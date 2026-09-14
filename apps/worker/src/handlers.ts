/**
 * The stage handlers (roadmap V021, V022, V026–V033).
 *
 * These are what `apps/worker` was missing. Each one is small on purpose: it
 * turns an outbox task into a call on a service that already exists and is
 * already tested. The value here is not new logic, it is that the logic
 * finally runs.
 *
 * The chain is two stages rather than one, because that is what the outbox is
 * for: each is independently retryable, so a slow classification does not force
 * the media work to be redone when it is retried.
 *
 *   submission_received -> process_submission_media -> match_submission
 *
 * A text-only report still goes through both. Most reports have no photograph,
 * and a media stage that only continued the chain when there was an image to
 * decode would quietly drop the majority of reports.
 */

import type { FilesystemObjectStoreAdapter, Queryable } from "@vision/adapters";
import {
  MediaProcessingService,
  runMatchingStage,
  type ClassifyText,
  type MatchingStageBounds,
  type ResolveJurisdiction,
  type Taxonomy,
} from "@vision/adapters";

import type { StageHandlers } from "./relay.ts";

export type StageDeployment = {
  readonly client: Queryable;
  readonly objectStore: FilesystemObjectStoreAdapter;
  /** Test-only escape hatch; the development deployment resolves the report's point. */
  readonly jurisdictionId: string | undefined;
  readonly resolveJurisdiction?: ResolveJurisdiction | undefined;
  /** Used until something classifies the report, and recorded as a fallback. */
  readonly fallbackCategory: string;
  readonly directoryVersion: string;
  readonly bounds: MatchingStageBounds;
  readonly taxonomy: Taxonomy;
  /** Present only when this deployment has an API key (V023). */
  readonly classify?: ClassifyText | undefined;
  readonly embed?: Parameters<typeof runMatchingStage>[1]["embed"];
  readonly classificationModelName?: string;
};

/**
 * The submission a task is about.
 *
 * The payload is checked first, and the event is the fallback — but in
 * practice the event *is* the source, because `submissions.ts` enqueues
 * `[{ task_type: "process_submission_media" }]` with no payload at all. A
 * handler that required the payload field refused every real report with "the
 * task carries no submission_id", which is how this was found: by running the
 * worker against a report submitted through the API, not by a test.
 *
 * Resolving from `status_event.aggregate_id` also works for rows already
 * sitting in the queue, which changing the producer alone would not.
 */
const submissionFor = async (
  client: Queryable,
  task: { readonly payload: Record<string, unknown>; readonly eventId: string },
): Promise<string | undefined> => {
  const fromPayload = task.payload["submission_id"];
  if (typeof fromPayload === "string" && fromPayload.length > 0) return fromPayload;

  const { rows } = await client.query(
    `select aggregate_id from status_event
      where event_id = $1 and aggregate_type = 'Submission'`,
    [task.eventId],
  );
  const aggregateId = rows[0]?.["aggregate_id"];
  return aggregateId === undefined || aggregateId === null ? undefined : String(aggregateId);
};

export const buildStageHandlers = (deployment: StageDeployment): StageHandlers => {
  const media = new MediaProcessingService(deployment.client, deployment.objectStore as never);

  return {
    /**
     * Decodes and redacts the photographs on a submission, then hands on.
     *
     * Each photograph is processed separately: one undecodable image must not
     * stop the rest of the report, and V021 leaves an unresolved item
     * quarantined rather than failing the submission.
     */
    process_submission_media: async (task, deps) => {
      const submissionId = await submissionFor(deployment.client, task);
      if (submissionId === undefined) {
        return {
          outcome: "refused",
          reason: "neither the task payload nor its event names a submission",
        };
      }

      const { rows } = await deployment.client.query(
        `select evidence_id from evidence_item
          where submission_id = $1 and media_type = 'photo' and privacy_state = 'active'
          order by ingested_at asc`,
        [submissionId],
      );

      const notes: string[] = [];
      for (const row of rows) {
        const outcome = await media.processEvidence({
          evidenceId: String(row["evidence_id"]),
          // The object store refuses a vague purpose, and the access is
          // audited — reading a private original is never incidental (V015).
          purpose: "process_submitted_media_for_derivatives",
          owner: `worker:media:${task.outboxId}`,
        });
        if (!outcome.ok && !outcome.alreadyProcessed) {
          notes.push(...outcome.reasons);
        }
      }

      // Handed on whether or not there were photographs, and whether or not
      // they all decoded: a report whose image was unreadable is still a
      // report, and the words in it still describe a problem.
      const next = await deps.enqueueNext({
        aggregateType: "Submission",
        aggregateId: submissionId,
        eventType: "submission_media_processed",
        taskType: "match_submission",
        payload: {
          submission_id: submissionId,
          photo_count: rows.length,
          unresolved_count: notes.length,
        },
      });
      void next;
      return { outcome: "done" };
    },

    /** Retrieval, the duplicate proposal, the commit, participation, trust and routing. */
    match_submission: async (task) => {
      const submissionId = await submissionFor(deployment.client, task);
      if (submissionId === undefined) {
        return {
          outcome: "refused",
          reason: "neither the task payload nor its event names a submission",
        };
      }

      const result = await runMatchingStage(deployment.client, {
        submissionId,
        jurisdictionId: deployment.jurisdictionId,
        ...(deployment.resolveJurisdiction === undefined
          ? {}
          : { resolveJurisdiction: deployment.resolveJurisdiction }),
        taxonomy: deployment.taxonomy,
        directoryVersion: deployment.directoryVersion,
        fallbackCategory: deployment.fallbackCategory,
        bounds: deployment.bounds,
        owner: `worker:matching:${task.outboxId}`,
        ...(deployment.classify === undefined ? {} : { classify: deployment.classify }),
        ...(deployment.classificationModelName === undefined
          ? {}
          : { classificationModelName: deployment.classificationModelName }),
        ...(deployment.embed === undefined ? {} : { embed: deployment.embed }),
      });

      if (result.status === "already_processed") {
        // An earlier delivery did this. Acknowledged rather than retried:
        // this is the crash window V017 exists for.
        return { outcome: "already_processed" };
      }
      if (result.status === "failed") {
        return { outcome: "refused", reason: result.reason };
      }
      return { outcome: "done" };
    },
  };
};
