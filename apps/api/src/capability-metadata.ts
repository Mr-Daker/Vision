/**
 * Capability metadata document served by the API (roadmap V009).
 *
 * Built from the adapters that are actually wired in, so the document cannot
 * drift from reality: if a simulated adapter is swapped for a real one, this
 * output changes with it. V002 requires every simulated provider to be
 * labelled wherever its output is surfaced, and this is the machine-readable
 * source the UI uses to do that.
 */

import {
  findUnlabelledSimulations,
  nowIso,
  CONTRACT_VERSION,
  type CapabilityDescriptor,
  type CapabilityMetadataDocument,
} from "@vision/contracts";

export type CapabilityProviders = {
  readonly descriptors: readonly CapabilityDescriptor[];
};

/**
 * Assembles the document and refuses to build a dishonest one: if a
 * non-real provider is not labelled as simulated, this throws at startup
 * rather than serving a misleading label to a citizen.
 */
export const buildCapabilityMetadata = (
  providers: CapabilityProviders,
): CapabilityMetadataDocument => {
  const document: CapabilityMetadataDocument = {
    contract_version: CONTRACT_VERSION,
    generated_at: nowIso(),
    capabilities: providers.descriptors,
  };

  const unlabelled = findUnlabelledSimulations(document);
  if (unlabelled.length > 0) {
    throw new Error(
      `refusing to start: simulated capabilities are not labelled as simulated: ${unlabelled.join(", ")}`,
    );
  }

  return document;
};
