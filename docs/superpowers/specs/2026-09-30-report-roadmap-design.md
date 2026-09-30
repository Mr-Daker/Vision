# Report roadmap and escalation track — design

Date: 2026-09-30. Approved by the product owner in conversation.

## Problem

A resident who opens a saved receipt sees a reference, one status line and a
date. The issue behind it records every step (routed, acknowledged, planned,
claimed, confirmed) with a time, and the supervisor side already computes how
long the department has had it against the configured wait. The resident sees
none of it and cannot tell what happens next or when.

## Design

Under a saved receipt (reached from "Find a saved receipt" and from every row
of "Your reports", whose button becomes "View progress"):

1. **Roadmap** — eight steps: Received · Photo and description checked ·
   Grouped with an issue · Sent to a department · Department acknowledges ·
   Work planned · Repair claimed · You confirm it is fixed. Each is done (with
   its recorded date), current, or upcoming. The current step carries one plain
   sentence saying what is happening, and says so when the next move is the
   resident's (answer "is this the same problem?", confirm a repair).
2. **Escalation track** — only while a department is responsible and the issue
   is not confirmed fixed: "day N of A with the department", the date it is
   flagged to a supervisor (alert) and the date it is escalated, from the
   ageing policy for the issue's category (or a supervisor's override), the
   same pause rules the supervisor view uses, and any alert already recorded.
   Wording: alerts are recorded internally; this build notifies nobody.

## Architecture

- **Domain, pure:** `report-roadmap.ts` — `buildRoadmap(input)` and
  `buildEscalation(input)`; no clock, no storage.
- **Adapter:** `readReportRoadmap(tx, { participantId, submissionId, policy,
asOf })` — owner-scoped; reads the submission, its processing event, a
  pending match question, the live issue link, the issue's events, the latest
  routing decision, and the supervisor's ageing context (pauses, override,
  current-window alerts) via the now-exported `loadAgeingContext`.
- **API:** `GET /v1/me/reports/:submissionId/roadmap` — private, session-bound,
  `no-store`; 404 for anything not the resident's own.
- **Web:** `toRoadmapView` (pure, tested) and a roadmap block in the saved
  receipt; English and Marathi strings.

## Not changing

The ageing arithmetic, supervisor screens, public issue page, alert semantics.

## Verification

Domain tests for every lifecycle position and the escalation dates with and
without pauses/alerts; a database test for the adapter including a stranger
getting nothing; view-model tests; `npm run check`; the resident's real
reports in the browser.
