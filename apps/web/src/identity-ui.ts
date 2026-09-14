/**
 * Minimal V009 identity UI, intentionally independent of a frontend framework.
 * V019 can mount this view model in the PWA without changing its trust rule:
 * the visible label always comes from API capability metadata.
 */

import {
  findUnlabelledSimulations,
  type CapabilityDescriptor,
  type CapabilityMetadataDocument,
} from "@vision/contracts";

export type DemoPrincipalSummary = {
  readonly credential: string;
  readonly label: string;
  readonly credential_state: "active" | "revoked" | "expired";
  readonly issuer: string;
};

export type DemoIdentityMetadata = CapabilityMetadataDocument & {
  readonly demo_principals: readonly DemoPrincipalSummary[];
};

export type DemoIdentityViewModel = {
  readonly heading: string;
  readonly providerLabel: string;
  readonly providerMode: "simulated" | "real" | "stub";
  readonly warning: string;
  readonly availablePrincipals: readonly DemoPrincipalSummary[];
};

const identityCapability = (
  capabilities: readonly CapabilityDescriptor[],
): CapabilityDescriptor => {
  const identity = capabilities.find((item) => item.capability === "citizen_identity");
  if (identity === undefined) {
    throw new Error("identity capability metadata is missing");
  }
  return identity;
};

export const buildDemoIdentityViewModel = (
  metadata: DemoIdentityMetadata,
): DemoIdentityViewModel => {
  const identity = identityCapability(metadata.capabilities);
  const unlabelled = findUnlabelledSimulations({
    contract_version: metadata.contract_version,
    generated_at: metadata.generated_at,
    capabilities: [identity],
  });
  if (unlabelled.length > 0) {
    throw new Error("refusing to render identity UI without an explicit simulation label");
  }

  return {
    heading: "Choose a demonstration account",
    providerLabel: identity.display_label,
    providerMode: identity.provider_mode,
    warning:
      identity.provider_mode === "real"
        ? "Identity is provided by an authenticated external integration."
        : "Demonstration only. This does not verify a real person or a DigiLocker credential.",
    availablePrincipals: metadata.demo_principals.filter(
      (principal) => principal.credential_state === "active",
    ),
  };
};

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

/** Renderable, accessible fragment used by the V009 login screen. */
export const renderDemoIdentityPanel = (model: DemoIdentityViewModel): string => {
  const choices = model.availablePrincipals
    .map(
      (principal) =>
        `<button type="button" data-demo-credential="${escapeHtml(principal.credential)}">${escapeHtml(principal.label)}</button>`,
    )
    .join("");

  return [
    '<section aria-labelledby="demo-identity-heading">',
    `<h1 id="demo-identity-heading">${escapeHtml(model.heading)}</h1>`,
    `<p role="status" data-provider-mode="${escapeHtml(model.providerMode)}">${escapeHtml(model.providerLabel)}</p>`,
    `<p role="note">${escapeHtml(model.warning)}</p>`,
    `<div aria-label="Demonstration accounts">${choices}</div>`,
    "</section>",
  ].join("");
};
