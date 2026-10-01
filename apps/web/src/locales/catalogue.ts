import { enIN } from "./en-IN.ts";
import { mrIN } from "./mr-IN.ts";
import { hiIN } from "./hi-IN.ts";
import { taIN } from "./ta-IN.ts";
import { teIN } from "./te-IN.ts";
import { knIN } from "./kn-IN.ts";
import type { LocalePack } from "./strings.ts";

/** Shared by the language selector and locale validation tests. */
export const CATALOGUE = {
  packs: [enIN, mrIN, hiIN, taIN, teIN, knIN] as readonly LocalePack[],
  fallbackCode: enIN.code,
};
