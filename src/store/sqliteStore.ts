/**
 * SQLite implementation of the Store port.
 *
 * Same external behaviour as MemoryStore, with two things it cannot fake:
 * the data outlives the process, and transition() is a real transaction.
 *
 * Durability settings matter for the crash test: WAL keeps a committed
 * transaction readable after SIGKILL, and synchronous = FULL makes the commit
 * durable before the bank call returns - otherwise "intent recorded before the
 * bank is called" would only be true in memory.
 *
 * The uniqueness the card asks for lives in the schema, not in code that could
 * be forgotten on a new call path:
 *   UNIQUE (distribution_id, investor_id)  - one payment per investor per distribution
 *   UNIQUE (idempotency_key)               - one payment per instruction at the bank
 */

import Database from "better-sqlite3";
import type {
  Store,
  Payment,
  PaymentId,
  IdempotencyKey,
  DistributionId,
  AuditEntry,
  AlertRecord,
  AlertKind,
  PaymentEvent,
  PaymentState,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  distribution_id   TEXT    NOT NULL,
  investor_id       TEXT    NOT NULL,
  amount_cents      INTEGER NOT NULL,
  idempotency_key   TEXT    NOT NULL,
  bank_details      TEXT    NOT NULL,
  instruction_no    INTEGER NOT NULL,
  state             TEXT    NOT NULL,
  transient_retries INTEGER NOT NULL,
  status_checks     INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_sent_at      INTEGER NOT NULL,
  UNIQUE (distribution_id, investor_id),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id      TEXT    NOT NULL,
  distribution_id TEXT    NOT NULL,
  investor_id     TEXT    NOT NULL,
  event           TEXT    NOT NULL,
  from_state      TEXT    NOT NULL,
  to_state        TEXT    NOT NULL,
  reason          TEXT,
  timestamp       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL,
  distribution_id TEXT    NOT NULL,
  payment_id      TEXT,
  investor_id     TEXT,
  event           TEXT,
  detail          TEXT    NOT NULL,
  timestamp       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_by_distribution ON payments (distribution_id);
CREATE INDEX IF NOT EXISTS audit_by_distribution    ON audit    (distribution_id, seq);
CREATE INDEX IF NOT EXISTS alerts_by_distribution   ON alerts   (distribution_id, seq);
`;

// ---------------------------------------------------------------------------
// Column lists (aliased to the camelCase field names the port uses)
// ---------------------------------------------------------------------------

const PAYMENT_COLUMNS = `
  id,
  distribution_id   AS distributionId,
  investor_id       AS investorId,
  amount_cents      AS amountCents,
  idempotency_key   AS idempotencyKey,
  bank_details      AS bankDetails,
  instruction_no    AS instructionNo,
  state,
  transient_retries AS transientRetries,
  status_checks     AS statusChecks,
  created_at        AS createdAt,
  updated_at        AS updatedAt,
  last_sent_at      AS lastSentAt
`;

const AUDIT_COLUMNS = `
  payment_id      AS paymentId,
  distribution_id AS distributionId,
  investor_id     AS investorId,
  event,
  from_state      AS fromState,
  to_state        AS toState,
  reason,
  timestamp
`;

const ALERT_COLUMNS = `
  kind,
  distribution_id AS distributionId,
  payment_id      AS paymentId,
  investor_id     AS investorId,
  event,
  detail,
  timestamp
`;

interface AuditRow {
  paymentId: string;
  distributionId: string;
  investorId: string;
  event: string;
  fromState: string;
  toState: string;
  reason: string | null;
  timestamp: number;
}

interface AlertRow {
  kind: string;
  distributionId: string;
  paymentId: string | null;
  investorId: string | null;
  event: string | null;
  detail: string;
  timestamp: number;
}

type Db = InstanceType<typeof Database>;

/**
 * Statement surface as better-sqlite3 actually behaves: variadic positional
 * bindings. @types/better-sqlite3 defaults prepare()'s binding generic to a
 * single value, so run(?, ?, ...) fails to type-check without this.
 */
interface Stmt {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

// ---------------------------------------------------------------------------
// SqliteStore
// ---------------------------------------------------------------------------

export class SqliteStore implements Store {
  private readonly db: Db;
  private readonly upsertPaymentStmt: Stmt;
  private readonly selectPaymentByIdStmt: Stmt;
  private readonly selectPaymentByKeyStmt: Stmt;
  private readonly selectPaymentsByDistStmt: Stmt;
  private readonly insertAuditStmt: Stmt;
  private readonly selectAuditByDistStmt: Stmt;
  private readonly insertAlertStmt: Stmt;
  private readonly selectAlertsByDistStmt: Stmt;
  private readonly writeTransition: (payment: Payment, entry: AuditEntry) => void;

  constructor(file: string) {
    this.db = new Database(file);

    // WAL survives an abrupt kill; FULL makes the commit durable before we
    // proceed to the bank call. Both are required by the F2 crash test.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(SCHEMA);

    this.upsertPaymentStmt = this.prepare(`
      INSERT INTO payments (
        id, distribution_id, investor_id, amount_cents, idempotency_key,
        bank_details, instruction_no, state, transient_retries, status_checks,
        created_at, updated_at, last_sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        distribution_id   = excluded.distribution_id,
        investor_id       = excluded.investor_id,
        amount_cents      = excluded.amount_cents,
        idempotency_key   = excluded.idempotency_key,
        bank_details      = excluded.bank_details,
        instruction_no    = excluded.instruction_no,
        state             = excluded.state,
        transient_retries = excluded.transient_retries,
        status_checks     = excluded.status_checks,
        created_at        = excluded.created_at,
        updated_at        = excluded.updated_at,
        last_sent_at      = excluded.last_sent_at
    `);

    this.selectPaymentByIdStmt = this.prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = ?`,
    );
    this.selectPaymentByKeyStmt = this.prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE idempotency_key = ?`,
    );
    this.selectPaymentsByDistStmt = this.prepare(
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE distribution_id = ? ORDER BY created_at, id`,
    );

    this.insertAuditStmt = this.prepare(`
      INSERT INTO audit (payment_id, distribution_id, investor_id, event, from_state, to_state, reason, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.selectAuditByDistStmt = this.prepare(
      `SELECT ${AUDIT_COLUMNS} FROM audit WHERE distribution_id = ? ORDER BY seq`,
    );

    this.insertAlertStmt = this.prepare(`
      INSERT INTO alerts (kind, distribution_id, payment_id, investor_id, event, detail, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.selectAlertsByDistStmt = this.prepare(
      `SELECT ${ALERT_COLUMNS} FROM alerts WHERE distribution_id = ? ORDER BY seq`,
    );

    // One transaction: the payment row and its audit row commit together or
    // not at all. This is the whole point of transition() in a durable store.
    this.writeTransition = this.db.transaction((payment: Payment, entry: AuditEntry) => {
      this.upsertPayment(payment);
      this.insertAudit(entry);
    });
  }

  /** prepare() with a statement shape that matches the runtime variadic API. */
  private prepare(sql: string): Stmt {
    return this.db.prepare(sql) as unknown as Stmt;
  }

  // -------------------------------------------------------------------------
  // Payment writes
  // -------------------------------------------------------------------------

  savePayment(payment: Payment): void {
    this.upsertPayment(payment);
  }

  private upsertPayment(payment: Payment): void {
    this.upsertPaymentStmt.run(
      payment.id,
      payment.distributionId,
      payment.investorId,
      payment.amountCents,
      payment.idempotencyKey,
      payment.bankDetails,
      payment.instructionNo,
      payment.state,
      payment.transientRetries,
      payment.statusChecks,
      payment.createdAt,
      payment.updatedAt,
      payment.lastSentAt,
    );
  }

  // -------------------------------------------------------------------------
  // Payment reads
  // -------------------------------------------------------------------------

  getPayment(id: PaymentId): Payment | undefined {
    const row = this.selectPaymentByIdStmt.get(id) as Payment | undefined;
    return row === undefined ? undefined : { ...row };
  }

  getPaymentByKey(key: IdempotencyKey): Payment | undefined {
    const row = this.selectPaymentByKeyStmt.get(key) as Payment | undefined;
    return row === undefined ? undefined : { ...row };
  }

  listPayments(distributionId: DistributionId): Payment[] {
    const rows = this.selectPaymentsByDistStmt.all(distributionId) as Payment[];
    return rows.map((row) => ({ ...row }));
  }

  // -------------------------------------------------------------------------
  // Audit log - append-only
  // -------------------------------------------------------------------------

  appendAudit(entry: AuditEntry): void {
    this.insertAudit(entry);
  }

  private insertAudit(entry: AuditEntry): void {
    this.insertAuditStmt.run(
      entry.paymentId,
      entry.distributionId,
      entry.investorId,
      entry.event,
      entry.fromState,
      entry.toState,
      entry.reason ?? null,
      entry.timestamp,
    );
  }

  listAudit(distributionId: DistributionId): AuditEntry[] {
    const rows = this.selectAuditByDistStmt.all(distributionId) as AuditRow[];
    return rows.map((row) => {
      const entry: AuditEntry = {
        paymentId: row.paymentId,
        distributionId: row.distributionId,
        investorId: row.investorId,
        event: row.event as PaymentEvent["type"],
        fromState: row.fromState as PaymentState,
        toState: row.toState as PaymentState,
        timestamp: row.timestamp,
      };
      return row.reason === null ? entry : { ...entry, reason: row.reason };
    });
  }

  // -------------------------------------------------------------------------
  // Alerts - append-only, not payment state changes
  // -------------------------------------------------------------------------

  appendAlert(record: AlertRecord): void {
    this.insertAlertStmt.run(
      record.kind,
      record.distributionId,
      record.paymentId ?? null,
      record.investorId ?? null,
      record.event ?? null,
      record.detail,
      record.timestamp,
    );
  }

  listAlerts(distributionId: DistributionId): AlertRecord[] {
    const rows = this.selectAlertsByDistStmt.all(distributionId) as AlertRow[];
    return rows.map((row) => {
      const record: AlertRecord = {
        kind: row.kind as AlertKind,
        distributionId: row.distributionId,
        detail: row.detail,
        timestamp: row.timestamp,
      };
      return {
        ...record,
        ...(row.paymentId === null ? {} : { paymentId: row.paymentId }),
        ...(row.investorId === null ? {} : { investorId: row.investorId }),
        ...(row.event === null ? {} : { event: row.event as PaymentEvent["type"] }),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Atomic transition
  // -------------------------------------------------------------------------

  transition(payment: Payment, entry: AuditEntry): void {
    this.writeTransition(payment, entry);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Close the connection. Not part of the Store port; tests and the harness use it. */
  close(): void {
    this.db.close();
  }
}
