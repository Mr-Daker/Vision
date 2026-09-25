/**
 * Every state-changing endpoint, read out of the routing sources (V047).
 *
 * The attack suite needs a list of what to attack, and a list maintained by
 * hand is a list that is correct until somebody adds a route. So the list is
 * derived: each route module is scanned for the `method === "POST"` guards
 * that dispatch it, and the suite asserts that every one of them is attacked
 * by name.
 *
 * It **fails closed**. A guard written in a shape this scanner does not
 * recognise raises rather than being skipped, for the same reason
 * `check:imports` fails on an unknown workspace package: silently ignoring the
 * thing you do not understand is how an endpoint ends up with no coverage and
 * a green suite.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Modules that dispatch on an HTTP method. `dashboard-routes` is read-only and included on purpose. */
export const ROUTE_MODULES: readonly string[] = [
  "app.ts",
  "submission-routes.ts",
  "citizen-routes.ts",
  "reviewer-routes.ts",
  "staff-routes.ts",
  "supervisor-routes.ts",
  "dashboard-routes.ts",
];

export type StateChangingRoute = {
  readonly module: string;
  readonly line: number;
  readonly methods: readonly string[];
  /** How the guard recognises the path, in a form a human can match to a probe. */
  readonly pathPattern: string;
  /** The stable key a probe declares it covers. */
  readonly key: string;
};

export class RouteInventoryError extends Error {}

const STATE_CHANGING = /method === "(POST|PUT|PATCH|DELETE)"/g;

/** `const fooMatch = /regex/.exec(path)` — resolves a guard that dispatches on a named matcher. */
const namedMatchers = (source: string): ReadonlyMap<string, string> => {
  const matchers = new Map<string, string>();
  const pattern =
    /const\s+(\w+)\s*=\s*(\/(?:\\.|\[[^\]]*\]|[^/\\])+\/[gimsuy]*)\s*\.exec\(\s*path\s*,?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) matchers.set(match[1], match[2]);
  }
  return matchers;
};

/** The path test that sits beside the method test on the same guard line. */
const pathPatternOf = (guardLine: string, matchers: ReadonlyMap<string, string>): string => {
  // Several literals before one, because a guard like
  // `path === "/v1/auth/logout" || path === "/v1/auth/rotate"` dispatches two
  // endpoints and taking the first would leave the second unattacked.
  const literals = [...guardLine.matchAll(/path === "([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  if (literals.length > 0) return literals.join(" | ");

  const prefix = /path\.startsWith\("([^"]+)"\)/.exec(guardLine);
  if (prefix?.[1] !== undefined) return `${prefix[1]}*`;

  const inline = /(\/(?:\\.|\[[^\]]*\]|[^/\\])+\/[gimsuy]*)\s*\.test\(\s*path\s*\)/.exec(guardLine);
  if (inline?.[1] !== undefined) return inline[1];

  const named = /(\w+) !== null/.exec(guardLine);
  if (named?.[1] !== undefined) {
    const resolved = matchers.get(named[1]);
    if (resolved !== undefined) return resolved;
    throw new RouteInventoryError(
      `a guard dispatches on '${named[1]}', and no '${named[1]} = /…/.exec(path)' was found in the same module`,
    );
  }

  throw new RouteInventoryError(
    `this guard's path test is in a shape the inventory does not recognise, so the endpoint would go unattacked: ${guardLine.trim()}`,
  );
};

export const stateChangingRoutes = (directory: string = HERE): readonly StateChangingRoute[] => {
  const routes: StateChangingRoute[] = [];

  for (const moduleName of ROUTE_MODULES) {
    const source = readFileSync(join(directory, moduleName), "utf8");
    const matchers = namedMatchers(source);
    const lines = source.split("\n");

    lines.forEach((line, index) => {
      STATE_CHANGING.lastIndex = 0;
      const methods = [...line.matchAll(STATE_CHANGING)]
        .map((match) => match[1])
        .filter((method): method is string => method !== undefined);
      if (methods.length === 0) return;

      const pathPattern = pathPatternOf(line, matchers);
      routes.push({
        module: moduleName,
        line: index + 1,
        methods,
        pathPattern,
        key: `${methods.join("/")} ${pathPattern}`,
      });
    });
  }

  return routes;
};
