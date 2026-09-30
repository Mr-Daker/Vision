/**
 * Submission acceptance and durable receipts (roadmap V018).
 *
 * The whole task hinges on one sequence: validate, then commit the submission,
 * its evidence, its first event and its pending work in **one** transaction,
 * and only then return a receipt. Consequences:
 *
 *  - A failed commit cannot be presented as a successful report, because the
 *    receipt is constructed from committed rows, not from the request.
 *  - A network retry under the same idempotency key returns the *original*
 *    receipt rather than creating a second submission.
 *  - The receipt stays readable while the worker is down, because reading it
 *    touches only the submission row.
 */

import { randomUUID } from "node:crypto";

import {
  parseBcp47,
  parseIdempotencyKey,
  parseIsoTimestamp,
  type FieldIssue,
} from "@vision/contracts";

import { recordConsent, KNOWN_CONSENT_PURPOSES } from "./consent.ts";
import { appendEventWithOutbox, type Queryable } from "./outbox.ts";
import type { FilesystemObjectStoreAdapter } from "./object-store.ts";

/** A client's declared observation. Every field is a claim, not proof. */
export type SubmissionInput = {
  readonly participantId: string;
  readonly observed: {
    readonly lon: number;
    readonly lat: number;
    /**
     * Metres, as reported by the device. **Absent for a manual pin**, which
     * has no device measurement — storing 0 there would present a typed
     * guess as a perfect reading, and the column is nullable for exactly
     * this reason.
     */
    readonly accuracyMetres?: number;
    /** Distinguishes captured location evidence from a manually dropped pin. */
    readonly source: "device_geolocation" | "manual_pin";
    readonly observedAt: string;
  };
  readonly interfaceLocale: string;
  /**
   * What the person agreed to when they sent this, if they were asked. It is
   * written in the same transaction as the report, before any worker can pick
   * the report up, so the first time the system decides whether this person
   * counts, the agreement is already there. Absent means they were not asked
   * (an API client): the report is saved and simply never counted.
   */
  readonly consent?: {
    readonly noticeVersion: string;
    readonly purposes: readonly string[];
  };
  readonly languageHint?: string;
  readonly text?: string;
  /** References to uploads already finalized through V016. */
  readonly evidence: readonly {
    readonly objectReference: string;
    readonly mediaType: "photo" | "voice";
  }[];
};

export type SubmissionReceipt = {
  readonly submission_id: string;
  readonly status_url: string;
  readonly processing_status: string;
  readonly server_received_at: string;
  /** True when this receipt was replayed rather than freshly created. */
  readonly replayed: boolean;
};

/**
 * A receipt read back later, with where the report is now.
 *
 * `processing_status` records intake and stays `received` once the work has
 * moved on to an issue, so on its own it told a resident that their report
 * arrived and nothing about what happened next. The issue it was grouped
 * with — the same one "your reports" shows — carries the rest. Both are null
 * until the report has been grouped.
 */
export type SubmissionReceiptWithProgress = SubmissionReceipt & {
  readonly issue_status: string | null;
  readonly issue_public_reference: string | null;
};

export type CreateSubmissionResult =
  | { readonly ok: true; readonly receipt: SubmissionReceipt }
  | {
      readonly ok: false;
      readonly code: "validation_failed";
      readonly issues: readonly FieldIssue[];
    }
  | { readonly ok: false; readonly code: "idempotency_key_reused"; readonly detail: string };

export type SubmissionServiceOptions = {
  readonly localePackVersion: string;
  readonly taxonomyVersion: string;
  readonly supportedLocales: readonly string[];
  readonly maxTextLength?: number;
  readonly maxAccuracyMetres?: number;
};

/** A transaction-capable client (`pg.Client`), needed for atomic acceptance. */
export interface TransactionalClient extends Queryable {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: Record<string, unknown>[]; readonly rowCount: number | null }>;
}

const issue = (field: string, code: string, detail: string): FieldIssue => ({
  field,
  code,
  detail,
});

export class SubmissionService {
  private readonly client: TransactionalClient;
  private readonly objectStore: Pick<
    FilesystemObjectStoreAdapter,
    "hasAcceptedEvidence" | "fingerprintOf"
  >;
  private readonly options: Required<Omit<SubmissionServiceOptions, "supportedLocales">> & {
    readonly supportedLocales: readonly string[];
  };

  constructor(
    client: TransactionalClient,
    objectStore: Pick<FilesystemObjectStoreAdapter, "hasAcceptedEvidence" | "fingerprintOf">,
    options: SubmissionServiceOptions,
  ) {
    this.client = client;
    this.objectStore = objectStore;
    this.options = {
      localePackVersion: options.localePackVersion,
      taxonomyVersion: options.taxonomyVersion,
      supportedLocales: options.supportedLocales,
      maxTextLength: options.maxTextLength ?? 2000,
      maxAccuracyMetres: options.maxAccuracyMetres ?? 10_000,
    };
  }

  /**
   * Validates the request without touching the database.
   *
   * Deliberately does NOT accept a category, department or severity: the
   * citizen is never asked to classify their own report (V001 §3).
   */
  async validate(input: SubmissionInput, idempotencyKey: string): Promise<readonly FieldIssue[]> {
    const issues: FieldIssue[] = [];

    const key = parseIdempotencyKey(idempotencyKey);
    if (!key.ok) issues.push(key.error);

    const locale = parseBcp47(input.interfaceLocale, "interface_locale");
    if (!locale.ok) issues.push(locale.error);
    else if (!this.options.supportedLocales.includes(input.interfaceLocale)) {
      issues.push(
        issue(
          "interface_locale",
          "unsupported_locale",
          `enabled locales are ${this.options.supportedLocales.join(", ")}`,
        ),
      );
    }

    const observedAt = parseIsoTimestamp(input.observed.observedAt, "observed_at");
    if (!observedAt.ok) issues.push(observedAt.error);

    const { lon, lat, accuracyMetres } = input.observed;
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      issues.push(issue("observed.lon", "out_of_range", "longitude must be between -180 and 180"));
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      issues.push(issue("observed.lat", "out_of_range", "latitude must be between -90 and 90"));
    }
    if (input.observed.source === "manual_pin") {
      // A typed position carries no device accuracy. Accepting one would let a
      // client dress a guess up as a measurement.
      if (accuracyMetres !== undefined) {
        issues.push(
          issue(
            "observed.accuracy_m",
            "not_applicable",
            "a manually entered location has no device accuracy to report",
          ),
        );
      }
    } else if (accuracyMetres === undefined) {
      issues.push(
        issue(
          "observed.accuracy_m",
          "required",
          "a device-reported location must state how accurate the device said it was",
        ),
      );
    } else if (!Number.isFinite(accuracyMetres) || accuracyMetres < 0) {
      issues.push(issue("observed.accuracy_m", "out_of_range", "accuracy must be zero or greater"));
    } else if (accuracyMetres > this.options.maxAccuracyMetres) {
      issues.push(
        issue(
          "observed.accuracy_m",
          "accuracy_too_poor",
          `accuracy beyond ${String(this.options.maxAccuracyMetres)} m cannot locate a defect`,
        ),
      );
    }

    const text = input.text?.trim() ?? "";
    if (text.length > this.options.maxTextLength) {
      issues.push(
        issue(
          "text",
          "too_long",
          `description must be at most ${String(this.options.maxTextLength)} characters`,
        ),
      );
    }

    // A report needs something observable: a description or recorded evidence.
    if (text.length === 0 && input.evidence.length === 0) {
      issues.push(
        issue(
          "evidence",
          "no_observation",
          "a report needs a description or at least one photo or voice recording",
        ),
      );
    }

    // An agreement is either complete and known or refused outright: guessing
    // at what a garbled one meant would put words in the person's mouth.
    if (input.consent !== undefined) {
      if (input.consent.noticeVersion.trim().length === 0) {
        issues.push(
          issue("consent.notice_version", "required", "name the notice the person was shown"),
        );
      }
      const unknown = input.consent.purposes.filter(
        (purpose) => !(KNOWN_CONSENT_PURPOSES as readonly string[]).includes(purpose),
      );
      if (input.consent.purposes.length === 0 || unknown.length > 0) {
        issues.push(
          issue(
            "consent.purposes",
            "unknown_purpose",
            unknown.length > 0
              ? `not a purpose this service asks for: ${unknown.join(", ")}`
              : "an agreement must name at least one purpose",
          ),
        );
      }
    }

    // Every referenced upload must already be accepted evidence (V016).
    for (const [index, item] of input.evidence.entries()) {
      const accepted = await this.objectStore
        .hasAcceptedEvidence(item.objectReference)
        .catch(() => false);
      if (!accepted) {
        issues.push(
          issue(
            `evidence[${String(index)}].object_reference`,
            "upload_not_finalized",
            "referenced upload has not passed completion validation",
          ),
        );
        continue;
      }
      if (this.objectStore.fingerprintOf(item.objectReference) === undefined) {
        issues.push(
          issue(
            `evidence[${String(index)}].object_reference`,
            "missing_fingerprint",
            "accepted evidence must carry a fingerprint",
          ),
        );
      }
    }

    return issues;
  }

  /** Returns the committed receipt for a prior identical request, if any. */
  private async findExistingReceipt(
    participantId: string,
    idempotencyKey: string,
  ): Promise<SubmissionReceipt | undefined> {
    const { rows } = await this.client.query(
      `select submission_id, processing_status, server_received_at
         from submission where participant_id = $1 and idempotency_key = $2`,
      [participantId, idempotencyKey],
    );
    if (rows.length === 0) return undefined;
    const row = rows[0]!;
    return this.receiptFrom(row, true);
  }

  private receiptFrom(row: Record<string, unknown>, replayed: boolean): SubmissionReceipt {
    const id = String(row["submission_id"]);
    return {
      submission_id: id,
      status_url: `/v1/submissions/${id}`,
      processing_status: String(row["processing_status"]),
      server_received_at: new Date(String(row["server_received_at"])).toISOString(),
      replayed,
    };
  }

  /**
   * Accepts a submission.
   *
   * The transaction writes the submission, its evidence, the first domain
   * event and the outbox work that will drive processing. The receipt is built
   * from the committed row, so it cannot describe a report the database
   * refused.
   */
  async create(
    input: SubmissionInput,
    context: { readonly idempotencyKey: string; readonly correlationId: string },
  ): Promise<CreateSubmissionResult> {
    const issues = await this.validate(input, context.idempotencyKey);
    if (issues.length > 0) {
      return { ok: false, code: "validation_failed", issues };
    }

    // Fast path: a retry that arrives after the original committed.
    const existing = await this.findExistingReceipt(input.participantId, context.idempotencyKey);
    if (existing !== undefined) return { ok: true, receipt: existing };

    const submissionId = randomUUID();
    const text = input.text?.trim() ?? "";

    await this.client.query("begin");
    try {
      const inserted = await this.client.query(
        `insert into submission (
           submission_id, participant_id, observed_location, observed_accuracy_m,
           observed_location_source, observed_at, interface_locale, language_hint,
           locale_pack_version, idempotency_key, taxonomy_version, processing_status
         ) values ($1,$2, ST_SetSRID(ST_MakePoint($3,$4),4326)::geography, $5,
                   $6,$7,$8,$9,$10,$11,$12,'received')
         returning submission_id, processing_status, server_received_at`,
        [
          submissionId,
          input.participantId,
          input.observed.lon,
          input.observed.lat,
          input.observed.accuracyMetres ?? null,
          input.observed.source,
          input.observed.observedAt,
          input.interfaceLocale,
          input.languageHint ?? null,
          this.options.localePackVersion,
          context.idempotencyKey,
          this.options.taxonomyVersion,
        ],
      );

      // The agreement is part of the same commit, so a report never exists
      // without the agreement that came with it (or the agreement without it).
      if (input.consent !== undefined) {
        await recordConsent(this.client, {
          participantId: input.participantId,
          noticeVersion: input.consent.noticeVersion,
          noticeLocale: input.interfaceLocale,
          grantedPurposes: input.consent.purposes,
        });
      }

      // Text description is evidence in its own right (V003 EvidenceItem).
      if (text.length > 0) {
        await this.client.query(
          `insert into evidence_item (
             evidence_id, submission_id, media_type, content_text, source_language,
             processing_status, redaction_status
           ) values ($1,$2,'text',$3,$4,'pending','pending')`,
          [randomUUID(), submissionId, text, input.languageHint ?? null],
        );
      }

      for (const item of input.evidence) {
        const fingerprint = this.objectStore.fingerprintOf(item.objectReference);
        await this.client.query(
          `insert into evidence_item (
             evidence_id, submission_id, media_type, object_reference, fingerprint_hash,
             source_language, processing_status, redaction_status
           ) values ($1,$2,$3,$4,$5,$6,'pending','pending')`,
          [
            randomUUID(),
            submissionId,
            item.mediaType,
            item.objectReference,
            fingerprint,
            input.languageHint ?? null,
          ],
        );
      }

      // The first domain event and the work that will process it, in the same
      // commit as the rows above (V017).
      await appendEventWithOutbox(
        this.client,
        {
          aggregate_type: "Submission",
          aggregate_id: submissionId,
          aggregate_version: 1,
          event_type: "submission_received",
          actor_type: "citizen",
          actor_pseudonym: input.participantId,
          correlation_id: context.correlationId,
          occurred_at: input.observed.observedAt,
          payload_schema_version: "v1",
          // Identifiers and counts only — no description, coordinates or
          // object references (V003 StatusEvent, V005 §8).
          payload: {
            evidence_count: input.evidence.length + (text.length > 0 ? 1 : 0),
            interface_locale: input.interfaceLocale,
            location_source: input.observed.source,
          },
        },
        [{ task_type: "process_submission_media" }],
      );

      await this.client.query("commit");
      return { ok: true, receipt: this.receiptFrom(inserted.rows[0]!, false) };
    } catch (error) {
      await this.client.query("rollback");

      // A concurrent retry may have won the race on the idempotency key.
      const raced = await this.findExistingReceipt(input.participantId, context.idempotencyKey);
      if (raced !== undefined) return { ok: true, receipt: raced };

      const detail = String(error instanceof Error ? error.message : error);
      if (detail.includes("submission_participant_idempotency_uniq")) {
        return { ok: false, code: "idempotency_key_reused", detail };
      }
      // Nothing was committed, so nothing may be reported as accepted.
      throw error;
    }
  }

  /**
   * Reads a receipt. Depends only on the submission row, so it keeps working
   * while the worker is down — which is what makes a saved submission
   * discoverable during an outage.
   */
  async readReceipt(
    submissionId: string,
    participantId: string,
  ): Promise<SubmissionReceiptWithProgress | undefined> {
    // The issue is found the way `listMyReports` finds it — through the live
    // evidence link — so a receipt and the reports list never disagree about
    // where the same report is.
    const { rows } = await this.client.query(
      `select s.submission_id, s.processing_status, s.server_received_at,
              grouped.current_status as issue_status,
              grouped.public_reference as issue_public_reference
         from submission s
         left join lateral (
           select i.current_status, i.public_reference
             from evidence_item e
             join issue_evidence_link link
               on link.evidence_id = e.evidence_id and link.effective_to is null
             join canonical_issue i on i.issue_id = link.canonical_issue_id
            where e.submission_id = s.submission_id
            order by link.effective_from desc
            limit 1
         ) grouped on true
        where s.submission_id = $1 and s.participant_id = $2`,
      [submissionId, participantId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      ...this.receiptFrom(row, false),
      issue_status: row["issue_status"] === null ? null : String(row["issue_status"]),
      issue_public_reference:
        row["issue_public_reference"] === null ? null : String(row["issue_public_reference"]),
    };
  }
}
