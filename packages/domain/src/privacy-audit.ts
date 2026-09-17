/**
 * Sample-data privacy audit rules (roadmap V044).
 *
 * V015 built the boundaries and V005 wrote the rules. This is the part that
 * goes looking for places they were not kept — in public views, in what was
 * sent to or stored from a model, in logs, and in the fixtures committed to
 * this repository.
 *
 * Two properties make an audit worth running.
 *
 * **A finding never reproduces what it found.** `scanText` reports the pattern
 * that matched and a masked excerpt, never the value. An audit report that
 * prints the leaked email address has leaked it a second time, into a file
 * that is easier to read and more widely shared than the one it came from.
 *
 * **The scanner is checked against planted data.** An audit that always passes
 * is indistinguishable from an audit that does not work, so the database test
 * plants a violation of each kind and asserts the scanner catches it before
 * asserting the real data is clean. `PLANTED_PROBES` exists for exactly that.
 *
 * The patterns below detect *classes* of personal data rather than attempting
 * to recognise names. A name detector would be a source of false confidence:
 * it would miss most names and find people in place names, and the absence of
 * its findings would be read as proof there are none. What is detectable is
 * detected; the rest is stated as a limit rather than implied to be covered.
 *
 * Pure: no clock, no storage, no filesystem. Every input is supplied.
 */

export type AuditScope = "public_view" | "model_trace" | "log" | "fixture" | "identity_store";

export const AUDIT_SCOPES: readonly AuditScope[] = [
  "public_view",
  "model_trace",
  "log",
  "fixture",
  "identity_store",
];

export type PersonalDataPattern = {
  readonly id: string;
  readonly pattern: RegExp;
  /** What it is, and why it must not be where it was found. */
  readonly why: string;
  /** Scopes this pattern is checked in. Not every class matters everywhere. */
  readonly scopes: readonly AuditScope[];
};

/**
 * The classes of personal data this audit can actually detect.
 *
 * Each is here because it is recognisable with high confidence from its shape
 * alone. Deliberately absent: any attempt to recognise a person's name. Such a
 * detector would miss most names and match place names, and a clean result
 * from it would be read as proof that none are present.
 */
export const PERSONAL_DATA_PATTERNS: readonly PersonalDataPattern[] = [
  {
    id: "email_address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    why: "an email address identifies a person and appears in no representation this system publishes, traces or commits",
    scopes: ["public_view", "model_trace", "log", "fixture", "identity_store"],
  },
  {
    id: "indian_mobile_number",
    // Bounded against hex digits and hyphens as well as digits. Without that
    // guard the last group of a UUID — twelve hex characters — produces a
    // match on roughly one identifier in ten, and an audit whose findings are
    // mostly noise teaches its readers to skip them.
    pattern: /(?<![0-9A-Fa-f-])(?:\+?91[\s-]?)?[6-9]\d{9}(?![0-9A-Fa-f-])/g,
    why: "a mobile number identifies a person and is never collected by this system, so its presence anywhere is a leak from somewhere else",
    scopes: ["public_view", "model_trace", "log", "fixture", "identity_store"],
  },
  {
    id: "aadhaar_like_sequence",
    pattern: /(?<![0-9A-Fa-f-])\d{4}[\s-]?\d{4}[\s-]?\d{4}(?![0-9A-Fa-f-])/g,
    why: "a twelve-digit sequence in this shape is an Aadhaar number or is indistinguishable from one, and neither may be stored",
    scopes: ["public_view", "model_trace", "log", "fixture", "identity_store"],
  },
  {
    id: "pan_like_identifier",
    pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    why: "this is the shape of a PAN, a government identifier this system has no reason to hold",
    scopes: ["public_view", "model_trace", "log", "fixture", "identity_store"],
  },
  {
    id: "private_original_reference",
    // A reference, not the tree's name. Requires a second path segment or a
    // file extension, so prose discussing the `originals/` tree — which the
    // V005 document does, correctly — is not reported as a leak from it.
    pattern:
      /\boriginals\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+|\boriginals\/[A-Za-z0-9._-]+\.[A-Za-z0-9]{2,5}\b/g,
    why: "a private original's object reference is the address of an unredacted photograph and must not leave the server (V016)",
    scopes: ["public_view", "model_trace", "fixture"],
  },
  {
    id: "precise_coordinate",
    // Five or more decimal places is roughly a metre. A public view carries a
    // coarse location or none; this precision identifies a doorway.
    pattern: /\b\d{1,3}\.\d{5,}\b/g,
    why: "a coordinate at this precision locates a doorway rather than an area, and a public view carries only a coarse location (V005)",
    scopes: ["public_view"],
  },
  {
    id: "cleartext_provider_subject",
    pattern: /"(?:provider_subject|subject|credential)"\s*:\s*"(?!\s*")[^"]{3,}"/g,
    why: "a provider subject or credential in cleartext defeats the identity mapping's keyed hash, which is the only thing keeping a login separate from a report (V009)",
    scopes: ["model_trace", "log", "fixture", "identity_store"],
  },
  {
    id: "raw_request_body",
    pattern: /"(?:request_body|raw_request|prompt_text|input_text)"\s*:/g,
    why: "V005 §6 forbids storing a raw model request; the input hash identifies it already, and the body is a citizen's own words",
    scopes: ["model_trace", "log"],
  },
];

export type AuditFinding = {
  readonly scope: AuditScope;
  /** Where it was found, in terms a person can go and look at. */
  readonly location: string;
  readonly patternId: string;
  readonly why: string;
  /**
   * A masked excerpt, never the value.
   *
   * The point of an audit report is that it can be circulated; one carrying
   * the data it found has moved that data into a more widely read file.
   */
  readonly maskedExcerpt: string;
};

/**
 * Masks a matched value, keeping only enough shape to find it again.
 *
 * First and last character, everything between replaced. Short matches are
 * fully masked rather than half-revealed.
 */
export const maskMatch = (value: string): string => {
  if (value.length <= 4) return "*".repeat(value.length);
  const first = value.slice(0, 1);
  const last = value.slice(-1);
  return `${first}${"*".repeat(Math.min(value.length - 2, 12))}${last} (${String(value.length)} chars)`;
};

/**
 * Scans one piece of text for the classes this audit detects.
 *
 * `location` travels into every finding so a report says where to look rather
 * than only that something is wrong.
 */
export const scanText = (
  text: string,
  scope: AuditScope,
  location: string,
): readonly AuditFinding[] => {
  const findings: AuditFinding[] = [];
  for (const candidate of PERSONAL_DATA_PATTERNS) {
    if (!candidate.scopes.includes(scope)) continue;
    // A fresh regex per scan: a shared /g regex carries lastIndex between
    // calls, which silently skips matches in the next string.
    const pattern = new RegExp(candidate.pattern.source, candidate.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      findings.push({
        scope,
        location,
        patternId: candidate.id,
        why: candidate.why,
        maskedExcerpt: maskMatch(match[0]),
      });
    }
  }
  return findings;
};

// ---------------------------------------------------------------------------
// Identity records
// ---------------------------------------------------------------------------

/**
 * What a stored identity mapping must look like.
 *
 * The hash is the whole mechanism: a login and a report are only unlinkable
 * because what is stored cannot be run backwards. A value that is not a
 * 64-character hex digest is either cleartext or something else entirely, and
 * both are findings.
 */
export const IDENTITY_HASH_SHAPE = /^[0-9a-f]{64}$/;

export const isKeyedHash = (value: string): boolean => IDENTITY_HASH_SHAPE.test(value);

/**
 * Fields a public issue view is permitted to carry.
 *
 * An allowlist rather than a denylist, matching `toPublicIssueView`: a field
 * added upstream is excluded until somebody adds it here deliberately.
 */
export const PUBLIC_VIEW_ALLOWED_FIELDS: readonly string[] = [
  "public_reference",
  "category",
  "current_status",
  "jurisdiction_id",
  "coarse_location",
  "counted_participants",
  "approved_derivative_references",
];

export const unexpectedPublicFields = (
  payload: Readonly<Record<string, unknown>>,
): readonly string[] =>
  Object.keys(payload).filter((field) => !PUBLIC_VIEW_ALLOWED_FIELDS.includes(field));

// ---------------------------------------------------------------------------
// Positive control
// ---------------------------------------------------------------------------

/**
 * One planted value per detectable class.
 *
 * Used by the database test to prove the scanner works before it is trusted to
 * report that the real data is clean. An audit that always passes is
 * indistinguishable from an audit that does not run.
 *
 * Every value here is invented and matches no real person.
 */
export const PLANTED_PROBES: Readonly<Record<string, string>> = {
  email_address: "not-a-real-person@example.invalid",
  indian_mobile_number: "+91 9876543210",
  aadhaar_like_sequence: "1234 5678 9012",
  pan_like_identifier: "ABCDE1234F",
  private_original_reference: "originals/2026/09/not-a-real-object.bin",
  precise_coordinate: "74.512345",
  cleartext_provider_subject: '{"provider_subject":"not-a-real-subject"}',
  raw_request_body: '{"request_body":{"text":"invented"}}',
};

// ---------------------------------------------------------------------------
// What the audit does not cover
// ---------------------------------------------------------------------------

/**
 * Stated on every report.
 *
 * A clean audit is evidence that the detectable classes are absent, and it is
 * not evidence that nothing personal is present. Saying so is what keeps a
 * green result from being read as a guarantee.
 */
export const AUDIT_LIMITS: readonly string[] = [
  "This audit detects classes of personal data recognisable from their shape: email addresses, mobile numbers, Aadhaar-like and PAN-like identifiers, private object references, over-precise coordinates, cleartext provider subjects and stored raw model requests.",
  "It does not attempt to recognise people's names. A name detector would miss most names and match place names, and a clean result from one would be read as proof that none are present.",
  "It does not read image or audio content. A face or a house number inside a photograph is a redaction question (V021), not something a text scan can find.",
  "A clean result means the detectable classes are absent from what was scanned. It is not a guarantee that nothing personal is present anywhere.",
  "Patterns are written to avoid reporting prose that discusses a private tree or an identifier that merely looks like a number. Each such refinement trades a possible miss for findings a reader will act on.",
  "Number patterns are bounded against hexadecimal context so that identifiers do not produce false findings. A real mobile number written immediately after a hexadecimal character would be missed; the alternative was an audit whose findings are mostly identifiers, which readers learn to skip.",
];
