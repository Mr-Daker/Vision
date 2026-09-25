# V049 — Performance measurements and operating budgets

Measured 2026-09-18T00:26:20.648Z on `Bs-MacBook-Air.local` — 10 CPU(s), 16.0 GiB, PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2).

## What this run may not be used to say

This run **may not back a capacity claim**, and the reasons are listed in full rather than summarised, because the arithmetic that turns a latency into a capacity is easy enough to do by accident.

1. this ran on 'Bs-MacBook-Air.local' with 10 CPU(s), which is not the environment any capacity claim would be about
1. the data volume present during the run is not the volume a claim would be about, and query cost does not stay flat as rows accumulate
1. the run was sequential, so nothing here measures what happens when requests arrive at once — which is the only thing a capacity figure is about
1. 'upload_grant_and_put' has 25 observation(s); a tail figure from that is the second or third slowest sample wearing a percentile's name
1. 'dashboard_read' has 20 observation(s); a tail figure from that is the second or third slowest sample wearing a percentile's name

## Conditions

| Setting                               | Value                           |
| ------------------------------------- | ------------------------------- |
| `max_connections`                     | 50                              |
| `superuser_reserved_connections`      | 3                               |
| `shared_buffers`                      | 128MB                           |
| `work_mem`                            | 4MB                             |
| `effective_cache_size`                | 4GB                             |
| `statement_timeout`                   | 2min                            |
| `idle_in_transaction_session_timeout` | 30s                             |
| `server_version`                      | 17.11 (Debian 17.11-1.pgdg13+2) |
| concurrency during the run            | 1 (sequential)                  |

Rows present when the run started — query cost does not stay flat as these grow:

| Table                 | Rows  |
| --------------------- | ----- |
| `canonical_issue`     | 1,078 |
| `submission`          | 402   |
| `evidence_item`       | 272   |
| `issue_evidence_link` | 144   |
| `issue_participation` | 152   |
| `status_event`        | 757   |
| `outbox`              | 174   |
| `summary_issue_fact`  | 1,078 |

## Measurements

| Measurement          | Observations | Failures | Min     | Median                                      | p95                                        | Max     |
| -------------------- | ------------ | -------- | ------- | ------------------------------------------- | ------------------------------------------ | ------- |
| receipt_latency      | 40           | 0        | 4.2 ms  | 4.54 ms (20 of 40 observations were slower) | 5.11 ms (2 of 40 observations were slower) | 5.5 ms  |
| upload_grant_and_put | 25           | 0        | 4.5 ms  | 4.89 ms (12 of 25 observations were slower) | 6.62 ms (1 of 25 observations were slower) | 6.8 ms  |
| processing_delay     | 40           | 0        | 1.0 ms  | 2.49 ms (20 of 40 observations were slower) | 2.81 ms (2 of 40 observations were slower) | 2.9 ms  |
| candidate_query      | 40           | 0        | 0.3 ms  | 0.45 ms (20 of 40 observations were slower) | 0.86 ms (2 of 40 observations were slower) | 1.1 ms  |
| dashboard_read       | 20           | 0        | 10.8 ms | 11.5 ms (10 of 20 observations were slower) | 12.5 ms (1 of 20 observations were slower) | 13.2 ms |

- **receipt_latency** — POST /v1/submissions over HTTP with a session and a CSRF token: what a citizen waits for before they are told their report was accepted
- **upload_grant_and_put** — POST /v1/uploads then PUT the bytes: the grant, the signed token and the write, which is what a photograph costs before anything looks at it
- **processing_delay** — the delay between a submission being accepted and its receipt being readable again, which is the part of the wait a citizen sees as 'still processing'
- **candidate_query** — retrieveCandidates: the spatial and temporal search a new report runs against every open issue nearby (V026)
- **dashboard_read** — readDistrictDashboard: the whole district view, including its freshness and reconciliation state (V039)

Candidate retrieval returned 1021 candidate(s) across 40 timed queries, of which 0 returned none. This is printed beside the latency because **a query that matches nothing is fast**, and a retrieval figure from queries that retrieved nothing measures the index and not the work.

## Database connections

Opened 47 concurrent connections; the 48th was refused. `max_connections` is 50, with 3 reserved for superusers.

## Storage growth

164 bytes per report, measured as the delta across 50 inserted reports (5,92,69,120 → 5,92,77,312 bytes of public tables). Measured as a delta rather than divided out of the total, because the total holds fixtures, seeds and several tasks' leftovers and dividing it would attribute all of that to reports.

## AI cost

Not exercised by this run: no provider call is made here, so no token is spent. The measured figures are in [the V046 results](V046-evaluation-results.md) — 16 calls, 1 841 input and 230 output tokens for eight reports — and no monetary figure accompanies them, because no price for this model is recorded in the source register.

## Budgets

Loaded from `demo-budgets.v1`. Operating budgets (V049). Every entry says where its number came from — 'chosen' with the reasoning, or 'measured' with what measured it and when — because a limit whose origin nobody recorded is indistinguishable from a limit somebody guessed. These are demonstration-scale budgets against a local container; a deployed instance must re-measure and revise them (V006 §5).

- receipt_latency_p95_ms: 5.11 ms against a ceiling of 1500 ms — within. (chosen: a citizen standing in the street with one bar of signal should see their receipt before they assume the report was lost; 1.5 s is the point at which people start pressing the button again, and a second submission is a second record of one problem.) When exceeded: stop accepting new demonstration load and look at the submission path before the queue, because a receipt that is late is a receipt a person will duplicate
- candidate_query_p95_ms: 0.86 ms against a ceiling of 400 ms — within. (chosen: retrieval runs inside the matching stage's lease and shares it with an embedding call and a transaction; 400 ms keeps it a small part of a stage sized at 180 s, so a slow query is visible long before it threatens the lease.) When exceeded: check the spatial index is being used before adding one, then reduce the time window in the matching pack rather than the radius, because the window costs rows and the radius costs accuracy
- dashboard_read_p95_ms: 12.5 ms against a ceiling of 2000 ms — within. (chosen: the dashboard is read by an operator at a desk, not by a person in the street, and it reads the whole district including its freshness and reconciliation state; two seconds is a page that feels slow rather than broken.) When exceeded: read from the summary projection rather than widening it, and if the projection itself is slow, rebuild before tuning — a drifted projection does more work than a fresh one
- processing_delay_p95_ms: 2.81 ms against a ceiling of 5000 ms — within. (chosen: the matching stage without a provider call is database work only; five seconds leaves room for a serialization retry and still puts an issue in front of a department inside one poll interval.) When exceeded: look at serialization failures first: a retry is a whole unit of work re-run, so a rising retry rate multiplies this figure rather than adding to it
- workload_connections_min: 47.0 connections against a floor of 36.0 connections — within. (chosen: V006 §5's gate: instance_max_connections must exceed the superuser reservation plus six for administration plus 36 for the workload, so that every service can set both max_instances and pool_max without the sum exceeding what the instance will give.) When exceeded: instance counts drop before pool sizes, because a service that cannot get a connection fails every request while a service with fewer instances fails none
- storage_bytes_per_issue_max: 164 bytes against a ceiling of 65536 bytes — within. (chosen: an issue carries its submission, its evidence rows, its links, its participation, its events and its projected fact; 64 KiB per issue is a ceiling chosen to make growth visible rather than to be tight, and it is the figure V049 re-measures.) When exceeded: measure which table grew before changing retention, because the answer decides whether this is evidence, events or the projection — and only one of those may be deleted
- ai_calls_per_report_max: not measured in this run against a ceiling of 2.00 calls — unknown. (chosen: one classification and one embedding. Anything above two means the cache missed or a retry ran, and both are worth seeing because both are paid.) When exceeded: check the AI cache key before the provider: a changed prompt version or model name makes every previous answer a miss, which is correct behaviour and an expensive surprise

## What these figures do not establish

- every figure here is from one machine, one database container, and the data that happened to be in it; none of that is the deployed environment
- the workload is synthetic and sequential unless a measurement says otherwise, so nothing here describes contention
- no figure may be multiplied by a population to produce a capacity, which is the specific claim V002 row 22 prohibits
- a percentile over a few dozen observations is a ranked observation, not an estimate of a distribution
- nothing here measures a cold start, a network between services, or a provider under load
