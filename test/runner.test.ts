import { describe, it, expect } from "vitest";
import { Runner, buildIdempotencyKey, CrashInjected } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { rngFromSeed } from "../harness/generate.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution, Investor } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvestor(id: string): Investor {
  return { id, name: `Investor ${id}`, bankDetails: `routing:${id}` };
}

function makeDist(id: string, totalCents: number, investors: { id: string; basis: number }[]): Distribution {
  const inputs = investors.map(({ id, basis }) => ({
    investor: makeInvestor(id),
    basisUnits: basis,
  }));
  const allocations = allocate(totalCents, inputs);
  return { id, totalCents, allocations, createdAt: 0 };
}

function makeRunner(overrides: {
  store?: MemoryStore;
  bank?: FakeBank;
  config?: Partial<import("../src/core/types.js").RunnerConfig>;
  crashAt?: import("../src/core/runner.js").CrashPoint;
} = {}) {
  const store = overrides.store ?? new MemoryStore();
  const bank = overrides.bank ?? new FakeBank(rngFromSeed(1), {
    permanentRejectRate: 0,
    transientRejectRate: 0,
    timeoutRate: 0,
    statusTimeoutRate: 0,
  });
  let now = 0;
  const clock = { now: () => now++ };
  const rng = rngFromSeed(1);
  const runner = new Runner({
    store, bank, clock, rng,
    ...(overrides.config !== undefined ? { config: overrides.config } : {}),
    ...(overrides.crashAt !== undefined ? { crashAt: overrides.crashAt } : {}),
  });
  return { store, bank, clock, runner };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Runner", () => {
  describe("happy path", () => {
    it("confirms all payments when bank always accepts", async () => {
      const { store, bank, runner } = makeRunner();
      const dist = makeDist("d1", 300, [
        { id: "a", basis: 1 },
        { id: "b", basis: 1 },
        { id: "c", basis: 1 },
      ]);

      const result = await runner.run(dist);

      expect(result.status).toBe("COMPLETED");
      expect(result.exceptions).toHaveLength(0);
      expect(result.totalConfirmedCents).toBe(300);

      const payments = store.listPayments("d1");
      expect(payments.every((p) => p.state === "CONFIRMED")).toBe(true);
    });

    it("writes intent before bank call (SENDING before CONFIRMED in audit)", async () => {
      const { store, runner } = makeRunner();
      const dist = makeDist("d2", 100, [{ id: "a", basis: 1 }]);

      await runner.run(dist);

      const audit = store.listAudit("d2");
      const sending = audit.find((e) => e.toState === "SENDING");
      const confirmed = audit.find((e) => e.toState === "CONFIRMED");
      expect(sending).toBeDefined();
      expect(confirmed).toBeDefined();
      expect(sending!.timestamp).toBeLessThan(confirmed!.timestamp);
    });

    it("skips zero-cent allocations without creating a payment", async () => {
      const { store, runner } = makeRunner();
      const dist = makeDist("d3", 100, [
        { id: "a", basis: 1 },
        { id: "b", basis: 0 }, // zero basis -> zero cents
      ]);

      await runner.run(dist);

      const payments = store.listPayments("d3");
      // Only investor 'a' gets a payment record
      expect(payments).toHaveLength(1);
      expect(payments[0]!.investorId).toBe("a");
    });
  });

  describe("idempotency key", () => {
    it("builds consistent keys for the same inputs", () => {
      const k1 = buildIdempotencyKey("dist-1", "inv-1", 1);
      const k2 = buildIdempotencyKey("dist-1", "inv-1", 1);
      expect(k1).toBe(k2);
    });

    it("builds different keys for different investors", () => {
      const k1 = buildIdempotencyKey("dist-1", "inv-1", 1);
      const k2 = buildIdempotencyKey("dist-1", "inv-2", 1);
      expect(k1).not.toBe(k2);
    });

    it("builds different keys for different instruction numbers", () => {
      const k1 = buildIdempotencyKey("dist-1", "inv-1", 1);
      const k2 = buildIdempotencyKey("dist-1", "inv-1", 2);
      expect(k1).not.toBe(k2);
    });
  });

  describe("transient retries", () => {
    it("retries and confirms after transient rejections below threshold", async () => {
      // 2 transient rejections then accept; maxTransientRetries = 3
      let calls = 0;
      const store = new MemoryStore();
      const bank: import("../src/core/types.js").Bank = {
        async send() {
          calls++;
          if (calls < 3) return { type: "REJECTED_TRANSIENT", reason: "flaky" };
          return { type: "ACCEPTED" };
        },
        async getStatus() { return { type: "NOT_FOUND" }; },
        getSettledKeys() { return new Map(); },
      };

      let now = 0;
      const runner = new Runner({
        store, bank,
        clock: { now: () => now++ },
        rng: rngFromSeed(1),
        config: { maxTransientRetries: 3, backoffBaseMs: 0 },
      });

      const dist = makeDist("d4", 100, [{ id: "a", basis: 1 }]);
      const result = await runner.run(dist);

      expect(result.status).toBe("COMPLETED");
      expect(store.listPayments("d4")[0]!.state).toBe("CONFIRMED");
    });

    it("moves to FAILED after retries exhausted", async () => {
      const store = new MemoryStore();
      const bank: import("../src/core/types.js").Bank = {
        async send() { return { type: "REJECTED_TRANSIENT", reason: "always flaky" }; },
        async getStatus() { return { type: "NOT_FOUND" }; },
        getSettledKeys() { return new Map(); },
      };

      let now = 0;
      const runner = new Runner({
        store, bank,
        clock: { now: () => now++ },
        rng: rngFromSeed(1),
        config: { maxTransientRetries: 3, backoffBaseMs: 0 },
      });

      const dist = makeDist("d5", 100, [{ id: "a", basis: 1 }]);
      const result = await runner.run(dist);

      expect(result.status).toBe("COMPLETED_WITH_EXCEPTIONS");
      expect(store.listPayments("d5")[0]!.state).toBe("FAILED");
    });
  });

  describe("crash and restart", () => {
    it("recovers correctly after crash at afterIntentRecorded", async () => {
      const store = new MemoryStore();
      const bank = new FakeBank(rngFromSeed(1), {
        permanentRejectRate: 0,
        transientRejectRate: 0,
        timeoutRate: 0,
        statusTimeoutRate: 0,
      });
      let now = 0;
      const clock = { now: () => now++ };

      const runner1 = new Runner({
        store, bank,
        clock, rng: rngFromSeed(1),
        crashAt: "afterIntentRecorded",
      });

      const dist = makeDist("d-crash", 100, [{ id: "a", basis: 1 }]);

      await expect(runner1.run(dist)).rejects.toBeInstanceOf(CrashInjected);

      // Payment should be in SENDING (intent recorded before crash)
      const paymentAfterCrash = store.listPayments("d-crash")[0];
      expect(paymentAfterCrash!.state).toBe("SENDING");

      // Restart over same store + bank
      const runner2 = new Runner({
        store, bank, clock, rng: rngFromSeed(2),
        config: { settleWindowMs: 0 }, // exit window immediately so NOT_FOUND triggers resend
      });
      const result = await runner2.run(dist);

      expect(result.status).toBe("COMPLETED");
      expect(store.listPayments("d-crash")[0]!.state).toBe("CONFIRMED");
    });
  });

  describe("break-it flags", () => {
    it("skipIntentRecord: payment goes straight from CREATED to bank without SENDING audit entry", async () => {
      const store = new MemoryStore();
      const bank = new FakeBank(rngFromSeed(1), {
        permanentRejectRate: 0,
        transientRejectRate: 0,
        timeoutRate: 0,
      });
      let now = 0;
      const runner = new Runner({
        store, bank,
        clock: { now: () => now++ },
        rng: rngFromSeed(1),
        config: { skipIntentRecord: true },
      });

      const dist = makeDist("d-skip", 100, [{ id: "a", basis: 1 }]);
      await runner.run(dist);

      const audit = store.listAudit("d-skip");
      const sendingEntry = audit.find((e) => e.toState === "SENDING" && e.event === "SEND_INTENT_RECORDED");
      expect(sendingEntry).toBeUndefined();
    });
  });

  describe("per-payment max", () => {
    it("throws if any allocation exceeds perPaymentMaxCents", async () => {
      const { runner } = makeRunner({ config: { perPaymentMaxCents: 50 } });
      const dist = makeDist("d-max", 100, [{ id: "a", basis: 1 }]);
      await expect(runner.run(dist)).rejects.toThrow(RangeError);
    });
  });
});
