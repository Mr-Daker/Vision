/**
 * Redaction policy for AI inputs and public derivatives (roadmap V021,
 * enforcing V005 §§4-7).
 *
 * The policy covers two kinds of disclosure that are not equally tractable,
 * and the difference is deliberately visible in this module's shape.
 *
 * **Contact details in text.** A telephone number, an email address or a long
 * identifier-like digit run can be located deterministically, so they are
 * genuinely removed here and the removal is recorded.
 *
 * **Faces and number plates in photographs.** Locating these requires a
 * detector. This codebase has none, and adding a model or a third-party
 * dependency is not in scope. Rather than pretend a photograph was checked,
 * `decidePhotoRedaction` treats every photograph as an *unresolved* case:
 * `needs_review`, barred from public views and from the normal AI path, which
 * is what V021 requires of an unresolved redaction case. A detector can be
 * supplied later without changing any caller.
 */

/** Shown in place of a removed contact detail. Contains no digits or `@`, so re-running the redactor over its own output finds nothing. */
export const CONTACT_PLACEHOLDER = "[contact detail removed]";

export type ContactRedactionKind = "phone_number" | "email_address" | "long_digit_sequence";

export type ContactRedaction = {
  readonly kind: ContactRedactionKind;
  /** Offset in the original text, so a reviewer can see where a removal happened. */
  readonly start: number;
  readonly end: number;
};

export type TextRedactionResult = {
  readonly redactedText: string;
  readonly redactions: readonly ContactRedaction[];
};

/**
 * A run of digits and separators long enough to be a contact number or an
 * identifier. Letters are excluded, so "3 of 12 taps since 2024" — counts and
 * dates a citizen legitimately wrote — is left alone. Over-redaction would
 * destroy the report, which is its own kind of failure.
 */
const DIGIT_RUN = /\+?\d[\d\s().-]{7,}\d/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const digitCount = (value: string): number => (value.match(/\d/g) ?? []).length;

type Candidate = { kind: ContactRedactionKind; start: number; end: number };

const digitCandidates = (text: string): Candidate[] => {
  const found: Candidate[] = [];
  for (const match of text.matchAll(DIGIT_RUN)) {
    const raw = match[0];
    const digits = digitCount(raw);
    if (digits < 10) continue;
    // Exactly ten digits, or an explicit international prefix, reads as a
    // telephone number; anything longer reads as an identifier. Both are
    // removed — the distinction only affects what the record says was found.
    const kind: ContactRedactionKind =
      digits === 10 || raw.startsWith("+") ? "phone_number" : "long_digit_sequence";
    found.push({ kind, start: match.index, end: match.index + raw.length });
  }
  return found;
};

const emailCandidates = (text: string): Candidate[] =>
  [...text.matchAll(EMAIL)].map((match) => ({
    kind: "email_address" as const,
    start: match.index,
    end: match.index + match[0].length,
  }));

/**
 * Removes contact details from free text or a transcript.
 *
 * The original string is never modified; callers keep it as the citizen's own
 * wording (V024 requires the original to survive) and pass only the redacted
 * form onward.
 */
export const redactContactDetails = (text: string): TextRedactionResult => {
  const candidates = [...emailCandidates(text), ...digitCandidates(text)].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );

  const accepted: Candidate[] = [];
  for (const candidate of candidates) {
    const last = accepted.at(-1);
    // An email can contain a long digit run; the earliest, longest match wins
    // so the same characters are not reported twice.
    if (last !== undefined && candidate.start < last.end) continue;
    accepted.push(candidate);
  }

  let redactedText = "";
  let cursor = 0;
  for (const candidate of accepted) {
    redactedText += text.slice(cursor, candidate.start) + CONTACT_PLACEHOLDER;
    cursor = candidate.end;
  }
  redactedText += text.slice(cursor);

  return {
    redactedText,
    redactions: accepted.map(({ kind, start, end }) => ({ kind, start, end })),
  };
};

export type RedactionRegionKind = "face" | "number_plate";

export type RedactionRegion = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly kind: RedactionRegionKind;
  /** Which detector proposed this region, so provenance survives into review. */
  readonly detectedBy: string;
};

export type PhotoRedactionInput = {
  /** Regions a detector proposed, or `undefined` when no detector ran. */
  readonly regions: readonly RedactionRegion[] | undefined;
  /** Human-readable detector identity, or `undefined` when none ran. */
  readonly detectorLabel: string | undefined;
};

export type PhotoRedactionDecision = {
  readonly status: "approved" | "not_required" | "needs_review";
  readonly reasons: readonly string[];
  readonly regions: readonly RedactionRegion[];
  /** False unless a reviewer-grade decision exists. */
  readonly mayEnterPublicView: boolean;
  readonly mayEnterAiPath: boolean;
};

/** Words that mark a detector as not evidence-grade (mirrors the V002 labelling rule). */
const NOT_EVIDENCE_GRADE = ["simulated", "fixture", "stub", "demonstration"];

/**
 * Decides whether a photograph's redaction state is resolved.
 *
 * Nothing here can be approved automatically today, and that is the point: an
 * unresolved case is quarantined rather than allowed through on the assumption
 * that it is probably fine.
 */
export const decidePhotoRedaction = (input: PhotoRedactionInput): PhotoRedactionDecision => {
  const regions = input.regions ?? [];
  const label = input.detectorLabel;

  if (label === undefined) {
    return {
      status: "needs_review",
      reasons: [
        "no detector is configured for faces or number plates, so this photograph has not been checked",
      ],
      regions,
      mayEnterPublicView: false,
      mayEnterAiPath: false,
    };
  }

  const simulated = NOT_EVIDENCE_GRADE.some((word) => label.toLowerCase().includes(word));
  if (simulated) {
    return {
      status: "needs_review",
      reasons: [
        `redaction regions came from a ${label}, which is not evidence that the photograph is clear of faces or number plates`,
      ],
      regions,
      mayEnterPublicView: false,
      mayEnterAiPath: false,
    };
  }

  // Reached only once a real, approved detector exists. Kept so adding one is
  // a configuration change rather than a rewrite of every caller.
  return regions.length === 0
    ? {
        status: "not_required",
        reasons: [`${label} found no face or number plate`],
        regions,
        mayEnterPublicView: true,
        mayEnterAiPath: true,
      }
    : {
        status: "approved",
        reasons: [`${label} found ${String(regions.length)} region(s), all covered`],
        regions,
        mayEnterPublicView: true,
        mayEnterAiPath: true,
      };
};
