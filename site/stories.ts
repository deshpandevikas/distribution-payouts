/**
 * The five stories on the replay page.
 *
 * The page's whole claim is that a stranger can read a sentence, press Play,
 * and see that sentence happen. So a story is data, not markup: a fixed seed, a
 * bank tuned so the named failure actually occurs, and the ending it promises.
 * `verdictFor` turns a run into the one line the page shows, using the run's own
 * numbers - never a hard-coded amount.
 *
 * All of this is plain Node so test/site-stories.test.ts can assert every
 * promise without a browser.
 */

import { centsToDisplay } from "../src/core/money.js";
import { DEFAULT_FAKE_BANK_CONFIG } from "../src/bank/fakeBank.js";
import type { FakeBankConfig } from "../src/bank/fakeBank.js";
import type { AuditEntry, Payment } from "../src/core/types.js";
import type { ReplayOptions, ReplayOutcome } from "./replay.js";

// ---------------------------------------------------------------------------
// Base bank: quiet unless a story turns one failure mode on
// ---------------------------------------------------------------------------

/**
 * Every rate at zero, every notification delivered. A story then changes only
 * the one behaviour it is about, so "the bank timed out" cannot be an accident
 * of some other failure mode.
 */
const QUIET_BANK: FakeBankConfig = {
  ...DEFAULT_FAKE_BANK_CONFIG,
  permanentRejectRate: 0,
  transientRejectRate: 0,
  lyingTransientRate: 0,
  timeoutRate: 0,
  statusTimeoutRate: 0,
  duplicateConfirmRate: 0,
  asyncConfirmRate: 1,
  asyncDropRate: 0,
  asyncDelayChecks: 0,
  lagChecks: 0,
  dedupe: true,
};

function storyOptions(
  seed: number,
  bank: Partial<FakeBankConfig>,
  flag: ReplayOptions["flag"] = "",
): ReplayOptions {
  return {
    seed,
    investors: 6,
    totalCents: 60_000,
    bank: { ...QUIET_BANK, ...bank },
    flag,
  };
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export type StoryExpectation =
  | { kind: "pass" }
  | { kind: "catch"; invariant: string }
  /** Ends at MANUAL_REVIEW: not a bug and not a pass - a person decides. */
  | { kind: "review" };

export interface Story {
  /** URL id: ?story=<id>. */
  id: string;
  title: string;
  /** Shown before Play, so the reader knows the ending to look for. */
  whatShouldHappen: string;
  options: ReplayOptions;
  expects: StoryExpectation;
}

/**
 * Seeds were chosen by running each configuration and keeping one where the
 * story happens exactly once: one timeout per payment, one investor paid twice,
 * and so on. They are pinned here, and test/site-stories.test.ts re-proves each
 * ending on every run, so a change to the bank or the runner that would make a
 * story lie fails the suite instead of quietly misleading a reader.
 */
export const STORIES: readonly Story[] = [
  {
    id: "normal-day",
    title: "Normal day",
    whatShouldHappen: "Every investor is paid once.",
    options: storyOptions(1, {}),
    expects: { kind: "pass" },
  },
  {
    id: "bank-timeout",
    title: "Bank times out",
    whatShouldHappen:
      "We don't know if the money moved, so we ask the bank before trying again. Still paid once.",
    // Every send times out, the money moved each time, and the bank's
    // notification is lost - so only a status question can reveal the truth.
    options: storyOptions(1, {
      timeoutRate: 1,
      asyncConfirmRate: 1,
      asyncDropRate: 1,
    }),
    expects: { kind: "pass" },
  },
  {
    id: "try-later",
    title: 'Bank says "try later"',
    whatShouldHappen:
      "We retry with the same payment key, so the bank can't pay twice.",
    options: storyOptions(7, { transientRejectRate: 0.55 }),
    expects: { kind: "pass" },
  },
  {
    id: "new-key-on-retry",
    title: "Bug planted: new key on retry",
    whatShouldHappen: "The bank pays someone twice. The check MUST catch it.",
    // The bank answers "try later" but had already paid (a lying transient).
    // The bug then builds a *new* key for the retry, so the bank cannot
    // recognise the second attempt as the same payment.
    options: storyOptions(32, {
      transientRejectRate: 0.3,
      lyingTransientRate: 1,
    }, "newKeyOnRetry"),
    expects: { kind: "catch", invariant: "I1" },
  },
  {
    id: "resend-without-asking",
    title: "Bug planted: resend without asking",
    whatShouldHappen:
      "Same: the bank pays someone twice, and the check MUST catch it.",
    // The money moved on a timeout. The bug resends without a status question,
    // and this bank does not deduplicate on the key - so it pays again.
    options: storyOptions(5, {
      dedupe: false,
      timeoutRate: 0.5,
      asyncConfirmRate: 1,
    }, "resendWithoutStatusCheck"),
    expects: { kind: "catch", invariant: "I1" },
  },
  {
    id: "bank-goes-quiet",
    title: "Bank goes quiet",
    whatShouldHappen:
      "We never find out whether the money moved, so it goes to a human instead of a retry.",
    // The send times out after the money moved, the bank's notification is
    // lost, and every status question times out too. After the check budget is
    // spent the payment stops: MANUAL_REVIEW is terminal by design, and no
    // amount of retrying is allowed to guess.
    options: storyOptions(10, {
      timeoutRate: 0.5,
      asyncConfirmRate: 1,
      asyncDropRate: 1,
      statusTimeoutRate: 1,
    }),
    expects: { kind: "review" },
  },
];

/** Looks up a story by its ?story= id. Unknown ids return undefined, never throw. */
export function storyById(id: string | null | undefined): Story | undefined {
  if (id === null || id === undefined) return undefined;
  return STORIES.find((story) => story.id === id);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export interface Verdict {
  /** pass = green, catch = red, review = amber (a human owns the money). */
  tone: "pass" | "catch" | "review";
  headline: string;
}

function times(count: number): string {
  if (count === 0) return "never";
  if (count === 1) return "once";
  if (count === 2) return "twice";
  return `${count} times`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * The one line the page shows after a run, in words a stranger can act on.
 *
 * Order matters: money that left twice is the headline even when the checker
 * also reports a bookkeeping violation, because "inv-4 was paid twice" is the
 * consequence and "I4" is only the name of the guard that noticed.
 */
export function verdictFor(story: Story, outcome: ReplayOutcome): Verdict {
  const rows = paymentRows(outcome);
  const planted = story.expects.kind === "catch"
    ? " This is the bug we planted."
    : "";

  const overpaid = rows
    .filter((row) => row.amountCents > 0 && row.paidTimes > 1)
    .sort((a, b) => (b.paidCents - b.amountCents) - (a.paidCents - a.amountCents))[0];
  if (overpaid) {
    const extra = overpaid.paidCents - overpaid.amountCents;
    return {
      tone: "catch",
      headline:
        `Caught: ${overpaid.investorId} was paid ${times(overpaid.paidTimes)}` +
        ` (${centsToDisplay(extra)} extra).${planted}`,
    };
  }

  // A payment nobody can resolve is not a pass and not a catch: the money may
  // have moved, and the design says a person decides. Said before `missed`,
  // because MANUAL_REVIEW is also "not CONFIRMED" and deserves its own tone.
  const stuck = rows.find((row) => row.state === "MANUAL_REVIEW");
  if (stuck) {
    return {
      tone: "review",
      headline:
        `Needs a human: ${stuck.investorId}'s ${centsToDisplay(stuck.amountCents)} is stuck,` +
        " and the bank will not say whether it moved.",
    };
  }

  const missed = rows.find(
    (row) => row.amountCents > 0 && (row.state !== "CONFIRMED" || row.paidTimes !== 1),
  );
  if (missed) {
    return {
      tone: "catch",
      headline:
        `Caught: ${missed.investorId} is ${missed.state} and the bank paid` +
        ` ${times(missed.paidTimes)}.${planted}`,
    };
  }

  if (outcome.violations.length > 0) {
    const first = outcome.violations[0]!;
    return {
      tone: "catch",
      headline: `Caught: the ${first.invariant} check failed - ${first.detail}`,
    };
  }

  return {
    tone: "pass",
    headline:
      "Passed: everyone paid exactly once, " +
      `${centsToDisplay(outcome.totalAllocatedCents)} accounted for`,
  };
}

// ---------------------------------------------------------------------------
// Payments table
// ---------------------------------------------------------------------------

export type RowState = Payment["state"] | "SKIPPED";

export interface PaymentRow {
  investorId: string;
  amountCents: number;
  /** Dollars, for display. Never parse this back. */
  amountDisplay: string;
  state: RowState;
  /** How many transfers the bank actually made to this investor. */
  paidTimes: number;
  paidCents: number;
  /** One plain-English sentence: what the bank did, in order. */
  whatHappened: string;
}

/**
 * One row per investor, in allocation order, including the investor whose share
 * rounded to zero. A skipped investor with no row would look like a name the
 * page forgot, and "we paid everybody" would be a claim the table contradicts.
 */
export function paymentRows(outcome: ReplayOutcome): PaymentRow[] {
  const eventsByPayment = new Map<string, AuditEntry[]>();
  for (const entry of outcome.audit) {
    const list = eventsByPayment.get(entry.paymentId);
    if (list) list.push(entry);
    else eventsByPayment.set(entry.paymentId, [entry]);
  }

  const paymentByInvestor = new Map(outcome.payments.map((p) => [p.investorId, p]));
  const settledByInvestor = new Map(
    outcome.settlements
      .filter((s) => s.investorId !== null)
      .map((s) => [s.investorId as string, s]),
  );

  return outcome.allocations.map((allocation) => {
    const investorId = allocation.investor.id;
    const payment = paymentByInvestor.get(investorId);
    const settled = settledByInvestor.get(investorId);
    const paidTimes = settled?.paidTimes ?? 0;
    const paidCents = settled?.paidCents ?? 0;

    if (!payment) {
      return {
        investorId,
        amountCents: 0,
        amountDisplay: centsToDisplay(0),
        state: "SKIPPED",
        paidTimes,
        paidCents,
        whatHappened: "share rounded to $0.00, nothing sent",
      };
    }

    return {
      investorId,
      amountCents: payment.amountCents,
      amountDisplay: centsToDisplay(payment.amountCents),
      state: payment.state,
      paidTimes,
      paidCents,
      whatHappened: describePayment(
        payment,
        eventsByPayment.get(payment.id) ?? [],
        paidTimes,
      ),
    };
  });
}

function describePayment(
  payment: Payment,
  entries: AuditEntry[],
  paidTimes: number,
): string {
  const events = entries.map((entry) => entry.event);
  const retries = events.filter((event) => event === "BANK_REJECTED_TRANSIENT").length;

  if (paidTimes > 1) {
    if (retries > 0) {
      return "Bank said try later (it had already paid), we retried with a new key, so it paid again";
    }
    if (events.includes("BANK_TIMEOUT")) {
      return "Bank timed out (it had already paid), we resent without asking, so it paid again";
    }
    return `The bank paid this investor ${times(paidTimes)}`;
  }

  if (events.includes("CHECKS_EXHAUSTED")) {
    return "The bank never answered our status checks, so a human has to look";
  }

  if (events.includes("BANK_TIMEOUT")) {
    if (events.includes("STATUS_CONFIRMED")) {
      return "Bank timed out, we asked, it said the payment went through";
    }
    if (events.includes("STATUS_FAILED")) {
      return "Bank timed out, we asked, it said it failed";
    }
    if (events.includes("ASYNC_CONFIRM")) {
      return "Bank timed out, then its confirmation arrived late";
    }
    if (events.includes("ASYNC_FAILURE")) {
      return "Bank timed out, then its failure arrived late";
    }
    return "Bank timed out and we have not found out what happened";
  }

  if (retries > 0) {
    if (payment.state === "CONFIRMED") {
      return `Bank said try later ${times(retries)}, paid on the ${ordinal(retries + 1)} try`;
    }
    if (events.includes("ASYNC_CONFIRM")) {
      return `Bank said try later ${times(retries)} and then confirmed late`;
    }
    return `Bank kept saying try later, so we stopped after ${times(retries)}`;
  }

  if (events.includes("STATUS_NOT_FOUND_IN_WINDOW")) {
    return "Bank had no record yet, so we waited out the settling window";
  }
  if (events.includes("STATUS_NOT_FOUND")) {
    return "Bank had no record of this payment";
  }
  if (events.includes("BANK_ACCEPTED")) {
    return "Bank accepted it first time";
  }
  if (events.includes("BANK_REJECTED_PERMANENT")) {
    return "Bank refused the payment outright";
  }
  if (events.includes("ASYNC_CONFIRM")) {
    return "Bank confirmed it with a late notification";
  }

  return `Payment ended ${payment.state.toLowerCase().replaceAll("_", " ")}`;
}
