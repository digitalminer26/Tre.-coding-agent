#!/usr/bin/env python3
"""AUD54-c1 finding 2: the mutation kills claimed in test_ledger
docstrings (F100-F109) must be REPRODUCIBLE from a fresh checkout.

This script applies each documented mutant to p9m3/ledger.py in a
throwaway COPY of the package (the tree on disk is never touched),
runs the named pin test against the mutant, and asserts RED — then
runs the FULL suite against the pristine copy and asserts GREEN.
Every mutation anchor must occur EXACTLY ONCE in the pristine source
or the script fails: an anchor drifting from the source is itself a
finding (the docstring claim would no longer be reproducible).

Usage:  python3 p9m3/mutation_matrix.py
Exit:   0 all claims reproduced; 1 any divergence (per-row reasons).

Matrix (id: mutation -> pin test, from the AUD52-c2/AUD53 cycle):
  T1   settle() drops its leading resolve-before-act  -> F100
  R2   operator_resolve_reset ALSO clears the pending mark -> F101
  A10  authorize checks only `raw is None` (hash drop) -> F102
  T3   settle() drops the strip-empty fast-path       -> F103
  T4   settle reserve `size + 1 > LOG_CAP` -> `>=`    -> F104
  T4b  settle reserve gains +1 byte of slack          -> F104
  A2   _log_names matches any parsed line (schema drop) -> F105
  A6   mint loop bound range(64) -> range(1<<20)      -> F106
  A9   default authorize drops the state gate         -> F107
  A15  AUTH cap check `len(payload)+2 > CAPS` -> `>=` -> F108
  A16  AUTH checked-write `n <= 0` -> `n < 0`         -> F109
"""
import os
import json
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)          # the `reference/` dir (import root)

# AUD54-c1 finding 3: parsing the runner's TEXT output is forgeable —
# a test can print fake `FAIL:`/`FAILED (...)` lines and flip an
# ERROR into a claimed RED. So the worker below runs the target with
# a real TestResult and dumps a machine record to a temp file the
# test never sees as its own stdout. Classification uses ONLY that
# record (plus "driver produced nothing" / timeout signals).
# AUD54-c2 finding 2: traceback TEXT is still text — a setUp
# exception whose message contains "\nin test_X" fooled the regex
# frame check. The driver now records STRUCTURED frames (filename +
# function name from traceback.extract_tb), so nothing is matched
# against message text. (Threat model note: a test could read
# MUTMATRIX_RESULT from os.environ and forge the record itself; the
# matrix guards against accidents and drift, not an adversarial test
# suite — an adversarial suite could equally edit mutation_matrix.py,
# so that is out of scope.)
DRIVER = (
    "import json, os, sys, unittest, traceback\n"
    "class Rec(unittest.TestResult):\n"
    "    def __init__(self):\n"
    "        unittest.TestResult.__init__(self)\n"
    "        self.deaths = []\n"
    "    def _die(self, test, kind, err):\n"
    "        tb = err[2]\n"
    "        frames = [[fr.filename, fr.name] for fr in\n"
    "                  traceback.extract_tb(tb)]\n"
    "        tmod = sys.modules[type(test).__module__]\n"
    "        self.deaths.append([test.id(), kind, frames,\n"
    "                            getattr(tmod, '__file__', ''),\n"
    "                            [c.__name__ for c in\n"
    "                             type(err[1]).__mro__]])\n"
    "    def addError(self, test, err):\n"
    "        unittest.TestResult.addError(self, test, err)\n"
    "        self._die(test, 'error', err)\n"
    "    def addFailure(self, test, err):\n"
    "        unittest.TestResult.addFailure(self, test, err)\n"
    "        self._die(test, 'fail', err)\n"
    "    def addSubTest(self, test, subtest, err):\n"
    "        # c3-f1: the BASE addSubTest appends straight to\n"
    "        # failures/errors WITHOUT calling addFailure/addError, so\n"
    "        # a `with self.subTest(): self.fail(...)` would record\n"
    "        # zero deaths and be classified GREEN. Record it with the\n"
    "        # PARENT test's id and structured frames, in order.\n"
    "        unittest.TestResult.addSubTest(self, test, subtest, err)\n"
    "        if err is not None:\n"
    "            frames = [[fr.filename, fr.name] for fr in\n"
    "                      traceback.extract_tb(err[2])]\n"
    "            tmod = sys.modules[type(test).__module__]\n"
    "            kind = 'fail' if issubclass(\n"
    "                err[0], AssertionError) else 'error'\n"
    "            self.deaths.append([test.id(), kind, frames,\n"
    "                                getattr(tmod, '__file__', ''),\n"
    "                                [c.__name__ for c in\n"
    "                                 err[0].__mro__]])\n"
    "res = Rec()\n"
    "suite = unittest.TestLoader().loadTestsFromName(sys.argv[1])\n"
    "suite.run(res)\n"
    "rec = {'ran': res.testsRun,\n"
    "     'collected': suite.countTestCases(),\n"
    "     'deaths': sorted(res.deaths),\n"
    "     'skipped': len(res.skipped),\n"
    "     'expected_failures': len(getattr(res, 'expectedFailures', [])),\n"
    "     'unexpected_successes': len(getattr(res, 'unexpectedSuccesses', []))}\n"
    "with open(os.environ['MUTMATRIX_RESULT'], 'w') as f:\n"
    "    json.dump(rec, f)\n"
)

MUTANTS = [
    # (id, old, new, test_name)
    ("T1",
     "forget a pending window across entry points.\n"
     "            self._resolve_locked()\n",
     "forget a pending window across entry points.\n",
     "test_F100_settle_resolves_before_act_even_on_a_strippable_tail"),
    ("R2",
     "            self._write_counter(0, exhausted=False)\n"
     "\n"
     "    # ---------------- (c-O) forced repair",
     "            try:\n"
     "                os.unlink(self._pending_side)\n"
     "            except OSError:\n"
     "                pass\n"
     "            self._write_counter(0, exhausted=False)\n"
     "\n"
     "    # ---------------- (c-O) forced repair",
     "test_F101_operator_reset_never_clears_the_pending_mark"),
    ("A10",
     'if raw is None or self._sha(raw) != e["hash"]:',
     "if raw is None:",
     "test_F102_authorize_verifies_the_entry_hash_not_just_the_offset"),
    ('T3',
     'if data.endswith(b"\\n") or not data[data.rfind(b"\\n") + 1:]'
     '.strip(b" \\t\\r"):',
     'if data.endswith(b"\\n"):',
     "test_F103_whitespace_only_tail_is_stripped_not_settled"),
    ("T4",
     'if size + 1 > LOG_CAP:\n'
     '                raise LedgerError("log-cap-exceeded", size=size, '
     'framed=1)',
     'if size + 1 >= LOG_CAP:\n'
     '                raise LedgerError("log-cap-exceeded", size=size, '
     'framed=1)',
     "test_F104_settlement_reserve_bound_is_strictly_greater"),
    ("T4b",
     'if size + 1 > LOG_CAP:\n'
     '                raise LedgerError("log-cap-exceeded", size=size, '
     'framed=1)',
     'if size + 1 > LOG_CAP + 1:\n'
     '                raise LedgerError("log-cap-exceeded", size=size, '
     'framed=1)',
     "test_F104_settlement_reserve_bound_is_strictly_greater"),
    ("A2",
     "for raw in self._read_bytes().split(b\"\\n\"):\n"
     "                    if self._schema_kind(raw) is not None:",
     "for raw in self._read_bytes().split(b\"\\n\"):\n"
     "                    if True:",
     "test_F105_log_names_authids_only_through_schema_valid_records"),
    ("A6",
     "for _ in range(64):",
     "for _ in range(1 << 20):",
     "test_F106_mint_retry_is_bounded_at_its_64th_attempt"),
    ("A9",
     'if occurrences is None:\n'
     '                if cls["state"] != STATE_UNMASKED:',
     "if occurrences is None:\n"
     '                if False:',
     "test_F107_default_authorize_requires_the_unmasked_state"),
    ("A15",
     'if len(payload.encode()) + 2 > CAPS["AUTH"]:',
     'if len(payload.encode()) + 2 >= CAPS["AUTH"]:',
     "test_F108_auth_size_cap_boundary_is_strictly_greater"),
    ("A16",
     'if n <= 0:\n'
     '                        raise OSError(errno.EIO, "AUTH write made '
     'no progress")',
     'if n < 0:\n'
     '                        raise OSError(errno.EIO, "AUTH write made '
     'no progress")',
     "test_F109_auth_write_zero_progress_raises_eio"),
]

CLASS = "p9m3.test_ledger.TestV38Cycle11Audit"
SUITE = "p9m3.test_ledger"


def run_test(root, target, timeout, expect_ran=None):
    """Run one unittest target in `root` via the JSON driver.
    Return (verdict, detail) where verdict is one of:
      "GREEN"      - driver record: ran == expect_ran, zero deaths,
                     zero skips/xfail/xpass
      "RED"        - exactly ONE death, its test id == the target,
                     and its STRUCTURED frames include one whose
                     file is the test module and whose function is
                     the pin's own method (AUD54c2 findings 1-2:
                     assertion AND error deaths both need the frame;
                     setUp/tearDown/loader deaths are NOT kills and
                     message text can no longer fake the frame)
      "ERROR"      - nothing proven: no record, bad count, zero
                     declared count, death elsewhere, skips, or an
                     INFRASTRUCTURE error (SyntaxError/ImportError-
                     family/FileNotFoundError/PermissionError/
                     MemoryError) through the pin (post-audit: those
                     prove nothing about the pin's assertion)
      "TIMEOUT"    - the run outlived `timeout`
    AUD54c1 f1: nonzero rc is NOT a kill. c1 f3: runner text is NOT
    trusted (out-of-band JSON only). c1 f2: `Ran 0 tests ... OK` is
    NOT green (expect_ran pins the count)."""
    if expect_ran is not None and expect_ran < 1:
        return "ERROR", "expect_ran must be >= 1, got %r" % (expect_ran,)
    fd, rec_path = tempfile.mkstemp(prefix="mutmatrix-rec-", suffix=".json")
    os.close(fd)
    env = dict(os.environ, MUTMATRIX_RESULT=rec_path)
    try:
        try:
            p = subprocess.run([sys.executable, "-B", "-c", DRIVER, target],
                               cwd=root, capture_output=True, text=True,
                               timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            return "TIMEOUT", "no output (timeout %ds)" % timeout
        try:
            with open(rec_path) as f:
                rec = json.load(f)
        except (OSError, ValueError):
            tail = (p.stdout + p.stderr).strip().splitlines()[-1:] or [""]
            return "ERROR", ("driver wrote no record (rc=%d); tail: %s"
                             % (p.returncode, tail[0][:80]))
        if p.returncode != 0:
            return "ERROR", "runner exited rc=%d after writing a record" \
                % p.returncode
    finally:
        try:
            os.unlink(rec_path)
        except OSError:
            pass
    ran = rec["ran"]
    if rec.get("collected", ran) != ran:
        return "ERROR", "collected %s but ran %d (tests dropped mid-run)" \
            % (rec["collected"], ran)
    if expect_ran is not None and ran != expect_ran:
        return "ERROR", "ran %d test(s), expected exactly %d" \
            % (ran, expect_ran)
    if ran < 1:
        return "ERROR", "ran %d test(s): empty suite is not evidence" % ran
    if rec["skipped"] or rec["expected_failures"] \
            or rec["unexpected_successes"]:
        return "ERROR", "skips/expected-results present: ran=%d " \
            "skipped=%d xfail=%d xpass=%d" % (
                ran, rec["skipped"], rec["expected_failures"],
                rec["unexpected_successes"])
    deaths = rec["deaths"]
    if not deaths:
        return "GREEN", "ran %d, all passed" % ran
    if len(deaths) != 1:
        return "ERROR", "not exactly one clean death: %d deaths (ran %d)" \
            % (len(deaths), ran)
    tid, kind, frames, modfile = deaths[0][:4]
    mro = deaths[0][4] if len(deaths[0]) > 4 else []
    if tid != target:
        return "ERROR", "the death is %r, not the named pin" % tid
    # AUD54-post-audit finding: an error whose traceback passes through
    # the pin is NOT a kill when the exception is an infrastructure
    # failure — SyntaxError/ImportError (broken dependency, bad
    # mutant copy, environment drift) proves nothing about the pin's
    # assertion. The driver records the exception's MRO so this check
    # cannot be fooled by message text or a re-raised wrapper.
    infra = {"SyntaxError", "ImportError", "ModuleNotFoundError",
             "FileNotFoundError", "PermissionError", "MemoryError",
             "SystemExit", "KeyboardInterrupt"}
    hit = infra.intersection(mro)
    if kind == "error" and hit:
        return "ERROR", ("error death is an infrastructure failure (%s) "
                         "through the pin — not evidence of a kill"
                         % ", ".join(sorted(hit)))
    method = target.rsplit(".", 1)[-1]
    # structured frame identity (c2 f1+f2): the death must pass
    # THROUGH the pin's own method in the test module — works for
    # asserts inside helpers the pin calls, and cannot be faked by
    # exception message text.
    here = os.path.realpath(modfile) if modfile else None
    if not any(here and os.path.realpath(fr[0]) == here
               and fr[1] == method for fr in frames):
        return "ERROR", ("%s death named the pin but never ran its "
                         "method body (setUp/tearDown/loader?)" % kind)
    return "RED", "1 %s through the pin's own method" % (
        "assertion failure" if kind == "fail" else "error")


def selftest_classifier():
    """AUD54-post-audit finding: the CLASSIFIER itself must be tested
    before it is trusted. A SyntaxError/ImportError raised inside the
    pin used to score RED (traceback frames matched, exception type
    never inspected) — an infrastructure failure masquerading as a
    kill. Each case writes a probe module into a temp dir and asserts
    the verdict: INFRA cases must be ERROR (no false RED) and real
    kills must stay RED (the gate never silently over-ERRORs a
    genuine kill — a mismatch either way prints and aborts the matrix
    with exit 1)."""
    cases = [
        # (name, module source, target, expected verdict, expect_ran)
        ("syntaxerror-raised-in-pin",
         "import unittest\n"
         "class T(unittest.TestCase):\n"
         "    def test_pin(self):\n"
         "        raise SyntaxError('broken dependency')\n",
         "m_infr_syntax.T.test_pin", "ERROR", None),
        ("importerror-in-pin",
         "import unittest\n"
         "class T(unittest.TestCase):\n"
         "    def test_pin(self):\n"
         "        import definitely_missing_module_xyz\n",
         "m_infr_import.T.test_pin", "ERROR", None),
        ("syntaxerror-at-module-import",
         "def broken(:\n",
         "m_infr_brokenmod.T.test_pin", "ERROR", None),
        ("filenotfound-in-pin",
         "import unittest\n"
         "class T(unittest.TestCase):\n"
         "    def test_pin(self):\n"
         "        open('/definitely/not/here/xyz')\n",
         "m_infr_fnf.T.test_pin", "ERROR", None),
        ("assertion-kill-stays-RED",
         "import unittest\n"
         "class T(unittest.TestCase):\n"
         "    def test_pin(self):\n"
         "        self.assertEqual(1, 2)\n",
         "m_kill_assert.T.test_pin", "RED", None),
        ("expected-oserror-kill-stays-RED",
         "import errno, unittest\n"
         "class T(unittest.TestCase):\n"
         "    def test_pin(self):\n"
         "        raise OSError(errno.EIO, 'device made no progress')\n",
         "m_kill_oserror.T.test_pin", "RED", None),
        ("subtest-kill-inside-pin-stays-RED",
         "import unittest\n"
         "class T(unittest.TestCase):\n"
         "    def test_pin(self):\n"
         "        with self.subTest('branch'):\n"
         "            self.fail('subtest death')\n",
         "m_kill_subtest.T.test_pin", "RED", None),
        ("skip-is-ERROR",
         "import unittest\n"
         "class T(unittest.TestCase):\n"
         "    def test_pin(self):\n"
         "        self.skipTest('not evidence')\n",
         "m_gate_skip.T.test_pin", "ERROR", None),
        ("xfail-is-ERROR",
         "import unittest\n"
         "class T(unittest.TestCase):\n"
         "    @unittest.expectedFailure\n"
         "    def test_pin(self):\n"
         "        self.fail('expected failure')\n",
         "m_gate_xfail.T.test_pin", "ERROR", None),
        ("count-mismatch-is-ERROR",
         "import unittest\n"
         "class T(unittest.TestCase):\n"
         "    def test_pin(self):\n"
         "        pass\n",
         "m_gate_count.T.test_pin", "ERROR", 2),
        ("two-deaths-is-ERROR",
         "import unittest\n"
         "class T(unittest.TestCase):\n"
         "    def test_pin(self):\n"
         "        self.fail('death one')\n"
         "    def test_sibling(self):\n"
         "        self.fail('death two')\n",
         "m_gate_multi.T", "ERROR", None),
    ]
    bad = []
    work = tempfile.mkdtemp(prefix="mutmatrix-selftest-")
    try:
        for i, (name, source, target, want, expect_ran) in enumerate(cases):
            mod = target.split(".")[0]
            with open(os.path.join(work, mod + ".py"), "w") as f:
                f.write(source)
            verdict, detail = run_test(work, target, timeout=30,
                                       expect_ran=expect_ran)
            ok = verdict == want
            print("SELFTEST %-36s %-5s %s (%s)"
                  % (name, verdict, "OK" if ok else "WANT %s" % want,
                     detail[:72]))
            if not ok:
                bad.append("selftest %s: got %s, want %s (%s)"
                           % (name, verdict, detail, want))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return bad


def main():
    # A broken classifier cannot certify ANY kill: run its own battery
    # first and abort loudly if a case misclassifies (post-audit:
    # infra errors must never score RED).
    st_fails = selftest_classifier()
    if st_fails:
        print("\nCLASSIFIER SELFTEST FAILED (%d):" % len(st_fails))
        for f in st_fails:
            print("  -", f)
        return 1
    print()
    src_dir = os.path.join(PKG, "p9m3")
    with open(os.path.join(src_dir, "ledger.py")) as f:
        src = f.read()
    work = tempfile.mkdtemp(prefix="mutmatrix-")
    fails = []
    try:
        # ---- full suite on the PRISTINE copy must be GREEN ----------
        # AUD54c1 finding 2: "Ran 0 tests ... OK" is not green. The
        # expected count is derived INDEPENDENTLY here (grep over the
        # test source for def test_*), so the driver's count and this
        # count are two sources that must agree. AUD54c3 finding 2:
        # a grep count cannot see aliases (test_x = test_y) or
        # inherited tests — if this gate ever fires on a legitimate
        # restructure, FAIL LOUD here and update the declaration
        # source by hand; the gate never fails silently toward GREEN.
        with open(os.path.join(src_dir, "test_ledger.py")) as f:
            test_src = f.read()
        want = len(re.findall(r"^\s+def test_", test_src, re.M))
        base = os.path.join(work, "base")
        shutil.copytree(src_dir, os.path.join(base, "p9m3"))
        verdict, detail = run_test(base, SUITE, timeout=600, expect_ran=want)
        print("BASE  full suite (%d tests declared): %s  (%s)"
              % (want, verdict, detail))
        if verdict != "GREEN":
            fails.append("BASE suite is not green on a clean tree "
                         "(%s: %s)" % (verdict, detail))

        # ---- each mutant must turn its pin test RED -----------------
        for mid, old, new, test in MUTANTS:
            hits = src.count(old)
            if hits != 1:
                fails.append("%s: anchor occurs %d times in ledger.py "
                             "(claim not reproducible — fix the anchor)"
                             % (mid, hits))
                print("%-4s anchor ERROR (%d matches)" % (mid, hits))
                continue
            root = os.path.join(work, mid)
            shutil.copytree(src_dir, os.path.join(root, "p9m3"))
            path = os.path.join(root, "p9m3", "ledger.py")
            with open(path, "w") as f:
                f.write(src.replace(old, new))
            verdict, detail = run_test(root, "%s.%s" % (CLASS, test),
                                       timeout=120)
            if verdict == "RED":
                print("%-4s RED  as claimed by %s (%s)"
                      % (mid, test, detail))
            elif verdict == "GREEN":
                fails.append("%s: pin test %s PASSED under the mutant "
                             "(claim is false — the pin does not kill it)"
                             % (mid, test))
                print("%-4s SURVIVED (green — claim broken)" % mid)
            else:
                fails.append("%s: pin test %s %s under the mutant — the "
                             "kill claim is UNPROVEN (%s)"
                             % (mid, test, verdict, detail))
                print("%-4s %s (%s)" % (mid, verdict, detail))
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if fails:
        print("\nMATRIX DIVERGED (%d):" % len(fails))
        for f in fails:
            print("  -", f)
        return 1
    print("\nMATRIX: all %d mutation claims + BASE reproduced."
          % len(MUTANTS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
