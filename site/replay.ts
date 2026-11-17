/**
 * The replay engine, with no DOM in it.
 *
 * Split out of main.ts so the page's promises are testable in plain Node:
 * "the same seed always gives the same run" and "a break-it flag shows a
 * violated invariant" are assertions, not claims in a README.
 *
 * It runs the real Runner, the real transition table, the in-memory store and
 * the seeded fake bank - the same code the harness grades.
 */

import { Runner } from "../src/core/runner.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import type { FakeBankConfig } from "../src/bank/fakeBank.js";
import { allocate } from "../src/core/allocation.js";
import { reconcile } from "../src/core/reconcile.js";
import { check } from "../harness/check.js";
import type { InvariantViolation } from "../harness/check.js";
import { makeSeededRng, rngFromSeed } from "../harness/generate.js";
import type {
  AllocatedPayment,
  AuditEntry,
  Distribution,
  Investor,
  Payment,
  RunnerConfig,
  RunResult,
} from "../src/core/types.js";
import { DEFAULT_RUNNER_CONFIG } from "../src/core/types.js";

export const BREAK_IT_FLAGS = [
  "skipIntentRecord",
  "timeoutAsFailure",
  "newKeyOnRetry",
  "overwriteConflictingConfirm",
  "resendWithoutStatusCheck",
] as const;

export type BreakItFlag = (typeof BREAK_IT_FLAGS)[number];

export interface ReplayOptions {
  seed: number;
  investors: number;
  totalCents: number;
  bank: FakeBankConfig;
  flag: BreakItFlag | "";
}

/**
 * What the bank actually did for one account, next to what we allocated to it.
 * `paidTimes` is the number of real transfers, which is what makes "paid twice"
 * sayable without trusting our own store: our store can only ever show one
 * payment per investor, however many times the money moved.
 */
export interface SettlementRow {
  account: string;
  investorId: string | null;
  allocatedCents: number;
  paidCents: number;
  paidTimes: number;
}

export interface ReplayOutcome {
  distributionId: string;
  totalAllocatedCents: number;
  result: RunResult;
  payments: Payment[];
  audit: AuditEntry[];
  violations: InvariantViolation[];
  allocations: AllocatedPayment[];
  settlements: SettlementRow[];
}

export function buildDistribution(options: ReplayOptions): Distribution {
  const rng = makeSeededRng(options.seed);
  const inputs = Array.from({ length: options.investors }, (_, index) => {
    const investor: Investor = {
      id: `inv-${index + 1}`,
      name: `Investor ${index + 1}`,
      bankDetails: `routing:${options.seed}:${index + 1}`,
    };
    // Last investor gets zero basis units when there is room, so the page also
    // shows the zero-cent allocation path instead of only happy payments.
    const basisUnits =
      index === options.investors - 1 && options.investors > 3
        ? 0
        : 1 + Math.floor(rng() * 10);
    return { investor, basisUnits };
  });

  return {
    id: `dist-${options.seed}`,
    totalCents: options.totalCents,
    allocations: allocate(options.totalCents, inputs),
    createdAt: 0,
  };
}

export async function replay(options: ReplayOptions): Promise<ReplayOutcome> {
  const distribution = buildDistribution(options);
  const store = new MemoryStore();
  const bank = new FakeBank(rngFromSeed(options.seed + 1), options.bank);

  let now = 0;
  const clock = { now: () => now++, sleep: async (ms: number) => { now += ms; } };

  const config: Partial<RunnerConfig> = { ...DEFAULT_RUNNER_CONFIG };
  if (options.flag !== "") config[options.flag] = true;

  const runner = new Runner({
    store,
    bank,
    clock,
    rng: rngFromSeed(options.seed + 2),
    config,
  });

  const result = await runner.run(distribution);
  const report = reconcile(distribution.id, store, bank, clock.now());
  const totalAllocatedCents = distribution.allocations.reduce((sum, a) => sum + a.amountCents, 0);

  const checkResult = check({
    distributionId: distribution.id,
    store,
    bank,
    report,
    totalAllocatedCents,
  });

  return {
    distributionId: distribution.id,
    totalAllocatedCents,
    result,
    payments: store.listPayments(distribution.id),
    audit: store.listAudit(distribution.id),
    violations: checkResult.violations,
    allocations: distribution.allocations,
    settlements: buildSettlements(distribution.allocations, bank),
  };
}

/**
 * Join the fund's allocation per bank account to the transfers the bank made.
 * Accounts are sorted so two runs produce identical output (the page's tests
 * compare whole outcomes).
 */
function buildSettlements(
  allocations: AllocatedPayment[],
  bank: FakeBank,
): SettlementRow[] {
  const allocated = new Map<string, { investorId: string; cents: number }>();
  for (const allocation of allocations) {
    const account = allocation.investor.bankDetails;
    const existing = allocated.get(account);
    if (existing) existing.cents += allocation.amountCents;
    else allocated.set(account, { investorId: allocation.investor.id, cents: allocation.amountCents });
  }

  const paid = bank.getSettlementsByAccount?.() ?? new Map();
  const accounts = [...new Set([...allocated.keys(), ...paid.keys()])].sort();

  return accounts.map((account) => {
    const ours = allocated.get(account);
    const theirs = paid.get(account);
    return {
      account,
      investorId: ours?.investorId ?? null,
      allocatedCents: ours?.cents ?? 0,
      paidCents: theirs?.totalCents ?? 0,
      paidTimes: theirs?.sendCount ?? 0,
    };
  });
}
