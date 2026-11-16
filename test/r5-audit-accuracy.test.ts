/**
 * R5 regression tests: audit log records events that did not happen.
 *
 *   (a) NOT_FOUND inside settle window audited as BANK_TIMEOUT (wrong event)
 *   (b) Transient retries exhausted audited as BANK_REJECTED_PERMANENT (wrong event)
 *   (c) Zero-cent skip audited as SEND_INTENT_RECORDED CREATED->CREATED (wrong event, wrong type)
 */

import { describe, it, expect } from "vitest";
import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution } from "../src/core/types.js";

function makeDist(id: string, totalCents: number, investors: { id: string; basis: number }[]): Distribution {
  const inputs = investors.map(({ id, basis }) => ({
    investor: { id, name: `Investor ${id}`, bankDetails: `routing:${id}` },
    basisUnits: basis,
  }));
  return { id, totalCents, allocations: allocate(totalCents, inputs), createdAt: 0 };
}

function makeRunner(store: MemoryStore, bank: FakeBank, config = {}) {
  let now = 0;
  return new Runner({
    store, bank,
    clock: { now: () => now++, sleep: async () => { now += 1; } },
    rng: { next: () => 0 },
    config: { backoffBaseMs: 0, ...config },
  });
}

describe("R5a: NOT_FOUND inside settle window audited as correct event", () => {
  it("audit shows STATUS_NOT_FOUND_IN_WINDOW, not BANK_TIMEOUT, when inside settle window", async () => {
    // Bank: timeout on send (-> UNKNOWN), status returns NOT_FOUND (inside window)
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 1,
      asyncConfirmRate: 1,  // will async-confirm so it terminates
      statusTimeoutRate: 0,
      lagChecks: 1,         // one NOT_FOUND check inside window
    });

    const store = new MemoryStore();
    // Large settle window so we're inside it on the first check
    const runner = makeRunner(store, bank, { settleWindowMs: 100_000, maxStatusChecks: 5 });

    const dist = makeDist("dist-r5a", 100, [{ id: "a", basis: 1 }]);
    await runner.run(dist);

    const audit = store.listAudit("dist-r5a");

    // Before fix: NOT_FOUND inside window is recorded as BANK_TIMEOUT
    // After fix: recorded as STATUS_NOT_FOUND_IN_WINDOW
    const wrongEvent = audit.find(e => e.event === "BANK_TIMEOUT" && e.fromState === "UNKNOWN" && e.toState === "UNKNOWN");
    const correctEvent = audit.find(e => e.event === "STATUS_NOT_FOUND_IN_WINDOW");
    expect(wrongEvent).toBeUndefined();
    expect(correctEvent).toBeDefined();
  });
});

describe("R5b: transient retries exhausted audited correctly", () => {
  it("audit shows TRANSIENT_RETRIES_EXHAUSTED, not BANK_REJECTED_PERMANENT, when retries exhaust", async () => {
    // Bank: always transient reject -> retries exhaust -> FAILED
    const bank = new FakeBank({ next: () => 0.08 }, {
      permanentRejectRate: 0,
      transientRejectRate: 1,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    const store = new MemoryStore();
    const runner = makeRunner(store, bank, { maxTransientRetries: 3, settleWindowMs: 0 });

    const dist = makeDist("dist-r5b", 100, [{ id: "a", basis: 1 }]);
    await runner.run(dist);

    const audit = store.listAudit("dist-r5b");

    // Before fix: retries exhausted recorded as BANK_REJECTED_PERMANENT (SENDING->FAILED)
    // After fix: recorded as TRANSIENT_RETRIES_EXHAUSTED (SENDING->FAILED)
    const wrongEvent = audit.find(e =>
      e.event === "BANK_REJECTED_PERMANENT" && e.fromState === "SENDING" && e.toState === "FAILED"
      && e.reason?.includes("transient retries exhausted"),
    );
    const correctEvent = audit.find(e => e.event === "TRANSIENT_RETRIES_EXHAUSTED");
    expect(wrongEvent).toBeUndefined();
    expect(correctEvent).toBeDefined();
  });
});

describe("R5c: zero-cent skip not in payment audit", () => {
  it("zero-cent allocation does not produce a SEND_INTENT_RECORDED audit entry", async () => {
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0, transientRejectRate: 0, timeoutRate: 0, statusTimeoutRate: 0,
    });

    const store = new MemoryStore();
    const runner = makeRunner(store, bank);

    // inv-a gets 100 cents, inv-b gets 0 (basis=0 -> zero cents, should be skipped)
    const dist = makeDist("dist-r5c", 100, [
      { id: "inv-a", basis: 1 },
      { id: "inv-b", basis: 0 },
    ]);
    await runner.run(dist);

    const audit = store.listAudit("dist-r5c");

    // Before fix: zero-cent skip produces a SEND_INTENT_RECORDED audit entry
    // After fix: zero-cent skip produces no payment audit entry
    const zeroCentAudit = audit.find(e =>
      e.investorId === "inv-b" && e.event === "SEND_INTENT_RECORDED",
    );
    expect(zeroCentAudit).toBeUndefined();

    // inv-a should still be audited normally
    const normalAudit = audit.find(e => e.investorId === "inv-a");
    expect(normalAudit).toBeDefined();
  });
});
