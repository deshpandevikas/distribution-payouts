/**
 * Property-based invariant tests (I1–I5).
 *
 * Uses fast-check to generate random seeds, runs each scenario through
 * the full pipeline, and asserts all invariants hold.
 *
 * This file is human-owned. Do not edit without explicit instruction.
 * Propose changes in chat.
 *
 * Run: npm test
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Runner, CrashInjected } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { reconcile } from "../src/core/reconcile.js";
import { generate, buildDistribution, rngFromSeed } from "../harness/generate.js";
import { check } from "../harness/check.js";
import type { CrashPoint } from "../src/core/runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runScenarioAndCheck(seed: number, crashAt?: CrashPoint) {
  let scenario = generate(seed, { ...(crashAt !== undefined ? { crashAt } : {}) });
  scenario = await buildDistribution(scenario);

  const store = new MemoryStore();
  const bank = new FakeBank(rngFromSeed(seed + 1), scenario.bankConfig);
  let now = 0;
  const clock = { now: () => now++ };

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
      const runner2 = new Runner({
        store,
        bank,
        clock,
        rng: rngFromSeed(seed + 3),
        config: { ...scenario.runnerConfig },
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

  const totalAllocatedCents = scenario.distribution.allocations.reduce(
    (s, a) => s + a.amountCents,
    0,
  );

  return check({
    distributionId: scenario.distribution.id,
    store,
    bank,
    report,
    totalAllocatedCents,
  });
}

// fast-check seed generator: positive integers up to 100_000.
const seedArb = fc.integer({ min: 1, max: 100_000 });

// ---------------------------------------------------------------------------
// I1: no key settled more than once; no investor paid more than allocated.
// ---------------------------------------------------------------------------

describe("I1: no double-settlement, no over-payment", () => {
  it("holds across random scenarios", async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async (seed) => {
        const result = await runScenarioAndCheck(seed);
        const i1 = result.violations.filter((v) => v.invariant === "I1");
        expect(i1, `seed=${seed} violations: ${i1.map((v) => v.detail).join("; ")}`).toHaveLength(0);
      }),
      { numRuns: 200, seed: 42 },
    );
  });
});

// ---------------------------------------------------------------------------
// I2: after drain, no payment in SENDING or UNKNOWN.
// ---------------------------------------------------------------------------

describe("I2: no stuck payments after drain", () => {
  it("holds across random scenarios", async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async (seed) => {
        const result = await runScenarioAndCheck(seed);
        const i2 = result.violations.filter((v) => v.invariant === "I2");
        expect(i2, `seed=${seed} violations: ${i2.map((v) => v.detail).join("; ")}`).toHaveLength(0);
      }),
      { numRuns: 200, seed: 42 },
    );
  });
});

// ---------------------------------------------------------------------------
// I3: allocations sum exactly to total; confirmed + failed + manual = total.
// ---------------------------------------------------------------------------

describe("I3: allocation and state totals are exact", () => {
  it("holds across random scenarios", async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async (seed) => {
        const result = await runScenarioAndCheck(seed);
        const i3 = result.violations.filter((v) => v.invariant === "I3");
        expect(i3, `seed=${seed} violations: ${i3.map((v) => v.detail).join("; ")}`).toHaveLength(0);
      }),
      { numRuns: 200, seed: 42 },
    );
  });
});

// ---------------------------------------------------------------------------
// I4: our CONFIRMED set === bank's settled set, except MANUAL_REVIEW in report.
// ---------------------------------------------------------------------------

describe("I4: confirmed set matches bank settled set", () => {
  it("holds across random scenarios", async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async (seed) => {
        const result = await runScenarioAndCheck(seed);
        const i4 = result.violations.filter((v) => v.invariant === "I4");
        expect(i4, `seed=${seed} violations: ${i4.map((v) => v.detail).join("; ")}`).toHaveLength(0);
      }),
      { numRuns: 200, seed: 42 },
    );
  });
});

// ---------------------------------------------------------------------------
// I5: every state change has an audit entry; every transition is legal.
// ---------------------------------------------------------------------------

describe("I5: audit log is complete and all transitions are legal", () => {
  it("holds across random scenarios", async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async (seed) => {
        const result = await runScenarioAndCheck(seed);
        const i5 = result.violations.filter((v) => v.invariant === "I5");
        expect(i5, `seed=${seed} violations: ${i5.map((v) => v.detail).join("; ")}`).toHaveLength(0);
      }),
      { numRuns: 200, seed: 42 },
    );
  });
});

// ---------------------------------------------------------------------------
// I1 + I3 + I5 hold with status query OFF (I2 allows more MANUAL_REVIEW).
// ---------------------------------------------------------------------------

describe("I1, I3, I5 hold with bank status query OFF", () => {
  it("holds across random scenarios", async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async (seed) => {
        let scenario = generate(seed, { bankConfig: { statusQueryEnabled: false } });
        scenario = await buildDistribution(scenario);

        const store = new MemoryStore();
        const bank = new FakeBank(rngFromSeed(seed + 1), scenario.bankConfig);
        let now = 0;
        const clock = { now: () => now++ };

        const runner = new Runner({
          store,
          bank,
          clock,
          rng: rngFromSeed(seed + 2),
          config: scenario.runnerConfig,
        });

        await runner.run(scenario.distribution);

        const report = reconcile(scenario.distribution.id, store, bank, clock.now());
        const totalAllocatedCents = scenario.distribution.allocations.reduce(
          (s, a) => s + a.amountCents, 0,
        );

        const result = check({
          distributionId: scenario.distribution.id,
          store,
          bank,
          report,
          totalAllocatedCents,
        });

        const relevant = result.violations.filter((v) =>
          v.invariant === "I1" || v.invariant === "I3" || v.invariant === "I5",
        );
        expect(
          relevant,
          `seed=${seed} violations: ${relevant.map((v) => v.detail).join("; ")}`,
        ).toHaveLength(0);
      }),
      { numRuns: 200, seed: 42 },
    );
  });
});

// ---------------------------------------------------------------------------
// Crash + restart: invariants hold after crash injection at each point.
// ---------------------------------------------------------------------------

describe("invariants hold after crash and restart", () => {
  const crashPoints: CrashPoint[] = [
    "afterIntentRecorded",
    "afterBankCallBeforeRecord",
    "duringStatusCheck",
  ];

  for (const point of crashPoints) {
    it(`holds after crash at ${point}`, async () => {
      await fc.assert(
        fc.asyncProperty(seedArb, async (seed) => {
          const result = await runScenarioAndCheck(seed, point);
          const violations = result.violations;
          expect(
            violations,
            `seed=${seed} crashAt=${point} violations: ${violations.map((v) => `[${v.invariant}] ${v.detail}`).join("; ")}`,
          ).toHaveLength(0);
        }),
        { numRuns: 100, seed: 42 },
      );
    });
  }
});
