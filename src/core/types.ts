/**
 * Shared types for the distribution payout runner.
 *
 * All monetary values are integer cents (USD). Never floats.
 * All sources of time and randomness are injected via Clock and Rng.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Integer cents, non-negative, safe-integer. Use assertCents() to validate. */
export type Cents = number;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type DistributionId = string;
export type InvestorId = string;
export type PaymentId = string;
export type IdempotencyKey = string;

// ---------------------------------------------------------------------------
// Payment states
// ---------------------------------------------------------------------------

export type PaymentState =
  | "CREATED"
  | "SENDING"
  | "CONFIRMED"
  | "FAILED"
  | "UNKNOWN"
  | "MANUAL_REVIEW";

/** States from which no further automated transition is possible. */
export const TERMINAL_STATES: ReadonlySet<PaymentState> = new Set([
  "CONFIRMED",
  "FAILED",
  "MANUAL_REVIEW",
]);

// ---------------------------------------------------------------------------
// Events (what the state machine acts on)
// ---------------------------------------------------------------------------

export type PaymentEvent =
  | { type: "SEND_INTENT_RECORDED" }
  | { type: "BANK_ACCEPTED" }
  | { type: "BANK_REJECTED_PERMANENT"; reason: string }
  | { type: "BANK_REJECTED_TRANSIENT"; reason: string }
  | { type: "BANK_TIMEOUT" }
  | { type: "STATUS_CONFIRMED" }
  | { type: "STATUS_FAILED"; reason: string }
  | { type: "STATUS_NOT_FOUND" }
  | { type: "STATUS_NOT_FOUND_IN_WINDOW" }
  | { type: "TRANSIENT_RETRIES_EXHAUSTED"; reason: string }
  | { type: "ASYNC_CONFIRM" }
  | { type: "ASYNC_FAILURE"; reason: string }
  | { type: "CHECKS_EXHAUSTED" }
  | { type: "RECOVERY_ON_RESTART" };

// ---------------------------------------------------------------------------
// Payment record
// ---------------------------------------------------------------------------

export interface Payment {
  id: PaymentId;
  distributionId: DistributionId;
  investorId: InvestorId;
  /** Allocated amount in cents. */
  amountCents: Cents;
  idempotencyKey: IdempotencyKey;
  /** Snapshotted bank routing details at time of payment creation. */
  bankDetails: string;
  /** Increments on reissue (Phase 1.5). Always 1 in Phase 1. */
  instructionNo: number;
  state: PaymentState;
  /** Number of transient retries attempted so far. */
  transientRetries: number;
  /** Cumulative status checks performed. */
  statusChecks: number;
  createdAt: number;
  updatedAt: number;
  /** Timestamp of the most recent bank send attempt. Used for settle-window calculation. */
  lastSentAt: number;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  paymentId: PaymentId;
  distributionId: DistributionId;
  investorId: InvestorId;
  event: PaymentEvent["type"];
  fromState: PaymentState;
  toState: PaymentState;
  reason?: string;
  /** Injected wall-clock milliseconds. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Investor + Distribution
// ---------------------------------------------------------------------------

export interface Investor {
  id: InvestorId;
  /** Display name  -  always fake. */
  name: string;
  /** Bank routing details  -  opaque string in Phase 1. */
  bankDetails: string;
}

export interface AllocationInput {
  investor: Investor;
  /** Basis units (ownership units, committed capital, etc.)  -  caller supplies. */
  basisUnits: number;
}

export interface AllocatedPayment {
  investor: Investor;
  amountCents: Cents;
}

export interface Distribution {
  id: DistributionId;
  /** Total amount to distribute, in cents. */
  totalCents: Cents;
  allocations: AllocatedPayment[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Runner config
// ---------------------------------------------------------------------------

export interface RunnerConfig {
  /** Max transient retries before moving to FAILED. Default 3. */
  maxTransientRetries: number;
  /** Base backoff in ms (doubles each retry, with jitter). Default 1000. */
  backoffBaseMs: number;
  /** Settle window in ms: how long to wait before resending a NOT_FOUND. Default 120_000. */
  settleWindowMs: number;
  /** Per-payment ceiling in cents. Default 1_000_000_000 ($10M). */
  perPaymentMaxCents: Cents;
  /** Max cumulative status checks per payment before CHECKS_EXHAUSTED. Default 5. */
  maxStatusChecks: number;

  // --- "break it" flags (Phase 1 harness) ---
  /** If true, skip writing intent before bank call. Makes I5 fail. */
  skipIntentRecord: boolean;
  /** If true, treat BANK_TIMEOUT as BANK_REJECTED_PERMANENT. Makes I2 fail. */
  timeoutAsFailure: boolean;
  /** If true, generate a new idempotency key on each retry. Makes I1 fail. */
  newKeyOnRetry: boolean;
  /** If true, on ASYNC_CONFIRM arriving while payment is FAILED or MANUAL_REVIEW,
   *  write CONFIRMED directly to the store skipping applyEvent and audit log.
   *  Makes I5 fail (audit toState != store state) and I4 fail (confirmed != bank settled). */
  overwriteConflictingConfirm: boolean;
  /** If true, skip status check and resend immediately on UNKNOWN. Makes I1 fail. */
  resendWithoutStatusCheck: boolean;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  maxTransientRetries: 3,
  backoffBaseMs: 1000,
  settleWindowMs: 120_000,
  perPaymentMaxCents: 1_000_000_000,
  maxStatusChecks: 5,
  skipIntentRecord: false,
  timeoutAsFailure: false,
  newKeyOnRetry: false,
  overwriteConflictingConfirm: false,
  resendWithoutStatusCheck: false,
};

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export type RunStatus = "COMPLETED" | "COMPLETED_WITH_EXCEPTIONS";

export interface RunResult {
  distributionId: DistributionId;
  status: RunStatus;
  /** Payments that ended in MANUAL_REVIEW or could not be settled cleanly. */
  exceptions: PaymentId[];
  totalAllocatedCents: Cents;
  totalConfirmedCents: Cents;
  totalFailedCents: Cents;
  totalManualReviewCents: Cents;
}

// ---------------------------------------------------------------------------
// Injected infrastructure interfaces
// ---------------------------------------------------------------------------

/** Injected clock  -  no Date.now() in src/. */
export interface Clock {
  now(): number;
  /** Advance time by ms. Fake clock increments; real clock awaits setTimeout. */
  sleep(ms: number): Promise<void>;
}

/** Injected RNG  -  no Math.random() in src/. */
export interface Rng {
  /** Returns a float in [0, 1). */
  next(): number;
}

// ---------------------------------------------------------------------------
// Bank interface (port)
// ---------------------------------------------------------------------------

export type BankResponseType =
  | "ACCEPTED"
  | "REJECTED_PERMANENT"
  | "REJECTED_TRANSIENT"
  | "TIMEOUT";

export interface BankSendResponse {
  type: BankResponseType;
  reason?: string;
}

export type BankStatusType =
  | "CONFIRMED"
  | "FAILED"
  | "NOT_FOUND"
  | "TIMEOUT";

export interface BankStatusResponse {
  type: BankStatusType;
  reason?: string;
}

export interface Bank {
  send(key: IdempotencyKey, amountCents: Cents, bankDetails: string): Promise<BankSendResponse>;
  getStatus(key: IdempotencyKey): Promise<BankStatusResponse>;
  /** Returns all keys the bank has settled (for reconciliation). */
  getSettledKeys(): ReadonlyMap<IdempotencyKey, Cents>;
  /**
   * Optional: returns total settled cents and send count per bankDetails account string.
   * Used by checker I1 to verify no account received more than its allocation.
   */
  getSettlementsByAccount?(): ReadonlyMap<string, { totalCents: number; sendCount: number }>;
  /**
   * Optional: drain and return pending async events (ASYNC_CONFIRM / ASYNC_FAILURE).
   * Banks that don't support async events omit this method.
   */
  drainAsyncEvents?(): Array<{ key: IdempotencyKey; type: "ASYNC_CONFIRM" | "ASYNC_FAILURE" }>;
}

// ---------------------------------------------------------------------------
// Store interface (port)  -  defined here for type completeness; impl in src/store/
// ---------------------------------------------------------------------------

export interface Store {
  savePayment(payment: Payment): void;
  getPayment(id: PaymentId): Payment | undefined;
  getPaymentByKey(key: IdempotencyKey): Payment | undefined;
  listPayments(distributionId: DistributionId): Payment[];
  appendAudit(entry: AuditEntry): void;
  listAudit(distributionId: DistributionId): AuditEntry[];
}
