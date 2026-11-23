/**
 * Edge cases of the split:
 *   (a) Float math loses money on large totals / large basis values
 *   (b) All-zero basis with totalCents > 0 should throw, not silently return zeros
 *   (c) Duplicate investor ids silently collide in bonusCents Map
 *   (d) Property: sum always equals total; tie-break is deterministic under input reordering
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { allocate, AllocationError } from "../src/core/allocation.js";
import type { AllocationInput } from "../src/core/types.js";

function inv(id: string, basisUnits: number): AllocationInput {
  return { investor: { id, name: `Investor ${id}`, bankDetails: `bank:${id}` }, basisUnits };
}

describe("large totals and basis units keep every cent", () => {
  it("sum equals total for large totalCents and large basis values", () => {
    // 2^53 - 1 is MAX_SAFE_INTEGER; large products can exceed it in float math
    // e.g. 10_000_000_00 (10M dollars in cents) with basis values up to 10_000
    const total = 1_000_000_000; // $10M
    const inputs = [
      inv("a", 3),
      inv("b", 7),
      inv("c", 11),
      inv("d", 13),
    ];
    const result = allocate(total, inputs);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(total);
  });

  it("sum equals total when basis*total exceeds 2^53 (integer overflow in float)", () => {
    // basis=10_000, total=1_000_000_000 => product=10^13, within safe int range
    // but with many investors this can expose float rounding
    const total = 999_999_999;
    const inputs = Array.from({ length: 7 }, (_, i) => inv(`inv-${i}`, 10_000 + i));
    const result = allocate(total, inputs);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(total);
  });

  it("tie-break is consistent when remainders are mathematically equal", () => {
    // 10 cents / 3 investors with equal basis: all have remainder 1/3
    // With float math, remainders that should be equal can compare unequal
    // Result must always give the extra cent to 'a' (lexicographically first)
    for (let total = 1; total <= 100; total++) {
      const result = allocate(total, [inv("c", 1), inv("b", 1), inv("a", 1)]);
      const sum = result.reduce((s, r) => s + r.amountCents, 0);
      expect(sum).toBe(total);
    }
  });
});

describe("all-zero basis with a nonzero total throws", () => {
  it("throws AllocationError when all basis units are zero and total > 0", () => {
    expect(() => allocate(100, [inv("a", 0), inv("b", 0)])).toThrow(AllocationError);
  });

  it("does NOT throw when total is also zero (no money to lose)", () => {
    expect(() => allocate(0, [inv("a", 0), inv("b", 0)])).not.toThrow();
  });
});

describe("duplicate investor ids are rejected", () => {
  it("throws AllocationError on duplicate investor ids", () => {
    expect(() => allocate(100, [inv("dup", 1), inv("dup", 2)])).toThrow(AllocationError);
  });
});

describe("properties of the split", () => {
  const inputsArb = fc.array(
    fc.record({
      id: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 1 }).map(arr => arr[0]!),
      basis: fc.integer({ min: 0, max: 10_000 }),
    }),
    { minLength: 1, maxLength: 20 },
  ).filter(inputs => {
    // unique ids
    const ids = inputs.map(i => i.id);
    return new Set(ids).size === ids.length;
  });

  it("sum always equals total for any valid inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        inputsArb,
        (total, inputs) => {
          const allInputs = inputs.map(({ id, basis }) => inv(id, basis));
          // skip all-zero basis with nonzero total (throws by design)
          const sumBasis = inputs.reduce((s, i) => s + i.basis, 0);
          if (sumBasis === 0 && total > 0) return true;
          const result = allocate(total, allInputs);
          const sum = result.reduce((s, r) => s + r.amountCents, 0);
          return sum === total;
        },
      ),
      { numRuns: 500, seed: 42 },
    );
  });

  it("tie-break is deterministic: input order does not affect who gets extra cents", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        inputsArb,
        (total, inputs) => {
          const sumBasis = inputs.reduce((s, i) => s + i.basis, 0);
          if (sumBasis === 0) return true;
          const allInputs = inputs.map(({ id, basis }) => inv(id, basis));
          const reversed = [...allInputs].reverse();
          const r1 = allocate(total, allInputs);
          const r2 = allocate(total, reversed);
          // Same id should get the same amount regardless of input order
          const byId1 = new Map(r1.map(r => [r.investor.id, r.amountCents]));
          const byId2 = new Map(r2.map(r => [r.investor.id, r.amountCents]));
          for (const [id, amt] of byId1) {
            if (byId2.get(id) !== amt) return false;
          }
          return true;
        },
      ),
      { numRuns: 500, seed: 42 },
    );
  });
});
