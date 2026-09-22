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
    sub.add_parser("report", help="write the evaluation report to deliverables/")

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

    elif args.command in ("evaluate", "report"):
        from . import analytics as an
        from .report import write_report

        print("analytics:evaluate (local DuckDB over pipeline Parquet)")
        run = an.run_local()
        classifications, rankings = an.evaluate(run)
        an.report(classifications, rankings)
        print(f"\n  {an.leakage_statement()}")
        if args.command == "report":
            path = write_report(run, classifications, rankings)
            print(f"\n  report written to {path}")

    print(f"\ndone in {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
