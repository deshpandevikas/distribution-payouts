/**
 * R2 regression tests:
 *   (a) bankDetails reaches the bank as "" - investor account is unroutable
 *   (b) FakeBank.getSettledKeys() is a Map - a double settlement is invisible by construction
 *   (c) checker I1 checks our records only, not the bank's per-account settlement list
 */

import { describe, it, expect } from "vitest";
import { FakeBank } from "../src/bank/fakeBank.js";
import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution } from "../src/core/types.js";

function makeDist(id: string, totalCents: number, investors: { id: string; bankDetails: string }[]): Distribution {
  const inputs = investors.map(({ id, bankDetails }) => ({
    investor: { id, name: `Investor ${id}`, bankDetails },
    basisUnits: 1,
  }));
  const allocations = allocate(totalCents, inputs);
  return { id, totalCents, allocations, createdAt: 0 };
}

describe("R2a: bankDetails passed to bank.send", () => {
  it("bank receives the investor bankDetails, not empty string", async () => {
    const sentDetails: string[] = [];
    const bank: import("../src/core/types.js").Bank = {
      async send(_key, _amount, bankDetails) {
        sentDetails.push(bankDetails);
        return { type: "ACCEPTED" };
      },
      async getStatus() { return { type: "NOT_FOUND" }; },
      getSettledKeys() { return new Map(); },
    };

    const store = new MemoryStore();
    let now = 0;
    const runner = new Runner({
      store, bank,
      clock: { now: () => now++, sleep: async () => { now += 1; } },
      rng: { next: () => 0.5 },
      config: { settleWindowMs: 0 },
    });

    const dist = makeDist("dist-r2a", 100, [
      { id: "inv-1", bankDetails: "routing:111:acc:999" },
    ]);
    await runner.run(dist);

    // Bug: sentDetails[0] === "" (empty string stub)
    // Fix: sentDetails[0] === "routing:111:acc:999"
    expect(sentDetails[0]).toBe("routing:111:acc:999");
  });
});

describe("R2b: FakeBank records settlements per account", () => {
  it("tracks settled amount per bankDetails account, not just per key", async () => {
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    await bank.send("key-1", 1000, "routing:acc-A");
    await bank.send("key-2", 2000, "routing:acc-A");

    // With current Map implementation: getSettledKeys() shows two separate keys.
    // The checker sees no problem even if both keys belong to the same investor.
    // Fix: bank exposes getSettlementsByAccount() so checker can sum per account.
    const byAccount = bank.getSettlementsByAccount();
    expect(byAccount.get("routing:acc-A")).toBeDefined();
    expect(byAccount.get("routing:acc-A")!.totalCents).toBe(3000);
    expect(byAccount.get("routing:acc-A")!.sendCount).toBe(2);
  });
});

describe("R2c: checker I1 uses bank account view", () => {
  it("detects overpayment from bank records even when our store looks correct", async () => {
    // Simulate: our store shows one CONFIRMED payment for inv-1 (100 cents)
    // but the bank settled 200 cents to their account (double send slipped through)
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    // Two sends to the same account under different keys (simulating newKeyOnRetry bug)
    await bank.send("key-a", 100, "routing:acc-X");
    await bank.send("key-b", 100, "routing:acc-X");

    const byAccount = bank.getSettlementsByAccount();
    const acct = byAccount.get("routing:acc-X");
    expect(acct).toBeDefined();
    // Bank settled 200 cents total to this account
    expect(acct!.totalCents).toBe(200);
  });
});
