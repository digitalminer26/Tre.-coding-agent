"""Regression tests for the mutation matrix's selftest coverage check.

These pin the audit findings on reason_coverage_errors(): a blank or
non-string reason must FAIL the battery (never a no-op reason check), a
missing or stale REASONS key must fail, and the check must never raise —
whatever the reason values are.

Run:  python3 -B -m unittest p9m3.test_mutation_matrix
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from p9m3 import mutation_matrix as mm  # noqa: E402


class ReasonCoverageTests(unittest.TestCase):
    NAMES = ["a", "b"]

    def test_complete_table_is_clean(self):
        self.assertEqual(
            mm.reason_coverage_errors(self.NAMES, {"a": "x", "b": "y"}), [])

    def test_missing_reason_key_fails(self):
        errs = mm.reason_coverage_errors(self.NAMES, {"a": "x"})
        self.assertTrue(any("selftest b:" in e and "no REASONS entry" in e
                            for e in errs), errs)

    def test_stale_reason_key_fails(self):
        errs = mm.reason_coverage_errors(
            self.NAMES, {"a": "x", "b": "y", "ghost": "z"})
        self.assertTrue(any("matches no case" in e for e in errs), errs)

    def test_empty_reason_fails(self):
        errs = mm.reason_coverage_errors(self.NAMES, {"a": "", "b": "y"})
        self.assertTrue(any("selftest a:" in e and "empty" in e
                            for e in errs), errs)

    def test_whitespace_only_reason_fails(self):
        errs = mm.reason_coverage_errors(self.NAMES,
                                         {"a": "  \t ", "b": "y"})
        self.assertTrue(any("selftest a:" in e for e in errs), errs)

    def test_non_string_reasons_fail_and_never_raise(self):
        for bad in (None, 0, 1.5, ["x"], b"x"):
            with self.subTest(reason=repr(bad)):
                errs = mm.reason_coverage_errors(self.NAMES,
                                                 {"a": bad, "b": "y"})
                self.assertTrue(any("selftest a:" in e for e in errs), errs)

    def test_duplicate_names_fail(self):
        errs = mm.reason_coverage_errors(["a", "a"], {"a": "x"})
        self.assertTrue(any("duplicate" in e for e in errs), errs)


class BatteryGateTests(unittest.TestCase):
    """The shipped battery itself must have full coverage."""

    def test_shipped_battery_has_no_coverage_errors(self):
        import io
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()):
            bad = mm.selftest_classifier()
        coverage = [b for b in bad if "REASON" in b or "REASONS" in b
                    or "duplicate" in b]
        self.assertEqual(coverage, [], coverage)


if __name__ == "__main__":
    unittest.main()
