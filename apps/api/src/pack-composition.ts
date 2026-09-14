/**
 * Composition point between the configuration packs and the code that uses
 * them (roadmap V023, V026, V033, V035).
 *
 * V035 recorded that "the confirmation policy pack has no loader". The loader
 * now exists in `@vision/config-packs`, but adapters may not import that
 * package (`tools/check-import-direction.mjs`), so something in the app has to
 * join the two. This file is that join, and it is deliberately the *only*
 * place a policy is produced: `resolveConfirmationPolicy` is what the
 * resolution path is given, so a deployment cannot end up applying a policy
 * that nothing loaded.
 *
 * It does not decide anything itself. The rules are data in the pack, the
 * decision is `evaluateConfirmation` in the domain, and this only carries one
 * to the other — including the pack's own caveat, so a reader of a resolution
 * sees what the numbers are based on.
 */

import {
  loadConfirmationPolicy,
  loadMatchingBounds,
  loadTaxonomy,
  loadTriagePolicy,
  ConfigPackError,
} from "@vision/config-packs";
import type { ConfirmationPolicyPack } from "@vision/domain";

export type ResolvedPolicy = {
  readonly policy: ConfirmationPolicyPack;
  /** Where the policy came from, for recording alongside a decision. */
  readonly source: string;
};

/**
 * Loads the confirmation policy for a jurisdiction profile.
 *
 * A missing or malformed pack is an error, not a fallback: a deployment
 * silently applying a built-in default would be applying a bar nobody
 * configured, and V035's whole point is that the bar is a stated choice.
 */
export const resolveConfirmationPolicy = (
  profileId: string,
  /** An already-parsed pack, for tests and for a deployment that supplies one out of band. */
  override?: unknown,
): ResolvedPolicy => {
  const loaded = loadConfirmationPolicy(profileId, override);
  return {
    policy: { version: loaded.version, rules: loaded.rules },
    source: `config pack '${profileId}' confirmation.json (${loaded.version})`,
  };
};

export type ResolvedBounds = {
  readonly version: string;
  readonly baseRadiusMetres: number;
  readonly timeWindowHours: number;
  readonly note: string;
  readonly unknownAccuracyAllowanceMetres: number;
  readonly candidateLimit: number;
};

/**
 * Loads the retrieval bounds the matching stage searches (V026).
 *
 * Same reasoning: `runMatchingStage` requires bounds rather than defaulting,
 * and this is where the configured ones come from.
 */
export const resolveMatchingBounds = (profileId: string, override?: unknown): ResolvedBounds => {
  const loaded = loadMatchingBounds(profileId, override);
  return {
    version: loaded.version,
    baseRadiusMetres: loaded.baseRadiusMetres,
    timeWindowHours: loaded.timeWindowHours,
    note: loaded.note,
    unknownAccuracyAllowanceMetres: loaded.unknownAccuracyAllowanceMetres,
    candidateLimit: loaded.candidateLimit,
  };
};

export type ResolvedTaxonomy = {
  readonly version: string;
  readonly categories: readonly { readonly id: string; readonly label: string }[];
  readonly categoryIds: readonly string[];
  readonly defectIds: readonly string[];
  readonly note: string;
  readonly labelLanguage: string;
  readonly labelNote: string;
};

/**
 * Loads the permitted classification identifiers (V023).
 *
 * The classifier may only propose identifiers on this list, so what the system
 * will classify at all is a pack decision. The instruction sent to the model
 * is *not* loaded here and stays fixed text in the adapter: identifiers are
 * data, instructions are code.
 */
export const resolveTaxonomy = (profileId: string, override?: unknown): ResolvedTaxonomy => {
  const loaded = loadTaxonomy(profileId, override);
  return {
    version: loaded.version,
    categories: loaded.categories,
    categoryIds: loaded.categoryIds,
    defectIds: loaded.defectIds,
    note: loaded.note,
    labelLanguage: loaded.labelLanguage,
    labelNote: loaded.labelNote,
  };
};

export type ResolvedTriagePolicy = {
  readonly version: string;
  readonly note: string;
  readonly categoryOrder: readonly string[];
  readonly ageEscalationDays: number;
};

/**
 * Loads the order this deployment chose to work reports in (V034).
 *
 * Not urgency. V034 declined to invent urgency and that still stands: this
 * records a decision a person made about which categories to look at first,
 * and the note it carries says as much to anyone reading the inbox.
 */
export const resolveTriagePolicy = (
  profileId: string,
  override?: unknown,
): ResolvedTriagePolicy => {
  const loaded = loadTriagePolicy(profileId, override);
  return {
    version: loaded.version,
    note: loaded.note,
    categoryOrder: loaded.categoryOrder,
    ageEscalationDays: loaded.ageEscalationDays,
  };
};

export { ConfigPackError };
