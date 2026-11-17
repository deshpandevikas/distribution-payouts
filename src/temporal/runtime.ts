/**
 * Builds the activity implementations.
 *
 * The transition table, the store port and the fake bank are reused exactly as
 * they are in the in-process runner - this file only wires them to Temporal.
 * A dependency object is passed in rather than imported so tests can point the
 * same activities at a temp SQLite file and a bank with a ledger.
 */

import { Context } from "@temporalio/activity";
import { applyEvent } from "../core/stateMachine.js";
import { buildIdempotencyKey, buildPaymentId } from "../core/runner.js";
import type {
  Bank,
  BankSendResponse,
  BankStatusResponse,
  Clock,
  Distribution,
  IdempotencyKey,
  Payment,
  PaymentEvent,
  PaymentId,
  RunResult,
  RunnerConfig,
  Store,
  Cents,
} from "../core/types.js";
import { DEFAULT_RUNNER_CONFIG, TERMINAL_STATES } from "../core/types.js";
import type { TemporalActivities } from "./activities.js";

export interface TemporalFaults {
  /** Commit a transition, then throw once - a crash between WAL commit and reply. */
  failAfterTransitionOnce?: boolean;
  /** Reach the bank, then throw once - what a worker crash looks like to Temporal. */
  failAfterSendOnce?: boolean;
  /** Reach the bank, then block until releasePause() - a worker dying mid-activity. */
  pauseAfterSendOnce?: boolean;
}

export interface TemporalRuntimeOptions {
  store: Store;
  bank: Bank;
  clock: Clock;
  config?: Partial<RunnerConfig>;
  faults?: TemporalFaults;
  /** Base backoff for transient retries, in ms. */
  backoffBaseMs?: number;
}

export interface TemporalRuntime {
  activities: TemporalActivities;
  /** Resolves once the paused send has reached the bank. */
  waitForPause(): Promise<void>;
  /** Lets the paused send return. */
  releasePause(): void;
  /** Resolves once the injected post-bank failure has fired. */
  waitForFault(): Promise<void>;
  /** Resolves once the injected post-transition failure has fired. */
  waitForTransitionFault(): Promise<void>;
  /** How many transitions committed and then threw. */
  transitionFaultsFired(): number;
}

export function createTemporalRuntimeQueue(opts: TemporalRuntimeOptions): TemporalRuntime {
  const config: RunnerConfig = { ...DEFAULT_RUNNER_CONFIG, ...(opts.config ?? {}) };
  const faults = opts.faults ?? {};

  let failedOnce = false;
  let pausedOnce = false;
  let pauseSignalled: () => void = () => {};
  let releasePause: () => void = () => {};
  const pauseReached = new Promise<void>((resolve) => { pauseSignalled = resolve; });
  const pauseReleased = new Promise<void>((resolve) => { releasePause = resolve; });
  let faultSignalled: () => void = () => {};
  const faultFired = new Promise<void>((resolve) => { faultSignalled = resolve; });
  let transitionFaultSignalled: () => void = () => {};
  const transitionFaultReached = new Promise<void>((resolve) => { transitionFaultSignalled = resolve; });
  let transitionFaultCount = 0;

  /**
   * 1-based attempt number of the CURRENT activity execution. That is the thing
   * Temporal retries, so it - not the bank rejection counter - is what a
   * new-key-on-retry bug keys off.
   */
  const activityAttempt = (): number => {
    try {
      return Context.current().info.attempt;
    } catch {
      return 1; // not inside an activity context (unit use)
    }
  };

  const mustGet = (id: PaymentId): Payment => {
    const payment = opts.store.getPayment(id);
    if (!payment) throw new Error(`activity: no payment ${id}`);
    return payment;
  };

  const recordEvent = async (id: PaymentId, event: PaymentEvent): Promise<Payment> => {
    const payment = mustGet(id);

    // Idempotent under Temporal retries. If the newest audit row for this
    // payment already records this event and the payment is already in that
    // row's target state, the transition committed before the activity died.
    // Applying it again would be illegal (or write a duplicate audit row).
    // Rows where fromState === toState are excluded: those are legitimate
    // repeats (e.g. staying UNKNOWN), not a retried commit.
    const audit = opts.store.listAudit(payment.distributionId).filter((e) => e.paymentId === id);
    const last = audit[audit.length - 1];
    if (
      last !== undefined &&
      last.event === event.type &&
      last.fromState !== last.toState &&
      payment.state === last.toState
    ) {
      return payment;
    }

    const result = applyEvent(payment, event, opts.clock);
    const updated: Payment = { ...payment, state: result.toState, updatedAt: opts.clock.now() };
    opts.store.transition(updated, result.auditEntry);

    if (faults.failAfterTransitionOnce === true && transitionFaultCount === 0) {
      transitionFaultCount += 1;
      transitionFaultSignalled();
      throw new Error("injected crash after the audit row committed");
    }

    return opts.store.getPayment(id) ?? updated;
  };

  const activities: TemporalActivities = {
    async ensurePayments(distribution: Distribution): Promise<Payment[]> {
      const payments: Payment[] = [];
      for (const allocation of distribution.allocations) {
        const key = buildIdempotencyKey(distribution.id, allocation.investor.id, 1);
        const existing = opts.store.getPaymentByKey(key);
        if (existing) { payments.push(existing); continue; }

        if (allocation.amountCents === 0) {
          opts.store.appendAlert({
            kind: "ALLOCATION_SKIPPED",
            distributionId: distribution.id,
            investorId: allocation.investor.id,
            detail: `zero-cent allocation for investor ${allocation.investor.id} - no payment created`,
            timestamp: opts.clock.now(),
          });
          continue;
        }

        const payment: Payment = {
          id: buildPaymentId(distribution.id, allocation.investor.id),
          distributionId: distribution.id,
          investorId: allocation.investor.id,
          amountCents: allocation.amountCents,
          idempotencyKey: key,
          bankDetails: allocation.investor.bankDetails,
          instructionNo: 1,
          state: "CREATED",
          transientRetries: 0,
          statusChecks: 0,
          createdAt: opts.clock.now(),
          updatedAt: opts.clock.now(),
          lastSentAt: 0,
        };
        opts.store.savePayment(payment);
        payments.push(payment);
      }
      return payments;
    },

    async loadPayment(id: PaymentId): Promise<Payment> {
      return mustGet(id);
    },

    recordEvent,

    async sendOnce(
      id: PaymentId,
      nowMs: number,
    ): Promise<{ key: IdempotencyKey; response: BankSendResponse }> {
      const payment = mustGet(id);
      // Break-it: a new key per retry is exactly the bug F3 has to be able to
      // reproduce, so the flag is honoured here too.
      const retryNo = config.newKeyOnRetry
        ? payment.transientRetries + Math.max(0, activityAttempt() - 1)
        : 0;
      const key = retryNo > 0
        ? buildIdempotencyKey(payment.distributionId, payment.investorId, payment.instructionNo, retryNo)
        : payment.idempotencyKey;

      // The workflow's clock, not this activity's: the settle window is measured
      // against lastSentAt, so both sides must use the same clock.
      const sent: Payment = { ...payment, lastSentAt: nowMs };
      opts.store.savePayment(sent);

      const response = await opts.bank.send(key, payment.amountCents, payment.bankDetails);

      if (faults.failAfterSendOnce === true && !failedOnce) {
        failedOnce = true;
        faultSignalled();
        throw new Error("injected worker crash after the bank call");
      }
      if (faults.pauseAfterSendOnce === true && !pausedOnce) {
        pausedOnce = true;
        pauseSignalled();
        try {
          await pauseReleased;
        } catch {
          // The worker went away while we were paused: let the activity end.
        }
      }

      return { key, response };
    },

    async recordSendResponse(
      id: PaymentId,
      _key: IdempotencyKey,
      response: BankSendResponse,
    ): Promise<Payment> {
      const payment = mustGet(id);
      switch (response.type) {
        case "ACCEPTED":
          return recordEvent(id, { type: "BANK_ACCEPTED" });
        case "REJECTED_PERMANENT":
          return recordEvent(id, {
            type: "BANK_REJECTED_PERMANENT",
            reason: response.reason ?? "permanent rejection",
          });
        case "TIMEOUT":
          if (config.timeoutAsFailure) {
            return recordEvent(id, {
              type: "BANK_REJECTED_PERMANENT",
              reason: "timeout treated as failure (timeoutAsFailure flag)",
            });
          }
          return recordEvent(id, { type: "BANK_TIMEOUT" });
        case "REJECTED_TRANSIENT": {
          const nextRetries = payment.transientRetries + 1;
          if (nextRetries >= config.maxTransientRetries) {
            opts.store.savePayment({ ...payment, transientRetries: nextRetries });
            return recordEvent(id, {
              type: "TRANSIENT_RETRIES_EXHAUSTED",
              reason: `transient retries exhausted after ${nextRetries} attempts`,
            });
          }
          const recorded = await recordEvent(id, {
            type: "BANK_REJECTED_TRANSIENT",
            reason: response.reason ?? "transient rejection",
          });
          const withCount: Payment = { ...recorded, transientRetries: nextRetries };
          opts.store.savePayment(withCount);
          return withCount;
        }
      }
    },

    async getStatus(id: PaymentId): Promise<BankStatusResponse> {
      const payment = mustGet(id);
      return opts.bank.getStatus(payment.idempotencyKey);
    },

    async recordStatus(
      id: PaymentId,
      response: BankStatusResponse,
      nowMs: number,
    ): Promise<{ payment: Payment; waitMs: number }> {
      const payment = mustGet(id);

      switch (response.type) {
        case "CONFIRMED":
          return { payment: await recordEvent(id, { type: "STATUS_CONFIRMED" }), waitMs: 0 };
        case "FAILED":
          return {
            payment: await recordEvent(id, {
              type: "STATUS_FAILED",
              reason: response.reason ?? "bank status: failed",
            }),
            waitMs: 0,
          };
        case "TIMEOUT":
          return { payment: await recordEvent(id, { type: "BANK_TIMEOUT" }), waitMs: 0 };
        case "NOT_FOUND": {
          const counted: Payment = { ...payment, statusChecks: payment.statusChecks + 1 };
          opts.store.savePayment(counted);

          if (counted.statusChecks >= config.maxStatusChecks) {
            return { payment: await recordEvent(id, { type: "CHECKS_EXHAUSTED" }), waitMs: 0 };
          }

          const age = nowMs - counted.lastSentAt;
          const insideWindow = age < config.settleWindowMs;

          if (counted.state === "SENDING") {
            // Inside the window: wait as UNKNOWN. Outside: stay SENDING so the
            // workflow sends again with the same key.
            return insideWindow
              ? { payment: await recordEvent(id, { type: "STATUS_NOT_FOUND" }), waitMs: 0 }
              : { payment: counted, waitMs: 0 };
          }

          if (insideWindow) {
            return {
              payment: await recordEvent(id, { type: "STATUS_NOT_FOUND_IN_WINDOW" }),
              waitMs: Math.max(0, config.settleWindowMs - age),
            };
          }
          return { payment: await recordEvent(id, { type: "STATUS_NOT_FOUND" }), waitMs: 0 };
        }
      }
    },

    async buildResult(distributionId: string, totalAllocatedCents: Cents): Promise<RunResult> {
      const exceptions: PaymentId[] = [];
      let confirmed = 0, failed = 0, manual = 0;
      for (const p of opts.store.listPayments(distributionId)) {
        if (TERMINAL_STATES.has(p.state)) {
          if (p.state === "CONFIRMED") confirmed += p.amountCents;
          else {
            exceptions.push(p.id);
            if (p.state === "FAILED") failed += p.amountCents;
            else manual += p.amountCents;
          }
        }
      }
      return {
        distributionId,
        status: exceptions.length === 0 ? "COMPLETED" : "COMPLETED_WITH_EXCEPTIONS",
        exceptions,
        totalAllocatedCents,
        totalConfirmedCents: confirmed,
        totalFailedCents: failed,
        totalManualReviewCents: manual,
      };
    },
  };

  return {
    activities,
    waitForPause: () => pauseReached,
    releasePause: () => releasePause(),
    waitForFault: () => faultFired,
    waitForTransitionFault: () => transitionFaultReached,
    transitionFaultsFired: () => transitionFaultCount,
  };
}
