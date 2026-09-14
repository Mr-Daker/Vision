/**
 * Staff triage and acknowledgment (roadmap V034).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * Three things are constantly conflated in civic software, and keeping them
 * apart is most of this task:
 *
 *  1. **we sent it** — a delivery attempt, ours;
 *  2. **we accepted it** — internal acceptance by a staff member, still ours;
 *  3. **they acknowledged it** — the only one involving the outside world.
 *
 * An interface that shows "acknowledged" for any of the first two tells a
 * citizen their report reached an authority when it did not. So they are
 * separate rows with separate actors, and only the third may carry provider
 * provenance — which in this demo always says simulated.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import type { Principal } from "@vision/domain";

import {
  listDepartmentInbox,
  assignIssue,
  recordAcknowledgment,
  StaffError,
} from "./staff-inbox.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
let jurisdictionId: string;
const issues: string[] = [];
const responsibilities: string[] = [];
const participants: string[] = [];
const submissions: string[] = [];

const ORIGIN = { lon: 75.41, lat: 17.61 };
const DIRECTORY = "demo-routing.v1";
const DEPARTMENT = "water-works";

const staff = (): Principal => ({
  role: "department_staff",
  staffId: randomUUID() as never,
  jurisdictionScope: [jurisdictionId],
  responsibilityScope: [{ jurisdictionId, departmentId: DEPARTMENT }],
  sessionId: randomUUID() as never,
});

const citizen = (participantId: string): Principal => ({
  role: "citizen",
  participantId: participantId as never,
  jurisdictionScope: [],
  sessionId: randomUUID() as never,
});

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
  jurisdictionId = randomUUID();
  await client.query(
    `insert into jurisdiction
       (jurisdiction_id, jurisdiction_profile_id, internal_code, directory_version,
        level_scheme, level_code, effective_from, synthetic_provenance)
     values ($1,'test-profile',$2,$3,'test-scheme','district',
             now() - interval '1 year', true)`,
    [jurisdictionId, `code-${jurisdictionId.slice(0, 8)}`, DIRECTORY],
  );
});

after(async () => {
  await client.end().catch(() => undefined);
  const cleaner = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 10_000 });
  await cleaner.connect();
  try {
    if (issues.length > 0) {
      await cleaner.query("delete from acknowledgment where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query("delete from assignment where issue_id = any($1::uuid[])", [issues]);
      await cleaner.query("delete from routing_decision where issue_id = any($1::uuid[])", [
        issues,
      ]);
      await cleaner.query(
        "delete from issue_participation where canonical_issue_id = any($1::uuid[])",
        [issues],
      );
    }
    if (submissions.length > 0) {
      await cleaner.query(
        "delete from issue_evidence_link where evidence_id in (select evidence_id from evidence_item where submission_id = any($1::uuid[]))",
        [submissions],
      );
      await cleaner.query("delete from evidence_item where submission_id = any($1::uuid[])", [
        submissions,
      ]);
      await cleaner.query("delete from submission where submission_id = any($1::uuid[])", [
        submissions,
      ]);
    }
    if (issues.length > 0) {
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
    if (participants.length > 0) {
      await cleaner.query("delete from participant where participant_id = any($1::uuid[])", [
        participants,
      ]);
    }
    await cleaner.query("delete from jurisdiction where jurisdiction_id = $1", [jurisdictionId]);
  } finally {
    await cleaner.end();
  }
});

const newParticipant = async (): Promise<string> => {
  const id = randomUUID();
  await client.query("insert into participant (participant_id) values ($1)", [id]);
  participants.push(id);
  return id;
};

/** An issue already routed to the department, as V033 leaves it. */
const routedIssue = async (
  options: { readonly openedDaysAgo?: number; readonly category?: string } = {},
): Promise<string> => {
  const category = options.category ?? `s34-${randomUUID().slice(0, 6)}`;
  const responsibilityId = randomUUID();
  await client.query(
    `insert into responsibility_directory
       (responsibility_id, directory_version, jurisdiction_id, category,
        department_id, department_label, provider_mode, effective_from)
     values ($1,$2,$3,$4,$5,'Water Works (simulated)','simulated', now() - interval '1 day')`,
    [responsibilityId, DIRECTORY, jurisdictionId, category, DEPARTMENT],
  );
  responsibilities.push(responsibilityId);

  const issueId = randomUUID();
  await client.query(
    `insert into canonical_issue
       (issue_id, public_reference, category, current_status, opened_at,
        representative_location, last_evidence_at, jurisdiction_id)
     values ($1,$2,$3,'routed_internal', now() - ($4::numeric * interval '1 day'),
             ST_SetSRID(ST_MakePoint($5,$6),4326)::geography, now(), $7)`,
    [
      issueId,
      `VIS-${issueId.slice(0, 8).toUpperCase()}`,
      category,
      options.openedDaysAgo ?? 1,
      ORIGIN.lon,
      ORIGIN.lat,
      jurisdictionId,
    ],
  );
  issues.push(issueId);

  await client.query(
    `insert into routing_decision
       (routing_id, issue_id, directory_version, category, jurisdiction_id,
        responsibility_id, department_id, department_label, recipient_mode, outcome, reason)
     values ($1,$2,$3,$4,$5,$6,$7,'Water Works (simulated)','simulated','routed','test route')`,
    [randomUUID(), issueId, DIRECTORY, category, jurisdictionId, responsibilityId, DEPARTMENT],
  );
  return issueId;
};

const addEvidence = async (issueId: string): Promise<void> => {
  const participantId = await newParticipant();
  const submissionId = randomUUID();
  await client.query(
    `insert into submission
       (submission_id, participant_id, observed_location, observed_accuracy_m,
        observed_location_source, observed_at, interface_locale, locale_pack_version,
        taxonomy_version, idempotency_key)
     values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, 12,
             'device_geolocation', now(), 'en-IN','demo-locales.v1','demo-taxonomy.v1',$5)`,
    [submissionId, participantId, ORIGIN.lon, ORIGIN.lat, `v34-${submissionId}`],
  );
  submissions.push(submissionId);
  const evidenceId = randomUUID();
  await client.query(
    `insert into evidence_item (evidence_id, submission_id, media_type, content_text)
     values ($1,$2,'text','The tap has been dry for a week.')`,
    [evidenceId, submissionId],
  );
  await client.query(
    `insert into issue_evidence_link
       (issue_evidence_link_id, evidence_id, canonical_issue_id, effective_from)
     values ($1,$2,$3, now())`,
    [randomUUID(), evidenceId, issueId],
  );
  await client.query(
    `insert into issue_participation
       (participation_id, participant_id, canonical_issue_id, counted,
        first_evidence_at, last_evidence_at)
     values ($1,$2,$3,true, now(), now())`,
    [randomUUID(), participantId, issueId],
  );
};

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

test("V034: the inbox lists issues routed to this department with their age", async () => {
  const issueId = await routedIssue({ openedDaysAgo: 3 });
  await addEvidence(issueId);

  const inbox = await listDepartmentInbox(client, {
    principal: staff(),
    departmentId: DEPARTMENT,
    jurisdictionId,
  });

  const item = inbox.items.find((candidate) => candidate.issueId === issueId);
  assert.notEqual(item, undefined);
  assert.ok((item?.ageDays ?? 0) >= 2.5 && (item?.ageDays ?? 0) <= 3.5);
  assert.equal(item?.countedParticipants, 1);
  assert.equal(item?.evidenceCount, 1);
  assert.equal(item?.departmentId, DEPARTMENT);
});

test("V034: the inbox never exposes a private original", async () => {
  const issueId = await routedIssue();
  await addEvidence(issueId);

  const inbox = await listDepartmentInbox(client, {
    principal: staff(),
    departmentId: DEPARTMENT,
    jurisdictionId,
  });

  assert.doesNotMatch(JSON.stringify(inbox), /originals\//);
});

test("V034: an issue re-routed elsewhere leaves this inbox", async () => {
  const issueId = await routedIssue();
  // A *newer* decision, not an edit of the old one: re-routing is history, and
  // the inbox must follow the latest decision rather than any decision ever
  // made about the issue.
  await client.query(
    `insert into routing_decision
       (routing_id, issue_id, directory_version, category, jurisdiction_id,
        department_id, department_label, recipient_mode, outcome, reason, decided_at,
        responsibility_id)
     select $1, issue_id, directory_version, category, jurisdiction_id,
            'roads', 'Roads (simulated)', 'simulated', 'routed',
            'reassigned to roads', now() + interval '1 second', responsibility_id
       from routing_decision where issue_id = $2`,
    [randomUUID(), issueId],
  );

  const inbox = await listDepartmentInbox(client, {
    principal: staff(),
    departmentId: DEPARTMENT,
    jurisdictionId,
  });

  assert.equal(
    inbox.items.some((item) => item.issueId === issueId),
    false,
  );
});

test("V034: a citizen cannot read a department inbox", async () => {
  const participantId = await newParticipant();

  await assert.rejects(
    () =>
      listDepartmentInbox(client, {
        principal: citizen(participantId),
        departmentId: DEPARTMENT,
        jurisdictionId,
      }),
    StaffError,
  );
});

test("V034: staff outside the jurisdiction cannot read the inbox", async () => {
  await assert.rejects(
    () =>
      listDepartmentInbox(client, {
        principal: {
          role: "department_staff",
          staffId: randomUUID() as never,
          jurisdictionScope: [randomUUID()],
          sessionId: randomUUID() as never,
        },
        departmentId: DEPARTMENT,
        jurisdictionId,
      }),
    StaffError,
  );
});

// ---------------------------------------------------------------------------
// The three statuses that must not be conflated
// ---------------------------------------------------------------------------

test("V034: a freshly routed issue is delivered to nobody and acknowledged by nobody", async () => {
  const issueId = await routedIssue();

  const inbox = await listDepartmentInbox(client, {
    principal: staff(),
    departmentId: DEPARTMENT,
    jurisdictionId,
  });

  const item = inbox.items.find((candidate) => candidate.issueId === issueId);
  assert.equal(item?.deliveryAttempted, false);
  assert.equal(item?.internallyAccepted, false);
  assert.equal(item?.recipientAcknowledged, false);
  // The label a staff member reads must not imply any of the three.
  assert.match(item?.statusLabel ?? "", /routed|not .*accepted|awaiting/i);
});

test("V034: internal acceptance is not an acknowledgment by anyone outside", async () => {
  const issueId = await routedIssue();
  const principal = staff();

  await recordAcknowledgment(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    kind: "internal_acceptance",
    note: "Picked up by the water works desk.",
  });

  const inbox = await listDepartmentInbox(client, {
    principal,
    departmentId: DEPARTMENT,
    jurisdictionId,
  });
  const item = inbox.items.find((candidate) => candidate.issueId === issueId);

  assert.equal(item?.internallyAccepted, true);
  // The distinction this task exists for.
  assert.equal(item?.recipientAcknowledged, false);
  assert.match(item?.statusLabel ?? "", /accepted internally/i);
  assert.doesNotMatch(item?.statusLabel ?? "", /acknowledged by/i);

  const { rows } = await client.query(
    "select provider_mode, authenticity from acknowledgment where issue_id = $1 and kind = 'internal_acceptance'",
    [issueId],
  );
  // Internal acceptance must claim no provider provenance at all.
  assert.equal(rows[0]?.["provider_mode"], null);
  assert.equal(rows[0]?.["authenticity"], null);
});

test("V034: a recipient acknowledgment must carry its provenance", async () => {
  const issueId = await routedIssue();

  await assert.rejects(
    () =>
      recordAcknowledgment(client, {
        principal: staff(),
        issueId,
        departmentId: DEPARTMENT,
        kind: "recipient_acknowledgment",
        note: "they said yes",
      }),
    /provenance|provider|simulated/i,
  );
});

test("V034: a simulated acknowledgment is recorded as simulated", async () => {
  const issueId = await routedIssue();

  await recordAcknowledgment(client, {
    principal: staff(),
    issueId,
    departmentId: DEPARTMENT,
    kind: "recipient_acknowledgment",
    provenance: {
      providerMode: "simulated",
      authenticity: "simulated_fixture",
      providerReference: "SIM-ACK-0001",
    },
    note: "Simulated department adapter replied.",
  });

  const inbox = await listDepartmentInbox(client, {
    principal: staff(),
    departmentId: DEPARTMENT,
    jurisdictionId,
  });
  const item = inbox.items.find((candidate) => candidate.issueId === issueId);

  assert.equal(item?.recipientAcknowledged, true);
  assert.equal(item?.recipientAcknowledgmentIsSimulated, true);
  // Never "acknowledged by the department" without the qualifier.
  assert.match(item?.statusLabel ?? "", /simulated/i);

  const { rows } = await client.query(
    "select provider_mode, authenticity, provider_reference from acknowledgment where issue_id = $1 and kind = 'recipient_acknowledgment'",
    [issueId],
  );
  assert.equal(rows[0]?.["provider_mode"], "simulated");
  assert.equal(rows[0]?.["authenticity"], "simulated_fixture");
  assert.equal(rows[0]?.["provider_reference"], "SIM-ACK-0001");
});

test("V034: delivery, internal acceptance and acknowledgment are three separate rows", async () => {
  const issueId = await routedIssue();
  const principal = staff();

  await recordAcknowledgment(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    kind: "delivery_attempted",
  });
  await recordAcknowledgment(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    kind: "internal_acceptance",
  });
  await recordAcknowledgment(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    kind: "recipient_acknowledgment",
    provenance: { providerMode: "simulated", authenticity: "simulated_fixture" },
  });

  const { rows } = await client.query(
    "select kind from acknowledgment where issue_id = $1 order by occurred_at",
    [issueId],
  );
  assert.deepEqual(
    rows.map((row) => row["kind"]),
    ["delivery_attempted", "internal_acceptance", "recipient_acknowledgment"],
  );
});

test("V034: a repeated callback is not a second acknowledgment", async () => {
  const issueId = await routedIssue();
  const principal = staff();
  await recordAcknowledgment(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    kind: "delivery_attempted",
  });

  const second = await recordAcknowledgment(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    kind: "delivery_attempted",
  });

  assert.equal(second.alreadyRecorded, true);
  const { rows } = await client.query(
    "select count(*)::int as n from acknowledgment where issue_id = $1 and kind = 'delivery_attempted'",
    [issueId],
  );
  assert.equal(rows[0]?.["n"], 1);
});

test("V034: a citizen cannot record an acknowledgment", async () => {
  const issueId = await routedIssue();
  const participantId = await newParticipant();

  await assert.rejects(
    () =>
      recordAcknowledgment(client, {
        principal: citizen(participantId),
        issueId,
        departmentId: DEPARTMENT,
        kind: "internal_acceptance",
      }),
    StaffError,
  );
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

test("V034: staff can assign an issue, with a reason", async () => {
  const issueId = await routedIssue();
  const principal = staff();
  const assignee = randomUUID();

  const result = await assignIssue(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    assignedStaffId: assignee,
    reason: "Nearest crew to the school gate.",
  });

  assert.equal(result.assigned, true);
  const { rows } = await client.query(
    "select assigned_staff_id, reason, valid_to from assignment where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["assigned_staff_id"], assignee);
  assert.match(String(rows[0]?.["reason"]), /nearest crew/i);
  assert.equal(rows[0]?.["valid_to"], null);
});

test("V034: reassigning supersedes the previous assignment rather than deleting it", async () => {
  const issueId = await routedIssue();
  const principal = staff();

  await assignIssue(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    assignedStaffId: randomUUID(),
    reason: "First crew available.",
  });
  await assignIssue(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    assignedStaffId: randomUUID(),
    reason: "First crew reassigned to a burst main.",
  });

  const { rows } = await client.query(
    "select valid_to, supersedes_assignment_id from assignment where issue_id = $1 order by valid_from",
    [issueId],
  );
  assert.equal(rows.length, 2, "who was responsible when is part of the record");
  assert.notEqual(rows[0]?.["valid_to"], null, "the first must be closed, not removed");
  assert.notEqual(rows[1]?.["supersedes_assignment_id"], null);
});

test("V034: an assignment with no reason is refused", async () => {
  const issueId = await routedIssue();

  await assert.rejects(
    () =>
      assignIssue(client, {
        principal: staff(),
        issueId,
        departmentId: DEPARTMENT,
        assignedStaffId: randomUUID(),
        reason: "  ",
      }),
    /reason/i,
  );
});

test("V034: a citizen cannot assign an issue", async () => {
  const issueId = await routedIssue();
  const participantId = await newParticipant();

  await assert.rejects(
    () =>
      assignIssue(client, {
        principal: citizen(participantId),
        issueId,
        departmentId: DEPARTMENT,
        assignedStaffId: randomUUID(),
        reason: "a genuine reason",
      }),
    StaffError,
  );
});

test("V034: the inbox shows who an issue is assigned to", async () => {
  const issueId = await routedIssue();
  const principal = staff();
  const assignee = randomUUID();
  await assignIssue(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    assignedStaffId: assignee,
    reason: "Nearest crew.",
  });

  const inbox = await listDepartmentInbox(client, {
    principal,
    departmentId: DEPARTMENT,
    jurisdictionId,
  });
  const item = inbox.items.find((candidate) => candidate.issueId === issueId);

  assert.equal(item?.assignedStaffId, assignee);
});

test("V034: the inbox orders oldest first so nothing sits forever", async () => {
  const older = await routedIssue({ openedDaysAgo: 10 });
  const newer = await routedIssue({ openedDaysAgo: 1 });

  const inbox = await listDepartmentInbox(client, {
    principal: staff(),
    departmentId: DEPARTMENT,
    jurisdictionId,
  });

  const positions = inbox.items.map((item) => item.issueId);
  assert.ok(positions.indexOf(older) < positions.indexOf(newer));
});

test("V034: internal acceptance may not claim provider provenance", async () => {
  // The other direction of the same rule. Allowing it would let an internal
  // state carry the very provenance that marks an external reply, which is how
  // "we picked it up" becomes "they acknowledged it".
  const issueId = await routedIssue();

  await assert.rejects(
    () =>
      recordAcknowledgment(client, {
        principal: staff(),
        issueId,
        departmentId: DEPARTMENT,
        kind: "internal_acceptance",
        provenance: { providerMode: "simulated", authenticity: "simulated_fixture" },
      }),
    /internal fact|must not claim|acknowledgment_external_provenance_ck/i,
  );

  const { rows } = await client.query(
    "select count(*)::int as n from acknowledgment where issue_id = $1",
    [issueId],
  );
  assert.equal(rows[0]?.["n"], 0, "nothing may be recorded");
});

// ---------------------------------------------------------------------------
// The inbox is ordered by a configured policy, not by an invented urgency (V034)
// ---------------------------------------------------------------------------

/**
 * A policy over two categories unique to the calling test.
 *
 * `routedIssue` inserts a directory entry per category, and
 * `responsibility_directory_active_uniq` allows one active owner per
 * (version, jurisdiction, category) — so tests sharing a category name
 * collide. Generating the names here keeps each test independent.
 */
const orderingOver = (): {
  readonly policy: {
    version: string;
    note: string;
    categoryOrder: readonly string[];
    ageEscalationDays: number;
  };
  readonly firstCategory: string;
  readonly secondCategory: string;
} => {
  const suffix = randomUUID().slice(0, 6);
  const firstCategory = `first-${suffix}`;
  const secondCategory = `second-${suffix}`;
  return {
    policy: {
      version: "test-triage.v1",
      note: "A test ordering. Not a severity, risk or urgency assessment.",
      categoryOrder: [firstCategory, secondCategory],
      ageEscalationDays: 14,
    },
    firstCategory,
    secondCategory,
  };
};

test("V034: the inbox is ordered by the configured policy", async () => {
  // V034 declined to invent urgency, and this does not reintroduce it: the
  // order comes from data the deployment supplies, and the reason for each
  // placement is reported.
  const { policy, firstCategory, secondCategory } = orderingOver();
  const second = await routedIssue({ category: secondCategory, openedDaysAgo: 2 });
  const first = await routedIssue({ category: firstCategory, openedDaysAgo: 1 });

  const inbox = await listDepartmentInbox(client, {
    principal: staff(),
    departmentId: DEPARTMENT,
    jurisdictionId,
    triagePolicy: policy,
  });
  const mine = inbox.items.filter((entry) => [first, second].includes(entry.issueId));

  assert.deepEqual(
    mine.map((entry) => entry.issueId),
    [first, second],
  );
});

test("V034: every item says why it is where it is, and names the policy", async () => {
  const { policy, firstCategory } = orderingOver();
  const issueId = await routedIssue({ category: firstCategory, openedDaysAgo: 3 });

  const inbox = await listDepartmentInbox(client, {
    principal: staff(),
    departmentId: DEPARTMENT,
    jurisdictionId,
    triagePolicy: policy,
  });
  const item = inbox.items.find((entry) => entry.issueId === issueId);

  assert.ok(item !== undefined);
  assert.match(
    item.orderingBasis.join(" "),
    new RegExp(`policy 'test-triage\\.v1' places category '${firstCategory}' at position 1 of 2`),
  );
  assert.match(inbox.orderingNote, /[Nn]ot a severity/);
  assert.equal(inbox.orderingPolicyVersion, "test-triage.v1");
});

test("V034: the inbox carries no urgency or severity field", async () => {
  const { policy, firstCategory } = orderingOver();
  const issueId = await routedIssue({ category: firstCategory });

  const inbox = await listDepartmentInbox(client, {
    principal: staff(),
    departmentId: DEPARTMENT,
    jurisdictionId,
    triagePolicy: policy,
  });
  const item = inbox.items.find((entry) => entry.issueId === issueId);

  assert.ok(item !== undefined);
  for (const forbidden of ["urgency", "severity", "priorityScore", "score", "risk"]) {
    assert.equal(
      Object.hasOwn(item, forbidden),
      false,
      `the inbox must not carry a '${forbidden}' field`,
    );
  }
});

test("V034: without a policy the inbox stays in age order rather than guessing one", async () => {
  // The policy is optional, and its absence must not be filled in with a
  // built-in ordering — that would be the deployment applying a preference
  // nobody configured. Oldest first is the only defensible default, and it
  // says so.
  const { firstCategory, secondCategory } = orderingOver();
  const older = await routedIssue({ category: secondCategory, openedDaysAgo: 9 });
  const newer = await routedIssue({ category: firstCategory, openedDaysAgo: 1 });

  const inbox = await listDepartmentInbox(client, {
    principal: staff(),
    departmentId: DEPARTMENT,
    jurisdictionId,
  });
  const mine = inbox.items.filter((entry) => [older, newer].includes(entry.issueId));

  assert.deepEqual(
    mine.map((entry) => entry.issueId),
    [older, newer],
  );
  assert.equal(inbox.orderingPolicyVersion, undefined);
  assert.match(inbox.orderingNote, /no ordering policy|oldest first/i);
});

// ---------------------------------------------------------------------------
// The lifecycle actually moves (V035 prerequisite)
//
// V034 recorded acknowledgments and assignments without touching
// `current_status`, so every routed issue sat at `routed_internal` forever and
// V035's `work_planned -> resolution_claimed` edge was unreachable in the
// running product. These pin the two guarded advances that close that gap.
// ---------------------------------------------------------------------------

const statusOf = async (issueId: string): Promise<string> => {
  const { rows } = await client.query(
    "select current_status from canonical_issue where issue_id = $1",
    [issueId],
  );
  return String(rows[0]?.["current_status"]);
};

test("V034/V035: a recipient acknowledgment advances the issue, with its provenance", async () => {
  const issueId = await routedIssue();
  assert.equal(await statusOf(issueId), "routed_internal");

  await recordAcknowledgment(client, {
    principal: staff(),
    issueId,
    departmentId: DEPARTMENT,
    kind: "recipient_acknowledgment",
    provenance: {
      providerMode: "simulated",
      authenticity: "simulated_fixture",
      providerReference: "SIM-ACK-ADV1",
    },
    note: "Simulated department adapter replied.",
  });

  assert.equal(await statusOf(issueId), "agency_ack_received");
  const { rows } = await client.query(
    `select event_type, payload from status_event
      where aggregate_type = 'canonical_issue' and aggregate_id = $1
      order by aggregate_version desc limit 1`,
    [issueId],
  );
  assert.equal(String(rows[0]?.["event_type"]), "agency_ack_received");
  const payload = rows[0]?.["payload"] as Record<string, unknown>;
  // Said in the event, because a stream is read by things that never saw the
  // label on the screen.
  assert.equal(payload["provider_mode"], "simulated");
  assert.equal(payload["is_government_acknowledgment"], false);
});

test("V034/V035: internal acceptance alone does not advance the issue", async () => {
  const issueId = await routedIssue();
  await recordAcknowledgment(client, {
    principal: staff(),
    issueId,
    departmentId: DEPARTMENT,
    kind: "internal_acceptance",
    note: "A staff member accepted this internally.",
  });
  // Internal state is not an acknowledgment by anyone outside, and the
  // lifecycle must not treat it as one.
  assert.equal(await statusOf(issueId), "routed_internal");
});

test("V034/V035: an assignment plans the work, and is what the guard requires", async () => {
  const issueId = await routedIssue();
  await recordAcknowledgment(client, {
    principal: staff(),
    issueId,
    departmentId: DEPARTMENT,
    kind: "recipient_acknowledgment",
    provenance: { providerMode: "simulated", authenticity: "simulated_fixture" },
    note: "Simulated department adapter replied.",
  });
  const principal = staff();
  await assignIssue(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    assignedStaffId: String(principal.staffId),
    reason: "Taking this on so the work can be scheduled.",
  });

  assert.equal(await statusOf(issueId), "work_planned");
  const { rows } = await client.query(
    `select count(*)::int as n from assignment where issue_id = $1 and valid_to is null`,
    [issueId],
  );
  assert.equal(Number(rows[0]?.["n"]), 1, "the advance is backed by a real assignment row");
});

test("V034/V035: assigning before any acknowledgment leaves the issue where it is", async () => {
  const issueId = await routedIssue();
  const principal = staff();
  await assignIssue(client, {
    principal,
    issueId,
    departmentId: DEPARTMENT,
    assignedStaffId: String(principal.staffId),
    reason: "Assigning before the recipient has replied.",
  });
  // The assignment is recorded either way; the lifecycle is not skipped.
  assert.equal(await statusOf(issueId), "routed_internal");
});

test("V034/V035: a repeated acknowledgment callback does not advance twice", async () => {
  const issueId = await routedIssue();
  const acknowledge = () =>
    recordAcknowledgment(client, {
      principal: staff(),
      issueId,
      departmentId: DEPARTMENT,
      kind: "recipient_acknowledgment",
      provenance: { providerMode: "simulated", authenticity: "simulated_fixture" },
      note: "Simulated department adapter replied.",
    });
  await acknowledge();
  const second = await acknowledge();

  assert.equal(second.alreadyRecorded, true);
  assert.equal(await statusOf(issueId), "agency_ack_received");
  const { rows } = await client.query(
    `select count(*)::int as n from status_event
      where aggregate_id = $1 and event_type = 'agency_ack_received'`,
    [issueId],
  );
  assert.equal(Number(rows[0]?.["n"]), 1, "one advance, one event");
});
