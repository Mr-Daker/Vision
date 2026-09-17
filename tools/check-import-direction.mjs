#!/usr/bin/env node
/**
 * Enforces the V006 package graph and package-manifest dependencies.
 *
 * The TypeScript parser is used deliberately: regular expressions miss
 * side-effect imports, dynamic imports, import-equals declarations and scoped
 * package subpaths. Unknown workspace packages fail closed until V006 records
 * an explicit rule for them.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

const RULES = {
  "packages/contracts": [],
  "packages/domain": ["@vision/contracts"],
  "packages/config-packs": ["@vision/contracts"],
  // Media decoding is a leaf like contracts: it takes bytes and returns bytes
  // or plain values, so it needs no domain vocabulary and must not acquire any.
  // Keeping it dependency-free is what lets it be reasoned about and tested in
  // isolation from the evidence lifecycle it serves (V021).
  "packages/media": [],
  "packages/adapters": ["@vision/contracts", "@vision/domain", "@vision/media"],
  "packages/fixtures": ["@vision/contracts"],
  "apps/api": ["@vision/contracts", "@vision/domain", "@vision/adapters", "@vision/config-packs"],
  "apps/worker": [
    "@vision/contracts",
    "@vision/domain",
    "@vision/adapters",
    "@vision/config-packs",
  ],
  // The evaluation harness (V046). It is the only consumer of @vision/fixtures
  // outside the fixtures package itself, because it is the only code permitted
  // to unseal the holdout — and it may not be imported by anything, so the
  // dependency cannot travel back the other way.
  "apps/eval": [
    "@vision/contracts",
    "@vision/domain",
    "@vision/adapters",
    "@vision/config-packs",
    "@vision/fixtures",
  ],
  // The web app runs in a browser, so it may only import packages that are
  // free of Node built-ins: @vision/contracts and @vision/domain are (checked
  // by `npm run check:browser-safe`). @vision/adapters is excluded on purpose
  // — it imports `node:fs` and `pg`, which have no meaning in a browser and
  // would drag server code into the client. There is no bundler: the browser
  // resolves these specifiers through the import map in index.html (V019).
  "apps/web": ["@vision/contracts", "@vision/domain"],
};

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const WORKSPACE_SPECIFIER = /^(@vision\/[^/]+)(?:\/.*)?$/;

const workspaceDirectories = () => {
  const result = [];
  for (const parent of ["packages", "apps"]) {
    let entries = [];
    try {
      entries = readdirSync(join(ROOT, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const layer = `${parent}/${entry.name}`;
      try {
        JSON.parse(readFileSync(join(ROOT, layer, "package.json"), "utf8"));
        result.push(layer);
      } catch {
        // A directory without a valid manifest is not an npm workspace.
      }
    }
  }
  return result.sort();
};

const walk = (dir, out = []) => {
  let entries = [];
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
    } else if (SOURCE_EXTENSION.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

const moduleSpecifiers = (file, source) => {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [];

  const addLiteral = (node) => {
    if (node !== undefined && ts.isStringLiteralLike(node)) found.push(node.text);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

const violations = [];
const layers = workspaceDirectories();

for (const layer of layers) {
  if (!Object.hasOwn(RULES, layer)) {
    violations.push({
      file: `${layer}/package.json`,
      detail: "workspace package has no V006 import rule",
    });
    continue;
  }

  const manifestPath = join(ROOT, layer, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const ownName = manifest.name;
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const allowed = RULES[layer];

  for (const file of walk(join(ROOT, layer, "src"))) {
    const relPath = relative(ROOT, file);
    const source = readFileSync(file, "utf8");

    for (const specifier of moduleSpecifiers(file, source)) {
      const match = WORKSPACE_SPECIFIER.exec(specifier);
      if (match === null) continue;
      const packageName = match[1];
      if (packageName === ownName) continue;

      if (!allowed.includes(packageName)) {
        violations.push({
          file: relPath,
          detail: `${layer} must not import ${specifier}; allowed: ${allowed.length > 0 ? allowed.join(", ") : "(nothing)"}`,
        });
      } else if (!declared.has(packageName)) {
        violations.push({
          file: `${layer}/package.json`,
          detail: `${packageName} is imported by ${relPath} but is not declared in the package manifest`,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Import-direction or manifest violations (V006 \u00a79):\n");
  for (const violation of violations) {
    console.error(`  ${violation.file}`);
    console.error(`      ${violation.detail}`);
  }
  process.exit(1);
}

console.log(
  `check:imports OK \u2014 ${layers.length} workspace packages have explicit V006 rules and declared imports`,
);
