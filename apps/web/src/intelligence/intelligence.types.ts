/**
 * Public Intelligence types.
 *
 * The lifecycle vocabulary here is not invented: `status` and `matchState` are
 * subsets of `IssueStatus` and `IssueMatchState` in
 * `packages/domain/src/transitions.ts`, and `issue-aggregation.test.ts` asserts
 * that they stay subsets. They are restated rather than imported because this
 * file is browser-delivered and the domain package reaches the browser through
 * a separate vendor build; the test is what keeps the two honest.
 */

/** Severity is a reported judgement, not a measurement. */
export type IssueSeverity = "low" | "medium" | "high" | "critical";

export type IssueCategory =
  | "road_damage"
  | "pothole"
  | "drainage"
  | "street_light"
  | "water_supply"
  | "sanitation"
  | "bridge"
  | "school"
  | "public_health_facility"
  | "waste"
  | "traffic_signal"
  | "public_transport"
  | "other";

/** A subset of the domain's `IssueStatus`. */
export type IssueLifecycleStatus =
  | "created"
  | "routing_review"
  | "routed_internal"
  | "agency_ack_received"
  | "work_planned"
  | "resolution_claimed"
  | "resolution_confirmed";

/** A subset of the domain's `IssueMatchState`. */
export type IssueMatchStatus =
  "pending" | "candidates_retrieved" | "match_confirmed" | "ambiguous" | "no_match";

export type LocationCaptureMethod = "device" | "manual";

export type IssueSource = "citizen_upload" | "field_staff" | "department";

/**
 * One synthetic infrastructure issue.
 *
 * Every record in the shipped dataset is fabricated. Nothing here describes a
 * real incident, a real citizen or a real department, and the interface says so
 * where a reader can see it rather than in a footnote.
 */
export type InfrastructureIssue = {
  readonly id: string;

  readonly country: string;
  readonly countryCode: string;
  readonly state: string;
  readonly stateCode: string;
  readonly district: string;
  readonly city: string;
  readonly locality?: string;

  readonly latitude: number;
  readonly longitude: number;

  readonly category: IssueCategory;
  readonly title: string;
  readonly description: string;

  readonly severity: IssueSeverity;
  readonly status: IssueLifecycleStatus;
  readonly matchState: IssueMatchStatus;

  readonly reportedAt: string;
  readonly updatedAt: string;

  /** How many separate citizen reports were consolidated into this issue. */
  readonly citizenReportsCount: number;
  readonly estimatedPeopleAffected: number;

  readonly department: string;
  readonly source: IssueSource;

  /**
   * The classifier's own reported confidence, 0–1. Shown as a band rather than
   * a percentage anywhere a reader might mistake it for a probability that the
   * issue is real — nothing here is calibrated to support that reading.
   */
  readonly classificationConfidence: number;

  /** Present when this issue absorbed repeat reports of one physical problem. */
  readonly duplicateClusterId?: string;

  readonly locationCaptureMethod: LocationCaptureMethod;
  readonly locationAccuracyMetres?: number;

  readonly tags: readonly string[];
};

/** A level in the drill-down. */
export type HierarchyLevel = "country" | "state" | "city" | "category" | "issue";

/** One node of the derived hierarchy the visualisation renders. */
export type HierarchyNode = {
  readonly id: string;
  readonly level: HierarchyLevel;
  readonly label: string;
  /** Issues at or beneath this node. */
  readonly issueCount: number;
  readonly criticalCount: number;
  readonly highCount: number;
  readonly peopleAffected: number;
  readonly severityMix: SeverityMix;
  readonly children: readonly HierarchyNode[];
  /** Set only on an issue node. */
  readonly issue?: InfrastructureIssue;
};

export type SeverityMix = {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
  readonly critical: number;
};

/** Active filter state. Empty sets mean "no restriction". */
export type IntelligenceFilters = {
  readonly severities: ReadonlySet<IssueSeverity>;
  readonly categories: ReadonlySet<IssueCategory>;
  /** Days back from the dataset's own newest report, or undefined for all. */
  readonly windowDays: number | undefined;
};
