#!/usr/bin/env node
/**
 * Rewrites workspace specifiers in the browser build (roadmap V019).
 *
 * A browser cannot resolve `@vision/contracts`. The obvious answer is an
 * import map, but an import map is an inline `<script>`, and the interface is
 * served under `script-src 'self'` — so it was blocked, the module graph never
 * resolved, and the page rendered as an empty shell. Rather than weaken the
 * policy or pin a fragile inline-script hash, the emitted files are rewritten
 * to absolute paths after `tsc`.
 *
 * Deliberately a plain string rewrite over emitted JavaScript: no bundler, no
 * dependency, and the mapping is one line per package.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const BUILD_DIR = join(ROOT, "apps/web/public/js");

/** Where each workspace package's entry point lands in the build. */
const MAPPING = {
  "@vision/contracts": "/js/vendor/contracts/src/index.js",
  "@vision/domain": "/js/vendor/domain/src/index.js",
};

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
};

let files;
try {
  files = walk(BUILD_DIR);
} catch {
  console.error(`no browser build at ${relative(ROOT, BUILD_DIR)} — run \`npm run build:web\``);
  process.exit(1);
}

let rewritten = 0;
const remaining = [];

for (const file of files) {
  const original = readFileSync(file, "utf8");
  let updated = original;

  for (const [specifier, path] of Object.entries(MAPPING)) {
    // Only a complete specifier in a quoted position, so a package name
    // mentioned in a comment or a string is left alone.
    updated = updated.replaceAll(`from "${specifier}"`, `from "${path}"`);
    updated = updated.replaceAll(`import("${specifier}")`, `import("${path}")`);
  }

  if (updated !== original) {
    writeFileSync(file, updated);
    rewritten += 1;
  }

  // Any bare specifier left in the output would fail silently in the browser
  // (an unresolved module, an empty page, nothing in the server log).
  for (const match of updated.matchAll(/from "([^".][^"]*)"/g)) {
    const specifier = match[1];
    if (!specifier.startsWith("/") && !specifier.startsWith("./") && !specifier.startsWith("../")) {
      remaining.push(`${relative(ROOT, file)}: ${specifier}`);
    }
  }
}

if (remaining.length > 0) {
  console.error("Bare module specifiers remain in the browser build:\n");
  for (const line of remaining) console.error(`  ${line}`);
  console.error("\nAdd the package to MAPPING in tools/rewrite-web-imports.mjs.");
  process.exit(1);
}

console.log(
  `build:web OK — ${String(files.length)} files emitted, ${String(rewritten)} rewritten, no bare specifiers left`,
);
