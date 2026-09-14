/**
 * Independent trust signals (roadmap V025, bounded by V002).
 *
 * Four observations, kept four observations. There is deliberately **no
 * combined score**: a single number would be read as a probability that the
 * reporter is honest, nothing here is calibrated, and V002 prohibition 9
 * forbids presenting an uncalibrated number as one. `calibratedScore` exists
 * only as a permanently absent field, so a caller that looks for one finds
 * nothing rather than inventing its own.
 *
 * The rule that does the most work: **missing metadata is `unknown`, never
 * `inconsistent`.** A cheap phone that strips EXIF, or one that cannot get a
 * GPS fix indoors, must not look like a fraud attempt. Penalising missing data
 * would fall hardest on exactly the reporters this system exists to hear.
 *
 * And four claims stay separate throughout: who someone is, whether they were
 * physically present, whether the image is authentic, and whether the severity
 * they describe is accurate. No signal here establishes any of them.
 */

export const SIGNAL_IDS = [
  "capture_consistency",
  "known_media_reuse",
  "image_description_consistency",
  "timestamp_availability",
  "independent_corroboration",
] as const;

export type SignalId = (typeof SIGNAL_IDS)[number];

export type SignalVerdict = "consistent" | "inconsistent" | "unknown" | "not_applicable";

export type EvidenceCheck = {
  readonly signal: SignalId;
  readonly verdict: SignalVerdict;
  /** Plain-language reason, shown to whoever inspects the flag. */
  readonly reason: string;
  /** What this observation explicitly does not establish. */
  readonly doesNotEstablish: readonly string[];
  /** True when this check's input came from a fixture rather than live data. */
  readonly inputIsFixture: boolean;
  /** Present on the corroboration check: always false, and visible. */
  readonly countsReuseAsIndependent?: false;
};

export type CaptureInput = {
  readonly source: "device_geolocation" | "manual_pin";
  readonly accuracyMetres: number | undefined;
  readonly observedAt: string;
  readonly submittedAt: string;
};

export type MediaInput = {
  readonly hasPhoto: boolean;
  readonly captureTimestampPresent: boolean;
  readonly capturedAt: string | undefined;
  readonly fingerprintSeenBefore: boolean;
  readonly otherEvidenceIds: readonly string[];
};

export type DescriptionConsistencyInput = {
  readonly verdict: "consistent" | "inconsistent" | "uncertain";
  readonly reason: string;
};

export type CorroborationInput = {
  readonly eligibleParticipants: number;
  /** True until V029 supplies live eligible participation. */
  readonly inputIsFixture: boolean;
};

export type TrustSignalInput = {
  readonly capture: CaptureInput;
  readonly media: MediaInput;
  readonly descriptionConsistency: DescriptionConsistencyInput | undefined;
  readonly corroboration: CorroborationInput;
  /** How far before the report a photograph may have been taken before it is flagged. */
  readonly maxCaptureAgeHours?: number;
};

export type TrustSignalReport = {
  readonly checks: readonly EvidenceCheck[];
  readonly requiresReview: boolean;
  readonly reviewReasons: readonly string[];
  readonly anyInputIsFixture: boolean;
  /** The claims no combination of these signals establishes. */
  readonly claimsNotEstablished: readonly string[];
  /**
   * Permanently `undefined`. No model score here has been calibrated against
   * a held-out set, so there is no number to publish (V046 would be the place).
   */
  readonly calibratedScore: undefined;
};

const DEFAULT_MAX_CAPTURE_AGE_HOURS = 72;

const NOT_FRAUD = "that the reporter was dishonest, or that any part of the report is false";
const NOT_IDENTITY = "who the reporter is";
const NOT_PRESENCE = "that the reporter was physically at the place";

const hoursBetween = (earlier: string, later: string): number | undefined => {
  const a = Date.parse(earlier);
  const b = Date.parse(later);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return (b - a) / 3_600_000;
};

const captureConsistency = (input: TrustSignalInput): EvidenceCheck => {
  const base = {
    signal: "capture_consistency" as const,
    inputIsFixture: false,
    doesNotEstablish: [NOT_IDENTITY, NOT_PRESENCE, NOT_FRAUD],
  };

  if (input.capture.source === "manual_pin") {
    // A typed position is a claim about a place, not a failed measurement.
    return {
      ...base,
      verdict: "unknown",
      reason:
        "the location was entered by hand, so there is no device measurement to compare against the report time",
    };
  }

  const capturedAt = input.media.capturedAt;
  if (!input.media.hasPhoto || capturedAt === undefined) {
    return {
      ...base,
      verdict: "unknown",
      reason:
        "the device reported a position, but there is no photograph capture time to compare it with",
    };
  }

  const ageHours = hoursBetween(capturedAt, input.capture.submittedAt);
  if (ageHours === undefined) {
    return { ...base, verdict: "unknown", reason: "the recorded times could not be read" };
  }

  const limit = input.maxCaptureAgeHours ?? DEFAULT_MAX_CAPTURE_AGE_HOURS;
  if (ageHours > limit) {
    return {
      ...base,
      verdict: "inconsistent",
      reason: `the photograph was taken about ${String(Math.round(ageHours))} hours before the report was submitted, more than the ${String(limit)} hours this check allows`,
      doesNotEstablish: [
        NOT_IDENTITY,
        NOT_PRESENCE,
        "that the difference was deliberate, or that the problem is not real — an old photograph of a long-standing problem looks exactly like this",
      ],
    };
  }
  if (ageHours < -1) {
    return {
      ...base,
      verdict: "inconsistent",
      reason: "the photograph's capture time is after the report was submitted",
      doesNotEstablish: [
        NOT_IDENTITY,
        NOT_PRESENCE,
        "that the reporter was dishonest; a device clock set wrongly produces this",
      ],
    };
  }

  return {
    ...base,
    verdict: "consistent",
    reason: `the photograph was taken about ${String(Math.max(0, Math.round(ageHours)))} hours before the report, within the ${String(limit)} hours this check allows`,
  };
};

const knownMediaReuse = (input: TrustSignalInput): EvidenceCheck => {
  const base = {
    signal: "known_media_reuse" as const,
    inputIsFixture: false,
    doesNotEstablish: [
      NOT_IDENTITY,
      "that the reuse was deliberate",
      "independent corroboration — the same photograph submitted twice is one observation, not two",
    ],
  };

  if (!input.media.hasPhoto) {
    return { ...base, verdict: "not_applicable", reason: "this report has no photograph" };
  }
  if (!input.media.fingerprintSeenBefore) {
    return {
      ...base,
      verdict: "consistent",
      reason: "these exact bytes have not been submitted before",
    };
  }
  return {
    ...base,
    verdict: "inconsistent",
    reason: `these exact bytes were submitted before, in ${String(input.media.otherEvidenceIds.length)} other evidence record(s); this is reuse of one photograph`,
  };
};

const imageDescriptionConsistency = (input: TrustSignalInput): EvidenceCheck => {
  const base = {
    signal: "image_description_consistency" as const,
    inputIsFixture: false,
    doesNotEstablish: [
      "that the event happened",
      "the severity of the problem",
      "that the image is authentic",
    ],
  };

  if (!input.media.hasPhoto) {
    return { ...base, verdict: "not_applicable", reason: "this report has no photograph" };
  }
  const supplied = input.descriptionConsistency;
  if (supplied === undefined || supplied.verdict === "uncertain") {
    return {
      ...base,
      verdict: "unknown",
      reason:
        supplied?.reason ??
        "no image-and-text comparison is available for this report, so nothing is claimed either way",
    };
  }
  return { ...base, verdict: supplied.verdict, reason: supplied.reason };
};

const timestampAvailability = (input: TrustSignalInput): EvidenceCheck => {
  const base = {
    signal: "timestamp_availability" as const,
    inputIsFixture: false,
    doesNotEstablish: [
      NOT_FRAUD,
      "when the problem began",
      "that a photograph without a timestamp is less truthful than one with it",
    ],
  };

  if (!input.media.hasPhoto) {
    return { ...base, verdict: "not_applicable", reason: "this report has no photograph" };
  }
  if (!input.media.captureTimestampPresent) {
    // The single most important rule in this file. Many phones and most
    // messaging apps strip capture metadata.
    return {
      ...base,
      verdict: "unknown",
      reason:
        "the photograph did not record a capture time; many devices and messaging apps remove it, so this says nothing about the report",
    };
  }
  return {
    ...base,
    verdict: "consistent",
    reason: "the photograph recorded a capture time that could be read",
  };
};

const independentCorroboration = (input: TrustSignalInput): EvidenceCheck => {
  const fixture = input.corroboration.inputIsFixture;
  const base = {
    signal: "independent_corroboration" as const,
    inputIsFixture: fixture,
    countsReuseAsIndependent: false as const,
    doesNotEstablish: [
      NOT_IDENTITY,
      "that the reports are accurate — agreement is not truth",
      "the severity of the problem",
    ],
  };

  const suffix = fixture
    ? " (this count comes from a clearly marked fixture, not from live participation)"
    : "";

  if (input.corroboration.eligibleParticipants <= 1) {
    return {
      ...base,
      verdict: "unknown",
      reason: `no other eligible participant has reported this${suffix}`,
    };
  }
  return {
    ...base,
    verdict: "consistent",
    reason: `${String(input.corroboration.eligibleParticipants)} eligible participants have reported this separately${suffix}`,
  };
};

export const evaluateTrustSignals = (input: TrustSignalInput): TrustSignalReport => {
  const checks: readonly EvidenceCheck[] = [
    captureConsistency(input),
    knownMediaReuse(input),
    imageDescriptionConsistency(input),
    timestampAvailability(input),
    independentCorroboration(input),
  ];

  // Only an *inconsistency* asks for review. If `unknown` did too, every
  // report from a phone that strips metadata would land in the queue, which
  // both makes the queue useless and penalises the least-equipped reporters.
  const inconsistent = checks.filter((check) => check.verdict === "inconsistent");

  return {
    checks,
    requiresReview: inconsistent.length > 0,
    reviewReasons: inconsistent.map((check) => check.reason),
    anyInputIsFixture: checks.some((check) => check.inputIsFixture),
    claimsNotEstablished: [
      "identity",
      "physical_presence",
      "image_authenticity",
      "factual_severity",
    ],
    calibratedScore: undefined,
  };
};
