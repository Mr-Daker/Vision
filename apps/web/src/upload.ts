/**
 * Upload state machine and client-side file checks (roadmap V019/V020).
 *
 * A three-call upload ([V016](../../../docs/foundation/V016-private-object-storage-uploads.md)):
 * grant, then bytes, then finalize. Only a *finalized* object may be attached
 * to a submission, so the interface must never present a half-finished upload
 * as attached evidence — that is the whole point of modelling this as states
 * rather than a boolean.
 *
 * Pure: no XHR, no DOM. The browser layer feeds it events.
 */

import type { StringKey } from "./locales/strings.ts";

/** Mirrors the server's permitted set; the server re-checks the magic bytes. */
export const ACCEPTED_IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png"];
export const ACCEPTED_AUDIO_TYPES: readonly string[] = ["audio/webm", "audio/ogg"];

/** Kept at the server's ceiling so a rejection is explained before the upload. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export type UploadPhase =
  | "idle"
  | "selected"
  | "granting"
  | "sending"
  | "finalizing"
  /** Finalized by the server. Only now is it attachable evidence. */
  | "accepted"
  | "failed";

export type UploadState = {
  readonly phase: UploadPhase;
  readonly fileName?: string;
  readonly byteSize?: number;
  readonly contentType?: string;
  /** 0–100, only meaningful while `sending`. */
  readonly percent: number;
  /** Present once granted, so a retry resumes the same object (V020). */
  readonly objectReference?: string;
  readonly uploadUrl?: string;
  readonly errorKey?: StringKey;
  /** How many times the citizen has explicitly retried. */
  readonly attempts: number;
};

export const initialUploadState: UploadState = { phase: "idle", percent: 0, attempts: 0 };

export type UploadEvent =
  | {
      readonly kind: "select";
      readonly fileName: string;
      readonly byteSize: number;
      readonly contentType: string;
    }
  | { readonly kind: "grant_requested" }
  | { readonly kind: "granted"; readonly objectReference: string; readonly uploadUrl: string }
  | { readonly kind: "progress"; readonly percent: number }
  | { readonly kind: "sent" }
  | { readonly kind: "accepted" }
  | { readonly kind: "failed"; readonly errorKey: StringKey }
  | { readonly kind: "retry" }
  | { readonly kind: "remove" };

export type FileRejection = {
  readonly errorKey: StringKey;
  readonly params: Readonly<Record<string, number>>;
};

/** Client-side pre-checks. Advisory: the server validates the bytes again. */
export const checkFile = (
  file: { readonly type: string; readonly size: number },
  accepted: readonly string[] = ACCEPTED_IMAGE_TYPES,
): FileRejection | undefined => {
  if (!accepted.includes(file.type)) {
    return { errorKey: "photo.wrong_type", params: {} };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { errorKey: "photo.too_large", params: { megabytes: MAX_UPLOAD_BYTES / (1024 * 1024) } };
  }
  return undefined;
};

const withoutError = (state: UploadState): UploadState => {
  const { errorKey: _dropped, ...rest } = state;
  return rest;
};

/**
 * The transition table.
 *
 * A `retry` keeps `objectReference`, so retrying re-sends bytes to the object
 * already granted instead of leaking a fresh grant on every attempt. An
 * unexpected event for the current phase is ignored rather than throwing: a
 * late progress callback from a cancelled request must not break the form.
 */
export const nextUploadState = (state: UploadState, event: UploadEvent): UploadState => {
  switch (event.kind) {
    case "select":
      return {
        phase: "selected",
        fileName: event.fileName,
        byteSize: event.byteSize,
        contentType: event.contentType,
        percent: 0,
        attempts: 0,
      };

    case "grant_requested":
      return state.phase === "selected" || state.phase === "failed"
        ? withoutError({ ...state, phase: "granting", percent: 0 })
        : state;

    case "granted":
      return state.phase === "granting"
        ? {
            ...state,
            phase: "sending",
            objectReference: event.objectReference,
            uploadUrl: event.uploadUrl,
            percent: 0,
          }
        : state;

    case "progress":
      if (state.phase !== "sending") return state;
      return { ...state, percent: Math.max(0, Math.min(100, Math.round(event.percent))) };

    case "sent":
      return state.phase === "sending" ? { ...state, phase: "finalizing", percent: 100 } : state;

    case "accepted":
      return state.phase === "finalizing" ? { ...state, phase: "accepted", percent: 100 } : state;

    case "failed":
      // Terminal states are not reopened by a stray failure callback.
      return state.phase === "accepted" || state.phase === "idle"
        ? state
        : { ...state, phase: "failed", errorKey: event.errorKey };

    case "retry":
      return state.phase === "failed"
        ? withoutError({ ...state, phase: "granting", percent: 0, attempts: state.attempts + 1 })
        : state;

    case "remove":
      return initialUploadState;
  }
};

/** True only for a server-finalized object. Anything else is not evidence. */
export const isAttachable = (state: UploadState): boolean =>
  state.phase === "accepted" && state.objectReference !== undefined;

/** True while work is in flight, so the interface can disable the send button. */
export const isUploadBusy = (state: UploadState): boolean =>
  state.phase === "granting" || state.phase === "sending" || state.phase === "finalizing";

/**
 * A selected-but-unsent upload blocks submission, because sending now would
 * silently drop the photo the citizen believes they attached.
 */
export const blocksSubmission = (state: UploadState): boolean =>
  isUploadBusy(state) || state.phase === "selected" || state.phase === "failed";
