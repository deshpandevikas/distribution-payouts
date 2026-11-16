# DECISIONS.md

For each decision: the why, options considered, what would change your mind,
cost of being wrong, one-way or two-way door.

---

## 1. States: CREATED, SENDING, CONFIRMED, FAILED, UNKNOWN, MANUAL_REVIEW

## 2. Intent persisted before bank call; restart in SENDING = status check, never blind resend

## 3. Idempotency key = hash(distributionId, investorId, instructionNo)

## 4. Fake bank dedupes on key; status query switchable

## 5. Status NOT_FOUND: wait settle window, then resend with the SAME key

## 6. Duplicate confirm on CONFIRMED = no-op + log; confirm on FAILED = MANUAL_REVIEW + alert

## 7. Partial failure: no rollback; run ends COMPLETED_WITH_EXCEPTIONS

## 8. Allocation: pro rata, floor to cents, largest remainder, ties by investorId ascending

## 9. Error classes: permanent -> FAILED; transient -> retry + backoff + jitter; timeout -> UNKNOWN

## 10. Audit log is append-only

## 11. Reconciliation never auto-fixes; reports 4 mismatch types

## 12. Zero-cent shares: no payment, but logged

## 13. Clock and RNG are injected; any seed replays exactly

## 14. MANUAL_REVIEW is the boundary: once a human owns a payment, the system never moves it
