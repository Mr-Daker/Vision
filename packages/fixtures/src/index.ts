/**
 * @vision/fixtures — reviewed fixture corpus and sealed evaluation holdout (V011).
 *
 * The corpus is data; this module is the only sanctioned way to read it, so the
 * holdout seal cannot be bypassed by accident.
 *
 * **The seal:** `loadHoldoutCorpus()` throws unless `VISION_EVAL_RUN=1` is set.
 * That makes accidental leakage into a prompt, a seed, or a demo rehearsal a
 * loud failure rather than a silent contamination. `tools/check-holdout-seal.mjs`
 * additionally fails CI if any non-evaluation module imports it.
 *
 * Import direction (V006 §9): fixtures import contracts only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS_DIR = join(import.meta.dirname, "corpus");

const readJson = <T>(filename: string): T =>
  JSON.parse(readFileSync(join(CORPUS_DIR, filename), "utf8")) as T;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CorpusSplit = "development" | "holdout";

export type ReviewerDecision =
  | "accepted"
  | "accepted_with_unresolved"
  | "needs_review"
  | "rejected"
  | "undecided_by_design"
  | "confirmed";

export type FixtureMedia = {
  readonly media_type: "photo" | "voice" | "text";
  readonly synthetic_placeholder: boolean;
  readonly object_bytes_present: boolean;
  readonly fingerprint_hash?: string;
  readonly transcript_expected?: string;
};

export type FixtureReport = {
  readonly report_id: string;
  readonly participant_ref: string;
  readonly interface_locale: string;
  readonly source_language: string;
  readonly asset_id: string;
  readonly jurisdiction_internal_code: string;
  readonly observed: {
    readonly lon: number;
    readonly lat: number;
    readonly accuracy_m: number;
    readonly observed_at: string;
  };
  readonly text: string;
  readonly media: readonly FixtureMedia[];
  readonly expected: {
    readonly category_id: string | null;
    readonly defect_id: string | null;
    readonly severity_band: string;
    readonly department_id?: string;
    readonly routing_review_expected?: boolean;
    readonly needs_review_expected?: boolean;
  };
  readonly reviewer: {
    readonly decision: ReviewerDecision;
    readonly reviewed_by: string;
    readonly reviewed_at: string | null;
    readonly notes: string;
  };
  readonly unresolved_labels: readonly string[];
};

export type ReportCorpus = {
  readonly split: CorpusSplit;
  readonly provenance: string;
  readonly notice: string;
  readonly reports: readonly FixtureReport[];
};

export type TaxonomyPack = {
  readonly taxonomy_version: string;
  readonly provenance: string;
  readonly label_definitions: Readonly<Record<string, string>>;
  readonly severity_bands: readonly { readonly id: string; readonly definition: string }[];
  readonly categories: readonly {
    readonly category_id: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly defects: readonly {
      readonly defect_id: string;
      readonly labels: Readonly<Record<string, string>>;
    }[];
  }[];
};

export type JurisdictionFixtures = {
  readonly jurisdiction_profile_id: string;
  readonly directory_version: string;
  readonly level_scheme: string;
  readonly provenance: string;
  readonly nodes: readonly {
    readonly internal_code: string;
    readonly level_code: string;
    readonly parent_internal_code: string | null;
    readonly label: string;
    readonly external_source_code: string | null;
    readonly effective_from: string;
    readonly boundary_multipolygon: readonly number[][][][];
  }[];
};

export type AssetFixtures = {
  readonly provenance: string;
  readonly assets: readonly {
    readonly asset_id: string;
    readonly asset_type: string;
    readonly name: string;
    readonly jurisdiction_internal_code: string;
    readonly lon: number;
    readonly lat: number;
    readonly effective_from: string;
  }[];
};

export type ResponsibilityFixtures = {
  readonly directory_version: string;
  readonly provenance: string;
  readonly departments: readonly {
    readonly department_id: string;
    readonly label: string;
    readonly provider_mode: string;
  }[];
  readonly rules: readonly {
    readonly jurisdiction_internal_code: string;
    readonly category_id: string;
    readonly department_id: string;
  }[];
  readonly deliberate_gaps: readonly {
    readonly jurisdiction_internal_code: string;
    readonly category_id: string;
    readonly reason: string;
  }[];
};

export type RelationFixtures = {
  readonly duplicate_pairs: readonly {
    readonly relation_id: string;
    readonly split: CorpusSplit;
    readonly report_a: string;
    readonly report_b: string;
    readonly expected_match_state: string;
    readonly expected_counted_participants: number;
  }[];
  readonly nearby_distinct: readonly {
    readonly relation_id: string;
    readonly split: CorpusSplit;
    readonly report_a: string;
    readonly report_b: string;
    readonly expected_match_state: string;
  }[];
  readonly recurrence: readonly {
    readonly relation_id: string;
    readonly split: CorpusSplit;
    readonly earlier_report: string;
    readonly later_report: string;
    readonly asset_id: string;
    readonly expected_treatment: string;
    readonly permitted_treatments: readonly string[];
  }[];
};

export type AdversarialFixtures = {
  readonly cases: readonly {
    readonly case_id: string;
    readonly kind: string;
    readonly required_handling: string;
    readonly must_not: readonly string[];
  }[];
};

// ---------------------------------------------------------------------------
// Loaders — development material is freely readable
// ---------------------------------------------------------------------------

export const loadTaxonomy = (): TaxonomyPack => readJson<TaxonomyPack>("taxonomy.v1.json");
export const loadJurisdictions = (): JurisdictionFixtures =>
  readJson<JurisdictionFixtures>("jurisdictions.json");
export const loadAssets = (): AssetFixtures => readJson<AssetFixtures>("assets.json");
export const loadResponsibilityDirectory = (): ResponsibilityFixtures =>
  readJson<ResponsibilityFixtures>("responsibility-directory.json");
export const loadRelations = (): RelationFixtures => readJson<RelationFixtures>("relations.json");
export const loadAdversarialCases = (): AdversarialFixtures =>
  readJson<AdversarialFixtures>("adversarial.json");

export const loadDevelopmentCorpus = (): ReportCorpus =>
  readJson<ReportCorpus>("reports.development.json");

// ---------------------------------------------------------------------------
// The seal
// ---------------------------------------------------------------------------

export class HoldoutSealError extends Error {}

export const HOLDOUT_SEAL_ENV = "VISION_EVAL_RUN";

/**
 * Reads the sealed holdout. Deliberately awkward to call.
 *
 * Holdout rows must never enter a prompt, a few-shot example, a tuning set, a
 * seeded database, or a demo rehearsal — only a scored evaluation run (V046).
 * Requiring an explicit environment flag means a casual import cannot leak the
 * corpus, and the reason string is recorded by the caller so an evaluation run
 * is attributable.
 */
export const loadHoldoutCorpus = (reason: string): ReportCorpus => {
  if (process.env[HOLDOUT_SEAL_ENV] !== "1") {
    throw new HoldoutSealError(
      [
        "the evaluation holdout is sealed.",
        "",
        `Set ${HOLDOUT_SEAL_ENV}=1 only for a scored evaluation run (V046).`,
        "It must never be set for a prompt, a tuning set, a database seed, or a",
        "demo rehearsal — doing so invalidates every held-out measurement.",
      ].join("\n"),
    );
  }
  if (reason.trim().length < 8) {
    throw new HoldoutSealError(
      "a holdout read requires a recorded reason of at least 8 characters",
    );
  }
  return readJson<ReportCorpus>("reports.holdout.json");
};

/**
 * Reads only the holdout's non-content metadata. Safe to call anywhere,
 * because it exposes counts and coverage but no report text, labels, or
 * coordinates — which is what a leakage test needs.
 */
export const holdoutMetadataOnly = (): {
  readonly sealed: boolean;
  readonly report_count: number;
  readonly asset_ids: readonly string[];
  readonly locales: readonly string[];
} => {
  const raw = readJson<ReportCorpus & { sealed: boolean }>("reports.holdout.json");
  return {
    sealed: raw.sealed,
    report_count: raw.reports.length,
    asset_ids: [...new Set(raw.reports.map((report) => report.asset_id))].sort(),
    locales: [...new Set(raw.reports.map((report) => report.source_language))].sort(),
  };
};

// ---------------------------------------------------------------------------
// Coverage and integrity helpers
// ---------------------------------------------------------------------------

export type CoverageReport = {
  readonly total: number;
  readonly by_language: Readonly<Record<string, number>>;
  readonly by_category: Readonly<Record<string, number>>;
  readonly with_unresolved_labels: number;
  readonly pending_native_review: number;
  readonly media_with_bytes: number;
};

export const coverageOf = (corpus: ReportCorpus): CoverageReport => {
  const byLanguage: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let unresolved = 0;
  let pendingReview = 0;
  let mediaWithBytes = 0;

  for (const report of corpus.reports) {
    byLanguage[report.source_language] = (byLanguage[report.source_language] ?? 0) + 1;
    const category = report.expected.category_id ?? "(abstention)";
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    if (report.unresolved_labels.length > 0) unresolved += 1;
    if (report.reviewer.reviewed_by === "pending_native_review") pendingReview += 1;
    mediaWithBytes += report.media.filter((item) => item.object_bytes_present).length;
  }

  return {
    total: corpus.reports.length,
    by_language: byLanguage,
    by_category: byCategory,
    with_unresolved_labels: unresolved,
    pending_native_review: pendingReview,
    media_with_bytes: mediaWithBytes,
  };
};

/** Asset ids shared by both splits. Must always be empty (V011 leakage rule). */
export const assetLeakage = (): readonly string[] => {
  const development = new Set(loadDevelopmentCorpus().reports.map((report) => report.asset_id));
  return holdoutMetadataOnly().asset_ids.filter((assetId) => development.has(assetId));
};
