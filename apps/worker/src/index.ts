/**
 * Private worker service (roadmap V006 D3, V017).
 *
 * No public ingress: it is invoked only by the authenticated outbox relay
 * (V006 §7).
 *
 * This was a placeholder that said so — `not_implemented_no_stages_registered`
 * — and the consequence was that a citizen submitted a report, received a
 * durable receipt, and then nothing happened to it. The
 * `process_submission_media` task that `submissions.ts` enqueues in the same
 * commit as every submission sat in `outbox` forever. Every stage was built and
 * tested; none of them ran.
 *
 * It now registers two stages (`./handlers.ts`) and runs them through the relay
 * (`./relay.ts`):
 *
 *   submission_received -> process_submission_media -> match_submission
 *
 * Two things are still configuration rather than capability, and a reader of
 * this process should know both:
 *
 *  * **The Hackathon jurisdiction is derived from a versioned synthetic
 *    boundary pack.** Ambiguous, outside-profile and low-accuracy edge cases
 *    remain unscoped for review. V060 replaces the synthetic geometry with
 *    partner-reviewed pilot boundaries.
 *  * **Classification and transcription run only where a key is configured.**
 *    Without one the stage uses the fallback category and records it as the
 *    fallback it is; the report is still processed, grouped and routed.
 */

export { buildStageHandlers, type StageDeployment } from "./handlers.ts";
export {
  runRelayOnce,
  type RelayPass,
  type StageHandler,
  type StageHandlers,
  type StageOutcome,
  type StageTask,
} from "./relay.ts";

/**
 * The task types this worker serves.
 *
 * Exported so a relay can narrow its claim to them. Claiming a task type no
 * handler serves means claiming work that cannot be done; omitting one a
 * handler serves means that work is never claimed at all.
 */
export const REGISTERED_TASK_TYPES = ["process_submission_media", "match_submission"] as const;

export const WORKER_STATUS = "stages_registered" as const;

export const describeWorker = (): string =>
  "vision private worker: registers process_submission_media (V021/V022 media decoding, " +
  "derivatives and redaction) and match_submission (V026-V033 retrieval, duplicate proposal, " +
  "transactional assignment, participation counting, trust checks and routing). " +
  "The jurisdiction is resolved from the configured versioned boundary pack; uncertain edges are " +
  "left for review rather than guessed. Classification and transcription run only " +
  "where an API key is configured; without one a report is still processed on its fallback category.";
