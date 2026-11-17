/**
 * Distribution payout runner.
 *
 * Orchestrates payments for a single distribution:
 *   1. For each allocated payment, create a Payment record (CREATED).
 *   2. Record send intent (SENDING) before calling the bank.
 *   3. Call the bank and handle the response via the state machine.
 *   4. On UNKNOWN: poll status up to maxStatusChecks times.
 *   5. On exhausted checks: CHECKS_EXHAUSTED -> MANUAL_REVIEW.
 *   6. After all payments drain: run reconciliation report.
 *
 * Key invariants the runner must uphold (enforced by harness, not asserted here):
 *   - Intent is always written before the bank is called (unless skipIntentRecord is set).
 *   - Retries reuse the same idempotency key (unless newKeyOnRetry is set).
 *   - A payment in SENDING on restart triggers a status check, never a blind resend.
 *   - Status checks are cumulative (count preserved across retries).
 *
 * Crash injection points (for harness crash tests):
 *   "afterIntentRecorded"        -  after SENDING is written, before bank call
 *   "afterBankCallBeforeRecord"  -  after bank responds, before state is recorded
 *   "duringStatusCheck"          -  during a status check poll
 *
 * All timing and randomness come from injected Clock and Rng.
 * No Date.now() or Math.random() here.
 */

import { createHash } from "node:crypto";
import { assertCents } from "./money.js";
import { applyEvent, IllegalTransitionError } from "./stateMachine.js";
import type {
  Payment,
  PaymentId,
  PaymentEvent,
  Distribution,
  Store,
  Bank,
  Clock,
  Rng,
  RunnerConfig,
  RunResult,
  Cents,
  IdempotencyKey,
  AuditEntry,
} from "./types.js";
import { DEFAULT_RUNNER_CONFIG, TERMINAL_STATES } from "./types.js";

// ---------------------------------------------------------------------------
// Crash injection
// ---------------------------------------------------------------------------

export type CrashPoint =
  | "afterIntentRecorded"
  | "afterBankCallBeforeRecord"
  | "duringStatusCheck";

export class CrashInjected extends Error {
  constructor(public readonly point: CrashPoint) {
    super(`crash injected at: ${point}`);
    this.name = "CrashInjected";
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunnerDeps {
  store: Store;
  bank: Bank;
  clock: Clock;
  rng: Rng;
  config?: Partial<RunnerConfig>;
  /** If set, throw CrashInjected when execution reaches this point. */
  crashAt?: CrashPoint;
}

export class Runner {
  private readonly store: Store;
  private readonly bank: Bank;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly config: RunnerConfig;
  private readonly crashAt: CrashPoint | undefined;

  constructor(deps: RunnerDeps) {
    this.store = deps.store;
    this.bank = deps.bank;
    this.clock = deps.clock;
    this.rng = deps.rng;
    this.config = { ...DEFAULT_RUNNER_CONFIG, ...(deps.config ?? {}) };
    this.crashAt = deps.crashAt;
  }

  // -------------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------------

  async run(distribution: Distribution): Promise<RunResult> {
    // Create or resume payments for every allocation.
    const paymentIds: PaymentId[] = [];
    for (const allocation of distribution.allocations) {
      assertCents(allocation.amountCents, `allocation for ${allocation.investor.id}`);

      if (allocation.amountCents > this.config.perPaymentMaxCents) {
        throw new RangeError(
          `payment for ${allocation.investor.id} (${allocation.amountCents}¢) exceeds per-payment max`,
        );
      }

      const key = buildIdempotencyKey(distribution.id, allocation.investor.id, 1);
      let payment = this.store.getPaymentByKey(key);

      if (!payment) {
        // Zero-cent allocations: log outside audit and skip per agreed-decisions.md #13.
        if (allocation.amountCents === 0) {
          console.log(
            `[SKIP] zero-cent allocation for investor ${allocation.investor.id}` +
            ` in distribution ${distribution.id} - no payment created`,
          );
          continue;
        }

        payment = {
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
          createdAt: this.clock.now(),
          updatedAt: this.clock.now(),
          lastSentAt: 0,
        };
        this.store.savePayment(payment);
      }

      paymentIds.push(payment.id);
    }

    // Resume any payments that were in-flight (SENDING/UNKNOWN) from a prior run.
    // Track recovered payment IDs so processPayment can route SENDING to status check
    // instead of blind resend (agreed-decisions.md #2).
    const recoveredIds = new Set<PaymentId>();
    for (const id of paymentIds) {
      const payment = this.store.getPayment(id)!;
      if (payment.state === "SENDING" || payment.state === "UNKNOWN") {
        await this.applyAndSave(payment, { type: "RECOVERY_ON_RESTART" });
        recoveredIds.add(id);
      }
    }

    // Process all non-terminal payments, draining async events after each one.
    for (const id of paymentIds) {
      const payment = this.store.getPayment(id)!;
      if (!TERMINAL_STATES.has(payment.state)) {
        await this.processPayment(payment, recoveredIds.has(id));
      }
      // Drain async events mid-run after each payment completes.
      await this.deliverAsyncEvents(paymentIds);
    }

    // Final drain for any events that arrived after the last payment.
    await this.deliverAsyncEvents(paymentIds);

    return this.buildResult(distribution.id, distribution.allocations.reduce(
      (s, a) => s + a.amountCents, 0,
    ));
  }

  // -------------------------------------------------------------------------
  // Per-payment processing
  // -------------------------------------------------------------------------

  private async processPayment(payment: Payment, isRecovered = false): Promise<void> {
    // Loop until the payment reaches a terminal state.
    // STATUS_NOT_FOUND outside the settle window can bounce UNKNOWN -> SENDING,
    // so we need to re-enter sendPayment after checkStatus in that case.
    const MAX_ITERATIONS = 1000; // hard safety cap against infinite loops
    let iterations = 0;
    // On first iteration of a recovered SENDING payment, status-check first.
    // Never blind resend on restart (agreed-decisions.md #2).
    let firstIter = true;
    while (!TERMINAL_STATES.has(payment.state)) {
      if (++iterations > MAX_ITERATIONS) {
        throw new Error(
          `processPayment exceeded ${MAX_ITERATIONS} iterations for payment ${payment.id} in state ${payment.state}  -  runner bug`,
        );
      }

      if (payment.state === "CREATED") {
        payment = await this.recordIntent(payment);
      } else if (payment.state === "SENDING") {
        if (isRecovered && firstIter) {
          // Recovery path: status check first, never blind resend.
          payment = await this.checkStatus(payment);
        } else {
          payment = await this.sendPayment(payment);
        }
      } else if (payment.state === "UNKNOWN") {
        payment = await this.checkStatus(payment);
      } else {
        throw new Error(
          `processPayment: unhandled non-terminal state ${payment.state} for payment ${payment.id}`,
        );
      }
      firstIter = false;
    }
  }

  // -------------------------------------------------------------------------
  // Intent recording
  // -------------------------------------------------------------------------

  private async recordIntent(payment: Payment): Promise<Payment> {
    if (this.config.skipIntentRecord) {
      // Break-it flag: skip the intent write but still advance state to SENDING
      // so the runner can proceed. The state transition is not persisted  -  this
      // is the bug being tested (I5 will catch the missing audit entry).
      payment = { ...payment, state: "SENDING", updatedAt: this.clock.now() };
      this.store.savePayment(payment);
    } else {
      payment = await this.applyAndSave(payment, { type: "SEND_INTENT_RECORDED" });
    }

    if (this.crashAt === "afterIntentRecorded") {
      throw new CrashInjected("afterIntentRecorded");
    }

    return payment;
  }

  // -------------------------------------------------------------------------
  // Bank send + response handling
  // -------------------------------------------------------------------------

  private async sendPayment(payment: Payment): Promise<Payment> {
    const key = this.config.newKeyOnRetry && payment.transientRetries > 0
      ? buildIdempotencyKey(payment.distributionId, payment.investorId, payment.instructionNo, payment.transientRetries)
      : payment.idempotencyKey;

    // Record lastSentAt before the bank call.
    payment = { ...payment, lastSentAt: this.clock.now() };
    this.store.savePayment(payment);

    const response = await this.bank.send(key, payment.amountCents, payment.bankDetails);

    if (this.crashAt === "afterBankCallBeforeRecord") {
      throw new CrashInjected("afterBankCallBeforeRecord");
    }

    switch (response.type) {
      case "ACCEPTED": {
        // Break-it flag: handled in deliverAsyncEvents for conflicting confirms.
        return this.applyAndSave(payment, { type: "BANK_ACCEPTED" });
      }

      case "REJECTED_PERMANENT":
        return this.applyAndSave(payment, {
          type: "BANK_REJECTED_PERMANENT",
          reason: response.reason ?? "permanent rejection",
        });

      case "REJECTED_TRANSIENT": {
        const nextRetries = payment.transientRetries + 1;
        if (nextRetries >= this.config.maxTransientRetries) {
          // Retries exhausted - use TRANSIENT_RETRIES_EXHAUSTED for accurate audit.
          payment = { ...payment, transientRetries: nextRetries };
          this.store.savePayment(payment);
          return this.applyAndSave(payment, {
            type: "TRANSIENT_RETRIES_EXHAUSTED",
            reason: `transient retries exhausted after ${nextRetries} attempts`,
          });
        }
        // Stay SENDING, increment retry count, then retry after backoff.
        payment = await this.applyAndSave(payment, {
          type: "BANK_REJECTED_TRANSIENT",
          reason: response.reason ?? "transient rejection",
        });
        payment = { ...payment, transientRetries: nextRetries };
        this.store.savePayment(payment);
        await this.backoff(nextRetries);
        return this.sendPayment(payment);
      }

      case "TIMEOUT": {
        if (this.config.timeoutAsFailure) {
          // Break-it flag: treat timeout as permanent failure.
          return this.applyAndSave(payment, {
            type: "BANK_REJECTED_PERMANENT",
            reason: "timeout treated as failure (timeoutAsFailure flag)",
          });
        }
        return this.applyAndSave(payment, { type: "BANK_TIMEOUT" });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Status check polling
  // -------------------------------------------------------------------------

  private async checkStatus(payment: Payment): Promise<Payment> {
    if (this.config.resendWithoutStatusCheck) {
      // Break-it flag: skip the status query and *assume* the key was never
      // received, then resend it. The assumption goes through the legal
      // UNKNOWN -> SENDING transition, so the bug is a real double payment that
      // I1 catches rather than an illegal BANK_ACCEPTED-in-UNKNOWN throw (the
      // state machine refuses that event by design: a late accept must arrive
      // as ASYNC_CONFIRM).
      const resent = payment.state === "UNKNOWN"
        ? await this.applyAndSave(payment, {
            type: "STATUS_NOT_FOUND",
            reason: "resendWithoutStatusCheck: assumed NOT_FOUND without querying the bank",
          })
        : payment;
      return this.sendPayment(resent);
    }

    if (payment.statusChecks >= this.config.maxStatusChecks) {
      return this.applyAndSave(payment, { type: "CHECKS_EXHAUSTED" });
    }

    if (this.crashAt === "duringStatusCheck") {
      throw new CrashInjected("duringStatusCheck");
    }

    const response = await this.bank.getStatus(payment.idempotencyKey);

    // Increment check count before applying the event.
    payment = { ...payment, statusChecks: payment.statusChecks + 1 };
    this.store.savePayment(payment);

    switch (response.type) {
      case "CONFIRMED":
        return this.applyAndSave(payment, { type: "STATUS_CONFIRMED" });

      case "FAILED":
        return this.applyAndSave(payment, {
          type: "STATUS_FAILED",
          reason: response.reason ?? "bank status: failed",
        });

      case "TIMEOUT":
        // Count as a check (already incremented above).
        return this.applyAndSave(payment, { type: "BANK_TIMEOUT" });

      case "NOT_FOUND": {
        const age = this.clock.now() - payment.lastSentAt;
        const insideWindow = age < this.config.settleWindowMs;

        if (payment.state === "SENDING") {
          // Inside window: go UNKNOWN and wait.
          if (insideWindow) {
            return this.applyAndSave(payment, { type: "STATUS_NOT_FOUND" });
          }
          // Outside window while in SENDING: resend same key.
          return this.sendPayment(payment);
        }

        // UNKNOWN state.
        if (insideWindow) {
          // Stay UNKNOWN - inside settle window, wait for bank to settle.
          // Sleeping the remaining window is what makes the window elapse at
          // all: without it the next check happens at the same instant, burns
          // the status-check budget and the payment never reaches a resend (R3).
          const waiting = await this.applyAndSave(payment, { type: "STATUS_NOT_FOUND_IN_WINDOW" });
          await this.clock.sleep(this.config.settleWindowMs - age);
          return waiting;
        }
        // Outside window: move back to SENDING for resend.
        return this.applyAndSave(payment, { type: "STATUS_NOT_FOUND" });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Async event delivery
  // -------------------------------------------------------------------------

  /**
   * Drain async events from the bank and apply them to the relevant payments.
   * Normal path: ASYNC_CONFIRM on SENDING/UNKNOWN -> CONFIRMED (via state machine).
   *
   * overwriteConflictingConfirm break-it flag:
   *   When ASYNC_CONFIRM arrives for a payment in FAILED or MANUAL_REVIEW,
   *   write CONFIRMED directly to the store WITHOUT going through applyEvent
   *   or the audit log. This skips the MR! cell that should fire, breaking I5
   *   (audit toState != store state) and I4 (our confirmed set diverges from
   *   what the state machine recorded).
   */
  private async deliverAsyncEvents(paymentIds: PaymentId[]): Promise<void> {
    if (!this.bank.drainAsyncEvents) return;
    const events = this.bank.drainAsyncEvents();
    if (events.length === 0) return;

    // Build a lookup from idempotency key -> paymentId.
    const keyToId = new Map<IdempotencyKey, PaymentId>();
    for (const id of paymentIds) {
      const p = this.store.getPayment(id);
      if (p) keyToId.set(p.idempotencyKey, id);
    }

    for (const ev of events) {
      const id = keyToId.get(ev.key);
      if (!id) {
        // Bank reports a payment we never sent - log an alert audit entry.
        this.store.appendAudit({
          paymentId: `unknown:${ev.key}`,
          distributionId: "unknown",
          investorId: "unknown",
          event: ev.type,
          fromState: "CREATED",
          toState: "MANUAL_REVIEW",
          reason: `unknown key ${ev.key} - bank event for payment not in this distribution`,
          timestamp: this.clock.now(),
        });
        console.error(`[ALERT] async event ${ev.type} for unknown key ${ev.key}`);
        continue;
      }
      const payment = this.store.getPayment(id);
      if (!payment) continue;

      if (ev.type === "ASYNC_CONFIRM") {
        // Break-it flag: if payment is in FAILED or MANUAL_REVIEW and flag is on,
        // silently overwrite to CONFIRMED without audit entry.
        if (
          this.config.overwriteConflictingConfirm &&
          (payment.state === "FAILED" || payment.state === "MANUAL_REVIEW")
        ) {
          const overwritten: Payment = {
            ...payment,
            state: "CONFIRMED",
            updatedAt: this.clock.now(),
          };
          this.store.savePayment(overwritten);
          // No audit entry  -  this is the bug.
          continue;
        }
        // Normal path: apply through state machine (MR! for FAILED, hold for MANUAL_REVIEW).
        await this.applyAndSave(payment, { type: "ASYNC_CONFIRM" });
      } else {
        await this.applyAndSave(payment, {
          type: "ASYNC_FAILURE",
          reason: "async failure from bank",
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async applyAndSave(payment: Payment, event: PaymentEvent): Promise<Payment> {
    const result = applyEvent(payment, event, this.clock);

    const updated: Payment = {
      ...payment,
      state: result.toState,
      updatedAt: this.clock.now(),
    };

    this.store.transition(updated, result.auditEntry);

    if (result.alert) {
      this.onAlert(result.auditEntry);
    }

    return updated;
  }

  private appendAudit(entry: AuditEntry): void {
    this.store.appendAudit(entry);
  }

  /** Backoff with jitter: base * 2^(attempt-1) * (0.5 + 0.5 * rng.next()). */
  private async backoff(attempt: number): Promise<void> {
    const base = this.config.backoffBaseMs * Math.pow(2, attempt - 1);
    const jitter = 0.5 + 0.5 * this.rng.next();
    const delay = Math.round(base * jitter);
    await this.clock.sleep(delay);
  }

  private onAlert(entry: AuditEntry): void {
    // Phase 1: log to stderr. Phase N: hook into alerting system.
    console.error(
      `[ALERT] payment ${entry.paymentId} escalated to MANUAL_REVIEW` +
      ` (event: ${entry.event}, from: ${entry.fromState})` +
      ` reason: ${entry.reason ?? "none"}`,
    );
  }

  private buildResult(distributionId: string, totalAllocatedCents: Cents): RunResult {
    const payments = this.store.listPayments(distributionId);
    const exceptions: PaymentId[] = [];
    let confirmedCents = 0;
    let failedCents = 0;
    let manualReviewCents = 0;

    for (const p of payments) {
      if (p.state === "MANUAL_REVIEW") {
        exceptions.push(p.id);
        manualReviewCents += p.amountCents;
      } else if (p.state === "FAILED") {
        exceptions.push(p.id);
        failedCents += p.amountCents;
      } else if (p.state === "CONFIRMED") {
        confirmedCents += p.amountCents;
      }
    }

    return {
      distributionId,
      status: exceptions.length === 0 ? "COMPLETED" : "COMPLETED_WITH_EXCEPTIONS",
      exceptions,
      totalAllocatedCents,
      totalConfirmedCents: confirmedCents,
      totalFailedCents: failedCents,
      totalManualReviewCents: manualReviewCents,
    };
  }
}

// ---------------------------------------------------------------------------
// Idempotency key + payment ID construction
// ---------------------------------------------------------------------------

export function buildIdempotencyKey(
  distributionId: string,
  investorId: string,
  instructionNo: number,
  retryNo = 0,
): IdempotencyKey {
  // retryNo is only non-zero when newKeyOnRetry break-it flag is active.
  const input = `${distributionId}:${investorId}:${instructionNo}:${retryNo}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

export function buildPaymentId(distributionId: string, investorId: string): PaymentId {
  return `pay:${distributionId}:${investorId}`;
}
