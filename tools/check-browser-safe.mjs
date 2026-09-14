#!/usr/bin/env node
/**
 * Asserts that everything shipped to the browser is free of Node built-ins.
 *
 * The web app has no bundler: the browser resolves `@vision/contracts` and
 * `@vision/domain` through the import map in `apps/web/public/app.html`, and
 * those packages are emitted to plain ESM by `npm run build:web`. A single
 * `node:crypto` import anywhere in that graph would fail at runtime in the
 * browser — with a module-resolution error the server-side tests would never
 * see, because Node resolves it happily.
 *
 * Tests are exempt: they run under `node --test`, never in a browser.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();

/** Source roots emitted for the browser by `npm run build:web`. */
const BROWSER_ROOTS = ["packages/contracts/src", "packages/domain/src", "apps/web/src"];

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const IS_TEST = /\.(?:db|live)?test\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Globals that exist in Node but not in every browser, or that indicate
 * server-only code. `crypto.randomUUID()` is deliberately absent: the global
 * `crypto` is standard in browsers and in Node 19+.
 */
const SERVER_ONLY_GLOBALS = ["process", "__dirname", "__filename", "require", "Buffer"];

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
    } else if (SOURCE_EXTENSION.test(entry.name) && !IS_TEST.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

const violations = [];
let scanned = 0;

for (const root of BROWSER_ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const relPath = relative(ROOT, file);
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    scanned += 1;

    const report = (node, detail) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({ file: `${relPath}:${String(line + 1)}`, detail });
    };

    const visit = (node) => {
      const specifier =
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined;

      if (specifier !== undefined && specifier.startsWith("node:")) {
        report(node, `imports the Node built-in '${specifier}', which does not exist in a browser`);
      }
      if (specifier === "@vision/adapters") {
        report(node, "imports @vision/adapters, which is server-only (node:fs, pg)");
      }

      // A bare identifier reference to a server-only global. Property accesses
      // like `globalThis.process` are still caught; a local variable of the
      // same name is not, because it is declared in scope.
      if (ts.isIdentifier(node) && SERVER_ONLY_GLOBALS.includes(node.text)) {
        const parent = node.parent;
        const isDeclarationName =
          (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isBindingElement(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isPropertyAssignment(parent)) &&
          parent.name === node;
        const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
        if (!isDeclarationName && !isPropertyName) {
          report(node, `references the server-only global '${node.text}'`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

if (violations.length > 0) {
  console.error("Browser-unsafe code in a package served to the browser (V019):\n");
  for (const violation of violations) {
    console.error(`  ${violation.file}`);
    console.error(`      ${violation.detail}`);
  }
  console.error("\nMove server-only code into @vision/adapters or an app, not a shared package.");
  process.exit(1);
}

console.log(`check:browser-safe OK — ${String(scanned)} browser-delivered files use no Node APIs`);
