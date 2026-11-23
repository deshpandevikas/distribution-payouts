# Distribution payouts

One distribution, many investors, pro-rata cents, one bank payment each. The arithmetic is
the easy part. The hard part starts when the bank call times out: **did the money move?**

This project starts from that question. It builds a small payout runner, then tries
hard to break it: a deterministic fake bank that loses notifications and lies about
transient rejections, crash injection, an invariant checker that reads only outputs, 2,000
randomized scenarios per harness run, and five bugs that the harness must catch (exit 1, not
0, and not a crash).

- **Replay page:** https://deshpandevikas.github.io/distribution-payouts/ — six stories: three pay everyone once, two double-pay an investor and get caught, one hands the money to a human. Or run a seed of your own.
- **CI:** https://github.com/deshpandevikas/distribution-payouts/actions/workflows/ci.yml

## The idea in five lines

1. Write the intent (SENDING) **before** calling the bank, so a crash leaves a trace.
2. A timeout means UNKNOWN, never FAILED: the money may have moved.
3. Never resend blind. Check the status of the idempotency key first.
4. NOT_FOUND inside the settle window is probably lag — wait, then resend the **same key**.
5. When the bank contradicts itself, stop and put a human in front of it.

Full write-up: [DESIGN.md](DESIGN.md). Transition grid: [docs/transitions.md](docs/transitions.md).
Operator procedures: [RUNBOOK.md](RUNBOOK.md).

## How to run it

Node 26 or newer (`.nvmrc` pins 26). No other services needed for the tests.

```bash
npm install
npm test            # unit, property, store-contract, crash, Temporal, MCP, page tests
npm run typecheck
npm run harness     # 2,000 seeded scenarios, then the invariant checker
```

Useful variants of the harness:

```bash
npm run harness -- --seed=42 --verbose          # one seed, per-run metrics
npm run harness -- --scenarios=200 --store=sqlite
npm run harness -- --break-it=newKeyOnRetry     # must exit 1
npm run harness -- --no-status-query            # bank that cannot answer status
```

Exit code matters: **0** = all invariants held, **1** = a real violation was caught,
**2** = the harness itself failed (bad flag, uncaught exception). A crash is not a catch.

Beyond the core:

```bash
npm run site:dev        # replay page on localhost (vite)
npm run site:build      # static bundle in site-dist/
npm run mcp:server      # read-only MCP server over stdio, reads SQLITE_PATH (default payouts.db)
npm run temporal:worker # Temporal worker (task queue "distribution-payouts")
npm run temporal:start  # start a distribution workflow by id
```

Temporal needs a dev server on `localhost:7233` (`temporal server start-dev`); override with
`TEMPORAL_ADDRESS`. Both the worker and the MCP server read the same SQLite file, so an
operator can inspect what the worker wrote.

## Where things live

| Path | What |
|---|---|
| `src/core/` | Pure logic: money, allocation, state machine, runner, reconciliation. No Node imports, so it also runs in the browser. |
| `src/store/` | `Store` port, `MemoryStore`, `SqliteStore`. |
| `src/bank/` | `FakeBank` (seeded failure modes), `FileBank` (crash tests). |
| `harness/` | `run.ts` scenario runner, `check.ts` invariant checker (I1–I5). |
| `src/temporal/` | Durable orchestration: one workflow per distribution, all I/O in activities. |
| `src/mcp/` | Read-only MCP tools for an operator or an agent. |
| `site/` | Browser replay: same core code, bundled. |
| `test/` | 28 files, including store-contract, SIGKILL crash, Temporal replay and MCP tests. |

## Future work: returns

Everything here assumes money only goes **out**. Real distributions also get money **back**:
a bank reverses a settled payment weeks later, and the investor has already been paid once.

The design for that is written down but not built (`docs/agreed-decisions.md`, decision 7):

- a `RETURNED` state, reached only by a `RETURN` event carrying the bank's reversal reference;
- the ledger reversal paired with the original payment, so the investor is never net-paid twice;
- a reissue that needs **new bank details and a second approval**, a new `instructionNo` and
  therefore a new idempotency key, plus a `reissue_of` link back to the original;
- and the same question as always, one level up: if the return notification is lost, the
  status query must still find it.

Until then `FAILED` is terminal for automated work, and re-paying a failed investor is a
human decision with a new key.

## Status

Phase 1 (core runner, harness, invariants) and the later work — durable store, Temporal,
published replay page, read-only MCP — are in. The project deliberately stops short of
maker-checker approval, identity holds, cancellation and investor notification; those are
described in `docs/agreed-decisions.md` and left unbuilt.
