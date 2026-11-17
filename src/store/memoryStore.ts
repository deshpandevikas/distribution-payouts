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
  AlertRecord,
} from "../core/types.js";

export class MemoryStore implements Store {
  private readonly payments = new Map<PaymentId, Payment>();
  private readonly keyIndex = new Map<IdempotencyKey, PaymentId>();
  /** (distributionId, investorId) -> paymentId, mirroring the SQLite unique constraint. */
  private readonly investorIndex = new Map<string, PaymentId>();
  private readonly auditLog: AuditEntry[] = [];
  private readonly alerts: AlertRecord[] = [];

  // -------------------------------------------------------------------------
  // Payment writes
  // -------------------------------------------------------------------------

  savePayment(payment: Payment): void {
    // Same two rules the SQLite schema enforces, so the contract suite means the
    // same thing for both stores. An update writes the same id, which is allowed.
    const keyOwner = this.keyIndex.get(payment.idempotencyKey);
    if (keyOwner !== undefined && keyOwner !== payment.id) {
      throw new Error(
        `duplicate idempotency key ${payment.idempotencyKey}: already used by payment ${keyOwner}`,
      );
    }

    const pair = `${payment.distributionId}\u0000${payment.investorId}`;
    const pairOwner = this.investorIndex.get(pair);
    if (pairOwner !== undefined && pairOwner !== payment.id) {
      throw new Error(
        `duplicate payment for distribution ${payment.distributionId} investor ${payment.investorId}: already ${pairOwner}`,
      );
    }

    this.payments.set(payment.id, { ...payment });
    this.keyIndex.set(payment.idempotencyKey, payment.id);
    this.investorIndex.set(pair, payment.id);
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

  // -------------------------------------------------------------------------
  // Alerts - append-only, not payment state changes
  // -------------------------------------------------------------------------

  appendAlert(record: AlertRecord): void {
    this.alerts.push({ ...record });
  }

  listAlerts(distributionId: DistributionId): AlertRecord[] {
    return this.alerts
      .filter((a) => a.distributionId === distributionId)
      .map((a) => ({ ...a }));
  }

  transition(payment: Payment, entry: AuditEntry): void {
    this.savePayment(payment);
    this.appendAudit(entry);
  }
}
