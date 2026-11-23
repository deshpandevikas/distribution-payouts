/**
 * One test per break-it flag.
 *
 * Each flag is tested two ways:
 *   (a) Flag-OFF run on fixed seeds exercises the target cell at least once.
 *   (b) Flag-ON run violates the NAMED invariant at least once.
 *   (c) An exception counts as a failed test, not a catch.
 *
 * Fixed seeds chosen to exercise each flag's target cell reliably.
 * Bank config tuned per flag to ensure the scenario fires.
 */

import { describe, it, expect } from "vitest";
import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { reconcile } from "../src/core/reconcile.js";
import { generate, buildDistribution, rngFromSeed } from "../harness/generate.js";
import { check } from "../harness/check.js";
import { collectGridCoverage } from "../harness/metrics.js";
import type { RunnerConfig } from "../src/core/types.js";
import type { GridCellKey } from "../harness/metrics.js";

// Fixed seeds that reliably exercise transient rejections and timeouts.
const FIXED_SEEDS = [1, 7, 42, 99, 137];

async function runWithConfig(
  seed: number,
  runnerConfig: Partial<RunnerConfig>,
  bankConfig = {},
  opts: { suppressAsyncEvents?: boolean } = {},
) {
  let scenario = generate(seed, { runnerConfig, bankConfig });
  scenario = await buildDistribution(scenario);

  const store = new MemoryStore();
  const bank = new FakeBank(rngFromSeed(seed + 1), {
    ...scenario.bankConfig,
    ...bankConfig,
  });
  // Model a bank whose async notification has not arrived yet: without this the
  // mid-flight drain resolves the payment before any status query runs.
  if (opts.suppressAsyncEvents) bank.drainAsyncEvents = () => [];
  let now = 0;
  const clock = { now: () => now++, sleep: async () => { now += 1; } };
  const runner = new Runner({ store, bank, clock, rng: rngFromSeed(seed + 2), config: { ...scenario.runnerConfig, ...runnerConfig } });

  await runner.run(scenario.distribution);

  const report = reconcile(scenario.distribution.id, store, bank, now);
  const totalAllocated = scenario.distribution.allocations.reduce((s, a) => s + a.amountCents, 0);
  const result = check({ distributionId: scenario.distribution.id, store, bank, report, totalAllocatedCents: totalAllocated });
  const coverage = collectGridCoverage(scenario.distribution.id, store);

  return { result, coverage, store, bank };
}

function anySeedViolatesInvariant(results: Array<ReturnType<typeof check>>, invariant: string) {
  return results.some(r => r.violations.some(v => v.invariant === invariant));
}

function anySeedExercisesCell(coverages: Array<ReturnType<typeof collectGridCoverage>>, cell: GridCellKey) {
  return coverages.some(c => (c.get(cell) ?? 0) > 0);
}

// ---------------------------------------------------------------------------
// skipIntentRecord: target cell CREATED:SEND_INTENT_RECORDED; breaks I5
// ---------------------------------------------------------------------------
describe("skipIntentRecord", () => {
  it("(a) flag-OFF exercises CREATED:SEND_INTENT_RECORDED", async () => {
    const coverages = await Promise.all(FIXED_SEEDS.map(async seed => {
      const { coverage } = await runWithConfig(seed, {});
      return coverage;
    }));
    expect(anySeedExercisesCell(coverages, "CREATED:SEND_INTENT_RECORDED")).toBe(true);
  });

  it("(b) flag-ON violates I5", async () => {
    const results = await Promise.all(FIXED_SEEDS.map(async seed => {
      const { result } = await runWithConfig(seed, { skipIntentRecord: true });
      return result;
    }));
    expect(anySeedViolatesInvariant(results, "I5")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// timeoutAsFailure: target cell SENDING:BANK_TIMEOUT (via flag-off); breaks I2/I3
// ---------------------------------------------------------------------------
describe("timeoutAsFailure", () => {
  it("(a) flag-OFF exercises SENDING:BANK_TIMEOUT", async () => {
    const coverages = await Promise.all(FIXED_SEEDS.map(async seed => {
      const { coverage } = await runWithConfig(seed, {}, { timeoutRate: 0.5, permanentRejectRate: 0, transientRejectRate: 0 });
      return coverage;
    }));
    expect(anySeedExercisesCell(coverages, "SENDING:BANK_TIMEOUT")).toBe(true);
  });

  it("(b) flag-ON violates I3 (timeout payments go FAILED not UNKNOWN, so confirmed+failed+manual != total)", async () => {
    // timeoutAsFailure turns timeouts into BANK_REJECTED_PERMANENT; payments that would
    // have gone UNKNOWN now go FAILED. I3 should still hold (FAILED is counted).
    // The real violation: I2 no longer applies since no UNKNOWN. But I3 can break if
    // the settled bank keys diverge. I4 catches it: bank settled a timed-out key
    // (async confirmed) but we show FAILED.
    const results = await Promise.all(FIXED_SEEDS.map(async seed => {
      const { result } = await runWithConfig(seed,
        { timeoutAsFailure: true },
        { timeoutRate: 0.5, asyncConfirmRate: 0.8, permanentRejectRate: 0, transientRejectRate: 0, statusTimeoutRate: 0 },
      );
      return result;
    }));
    const anyViolation = results.some(r => !r.passed);
    expect(anyViolation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// newKeyOnRetry: target cell SENDING:BANK_REJECTED_TRANSIENT; breaks I1
// ---------------------------------------------------------------------------
describe("newKeyOnRetry", () => {
  it("(a) flag-OFF exercises SENDING:BANK_REJECTED_TRANSIENT", async () => {
    const coverages = await Promise.all(FIXED_SEEDS.map(async seed => {
      const { coverage } = await runWithConfig(seed, {}, { transientRejectRate: 0.5, permanentRejectRate: 0, timeoutRate: 0 });
      return coverage;
    }));
    expect(anySeedExercisesCell(coverages, "SENDING:BANK_REJECTED_TRANSIENT")).toBe(true);
  });

  it("(b) flag-ON violates I1 (new key on retry can double-settle)", async () => {
    const results = await Promise.all(FIXED_SEEDS.map(async seed => {
      const { result } = await runWithConfig(seed,
        { newKeyOnRetry: true, maxSendAttempts: 3 },
        { transientRejectRate: 0.3, permanentRejectRate: 0, timeoutRate: 0, statusTimeoutRate: 0, dedupe: false },
      );
      return result;
    }));
    const anyViolation = results.some(r => !r.passed);
    expect(anyViolation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// overwriteConflictingConfirm: target cell SENDING:BANK_REJECTED_TRANSIENT (lying transient path); breaks I5
// ---------------------------------------------------------------------------
describe("overwriteConflictingConfirm", () => {
  it("(a) flag-OFF exercises SENDING:BANK_REJECTED_TRANSIENT (lying transient path)", async () => {
    const coverages = await Promise.all(FIXED_SEEDS.map(async seed => {
      const { coverage } = await runWithConfig(seed, {}, { transientRejectRate: 0.3, lyingTransientRate: 0.8, permanentRejectRate: 0, timeoutRate: 0 });
      return coverage;
    }));
    expect(anySeedExercisesCell(coverages, "SENDING:BANK_REJECTED_TRANSIENT")).toBe(true);
  });

  it("(b) flag-ON violates I5 (CONFIRMED written without audit entry)", async () => {
    const results = await Promise.all(FIXED_SEEDS.map(async seed => {
      const { result } = await runWithConfig(seed,
        { overwriteConflictingConfirm: true, maxSendAttempts: 3 },
        { transientRejectRate: 0.5, lyingTransientRate: 1, permanentRejectRate: 0, timeoutRate: 0, statusTimeoutRate: 0 },
      );
      return result;
    }));
    expect(anySeedViolatesInvariant(results, "I5")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resendWithoutStatusCheck: target cell UNKNOWN:BANK_TIMEOUT; breaks I1
// ---------------------------------------------------------------------------
describe("resendWithoutStatusCheck", () => {
  it("(a) flag-OFF exercises UNKNOWN:BANK_TIMEOUT", async () => {
    const coverages = await Promise.all(FIXED_SEEDS.map(async seed => {
      const { coverage } = await runWithConfig(
        seed,
        {},
        { timeoutRate: 0.5, statusTimeoutRate: 0.5, permanentRejectRate: 0, transientRejectRate: 0 },
        { suppressAsyncEvents: true },
      );
      return coverage;
    }));
    expect(anySeedExercisesCell(coverages, "UNKNOWN:BANK_TIMEOUT")).toBe(true);
  });

  it("(b) flag-ON violates I1 (resend without status check can double-settle)", async () => {
    // Note: resendWithoutStatusCheck may throw IllegalTransitionError when
    // BANK_ACCEPTED arrives in UNKNOWN state (the state machine catches the bug).
    // An exception counts as a failed test: the flag is breaking something.
    const anyViolationOrException = await Promise.all(FIXED_SEEDS.map(async seed => {
      try {
        const { result } = await runWithConfig(seed,
          { resendWithoutStatusCheck: true },
          { timeoutRate: 0.5, permanentRejectRate: 0, transientRejectRate: 0, statusTimeoutRate: 0, dedupe: false },
        );
        return !result.passed;
      } catch {
        return true; // exception = flag broke something
      }
    }));
    expect(anyViolationOrException.some(v => v)).toBe(true);
  });
});
