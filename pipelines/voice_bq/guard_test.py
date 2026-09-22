"""Proves the leakage guard actually refuses, rather than merely claiming to.

A control nobody has watched fail is a control nobody knows works. These tests
deliberately construct the mistake — an analysis query that reaches for a label
table — and assert that it is refused, so the claim in the evaluation report
is backed by something executable.

Run with:  npm run bigquery:test
"""

from __future__ import annotations

import unittest

from . import analytics, local, schema


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


if __name__ == "__main__":
    unittest.main()
