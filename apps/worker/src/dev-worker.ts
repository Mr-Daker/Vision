/**
 * Development worker loop (roadmap V006 D3, V017).
 *
 * Run with: npm run worker
 *
 * The loop lives here rather than in `relay.ts` so that one relay pass stays a
 * plain function — testable without timers, and with a cadence a deployment
 * chooses rather than one compiled in.
 *
 * This is a *development* runner. It selects a versioned profile pack, seeds
 * its synthetic boundaries and routing rules idempotently, resolves each
 * report's own location, polls on a fixed interval, and logs counts. A deployed worker
 * would take its work from the authenticated relay rather than polling, and
 * V049's load work is where the interval would be chosen from evidence.
 */

import pg from "pg";

import {
  FilesystemObjectStoreAdapter,
  reclaimAbandonedClaims,
  resolveJurisdictionAtLocation,
  seedJurisdictionProfile,
  seedRoutingDirectoryForProfile,
  summaryStatus,
  sweepAgeingAlerts,
  applySummaryEvents,
  rebuildSummaries,
  reconcileSummaries,
} from "@vision/adapters";
import {
  loadAgeingPolicy,
  loadJurisdictionProfile,
  loadMatchingBounds,
  loadRoutingDirectory,
  loadTaxonomy,
} from "@vision/config-packs";

import { buildStageHandlers } from "./handlers.ts";
import { REGISTERED_TASK_TYPES } from "./index.ts";
import { runRelayOnce } from "./relay.ts";

const databaseUrl =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const intervalMs = Number(process.env["WORKER_POLL_MS"] ?? 2_000);

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

const objectStore = new FilesystemObjectStoreAdapter({
  root: process.env["OBJECT_STORE_ROOT"] ?? "./local-object-store",
  // Development-only fallback, identical in purpose to the API dev server's.
  // A deployed process receives a secret from its runtime, not from this file.
  grantHmacKey: process.env["OBJECT_STORE_GRANT_HMAC_KEY"] ?? "local-dev-grant-key-not-a-secret",
});

const profileId = process.env["JURISDICTION_PROFILE_ID"] ?? "demo-district-a";
const profile = loadJurisdictionProfile(profileId);
const directory = loadRoutingDirectory(profileId);
const bounds = loadMatchingBounds(profileId);
const taxonomy = loadTaxonomy(profileId);
const seededProfile = await seedJurisdictionProfile(client, profile);
const seededDirectory = await seedRoutingDirectoryForProfile(client, {
  profileId,
  boundaryVersion: profile.directory_version,
  directory,
});

const handlers = buildStageHandlers({
  client,
  objectStore,
  jurisdictionId: undefined,
  resolveJurisdiction: ({ lon, lat, accuracyMetres, observedAt }) =>
    resolveJurisdictionAtLocation(client, {
      profileId,
      boundaryVersion: profile.directory_version,
      lon,
      lat,
      accuracyMetres,
      observedAt,
    }),
  fallbackCategory: process.env["WORKER_FALLBACK_CATEGORY"] ?? "sanitation",
  directoryVersion: directory.directoryVersion,
  bounds,
  taxonomy: {
    version: taxonomy.version,
    categoryIds: taxonomy.categoryIds,
    defectIds: taxonomy.defectIds,
  },
});

const owner = `dev-worker:${process.pid}`;
console.log(`vision dev worker on ${databaseUrl.replace(/:[^:@]*@/, ":***@")}`);
console.log(`  task types: ${REGISTERED_TASK_TYPES.join(", ")}`);
console.log(
  `  jurisdiction: ${profileId}/${profile.directory_version} (${String(seededProfile.inserted)} inserted, ${String(seededProfile.updated)} refreshed)`,
);
console.log(
  `  routing:      ${directory.directoryVersion} (${String(seededDirectory.inserted)} inserted, ${String(seededDirectory.alreadyPresent)} present)`,
);

// Loaded once: a pack that fails validation should stop the worker at startup
// rather than silently skip every sweep.
const ageingPolicy = loadAgeingPolicy(profileId);

/** Jurisdictions this profile actually seeded, so the sweep is scoped. */
const ageingJurisdictions = async (): Promise<readonly string[]> => {
  const { rows } = await client.query(
    "select jurisdiction_id from jurisdiction where jurisdiction_profile_id = $1",
    [profileId],
  );
  return rows.map((row) => String(row["jurisdiction_id"]));
};

// V038 summary projection. Seeded by a rebuild when it has never been built,
// then maintained incrementally. Reconciled on a slower cadence than it is
// applied, because a reconciliation reads every issue and a projection that
// was checked a moment ago is not what a reader needs — a projection that is
// checked *often enough that a fault surfaces the same day* is.
const reconcileEveryPasses = Number(process.env["SUMMARY_RECONCILE_EVERY"] ?? 30);
let summaryPass = 0;

const startupSummary = await summaryStatus(client, { asOf: new Date() });
if (startupSummary.freshness.state === "never_built") {
  const built = await rebuildSummaries(client, { asOf: new Date() });
  console.log(
    `  summaries:   seeded by rebuild — ${String(built.issuesProjected)} issue(s) into ${String(built.cellsWritten)} cell(s)`,
  );
} else {
  console.log(`  summaries:   ${startupSummary.freshness.explanation}`);
}

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

while (running) {
  try {
    // Work whose claim was abandoned by a crashed relay would otherwise stay
    // claimed forever and never happen (V017).
    const reclaimed = await reclaimAbandonedClaims(client);
    if (reclaimed > 0) console.log(`  reclaimed ${String(reclaimed)} abandoned claim(s)`);

    const pass = await runRelayOnce(client, {
      handlers,
      claimedBy: owner,
      limit: 20,
      taskTypes: [...REGISTERED_TASK_TYPES],
    });
    if (pass.claimed > 0) {
      console.log(
        `  claimed ${String(pass.claimed)} delivered ${String(pass.delivered)} failed ${String(pass.failed)} unhandled ${String(pass.unhandled)}`,
      );
      for (const note of pass.notes) console.log(`    ${note}`);
    }
  } catch (error) {
    console.error(`  relay pass failed: ${error instanceof Error ? error.name : "unknown"}`);
  }

  // V036 ageing sweep. Separate from the relay pass because it is not outbox
  // work: nothing is delivered, and a failure here must not make a delivered
  // task look unhandled. `asOf` is passed rather than read inside, so this and
  // the tests drive the same code path.
  try {
    const asOf = new Date();
    for (const jurisdictionId of await ageingJurisdictions()) {
      const swept = await sweepAgeingAlerts(client, {
        jurisdictionId,
        policy: ageingPolicy,
        asOf,
        limit: 500,
      });
      if (swept.raised > 0) {
        console.log(
          `  ageing: raised ${String(swept.raised)} alert(s) across ${String(swept.evaluated)} issue(s) in ${jurisdictionId}`,
        );
      }
    }
  } catch (error) {
    console.error(`  ageing sweep failed: ${error instanceof Error ? error.name : "unknown"}`);
  }

  // V038 summary projection. Its own try/catch for the same reason as the
  // ageing sweep: a projection that cannot keep up must not make delivered
  // outbox work look unhandled, and a reconciliation that finds a fault must
  // not stop the relay.
  try {
    summaryPass += 1;
    const pass = await applySummaryEvents(client, { asOf: new Date(), limit: 500 });
    if (pass.eventsApplied > 0 || pass.issuesDiscovered > 0) {
      console.log(
        `  summaries: applied ${String(pass.eventsApplied)} event(s), found ${String(pass.issuesDiscovered)} unprojected issue(s), reprojected ${String(pass.issuesProjected)} into ${String(pass.cellsRefreshed)} cell(s)`,
      );
    }
    if (reconcileEveryPasses > 0 && summaryPass % reconcileEveryPasses === 0) {
      const run = await reconcileSummaries(client, { asOf: new Date() });
      if (!run.reconciled) {
        // Loud, and specific enough to act on. A reconciliation failure that
        // logs only "mismatch" gets muted rather than investigated.
        console.error(
          `  summaries: RECONCILIATION FAILED — ${String(run.mismatchedFacts)} issue(s) and ${String(run.mismatchedCells)} cell(s) disagree with a clean rebuild (run ${run.runId})`,
        );
        for (const difference of run.factDifferences.slice(0, 5)) {
          console.error(
            `    ${difference.issueId} ${difference.field}: projected ${difference.incremental}, rebuilt ${difference.rebuilt}`,
          );
        }
      }
    }
  } catch (error) {
    console.error(
      `  summary projection failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

await client.end();
