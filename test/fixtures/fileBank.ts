/**
 * A bank whose settled set lives in a file.
 *
 * The crash test needs the bank's memory to survive the child process being
 * killed, or "exactly one settlement" could only be checked inside the process
 * that died. One line per accepted send: `key<TAB>amount`.
 *
 * Dedupe is by key, like a real bank: sending the same key twice settles once.
 * That is what makes an extra send visible as a *second line*, not as a second
 * settlement - the test counts lines, so a blind resend would be caught even
 * though the money moved once.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Bank, Cents, IdempotencyKey } from "../../src/core/types.js";

export class FileBank implements Bank {
  constructor(private readonly ledgerPath: string) {}

  private lines(): string[] {
    if (!existsSync(this.ledgerPath)) return [];
    return readFileSync(this.ledgerPath, "utf8").split("\n").filter((l) => l.trim() !== "");
  }

  private settled(): Map<IdempotencyKey, Cents> {
    const map = new Map<IdempotencyKey, Cents>();
    for (const line of this.lines()) {
      const [key, amount] = line.split("\t");
      if (key !== undefined && amount !== undefined && !map.has(key)) {
        map.set(key, Number(amount));
      }
    }
    return map;
  }

  async send(key: IdempotencyKey, amountCents: Cents): Promise<{ type: "ACCEPTED" }> {
    if (!this.settled().has(key)) {
      appendFileSync(this.ledgerPath, `${key}\t${amountCents}\n`);
    }
    return { type: "ACCEPTED" };
  }

  async getStatus(key: IdempotencyKey): Promise<{ type: "CONFIRMED" | "NOT_FOUND" }> {
    return this.settled().has(key) ? { type: "CONFIRMED" } : { type: "NOT_FOUND" };
  }

  getSettledKeys(): ReadonlyMap<IdempotencyKey, Cents> {
    return this.settled();
  }

  /** Number of send attempts that reached the bank (a resend adds a line). */
  sendLines(): number {
    return this.lines().length;
  }
}
