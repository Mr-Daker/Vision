/**
 * Colour-contrast assertions for the citizen interface (roadmap V019).
 *
 * A contrast ratio measured once during development is a claim that quietly
 * stops being true the first time someone adjusts a colour. This reads the
 * real stylesheet, resolves the custom properties for both colour schemes, and
 * fails if any text pair drops below the WCAG 2.1 AA threshold.
 *
 * Scope and honesty: this checks the pairs listed below, which are the pairs
 * the interface actually renders. It is not a full page audit, and it says
 * nothing about screen-reader behaviour — those remain owner checks recorded
 * in the V019 task record.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), "../public/app.css");

/** WCAG 2.1: 4.5:1 for normal text, 3:1 for large text and UI components. */
const TEXT_MINIMUM = 4.5;
const NON_TEXT_MINIMUM = 3;

const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
};

const ratio = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

/**
 * Reads the custom properties from a `:root` block.
 *
 * `blockIndex` 0 is the light scheme; 1 is the `prefers-color-scheme: dark`
 * override, whose values are merged over the light ones exactly as the cascade
 * would.
 */
const readTokens = (css: string, blockIndex: number): Record<string, string> => {
  const blocks = [...css.matchAll(/:root\s*\{([^}]*)\}/g)];
  const block = blocks[blockIndex];
  assert.notEqual(block, undefined, `expected a :root block at index ${String(blockIndex)}`);
  const tokens: Record<string, string> = {};
  for (const match of (block?.[1] ?? "").matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[match[1] ?? ""] = (match[2] ?? "").toLowerCase();
  }
  return tokens;
};

/** Every foreground/background pair the interface renders. */
const PAIRS: readonly (readonly [string, string, string, number])[] = [
  ["body text", "--ink", "--page", TEXT_MINIMUM],
  ["muted text on the page", "--ink-muted", "--page", TEXT_MINIMUM],
  ["muted text on a panel", "--ink-muted", "--panel", TEXT_MINIMUM],
  ["primary button label", "--accent-ink", "--accent", TEXT_MINIMUM],
  ["error text on the page", "--danger", "--page", TEXT_MINIMUM],
  ["error text in the summary", "--danger", "--danger-bg", TEXT_MINIMUM],
  ["claimed-pin warning text", "--warning-ink", "--warning-bg", TEXT_MINIMUM],
  // The focus ring is a UI component, not text, so 3:1 is its threshold.
  ["focus ring against the page", "--focus", "--page", NON_TEXT_MINIMUM],
  ["focus ring against a panel", "--focus", "--panel", NON_TEXT_MINIMUM],
];

const css = readFileSync(CSS_PATH, "utf8");

/**
 * The stylesheet with comments removed.
 *
 * Needed because the first version of the checks below matched the file's own
 * prose — a comment stating that `outline: none` appears nowhere counted as an
 * occurrence of it. Declarations are what these assertions are about.
 */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
const light = readTokens(css, 0);
const dark = { ...light, ...readTokens(css, 1) };

for (const [schemeName, tokens] of [
  ["light", light],
  ["dark", dark],
] as const) {
  test(`V019: ${schemeName} scheme meets the contrast thresholds`, () => {
    for (const [description, foreground, background, minimum] of PAIRS) {
      const fg = tokens[foreground];
      const bg = tokens[background];
      assert.notEqual(fg, undefined, `${schemeName}: ${foreground} is not defined`);
      assert.notEqual(bg, undefined, `${schemeName}: ${background} is not defined`);

      const measured = ratio(fg ?? "#000000", bg ?? "#ffffff");
      assert.ok(
        measured >= minimum,
        `${schemeName}: ${description} is ${measured.toFixed(2)}:1, below the required ${String(minimum)}:1`,
      );
    }
  });
}

test("V019: focus is never removed and hidden always wins", () => {
  assert.doesNotMatch(
    declarations,
    /outline:\s*(none|0)/,
    "removing the focus outline makes the interface unusable by keyboard",
  );
  assert.match(
    declarations,
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    "author display rules override the browser's [hidden], so this must stay",
  );
  assert.doesNotMatch(
    declarations,
    /user-scalable\s*=\s*no|maximum-scale/,
    "the interface must not block zoom",
  );
});

test("V019: every interactive class reserves a 44px minimum target", () => {
  // 2.75rem at the default root size is 44px. Checked as text because the
  // rendered size is verified in a browser, and this guards the intent.
  const buttonBlock = /\.button,\s*\.button-secondary,\s*\.button-quiet\s*\{([^}]*)\}/.exec(
    declarations,
  );
  assert.notEqual(buttonBlock, null, "the shared button block must exist");
  assert.match(buttonBlock?.[1] ?? "", /min-height:\s*2\.75rem/);
  assert.match(buttonBlock?.[1] ?? "", /min-width:\s*2\.75rem/);
});
