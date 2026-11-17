/**
 * R4 regression tests:
 *   (a) Timeout that resolves CONFIRMED never queues ASYNC_CONFIRM - only lying transients do
 *   (b) No duplicate-confirm rate
 *   (c) Async events drained only once at end, not mid-run
 *   (d) Unknown-key async events silently dropped instead of alerting
 */

import { describe, it, expect } from "vitest";
import { FakeBank } from "../src/bank/fakeBank.js";
import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { allocate } from "../src/core/allocation.js";
import type { Distribution } from "../src/core/types.js";

function makeDist(id: string, totalCents: number, bankDetails = "routing:test"): Distribution {
  const investor = { id: "inv-1", name: "Test", bankDetails };
  const allocations = allocate(totalCents, [{ investor, basisUnits: 1 }]);
  return { id, totalCents, allocations, createdAt: 0 };
}

describe("R4a: timeout with async CONFIRMED queues ASYNC_CONFIRM", () => {
  it("a timeout that resolves CONFIRMED queues an ASYNC_CONFIRM event", async () => {
    // Force 100% timeout, 100% async confirm
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 1,
      asyncConfirmRate: 1,
      statusTimeoutRate: 0,
      statusQueryEnabled: true,
    });

    await bank.send("key-t", 100, "routing:test");

    // Before fix: drainAsyncEvents() returns [] for timeout outcomes
    // After fix: drainAsyncEvents() returns [{key: "key-t", type: "ASYNC_CONFIRM"}]
    const events = bank.drainAsyncEvents();
    expect(events.some(e => e.key === "key-t" && e.type === "ASYNC_CONFIRM")).toBe(true);
  });
});

describe("R4b: duplicate confirm rate", () => {
  it("FakeBank supports a duplicateConfirmRate config option", async () => {
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
      duplicateConfirmRate: 1, // every ACCEPTED also queues a second ASYNC_CONFIRM
    });

    await bank.send("key-dup", 100, "routing:test");

    // Before fix: no duplicateConfirmRate exists, drainAsyncEvents() returns []
    // After fix: drainAsyncEvents() returns the duplicate ASYNC_CONFIRM
    const events = bank.drainAsyncEvents();
    expect(events.some(e => e.key === "key-dup" && e.type === "ASYNC_CONFIRM")).toBe(true);
  });
});

describe("R4c: async events drained mid-run at seeded random points", () => {
  it("runner delivers async events before the run ends (mid-run drain)", async () => {
    // A lying transient queues ASYNC_CONFIRM. If drained only at the end, the
    // payment may already be FAILED from retries, and the confirm arrives post-terminal.
    // Mid-run drain delivers it while SENDING/UNKNOWN is still possible.
    const deliveredMidRun: string[] = [];
    const originalSend = FakeBank.prototype.drainAsyncEvents;

    // We verify by checking that the runner calls drainAsyncEvents more than once
    // across a run with multiple payments - i.e. not just at the end.
    let drainCallCount = 0;
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0.3,
      timeoutRate: 0,
      statusTimeoutRate: 0,
      lyingTransientRate: 0.5,
    });

    const origDrain = bank.drainAsyncEvents.bind(bank);
    bank.drainAsyncEvents = () => {
      drainCallCount++;
      return origDrain();
    };

    const store = new MemoryStore();
    let now = 0;
    const runner = new Runner({
      store, bank,
      clock: { now: () => now++, sleep: async () => { now += 1; } },
      rng: { next: () => 0 },
      config: { settleWindowMs: 0, backoffBaseMs: 0 },
    });

    // 5 investors - enough for mid-run drains to be observable
    const inputs = Array.from({ length: 5 }, (_, i) => ({
      investor: { id: `inv-${i}`, name: `Inv ${i}`, bankDetails: `routing:${i}` },
      basisUnits: 1,
    }));
    const dist: Distribution = {
      id: "dist-r4c",
      totalCents: 500,
      allocations: allocate(500, inputs),
      createdAt: 0,
    };

    await runner.run(dist);

    // Before fix: drainCallCount === 1 (only at end)
    // After fix: drainCallCount > 1 (mid-run drains too)
    expect(drainCallCount).toBeGreaterThan(1);
  });
});

describe("R4d: unknown-key async event alerts instead of silent drop", () => {
  it("ASYNC_CONFIRM for a key the runner never sent records an alert for the distribution", async () => {
    // Manually inject an async event for an unknown key
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    // Inject a ghost ASYNC_CONFIRM directly into the queue
    (bank as any).asyncQueue.push({ key: "ghost-key", type: "ASYNC_CONFIRM" });

    const store = new MemoryStore();
    let now = 0;
    const runner = new Runner({
      store, bank,
      clock: { now: () => now++, sleep: async () => { now += 1; } },
      rng: { next: () => 0.5 },
      config: { settleWindowMs: 0 },
    });

    const dist = makeDist("dist-r4d", 100);
    await runner.run(dist);

    // Before fix: ghost event silently dropped.
    // C4: recorded as an alert keyed to the real distribution, not as a
    // fabricated CREATED -> MANUAL_REVIEW audit row for a payment that does not
    // exist - such a row was invisible from listAudit("dist-r4d"), which is the
    // only query an operator makes.
    const alerts = store.listAlerts("dist-r4d");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("BANK_EVENT_FOR_UNKNOWN_KEY");
    expect(alerts[0]!.detail).toContain("ghost-key");

    const audit = store.listAudit("dist-r4d");
    expect(audit.filter(e => e.toState === "MANUAL_REVIEW")).toHaveLength(0);
    expect(audit.filter(e => e.paymentId.startsWith("unknown:"))).toHaveLength(0);
  });
});
