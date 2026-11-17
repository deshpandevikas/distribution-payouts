/**
 * F3: Temporal path.
 *
 * Same core logic, second execution model. The in-process runner and the
 * 2,000-scenario harness are untouched - this file only exercises the Temporal
 * workflow, and it uses createTimeSkipping() so CI needs no Temporal server.
 *
 * What must hold here that the in-process runner gets for free:
 *   - an activity may run twice, so the idempotency key and "check before
 *     resending" still have to prevent a second payment;
 *   - a worker can die mid-payment and another one picks the workflow up.
 *
 * Every test asserts at the bank (settlements), not just in our store: a
 * payment that moved twice is only visible there.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { SqliteStore } from "../src/store/sqliteStore.js";
import { FakeBank } from "../src/bank/fakeBank.js";
import { rngFromSeed } from "../harness/generate.js";
import { allocate } from "../src/core/allocation.js";
import { distributionWorkflow } from "../src/temporal/workflows.js";
import { createTemporalRuntimeQueue } from "../src/temporal/runtime.js";
import { WORKFLOW_TASK_QUEUE } from "../src/temporal/config.js";
import type { Distribution } from "../src/core/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = join(HERE, "..", "src", "temporal", "workflows.ts");

interface Harness {
  dir: string;
  store: SqliteStore;
  bank: FakeBank;
  env: TestWorkflowEnvironment;
  distribution: Distribution;
  cleanup: () => Promise<void>;
}

function distribution(investors: number, totalCents: number): Distribution {
  const allocations = allocate(
    totalCents,
    Array.from({ length: investors }, (_, i) => ({
      investor: { id: `inv-${i}`, name: `Investor ${i}`, bankDetails: `routing:${i}` },
      basisUnits: 1,
    })),
  );
  return { id: "dist-temporal", totalCents, allocations, createdAt: 0 };
}

async function harness(opts: {
  investors?: number;
  totalCents?: number;
  dedupe?: boolean;
  faults?: Parameters<typeof createTemporalRuntimeQueue>[0]["faults"];
  runnerConfig?: Parameters<typeof createTemporalRuntimeQueue>[0]["config"];
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dp-temporal-"));
  const store = new SqliteStore(join(dir, "payouts.db"));
  const bank = new FakeBank(rngFromSeed(3), {
    permanentRejectRate: 0,
    transientRejectRate: 0,
    timeoutRate: 0,
    statusTimeoutRate: 0,
    ...(opts.dedupe === false ? { dedupe: false } : {}),
  });
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const runtime = createTemporalRuntimeQueue({
    store,
    bank,
    clock: { now: () => Date.parse("2026-01-01T00:00:00Z"), sleep: async () => {} },
    ...(opts.runnerConfig !== undefined ? { config: opts.runnerConfig } : {}),
    ...(opts.faults !== undefined ? { faults: opts.faults } : {}),
  });

  return {
    dir,
    store,
    bank,
    env,
    distribution: distribution(opts.investors ?? 3, opts.totalCents ?? 900),
    cleanup: async () => {
      await env.teardown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
    // activities are handed to the worker below
    ...({ runtime } as object),
  } as Harness & { runtime: ReturnType<typeof createTemporalRuntimeQueue> };
}

async function runWorkflow(h: Harness & { runtime: ReturnType<typeof createTemporalRuntimeQueue> }, dist: Distribution) {
  const worker: Worker = await Worker.create({
      connection: h.env.nativeConnection,
    taskQueue: WORKFLOW_TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: h.runtime.activities,
  });

  return worker.runUntil(() =>
    h.env.client.workflow.execute(distributionWorkflow, {
      args: [dist],
      taskQueue: WORKFLOW_TASK_QUEUE,
      workflowId: `wf-${dist.id}-${Date.now()}`,
    }),
  );
}

describe("Temporal distribution workflow", () => {
  let active: (Harness & { runtime: ReturnType<typeof createTemporalRuntimeQueue> }) | undefined;

  afterEach(async () => {
    if (active) {
      await active.cleanup();
      active = undefined;
    }
  });

  it("confirms every investor and settles each key exactly once", async () => {
    const h = (await harness({ investors: 3, totalCents: 900 })) as Harness & {
      runtime: ReturnType<typeof createTemporalRuntimeQueue>;
    };
    active = h;

    const result = await runWorkflow(h, h.distribution);

    expect(result.status).toBe("COMPLETED");
    const payments = h.store.listPayments(h.distribution.id);
    expect(payments).toHaveLength(3);
    expect(payments.every((p) => p.state === "CONFIRMED")).toBe(true);
    expect(h.bank.getSettledKeys().size).toBe(3);
  });

  it("does not pay twice when the send activity runs again after the bank call", async () => {
    const h = (await harness({
      investors: 2,
      totalCents: 600,
      // The first send activity reaches the bank and then fails, as a worker
      // crash would. Temporal retries it.
      faults: { failAfterSendOnce: true },
    })) as Harness & { runtime: ReturnType<typeof createTemporalRuntimeQueue> };
    active = h;

    const result = await runWorkflow(h, h.distribution);

    expect(result.status).toBe("COMPLETED");
    expect(h.bank.getSettledKeys().size).toBe(2);
    const settledCents = [...h.bank.getSettledKeys().values()].reduce((a, b) => a + b, 0);
    expect(settledCents).toBe(600);
  });

  it("break-it: a new key on retry with a non-deduping bank double-pays, and the check catches it", async () => {
    const h = (await harness({
      investors: 2,
      totalCents: 600,
      dedupe: false,
      runnerConfig: { newKeyOnRetry: true },
      faults: { failAfterSendOnce: true },
    })) as Harness & { runtime: ReturnType<typeof createTemporalRuntimeQueue> };
    active = h;

    await runWorkflow(h, h.distribution).catch(() => undefined);

    const settledCents = [...h.bank.getSettledKeys().values()].reduce((a, b) => a + b, 0);
    // The bug: the retry used a different key, so the bank paid again under a
    // key we no longer track. Both settlements are visible in the bank.
    expect(h.bank.getSettledKeys().size).toBeGreaterThan(2);
    expect(settledCents).toBeGreaterThan(600);
  });
});
