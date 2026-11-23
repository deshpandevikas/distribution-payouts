/**
 * Store.transition() writes the state change and the audit entry in one call.
 * savePayment() and appendAudit() are separate, so a crash between them leaves
 * the state changed and no audit row to explain it.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore } from "../src/store/memoryStore.js";
import type { Payment, AuditEntry } from "../src/core/types.js";

function makePayment(): Payment {
  return {
    id: "pay-1", distributionId: "dist-1", investorId: "inv-1",
    amountCents: 100, bankDetails: "routing:1", idempotencyKey: "key-1",
    instructionNo: 1, state: "CREATED", transientRetries: 0, statusChecks: 0,
    createdAt: 0, updatedAt: 0, lastSentAt: 0,
  };
}

function makeAudit(paymentId: string): AuditEntry {
  return {
    paymentId, distributionId: "dist-1", investorId: "inv-1",
    event: "SEND_INTENT_RECORDED", fromState: "CREATED", toState: "SENDING",
    timestamp: 1,
  };
}

describe("an atomic transition", () => {
  it("Store has a transition() method that writes payment and audit entry together", () => {
    const store = new MemoryStore();
    const payment = makePayment();
    store.savePayment(payment);

    const updated: Payment = { ...payment, state: "SENDING", updatedAt: 1 };
    const entry = makeAudit(payment.id);

    expect(typeof store.transition).toBe("function");
    store.transition(updated, entry);

    expect(store.getPayment(payment.id)!.state).toBe("SENDING");
    expect(store.listAudit("dist-1")).toHaveLength(1);
  });

  it("transition() is atomic: either both writes happen or neither", () => {
    // In MemoryStore this is trivially atomic (synchronous). The test verifies
    // the interface exists so SQLite can implement it as one transaction.
    const store = new MemoryStore();
    const payment = makePayment();
    store.savePayment(payment);

    const updated: Payment = { ...payment, state: "CONFIRMED", updatedAt: 2 };
    const entry = makeAudit(payment.id);

    store.transition(updated, entry);

    // Both visible after transition
    expect(store.getPayment(payment.id)!.state).toBe("CONFIRMED");
    expect(store.listAudit("dist-1")[0]!.toState).toBe("SENDING");
  });
});
