#!/usr/bin/env node
/**
 * Loads the sanctioned-project register and proposes links (V041).
 *
 * Usage:
 *   npm run projects:seed     load the register, attach the demo asset, match
 *   npm run projects:match    re-run the matcher over the profile's issues
 *   npm run projects:report   print what the matcher last found
 *
 * Every outcome is printed, including the ones that found nothing. A loader
 * that prints only its successes is how "no project was found" becomes
 * invisible, and invisible is exactly how it gets read as "not funded".
 */

import pg from "pg";

import { loadProjectRegister as loadPack } from "@vision/config-packs";
import { loadProjectRegister, proposeLinksForIssue, readProjectLinks } from "@vision/adapters";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";
const PROFILE = process.env.JURISDICTION_PROFILE_ID ?? "demo-district-a";

/**
 * The demo attachment.
 *
 * One report is attached to a synthetic asset so the strongest matching path —
 * a project naming the physical thing rather than a place near it — is
 * exercised by the demonstration and not only by tests.
 */
const DEMO_ASSET_ATTACHMENTS = [
  { publicReference: "VIS-V034-WTR", assetId: "demo-asset-001" },
  // Attached so V043's comparison view has a report whose own lifecycle falls
  // inside a project's dates — including a reopening, which is the event that
  // most resists being read as the money having worked.
  { publicReference: "VIS-V035-WATER", assetId: "demo-asset-005" },
];

const command = process.argv[2] ?? "report";
const client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 60_000 });
await client.connect();

try {
  const asOf = new Date();
  const pack = loadPack(PROFILE);
  const source = {
    source_record_id: pack.source.sourceRecordId,
    source_name: pack.source.sourceName,
    source_url_or_location: pack.source.sourceUrlOrLocation,
    retrieved_at: pack.source.retrievedAt,
    ...(pack.source.sourceEffectiveAt === undefined
      ? {}
      : { source_effective_at: pack.source.sourceEffectiveAt }),
    licence_or_permission_status: pack.source.licenceOrPermissionStatus,
    demo_status: pack.source.demoStatus,
  };

  if (command === "seed" || command === "load") {
    console.log(`project register ${pack.version} — ${pack.projects.length} project(s)`);
    console.log(`  ${pack.notice}`);
    const result = await loadProjectRegister(client, {
      projects: pack.projects,
      source,
      jurisdictionProfileId: PROFILE,
    });
    console.log(`  loaded ${result.loaded}, skipped ${result.skipped.length}`);
    for (const skip of result.skipped) console.log(`    ${skip.projectId}: ${skip.reason}`);
  }

  if (command === "seed") {
    for (const attachment of DEMO_ASSET_ATTACHMENTS) {
      const { rowCount } = await client.query(
        "update canonical_issue set asset_id = $2 where public_reference = $1",
        [attachment.publicReference, attachment.assetId],
      );
      console.log(
        `  attached ${attachment.publicReference} to ${attachment.assetId} (${rowCount ?? 0} row)`,
      );
    }
  }

  if (command === "seed" || command === "match") {
    const { rows } = await client.query(
      `select c.issue_id, c.public_reference
         from canonical_issue c
         join jurisdiction j on j.jurisdiction_id = c.jurisdiction_id
        where j.jurisdiction_profile_id = $1
        order by c.opened_at`,
      [PROFILE],
    );
    console.log("");
    console.log(`Matching ${rows.length} report(s) against the register`);
    const tally = { single_candidate: 0, ambiguous: 0, no_candidate: 0 };
    for (const row of rows) {
      const result = await proposeLinksForIssue(client, {
        issueId: String(row.issue_id),
        registerName: pack.source.sourceName,
        registerIsSynthetic: pack.source.licenceOrPermissionStatus === "synthetic",
        sourceRecordId: pack.source.sourceRecordId,
        asOf,
      });
      tally[result.proposal.outcome] += 1;
      if (result.proposal.outcome !== "no_candidate") {
        console.log(
          `  ${String(row.public_reference).padEnd(24)} ${result.proposal.outcome}: ${result.proposal.candidates.map((c) => c.projectId).join(", ")}`,
        );
      }
    }
    console.log(
      `  ${tally.single_candidate} single candidate, ${tally.ambiguous} ambiguous, ${tally.no_candidate} with no match recorded`,
    );
  }

  const { rows: issues } = await client.query(
    `select c.issue_id, c.public_reference, c.category
       from canonical_issue c
       join project_link l on l.issue_id = c.issue_id
      group by c.issue_id, c.public_reference, c.category
      order by c.public_reference`,
  );
  const links = await readProjectLinks(client, {
    issueIds: issues.map((row) => String(row.issue_id)),
  });

  const unmatchedIssues = issues.filter((issue) =>
    links
      .filter((link) => link.issueId === String(issue.issue_id))
      .every((link) => link.status === "unmatched"),
  );
  const matchedIssues = issues.filter((issue) => !unmatchedIssues.includes(issue));

  console.log("");
  console.log(`Recorded findings (${links.length} row(s) across ${issues.length} report(s))`);

  // The no-matches are stated first and as a count with the note in full. A
  // report that lists only its links is how "we searched and found nothing"
  // becomes invisible, and invisible is how it gets read as "not funded".
  console.log("");
  console.log(`  ${unmatchedIssues.length} report(s) searched with NO MATCH RECORDED`);
  if (unmatchedIssues.length > 0) {
    console.log(`      ${links.find((link) => link.status === "unmatched")?.absenceNote ?? ""}`);
    console.log(
      `      for example: ${unmatchedIssues
        .slice(0, 5)
        .map((issue) => String(issue.public_reference))
        .join(", ")}`,
    );
  }

  console.log("");
  console.log(`  ${matchedIssues.length} report(s) with a candidate to review`);
  for (const issue of matchedIssues) {
    console.log(`  ${String(issue.public_reference)}`);
    for (const link of links.filter((link) => link.issueId === String(issue.issue_id))) {
      console.log(
        `      ${link.status.padEnd(10)} ${String(link.projectId).padEnd(14)} ${link.matchMethod ?? ""}`,
      );
      for (const reason of link.reasons) console.log(`          · ${reason}`);
    }
  }
} finally {
  await client.end();
}
