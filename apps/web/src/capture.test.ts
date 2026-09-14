/**
 * Tests for the citizen capture logic (roadmap V019, V020).
 *
 * These cover the parts that can be wrong silently: locale fallback, the
 * captured-versus-claimed location distinction, the upload state machine, the
 * duplicate-tap guard and the draft privacy rules. The interface itself —
 * keyboard order, focus visibility, announcements, contrast, target sizes,
 * zoom — is checked in a browser and recorded in the V019 task record.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { enIN } from "./locales/en-IN.ts";
import { mrIN } from "./locales/mr-IN.ts";
import type { LocalePack, StringKey } from "./locales/strings.ts";
import {
  createTranslator,
  interpolate,
  resolveLocale,
  resolvePreferredLocale,
  LocaleError,
} from "./i18n.ts";
import {
  STALE_LOCATION_MINUTES,
  describeLocation,
  geolocationErrorKey,
  isLocationStale,
  readingAgeMinutes,
  validateCoordinates,
  type LocationReading,
} from "./location.ts";
import {
  MAX_UPLOAD_BYTES,
  blocksSubmission,
  checkFile,
  initialUploadState,
  isAttachable,
  nextUploadState,
  type UploadState,
} from "./upload.ts";
import {
  MAX_TEXT_LENGTH,
  SubmitGuard,
  buildRequestBody,
  canSubmit,
  findBlocks,
  newIdempotencyKey,
  type CaptureForm,
} from "./submission.ts";
import { DRAFT_TTL_HOURS, DraftStore, restoreFormState, type KeyValueStore } from "./drafts.ts";

const CATALOGUE = { packs: [enIN, mrIN], fallbackCode: enIN.code };

/**
 * `Partial<T>` refuses an explicit `undefined` under `exactOptionalPropertyTypes`,
 * but these helpers need to say "this field is deliberately absent".
 */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };

/** Merges overrides, treating an explicit `undefined` as "leave this out". */
const merge = <T extends object>(base: T, overrides: Loose<T>): T => {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result as T;
};

const deviceReading = (overrides: Loose<LocationReading> = {}): LocationReading =>
  merge<LocationReading>(
    {
      lat: 16.8524,
      lon: 74.5815,
      accuracyMetres: 12,
      source: "device_geolocation",
      observedAt: new Date("2026-09-09T10:00:00.000Z").toISOString(),
    },
    overrides,
  );

const accepted = (reference: string): UploadState => ({
  phase: "accepted",
  percent: 100,
  attempts: 0,
  objectReference: reference,
});

const formWith = (overrides: Loose<CaptureForm> = {}): CaptureForm =>
  merge<CaptureForm>(
    {
      location: deviceReading(),
      photo: initialUploadState,
      description: { text: "" },
      interfaceLocale: enIN.code,
      idempotencyKey: "web-test-key",
    },
    overrides,
  );

// ---------------------------------------------------------------------------
// Localisation
// ---------------------------------------------------------------------------

test("V019: every locale pack defines exactly the same keys", () => {
  const reference = Object.keys(enIN.strings).sort();
  for (const pack of CATALOGUE.packs) {
    assert.deepEqual(
      Object.keys(pack.strings).sort(),
      reference,
      `pack ${pack.code} must define the same keys as the source pack`,
    );
    for (const [key, value] of Object.entries(pack.strings)) {
      assert.equal(value.trim().length > 0, true, `${pack.code}:${key} must not be empty`);
    }
  }
});

test("V019: a pack drafted without a native reviewer says so", () => {
  const marathi = createTranslator(mrIN);
  assert.equal(
    marathi.disclosesTranslationStatus,
    true,
    "an unreviewed translation must be disclosed, not presented as finished",
  );
  assert.equal(createTranslator(enIN).disclosesTranslationStatus, false);
  assert.equal(mrIN.translation_status, "machine_drafted_pending_native_review");
});

test("V019: locale resolution falls back without silently mislabelling", () => {
  assert.equal(resolveLocale("mr-IN", CATALOGUE).code, mrIN.code);
  assert.equal(resolveLocale("mr", CATALOGUE).code, mrIN.code, "a primary subtag must match");
  assert.equal(resolveLocale("MR-in", CATALOGUE).code, mrIN.code, "matching is case-insensitive");
  assert.equal(resolveLocale("fr-FR", CATALOGUE).code, enIN.code, "an unknown tag falls back");
  assert.equal(resolveLocale(undefined, CATALOGUE).code, enIN.code);
  assert.equal(resolvePreferredLocale(["fr", "mr-IN", "en-IN"], CATALOGUE).code, mrIN.code);
  assert.equal(resolvePreferredLocale([], CATALOGUE).code, enIN.code);
});

test("V019: a catalogue whose fallback is missing fails loudly", () => {
  assert.throws(
    () => resolveLocale("mr-IN", { packs: [mrIN], fallbackCode: "en-IN" }),
    LocaleError,
    "a misconfigured catalogue must not resolve to an arbitrary language",
  );
});

test("V019: interpolation leaves an unsupplied placeholder visible", () => {
  assert.equal(interpolate("about {metres} m", { metres: 12 }), "about 12 m");
  assert.equal(
    interpolate("about {metres} m", {}),
    "about {metres} m",
    "a missing parameter must be obvious, not an empty gap",
  );
});

test("V019: the receipt wording never promises repair or officialdom", () => {
  for (const pack of CATALOGUE.packs) {
    const promise = pack.strings["receipt.not_a_promise"];
    assert.equal(promise.trim().length > 0, true, `${pack.code} must carry the receipt caveat`);
  }
  // The English source is checked for wording, because it is the text the
  // V002 prohibitions were written against.
  const english = enIN.strings["receipt.not_a_promise"].toLowerCase();
  assert.match(english, /not an official/);
  assert.match(english, /not a promise/);
  const saved = enIN.strings["receipt.saved_note"].toLowerCase();
  assert.doesNotMatch(saved, /verified|confirmed|official receipt/);
});

test("V019: no locale pack offers a category, department or severity choice", () => {
  // The roadmap keeps classification out of the citizen's required form. If a
  // key for it ever appears, this test is where the argument should happen.
  const keys = Object.keys(enIN.strings) as StringKey[];
  const classification = keys.filter((key) =>
    /(^|\.)(category|department|severity|priority)/.test(key),
  );
  assert.deepEqual(classification, []);
});

// ---------------------------------------------------------------------------
// Location: captured evidence versus a claimed pin
// ---------------------------------------------------------------------------

test("V019: a captured position and a typed position are described differently", () => {
  const captured = describeLocation(deviceReading());
  const claimed = describeLocation(
    deviceReading({ source: "manual_pin", accuracyMetres: undefined }),
  );

  assert.equal(captured.isDeviceEvidence, true);
  assert.equal(claimed.isDeviceEvidence, false);
  assert.notEqual(captured.headingKey, claimed.headingKey);
  assert.notEqual(captured.noteKey, claimed.noteKey);
  assert.equal(captured.accuracyKey, "location.accuracy");
  assert.equal(captured.accuracyParams["metres"], 12);
});

test("V019: a manual pin is never given an invented accuracy", () => {
  // Even if a caller passes one through, a typed position has no device
  // measurement to report.
  const claimed = describeLocation(deviceReading({ source: "manual_pin", accuracyMetres: 5 }));
  assert.equal(claimed.accuracyKey, "location.accuracy_unknown");
  assert.deepEqual(claimed.accuracyParams, {});
});

test("V019: a device reading with no accuracy says the accuracy is unknown", () => {
  const reading = describeLocation(deviceReading({ accuracyMetres: undefined }));
  assert.equal(reading.accuracyKey, "location.accuracy_unknown");
  assert.equal(reading.isDeviceEvidence, true, "it is still a device reading");
});

test("V019: impossible coordinates are refused before anything is sent", () => {
  assert.deepEqual(validateCoordinates(16.85, 74.58), []);
  assert.equal(validateCoordinates(91, 74.58).length, 1);
  assert.equal(validateCoordinates(16.85, 181).length, 1);
  assert.equal(validateCoordinates(Number.NaN, Number.POSITIVE_INFINITY).length, 2);
});

test("V019: a denied permission is distinguished from an unavailable position", () => {
  assert.equal(geolocationErrorKey(1), "location.permission_denied");
  assert.equal(geolocationErrorKey(2), "location.unavailable");
  assert.equal(geolocationErrorKey(3), "location.unavailable");
  assert.equal(geolocationErrorKey(undefined), "location.unavailable");
});

test("V020: only a captured position goes stale", () => {
  const observedAtMs = Date.parse(deviceReading().observedAt);
  const fresh = observedAtMs + 60_000;
  const old = observedAtMs + (STALE_LOCATION_MINUTES + 1) * 60_000;

  assert.equal(isLocationStale(deviceReading(), fresh), false);
  assert.equal(isLocationStale(deviceReading(), old), true);
  assert.equal(readingAgeMinutes(deviceReading(), old), STALE_LOCATION_MINUTES + 1);
  assert.equal(
    isLocationStale(deviceReading({ source: "manual_pin" }), old),
    false,
    "a typed position is a claim about a place, not a measurement that ages",
  );
  assert.equal(
    readingAgeMinutes(deviceReading(), observedAtMs - 60_000),
    0,
    "clock skew must not produce a negative age",
  );
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

test("V019: an unfinished upload is never attachable evidence", () => {
  let state = nextUploadState(initialUploadState, {
    kind: "select",
    fileName: "pothole.jpg",
    byteSize: 1024,
    contentType: "image/jpeg",
  });
  assert.equal(state.phase, "selected");
  assert.equal(isAttachable(state), false);

  state = nextUploadState(state, { kind: "grant_requested" });
  state = nextUploadState(state, {
    kind: "granted",
    objectReference: "2026-09/abc",
    uploadUrl: "/v1/uploads/x",
  });
  assert.equal(state.phase, "sending");
  assert.equal(isAttachable(state), false, "granted is not accepted");

  state = nextUploadState(state, { kind: "progress", percent: 40 });
  assert.equal(state.percent, 40);
  assert.equal(isAttachable(state), false);

  state = nextUploadState(state, { kind: "sent" });
  assert.equal(state.phase, "finalizing");
  assert.equal(isAttachable(state), false, "bytes sent is not the same as server-accepted");

  state = nextUploadState(state, { kind: "accepted" });
  assert.equal(isAttachable(state), true);
  assert.equal(state.percent, 100);
});

test("V019: progress is clamped and ignored outside the sending phase", () => {
  const selected = nextUploadState(initialUploadState, {
    kind: "select",
    fileName: "a.png",
    byteSize: 10,
    contentType: "image/png",
  });
  assert.equal(nextUploadState(selected, { kind: "progress", percent: 50 }).percent, 0);

  const sending = nextUploadState(nextUploadState(selected, { kind: "grant_requested" }), {
    kind: "granted",
    objectReference: "r",
    uploadUrl: "u",
  });
  assert.equal(nextUploadState(sending, { kind: "progress", percent: 250 }).percent, 100);
  assert.equal(nextUploadState(sending, { kind: "progress", percent: -5 }).percent, 0);
});

test("V020: a retry reuses the granted object instead of leaking a new grant", () => {
  let state = nextUploadState(initialUploadState, {
    kind: "select",
    fileName: "a.jpg",
    byteSize: 10,
    contentType: "image/jpeg",
  });
  state = nextUploadState(state, { kind: "grant_requested" });
  state = nextUploadState(state, {
    kind: "granted",
    objectReference: "2026-09/same",
    uploadUrl: "u",
  });
  state = nextUploadState(state, { kind: "failed", errorKey: "photo.failed" });
  assert.equal(state.phase, "failed");
  assert.equal(state.errorKey, "photo.failed");

  const retried = nextUploadState(state, { kind: "retry" });
  assert.equal(retried.phase, "granting");
  assert.equal(retried.attempts, 1);
  assert.equal(retried.objectReference, "2026-09/same", "the same object is reused");
  assert.equal(retried.errorKey, undefined, "the stale error must be cleared");
});

test("V019: a late failure callback cannot un-accept an accepted upload", () => {
  const state = accepted("2026-09/done");
  const late = nextUploadState(state, { kind: "failed", errorKey: "photo.failed" });
  assert.deepEqual(late, state, "a stray callback from a cancelled request changes nothing");
});

test("V019: removing an upload returns to a clean state", () => {
  assert.deepEqual(nextUploadState(accepted("r"), { kind: "remove" }), initialUploadState);
});

test("V019: oversized and wrong-type files are explained before uploading", () => {
  assert.equal(checkFile({ type: "image/jpeg", size: 1024 }), undefined);
  assert.equal(checkFile({ type: "image/gif", size: 1024 })?.errorKey, "photo.wrong_type");
  const tooBig = checkFile({ type: "image/png", size: MAX_UPLOAD_BYTES + 1 });
  assert.equal(tooBig?.errorKey, "photo.too_large");
  assert.equal(tooBig?.params["megabytes"], 8);
});

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

test("V019: a report needs a location and something observable, in any one form", () => {
  // The second rule is the server's `no_observation` check, mirrored client
  // side so the citizen is told before sending instead of being rejected.
  assert.equal(
    canSubmit(formWith()),
    false,
    "a location on its own gives a reviewer nothing to look at",
  );
  assert.deepEqual(
    findBlocks(formWith()).map((block) => block.field),
    ["observation"],
  );

  assert.equal(canSubmit(formWith({ description: { text: "street light out" } })), true);
  assert.equal(canSubmit(formWith({ photo: accepted("2026-09/photo") })), true);
  assert.equal(
    canSubmit(formWith({ description: { text: "", voice: accepted("2026-09/voice") } })),
    true,
  );
  assert.equal(
    canSubmit(formWith({ description: { text: "   " } })),
    false,
    "whitespace is not an observation",
  );

  const noLocation = formWith({ location: undefined, description: { text: "broken" } });
  assert.equal(canSubmit(noLocation), false);
  assert.deepEqual(
    findBlocks(noLocation).map((block) => block.field),
    ["location"],
  );
});

test("V019: a half-finished upload blocks sending instead of being dropped", () => {
  const selected = nextUploadState(initialUploadState, {
    kind: "select",
    fileName: "a.jpg",
    byteSize: 10,
    contentType: "image/jpeg",
  });
  assert.equal(blocksSubmission(selected), true);
  const blocks = findBlocks(formWith({ photo: selected, description: { text: "broken light" } }));
  assert.deepEqual(
    blocks.map((block) => block.errorKey),
    ["error.upload_incomplete"],
    "sending now would silently drop the photo the citizen thinks is attached",
  );
});

test("V019: over-long text blocks sending", () => {
  const form = formWith({ description: { text: "x".repeat(MAX_TEXT_LENGTH + 1) } });
  assert.equal(canSubmit(form), false);
  assert.deepEqual(
    findBlocks(form).map((block) => block.field),
    ["text"],
    "over-long text is still an observation; only its length is the problem",
  );
});

test("V019: the request body carries the location source and no invented accuracy", () => {
  const captured = buildRequestBody(formWith());
  assert.equal(captured.observed.source, "device_geolocation");
  assert.equal(captured.observed.accuracy_m, 12);

  const claimed = buildRequestBody(
    formWith({ location: deviceReading({ source: "manual_pin", accuracyMetres: undefined }) }),
  );
  assert.equal(claimed.observed.source, "manual_pin");
  assert.equal(
    claimed.observed.accuracy_m,
    null,
    "a typed position reports no accuracy rather than a made-up number",
  );
  assert.equal(
    buildRequestBody(
      formWith({ location: deviceReading({ source: "manual_pin", accuracyMetres: 5 }) }),
    ).observed.accuracy_m,
    null,
    "even a stray accuracy on a typed position is not sent as a measurement",
  );
});

test("V019: only accepted uploads reach the request body", () => {
  const sending: UploadState = { phase: "sending", percent: 50, attempts: 0, objectReference: "r" };
  const body = buildRequestBody(
    formWith({
      photo: accepted("2026-09/photo"),
      description: { text: " a pothole ", voice: sending },
    }),
  );
  assert.deepEqual(body.evidence, [{ object_reference: "2026-09/photo", media_type: "photo" }]);
  assert.equal(body.text, "a pothole", "text is trimmed");

  const empty = buildRequestBody(formWith({ description: { text: "   " } }));
  assert.equal("text" in empty, false, "whitespace is not a description");
});

test("V019: building a body without a location fails instead of inventing one", () => {
  assert.throws(() => buildRequestBody(formWith({ location: undefined })), /requires a location/);
});

test("V020: a double tap sends once", () => {
  const guard = new SubmitGuard(1000);
  assert.equal(guard.begin(1_000), true);
  assert.equal(guard.begin(1_010), false, "the second of two fast taps is refused");
  assert.equal(guard.busy, true);

  guard.end();
  assert.equal(guard.begin(1_200), false, "still inside the cooldown");
  assert.equal(guard.begin(2_500), true, "a deliberate retry later is allowed");
});

test("V020: an attempt that throws does not wedge the send button", () => {
  const guard = new SubmitGuard(0);
  assert.equal(guard.begin(1_000), true);
  try {
    throw new Error("network");
  } catch {
    guard.end();
  }
  assert.equal(guard.begin(1_001), true);
});

test("V018/V019: a fresh key per report, not a content hash", () => {
  const a = newIdempotencyKey();
  const b = newIdempotencyKey();
  assert.notEqual(a, b, "two reports of the same problem must both be accepted");
  assert.match(a, /^web-[0-9a-f-]{36}$/);
});

// ---------------------------------------------------------------------------
// Drafts (V020)
// ---------------------------------------------------------------------------

const memoryStore = (): KeyValueStore & { readonly map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
};

type DraftInputShape = Parameters<DraftStore["save"]>[0];

const draftInput = (overrides: Loose<DraftInputShape> = {}): DraftInputShape =>
  merge<DraftInputShape>(
    {
      idempotencyKey: "web-abc",
      interfaceLocale: enIN.code,
      text: "street light out",
      location: deviceReading(),
      photo: initialUploadState,
    },
    overrides,
  );

test("V020: nothing is written to the device without consent", () => {
  const store = memoryStore();
  const drafts = new DraftStore(store);
  assert.equal(drafts.consent(), "unasked");
  assert.equal(drafts.save(draftInput(), 1_000), false, "save must report that it did not write");
  assert.equal(store.map.size, 0, "not even an empty key may appear before consent");
  assert.equal(drafts.load(1_000), undefined);
});

test("V020: declining consent deletes anything an earlier grant stored", () => {
  const store = memoryStore();
  const drafts = new DraftStore(store);
  drafts.recordConsent("granted");
  assert.equal(drafts.save(draftInput(), 1_000), true);
  assert.notEqual(drafts.load(1_000), undefined);

  drafts.recordConsent("declined");
  assert.equal(drafts.load(1_000), undefined);
  assert.equal(
    [...store.map.keys()].some((key) => key.includes("draft.v1")),
    false,
    "withdrawing consent must remove the stored draft, not just stop new writes",
  );
});

test("V020: a draft keeps the original idempotency key so a retry is not a second report", () => {
  const store = memoryStore();
  const drafts = new DraftStore(store);
  drafts.recordConsent("granted");
  drafts.save(draftInput({ idempotencyKey: "web-original" }), 1_000);

  const restored = drafts.load(2_000);
  assert.equal(restored?.idempotencyKey, "web-original");
  const form = restoreFormState(restored!);
  assert.equal(form.idempotencyKey, "web-original");
});

test("V020: media bytes are never stored, and only accepted uploads are remembered", () => {
  const store = memoryStore();
  const drafts = new DraftStore(store);
  drafts.recordConsent("granted");

  const sending: UploadState = { phase: "sending", percent: 60, attempts: 0, objectReference: "r" };
  drafts.save(draftInput({ photo: sending }), 1_000);
  const withUnfinished = drafts.load(1_000);
  assert.equal(
    withUnfinished?.photoReference,
    undefined,
    "an unfinished upload must not be restored as an attached photo",
  );

  drafts.save(draftInput({ photo: accepted("2026-09/ok") }), 1_000);
  const raw = store.map.get("vision.draft.v1") ?? "";
  assert.match(raw, /2026-09\/ok/);
  assert.equal(raw.includes("base64"), false, "no encoded media may reach device storage");
  assert.equal(restoreFormState(drafts.load(1_000)!).photo.phase, "accepted");
});

test("V020: a draft past its disclosed lifetime is deleted on load", () => {
  const store = memoryStore();
  const drafts = new DraftStore(store);
  drafts.recordConsent("granted");
  drafts.save(draftInput(), 0);

  const justInside = DRAFT_TTL_HOURS * 3_600_000 - 1;
  assert.notEqual(drafts.load(justInside), undefined);

  const past = DRAFT_TTL_HOURS * 3_600_000;
  assert.equal(drafts.load(past), undefined, "the disclosed lifetime is enforced, not just stated");
  assert.equal(store.map.has("vision.draft.v1"), false, "expiry deletes rather than hides");
});

test("V020: corrupted or hand-edited device storage never becomes form state", () => {
  const store = memoryStore();
  const drafts = new DraftStore(store);
  drafts.recordConsent("granted");

  store.map.set("vision.draft.v1", "{not json");
  assert.equal(drafts.load(1_000), undefined);

  store.map.set("vision.draft.v1", JSON.stringify({ savedAtMs: 1, text: 5 }));
  assert.equal(drafts.load(1_000), undefined);

  store.map.set(
    "vision.draft.v1",
    JSON.stringify({
      savedAtMs: 1,
      idempotencyKey: "k",
      interfaceLocale: "en-IN",
      text: "ok",
      location: {
        lat: "not a number",
        lon: 1,
        source: "manual_pin",
        observedAt: "2026-01-01T00:00:00Z",
      },
    }),
  );
  const loaded = drafts.load(1_000);
  assert.notEqual(loaded, undefined, "a valid draft with an invalid location still loads");
  assert.equal(loaded?.location, undefined, "the unusable location is dropped, not trusted");
});

test("V020: an unknown location source is rejected rather than defaulted", () => {
  const store = memoryStore();
  const drafts = new DraftStore(store);
  drafts.recordConsent("granted");
  store.map.set(
    "vision.draft.v1",
    JSON.stringify({
      savedAtMs: 1,
      idempotencyKey: "k",
      interfaceLocale: "en-IN",
      text: "ok",
      location: {
        lat: 16.8,
        lon: 74.5,
        source: "verified_gps",
        observedAt: "2026-01-01T00:00:00Z",
      },
    }),
  );
  assert.equal(
    drafts.load(1_000)?.location,
    undefined,
    "a source the contract does not define must never be honoured",
  );
});

test("V020: sign-out clears both the draft and the consent decision", () => {
  const store = memoryStore();
  const drafts = new DraftStore(store);
  drafts.recordConsent("granted");
  drafts.save(draftInput(), 1_000);

  drafts.clearAll();
  assert.equal(store.map.size, 0);
  assert.equal(drafts.consent(), "unasked", "the next citizen on this device is asked again");
});

test("V020: a storage failure is reported rather than losing the report silently", () => {
  const failing: KeyValueStore = {
    getItem: (key) => (key === "vision.draft-consent.v1" ? "granted" : null),
    setItem: (key) => {
      if (key === "vision.draft.v1") throw new Error("QuotaExceededError");
    },
    removeItem: () => {},
  };
  const drafts = new DraftStore(failing);
  assert.equal(
    drafts.save(draftInput(), 1_000),
    false,
    "the interface must be able to say the draft was not kept",
  );
});

test("V019: locale packs are data, so the catalogue is what names a language", () => {
  // Nothing outside src/locales/ may hard-code a language tag (V001 App. G
  // rule 7). This asserts the shape the rest of the app depends on.
  const packs: readonly LocalePack[] = CATALOGUE.packs;
  assert.equal(packs.length >= 2, true);
  for (const pack of packs) {
    assert.match(pack.code, /^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/);
    assert.equal(pack.endonym.trim().length > 0, true, "a language must name itself");
  }
});

/**
 * Guards against dead and missing interface strings.
 *
 * A key defined but never rendered is a promise the interface does not keep
 * (a disclosed draft lifetime that is never shown, for instance), and a key
 * rendered but not defined would throw at runtime. Both are cheap to check
 * and expensive to notice by eye.
 */
test("V019: every locale key is rendered somewhere, and every rendered key exists", async () => {
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = dirname(fileURLToPath(import.meta.url));
  // The pure modules also name keys: `describeLocation` returns which heading
  // and note to render, `checkFile` which rejection to show. A key named there
  // is as reachable as one named in the markup.
  const sources = await Promise.all(
    [
      "main.ts",
      "location.ts",
      "upload.ts",
      "submission.ts",
      "drafts.ts",
      // The evidence rail renders its own labels and states rather than
      // routing them through main.ts, so its keys are reachable from here.
      "evidence-rail.ts",
      // V035 chooses which *key* describes a resolution state rather than
      // writing the sentence, so the keys are named here and rendered by
      // main.ts. Same reasoning as the rail above.
      "tracking.ts",
      // Renamed when the landing page took `/`; the citizen app is now app.html.
      "../public/app.html",
    ].map((file) => readFile(join(here, file), "utf8")),
  );
  const used = sources.join("\n");

  const declared = Object.keys(enIN.strings);
  const unused = declared.filter((key) => !used.includes(`"${key}"`));
  assert.deepEqual(unused, [], "these strings are defined but never shown to anyone");

  // Keys referenced by the interface must exist in the source pack.
  const referenced = new Set<string>();
  for (const match of used.matchAll(/data-i18n="([\w.]+)"/g)) referenced.add(match[1] ?? "");
  for (const match of used.matchAll(/\bt\("([\w.]+)"/g)) referenced.add(match[1] ?? "");
  const missing = [...referenced].filter((key) => !declared.includes(key));
  assert.deepEqual(missing, [], "the interface renders keys the locale pack does not define");
});
