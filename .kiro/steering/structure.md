---
inclusion: always
---
src/core/      allocation.ts, stateMachine.ts, runner.ts, reconcile.ts, types.ts
src/bank/      fakeBank.ts (seeded, configurable failure rates, status query on/off)
src/store/     store.ts (interface), memoryStore.ts
harness/       generate.ts (scenarios), check.ts (invariants), metrics.ts, run.ts (CLI)
test/          unit tests, invariants.test.ts (property tests)
