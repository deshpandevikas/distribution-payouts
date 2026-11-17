/**
 * Store contract.
 *
 * One suite, two implementations. Anything the runner relies on must hold for
 * both: the MemoryStore is the reference, the SQLite store is the one that has
 * to survive a process being killed. Writing this once and running it twice is
 * what stops the two from drifting (F2).
 *
 * These tests are deliberately implementation-blind: no SQL, no table names, no
 * connection handling. Persistence across a reopen is the only test that needs
 * a file, and it lives at the bottom under its own describe.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/store/memoryStore.js";
import { SqliteStore } from "../src/store/sqliteStore.js";
import type { Store, Payment, AuditEntry, AlertRecord } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function payment(over: Partial<Payment> = {}): Payment {
  const id = over.id ?? "pay-1";
  return {
    id,
    distributionId: "dist-1",
    investorId: "inv-1",
    amountCents: 1_000,
    idempotencyKey: `key:${id}`,
    bankDetails: "routing:1",
    instructionNo: 1,
    state: "CREATED",
    transientRetries: 0,
    statusChecks: 0,
    createdAt: 0,
    updatedAt: 0,
    lastSentAt: 0,
    ...over,
  };
}

function auditEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    paymentId: "pay-1",
    distributionId: "dist-1",
    investorId: "inv-1",
    event: "SEND_INTENT_RECORDED",
    fromState: "CREATED",
    toState: "SENDING",
    timestamp: 1,
    ...over,
  };
}

function alertRecord(over: Partial<AlertRecord> = {}): AlertRecord {
  return {
    kind: "ALLOCATION_SKIPPED",
    distributionId: "dist-1",
    detail: "zero-cent allocation for investor inv-2",
    timestamp: 2,
    ...over,
  };
}

interface Harness {
  store: Store;
  close: () => void;
}

const IMPLEMENTATIONS: Array<{ name: string; create: () => Harness }> = [
  {
    name: "MemoryStore",
    create: () => ({ store: new MemoryStore(), close: () => {} }),
  },
  {
    name: "SqliteStore",
    create: () => {
      const store = new SqliteStore(":memory:");
      return { store, close: () => store.close() };
    },
  },
];

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe.each(IMPLEMENTATIONS)("Store contract: $name", ({ create }) => {
  let h: Harness;

  beforeEach(() => {
    h = create();
  });

  afterEach(() => {
    h.close();
  });

  it("round-trips every payment field", () => {
    const p = payment({
      id: "pay-42",
      distributionId: "dist-9",
      investorId: "inv-7",
      amountCents: 123_456,
      idempotencyKey: "key-abc",
      bankDetails: "routing:9:7",
      instructionNo: 3,
      state: "UNKNOWN",
      transientRetries: 2,
      statusChecks: 4,
      createdAt: 10,
      updatedAt: 20,
      lastSentAt: 15,
    });

    h.store.savePayment(p);

    expect(h.store.getPayment("pay-42")).toEqual(p);
  });

  it("finds a payment by idempotency key", () => {
    h.store.savePayment(payment({ id: "pay-a", idempotencyKey: "key-a" }));

    expect(h.store.getPaymentByKey("key-a")?.id).toBe("pay-a");
    expect(h.store.getPaymentByKey("key-missing")).toBeUndefined();
  });

  it("scopes listPayments to its own distribution", () => {
    h.store.savePayment(payment({ id: "p1", investorId: "i1", idempotencyKey: "k1" }));
    h.store.savePayment(payment({ id: "p2", investorId: "i2", idempotencyKey: "k2" }));
    h.store.savePayment(
      payment({ id: "p3", distributionId: "dist-2", investorId: "i3", idempotencyKey: "k3" }),
    );

    expect(h.store.listPayments("dist-1").map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(h.store.listPayments("dist-2").map((p) => p.id)).toEqual(["p3"]);
    expect(h.store.listPayments("dist-none")).toEqual([]);
  });

  it("hands out copies, not live objects", () => {
    h.store.savePayment(payment({ id: "pay-copy", idempotencyKey: "key-copy" }));

    const first = h.store.getPayment("pay-copy")!;
    first.state = "CONFIRMED";
    first.amountCents = 999_999;

    expect(h.store.getPayment("pay-copy")!.state).toBe("CREATED");
    expect(h.store.getPayment("pay-copy")!.amountCents).toBe(1_000);

    const listed = h.store.listPayments("dist-1")[0]!;
    listed.state = "FAILED";
    expect(h.store.listPayments("dist-1")[0]!.state).toBe("CREATED");
  });

  it("writes the state change and its audit row in one transition()", () => {
    h.store.savePayment(payment({ id: "pay-t", idempotencyKey: "key-t" }));
    const moved = payment({ id: "pay-t", idempotencyKey: "key-t", state: "SENDING", updatedAt: 5 });

    h.store.transition(moved, auditEntry({ paymentId: "pay-t", timestamp: 5 }));

    expect(h.store.getPayment("pay-t")!.state).toBe("SENDING");
    expect(h.store.listAudit("dist-1")).toEqual([auditEntry({ paymentId: "pay-t", timestamp: 5 })]);
  });

  it("keeps audit append order and scopes by distribution", () => {
    h.store.appendAudit(auditEntry({ timestamp: 1, toState: "SENDING" }));
    h.store.appendAudit(
      auditEntry({ timestamp: 2, fromState: "SENDING", toState: "CONFIRMED", event: "BANK_ACCEPTED" }),
    );
    h.store.appendAudit(auditEntry({ distributionId: "dist-2", paymentId: "pay-other", timestamp: 3 }));

    const entries = h.store.listAudit("dist-1");
    expect(entries.map((e) => e.timestamp)).toEqual([1, 2]);
    expect(entries.map((e) => e.toState)).toEqual(["SENDING", "CONFIRMED"]);
    expect(h.store.listAudit("dist-2").map((e) => e.paymentId)).toEqual(["pay-other"]);
  });

  it("round-trips optional audit fields as absent, not undefined-valued keys", () => {
    h.store.appendAudit(auditEntry({ timestamp: 1 }));

    const entry = h.store.listAudit("dist-1")[0]!;
    expect(entry).toEqual(auditEntry({ timestamp: 1 }));
    expect("reason" in entry).toBe(false);
  });

  it("keeps alerts separate from payment audit, optional fields intact", () => {
    h.store.appendAlert(alertRecord());
    h.store.appendAlert(
      alertRecord({
        kind: "BANK_EVENT_FOR_UNKNOWN_KEY",
        paymentId: "pay-1",
        investorId: "inv-1",
        event: "ASYNC_CONFIRM",
        detail: "bank event for unknown key",
        timestamp: 3,
      }),
    );

    const alerts = h.store.listAlerts("dist-1");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toEqual(alertRecord());
    expect(alerts[1]).toEqual(
      alertRecord({
        kind: "BANK_EVENT_FOR_UNKNOWN_KEY",
        paymentId: "pay-1",
        investorId: "inv-1",
        event: "ASYNC_CONFIRM",
        detail: "bank event for unknown key",
        timestamp: 3,
      }),
    );
    // An alert must never look like a payment state change.
    expect(h.store.listAudit("dist-1")).toEqual([]);
  });

  it("rejects a second payment for the same (distribution, investor)", () => {
    h.store.savePayment(payment({ id: "pay-u1", investorId: "inv-same", idempotencyKey: "key-u1" }));

    expect(() =>
      h.store.savePayment(
        payment({ id: "pay-u2", investorId: "inv-same", idempotencyKey: "key-u2" }),
      ),
    ).toThrow();

    expect(h.store.listPayments("dist-1").map((p) => p.id)).toEqual(["pay-u1"]);
  });

  it("rejects a second payment with the same idempotency key", () => {
    h.store.savePayment(payment({ id: "pay-k1", investorId: "inv-k1", idempotencyKey: "key-dup" }));

    expect(() =>
      h.store.savePayment(
        payment({ id: "pay-k2", investorId: "inv-k2", idempotencyKey: "key-dup" }),
      ),
    ).toThrow();

    expect(h.store.getPaymentByKey("key-dup")?.id).toBe("pay-k1");
  });

  it("updates an existing payment in place without duplicating it", () => {
    h.store.savePayment(payment({ id: "pay-up", idempotencyKey: "key-up" }));
    h.store.savePayment(payment({ id: "pay-up", idempotencyKey: "key-up", state: "SENDING", statusChecks: 2 }));

    const rows = h.store.listPayments("dist-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.statusChecks).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Persistence - SQLite only, by nature
// ---------------------------------------------------------------------------

describe("SqliteStore persistence", () => {
  it("survives closing and reopening the same file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-store-"));
    const file = join(dir, "payouts.db");
    try {
      const first = new SqliteStore(file);
      first.savePayment(payment({ id: "pay-p", idempotencyKey: "key-p", state: "SENDING" }));
      first.appendAudit(auditEntry({ paymentId: "pay-p" }));
      first.appendAlert(alertRecord({ paymentId: "pay-p" }));
      first.close();

      const second = new SqliteStore(file);
      expect(second.getPayment("pay-p")?.state).toBe("SENDING");
      expect(second.getPaymentByKey("key-p")?.id).toBe("pay-p");
      expect(second.listAudit("dist-1")).toHaveLength(1);
      expect(second.listAlerts("dist-1")).toHaveLength(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
