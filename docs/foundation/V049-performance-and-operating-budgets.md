# V049 — Performance measurements and operating budgets

**Roadmap task:** V049 · **Prerequisites:** V006, V013, V023, V026, V039, V043, V048 · **Owner:** Platform + QA
**Code:** `packages/domain/src/performance.ts`, `packages/adapters/src/performance.ts` · **Budgets:** `packages/config-packs/src/packs/demo-district-a/budgets.json` · **Command:** `npm run perf:measure` · **Results:** [V049-performance-results.md](../../deliverables/V049-performance-results.md)

V002 row 22 wrote this task's prohibited claim down years before the measurement existed: _national-scale capacity extrapolated from a small demonstration_. The temptation is not dishonesty, it is arithmetic — a laptop served a request in five milliseconds, a district has four hundred thousand people, therefore — and the "therefore" is where a measurement becomes a promise nobody can keep. So the refusal is in code, not in a footnote.

## 1. A percentile that says where it sits

With forty observations a p95 is the third-slowest one. Writing "p95 = 5.0 ms" hides that; `percentileOf` returns the value **and** how many observations were slower, and there is no branch that prints the number alone. When the rank lands on the maximum the sentence says so outright: _a maximum wearing a percentile's name_. Nearest-rank rather than an interpolating method, because interpolation invents a value between two observations and at these sample sizes the invented value would be doing more work than the data.

This is V046's "counts, not rates" applied to latency, and it comes from the same reasoning.

## 2. A measurement without its conditions is not a measurement

The conditions are read rather than described: hostname, CPU count, memory, the database's own `max_connections`, `shared_buffers`, `work_mem`, `statement_timeout` and version as the server reports them, and the row count of every table whose size changes what a query costs. They print above the figures, not in a footnote, because the figure and the thing that makes it meaningless have to travel together.

`capacityClaimVerdict` then refuses, and lists why: not the deployed environment, not the data volume a claim would be about, **sequential** — so nothing here describes contention, which is the only thing a capacity figure is about — and any measurement with fewer than thirty observations or any failures at all. A latency figure that excludes the requests that failed describes a system that was not the one under test.

## 3. A budget names its own source, and which side of the limit is good

V026 recorded that a default in code is what makes an uncalibrated number invisible. So the budgets are a pack, and every entry is either `measured` — saying what measured it and when — or `chosen`, saying by what reasoning. The loader refuses a third kind, refuses a chosen number with no reasoning, and refuses any budget that does not say **what happens when it is exceeded**: a limit with no consequence is a wish.

Each budget also declares a direction, and that is not a detail. The connection budget is a **floor** — V006 §5 requires at least 36 for the workload — and the first run of this reported a healthy 47 as "exceeded", because the checker assumed every limit was a ceiling. A budget that reports a passing system as failing is how a budget stops being read.

## 4. What was measured

Against a local container holding roughly 900 issues, sequentially, on one laptop. Every figure carries the count of observations slower than it in the results document.

| Measurement                                        | Median  | p95     |
| -------------------------------------------------- | ------- | ------- |
| receipt latency (`POST /v1/submissions` over HTTP) | 4.5 ms  | 5.0 ms  |
| upload grant and byte `PUT`                        | 5.0 ms  | 5.4 ms  |
| receipt read after acceptance                      | 2.6 ms  | 3.1 ms  |
| candidate retrieval (V026)                         | 0.39 ms | 0.85 ms |
| district dashboard (V039)                          | 11.8 ms | 12.8 ms |

Retrieval returned **432 candidates across 40 timed queries, none of them empty**. That number is printed beside the latency deliberately: a query that matches nothing is fast, and a retrieval figure from queries that retrieved nothing measures the index rather than the work.

**Connections.** Opening connections until the container refused, the 48th was refused: 47 usable against `max_connections=50` with 3 reserved. V006 §5's gate of 36 is met with eleven to spare — and this is a measurement of _what the setting yields_, not of what it claims, which is the distinction V006 asked for. The managed instance is still unprovisioned, so the re-measurement V006 actually needs has not happened.

**Storage.** 492 bytes per report, measured as the delta across fifty inserted reports rather than divided out of the total — the total holds fixtures, seeds and several tasks' leftovers, and dividing it would attribute all of that to reports.

**AI cost.** Not exercised here; no provider call is made, so no token is spent. The measured figures are V046's — 16 calls, 1 841 input and 230 output tokens for eight reports — and no monetary figure accompanies them, because no price for this model is in the source register.

## 5. The one number the evidence says to change

Processing takes about 3 ms. The development worker polls every **2 000 ms**. So the dominant term in the time between a citizen pressing send and their report reaching a department is the poll interval, by a factor of roughly six hundred — the work is not the wait.

V017 recorded that "V049 is where the poll interval would be chosen from evidence rather than picked", and this is that evidence. It is **not changed here**, because how often a worker may query the database is a decision about load on a shared instance rather than a measurement, and the instance it would run against does not exist yet. The recommendation is recorded instead: on this evidence a poll interval in the hundreds of milliseconds would put a report in front of a department inside a second and cost a couple of queries a second per worker. The owner decides.

No index was changed. Retrieval at 0.85 ms over 900 issues does not justify one, and adding an index on the strength of a measurement that did not need it is how a schema accumulates indexes nobody can remove.

## 6. What these figures do not establish

- every figure is from one machine, one container, and the data that happened to be in it;
- the workload is synthetic and **sequential**, so nothing here describes contention;
- no figure may be multiplied by a population to produce a capacity — the specific claim V002 row 22 prohibits;
- a percentile over a few dozen observations is a ranked observation, not an estimate of a distribution;
- nothing measures a cold start, a network between services, or a provider under load.

## 7. Open

Concurrency. Every figure here is sequential, and the question a capacity budget exists to answer is what happens when requests arrive together — including the serialization-failure rate V028 deferred here, which cannot be measured without contention. A managed instance to measure against is V051's, and the pilot-scale measurement is V062's.
