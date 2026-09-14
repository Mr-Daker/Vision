/**
 * Citizen tracking and discovery read models (roadmap V030).
 *
 * Two obligations pull against each other and both must hold.
 *
 * A citizen must be able to return to their own report **without keeping a
 * secret link**, so every private view is bound to the participant behind the
 * session. A submission id is not a bearer token: holding one grants nothing.
 *
 * A stranger must be able to discover nearby public issues **without learning
 * anything private**, so the public shape comes from the V015 projection
 * (`toPublicIssueView`) rather than being assembled field by field here. The
 * public location is deliberately coarsened: a precise pin on a public map can
 * be walked back to a reporter's doorstep.
 *
 * The read side is also where uncertainty either stays visible or quietly
 * disappears. Every view carries what is uncertain, what is simulated and what
 * is still a fixture, because a summary that looks more confident than the
 * data behind it is worse than no summary.
 *
 * Paging is by **cursor**, not offset: with an offset, a row inserted between
 * two pages makes a citizen see the same report twice.
 */

import { toPublicIssueView, type IssueRecord } from "@vision/domain";

import type { Queryable } from "./outbox.ts";

export const MY_REPORTS_PAGE_LIMIT = 20;
export const DISCOVERY_PAGE_LIMIT = 50;
export const DEFAULT_DISCOVERY_RADIUS_METRES = 2_000;

/** Decimal places kept in a public location. Three is roughly 110 m here. */
const COARSE_DECIMALS = 3;

const coarsen = (value: number): number => Number(value.toFixed(COARSE_DECIMALS));

const clamp = (requested: number | undefined, ceiling: number): number => {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) return ceiling;
  return Math.min(Math.floor(requested), ceiling);
};

/**
 * Opaque cursor over a compound sort key.
 *
 * Two parts, because a timestamp alone is not unique — two reports submitted
 * in the same instant would make one of them unreachable or repeated.
 *
 * The value is also compared as a **typed** tuple in SQL, never as text. An
 * earlier version compared `server_received_at::text`, and PostgreSQL trims
 * trailing zeros from a timestamp, so "…:00.1" sorts before "…:00.12" as a
 * string while being *later* as a time. Pages then overlapped.
 */
const encodeCursor = (parts: readonly string[]): string =>
  Buffer.from(parts.join("\u0000"), "utf8").toString("base64url");

const decodeCursor = (cursor: string | undefined): readonly string[] | undefined =>
  cursor === undefined
    ? undefined
    : Buffer.from(cursor, "base64url").toString("utf8").split("\u0000");

// ---------------------------------------------------------------------------
// My Reports
// ---------------------------------------------------------------------------

export type MyReport = {
  readonly submissionId: string;
  readonly submittedAt: string;
  readonly observedAt: string;
  readonly statusLabel: string;
  readonly issuePublicReference: string | undefined;
  readonly issueStatus: string | undefined;
  readonly evidenceCount: number;
  /**
   * The candidate issue this report is waiting for an answer about (V031).
   *
   * `undefined` when there is no open question — which is the ordinary case.
   * Present only for an `ambiguous` match that is neither superseded nor
   * already decided.
   */
  readonly awaitingAnswerForIssueId: string | undefined;
};

export type MyReportsPage = {
  readonly reports: readonly MyReport[];
  readonly nextCursor: string | undefined;
};

/**
 * Plain-language status for a citizen, not an internal state name.
 *
 * "received" is a real state and must not be dressed up as progress; a report
 * with no issue yet is exactly that, and saying so is more honest than an
 * encouraging label.
 */
const statusLabelFor = (issueStatus: string | undefined): string =>
  issueStatus === undefined
    ? "Received and not yet grouped with an issue"
    : `Grouped with an issue (${issueStatus.replace(/_/g, " ")})`;

export const listMyReports = async (
  tx: Queryable,
  options: {
    readonly participantId: string;
    readonly limit?: number;
    readonly cursor?: string | undefined;
  },
): Promise<MyReportsPage> => {
  const limit = clamp(options.limit, MY_REPORTS_PAGE_LIMIT);
  const cursor = decodeCursor(options.cursor);

  const { rows } = await tx.query(
    `select
        s.submission_id,
        s.server_received_at,
        -- Also selected as text, and used as the cursor key. The driver parses
        -- a timestamptz into a JS Date, which holds milliseconds while the
        -- column holds microseconds, so a cursor built from the parsed value
        -- silently skips rows inside the same millisecond. Text out, cast back
        -- in SQL, no precision lost anywhere.
        s.server_received_at::text as received_cursor,
        s.observed_at,
        i.public_reference,
        i.current_status,
        (select count(*)::int from evidence_item e
          where e.submission_id = s.submission_id and e.privacy_state = 'active') as evidence_count,
        -- V031: the question waiting for this reporter, if there is one.
        --
        -- Only an ambiguous match that has not been superseded and has no
        -- decision yet. A superseded proposal would ask about a candidate the
        -- matcher has already discarded, and a decided one would make the
        -- citizen's earlier answer look as though it had not registered.
        (select m.candidate_issue_ids[1]
           from issue_match m
          where m.submission_id = s.submission_id
            and m.state = 'ambiguous'
            and m.superseded_at is null
            and m.decided_at is null
          order by m.match_id asc
          limit 1) as awaiting_answer_issue_id
       from submission s
       left join issue_evidence_link link
              on link.effective_to is null
             and link.evidence_id in (select evidence_id from evidence_item
                                       where submission_id = s.submission_id)
       left join canonical_issue i on i.issue_id = link.canonical_issue_id
      where s.participant_id = $1
        and s.privacy_state = 'active'
        and (
          $3::timestamptz is null
          or (s.server_received_at, s.submission_id) < ($3::timestamptz, $4::uuid)
        )
      group by s.submission_id, s.server_received_at, s.observed_at,
               i.public_reference, i.current_status
      order by s.server_received_at desc, s.submission_id desc
      limit $2`,
    [options.participantId, limit + 1, cursor?.[0] ?? null, cursor?.[1] ?? null],
  );

  const kept = rows.slice(0, limit);
  const last = kept.at(-1);
  return {
    reports: kept.map((row) => {
      const issueStatus =
        row["current_status"] === null ? undefined : String(row["current_status"]);
      return {
        submissionId: String(row["submission_id"]),
        submittedAt: new Date(String(row["server_received_at"])).toISOString(),
        observedAt: new Date(String(row["observed_at"])).toISOString(),
        statusLabel: statusLabelFor(issueStatus),
        issuePublicReference:
          row["public_reference"] === null ? undefined : String(row["public_reference"]),
        issueStatus,
        evidenceCount: Number(row["evidence_count"] ?? 0),
        awaitingAnswerForIssueId:
          row["awaiting_answer_issue_id"] === null || row["awaiting_answer_issue_id"] === undefined
            ? undefined
            : String(row["awaiting_answer_issue_id"]),
      };
    }),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor([String(last["received_cursor"]), String(last["submission_id"])])
        : undefined,
  };
};

/**
 * Resolves one of the citizen's own receipts.
 *
 * Scoped to the participant on purpose: a submission id appears in a receipt a
 * citizen may screenshot or forward, and it must not become a credential for
 * whoever ends up holding it.
 */
export const lookupReceipt = async (
  tx: Queryable,
  options: { readonly participantId: string; readonly submissionId: string },
): Promise<MyReport | undefined> => {
  const page = await listMyReports(tx, { participantId: options.participantId, limit: 100 });
  return page.reports.find((report) => report.submissionId === options.submissionId);
};

// ---------------------------------------------------------------------------
// Public discovery
// ---------------------------------------------------------------------------

export type DiscoveredIssue = {
  readonly publicReference: string;
  readonly category: string;
  readonly currentStatus: string;
  readonly coarseLocation: { readonly lon: number; readonly lat: number } | undefined;
  readonly countedParticipants: number;
  readonly approvedDerivativeReferences: readonly string[];
  readonly lastEvidenceAt: string | undefined;
};

export type DiscoveryPage = {
  readonly issues: readonly DiscoveredIssue[];
  readonly nextCursor: string | undefined;
  readonly appliedLimit: number;
  readonly appliedFilters: {
    readonly category: string | undefined;
    readonly radiusMetres: number;
  };
  readonly note: string;
};

const DISCOVERY_NOTE =
  "this is a bounded search by radius and page size; nothing was found outside those bounds rather than nothing existing";

export const discoverNearbyIssues = async (
  tx: Queryable,
  options: {
    readonly lon: number;
    readonly lat: number;
    readonly radiusMetres?: number;
    readonly category?: string | undefined;
    readonly limit?: number;
    readonly cursor?: string | undefined;
  },
): Promise<DiscoveryPage> => {
  const limit = clamp(options.limit, DISCOVERY_PAGE_LIMIT);
  const radiusMetres = options.radiusMetres ?? DEFAULT_DISCOVERY_RADIUS_METRES;
  const cursor = decodeCursor(options.cursor);

  const { rows } = await tx.query(
    `select
        i.issue_id,
        i.public_reference,
        i.category,
        i.current_status,
        i.jurisdiction_id,
        i.last_evidence_at,
        ST_X(i.representative_location::geometry) as lon,
        ST_Y(i.representative_location::geometry) as lat,
        (select count(*)::int from issue_participation p
          where p.canonical_issue_id = i.issue_id and p.counted = true) as counted,
        (select coalesce(array_agg(e.derivative_reference), '{}')
           from issue_evidence_link link
           join evidence_item e on e.evidence_id = link.evidence_id
          where link.canonical_issue_id = i.issue_id
            and link.effective_to is null
            and e.derivative_reference is not null
            -- Redundant with evidence_item_derivative_needs_approval_ck, which
            -- makes "a derivative without an approved redaction" impossible to
            -- store. Kept as the statement of intent; the constraint is what
            -- the test pins, because no test can distinguish this filter.
            and e.redaction_status in ('approved','not_required')
            and e.privacy_state = 'active') as derivatives
       from canonical_issue i
      where i.representative_location is not null
        and ST_DWithin(i.representative_location,
                       ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)
        and ($5::text is null or i.category = $5)
        and ($6::text is null or i.public_reference > $6)
        -- Retired by a merge: its reference still resolves, but it must not
        -- appear twice in a public list alongside its survivor.
        and not exists (select 1 from issue_alias a
                         where a.source_issue_id = i.issue_id and a.valid_to is null)
      order by i.public_reference asc
      limit $4`,
    [
      options.lon,
      options.lat,
      radiusMetres,
      limit + 1,
      options.category ?? null,
      cursor?.[0] ?? null,
    ],
  );

  const kept = rows.slice(0, limit);
  const last = kept.at(-1);

  const issues = kept.map((row) => {
    // Built through the V015 projection so a private field cannot be added
    // here by accident: anything not in `PublicIssueView` is dropped.
    const record: IssueRecord = {
      issue_id: String(row["issue_id"]),
      public_reference: String(row["public_reference"]),
      category: String(row["category"]),
      current_status: String(row["current_status"]),
      jurisdiction_id: row["jurisdiction_id"] === null ? "" : String(row["jurisdiction_id"]),
      precise_location: { lon: Number(row["lon"]), lat: Number(row["lat"]) },
      coarse_location: { lon: coarsen(Number(row["lon"])), lat: coarsen(Number(row["lat"])) },
      counted_participants: Number(row["counted"] ?? 0),
      approved_derivative_references: (row["derivatives"] as string[] | null) ?? [],
    };
    const view = toPublicIssueView(record);
    return {
      publicReference: view.public_reference,
      category: view.category,
      currentStatus: view.current_status,
      coarseLocation: view.coarse_location,
      countedParticipants: view.counted_participants,
      approvedDerivativeReferences: view.approved_derivative_references,
      lastEvidenceAt:
        row["last_evidence_at"] === null
          ? undefined
          : new Date(String(row["last_evidence_at"])).toISOString(),
    };
  });

  return {
    issues,
    // `public_reference` is unique, so it is a complete sort key on its own.
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor([String(last["public_reference"])])
        : undefined,
    appliedLimit: limit,
    appliedFilters: { category: options.category, radiusMetres },
    note: DISCOVERY_NOTE,
  };
};

// ---------------------------------------------------------------------------
// Issue detail
// ---------------------------------------------------------------------------

export type DetailEvidence = {
  readonly mediaType: string;
  readonly contentText: string | undefined;
  readonly derivativeReference: string | undefined;
  /** False whenever there is nothing a reader may legitimately be shown. */
  readonly viewable: boolean;
  readonly whyNotViewable: string | undefined;
  readonly ingestedAt: string;
};

/**
 * Whether a workflow is actually running behind this field.
 *
 * `isLive` was the literal `false` while V034 and V035 existed only as
 * services. Both now write real events, so this reports what is true for the
 * issue in hand rather than a constant — and a reader is told which.
 */
export type WorkflowLiveness = {
  readonly isLive: boolean;
  readonly note: string;
};

/** @deprecated Kept as an alias while callers move to {@link WorkflowLiveness}. */
export type NotYetLive = WorkflowLiveness;

export type IssueDetail = {
  readonly publicReference: string;
  readonly category: string;
  readonly currentStatus: string;
  readonly openedAt: string;
  readonly lastEvidenceAt: string | undefined;
  readonly coarseLocation: { readonly lon: number; readonly lat: number } | undefined;
  readonly countedParticipants: number;
  /** Complaint entries, which is not the same number as people. */
  readonly complaintEntries: number;
  readonly evidence: readonly DetailEvidence[];
  /** Recorded events about the asset itself. Empty until V040 supplies them. */
  readonly infrastructureHistory: readonly { readonly at: string; readonly what: string }[];
  readonly infrastructureHistoryNote: string;
  readonly assignment: WorkflowLiveness;
  readonly resolution: WorkflowLiveness;
  readonly disclosures: readonly string[];
};

/** The V035 sentence, kept identical to the one the domain emits. */
const NOT_A_CERTIFICATION =
  "a confirmed repair here means people agreed the problem looks fixed; it is not an inspection, not an engineer's certification, and not a guarantee the repair is permanent";

const HISTORY_NOTE =
  "infrastructure history means recorded events about the asset itself and is separate from complaint entries; two reports by one person are two entries, not two events";

/**
 * Resolves an issue by its public reference.
 *
 * The public reference is the only address a reader is given, and it stays
 * resolvable after a merge retires the issue — a citizen holding a reference
 * from a receipt must not hit a dead end (V003 CanonicalIssue).
 */
export const findIssueIdByReference = async (
  tx: Queryable,
  publicReference: string,
): Promise<string | undefined> => {
  const { rows } = await tx.query(
    "select issue_id from canonical_issue where public_reference = $1",
    [publicReference],
  );
  return rows[0] === undefined ? undefined : String(rows[0]["issue_id"]);
};

export const getIssueDetail = async (
  tx: Queryable,
  options: { readonly issueId: string },
): Promise<IssueDetail | undefined> => {
  const { rows } = await tx.query(
    `select
        i.public_reference, i.category, i.current_status, i.opened_at, i.last_evidence_at,
        ST_X(i.representative_location::geometry) as lon,
        ST_Y(i.representative_location::geometry) as lat,
        (select count(*)::int from issue_participation p
          where p.canonical_issue_id = i.issue_id and p.counted = true) as counted,
        (select count(*)::int from issue_evidence_link link
          where link.canonical_issue_id = i.issue_id and link.effective_to is null) as entries
       from canonical_issue i
      where i.issue_id = $1`,
    [options.issueId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;

  const evidenceRows = await tx.query(
    `select e.media_type, e.content_text, e.derivative_reference, e.redaction_status,
            e.processing_status, e.ingested_at
       from issue_evidence_link link
       join evidence_item e on e.evidence_id = link.evidence_id
      where link.canonical_issue_id = $1
        and link.effective_to is null
        and e.privacy_state = 'active'
      order by e.ingested_at asc`,
    [options.issueId],
  );

  const evidence: readonly DetailEvidence[] = evidenceRows.rows.map((item) => {
    const mediaType = String(item["media_type"]);
    const derivative =
      item["derivative_reference"] === null ? undefined : String(item["derivative_reference"]);
    const redaction = String(item["redaction_status"]);
    const text = item["content_text"] === null ? undefined : String(item["content_text"]);

    // A photograph is viewable only through an approved derivative. The
    // original is never offered here at any authorisation level: this is the
    // public read model, and an authorised original read is a separate,
    // audited path (V015, V021 §5).
    const viewable = mediaType === "text" ? text !== undefined : derivative !== undefined;
    const whyNotViewable = viewable
      ? undefined
      : mediaType === "text"
        ? "this entry has no text"
        : `no approved derivative exists yet (redaction status: ${redaction}), so there is nothing that may be shown`;

    return {
      mediaType,
      contentText: text,
      derivativeReference: derivative,
      viewable,
      whyNotViewable,
      ingestedAt: new Date(String(item["ingested_at"])).toISOString(),
    };
  });

  // What is actually recorded against this issue, rather than a constant.
  const workflow = await tx.query(
    `select
        exists (select 1 from assignment a
                 where a.issue_id = $1 and a.valid_to is null) as assigned,
        exists (select 1 from resolution_claim k where k.issue_id = $1) as claimed`,
    [options.issueId],
  );
  const assigned = workflow.rows[0]?.["assigned"] === true;
  const claimed = workflow.rows[0]?.["claimed"] === true;
  const status = String(row["current_status"]);

  const disclosures = [
    "identity in this demonstration is simulated and is not a real identity check",
    "any proposed category comes from an AI model and is pending review, not confirmed",
    // V034 and V035 are connected now, so the old blanket sentence would be
    // false. What remains true is that every department in this demonstration
    // is simulated, and that agreement is not an inspection.
    "every department, recipient and acknowledgment in this demonstration is simulated; no government system is contacted",
    NOT_A_CERTIFICATION,
  ];

  return {
    publicReference: String(row["public_reference"]),
    category: String(row["category"]),
    currentStatus: String(row["current_status"]),
    openedAt: new Date(String(row["opened_at"])).toISOString(),
    lastEvidenceAt:
      row["last_evidence_at"] === null
        ? undefined
        : new Date(String(row["last_evidence_at"])).toISOString(),
    coarseLocation:
      row["lon"] === null
        ? undefined
        : { lon: coarsen(Number(row["lon"])), lat: coarsen(Number(row["lat"])) },
    countedParticipants: Number(row["counted"] ?? 0),
    complaintEntries: Number(row["entries"] ?? 0),
    evidence,
    // Empty until V040 imports asset records; an invented history would be the
    // worst kind of confident-looking summary.
    infrastructureHistory: [],
    infrastructureHistoryNote: HISTORY_NOTE,
    assignment: {
      isLive: assigned,
      note: assigned
        ? "a department staff member is assigned to this issue in the simulated department directory"
        : "no staff member is assigned to this issue yet",
    },
    resolution: {
      // A claim makes the workflow live. It does not make the repair verified,
      // which is why the note says which of the two this is.
      isLive: claimed,
      note: claimed
        ? status === "resolution_confirmed"
          ? "participants confirmed that the visible problem appears fixed"
          : status === "resolution_disputed"
            ? "a participant disputes the repair claim, so it is not confirmed"
            : status === "reopened"
              ? "this issue was reopened after a confirmed resolution, so it is open again"
              : "department staff recorded a repair claim, which is awaiting confirmation and is not a verified resolution"
        : "no repair has been claimed for this issue yet",
    },
    disclosures,
  };
};
