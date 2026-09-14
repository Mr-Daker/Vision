/**
 * Caches provider answers by input hash (roadmap V023).
 *
 * V023 recorded "no result caching by input hash, so a repeat is a repeat
 * charge". This is that cache. On a free tier of five requests per minute the
 * saving is not only money — a re-run of the same submission that re-asks the
 * provider will rate-limit, and the stage then looks broken.
 *
 * Three rules the implementation exists to hold:
 *
 *  1. **The key includes the model and prompt version.** A changed prompt is a
 *     different question; answering it from an old entry would attribute an
 *     answer to a prompt that never produced it.
 *  2. **A failure is never cached.** Caching an outage makes it permanent.
 *  3. **A cached answer is dated when it was obtained.** It is returned with
 *     `firstObtainedAt`, and callers must not present it as freshly observed:
 *     the answer is as old as it is, and a surface saying otherwise would be
 *     overstating what the system currently knows (V002 row 16).
 *
 * What is *not* stored is the request. V005 §6 forbids storing raw request
 * bodies and the citizen's words are in the request; the hash identifies the
 * input without keeping it.
 */

import { createHash, randomUUID } from "node:crypto";

import type { Queryable } from "./outbox.ts";

export type AiCacheOperation = "classification" | "embedding" | "transcription";

export type AiCacheKey = {
  readonly operation: AiCacheOperation;
  /** sha-256 of exactly what was sent, lower-case hex. */
  readonly inputHash: string;
  readonly modelName: string;
  readonly promptVersion: string;
};

export type CachedResult = {
  readonly result: unknown;
  readonly firstObtainedAt: Date;
  readonly hitCount: number;
  readonly providerRequestId: string | undefined;
};

/** What a wrapped provider call returns. A failure carries no result to cache. */
export type ProviderCallOutcome =
  | { readonly outcome: "success"; readonly result: unknown; readonly providerRequestId?: string }
  | { readonly outcome: "failure"; readonly reasonCode: string };

export type CachedCallResult =
  | {
      readonly outcome: "success";
      readonly result: unknown;
      readonly fromCache: boolean;
      /** When this answer was obtained from the provider — not when it was read. */
      readonly firstObtainedAt: Date;
      readonly providerRequestId: string | undefined;
    }
  | {
      readonly outcome: "failure";
      readonly reasonCode: string;
      readonly fromCache: false;
      readonly firstObtainedAt: Date;
      readonly providerRequestId: undefined;
    };

export class AiCacheError extends Error {}

const HASH_SHAPE = /^[0-9a-f]{64}$/;

const requireHash = (inputHash: string): void => {
  // Also a table constraint. Checked here so a mis-hashed key is refused
  // before a row is attempted, and so the message names the cause.
  if (!HASH_SHAPE.test(inputHash)) {
    throw new AiCacheError("an AI cache input hash must be 64 lower-case hex characters");
  }
};

/**
 * Reads a cached answer without recording a hit.
 *
 * Separate from `withAiCache` so a caller that only wants to report on the
 * cache does not inflate the counts it is reporting.
 */
export const lookupCachedResult = async (
  tx: Queryable,
  key: AiCacheKey,
): Promise<CachedResult | undefined> => {
  requireHash(key.inputHash);
  const { rows } = await tx.query(
    `select result, created_at, hit_count, provider_request_id
       from ai_result_cache
      where operation = $1 and input_hash = $2 and model_name = $3 and prompt_version = $4`,
    [key.operation, key.inputHash, key.modelName, key.promptVersion],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const providerRequestId = row["provider_request_id"];
  return {
    result: row["result"],
    firstObtainedAt: new Date(String(row["created_at"])),
    hitCount: Number(row["hit_count"]),
    providerRequestId: typeof providerRequestId === "string" ? providerRequestId : undefined,
  };
};

/**
 * Runs `call` unless the same question has already been answered.
 *
 * The provider is not called on a hit — that is the whole point, and the test
 * for it throws from `call` so a regression cannot pass quietly.
 */
export const withAiCache = async (
  tx: Queryable,
  key: AiCacheKey,
  call: () => Promise<ProviderCallOutcome>,
): Promise<CachedCallResult> => {
  requireHash(key.inputHash);

  const existing = await lookupCachedResult(tx, key);
  if (existing !== undefined) {
    await tx.query(
      `update ai_result_cache set hit_count = hit_count + 1
        where operation = $1 and input_hash = $2 and model_name = $3 and prompt_version = $4`,
      [key.operation, key.inputHash, key.modelName, key.promptVersion],
    );
    return {
      outcome: "success",
      result: existing.result,
      fromCache: true,
      // The original observation time, deliberately. Rewriting this to now()
      // would let a three-day-old answer be presented as current.
      firstObtainedAt: existing.firstObtainedAt,
      providerRequestId: existing.providerRequestId,
    };
  }

  const fresh = await call();
  if (fresh.outcome === "failure") {
    // Not written. An outage cached is an outage that never ends.
    return {
      outcome: "failure",
      reasonCode: fresh.reasonCode,
      fromCache: false,
      firstObtainedAt: new Date(),
      providerRequestId: undefined,
    };
  }

  const { rows } = await tx.query(
    `insert into ai_result_cache
       (cache_id, operation, input_hash, model_name, prompt_version, result, provider_request_id)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7)
     on conflict (operation, input_hash, model_name, prompt_version) do nothing
     returning created_at`,
    [
      randomUUID(),
      key.operation,
      key.inputHash,
      key.modelName,
      key.promptVersion,
      JSON.stringify(fresh.result),
      fresh.providerRequestId ?? null,
    ],
  );

  // `do nothing` means a concurrent call inserted first. Both answers are
  // answers to the same question, so the caller keeps the one it paid for
  // rather than the write failing and the stage crashing.
  const createdAt = rows[0]?.["created_at"];
  return {
    outcome: "success",
    result: fresh.result,
    fromCache: false,
    firstObtainedAt: createdAt === undefined ? new Date() : new Date(String(createdAt)),
    ...(fresh.providerRequestId === undefined
      ? { providerRequestId: undefined }
      : { providerRequestId: fresh.providerRequestId }),
  };
};

// ---------------------------------------------------------------------------
// Wiring the cache into the calls the pipeline makes
// ---------------------------------------------------------------------------

/**
 * There is no prompt in an embedding request, so the key needs a stand-in.
 *
 * It is versioned rather than a constant like "n/a" because the *preparation*
 * of the text can change — trimming, case, a task type — and that changes the
 * vector. When it does, this string changes and old entries stop being hits.
 */
export const EMBEDDING_PROMPT_VERSION = "embed-input.v1";

type EmbeddingCall = (text: string) => Promise<{
  readonly vector: readonly number[];
  readonly model: string;
  readonly dimensions: number;
  readonly normalized: boolean;
}>;

/**
 * Wraps an embedding function so identical text is embedded once.
 *
 * Two people describing the same landmark in the same words is the ordinary
 * case, not an edge case, and on a five-requests-per-minute tier the second
 * call is the one that fails.
 *
 * A throwing provider is allowed to throw. Caching a failure — or worse,
 * caching an empty vector so the call "succeeds" — would make every later
 * similarity comparison quietly wrong, which is harder to notice than an
 * outage.
 */
export const cachedEmbedText = (
  tx: Queryable,
  embed: EmbeddingCall,
  options: { readonly modelName: string; readonly promptVersion?: string },
): EmbeddingCall => {
  const promptVersion = options.promptVersion ?? EMBEDDING_PROMPT_VERSION;
  return async (text: string) => {
    const key: AiCacheKey = {
      operation: "embedding",
      inputHash: createHash("sha256").update(text).digest("hex"),
      modelName: options.modelName,
      promptVersion,
    };

    const cached = await withAiCache(tx, key, async () => {
      const fresh = await embed(text);
      return { outcome: "success", result: fresh };
    });

    if (cached.outcome === "failure") {
      // `withAiCache` only reports a failure when the call returned one, and
      // this wrapper never returns one — a throwing provider throws through.
      throw new AiCacheError(`embedding unavailable: ${cached.reasonCode}`);
    }

    const row = cached.result as {
      vector?: unknown;
      model?: unknown;
      dimensions?: unknown;
      normalized?: unknown;
    };
    if (!Array.isArray(row.vector) || typeof row.model !== "string") {
      throw new AiCacheError("a cached embedding row is not a usable embedding");
    }
    return {
      vector: row.vector.map((component) => Number(component)),
      model: row.model,
      dimensions: Number(row.dimensions),
      normalized: row.normalized === true,
    };
  };
};
