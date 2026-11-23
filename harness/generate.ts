/**
 * Harness scenario generator.
 *
 * Builds a fully-specified scenario from a seed:
 *   - A distribution with N investors and a total amount
 *   - FakeBank config (failure rates)
 *   - RunnerConfig (break-it flags off by default)
 *   - An optional crash injection point
 *
 * Everything is deterministic: same seed => same scenario => same run.
 * The harness runner calls generate() for each seed in its list.
 */

import type { Distribution, AllocationInput, Investor, RunnerConfig } from "../src/core/types.js";
import { DEFAULT_RUNNER_CONFIG } from "../src/core/types.js";
import type { FakeBankConfig } from "../src/bank/fakeBank.js";
import { DEFAULT_FAKE_BANK_CONFIG } from "../src/bank/fakeBank.js";
import type { CrashPoint } from "../src/core/runner.js";

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32  -  fast, good distribution, no deps)
// ---------------------------------------------------------------------------

export function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Wraps a seeded generator function as a Rng interface. */
export function rngFromSeed(seed: number) {
  const gen = makeSeededRng(seed);
  return { next: gen };
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export interface Scenario {
  seed: number;
  distribution: Distribution;
  allocationInputs: AllocationInput[];
  bankConfig: FakeBankConfig;
  runnerConfig: RunnerConfig;
  crashAt: CrashPoint | undefined;
}

export interface GenerateOptions {
  /** Min investors per distribution. Default 1. */
  minInvestors?: number;
  /** Max investors per distribution. Default 20. */
  maxInvestors?: number;
  /** Min total cents. Default 100 ($1.00). */
  minTotalCents?: number;
  /** Max total cents. Default 10_000_000 ($100,000). */
  maxTotalCents?: number;
  /** Override bank config (partial). */
  bankConfig?: Partial<FakeBankConfig>;
  /** Override runner config (partial). */
  runnerConfig?: Partial<RunnerConfig>;
  /** If set, inject this crash point. */
  crashAt?: CrashPoint;
}

export function generate(seed: number, opts: GenerateOptions = {}): Scenario {
  const rng = makeSeededRng(seed);
  const rand = () => rng();

  const minInvestors = opts.minInvestors ?? 1;
  const maxInvestors = opts.maxInvestors ?? 20;
  const minTotalCents = opts.minTotalCents ?? 100;
  const maxTotalCents = opts.maxTotalCents ?? 10_000_000;

  // Number of investors.
  const nInvestors = minInvestors + Math.floor(rand() * (maxInvestors - minInvestors + 1));

  // Total cents.
  const totalCents = minTotalCents + Math.floor(rand() * (maxTotalCents - minTotalCents + 1));

  // Build investors + basis units.
  const allocationInputs: AllocationInput[] = [];
  for (let i = 0; i < nInvestors; i++) {
    const investor: Investor = {
      id: `inv-${seed}-${i}`,
      name: `Investor ${i}`,
      bankDetails: `routing:${seed}:${i}`,
    };
    // Basis units: 1 to 1000, some investors may have 0 (edge case).
    const basisUnits = Math.floor(rand() * 1001);
    allocationInputs.push({ investor, basisUnits });
  }

  const distributionId = `dist-${seed}`;

  // Allocate to build the distribution (import inline to avoid circular dep).
  // We import allocate lazily here so generate.ts has no hard dep on allocation.ts at module load.
  // The caller builds the Distribution with pre-allocated amounts via buildDistribution().
  const bankConfig: FakeBankConfig = {
    ...DEFAULT_FAKE_BANK_CONFIG,
    ...(opts.bankConfig ?? {}),
  };

  // Status-visibility lag for a deterministic subset of seeds: the bank has the
  // record but reports NOT_FOUND for the first checks. That is what exercises
  // the settle-window wait-then-resend path in the default sweep, instead of
  // only inside tuned break-it configs.
  if (opts.bankConfig?.lagChecks === undefined) {
    bankConfig.lagChecks = seed % 7 === 0 ? 2 : 0;
  }

  // A notification is not guaranteed either. Vary the bank by seed so the
  // default sweep covers the paths that only exist when it is lost or late -
  // above all a status query actually issued from UNKNOWN.
  if (opts.bankConfig?.asyncDropRate === undefined && opts.bankConfig?.asyncDelayChecks === undefined) {
    switch (seed % 6) {
      case 1:
        // Webhook lost; the money still moved, so only a query finds out.
        bankConfig.asyncDropRate = 0.35;
        break;
      case 2:
        // Bank knows but tells us late: queries happen first.
        bankConfig.asyncDelayChecks = 1 + (seed % 3);
        break;
      case 3:
        // Late notification plus a flaky status endpoint: a query from UNKNOWN
        // can time out, which is UNKNOWN:BANK_TIMEOUT.
        bankConfig.asyncDelayChecks = 2;
        bankConfig.statusTimeoutRate = 0.4;
        break;
      case 4:
        // Lying transient on the last allowed attempt: retries exhaust to
        // FAILED while the confirmation is still in flight, -> FAILED:ASYNC_CONFIRM.
        bankConfig.transientRejectRate = 0.5;
        bankConfig.lyingTransientRate = 0.9;
        break;
      case 5:
        // More payments reach UNKNOWN at all, with slow notifications.
        bankConfig.timeoutRate = 0.4;
        bankConfig.asyncDelayChecks = 3;
        break;
    }
  }

  const runnerConfig: RunnerConfig = {
    ...DEFAULT_RUNNER_CONFIG,
    // Use the real settle window (DEFAULT_RUNNER_CONFIG): a zero window meant
    // the "wait, then resend" branch never ran in any scenario.
    ...(opts.runnerConfig ?? {}),
  };

  return {
    seed,
    distribution: {
      id: distributionId,
      totalCents,
      allocations: [], // filled by buildDistribution() after allocation
      createdAt: 0,
    },
    allocationInputs,
    bankConfig,
    runnerConfig,
    crashAt: opts.crashAt,
  };
}

/**
 * Finalise the scenario by running allocation and attaching the results
 * to the distribution. Called by the harness runner after generate().
 */
export async function buildDistribution(scenario: Scenario): Promise<Scenario> {
  const { allocate } = await import("../src/core/allocation.js");
  const allocated = allocate(scenario.distribution.totalCents, scenario.allocationInputs);
  return {
    ...scenario,
    distribution: {
      ...scenario.distribution,
      allocations: allocated,
    },
  };
}
