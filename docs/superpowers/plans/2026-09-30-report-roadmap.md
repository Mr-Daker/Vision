# Report Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a resident, under a saved receipt, the eight-step roadmap of their report and its escalation track.

**Architecture:** Pure domain builders → owner-scoped adapter reusing the supervisor ageing context → private GET route → pure web view model → DOM block in the receipt.

**Tech Stack:** TypeScript, PostgreSQL, `node:test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-30-report-roadmap-design.md`.
- No score, no severity, no word implying anyone was notified.
- Owner-scoped: a stranger's request is indistinguishable from a missing report (404).
- Every new locale key in en-IN and mr-IN, rendered from a file `capture.test.ts` scans.

### Task 1: Domain builders — `packages/domain/src/report-roadmap.ts` (+ test)

- [ ] Tests: pre-check, checked-not-grouped, awaiting answer, routing review, routed (acknowledge current), work planned, claimed (resident's turn), confirmed (all done), disputed, reopened; escalation due dates, pause shifting them, recorded alerts, no track once confirmed.
- [ ] Implement `ROADMAP_STEPS`, `buildRoadmap`, `buildEscalation`; export from `index.ts`.

### Task 2: Adapter — `packages/adapters/src/report-roadmap.ts` (+ dbtest)

- [ ] Export `loadAgeingContext` from `supervisor-queues.ts`.
- [ ] `readReportRoadmap` as specified; dbtest: new report → received/checked; grouped + routed issue → escalation present; stranger → undefined.

### Task 3: API — `GET /v1/me/reports/:id/roadmap` in `citizen-routes.ts`

- [ ] Add `ageingPolicy` to the citizen route deps (server.ts loads it for the profile).

### Task 4: Web — `toRoadmapView` in `tracking.ts` (+ test), strings, markup, render

- [ ] `api.roadmap(id)`; render into `#receipt-roadmap` after a receipt is found; "View progress" label.

### Task 5: Verify — `npm run check`, related dbtests, browser with the resident's real reports.
