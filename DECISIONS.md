# Decisions

Each entry: what was decided, why, what else was considered, what would change my mind,
and how costly it is to reverse.

## 1. A timeout means UNKNOWN, never FAILED

This is the decision the whole project hangs on. A timeout tells you nothing about the money. The
bank may have paid. If we call it FAILED, sooner or later someone helpfully pays again, and that is
the one mistake this system exists to prevent. The status checks, the settle window and the human
queue are all here because of this rule.

I would only change it for a bank that guarantees a timed-out request was never processed. I have
not met one. Reversing it would be expensive, because every later state assumes it.

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

Notifications arrive late, twice, or never. The harness drops and delays them on purpose, and that
made this an easy call. A notification can move a payment forward early, but nothing waits on one.
The status query decides. If the two disagree, that is decision 6.

I would rethink this only for a bank whose status endpoint is less reliable than its notifications.

## 6. Contradictions go to a human, and the system stops touching that payment

A confirm after we marked it FAILED. A failure after CONFIRMED. An event for a payment we never
sent. Each one means our picture of the money is wrong, and any automatic guess either pays twice
or leaves someone unpaid. So the system stops and a person looks.

MANUAL_REVIEW is final for automation on purpose. I would rather an operator be slow than have the
operator and the code fighting over the same payment.

A reply that confirms a different amount or account belongs here too. That check is not built yet.
If review volume ever outgrows the people doing it, I would automate the safest case first, with an
audit trail, and nothing else.

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

This one came from getting burned. The first harness passed while hiding three real
bugs, because its fake bank was too kind and its clock ignored sleep. Green meant nothing.

Now every invariant has a planted bug that has to turn it red, and CI checks that it does. A crash
does not count as a catch: the harness exits 1 for a caught violation and 2 for a crash, and CI
accepts only 1. The checker keeps its own copy of the state table, so the runner cannot grade its
own homework.

Coverage numbers would not have caught any of this. They show that code ran, not that anything
checked it.

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

## What I would do differently

- Make the fake bank mean on day one. A friendly fake is worse than none, because it hands out green checks.
- Build the page a visitor sees early. I built the replay page as a debugging tool and had to rebuild it once I tried to explain it.
- Review the edges first. The two bugs that got past the tests, a Temporal clock and a writable MCP database, were both where the code touches the outside world.
