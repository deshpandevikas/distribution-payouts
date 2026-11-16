import { describe, it, expect } from "vitest";
import { reconcile } from "../src/core/reconcile.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { rngFromSeed } from "../harness/generate.js";
import type { Payment } from "../src/core/types.js";

function makePayment(overrides: Partial<Payment> & { id: string; idempotencyKey: string }): Payment {
  return {
    distributionId: "dist-1",
    investorId: overrides.id,
    amountCents: 1000,
    instructionNo: 1,
    state: "CONFIRMED",
    transientRetries: 0,
    statusChecks: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("reconcile", () => {
  it("reports clean when our CONFIRMED set matches bank settled set", async () => {
    const store = new MemoryStore();
    const bank = new FakeBank(rngFromSeed(1), {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    await bank.send("key-1", 1000, "r");
    store.savePayment(makePayment({ id: "pay-1", idempotencyKey: "key-1", amountCents: 1000 }));

    const report = reconcile("dist-1", store, bank, 0);
    expect(report.clean).toBe(true);
    expect(report.mismatches).toHaveLength(0);
  });

  it("reports OURS_ONLY when we show CONFIRMED but bank has no record", () => {
    const store = new MemoryStore();
    // Bank with no sends  -  getSettledKeys() returns empty
    const bank = new FakeBank(rngFromSeed(1), { permanentRejectRate: 0, transientRejectRate: 0, timeoutRate: 0 });

    store.savePayment(makePayment({ id: "pay-1", idempotencyKey: "key-orphan", amountCents: 500 }));

    const report = reconcile("dist-1", store, bank, 0);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]!.type).toBe("OURS_ONLY");
    expect(report.mismatches[0]!.key).toBe("key-orphan");
  });

  it("reports BANK_ONLY when bank settled a key we have no record for", async () => {
    const store = new MemoryStore();
    const bank = new FakeBank(rngFromSeed(1), {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    await bank.send("key-ghost", 999, "r");
    // Don't save any payment in store

    const report = reconcile("dist-1", store, bank, 0);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]!.type).toBe("BANK_ONLY");
    expect(report.mismatches[0]!.bankAmountCents).toBe(999);
  });

  it("reports STATE_MISMATCH when bank settled a key but our payment is not CONFIRMED", async () => {
    const store = new MemoryStore();
    const bank = new FakeBank(rngFromSeed(1), {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    await bank.send("key-mismatch", 1000, "r");
    store.savePayment(makePayment({
      id: "pay-mismatch",
      idempotencyKey: "key-mismatch",
      amountCents: 1000,
      state: "MANUAL_REVIEW",
    }));

    const report = reconcile("dist-1", store, bank, 0);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]!.type).toBe("STATE_MISMATCH");
    expect(report.mismatches[0]!.ourState).toBe("MANUAL_REVIEW");
  });

  it("never auto-fixes  -  store and bank are unchanged after reconcile", async () => {
    const store = new MemoryStore();
    const bank = new FakeBank(rngFromSeed(1), {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
    });

    await bank.send("key-1", 1000, "r");
    // Intentional mismatch: our amount differs
    store.savePayment(makePayment({ id: "pay-1", idempotencyKey: "key-1", amountCents: 999 }));

    reconcile("dist-1", store, bank, 0);

    // Store is unchanged
    expect(store.getPaymentByKey("key-1")?.amountCents).toBe(999);
    // Bank is unchanged
    expect(bank.getSettledKeys().get("key-1")).toBe(1000);
  });

  it("reports AMOUNT_MISMATCH when amounts differ", async () => {
    const store = new MemoryStore();
    const bank = new FakeBank(rngFromSeed(1), {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    await bank.send("key-amt", 1000, "r");
    store.savePayment(makePayment({ id: "pay-amt", idempotencyKey: "key-amt", amountCents: 500 }));

    const report = reconcile("dist-1", store, bank, 0);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]!.type).toBe("AMOUNT_MISMATCH");
    expect(report.mismatches[0]!.ourAmountCents).toBe(500);
    expect(report.mismatches[0]!.bankAmountCents).toBe(1000);
  });

  it("only includes payments for the requested distributionId", async () => {
    const store = new MemoryStore();
    const bank = new FakeBank(rngFromSeed(1), {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    // Payment for dist-1
    await bank.send("key-d1", 100, "r");
    store.savePayment(makePayment({ id: "pay-d1", idempotencyKey: "key-d1", distributionId: "dist-1", amountCents: 100 }));

    // Payment for dist-2 (different distribution, same store)
    store.savePayment(makePayment({ id: "pay-d2", idempotencyKey: "key-d2", distributionId: "dist-2", amountCents: 200 }));

    const report = reconcile("dist-1", store, bank, 0);
    expect(report.clean).toBe(true);
  });
});
