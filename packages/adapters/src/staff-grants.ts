/**
 * Durable staff grants used by the reviewer surface (roadmap V032).
 *
 * Authentication still produces an ordinary application session for a
 * pseudonymous participant. Only after validating that session does the
 * server look up this grant. Role, staff id and jurisdiction scope therefore
 * never come from a request body or browser storage.
 */

import { randomUUID } from "node:crypto";

import type { Uuid } from "@vision/contracts";
import type { Role } from "@vision/domain";

import type { Queryable } from "./outbox.ts";

export type StaffGrant = {
  readonly staffId: Uuid;
  readonly role: Exclude<Role, "citizen">;
  readonly jurisdictionScope: readonly string[];
  readonly responsibilityScope: readonly {
    readonly jurisdictionId: string;
    readonly departmentId: string;
  }[];
  readonly providerMode: "simulated" | "real";
};

export type ConfiguredStaffResponsibility = {
  readonly jurisdictionInternalCode: string;
  readonly departmentId: string;
};

export class StaffGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaffGrantError";
  }
}

export class PostgresStaffGrantRepository {
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
  }

  async findActiveByParticipant(participantId: string): Promise<StaffGrant | undefined> {
    const { rows } = await this.db.query(
      `select a.staff_id, a.role, a.provider_mode,
              coalesce(array_agg(g.jurisdiction_id::text order by g.jurisdiction_id)
                filter (where g.revoked_at is null), array[]::text[]) as jurisdiction_scope
         from staff_account a
         left join staff_jurisdiction_grant g on g.staff_id = a.staff_id
        where a.participant_id = $1
          and a.account_state = 'active'
          and a.disabled_at is null
        group by a.staff_id, a.role, a.provider_mode`,
      [participantId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const role = String(row["role"]);
    if (
      !(["reviewer", "department_staff", "supervisor", "administrator"] as const).includes(
        role as "reviewer" | "department_staff" | "supervisor" | "administrator",
      )
    ) {
      throw new StaffGrantError(`stored staff role '${role}' is not supported`);
    }
    const staffId = String(row["staff_id"]);
    const responsibilities = await this.db.query(
      `select jurisdiction_id, department_id
         from staff_department_grant
        where staff_id = $1 and revoked_at is null
        order by jurisdiction_id, department_id`,
      [staffId],
    );
    return {
      staffId: staffId as Uuid,
      role: role as StaffGrant["role"],
      jurisdictionScope: ((row["jurisdiction_scope"] as string[] | null) ?? []).map(String),
      responsibilityScope: responsibilities.rows.map((responsibility) => ({
        jurisdictionId: String(responsibility["jurisdiction_id"]),
        departmentId: String(responsibility["department_id"]),
      })),
      providerMode: String(row["provider_mode"]) === "real" ? "real" : "simulated",
    };
  }

  /**
   * Provisions the one simulated reviewer fixture for a configured demo pack.
   *
   * This is deliberately not a general staff-registration endpoint. The
   * caller has already authenticated through an adapter containing only the
   * reviewer fixture, and the profile id is deployment configuration. Existing
   * accounts are never silently promoted or re-scoped.
   */
  async ensureSimulatedReviewer(
    participantId: string,
    jurisdictionProfileId: string,
    jurisdictionInternalCodes: readonly string[],
  ): Promise<StaffGrant> {
    await this.db.query("begin");
    try {
      const jurisdictions = await this.db.query(
        `select jurisdiction_id
           from jurisdiction
          where jurisdiction_profile_id = $1
            and internal_code = any($2::text[])
            and effective_from <= now()
            and (effective_to is null or effective_to > now())
          order by jurisdiction_id`,
        [jurisdictionProfileId, jurisdictionInternalCodes],
      );
      const configuredCodes = new Set(jurisdictionInternalCodes);
      if (configuredCodes.size === 0 || jurisdictions.rows.length !== configuredCodes.size) {
        throw new StaffGrantError(
          `the configured reviewer jurisdictions for profile '${jurisdictionProfileId}' are not fully seeded`,
        );
      }

      const existing = await this.findActiveByParticipant(participantId);
      let staffId: string;
      if (existing === undefined) {
        staffId = randomUUID();
        await this.db.query(
          `insert into staff_account
             (staff_id, participant_id, role, account_state, provider_mode)
           values ($1,$2,'reviewer','active','simulated')
           on conflict (participant_id) do nothing`,
          [staffId, participantId],
        );
        const stored = await this.db.query(
          `select staff_id, role, account_state, provider_mode
             from staff_account where participant_id = $1`,
          [participantId],
        );
        const row = stored.rows[0];
        if (
          row === undefined ||
          String(row["role"]) !== "reviewer" ||
          String(row["account_state"]) !== "active" ||
          String(row["provider_mode"]) !== "simulated"
        ) {
          throw new StaffGrantError("the authenticated identity is not an active demo reviewer");
        }
        staffId = String(row["staff_id"]);
      } else {
        if (existing.role !== "reviewer" || existing.providerMode !== "simulated") {
          throw new StaffGrantError("the authenticated identity is not a simulated reviewer");
        }
        staffId = existing.staffId;
      }

      for (const row of jurisdictions.rows) {
        await this.db.query(
          `insert into staff_jurisdiction_grant (staff_id, jurisdiction_id)
           values ($1,$2)
           on conflict (staff_id, jurisdiction_id) do nothing`,
          [staffId, String(row["jurisdiction_id"])],
        );
      }

      const grant = await this.findActiveByParticipant(participantId);
      if (grant === undefined || grant.role !== "reviewer") {
        throw new StaffGrantError("the reviewer grant could not be provisioned");
      }
      await this.db.query("commit");
      return grant;
    } catch (error) {
      await this.db.query("rollback").catch(() => undefined);
      throw error;
    }
  }

  /**
   * Provisions the fixed simulated department-staff fixture.
   *
   * Responsibility pairs come from the selected, versioned routing pack. The
   * request supplies neither a role nor a department, and an existing account
   * is never promoted or re-scoped to a different role.
   */
  async ensureSimulatedDepartmentStaff(
    participantId: string,
    jurisdictionProfileId: string,
    configuredResponsibilities: readonly ConfiguredStaffResponsibility[],
  ): Promise<StaffGrant> {
    const unique = new Map<string, ConfiguredStaffResponsibility>();
    for (const responsibility of configuredResponsibilities) {
      const key = `${responsibility.jurisdictionInternalCode}\u0000${responsibility.departmentId}`;
      unique.set(key, responsibility);
    }
    if (unique.size === 0) {
      throw new StaffGrantError("the demo staff responsibility scope is empty");
    }

    await this.db.query("begin");
    try {
      const internalCodes = [
        ...new Set([...unique.values()].map((row) => row.jurisdictionInternalCode)),
      ];
      const jurisdictions = await this.db.query(
        `select jurisdiction_id, internal_code
           from jurisdiction
          where jurisdiction_profile_id = $1
            and internal_code = any($2::text[])
            and effective_from <= now()
            and (effective_to is null or effective_to > now())`,
        [jurisdictionProfileId, internalCodes],
      );
      const jurisdictionByCode = new Map(
        jurisdictions.rows.map((row) => [
          String(row["internal_code"]),
          String(row["jurisdiction_id"]),
        ]),
      );
      if (jurisdictionByCode.size !== internalCodes.length) {
        throw new StaffGrantError(
          `the configured staff jurisdictions for profile '${jurisdictionProfileId}' are not fully seeded`,
        );
      }

      const resolved = [...unique.values()].map((responsibility) => ({
        jurisdictionId: jurisdictionByCode.get(responsibility.jurisdictionInternalCode) ?? "",
        departmentId: responsibility.departmentId,
      }));
      const available = await this.db.query(
        `select distinct jurisdiction_id, department_id
           from responsibility_directory
          where jurisdiction_id = any($1::uuid[])
            and department_id = any($2::text[])
            and effective_from <= now()
            and (effective_to is null or effective_to > now())`,
        [resolved.map((row) => row.jurisdictionId), resolved.map((row) => row.departmentId)],
      );
      const availablePairs = new Set(
        available.rows.map(
          (row) => `${String(row["jurisdiction_id"])}\u0000${String(row["department_id"])}`,
        ),
      );
      if (
        resolved.some(
          (row) => !availablePairs.has(`${row.jurisdictionId}\u0000${row.departmentId}`),
        )
      ) {
        throw new StaffGrantError(
          "the configured staff responsibility directory entries are not fully seeded",
        );
      }

      const existing = await this.findActiveByParticipant(participantId);
      let staffId: string;
      if (existing === undefined) {
        staffId = randomUUID();
        await this.db.query(
          `insert into staff_account
             (staff_id, participant_id, role, account_state, provider_mode)
           values ($1,$2,'department_staff','active','simulated')
           on conflict (participant_id) do nothing`,
          [staffId, participantId],
        );
        const stored = await this.db.query(
          `select staff_id, role, account_state, provider_mode
             from staff_account where participant_id = $1`,
          [participantId],
        );
        const row = stored.rows[0];
        if (
          row === undefined ||
          String(row["role"]) !== "department_staff" ||
          String(row["account_state"]) !== "active" ||
          String(row["provider_mode"]) !== "simulated"
        ) {
          throw new StaffGrantError(
            "the authenticated identity is not an active demo department staff account",
          );
        }
        staffId = String(row["staff_id"]);
      } else {
        if (existing.role !== "department_staff" || existing.providerMode !== "simulated") {
          throw new StaffGrantError(
            "the authenticated identity is not a simulated department staff account",
          );
        }
        staffId = existing.staffId;
      }

      for (const responsibility of resolved) {
        await this.db.query(
          `insert into staff_jurisdiction_grant (staff_id, jurisdiction_id)
           values ($1,$2)
           on conflict (staff_id, jurisdiction_id) do nothing`,
          [staffId, responsibility.jurisdictionId],
        );
        await this.db.query(
          `insert into staff_department_grant (staff_id, jurisdiction_id, department_id)
           values ($1,$2,$3)
           on conflict (staff_id, jurisdiction_id, department_id) do nothing`,
          [staffId, responsibility.jurisdictionId, responsibility.departmentId],
        );
      }

      const grant = await this.findActiveByParticipant(participantId);
      if (
        grant === undefined ||
        grant.role !== "department_staff" ||
        grant.responsibilityScope.length !== resolved.length
      ) {
        throw new StaffGrantError("the department staff grant could not be provisioned");
      }
      await this.db.query("commit");
      return grant;
    } catch (error) {
      await this.db.query("rollback").catch(() => undefined);
      throw error;
    }
  }
}
