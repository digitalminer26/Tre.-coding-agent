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
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)          # the `reference/` dir (import root)

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


def run_test(root, target, timeout):
    """Run one unittest target in `root`; return (returncode, tail)."""
    try:
        p = subprocess.run([sys.executable, "-B", "-m", "unittest",
                            "-v", target],
                           cwd=root, capture_output=True, text=True,
                           timeout=timeout)
    except subprocess.TimeoutExpired:
        return "TIMEOUT", ""
    tail = (p.stdout + p.stderr).strip().splitlines()[-1:] or [""]
    return p.returncode, tail[0]


def main():
    src_dir = os.path.join(PKG, "p9m3")
    src = open(os.path.join(src_dir, "ledger.py")).read()
    work = tempfile.mkdtemp(prefix="mutmatrix-")
    fails = []
    try:
        # ---- full suite on the PRISTINE copy must be GREEN ----------
        base = os.path.join(work, "base")
        shutil.copytree(src_dir, os.path.join(base, "p9m3"))
        rc, tail = run_test(base, SUITE, timeout=600)
        print("BASE  full suite: %s  (%s)" % (
            "GREEN" if rc == 0 else "NOT GREEN", tail))
        if rc != 0:
            fails.append("BASE suite is not green on a clean tree")

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
            rc, tail = run_test(root, "%s.%s" % (CLASS, test), timeout=120)
            if rc == "TIMEOUT" or rc != 0:
                print("%-4s RED  as claimed by %s" % (mid, test))
            else:
                fails.append("%s: pin test %s PASSED under the mutant "
                             "(claim is false — the pin does not kill it)"
                             % (mid, test))
                print("%-4s SURVIVED (%s green — claim broken)" % (mid, test))
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
