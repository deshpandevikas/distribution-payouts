/**
 * Money helpers: integer cents only, USD.
 * All amounts in this codebase are number (integer cents, safe-integer checked).
 * Never floats. No other currency.
 */

export function assertCents(value: number, label = "amount"): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer (cents), got ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`${label} must be non-negative cents, got ${value}`);
  }
}

/** Format cents as a human-readable USD string (for logs only; never parse this back). */
export function centsToDisplay(cents: number): string {
  assertCents(cents);
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return `$${dollars}.${String(rem).padStart(2, "0")}`;
}
