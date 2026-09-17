/**
 * The held-out evaluation run (roadmap V046).
 *
 * This is the only file in the repository permitted to unseal the V011
 * holdout, and `tools/check-holdout-seal.mjs` enforces that. Everything the
 * run needs is composed here and injected downward, so no adapter, no worker
 * and no test can reach the corpus by accident.
 *
 * Four properties of the run, each of them a decision:
 *
 *  * **A disposable database.** The holdout must never enter a seeded
 *    database; a rolled-back transaction would not do, because the pipeline's
 *    assignment step opens its own SERIALIZABLE transaction and would commit
 *    the caller's. So the run creates a database, migrates it, uses it and
 *    drops it. Nothing the demo reads is touched, and the drop is in a
 *    `finally`.
 *
 *  * **The deployed path, not a copy of it.** Each row is inserted as an
 *    ordinary submission and handed to `runMatchingStage` — the same call
 *    `apps/worker` makes. The classifier and the embedder are the real Gemini
 *    adapters behind a recording transport.
 *
 *  * **The rehearsal split is allowed and is never disguised.** `--split
 *    development` runs the same harness against the corpus the pipeline was
 *    built on, which is how the harness itself is tested. The verdict refuses
 *    to call the result a held-out measurement.
 *
 *  * **The reason is recorded.** The seal requires one and it goes into the
 *    run record, so an unsealing is attributable afterwards.
 *
 * Usage:
 *   VISION_EVAL_RUN=1 npm run eval:holdout -- --reason "V046 scored run" [--split development] [--provider stub]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  GeminiClassificationAdapter,
  GeminiEmbeddingAdapter,
  CLASSIFICATION_PROMPT_VERSION,
  DEFAULT_RETRY_POLICY,
  createRecordingTransport,
  pairOutcomeOf,
  resolveJurisdictionAtLocation,
  routeFromReviewedLabel,
  runEvaluationCorpus,
  type EvaluationRow,
  type ProviderCall,
  type RoutingResult,
  type RowObservation,
} from "@vision/adapters";
import {
  loadMatchingBounds,
  loadRoutingDirectory as loadDeploymentRouting,
  loadTaxonomy as loadDeploymentTaxonomy,
} from "@vision/config-packs";
import { newCorrelationId, unsafeBcp47 } from "@vision/contracts";
import { costStatement, qualityClaimVerdict, type ProviderUsage } from "@vision/domain";
import {
  loadDevelopmentCorpus,
  loadHoldoutCorpus,
  loadRelations,
  loadResponsibilityDirectory,
  loadTaxonomy,
  type ReportCorpus,
} from "@vision/fixtures";

import { readRunHistory } from "./history.ts";
import { seedCorpusStructure } from "./structure.ts";
import { renderReport } from "./report.ts";
import { scoreRow, summarise, type RowScore } from "./score.ts";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argOf = (name: string): string | undefined => {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  return inline === undefined ? undefined : inline.slice(flag.length + 1);
};

const reason = argOf("reason") ?? "";
const split = argOf("split") === "development" ? "development" : "holdout";
const providerMode = argOf("provider") === "stub" ? "stub" : "real";
const outputDirectory = argOf("out") ?? "deliverables";

if (reason.trim().length < 8) {
  console.error(
    [
      "a V046 run requires --reason with at least 8 characters.",
      "",
      "The reason is recorded in the run record and in the seal read, so an",
      "unsealing of the holdout is attributable to a purpose afterwards.",
    ].join("\n"),
  );
  process.exit(64);
}

// ---------------------------------------------------------------------------
// The disposable database
// ---------------------------------------------------------------------------

const baseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const runId = `${new Date()
  .toISOString()
  .replace(/[^0-9]/g, "")
  .slice(0, 14)}`;
const evaluationDatabase = `vision_eval_${runId}`;

const urlFor = (database: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

const adminClient = new pg.Client({ connectionString: urlFor("postgres") });
await adminClient.connect();
await adminClient.query(`create database ${evaluationDatabase}`);
console.log(`created disposable evaluation database ${evaluationDatabase}`);

const dropDatabase = async (): Promise<void> => {
  await adminClient
    .query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [evaluationDatabase],
    )
    .catch(() => undefined);
  await adminClient
    .query(`drop database if exists ${evaluationDatabase}`)
    .catch((error: unknown) => {
      console.error(`could not drop ${evaluationDatabase}: ${String(error)}`);
    });
  await adminClient.end().catch(() => undefined);
};

const client = new pg.Client({ connectionString: urlFor(evaluationDatabase) });

try {
  // --- migrate ---
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, ["tools/db.mjs", "migrate"], {
    env: { ...process.env, DATABASE_URL: urlFor(evaluationDatabase) },
    stdio: "inherit",
  });

  await client.connect();
  const structure = await seedCorpusStructure(client);
  console.log(
    `seeded structure: ${String(structure.jurisdictions)} jurisdictions, ${String(structure.assets)} assets, ${String(structure.responsibilityRules)} routing rules`,
  );

  // --- the corpus ---
  const corpus: ReportCorpus =
    split === "holdout" ? loadHoldoutCorpus(reason) : loadDevelopmentCorpus();
  const rows = corpus.reports as readonly EvaluationRow[];
  const relations = loadRelations();
  const taxonomy = loadTaxonomy();
  const deploymentProfile = process.env["JURISDICTION_PROFILE_ID"] ?? "demo-district-a";
  const bounds = loadMatchingBounds(deploymentProfile);

  // A version identifier exists so that a stored decision can be interpreted
  // later. These comparisons ask whether any identifier names two different
  // things — the reviewed corpus's world and the deployment pack's world — in
  // which case a recorded proposal or route does not say which one it came
  // from, and nothing else in the system would notice.
  const deploymentTaxonomy = loadDeploymentTaxonomy(deploymentProfile);
  const deploymentRouting = loadDeploymentRouting(deploymentProfile);
  const corpusRouting = loadResponsibilityDirectory();

  const sorted = (values: readonly string[]): readonly string[] => [...new Set(values)].sort();
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  const corpusCategoryIds = sorted(taxonomy.categories.map((category) => category.category_id));
  const deploymentCategoryIds = sorted(deploymentTaxonomy.categoryIds);
  const corpusDepartmentIds = sorted(
    corpusRouting.departments.map((department) => department.department_id),
  );
  const deploymentDepartmentIds = sorted(
    deploymentRouting.entries.map((entry: { readonly departmentId: string }) => entry.departmentId),
  );

  const versionCollisions = [
    {
      versionString: taxonomy.taxonomy_version,
      deploymentVersionString: deploymentTaxonomy.version,
      what: "category identifiers",
      corpusValues: corpusCategoryIds,
      deploymentValues: deploymentCategoryIds,
      collides:
        taxonomy.taxonomy_version === deploymentTaxonomy.version &&
        !same(corpusCategoryIds, deploymentCategoryIds),
    },
    {
      versionString: corpusRouting.directory_version,
      deploymentVersionString: deploymentRouting.directoryVersion,
      what: "department identifiers",
      corpusValues: corpusDepartmentIds,
      deploymentValues: deploymentDepartmentIds,
      collides:
        corpusRouting.directory_version === deploymentRouting.directoryVersion &&
        !same(corpusDepartmentIds, deploymentDepartmentIds),
    },
  ].filter((entry) => entry.collides);

  const labelSpaceAgreesWithDeployment = versionCollisions.length === 0;

  // --- providers ---
  const apiKey = process.env["GEMINI_API_KEY"] ?? "";
  if (providerMode === "real" && apiKey.trim().length === 0) {
    throw new Error(
      "a real-provider run needs GEMINI_API_KEY; rerun with --provider stub to measure the stub and have the report say so",
    );
  }

  const classificationModel = process.env["GEMINI_CLASSIFICATION_MODEL"] ?? "";
  const embeddingModel = process.env["GEMINI_EMBEDDING_MODEL"] ?? "";
  const embeddingDimensions = Number(process.env["GEMINI_EMBEDDING_DIMENSIONS"] ?? "3072");

  const classificationTransport = createRecordingTransport(async (url, init) => {
    const response = await fetch(url, init as RequestInit);
    return { status: response.status, json: () => response.json() as Promise<unknown> };
  }, "classification");
  const embeddingTransport = createRecordingTransport(async (url, init) => {
    const response = await fetch(url, init as RequestInit);
    return { status: response.status, json: () => response.json() as Promise<unknown> };
  }, "embedding");

  const taxonomyForAdapter = {
    version: taxonomy.taxonomy_version,
    categoryIds: taxonomy.categories.map((category) => category.category_id),
    defectIds: taxonomy.categories.flatMap((category) =>
      category.defects.map((defect) => defect.defect_id),
    ),
  };

  const classifier =
    providerMode === "stub"
      ? undefined
      : new GeminiClassificationAdapter({
          apiKey,
          classificationModel,
          taxonomy: taxonomyForAdapter,
          transport: classificationTransport.transport,
        });

  const embedder =
    providerMode === "stub"
      ? undefined
      : new GeminiEmbeddingAdapter({
          apiKey,
          embeddingModel,
          expectedDimensions: embeddingDimensions,
          transport: embeddingTransport.transport,
        });

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  // The free tier permits five requests per minute per model and this run
  // makes two calls per report. Pacing is part of the run, not a workaround:
  // a 429 counted as an outage would understate the provider's answers.
  const PACE_MS = Number(process.env["EVAL_PACE_MS"] ?? "30000");

  /**
   * The language of the row currently being classified.
   *
   * The pipeline's `ClassifyText` port passes **only the text**, so a deployed
   * classifier is never told which language the report is in — a real gap this
   * run found and recorded rather than papered over. The harness knows,
   * because it sets this before each row, and a Marathi report classified
   * while the adapter was told "en-IN" would have measured the wrong thing.
   */
  let currentLanguage = "en-IN";
  let currentSubject = "(unattributed)";
  /**
   * How many attempts each row's classification took, and whether one answered.
   *
   * Both, because a first version recorded only the count and then printed
   * "answered on attempt 5" for eight rows that never answered at all.
   */
  const classificationAttempts = new Map<
    string,
    { readonly attempts: number; readonly answered: boolean }
  >();

  const classify =
    classifier === undefined
      ? undefined
      : async (
          text: string,
        ): Promise<
          | { readonly outcome: "classified"; readonly proposal: never }
          | { readonly outcome: "unavailable"; readonly reasonCode: string }
        > => {
          // The deployment retries: a `match_submission` task that fails with a
          // retryable outcome goes back on the outbox with exponential backoff
          // up to the policy ceiling. A run that gave up on the first 503 would
          // measure a worse system than the one that is deployed — the first
          // real run lost three of eight calls that way.
          let lastReason = "no_attempt_made";
          for (let attempt = 1; attempt <= DEFAULT_RETRY_POLICY.maxAttempts; attempt += 1) {
            const result = await classifier.classify(
              {
                text,
                source_language: unsafeBcp47(currentLanguage),
                taxonomy_version: taxonomyForAdapter.version,
              },
              { correlation_id: newCorrelationId() },
            );
            if (result.kind === "success") {
              classificationAttempts.set(currentSubject, { attempts: attempt, answered: true });
              return { outcome: "classified", proposal: result.value as never };
            }
            lastReason = result.reason_code;
            if (result.kind !== "unavailable") break; // a rejection is terminal
            if (attempt === DEFAULT_RETRY_POLICY.maxAttempts) break;
            const hinted = "retry_after_ms" in result ? result.retry_after_ms : undefined;
            await sleep(
              hinted ?? DEFAULT_RETRY_POLICY.baseBackoffSeconds * 1000 * Math.pow(2, attempt - 1),
            );
          }
          classificationAttempts.set(currentSubject, {
            attempts: DEFAULT_RETRY_POLICY.maxAttempts,
            answered: false,
          });
          return { outcome: "unavailable", reasonCode: lastReason };
        };

  const embed =
    embedder === undefined
      ? undefined
      : async (text: string) => {
          const result = await embedder.embed(text, { correlation_id: newCorrelationId() });
          if (result.kind !== "success") {
            throw new Error(`embedding unavailable: ${result.reason_code}`);
          }
          return {
            vector: result.value.vector,
            model: result.value.model_name,
            dimensions: result.value.dimensions,
            normalized: result.value.normalized,
          };
        };

  // --- the run ---
  const startedAt = new Date();
  const observations = await runEvaluationCorpus(client, {
    rows,
    localePackVersion: process.env["LOCALE_PACK_VERSION"] ?? "demo-locales.v1",
    taxonomyVersion: taxonomy.taxonomy_version,
    stage: {
      jurisdictionId: undefined,
      // The same versioned boundary resolution `apps/worker` uses. Without it
      // every issue would carry no jurisdiction and every routing lookup would
      // fail for a reason that had nothing to do with the directory — which is
      // exactly what the first rehearsal run showed.
      resolveJurisdiction: ({ lon, lat, accuracyMetres, observedAt }) =>
        resolveJurisdictionAtLocation(client, {
          profileId: structure.profileId,
          boundaryVersion: structure.boundaryVersion,
          lon,
          lat,
          accuracyMetres,
          observedAt,
        }),
      taxonomy: taxonomyForAdapter,
      directoryVersion: structure.directoryVersion,
      // A report whose category nothing established keeps this, and the
      // scorer treats it as an abstention rather than an answer.
      fallbackCategory: process.env["WORKER_FALLBACK_CATEGORY"] ?? "sanitation",
      bounds,
      classificationModelName: classificationModel,
      classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
      ...(embed === undefined ? {} : { embed }),
    },
    classify: classify as never,
    beforeRow: async (row, index) => {
      currentLanguage = row.source_language;
      currentSubject = row.report_id;
      classificationTransport.setSubject(row.report_id);
      embeddingTransport.setSubject(row.report_id);
      if (index > 0 && providerMode === "real") await sleep(PACE_MS);
      console.log(`  [${String(index + 1)}/${String(rows.length)}] ${row.report_id}`);
    },
  });
  const finishedAt = new Date();

  // --- the reviewed-label routing probe, after every row, so no extra issue
  //     exists while retrieval is being measured ---
  const byReport = new Map<string, RowObservation>(
    observations.map((observation) => [observation.reportId, observation]),
  );
  const probes = new Map<string, RoutingResult | { readonly probeFailed: string } | undefined>();
  for (const row of rows) {
    const observation = byReport.get(row.report_id);
    if (observation?.issueId === undefined || row.expected.category_id === null) {
      probes.set(row.report_id, undefined);
      continue;
    }
    probes.set(
      row.report_id,
      await routeFromReviewedLabel(client, {
        issueId: observation.issueId,
        reviewedCategory: row.expected.category_id,
        directoryVersion: structure.directoryVersion,
      }),
    );
  }

  // --- scoring ---
  const scores: RowScore[] = rows.map((row) => {
    const observation = byReport.get(row.report_id);
    return scoreRow(row, observation, {
      endToEnd: observation?.routing,
      fromReviewedLabel: probes.get(row.report_id),
    });
  });

  const pairFor = (relationId: string, a: string, b: string) =>
    pairOutcomeOf({
      relationId,
      first: byReport.get(a),
      second: byReport.get(b),
    });

  const duplicatePairs = relations.duplicate_pairs
    .filter((pair) => pair.split === split)
    .map((pair) => pairFor(pair.relation_id, pair.report_a, pair.report_b));
  const distinctPairs = relations.nearby_distinct
    .filter((pair) => pair.split === split)
    .map((pair) => pairFor(pair.relation_id, pair.report_a, pair.report_b));

  const summary = summarise({ rows, scores, duplicatePairs, distinctPairs });

  const calls: readonly ProviderCall[] = [
    ...classificationTransport.calls,
    ...embeddingTransport.calls,
  ];
  const usage: ProviderUsage = {
    calls: calls.length,
    promptTokens: calls.some((call) => call.promptTokens !== undefined)
      ? calls.reduce((total, call) => total + (call.promptTokens ?? 0), 0)
      : undefined,
    outputTokens: calls.some((call) => call.outputTokens !== undefined)
      ? calls.reduce((total, call) => total + (call.outputTokens ?? 0), 0)
      : undefined,
    totalTokens: calls.some((call) => call.totalTokens !== undefined)
      ? calls.reduce((total, call) => total + (call.totalTokens ?? 0), 0)
      : undefined,
  };

  const withheldLanguages = [...new Set(rows.map((row) => row.source_language))].filter(
    (language) =>
      !summary.scoredRows.some((score) => score.language === language) &&
      rows.some((row) => row.source_language === language),
  );

  const verdict = qualityClaimVerdict({
    split,
    providerMode,
    scoredReports: summary.scoredRows.length,
    withheldReports: summary.withheldRows.length,
    languages: [...new Set(rows.map((row) => row.source_language))],
    withheldLanguages,
    duplicatePairs: duplicatePairs.length,
    distinctPairs: distinctPairs.length,
    widestReportedFigure: summary.proposedCategory,
    labelSpaceAgreesWithDeployment,
  });

  const recordDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "deliverables",
    "v046-runs",
  );

  // The record is written first, so the cross-run table in the document
  // includes the run that is producing it. A document that listed every run
  // except its own would be the one artifact that could not be checked against
  // the evidence beside it.
  mkdirSync(recordDirectory, { recursive: true });
  const record = join(recordDirectory, `${runId}-${split}-${providerMode}.json`);
  writeFileSync(
    record,
    `${JSON.stringify(
      {
        runId,
        reason,
        split,
        providerMode,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        verdict,
        scores,
        duplicatePairs,
        distinctPairs,
        calls: calls.map((call) => ({ ...call, statementFindings: call.statementFindings })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${record}`);

  const document = renderReport({
    runId,
    reason,
    split,
    providerMode,
    startedAt,
    finishedAt,
    corpusProvenance: corpus.provenance,
    versions: {
      taxonomy: taxonomy.taxonomy_version,
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      classificationModel: providerMode === "stub" ? "" : classificationModel,
      classificationModelVersionReported:
        classificationTransport.calls.find((call) => call.modelVersion !== undefined)
          ?.modelVersion ?? undefined,
      embeddingModel: providerMode === "stub" ? "" : embeddingModel,
      embeddingDimensions,
      directoryVersion: structure.directoryVersion,
      boundaryVersion: structure.boundaryVersion,
      profileId: structure.profileId,
      boundsVersion: bounds.version,
      boundsNote: bounds.note,
      localePackVersion: process.env["LOCALE_PACK_VERSION"] ?? "demo-locales.v1",
    },
    labelSpace: { agrees: labelSpaceAgreesWithDeployment, deploymentProfile, versionCollisions },
    rows,
    scores,
    summary,
    duplicatePairs,
    distinctPairs,
    observations,
    classificationAttempts,
    calls,
    costLine: costStatement(usage),
    history: readRunHistory(recordDirectory, split),
    verdict,
  });

  mkdirSync(outputDirectory, { recursive: true });
  const target = join(outputDirectory, "V046-evaluation-results.md");
  // Through Prettier with the repository's own configuration, because
  // `format:check` gates every file and a generator that fights the formatter
  // leaves a deliverable that fails the build the moment it is produced.
  const { format, resolveConfig } = await import("prettier");
  const prettierConfig = await resolveConfig(target);
  writeFileSync(
    target,
    await format(document, { ...prettierConfig, filepath: target, parser: "markdown" }),
    "utf8",
  );
  console.log(`\nwrote ${target}`);

  if (!verdict.permitted) {
    console.log("\nthis run may not back a quality claim:");
    for (const line of verdict.reasons) console.log(`  - ${line}`);
  }
} finally {
  await client.end().catch(() => undefined);
  await dropDatabase();
  console.log(`dropped ${evaluationDatabase}`);
}
