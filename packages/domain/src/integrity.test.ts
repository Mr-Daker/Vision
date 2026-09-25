/**
 * What a finding has to carry before it counts as one (roadmap V048).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AFFECTED_LIMIT,
  BANNED_INTEGRITY_PHRASES,
  INTEGRITY_LIMITS,
  INVARIANTS,
  IntegrityFindingError,
  findingStatement,
  integrityFinding,
  integrityOverclaims,
  integrityVerdict,
  type CheckOutcome,
} from "./integrity.ts";

const base = {
  check: "a_check",
  invariant: "uniqueness" as const,
  recoverability: "repairable_by_operator" as const,
  what: "something is wrong",
  affected: ["id-1"],
  matched: 1,
  procedure: "read both rows and decide which is right, recording who decided",
  ifNobodyActs: "the wrong number keeps being shown to everybody who reads it",
};

test("a finding with no repair procedure is refused", () => {
  assert.throws(() => integrityFinding({ ...base, procedure: "fix it" }), IntegrityFindingError);
});

test("a finding that does not say what happens if nobody acts is refused", () => {
  assert.throws(() => integrityFinding({ ...base, ifNobodyActs: "bad" }), IntegrityFindingError);
});

test("an unrecoverable finding that does not say what was lost is refused", () => {
  assert.throws(
    () => integrityFinding({ ...base, recoverability: "unrecoverable" }),
    IntegrityFindingError,
  );
});

test("a repairable finding claiming a loss is refused", () => {
  assert.throws(() => integrityFinding({ ...base, lost: "everything" }), IntegrityFindingError);
});

test("a well-formed finding survives, and its identifiers are bounded", () => {
  const finding = integrityFinding({
    ...base,
    affected: Array.from({ length: AFFECTED_LIMIT + 40 }, (_, index) => `id-${String(index)}`),
    matched: AFFECTED_LIMIT + 40,
  });
  assert.equal(finding.affected.length, AFFECTED_LIMIT);
  assert.equal(finding.matched, AFFECTED_LIMIT + 40);
});

test("the statement says how many were not listed rather than pretending it listed them", () => {
  const statement = findingStatement(
    integrityFinding({
      ...base,
      affected: ["id-1", "id-2"],
      matched: 9,
    }),
  );
  assert.match(statement, /and 7 more/);
  assert.match(statement, /do this:/);
  assert.match(statement, /if nobody acts:/);
});

const clean = (invariant: (typeof INVARIANTS)[number]): CheckOutcome => ({
  check: `check_${invariant}`,
  invariant,
  ran: true,
  findings: [],
});

test("a run where every invariant was checked and nothing was found is clean", () => {
  const verdict = integrityVerdict(INVARIANTS.map(clean));
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.everyCheckRanAndFoundNothing, true);
});

test("an invariant nobody checked is a reason, not a silence", () => {
  const verdict = integrityVerdict(INVARIANTS.filter((i) => i !== "delivery").map(clean));
  assert.equal(verdict.everyCheckRanAndFoundNothing, false);
  assert.ok(verdict.reasons.some((reason) => reason.includes("delivery")));
});

test("a check that could not run is a reason, and never counts as a pass", () => {
  const outcomes = INVARIANTS.map(clean).map((outcome, index) =>
    index === 0 ? { ...outcome, ran: false, reasonNotRun: "the table is missing" } : outcome,
  );
  const verdict = integrityVerdict(outcomes);
  assert.equal(verdict.everyCheckRanAndFoundNothing, false);
  assert.ok(verdict.reasons.some((reason) => /did not run/.test(reason)));
});

test("findings are counted by what can be done about them", () => {
  const verdict = integrityVerdict([
    ...INVARIANTS.map(clean),
    {
      check: "a",
      invariant: "uniqueness",
      ran: true,
      findings: [integrityFinding({ ...base, recoverability: "repairable_by_rebuild" })],
    },
    {
      check: "b",
      invariant: "uniqueness",
      ran: true,
      findings: [
        integrityFinding({
          ...base,
          recoverability: "unrecoverable",
          lost: "who decided, and why",
        }),
      ],
    },
  ]);
  assert.equal(verdict.rebuildRepairs, 1);
  assert.equal(verdict.unrecoverable, 1);
  assert.equal(verdict.operatorRepairs, 0);
});

test("checks the schema enforces are counted, so the report can say which is which", () => {
  const verdict = integrityVerdict([
    ...INVARIANTS.map(clean),
    { ...clean("uniqueness"), check: "enforced", enforcedBy: "some_constraint_uniq" },
  ]);
  assert.equal(verdict.enforcedByTheDatabase, 1);
});

test("the limits say what a clean run still does not establish", () => {
  assert.ok(INTEGRITY_LIMITS.some((limit) => /nobody wrote down|somebody wrote down/.test(limit)));
  assert.ok(INTEGRITY_LIMITS.some((limit) => /cannot occur at all/.test(limit)));
});

test("the banned phrasings catch a claim a check cannot support", () => {
  assert.ok(
    integrityOverclaims("The projection is guaranteed consistent and self-healing.").length >= 2,
  );
  for (const phrase of BANNED_INTEGRITY_PHRASES) assert.equal(phrase, phrase.toLowerCase());
});

test("the honest sentences this report needs are not banned", () => {
  assert.deepEqual(
    integrityOverclaims(
      "Every check that ran found nothing. Four of these conditions cannot occur because a constraint refuses them.",
    ),
    [],
  );
});
