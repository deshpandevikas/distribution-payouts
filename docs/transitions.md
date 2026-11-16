# Payment State Transition Grid

Legend: `->X` move to X | `noop` no-op + audit log | `MR!` MANUAL_REVIEW + alert |
`hold` stay in MANUAL_REVIEW, attach event as evidence for the operator |
`ILLEGAL` runner bug: reject and throw (only for runner-generated events; bank events never throw).

Defaults (config): transient retries 3, backoff 1s doubling + jitter; status checks max 5
(cumulative per payment, so every payment terminates); settle window 2 min; per-payment max $10,000,000.00.

| Event \ State            | CREATED   | SENDING                                   | UNKNOWN                                        | CONFIRMED | FAILED  | MANUAL_REVIEW |
|--------------------------|-----------|-------------------------------------------|------------------------------------------------|-----------|---------|---------------|
| SEND_INTENT_RECORDED     | ->SENDING | ILLEGAL                                   | ILLEGAL                                        | ILLEGAL   | ILLEGAL | ILLEGAL       |
| BANK_ACCEPTED (sync)     | ILLEGAL   | ->CONFIRMED                               | ILLEGAL (late replies arrive as ASYNC_CONFIRM) | ILLEGAL   | ILLEGAL | ILLEGAL       |
| BANK_REJECTED_PERMANENT  | ILLEGAL   | ->FAILED                                  | ILLEGAL                                        | ILLEGAL   | ILLEGAL | ILLEGAL       |
| BANK_REJECTED_TRANSIENT  | ILLEGAL   | stay SENDING, retry same key; after 3 ->FAILED | ILLEGAL                                   | ILLEGAL   | ILLEGAL | ILLEGAL       |
| BANK_TIMEOUT             | ILLEGAL   | ->UNKNOWN                                 | stay UNKNOWN, count as a check (status call timed out) | ILLEGAL | ILLEGAL | ILLEGAL   |
| STATUS_CONFIRMED         | ILLEGAL   | ->CONFIRMED (recovery path)               | ->CONFIRMED                                    | noop      | MR!     | hold          |
| STATUS_FAILED            | ILLEGAL   | ->FAILED (recovery path)                  | ->FAILED                                       | MR!       | noop    | hold          |
| STATUS_NOT_FOUND         | ILLEGAL   | inside settle window: ->UNKNOWN; after: resend same key | inside settle window: stay UNKNOWN; after: ->SENDING, resend same key | MR! | noop | hold |
| ASYNC_CONFIRM            | MR!       | ->CONFIRMED                               | ->CONFIRMED                                    | noop      | MR!     | hold          |
| ASYNC_FAILURE            | MR!       | ->FAILED                                  | ->FAILED                                       | MR!       | noop    | hold          |
| CHECKS_EXHAUSTED         | ILLEGAL   | ILLEGAL                                   | ->MANUAL_REVIEW                                | ILLEGAL   | ILLEGAL | ILLEGAL       |
| RECOVERY_ON_RESTART      | resume: record intent, then send | status check, NEVER blind resend | continue status checks (count preserved) | noop | noop | noop |

## Why the contested cells

- **UNKNOWN + late confirm -> CONFIRMED**: the bank's record is the truth about money moving; UNKNOWN only meant "not known yet".
- **MANUAL_REVIEW + any bank event -> hold**: once a human owns it, the system never moves it, so the two never race.
- **CONFIRMED + failure/not-found -> MR!**: a contradiction about money is never resolved silently. (A real return after settlement is a separate RETURN event in Phase 1.5.)
- **CREATED + any bank event -> MR!**: the bank reports a payment we never sent. Investigate, do not absorb.
- **Transient reject exhausted -> FAILED (not UNKNOWN)**: a transient reject means the bank did not process it.
- **FAILED is terminal in Phase 1**. Re-paying a failed investor is a new instruction (new key) and a human decision.
