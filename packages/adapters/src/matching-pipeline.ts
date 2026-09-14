/**
 * The matching pipeline, wired end to end.
 *
 * V026 to V033 were each verified on their own and none of them was called by
 * anything — every one of those task records said so. This is the stage that
 * calls them in order:
 *
 *   embed (outside any transaction)
 *     -> retrieve candidates        (V026)
 *     -> propose a match            (V027)
 *     -> commit the decision        (V028, SERIALIZABLE + recheck)
 *     -> count the contributor      (V029, eligibility from V014)
 *     -> route to a department      (V033)
 *
 * It runs inside one V017 stage lease, so a duplicate delivery is a no-op and
 * a crash leaves recoverable work. The stage's unique key is what makes that
 * true, not anything in this file.
 *
 * **Providers are called before the transaction opens.** A transaction held
 * across a network call is how a connection pool is exhausted by a slow third
 * party (V006 §5), and V028's whole strategy depends on the transaction being
 * short. A test asserts no transaction is open while the embedding runs.
 *
 * **A provider outage does not stop the chain.** Without a vector the matcher
 * has one fewer signal, and V027 already refuses to match on proximity alone —
 * so the report is still grouped or opened, with the missing signal recorded
 * rather than silently treated as "no similarity".
 */

import { createHash, randomUUID } from "node:crypto";

import {
  evaluateParticipationEligibility,
  evaluateTrustSignals,
  proposeMatch,
  type MatchSignals,
} from "@vision/domain";

import type { Taxonomy } from "./gemini.ts";
import type { ClassificationProposal } from "@vision/contracts";

import { activeConsentPurposes } from "./consent.ts";
import { retrieveCandidates, type IssueCandidate } from "./candidates.ts";
import { assignSubmissionToIssue } from "./issue-assignment.ts";
import { recordParticipation } from "./participation-counts.ts";
import { recordClassificationProposal, recordTrustSignalReport } from "./proposals.ts";
import { withAiCache } from "./ai-cache.ts";
import { resolveRouting, type RoutingResult } from "./routing.ts";
import {
  recordJurisdictionResolution,
  type JurisdictionResolution,
  type ResolveJurisdiction,
} from "./jurisdictions.ts";
import { acquireStageLease, completeStage, failStage, type Queryable } from "./outbox.ts";

export const MATCHING_STAGE = "matching";
export const MATCHING_PIPELINE_VERSION = "matching.v1";

/** Produces a semantic vector. Injected, so the pipeline needs no provider of its own. */
/**
 * Classifies a report's text (roadmap V023).
 *
 * A port, not the Gemini adapter itself: the stage must run without an API key
 * (a deployment that stops accepting reports because a vendor is rate-limiting
 * is worse than one that categorises them later), and the adapter needs no
 * database access.
 */
export type ClassifyText = (
  text: string,
) => Promise<
  | { readonly outcome: "classified"; readonly proposal: ClassificationProposal }
  | { readonly outcome: "unavailable"; readonly reasonCode: string }
>;

export type EmbedText = (text: string) => Promise<{
  readonly vector: readonly number[];
  readonly model: string;
  readonly dimensions: number;
  readonly normalized: boolean;
}>;

export type MatchingStageInput = {
  readonly submissionId: string;
  /**
   * Legacy/test-only explicit scope. Deployments use resolveJurisdiction so a
   * caller cannot attribute every report to one configured id.
   */
  readonly jurisdictionId: string | undefined;
  readonly resolveJurisdiction?: ResolveJurisdiction | undefined;
  readonly taxonomy: Taxonomy;
  readonly directoryVersion: string;
  /**
   * Category used when nothing has classified the report yet.
   *
   * Not a guess dressed as a classification: it is recorded as the fallback it
   * is, and a real proposal (V023) replaces it once a reviewer confirms one.
   */
  readonly fallbackCategory: string;
  readonly embed?: EmbedText | undefined;
  /**
   * The classifier, if this deployment has one (V023).
   *
   * Optional on purpose. Without it the stage uses `fallbackCategory` and
   * records it as the fallback it is — which is what a deployment with no API
   * key does, and it must keep working.
   */
  readonly classify?: ClassifyText | undefined;
  /** Part of the cache key: a different model is a different answer. */
  readonly classificationModelName?: string;
  /** Part of the cache key: a changed prompt is a different question. */
  readonly classificationPromptVersion?: string;
  /**
   * Retrieval bounds, supplied as data.
   *
   * Required, not defaulted. V026 recorded that the window "defaults to 90
   * days with no evidence behind that number"; a default in code is exactly
   * what makes an uncalibrated number invisible. Requiring the caller to
   * supply bounds that carry their own `version` and `note` means every run
   * records which bounds it searched and what they are based on.
   *
   * `@vision/config-packs` has the loader (`loadMatchingBounds`); adapters may
   * not import it, so composition happens in the app.
   */
  readonly bounds: MatchingStageBounds;
  readonly owner?: string;
};

/** The shape `loadMatchingBounds` produces. Structural, so adapters stay leaf-ward of the pack loader. */
/**
 * How long the matching stage holds its lease.
 *
 * Sized against the provider, not chosen round: a single classification call
 * may take the adapter's full `DEFAULT_TIMEOUT_MS`, measured at 35–49 s
 * against the live endpoint, and retrieval, the embedding, the assignment
 * transaction and the trust evaluation all happen inside the same lease. A
 * lease that expires mid-call lets another worker take the stage over and
 * fence the first one's writes out — the work is done twice and the first
 * attempt's results disappear. `provider-latency.test.ts` pins the
 * relationship so this and the request timeout cannot drift apart.
 */
export const MATCHING_LEASE_SECONDS = 180;

export type MatchingStageBounds = {
  readonly version: string;
  readonly baseRadiusMetres: number;
  readonly timeWindowHours: number;
  readonly note: string;
};

export type MatchingStageResult =
  | {
      readonly status: "completed";
      readonly assignment: "created" | "attached" | "needs_review";
      readonly issueId: string | undefined;
      readonly routing: RoutingResult | undefined;
      readonly jurisdictionResolution: JurisdictionResolution | undefined;
      readonly embeddingAvailable: boolean;
      readonly candidateCount: number;
      readonly notes: readonly string[];
    }
  | { readonly status: "already_processed" }
  | { readonly status: "failed"; readonly reason: string };

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

type SubmissionRow = {
  readonly participantId: string;
  readonly lon: number;
  readonly lat: number;
  readonly accuracyMetres: number | undefined;
  readonly observedAt: string;
  /** How the position was obtained. A dropped pin is not a worse report, just a different one. */
  readonly locationSource: "device_geolocation" | "manual_pin";
  /** When the server accepted the report, which is what a capture time is compared against. */
  readonly submittedAt: string;
  readonly text: string;
};

const loadSubmission = async (
  tx: Queryable,
  submissionId: string,
): Promise<SubmissionRow | { readonly missingLocation: true; readonly participantId: string }> => {
  const { rows } = await tx.query(
    `select
        s.participant_id,
        ST_X(s.observed_location::geometry) as lon,
        ST_Y(s.observed_location::geometry) as lat,
        s.observed_accuracy_m, s.observed_at,
        s.observed_location_source, s.server_received_at,
        coalesce(
          (select string_agg(e.content_text, ' ' order by e.ingested_at)
             from evidence_item e
            where e.submission_id = s.submission_id
              and e.media_type in ('text','voice')
              and e.privacy_state = 'active'
              and e.content_text is not null),
          ''
        ) as text
       from submission s
      where s.submission_id = $1 and s.privacy_state = 'active'`,
    [submissionId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`submission ${submissionId} does not exist or is not active`);
  }
  if (row["lon"] === null || row["lat"] === null) {
    return { missingLocation: true, participantId: String(row["participant_id"]) };
  }
  return {
    participantId: String(row["participant_id"]),
    lon: Number(row["lon"]),
    lat: Number(row["lat"]),
    accuracyMetres:
      row["observed_accuracy_m"] === null ? undefined : Number(row["observed_accuracy_m"]),
    observedAt: new Date(String(row["observed_at"])).toISOString(),
    locationSource:
      String(row["observed_location_source"]) === "manual_pin"
        ? "manual_pin"
        : "device_geolocation",
    submittedAt: new Date(String(row["server_received_at"])).toISOString(),
    text: String(row["text"] ?? ""),
  };
};

/**
 * Whether this submission's media duplicates a candidate issue's.
 *
 * Closes V027's note that media similarity was "passed in as a boolean rather
 * than computed". It is an exact fingerprint comparison: V021's perceptual
 * hash exists, but treating near-duplicate images as the same photograph is a
 * judgement, and V027 only needs to know whether the bytes were reused.
 */
const mediaReuseAgainst = async (
  tx: Queryable,
  submissionId: string,
  issueIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  if (issueIds.length === 0) return new Set();
  const { rows } = await tx.query(
    `select distinct link.canonical_issue_id
       from evidence_item mine
       join evidence_item theirs
              on theirs.fingerprint_hash = mine.fingerprint_hash
             and theirs.evidence_id <> mine.evidence_id
       join issue_evidence_link link
              on link.evidence_id = theirs.evidence_id and link.effective_to is null
      where mine.submission_id = $1
        and mine.fingerprint_hash is not null
        and mine.privacy_state = 'active'
        and theirs.privacy_state = 'active'
        and link.canonical_issue_id = any($2::uuid[])`,
    [submissionId, [...issueIds]],
  );
  return new Set(rows.map((row) => String(row["canonical_issue_id"])));
};

const toSignals = (
  candidate: IssueCandidate,
  accuracyMetres: number | undefined,
  reused: ReadonlySet<string>,
): MatchSignals => ({
  issueId: candidate.issueId,
  publicReference: candidate.publicReference,
  distanceMetres: candidate.distanceMetres,
  positionAccuracyMetres: accuracyMetres,
  assetMatches: candidate.assetMatches,
  categoryMatches: candidate.categoryMatches,
  semanticDistance: candidate.semanticDistance,
  mediaNearDuplicate: reused.has(candidate.issueId) ? true : undefined,
  issueOpenedAt: candidate.openedAt,
  lastEvidenceAt: candidate.lastEvidenceAt,
  // Recurrence needs the prior issue's confirmed-resolution state, which the
  // candidate query does not carry. Left undefined rather than guessed: V027
  // treats an absent classification as "not a recurrence candidate", and
  // inventing one here would send reports to review for no reason.
  recurrence: undefined,
});

export const runMatchingStage = async (
  tx: Queryable,
  input: MatchingStageInput,
): Promise<MatchingStageResult> => {
  const loaded = await loadSubmission(tx, input.submissionId);

  const lease = await acquireStageLease(
    tx,
    {
      submissionId: input.submissionId,
      stage: MATCHING_STAGE,
      pipelineVersion: MATCHING_PIPELINE_VERSION,
    },
    {
      owner: input.owner ?? `matching-worker:${process.pid}`,
      leaseSeconds: MATCHING_LEASE_SECONDS,
      inputHash: input.submissionId,
    },
  );
  if (!lease.acquired) {
    return { status: "already_processed" };
  }

  if ("missingLocation" in loaded) {
    // Recoverable, not terminal: a location can be corrected, and a report
    // without one is still a report.
    await failStage(tx, lease.lease, "submission_has_no_location");
    return {
      status: "failed",
      reason: "this submission has no observed location, so no candidate search is possible",
    };
  }

  const notes: string[] = [];

  // ---- Provider work, deliberately before any transaction opens ----
  let embedding: Awaited<ReturnType<EmbedText>> | undefined;
  if (input.embed !== undefined && loaded.text.trim().length > 0) {
    try {
      embedding = await input.embed(loaded.text);
    } catch {
      // One fewer signal, not a failure. V027 refuses to match on proximity
      // alone, so the absence is safe — but it is recorded, because a silent
      // "no similarity" would look like evidence of difference.
      notes.push(
        "no semantic vector was produced for this report, so candidates were compared without a similarity signal",
      );
    }
  } else if (input.embed === undefined) {
    notes.push(
      "no embedding provider is configured, so candidates were compared without semantics",
    );
  }

  if (embedding !== undefined) {
    await tx.query(
      `insert into submission_embedding
         (submission_id, embedding, model_name, dimensions, normalized, input_hash)
       values ($1,$2::vector,$3,$4,$5,$6)
       on conflict (submission_id) do update
          set embedding = excluded.embedding, model_name = excluded.model_name,
              dimensions = excluded.dimensions, normalized = excluded.normalized,
              input_hash = excluded.input_hash, embedded_at = now()`,
      [
        input.submissionId,
        JSON.stringify([...embedding.vector]),
        embedding.model,
        embedding.dimensions,
        embedding.normalized,
        sha256(loaded.text),
      ],
    );
  }

  // ---- V023: classify, cache the answer, store the proposal ----
  //
  // Three rules hold here, and each one is a decision rather than a detail:
  //
  //  * The call goes through `withAiCache`, so two people describing the same
  //    problem in the same words cost one call — on a five-per-minute tier the
  //    second is the one that fails.
  //  * An outage never loses the report. The stage continues on the fallback
  //    category and says so; a report that failed to process because a vendor
  //    was rate-limiting is a report the citizen filed and nobody ever saw.
  //  * Only a `high` band is used as the working category. Anything less is
  //    advice pending review (V023), and using it would route the report on a
  //    guess nobody confirmed — routing decides who is asked to fix it.
  let category = input.fallbackCategory;
  let classification: ClassificationProposal | undefined;
  if (input.classify !== undefined) {
    // The proposal hangs off a piece of evidence so a reviewer sees it beside
    // what it describes. The evidence is linked to an issue later in this same
    // stage, which is what puts the proposal in the jurisdiction-scoped queue.
    const evidenceRow = await tx.query(
      `select evidence_id from evidence_item
        where submission_id = $1 and privacy_state = 'active'
        order by ingested_at asc limit 1`,
      [input.submissionId],
    );
    const evidenceForProposal =
      evidenceRow.rows[0] === undefined ? undefined : String(evidenceRow.rows[0]["evidence_id"]);
    const classifier = input.classify;
    const cached = await withAiCache(
      tx,
      {
        operation: "classification",
        inputHash: sha256(loaded.text),
        modelName: input.classificationModelName ?? "unnamed-classifier",
        promptVersion: input.classificationPromptVersion ?? "classify.v1",
      },
      async () => {
        const answer = await classifier(loaded.text);
        return answer.outcome === "classified"
          ? { outcome: "success" as const, result: answer.proposal }
          : { outcome: "failure" as const, reasonCode: answer.reasonCode };
      },
    );

    if (cached.outcome === "failure") {
      notes.push(
        `classification was unavailable (${cached.reasonCode}), so this report keeps its fallback category and nothing was proposed`,
      );
    } else {
      classification = cached.result as ClassificationProposal;
      await recordClassificationProposal(tx, {
        submissionId: input.submissionId,
        ...(evidenceForProposal === undefined ? {} : { evidenceId: evidenceForProposal }),
        proposal: classification,
      });
      if (classification.certainty_band === "high") {
        category = classification.proposed_category_id;
        notes.push(
          `a model proposed the category '${category}' with high certainty and it was applied without review; a model chose this, and nothing has confirmed it`,
        );
      } else {
        notes.push(
          `a model proposed '${classification.proposed_category_id}' with ${classification.certainty_band} certainty; it is pending review and was not applied, so this report keeps its fallback category`,
        );
      }
    }
  }

  if (input.resolveJurisdiction !== undefined && input.jurisdictionId !== undefined) {
    throw new Error(
      "a matching stage must use either versioned location resolution or an explicit test jurisdiction, not both",
    );
  }
  const jurisdictionResolution =
    input.resolveJurisdiction === undefined
      ? undefined
      : await input.resolveJurisdiction({
          lon: loaded.lon,
          lat: loaded.lat,
          accuracyMetres: loaded.accuracyMetres,
          observedAt: loaded.observedAt,
        });
  const effectiveJurisdictionId =
    jurisdictionResolution?.outcome === "resolved"
      ? jurisdictionResolution.selected?.jurisdictionId
      : input.jurisdictionId;
  if (jurisdictionResolution !== undefined) {
    notes.push(`jurisdiction resolution: ${jurisdictionResolution.reason}`);
  }

  const candidates = await retrieveCandidates(tx, {
    submissionId: input.submissionId,
    lon: loaded.lon,
    lat: loaded.lat,
    accuracyMetres: loaded.accuracyMetres,
    category,
    ...(effectiveJurisdictionId === undefined ? {} : { jurisdictionId: effectiveJurisdictionId }),
    ...(jurisdictionResolution !== undefined && effectiveJurisdictionId === undefined
      ? { onlyUnscopedJurisdiction: true }
      : {}),
    baseRadiusMetres: input.bounds.baseRadiusMetres,
    timeWindowHours: input.bounds.timeWindowHours,
    ...(embedding === undefined ? {} : { embedding: embedding.vector }),
  });
  // Recorded on the result, not just used: a reader who sees two reports not
  // matched needs to know which bounds were searched and that they are not
  // calibrated.
  notes.push(
    `retrieval used bounds '${input.bounds.version}' (${String(Math.round(candidates.diagnostics.radiusMetres))} m, ${String(candidates.diagnostics.timeWindowHours)} h): ${input.bounds.note}`,
  );

  const reused = await mediaReuseAgainst(
    tx,
    input.submissionId,
    candidates.candidates.map((candidate) => candidate.issueId),
  );

  const evidenceIds = await tx.query(
    "select evidence_id from evidence_item where submission_id = $1 and privacy_state = 'active'",
    [input.submissionId],
  );

  const proposal = proposeMatch({
    candidates: candidates.candidates.map((candidate) =>
      toSignals(candidate, loaded.accuracyMetres, reused),
    ),
    observedAt: loaded.observedAt,
    taxonomyVersion: input.taxonomy.version,
    evidenceIds: evidenceIds.rows.map((row) => String(row["evidence_id"])),
  });

  // ---- The short transactional commit (V028) ----
  const assignment = await assignSubmissionToIssue(tx, {
    submissionId: input.submissionId,
    participantId: loaded.participantId,
    lon: loaded.lon,
    lat: loaded.lat,
    accuracyMetres: loaded.accuracyMetres,
    category,
    ...(effectiveJurisdictionId === undefined ? {} : { jurisdictionId: effectiveJurisdictionId }),
    ...(jurisdictionResolution !== undefined && effectiveJurisdictionId === undefined
      ? { onlyUnscopedJurisdiction: true }
      : {}),
    observedAt: loaded.observedAt,
    proposal,
    candidateIdsSeen: candidates.candidates.map((candidate) => candidate.issueId),
    // The recheck must search exactly the bounds retrieval searched. Its own
    // default is wider, and a wider recheck finds candidates retrieval never
    // saw — making every decision "stale" and the rerun loop endless. The
    // diagnostics carry the radius actually used, so there is no second guess.
    radiusMetres: candidates.diagnostics.radiusMetres,
    // Same value as the recheck's own default today, so no test can
    // distinguish it — passed anyway, because the alignment is the point and
    // either default could change independently.
    timeWindowHours: candidates.diagnostics.timeWindowHours,
  });

  if (assignment.status === "stale") {
    // The world changed between the proposal and the recheck. Retryable, and
    // recorded as such rather than committed on stale data.
    await failStage(tx, lease.lease, "candidates_changed_rerun_required");
    return { status: "failed", reason: assignment.reason };
  }

  let issueId: string | undefined;
  let outcome: "created" | "attached" | "needs_review";
  if (assignment.status === "created") {
    issueId = assignment.issueId;
    outcome = "created";
  } else if (assignment.status === "attached") {
    issueId = assignment.issueId;
    outcome = "attached";
  } else {
    outcome = "needs_review";
    notes.push("the match was ambiguous, so a reviewer must decide which issue this belongs to");
  }

  if (issueId !== undefined) {
    // A new issue inherits this report's vector so V026 can rerank against it.
    if (assignment.status === "created" && embedding !== undefined) {
      await tx.query(
        `update canonical_issue
            set representative_embedding = $2::vector,
                representative_embedding_model = $3
          where issue_id = $1 and representative_embedding is null`,
        [issueId, JSON.stringify([...embedding.vector]), embedding.model],
      );
    }
    if (effectiveJurisdictionId !== undefined) {
      await tx.query(
        "update canonical_issue set jurisdiction_id = $2 where issue_id = $1 and jurisdiction_id is null",
        [issueId, effectiveJurisdictionId],
      );
    }

    // ---- V029, with V014's eligibility actually connected ----
    const participant = await tx.query(
      "select participant_id, created_at, tombstoned_at from participant where participant_id = $1",
      [loaded.participantId],
    );
    const verdict = evaluateParticipationEligibility({
      participant: {
        participant_id: loaded.participantId as never,
        created_at: new Date(String(participant.rows[0]?.["created_at"])).toISOString() as never,
        ...(participant.rows[0]?.["tombstoned_at"] === null ||
        participant.rows[0]?.["tombstoned_at"] === undefined
          ? {}
          : {
              tombstoned_at: new Date(
                String(participant.rows[0]["tombstoned_at"]),
              ).toISOString() as never,
            }),
      },
      // The submission was accepted on a valid session (V018 refuses
      // otherwise), so by the time this stage runs that is settled fact.
      hasValidSession: true,
      grantedPurposes: await activeConsentPurposes(tx, loaded.participantId),
      identityProviderMode: "simulated",
    });

    await recordParticipation(tx, {
      participantId: loaded.participantId,
      issueId,
      evidenceAt: loaded.observedAt,
      eligibility: verdict.counted
        ? { verdict: "eligible", reasons: ["evaluated by the V014 eligibility rules"] }
        : { verdict: "not_counted", reasons: [verdict.reason] },
    });
    if (!verdict.counted) {
      notes.push(`this contribution is recorded but not counted: ${verdict.reason}`);
    }
  }

  // ---- V025: evaluate the trust checks and store them ----
  //
  // V025 recorded "nothing consumes these checks yet". They ran here in the
  // domain and were discarded, so no reviewer ever saw one. Stored now, with
  // one property that matters more than the storing: `requires_review` follows
  // only from an *inconsistent* check. A stripped photograph produces
  // `unknown`, and an unknown never flags anybody (see `recordTrustSignalReport`).
  const media = await tx.query(
    `select e.evidence_id, e.captured_at
       from evidence_item e
      where e.submission_id = $1 and e.media_type = 'photo' and e.privacy_state = 'active'
      order by e.ingested_at asc`,
    [input.submissionId],
  );
  const firstPhoto = media.rows[0];
  // Reuse against *any* prior evidence, not only the candidate issues.
  // `reused` above answers a narrower question — which candidates share bytes
  // with this report — and using it here would miss a photograph reused from
  // somewhere the retrieval never looked, which is the case the check is for.
  const reuseElsewhere = (
    await tx.query(
      `select distinct theirs.evidence_id
         from evidence_item mine
         join evidence_item theirs
                on theirs.fingerprint_hash = mine.fingerprint_hash
               and theirs.evidence_id <> mine.evidence_id
        where mine.submission_id = $1
          and mine.fingerprint_hash is not null
          and mine.privacy_state = 'active'
          and theirs.privacy_state = 'active'`,
      [input.submissionId],
    )
  ).rows.map((row) => String(row["evidence_id"]));
  // The eligible-participant count is now live (V029), so the corroboration
  // input is no longer a fixture — and saying it still was would understate
  // what the system actually knows.
  const eligible =
    issueId === undefined
      ? 0
      : Number(
          (
            await tx.query(
              "select count(*)::int as n from issue_participation where canonical_issue_id = $1 and counted",
              [issueId],
            )
          ).rows[0]?.["n"] ?? 0,
        );

  const trust = evaluateTrustSignals({
    capture: {
      source: loaded.locationSource,
      accuracyMetres: loaded.accuracyMetres,
      observedAt: loaded.observedAt,
      submittedAt: loaded.submittedAt,
    },
    media: {
      hasPhoto: media.rows.length > 0,
      captureTimestampPresent: firstPhoto?.["captured_at"] !== null && firstPhoto !== undefined,
      capturedAt:
        firstPhoto === undefined || firstPhoto["captured_at"] === null
          ? undefined
          : new Date(String(firstPhoto["captured_at"])).toISOString(),
      fingerprintSeenBefore: reuseElsewhere.length > 0,
      otherEvidenceIds: reuseElsewhere,
    },
    // No image-description check: that needs a vision call, and inventing a
    // verdict without one would be asserting a comparison nothing performed.
    descriptionConsistency: undefined,
    corroboration: { eligibleParticipants: eligible, inputIsFixture: false },
  });
  await recordTrustSignalReport(tx, {
    submissionId: input.submissionId,
    canonicalIssueId: issueId,
    report: trust,
  });
  if (trust.requiresReview) {
    notes.push(
      `a consistency check did not line up, so this is in the review queue: ${trust.reviewReasons.join("; ")}`,
    );
  }

  // ---- V033 ----
  let routing: RoutingResult | undefined;
  let jurisdictionResolutionId: string | undefined;
  if (jurisdictionResolution !== undefined) {
    let appliedToIssue = false;
    if (issueId !== undefined && jurisdictionResolution.outcome === "resolved") {
      const assigned = await tx.query(
        "select jurisdiction_id from canonical_issue where issue_id = $1",
        [issueId],
      );
      appliedToIssue =
        assigned.rows[0]?.["jurisdiction_id"] !== null &&
        String(assigned.rows[0]?.["jurisdiction_id"]) ===
          jurisdictionResolution.selected?.jurisdictionId;
      if (!appliedToIssue) {
        notes.push(
          "the location resolved, but it conflicts with the issue's existing jurisdiction; the existing scope was preserved for review",
        );
      }
    }
    jurisdictionResolutionId = await recordJurisdictionResolution(tx, {
      submissionId: input.submissionId,
      issueId,
      appliedToIssue,
      resolution: jurisdictionResolution,
    });
  }
  if (issueId !== undefined) {
    routing = await resolveRouting(tx, {
      issueId,
      directoryVersion: input.directoryVersion,
      ...(jurisdictionResolutionId === undefined ? {} : { jurisdictionResolutionId }),
    });
    if (routing.outcome !== "routed") {
      notes.push(`routing did not find an owner: ${routing.reason}`);
    }
  }

  await completeStage(tx, lease.lease, {
    pipeline_version: MATCHING_PIPELINE_VERSION,
    assignment: outcome,
    issue_id: issueId ?? null,
    candidate_count: candidates.candidates.length,
    embedding_available: embedding !== undefined,
    routing_outcome: routing?.outcome ?? null,
    jurisdiction_outcome: jurisdictionResolution?.outcome ?? null,
    boundary_version: jurisdictionResolution?.boundaryVersion ?? null,
    matcher_version: proposal.matcherVersion,
  });

  return {
    status: "completed",
    assignment: outcome,
    issueId,
    routing,
    jurisdictionResolution,
    embeddingAvailable: embedding !== undefined,
    candidateCount: candidates.candidates.length,
    notes,
  };
};
