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
// Single scenario run
// ---------------------------------------------------------------------------

async function runScenario(seed: number, opts: ReturnType<typeof parseArgs>) {
  let scenario = generate(seed, {
    bankConfig: {
      ...(opts.noStatusQuery ? { statusQueryEnabled: false } : {}),
      // overwriteConflictingConfirm requires lying-transient sends to produce
      // FAILED payments that later receive ASYNC_CONFIRM.
      ...(opts.breakIt.overwriteConflictingConfirm ? { lyingTransientRate: 0.5 } : {}),
    },
    runnerConfig: opts.breakIt,
    crashAt: opts.crashAt,
  });
  scenario = await buildDistribution(scenario);

  const store = new MemoryStore();
  const bankRng = rngFromSeed(seed + 1); // separate RNG stream for bank
  const bank = new FakeBank(bankRng, scenario.bankConfig);

  // Fake clock: starts at 0, advances by 1ms on each call.
  let now = 0;
  const clock = { now: () => now++ };

  const runner = new Runner({
    store,
    bank,
    clock,
    rng: rngFromSeed(seed + 2), // separate RNG for runner backoff jitter
    config: scenario.runnerConfig,
    crashAt: scenario.crashAt,
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
        config: { ...scenario.runnerConfig, skipIntentRecord: false }, // reset intent flag on restart
        crashAt: undefined, // no second crash
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
