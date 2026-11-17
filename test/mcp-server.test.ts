/**
 * F5: the MCP tools, exercised through the SDK's in-memory client.
 *
 * The server is given a Store, so the test points it at a real seeded SQLite
 * database (the F2 store) instead of a mock. That is the point: the tools must
 * read what the runner actually wrote, including the audit trail.
 *
 * Read-only is asserted, not assumed: the tool list is checked by name, and a
 * guard fails if any tool name looks like it could write.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteStore } from "../src/store/sqliteStore.js";
import { createReadOnlyServer } from "../src/mcp/server.js";
import type { Payment } from "../src/core/types.js";

const DIST = "dist-mcp";

function payment(over: Partial<Payment>): Payment {
  return {
    id: "pay-1",
    distributionId: DIST,
    investorId: "inv-1",
    amountCents: 1_000,
    idempotencyKey: `key:${over.id ?? "pay-1"}`,
    bankDetails: "routing:1",
    instructionNo: 1,
    state: "CREATED",
    transientRetries: 0,
    statusChecks: 0,
    createdAt: 0,
    updatedAt: 0,
    lastSentAt: 0,
    ...over,
  };
}

interface Harness {
  store: SqliteStore;
  client: Client;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dp-mcp-"));
  const store = new SqliteStore(join(dir, "payouts.db"));

  // One clean payment, one escalated with a full trail, one alert.
  store.savePayment(payment({ id: "pay-ok", investorId: "inv-ok", state: "CONFIRMED", amountCents: 500 }));
  store.appendAudit({
    paymentId: "pay-ok", distributionId: DIST, investorId: "inv-ok",
    event: "BANK_ACCEPTED", fromState: "SENDING", toState: "CONFIRMED", timestamp: 2,
  });

  store.savePayment(payment({ id: "pay-mr", investorId: "inv-mr", state: "MANUAL_REVIEW", amountCents: 700 }));
  store.appendAudit({
    paymentId: "pay-mr", distributionId: DIST, investorId: "inv-mr",
    event: "SEND_INTENT_RECORDED", fromState: "CREATED", toState: "SENDING", timestamp: 1,
  });
  store.appendAudit({
    paymentId: "pay-mr", distributionId: DIST, investorId: "inv-mr",
    event: "TRANSIENT_RETRIES_EXHAUSTED", fromState: "SENDING", toState: "FAILED",
    reason: "transient retries exhausted after 3 attempts", timestamp: 3,
  });
  store.appendAudit({
    paymentId: "pay-mr", distributionId: DIST, investorId: "inv-mr",
    event: "ASYNC_CONFIRM", fromState: "FAILED", toState: "MANUAL_REVIEW",
    reason: "ASYNC_CONFIRM on FAILED  -  contradiction, investigate", timestamp: 4,
  });

  store.appendAlert({
    kind: "BANK_EVENT_FOR_UNKNOWN_KEY",
    distributionId: DIST,
    detail: "bank event ASYNC_CONFIRM for key key-missing - no payment for this key",
    timestamp: 5,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createReadOnlyServer(store);
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    store,
    client,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((part) => part.text ?? "").join("\n");
}

describe("read-only MCP server", () => {
  let h: Harness;

  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  it("exposes exactly the four read-only tools", async () => {
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(["explain_payment", "get_payment", "list_alerts", "list_manual_review"]);
    // A write tool must never appear, under any plausible name.
    expect(names.filter((n) => /write|update|set|create|delete|send|pay_|retry|resolve|force/i.test(n))).toEqual([]);
  });

  it("get_payment returns the stored payment", async () => {
    const result = await h.client.callTool({ name: "get_payment", arguments: { paymentId: "pay-mr" } });
    const payload = JSON.parse(textOf(result)) as Payment;

    expect(payload.id).toBe("pay-mr");
    expect(payload.state).toBe("MANUAL_REVIEW");
    expect(payload.amountCents).toBe(700);
  });

  it("get_payment reports an unknown id without inventing a payment", async () => {
    const result = await h.client.callTool({ name: "get_payment", arguments: { paymentId: "nope" } });
    expect(textOf(result)).toMatch(/not found|no payment/i);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("explain_payment says why a payment is in MANUAL_REVIEW, in words", async () => {
    const result = await h.client.callTool({ name: "explain_payment", arguments: { paymentId: "pay-mr" } });
    const text = textOf(result);

    expect(text).toContain("MANUAL_REVIEW");
    expect(text).toContain("ASYNC_CONFIRM");
    // The contradiction that escalated it, not just the final state.
    expect(text).toMatch(/contradiction/i);
    // The trail, in order. Scoped to the trail section: the "Why:" sentence
    // legitimately names ASYNC_CONFIRM before the trail lists it.
    const trail = text.slice(text.indexOf("Audit trail:"));
    expect(trail.indexOf("SEND_INTENT_RECORDED")).toBeLessThan(trail.indexOf("ASYNC_CONFIRM"));
    expect(trail.indexOf("TRANSIENT_RETRIES_EXHAUSTED")).toBeLessThan(trail.indexOf("ASYNC_CONFIRM"));
    expect(text).toContain("TRANSIENT_RETRIES_EXHAUSTED");
  });

  it("list_manual_review returns only escalated payments", async () => {
    const result = await h.client.callTool({ name: "list_manual_review", arguments: { distributionId: DIST } });
    const text = textOf(result);

    expect(text).toContain("pay-mr");
    expect(text).not.toContain("pay-ok");
  });

  it("list_alerts returns operator alerts, not payment state changes", async () => {
    const result = await h.client.callTool({ name: "list_alerts", arguments: { distributionId: DIST } });
    const text = textOf(result);

    expect(text).toContain("BANK_EVENT_FOR_UNKNOWN_KEY");
    expect(text).toContain("key-missing");
  });
});
