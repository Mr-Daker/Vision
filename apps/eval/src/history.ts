/**
 * Every recorded run of a split, read back (roadmap V046).
 *
 * A single run's document describes a single afternoon. On the day this was
 * built, three runs of identical code against identical rows produced a clean
 * pass, a run in which the provider refused every call, and one in between —
 * and no one of those three is the result. Reading the stored records back
 * into the published document means the variance is visible without anybody
 * having to remember it, and means a run cannot be quietly replaced by a
 * better one.
 *
 * Derived only from what a record already holds, so old records stay readable.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RunHistoryEntry = {
  readonly runId: string;
  readonly providerMode: string;
  readonly startedAt: string;
  /** Rows whose labels were allowed to back a figure. */
  readonly rowsWithUsableLabels: number;
  /** Of those, rows that produced an answer to compare against. */
  readonly rowsScored: number;
  readonly categoryMatches: number;
  readonly classificationCalls: number;
  readonly classificationCallsAnswered: number;
  readonly permitted: boolean;
};

type StoredScore = {
  readonly authority?: { readonly usable?: unknown };
  readonly proposedCategory?: { readonly kind?: unknown };
};

type StoredCall = { readonly operation?: unknown; readonly status?: unknown };

type StoredRecord = {
  readonly runId?: unknown;
  readonly split?: unknown;
  readonly providerMode?: unknown;
  readonly startedAt?: unknown;
  readonly verdict?: { readonly permitted?: unknown };
  readonly scores?: unknown;
  readonly calls?: unknown;
};

const asArray = <T>(value: unknown): readonly T[] => (Array.isArray(value) ? (value as T[]) : []);

export const readRunHistory = (directory: string, split: string): readonly RunHistoryEntry[] => {
  let names: readonly string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  const entries: RunHistoryEntry[] = [];
  for (const name of names) {
    let record: StoredRecord;
    try {
      record = JSON.parse(readFileSync(join(directory, name), "utf8")) as StoredRecord;
    } catch {
      continue;
    }
    if (record.split !== split) continue;

    const scores = asArray<StoredScore>(record.scores);
    const usable = scores.filter((score) => score.authority?.usable === true);
    const scored = usable.filter(
      (score) =>
        score.proposedCategory !== undefined && score.proposedCategory.kind !== "unscorable",
    );
    const calls = asArray<StoredCall>(record.calls).filter(
      (call) => call.operation === "classification",
    );

    entries.push({
      runId: String(record.runId ?? name),
      providerMode: String(record.providerMode ?? "unknown"),
      startedAt: String(record.startedAt ?? ""),
      rowsWithUsableLabels: usable.length,
      rowsScored: scored.length,
      categoryMatches: scored.filter((score) => score.proposedCategory?.kind === "match").length,
      classificationCalls: calls.length,
      classificationCallsAnswered: calls.filter((call) => call.status === 200).length,
      permitted: record.verdict?.permitted === true,
    });
  }

  return entries.sort((a, b) => a.runId.localeCompare(b.runId));
};
