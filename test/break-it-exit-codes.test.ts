/**
 * The CI break-it step must fail for every flag, with a named invariant.
 * invariant violation and exit code 1 - never a crash.
 *
 * ci.yml runs, once per flag:
 *
 *   npm run harness -- --scenarios=50 --break-it=$flag
 *
 * A flag that breaks nothing would otherwise exit 0 and pass CI. The step asserts
 * other half: the old step treated any non-zero exit as a catch, so a flag
 * that died on an exception looked identical to a flag that violated an
 * invariant. The harness now exits 1 only for a violation and 2 for any other
 * error, and ci.yml accepts exit 1 only. These tests pin both halves down by
 * running the CI command itself: same entry point, same flag, same scenario
 * count, same implicit seeds (1..50).
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Scenario count ci.yml uses for the per-flag break-it step. */
const CI_SCENARIOS = 50;

/** Each run is a full 50-scenario harness pass; well under a few seconds. */
const RUN_TIMEOUT_MS = 120_000;

/**
 * The invariant each flag is supposed to break. A flag "works" only if the
 * checker names it - an exception or a non-zero exit proves nothing.
 */
const BREAK_IT_FLAGS = [
  { flag: "skipIntentRecord", invariant: "I5" },
  { flag: "timeoutAsFailure", invariant: "I4" },
  { flag: "newKeyOnRetry", invariant: "I4" },
  { flag: "overwriteConflictingConfirm", invariant: "I5" },
  // A blind resend must move money twice and be caught by I1 (double
  // settlement), not die on an illegal transition inside the runner.
  { flag: "resendWithoutStatusCheck", invariant: "I1" },
] as const;

interface RunResult {
  /** Process exit code, or -1 if the process could not be started/killed. */
  code: number;
  /** stdout + stderr, for failure messages. */
  output: string;
}

/** Runs the harness exactly as ci.yml does for a single break-it flag. */
function runBreakItFlag(flag: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        "--import",
        "tsx",
        "harness/run.ts",
        `--scenarios=${CI_SCENARIOS}`,
        `--break-it=${flag}`,
      ],
      { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const rawCode = (err as { code?: unknown } | null)?.code;
        const code = err === null ? 0 : typeof rawCode === "number" ? rawCode : -1;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}

// timeoutAsFailure's expected invariant is I4, not I5. The I5 it used
// to print was the checker's false positive on the FAILED->MANUAL_REVIEW and
// CONFIRMED->MANUAL_REVIEW cells (both documented MR cells). What this bug really
// violates is I4: the bank settled while we recorded FAILED.
describe("every break-it flag fails an invariant with exit 1", () => {
  for (const { flag, invariant } of BREAK_IT_FLAGS) {
    it(`${flag} exits 1 with VIOLATION: [${invariant}]`, async () => {
      const { code, output } = await runBreakItFlag(flag);
      const seen = output.slice(0, 4000);

      // 0 = the flag broke nothing. 2 = the harness threw; a crash is not
      // a catch. Only 1 means the checker caught the bug.
      expect(code, `${flag} must exit 1 (invariant violation), got ${code}\n${seen}`).toBe(1);

      expect(
        output,
        `${flag} must print "VIOLATION: [${invariant}]", not just exit non-zero`,
      ).toContain(`VIOLATION: [${invariant}]`);

      // An illegal transition is the runner crashing over its own bug, not the
      // checker catching it.
      expect(output, `${flag} must not fail by throwing IllegalTransitionError`).not.toContain(
        "IllegalTransitionError",
      );
    }, RUN_TIMEOUT_MS);
  }
});

describe("a harness error is distinguishable from an invariant violation", () => {
  it("unknown break-it flag exits 2 and reports no violation", async () => {
    const { code, output } = await runBreakItFlag("notARealFlag");
    expect(code, `unknown flag must exit 2, got ${code}\n${output.slice(0, 2000)}`).toBe(2);
    expect(output, "a usage error must not look like an invariant violation").not.toContain(
      "VIOLATION:",
    );
  }, RUN_TIMEOUT_MS);
});
