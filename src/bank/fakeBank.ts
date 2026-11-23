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
   * rolls fresh regardless of prior outcomes, and each settling send counts as
   * a separate transfer in getSettlementsByAccount(). Default true.
   * Set to false for break-it tests that need to exercise double-settlement.
   */
  dedupe: boolean;
  /**
   * Number of status checks that return NOT_FOUND before the bank reveals the
   * real outcome. Simulates a bank that accepts but lags on status visibility.
   * Default 0 (no lag).
   */
  lagChecks: number;
  /**
   * 0-1 probability that a notification (ASYNC_CONFIRM / ASYNC_FAILURE) is lost
   * before it ever reaches us. Real banks lose webhooks; the money has still
   * moved, so only a status query can reveal the truth. Default 0 - every event
   * is delivered, which is the only behaviour when no delay is set.
   */
  asyncDropRate: number;
  /**
   * Deliver a notification only after this many status queries for its key: the
   * bank knows the outcome but tells us late. Default 0 (delivered on the first
   * drain).
   */
  asyncDelayChecks: number;
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
  lagChecks: 0,
  asyncDropRate: 0,
  asyncDelayChecks: 0,
};

// ---------------------------------------------------------------------------
// Async event (ASYNC_CONFIRM or ASYNC_FAILURE) queued by the bank
// ---------------------------------------------------------------------------

export interface AsyncBankEvent {
  key: IdempotencyKey;
  type: "ASYNC_CONFIRM" | "ASYNC_FAILURE";
}

/** Queued event plus the status-query count at which it becomes deliverable. */
interface QueuedAsyncEvent extends AsyncBankEvent {
  readyAtQueryCount: number;
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

/** One transfer the bank actually made. */
interface Settlement {
  key: IdempotencyKey;
  amountCents: Cents;
  bankDetails: string;
}

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
  /**
   * Every transfer made, one entry per settling send - deliberately not keyed.
   * records is one-per-key, so resending a settled key overwrites the earlier
   * transfer and hides it. That is the same "double settlement invisible via a
   * Map" blind spot closed for distinct keys, still open for one key sent
   * twice. Only populated when dedupe=false (see recordSettlement).
   */
  private readonly settlementLedger: Settlement[] = [];
  private readonly asyncQueue: QueuedAsyncEvent[] = [];
  private readonly lagCheckCounts = new Map<IdempotencyKey, number>();
  /** Status queries per key - gates delivery when asyncDelayChecks > 0. */
  private readonly queryCounts = new Map<IdempotencyKey, number>();
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
        this.recordSettlement(key, amountCents, bankDetails);
        this.queueAsync(key, "ASYNC_CONFIRM");
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
      // A timed-out send can still have moved the money - that is what makes a
      // later blind resend a second transfer.
      if (asyncResolution === "CONFIRMED") this.recordSettlement(key, amountCents, bankDetails);
      // Queue ASYNC_CONFIRM/ASYNC_FAILURE so the runner receives late notification.
      // A lost notification (asyncDropRate) is simply never queued.
      this.queueAsync(key, asyncResolution === "CONFIRMED" ? "ASYNC_CONFIRM" : "ASYNC_FAILURE");
      return { type: "TIMEOUT" };
    }

    this.records.set(key, { outcome: "ACCEPTED", amountCents, bankDetails, asyncResolution: null });
    this.recordSettlement(key, amountCents, bankDetails);
    // Optionally queue a duplicate confirm (simulates late duplicate from bank).
    if (this.rng.next() < this.config.duplicateConfirmRate) {
      this.queueAsync(key, "ASYNC_CONFIRM");
    }
    return { type: "ACCEPTED" };
  }

  // -------------------------------------------------------------------------
  // Bank.getStatus
  // -------------------------------------------------------------------------

  async getStatus(key: IdempotencyKey): Promise<BankStatusResponse> {
    // Count every query, whatever it answers: a delayed notification is
    // released once the bank has been asked this many times for that key.
    this.queryCounts.set(key, (this.queryCounts.get(key) ?? 0) + 1);

    if (!this.config.statusQueryEnabled) {
      return { type: "NOT_FOUND" };
    }

    const timeoutR = this.rng.next();
    if (timeoutR < this.config.statusTimeoutRate) {
      return { type: "TIMEOUT" };
    }

    // Lag mode: return NOT_FOUND for the first N checks, then reveal truth.
    if (this.config.lagChecks > 0) {
      const count = this.lagCheckCounts.get(key) ?? 0;
      if (count < this.config.lagChecks) {
        this.lagCheckCounts.set(key, count + 1);
        return { type: "NOT_FOUND" };
      }
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

    // No bank-side key dedupe: count actual transfers, so a resend of an already
    // settled key shows up as a second settlement instead of overwriting it.
    if (!this.config.dedupe) {
      for (const settlement of this.settlementLedger) {
        const existing = byAccount.get(settlement.bankDetails);
        if (existing) {
          existing.totalCents += settlement.amountCents;
          existing.sendCount++;
        } else {
          byAccount.set(settlement.bankDetails, {
            totalCents: settlement.amountCents,
            sendCount: 1,
          });
        }
      }
      return byAccount;
    }

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

  /**
   * Return the notifications that are deliverable now.
   *
   * With asyncDelayChecks > 0 an event stays queued until the key has been
   * status-queried that many times, so the caller really queries the bank first
   * and the notification arrives late - which is what a lost or slow webhook
   * looks like from our side.
   */
  drainAsyncEvents(): AsyncBankEvent[] {
    const ready: AsyncBankEvent[] = [];
    for (let i = this.asyncQueue.length - 1; i >= 0; i--) {
      const ev = this.asyncQueue[i]!;
      const readyAt = ev.readyAtQueryCount ?? 0;
      if ((this.queryCounts.get(ev.key) ?? 0) >= readyAt) {
        ready.push({ key: ev.key, type: ev.type });
        this.asyncQueue.splice(i, 1);
      }
    }
    return ready.reverse();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Append one transfer to the settlement ledger.
   * Only when dedupe=false: with the bank's idempotency on, runs rely on the
   * key record and must keep the old one-row-per-key accounting.
   */
  private recordSettlement(key: IdempotencyKey, amountCents: Cents, bankDetails: string): void {
    if (this.config.dedupe) return;
    this.settlementLedger.push({ key, amountCents, bankDetails });
  }

  /**
   * Queue one notification, applying the two delivery failure modes.
   * The Rng is only drawn when a rate is non-zero, so every existing config
   * keeps the exact stream - and therefore the exact outcomes - it had before.
   */
  private queueAsync(key: IdempotencyKey, type: AsyncBankEvent["type"]): void {
    if (this.config.asyncDropRate > 0 && this.rng.next() < this.config.asyncDropRate) {
      return; // notification lost in transit
    }
    this.asyncQueue.push({
      key,
      type,
      readyAtQueryCount: (this.queryCounts.get(key) ?? 0) + this.config.asyncDelayChecks,
    });
  }

  private isSettled(record: KeyRecord): boolean {
    return (
      record.outcome === "ACCEPTED" ||
      record.outcome === "LYING_TRANSIENT" ||
      (record.outcome === "TIMEOUT" && record.asyncResolution === "CONFIRMED")
    );
  }
}
