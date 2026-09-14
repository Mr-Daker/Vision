/**
 * Private object storage with scoped upload grants (roadmap V016).
 *
 * A filesystem driver stands in for managed private buckets. The storage
 * *semantics* are the point, not the backend: a managed driver (V051) must
 * satisfy the same contract tests.
 *
 * Four separate trees, because mixing them is how private evidence leaks:
 *
 *   staging/      an upload in progress. L2, expires if never completed.
 *   originals/    accepted private evidence. Never public.
 *   quarantine/   failed or suspicious content, isolated for review.
 *   derivatives/  redaction-approved, public-safe output only.
 *
 * The invariant that matters most: **a failed upload never produces accepted
 * evidence.** Every rejection path either leaves nothing behind or moves the
 * bytes to quarantine — never to `originals/`.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

import {
  nowIso,
  type AdapterDescriptor,
  type AdapterOutcome,
  type CapabilityDescriptor,
  type IsoTimestamp,
  type MutationAdapterCallContext,
  type ObjectStoreAdapter,
  type SimulatedProvenance,
  type StoredObject,
  type UploadGrant,
  type Uuid,
} from "@vision/contracts";
import type { Decision } from "@vision/domain";

export const FILESYSTEM_OBJECT_STORE_PROVIDER = "filesystem-object-store";

export const OBJECT_STORE_CAPABILITY: CapabilityDescriptor = {
  capability: "object_storage",
  provider_name: FILESYSTEM_OBJECT_STORE_PROVIDER,
  provider_mode: "simulated",
  display_label: "Simulated local object storage — demonstration only",
  v002_row: 5,
  may_claim: ["Stored byte size and content type", "Cryptographic fingerprint of the stored bytes"],
  must_not_claim: ["Verified authentic photograph", "Confirmed not AI-generated"],
};

/** Content types the demonstration accepts, with their magic-byte signatures. */
const PERMITTED_TYPES: Readonly<Record<string, readonly (readonly number[])[]>> = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // WebM/Matroska EBML header; used for recorded voice.
  "audio/webm": [[0x1a, 0x45, 0xdf, 0xa3]],
  "audio/ogg": [[0x4f, 0x67, 0x67, 0x53]],
};

export const PERMITTED_CONTENT_TYPES: readonly string[] = Object.keys(PERMITTED_TYPES);

/** Hard ceiling regardless of what a caller requests. */
export const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

/** V005 §6: an incomplete upload is deleted within 24 hours. */
export const STAGING_TTL_SECONDS = 24 * 60 * 60;

export type ObjectStoreOptions = {
  readonly root: string;
  /** [L3c] HMAC key binding a grant to its object path and owner. */
  readonly grantHmacKey: string;
  readonly grantTtlSeconds?: number;
};

type GrantRecord = {
  readonly object_reference: string;
  readonly owner_pseudonym: Uuid;
  readonly intended_content_type: string;
  readonly max_bytes: number;
  readonly issued_at: IsoTimestamp;
  readonly expires_at: IsoTimestamp;
  readonly signature: string;
  finalized: boolean;
  finalized_result?: StoredObject;
};

export class ObjectStoreError extends Error {}

/**
 * Proof that an audited authorization decision permitted reading a private
 * original. Only `grantOriginalAccess` can produce one, and it refuses unless
 * the decision was both allowed and flagged for audit — so the storage layer
 * cannot be talked into serving an original by a caller that merely asserts
 * it is authorized (V015 §3, V005 §3).
 */
declare const originalAccessBrand: unique symbol;
export type OriginalAccessGrant = {
  readonly [originalAccessBrand]: true;
  readonly purpose: string;
};

/**
 * Service-identity read of the original a stage is processing (V006 §4).
 *
 * The role-based path below models a *human* principal, and no role in that
 * model is the worker: pretending the media pipeline is a reviewer would put a
 * false actor in the audit trail. This is the narrow alternative — still
 * purpose-bound, still audited, and scoped to a named stage — and it grants
 * nothing beyond reading the object that stage was handed.
 */
export const grantStageOriginalAccess = (stage: string, purpose: string): OriginalAccessGrant => {
  if (stage.trim().length === 0) {
    throw new ObjectStoreError("a stage-bound original read must name its stage");
  }
  if (purpose.trim().length < 8) {
    throw new ObjectStoreError("a private-original read requires a recorded purpose");
  }
  return { purpose: `stage:${stage}: ${purpose}` } as OriginalAccessGrant;
};

export const grantOriginalAccess = (decision: Decision, purpose: string): OriginalAccessGrant => {
  if (!decision.allowed) {
    throw new ObjectStoreError("reading a private original requires an allowed decision");
  }
  if (!decision.auditRequired) {
    throw new ObjectStoreError(
      "reading a private original is exceptional access and must be audited; refusing a routine decision",
    );
  }
  if (purpose.trim().length < 8) {
    throw new ObjectStoreError("a private-original read requires a recorded purpose");
  }
  return { purpose } as OriginalAccessGrant;
};

const sniffContentType = (bytes: Buffer): string | undefined => {
  for (const [type, signatures] of Object.entries(PERMITTED_TYPES)) {
    for (const signature of signatures) {
      if (bytes.length < signature.length) continue;
      if (signature.every((byte, index) => bytes[index] === byte)) return type;
    }
  }
  return undefined;
};

export class FilesystemObjectStoreAdapter implements ObjectStoreAdapter {
  readonly descriptor: AdapterDescriptor = {
    provider_name: FILESYSTEM_OBJECT_STORE_PROVIDER,
    provider_mode: "simulated",
    capability: OBJECT_STORE_CAPABILITY,
  };

  private readonly root: string;
  private readonly grantHmacKey: string;
  private readonly grantTtlSeconds: number;
  private readonly clock: () => IsoTimestamp;
  private readonly grants = new Map<string, GrantRecord>();

  constructor(options: ObjectStoreOptions, clock: () => IsoTimestamp = nowIso) {
    if (options.grantHmacKey.length === 0) {
      throw new ObjectStoreError("OBJECT_STORE_GRANT_HMAC_KEY must be configured");
    }
    this.root = options.root;
    this.grantHmacKey = options.grantHmacKey;
    this.grantTtlSeconds = options.grantTtlSeconds ?? 900;
    this.clock = clock;
  }

  private provenance(fixtureId: string): SimulatedProvenance {
    return {
      provider_mode: "simulated",
      authenticity: "simulated_fixture",
      provider_name: FILESYSTEM_OBJECT_STORE_PROVIDER,
      observed_at: this.clock(),
      fixture_id: fixtureId,
    };
  }

  /**
   * Resolves a tree-relative path, refusing anything that escapes the tree.
   * A traversal attempt is a storage-layer concern, not the caller's.
   */
  private pathFor(
    tree: "staging" | "originals" | "quarantine" | "derivatives",
    ref: string,
  ): string {
    const base = join(this.root, tree);
    const resolved = normalize(join(base, ref));
    if (!resolved.startsWith(base + sep)) {
      throw new ObjectStoreError(`object reference escapes the ${tree} tree: ${ref}`);
    }
    return resolved;
  }

  private sign(
    objectReference: string,
    owner: Uuid,
    contentType: string,
    maxBytes: number,
  ): string {
    return createHmac("sha256", this.grantHmacKey)
      .update(`${objectReference}\0${owner}\0${contentType}\0${String(maxBytes)}`)
      .digest("hex");
  }

  private isExpired(record: GrantRecord, at: IsoTimestamp): boolean {
    return Date.parse(record.expires_at) <= Date.parse(at);
  }

  async createUploadGrant(
    request: {
      readonly intended_content_type: string;
      readonly max_bytes: number;
      readonly owner_pseudonym: Uuid;
    },
    context: MutationAdapterCallContext,
  ): Promise<AdapterOutcome<UploadGrant>> {
    const correlation_id = context.correlation_id;

    if (!Object.hasOwn(PERMITTED_TYPES, request.intended_content_type)) {
      return {
        kind: "rejected",
        reason_code: "unsupported_content_type",
        retryable: false,
        detail: `content type '${request.intended_content_type}' is not accepted`,
        provenance: this.provenance("object_storage.grant.unsupported_type"),
        correlation_id,
      };
    }
    if (request.max_bytes <= 0 || request.max_bytes > MAX_OBJECT_BYTES) {
      return {
        kind: "rejected",
        reason_code: "invalid_size_limit",
        retryable: false,
        detail: `max_bytes must be between 1 and ${String(MAX_OBJECT_BYTES)}`,
        provenance: this.provenance("object_storage.grant.invalid_size"),
        correlation_id,
      };
    }

    const issuedAt = this.clock();
    // Unique, non-guessable, date-partitioned path. Never derived from
    // caller-supplied names, so one caller cannot target another's object.
    const objectReference = `${issuedAt.slice(0, 7)}/${randomUUID()}`;
    const expiresAt = new Date(
      Date.parse(issuedAt) + this.grantTtlSeconds * 1000,
    ).toISOString() as IsoTimestamp;

    const signature = this.sign(
      objectReference,
      request.owner_pseudonym,
      request.intended_content_type,
      request.max_bytes,
    );

    this.grants.set(objectReference, {
      object_reference: objectReference,
      owner_pseudonym: request.owner_pseudonym,
      intended_content_type: request.intended_content_type,
      max_bytes: request.max_bytes,
      issued_at: issuedAt,
      expires_at: expiresAt,
      signature,
      finalized: false,
    });

    return {
      kind: "success",
      value: {
        object_reference: objectReference,
        // The token binds the URL to this object, owner, type and size.
        upload_url: `/v1/uploads/${encodeURIComponent(objectReference)}?token=${signature}`,
        expires_at: expiresAt,
        max_bytes: request.max_bytes,
        permitted_content_types: [request.intended_content_type],
      },
      provenance: this.provenance("object_storage.grant.success"),
      correlation_id,
    };
  }

  /**
   * Writes staged bytes. This stands in for the client's PUT to a signed URL.
   *
   * It refuses unless the presented token matches the grant for *this* object,
   * which is what stops an authorized client writing to an object it was not
   * granted.
   */
  async putStagedObject(
    objectReference: string,
    token: string,
    bytes: Buffer,
    declaredContentType: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    const record = this.grants.get(objectReference);
    if (record === undefined) {
      return { ok: false, reason: "no_grant_for_object" };
    }

    const presented = Buffer.from(token, "utf8");
    const expected = Buffer.from(record.signature, "utf8");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return { ok: false, reason: "grant_token_mismatch" };
    }
    if (this.isExpired(record, this.clock())) {
      return { ok: false, reason: "grant_expired" };
    }
    if (record.finalized) {
      return { ok: false, reason: "object_already_finalized" };
    }
    if (declaredContentType !== record.intended_content_type) {
      return { ok: false, reason: "declared_content_type_mismatch" };
    }
    // Refuse oversized content at write time as well as at completion, so
    // nothing oversized is ever persisted even briefly.
    if (bytes.byteLength > record.max_bytes) {
      return { ok: false, reason: "oversized_content" };
    }

    const target = this.pathFor("staging", objectReference);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return { ok: true };
  }

  async finalizeUpload(
    objectReference: string,
    context: MutationAdapterCallContext,
  ): Promise<AdapterOutcome<StoredObject>> {
    const correlation_id = context.correlation_id;
    const at = this.clock();
    const record = this.grants.get(objectReference);

    const reject = (
      reasonCode: string,
      detail: string,
      fixture: string,
    ): AdapterOutcome<StoredObject> => ({
      kind: "rejected",
      reason_code: reasonCode,
      retryable: false,
      detail,
      provenance: this.provenance(fixture),
      correlation_id,
    });

    // A forged completion for an object nobody granted.
    if (record === undefined) {
      return reject(
        "no_grant_for_object",
        "no upload grant exists for this object reference",
        "object_storage.finalize.forged",
      );
    }

    // Replay of a completed upload returns the committed result.
    if (record.finalized) {
      return {
        kind: "duplicate",
        reason_code: "upload_already_finalized",
        ...(record.finalized_result === undefined
          ? {}
          : { existing_value: record.finalized_result }),
        provenance: this.provenance("object_storage.finalize.duplicate"),
        correlation_id,
      };
    }

    if (this.isExpired(record, at)) {
      await this.quarantine(objectReference, "grant_expired");
      return reject(
        "grant_expired",
        "the upload grant expired before completion was validated",
        "object_storage.finalize.expired",
      );
    }

    const staged = this.pathFor("staging", objectReference);
    let bytes: Buffer;
    try {
      bytes = await readFile(staged);
    } catch {
      return reject(
        "no_staged_object",
        "completion was claimed but no staged bytes exist",
        "object_storage.finalize.missing",
      );
    }

    if (bytes.byteLength === 0) {
      await this.quarantine(objectReference, "empty_object");
      return reject("empty_object", "the staged object is empty", "object_storage.finalize.empty");
    }
    if (bytes.byteLength > record.max_bytes) {
      await this.quarantine(objectReference, "oversized_content");
      return reject(
        "oversized_content",
        `staged object is ${String(bytes.byteLength)} bytes, over the granted ${String(record.max_bytes)}`,
        "object_storage.finalize.oversized",
      );
    }

    // The declared type must match what the bytes actually are. A filename or
    // header is not evidence of content (V005 §7).
    const sniffed = sniffContentType(bytes);
    if (sniffed === undefined || sniffed !== record.intended_content_type) {
      await this.quarantine(objectReference, "content_type_mismatch");
      return reject(
        "content_metadata_mismatch",
        `declared '${record.intended_content_type}' but the bytes are ${sniffed ?? "an unrecognised format"}`,
        "object_storage.finalize.mismatch",
      );
    }

    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const original = this.pathFor("originals", objectReference);
    await mkdir(dirname(original), { recursive: true });
    await rename(staged, original);

    const result: StoredObject = {
      object_reference: objectReference,
      byte_size: bytes.byteLength,
      content_type: sniffed,
      stored_at: at,
    };
    record.finalized = true;
    record.finalized_result = result;
    this.fingerprints.set(objectReference, fingerprint);

    return {
      kind: "success",
      value: result,
      provenance: this.provenance("object_storage.finalize.success"),
      correlation_id,
    };
  }

  private readonly fingerprints = new Map<string, string>();

  /** Cryptographic fingerprint of accepted bytes, for V021 reuse detection. */
  fingerprintOf(objectReference: string): string | undefined {
    return this.fingerprints.get(objectReference);
  }

  /**
   * Content type of an accepted object, as validated at completion.
   *
   * `finalizeUpload` only accepts bytes whose sniffed type equals the declared
   * one, so this is the *actual* type and not a client claim. A consumer that
   * re-checks it is doing defence in depth, not validation.
   */
  contentTypeOf(objectReference: string): string | undefined {
    return this.grants.get(objectReference)?.finalized_result?.content_type;
  }

  private async quarantine(objectReference: string, reason: string): Promise<void> {
    const staged = this.pathFor("staging", objectReference);
    try {
      await stat(staged);
    } catch {
      return;
    }
    const target = this.pathFor("quarantine", `${objectReference}.${reason}`);
    await mkdir(dirname(target), { recursive: true });
    await rename(staged, target);
  }

  /** Reading a private original requires audited, purpose-bound access. */
  async readOriginal(objectReference: string, access: OriginalAccessGrant): Promise<Buffer> {
    if (access.purpose.trim().length < 8) {
      throw new ObjectStoreError("a private-original read requires a recorded purpose");
    }
    return readFile(this.pathFor("originals", objectReference));
  }

  /**
   * Reads a published derivative for public serving (V030).
   *
   * Confined to the derivatives tree by `pathFor`, which refuses a reference
   * that escapes it — so there is no reference a caller can construct that
   * reaches `originals/`, `staging/` or `quarantine/`. A derivative only
   * exists here if `writeApprovedDerivative` accepted it, which requires an
   * approved or not-required redaction decision, so "is it publishable?" was
   * already answered when the file was created.
   */
  async readApprovedDerivative(reference: string): Promise<Buffer | undefined> {
    let target: string;
    try {
      target = this.pathFor("derivatives", reference);
    } catch {
      // A traversal attempt is a signal, not an absence — but the caller is
      // told nothing beyond "no such derivative".
      return undefined;
    }
    try {
      return await readFile(target);
    } catch {
      return undefined;
    }
  }

  /**
   * Publishes a redaction-approved derivative into the separate public tree.
   * Mirrors the V012 constraint that a derivative requires approval.
   */
  async writeApprovedDerivative(
    objectReference: string,
    bytes: Buffer,
    redactionStatus: "approved" | "not_required" | "pending" | "needs_review",
  ): Promise<string> {
    if (redactionStatus !== "approved" && redactionStatus !== "not_required") {
      throw new ObjectStoreError(
        `refusing to publish a derivative with redaction_status '${redactionStatus}'`,
      );
    }
    const target = this.pathFor("derivatives", objectReference);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return `derivatives/${objectReference}`;
  }

  /**
   * True only for bytes that passed completion validation.
   *
   * The path is resolved *outside* the try, so a reference that escapes the
   * tree raises `ObjectStoreError` rather than being reported as a quiet
   * "not found". A traversal attempt is a signal, not an absence.
   */
  async hasAcceptedEvidence(objectReference: string): Promise<boolean> {
    const path = this.pathFor("originals", objectReference);
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether this process issued the upload grant to the named owner.
   *
   * Upload references are unguessable, but possession of a reference is not
   * authorization. The grant owner is checked separately before a staff
   * session may finalize or attach the object to a resolution claim.
   */
  isUploadOwnedBy(objectReference: string, ownerPseudonym: Uuid): boolean {
    return this.grants.get(objectReference)?.owner_pseudonym === ownerPseudonym;
  }

  /** True only when accepted bytes exist and the authenticated owner uploaded them. */
  async hasAcceptedEvidenceOwnedBy(
    objectReference: string,
    ownerPseudonym: Uuid,
  ): Promise<boolean> {
    const record = this.grants.get(objectReference);
    if (
      record === undefined ||
      record.owner_pseudonym !== ownerPseudonym ||
      record.finalized !== true
    ) {
      return false;
    }
    return this.hasAcceptedEvidence(objectReference);
  }

  async hasStagedObject(objectReference: string): Promise<boolean> {
    const path = this.pathFor("staging", objectReference);
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deletes staged objects whose grant has expired (V005 §6: within 24 hours).
   * Returns the references removed, so a job can report what it cleaned.
   */
  async cleanupExpiredStaging(): Promise<readonly string[]> {
    const at = this.clock();
    const removed: string[] = [];

    for (const [reference, record] of this.grants) {
      if (record.finalized) continue;
      const staleAfter = Date.parse(record.issued_at) + STAGING_TTL_SECONDS * 1000;
      const expiredGrant = this.isExpired(record, at);
      const staleStaging = Date.parse(at) >= staleAfter;
      if (!expiredGrant && !staleStaging) continue;

      const staged = this.pathFor("staging", reference);
      try {
        await rm(staged, { force: true });
      } catch {
        continue;
      }
      this.grants.delete(reference);
      removed.push(reference);
    }
    return removed;
  }

  /** Test/diagnostic helper: how many objects each tree holds. */
  async treeCounts(): Promise<Readonly<Record<string, number>>> {
    const counts: Record<string, number> = {};
    for (const tree of ["staging", "originals", "quarantine", "derivatives"] as const) {
      let total = 0;
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.isDirectory()) await walk(join(dir, entry.name));
          else total += 1;
        }
      };
      await walk(join(this.root, tree));
      counts[tree] = total;
    }
    return counts;
  }
}
