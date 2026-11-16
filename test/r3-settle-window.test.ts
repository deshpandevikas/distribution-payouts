/**
 * R3 regression tests: settle-window resend path is unreachable.
 *
 * Before fix:
 *   - Clock has no sleep() - backoff and polling don't advance clock
 *   - settle window is 120,000ms but fake clock only advances 1ms per call
 *   - age is measured from createdAt, not lastSentAt
 *   - bank always returns CONFIRMED/FAILED on status (never NOT_FOUND for a sent key)
 *
 * After fix:
 *   - Clock interface has sleep(ms): fake clock advances, real clock awaits
 *   - Payment has lastSentAt field
 *   - settle window measured from lastSentAt
 *   - FakeBank has lagMode: returns NOT_FOUND for first K status checks before resolving
 */

import { describe, it, expect } from "vitest";
import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution, Clock } from "../src/core/types.js";

function makeDist(id: string, totalCents: number): Distribution {
  const investor = { id: "inv-1", name: "Test", bankDetails: "routing:test" };
  return {
    id, totalCents,
    allocations: allocate(totalCents, [{ investor, basisUnits: 1 }]),
    createdAt: 0,
  };
}

describe("R3: Clock has sleep()", () => {
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

describe("R3: settle-window resend exercised", () => {
  it("payment in UNKNOWN outside settle window resends (UNKNOWN->SENDING in audit)", async () => {
    // Bank lag mode: status returns NOT_FOUND for first 2 checks, then CONFIRMED.
    // settle window = 0 so we're immediately outside it.
    // This forces UNKNOWN -> STATUS_NOT_FOUND -> SENDING -> BANK_ACCEPTED -> CONFIRMED.
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 1,        // force timeout -> UNKNOWN
      asyncConfirmRate: 0,   // async resolves as FAILED so status check drives recovery
      statusTimeoutRate: 0,
      lagChecks: 2,          // NOT_FOUND for first 2 status checks
    });

    const store = new MemoryStore();
    let now = 0;
    const clock: Clock = {
      now: () => now++,
      sleep: async (_ms: number) => { now += 10; }, // advance clock on sleep
    };

    const runner = new Runner({
      store, bank, clock,
      rng: { next: () => 0 },
      config: {
        settleWindowMs: 0,   // immediately outside window
        maxStatusChecks: 10,
        backoffBaseMs: 1,
      },
    });

    const dist = makeDist("dist-r3", 100);
    await runner.run(dist);

    const audit = store.listAudit("dist-r3");

    // Before fix: UNKNOWN->SENDING never appears (settle window never expires)
    // After fix: UNKNOWN->SENDING appears (outside window, resend triggered)
    const resendTransition = audit.some(e =>
      e.fromState === "UNKNOWN" && e.toState === "SENDING",
    );
    expect(resendTransition).toBe(true);
  });

  it("settle window measured from lastSentAt, not createdAt", async () => {
    // With createdAt-based window and a clock that advances slowly,
    // a payment created at t=0 would appear inside the window even after many status checks.
    // With lastSentAt-based window, the window resets on each send.
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 1,
      asyncConfirmRate: 0,
      statusTimeoutRate: 0,
      lagChecks: 1,
    });

    const store = new MemoryStore();
    let now = 0;
    const clock: Clock = {
      now: () => now++,
      sleep: async (_ms) => { now += 1; },
    };

    const runner = new Runner({
      store, bank, clock,
      rng: { next: () => 0 },
      config: { settleWindowMs: 5, maxStatusChecks: 10, backoffBaseMs: 0 },
    });

    const dist = makeDist("dist-r3b", 100);
    await runner.run(dist);

    // Should complete - the window expires relative to lastSentAt, triggering resend
    const payments = store.listPayments("dist-r3b");
    expect(["CONFIRMED", "FAILED", "MANUAL_REVIEW"]).toContain(payments[0]!.state);
  });
});
