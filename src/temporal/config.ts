/** Shared Temporal configuration. One workflow per distribution, one task queue. */

export const WORKFLOW_TASK_QUEUE = "distribution-payouts";
export const DEFAULT_TEMPORAL_ADDRESS = "localhost:7233";
/** Local dev database + the bank ledger file, so a restarted worker sees the same money. */
export const DEFAULT_SQLITE_PATH = "payouts.db";
