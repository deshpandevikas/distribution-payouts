/**
 * Three "try later" rejections end the payment FAILED, after exactly three sends.
 *
 * maxSendAttempts counts the first send, so the runner stops after the third
 * rejection instead of sending a fourth time. Every attempt reuses the same
 * idempotency key: one key, three attempts.
 */

import { describe, it, expect } from "vitest";
import { FakeBank } from "../src/bank/fakeBank.js";
import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution, IdempotencyKey } from "../src/core/types.js";

describe("three try-later rejections", () => {
  it("end FAILED after exactly 3 sends to the bank", async () => {
    const keys: IdempotencyKey[] = [];
    const bank = new FakeBank({ next: () => 0 }, {
      permanentRejectRate: 0,
      transientRejectRate: 1,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });
    const origSend = bank.send.bind(bank);
    bank.send = async (key, amount, details) => {
      keys.push(key);
      return origSend(key, amount, details);
    };

    const store = new MemoryStore();
    let now = 0;
    const runner = new Runner({
      store, bank,
      clock: { now: () => now++, sleep: async (ms: number) => { now += ms; } },
      rng: { next: () => 0 },
      config: { maxSendAttempts: 3, backoffBaseMs: 0, settleWindowMs: 0 },
    });

    const investor = { id: "inv-1", name: "Test", bankDetails: "routing:test" };
    const dist: Distribution = {
      id: "dist-attempts",
      totalCents: 100,
      allocations: allocate(100, [{ investor, basisUnits: 1 }]),
      createdAt: 0,
    };
    await runner.run(dist);

    expect(keys).toHaveLength(3);
    expect(new Set(keys).size, "every attempt uses the same key").toBe(1);
    expect(store.listPayments("dist-attempts")[0]!.state).toBe("FAILED");
    expect(
      store.listAudit("dist-attempts").some(e => e.event === "TRANSIENT_RETRIES_EXHAUSTED"),
    ).toBe(true);
  });
});
