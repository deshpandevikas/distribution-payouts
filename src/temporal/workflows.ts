/**
 * One workflow per distribution.
 *
 * Determinism rules: no Date.now(), no Math.random(), no I/O, no Node imports.
 * Time comes from workflowInfo().unsafe.now() (the workflow task clock) and
 * waiting is done with Temporal's sleep, so a replay sees the same numbers and
 * the same timers.
 *
 * Every bank call and every store write is an activity. Business outcomes come
 * back as values, so Temporal's retries mean "the worker failed", not "the bank
 * said no".
 */

import { proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import { TERMINAL_STATES } from "../core/types.js";
import type { Distribution, Payment, PaymentId, RunResult } from "../core/types.js";
import type { TemporalActivities } from "./activities.js";

const acts = proxyActivities<TemporalActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "100 milliseconds",
    backoffCoefficient: 2,
    maximumAttempts: 10,
  },
});

/** Deterministic backoff: same attempt number, same delay, no jitter. */
function backoffMs(attempt: number): number {
  return 100 * Math.pow(2, Math.max(0, attempt - 1));
}

async function statusCheck(id: PaymentId): Promise<Payment> {
  const status = await acts.getStatus(id);
  const outcome = await acts.recordStatus(id, status, workflowInfo().unsafe.now());
  if (outcome.waitMs > 0) {
    // Temporal sleep, not a real timer: the test environment skips it.
    await sleep(outcome.waitMs);
  }
  return outcome.payment;
}

export async function distributionWorkflow(distribution: Distribution): Promise<RunResult> {
  const payments = await acts.ensurePayments(distribution);

  for (const initial of payments) {
    let payment = initial;

    // Restart recovery: never blind resend. A payment found in flight is
    // status-checked before anything is sent again.
    const recovered = payment.state === "SENDING" || payment.state === "UNKNOWN";
    if (recovered) {
      payment = await acts.recordEvent(payment.id, { type: "RECOVERY_ON_RESTART" });
    }

    let firstIteration = true;
    let iterations = 0;

    while (!TERMINAL_STATES.has(payment.state)) {
      if (++iterations > 1000) {
        throw new Error(`workflow exceeded 1000 iterations for payment ${payment.id}`);
      }

      if (payment.state === "CREATED") {
        payment = await acts.recordEvent(payment.id, { type: "SEND_INTENT_RECORDED" });
      } else if (payment.state === "SENDING") {
        if (recovered && firstIteration) {
          payment = await statusCheck(payment.id);
        } else {
          const sent = await acts.sendOnce(payment.id);
          payment = await acts.recordSendResponse(payment.id, sent.key, sent.response);
          if (sent.response.type === "REJECTED_TRANSIENT") {
            await sleep(backoffMs(payment.transientRetries));
          }
        }
      } else if (payment.state === "UNKNOWN") {
        payment = await statusCheck(payment.id);
      } else {
        throw new Error(`unexpected non-terminal state ${payment.state} for ${payment.id}`);
      }

      firstIteration = false;
    }
  }

  const totalAllocatedCents = distribution.allocations.reduce((sum, a) => sum + a.amountCents, 0);
  return acts.buildResult(distribution.id, totalAllocatedCents);
}
