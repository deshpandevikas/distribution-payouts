/**
 * The replay page's six stories, as tests.
 *
 * The page promises a stranger that a story ends a particular way: three normal
 * days pass, two planted bugs are caught, and one ends with a person holding the
 * money. That promise is only worth making if it is asserted, so every ending
 * the page shows is checked here against the real runner, the real transition
 * table and the real checker - same code the browser bundles.
 *
 * Each story also has to actually contain the thing it is named after: a story
 * called "bank times out" that never times out teaches nothing.
 */

import { describe, it, expect } from "vitest";
import { dollarsToCents, replay } from "../site/replay.js";
import type { ReplayOutcome } from "../site/replay.js";
import { STORIES, storyById, verdictFor, paymentRows } from "../site/stories.js";
import type { Story } from "../site/stories.js";

function story(id: string): Story {
  const found = storyById(id);
  if (!found) throw new Error(`no story with id ${id}`);
  return found;
}

async function runStory(id: string): Promise<{ story: Story; outcome: ReplayOutcome }> {
  const chosen = story(id);
  return { story: chosen, outcome: await replay(chosen.options) };
}

const PASS_LINE = "Passed: everyone paid exactly once, $600.00 accounted for";

describe("six stories, fixed seeds", () => {
  it("ships exactly the six stories the page advertises, with unique link ids", () => {
    expect(STORIES.map((s) => s.id)).toEqual([
      "normal-day",
      "bank-timeout",
      "try-later",
      "new-key-on-retry",
      "resend-without-asking",
      "bank-goes-quiet",
    ]);

    expect(new Set(STORIES.map((s) => s.id)).size).toBe(STORIES.length);

    for (const s of STORIES) {
      // "What should happen" has to be readable before the run, not a label.
      expect(s.whatShouldHappen.length, `${s.id} needs a plain-English expectation`).toBeGreaterThan(20);
      // A seed is what makes the story repeatable for the next stranger.
      expect(Number.isInteger(s.options.seed), `${s.id} needs a fixed seed`).toBe(true);
    }
  });

  it("links by ?story=<id>, and returns undefined for an id that is not a story", () => {
    expect(story("try-later").title).toMatch(/try later/i);
    expect(storyById("no-such-story")).toBeUndefined();
  });

  it("only the two bug stories promise a catch", () => {
    expect(STORIES.filter((s) => s.expects.kind === "catch").map((s) => s.id)).toEqual([
      "new-key-on-retry",
      "resend-without-asking",
    ]);
    expect(STORIES.filter((s) => s.expects.kind === "review").map((s) => s.id)).toEqual([
      "bank-goes-quiet",
    ]);
  });
});

describe("the three normal stories pass", () => {
  it("normal day: every investor paid once, $600.00 accounted for", async () => {
    const { story: s, outcome } = await runStory("normal-day");

    expect(outcome.violations).toEqual([]);
    expect(verdictFor(s, outcome)).toEqual({ tone: "pass", headline: PASS_LINE });

    const rows = paymentRows(outcome);
    const paid = rows.filter((r) => r.amountCents > 0);
    expect(paid).toHaveLength(5);
    expect(paid.every((r) => r.state === "CONFIRMED" && r.paidTimes === 1)).toBe(true);
    expect(outcome.result.totalConfirmedCents).toBe(60_000);
  });

  it("bank timeout: the story really times out, asks the bank, and still pays once", async () => {
    const { story: s, outcome } = await runStory("bank-timeout");

    expect(outcome.violations).toEqual([]);
    expect(verdictFor(s, outcome)).toEqual({ tone: "pass", headline: PASS_LINE });

    const timeouts = outcome.audit.filter((e) => e.event === "BANK_TIMEOUT");
    const asked = outcome.audit.filter((e) => e.event === "STATUS_CONFIRMED");
    expect(timeouts.length, "a story called bank-timeout must contain a timeout").toBeGreaterThan(0);
    expect(asked.length, "the runner must ask the bank before believing the timeout").toBeGreaterThan(0);

    const rows = paymentRows(outcome);
    expect(rows.filter((r) => r.amountCents > 0).every((r) => r.paidTimes === 1)).toBe(true);
    expect(rows.find((r) => r.investorId === "inv-1")?.whatHappened).toBe(
      "Bank timed out, we asked, it said the payment went through",
    );
  });

  it("try later: the story really retries, reuses the same key, and pays once", async () => {
    const { story: s, outcome } = await runStory("try-later");

    expect(outcome.violations).toEqual([]);
    expect(verdictFor(s, outcome)).toEqual({ tone: "pass", headline: PASS_LINE });

    const retried = outcome.payments.filter((p) => p.transientRetries > 0);
    expect(retried.length, "a story called try-later must contain a retry").toBeGreaterThan(0);

    // The same key on every attempt is what stops the bank paying twice.
    for (const p of outcome.payments) {
      expect(p.idempotencyKey).toBe(`dist-${s.options.seed}:${p.investorId}:1`);
    }

    const rows = paymentRows(outcome);
    expect(rows.find((r) => r.investorId === "inv-1")?.whatHappened).toBe(
      "Bank said try later twice, paid on the 3rd try",
    );
    expect(rows.find((r) => r.investorId === "inv-2")?.whatHappened).toBe(
      "Bank accepted it first time",
    );
  });
});

describe("the two planted bugs are caught", () => {
  it("new key on retry: the bank pays someone twice, caught by I1", async () => {
    const { story: s, outcome } = await runStory("new-key-on-retry");

    const named = outcome.violations.map((v) => v.invariant);
    expect(named, "the story's named check must be I1").toContain(s.expects.kind === "catch" ? s.expects.invariant : "");
    expect(named).toContain("I1");

    expect(verdictFor(s, outcome)).toEqual({
      tone: "catch",
      headline: "Caught: inv-4 was paid twice ($180.00 extra). This is the bug we planted.",
    });
  });

  it("resend without asking: the bank pays someone twice, caught by I1", async () => {
    const { story: s, outcome } = await runStory("resend-without-asking");

    expect(outcome.violations.map((v) => v.invariant)).toContain("I1");
    expect(verdictFor(s, outcome)).toEqual({
      tone: "catch",
      headline: "Caught: inv-4 was paid twice ($161.54 extra). This is the bug we planted.",
    });
  });

  it("names the investor the bank actually paid twice, from the run's own numbers", async () => {
    const { story: s, outcome } = await runStory("new-key-on-retry");

    const doublePaid = paymentRows(outcome).filter((r) => r.paidTimes > 1);
    expect(doublePaid.map((r) => r.investorId)).toEqual(["inv-4"]);

    const row = doublePaid[0]!;
    const extra = row.amountCents; // paid twice: one whole allocation extra
    expect(verdictFor(s, outcome).headline).toContain(`$${(extra / 100).toFixed(2)} extra`);
  });
});

describe("the story that hands the money to a person", () => {
  it("bank goes quiet: one payment stuck, nobody double-paid, a human owns it", async () => {
    const { story: s, outcome } = await runStory("bank-goes-quiet");

    expect(outcome.violations).toEqual([]);

    const rows = paymentRows(outcome);
    expect(rows.filter((r) => r.state === "MANUAL_REVIEW").map((r) => r.investorId)).toEqual(["inv-4"]);
    expect(rows.every((r) => r.paidTimes <= 1)).toBe(true);

    const settled = rows.filter((r) => r.amountCents > 0 && r.state !== "MANUAL_REVIEW");
    expect(settled.every((r) => r.state === "CONFIRMED" && r.paidTimes === 1)).toBe(true);

    // The story has to really go quiet: a timeout, then the check budget spent.
    const events = outcome.audit.filter((e) => e.investorId === "inv-4").map((e) => e.event);
    expect(events).toContain("BANK_TIMEOUT");
    expect(events).toContain("CHECKS_EXHAUSTED");

    expect(verdictFor(s, outcome)).toEqual({
      tone: "review",
      headline:
        "Needs a human: inv-4's $145.95 is stuck, and the bank will not say whether it moved.",
    });
  });
});

describe("the page stays reproducible", () => {
  it("gives the same verdict and the same payments on a second run", async () => {
    for (const s of STORIES) {
      const first = await replay(s.options);
      const second = await replay(s.options);

      expect(verdictFor(s, second), s.id).toEqual(verdictFor(s, first));
      expect(second.payments, s.id).toEqual(first.payments);
      expect(second.settlements, s.id).toEqual(first.settlements);
    }
  });
});

describe("payments table in plain English", () => {
  it("shows the investor whose share rounded to zero instead of hiding them", async () => {
    const { outcome } = await runStory("normal-day");
    const skipped = paymentRows(outcome).find((r) => r.investorId === "inv-6");

    expect(skipped).toBeDefined();
    expect(skipped!.amountCents).toBe(0);
    expect(skipped!.state).toBe("SKIPPED");
    expect(skipped!.whatHappened).toBe("share rounded to $0.00, nothing sent");
  });

  it("takes dollars in the Advanced box and converts to integer cents once", () => {
    expect(dollarsToCents(600)).toBe(60_000);
    expect(dollarsToCents(600.5)).toBe(60_050);
    expect(dollarsToCents(123.45)).toBe(12_345);
    expect(dollarsToCents(0.07)).toBe(7);
    // The reason the rounding lives at the boundary: 0.1 + 0.2 dollars is not
    // exactly 0.3 in binary, and cents must stay integers.
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
  });

  it("shows money in dollars, never raw cents", async () => {
    const { outcome } = await runStory("new-key-on-retry");
    const rows = paymentRows(outcome);

    expect(rows.find((r) => r.investorId === "inv-1")?.amountDisplay).toBe("$80.00");
    expect(rows.some((r) => r.amountDisplay.includes("¢"))).toBe(false);
  });
});
