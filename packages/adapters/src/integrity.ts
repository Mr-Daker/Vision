/**
 * The invariant checks, in SQL (roadmap V048).
 *
 * Each one answers a question an operator would ask at three in the morning,
 * and each carries the sentence they would act on. `integrityFinding` refuses
 * to build a finding without that sentence, so a check cannot be added here
 * without one.
 *
 * Every check is **probed** by `integrity.dbtest.ts` before its clean result is
 * believed: the condition is planted, the check is required to fire, and only
 * then is a clean database reported as clean. V044's privacy audit established
 * that device and the reason holds here — an audit that always passes is
 * indistinguishable from one that does not work.
 *
 * Nothing here repairs anything. `reconcileSummaries` already set that rule for
 * the projection and it is the right one generally: a tool that quietly fixes
 * what it finds destroys the evidence of how it broke.
 */

import {
  AFFECTED_LIMIT,
  integrityFinding,
  type CheckOutcome,
  type IntegrityFinding,
} from "@vision/domain";

import type { Queryable } from "./outbox.ts";
import { reconcileSummaries } from "./summaries.ts";
import { DISTRICT_CATEGORY_SUMMARY } from "./summaries.ts";

export type IntegrityOptions = {
  readonly summaryName?: string;
  readonly asOf: Date;
  /** The outbox attempt ceiling this deployment runs with (V017). */
  readonly maxAttempts?: number;
};

type Row = Record<string, unknown>;

const idsOf = (rows: readonly Row[], column: string): readonly string[] =>
  rows.slice(0, AFFECTED_LIMIT).map((row) => String(row[column]));

/** Runs one SQL check and turns its rows into at most one finding. */
const sqlCheck = async (
  tx: Queryable,
  spec: {
    readonly check: string;
    readonly invariant: Parameters<typeof integrityFinding>[0]["invariant"];
    readonly recoverability: Parameters<typeof integrityFinding>[0]["recoverability"];
    readonly sql: string;
    readonly params?: readonly unknown[];
    readonly idColumn: string;
    readonly what: string;
    readonly procedure: string;
    readonly ifNobodyActs: string;
    readonly lost?: string;
    /** Names the constraint that already refuses this condition, when one does. */
    readonly enforcedBy?: string;
  },
): Promise<CheckOutcome> => {
  const enforced = spec.enforcedBy === undefined ? {} : { enforcedBy: spec.enforcedBy };
  let rows: readonly Row[];
  try {
    const result = await tx.query(spec.sql, [...(spec.params ?? [])]);
    rows = result.rows as readonly Row[];
  } catch (error) {
    return {
      check: spec.check,
      invariant: spec.invariant,
      ran: false,
      reasonNotRun: error instanceof Error ? error.message : String(error),
      findings: [],
      ...enforced,
    };
  }

  if (rows.length === 0) {
    return { check: spec.check, invariant: spec.invariant, ran: true, findings: [], ...enforced };
  }

  return {
    check: spec.check,
    invariant: spec.invariant,
    ran: true,
    ...enforced,
    findings: [
      integrityFinding({
        check: spec.check,
        invariant: spec.invariant,
        recoverability: spec.recoverability,
        what: spec.what,
        affected: idsOf(rows, spec.idColumn),
        matched: rows.length,
        procedure: spec.procedure,
        ifNobodyActs: spec.ifNobodyActs,
        ...(spec.lost === undefined ? {} : { lost: spec.lost }),
      }),
    ],
  };
};

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * Canonical issue membership.
 *
 * There was a third check here, and removing it is worth recording. It reported
 * evidence whose live link still named an issue a merge had retired — which
 * sounds like a fault and is in fact how V028's merge works: the merge record
 * is authoritative and reads resolve through the alias, so the link keeps
 * naming where the evidence actually landed. The check fired on every correct
 * merge. A check that fires on correct behaviour is worse than no check,
 * because it is the one that teaches people to skip the output.
 *
 * One piece of evidence belongs to one issue at a time. Two live links mean a
 * report is counted in two places, and V029's "fourteen people reported this"
 * stops being a count of people.
 */
const membershipChecks = (tx: Queryable): readonly Promise<CheckOutcome>[] => [
  sqlCheck(tx, {
    check: "evidence_on_more_than_one_active_issue",
    enforcedBy: "issue_evidence_link_one_active_per_evidence_uniq",
    invariant: "issue_membership",
    recoverability: "repairable_by_operator",
    sql: `select evidence_id, count(*)::int as links
            from issue_evidence_link
           where effective_to is null
           group by evidence_id
          having count(*) > 1
           order by evidence_id`,
    idColumn: "evidence_id",
    what: "a piece of evidence is live on more than one canonical issue at the same time",
    ifNobodyActs:
      "the report is counted on both issues, so participation counts and every summary built from them overstate how many people reported each problem",
    procedure:
      "read both issues; if they describe one problem, merge them with a reason and let the alias resolve the links. If they are genuinely different, close the wrong link by setting effective_to and record which actor decided, so the correction is attributable.",
  }),
  sqlCheck(tx, {
    check: "merge_alias_cycle",
    invariant: "issue_membership",
    recoverability: "unrecoverable",
    sql: `with recursive walk(start_id, current_id, depth) as (
              select surviving_issue_id, merged_issue_id, 1
                from issue_merge where reversed_at is null
            union all
              select w.start_id, m.merged_issue_id, w.depth + 1
                from walk w
                join issue_merge m
                  on m.surviving_issue_id = w.current_id and m.reversed_at is null
               where w.depth < 32
          )
          select distinct start_id
            from walk
           where current_id = start_id
           order by start_id`,
    idColumn: "start_id",
    what: "two or more merges point at each other, so no issue in the ring is the survivor",
    ifNobodyActs:
      "every read of those issues resolves to an unknown survivor; V038 projects them into an unknown cell rather than dropping them, so the count stays honest while the issues stay unreadable",
    lost: "which issue the reviewers intended to survive. Both merges are recorded as valid decisions and the records cannot say which intent came first, so whatever is done next is a person choosing, not a repair.",
    procedure:
      "pick the surviving issue deliberately and reverse the merge that closes the ring, giving a reversal reason that names this finding. The choice is a new decision by a named actor, and the reversal record is what says so afterwards.",
  }),
];

/**
 * Uniqueness.
 *
 * A public reference is what a citizen is told to quote. Two issues sharing one
 * means two different problems answer to the same name.
 */
const uniquenessChecks = (tx: Queryable): readonly Promise<CheckOutcome>[] => [
  sqlCheck(tx, {
    check: "duplicate_public_reference",
    enforcedBy: "canonical_issue_public_reference_key",
    invariant: "uniqueness",
    recoverability: "repairable_by_operator",
    sql: `select public_reference, count(*)::int as issues
            from canonical_issue
           group by public_reference
          having count(*) > 1
           order by public_reference`,
    idColumn: "public_reference",
    what: "two canonical issues answer to the same public reference",
    ifNobodyActs:
      "a citizen quoting their reference reaches whichever issue the query happens to return, and tracking a report becomes a coin toss",
    procedure:
      "keep the reference on the older issue and issue a new one for the newer, then notify anyone who was given the reassigned reference. Do not delete either issue; a reference that stops working is better than one that silently points elsewhere.",
  }),
  sqlCheck(tx, {
    check: "participation_counted_twice",
    enforcedBy: "issue_participation_participant_issue_uniq",
    invariant: "uniqueness",
    recoverability: "repairable_by_operator",
    sql: `select canonical_issue_id, participant_id, count(*)::int as rows_found
            from issue_participation
           where counted
           group by canonical_issue_id, participant_id
          having count(*) > 1
           order by canonical_issue_id`,
    idColumn: "canonical_issue_id",
    what: "one participant is counted more than once on the same issue",
    ifNobodyActs:
      "the issue reports more contributors than there are people, which is the one number V029 exists to keep honest",
    procedure:
      "keep the earliest counted row and mark the rest non-counted with a reason naming this finding, then rebuild the summaries. Do not delete the rows: the record that the same person contributed twice is true and worth keeping.",
  }),
];

/**
 * Permitted transitions.
 *
 * Every status this system shows was supposed to have been reached by a
 * recorded transition. A status with no event behind it is a status nobody can
 * explain.
 */
const transitionChecks = (tx: Queryable): readonly Promise<CheckOutcome>[] => [
  sqlCheck(tx, {
    check: "status_with_no_transition_event",
    invariant: "permitted_transitions",
    recoverability: "unrecoverable",
    sql: `select i.issue_id
            from canonical_issue i
           where i.current_status <> 'created'
             and not exists (
                   select 1 from status_event e
                    where e.aggregate_type = 'canonical_issue'
                      and e.aggregate_id = i.issue_id::text
                 )
           order by i.issue_id`,
    idColumn: "issue_id",
    what: "an issue is in a status that no recorded event ever moved it to",
    ifNobodyActs:
      "the issue keeps behaving as though it reached that status legitimately — an ageing clock runs or does not, a queue includes it or does not — and nothing can say why",
    lost: "who moved the issue and why. The transition was never recorded, so the actor, the reason and the time are gone and cannot be reconstructed from anything here.",
    procedure:
      "do not edit the status to match a guess. Record a new event by a named operator that states the status was found without provenance and what was decided about it, then let the ordinary lifecycle continue from there; a fabricated history is worse than a gap that says it is one.",
  }),
];

/**
 * Metric denominators.
 *
 * V037's rule is that a rate names its population. This checks that the
 * population the projection reports is the population the records contain.
 */
const denominatorChecks = async (
  tx: Queryable,
  options: IntegrityOptions,
): Promise<readonly CheckOutcome[]> => {
  const summaryName = options.summaryName ?? DISTRICT_CATEGORY_SUMMARY;

  const cellPartition = await sqlCheck(tx, {
    check: "summary_cells_do_not_total_the_facts",
    invariant: "metric_denominators",
    recoverability: "repairable_by_rebuild",
    sql: `select $1::text as summary_name
            from (select 1) probe
           where (select coalesce(sum(issue_count), 0) from summary_cell where summary_name = $1)
              <> (select count(*) from summary_issue_fact
                   where summary_name = $1 and not retired_by_merge)`,
    params: [summaryName],
    idColumn: "summary_name",
    // Facts retired by a merge are held deliberately and counted in no cell
    // (V038), so they are excluded here rather than being reported as a gap.
    what: "the projected cells do not add up to the number of live issues the projection holds facts for",
    ifNobodyActs:
      "every rate computed from this summary divides by a denominator that does not match its own numerator, and V037's promise that a rate names its population stops being true",
    procedure:
      "run `npm run summaries:rebuild`, which recomputes every cell from the records and is safe to run at any time, then `npm run summaries:report` to confirm the totals agree.",
  });

  let reconciliation: CheckOutcome;
  try {
    const result = await reconcileSummaries(tx, { summaryName, asOf: options.asOf });
    const findings: IntegrityFinding[] = [];
    if (!result.reconciled) {
      findings.push(
        integrityFinding({
          check: "projection_disagrees_with_a_rebuild",
          invariant: "metric_denominators",
          recoverability: "repairable_by_rebuild",
          what: "the stored projection and a fresh rebuild from the records do not agree",
          affected: result.factDifferences.slice(0, AFFECTED_LIMIT).map((d) => d.issueId),
          matched: result.mismatchedFacts + result.mismatchedCells,
          ifNobodyActs:
            "every dashboard figure and every summary read continues to report the stored numbers, which are the ones that disagree with the records they claim to describe",
          procedure:
            "run `npm run summaries:rebuild`. The rebuild reads the records and replaces the projection, so the disagreement is resolved in favour of the records rather than the cache. Keep this run's report: the difference is the only evidence of how far the projection drifted.",
        }),
      );
    }
    reconciliation = {
      check: "projection_disagrees_with_a_rebuild",
      invariant: "metric_denominators",
      ran: true,
      findings,
    };
  } catch (error) {
    reconciliation = {
      check: "projection_disagrees_with_a_rebuild",
      invariant: "metric_denominators",
      ran: false,
      reasonNotRun: error instanceof Error ? error.message : String(error),
      findings: [],
    };
  }

  return [cellPartition, reconciliation];
};

/**
 * Delivery.
 *
 * V017 promised that work is never silently dropped. A task that stopped being
 * retried without saying why is exactly that, wearing a different name.
 */
const deliveryChecks = (
  tx: Queryable,
  options: IntegrityOptions,
): readonly Promise<CheckOutcome>[] => [
  sqlCheck(tx, {
    check: "task_abandoned_without_a_reason",
    invariant: "delivery",
    recoverability: "repairable_by_operator",
    sql: `select outbox_id
            from outbox
           where delivered_at is null
             and terminal_failure_reason is null
             and attempts >= $1::int
           order by created_at`,
    params: [options.maxAttempts ?? 5],
    idColumn: "outbox_id",
    what: "a task has reached the attempt ceiling, is not delivered, and records no terminal reason",
    ifNobodyActs:
      "the work never happens and nothing says so: a report that was accepted is never classified, matched or routed, and the citizen's receipt keeps promising it is being processed",
    procedure:
      "read the task's event and stage history to find why it stopped, record a terminal reason on the row so it is no longer silent, then re-enqueue the stage if the cause has been fixed. A task with a reason is a backlog item; a task without one is a disappearance.",
  }),
  sqlCheck(tx, {
    check: "task_delivered_and_failed",
    enforcedBy: "outbox_terminal_requires_no_delivery_ck",
    invariant: "delivery",
    recoverability: "repairable_by_operator",
    sql: `select outbox_id
            from outbox
           where delivered_at is not null and terminal_failure_reason is not null
           order by created_at`,
    idColumn: "outbox_id",
    what: "a task is recorded as both delivered and terminally failed",
    ifNobodyActs:
      "the delivery log contradicts itself, so no later question about whether that work happened can be answered from it",
    procedure:
      "check the stage's own result to establish which is true, then clear whichever field the stage contradicts and record an operator note saying which was believed and why.",
  }),
];

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export const runIntegrityChecks = async (
  tx: Queryable,
  options: IntegrityOptions,
): Promise<readonly CheckOutcome[]> => {
  const parallel = await Promise.all([
    ...membershipChecks(tx),
    ...uniquenessChecks(tx),
    ...transitionChecks(tx),
    ...deliveryChecks(tx, options),
  ]);
  const denominators = await denominatorChecks(tx, options);
  return [...parallel, ...denominators];
};

/** Every check this module runs, for a test that asserts each one has a probe. */
export const INTEGRITY_CHECK_NAMES: readonly string[] = [
  "evidence_on_more_than_one_active_issue",
  "merge_alias_cycle",
  "duplicate_public_reference",
  "participation_counted_twice",
  "status_with_no_transition_event",
  "task_abandoned_without_a_reason",
  "task_delivered_and_failed",
  "summary_cells_do_not_total_the_facts",
  "projection_disagrees_with_a_rebuild",
];
