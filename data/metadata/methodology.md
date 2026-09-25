# VOICE dataset methodology

How each table was produced, in enough detail to reproduce or dispute it.
Every claim here is implemented in `pipelines/voice_data`; where the two
disagree, the code is correct and this document is a bug.

## 1. Real data acquisition

**Endpoint.** `https://api.data.gov.in/resource/<id>` with `format=json`,
paged by `offset`. Datasets served there carry the Government Open Data
License – India, which permits reuse with attribution — the licence this
pipeline relies on for every row marked `real`.

**The 10-record cap.** The public sample key returns 10 records per request
regardless of `limit`, while reporting success. Every read therefore pages in
steps of 10; a national census read is ~1,900 requests. A caller trusting
`limit` would ingest 10 rows and believe it had the table. Setting
`DATA_GOV_IN_API_KEY` raises the cap, and the client reads the true page size
from the first response.

**Discovery, not hard-coding.** The per-state Census 2011 resources are found
at run time via `/lists?filters[title]=Primary Census Abstract 2011`. `/catalog`
and a bare `/resource` are 404; the reported `total` counts the whole catalogue
rather than the matches, so titles are filtered client-side. The India-level
resource (states only, no districts) and the duplicate "Orissa" spelling are
excluded.

**Rate limiting.** The first full run lost ten consecutive states — each of
which answered when requested alone. Backoff is now 6 attempts at 4s × attempt,
with a 0.35s courtesy delay between requests. Retrying harder is the fix;
requesting faster is not.

**Caching.** Responses are written to `data/raw/` with their retrieval time,
source URL and licence. `data:prepare` reads only the cache, so cleaning can be
re-run freely without touching a government service, and the pipeline is
reproducible offline.

## 2. Infrastructure: real anchors, derived remainder

Real district tables were found for a minority of cells and are used directly,
marked `real` with `real_source_key` naming the source. For water, household
counts in the Tamil Nadu and Haryana tables are denominated in lakhs; the
coverage *ratio* is unit-free so the scale cancels, and only the household count
is rescaled.

Everything else is `derived` from a latent per-sector quality score:

```
quality[sector] = 0.42
                + w1·urbanisation + w2·literacy + w3·log-density − w4·ST-share (sector-specific)
                + district_effect ~ N(0, 0.16)      ← terrain, history, state capacity
                + sector_noise    ~ N(0, 0.13)
                clipped to [0.03, 0.97]
```

The direction of each term is the only claim being made, and each is a
commonplace of development statistics. Magnitudes were chosen to spread the
scores, **not fitted to evidence**. The shared `district_effect` makes a
district's sectors correlate without moving together, which is both more
realistic and stops the dataset being trivially separable.

Sector-specific fields are then projected from that score (tap coverage ≈ score;
school facility percentages centred and spread; pupil-teacher ratio inverse;
facilities per 100k scaled by population). **A derived value is a modelling
stand-in, never a statistic about that district.**

District coordinates are a deterministic draw inside the district's own state
bounding box. Boundary shapefiles that would give true centroids are outside the
agreed licence position, so rather than ingest an unlicensed file or invent an
official-looking centroid, the placement is approximate and marked `derived`.
`population_density` divides state area equally among its districts — a ranking
proxy only.

## 3. Public investment

Entirely synthetic. Ordinary cells draw a Poisson project count rising with
deficit and population, so money tends to follow need imperfectly. Planted cells
override: Scenario A and G get **no** project (the absence is the thing to
detect), B gets active projects, C gets a project completed *inside* the window
with high spend, E gets a delayed one, H gets completed ones.

Amounts are lognormal. Release and spend ratios are conditioned on status, and
the invariant `spent ≤ released ≤ sanctioned` is enforced and validated.
Scheme names are real programmes; every record is marked `synthetic` and carries
a `notice` saying it is not a real sanction.

## 4. Citizen demand model

For each district × sector × month:

```
weight = population^0.82
       × (deficit/100)^1.5 × (1.25 − 0.55·adequacy)
       × realised_participation
       × scenario_demand_multiplier
       × scenario_trend[month]
       × sector_seasonality[calendar_month]
       × lognormal(0, 0.35)
```

`adequacy = 1 − exp(−spend_per_head / 120)` — squashed so that a lot of money
per head means need is being met, with diminishing returns.

`participation = clip(0.16 + 0.006·urban% + 0.005·(literacy−55) + N(0,0.06))`,
then multiplied by the scenario's propensity multiplier. **Volume is
`need × participation`**, which is what allows severe need with near-silence
(Scenario G) and high volume with modest need (Scenario F).

The weights are converted to integer counts by a single multinomial draw against
the requested total, so `--reports 100000` and `--reports 1000000` describe the
same country sampled at different depths.

**Trend shapes** (relative demand across the 24 months): `rising` is quiet then
climbs steeply late; `chronic` is persistently high with slow waves; `declining`
decays exponentially to a floor; `flat_high` and `flat` are constant. All are
perturbed by lognormal noise.

**Seasonality** is directional and mild: water peaks March–June, roads and
drainage June–September, health rises slightly in the monsoon, education tracks
the academic year. Noise is large enough that no cell is a clean function of its
season.

## 5. Canonical issues and duplication

Issues are created per district-sector at roughly one per 7.5 allocated reports,
Poisson-drawn. Each has a start month and a heavy-tailed persistence
(negative binomial), floored at 9 months for chronic scenarios.

A report can only observe an issue **active in its month**, which is what makes
the issue's first/last-seen dates meaningful. Within the active set the draw is
Zipf-like (weight ∝ 1/rank^0.9): a few issues attract most reports and a long
tail is reported once. Uniform assignment would make every duplicate cluster the
same size and the deduplication task unrealistically easy.

`severity` on a report is `severity_ground_truth ± 1` — an observation, not the
truth. `duplicate_cluster_id` is left empty: it is the column a deduplicator
writes, and filling it with the answer would hand the task to the method being
evaluated.

## 6. Citizens

Drawn from a bounded pool per district sized at roughly one reporter per 2.6
allocated reports, with a `random^1.7` skew so a minority file a
disproportionate share. Generating one citizen per report would make "unique
citizens" identical to "reports" and destroy per-person analysis.

## 7. Language and text

Language is drawn 62% the state's regional language, 18% Hindi, 16% English, 4%
spread across the rest — geographically plausible rather than uniform, and never
a claim about a state's true linguistic composition.

English templates exist for all 16 issue types. Native templates
(Hindi, Marathi, Tamil, Bengali) exist for common types only. A report in a
language with no template keeps its language label, carries English text and
sets `raw_description_language_matched = false`. Fabricating translations would
poison any multilingual NLP trained on this corpus.

Locality names are built from neutral Indian place-name fragments so no real
village is ever named in a synthetic hardship report.

## 8. Determinism

Every random draw comes from `numpy.random.default_rng(seed ^ constant)` with a
per-stage constant, so stages are independent but reproducible. The 24-month
window is pinned in `config.py` rather than derived from the current date, so a
regeneration next month is byte-identical rather than shifted.

## 9. Performance

1,000,000 reports generate in ~42 seconds end-to-end on a laptop. Attributes are
drawn with NumPy across whole chunks and streamed to Parquet through
`ParquetWriter` (zstd), so the full table is never held in memory. The CSV mirror
is capped at 200,000 rows because a million-row CSV helps nobody; the Parquet
file is complete.
