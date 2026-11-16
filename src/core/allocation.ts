/**
 * Allocation: distribute a total amount (integer cents) across investors
 * pro rata by their basis units.
 *
 * Algorithm (agreed-decisions.md #9):
 *   1. Compute each investor's exact share = totalCents * (basis / sumBasis).
 *   2. Floor each share to cents.
 *   3. Distribute leftover cents (totalCents - sum of floors) one cent at a time
 *      to the investors with the largest fractional remainders.
 *   4. Ties in fractional remainder broken by investorId ascending (lexicographic).
 *
 * Guarantees:
 *   - Sum of all allocations === totalCents exactly.
 *   - No floats in output  -  all values are integer cents.
 *   - Investors with a zero-cent share are included in the output (amount = 0)
 *     so the caller can log them per agreed-decisions.md #13.
 *   - No randomness, no I/O  -  pure function.
 */

import { assertCents } from "./money.js";
import type { AllocationInput, AllocatedPayment, Cents } from "./types.js";

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationError";
  }
}

/**
 * Allocate `totalCents` across `inputs` pro rata by `basisUnits`.
 *
 * @param totalCents  Total distribution amount in integer cents.
 * @param inputs      Each investor with their basis units (must be > 0 for all entries).
 * @returns           One AllocatedPayment per input, in the same order.
 *                    Sum of amountCents === totalCents.
 */
export function allocate(
  totalCents: Cents,
  inputs: AllocationInput[],
): AllocatedPayment[] {
  assertCents(totalCents, "totalCents");

  if (inputs.length === 0) {
    throw new AllocationError("inputs must not be empty");
  }

  for (const { investor, basisUnits } of inputs) {
    if (!Number.isFinite(basisUnits) || basisUnits < 0) {
      throw new AllocationError(
        `investor ${investor.id}: basisUnits must be a non-negative finite number, got ${basisUnits}`,
      );
    }
  }

  const sumBasis = inputs.reduce((acc, i) => acc + i.basisUnits, 0);

  if (sumBasis === 0) {
    // Every investor has zero basis  -  distribute nothing to anyone.
    return inputs.map(({ investor }) => ({ investor, amountCents: 0 }));
  }

  // Step 1 + 2: exact share and floor.
  const working = inputs.map(({ investor, basisUnits }) => {
    const exact = (totalCents * basisUnits) / sumBasis;
    const floored = Math.floor(exact);
    const remainder = exact - floored;
    return { investor, floored, remainder };
  });

  // Step 3: how many leftover cents to distribute?
  const sumFloored = working.reduce((acc, w) => acc + w.floored, 0);
  let leftover = totalCents - sumFloored;

  // Step 4: sort by remainder desc, tie-break by investorId asc.
  const sorted = [...working].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.investor.id < b.investor.id ? -1 : a.investor.id > b.investor.id ? 1 : 0;
  });

  // Distribute leftover cents one at a time to the top-remainder investors.
  const bonusCents = new Map<string, number>();
  for (const w of sorted) {
    if (leftover <= 0) break;
    bonusCents.set(w.investor.id, 1);
    leftover--;
  }

  // Build output in original input order.
  const result: AllocatedPayment[] = working.map(({ investor, floored }) => ({
    investor,
    amountCents: floored + (bonusCents.get(investor.id) ?? 0),
  }));

  // Invariant check: sum must equal totalCents exactly.
  const total = result.reduce((acc, r) => acc + r.amountCents, 0);
  if (total !== totalCents) {
    // Should be unreachable; guard against floating-point edge cases in the algorithm.
    throw new AllocationError(
      `allocation sum ${total} !== totalCents ${totalCents}  -  bug in allocator`,
    );
  }

  return result;
}
