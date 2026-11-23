/**
 * A same-key retry after a transient rejection must be able to confirm.
 *
 * The fake bank commits only ACCEPTED and REJECTED_PERMANENT as outcomes. A retry on a
 * transient-rejected or unresolved-timeout key rolls fresh, the way a real bank does.
 */

import { describe, it, expect } from "vitest";
import { FakeBank } from "../src/bank/fakeBank.js";
import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution } from "../src/core/types.js";

// A seeded Rng that returns values from a fixed list, then 0.5 for the rest.
function listRng(values: number[]) {
  let i = 0;
  return { next: () => i < values.length ? values[i++]! : 0.5 };
}

function makeDist(totalCents: number, investorId: string): Distribution {
  const investor = { id: investorId, name: "Test", bankDetails: "routing:test" };
  const allocations = allocate(totalCents, [{ investor, basisUnits: 1 }]);
  return { id: "dist-r0", totalCents, allocations, createdAt: 0 };
}

describe("a transient rejection does not poison the key", () => {
  it("confirms on retry after one transient rejection", async () => {
    // Bank: first roll => transient (0.15, inside permanentRejectRate=0.05 + transientRejectRate=0.1 window)
    //       second roll (retry) => accepted (0.5, above all reject thresholds)
    const bank = new FakeBank(listRng([0.08, 0.5]), {
      permanentRejectRate: 0.05,
      transientRejectRate: 0.10,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    const store = new MemoryStore();
    let now = 0;
    const runner = new Runner({
      store, bank,
      clock: { now: () => now++, sleep: async () => { now += 1; } },
      rng: { next: () => 0 }, // zero jitter
      config: { maxSendAttempts: 3, backoffBaseMs: 0, settleWindowMs: 0 },
    });

    const dist = makeDist(100, "inv-a");
    await runner.run(dist);

    const payments = store.listPayments("dist-r0");
    expect(payments[0]!.state).toBe("CONFIRMED");
  });

  it("counts confirmed payments with transientRetries > 0 as non-zero across scenarios", async () => {
    let confirmedWithRetries = 0;

    for (let seed = 1; seed <= 500; seed++) {
      let calls = 0;
      // First call: transient. Subsequent calls: accepted.
      const bank = new FakeBank({ next: () => calls++ === 0 ? 0.08 : 0.5 }, {
        permanentRejectRate: 0.05,
        transientRejectRate: 0.10,
        timeoutRate: 0,
        statusTimeoutRate: 0,
      });
      const store = new MemoryStore();
      let now = 0;
      const runner = new Runner({
        store, bank,
        clock: { now: () => now++, sleep: async () => { now += 1; } },
        rng: { next: () => 0 },
        config: { maxSendAttempts: 3, backoffBaseMs: 0, settleWindowMs: 0 },
      });

      const dist = makeDist(100, `inv-${seed}`);
      await runner.run(dist);

      const p = store.listPayments(`dist-r0`);
      if (p[0]?.state === "CONFIRMED" && p[0].transientRetries > 0) {
        confirmedWithRetries++;
      }
    }

    expect(confirmedWithRetries).toBeGreaterThan(0);
  });
});
