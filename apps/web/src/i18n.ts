/**
 * Locale resolution and interpolation (roadmap V019).
 *
 * No language is named in this file. The available packs are passed in, so
 * adding or removing a language is a data change ([V001](../../../docs/foundation/V001-scope-and-release-boundaries.md)
 * Appendix G rule 7).
 */

import type { LocalePack, StringKey } from "./locales/strings.ts";

export type LocaleCatalogue = {
  readonly packs: readonly LocalePack[];
  /** Used when the requested tag matches nothing. Must be in `packs`. */
  readonly fallbackCode: string;
};

export class LocaleError extends Error {}

/** Exact tag first, then primary subtag: `mr` and `mr-Deva-IN` both match `mr-IN`. */
const findMatch = (requested: string, packs: readonly LocalePack[]): LocalePack | undefined => {
  const wanted = requested.trim().toLowerCase();
  if (wanted.length === 0) return undefined;
  const primary = wanted.split("-")[0];
  return (
    packs.find((pack) => pack.code.toLowerCase() === wanted) ??
    packs.find((pack) => pack.code.toLowerCase().split("-")[0] === primary)
  );
};

const fallbackPack = (catalogue: LocaleCatalogue): LocalePack => {
  const fallback = catalogue.packs.find((pack) => pack.code === catalogue.fallbackCode);
  if (fallback === undefined) {
    throw new LocaleError(`fallback locale '${catalogue.fallbackCode}' is not in the catalogue`);
  }
  return fallback;
};

/**
 * Picks a pack for a requested tag, falling back when nothing matches.
 *
 * Region-only differences are a match rather than a miss, so a device
 * reporting `mr` is not silently served the fallback language.
 */
export const resolveLocale = (
  requested: string | undefined,
  catalogue: LocaleCatalogue,
): LocalePack => {
  const fallback = fallbackPack(catalogue);
  if (requested === undefined) return fallback;
  return findMatch(requested, catalogue.packs) ?? fallback;
};

/** Picks the best pack for an ordered preference list, e.g. `navigator.languages`. */
export const resolvePreferredLocale = (
  preferences: readonly string[],
  catalogue: LocaleCatalogue,
): LocalePack => {
  const fallback = fallbackPack(catalogue);
  for (const preference of preferences) {
    const match = findMatch(preference, catalogue.packs);
    if (match !== undefined) return match;
  }
  return fallback;
};

export type Translator = {
  readonly pack: LocalePack;
  readonly t: (key: StringKey, params?: Readonly<Record<string, string | number>>) => string;
  /** True when the interface must disclose that the text is unreviewed. */
  readonly disclosesTranslationStatus: boolean;
};

/**
 * `{name}` placeholders are replaced; an unknown placeholder is left as-is so
 * a missing parameter is visible in the interface instead of rendering an
 * empty gap that nobody notices.
 */
export const interpolate = (
  template: string,
  params: Readonly<Record<string, string | number>> = {},
): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );

export const createTranslator = (pack: LocalePack): Translator => ({
  pack,
  t: (key, params) => interpolate(pack.strings[key], params),
  disclosesTranslationStatus: pack.translation_status !== "source",
});
