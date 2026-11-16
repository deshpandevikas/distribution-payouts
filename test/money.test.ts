import { describe, it, expect } from "vitest";
import { assertCents, centsToDisplay } from "../src/core/money.js";

describe("assertCents", () => {
  it("accepts valid non-negative integer cents", () => {
    expect(() => assertCents(0)).not.toThrow();
    expect(() => assertCents(1)).not.toThrow();
    expect(() => assertCents(100_000_000)).not.toThrow();
    expect(() => assertCents(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it("rejects floats", () => {
    expect(() => assertCents(1.5)).toThrow(RangeError);
    expect(() => assertCents(0.1)).toThrow(RangeError);
  });

  it("rejects negative values", () => {
    expect(() => assertCents(-1)).toThrow(RangeError);
  });

  it("rejects values beyond MAX_SAFE_INTEGER", () => {
    expect(() => assertCents(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe("centsToDisplay", () => {
  it("formats zero", () => {
    expect(centsToDisplay(0)).toBe("$0.00");
  });

  it("formats whole dollars", () => {
    expect(centsToDisplay(100)).toBe("$1.00");
    expect(centsToDisplay(10000)).toBe("$100.00");
  });

  it("pads single-digit cents", () => {
    expect(centsToDisplay(101)).toBe("$1.01");
    expect(centsToDisplay(109)).toBe("$1.09");
  });
});
