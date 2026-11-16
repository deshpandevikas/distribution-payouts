/**
 * Fake bank implementation for testing and harness runs.
 *
 * Behaviour is driven entirely by injected Rng  -  no Math.random() here.
 * The same seed always produces the same sequence of outcomes.
 *
 * Failure modes configurable per instance:
 *   - permanent rejection rate
 *   - transient rejection rate
 *   - timeout rate  (send + status)
 *   - late async confirm rate (bank "confirms" after a timeout)
 *   - lying-transient rate: bank returns REJECTED_TRANSIENT but actually settles,
 *     then later sends ASYNC_CONFIRM (visible via drainAsyncEvents())
 *   - status query enabled / disabled
 *
 * Idempotency: the bank records the first outcome for each key and replays
 * it on retries (deduplication). A second send with the same key that was
 * already ACCEPTED returns ACCEPTED again without double-settling.
 *
 * All data is fake. No real bank names or credentials anywhere.
 */

import type {
  Bank,
  BankSendResponse,
  BankStatusResponse,
  IdempotencyKey,
  Cents,
  Rng,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FakeBankConfig {
  /** 0–1 probability of permanent rejection on a fresh send. Default 0.05. */
  permanentRejectRate: number;
  /** 0–1 probability of transient rejection on a fresh send. Default 0.1. */
  transientRejectRate: number;
  /** 0–1 probability of timeout on a fresh send. Default 0.1. */
  timeoutRate: number;
  /** 0–1 probability that a timed-out send eventually async-confirms. Default 0.5. */
  asyncConfirmRate: number;
  /** 0–1 probability of timeout on a status query. Default 0.05. */
  statusTimeoutRate: number;
  /** If false, getStatus() always returns NOT_FOUND (simulates no status endpoint). Default true. */
  statusQueryEnabled: boolean;
  /**
   * 0–1 probability that a transient rejection actually settled at the bank
   * and will produce an ASYNC_CONFIRM later (lying transient). Default 0.
   * When this fires, getStatus() returns CONFIRMED and the key appears in getSettledKeys().
   */
  lyingTransientRate: number;
}

export const DEFAULT_FAKE_BANK_CONFIG: FakeBankConfig = {
  permanentRejectRate: 0.05,
  transientRejectRate: 0.10,
  timeoutRate: 0.10,
  asyncConfirmRate: 0.50,
  statusTimeoutRate: 0.05,
  statusQueryEnabled: true,
  lyingTransientRate: 0,
};

// ---------------------------------------------------------------------------
// Async event (ASYNC_CONFIRM or ASYNC_FAILURE) queued by the bank
// ---------------------------------------------------------------------------

export interface AsyncBankEvent {
  key: IdempotencyKey;
  type: "ASYNC_CONFIRM" | "ASYNC_FAILURE";
}

// ---------------------------------------------------------------------------
// Internal record per idempotency key
// ---------------------------------------------------------------------------

type SettledOutcome = "ACCEPTED" | "REJECTED_PERMANENT" | "REJECTED_TRANSIENT" | "LYING_TRANSIENT";

interface KeyRecord {
  /** The outcome the bank committed to on the first send. */
  outcome: SettledOutcome | "TIMEOUT";
  amountCents: Cents;
  /**
   * For TIMEOUT outcomes: did the bank eventually settle this async?
   * Determined at send time, revealed on getStatus().
   */
  asyncResolution: "CONFIRMED" | "FAILED" | null;
}

// ---------------------------------------------------------------------------
// FakeBank
// ---------------------------------------------------------------------------

export class FakeBank implements Bank {
  private readonly records = new Map<IdempotencyKey, KeyRecord>();
  private readonly asyncQueue: AsyncBankEvent[] = [];
  private readonly rng: Rng;
  private readonly config: FakeBankConfig;

  constructor(rng: Rng, config: Partial<FakeBankConfig> = {}) {
    this.rng = rng;
    this.config = { ...DEFAULT_FAKE_BANK_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Bank.send
  // -------------------------------------------------------------------------

  async send(
    key: IdempotencyKey,
    amountCents: Cents,
    _bankDetails: string,
  ): Promise<BankSendResponse> {
    // Idempotency: replay committed outcome.
    const existing = this.records.get(key);
    if (existing) {
      return this.replaySend(existing);
    }

    // Fresh send  -  roll outcomes.
    const r = this.rng.next();
    const { permanentRejectRate, transientRejectRate, timeoutRate } = this.config;

    if (r < permanentRejectRate) {
      this.records.set(key, { outcome: "REJECTED_PERMANENT", amountCents, asyncResolution: null });
      return { type: "REJECTED_PERMANENT", reason: "fake-bank: permanent rejection" };
    }

    if (r < permanentRejectRate + transientRejectRate) {
      // Check if this transient rejection is actually a lying transient.
      const lyingR = this.rng.next();
      if (lyingR < this.config.lyingTransientRate) {
        // Bank actually settled but lies to us. Queue ASYNC_CONFIRM for later delivery.
        this.records.set(key, { outcome: "LYING_TRANSIENT", amountCents, asyncResolution: "CONFIRMED" });
        this.asyncQueue.push({ key, type: "ASYNC_CONFIRM" });
      } else {
        this.records.set(key, { outcome: "REJECTED_TRANSIENT", amountCents, asyncResolution: null });
      }
      return { type: "REJECTED_TRANSIENT", reason: "fake-bank: transient rejection" };
    }

    if (r < permanentRejectRate + transientRejectRate + timeoutRate) {
      // Decide async resolution now (deterministic, same seed = same harness run).
      const asyncR = this.rng.next();
      const asyncResolution: "CONFIRMED" | "FAILED" =
        asyncR < this.config.asyncConfirmRate ? "CONFIRMED" : "FAILED";
      this.records.set(key, { outcome: "TIMEOUT", amountCents, asyncResolution });
      return { type: "TIMEOUT" };
    }

    // Happy path: accepted and settled.
    this.records.set(key, { outcome: "ACCEPTED", amountCents, asyncResolution: null });
    return { type: "ACCEPTED" };
  }

  // -------------------------------------------------------------------------
  // Bank.getStatus
  // -------------------------------------------------------------------------

  async getStatus(key: IdempotencyKey): Promise<BankStatusResponse> {
    if (!this.config.statusQueryEnabled) {
      return { type: "NOT_FOUND" };
    }

    // Status endpoint itself can time out.
    const timeoutR = this.rng.next();
    if (timeoutR < this.config.statusTimeoutRate) {
      return { type: "TIMEOUT" };
    }

    const record = this.records.get(key);
    if (!record) {
      return { type: "NOT_FOUND" };
    }

    switch (record.outcome) {
      case "ACCEPTED":
        return { type: "CONFIRMED" };
      case "REJECTED_PERMANENT":
        return { type: "FAILED", reason: "fake-bank: permanent rejection" };
      case "REJECTED_TRANSIENT":
        // A normal transient reject means the bank never processed it.
        return { type: "NOT_FOUND" };
      case "LYING_TRANSIENT":
        // The bank settled despite lying  -  status reveals the truth.
        return { type: "CONFIRMED" };
      case "TIMEOUT":
        if (record.asyncResolution === "CONFIRMED") {
          return { type: "CONFIRMED" };
        }
        return { type: "FAILED", reason: "fake-bank: async failure after timeout" };
    }
  }

  // -------------------------------------------------------------------------
  // Bank.getSettledKeys  -  for reconciliation
  // -------------------------------------------------------------------------

  getSettledKeys(): ReadonlyMap<IdempotencyKey, Cents> {
    const settled = new Map<IdempotencyKey, Cents>();
    for (const [key, record] of this.records) {
      if (
        record.outcome === "ACCEPTED" ||
        record.outcome === "LYING_TRANSIENT" ||
        (record.outcome === "TIMEOUT" && record.asyncResolution === "CONFIRMED")
      ) {
        settled.set(key, record.amountCents);
      }
    }
    return settled;
  }

  // -------------------------------------------------------------------------
  // Async event delivery  -  runner calls this after processing all payments
  // -------------------------------------------------------------------------

  /**
   * Drain and return all pending async events (ASYNC_CONFIRM / ASYNC_FAILURE).
   * Called by the runner after each payment completes to deliver late bank signals.
   */
  drainAsyncEvents(): AsyncBankEvent[] {
    return this.asyncQueue.splice(0);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private replaySend(record: KeyRecord): BankSendResponse {
    switch (record.outcome) {
      case "ACCEPTED":
        return { type: "ACCEPTED" };
      case "REJECTED_PERMANENT":
        return { type: "REJECTED_PERMANENT", reason: "fake-bank: permanent rejection (replay)" };
      case "REJECTED_TRANSIENT":
      case "LYING_TRANSIENT":
        return { type: "REJECTED_TRANSIENT", reason: "fake-bank: transient rejection (replay)" };
      case "TIMEOUT":
        return { type: "TIMEOUT" };
    }
  }
}
