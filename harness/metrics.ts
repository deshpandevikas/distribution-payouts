/**
 * Harness metrics collection.
 *
 * Aggregates results across multiple scenario runs and prints a summary.
 * Per Phase 1 handoff requirements:
 *   - payments total
 *   - manual-intervention rate (payments that touched MANUAL_REVIEW / total)
 *   - count that hit UNKNOWN at any point
 *   - retries: total and max per payment
 *   - invariant pass/fail per run and overall
 */

import type { Store } from "../src/core/types.js";
import type { CheckResult } from "./check.js";

// ---------------------------------------------------------------------------
// Per-run metrics
// ---------------------------------------------------------------------------

export interface RunMetrics {
  seed: number;
  totalPayments: number;
  confirmedPayments: number;
  failedPayments: number;
  manualReviewPayments: number;
  paymentsHitUnknown: number;
  totalRetries: number;
  maxRetriesPerPayment: number;
  invariantsPassed: boolean;
  violations: string[];
}

export function collectRunMetrics(
  seed: number,
  distributionId: string,
  store: Store,
  checkResult: CheckResult,
): RunMetrics {
  const payments = store.listPayments(distributionId);
  const audit = store.listAudit(distributionId);

  // Count payments that ever entered UNKNOWN by scanning audit log.
  const hitUnknown = new Set<string>();
  let totalRetries = 0;
  const retriesByPayment = new Map<string, number>();

  for (const entry of audit) {
    if (entry.toState === "UNKNOWN") {
      hitUnknown.add(entry.paymentId);
    }
    // Count transient retries: SENDING->SENDING transitions.
    if (entry.fromState === "SENDING" && entry.toState === "SENDING") {
      retriesByPayment.set(entry.paymentId, (retriesByPayment.get(entry.paymentId) ?? 0) + 1);
      totalRetries++;
    }
  }

  const maxRetriesPerPayment = retriesByPayment.size > 0
    ? Math.max(...retriesByPayment.values())
    : 0;

  let confirmed = 0, failed = 0, manual = 0;
  for (const p of payments) {
    if (p.state === "CONFIRMED") confirmed++;
    else if (p.state === "FAILED") failed++;
    else if (p.state === "MANUAL_REVIEW") manual++;
  }

  return {
    seed,
    totalPayments: payments.length,
    confirmedPayments: confirmed,
    failedPayments: failed,
    manualReviewPayments: manual,
    paymentsHitUnknown: hitUnknown.size,
    totalRetries,
    maxRetriesPerPayment,
    invariantsPassed: checkResult.passed,
    violations: checkResult.violations.map((v) => `[${v.invariant}] ${v.detail}`),
  };
}

// ---------------------------------------------------------------------------
// Aggregate metrics across all runs
// ---------------------------------------------------------------------------

export interface AggregateMetrics {
  totalScenarios: number;
  totalPayments: number;
  totalConfirmed: number;
  totalFailed: number;
  totalManualReview: number;
  totalHitUnknown: number;
  totalRetries: number;
  maxRetriesAcrossAllRuns: number;
  manualInterventionRate: number;
  invariantPassRate: number;
  failedScenarios: number;
  failedSeeds: number[];
}

export function aggregate(runs: RunMetrics[]): AggregateMetrics {
  if (runs.length === 0) {
    return {
      totalScenarios: 0,
      totalPayments: 0,
      totalConfirmed: 0,
      totalFailed: 0,
      totalManualReview: 0,
      totalHitUnknown: 0,
      totalRetries: 0,
      maxRetriesAcrossAllRuns: 0,
      manualInterventionRate: 0,
      invariantPassRate: 0,
      failedScenarios: 0,
      failedSeeds: [],
    };
  }

  const totalPayments = runs.reduce((s, r) => s + r.totalPayments, 0);
  const totalManualReview = runs.reduce((s, r) => s + r.manualReviewPayments, 0);
  const failedScenarios = runs.filter((r) => !r.invariantsPassed).length;

  return {
    totalScenarios: runs.length,
    totalPayments,
    totalConfirmed: runs.reduce((s, r) => s + r.confirmedPayments, 0),
    totalFailed: runs.reduce((s, r) => s + r.failedPayments, 0),
    totalManualReview,
    totalHitUnknown: runs.reduce((s, r) => s + r.paymentsHitUnknown, 0),
    totalRetries: runs.reduce((s, r) => s + r.totalRetries, 0),
    maxRetriesAcrossAllRuns: Math.max(...runs.map((r) => r.maxRetriesPerPayment)),
    manualInterventionRate: totalPayments > 0 ? totalManualReview / totalPayments : 0,
    invariantPassRate: (runs.length - failedScenarios) / runs.length,
    failedScenarios,
    failedSeeds: runs.filter((r) => !r.invariantsPassed).map((r) => r.seed),
  };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export function printRunMetrics(m: RunMetrics): void {
  const status = m.invariantsPassed ? "✓ PASS" : "✗ FAIL";
  console.log(
    `  seed=${m.seed} ${status} payments=${m.totalPayments}` +
    ` confirmed=${m.confirmedPayments} failed=${m.failedPayments}` +
    ` manual=${m.manualReviewPayments} unknown=${m.paymentsHitUnknown}` +
    ` retries=${m.totalRetries} maxRetries=${m.maxRetriesPerPayment}`,
  );
  for (const v of m.violations) {
    console.log(`    VIOLATION: ${v}`);
  }
}

export function printAggregate(m: AggregateMetrics): void {
  console.log("\n=== Harness Summary ===");
  console.log(`Scenarios:            ${m.totalScenarios}`);
  console.log(`Total payments:       ${m.totalPayments}`);
  console.log(`  Confirmed:          ${m.totalConfirmed}`);
  console.log(`  Failed:             ${m.totalFailed}`);
  console.log(`  Manual review:      ${m.totalManualReview}`);
  console.log(`  Hit UNKNOWN:        ${m.totalHitUnknown}`);
  console.log(`Total retries:        ${m.totalRetries}`);
  console.log(`Max retries (single): ${m.maxRetriesAcrossAllRuns}`);
  console.log(`Manual rate:          ${(m.manualInterventionRate * 100).toFixed(2)}%`);
  console.log(`Invariant pass rate:  ${(m.invariantPassRate * 100).toFixed(2)}%`);
  if (m.failedScenarios > 0) {
    console.log(`\nFAILED SCENARIOS (${m.failedScenarios}):`);
    for (const seed of m.failedSeeds) {
      console.log(`  seed=${seed}`);
    }
  }
  console.log("======================\n");
}

// ---------------------------------------------------------------------------
// Grid coverage: (state x event) hit counts across all runs
// ---------------------------------------------------------------------------

import type { PaymentState, PaymentEvent } from "../src/core/types.js";

export type GridCellKey = `${PaymentState}:${PaymentEvent["type"]}`;
export type GridCoverage = Map<GridCellKey, number>;

/**
 * Collect grid coverage from a single run's audit log.
 * Each audit entry records (fromState, event)  -  that's one cell exercised.
 */
export function collectGridCoverage(
  distributionId: string,
  store: Store,
): GridCoverage {
  const coverage: GridCoverage = new Map();
  for (const entry of store.listAudit(distributionId)) {
    const key: GridCellKey = `${entry.fromState}:${entry.event}`;
    coverage.set(key, (coverage.get(key) ?? 0) + 1);
  }
  return coverage;
}

/**
 * Merge per-run coverage maps into one aggregate.
 */
export function mergeGridCoverage(maps: GridCoverage[]): GridCoverage {
  const merged: GridCoverage = new Map();
  for (const m of maps) {
    for (const [key, count] of m) {
      merged.set(key, (merged.get(key) ?? 0) + count);
    }
  }
  return merged;
}

/**
 * All (state, event) cells that the break-it flags rely on being exercised.
 * A flag whose target cell was never hit is a coverage gap, not a real test.
 */
export const BREAK_IT_REQUIRED_CELLS: Record<string, GridCellKey[]> = {
  skipIntentRecord:            ["CREATED:SEND_INTENT_RECORDED"],
  // timeoutAsFailure converts BANK_TIMEOUT to BANK_REJECTED_PERMANENT before applyEvent,
  // so SENDING:BANK_TIMEOUT never appears in audit. Check the downstream cell instead.
  timeoutAsFailure:            ["SENDING:BANK_REJECTED_PERMANENT"],
  newKeyOnRetry:               ["SENDING:BANK_REJECTED_TRANSIENT"],
  // overwriteConflictingConfirm bypasses applyEvent on FAILED:ASYNC_CONFIRM  -  that cell
  // never appears in audit by design. Check transient retries as proof of scenario coverage.
  overwriteConflictingConfirm: ["SENDING:BANK_REJECTED_TRANSIENT"],
  resendWithoutStatusCheck:    ["UNKNOWN:BANK_TIMEOUT"],
};

/**
 * Check whether required cells for a break-it flag were exercised.
 * Returns names of flags whose required cells were never hit (coverage gaps).
 */
export function findCoverageGaps(
  coverage: GridCoverage,
  activeFlags: string[],
): string[] {
  const gaps: string[] = [];
  for (const flag of activeFlags) {
    const required = BREAK_IT_REQUIRED_CELLS[flag] ?? [];
    const allHit = required.every((cell) => (coverage.get(cell) ?? 0) > 0);
    if (!allHit) {
      const missing = required.filter((c) => (coverage.get(c) ?? 0) === 0);
      gaps.push(`${flag}: cells never exercised: ${missing.join(", ")}`);
    }
  }
  return gaps;
}

export function printGridCoverage(coverage: GridCoverage, activeFlags: string[]): void {
  console.log("\n=== Grid Coverage ===");
  const sorted = [...coverage.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [cell, count] of sorted) {
    console.log(`  ${cell.padEnd(45)} ${count}`);
  }

  const gaps = findCoverageGaps(coverage, activeFlags);
  if (gaps.length > 0) {
    console.log("\n⚠ COVERAGE GAPS (break-it flag never exercised its target cell):");
    for (const g of gaps) {
      console.log(`  ${g}`);
    }
  } else if (activeFlags.length > 0) {
    console.log("\n✓ All break-it flag target cells were exercised.");
  }
  console.log("=====================\n");
}
