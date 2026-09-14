# V037 — Analytics Metric Semantics

**Status:** Ready for owner approval
**Roadmap task:** V037 · **Prerequisites:** V014, V029, V035 · **Owner:** Analytics + Backend

This document defines reproducible analytics contracts for the Vision system. The foundational rule for analytics in this system is that missing data stays missing, and an unresolved or claimed status is never a standing resolution.

## 1. Mandatory Core Rules

- **A resolution claim is not a resolution.** It is only a staff assertion.
- **Only a standing `resolution_confirmed` issue counts as currently closed.**
- **Reopening removes the issue from current closure counts.**
- **Resolution speed must not be calculated only from resolved issues** and presented as performance for the full cohort (this is survivorship bias).
- **Fixed-window comparisons must include only cohorts with sufficient observation time.** A 30-day resolution rate cannot include issues opened 10 days ago.
- **Reopening during the observation window invalidates the earlier resolution.** If an issue is resolved on day 5 and reopened on day 10, it is not "resolved within 30 days" if the observation window closes while it is reopened.
- **Count canonical issue roots, not complaint rows.** Issues with an active outgoing alias (merged away) are excluded from base issue counts, though their data contributes to their root.
- **Merged issues must not be double-counted.** All aggregates apply to the active alias closure.
- **Unique contributors are distinct `participant_id`s across the active alias closure.**
- **Local distinct contributor counts cannot be summed** to obtain a higher-level distinct count (the same person might report in multiple jurisdictions).
- **Report volume must never be called affected population.**
- **Estimated population must come from a separate source** with source date, coverage, and units. It is never derived from submission counts.
- **Unknown or missing data must remain unknown, never silently become zero.**
- **Simulated records and integrations must remain visibly simulated.**
- **Do not invent national-scale claims from the demonstration dataset.**

## 2. Metric Definition Table

For each metric, the following semantics apply across the board unless otherwise specified:
- **Treatment of merged/separated issues:** Metrics are evaluated against the active canonical root (following `issue_alias` edges where `valid_to` IS NULL). Merged-away issues are excluded from the denominator as independent entities.
- **Issue-alias root semantics:** All child data (events, evidence, participants) is logically folded into the active root before calculation.
- **Jurisdiction/boundary version:** Uses the active jurisdiction at the `as-of timestamp`.
- **Category/taxonomy version:** Uses the issue's active category at the `as-of timestamp`.
- **Late corrections/rebuild behavior:** Rebuilding analytics from the event stream (`status_event`) as of a historical timestamp must yield the exact historical value, applying only corrections with an `occurred_at` <= the `as-of timestamp`.

| Stable Identifier | Plain-Language Meaning | Authoritative Tables / Events | Exact Numerator | Exact Denominator | Start Timestamp | End Timestamp | As-of Timestamp |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `metric_current_backlog` | Number of unresolved canonical issues currently active. | `canonical_issue`, `issue_alias` | Count of canonical roots where `current_status` != 'resolution_confirmed'. | N/A (absolute count) | `opened_at` | N/A | Evaluation time (now) |
| `metric_backlog_by_category_jurisdiction` | Unresolved issues grouped by category and jurisdiction. | `canonical_issue`, `issue_alias` | Count of canonical roots where `current_status` != 'resolution_confirmed', grouped. | N/A | `opened_at` | N/A | Evaluation time (now) |
| `metric_accepted_issue_cohorts` | Issues created in a specific time window. | `canonical_issue`, `issue_alias` | Count of canonical roots opened within the window. | N/A | Window start | Window end | Window end |
| `metric_resolution_rate` | Percentage of an accepted cohort that is currently resolved. | `canonical_issue`, `issue_alias` | Canonical roots from cohort currently in `resolution_confirmed`. | All canonical roots from the cohort. | `opened_at` | N/A | Evaluation time (now) |
| `metric_fixed_window_resolution_rate_30d` | Percentage of a cohort resolved within 30 days of opening, without reopening within those 30 days. | `canonical_issue`, `issue_alias`, `status_event` | Canonical roots resolved within 30 days and NOT reopened within 30 days. | Canonical roots opened > 30 days ago. | `opened_at` | `opened_at` + 30 days | `opened_at` + 30 days |
| `metric_time_to_resolution` | Distribution of time taken to reach standing confirmed resolution, including censored data. | `canonical_issue`, `status_event` | Time from `opened_at` to first `resolution_confirmed` (adjusted for reopenings). | All canonical roots in cohort. | `opened_at` | Final `resolution_confirmed` event | Evaluation time (now) |
| `metric_age_unresolved_issues` | Age distribution of the current backlog. | `canonical_issue`, `issue_alias` | `as_of_timestamp` - `opened_at` for unresolved roots. | Unresolved canonical roots. | `opened_at` | N/A | Evaluation time (now) |
| `metric_resolution_claims_awaiting` | Number of staff repair claims needing participant/reviewer confirmation. | `canonical_issue`, `resolution_claim` | Count of roots where `current_status` = 'resolution_claimed'. | N/A | Claim `claimed_at` | N/A | Evaluation time (now) |
| `metric_disputed_resolutions` | Number of claims currently rejected by citizens. | `canonical_issue` | Count of roots where `current_status` = 'resolution_disputed'. | N/A | Dispute event time | N/A | Evaluation time (now) |
| `metric_reopening_rate` | Percentage of confirmed resolutions that were later reopened. | `canonical_issue`, `reopening`, `status_event` | Count of roots with at least one `issue_reopened` event. | Roots that ever reached `resolution_confirmed`. | First `resolution_confirmed` | N/A | Evaluation time (now) |
| `metric_standing_confirmed_resolutions` | Total successfully closed issues not currently reopened. | `canonical_issue`, `issue_alias` | Count of roots where `current_status` = 'resolution_confirmed'. | N/A | `opened_at` | Confirmation event | Evaluation time (now) |
| `metric_unique_contributors` | Number of distinct people who reported an issue. | `issue_participation`, `issue_alias` | Count of distinct `participant_id` where `counted = true` in active alias closure. | N/A | First evidence | Last evidence | Evaluation time (now) |
| `metric_evidence_submission_counts` | Volume of evidence items attached to an issue. | `issue_evidence_link`, `evidence_item` | Count of `issue_evidence_link` where `effective_to` IS NULL. | N/A | `effective_from` | N/A | Evaluation time (now) |
| `metric_estimated_population_served` | External population size for a jurisdiction. | External authoritative source | Value from external source. | N/A | Source effective date | Source expiry | Source effective date |
| `metric_data_coverage_unknowns` | Proportion of records with missing categorical data. | `canonical_issue` | Count of rows missing the field. | All rows in scope. | `opened_at` | N/A | Evaluation time (now) |

### Metric Specific Rules

#### Treatment of unresolved/censored issues
For `metric_time_to_resolution`, unresolved issues must be included in the denominator (using survival analysis methods like Kaplan-Meier). Calculating average time-to-resolution *only* on resolved issues is explicitly forbidden, as it hides long-standing unresolved issues.

#### Treatment of reopening
Reopening immediately transitions the issue out of `resolution_confirmed`. For fixed-window metrics (e.g., 30-day resolution), if an issue is resolved on day 5 and reopened on day 10, it is NOT counted in the numerator for the 30-day window. If it is reopened on day 35, it IS counted in the numerator for the 30-day window (as the window closed while it was resolved).

#### Treatment of disputed claims
Disputes keep an issue out of the `resolution_confirmed` state. Claims awaiting confirmation or currently disputed do NOT count as resolved.

#### Missing-data behaviour
Missing data (e.g., population) yields `NULL` or `UNKNOWN`. It must never fallback to `0`. 

#### Mandatory Disclosures
- Any dashboard showing contributor counts must disclose: "A count of counted participants; it does not mean nobody else is affected, and it is not evidence that the reports are accurate."
- Any dashboard showing resolutions must disclose: "A confirmed repair means people agreed the problem looks fixed; it is not an inspection or an engineer's certification."

#### Claims the UI must never make
- Never claim report volume is "affected population".
- Never claim "0 corroborations" means "0 other people are affected".
- Never present Reviewer Confirmation as Citizen Confirmation.
- Never present a Staff Claim as a Verified Resolution.

## 3. Formulas and Pseudocode

### Canonical Root Resolution (SQL-like)
```sql
-- CTE to find the active root for any issue
WITH RECURSIVE active_roots AS (
    SELECT issue_id AS original_id, issue_id AS root_id
    FROM canonical_issue
    WHERE NOT EXISTS (SELECT 1 FROM issue_alias WHERE source_issue_id = canonical_issue.issue_id AND valid_to IS NULL)
    
    UNION ALL
    
    SELECT a.source_issue_id, r.root_id
    FROM issue_alias a
    JOIN active_roots r ON a.target_issue_id = r.original_id
    WHERE a.valid_to IS NULL
)
```

### Unique Contributors
```sql
SELECT root_id, COUNT(DISTINCT p.participant_id) as unique_contributors
FROM active_roots r
JOIN issue_participation p ON p.canonical_issue_id = r.original_id
WHERE p.counted = true
GROUP BY root_id;
```

### 30-Day Fixed Window Resolution Rate
```sql
-- Denominator: all roots opened strictly more than 30 days before as_of_timestamp
SELECT 
    COUNT(CASE WHEN resolved_within_30d AND NOT reopened_within_30d THEN 1 END) AS numerator,
    COUNT(*) AS denominator
FROM cohort_issues;
```

## 4. Worked Examples

**1. Normal Closure:** 
- Day 1: Issue opened. 
- Day 5: Staff claims resolution (`current_status` = 'resolution_claimed'). Not resolved. 
- Day 7: Citizen confirms (`current_status` = 'resolution_confirmed'). Resolved.
- *Fixed-window 30d result:* Numerator = 1, Denominator = 1.

**2. Dispute:** 
- Day 1: Issue opened. 
- Day 5: Staff claims resolution. 
- Day 6: Citizen disputes (`current_status` = 'resolution_disputed').
- *Fixed-window 30d result (if still disputed at Day 30):* Numerator = 0, Denominator = 1.

**3. Reopening:** 
- Day 1: Issue opened. 
- Day 5: Confirmed. 
- Day 10: Reopened (`current_status` = 'reopened'). 
- *Fixed-window 30d result:* Numerator = 0, Denominator = 1.

**4. Merge:** 
- Issue A and Issue B both have 2 contributors, with 1 person reporting both. 
- B is merged into A. B has an active `issue_alias` to A. 
- Backlog count: 1 (Issue A is the root).
- Unique contributors for A: 3 (union of sets, not sum).

**5. Insufficient Observation Window:** 
- Issue opened 15 days ago. Resolved 5 days ago. 
- *Fixed-window 30d result:* Excluded from denominator entirely.

**6. Missing Population Data:** 
- Jurisdiction X has no population estimate loaded.
- *Result:* `estimated_population` = NULL. Per-capita metrics = NULL.

## 5. Invariants V038 Must Preserve

- V038 (Analytics Pipeline Implementation) must use `current_version` and `status_event` ledgers to reconstruct state at `as_of_timestamp` exactly.
- V038 must project `issue_participation` folding rules (as defined in V029) accurately when aggregating unique contributors across aliases.
- V038 must NEVER emit an assumed `0` for missing population or demographic data.

## 6. Acceptance Tests V038 Should Later Implement

1. **Survivorship Bias Test:** Assert that `time_to_resolution` calculation accepts censored inputs (unresolved issues) and does not drop them from the denominator.
2. **Reopening Window Test:** Assert an issue confirmed on day 5 and reopened on day 10 yields `false` for `resolved_within_30d_window`.
3. **Double Counting Test:** Assert that summing unique contributors across two merged issues equals the mathematical union, not the scalar sum.
4. **Hierarchical Disaggregation Test:** Assert that a dashboard querying `sum(unique_contributors)` across multiple jurisdictions triggers a validation failure or returns a prominent warning that summing distinct counts yields incorrect results.
5. **Observation Window Test:** Assert that an issue opened 29 days ago is excluded from the 30-day fixed-window denominator.

## 7. Explicit Unresolved Product Decisions

1. **Cross-jurisdiction distinct counts:** While summing distinct counts locally is banned, how should the UI handle a user explicitly requesting a national-level distinct contributor count? (Option: Force a full table scan query, or disable the metric entirely).
2. **Reopening after fixed window:** If an issue is reopened on Day 40, does it retrospectively alter the historical report of the 30-day cohort rate generated on Day 31? (Recommendation: Fixed windows are snapshots; Day 40 events do not rewrite the Day 30 snapshot).
