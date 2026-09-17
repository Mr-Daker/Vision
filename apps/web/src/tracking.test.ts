/**
 * Tracking and discovery view models (roadmap V030).
 *
 * Pure: these take an API payload and return exactly what should appear on
 * screen, so the wording that carries the honesty obligations is testable
 * without a browser.
 *
 * The recurring risk here is a number that reads as more than it is. "Three
 * people reported this" must never render as "three people affected", and an
 * empty list of nearby issues must never render as "nothing is wrong nearby".
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { interpolate, type Translate } from "./i18n.ts";
import { enIN } from "./locales/en-IN.ts";
import {
  type CandidatePayload,
  type DetailPayload,
  type DiscoveryPayload,
  type ReportPayload,
  type ResolutionPayload,
  normalizeReceiptReference,
  toCandidateView,
  toCategoryOptions,
  toDetailView,
  toDiscoveryMapView,
  toDiscoveryView,
  toReceiptLookupView,
  toReportRows,
  toResolutionView,
} from "./tracking.ts";

const report = (overrides: Partial<ReportPayload> = {}): ReportPayload => ({
  submission_id: "11111111-1111-1111-1111-111111111111",
  submitted_at: "2026-09-10T10:00:00.000Z",
  observed_at: "2026-09-10T09:55:00.000Z",
  status_label: "Grouped with an issue (created)",
  issue_public_reference: "VIS-ABCD1234",
  issue_status: "created",
  evidence_count: 2,
  ...overrides,
});

const discovery = (overrides: Partial<DiscoveryPayload> = {}): DiscoveryPayload => ({
  issues: [
    {
      public_reference: "VIS-ABCD1234",
      category: "sanitation",
      current_status: "created",
      coarse_location: { lon: 74.81, lat: 17.05 },
      counted_participants: 3,
      approved_derivative_references: [],
      last_evidence_at: "2026-09-10T10:00:00.000Z",
    },
  ],
  next_cursor: null,
  applied_limit: 50,
  applied_filters: { category: null, radius_m: 2000 },
  note: "this is a bounded search by radius and page size",
  ...overrides,
});

const detail = (overrides: Partial<DetailPayload> = {}): DetailPayload => ({
  public_reference: "VIS-ABCD1234",
  category: "sanitation",
  current_status: "created",
  opened_at: "2026-09-01T10:00:00.000Z",
  last_evidence_at: "2026-09-10T10:00:00.000Z",
  coarse_location: { lon: 74.81, lat: 17.05 },
  counted_participants: 3,
  complaint_entries: 5,
  evidence: [
    {
      media_type: "text",
      content_text: "The drain is blocked.",
      derivative_reference: null,
      viewable: true,
      why_not_viewable: null,
      ingested_at: "2026-09-01T10:00:00.000Z",
    },
  ],
  infrastructure_history: [],
  infrastructure_history_note: "infrastructure history is separate from complaint entries",
  assignment: { is_live: false, note: "no routing workflow is live yet; V034 supplies these" },
  resolution: { is_live: false, note: "no resolution workflow is live yet; V035 supplies these" },
  disclosures: ["identity in this demonstration is simulated"],
  ...overrides,
});

// ---------------------------------------------------------------------------
// My reports
// ---------------------------------------------------------------------------

test("V030: a report row shows its reference and how much evidence it carries", () => {
  const [row] = toReportRows([report()]);

  assert.equal(row?.reference, "VIS-ABCD1234");
  assert.equal(row?.evidenceCount, 2);
  assert.equal(row?.hasIssue, true);
});

test("V030: an ungrouped report is shown as received, not as progress", () => {
  const [row] = toReportRows([
    report({
      issue_public_reference: null,
      issue_status: null,
      status_label: "Received and not yet grouped with an issue",
    }),
  ]);

  assert.equal(row?.hasIssue, false);
  assert.equal(row?.reference, undefined);
  assert.match(row?.statusLabel ?? "", /received|not yet/i);
});

test("V030: report rows keep the server's order", () => {
  const rows = toReportRows([
    report({ submission_id: "a", submitted_at: "2026-09-10T10:00:00.000Z" }),
    report({ submission_id: "b", submitted_at: "2026-09-09T10:00:00.000Z" }),
  ]);

  assert.deepEqual(
    rows.map((row) => row.submissionId),
    ["a", "b"],
  );
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("V030: a discovery view labels the count as people who reported", () => {
  const view = toDiscoveryView(discovery());

  // Not "affected". A count of reporters is not a count of people with the
  // problem, and the difference is the whole point.
  assert.match(view.issues[0]?.participantsLabel ?? "", /reported/i);
  assert.doesNotMatch(view.issues[0]?.participantsLabel ?? "", /affected|impacted/i);
});

test("V030: an empty discovery result never reads as nothing being wrong", () => {
  const view = toDiscoveryView(discovery({ issues: [] }));

  assert.equal(view.isEmpty, true);
  assert.match(view.emptyMessage, /searched|bounded|does not mean/i);
  assert.doesNotMatch(view.emptyMessage, /^no problems|nothing is wrong/i);
});

test("V030: the applied bounds are always shown, not just when empty", () => {
  const view = toDiscoveryView(discovery());

  assert.match(view.boundsLabel, /2000|2 km|radius/i);
  assert.equal(view.hasMore, false);
});

test("V030: more pages available is reported", () => {
  const view = toDiscoveryView(discovery({ next_cursor: "abc" }));

  assert.equal(view.hasMore, true);
  assert.equal(view.nextCursor, "abc");
});

test("V030: a filter in effect is visible in the view", () => {
  const view = toDiscoveryView(
    discovery({ applied_filters: { category: "sanitation", radius_m: 500 } }),
  );

  assert.match(view.boundsLabel, /sanitation/);
});

test("V030: the map uses the radius the server actually applied", () => {
  const view = toDiscoveryView(discovery({ applied_filters: { category: null, radius_m: 750 } }));

  assert.equal(view.radiusMetres, 750);
});

test("V030: map markers preserve real bearing around the search centre", () => {
  const rows = toDiscoveryView(
    discovery({
      issues: [
        {
          ...discovery().issues[0]!,
          public_reference: "VIS-EAST0001",
          coarse_location: { lon: 74.801, lat: 17.05 },
        },
        {
          ...discovery().issues[0]!,
          public_reference: "VIS-NORTH001",
          coarse_location: { lon: 74.8, lat: 17.051 },
        },
      ],
    }),
  ).issues;
  const map = toDiscoveryMapView(rows, { lon: 74.8, lat: 17.05 }, 2_000);

  assert.equal(map.markers.length, 2);
  assert.ok((map.markers[0]?.leftPercent ?? 0) > 50, "east must plot to the right");
  assert.equal(map.markers[0]?.topPercent, 50);
  assert.equal(map.markers[1]?.leftPercent, 50);
  assert.ok((map.markers[1]?.topPercent ?? 100) < 50, "north must plot above centre");
});

test("V030: results without a public location stay in the list and are counted off-map", () => {
  const rows = toDiscoveryView(
    discovery({
      issues: [
        {
          ...discovery().issues[0]!,
          coarse_location: null,
        },
      ],
    }),
  ).issues;
  const map = toDiscoveryMapView(rows, { lon: 74.8, lat: 17.05 }, 2_000);

  assert.equal(map.totalIssues, 1);
  assert.equal(map.markers.length, 0);
  assert.equal(map.missingPublicLocationCount, 1);
});

test("V030: a rounded point outside the displayed extent is disclosed, never clamped", () => {
  const rows = toDiscoveryView(
    discovery({
      issues: [
        {
          ...discovery().issues[0]!,
          coarse_location: { lon: 75, lat: 17.05 },
        },
      ],
    }),
  ).issues;
  const map = toDiscoveryMapView(rows, { lon: 74.8, lat: 17.05 }, 500);

  assert.equal(map.markers.length, 0);
  assert.equal(map.outsideDisplayedExtentCount, 1);
});

// ---------------------------------------------------------------------------
// Receipt lookup
// ---------------------------------------------------------------------------

test("V030: receipt lookup normalizes a complete reference", () => {
  assert.equal(
    normalizeReceiptReference(" 11111111-1111-4111-8111-111111111111 "),
    "11111111-1111-4111-8111-111111111111",
  );
});

test("V030: receipt lookup refuses partial or malformed references before fetching", () => {
  assert.equal(normalizeReceiptReference(""), undefined);
  assert.equal(normalizeReceiptReference("11111111"), undefined);
  assert.equal(normalizeReceiptReference("11111111-1111-1111-1111-111111111111"), undefined);
});

test("V030: a found receipt displays only facts returned by the receipt API", () => {
  const view = toReceiptLookupView({
    submission_id: "11111111-1111-4111-8111-111111111111",
    processing_status: "accepted",
    server_received_at: "2026-09-10T10:00:00.000Z",
    replayed: false,
  });

  assert.deepEqual(view, {
    reference: "11111111-1111-4111-8111-111111111111",
    status: "accepted",
    receivedAt: "2026-09-10T10:00:00.000Z",
    wasReplay: false,
  });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

test("V030: a detail view separates contributors from complaint entries", () => {
  const view = toDetailView(detail());

  assert.match(view.participantsLabel, /3/);
  assert.match(view.entriesLabel, /5/);
  // Two different sentences, because they are two different facts.
  assert.notEqual(view.participantsLabel, view.entriesLabel);
});

test("V030: a photo that cannot be shown says why", () => {
  const view = toDetailView(
    detail({
      evidence: [
        {
          media_type: "photo",
          content_text: null,
          derivative_reference: null,
          viewable: false,
          why_not_viewable: "no approved derivative exists yet (redaction status: needs_review)",
          ingested_at: "2026-09-01T10:00:00.000Z",
        },
      ],
    }),
  );

  const item = view.evidence[0];
  assert.equal(item?.showImage, false);
  assert.match(item?.note ?? "", /redaction|approved/i);
});

test("V030: only an approved derivative produces an image source", () => {
  const view = toDetailView(
    detail({
      evidence: [
        {
          media_type: "photo",
          content_text: null,
          derivative_reference: "derivatives/2026-09/abc",
          viewable: true,
          why_not_viewable: null,
          ingested_at: "2026-09-01T10:00:00.000Z",
        },
      ],
    }),
  );

  assert.equal(view.evidence[0]?.showImage, true);
  assert.match(view.evidence[0]?.imageSource ?? "", /^\/v1\/media\/derivatives/);
  assert.doesNotMatch(view.evidence[0]?.imageSource ?? "", /originals/);
});

test("V030: an empty infrastructure history is explained, not left blank", () => {
  const view = toDetailView(detail());

  assert.equal(view.hasInfrastructureHistory, false);
  assert.match(view.infrastructureHistoryNote, /separate|complaint/i);
});

test("V030: assignment and resolution are rendered as not yet live", () => {
  const view = toDetailView(detail());

  assert.equal(view.assignment.isLive, false);
  assert.match(view.assignment.note, /V034|not .*live/i);
  assert.equal(view.resolution.isLive, false);
});

test("V030: every disclosure reaches the view", () => {
  const view = toDetailView(
    detail({ disclosures: ["identity is simulated", "the category is a proposal"] }),
  );

  assert.deepEqual(view.disclosures, ["identity is simulated", "the category is a proposal"]);
});

test("V030: a detail view with no disclosures is treated as a fault, not rendered silently", () => {
  // A page that shows none has either lost them in transit or is claiming
  // more certainty than the system has.
  const view = toDetailView(detail({ disclosures: [] }));

  assert.equal(view.disclosures.length, 1);
  assert.match(view.disclosures[0] ?? "", /could not be loaded|unavailable/i);
});

// ---------------------------------------------------------------------------
// The discovery filter's options (V030)
// ---------------------------------------------------------------------------

test("V030: filter options come from the taxonomy, with 'all' still first", () => {
  // V030 recorded that the filter "is populated with no options until a
  // taxonomy pack is loaded, so it currently shows only 'All categories'".
  // "All" stays first because clearing the filter must always be reachable.
  const view = toCategoryOptions(
    {
      taxonomy_version: "demo-taxonomy.v1",
      categories: [
        { id: "water_supply", label: "Water supply" },
        { id: "sanitation", label: "Sanitation and drainage" },
      ],
      note: "generic identifiers",
      label_language: "en-IN",
      label_note: "These labels are English only and are not translated.",
    },
    "All categories",
  );

  assert.deepEqual(
    view.options.map((option) => option.value),
    ["", "water_supply", "sanitation"],
  );
  assert.equal(view.options[0]?.label, "All categories");
  assert.equal(view.options[1]?.label, "Water supply");
});

test("V030: an untranslated label is disclosed when the page is not in its language", () => {
  // A Marathi page showing English category names must say so. Finding
  // English in a page that claims to be translated is how a reader loses
  // confidence in everything else on it.
  const view = toCategoryOptions(
    {
      taxonomy_version: "demo-taxonomy.v1",
      categories: [{ id: "sanitation", label: "Sanitation and drainage" }],
      note: "generic identifiers",
      label_language: "en-IN",
      label_note: "These labels are English only and are not translated.",
    },
    "All categories",
    "mr-IN",
  );

  assert.notEqual(view.languageDisclosure, undefined);
  assert.match(view.languageDisclosure ?? "", /not translated/i);
});

test("V030: no disclosure is shown when the labels are in the page's language", () => {
  // Saying "these are in English" on an English page is noise, and noise
  // trains people to skip the disclosures that matter.
  const view = toCategoryOptions(
    {
      taxonomy_version: "demo-taxonomy.v1",
      categories: [{ id: "sanitation", label: "Sanitation and drainage" }],
      note: "generic identifiers",
      label_language: "en-IN",
      label_note: "These labels are English only and are not translated.",
    },
    "All categories",
    "en-IN",
  );

  assert.equal(view.languageDisclosure, undefined);
});

test("V030: an empty taxonomy leaves 'all' selectable rather than an empty list", () => {
  // A select with no options at all is a dead control. The filter degrades to
  // "everything", which is what it does today.
  const view = toCategoryOptions(
    {
      taxonomy_version: "demo-taxonomy.v1",
      categories: [],
      note: "generic identifiers",
      label_language: "en-IN",
      label_note: "not translated",
    },
    "All categories",
  );

  assert.deepEqual(
    view.options.map((option) => option.value),
    [""],
  );
});

test("V030: the filter never offers a defect identifier", () => {
  // A citizen is never asked to classify (V018 §2). Offering defects would be
  // an interface that does.
  const view = toCategoryOptions(
    {
      taxonomy_version: "demo-taxonomy.v1",
      categories: [{ id: "sanitation", label: "Sanitation and drainage" }],
      note: "generic identifiers",
      label_language: "en-IN",
      label_note: "not translated",
      // A server that started sending these must not have them rendered.
      defect_ids: ["blockage", "leak"],
    } as never,
    "All categories",
  );

  assert.deepEqual(
    view.options.map((option) => option.value),
    ["", "sanitation"],
  );
});

// ---------------------------------------------------------------------------
// The citizen confirm/reject question (V031)
// ---------------------------------------------------------------------------

const candidate = (overrides: Record<string, unknown> = {}): CandidatePayload => {
  // `candidate` is pulled out of the overrides before the outer spread: an
  // earlier version spread the whole overrides object last, which replaced the
  // merged inner object wholesale and left its other fields undefined.
  const { candidate: candidateOverrides, ...rest } = overrides;
  return {
    candidate: {
      public_reference: "VIS-0A1B2C3D",
      category: "sanitation",
      opened_at: "2026-09-01T08:00:00.000Z",
      last_evidence_at: "2026-09-08T09:30:00.000Z",
      coarse_location: { lon: 75.906, lat: 17.66 },
      distance_metres: 42,
      counted_participants: 3,
      entry_count: 4,
      preview_derivatives: ["derivatives/a/one.png"],
      ...(candidateOverrides as Record<string, unknown> | undefined),
    },
    resolved_through_alias: false,
    ...rest,
  } as CandidatePayload;
};

/**
 * An English translator, so these assertions read as the sentences a reader
 * sees. The Marathi pack is exercised by the locale-pack tests; what matters
 * here is that the view builder renders whichever pack it is handed.
 */
const translate: Translate = (key, params) => interpolate(enIN.strings[key], params);

test("V031: the question asked is whether it is the same problem", () => {
  // Not whether the category is right, and not which department owns it. V031
  // exists to remove the classification burden from the citizen (V018 §2), and
  // the wording is where that either holds or quietly fails.
  const view = toCandidateView(candidate(), translate);

  assert.match(view.question, /same problem/i);
  assert.doesNotMatch(view.question, /categor|department|severity|classif/i);
});

test("V031: the candidate is described without naming anyone who reported it", () => {
  const view = toCandidateView(candidate(), translate);

  assert.match(view.summary, /VIS-0A1B2C3D/);
  assert.doesNotMatch(view.summary, /reporter|name|phone|@/i);
});

test("V031: a count of others is reported as a count, never as agreement", () => {
  // Three people reporting a problem is three reports. It is not three people
  // agreeing with *this* reporter, and it is not corroboration of anything
  // they said.
  const view = toCandidateView(candidate({ candidate: { counted_participants: 3 } }), translate);

  assert.match(view.participantsLabel, /3/);
  assert.doesNotMatch(view.participantsLabel, /agree|confirm|verif|corrobor/i);
});

test("V031: distance is reported as approximate, not as a measurement of the problem", () => {
  // The distance is between two reported positions, each with its own
  // accuracy. Printing "42 m" flat would present a precision neither has.
  const view = toCandidateView(candidate({ candidate: { distance_metres: 42 } }), translate);

  assert.match(view.distanceLabel ?? "", /about|approx|~/i);
});

test("V031: an absent distance is omitted rather than shown as zero", () => {
  // Zero metres would read as "the same spot", which is the opposite of
  // "we do not know".
  const view = toCandidateView(candidate({ candidate: { distance_metres: null } }), translate);

  assert.equal(view.distanceLabel, undefined);
});

test("V031: rejecting is offered as an equal choice, not as a warned-against one", () => {
  // If the reject button is hedged with warnings the citizen learns that
  // disagreeing is the difficult path, and the question stops being a real
  // question.
  const view = toCandidateView(candidate(), translate);

  assert.ok(view.confirmLabel.length > 0);
  assert.ok(view.rejectLabel.length > 0);
  assert.doesNotMatch(view.rejectLabel, /are you sure|warning|careful|cannot be undone/i);
});

test("V031: the consequence of each choice is stated plainly", () => {
  const view = toCandidateView(candidate(), translate);

  assert.match(view.confirmConsequence, /added to|joins|same/i);
  assert.match(view.rejectConsequence, /separate|own|new/i);
});

test("V031: a candidate reached through a merge alias says so", () => {
  // The reference the citizen was shown may have been retired by a merge. A
  // screen naming a different reference than the one they saw, with nothing
  // explaining it, looks like the system lost their report.
  const view = toCandidateView(candidate({ resolved_through_alias: true }), translate);

  assert.match(view.aliasNote ?? "", /merged|combined/i);
});

test("V031: nothing on the screen claims the match is verified", () => {
  const view = toCandidateView(candidate(), translate);
  const everything = [
    view.question,
    view.summary,
    view.participantsLabel,
    view.confirmConsequence,
    view.rejectConsequence,
  ].join(" ");

  assert.doesNotMatch(everything, /verified|confirmed match|proven|certain/i);
});

test("V031: previews are listed, and a candidate with none is not an error", () => {
  const withPreview = toCandidateView(candidate(), translate);
  const without = toCandidateView(candidate({ candidate: { preview_derivatives: [] } }), translate);

  assert.equal(withPreview.previewReferences.length, 1);
  assert.equal(without.previewReferences.length, 0);
  assert.equal(without.question, withPreview.question);
});

test("V031: a report row carries the pending question so the list can offer it", () => {
  const rows = toReportRows([
    {
      submission_id: "s-1",
      submitted_at: "2026-09-10T10:00:00.000Z",
      observed_at: "2026-09-10T09:00:00.000Z",
      status_label: "Received",
      issue_public_reference: null,
      issue_status: null,
      evidence_count: 1,
      awaiting_answer_for_issue_id: "issue-7",
    },
    {
      submission_id: "s-2",
      submitted_at: "2026-09-10T10:00:00.000Z",
      observed_at: "2026-09-10T09:00:00.000Z",
      status_label: "Received",
      issue_public_reference: "VIS-1",
      issue_status: "created",
      evidence_count: 1,
      awaiting_answer_for_issue_id: null,
    },
  ]);

  assert.equal(rows[0]?.awaitingAnswerForIssueId, "issue-7");
  assert.equal(rows[1]?.awaitingAnswerForIssueId, undefined);
});

test("V031: a coarse position is rendered as numbers, not as an object", () => {
  // Found by opening the page rather than by a test: the payload sends
  // `{lon, lat}` and an earlier version of this test passed a string, so
  // interpolating the object printed "near [object Object]" to the reader with
  // every test still green.
  const view = toCandidateView(
    candidate({ candidate: { coarse_location: { lon: 75.906, lat: 17.66 } } }),
    translate,
  );

  assert.doesNotMatch(view.summary, /\[object Object\]/);
  assert.match(view.summary, /17\.660, 75\.906/);
});

test("V031: a coarse position keeps the precision the server published", () => {
  // The server coarsens the position on purpose. Printing more decimal places
  // than it sent would invent precision it deliberately removed, and a reader
  // would take it for the reported location.
  const view = toCandidateView(
    candidate({ candidate: { coarse_location: { lon: 75.9061234, lat: 17.6598765 } } }),
    translate,
  );

  assert.match(view.summary, /17\.660, 75\.906/);
  assert.doesNotMatch(view.summary, /17\.6598|75\.90612/);
});

test("V030: an issue with no counted contribution does not claim nobody reported it", () => {
  // Found by submitting a real report and looking at the result. An issue
  // exists *because* somebody reported it, so "0 people reported this" is a
  // statement the interface knows to be false.
  //
  // Zero is the ordinary case right now, not an edge one: counting a
  // contribution needs `demo_processing` consent (V014), nothing records that
  // consent yet (V044 owns the capture notices), so every real report is
  // recorded and not counted.
  const view = toDiscoveryView({
    issues: [
      {
        public_reference: "VIS-0A1B2C3D",
        category: "sanitation",
        current_status: "created",
        coarse_location: { lon: 76.55, lat: 18.55 },
        counted_participants: 0,
        last_evidence_at: "2026-09-11T10:00:00.000Z",
        approved_derivative_references: [],
      },
    ],
    applied_filters: { radius_m: 500, category: null },
    applied_limit: 20,
    next_cursor: null,
    note: "Nothing was found within the area searched.",
  });

  const label = view.issues[0]?.participantsLabel ?? "";
  assert.doesNotMatch(label, /^0 people reported this$/);
  // It says what is true: no contribution has been counted, which is not the
  // same claim as nobody having reported.
  assert.match(label, /no contribution has been counted|not been counted/i);
});

test("V030: a counted contribution is still reported plainly", () => {
  const view = toDiscoveryView({
    issues: [
      {
        public_reference: "VIS-0A1B2C3D",
        category: "sanitation",
        current_status: "created",
        coarse_location: { lon: 76.55, lat: 18.55 },
        counted_participants: 3,
        last_evidence_at: "2026-09-11T10:00:00.000Z",
        approved_derivative_references: [],
      },
    ],
    applied_filters: { radius_m: 500, category: null },
    applied_limit: 20,
    next_cursor: null,
    note: "Nothing was found within the area searched.",
  });

  assert.equal(view.issues[0]?.participantsLabel, "3 people reported this");
});

// ---------------------------------------------------------------------------
// V035 — the citizen's view of a repair claim
// ---------------------------------------------------------------------------

const resolutionPayload = (overrides: Record<string, unknown> = {}): ResolutionPayload =>
  ({
    issue_status: "resolution_claimed",
    claim: {
      claimed_at: "2026-09-10T09:00:00.000Z",
      description: "Replaced the washer and resealed the joint.",
      completion_evidence: [
        {
          media_type: "photo",
          derivative_reference: null,
          viewable: false,
          why_not_viewable: "no approved derivative exists yet",
        },
      ],
    },
    confirmation_policy_version: "demo-confirmation.v1",
    required_confirmations: 1,
    confirmations_recorded: 0,
    disputes_recorded: 0,
    confirmation_status: "claimed_awaiting_confirmation",
    is_verified_resolution: false,
    counts_as_closed: false,
    resolved_by_reviewer: false,
    requires_qualified_inspection: false,
    may_respond: true,
    may_respond_blocked_by: null,
    may_reopen: false,
    history: [
      {
        at: "2026-09-10T09:00:00.000Z",
        kind: "resolution_claimed",
        what: "Department staff recorded a repair claim awaiting confirmation",
        comment: "Replaced the washer and resealed the joint.",
        by_reviewer: false,
      },
    ],
    disclosures: ["A confirmed repair means participants agreed…"],
    ...overrides,
  }) as ResolutionPayload;

test("V035: a claim maps to the claimed state, never the confirmed one", () => {
  const view = toResolutionView(resolutionPayload());
  assert.equal(view.stateKey, "resolution.state_claimed");
  assert.equal(view.isVerifiedResolution, false);
});

test("V035: each lifecycle status selects its own sentence", () => {
  for (const [status, key] of [
    ["resolution_claimed", "resolution.state_claimed"],
    ["resolution_confirmed", "resolution.state_confirmed"],
    ["resolution_disputed", "resolution.state_disputed"],
    ["reopened", "resolution.state_reopened"],
  ] as const) {
    assert.equal(toResolutionView(resolutionPayload({ issue_status: status })).stateKey, key);
  }
});

test("V035: an unrecognised status falls back to the claim wording, not the confirmed one", () => {
  // The worst possible default on this screen would be "confirmed". A status
  // this build does not know about is still, at most, a claim.
  const view = toResolutionView(resolutionPayload({ issue_status: "some_future_state" }));
  assert.equal(view.stateKey, "resolution.state_claimed");
});

test("V035: `isVerifiedResolution` is the server's, never derived from the status name", () => {
  // A payload whose status says confirmed but whose flag says otherwise is
  // reported as the flag says. The flag is the field the API computes from a
  // persisted confirmation record; the name is just a name.
  const view = toResolutionView(
    resolutionPayload({ issue_status: "resolution_confirmed", is_verified_resolution: false }),
  );
  assert.equal(view.stateKey, "resolution.state_confirmed");
  assert.equal(view.isVerifiedResolution, false);
});

test("V035: completion evidence carries no object reference, only an approved derivative", () => {
  const view = toResolutionView(
    resolutionPayload({
      claim: {
        claimed_at: "2026-09-10T09:00:00.000Z",
        description: "Done.",
        completion_evidence: [
          {
            media_type: "photo",
            derivative_reference: "derivatives/2026-09/abc",
            viewable: true,
            why_not_viewable: null,
          },
        ],
      },
    }),
  );
  const row = view.evidence[0];
  assert.equal(row?.derivativeReference, "derivatives/2026-09/abc");
  // The shaped row has no field that could hold a private original, so there
  // is nothing for a later edit to render by accident.
  assert.deepEqual(Object.keys(row ?? {}).sort(), [
    "derivativeReference",
    "viewable",
    "whyNotViewable",
  ]);
});

test("V035: an unapproved photograph is not shown, and says why", () => {
  const view = toResolutionView(resolutionPayload());
  assert.equal(view.evidence[0]?.viewable, false);
  assert.equal(view.evidence[0]?.derivativeReference, undefined);
  assert.match(view.evidence[0]?.whyNotViewable ?? "", /no approved derivative/i);
});

test("V035: every refusal to answer names its own cause", () => {
  for (const [reason, key] of [
    ["not_a_counted_participant", "resolution.blocked_not_participant"],
    ["already_answered", "resolution.blocked_already_answered"],
    ["no_claim_awaiting_an_answer", "resolution.blocked_no_claim"],
    ["policy_excludes_citizens", "resolution.blocked_policy"],
  ] as const) {
    const view = toResolutionView(
      resolutionPayload({ may_respond: false, may_respond_blocked_by: reason }),
    );
    assert.equal(view.mayRespond, false);
    assert.equal(view.blockedKey, key);
  }
});

test("V035: a reopened issue is not a standing resolution", () => {
  const view = toResolutionView(
    resolutionPayload({
      issue_status: "reopened",
      is_verified_resolution: false,
      counts_as_closed: false,
      may_reopen: false,
    }),
  );
  assert.equal(view.stateKey, "resolution.state_reopened");
  assert.equal(view.isVerifiedResolution, false);
});

test("V035: an issue with no claim renders nothing rather than an empty claim", () => {
  const view = toResolutionView(resolutionPayload({ claim: null }));
  assert.equal(view.hasClaim, false);
  assert.equal(view.description, undefined);
  assert.deepEqual(view.evidence, []);
});

test("V035: a reviewer override is not reported as the reporters agreeing", () => {
  // The people who reported it *disputed* it; a reviewer decided otherwise.
  // Telling them "people who reported this agreed" would be false to the face
  // of the person who disagreed, so the confirmed state has two sentences.
  const overridden = toResolutionView(
    resolutionPayload({
      issue_status: "resolution_confirmed",
      is_verified_resolution: true,
      counts_as_closed: true,
      resolved_by_reviewer: true,
    }),
  );
  assert.equal(overridden.stateKey, "resolution.state_confirmed_by_reviewer");

  const agreed = toResolutionView(
    resolutionPayload({
      issue_status: "resolution_confirmed",
      is_verified_resolution: true,
      counts_as_closed: true,
      resolved_by_reviewer: false,
    }),
  );
  assert.equal(agreed.stateKey, "resolution.state_confirmed");
});
