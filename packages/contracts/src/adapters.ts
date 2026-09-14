/**
 * Replaceable provider-adapter ports (roadmap V008).
 *
 * Every port returns `AdapterOutcome<T>` so that unavailable, pending,
 * rejected, duplicate and ambiguous results are ordinary data rather than
 * exceptions. A real provider can replace a simulated one without changing any
 * caller, which is what V010's "done when" requires.
 *
 * No port exposes a provider identity reference, a token, or a secret to its
 * caller. Adapters keep those inside their own boundary (V005 §3).
 */

import type { AdapterOutcome, ProviderMode } from "./outcomes.ts";
import type {
  Bcp47,
  CorrelationId,
  IdempotencyKey,
  IdempotencyScope,
  IsoTimestamp,
  RequestFingerprint,
  Uuid,
} from "./primitives.ts";
import type { CapabilityDescriptor } from "./capability.ts";

/** Every adapter must describe itself, including whether it is simulated. */
export type AdapterDescriptor = {
  readonly provider_name: string;
  readonly provider_mode: ProviderMode;
  readonly capability: CapabilityDescriptor;
};

export type AdapterCallContext = {
  readonly correlation_id: CorrelationId;
  readonly deadline_ms?: number;
};

/**
 * Required context for every adapter operation that can create or change
 * provider-side state. The application derives the scope and fingerprint from
 * the authenticated actor/tenant, operation, and canonical request; adapters
 * must bind the opaque key to both rather than trusting the key alone.
 */
export type MutationAdapterCallContext = AdapterCallContext & {
  readonly idempotency_key: IdempotencyKey;
  readonly idempotency_scope: IdempotencyScope;
  readonly request_fingerprint: RequestFingerprint;
};

// ---------------------------------------------------------------------------
// 1. Identity (V009 simulated; V057 real)
// ---------------------------------------------------------------------------

/**
 * What an identity provider asserts. `provider_subject_reference` is the raw
 * provider-scoped subject: it crosses this boundary exactly once, is
 * immediately keyed-hashed by the identity service, and is never returned to
 * the application domain (V003 IdentityMapping).
 */
export type CredentialStateObservation =
  | {
      readonly state: "active";
      readonly checked_at: IsoTimestamp;
    }
  | {
      readonly state: "revoked";
      readonly checked_at: IsoTimestamp;
      readonly revoked_at: IsoTimestamp;
    }
  | {
      readonly state: "expired";
      readonly checked_at: IsoTimestamp;
      readonly expired_at: IsoTimestamp;
    };

export type IdentityAssertion = {
  readonly provider: string;
  /** Credential issuer as asserted by the adapter; simulated in V009. */
  readonly issuer: string;
  readonly provider_subject_reference: string;
  /** Assurance the provider claims. Never interpreted as truth of a report. */
  readonly assurance_label: string;
  /** Explicitly observed credential state; callers must fail closed unless active. */
  readonly credential_state: CredentialStateObservation;
  readonly asserted_at: IsoTimestamp;
};

export type IdentityChallenge = {
  /** Opaque credential supplied by the citizen. Simulated adapters use fixtures. */
  readonly credential: string;
  readonly interface_locale: Bcp47;
};

export interface IdentityProviderAdapter {
  readonly descriptor: AdapterDescriptor;
  /** Resolves a credential to a provider assertion. */
  authenticate(
    challenge: IdentityChallenge,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<IdentityAssertion>>;
}

// ---------------------------------------------------------------------------
// 2. Government routing / recipient (V010 simulated; V058 real)
// ---------------------------------------------------------------------------

export type RecipientSubmission = {
  readonly issue_id: Uuid;
  readonly department_id: string;
  readonly routing_directory_version: string;
  readonly category: string;
  readonly summary_reference: string;
  readonly submitted_at: IsoTimestamp;
};

/** A delivery receipt is transport-level only: it is not an acknowledgment. */
export type RecipientDelivery = {
  readonly delivery_id: Uuid;
  readonly issue_id: Uuid;
  readonly department_id: string;
  readonly accepted_at: IsoTimestamp;
  /** Provider-side reference, when the recipient issues one. */
  readonly external_reference?: string;
};

/**
 * An acknowledgment claims the recipient took receipt. It may only be
 * presented as official receipt when its provenance is
 * `authenticated_external` (V002 row 16, outcomes.ts).
 */
export type RecipientAcknowledgment = {
  readonly delivery_id: Uuid;
  readonly issue_id: Uuid;
  readonly acknowledged_at: IsoTimestamp;
  readonly external_reference?: string;
  readonly note?: string;
};

export interface GovernmentRecipientAdapter {
  readonly descriptor: AdapterDescriptor;
  /** Hand an issue to the recipient channel. Success means delivered, not acknowledged. */
  deliver(
    submission: RecipientSubmission,
    context: MutationAdapterCallContext,
  ): Promise<AdapterOutcome<RecipientDelivery>>;
  /** Poll for acknowledgment. `pending` is the normal answer before one arrives. */
  fetchAcknowledgment(
    deliveryId: Uuid,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<RecipientAcknowledgment>>;
}

// ---------------------------------------------------------------------------
// 3. Object storage (V016 real driver; filesystem locally)
// ---------------------------------------------------------------------------

export type UploadGrant = {
  readonly object_reference: string;
  readonly upload_url: string;
  readonly expires_at: IsoTimestamp;
  readonly max_bytes: number;
  readonly permitted_content_types: readonly string[];
};

export type StoredObject = {
  readonly object_reference: string;
  readonly byte_size: number;
  readonly content_type: string;
  readonly stored_at: IsoTimestamp;
};

export interface ObjectStoreAdapter {
  readonly descriptor: AdapterDescriptor;
  /** Narrowly scoped, expiring grant for exactly one object path. */
  createUploadGrant(
    request: {
      readonly intended_content_type: string;
      readonly max_bytes: number;
      readonly owner_pseudonym: Uuid;
    },
    context: MutationAdapterCallContext,
  ): Promise<AdapterOutcome<UploadGrant>>;
  /** Server-side validation that the promised object actually arrived intact. */
  finalizeUpload(
    objectReference: string,
    context: MutationAdapterCallContext,
  ): Promise<AdapterOutcome<StoredObject>>;
}

// ---------------------------------------------------------------------------
// 4. Durable task delivery (V017)
// ---------------------------------------------------------------------------

export type TaskRequest = {
  readonly task_type: string;
  readonly stage_key: string;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
  readonly not_before?: IsoTimestamp;
};

export type TaskHandle = {
  readonly task_id: string;
  readonly stage_key: string;
  readonly enqueued_at: IsoTimestamp;
};

export interface TaskDeliveryAdapter {
  readonly descriptor: AdapterDescriptor;
  /**
   * Delivery is at-least-once and unordered (V006 §7). A `duplicate` outcome
   * for a known stage key is expected, not an error.
   */
  enqueue(
    task: TaskRequest,
    context: MutationAdapterCallContext,
  ): Promise<AdapterOutcome<TaskHandle>>;
}

// ---------------------------------------------------------------------------
// 5. AI inference (V023) — classification and transcription are separate
//    operations with separate consent purposes (V005 §4)
// ---------------------------------------------------------------------------

export type ClassificationInput = {
  /** Redaction-approved derivative reference only; never an original. */
  readonly approved_image_reference?: string;
  /** Submitted text, or a voice transcript. Never raw audio. */
  readonly text: string;
  readonly source_language: Bcp47;
  readonly taxonomy_version: string;
};

export type ClassificationProposal = {
  readonly taxonomy_version: string;
  readonly proposed_category_id: string;
  readonly proposed_defect_id?: string;
  /**
   * Model-reported ordinal band, never presented as a probability of truth
   * (V002 prohibition 9).
   */
  readonly certainty_band: "low" | "medium" | "high";
  readonly requires_review: boolean;
  readonly model_name: string;
  readonly prompt_version: string;
  readonly input_hash: string;
};

export interface AiClassificationAdapter {
  readonly descriptor: AdapterDescriptor;
  classify(
    input: ClassificationInput,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<ClassificationProposal>>;
}

export type TranscriptionInput = {
  /** Private audio object reference. Requires gemini_voice_transcription consent. */
  readonly audio_object_reference: string;
  readonly expected_language?: Bcp47;
};

export type TranscriptionResult = {
  readonly transcript_text: string;
  readonly detected_language: Bcp47;
  readonly model_name: string;
  readonly input_hash: string;
  /** True when the audio left our trust boundary, which the notice must disclose. */
  readonly processed_externally: boolean;
};

export interface AiTranscriptionAdapter {
  readonly descriptor: AdapterDescriptor;
  transcribe(
    input: TranscriptionInput,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<TranscriptionResult>>;
}

// ---------------------------------------------------------------------------
// 6. Source import (V010 fixtures; V040/V061 real feeds)
// ---------------------------------------------------------------------------

export type SourceLicence =
  | "permitted"
  | "synthetic"
  | "consented"
  | "reference_only"
  | "unavailable"
  | "verification_pending";

export type SourceDemoStatus =
  | "permitted_source_data"
  | "team_created_synthetic"
  | "consented_evaluation_data"
  | "unavailable_not_approved";

/**
 * One imported record plus the provenance that decides whether it may back a
 * demonstration claim at all (V004 §5).
 */
export type SourceRecordSnapshot = {
  readonly source_record_id: Uuid;
  readonly source_name: string;
  readonly source_url_or_location: string;
  readonly retrieved_at: IsoTimestamp;
  readonly source_effective_at?: IsoTimestamp;
  readonly licence_or_permission_status: SourceLicence;
  readonly demo_status: SourceDemoStatus;
  /** Must be absent for reference_only / unavailable / verification_pending. */
  readonly raw_snapshot?: Readonly<Record<string, unknown>>;
};

export type SourceImportQuery = {
  readonly dataset: string;
  readonly jurisdiction_profile_id: string;
  readonly as_of?: IsoTimestamp;
};

export interface SourceImportAdapter {
  readonly descriptor: AdapterDescriptor;
  fetchRecords(
    query: SourceImportQuery,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<readonly SourceRecordSnapshot[]>>;
}

/**
 * A snapshot may only be ingested when its licence permits it. Reference-only
 * and unavailable sources must never carry a raw snapshot (V003 SourceRecord).
 */
export const isIngestible = (snapshot: SourceRecordSnapshot): boolean =>
  (snapshot.licence_or_permission_status === "permitted" ||
    snapshot.licence_or_permission_status === "synthetic" ||
    snapshot.licence_or_permission_status === "consented") &&
  snapshot.demo_status !== "unavailable_not_approved";
