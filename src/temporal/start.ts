/**
 * Start one Temporal run: `npm run temporal:start`.
 * Builds a small distribution with the same allocation code the harness uses.
 */

import { Client, Connection } from "@temporalio/client";
import { allocate } from "../core/allocation.js";
import type { Distribution } from "../core/types.js";
import { distributionWorkflow } from "./workflows.js";
import { DEFAULT_TEMPORAL_ADDRESS, WORKFLOW_TASK_QUEUE } from "./config.js";

function demoDistribution(): Distribution {
  const allocations = allocate(900, [
    { investor: { id: "inv-a", name: "Investor A", bankDetails: "routing:a" }, basisUnits: 1 },
    { investor: { id: "inv-b", name: "Investor B", bankDetails: "routing:b" }, basisUnits: 1 },
    { investor: { id: "inv-c", name: "Investor C", bankDetails: "routing:c" }, basisUnits: 1 },
  ]);
  return { id: `dist-${Date.now()}`, totalCents: 900, allocations, createdAt: Date.now() };
}

async function main(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
  const connection = await Connection.connect({ address });
  const client = new Client({ connection });
  const distribution = demoDistribution();

  const result = await client.workflow.execute(distributionWorkflow, {
    taskQueue: WORKFLOW_TASK_QUEUE,
    workflowId: distribution.id,
    args: [distribution],
  });

  console.log(JSON.stringify(result, null, 2));
  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
