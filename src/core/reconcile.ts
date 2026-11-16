/**
 * Reconciliation report (agreed-decisions.md #12).
 *
 * Runs after a distribution completes. Compares our store's view of the world
 * against the bank's settled records and reports discrepancies.
 *
 * Four mismatch types:
 *   OURS_ONLY        -  we show CONFIRMED but the bank has no record of the key
 *   BANK_ONLY        -  bank settled a key we have no CONFIRMED record for
 *   AMOUNT_MISMATCH  -  both sides confirm the key but amounts differ
 *   STATE_MISMATCH   -  bank shows settled but our payment is not CONFIRMED
 *                     (e.g. still UNKNOWN, FAILED, or MANUAL_REVIEW)
 *
 * Never auto-fixes. The report is the output; a human or downstream process
 * decides what to do with it.
 *
 * The checker in harness/check.ts uses this report to verify I4.
 */

import type {
  Store,
  Bank,
  DistributionId,
  IdempotencyKey,
  PaymentId,
  Cents,
} from "./types.js";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type MismatchType =
  | "OURS_ONLY"
  | "BANK_ONLY"
  | "AMOUNT_MISMATCH"
  | "STATE_MISMATCH";

export interface Mismatch {
  type: MismatchType;
  key: IdempotencyKey;
  paymentId: PaymentId | null;
  /** Our recorded amount, if we have a payment for this key. */
  ourAmountCents: Cents | null;
  /** Bank's settled amount, if the bank has a record for this key. */
  bankAmountCents: Cents | null;
  /** Our payment's state, if we have a payment for this key. */
  ourState: string | null;
  detail: string;
}

export interface ReconciliationReport {
  distributionId: DistributionId;
  ranAt: number;
  /** Total payments we show as CONFIRMED. */
  ourConfirmedCount: number;
  ourConfirmedCents: Cents;
  /** Total keys the bank has settled. */
  bankSettledCount: number;
  bankSettledCents: Cents;
  mismatches: Mismatch[];
  /** True if there are zero mismatches. */
  clean: boolean;
}

// ---------------------------------------------------------------------------
// reconcile()
// ---------------------------------------------------------------------------

export function reconcile(
  distributionId: DistributionId,
  store: Store,
  bank: Bank,
  nowMs: number,
): ReconciliationReport {
  const payments = store.listPayments(distributionId);
  const bankSettled = bank.getSettledKeys();

  // Build a map of idempotency key -> payment for our CONFIRMED payments.
  const ourConfirmed = new Map<IdempotencyKey, { paymentId: PaymentId; amountCents: Cents }>();
  // Also track non-CONFIRMED payments by key so we can detect STATE_MISMATCH.
  const ourNonConfirmed = new Map<IdempotencyKey, { paymentId: PaymentId; amountCents: Cents; state: string }>();

  for (const p of payments) {
    if (p.state === "CONFIRMED") {
      ourConfirmed.set(p.idempotencyKey, { paymentId: p.id, amountCents: p.amountCents });
    } else {
      ourNonConfirmed.set(p.idempotencyKey, { paymentId: p.id, amountCents: p.amountCents, state: p.state });
    }
  }

  const mismatches: Mismatch[] = [];

  // --- OURS_ONLY and AMOUNT_MISMATCH ---
  for (const [key, ours] of ourConfirmed) {
    const bankAmount = bankSettled.get(key);
    if (bankAmount === undefined) {
      mismatches.push({
        type: "OURS_ONLY",
        key,
        paymentId: ours.paymentId,
        ourAmountCents: ours.amountCents,
        bankAmountCents: null,
        ourState: "CONFIRMED",
        detail: `we show CONFIRMED for key ${key} but bank has no settled record`,
      });
    } else if (bankAmount !== ours.amountCents) {
      mismatches.push({
        type: "AMOUNT_MISMATCH",
        key,
        paymentId: ours.paymentId,
        ourAmountCents: ours.amountCents,
        bankAmountCents: bankAmount,
        ourState: "CONFIRMED",
        detail: `amount mismatch for key ${key}: ours ${ours.amountCents}¢, bank ${bankAmount}¢`,
      });
    }
  }

  // --- BANK_ONLY and STATE_MISMATCH ---
  for (const [key, bankAmount] of bankSettled) {
    if (ourConfirmed.has(key)) {
      // Already handled above.
      continue;
    }

    const nonConfirmed = ourNonConfirmed.get(key);
    if (nonConfirmed) {
      mismatches.push({
        type: "STATE_MISMATCH",
        key,
        paymentId: nonConfirmed.paymentId,
        ourAmountCents: nonConfirmed.amountCents,
        bankAmountCents: bankAmount,
        ourState: nonConfirmed.state,
        detail: `bank settled key ${key} but our payment is in state ${nonConfirmed.state}`,
      });
    } else {
      mismatches.push({
        type: "BANK_ONLY",
        key,
        paymentId: null,
        ourAmountCents: null,
        bankAmountCents: bankAmount,
        ourState: null,
        detail: `bank settled key ${key} but we have no payment record for it`,
      });
    }
  }

  const ourConfirmedCents = [...ourConfirmed.values()].reduce((s, p) => s + p.amountCents, 0);
  const bankSettledCents = [...bankSettled.values()].reduce((s, v) => s + v, 0);

  return {
    distributionId,
    ranAt: nowMs,
    ourConfirmedCount: ourConfirmed.size,
    ourConfirmedCents,
    bankSettledCount: bankSettled.size,
    bankSettledCents,
    mismatches,
    clean: mismatches.length === 0,
  };
}
