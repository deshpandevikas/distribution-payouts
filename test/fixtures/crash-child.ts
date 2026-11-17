/**
 * Child process for the SQLite crash test: send once, then die hard.
 *
 * The runner is configured to throw CrashInjected immediately after the bank
 * responds and before the response is recorded. Instead of unwinding, this
 * process SIGKILLs itself - no finally block, no store.close(), no flush. What
 * survives in the database file is whatever was actually committed.
 *
 * Usage: tsx test/fixtures/crash-child.ts <dbPath> <ledgerPath>
 */

import { SqliteStore } from "../../src/store/sqliteStore.js";
import { FileBank } from "./fileBank.js";
import { crashScenario } from "./crashScenario.js";
import { Runner, CrashInjected } from "../../src/core/runner.js";
import { rngFromSeed } from "../../harness/generate.js";

const [dbPath, ledgerPath] = process.argv.slice(2);

if (dbPath === undefined || ledgerPath === undefined) {
  console.error("usage: crash-child.ts <dbPath> <ledgerPath>");
  process.exit(2);
}

const store = new SqliteStore(dbPath);
const bank = new FileBank(ledgerPath);
let now = 0;
const clock = { now: () => now++, sleep: async (ms: number) => { now += ms; } };

const runner = new Runner({
  store,
  bank,
  clock,
  rng: rngFromSeed(7),
  crashAt: "afterBankCallBeforeRecord",
});

try {
  await runner.run(crashScenario());
} catch (err) {
  if (err instanceof CrashInjected) {
    // Hard kill: the point of the test is that durability cannot depend on an
    // orderly shutdown.
    process.kill(process.pid, "SIGKILL");
  }
  console.error(err);
  process.exit(3);
}

console.error("child completed without crashing - the crash point never fired");
process.exit(4);
