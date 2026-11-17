/**
 * Harness CLI entry point.
 *
 * Usage:
 *   npx tsx harness/run.ts [options]
 *
 * Options:
 *   --scenarios=N      Number of random scenarios (default 2000)
 *   --seed=N           Run a single specific seed
 *   --seeds=1,2,3      Run specific seeds (comma-separated)
 *   --verbose          Print per-run metrics (always printed on failure)
 *   --break-it=FLAG    Enable one break-it flag for all runs
 *                      Flags: skipIntentRecord | timeoutAsFailure | newKeyOnRetry |
 *                             overwriteConflictingConfirm | resendWithoutStatusCheck
 *   --no-status-query  Disable bank status query for all runs
 *   --crash-at=POINT   Inject crash at: afterIntentRecorded |
 *                                       afterBankCallBeforeRecord |
 *                                       duringStatusCheck
 *
 * Exit code: 0 if all invariants pass, 1 if any fail.
 */

import { Runner, CrashInjected } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import type { FakeBankConfig } from "../src/bank/fakeBank.js";
import { reconcile } from "../src/core/reconcile.js";
import { generate, buildDistribution, rngFromSeed } from "./generate.js";
import { check } from "./check.js";
import {
  collectRunMetrics,
  collectGridCoverage,
  mergeGridCoverage,
  aggregate,
  printRunMetrics,
  printAggregate,
  printGridCoverage,
  type GridCoverage,
} from "./metrics.js";
import type { RunnerConfig } from "../src/core/types.js";
import type { CrashPoint } from "../src/core/runner.js";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  scenarios: number;
  seeds: number[] | null;
  verbose: boolean;
  breakIt: Partial<RunnerConfig>;
  noStatusQuery: boolean;
  crashAt: CrashPoint | undefined;
} {
  const args = argv.slice(2);
  let scenarios = 2000;
  let seeds: number[] | null = null;
  let verbose = false;
  const breakIt: Partial<RunnerConfig> = {};
  let noStatusQuery = false;
  let crashAt: CrashPoint | undefined;

  for (const arg of args) {
    if (arg.startsWith("--scenarios=")) {
      scenarios = parseInt(arg.slice("--scenarios=".length), 10);
    } else if (arg.startsWith("--seed=")) {
      seeds = [parseInt(arg.slice("--seed=".length), 10)];
    } else if (arg.startsWith("--seeds=")) {
      seeds = arg.slice("--seeds=".length).split(",").map((s) => parseInt(s.trim(), 10));
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--no-status-query") {
      noStatusQuery = true;
    } else if (arg.startsWith("--break-it=")) {
      const flag = arg.slice("--break-it=".length);
      switch (flag) {
        case "skipIntentRecord":           breakIt.skipIntentRecord = true; break;
        case "timeoutAsFailure":           breakIt.timeoutAsFailure = true; break;
        case "newKeyOnRetry":              breakIt.newKeyOnRetry = true; break;
        case "overwriteConflictingConfirm": breakIt.overwriteConflictingConfirm = true; break;
        case "resendWithoutStatusCheck":   breakIt.resendWithoutStatusCheck = true; break;
        default:
          console.error(`Unknown break-it flag: ${flag}`);
          process.exit(1);
      }
    } else if (arg.startsWith("--crash-at=")) {
      crashAt = arg.slice("--crash-at=".length) as CrashPoint;
    }
  }

  return { scenarios, seeds, verbose, breakIt, noStatusQuery, crashAt };
}

// ---------------------------------------------------------------------------
// Per-flag bank config
// ---------------------------------------------------------------------------
//
// Some break-it bugs are only reachable under a specific bank failure pattern.
// overwriteConflictingConfirm needs a payment sitting in FAILED when an
// ASYNC_CONFIRM for its key is drained. Since a retry now cancels the queued
// async event, the only surviving route is a lying transient on the *last*
// allowed attempt: the runner retries-exhausts, the payment lands FAILED, and
// the event stays queued. At the default rates that is ~5e-4 per payment, i.e.
// ~0.25 expected hits across the 50 scenarios CI runs - so the flag looked
// fixed when it was only rare. Tuning the bank the way
// test/r6-break-it.test.ts does makes the same route routine.

const BREAK_IT_BANK_CONFIG = {
  overwriteConflictingConfirm: {
    transientRejectRate: 0.5,
    lyingTransientRate: 1,
    permanentRejectRate: 0,
    timeoutRate: 0,
    statusTimeoutRate: 0,
  },
} satisfies Partial<Record<keyof RunnerConfig, Partial<FakeBankConfig>>>;

function breakItBankConfig(breakIt: Partial<RunnerConfig>): Partial<FakeBankConfig> {
  const overrides: Partial<FakeBankConfig> = {};
  for (const flag of Object.keys(BREAK_IT_BANK_CONFIG) as Array<keyof typeof BREAK_IT_BANK_CONFIG>) {
    if (breakIt[flag] === true) Object.assign(overrides, BREAK_IT_BANK_CONFIG[flag]);
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// Single scenario run
// ---------------------------------------------------------------------------

async function runScenario(seed: number, opts: ReturnType<typeof parseArgs>) {
  let scenario = generate(seed, {
    bankConfig: {
      ...(opts.noStatusQuery ? { statusQueryEnabled: false } : {}),
      ...breakItBankConfig(opts.breakIt),
    },
    runnerConfig: opts.breakIt,
    ...(opts.crashAt !== undefined ? { crashAt: opts.crashAt } : {}),
  });
  scenario = await buildDistribution(scenario);

  const store = new MemoryStore();
  const bankRng = rngFromSeed(seed + 1); // separate RNG stream for bank
  const bank = new FakeBank(bankRng, scenario.bankConfig);

  // Fake clock: starts at 0, advances by 1ms on each call.
  let now = 0;
  const clock = { now: () => now++, sleep: async () => { now += 1; } };

  const runner = new Runner({
    store,
    bank,
    clock,
    rng: rngFromSeed(seed + 2),
    config: scenario.runnerConfig,
    ...(scenario.crashAt !== undefined ? { crashAt: scenario.crashAt } : {}),
  });

  try {
    await runner.run(scenario.distribution);
  } catch (err) {
    if (err instanceof CrashInjected) {
      // Crash: rebuild runner over same store + bank (simulates restart).
      const runner2 = new Runner({
        store,
        bank,
        clock,
        rng: rngFromSeed(seed + 3),
        config: { ...scenario.runnerConfig, skipIntentRecord: false },
      });
      await runner2.run(scenario.distribution);
    } else {
      throw err;
    }
  }

  const report = reconcile(
    scenario.distribution.id,
    store,
    bank,
    clock.now(),
  );

  const checkResult = check({
    distributionId: scenario.distribution.id,
    store,
    bank,
    report,
    totalAllocatedCents: scenario.distribution.allocations.reduce((s, a) => s + a.amountCents, 0),
  });

  return {
    runMetrics: collectRunMetrics(seed, scenario.distribution.id, store, checkResult),
    coverage: collectGridCoverage(scenario.distribution.id, store),
  };
}

async function main() {
  const opts = parseArgs(process.argv);

  // Determine seeds to run.
  const seedList: number[] = opts.seeds
    ? opts.seeds
    : Array.from({ length: opts.scenarios }, (_, i) => i + 1);

  console.log(`Running ${seedList.length} scenario(s)...`);
  if (Object.keys(opts.breakIt).length > 0) {
    console.log(`Break-it flags: ${JSON.stringify(opts.breakIt)}`);
  }
  if (opts.noStatusQuery) console.log("Bank status query: OFF");
  if (opts.crashAt) console.log(`Crash injection: ${opts.crashAt}`);

  const allMetrics = [];
  const allCoverages: GridCoverage[] = [];
  let anyFailed = false;

  for (const seed of seedList) {
    const { runMetrics, coverage } = await runScenario(seed, opts);
    allMetrics.push(runMetrics);
    allCoverages.push(coverage);

    if (!runMetrics.invariantsPassed) {
      anyFailed = true;
      printRunMetrics(runMetrics);
    } else if (opts.verbose) {
      printRunMetrics(runMetrics);
    }
  }

  const activeFlags = Object.keys(opts.breakIt);
  printAggregate(aggregate(allMetrics));
  printGridCoverage(mergeGridCoverage(allCoverages), activeFlags);

  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
