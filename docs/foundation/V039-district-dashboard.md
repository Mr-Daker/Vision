# V039 — District dashboard with evidence drill-down

**Roadmap task:** V039 · **Prerequisites:** V030, V036, V037, V038 · **Owner:** Frontend + Data
**Code:** `packages/adapters/src/dashboard.ts`, `apps/api/src/dashboard-routes.ts`, `apps/web/src/dashboard-view.ts` · **Screen:** `apps/web/public/dashboard.html`

V037 defined what the numbers mean, V038 projected them into tables. This is the screen, and its entire job is to be a set of numbers a reader can check rather than a set of numbers a reader must trust.

## 1. Every total says what it is a total of

The first thing on the page is the reconciliation banner. `sourcePopulation` is counted live from the authoritative records using V038's own merge resolution; `projectedTotal` is summed from the stored summary cells; the banner states both and says whether they agree.

When they disagree it says so in the caution tone, names the difference, and says the page should not be quoted until the summary is rebuilt. It does not show the prettier number. This is checked in the browser by inserting one report without reprojecting: the banner flips from "267 reports, and the table adds up to them" to "These totals do not add up to the records … a difference of 1."

The reconciliation is deliberately **not** a comparison of two implementations of the same walk — both sides resolve merges through `FACT_SELECT_SQL`, because two different definitions of "one report" would make every check a coin toss between two defensible answers. What it detects is the failure that actually happens: a projection that is behind, or wrong, about the records it claims to describe.

Every row of the table also adds up to its own ward total, including an **Other categories** column for reports filed under a category the taxonomy pack does not list. Hiding those would have made the table stop adding up to the headline above it; giving them their own tracked column would have manufactured empty rows for categories nobody tracks.

## 2. Zero is not missing — and the distinction is real, not decorative

V038 only materialises cells that hold something: a cell with zero issues is deleted rather than stored. So emptiness at cell grain carries no information on its own. What does carry information is the **health of the whole projection**, and that is what separates the two:

| On screen | Means                                                                  | When                                                                              |
| --------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `4`       | four reports                                                           | a stored cell holds them                                                          |
| `0`       | the summary is up to date, matches the records, and found nothing here | no stored cell **and** the projection is fresh, reconciled, and its totals add up |
| `No data` | nothing can be concluded about this slot                               | no stored cell and any of those three is false                                    |

The same empty slot renders one way or the other depending on whether the summary above it can be trusted, and a database test drives exactly that flip. `figure` is the single function that produces both, and it returns a different string **and** a different tone: `No data` is set in the display face, recessive and uppercase, so a reader scanning a column of numerals cannot take it for a small count. Collapsing the two into one permanently cautious label would have been safe in the wrong direction — a map that always says "we cannot say" teaches its readers to ignore the caution.

Reports that have not been placed in a ward get their own visible row rather than being dropped, and the coverage banner reports the three kinds of gap separately: slots that cannot be reported on, reports with no ward, and reports filed under untracked categories. Three different problems with three different fixes.

## 3. Freshness counts what a queue cannot see

`assessFreshness` takes both `pendingEvents` and `unprojectedIssues`. The second exists because no production path appends a `status_event` when an issue is opened, so a brand-new report adds nothing to the event backlog while being entirely absent from the summary — a projection reporting "nothing pending" while a hundred reports have never been projected would be the most misleading thing that function could say. Found during this task's own browser pass, where the totals banner correctly said the page was behind while the freshness banner said it was up to date.

## 4. From an indicator to its records, and no further

Select any count and the reports behind it open; select a report and its evidence opens. The chain stops exactly where the V015 boundary does.

The dashboard rides the **V036 supervisor session** rather than introducing a sixth role. A supervisor already holds `issue.read_private` and `evidence.read_redacted` inside their own jurisdictions and — the part that matters — does **not** hold `evidence.read_original`. `DashboardEvidenceItem` has no field that could carry a private original's reference, and the query selects `derivative_reference` and never `object_reference`: a select list is a boundary a later refactor cannot accidentally widen the way a filtered response object can. Both the adapter test and the HTTP test assert against the raw serialised bytes that no `originals/` path left the server.

The jurisdiction scope comes from the server-side grant on every request. The cell key travels in the URL, so it is checked against that grant before anything is read — a reader who edits it meets a refusal rather than a ward they have no grant for. The unplaced bucket is counted but cannot be opened at all: no jurisdiction grant covers reports that belong to no jurisdiction.

The whole surface is read-only, and anything that is not a GET is refused before a session is even looked up. A dashboard that could change the thing it measures would make "what does the district look like" depend on who has been looking at it.

## 5. Measures travel with their definitions

Three V037 measures are shown — age of unresolved issues, fixed-window resolution, reopening rate — each with its meaning, numerator, denominator and missing-data behaviour behind a disclosure, and each labelled **district-wide** rather than per-ward. Per-ward versions of the last two would have an empty denominator in most wards and would render as zero, which is precisely the confusion this screen exists to avoid. An unknown measure renders as "Not known — " plus the reason in words; there is no code path that can print `0` for a quantity the server declined to answer.

`rollUpCells` shares V037's refusals exactly, so the page cannot total counted participants across wards, and cannot total anything across two boundary directory versions.

## 6. Limits

- **Current state only.** The dashboard describes now and says when it was built. Historical horizons are V037's question, answered from the ledger.
- **No approved photo derivative exists in the demo data**, so the redacted-image path is covered by tests but has not been seen rendered in a browser. That is the separately recorded broken demo-image fixture, not a defect in this screen.
- **Linked from the supervisor workspace only.** The reviewer and department workspaces hold different sessions and would meet a refusal.
- **`readDistrictDashboard` walks every issue on every load** to count the live population. At demo scale that is well under a second; a deployment with real volume would cache the population count between projections, and that is V049's work rather than a change to the contract above.
