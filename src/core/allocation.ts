/**
 * Allocation: distribute a total amount (integer cents) across investors
 * pro rata by their basis units.
 *
 * Algorithm:
 *   1. Compute floor = floor(totalCents * basisUnits / sumBasis) using integer division.
 *   2. Compute remainder = (totalCents * basisUnits) % sumBasis (integer, no float).
 *   3. Distribute leftover cents one at a time to investors with the largest remainders.
 *   4. Ties broken by investorId ascending (lexicographic).
 *
 * All arithmetic uses BigInt to avoid float rounding on large totals * large bases.
 *
 * Guarantees:
 *   - Sum of all allocations === totalCents exactly.
 *   - No floats in output - all values are integer cents.
 *   - Throws AllocationError on empty inputs, negative basis, duplicate ids,
 *     or all-zero basis with nonzero total (money would vanish silently).
 *   - Zero-cent shares stay in the output so the split can be logged and summed.
 *   - No randomness, no I/O - pure function.
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
 * @param inputs      Each investor with their basis units.
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

  // Validate basis units and collect unique id check.
  const seenIds = new Set<string>();
  for (const { investor, basisUnits } of inputs) {
    if (!Number.isFinite(basisUnits) || basisUnits < 0) {
      throw new AllocationError(
        `investor ${investor.id}: basisUnits must be a non-negative finite number, got ${basisUnits}`,
      );
    }
    if (!Number.isInteger(basisUnits)) {
      throw new AllocationError(
        `investor ${investor.id}: basisUnits must be an integer, got ${basisUnits}`,
      );
    }
    if (seenIds.has(investor.id)) {
      throw new AllocationError(
        `duplicate investor id: ${investor.id}`,
      );
    }
    seenIds.add(investor.id);
  }

  const sumBasis = inputs.reduce((acc, i) => acc + i.basisUnits, 0);

  if (sumBasis === 0) {
    if (totalCents > 0) {
      throw new AllocationError(
        `all investors have zero basis units but totalCents is ${totalCents} - money would vanish`,
      );
    }
    // totalCents === 0: nothing to distribute, zero for everyone.
    return inputs.map(({ investor }) => ({ investor, amountCents: 0 }));
  }

  // Use BigInt for integer division to avoid float rounding.
  const bigTotal = BigInt(totalCents);
  const bigSum = BigInt(sumBasis);

  const working = inputs.map(({ investor, basisUnits }) => {
    const bigBasis = BigInt(basisUnits);
    const product = bigTotal * bigBasis;
    const floored = Number(product / bigSum);       // safe: <= totalCents <= MAX_SAFE_INTEGER
    const remainder = Number(product % bigSum);     // safe: < sumBasis
    return { investor, floored, remainder };
  });

  // Distribute leftover cents: sort by remainder desc, tie-break by investorId asc.
  const sumFloored = working.reduce((acc, w) => acc + w.floored, 0);
  let leftover = totalCents - sumFloored;

  const sorted = [...working].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.investor.id < b.investor.id ? -1 : a.investor.id > b.investor.id ? 1 : 0;
  });

  const bonusCents = new Map<string, number>();
  for (const w of sorted) {
    if (leftover <= 0) break;
    bonusCents.set(w.investor.id, 1);
    leftover--;
  }

  const result: AllocatedPayment[] = working.map(({ investor, floored }) => ({
    investor,
    amountCents: floored + (bonusCents.get(investor.id) ?? 0),
  }));

  // Invariant guard.
  const total = result.reduce((acc, r) => acc + r.amountCents, 0);
  if (total !== totalCents) {
    throw new AllocationError(
      `allocation sum ${total} !== totalCents ${totalCents} - bug in allocator`,
    );
  }

  return result;
}
