# Runbook

What to do when a payment is escalated, an alert fires, or CI goes red.

Everything below assumes the store is the SQLite file the worker and the MCP server share
(`SQLITE_PATH`, default `payouts.db`). The MCP server is the intended way to look: it is
read-only, so looking can never change anything.

```bash
SQLITE_PATH=payouts.db npm run mcp:server   # then call the tools from any MCP client
```

## A payment in MANUAL_REVIEW

**What it means.** The system stopped on purpose. Either it ran out of safe options
(`CHECKS_EXHAUSTED`, `UNKNOWN` after five status checks) or the bank said two incompatible
things (a confirm for a payment we recorded FAILED, a status for a CONFIRMED payment that now
says failed, an event for a payment we never sent).

**Find it.** `list_manual_review` with the `distributionId`. Then `explain_payment` with the
`paymentId`: it gives the event that arrived, the state it arrived in, the runner's own reason
("ASYNC_CONFIRM on FAILED — contradiction, investigate"), and the trail in order.

**Read the reason before the amounts.** The reason tells you which of two situations you are
in:

| Situation | What the trail shows | What it means |
|---|---|---|
| Contradiction | Two terminal-looking events, opposite directions (confirm after failure) | One of the bank's answers is wrong. Which one, only the bank can say. |
| Checks exhausted | `BANK_TIMEOUT` / `NOT_FOUND` repeated, then `CHECKS_EXHAUSTED` | We never learned whether the money moved. |
| Bank event for an unknown key | No payment with that key | Money reported against something we did not record. |

**Decide.**

1. Ask the bank (statement, portal, support) whether the key settled.
2. If it **did** settle, our record is wrong — the reconciliation report shows this as
   `STATE_MISMATCH` for that key. Correct it out of band and record why.
3. If it **did not** settle, re-paying is a new instruction: new `instructionNo`, therefore a
   new key, and a human decision. Do not reuse the old key by hand — that is exactly the
   "blind resend" the system refuses to do.
4. Record the decision. Whatever the outcome, the reason for the human decision belongs
   somewhere durable.

**What not to do.** Do not edit the `payments` table directly while a run is in flight. The
database will accept it, but `transition()` is the only audited path: a hand edit leaves the
final audit row pointing at the old state, and the next run fails I5 with "final audit toState
!= payment state". If you must correct the store, take the run offline first.

**While it waits.** Any bank event for a payment in MANUAL_REVIEW is attached as evidence and
does not move it (`hold`). So a manual review can accumulate confirmations and failures
without racing the person looking at it. Nothing times out of MANUAL_REVIEW.

## Alerts

Alerts are records about the distribution, not payment state changes. `list_alerts` returns
them with a timestamp.

### `BANK_EVENT_FOR_UNKNOWN_KEY`

The bank reported a confirmation or failure for an idempotency key with no payment in this
distribution.

Likely causes: the event belongs to another distribution (a misrouted or duplicated
notification); a reissued payment is still receiving events for its old key; or a fabricated
webhook. The alert includes the key in its `detail`, so the key is the thing to trace:
`<distributionId>:<investorId>:<instructionNo>`.

Do **not** create a payment record to "attach" the event. If money really moved and we have no
record of it, that is a reconciliation problem, not a data-entry problem.

### `ALLOCATION_SKIPPED`

A zero-cent share produced no payment (decision 13 in `docs/agreed-decisions.md`). Expected
whenever a tiny basis rounds down to zero: the investor is still recorded, just not paid.
No action, unless the count is surprising — then check the allocation basis, since rounding
happens by largest remainder and a wrong basis unit is what usually moves the boundary.

## A red CI run

Steps run in order; the first failure is the one that matters.

| Step | A failure means |
|---|---|
| `better-sqlite3 loads a Node 26 prebuild` | The install log shows `node-gyp`, i.e. no prebuild for this Node. The rule is prebuild or fall back to `node:sqlite`; a silent source compile is not acceptable, so this step asserts on the log rather than on the build succeeding. |
| `Type check` | A real type error. Nothing to interpret. |
| `Unit and property tests` | A failing `store-contract` test means the two stores diverged; `sqlite-crash` means durability broke; `temporal` means determinism or activity idempotency broke; `core-no-node-imports` means a Node import crept into `src/core` (which would also break the page build). |
| `Harness fixed seeds` | A deterministic regression on a seed in `1,2,3,42,100,999,1234,5678,9999,10000`. Reproduce locally with that seed and `--verbose` before changing anything. |
| `Harness on the SQLite store` | Rules hold in memory but not once persisted — look for a transaction boundary or a missing constraint, not a logic bug. |
| `Break-it flags each fail an invariant` | This step asserts **exit 1** for each of the five flags. Exit **0** means the flag stopped breaking anything (the bug moved, or the bank config drifted); exit **2** means the harness crashed — an exception is not a catch. Both fail the step. |

The Pages workflow is separate. If `site:build` fails, the core probably stopped being
browser-safe; the `core-no-node-imports` test usually fails first and says which import.

## Replay a seed

Deterministic everywhere: same seed, same distribution, same bank rolls, same outcome.

```bash
npm run harness -- --seed=42 --verbose
npm run harness -- --seed=42 --store=sqlite
npm run harness -- --seed=42 --no-status-query
npm run harness -- --seed=42 --crash-at=afterBankCallBeforeRecord
npm run harness -- --seed=42 --break-it=resendWithoutStatusCheck   # expect exit 1
```

`--crash-at` accepts `afterIntentRecorded`, `afterBankCallBeforeRecord`,
`duringStatusCheck`. The harness stops at that point; re-running the same seed shows what a
restart does with the payment it left behind.

On the page: https://deshpandevikas.github.io/distribution-payouts/

| Parameter | Default meaning |
|---|---|
| `seed` | The whole scenario. Same seed, same run. |
| `investors` | How many investors to allocate to (capped at 40). |
| `total` | Total to distribute, in cents. |
| `timeoutRate` | Chance a send times out. |
| `transientRejectRate` | Chance of a transient rejection (retried, same key). |
| `lyingTransientRate` | Chance a transient rejection actually settled anyway. |
| `asyncConfirmRate` | Of timed-out sends, the share that later confirm. |
| `asyncDelayChecks` | Deliver the notification only after N status queries. |
| `asyncDropRate` | Chance a notification is lost entirely. |
| `flag` | One break-it flag, or empty. |

Example: `?seed=42&flag=newKeyOnRetry` — the run ends with a violated invariant and the page
prints which one. Set `timeoutRate=1` to make timeouts certain.

## A stuck Temporal run

```bash
npm run temporal:worker                 # must be running; task queue "distribution-payouts"
npm run temporal:start                  # one workflow, workflowId = distribution id
```

The worker and MCP server read the same `SQLITE_PATH`, so inspect the store while the workflow
waits. With the Temporal CLI, `temporal workflow describe` shows pending activities.

If the worker is being restarted, let it shut down: `Worker.shutdown()` waits for in-flight
activities, and a kill mid-activity leaves Temporal to retry it. That retry is safe — the
activities are at-least-once and `recordEvent` is idempotent — but a kill makes the run take
longer and shows up as activity retries in the history.
