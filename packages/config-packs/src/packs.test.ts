/**
 * Routing, confirmation and matching packs (closes labelled gaps in V026,
 * V033 and V035).
 *
 * Each of those records said the same thing in different words: a value the
 * system depends on lived in code with nothing behind it. V033 had no seeded
 * directory, so a live demo would route everything to `no_directory_entry`.
 * V035's confirmation policy had no loader. V026's 90-day window was "a
 * default with no evidence behind that number".
 *
 * These packs are data, and the loaders refuse a pack that would quietly
 * behave worse than no pack at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadRoutingDirectory,
  loadJurisdictionProfile,
  loadConfirmationPolicy,
  loadTaxonomy,
  loadTriagePolicy,
  loadMatchingBounds,
  loadContextPack,
  loadProjectRegister,
  loadPrioritizationPolicy,
  ConfigPackError,
} from "./index.ts";

const PROFILE = "demo-district-a";

test("PACK: the routing directory loads and every department is labelled simulated", () => {
  const directory = loadRoutingDirectory(PROFILE);

  assert.equal(directory.directoryVersion, "demo-routing.v1");
  assert.ok(directory.entries.length >= 4);
  for (const entry of directory.entries) {
    // V010's rule: a simulated recipient must say so wherever it appears, and
    // the label is what a staff member and a citizen actually read.
    assert.equal(entry.providerMode, "simulated");
    assert.match(entry.departmentLabel, /simulated/i);
  }
});

test("PACK: the directory declares no duplicate owner per jurisdiction and category", () => {
  const directory = loadRoutingDirectory(PROFILE);

  const keys = directory.entries.map(
    (entry) => `${entry.jurisdictionInternalCode}/${entry.category}`,
  );
  assert.equal(new Set(keys).size, keys.length);
});

test("PACK: a pack claiming a real department is refused", () => {
  // Nothing in this demonstration may assert a real government relationship,
  // so a pack that declares one is a configuration error rather than an
  // upgrade (V004 §5). The label here *does* say simulated, so this isolates
  // the provider_mode check rather than tripping two at once.
  assert.throws(
    () =>
      loadRoutingDirectory(PROFILE, {
        directory_version: "x",
        entries: [
          {
            jurisdiction_internal_code: "DDA-B1",
            category: "sanitation",
            department_id: "real-municipal-corporation",
            department_label: "Municipal Corporation (simulated)",
            provider_mode: "real",
          },
        ],
      }),
    /only 'simulated' may be configured/,
  );
});

test("PACK: a department whose label does not say simulated is refused", () => {
  // The label is what a citizen and a staff member actually read, so the
  // provider_mode field alone is not enough (V010).
  assert.throws(
    () =>
      loadRoutingDirectory(PROFILE, {
        directory_version: "x",
        entries: [
          {
            jurisdiction_internal_code: "DDA-B1",
            category: "sanitation",
            department_id: "demo-sanitation",
            department_label: "Sanitation Department",
            provider_mode: "simulated",
          },
        ],
      }),
    /does not say it is simulated/,
  );
});

test("PACK: a directory listing one category twice is refused", () => {
  // Two owners for one category is contested ownership, which is a review
  // item (V059), not something a pack may assert — and picking the first row
  // would hide it.
  assert.throws(
    () =>
      loadRoutingDirectory(PROFILE, {
        directory_version: "x",
        entries: [
          {
            jurisdiction_internal_code: "DDA-B1",
            category: "sanitation",
            department_id: "demo-a",
            department_label: "A (simulated)",
            provider_mode: "simulated",
          },
          {
            jurisdiction_internal_code: "DDA-B1",
            category: "sanitation",
            department_id: "demo-b",
            department_label: "B (simulated)",
            provider_mode: "simulated",
          },
        ],
      }),
    /twice/,
  );
});

test("PACK: the confirmation policy loads with its version", () => {
  const policy = loadConfirmationPolicy(PROFILE);

  assert.equal(policy.version, "demo-confirmation.v1");
  assert.equal(policy.rules["sanitation"]?.requiredConfirmations, 1);
  assert.equal(policy.rules["structural"]?.requiredConfirmations, 2);
  assert.equal(policy.rules["structural"]?.reviewerMayOverride, false);
  assert.equal(policy.rules["structural"]?.requiresQualifiedInspection, true);
});

test("PACK: a confirmation rule requiring zero confirmations is refused", () => {
  // Zero would mean a staff claim closes an issue with nobody agreeing, which
  // is precisely what V035 exists to prevent.
  assert.throws(
    () =>
      loadConfirmationPolicy(PROFILE, {
        version: "x",
        rules: {
          sanitation: {
            required_confirmations: 0,
            citizen_may_confirm: true,
            reviewer_may_override: false,
          },
        },
      }),
    /at least one|zero/i,
  );
});

test("PACK: matching bounds load, and say they are not calibrated", () => {
  const bounds = loadMatchingBounds(PROFILE);

  assert.equal(bounds.version, "demo-matching.v1");
  assert.equal(bounds.baseRadiusMetres, 150);
  assert.equal(bounds.timeWindowHours, 2160);
  // The pack carries the caveat, so a reader of the configuration sees it
  // without having to find the task record.
  assert.match(bounds.note, /not .*(measured|calibrated)/i);
});

test("PACK: nonsensical matching bounds are refused rather than clamped", () => {
  for (const bad of [
    { base_radius_metres: 0 },
    { base_radius_metres: -1 },
    { time_window_hours: 0 },
    { candidate_limit: 0 },
  ]) {
    assert.throws(
      () =>
        loadMatchingBounds(PROFILE, {
          version: "x",
          note: "not measured",
          ...{
            base_radius_metres: 150,
            unknown_accuracy_allowance_metres: 250,
            time_window_hours: 2160,
            candidate_limit: 50,
            ...bad,
          },
        }),
      ConfigPackError,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("PACK: an unknown profile is refused, not silently defaulted", () => {
  assert.throws(() => loadRoutingDirectory("never-configured"), ConfigPackError);
  assert.throws(() => loadConfirmationPolicy("never-configured"), ConfigPackError);
  assert.throws(() => loadMatchingBounds("never-configured"), ConfigPackError);
});

test("PACK: a rule that omits reviewer override does not get one", () => {
  // Absent means no. Defaulting an override *on* would let a reviewer close a
  // disputed issue in every category nobody had thought about.
  const policy = loadConfirmationPolicy(PROFILE, {
    version: "x",
    rules: { sanitation: { required_confirmations: 1, citizen_may_confirm: true } },
  });

  assert.equal(policy.rules["sanitation"]?.reviewerMayOverride, false);
});

test("PACK: matching bounds with no note are refused", () => {
  // The note is where "these are reasoned, not measured" lives. Without it a
  // reader of the configuration would take the numbers at face value.
  assert.throws(
    () =>
      loadMatchingBounds(PROFILE, {
        version: "x",
        base_radius_metres: 150,
        unknown_accuracy_allowance_metres: 250,
        time_window_hours: 2160,
        candidate_limit: 50,
      }),
    /note saying what they are based on/,
  );
});

// ---------------------------------------------------------------------------
// The classification taxonomy (V023)
// ---------------------------------------------------------------------------

/** A taxonomy override that is valid, so a test can invalidate exactly one field. */
const taxonomyOverride = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: "t.v1",
  note: "a test taxonomy",
  label_language: "en-IN",
  label_note: "not translated",
  categories: [{ id: "sanitation", label: "Sanitation" }],
  defect_ids: ["blockage"],
  ...overrides,
});

test("PACK: the demo taxonomy loads with its categories and defects", () => {
  const taxonomy = loadTaxonomy("demo-district-a");

  assert.equal(taxonomy.version, "demo-taxonomy.v1");
  assert.ok(taxonomy.categoryIds.includes("sanitation"));
  assert.ok(taxonomy.defectIds.length > 0);
});

test("PACK: a taxonomy with no categories is refused rather than loaded empty", () => {
  // An empty taxonomy would make the model's "choose only from the permitted
  // identifiers" instruction unsatisfiable, and every reply would then be
  // rejected as an unknown category — an outage that looks like a model fault.
  assert.throws(
    () => loadTaxonomy("demo-district-a", taxonomyOverride({ categories: [] })),
    ConfigPackError,
  );
});

test("PACK: a taxonomy listing a category twice is refused", () => {
  assert.throws(
    () =>
      loadTaxonomy(
        "demo-district-a",
        taxonomyOverride({
          categories: [
            { id: "sanitation", label: "Sanitation" },
            { id: "sanitation", label: "Sanitation again" },
          ],
        }),
      ),
    ConfigPackError,
  );
});

test("PACK: a taxonomy with no version is refused", () => {
  // The version is recorded on every proposal; an unversioned taxonomy makes
  // a stored proposal impossible to interpret later.
  assert.throws(
    () => loadTaxonomy("demo-district-a", taxonomyOverride({ version: "" })),
    ConfigPackError,
  );
});

test("PACK: a taxonomy with no note saying what the list is, is refused", () => {
  // The note is the only place the pack states that these identifiers are
  // generic and match no authority's own scheme. A taxonomy that loaded
  // without one would let that disclaimer be dropped silently.
  assert.throws(
    () => loadTaxonomy("demo-district-a", taxonomyOverride({ note: "  " })),
    ConfigPackError,
  );
});

test("PACK: an empty defect list is refused as well as an empty category list", () => {
  // One check covers both fields, so both need pinning: a test that only ever
  // passed an empty category list would not notice the defect side.
  assert.throws(
    () => loadTaxonomy("demo-district-a", taxonomyOverride({ defect_ids: [] })),
    ConfigPackError,
  );
});

test("PACK: every category the routing directory owns exists in the taxonomy", () => {
  // Two packs that disagree route real reports to `no_directory_entry`. The
  // packs are data, so this is the only place the agreement can be checked.
  const taxonomy = loadTaxonomy("demo-district-a");
  const directory = loadRoutingDirectory("demo-district-a");

  for (const entry of directory.entries) {
    assert.ok(
      taxonomy.categoryIds.includes(entry.category),
      `the directory owns '${entry.category}', which the taxonomy does not list`,
    );
  }
});

test("PACK: every routing jurisdiction exists in the versioned profile", () => {
  const profile = loadJurisdictionProfile("demo-district-a");
  const directory = loadRoutingDirectory("demo-district-a");
  const codes = new Set(profile.nodes.map((node) => node.internal_code));

  for (const entry of directory.entries) {
    assert.ok(
      codes.has(entry.jurisdictionInternalCode),
      `the directory names unknown jurisdiction '${entry.jurisdictionInternalCode}'`,
    );
  }
});

test("PACK: every category the confirmation policy rules on exists in the taxonomy", () => {
  const taxonomy = loadTaxonomy("demo-district-a");
  const policy = loadConfirmationPolicy("demo-district-a");

  for (const category of Object.keys(policy.rules)) {
    assert.ok(
      taxonomy.categoryIds.includes(category),
      `the confirmation policy rules on '${category}', which the taxonomy does not list`,
    );
  }
});

// ---------------------------------------------------------------------------
// The triage ordering policy (V034)
// ---------------------------------------------------------------------------

test("PACK: the demo triage policy loads with its order and threshold", () => {
  const triage = loadTriagePolicy("demo-district-a");

  assert.equal(triage.version, "demo-triage.v1");
  assert.equal(triage.categoryOrder[0], "structural");
  assert.equal(triage.ageEscalationDays, 14);
});

test("PACK: a triage policy whose note does not disclaim severity is refused", () => {
  // The note is the difference between a configured ordering and an invented
  // urgency score. A policy that loaded without that disclaimer would put a
  // severity-looking field in front of staff, which V034 declined to build.
  assert.throws(
    () =>
      loadTriagePolicy("demo-district-a", {
        version: "t.v1",
        note: "the order to work in",
        category_order: ["sanitation"],
        age_escalation_days: 14,
      }),
    ConfigPackError,
  );
});

test("PACK: a triage policy with no escalation threshold is refused", () => {
  // Without a threshold a category at the bottom of the order is never
  // reached, and reports in it wait indefinitely with nothing recording that.
  assert.throws(
    () =>
      loadTriagePolicy("demo-district-a", {
        version: "t.v1",
        note: "Not a severity, risk or urgency assessment.",
        category_order: ["sanitation"],
      }),
    ConfigPackError,
  );
});

test("PACK: a triage policy listing a category twice is refused", () => {
  assert.throws(
    () =>
      loadTriagePolicy("demo-district-a", {
        version: "t.v1",
        note: "Not a severity, risk or urgency assessment.",
        category_order: ["sanitation", "sanitation"],
        age_escalation_days: 14,
      }),
    ConfigPackError,
  );
});

test("PACK: every category the triage policy orders exists in the taxonomy", () => {
  // A policy ordering a category nothing can be classified as is a rule that
  // never fires, and it would look like coverage that is not there.
  const triage = loadTriagePolicy("demo-district-a");
  const taxonomy = loadTaxonomy("demo-district-a");

  for (const category of triage.categoryOrder) {
    assert.ok(
      taxonomy.categoryIds.includes(category),
      `the triage policy orders '${category}', which the taxonomy does not list`,
    );
  }
});

test("PACK: a triage policy ordering nothing is refused", () => {
  // An empty order makes every category unlisted, so the "unlisted goes last"
  // rule applies to all of them and the policy decides nothing — while still
  // loading as though it did.
  assert.throws(
    () =>
      loadTriagePolicy("demo-district-a", {
        version: "t.v1",
        note: "Not a severity, risk or urgency assessment.",
        category_order: [],
        age_escalation_days: 14,
      }),
    ConfigPackError,
  );
});

test("PACK: a category with no label is refused, not shown by its identifier", () => {
  // A raw identifier like `water_supply` shown to a citizen is a leaked
  // internal name, not a label anybody wrote for them to read.
  assert.throws(
    () => loadTaxonomy("demo-district-a", taxonomyOverride({ categories: [{ id: "sanitation" }] })),
    ConfigPackError,
  );
});

test("PACK: a taxonomy that does not state its label language is refused", () => {
  // An unstated language gets rendered as though it were the reader's. A
  // Marathi reader would be shown English with nothing saying so, which is the
  // kind of silent gap V019's native review exists to surface.
  assert.throws(
    () => loadTaxonomy("demo-district-a", taxonomyOverride({ label_language: "" })),
    ConfigPackError,
  );
});

test("PACK: a taxonomy that does not say whether its labels are translated is refused", () => {
  assert.throws(
    () => loadTaxonomy("demo-district-a", taxonomyOverride({ label_note: "" })),
    ConfigPackError,
  );
});

test("PACK: the demo taxonomy's labels are declared English and untranslated", () => {
  // The demo pack is honest about this rather than leaving it to be discovered
  // by a Marathi reader.
  const taxonomy = loadTaxonomy("demo-district-a");

  assert.equal(taxonomy.labelLanguage, "en-IN");
  assert.match(taxonomy.labelNote, /not translated/i);
  assert.equal(taxonomy.categories[0]?.label, "Water supply");
});

// ---------------------------------------------------------------------------
// Context pack (V040)
// ---------------------------------------------------------------------------

const contextOverride = (over: Record<string, unknown>): Record<string, unknown> => ({
  version: "test-context.v1",
  notice: "SYNTHETIC context data invented for demonstration.",
  source: {
    source_record_id: "a0400000-0000-4000-8000-000000000040",
    source_name: "test register",
    source_url_or_location: "packs/test/context.json",
    retrieved_at: "2026-09-17T00:00:00Z",
    licence_or_permission_status: "synthetic",
    demo_status: "team_created_synthetic",
  },
  datasets: [
    {
      dataset_id: "test.population",
      kind: "population",
      unit: "persons",
      label: "Population (synthetic)",
      max_age_days: 365,
      rows: [
        {
          subject_kind: "jurisdiction",
          subject_id: "T-1",
          value: 100,
          unit: "persons",
          vintage: "2026-01-01T00:00:00Z",
        },
      ],
    },
  ],
  ...over,
});

test("PACK: a context pack whose notice does not say the figures are synthetic is refused", () => {
  // Every screen showing one of these figures inherits the claim the notice
  // makes, so a pack that makes none cannot be loaded.
  assert.throws(
    () => loadContextPack("demo-district-a", contextOverride({ notice: "District context data." })),
    ConfigPackError,
  );
});

test("PACK: a context pack whose source may not be ingested is refused at load", () => {
  for (const licence of ["reference_only", "unavailable", "verification_pending"]) {
    assert.throws(
      () =>
        loadContextPack(
          "demo-district-a",
          contextOverride({
            source: {
              ...(contextOverride({}) as { source: Record<string, unknown> }).source,
              licence_or_permission_status: licence,
            },
          }),
        ),
      ConfigPackError,
      `${licence} data must not be loadable (V004 §5)`,
    );
  }
});

test("PACK: a context dataset with no currency window is refused", () => {
  // Without one there is no threshold at which a reader is told a figure is
  // old, and a stale number shown as current is the failure V040 prevents.
  assert.throws(
    () =>
      loadContextPack(
        "demo-district-a",
        contextOverride({
          datasets: [
            {
              ...(contextOverride({}) as { datasets: Record<string, unknown>[] }).datasets[0],
              max_age_days: 0,
            },
          ],
        }),
      ),
    ConfigPackError,
  );
});

test("PACK: the demo context pack is synthetic, and says so in its own words", () => {
  const pack = loadContextPack("demo-district-a");
  assert.equal(pack.source.licenceOrPermissionStatus, "synthetic");
  assert.equal(pack.source.demoStatus, "team_created_synthetic");
  assert.match(pack.notice, /SYNTHETIC/);
  assert.match(pack.notice, /describes a real place|describe no real place|no real place/i);
  assert.match(pack.notice, /no external dataset was ingested/i);
});

test("PACK: the demo context pack models a missing figure and a stale one on purpose", () => {
  const pack = loadContextPack("demo-district-a");
  const rows = pack.datasets.flatMap((dataset) => dataset.rows);

  // A ward with no population figure must read as unknown everywhere, never as
  // zero people — so the pack ships one.
  assert.ok(
    rows.some((row) => typeof row.value === "string" && /not surveyed|NA/i.test(row.value)),
    "the pack must contain at least one deliberately absent figure",
  );

  // And one figure old enough that every screen showing it has to say so.
  const access = pack.datasets.find((dataset) => dataset.kind === "access");
  assert.notEqual(access, undefined);
  const oldest = Math.min(...(access?.rows ?? []).map((row) => Date.parse(row.vintage)));
  assert.ok(
    Date.now() - oldest > (access?.maxAgeDays ?? 0) * 86_400_000,
    "the pack must contain at least one figure past its currency window",
  );
});

// ---------------------------------------------------------------------------
// Project register (V041)
// ---------------------------------------------------------------------------

const registerOverride = (over: Record<string, unknown>): Record<string, unknown> => ({
  version: "test-projects.v1",
  notice: "SYNTHETIC sanctioned-project register invented for demonstration.",
  source: {
    source_record_id: "a0410000-0000-4000-8000-000000000041",
    source_name: "test register",
    source_url_or_location: "packs/test/projects.json",
    retrieved_at: "2026-09-17T00:00:00Z",
    licence_or_permission_status: "synthetic",
    demo_status: "team_created_synthetic",
  },
  projects: [
    {
      project_id: "T-PRJ-1",
      project_name: "Test works (synthetic)",
      scope_description: "Scope.",
      scope_terms: ["water_supply"],
      asset_id: null,
      jurisdiction_internal_code: "T-1",
      longitude: 74.5,
      latitude: 16.8,
      sanctioned_at: "2025-04-01T00:00:00Z",
      completed_at: null,
      amount: 100,
      amount_unit: "inr",
    },
  ],
  ...over,
});

const firstProject = (): Record<string, unknown> =>
  (registerOverride({}) as { projects: Record<string, unknown>[] }).projects[0] as Record<
    string,
    unknown
  >;

test("PACK: a project register whose notice does not say the projects are synthetic is refused", () => {
  // A funding claim inherits whatever the register says about itself, and
  // "this asset was paid for" is the most loaded thing this system can appear
  // to say. A register that makes no claim about its own provenance cannot be
  // loaded at all.
  assert.throws(
    () => loadProjectRegister("demo-district-a", registerOverride({ notice: "Project register." })),
    ConfigPackError,
  );
});

test("PACK: a project register that may not be ingested is refused at load", () => {
  for (const licence of ["reference_only", "unavailable", "verification_pending"]) {
    assert.throws(
      () =>
        loadProjectRegister(
          "demo-district-a",
          registerOverride({
            source: {
              ...(registerOverride({}) as { source: Record<string, unknown> }).source,
              licence_or_permission_status: licence,
            },
          }),
        ),
      ConfigPackError,
      `${licence} funding data must not be loadable (V004 §5)`,
    );
  }
});

test("PACK: a project with no scope terms is refused", () => {
  // Without them it can only ever be matched on where it is, and proximity
  // alone is never enough to propose a link (V041).
  assert.throws(
    () =>
      loadProjectRegister(
        "demo-district-a",
        registerOverride({ projects: [{ ...firstProject(), scope_terms: [] }] }),
      ),
    ConfigPackError,
  );
});

test("PACK: an amount without its unit is refused, and so is a unit without an amount", () => {
  for (const broken of [{ amount_unit: null }, { amount: null }]) {
    assert.throws(
      () =>
        loadProjectRegister(
          "demo-district-a",
          registerOverride({ projects: [{ ...firstProject(), ...broken }] }),
        ),
      ConfigPackError,
    );
  }
});

test("PACK: the demo register models one defensible match, one ambiguity and one distractor", () => {
  const pack = loadProjectRegister("demo-district-a");
  assert.equal(pack.source.licenceOrPermissionStatus, "synthetic");
  assert.match(pack.notice, /SYNTHETIC/);
  assert.match(pack.notice, /nothing here may be quoted as evidence/i);

  // Projects naming an asset: the only signal that can carry a proposal alone.
  // Two of them, with different jobs — one demonstrates a defensible link, the
  // other a report whose lifecycle falls inside a project's own dates (V043).
  assert.equal(pack.projects.filter((project) => project.assetId !== null).length, 2);

  // Two sharing a place and a scope, so the matcher has to say it cannot
  // separate them rather than picking one.
  const sanitation = pack.projects.filter((project) => project.scopeTerms.includes("sanitation"));
  assert.equal(sanitation.length, 2);
  assert.notEqual(sanitation[0]?.projectId, sanitation[1]?.projectId);

  // And at least one that matches nothing, so a no-match is a real search
  // rather than a search of an empty register.
  assert.ok(pack.projects.length >= 4);
});

// ---------------------------------------------------------------------------
// Prioritization policy (V042)
// ---------------------------------------------------------------------------

const priorityOverride = (over: Record<string, unknown>): Record<string, unknown> => ({
  version: "test-priority.v1",
  note: "An ordering by configured factors. It is not a finding about need.",
  budget_assumption: "No budget or cost information is used anywhere in this ordering.",
  minimum_factors_for_ranking: 2,
  existing_project_direction: "deprioritise",
  existing_project_rationale: "a confirmed project suggests the work is already planned",
  references: {
    persistence_reference_days: 120,
    persistence_per_reopening: 0.25,
    population_reference_count: 20000,
    equity_reference_rate_per_1000: 8,
    alternatives_reference_count: 3,
  },
  weightings: [
    {
      id: "a",
      label: "A",
      rationale: "one defensible reading",
      weights: { persistence: 0.5, reporting_equity: 0.5 },
    },
    {
      id: "b",
      label: "B",
      rationale: "another defensible reading",
      weights: { persistence: 0.8, reporting_equity: 0.2 },
    },
  ],
  ...over,
});

test("PACK: a prioritization policy with one weighting is refused", () => {
  // One weighting produces a ranking that reads as a finding; the interval
  // between several is what the evidence supports.
  assert.throws(
    () =>
      loadPrioritizationPolicy(
        "demo-district-a",
        priorityOverride({
          weightings: [(priorityOverride({}) as { weightings: unknown[] }).weightings[0]],
        }),
      ),
    ConfigPackError,
  );
});

test("PACK: weightings that do not sum to one are refused", () => {
  assert.throws(
    () =>
      loadPrioritizationPolicy(
        "demo-district-a",
        priorityOverride({
          weightings: [
            { id: "a", label: "A", rationale: "r", weights: { persistence: 0.5 } },
            { id: "b", label: "B", rationale: "r", weights: { persistence: 1 } },
          ],
        }),
      ),
    ConfigPackError,
    "intervals between weightings that are not comparable mean nothing",
  );
});

test("PACK: a policy that does not state its budget assumption is refused", () => {
  // The ordering knows nothing about cost, and every reader will assume
  // otherwise unless the pack says so.
  assert.throws(
    () =>
      loadPrioritizationPolicy(
        "demo-district-a",
        priorityOverride({ budget_assumption: "Costs are considered." }),
      ),
    ConfigPackError,
  );
});

test("PACK: the direction of the existing-project factor must be chosen explicitly", () => {
  assert.throws(
    () =>
      loadPrioritizationPolicy(
        "demo-district-a",
        priorityOverride({ existing_project_direction: "either" }),
      ),
    ConfigPackError,
  );
});

test("PACK: the demo policy declares four plausible weightings that genuinely differ", () => {
  const pack = loadPrioritizationPolicy("demo-district-a");
  assert.ok(pack.weightings.length >= 4);
  assert.match(pack.budgetAssumption, /No budget, cost, capacity or delivery-time/);
  assert.match(pack.note, /not a finding about need/);

  // Each weighting must lead on a different factor, or the "plausible
  // alternatives" are the same reading four times and the interval is fake.
  const leaders = pack.weightings.map((weighting) => {
    const entries = Object.entries(weighting.weights).sort((a, b) => b[1] - a[1]);
    return entries[0]?.[0];
  });
  assert.equal(new Set(leaders).size >= 3, true, `weightings lead on ${leaders.join(", ")}`);
  assert.match(pack.existingProjectRationale, /equally defensible/);
});
