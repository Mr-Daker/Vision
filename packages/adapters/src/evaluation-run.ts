/**
 * Running a reviewed corpus through the deployed pipeline (roadmap V046).
 *
 * The thing being measured has to be the thing that runs. So this does not
 * reimplement classification, retrieval, assignment or routing — it inserts
 * each corpus row as an ordinary submission and calls `runMatchingStage`, the
 * same function `apps/worker` calls for a report a citizen filed. A harness
 * that reimplemented any stage would measure the harness.
 *
 * Three properties this file exists to give the run:
 *
 *  * **The corpus is injected, never loaded.** Nothing here can reach the
 *    sealed holdout; only `apps/eval` may, and it has to say why. That keeps
 *    `tools/check-holdout-seal.mjs` meaningful instead of allowlisting the
 *    whole adapter layer.
 *
 *  * **Observations come from the provider's own reply.** Latency, HTTP status
 *    and token counts are read off the call by a recording transport wrapped
 *    around the adapter's, not estimated afterwards. The adapter is unchanged
 *    and unaware.
 *
 *  * **What the model proposed and what the system applied are kept apart.**
 *    `runMatchingStage` applies a proposed category only at the `high` band;
 *    anything less is recorded and not used. Those are two different answers
 *    and V046 has to score both, or a system that abstains correctly would be
 *    indistinguishable from one that never had an opinion.
 */

import { randomUUID } from "node:crypto";

import type { ClassificationProposal } from "@vision/contracts";
import { unsupportedStatements, type UnsupportedStatement } from "@vision/domain";

import type { Queryable } from "./outbox.ts";
import { runMatchingStage, type MatchingStageInput } from "./matching-pipeline.ts";
import { resolveRouting, type RoutingResult } from "./routing.ts";
import type { GeminiTransport } from "./gemini.ts";

// ---------------------------------------------------------------------------
// 1. The corpus row, structurally
// ---------------------------------------------------------------------------

/**
 * A corpus row, as a structural type.
 *
 * Deliberately not an import from `@vision/fixtures`: adapters may import
 * contracts, domain and media only (V006 §9), and the fixtures package is
 * where the seal lives. Describing the shape keeps the direction intact.
 */
export type EvaluationRow = {
  readonly report_id: string;
  readonly source_language: string;
  readonly interface_locale: string;
  readonly asset_id: string;
  readonly observed: {
    readonly lon: number;
    readonly lat: number;
    readonly accuracy_m: number;
    readonly observed_at: string;
  };
  readonly text: string;
  readonly expected: {
    readonly category_id: string | null;
    readonly defect_id: string | null;
    readonly department_id?: string;
    readonly routing_review_expected?: boolean;
    readonly needs_review_expected?: boolean;
  };
  readonly reviewer: {
    readonly decision: string;
    readonly reviewed_by: string;
    readonly reviewed_at: string | null;
    readonly notes: string;
  };
  readonly unresolved_labels: readonly string[];
};

// ---------------------------------------------------------------------------
// 2. Recording what the provider actually did
// ---------------------------------------------------------------------------

export type ProviderCall = {
  readonly operation: "classification" | "embedding";
  /** Which corpus row this call was made for. Set by the caller before the call. */
  readonly subject: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly promptTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  /** The model version the provider reports back, which may not be the one asked for. */
  readonly modelVersion: string | undefined;
  /** Claim language found in the reply. The excerpt is bounded; the reply never travels. */
  readonly statementFindings: readonly UnsupportedStatement[];
};

export type RecordingTransport = {
  readonly transport: GeminiTransport;
  readonly calls: readonly ProviderCall[];
  /** Names the row the next call belongs to. */
  setSubject: (subject: string) => void;
};

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readUsage = (
  payload: unknown,
): { prompt: number | undefined; output: number | undefined; total: number | undefined } => {
  if (typeof payload !== "object" || payload === null) {
    return { prompt: undefined, output: undefined, total: undefined };
  }
  const usage = (payload as { usageMetadata?: unknown }).usageMetadata;
  if (typeof usage !== "object" || usage === null) {
    return { prompt: undefined, output: undefined, total: undefined };
  }
  const record = usage as Record<string, unknown>;
  return {
    prompt: readNumber(record["promptTokenCount"]),
    output: readNumber(record["candidatesTokenCount"]),
    total: readNumber(record["totalTokenCount"]),
  };
};

const readModelVersion = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const version = (payload as { modelVersion?: unknown }).modelVersion;
  return typeof version === "string" && version.length > 0 ? version : undefined;
};

/** Every piece of text the model produced, concatenated for scanning only. */
const readReplyText = (payload: unknown): string => {
  if (typeof payload !== "object" || payload === null) return "";
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return "";
  const parts: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const content = (candidate as { content?: unknown }).content;
    if (typeof content !== "object" || content === null) continue;
    const contentParts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(contentParts)) continue;
    for (const part of contentParts) {
      if (typeof part !== "object" || part === null) continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
};

/**
 * Wraps a transport so a run records itself.
 *
 * The response body is read once here and handed to the adapter as an
 * already-resolved value, because a `json()` that can only be consumed once
 * would otherwise be consumed by whichever of the two read it first.
 */
export const createRecordingTransport = (
  inner: GeminiTransport,
  operation: ProviderCall["operation"],
): RecordingTransport => {
  const calls: ProviderCall[] = [];
  let subject = "(unattributed)";

  const transport: GeminiTransport = async (url, init) => {
    const startedAt = process.hrtime.bigint();
    const response = await inner(url, init);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const usage = readUsage(payload);
    calls.push({
      operation,
      subject,
      status: response.status,
      latencyMs,
      promptTokens: usage.prompt,
      outputTokens: usage.output,
      totalTokens: usage.total,
      modelVersion: readModelVersion(payload),
      statementFindings:
        operation === "classification" ? unsupportedStatements(readReplyText(payload)) : [],
    });
    return { status: response.status, json: async () => payload };
  };

  return {
    transport,
    calls,
    setSubject: (next: string) => {
      subject = next;
    },
  };
};

// ---------------------------------------------------------------------------
// 3. Putting a corpus row into the pipeline's own input
// ---------------------------------------------------------------------------

/**
 * Writes one corpus row as an ordinary submission.
 *
 * It goes in exactly as a citizen's report does — participant, consent, a
 * located submission, one piece of text evidence — because anything special
 * about the row would be something the measurement was not measuring. The
 * corpus supplies the accuracy figure, including the deliberately poor ones.
 */
export const insertEvaluationSubmission = async (
  tx: Queryable,
  row: EvaluationRow,
  options: { readonly localePackVersion: string; readonly taxonomyVersion: string },
): Promise<{ readonly submissionId: string; readonly participantId: string }> => {
  const participantId = randomUUID();
  await tx.query("insert into participant (participant_id) values ($1)", [participantId]);
  await tx.query(
    `insert into consent_record
       (consent_id, participant_id, notice_version, notice_locale,
        granted_purposes, granted_at)
     values ($1,$2,'notice.v1',$3, ARRAY['demo_processing']::text[], now())`,
    [randomUUID(), participantId, row.interface_locale],
  );

  const submissionId = randomUUID();
  await tx.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, language_hint,
        locale_pack_version, taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, $5,
             'device_geolocation', $6::timestamptz, $7, $8, $9, $10, $11)`,
    [
      submissionId,
      participantId,
      row.observed.lon,
      row.observed.lat,
      row.observed.accuracy_m,
      row.observed.observed_at,
      row.interface_locale,
      row.source_language,
      options.localePackVersion,
      options.taxonomyVersion,
      `eval-${row.report_id}-${submissionId}`,
    ],
  );
  await tx.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text',$3)`,
    [randomUUID(), submissionId, row.text],
  );
  return { submissionId, participantId };
};

// ---------------------------------------------------------------------------
// 4. One row through the pipeline
// ---------------------------------------------------------------------------

export type RowObservation = {
  readonly reportId: string;
  readonly submissionId: string;
  readonly sourceLanguage: string;
  readonly stageStatus: "completed" | "already_processed" | "failed";
  readonly failureReason: string | undefined;
  readonly assignment: "created" | "attached" | "needs_review" | undefined;
  readonly issueId: string | undefined;
  readonly candidateCount: number;
  /** What the model said, at whatever band it said it. */
  readonly proposal: ClassificationProposal | undefined;
  readonly classificationUnavailableReason: string | undefined;
  /** What the system actually used. Differs from the proposal below the high band. */
  readonly appliedCategory: string | undefined;
  readonly routing: RoutingResult | undefined;
  readonly notes: readonly string[];
};

export type CorpusRunOptions = {
  readonly rows: readonly EvaluationRow[];
  readonly localePackVersion: string;
  readonly taxonomyVersion: string;
  readonly stage: Omit<MatchingStageInput, "submissionId" | "classify" | "owner">;
  /**
   * The classifier under evaluation. Wrapped here so the proposal is captured
   * per row; the pipeline's own copy is the same function.
   */
  readonly classify:
    | ((
        text: string,
      ) => Promise<
        | { readonly outcome: "classified"; readonly proposal: ClassificationProposal }
        | { readonly outcome: "unavailable"; readonly reasonCode: string }
      >)
    | undefined;
  /** Called before each row so a caller can pace against a rate limit. */
  readonly beforeRow?: (row: EvaluationRow, index: number) => Promise<void>;
};

/**
 * Runs the corpus in order.
 *
 * Order matters and is the corpus's own: the second half of a duplicate pair
 * can only retrieve the first half's issue if the first half has already been
 * processed. Running these concurrently would measure a race.
 */
export const runEvaluationCorpus = async (
  client: Queryable,
  options: CorpusRunOptions,
): Promise<readonly RowObservation[]> => {
  const observations: RowObservation[] = [];

  for (const [index, row] of options.rows.entries()) {
    if (options.beforeRow !== undefined) await options.beforeRow(row, index);

    const { submissionId } = await insertEvaluationSubmission(client, row, {
      localePackVersion: options.localePackVersion,
      taxonomyVersion: options.taxonomyVersion,
    });

    let proposal: ClassificationProposal | undefined;
    let unavailableReason: string | undefined;
    const classifier = options.classify;
    const capturing =
      classifier === undefined
        ? undefined
        : async (text: string) => {
            const answer = await classifier(text);
            if (answer.outcome === "classified") proposal = answer.proposal;
            else unavailableReason = answer.reasonCode;
            return answer;
          };

    const result = await runMatchingStage(client, {
      ...options.stage,
      submissionId,
      ...(capturing === undefined ? {} : { classify: capturing }),
      owner: `eval:${row.report_id}`,
    });

    if (result.status !== "completed") {
      observations.push({
        reportId: row.report_id,
        submissionId,
        sourceLanguage: row.source_language,
        stageStatus: result.status,
        failureReason: result.status === "failed" ? result.reason : undefined,
        assignment: undefined,
        issueId: undefined,
        candidateCount: 0,
        proposal,
        classificationUnavailableReason: unavailableReason,
        appliedCategory: undefined,
        routing: undefined,
        notes: [],
      });
      continue;
    }

    // Read the category the system actually committed rather than inferring it
    // from the proposal: the high-band gate lives in the pipeline, and a
    // harness that reimplemented the gate could not detect the gate changing.
    let appliedCategory: string | undefined;
    if (result.issueId !== undefined) {
      const { rows } = await client.query(
        "select category from canonical_issue where issue_id = $1",
        [result.issueId],
      );
      const value = rows[0]?.["category"];
      appliedCategory = value === undefined || value === null ? undefined : String(value);
    }

    observations.push({
      reportId: row.report_id,
      submissionId,
      sourceLanguage: row.source_language,
      stageStatus: "completed",
      failureReason: undefined,
      assignment: result.assignment,
      issueId: result.issueId,
      candidateCount: result.candidateCount,
      proposal,
      classificationUnavailableReason: unavailableReason,
      appliedCategory,
      routing: result.routing,
      notes: result.notes,
    });
  }

  return observations;
};

// ---------------------------------------------------------------------------
// 5. Routing the directory would have chosen from the reviewed label
// ---------------------------------------------------------------------------

/**
 * Routes an issue as if the reviewed category had been the working one.
 *
 * Without this, a routing error is unattributable: an issue sent to the wrong
 * department may have a correct directory and a wrong category, or the other
 * way round, and those have completely different fixes. The probe forces the
 * reviewed label in, resolves, and rolls the whole thing back, so neither the
 * category nor the routing row it writes survives to affect anything else.
 */
export const routeFromReviewedLabel = async (
  client: Queryable,
  input: {
    readonly issueId: string;
    readonly reviewedCategory: string;
    readonly directoryVersion: string;
  },
): Promise<RoutingResult | { readonly probeFailed: string }> => {
  await client.query("begin");
  try {
    await client.query("update canonical_issue set category = $2 where issue_id = $1", [
      input.issueId,
      input.reviewedCategory,
    ]);
    const routing = await resolveRouting(client, {
      issueId: input.issueId,
      directoryVersion: input.directoryVersion,
    });
    return routing;
  } catch (error) {
    return { probeFailed: error instanceof Error ? error.message : String(error) };
  } finally {
    // Always. The probe exists to ask a question, never to change an answer.
    await client.query("rollback").catch(() => undefined);
  }
};

// ---------------------------------------------------------------------------
// 6. Did the pipeline put two reports on one issue?
// ---------------------------------------------------------------------------

export type PairOutcome = {
  readonly relationId: string;
  readonly retrieved: boolean;
  readonly merged: boolean;
  readonly detail: string;
};

/**
 * Scores one reviewer-labelled pair from what the pipeline did.
 *
 * `retrieved` is answered from the candidate count on the later report rather
 * than from the merge: a pipeline that retrieved the right issue and then
 * declined to merge is a different system from one that never saw it, and
 * V046 asks for those to be measured separately.
 */
export const pairOutcomeOf = (input: {
  readonly relationId: string;
  readonly first: RowObservation | undefined;
  readonly second: RowObservation | undefined;
}): PairOutcome => {
  const { relationId, first, second } = input;
  if (first === undefined || second === undefined) {
    return {
      relationId,
      retrieved: false,
      merged: false,
      detail: "one side of this pair was not run, so the pair says nothing",
    };
  }
  const merged =
    first.issueId !== undefined && second.issueId !== undefined && first.issueId === second.issueId;
  const retrieved = merged || second.candidateCount > 0;
  const detail = merged
    ? "both reports were attached to one issue"
    : second.candidateCount > 0
      ? `${String(second.candidateCount)} candidate(s) were retrieved for the later report and it was still opened separately (assignment: ${second.assignment ?? "none"})`
      : "no candidate was retrieved for the later report";
  return { relationId, retrieved, merged, detail };
};
