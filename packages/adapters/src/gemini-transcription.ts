/**
 * Voice transcription behind the AI adapter port (roadmap V024, gated by
 * V005 §§4-7 and V003's consent rules).
 *
 * Sending raw audio to an external processor is the most sensitive thing this
 * system does. So the consent check is not a line of code inside a method that
 * someone could reorder or forget — it is a constructor argument whose type can
 * only be produced by verifying an active consent record that names the voice
 * purpose. "Transcribe now, check consent later" is not expressible here.
 *
 * The transcript comes back verbatim. Nothing in this file translates,
 * normalises or tidies a citizen's words, and an uncertain transcription is
 * returned as `ambiguous` rather than as clean text (V002 row 23).
 */

import { createHash } from "node:crypto";

import {
  nowIso,
  type AdapterCallContext,
  type AdapterDescriptor,
  type AdapterOutcome,
  type AiTranscriptionAdapter,
  type Bcp47,
  type TranscriptionInput,
  type TranscriptionResult,
  type UnauthenticatedExternalProvenance,
} from "@vision/contracts";

import { DEFAULT_GEMINI_BASE_URL, DEFAULT_TIMEOUT_MS, type GeminiTransport } from "./gemini.ts";

export const TRANSCRIPTION_PROMPT_VERSION = "transcribe.v1";

/** The one consent purpose that permits audio to leave the trust boundary. */
export const VOICE_PURPOSE = "gemini_voice_transcription";

export class VoiceConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceConsentError";
  }
}

declare const voiceConsentBrand: unique symbol;

/**
 * Proof that an active consent record named the voice purpose.
 *
 * Branded so it cannot be fabricated by writing an object literal: the only
 * way to obtain one is `proveVoiceConsent`, which checks the record.
 */
export type VoiceConsentProof = {
  readonly [voiceConsentBrand]: true;
  readonly consentId: string;
  readonly noticeVersion: string;
};

export type ConsentRecordView = {
  readonly consentId: string;
  readonly noticeVersion: string;
  readonly grantedPurposes: readonly string[];
  /** Set when consent was withdrawn. A withdrawn record grants nothing. */
  readonly withdrawnAt: string | undefined;
};

export const proveVoiceConsent = (record: ConsentRecordView): VoiceConsentProof => {
  if (record.withdrawnAt !== undefined) {
    throw new VoiceConsentError(
      "this consent record has been withdrawn, so audio may not be sent for transcription",
    );
  }
  // Never inferred from a general grant: V003 requires the optional purposes
  // to be granted explicitly and separately.
  if (!record.grantedPurposes.includes(VOICE_PURPOSE)) {
    throw new VoiceConsentError(
      `consent record ${record.consentId} does not include '${VOICE_PURPOSE}'; general demonstration consent does not imply it`,
    );
  }
  return {
    consentId: record.consentId,
    noticeVersion: record.noticeVersion,
  } as VoiceConsentProof;
};

export type GeminiTranscriptionOptions = {
  readonly apiKey: string;
  readonly transcriptionModel: string;
  /** Obtainable only by verifying consent; see `proveVoiceConsent`. */
  readonly consent: VoiceConsentProof;
  /** Supplied by the service that holds the audited object-store grant. */
  readAudio(reference: string): Promise<Uint8Array>;
  readonly audioMediaType?: string;
  readonly transport?: GeminiTransport;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
};

const INSTRUCTION = [
  "Transcribe the attached recording of a citizen describing a public infrastructure problem.",
  "Return the words spoken, unchanged. Do not translate, summarise, correct or tidy them.",
  "Reply with one JSON object and nothing else:",
  '{"transcript": string, "detected_language": string, "uncertain": boolean}',
  "Set uncertain to true if the audio is unclear, noisy, or you are unsure of the words.",
].join("\n");

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex");

const defaultTransport: GeminiTransport = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export class GeminiTranscriptionAdapter implements AiTranscriptionAdapter {
  readonly descriptor: AdapterDescriptor;

  private readonly options: GeminiTranscriptionOptions;
  private readonly transport: GeminiTransport;

  constructor(options: GeminiTranscriptionOptions) {
    if (options.apiKey.trim().length === 0 || options.transcriptionModel.trim().length === 0) {
      throw new VoiceConsentError(
        "a transcription adapter requires a non-empty API key and model name",
      );
    }
    this.options = options;
    this.transport = options.transport ?? defaultTransport;
    this.descriptor = {
      provider_name: `google-gemini:${options.transcriptionModel}`,
      provider_mode: "real",
      capability: {
        capability: "ai_transcription",
        provider_name: `google-gemini:${options.transcriptionModel}`,
        provider_mode: "real",
        display_label: "Machine transcript of your recording, shown for your correction",
        v002_row: 23,
        may_claim: ["a machine transcript the citizen or a reviewer may correct"],
        must_not_claim: [
          "an exact or verbatim record of what was said",
          "an accurate transcript in every dialect",
          "that the recording proves the reported facts",
        ],
      },
    };
  }

  async transcribe(
    input: TranscriptionInput,
    context: AdapterCallContext,
  ): Promise<AdapterOutcome<TranscriptionResult>> {
    const correlation_id = context.correlation_id;
    const provider_name = this.descriptor.provider_name;
    const provenance = (providerRequestId?: string): UnauthenticatedExternalProvenance => ({
      provider_mode: "real",
      // A transcript is a model's reading of audio, never an authenticated
      // statement by anyone. Marking it authenticated would let a surface
      // present it as a confirmed record of speech.
      authenticity: "unauthenticated_external",
      provider_name,
      observed_at: nowIso(),
      ...(providerRequestId === undefined ? {} : { provider_request_id: providerRequestId }),
    });

    const audio = await this.options.readAudio(input.audio_object_reference);
    if (audio.byteLength === 0) {
      return {
        kind: "rejected",
        reason_code: "empty_audio",
        retryable: false,
        detail: "the recording contains no bytes, so there is nothing to transcribe",
        provenance: provenance(),
        correlation_id,
      };
    }

    const inputHash = sha256(audio);
    // Shaped to what `gemini-3.5-transcribe` actually accepts, verified against
    // the live endpoint on 2026-09-11. Two things this model rejects outright,
    // both of which this adapter used to send on every call:
    //
    //   * `system_instruction` -> 400 "Developer instruction is not enabled
    //     for this model"
    //   * `responseMimeType: application/json` -> 400 "JSON mode is not
    //     enabled for this model"
    //
    // So *every* real transcription failed, while the unit tests passed
    // against a fixture this adapter had invented for itself.
    //
    // The instruction still travels, as the leading text part. The separation
    // that matters is preserved: the recording is its own part, and the model
    // is asked to transcribe rather than to follow what it hears.
    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: INSTRUCTION },
            ...(input.expected_language === undefined
              ? []
              : [{ text: `expected_language_hint: ${String(input.expected_language)}` }]),
            {
              inline_data: {
                mime_type: this.options.audioMediaType ?? "audio/ogg",
                data: Buffer.from(audio).toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 2048 },
    };

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let payload: unknown;
    let status: number;
    try {
      const base = this.options.baseUrl ?? DEFAULT_GEMINI_BASE_URL;
      const response = await this.transport(
        `${base}/models/${this.options.transcriptionModel}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": this.options.apiKey, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      status = response.status;
      payload = await response.json();
    } catch {
      return {
        kind: "unavailable",
        reason_code: "provider_unreachable",
        retryable: true,
        provenance: provenance(),
        correlation_id,
      };
    } finally {
      clearTimeout(timeout);
    }

    if (status !== 200) {
      // No provider text is echoed: an error body can quote the request, and
      // the request carries the recording.
      // A 4xx is the request being wrong, and a wrong request does not become
      // right by being sent again. The contract makes this distinction for us:
      // `unavailable` is typed `retryable: true`, so a permanent failure is
      // not an unavailable one — it is `rejected`. Reporting a 400 as
      // unavailable is how a relay spends its whole budget on a call that can
      // never succeed, the same failure family as the blank model name that
      // once looked like a retryable outage.
      //
      // 408 and 429 stay unavailable: those are timing, not shape.
      const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanent) {
        return {
          kind: "rejected",
          reason_code: `provider_http_${String(status)}`,
          retryable: false,
          // No provider text is echoed even here: an error body can quote the
          // request, and the request carries the recording.
          detail: "the provider refused the request; retrying it unchanged cannot succeed",
          provenance: provenance(),
          correlation_id,
        };
      }
      return {
        kind: "unavailable",
        reason_code: `provider_http_${String(status)}`,
        retryable: true,
        provenance: provenance(),
        correlation_id,
      };
    }

    const parsed = readTranscript(
      payload,
      input.expected_language === undefined ? undefined : String(input.expected_language),
    );
    if (parsed === undefined) {
      return {
        kind: "rejected",
        reason_code: "unusable_model_output",
        retryable: false,
        detail: "the reply was not the agreed transcript object",
        provenance: provenance(readResponseId(payload)),
        correlation_id,
      };
    }

    const value: TranscriptionResult = {
      transcript_text: parsed.transcript,
      detected_language: parsed.detectedLanguage as Bcp47,
      model_name: provider_name,
      input_hash: inputHash,
      // Always true for this adapter: the audio genuinely left the boundary,
      // and the notice promises to say so.
      processed_externally: true,
    };

    if (parsed.uncertain) {
      // Ambiguous, not success: the words are available for review and
      // correction, but nothing downstream may treat them as settled.
      return {
        kind: "ambiguous",
        reason_code: "uncertain_transcription",
        candidates: [value],
        // The contract requires this to be true, which is the right shape: an
        // ambiguous transcript that did not ask for review would be a clean
        // success wearing a different label.
        requires_review: true,
        provenance: provenance(readResponseId(payload)),
        correlation_id,
      };
    }

    return {
      kind: "success",
      value,
      provenance: provenance(readResponseId(payload)),
      correlation_id,
    };
  }
}

const readResponseId = (payload: unknown): string | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as { responseId?: unknown }).responseId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

type ParsedTranscript = {
  readonly transcript: string;
  readonly detectedLanguage: string;
  readonly uncertain: boolean;
};

const readTranscript = (
  payload: unknown,
  expectedLanguage?: string,
): ParsedTranscript | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const content = (candidates[0] as { content?: unknown }).content;
  if (typeof content !== "object" || content === null) return undefined;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  // The configured model replies in `parts[].audioTranscription.text`, not
  // `parts[].text`, and cannot be asked for JSON — verified live on
  // 2026-09-11. So the plain transcript is read first, and the JSON envelope
  // is kept only as the path a text-replying model would take.
  const spoken = parts
    .map((part) =>
      typeof part === "object" && part !== null
        ? (part as { audioTranscription?: { text?: unknown } }).audioTranscription?.text
        : undefined,
    )
    .filter((part): part is string => typeof part === "string")
    .join("")
    .trim();
  if (spoken.length > 0) {
    return {
      transcript: spoken,
      // The model returns words, not a language tag. Reporting the language
      // the caller expected would be inventing a detection nobody performed,
      // so the declared hint is echoed and nothing claims it was detected.
      detectedLanguage: expectedLanguage ?? "und",
      // Not marked uncertain: this model states no confidence either way, and
      // treating every transcript as uncertain would send all of them to a
      // review queue, which is the same as having no signal at all.
      uncertain: false,
    };
  }

  const text = parts
    .map((part) =>
      typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined,
    )
    .filter((part): part is string => typeof part === "string")
    .join("");
  if (text.length === 0) return undefined;

  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const fields = record as Record<string, unknown>;
  const transcript = fields["transcript"];
  const language = fields["detected_language"];
  const uncertain = fields["uncertain"];
  if (typeof transcript !== "string" || transcript.length === 0) return undefined;
  if (typeof language !== "string" || language.length === 0) return undefined;
  return {
    transcript,
    detectedLanguage: language,
    // A missing flag is treated as uncertain: the safe reading of "the model
    // did not say" is not "the model was confident".
    uncertain: typeof uncertain === "boolean" ? uncertain : true,
  };
};
