/**
 * F2 crash test.
 *
 * A real child process, killed with SIGKILL between the bank call and the
 * record step, then the same database file reopened in this process. Recovery
 * must resume through the status check - never a blind resend - and the bank
 * must show exactly one settlement.
 *
 * The bank's settled set lives in a file (FileBank) so it survives the kill;
 * counting its send lines is how a second send would be noticed even though the
 * key would dedupe the money to one transfer.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../src/store/sqliteStore.js";
import { FileBank } from "./fixtures/fileBank.js";
import { crashScenario, CRASH_DISTRIBUTION_ID } from "./fixtures/crashScenario.js";
import { Runner } from "../src/core/runner.js";
import { rngFromSeed } from "../harness/generate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHILD = join(HERE, "fixtures", "crash-child.ts");

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

function runCrashChild(dbPath: string, ledgerPath: string): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CHILD, dbPath, ledgerPath],
      { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "dp-crash-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("SQLite crash recovery", () => {
  it(
    "kills the process after the bank call and the recorded intent survives",
    async () => {
      await withTempDir(async (dir) => {
        const dbPath = join(dir, "payouts.db");
        const ledgerPath = join(dir, "ledger.tsv");

        const result = await runCrashChild(dbPath, ledgerPath);

        expect(result.signal).toBe("SIGKILL");
        expect(existsSync(dbPath)).toBe(true);

        const bank = new FileBank(ledgerPath);
        // The money moved: the bank accepted the send before the process died.
        expect(bank.sendLines()).toBe(1);
        expect(bank.getSettledKeys().size).toBe(1);

        const store = new SqliteStore(dbPath);
        try {
          const payments = store.listPayments(CRASH_DISTRIBUTION_ID);
          expect(payments).toHaveLength(1);
          // Intent was committed before the bank call, so it is still here...
          expect(payments[0]!.state).toBe("SENDING");
          // ...and the bank response was not: exactly one audit row, no CONFIRMED.
          expect(store.listAudit(CRASH_DISTRIBUTION_ID).map((e) => e.event)).toEqual([
            "SEND_INTENT_RECORDED",
          ]);
        } finally {
          store.close();
        }
      });
    },
    30_000,
  );

  it(
    "recovery resumes through the status check and settles exactly once",
    async () => {
      await withTempDir(async (dir) => {
        const dbPath = join(dir, "payouts.db");
        const ledgerPath = join(dir, "ledger.tsv");

        const result = await runCrashChild(dbPath, ledgerPath);
        expect(result.signal).toBe("SIGKILL");

        const bank = new FileBank(ledgerPath);
        const store = new SqliteStore(dbPath);
        let now = 0;
        const clock = { now: () => now++, sleep: async (ms: number) => { now += ms; } };

        try {
          const runner = new Runner({ store, bank, clock, rng: rngFromSeed(11) });
          const runResult = await runner.run(crashScenario());

          expect(runResult.status).toBe("COMPLETED");
          const payments = store.listPayments(CRASH_DISTRIBUTION_ID);
          expect(payments).toHaveLength(1);
          expect(payments[0]!.state).toBe("CONFIRMED");

          // The recovery asked the bank instead of resending: still one send.
          expect(bank.sendLines()).toBe(1);
          expect(bank.getSettledKeys().size).toBe(1);

          const events = store.listAudit(CRASH_DISTRIBUTION_ID).map((e) => e.event);
          expect(events).toContain("RECOVERY_ON_RESTART");
          expect(events).toContain("STATUS_CONFIRMED");
          expect(events).not.toContain("SEND_INTENT_RECORDED_AGAIN");
        } finally {
          store.close();
        }
      });
    },
    30_000,
  );
});
