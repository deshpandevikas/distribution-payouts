# Design

How the payout runner is put together, and why it looks like this.

The problem: a broker distributes a total amount to its investors. Each investor gets a share
of the total, and each share becomes one bank transfer. Between "we decided to pay" and "the
bank confirms the money moved" the process can stall, time out, crash, or receive a
notification twice. The design is mostly about that gap.

## The parts

| Part | Code | Role |
|---|---|---|
| Money | `src/core/money.ts` | Integer cents only. No floats anywhere. |
| Allocation | `src/core/allocation.ts` | Pro rata by supplied basis units, floor to cents, leftover cents by largest remainder, ties by investor id. Sums to the total exactly. |
| State machine | `src/core/stateMachine.ts` | One table: `(state, event) -> outcome`. Pure; no scheduling, no I/O. |
| Runner | `src/core/runner.ts` | Drives each payment from CREATED to terminal: record intent, send, interpret the response, poll status, drain async events. |
| Reconciliation | `src/core/reconcile.ts` | End-of-run comparison of our store against the bank: `OURS_ONLY`, `BANK_ONLY`, `AMOUNT_MISMATCH`, `STATE_MISMATCH`. Reports; never fixes. |
| Store port | `src/core/types.ts`, `src/store/` | `MemoryStore` for speed, `SqliteStore` for durability. |
| Bank port | `src/core/types.ts`, `src/bank/`, `test/fixtures/fileBank.ts` | `FakeBank` for scenarios; `FileBank` (a ledger on disk, so it survives a killed process) for crash tests. |
| Harness | `harness/` | Scenario generator, invariant checker, break-it flags, CLI. |
| Temporal adapter | `src/temporal/` | Durable version of the same runner: workflow per distribution, all I/O in activities. |
| MCP server | `src/mcp/` | Four read-only tools over the store. |
| Replay page | `site/` | The same core + checker, compiled into a static page. |

`src/core` imports nothing from Node. That is not an accident of style: the same code has to
run under Vitest, inside a Temporal workflow sandbox (no Node), and in a browser. A guard
test (`test/core-no-node-imports.test.ts`) fails the build if a `node:` import appears.

## The six states

```
CREATED ──SEND_INTENT_RECORDED──> SENDING ──BANK_ACCEPTED──> CONFIRMED
                                     │
                                     ├──REJECTED_PERMANENT──> FAILED
                                     ├──REJECTED_TRANSIENT──> SENDING (retry, same key)
                                     ├──TIMEOUT─────────────> UNKNOWN
                                     │                           │
                                     │        STATUS_CONFIRMED ──┼──> CONFIRMED
                                     │        STATUS_FAILED ─────┼──> FAILED
                                     │        NOT_FOUND ─────────┴──> SENDING (after window)
                                     │        CHECKS_EXHAUSTED ─────> MANUAL_REVIEW
                                     └──ASYNC_CONFIRM / ASYNC_FAILURE──> CONFIRMED / FAILED
```

The full 6 × 14 grid, including the cells that exist only to escalate, is
[docs/transitions.md](docs/transitions.md). Four outcomes per cell: move, no-op (duplicate
event, logged), `MR!` (move to MANUAL_REVIEW and alert), `hold` (stay in MANUAL_REVIEW and
attach the event as evidence). `ILLEGAL` throws — but only for events the runner itself
generated; a bank event never throws, because a bank saying something unexpected is a
situation to investigate, not a bug to crash on.

## The one hard question: did the money move?

A bank call can fail in three genuinely different ways, and conflating them is how payout
systems double-pay people:

- **The bank said no.** The payment did not happen. FAILED is correct.
- **The bank said yes.** Record CONFIRMED with the key.
- **The bank said nothing** (timeout, dropped connection, our process died). *We do not
  know.* The money may have moved.

So the runner never guesses:

1. **Intent before the call.** `SEND_INTENT_RECORDED` moves the payment to SENDING and is
   persisted before `bank.send()` is invoked. A crash at that instant leaves a payment whose
   state says "we may have sent this", which is the truth.
2. **Timeout → UNKNOWN, never FAILED.** FAILED invites a resend, and a resend assumes nothing
   was received. With a bank that does not deduplicate on the key (or a key we lost), that
   assumption is a second transfer.
3. **Check status before resending.** A status query is free of risk; a resend moves money.
   The runner asks the bank for the key's status before it considers sending again.
4. **The settle window.** `NOT_FOUND` does not mean "not there" — it often means "not visible
   yet". Inside the window the payment waits (the runner sleeps the remainder of the window,
   so time actually passes and the check budget is not burned in a tight loop). After the
   window, a NOT_FOUND is the bank's considered answer, and the runner resends **the same
   key**. If the first send had in fact settled, the deduplicating bank returns the original
   acceptance rather than paying twice.
5. **Bounded checks, then a human.** Status checks are cumulative per payment and capped
   (default 5), so every payment terminates. `CHECKS_EXHAUSTED` escalates to MANUAL_REVIEW:
   unknown money is a person's problem, not a loop's.
6. **Restart is not a fresh start.** A payment found in SENDING or UNKNOWN on restart gets
   `RECOVERY_ON_RESTART`: status check first, never a blind resend.

## Idempotency

The key is readable and deterministic:

```
dist-2026-Q3:inv-042:1          # retries reuse it
dist-2026-Q3:inv-042:2          # reissue = new instruction = new key
```

Readable on purpose: a key appears in a bank statement, an audit row and an operator's
message, and it should say what it pays for. Deterministic on purpose: recomputing the key
after a restart produces the same string, which is what makes a resend a no-op at the bank.
It is not a hash, so `src/core` needs no `node:crypto` and can run in the browser.

`instructionNo` is what separates "retry" from "reissue": retries keep it, reissues increment
it (Phase 1.5, with returns). A break-it flag appends `:retry-N` so that a bug key can never
be mistaken for a real one.

## Ports and adapters

The core sees two injected ports plus `Clock` and `Rng`. Nothing in `src/core` reads the
wall clock or a random source directly, which is why any seed replays exactly — in a test, in
the harness, and on the page.

### Store

```ts
savePayment, getPayment, getPaymentByKey, listPayments          // payments
appendAudit, listAudit                                          // append-only history
appendAlert, listAlerts                                         // operator records, not payments
transition(payment, auditEntry)                                 // state change + audit, atomically
```

`transition()` is the only way state changes. It writes the payment and its audit entry
together, so the invariant "every state change has an audit row" is a property of the API
rather than of careful call sites.

Alerts are deliberately not payment audit rows. A bank event for a key we never sent has no
payment to attach to; manufacturing a `CREATED -> MANUAL_REVIEW` row under a fake payment id
made it invisible to an operator querying the distribution. Alerts are keyed to the
distribution instead.

### SQLite adapter

`SqliteStore` (`better-sqlite3`) is the durable one. Three tables — `payments`, `audit`,
`alerts` — with the constraints that matter in the schema rather than in the application:

- `UNIQUE (distribution_id, investor_id)` — one payment per investor per distribution;
- `UNIQUE (idempotency_key)` — one payment per key;
- `transition()` inside a single transaction (update + insert, commit or rollback);
- `journal_mode = WAL`, `synchronous = FULL` — a committed state change survives a process
  kill, which a test proves by `SIGKILL`-ing a child process mid-run and reopening the file.

`MemoryStore` mirrors the same uniqueness rules, so the contract suite passes against both
and the in-memory runs the harness uses are not a weaker model.

### Bank

`FakeBank` is seeded and models the failure modes that matter: permanent and transient
rejections, timeouts, late and **lost** notifications (`asyncDropRate`), delayed
notifications (`asyncDelayChecks`), status lag, and "lying transient" (the bank rejects as
transient but settled anyway, then notifies later). Only ACCEPTED and REJECTED_PERMANENT are
committed outcomes; a transient rejection or an unresolved timeout rolls fresh on the next
send, the way a real bank does.

## Durable orchestration (Temporal)

`src/temporal/` is the same runner under a durable engine, not a second implementation of the
rules: the workflow calls the same transition table through activities.

- **One workflow per distribution**, `workflowId = distribution.id`. Starting it twice does
  not pay twice.
- **All I/O is an activity**: `ensurePayments`, `recordEvent`, `sendOnce`,
  `recordSendResponse`, `getStatus`, `recordStatus`, `buildResult`.
- **Business outcomes are return values, not exceptions.** A rejection or a timeout comes back
  as data, so Temporal's retries mean "the worker failed", never "the bank said no". Retrying
  a `REJECTED_PERMANENT` as if it were an infrastructure fault would be exactly the bug the
  core avoids.
- **Determinism**: no `Date.now()`, no `Math.random()`, no Node imports. Time comes from
  `workflowInfo().unsafe.now()`; waiting uses Temporal's `sleep`, so backoff and the settle
  window are timers the test environment can skip and a replay can reproduce.
- **Activities are at-least-once**, so `recordEvent` is idempotent: the activity re-reads the
  payment and applying the same event twice lands on the same state. A test kills the
  activity after its commit, lets Temporal retry, and asserts the payment moved once.

`test/temporal.test.ts` runs the workflow against `TestWorkflowEnvironment` (time-skipping),
including `Worker.runReplayHistory` over a recorded history: if workflow code ever stops being
deterministic, that test fails.

## Read-only view (MCP)

`src/mcp/` serves four tools over stdio, reading the same SQLite file the worker writes:

| Tool | Answers |
|---|---|
| `get_payment` | The stored record for one payment id. |
| `explain_payment` | *Why* it is where it is: the event that arrived, the state it arrived in, the runner's own reason, then the trail in order. |
| `list_manual_review` | Every escalated payment in a distribution, with the reason it got there. |
| `list_alerts` | Bank events with no payment, skipped allocations. |

There is no write path. The handler can only reach `Store` read methods, the tool list is a
frozen constant, and a test fails if any tool name looks like a mutation.

## Browser replay (site/)

`site/` bundles the real `src/core` and the real checker with Vite (root `site/`, `base: "./"`
for the Pages subpath). The page takes a seed, investor count and total, plus bank failure
rates, runs the distribution, and prints the outcome and any invariant violations. Every
control is also a URL parameter (`?seed=42&flag=newKeyOnRetry`), so a failing run is a link
someone can open.

The point of the page is honesty: it is the same code the tests run, so the bug you switch on
is the bug the harness catches, and you can watch a green run turn red.

## What the harness proves

`harness/check.ts` reads only outputs — audit log, store snapshot, bank settlements,
reconciliation report — and checks five invariants:

| | |
|---|---|
| I1 | No key settled twice; no account received more than its allocation. |
| I2 | After the run drains, nothing is left in SENDING or UNKNOWN. |
| I3 | Allocations sum exactly to the total; confirmed + failed + manual = allocated. |
| I4 | Our CONFIRMED set equals the bank's settled set — except MANUAL_REVIEW payments, which must appear in the reconciliation report. |
| I5 | Every state change is audited, every audited transition is legal, the trail is continuous, and it ends at the stored state. |

The checker keeps its **own** copy of the legal transitions rather than importing the table,
so a bug in the state machine cannot blind the check. That duplication is deliberate and has
to be maintained by hand.

Five break-it flags each break one invariant, and CI asserts exit code **1** for each — 0
means the flag broke nothing, 2 means the harness crashed, and neither counts as a catch.

## Trade-offs

- **MANUAL_REVIEW is terminal.** No timeout moves a payment out of it. A human resolves it, and
  there is no admin write tool today: resolution is a deliberate out-of-band action, which is
  worse ergonomically and better for safety than an automated "just mark it paid".
- **`synchronous = FULL` and WAL** cost write throughput and buy the crash guarantee. For
  thousands of payments that is the right trade; for millions, batching would be needed.
- **Readable keys instead of hashes** trade length and a small exposure of internal ids for
  debuggability. Investor ids are internal, not bank data.
- **Polling, not webhooks, is the source of truth.** Notifications are an optimisation; the
  status query is what decides. That is why lost notifications cannot lose money.
- **Two orchestration paths.** Keeping the direct runner and the Temporal version in step is
  real work; the shared state machine and the shared checker are what keep them honest, and
  `test/invariants.test.ts` grades both the same way.
- **Five checks and a two-minute window are policy, not physics.** They encode "how long
  before we call it unknown"; a different bank needs different numbers.
- **USD only, integer cents, no FX** — a real payout system needs per-currency minor units.

## Not built

Deliberately out of scope, written up in `docs/agreed-decisions.md`: maker-checker approval
above a threshold, identity holds, bank-detail snapshots at approval, cancelling unsent
payments, investor notification, and returns (money coming back after settlement, which needs
a `RETURNED` state, a ledger reversal and an approved reissue).
