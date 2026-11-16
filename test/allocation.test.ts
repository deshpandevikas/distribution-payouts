import { describe, it, expect } from "vitest";
import { allocate, AllocationError } from "../src/core/allocation.js";
import type { AllocationInput } from "../src/core/types.js";

function inv(id: string, basisUnits: number): AllocationInput {
  return { investor: { id, name: `Investor ${id}`, bankDetails: `bank:${id}` }, basisUnits };
}

describe("allocate", () => {
  it("distributes a whole-dollar amount evenly", () => {
    const result = allocate(300, [inv("a", 1), inv("b", 1), inv("c", 1)]);
    expect(result.map((r) => r.amountCents)).toEqual([100, 100, 100]);
  });

  it("sums to totalCents exactly", () => {
    // 100 cents across 3 investors  -  largest-remainder gives one investor 34¢
    const result = allocate(100, [inv("a", 1), inv("b", 1), inv("c", 1)]);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(100);
  });

  it("floors and uses largest remainder for leftover", () => {
    // 10 cents, 3 investors with equal basis: floors are 3,3,3 leftover 1
    // first investor (sorted by remainder, then id asc) gets the extra cent
    const result = allocate(10, [inv("a", 1), inv("b", 1), inv("c", 1)]);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(10);
    // exactly one investor got an extra cent
    const extras = result.filter((r) => r.amountCents === 4);
    expect(extras).toHaveLength(1);
  });

  it("tie-breaks by investorId ascending (lexicographic)", () => {
    // All three have identical basis and identical remainder  -  id 'a' wins the extra cent
    const result = allocate(10, [inv("c", 1), inv("b", 1), inv("a", 1)]);
    const byId = Object.fromEntries(result.map((r) => [r.investor.id, r.amountCents]));
    // sum must be 10; 'a' should get the tie-broken extra cent
    expect(byId["a"]).toBe(4);
    expect((byId["b"] ?? 0) + (byId["c"] ?? 0)).toBe(6);
  });

  it("handles unequal basis units", () => {
    // investor a: 3/4 of 100 = 75, investor b: 1/4 of 100 = 25
    const result = allocate(100, [inv("a", 3), inv("b", 1)]);
    const byId = Object.fromEntries(result.map((r) => [r.investor.id, r.amountCents]));
    expect(byId["a"]).toBe(75);
    expect(byId["b"]).toBe(25);
  });

  it("includes zero-cent allocations in output", () => {
    // investor b has 0 basis  -  gets 0 cents but must appear in output
    const result = allocate(100, [inv("a", 1), inv("b", 0)]);
    expect(result).toHaveLength(2);
    const byId = Object.fromEntries(result.map((r) => [r.investor.id, r.amountCents]));
    expect(byId["b"]).toBe(0);
    expect(byId["a"]).toBe(100);
  });

  it("throws when all basis are zero and total > 0", () => {
    expect(() => allocate(100, [inv("a", 0), inv("b", 0)])).toThrow(AllocationError);
  });

  it("does NOT throw when total is also zero (zero basis, zero total)", () => {
    const result = allocate(0, [inv("a", 0), inv("b", 0)]);
    expect(result.every((r) => r.amountCents === 0)).toBe(true);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(0);
  });

  it("handles totalCents = 0", () => {
    const result = allocate(0, [inv("a", 1), inv("b", 2)]);
    expect(result.every((r) => r.amountCents === 0)).toBe(true);
  });

  it("handles single investor gets everything", () => {
    const result = allocate(999, [inv("solo", 1)]);
    expect(result[0]!.amountCents).toBe(999);
  });

  it("throws on empty inputs", () => {
    expect(() => allocate(100, [])).toThrow(AllocationError);
  });

  it("throws on negative basis", () => {
    expect(() => allocate(100, [inv("a", -1)])).toThrow(AllocationError);
  });

  it("preserves input order in output", () => {
    const inputs = [inv("z", 1), inv("m", 1), inv("a", 1)];
    const result = allocate(99, inputs);
    expect(result.map((r) => r.investor.id)).toEqual(["z", "m", "a"]);
  });
});
