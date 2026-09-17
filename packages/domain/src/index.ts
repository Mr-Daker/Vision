/**
 * @vision/domain — pure domain policy and state transitions.
 *
 * Import direction rule (V006 §9): domain imports @vision/contracts only. It
 * must never import adapters, config packs, or an application.
 */

export * from "./entities.ts";
export * from "./session-policy.ts";
export * from "./transitions.ts";
export * from "./alias.ts";
export * from "./participation.ts";
export * from "./authorization.ts";

export * from "./redaction-policy.ts";
export * from "./language-policy.ts";
export * from "./trust-signals.ts";
export * from "./match-proposal.ts";
export * from "./confirmation-policy.ts";
export * from "./triage-order.ts";
export * from "./ageing-policy.ts";

export * from "./metric-semantics.ts";
export * from "./summary-projection.ts";
export * from "./context-import.ts";
export * from "./project-match.ts";
export * from "./prioritization.ts";
export * from "./outcome-attribution.ts";
export * from "./privacy-audit.ts";
export * from "./usability-study.ts";
export * from "./evaluation.ts";
