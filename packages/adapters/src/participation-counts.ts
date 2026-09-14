/**
 * Unique contribution counts across merges (roadmap V029).
 *
 * "Fourteen people reported this" is the most quotable number this system
 * produces, so every route to inflating it is closed here: one person
 * submitting repeatedly, a retry, a duplicate delivery, and — the subtle one —
 * two issues merging when the same person had reported both. Merging **unions**
 * contributors; it never adds the two totals.
 *
 * Four quantities are kept strictly apart, because collapsing them is exactly
 * how a dashboard overstates public concern:
 *
 *  - **submitted media items** — how much evidence arrived;
 *  - **unique contributors** — how many distinct people reported;
 *  - **on-site evidence** — evidence carrying a device measurement rather than
 *    a typed claim about a place;
 *  - **population** — never estimated. A count of reporters says nothing about
 *    how many people are affected, and presenting one as the other would be an
 *    invention. The field exists as a permanent `undefined` so a caller finds
 *    an explicit absence instead of substituting a contributor count.
 *
 * What actually stops one person becoming several accounts is upstream: the
 * V009 identity mapping is unique on the hashed provider subject, so a second
 * login with the same credential reaches the same participant. The unique
 * constraint here closes the rest.
 */

import { randomUUID } from "node:crypto";

import {
  nowIso,
  type AdapterCallContext,
  type AdapterDescriptor,
  type AdapterOutcome,
  type UnauthenticatedExternalProvenance,
} from "@vision/contracts";

import type { Queryable } from "./outbox.ts";
import type { CorroborationCount } from "./corroboration.ts";

export type EligibilityDecision = {
  readonly verdict: "eligible" | "not_counted";
  readonly reasons: readonly string[];
};

export type RecordParticipationInput = {
  readonly participantId: string;
  readonly issueId: string;
  readonly evidenceAt: string;
  readonly eligibility: EligibilityDecision;
};

export type RecordParticipationResult = {
  readonly counted: boolean;
  /** False when a participation for this pair already existed. */
  readonly created: boolean;
  readonly reasons: readonly string[];
};

/**
 * Records a contribution, counting the person at most once per issue.
 *
 * The unique constraint on `(participant_id, canonical_issue_id)` is what makes
 * this safe under at-least-once delivery: a duplicate lands on the existing
 * row and only advances its evidence window.
 */
export const recordParticipation = async (
  tx: Queryable,
  input: RecordParticipationInput,
): Promise<RecordParticipationResult> => {
  const counted = input.eligibility.verdict === "eligible";
  const reason = counted ? null : input.eligibility.reasons.join("; ");

  const { rows } = await tx.query(
    `insert into issue_participation
       (participation_id, participant_id, canonical_issue_id, counted, non_counted_reason,
        eligibility_provenance, first_evidence_at, last_evidence_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)
     on conflict (participant_id, canonical_issue_id) do update
        set first_evidence_at = least(issue_participation.first_evidence_at, excluded.first_evidence_at),
            last_evidence_at = greatest(issue_participation.last_evidence_at, excluded.last_evidence_at),
            current_version = issue_participation.current_version + 1
     returning current_version`,
    [
      randomUUID(),
      input.participantId,
      input.issueId,
      counted,
      reason,
      JSON.stringify({ verdict: input.eligibility.verdict, reasons: input.eligibility.reasons }),
      input.evidenceAt,
    ],
  );

  // Version 1 means the insert happened; anything higher means the row was
  // already there and this contribution only widened its window.
  const created = Number(rows[0]?.["current_version"] ?? 1) === 1;
  return { counted, created, reasons: input.eligibility.reasons };
};

export type IssueCounts = {
  readonly uniqueContributors: number;
  readonly submittedMediaItems: number;
  readonly onsiteEvidenceItems: number;
  /** Permanently undefined. This system does not estimate populations. */
  readonly populationEstimate: undefined;
};

export const countsForIssue = async (tx: Queryable, issueId: string): Promise<IssueCounts> => {
  const contributors = await tx.query(
    `select count(*)::int as n from issue_participation
      where canonical_issue_id = $1 and counted = true`,
    [issueId],
  );

  const media = await tx.query(
    `select
        count(*)::int as submitted,
        -- On-site means the position was measured by the device. A typed pin
        -- is a claim about a place, and counting it as on-site evidence would
        -- overstate what is known (V019 §2).
        count(*) filter (where s.observed_location_source = 'device_geolocation')::int as onsite
       from issue_evidence_link link
       join evidence_item e on e.evidence_id = link.evidence_id
       join submission s on s.submission_id = e.submission_id
      where link.canonical_issue_id = $1
        and link.effective_to is null
        and e.privacy_state = 'active'`,
    [issueId],
  );

  return {
    uniqueContributors: Number(contributors.rows[0]?.["n"] ?? 0),
    submittedMediaItems: Number(media.rows[0]?.["submitted"] ?? 0),
    onsiteEvidenceItems: Number(media.rows[0]?.["onsite"] ?? 0),
    populationEstimate: undefined,
  };
};

export type UnionParticipationInput = {
  readonly survivingIssueId: string;
  readonly mergedIssueId: string;
  /** Set when undoing a specific merge, so only what that merge moved comes back. */
  readonly onlyMovedByMerge?: string;
};

export type UnionParticipationResult = {
  readonly movedParticipations: number;
  /** Participants already counted on the surviving issue: one person, one count. */
  readonly alreadyPresent: number;
};

/**
 * Moves participations onto the surviving issue, unioning rather than summing.
 *
 * A participant present on both sides is one person: their row on the merged
 * issue is folded into the surviving one, widening its evidence window so the
 * date they first reported survives. That date is history and a merge is not
 * licence to rewrite it.
 */
export const unionParticipationOnMerge = async (
  tx: Queryable,
  input: UnionParticipationInput,
): Promise<UnionParticipationResult> => {
  // When undoing a specific merge, only what that merge brought over may go
  // back. Moving everything would sweep the surviving issue's own
  // contributors onto the retired issue and corrupt both counts — which is
  // exactly what an earlier version of this function did.
  const { rows } =
    input.onlyMovedByMerge === undefined
      ? await tx.query(
          `select participant_id, counted, non_counted_reason, eligibility_provenance,
                  first_evidence_at, last_evidence_at
             from issue_participation
            where canonical_issue_id = $1`,
          [input.mergedIssueId],
        )
      : await tx.query(
          `select participant_id, counted, non_counted_reason, eligibility_provenance,
                  first_evidence_at, last_evidence_at
             from issue_participation
            where canonical_issue_id = $1
              and eligibility_provenance->>'moved_from_issue_id' = $2`,
          [input.mergedIssueId, input.survivingIssueId],
        );

  let moved = 0;
  let alreadyPresent = 0;

  for (const row of rows) {
    const participantId = String(row["participant_id"]);
    const existing = await tx.query(
      "select participation_id from issue_participation where participant_id = $1 and canonical_issue_id = $2",
      [participantId, input.survivingIssueId],
    );

    if (existing.rows[0] === undefined) {
      await tx.query(
        `insert into issue_participation
           (participation_id, participant_id, canonical_issue_id, counted, non_counted_reason,
            eligibility_provenance, first_evidence_at, last_evidence_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          randomUUID(),
          participantId,
          input.survivingIssueId,
          row["counted"],
          row["non_counted_reason"],
          JSON.stringify({
            ...(row["eligibility_provenance"] as Record<string, unknown>),
            moved_from_issue_id: input.mergedIssueId,
            moved_at: nowIso(),
            ...(input.onlyMovedByMerge === undefined
              ? {}
              : { restored_by_reversing_merge: input.onlyMovedByMerge }),
          }),
          row["first_evidence_at"],
          row["last_evidence_at"],
        ],
      );
      moved += 1;
    } else {
      // The same person on both sides. Widen the window; do not add a count.
      // The folded row's own window is recorded so reversing the merge can
      // recreate it — otherwise undoing a merge would silently lose the fact
      // that this person had reported the other issue too.
      await tx.query(
        `update issue_participation
            set first_evidence_at = least(first_evidence_at, $3::timestamptz),
                last_evidence_at = greatest(last_evidence_at, $4::timestamptz),
                eligibility_provenance = jsonb_set(
                  eligibility_provenance, '{folded_in}',
                  coalesce(eligibility_provenance->'folded_in', '[]'::jsonb) || $5::jsonb, true),
                current_version = current_version + 1
          where participant_id = $1 and canonical_issue_id = $2`,
        [
          participantId,
          input.survivingIssueId,
          row["first_evidence_at"],
          row["last_evidence_at"],
          JSON.stringify([
            {
              from_issue_id: input.mergedIssueId,
              first_evidence_at: row["first_evidence_at"],
              last_evidence_at: row["last_evidence_at"],
              folded_at: nowIso(),
            },
          ]),
        ],
      );
      alreadyPresent += 1;
    }

    // The source row is removed only after the destination exists, so a
    // failure mid-way leaves a duplicate (visible, correctable) rather than a
    // lost contribution.
    await tx.query(
      "delete from issue_participation where participant_id = $1 and canonical_issue_id = $2",
      [participantId, input.mergedIssueId],
    );
  }

  // Recreate rows that this merge folded into an existing participation.
  let restoredFolds = 0;
  if (input.onlyMovedByMerge !== undefined) {
    const folded = await tx.query(
      `select participant_id, counted, non_counted_reason, eligibility_provenance
         from issue_participation
        where canonical_issue_id = $1
          and eligibility_provenance->'folded_in' @> $2::jsonb`,
      [input.mergedIssueId, JSON.stringify([{ from_issue_id: input.survivingIssueId }])],
    );
    for (const row of folded.rows) {
      const entries = ((row["eligibility_provenance"] as Record<string, unknown>)["folded_in"] ??
        []) as { from_issue_id?: string; first_evidence_at?: string; last_evidence_at?: string }[];
      const entry = entries.find((item) => item.from_issue_id === input.survivingIssueId);
      if (entry === undefined) continue;
      await tx.query(
        `insert into issue_participation
           (participation_id, participant_id, canonical_issue_id, counted, non_counted_reason,
            eligibility_provenance, first_evidence_at, last_evidence_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
         on conflict (participant_id, canonical_issue_id) do nothing`,
        [
          randomUUID(),
          String(row["participant_id"]),
          input.survivingIssueId,
          row["counted"],
          row["non_counted_reason"],
          JSON.stringify({ restored_by_reversing_merge: input.onlyMovedByMerge }),
          entry.first_evidence_at ?? nowIso(),
          entry.last_evidence_at ?? nowIso(),
        ],
      );
      restoredFolds += 1;
    }
  }

  return { movedParticipations: moved + restoredFolds, alreadyPresent };
};

const LIVE_NOTE_SUFFIX =
  "a count of counted participants; it does not mean nobody else is affected, and it is not evidence that the reports are accurate";

/**
 * Live eligible participation for the V025 corroboration signal (V029).
 *
 * Replaces `FixtureCorroborationAdapter`. `inputIsFixture` is now false, and
 * the descriptor says `real` — the number comes from counted participations.
 * A zero still means "no other counted participant", never "nobody else has
 * this problem" (V002 row 20).
 */
export class LiveCorroborationAdapter {
  readonly descriptor: AdapterDescriptor;

  private readonly tx: Queryable;

  constructor(tx: Queryable) {
    this.tx = tx;
    this.descriptor = {
      provider_name: "live-participation",
      provider_mode: "real",
      capability: {
        capability: "source_import",
        provider_name: "live-participation",
        provider_mode: "real",
        display_label: "Number of people who separately reported this",
        v002_row: 25,
        may_claim: ["how many distinct counted participants reported this issue"],
        must_not_claim: [
          "that agreement between reports makes them accurate",
          "that a count of zero means nobody else has this problem",
          "how many people are affected",
        ],
      },
    };
  }

  async countEligibleParticipants(
    issueId: string,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<CorroborationCount>> {
    const provenance: UnauthenticatedExternalProvenance = {
      provider_mode: "real",
      // Internal data rather than an outside authority: still not something
      // any surface may present as externally confirmed.
      authenticity: "unauthenticated_external",
      provider_name: this.descriptor.provider_name,
      observed_at: nowIso(),
    };

    const counts = await countsForIssue(this.tx, issueId);

    return {
      kind: "success",
      value: {
        eligibleParticipants: counts.uniqueContributors,
        inputIsFixture: false,
        note: `${String(counts.uniqueContributors)} counted participant(s): ${LIVE_NOTE_SUFFIX}`,
      },
      provenance,
      correlation_id: context.correlation_id,
    };
  }
}
