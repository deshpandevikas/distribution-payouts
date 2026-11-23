/**
 * The Temporal path.
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
import type {
  Bank,
  BankSendResponse,
  BankStatusResponse,
  Cents,
  Distribution,
  IdempotencyKey,
} from "../src/core/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_PATH = join(HERE, "..", "src", "temporal", "workflows.ts");

interface Harness {
  dir: string;
  store: SqliteStore;
  bank: Bank;
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

/**
 * A bank that answers by script.
 *
 * FakeBank is seeded and probabilistic; these cases need an exact sequence - a
 * timeout, then N NOT_FOUND answers, then settlement - because the question is
 * whether the workflow waits out the window, not what a seed happens to roll.
 * Every send and status query is recorded, so a test can assert the order.
 */
class ScriptedBank implements Bank {
  /** Keys in the order they were sent. */
  readonly sends: IdempotencyKey[] = [];
  /** Keys in the order their status was queried. */
  readonly statuses: IdempotencyKey[] = [];
  private readonly settled = new Map<IdempotencyKey, Cents>();
  private readonly attempts = new Map<IdempotencyKey, number>();
  private query = 0;

  constructor(
    private readonly plan: {
      /** The first send of each key times out instead of accepting. */
      firstSendTimesOut: boolean;
      /** A timed-out send moved the money anyway, so it confirms by status. */
      settleOnTimeout: boolean;
      /** Status answers in order; the last one repeats. */
      status: Array<"NOT_FOUND" | "CONFIRMED" | "FAILED" | "TIMEOUT">;
    },
  ) {}

  async send(key: IdempotencyKey, amountCents: Cents): Promise<BankSendResponse> {
    this.sends.push(key);
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);

    if (attempt === 1 && this.plan.firstSendTimesOut) {
      if (this.plan.settleOnTimeout) this.settle(key, amountCents);
      return { type: "TIMEOUT" };
    }
    this.settle(key, amountCents);
    return { type: "ACCEPTED" };
  }

  async getStatus(key: IdempotencyKey): Promise<BankStatusResponse> {
    this.statuses.push(key);
    const answer = this.plan.status[Math.min(this.query, this.plan.status.length - 1)]!;
    this.query += 1;

    switch (answer) {
      case "CONFIRMED":
        return { type: "CONFIRMED" };
      case "FAILED":
        return { type: "FAILED", reason: "scripted failure" };
      case "TIMEOUT":
        return { type: "TIMEOUT" };
      case "NOT_FOUND":
        return { type: "NOT_FOUND" };
    }
  }

  getSettledKeys(): ReadonlyMap<IdempotencyKey, Cents> {
    return this.settled;
  }

  private settle(key: IdempotencyKey, amountCents: Cents): void {
    if (!this.settled.has(key)) this.settled.set(key, amountCents);
  }
}

async function harness(opts: {
  investors?: number;
  totalCents?: number;
  dedupe?: boolean;
  faults?: Parameters<typeof createTemporalRuntimeQueue>[0]["faults"];
  runnerConfig?: Parameters<typeof createTemporalRuntimeQueue>[0]["config"];
  bank?: Bank;
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dp-temporal-"));
  const store = new SqliteStore(join(dir, "payouts.db"));
  const bank: Bank = opts.bank ?? new FakeBank(rngFromSeed(3), {
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

  it("replays the recorded history against the current workflow code", async () => {
    const h = (await harness({ investors: 2, totalCents: 600 })) as Harness & {
      runtime: ReturnType<typeof createTemporalRuntimeQueue>;
    };
    active = h;

    const worker = await Worker.create({
      connection: h.env.nativeConnection,
      taskQueue: WORKFLOW_TASK_QUEUE,
      workflowsPath: WORKFLOWS_PATH,
      activities: h.runtime.activities,
    });

    const handle = await h.env.client.workflow.start(distributionWorkflow, {
      args: [h.distribution],
      taskQueue: WORKFLOW_TASK_QUEUE,
      workflowId: `wf-replay-${h.distribution.id}`,
    });
    await worker.runUntil(handle.result());

    const history = await handle.fetchHistory();
    expect((history.events ?? []).length).toBeGreaterThan(0);

    // This is what a restarted worker does with a run it has never seen: rebuild
    // the workflow state by replaying history through the current code. Any
    // unseeded random number or non-deterministic branch throws here instead of
    // passing silently, which is the property a real worker kill would test.
    // (Date.now() is fine: the sandbox maps it to workflow time.)
    await Worker.runReplayHistory(
      { workflowsPath: WORKFLOWS_PATH },
      history,
      handle.workflowId,
    );

    // The replay must not re-execute activities: the money did not move again.
    expect(h.bank.getSettledKeys().size).toBe(2);
    expect(h.store.listPayments(h.distribution.id).every((p) => p.state === "CONFIRMED")).toBe(true);
  }, 60_000);

  it("retries a transition that committed and then threw, without duplicating the audit row", async () => {
    const h = (await harness({
      investors: 1,
      totalCents: 300,
      faults: { failAfterTransitionOnce: true },
    })) as Harness & { runtime: ReturnType<typeof createTemporalRuntimeQueue> };
    active = h;

    const result = await runWorkflow(h, h.distribution);

    // The activity committed SEND_INTENT_RECORDED, then died before returning;
    // Temporal retried it and the retry recognised the commit.
    expect(h.runtime.transitionFaultsFired()).toBeGreaterThan(0);
    expect(result.status).toBe("COMPLETED");

    const audit = h.store.listAudit(h.distribution.id);
    expect(audit.filter((e) => e.event === "SEND_INTENT_RECORDED")).toHaveLength(1);
    expect(audit.filter((e) => e.event === "BANK_ACCEPTED")).toHaveLength(1);

    const payments = h.store.listPayments(h.distribution.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.state).toBe("CONFIRMED");
    expect(h.bank.getSettledKeys().size).toBe(1);
  }, 60_000);

  it("waits out the settle window on NOT_FOUND, then resends the same key and settles once", async () => {
    // A timeout, then two NOT_FOUND answers. Inside the window the workflow must
    // wait (time-skipped), not resend; after it, resend with the SAME key.
    const bank = new ScriptedBank({
      firstSendTimesOut: true,
      settleOnTimeout: false,
      status: ["NOT_FOUND", "NOT_FOUND"],
    });
    const h = (await harness({
      investors: 1,
      totalCents: 300,
      bank,
      runnerConfig: { settleWindowMs: 2_000 },
    })) as Harness & { runtime: ReturnType<typeof createTemporalRuntimeQueue> };
    active = h;

    const result = await runWorkflow(h, h.distribution);

    expect(result.status).toBe("COMPLETED");
    // Two status answers arrived before anything was sent again: the window was
    // waited out rather than skipped by a clock mismatch.
    expect(bank.statuses).toHaveLength(2);
    expect(bank.sends).toHaveLength(2);
    expect(bank.sends[1]).toBe(bank.sends[0]);

    expect(h.store.listAudit(h.distribution.id).map((e) => e.event)).toEqual([
      "SEND_INTENT_RECORDED",
      "BANK_TIMEOUT",
      "STATUS_NOT_FOUND_IN_WINDOW",
      "STATUS_NOT_FOUND",
      "BANK_ACCEPTED",
    ]);

    const payments = h.store.listPayments(h.distribution.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.state).toBe("CONFIRMED");
    expect(bank.getSettledKeys().size).toBe(1);
  }, 60_000);

  it("a timeout followed by a status CONFIRMED ends CONFIRMED with a single settlement", async () => {
    const bank = new ScriptedBank({
      firstSendTimesOut: true,
      settleOnTimeout: true,
      status: ["CONFIRMED"],
    });
    const h = (await harness({ investors: 1, totalCents: 300, bank })) as Harness & {
      runtime: ReturnType<typeof createTemporalRuntimeQueue>;
    };
    active = h;

    const result = await runWorkflow(h, h.distribution);

    expect(result.status).toBe("COMPLETED");
    // The status query resolved it; nothing was resent.
    expect(bank.sends).toHaveLength(1);
    expect(bank.statuses).toHaveLength(1);
    expect(bank.getSettledKeys().size).toBe(1);
    expect(h.store.listAudit(h.distribution.id).map((e) => e.event)).toEqual([
      "SEND_INTENT_RECORDED",
      "BANK_TIMEOUT",
      "STATUS_CONFIRMED",
    ]);
    expect(h.store.listPayments(h.distribution.id)[0]!.state).toBe("CONFIRMED");
  }, 60_000);
});
