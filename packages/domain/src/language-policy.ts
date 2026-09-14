/**
 * Multilingual understanding policy (roadmap V024, bounding V002 row 23).
 *
 * The failure this prevents is specific: a report in a language nobody has
 * evaluated being machine-translated into a confident label, so the
 * uncertainty vanishes before a reviewer ever sees it. Nothing here translates
 * anything. Every rule is about keeping doubt visible and keeping the
 * citizen's own words intact.
 *
 * The enabled-language list arrives as data from the caller. There is no
 * language name in this file, because a locale is scope and scope lives in
 * configuration (V001 Appendix G rule 7).
 */

/** Below this many characters a transcript is treated as noise rather than speech. */
export const TRANSCRIPT_UNCERTAINTY_FLOOR = 8;

export type LanguageHandlingInput = {
  /** BCP 47 tag the provider reported, or `undefined` when it reported none. */
  readonly detected: string | undefined;
  readonly enabled: readonly string[];
};

export type LanguageHandlingDecision = {
  readonly enabled: boolean;
  readonly requiresReview: boolean;
  readonly mayAutoClassify: boolean;
  /** Always false. This module never translates, and says so where callers can see it. */
  readonly translated: false;
  readonly reasons: readonly string[];
};

/** Case-insensitive tag comparison where a base tag matches a regional one and vice versa. */
const tagMatches = (detected: string, enabled: string): boolean => {
  const a = detected.toLowerCase();
  const b = enabled.toLowerCase();
  if (a === b) return true;
  // "mr" must match an enabled "mr-IN": the citizen did not choose the tag,
  // and refusing on a missing region would report a supported language as
  // unsupported.
  const baseA = a.split("-")[0] ?? a;
  const baseB = b.split("-")[0] ?? b;
  return baseA === baseB;
};

export const decideLanguageHandling = (input: LanguageHandlingInput): LanguageHandlingDecision => {
  if (input.detected === undefined || input.detected.trim().length === 0) {
    return {
      enabled: false,
      requiresReview: true,
      mayAutoClassify: false,
      translated: false,
      reasons: [
        "the language of this report was not detected, so it is unknown rather than English",
      ],
    };
  }

  const matched = input.enabled.some((candidate) => tagMatches(input.detected ?? "", candidate));
  if (!matched) {
    return {
      enabled: false,
      requiresReview: true,
      mayAutoClassify: false,
      translated: false,
      reasons: [
        `'${input.detected}' is outside the enabled language pack, so it is routed to review with its original wording rather than translated`,
      ],
    };
  }

  return {
    enabled: true,
    requiresReview: false,
    mayAutoClassify: true,
    translated: false,
    reasons: [],
  };
};

export type TranscriptCorrection = {
  readonly text: string;
  /** Who corrected it. Recorded so a correction is attributable. */
  readonly correctedBy: string;
};

export type TranscriptionAssessmentInput = {
  readonly transcriptText: string;
  readonly detectedLanguage: string | undefined;
  readonly enabled: readonly string[];
  /** The provider's own signal that it was unsure. Never inferred from the text. */
  readonly modelReportedUncertain: boolean;
  readonly correction?: TranscriptCorrection;
};

export type TranscriptionAssessment = {
  /** Exactly what the provider returned. Never overwritten. */
  readonly originalText: string;
  /** What downstream steps should read: the correction when there is one, else the original. */
  readonly effectiveText: string;
  /** Always undefined: no translation happens in this codebase. */
  readonly translatedText: undefined;
  readonly corrected: boolean;
  readonly correctedBy: string | undefined;
  readonly language: LanguageHandlingDecision;
  readonly usableForClassification: boolean;
  readonly requiresReview: boolean;
  readonly reasons: readonly string[];
};

/**
 * Decides whether a transcript may feed classification, and why not when it
 * may not.
 *
 * A human correction resolves model uncertainty — that is the whole point of
 * offering a correction path — but it never erases what the model produced.
 */
export const assessTranscription = (
  input: TranscriptionAssessmentInput,
): TranscriptionAssessment => {
  const reasons: string[] = [];
  const language = decideLanguageHandling({
    detected: input.detectedLanguage,
    enabled: input.enabled,
  });
  reasons.push(...language.reasons);

  const correction = input.correction;
  // A blank correction would delete the report under the guise of fixing it.
  const correctionUsable = correction !== undefined && correction.text.trim().length > 0;
  if (correction !== undefined && !correctionUsable) {
    reasons.push("a blank correction was ignored; it would have erased the report");
  }

  const effectiveText = correctionUsable ? correction.text : input.transcriptText;

  // Emptiness is assessed on the text that would actually be used. Silence is
  // "we could not hear anything", not "there is nothing to report".
  const meaningful = effectiveText.replace(/[^\p{L}\p{N}]/gu, "").length;
  const tooLittle = meaningful < TRANSCRIPT_UNCERTAINTY_FLOOR;
  if (tooLittle) {
    reasons.push(
      "the recording produced too little speech to classify; it may be noisy or silent, which is not the same as empty",
    );
  }

  const stillUncertain = input.modelReportedUncertain && !correctionUsable;
  if (stillUncertain) {
    reasons.push("the provider reported an uncertain transcription, so it is shown for review");
  }

  const usableForClassification = language.mayAutoClassify && !tooLittle && !stillUncertain;

  return {
    originalText: input.transcriptText,
    effectiveText,
    translatedText: undefined,
    corrected: correctionUsable,
    correctedBy: correctionUsable ? correction.correctedBy : undefined,
    language,
    usableForClassification,
    requiresReview: !usableForClassification,
    reasons,
  };
};
