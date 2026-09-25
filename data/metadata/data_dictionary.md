# VOICE data dictionary

Every table produced by `pipelines/voice_data`. `data_origin` on each row is
authoritative: `real` was retrieved from an official source under a licence
permitting reuse, `derived` was computed from real values by a documented rule,
`synthetic` was generated.

---

## `master/district_master.csv` — one row per district

| Column | Type | Origin | Notes |
| --- | --- | --- | --- |
| `country_code` | str | real | Always `IN`. |
| `state_code` | str | real | Census 2011 state code, zero-padded to 2. |
| `state_name` | str | real | From the STATE-level census row. |
| `district_code` | str | real | Census 2011 district code, zero-padded to 3. |
| `district_key` | str | real | `state_code + district_code`. The join key everywhere. |
| `district_name` | str | real | Census name, title-cased. |
| `block_code`, `block_name`, `locality_code`, `locality_name` | str | — | **Empty.** No official source in this pipeline supplies sub-district codes, and inventing an official-looking code is forbidden. Synthetic localities are *named* on reports, never coded. |
| `latitude`, `longitude` | float | **derived** | A deterministic point inside the district's state. **Not a centroid.** |
| `coordinates_origin` | str | — | Always `derived`, as a standing warning. |
| `codes_origin` | str | — | Always `real`. |

## `processed/demographics.csv` — one row per district

All from the Census 2011 Primary Census Abstract.

| Column | Type | Origin | Notes |
| --- | --- | --- | --- |
| `population`, `households` | int | real | Census counts. |
| `population_density` | float | **derived** | population ÷ (state area ÷ district count). Assumes equal-area districts — a ranking proxy, not a density. |
| `rural_population_pct`, `urban_population_pct` | float | real | From the census Rural/Urban rows. |
| `literacy_rate` | float | real | Literates ÷ population × 100. Census definition (age 7+ literacy is *not* separately applied). |
| `female_population_pct`, `sc_population_pct`, `st_population_pct`, `working_population_pct`, `child_population_pct` | float | real | Ratios of census counts. Child = age 0–6. |
| `data_origin` | str | — | `real`. |
| `population_density_origin` | str | — | `derived`, flagging the one exception above. |
| `source_name`, `source_url`, `source_year`, `retrieved_at` | str | — | Provenance. |

## `processed/{water,road,education,health}_infrastructure.csv`

One row per district per sector. **`data_origin` varies by row.**

Shared columns: `district_key`, `state_code`, `district_name`, `sector`,
`infrastructure_score` (0–100, higher is better served),
`infrastructure_deficit_score` (100 − score), `data_origin`,
`real_source_key` (which real table anchored this row, when one did).

| Sector | Sector-specific columns |
| --- | --- |
| water | `tap_water_coverage_pct`, `households_with_tap_water`, `total_households`, `water_scheme_count`, `functional_water_scheme_pct` |
| roads | `road_length_km`, `sanctioned_road_length_km`, `completed_road_length_km`, `road_completion_pct`, `road_project_count` |
| education | `school_count`, `student_enrolment`, `schools_with_drinking_water_pct`, `schools_with_toilets_pct`, `schools_with_electricity_pct`, `schools_with_boundary_wall_pct`, `schools_requiring_major_repair_pct`, `pupil_teacher_ratio` |
| health | `phc_count`, `chc_count`, `hospital_count`, `health_facilities_per_100k`, `bed_count`, `beds_per_100k`, `doctor_or_staff_availability_indicator`, `facility_utilization_indicator` |

Rows marked `derived` are modelled from census characteristics (see
`methodology.md` §2). **They are not measurements of that district.**

## `processed/public_investments.csv` — one row per project

**Every row is `synthetic`.** `scheme_name` is a real central programme; the
project, its money and its dates are invented.

`project_id`, `sector`, `state_code`, `district_code`, `district_key`,
`district_name`, `project_name`, `scheme_name`, `sanctioned_amount`,
`released_amount`, `spent_amount`, `currency` (INR), `sanction_date`,
`start_date`, `expected_completion_date`, `actual_completion_date`,
`project_status` (`planned` | `sanctioned` | `in_progress` | `completed` |
`delayed` | `unknown`), `project_scope`, `coverage_area`, `source`,
`data_origin`, `notice`.

Invariants enforced by `data:validate`: `spent ≤ released ≤ sanctioned`, all
non-negative.

## `synthetic/canonical_issues.csv` / `.parquet` — the ground-truth problems

One row per real-world problem that reports observe. **This is label data.**

| Column | Notes |
| --- | --- |
| `canonical_issue_id` | Primary key. Referenced by reports. |
| `district_key`, `sector`, `issue_type`, `issue_subtype`, `locality_name` | Placement. Locality is invented. |
| `lat`, `lon` | Jittered from the district's derived point. |
| `severity_ground_truth` | 1–5. Reports observe this *noisily*. |
| `first_seen_at`, `last_seen_at` | Recomputed from the reports actually generated. |
| `affected_population_estimate` | Synthetic. |
| `persistence_days` | Observed span. |
| `true_status` | `resolved` \| `unresolved` \| `persistent_unresolved`. |
| `true_project_overlap` | Whether a sanctioned project genuinely covers this issue. |
| `true_infrastructure_deficit` | Whether a real deficit underlies it. |
| `report_count` | How many reports observed it. |
| `scenario_id` | Blank unless planted. |

## `synthetic/citizen_reports.parquet` (+ capped `.csv`)

One row per report. **The CSV is capped at 200,000 rows**; the Parquet file is
complete. Full schema in `pipelines/voice_data/generate.py::_report_schema`.

Notable columns:

| Column | Notes |
| --- | --- |
| `report_id` | Primary key. |
| `citizen_id_hash` | Opaque BLAKE2s hash. No name, contact or demographic attribute exists. |
| `created_at` | Second resolution, uniform within its month. |
| `state_code`, `district_code`, `district_key` | Real codes. `block_code`, `locality_code` are empty by design. |
| `latitude`, `longitude` | Derived, jittered from the issue. |
| `input_channel` | `mobile_app` \| `web` \| `whatsapp` \| `sms` \| `existing_portal`. |
| `input_mode` | `text` \| `voice` \| `image_text` \| `voice_image`. |
| `language` | 12 languages, geographically weighted by state. |
| `raw_description` | Native-language text where a template exists, else English. |
| `normalized_description` | Always English. |
| `raw_description_language_matched` | **False** where `raw_description` is English despite a non-English `language`. |
| `severity` | 1–5, a noisy read of `severity_ground_truth` (±1). |
| `duplicate_cluster_id` | **Empty by design** — the column a deduplicator writes. |
| `canonical_issue_id` | **Ground truth.** Withhold when evaluating deduplication. |
| `evidence_confidence` | 0–1, higher with image and verified identity. |
| `image_available`, `image_path_or_placeholder`, `image_authenticity_signal` | No image bytes are generated; the placeholder says so. |
| `verified_identity`, `anonymous_identity`, `support_count`, `status` | Report state. |
| `scenario_id` | **Ground truth.** Withhold when evaluating. |

## `synthetic/citizens.csv`

`citizen_id_hash`, `district_key`, `state_code`, `primary_language`,
`primary_channel`, `report_count`, `ever_verified`, `data_origin`.
Deliberately thin — no attribute here could identify a person even in principle.

## `synthetic/planted_scenarios.csv`

The scenario inventory: which district-sector cell carries which scenario, the
levers applied, the expected interpretation, and the `ground_truth_*` flags.

## `master/district_sector_master.csv` / `.parquet` — **the analytical table**

One row per **district × sector × month**. Districts × 4 sectors × 24 months;
every combination exists, including months with zero reports (silence is data).

Groups: identity (`country_code` … `sector`, `year`, `month`); demography
(`population`, `population_density`); citizen signal (`citizen_report_count`,
`unique_citizen_count`, `canonical_issue_count`, `reports_per_10k`,
`avg_severity`, `high_severity_report_count`, `persistent_issue_count`,
`avg_persistence_days`); infrastructure (`infrastructure_score`,
`infrastructure_deficit_score`, `infrastructure_data_origin`); investment
(`sanctioned_investment`, `released_investment`, `spent_investment`,
`active_project_count`, `completed_project_count`, `delayed_project_count`,
`last_project_completion_date`, `months_since_last_completion`);
participation (`digital_participation_score`, `platform_adoption_score`,
`reporting_propensity`, `urbanization_proxy`); and **ground truth**
(`scenario_id`, `ground_truth_scenario`, `expected_interpretation`,
`ground_truth_unmet_need`, `ground_truth_investment_gap`,
`ground_truth_execution_gap`, `ground_truth_emerging_hotspot`,
`ground_truth_silent_need`).

`ground_truth_scenario` is `none` for unplanted cells — a real class, not a null.

**No VOICE priority or recommendation score is computed here.** That is the
next phase.

## `metadata/sources.csv`

Mirrors the 16 columns of `docs/foundation/registers/source-register.csv` plus
`data_origin`, `columns_used`, `cleaning_performed`, `rows_retrieved` and
`retrieval_status`. Sources that failed or were deliberately not ingested are
listed with the reason and the substitute used.
