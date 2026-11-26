#!/usr/bin/env python3
"""Deterministic driver for scripts/findings-mutate.py's pure judgment
functions (g1s7-F3 audit fix 5). test/findings-mutate.test.ts imports
the sweep script by path and feeds it SYNTHETIC TAP so every rule —
baseline dup rejection, executed-only attribution, SKIP-DRIFT,
AMBIGUOUS-TAP, isolation reproduction, hang attribution, fail-closed
registry audit, crash-journal recovery, signal-atomic spawn — is
pinned WITHOUT the ~30-minute mutant sweep.

Contract: one command per invocation, JSON in, one JSON object out,
exit 0 on success (a rule violation is a normal JSON result, not an
exception).

Commands:
  baseline      {"tap": [...]}   -> green? refusal reasons
  sweep         {"base_tap": [...], "tap": [...]}
                                 -> judge_run verdict + skip-drift names
  iso           {"base_tap": [...], "iso_tap": [...], "target": name}
                                 -> judge_run(iso, require) verdict
  hang          {"base_tap": [...], "suites": [{"tap": [...]}, ...]}
                                 -> judge_hang verdict per rerun
  registry      {"src": "python source defining MUTS = {...}"}
                                 -> fail-closed dupes result ("none"/["name"]/null)
  journal       {"dir": tmpdir}  -> _journal_recover roundtrip facts
  spawnmask     {}               -> SIGINT/SIGTERM blocked inside _spawn_atomic?
"""
import ast
import base64
import importlib.util
import io
import json
import os
import signal
import sys
import tempfile
from contextlib import redirect_stdout

SPEC_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "findings-mutate.py")


def load_sweep():
    spec = importlib.util.spec_from_file_location("findings_mutate", SPEC_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def parse_tap(mod, lines):
    r = mod.RunResult()
    r.lines = list(lines)
    r.rc = 0
    r.parse()
    return r


def apply_rc(mod, r, payload):
    """Explicit rc from the payload wins; otherwise derive the rc a
    real `node --test` would exit with (0 green, 1 with failures) —
    g1s7-C1-F6: rc=0 over '# fail N>0' is the CONTRADICTORY shape the
    judge must refuse, so fixtures only get that when they ask."""
    if "rc" in payload:
        r.rc = payload["rc"]
    elif r.fail:
        r.rc = 1
    return r


def cmd_baseline(mod, payload):
    # g1s7-C1-F10 audit fix: call the REAL production gate
    # (baseline_refusals) — the driver no longer reimplements the
    # refusal conditions, so it cannot drift from baseline().
    r = parse_tap(mod, payload["tap"])
    apply_rc(mod, r, payload)
    if payload.get("timed_out"):
        r.timed_out = True
    reasons = mod.baseline_refusals(r)
    return {"refused": bool(reasons), "reasons": reasons,
            "green": sorted(mod.attribution_green(r)),
            "executed": sorted(r.executed),
            "skipped": sorted(r.skipped)}


def cmd_sweep(mod, payload):
    base = parse_tap(mod, payload["base_tap"])
    r = parse_tap(mod, payload["tap"])
    apply_rc(mod, r, payload)
    status, detail, new_fail = mod.judge_run(r, mod.attribution_green(base),
                                             base.skipped)
    drift = mod.new_skip_drift(r, mod.attribution_green(base), base.skipped)
    return {"status": status, "detail": detail, "new_fail": new_fail,
            "drift": drift,
            "green": sorted(mod.attribution_green(base))}


def cmd_iso(mod, payload):
    base = parse_tap(mod, payload["base_tap"])
    iso = parse_tap(mod, payload["iso_tap"])
    apply_rc(mod, iso, payload)
    status, detail, _ = mod.judge_run(iso, mod.attribution_green(base),
                                      base.skipped,
                                      require_iso_fail=payload["target"])
    return {"status": status, "detail": detail}


def cmd_hang(mod, payload):
    base = parse_tap(mod, payload["base_tap"])
    per_suite = []
    for i, s in enumerate(payload["suites"]):
        sr = parse_tap(mod, s["tap"])
        sr.timed_out = bool(s.get("timed_out", False))
        if "rc" in s:
            sr.rc = s["rc"]
        per_suite.append((f"suite{i}", sr))
    # g1s7-C1-F5 audit: per-suite baseline membership, keyed by the
    # same suite ids; payload "suite_green": {"suite0": [names]}.
    # Absent key => None (attribution must be refused fail-closed).
    sg = payload.get("suite_green")
    suite_green = None
    if sg is not None:
        suite_green = {f"suite{i}": set(sg.get(f"suite{i}", []))
                       for i in range(len(payload["suites"]))}
    ok, hung, clean, why = mod.judge_hang(per_suite,
                                          mod.attribution_green(base),
                                          base.skipped, suite_green=suite_green)
    return {"attributed": ok, "hung": hung, "clean": clean, "reason": why}


def cmd_registry(mod, payload):
    # Audit SYNTHETIC sources with the REAL function: extract
    # _mutant_name_dupes verbatim from the sweep script, append it to
    # the fixture (which defines its own MUTS), load as a module so
    # __file__ is the fixture — no duplicated logic in the test.
    tmp = tempfile.mkdtemp(prefix="fmd-reg-")
    with open(SPEC_PATH, encoding="utf-8") as fh:
        real_src = fh.read()
    tree = ast.parse(real_src)
    fn_src = None
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_mutant_name_dupes":
            fn_src = ast.get_source_segment(real_src, node)
            break
    if fn_src is None:
        return {"dupes": "RAISED", "err": "_mutant_name_dupes not found in sweep source"}
    fixture = os.path.join(tmp, "registry_under_test.py")
    # g1s7-C2q-F1 probe shape: the module LOADED fine (valid source at
    # import); the on-disk file becomes malformed UTF-8 BEFORE the
    # audit re-reads __file__ (byte-rotated checkout). exec a VALID
    # fixture, then overwrite the file with payload["corrupt_b64"]
    # (kept valid Python ASCII-structurally — only a string literal
    # body carries the malformed bytes) and run the audit.
    corrupt_b64 = payload.get("corrupt_b64")
    with open(fixture, "w", encoding="utf-8") as fh:
            # future-annotations defers the real fn's PEP 604 annotations
            # (list[str] | None) the fixture lacks imports for; `import
            # ast` covers the fn's module-level use.
            fh.write("from __future__ import annotations\nimport ast\n\n"
                     + payload["src"] + "\n\n" + fn_src + "\n")
    spec = importlib.util.spec_from_file_location("reg_ut", fixture)
    m = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(m)
        if corrupt_b64 is not None:
            with open(fixture, "wb") as fh:
                fh.write(base64.b64decode(corrupt_b64))
        dupes = m._mutant_name_dupes()
    except Exception as e:
        return {"dupes": "RAISED", "err": f"{type(e).__name__}: {e}"}
    return {"dupes": dupes if dupes is None else dupes}


def cmd_journal(mod, payload):
    tmp = payload["dir"]
    src = os.path.join(tmp, "intake.ts")
    mod.SRC = src
    # Journal probes retarget the FIXED root (C2a3-F1: journal/lock
    # are _JOURNAL_ROOT-based, never TMPDIR-derived).
    saved_root = mod._JOURNAL_ROOT
    mod._JOURNAL_ROOT = os.path.join(tmp, "jroot")
    os.makedirs(mod._JOURNAL_ROOT, exist_ok=True)
    pristine = "export const x = 1;\n"
    # Fresh journal against pristine source: nothing to undo.
    open(src, "w").write(pristine)
    mod._journal_write(pristine)
    existed = os.path.exists(mod._journal_path())
    recovered_clean = mod._journal_recover()          # expect False, journal gone
    gone_after_clean = not os.path.exists(mod._journal_path())
    # SIGKILL simulation: apply a mutant with the journal still armed.
    mod._journal_write(pristine)
    open(src, "w").write("export const x = 2; /* MUTANT */\n")
    recovered_dirty = mod._journal_recover()          # expect True
    content = open(src).read()
    gone_after_recover = not os.path.exists(mod._journal_path())
    # g1s7-C1-F8 audit: torn journal (header promises more bytes than
    # the body carries — SIGKILL mid-write shape) must RAISE and NEVER
    # touch src/. g1s7-C2-F3 audit: the corrupt journal is QUARANTINED
    # (renamed aside), not deleted — a later run must still discover
    # that recovery is outstanding, never accept mutated src/ blind.
    open(src, "w").write("export const x = 3; /* MUTANT */\n")
    with open(mod._journal_path(), "w", encoding="utf-8") as fh:
        fh.write(mod._JOURNAL_MAGIC + "9999\n" + "0" * 64 + "\nexport const x = 1;\n" + mod._JOURNAL_END)
    torn_raised = False
    try:
        mod._journal_recover()
    except mod.JournalCorrupt:
        torn_raised = True
    torn_journal_gone = not os.path.exists(mod._journal_path())
    torn_src_untouched = open(src).read() == "export const x = 3; /* MUTANT */\n"
    quarantine = [f for f in os.listdir(os.path.dirname(mod._journal_path()))
                  if f.startswith(os.path.basename(mod._journal_path()))
                  and ".corrupt." in f]
    torn_quarantined = len(quarantine) == 1 and open(
        os.path.join(os.path.dirname(mod._journal_path()),
                     quarantine[0])).read().startswith(mod._JOURNAL_MAGIC)
    # g1s7-C2a-F1 audit: the NEXT recover (quarantine present, journal
    # absent) must RAISE too — "not finding j" may never bless a
    # possibly-mutated src/ as pristine. Only manual handling of the
    # quarantine clears the refusal.
    second_raised = False
    try:
        mod._journal_recover()
    except mod.JournalCorrupt:
        second_raised = True
    second_src_untouched = open(src).read() == "export const x = 3; /* MUTANT */\n"
    # Manual handling (as the refusal instructs): restore src, remove
    # the quarantine -> recovery is silent-False again.
    open(src, "w").write(pristine)
    for q in quarantine:
        os.remove(os.path.join(os.path.dirname(mod._journal_path()), q))
    cleared_ok = mod._journal_recover() is False
    # g1s7-C2k-F1 audit: a SAME-LENGTH corrupted body (valid length
    # header, valid end marker, but modified content) must NOT be
    # accepted as pristine — the digest check quarantines it and src
    # is never touched. Pre-checksum journals accepted this blind.
    open(src, "w").write("export const x = 5; /* MUTANT */\n")
    corrupt_body = "export const x = 1;\n"  # pristine-length bytes
    payload_f2 = (mod._JOURNAL_MAGIC
                  + str(len(corrupt_body.encode())) + "\n"
                  + "f" * 64 + "\n"  # digest of SOMETHING ELSE
                  + corrupt_body + mod._JOURNAL_END)
    mod._journal_write(pristine)  # real journal first...
    with open(mod._journal_path(), "w", encoding="utf-8") as fh:
        fh.write(payload_f2)      # ...then the crafted corruption
    digest_raised = False
    try:
        mod._journal_recover()
    except mod.JournalCorrupt:
        digest_raised = True
    digest_journal_gone = not os.path.exists(mod._journal_path())
    digest_src_untouched = open(src).read() == "export const x = 5; /* MUTANT */\n"
    digest_quarantine = [f for f in os.listdir(os.path.dirname(mod._journal_path()))
                         if ".corrupt." in f]
    digest_quarantined = len(digest_quarantine) == 1
    # Manual handling: restore src, clear quarantine -> silent False.
    open(src, "w").write(pristine)
    for q in digest_quarantine:
        os.remove(os.path.join(os.path.dirname(mod._journal_path()), q))
    digest_cleared_ok = mod._journal_recover() is False
    # g1s7-C2-F1 audit: an UNREADABLE journal (OSError on read) must
    # raise JournalRecoverFailed and PRESERVE the journal — the old
    # `except OSError: return False` said "nothing to recover" over a
    # possibly-mutated src/.
    mod._journal_write(pristine)
    open(src, "w").write("export const x = 4; /* MUTANT */\n")
    os.chmod(mod._journal_path(), 0o000)
    unreadable_raised = False
    try:
        mod._journal_recover()
    except mod.JournalRecoverFailed:
        unreadable_raised = True
    unreadable_preserved = os.path.exists(mod._journal_path())
    os.chmod(mod._journal_path(), 0o600)
    src_still_mutant = open(src).read() == "export const x = 4; /* MUTANT */\n"
    # g1s7-C2a-F4 audit: an INACCESSIBLE journal DIRECTORY must not
    # read as "no journal to recover" (os.path.exists swallows EACCES
    # on the path walk). Redirect the journal into a mode-000 dir:
    # recovery must raise JournalRecoverFailed, never return False.
    inacc = os.path.join(tmp, "journaldir-nox")
    os.makedirs(inacc, exist_ok=True)
    mod._JOURNAL_ROOT = inacc
    os.chmod(inacc, 0o000)
    inaccess_raised = False
    try:
        mod._journal_recover()
    except mod.JournalRecoverFailed:
        inaccess_raised = True
    os.chmod(inacc, 0o700)
    mod._JOURNAL_ROOT = os.path.join(tmp, "jroot")
    inaccess_dir_removed = True
    try:
        os.rmdir(inacc)
    except OSError:
        inaccess_dir_removed = False
    # g1s7-C2a2-F1 audit: SEARCHABLE-but-UNLISTABLE dir (mode 0111):
    # listdir fails with EACCES while stat() of known names still
    # works — a swallowed listing error would hide a quarantine and
    # bless mutated src/. The scan must refuse.
    unlist = os.path.join(tmp, "journaldir-unlistable")
    os.makedirs(unlist, exist_ok=True)
    qname = os.path.join(unlist, "findings-mutate-abc123def456.journal.corrupt.1")
    with open(qname, "w") as fh:
        fh.write("FJ2\n4\n" + "0" * 64 + "\ntest\nFJ2-END")
    mod._JOURNAL_ROOT = unlist
    os.chmod(unlist, 0o111)
    unlistable_raised = False
    try:
        mod._journal_recover()
    except (mod.JournalRecoverFailed, mod.JournalCorrupt):
        unlistable_raised = True
    finally:
        os.chmod(unlist, 0o700)
        mod._JOURNAL_ROOT = os.path.join(tmp, "jroot")
    unlist_dir_removed = True
    try:
        os.remove(qname)
        os.rmdir(unlist)
    except OSError:
        unlist_dir_removed = False
    # g1s7-C2a3-F1 audit: the journal location must be INDEPENDENT of
    # TMPDIR — retarget _JOURNAL_ROOT once, then prove a TMPDIR change
    # mid-flight cannot move the journal or its lock out of reach.
    os.environ["TMPDIR"] = os.path.join(tmp, "tmpdir-a")
    os.makedirs(os.environ["TMPDIR"], exist_ok=True)
    # src currently holds the x=4 MUTANT; arm the journal with the
    # pristine body and prove recovery at the stable root works.
    mod._journal_write(pristine)
    jp_a = mod._journal_path()
    os.environ["TMPDIR"] = os.path.join(tmp, "tmpdir-b")
    os.makedirs(os.environ["TMPDIR"], exist_ok=True)
    jp_b = mod._journal_path()
    tmpdir_stable = (jp_a == jp_b
                     and jp_a.startswith(os.path.join(tmp, "jroot"))
                     and os.path.exists(jp_a))
    # Recovery after the probe must WORK at the stable root: the
    # journal (pristine) was written, src is the mutant, so recover
    # returns True AND restores pristine content.
    tmpdir_recover_ok = False
    if tmpdir_stable:
        tmpdir_recover_ok = mod._journal_recover() is True and \
            open(src).read() == pristine
    # Cleanup: never leave fixture journals/quarantines behind (the
    # litter scan below only sees this journal's prefix). Scan while
    # _JOURNAL_ROOT still points at the fixture root: the litter the
    # probe is about is journal-write litter in THAT dir; restoring
    # the real root first would make the scan list /tmp (vacuous for
    # the probe and unreadable under the sandbox).
    try:
        os.remove(mod._journal_path())
    except FileNotFoundError:
        pass
    for q in quarantine:
        try:
            os.remove(os.path.join(os.path.dirname(mod._journal_path()), q))
        except OSError:
            pass
    # Atomic write leaves no .tmp litter behind. g1s7-C2-F5 audit:
    # the journal (and its tmp files) live in the SYSTEM temp dir
    # (tempfile.gettempdir()), NOT the fixture dir — scanning the
    # fixture dir for *.tmp could only ever pass vacuously. Scan where
    # _journal_write actually writes, filtered to this journal's
    # prefix so unrelated system litter cannot flip the result.
    import tempfile as _tf
    jdir = os.path.dirname(mod._journal_path())
    jbase = os.path.basename(mod._journal_path())
    litter = [f for f in os.listdir(jdir)
              if f.startswith(jbase) and f.endswith(".tmp")]
    mod._JOURNAL_ROOT = saved_root
    del os.environ["TMPDIR"]
    return {"existed": existed, "recovered_clean": recovered_clean,
            "gone_after_clean": gone_after_clean,
            "recovered_dirty": recovered_dirty,
            "restored": content == pristine,
            "gone_after_recover": gone_after_recover,
            "torn_raised": torn_raised,
            "torn_journal_gone": torn_journal_gone,
            "torn_src_untouched": torn_src_untouched,
            "torn_quarantined": torn_quarantined,
            "second_raised": second_raised,
            "second_src_untouched": second_src_untouched,
            "cleared_ok": cleared_ok,
            "digest_raised": digest_raised,
            "digest_journal_gone": digest_journal_gone,
            "digest_src_untouched": digest_src_untouched,
            "digest_quarantined": digest_quarantined,
            "digest_cleared_ok": digest_cleared_ok,
            "unreadable_raised": unreadable_raised,
            "unreadable_preserved": unreadable_preserved,
            "src_still_mutant": src_still_mutant,
            "inaccess_raised": inaccess_raised,
            "inaccess_dir_removed": inaccess_dir_removed,
            "unlistable_raised": unlistable_raised,
            "unlist_dir_removed": unlist_dir_removed,
            "tmpdir_stable": tmpdir_stable,
            "tmpdir_recover_ok": tmpdir_recover_ok,
            "no_tmp_litter": litter == []}


def cmd_journal_pathkey(mod, payload):
    """g1s7-C1-F1 audit: two checkouts (different ABSOLUTE paths for
    the same-named source) must map to DIFFERENT journal paths."""
    a = os.path.join(payload["dir"], "checkoutA", "intake.ts")
    b = os.path.join(payload["dir"], "checkoutB", "intake.ts")
    os.makedirs(os.path.dirname(a), exist_ok=True)
    os.makedirs(os.path.dirname(b), exist_ok=True)
    mod.SRC = a
    pa = mod._journal_path()
    mod.SRC = b
    pb = mod._journal_path()
    return {"distinct": pa != pb, "a_in_tmp": pa.startswith(
        payload["dir"].replace(payload["dir"], "") or "/"),
        "both_absolute": os.path.isabs(pa) and os.path.isabs(pb)}


def cmd_journal_import(mod, payload):
    """g1s7-C1-F2 audit: a bare import (no sweep armed _SRC_RESTORE)
    must leave a live journal untouched through this process's exit.
    The journal is written here; the TS test asserts it still EXISTS
    after this driver process has exited (atexit has run)."""
    src = os.path.join(payload["dir"], "intake.ts")
    mod.SRC = src
    mod._JOURNAL_ROOT = os.path.join(payload["dir"], "jroot")
    os.makedirs(mod._JOURNAL_ROOT, exist_ok=True)
    open(src, "w").write("export const x = 2; /* MUTANT */\n")
    mod._journal_write("export const x = 1;\n")
    # NOT armed: _SRC_RESTORE stays None, exactly like an import.
    armed = mod._SRC_RESTORE["orig"] is not None
    return {"armed": armed,
            "journal_exists_before_exit": os.path.exists(mod._journal_path())}


def cmd_journal_import_recheck(mod, payload):
    """Run AFTER cmd_journal_import's process exited: does the live
    journal still exist? (g1s7-C1-F2: atexit of a never-mutating
    process must not delete it.)"""
    src = os.path.join(payload["dir"], "intake.ts")
    mod.SRC = src
    mod._JOURNAL_ROOT = os.path.join(payload["dir"], "jroot")
    return {"journal_survives": os.path.exists(mod._journal_path())}


def cmd_journal_lock(mod, payload):
    """g1s7-C1-F1 audit: concurrent sweeps are refused by the flock.
    Child process tries to acquire the same journal lock while the
    parent holds it -> must fail."""
    import subprocess
    src = os.path.join(payload["dir"], "intake.ts")
    mod.SRC = src
    mod._JOURNAL_ROOT = os.path.join(payload["dir"], "jroot")
    os.makedirs(mod._JOURNAL_ROOT, exist_ok=True)
    got = mod._acquire_sweep_lock()
    code = (f"import importlib.util,json,sys;"
            f"spec=importlib.util.spec_from_file_location('m','{SPEC_PATH}');"
            f"m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);"
            f"m.SRC={src!r};m._JOURNAL_ROOT={os.path.join(payload['dir'], 'jroot')!r};"
            f"print(json.dumps({{'child_got': m._acquire_sweep_lock()}}))")
    out = subprocess.run([sys.executable, "-c", code],
                         capture_output=True, text=True, timeout=30)
    child = json.loads(out.stdout) if out.stdout.strip() else {"child_got": "ERR"}
    return {"parent_got": got, "child_got": child["child_got"],
            "child_exit": out.returncode}


def cmd_restore_hook_durability(mod, payload):
    """g1s7-C2c-F1 audit: when src ALREADY equals orig in the page
    cache but the durable fsync FAILS, the atexit hook must set
    _RESTORE_FAILED (journal stays armed) — the old hook skipped
    fsync entirely on a page-cache match and let the clear hook
    delete the journal over un-durable bytes."""
    src = os.path.join(payload["dir"], "intake.ts")
    orig = "export const x = 1;\n"
    open(src, "w").write(orig)
    mod.SRC = src
    mod._SRC_RESTORE["orig"] = orig
    mod._SRC_RESTORE["path"] = src
    mod._RESTORE_FAILED = False
    mod._JOURNAL_ROOT = os.path.join(payload["dir"], "jroot")
    os.makedirs(mod._JOURNAL_ROOT, exist_ok=True)
    # g1s7-C2i-F2: the clear hook refuses without the sweep lock (a
    # process that never held it cannot prove the journal is not a
    # LIVE sweep's). Real sweeps hold the lock before arming — take
    # it here so this simulates a lock-holding sweep.
    if not mod._acquire_sweep_lock():
        raise RuntimeError("driver could not take the sim sweep lock")
    real = os.fsync
    try:
        def raise_eio(_fd):
            raise OSError(5, "injected fsync EIO")
        # Control first: with a working fsync the same (already
        # matching) state restores and clears cleanly.
        mod._restore_src_hook()
        mod._journal_write(orig)
        mod._journal_clear_hook()
        cleared_when_durable = not os.path.exists(mod._journal_path())
        # Fault: arm again, fail the hook's fsync on the MATCH
        # branch; the journal must stay armed.
        mod._journal_write(orig)
        os.fsync = raise_eio
        mod._restore_src_hook()
        failed_flag = mod._RESTORE_FAILED is True
        mod._journal_clear_hook()
        journal_armed = os.path.exists(mod._journal_path())
        # g1s7-C2m-F1 audit: an INTERRUPT (SystemExit, as a deferred
        # SIGINT/SIGTERM raises) landing inside the restore hook must
        # set the failure flag too and propagate — Python keeps
        # running the remaining atexit callbacks after one raises,
        # so a silent slip-past let the clear hook delete the journal
        # over un-proven page-cache bytes.
        mod._SRC_RESTORE["orig"] = orig
        mod._SRC_RESTORE["path"] = src
        mod._RESTORE_FAILED = False
        os.fsync = real  # journal re-arm must use the REAL fsync
        mod._journal_write(orig)

        def raise_exit(_fd):
            raise SystemExit(143)
        os.fsync = raise_exit
        propagated = False
        try:
            mod._restore_src_hook()
        except SystemExit:
            propagated = True
        exit_flag = mod._RESTORE_FAILED is True
        mod._journal_clear_hook()
        journal_armed_after_exit = os.path.exists(mod._journal_path())
    finally:
        os.fsync = real
        mod._SRC_RESTORE["orig"] = None
        mod._SRC_RESTORE["path"] = None
        mod._RESTORE_FAILED = False
        try:
            os.remove(mod._journal_path())
        except OSError:
            pass
    return {"failed_flag_on_fsync_error": failed_flag,
            "journal_armed_after_failed_restore": journal_armed,
            "cleared_when_durable": cleared_when_durable,
            "exit_propagated": propagated,
            "exit_sets_failed_flag": exit_flag,
            "journal_armed_after_exit": journal_armed_after_exit}


def cmd_fsync_semantics(mod, payload):
    """g1s7-C2b-F2 audit: _fsync_dir must forgive ONLY 'platform does
    not support this call' errnos and propagate real I/O failures.
    Fault-inject via monkeypatch (EIO must raise, EINVAL must not)."""
    real = os.fsync
    results = {}
    d = payload["dir"]
    try:
        def raise_eio(_fd):
            raise OSError(5, "injected EIO")
        os.fsync = raise_eio
        try:
            mod._fsync_dir(d)
            results["eio_raised"] = False
        except OSError:
            results["eio_raised"] = True

        def raise_einval(_fd):
            raise OSError(22, "injected EINVAL")
        os.fsync = raise_einval
        try:
            mod._fsync_dir(d)
            results["einval_tolerated"] = True
        except OSError:
            results["einval_tolerated"] = False
        # g1s7-C2c-F3 audit: restore the REAL fsync BEFORE the real-
        # call probe — calling it under the EINVAL mock proved nothing.
        os.fsync = real
        try:
            mod._fsync_dir(d)
            results["real_ok"] = True
        except OSError:
            results["real_ok"] = False
    finally:
        os.fsync = real
    return results


def cmd_descendant_kill(mod, payload):
    """g1s7-C2a3-F2 audit: an IMMEDIATE child that exits while its
    descendant (same process group, e.g. `sh -c 'sleep N &'`) keeps
    running must NOT be dropped uncleaned — the group kill must be
    unconditional. `ps` is blocked in the sandbox, so the descendant
    publishes its pid to a file and we probe liveness with kill(pid,0)."""
    import time
    pidfile = os.path.join(payload["dir"], "desc.pid")
    res = mod.stream_run(["sh", "-c",
                          f'sleep 137 & echo $! > {pidfile}'], 5)
    time.sleep(0.2)  # let the descendant reparent (ppid->1)
    # g1s7-C2b-F3 audit: a missing/malformed pidfile must NOT read as
    # "descendant killed" — the probe has to PROVE the descendant was
    # spawned before its absence can count as cleanup evidence.
    descendant_spawned = False
    descendant_alive = False
    try:
        dpid = int(open(pidfile).read().strip())
        descendant_spawned = dpid > 0
    except (FileNotFoundError, ValueError):
        dpid = None
    if descendant_spawned:
        try:
            os.kill(dpid, 0)
            descendant_alive = True
        except ProcessLookupError:
            descendant_alive = False  # killed with the group: pass
        except PermissionError:
            descendant_alive = True   # alive, just not ours to signal
        except OSError:
            descendant_alive = False
        if descendant_alive:  # cleanup no matter what (no test litter)
            try:
                os.kill(dpid, signal.SIGKILL)
            except OSError:
                pass
    return {"rc": res.rc, "descendant_spawned": descendant_spawned,
            "descendant_alive": descendant_alive,
            "children_empty": len(mod.ACTIVE_CHILDREN) == 0}


def cmd_spawnmask(mod, _payload):
    import subprocess
    m_before = signal.pthread_sigmask(signal.SIG_BLOCK, set())
    with mod._spawn_atomic() as cm:
        proc = subprocess.Popen(["sleep", "0.3"],
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        mod.ACTIVE_CHILDREN.add(proc.pid)
        inside = signal.pthread_sigmask(signal.SIG_BLOCK, set())
        tracked = proc.pid in mod.ACTIVE_CHILDREN
    m_after = signal.pthread_sigmask(signal.SIG_BLOCK, set())
    proc.wait()
    mod.ACTIVE_CHILDREN.discard(proc.pid)
    return {"sigint_inside": signal.SIGINT in inside,
            "sigterm_inside": signal.SIGTERM in inside,
            "restored_after": m_after == m_before,
            "tracked_in_region": tracked,
            "cm_returns_self": cm.__class__.__name__ == "_spawn_atomic",
            "children_empty": len(mod.ACTIVE_CHILDREN) == 0}


def cmd_kill_on_unwind(mod, payload):
    """g1s7-C1-F3 audit: an interrupt (SystemExit from the signal
    handler) unwinding through stream_run's wait() must KILL the
    child group BEFORE discarding its pid — the process must be dead
    and tracking empty when the exception lands at the caller."""
    import subprocess as sp
    real_popen = sp.Popen
    holder = {}

    class FakePopen:
        def __init__(self, argv, **kw):
            self._p = real_popen(argv, **kw)
            holder["p"] = self._p
            self._raised = False

        def __getattr__(self, name):
            return getattr(self._p, name)

        def wait(self, timeout=None):
            # Interrupt lands DURING the first wait (the signal
            # handler firing); the finally's post-kill wait must go
            # through to the real proc.
            if not self._raised:
                self._raised = True
                raise SystemExit(143)
            return self._p.wait(timeout)

    mod.subprocess.Popen = FakePopen
    try:
        try:
            mod.stream_run(["sleep", "30"], 60)
            outcome = "no-raise"
        except SystemExit:
            outcome = "raised"
    finally:
        mod.subprocess.Popen = real_popen
    p = holder.get("p")
    alive = p is not None and p.poll() is None
    return {"outcome": outcome, "child_killed": not alive,
            "children_empty": len(mod.ACTIVE_CHILDREN) == 0}


def cmd_build_kill_on_unwind(mod, payload):
    """g1s7-C1-F3 audit (build() half): same contract in build() —
    SystemExit through communicate() must kill the tsc group before
    deregistration."""
    import subprocess as sp
    real_popen = sp.Popen
    holder = {}

    class FakePopen:
        def __init__(self, argv, **kw):
            self._p = real_popen(argv, **kw)
            holder["p"] = self._p
            self._raised = False

        def __getattr__(self, name):
            return getattr(self._p, name)

        def communicate(self, timeout=None):
            if not self._raised:
                self._raised = True
                raise SystemExit(143)
            return self._p.communicate(timeout)

    mod.subprocess.Popen = FakePopen
    try:
        try:
            mod.build()
            outcome = "no-raise"
        except SystemExit:
            outcome = "raised"
    finally:
        mod.subprocess.Popen = real_popen
    p = holder.get("p")
    alive = p is not None and p.poll() is None
    return {"outcome": outcome, "child_killed": not alive,
            "children_empty": len(mod.ACTIVE_CHILDREN) == 0}


def cmd_destroy_print_abort(mod, payload):
    """g1s7-C2n-F1 audit: a print that RAISES (closed/broken stdout)
    must not abort the destroy. Simulates BrokenPipeError from every
    print inside _destroy_suspect_dist and checks the fs side effects
    completed AND the sticky flag ends cleared on the success path —
    and that an abort at the FLAG level (flag injected after a
    simulated mid-way failure) leaves the journal armed."""
    d = payload["dir"]
    dist = os.path.join(d, "intake.js")
    mod.DIST = dist
    mod._JOURNAL_ROOT = os.path.join(d, "jroot")
    os.makedirs(mod._JOURNAL_ROOT, exist_ok=True)
    os.makedirs(os.path.dirname(dist) or ".", exist_ok=True)

    class BrokenStdout:
        def write(self, *a):
            raise BrokenPipeError(32, "broken pipe")

        def flush(self):
            raise BrokenPipeError(32, "broken pipe")

    real_stdout = sys.stdout
    try:
        # Success path under broken logging: the artifact must still
        # be deleted and the flag cleared (durable absence).
        with open(dist, "w") as fh:
            fh.write("MUTANT JS")
        mod._DIST_STILL_SUSPECT = True
        sys.stdout = BrokenStdout()
        try:
            ok = mod._destroy_suspect_dist("C2n-F1 probe — broken stdout")
        finally:
            sys.stdout = real_stdout
        gone = not os.path.exists(dist)
        cleared = mod._DIST_STILL_SUSPECT is False
        # Re-destroy with the file ALREADY absent under broken
        # logging (the C2i-F1 retry branch): still durable-success.
        mod._DIST_STILL_SUSPECT = True
        sys.stdout = BrokenStdout()
        try:
            ok2 = mod._destroy_suspect_dist("C2n-F1 probe — retry absent")
        finally:
            sys.stdout = real_stdout
        # A genuine destroy failure (unlink raises a non-OSError):
        # the pessimistic entry flag must have been set already,
        # BEFORE the raise — the flag is armed even mid-abort.
        with open(dist, "w") as fh:
            fh.write("MUTANT JS")
        mod._DIST_STILL_SUSPECT = False  # optimistic start state
        real_remove = os.remove

        def explode(_p):
            raise KeyboardInterrupt("interrupt landing inside the unlink")
        os.remove = explode
        aborted_armed = None
        try:
            sys.stdout = BrokenStdout()
            try:
                mod._destroy_suspect_dist("C2n-F1 probe — abort mid-destroy")
            except KeyboardInterrupt:
                aborted_armed = mod._DIST_STILL_SUSPECT is True
            finally:
                sys.stdout = real_stdout
        finally:
            os.remove = real_remove
        return {"ok_under_broken_stdout": bool(ok),
                "artifact_gone": gone,
                "flag_cleared_on_success": cleared,
                "retry_absent_ok": bool(ok2),
                "armed_on_midway_abort": bool(aborted_armed)}
    finally:
        sys.stdout = real_stdout


def cmd_crlf_roundtrip(mod, payload):
    """g1s7-C2q-F2 probe: a CRLF source must survive the ENTIRE
    mutate/journal/restore chain BYTE-EXACT — snapshot read, journal
    write+recover, durable restore, and the atexit restore hook all
    with newline translation disabled. Before the fix, universal-
    newline conversion rewrote the whole file to LF."""
    tmp = payload["dir"]
    src = os.path.join(tmp, "intake.ts")
    mod.SRC = src
    saved_root = mod._JOURNAL_ROOT
    mod._JOURNAL_ROOT = os.path.join(tmp, "jroot")
    os.makedirs(mod._JOURNAL_ROOT, exist_ok=True)
    try:
        crlf = b"export const a = 1;\r\nconst b = 2;\r\nexport const z = 3;\r\n"
        with open(src, "wb") as fh:
            fh.write(crlf)
        # 1. Snapshot read (same open() flags main() uses).
        with open(src, encoding="utf-8", newline="") as fh:
            orig = fh.read()
        snapshot_exact = orig == crlf.decode("utf-8")  # \r preserved
        # 2. Journal the CRLF body; recover-clean must verify the
        #    declared byte length against the UNTRANSLATED body.
        mod._journal_write(orig)
        clean = mod._journal_recover() is False
        # 3. Apply a "mutant" EXACTLY as main() does post-C2r-F2: a
        #    MULTI-LINE registry snippet (LF-authored) must be adapted
        #    to the file's CRLF endings before replace — the old
        #    single-line probe let the production PATCH-MISS bug pass
        #    unseen. Then recover the dirty journal: restored bytes
        #    must equal the ORIGINAL bytes (\r\n included).
        mod._journal_write(orig)
        snip_old = "export const a = 1;\nconst b = 2;\n"   # LF registry shape
        snip_new = "export const a = 1;\nconst b = 666;\n"
        adapted_missed = snip_old not in orig               # must be true on CRLF src
        a_old, a_new = snip_old, snip_new
        if "\n" in a_old and a_old not in orig and "\r\n" in orig:
            a_old = a_old.replace("\n", "\r\n")
            a_new = a_new.replace("\n", "\r\n")
        adapted_hits = orig.count(a_old) == 1
        with open(src, "w", encoding="utf-8", newline="") as fh:
            fh.write(orig.replace(a_old, a_new, 1))
        mutated = open(src, "rb").read()
        mutant_applied = b"666" in mutated and b"\r\n" in mutated
        multiline_adapted = adapted_missed and adapted_hits
        recovered = mod._journal_recover() is True
        recovered_exact = open(src, "rb").read() == crlf
        # 4. _write_durable of the CRLF text then _write a mutated
        #    variant back byte-exact through the durable writer.
        mutated_text = orig.replace(a_old, a_new.replace("666", "777"), 1)
        mod._write_durable(src, mutated_text)
        durable_exact = open(src, "rb").read() == mutated_text.encode("utf-8")
        # 5. atexit restore hook: orig snapshot vs the mutated file.
        mod._SRC_RESTORE["orig"] = orig
        mod._SRC_RESTORE["path"] = src
        mod._RESTORE_FAILED = False
        mod._restore_src_hook()
        hook_exact = open(src, "rb").read() == crlf
        hook_ok = mod._RESTORE_FAILED is False
        # 6. The hook's fast path (file already == orig) must NOT
        #    rewrite a byte-identical CRLF file (no needless churn).
        mtime_before = os.stat(src).st_mtime_ns
        mod._restore_src_hook()
        fast_no_rewrite = os.stat(src).st_mtime_ns == mtime_before
        return {"snapshot_exact": snapshot_exact,
                "recover_clean_ok": clean,
                "mutant_applied_crlf_intact": mutant_applied,
                "recovered_dirty": recovered,
                "recovered_byte_exact": recovered_exact,
                "durable_write_byte_exact": durable_exact,
                "multiline_snippet_adapted": multiline_adapted,
                "hook_restore_byte_exact": hook_exact,
                "hook_no_failure": hook_ok,
                "hook_fastpath_no_rewrite": fast_no_rewrite}
    finally:
        mod._JOURNAL_ROOT = saved_root
        mod._SRC_RESTORE["orig"] = None
        mod._SRC_RESTORE["path"] = None


def cmd_crlf_registry(mod, payload):
    """g1s7-C2r-F2 behavioral probe: parse the REAL MUTS registry out
    of the sweep source, render SRC as CRLF, and verify main()'s
    adaptation rule makes EVERY snippet (single- AND multi-line)
    findable in the CRLF text."""
    with open(payload["sweep"], encoding="utf-8") as fh:
        real = fh.read()
    tree = ast.parse(real)
    muts = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "MUTS":
            muts = ast.literal_eval(node.value)
            break
    if not isinstance(muts, dict) or not muts:
        return {"all_adapted": False, "err": "MUTS not parseable"}
    # The sweep's OWN SRC constant (relative to the repo root the
    # tests run from) — same file the real sweep mutates.
    src_text = open(mod.SRC, encoding="utf-8").read()
    crlf_text = src_text.replace("\n", "\r\n")
    # Model main() on a CRLF checkout: orig is read newline="" so it
    # carries the raw CRLF text; the adaptation guard sees the LF
    # snippet ABSENT from orig and fires.
    misses = []
    for name, (old_snip, _new) in muts.items():
        probe_old = old_snip
        if "\n" in probe_old and probe_old not in crlf_text and "\r\n" in crlf_text:
            probe_old = probe_old.replace("\n", "\r\n")
        if probe_old not in crlf_text:
            misses.append(name)
    return {"all_adapted": not misses, "misses": misses,
            "registry_size": len(muts)}


def cmd_clear_durability(mod, payload):
    """g1s7-C2t-F1/F2/F3 probe (v2, DONE-marker semantics): the
    journal's lifecycle is ARMED (restorable) -> DONE (never
    restorable) -> removed-best-effort. A resurrection of ANY
    on-disk state must never clobber edits made after the fact."""
    tmp = payload["dir"]
    src = os.path.join(tmp, "intake.ts")
    mod.SRC = src
    saved_root = mod._JOURNAL_ROOT
    mod._JOURNAL_ROOT = os.path.join(tmp, "jroot")
    os.makedirs(mod._JOURNAL_ROOT, exist_ok=True)
    real_fsync_dir = mod._fsync_dir
    orig = "export const x = 1;\n"
    open(src, "w").write(orig)
    try:
        # (0) C2u-F2: a stale PID-named tmp (SIGKILLed sweep + PID
        #     reuse) must NOT poison future writes with EEXIST —
        #     _journal_write_body unlinks our-own-stale tmp, retries.
        stale_tmp = "%s.%d.tmp" % (mod._journal_path(), os.getpid())
        open(stale_tmp, "w").write("stale corpse of a SIGKILLed sweep\n")
        mod._journal_write(orig)
        f2a_write_survives_stale_tmp = (os.path.exists(mod._journal_path())
                                        and "FJ-DONE" not in open(mod._journal_path()).read())
        # post-restore branch with the stale tmp present: recovery's
        # OWN DONE-mark must hit the stale tmp (plant AFTER the arm,
        # else _journal_write consumes it and the claim is untested).
        mod._journal_write(orig)
        open(stale_tmp, "w").write("stale again\n")
        open(src, "w").write("export const x = 7; /* MUTANT */\n")
        f2b_rec = mod._journal_recover() is True
        f2b_done_not_armed = (not os.path.exists(mod._journal_path())
                              or open(mod._journal_path()).read().find("FJ-DONE") >= 0)
        # stale-tmp + edit-after-residual check: with the fix the
        # journal cannot remain ARMED here at all.
        open(src, "w").write("export const x = 123; /* user edit */\n")
        f2b_edit_safe = mod._journal_recover() is False and \
            open(src).read().find("123") >= 0

        # (0b) C2v-F1: a REAL SIGTERM delivered inside the masked
        #     completion must NOT strand an ARMED record over a
        #     completed restore — it stays pending, the DONE marker
        #     lands, and the exit happens after the transition.
        saved_term = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGTERM, mod._interrupt)
        real_mark = mod._journal_mark_done
        term_arrived_after_mark = []
        def marking_with_signal(_p=real_mark):
            os.kill(os.getpid(), signal.SIGTERM)  # blocked -> pending
            _p()
            term_arrived_after_mark.append(0)  # mark completed despite signal
        mod._journal_mark_done = marking_with_signal
        mod._journal_write(orig)
        sigexit = None
        try:
            mod._journal_clear()
        except SystemExit as e:
            sigexit = e.code
        finally:
            mod._journal_mark_done = real_mark
            signal.signal(signal.SIGTERM, saved_term)
        v1_mark_completed = bool(term_arrived_after_mark)
        v1_not_armed = True
        if os.path.exists(mod._journal_path()):
            v1_not_armed = "FJ-DONE" in open(mod._journal_path()).read()
        open(src, "w").write("export const x = 888; /* post-sigterm edit */\n")
        v1_edit_survives = (mod._journal_recover() is False
                            and open(src).read().find("888") >= 0)

        # (0d) C2w-F3: an UNEXPECTED exception escaping the masked
        #     completion (KeyboardInterrupt injected INTO the mark)
        #     must not leak the signal mask to the caller.
        def mask_blocks_term():
            try:
                blocked = signal.pthread_sigmask(signal.SIG_BLOCK, set())
            except (AttributeError, ValueError, OSError):
                return None  # platform without pthread_sigmask
            return (signal.SIGINT in blocked) or (signal.SIGTERM in blocked)
        def ki_marker():
            raise KeyboardInterrupt("injected during the DONE-mark")
        real_mark2 = mod._journal_mark_done
        mod._journal_mark_done = ki_marker
        w3_match_mask = w3_dirty_mask = w3_clear_mask = None
        try:
            mod._journal_write(orig)      # src == orig -> match shape
            try:
                mod._journal_recover()
                w3_match_escaped = False
            except KeyboardInterrupt:
                w3_match_escaped = True
            w3_match_mask = mask_blocks_term()
            # dirty branch: divergent src -> restore, mark raises KI
            mod._journal_write(orig)
            open(src, "w").write("export const x = 5; /* MUTANT */\n")
            try:
                mod._journal_recover()
                w3_dirty_escaped = False
            except KeyboardInterrupt:
                w3_dirty_escaped = True
            w3_dirty_mask = mask_blocks_term()
            # clear path: mark raises KI through _journal_clear
            mod._journal_write(orig)
            try:
                mod._journal_clear()
                w3_clear_escaped = False
            except KeyboardInterrupt:
                w3_clear_escaped = True
            w3_clear_mask = mask_blocks_term()
        finally:
            mod._journal_mark_done = real_mark2
        w3_ok = (w3_match_escaped and w3_dirty_escaped and w3_clear_escaped
                 and not (w3_match_mask if w3_match_mask is not None else False)
                 and not (w3_dirty_mask if w3_dirty_mask is not None else False)
                 and not (w3_clear_mask if w3_clear_mask is not None else False))

        # (0c) C2v-F1 backstop: the dirty restore PRESERVES the
        # divergent current bytes before overwriting them.
        mod._journal_write(orig)
        open(src, "w").write("export const x = 42; /* user work */\n")
        b_text = open(src).read()
        v1_recovered = mod._journal_recover() is True
        backups = [n for n in os.listdir(mod._JOURNAL_ROOT)
                   if ".pre-recover." in n]
        v1_backup_exists = len(backups) >= 1
        v1_backup_exact = v1_backup_exists and all(
            open(os.path.join(mod._JOURNAL_ROOT, n), "rb").read() == b_text.encode()
            for n in backups)
        v1_src_restored = open(src).read() == orig

        # (1) normal lifecycle: arm, then clear -> journal gone.
        mod._journal_write(orig)
        mod._journal_clear()
        normal_clears = not os.path.exists(mod._journal_path())

        # (2) C2t-F1 core: a RESURRECTED DONE marker with src since
        #     edited to B must NEVER restore — recover() removes the
        #     stale marker and leaves B untouched.
        mod._journal_write(orig)
        mod._journal_mark_done()
        open(src, "w").write("export const x = 999; /* post-sweep edit */\n")
        b_text = open(src).read()
        recovered = mod._journal_recover()
        stale_done_no_restore = (recovered is False)
        edit_survives = open(src).read() == b_text
        marker_gone = not os.path.exists(mod._journal_path())

        # (3) regression: ARMED journal + divergent (mutant) src ->
        #     restore, then the completion match-clears cleanly.
        mod._journal_write(orig)
        open(src, "w").write("export const x = 2; /* MUTANT */\n")
        dirty_recovered = mod._journal_recover() is True
        dirty_src_restored = open(src).read() == orig

        # (4) C2t-F2: DONE-mark failure (EIO) in the DIRTY branch —
        #     recovery still completes (restore durable), residual
        #     ARMED body == src -> next recover match-clears.
        mod._journal_write(orig)
        open(src, "w").write("export const x = 3; /* MUTANT */\n")
        def eio(_p):
            raise OSError(5, "injected EIO")
        mod._fsync_dir = eio
        try:
            f2_recovered = mod._journal_recover() is True
        finally:
            mod._fsync_dir = real_fsync_dir
        f2_src_restored = open(src).read() == orig
        f2_journal_still = os.path.exists(mod._journal_path())
        f2_next_matchclears = (mod._journal_recover() is False
                               and open(src).read() == orig)

        # (5) C2t-F2: DONE-mark failure in the MATCH branch -> refuse
        #     (authoritative record cannot be closed), journal kept,
        #     src untouched; a later healthy recover match-clears.
        mod._journal_write(orig)           # src == orig -> match shape
        refused = False
        mod._fsync_dir = eio
        try:
            try:
                mod._journal_recover()
            except mod.JournalRecoverFailed:
                refused = True
        finally:
            mod._fsync_dir = real_fsync_dir
        f2b_src_intact = open(src).read() == orig
        f2b_journal_kept = os.path.exists(mod._journal_path())
        f2b_healthy_clears = (mod._journal_recover() is False)

        # (6) C2t-F3: clear()'s mark interrupted by SIGTERM-shaped
        #     SystemExit must NOT leave an unproven-deletion hole:
        #     no replace happened, so the ARMED journal (body == the
        #     verified-pristine src) remains -> match-clear safe.
        mod._journal_write(orig)
        def boom(_p):
            raise SystemExit(143)
        mod._fsync_dir = boom
        exit_propagated = False
        try:
            mod._journal_clear()
        except SystemExit:
            exit_propagated = True
        finally:
            mod._fsync_dir = real_fsync_dir
        f3_journal_state_safe = mod._journal_recover() is False
        f3_src_intact = open(src).read() == orig

        # (7) C2u-F1: the hook's except branch is reached ONLY by a
        #     failed verification RE-READ (clear() is OSError-total).
        #     It must complete via the DONE marker — never write an
        #     ARMED record, which a later sweep could restore over
        #     post-sweep edits.
        mod._journal_write(orig)
        saved_lock = mod._JOURNAL_LOCK_FD
        mod._JOURNAL_LOCK_FD = object()
        saved_restore = mod._SRC_RESTORE["orig"], mod._SRC_RESTORE["path"]
        mod._SRC_RESTORE["orig"] = orig
        mod._SRC_RESTORE["path"] = src
        mod._RESTORE_FAILED = False
        saved_suspect = mod._DIST_STILL_SUSPECT
        mod._DIST_STILL_SUSPECT = False
        import builtins as _bi
        real_open2 = _bi.open
        verify_hits = []
        def no_read(_p, _mode=None, **kw):
            # ONLY the mode-less verification read on OUR src; every
            # other open (incl. mode-less journal writes) passes.
            if _mode is None and _p == src:
                verify_hits.append(1)
                raise OSError(5, "injected verify-read EIO")
            if _mode is None:
                return real_open2(_p, **kw)
            return real_open2(_p, _mode, **kw)
        _bi.open = no_read
        try:
            mod._journal_clear_hook()
        finally:
            _bi.open = real_open2
        f1_verify_was_hit = len(verify_hits) > 0
        f1_not_armed = True
        if os.path.exists(mod._journal_path()):
            body0 = open(mod._journal_path()).read()
            f1_not_armed = "FJ-DONE" in body0  # only a DONE residue is legal
        # and a user edit after the hook is NEVER restored over:
        open(src, "w").write("export const x = 555; /* post-hook edit */\n")
        f1_edit_survives = (mod._journal_recover() is False
                            and open(src).read().find("555") >= 0)
        # normal hook path still completes (arm then hook clears).
        open(src, "w").write(orig)  # f1 section left src edited
        mod._journal_write(orig)
        mod._journal_clear_hook()
        hook_normal_clears = not os.path.exists(mod._journal_path())
        mod._JOURNAL_LOCK_FD = saved_lock
        mod._SRC_RESTORE["orig"], mod._SRC_RESTORE["path"] = saved_restore
        mod._DIST_STILL_SUSPECT = saved_suspect
        return {"normal_clear_still_works": normal_clears,
                "sigterm_in_completion_not_armed": (
                    sigexit is not None and v1_mark_completed and v1_not_armed),
                "sigterm_edit_survives": v1_edit_survives,
                "ki_escape_restores_signal_mask": w3_ok,
                "divergent_bytes_preserved_on_restore": (
                    v1_recovered and v1_backup_exists and v1_backup_exact
                    and v1_src_restored),
                "stale_tmp_write_survives": f2a_write_survives_stale_tmp,
                "stale_tmp_dirty_recover": f2b_rec,
                "stale_tmp_done_not_armed": f2b_done_not_armed,
                "stale_tmp_edit_safe": f2b_edit_safe,
                "verify_read_fail_completes_done": f1_not_armed and f1_verify_was_hit,
                "verify_read_fail_edit_survives": f1_edit_survives,
                "stale_done_never_restores": stale_done_no_restore,
                "post_edit_survives_resurrection": edit_survives,
                "stale_marker_removed": marker_gone,
                "armed_dirty_recovers": dirty_recovered,
                "dirty_src_restored": dirty_src_restored,
                "dirty_branch_eio_recovers_anyway": f2_recovered,
                "dirty_branch_eio_src_restored": f2_src_restored,
                "dirty_branch_eio_journal_remains": f2_journal_still,
                "dirty_branch_eio_next_matchclears": f2_next_matchclears,
                "match_branch_eio_refuses": refused,
                "match_branch_eio_src_intact": f2b_src_intact,
                "match_branch_eio_journal_kept": f2b_journal_kept,
                "match_branch_healthy_clears": f2b_healthy_clears,
                "sigterm_during_mark_propagates": exit_propagated,
                "sigterm_state_matchclear_safe": f3_journal_state_safe,
                "sigterm_src_intact": f3_src_intact,
                "hook_normal_clear_works": hook_normal_clears}
    finally:
        mod._fsync_dir = real_fsync_dir
        mod._JOURNAL_ROOT = saved_root


def main():
    cmd = sys.argv[1]
    payload = json.loads(sys.stdin.read() or "{}")
    mod = load_sweep()
    fn = {"baseline": cmd_baseline, "sweep": cmd_sweep, "iso": cmd_iso,
          "hang": cmd_hang, "registry": cmd_registry, "journal": cmd_journal,
          "journal_pathkey": cmd_journal_pathkey,
          "journal_import": cmd_journal_import,
          "journal_import_recheck": cmd_journal_import_recheck,
          "journal_lock": cmd_journal_lock,
          "kill_on_unwind": cmd_kill_on_unwind,
          "descendant_kill": cmd_descendant_kill,
          "fsync_semantics": cmd_fsync_semantics,
          "restore_hook": cmd_restore_hook_durability,
          "destroy_print_abort": cmd_destroy_print_abort,
          "crlf_roundtrip": cmd_crlf_roundtrip,
          "crlf_registry": cmd_crlf_registry,
          "clear_durability": cmd_clear_durability,
          "build_kill_on_unwind": cmd_build_kill_on_unwind,
          "spawnmask": cmd_spawnmask,
          }[cmd]
    buf = io.StringIO()
    with redirect_stdout(buf):  # module prints nothing expected; stay clean
        result = fn(mod, payload)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
