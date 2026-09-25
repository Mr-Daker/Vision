# VOICE dataset limitations

What this dataset cannot support, stated plainly. Read alongside
`methodology.md` and the ethics section of `docs/data/README.md`.

## 1. The citizen data is not real

No record in `synthetic/` describes a real complaint, a real person, a real
issue or a real place below district level. The dataset exists so analytics can
be **evaluated against known ground truth**, which requires labels no real
corpus carries. It cannot be used to describe actual citizen demand anywhere in
India, and no figure derived from it is evidence about any real place.

## 2. Planted scenarios say nothing about the districts they land on

Scenarios are assigned by weighted random draw. A district carrying Scenario C
("complaints continue after a project was completed") is not a district where a
project failed — it is a district that drew a label in a simulation. Any
presentation of this data must make that unmissable, and must not name a real
district as an example of a planted failure.

## 3. Census 2011 is fourteen years out of date

It remains the most recent full Indian census, but:

- **Boundaries have changed substantially.** Many districts have been created or
  bifurcated since 2011; Telangana did not exist as a state. District codes here
  are 2011 codes and will not join cleanly to post-2011 administrative data.
- **Populations have moved.** Every population, household and literacy figure is
  as of 2011 and should be treated as a structural characteristic, not a current
  measurement.
- **627 of ~640 districts** are present. The remainder did not return usable
  DISTRICT-level rows from the published resources.

## 4. Most infrastructure values are modelled, not measured

Only **151 of 2,508 district-sector cells (6%)** are anchored on a real district
table, and those real anchors are themselves single-state parliamentary answers
with differing years (2007-08 to 2022) and differing definitions. The other 94%
are `derived` from census characteristics by the rule in `methodology.md` §2.

The derivation encodes a *direction* (urban, literate districts tend to be
better served) that is a commonplace of development statistics, but its
magnitudes are chosen to spread the data, not fitted to evidence. **A derived
infrastructure value must never be published as a statistic about a district.**

Consequence for analytics: a method that appears to "detect" infrastructure
deficits is partly detecting the generator's own rule. Findings about the
relationship between demographics and infrastructure are circular here and are
not transferable to real data.

## 5. Every project record is invented

Scheme names (Jal Jeevan Mission, PMGSY, Samagra Shiksha, PM-ABHIM) are real
programmes. The sanctions, releases, expenditures, dates and statuses attached
to them are entirely synthetic. Nothing here is evidence about any real
programme's disbursement or delivery, and no row should ever be quoted as one.

## 6. Coordinates are approximate placements, not locations

District coordinates are a deterministic point inside the district's *state*
bounding box. They are **not centroids**, and report coordinates are jittered
from them. Any genuine geospatial analysis — distance, adjacency, catchment,
routing, boundary containment — will produce wrong answers. `population_density`
likewise assumes districts within a state have equal area, making it a ranking
proxy rather than a density.

## 7. Native-language coverage is partial

English templates cover all 16 issue types. Hindi, Marathi, Tamil and Bengali
cover common types only; Telugu, Kannada, Malayalam, Gujarati, Punjabi, Odia and
Assamese have language labels but currently no native templates. Those reports
carry English text with `raw_description_language_matched = false`.

This was chosen over machine-translating templates into languages nobody on the
project can review. A multilingual model trained on this corpus will therefore
see far less non-English text than the `language` column implies, and the flag
column is the honest way to measure that.

## 8. Text diversity is template-bounded

Descriptions are drawn from roughly three templates per issue type with a
substituted locality name. Real citizen text is far more varied, misspelled,
truncated and code-mixed. Any NLP evaluation on this corpus will overstate
performance on real input, and deduplication in particular is easier here than
in reality because near-identical phrasings recur by construction.

## 9. Ground truth is a simulation's ground truth

The labels are perfectly correct *about the simulation*. They say nothing about
whether the same signals would identify unmet need in reality. A method that
recovers the planted scenarios has demonstrated it can recover **this
generator's** structure — a necessary condition for usefulness, not a sufficient
one. Do not report evaluation scores from this dataset as real-world accuracy.

## 10. The generator's assumptions are the dataset's ceiling

Volume is `need × participation` by construction, so any analysis concluding
"raw counts mislead because participation varies" is recovering an assumption
that was built in. The dataset can show a method *works given* that assumption;
it cannot validate the assumption itself. The same applies to seasonality
shapes, the persistence distribution and the Zipf duplicate structure.

## 11. Sub-district geography is absent

`block_code`, `block_name`, `locality_code` are empty throughout. No licensed
source in this pipeline supplies sub-district codes, and inventing
official-looking codes is forbidden. Locality *names* on reports are synthetic
and deliberately do not correspond to real villages. Analysis below district
level is not supported.

## 12. Operational caveats

- The public data.gov.in sample key caps responses at 10 records and rate-limits
  aggressively; a full download takes 10–15 minutes and can partially fail.
  `data:download` is resumable and records failures in `sources.csv`.
- `data.gov.in` displayed a "sandbox environment" banner at retrieval time
  (see `sources.csv` retrieval dates). The API returned coherent official data,
  but this is noted rather than assumed away.
- `citizen_reports.csv` is capped at 200,000 rows. The Parquet file is complete;
  use it for anything above that scale.
