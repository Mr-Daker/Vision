"""Command line for the VOICE BigQuery layer.

    python -m voice_bq setup        # create datasets
    python -m voice_bq load         # pipeline output -> BigQuery
    python -m voice_bq validate     # parity + leakage checks
    python -m voice_bq views        # build analytics_safe_* and analysis views
    python -m voice_bq analytics    # run the five analyses (BigQuery)
    python -m voice_bq evaluate     # run + score locally against planted scenarios

Normally invoked through the `npm run bigquery:*` and `analytics:*` scripts.
Every BigQuery command needs a project and Application Default Credentials;
`evaluate` needs neither and runs entirely on the local Parquet.
"""

from __future__ import annotations

import argparse
import sys
import time


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="voice_bq", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("setup", "create the analytics and evaluation datasets"),
        ("load", "load pipeline output into BigQuery"),
        ("validate", "check parity with local data and that no labels leaked"),
        ("views", "create the safe views and the five analysis views"),
        ("analytics", "run the five analyses in BigQuery"),
        ("evaluate", "run the analyses locally and score them against planted scenarios"),
    ):
        sub.add_parser(name, help=help_text)
    sub.add_parser("report", help="write the held-out evaluation report to deliverables/")
    sub.add_parser("split", help="show the development / hidden scenario split")
    frozen = sub.add_parser("freeze", help="record a SHA-256 freeze of the analysis SQL")
    frozen.add_argument("--reason", required=True, help="why the rules are being re-frozen")
    frozen.add_argument("--force", action="store_true", help="overwrite an existing freeze")

    args = parser.parse_args(argv)
    started = time.time()

    if args.command == "setup":
        from . import config as cfg
        from .client import bigquery_client
        from .load import ensure_datasets

        config = cfg.load()
        client = bigquery_client(config)
        created = ensure_datasets(client, config)
        print(f"  project  {config.project} ({config.location})")
        for dataset in created:
            print(f"  created  {dataset}")
        if not created:
            print("  both datasets already exist; nothing to do")

    elif args.command == "load":
        from .load import run

        print("bigquery:load")
        run()

    elif args.command == "validate":
        from .validate import report, run

        print("bigquery:validate")
        if not report(run()):
            return 1

    elif args.command == "views":
        from .bq import create_views

        print("bigquery:views")
        for name in create_views():
            print(f"  created  {name}")

    elif args.command == "analytics":
        from .bq import create_views

        print("analytics:run (BigQuery)")
        for name in create_views():
            print(f"  built    {name}")

    elif args.command == "split":
        from . import splits

        split = splits.build()
        print(splits.summarise(split).to_string())
        print(f"\n  written to {splits.SPLIT_PATH}")

    elif args.command == "freeze":
        from . import freeze as fz

        record = fz.freeze(args.reason, force=args.force)
        print(f"  frozen at {record['frozen_at']}")
        for name, digest in record["digests"].items():
            print(f"    {name:26s} {digest[:16]}...")

    elif args.command in ("evaluate", "report"):
        from . import analytics as an
        from . import freeze as fz
        from .report import write_report

        print("analytics:evaluate (local DuckDB over pipeline Parquet)")
        run = an.run_local()

        # Development first, so the generalisation gap is visible rather than
        # a hidden figure being read in isolation.
        print("\n  DEVELOPMENT split (thresholds were chosen on these cells)")
        dev_class, dev_rank = an.evaluate(run, "development")
        an.report(dev_class, dev_rank)

        print("\n  HIDDEN split (held out; scored once against frozen rules)")
        classifications, rankings = an.evaluate(run, "hidden")
        an.report(classifications, rankings)

        print(f"\n  {an.leakage_statement()}")
        print(f"  {fz.statement()}")
        if args.command == "report":
            path = write_report(run, classifications, rankings, split="hidden")
            print(f"\n  report written to {path}")

    print(f"\ndone in {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
