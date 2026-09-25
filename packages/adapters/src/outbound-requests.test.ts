/**
 * Where this system is allowed to make an outbound request (roadmap V047).
 *
 * V047's "done when" says untrusted evidence must not be able to "fetch
 * arbitrary internal URLs". The way that becomes possible is not a bug in a
 * URL builder; it is a second outbound call site appearing somewhere, built
 * from something a citizen typed. A test that checked the two call sites that
 * exist today would not catch the third.
 *
 * So this fails closed: every `fetch` in runtime code must be one of the two
 * provider transports, each of which builds its URL from configuration and
 * concatenates only a configured model name. A new call site fails this test
 * until somebody adds it here deliberately and says why.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Server-side runtime only.
 *
 * `apps/web` is excluded because its `fetch` runs in the reader's own browser
 * against this origin — that is a client calling its own API, not a server
 * being made to call somewhere. `apps/eval` is excluded because it is the V046
 * harness rather than a deployed service, and its one transport wraps the
 * Gemini adapter's own URL.
 */
const SCANNED = ["packages", "apps/api", "apps/worker", "tools"];

/**
 * The only places permitted to reach the network at runtime.
 *
 * Both are the default transports of the V023 Gemini adapters. Each receives a
 * URL its own adapter built from `baseUrl` and a configured model name, and
 * neither takes any part of the URL from a request, a report, or a database
 * row.
 */
/** The two provider transports, whose URL shape is pinned below. */
const PROVIDER_TRANSPORTS = new Set([
  "packages/adapters/src/gemini.ts",
  "packages/adapters/src/gemini-transcription.ts",
]);

const ALLOWED_OUTBOUND = new Set([
  ...PROVIDER_TRANSPORTS,
  // The V049 measurement harness. It is not deployed runtime: it starts the API
  // handler in its own process and calls `http://127.0.0.1:<the port it was
  // just given>`, so the URL comes from a listener it created and no part of it
  // can come from a report, a row or a request.
  "tools/performance.mjs",
]);

const isSource = (name: string): boolean => /\.(ts|mts|cts|mjs|cjs|js)$/.test(name);
const isTest = (path: string): boolean => /\.(test|dbtest|livetest)\.[cm]?tsx?$/.test(path);

const walk = (directory: string, found: string[] = []): string[] => {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, found);
    } else if (isSource(entry.name)) {
      found.push(full);
    }
  }
  return found;
};

/** `fetch(` that is a call rather than a word inside a comment or a string. */
const OUTBOUND = /(?<![\w.$])fetch\s*\(/;

test("no runtime code outside the two provider transports reaches the network", () => {
  const offenders: string[] = [];

  for (const root of SCANNED) {
    for (const file of walk(join(ROOT, root))) {
      const path = relative(ROOT, file).split("\\").join("/");
      if (isTest(path) || ALLOWED_OUTBOUND.has(path)) continue;
      const source = readFileSync(file, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("#"))
          continue;
        if (OUTBOUND.test(line)) offenders.push(`${path}:${String(index + 1)}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `a new outbound call site appeared. Every one is a place a URL could come to be built from something a citizen typed, so add it to ALLOWED_OUTBOUND deliberately, with the reason its URL cannot be influenced: ${offenders.join(", ")}`,
  );
});

test("the permitted transports build their URL from configuration, not from their input", () => {
  for (const path of PROVIDER_TRANSPORTS) {
    const source = readFileSync(join(ROOT, path), "utf8");
    // The adapter builds `${base}/models/${model}:method`. `base` comes from
    // options, `model` from options. Assert the literal shape is still there,
    // so a change to template it from anything else is visible here.
    assert.match(
      source,
      /\$\{base\}\/models\/\$\{this\.options\.\w+Model\}/,
      `${path} no longer builds its URL from a configured base and model name`,
    );
    assert.match(
      source,
      /baseUrl \?\? DEFAULT_GEMINI_BASE_URL/,
      `${path} must take its base URL from configuration with a fixed default`,
    );
  }
});
