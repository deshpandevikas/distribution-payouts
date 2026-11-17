/**
 * Replay page DOM layer.
 *
 * All the money logic is in site/replay.ts, which is plain Node-testable. This
 * file only reads the form, writes the URL and renders the outcome.
 */

import { BREAK_IT_FLAGS, replay } from "./replay.js";
import type { BreakItFlag, ReplayOutcome } from "./replay.js";
import type { FakeBankConfig } from "../src/bank/fakeBank.js";

interface Controls {
  seed: number;
  investors: number;
  totalCents: number;
  bank: FakeBankConfig;
  flag: BreakItFlag | "";
}

const NUMBER_FIELDS = [
  "seed",
  "investors",
  "total",
  "timeoutRate",
  "transientRejectRate",
  "lyingTransientRate",
  "asyncConfirmRate",
  "asyncDelayChecks",
  "asyncDropRate",
] as const;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const input = (id: string): HTMLInputElement => $(id) as HTMLInputElement;
const num = (id: string): number => Number(input(id).value);

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function readControls(): Controls {
  return {
    seed: Math.max(1, Math.floor(num("seed"))),
    investors: Math.min(40, Math.max(1, Math.floor(num("investors")))),
    totalCents: Math.max(1, Math.floor(num("total"))),
    flag: ($("flag") as HTMLSelectElement).value as BreakItFlag | "",
    bank: {
      permanentRejectRate: 0,
      statusTimeoutRate: 0,
      dedupe: true,
      timeoutRate: num("timeoutRate"),
      transientRejectRate: num("transientRejectRate"),
      lyingTransientRate: num("lyingTransientRate"),
      asyncConfirmRate: num("asyncConfirmRate"),
      asyncDelayChecks: Math.max(0, Math.floor(num("asyncDelayChecks"))),
      asyncDropRate: num("asyncDropRate"),
    },
  };
}

function applyUrlParams(): void {
  const params = new URLSearchParams(location.search);
  for (const id of NUMBER_FIELDS) {
    const value = params.get(id);
    if (value !== null) input(id).value = value;
  }
  const flag = params.get("flag");
  if (flag !== null && (BREAK_IT_FLAGS as readonly string[]).includes(flag)) {
    ($("flag") as HTMLSelectElement).value = flag;
  }
}

function writeUrl(controls: Controls): void {
  const params = new URLSearchParams();
  params.set("seed", String(controls.seed));
  if (controls.flag !== "") params.set("flag", controls.flag);
  params.set("investors", String(controls.investors));
  params.set("total", String(controls.totalCents));
  params.set("timeoutRate", String(controls.bank.timeoutRate));
  params.set("transientRejectRate", String(controls.bank.transientRejectRate));
  params.set("lyingTransientRate", String(controls.bank.lyingTransientRate));
  params.set("asyncConfirmRate", String(controls.bank.asyncConfirmRate));
  params.set("asyncDelayChecks", String(controls.bank.asyncDelayChecks ?? 0));
  params.set("asyncDropRate", String(controls.bank.asyncDropRate ?? 0));
  history.replaceState(null, "", `?${params.toString()}`);
}

function render(controls: Controls, outcome: ReplayOutcome): void {
  $("summary").innerHTML = `
    <h2>Run</h2>
    <p>
      seed <code>${controls.seed}</code>,
      flag <code>${controls.flag === "" ? "none" : escapeHtml(controls.flag)}</code>,
      ${outcome.payments.length} payments,
      allocated <code>${outcome.totalAllocatedCents}c</code>,
      confirmed <code>${outcome.result.totalConfirmedCents}c</code>,
      failed <code>${outcome.result.totalFailedCents}c</code>,
      manual <code>${outcome.result.totalManualReviewCents}c</code>
      - <strong>${escapeHtml(outcome.result.status)}</strong>
    </p>
  `;

  if (outcome.violations.length === 0) {
    $("invariants").innerHTML = `<h2>Invariants</h2><p class="ok">All invariants hold.</p>`;
  } else {
    const rows = outcome.violations
      .map(
        (v) => `<tr><td class="bad">${escapeHtml(v.invariant)}</td><td>${escapeHtml(v.detail)}</td></tr>`,
      )
      .join("");
    const note = controls.flag === ""
      ? ""
      : `<p class="sub">Break-it flag <code>${escapeHtml(controls.flag)}</code> is on: a violation here is the point.</p>`;
    $("invariants").innerHTML = `
      <h2>Invariants</h2>
      ${note}
      <p class="bad">${outcome.violations.length} violation(s)</p>
      <table><thead><tr><th>Invariant</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>
    `;
  }

  const paymentRows = outcome.payments
    .map(
      (p) => `<tr>
        <td class="state">${escapeHtml(p.investorId)}</td>
        <td>${p.amountCents}c</td>
        <td class="state">${escapeHtml(p.state)}</td>
        <td class="state">${escapeHtml(p.idempotencyKey)}</td>
        <td>${p.transientRetries}</td>
        <td>${p.statusChecks}</td>
      </tr>`,
    )
    .join("");

  $("payments").innerHTML = `
    <h2>Payments</h2>
    <table>
      <thead><tr><th>Investor</th><th>Amount</th><th>State</th><th>Idempotency key</th><th>Retries</th><th>Checks</th></tr></thead>
      <tbody>${paymentRows}</tbody>
    </table>
  `;

  const auditRows = outcome.audit
    .map(
      (e) => `<tr>
        <td class="state">${escapeHtml(e.investorId)}</td>
        <td class="state">${escapeHtml(e.event)}</td>
        <td class="state">${escapeHtml(e.fromState)} &rarr; ${escapeHtml(e.toState)}</td>
        <td>${escapeHtml(e.reason ?? "")}</td>
      </tr>`,
    )
    .join("");

  $("audit").innerHTML = `
    <h2>Audit log</h2>
    <table>
      <thead><tr><th>Investor</th><th>Event</th><th>Transition</th><th>Reason</th></tr></thead>
      <tbody>${auditRows}</tbody>
    </table>
  `;
}

async function run(): Promise<void> {
  const controls = readControls();
  writeUrl(controls);
  render(controls, await replay(controls));
}

$("controls").addEventListener("submit", (event) => {
  event.preventDefault();
  void run();
});

applyUrlParams();
void run();
