/**
 * Running the V044 sample-data audit against the database.
 *
 * The rules are pure and live in `@vision/domain`. This walks the places
 * personal data could have reached and scans what it finds: the identity
 * store, what was kept from a model, the logs and event payloads, and the
 * public representation of every issue.
 *
 * Public views are **built** rather than read. `toPublicIssueView` is the one
 * function that produces a public representation, so the audit runs it over
 * every issue and checks the result — which catches a field added upstream on
 * the very issue it would have leaked from, rather than only on whichever
 * issue somebody happened to open.
 *
 * Nothing here writes. An audit that could alter what it audits is not one.
 */

import {
  isKeyedHash,
  scanText,
  toPublicIssueView,
  unexpectedPublicFields,
  type AuditFinding,
  type IssueRecord,
} from "@vision/domain";

import type { Queryable } from "./outbox.ts";

export type AuditCounts = {
  readonly identityMappings: number;
  readonly modelTraces: number;
  readonly logRows: number;
  readonly eventPayloads: number;
  readonly publicViews: number;
};

export type AuditReport = {
  readonly ranAt: string;
  readonly counts: AuditCounts;
  readonly findings: readonly AuditFinding[];
  readonly clean: boolean;
};

/**
 * The identity store.
 *
 * The keyed hash is the whole mechanism that keeps a login separate from a
 * report, so a stored value that is not a digest is either cleartext or
 * something else, and both are findings. The column is also scanned as text,
 * because a value can be the right shape and still have something else beside
 * it in the row.
 */
const auditIdentityStore = async (
  tx: Queryable,
): Promise<{ readonly findings: readonly AuditFinding[]; readonly scanned: number }> => {
  const { rows } = await tx.query(
    `select identity_mapping_id, provider, provider_subject_hash, provider_mode, erased_at
       from identity_mapping`,
  );
  const findings: AuditFinding[] = [];
  for (const row of rows) {
    const id = String(row["identity_mapping_id"]);
    const hashed = row["provider_subject_hash"];
    // A null hash on an erased row is the tombstone working, not a finding.
    // A null hash on a live row is a mapping that resolves to nothing.
    if (hashed === null || hashed === undefined) {
      if (row["erased_at"] === null || row["erased_at"] === undefined) {
        findings.push({
          scope: "identity_store",
          location: `identity_mapping/${id}`,
          patternId: "live_mapping_without_hash",
          why: "a live identity mapping with no stored digest cannot resolve a login to its participant, so either the row is wrong or an erasure did not record itself",
          maskedExcerpt: "null",
        });
      }
    } else if (!isKeyedHash(String(hashed))) {
      findings.push({
        scope: "identity_store",
        location: `identity_mapping/${id}`,
        patternId: "not_a_keyed_hash",
        why: "the stored provider subject is not a 64-character digest, so it is either cleartext or something a lookup could run backwards (V009)",
        maskedExcerpt: `${String(String(hashed).length)} chars, shape not a digest`,
      });
    }
    findings.push(
      ...scanText(
        JSON.stringify({ provider: row["provider"], provider_mode: row["provider_mode"] }),
        "identity_store",
        `identity_mapping/${id}`,
      ),
    );
  }
  return { findings, scanned: rows.length };
};

/**
 * What was kept from a model.
 *
 * V005 §6 forbids storing a raw request; the cache holds a hash of the input
 * and the provider's structured answer. Both the answer and the provider's own
 * request id are scanned, because an answer can quote its input back.
 */
const auditModelTraces = async (
  tx: Queryable,
): Promise<{ readonly findings: readonly AuditFinding[]; readonly scanned: number }> => {
  const { rows } = await tx.query(
    "select cache_id, operation, result, provider_request_id from ai_result_cache",
  );
  const findings: AuditFinding[] = [];
  for (const row of rows) {
    const location = `ai_result_cache/${String(row["cache_id"])} (${String(row["operation"])})`;
    findings.push(
      ...scanText(
        JSON.stringify({
          result: row["result"],
          provider_request_id: row["provider_request_id"],
        }),
        "model_trace",
        location,
      ),
    );
  }
  return { findings, scanned: rows.length };
};

/**
 * Logs and event payloads.
 *
 * `status_event.payload` and `outbox.payload` are the two places a handler can
 * put anything it likes, so they are scanned in full. The private-evidence
 * access log carries a free-text purpose a reviewer wrote, which is exactly
 * the sort of field an email address ends up in.
 */
const auditLogs = async (
  tx: Queryable,
): Promise<{
  readonly findings: readonly AuditFinding[];
  readonly logRows: number;
  readonly eventPayloads: number;
}> => {
  const findings: AuditFinding[] = [];

  const { rows: accessRows } = await tx.query(
    "select access_id, purpose from private_evidence_access_log",
  );
  for (const row of accessRows) {
    findings.push(
      ...scanText(
        String(row["purpose"]),
        "log",
        `private_evidence_access_log/${String(row["access_id"])}`,
      ),
    );
  }

  const { rows: eventRows } = await tx.query(
    "select event_id, aggregate_type, payload from status_event",
  );
  for (const row of eventRows) {
    findings.push(
      ...scanText(
        JSON.stringify(row["payload"]),
        "log",
        `status_event/${String(row["event_id"])} (${String(row["aggregate_type"])})`,
      ),
    );
  }

  const { rows: outboxRows } = await tx.query("select outbox_id, task_type, payload from outbox");
  for (const row of outboxRows) {
    findings.push(
      ...scanText(
        JSON.stringify(row["payload"]),
        "log",
        `outbox/${String(row["outbox_id"])} (${String(row["task_type"])})`,
      ),
    );
  }

  return {
    findings,
    logRows: accessRows.length + outboxRows.length,
    eventPayloads: eventRows.length,
  };
};

/**
 * The public representation of every issue.
 *
 * Built by running the one function that produces a public view, over every
 * issue, rather than sampling what an endpoint happened to return. The record
 * handed in carries the restricted fields deliberately — that is what makes
 * this a test of the filter rather than of the query that fed it.
 */
const auditPublicViews = async (
  tx: Queryable,
): Promise<{ readonly findings: readonly AuditFinding[]; readonly scanned: number }> => {
  const { rows } = await tx.query(
    `select c.issue_id, c.public_reference, c.category, c.current_status,
            coalesce(c.jurisdiction_id::text, '') as jurisdiction_id,
            st_x(c.representative_location::geometry) as lon,
            st_y(c.representative_location::geometry) as lat,
            (select count(*)::int from issue_participation p
              where p.canonical_issue_id = c.issue_id and p.counted) as counted,
            (select coalesce(array_agg(e.object_reference), '{}')
               from issue_evidence_link l
               join evidence_item e on e.evidence_id = l.evidence_id
              where l.canonical_issue_id = c.issue_id and e.object_reference is not null)
              as originals,
            (select coalesce(array_agg(e.derivative_reference), '{}')
               from issue_evidence_link l
               join evidence_item e on e.evidence_id = l.evidence_id
              where l.canonical_issue_id = c.issue_id and e.derivative_reference is not null)
              as derivatives
       from canonical_issue c`,
  );

  const findings: AuditFinding[] = [];
  for (const row of rows) {
    const lon = row["lon"] === null || row["lon"] === undefined ? undefined : Number(row["lon"]);
    const lat = row["lat"] === null || row["lat"] === undefined ? undefined : Number(row["lat"]);
    const record: IssueRecord = {
      issue_id: String(row["issue_id"]),
      public_reference: String(row["public_reference"]),
      category: String(row["category"]),
      current_status: String(row["current_status"]),
      jurisdiction_id: String(row["jurisdiction_id"]),
      ...(lon === undefined || lat === undefined ? {} : { precise_location: { lon, lat } }),
      counted_participants: Number(row["counted"] ?? 0),
      original_object_references: ((row["originals"] as string[] | null) ?? []).map(String),
      approved_derivative_references: ((row["derivatives"] as string[] | null) ?? []).map(String),
    };

    const view = toPublicIssueView(record);
    const location = `public_view/${record.public_reference}`;
    for (const field of unexpectedPublicFields(view as unknown as Record<string, unknown>)) {
      findings.push({
        scope: "public_view",
        location,
        patternId: "unexpected_public_field",
        why: `'${field}' is not on the public allowlist; a field added upstream must be excluded until it is added here deliberately (V005 §7)`,
        maskedExcerpt: field,
      });
    }
    findings.push(...scanText(JSON.stringify(view), "public_view", location));
  }
  return { findings, scanned: rows.length };
};

/**
 * Runs the whole audit.
 *
 * `asOf` is supplied rather than read, so a report can be reproduced and a
 * test does not depend on when it ran.
 */
export const auditSampleData = async (
  tx: Queryable,
  options: { readonly asOf: Date },
): Promise<AuditReport> => {
  const identity = await auditIdentityStore(tx);
  const traces = await auditModelTraces(tx);
  const logs = await auditLogs(tx);
  const views = await auditPublicViews(tx);

  const findings = [...identity.findings, ...traces.findings, ...logs.findings, ...views.findings];

  return {
    ranAt: options.asOf.toISOString(),
    counts: {
      identityMappings: identity.scanned,
      modelTraces: traces.scanned,
      logRows: logs.logRows,
      eventPayloads: logs.eventPayloads,
      publicViews: views.scanned,
    },
    findings,
    clean: findings.length === 0,
  };
};
