/**
 * Staff triage and acknowledgment (roadmap V034).
 *
 * Three facts that civic software conflates constantly, kept apart here
 * because conflating them tells a citizen their report reached an authority
 * when it did not:
 *
 *  1. **delivery_attempted / delivery_accepted** — we sent it. Ours.
 *  2. **internal_acceptance** — a staff member picked it up. Still ours.
 *  3. **recipient_acknowledgment** — the recipient replied. The only one
 *     involving the outside world, and the only one permitted to carry
 *     provider provenance — which in this demo always says simulated.
 *
 * The database enforces the same split: `acknowledgment_external_provenance_ck`
 * requires provenance for a recipient acknowledgment and *forbids* it for the
 * internal kinds, so an internal state cannot be dressed up as an external
 * one even by a careless insert.
 *
 * `statusLabel` is built from those three booleans and never collapses them.
 *
 * Permissions are V015's and scoped to an exact jurisdiction/department pair.
 * The V034 staff HTTP surface derives this `Principal` only after validating
 * a session and its durable server-side responsibility grant.
 */

import { randomUUID } from "node:crypto";

import {
  authorize,
  DEFAULT_CONFIRMATION_RULE,
  orderTriageQueue,
  type ConfirmationPolicyPack,
  type Principal,
  type TriagePolicy,
} from "@vision/domain";

import { advanceIssueStatus } from "./issue-lifecycle.ts";
import type { Queryable } from "./outbox.ts";

export class StaffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaffError";
  }
}

export const INBOX_LIMIT = 100;

export type AcknowledgmentKind =
  "delivery_attempted" | "delivery_accepted" | "internal_acceptance" | "recipient_acknowledgment";

export type InboxItem = {
  readonly issueId: string;
  readonly publicReference: string;
  readonly category: string;
  readonly currentStatus: string;
  readonly departmentId: string;
  readonly openedAt: string;
  readonly ageDays: number;
  readonly countedParticipants: number;
  readonly evidenceCount: number;
  readonly assignedStaffId: string | undefined;
  readonly assignedAt: string | undefined;
  readonly assignmentReason: string | undefined;
  readonly deliveryAttempted: boolean;
  readonly deliveryAttemptedAt: string | undefined;
  readonly deliveryAccepted: boolean;
  readonly deliveryAcceptedAt: string | undefined;
  readonly internallyAccepted: boolean;
  readonly internallyAcceptedAt: string | undefined;
  readonly internallyAcceptedBy: string | undefined;
  readonly internalAcceptanceNote: string | undefined;
  readonly recipientAcknowledged: boolean;
  readonly recipientAcknowledgedAt: string | undefined;
  readonly recipientAcknowledgmentReference: string | undefined;
  readonly recipientAcknowledgmentNote: string | undefined;
  /** True when the acknowledging recipient was a simulation. */
  readonly recipientAcknowledgmentIsSimulated: boolean;
  /** Built from the three booleans; never collapses them into one word. */
  readonly statusLabel: string;
  // ── V035 resolution state ───────────────────────────────────────────────
  /** The latest repair claim, when one exists. A claim is not a resolution. */
  readonly resolutionClaimedAt: string | undefined;
  readonly resolutionClaimDescription: string | undefined;
  readonly completionEvidenceCount: number;
  readonly resolutionConfirmations: number;
  readonly resolutionDisputes: number;
  /** How many confirmations this category's policy requires, when one loaded. */
  readonly requiredConfirmations: number | undefined;
  /**
   * Why this item is where it is in the list.
   *
   * Note what is deliberately absent: there is no urgency, severity, risk or
   * priority score on this type. V034 declined to invent one, because nothing
   * in this system measures how dangerous a problem is. What the list has
   * instead is a *configured order* and the stated reason for each placement,
   * so a reader can see that a person decided it and which decision it was.
   */
  readonly orderingBasis: readonly string[];
};

export type DepartmentInbox = {
  readonly items: readonly InboxItem[];
  readonly departmentId: string;
  readonly jurisdictionId: string;
  readonly appliedLimit: number;
  readonly exhaustive: boolean;
  /** The ordering policy applied, or undefined when none was supplied. */
  readonly orderingPolicyVersion: string | undefined;
  /** What the ordering is and is not. Present either way. */
  readonly orderingNote: string;
};

const NO_POLICY_NOTE =
  "no ordering policy was supplied, so this list is in age order, oldest first; it is not ranked by urgency, severity or risk, none of which this system measures";

const requireStaff = (
  principal: Principal,
  action: "issue.read_private" | "assignment.write" | "issue.transition",
  jurisdictionId: string,
  departmentId: string,
): void => {
  if (principal.role !== "department_staff") {
    throw new StaffError(`role '${principal.role}' cannot operate a department inbox`);
  }
  const decision = authorize(principal, action, { jurisdictionId });
  if (!decision.allowed) {
    throw new StaffError(`role '${principal.role}' may not ${action}: ${decision.reason}`);
  }
  const inResponsibilityScope = principal.responsibilityScope?.some(
    (scope) => scope.jurisdictionId === jurisdictionId && scope.departmentId === departmentId,
  );
  if (inResponsibilityScope !== true) {
    throw new StaffError(
      `department '${departmentId}' in jurisdiction '${jurisdictionId}' is outside this staff member's responsibility scope`,
    );
  }
};

/**
 * The label a staff member reads.
 *
 * Deliberately verbose. "Acknowledged" on its own is the word that does the
 * damage, so the qualifier travels with it and an internal state never
 * borrows it.
 */
const statusLabelFor = (flags: {
  readonly deliveryAttempted: boolean;
  readonly deliveryAccepted: boolean;
  readonly internallyAccepted: boolean;
  readonly recipientAcknowledged: boolean;
  readonly simulated: boolean;
}): string => {
  const parts: string[] = [];
  if (flags.recipientAcknowledged) {
    parts.push(
      flags.simulated ? "acknowledged by a simulated recipient" : "acknowledged by the recipient",
    );
  }
  if (flags.internallyAccepted) parts.push("accepted internally");
  if (flags.deliveryAccepted) parts.push("delivery accepted by the configured transport");
  else if (flags.deliveryAttempted) parts.push("delivery attempted");
  if (parts.length === 0) return "routed internally, not yet accepted by anyone";
  return parts.join("; ");
};

export const listDepartmentInbox = async (
  tx: Queryable,
  options: {
    readonly principal: Principal;
    readonly departmentId: string;
    readonly jurisdictionId: string;
    readonly limit?: number;
    /**
     * The order this deployment chose, as data (V034).
     *
     * Optional, and its absence is *not* filled in with a built-in ordering:
     * that would be applying a preference nobody configured. Without it the
     * list stays in age order and says so.
     */
    readonly triagePolicy?: TriagePolicy;
    /**
     * The loaded confirmation policy (V035).
     *
     * Used only to report how many confirmations a claim needs. Absent, the
     * field is `undefined` rather than a guessed number — a staff member
     * reading "1 of 2" must be reading a policy somebody configured.
     */
    readonly confirmationPolicy?: ConfirmationPolicyPack;
  },
): Promise<DepartmentInbox> => {
  requireStaff(
    options.principal,
    "issue.read_private",
    options.jurisdictionId,
    options.departmentId,
  );
  const limit = Math.min(Math.max(options.limit ?? INBOX_LIMIT, 1), INBOX_LIMIT);

  // No query here selects `object_reference`: an inbox is a worklist, and
  // reading a private original is a separate audited act (V015).
  const { rows } = await tx.query(
    `select
        i.issue_id, i.public_reference, i.category, i.current_status, i.opened_at,
        extract(epoch from (now() - i.opened_at)) / 86400.0 as age_days,
        r.department_id,
        (select count(*)::int from issue_participation p
          where p.canonical_issue_id = i.issue_id and p.counted = true) as counted,
        (select count(*)::int from issue_evidence_link link
          where link.canonical_issue_id = i.issue_id and link.effective_to is null) as evidence,
        (select a.assigned_staff_id from assignment a
          where a.issue_id = i.issue_id and a.valid_to is null
          order by a.valid_from desc limit 1) as assigned_staff_id,
        (select a.valid_from from assignment a
          where a.issue_id = i.issue_id and a.valid_to is null
          order by a.valid_from desc limit 1) as assigned_at,
        (select a.reason from assignment a
          where a.issue_id = i.issue_id and a.valid_to is null
          order by a.valid_from desc limit 1) as assignment_reason,
        exists (select 1 from acknowledgment k
                 where k.issue_id = i.issue_id
                   and k.kind = 'delivery_attempted') as delivery_attempted,
        (select k.occurred_at from acknowledgment k
          where k.issue_id = i.issue_id and k.kind = 'delivery_attempted') as delivery_attempted_at,
        exists (select 1 from acknowledgment k
                 where k.issue_id = i.issue_id
                   and k.kind = 'delivery_accepted') as delivery_accepted,
        (select k.occurred_at from acknowledgment k
          where k.issue_id = i.issue_id and k.kind = 'delivery_accepted') as delivery_accepted_at,
        exists (select 1 from acknowledgment k
                 where k.issue_id = i.issue_id
                   and k.kind = 'internal_acceptance') as internal,
        (select k.occurred_at from acknowledgment k
          where k.issue_id = i.issue_id and k.kind = 'internal_acceptance') as internal_at,
        (select k.actor_id from acknowledgment k
          where k.issue_id = i.issue_id and k.kind = 'internal_acceptance') as internal_by,
        (select k.note from acknowledgment k
          where k.issue_id = i.issue_id and k.kind = 'internal_acceptance') as internal_note,
        (select k.provider_mode from acknowledgment k
          where k.issue_id = i.issue_id
            and k.kind = 'recipient_acknowledgment' limit 1) as ack_mode,
        (select k.occurred_at from acknowledgment k
          where k.issue_id = i.issue_id and k.kind = 'recipient_acknowledgment') as ack_at,
        (select k.provider_reference from acknowledgment k
          where k.issue_id = i.issue_id and k.kind = 'recipient_acknowledgment') as ack_reference,
        (select k.note from acknowledgment k
          where k.issue_id = i.issue_id and k.kind = 'recipient_acknowledgment') as ack_note,
        -- V035. The latest claim only: an earlier claim that was disputed and
        -- returned is history, and showing it beside the current one would
        -- read as two open claims.
        (select c.claimed_at from resolution_claim c
          where c.issue_id = i.issue_id order by c.claimed_at desc limit 1) as claimed_at,
        (select c.description from resolution_claim c
          where c.issue_id = i.issue_id order by c.claimed_at desc limit 1) as claim_description,
        (select count(*)::int from resolution_evidence_item e
          where e.claim_id = (select c.claim_id from resolution_claim c
                               where c.issue_id = i.issue_id
                               order by c.claimed_at desc limit 1)
            and e.privacy_state = 'active') as completion_evidence,
        (select count(*)::int from resolution_confirmation f
          where f.claim_id = (select c.claim_id from resolution_claim c
                               where c.issue_id = i.issue_id
                               order by c.claimed_at desc limit 1)
            and f.decision = 'confirmed') as confirmations,
        (select count(*)::int from resolution_confirmation f
          where f.claim_id = (select c.claim_id from resolution_claim c
                               where c.issue_id = i.issue_id
                               order by c.claimed_at desc limit 1)
            and f.decision = 'disputed') as disputes
       from canonical_issue i
       join routing_decision r on r.issue_id = i.issue_id
      where i.jurisdiction_id = $1
        and r.department_id = $2
        and r.outcome = 'routed'
        -- Only the most recent routing decision counts: an issue re-routed
        -- away must leave this inbox, and its history stays in the table.
        and r.decided_at = (
          select max(r2.decided_at) from routing_decision r2 where r2.issue_id = i.issue_id
        )
      order by i.opened_at asc
      limit $3`,
    [options.jurisdictionId, options.departmentId, limit + 1],
  );

  const kept = rows.slice(0, limit);
  const items = kept.map((row) => {
    const ackMode = row["ack_mode"] === null ? undefined : String(row["ack_mode"]);
    const flags = {
      deliveryAttempted: row["delivery_attempted"] === true,
      deliveryAccepted: row["delivery_accepted"] === true,
      internallyAccepted: row["internal"] === true,
      recipientAcknowledged: ackMode !== undefined,
      simulated: ackMode === "simulated",
    };
    return {
      issueId: String(row["issue_id"]),
      publicReference: String(row["public_reference"]),
      category: String(row["category"]),
      currentStatus: String(row["current_status"]),
      departmentId: String(row["department_id"]),
      openedAt: new Date(String(row["opened_at"])).toISOString(),
      ageDays: Number(row["age_days"]),
      countedParticipants: Number(row["counted"] ?? 0),
      evidenceCount: Number(row["evidence"] ?? 0),
      assignedStaffId:
        row["assigned_staff_id"] === null ? undefined : String(row["assigned_staff_id"]),
      assignedAt:
        row["assigned_at"] === null
          ? undefined
          : new Date(String(row["assigned_at"])).toISOString(),
      assignmentReason:
        row["assignment_reason"] === null ? undefined : String(row["assignment_reason"]),
      deliveryAttempted: flags.deliveryAttempted,
      deliveryAttemptedAt:
        row["delivery_attempted_at"] === null
          ? undefined
          : new Date(String(row["delivery_attempted_at"])).toISOString(),
      deliveryAccepted: flags.deliveryAccepted,
      deliveryAcceptedAt:
        row["delivery_accepted_at"] === null
          ? undefined
          : new Date(String(row["delivery_accepted_at"])).toISOString(),
      internallyAccepted: flags.internallyAccepted,
      internallyAcceptedAt:
        row["internal_at"] === null
          ? undefined
          : new Date(String(row["internal_at"])).toISOString(),
      internallyAcceptedBy: row["internal_by"] === null ? undefined : String(row["internal_by"]),
      internalAcceptanceNote:
        row["internal_note"] === null ? undefined : String(row["internal_note"]),
      recipientAcknowledged: flags.recipientAcknowledged,
      recipientAcknowledgedAt:
        row["ack_at"] === null ? undefined : new Date(String(row["ack_at"])).toISOString(),
      recipientAcknowledgmentReference:
        row["ack_reference"] === null ? undefined : String(row["ack_reference"]),
      recipientAcknowledgmentNote: row["ack_note"] === null ? undefined : String(row["ack_note"]),
      recipientAcknowledgmentIsSimulated: flags.simulated,
      statusLabel: statusLabelFor(flags),
      // ── V035 ─────────────────────────────────────────────────────────────
      resolutionClaimedAt:
        row["claimed_at"] === null ? undefined : new Date(String(row["claimed_at"])).toISOString(),
      resolutionClaimDescription:
        row["claim_description"] === null ? undefined : String(row["claim_description"]),
      completionEvidenceCount: Number(row["completion_evidence"] ?? 0),
      resolutionConfirmations: Number(row["confirmations"] ?? 0),
      resolutionDisputes: Number(row["disputes"] ?? 0),
      requiredConfirmations:
        options.confirmationPolicy === undefined
          ? undefined
          : (options.confirmationPolicy.rules[String(row["category"])] ?? DEFAULT_CONFIRMATION_RULE)
              .requiredConfirmations,
      orderingBasis: [] as readonly string[],
    };
  });

  const policy = options.triagePolicy;
  if (policy === undefined) {
    // The SQL already ordered by `opened_at asc`. Stated on the result so a
    // reader is not left to infer why the list is in this order.
    return {
      items: items.map((item) => ({
        ...item,
        orderingBasis: [
          `no ordering policy was supplied, so this is placed by age: waiting ${String(Math.round(item.ageDays))} days`,
        ],
      })),
      departmentId: options.departmentId,
      jurisdictionId: options.jurisdictionId,
      appliedLimit: limit,
      exhaustive: rows.length <= limit,
      orderingPolicyVersion: undefined,
      orderingNote: NO_POLICY_NOTE,
    };
  }

  const ordered = orderTriageQueue(
    items.map((item) => ({
      issueId: item.issueId,
      publicReference: item.publicReference,
      category: item.category,
      ageDays: item.ageDays,
      countedParticipants: item.countedParticipants,
    })),
    policy,
  );
  const byId = new Map(items.map((item) => [item.issueId, item]));

  return {
    // The `undefined` branch is unreachable: `byId` is built from the very
    // array `ordered` was derived from, so every entry has a match. It is
    // written out because `Map.get` is typed as possibly-undefined under
    // `noUncheckedIndexedAccess`, and no test can distinguish it from a
    // non-null assertion. `flatMap` rather than a cast, so that if the two
    // ever do drift the list comes back shorter rather than with a hole in it
    // — a worklist containing `undefined` is worse than one missing a row.
    items: ordered.flatMap((entry) => {
      const item = byId.get(entry.issueId);
      return item === undefined ? [] : [{ ...item, orderingBasis: entry.basis }];
    }),
    departmentId: options.departmentId,
    jurisdictionId: options.jurisdictionId,
    appliedLimit: limit,
    exhaustive: rows.length <= limit,
    orderingPolicyVersion: policy.version,
    orderingNote: policy.note,
  };
};

export type AcknowledgmentInput = {
  readonly principal: Principal;
  readonly issueId: string;
  readonly departmentId: string;
  readonly kind: AcknowledgmentKind;
  readonly note?: string;
  /** Required for a recipient acknowledgment, forbidden for the internal kinds. */
  readonly provenance?: {
    readonly providerMode: "simulated" | "real";
    readonly authenticity:
      "simulated_fixture" | "authenticated_external" | "unauthenticated_external";
    readonly providerReference?: string;
  };
};

export type AcknowledgmentResult = {
  readonly acknowledgmentId: string | undefined;
  /** True when this kind was already recorded, so a repeated callback is a no-op. */
  readonly alreadyRecorded: boolean;
};

export const recordAcknowledgment = async (
  tx: Queryable,
  input: AcknowledgmentInput,
): Promise<AcknowledgmentResult> => {
  const issue = await tx.query(
    `select i.jurisdiction_id, i.current_status, r.department_id, r.outcome
       from canonical_issue i
       left join lateral (
         select department_id, outcome from routing_decision
          where issue_id = i.issue_id order by decided_at desc limit 1
       ) r on true
      where i.issue_id = $1`,
    [input.issueId],
  );
  const row = issue.rows[0];
  if (row === undefined) throw new StaffError(`issue ${input.issueId} does not exist`);
  const jurisdictionId =
    row["jurisdiction_id"] === null ? undefined : String(row["jurisdiction_id"]);
  if (jurisdictionId === undefined) {
    throw new StaffError("an acknowledgment is jurisdiction-scoped and this issue has none");
  }
  if (row["outcome"] !== "routed" || String(row["department_id"] ?? "") !== input.departmentId) {
    throw new StaffError(
      `issue ${input.issueId} is not currently routed to department '${input.departmentId}'`,
    );
  }
  requireStaff(input.principal, "issue.transition", jurisdictionId, input.departmentId);

  const external = input.kind === "recipient_acknowledgment";
  if (external && input.provenance === undefined) {
    // The rule this task exists for: an external acknowledgment without
    // provenance could not be distinguished from an internal state, and would
    // let a simulation pass for an authority. Also enforced by
    // acknowledgment_external_provenance_ck, which is the layer a test can
    // distinguish; this one exists for the message.
    throw new StaffError(
      "a recipient acknowledgment must carry provider provenance, including whether the responder was simulated",
    );
  }
  // Also enforced by acknowledgment_external_provenance_ck (a biconditional),
  // which is the layer a test can distinguish; this is for the message.
  if (!external && input.provenance !== undefined) {
    throw new StaffError(
      `${input.kind} is an internal fact and must not claim provider provenance`,
    );
  }

  const acknowledgmentId = randomUUID();
  const inserted = await tx.query(
    `insert into acknowledgment
         (acknowledgment_id, issue_id, kind, actor_type, actor_id,
          provider_reference, provider_mode, authenticity, occurred_at, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)
       on conflict (issue_id, kind) do nothing
       returning acknowledgment_id`,
    [
      acknowledgmentId,
      input.issueId,
      input.kind,
      input.principal.role === "department_staff" ? "staff" : input.principal.role,
      input.principal.staffId ?? null,
      input.provenance?.providerReference ?? null,
      input.provenance?.providerMode ?? null,
      input.provenance?.authenticity ?? null,
      input.note ?? null,
    ],
  );
  // One acknowledgment of each kind per issue: a repeated delivery callback
  // is a no-op. `ON CONFLICT` keeps this composable inside the three-event
  // simulated delivery transaction; catching a uniqueness error would leave
  // PostgreSQL's transaction in an aborted state.
  if (inserted.rows.length === 0) {
    return { acknowledgmentId: undefined, alreadyRecorded: true };
  }

  // V034 recorded this fact and stopped, which left every routed issue at
  // `routed_internal` forever and made V035's claim edge unreachable in the
  // running product. The advance is guarded, not assumed: `canTransitionIssue`
  // still requires the recorded provider provenance, and an issue that is not
  // in `routed_internal` is left exactly where it is.
  if (
    external &&
    input.provenance !== undefined &&
    String(row["current_status"]) === "routed_internal"
  ) {
    await advanceIssueStatus(tx, {
      issueId: input.issueId,
      from: "routed_internal",
      to: "agency_ack_received",
      context: {
        actor: "staff",
        hasActiveOutgoingAlias: false,
        acknowledgment: {
          providerMode: input.provenance.providerMode,
          authenticity: input.provenance.authenticity,
          recordedActor: String(input.principal.staffId ?? input.principal.role),
        },
      },
      eventType: "agency_ack_received",
      actorType: "staff",
      actorId: input.principal.staffId,
      payload: {
        acknowledgment_id: acknowledgmentId,
        department_id: input.departmentId,
        provider_mode: input.provenance.providerMode,
        authenticity: input.provenance.authenticity,
        // Said in the event, because a stream is read by things that will not
        // have read the label on the screen.
        is_government_acknowledgment: input.provenance.providerMode === "real",
      },
    });
  }

  return { acknowledgmentId, alreadyRecorded: false };
};

export type AssignInput = {
  readonly principal: Principal;
  readonly issueId: string;
  readonly departmentId: string;
  readonly assignedStaffId: string;
  readonly reason: string;
};

/**
 * Assigns an issue, superseding any current assignment.
 *
 * The previous row is closed rather than removed: who was responsible when is
 * the question an audit asks, and it cannot be answered from current state
 * alone (V003 effective dating).
 */
export const assignIssue = async (
  tx: Queryable,
  input: AssignInput,
): Promise<{ readonly assigned: true; readonly assignmentId: string }> => {
  if (input.reason.trim().length === 0) {
    throw new StaffError("an assignment requires a recorded reason");
  }

  const issue = await tx.query(
    `select i.jurisdiction_id, i.current_status, r.department_id, r.outcome
       from canonical_issue i
       left join lateral (
         select department_id, outcome from routing_decision
          where issue_id = i.issue_id order by decided_at desc limit 1
       ) r on true
      where i.issue_id = $1`,
    [input.issueId],
  );
  const row = issue.rows[0];
  if (row === undefined) throw new StaffError(`issue ${input.issueId} does not exist`);
  const jurisdictionId =
    row["jurisdiction_id"] === null ? undefined : String(row["jurisdiction_id"]);
  if (jurisdictionId === undefined) {
    throw new StaffError("an assignment is jurisdiction-scoped and this issue has none");
  }
  if (row["outcome"] !== "routed" || String(row["department_id"] ?? "") !== input.departmentId) {
    throw new StaffError(
      `issue ${input.issueId} is not currently routed to department '${input.departmentId}'`,
    );
  }
  requireStaff(input.principal, "assignment.write", jurisdictionId, input.departmentId);

  const assignmentId = randomUUID();
  await tx.query("begin");
  try {
    const current = await tx.query(
      `select assignment_id from assignment
        where issue_id = $1 and valid_to is null
        order by valid_from desc limit 1`,
      [input.issueId],
    );
    const supersedes =
      current.rows[0] === undefined ? null : String(current.rows[0]["assignment_id"]);

    if (supersedes !== null) {
      await tx.query("update assignment set valid_to = now() where assignment_id = $1", [
        supersedes,
      ]);
    }

    await tx.query(
      `insert into assignment
         (assignment_id, issue_id, department_id, assigned_staff_id, reason,
          valid_from, supersedes_assignment_id)
       values ($1,$2,$3,$4,$5, now(), $6)`,
      [
        assignmentId,
        input.issueId,
        input.departmentId,
        input.assignedStaffId,
        input.reason,
        supersedes,
      ],
    );

    // An assignment is what `canTransitionIssue` requires before work can be
    // planned, and it has just been written inside this transaction — so the
    // guard is satisfied by a fact rather than by an assertion. Inside the
    // same transaction so an issue can never be left advanced with no
    // assignment behind it.
    // Also from `reopened`: a reopened issue is live work again, and without
    // this it would sit in the inbox with no route back to a claim — the
    // citizen's reopening would have no effect anybody could act on.
    const statusNow = String(row["current_status"]);
    if (statusNow === "agency_ack_received" || statusNow === "reopened") {
      await advanceIssueStatus(tx, {
        issueId: input.issueId,
        from: statusNow === "reopened" ? "reopened" : "agency_ack_received",
        to: "work_planned",
        context: {
          actor: "staff",
          hasActiveOutgoingAlias: false,
          hasActiveAssignment: true,
        },
        eventType: "work_planned",
        actorType: "staff",
        actorId: input.principal.staffId,
        payload: {
          assignment_id: assignmentId,
          department_id: input.departmentId,
          assigned_staff_id: input.assignedStaffId,
          reason: input.reason,
        },
      });
    }
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }

  return { assigned: true, assignmentId };
};
