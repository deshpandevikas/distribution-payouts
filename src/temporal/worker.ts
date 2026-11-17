/**
 * Local worker: `npm run temporal:worker`.
 *
 * Needs a server (`temporal server start-dev`) unless TEMPORAL_ADDRESS points
 * somewhere else. The store is the SQLite file, so a worker restart resumes from
 * durable state instead of memory.
 */

import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { SqliteStore } from "../store/sqliteStore.js";
import { FakeBank } from "../bank/fakeBank.js";
import { rngFromSeed } from "../../harness/generate.js";
import { createTemporalRuntimeQueue } from "./runtime.js";
import { DEFAULT_SQLITE_PATH, DEFAULT_TEMPORAL_ADDRESS, WORKFLOW_TASK_QUEUE } from "./config.js";

async function main(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
  const store = new SqliteStore(process.env.SQLITE_PATH ?? DEFAULT_SQLITE_PATH);
  const bank = new FakeBank(rngFromSeed(1), {});
  let now = Date.now();
  const clock = { now: () => now++, sleep: async (ms: number) => { await new Promise((r) => setTimeout(r, ms)); now += ms; } };

  const { activities } = createTemporalRuntimeQueue({ store, bank, clock });
  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    taskQueue: WORKFLOW_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
  });

  console.log(`worker listening on ${address}, task queue ${WORKFLOW_TASK_QUEUE}`);
  await worker.run();
  store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
