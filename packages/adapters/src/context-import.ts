/**
 * Contextual data import with lineage (roadmap V040).
 *
 * Loads population, enrolment, access and investment figures for the district
 * and, just as importantly, records every row it refused.
 *
 * The rule the whole import turns on: **a row is either loaded intact or
 * reported, and there is no third path.** Nothing here rescales a unit,
 * attaches an unmatched identifier to a nearby one, substitutes a zero for an
 * absence, or drops a row quietly. Each of those would produce a plausible
 * number that nobody could later distinguish from a real one, which is the
 * specific way context data becomes misinformation: it is quoted long after
 * the file it came from has been forgotten.
 *
 * Rejections are persisted rather than logged. The V040 acceptance clause is
 * that invalid units, stale records and unmatched assets are *reported*, and a
 * refusal that only ever existed in a log line is not reportable after the
 * fact — the question "what did not load, and why" has to be answerable from
 * the database a week later.
 *
 * Staleness is the one thing that is not a refusal. A figure from three years
 * ago is still the best figure available; what would be dishonest is showing
 * it without the three years. `readContextForJurisdiction` therefore returns
 * stale values with their age attached, and `lineageSentence` renders both.
 */

import { randomUUID } from "node:crypto";

import {
  CONTEXT_KINDS,
  lineageSentence,
  stalenessOf,
  validateContextRow,
  type ContextDataset,
  type ContextKind,
  type ContextRow,
  type DisplayableContextValue,
  type Rejection,
} from "@vision/domain";
import type { SourceRecordSnapshot } from "@vision/contracts";

import type { Queryable } from "./outbox.ts";

export class ContextImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextImportError";
  }
}

export type ImportRejection = Rejection & {
  readonly rowIndex: number;
  readonly raw: Readonly<Record<string, unknown>>;
};

export type ImportRunResult = {
  readonly runId: string;
  readonly datasetId: string;
  readonly rowsRead: number;
  readonly rowsLoaded: number;
  readonly rowsRejected: number;
  readonly rejections: readonly ImportRejection[];
};

/**
 * Ensures the source record exists, refusing anything V004 does not permit.
 *
 * The licence check is here as well as in the domain validator on purpose.
 * This is the layer that writes, and a gate that only exists on the path a
 * caller happens to take is not a gate.
 */
export const ensureSourceRecord = async (
  tx: Queryable,
  source: SourceRecordSnapshot,
): Promise<string> => {
  if (!["permitted", "synthetic", "consented"].includes(source.licence_or_permission_status)) {
    throw new ContextImportError(
      `source '${source.source_name}' is ${source.licence_or_permission_status} and may not be ingested (V004 §5)`,
    );
  }
  await tx.query(
    `insert into source_record
       (source_record_id, source_name, source_url_or_location, retrieved_at,
        source_effective_at, licence_or_permission_status, demo_status, raw_snapshot)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     on conflict (source_record_id) do update set
       source_name = excluded.source_name,
       source_url_or_location = excluded.source_url_or_location,
       retrieved_at = excluded.retrieved_at,
       source_effective_at = excluded.source_effective_at,
       licence_or_permission_status = excluded.licence_or_permission_status,
       demo_status = excluded.demo_status,
       current_version = source_record.current_version + 1`,
    [
      source.source_record_id,
      source.source_name,
      source.source_url_or_location,
      source.retrieved_at,
      source.source_effective_at ?? null,
      source.licence_or_permission_status,
      source.demo_status,
      JSON.stringify(source.raw_snapshot ?? {}),
    ],
  );
  return String(source.source_record_id);
};

const subjectIndex = async (
  tx: Queryable,
  jurisdictionProfileId: string,
): Promise<{
  readonly jurisdictions: ReadonlyMap<string, string>;
  readonly assets: ReadonlySet<string>;
}> => {
  const { rows: jurisdictionRows } = await tx.query(
    `select jurisdiction_id, internal_code from jurisdiction where jurisdiction_profile_id = $1`,
    [jurisdictionProfileId],
  );
  const { rows: assetRows } = await tx.query(
    `select a.asset_id from infrastructure_asset a
       join jurisdiction j on j.jurisdiction_id = a.jurisdiction_id
      where j.jurisdiction_profile_id = $1`,
    [jurisdictionProfileId],
  );
  return {
    jurisdictions: new Map(
      jurisdictionRows.map((row) => [String(row["internal_code"]), String(row["jurisdiction_id"])]),
    ),
    assets: new Set(assetRows.map((row) => String(row["asset_id"]))),
  };
};

export type DatasetToImport = {
  readonly datasetId: string;
  readonly kind: ContextKind;
  readonly unit: string;
  readonly label: string;
  readonly maxAgeDays: number;
  readonly rows: readonly ContextRow[];
};

/**
 * Imports one dataset, in one transaction, reporting everything it refused.
 *
 * A run that rejects every row still commits: the dataset, the run and its
 * rejections are the record of what was attempted, and rolling that back would
 * leave nothing to look at but the failure of the command. Observations
 * themselves are replaced wholesale for the dataset, so re-running a corrected
 * file does not leave the superseded rows behind.
 */
export const importContextDataset = async (
  tx: Queryable,
  options: {
    readonly dataset: DatasetToImport;
    readonly source: SourceRecordSnapshot;
    readonly jurisdictionProfileId: string;
    readonly asOf: Date;
  },
): Promise<ImportRunResult> => {
  const { dataset, source } = options;
  if (!CONTEXT_KINDS.includes(dataset.kind)) {
    throw new ContextImportError(`'${dataset.kind}' is not a context kind this system holds`);
  }

  const sourceRecordId = await ensureSourceRecord(tx, source);
  const subjects = await subjectIndex(tx, options.jurisdictionProfileId);
  const knownSubjects = new Set<string>([...subjects.jurisdictions.keys(), ...subjects.assets]);

  const validator: ContextDataset = {
    datasetId: dataset.datasetId,
    kind: dataset.kind,
    unit: dataset.unit,
    label: dataset.label,
    source,
    maxAgeDays: dataset.maxAgeDays,
  };

  const seen = new Set<string>();
  const accepted: {
    readonly row: ContextRow;
    readonly value: number | null;
    readonly missingIndicator: string | null;
    readonly vintage: string;
  }[] = [];
  const rejections: ImportRejection[] = [];

  dataset.rows.forEach((row, rowIndex) => {
    const outcome = validateContextRow(validator, row, {
      knownSubjects,
      asOfMs: options.asOf.getTime(),
      seen,
    });
    if (!outcome.ok) {
      for (const rejection of outcome.rejections) {
        rejections.push({ ...rejection, rowIndex, raw: { ...row } });
      }
      return;
    }
    seen.add(`${row.subjectKind}:${row.subjectId}`);
    accepted.push({
      row,
      value: outcome.row.value,
      missingIndicator: outcome.row.missingIndicator,
      vintage: outcome.row.vintage,
    });
  });

  const runId = randomUUID();
  await tx.query("begin");
  try {
    await tx.query(
      `insert into context_dataset
         (dataset_id, kind, unit, label, source_record_id, synthetic_provenance,
          max_age_days, jurisdiction_profile_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (dataset_id) do update set
         kind = excluded.kind, unit = excluded.unit, label = excluded.label,
         source_record_id = excluded.source_record_id,
         synthetic_provenance = excluded.synthetic_provenance,
         max_age_days = excluded.max_age_days,
         jurisdiction_profile_id = excluded.jurisdiction_profile_id,
         loaded_at = now()`,
      [
        dataset.datasetId,
        dataset.kind,
        dataset.unit,
        dataset.label,
        sourceRecordId,
        source.licence_or_permission_status === "synthetic",
        dataset.maxAgeDays,
        options.jurisdictionProfileId,
      ],
    );

    // Replaced wholesale: a corrected file must not leave the rows it
    // corrected sitting alongside their replacements.
    await tx.query("delete from context_observation where dataset_id = $1", [dataset.datasetId]);

    for (const entry of accepted) {
      const jurisdictionId =
        entry.row.subjectKind === "jurisdiction"
          ? (subjects.jurisdictions.get(entry.row.subjectId) ?? null)
          : null;
      await tx.query(
        `insert into context_observation
           (observation_id, dataset_id, subject_kind, jurisdiction_id, asset_id,
            value, missing_indicator, unit, vintage, raw)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          randomUUID(),
          dataset.datasetId,
          entry.row.subjectKind,
          jurisdictionId,
          entry.row.subjectKind === "asset" ? entry.row.subjectId : null,
          entry.value,
          entry.missingIndicator,
          entry.row.unit,
          entry.vintage,
          JSON.stringify(entry.row),
        ],
      );
    }

    await tx.query(
      `insert into context_import_run (run_id, dataset_id, ran_at, rows_read, rows_loaded, rows_rejected)
       values ($1,$2,$3::timestamptz,$4,$5,$6)`,
      [
        runId,
        dataset.datasetId,
        options.asOf.toISOString(),
        dataset.rows.length,
        accepted.length,
        dataset.rows.length - accepted.length,
      ],
    );

    for (const rejection of rejections) {
      await tx.query(
        `insert into context_import_rejection
           (rejection_id, run_id, row_index, reason_code, detail, raw)
         values ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          randomUUID(),
          runId,
          rejection.rowIndex,
          rejection.code,
          rejection.detail,
          JSON.stringify(rejection.raw),
        ],
      );
    }

    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }

  return {
    runId,
    datasetId: dataset.datasetId,
    rowsRead: dataset.rows.length,
    rowsLoaded: accepted.length,
    rowsRejected: dataset.rows.length - accepted.length,
    rejections,
  };
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ContextValueRow = DisplayableContextValue & {
  readonly datasetId: string;
  readonly jurisdictionId: string;
  /** The only supported rendering. Computed here so no caller can omit it. */
  readonly lineage: string;
};

const toValueRow = (row: Record<string, unknown>, asOf: Date): ContextValueRow => {
  const vintage = new Date(String(row["vintage"]));
  const displayable: DisplayableContextValue = {
    datasetLabel: String(row["label"]),
    kind: String(row["kind"]) as ContextKind,
    value: row["value"] === null || row["value"] === undefined ? null : Number(row["value"]),
    missingIndicator:
      row["missing_indicator"] === null || row["missing_indicator"] === undefined
        ? null
        : String(row["missing_indicator"]),
    unit: String(row["unit"]),
    vintage: vintage.toISOString(),
    sourceName: String(row["source_name"]),
    sourceLocation: String(row["source_url_or_location"]),
    licence: String(row["licence_or_permission_status"]),
    synthetic: row["synthetic_provenance"] === true,
    staleness: stalenessOf(vintage.getTime(), asOf.getTime(), Number(row["max_age_days"])),
  };
  return {
    ...displayable,
    datasetId: String(row["dataset_id"]),
    jurisdictionId: String(row["jurisdiction_id"]),
    lineage: lineageSentence(displayable),
  };
};

/**
 * Every context figure for a set of jurisdictions, each with its lineage.
 *
 * The lineage sentence is computed here rather than left to the caller,
 * because "every displayed context value links to a source record or is
 * visibly synthetic" is not a property a screen can be trusted to remember —
 * it has to arrive attached to the number.
 */
export const readContextForJurisdictions = async (
  tx: Queryable,
  options: { readonly jurisdictionIds: readonly string[]; readonly asOf: Date },
): Promise<readonly ContextValueRow[]> => {
  if (options.jurisdictionIds.length === 0) return [];
  const { rows } = await tx.query(
    `select o.dataset_id, o.jurisdiction_id, o.value, o.missing_indicator, o.unit, o.vintage,
            d.kind, d.label, d.max_age_days, d.synthetic_provenance,
            s.source_name, s.source_url_or_location, s.licence_or_permission_status
       from context_observation o
       join context_dataset d on d.dataset_id = o.dataset_id
       join source_record s on s.source_record_id = d.source_record_id
      where o.jurisdiction_id = any($1::uuid[])
      order by d.kind, d.dataset_id, o.jurisdiction_id`,
    [[...options.jurisdictionIds]],
  );
  return rows.map((row) => toValueRow(row, options.asOf));
};

export type ImportRunSummary = {
  readonly runId: string;
  readonly datasetId: string;
  readonly ranAt: string;
  readonly rowsRead: number;
  readonly rowsLoaded: number;
  readonly rowsRejected: number;
  readonly rejections: readonly {
    readonly code: string;
    readonly detail: string;
    readonly rowIndex: number;
  }[];
};

/** The most recent run per dataset, with what it refused and why. */
export const readImportRuns = async (
  tx: Queryable,
  options: { readonly jurisdictionProfileId: string },
): Promise<readonly ImportRunSummary[]> => {
  const { rows } = await tx.query(
    `select distinct on (r.dataset_id)
            r.run_id, r.dataset_id, r.ran_at, r.rows_read, r.rows_loaded, r.rows_rejected
       from context_import_run r
       join context_dataset d on d.dataset_id = r.dataset_id
      where d.jurisdiction_profile_id = $1
      order by r.dataset_id, r.ran_at desc`,
    [options.jurisdictionProfileId],
  );
  const summaries: ImportRunSummary[] = [];
  for (const row of rows) {
    const { rows: rejectionRows } = await tx.query(
      `select row_index, reason_code, detail from context_import_rejection
        where run_id = $1 order by row_index, reason_code`,
      [String(row["run_id"])],
    );
    summaries.push({
      runId: String(row["run_id"]),
      datasetId: String(row["dataset_id"]),
      ranAt: new Date(String(row["ran_at"])).toISOString(),
      rowsRead: Number(row["rows_read"]),
      rowsLoaded: Number(row["rows_loaded"]),
      rowsRejected: Number(row["rows_rejected"]),
      rejections: rejectionRows.map((rejection) => ({
        rowIndex: Number(rejection["row_index"]),
        code: String(rejection["reason_code"]),
        detail: String(rejection["detail"]),
      })),
    });
  }
  return summaries;
};
