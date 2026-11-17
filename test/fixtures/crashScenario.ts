/**
 * The one distribution the SQLite crash test uses.
 *
 * Shared by the parent test and the child process so both operate on exactly
 * the same distribution id, investor and idempotency key - the child has to
 * build the same key the parent later looks the payment up by.
 */

import { allocate } from "../../src/core/allocation.js";
import type { Distribution } from "../../src/core/types.js";

export const CRASH_DISTRIBUTION_ID = "dist-crash";
export const CRASH_AMOUNT_CENTS = 250;

export function crashScenario(): Distribution {
  const allocations = allocate(CRASH_AMOUNT_CENTS, [
    {
      investor: {
        id: "inv-crash",
        name: "Crash Investor",
        bankDetails: "routing:crash",
      },
      basisUnits: 1,
    },
  ]);

  return {
    id: CRASH_DISTRIBUTION_ID,
    totalCents: CRASH_AMOUNT_CENTS,
    allocations,
    createdAt: 0,
  };
}
