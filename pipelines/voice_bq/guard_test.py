"""Proves the leakage guard actually refuses, rather than merely claiming to.

A control nobody has watched fail is a control nobody knows works. These tests
deliberately construct the mistake — an analysis query that reaches for a label
table — and assert that it is refused, so the claim in the evaluation report
is backed by something executable.

Run with:  npm run bigquery:test
"""

from __future__ import annotations

import unittest
from unittest.mock import patch

from . import analytics, bq, load, local, schema


class LeakageGuard(unittest.TestCase):
    def test_refuses_a_query_naming_a_label_table(self) -> None:
        offending = "SELECT * FROM {district_sector_month_labels}"
        with self.assertRaises(PermissionError):
            local.assert_no_label_access(offending, "offending.sql")

    def test_refuses_the_planted_scenario_table(self) -> None:
        with self.assertRaises(PermissionError):
            local.assert_no_label_access("SELECT * FROM {planted_scenarios}", "offending.sql")

    def test_allows_an_ordinary_analysis_query(self) -> None:
        local.assert_no_label_access(
            "SELECT district_key FROM {district_sector_month}", "fine.sql"
        )

    def test_every_shipped_analysis_file_passes_the_guard(self) -> None:
        for filename in analytics.ANALYSIS_FILES:
            with self.subTest(filename=filename):
                local.assert_no_label_access(local.load_sql(filename), filename)

    def test_no_analysis_file_mentions_a_ground_truth_column(self) -> None:
        for filename in analytics.ANALYSIS_FILES:
            body = local.load_sql(filename).lower()
            for column in schema.MASTER_LABELS + schema.ISSUE_LABELS:
                with self.subTest(filename=filename, column=column):
                    self.assertNotIn(column.lower(), body)


class AnalyticsViewsExcludeLabels(unittest.TestCase):
    def test_local_views_drop_the_label_columns(self) -> None:
        connection = local.connect()
        columns = {
            row[0]
            for row in connection.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'district_sector_month'"
            ).fetchall()
        }
        for label in schema.MASTER_LABELS:
            self.assertNotIn(label, columns)

    def test_label_view_still_carries_them(self) -> None:
        # The other half of the guarantee: a control that worked by losing the
        # labels would pass the test above and make evaluation impossible.
        connection = local.connect()
        columns = {
            row[0]
            for row in connection.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'district_sector_month_labels'"
            ).fetchall()
        }
        for label in schema.MASTER_LABELS:
            self.assertIn(label, columns)


class DeploymentSafety(unittest.TestCase):
    def test_all_null_identifier_columns_keep_string_dtype(self) -> None:
        frame = load._frame_for("district_master")
        self.assertEqual(str(frame["block_code"].dtype), "string")
        self.assertEqual(str(frame["locality_code"].dtype), "string")
        self.assertTrue(frame["block_code"].isna().all())
        self.assertTrue(frame["locality_code"].isna().all())

    def test_bigquery_binding_keeps_generated_suffix_inside_backticks(self) -> None:
        config = load.cfg.BigQueryConfig(
            project="project",
            analytics_dataset="analytics",
            eval_dataset="eval",
            location="asia-south1",
            staging_bucket=None,
        )
        statement = (
            "CREATE VIEW {analytics_features}_unmet_need AS "
            "SELECT * FROM {analytics_features}"
        )
        self.assertEqual(
            local.bind(statement, bq.bindings(config)),
            "CREATE VIEW `project.analytics.analytics_features_unmet_need` AS "
            "SELECT * FROM `project.analytics.analytics_features`",
        )

    def test_public_projects_partitions_on_the_materialised_date_column(self) -> None:
        spec = next(table for table in schema.ANALYTICS_TABLES if table.name == "public_projects")
        statement = spec.create_sql("project.dataset")
        self.assertIn("PARTITION BY sanction_date", statement)
        self.assertNotIn("PARTITION BY DATE(sanction_date)", statement)

    def test_failed_load_removes_every_label_bearing_staging_table(self) -> None:
        class FakeClient:
            def __init__(self) -> None:
                self.deleted: list[str] = []

            def delete_table(self, table: str, *, not_found_ok: bool) -> None:
                self.deleted.append(table)

        client = FakeClient()
        config = load.cfg.BigQueryConfig(
            project="project",
            analytics_dataset="analytics",
            eval_dataset="eval",
            location="asia-south1",
            staging_bucket=None,
        )
        with (
            patch.object(load.cfg, "load", return_value=config),
            patch.object(load, "bigquery_client", return_value=client),
            patch.object(load, "ensure_datasets", return_value=[]),
            patch.object(load, "_frame_for", return_value=object()),
            patch.object(load, "_upload", return_value=1) as upload,
            patch.object(load, "run_query", side_effect=RuntimeError("build failed")) as query,
        ):
            with self.assertRaisesRegex(RuntimeError, "build failed"):
                load.run()

        self.assertEqual(
            set(client.deleted),
            {f"project.eval.{name}" for name in schema.staging_tables()},
        )
        self.assertEqual(
            {call.args[3] for call in upload.call_args_list},
            {f"project.eval.{name}" for name in load.STAGING_SOURCES},
        )
        self.assertIn("`project.eval._staging_citizen_reports`", query.call_args.args[1])

    def test_district_profile_rebuilds_geography_instead_of_grouping_on_it(self) -> None:
        from . import views

        spec = next(view for view in views.VIEWS if view.name == "analytics_safe_district_profile")
        statement = spec.create_sql("project.dataset")
        group_by = statement.rsplit("GROUP BY", 1)[1]
        self.assertIn("ST_GEOGPOINT(dm.longitude, dm.latitude) AS location", statement)
        self.assertNotIn("dm.location", group_by)


if __name__ == "__main__":
    unittest.main()
