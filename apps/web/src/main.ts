/**
 * The citizen capture and submission interface (roadmap V019, V020).
 *
 * This is the only file in the web app that touches the DOM. Everything it
 * decides — locale choice, the captured-versus-claimed location distinction,
 * upload phases, what blocks submission, draft policy — lives in the pure
 * modules beside it and is unit-tested there.
 *
 * Interface rules held here:
 *  - Nothing is announced that is not true: an upload is "uploaded" only after
 *    the server finalizes it, and a failed send says nothing was saved.
 *  - Every state change that matters is announced to a screen reader through a
 *    live region, and focus is moved deliberately when a panel replaces
 *    another.
 *  - No category, department or severity is ever asked for.
 */

import { ApiClient, type CapabilityMetadata, type Receipt } from "./api.ts";
import { DRAFT_TTL_HOURS, DraftStore, restoreFormState } from "./drafts.ts";
import { renderEvidenceRail, type PipelineStage } from "./evidence-rail.ts";
import {
  toReportRows,
  toDiscoveryView,
  toDetailView,
  toResolutionView,
  type ResolutionPayload,
  type ResolutionView,
  toCategoryOptions,
  toCandidateView,
  toDiscoveryMapView,
  toReceiptLookupView,
  normalizeReceiptReference,
  type ReportPayload,
  type ReportRow,
  type DiscoveryRow,
  type DiscoveryPayload,
  type DiscoveryView,
  type DetailPayload,
  type DetailView,
  type TaxonomyPayload,
  type CandidatePayload,
} from "./tracking.ts";
import {
  createTranslator,
  resolveLocale,
  resolvePreferredLocale,
  type Translator,
} from "./i18n.ts";
import { enIN } from "./locales/en-IN.ts";
import { mrIN } from "./locales/mr-IN.ts";
import type { LocalePack, StringKey } from "./locales/strings.ts";
import {
  describeLocation,
  geolocationErrorKey,
  isLocationStale,
  readingAgeMinutes,
  validateCoordinates,
  type LocationReading,
} from "./location.ts";
import {
  ACCEPTED_AUDIO_TYPES,
  MAX_UPLOAD_BYTES,
  checkFile,
  initialUploadState,
  nextUploadState,
  type UploadState,
} from "./upload.ts";
import {
  MAX_TEXT_LENGTH,
  SubmitGuard,
  buildRequestBody,
  findBlocks,
  newIdempotencyKey,
  type CaptureForm,
} from "./submission.ts";
import { buildDemoIdentityViewModel, type DemoIdentityMetadata } from "./identity-ui.ts";

/** The locale catalogue. Adding a language is a change to this list only. */
const CATALOGUE = { packs: [enIN, mrIN] as readonly LocalePack[], fallbackCode: enIN.code };

const MEGABYTE = 1024 * 1024;
const DRAFT_SAVE_DEBOUNCE_MS = 700;

const api = new ApiClient();
const drafts = new DraftStore(window.localStorage);
const guard = new SubmitGuard();

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element: ${id}`);
  return node as T;
};

type AppState = {
  translator: Translator;
  location: LocationReading | undefined;
  photo: UploadState;
  voice: UploadState | undefined;
  idempotencyKey: string;
  signedIn: boolean;
  identityLabel: string;
  recording: MediaRecorder | undefined;
  recordingStartedAtMs: number;
  /* Evidence rail. These exist so the rail can distinguish "nothing yet" from
     "working on it" — its processing state is driven by real outstanding work,
     never by a timer imitating computation. */
  locating: boolean;
  nearbyCount: number | undefined;
  nearbyLoading: boolean;
  stage: PipelineStage;
};

const state: AppState = {
  translator: createTranslator(resolvePreferredLocale([...navigator.languages], CATALOGUE)),
  location: undefined,
  photo: initialUploadState,
  voice: undefined,
  idempotencyKey: newIdempotencyKey(),
  signedIn: false,
  identityLabel: "",
  recording: undefined,
  recordingStartedAtMs: 0,
  locating: false,
  nearbyCount: undefined,
  nearbyLoading: false,
  stage: "captured",
};

const t = (key: StringKey, params?: Readonly<Record<string, string | number>>): string =>
  state.translator.t(key, params);

// ---------------------------------------------------------------------------
// Announcements and errors
// ---------------------------------------------------------------------------

/** Speaks a message through the polite live region. */
const announce = (message: string): void => {
  const region = el("live-status");
  // Re-setting identical text does not always re-announce, so clear first.
  region.textContent = "";
  window.setTimeout(() => {
    region.textContent = message;
  }, 50);
};

/**
 * Shows what went wrong.
 *
 * A single message stands on its own. The "fix the highlighted fields"
 * heading appears only above a list, because putting it above "you appear to
 * be offline" told the citizen to correct a field when nothing was wrong with
 * what they typed.
 */
const showErrors = (messages: readonly string[]): void => {
  const summary = el("error-summary");
  summary.replaceChildren();
  if (messages.length === 0) {
    summary.hidden = true;
    return;
  }

  if (messages.length === 1) {
    const only = document.createElement("p");
    only.textContent = messages[0] ?? "";
    summary.append(only);
  } else {
    const heading = document.createElement("p");
    heading.textContent = t("error.validation");
    const list = document.createElement("ul");
    for (const message of messages) {
      const item = document.createElement("li");
      item.textContent = message;
      list.append(item);
    }
    summary.append(heading, list);
  }

  summary.hidden = false;
  summary.focus();
};

const clearErrors = (): void => showErrors([]);

const fieldError = (id: string, message: string | undefined, input?: HTMLElement): void => {
  const node = el(id);
  node.textContent = message ?? "";
  node.hidden = message === undefined;
  if (input !== undefined) {
    if (message === undefined) input.removeAttribute("aria-invalid");
    else input.setAttribute("aria-invalid", "true");
  }
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const applyStaticText = (): void => {
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset["i18n"] as StringKey | undefined;
    if (key === undefined) continue;
    node.textContent = t(key);
  }

  document.documentElement.lang = state.translator.pack.code;
  document.documentElement.dir = state.translator.pack.direction;

  el("photo-hint").textContent = t("photo.hint", { megabytes: MAX_UPLOAD_BYTES / MEGABYTE });
  el("description-hint").textContent = t("describe.text_hint", { max: MAX_TEXT_LENGTH });
  el("consent-explain").textContent = t("draft.consent_explain", { hours: 24 });
  el("receipt-saved-note").textContent = t("receipt.saved_note");
  el("receipt-caveat").textContent = t("receipt.not_a_promise");
  el("footer-disclosure").textContent = t("receipt.not_a_promise");

  const notice = el("translation-notice");
  notice.hidden = !state.translator.disclosesTranslationStatus;
  if (state.translator.disclosesTranslationStatus) {
    notice.textContent = t("app.translation_pending");
  }
};

const renderLanguageSelect = (): void => {
  const select = el<HTMLSelectElement>("language-select");
  select.replaceChildren();
  for (const pack of CATALOGUE.packs) {
    const option = document.createElement("option");
    option.value = pack.code;
    option.textContent = pack.endonym;
    option.selected = pack.code === state.translator.pack.code;
    select.append(option);
  }
};

const renderLocation = (): void => {
  const result = el("location-result");
  const reading = state.location;
  if (reading === undefined) {
    result.hidden = true;
    return;
  }

  const disclosure = describeLocation(reading);
  result.hidden = false;
  result.dataset["locationSource"] = reading.source;
  el("location-result-heading").textContent = t(disclosure.headingKey);
  el("location-result-note").textContent = t(disclosure.noteKey);
  el("location-accuracy").textContent = t(disclosure.accuracyKey, disclosure.accuracyParams);
  el("location-captured-at").textContent = t("location.captured_at", {
    time: new Date(reading.observedAt).toLocaleString(state.translator.pack.code),
  });
  el("location-coordinates").textContent = `${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)}`;

  // Only a device reading is offered for re-capture; a typed position is not
  // a measurement that goes out of date.
  el("refresh-location").hidden = !disclosure.isDeviceEvidence;

  const stale = el("location-stale");
  const isStale = isLocationStale(reading, Date.now());
  stale.hidden = !isStale;
  if (isStale) {
    stale.textContent = t("location.stale_prompt", {
      minutes: readingAgeMinutes(reading, Date.now()),
    });
  }
};

const renderUpload = (
  which: "photo" | "voice",
  upload: UploadState | undefined,
  ids: {
    readonly state: string;
    readonly progress: string;
    readonly retry?: string;
    readonly remove?: string;
  },
): void => {
  const line = el(ids.state);
  const progress = el<HTMLProgressElement>(ids.progress);
  const upl = upload ?? initialUploadState;

  const retry = ids.retry === undefined ? undefined : el(ids.retry);
  const remove = ids.remove === undefined ? undefined : el(ids.remove);
  if (retry !== undefined) retry.hidden = upl.phase !== "failed";
  if (remove !== undefined) remove.hidden = upl.phase === "idle";

  progress.hidden = upl.phase !== "sending";
  progress.value = upl.percent;

  switch (upl.phase) {
    case "idle":
      line.textContent = "";
      break;
    case "selected":
      line.textContent =
        which === "photo"
          ? t("photo.selected", {
              name: upl.fileName ?? "",
              kilobytes: Math.ceil((upl.byteSize ?? 0) / 1024),
            })
          : t("describe.voice_recorded", { seconds: Math.round((upl.byteSize ?? 0) / 16000) });
      break;
    case "granting":
    case "sending":
    case "finalizing":
      line.textContent = t("photo.uploading", { percent: upl.percent });
      break;
    case "accepted":
      // Only now is the object accepted evidence on the server.
      line.textContent =
        which === "photo"
          ? t("photo.uploaded")
          : t("describe.voice_recorded", {
              seconds: Math.round((upl.byteSize ?? 0) / 16000),
            });
      break;
    case "failed":
      line.textContent = upl.errorKey === undefined ? t("photo.failed") : t(upl.errorKey);
      break;
  }
};

const renderReview = (): void => {
  const list = el("review-list");
  list.replaceChildren();

  const rows: readonly (readonly [string, string])[] = [
    [
      t("review.location"),
      state.location === undefined
        ? t("review.none")
        : `${t(describeLocation(state.location).headingKey)} — ${state.location.lat.toFixed(5)}, ${state.location.lon.toFixed(5)}`,
    ],
    [t("review.photo"), state.photo.phase === "accepted" ? t("photo.uploaded") : t("review.none")],
    [
      t("review.description"),
      el<HTMLTextAreaElement>("description").value.trim().length > 0
        ? el<HTMLTextAreaElement>("description").value.trim()
        : state.voice?.phase === "accepted"
          ? t("describe.voice_heading")
          : t("review.none"),
    ],
  ];

  for (const [term, description] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = description;
    list.append(dt, dd);
  }
};

const currentForm = (): CaptureForm => ({
  ...(state.location === undefined ? {} : { location: state.location }),
  photo: state.photo,
  description: {
    text: el<HTMLTextAreaElement>("description").value,
    ...(state.voice === undefined ? {} : { voice: state.voice }),
  },
  interfaceLocale: state.translator.pack.code,
  idempotencyKey: state.idempotencyKey,
});

const renderSubmitAvailability = (): void => {
  const button = el<HTMLButtonElement>("submit-report");
  const blocks = findBlocks(currentForm());
  // Disabled only for reasons the interface has already explained, so the
  // control is never mysteriously dead.
  button.disabled = blocks.length > 0 || guard.busy;
  button.setAttribute("aria-disabled", String(button.disabled));
};

const renderAll = (): void => {
  applyStaticText();
  renderLanguageSelect();
  renderLocation();
  renderUpload("photo", state.photo, {
    state: "photo-state",
    progress: "photo-progress",
    retry: "photo-retry",
    remove: "photo-remove",
  });
  renderUpload("voice", state.voice, { state: "voice-state", progress: "voice-progress" });
  renderReview();
  renderRemaining();
  renderSubmitAvailability();
  renderRail();
};

/* The rail reads the file straight off the input rather than from `state`,
   because that is where it lives — a draft restored from storage has the name
   and size but no bytes, and the rail shows the readout without a preview in
   that case rather than a broken image. */
const renderRail = (): void => {
  const input = document.getElementById("photo-input");
  const file = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
  renderEvidenceRail(
    {
      location: state.location,
      locating: state.locating,
      photo: state.photo,
      photoFile: file,
      nearbyCount: state.nearbyCount,
      nearbyLoading: state.nearbyLoading,
      nearbyMarkers: [],
      stage: state.stage,
    },
    t,
    state.translator.pack.code,
  );
};

const renderRemaining = (): void => {
  const textarea = el<HTMLTextAreaElement>("description");
  el("description-remaining").textContent = t("describe.remaining", {
    remaining: MAX_TEXT_LENGTH - textarea.value.length,
  });
};

// ---------------------------------------------------------------------------
// Drafts (V020)
// ---------------------------------------------------------------------------

let draftTimer: number | undefined;

const saveDraftSoon = (): void => {
  if (drafts.consent() !== "granted") return;
  if (draftTimer !== undefined) window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    const saved = drafts.save(
      {
        idempotencyKey: state.idempotencyKey,
        interfaceLocale: state.translator.pack.code,
        text: el<HTMLTextAreaElement>("description").value,
        ...(state.location === undefined ? {} : { location: state.location }),
        photo: state.photo,
        ...(state.voice === undefined ? {} : { voice: state.voice }),
      },
      Date.now(),
    );
    el("draft-state").textContent = saved
      ? t("draft.saved", { time: new Date().toLocaleTimeString(state.translator.pack.code) })
      : "";
    // The disclosed lifetime sits beside the draft itself, not only in the
    // consent text the citizen read once.
    el("draft-expiry").textContent = t("draft.expires", { hours: DRAFT_TTL_HOURS });
    el("draft-expiry").hidden = !saved;
    el("discard-draft").hidden = !saved;
  }, DRAFT_SAVE_DEBOUNCE_MS);
};

/** Removes the device draft on request, leaving the form as it is on screen. */
const discardDraft = (): void => {
  drafts.clear();
  el("draft-state").textContent = "";
  el("draft-expiry").hidden = true;
  el("discard-draft").hidden = true;
  el("draft-restored").hidden = true;
  announce(t("draft.discard"));
};

const restoreDraft = (): void => {
  const draft = drafts.load(Date.now());
  if (draft === undefined) return;

  const restored = restoreFormState(draft);
  state.location = restored.location;
  state.photo = restored.photo;
  state.voice = restored.voice;
  state.idempotencyKey = restored.idempotencyKey;
  // The draft records which language the citizen was working in, so restoring
  // it in a different language would be a worse restoration than none.
  state.translator = createTranslator(resolveLocale(restored.interfaceLocale, CATALOGUE));
  el<HTMLTextAreaElement>("description").value = restored.text;

  const notice = el("draft-restored");
  notice.textContent = t("draft.restored");
  notice.hidden = false;
  announce(t("draft.restored"));
};

// ---------------------------------------------------------------------------
// Location capture
// ---------------------------------------------------------------------------

const captureLocation = (): void => {
  fieldError("location-error", undefined);

  if (!("geolocation" in navigator)) {
    fieldError("location-error", t("location.unsupported"));
    revealManualEntry();
    return;
  }

  const button = el<HTMLButtonElement>("use-location");
  button.disabled = true;
  state.locating = true;
  renderAll();
  announce(t("location.locating"));

  navigator.geolocation.getCurrentPosition(
    (position) => {
      button.disabled = false;
      state.locating = false;
      const accuracy = position.coords.accuracy;
      state.location = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        ...(Number.isFinite(accuracy) ? { accuracyMetres: accuracy } : {}),
        source: "device_geolocation",
        observedAt: new Date(position.timestamp).toISOString(),
      };
      renderAll();
      announce(t("location.captured_heading"));
      saveDraftSoon();
    },
    (error) => {
      button.disabled = false;
      state.locating = false;
      const key = geolocationErrorKey(error.code);
      renderAll();
      fieldError("location-error", t(key));
      announce(t(key));
      // A denied permission is a dead end unless the manual path is offered.
      revealManualEntry();
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
  );
};

const revealManualEntry = (): void => {
  const fields = el("manual-fields");
  const toggle = el("toggle-manual");
  fields.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  el<HTMLInputElement>("manual-lat").focus();
};

const applyManualLocation = (): void => {
  const latInput = el<HTMLInputElement>("manual-lat");
  const lonInput = el<HTMLInputElement>("manual-lon");
  const lat = Number(latInput.value.trim());
  const lon = Number(lonInput.value.trim());

  const issues = validateCoordinates(lat, lon);
  fieldError(
    "manual-lat-error",
    issues.some((issue) => issue.field === "lat") ? t("location.latitude") : undefined,
    latInput,
  );
  fieldError(
    "manual-lon-error",
    issues.some((issue) => issue.field === "lon") ? t("location.longitude") : undefined,
    lonInput,
  );
  if (issues.length > 0) {
    announce(t("error.validation"));
    return;
  }

  state.location = {
    lat,
    lon,
    // No accuracy: a typed position has no device measurement (V018 §3).
    source: "manual_pin",
    observedAt: new Date().toISOString(),
  };
  renderAll();
  announce(t("location.manual_heading"));
  saveDraftSoon();
};

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

const setUpload = (which: "photo" | "voice", next: UploadState): void => {
  if (which === "photo") state.photo = next;
  else state.voice = next;
  renderAll();
};

const uploadOf = (which: "photo" | "voice"): UploadState =>
  which === "photo" ? state.photo : (state.voice ?? initialUploadState);

/**
 * Runs grant → bytes → finalize.
 *
 * A failure at any step leaves the upload in `failed` with an explanation and
 * an explicit retry; it never silently becomes "attached". The granted object
 * reference is kept so a retry reuses it (V020).
 */
const runUpload = async (which: "photo" | "voice", blob: Blob): Promise<void> => {
  setUpload(which, nextUploadState(uploadOf(which), { kind: "grant_requested" }));

  const existing = uploadOf(which).objectReference;
  let grant = existing === undefined ? undefined : uploadOf(which).uploadUrl;
  let objectReference = existing;

  if (objectReference === undefined || grant === undefined) {
    const granted = await api.requestUploadGrant(blob.type, blob.size);
    if (!granted.ok) {
      setUpload(
        which,
        nextUploadState(uploadOf(which), {
          kind: "failed",
          errorKey: granted.offline ? "error.offline" : "photo.failed",
        }),
      );
      announce(t(granted.offline ? "error.offline" : "photo.failed"));
      return;
    }
    objectReference = granted.value.object_reference;
    grant = granted.value.upload_url;
    setUpload(
      which,
      nextUploadState(uploadOf(which), {
        kind: "granted",
        objectReference,
        uploadUrl: grant,
      }),
    );
  } else {
    setUpload(
      which,
      nextUploadState(uploadOf(which), {
        kind: "granted",
        objectReference,
        uploadUrl: grant,
      }),
    );
  }

  const sent = await api.putBytes(
    { object_reference: objectReference, upload_url: grant, expires_at: "", max_bytes: blob.size },
    blob,
    (percent) => setUpload(which, nextUploadState(uploadOf(which), { kind: "progress", percent })),
  );
  if (!sent.ok) {
    setUpload(
      which,
      nextUploadState(uploadOf(which), {
        kind: "failed",
        errorKey: sent.offline ? "error.offline" : "photo.failed",
      }),
    );
    announce(t(sent.offline ? "error.offline" : "photo.failed"));
    return;
  }
  setUpload(which, nextUploadState(uploadOf(which), { kind: "sent" }));

  const finalized = await api.finalizeUpload(objectReference);
  if (!finalized.ok) {
    setUpload(
      which,
      nextUploadState(uploadOf(which), {
        kind: "failed",
        errorKey: finalized.offline ? "error.offline" : "photo.failed",
      }),
    );
    announce(t(finalized.offline ? "error.offline" : "photo.failed"));
    return;
  }

  setUpload(which, nextUploadState(uploadOf(which), { kind: "accepted" }));
  announce(t(which === "photo" ? "photo.uploaded" : "describe.voice_recorded", { seconds: 0 }));
  saveDraftSoon();
};

const onPhotoSelected = (): void => {
  const input = el<HTMLInputElement>("photo-input");
  const file = input.files?.[0];
  if (file === undefined) return;

  const rejection = checkFile({ type: file.type, size: file.size });
  if (rejection !== undefined) {
    setUpload("photo", initialUploadState);
    fieldError("photo-state", t(rejection.errorKey, rejection.params));
    announce(t(rejection.errorKey, rejection.params));
    input.value = "";
    return;
  }

  setUpload(
    "photo",
    nextUploadState(initialUploadState, {
      kind: "select",
      fileName: file.name,
      byteSize: file.size,
      contentType: file.type,
    }),
  );
  void runUpload("photo", file);
};

// ---------------------------------------------------------------------------
// Voice, with typing always available as the equivalent path
// ---------------------------------------------------------------------------

const supportsRecording = (): boolean =>
  typeof MediaRecorder !== "undefined" && navigator.mediaDevices !== undefined;

const toggleRecording = async (): Promise<void> => {
  const button = el<HTMLButtonElement>("voice-record");
  const label = button.querySelector("span");

  if (state.recording !== undefined) {
    state.recording.stop();
    return;
  }
  if (!supportsRecording()) {
    el("voice-state").textContent = t("describe.voice_unsupported");
    announce(t("describe.voice_unsupported"));
    return;
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    el("voice-state").textContent = t("describe.voice_permission_denied");
    announce(t("describe.voice_permission_denied"));
    return;
  }

  const mimeType = ACCEPTED_AUDIO_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mimeType === undefined ? {} : { mimeType });
  const chunks: Blob[] = [];

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    for (const track of stream.getTracks()) track.stop();
    state.recording = undefined;
    if (label !== null) label.textContent = t("describe.voice_record");

    const seconds = Math.max(1, Math.round((Date.now() - state.recordingStartedAtMs) / 1000));
    const blob = new Blob(chunks, { type: recorder.mimeType });
    setUpload(
      "voice",
      nextUploadState(initialUploadState, {
        kind: "select",
        fileName: `voice.${blob.type.includes("ogg") ? "ogg" : "webm"}`,
        byteSize: blob.size,
        contentType: blob.type,
      }),
    );
    el("voice-state").textContent = t("describe.voice_recorded", { seconds });
    void runUpload("voice", blob);
  });

  state.recording = recorder;
  state.recordingStartedAtMs = Date.now();
  recorder.start();
  if (label !== null) label.textContent = t("describe.voice_stop");
  announce(t("describe.voice_record"));
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const renderSignedIn = (label: string): void => {
  state.signedIn = true;
  state.identityLabel = label;
  el("login-panel").hidden = true;
  el("report-form").hidden = false;
  el("sign-out").hidden = false;
  const line = el("signed-in-as");
  line.textContent = t("login.signed_in_as", { label });
  line.hidden = false;
  // The standalone provider disclosure and this line render the same sentence
  // once somebody is signed in, and the same sentence twice reads as a defect
  // rather than as emphasis. This line says strictly more — it states the
  // session as well as the provider — so it is the one that stays.
  el("capability-label").hidden = true;
  renderAll();
};

const renderLoginPanel = (metadata: CapabilityMetadata): void => {
  // The view model refuses to render if a simulated provider is unlabelled,
  // so the interface cannot present a simulation as a real verification.
  const model = buildDemoIdentityViewModel(metadata as unknown as DemoIdentityMetadata);
  el("capability-label").textContent = model.providerLabel;
  el("capability-label").hidden = false;
  el("login-warning").textContent = model.warning;

  const choices = el("login-choices");
  choices.replaceChildren();
  for (const principal of model.availablePrincipals) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = t("login.choose", { label: principal.label });
    button.addEventListener("click", () => void signIn(principal.credential, principal.label));
    choices.append(button);
  }

  el("login-panel").hidden = false;
  el("report-form").hidden = true;
};

const signIn = async (credential: string, label: string): Promise<void> => {
  clearErrors();
  const result = await api.demoLogin(credential);
  if (!result.ok) {
    showErrors([result.offline ? t("error.offline") : result.message]);
    return;
  }
  renderSignedIn(label);
  // The first load ran before a session existed. Fetch again now so the
  // citizen does not have to reload the page to reach tracking or lookup.
  void loadMyReports();
  el<HTMLElement>("location-heading").scrollIntoView({ block: "nearest" });
  announce(t("login.signed_in_as", { label }));
};

const signOut = async (): Promise<void> => {
  await api.logout();
  // The server clears the session cookie; the client clears what it kept on
  // the device, because a shared phone must not leak the last person's draft.
  drafts.clearAll();
  window.location.reload();
};

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

const showReceipt = (receipt: Receipt): void => {
  el("report-form").hidden = true;
  el("receipt-panel").hidden = false;
  el("receipt-reference").textContent = receipt.submission_id;
  el("receipt-status").textContent = receipt.processing_status;
  el("receipt-received-at").textContent = new Date(receipt.server_received_at).toLocaleString(
    state.translator.pack.code,
  );

  const replayed = el("receipt-replayed");
  replayed.hidden = !receipt.replayed;
  if (receipt.replayed) replayed.textContent = t("receipt.replayed");

  // The draft is only cleared once the server has confirmed the report is
  // saved. Clearing it on send would lose the report if the send failed.
  drafts.clear();
  el("draft-state").textContent = "";
  el("draft-expiry").hidden = true;
  el("discard-draft").hidden = true;

  const heading = el("receipt-heading");
  heading.focus();
  announce(`${t("receipt.heading")}. ${t("receipt.not_a_promise")}`);
};

const submitReport = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault();
  clearErrors();

  if (!guard.begin(Date.now())) {
    announce(t("error.duplicate_tap"));
    return;
  }

  const button = el<HTMLButtonElement>("submit-report");
  const buttonLabel = button.querySelector("span");
  const form = currentForm();

  try {
    const blocks = findBlocks(form);
    if (blocks.length > 0) {
      showErrors(blocks.map((block) => t(block.errorKey)));
      return;
    }

    button.disabled = true;
    if (buttonLabel !== null) buttonLabel.textContent = t("review.submitting");
    announce(t("review.submitting"));

    // The same key for every retry of this report, so a retry after a lost
    // connection returns the original receipt instead of filing again.
    const result = await api.createSubmission(buildRequestBody(form), form.idempotencyKey);

    if (!result.ok) {
      if (result.offline) {
        // Nothing reached the server. Say exactly that, keep the draft and the
        // key, and let the citizen retry.
        showErrors([t("error.offline")]);
        announce(t("error.offline"));
        saveDraftSoon();
        return;
      }
      if (result.code === "unauthenticated") {
        showErrors([t("error.session_expired")]);
        saveDraftSoon();
        return;
      }
      if (result.code === "rate_limited" || result.code === "quota_exceeded") {
        showErrors([t("error.rate_limited", { seconds: result.retryAfterSeconds ?? 60 })]);
        return;
      }
      if (result.issues.length > 0) {
        showErrors(result.issues.map((issue) => `${issue.field}: ${issue.detail}`));
        return;
      }
      showErrors([t("error.server")]);
      return;
    }

    showReceipt(result.value);
    // The saved report should be reachable from My Reports immediately, not
    // only after the next page load.
    void loadMyReports();
  } finally {
    guard.end();
    if (buttonLabel !== null) buttonLabel.textContent = t("review.submit");
    renderSubmitAvailability();
  }
};

const startAnotherReport = (): void => {
  state.location = undefined;
  state.photo = initialUploadState;
  state.voice = undefined;
  // A new report gets a new key; reusing the old one would replay the receipt.
  state.idempotencyKey = newIdempotencyKey();
  el<HTMLTextAreaElement>("description").value = "";
  el<HTMLInputElement>("photo-input").value = "";
  el("receipt-panel").hidden = true;
  el("report-form").hidden = false;
  el("draft-restored").hidden = true;
  renderAll();
  el("location-heading").scrollIntoView({ block: "nearest" });
  el<HTMLButtonElement>("use-location").focus();
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const askDraftConsent = (): void => {
  const panel = el("consent-panel");
  panel.hidden = false;
  el("consent-heading").focus();
};

const wire = (): void => {
  el<HTMLSelectElement>("language-select").addEventListener("change", (event) => {
    const code = (event.target as HTMLSelectElement).value;
    const pack = CATALOGUE.packs.find((candidate) => candidate.code === code);
    if (pack === undefined) return;
    state.translator = createTranslator(pack);
    renderAll();
    // Rebuilt because the "all categories" option is translated and the
    // untranslated-label disclosure depends on which language the page is in.
    // `loadCategoryFilter` preserves the reader's current selection.
    void loadCategoryFilter();
    if (state.signedIn) void loadMyReports();
    if (displayedDiscoveryRadiusMetres !== undefined) {
      renderDiscoveryMap(displayedDiscoveryRows, displayedDiscoveryRadiusMetres);
    }
    announce(t("app.language_label"));
  });

  el("use-location").addEventListener("click", captureLocation);
  el("refresh-location").addEventListener("click", captureLocation);
  el("clear-location").addEventListener("click", () => {
    state.location = undefined;
    renderAll();
    saveDraftSoon();
    el<HTMLButtonElement>("use-location").focus();
  });

  el("toggle-manual").addEventListener("click", () => {
    const fields = el("manual-fields");
    const expanded = !fields.hidden;
    fields.hidden = expanded;
    el("toggle-manual").setAttribute("aria-expanded", String(!expanded));
    if (!expanded) el<HTMLInputElement>("manual-lat").focus();
  });
  el("apply-manual").addEventListener("click", applyManualLocation);

  el("photo-input").addEventListener("change", onPhotoSelected);
  el("photo-retry").addEventListener("click", () => {
    const file = el<HTMLInputElement>("photo-input").files?.[0];
    if (file === undefined) return;
    setUpload("photo", nextUploadState(state.photo, { kind: "retry" }));
    void runUpload("photo", file);
  });
  el("photo-remove").addEventListener("click", () => {
    el<HTMLInputElement>("photo-input").value = "";
    setUpload("photo", nextUploadState(state.photo, { kind: "remove" }));
    saveDraftSoon();
  });

  el("voice-record").addEventListener("click", () => void toggleRecording());

  const description = el<HTMLTextAreaElement>("description");
  description.addEventListener("input", () => {
    renderRemaining();
    renderReview();
    renderSubmitAvailability();
    saveDraftSoon();
  });

  el<HTMLFormElement>("report-form").addEventListener("submit", (event) => {
    void submitReport(event as SubmitEvent);
  });
  el("report-another").addEventListener("click", startAnotherReport);
  el("sign-out").addEventListener("click", () => void signOut());

  el("discard-draft").addEventListener("click", discardDraft);

  el("consent-allow").addEventListener("click", () => {
    drafts.recordConsent("granted");
    el("consent-panel").hidden = true;
    saveDraftSoon();
  });
  el("consent-decline").addEventListener("click", () => {
    drafts.recordConsent("declined");
    el("consent-panel").hidden = true;
  });

  // A location captured before the phone was pocketed may no longer be where
  // the citizen is standing; re-checking on return is cheaper than a wrong pin.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") renderLocation();
  });

  if (!supportsRecording()) {
    el<HTMLButtonElement>("voice-record").disabled = true;
    el("voice-state").textContent = t("describe.voice_unsupported");
  }
};

const start = async (): Promise<void> => {
  renderAll();
  wire();
  // V030 surfaces. Wired before the session is known: the tracking panel
  // stays hidden until a session actually returns reports, and discovery is
  // public so it needs no session at all.
  wireTrackingAndDiscovery();
  void loadMyReports();
  // Public, like discovery itself, so this needs no session and runs before
  // one is known (V030).
  void loadCategoryFilter();
  // V031's listeners, attached once. An earlier version of this call landed in
  // the language-change handler instead, so the buttons did nothing until the
  // reader happened to switch language — silently, with no error anywhere.
  wireCandidateQuestion();

  if (drafts.consent() === "unasked") askDraftConsent();
  else restoreDraft();

  const metadata = await api.capabilities();
  if (!metadata.ok) {
    showErrors([metadata.offline ? t("error.offline") : t("error.server")]);
    return;
  }

  const session = await api.session();
  if (session.ok && session.value.authenticated) {
    // The CSRF cookie is readable by design; a returning session needs its
    // token back before any write can be attempted.
    api.setCsrfToken(readCsrfCookie());
    renderSignedIn(session.value.identity_label ?? "");
    el("capability-label").textContent = session.value.identity_label ?? "";
    renderLoginPanelLabelsOnly(metadata.value);
  } else {
    renderLoginPanel(metadata.value);
  }
  renderAll();
};

/** Keeps the honesty labels visible for an already-signed-in session. */
const renderLoginPanelLabelsOnly = (metadata: CapabilityMetadata): void => {
  const model = buildDemoIdentityViewModel(metadata as unknown as DemoIdentityMetadata);
  el("capability-label").textContent = model.providerLabel;
};

const readCsrfCookie = (): string | undefined => {
  for (const part of document.cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() === "vision_csrf") {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// V030: tracking, discovery and issue detail
// ---------------------------------------------------------------------------

/**
 * Renders the citizen's own reports.
 *
 * Session-bound: there is no link to keep and nothing to paste. An empty list
 * says so plainly rather than showing an encouraging placeholder.
 */
const renderMyReports = (rows: readonly ReportRow[]): void => {
  const list = el<HTMLUListElement>("tracking-list");
  list.replaceChildren();
  el("tracking-empty").hidden = rows.length > 0;

  for (const row of rows) {
    const item = document.createElement("li");
    const reference = document.createElement("p");
    reference.textContent = row.hasIssue ? (row.reference ?? "") : t("tracking.no_issue_yet");
    const status = document.createElement("p");
    status.className = "disclosure";
    status.textContent = row.statusLabel;
    const evidence = document.createElement("p");
    evidence.className = "disclosure";
    evidence.textContent = t("tracking.evidence_count", {
      count: String(row.evidenceCount),
    });
    const receiptReference = document.createElement("p");
    receiptReference.className = "disclosure record-reference";
    receiptReference.textContent = t("tracking.receipt_reference", {
      reference: row.submissionId,
    });
    const openReceipt = document.createElement("button");
    openReceipt.type = "button";
    openReceipt.className = "button-quiet";
    openReceipt.textContent = t("tracking.open_receipt");
    openReceipt.addEventListener("click", () => void lookupReceipt(row.submissionId));
    item.append(reference, status, evidence, receiptReference, openReceipt);

    if (row.hasIssue && row.reference !== undefined) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "button-quiet";
      open.textContent = t("discovery.open_detail");
      const reference_ = row.reference;
      open.addEventListener("click", () => void openDetail(reference_));
      item.append(open);
    }

    // V031: the report is waiting for the reporter to answer one question.
    // Offered here because this list is the only place a citizen sees their
    // own reports — before this the question existed server-side with nothing
    // in the interface able to reach it.
    if (row.awaitingAnswerForIssueId !== undefined) {
      const ask = document.createElement("button");
      ask.type = "button";
      ask.className = "button";
      ask.textContent = t("candidate.heading");
      const submissionId = row.submissionId;
      const candidateIssueId = row.awaitingAnswerForIssueId;
      ask.addEventListener(
        "click",
        () => void openCandidateQuestion(submissionId, candidateIssueId),
      );
      item.append(ask);
    }
    list.append(item);
  }
};

const renderLookupReceipt = (receipt: Receipt): void => {
  const view = toReceiptLookupView(receipt);
  el("receipt-lookup-result-reference").textContent = view.reference;
  el("receipt-lookup-result-status").textContent = view.status;
  el("receipt-lookup-result-received-at").textContent = new Date(view.receivedAt).toLocaleString(
    state.translator.pack.code,
  );

  const replayed = el("receipt-lookup-result-replayed");
  replayed.hidden = !view.wasReplay;
  replayed.textContent = view.wasReplay ? t("receipt.replayed") : "";

  el("receipt-lookup-result").hidden = false;
  const heading = el("receipt-lookup-result-heading");
  heading.focus();
  announce(t("lookup.found"));
};

/**
 * Opens only a receipt owned by the current session. The API deliberately
 * returns the same not-found response for an unknown reference and somebody
 * else's reference, so this screen cannot be used to probe report ownership.
 */
const lookupReceipt = async (reference?: string): Promise<void> => {
  const form = el<HTMLFormElement>("receipt-lookup-form");
  const input = el<HTMLInputElement>("receipt-lookup-reference");
  const button = el<HTMLButtonElement>("receipt-lookup-submit");
  const buttonLabel = button.querySelector("span");
  if (reference !== undefined) input.value = reference;

  fieldError("receipt-lookup-error", undefined, input);
  el("receipt-lookup-result").hidden = true;
  const normalized = normalizeReceiptReference(input.value);
  if (normalized === undefined) {
    fieldError("receipt-lookup-error", t("lookup.invalid"), input);
    input.focus();
    announce(t("lookup.invalid"));
    return;
  }

  button.disabled = true;
  form.setAttribute("aria-busy", "true");
  if (buttonLabel !== null) buttonLabel.textContent = t("lookup.searching");
  try {
    const result = await api.receipt(normalized);
    if (!result.ok) {
      const message =
        result.code === "not_found"
          ? t("lookup.not_found")
          : result.offline
            ? t("error.offline")
            : result.code === "unauthenticated"
              ? t("error.session_expired")
              : t("error.server");
      fieldError("receipt-lookup-error", message, input);
      announce(message);
      return;
    }
    input.value = normalized;
    renderLookupReceipt(result.value);
  } finally {
    button.disabled = false;
    form.removeAttribute("aria-busy");
    if (buttonLabel !== null) buttonLabel.textContent = t("lookup.submit");
  }
};

const loadMyReports = async (): Promise<void> => {
  const result = await api.myReports();
  if (!result.ok) {
    // Signed out or offline: the panel is hidden rather than showing an
    // empty list, which would read as "you have never reported anything".
    el("tracking-panel").hidden = true;
    return;
  }
  el("tracking-panel").hidden = false;
  const payload = result.value as { reports: ReportPayload[] };
  renderMyReports(toReportRows(payload.reports));
};

/** Cursor for the next discovery page, and the position it belongs to. */
let discoveryCursor: string | undefined;
let discoveryOrigin: { lon: number; lat: number } | undefined;
let displayedDiscoveryRows: readonly DiscoveryRow[] = [];
let displayedDiscoveryRadiusMetres: number | undefined;

const renderDiscoveryMap = (rows: readonly DiscoveryRow[], radiusMetres: number): void => {
  const origin = discoveryOrigin;
  if (origin === undefined) return;

  const view = toDiscoveryMapView(rows, origin, radiusMetres);
  const markers = el("discovery-map-markers");
  markers.replaceChildren(
    ...view.markers.map((marker) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "coordinate-map-marker";
      button.style.left = `${marker.leftPercent.toFixed(3)}%`;
      button.style.top = `${marker.topPercent.toFixed(3)}%`;
      button.textContent = String(marker.index);
      button.setAttribute(
        "aria-label",
        t("discovery.map_marker", {
          index: marker.index,
          reference: marker.reference,
          category: marker.category,
        }),
      );
      button.title = `${marker.reference} — ${marker.category}`;
      button.addEventListener("click", () => void openDetail(marker.reference));
      return button;
    }),
  );

  const summaries = [
    t("discovery.map_summary", {
      shown: view.markers.length,
      total: view.totalIssues,
    }),
  ];
  if (view.missingPublicLocationCount > 0) {
    summaries.push(t("discovery.map_missing", { count: view.missingPublicLocationCount }));
  }
  if (view.outsideDisplayedExtentCount > 0) {
    summaries.push(t("discovery.map_outside", { count: view.outsideDisplayedExtentCount }));
  }
  el("discovery-map-summary").textContent = summaries.join(" ");
  el("discovery-map-shell").hidden = false;
};

const renderDiscovery = (view: DiscoveryView, append: boolean): void => {
  const list = el<HTMLUListElement>("discovery-list");
  displayedDiscoveryRows = append
    ? [
        ...displayedDiscoveryRows,
        ...view.issues.filter(
          (candidate) =>
            !displayedDiscoveryRows.some((shown) => shown.reference === candidate.reference),
        ),
      ]
    : view.issues;
  displayedDiscoveryRadiusMetres = view.radiusMetres;
  list.replaceChildren();

  el("discovery-bounds").textContent = view.boundsLabel;
  const empty = el("discovery-empty");
  empty.hidden = displayedDiscoveryRows.length > 0;
  empty.textContent = view.emptyMessage;

  for (const [index, issue] of displayedDiscoveryRows.entries()) {
    const item = document.createElement("li");
    const heading = document.createElement("p");
    heading.textContent = `${String(index + 1)}. ${issue.reference} — ${issue.category}`;
    const participants = document.createElement("p");
    participants.className = "disclosure";
    participants.textContent = issue.participantsLabel;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "button-quiet";
    open.textContent = t("discovery.open_detail");
    open.addEventListener("click", () => void openDetail(issue.reference));
    item.append(heading, participants, open);
    list.append(item);
  }

  renderDiscoveryMap(displayedDiscoveryRows, view.radiusMetres);
  state.nearbyCount = displayedDiscoveryRows.length;
  renderRail();

  discoveryCursor = view.nextCursor;
  el("discovery-more").hidden = !view.hasMore;
};

const loadDiscovery = async (append: boolean): Promise<void> => {
  const origin = discoveryOrigin;
  if (origin === undefined) return;
  const category = el<HTMLSelectElement>("discovery-category").value;
  state.nearbyLoading = true;
  renderRail();
  try {
    const result = await api.nearbyIssues({
      lon: origin.lon,
      lat: origin.lat,
      ...(category.length === 0 ? {} : { category }),
      ...(append && discoveryCursor !== undefined ? { cursor: discoveryCursor } : {}),
    });
    if (!result.ok) {
      showErrors([result.offline ? t("error.offline") : t("error.server")]);
      return;
    }
    renderDiscovery(toDiscoveryView(result.value as DiscoveryPayload), append);
  } finally {
    state.nearbyLoading = false;
    renderRail();
  }
};

const renderDetail = (view: DetailView): void => {
  el("detail-opened").textContent = view.openedAt;
  el("detail-last-evidence").textContent = view.lastEvidenceAt ?? "—";
  el("detail-participants").textContent = view.participantsLabel;
  el("detail-entries").textContent = view.entriesLabel;

  const evidence = el<HTMLUListElement>("detail-evidence");
  evidence.replaceChildren();
  for (const item of view.evidence) {
    const entry = document.createElement("li");
    if (item.text !== undefined) {
      const text = document.createElement("p");
      text.textContent = item.text;
      entry.append(text);
    }
    if (item.showImage && item.imageSource !== undefined) {
      const image = document.createElement("img");
      image.src = item.imageSource;
      // Described rather than left unlabelled: a screen reader must not
      // announce a bare filename, and the derivative is a redacted view.
      image.alt = t("detail.evidence_heading");
      image.loading = "lazy";
      entry.append(image);
    }
    if (item.note !== undefined) {
      const note = document.createElement("p");
      note.className = "disclosure";
      note.textContent = item.note;
      entry.append(note);
    }
    evidence.append(entry);
  }

  el("detail-history-note").textContent = view.infrastructureHistoryNote;
  const history = el<HTMLUListElement>("detail-history");
  history.replaceChildren();
  for (const entry of view.infrastructureHistory) {
    const item = document.createElement("li");
    item.textContent = `${entry.at} — ${entry.what}`;
    history.append(item);
  }

  const disclosures = el<HTMLUListElement>("detail-disclosures");
  disclosures.replaceChildren();
  for (const line of view.disclosures) {
    const item = document.createElement("li");
    item.textContent = line;
    disclosures.append(item);
  }

  el("detail-panel").hidden = false;
  el("detail-heading").focus();
};

// ── V035 repair claim, inside the issue details panel ─────────────────────
//
// Which issue the panel is showing, so the confirm / dispute / reopen buttons
// know what they are acting on. Held rather than read back out of the DOM: a
// reference parsed from rendered text is a reference that can be edited.
let openIssueReference: string | undefined;

const renderResolution = (view: ResolutionView): void => {
  const panel = el("detail-resolution");
  if (!view.hasClaim) {
    // Nothing claimed: the panel stays exactly as it was before V035.
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  el("resolution-state").textContent = t(view.stateKey);

  const progress = el("resolution-progress");
  if (view.disputesRecorded > 0) {
    progress.hidden = false;
    progress.textContent = t("resolution.progress_disputed", {
      disputes: view.disputesRecorded,
      version: view.policyVersion,
    });
  } else {
    progress.hidden = false;
    progress.textContent = t("resolution.progress", {
      recorded: view.confirmationsRecorded,
      required: view.requiredConfirmations,
      version: view.policyVersion,
    });
  }

  el("resolution-claim").hidden = view.description === undefined;
  el("resolution-description").textContent = view.description ?? "";

  // Only approved derivatives are ever rendered. When there is none the row
  // says why, in the server's own words, rather than showing a broken frame.
  const evidence = el<HTMLUListElement>("resolution-evidence");
  evidence.replaceChildren();
  for (const item of view.evidence) {
    const entry = document.createElement("li");
    if (item.viewable && item.derivativeReference !== undefined) {
      const image = document.createElement("img");
      image.src = `/v1/media/${item.derivativeReference}`;
      image.alt = t("resolution.evidence_photo");
      image.loading = "lazy";
      entry.append(image);
    } else {
      const note = document.createElement("p");
      note.className = "disclosure";
      note.textContent = item.whyNotViewable ?? t("resolution.evidence_pending");
      entry.append(note);
    }
    evidence.append(entry);
  }

  el("resolution-caveat").textContent = t("resolution.caveat");
  const inspection = el("resolution-inspection");
  inspection.hidden = !view.requiresQualifiedInspection;
  if (view.requiresQualifiedInspection) {
    inspection.textContent = t("resolution.inspection");
  }

  el("resolution-respond").hidden = !view.mayRespond;
  el("resolution-reopen").hidden = !view.mayReopen;

  const blocked = el("resolution-blocked");
  // A refusal names its cause. "You cannot answer" with no reason is
  // indistinguishable from the page being broken.
  blocked.hidden = view.mayRespond || view.blockedKey === undefined;
  blocked.textContent = view.blockedKey === undefined ? "" : t(view.blockedKey);

  const history = el<HTMLUListElement>("resolution-history");
  history.replaceChildren();
  for (const entry of view.history) {
    const item = document.createElement("li");
    const line = document.createElement("p");
    line.textContent = `${entry.at} — ${entry.what}`;
    item.append(line);
    if (entry.comment !== undefined) {
      const quote = document.createElement("p");
      quote.className = "disclosure";
      quote.textContent = entry.comment;
      item.append(quote);
    }
    history.append(item);
  }
};

const loadResolution = async (publicReference: string): Promise<void> => {
  const result = await api.issueResolution(publicReference);
  if (!result.ok) {
    // Not an error banner: an issue with no claim, or a reader with no
    // session, is the ordinary case and the rest of the details still work.
    el("detail-resolution").hidden = true;
    return;
  }
  renderResolution(toResolutionView(result.value as ResolutionPayload));
};

const resolutionError = (message: string): void => {
  const error = el("resolution-error");
  error.hidden = false;
  error.textContent = message;
};

const answerClaim = async (decision: "confirmed" | "disputed"): Promise<void> => {
  const reference = openIssueReference;
  if (reference === undefined) return;
  const comment = el<HTMLTextAreaElement>("resolution-comment").value.trim();
  if (decision === "disputed" && comment.length < 8) {
    resolutionError(t("resolution.dispute_needs_reason"));
    el("resolution-comment").focus();
    return;
  }
  el("resolution-error").hidden = true;
  const result = await api.respondToResolution(
    reference,
    decision,
    comment.length > 0 ? comment : undefined,
  );
  if (!result.ok) {
    resolutionError(result.message);
    return;
  }
  announce(
    t(decision === "confirmed" ? "resolution.saved_confirmed" : "resolution.saved_disputed"),
  );
  el<HTMLTextAreaElement>("resolution-comment").value = "";
  await loadResolution(reference);
};

const reopenOpenIssue = async (): Promise<void> => {
  const reference = openIssueReference;
  if (reference === undefined) return;
  const reason = el<HTMLTextAreaElement>("reopen-reason").value.trim();
  if (reason.length < 8) {
    resolutionError(t("resolution.reopen_needs_reason"));
    el("reopen-reason").focus();
    return;
  }
  el("resolution-error").hidden = true;
  const result = await api.reopenIssue(reference, reason);
  if (!result.ok) {
    resolutionError(result.message);
    return;
  }
  announce(t("resolution.saved_reopened"));
  el<HTMLTextAreaElement>("reopen-reason").value = "";
  await loadResolution(reference);
};

const openDetail = async (publicReference: string): Promise<void> => {
  const result = await api.issueDetail(publicReference);
  if (!result.ok) {
    showErrors([t("error.server")]);
    return;
  }
  openIssueReference = publicReference;
  el("resolution-error").hidden = true;
  renderDetail(toDetailView(result.value as DetailPayload));
  await loadResolution(publicReference);
};

/**
 * Fills the discovery filter from the taxonomy the server serves (V030).
 *
 * Failure is not fatal and not reported as an error: the filter degrades to
 * "All categories", which is what it did before, and discovery still works.
 * A red banner over a working page for a filter that is merely less specific
 * would be out of proportion.
 */
const loadCategoryFilter = async (): Promise<void> => {
  const result = await api.taxonomy();
  if (!result.ok) return;
  const view = toCategoryOptions(
    result.value as TaxonomyPayload,
    t("discovery.filter_all"),
    state.translator.pack.code,
  );

  const select = el<HTMLSelectElement>("discovery-category");
  const previous = select.value;
  select.replaceChildren(
    ...view.options.map((option) => {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      return element;
    }),
  );
  // A locale change reloads the options; losing the reader's chosen filter
  // while they are reading the results it produced would be its own defect.
  if (view.options.some((option) => option.value === previous)) select.value = previous;

  const disclosure = el("discovery-category-language");
  if (view.languageDisclosure === undefined) {
    disclosure.hidden = true;
    disclosure.textContent = "";
  } else {
    disclosure.hidden = false;
    disclosure.textContent = view.languageDisclosure;
  }
};

// ---------------------------------------------------------------------------
// The citizen confirm/reject question (V031)
// ---------------------------------------------------------------------------

/** The question currently on screen, so the answer goes to the right report. */
let pendingCandidate: { submissionId: string; candidateIssueId: string } | undefined;

/**
 * Shows the confirm/reject question for one report.
 *
 * V031 recorded "**No citizen screen.** ... A citizen cannot reach it without
 * calling the API directly." This is the screen.
 */
const openCandidateQuestion = async (
  submissionId: string,
  candidateIssueId: string,
): Promise<void> => {
  const result = await api.matchCandidate(submissionId, candidateIssueId);
  if (!result.ok) {
    showErrors([result.offline ? t("error.offline") : t("error.server")]);
    return;
  }
  const view = toCandidateView(result.value as CandidatePayload, t);
  pendingCandidate = { submissionId, candidateIssueId };

  el("candidate-question").textContent = view.question;
  el("candidate-summary").textContent = view.summary;
  el("candidate-opened").textContent = view.openedLabel;
  // An unknown distance shows an explicit "not known" rather than an empty
  // cell: a blank field reads as a rendering fault, not as missing data.
  el("candidate-distance").textContent = view.distanceLabel ?? t("detail.not_live");
  el("candidate-participants").textContent = view.participantsLabel;
  el("candidate-confirm").textContent = view.confirmLabel;
  el("candidate-reject").textContent = view.rejectLabel;
  el("candidate-confirm-consequence").textContent = view.confirmConsequence;
  el("candidate-reject-consequence").textContent = view.rejectConsequence;

  const alias = el("candidate-alias");
  alias.hidden = view.aliasNote === undefined;
  alias.textContent = view.aliasNote ?? "";

  const previews = el("candidate-previews");
  previews.replaceChildren(
    ...view.previewReferences.map((reference) => {
      const row = document.createElement("li");
      const image = document.createElement("img");
      image.src = `/v1/media/${encodeURIComponent(reference)}`;
      // Described as a photograph on the existing report and nothing more: no
      // detector has looked at it, so no claim about its contents is available
      // to put here (V021).
      image.alt = t("candidate.previews_heading");
      image.loading = "lazy";
      row.append(image);
      return row;
    }),
  );

  el("candidate-result").hidden = true;
  el("candidate-panel").hidden = false;
  el("candidate-heading").focus();
};

const answerCandidate = async (decision: "confirm-match" | "reject-match"): Promise<void> => {
  const pending = pendingCandidate;
  if (pending === undefined) return;

  const confirm = el<HTMLButtonElement>("candidate-confirm");
  const reject = el<HTMLButtonElement>("candidate-reject");
  confirm.disabled = true;
  reject.disabled = true;
  try {
    const result = await api.decideMatch(pending.submissionId, decision, pending.candidateIssueId);
    if (!result.ok) {
      showErrors([result.offline ? t("error.offline") : t("error.server")]);
      return;
    }
    const outcome = el("candidate-result");
    outcome.textContent = t("candidate.answered");
    outcome.hidden = false;
    announce(t("candidate.answered"));
    pendingCandidate = undefined;
    // The report's own row changes either way, so the list is reloaded rather
    // than patched from the answer — patching would show a state the server
    // has not confirmed.
    void loadMyReports();
  } finally {
    confirm.disabled = false;
    reject.disabled = false;
  }
};

const wireCandidateQuestion = (): void => {
  el("candidate-confirm").addEventListener("click", () => void answerCandidate("confirm-match"));
  el("candidate-reject").addEventListener("click", () => void answerCandidate("reject-match"));
  el("candidate-close").addEventListener("click", () => {
    // Closed, not answered. Leaving without choosing is allowed: the question
    // stays open and the report is unchanged.
    pendingCandidate = undefined;
    el("candidate-panel").hidden = true;
  });
};

const wireTrackingAndDiscovery = (): void => {
  el("tracking-refresh").addEventListener("click", () => void loadMyReports());
  el<HTMLFormElement>("receipt-lookup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void lookupReceipt();
  });
  el("discovery-more").addEventListener("click", () => void loadDiscovery(true));
  el("resolution-confirm").addEventListener("click", () => void answerClaim("confirmed"));
  el("resolution-dispute").addEventListener("click", () => void answerClaim("disputed"));
  el("resolution-reopen-submit").addEventListener("click", () => void reopenOpenIssue());

  el("detail-close").addEventListener("click", () => {
    openIssueReference = undefined;
    el("detail-resolution").hidden = true;
    el("detail-panel").hidden = true;
  });
  el("discovery-category").addEventListener("change", () => void loadDiscovery(false));
  el("discovery-search").addEventListener("click", () => {
    // Reuse a position the citizen already chose for this report. A manual pin
    // remains a claimed position—the existing location panel says so—but it
    // is still a valid centre for a public nearby search and avoids asking for
    // the same permission twice.
    if (state.location !== undefined) {
      discoveryOrigin = { lon: state.location.lon, lat: state.location.lat };
      void loadDiscovery(false);
      return;
    }
    if (navigator.geolocation === undefined) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        discoveryOrigin = {
          lon: position.coords.longitude,
          lat: position.coords.latitude,
        };
        void loadDiscovery(false);
      },
      () => {
        // Discovery needs a position and will not invent one; the existing
        // location messages already explain a refused permission.
        showErrors([t("location.permission_denied")]);
      },
    );
  });
};

void start();
