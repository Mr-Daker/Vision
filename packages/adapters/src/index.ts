/**
 * @vision/adapters — provider adapter implementations (V009, V010).
 *
 * Import direction rule (V006 §9): adapters may import @vision/contracts and
 * @vision/domain. They must never import an application.
 *
 * Every adapter here is simulated or synthetic. Real providers (V023 Gemini,
 * V057 identity, V058 recipient) implement the same ports and are handed to
 * the same contract suites in contract-tests.ts.
 */

export * from "./ports.ts";
export * from "./identity.ts";
export * from "./sessions.ts";
export * from "./recipient.ts";
export * from "./sources.ts";
export * from "./object-store.ts";
export * from "./outbox.ts";
export * from "./submissions.ts";
export * from "./postgres-repositories.ts";

// contract-tests.ts is deliberately NOT re-exported: it imports node:test, and
// production code must never pull the test runner into its module graph. Test
// files import it directly.

export * from "./ai-cache.ts";
export * from "./gemini.ts";
export * from "./proposals.ts";
export * from "./media-pipeline.ts";
export * from "./media-processing.ts";
export * from "./gemini-transcription.ts";
export * from "./corroboration.ts";
export * from "./candidates.ts";
export * from "./issue-assignment.ts";
export * from "./participation-counts.ts";
export * from "./citizen-views.ts";
export * from "./citizen-confirmation.ts";
export * from "./review-queue.ts";
export * from "./staff-grants.ts";
export * from "./routing.ts";
export * from "./jurisdictions.ts";
export * from "./staff-inbox.ts";
export * from "./supervisor-queues.ts";
export * from "./issue-lifecycle.ts";
export * from "./resolution.ts";
export * from "./matching-pipeline.ts";
export * from "./consent.ts";

export * from "./analytics-metrics.ts";
export * from "./analytics-doc.ts";
export * from "./summaries.ts";
export * from "./dashboard.ts";
export * from "./context-import.ts";
export * from "./project-links.ts";
export * from "./prioritization.ts";
export * from "./comparison.ts";
export * from "./privacy-audit.ts";
export * from "./erasure.ts";
export * from "./evaluation-run.ts";
