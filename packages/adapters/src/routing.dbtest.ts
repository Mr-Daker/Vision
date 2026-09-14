/**
 * Department routing through a versioned directory (roadmap V033).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * Routing is a **deterministic directory lookup**, not an inference. The AI
 * proposes a category; the directory decides who owns that category in that
 * jurisdiction, as of a date, at a recorded version. Conflating the two would
 * let an unreviewed model output look like an authority decision.
 *
 * The other rule: the demo may route internally and may route to a simulated
 * recipient, and it must never present either as a government acknowledgment.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { resolveRouting, seedRoutingDirectory, RoutingError } from "./routing.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
let jurisdictionId: string;
let otherJurisdictionId: string;
const issues: string[] = [];
const responsibilities: string[] = [];

const ORIGIN = { lon: 75.31, lat: 17.51 };
const DIRECTORY = "demo-routing.v1";

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  for (const id of [(jurisdictionId = randomUUID()), (otherJurisdictionId = randomUUID())]) {
    await client.query(
      `insert into jurisdiction
         (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
          level_scheme, level_code, effective_from, synthetic_provenance)
       values ($1,'test-profile',$2,$3,'test-scheme','district',
               now() - interval '1 year', true)`,
      [id, `code-${id.slice(0, 8)}`, DIRECTORY],
    );
  }
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (issues.length > 0) {
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query("delete from status_event where aggregate_id = any($1::text[])", [
        issues,
      ]);
      await cleaner.query("delete from canonical_issue where issue_id = any($1::uuid[])", [issues]);
    }
    if (responsibilities.length > 0) {
      await cleaner.query(
        "delete from responsibility_directory where responsibility_id = any($1::uuid[])",
        [responsibilities],
      );
    }
    await cleaner.query("delete from jurisdiction where jurisdiction_id = any($1::uuid[])", [
      [jurisdictionId, otherJurisdictionId],
    ]);
  } finally {
    await cleaner.end();
  }
});

const newIssue = async (category: string, jurisdiction: string | null): Promise<string> => {
  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,$3,'created', now(),
             ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, now(), $6)`,
    [
      issueId,
      `VIS-${issueId.slice(0, 8).toUpperCase()}`,
      category,
      ORIGIN.lon,
      ORIGIN.lat,
      jurisdiction,
    ],
  );
  issues.push(issueId);
  return issueId;
};

const addDirectoryEntry = async (options: {
  readonly category: string;
  readonly jurisdiction?: string;
  readonly departmentId?: string;
  readonly providerMode?: "simulated" | "real";
  readonly version?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
}): Promise<string> => {
  const responsibilityId = randomUUID();
  await client.query(
    `insert into responsibility_directory
       (responsibility_id, directory_version, jurisdiction_id, category,
        department_id, department_label, provider_mode, effective_from, effective_to)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      responsibilityId,
      options.version ?? DIRECTORY,
      options.jurisdiction ?? jurisdictionId,
      options.category,
      options.departmentId ?? `dept-${responsibilityId.slice(0, 6)}`,
      "Test Department (simulated)",
      options.providerMode ?? "simulated",
      options.effectiveFrom ?? new Date(Date.now() - 86_400_000).toISOString(),
      options.effectiveTo ?? null,
    ],
  );
  responsibilities.push(responsibilityId);
  return responsibilityId;
};

// ---------------------------------------------------------------------------
// A route is a directory lookup, and it is explainable
// ---------------------------------------------------------------------------

test("V033: a matching directory entry routes the issue and records the version used", async () => {
  const category = `r33-${randomUUID().slice(0, 6)}`;
  const responsibilityId = await addDirectoryEntry({ category, departmentId: "water-works" });
  const issueId = await newIssue(category, jurisdictionId);

  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  assert.equal(result.outcome, "routed");
  if (result.outcome !== "routed") return;
  assert.equal(result.departmentId, "water-works");
  assert.equal(result.responsibilityId, responsibilityId);
  // Explainable: the exact version consulted is recorded, so the route can be
  // re-derived later even after the directory changes.
  assert.equal(result.directoryVersion, DIRECTORY);
  assert.ok(result.reason.length > 10);

  const { rows } = await client.query(
    "select directory_version, department_id, recipient_mode, outcome, category from routing_decision where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["directory_version"], DIRECTORY);
  assert.equal(rows[0]?.["recipient_mode"], "simulated");
  // The category used for the lookup is recorded, so a later category change
  // does not silently rewrite why this route was chosen.
  assert.equal(rows[0]?.["category"], category);
});

test("V033: a simulated recipient is labelled simulated, never as an authority", async () => {
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({ category, providerMode: "simulated" });
  const issueId = await newIssue(category, jurisdictionId);

  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  assert.equal(result.outcome, "routed");
  if (result.outcome !== "routed") return;
  assert.equal(result.recipientMode, "simulated");
  assert.equal(result.isGovernmentAcknowledgment, false);
  // The word "simulated" specifically. An earlier pattern here also accepted
  // "not an acknowledgment", which the *real*-recipient wording satisfies too
  // — so a simulated route could have described itself as a real one.
  assert.match(result.disclosure, /simulated department/i);
  assert.match(result.disclosure, /nothing here is a government acknowledgment/i);
});

test("V033: routing never claims an acknowledgment of any kind", async () => {
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({ category });
  const issueId = await newIssue(category, jurisdictionId);

  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  // Routing means "we decided who this belongs to". Delivery and
  // acknowledgment are V034's separate facts.
  assert.equal("acknowledged" in result, false);
  assert.equal(result.isGovernmentAcknowledgment, false);
});

// ---------------------------------------------------------------------------
// Unknown, ambiguous and expired ownership
// ---------------------------------------------------------------------------

test("V033: no directory entry sends the issue to review, not to a guess", async () => {
  const category = `r33-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, jurisdictionId);

  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  assert.equal(result.outcome, "no_directory_entry");
  assert.equal(result.recipientMode, "none");
  assert.match(result.reason, /no owner|no entry|not listed|unknown/i);

  const { rows } = await client.query(
    "select department_id, responsibility_id from routing_decision where issue_id = $1",
    [issueId],
  );
  // A review outcome must not pretend to have a recipient.
  assert.equal(rows[0]?.["department_id"], null);
  assert.equal(rows[0]?.["responsibility_id"], null);
});

test("V033: an issue with no jurisdiction goes to unknown-owner review", async () => {
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({ category });
  const issueId = await newIssue(category, null);

  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  assert.equal(result.outcome, "unknown_owner_review");
  assert.match(result.reason, /jurisdiction/i);
});

test("V033: the directory itself forbids two open-ended owners for one category", async () => {
  // The ambiguity branch in `resolveRouting` exists, but it cannot be reached
  // this way: `responsibility_directory_active_uniq` already guarantees one
  // owner per (version, jurisdiction, category) while `effective_to is null`.
  // The constraint is the enforcing mechanism, so the constraint is what this
  // pins. Genuine contested ownership comes from overlapping *jurisdictions*,
  // which is V059's problem and cannot arise from a duplicate row here.
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({ category, departmentId: "dept-a" });

  await assert.rejects(
    () => addDirectoryEntry({ category, departmentId: "dept-b" }),
    /responsibility_directory_active_uniq/,
  );
});

test("V033: a superseded owner and its replacement do not make the route ambiguous", async () => {
  // The realistic shape of a directory change: close the old entry, open a
  // new one. Only the open one is active, so the route stays unambiguous and
  // the closed row remains as history.
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({
    category,
    departmentId: "old-dept",
    effectiveFrom: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    effectiveTo: new Date(Date.now() - 86_400_000).toISOString(),
  });
  await addDirectoryEntry({ category, departmentId: "new-dept" });
  const issueId = await newIssue(category, jurisdictionId);

  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  assert.equal(result.outcome, "routed");
  assert.equal(result.outcome === "routed" ? result.departmentId : undefined, "new-dept");
});

test("V033: an entry that has expired does not route", async () => {
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({
    category,
    effectiveFrom: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    effectiveTo: new Date(Date.now() - 86_400_000).toISOString(),
  });
  const issueId = await newIssue(category, jurisdictionId);

  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  assert.equal(result.outcome, "no_directory_entry");
});

test("V033: an entry that is not yet effective does not route", async () => {
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({
    category,
    effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const issueId = await newIssue(category, jurisdictionId);

  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  assert.equal(result.outcome, "no_directory_entry");
});

test("V033: an entry in another jurisdiction does not route this issue", async () => {
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({ category, jurisdiction: otherJurisdictionId });
  const issueId = await newIssue(category, jurisdictionId);

  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  assert.equal(result.outcome, "no_directory_entry");
});

// ---------------------------------------------------------------------------
// The directory version is part of the question
// ---------------------------------------------------------------------------

test("V033: routing against a different directory version sees different entries", async () => {
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({ category, version: "demo-routing.v1", departmentId: "old-dept" });
  await addDirectoryEntry({ category, version: "demo-routing.v2", departmentId: "new-dept" });
  const first = await newIssue(category, jurisdictionId);
  const second = await newIssue(category, jurisdictionId);

  const v1 = await resolveRouting(client, { issueId: first, directoryVersion: "demo-routing.v1" });
  const v2 = await resolveRouting(client, { issueId: second, directoryVersion: "demo-routing.v2" });

  assert.equal(v1.outcome === "routed" ? v1.departmentId : undefined, "old-dept");
  assert.equal(v2.outcome === "routed" ? v2.departmentId : undefined, "new-dept");
});

test("V033: a blank directory version is refused rather than defaulted", async () => {
  // A route nobody can re-derive is not explainable, and picking "the latest"
  // silently would make two identical issues route differently over time with
  // nothing recording why.
  const category = `r33-${randomUUID().slice(0, 6)}`;
  const issueId = await newIssue(category, jurisdictionId);

  await assert.rejects(
    () => resolveRouting(client, { issueId, directoryVersion: "  " }),
    RoutingError,
  );
});

test("V033: an unknown issue is refused, not routed", async () => {
  await assert.rejects(
    () => resolveRouting(client, { issueId: randomUUID(), directoryVersion: DIRECTORY }),
    RoutingError,
  );
});

// ---------------------------------------------------------------------------
// Separation from AI classification
// ---------------------------------------------------------------------------

test("V033: routing uses the issue's recorded category, not a model call", async () => {
  // There is no classifier parameter and no network call. The category is
  // whatever the issue records; a model proposal becomes that only after
  // review (V032), and conflating the two would let unreviewed model output
  // look like an authority decision.
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({ category, departmentId: "recorded-dept" });
  const issueId = await newIssue(category, jurisdictionId);
  const forbidden = () => {
    throw new Error("routing must not call a classifier");
  };

  const result = await resolveRouting(client, {
    issueId,
    directoryVersion: DIRECTORY,
    classify: forbidden,
  } as never);

  assert.equal(result.outcome === "routed" ? result.departmentId : undefined, "recorded-dept");
});

test("V033: routing twice records both decisions rather than overwriting", async () => {
  const category = `r33-${randomUUID().slice(0, 6)}`;
  await addDirectoryEntry({ category });
  const issueId = await newIssue(category, jurisdictionId);

  await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });
  await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  const { rows } = await client.query(
    "select count(*)::int as n from routing_decision where issue_id = $1",
    [issueId],
  );
  // A re-route is history: why an issue moved between departments is exactly
  // the question an audit asks.
  assert.equal(rows[0]?.["n"], 2);
});

// ---------------------------------------------------------------------------
// Seeding the directory from a pack (closes V033's "no seeded entries")
// ---------------------------------------------------------------------------

test("V033: a directory pack seeds the database and routing then finds an owner", async () => {
  const category = `seed-${randomUUID().slice(0, 6)}`;
  const pack = {
    directoryVersion: DIRECTORY,
    entries: [
      {
        category,
        departmentId: "demo-seeded",
        departmentLabel: "Seeded Department (simulated)",
        providerMode: "simulated" as const,
      },
    ],
  };

  const seeded = await seedRoutingDirectory(client, { jurisdictionId, directory: pack });
  const { rows: added } = await client.query(
    "select responsibility_id from responsibility_directory where category = $1",
    [category],
  );
  for (const row of added) responsibilities.push(String(row["responsibility_id"]));

  assert.equal(seeded.inserted, 1);
  const issueId = await newIssue(category, jurisdictionId);
  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });

  assert.equal(result.outcome, "routed");
  assert.equal(result.outcome === "routed" ? result.departmentId : undefined, "demo-seeded");
});

test("V033: seeding twice is idempotent, not a constraint violation", async () => {
  // A redeploy re-runs the seed. Colliding with
  // responsibility_directory_active_uniq would make deployment fail on a
  // second run, which is how seeding gets quietly disabled.
  const category = `seed-${randomUUID().slice(0, 6)}`;
  const pack = {
    directoryVersion: DIRECTORY,
    entries: [
      {
        category,
        departmentId: "demo-seeded",
        departmentLabel: "Seeded Department (simulated)",
        providerMode: "simulated" as const,
      },
    ],
  };

  const first = await seedRoutingDirectory(client, { jurisdictionId, directory: pack });
  const second = await seedRoutingDirectory(client, { jurisdictionId, directory: pack });
  const { rows: added } = await client.query(
    "select responsibility_id from responsibility_directory where category = $1",
    [category],
  );
  for (const row of added) responsibilities.push(String(row["responsibility_id"]));

  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(second.alreadyPresent, 1);
  assert.equal(added.length, 1);
});

test("V033: changing an owner without changing the directory version is refused", async () => {
  const category = `seed-${randomUUID().slice(0, 6)}`;
  const base = {
    directoryVersion: DIRECTORY,
    entries: [
      {
        category,
        departmentId: "demo-original",
        departmentLabel: "Original Department (simulated)",
        providerMode: "simulated" as const,
      },
    ],
  };
  await seedRoutingDirectory(client, { jurisdictionId, directory: base });
  const { rows: added } = await client.query(
    "select responsibility_id from responsibility_directory where category = $1",
    [category],
  );
  for (const row of added) responsibilities.push(String(row["responsibility_id"]));

  await assert.rejects(
    () =>
      seedRoutingDirectory(client, {
        jurisdictionId,
        directory: {
          ...base,
          entries: [
            {
              category,
              providerMode: "simulated" as const,
              departmentId: "demo-replacement",
              departmentLabel: "Replacement Department (simulated)",
            },
          ],
        },
      }),
    /changed.*without changing its version/i,
  );
});

test("V033: a seeded entry is written as simulated, whatever the pack says", async () => {
  // This is the one property of seeding that must not be loosenable. The pack
  // loader refuses a real recipient, but a seed that wrote `provider_mode =
  // 'real'` anyway would make routing report a real recipient mode, and the
  // whole demo would then claim a government relationship that does not exist.
  // So the seed hard-codes 'simulated' and does not read a mode from the pack;
  // this test is what stops that hard-coding being replaced by a pass-through.
  const category = `seed-${randomUUID().slice(0, 6)}`;
  await seedRoutingDirectory(client, {
    jurisdictionId,
    directory: {
      directoryVersion: DIRECTORY,
      entries: [
        {
          category,
          departmentId: "demo-seeded",
          departmentLabel: "Seeded Department (simulated)",
          // A pack that has somehow been built by hand claiming otherwise.
          providerMode: "real" as unknown as "simulated",
        },
      ],
    },
  });
  const { rows: added } = await client.query(
    "select responsibility_id, provider_mode from responsibility_directory where category = $1",
    [category],
  );
  for (const row of added) responsibilities.push(String(row["responsibility_id"]));

  assert.equal(added[0]?.["provider_mode"], "simulated");

  const issueId = await newIssue(category, jurisdictionId);
  const result = await resolveRouting(client, { issueId, directoryVersion: DIRECTORY });
  assert.equal(result.outcome === "routed" ? result.recipientMode : undefined, "simulated");
});
