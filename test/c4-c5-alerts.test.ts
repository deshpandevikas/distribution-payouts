/**
 * C4/C5: things an operator must see that are not payment state changes belong
 * in an alerts list, not in the payment audit log.
 *
 * C4 (before the fix): a bank event for a key we never sent was appended to the
 * audit log as `paymentId: "unknown:<key>"`, `distributionId: "unknown"` and a
 * fabricated `CREATED -> MANUAL_REVIEW` transition. No payment exists, so
 * `listAudit(realDistributionId)` never showed it: the alert was invisible to
 * the very operator it was written for.
 *
 * C5 (before the fix): a zero-cent allocation was only a console.log. Decision
 * #13 says it must be recorded, and C4's list is where.
 */

import { describe, it, expect } from "vitest";
import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution } from "../src/core/types.js";

function makeDist(
  id: string,
  totalCents: number,
  investors: { id: string; basis: number }[],
): Distribution {
  const inputs = investors.map(({ id: investorId, basis }) => ({
    investor: { id: investorId, name: `Investor ${investorId}`, bankDetails: `routing:${investorId}` },
    basisUnits: basis,
  }));
  return { id, totalCents, allocations: allocate(totalCents, inputs), createdAt: 0 };
}

function makeRunner(store: MemoryStore, bank: FakeBank) {
  let now = 0;
  return new Runner({
    store, bank,
    clock: { now: () => now++, sleep: async (ms: number) => { now += ms; } },
    rng: { next: () => 0.5 },
    config: { settleWindowMs: 0, backoffBaseMs: 0 },
  });
}

const CLEAN_BANK = {
  permanentRejectRate: 0,
  transientRejectRate: 0,
  timeoutRate: 0,
  statusTimeoutRate: 0,
};

describe("C4: bank event for a key we never sent", () => {
  it("writes an alert keyed to the distribution, not a fabricated payment audit row", async () => {
    const bank = new FakeBank({ next: () => 0.5 }, CLEAN_BANK);
    let pending: Array<{ key: string; type: "ASYNC_CONFIRM" | "ASYNC_FAILURE" }> = [
      { key: "ghost-key", type: "ASYNC_CONFIRM" },
    ];
    bank.drainAsyncEvents = () => {
      const out = pending;
      pending = [];
      return out;
    };

    const store = new MemoryStore();
    await makeRunner(store, bank).run(makeDist("dist-c4", 100, [{ id: "inv-1", basis: 1 }]));

    // The audit log describes payments. There is no payment here.
    const audit = store.listAudit("dist-c4");
    expect(audit.filter(e => e.paymentId.startsWith("unknown:"))).toHaveLength(0);
    expect(audit.filter(e => e.toState === "MANUAL_REVIEW")).toHaveLength(0);

    // The operator sees it through the alerts list, keyed to the distribution.
    const alerts = store.listAlerts("dist-c4");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("BANK_EVENT_FOR_UNKNOWN_KEY");
    expect(alerts[0]!.distributionId).toBe("dist-c4");
    expect(alerts[0]!.event).toBe("ASYNC_CONFIRM");
    expect(alerts[0]!.detail).toContain("ghost-key");

    // Alerts are per distribution, not global.
    expect(store.listAlerts("dist-other")).toHaveLength(0);

    // The real payment is untouched.
    expect(store.listPayments("dist-c4")[0]!.state).toBe("CONFIRMED");
  });
});

describe("C5: zero-cent allocation is recorded, not just logged", () => {
  it("appends ALLOCATION_SKIPPED to the alerts list and creates no payment", async () => {
    const bank = new FakeBank({ next: () => 0.5 }, CLEAN_BANK);
    const store = new MemoryStore();

    await makeRunner(store, bank).run(makeDist("dist-c5", 100, [
      { id: "inv-a", basis: 1 },
      { id: "inv-b", basis: 0 },
    ]));

    const alerts = store.listAlerts("dist-c5");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("ALLOCATION_SKIPPED");
    expect(alerts[0]!.distributionId).toBe("dist-c5");
    expect(alerts[0]!.investorId).toBe("inv-b");
    expect(alerts[0]!.detail).toContain("zero-cent");

    // Decision #13: no payment for a zero-cent share, and no audit row either.
    expect(store.listPayments("dist-c5")).toHaveLength(1);
    expect(store.listAudit("dist-c5").some(e => e.investorId === "inv-b")).toBe(false);
  });
});
