"""Did the analytics rediscover the planted scenarios it was never shown?

This is the claim the whole data foundation exists to support, so the harness
has to be honest about two things at once.

**The analytics never sees the labels.** The five analysis files are executed
through `local.run_file`, which refuses any query that names an evaluation
table. Labels are joined here, afterwards, on `(district_key, sector)` — and
the join happens in Python, against results the SQL had already produced.

**A figure is reported with its uncertainty.** `precision = 0.82` from 11
examples is not the same claim as `precision = 0.82` from 900, and printing
both as "0.82" invites a reader to believe the first. Every proportion below
carries a 95% Wilson interval and is marked unreportable when that interval is
wider than 20 points — mirroring `wilsonInterval` and
`MAX_INTERVAL_WIDTH_FOR_A_RATE` in `packages/domain/src/evaluation.ts`, so the
warehouse and the application judge a rate the same way.

Ranking metrics use the same discipline: Recall@K is a proportion and gets an
interval; NDCG@K is not a proportion and is reported as a bare number with its
K stated.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import pandas as pd

#: Two-sided 95%. Same constant as evaluation.ts:155.
Z = 1.959963984540054

#: Same threshold and the same reasoning as evaluation.ts:177.
MAX_INTERVAL_WIDTH_FOR_A_RATE = 0.2


@dataclass(frozen=True)
class Figure:
    """A proportion, its interval, and whether it may be quoted as a rate."""

    numerator: int
    denominator: int
    low: float
    high: float
    rate_reportable: bool

    @property
    def value(self) -> float | None:
        return self.numerator / self.denominator if self.denominator else None

    def render(self) -> str:
        if self.denominator == 0:
            return "no observations"
        counts = f"{self.numerator} of {self.denominator}"
        band = f"95% CI {self.low:.0%}–{self.high:.0%}"
        if not self.rate_reportable:
            return f"{counts} ({band}: interval too wide to quote as a rate)"
        return f"{counts} = {self.value:.1%} ({band})"


def wilson(successes: int, trials: int) -> Figure:
    if trials <= 0 or successes < 0 or successes > trials:
        return Figure(max(successes, 0), max(trials, 0), 0.0, 1.0, False)
    p = successes / trials
    z2 = Z * Z
    denominator = 1 + z2 / trials
    centre = p + z2 / (2 * trials)
    spread = Z * math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))
    low = max(0.0, (centre - spread) / denominator)
    high = min(1.0, (centre + spread) / denominator)
    return Figure(successes, trials, low, high, (high - low) <= MAX_INTERVAL_WIDTH_FOR_A_RATE)


@dataclass
class ClassificationResult:
    signal: str
    expected_label: str
    true_positives: int
    false_positives: int
    false_negatives: int
    true_negatives: int
    precision: Figure
    recall: Figure
    f1: float | None
    notes: list[str] = field(default_factory=list)

    @property
    def predicted_positives(self) -> int:
        return self.true_positives + self.false_positives

    @property
    def actual_positives(self) -> int:
        return self.true_positives + self.false_negatives


def score_classification(
    predictions: pd.DataFrame,
    labels: pd.DataFrame,
    *,
    signal: str,
    prediction_column: str,
    label_column: str,
    keys: tuple[str, ...] = ("district_key", "sector"),
) -> ClassificationResult:
    """Joins a signal to its label and counts the four cells of the matrix.

    The join is a left join from the full prediction grid, so a planted cell the
    analytics never scored counts as a false negative rather than vanishing —
    silently dropping the rows a method missed is the most flattering possible
    bug.
    """
    merged = predictions[list(keys) + [prediction_column]].merge(
        labels[list(keys) + [label_column]].drop_duplicates(subset=list(keys)),
        on=list(keys),
        how="left",
    )
    predicted = merged[prediction_column].fillna(False).astype(bool)
    actual = merged[label_column].fillna(False).astype(bool)

    tp = int((predicted & actual).sum())
    fp = int((predicted & ~actual).sum())
    fn = int((~predicted & actual).sum())
    tn = int((~predicted & ~actual).sum())

    precision = wilson(tp, tp + fp)
    recall = wilson(tp, tp + fn)

    f1: float | None = None
    if precision.value is not None and recall.value is not None:
        total = precision.value + recall.value
        f1 = (2 * precision.value * recall.value / total) if total > 0 else 0.0

    notes: list[str] = []
    if not precision.rate_reportable:
        notes.append("precision interval too wide to quote as a rate")
    if not recall.rate_reportable:
        notes.append("recall interval too wide to quote as a rate")
    if f1 is not None and (not precision.rate_reportable or not recall.rate_reportable):
        notes.append("F1 combines two figures and inherits the wider one's uncertainty")

    return ClassificationResult(
        signal=signal,
        expected_label=label_column,
        true_positives=tp,
        false_positives=fp,
        false_negatives=fn,
        true_negatives=tn,
        precision=precision,
        recall=recall,
        f1=f1,
        notes=notes,
    )


@dataclass
class RankingResult:
    signal: str
    k: int
    relevant_total: int
    hits_at_k: int
    recall_at_k: Figure
    precision_at_k: Figure
    ndcg_at_k: float

    @property
    def max_possible_recall(self) -> float:
        """The ceiling Recall@K can reach, which is often the whole story.

        With 108 relevant cells, Recall@10 cannot exceed 10/108 = 9.3% no
        matter how perfect the ranking. Printing 3.9% beside a 51% precision
        invites the reader to conclude the ranking is broken when it is the
        metric that is mis-specified for this K. The ceiling is reported so
        the number can be read against what it could possibly have been.
        """
        return min(self.k, self.relevant_total) / self.relevant_total if self.relevant_total else 0.0


def score_ranking(
    ranked: pd.DataFrame,
    labels: pd.DataFrame,
    *,
    signal: str,
    score_column: str,
    label_column: str,
    k: int,
    keys: tuple[str, ...] = ("district_key", "sector"),
) -> RankingResult:
    """Precision@K, Recall@K and NDCG@K for a ranked shortlist.

    NDCG uses binary relevance and the standard log2 discount. Reported as a
    bare number, not a proportion: it is a normalised gain, and dressing it in a
    confidence interval would imply a sampling model it does not have.
    """
    merged = ranked[list(keys) + [score_column]].merge(
        labels[list(keys) + [label_column]].drop_duplicates(subset=list(keys)),
        on=list(keys),
        how="left",
    )
    merged[label_column] = merged[label_column].fillna(False).astype(bool)
    merged = merged.sort_values(score_column, ascending=False).reset_index(drop=True)

    relevant_total = int(merged[label_column].sum())
    top = merged.head(k)
    hits = int(top[label_column].sum())

    gains = top[label_column].astype(float).to_numpy()
    discounts = 1.0 / __import__("numpy").log2(__import__("numpy").arange(2, len(gains) + 2))
    dcg = float((gains * discounts).sum())
    ideal_hits = min(relevant_total, k)
    ideal_gains = [1.0] * ideal_hits + [0.0] * (len(gains) - ideal_hits)
    idcg = float(
        sum(g * d for g, d in zip(ideal_gains, discounts))
    )
    ndcg = dcg / idcg if idcg > 0 else 0.0

    return RankingResult(
        signal=signal,
        k=k,
        relevant_total=relevant_total,
        hits_at_k=hits,
        recall_at_k=wilson(hits, relevant_total),
        precision_at_k=wilson(hits, min(k, len(merged))),
        ndcg_at_k=ndcg,
    )
