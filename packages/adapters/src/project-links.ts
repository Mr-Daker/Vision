/**
 * Sanctioned-project links (roadmap V041).
 *
 * Loads the project register, proposes links between reports and projects, and
 * records what a reviewer decided — including, crucially, the case where
 * nothing matched.
 *
 * **A no-match is written down.** `proposeLinksForIssue` records an `unmatched`
 * row rather than leaving the absence of a row to speak for itself. An absent
 * row is indistinguishable from "nobody has looked yet", and a reader who
 * cannot tell those apart will read either as "this was never funded". The
 * stored row names the register that was searched, the matcher version that
 * searched it, and the note saying what the finding does and does not mean.
 *
 * **Nothing is confirmed here.** The matcher writes `proposed`, `ambiguous` or
 * `unmatched`; only `recordProjectLinkDecision` writes `confirmed` or
 * `rejected`, and the database refuses either without a reviewer against it.
 * Linking a citizen's report to a public spending record is a claim with a
 * name on it, and the name has to be a person's.
 *
 * **No confidence number is stored.** `match_basis` holds the methods that
 * fired and the reasons in words. A percentage beside a funding claim would be
 * read as a probability somebody calibrated, and nothing here is calibrated.
 */

import { randomUUID } from "node:crypto";

import {
  DEFAULT_PROJECT_THRESHOLDS,
  PROJECT_MATCHER_VERSION,
  absenceStatement,
  proposeProjectMatch,
  type ProjectMatchProposal,
  type ProjectMatchThresholds,
  type ProjectSignals,
} from "@vision/domain";
import type { SourceRecordSnapshot } from "@vision/contracts";

import { ensureSourceRecord } from "./context-import.ts";
import type { Queryable } from "./outbox.ts";

export class ProjectLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectLinkError";
  }
}

export type ProjectToLoad = {
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

export type RegisterLoadResult = {
  readonly loaded: number;
  readonly skipped: readonly { readonly projectId: string; readonly reason: string }[];
};

/**
 * Loads the project register, refusing rows it cannot place.
 *
 * A project naming a jurisdiction or an asset that does not exist is skipped
 * and reported, never attached to the nearest plausible one — the same rule
 * V040 applies to context rows, and for the same reason: a funding record
 * pinned to the wrong place is worse than one that is missing.
 */
export const loadProjectRegister = async (
  tx: Queryable,
  options: {
    readonly projects: readonly ProjectToLoad[];
    readonly source: SourceRecordSnapshot;
    readonly jurisdictionProfileId: string;
  },
): Promise<RegisterLoadResult> => {
  const sourceRecordId = await ensureSourceRecord(tx, options.source);
  const synthetic = options.source.licence_or_permission_status === "synthetic";

  const { rows: jurisdictionRows } = await tx.query(
    "select jurisdiction_id, internal_code from jurisdiction where jurisdiction_profile_id = $1",
    [options.jurisdictionProfileId],
  );
  const jurisdictions = new Map(
    jurisdictionRows.map((row) => [String(row["internal_code"]), String(row["jurisdiction_id"])]),
  );
  const { rows: assetRows } = await tx.query("select asset_id from infrastructure_asset");
  const assets = new Set(assetRows.map((row) => String(row["asset_id"])));

  const skipped: { projectId: string; reason: string }[] = [];
  let loaded = 0;

  for (const project of options.projects) {
    const jurisdictionId = jurisdictions.get(project.jurisdictionInternalCode);
    if (jurisdictionId === undefined) {
      skipped.push({
        projectId: project.projectId,
        reason: `no jurisdiction '${project.jurisdictionInternalCode}' in this profile; the project is reported rather than placed in the nearest one`,
      });
      continue;
    }
    if (project.assetId !== null && !assets.has(project.assetId)) {
      skipped.push({
        projectId: project.projectId,
        reason: `names asset '${project.assetId}', which does not exist; a funding record pinned to the wrong asset is worse than one that is missing`,
      });
      continue;
    }

    await tx.query(
      `insert into sanctioned_project
         (project_id, project_name, scope_description, scope_terms, asset_id,
          jurisdiction_id, location, sanctioned_at, completed_at, amount, amount_unit,
          source_record_id, synthetic_provenance)
       values ($1,$2,$3,$4::text[],$5,$6,
               case when $7::double precision is null or $8::double precision is null then null
                    else st_setsrid(st_makepoint($7,$8),4326)::geography end,
               $9,$10,$11,$12,$13,$14)
       on conflict (project_id) do update set
         project_name = excluded.project_name,
         scope_description = excluded.scope_description,
         scope_terms = excluded.scope_terms,
         asset_id = excluded.asset_id,
         jurisdiction_id = excluded.jurisdiction_id,
         location = excluded.location,
         sanctioned_at = excluded.sanctioned_at,
         completed_at = excluded.completed_at,
         amount = excluded.amount,
         amount_unit = excluded.amount_unit,
         source_record_id = excluded.source_record_id,
         synthetic_provenance = excluded.synthetic_provenance,
         loaded_at = now()`,
      [
        project.projectId,
        project.projectName,
        project.scopeDescription,
        [...project.scopeTerms],
        project.assetId,
        jurisdictionId,
        project.longitude,
        project.latitude,
        project.sanctionedAt,
        project.completedAt,
        project.amount,
        project.amountUnit,
        sourceRecordId,
        synthetic,
      ],
    );
    loaded += 1;
  }

  return { loaded, skipped };
};

// ---------------------------------------------------------------------------
// Proposing
// ---------------------------------------------------------------------------

/**
 * Candidate signals for one report.
 *
 * Distance comes from PostGIS rather than from arithmetic here, and is `null`
 * when either side has no position — never zero, and never guessed. Scope
 * overlap is computed as a set intersection against the report's category, so
 * a project's scope terms have to name the category rather than resemble it.
 */
const CANDIDATE_SQL = `select
  p.project_id, p.project_name, p.scope_terms, p.asset_id, p.sanctioned_at, p.completed_at,
  p.synthetic_provenance, p.source_record_id, s.source_name,
  (p.asset_id is not null and p.asset_id = i.asset_id) as asset_id_matches,
  case when p.location is null or i.representative_location is null then null
       else st_distance(p.location, i.representative_location) end as distance_metres,
  array(select unnest(p.scope_terms) intersect select unnest(array[i.category])) as shared_terms,
  (i.opened_at >= p.sanctioned_at
    and (p.completed_at is null or i.opened_at <= p.completed_at)) as opened_inside_window
from sanctioned_project p
join source_record s on s.source_record_id = p.source_record_id
cross join lateral (
  select c.asset_id, c.category, c.opened_at, c.representative_location, c.jurisdiction_id
    from canonical_issue c where c.issue_id = $1::uuid
) i
where p.jurisdiction_id = i.jurisdiction_id
   or (p.asset_id is not null and p.asset_id = i.asset_id)
order by p.project_id`;

export type ProposeResult = {
  readonly issueId: string;
  readonly proposal: ProjectMatchProposal;
  readonly written: readonly { readonly projectId: string | null; readonly status: string }[];
};

/**
 * Searches the register for one report and records what it found.
 *
 * Re-runnable: prior matcher output for this issue is cleared first, so a rule
 * change produces a fresh finding rather than layers of stale proposals.
 * Reviewer decisions are **not** cleared — a person's judgement is not the
 * matcher's to withdraw.
 */
export const proposeLinksForIssue = async (
  tx: Queryable,
  options: {
    readonly issueId: string;
    readonly registerName: string;
    readonly registerIsSynthetic: boolean;
    readonly sourceRecordId: string;
    readonly thresholds?: ProjectMatchThresholds;
    readonly asOf: Date;
  },
): Promise<ProposeResult> => {
  const { rows } = await tx.query(CANDIDATE_SQL, [options.issueId]);
  const candidates: readonly ProjectSignals[] = rows.map((row) => ({
    projectId: String(row["project_id"]),
    projectName: String(row["project_name"]),
    sourceRecordId: String(row["source_record_id"]),
    sourceName: String(row["source_name"]),
    synthetic: row["synthetic_provenance"] === true,
    assetIdMatches: row["asset_id_matches"] === true,
    distanceMetres:
      row["distance_metres"] === null || row["distance_metres"] === undefined
        ? undefined
        : Number(row["distance_metres"]),
    sharedScopeTerms: ((row["shared_terms"] as string[] | null) ?? []).map((term) => String(term)),
    sanctionedAt: new Date(String(row["sanctioned_at"])).toISOString(),
    completedAt:
      row["completed_at"] === null || row["completed_at"] === undefined
        ? undefined
        : new Date(String(row["completed_at"])).toISOString(),
    openedInsideProjectWindow: row["opened_inside_window"] === true,
  }));

  const proposal = proposeProjectMatch({
    candidates,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    registerName: options.registerName,
    registerIsSynthetic: options.registerIsSynthetic,
  });

  const written: { projectId: string | null; status: string }[] = [];
  await tx.query("begin");
  try {
    // Matcher output only. A reviewer's confirmation or rejection stands.
    await tx.query(
      `delete from project_link
        where issue_id = $1::uuid and match_status in ('proposed','ambiguous','unmatched')`,
      [options.issueId],
    );

    // Pairings a person has already settled are not re-asked. The matcher may
    // still find them — that is what keeps the reasoning honest — but putting
    // a decided pairing back in a reviewer's queue would make every rejection
    // temporary, and a rejection that comes back next week is not an answer.
    const { rows: decidedRows } = await tx.query(
      `select project_id from project_link
        where issue_id = $1::uuid and match_status in ('confirmed','rejected')
          and project_id is not null`,
      [options.issueId],
    );
    const decided = new Set(decidedRows.map((row) => String(row["project_id"])));

    const basis = {
      matcher_version: proposal.matcherVersion,
      outcome: proposal.outcome,
      reasons: proposal.reasons,
      absence_note: proposal.absenceNote,
      register: options.registerName,
      register_is_synthetic: options.registerIsSynthetic,
    };

    const outstanding = proposal.candidates.filter(
      (candidate) => !decided.has(candidate.projectId),
    );

    if (proposal.outcome === "no_candidate" && decided.size > 0) {
      // Nothing new to show, and an `unmatched` row would be false: a decided
      // link exists for this report.
      await tx.query("commit");
      return { issueId: options.issueId, proposal, written };
    }

    if (proposal.outcome === "no_candidate") {
      await tx.query(
        `insert into project_link
           (project_link_id, issue_id, project_id, source_project_id, match_basis,
            match_status, match_method, matcher_version, proposed_at)
         values ($1,$2::uuid,null,$3,$4::jsonb,'unmatched',null,$5,$6::timestamptz)`,
        [
          randomUUID(),
          options.issueId,
          options.sourceRecordId,
          JSON.stringify(basis),
          proposal.matcherVersion,
          options.asOf.toISOString(),
        ],
      );
      written.push({ projectId: null, status: "unmatched" });
    } else {
      const status = proposal.outcome === "ambiguous" ? "ambiguous" : "proposed";
      for (const candidate of outstanding) {
        await tx.query(
          `insert into project_link
             (project_link_id, issue_id, project_id, source_project_id, match_basis,
              match_status, match_method, matcher_version, proposed_at)
           values ($1,$2::uuid,$3,$4,$5::jsonb,$6,$7,$8,$9::timestamptz)`,
          [
            randomUUID(),
            options.issueId,
            candidate.projectId,
            options.sourceRecordId,
            JSON.stringify({ ...basis, methods: candidate.methods, reasons: candidate.reasons }),
            status,
            candidate.methods.join("+"),
            proposal.matcherVersion,
            options.asOf.toISOString(),
          ],
        );
        written.push({ projectId: candidate.projectId, status });
      }
    }
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }

  return { issueId: options.issueId, proposal, written };
};

// ---------------------------------------------------------------------------
// Reading and deciding
// ---------------------------------------------------------------------------

export type ProjectLinkRow = {
  readonly projectLinkId: string;
  readonly issueId: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly scopeDescription: string | null;
  readonly amount: number | null;
  readonly amountUnit: string | null;
  readonly sanctionedAt: string | null;
  readonly completedAt: string | null;
  readonly status: "proposed" | "confirmed" | "rejected" | "ambiguous" | "unmatched";
  readonly matchMethod: string | null;
  readonly matcherVersion: string | null;
  readonly reasons: readonly string[];
  /** What a no-match does and does not mean. Present on every row. */
  readonly absenceNote: string;
  readonly reviewerId: string | null;
  readonly decidedAt: string | null;
  readonly sourceName: string;
  readonly synthetic: boolean;
};

const FALLBACK_NOTE = absenceStatement({
  registerName: "the project register",
  registerIsSynthetic: true,
});

export const readProjectLinks = async (
  tx: Queryable,
  options: { readonly issueIds: readonly string[] },
): Promise<readonly ProjectLinkRow[]> => {
  if (options.issueIds.length === 0) return [];
  const { rows } = await tx.query(
    `select l.project_link_id, l.issue_id, l.project_id, l.match_status, l.match_method,
            l.matcher_version, l.match_basis, l.reviewer_id, l.decided_at,
            p.project_name, p.scope_description, p.amount, p.amount_unit,
            p.sanctioned_at, p.completed_at, p.synthetic_provenance,
            s.source_name
       from project_link l
       left join sanctioned_project p on p.project_id = l.project_id
       join source_record s on s.source_record_id = l.source_project_id
      where l.issue_id = any($1::uuid[])
      order by l.issue_id, l.match_status, l.project_id nulls first`,
    [[...options.issueIds]],
  );
  return rows.map((row) => {
    const basis = (row["match_basis"] ?? {}) as Record<string, unknown>;
    const reasons = Array.isArray(basis["reasons"])
      ? (basis["reasons"] as unknown[]).map((reason) => String(reason))
      : [];
    const text = (value: unknown): string | null =>
      value === null || value === undefined ? null : String(value);
    return {
      projectLinkId: String(row["project_link_id"]),
      issueId: String(row["issue_id"]),
      projectId: text(row["project_id"]),
      projectName: text(row["project_name"]),
      scopeDescription: text(row["scope_description"]),
      amount: row["amount"] === null || row["amount"] === undefined ? null : Number(row["amount"]),
      amountUnit: text(row["amount_unit"]),
      sanctionedAt:
        row["sanctioned_at"] === null || row["sanctioned_at"] === undefined
          ? null
          : new Date(String(row["sanctioned_at"])).toISOString(),
      completedAt:
        row["completed_at"] === null || row["completed_at"] === undefined
          ? null
          : new Date(String(row["completed_at"])).toISOString(),
      status: String(row["match_status"]) as ProjectLinkRow["status"],
      matchMethod: text(row["match_method"]),
      matcherVersion: text(row["matcher_version"]),
      reasons,
      // Every row carries it, not only the unmatched ones: a reader looking at
      // one weak proposal is at the same risk of reading the gaps around it as
      // absence of funding.
      absenceNote:
        typeof basis["absence_note"] === "string" ? basis["absence_note"] : FALLBACK_NOTE,
      reviewerId: text(row["reviewer_id"]),
      decidedAt:
        row["decided_at"] === null || row["decided_at"] === undefined
          ? null
          : new Date(String(row["decided_at"])).toISOString(),
      sourceName: String(row["source_name"]),
      synthetic: row["synthetic_provenance"] === true,
    };
  });
};

/**
 * Records a reviewer's decision on one proposed link.
 *
 * Only `confirmed` and `rejected` are reachable, and the database refuses
 * either without a reviewer id. A rejection is kept rather than deleted: that
 * somebody looked at this pairing and said no is a finding, and a deleted row
 * would leave the matcher free to propose it again next week with nothing
 * recording that the question was already settled.
 */
export const recordProjectLinkDecision = async (
  tx: Queryable,
  options: {
    readonly projectLinkId: string;
    readonly decision: "confirmed" | "rejected";
    readonly reviewerId: string;
    readonly reason: string;
    readonly asOf: Date;
  },
): Promise<void> => {
  if (options.reason.trim().length < 8) {
    throw new ProjectLinkError(
      "a decision about whether public money was spent on this needs a reason somebody can read later",
    );
  }
  const { rows } = await tx.query(
    `update project_link
        set match_status = $2, reviewer_id = $3, decided_at = $4::timestamptz,
            match_basis = jsonb_set(
              coalesce(match_basis, '{}'::jsonb), '{reviewer_reason}', to_jsonb($5::text), true),
            current_version = current_version + 1
      where project_link_id = $1
        and match_status in ('proposed','ambiguous')
      returning project_link_id`,
    [
      options.projectLinkId,
      options.decision,
      options.reviewerId,
      options.asOf.toISOString(),
      options.reason,
    ],
  );
  if (rows.length === 0) {
    throw new ProjectLinkError(
      "this link is not awaiting a decision; it may already have been decided, or the matcher may have withdrawn it",
    );
  }
};

/** Everything the matcher last found for one report, ready to show. */
export type IssueProjectView = {
  readonly issueId: string;
  readonly links: readonly ProjectLinkRow[];
  readonly hasConfirmedLink: boolean;
  readonly searched: boolean;
  readonly absenceNote: string;
};

export const readIssueProjectView = async (
  tx: Queryable,
  options: { readonly issueId: string },
): Promise<IssueProjectView> => {
  const links = await readProjectLinks(tx, { issueIds: [options.issueId] });
  return {
    issueId: options.issueId,
    links,
    hasConfirmedLink: links.some((link) => link.status === "confirmed"),
    // False means nobody has looked yet, which is a different statement from
    // having looked and found nothing. The two must never render the same.
    searched: links.length > 0,
    absenceNote: links[0]?.absenceNote ?? FALLBACK_NOTE,
  };
};
