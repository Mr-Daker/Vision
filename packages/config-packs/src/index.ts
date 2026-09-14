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
