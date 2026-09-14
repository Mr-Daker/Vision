/**
 * Building and guarding the submission request (roadmap V019/V020).
 *
 * Two rules from the roadmap live here:
 *
 *  1. **A retry must not create a second report.** One idempotency key is
 *     minted per attempt-at-a-report and reused for every retry of it
 *     ([V018](../../../docs/foundation/V018-submission-acceptance-and-receipt.md) §2),
 *     including a retry after the connection came back.
 *  2. **A double tap is not two reports.** The guard is time-based and does
 *     not rely on a disabled attribute, because a disabled button is a
 *     rendering detail and a second tap can arrive before a repaint.
 *
 * Pure: no fetch, no DOM.
 */

import type { StringKey } from "./locales/strings.ts";
import { blocksSubmission, isAttachable, type UploadState } from "./upload.ts";
import type { LocationReading } from "./location.ts";

export const MAX_TEXT_LENGTH = 500;

export type DescriptionDraft = {
  readonly text: string;
  /** A finalized voice recording, if one was made. */
  readonly voice?: UploadState;
};

export type CaptureForm = {
  readonly location?: LocationReading;
  readonly photo: UploadState;
  readonly description: DescriptionDraft;
  readonly interfaceLocale: string;
  /** Minted when the citizen starts a report, reused across every retry. */
  readonly idempotencyKey: string;
};

export type SubmissionRequestBody = {
  readonly observed: {
    readonly lat: number;
    readonly lon: number;
    readonly accuracy_m: number | null;
    readonly source: LocationReading["source"];
    readonly observed_at: string;
  };
  readonly interface_locale: string;
  readonly text?: string;
  readonly evidence: readonly {
    readonly object_reference: string;
    readonly media_type: "photo" | "voice";
  }[];
};

export type FormBlock = { readonly field: string; readonly errorKey: StringKey };

/**
 * What still stops this report being sent.
 *
 * A location is required, and so is *something observable* — a description, a
 * photo or a recording. That second rule is the server's
 * (`no_observation`, [V018](../../../docs/foundation/V018-submission-acceptance-and-receipt.md)),
 * mirrored here so the citizen is told before they send rather than meeting it
 * as a rejected request. Which of the three they provide is up to them.
 *
 * There is deliberately **no category, department or severity** to complete:
 * that is decided after review, and asking a citizen to classify
 * infrastructure is how reports get mis-routed and then blamed on the reporter.
 */
export const findBlocks = (form: CaptureForm): readonly FormBlock[] => {
  const blocks: FormBlock[] = [];
  if (form.location === undefined) {
    blocks.push({ field: "location", errorKey: "error.validation" });
  }

  const hasText = form.description.text.trim().length > 0;
  const hasPhoto = isAttachable(form.photo);
  const hasVoice = form.description.voice !== undefined && isAttachable(form.description.voice);
  if (!hasText && !hasPhoto && !hasVoice) {
    blocks.push({ field: "observation", errorKey: "error.no_observation" });
  }
  if (blocksSubmission(form.photo)) {
    blocks.push({ field: "photo", errorKey: "error.upload_incomplete" });
  }
  if (form.description.voice !== undefined && blocksSubmission(form.description.voice)) {
    blocks.push({ field: "voice", errorKey: "error.upload_incomplete" });
  }
  if (form.description.text.length > MAX_TEXT_LENGTH) {
    blocks.push({ field: "text", errorKey: "error.validation" });
  }
  return blocks;
};

export const canSubmit = (form: CaptureForm): boolean => findBlocks(form).length === 0;

/** Serialises the form for `POST /v1/submissions`. */
export const buildRequestBody = (form: CaptureForm): SubmissionRequestBody => {
  const location = form.location;
  if (location === undefined) {
    throw new Error("buildRequestBody requires a location; call canSubmit first");
  }

  const evidence: { object_reference: string; media_type: "photo" | "voice" }[] = [];
  if (isAttachable(form.photo) && form.photo.objectReference !== undefined) {
    evidence.push({ object_reference: form.photo.objectReference, media_type: "photo" });
  }
  const voice = form.description.voice;
  if (voice !== undefined && isAttachable(voice) && voice.objectReference !== undefined) {
    evidence.push({ object_reference: voice.objectReference, media_type: "voice" });
  }

  const text = form.description.text.trim();
  return {
    observed: {
      lat: location.lat,
      lon: location.lon,
      // Null, never a stand-in number: a made-up accuracy is a fabricated
      // measurement, and a manual pin has none to report. The server keeps a
      // null out of the row rather than storing 0 (V018 §3).
      accuracy_m:
        location.source === "device_geolocation" ? (location.accuracyMetres ?? null) : null,
      source: location.source,
      observed_at: location.observedAt,
    },
    interface_locale: form.interfaceLocale,
    ...(text.length > 0 ? { text } : {}),
    evidence,
  };
};

/**
 * Duplicate-tap and in-flight guard.
 *
 * `begin` returns false while a send is in flight or within the cooldown of
 * the last one, so the second of two fast taps is refused by state rather
 * than by hoping the button was already disabled.
 */
export const DUPLICATE_TAP_COOLDOWN_MS = 1500;

export class SubmitGuard {
  private inFlight = false;
  private lastAcceptedAtMs = Number.NEGATIVE_INFINITY;
  private readonly cooldownMs: number;

  constructor(cooldownMs: number = DUPLICATE_TAP_COOLDOWN_MS) {
    this.cooldownMs = cooldownMs;
  }

  get busy(): boolean {
    return this.inFlight;
  }

  begin(nowMs: number): boolean {
    if (this.inFlight) return false;
    if (nowMs - this.lastAcceptedAtMs < this.cooldownMs) return false;
    this.inFlight = true;
    this.lastAcceptedAtMs = nowMs;
    return true;
  }

  /** Call in a `finally`: an attempt that threw must not wedge the button. */
  end(): void {
    this.inFlight = false;
  }
}

/**
 * A fresh idempotency key for a new report.
 *
 * Deliberately **not** derived from the form contents: two genuinely separate
 * reports about the same pothole from the same place must both be accepted,
 * and a content hash would silently merge them.
 */
export const newIdempotencyKey = (): string => `web-${crypto.randomUUID()}`;
