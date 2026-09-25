/**
 * The rule that makes an attack suite mean something (roadmap V047).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ATTACK_CLASSES,
  BANNED_SECURITY_PHRASES,
  SECURITY_LIMITS,
  probeStatement,
  probeVerdict,
  securityClaimVerdict,
  securityOverclaims,
  type AttackClass,
  type ProbeObservation,
} from "./abuse-surface.ts";

const probe = (overrides: Partial<ProbeObservation> = {}): ProbeObservation => ({
  goal: {
    attackClass: "authorization_bypass",
    name: "a probe",
    ifItWorks: "the attacker gets in",
  },
  attackAchievedGoal: false,
  controlSucceeded: true,
  detail: "refused",
  ...overrides,
});

const everyClass = (): readonly ProbeObservation[] =>
  ATTACK_CLASSES.map((attackClass: AttackClass) =>
    probe({ goal: { attackClass, name: attackClass, ifItWorks: "something bad" } }),
  );

test("an attack that failed while its control also failed tested nothing", () => {
  assert.equal(probeVerdict(probe({ controlSucceeded: false })), "inconclusive");
});

test("an attack that failed against a working control is blocked", () => {
  assert.equal(probeVerdict(probe()), "blocked");
});

test("an attack that worked is reported as succeeded whatever the control did", () => {
  assert.equal(
    probeVerdict(probe({ attackAchievedGoal: true, controlSucceeded: false })),
    "succeeded",
  );
});

test("an inconclusive probe says so in words, rather than reading as a pass", () => {
  const statement = probeStatement(probe({ controlSucceeded: false }));
  assert.match(statement, /inconclusive/);
  assert.match(statement, /nothing was tested/);
  assert.doesNotMatch(statement, /^blocked/);
});

test("a run where every probe was refused against a working control is clean", () => {
  const verdict = securityClaimVerdict({
    observations: everyClass(),
    uncoveredStateChangingEndpoints: [],
  });
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.everyProbeBlocked, true);
  assert.equal(verdict.blocked, ATTACK_CLASSES.length);
});

test("an attack class with no probe at all is a reason, not a silence", () => {
  const verdict = securityClaimVerdict({
    observations: everyClass().filter(
      (observation) => observation.goal.attackClass !== "media_abuse",
    ),
    uncoveredStateChangingEndpoints: [],
  });
  assert.equal(verdict.everyProbeBlocked, false);
  assert.ok(verdict.reasons.some((reason) => reason.includes("media_abuse")));
});

test("a state-changing endpoint nobody attacks is a reason", () => {
  const verdict = securityClaimVerdict({
    observations: everyClass(),
    uncoveredStateChangingEndpoints: ["POST /v1/something/new"],
  });
  assert.equal(verdict.everyProbeBlocked, false);
  assert.ok(verdict.reasons.some((reason) => reason.includes("/v1/something/new")));
});

test("inconclusive probes are counted separately from blocked ones", () => {
  const verdict = securityClaimVerdict({
    observations: [
      ...everyClass(),
      probe({
        controlSucceeded: false,
        goal: {
          attackClass: "media_abuse",
          name: "an untested probe",
          ifItWorks: "something bad",
        },
      }),
    ],
    uncoveredStateChangingEndpoints: [],
  });
  assert.equal(verdict.inconclusive, 1);
  assert.equal(verdict.blocked, ATTACK_CLASSES.length);
  assert.equal(verdict.everyProbeBlocked, false);
});

test("the verdict never reports a system as secure, only that these attacks were refused", () => {
  const verdict = securityClaimVerdict({
    observations: everyClass(),
    uncoveredStateChangingEndpoints: [],
  });
  assert.equal("secure" in verdict, false);
  assert.ok(Object.keys(verdict).includes("everyProbeBlocked"));
});

test("the limits say what a clean run still does not establish", () => {
  assert.ok(SECURITY_LIMITS.length >= 4);
  assert.ok(SECURITY_LIMITS.some((limit) => /nobody thought of/.test(limit)));
  assert.ok(SECURITY_LIMITS.some((limit) => /prompt injection/.test(limit)));
});

test("the banned phrasings catch a claim a probe suite cannot support", () => {
  assert.ok(securityOverclaims("The API is secure and has no vulnerabilities.").length >= 2);
  assert.ok(securityOverclaims("bank-grade protection").length >= 1);
});

test("the honest sentences this report needs are not banned", () => {
  const honest = [
    "No test here establishes that this system is safe against an attack nobody wrote.",
    "Every probe in this suite reached its boundary and was refused.",
    "A clean run is evidence about the attacks in it and about nothing else.",
  ].join(" ");
  assert.deepEqual(securityOverclaims(honest), []);
});

test("every banned phrase is lower case so the substring check cannot miss one", () => {
  for (const phrase of BANNED_SECURITY_PHRASES) assert.equal(phrase, phrase.toLowerCase());
});
