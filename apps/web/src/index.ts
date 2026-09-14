/**
 * Citizen and staff PWA (roadmap V019+).
 *
 * V009 supplies the small, framework-neutral demo-identity surface exported
 * below. The full citizen reporting UI still begins at V019.
 *
 * Not implemented yet, by design:
 *  - citizen capture and submission flow  -> V019
 *  - offline drafts (IndexedDB)           -> V020
 *  - mr-IN / en-IN locale resources       -> V019 (locale packs)
 *  - tracking, review and staff surfaces  -> V030-V034
 *
 * The API already serves the capability metadata this app must use to label
 * simulated providers (V009); it is the single source for those labels.
 */

export const WEB_STATUS = "demo_identity_surface_ready_v009" as const;

export const CAPABILITY_METADATA_ENDPOINT = "/v1/capabilities" as const;

export * from "./identity-ui.ts";
