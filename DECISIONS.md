# Decisions

Each entry: what was decided, why, what else was considered, what would change my mind,
and how costly it is to reverse.

## 1. A timeout means UNKNOWN, never FAILED

**Why:** a timeout tells us nothing about the money. The bank may have paid. Marking it
FAILED invites someone to pay again, which is the one mistake this system must never make.
**Considered:** treat a timeout as failed and retry (simple, and it pays twice).
**Would change my mind:** a bank that guarantees a timed-out request was never processed.
None I know of does.
**Reversal cost:** high. Every state after this one depends on it.

## 2. Record the intent before calling the bank

**Why:** if the process dies right after the bank call, the SENDING record is the only
trace that money may be moving. Without it, a restart would treat the payment as never sent.
**Considered:** write after the bank answers (fewer writes, but a crash loses the evidence).
**Would change my mind:** nothing. This is the cheapest insurance in the system.
**Reversal cost:** low to change, high if it is ever missing in production.

## 3. Never resend blind: ask the bank first, and resend with the same key

**Why:** after a timeout or a restart, the only safe question is "did you get this key?".
The same idempotency key on a resend means even a mistaken resend cannot pay twice at a
bank that deduplicates.
**Considered:** resend immediately with the same key and trust the bank's dedupe. Rejected
because not every bank deduplicates reliably, and the status check costs one call.
**Would change my mind:** a bank with no status query. Then the same-key resend is the only
tool, and the risk is documented.
**Reversal cost:** low.

## 4. "Not found" inside a 2-minute window is lag, not absence

**Why:** banks often answer "not found" for a payment they accepted seconds ago. Inside the
settle window we wait. After it, we resend with the same key. Up to 5 status checks, then a
human.
**Considered:** resend on the first "not found" (pays twice at a lagging bank without dedupe).
Never resend (strands real failures forever).
**Would change my mind:** real lag data from a bank. The 2 minutes and 5 checks are policy,
not physics, and are configurable.
**Reversal cost:** low. They are config values.

## 5. The bank's status answer is the truth; notifications are hints

**Why:** notifications get lost, delayed and duplicated. The status query is what decides.
A notification can move a payment forward early, but it is never required, so a lost one
cannot lose money. If a notification and the status disagree, that is a contradiction, and
decision 6 applies.
**Considered:** notifications as the only source (simpler, and blind when one is lost).
**Would change my mind:** a bank whose status endpoint is less reliable than its notifications.
**Reversal cost:** medium.

## 6. Contradictions go to a human, and the system stops touching that payment

**Why:** a confirm after we marked it FAILED, a failure after CONFIRMED, or an event for a
payment we never sent. Each means our picture of the money is wrong. Any automatic choice
risks paying twice or leaving an investor unpaid. MANUAL_REVIEW is final for automation, so
a human and the system never race on the same payment.
A reply that confirms a different amount or account would also belong here. It is not built
yet, because nothing compares the bank's echo against what we sent.
**Considered:** let the latest event win (silently flips money states), or ignore late events
(hides real payments).
**Would change my mind:** volume. If humans cannot keep up, automate the safest sub-case
first, with an audit trail.
**Reversal cost:** low to loosen later, high if loosened too early.

## 7. "Try later" rejections get 3 attempts in total, then FAILED

**Why:** a transient rejection means the bank did not process it, so FAILED is honest after
the limit, unlike a timeout. Retries use the same key, with exponential backoff and jitter.
3 attempts means the first send plus 2 retries, and the setting is named `maxSendAttempts`
so nobody has to guess.
**Considered:** retry forever (hides a dead bank), or go to UNKNOWN (wrong, the bank said no).
**Would change my mind:** the bank's documented retry guidance.
**Reversal cost:** low.

## 8. The idempotency key is readable: distribution:investor:instruction

**Why:** the key shows up in bank statements, audit rows and operator messages, so it
should say what it pays for. It is deterministic, so a restart rebuilds the same key. A
reissue after a failure gets a new instruction number, so it is a new key on purpose.
**Considered:** a hash (opaque, and it forced a crypto import into the core).
**Would change my mind:** a bank with a short key length limit, or ids that must not leak.
**Reversal cost:** medium, because keys already sent must stay valid.

## 9. Money is integer cents, split by largest remainder

**Why:** floats lose cents. Each investor gets the floor of their share. Leftover cents go to
the largest remainders, and ties go by investor id, so the result is deterministic and sums
exactly to the total. A share that rounds to $0 sends nothing and is recorded as an alert.
**Considered:** floats with rounding (drifts), or giving all leftover cents to one investor
(unfair at scale).
**Would change my mind:** multi-currency support, which needs per-currency minor units.
**Reversal cost:** high once payments exist.

## 10. A partial failure does not roll back the run

**Why:** money that already moved cannot be un-sent. The run ends COMPLETED_WITH_EXCEPTIONS
with a list, and reconciliation reports mismatches but never auto-fixes them.
**Considered:** all-or-nothing (impossible with real banks).
**Reversal cost:** low.

## 11. Tests must prove they can fail

**Why:** the first harness passed while hiding three bugs, because the fake bank
was too kind. So each invariant has a planted bug that must make it fail. The harness exits
1 for a caught violation and 2 for a crash, and CI accepts only 1, because a crash is not a
catch. The checker keeps its own copy of the state table, so a bug in the runner cannot
grade itself.
**Considered:** coverage numbers alone (they show code ran, not that it was checked).
**Reversal cost:** none. This only adds confidence.

## 12. Small, swappable infrastructure

- **SQLite, not Postgres:** it proves the two things that matter, an atomic state change
  plus audit row and survival of a hard kill, with zero setup for a reader. The store is an
  interface, so Postgres is a new adapter, not a rewrite.
- **Temporal as a second runner, not a rewrite:** it reuses the same state table and
  shows that durable workflows do not remove the need for idempotency, because Temporal may
  run an activity twice.
- **Read-only MCP:** an operator or an AI assistant can ask "why is this payment in review?",
  and nothing can write through it.
- **A static replay page, not a hosted backend:** the core runs in the browser, so anyone
  can try it with nothing to maintain.

## Trade-offs I accepted

- MANUAL_REVIEW has no admin tool. Resolution is deliberate and out of band: safer, but
  slower for operators.
- Full sync writes in SQLite cost throughput for crash safety. Right for thousands of
  payments. Millions would need batching.
- Two runners (direct and Temporal) must stay in step. The shared state table and the
  shared checker are what keep them honest.
- USD only.

## If I kept going

1. Returns: a RETURNED state, a paired ledger reversal, and a reissue that needs new bank
   details, a second approval and a new key.
2. Maker-checker approval above a threshold, and identity holds before any money moves.
3. Compare the bank's echo of amount and account, and route mismatches to a human.
4. Postgres adapter and a real bank sandbox, run against the same checker.
