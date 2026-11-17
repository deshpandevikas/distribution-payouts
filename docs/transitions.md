# Payment State Transition Grid

Legend: `->X` move to X | `noop` no-op + audit log | `MR!` MANUAL_REVIEW + alert |
`hold` stay in MANUAL_REVIEW, attach event as evidence for the operator |
`ILLEGAL` runner bug: reject and throw (only for runner-generated events; bank events never throw).

Defaults (config): transient retries 3, backoff 1s doubling + jitter; status checks max 5
(cumulative per payment, so every payment terminates); settle window 2 min; per-payment max $10,000,000.00.

All 14 event types have a cell in all 6 states (84 cells). `ILLEGAL` means the runner emitted
an event that cannot apply in that state; a bank event never takes that path — a bank saying
something unexpected escalates instead. `harness/check.ts` keeps its own copy of the legal
pairs on purpose, so a bug in the transition table cannot blind the checker; the two must
change together.

| Event \ State            | CREATED   | SENDING                                   | UNKNOWN                                        | CONFIRMED | FAILED  | MANUAL_REVIEW |
|--------------------------|-----------|-------------------------------------------|------------------------------------------------|-----------|---------|---------------|
| SEND_INTENT_RECORDED     | ->SENDING | ILLEGAL                                   | ILLEGAL                                        | ILLEGAL   | ILLEGAL | ILLEGAL       |
| BANK_ACCEPTED (sync)     | ILLEGAL   | ->CONFIRMED                               | ILLEGAL (late replies arrive as ASYNC_CONFIRM) | ILLEGAL   | ILLEGAL | ILLEGAL       |
| BANK_REJECTED_PERMANENT  | ILLEGAL   | ->FAILED                                  | ILLEGAL                                        | ILLEGAL   | ILLEGAL | ILLEGAL       |
| BANK_REJECTED_TRANSIENT  | ILLEGAL   | stay SENDING, retry same key              | ILLEGAL                                        | ILLEGAL   | ILLEGAL | ILLEGAL       |
| TRANSIENT_RETRIES_EXHAUSTED | ILLEGAL | ->FAILED (3rd transient reject)           | ILLEGAL                                        | ILLEGAL   | ILLEGAL | ILLEGAL       |
| BANK_TIMEOUT             | ILLEGAL   | ->UNKNOWN                                 | stay UNKNOWN, count as a check (status call timed out) | ILLEGAL | ILLEGAL | ILLEGAL |
| STATUS_CONFIRMED         | ILLEGAL   | ->CONFIRMED (recovery path)               | ->CONFIRMED                                    | noop      | MR!     | hold          |
| STATUS_FAILED            | ILLEGAL   | ->FAILED (recovery path)                  | ->FAILED                                       | MR!       | noop    | hold          |
| STATUS_NOT_FOUND         | ILLEGAL   | inside settle window: ->UNKNOWN; after: resend same key | inside settle window: ->UNKNOWN; after: ->SENDING, resend same key | MR! | noop | hold |
| STATUS_NOT_FOUND_IN_WINDOW | ILLEGAL | ILLEGAL                                   | stay UNKNOWN, then sleep out the rest of the window | ILLEGAL | ILLEGAL | ILLEGAL |
| ASYNC_CONFIRM            | MR!       | ->CONFIRMED                               | ->CONFIRMED                                    | noop      | MR!     | hold          |
| ASYNC_FAILURE            | MR!       | ->FAILED                                  | ->FAILED                                       | MR!       | noop    | hold          |
| CHECKS_EXHAUSTED         | ILLEGAL   | ILLEGAL                                   | ->MANUAL_REVIEW                                | ILLEGAL   | ILLEGAL | ILLEGAL       |
| RECOVERY_ON_RESTART      | resume: record intent, then send | status check, NEVER blind resend | continue status checks (count preserved) | noop | noop | noop |

## Why the contested cells

- **UNKNOWN + late confirm -> CONFIRMED**: the bank's record is the truth about money moving; UNKNOWN only meant "not known yet".
- **MANUAL_REVIEW + any bank event -> hold**: once a human owns it, the system never moves it, so the two never race.
- **CONFIRMED + failure/not-found -> MR!**: a contradiction about money is never resolved silently. (A real return after settlement is a separate RETURN event in Phase 1.5.)
- **CREATED + any bank event -> MR!**: the bank reports a payment we never sent. Investigate, do not absorb.
- **Transient reject exhausted -> FAILED (not UNKNOWN)**: a transient reject means the bank did not process it. The runner emits `TRANSIENT_RETRIES_EXHAUSTED` for this, so the audit row names the real reason instead of looking like one more retry.
- **FAILED is terminal in Phase 1**. Re-paying a failed investor is a new instruction (new key) and a human decision.
- **NOT_FOUND is answered by the runner, not the table**: inside the window it becomes `STATUS_NOT_FOUND_IN_WINDOW` (a move to the same state, which keeps the wait auditable and sleeps out the remaining window); outside the window it becomes `STATUS_NOT_FOUND`, which is what sends the payment back to SENDING with the same key.

## The `SENDING -> MANUAL_REVIEW` edge

The checker treats `SENDING -> MANUAL_REVIEW` as a legal pair. No cell in this table produces
it, and none should today.

The pair exists for one situation: a bank reply that **conflicts** with what we sent — a
confirmation for a different amount, or for a different account. That reply is neither an
accept nor a rejection, and absorbing it as either is how a system pays the wrong amount
without noticing. The right outcome is MANUAL_REVIEW with the reply attached as evidence.

It is unreachable because nothing compares the bank's echo of amount or account against the
send: a confirming reply is taken at its word. Adding that comparison means adding a cell to
the table, which is a human decision, not a refactor.

Until then the edge is legal-but-unreachable, and SENDING has exactly the outcomes listed
above. Verified 2026-11-17 by driving all 14 event types into SENDING: none reached
MANUAL_REVIEW.
