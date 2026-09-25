/**
 * What an alert must carry before it is worth sending (roadmap V050).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AlertError,
  BANNED_MONITORING_PHRASES,
  EXAMPLE_LIMIT,
  MONITORING_LIMITS,
  SIGNAL_NAMES,
  alert,
  alertStatement,
  monitoringOverclaims,
  monitoringVerdict,
  type SignalReading,
} from "./observability.ts";

const base = {
  signal: "stage_failures" as const,
  severity: "page" as const,
  summary: "stage_failures is past its budget",
  observed: 3,
  threshold: 0,
  unit: "terminal failures",
  identifiers: ["11982", "11983"],
  state: { signal: "stage_failures", observed: 3, threshold: 0 },
  runbook: "V050 runbook §3 — safe replay",
};

test("an alert with no identifier is refused", () => {
  assert.throws(() => alert({ ...base, identifiers: [] }), AlertError);
});

test("an alert with no state is refused, because an id alone is a search", () => {
  assert.throws(() => alert({ ...base, state: {} }), AlertError);
});

test("an alert naming no runbook section is refused", () => {
  assert.throws(() => alert({ ...base, runbook: "  " }), AlertError);
});

test("prose where an identifier belongs is refused", () => {
  assert.throws(
    () =>
      alert({
        ...base,
        identifiers: ["the drain outside the school is blocked"],
      }),
    AlertError,
  );
});

test("prose in a state field is refused, because state is codes and counts", () => {
  assert.throws(
    () =>
      alert({
        ...base,
        state: { reason: "the citizen said the wall had fallen over" },
      }),
    AlertError,
  );
});

test("codes, versions and ids are not mistaken for prose", () => {
  const entry = alert({
    ...base,
    identifiers: ["11982", "demo-routing.v1", "stage_failed_permanently", "connections_in_use=3"],
    state: { reason_code: "stage_failed_permanently", task_type: "match_submission" },
  });
  assert.equal(entry.identifiers.length, 4);
});

test("identifiers are bounded, because an alert is pasted into a chat", () => {
  const entry = alert({
    ...base,
    identifiers: Array.from({ length: EXAMPLE_LIMIT + 20 }, (_, index) => String(index)),
  });
  assert.equal(entry.identifiers.length, EXAMPLE_LIMIT);
});

test("the statement carries the state, the ids and the runbook together", () => {
  const statement = alertStatement(alert(base));
  assert.match(statement, /state:/);
  assert.match(statement, /ids:/);
  assert.match(statement, /runbook:/);
});

const reading = (
  signal: (typeof SIGNAL_NAMES)[number],
  value: number | undefined,
): SignalReading => ({
  signal,
  value,
  unit: "things",
  examples: [],
  ...(value === undefined ? { unavailable: "the table is missing" } : {}),
});

test("a run where every signal read and none is firing is clean", () => {
  const verdict = monitoringVerdict({
    readings: SIGNAL_NAMES.map((signal) => reading(signal, 0)),
    alerts: [],
  });
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.noWatchedSignalIsFiring, true);
});

test("a signal that could not be read is a reason, never a healthy zero", () => {
  const verdict = monitoringVerdict({
    readings: SIGNAL_NAMES.map((signal) =>
      reading(signal, signal === "outbox_lag" ? undefined : 0),
    ),
    alerts: [],
  });
  assert.equal(verdict.noWatchedSignalIsFiring, false);
  assert.ok(verdict.reasons.some((reason) => /outbox_lag.*could not be read/.test(reason)));
});

test("a signal nobody read at all is a reason", () => {
  const verdict = monitoringVerdict({
    readings: SIGNAL_NAMES.filter((signal) => signal !== "model_cost").map((s) => reading(s, 0)),
    alerts: [],
  });
  assert.ok(verdict.reasons.some((reason) => reason.includes("model_cost")));
});

test("pages and warnings are counted separately", () => {
  const verdict = monitoringVerdict({
    readings: SIGNAL_NAMES.map((signal) => reading(signal, 0)),
    alerts: [alert(base), alert({ ...base, signal: "queue_age", severity: "warning" })],
  });
  assert.equal(verdict.pages, 1);
  assert.equal(verdict.warnings, 1);
});

test("the verdict never reports a system as healthy, only that nothing watched is firing", () => {
  const verdict = monitoringVerdict({
    readings: SIGNAL_NAMES.map((signal) => reading(signal, 0)),
    alerts: [],
  });
  assert.equal("healthy" in verdict, false);
});

test("the limits say that nothing here delivers an alert anywhere", () => {
  assert.ok(MONITORING_LIMITS.some((limit) => /not a pager/.test(limit)));
});

test("the banned phrasings catch a claim a seven-signal read cannot support", () => {
  assert.ok(monitoringOverclaims("Complete observability; nothing can go unnoticed.").length >= 2);
  for (const phrase of BANNED_MONITORING_PHRASES) assert.equal(phrase, phrase.toLowerCase());
});
