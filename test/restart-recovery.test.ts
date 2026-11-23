/**
 * A restart in SENDING must status-check, never blind resend.
 *
 * RECOVERY_ON_RESTART in SENDING stays SENDING, then processPayment
 * calls sendPayment directly - a blind resend. The bank's dedupe hides it.
 *
 * recovery in SENDING goes through status check first.
 * With dedupe=false, a blind resend would double-settle the account.
 */

import { describe, it, expect } from "vitest";
import { Runner, CrashInjected } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution } from "../src/core/types.js";

function makeDist(id: string, totalCents: number): Distribution {
  const investor = { id: "inv-1", name: "Test", bankDetails: "routing:test" };
  return {
    id,
    totalCents,
    allocations: allocate(totalCents, [{ investor, basisUnits: 1 }]),
    createdAt: 0,
  };
}

describe("a restart in SENDING status-checks before resending", () => {
  it("does not send twice when crashed after intent recorded (dedupe=false)", async () => {
    // With dedupe=false, a blind resend would create a second settlement.
    const sendKeys: string[] = [];
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
      dedupe: false, // dedupe off: blind resend would double-settle
    });

    const origSend = bank.send.bind(bank);
    bank.send = async (key, amount, details) => {
      sendKeys.push(key);
      return origSend(key, amount, details);
    };

    const store = new MemoryStore();
    let now = 0;
    const clock = { now: () => now++, sleep: async () => { now += 1; } };

    // Run 1: crash after intent recorded (payment is in SENDING)
    const runner1 = new Runner({
      store, bank, clock,
      rng: { next: () => 0 },
      crashAt: "afterIntentRecorded",
    });

    const dist = makeDist("dist-r1", 100);
    await expect(runner1.run(dist)).rejects.toBeInstanceOf(CrashInjected);

    const sendCountAfterCrash = sendKeys.length;
    // No send should have happened yet (crashed before bank call)
    expect(sendCountAfterCrash).toBe(0);

    const payments = store.listPayments("dist-r1");
    expect(payments[0]!.state).toBe("SENDING");

    // Run 2: restart over same store + bank
    const runner2 = new Runner({
      store, bank, clock,
      rng: { next: () => 0 },
      config: { settleWindowMs: 0 },
    });

    await runner2.run(dist);

    // With fix: exactly 1 send (status check found NOT_FOUND, then sent once)
    // With bug: 2 sends (blind resend on restart, then status check or second accept)
    expect(sendKeys.length).toBe(1);
    expect(store.listPayments("dist-r1")[0]!.state).toBe("CONFIRMED");
  });

  it("status-checks on restart in SENDING (audit shows STATUS_CONFIRMED, not BANK_ACCEPTED from blind resend)", async () => {
    const store = new MemoryStore();
    let now = 0;
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    // Crash after bank call but before recording reply - payment stays SENDING
    const runner1 = new Runner({
      store, bank, clock: { now: () => now++, sleep: async () => { now += 1; } },
      rng: { next: () => 0 },
      crashAt: "afterBankCallBeforeRecord",
    });

    const dist = makeDist("dist-r1b", 100);
    await expect(runner1.run(dist)).rejects.toBeInstanceOf(CrashInjected);

    // Payment is in SENDING; bank has ACCEPTED the key already
    expect(store.listPayments("dist-r1b")[0]!.state).toBe("SENDING");

    const runner2 = new Runner({
      store, bank, clock: { now: () => now++, sleep: async () => { now += 1; } },
      rng: { next: () => 0 },
      config: { settleWindowMs: 0 },
    });

    await runner2.run(dist);

    const audit = store.listAudit("dist-r1b");
    // With fix: recovery path goes through status check - audit shows STATUS_CONFIRMED
    // With bug: blind resend - bank dedupes and returns ACCEPTED again, audit shows BANK_ACCEPTED
    const confirmedViaStatus = audit.some(e => e.event === "STATUS_CONFIRMED" && e.toState === "CONFIRMED");
    expect(confirmedViaStatus).toBe(true);
  });
});
