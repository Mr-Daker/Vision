/**
 * What an attack has to demonstrate before it counts (roadmap V047).
 *
 * A suite of attacks that all come back "blocked" is the easiest green thing
 * in software to produce, because a request that never reached the boundary is
 * indistinguishable from one the boundary refused. A typo in a path returns
 * 404. An unparsed body returns 400. Both look exactly like a defence working.
 *
 * So the unit here is not an attack, it is an attack **plus its control**: the
 * same request made legitimately, which must succeed. If the control does not
 * succeed, the probe is `inconclusive` — never `blocked` — and the verdict
 * refuses on it. This is the same device V044's privacy audit uses when it
 * plants data before declaring anything clean: a detector nobody has watched
 * work is a source of confidence rather than evidence.
 *
 * Nothing here says a system is secure. `securityClaimVerdict` cannot return
 * "secure" at all; the best it returns is that every boundary this suite knows
 * how to attack held against the attacks in it, which is a much smaller claim
 * and the only one a test suite can support.
 *
 * Pure: no clock, no storage, no network.
 */

/** The classes V047 names, plus the two properties its "done when" adds. */
export type AttackClass =
  | "authorization_bypass"
  | "cross_jurisdiction_access"
  | "media_abuse"
  | "forged_identity_field"
  | "repeated_contribution"
  | "secret_exposure"
  | "embedded_instruction"
  | "output_validation"
  | "resource_bound";

export const ATTACK_CLASSES: readonly AttackClass[] = [
  "authorization_bypass",
  "cross_jurisdiction_access",
  "media_abuse",
  "forged_identity_field",
  "repeated_contribution",
  "secret_exposure",
  "embedded_instruction",
  "output_validation",
  "resource_bound",
];

/**
 * What the attacker was trying to obtain.
 *
 * Recorded per probe because "blocked" means nothing without it: a request
 * refused with 403 while the data it wanted leaks from a different endpoint
 * has not been blocked, it has been redirected.
 */
export type AttackGoal = {
  readonly attackClass: AttackClass;
  readonly name: string;
  /** Plain sentence: what the attacker gets if this works. */
  readonly ifItWorks: string;
};

export type ProbeObservation = {
  readonly goal: AttackGoal;
  /**
   * Did the attack achieve the goal? Decided by the caller from the response,
   * not inferred from a status code — a 200 carrying an error envelope and a
   * 403 are both refusals, and a 200 carrying the data is not.
   */
  readonly attackAchievedGoal: boolean;
  /**
   * Did the same operation succeed when performed legitimately?
   *
   * Required. Without it the probe proves the request failed, not that the
   * boundary refused it.
   */
  readonly controlSucceeded: boolean;
  /** Short, non-reproducing note: what came back. */
  readonly detail: string;
};

export type ProbeVerdict = "blocked" | "succeeded" | "inconclusive";

export const probeVerdict = (observation: ProbeObservation): ProbeVerdict => {
  if (observation.attackAchievedGoal) return "succeeded";
  if (!observation.controlSucceeded) return "inconclusive";
  return "blocked";
};

export const probeStatement = (observation: ProbeObservation): string => {
  const verdict = probeVerdict(observation);
  if (verdict === "succeeded") {
    return `**succeeded** — ${observation.goal.ifItWorks}. ${observation.detail}`;
  }
  if (verdict === "inconclusive") {
    return `inconclusive — the attack failed, but the same operation performed legitimately also failed, so nothing was tested. ${observation.detail}`;
  }
  return `blocked — ${observation.detail}`;
};

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type SecurityRunConditions = {
  readonly observations: readonly ProbeObservation[];
  /**
   * Endpoints that change state and are not covered by any probe.
   *
   * Supplied by the caller from the routing sources rather than from a list
   * somebody maintains by hand, because the failure this catches is a new
   * endpoint nobody thought to attack.
   */
  readonly uncoveredStateChangingEndpoints: readonly string[];
};

export type SecurityVerdict = {
  /**
   * Deliberately not named `secure`. It says only that every attack this suite
   * contains was refused by the boundary it aimed at.
   */
  readonly everyProbeBlocked: boolean;
  readonly reasons: readonly string[];
  readonly blocked: number;
  readonly succeeded: number;
  readonly inconclusive: number;
};

export const securityClaimVerdict = (conditions: SecurityRunConditions): SecurityVerdict => {
  const reasons: string[] = [];
  const verdicts = conditions.observations.map((observation) => ({
    observation,
    verdict: probeVerdict(observation),
  }));

  for (const { observation, verdict } of verdicts) {
    if (verdict === "succeeded") {
      reasons.push(`'${observation.goal.name}' achieved its goal: ${observation.goal.ifItWorks}`);
    }
    if (verdict === "inconclusive") {
      reasons.push(
        `'${observation.goal.name}' tested nothing: its control did not succeed, so the attack's failure says nothing about the boundary (${observation.detail})`,
      );
    }
  }

  const covered = new Set(
    conditions.observations.map((observation) => observation.goal.attackClass),
  );
  for (const attackClass of ATTACK_CLASSES) {
    if (!covered.has(attackClass)) {
      reasons.push(`no probe exercises '${attackClass}', which V047 names explicitly`);
    }
  }

  for (const endpoint of conditions.uncoveredStateChangingEndpoints) {
    reasons.push(
      `'${endpoint}' changes state and no probe attacks it, so nothing here says whether it is reachable without the right session`,
    );
  }

  return {
    everyProbeBlocked: reasons.length === 0,
    reasons,
    blocked: verdicts.filter((entry) => entry.verdict === "blocked").length,
    succeeded: verdicts.filter((entry) => entry.verdict === "succeeded").length,
    inconclusive: verdicts.filter((entry) => entry.verdict === "inconclusive").length,
  };
};

/**
 * What this suite still does not establish, whatever its results.
 *
 * Printed with every report, because "every probe blocked" is read as "it is
 * safe" unless the distance between those two is stated in the same breath.
 */
export const SECURITY_LIMITS: readonly string[] = [
  "this is a suite of attacks somebody thought of; a class of attack nobody thought of produces no probe and therefore no finding",
  "it exercises the application's own boundaries, not the platform's — no dependency, container, network or provider configuration is tested here",
  "no test here establishes that a model resists a prompt injection; what is tested is that the system holds when the model does not",
  "no timing, side-channel, cryptographic or denial-of-service analysis is attempted",
  "a probe proves a boundary refused one request, never that the boundary is correct for every request",
];

/**
 * Phrasings a V047 report may not contain.
 *
 * Checked against the published documents. The list is claim shapes rather
 * than bare words, because this report has to be able to write the sentence
 * "no test here establishes that this is secure".
 */
export const BANNED_SECURITY_PHRASES: readonly string[] = [
  "is secure",
  "fully secure",
  "is hardened",
  "no vulnerabilities",
  "cannot be hacked",
  "attack-proof",
  "guaranteed safe",
  "penetration tested",
  "security certified",
  "bank-grade",
  "military-grade",
  "unbreakable",
];

export const securityOverclaims = (text: string): readonly string[] => {
  const haystack = text.toLowerCase();
  return BANNED_SECURITY_PHRASES.filter((phrase) => haystack.includes(phrase));
};
