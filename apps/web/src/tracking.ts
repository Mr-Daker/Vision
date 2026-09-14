/**
 * Tracking and discovery view models (roadmap V030).
 *
 * Pure: an API payload in, exactly what should appear on screen out. No DOM,
 * no fetch, no clock — so the wording that carries this task's honesty
 * obligations can be tested directly.
 *
 * The recurring risk is a number that reads as more than it is:
 *
 *  - a count of people who **reported** is not a count of people **affected**;
 *  - complaint entries and contributors are two different facts and get two
 *    different sentences;
 *  - an empty list of nearby issues means the bounded search found none, not
 *    that nothing is wrong nearby;
 *  - a photograph appears only through an approved derivative, and when one
 *    does not exist the reader is told why rather than shown a blank.
 */

export type ReportPayload = {
  readonly submission_id: string;
  readonly submitted_at: string;
  readonly observed_at: string;
  readonly status_label: string;
  readonly issue_public_reference: string | null;
  readonly issue_status: string | null;
  readonly evidence_count: number;
  /** The candidate issue this report is waiting for an answer about (V031). */
  readonly awaiting_answer_for_issue_id?: string | null;
};

export type ReportRow = {
  readonly submissionId: string;
  readonly submittedAt: string;
  readonly observedAt: string;
  readonly statusLabel: string;
  readonly reference: string | undefined;
  readonly hasIssue: boolean;
  readonly evidenceCount: number;
  /**
   * Present when this report has an open confirm/reject question (V031).
   *
   * Carried through so the list can offer the question. Before this the
   * question existed server-side with nothing in the interface able to reach
   * it.
   */
  readonly awaitingAnswerForIssueId: string | undefined;
};

/** Server order is kept: it is "newest first" and the client must not re-sort. */
export const toReportRows = (payload: readonly ReportPayload[]): readonly ReportRow[] =>
  payload.map((item) => ({
    submissionId: item.submission_id,
    submittedAt: item.submitted_at,
    observedAt: item.observed_at,
    statusLabel: item.status_label,
    reference: item.issue_public_reference ?? undefined,
    hasIssue: item.issue_public_reference !== null,
    evidenceCount: item.evidence_count,
    awaitingAnswerForIssueId: item.awaiting_answer_for_issue_id ?? undefined,
  }));

export type DiscoveredPayload = {
  readonly public_reference: string;
  readonly category: string;
  readonly current_status: string;
  readonly coarse_location: { readonly lon: number; readonly lat: number } | null;
  readonly counted_participants: number;
  readonly approved_derivative_references: readonly string[];
  readonly last_evidence_at: string | null;
};

export type DiscoveryPayload = {
  readonly issues: readonly DiscoveredPayload[];
  readonly next_cursor: string | null;
  readonly applied_limit: number;
  readonly applied_filters: { readonly category: string | null; readonly radius_m: number };
  readonly note: string;
};

export type DiscoveryRow = {
  readonly reference: string;
  readonly category: string;
  readonly status: string;
  readonly coarseLocation: { readonly lon: number; readonly lat: number } | undefined;
  readonly participantsLabel: string;
  readonly lastEvidenceAt: string | undefined;
};

export type DiscoveryView = {
  readonly issues: readonly DiscoveryRow[];
  readonly isEmpty: boolean;
  readonly emptyMessage: string;
  readonly boundsLabel: string;
  /** The radius the server actually applied, never a client-side assumption. */
  readonly radiusMetres: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | undefined;
};

/**
 * "Reported", never "affected".
 *
 * Singular and plural are separate strings rather than a bracketed "(s)",
 * because "1 people reported this" is the kind of detail that makes a reader
 * distrust everything else on the page.
 */
/**
 * How many people's contributions are counted on an issue.
 *
 * Zero gets its own wording, because "0 people reported this" is a statement
 * the interface knows to be false: the issue exists *because* somebody
 * reported it. What zero actually means is that no contribution has been
 * counted — counting one needs `demo_processing` consent (V014), and nothing
 * records that consent yet (V044 owns the capture notices), so zero is the
 * ordinary case today rather than an edge one.
 *
 * The distinction matters beyond tidiness: a reader who sees "0 people
 * reported this" on a real problem learns that the numbers here are wrong, and
 * stops believing the ones that are right.
 */
const participantsLabel = (count: number): string => {
  if (count === 0) return "No contribution has been counted on this report yet";
  return count === 1 ? "1 person reported this" : `${String(count)} people reported this`;
};

export const toDiscoveryView = (payload: DiscoveryPayload): DiscoveryView => {
  const filters = payload.applied_filters;
  const categoryPart = filters.category === null ? "" : `, category ${filters.category}`;

  return {
    issues: payload.issues.map((issue) => ({
      reference: issue.public_reference,
      category: issue.category,
      status: issue.current_status,
      coarseLocation: issue.coarse_location ?? undefined,
      participantsLabel: participantsLabel(issue.counted_participants),
      lastEvidenceAt: issue.last_evidence_at ?? undefined,
    })),
    isEmpty: payload.issues.length === 0,
    // The server's own note travels through, because it is the sentence that
    // stops an empty result being read as an all-clear.
    emptyMessage: `Nothing was found within the area searched. ${payload.note}`,
    boundsLabel: `Searched within ${String(filters.radius_m)} m${categoryPart}, up to ${String(payload.applied_limit)} results`,
    radiusMetres: filters.radius_m,
    hasMore: payload.next_cursor !== null,
    nextCursor: payload.next_cursor ?? undefined,
  };
};

// ---------------------------------------------------------------------------
// Nearby coordinate map (roadmap V030)
// ---------------------------------------------------------------------------

/** Approximate metres in one latitude degree over the demonstration extent. */
const METRES_PER_DEGREE_LATITUDE = 111_320;

/** Keep marker centres away from the edge so their 44px hit areas stay usable. */
const MAP_EDGE_INSET_PERCENT = 8;

export type DiscoveryMapMarker = {
  readonly index: number;
  readonly reference: string;
  readonly category: string;
  readonly status: string;
  readonly leftPercent: number;
  readonly topPercent: number;
};

export type DiscoveryMapView = {
  readonly markers: readonly DiscoveryMapMarker[];
  readonly totalIssues: number;
  readonly missingPublicLocationCount: number;
  readonly outsideDisplayedExtentCount: number;
};

/**
 * Places public, deliberately coarsened issue locations around the search
 * centre. This is a coordinate plot, not a street map: every marker is based
 * on a location the public API actually returned and no road or building is
 * invented behind it.
 */
export const toDiscoveryMapView = (
  issues: readonly DiscoveryRow[],
  origin: { readonly lon: number; readonly lat: number },
  radiusMetres: number,
): DiscoveryMapView => {
  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) {
    return {
      markers: [],
      totalIssues: issues.length,
      missingPublicLocationCount: issues.filter((issue) => issue.coarseLocation === undefined)
        .length,
      outsideDisplayedExtentCount: 0,
    };
  }

  const usableHalf = 50 - MAP_EDGE_INSET_PERCENT;
  const metresPerDegreeLongitude =
    METRES_PER_DEGREE_LATITUDE * Math.cos((origin.lat * Math.PI) / 180);
  let missingPublicLocationCount = 0;
  let outsideDisplayedExtentCount = 0;
  const markers: DiscoveryMapMarker[] = [];

  for (const [issueIndex, issue] of issues.entries()) {
    const place = issue.coarseLocation;
    if (place === undefined) {
      missingPublicLocationCount += 1;
      continue;
    }

    const eastMetres = (place.lon - origin.lon) * metresPerDegreeLongitude;
    const northMetres = (place.lat - origin.lat) * METRES_PER_DEGREE_LATITUDE;
    if (Math.abs(eastMetres) > radiusMetres || Math.abs(northMetres) > radiusMetres) {
      // The server searched using the private precise location but publishes a
      // rounded one. Rounding can move the public point just outside this
      // square; omitting it with a disclosure is more honest than pinning it
      // falsely to the edge.
      outsideDisplayedExtentCount += 1;
      continue;
    }

    markers.push({
      // Matches the visible result-list number, including when an earlier row
      // has no publishable location and therefore has no marker.
      index: issueIndex + 1,
      reference: issue.reference,
      category: issue.category,
      status: issue.status,
      leftPercent: 50 + (eastMetres / radiusMetres) * usableHalf,
      topPercent: 50 - (northMetres / radiusMetres) * usableHalf,
    });
  }

  return {
    markers,
    totalIssues: issues.length,
    missingPublicLocationCount,
    outsideDisplayedExtentCount,
  };
};

// ---------------------------------------------------------------------------
// Receipt lookup (roadmap V030)
// ---------------------------------------------------------------------------

const RECEIPT_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Empty or malformed references are refused before a network request. */
export const normalizeReceiptReference = (value: string): string | undefined => {
  const normalized = value.trim().toLowerCase();
  return RECEIPT_REFERENCE_PATTERN.test(normalized) ? normalized : undefined;
};

export type ReceiptPayload = {
  readonly submission_id: string;
  readonly processing_status: string;
  readonly server_received_at: string;
  readonly replayed: boolean;
};

export type ReceiptLookupView = {
  readonly reference: string;
  readonly status: string;
  readonly receivedAt: string;
  readonly wasReplay: boolean;
};

/** Keeps the screen bound to server-returned receipt facts only. */
export const toReceiptLookupView = (receipt: ReceiptPayload): ReceiptLookupView => ({
  reference: receipt.submission_id,
  status: receipt.processing_status,
  receivedAt: receipt.server_received_at,
  wasReplay: receipt.replayed,
});

export type DetailEvidencePayload = {
  readonly media_type: string;
  readonly content_text: string | null;
  readonly derivative_reference: string | null;
  readonly viewable: boolean;
  readonly why_not_viewable: string | null;
  readonly ingested_at: string;
};

export type DetailPayload = {
  readonly public_reference: string;
  readonly category: string;
  readonly current_status: string;
  readonly opened_at: string;
  readonly last_evidence_at: string | null;
  readonly coarse_location: { readonly lon: number; readonly lat: number } | null;
  readonly counted_participants: number;
  readonly complaint_entries: number;
  readonly evidence: readonly DetailEvidencePayload[];
  readonly infrastructure_history: readonly { readonly at: string; readonly what: string }[];
  readonly infrastructure_history_note: string;
  readonly assignment: { readonly is_live: boolean; readonly note: string };
  readonly resolution: { readonly is_live: boolean; readonly note: string };
  readonly disclosures: readonly string[];
};

export type DetailEvidenceRow = {
  readonly mediaType: string;
  readonly text: string | undefined;
  readonly showImage: boolean;
  readonly imageSource: string | undefined;
  readonly note: string | undefined;
  readonly ingestedAt: string;
};

export type DetailView = {
  readonly reference: string;
  readonly category: string;
  readonly status: string;
  readonly openedAt: string;
  readonly lastEvidenceAt: string | undefined;
  readonly coarseLocation: { readonly lon: number; readonly lat: number } | undefined;
  readonly participantsLabel: string;
  readonly entriesLabel: string;
  readonly evidence: readonly DetailEvidenceRow[];
  readonly hasInfrastructureHistory: boolean;
  readonly infrastructureHistory: readonly { readonly at: string; readonly what: string }[];
  readonly infrastructureHistoryNote: string;
  readonly assignment: { readonly isLive: boolean; readonly note: string };
  readonly resolution: { readonly isLive: boolean; readonly note: string };
  readonly disclosures: readonly string[];
};

const entriesLabel = (count: number): string =>
  count === 1
    ? "1 report entry has been attached to this issue"
    : `${String(count)} report entries have been attached to this issue`;

const MISSING_DISCLOSURES =
  "The notes about what is simulated or uncertain could not be loaded, so treat everything on this page as unconfirmed.";

export const toDetailView = (payload: DetailPayload): DetailView => ({
  reference: payload.public_reference,
  category: payload.category,
  status: payload.current_status,
  openedAt: payload.opened_at,
  lastEvidenceAt: payload.last_evidence_at ?? undefined,
  coarseLocation: payload.coarse_location ?? undefined,
  participantsLabel: participantsLabel(payload.counted_participants),
  entriesLabel: entriesLabel(payload.complaint_entries),
  evidence: payload.evidence.map((item) => {
    // An image source is built only from a derivative reference. There is no
    // branch here that could produce a path into `originals/`, which is the
    // point: a private original has no route to a reader's browser.
    const derivative = item.derivative_reference;
    const showImage = item.viewable && derivative !== null && derivative.startsWith("derivatives/");
    return {
      mediaType: item.media_type,
      text: item.content_text ?? undefined,
      showImage,
      imageSource: showImage ? `/v1/media/${derivative ?? ""}` : undefined,
      note: item.why_not_viewable ?? undefined,
      ingestedAt: item.ingested_at,
    };
  }),
  hasInfrastructureHistory: payload.infrastructure_history.length > 0,
  infrastructureHistory: payload.infrastructure_history,
  infrastructureHistoryNote: payload.infrastructure_history_note,
  assignment: { isLive: payload.assignment.is_live, note: payload.assignment.note },
  resolution: { isLive: payload.resolution.is_live, note: payload.resolution.note },
  // A page with no disclosures has either lost them in transit or is claiming
  // more certainty than the system has. Substituting a warning is the safe
  // reading; rendering nothing is not.
  disclosures: payload.disclosures.length > 0 ? payload.disclosures : [MISSING_DISCLOSURES],
});

// ---------------------------------------------------------------------------
// Discovery's category filter (roadmap V030)
// ---------------------------------------------------------------------------

export type TaxonomyPayload = {
  readonly taxonomy_version: string;
  readonly categories: readonly { readonly id: string; readonly label: string }[];
  readonly note: string;
  readonly label_language: string;
  readonly label_note: string;
};

export type CategoryOption = {
  readonly value: string;
  readonly label: string;
};

export type CategoryOptionsView = {
  readonly options: readonly CategoryOption[];
  /**
   * Present only when the labels are not in the page's language.
   *
   * A Marathi page showing English category names has to say so. And it is
   * `undefined` on an English page on purpose: "these are in English" on an
   * English page is noise, and noise teaches people to skip the disclosures
   * that matter.
   */
  readonly languageDisclosure: string | undefined;
  readonly taxonomyVersion: string;
};

/**
 * Builds the discovery filter's options from the taxonomy the server serves.
 *
 * V030 recorded that the filter "is populated with no options until a taxonomy
 * pack is loaded, so it currently shows only 'All categories'". The pack now
 * exists (V023) and `/v1/taxonomy` serves it.
 *
 * Two details that are not incidental:
 *
 *  * The "all" option stays first and keeps an empty value, so clearing the
 *    filter is always reachable — including when the taxonomy is empty, where
 *    the alternative is a select with no options, which is a dead control.
 *  * Only `categories` is read. A citizen is never asked to classify (V018
 *    §2), so a defect identifier must never become something to pick from,
 *    even if a future server started sending them.
 */
export const toCategoryOptions = (
  payload: TaxonomyPayload,
  allLabel: string,
  pageLanguage?: string,
): CategoryOptionsView => {
  const options: CategoryOption[] = [
    { value: "", label: allLabel },
    ...payload.categories.map((category) => ({ value: category.id, label: category.label })),
  ];

  const labelsAreInPageLanguage =
    pageLanguage === undefined || pageLanguage === payload.label_language;

  return {
    options,
    languageDisclosure: labelsAreInPageLanguage ? undefined : payload.label_note,
    taxonomyVersion: payload.taxonomy_version,
  };
};

// ---------------------------------------------------------------------------
// The citizen confirm/reject question (roadmap V031)
// ---------------------------------------------------------------------------

export type CandidatePayload = {
  readonly candidate: {
    readonly public_reference: string;
    readonly category: string;
    readonly opened_at: string;
    readonly last_evidence_at: string | null;
    readonly coarse_location: { readonly lon: number; readonly lat: number } | null;
    readonly distance_metres: number | null;
    readonly counted_participants: number;
    readonly entry_count: number;
    readonly preview_derivatives: readonly string[];
  };
  readonly resolved_through_alias: boolean;
};

export type CandidateView = {
  /** The one question being asked. Deliberately not about category. */
  readonly question: string;
  readonly summary: string;
  readonly participantsLabel: string;
  readonly distanceLabel: string | undefined;
  readonly openedLabel: string;
  readonly confirmLabel: string;
  readonly rejectLabel: string;
  readonly confirmConsequence: string;
  readonly rejectConsequence: string;
  /** Present when a merge retired the reference the citizen was shown. */
  readonly aliasNote: string | undefined;
  readonly previewReferences: readonly string[];
};

/**
 * Builds the confirm/reject screen (roadmap V031).
 *
 * V031 recorded "**No citizen screen.** The endpoints and the read model are
 * tested, but `apps/web` does not yet render the confirm/reject question ... A
 * citizen cannot reach it without calling the API directly."
 *
 * The wording here is the deliverable, not decoration:
 *
 *  * **One question: is this the same problem?** Not whether the category is
 *    right and not which department owns it. V018 §2 is explicit that a
 *    citizen is never asked to classify, and a screen that slipped a category
 *    question in beside this one would put the burden straight back.
 *  * **A count of others is a count.** Three people reporting a problem is
 *    three reports; it is not three people agreeing with this reporter, and it
 *    corroborates nothing either of them said.
 *  * **Rejecting is an equal choice.** No warnings, no "are you sure". A
 *    hedged reject button teaches the reader that disagreeing is the difficult
 *    path, and the question stops being a real question.
 *  * **Distance is approximate.** It is between two reported positions, each
 *    with its own accuracy, so it is stated as "about N m" and omitted
 *    entirely when unknown — "0 m" would read as "the same spot", the opposite
 *    of "we do not know".
 */
/**
 * Formats a coarse position for reading.
 *
 * The server sends `{lon, lat}`, already coarsened. Interpolating the object
 * straight into a sentence printed "near [object Object]" — found by opening
 * the page, not by a test, because the test had used a string. Kept to three
 * decimal places because that is the precision the server publishes; adding
 * digits here would invent precision it deliberately removed.
 */
const coarsePlace = (place: { readonly lon: number; readonly lat: number }): string =>
  `${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}`;

export const toCandidateView = (payload: CandidatePayload): CandidateView => {
  const candidate = payload.candidate;
  const others = candidate.counted_participants;

  return {
    question: "Is this the same problem you are reporting?",
    summary: `${candidate.public_reference}, first reported ${candidate.opened_at.slice(0, 10)}${
      candidate.coarse_location === null ? "" : `, near ${coarsePlace(candidate.coarse_location)}`
    }`,
    // "reported this" and not "agreed": see the note above.
    participantsLabel:
      others === 1 ? "1 person reported this" : `${String(others)} people reported this`,
    distanceLabel:
      candidate.distance_metres === null
        ? undefined
        : `about ${String(Math.round(candidate.distance_metres))} m from where you reported`,
    openedLabel: `First reported ${candidate.opened_at.slice(0, 10)}`,
    confirmLabel: "Yes, it is the same problem",
    rejectLabel: "No, it is a different problem",
    confirmConsequence:
      "Your report is added to this one. Your entry stays yours, and it is counted once.",
    rejectConsequence:
      "Your report stays separate and gets its own reference. Nothing you sent is deleted.",
    aliasNote: payload.resolved_through_alias
      ? "This report was merged with another one, so the reference shown here may differ from the one you saw earlier. Nothing was removed."
      : undefined,
    previewReferences: candidate.preview_derivatives,
  };
};

// ---------------------------------------------------------------------------
// V035 — repair claims, confirmation, dispute and reopening
//
// Pure shaping only. What this file decides is which *string key* an interface
// should render for a state, never the sentence itself — so the vocabulary
// stays in the locale packs and a Marathi reader is not shown English.
//
// The one rule these types exist to protect: `resolution_claimed` is a claim.
// `isVerifiedResolution` comes from the server and is never derived from a
// status name here, so no amount of editing this file can make a claim read as
// a finished repair.
// ---------------------------------------------------------------------------

export type ResolutionEvidencePayload = {
  readonly media_type: string;
  readonly derivative_reference: string | null;
  readonly viewable: boolean;
  readonly why_not_viewable: string | null;
};

export type ResolutionHistoryPayload = {
  readonly at: string;
  readonly kind: string;
  readonly what: string;
  readonly comment: string | null;
  readonly by_reviewer: boolean;
};

export type ResolutionPayload = {
  readonly issue_status: string;
  readonly claim: {
    readonly claimed_at: string;
    readonly description: string;
    readonly completion_evidence: readonly ResolutionEvidencePayload[];
  } | null;
  readonly confirmation_policy_version: string;
  readonly required_confirmations: number;
  readonly confirmations_recorded: number;
  readonly disputes_recorded: number;
  readonly confirmation_status: string;
  readonly is_verified_resolution: boolean;
  readonly counts_as_closed: boolean;
  readonly resolved_by_reviewer: boolean;
  readonly requires_qualified_inspection: boolean;
  readonly may_respond: boolean;
  readonly may_respond_blocked_by: string | null;
  readonly may_reopen: boolean;
  readonly history: readonly ResolutionHistoryPayload[];
  readonly disclosures: readonly string[];
};

/** Which locale key describes the state. Never "verified" for a claim. */
export type ResolutionStateKey =
  | "resolution.state_claimed"
  | "resolution.state_confirmed"
  | "resolution.state_confirmed_by_reviewer"
  | "resolution.state_disputed"
  | "resolution.state_reopened";

export type ResolutionBlockedKey =
  | "resolution.blocked_not_participant"
  | "resolution.blocked_already_answered"
  | "resolution.blocked_no_claim"
  | "resolution.blocked_policy";

export type ResolutionEvidenceRow = {
  readonly derivativeReference: string | undefined;
  readonly viewable: boolean;
  /** The server's own sentence, which says why nothing may be shown. */
  readonly whyNotViewable: string | undefined;
};

export type ResolutionView = {
  readonly hasClaim: boolean;
  readonly stateKey: ResolutionStateKey;
  readonly claimedAt: string | undefined;
  readonly description: string | undefined;
  readonly evidence: readonly ResolutionEvidenceRow[];
  readonly requiredConfirmations: number;
  readonly confirmationsRecorded: number;
  readonly disputesRecorded: number;
  readonly policyVersion: string;
  /** True only for a standing confirmed resolution, straight from the server. */
  readonly isVerifiedResolution: boolean;
  readonly requiresQualifiedInspection: boolean;
  readonly mayRespond: boolean;
  readonly blockedKey: ResolutionBlockedKey | undefined;
  readonly mayReopen: boolean;
  readonly history: readonly {
    readonly at: string;
    readonly what: string;
    readonly comment: string | undefined;
  }[];
};

const BLOCKED_KEYS: Readonly<Record<string, ResolutionBlockedKey>> = {
  not_a_counted_participant: "resolution.blocked_not_participant",
  already_answered: "resolution.blocked_already_answered",
  no_claim_awaiting_an_answer: "resolution.blocked_no_claim",
  policy_excludes_citizens: "resolution.blocked_policy",
};

/**
 * The state sentence, chosen from the lifecycle status.
 *
 * `resolution_claimed` maps to the *claimed* key and nothing else. A default
 * that fell through to "confirmed" would be the single worst bug this screen
 * could have, so the fallback is the claim wording, which overstates nothing.
 */
const stateKeyFor = (status: string, resolvedByReviewer: boolean): ResolutionStateKey => {
  if (status === "resolution_confirmed") {
    // A reviewer override is still a confirmed resolution, but telling the
    // person who disputed it that "people agreed" would be false to their
    // face. They get the sentence that says what actually happened.
    return resolvedByReviewer
      ? "resolution.state_confirmed_by_reviewer"
      : "resolution.state_confirmed";
  }
  if (status === "resolution_disputed") return "resolution.state_disputed";
  if (status === "reopened") return "resolution.state_reopened";
  return "resolution.state_claimed";
};

export const toResolutionView = (payload: ResolutionPayload): ResolutionView => ({
  hasClaim: payload.claim !== null,
  stateKey: stateKeyFor(payload.issue_status, payload.resolved_by_reviewer === true),
  claimedAt: payload.claim?.claimed_at,
  description: payload.claim?.description,
  evidence: (payload.claim?.completion_evidence ?? []).map((item) => ({
    derivativeReference: item.derivative_reference ?? undefined,
    viewable: item.viewable,
    whyNotViewable: item.why_not_viewable ?? undefined,
  })),
  requiredConfirmations: payload.required_confirmations,
  confirmationsRecorded: payload.confirmations_recorded,
  disputesRecorded: payload.disputes_recorded,
  policyVersion: payload.confirmation_policy_version,
  isVerifiedResolution: payload.is_verified_resolution,
  requiresQualifiedInspection: payload.requires_qualified_inspection,
  mayRespond: payload.may_respond,
  blockedKey:
    payload.may_respond_blocked_by === null
      ? undefined
      : BLOCKED_KEYS[payload.may_respond_blocked_by],
  mayReopen: payload.may_reopen,
  history: payload.history.map((entry) => ({
    at: entry.at,
    what: entry.what,
    comment: entry.comment ?? undefined,
  })),
});
