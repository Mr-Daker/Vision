/**
 * Caching provider answers by input hash (roadmap V023).
 *
 * Run with: npm run db:up && npm run db:migrate && npm run test:db
 *
 * V023 recorded: "no result caching by input hash, so a repeat is a repeat
 * charge". On a free tier of five requests per minute that is not only cost,
 * it is the difference between a demo working and a demo rate-limiting.
 *
 * Two things matter more than the saving:
 *
 *  * A changed prompt or model is a **different question**. Answering it from
 *    an old cache would attribute an answer to a prompt that never produced it.
 *  * A cached answer was observed *then*, not now. A surface that showed it as
 *    freshly observed would be overstating what the system knows, so the
 *    wrapper reports when the answer was first obtained and never rewrites
 *    that to the present.
 *
 * A failure is never cached: caching an outage makes it permanent.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

import {
  withAiCache,
  lookupCachedResult,
  cachedEmbedText,
  EMBEDDING_PROMPT_VERSION,
  type AiCacheKey,
} from "./ai-cache.ts";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://vision:vision_local_dev_only@127.0.0.1:5432/vision_dev";

let client: pg.Client;
const hashes: string[] = [];

const hashFor = (seed: string): string => {
  const h = seed
    .padEnd(64, "0")
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a");
  hashes.push(h);
  return h;
};

/** Records a text's hash so the cleanup finds rows keyed by a hash the test never computed. */
const trackText = (text: string, model: string, promptVersion: string): void => {
  void model;
  void promptVersion;
  hashes.push(createHash("sha256").update(text).digest("hex"));
};

const key = (overrides: Partial<AiCacheKey> = {}): AiCacheKey => ({
  operation: "classification",
  inputHash: hashFor(randomUUID().replace(/-/g, "")),
  modelName: "gemini-3.6-flash",
  promptVersion: "classify.v1",
  ...overrides,
});

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL, statement_timeout: 15_000 });
  await client.connect();
});

after(async () => {
  if (hashes.length > 0) {
    await client
      .query("delete from ai_result_cache where input_hash = any($1::text[])", [hashes])
      .catch(() => undefined);
  }
  await client.end().catch(() => undefined);
});

test("V023: a repeated identical call is answered from the cache, not the provider", async () => {
  const k = key();
  let calls = 0;
  const call = async () => {
    calls += 1;
    return { outcome: "success" as const, result: { category: "sanitation" } };
  };

  const first = await withAiCache(client, k, call);
  const second = await withAiCache(client, k, call);

  assert.equal(calls, 1);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.deepEqual(second.result, { category: "sanitation" });
});

test("V023: a cached answer reports when it was obtained, not the present moment", async () => {
  const k = key();
  await withAiCache(client, k, async () => ({
    outcome: "success" as const,
    result: { category: "sanitation" },
  }));
  await client.query(
    "update ai_result_cache set created_at = now() - interval '3 days' where input_hash = $1",
    [k.inputHash],
  );

  const hit = await withAiCache(client, k, async () => {
    throw new Error("the provider must not be called");
  });

  assert.equal(hit.fromCache, true);
  const ageHours = (Date.now() - hit.firstObtainedAt.getTime()) / 3_600_000;
  assert.ok(ageHours > 70, `expected a three-day-old answer, got ${String(ageHours)} h`);
});

test("V023: a changed prompt version is a different question and misses", async () => {
  const k = key();
  let calls = 0;
  const call = async () => {
    calls += 1;
    return { outcome: "success" as const, result: { calls } };
  };

  await withAiCache(client, k, call);
  const second = await withAiCache(client, { ...k, promptVersion: "classify.v2" }, call);

  assert.equal(calls, 2);
  assert.equal(second.fromCache, false);
});

test("V023: a changed model misses", async () => {
  const k = key();
  let calls = 0;
  const call = async () => {
    calls += 1;
    return { outcome: "success" as const, result: { calls } };
  };

  await withAiCache(client, k, call);
  await withAiCache(client, { ...k, modelName: "gemini-3.5-flash" }, call);

  assert.equal(calls, 2);
});

test("V023: a different input misses", async () => {
  let calls = 0;
  const call = async () => {
    calls += 1;
    return { outcome: "success" as const, result: { calls } };
  };

  await withAiCache(client, key(), call);
  await withAiCache(client, key(), call);

  assert.equal(calls, 2);
});

test("V023: a failure is not cached, so an outage does not become permanent", async () => {
  const k = key();
  let calls = 0;
  const call = async () => {
    calls += 1;
    return calls === 1
      ? { outcome: "failure" as const, reasonCode: "provider_unavailable" }
      : { outcome: "success" as const, result: { category: "sanitation" } };
  };

  const first = await withAiCache(client, k, call);
  const second = await withAiCache(client, k, call);

  assert.equal(first.fromCache, false);
  assert.equal(first.outcome, "failure");
  // The retry reached the provider rather than being told the outage again.
  assert.equal(calls, 2);
  assert.equal(second.outcome, "success");
  assert.deepEqual(second.result, { category: "sanitation" });
});

test("V023: hits are counted, so the saving can be reported rather than assumed", async () => {
  const k = key();
  const call = async () => ({ outcome: "success" as const, result: { category: "sanitation" } });

  await withAiCache(client, k, call);
  await withAiCache(client, k, call);
  await withAiCache(client, k, call);

  const cached = await lookupCachedResult(client, k);
  assert.equal(cached?.hitCount, 2);
});

test("V023: the cache stores the answer and never the text that was sent", async () => {
  // V005 §6 forbids storing raw request bodies, and the citizen's words are in
  // the request. The hash identifies the input; the words must not be there.
  const k = key();
  await withAiCache(client, k, async () => ({
    outcome: "success" as const,
    result: { category: "sanitation" },
  }));

  const { rows } = await client.query("select * from ai_result_cache where input_hash = $1", [
    k.inputHash,
  ]);
  assert.equal(rows.length, 1);
  const stored = JSON.stringify(rows[0]);
  assert.ok(!stored.includes("the drain outside"), "the request text must not be stored");
  assert.match(stored, /sanitation/);
});

test("V023: two concurrent identical calls settle on one cached answer", async () => {
  // Both may legitimately reach the provider — nothing locks here — but the
  // second writer must not fail on ai_result_cache_key_uniq, because a
  // crashed classification stage would leave the submission stuck.
  const k = key();
  const call = async () => ({ outcome: "success" as const, result: { category: "sanitation" } });

  const results = await Promise.all([withAiCache(client, k, call), withAiCache(client, k, call)]);

  assert.equal(results.length, 2);
  for (const r of results) assert.equal(r.outcome, "success");
  const { rows } = await client.query(
    "select count(*)::int as n from ai_result_cache where input_hash = $1",
    [k.inputHash],
  );
  assert.equal(rows[0]?.["n"], 1);
});

// ---------------------------------------------------------------------------
// Wiring the cache into the calls the pipeline actually makes
// ---------------------------------------------------------------------------

test("V023: the same text is embedded once, however many reports contain it", async () => {
  // The repeat V023 named. Two people reporting the same landmark in the same
  // words is the ordinary case, and on a five-per-minute tier the second
  // embedding is the one that rate-limits.
  let calls = 0;
  const embed = async (text: string) => {
    calls += 1;
    return {
      vector: Array.from({ length: 4 }, (_, i) => (i + text.length) / 100),
      model: "gemini-embedding-001",
      dimensions: 4,
      normalized: true,
    };
  };
  const text = `the drain by gate ${randomUUID()}`;
  const cached = cachedEmbedText(client, embed, { modelName: "gemini-embedding-001" });
  trackText(text, "gemini-embedding-001", EMBEDDING_PROMPT_VERSION);

  const first = await cached(text);
  const second = await cached(text);

  assert.equal(calls, 1);
  assert.deepEqual(second.vector, first.vector);
  assert.equal(second.dimensions, first.dimensions);
  assert.equal(second.normalized, true);
});

test("V023: a cached embedding is not passed off as a different model's", async () => {
  // The vector is only meaningful against vectors from the same model. Reusing
  // one across models would silently compare incomparable numbers.
  let calls = 0;
  const embed = (model: string) => async (text: string) => {
    calls += 1;
    return { vector: [text.length / 10], model, dimensions: 1, normalized: true };
  };
  const text = `same words ${randomUUID()}`;
  trackText(text, "gemini-embedding-001", EMBEDDING_PROMPT_VERSION);
  trackText(text, "some-other-embedder", EMBEDDING_PROMPT_VERSION);

  await cachedEmbedText(client, embed("gemini-embedding-001"), {
    modelName: "gemini-embedding-001",
  })(text);
  const other = await cachedEmbedText(client, embed("some-other-embedder"), {
    modelName: "some-other-embedder",
  })(text);

  assert.equal(calls, 2);
  assert.equal(other.model, "some-other-embedder");
});

test("V023: an embedding failure is propagated, not cached as an empty vector", async () => {
  const text = `failing ${randomUUID()}`;
  trackText(text, "gemini-embedding-001", EMBEDDING_PROMPT_VERSION);
  let calls = 0;
  const embed = async () => {
    calls += 1;
    if (calls === 1) throw new Error("provider unavailable");
    return { vector: [0.5], model: "gemini-embedding-001", dimensions: 1, normalized: true };
  };
  const cached = cachedEmbedText(client, embed, { modelName: "gemini-embedding-001" });

  await assert.rejects(() => cached(text), /unavailable/);
  // A cached empty vector would make every later comparison silently wrong.
  const retried = await cached(text);
  assert.deepEqual(retried.vector, [0.5]);
  assert.equal(calls, 2);
});

test("V023: a cached embedding reports the provider's own model and normalisation", async () => {
  // Both fields are read back from the row, not restated from the request.
  // `normalized` decides whether cosine similarity is valid at all, and the
  // model name is what tells a later reader whether two vectors are even
  // comparable — a wrapper that asserted its own values would make an
  // unnormalised vector look safe to compare.
  const text = `unnormalised ${randomUUID()}`;
  trackText(text, "asked-for-model", EMBEDDING_PROMPT_VERSION);
  const embed = async () => ({
    vector: [3, 4],
    // The provider answering as a different model than the caller named: a
    // served-from-a-fallback case that must not be papered over.
    model: "provider-actually-used",
    dimensions: 2,
    normalized: false,
  });
  const cached = cachedEmbedText(client, embed, { modelName: "asked-for-model" });

  const fresh = await cached(text);
  const hit = await cached(text);

  assert.equal(fresh.normalized, false);
  assert.equal(hit.normalized, false);
  assert.equal(hit.model, "provider-actually-used");
  assert.deepEqual(hit.vector, [3, 4]);
});
