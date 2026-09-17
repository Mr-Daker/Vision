/**
 * Department routing through a versioned directory (roadmap V033).
 *
 * Routing is a **deterministic directory lookup**, not an inference. The AI
 * proposes a category (V023) and a reviewer may confirm it (V032); this then
 * asks the directory who owns that category, in that jurisdiction, as of now,
 * at a named version. There is no classifier parameter here and no network
 * call, because conflating the two would let unreviewed model output look like
 * an authority decision.
 *
 * Three things make a route explainable, and all three are recorded:
 *
 *  - the **directory version** consulted, so the route can be re-derived after
 *    the directory changes. It must be supplied: silently taking "the latest"
 *    would make two identical issues route differently over time with nothing
 *    saying why;
 *  - the **category** used, so a later category change does not rewrite the
 *    reason this route was chosen;
 *  - whether the recipient is **simulated**.
 *
 * And the hard prohibition: routing means "we decided who this belongs to". It
 * is not delivery, not internal acceptance, and above all not a government
 * acknowledgment — those are V034's three separate facts. `isGovernmentAcknowledgment`
 * is a literal `false` here so no caller can read it as one.
 *
 * A decision here is also a **lifecycle move**, which it was not originally.
 * Recording the decision and leaving `current_status` at `created` meant
 * `routing_review` and `routed_internal` were states nothing in the running
 * product could reach — only the demo seeds produced them, and the event
 * ledger never mentioned either, so V037's reconstruction of status at a past
 * horizon had nothing to read. The move goes through `advanceIssueStatus`, so
 * it is still `canTransitionIssue` that decides whether it is allowed.
 */

import { randomUUID } from "node:crypto";

import type { Queryable } from "./outbox.ts";
import { advanceIssueStatus } from "./issue-lifecycle.ts";

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * Runs `work` so that everything it writes commits or fails together.
 *
 * Needed because `resolveRouting` now performs two writes that must not come
 * apart — the decision row and the lifecycle move — and its callers differ in
 * whether they already own a transaction. The matching pipeline calls it in
 * autocommit; the review queue calls it from inside its own `begin`, where
 * issuing another `begin` would make the inner `commit` commit the caller's
 * work and leave a later failure unrollbackable.
 *
 * The probe is the one `assignSubmissionToIssueInTransaction` already relies
 * on: `savepoint` outside a transaction block raises 25P01. Asking the
 * database is the only answer that cannot be wrong, and a parameter saying
 * "trust me, I am in a transaction" is exactly the assertion this codebase
 * refuses everywhere else.
 */
const atomically = async <T>(tx: Queryable, work: () => Promise<T>): Promise<T> => {
  const probe = `routing_${randomUUID().replace(/-/g, "")}`;
  let ownsTransaction = false;
  try {
    await tx.query(`savepoint ${probe}`);
    await tx.query(`release savepoint ${probe}`);
  } catch (error) {
    if ((error as { code?: string }).code !== "25P01") throw error;
    ownsTransaction = true;
  }

  if (!ownsTransaction) return work();

  await tx.query("begin");
  try {
    const result = await work();
    await tx.query("commit");
    return result;
  } catch (error) {
    await tx.query("rollback").catch(() => undefined);
    throw error;
  }
};

export type RoutingOutcome =
  "routed" | "unknown_owner_review" | "ambiguous_owner_review" | "no_directory_entry";

type RoutingBase = {
  readonly issueId: string;
  readonly directoryVersion: string;
  readonly category: string;
  readonly reason: string;
  readonly jurisdictionResolutionId: string | undefined;
  readonly jurisdiction:
    | {
        readonly jurisdictionId: string;
        readonly internalCode: string;
        readonly profileId: string;
        readonly boundaryVersion: string;
        readonly syntheticProvenance: boolean;
      }
    | undefined;
  /** Always false. Routing is a decision about ownership, never an acknowledgment. */
  readonly isGovernmentAcknowledgment: false;
  readonly disclosure: string;
};

export type RoutingResult =
  | (RoutingBase & {
      readonly outcome: "routed";
      readonly responsibilityId: string;
      readonly departmentId: string;
      readonly departmentLabel: string;
      readonly recipientMode: "simulated" | "real";
    })
  | (RoutingBase & {
      readonly outcome: "unknown_owner_review" | "ambiguous_owner_review" | "no_directory_entry";
      readonly recipientMode: "none";
    });

const SIMULATED_DISCLOSURE =
  "this route was decided internally and the recipient is a simulated department; nothing here is a government acknowledgment";
const REAL_DISCLOSURE =
  "this route names a real recipient from the directory; being routed is not an acknowledgment by that recipient";
const REVIEW_DISCLOSURE =
  "no recipient was determined, so this issue is waiting for an operational review; nothing has been sent anywhere";

export type SeedResult = {
  readonly inserted: number;
  readonly alreadyPresent: number;
  readonly directoryVersion: string;
};

/**
 * Loads a routing directory pack into the database for one jurisdiction.
 *
 * V033 recorded that the directory "has no seeded entries outside tests, so a
 * live demo would route everything to `no_directory_entry`". This is that
 * seeding step. It is idempotent: re-running finds the existing open-ended
 * entry rather than colliding with
 * `responsibility_directory_active_uniq`, so a redeploy is safe.
 *
 * Every entry the pack loader accepted is `simulated` — the loader refuses a
 * real recipient outright — so nothing this writes can present a government
 * relationship.
 */
export const seedRoutingDirectory = async (
  tx: Queryable,
  options: {
    readonly jurisdictionId: string;
    readonly directory: {
      readonly directoryVersion: string;
      readonly entries: readonly {
        readonly category: string;
        readonly departmentId: string;
        readonly departmentLabel: string;
        readonly providerMode: "simulated";
      }[];
    };
  },
): Promise<SeedResult> => {
  let inserted = 0;
  let alreadyPresent = 0;

  for (const entry of options.directory.entries) {
    const existing = await tx.query(
      `select department_id, department_label, provider_mode
         from responsibility_directory
        where directory_version = $1 and jurisdiction_id = $2 and category = $3
          and effective_to is null`,
      [options.directory.directoryVersion, options.jurisdictionId, entry.category],
    );
    const present = existing.rows[0];
    if (present !== undefined) {
      if (
        String(present["department_id"]) !== entry.departmentId ||
        String(present["department_label"]) !== entry.departmentLabel ||
        String(present["provider_mode"]) !== "simulated"
      ) {
        throw new RoutingError(
          `routing directory '${options.directory.directoryVersion}' changed category '${entry.category}' without changing its version`,
        );
      }
      alreadyPresent += 1;
      continue;
    }
    await tx.query(
      `insert into responsibility_directory
         (responsibility_id, directory_version, jurisdiction_id, category,
          department_id, department_label, provider_mode, effective_from)
       values ($1,$2,$3,$4,$5,$6,'simulated', now())`,
      [
        randomUUID(),
        options.directory.directoryVersion,
        options.jurisdictionId,
        entry.category,
        entry.departmentId,
        entry.departmentLabel,
      ],
    );
    inserted += 1;
  }

  return { inserted, alreadyPresent, directoryVersion: options.directory.directoryVersion };
};

/** Seeds every scoped rule after resolving its internal jurisdiction code. */
export const seedRoutingDirectoryForProfile = async (
  tx: Queryable,
  options: {
    readonly profileId: string;
    readonly boundaryVersion: string;
    readonly directory: {
      readonly directoryVersion: string;
      readonly entries: readonly {
        readonly jurisdictionInternalCode: string;
        readonly category: string;
        readonly departmentId: string;
        readonly departmentLabel: string;
        readonly providerMode: "simulated";
      }[];
    };
  },
): Promise<SeedResult> => {
  let inserted = 0;
  let alreadyPresent = 0;
  const internalCodes = [
    ...new Set(options.directory.entries.map((entry) => entry.jurisdictionInternalCode)),
  ];
  const available = await tx.query(
    `select jurisdiction_id, internal_code
       from jurisdiction
      where jurisdiction_profile_id = $1
        and directory_version = $2
        and internal_code = any($3::text[])`,
    [options.profileId, options.boundaryVersion, internalCodes],
  );
  const jurisdictionIds = new Map(
    available.rows.map((row) => [String(row["internal_code"]), String(row["jurisdiction_id"])]),
  );
  const missing = internalCodes.filter((code) => !jurisdictionIds.has(code));
  if (missing.length > 0) {
    throw new RoutingError(
      `routing rules name jurisdiction(s) absent from profile '${options.profileId}' version '${options.boundaryVersion}': ${missing.join(", ")}`,
    );
  }

  for (const entry of options.directory.entries) {
    const jurisdictionId = jurisdictionIds.get(entry.jurisdictionInternalCode);
    if (jurisdictionId === undefined) {
      throw new RoutingError("the validated routing jurisdiction disappeared during seeding");
    }
    const result = await seedRoutingDirectory(tx, {
      jurisdictionId,
      directory: { directoryVersion: options.directory.directoryVersion, entries: [entry] },
    });
    inserted += result.inserted;
    alreadyPresent += result.alreadyPresent;
  }
  return { inserted, alreadyPresent, directoryVersion: options.directory.directoryVersion };
};

export const resolveRouting = async (
  tx: Queryable,
  options: {
    readonly issueId: string;
    readonly directoryVersion: string;
    readonly jurisdictionResolutionId?: string | undefined;
  },
): Promise<RoutingResult> => {
  if (options.directoryVersion.trim().length === 0) {
    throw new RoutingError(
      "a routing decision must name the directory version it used; there is no default",
    );
  }

  const issue = await tx.query(
    `select i.category, i.jurisdiction_id, j.internal_code,
            j.jurisdiction_profile_id, j.directory_version as boundary_version,
            j.synthetic_provenance
       from canonical_issue i
       left join jurisdiction j on j.jurisdiction_id = i.jurisdiction_id
      where i.issue_id = $1`,
    [options.issueId],
  );
  const row = issue.rows[0];
  if (row === undefined) {
    throw new RoutingError(`issue ${options.issueId} does not exist`);
  }
  const category = String(row["category"]);
  const jurisdictionId =
    row["jurisdiction_id"] === null ? undefined : String(row["jurisdiction_id"]);
  const jurisdiction =
    jurisdictionId === undefined
      ? undefined
      : {
          jurisdictionId,
          internalCode: String(row["internal_code"]),
          profileId: String(row["jurisdiction_profile_id"]),
          boundaryVersion: String(row["boundary_version"]),
          syntheticProvenance: row["synthetic_provenance"] === true,
        };

  if (options.jurisdictionResolutionId !== undefined) {
    const linked = await tx.query(
      `select 1 from jurisdiction_resolution
        where resolution_id = $1 and issue_id = $2`,
      [options.jurisdictionResolutionId, options.issueId],
    );
    if (linked.rows[0] === undefined) {
      throw new RoutingError(
        "the jurisdiction resolution does not belong to the issue being routed",
      );
    }
  }

  const record = async (
    outcome: RoutingOutcome,
    reason: string,
    recipient:
      | {
          readonly responsibilityId: string;
          readonly departmentId: string;
          readonly departmentLabel: string;
          readonly recipientMode: "simulated" | "real";
        }
      | undefined,
  ): Promise<RoutingResult> => {
    const routingId = randomUUID();
    await atomically(tx, async () => {
      await tx.query(
        `insert into routing_decision
         (routing_id, issue_id, directory_version, category, jurisdiction_id,
          responsibility_id, department_id, department_label, recipient_mode,
          outcome, reason, jurisdiction_resolution_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          routingId,
          options.issueId,
          options.directoryVersion,
          category,
          jurisdictionId ?? null,
          recipient?.responsibilityId ?? null,
          recipient?.departmentId ?? null,
          recipient?.departmentLabel ?? null,
          recipient?.recipientMode ?? "none",
          outcome,
          reason,
          options.jurisdictionResolutionId ?? null,
        ],
      );

      // The decision is also a move, which V033 recorded and did not make.
      //
      // Leaving `current_status` at `created` meant `routing_review` and
      // `routed_internal` were states no running code could reach: only the
      // demo seeds ever produced one, the ledger never mentioned either, and
      // V037's reconstruction of status at a past horizon — which reads
      // `status_event` and nothing else — therefore had nothing to read.
      //
      // Guarded, not asserted. `advanceIssueStatus` puts every move through
      // `canTransitionIssue`, and the UPDATE is conditioned on the issue still
      // being in `created`, so:
      //
      //  * a re-route of an issue that has already moved on is a no-op and
      //    still records its decision row — a re-route is history either way;
      //  * an issue sitting in `routing_review` is *not* released by a later
      //    directory entry appearing. `canTransitionIssue` requires a reviewer
      //    to leave that state, and a deterministic lookup is not the person
      //    who was asked to decide.
      await advanceIssueStatus(tx, {
        issueId: options.issueId,
        from: "created",
        to: outcome === "routed" ? "routed_internal" : "routing_review",
        context: {
          actor: "system_worker",
          hasActiveOutgoingAlias: false,
          routingDirectoryVersion: options.directoryVersion,
        },
        eventType: outcome === "routed" ? "routed_internal" : "routing_review",
        actorType: "system_worker",
        payload: {
          routing_id: routingId,
          directory_version: options.directoryVersion,
          category,
          outcome,
          jurisdiction_id: jurisdictionId ?? null,
          department_id: recipient?.departmentId ?? null,
          recipient_mode: recipient?.recipientMode ?? "none",
          reason,
          // Said in the event too, because a stream is read by things that
          // never saw the disclosure on the screen.
          is_government_acknowledgment: false,
        },
      });
    });

    const base: RoutingBase = {
      issueId: options.issueId,
      directoryVersion: options.directoryVersion,
      category,
      reason,
      jurisdictionResolutionId: options.jurisdictionResolutionId,
      jurisdiction,
      isGovernmentAcknowledgment: false,
      disclosure:
        recipient === undefined
          ? REVIEW_DISCLOSURE
          : recipient.recipientMode === "simulated"
            ? SIMULATED_DISCLOSURE
            : REAL_DISCLOSURE,
    };

    return recipient === undefined
      ? { ...base, outcome: outcome as Exclude<RoutingOutcome, "routed">, recipientMode: "none" }
      : { ...base, outcome: "routed", ...recipient };
  };

  if (jurisdictionId === undefined) {
    // V033 leaves an issue unscoped when the point is outside the configured
    // profile, overlaps peers, or its accuracy range reaches an edge. That is
    // an operational review item rather than a guessed owner.
    return record(
      "unknown_owner_review",
      "the issue has no safely resolved jurisdiction, so no responsibility entry can be looked up; it is waiting for operational review",
      undefined,
    );
  }

  const { rows } = await tx.query(
    `select responsibility_id, department_id, department_label, provider_mode
       from responsibility_directory
      where directory_version = $1
        and jurisdiction_id = $2
        and category = $3
        and effective_from <= now()
        and (effective_to is null or effective_to > now())
      order by responsibility_id asc`,
    [options.directoryVersion, jurisdictionId, category],
  );

  if (rows.length === 0) {
    return record(
      "no_directory_entry",
      `directory '${options.directoryVersion}' lists no owner for category '${category}' in this jurisdiction as of now`,
      undefined,
    );
  }
  if (rows.length > 1) {
    // Unreachable through a duplicate row: responsibility_directory_active_uniq
    // already guarantees one open-ended owner per (version, jurisdiction,
    // category), and that constraint is what the test pins. Kept because
    // genuine contested ownership comes from overlapping jurisdictions, which
    // V059 introduces — and picking the first row would hide it.
    return record(
      "ambiguous_owner_review",
      `directory '${options.directoryVersion}' lists ${String(rows.length)} owners for category '${category}' in this jurisdiction; contested ownership is decided by a person, not by picking the first row`,
      undefined,
    );
  }

  const entry = rows[0];
  if (entry === undefined) {
    return record("no_directory_entry", "the directory query returned nothing", undefined);
  }
  const recipientMode = String(entry["provider_mode"]) === "real" ? "real" : "simulated";
  return record(
    "routed",
    `routing directory '${options.directoryVersion}' assigns category '${category}' in jurisdiction '${jurisdiction?.internalCode ?? jurisdictionId}' from boundary version '${jurisdiction?.boundaryVersion ?? "unknown"}' to '${String(entry["department_id"])}'`,
    {
      responsibilityId: String(entry["responsibility_id"]),
      departmentId: String(entry["department_id"]),
      departmentLabel: String(entry["department_label"]),
      recipientMode,
    },
  );
};
