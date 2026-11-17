/**
 * The activity surface, as types only.
 *
 * Workflow code imports this with `import type`, so nothing here is bundled
 * into the workflow sandbox: no store, no bank client, no Node imports.
 * The implementations are built in runtime.ts, where the dependencies live.
 */

import type {
  BankSendResponse,
  BankStatusResponse,
  Distribution,
  IdempotencyKey,
  Payment,
  PaymentEvent,
  PaymentId,
  RunResult,
  Cents,
} from "../core/types.js";

export interface TemporalActivities {
  /** Create missing payment records for the distribution (a store write). */
  ensurePayments(distribution: Distribution): Promise<Payment[]>;

  /** Re-read a payment. */
  loadPayment(id: PaymentId): Promise<Payment>;

  /** Apply an event through the shared transition table and persist it atomically. */
  recordEvent(id: PaymentId, event: PaymentEvent): Promise<Payment>;

  /**
   * One bank send. Returns the outcome as a value - a rejection or a timeout is
   * a business result, not an exception, so Temporal only retries this activity
   * when the worker itself fails.
   *
   * `nowMs` is the workflow's clock (Date.now() inside the workflow), passed in
   * so lastSentAt is written from the same clock the settle window is measured
   * against. An activity-side clock drifts from it, and the window is the first
   * thing to break.
   */
  sendOnce(
    id: PaymentId,
    nowMs: number,
  ): Promise<{ key: IdempotencyKey; response: BankSendResponse }>;

  /** Persist the outcome of a send, including retry/exhaustion bookkeeping. */
  recordSendResponse(
    id: PaymentId,
    key: IdempotencyKey,
    response: BankSendResponse,
  ): Promise<Payment>;

  /** One bank status query, also returned as a value. */
  getStatus(id: PaymentId): Promise<BankStatusResponse>;

  /**
   * Persist a status outcome. `nowMs` is the workflow's deterministic clock, so
   * the settle-window decision is made inside the activity from a timestamp the
   * workflow controls.
   */
  recordStatus(
    id: PaymentId,
    response: BankStatusResponse,
    nowMs: number,
  ): Promise<{ payment: Payment; waitMs: number }>;

  /** Totals for the run result, read from the store. */
  buildResult(distributionId: string, totalAllocatedCents: Cents): Promise<RunResult>;
}
