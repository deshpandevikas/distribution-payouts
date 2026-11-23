/**
 * Async events must be able to land while a payment is in flight.
 *
 * Before the fix, drainAsyncEvents() ran only after each payment finished, so a
 * late ASYNC_CONFIRM for a payment sitting in UNKNOWN could not arrive until
 * that payment had already left UNKNOWN (or gone to MANUAL_REVIEW). The grid
 * cell UNKNOWN:ASYNC_CONFIRM was unreachable in every scenario.
 *
 * This test makes the status query useless (lagChecks far above the check
 * budget, so it answers NOT_FOUND forever). The ONLY way the payment can reach
 * CONFIRMED is the ASYNC_CONFIRM its timed-out send queued - i.e. the event must
 * be drained mid-flight, from inside checkStatus.
 */

import { describe, it, expect } from "vitest";
import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution, IdempotencyKey } from "../src/core/types.js";

function makeDist(id: string, totalCents: number): Distribution {
  const investor = { id: "inv-1", name: "Test", bankDetails: "routing:test" };
  return {
    id, totalCents,
    allocations: allocate(totalCents, [{ investor, basisUnits: 1 }]),
    createdAt: 0,
  };
}

describe("an async event lands while the payment is UNKNOWN", () => {
  it("confirms an UNKNOWN payment from its late ASYNC_CONFIRM, with no resend", async () => {
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 1,      // send times out -> UNKNOWN, ASYNC_CONFIRM queued
      asyncConfirmRate: 1,
      statusTimeoutRate: 0,
      lagChecks: 100,      // status never resolves on its own
    });

    const sendKeys: IdempotencyKey[] = [];
    const origSend = bank.send.bind(bank);
    bank.send = async (key, amount, details) => {
      sendKeys.push(key);
      return origSend(key, amount, details);
    };

    const store = new MemoryStore();
    let now = 0;
    const runner = new Runner({
      store, bank,
      clock: { now: () => now++, sleep: async (ms: number) => { now += ms; } },
      rng: { next: () => 0.5 },
      config: { settleWindowMs: 120_000, maxStatusChecks: 2, backoffBaseMs: 0 },
    });

    await runner.run(makeDist("dist-c6", 100));

    const audit = store.listAudit("dist-c6");
    const cells = audit.map(e => `${e.fromState}:${e.event}`).join(", ");

    // The event was applied from UNKNOWN, the cell this test is about.
    expect(
      audit.some(e => e.event === "ASYNC_CONFIRM" && e.fromState === "UNKNOWN" && e.toState === "CONFIRMED"),
      `expected UNKNOWN:ASYNC_CONFIRM, got: ${cells}`,
    ).toBe(true);

    // ...and it resolved the payment without a resend or a manual review.
    expect(store.listPayments("dist-c6")[0]!.state).toBe("CONFIRMED");
    expect(sendKeys).toHaveLength(1);
  });
});
