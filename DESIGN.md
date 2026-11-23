# Design

The problem: a fund distributes a total amount to its investors. Each investor gets a share
of the total, and each share becomes one bank transfer. Between "we decided to pay" and "the
bank confirms the money moved" the process can stall, time out, crash, or deliver a
notification twice. The design is mostly about that gap.

## The parts

| Part | Code | Role |
|---|---|---|
| Allocation | `src/core/allocation.ts` | Pro rata by supplied basis units, floor to cents, leftover cents by largest remainder, ties by investor id. Sums to the total exactly. |
| State machine | `src/core/stateMachine.ts` | One table: `(state, event) -> outcome`. Pure; no scheduling, no I/O. |
| Runner | `src/core/runner.ts` | Drives each payment from CREATED to terminal: record intent, send, interpret the response, poll status, drain async events. |
| Reconciliation | `src/core/reconcile.ts` | End of run comparison of our store against the bank: `OURS_ONLY`, `BANK_ONLY`, `AMOUNT_MISMATCH`, `STATE_MISMATCH`. Reports; never fixes. |
| Store port | `src/core/types.ts`, `src/store/` | `MemoryStore` for speed, `SqliteStore` for durability. |
| Bank port | `src/core/types.ts`, `src/bank/` | `FakeBank` for scenarios; `FileBank` (a ledger on disk, so it survives a killed process) for crash tests. |
| Harness | `harness/` | Scenario generator, invariant checker, break-it flags, CLI. |
| Temporal adapter | `src/temporal/` | Durable version of the same runner: one workflow per distribution, all I/O in activities. |
| MCP server | `src/mcp/` | Four read-only tools over the store. |
| Replay page | `site/` | The same core and checker, compiled into a static page. |

`src/core` imports nothing from Node. That is not an accident of style: the same code has to
run under Vitest, inside a Temporal workflow sandbox, and in a browser. A guard test
(`test/core-no-node-imports.test.ts`) fails the build if a `node:` import appears.

## The six states

CREATED, SENDING, CONFIRMED, FAILED, UNKNOWN, MANUAL_REVIEW. Everything after
SENDING is about not guessing: a timeout becomes UNKNOWN, an exhausted check
budget becomes MANUAL_REVIEW, and a bank event that contradicts what we recorded
escalates instead of overwriting.

The full 6 by 14 grid, including the cells that exist only to escalate, is in
[docs/transitions.md](docs/transitions.md). Four outcomes per cell: move, no-op, `MR!` (escalate
and alert), `hold` (stay, attach the event as evidence). `ILLEGAL` throws only for events the
runner generated; a bank event never throws, because a bank saying something unexpected is a
situation to investigate.

## The one hard question: did the money move?

A bank call can fail in three genuinely different ways, and conflating them is how payout
systems double-pay people:

- **The bank said no.** The payment did not happen. FAILED is correct.
- **The bank said yes.** Record CONFIRMED with the key.
- **The bank said nothing** (timeout, dropped connection, our process died). We do not know.
  The money may have moved.

So the runner never guesses, and six rules follow from that. It records intent before
the call, so a crash at that instant leaves a payment that says "we may have sent
this". A timeout becomes UNKNOWN, never FAILED, because FAILED invites a resend. It
asks the bank for the key's status before any resend. Inside the settle window
a `NOT_FOUND` waits, sleeping out the remainder of the window rather than burning
the check budget in a tight loop; after the window it resends the same key, and a
deduplicating bank returns the original acceptance instead of paying twice. Status
checks are capped at 5 per payment, then `CHECKS_EXHAUSTED` hands it to a person,
because unknown money is a person's problem, not a loop's. On restart, a payment
found in SENDING or UNKNOWN gets a status check, never a blind resend. Each rule,
and what it costs, is in [DECISIONS.md](DECISIONS.md).

## Idempotency

The key is readable and deterministic:

`dist-2026-q3:inv-042:1` for a first attempt, `:2` for a reissue.

A key appears in a bank statement, an audit row and an operator's message, so it should say
what it pays for. Recomputing it after a restart produces the same string, which is what
makes a resend a no-op at the bank. It is not a hash, so `src/core` needs no `node:crypto`
and can run in the browser.

`instructionNo` separates "retry" from "reissue": retries keep it, reissues increment it. A
break-it flag appends `:retry-N` so that a bug key can never be mistaken for a real one.

## Ports and adapters

The core sees two injected ports plus `Clock` and `Rng`, so nothing reads the wall clock or
a random source directly and any seed replays exactly.

### Store

`transition(payment, auditEntry)` is the only way state changes. It writes the payment and
its audit entry together, so "every state change has an audit row" is a property of the API
rather than of careful call sites. Around it: payment reads, an append-only audit log, and an
alerts list.

Alerts are not payment audit rows. A bank event for a key we never sent has no payment to
attach to, so alerts are keyed to the distribution instead.

### SQLite adapter

`SqliteStore` (`better-sqlite3`) is the durable one. Three tables (`payments`, `audit`,
`alerts`) with the constraints that matter in the schema rather than in the application:

Unique on `(distribution_id, investor_id)` and on `(idempotency_key)`; `transition()` runs
inside one transaction; `journal_mode = WAL` and `synchronous = FULL` mean a committed state
change survives a process kill, which a test proves by killing a child process mid run.

`MemoryStore` mirrors the same uniqueness rules, so the contract suite passes against both
and the in-memory runs the harness uses are not a weaker model.

### Bank

`FakeBank` is seeded and models permanent and transient rejections, timeouts, lost and
delayed notifications, status lag, and a "lying transient" (rejects but settled anyway).
Only ACCEPTED and REJECTED_PERMANENT are committed; anything else rolls fresh.

## Durable orchestration (Temporal)

`src/temporal/` is the same runner under a durable engine, not a second set of rules.

- **One workflow per distribution**, `workflowId = distribution.id`. Starting it twice does
  not pay twice.
- **All I/O is an activity**: `ensurePayments`, `recordEvent`, `sendOnce`,
  `recordSendResponse`, `getStatus`, `recordStatus`, `buildResult`.
- **Business outcomes are return values, not exceptions.** A rejection or a timeout comes
  back as data, so Temporal's retries mean "the worker failed", never "the bank said no".
- **Determinism**: no `Math.random()`, no Node imports, and `Date.now()` is the SDK's
  patched workflow clock. `workflowInfo().unsafe.now()` reads system time, and mixing it
  with an activity clock made `lastSentAt` and the settle-window check disagree, skipping
  the window. The workflow reads `Date.now()` once per attempt and waits with Temporal's
  `sleep`, so backoff and the settle window are timers the test environment can skip.
- **Activities are at-least-once**, so `recordEvent` is idempotent: applying the same event
  twice lands on the same state, and a test kills the activity after its commit to prove it.

`test/temporal.test.ts` runs the workflow against `TestWorkflowEnvironment` with time
skipping, including `Worker.runReplayHistory` over a recorded history: if workflow code ever
stops being deterministic, that test fails.

## Read-only view (MCP)

`src/mcp/` serves four tools over stdio, reading the same SQLite file the worker writes. The
handle is opened read-only (`readonly: true`, `fileMustExist: true`) with no schema creation,
so the process cannot write even if a handler were buggy:

- `get_payment`: the stored record for one payment id.
- `explain_payment`: why it is where it is, with the event that arrived, the state it arrived
  in, the runner's reason, and the trail in order.
- `list_manual_review`: every escalated payment in a distribution, with its reason.
- `list_alerts`: bank events with no payment, skipped allocations.

There is no write path: the handler reaches only `Store` read methods, the tool list is
frozen, and a test fails if a tool name looks like a mutation.

## Browser replay (site/)

`site/` bundles the real `src/core` and the real checker with Vite (root `site/`, `base: "./"`
for the Pages subpath). Six stories rather than a form: each is a fixed seed plus bank
settings tuned so the named failure really happens. Three end green (everyone paid once),
two end red (a planted bug double-pays an investor and I1 catches it), one ends amber at
MANUAL_REVIEW because the bank stops answering. Every control is also a URL parameter
(`?story=bank-goes-quiet`, `?seed=42&flag=newKeyOnRetry`), so a run is a link.

The page runs the same code as the tests, so the bug you switch on is the bug the harness
catches.

## What the harness proves

`harness/check.ts` reads only outputs (audit log, store snapshot, bank settlements,
reconciliation report) and checks five invariants:

- `I1`: no key settled twice, no account paid more than its allocation.
- `I2`: after the run drains, nothing is left in SENDING or UNKNOWN.
- `I3`: allocations sum exactly to the total; confirmed + failed + manual = allocated.
- `I4`: our CONFIRMED set equals the bank's settled set, except MANUAL_REVIEW payments,
  which must appear in the reconciliation report.
- `I5`: every state change is audited, every transition legal, the trail continuous and
  ending at the stored state.

The checker keeps its **own** copy of the legal transitions rather than importing the table,
so a bug in the state machine cannot blind the check. That duplication is deliberate and has
to be maintained by hand.

Five break-it flags each break one invariant, and CI asserts exit code **1** for each: 0
means the flag broke nothing, 2 means the harness crashed, and neither counts as a catch.

For what all of this costs, and what was left out, see [DECISIONS.md](DECISIONS.md).
