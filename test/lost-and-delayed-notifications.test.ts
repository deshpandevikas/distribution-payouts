/**
 * A bank notification is not guaranteed: it can be lost or late.
 *
 * A fake bank that queues an event for every outcome that leaves a payment in
 * UNKNOWN resolves every such payment by event, so no status query is ever
 * issued from UNKNOWN. That makes UNKNOWN:BANK_TIMEOUT, UNKNOWN:STATUS_NOT_FOUND
 * and UNKNOWN:STATUS_NOT_FOUND_IN_WINDOW unreachable rather than rare.
 *
 * Real banks lose webhooks and deliver them late, so the fake bank has the same
 * two failure modes, seeded from its injected Rng so a seed stays reproducible:
 *
 *   asyncDropRate:    the notification is lost entirely
 *   asyncDelayChecks: it arrives only after N status queries for that key
 *
 * The last two cases pin the coverage: the query really runs from UNKNOWN
 * (BANK_TIMEOUT), and FAILED plus a late confirm still escalates.
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

describe("a dropped notification", () => {
  it("never reaches drainAsyncEvents, while the status query still sees the truth", async () => {
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 1,        // send times out -> UNKNOWN, money did move
      asyncConfirmRate: 1,   // ...and it would confirm
      statusTimeoutRate: 0,
      asyncDropRate: 1,      // except the notification is lost
    });

    await bank.send("key-drop", 100, "routing:test");

    // there was no way to model a lost notification at all.
    expect(bank.drainAsyncEvents(), "a dropped notification must never be delivered").toHaveLength(0);

    // The bank itself is fine - that is what makes the status query necessary.
    expect((await bank.getStatus("key-drop")).type).toBe("CONFIRMED");
  });
});

describe("a delayed notification", () => {
  it("arrives only after asyncDelayChecks status queries for that key", async () => {
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 1,
      asyncConfirmRate: 1,
      statusTimeoutRate: 0,
      asyncDelayChecks: 2,
    });

    await bank.send("key-late", 100, "routing:test");
    expect(bank.drainAsyncEvents(), "held back before any query").toHaveLength(0);

    await bank.getStatus("key-late");
    expect(bank.drainAsyncEvents(), "still held back after one query").toHaveLength(0);

    await bank.getStatus("key-late");
    const events = bank.drainAsyncEvents();
    expect(events.map(e => e.key), "delivered once the bank caught up").toEqual(["key-late"]);
    expect(events[0]!.type).toBe("ASYNC_CONFIRM");
  });
});

describe("a payment can be queried while it is UNKNOWN", () => {
  it("hits UNKNOWN:BANK_TIMEOUT when the notification is lost and the query times out", async () => {
    // Notification lost + every status query times out: the only way this
    // payment can move is the query path from UNKNOWN, which is the cell.
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 1,
      asyncConfirmRate: 1,
      asyncDropRate: 1,
      statusTimeoutRate: 1,
    });

    const store = new MemoryStore();
    let now = 0;
    const clock: Clock = {
      now: () => now++,
      sleep: async (ms: number) => { now += ms; },
    };

    const runner = new Runner({
      store, bank, clock,
      rng: { next: () => 0.5 },
      config: { settleWindowMs: 120_000, maxStatusChecks: 2, backoffBaseMs: 0 },
    });

    await runner.run(makeDist("dist-f1-timeout", 100));

    const cells = store.listAudit("dist-f1-timeout").map(e => `${e.fromState}:${e.event}`);
    expect(
      cells,
      `expected UNKNOWN:BANK_TIMEOUT, got: ${cells.join(", ")}`,
    ).toContain("UNKNOWN:BANK_TIMEOUT");
  });
});

describe("a late confirmation on a FAILED payment", () => {
  it("a late confirm on a FAILED payment escalates to MANUAL_REVIEW", async () => {
    // A lying transient on the last allowed attempt: the payment exhausts its
    // retries and reaches FAILED with the confirmation still in flight, so the
    // event lands on FAILED rather than being cancelled by another send.
    const bank = new FakeBank({ next: () => 0.5 }, {
      permanentRejectRate: 0,
      transientRejectRate: 1,
      timeoutRate: 0,
      lyingTransientRate: 1,
      statusTimeoutRate: 0,
    });

    const store = new MemoryStore();
    let now = 0;
    const clock: Clock = {
      now: () => now++,
      sleep: async (ms: number) => { now += ms; },
    };

    const runner = new Runner({
      store, bank, clock,
      rng: { next: () => 0.5 },
      config: { maxSendAttempts: 1, backoffBaseMs: 0, settleWindowMs: 0 },
    });

    await runner.run(makeDist("dist-f1-failed", 100));

    const audit = store.listAudit("dist-f1-failed");
    const cells = audit.map(e => `${e.fromState}:${e.event}`);
    expect(cells, `expected FAILED:ASYNC_CONFIRM, got: ${cells.join(", ")}`).toContain("FAILED:ASYNC_CONFIRM");
    expect(store.listPayments("dist-f1-failed")[0]!.state).toBe("MANUAL_REVIEW");
  });
});
