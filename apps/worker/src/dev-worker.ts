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
} from "@vision/adapters";
import {
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
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

await client.end();
