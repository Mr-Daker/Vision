#!/usr/bin/env node
/**
 * Rejects hard-coded scope in production logic.
 *
 * Required by V001 Appendix G rule 7: "CI must reject production logic that
 * branches on `Sangli`, `mr-IN`, or `school-infrastructure`".
 *
 * Scope lives in configuration packs and locale resources, which are data and
 * are therefore exempt. Tests are exempt because a test may legitimately assert
 * that a specific pack value is handled.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

/** Discover every workspace source root so a new package cannot bypass CI. */
const SCANNED_ROOTS = ["packages", "apps"].flatMap((parent) => {
  try {
    return readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => {
        try {
          statSync(join(ROOT, parent, entry.name, "package.json"));
          return true;
        } catch {
          return false;
        }
      })
      .map((entry) => `${parent}/${entry.name}/src`);
  } catch {
    return [];
  }
});

/**
 * Exempt paths. Configuration data and locale resources are where scope
 * belongs; test files may reference it deliberately.
 */
const isExempt = (relPath) =>
  relPath.includes("/packs/") ||
  relPath.includes("/corpus/") ||
  relPath.includes("/locales/") ||
  relPath.includes("/fixtures/") ||
  // `.dbtest.ts` and `.livetest.ts` are test files too — one needs a live
  // database, the other a live provider. Each new test-file kind has to be
  // added here, and forgetting is how a real scope literal would slip past.
  /\.(?:db|live)?test\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(relPath) ||
  /contract-tests\.ts$/.test(relPath);

/**
 * Forbidden literals. These are the locked V001 scope values: they must never
 * appear in a branch, comparison, or constant inside production logic.
 */
const FORBIDDEN = [
  { pattern: /\bSangli\b/i, label: "Sangli (district scope)" },
  {
    // Anywhere inside a string literal, not only as the whole literal: a
    // comma-joined default such as "en-IN,mr-IN" is still scope in code, and
    // an earlier version of this pattern missed exactly that.
    pattern: /["'`][^"'`]*\bmr-IN\b[^"'`]*["'`]/,
    label: "mr-IN (locale scope)",
    // Referring to a locale *resource* is how locale data is meant to be
    // reached, so a path into a locale or configuration pack is not a branch
    // on scope.
    allowIf: /locales\/|\/packs\//,
  },
  { pattern: /\bschool-infrastructure\b/i, label: "school-infrastructure (taxonomy scope)" },
];

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
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

const violations = [];

for (const root of SCANNED_ROOTS) {
  const abs = join(ROOT, root);
  try {
    statSync(abs);
  } catch {
    continue;
  }

  for (const file of walk(abs)) {
    const relPath = relative(ROOT, file);
    if (isExempt(relPath)) continue;

    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      // A comment explaining the rule is not a branch on it.
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;

      for (const { pattern, label, allowIf } of FORBIDDEN) {
        if (allowIf !== undefined && allowIf.test(line)) continue;
        if (pattern.test(line)) {
          violations.push({ file: relPath, line: index + 1, label, text: trimmed.slice(0, 120) });
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error("Hard-coded scope found in production logic (V001 Appendix G rule 7):\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.label}]`);
    console.error(`      ${v.text}`);
  }
  console.error(
    "\nMove the value into a configuration pack or locale resource. Scope is data, not code.",
  );
  process.exit(1);
}

console.log(`check:scope OK — ${SCANNED_ROOTS.length} production source roots are scope-neutral`);
