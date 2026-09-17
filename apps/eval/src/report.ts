/**
 * Writing the run down (roadmap V046).
 *
 * Ordering is the argument. The refusal comes before any figure, for the same
 * reason V045's results document states the sample size before any
 * observation: a reader who meets the numbers first has already formed the
 * impression the caveat then has to undo.
 *
 * Nothing here computes a result. Every figure arrives already scored and
 * already carrying its interval, so this file cannot accidentally widen what
 * the measurement supports.
 */

import {
  MATCHING_NOT_COMBINABLE,
  MAX_INTERVAL_WIDTH_RATIONALE,
  abstentionStatement,
  figureStatement,
  type EvaluationClaimVerdict,
  type PairObservation,
} from "@vision/domain";
import type { EvaluationRow, ProviderCall, RowObservation } from "@vision/adapters";

import type { RunHistoryEntry } from "./history.ts";
import type { EvaluationSummary, RowScore } from "./score.ts";

export type ReportInput = {
  readonly runId: string;
  readonly reason: string;
  readonly split: "holdout" | "development";
  readonly providerMode: "real" | "stub";
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly corpusProvenance: string;
  readonly versions: {
    readonly taxonomy: string;
    readonly promptVersion: string;
    readonly classificationModel: string;
    readonly classificationModelVersionReported: string | undefined;
    readonly embeddingModel: string;
    readonly embeddingDimensions: number;
    readonly directoryVersion: string;
    readonly boundaryVersion: string;
    readonly profileId: string;
    readonly boundsVersion: string;
    readonly boundsNote: string;
    readonly localePackVersion: string;
  };
  readonly labelSpace: {
    readonly agrees: boolean;
    readonly deploymentProfile: string;
    readonly versionCollisions: readonly {
      readonly versionString: string;
      readonly deploymentVersionString: string;
      readonly what: string;
      readonly corpusValues: readonly string[];
      readonly deploymentValues: readonly string[];
    }[];
  };
  readonly rows: readonly EvaluationRow[];
  readonly scores: readonly RowScore[];
  readonly summary: EvaluationSummary;
  readonly duplicatePairs: readonly PairObservation[];
  readonly distinctPairs: readonly PairObservation[];
  readonly observations: readonly RowObservation[];
  /** Attempts each row's classification needed, so a retried call is visible. */
  readonly classificationAttempts: ReadonlyMap<
    string,
    { readonly attempts: number; readonly answered: boolean }
  >;
  readonly calls: readonly ProviderCall[];
  readonly costLine: string;
  /** Every recorded run of this split, including the ones that came out worse. */
  readonly history: readonly RunHistoryEntry[];
  readonly verdict: EvaluationClaimVerdict;
};

const outcomeLabel = (score: RowScore, field: "proposedCategory" | "appliedCategory"): string => {
  const outcome = score[field];
  if (outcome === undefined) return "withheld";
  switch (outcome.kind) {
    case "match":
      return `matched (${outcome.value})`;
    case "mismatch":
      return `label ${outcome.expected}, produced ${outcome.produced}`;
    case "abstained_where_labelled":
      return `declined; label was ${outcome.expected}`;
    case "correct_abstention":
      return "declined, as the corpus expects";
    case "asserted_where_none_expected":
      return `asserted ${outcome.produced} where the corpus expects no assertion`;
    case "unscorable":
      return "outside the score";
  }
};

export const renderReport = (input: ReportInput): string => {
  const lines: string[] = [];
  const write = (line = ""): void => {
    lines.push(line);
  };

  const durationSeconds = Math.round(
    (input.finishedAt.getTime() - input.startedAt.getTime()) / 1000,
  );

  write(`# V046 — Held-out evaluation results`);
  write();
  write(
    `**Run \`${input.runId}\`** · split **${input.split}** · provider **${input.providerMode}** · ${input.startedAt.toISOString()} → ${input.finishedAt.toISOString()} (${String(durationSeconds)} s)`,
  );
  write();
  write(`> Recorded reason for unsealing: _${input.reason}_`);
  write(`>`);
  write(`> Corpus provenance: ${input.corpusProvenance}`);
  write();

  // -- the refusal, first --
  write(`## What this run may not be used to say`);
  write();
  if (input.verdict.permitted) {
    write(
      `Every condition this evaluation checks is met, so the figures below may back a quality statement within the bounds each figure names.`,
    );
  } else {
    write(
      `This run **may not back a quality claim**. The reasons are listed in full, because a refusal that names what is missing is a next step and a refusal that does not is a wall.`,
    );
    write();
    for (const reason of input.verdict.reasons) write(`1. ${reason}`);
  }
  write();

  // -- versions --
  write(`## What was run`);
  write();
  write(`| Recorded version | Value |`);
  write(`| --- | --- |`);
  write(
    `| Classification model requested | \`${input.versions.classificationModel || "(none — stub run)"}\` |`,
  );
  write(
    `| Classification model the provider reported | \`${input.versions.classificationModelVersionReported ?? "(not reported)"}\` |`,
  );
  write(`| Prompt version | \`${input.versions.promptVersion}\` |`);
  write(`| Taxonomy | \`${input.versions.taxonomy}\` |`);
  write(
    `| Embedding model | \`${input.versions.embeddingModel || "(none)"}\` at ${String(input.versions.embeddingDimensions)} dimensions |`,
  );
  write(`| Routing directory | \`${input.versions.directoryVersion}\` |`);
  write(
    `| Jurisdiction profile / boundaries | \`${input.versions.profileId}\` / \`${input.versions.boundaryVersion}\` |`,
  );
  write(`| Retrieval bounds | \`${input.versions.boundsVersion}\` |`);
  write(`| Locale pack | \`${input.versions.localePackVersion}\` |`);
  write();
  write(`Retrieval bounds note, carried from the pack: _${input.versions.boundsNote}_`);
  write();

  // -- the label space --
  write(`## Whether a version identifier names one thing`);
  write();
  if (input.labelSpace.agrees) {
    write(
      `Every version identifier shared by the reviewed corpus and the \`${input.labelSpace.deploymentProfile}\` deployment pack names the same set of values, so a proposal and a label are answers to the same question.`,
    );
  } else {
    write(
      `**No.** A version identifier exists so that a decision recorded today can be interpreted next year. The reviewed corpus (V011) and the \`${input.labelSpace.deploymentProfile}\` deployment pack reuse identifiers for sets that are not the same:`,
    );
    write();
    write(`| Identifier | What it names | In the reviewed corpus | In the deployment pack |`);
    write(`| --- | --- | --- | --- |`);
    for (const collision of input.labelSpace.versionCollisions) {
      write(
        `| \`${collision.versionString}\` | ${collision.what} | ${collision.corpusValues.map((value) => `\`${value}\``).join(", ")} | ${collision.deploymentValues.map((value) => `\`${value}\``).join(", ")} |`,
      );
    }
    write();
    write(
      `A proposal stored as \`${input.labelSpace.versionCollisions[0]?.versionString ?? ""}\` therefore does not say which vocabulary it chose from, and a routing decision recorded against a directory version does not say which directory. This run gave the classifier the **corpus** list, because that is the list the reviewers' labels are written in — so the classification figures below describe a configuration this deployment does not currently run. Nothing here changes either side: which list is right is an owner's decision, not a measurement.`,
    );
  }
  write();

  // -- label authority --
  write(`## Which rows were allowed to back a figure`);
  write();
  write(
    `V011 §4 records that a row awaiting native-speaker review "must not back a V046 measurement until a native reviewer signs off". That was a sentence in a document; \`labelAuthorityOf\` makes it a gate, and this table is its output.`,
  );
  write();
  write(`| Report | Language | Scored | Reason if withheld |`);
  write(`| --- | --- | --- | --- |`);
  for (const score of input.scores) {
    write(
      `| \`${score.reportId}\` | ${score.language} | ${score.authority.usable ? "yes" : "**no**"} | ${score.authority.usable ? "—" : score.authority.reason} |`,
    );
  }
  write();
  write(
    `**${String(input.summary.scoredRows.length)} of ${String(input.rows.length)}** rows are inside every label-dependent figure below. Latency, token counts, HTTP outcomes and claim-language findings are properties of the call rather than of the label, so those cover **all ${String(input.rows.length)}** rows.`,
  );
  write();

  // -- classification --
  write(`## How to read every figure below`);
  write();
  write(
    `Each one is written as a count with a 95% Wilson interval. A percentage appears **only** when that interval is narrower than twenty percentage points, and that threshold is ${MAX_INTERVAL_WIDTH_RATIONALE}. Where a figure says "too wide to be written as a rate", the counts are the result and the interval is what the counts are worth. Wilson rather than the textbook interval because the textbook one returns zero width at 4 of 4, which would report a four-example run as certainty.`,
  );
  write();

  write(`## Classification`);
  write();
  write(
    `Two answers are scored, because there are two. The model **proposes**; \`runMatchingStage\` applies a proposal only at the \`high\` certainty band and otherwise keeps the deployment's fallback category. A fallback is recorded here as the system declining, never as an answer — on this deployment the fallback is a real category id, so a report whose reviewed label happened to equal it would otherwise have scored as correct while nothing classified it.`,
  );
  write();
  write(`| Figure | Result |`);
  write(`| --- | --- |`);
  write(
    `| Model proposal matched the reviewed category | ${figureStatement(input.summary.proposedCategory)} |`,
  );
  write(
    `| Model proposal matched the reviewed defect | ${figureStatement(input.summary.proposedDefect)} |`,
  );
  write(
    `| Category the system applied matched the reviewed category | ${figureStatement(input.summary.appliedCategory)} |`,
  );
  write();

  write(`### Per language`);
  write();
  write(`| Language | Model proposal against the reviewed category |`);
  write(`| --- | --- |`);
  for (const [language, figure] of input.summary.byLanguage) {
    write(`| ${language} | ${figureStatement(figure)} |`);
  }
  const missingLanguages = [...new Set(input.rows.map((row) => row.source_language))].filter(
    (language) => !input.summary.byLanguage.has(language),
  );
  for (const language of missingLanguages) {
    write(`| ${language} | withheld — every row in this language is awaiting native review |`);
  }
  write();

  write(`### Per category`);
  write();
  write(`| Reviewed category | Model proposal |`);
  write(`| --- | --- |`);
  for (const [category, figure] of input.summary.byCategory) {
    write(`| ${category} | ${figureStatement(figure)} |`);
  }
  write();

  write(`### Every scored row`);
  write();
  write(`| Report | Band | Model proposed | System applied |`);
  write(`| --- | --- | --- | --- |`);
  for (const score of input.scores) {
    write(
      `| \`${score.reportId}\` | ${score.certaintyBand ?? "—"} | ${outcomeLabel(score, "proposedCategory")} | ${outcomeLabel(score, "appliedCategory")} |`,
    );
  }
  write();

  // -- abstention --
  write(`## Abstention coverage`);
  write();
  write(abstentionStatement(input.summary.abstention) + ".");
  write();
  write(
    `Both directions are named every time. "It never over-asserted" means nothing without how often it had the opportunity to, and an abstention on a report that carried a perfectly good label is a cost too — it is a report nobody categorised.`,
  );
  write();

  // -- routing --
  write(`## Routing`);
  write();
  write(
    `Routing is measured twice. End to end it uses whatever category the system settled on, which is what a citizen's report would actually get. From the reviewed label it forces the corpus's own category in and asks the directory the same question, which separates a wrong custodian caused by the directory from a wrong custodian caused by the classifier. The probe writes into a transaction that is always rolled back.`,
  );
  write();
  write(`| Figure | Result |`);
  write(`| --- | --- |`);
  write(`| Custodian correct, end to end | ${figureStatement(input.summary.routingEndToEnd)} |`);
  write(
    `| Custodian correct, given the reviewed label | ${figureStatement(input.summary.routingFromReviewedLabel)} |`,
  );
  write();
  write(`| Report | Detail |`);
  write(`| --- | --- |`);
  for (const score of input.scores) {
    write(`| \`${score.reportId}\` | ${score.routingDetail} |`);
  }
  write();

  // -- matching --
  write(`## Candidate retrieval and merges`);
  write();
  write(`${MATCHING_NOT_COMBINABLE}`);
  write();
  write(`| Figure | Result |`);
  write(`| --- | --- |`);
  write(
    `| Reviewed duplicate pairs whose later report retrieved the earlier issue | ${figureStatement(input.summary.matching.candidateRecall)} |`,
  );
  write(
    `| ...of those, merged onto one issue | ${figureStatement(input.summary.matching.mergeOfRetrieved)} |`,
  );
  write(
    `| Reviewed distinct pairs merged anyway | ${figureStatement(input.summary.matching.incorrectMerges)} |`,
  );
  write(
    `| Reviewed distinct pairs retrieved and correctly left separate | ${figureStatement(input.summary.matching.correctlySeparated)} |`,
  );
  write();
  if (input.duplicatePairs.length + input.distinctPairs.length > 0) {
    write(`| Pair | Retrieved | Merged |`);
    write(`| --- | --- | --- |`);
    for (const pair of [...input.duplicatePairs, ...input.distinctPairs]) {
      write(
        `| \`${pair.relationId}\` | ${pair.retrieved ? "yes" : "no"} | ${pair.merged ? "yes" : "no"} |`,
      );
    }
    write();
  }

  // -- unsupported statements --
  write(`## Unsupported statements in model replies`);
  write();
  const findings = input.calls.flatMap((call) =>
    call.statementFindings.map((finding) => ({ subject: call.subject, ...finding })),
  );
  if (findings.length === 0) {
    write(
      `No reply carried a probability, a percentage, a numeric score, a severity assertion, a repair recommendation, a status assertion, or an echo of an instruction embedded in a report. ${String(input.calls.filter((call) => call.operation === "classification").length)} classification replies were scanned.`,
    );
  } else {
    write(`| Report | Finding | Why it is unsupported | Excerpt |`);
    write(`| --- | --- | --- | --- |`);
    for (const finding of findings) {
      write(
        `| \`${finding.subject}\` | ${finding.code} | ${finding.why} | \`${finding.excerpt}\` |`,
      );
    }
    write();
    write(
      `The excerpt is bounded and the reply itself is never reproduced: a report that printed the whole reply to show what was wrong with it would have copied the citizen's words into a more widely circulated file.`,
    );
  }
  write();

  // -- latency --
  write(`## Latency`);
  write();
  if (input.calls.length === 0) {
    write(`No provider call was made, so there is no latency to report.`);
  } else {
    write(
      `Every observation is listed rather than summarised. With ${String(input.calls.length)} calls a median and a 95th percentile would be a summary of almost nothing, and the two slowest calls are the interesting ones.`,
    );
    write();
    write(`| Call | Operation | HTTP | Milliseconds |`);
    write(`| --- | --- | --- | --- |`);
    for (const call of input.calls) {
      write(
        `| \`${call.subject}\` | ${call.operation} | ${String(call.status)} | ${call.latencyMs.toFixed(0)} |`,
      );
    }
  }
  write();

  // -- cost --
  write(`## Cost`);
  write();
  write(input.costLine);
  write();

  // -- errors --
  write(`## Error examples`);
  write();
  const errors = input.scores.filter(
    (score) =>
      score.authority.usable &&
      (score.proposedCategory?.kind === "mismatch" ||
        score.proposedDefect?.kind === "mismatch" ||
        score.proposedCategory?.kind === "asserted_where_none_expected" ||
        score.routingEndToEnd === "incorrect"),
  );
  if (errors.length === 0) {
    write(
      `No scored row produced a wrong category, a wrong defect or a wrong custodian. On ${String(input.summary.scoredRows.length)} scored rows that is an observation about ${String(input.summary.scoredRows.length)} reports, and the intervals above say what it is worth.`,
    );
  } else {
    for (const score of errors) {
      write(`- \`${score.reportId}\` (${score.language})`);
      if (score.proposedCategory !== undefined) {
        write(`  - category: ${outcomeLabel(score, "proposedCategory")}`);
      }
      write(`  - routing: ${score.routingDetail}`);
    }
  }
  write();

  const failures = input.observations.filter(
    (observation) => observation.stageStatus !== "completed",
  );
  if (failures.length > 0) {
    write(`### Rows the pipeline did not complete`);
    write();
    for (const failure of failures) {
      write(`- \`${failure.reportId}\`: ${failure.failureReason ?? failure.stageStatus}`);
    }
    write();
  }

  const retried = [...input.classificationAttempts.entries()].filter(
    ([, record]) => record.attempts > 1,
  );
  const unavailable = input.observations.filter(
    (observation) => observation.classificationUnavailableReason !== undefined,
  );
  write(`### Provider outcomes`);
  write();
  write(
    `The harness retries a retryable outcome on the deployment's own policy — the outbox allows five attempts with exponential backoff — because a run that gave up on the first 503 would measure a worse system than the one that is deployed. That policy has a consequence worth recording: its backoff (2, 4, 8, 16 seconds) fits inside the provider's per-minute window, so against a rate limit the retries are part of what sustains the limit. The provider's own \`RetryInfo\` hint is honoured when it sends one, and is the only thing that prevents that.`,
  );
  write();
  if (retried.length === 0) {
    write(`No classification needed a second attempt.`);
  } else {
    for (const [reportId, record] of retried) {
      write(
        record.answered
          ? `- \`${reportId}\`: answered on attempt ${String(record.attempts)}`
          : `- \`${reportId}\`: no answer after ${String(record.attempts)} attempts`,
      );
    }
  }
  write();
  if (unavailable.length > 0) {
    write(
      `These rows had **no proposal at all** after the retry policy was exhausted. They are scored as unscorable, never as abstentions: a 503 is a property of an afternoon and declining to classify is a property of the system, and merging them would let an outage be read as care. A reason code beginning \`provider_\` is an outage; anything else is the reply being refused before it could become a proposal.`,
    );
    write();
    for (const observation of unavailable) {
      write(`- \`${observation.reportId}\`: ${observation.classificationUnavailableReason ?? ""}`);
    }
    write();
  } else {
    write(`Every row received a proposal.`);
    write();
  }

  // -- limitations --
  write(`## Limitations of this run`);
  write();
  write(
    `- The evaluation database held **only** the rows in this split. Retrieval was therefore measured against a near-empty district, which says nothing about how many wrong candidates would be retrieved at a real report density.`,
  );
  write(
    `- No image or audio reached a model. The corpus carries no media bytes by design (V011), so this measures the text path only.`,
  );
  write(
    `- Transcription (V024) is not exercised here: every row arrives as text, so nothing measures the voice path.`,
  );
  write(
    `- The adversarial cases in \`adversarial.json\` are not scored by this run. Instruction-echo is detected in replies as an unsupported statement, but the injection boundary itself is V047's subject.`,
  );
  write(
    `- Nothing here measures what a reviewer or a citizen does with a proposal. A proposal that is wrong and visibly low-certainty costs less than one that is wrong and confident, and this run does not observe that difference.`,
  );
  write();

  write(`## Every recorded run of this split`);
  write();
  write(
    `A single run describes a single afternoon. These are read back from \`deliverables/v046-runs/\` rather than remembered, so that a run cannot be quietly replaced by a better one, and so that the spread is part of the result.`,
  );
  write();
  write(
    `| Run | Provider | Classification calls answered | Rows with usable labels | Rows that produced an answer | Category matches |`,
  );
  write(`| --- | --- | --- | --- | --- | --- |`);
  for (const entry of input.history) {
    write(
      `| \`${entry.runId}\`${entry.runId === input.runId ? " (this one)" : ""} | ${entry.providerMode} | ${String(entry.classificationCallsAnswered)} of ${String(entry.classificationCalls)} | ${String(entry.rowsWithUsableLabels)} | ${String(entry.rowsScored)} | ${String(entry.categoryMatches)} |`,
    );
  }
  write();
  const answeredRatios = new Set(
    input.history
      .filter((entry) => entry.classificationCalls > 0)
      .map(
        (entry) =>
          `${String(entry.classificationCallsAnswered)}/${String(entry.classificationCalls)}`,
      ),
  );
  if (answeredRatios.size > 1) {
    write(
      `The column that moves most is the first one: the same code against the same rows got a different number of answers out of the provider on different runs. **On this evidence, provider availability rather than model behaviour decided how much of the corpus could be scored at all.**`,
    );
  } else {
    write(
      `No run of this split has been permitted to carry a quality claim; each one's own verdict says why.`,
    );
  }
  write();

  write(`## Reproducibility, and what publishing this costs`);
  write();
  write(
    `The **method** is reproducible: the versions above, the disposable database, the seeding and the row order are all fixed, and the machine-readable record of every run is kept under \`deliverables/v046-runs/\`. The **provider is not deterministic**, and that is not a caveat to skip over — two runs of identical code against identical rows minutes apart can differ in how many calls the provider answers at all. Comparing two runs means comparing the records, not remembering the first one.`,
  );
  write();
  write(
    `Publishing a result costs holdout. This document names report identifiers, their languages, their reviewed categories and the custodians expected for them, because V046 asks for per-category results and error examples and there is no way to give those without disclosing part of what was held out. So these ${String(input.rows.length)} rows are now less held-out than they were this morning, and a future measurement that needs them unseen needs **new** rows rather than these ones again. That is an argument for growing the corpus, not for publishing less of what was measured.`,
  );
  write();

  write(`## Reproducing this run`);
  write();
  write("```bash");
  write(
    `npm run eval:holdout -- --reason "V046 scored run" --split ${input.split} --provider ${input.providerMode}`,
  );
  write("```");
  write();
  write(
    `The seal additionally requires the environment variable \`VISION_EVAL_RUN\` to be set to \`1\` for that process. No script and no committed file sets it — \`tools/check-holdout-seal.mjs\` fails the build if one ever does — so unsealing the holdout is always a deliberate act typed at a command line, and the reason above is recorded with it.`,
  );
  write();
  write(
    `The harness creates a disposable database, migrates it, seeds the corpus structure, runs every row through \`runMatchingStage\`, writes this document and a machine-readable record under \`deliverables/v046-runs/\`, and drops the database in a \`finally\`. The holdout is never written into a database anything else reads.`,
  );
  write();

  return `${lines.join("\n")}\n`;
};
