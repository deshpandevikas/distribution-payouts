# Distribution payouts

A payout runner for a fund paying its investors. The hard part is not the math, it is a bank call that times out: did the money move?

## Try it

[The replay page](https://deshpandevikas.github.io/distribution-payouts/). Six stories, about 30 seconds.

[![CI](https://github.com/deshpandevikas/distribution-payouts/actions/workflows/ci.yml/badge.svg)](https://github.com/deshpandevikas/distribution-payouts/actions/workflows/ci.yml)

## Results

- **172 tests passing** across 28 files: unit, property, store contract, SIGKILL crash, Temporal replay, MCP, page.
- **2,000 random scenarios** against a bank that loses notifications, lies, times out and crashes the process: **0 double payments, 0 lost cents**.
- **98.1% of payments completed with no human involved** (20,811 payments, 392 of them reached MANUAL_REVIEW).
- **5 of 5 planted bugs caught.** The harness exits 1 for a caught violation and 2 for a crash, and CI accepts only 1, because a crash is not a catch.

## The idea in five lines

1. Write the intent (SENDING) **before** calling the bank, so a crash leaves a trace.
2. A timeout means UNKNOWN, never FAILED: the money may have moved.
3. Never resend blind. Check the status of the idempotency key first.
4. NOT_FOUND inside the settle window is probably lag, so wait and then resend the **same key**.
5. When the bank contradicts itself, stop and put a human in front of it.

## Where to read next

- [DECISIONS.md](DECISIONS.md) for why each choice was made.
- [DESIGN.md](DESIGN.md) for how it works.
- [RUNBOOK.md](RUNBOOK.md) for operating it.
- [docs/transitions.md](docs/transitions.md) for the full state table.

## How to run

Node 26 or newer (`.nvmrc` pins 26). No other services needed for the tests.

```bash
npm install
npm test            # 172 tests
npm run typecheck
npm run harness     # 2,000 seeded scenarios, then the invariant checker
```

The same code against a real database, a durable engine, and an operator interface:

```bash
npm run harness -- --scenarios=200 --store=sqlite   # SQLite instead of memory
npm run temporal:worker                             # Temporal worker (needs a local dev server)
npm run mcp:server                                  # read-only MCP tools over SQLITE_PATH
npm run site:dev                                    # the replay page on localhost
```

More variants, crash injection and single-seed replay are in [RUNBOOK.md](RUNBOOK.md).

## Code map

| Path | What |
|---|---|
| `src/core/` | Money, allocation, state machine, runner, reconciliation. No Node imports, so it also runs in the browser. |
| `src/store/` | `Store` port, `MemoryStore`, `SqliteStore`. |
| `src/bank/` | `FakeBank` (seeded failure modes), `FileBank` (survives a killed process). |
| `harness/` | Scenario generator, invariant checker, break-it flags. |
| `src/temporal/` | Durable orchestration: one workflow per distribution, all I/O in activities. |
| `src/mcp/` | Four read-only tools for an operator. |
| `site/` | Browser replay of the same core. |
| `test/` | 28 files, named by the behavior they pin down. |

## How this was built

I used coding agents for most of the typing. I set the scope, decided every state transition and invariant, and reviewed each change. The review mattered: the first test harness passed while hiding three real bugs (retries that could never succeed, a restart that resent blindly, and a wait-then-resend path that never ran), and a later review caught a Temporal clock bug that the tests did not. Each fix landed as a failing test first, then the fix.

## Not built, on purpose

- Returns: money coming back after settlement.
- Maker-checker approval.
- Identity holds.
- Investor notification.
- GraphQL API, because no client needs one yet.
- Postgres: SQLite proves the transaction and crash behavior with zero setup.
- Capital calls and the investor wallet: the same payment engine, a different direction.

See "If I kept going" in [DECISIONS.md](DECISIONS.md) for what comes next, and "Trade-offs I accepted" for what that costs.
