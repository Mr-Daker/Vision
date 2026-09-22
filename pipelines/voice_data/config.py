"""Paths, constants and scope for the VOICE data foundation.

Everything configurable about the dataset lives here rather than being spread
through the pipeline, so a reader can see the whole shape of what is generated
in one file: which sectors exist, which languages are plausible where, how long
the time window is, and where each artefact is written.

Scope note: this pipeline is deliberately separate from `packages/` and
`apps/`. It writes files under `data/` and imports nothing from the
application. `check:scope` and `check:browser-safe` only scan production source
roots, and this is not one.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DATA = REPO_ROOT / "data"

RAW = DATA / "raw"
RAW_CENSUS = RAW / "census"
RAW_OTHER = RAW / "other"
PROCESSED = DATA / "processed"
SYNTHETIC = DATA / "synthetic"
MASTER = DATA / "master"
METADATA = DATA / "metadata"

ALL_DIRS = [
    RAW,
    RAW_CENSUS,
    RAW / "udise",
    RAW / "hmis",
    RAW / "jjm",
    RAW / "pmgsy",
    RAW_OTHER,
    PROCESSED,
    SYNTHETIC,
    MASTER,
    METADATA,
]


def ensure_dirs() -> None:
    for directory in ALL_DIRS:
        directory.mkdir(parents=True, exist_ok=True)


# ── Scope ──────────────────────────────────────────────────────────────────

COUNTRY_CODE = "IN"

#: The four sectors this prototype supports. Adding a fifth means adding it
#: here plus an entry in SECTOR_SEASONALITY and the issue-template catalogue;
#: nothing else in the pipeline hard-codes the list.
SECTORS = ("water", "roads", "education", "health")

#: Months of history generated. The task asks for at least 24.
MONTHS = 24

#: The window ends at the end of this month and runs back MONTHS from there.
#: Fixed rather than "today" so a regeneration a week later is byte-identical.
WINDOW_END_YEAR = 2026
WINDOW_END_MONTH = 6

DEFAULT_SEED = 42
DEFAULT_REPORTS = 100_000

# ── Report attributes ──────────────────────────────────────────────────────

INPUT_CHANNELS = ("mobile_app", "web", "whatsapp", "sms", "existing_portal")
INPUT_MODES = ("text", "voice", "image_text", "voice_image")

STATUSES = ("open", "acknowledged", "in_progress", "resolved", "closed_unresolved")

PROJECT_STATUSES = (
    "planned",
    "sanctioned",
    "in_progress",
    "completed",
    "delayed",
    "unknown",
)

#: Languages the platform accepts. The mix per state is set below; this is the
#: full vocabulary.
LANGUAGES = (
    "English",
    "Hindi",
    "Tamil",
    "Telugu",
    "Bengali",
    "Marathi",
    "Odia",
    "Kannada",
    "Malayalam",
    "Gujarati",
    "Punjabi",
    "Assamese",
)

#: Dominant regional language by 2011 census state code. Reports in a state
#: draw mostly from its regional language, then Hindi/English — so the language
#: distribution is geographically plausible rather than uniform. States absent
#: from this map fall back to REGIONAL_FALLBACK.
#:
#: This is a *linguistic-plausibility* device for synthetic text only. It is not
#: a claim about the true language composition of any state, which is far more
#: mixed than one label can express.
STATE_LANGUAGE = {
    "01": "Hindi",  # Jammu & Kashmir (Urdu/Kashmiri unsupported; see limitations)
    "02": "Hindi",  # Himachal Pradesh
    "03": "Punjabi",  # Punjab
    "04": "Hindi",  # Chandigarh
    "05": "Hindi",  # Uttarakhand
    "06": "Hindi",  # Haryana
    "07": "Hindi",  # NCT of Delhi
    "08": "Hindi",  # Rajasthan
    "09": "Hindi",  # Uttar Pradesh
    "10": "Hindi",  # Bihar
    "11": "Hindi",  # Sikkim (Nepali unsupported)
    "12": "Assamese",  # Arunachal Pradesh
    "13": "English",  # Nagaland
    "14": "English",  # Manipur
    "15": "English",  # Mizoram
    "16": "Bengali",  # Tripura
    "17": "English",  # Meghalaya
    "18": "Assamese",  # Assam
    "19": "Bengali",  # West Bengal
    "20": "Hindi",  # Jharkhand
    "21": "Odia",  # Odisha
    "22": "Hindi",  # Chhattisgarh
    "23": "Hindi",  # Madhya Pradesh
    "24": "Gujarati",  # Gujarat
    "25": "Gujarati",  # Daman & Diu
    "26": "Gujarati",  # Dadra & Nagar Haveli
    "27": "Marathi",  # Maharashtra
    "28": "Telugu",  # Andhra Pradesh (2011 boundaries, pre-bifurcation)
    "29": "Kannada",  # Karnataka
    "30": "Marathi",  # Goa (Konkani unsupported)
    "31": "Malayalam",  # Lakshadweep
    "32": "Malayalam",  # Kerala
    "33": "Tamil",  # Tamil Nadu
    "34": "Tamil",  # Puducherry
    "35": "Bengali",  # Andaman & Nicobar Islands
}
REGIONAL_FALLBACK = "Hindi"

#: Share of reports in the state's regional language, then Hindi, then English.
#: The remainder spreads thinly over other languages, which is what a real
#: multilingual platform sees from migrant and border populations.
LANGUAGE_MIX = {"regional": 0.62, "hindi": 0.18, "english": 0.16, "other": 0.04}

# ── Seasonality ────────────────────────────────────────────────────────────

#: Multiplier by calendar month (1-12) applied to a sector's report rate.
#:
#: Justification, kept deliberately mild: water stress peaks in the hot months
#: before the monsoon, road and drainage complaints peak during and just after
#: the monsoon, health has a mild monsoon-season rise, and education tracks the
#: academic year rather than the weather. These are directional shapes, not
#: fitted curves — §15 of the brief warns against overfitting every report to
#: seasonality, and `NOISE_SD` below keeps the signal from being clean.
SECTOR_SEASONALITY = {
    "water": [0.85, 0.9, 1.15, 1.45, 1.6, 1.35, 0.95, 0.8, 0.8, 0.85, 0.85, 0.85],
    "roads": [0.8, 0.8, 0.85, 0.9, 1.0, 1.35, 1.6, 1.55, 1.3, 1.0, 0.85, 0.8],
    "health": [1.0, 0.95, 0.95, 1.0, 1.05, 1.15, 1.25, 1.2, 1.1, 1.0, 1.0, 1.05],
    "education": [0.9, 0.85, 0.8, 0.85, 0.75, 1.3, 1.35, 1.15, 1.05, 0.95, 1.0, 0.95],
}

#: Lognormal noise applied on top of every district-sector-month rate, so no
#: cell is a clean function of its indicators.
NOISE_SD = 0.35


# ── Geography reference ────────────────────────────────────────────────────

#: Approximate bounding box (lat_min, lat_max, lon_min, lon_max) and land area
#: in km² per 2011 census state code.
#:
#: These are authored reference values, not an ingested dataset. They exist for
#: two derived purposes only: placing a district at a *plausible* coordinate
#: inside its own state, and estimating a density proxy. Neither output is an
#: official centroid or an official district area, and both are marked
#: `derived` wherever they appear. See `data/metadata/limitations.md`.
STATE_GEOGRAPHY = {
    "01": (32.3, 36.5, 74.0, 79.0, 222236),
    "02": (30.4, 33.2, 75.6, 79.0, 55673),
    "03": (29.5, 32.5, 73.9, 76.9, 50362),
    "04": (30.6, 30.8, 76.7, 76.9, 114),
    "05": (28.7, 31.5, 77.6, 81.0, 53483),
    "06": (27.7, 30.9, 74.5, 77.6, 44212),
    "07": (28.4, 28.9, 76.8, 77.3, 1483),
    "08": (23.0, 30.2, 69.5, 78.3, 342239),
    "09": (23.9, 30.4, 77.1, 84.6, 240928),
    "10": (24.3, 27.5, 83.3, 88.3, 94163),
    "11": (27.0, 28.1, 88.0, 88.9, 7096),
    "12": (26.6, 29.4, 91.6, 97.4, 83743),
    "13": (25.2, 27.0, 93.3, 95.3, 16579),
    "14": (23.8, 25.7, 92.9, 94.8, 22327),
    "15": (21.9, 24.5, 92.2, 93.5, 21081),
    "16": (22.9, 24.6, 91.1, 92.4, 10486),
    "17": (25.0, 26.2, 89.8, 92.9, 22429),
    "18": (24.1, 28.0, 89.7, 96.0, 78438),
    "19": (21.5, 27.3, 85.8, 89.9, 88752),
    "20": (21.9, 25.4, 83.3, 87.9, 79716),
    "21": (17.8, 22.6, 81.3, 87.5, 155707),
    "22": (17.8, 24.1, 80.2, 84.4, 135192),
    "23": (21.1, 26.9, 74.0, 82.8, 308245),
    "24": (20.1, 24.7, 68.2, 74.5, 196244),
    "25": (20.4, 20.8, 70.8, 73.0, 112),
    "26": (20.0, 20.4, 72.8, 73.2, 491),
    "27": (15.6, 22.0, 72.6, 80.9, 307713),
    "28": (12.6, 19.9, 76.8, 84.8, 275045),
    "29": (11.6, 18.5, 74.0, 78.6, 191791),
    "30": (14.9, 15.8, 73.7, 74.3, 3702),
    "31": (8.2, 12.3, 71.7, 74.0, 32),
    "32": (8.2, 12.8, 74.8, 77.4, 38852),
    "33": (8.1, 13.6, 76.2, 80.3, 130060),
    "34": (9.9, 12.0, 74.8, 79.9, 479),
    "35": (6.7, 13.7, 92.2, 94.3, 8249),
}
DEFAULT_STATE_GEOGRAPHY = (8.0, 35.0, 68.0, 97.0, 100000)


@dataclass(frozen=True)
class GenerationSettings:
    """One run's knobs. Constructed by the CLI, threaded through generation."""

    reports: int = DEFAULT_REPORTS
    seed: int = DEFAULT_SEED
    chunk_rows: int = 200_000
    write_csv: bool = True
    csv_report_cap: int = 200_000
    """Reports beyond this many are Parquet-only: a 1M-row CSV helps nobody."""
