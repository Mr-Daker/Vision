/**
 * Demonstration notices at the screens that need them (roadmap V044).
 *
 * Two things must be said where a reader would otherwise assume the opposite,
 * and both are said at the screen rather than in a policy page nobody opens:
 *
 *  - **identity is simulated** — wherever somebody signs in or their account
 *    is shown, because a sign-in that looks like DigiLocker and is not would
 *    be the single most misleading thing in this product;
 *  - **departments and recipients are simulated** — wherever a department,
 *    a recipient or a delivery appears, because a screen that says a report
 *    reached an authority when nothing was sent is a false assurance given to
 *    somebody who is relying on it.
 *
 * Checked against the shipped HTML rather than against a constant, so a notice
 * removed during a redesign fails here rather than being noticed by a user.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../public");

const read = (page: string): string => readFileSync(join(PUBLIC_DIR, page), "utf8");

/** Screens where somebody signs in or their identity is shown. */
const IDENTITY_SCREENS = [
  "index.html",
  "signin.html",
  "app.html",
  "staff.html",
  "reviewer.html",
  "supervisor.html",
  "dashboard.html",
  "compare.html",
];

/** Screens where a department, a recipient or a delivery appears. */
const DEPARTMENT_SCREENS = [
  "index.html",
  "app.html",
  "staff.html",
  "reviewer.html",
  "supervisor.html",
  "dashboard.html",
  "compare.html",
];

// "simulated" and "part of a simulation" are the same claim, and a test that
// insisted on one word form would be checking prose rather than the promise.
const SIMULATED = "simulat(?:ed|ion)";

const IDENTITY_NOTICE = new RegExp(
  `identit(?:y|ies)[^.]{0,120}${SIMULATED}|${SIMULATED}[^.]{0,120}identit(?:y|ies)|not a real identity check`,
  "i",
);

const DEPARTMENT_NOTICE = new RegExp(
  `(?:department|recipient|authority|official)[^.]{0,160}${SIMULATED}|${SIMULATED}[^.]{0,160}(?:department|recipient|authority|official)`,
  "i",
);

test("every screen where somebody signs in says the identity is simulated", () => {
  for (const page of IDENTITY_SCREENS) {
    assert.match(
      read(page),
      IDENTITY_NOTICE,
      `${page} offers or reflects a sign-in without saying the identity is simulated`,
    );
  }
});

test("every screen showing a department or recipient says they are simulated", () => {
  for (const page of DEPARTMENT_SCREENS) {
    assert.match(
      read(page),
      DEPARTMENT_NOTICE,
      `${page} shows departmental handling without saying it is simulated`,
    );
  }
});

test("no screen claims a report reached a real authority", () => {
  const forbidden = [
    /\bsent to the (?:department|authority|government)\b/i,
    /\bfiled with\b/i,
    /\bofficial complaint\b/i,
    /\byour report has been delivered\b/i,
  ];
  for (const page of [...new Set([...IDENTITY_SCREENS, ...DEPARTMENT_SCREENS])]) {
    const html = read(page);
    for (const pattern of forbidden) {
      assert.doesNotMatch(html, pattern, `${page} claims a report reached a real authority`);
    }
  }
});

test("the citizen app says both things, because it is the screen a reporter uses", () => {
  // The one screen where somebody might act on the belief that a real
  // department received their report.
  const app = read("app.html");
  assert.match(app, IDENTITY_NOTICE);
  assert.match(app, DEPARTMENT_NOTICE);
});

test("every operator screen carries a footer disclaiming what it is", () => {
  for (const page of [
    "staff.html",
    "reviewer.html",
    "supervisor.html",
    "dashboard.html",
    "compare.html",
  ]) {
    const html = read(page);
    const footer = /<footer>([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
    assert.ok(footer.trim().length > 40, `${page} has no footer disclaimer`);
    assert.match(footer, /simulat|demonstration/i, `${page}'s footer does not say what this is`);
  }
});
