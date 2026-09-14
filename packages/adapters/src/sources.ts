/**
 * Synthetic source-import adapters (roadmap V010).
 *
 * Supplies project and demographic context from team-created synthetic rows.
 * Every row is labelled `synthetic` / `team_created_synthetic`, because V004
 * classifies every real candidate source as reference-only or
 * unavailable-for-ingestion: there is no permitted external dataset to import.
 *
 * Deliberately modelled awkward cases:
 *  - **missing project match** — an empty result, which means *unknown*, never
 *    "this asset has no funding" (V002 row 20);
 *  - **stale records** — rows whose `source_effective_at` is old, surfaced via
 *    `isStale()` so a caller can show staleness instead of hiding it.
 */

import {
  nowIso,
  unsafeUuid,
  type AdapterCallContext,
  type AdapterDescriptor,
  type AdapterOutcome,
  type CapabilityDescriptor,
  type IsoTimestamp,
  type SourceImportAdapter,
  type SourceImportQuery,
  type SourceRecordSnapshot,
} from "@vision/contracts";

export const SYNTHETIC_SOURCE_PROVIDER = "synthetic-source-import";

export const SYNTHETIC_SOURCE_CAPABILITY: CapabilityDescriptor = {
  capability: "source_import",
  provider_name: SYNTHETIC_SOURCE_PROVIDER,
  provider_mode: "simulated",
  display_label: "Simulated source import — team-created synthetic records only",
  v002_row: 20,
  may_claim: [
    "Synthetic context record, labelled as synthetic",
    "No matching record found (meaning unknown)",
  ],
  must_not_claim: [
    "Confirmed government has or has not funded this asset",
    "Verified affected citizens",
  ],
};

export type SyntheticSourceOptions = {
  /** Datasets this adapter serves. Unknown datasets are rejected, not faked. */
  readonly rows?: Readonly<Record<string, readonly SourceRecordSnapshot[]>>;
  /** When set, every call returns `unavailable` — used to test degraded feeds. */
  readonly forceUnavailable?: boolean;
};

const SYNTHETIC_PROJECT_ROWS: readonly SourceRecordSnapshot[] = [
  {
    source_record_id: unsafeUuid("a1000000-0000-4000-8000-000000000001"),
    source_name: "synthetic sanctioned-project register",
    source_url_or_location: "packages/adapters/src/sources.ts#SYNTHETIC_PROJECT_ROWS",
    retrieved_at: "2026-09-09T09:00:00Z" as IsoTimestamp,
    source_effective_at: "2026-08-01T00:00:00Z" as IsoTimestamp,
    licence_or_permission_status: "synthetic",
    demo_status: "team_created_synthetic",
    raw_snapshot: {
      project_id: "synthetic-project-001",
      asset_id: "demo-asset-001",
      stage: "sanctioned",
      label: "SYNTHETIC — not a real sanctioned project",
    },
  },
  {
    // Deliberately stale: exercises the "stale records" requirement.
    source_record_id: unsafeUuid("a1000000-0000-4000-8000-000000000002"),
    source_name: "synthetic sanctioned-project register",
    source_url_or_location: "packages/adapters/src/sources.ts#SYNTHETIC_PROJECT_ROWS",
    retrieved_at: "2026-09-09T09:00:00Z" as IsoTimestamp,
    source_effective_at: "2024-01-15T00:00:00Z" as IsoTimestamp,
    licence_or_permission_status: "synthetic",
    demo_status: "team_created_synthetic",
    raw_snapshot: {
      project_id: "synthetic-project-002",
      asset_id: "demo-asset-002",
      stage: "completed",
      label: "SYNTHETIC — deliberately stale record",
    },
  },
];

const SYNTHETIC_DEMOGRAPHIC_ROWS: readonly SourceRecordSnapshot[] = [
  {
    source_record_id: unsafeUuid("a2000000-0000-4000-8000-000000000001"),
    source_name: "synthetic enrolment estimate",
    source_url_or_location: "packages/adapters/src/sources.ts#SYNTHETIC_DEMOGRAPHIC_ROWS",
    retrieved_at: "2026-09-09T09:00:00Z" as IsoTimestamp,
    source_effective_at: "2026-07-01T00:00:00Z" as IsoTimestamp,
    licence_or_permission_status: "synthetic",
    demo_status: "team_created_synthetic",
    raw_snapshot: {
      asset_id: "demo-asset-001",
      estimated_population_served: 240,
      estimate_method: "SYNTHETIC — fabricated for demonstration",
    },
  },
];

export const SYNTHETIC_SOURCE_ROWS: Readonly<Record<string, readonly SourceRecordSnapshot[]>> = {
  projects: SYNTHETIC_PROJECT_ROWS,
  demographics: SYNTHETIC_DEMOGRAPHIC_ROWS,
} as const;

/** A synthetic adapter may never emit a row with real-source presentation labels. */
export const isLabelledSynthetic = (snapshot: SourceRecordSnapshot): boolean =>
  snapshot.licence_or_permission_status === "synthetic" &&
  snapshot.demo_status === "team_created_synthetic";

const hasVisibleSyntheticMarker = (snapshot: SourceRecordSnapshot): boolean => {
  if (snapshot.raw_snapshot === undefined) return false;
  try {
    return /synthetic/i.test(JSON.stringify(snapshot.raw_snapshot));
  } catch {
    return false;
  }
};

const cloneSnapshot = (snapshot: SourceRecordSnapshot): SourceRecordSnapshot =>
  structuredClone(snapshot);

/**
 * Copy and validate at the adapter boundary. The options hook exists for
 * controlled test/demo scenarios, but it must not provide a way to make this
 * explicitly synthetic provider emit rows labelled as real or permitted.
 */
const prepareSyntheticRows = (
  configured: Readonly<Record<string, readonly SourceRecordSnapshot[]>>,
): Readonly<Record<string, readonly SourceRecordSnapshot[]>> =>
  Object.fromEntries(
    Object.entries(configured).map(([dataset, rows]) => [
      dataset,
      rows.map((row, index) => {
        if (!isLabelledSynthetic(row)) {
          throw new Error(
            `synthetic source row '${dataset}[${String(index)}]' must be labelled synthetic`,
          );
        }
        if (!hasVisibleSyntheticMarker(row)) {
          throw new Error(
            `synthetic source row '${dataset}[${String(index)}]' must include a visible SYNTHETIC marker in raw_snapshot`,
          );
        }
        return cloneSnapshot(row);
      }),
    ]),
  );

export class SyntheticSourceImportAdapter implements SourceImportAdapter {
  readonly descriptor: AdapterDescriptor = {
    provider_name: SYNTHETIC_SOURCE_PROVIDER,
    provider_mode: "simulated",
    capability: SYNTHETIC_SOURCE_CAPABILITY,
  };

  private readonly rows: Readonly<Record<string, readonly SourceRecordSnapshot[]>>;
  private readonly forceUnavailable: boolean;
  private readonly clock: () => IsoTimestamp;

  constructor(options: SyntheticSourceOptions = {}, clock: () => IsoTimestamp = nowIso) {
    this.rows = prepareSyntheticRows(options.rows ?? SYNTHETIC_SOURCE_ROWS);
    this.forceUnavailable = options.forceUnavailable ?? false;
    this.clock = clock;
  }

  private provenance(fixtureId: string) {
    return {
      provider_mode: "simulated",
      authenticity: "simulated_fixture",
      provider_name: SYNTHETIC_SOURCE_PROVIDER,
      observed_at: this.clock(),
      fixture_id: fixtureId,
    } as const;
  }

  async fetchRecords(
    query: SourceImportQuery,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<readonly SourceRecordSnapshot[]>> {
    const correlation_id = context.correlation_id;

    if (this.forceUnavailable) {
      return {
        kind: "unavailable",
        reason_code: "source_feed_unreachable",
        retryable: true,
        retry_after_ms: 5_000,
        provenance: this.provenance("source_import.unavailable"),
        correlation_id,
      };
    }

    const dataset = this.rows[query.dataset];
    if (dataset === undefined) {
      return {
        kind: "rejected",
        reason_code: "unknown_dataset",
        retryable: false,
        detail: `no synthetic dataset is configured for '${query.dataset}'`,
        provenance: this.provenance("source_import.rejected"),
        correlation_id,
      };
    }

    // An empty result is a successful "unknown", never an error and never
    // evidence that no such project or population exists.
    return {
      kind: "success",
      // Do not expose the adapter's in-memory fixtures to caller mutation.
      value: dataset.map(cloneSnapshot),
      provenance: this.provenance("source_import.success"),
      correlation_id,
    };
  }
}

/**
 * A snapshot is stale when its source-effective date is older than the allowed
 * window. Staleness is a display and review signal, not a reason to discard
 * the record silently.
 */
export const isStale = (
  snapshot: SourceRecordSnapshot,
  now: IsoTimestamp,
  maxAgeDays: number,
): boolean => {
  if (snapshot.source_effective_at === undefined) {
    return true;
  }
  const ageMs = Date.parse(now) - Date.parse(snapshot.source_effective_at);
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
};
