/**
 * C1: the CI break-it step must fail for every break-it flag.
 *
 * ci.yml runs, once per flag:
 *
 *   npm run harness -- --scenarios=50 --break-it=$flag
 *
 * and treats any non-zero exit as "the flag broke an invariant".
 *
 * That stopped being true for overwriteConflictingConfirm. Its bug needs a
 * payment in FAILED/MANUAL_REVIEW at the moment an ASYNC_CONFIRM for the same
 * key is drained. Since retries now cancel the queued async event, the only
 * surviving route is three consecutive transient rejections with a lying one
 * on the last allowed attempt - roughly 5e-4 per payment. Across the 50 CI
 * scenarios (~500 payments) that is ~0.25 expected hits, so the harness saw
 * none and exited 0, and the phase's CI went red.
 *
 * These tests run the CI command itself: same entry point, same flag, same
 * scenario count, same implicit seeds (1..50). A flag that stops failing an
 * invariant fails here instead of only in CI.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Scenario count ci.yml uses for the per-flag break-it step. */
const CI_SCENARIOS = 50;

/** Each run is a full 50-scenario harness pass; well under a few seconds. */
const RUN_TIMEOUT_MS = 120_000;

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

describe("C1: CI break-it step fails an invariant for every flag", () => {
  it("skipIntentRecord", async () => {
    const { code, output } = await runBreakItFlag("skipIntentRecord");
    expect(code, output.slice(0, 4000)).not.toBe(0);
  }, RUN_TIMEOUT_MS);

  it("timeoutAsFailure", async () => {
    const { code, output } = await runBreakItFlag("timeoutAsFailure");
    expect(code, output.slice(0, 4000)).not.toBe(0);
  }, RUN_TIMEOUT_MS);

  it("newKeyOnRetry", async () => {
    const { code, output } = await runBreakItFlag("newKeyOnRetry");
    expect(code, output.slice(0, 4000)).not.toBe(0);
  }, RUN_TIMEOUT_MS);

  it("overwriteConflictingConfirm exits non-zero AND reports an invariant violation", async () => {
    const { code, output } = await runBreakItFlag("overwriteConflictingConfirm");
    expect(code, output.slice(0, 4000)).not.toBe(0);
    // Non-zero alone is not enough: the overwrite branch writes CONFIRMED
    // without an audit entry, so the run must surface an I5 violation rather
    // than dying on an exception.
    expect(output, "run must print an invariant violation, not just exit non-zero").toMatch(
      /VIOLATION: \[I5\]/,
    );
  }, RUN_TIMEOUT_MS);

  // resendWithoutStatusCheck currently exits non-zero by throwing
  // IllegalTransitionError (0 violation lines). Distinguishing a violation from
  // a crash in the CI step is C2's card, so this asserts non-zero only.
  it("resendWithoutStatusCheck", async () => {
    const { code, output } = await runBreakItFlag("resendWithoutStatusCheck");
    expect(code, output.slice(0, 4000)).not.toBe(0);
  }, RUN_TIMEOUT_MS);
});
