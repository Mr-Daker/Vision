"""The freeze: a record of exactly which rules produced a hidden-set result.

A held-out evaluation only means anything if the rules were fixed before the
hidden labels were read. That is a claim about history, and history is not
checkable by looking at the current files — a threshold nudged after the fact
leaves no trace.

So the freeze records a SHA-256 of every analysis SQL file at the moment the
rules were fixed. `verify()` recomputes them, and any later edit makes the
mismatch visible. The evaluation report prints the verdict, so a reader can
tell whether the numbers they are looking at came from the frozen rules or from
something edited afterwards.

This mirrors `tools/check-holdout-seal.mjs`, which does the same job for the
V011 evaluation corpus: the repository already takes the position that an
evaluation boundary should be mechanically checkable rather than promised.

A legitimate re-freeze is fine — rules improve. What must not happen is a
re-freeze that goes unrecorded, so `freeze()` refuses to overwrite silently
and the manifest carries the reason for each version.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from .analytics import ANALYSIS_FILES
from .local import SQL_DIR

MANIFEST = Path(__file__).resolve().parent / "frozen_rules.json"


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def current_digests() -> dict[str, str]:
    return {name: _digest(SQL_DIR / name) for name in ANALYSIS_FILES}


def freeze(reason: str, *, force: bool = False) -> dict:
    if MANIFEST.exists() and not force:
        raise RuntimeError(
            f"{MANIFEST.name} already exists. A re-freeze invalidates every evaluation "
            "reported against the previous rules, so it must be deliberate: pass force=True "
            "and give a reason that will be recorded."
        )
    history = []
    if MANIFEST.exists():
        history = json.loads(MANIFEST.read_text(encoding="utf-8")).get("history", [])

    record = {
        "frozen_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "reason": reason,
        "digests": current_digests(),
    }
    history.append(record)
    MANIFEST.write_text(
        json.dumps({"current": record, "history": history}, indent=2) + "\n",
        encoding="utf-8",
    )
    return record


def verify() -> tuple[bool, list[str]]:
    """Returns (rules_unchanged, list of files that differ from the freeze)."""
    if not MANIFEST.exists():
        return False, ["no freeze manifest exists; rules were never frozen"]
    frozen = json.loads(MANIFEST.read_text(encoding="utf-8"))["current"]["digests"]
    current = current_digests()
    changed = [
        name
        for name in sorted(set(frozen) | set(current))
        if frozen.get(name) != current.get(name)
    ]
    return not changed, changed


def statement() -> str:
    unchanged, changed = verify()
    if unchanged:
        frozen = json.loads(MANIFEST.read_text(encoding="utf-8"))["current"]
        return (
            f"Rules frozen {frozen['frozen_at']} and unchanged since "
            f"({len(frozen['digests'])} SQL files verified by SHA-256)."
        )
    return (
        "WARNING: the analysis SQL differs from the frozen manifest for "
        f"{', '.join(changed)}. Hidden-set figures below were NOT produced by the frozen "
        "rules and must not be reported as a held-out result."
    )
