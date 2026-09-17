/**
 * Foundational accessibility of the shipped screens (roadmap V045).
 *
 * V045's acceptance clause ends "foundational accessibility is not deferred to
 * V065". This is the part of that which can be checked on every commit: a
 * static audit of the markup that actually ships, so a control that loses its
 * label during a redesign fails here rather than being found by somebody using
 * a screen reader.
 *
 * It is a **floor, not a substitute**. Focus order under a real Tab press,
 * what a screen reader announces, behaviour at 200% zoom and on a throttled
 * connection are dynamic properties this cannot see; those are verified in a
 * browser and recorded in the V045 results with the date they were checked.
 * Saying so matters: a green static audit read as "accessible" is exactly the
 * false assurance this task exists to prevent.
 *
 * The parsing is deliberately simple and errs towards reporting. A check that
 * occasionally flags something fine costs a moment; one that silently skips a
 * control because the markup surprised it defeats the purpose.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../public");

const PAGES = readdirSync(PUBLIC_DIR).filter((name) => name.endsWith(".html"));

const read = (page: string): string => readFileSync(join(PUBLIC_DIR, page), "utf8");

/** Strips comments, so markup discussed in a comment is not audited as markup. */
const withoutComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "");

const tagsOf = (html: string, tag: string): readonly string[] =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "gi"))].map((match) => match[0]);

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return match?.[1];
};

test("V045: every page declares a language", () => {
  for (const page of PAGES) {
    const html = withoutComments(read(page));
    const root = tagsOf(html, "html")[0] ?? "";
    const lang = attribute(root, "lang");
    assert.ok(
      lang !== undefined && lang.length > 0,
      `${page} has no lang, so a screen reader guesses the pronunciation of every word`,
    );
  }
});

test("V045: every page has one main landmark and a skip link that reaches it", () => {
  for (const page of PAGES) {
    const html = withoutComments(read(page));
    const mains = tagsOf(html, "main");
    assert.equal(mains.length, 1, `${page} must have exactly one main landmark`);

    const skip = /<a[^>]*class="[^"]*skip-link[^"]*"[^>]*href="#([^"]+)"/i.exec(html);
    assert.notEqual(skip, null, `${page} has no skip link, so keyboard users traverse the header`);
    const target = skip?.[1] ?? "";
    assert.ok(
      new RegExp(`id="${target}"`).test(html),
      `${page}'s skip link points at #${target}, which does not exist`,
    );
  }
});

test("V045: no page uses a positive tabindex", () => {
  for (const page of PAGES) {
    const html = withoutComments(read(page));
    const offenders = [...html.matchAll(/tabindex\s*=\s*"([^"]*)"/gi)]
      .map((match) => match[1] ?? "")
      .filter((value) => Number(value) > 0);
    assert.deepEqual(
      offenders,
      [],
      `${page} sets a positive tabindex, which reorders the page for keyboard users only`,
    );
  }
});

test("V045: every image carries alt text, even if empty", () => {
  for (const page of PAGES) {
    const html = withoutComments(read(page));
    for (const tag of tagsOf(html, "img")) {
      assert.ok(
        /\balt\s*=/.test(tag),
        `${page} has an <img> with no alt attribute: ${tag.slice(0, 80)}`,
      );
    }
  }
});

test("V045: every form control has a name a screen reader can announce", () => {
  for (const page of PAGES) {
    const html = withoutComments(read(page));
    const labelledIds = new Set(
      [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*"([^"]+)"/gi)].map((match) => match[1] ?? ""),
    );
    // A control wrapped in its label needs no `for`.
    const wrapped = new Set(
      [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)].flatMap((match) =>
        [...(match[0] ?? "").matchAll(/\bid\s*=\s*"([^"]+)"/gi)].map((inner) => inner[1] ?? ""),
      ),
    );

    for (const control of ["input", "select", "textarea"]) {
      for (const tag of tagsOf(html, control)) {
        if (/\btype\s*=\s*"(?:hidden|submit|button)"/i.test(tag)) continue;
        const id = attribute(tag, "id") ?? "";
        const named =
          attribute(tag, "aria-label") !== undefined ||
          attribute(tag, "aria-labelledby") !== undefined ||
          labelledIds.has(id) ||
          wrapped.has(id);
        assert.ok(
          named,
          `${page} has a <${control}> with no label, aria-label or aria-labelledby: ${tag.slice(0, 90)}`,
        );
      }
    }
  }
});

test("V045: every button and link in the markup has something to announce", () => {
  for (const page of PAGES) {
    const html = withoutComments(read(page));
    for (const [, open, inner] of html.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/gi)) {
      const hasText = (inner ?? "").replace(/<[^>]*>/g, "").trim().length > 0;
      const hasLabel = attribute(open ?? "", "aria-label") !== undefined;
      assert.ok(
        hasText || hasLabel,
        `${page} has a button with neither text nor aria-label: ${(open ?? "").slice(0, 80)}`,
      );
    }
    for (const [, open, inner] of html.matchAll(/(<a\b[^>]*href[^>]*>)([\s\S]*?)<\/a>/gi)) {
      const stripped = (inner ?? "").replace(/<[^>]*>/g, "").trim();
      const hasImageAlt = /\balt\s*=\s*"[^"]+"/i.test(inner ?? "");
      const hasLabel = attribute(open ?? "", "aria-label") !== undefined;
      assert.ok(
        stripped.length > 0 || hasImageAlt || hasLabel,
        `${page} has a link with nothing to announce: ${(open ?? "").slice(0, 80)}`,
      );
    }
  }
});

test("V045: headings descend without skipping a level", () => {
  for (const page of PAGES) {
    const html = withoutComments(read(page));
    const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((match) => Number(match[1]));
    let previous = 0;
    for (const level of levels) {
      if (previous !== 0) {
        assert.ok(
          level <= previous + 1,
          `${page} jumps from h${String(previous)} to h${String(level)}, which reads as a missing section`,
        );
      }
      previous = level;
    }
    assert.equal(levels[0], 1, `${page} must open at h1`);
  }
});

test("V045: a data table names itself", () => {
  for (const page of PAGES) {
    const html = withoutComments(read(page));
    for (const [, block] of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
      const open = tagsOf(html, "table")[0] ?? "";
      const named =
        /<caption\b/i.test(block ?? "") ||
        attribute(open, "aria-label") !== undefined ||
        attribute(open, "aria-labelledby") !== undefined;
      assert.ok(named, `${page} has a table with no caption or accessible name`);
    }
  }
});

test("V045: no control relies on a placeholder as its only name", () => {
  // A placeholder disappears on focus and is not announced as a label by every
  // assistive technology, so a field named only by one is a field with no name
  // at the moment somebody is typing into it.
  for (const page of PAGES) {
    const html = withoutComments(read(page));
    const labelledIds = new Set(
      [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*"([^"]+)"/gi)].map((match) => match[1] ?? ""),
    );
    for (const tag of tagsOf(html, "input")) {
      if (attribute(tag, "placeholder") === undefined) continue;
      const id = attribute(tag, "id") ?? "";
      const named =
        attribute(tag, "aria-label") !== undefined ||
        attribute(tag, "aria-labelledby") !== undefined ||
        labelledIds.has(id);
      assert.ok(named, `${page} names a field only by its placeholder: ${tag.slice(0, 90)}`);
    }
  }
});

test("V045: the citizen app keeps its live regions, which is how progress is announced", () => {
  // Without one, a screen-reader user gets no confirmation that anything
  // happened when a report is sent.
  const app = withoutComments(read("app.html"));
  assert.match(app, /aria-live\s*=\s*"(?:polite|assertive)"/i);
  assert.match(app, /role\s*=\s*"alert"/i, "an error that is not announced is an error not seen");
});
