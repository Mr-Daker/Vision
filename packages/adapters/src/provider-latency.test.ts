/**
 * The provider is slow, and every timeout budget has to agree about that
 * (roadmap V023).
 *
 * Measured against the real endpoint on 2026-09-11: a prompt of "Reply with the
 * single word: ok" took **35 s**, and the same prompt with
 * `thinkingConfig.thinkingBudget: 128` took **49 s**. `thinkingBudget: 0` is
 * rejected with HTTP 400 — this model always thinks — so the latency is not
 * something the caller can opt out of. Earlier in the same day the same model
 * answered in 2.6 s, so the range is wide and load-dependent.
 *
 * Two budgets depend on that number, and they were set independently:
 *
 *  * the adapter's request timeout, which at 20 s reported a **working**
 *    provider as `provider_unreachable, retryable: true` — the same failure
 *    family as the blank model name that once looked like a retryable outage,
 *    and with the same consequence: a relay retrying forever against something
 *    that is not actually broken;
 *  * the matching stage's lease, which must outlast the call it makes. A lease
 *    that expires mid-call lets another worker take the stage over and fence
 *    the first one's writes out, so the work is done twice and the first
 *    attempt's results vanish.
 *
 * This file pins the relationship between them, so the two cannot drift apart
 * silently again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TIMEOUT_MS } from "./gemini.ts";
import { MATCHING_LEASE_SECONDS } from "./matching-pipeline.ts";

/** The slowest trivial call measured against the live endpoint. */
const MEASURED_WORST_CASE_MS = 49_000;

test("V023: the request timeout allows for the latency actually measured", () => {
  // A timeout below the measured latency turns every call into a reported
  // outage, and the report is retryable — so the relay keeps paying for calls
  // it then abandons.
  assert.ok(
    DEFAULT_TIMEOUT_MS >= MEASURED_WORST_CASE_MS,
    `the request timeout is ${String(DEFAULT_TIMEOUT_MS)} ms, below the ${String(MEASURED_WORST_CASE_MS)} ms measured against the live endpoint`,
  );
});

test("V023: the stage lease outlasts the provider call it makes", () => {
  // With a 60 s lease and a 49 s call there is 11 s for everything else in the
  // stage, which is not a margin, it is a coincidence.
  assert.ok(
    MATCHING_LEASE_SECONDS * 1_000 > DEFAULT_TIMEOUT_MS,
    `the stage lease is ${String(MATCHING_LEASE_SECONDS)} s and a single provider call may take ${String(DEFAULT_TIMEOUT_MS / 1_000)} s`,
  );
});

test("V023: the lease leaves room for the rest of the stage, not just the call", () => {
  // Retrieval, the embedding, the assignment transaction and the trust
  // evaluation all happen inside the same lease. Half again the provider
  // budget is the margin this asserts — enough that a slow call does not by
  // itself end the lease.
  const marginMs = MATCHING_LEASE_SECONDS * 1_000 - DEFAULT_TIMEOUT_MS;
  assert.ok(
    marginMs >= DEFAULT_TIMEOUT_MS / 2,
    `only ${String(marginMs / 1_000)} s remains for the rest of the stage after one provider call`,
  );
});
