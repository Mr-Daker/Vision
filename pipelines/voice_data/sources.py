"""The registry of external sources this pipeline reads, and what each is for.

Every entry here was reached and inspected before being listed. Sources that
were investigated and found unusable are recorded too, in `UNAVAILABLE`, with
the reason — a register that lists only what worked teaches the next reader
nothing about what was already ruled out.

Licence position (settled with the project owner, and consistent with
`docs/foundation/V004-source-and-reuse-register.md`): bulk ingestion is limited
to sources whose licence actually permits reuse. In practice that is
data.gov.in, published under the Government Open Data License – India. Portals
that are merely publicly *visible* — LGD, UDISE+, the PMGSY and HMIS dashboards
— stay reference-only, exactly as V004 already records them, and this pipeline
builds a clearly-labelled derived proxy instead of scraping them.
"""

from __future__ import annotations

from dataclasses import dataclass

GODL = "Government Open Data License - India (GODL-India) — reuse permitted with attribution"


@dataclass(frozen=True)
class ApiResource:
    """One data.gov.in resource this pipeline reads in full."""

    key: str
    resource_id: str
    dataset_name: str
    publisher: str
    geographic_level: str
    time_period: str
    sector: str | None = None
    state_hint: str | None = None
    notes: str = ""

    @property
    def url(self) -> str:
        return f"https://api.data.gov.in/resource/{self.resource_id}"


# ── Demographics: the real national backbone ───────────────────────────────

#: Census 2011 Primary Census Abstract, published per state/UT. Each resource
#: carries DISTRICT-level rows with official `state_code` and `district_code`,
#: which is what makes a real national district master possible at all — the
#: Local Government Directory, the usual answer for codes, is captcha-gated
#: with no downloadable extract (see UNAVAILABLE).
#:
#: Discovered at run time rather than hard-coded, because the catalogue is the
#: authority on which resources exist; `PCA_DISCOVERY_QUERY` is the search that
#: finds them and `PCA_EXCLUDE_TITLES` drops the aggregates and duplicates.
PCA_DISCOVERY_QUERY = "Primary Census Abstract 2011"
PCA_TITLE_PREFIX = "primary census abstract 2011"

#: The India-level resource holds only India and STATE rows, so it contributes
#: no districts. "Orissa" duplicates "Odisha" under the pre-2011 spelling.
PCA_EXCLUDE_TITLES = {
    "primary census abstract 2011 - india",
    "primary census abstract 2011 - orissa",
}

#: Himachal Pradesh does not surface under the same query; searched separately.
PCA_EXTRA_QUERIES = ("Primary Census Abstract 2011 Himachal",)

PCA_PUBLISHER = "Office of the Registrar General & Census Commissioner, India (via data.gov.in)"


# ── Sector indicators: real, but fragmentary ───────────────────────────────

#: Verified district-level sector resources. Every one is a single state, from
#: a parliamentary answer or a state return, with its own schema and year.
#: There is no national district-level table for any of the four sectors on
#: data.gov.in; these are stitched in as genuine anchors and everything else is
#: a labelled proxy. This is stated plainly in `limitations.md` rather than
#: papered over.
SECTOR_RESOURCES: tuple[ApiResource, ...] = (
    ApiResource(
        key="water_mp_tap_connections",
        resource_id="a59eaa2e-98fa-467d-a133-6b72af0ffb17",
        dataset_name="District-wise provision of potable water / tap connections, Madhya Pradesh",
        publisher="Ministry of Jal Shakti (via data.gov.in)",
        geographic_level="district",
        time_period="2022",
        sector="water",
        state_hint="Madhya Pradesh",
        notes="53 rows. Households and tap-water connections as on 29-07-2022.",
    ),
    ApiResource(
        key="water_tn_jjm",
        resource_id="a9ff333b-cbf6-4765-9ce2-3237d6351650",
        dataset_name="District-wise Rural Households with Tap Water Connection (JJM), Tamil Nadu",
        publisher="Ministry of Jal Shakti / Jal Jeevan Mission (via data.gov.in)",
        geographic_level="district",
        time_period="2019-2021",
        sector="water",
        state_hint="Tamil Nadu",
        notes="37 rows. Household counts are in LAKHS, not units — rescaled on import.",
    ),
    ApiResource(
        key="water_hr_tap",
        resource_id="444cc4d1-4853-44c1-9ae2-ddcaaa3738bd",
        dataset_name="District-wise Rural Households with Tap Water Connection, Haryana",
        publisher="Ministry of Jal Shakti (via data.gov.in)",
        geographic_level="district",
        time_period="2021",
        sector="water",
        state_hint="Haryana",
        notes="23 rows. Household counts are in LAKHS — rescaled on import.",
    ),
    ApiResource(
        key="roads_od_completed",
        resource_id="b3320522-5dde-4803-b126-eafda8a98d17",
        dataset_name="District-wise Road Length Completed, Odisha",
        publisher="Government of Odisha (via data.gov.in)",
        geographic_level="district",
        time_period="2019-20 to 2022-23",
        sector="roads",
        state_hint="Odisha",
        notes="31 rows, four annual columns.",
    ),
    ApiResource(
        key="roads_ka_constructed",
        resource_id="251e53ad-d056-48d7-b5ff-39954532749a",
        dataset_name="District-wise Road Length Constructed, Karnataka",
        publisher="Ministry of Rural Development (via data.gov.in)",
        geographic_level="district",
        time_period="2018-19 to 2022-23",
        sector="roads",
        state_hint="Karnataka",
        notes="31 rows, single cumulative length column.",
    ),
    ApiResource(
        key="education_hp_schools",
        resource_id="6e9fff80-5242-4672-94ee-b488bda00eb8",
        dataset_name="District-wise Number of Schools and Colleges, Himachal Pradesh",
        publisher="Government of Himachal Pradesh (via data.gov.in)",
        geographic_level="district",
        time_period="2020-21",
        sector="education",
        state_hint="Himachal Pradesh",
        notes="13 rows. Carries an explicit state column.",
    ),
    ApiResource(
        key="health_dlhs3_facilities",
        resource_id="5d5a8c17-6527-491a-b19d-e7031ea66a76",
        dataset_name="Facility Indicators, DLHS-III",
        publisher="Ministry of Health and Family Welfare (via data.gov.in)",
        geographic_level="district",
        time_period="2007-08",
        sector="health",
        notes="12 rows. Indicators are percentages, not facility counts, and are dated.",
    ),
    ApiResource(
        key="health_hwc_aspirational",
        resource_id="288508e5-9597-4668-b4d4-ba420ceeef6d",
        dataset_name="District-wise Ayushman Bharat Health and Wellness Centres (aspirational districts)",
        publisher="Ministry of Health and Family Welfare (via data.gov.in)",
        geographic_level="district",
        time_period="2022",
        sector="health",
        notes="11 rows, aspirational districts only. Operational SHC/PHC/UPHC counts.",
    ),
)


# ── Investigated and not usable ────────────────────────────────────────────

#: Recorded so the next person does not spend the afternoon rediscovering it.
UNAVAILABLE: tuple[dict[str, str], ...] = (
    {
        "dataset_name": "Local Government Directory (LGD)",
        "url": "https://lgdirectory.gov.in/",
        "reason": (
            "Site responds, but the directory download is captcha- and login-gated and "
            "exposes no CSV/XLS/ZIP link and no open REST endpoint. V004 already records "
            "it as reference-only: public visibility is not permission for bulk reuse."
        ),
        "substitute": "Official district codes taken from Census 2011 PCA resources instead.",
    },
    {
        "dataset_name": "UDISE+ (school education statistics)",
        "url": "https://udiseplus.gov.in/",
        "reason": "Host did not respond within timeout; bulk access requires registration.",
        "substitute": "Education indicators derived from census literacy and child population.",
    },
    {
        "dataset_name": "PMGSY / OMMS (rural roads)",
        "url": "https://omms.nic.in/",
        "reason": "Host did not respond within timeout; no open bulk endpoint identified.",
        "substitute": "Road indicators derived, anchored on the two real state road tables.",
    },
    {
        "dataset_name": "NITI Aayog SDG India Index / MPI",
        "url": "https://sdgindiaindex.niti.gov.in/",
        "reason": (
            "Single-page app with no open data endpoint; the data.gov.in SDG and MPI "
            "resources are state-level only, so neither supports district analysis."
        ),
        "substitute": "Not used.",
    },
    {
        "dataset_name": "HMIS (health management information system)",
        "url": "https://hmis.mohfw.gov.in/",
        "reason": "Report-builder portal; no open bulk district extract identified.",
        "substitute": "Health indicators derived, anchored on DLHS-III where it overlaps.",
    },
)
