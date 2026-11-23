/**
 * The settle-window resend path must actually run.
 *
 * The path is easy to break in two ways:
 *   - the harness clock ignored the ms passed to sleep(), so time moved 1ms per
 *     call and a 120_000ms window could never elapse;
 *   - nothing in checkStatus() ever slept, so an UNKNOWN payment re-queried
 *     status at the same instant until CHECKS_EXHAUSTED.
 *
 * "Ended in some terminal state" passes in the broken and the fixed world, so
 * these tests assert the two grid cells and the resend itself:
 *   UNKNOWN:STATUS_NOT_FOUND_IN_WINDOW  (wait), then
 *   UNKNOWN:STATUS_NOT_FOUND            (window gone: back to SENDING), then
 *   a second bank.send with the SAME idempotency key.
 */

import { describe, it, expect } from "vitest";
import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution, Clock, IdempotencyKey } from "../src/core/types.js";

function makeDist(id: string, totalCents: number): Distribution {
  const investor = { id: "inv-1", name: "Test", bankDetails: "routing:test" };
  return {
    id, totalCents,
    allocations: allocate(totalCents, [{ investor, basisUnits: 1 }]),
    createdAt: 0,
  };
}

describe("the clock can wait", () => {
  it("Clock interface requires sleep(ms) method", () => {
    // This test verifies the interface at the type level.
    // A clock without sleep() should not compile.
    const fakeClock: Clock = {
      now: () => 0,
      sleep: async (ms: number) => { void ms; },
    };
    expect(typeof fakeClock.sleep).toBe("function");
  });
});

describe("the settle window waits, then resends the same key", () => {
  it("waits inside the window, then resends the same key once the window is gone", async () => {
    // Bank never reveals status (lagChecks far above the check budget), so the
    // payment cannot resolve by status: the only way out is wait -> resend.
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 1,        // first send times out -> UNKNOWN
      asyncConfirmRate: 0,   // even if it surfaces, it is a failure
      statusTimeoutRate: 0,
      lagChecks: 100,        // NOT_FOUND for every status check
    });

    // This test is about the settle-window wait/resend, not about late async
    // events. Hold the bank's async events back: they have not arrived yet.
    // Otherwise the mid-flight drain resolves the payment before the first
    // status query and the wait/resend sequence never runs.
    bank.drainAsyncEvents = () => [];

    const sendKeys: IdempotencyKey[] = [];
    const origSend = bank.send.bind(bank);
    bank.send = async (key, amount, details) => {
      sendKeys.push(key);
      return origSend(key, amount, details);
    };

    const store = new MemoryStore();
    let now = 0;
    const sleeps: number[] = [];
    // The clock the harness must use: sleep honours the requested duration.
    const clock: Clock = {
      now: () => now++,
      sleep: async (ms: number) => { sleeps.push(ms); now += ms; },
    };

    const runner = new Runner({
      store, bank, clock,
      rng: { next: () => 0 },
      config: {
        settleWindowMs: 1_000,
        maxStatusChecks: 4,
        backoffBaseMs: 0,
      },
    });

    const dist = makeDist("dist-r3", 100);
    await runner.run(dist);

    const audit = store.listAudit("dist-r3");
    const cells = audit.map(e => `${e.fromState}:${e.event}`);

    // 1. The payment waited inside the window.
    expect(cells).toContain("UNKNOWN:STATUS_NOT_FOUND_IN_WINDOW");

    // 2. Once the window was gone, NOT_FOUND moved UNKNOWN -> SENDING.
    expect(cells).toContain("UNKNOWN:STATUS_NOT_FOUND");
    expect(
      audit.some(e => e.event === "STATUS_NOT_FOUND" && e.fromState === "UNKNOWN" && e.toState === "SENDING"),
      "UNKNOWN -> SENDING on STATUS_NOT_FOUND must be audited",
    ).toBe(true);

    // 3. The wait was real: the runner asked the clock for time inside the window.
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(now, "clock must advance past the settle window").toBeGreaterThanOrEqual(1_000);

    // 4. The resend reused the idempotency key - no new key, no new payment.
    expect(sendKeys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sendKeys).size, "every send must use the same idempotency key").toBe(1);
    expect(store.listPayments("dist-r3")).toHaveLength(1);
  });
});
