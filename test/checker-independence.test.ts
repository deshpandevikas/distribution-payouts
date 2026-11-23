/**
 * The checker must not trust what it is checking:
 *   (a) I4 trusts reconcile() output - a reconcile bug blinds I4
 *   (b) I5 missing continuity check (entry[i].toState === entry[i+1].fromState)
 *   (c) I5 uses runner's own transition table - an imported table bug blinds I5
 */

import { describe, it, expect } from "vitest";
import { check } from "../harness/check.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { rngFromSeed } from "../harness/generate.js";
import type { Payment, AuditEntry } from "../src/core/types.js";
import { reconcile } from "../src/core/reconcile.js";

function makePayment(id: string, key: string, state: Payment["state"], amountCents = 1000): Payment {
  return {
    id,
    distributionId: "dist-r7",
    investorId: id,
    amountCents,
    bankDetails: `routing:${id}`,
    idempotencyKey: key,
    instructionNo: 1,
    state,
    transientRetries: 0,
    statusChecks: 0,
    createdAt: 0,
    updatedAt: 1,
    lastSentAt: 0,
  };
}

function makeAuditEntry(paymentId: string, from: AuditEntry["fromState"], to: AuditEntry["toState"], event: AuditEntry["event"] = "SEND_INTENT_RECORDED"): AuditEntry {
  return {
    paymentId,
    distributionId: "dist-r7",
    investorId: paymentId,
    event,
    fromState: from,
    toState: to,
    timestamp: 1,
  };
}

describe("I4 is computed from the store and the bank, not from reconcile", () => {
  it("detects I4 violation even when reconcile() has a bug that hides it", async () => {
    // We test that check() computes I4 independently.
    // Set up: bank settled key-1, our store shows CONFIRMED for key-1 - this is clean.
    // But add a STATE_MISMATCH that reconcile would normally report - check I4 catches it
    // even if reconcile's report is intentionally empty (simulating a reconcile bug).
    const store = new MemoryStore();
    const bank = new FakeBank(rngFromSeed(1), {
      permanentRejectRate: 0,
      transientRejectRate: 0,
      timeoutRate: 0,
      statusTimeoutRate: 0,
    });

    await bank.send("key-1", 1000, "routing:pay-1");
    store.savePayment(makePayment("pay-1", "key-1", "CONFIRMED", 1000));
    store.appendAudit(makeAuditEntry("pay-1", "CREATED", "SENDING"));
    store.appendAudit(makeAuditEntry("pay-1", "SENDING", "CONFIRMED", "BANK_ACCEPTED"));

    // Bank also settled key-2 but our store has it as FAILED (STATE_MISMATCH)
    await bank.send("key-2", 500, "routing:pay-2");
    store.savePayment(makePayment("pay-2", "key-2", "FAILED", 500));
    store.appendAudit(makeAuditEntry("pay-2", "CREATED", "SENDING"));
    store.appendAudit(makeAuditEntry("pay-2", "SENDING", "FAILED", "BANK_REJECTED_PERMANENT"));

    // Pass an EMPTY reconcile report (simulates reconcile bug hiding the mismatch)
    const emptyReport = {
      distributionId: "dist-r7",
      ranAt: 0,
      ourConfirmedCount: 1,
      ourConfirmedCents: 1000,
      bankSettledCount: 2,
      bankSettledCents: 1500,
      mismatches: [], // empty - reconcile "missed" the STATE_MISMATCH
      clean: true,
    };

    const result = check({
      distributionId: "dist-r7",
      store,
      bank,
      report: emptyReport,
      totalAllocatedCents: 1500,
    });

    const i4 = result.violations.filter(v => v.invariant === "I4");
    expect(i4.length).toBeGreaterThan(0);
  });
});

describe("I5 catches a gap in the audit trail", () => {
  it("detects a gap where audit entry[i].toState !== entry[i+1].fromState", () => {
    const store = new MemoryStore();
    const bank = new FakeBank(rngFromSeed(1), {
      permanentRejectRate: 0, transientRejectRate: 0, timeoutRate: 0, statusTimeoutRate: 0,
    });

    store.savePayment(makePayment("pay-gap", "key-gap", "CONFIRMED", 100));

    // Audit has a gap: CREATED->SENDING, then UNKNOWN->CONFIRMED (fromState mismatch)
    store.appendAudit(makeAuditEntry("pay-gap", "CREATED", "SENDING", "SEND_INTENT_RECORDED"));
    store.appendAudit(makeAuditEntry("pay-gap", "UNKNOWN", "CONFIRMED", "STATUS_CONFIRMED")); // gap: should be SENDING->...

    const report = reconcile("dist-r7", store, bank, 0);
    const result = check({
      distributionId: "dist-r7",
      store,
      bank,
      report,
      totalAllocatedCents: 100,
    });

    const i5 = result.violations.filter(v => v.invariant === "I5");
    expect(i5.length).toBeGreaterThan(0);
  });
});
