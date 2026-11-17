/**
 * Read-only MCP server over the SQLite store (F2).
 *
 * The card's rule is absolute: no tool writes, ever. That is enforced three
 * ways - the handler only calls Store read methods, the tool list is a fixed
 * constant, and the test fails if a write-shaped tool name ever appears.
 *
 * `explain_payment` is the one with judgement in it: it answers "why is this in
 * MANUAL_REVIEW?" by naming the event that escalated it and quoting the
 * runner's own reason, rather than restating the state.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Payment, Store } from "../core/types.js";
import { TERMINAL_STATES } from "../core/types.js";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: "string"; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

/** Frozen on purpose: adding a tool is a code change with a test. */
const TOOLS: ToolDefinition[] = [
  {
    name: "get_payment",
    description: "Read one payment record by id (state, amount, key, retry counters).",
    inputSchema: {
      type: "object",
      properties: { paymentId: { type: "string", description: "Payment id, e.g. pay:dist-1:inv-1" } },
      required: ["paymentId"],
      additionalProperties: false,
    },
  },
  {
    name: "explain_payment",
    description:
      "Explain in plain words why a payment is in its current state, with its audit trail - including the contradiction that sent it to MANUAL_REVIEW.",
    inputSchema: {
      type: "object",
      properties: { paymentId: { type: "string", description: "Payment id" } },
      required: ["paymentId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_manual_review",
    description: "List every payment in MANUAL_REVIEW for a distribution, with the reason it got there.",
    inputSchema: {
      type: "object",
      properties: { distributionId: { type: "string", description: "Distribution id" } },
      required: ["distributionId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_alerts",
    description: "List operator alerts for a distribution (bank events with no payment, skipped allocations).",
    inputSchema: {
      type: "object",
      properties: { distributionId: { type: "string", description: "Distribution id" } },
      required: ["distributionId"],
      additionalProperties: false,
    },
  },
];

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

export function createReadOnlyServer(store: Store): Server {
  const server = new Server(
    { name: "distribution-payouts", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const stringArg = (key: string): string | undefined =>
      typeof args[key] === "string" ? (args[key] as string) : undefined;

    switch (request.params.name) {
      case "get_payment": {
        const payment = findPayment(store, stringArg("paymentId"));
        if (typeof payment === "string") return fail(payment);
        return ok(JSON.stringify(payment, null, 2));
      }

      case "explain_payment": {
        const payment = findPayment(store, stringArg("paymentId"));
        if (typeof payment === "string") return fail(payment);
        return ok(explain(store, payment));
      }

      case "list_manual_review": {
        const distributionId = stringArg("distributionId");
        if (distributionId === undefined) return fail("distributionId is required");
        return ok(listManualReview(store, distributionId));
      }

      case "list_alerts": {
        const distributionId = stringArg("distributionId");
        if (distributionId === undefined) return fail("distributionId is required");
        return ok(listAlerts(store, distributionId));
      }

      default:
        return fail(`unknown tool: ${request.params.name}`);
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Tool bodies - reads only
// ---------------------------------------------------------------------------

function findPayment(store: Store, paymentId: string | undefined): Payment | string {
  if (paymentId === undefined) return "paymentId is required";
  const payment = store.getPayment(paymentId);
  return payment ?? `Payment ${paymentId} not found: no payment with that id in this database.`;
}

function explain(store: Store, payment: Payment): string {
  const audit = store.listAudit(payment.distributionId).filter((e) => e.paymentId === payment.id);
  const lines: string[] = [];

  lines.push(
    `Payment ${payment.id} for investor ${payment.investorId} is in ${payment.state} ` +
      `(${payment.amountCents}c, key ${payment.idempotencyKey}).`,
  );

  const escalation = [...audit]
    .reverse()
    .find((e) => e.toState === "MANUAL_REVIEW" || e.toState === "FAILED");

  if (payment.state === "MANUAL_REVIEW") {
    if (escalation !== undefined) {
      lines.push(
        `Why: it was escalated to MANUAL_REVIEW when ${escalation.event} arrived ` +
          `while the payment was ${escalation.fromState}.` +
          (escalation.reason !== undefined ? ` The runner's reason: "${escalation.reason}".` : ""),
      );
    } else {
      lines.push("Why: it is in MANUAL_REVIEW but no audit entry explains the escalation - investigate.");
    }
    lines.push("A human owns it now: no automated transition will move it.");
  } else if (payment.state === "FAILED") {
    lines.push(
      escalation !== undefined
        ? `It failed at ${escalation.event} (from ${escalation.fromState})` +
          (escalation.reason !== undefined ? `: ${escalation.reason}.` : ".")
        : "It failed, but no audit entry records the failure - investigate.",
    );
    lines.push("FAILED is terminal in this phase: paying it again is a new instruction and a human decision.");
  } else if (payment.state === "CONFIRMED") {
    lines.push("It is settled: the bank accepted the key and the money moved.");
  } else if (!TERMINAL_STATES.has(payment.state)) {
    lines.push(
      `It is still in flight (${payment.statusChecks} status checks, ` +
        `${payment.transientRetries} transient retries).`,
    );
  }

  if (audit.length === 0) {
    lines.push("Audit trail: empty - a state change happened without an audit entry (I5 violation).");
  } else {
    lines.push("Audit trail:");
    audit.forEach((entry, index) => {
      const reason = entry.reason !== undefined ? ` (${entry.reason})` : "";
      lines.push(`  ${index + 1}. ${entry.event}: ${entry.fromState} -> ${entry.toState}${reason}`);
    });
  }

  return lines.join("\n");
}

function listManualReview(store: Store, distributionId: string): string {
  const payments = store.listPayments(distributionId).filter((p) => p.state === "MANUAL_REVIEW");
  if (payments.length === 0) return `No payments in MANUAL_REVIEW for distribution ${distributionId}.`;

  const audit = store.listAudit(distributionId);
  const lines = [
    `${payments.length} payment(s) in MANUAL_REVIEW for distribution ${distributionId}:`,
  ];

  for (const payment of payments) {
    const escalation = [...audit]
      .reverse()
      .find((e) => e.paymentId === payment.id && e.toState === "MANUAL_REVIEW");
    lines.push(
      `- ${payment.id} (investor ${payment.investorId}, ${payment.amountCents}c)` +
        (escalation !== undefined
          ? `: ${escalation.event} from ${escalation.fromState}` +
            (escalation.reason !== undefined ? ` - ${escalation.reason}` : "")
          : ": no audit entry explains the escalation"),
    );
  }

  return lines.join("\n");
}

function listAlerts(store: Store, distributionId: string): string {
  const alerts = store.listAlerts(distributionId);
  if (alerts.length === 0) return `No alerts for distribution ${distributionId}.`;

  const lines = [`${alerts.length} alert(s) for distribution ${distributionId}:`];
  for (const alert of alerts) {
    const about = alert.paymentId !== undefined ? ` [payment ${alert.paymentId}]` : "";
    lines.push(`- ${alert.kind}${about}: ${alert.detail}`);
  }
  return lines.join("\n");
}
