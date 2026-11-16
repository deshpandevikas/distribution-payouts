# OPEN_QUESTIONS.md

Things that are unsure, unresolved, or need a decision before implementation.
Add here instead of guessing. Close entries with a resolution and date.

---

<!-- Example format:
## OQ-1: <short title>
**Raised:** YYYY-MM-DD
**Context:** What triggered the question.
**Question:** The specific thing that is unclear.
**Resolution:** (fill in when closed)
-->

## OQ-1: overwriteOnDuplicateConfirm was an equivalent mutant — resolved
**Raised:** phase-1 implementation
**Resolution:** Resolved — flag redesigned and renamed.

**What happened:** The original `overwriteOnDuplicateConfirm` flag wrote `state: "CONFIRMED"` to a
payment already in `CONFIRMED`. This is an *equivalent mutant*: the mutation is syntactically
different from the correct code but produces identical observable output. The store Map overwrites
with the same value; I5's `lastEntry.toState !== p.state` check sees `CONFIRMED === CONFIRMED`; I1's
overpayment check sees no change in amount. No invariant fires.

**Root cause:** Break-it flags must target state machine cells whose outcome is *observable* —
either a state change that the checker tracks, or an audit entry that the checker reads. A cell
that is a noop (CONFIRMED + ASYNC_CONFIRM = noop) cannot be broken by overwriting it.

**Fix:** Renamed to `overwriteConflictingConfirm`. Targets `FAILED:ASYNC_CONFIRM` and
`MANUAL_REVIEW:ASYNC_CONFIRM` — both MR!/hold cells where the state machine would fire an alert
and write an audit entry. The flag bypasses `applyEvent` entirely and writes `CONFIRMED` directly
to the store with no audit entry. I5 catches it: `lastEntry.toState` (FAILED or MANUAL_REVIEW)
!== `p.state` (CONFIRMED).

Added `lyingTransientRate` to FakeBank to produce the FAILED->ASYNC_CONFIRM scenario naturally:
bank returns REJECTED_TRANSIENT but actually settles, queues ASYNC_CONFIRM, which arrives after
retries exhaust and payment reaches FAILED.

Added grid coverage metric to harness: any break-it flag whose required (state, event) cell was
never exercised is reported as a coverage gap — a flag that never exercises its target cell is not
a test, it's dead code.
