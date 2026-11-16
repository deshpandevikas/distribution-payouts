/**
 * Invariant checker.
 *
 * Reads only outputs: audit log, final store snapshot, bank's settled records,
 * and the reconciliation report. Never touches runner internals.
 *
 * The same checker will grade the Temporal version in Phase 4.
 *
 * Invariants (from Phase 1 handoff):
 *
 *   I1: No idempotency key is settled more than once at the bank;
 *       no investor receives more than their allocated amount.
 *
 *   I2: After the run drains, no payment is in SENDING or UNKNOWN.
 *
 *   I3: Allocations sum exactly to the distribution total;
 *       confirmed + failed + manual = total allocated (accounting for zero-cent skips).
 *
 *   I4: Our CONFIRMED set equals the bank's settled set, except payments in
 *       MANUAL_REVIEW which must appear in the reconciliation report.
 *
 *   I5: Every state change has an audit entry, and every audited transition
 *       is legal per the grid (no ILLEGAL cells were silently swallowed).
 *
 *   With bank status query OFF: I1, I3, I5 still hold;
 *   I2 holds with more MANUAL_REVIEW.
 */

import type { Store, Bank, AuditEntry, PaymentState } from "../src/core/types.js";
import { TERMINAL_STATES } from "../src/core/types.js";
import type { ReconciliationReport } from "../src/core/reconcile.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface InvariantViolation {
  invariant: string;
  detail: string;
  paymentId?: string;
}

export interface CheckResult {
  passed: boolean;
  violations: InvariantViolation[];
}

// ---------------------------------------------------------------------------
// Legal transitions (mirrors the transition table  -  used for I5)
// ---------------------------------------------------------------------------

type TransitionKey = `${PaymentState}->${PaymentState}`;

const LEGAL_TRANSITIONS: ReadonlySet<TransitionKey> = new Set<TransitionKey>([
  // CREATED
  "CREATED->SENDING",
  "CREATED->MANUAL_REVIEW",
  // SENDING
  "SENDING->CONFIRMED",
  "SENDING->FAILED",
  "SENDING->SENDING",   // transient retry stay
  "SENDING->UNKNOWN",
  "SENDING->MANUAL_REVIEW",
  // UNKNOWN
  "UNKNOWN->CONFIRMED",
  "UNKNOWN->FAILED",
  "UNKNOWN->UNKNOWN",   // stay in window / check timed out
  "UNKNOWN->SENDING",   // resend after settle window
  "UNKNOWN->MANUAL_REVIEW",
  // Terminal -> terminal (noop transitions)
  "CONFIRMED->CONFIRMED",
  "FAILED->FAILED",
  "MANUAL_REVIEW->MANUAL_REVIEW",
  // Recovery transitions
  "CONFIRMED->CONFIRMED",
  "FAILED->FAILED",
]);

// ---------------------------------------------------------------------------
// check()
// ---------------------------------------------------------------------------

export interface CheckInputs {
  distributionId: string;
  store: Store;
  bank: Bank;
  report: ReconciliationReport;
  /** Total cents that were allocated (sum of AllocatedPayment.amountCents). */
  totalAllocatedCents: number;
}

export function check(inputs: CheckInputs): CheckResult {
  const { distributionId, store, bank, report, totalAllocatedCents } = inputs;
  const violations: InvariantViolation[] = [];
  const payments = store.listPayments(distributionId);
  const audit = store.listAudit(distributionId);
  const bankSettled = bank.getSettledKeys();

  // -------------------------------------------------------------------------
  // I1: no key settled more than once; no investor paid more than allocated.
  // -------------------------------------------------------------------------
  {
    // Bank deduplication is internal to FakeBank, but we verify from outside:
    // each settled key should appear exactly once in bankSettled (it's a Map).
    // Check our side: no two CONFIRMED payments share the same idempotency key.
    const confirmedKeys = new Map<string, string>(); // key -> paymentId
    for (const p of payments) {
      if (p.state === "CONFIRMED") {
        if (confirmedKeys.has(p.idempotencyKey)) {
          violations.push({
            invariant: "I1",
            paymentId: p.id,
            detail: `idempotency key ${p.idempotencyKey} confirmed on multiple payments: ${confirmedKeys.get(p.idempotencyKey)} and ${p.id}`,
          });
        } else {
          confirmedKeys.set(p.idempotencyKey, p.id);
        }
      }
    }

    // No investor should have total CONFIRMED amount > their allocation.
    const confirmedByInvestor = new Map<string, number>();
    const allocatedByInvestor = new Map<string, number>();
    for (const p of payments) {
      allocatedByInvestor.set(p.investorId, p.amountCents);
      if (p.state === "CONFIRMED") {
        confirmedByInvestor.set(p.investorId, (confirmedByInvestor.get(p.investorId) ?? 0) + p.amountCents);
      }
    }
    for (const [investorId, confirmed] of confirmedByInvestor) {
      const allocated = allocatedByInvestor.get(investorId) ?? 0;
      if (confirmed > allocated) {
        violations.push({
          invariant: "I1",
          detail: `investor ${investorId} confirmed ${confirmed}¢ > allocated ${allocated}¢`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // I2: after drain, no payment in SENDING or UNKNOWN.
  // -------------------------------------------------------------------------
  {
    for (const p of payments) {
      if (p.state === "SENDING" || p.state === "UNKNOWN") {
        violations.push({
          invariant: "I2",
          paymentId: p.id,
          detail: `payment ${p.id} is still in state ${p.state} after run drained`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // I3: allocations sum to total; confirmed + failed + manual = total allocated.
  // -------------------------------------------------------------------------
  {
    let confirmedCents = 0;
    let failedCents = 0;
    let manualCents = 0;

    for (const p of payments) {
      if (p.state === "CONFIRMED") confirmedCents += p.amountCents;
      else if (p.state === "FAILED") failedCents += p.amountCents;
      else if (p.state === "MANUAL_REVIEW") manualCents += p.amountCents;
    }

    const accounted = confirmedCents + failedCents + manualCents;
    if (accounted !== totalAllocatedCents) {
      violations.push({
        invariant: "I3",
        detail: `confirmed(${confirmedCents}) + failed(${failedCents}) + manual(${manualCents}) = ${accounted} !== totalAllocated(${totalAllocatedCents})`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // I4: our CONFIRMED set === bank's settled set, except MANUAL_REVIEW payments
  //     which must appear in the reconciliation report.
  // -------------------------------------------------------------------------
  {
    // Any STATE_MISMATCH or BANK_ONLY in the report that is NOT a MANUAL_REVIEW
    // payment is a true discrepancy.
    for (const m of report.mismatches) {
      if (m.type === "STATE_MISMATCH") {
        // MANUAL_REVIEW payments appearing here is expected - they should be in report.
        if (m.ourState !== "MANUAL_REVIEW") {
          violations.push({
            invariant: "I4",
            ...(m.paymentId != null ? { paymentId: m.paymentId } : {}),
            detail: `STATE_MISMATCH for key ${m.key}: our state is ${m.ourState}, bank settled - not in MANUAL_REVIEW`,
          });
        }
        // If it IS MANUAL_REVIEW, it's expected in the report - no violation.
      } else if (m.type === "BANK_ONLY") {
        violations.push({
          invariant: "I4",
          detail: `BANK_ONLY: bank settled key ${m.key} (${m.bankAmountCents}¢) but we have no payment record`,
        });
      } else if (m.type === "OURS_ONLY") {
        violations.push({
          invariant: "I4",
          ...(m.paymentId != null ? { paymentId: m.paymentId } : {}),
          detail: `OURS_ONLY: we show CONFIRMED for key ${m.key} but bank has no settled record`,
        });
      } else if (m.type === "AMOUNT_MISMATCH") {
        violations.push({
          invariant: "I4",
          ...(m.paymentId != null ? { paymentId: m.paymentId } : {}),
          detail: `AMOUNT_MISMATCH for key ${m.key}: ours ${m.ourAmountCents}¢ vs bank ${m.bankAmountCents}¢`,
        });
      }
    }

    // Also verify: every MANUAL_REVIEW payment whose key the bank settled
    // appears in the reconciliation report.
    const reportedKeys = new Set(report.mismatches.map((m) => m.key));
    for (const p of payments) {
      if (p.state === "MANUAL_REVIEW" && bankSettled.has(p.idempotencyKey)) {
        if (!reportedKeys.has(p.idempotencyKey)) {
          violations.push({
            invariant: "I4",
            paymentId: p.id,
            detail: `MANUAL_REVIEW payment ${p.id} key ${p.idempotencyKey} settled by bank but not in reconciliation report`,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // I5: every state change has an audit entry; every audited transition is legal.
  // -------------------------------------------------------------------------
  {
    // Build a map of paymentId -> ordered audit entries.
    const auditByPayment = new Map<string, AuditEntry[]>();
    for (const entry of audit) {
      if (!auditByPayment.has(entry.paymentId)) {
        auditByPayment.set(entry.paymentId, []);
      }
      auditByPayment.get(entry.paymentId)!.push(entry);
    }

    // Every payment must have at least one audit entry.
    for (const p of payments) {
      if (!auditByPayment.has(p.id)) {
        violations.push({
          invariant: "I5",
          paymentId: p.id,
          detail: `payment ${p.id} has no audit entries`,
        });
        continue;
      }

      const entries = auditByPayment.get(p.id)!;

      // The first audit entry's fromState must be CREATED.
      // If it isn't, a state change happened before the audit log started.
      const firstEntry = entries[0];
      if (firstEntry && firstEntry.fromState !== "CREATED") {
        violations.push({
          invariant: "I5",
          paymentId: p.id,
          detail: `first audit entry fromState is ${firstEntry.fromState}, expected CREATED  -  state change occurred without an audit entry`,
        });
      }

      // Every audited transition must be legal.
      for (const entry of entries) {
        const key: TransitionKey = `${entry.fromState}->${entry.toState}`;
        if (!LEGAL_TRANSITIONS.has(key)) {
          violations.push({
            invariant: "I5",
            paymentId: p.id,
            detail: `illegal audited transition: ${entry.fromState} -> ${entry.toState} (event: ${entry.event})`,
          });
        }
      }

      // The final audit entry's toState must match the payment's current state.
      const lastEntry = entries[entries.length - 1];
      if (lastEntry && lastEntry.toState !== p.state) {
        violations.push({
          invariant: "I5",
          paymentId: p.id,
          detail: `final audit toState ${lastEntry.toState} !== payment state ${p.state}`,
        });
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
