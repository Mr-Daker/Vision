/**
 * Voice transcription adapter tests (roadmap V024, gated by V005 §§4-7).
 *
 * Raw audio crossing to an external processor is the most sensitive thing this
 * system does, so the adapter is built so that it *cannot* be used without
 * proof that an active consent record includes the voice purpose. The proof is
 * a constructor argument, which makes "transcribe first, check consent later"
 * unexpressible rather than merely discouraged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { newCorrelationId, unsafeBcp47, type AdapterCallContext } from "@vision/contracts";

import {
  GeminiTranscriptionAdapter,
  proveVoiceConsent,
  VoiceConsentError,
} from "./gemini-transcription.ts";
import type { GeminiTransport } from "./gemini.ts";

const API_KEY = "test-key-never-logged-0123456789";
const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]);

const context = (): AdapterCallContext => ({ correlation_id: newCorrelationId() });

const grantedConsent = {
  consentId: "11111111-1111-1111-1111-111111111111",
  noticeVersion: "notice.v1",
  grantedPurposes: ["demo_processing", "gemini_voice_transcription"],
  withdrawnAt: undefined,
};

const recording = (reply: unknown, status = 200) => {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const transport: GeminiTransport = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
    return { status, json: async () => reply };
  };
  return { transport, calls };
};

const transcriptReply = (text: string, language = "en-IN") => ({
  candidates: [
    {
      content: {
        parts: [
          {
            text: JSON.stringify({
              transcript: text,
              detected_language: language,
              uncertain: false,
            }),
          },
        ],
      },
      finishReason: "STOP",
    },
  ],
  responseId: "resp-voice-1",
});

const adapterWith = (transport: GeminiTransport, audio: Uint8Array = AUDIO) =>
  new GeminiTranscriptionAdapter({
    apiKey: API_KEY,
    transcriptionModel: "gemini-3.5-transcribe",
    consent: proveVoiceConsent(grantedConsent),
    readAudio: async () => audio,
    transport,
  });

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

test("V024: consent without the voice purpose cannot be proved", () => {
  assert.throws(
    () => proveVoiceConsent({ ...grantedConsent, grantedPurposes: ["demo_processing"] }),
    VoiceConsentError,
  );
});

test("V024: general demo consent never implies the voice purpose", () => {
  // V003 is explicit: an optional purpose is never inferred from a general
  // grant. This is the code-level expression of that rule.
  assert.throws(
    () =>
      proveVoiceConsent({
        ...grantedConsent,
        grantedPurposes: ["demo_processing", "public_derivative", "gemini_classification"],
      }),
    VoiceConsentError,
  );
});

test("V024: withdrawn consent cannot be proved", () => {
  assert.throws(
    () => proveVoiceConsent({ ...grantedConsent, withdrawnAt: "2026-09-01T00:00:00Z" }),
    VoiceConsentError,
  );
});

test("V024: a granted, active voice consent proves and records its notice version", () => {
  const proof = proveVoiceConsent(grantedConsent);

  assert.equal(proof.consentId, grantedConsent.consentId);
  assert.equal(proof.noticeVersion, "notice.v1");
});

// ---------------------------------------------------------------------------
// What is sent
// ---------------------------------------------------------------------------

test("V024: the audio is sent inline with its media type and the key in a header", async () => {
  const { transport, calls } = recording(transcriptReply("the roof leaks"));

  await adapterWith(transport).transcribe(
    { audio_object_reference: "originals/2026-09/voice-1" },
    context(),
  );

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]?.url ?? "", /test-key/);
  assert.equal(calls[0]?.headers["x-goog-api-key"], API_KEY);
  const body = JSON.stringify(calls[0]?.body);
  assert.match(body, /inline_data|inlineData/, "audio must travel as inline data");
});

test("V024: no identity value accompanies the audio", async () => {
  const { transport, calls } = recording(transcriptReply("the roof leaks"));

  await adapterWith(transport).transcribe(
    { audio_object_reference: "originals/2026-09/voice-1" },
    context(),
  );

  const body = JSON.stringify(calls[0]?.body);
  for (const forbidden of ["participant", "session", "identity", "consent"]) {
    assert.doesNotMatch(body, new RegExp(forbidden, "i"), `${forbidden} must not be sent`);
  }
});

test("V024: empty audio is refused before anything is sent", async () => {
  const { transport, calls } = recording(transcriptReply("x"));

  const outcome = await adapterWith(transport, new Uint8Array()).transcribe(
    { audio_object_reference: "originals/2026-09/voice-1" },
    context(),
  );

  assert.equal(outcome.kind, "rejected");
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

test("V024: a transcript is returned verbatim and marked as externally processed", async () => {
  // Mixed case and surrounding whitespace on purpose: a transcript that is
  // silently trimmed or lower-cased is no longer what was said, and Marathi
  // text alone cannot detect that because it has neither.
  const spoken = "  The Roof of Room 4 Leaks.  शाळेची गटार तुंबली आहे.  ";
  const { transport } = recording(transcriptReply(spoken, "mr-IN"));

  const outcome = await adapterWith(transport).transcribe(
    {
      audio_object_reference: "originals/2026-09/voice-1",
      expected_language: unsafeBcp47("mr-IN"),
    },
    context(),
  );

  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;
  assert.equal(outcome.value.transcript_text, spoken, "the words must not be altered");
  assert.equal(outcome.value.detected_language, "mr-IN");
  // A model's reading of audio is external but unauthenticated: nothing may
  // present it as a confirmed record of what was said.
  assert.equal(outcome.provenance.authenticity, "unauthenticated_external");
  assert.equal(outcome.provenance.provider_mode, "real");
  // The notice promises to disclose that audio left the boundary, so this must
  // never be false for a real provider.
  assert.equal(outcome.value.processed_externally, true);
  assert.equal(
    outcome.value.input_hash,
    createHash("sha256").update(Buffer.from(AUDIO)).digest("hex"),
  );
});

test("V024: an uncertain transcription is surfaced rather than returned as clean text", async () => {
  const { transport } = recording({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                transcript: "the ... roof ...",
                detected_language: "en-IN",
                uncertain: true,
              }),
            },
          ],
        },
      },
    ],
  });

  const outcome = await adapterWith(transport).transcribe(
    { audio_object_reference: "originals/2026-09/voice-1" },
    context(),
  );

  assert.equal(outcome.kind, "ambiguous", "an uncertain transcript is not a clean success");
});

test("V024: a reply that omits the uncertainty flag is treated as uncertain", async () => {
  // "The model did not say" is not "the model was confident". Defaulting the
  // other way would quietly promote an unverified transcript to settled text.
  const { transport } = recording({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                transcript: "the roof leaks badly",
                detected_language: "en-IN",
              }),
            },
          ],
        },
      },
    ],
  });

  const outcome = await adapterWith(transport).transcribe(
    { audio_object_reference: "originals/2026-09/voice-1" },
    context(),
  );

  assert.equal(outcome.kind, "ambiguous");
});

test("V024: a reply that is not the agreed schema is refused, not guessed at", async () => {
  for (const bad of [
    { candidates: [] },
    {},
    // Not JSON at all.
    { candidates: [{ content: { parts: [{ text: "hello" }] } }] },
    // Valid JSON in the agreed shape but with no transcript. The one field the
    // whole call exists to obtain is the one that must not be optional.
    {
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify({ detected_language: "en-IN", uncertain: false }) }],
          },
        },
      ],
    },
    {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  transcript: "",
                  detected_language: "en-IN",
                  uncertain: false,
                }),
              },
            ],
          },
        },
      ],
    },
    // No detected language. V024 routes on the language, so accepting a reply
    // without one would send an unknown language down the enabled-language
    // path and silently lose the very uncertainty that matters.
    {
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify({ transcript: "the roof leaks", uncertain: false }) }],
          },
        },
      ],
    },
  ]) {
    const { transport } = recording(bad);

    const outcome = await adapterWith(transport).transcribe(
      { audio_object_reference: "originals/2026-09/voice-1" },
      context(),
    );

    assert.notEqual(outcome.kind, "success", `${JSON.stringify(bad)} must not be accepted`);
  }
});

test("V024: a provider error never leaks the key", async () => {
  const { transport } = recording({ error: { message: `bad ${API_KEY}` } }, 403);

  const outcome = await adapterWith(transport).transcribe(
    { audio_object_reference: "originals/2026-09/voice-1" },
    context(),
  );

  assert.notEqual(outcome.kind, "success");
  assert.doesNotMatch(JSON.stringify(outcome), new RegExp(API_KEY));
});

test("V024: the adapter labels itself real and refuses to claim an exact transcript", () => {
  const { transport } = recording(transcriptReply("x"));

  const descriptor = adapterWith(transport).descriptor;

  assert.equal(descriptor.provider_mode, "real");
  assert.match(descriptor.capability.must_not_claim.join(" "), /exact|verbatim|accurate/i);
});

test("V024: an ambiguous transcript declares that it requires review", async () => {
  const { transport } = recording({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                transcript: "the roof maybe leaks",
                detected_language: "en-IN",
                uncertain: true,
              }),
            },
          ],
        },
      },
    ],
  });

  const outcome = await adapterWith(transport).transcribe(
    { audio_object_reference: "originals/2026-09/voice-1" },
    context(),
  );

  assert.equal(outcome.kind, "ambiguous");
  if (outcome.kind !== "ambiguous") return;
  // An ambiguous transcript that did not ask for review would be a clean
  // success wearing a different label.
  assert.equal(outcome.requires_review, true);
  assert.equal(outcome.candidates.length, 1);
  assert.equal(outcome.candidates[0]?.transcript_text, "the roof maybe leaks");
});

// ---------------------------------------------------------------------------
// The shape the configured model actually speaks (V024)
// ---------------------------------------------------------------------------

/**
 * A reply exactly as `gemini-3.5-transcribe` returned it on 2026-09-11.
 *
 * The transcript arrives in `parts[0].audioTranscription.text`, not
 * `parts[0].text`, and there is no JSON envelope — the model rejects JSON mode.
 * Every unit test before this one asserted against a fixture the adapter
 * itself invented, so all of them passed while no real call could ever succeed.
 */
const REAL_REPLY = {
  candidates: [
    {
      content: {
        parts: [{ audioTranscription: { text: "The drain outside the school gate is blocked." } }],
        role: "model",
      },
      finishReason: "STOP",
      index: 0,
    },
  ],
  modelVersion: "gemini-3.5-transcribe",
  responseId: "Zw-kapTOJsS3qfkP8r-voQY",
};

test("V024: the reply shape the configured model actually returns is understood", async () => {
  const outcome = await adapterWith(async () => ({
    status: 200,
    json: async () => REAL_REPLY,
  })).transcribe({ audio_object_reference: "originals/2026-09/voice-1" }, context());

  assert.equal(outcome.kind, "success", `unexpected outcome: ${JSON.stringify(outcome)}`);
  if (outcome.kind !== "success") return;
  assert.equal(outcome.value.transcript_text, "The drain outside the school gate is blocked.");
});

test("V024: the request carries no system instruction, which this model refuses", async () => {
  // Live, a `system_instruction` came back 400 "Developer instruction is not
  // enabled for this model" — so every real call failed. The instruction is
  // still sent, as a text part alongside the audio; what changes is where.
  let sent: Record<string, unknown> = {};
  await adapterWith(async (_url, init) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    return { status: 200, json: async () => REAL_REPLY };
  }).transcribe({ audio_object_reference: "originals/2026-09/voice-1" }, context());

  assert.equal(Object.hasOwn(sent, "system_instruction"), false);
  assert.equal(Object.hasOwn(sent, "systemInstruction"), false);
  const parts = (sent["contents"] as { parts: { text?: string }[] }[])[0]?.parts ?? [];
  assert.ok(
    parts.some((part) => (part.text ?? "").includes("Transcribe")),
    "the instruction must still reach the model, as a text part",
  );
});

test("V024: the request does not ask for JSON mode, which this model refuses", async () => {
  // Live, `responseMimeType: application/json` came back 400 "JSON mode is not
  // enabled for this model".
  let sent: Record<string, unknown> = {};
  await adapterWith(async (_url, init) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    return { status: 200, json: async () => REAL_REPLY };
  }).transcribe({ audio_object_reference: "originals/2026-09/voice-1" }, context());

  const generation = (sent["generationConfig"] ?? {}) as Record<string, unknown>;
  assert.equal(generation["responseMimeType"], undefined);
});

test("V024: a 400 is permanent, not something to retry forever", async () => {
  // A malformed request does not become well-formed by being sent again. This
  // adapter reported every 4xx as `retryable: true`, which is how a relay
  // burns its budget against a request that can never succeed — the same
  // failure family as the blank model name that looked like an outage.
  const outcome = await adapterWith(async () => ({
    status: 400,
    json: async () => ({ error: { code: 400, message: "Developer instruction is not enabled" } }),
  })).transcribe({ audio_object_reference: "originals/2026-09/voice-1" }, context());

  // `rejected`, not `unavailable`: the contract types an unavailable outcome
  // as `retryable: true`, so a permanent failure cannot be one. The kind is
  // the claim, and it has to be the honest one.
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") return;
  assert.equal(outcome.retryable, false);
});

test("V024: a 503 is still worth retrying", async () => {
  // The provider answered 503 "experiencing high demand" repeatedly while this
  // was being verified. That one genuinely does clear on its own.
  const outcome = await adapterWith(async () => ({
    status: 503,
    json: async () => ({}),
  })).transcribe({ audio_object_reference: "originals/2026-09/voice-1" }, context());

  assert.equal(outcome.kind, "unavailable");
  if (outcome.kind !== "unavailable") return;
  assert.equal(outcome.retryable, true);
});

test("V024: no language is claimed to have been detected when none was", async () => {
  // This model returns words and nothing else — no language tag. Echoing back
  // whatever the caller expected, labelled as `detected_language`, would be
  // reporting a detection nobody performed: a Marathi recording submitted with
  // an "en-IN" hint would come back asserting English.
  const outcome = await adapterWith(async () => ({
    status: 200,
    json: async () => REAL_REPLY,
  })).transcribe({ audio_object_reference: "originals/2026-09/voice-1" }, context());

  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;
  // `und` is the ISO 639-2 code for "undetermined": the honest answer.
  assert.equal(String(outcome.value.detected_language), "und");
});

test("V024: a declared language is echoed as declared, not as detected", async () => {
  const outcome = await adapterWith(async () => ({
    status: 200,
    json: async () => REAL_REPLY,
  })).transcribe(
    {
      audio_object_reference: "originals/2026-09/voice-1",
      expected_language: unsafeBcp47("mr-IN"),
    },
    context(),
  );

  assert.equal(outcome.kind, "success");
  if (outcome.kind !== "success") return;
  // The caller said Marathi, so Marathi comes back — but only because the
  // caller said so, never because the model worked it out.
  assert.equal(String(outcome.value.detected_language), "mr-IN");
});

test("V024: a 429 stays retryable, because the quota resets", async () => {
  // The free tier answers 429 in ordinary use — five requests a minute. It is
  // a 4xx, but it is about timing rather than the shape of the request, so it
  // is the one client error that retrying does fix. Filing it as permanent
  // would drop every report that arrived in a busy minute.
  const outcome = await adapterWith(async () => ({
    status: 429,
    json: async () => ({}),
  })).transcribe({ audio_object_reference: "originals/2026-09/voice-1" }, context());

  assert.equal(outcome.kind, "unavailable");
  if (outcome.kind !== "unavailable") return;
  assert.equal(outcome.retryable, true);
});
