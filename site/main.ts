/**
 * Replay page DOM layer.
 *
 * The stories, their promised endings and the verdict line live in
 * site/stories.ts, which is plain Node and tested. This file only turns data
 * into elements: the five story buttons, one verdict line, the payments table,
 * and the raw knobs and audit log under Advanced.
 */

import { BREAK_IT_FLAGS, dollarsToCents, replay } from "./replay.js";
import type { BreakItFlag, ReplayOptions, ReplayOutcome } from "./replay.js";
import { STORIES, paymentRows, storyById, verdictFor } from "./stories.js";
import type { Story, Verdict } from "./stories.js";
import type { FakeBankConfig } from "../src/bank/fakeBank.js";
import { centsToDisplay } from "../src/core/money.js";

interface Controls {
  seed: number;
  investors: number;
  totalCents: number;
  bank: FakeBankConfig;
  flag: BreakItFlag | "";
}

/**
 * Inputs that make a URL a set of custom settings rather than a story link.
 * Note `total`: the box takes dollars, the URL keeps cents, so a ?total= link
 * written before the box changed still loads the same distribution.
 */
const ADVANCED_FIELDS = [
  "seed",
  "investors",
  "total",
  "timeoutRate",
  "transientRejectRate",
  "lyingTransientRate",
  "asyncConfirmRate",
  "asyncDelayChecks",
  "asyncDropRate",
] as const;

/** Friendly labels: the table is for a stranger, not for the state machine. */
const STATE_LABEL: Record<string, string> = {
  CONFIRMED: "Paid",
  FAILED: "Not paid",
  MANUAL_REVIEW: "Needs a human",
  SKIPPED: "Skipped",
  CREATED: "Created",
  SENDING: "Sending",
  UNKNOWN: "Unknown",
};

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
};

const input = (id: string): HTMLInputElement => $(id) as HTMLInputElement;
const num = (id: string): number => Number(input(id).value);

let selected: Story = STORIES[0]!;
let running = false;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function showVerdict(verdict: Verdict, note: string): void {
  const element = $("verdict");
  element.hidden = false;
  element.className = `verdict ${verdict.tone}`;
  element.innerHTML = `
    <span class="verdict-text">${escapeHtml(verdict.headline)}</span>
    <span class="verdict-note">${escapeHtml(note)}</span>
  `;
}

// ---------------------------------------------------------------------------
// Story choices
// ---------------------------------------------------------------------------

function renderStoryChoices(): void {
  $("stories").innerHTML = STORIES.map(
    (story) => `
      <button type="button" class="story" data-story="${escapeHtml(story.id)}" aria-pressed="false">
        <span class="story-title">${escapeHtml(story.title)}</span>
        <span class="story-expect"><strong>What should happen:</strong> ${escapeHtml(story.whatShouldHappen)}</span>
      </button>`,
  ).join("");

  for (const button of document.querySelectorAll<HTMLButtonElement>("button.story")) {
    button.addEventListener("click", () => selectStory(button.dataset.story ?? ""));
  }
}

function selectStory(id: string): void {
  const story = storyById(id);
  if (!story) return;

  selected = story;
  for (const button of document.querySelectorAll<HTMLButtonElement>("button.story")) {
    button.setAttribute("aria-pressed", String(button.dataset.story === story.id));
  }
  $("selection").textContent = `Story: ${story.title}`;
  history.replaceState(null, "", `?story=${encodeURIComponent(story.id)}`);
}

// ---------------------------------------------------------------------------
// Rendering a run
// ---------------------------------------------------------------------------

function renderOutcome(story: Story, outcome: ReplayOutcome): void {
  showVerdict(verdictFor(story, outcome), `What should happen: ${story.whatShouldHappen}`);

  const rows = paymentRows(outcome)
    .map(
      (row) => `<tr>
        <td class="state">${escapeHtml(row.investorId)}</td>
        <td class="money">${escapeHtml(row.amountDisplay)}</td>
        <td>${escapeHtml(STATE_LABEL[row.state] ?? row.state)}</td>
        <td>${escapeHtml(row.whatHappened)}</td>
      </tr>`,
    )
    .join("");

  $("payments").innerHTML = `
    <h2>What the bank did, investor by investor</h2>
    <p class="sub">
      ${outcome.payments.length} payments sent,
      ${escapeHtml(centsToDisplay(outcome.result.totalConfirmedCents))} confirmed,
      ${escapeHtml(centsToDisplay(outcome.result.totalFailedCents))} failed,
      ${escapeHtml(centsToDisplay(outcome.result.totalManualReviewCents))} waiting for a human.
      The fund allocated ${escapeHtml(centsToDisplay(outcome.totalAllocatedCents))}.
    </p>
    <table>
      <thead>
        <tr><th>Investor</th><th>Amount</th><th>State</th><th>What happened</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  renderAdvanced(outcome);
}

function renderAdvanced(outcome: ReplayOutcome): void {
  const audit = outcome.audit
    .map(
      (entry) => `<tr>
        <td class="state">${escapeHtml(entry.investorId)}</td>
        <td class="state">${escapeHtml(entry.event)}</td>
        <td class="state">${escapeHtml(entry.fromState)} &rarr; ${escapeHtml(entry.toState)}</td>
        <td>${escapeHtml(entry.reason ?? "")}</td>
      </tr>`,
    )
    .join("");

  const keys = outcome.payments
    .map(
      (payment) => `<tr>
        <td class="state">${escapeHtml(payment.investorId)}</td>
        <td class="state">${escapeHtml(payment.idempotencyKey)}</td>
        <td class="money">${escapeHtml(centsToDisplay(payment.amountCents))}</td>
        <td>${payment.transientRetries} retries, ${payment.statusChecks} status checks</td>
      </tr>`,
    )
    .join("");

  $("advancedBody").innerHTML = `
    <h3>Payment keys</h3>
    <p class="sub">
      The key is what tells the bank "this is the same payment, not a new one".
      A retry that changes it is how a bank ends up paying twice.
    </p>
    <table>
      <thead><tr><th>Investor</th><th>Idempotency key</th><th>Amount</th><th>Attempts</th></tr></thead>
      <tbody>${keys}</tbody>
    </table>

    <h3>Audit log</h3>
    <p class="sub">Every state change, in order, with the reason the state machine gave.</p>
    <table>
      <thead><tr><th>Investor</th><th>Event</th><th>Transition</th><th>Reason</th></tr></thead>
      <tbody>${audit}</tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function playStory(story: Story): Promise<void> {
  if (running) return;
  running = true;

  selectStory(story.id);
  const button = $("play") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "Playing...";

  try {
    renderOutcome(story, await replay(story.options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showVerdict({ tone: "catch", headline: `The run itself failed: ${message}` }, story.whatShouldHappen);
  } finally {
    running = false;
    button.disabled = false;
    button.textContent = "Play";
  }
}

// ---------------------------------------------------------------------------
// Advanced: custom settings
// ---------------------------------------------------------------------------

function readTotalCents(): number {
  const dollars = num("total");
  return Math.max(1, Number.isFinite(dollars) ? dollarsToCents(dollars) : 0);
}

function readControls(): Controls {
  return {
    seed: Math.max(1, Math.floor(num("seed"))),
    investors: Math.min(40, Math.max(1, Math.floor(num("investors")))),
    totalCents: readTotalCents(),
    flag: ($("flag") as HTMLSelectElement).value as BreakItFlag | "",
    bank: {
      permanentRejectRate: 0,
      statusTimeoutRate: 0,
      dedupe: true,
      timeoutRate: num("timeoutRate"),
      transientRejectRate: num("transientRejectRate"),
      lyingTransientRate: num("lyingTransientRate"),
      asyncConfirmRate: num("asyncConfirmRate"),
      asyncDelayChecks: Math.max(0, Math.floor(num("asyncDelayChecks"))),
      asyncDropRate: num("asyncDropRate"),
    },
  };
}

function customOptions(controls: Controls): ReplayOptions {
  return {
    seed: controls.seed,
    investors: controls.investors,
    totalCents: controls.totalCents,
    bank: controls.bank,
    flag: controls.flag,
  };
}

function customStory(controls: Controls): Story {
  return {
    id: "custom",
    title: "Custom settings",
    whatShouldHappen:
      "Nothing specific: you chose these settings, so the page cannot promise an ending.",
    options: customOptions(controls),
    expects: controls.flag === "" ? { kind: "pass" } : { kind: "catch", invariant: "I1" },
  };
}

function applyUrlParams(): void {
  const params = new URLSearchParams(location.search);
  for (const id of ADVANCED_FIELDS) {
    if (id === "total") continue; // cents in the link, dollars in the box
    const value = params.get(id);
    if (value !== null) input(id).value = value;
  }

  const totalCents = params.get("total");
  if (totalCents !== null && Number.isFinite(Number(totalCents))) {
    input("total").value = (Number(totalCents) / 100).toFixed(2);
  }
  const flag = params.get("flag");
  if (flag !== null && (BREAK_IT_FLAGS as readonly string[]).includes(flag)) {
    ($("flag") as HTMLSelectElement).value = flag;
  }
}

function writeCustomUrl(controls: Controls): void {
  const params = new URLSearchParams();
  params.set("seed", String(controls.seed));
  if (controls.flag !== "") params.set("flag", controls.flag);
  params.set("investors", String(controls.investors));
  params.set("total", String(controls.totalCents));
  params.set("timeoutRate", String(controls.bank.timeoutRate));
  params.set("transientRejectRate", String(controls.bank.transientRejectRate));
  params.set("lyingTransientRate", String(controls.bank.lyingTransientRate));
  params.set("asyncConfirmRate", String(controls.bank.asyncConfirmRate));
  params.set("asyncDelayChecks", String(controls.bank.asyncDelayChecks ?? 0));
  params.set("asyncDropRate", String(controls.bank.asyncDropRate ?? 0));
  history.replaceState(null, "", `?${params.toString()}`);
}

async function runCustom(): Promise<void> {
  if (running) return;
  running = true;

  const controls = readControls();
  writeCustomUrl(controls);
  const story = customStory(controls);

  try {
    renderOutcome(story, await replay(customOptions(controls)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showVerdict({ tone: "catch", headline: `The run itself failed: ${message}` }, story.whatShouldHappen);
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

renderStoryChoices();
applyUrlParams();

const params = new URLSearchParams(location.search);
const linkedStory = storyById(params.get("story"));

if (linkedStory) {
  // ?story=<id> is a link to one story: select it and play it, so the URL a
  // reader copies shows the same ending to whoever opens it.
  void playStory(linkedStory);
} else if (ADVANCED_FIELDS.some((id) => params.has(id))) {
  // An older ?seed= link: honour it, and open Advanced so the settings are visible.
  ($("advanced") as HTMLDetailsElement).open = true;
  void runCustom();
} else {
  selectStory(STORIES[0]!.id);
}

$("play").addEventListener("click", () => {
  void playStory(selected);
});

$("controls").addEventListener("submit", (event) => {
  event.preventDefault();
  void runCustom();
});
