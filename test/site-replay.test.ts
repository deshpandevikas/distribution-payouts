/**
 * The page's promises, as tests.
 *
 * site/replay.ts has no DOM, so these run in plain Node: the same seed repeats
 * exactly, a normal run keeps every invariant, and a break-it flag produces a
 * violated invariant (which the page shows in red).
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_FAKE_BANK_CONFIG } from "../src/bank/fakeBank.js";
import { replay } from "../site/replay.js";
import type { ReplayOptions } from "../site/replay.js";

const quietBank: ReplayOptions["bank"] = {
  ...DEFAULT_FAKE_BANK_CONFIG,
  permanentRejectRate: 0,
  transientRejectRate: 0,
  lyingTransientRate: 0,
  timeoutRate: 0,
  statusTimeoutRate: 0,
  asyncConfirmRate: 0.5,
  asyncDropRate: 0,
  asyncDelayChecks: 0,
  lagChecks: 0,
  dedupe: true,
};

const base: ReplayOptions = {
  seed: 42,
  investors: 6,
  totalCents: 60_000,
  bank: quietBank,
  flag: "",
};

describe("site replay", () => {
  it("gives exactly the same run for the same seed", async () => {
    const first = await replay(base);
    const second = await replay(base);

    expect(second.result).toEqual(first.result);
    expect(second.payments).toEqual(first.payments);
    expect(second.audit).toEqual(first.audit);
    expect(second.violations).toEqual(first.violations);
  });

  it("changes the run when the seed changes", async () => {
    const a = await replay(base);
    const b = await replay({ ...base, seed: 43 });
    expect(JSON.stringify(a.payments)).not.toBe(JSON.stringify(b.payments));
  });

  it("keeps every invariant with the bank behaving", async () => {
    const outcome = await replay(base);
    expect(outcome.violations).toEqual([]);
    expect(outcome.result.status).toBe("COMPLETED");
  });

  it("shows a violated invariant when a break-it flag is on", async () => {
    // skipIntentRecord writes no SEND_INTENT_RECORDED audit row, so the first
    // audit entry starts in SENDING instead of CREATED: I5 must catch it without
    // needing any bank failure to line up.
    const outcome = await replay({ ...base, flag: "skipIntentRecord" });

    expect(outcome.violations.length).toBeGreaterThan(0);
    expect(outcome.violations.map((v) => v.invariant)).toContain("I5");
  });
});
