/**
 * Category-specific resolution confirmation policy (roadmap V035).
 *
 * The rule this exists to enforce: **a repair claim is not a verified
 * resolution.** Someone saying they fixed something is a claim; whether it
 * counts as resolved depends on who confirms it, and for some categories on
 * whether anyone qualified could confirm it at all.
 *
 * The policy is data supplied by the caller, never a branch on a category name
 * in this file (V001 Appendix G rule 7).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateConfirmation,
  DEFAULT_CONFIRMATION_RULE,
  type ConfirmationPolicyPack,
} from "./confirmation-policy.ts";

const pack: ConfirmationPolicyPack = {
  version: "demo-confirmation.v1",
  rules: {
    routine: { requiredConfirmations: 1, citizenMayConfirm: true, reviewerMayOverride: true },
    safety: {
      requiredConfirmations: 2,
      citizenMayConfirm: true,
      reviewerMayOverride: false,
      requiresQualifiedInspection: true,
    },
  },
};

const claim = (overrides: Record<string, unknown> = {}) => ({
  category: "routine",
  policy: pack,
  claimEvidenceCount: 1,
  confirmations: [] as readonly {
    actor: "participant" | "reviewer";
    decision: "confirmed" | "disputed";
    hasCountedParticipation?: boolean;
  }[],
  ...overrides,
});

test("V035: a claim on its own is never a verified resolution", () => {
  const result = evaluateConfirmation(claim());

  assert.equal(result.status, "claimed_awaiting_confirmation");
  assert.equal(result.isVerifiedResolution, false);
  assert.match(result.reason, /claim|not .*confirmed|awaiting/i);
});

test("V035: a claim with no completion evidence cannot even be awaiting confirmation", () => {
  const result = evaluateConfirmation(claim({ claimEvidenceCount: 0 }));

  assert.equal(result.status, "claim_incomplete");
  assert.equal(result.isVerifiedResolution, false);
  assert.match(result.reason, /evidence/i);
});

test("V035: one citizen confirmation resolves a routine category", () => {
  const result = evaluateConfirmation(
    claim({
      confirmations: [
        { actor: "participant", decision: "confirmed", hasCountedParticipation: true },
      ],
    }),
  );

  assert.equal(result.status, "confirmed");
  assert.equal(result.isVerifiedResolution, true);
});

test("V035: a confirmation from someone whose participation does not count is ignored", () => {
  const result = evaluateConfirmation(
    claim({
      confirmations: [
        { actor: "participant", decision: "confirmed", hasCountedParticipation: false },
      ],
    }),
  );

  assert.equal(result.status, "claimed_awaiting_confirmation");
  assert.match(result.reason, /counted|eligible/i);
});

test("V035: a safety category needs two confirmations, not one", () => {
  const one = evaluateConfirmation(
    claim({
      category: "safety",
      confirmations: [
        { actor: "participant", decision: "confirmed", hasCountedParticipation: true },
      ],
    }),
  );
  const two = evaluateConfirmation(
    claim({
      category: "safety",
      confirmations: [
        { actor: "participant", decision: "confirmed", hasCountedParticipation: true },
        { actor: "participant", decision: "confirmed", hasCountedParticipation: true },
      ],
    }),
  );

  assert.equal(one.status, "claimed_awaiting_confirmation");
  assert.equal(two.isVerifiedResolution, true);
});

test("V035: any dispute stops the claim being resolved, however many confirmations", () => {
  const result = evaluateConfirmation(
    claim({
      confirmations: [
        { actor: "participant", decision: "confirmed", hasCountedParticipation: true },
        { actor: "participant", decision: "disputed", hasCountedParticipation: true },
      ],
    }),
  );

  assert.equal(result.status, "disputed");
  assert.equal(result.isVerifiedResolution, false);
  assert.match(result.reason, /dispute/i);
});

test("V035: a reviewer may resolve a dispute where the policy allows it", () => {
  const result = evaluateConfirmation(
    claim({
      confirmations: [
        { actor: "participant", decision: "disputed", hasCountedParticipation: true },
        { actor: "reviewer", decision: "confirmed" },
      ],
    }),
  );

  assert.equal(result.status, "confirmed");
  assert.equal(result.resolvedByReviewer, true);
});

test("V035: a reviewer may not override a dispute where the policy forbids it", () => {
  // A safety category is exactly where a reviewer overruling the people who
  // live there would be least defensible.
  const result = evaluateConfirmation(
    claim({
      category: "safety",
      confirmations: [
        { actor: "participant", decision: "disputed", hasCountedParticipation: true },
        { actor: "reviewer", decision: "confirmed" },
      ],
    }),
  );

  assert.equal(result.status, "disputed");
  assert.equal(result.isVerifiedResolution, false);
  assert.match(result.reason, /may not override|policy/i);
});

test("V035: an unknown category falls back to the strictest default, not to permissive", () => {
  const result = evaluateConfirmation(claim({ category: "never-configured" }));

  assert.equal(
    result.appliedRule.requiredConfirmations,
    DEFAULT_CONFIRMATION_RULE.requiredConfirmations,
  );
  assert.equal(result.appliedRule.reviewerMayOverride, false);
  assert.match(result.reason, /no rule|default/i);
});

test("V035: the policy version used is recorded on every evaluation", () => {
  const result = evaluateConfirmation(claim());

  assert.equal(result.policyVersion, "demo-confirmation.v1");
});

test("V035: a photograph is never presented as a safety certification", () => {
  const result = evaluateConfirmation(
    claim({
      category: "safety",
      confirmations: [
        { actor: "participant", decision: "confirmed", hasCountedParticipation: true },
        { actor: "participant", decision: "confirmed", hasCountedParticipation: true },
      ],
    }),
  );

  assert.equal(result.isVerifiedResolution, true);
  // Even a fully confirmed safety repair carries *both* disclosures, and they
  // say different things: one that agreement is not a certification, one that
  // the inspection this category needs has not happened. An earlier version
  // asserted only a loose pattern that the first disclosure already satisfied,
  // so the second could be dropped with no test noticing.
  assert.match(result.disclosures.join(" "), /not an engineer's certification/i);
  assert.match(result.disclosures.join(" "), /qualified person should inspect/i);
  assert.match(result.disclosures.join(" "), /no such inspection has happened/i);
  assert.equal(result.disclosures.length, 2);
  assert.equal(result.requiresQualifiedInspection, true);
});

test("V035: a routine resolution still says what it does not establish", () => {
  const result = evaluateConfirmation(
    claim({
      confirmations: [
        { actor: "participant", decision: "confirmed", hasCountedParticipation: true },
      ],
    }),
  );

  // A routine category gets the certification disclosure but not the
  // inspection one: claiming an inspection is needed where the policy does not
  // say so would be its own kind of overstatement.
  assert.equal(result.disclosures.length, 1);
  assert.match(result.disclosures[0] ?? "", /not a guarantee the repair is permanent/i);
  assert.equal(result.requiresQualifiedInspection, false);
});
