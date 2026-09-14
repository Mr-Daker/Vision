/**
 * Consent-aware device drafts (roadmap V020).
 *
 * What this is for: a lost connection must not lose what the citizen wrote,
 * and must not pretend the report was accepted. Those are two different
 * failures and both are addressed here — the draft survives, and it is stored
 * as an explicitly *unsent* draft that carries the original idempotency key so
 * reconnecting retries the same report instead of filing a second one.
 *
 * Privacy rules this file implements ([V005](../../../docs/foundation/V005-data-privacy-and-retention.md)):
 *
 *  - **Nothing is written without consent.** No consent, no key in storage —
 *    not an empty draft, not a flag beyond the consent decision itself.
 *  - **Disclosed lifetime, enforced in code.** A draft older than
 *    `DRAFT_TTL_HOURS` is deleted on the next load, and the interface states
 *    that lifetime before consent is given.
 *  - **Media bytes are never written to device storage.** Only the reference
 *    to an upload that the server has already accepted, which is not evidence
 *    content and is useless without the session.
 *  - **Sign-out clears drafts**, matching the server clearing the session.
 *
 * Pure apart from an injected key-value store, so the policy is testable
 * without a browser.
 */

import { initialUploadState, type UploadState } from "./upload.ts";
import type { LocationReading } from "./location.ts";

/** The subset of `Storage` used, so tests can pass a Map-backed stand-in. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DRAFT_TTL_HOURS = 24;
const DRAFT_KEY = "vision.draft.v1";
const CONSENT_KEY = "vision.draft-consent.v1";

export type DraftConsent = "granted" | "declined" | "unasked";

/**
 * A draft as stored. `photoReference` is present only for an upload the
 * server has already accepted; anything unfinished is dropped on save,
 * because restoring it would show an attached photo that does not exist.
 */
export type StoredDraft = {
  readonly savedAtMs: number;
  readonly idempotencyKey: string;
  readonly interfaceLocale: string;
  readonly text: string;
  readonly location?: LocationReading;
  readonly photoReference?: string;
  readonly voiceReference?: string;
};

export type DraftInput = {
  readonly idempotencyKey: string;
  readonly interfaceLocale: string;
  readonly text: string;
  readonly location?: LocationReading;
  readonly photo: UploadState;
  readonly voice?: UploadState;
};

const isExpired = (draft: StoredDraft, nowMs: number): boolean =>
  nowMs - draft.savedAtMs >= DRAFT_TTL_HOURS * 60 * 60 * 1000;

/** Only an accepted upload has a reference worth keeping. */
const acceptedReference = (state: UploadState | undefined): string | undefined =>
  state !== undefined && state.phase === "accepted" ? state.objectReference : undefined;

export class DraftStore {
  private readonly store: KeyValueStore;

  constructor(store: KeyValueStore) {
    this.store = store;
  }

  consent(): DraftConsent {
    const raw = this.store.getItem(CONSENT_KEY);
    return raw === "granted" || raw === "declined" ? raw : "unasked";
  }

  /** Declining also deletes anything stored under an earlier grant. */
  recordConsent(decision: "granted" | "declined"): void {
    this.store.setItem(CONSENT_KEY, decision);
    if (decision === "declined") this.store.removeItem(DRAFT_KEY);
  }

  /** Returns whether anything was written, so the interface can be honest. */
  save(input: DraftInput, nowMs: number): boolean {
    if (this.consent() !== "granted") return false;

    const photoReference = acceptedReference(input.photo);
    const voiceReference = acceptedReference(input.voice);
    const draft: StoredDraft = {
      savedAtMs: nowMs,
      idempotencyKey: input.idempotencyKey,
      interfaceLocale: input.interfaceLocale,
      text: input.text,
      ...(input.location === undefined ? {} : { location: input.location }),
      ...(photoReference === undefined ? {} : { photoReference }),
      ...(voiceReference === undefined ? {} : { voiceReference }),
    };

    try {
      this.store.setItem(DRAFT_KEY, JSON.stringify(draft));
      return true;
    } catch {
      // A full or blocked storage quota is not a reason to lose the report in
      // progress: the in-memory form is still authoritative.
      return false;
    }
  }

  /**
   * Loads a draft, deleting it if it has expired or cannot be parsed.
   *
   * Returning `undefined` for unreadable data is deliberate: a corrupted or
   * hand-edited draft must not become form state.
   */
  load(nowMs: number): StoredDraft | undefined {
    if (this.consent() !== "granted") {
      // Storage may still hold a draft from before consent was withdrawn.
      this.store.removeItem(DRAFT_KEY);
      return undefined;
    }

    const raw = this.store.getItem(DRAFT_KEY);
    if (raw === null) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.store.removeItem(DRAFT_KEY);
      return undefined;
    }

    const draft = asStoredDraft(parsed);
    if (draft === undefined) {
      this.store.removeItem(DRAFT_KEY);
      return undefined;
    }
    if (isExpired(draft, nowMs)) {
      this.store.removeItem(DRAFT_KEY);
      return undefined;
    }
    return draft;
  }

  clear(): void {
    this.store.removeItem(DRAFT_KEY);
  }

  /** Sign-out: the draft and the consent decision both go. */
  clearAll(): void {
    this.store.removeItem(DRAFT_KEY);
    this.store.removeItem(CONSENT_KEY);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Validates untrusted storage content rather than trusting its shape. */
export const asStoredDraft = (value: unknown): StoredDraft | undefined => {
  if (!isRecord(value)) return undefined;
  const savedAtMs = value["savedAtMs"];
  const idempotencyKey = value["idempotencyKey"];
  const interfaceLocale = value["interfaceLocale"];
  const text = value["text"];
  if (typeof savedAtMs !== "number" || !Number.isFinite(savedAtMs)) return undefined;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) return undefined;
  if (typeof interfaceLocale !== "string" || interfaceLocale.length === 0) return undefined;
  if (typeof text !== "string") return undefined;

  const location = asLocationReading(value["location"]);
  const photoReference =
    typeof value["photoReference"] === "string" ? value["photoReference"] : undefined;
  const voiceReference =
    typeof value["voiceReference"] === "string" ? value["voiceReference"] : undefined;

  return {
    savedAtMs,
    idempotencyKey,
    interfaceLocale,
    text,
    ...(location === undefined ? {} : { location }),
    ...(photoReference === undefined ? {} : { photoReference }),
    ...(voiceReference === undefined ? {} : { voiceReference }),
  };
};

const asLocationReading = (value: unknown): LocationReading | undefined => {
  if (!isRecord(value)) return undefined;
  const lat = value["lat"];
  const lon = value["lon"];
  const source = value["source"];
  const observedAt = value["observedAt"];
  if (typeof lat !== "number" || typeof lon !== "number") return undefined;
  if (source !== "device_geolocation" && source !== "manual_pin") return undefined;
  if (typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))) return undefined;
  const accuracy = value["accuracyMetres"];

  return {
    lat,
    lon,
    source,
    observedAt,
    ...(typeof accuracy === "number" && Number.isFinite(accuracy)
      ? { accuracyMetres: accuracy }
      : {}),
  };
};

/**
 * Turns a stored draft back into form state.
 *
 * The photo comes back as an **accepted** upload only when the server had
 * already accepted it. Bytes are never stored, so an upload that was still in
 * progress cannot be resumed from a restored draft — the citizen is asked to
 * choose the photo again rather than being shown a photo that is not there.
 */
export const restoreFormState = (
  draft: StoredDraft,
): {
  readonly text: string;
  readonly location: LocationReading | undefined;
  readonly photo: UploadState;
  readonly voice: UploadState | undefined;
  readonly idempotencyKey: string;
  readonly interfaceLocale: string;
} => ({
  text: draft.text,
  location: draft.location,
  photo:
    draft.photoReference === undefined
      ? initialUploadState
      : { phase: "accepted", percent: 100, attempts: 0, objectReference: draft.photoReference },
  voice:
    draft.voiceReference === undefined
      ? undefined
      : { phase: "accepted", percent: 100, attempts: 0, objectReference: draft.voiceReference },
  idempotencyKey: draft.idempotencyKey,
  interfaceLocale: draft.interfaceLocale,
});
