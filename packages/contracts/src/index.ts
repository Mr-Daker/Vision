/**
 * @vision/contracts — versioned contracts shared by every application layer
 * (roadmap V008).
 *
 * Import direction rule (V006 §9): this package is a leaf. It must not import
 * @vision/domain, @vision/adapters, @vision/config-packs, or any app.
 */

export * from "./primitives.ts";
export * from "./errors.ts";
export * from "./outcomes.ts";
export * from "./capability.ts";
export * from "./envelope.ts";
export * from "./adapters.ts";
export * from "./fixtures.ts";
