#!/usr/bin/env node
/**
 * Keeps the V011 evaluation holdout sealed.
 *
 * Two independent failures are checked, because the runtime seal alone is not
 * enough — someone could set the flag in the wrong place:
 *
 *  1. No production, seeding, or demo module may import `loadHoldoutCorpus`
 *     or read the holdout file directly. Only files under an evaluation path
 *     may (none exist yet; V046 adds them).
 *  2. No committed file may set VISION_EVAL_RUN=1, which would silently
 *     unseal the corpus for every run.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

const SCANNED = ["packages", "apps", "tools", ".github"];

/** Only these paths may touch the holdout. */
const EVALUATION_ALLOWLIST = [
  /^packages\/fixtures\/src\/index\.ts$/, // defines the seal
  /^packages\/fixtures\/src\/fixtures\.test\.ts$/, // tests the seal
  /^tools\/check-holdout-seal\.mjs$/, // this checker
  // The V046 harness, and only its entry point. A root `evals/` directory was
  // allowlisted here before V046 existed, which could never match: this
  // scanner walks packages, apps, tools and .github, so a file outside those
  // was neither allowed nor checked — including for the committed seal flag,
  // in exactly the place that flag would be set. `apps/eval` is inside the
  // walk, inside the typechecker, and inside the formatter.
  /^apps\/eval\/src\/holdout-run\.ts$/,
];

const HOLDOUT_REFERENCES = [
  { label: "loadHoldoutCorpus import/call", pattern: /loadHoldoutCorpus/ },
  { label: "direct holdout file read", pattern: /reports\.holdout\.json/ },
];

const SEAL_FLAG = /VISION_EVAL_RUN\s*[=:]\s*["']?1["']?/;

const walk = (dir, out = []) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "corpus") {
        continue;
      }
      walk(full, out);
    } else if (/\.(ts|mts|js|mjs|cjs|ya?ml|json|sh)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

const violations = [];

for (const root of SCANNED) {
  for (const file of walk(join(ROOT, root))) {
    const relPath = relative(ROOT, file);
    const allowed = EVALUATION_ALLOWLIST.some((pattern) => pattern.test(relPath));
    const content = readFileSync(file, "utf8");

    if (!allowed) {
      for (const { label, pattern } of HOLDOUT_REFERENCES) {
        if (pattern.test(content)) {
          violations.push({ relPath, detail: `${label} outside an evaluation path` });
        }
      }
    }

    // The flag must never be committed as enabled. This checker is exempt from
    // its own scan: it necessarily contains the pattern it searches for.
    if (relPath === "tools/check-holdout-seal.mjs") continue;

    content.split("\n").forEach((line, index) => {
      if (SEAL_FLAG.test(line) && !/process\.env\[/.test(line) && !/^\s*[*/#]/.test(line.trim())) {
        violations.push({
          relPath: `${relPath}:${String(index + 1)}`,
          detail: "commits VISION_EVAL_RUN=1, which would unseal the holdout for every run",
        });
      }
    });
  }
}

if (violations.length > 0) {
  console.error("Holdout seal violations (V011):\n");
  for (const violation of violations) {
    console.error(`  ${violation.relPath}`);
    console.error(`      ${violation.detail}`);
  }
  console.error(
    "\nThe holdout may only be read by a scored evaluation run. Leaking it into a\nprompt, seed, or rehearsal invalidates every held-out measurement.",
  );
  process.exit(1);
}

console.log("check:holdout OK — the evaluation holdout is referenced only from evaluation paths");
