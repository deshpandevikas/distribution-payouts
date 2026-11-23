/**
 * The core must run in a browser.
 *
 * The replay page runs the same core logic with the in-memory store and the
 * fake bank, so any Node built-in in src/core makes the page impossible to
 * build. TypeScript will not catch it - `node:crypto` type-checks fine - so the
 * rule is enforced by reading the source.
 *
 * This is deliberately a source scan, not a bundler run: it names the offending
 * file and line instead of failing later inside Vite with a polyfill error.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = join(HERE, "..", "src", "core");

/** Node built-ins that must never appear in core: they do not exist in a browser. */
const NODE_BUILTIN = /(?:from\s*|require\(\s*)["'](node:[a-z_/]+|assert|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|https|module|net|os|path|perf_hooks|process|querystring|readline|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)["']/;

function coreFiles(): string[] {
  return readdirSync(CORE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(CORE_DIR, entry.name))
    .sort();
}

describe("core has no Node imports", () => {
  it("scans every file in src/core", () => {
    expect(coreFiles().length).toBeGreaterThan(3);
  });

  it("imports no Node built-in anywhere in src/core", () => {
    const offenders: string[] = [];

    for (const file of coreFiles()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const match = NODE_BUILTIN.exec(line);
        if (match !== null) {
          offenders.push(`${file.split("/").slice(-2).join("/")}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
