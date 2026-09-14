/**
 * Media processing IO shell (roadmap V021).
 *
 * The decisions live in `media-pipeline.ts`, which is pure. This file does the
 * parts only the database and the object store can do: take a stage lease so
 * duplicate delivery is harmless (V017), read the private original through the
 * audited purpose-bound path (V015), persist the derived values, and publish a
 * derivative *only* when the redaction decision is resolved.
 *
 * The derivative rule is enforced in three independent places on purpose — the
 * pipeline produces no bytes, this shell does not call the writer, and the
 * database constraint `evidence_item_derivative_needs_approval_ck` refuses the
 * row. Any one of them failing still leaves the other two.
 */

import { acquireStageLease, completeStage, failStage, type Queryable } from "./outbox.ts";
import { grantStageOriginalAccess, type FilesystemObjectStoreAdapter } from "./object-store.ts";
import {
  MEDIA_PIPELINE_VERSION,
  processPhotoBytes,
  type PhotoDetector,
  type ProcessPhotoResult,
} from "./media-pipeline.ts";

/** Stage name under which media processing is leased. */
export const MEDIA_STAGE = "media_processing";

/** Seconds a media-processing lease is held before it may be taken over. */
export const MEDIA_LEASE_SECONDS = 60;

export type EvidenceReuse = {
  readonly seenBefore: boolean;
  readonly otherEvidenceIds: readonly string[];
  readonly otherSubmissionIds: readonly string[];
  /**
   * Always false. Identical bytes appearing twice means the same photograph was
   * submitted twice; it is not a second, independent observation, and V002
   * forbids presenting it as one.
   */
  readonly isIndependentCorroboration: false;
  readonly note: string;
};

const REUSE_NOTE =
  "identical bytes were submitted before; this is reuse of one photograph and is not independent corroboration";

/**
 * Finds other evidence records carrying the same cryptographic fingerprint.
 *
 * Erased rows are excluded because their fingerprint is cleared by the V005
 * erasure rule, so they cannot match anyway — and a tombstone is not a
 * contributor's evidence.
 */
export const findFingerprintReuse = async (
  tx: Queryable,
  options: { readonly fingerprintHash: string; readonly excludeEvidenceId: string },
): Promise<EvidenceReuse> => {
  const { rows } = await tx.query(
    `select evidence_id, submission_id
       from evidence_item
      where fingerprint_hash = $1
        and evidence_id <> $2
        -- Redundant with the erasure constraint, which clears the fingerprint
        -- of an erased row, so an erased row cannot match anyway. Kept as the
        -- statement of intent: a tombstone is not a contributor's evidence.
        and privacy_state = 'active'
      order by ingested_at asc`,
    [options.fingerprintHash, options.excludeEvidenceId],
  );

  return {
    seenBefore: rows.length > 0,
    otherEvidenceIds: rows.map((row) => String(row["evidence_id"])),
    otherSubmissionIds: rows.map((row) => String(row["submission_id"])),
    isIndependentCorroboration: false,
    note: REUSE_NOTE,
  };
};

export type ProcessEvidenceInput = {
  readonly evidenceId: string;
  /** Recorded reason for touching a private original; the object store refuses a vague one. */
  readonly purpose: string;
  readonly detector?: PhotoDetector;
  readonly owner?: string;
};

export type ProcessEvidenceOutcome = {
  readonly ok: boolean;
  /** True when a previous run already completed this stage, so nothing was redone. */
  readonly alreadyProcessed: boolean;
  readonly result?: ProcessPhotoResult;
  readonly reuse?: EvidenceReuse;
  readonly derivativeReference?: string;
  readonly reasons: readonly string[];
};

export class MediaProcessingService {
  private readonly client: Queryable;
  private readonly objectStore: FilesystemObjectStoreAdapter;

  constructor(client: Queryable, objectStore: FilesystemObjectStoreAdapter) {
    this.client = client;
    this.objectStore = objectStore;
  }

  async processEvidence(input: ProcessEvidenceInput): Promise<ProcessEvidenceOutcome> {
    const { rows } = await this.client.query(
      `select submission_id, media_type, object_reference, privacy_state, current_version
         from evidence_item where evidence_id = $1`,
      [input.evidenceId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`evidence not found: ${input.evidenceId}`);
    if (row["privacy_state"] !== "active") {
      // An erased item has no bytes to process and must not be resurrected.
      return { ok: false, alreadyProcessed: true, reasons: ["evidence has been erased"] };
    }
    if (row["media_type"] !== "photo") {
      return { ok: false, alreadyProcessed: false, reasons: ["only photographs run this stage"] };
    }

    const submissionId = String(row["submission_id"]);
    const objectReference = String(row["object_reference"]);

    // Built before the lease deliberately: a bad purpose must not consume an
    // attempt or leave a lease dangling until reconciliation picks it up.
    const access = grantStageOriginalAccess(MEDIA_STAGE, input.purpose);

    const lease = await acquireStageLease(
      this.client,
      { submissionId, stage: MEDIA_STAGE, pipelineVersion: MEDIA_PIPELINE_VERSION },
      {
        owner: input.owner ?? `media-worker:${process.pid}`,
        leaseSeconds: MEDIA_LEASE_SECONDS,
        inputHash: objectReference,
      },
    );
    if (!lease.acquired) {
      // `already_succeeded` is the duplicate-delivery case and is a success for
      // the caller: the work is done, just not by this delivery.
      return {
        ok: lease.reason === "already_succeeded",
        alreadyProcessed: true,
        reasons: [`stage not leased: ${lease.reason}`],
      };
    }

    // Purpose-bound, audited service read (V006 §4). A vague purpose throws
    // here rather than quietly reading a private original.
    // Bytes can be gone even though the row says the upload was accepted: a
    // restore gap, a botched migration, a bug. Left unhandled this threw out
    // of here and the stage stayed leased, which is an *invisible* failure —
    // the one outcome V022 forbids. It becomes a recorded, retryable one.
    let bytes: Buffer;
    try {
      bytes = await this.objectStore.readOriginal(objectReference, access);
    } catch (error) {
      const missing =
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "ENOENT";
      const reasonCode = missing ? "missing_original" : "unreadable_original";
      const detail = missing
        ? `the accepted original ${objectReference} is missing from storage`
        : `the accepted original ${objectReference} could not be read`;
      await failStage(this.client, lease.lease, reasonCode);
      return { ok: false, alreadyProcessed: false, reasons: [detail] };
    }

    // `finalizeUpload` already proved the stored type equals the sniffed type,
    // so the pipeline's own mismatch branch is unreachable from here. It is
    // kept because the pipeline is also callable on bytes that did not come
    // through V016, and because two independent checks is the point.
    const contentType =
      this.objectStore.contentTypeOf(objectReference) ?? "application/octet-stream";
    const result = processPhotoBytes({
      declaredContentType: contentType,
      bytes,
      ...(input.detector === undefined ? {} : { detector: input.detector }),
    });

    if (!result.ok) {
      await this.client.query(
        `update evidence_item
            set processing_status = $2, fingerprint_hash = coalesce(fingerprint_hash, $3),
                current_version = current_version + 1
          where evidence_id = $1`,
        [input.evidenceId, result.processingStatus, result.fingerprintHash],
      );
      await failStage(this.client, lease.lease, result.reasonCode);
      return {
        ok: false,
        alreadyProcessed: false,
        result,
        reasons: result.reasons,
      };
    }

    const reuse = await findFingerprintReuse(this.client, {
      fingerprintHash: result.fingerprintHash,
      excludeEvidenceId: input.evidenceId,
    });

    // Third and innermost check on publishing. It is deliberately redundant:
    // the pipeline emits no derivative bytes for an unresolved case, this
    // refuses to write them, `writeApprovedDerivative` refuses again, and the
    // `evidence_item_derivative_needs_approval_ck` constraint refuses the row.
    // Mutation testing cannot distinguish this layer while the one above it
    // holds, which is exactly what defence in depth looks like.
    let derivativeReference: string | undefined;
    if (result.derivative !== undefined && result.mayEnterPublicView) {
      derivativeReference = await this.objectStore.writeApprovedDerivative(
        objectReference,
        Buffer.from(result.derivative.bytes),
        result.redactionStatus === "needs_review" ? "needs_review" : result.redactionStatus,
      );
    }

    await this.client.query(
      `update evidence_item
          set processing_status = $2,
              redaction_status = $3,
              fingerprint_hash = $4,
              perceptual_hash = $5,
              capture_metadata = $6::jsonb,
              captured_at = $7,
              derivative_reference = $8,
              current_version = current_version + 1
        where evidence_id = $1`,
      [
        input.evidenceId,
        result.processingStatus,
        result.redactionStatus,
        result.fingerprintHash,
        result.perceptualHash,
        JSON.stringify(result.captureMetadata),
        result.captureMetadata.capturedAt ?? null,
        derivativeReference ?? null,
      ],
    );

    await completeStage(this.client, lease.lease, {
      pipeline_version: result.pipelineVersion,
      processing_status: result.processingStatus,
      redaction_status: result.redactionStatus,
      fingerprint_hash: result.fingerprintHash,
      reuse_seen_before: reuse.seenBefore,
      reuse_is_independent_corroboration: reuse.isIndependentCorroboration,
    });

    return {
      ok: true,
      alreadyProcessed: false,
      result,
      reuse,
      ...(derivativeReference === undefined ? {} : { derivativeReference }),
      reasons: result.reasons,
    };
  }
}
