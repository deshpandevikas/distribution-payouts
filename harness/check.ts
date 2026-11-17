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
// Legal transitions - independent copy from docs/transitions.md.
// Does NOT import from src/core/stateMachine.ts so a runner table bug cannot
// blind this check (R7). Maintained in sync with the docs manually.
// ---------------------------------------------------------------------------

type TransitionKey = `${PaymentState}->${PaymentState}`;

const LEGAL_TRANSITIONS: ReadonlySet<TransitionKey> = new Set<TransitionKey>([
  // CREATED -> SENDING (SEND_INTENT_RECORDED)
  "CREATED->SENDING",
  // CREATED -> MANUAL_REVIEW (ASYNC_CONFIRM/ASYNC_FAILURE on unknown payment)
  "CREATED->MANUAL_REVIEW",
  // SENDING outcomes
  "SENDING->CONFIRMED",       // BANK_ACCEPTED
  "SENDING->FAILED",          // BANK_REJECTED_PERMANENT, TRANSIENT_RETRIES_EXHAUSTED
  "SENDING->SENDING",         // BANK_REJECTED_TRANSIENT (stay, retry same key)
  "SENDING->UNKNOWN",         // BANK_TIMEOUT
  "SENDING->MANUAL_REVIEW",   // ASYNC_CONFIRM/ASYNC_FAILURE MR!
  // UNKNOWN outcomes
  "UNKNOWN->CONFIRMED",       // STATUS_CONFIRMED, ASYNC_CONFIRM
  "UNKNOWN->FAILED",          // STATUS_FAILED, ASYNC_FAILURE
  "UNKNOWN->UNKNOWN",         // BANK_TIMEOUT (status timed out), STATUS_NOT_FOUND_IN_WINDOW
  "UNKNOWN->SENDING",         // STATUS_NOT_FOUND outside window (resend)
  "UNKNOWN->MANUAL_REVIEW",   // CHECKS_EXHAUSTED
  // Contradictions routed to a human (MR cells in docs/transitions.md). A bank
  // telling us two incompatible things is not an illegal transition - it is the
  // case the design escalates. These were missing from this hand-copied grid
  // because no scenario ever exercised them until F1 made lost/late
  // notifications routine:
  //   CONFIRMED:STATUS_FAILED, CONFIRMED:STATUS_NOT_FOUND, CONFIRMED:ASYNC_FAILURE
  //   FAILED:STATUS_CONFIRMED, FAILED:ASYNC_CONFIRM
  "CONFIRMED->MANUAL_REVIEW",
  "FAILED->MANUAL_REVIEW",
  // Terminal noop transitions (RECOVERY_ON_RESTART, duplicate events)
  "CONFIRMED->CONFIRMED",
  "FAILED->FAILED",
  "MANUAL_REVIEW->MANUAL_REVIEW",
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
  // Check from BANK records, not just our store (R2: double settlement invisible via Map).
  // -------------------------------------------------------------------------
  {
    // Our side: no two CONFIRMED payments share the same idempotency key.
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

    // Bank side: total settled per account must not exceed the allocation for that account.
    // Build allocated amount per bankDetails from our payment records.
    const allocatedByAccount = new Map<string, number>();
    for (const p of payments) {
      allocatedByAccount.set(p.bankDetails, (allocatedByAccount.get(p.bankDetails) ?? 0) + p.amountCents);
    }

    if (bank.getSettlementsByAccount) {
      const byAccount = bank.getSettlementsByAccount();
      for (const [account, settlement] of byAccount) {
        const allocated = allocatedByAccount.get(account) ?? 0;
        if (settlement.totalCents > allocated) {
          violations.push({
            invariant: "I1",
            detail: `account ${account} received ${settlement.totalCents}¢ from bank (${settlement.sendCount} sends) > allocated ${allocated}¢`,
          });
        }
      }
    } else {
      // Fallback: check our store side only (weaker - blind to double settlement).
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
            detail: `investor ${investorId} confirmed ${confirmed}¢ > allocated ${allocated}¢ (store-side check only)`,
          });
        }
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
  // Computed directly from store and bank - does NOT trust reconcile() output,
  // so a bug in reconcile cannot blind this check (R7).
  // -------------------------------------------------------------------------
  {
    // Build maps from our store.
    const ourConfirmedByKey = new Map<string, string>(); // key -> paymentId
    const ourStateByKey = new Map<string, string>();     // key -> state
    for (const p of payments) {
      ourStateByKey.set(p.idempotencyKey, p.state);
      if (p.state === "CONFIRMED") ourConfirmedByKey.set(p.idempotencyKey, p.id);
    }

    // Check every key the bank settled.
    for (const [key, bankAmount] of bankSettled) {
      const ourState = ourStateByKey.get(key);
      if (ourState === undefined) {
        violations.push({
          invariant: "I4",
          detail: `bank settled key ${key} (${bankAmount}¢) but we have no payment record`,
        });
      } else if (ourState === "CONFIRMED") {
        // Both sides agree - check amount.
        const p = payments.find(x => x.idempotencyKey === key);
        if (p && p.amountCents !== bankAmount) {
          violations.push({
            invariant: "I4",
            paymentId: p.id,
            detail: `amount mismatch for key ${key}: ours ${p.amountCents}¢ vs bank ${bankAmount}¢`,
          });
        }
      } else if (ourState === "MANUAL_REVIEW") {
        // Expected - MANUAL_REVIEW payments may have bank settlements.
        // Verify they appear in the reconciliation report.
        const inReport = report.mismatches.some(m => m.key === key);
        if (!inReport) {
          const p = payments.find(x => x.idempotencyKey === key);
          violations.push({
            invariant: "I4",
            ...(p ? { paymentId: p.id } : {}),
            detail: `MANUAL_REVIEW payment key ${key} settled by bank but missing from reconciliation report`,
          });
        }
      } else {
        // Bank settled a key we show as FAILED, SENDING, UNKNOWN, or CREATED.
        const p = payments.find(x => x.idempotencyKey === key);
        violations.push({
          invariant: "I4",
          ...(p ? { paymentId: p.id } : {}),
          detail: `bank settled key ${key} but our payment state is ${ourState} - contradiction`,
        });
      }
    }

    // Check every key we show as CONFIRMED - must appear in bank settled.
    for (const [key, paymentId] of ourConfirmedByKey) {
      if (!bankSettled.has(key)) {
        violations.push({
          invariant: "I4",
          paymentId,
          detail: `we show CONFIRMED for key ${key} but bank has no settled record`,
        });
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

      // Continuity: each entry's toState must equal the next entry's fromState.
      for (let i = 0; i < entries.length - 1; i++) {
        const curr = entries[i]!;
        const next = entries[i + 1]!;
        if (curr.toState !== next.fromState) {
          violations.push({
            invariant: "I5",
            paymentId: p.id,
            detail: `audit discontinuity at entry ${i}: toState ${curr.toState} !== next fromState ${next.fromState} (events: ${curr.event} -> ${next.event})`,
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
