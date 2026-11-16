/**
 * In-memory implementation of the Store port.
 *
 * All state lives in Maps on the heap  -  no persistence, no I/O.
 * Phase 5 replaces this with a SQLite-backed store; the interface stays the same.
 *
 * Thread safety: not a concern in Phase 1 (single-threaded Node event loop,
 * no worker threads, no async interleaving inside a single runner tick).
 */

import type {
  Store,
  Payment,
  PaymentId,
  IdempotencyKey,
  DistributionId,
  AuditEntry,
} from "../core/types.js";

export class MemoryStore implements Store {
  private readonly payments = new Map<PaymentId, Payment>();
  private readonly keyIndex = new Map<IdempotencyKey, PaymentId>();
  private readonly auditLog: AuditEntry[] = [];

  // -------------------------------------------------------------------------
  // Payment writes
  // -------------------------------------------------------------------------

  savePayment(payment: Payment): void {
    this.payments.set(payment.id, { ...payment });
    this.keyIndex.set(payment.idempotencyKey, payment.id);
  }

  // -------------------------------------------------------------------------
  // Payment reads
  // -------------------------------------------------------------------------

  getPayment(id: PaymentId): Payment | undefined {
    const p = this.payments.get(id);
    return p ? { ...p } : undefined;
  }

  getPaymentByKey(key: IdempotencyKey): Payment | undefined {
    const id = this.keyIndex.get(key);
    if (id === undefined) return undefined;
    return this.getPayment(id);
  }

  listPayments(distributionId: DistributionId): Payment[] {
    const result: Payment[] = [];
    for (const payment of this.payments.values()) {
      if (payment.distributionId === distributionId) {
        result.push({ ...payment });
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Audit log  -  append-only
  // -------------------------------------------------------------------------

  appendAudit(entry: AuditEntry): void {
    this.auditLog.push({ ...entry });
  }

  listAudit(distributionId: DistributionId): AuditEntry[] {
    return this.auditLog
      .filter((e) => e.distributionId === distributionId)
      .map((e) => ({ ...e }));
  }
}
