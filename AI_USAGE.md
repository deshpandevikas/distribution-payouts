# AI_USAGE.md

Record of where AI was used, what it proposed, what was accepted or changed, and why.

---

## Phase 1 — Design conversation (pre-implementation)

**What the AI proposed:**
- Full state machine transition grid (states, events, cell-by-cell behavior)
- Idempotency key scheme (hash of distributionId + investorId + instructionNo)
- Allocation algorithm (pro rata, largest remainder, tie-break by investorId)
- Error class taxonomy (permanent / transient / timeout)
- Harness structure (checker reads only outputs; crash injection points; break-it flags)

**Two gaps found on challenge:**

1. **Auto-reissue to a bad account.** The original proposal had the runner automatically reissue a
   FAILED payment with new bank details. Challenged: who approves the new details? A bad account
   could route money to the wrong place. Resolution: reissue requires new bank details + explicit
   human approval (Phase 1.5). The runner never auto-reissues.

2. **Allocation basis hardcoded to commitment amount.** The original proposal assumed the allocation
   basis was always the investor's committed capital. Challenged: different distributions use
   different bases (committed capital, called capital, ownership units). Resolution: basis is an
   input to the allocation function, not hardcoded. Caller supplies the basis vector.

**What was accepted unchanged:**
- Transition grid cell-by-cell behavior (after review against each contested cell)
- Idempotency key scheme
- Largest-remainder allocation with investorId tie-break
- Inject Clock and RNG everywhere; no Date.now() / Math.random() in src/

**What was changed:**
- Reissue gated on human approval (see gap 1)
- Allocation basis is a parameter (see gap 2)
