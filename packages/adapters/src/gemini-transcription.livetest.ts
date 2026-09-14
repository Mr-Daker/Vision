/**
 * Real audio, really transcribed (roadmap V024).
 *
 * Run with: npm run test:live
 *
 * V024 recorded: "**No real audio has been transcribed.** `gemini-3.5-transcribe`
 * is configured and the adapter is unit-tested against a stubbed transport, but
 * no live audio call has been made — so the transcription integration is
 * **verification pending**."
 *
 * This is the test that closes it. The audio is *generated*, not recorded: a
 * real person's voice is exactly the kind of data V005 says not to collect for
 * a test, and no citizen has consented to their recording living in a repo. So
 * a Gemini text-to-speech model speaks a known sentence, the PCM it returns is
 * wrapped in a WAV header here (no dependency — the header is 44 bytes), and
 * that is what gets transcribed.
 *
 * Because the sentence is known, this checks the one thing a stub cannot: that
 * the words come back. A stubbed transport can only ever prove the adapter
 * parses its own fixture.
 *
 * The free tier is the limiting factor, not the code. `gemini-3.5-transcribe`
 * answered 503 "experiencing high demand" repeatedly on 2026-09-11 and then
 * 429 once the day's quota went, so this skips on both rather than failing —
 * an unavailable provider is the environment. A transcript that arrives and is
 * *wrong* is not skippable.
 */

import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

import { newCorrelationId, unsafeBcp47, type AdapterCallContext } from "@vision/contracts";

import { DEFAULT_TIMEOUT_MS } from "./gemini.ts";
import {
  GeminiTranscriptionAdapter,
  proveVoiceConsent,
  VOICE_PURPOSE,
} from "./gemini-transcription.ts";

const apiKey = process.env["GEMINI_API_KEY"] ?? "";
const transcriptionModel = process.env["GEMINI_TRANSCRIPTION_MODEL"] ?? "";
const speechModel = process.env["GEMINI_SPEECH_MODEL"] ?? "gemini-2.5-flash-preview-tts";
const skip =
  apiKey.length === 0 || transcriptionModel.length === 0
    ? "GEMINI_API_KEY or GEMINI_TRANSCRIPTION_MODEL is not set"
    : false;

const SPOKEN = "The drain outside the school gate is blocked.";

const context = (): AdapterCallContext => ({ correlation_id: newCorrelationId() });

/** Provider conditions that are the environment rather than a defect here. */
const unavailableUpstream = (outcome: { kind: string; reason_code?: string }): boolean =>
  outcome.kind === "unavailable" &&
  ["provider_http_429", "provider_http_503", "provider_unreachable"].includes(
    outcome.reason_code ?? "",
  );

/**
 * Wraps raw 16-bit mono PCM in a WAV header.
 *
 * The speech model returns `audio/L16;codec=pcm;rate=24000`, which is headerless
 * samples. Sending those as `audio/wav` without the header would have the
 * provider read sample data as a header and transcribe noise — a failure that
 * looks like a bad model rather than a bad request.
 */
const toWav = (pcm: Uint8Array, sampleRate: number): Uint8Array => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
};

/** Speaks `SPOKEN` with a text-to-speech model, returning WAV bytes. */
const speak = async (): Promise<{ wav: Uint8Array } | { unavailable: string }> => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${speechModel}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Say clearly, and only this: ${SPOKEN}` }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
        },
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    },
  );
  if (response.status !== 200) return { unavailable: `speech_http_${String(response.status)}` };

  const payload = (await response.json()) as {
    candidates?: {
      content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
    }[];
  };
  const inline = payload.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (inline?.data === undefined) return { unavailable: "speech_returned_no_audio" };

  // The rate travels in the mime type (`audio/L16;codec=pcm;rate=24000`), so it
  // is read rather than assumed — a wrong rate transcribes as gibberish.
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1] ?? "24000");
  return { wav: toWav(Buffer.from(inline.data, "base64"), rate) };
};

test(
  "V024 live: real speech is transcribed back to the words that were spoken",
  { skip },
  async (t) => {
    const spoken = await speak();
    if ("unavailable" in spoken) {
      t.skip(
        `the speech model was unavailable, so there was no audio to transcribe: ${spoken.unavailable}`,
      );
      return;
    }

    const adapter = new GeminiTranscriptionAdapter({
      apiKey,
      transcriptionModel,
      consent: proveVoiceConsent({
        consentId: randomUUID(),
        noticeVersion: "demo-notice.v1",
        grantedPurposes: [VOICE_PURPOSE],
        withdrawnAt: undefined,
      }),
      readAudio: async () => spoken.wav,
      audioMediaType: "audio/wav",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    const outcome = await adapter.transcribe(
      {
        audio_object_reference: "originals/live/generated-speech.wav",
        expected_language: unsafeBcp47("en-IN"),
      },
      context(),
    );

    if (unavailableUpstream(outcome)) {
      t.skip(`the transcription model was unavailable: ${JSON.stringify(outcome)}`);
      return;
    }

    assert.equal(outcome.kind, "success", `unexpected outcome: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "success") return;

    // The sentence is known, so this is the assertion a stub can never make: the
    // words came back. Matched on the distinctive content words rather than the
    // whole string, because punctuation and casing are the model's to choose.
    const transcript = outcome.value.transcript_text.toLowerCase();
    for (const word of ["drain", "school", "blocked"]) {
      assert.ok(
        transcript.includes(word),
        `expected '${word}' in: ${outcome.value.transcript_text}`,
      );
    }
    console.log(`  live transcription: ${JSON.stringify(outcome.value.transcript_text)}`);
  },
);

test(
  "V024 live: a transcript is never presented as an authenticated record",
  { skip },
  async (t) => {
    // A transcript is a model's reading of audio. Marking it authenticated would
    // let a surface present it as a confirmed record of what somebody said —
    // which is exactly the overstatement V002 row 16 forbids, and it matters most
    // for a citizen's own words.
    const spoken = await speak();
    if ("unavailable" in spoken) {
      t.skip(`the speech model was unavailable: ${spoken.unavailable}`);
      return;
    }

    const adapter = new GeminiTranscriptionAdapter({
      apiKey,
      transcriptionModel,
      consent: proveVoiceConsent({
        consentId: randomUUID(),
        noticeVersion: "demo-notice.v1",
        grantedPurposes: [VOICE_PURPOSE],
        withdrawnAt: undefined,
      }),
      readAudio: async () => spoken.wav,
      audioMediaType: "audio/wav",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    const outcome = await adapter.transcribe(
      {
        audio_object_reference: "originals/live/generated-speech.wav",
        expected_language: unsafeBcp47("en-IN"),
      },
      context(),
    );
    if (unavailableUpstream(outcome)) {
      t.skip(`the transcription model was unavailable: ${JSON.stringify(outcome)}`);
      return;
    }
    assert.equal(outcome.kind, "success", `unexpected outcome: ${JSON.stringify(outcome)}`);
    if (outcome.kind !== "success") return;

    assert.equal(outcome.provenance.authenticity, "unauthenticated_external");
    assert.equal(outcome.provenance.provider_mode, "real");
  },
);
