Payment behavior
1. States: CREATED, SENDING, CONFIRMED, FAILED, UNKNOWN, MANUAL_REVIEW (RETURNED in Phase 1.5).
2. Intent (SENDING) is persisted before calling the bank. Restart in SENDING = status check, never blind resend.
3. Idempotency key = readable string distributionId:investorId:instructionNo (not a hash). Retries reuse it; reissue increments instructionNo.
4. Fake bank dedupes on key and has a status query; status query can be switched off.
5. Status NOT_FOUND: wait a settle window (configurable), then resend with the SAME key.
6. Duplicate confirm on CONFIRMED = no-op + log. Confirm on FAILED = MANUAL_REVIEW + alert. Never override silently.
7. (Phase 1.5) Return: original -> RETURNED, ledger reversed, reissue needs new bank details + approval, new key, reissue_of link.
8. Partial failure: no rollback; run ends COMPLETED_WITH_EXCEPTIONS with an exceptions list.
9. Allocation: pro rata by a supplied basis (ownership units), floor to cents, leftover cents by largest remainder, ties by investorId ascending. Sum equals total exactly.
10. Error classes: permanent -> FAILED; transient -> retry with backoff + jitter, same key, max N; timeout -> UNKNOWN.
11. Audit log is append-only: who, what, when, from-state, to-state, reason.
12. Reconciliation runs at end of run; reports 4 mismatch types (ours-only, bank-only, amount, state); never auto-fixes.
13. Zero-cent shares produce no payment, but are logged. USD only. Per-payment max as a sanity check.
14. Clock and RNG are injected everywhere; any seed replays exactly.
15. Manual intervention = any payment that touches MANUAL_REVIEW.

Written up only (no code in Phase 1)
- Maker-checker approval (two-person above a threshold), identity hold for unverified investors,
  bank-details snapshot at approval, cancellation of unsent payments, investor notification.

Architecture
- Pure TS core; store and bank are injected interfaces.
- Later: Temporal (orchestration), SQLite (persistence), static UI on GitHub Pages, read-only MCP, CI on GitHub Actions.
