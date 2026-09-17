/**
 * @vision/config-packs — versioned scope configuration (V001 Appendix G, V006 §10).
 *
 * Scope is data, not code. A jurisdiction profile describes its own hierarchy
 * and level scheme, so adding a district means adding a reviewed pack rather
 * than editing workflow code.
 *
 * The two packs shipped here are deliberately generic and synthetic, and they
 * use different level schemes (a rural-style block hierarchy and an urban-style
 * ward hierarchy) so the portability requirement in Appendix G rule 7 is proved
 * by loading a second pack through the same code path. The locked
 * demonstration pack, its taxonomy and its locale resources are authored by
 * V011/V019, not here.
 *
 * Import direction (V006 §9): config packs import contracts only.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type JurisdictionNode = {
  readonly internal_code: string;
  readonly level_code: string;
  readonly parent_internal_code: string | null;
  readonly label: string;
  readonly external_source_code: string | null;
  readonly effective_from: string;
  /** GeoJSON-shaped MultiPolygon coordinates: polygon -> ring -> point -> [lon, lat]. */
  readonly boundary_multipolygon: readonly (readonly (readonly (readonly [number, number])[])[])[];
};

export type JurisdictionProfile = {
  readonly jurisdiction_profile_id: string;
  readonly provenance:
    "team_created_synthetic" | "permitted_source_data" | "consented_evaluation_data";
  readonly label: string;
  readonly level_scheme: string;
  readonly directory_version: string;
  readonly notice: string;
  readonly nodes: readonly JurisdictionNode[];
};

const PACKS_DIR = join(import.meta.dirname, "packs");

export const listJurisdictionProfileIds = (): readonly string[] =>
  readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

export class ConfigPackError extends Error {}

/**
 * Loads and validates a profile. Validation is strict and fails closed: an
 * unknown parent, a self-referencing node, a cycle, or a missing external
 * source record makes the pack unusable rather than partially applied
 * (V003 Jurisdiction constraints).
 */
export const loadJurisdictionProfile = (profileId: string): JurisdictionProfile => {
  let raw: string;
  try {
    raw = readFileSync(join(PACKS_DIR, profileId, "profile.json"), "utf8");
  } catch {
    throw new ConfigPackError(`unknown jurisdiction profile: ${profileId}`);
  }

  const parsed = JSON.parse(raw) as JurisdictionProfile;

  if (parsed.jurisdiction_profile_id !== profileId) {
    throw new ConfigPackError(
      `pack directory '${profileId}' declares id '${parsed.jurisdiction_profile_id}'`,
    );
  }
  if (parsed.nodes.length === 0) {
    throw new ConfigPackError(`profile ${profileId} declares no nodes`);
  }
  if (
    typeof parsed.notice !== "string" ||
    parsed.notice.trim().length === 0 ||
    (parsed.provenance === "team_created_synthetic" && !/synthetic/i.test(parsed.notice))
  ) {
    throw new ConfigPackError(
      `profile ${profileId} must carry a provenance-appropriate boundary notice`,
    );
  }

  const byCode = new Map(parsed.nodes.map((node) => [node.internal_code, node]));
  if (byCode.size !== parsed.nodes.length) {
    throw new ConfigPackError(`profile ${profileId} has duplicate internal codes`);
  }

  for (const node of parsed.nodes) {
    if (node.parent_internal_code === node.internal_code) {
      throw new ConfigPackError(`node ${node.internal_code} references itself as parent`);
    }
    if (node.parent_internal_code !== null && !byCode.has(node.parent_internal_code)) {
      throw new ConfigPackError(
        `node ${node.internal_code} references unknown parent ${node.parent_internal_code}`,
      );
    }
    // An external identifier may only appear once its reuse is approved, and
    // V004 currently classifies every candidate as reference-only or
    // unavailable — so a pack asserting one is rejected here.
    if (node.external_source_code !== null) {
      throw new ConfigPackError(
        `node ${node.internal_code} declares an external source code, which requires an approved permitted source (V004 §5)`,
      );
    }

    if (!Array.isArray(node.boundary_multipolygon) || node.boundary_multipolygon.length === 0) {
      throw new ConfigPackError(`node ${node.internal_code} declares no boundary polygon`);
    }
    for (const polygon of node.boundary_multipolygon) {
      if (!Array.isArray(polygon) || polygon.length === 0) {
        throw new ConfigPackError(`node ${node.internal_code} contains an empty polygon`);
      }
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 4) {
          throw new ConfigPackError(
            `node ${node.internal_code} contains a boundary ring with fewer than four points`,
          );
        }
        for (const point of ring) {
          if (
            !Array.isArray(point) ||
            point.length !== 2 ||
            !Number.isFinite(point[0]) ||
            !Number.isFinite(point[1]) ||
            point[0] < -180 ||
            point[0] > 180 ||
            point[1] < -90 ||
            point[1] > 90
          ) {
            throw new ConfigPackError(
              `node ${node.internal_code} contains an invalid [longitude, latitude] point`,
            );
          }
        }
        const first = ring[0];
        const last = ring.at(-1);
        if (
          first === undefined ||
          last === undefined ||
          first[0] !== last[0] ||
          first[1] !== last[1]
        ) {
          throw new ConfigPackError(`node ${node.internal_code} contains an open boundary ring`);
        }
      }
    }
  }

  // Cycle check by walking each node to a root.
  for (const node of parsed.nodes) {
    const seen = new Set<string>([node.internal_code]);
    let cursor = node.parent_internal_code;
    let hops = 0;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new ConfigPackError(`profile ${profileId} contains a hierarchy cycle at ${cursor}`);
      }
      seen.add(cursor);
      hops += 1;
      if (hops > 16) {
        throw new ConfigPackError(`profile ${profileId} hierarchy exceeds 16 levels`);
      }
      cursor = byCode.get(cursor)?.parent_internal_code ?? null;
    }
  }

  return parsed;
};

/** Roots are nodes with no parent. A well-formed profile has exactly one. */
export const rootsOf = (profile: JurisdictionProfile): readonly JurisdictionNode[] =>
  profile.nodes.filter((node) => node.parent_internal_code === null);

export const depthOf = (profile: JurisdictionProfile, internalCode: string): number => {
  const byCode = new Map(profile.nodes.map((node) => [node.internal_code, node]));
  let depth = 0;
  let cursor = byCode.get(internalCode)?.parent_internal_code ?? null;
  while (cursor !== null) {
    depth += 1;
    cursor = byCode.get(cursor)?.parent_internal_code ?? null;
  }
  return depth;
};

// ---------------------------------------------------------------------------
// Routing, confirmation and matching packs
//
// Each of these closes a labelled gap: V033 had no seeded directory (so a live
// demo would route everything to `no_directory_entry`), V035's confirmation
// policy had no loader, and V026's retrieval window was "a default with no
// evidence behind that number".
//
// The loaders refuse a pack that would behave worse than no pack. A directory
// naming a *real* department is the clearest case: nothing in this
// demonstration may assert a government relationship, so such a pack is a
// configuration error rather than an upgrade.
// ---------------------------------------------------------------------------

export type RoutingDirectoryEntry = {
  readonly jurisdictionInternalCode: string;
  readonly category: string;
  readonly departmentId: string;
  readonly departmentLabel: string;
  readonly providerMode: "simulated";
};

export type RoutingDirectory = {
  readonly directoryVersion: string;
  readonly entries: readonly RoutingDirectoryEntry[];
};

const readPackFile = (profileId: string, file: string): unknown => {
  let raw: string;
  try {
    raw = readFileSync(join(PACKS_DIR, profileId, file), "utf8");
  } catch {
    throw new ConfigPackError(`profile '${profileId}' has no ${file}`);
  }
  return JSON.parse(raw);
};

export const loadRoutingDirectory = (profileId: string, override?: unknown): RoutingDirectory => {
  const parsed = (override ?? readPackFile(profileId, "routing.json")) as {
    directory_version?: unknown;
    entries?: unknown;
  };
  const version = parsed.directory_version;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new ConfigPackError("a routing directory must declare a directory_version");
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new ConfigPackError(`routing directory '${version}' declares no entries`);
  }

  const entries: RoutingDirectoryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.entries) {
    const entry = raw as Record<string, unknown>;
    const category = entry["category"];
    const jurisdictionInternalCode = entry["jurisdiction_internal_code"];
    const departmentId = entry["department_id"];
    const departmentLabel = entry["department_label"];
    const providerMode = entry["provider_mode"];
    if (
      typeof jurisdictionInternalCode !== "string" ||
      jurisdictionInternalCode.trim().length === 0 ||
      typeof category !== "string" ||
      typeof departmentId !== "string"
    ) {
      throw new ConfigPackError(
        "a routing entry needs a jurisdiction_internal_code, category and department_id",
      );
    }
    if (typeof departmentLabel !== "string" || departmentLabel.trim().length === 0) {
      throw new ConfigPackError(`routing entry '${category}' needs a department_label`);
    }
    // The hard one. A pack cannot introduce a real recipient: that requires
    // approved onboarding (V058) and a relationship nobody has established.
    if (providerMode !== "simulated") {
      throw new ConfigPackError(
        `routing entry '${category}' declares provider_mode '${String(providerMode)}'; only 'simulated' may be configured, because a real recipient requires V058 approval`,
      );
    }
    if (!/simulated/i.test(departmentLabel)) {
      throw new ConfigPackError(
        `routing entry '${category}' has a label that does not say it is simulated; every surface showing it must (V010)`,
      );
    }
    const ownershipKey = `${jurisdictionInternalCode}\u0000${category}`;
    if (seen.has(ownershipKey)) {
      throw new ConfigPackError(
        `routing directory '${version}' lists category '${category}' twice in jurisdiction '${jurisdictionInternalCode}'; contested ownership is a review item, not a configuration choice`,
      );
    }
    seen.add(ownershipKey);
    entries.push({
      jurisdictionInternalCode,
      category,
      departmentId,
      departmentLabel,
      providerMode: "simulated",
    });
  }

  return { directoryVersion: version, entries };
};

export type ConfirmationRulePack = {
  readonly requiredConfirmations: number;
  readonly citizenMayConfirm: boolean;
  readonly reviewerMayOverride: boolean;
  readonly requiresQualifiedInspection?: boolean;
};

export type ConfirmationPolicy = {
  readonly version: string;
  readonly rules: Readonly<Record<string, ConfirmationRulePack>>;
};

export const loadConfirmationPolicy = (
  profileId: string,
  override?: unknown,
): ConfirmationPolicy => {
  const parsed = (override ?? readPackFile(profileId, "confirmation.json")) as {
    version?: unknown;
    rules?: unknown;
  };
  if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
    throw new ConfigPackError("a confirmation policy must declare a version");
  }
  if (typeof parsed.rules !== "object" || parsed.rules === null) {
    throw new ConfigPackError(`confirmation policy '${parsed.version}' declares no rules`);
  }

  const rules: Record<string, ConfirmationRulePack> = {};
  for (const [category, raw] of Object.entries(parsed.rules as Record<string, unknown>)) {
    const rule = raw as Record<string, unknown>;
    const required = rule["required_confirmations"];
    if (typeof required !== "number" || !Number.isInteger(required) || required < 1) {
      // Zero would mean a staff claim closes an issue with nobody agreeing,
      // which is exactly what V035 exists to prevent.
      throw new ConfigPackError(
        `category '${category}' must require at least one confirmation; zero would close an issue on a claim alone`,
      );
    }
    rules[category] = {
      requiredConfirmations: required,
      citizenMayConfirm: rule["citizen_may_confirm"] !== false,
      reviewerMayOverride: rule["reviewer_may_override"] === true,
      ...(rule["requires_qualified_inspection"] === true
        ? { requiresQualifiedInspection: true }
        : {}),
    };
  }

  return { version: parsed.version, rules };
};

export type MatchingBounds = {
  readonly version: string;
  readonly baseRadiusMetres: number;
  readonly unknownAccuracyAllowanceMetres: number;
  readonly timeWindowHours: number;
  readonly candidateLimit: number;
  /** Carries the "not calibrated" caveat so a reader of the configuration sees it. */
  readonly note: string;
};

export const loadMatchingBounds = (profileId: string, override?: unknown): MatchingBounds => {
  const parsed = (override ?? readPackFile(profileId, "matching.json")) as Record<string, unknown>;
  const positiveInteger = (name: string): number => {
    const value = parsed[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      // Refused rather than clamped: a clamped bound is a different search
      // from the one the configuration asked for, with nothing recording the
      // substitution.
      throw new ConfigPackError(`matching bound '${name}' must be a positive number`);
    }
    return value;
  };
  if (typeof parsed["version"] !== "string" || parsed["version"].trim().length === 0) {
    throw new ConfigPackError("matching bounds must declare a version");
  }
  const note = parsed["note"];
  if (typeof note !== "string" || note.trim().length === 0) {
    throw new ConfigPackError("matching bounds must carry a note saying what they are based on");
  }

  return {
    version: parsed["version"],
    baseRadiusMetres: positiveInteger("base_radius_metres"),
    unknownAccuracyAllowanceMetres: positiveInteger("unknown_accuracy_allowance_metres"),
    timeWindowHours: positiveInteger("time_window_hours"),
    candidateLimit: positiveInteger("candidate_limit"),
    note,
  };
};

export type TaxonomyCategory = {
  readonly id: string;
  readonly label: string;
};

export type Taxonomy = {
  readonly version: string;
  readonly categories: readonly TaxonomyCategory[];
  readonly categoryIds: readonly string[];
  readonly defectIds: readonly string[];
  /** What the list is and is not, carried so a reader of the pack sees it. */
  readonly note: string;
  /** The language the labels are written in. Not assumed to be the reader's. */
  readonly labelLanguage: string;
  /** That the labels are untranslated, so an interface can say so. */
  readonly labelNote: string;
};

/**
 * Loads the permitted classification identifiers (roadmap V023).
 *
 * V023 recorded that the taxonomy reached the classifier only from test
 * fixtures, so a deployment had none — and a classifier with no permitted
 * identifiers rejects every reply it gets. This is that pack.
 *
 * Note what is deliberately *not* loadable: the system instruction sent to the
 * model stays fixed text in `@vision/adapters`. Making the instruction data
 * would give a pack a way to tell the model what to do, which is the same
 * injection route the adapter keeps citizen text away from. The identifiers
 * are data; the instruction is code.
 */
export const loadTaxonomy = (profileId: string, override?: unknown): Taxonomy => {
  const parsed = (override ?? readPackFile(profileId, "taxonomy.json")) as Record<string, unknown>;

  if (typeof parsed["version"] !== "string" || parsed["version"].trim().length === 0) {
    // Recorded on every stored proposal. Without it a proposal cannot be
    // interpreted later, because nothing says which list it chose from.
    throw new ConfigPackError("a taxonomy must declare a version");
  }
  const note = parsed["note"];
  if (typeof note !== "string" || note.trim().length === 0) {
    throw new ConfigPackError("a taxonomy must carry a note saying what the list is");
  }

  const labelLanguage = parsed["label_language"];
  if (typeof labelLanguage !== "string" || labelLanguage.trim().length === 0) {
    // Required, not defaulted. A label whose language is unstated will be
    // rendered as though it were in the reader's, and a Marathi reader would
    // then be shown English with nothing saying so.
    throw new ConfigPackError("a taxonomy must state the language its labels are written in");
  }
  const labelNote = parsed["label_note"];
  if (typeof labelNote !== "string" || labelNote.trim().length === 0) {
    throw new ConfigPackError(
      "a taxonomy must carry a label_note saying whether the labels are translated",
    );
  }

  const identifiers = (field: string): readonly string[] => {
    const value = parsed[field];
    if (!Array.isArray(value) || value.length === 0) {
      // An empty list makes "choose only from the permitted identifiers"
      // unsatisfiable, so every reply is rejected as an unknown category — an
      // outage that reads like a model fault.
      throw new ConfigPackError(`a taxonomy must list at least one ${field} entry`);
    }
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new ConfigPackError(`every ${field} entry must be a non-empty string`);
      }
      if (seen.has(entry)) {
        throw new ConfigPackError(`${field} lists '${entry}' twice`);
      }
      seen.add(entry);
    }
    return value as readonly string[];
  };

  const rawCategories = parsed["categories"];
  if (!Array.isArray(rawCategories) || rawCategories.length === 0) {
    throw new ConfigPackError("a taxonomy must list at least one category");
  }
  const seenIds = new Set<string>();
  const categories = rawCategories.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ConfigPackError("every taxonomy category must be an object");
    }
    const id = (entry as Record<string, unknown>)["id"];
    const label = (entry as Record<string, unknown>)["label"];
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new ConfigPackError("every taxonomy category must have a non-empty id");
    }
    if (typeof label !== "string" || label.trim().length === 0) {
      // Refused rather than falling back to the identifier. A raw identifier
      // like `water_supply` shown to a citizen is a leaked internal name, not
      // a label somebody wrote for them to read.
      throw new ConfigPackError(`taxonomy category '${id}' has no label`);
    }
    if (seenIds.has(id)) {
      throw new ConfigPackError(`category_ids lists '${id}' twice`);
    }
    seenIds.add(id);
    return { id, label };
  });

  return {
    version: parsed["version"],
    categories,
    categoryIds: categories.map((category) => category.id),
    defectIds: identifiers("defect_ids"),
    note,
    labelLanguage,
    labelNote,
  };
};

export type TriagePolicyPack = {
  readonly version: string;
  readonly note: string;
  readonly categoryOrder: readonly string[];
  readonly ageEscalationDays: number;
};

/**
 * Loads the triage ordering policy (roadmap V034).
 *
 * V034 declined to invent urgency. This is not urgency: it is the order a
 * deployment chose, as data, so the choice is visible and attributable rather
 * than compiled in.
 *
 * The note is checked for an explicit disclaimer, not merely for being
 * present. A note reading "the order to work in" would let a severity-looking
 * field reach staff with nothing saying it is not a severity — which is the
 * exact failure V034 refused.
 */
export const loadTriagePolicy = (profileId: string, override?: unknown): TriagePolicyPack => {
  const parsed = (override ?? readPackFile(profileId, "triage.json")) as Record<string, unknown>;

  if (typeof parsed["version"] !== "string" || parsed["version"].trim().length === 0) {
    throw new ConfigPackError("a triage policy must declare a version");
  }
  const note = parsed["note"];
  if (typeof note !== "string" || !/not a severity, risk or urgency/i.test(note)) {
    throw new ConfigPackError(
      "a triage policy's note must say explicitly that it is not a severity, risk or urgency assessment",
    );
  }
  const order = parsed["category_order"];
  if (!Array.isArray(order) || order.length === 0) {
    throw new ConfigPackError("a triage policy must order at least one category");
  }
  const seen = new Set<string>();
  for (const category of order) {
    if (typeof category !== "string" || category.trim().length === 0) {
      throw new ConfigPackError("every ordered category must be a non-empty string");
    }
    if (seen.has(category)) {
      throw new ConfigPackError(`the triage order lists '${category}' twice`);
    }
    seen.add(category);
  }
  const days = parsed["age_escalation_days"];
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
    // Refused rather than defaulted to infinity: without a threshold the
    // lowest-ordered category is never reached, and nothing would record that
    // reports in it are waiting indefinitely.
    throw new ConfigPackError(
      "a triage policy must set a positive age_escalation_days, or a low-ordered category is never reached",
    );
  }

  return {
    version: parsed["version"],
    note,
    categoryOrder: order as readonly string[],
    ageEscalationDays: days,
  };
};

export type AgeingRulePack = {
  readonly alertAfterDays: number;
  readonly escalateAfterDays: number;
};

export type AgeingPolicy = {
  readonly version: string;
  readonly note: string;
  readonly rules: Readonly<Record<string, AgeingRulePack>>;
  readonly fallback: AgeingRulePack;
};

/**
 * Loads the ageing and escalation thresholds (roadmap V036).
 *
 * The note is checked for an explicit disclaimer rather than merely for being
 * present, exactly as `loadTriagePolicy` does. A pack whose note reads "how
 * quickly each category must be fixed" would let a severity-looking promise
 * reach a supervisor's screen with nothing saying the system cannot measure
 * how dangerous anything is — which is the failure V034 refused and this
 * deliverable inherits.
 *
 * The fallback is required, not defaulted. A deployment that has not decided
 * how long an unlisted category may wait must say so by writing a number down;
 * inventing one here would hold a department to a deadline nobody agreed.
 */
export const loadAgeingPolicy = (profileId: string, override?: unknown): AgeingPolicy => {
  const parsed = (override ?? readPackFile(profileId, "ageing.json")) as Record<string, unknown>;

  if (typeof parsed["version"] !== "string" || parsed["version"].trim().length === 0) {
    throw new ConfigPackError("an ageing policy must declare a version");
  }
  const note = parsed["note"];
  if (typeof note !== "string" || !/not a severity, risk or urgency/i.test(note)) {
    throw new ConfigPackError(
      "an ageing policy's note must say explicitly that it is not a severity, risk or urgency assessment",
    );
  }

  const rule = (raw: unknown, label: string): AgeingRulePack => {
    const value = (raw ?? {}) as Record<string, unknown>;
    const alertAfterDays = value["alert_after_days"];
    const escalateAfterDays = value["escalate_after_days"];
    for (const [name, candidate] of [
      ["alert_after_days", alertAfterDays],
      ["escalate_after_days", escalateAfterDays],
    ] as const) {
      if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
        throw new ConfigPackError(`${label} must set a positive ${name}`);
      }
    }
    if ((escalateAfterDays as number) <= (alertAfterDays as number)) {
      // Otherwise the overdue and escalated queues hold the same rows, which
      // tells a supervisor nothing and hides the second stage entirely.
      throw new ConfigPackError(`${label} must escalate later than it alerts`);
    }
    return {
      alertAfterDays: alertAfterDays as number,
      escalateAfterDays: escalateAfterDays as number,
    };
  };

  const rawRules = parsed["rules"];
  if (typeof rawRules !== "object" || rawRules === null) {
    throw new ConfigPackError(`ageing policy '${parsed["version"]}' declares no rules`);
  }
  const rules: Record<string, AgeingRulePack> = {};
  for (const [category, raw] of Object.entries(rawRules as Record<string, unknown>)) {
    rules[category] = rule(raw, `ageing category '${category}'`);
  }

  if (parsed["fallback"] === undefined) {
    throw new ConfigPackError(
      "an ageing policy must declare a fallback for categories it does not list, so an unconfigured category is not held to a guessed deadline",
    );
  }

  return {
    version: parsed["version"],
    note,
    rules,
    fallback: rule(parsed["fallback"], "the ageing fallback"),
  };
};

// ---------------------------------------------------------------------------
// Contextual data (V040)
// ---------------------------------------------------------------------------

export type ContextSourcePack = {
  readonly sourceRecordId: string;
  readonly sourceName: string;
  readonly sourceUrlOrLocation: string;
  readonly retrievedAt: string;
  readonly sourceEffectiveAt?: string;
  readonly licenceOrPermissionStatus: string;
  readonly demoStatus: string;
};

export type ContextRowPack = {
  readonly subjectKind: "jurisdiction" | "asset";
  readonly subjectId: string;
  readonly value: unknown;
  readonly unit: string;
  readonly vintage: string;
  readonly note?: string;
};

export type ContextDatasetPack = {
  readonly datasetId: string;
  readonly kind: string;
  readonly unit: string;
  readonly label: string;
  readonly maxAgeDays: number;
  readonly rows: readonly ContextRowPack[];
};

export type ContextPack = {
  readonly version: string;
  /** What this data is and is not. Travels with every value loaded from it. */
  readonly notice: string;
  readonly source: ContextSourcePack;
  readonly datasets: readonly ContextDatasetPack[];
};

/**
 * Loads the district's contextual datasets (V040).
 *
 * The notice is validated rather than merely read. V004's downgrade rule means
 * every context figure in this demonstration is team-created synthetic, and a
 * pack that does not say so in its own words would let a screen inherit a
 * claim nobody made. The licence is checked for the same reason: this loader
 * refuses to hand over a pack whose source is reference-only or unavailable,
 * so a mislabelled pack fails at load rather than at display.
 */
export const loadContextPack = (profileId: string, override?: unknown): ContextPack => {
  const parsed = (override ?? readPackFile(profileId, "context.json")) as Record<string, unknown>;

  if (typeof parsed["version"] !== "string" || parsed["version"].trim().length === 0) {
    throw new ConfigPackError("a context pack must declare a version");
  }
  const notice = parsed["notice"];
  if (typeof notice !== "string" || !/synthetic/i.test(notice)) {
    throw new ConfigPackError(
      "a context pack's notice must say in its own words that the figures are synthetic, because every screen showing one inherits that claim",
    );
  }

  const rawSource = parsed["source"];
  if (typeof rawSource !== "object" || rawSource === null) {
    throw new ConfigPackError("a context pack must declare the source its figures came from");
  }
  const sourceFields = rawSource as Record<string, unknown>;
  const text = (key: string): string => {
    const value = sourceFields[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ConfigPackError(`a context pack source must declare ${key}`);
    }
    return value;
  };
  const licence = text("licence_or_permission_status");
  if (!["permitted", "synthetic", "consented"].includes(licence)) {
    throw new ConfigPackError(
      `a context pack source licensed '${licence}' may not be ingested; only permitted, synthetic or consented data may be loaded (V004 §5)`,
    );
  }
  const effectiveAt = sourceFields["source_effective_at"];
  const source: ContextSourcePack = {
    sourceRecordId: text("source_record_id"),
    sourceName: text("source_name"),
    sourceUrlOrLocation: text("source_url_or_location"),
    retrievedAt: text("retrieved_at"),
    ...(typeof effectiveAt === "string" ? { sourceEffectiveAt: effectiveAt } : {}),
    licenceOrPermissionStatus: licence,
    demoStatus: text("demo_status"),
  };

  const rawDatasets = parsed["datasets"];
  if (!Array.isArray(rawDatasets) || rawDatasets.length === 0) {
    throw new ConfigPackError("a context pack must declare at least one dataset");
  }

  const datasets = rawDatasets.map((entry, index) => {
    const dataset = (entry ?? {}) as Record<string, unknown>;
    const field = (key: string): string => {
      const value = dataset[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new ConfigPackError(`context dataset ${String(index)} must declare ${key}`);
      }
      return value;
    };
    const maxAgeDays = dataset["max_age_days"];
    if (typeof maxAgeDays !== "number" || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      throw new ConfigPackError(
        `context dataset '${field("dataset_id")}' must declare a positive max_age_days, so a reader can be told when a figure is stale`,
      );
    }
    const rawRows = dataset["rows"];
    if (!Array.isArray(rawRows)) {
      throw new ConfigPackError(`context dataset '${field("dataset_id")}' declares no rows`);
    }
    const rows: ContextRowPack[] = rawRows.map((rawRow, rowIndex): ContextRowPack => {
      const values = (rawRow ?? {}) as Record<string, unknown>;
      const subjectKind = values["subject_kind"];
      if (subjectKind !== "jurisdiction" && subjectKind !== "asset") {
        throw new ConfigPackError(
          `row ${String(rowIndex)} of '${field("dataset_id")}' must describe a jurisdiction or an asset`,
        );
      }
      const note = values["note"];
      return {
        subjectKind,
        subjectId: String(values["subject_id"] ?? ""),
        value: values["value"],
        unit: String(values["unit"] ?? ""),
        vintage: String(values["vintage"] ?? ""),
        ...(typeof note === "string" ? { note } : {}),
      };
    });
    return {
      datasetId: field("dataset_id"),
      kind: field("kind"),
      unit: field("unit"),
      label: field("label"),
      maxAgeDays,
      rows,
    };
  });

  return { version: parsed["version"], notice, source, datasets };
};

// ---------------------------------------------------------------------------
// Sanctioned projects (V041)
// ---------------------------------------------------------------------------

export type SanctionedProjectPack = {
  readonly projectId: string;
  readonly projectName: string;
  readonly scopeDescription: string;
  readonly scopeTerms: readonly string[];
  readonly assetId: string | null;
  readonly jurisdictionInternalCode: string;
  readonly longitude: number | null;
  readonly latitude: number | null;
  readonly sanctionedAt: string;
  readonly completedAt: string | null;
  readonly amount: number | null;
  readonly amountUnit: string | null;
};

export type ProjectRegisterPack = {
  readonly version: string;
  readonly notice: string;
  readonly source: ContextSourcePack;
  readonly projects: readonly SanctionedProjectPack[];
};

/**
 * Loads the district's sanctioned-project register (V041).
 *
 * The same licence gate as the context pack, for a sharper reason. Whether
 * public infrastructure has been paid for is the most politically loaded thing
 * this system could appear to say; a register whose provenance is not one of
 * permitted, synthetic or consented must not be loadable at all, and its
 * notice has to say what it is before any project in it reaches a screen.
 */
export const loadProjectRegister = (profileId: string, override?: unknown): ProjectRegisterPack => {
  const parsed = (override ?? readPackFile(profileId, "projects.json")) as Record<string, unknown>;

  if (typeof parsed["version"] !== "string" || parsed["version"].trim().length === 0) {
    throw new ConfigPackError("a project register must declare a version");
  }
  const notice = parsed["notice"];
  if (typeof notice !== "string" || !/synthetic/i.test(notice)) {
    throw new ConfigPackError(
      "a project register's notice must say in its own words that the projects are synthetic, because a funding claim inherits it",
    );
  }

  const rawSource = parsed["source"];
  if (typeof rawSource !== "object" || rawSource === null) {
    throw new ConfigPackError("a project register must declare the source its projects came from");
  }
  const sourceFields = rawSource as Record<string, unknown>;
  const text = (key: string): string => {
    const value = sourceFields[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ConfigPackError(`a project register source must declare ${key}`);
    }
    return value;
  };
  const licence = text("licence_or_permission_status");
  if (!["permitted", "synthetic", "consented"].includes(licence)) {
    throw new ConfigPackError(
      `a project register licensed '${licence}' may not be ingested; only permitted, synthetic or consented data may be loaded (V004 §5)`,
    );
  }
  const effectiveAt = sourceFields["source_effective_at"];
  const source: ContextSourcePack = {
    sourceRecordId: text("source_record_id"),
    sourceName: text("source_name"),
    sourceUrlOrLocation: text("source_url_or_location"),
    retrievedAt: text("retrieved_at"),
    ...(typeof effectiveAt === "string" ? { sourceEffectiveAt: effectiveAt } : {}),
    licenceOrPermissionStatus: licence,
    demoStatus: text("demo_status"),
  };

  const rawProjects = parsed["projects"];
  if (!Array.isArray(rawProjects) || rawProjects.length === 0) {
    throw new ConfigPackError("a project register must declare at least one project");
  }

  const projects: SanctionedProjectPack[] = rawProjects.map(
    (entry, index): SanctionedProjectPack => {
      const project = (entry ?? {}) as Record<string, unknown>;
      const field = (key: string): string => {
        const value = project[key];
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new ConfigPackError(`project ${String(index)} must declare ${key}`);
        }
        return value;
      };
      const number = (key: string): number | null => {
        const value = project[key];
        if (value === null || value === undefined) return null;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new ConfigPackError(`project '${field("project_id")}' has an unreadable ${key}`);
        }
        return value;
      };
      const terms = project["scope_terms"];
      if (!Array.isArray(terms) || terms.length === 0) {
        throw new ConfigPackError(
          `project '${field("project_id")}' must declare scope terms; without them it can only ever be matched on where it is, which is never enough`,
        );
      }
      const amount = number("amount");
      const amountUnit = project["amount_unit"];
      if ((amount === null) !== (amountUnit === null || amountUnit === undefined)) {
        throw new ConfigPackError(
          `project '${field("project_id")}' must declare an amount and its unit together, or neither`,
        );
      }
      const assetId = project["asset_id"];
      const completedAt = project["completed_at"];
      return {
        projectId: field("project_id"),
        projectName: field("project_name"),
        scopeDescription: field("scope_description"),
        scopeTerms: terms.map((term) => String(term)),
        assetId: typeof assetId === "string" && assetId.length > 0 ? assetId : null,
        jurisdictionInternalCode: field("jurisdiction_internal_code"),
        longitude: number("longitude"),
        latitude: number("latitude"),
        sanctionedAt: field("sanctioned_at"),
        completedAt: typeof completedAt === "string" ? completedAt : null,
        amount,
        amountUnit: typeof amountUnit === "string" ? amountUnit : null,
      };
    },
  );

  return { version: parsed["version"], notice, source, projects };
};

// ---------------------------------------------------------------------------
// Prioritization policy (V042)
// ---------------------------------------------------------------------------

export type PriorityWeightingPack = {
  readonly id: string;
  readonly label: string;
  readonly rationale: string;
  readonly weights: Readonly<Record<string, number>>;
};

export type PrioritizationPack = {
  readonly version: string;
  readonly note: string;
  readonly budgetAssumption: string;
  readonly minimumFactorsForRanking: number;
  readonly existingProjectDirection: "prioritise" | "deprioritise";
  readonly existingProjectRationale: string;
  readonly references: {
    readonly persistenceReferenceDays: number;
    readonly persistencePerReopening: number;
    readonly populationReferenceCount: number;
    readonly equityReferenceRatePer1000: number;
    readonly alternativesReferenceCount: number;
  };
  readonly weightings: readonly PriorityWeightingPack[];
};

/**
 * Loads the recommendation policy (V042).
 *
 * Refuses a pack with fewer than two weightings. One weighting produces a
 * ranking that reads as a finding; the interval between several is what the
 * evidence supports, and a pack that cannot express an interval would make the
 * sensitivity analysis a formality.
 *
 * Also refuses a pack that does not state its budget assumption, because this
 * ordering knows nothing about cost and every reader will assume otherwise
 * unless told.
 */
export const loadPrioritizationPolicy = (
  profileId: string,
  override?: unknown,
): PrioritizationPack => {
  const parsed = (override ?? readPackFile(profileId, "prioritization.json")) as Record<
    string,
    unknown
  >;

  const text = (key: string, test?: RegExp): string => {
    const value = parsed[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ConfigPackError(`a prioritization policy must declare ${key}`);
    }
    if (test !== undefined && !test.test(value)) {
      throw new ConfigPackError(`a prioritization policy's ${key} must say what it does not know`);
    }
    return value;
  };

  const version = text("version");
  const note = text("note", /not a (finding|measure|statement)/i);
  // Stated in the pack's own words: a reader who is not told will assume the
  // ordering knows what these things cost.
  const budgetAssumption = text("budget_assumption", /no budget|no cost/i);
  const existingProjectDirection = text("existing_project_direction");
  if (existingProjectDirection !== "prioritise" && existingProjectDirection !== "deprioritise") {
    throw new ConfigPackError(
      "existing_project_direction must be 'prioritise' or 'deprioritise'; both readings are defensible, so the pack has to choose one explicitly",
    );
  }
  const existingProjectRationale = text("existing_project_rationale");

  const minimum = parsed["minimum_factors_for_ranking"];
  if (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 1) {
    throw new ConfigPackError(
      "a prioritization policy must declare a positive minimum_factors_for_ranking, below which a candidate is reported rather than ranked",
    );
  }

  const rawReferences = parsed["references"];
  if (typeof rawReferences !== "object" || rawReferences === null) {
    throw new ConfigPackError("a prioritization policy must declare its reference points");
  }
  const referenceFields = rawReferences as Record<string, unknown>;
  const reference = (key: string): number => {
    const value = referenceFields[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ConfigPackError(`reference point '${key}' must be a positive number`);
    }
    return value;
  };

  const rawWeightings = parsed["weightings"];
  if (!Array.isArray(rawWeightings) || rawWeightings.length < 2) {
    throw new ConfigPackError(
      "a prioritization policy must declare at least two plausible weightings; one produces a ranking that looks like a finding",
    );
  }

  const weightings: PriorityWeightingPack[] = rawWeightings.map(
    (entry, index): PriorityWeightingPack => {
      const weighting = (entry ?? {}) as Record<string, unknown>;
      const field = (key: string): string => {
        const value = weighting[key];
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new ConfigPackError(`weighting ${String(index)} must declare ${key}`);
        }
        return value;
      };
      const rawWeights = weighting["weights"];
      if (typeof rawWeights !== "object" || rawWeights === null) {
        throw new ConfigPackError(`weighting '${field("id")}' declares no weights`);
      }
      const weights: Record<string, number> = {};
      for (const [factor, value] of Object.entries(rawWeights as Record<string, unknown>)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new ConfigPackError(
            `weighting '${field("id")}' has an unreadable weight for ${factor}`,
          );
        }
        weights[factor] = value;
      }
      const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
      if (Math.abs(total - 1) > 0.001) {
        // Weights that do not sum to one make two weightings incomparable, and
        // comparing them is the entire point of having several.
        throw new ConfigPackError(
          `weighting '${field("id")}' sums to ${String(Math.round(total * 1000) / 1000)}; weightings must sum to 1 or the intervals between them mean nothing`,
        );
      }
      return {
        id: field("id"),
        label: field("label"),
        rationale: field("rationale"),
        weights,
      };
    },
  );

  const ids = new Set(weightings.map((weighting) => weighting.id));
  if (ids.size !== weightings.length) {
    throw new ConfigPackError("weighting ids must be distinct");
  }

  return {
    version,
    note,
    budgetAssumption,
    minimumFactorsForRanking: minimum,
    existingProjectDirection,
    existingProjectRationale,
    references: {
      persistenceReferenceDays: reference("persistence_reference_days"),
      persistencePerReopening: reference("persistence_per_reopening"),
      populationReferenceCount: reference("population_reference_count"),
      equityReferenceRatePer1000: reference("equity_reference_rate_per_1000"),
      alternativesReferenceCount: reference("alternatives_reference_count"),
    },
    weightings,
  };
};
