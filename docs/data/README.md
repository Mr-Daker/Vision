# VOICE data foundation

The dataset VOICE analytics will be built and evaluated against: real Indian
demographic data, partly-real infrastructure indicators, synthetic public
investment records, and a large body of synthetic citizen feedback generated
**conditionally on those real regional characteristics**, with known ground
truth planted so later analytics can be scored rather than admired.

Pipeline: [`pipelines/voice_data`](../../pipelines/voice_data). Nothing here is
imported by the application; it reads and writes `data/` and nothing else.

> **Read this before quoting any number from this dataset.**
> Citizen reports, canonical issues and project records in this dataset are
> **synthetic**. They are not real complaints, not real sanctions, and not real
> expenditure. Where a synthetic hardship scenario lands on a real district
> name, that is an artefact of random assignment and says nothing whatever
> about conditions in that district. See [Ethics and interpretation](#9-ethics-and-interpretation).

---

## 1. What data is real

| Table | Origin | Source |
| --- | --- | --- |
| `master/district_master.csv` | **real** codes, `derived` coordinates | Census 2011 Primary Census Abstract, per state, via data.gov.in |
| `processed/demographics.csv` | **real** (one `derived` column) | Census 2011 PCA |
| `processed/*_infrastructure.csv` | **mixed**, marked per row | data.gov.in district tables where they exist; `derived` elsewhere |
| `processed/public_investments.csv` | **synthetic** | generator |
| `synthetic/*` | **synthetic** | generator |
| `master/district_sector_master.csv` | mixed; every column traceable to the above | — |

**Real, and genuinely so:** 627 districts across 34 states/UTs with official
`state_code` and `district_code`, population, households, literates, SC and ST
population, workers, children aged 0–6, and the rural/urban split — all from
the Census 2011 Primary Census Abstract, retrieved from data.gov.in under the
Government Open Data License – India, which permits reuse with attribution.
Derived ratios (literacy rate, female share, and so on) are arithmetic on those
figures and nothing else.

**Real but fragmentary:** district-level sector tables exist on data.gov.in only
as single-state parliamentary answers — Madhya Pradesh, Tamil Nadu and Haryana
for water; Odisha and Karnataka for roads; Himachal Pradesh for schools; a
DLHS-III sample and the aspirational-district list for health. Together they
anchor **151 of 2,508 district-sector cells (6%)**. There is no national
district-level table for any of the four sectors, and this pipeline does not
pretend otherwise.

**Not used, and why:** the Local Government Directory is captcha- and
login-gated with no downloadable extract; UDISE+ and PMGSY/OMMS did not respond
and require registration; NITI Aayog's SDG Index and MPI publish only
state-level figures. Each is recorded in `data/metadata/sources.csv` with the
reason and the substitute used. This follows the position already set in
[V004](../foundation/V004-source-and-reuse-register.md): *public visibility of a
dataset is not permission to reuse it in bulk*.

## 2. What data is synthetic

Everything about citizens, their reports, the issues behind those reports, and
every project record. Also the ~94% of infrastructure cells with no real source,
which are marked `derived` rather than `synthetic` because they are computed
from real census characteristics by a stated rule.

## 3. Why synthetic citizen feedback is necessary

No open national dataset contains citizen development requests with location,
sector, language, severity, duplication structure and outcome. CPGRAMS publishes
disposal statistics, not complaint-level records, and nothing public links
complaints to infrastructure indicators and investment. VOICE analytics cannot
be built — or, more to the point, **evaluated** — without such a corpus, so this
pipeline generates one with known ground truth instead of waiting for one that
does not exist.

Generating it also avoids the alternative failure: training and tuning on a
convenience sample of real grievances would bake in that portal's own reporting
bias, which is one of the exact problems VOICE is meant to detect.

## 4. How real characteristics drive synthetic feedback

Report volume for a district-sector-month is a product, not a draw:

```
weight = population^0.82
       × (deficit/100)^1.5 × (1.25 − 0.55 × investment_adequacy)   ← need
       × realised_participation                                     ← who reports
       × scenario_demand_multiplier
       × scenario_trend_shape[month]
       × sector_seasonality[calendar_month]
       × lognormal(0, 0.35)                                         ← noise
```

- **Need** rises with the infrastructure deficit and falls as money per head
  rises, so a district with poor tap-water coverage, many people and no water
  project tends to produce persistent water complaints.
- **Participation** is a separate factor built from urbanisation and literacy.
  Volume is `need × participation`, which is what lets need and silence coexist.
- **Seasonality** is directional and mild: water peaks before the monsoon, roads
  and drainage during it, education tracks the academic year.
- **Noise** is deliberately large. Nothing in this dataset is a clean function
  of its indicators, and some unplanted districts look planted by chance.

## 5. What scenarios were planted

162 district-sector cells carry one of eight scenarios; the other ~2,346 are
ordinary. Full inventory in `data/synthetic/planted_scenarios.csv`, labels on
the master table as `ground_truth_*`.

| Code | Situation | Expected interpretation |
| --- | --- | --- |
| A | High demand, poor infrastructure, large population, no relevant project | NEW INVESTMENT GAP |
| B | High demand, poor infrastructure, project already sanctioned and running | DO NOT RECOMMEND DUPLICATE INVESTMENT; MONITOR EXECUTION |
| C | Project completed and money spent, complaints continue after completion | POSSIBLE EXECUTION / OUTCOME GAP |
| D | Reports climbing sharply over recent months | EMERGING HOTSPOT |
| E | Reports consistently high across the whole window | PERSISTENT UNMET NEED |
| F | Large metro: high raw volume, unremarkable per-capita rate, decent infrastructure | RAW REPORT COUNT SHOULD NOT DOMINATE |
| G | Severe deficit, vulnerable population, very few reports, low participation | POSSIBLE UNDER-REPORTING |
| H | Good infrastructure, adequate investment, few complaints | LOW PRIORITY |

The scenarios overlap on purpose. A and B both show heavy demand over poor
infrastructure and are separated only by the investment record; C resembles B
until report dates are compared against the completion date; F resembles a
crisis until you divide by population. A dataset whose labels can be read off
one column would test nothing.

**Withhold at evaluation time:** `ground_truth_*`, `scenario_id`,
`expected_interpretation` on the master table, and `canonical_issue_id` and
`scenario_id` on the report table. Those are labels, not features.

## 6. How to regenerate

One-time setup (creates `.venv`, installs pandas/numpy/pyarrow/requests):

```bash
npm run data:setup
```

Fetch the real sources into `data/raw/` (~1,900 paged API requests on the public
sample key; roughly 10–15 minutes, and cached afterwards):

```bash
npm run data:download
```

Build everything. `--` passes arguments through to the pipeline:

```bash
npm run data:all -- --reports 100000 --seed 42     # development sample
npm run data:all -- --reports 500000 --seed 42     # mid scale
npm run data:all -- --reports 1000000 --seed 42    # full scale
```

Individual steps, and the checks:

```bash
npm run data:prepare
npm run data:generate -- --reports 500000 --seed 42
npm run data:validate
npm run data:summary
```

A registered data.gov.in key removes the 10-records-per-request cap and makes
the download much faster:

```bash
export DATA_GOV_IN_API_KEY=your_key_here
```

**Determinism:** the same `--seed` reproduces the same dataset. The 24-month
window is pinned in `config.py` rather than derived from today's date, so a
regeneration next month is identical rather than shifted.

## 7. Dataset limitations

Full list in `data/metadata/limitations.md`. The ones that matter most:

- **Census 2011 is fourteen years old.** District boundaries have changed
  substantially since (new districts, bifurcations, Telangana). Population and
  literacy have moved. Everything demographic is as of 2011 and labelled so.
- **Coordinates are not real.** They are a deterministic point inside the
  district's own state, not a centroid. Do not do geospatial analysis with them.
- **`population_density` assumes equal-area districts within a state.** It is a
  ranking proxy, not a density.
- **94% of infrastructure values are modelled**, not measured.
- **Every project record is invented.** The scheme names are real programmes;
  the sanctions, releases and expenditures attached to them are not.
- **Native-language text is a documented subset.** English covers every issue
  type; Hindi, Marathi, Tamil and Bengali cover common ones. Reports in a
  language with no template keep the language label, carry English text, and set
  `raw_description_language_matched = false` so the gap is visible rather than
  filled with a bad translation.

## 8. What this dataset supports

Without redesign: unmet-need detection, demand-vs-population normalisation,
corroboration of complaints against infrastructure indicators, investment-gap
and duplicate-investment analysis, post-completion outcome gaps, emerging
hotspot detection, under-reporting detection, deduplication and canonical-issue
recovery, and scoring any of those against the planted ground truth.

Deliberately **not** included yet: any priority score, recommendation engine,
dashboard or model. This phase is the foundation only.

## 9. Ethics and interpretation

- **These are not real allegations.** No record here describes a real
  complaint, a real failure, a real contractor, or a real official. Nothing
  supports a claim about any real government body's performance.
- **A planted scenario is not a finding.** Scenarios are assigned by weighted
  random draw. A district carrying Scenario C is not a district where a project
  failed; it is a district that drew a label in a simulation.
- **No political or credibility scoring.** The pipeline produces no rating of
  any government, party, official or contractor, and the vocabulary is
  deliberately kept to observation ("reports continue after completion") rather
  than intent.
- **Localities are invented.** Report-level place names are built from neutral
  name fragments so no real village is named in a synthetic hardship report.
- **No personal data, real or simulated-realistic.** Citizens are an opaque
  hash with no name, contact detail or demographic attribute.
- **Do not publish derived infrastructure values as statistics about a
  district.** They are modelling inputs. The `data_origin` column on every row
  exists precisely so this line is never crossed by accident.
