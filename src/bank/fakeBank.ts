/**
 * Fake bank implementation for testing and harness runs.
 *
 * Behaviour is driven entirely by injected Rng - no Math.random() here.
 * The same seed always produces the same sequence of outcomes.
 *
 * Failure modes configurable per instance:
 *   - permanent rejection rate
 *   - transient rejection rate
 *   - timeout rate (send + status)
 *   - late async confirm rate (bank "confirms" after a timeout)
 *   - lying-transient rate: bank returns REJECTED_TRANSIENT but actually settles,
 *     then later sends ASYNC_CONFIRM (visible via drainAsyncEvents())
 *   - dedupe: if false, every send is fresh regardless of prior outcome
 *   - status query enabled / disabled
 *
 * Idempotency (when dedupe=true, the default):
 *   Only ACCEPTED and REJECTED_PERMANENT are committed outcomes.
 *   REJECTED_TRANSIENT and unresolved TIMEOUT are not committed - a retry
 *   with the same key rolls fresh, matching real bank behaviour.
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
  /** 0-1 probability of permanent rejection on a fresh send. Default 0.05. */
  permanentRejectRate: number;
  /** 0-1 probability of transient rejection on a fresh send. Default 0.1. */
  transientRejectRate: number;
  /** 0-1 probability of timeout on a fresh send. Default 0.1. */
  timeoutRate: number;
  /** 0-1 probability that a timed-out send eventually async-confirms. Default 0.5. */
  asyncConfirmRate: number;
  /** 0-1 probability of timeout on a status query. Default 0.05. */
  statusTimeoutRate: number;
  /** If false, getStatus() always returns NOT_FOUND. Default true. */
  statusQueryEnabled: boolean;
  /**
   * 0-1 probability that a transient rejection actually settled at the bank
   * and will produce an ASYNC_CONFIRM later (lying transient). Default 0.
   */
  lyingTransientRate: number;
  /**
   * 0-1 probability that an ACCEPTED send also queues a duplicate ASYNC_CONFIRM
   * (simulates late duplicate confirmation from bank). Default 0.
   */
  duplicateConfirmRate: number;
  /**
   * If false, the bank does not deduplicate on idempotency key - every send
   * rolls fresh regardless of prior outcomes. Default true.
   * Set to false for break-it tests that need to exercise double-settlement.
   */
  dedupe: boolean;
}

export const DEFAULT_FAKE_BANK_CONFIG: FakeBankConfig = {
  permanentRejectRate: 0.05,
  transientRejectRate: 0.10,
  timeoutRate: 0.10,
  asyncConfirmRate: 0.50,
  statusTimeoutRate: 0.05,
  statusQueryEnabled: true,
  lyingTransientRate: 0,
  duplicateConfirmRate: 0,
  dedupe: true,
};

// ---------------------------------------------------------------------------
// Async event (ASYNC_CONFIRM or ASYNC_FAILURE) queued by the bank
// ---------------------------------------------------------------------------

export interface AsyncBankEvent {
  key: IdempotencyKey;
  type: "ASYNC_CONFIRM" | "ASYNC_FAILURE";
}

// ---------------------------------------------------------------------------
// Per-account settlement record (for I1 checker)
// ---------------------------------------------------------------------------

export interface AccountSettlement {
  /** Total cents settled to this account across all keys. */
  totalCents: Cents;
  /** Number of distinct sends that settled to this account. */
  sendCount: number;
}

// ---------------------------------------------------------------------------
// Internal record per idempotency key
// ---------------------------------------------------------------------------

type SettledOutcome = "ACCEPTED" | "REJECTED_PERMANENT" | "REJECTED_TRANSIENT" | "LYING_TRANSIENT";

interface KeyRecord {
  outcome: SettledOutcome | "TIMEOUT";
  amountCents: Cents;
  bankDetails: string;
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
    bankDetails: string,
  ): Promise<BankSendResponse> {
    if (this.config.dedupe) {
      const existing = this.records.get(key);
      if (existing) {
        if (existing.outcome === "ACCEPTED") {
          return { type: "ACCEPTED" };
        }
        if (existing.outcome === "REJECTED_PERMANENT") {
          return { type: "REJECTED_PERMANENT", reason: "fake-bank: permanent rejection (replay)" };
        }
        // REJECTED_TRANSIENT, LYING_TRANSIENT, TIMEOUT: not committed, roll fresh.
        // Cancel any pending async events for this key since it's being retried.
        const idx = this.asyncQueue.findIndex(e => e.key === key);
        if (idx !== -1) this.asyncQueue.splice(idx, 1);
        this.records.delete(key);
      }
    }

    // Roll outcomes.
    const r = this.rng.next();
    const { permanentRejectRate, transientRejectRate, timeoutRate } = this.config;

    if (r < permanentRejectRate) {
      this.records.set(key, { outcome: "REJECTED_PERMANENT", amountCents, bankDetails, asyncResolution: null });
      return { type: "REJECTED_PERMANENT", reason: "fake-bank: permanent rejection" };
    }

    if (r < permanentRejectRate + transientRejectRate) {
      const lyingR = this.rng.next();
      if (lyingR < this.config.lyingTransientRate) {
        this.records.set(key, { outcome: "LYING_TRANSIENT", amountCents, bankDetails, asyncResolution: "CONFIRMED" });
        this.asyncQueue.push({ key, type: "ASYNC_CONFIRM" });
      } else {
        this.records.set(key, { outcome: "REJECTED_TRANSIENT", amountCents, bankDetails, asyncResolution: null });
      }
      return { type: "REJECTED_TRANSIENT", reason: "fake-bank: transient rejection" };
    }

    if (r < permanentRejectRate + transientRejectRate + timeoutRate) {
      const asyncR = this.rng.next();
      const asyncResolution: "CONFIRMED" | "FAILED" =
        asyncR < this.config.asyncConfirmRate ? "CONFIRMED" : "FAILED";
      this.records.set(key, { outcome: "TIMEOUT", amountCents, bankDetails, asyncResolution });
      // Queue ASYNC_CONFIRM/ASYNC_FAILURE so the runner receives late notification.
      this.asyncQueue.push({ key, type: asyncResolution === "CONFIRMED" ? "ASYNC_CONFIRM" : "ASYNC_FAILURE" });
      return { type: "TIMEOUT" };
    }

    this.records.set(key, { outcome: "ACCEPTED", amountCents, bankDetails, asyncResolution: null });
    // Optionally queue a duplicate confirm (simulates late duplicate from bank).
    if (this.rng.next() < this.config.duplicateConfirmRate) {
      this.asyncQueue.push({ key, type: "ASYNC_CONFIRM" });
    }
    return { type: "ACCEPTED" };
  }

  // -------------------------------------------------------------------------
  // Bank.getStatus
  // -------------------------------------------------------------------------

  async getStatus(key: IdempotencyKey): Promise<BankStatusResponse> {
    if (!this.config.statusQueryEnabled) {
      return { type: "NOT_FOUND" };
    }

    const timeoutR = this.rng.next();
    if (timeoutR < this.config.statusTimeoutRate) {
      return { type: "TIMEOUT" };
    }

    const record = this.records.get(key);
    if (!record) {
      return { type: "NOT_FOUND" };
    }

    switch (record.outcome) {
      case "ACCEPTED":        return { type: "CONFIRMED" };
      case "REJECTED_PERMANENT": return { type: "FAILED", reason: "fake-bank: permanent rejection" };
      case "REJECTED_TRANSIENT": return { type: "NOT_FOUND" };
      case "LYING_TRANSIENT": return { type: "CONFIRMED" };
      case "TIMEOUT":
        return record.asyncResolution === "CONFIRMED"
          ? { type: "CONFIRMED" }
          : { type: "FAILED", reason: "fake-bank: async failure after timeout" };
    }
  }

  // -------------------------------------------------------------------------
  // Bank.getSettledKeys - for reconciliation
  // -------------------------------------------------------------------------

  getSettledKeys(): ReadonlyMap<IdempotencyKey, Cents> {
    const settled = new Map<IdempotencyKey, Cents>();
    for (const [key, record] of this.records) {
      if (this.isSettled(record)) {
        settled.set(key, record.amountCents);
      }
    }
    return settled;
  }

  // -------------------------------------------------------------------------
  // Per-account settlement view - for checker I1
  // -------------------------------------------------------------------------

  /**
   * Returns total settled cents and send count per bankDetails account string.
   * The checker uses this to verify no account received more than its allocation.
   */
  getSettlementsByAccount(): ReadonlyMap<string, AccountSettlement> {
    const byAccount = new Map<string, AccountSettlement>();
    for (const record of this.records.values()) {
      if (this.isSettled(record)) {
        const existing = byAccount.get(record.bankDetails);
        if (existing) {
          existing.totalCents += record.amountCents;
          existing.sendCount++;
        } else {
          byAccount.set(record.bankDetails, { totalCents: record.amountCents, sendCount: 1 });
        }
      }
    }
    return byAccount;
  }

  // -------------------------------------------------------------------------
  // Async event delivery
  // -------------------------------------------------------------------------

  drainAsyncEvents(): AsyncBankEvent[] {
    return this.asyncQueue.splice(0);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private isSettled(record: KeyRecord): boolean {
    return (
      record.outcome === "ACCEPTED" ||
      record.outcome === "LYING_TRANSIENT" ||
      (record.outcome === "TIMEOUT" && record.asyncResolution === "CONFIRMED")
    );
  }
}
