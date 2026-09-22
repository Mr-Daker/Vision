"""Command-line entry point for the VOICE data pipeline.

    python -m voice_data download          # fetch real sources into data/raw
    python -m voice_data prepare           # clean into data/processed + master
    python -m voice_data generate --reports 500000 --seed 42
    python -m voice_data validate
    python -m voice_data summary
    python -m voice_data all --reports 100000

Normally invoked through the `npm run data:*` scripts, which point at the
project virtualenv so the commands are the same for everyone.
"""

from __future__ import annotations

import argparse
import sys
import time

from . import config


def _generation_settings(args) -> "config.GenerationSettings":
    return config.GenerationSettings(
        reports=args.reports,
        seed=args.seed,
        chunk_rows=args.chunk_rows,
        write_csv=not args.no_csv,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="voice_data", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def add_generation_args(p):
        p.add_argument("--reports", type=int, default=config.DEFAULT_REPORTS,
                       help="number of citizen reports to generate")
        p.add_argument("--seed", type=int, default=config.DEFAULT_SEED,
                       help="deterministic seed; the same seed reproduces the dataset")
        p.add_argument("--chunk-rows", type=int, default=200_000,
                       help="rows per Parquet write")
        p.add_argument("--no-csv", action="store_true",
                       help="skip the capped CSV mirror of the report table")

    download = sub.add_parser("download", help="fetch real public sources")
    download.add_argument("--refresh", action="store_true", help="ignore the cache and refetch")

    sub.add_parser("prepare", help="clean sources into analytical tables").add_argument(
        "--seed", type=int, default=config.DEFAULT_SEED
    )

    add_generation_args(sub.add_parser("generate", help="generate issues and citizen reports"))
    sub.add_parser("validate", help="run dataset validation checks")
    sub.add_parser("summary", help="write and print summary statistics")
    add_generation_args(sub.add_parser("all", help="prepare, generate, validate and summarise"))

    args = parser.parse_args(argv)
    started = time.time()

    if args.command == "download":
        from . import download as step

        print("data:download")
        step.run(refresh=args.refresh)

    elif args.command == "prepare":
        from . import prepare as step

        print("data:prepare")
        step.run(seed=args.seed)

    elif args.command == "generate":
        from . import generate as gen, master as master_step, prepare as prep

        print("data:generate")
        processed = prep.run(seed=args.seed)
        generated = gen.run(processed, _generation_settings(args))
        master_step.run(processed, generated)

    elif args.command == "validate":
        from . import validate as step

        print("data:validate")
        ok = step.report(step.run())
        if not ok:
            return 1

    elif args.command == "summary":
        from . import summary as step

        print(step.run())

    elif args.command == "all":
        from . import generate as gen, master as master_step, prepare as prep
        from . import summary as summary_step, validate as validate_step

        print("data:prepare")
        processed = prep.run(seed=args.seed)
        print("data:generate")
        generated = gen.run(processed, _generation_settings(args))
        master_step.run(processed, generated)
        print("data:validate")
        ok = validate_step.report(validate_step.run())
        summary_step.run()
        print("\n  summary written to data/metadata/summary.md")
        if not ok:
            return 1

    print(f"\ndone in {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
