# QUIZ.md

Hard "why" questions from code changes. Do not answer here — think them through before the next review.

---

## types.ts (created)

1. `Store` is defined in `types.ts` as a port interface, but `types.ts` also owns `Payment`, `AuditEntry`, and all domain types — why is it acceptable to colocate the storage port with the domain model here, and at what point does that coupling become a problem worth splitting?

2. `PaymentState` is a plain string union and `TERMINAL_STATES` is a `ReadonlySet` checked at runtime — why not encode terminality into the type system itself (e.g. a discriminated union of `TerminalPayment | ActivePayment`), and what specifically would you lose or gain by doing so?

## stateMachine.ts (created)

1. `SENDING:BANK_REJECTED_TRANSIENT` stays in `SENDING` — but the state machine itself does not enforce the retry cap; the runner decides whether to send this event or instead let retries exhaust and then... what? If the runner is responsible for deciding when retries are exhausted, why does `BANK_REJECTED_TRANSIENT` not have a companion `RETRIES_EXHAUSTED` event distinct from `CHECKS_EXHAUSTED`, and what invariant break could happen if the runner gets that boundary logic wrong?

2. `STATUS_NOT_FOUND` in `UNKNOWN` moves to `SENDING` (resend same key, outside settle window) — but the transition table has no cell that represents "inside settle window, stay UNKNOWN" for the `UNKNOWN` state; instead the comment says the runner resolves the settle window before calling `applyEvent`. Why is the settle-window decision deliberately kept outside the state machine rather than modeled as two distinct events, and what does that choice cost you at the harness verification layer?

## allocation.ts (created)

1. The largest-remainder step sorts by fractional remainder descending and breaks ties by `investorId` ascending — but `investorId` is a string, so the tie-break is lexicographic, not numeric. If investor IDs are generated as numeric strings (`"9"`, `"10"`, `"11"`), lexicographic order gives `"10" < "11" < "9"`, which is not what a reader would expect. Why is a deterministic but non-obvious tie-break acceptable here, and what property does the harness need to verify to catch a regression if ID generation changes?

2. When `sumBasis === 0`, the function returns zero cents for every investor and the sum check still passes — but `totalCents` may be non-zero. Why is a silent zero-allocation the right behavior rather than an error, and what does the caller need to do to ensure this case is logged per agreed-decisions.md #13 rather than silently dropped?

## runner.ts (created)

1. `backoff()` computes a delay and then discards it (`void delay`) because the harness uses a fake clock — but `sendPayment()` calls `backoff()` with `await`, which means in a real deployment with a real clock, the runner would need a real `setTimeout` sleep here. Why is silently dropping the delay acceptable for Phase 1, and what specific change is needed in Phase 5 (SQLite) or Phase 4 (Temporal) to make this production-safe, and what breaks if you forget?

2. The runner stores `bankDetails` as an empty string when calling `bank.send()` because `Payment` only carries `investorId`, not the full `Investor` record. The allocation step has the `Investor` (with `bankDetails`), but the runner recreates a stub investor at send time. Why was `bankDetails` not included on the `Payment` record itself, and what real-world failure mode does that design choice create if bank details need to change between a crash and a restart?

## reconcile.ts (created)

1. `STATE_MISMATCH` covers the case where the bank settled a key but our payment is not CONFIRMED — but payments in `MANUAL_REVIEW` are explicitly expected to appear in the reconciliation report per agreed-decisions.md #12 and I4. Why does the reconciler treat `MANUAL_REVIEW` the same as `FAILED` or `UNKNOWN` in a `STATE_MISMATCH` rather than giving it its own mismatch type, and what does the harness invariant I4 need to verify differently for `MANUAL_REVIEW` payments versus genuinely anomalous `STATE_MISMATCH` entries?

2. `reconcile()` takes `nowMs` as a plain `number` parameter rather than a `Clock` — breaking the pattern used everywhere else in the codebase. Why is that inconsistency acceptable here, or is it a mistake, and what does it mean for the harness when it needs to replay a run at a fixed timestamp and verify the report's `ranAt` field deterministically?

## runner.ts (fix: processPayment loop)

1. The fix replaces three sequential `if` blocks with a `while (!TERMINAL_STATES.has(...))` loop — but the loop has three `if` branches inside it that each check state independently. If `sendPayment` returns `MANUAL_REVIEW` (a terminal state), the loop exits correctly; but what happens if a future state is added that is neither `CREATED`, `SENDING`, nor `UNKNOWN` and also not in `TERMINAL_STATES`? The loop would spin forever. Why is there no explicit guard against an unrecognised non-terminal state, and what is the cheapest way to add one without breaking the existing logic?

2. The original bug was that `UNKNOWN -> SENDING` (via `STATUS_NOT_FOUND` outside the settle window) left the payment stranded because `processPayment` only entered `sendPayment` once. This was a logic gap, not a state machine error — the state machine did exactly what the transition table said. Why does this reveal a deeper design tension between the state machine's job (record what happened) and the runner's job (decide what to do next), and what invariant or contract should exist at the boundary between them to prevent this class of bug from recurring?

## runner.ts (fix: iteration cap + unhandled state guard)

1. The iteration cap of 1000 is an arbitrary number chosen to be "large enough." For a payment with `maxTransientRetries=3` and `maxStatusChecks=5`, the theoretical maximum legitimate iterations is bounded and much smaller. Why is a hardcoded 1000 worse than deriving the cap from config values, and what does a cap that's too high actually protect against versus one that's correctly derived?

2. The unhandled-state `else` branch throws a plain `Error`, not an `IllegalTransitionError`. Both represent runner bugs — a state the runner reached that it doesn't know how to handle. Why are they different enough to warrant different error types, or should they be unified, and what does the distinction (or lack of it) mean for the harness when it needs to distinguish "runner bug" from "bank misbehaviour" in its violation report?

## runner.ts (fix: skipIntentRecord advances state without audit entry)

1. When `skipIntentRecord` is true, the runner mutates state to `SENDING` and saves the payment directly, bypassing `applyAndSave` and the audit log entirely. I5 is supposed to catch this — but I5 checks that every *audited* transition is legal, not that every *state change* has an audit entry. Does I5 as written actually catch `skipIntentRecord`, or does it only catch illegal audited transitions? What would need to change in the invariant to reliably detect a missing audit entry for a state transition that did happen?

2. The `skipIntentRecord` path writes `state: "SENDING"` to the store without going through the state machine at all — it's a direct store write, not an `applyEvent` call. This means the state machine's `ILLEGAL` guards for `CREATED` are completely bypassed. For the purposes of the break-it harness this is intentional, but why does this make `skipIntentRecord` a fundamentally different kind of break-it flag than the others (which all go through `applyEvent` and the state machine), and what does that mean for what invariant it can and cannot reliably break?

## runner.ts (fix: overwriteOnDuplicateConfirm intercepts before state machine)

1. `overwriteOnDuplicateConfirm` only fires when `payment.state === "CONFIRMED"` and `response.type === "ACCEPTED"` — but the bank's idempotency means a replayed send for an already-confirmed payment will always return `ACCEPTED` (replay). In a real system without a fake bank, what conditions would cause a second `ACCEPTED` response for an already-confirmed payment, and is the break-it flag actually simulating a realistic failure mode or an artificial one?

2. The flag writes directly to the store and returns without an audit entry, which is how I5 catches it — but I1 (no investor paid more than allocated) also claims to catch this flag. With `overwriteOnDuplicateConfirm`, the payment amount doesn't change and the investor is still only confirmed once in the store (the overwrite is idempotent on a Map). So does I1 actually fire, or does only I5 fire, and if only I5 fires, is the flag's description in the handoff ("makes I1/I5 fail") accurate?

## types.ts (overwriteConflictingConfirm rename)

1. The original flag was named `overwriteOnDuplicateConfirm` — a "duplicate confirm" implies the same payment confirmed twice, which is a no-op in the state machine (CONFIRMED + ASYNC_CONFIRM = noop). The new flag targets a *conflicting* confirm: bank says confirmed, we say failed. Why is the distinction between duplicate and conflicting important for what invariant you can break, and what does it tell you about how break-it flags should be designed — should they target state machine cells that are noops, or cells that are MR!/ILLEGAL?

2. The flag description says it makes I4 fail ("confirmed != bank settled") — but I4 checks our CONFIRMED set against the bank's settled set. If the flag writes CONFIRMED directly to the store for a payment the bank settled, our set and the bank's set would actually *agree* on that key. Under what exact sequence of events does I4 actually fire, and is the description in the comment correct?

## types.ts (drainAsyncEvents added to Bank interface as optional)

1. `drainAsyncEvents` is optional on the `Bank` interface — banks that don't support it just omit it. But the runner will silently skip async event delivery for those banks. If a future bank implementation forgets to implement it (not an intentional omission), there is no compile-time or runtime signal. Why is optional the right choice here rather than making it required with a default no-op implementation, and what does that choice cost you at the type level?

2. The async event shape `{ key: IdempotencyKey; type: "ASYNC_CONFIRM" | "ASYNC_FAILURE" }` is defined inline in the interface rather than as a named type. `AsyncBankEvent` already exists in `fakeBank.ts` for exactly this shape. Why is there now a structural duplicate between the interface definition and `AsyncBankEvent`, and what is the right place for this type to live given that it crosses the boundary between the bank port and the runner?

## runner.ts (deliverAsyncEvents + overwriteConflictingConfirm)

1. `deliverAsyncEvents` is called once after all payments drain — but lying-transient events are queued at send time, which happens during `processPayment`. If a payment hits retries exhausted (FAILED) *before* `deliverAsyncEvents` runs, the ASYNC_CONFIRM arrives after FAILED is already terminal and the flag fires. But what happens if a payment is still in SENDING or UNKNOWN when `deliverAsyncEvents` runs — can the ASYNC_CONFIRM arrive for a non-terminal payment, and does the state machine handle that correctly without the break-it flag?

2. The `overwriteConflictingConfirm` flag targets FAILED or MANUAL_REVIEW specifically — but the lying-transient mechanic requires retries to exhaust first (so the payment reaches FAILED) before the ASYNC_CONFIRM is delivered. With `maxTransientRetries=3` and `lyingTransientRate` applied only on the first send, is it guaranteed that the payment will be in FAILED by the time `deliverAsyncEvents` runs, or are there scenarios where it ends up CONFIRMED via the normal status-check path before retries exhaust, making the flag a no-op again?
