/**
 * Provider capability metadata (roadmap V008; consumed by V009 and the UI).
 *
 * This is the machine-readable form of the V002 capability/evidence matrix.
 * The API serves it so that no surface has to hard-code whether a provider is
 * simulated, and so an evaluator can verify the labelling claim directly.
 */

import type { IsoTimestamp } from "./primitives.ts";
import type { ProviderMode } from "./outcomes.ts";

export type CapabilityId =
  | "citizen_identity"
  | "recipient_acknowledgment"
  | "ai_classification"
  | "ai_transcription"
  | "object_storage"
  | "task_delivery"
  | "source_import";

export type CapabilityDescriptor = {
  readonly capability: CapabilityId;
  readonly provider_name: string;
  readonly provider_mode: ProviderMode;
  /**
   * Short label every surface must display wherever this capability's output
   * appears. For simulated/stub providers it must say so in plain language.
   */
  readonly display_label: string;
  /** Corresponding row number in the V002 matrix, for traceability. */
  readonly v002_row: number;
  readonly may_claim: readonly string[];
  readonly must_not_claim: readonly string[];
};

export type CapabilityMetadataDocument = {
  readonly contract_version: string;
  readonly generated_at: IsoTimestamp;
  readonly capabilities: readonly CapabilityDescriptor[];
};

const SIMULATION_WORDS = ["simulated", "stub", "demonstration only", "not a real"];

/**
 * A simulated or stubbed capability must be labelled as such. Returns the
 * offending capability ids so a test or a CI check can fail loudly rather than
 * relying on reviewer vigilance (V002 row 16, V001 Appendix C).
 */
export const findUnlabelledSimulations = (
  document: CapabilityMetadataDocument,
): readonly CapabilityId[] =>
  document.capabilities
    .filter((capability) => capability.provider_mode !== "real")
    .filter((capability) => {
      const label = capability.display_label.toLowerCase();
      return !SIMULATION_WORDS.some((word) => label.includes(word));
    })
    .map((capability) => capability.capability);
