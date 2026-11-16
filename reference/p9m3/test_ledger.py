"""Fixture suite F1-F77 (+ the C6_* v38-cycle-6 audit pins) for the
P9/M3 reference implementation — coverage BY FIXTURE FAMILY, not one
test per label: F14 pinned inside test_F9_F14, F15's behavior pinned
by test_F6 (duplicate spec row), V33 rows F23/F25 share numbers with
different v38 fixtures; the V33 activation/prefix semantics are
pinned by test_F23v33_*/test_F25v33_* (D4-scopeA cycle-5 fold,
mutation-checked) (mapping detail in the ledger module header,
D4A-c5-3)
(spec docs/21-p9-m3-promotion-rollback-fleet-budget.md DRAFT v42,
V33 FIXTURE TABLE with v36/v37 additions + v38 audit fixtures F23-F27,
v38 cycle-1/cycle-2 pins F28-F33, the v40-v42 audit pins F35-F57
(F55/F56 mint freshness & ULID conformance, F57 cap-refusal preflight,
F19 forced-order rewrite + R5-c1 contention-handshake/one-frame-fits/
sidecar-untouched pins), and F58/F59 — the S-J3-C clamped-clock label
and the exact-cap reserve boundary; F60-F64 the AUD46 cycle pins,
F65-F67 the AUD47 cycle-1 pins (completion-failure owed re-arm, the
decision-gate owed overlay clause, the sidecar width-heal); F72-F77
the AUD48 cycle-1/2 pins (operator-reset sole-evidence refusal,
zero-first completion surviving the combined corrupt-clear +
zero fault, the evidence-based reset guard under sticky exhaustion,
the ambiguous unreadable-witness refusal, the in-fd owed repair on
a faulting clear fsync);
expected results normative).
(D4A-c1 finding 2: this header formerly stopped at F57.)

Run: cd reference && python3 -m unittest p9m3.test_ledger -v
"""
from __future__ import annotations

import errno
import hashlib
import json
import multiprocessing
import os
import shutil
import signal
import tempfile
import time
import unittest

from p9m3.ledger import (
    AUTH_FILE_MALFORMED,
    AUTH_INVENTORY_CAP,
    LOG_CAP,
    Ledger,
    LedgerError,
    STATE_CONFLICT,
    STATE_EXHAUSTED,
    STATE_OK,
    STATE_PENDING,
    STATE_UNMASKED,
    STATE_UNKNOWN,
    STATE_UNSETTLED,
)
from p9m3.probe import FSProbeError, FsFaults, run_probe


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


CORRUPT = b"{corrupted-not-json"


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="p9m3-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def mk(self, faults=None, **kw):
        return Ledger(self.dir, faults=faults or FsFaults(), **kw)

    def raw(self, led=None):
        p = os.path.join((led or self.led).dir if led or hasattr(self, "led")
                         else self.dir, "consumptions.jsonl")
        try:
            with open(p, "rb") as f:
                return f.read()
        except FileNotFoundError:
            return b""

    def seed(self, content, path="consumptions.jsonl"):
        p = os.path.join(self.dir, path)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, content)
            os.fsync(fd)
        finally:
            os.close(fd)

    def seed_at(self, items):
        """Place raw line payloads (no newline) at exact byte offsets,
        separated by blank filler lines. Offset 0 needs no filler."""
        out = bytearray()
        pos = 0
        for off, payload in items:
            if off < pos:
                raise AssertionError("offset collision")
            if off == pos:
                out += payload + b"\n"
            else:
                out += b" " * (off - pos - 1) + b"\n"
                out += payload + b"\n"
            pos = off + len(payload) + 1
        self.seed(bytes(out))

    def occ(self, offset, payload):
        return {"offset": offset, "hash": sha(payload)}


class TestFixtures(Base):
    # ------------------------------------------------------------------ F1
    def test_F1_occurrence_list_change_refuses_stale_auth(self):
        line100 = CORRUPT + b"#1"
        self.seed_at([(100, line100)])
        self.led = self.mk()
        auth = self.led.authorize([self.occ(100, line100)], auth_id="A1", test_only=True)
        # identical malformed bytes appended at a NEW offset (900)
        pad = b" " * (900 - 101 - len(line100)) + b"\n"
        self.seed(pad + line100 + b"\n")
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth)
        self.assertEqual(cm.exception.code, "authorization-stale")
        cls = self.led.classify()
        self.assertEqual(cls["state"], STATE_UNMASKED)
        masked = {(e["offset"], e["hash"])
                  for r in cls["valid_repairs"] for e in r["masks"]}
        self.assertNotIn((900, sha(line100)), masked)  # never masked
        self.assertNotIn(auth, cls["spent"])

    # ------------------------------------------------------------------ F2
    def test_F2_effective_all_inerts_old_confirmation(self):
        corrupt = CORRUPT + b"-landing-G1-X-L50"
        self.seed_at([(100, corrupt)])
        self.led = self.mk()
        self.led.seed_confirmation_log(b'{"confirmGen":"GEN1"}' + b" " * 178 + b"\n")  # exactly 200 bytes
        auth = self.led.authorize([self.occ(100, corrupt)], auth_id="A1", test_only=True)
        res = self.led.repair(auth)
        self.assertEqual(res["outcome"], "repaired")
        cls = self.led.classify()
        self.assertEqual(cls["effective_all"], 200)
        self.assertFalse(self.led.confirmation_clears(40))   # old conf inert
        self.assertTrue(self.led.confirmation_clears(260))   # new conf clears

    # ------------------------------------------------------------------ F3
    def test_F3_confirmation_landed_between_LC_read_and_append(self):
        # CONTRACT F3 ROW (v41 R4-c1 rewrite): the confirmation must
        # land INSIDE the window between repair()'s L_C read and the
        # REPAIR append — the old test appended AFTER repair()
        # returned, which never tested the race (inline audit cycle 1
        # finding 2). Now the in-repair hook `_test_hook_after_lc_read`
        # (fires after the L_C read, before any ledger byte) lands the
        # confirmation mid-window; the REPAIR must carry the L_C it
        # READ (200), not the grown length, and the late-landed
        # confirmation stays ACTIVE (clears).
        corrupt = CORRUPT + b"-f3"
        self.seed_at([(50, corrupt)])
        self.led = self.mk()
        self.led.seed_confirmation_log(b"c" * 199 + b"\n")   # exactly 200 B
        auth = self.led.authorize([self.occ(50, corrupt)], auth_id="A1", test_only=True)
        landed = []
        def _land():
            # we are INSIDE repair()'s lock, after its L_C read
            self.led.seed_confirmation_log(b"d" * 9 + b"\n")   # lands at 200..209
            landed.append(self.led.confirmation_length())
        self.led._test_hook_after_lc_read = _land
        res = self.led.repair(auth)
        self.assertEqual(res["outcome"], "repaired")
        self.assertEqual(landed, [210], "hook did not run inside the window")
        rec = json.loads(self.raw().rsplit(b"\n", 2)[-2])
        self.assertEqual(rec["t"], "REPAIR")
        self.assertEqual(rec["all"]["watermark"], 200,
                         "REPAIR watermark must be the L_C READ, not the "
                         "grown length (race not tested without the hook)")
        self.assertTrue(self.led.confirmation_clears(210))  # ACTIVE, clears
        # R4-c2-2: the START offset of the late-landed confirmation must
        # clear too — a threshold shifted to the grown length (e.g. the
        # REPAIR watermarking 210 and suppressing inside its own
        # generation) would clear 210 but WRONGLY SUPPRESS 200.
        self.assertTrue(self.led.confirmation_clears(200),
                        "confirmation start offset must be ACTIVE")
        self.assertFalse(self.led.confirmation_clears(199),
                         "pre-existing region stays inert under gen0 ALL")

    # ------------------------------------------------------------------ F4
    def test_F4_repair_killed_torn_settlement_new_auth(self):
        orig = CORRUPT + b"-original"
        self.seed_at([(0, orig)])
        torn = b'{"t":"REPAIR","authId":"A1","masks":['  # first 30 bytes
        self.seed(torn[:30])                 # post-repair torn state
        self.led = self.mk()
        # torn tail => unsettled; settle makes it one malformed occurrence
        cls = self.led.settle()
        self.assertEqual(cls["state"], STATE_UNMASKED)
        self.assertEqual(len(cls["unmasked"]), 2)
        auth1 = "A1"
        # AUTH1 (covering only the original occurrence) stays unspent + stale
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth1)
        self.assertEqual(cm.exception.code, "authorization-stale")
        self.assertNotIn(auth1, self.led.classify()["spent"])
        # NEW AUTH2 over both occurrences succeeds
        occs = [{"offset": o["offset"], "hash": o["hash"]}
                for o in self.led.classify()["unmasked"]]
        auth2 = self.led.authorize(occs, auth_id="A2", test_only=True)
        self.assertEqual(self.led.repair(auth2)["outcome"], "repaired")
        self.assertEqual(self.led.classify()["state"], STATE_OK)

    # ------------------------------------------------------------------ F5
    def test_F5_partial_write_then_eio_is_unsettled_not_failed(self):
        orig = CORRUPT + b"-orig5"
        self.seed_at([(0, orig)])
        self.led = self.mk()
        self.led.authorize([self.occ(0, orig)], auth_id="A1", test_only=True)
        self.led.faults.partial_write = 10   # 10 of ~300 bytes then EIO
        with self.assertRaises(OSError):
            self.led.repair("A1")
        cls = self.led.classify()
        self.assertEqual(cls["state"], STATE_UNSETTLED)  # NOT failed
        self.assertNotIn("A1", cls["spent"])
        # settlement, then a NEW AUTH; AUTH1 stays unspent and stale
        self.led.settle()
        self.led.faults.partial_write = None
        with self.assertRaises(LedgerError) as cm:
            self.led.repair("A1")
        self.assertEqual(cm.exception.code, "authorization-stale")
        occs = [{"offset": o["offset"], "hash": o["hash"]}
                for o in self.led.classify()["unmasked"]]
        auth2 = self.led.authorize(occs)
        self.assertEqual(self.led.repair(auth2)["outcome"], "repaired")

    # ------------------------------------------------------------------ F6
    def test_F6_durable_repair_reread_fails_outcome_unknown(self):
        bad = CORRUPT + b"-f6"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        auth = self.led.authorize([self.occ(0, bad)])
        self.led.faults.reread_fails = True
        res = self.led.repair(auth)
        self.assertEqual(res["outcome"], "outcome-unknown")
        self.led.faults.reread_fails = False
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth)            # no second REPAIR
        self.assertEqual(cm.exception.code, "authorization-spent")
        self.assertIn(auth, self.led.classify()["spent"])  # VALID => spent

    # ------------------------------------------------------------------ F7
    def test_F7_same_gen_unequal_watermarks_max_no_conflict(self):
        bad = CORRUPT + b"-f7"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        # v40 R3c1: the header must PARSE (v39 R2-B2 compares
        # confirmGen against the CURRENT generation header on every
        # read; an unparseable header reads GEN0 and the GEN1 REPAIRs
        # would be DEAD). 21 B header + 279 B pad + \n = 301 B.
        self.led.seed_confirmation_log(
            b'{"confirmGen":"GEN1"}' + b" " * 279 + b"\n")
        occs = [self.occ(0, bad)]
        auth = self.led.authorize(occs, auth_id="A1", test_only=True)
        d = self.led._frame('{"t":"REPAIR","authId":"A1","masks":%s,"all":{"hostToken":"ALL","watermark":200,"confirmGen":"GEN1"}}' % _j(occs))
        d2 = self.led._frame('{"t":"REPAIR","authId":"A1","masks":%s,"all":{"hostToken":"ALL","watermark":220,"confirmGen":"GEN1"}}' % _j(occs))
        self.seed(d + d2)
        cls = self.led.classify()
        self.assertEqual(cls["state"], STATE_OK)
        self.assertEqual(cls["effective_all"], 220)
        self.assertEqual(len(cls["dead_repairs"]), 0)

    def test_F7b_unequal_confirmgen_repair_conflict(self):
        # v40 R3c1 OUTCOME SUPERSEDED (v39 R2-B2): with the generation
        # clause, a REPAIR whose confirmGen != the CURRENT header is
        # DEAD (mask-mismatch), NOT a conflict party — the stage-4
        # unequal-confirmGen branch is UNREACHABLE for conforming
        # writes and kept only defensively. The old expectation
        # ('repair-conflict' when the header is GEN1) was tested
        # against a log whose header did not parse; under R2-B2 the
        # GEN2 record masks nothing and the GEN1 record (matching the
        # header) classifies VALID alone.
        bad = CORRUPT + b"-f7b"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        self.led.seed_confirmation_log(
            b'{"confirmGen":"GEN1"}' + b" " * 279 + b"\n")
        occs = [self.occ(0, bad)]
        self.led.authorize(occs, auth_id="A1", test_only=True)
        d = self.led._frame('{"t":"REPAIR","authId":"A1","masks":%s,"all":{"hostToken":"ALL","watermark":200,"confirmGen":"GEN1"}}' % _j(occs))
        d2 = self.led._frame('{"t":"REPAIR","authId":"A1","masks":%s,"all":{"hostToken":"ALL","watermark":200,"confirmGen":"GEN2"}}' % _j(occs))
        self.seed(d + d2)
        cls = self.led.classify()
        self.assertNotEqual(cls["state"], STATE_CONFLICT)  # defensive branch unreachable
        self.assertEqual(cls["state"], STATE_OK)
        self.assertEqual(len(cls["dead_repairs"]), 1)
        self.assertEqual(cls["dead_repairs"][0]["reason"], "mask-mismatch")
        self.assertEqual(cls["effective_all"], 200)
        self.assertFalse(any(r["all"]["confirmGen"] == "GEN2"
                             for r in cls["valid_repairs"]))

    # ------------------------------------------------------------------ F8
    def test_F8_repair_too_large_no_truncation(self):
        payload = b"".join(b"!bad%02d!" % i + b"z" * 60 + b"\n"
                           for i in range(60))
        self.seed(payload)
        self.led = self.mk()
        before = self.raw()
        occs = [{"offset": o["offset"], "hash": o["hash"]}
                for o in self.led.classify()["unmasked"]]
        self.assertEqual(len(occs), 60)
        auth = self.led.authorize(occs)
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth)
        self.assertEqual(cm.exception.code, "repair-too-large")
        self.assertEqual(self.raw(), before)  # no truncation attempted
        self.assertEqual(self.led.classify()["state"], STATE_UNMASKED)

    # --------------------------------------------------------------- F9/F14
    def test_F9_F14_torn_auth_tail_fails_closed(self):
        bad = CORRUPT + b"-f9"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        self.led.authorize([self.occ(0, bad)], auth_id="A1", test_only=True)
        self.seed(b'{"t":"AUTH","authId":"A2","occurrenc', path="authorizations.jsonl")
        self.led = self.mk()  # successor view
        self.assertTrue(self.led.classify()["authorization_file_malformed"])
        self.assertFalse(self.led.promotion_allowed())
        with self.assertRaises(LedgerError) as cm:
            self.led.repair("A1")           # every authorization fails closed
        self.assertEqual(cm.exception.code, AUTH_FILE_MALFORMED)
        with self.assertRaises(LedgerError) as cm:
            self.led.authorize()
        self.assertEqual(cm.exception.code, AUTH_FILE_MALFORMED)

    # ---------------------------------------------------------------- F10
    def test_F10_static_no_destructive_calls_in_live_protocol(self):
        import re
        with open(os.path.join(os.path.dirname(__file__), "ledger.py")) as _f:
            src = _f.read()
        # AUD47-c1 (audit cycle 1, major 2): ONE narrow, audited
        # exception — `_sidecar_fix_width` re-establishes a sidecar's
        # DECLARED fixed width (a corrupted over-long record must not
        # wedge a field fail-closed past every healthy rewrite). The
        # shrink is to a constant width inside that helper only; the
        # rest of the source is scanned with the full forbidden set
        # and the exception is pinned to its single site.
        heal = re.search(r"    @staticmethod\n    def _sidecar_fix_width"
                         r"\(fd, width\):.*?(?=\n    def )", src, re.S)
        self.assertIsNotNone(heal, "_sidecar_fix_width must exist")
        self.assertEqual(heal.group(0).count("ftruncate"), 1,
                         "exactly one ftruncate in the width-heal helper")
        self.assertEqual(len(re.findall(r"os\.ftruncate\s*\(", src)), 1,
                         "the width-heal helper is the SOLE ftruncate call")
        src = src.replace(heal.group(0), "def _sidecar_fix_width(): ...")
        for pat in (r"os\.rename\s*\(", r"os\.truncate\s*\(",
                    r"os\.ftruncate\s*\(", r"os\.replace\s*\(",
                    r"os\.remove\s*\(", r"\.unlink\s*\(",
                    r"O_TRUNC", r"shutil\.(rmtree|move|copyfile)"):
            self.assertIsNone(re.search(pat, src),
                              "forbidden call in live protocol: %s" % pat)

    # ---------------------------------------------------------------- F11
    def test_F11_oversize_log_unknown_defensive(self):
        big = b"x" * LOG_CAP + b"\n"          # 64 MiB + 1 byte
        self.seed(big)
        self.led = self.mk()
        self.assertEqual(self.led.classify()["state"], STATE_UNKNOWN)
        self.assertFalse(self.led.promotion_allowed())

    # ---------------------------------------------------------------- F12
    def test_F12_fully_masked_status_render(self):
        lines = [CORRUPT + b"-a", CORRUPT + b"-b"]
        self.seed(b"".join(l + b"\n" for l in lines))
        self.led = self.mk()
        occs = [{"offset": o["offset"], "hash": o["hash"]}
                for o in self.led.classify()["unmasked"]]
        auth = self.led.authorize(occs, auth_id="AUTHX", test_only=True)
        self.led.repair(auth)
        st = self.led.status()
        self.assertEqual(st["decision"], STATE_OK)
        self.assertIn("repaired (overlay active: 2 lines masked by "
                      "REPAIR{AUTHX})", st["renders"])

    # ---------------------------------------------------------------- F13
    def test_F13_dead_repair_masking_valid_watermark(self):
        wm = (b'{"t":"WATERMARK","hostToken":"H1","watermark":7,'
              b'"confirmGen":"G1"}')
        bad = CORRUPT + b"-f13"
        self.seed_at([(0, wm), (len(wm) + 2, bad)])
        wm_offset, bad_offset = 1, len(wm) + 2
        # REPAIR masks the VALID watermark's offset instead of the bad line
        masks = [{"offset": wm_offset, "hash": sha(wm)}]
        self.led = self.mk()
        # A9 exists as a valid AUTH, but its occurrence list differs from
        # the REPAIR's masks => DEAD reason must be mask-mismatch (not
        # unknown-authId).
        self.led.authorize([self.occ(bad_offset, bad)], auth_id="A9", test_only=True)
        self.seed(self.led_frame(
            '{"t":"REPAIR","authId":"A9","masks":%s,"all":{"hostToken":"ALL",'
            '"watermark":0,"confirmGen":"G0"}}' % _j(masks)))
        self.led = self.mk()
        cls = self.led.classify()
        self.assertEqual(cls["state"], STATE_UNMASKED)
        self.assertEqual(len(cls["dead_repairs"]), 1)
        self.assertEqual(cls["dead_repairs"][0]["reason"], "mask-mismatch")
        self.assertEqual(cls["dead_repairs"][0]["offset"],
                         len(wm) + 2 + len(bad) + 2)  # the REPAIR line
                         # (+1 bad's terminator; the frame's leading \n is
                         #  a blank line, which framing ignores)
        self.assertNotIn((bad_offset, sha(bad)),
                         {(e["offset"], e["hash"])
                          for r in cls["valid_repairs"] for e in r["masks"]})
        st = self.led.status()
        self.assertEqual(len(st["dead_repairs"]), 1)

    def led_frame(self, js):
        return self.Led_frame(js)

    def Led_frame(self, js):
        return b"\n" + js.encode() + b"\n"

    # ---------------------------------------------------------------- F16
    def test_F16_authorize_refuses_schema_valid_line_dead_repair_ok(self):
        r2 = ('{"t":"REPAIR","authId":"NOPE","masks":[],"all":{"hostToken":'
              '"ALL","watermark":0,"confirmGen":"G0"}}').encode()
        self.seed(b"\n" + r2 + b"\n")
        self.led = self.mk()
        r2_offset = 1
        with self.assertRaises(LedgerError) as cm:
            self.led.authorize([self.occ(r2_offset, r2)])
        self.assertEqual(cm.exception.code, "auth-entry-not-malformed")
        cls = self.led.classify()
        self.assertEqual(cls["state"], STATE_OK)   # R2 masks nothing, is no occurrence
        self.assertEqual(len(cls["dead_repairs"]), 1)
        self.assertEqual(cls["dead_repairs"][0]["reason"], "unknown-authId")
        st = self.led.status()
        self.assertEqual(len(st["dead_repairs"]), 1)

    # ---------------------------------------------------------------- F17
    def test_F17_cap_refuses_before_write_auth_unspent(self):
        bad = CORRUPT + b"-f17"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        auth = self.led.authorize([self.occ(0, bad)])
        before = self.raw()
        self.led.faults.size_override = LOG_CAP - 100  # pretend near-cap
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth)
        self.assertEqual(cm.exception.code, "log-cap-exceeded")
        self.assertEqual(self.raw(), before)         # ZERO bytes
        self.assertNotIn(auth, self.led.classify()["spent"])
        self.assertEqual(self.led.classify()["state"], STATE_UNMASKED)

    # ---------------------------------------------------------------- F18
    def test_F18_settle_fsync_eio_durability_pending_until_resolve(self):
        applied = b'{"t":"APPLIED","authId":"X1"}'
        self.seed(b"\n" + applied)                   # unsettled tail, VALID after \n
        self.led = self.mk()
        self.led.faults.fsync_fault = True
        with self.assertRaises(LedgerError) as cm:
            self.led.settle()                        # \n written, fsync EIO
        self.assertEqual(cm.exception.code, STATE_PENDING)
        self.assertTrue(self.led.durability_pending())
        successor = self.mk()                        # process exits; next holder
        cls = successor.classify()
        self.assertIn("X1", cls["spent"])            # sees settled VALID record
        st = successor.status()
        self.assertEqual(cls["state"], STATE_OK)     # classification itself...
        self.assertEqual(st["decision"], STATE_PENDING)  # ...decision REFUSES
        successor.faults.fsync_fault = False
        cls2 = successor.resolve()                   # fsync file+dir+read
        self.assertEqual(cls2["state"], STATE_OK)
        self.assertTrue(successor.promotion_allowed())

    # ------------------------------------------------- F18z (v40, R3-c2 R3-2-2)
    def test_F18z_settle_zero_write_is_no_progress_not_durable(self):
        # R3-2-2: the settlement byte is a WRITE under the checked-write
        # rule. A zero-returning settlement write must raise, leave the
        # tail UNTERMINATED (no false durable settlement), and keep the
        # decision durability-pending until resolve.
        applied = b'{"t":"APPLIED","authId":"Z1"}'
        self.seed(b"\n" + applied)                   # unsettled tail
        self.led = self.mk()
        before = os.path.getsize(os.path.join(self.dir, "consumptions.jsonl"))
        self.led.faults.settle_write_zero = True
        with self.assertRaises(LedgerError) as cm:
            self.led.settle()
        self.assertEqual(cm.exception.code, STATE_PENDING)
        after = os.path.getsize(os.path.join(self.dir, "consumptions.jsonl"))
        self.assertEqual(after, before, "settlement byte landed on zero write")
        self.assertTrue(self.led.durability_pending())
        self.assertEqual(self.led.classify()["state"], STATE_UNSETTLED)
        self.assertFalse(self.led.promotion_allowed())
        # recovery: resolve clears the durability window (no byte landed
        # => the intent resolves to absent), but the tail is STILL
        # unsettled — the service re-attempts the settlement, which now
        # succeeds.
        self.led.faults.settle_write_zero = False
        self.led.resolve()
        self.assertFalse(self.led.durability_pending())
        self.assertEqual(self.led.classify()["state"], STATE_UNSETTLED)
        self.led.settle()
        self.assertTrue(self.led.promotion_allowed())

    def test_F18z2_settle_in_lock_zero_write_zero_bytes(self):
        # Same rule for the in-lock settlement entry point: a zero
        # return raises and appends NOTHING; the raw OSError propagates
        # (the caller's lock acquisition spans the steps).
        applied = b'{"t":"APPLIED","authId":"Z2"}'
        self.seed(b"\n" + applied)
        led = self.mk()
        before = os.path.getsize(os.path.join(self.dir, "consumptions.jsonl"))
        led.faults.settle_write_zero = True
        with led._lock("append"):
            with self.assertRaises(OSError):
                led.settle_in_lock()
        after = os.path.getsize(os.path.join(self.dir, "consumptions.jsonl"))
        self.assertEqual(after, before, "settle_in_lock wrote on zero return")
        led.faults.settle_write_zero = False
        with led._lock("append"):
            cls = led.settle_in_lock()
        self.assertEqual(cls["state"], STATE_OK)

    # ---------------------------------------------------------------- F19
    def test_F19_concurrent_cap_crossing_serialized_zero_bytes(self):
        # CONTRACT F19 ROW (v42 R5-AUDIT REWRITE of the v41 R4-c1
        # rewrite, inline-audit findings 1+2). The R4 version
        #  (i) did NOT prove serialization: its start-pistol left the
        #      actual order to kernel wake-up, so the non-crossing
        #      offsets also passed under a purely sequential schedule
        #      and proved nothing about the loser OBSERVING the
        #      winner's bytes;
        # (ii) its crossing case used size == cap with 4-byte frames,
        #      not the row's stated geometry (ledger at cap - 24 B,
        #      frames whose size CROSSES the cap);
        # (iii) blocking recv()s ran BEFORE the timed join(), so a
        #      child that died or hung before reporting could hang the
        #      suite, and exitcode None ("still alive") was accepted.
        # v42 PROVES the row instead of sampling it:
        #  (a) ROW GEOMETRY: ledger at cap - 24 B, two processes with
        #      32-byte frames — every frame crosses. The result is
        #      ORDER-INDEPENDENT BY CONSTRUCTION: a refusal writes
        #      zero bytes, so the second racer sees exactly the state
        #      the first saw — each order => both `log-cap-exceeded`,
        #      ZERO bytes.
        #  (b) BOTH SERIAL ORDERS FORCED via the v42
        #      `_test_hook_after_reserve` seam: the FIRST child parks
        #      INSIDE its reservation (lock held, after the reserve
        #      check, before any byte); the SECOND starts and BLOCKS
        #      on the flock — proven by the R5-c1 `_test_hook_lock_miss`
        #      seam (the rival signals the first time flock() MISSES;
        #      finding 1: never a sleep — a non-exclusive lock trips
        #      the guard instead of passing). The parent releases the
        #      FIRST, so the loser's reserve check happens STRICTLY
        #      after the winner's write — in either ROLE order:
        #      distinctly tagged 12-byte frames show WHO wrote WHERE;
        #      admitted offsets are exactly {cap-24, cap-12} and the
        #      loser's frame sits at winner + 12 — its reserve check
        #      OBSERVED the winner's bytes.
        # (b2) PER-FRAME-LENGTH BOUNDARY GEOMETRY (R5-c1 f2 + R5-c2 f1
        #      + R5-c3 f1 + R5-c4 f1): FOR EVERY framed length F the
        #      fixture appends, one pair with remaining R == F EXACTLY
        #      (must fit) and one with R == F - 1 (must refuse), in
        #      both lead roles — the comparison operand is pinned at
        #      its boundary per F, so any constant delta or size shift
        #      mis-verdicts some pair. Every refusal also reports the
        #      predicate's OWN (size, framed) — the same locals the
        #      comparison consumed (ledger.py pins it) — so
        #      reported-vs-compared divergence fails. Bounded evidence
        #      for these sizes/roles/orders (R5-c4): the loser's
        #      reserve check is SHOWN to observe the winner's bytes at
        #      these boundaries, not proven against every conceivable
        #      implementation.
        # SIDE CAR PIN (R5-c1 finding 3): fresh dirs have NO pending
        #      sidecar; every cap refusal (cases a and b2) leaves it
        #      UNTOUCHED with no durability window — an intent written
        #      before the cap check would stamp a stale P marker here.
        #  (c) contention refusal stays pinned: external flock holder,
        #      bounded attempts => `ledger-lock-held`, zero bytes;
        #      after release the append is admitted.
        # Hang-safety (finding 2): EVERY interprocess receive is
        # poll(timeout)-guarded; a child that has not exited is
        # terminated; child exit status is asserted 0 — a child
        # failure FAILS the test fast and can never hang the suite.
        ctx = multiprocessing.get_context("fork")
        TO = 30.0

        def recv_or_fail(pipe, why, timeout=TO):
            if not pipe.poll(timeout):
                self.fail("F19 hang guard: %s (no data within %ds)"
                          % (why, timeout))
            return pipe.recv()

        def quiet_reap(*procs):
            for p in procs:                      # early-abort cleanup
                if p is not None and p.is_alive():
                    p.terminate()
                    p.join(5)

        def spawn(workdir, framed, wait_r=None, parks=None, attempts=200,
                  miss_w=None):
            """One racer. wait_r: pipe waited on BEFORE the lock (the
            start pistol). parks: (inside_w, go_r) wired into the
            reserve seam. miss_w: wired into the v42 R5-c1
            `_test_hook_lock_miss` seam — the child signals the FIRST
            time flock() MISSES, so the parent learns the rival
            DEMONSTRABLY hit the busy lock (finding 1: never trust a
            sleep for 'the rival reached the lock'). The parent
            closes its copies of the child-side ends right after
            start (finding 2: no leaked endpoints; the suite runs
            with -W error::ResourceWarning).
            Returns (proc, result_r); results are ("wrote", offset) or
            ("refused", code)."""
            res_r, res_w = ctx.Pipe(duplex=False)

            def racer():
                # F19 FLAKE FIX (root-caused 2026-07-27): the FS probe
                # is a ONCE-PER-DIRECTORY contract (probe.py docstring),
                # and leg 4's census check carries a baseline/census
                # RACE against a concurrent sibling probe: names created
                # by the rival after our baseline (still visible at the
                # post-rename census) read as "rename left a second
                # visible name" — overlap makes false refusal the common
                # outcome (observed run: 8x400 concurrent run_probe on
                # one dir = 3168/3200 leg4 fails; serial = 0/3000; not
                # every overlap fails unconditionally). This test forks
                # racing constructors on ONE directory -> overlapping
                # probes. The contention UNDER TEST is
                # the append flock, not the probe; every workdir here
                # was already probed once by the parent (seeded_dir's
                # Ledger(d) / the parent-side Ledger before spawn), so
                # the children skip the re-probe instead of racing it.
                led = Ledger(workdir, lock_attempts=attempts,
                             lock_backoff=0.01, probe=False)
                if miss_w is not None:
                    def _on_miss(i, who, _sent=[]):
                        if not _sent:
                            _sent.append(1)
                            miss_w.send(b"miss")  # THIS process was
                            # refused the lock — real contention.
                    led._test_hook_lock_miss = _on_miss
                if wait_r is not None:
                    wait_r.recv()
                if parks is not None:
                    inside_w, go_r = parks

                    def _hook():
                        inside_w.send(b"inside")   # reserved, lock held
                        go_r.recv()               # park until released
                    led._test_hook_after_reserve = _hook
                try:
                    with led._lock("append"):
                        off = led._append_bytes(framed)
                    res_w.send(("wrote", off))
                except LedgerError as e:
                    if e.code == "log-cap-exceeded":
                        # R5-c3 finding 1: report the predicate's OWN
                        # reported size/framed from the rejection —
                        # direct instrumentation of what the reserve
                        # check believed, not just its verdict.
                        res_w.send(("refused", e.code,
                                    e.detail.get("size"),
                                    e.detail.get("framed")))
                    else:
                        res_w.send(("refused", e.code))
                finally:
                    res_w.close()
            p = ctx.Process(target=racer, daemon=True)
            p.start()
            res_w.close()
            return p, res_r

        def seeded_dir(size):
            d = tempfile.mkdtemp(prefix="p9m3-f19-", dir=self.dir)
            seed = Ledger(d)
            fd = os.open(seed.ledger_path, os.O_WRONLY | os.O_CREAT
                         | os.O_APPEND, 0o600)
            os.ftruncate(fd, size)               # TEST seeding, not protocol
            os.close(fd)
            del seed
            return d

        # ---- (a) crossing pair at the row's geometry: cap - 24 B, 32-B
        # frames. Simultaneous release; both refuse; zero bytes — and
        # since refusals write nothing the outcome holds for EVERY
        # serial order (the induction is the zero-bytes fact itself).
        d1 = seeded_dir(LOG_CAP - 24)
        go1_r, go1_w = ctx.Pipe(duplex=False)
        go2_r, go2_w = ctx.Pipe(duplex=False)
        pa, ra = spawn(d1, b"X" * 32, wait_r=go1_r)
        pb, rb = spawn(d1, b"X" * 32, wait_r=go2_r)
        go1_r.close(); go2_r.close()             # parent keeps only write ends
        try:
            go1_w.send(b"go"); go2_w.send(b"go")  # simultaneous pistol
            ca = recv_or_fail(ra, "racer A never reported")
            cb = recv_or_fail(rb, "racer B never reported")
            pa.join(10); pb.join(10)
            self.assertEqual((pa.exitcode, pb.exitcode), (0, 0),
                             "racer did not exit cleanly")
        finally:
            quiet_reap(pa, pb)
        self.assertEqual([ca, cb],
                         [("refused", "log-cap-exceeded", LOG_CAP - 24, 32),
                          ("refused", "log-cap-exceeded", LOG_CAP - 24, 32)],
                         "refusal detail must report the predicate's own "
                         "size (the seed) and framed length (R5-c3 f1)")
        self.assertEqual(len(Ledger(d1)._read_bytes()), LOG_CAP - 24,
                         "crossing refusals wrote bytes")
        # R5-c1 finding 3 (major): a REFUSAL must leave the pending
        # sidecar UNTOUCHED — moving the `_write_pending(..., False)`
        # intent before the cap check would stamp a stale P marker here
        # (durability_pending flips True behind bytes that never
        # landed). Pin: absent before, absent after, no window.
        ledA = Ledger(d1)
        self.assertIsNone(ledA._read_pending(),
                          "cap refusals created/touched the pending sidecar")
        self.assertFalse(ledA.durability_pending(),
                         "cap refusals opened a durability window")

        # ---- (b) both serial orders, FORCED, roles swapped. First the
        # A-led order: A parks inside its reservation, B blocks on the
        # flock, A is released => A's write lands strictly before B can
        # reserve. Fresh dir, B-led order: mirror.
        FA, FB = b"A" * 12, b"B" * 12

        def forced_race(workdir, first_frame, second_frame):
            inside_r, inside_w = ctx.Pipe(duplex=False)
            go_r, go_w = ctx.Pipe(duplex=False)
            miss_r, miss_w = ctx.Pipe(duplex=False)
            p1 = r1 = p2 = r2 = None
            try:
                p1, r1 = spawn(workdir, first_frame, parks=(inside_w, go_r))
                inside_w.close(); go_r.close()   # child-side ends done here
                recv_or_fail(inside_r, "first child never reached its "
                                       "reservation under the lock")
                p2, r2 = spawn(workdir, second_frame, miss_w=miss_w)
                miss_w.close()                   # parent's write-end copy
                # R5-c1 FINDING 1 (major): proof, not a sleep. Wait on
                # the SECOND child's own signal that its flock() MISSED
                # — i.e., it demonstrably hit the busy lock. A mutation
                # to a non-exclusive lock would let the rival in with
                # NO miss: the guard below FAILS the test instead of
                # passing on kernel wake-up luck.
                if not miss_r.poll(10):
                    self.fail("F19 contention guard: the second child "
                              "NEVER saw the lock busy (a non-exclusive "
                              "lock must trip THIS, not pass)")
                try:
                    self.assertEqual(miss_r.recv(), b"miss")
                except EOFError:
                    self.fail("F19 contention guard: second child died "
                              "before ever contending for the lock")
                miss_r.close()
                go_w.send(b"go")                 # release FIRST: strict order
                first = recv_or_fail(r1, "first child never reported")
                second = recv_or_fail(r2, "second child never reported")
                p1.join(10); p2.join(10)
                self.assertEqual((p1.exitcode, p2.exitcode), (0, 0),
                                 "racer did not exit cleanly")
                return first, second
            finally:
                quiet_reap(p1, p2)

        dB = seeded_dir(LOG_CAP - 24)
        self.assertIsNone(Ledger(dB)._read_pending(),
                          "fresh dir must have no pending sidecar")
        res = forced_race(dB, FA, FB)
        self.assertEqual([r[0] for r in res], ["wrote", "wrote"],
                         "forced pair refused unexpectedly: %r" % (res,))
        self.assertEqual(sorted(r[1] for r in res),
                         [LOG_CAP - 24, LOG_CAP - 12])
        data = Ledger(dB)._read_bytes()
        self.assertEqual(len(data), LOG_CAP,
                         "non-crossing pair must exactly fill the last 24 B")
        self.assertEqual(data[LOG_CAP - 24:LOG_CAP - 12], FA,
                         "FIRST (the parked reservation) lost its slot")
        self.assertEqual(data[LOG_CAP - 12:], FB,
                         "loser's reserve check did not OBSERVE the "
                         "winner's bytes (slot != winner + 12)")
        # R5-c1 finding 3: a settled append leaves the sidecar at D at
        # ITS offset; nothing here may open a pending window.
        ledB = Ledger(dB)
        self.assertEqual(ledB._read_pending(), (LOG_CAP - 12, True),
                         "settled pair left the sidecar off the last write")
        self.assertFalse(ledB.durability_pending(),
                         "settled pair reports a durability window")

        # ---- (b2) PER-FRAME-LENGTH BOUNDARY GEOMETRY (R5-c1 f2 +
        # R5-c2 f1 + R5-c3 f1 + R5-c4 f1, all major): FOR EVERY framed
        # length F the fixture appends, a pair whose remaining space R
        # equals EXACTLY F (must FIT) and one with R == F - 1 (must
        # REFUSE). The comparison operand is thereby pinned at its
        # boundary for each F: ANY constant delta in the predicate
        # (max(0, size - 1), +1, or a size shifted by the frame
        # length) mis-verdicts SOME pair — the fit pairs kill
        # refuse-biased mutants, the refuse pairs kill
        # fit-biased/guessed/stale-size mutants, and the offset +
        # sidecar assertions localize WHERE. Each refusal ALSO reports
        # the predicate's OWN (size, framed) taken from the same
        # locals the comparison used (ledger.py instrumented per
        # R5-c3/c4), so reported-vs-compared divergence fails too.
        # (Bounded evidence for these sizes/roles/orders, per R5-c4 —
        # not a proof against every conceivable implementation.)
        RESERVE0 = LOG_CAP - 24                  # default seed (small F)
        # Every framed length F appended ANYWHERE in this geometry —
        # the set is CLOSED under lead and trail roles (R5-c5 f1):
        # trails are these F; leads are max(24-F+d, 8), and every
        # such lead length is itself in the set (leads 4..7 impossible
        # — lead floor is 8; case (b)'s 12-B frames and case (a)'s
        # 32-B frames are members too).
        FRAMES = (4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21, 32)
        GEOM = []
        for owner in ("A", "B"):                 # who writes the LEAD
            for F in FRAMES:
                for d in (0, 1):
                    # d=0: R == F EXACTLY (must fit); d=1: R == F-1
                    # (must refuse). seed + lead == LOG_CAP - (F - d);
                    # lead >= 8 so deep-F pairs seed deeper.
                    lead_len = max(24 - F + d, 8)
                    seed = LOG_CAP - (F - d) - lead_len
                    lead = owner.encode() * lead_len
                    trail = (b"B" if owner == "A" else b"A") * F
                    GEOM.append((lead, trail, d == 0, seed))
        for lead, trail, fits, seed in GEOM:
            who = "A" if lead[:1] == b"A" else "B"
            other = "B" if who == "A" else "A"
            tag = "%s%d/%s%d%s" % (who, len(lead), other, len(trail),
                                   "fit" if fits else "over")
            d = seeded_dir(seed)
            res = forced_race(d, lead, trail)
            self.assertEqual(res[0], ("wrote", seed),
                             "FIRST lost its reserved slot (%s)" % tag)
            if fits:
                self.assertEqual(res[1],
                                 ("wrote", seed + len(lead)),
                                 "SECOND refused although R == %d == F "
                                 "exactly (%s) - refuse-biased or size-"
                                 "inflating predicate" % (len(trail), tag))
                data = Ledger(d)._read_bytes()
                self.assertEqual(len(data), seed + len(lead) + len(trail),
                                 "fit pair misplaced bytes (%s)" % tag)
                self.assertLessEqual(len(data), LOG_CAP,
                                     "fit pair exceeded the cap (%s)" % tag)
                self.assertEqual(data[seed:], lead + trail,
                                 "frame order clobbered (%s)" % tag)
                led5 = Ledger(d)
                self.assertEqual(led5._read_pending(),
                                 (seed + len(lead), True),
                                 "sidecar off the last settled write (%s)"
                                 % tag)
                self.assertFalse(led5.durability_pending(),
                                 "settled pair reports a window (%s)" % tag)
            else:
                self.assertEqual(
                    res[1],
                    ("refused", "log-cap-exceeded", seed + len(lead),
                     len(trail)),
                    "SECOND passed its reserve check with only %d B left "
                    "and a %d B frame (R == F - 1), and/or its REPORTED "
                    "operand is not the comparison's own (size, framed) "
                    "(%s)" % (24 - len(lead), len(trail), tag))
                data = Ledger(d)._read_bytes()
                self.assertEqual(len(data), seed + len(lead),
                                 "cap refusal added bytes (%s)" % tag)
                self.assertLessEqual(len(data), LOG_CAP,
                                     "ledger EXCEEDED the cap (%s)" % tag)
                self.assertEqual(data[seed:], lead,
                                 "winner's frame clobbered (%s)" % tag)
                self.assertNotIn(trail, data,
                                 "loser's frame landed despite refusal (%s)"
                                 % tag)
                led5 = Ledger(d)
                self.assertEqual(
                    led5._read_pending(), (seed, True),
                    "cap refusal moved/re-created the pending sidecar (%s)"
                    % tag)
                self.assertFalse(led5.durability_pending(),
                                 "cap refusal opened a durability window (%s)"
                                 % tag)
        dC = seeded_dir(LOG_CAP - 24)
        res = forced_race(dC, FB, FA)            # roles swapped
        self.assertEqual([r[0] for r in res], ["wrote", "wrote"],
                         "forced pair (swapped) refused unexpectedly: %r"
                         % (res,))
        self.assertEqual(sorted(r[1] for r in res),
                         [LOG_CAP - 24, LOG_CAP - 12])
        data = Ledger(dC)._read_bytes()
        self.assertEqual(data[LOG_CAP - 24:LOG_CAP - 12], FB)
        self.assertEqual(data[LOG_CAP - 12:], FA)

        # ---- (c) contention refusal stays pinned: an external holder
        # keeps the flock; a bounded-attempts child refuses
        # `ledger-lock-held` and writes nothing; after release the
        # append is admitted.
        d3 = seeded_dir(LOG_CAP - 24)
        import fcntl as _f
        holder = os.open(os.path.join(d3, "consumptions.jsonl.lock"),
                         os.O_RDWR | os.O_CREAT, 0o600)
        _f.flock(holder, _f.LOCK_EX)
        try:
            p, r = spawn(d3, b"\n{}\n", attempts=2)
            try:
                self.assertEqual(recv_or_fail(r, "bounded child never reported"),
                                 ("refused", "ledger-lock-held"))
                p.join(10)
                self.assertEqual(p.exitcode, 0, "bounded racer unhealthy")
            finally:
                quiet_reap(p)
            self.assertEqual(len(Ledger(d3)._read_bytes()), LOG_CAP - 24,
                             "lock-held refusal wrote bytes")
        finally:
            _f.flock(holder, _f.LOCK_UN)
            os.close(holder)
        led4 = Ledger(d3)
        with led4._lock("append"):
            self.assertEqual(led4._append_bytes(b"\n{}\n"), LOG_CAP - 24)
        self.assertEqual(len(led4._read_bytes()), LOG_CAP - 20)

    # ---------------------------------------------------------------- F20
    def test_F20_injected_failure_successor_rederives_bounded_resolve(self):
        # v38 audit C1-6: this simulates the crash with an injected
        # exception; it does NOT SIGKILL a process. The real kill -9
        # boundary is covered by the real-SIGKILL child-process pin in
        # TestV38CyclePins (the fork + kill -9 partial-bytes case).
        bad = CORRUPT + b"-f20"
        self.seed_at([(0, bad)])
        led1 = self.mk(repair_attempt_cap=3)
        led1.faults.fsync_fault = True
        with self.assertRaises(OSError):
            led1.append_watermark("H1", 1, "G1")     # bytes written, not durable
        successor = self.mk(repair_attempt_cap=3)    # kill -9 happened
        successor.faults.resolve_fsync_fault = True  # adversary keeps failing fsync
        self.assertEqual(successor.status()["decision"], STATE_PENDING)
        self.assertTrue(successor.durability_pending())
        codes = []
        for _ in range(5):
            try:
                successor.resolve()
                codes.append("resolved")
            except LedgerError as e:
                codes.append(e.code)
        self.assertEqual(codes, [STATE_PENDING, STATE_PENDING, STATE_PENDING,
                                 STATE_EXHAUSTED, STATE_EXHAUSTED])
        self.assertEqual(successor.status()["decision"], STATE_EXHAUSTED)
        self.assertFalse(successor.promotion_allowed())
        # STICKY (v38 audit fix 4): clearing the fault does NOT re-arm —
        # exhaustion exits service until the operator resets.
        successor.faults.resolve_fsync_fault = False
        with self.assertRaises(LedgerError) as cm:
            successor.resolve()
        self.assertEqual(cm.exception.code, STATE_EXHAUSTED)
        self.assertEqual(Ledger(self.dir).status()["decision"],
                         STATE_EXHAUSTED)   # fresh process remembers
        successor.operator_resolve_reset()  # explicit operator re-arm
        cls = successor.resolve()                    # idempotent: succeeds once
        self.assertEqual(cls["state"], STATE_UNMASKED)
        self.assertFalse(successor.durability_pending())


    # ---------------------- F23/V33 (D4A-c5-1): late-AUTH activation --
    def test_F23v33_late_genuine_AUTH_activates_dead_repair(self):
        """V33 fixture row F23 (docs/21): a DEAD REPAIR (unknown-authId)
        classifies VALID on the re-read once a GENUINE AUTH with the
        exact mask list appears; a second REPAIR under that AUTH is
        refused SPENT. SETUP IS INJECTED/CORRUPTION-ONLY per the row
        (a conforming producer refuses a REPAIR with no matching AUTH;
        the AUTH line is seeded raw — the live authorize() would refuse
        the authId as already-used by the injected REPAIR). Added by
        the D4-scopeA cycle-5 fold: the v38 test_F23 pins a different
        (intent-journal) fixture; the V33 row's activation arm was
        otherwise pinned only by the F24gen growth arm."""
        bad = CORRUPT + b"-f23late"
        self.seed(bad + b"\n")
        led = self.mk()
        gen = led.confirmation_gen()
        o = self.occ(0, bad)
        self.seed(self.Led_frame(json.dumps(
            {"t": "REPAIR", "authId": "A9", "masks": [o],
             "all": {"hostToken": "ALL", "watermark": 0,
                     "confirmGen": gen}})))
        c = led.classify()
        self.assertEqual([x["reason"] for x in c["dead_repairs"]],
                         ["unknown-authId"])          # DEAD pre-AUTH
        self.assertEqual(c["state"], STATE_UNMASKED)
        # the genuine AUTH arrives LATER (raw seed: injection-only row)
        self.seed(b'{"t":"AUTH","authId":"A9","occurrences":'
                  + json.dumps([o]).encode()
                  + b',"createdAt":1.0}\n', path="authorizations.jsonl")
        c = led.classify()
        self.assertEqual(c["dead_repairs"], [])        # VALID on re-read
        self.assertEqual(c["state"], STATE_OK)
        self.assertIn("A9", c["spent"])
        with self.assertRaises(LedgerError) as cm:
            self.mk().repair("A9")                     # second REPAIR
        self.assertEqual(cm.exception.code, "authorization-spent")

    def test_F23v33_late_AUTH_occurrence_mismatch_stays_dead(self):
        """V33 F23's second arm: if the later AUTH carries
        occurrences != M, the REPAIR stays DEAD forever (F21 rule)."""
        b1, b2 = CORRUPT + b"-f23m1", CORRUPT + b"-f23m2"
        self.seed(b1 + b"\n" + b2 + b"\n")
        led = self.mk()
        gen = led.confirmation_gen()
        self.seed(self.Led_frame(json.dumps(
            {"t": "REPAIR", "authId": "A8", "masks": [self.occ(0, b1)],
             "all": {"hostToken": "ALL", "watermark": 0,
                     "confirmGen": gen}})))
        # AUTH over BOTH occurrences while the REPAIR masks only the first
        self.seed(b'{"t":"AUTH","authId":"A8","occurrences":'
                  + json.dumps([self.occ(0, b1),
                                self.occ(len(b1) + 1, b2)]).encode()
                  + b',"createdAt":1.0}\n', path="authorizations.jsonl")
        c = led.classify()
        self.assertEqual([x["reason"] for x in c["dead_repairs"]],
                         ["mask-mismatch"])            # stays DEAD
        self.assertEqual(c["state"], STATE_UNMASKED)
        self.assertNotIn("A8", c["spent"])

    # ------------------ F25/V33 (D4A-c5-2): crash-prefix arms --------
    def test_F25v33_crash_prefix_enumeration_three_arms(self):
        """V33 fixture row F25 CRASH-PREFIX ENUMERATION (v39 R2-M4):
        a crash between loop syscalls leaves three disk prefixes with
        THREE distinct read outcomes, driven SEPARATELY here:
        (a) ZERO bytes => no trace at all (read == no append);
        (b) whitespace-only prefix (bare \n and ' \n ') => trailing
            whitespace is ignored => indistinguishable from (a), NOT
            unsettled-tail;
        (c) a NONBLANK unterminated prefix => unsettled-tail + the
            settlement route.
        The v38 test_F25 pins post-write verify staleness (a different
        fixture reusing the number); this row's arms were not driven.
        AUD45-pre fold strengthens this beyond the read side: the write
        side is DRIVEN — append_watermark under partial_write {0, 1, 4}
        must PRODUCE exactly the prefixes (a)/(b1)/(c) on disk, resolve
        them per their arms, and arm (c) walks the full settlement
        route (torn tail -> newline -> one malformed occurrence ->
        unmasked-malformed, per the AUD34-M1 settlement rule)."""
        frame_ok = b"\n" + json.dumps(
            {"t": "WATERMARK", "hostToken": "H0", "watermark": 1,
             "confirmGen": "G0"}).encode() + b"\n"
        for label, tail in [("(a)", b""), ("(b1)", b"\n"),
                            ("(b2)", b"\n  \n "), ("(c)", b"\n{X")]:
            with self.subTest(label):
                self.seed(frame_ok + tail)
                st = self.mk().status()
                if tail == b"\n{X":
                    self.assertEqual(st["decision"], STATE_UNSETTLED)
                else:
                    self.assertEqual(st["decision"], STATE_OK)
        # write side (AUD45-pre): the injected short write produces
        # exactly these prefixes; each resolves per its arm. Fresh
        # dirs: the read-side loop above already wrote to self.dir,
        # and each write arm needs a pristine journal.
        for label, partial, prefix in [("a-zero", 0, b""),
                                       ("b1-ws", 1, b"\n"),
                                       ("c-nonblank", 4, b'\n{"t')]:
            with self.subTest(label):
                wdir = tempfile.mkdtemp(prefix="p9m3-w", dir=self.dir)
                self.addCleanup(shutil.rmtree, wdir, ignore_errors=True)
                led = Ledger(wdir, faults=FsFaults())
                led.faults.partial_write = partial
                with self.assertRaises(OSError):
                    led.append_watermark("H0", 1, "G0")
                led.faults.partial_write = None
                self.assertEqual(self.raw(led), prefix)
                res = led.resolve()
                if label == "c-nonblank":
                    self.assertEqual(res["state"], STATE_UNSETTLED)
                    led.settle()
                    raw = self.raw(led)
                    self.assertTrue(raw.endswith(b"\n"))
                    self.assertEqual(raw.count(b"\n"), 2)   # torn + settle
                    self.assertEqual(len(led.classify()["occurrences"]), 1)
                    self.assertEqual(led.status()["decision"],
                                     STATE_UNMASKED)
                else:
                    self.assertEqual(res["state"], STATE_OK)
                    self.assertEqual(led.status()["decision"], STATE_OK)
    # ---------------------------------------------------------------- F21
    def test_F21_dead_repair_inert_promotion_refused_fresh_pair(self):
        bad = CORRUPT + b"-f21"
        bad2 = CORRUPT + b"-f21b"
        self.seed_at([(0, bad), (len(bad) + 2, bad2)])
        self.led = self.mk()
        # valid AUTH covering ONLY the first occurrence (different list)
        auth = self.led.authorize([self.occ(0, bad)], auth_id="A1", test_only=True)
        # REPAIR naming an unknown authId (adversary)
        self.seed(self.Led_frame(
            '{"t":"REPAIR","authId":"GHOST","masks":[],"all":{"hostToken":'
            '"ALL","watermark":0,"confirmGen":"G0"}}'))
        st = self.led.status()
        self.assertEqual(st["decision"], STATE_UNMASKED)
        self.assertEqual(len(st["dead_repairs"]), 1)
        self.assertEqual(st["dead_repairs"][0]["reason"], "unknown-authId")
        self.assertFalse(self.led.promotion_allowed())
        with self.assertRaises(LedgerError):
            self.led.revive_dead_repair()            # no such command
        # A1 cannot repair: its list covers only occ 0 (list changed)
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth)
        self.assertEqual(cm.exception.code, "authorization-stale")
        # fresh AUTH+REPAIR over the CURRENT list succeeds
        auth2 = self.led.authorize(
            [{"offset": o["offset"], "hash": o["hash"]}
             for o in self.led.classify()["unmasked"]], auth_id="A2", test_only=True)
        self.assertEqual(self.led.repair(auth2)["outcome"], "repaired")
        self.assertEqual(self.led.status()["decision"], STATE_OK)
        # A1 stays UNSPENT (its REPAIR never existed): authorizing its
        # exact list again is a replay refusal, not a fresh authorization
        with self.assertRaises(LedgerError) as cm:
            self.led.authorize(
                [{"offset": 0, "hash": sha(bad)}], auth_id="A3", test_only=True)
        self.assertEqual(cm.exception.code, "authorization-replay")

    # ---------------------------------------------------------------- F22
    def test_F22_fs_probe_rejects_impostors(self):
        d1 = tempfile.mkdtemp(prefix="p9m3-nfs-", dir=self.dir)
        with self.assertRaises(FSProbeError) as cm:
            run_probe(d1, fstype="nfs")
        self.assertEqual(str(cm.exception), "fs-probe-failed:leg1")
        with self.assertRaises(FSProbeError) as cm:
            Ledger(os.path.join(d1, "led"), fstype="nfs")
        self.assertIn("leg1", str(cm.exception))
        self.assertEqual(os.listdir(d1), [n for n in os.listdir(d1)
                                          if not n.startswith("led")])
        d2 = tempfile.mkdtemp(prefix="p9m3-fuse-", dir=self.dir)
        with self.assertRaises(FSProbeError) as cm:
            run_probe(d2, fstype="local",
                      faults=FsFaults(fsync_visibility_fails=True))
        self.assertEqual(str(cm.exception), "fs-probe-failed:leg3")
        d3 = tempfile.mkdtemp(prefix="p9m3-fuse2-", dir=self.dir)
        with self.assertRaises(FSProbeError) as cm:
            run_probe(d3, fstype="local",
                      faults=FsFaults(silly_rename_leaves_second_name=True))
        self.assertEqual(str(cm.exception), "fs-probe-failed:leg4")
        # healthy local mount passes; probe writes no ledger bytes
        d4 = tempfile.mkdtemp(prefix="p9m3-good-", dir=self.dir)
        run_probe(d4, fstype="local")
        self.assertEqual([n for n in os.listdir(d4) if not n.startswith(".probe")
                          or n == ".probe-stays"], [])

    # ------------------------------------------------------------- F23 (v38)
    def test_F23_intent_first_repair_journal(self):
        # Intent-first protocol + append-only repair journal (audit fix 5):
        # a byte-producing repair that never reaches an outcome leaves an
        # INTENT line with NO outcome and the sidecar at P intent 'R'.
        bad = CORRUPT + b"-f23"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        auth = self.led.authorize([self.occ(0, bad)], auth_id="A23", test_only=True)
        jpath = os.path.join(self.dir, "repair_intent.jsonl")
        self.led.faults.partial_write = 4            # partial bytes, then die
        with self.assertRaises(OSError):
            self.led.repair(auth)
        self.assertTrue(self.led.durability_pending())
        self.assertEqual(self.led._pending_intent(), "R")
        with open(jpath, "rb") as f:
            journal = [json.loads(l) for l in f if l.strip()]
        self.assertEqual([r["t"] for r in journal], ["REPAIR-INTENT"])
        # successor: re-derivation is the authority; journal stays evidence
        succ = self.mk()
        self.assertTrue(succ.durability_pending())
        self.assertEqual(succ.status()["decision"], STATE_PENDING)
        succ.faults.resolve_fsync_fault = False
        cls = succ.resolve()                         # partial frame: unsettled
        self.assertIn(cls["state"], (STATE_UNSETTLED, STATE_UNMASKED,
                                      STATE_OK))
        # completed repair journals intent AND outcome
        self.led.faults.partial_write = None         # fault lifted
        st2 = self.led.settle()                      # settle torn fragment
        auth2 = self.led.authorize(
            [{"offset": o["offset"], "hash": o["hash"]}
             for o in st2["unmasked"]], auth_id="A23b", test_only=True)
        res = self.led.repair(auth2)
        self.assertEqual(res["outcome"], "repaired")
        with open(jpath, "rb") as f:
            journal = [json.loads(l) for l in f if l.strip()]
        self.assertEqual([r["t"] for r in journal],
                         ["REPAIR-INTENT", "REPAIR-INTENT", "REPAIR-OUTCOME"])
        self.assertEqual(journal[0]["authId"], auth)
        self.assertEqual(journal[1]["authId"], auth2)
        self.assertEqual(journal[-1]["outcome"], "repaired")

    # ------------------------------------------------------------- F24 (v38)
    def test_F24_promote_binding_transaction(self):
        # Binding promotion (audit fix 2): the decision + journal write
        # happen under ONE lock; a held lock refuses the decision (never
        # decides on a stale snapshot).
        self.led = self.mk(lock_attempts=2, lock_backoff=0.01)
        res = self.led.promote(lambda: {
            "allowed": True,
            "off": self.led.append_applied_in_lock("PROMO1")})
        self.assertTrue(res["allowed"])
        self.assertIn("PROMO1", self.led.classify()["spent"])
        # contention: lock held => promote REFUSES (no decide-on-snapshot)
        import fcntl as _f
        holder = os.open(self.led.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        _f.flock(holder, _f.LOCK_EX)
        with self.assertRaises(LedgerError) as cm:
            self.led.promote(lambda: {"allowed": True})
        self.assertEqual(cm.exception.code, "ledger-lock-timeout")
        _f.flock(holder, _f.LOCK_UN)
        os.close(holder)
        # durability-pending => refused: while the resolve fault is active
        # promote's resolve-on-use fails => overlay decision, no journal
        self.led.faults.fsync_fault = True
        with self.assertRaises(OSError):
            self.led.append_watermark("H1", 1, "G1")  # bytes land, not durable
        self.led.faults.resolve_fsync_fault = True
        r = self.led.promote(lambda: {"allowed": True})
        self.assertEqual(r, {"allowed": False, "decision": STATE_PENDING})
        # self-heal: resolve-on-use succeeds once IO recovers
        self.led.faults.fsync_fault = False
        self.led.faults.resolve_fsync_fault = False
        self.led.resolve()
        self.assertTrue(self.led.promote(
            lambda: {"allowed": True})["allowed"])

    # ------------------------------------------- F24gen (doc F24, v39 R2-B2;
    #                                pinned v40 by R3-c1 CODE-1)
    def test_F24gen_generation_binding_of_repair_validity(self):
        # Doc 21 fixture F24 (v39 R2-B2): REPAIR validity is bound to
        # the confirmation-log generation recorded in its own
        # all.confirmGen, compared against the CURRENT generation
        # header on every read. (a) a DEAD-by-watermark REPAIR becomes
        # VALID when the log grows past W IN THE SAME GENERATION;
        # (b) a NEW generation header leaves it DEAD permanently, and
        # a DEAD REPAIR masks nothing and cannot spend.
        bad = CORRUPT + b"-f24gen"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        # generation header GEN1; log currently 100 B (< W=200) => DEAD
        self.led.seed_confirmation_log(
            b'{"confirmGen":"GEN1"}' + b" " * 79 + b"\n")
        occs = [self.occ(0, bad)]
        self.led.authorize(occs, auth_id="A24G", test_only=True)
        W = 200
        d = self.led._frame(
            '{"t":"REPAIR","authId":"A24G","masks":%s,"all":{"hostToken":"ALL","watermark":%d,"confirmGen":"GEN1"}}'
            % (_j(occs), W))
        self.seed(d)
        c = self.led.classify()
        self.assertEqual([x["reason"] for x in c["dead_repairs"]],
                         ["mask-mismatch"])          # DEAD: W > L_C
        self.assertEqual(c["state"], STATE_UNMASKED)  # masks nothing
        self.assertNotIn("A24G", c["spent"])
        # (a) same-generation growth past W => VALID on the re-read
        self.led.seed_confirmation_log(b"e" * (W - 100) + b"\n")
        self.assertGreaterEqual(self.led.confirmation_length(), W)
        self.assertEqual(self.led.confirmation_gen(), "GEN1")
        c = self.led.classify()
        self.assertEqual(c["state"], STATE_OK)
        self.assertEqual(c["dead_repairs"], [])
        self.assertIn("A24G", c["spent"])
        # (b) a confirmation-log repair publishes a NEW generation
        # header => the GEN1 REPAIR is DEAD permanently again
        self.led.seed_confirmation_log(
            b'{"confirmGen":"GEN2"}' + b" " * 39 + b"\n")
        # NOTE: header parsing reads the FIRST line; emulate the
        # confirmation-repair by replacing the log with the new header
        # over a fresh file (append-only in the real protocol means the
        # new header is the first line of the NEW log epoch).
        p = os.path.join(self.dir, "confirmations.jsonl")
        os.remove(p)
        self.led.seed_confirmation_log(
            b'{"confirmGen":"GEN2"}' + b" " * 39 + b"\n" + b"g" * 300 + b"\n")
        self.assertEqual(self.led.confirmation_gen(), "GEN2")
        c = self.led.classify()
        self.assertEqual(c["state"], STATE_UNMASKED)   # DEAD masks nothing
        self.assertEqual([x["reason"] for x in c["dead_repairs"]],
                         ["mask-mismatch"])
        self.assertNotIn("A24G", c["spent"])
        self.assertFalse(self.led.promotion_allowed())

    # ------------------------------------------------------------- F25 (v38)
    def test_F25_post_write_verify_stale_is_outcome_unknown(self):
        # Post-write re-read is a CONTENT verification (audit fix 5): a
        # write that reports success but whose bytes are not visible at
        # the reserved offset => outcome-unknown, never `repaired`.
        bad = CORRUPT + b"-f25"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        auth = self.led.authorize([self.occ(0, bad)], auth_id="A25", test_only=True)
        self.led.faults.reread_stale = True
        res = self.led.repair(auth)
        self.assertEqual(res["outcome"], "outcome-unknown")
        self.led.faults.reread_stale = False
        # the REPAIR did land: successor sees it spent; retry on the same
        # auth refuses as spent (never a second REPAIR)
        self.assertIn(auth, self.led.classify()["spent"])
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth)
        self.assertEqual(cm.exception.code, "authorization-spent")

    # ------------------------------------------------------------- F26 (v38)
    def test_F26_authorize_refuses_masked_occurrence(self):
        # Audit fix 6: an AUTH over an ALREADY-MASKED occurrence would
        # mint a DEAD-on-arrival REPAIR; authorize refuses it.
        bad = CORRUPT + b"-f26"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        occ = self.occ(0, bad)
        auth = self.led.authorize([occ], auth_id="A26", test_only=True)
        self.assertEqual(self.led.repair(auth)["outcome"], "repaired")
        cls = self.led.classify()
        self.assertEqual(cls["state"], STATE_OK)
        self.assertEqual(cls["unmasked"], [])
        with self.assertRaises(LedgerError) as cm:
            self.led.authorize([{"offset": 0, "hash": sha(bad)}],
                               auth_id="A26b", test_only=True)
        self.assertEqual(cm.exception.code, "auth-entry-not-unmasked")

    # ------------------------------------------------------------- F27 (v38)
    def test_F27_sigkill_midwrite_survives_as_unsettled(self):
        # A REAL SIGKILL after partial bytes land (no fsync, no exit
        # handler): the kernel-written bytes survive and the successor
        # must treat the tail as unsettled (unsettled-tail refusal).
        self.led = self.mk()
        self.led.append_watermark("H0", 1, "G0")
        # v38 cycle-6 (audit C5-4): the child runs the REAL append path,
        # not a raw os.write. The partial_write seam makes the live code
        # write a prefix and then stop; the child SIGKILLs itself at that
        # exact point, so the pending intent sidecar and the torn bytes are
        # the protocol's own, not hand-written.
        # audit cycle-7 finding (cycle-2 F27): the kill must land INSIDE the
        # ledger write syscall, after the prefix, with NO later seam-side
        # pending update to mask a removed pre-write marker.
        from unittest import mock
        pre_size = os.path.getsize(self.led.ledger_path)   # interrupted append's offset
        pid = os.fork()
        if pid == 0:                                 # child dies mid-write
            try:
                child = self.mk()
                real = os.write
                def die_in_ledger(fd, data):
                    if b'"t":"WATERMARK"' not in data:
                        return real(fd, data)
                    real(fd, data[:8])               # 8-byte prefix lands
                    os.kill(os.getpid(), signal.SIGKILL)
                with mock.patch("p9m3.ledger.os.write", side_effect=die_in_ledger):
                    child.append_watermark("H0", 2, "G0")   # PUBLIC path
            finally:
                os._exit(3)                          # only if kill failed
        _, status = os.waitpid(pid, 0)
        self.assertTrue(os.WIFSIGNALED(status)
                        and os.WTERMSIG(status) == signal.SIGKILL,
                        "child was not killed inside the ledger write")
        succ = self.mk()
        cls = succ.classify()
        self.assertEqual(cls["state"], STATE_UNSETTLED)
        # audit cycle-7 finding 2: the successor must see the pending window
        # itself (non-durable), not infer it from the torn bytes alone.
        pend = succ._read_pending()
        self.assertIsNotNone(pend, "successor sees no pending window")
        self.assertEqual(pend[1], False, "pending window marked durable")
        # audit cycle-9 finding: the window must identify the INTERRUPTED
        # append (its pre-write ledger offset), not any stale offset.
        self.assertEqual(pend[0], pre_size, "pending offset is not the interrupted append")
        self.assertFalse(succ.promotion_allowed())
        st = succ.settle()                           # settlement completes
        self.assertEqual(st["state"], STATE_UNMASKED)   # fragment: malformed
        self.assertFalse(succ.promotion_allowed())      # unmasked: still refuse
        # operator path: authorize over the fragment, repair, then promote
        auth = succ.authorize([{"offset": o["offset"], "hash": o["hash"]}
                               for o in st["unmasked"]], auth_id="A27", test_only=True)
        self.assertEqual(succ.repair(auth)["outcome"], "repaired")
        self.assertEqual(succ.classify()["state"], STATE_OK)
        self.assertTrue(succ.promotion_allowed())


def _j(obj):
    import json
    return json.dumps(obj, separators=(",", ":"))


class TestV38CyclePins(Base):
    """F28-F33: pins for the v38 cycle-1 / cycle-2 audit fixes."""

    # ------------------------------------------------------------- F28 (C2-F9)
    def test_F28_auth_shaped_line_in_consumption_log_is_malformed(self):
        # C2 cycle-2 fix 9: AUTH is NOT a consumption-log kind. An
        # AUTH-shaped, schema-valid line inside the consumption log is
        # a MALFORMED OCCURRENCE — never a valid record, never spent.
        auth_line = _j({"t": "AUTH", "authId": "A42",
                        "occurrences": [{"offset": 7, "hash": sha(b"x") * 1}],
                        "createdAt": 1700000000}).encode()
        self.seed_at([(0, auth_line)])
        self.led = self.mk()
        cls = self.led.classify()
        self.assertEqual(cls["state"], STATE_UNMASKED)
        self.assertEqual([o["offset"] for o in cls["unmasked"]], [0])
        self.assertEqual(cls["spent"], set())
        # ...and it must be authorizable+repairable like any malformed
        # occurrence (proves it is treated as occurrence, not authority)
        auth = self.led.authorize([self.occ(0, auth_line)], auth_id="R28", test_only=True)
        self.assertEqual(self.led.repair(auth)["outcome"], "repaired")
        self.assertEqual(self.led.classify()["state"], STATE_OK)

    # ------------------------------------------------------------- F29 (C2-F2)
    def test_F29_oversize_auth_line_fails_closed_on_read(self):
        # C2 cycle-2 fix 2: the AUTH file read is BOUNDED; a line past
        # the 64 KiB cap fails CLOSED (authorization-file-malformed) —
        # never parsed as a valid authorization.
        big = {"t": "AUTH", "authId": "BIG",
               "occurrences": [{"offset": i, "hash": sha(b"%d" % i)}
                               for i in range(2500)],
               "createdAt": 1700000000}
        line = _j(big).encode()
        assert len(line) > 64 * 1024
        self.seed(line + b"\n", path="authorizations.jsonl")
        self.led = self.mk()
        self.assertTrue(self.led.classify()["authorization_file_malformed"])
        with self.assertRaises(LedgerError) as cm:
            self.led.authorize([self.occ(0, CORRUPT)], auth_id="A29", test_only=True)
        self.assertEqual(cm.exception.code, AUTH_FILE_MALFORMED)
        with self.assertRaises(LedgerError) as cm:
            self.led.repair("BIG")
        self.assertEqual(cm.exception.code, AUTH_FILE_MALFORMED)
        self.assertFalse(self.led.promotion_allowed())

    # ---------------------------------------------------------------- F30 (F3)
    def test_F30_probe_creates_directory_0700(self):
        d = os.path.join(self.dir, "fresh", "leddir")
        run_probe(d, fstype="local")
        self.assertEqual(os.stat(d).st_mode & 0o777, 0o700)

    # ---------------------------------------------------------------- F31 (F7)
    def test_F31_probe_scratch_unpredictable_and_symlink_refused(self):
        from p9m3.probe import _scratch_names
        d = os.path.join(self.dir, "scratch")
        os.makedirs(d, mode=0o700)
        n1 = _scratch_names(d)
        n2 = _scratch_names(d)
        # unpredictable: two draws never collide...
        self.assertNotEqual(n1["lock"], n2["lock"])
        # ...and never the old predictable names
        self.assertNotIn(".probe-lock", n1.values())
        # symlink at a scratch name: O_NOFOLLOW refuses (leg2), never
        # follows/truncates the target
        victim = os.path.join(self.dir, "victim")
        os.write((lambda fd: fd)(os.open(victim, os.O_WRONLY | os.O_CREAT,
                                         0o600)), b"do-not-touch")
        sneak = os.path.join(d, "sneak")
        os.symlink(victim, sneak)
        from p9m3.probe import _leg2_flock_roundtrip, FsFaults as _FF
        dfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, dfd)
        with self.assertRaises(FSProbeError) as cm:
            _leg2_flock_roundtrip(dfd, _FF(), {"lock": "sneak"})
        self.assertEqual(str(cm.exception), "fs-probe-failed:leg2")
        with open(victim, "rb") as f:
            self.assertEqual(f.read(), b"do-not-touch")

    # ---------------------------------------------------------------- F32 (F8)
    def test_F32_empty_pending_sidecar_fails_closed(self):
        # A torn creation (file exists, payload never landed) is NOT
        # "no window": it fails CLOSED as pending.
        self.led = self.mk()
        self.led.append_watermark("H0", 1, "G0")     # normal, durable
        self.assertFalse(self.led.durability_pending())
        fd = os.open(os.path.join(self.dir, "last-append"),
                     os.O_WRONLY | os.O_TRUNC, 0o600)
        os.close(fd)                                  # zero-byte sidecar
        self.assertTrue(self.led.durability_pending())
        self.assertEqual(self.led.status()["decision"], STATE_PENDING)

    # ---------------------------------------------------------------- F33 (F10)
    def test_F33_decision_append_refuses_non_ok_classification(self):
        # A decision append inside promote() re-checks the gate on the
        # IN-LOCK classification: a non-ok state refuses the append.
        bad = CORRUPT + b"-f33"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        self.assertEqual(self.led.classify()["state"], STATE_UNMASKED)
        # promote() itself refuses (dict) without running the callback...
        r = self.led.promote(lambda: self.led.append_applied_in_lock("P33"))
        self.assertEqual(r["allowed"], False)
        self.assertNotIn("P33", self.led.classify()["spent"])
        # ...and the in-lock append refuses on its own re-check too
        with self.assertRaises(LedgerError) as cm:
            with self.led._lock("append"):
                self.led.append_applied_in_lock("P33")
        self.assertEqual(cm.exception.code, "decision-append-refused")
        # ok state still admits the in-lock decision append
        auth = self.led.authorize([self.occ(0, bad)], auth_id="A33", test_only=True)
        self.led.repair(auth)
        r = self.led.promote(lambda: {"off": self.led.append_applied_in_lock("P33b")})
        self.assertIn("off", r)
        self.assertIn("P33b", self.led.classify()["spent"])

    # ================================================================ F34
    def test_F34_counter_strict_grammar_single_parser(self):
        # v38 cycle-3 fix 3 (AUD C3-3): ONE strict parser; an EXISTING
        # resolve-attempts file that fails the grammar — empty, torn,
        # overlength, negative, unknown flag, wrong padding — is
        # EXHAUSTED (fail closed), never silently re-armed. MISSING file
        # stays (0, not exhausted).
        import p9m3.ledger as L
        side = os.path.join(self.dir, "resolve-attempts")
        self.led = self.mk()
        self.assertEqual(self.led._parse_counter(), (0, False))  # missing
        for corpus in (b"",                      # empty (torn creation)
                       b"2 ",                    # truncated flag
                       b" 2 -",                  # leading space
                       b"-3 -",                  # negative count
                       b"2 Q",                   # unknown flag
                       b"2- ",                    # missing separator
                       b"01234567890 -",         # 11 digits
                       b"2 -  x",                # overlength 17 bytes
                       b"two -"):                # unparsable
            fd = os.open(side, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.write(fd, corpus)
            os.close(fd)
            n, exh = Ledger(self.dir)._parse_counter()
            self.assertTrue(exh, "must be exhausted: %r" % corpus)
            self.assertGreater(n, 2)             # over-cap, never 0
        # a valid record parses exactly
        fd = os.open(side, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, b"2 -" + b"\0" * 13)
        os.close(fd)
        led2 = Ledger(self.dir)
        self.assertEqual(led2._parse_counter(), (2, False))
        self.assertEqual(led2._read_counter(), 2)
        self.assertFalse(led2._attempts_exhausted())
        # ...and resolve refuses across a process restart on corrupt
        fd = os.open(side, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, b"")
        os.close(fd)
        with self.assertRaises(LedgerError) as cm:
            Ledger(self.dir).resolve()
        self.assertEqual(cm.exception.code, STATE_EXHAUSTED)

    # ---------------------------------------------------------------- F35
    def test_F35_status_and_resolution_agree_on_corrupt_counter(self):
        # v38 cycle-3 fix 3: status and the resolve loop share the ONE
        # parser — with a pending window AND a corrupt counter both
        # report exhaustion (the two readers can no longer disagree),
        # across a restart.
        self.seed(b"y" * 40 + b"\n")
        self.led = self.mk()
        self.led.faults.fsync_fault = True
        with self.assertRaises(OSError):
            self.led.append_watermark("H1", 1, "G1")   # pending window
        self.led.faults.fsync_fault = False
        side = os.path.join(self.dir, "resolve-attempts")
        fd = os.open(side, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, b"")                              # corrupt: empty
        os.close(fd)
        fresh = Ledger(self.dir)
        self.assertTrue(fresh.durability_pending())
        self.assertEqual(fresh.status()["decision"], STATE_EXHAUSTED)
        with self.assertRaises(LedgerError) as cm:
            fresh.resolve()
        self.assertEqual(cm.exception.code, STATE_EXHAUSTED)

    # ---------------------------------------------------------------- F36
    def test_F36_auth_line_cap_enforced_streaming(self):
        # v38 cycle-3 fix 4 (AUD C3-4): the per-line cap is enforced
        # while STREAMING — a line crossing 64 KiB mid-chunk fails
        # the file closed BEFORE the remainder is read. A 64 KiB - 1
        # valid AUTH (crossing the 16 KiB chunk framing) still parses.
        def auth_of(auth_id, n_occ, pad_len):
            occ = [{"offset": i, "hash": sha(b"%d" % i)}
                   for i in range(n_occ)]
            d = {"t": "AUTH", "authId": auth_id, "occurrences": occ,
                 "createdAt": 1700000000}
            line = _j(d)
            # pad with extra occurrences up to (never past) pad_len
            while True:
                occ.append({"offset": len(occ),
                            "hash": sha(b"p%d" % len(occ))})
                nxt = _j(d)
                if len(nxt) > pad_len:
                    occ.pop()
                    break
                line = nxt
            return line.encode()
        good = auth_of("G36", 0, 64 * 1024 - 2)      # just under cap
        assert len(good) <= 64 * 1024
        self.seed(good + b"\n", path="authorizations.jsonl")
        self.led = self.mk()
        auths, mal = self.led._read_auths()
        self.assertFalse(mal)
        self.assertEqual([a["authId"] for a in auths], ["G36"])
        # now a huge line followed by megabytes: fail closed, early
        big = good + b" " * (64 * 1024 + 8)          # valid prefix, over cap
        assert len(big) > 64 * 1024
        d2 = tempfile.mkdtemp(prefix="p9m3-f36b-", dir=self.dir)
        fd = os.open(os.path.join(d2, "authorizations.jsonl"),
                     os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.write(fd, big + b"\n" + b"9" * (8 * 1024 * 1024))
        os.close(fd)
        led2 = Ledger(d2)
        auths2, mal2 = led2._read_auths()
        self.assertTrue(mal2)
        self.assertEqual(auths2, [])          # remainder never retained
        self.assertTrue(led2.classify()["authorization_file_malformed"])

    # ---------------------------------------------------------------- F37
    def test_F37_auth_inventory_cap(self):
        # v38 cycle-3 fix 4 (spec draft AUTH READER BOUNDS): 1024 valid
        # AUTHs are admitted; the 1025th valid line is malformed —
        # every authorization refused (fail closed).
        lines = []
        for i in range(AUTH_INVENTORY_CAP):
            d = {"t": "AUTH", "authId": "A%04d" % i, "occurrences": [],
                 "createdAt": 1700000000}
            lines.append(_j(d).encode())
        self.seed(b"\n".join(lines) + b"\n", path="authorizations.jsonl")
        self.led = self.mk()
        auths, mal = self.led._read_auths()
        self.assertFalse(mal)
        self.assertEqual(len(auths), AUTH_INVENTORY_CAP)
        extra = ('{"t":"AUTH","authId":"A9999","occurrences":[],'
                 '"createdAt":1700000000}').encode()
        self.seed(extra + b"\n", path="authorizations.jsonl")
        fresh = Ledger(self.dir)
        auths2, mal2 = fresh._read_auths()
        self.assertTrue(mal2)
        self.assertTrue(fresh.classify()["authorization_file_malformed"])

    # ---------------------------------------------------------------- F38
    def test_F38_strict_path_permissions_and_probe_dir_gate(self):
        # v38 cycle-3 fix 5 (AUD C3-5): startup check is STRICT (any
        # bit outside 0600 on a protocol file, group READ included) and
        # the probe validates the directory BEFORE any scratch write.
        self.led = self.mk()
        self.led.append_watermark("H1", 1, "G1")
        os.chmod(os.path.join(self.dir, "consumptions.jsonl"), 0o604)
        with self.assertRaises(LedgerError) as cm:
            Ledger(self.dir)
        self.assertEqual(cm.exception.code, "unsafe-path-permissions")
        os.chmod(os.path.join(self.dir, "consumptions.jsonl"), 0o600)
        d = tempfile.mkdtemp(prefix="p9m3-f38-", dir=self.dir)
        os.chmod(d, 0o755)                      # group/other access
        with self.assertRaises(FSProbeError) as cm:
            run_probe(d)
        self.assertEqual(str(cm.exception), "fs-probe-failed:dir-mode")
        # ZERO scratch trace left in a refused directory
        self.assertEqual([n for n in os.listdir(d)
                          if n.startswith(".probe-")], [])
        # fresh creation defeats a hostile umask (established 0700)
        old = os.umask(0o077)
        try:
            d2 = os.path.join(self.dir, "fresh-umask-case")
            run_probe(d2)
            self.assertEqual(os.stat(d2).st_mode & 0o777, 0o700)
        finally:
            os.umask(old)

    # ---------------------------------------------------------------- F39
    def test_F39_probe_exact_outcomes(self):
        # v38 cycle-3 fix 7 (AUD C3-7): leg 3 is BYTE EQUALITY (surplus
        # on fresh open fails); leg 4 verifies the destination carries
        # the source bytes (stale destination content fails).
        d1 = tempfile.mkdtemp(prefix="p9m3-f39a-", dir=self.dir)
        with self.assertRaises(FSProbeError) as cm:
            run_probe(d1, faults=FsFaults(append_leaves_extra_bytes=True))
        self.assertEqual(str(cm.exception), "fs-probe-failed:leg3")
        d2 = tempfile.mkdtemp(prefix="p9m3-f39b-", dir=self.dir)
        with self.assertRaises(FSProbeError) as cm:
            run_probe(d2, faults=FsFaults(rename_keeps_old_content=True))
        self.assertEqual(str(cm.exception), "fs-probe-failed:leg4")

    # ---------------------------------------------------------------- F40
    def test_F40_decision_append_gate_every_entry_point(self):
        # v38 cycle-3 fixes 1+6 (AUD C3-1/C3-6): the PUBLIC applied
        # append gates on the in-lock classification (zero bytes on
        # refusal), and the in-lock helper enforces its own held-lock
        # precondition and its own resolve-on-use.
        bad = CORRUPT + b"-f40"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        before = len(self.raw())
        with self.assertRaises(LedgerError) as cm:
            self.led.append_applied("A40")
        self.assertEqual(cm.exception.code, "decision-append-refused")
        self.assertEqual(len(self.raw()), before)     # ZERO bytes
        # helper without any held lock REFUSES before resolving
        with self.assertRaises(LedgerError) as cm:
            self.led.append_applied_in_lock("A40")
        self.assertEqual(cm.exception.code, "lock-required-not-held")
        # helper under the lock still resolves for itself: an injected
        # resolve failure refuses even though the caller "resolved"
        auth = self.led.authorize([self.occ(0, bad)], auth_id="A40a", test_only=True)
        self.led.repair(auth)                          # state -> ok
        self.led.faults.resolve_fsync_fault = True
        with self.assertRaises(LedgerError) as cm:
            with self.led._lock("append"):
                self.led.append_applied_in_lock("A40b")
        self.assertEqual(cm.exception.code, STATE_PENDING)
        self.assertNotIn("A40b", self.led.classify()["spent"])
        self.led.faults.resolve_fsync_fault = False
        import fcntl as _f
        # v38 cycle-4 fix 1 (AUD C4-F1): a FOREIGN flock fd is NOT a
        # capability here — even with the lock genuinely held on another
        # fd, the instance without its own acquisition REFUSES, zero
        # bytes (exclusion is per-instance, a declaration buys nothing).
        holder = os.open(self.led.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        _f.flock(holder, _f.LOCK_EX)
        with self.assertRaises(LedgerError) as cm:
            self.led.append_applied_in_lock("A40c")
        self.assertEqual(cm.exception.code, "lock-required-not-held")
        _f.flock(holder, _f.LOCK_UN)
        os.close(holder)
        self.assertNotIn("A40c", self.led.classify()["spent"])
        # ...and through the instance's OWN lock it succeeds
        with self.led._lock("append"):
            off = self.led.append_applied_in_lock("A40c")
        self.assertIsInstance(off, int)
        self.assertIn("A40c", self.led.classify()["spent"])

    # ---------------------------------------------------------------- F41
    def test_F41_failed_clean_requires_durable_resolution(self):
        # v38 cycle-3 fix 2 (AUD C3-2): a clean-looking write error is
        # FAILED only after the resolve sequence completes; a resolve
        # failure reports outcome-unknown; the ONE fresh (c-O) attempt
        # is enforced PERSISTENTLY (a second clean episode refuses
        # BEFORE writing, across a fresh process).
        bad = CORRUPT + b"-f41"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        auth = self.led.authorize([self.occ(0, bad)], auth_id="A41", test_only=True)
        before = len(self.raw())
        self.led.faults.write_raises = True
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth)
        self.assertEqual(cm.exception.code, "repair-failed-clean")
        self.assertEqual(len(self.raw()), before)
        self.assertNotIn(auth, self.led.classify()["spent"])
        # same AUTH, second clean episode: refused from the durable
        # journal INSIDE the attempt (prior >= 1)
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth)
        self.assertEqual(cm.exception.code, "repair-retry-exhausted")
        # a FRESH process refuses BEFORE any IO beyond resolve
        fresh = Ledger(self.dir)
        with self.assertRaises(LedgerError) as cm:
            fresh.repair(auth)
        self.assertEqual(cm.exception.code, "repair-retry-exhausted")
        self.assertEqual(len(fresh._read_bytes()), before)

    def test_F41b_clean_error_with_failing_resolve_is_unknown(self):
        # the FAILED verdict is never reported when the resolution
        # itself cannot complete: outcome-unknown, AUTH unspent.
        bad = CORRUPT + b"-f41b"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        auth = self.led.authorize([self.occ(0, bad)], auth_id="A41b", test_only=True)
        calls = {"n": 0}
        orig = self.led._resolve_io

        def flaky():
            calls["n"] += 1
            if calls["n"] == 2:          # the post-failure resolve fails
                raise OSError(5, "resolve-io refused")
            return orig()
        self.led._resolve_io = flaky
        self.led.faults.write_raises = True
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth)
        self.assertEqual(cm.exception.code, "repair-outcome-unknown")
        self.assertNotIn(auth, self.led.classify()["spent"])
        with open(os.path.join(self.dir, "consumptions.jsonl"), "rb") as _f:
            self.assertEqual(self.raw(), _f.read())


    # ---------------------------------------------------------------- F42
    def test_F42_foreign_fd_is_not_a_lock_capability(self):
        # v38 cycle-4 fix 1 (AUD C4-F1): a lock declaration (boolean or
        # a genuinely-held FOREIGN fd) is NOT an acquisition of this
        # instance — every un-acquired append refuses with ZERO bytes.
        # (Positive case stays in F40: through the instance's own lock
        # the same append succeeds.)
        import fcntl as _f
        self.led = self.mk()
        holder = os.open(self.led.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        _f.flock(holder, _f.LOCK_EX)           # genuinely held elsewhere
        before = len(self.raw())
        with self.assertRaises(LedgerError) as cm:
            self.led.append_applied_in_lock("A42")
        self.assertEqual(cm.exception.code, "lock-required-not-held")
        self.assertEqual(len(self.raw()), before)   # zero bytes
        # the raw write path is equally closed (v38 cycle-4 fix 7):
        # NO parameter or mode of _append_bytes skips the assertion
        with self.assertRaises(LedgerError) as cm:
            self.led._append_bytes(b"{applied}\n")
        self.assertEqual(cm.exception.code, "lock-required-not-held")
        self.assertEqual(len(self.raw()), before)
        _f.flock(holder, _f.LOCK_UN)
        os.close(holder)

    # ---------------------------------------------------------------- F43
    def test_F43_truncated_counter_never_rearms(self):
        # v38 cycle-4 fix 3 (AUD C4-F3): the counter record is FIXED
        # WIDTH (16 bytes) — SHORT existing files (torn creation or a
        # truncated rewrite), including prefixes of valid records, are
        # EXHAUSTED like every other corruption. MISSING stays (0,False).
        side = os.path.join(self.dir, "resolve-attempts")
        self.led = self.mk()
        for corpus in (b"0",                   # 1 byte
                       b"0 ",                  # torn before flag
                       b"0 -",                 # valid record, TRUNCATED
                       b"0 -\0",              # one byte short of 16
                       b"1234567890 -" + b"\0" * 5):   # 15: short
            fd = os.open(side, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.write(fd, corpus)
            os.close(fd)
            n, exh = Ledger(self.dir)._parse_counter()
            self.assertTrue(exh, "short file must be exhausted: %r" % corpus)
            self.assertGreater(n, 2)
        # the exact 16-byte record parses (unchanged behavior)
        fd = os.open(side, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, b"0 -" + b"\0" * 13)
        os.close(fd)
        self.assertEqual(Ledger(self.dir)._parse_counter(), (0, False))

    # ---------------------------------------------------------------- F44
    def test_F44_authorize_refuses_at_capacity_before_write(self):
        # v38 cycle-4 fix 5 (AUD C4-F5): at AUTH_INVENTORY_CAP the
        # writer refuses BEFORE any byte (`auth-inventory-full`) — the
        # reader bound means a 1025th valid line would make the whole
        # file malformed and refuse EVERY AUTH; authorize must never
        # create that terminal state itself.
        lines = []
        for i in range(AUTH_INVENTORY_CAP):
            d = {"t": "AUTH", "authId": "A%04d" % i, "occurrences": [],
                 "createdAt": 1700000000}
            lines.append(_j(d).encode())
        self.seed(b"\n".join(lines) + b"\n", path="authorizations.jsonl")
        self.led = self.mk()
        p = os.path.join(self.dir, "authorizations.jsonl")
        before = os.path.getsize(p)
        with self.assertRaises(LedgerError) as cm:
            self.led.authorize([], auth_id="A-1025", test_only=True)
        self.assertEqual(cm.exception.code, "auth-inventory-full")
        self.assertEqual(os.path.getsize(p), before)     # ZERO bytes
        # the existing inventory stays fully readable (not terminal)
        fresh = Ledger(self.dir)
        auths, mal = fresh._read_auths()
        self.assertFalse(mal)
        self.assertEqual(len(auths), AUTH_INVENTORY_CAP)

    # ---------------------------------------------------------------- F45
    def test_F45_journal_conservative_recovery(self):
        # v38 cycle-5 (owner decisions D1-A TOTAL-ATTEMPT CAP + D2-A
        # STRICT JOURNAL): every landed REPAIR-INTENT for an auth is one
        # consumed attempt (orphans included); the ONLY reset is a
        # VALID DURABLE repaired; ANY journal damage (torn line,
        # unterminated tail, over-cap) fails CLOSED as
        # `journal-unreadable` for every reader — no keyword heuristics.
        jp = os.path.join(self.dir, "repair_intent.jsonl")

        def write_journal(data):
            fd = os.open(jp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.write(fd, data)
            os.close(fd)
            return Ledger(self.dir)

        I = lambda a: ('{"t":"REPAIR-INTENT","authId":"%s","at":1}' % a).encode() + b"\n"
        F = lambda a: ('{"t":"REPAIR-OUTCOME","authId":"%s","outcome":"failed-clean","durable":false,"at":2}' % a).encode() + b"\n"
        R = lambda a: ('{"t":"REPAIR-OUTCOME","authId":"%s","outcome":"repaired","durable":true,"at":3}' % a).encode() + b"\n"

        self.led = self.mk()
        # healthy pairs count exactly once each (the INTENT), per auth
        led = write_journal(I("A1") + F("A1"))
        self.assertEqual(led._clean_failure_count("A1"), 1)
        self.assertEqual(led._clean_failure_count("A2"), 0)
        led = write_journal(I("A1") + F("A1") + I("A2") + F("A2"))
        self.assertEqual(led._clean_failure_count("A2"), 1)
        self.assertEqual(led._clean_failure_count("A1"), 1)
        # durable repaired resets ONLY its own auth
        led = write_journal(I("A1") + F("A1") + I("A1") + R("A1") + I("A2") + F("A2"))
        self.assertEqual(led._clean_failure_count("A1"), 0)
        self.assertEqual(led._clean_failure_count("A2"), 1)
        # crash-between-resolve-and-record: INTENT, no outcome => consumed
        led = write_journal(I("A1"))
        self.assertEqual(led._clean_failure_count("A1"), 1)
        # torn line => journal-unreadable (D2-A global refusal: an
        # undecidable record damages the whole bound, any auth)
        led = write_journal(b'{"t":"REPAIR-INTE{"authId":"A1","at"')
        with self.assertRaises(LedgerError) as cm:
            led._clean_failure_count("A1")
        self.assertEqual(cm.exception.code, "journal-unreadable")
        # unterminated tail => journal-unreadable regardless of naming
        led = write_journal(I("A1") + F("A1")
                            + b'{"t":"REPAIR-OUTCOME","authId":"A1","out')
        with self.assertRaises(LedgerError) as cm:
            led._clean_failure_count("A1")
        self.assertEqual(cm.exception.code, "journal-unreadable")
        led = write_journal(I("A1") + F("A1") + b'{"t":"REPAIR-O","authId":"A9')
        with self.assertRaises(LedgerError) as cm:
            led._clean_failure_count("A1")
        self.assertEqual(cm.exception.code, "journal-unreadable")
        # over-cap journal fails CLOSED
        led = write_journal(I("A1") + b"x" * (Ledger.JOURNAL_CAP + 1))
        with self.assertRaises(LedgerError) as cm:
            led._clean_failure_count("A1")
        self.assertEqual(cm.exception.code, "journal-unreadable")

    # ---------------------------------------------------------------- F49
    def test_F49_journal_strict_grammar_global_refusal(self):
        # v38 cycle-5 owner decision D2-A (closes the audit's
        # null-scalar crash): EVERY terminated line must be a JSON
        # OBJECT of a known kind with an EXACT key set and valid field
        # types. Non-object JSON (bare null/string/array), schema
        # violations, unknown kinds/outcomes, dangling symlink journal
        # => `journal-unreadable`, never AttributeError, never a
        # silently forgiven attempt. A `durable:false` "repaired" is
        # grammatically valid but resets NOTHING (audit finding 2).
        jp = os.path.join(self.dir, "repair_intent.jsonl")

        def write_journal(data):
            fd = os.open(jp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.write(fd, data)
            os.close(fd)
            return Ledger(self.dir)

        def unreadable(data):
            led = write_journal(data)
            try:
                n = led._clean_failure_count("A1")
            except LedgerError as e:
                self.assertEqual(e.code, "journal-unreadable",
                                 "corpus %r" % data)
                return
            self.fail("corpus accepted: %r (counted %r)" % (data, n))

        for corpus in (b'null\n', b'"x"\n', b'[1,2]\n', b'123\n', b'true\n',
                       b'{}\n',
                       b'{"t":"BOGUS","authId":"A1","at":1}\n',
                       # exact-key-set violations
                       b'{"t":"REPAIR-INTENT","authId":"A1"}\n',
                       b'{"t":"REPAIR-INTENT","authId":"A1","at":1,"x":2}\n',
                       b'{"t":"REPAIR-INTENT","authId":"","at":1}\n',
                       b'{"t":"REPAIR-INTENT","authId":7,"at":1}\n',
                       b'{"t":"REPAIR-INTENT","authId":"A1","at":"x"}\n',
                       b'{"t":"REPAIR-OUTCOME","authId":"A1","outcome":'
                       b'"repaired","durable":true}\n',              # no at
                       b'{"t":"REPAIR-OUTCOME","authId":"A1","outcome":'
                       b'"mystery","durable":true,"at":1}\n',        # bad enum
                       b'{"t":"REPAIR-OUTCOME","authId":"A1","outcome":'
                       b'"repaired","durable":"yes","at":1}\n'):     # bad bool
            unreadable(corpus)
        # dangling symlink is damage, NOT absence (ENOENT alone = fresh).
        # Use an instance built BEFORE the symlink appeared (the strict
        # path-permissions gate rejects a symlinked journal at
        # construction; this pin exercises the journal reader itself).
        link = os.path.join(self.dir, "impostor-dangling")   # never created
        led = self.mk()
        try:
            os.remove(jp)                        # previous write_journal
            os.symlink(link, jp)
            with self.assertRaises(LedgerError) as cm:
                led._clean_failure_count("A1")
            self.assertEqual(cm.exception.code, "journal-unreadable")
        finally:
            os.remove(jp)
        # empty journal file = zero records, valid, counts 0
        self.assertEqual(write_journal(b"")._clean_failure_count("A1"), 0)
        # durable:false "repaired" NEVER resets (audit finding 2):
        # intents still count; only durable True clears the bound.
        led = write_journal(
            b'{"t":"REPAIR-INTENT","authId":"A1","at":1}\n'
            b'{"t":"REPAIR-OUTCOME","authId":"A1","outcome":"repaired",'
            b'"durable":false,"at":2}\n'
            b'{"t":"REPAIR-INTENT","authId":"A1","at":3}\n')
        self.assertEqual(led._clean_failure_count("A1"), 2)
        led = write_journal(
            b'{"t":"REPAIR-INTENT","authId":"A1","at":1}\n'
            b'{"t":"REPAIR-OUTCOME","authId":"A1","outcome":"repaired",'
            b'"durable":true,"at":2}\n')
        self.assertEqual(led._clean_failure_count("A1"), 0)  # strict reset

    # ---------------------------------------------------------------- F50
    def test_F50_settle_in_lock_requires_own_acquisition(self):
        # v38 cycle-5 audit finding 1 (always-fix): `settle_in_lock`
        # was the one writer with NO acquisition check — a caller with
        # no lock settled bytes onto the ledger (reproduced: a fresh
        # instance turned `{unfinished` into `{unfinished\n`). Now it
        # verifies its own acquisition and refuses with ZERO bytes,
        # exactly like `_append_bytes` (F42).
        self.led = self.mk()
        self.seed(b"{unfinished")
        jp = os.path.join(self.dir, "consumptions.jsonl")
        with open(jp, "rb") as f:
            before = f.read()
        fresh = Ledger(self.dir)             # never acquired any lock
        with self.assertRaises(LedgerError) as cm:
            fresh.settle_in_lock()
        self.assertEqual(cm.exception.code, "lock-required-not-held")
        with open(jp, "rb") as f:            # ZERO bytes written
            self.assertEqual(f.read(), before)
        # positive control: under THIS instance's lock it settles fine
        with fresh._lock("append"):
            cls = fresh.settle_in_lock()
        with open(jp, "rb") as f:
            self.assertEqual(f.read(), before + b"\n")
        self.assertNotEqual(cls["state"], STATE_UNSETTLED)

    # ---------------------------------------------------------------- F51
    def test_F51_lock_identity_rules_out_fd_reuse(self):
        # v38 cycle-5 owner decision D4-B: `_lock_held` verifies the
        # stored fd still refers to the SAME file (dev/ino), so an fd
        # closed behind our back whose NUMBER is reused for a
        # different file is NOT accepted as "still held". (POSIX hands
        # out the lowest free fd, so the reuse below is deterministic.)
        self.led = self.mk()
        self.seed(b"y" * 30 + b"\n")
        with self.led._lock("append"):
            fd = self.led._lock_fd
            self.assertTrue(self.led._lock_held())
        # `with` exit closed the fd; the number is now free and POSIX
        # hands out the lowest free fd, so the reuse below is
        # deterministic: same NUMBER, different FILE.
        other = os.path.join(self.dir, "unrelated")
        reused = os.open(other, os.O_WRONLY | os.O_CREAT, 0o600)
        self.assertEqual(reused, fd)          # number recycled, file new
        self.led._lock_fd, self.led._lock_who = reused, "append"
        self.led._lock_stat = os.stat(self.led.lock_path)  # stale identity
        self.assertFalse(self.led._lock_held())
        before = len(self.raw())
        with self.assertRaises(LedgerError) as cm:
            self.led._append_bytes(b"{x}\n")
        self.assertEqual(cm.exception.code, "lock-required-not-held")
        self.assertEqual(len(self.raw()), before)         # ZERO bytes
        os.close(reused)

    # ---------------------------------------------------------------- F52
    def test_F52_probe_census_has_no_cwd_side_effect(self):
        # v38 cycle-5 owner decision D3-B: the probe census runs
        # THROUGH the validated dir fd (os.scandir) — the process-wide
        # fchdir/chdir round-trip is GONE, so a multi-threaded host
        # process is never exposed (another thread could do relative
        # I/O against the probe dir mid-sweep, and restore-by-name
        # could fail after a rename). Pin: getcwd identical across a
        # full healthy probe.
        cwd_before = os.getcwd()
        d = tempfile.mkdtemp(prefix="p9m3-cwd-", dir=self.dir)
        run_probe(d, fstype="local")
        self.assertEqual(os.getcwd(), cwd_before)
        # STATIC (mutation-caught): fchdir-restore is invisible to a
        # serial observer, so the SOURCE is pinned — probe.py must
        # contain no chdir of any form; the census is os.scandir(fd).
        import inspect
        import p9m3.probe as probe_mod
        psrc = inspect.getsource(probe_mod)
        for pat in ("fchdir", "os.chdir", "chdir("):
            self.assertNotIn(pat, psrc,
                             "probe.py must never chdir: found %r" % pat)
        self.assertIn("os.scandir(dir_fd)", psrc)
        # and relative paths still resolve against the ORIGINAL cwd
        marker = ".p9m3-rel-probe-marker"
        try:
            with open(marker, "w") as f:
                f.write("x")
            self.assertTrue(os.path.exists(os.path.join(cwd_before, marker)))
        finally:
            os.remove(os.path.join(cwd_before, marker))

    # ------------------------------------------- F53 (v40, R3-c3 CODE-1)
    def test_F53_authorize_authid_freshness(self):
        # R3-c3 CODE-1: the production authorization path MINTS a fresh
        # ULID; a caller-chosen authId is a test-only seam and can
        # never reuse an ID already present in the AUTH file or named
        # by ANY terminated schema-valid record in the consumption log
        # (closes DEAD-REPAIR activation and AUTH-id duplication).
        bad = CORRUPT + b"-f53"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        occs = [self.occ(0, bad)]
        # (1) caller-chosen WITHOUT the test-only seam => refused, zero bytes
        authp = os.path.join(self.dir, "authorizations.jsonl")
        before = os.path.getsize(authp) if os.path.exists(authp) else 0
        with self.assertRaises(LedgerError) as cm:
            self.led.authorize(occs, auth_id="CALLER1")
        self.assertEqual(cm.exception.code, "auth-id-caller-chosen-forbidden")
        after = os.path.getsize(authp) if os.path.exists(authp) else 0
        self.assertEqual(after, before, "refused authorize wrote bytes")
        # (2) production authorize mints a fresh ULID (no caller id)
        aid = self.led.authorize(occs)
        self.assertTrue(aid)
        # (3) test-only seam refusing an id ALREADY in the AUTH file
        with self.assertRaises(LedgerError) as cm:
            self.led.authorize(occs, auth_id=aid, test_only=True)
        self.assertEqual(cm.exception.code, "auth-id-exists")
        # (4) DEAD-REPAIR activation path: a REPAIR naming DEADX with
        # no matching AUTH is DEAD (unknown-authId). authorize to match
        # it is refused even WITH the test-only seam: the log already
        # names the id.
        repair = ('{"t":"REPAIR","authId":"DEADX","masks":%s,"all":'
                  '{"hostToken":"ALL","watermark":0,"confirmGen":"GEN0"}}'
                  % _j(occs)).encode()
        self.seed(b"\n" + repair + b"\n")
        c = self.led.classify()
        self.assertIn("unknown-authId",
                      [x["reason"] for x in c["dead_repairs"]])
        with self.assertRaises(LedgerError) as cm:
            self.led.authorize(occs, auth_id="DEADX", test_only=True)
        self.assertEqual(cm.exception.code, "auth-id-already-used")
        # (5) an APPLIED line's authId is also 'already used'
        self.seed(b'{"t":"APPLIED","authId":"APL53"}\n')
        with self.assertRaises(LedgerError) as cm:
            self.led.authorize([self.occ(0, bad)], auth_id="APL53",
                               test_only=True)
        self.assertEqual(cm.exception.code, "auth-id-already-used")
        # (6) the production-minted id can never BE DEADX, and the
        # pre-existing DEAD REPAIR stays DEAD no matter how many AUTHs
        # exist (freshness never activates it).
        c = self.led.classify()
        self.assertIn("unknown-authId",
                      [x["reason"] for x in c["dead_repairs"]])
        self.assertNotEqual(aid, "DEADX")

    # ------------------------------------------- F54 (v40, R3-c3 CODE-2)
    def test_F54_unreadable_log_classifies_unknown_fail_closed(self):
        # R3-c3 CODE-2: stage 1 says an unreadable consumption log is
        # `unknown` — classification must NOT raise raw OSError, and
        # binding promotion must not execute its callback.
        self.seed(b"\n" + b'{"t":"APPLIED","authId":"U1"}' + b"\n")
        self.led = self.mk()
        for seam in ("open_raises", "read_raises"):
            setattr(self.led.faults, seam, True)
            c = self.led.classify()
            self.assertEqual(c["state"], STATE_UNKNOWN, seam)
            st = self.led.status()
            self.assertEqual(st["classification"], STATE_UNKNOWN, seam)
            ran = []
            r = self.led.promote(lambda: ran.append(1) or {"allowed": True})
            self.assertFalse(r["allowed"], seam)
            self.assertEqual(ran, [], "%s: callback executed" % seam)
            self.assertFalse(self.led.promotion_allowed(), seam)
            setattr(self.led.faults, seam, False)
        # recovery: reads classify normally again
        self.assertEqual(self.led.classify()["state"], STATE_OK)
        # ENOENT-as-empty is preserved (no file => empty, OK — not unknown)
        led2 = self.mk()
        os.remove(os.path.join(self.dir, "consumptions.jsonl"))
        self.assertEqual(led2.classify()["state"], STATE_OK)

    # ------------------------------------------- F55 (v40, inline F-A1)
    def test_F55_minted_authid_collision_checked_under_lock(self):
        # INLINE-AUDIT F-A1: freshness must be enforced on the PRODUCTION
        # mint path too, not just the test-only seam. Force the generator
        # to collide: (a) collide with a pre-existing AUTH id, (b) with a
        # log-named id (DEAD REPAIR), and prove the bounded retry either
        # moves past a transient collision or refuses FAIL-CLOSED
        # (`auth-id-mint-collision`, zero bytes) — never writes a
        # duplicate id.
        import unittest.mock as mock
        import p9m3.ledger as lmod
        bad = CORRUPT + b"-f55"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        occs = [self.occ(0, bad)]
        aid = self.led.authorize(occs)          # production mint
        authp = os.path.join(self.dir, "authorizations.jsonl")
        # (a) persistent collision with the existing AUTH => refuse, 0 bytes
        size0 = os.path.getsize(authp)
        with mock.patch.object(lmod, "_mint_ulid", return_value=aid):
            with self.assertRaises(LedgerError) as cm:
                self.led.authorize(occs)
        self.assertEqual(cm.exception.code, "auth-id-mint-collision")
        self.assertEqual(os.path.getsize(authp), size0,
                         "refused mint wrote bytes")
        # (b) persistent collision with a DEAD REPAIR's log-named id
        repair = ('{"t":"REPAIR","authId":"HOSTILE1","masks":%s,"all":'
                  '{"hostToken":"ALL","watermark":0,"confirmGen":"GEN0"}}'
                  % _j(occs)).encode()
        self.seed(b"\n" + repair + b"\n")
        with mock.patch.object(lmod, "_mint_ulid", return_value="HOSTILE1"):
            with self.assertRaises(LedgerError) as cm:
                self.led.authorize(occs)
        self.assertEqual(cm.exception.code, "auth-id-mint-collision")
        self.assertEqual(os.path.getsize(authp), size0,
                         "refused mint (log-named) wrote bytes")
        # (c) transient collision: first candidate collides, second is
        # fresh => authorize SUCCEEDS on the retry with the fresh id.
        # NOTE: a DIFFERENT occurrence list — re-authorizing the SAME
        # list as the unspent AUTH hits `authorization-replay` first.
        bad2 = CORRUPT + b"-f55b"
        off2 = os.path.getsize(os.path.join(self.dir, "consumptions.jsonl"))
        self.seed(b"\n" + bad2 + b"\n")
        seq = iter([aid, "FRESHF55CAND2TTTTTTTTTTTTTT"])
        with mock.patch.object(lmod, "_mint_ulid", side_effect=lambda: next(seq)):
            new_id = self.led.authorize([self.occ(off2 + 1, bad2)])
        self.assertEqual(new_id, "FRESHF55CAND2TTTTTTTTTTTTTT")
        self.assertNotEqual(new_id, aid)

    # ------------------------------------------- F57 (v41, R4-c2-1)
    def test_F57_cap_refusal_preflight_no_intent_no_attempt(self):
        # R4-c2-1: a repair() refused by the LOG CAP must consume NOTHING
        # — no ledger byte, no REPAIR-INTENT in the journal — because the
        # D1-A attempt definition is a LANDED intent. Previously the
        # intent landed before the cap check inside _append_bytes, so two
        # cap refusals (zero ledger bytes) exhausted the two-attempt
        # allowance. Now: refusal, journal byte-identical & no new intent
        # for the auth; and after capacity is restored the SAME AUTH
        # still repairs (allowance untouched).
        bad = CORRUPT + b"-f57"
        self.seed_at([(0, bad)])
        led = self.mk()
        auth = led.authorize([self.occ(0, bad)], auth_id="A57",
                             test_only=True)
        jp = os.path.join(self.dir, "repair_intent.jsonl")
        led.faults.size_override = LOG_CAP - 10   # any REPAIR crosses
        for _ in range(3):
            with self.assertRaises(LedgerError) as cm:
                led.repair(auth)
            self.assertEqual(cm.exception.code, "log-cap-exceeded")
        jdata = open(jp, "rb").read() if os.path.exists(jp) else b""
        self.assertNotIn(b"A57", jdata,
                         "cap refusal journaled an intent (R4-c2-1)")
        size0 = os.path.getsize(os.path.join(self.dir, "consumptions.jsonl"))
        self.assertEqual(size0, 1 + len(bad), "cap refusal wrote ledger bytes")
        led.faults.size_override = None            # capacity restored
        self.assertEqual(led.repair(auth)["outcome"], "repaired",
                         "allowance was consumed by zero-byte refusals")

    # ------------------------------------------- F58 (owner S-J3-C)
    def test_F58_clock_beyond_12_digits_keeps_admitted_outcome(self):
        # S-J3-C: a clock jumping beyond 12 digits between an admitted
        # intent and its outcome must NOT lose the outcome. The clamp
        # keeps every `at` at AT_MAX, so the outcome lands durable and
        # the journal reads back.
        from unittest import mock
        self.seed_at([(0, CORRUPT + b"-f58")])
        led = self.mk()
        auth = led.authorize([self.occ(0, CORRUPT + b"-f58")],
                             auth_id="A58", test_only=True)
        real_now = int(time.time())
        state = {"n": 0}
        def fake_now():
            state["n"] += 1
            return real_now if state["n"] == 1 else 10 ** 13 + 5
        with mock.patch("p9m3.ledger.time.time", side_effect=fake_now):
            self.assertEqual(led.repair(auth)["outcome"], "repaired",
                             "outcome refused by an out-of-range clock")
        jp = os.path.join(self.dir, "repair_intent.jsonl")
        with open(jp, "rb") as f:
            lines = [json.loads(x) for x in f.read().splitlines()]
        oc = [r for r in lines if r["t"] == "REPAIR-OUTCOME"
              and r["authId"] == "A58"]
        self.assertEqual(len(oc), 1, "admitted intent lost its outcome")
        self.assertEqual(oc[0]["outcome"], "repaired")
        self.assertIs(oc[0]["durable"], True)
        self.assertEqual(oc[0]["at"], 10 ** 12 - 1, "clamp not applied")
        led2 = self.mk()
        led2.status()
        self.assertEqual(led2._clean_failure_count("A58"), 0)

    def test_F59_reserve_is_exact_at_the_journal_cap_boundary(self):
        # S-J3-C: the reserve is EXACT. Fill the journal so that the
        # intent fits ONLY if the reserve is exactly the outcome size.
        # One byte less of cap ⇒ refused with zero bytes (no intent);
        # the exact cap ⇒ the intent is admitted AND its outcome (even
        # with a clock beyond 12 digits) lands. This kills a reserve that
        # is one byte short (the bug found by the owner-directed audit).
        import json as _json
        def line(rec):
            return _json.dumps(rec, separators=(",", ":")).encode() + b"\n"
        intent = {"t": "REPAIR-INTENT", "authId": "A59",
                  "at": 10 ** 12 - 1}
        worst_out = {"t": "REPAIR-OUTCOME", "authId": "A59",
                     "outcome": "outcome-unknown", "durable": False,
                     "at": 10 ** 12 - 1}
        exact = len(line(intent)) + len(line(worst_out))
        jp = os.path.join(self.dir, "repair_intent.jsonl")
        led = self.mk()
        led.JOURNAL_CAP = exact - 1
        with self.assertRaises(LedgerError) as cm:
            led._journal_append(intent)
        self.assertEqual(cm.exception.code, "journal-full")
        self.assertFalse(os.path.exists(jp) and os.path.getsize(jp) > 0)
        led = self.mk()
        led.JOURNAL_CAP = exact
        led._journal_append(intent)
        # outcome with an out-of-range clock is clamped to the worst size
        led._journal_append({"t": "REPAIR-OUTCOME", "authId": "A59",
                             "outcome": "outcome-unknown",
                             "durable": False, "at": 10 ** 13})
        self.assertEqual(os.path.getsize(jp), exact)

    # ------------------------------------------- F56 (v40, inline F-A2)
    def test_F56_minted_id_is_conforming_ulid(self):
        # INLINE-AUDIT F-A2: `_mint_ulid` must emit a CONFORMING ULID —
        # 26 Crockford-base32 chars decoding to a 128-bit value whose
        # top 48 bits are epoch-ms and low 80 bits random. The old
        # random-26 generator violated both the alphabet-range (values
        # could exceed 2^128) and the timestamp contract.
        from p9m3.ledger import _mint_ulid, _ULID_ALPHABET
        alpha = set(_ULID_ALPHABET)
        CR = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        before = int(time.time() * 1000)
        ids = [_mint_ulid() for _ in range(200)]
        after = int(time.time() * 1000)
        for uid in ids:
            self.assertEqual(len(uid), 26)
            self.assertTrue(set(uid) <= alpha, uid)
            val = 0
            for ch in uid:
                val = (val << 5) | CR.index(ch)
            self.assertLess(val, 1 << 128, "ULID exceeds 128 bits")
            ts = val >> 80
            self.assertGreaterEqual(ts, before - 1000)
            self.assertLessEqual(ts, after + 1000,
                                 "48-bit timestamp prefix out of range")
        # uniqueness across 200 mints (birthday over 80 random bits is
        # nil; a duplicate means a broken CSPRNG call)
        self.assertEqual(len(set(ids)), 200)
        # and time-ordering across MILLISECONDS: the id minted later
        # (strictly larger ts) is lexicographically greater.
        time.sleep(0.002)
        u1 = _mint_ulid()
        time.sleep(0.002)
        u2 = _mint_ulid()
        self.assertLess(u1, u2, "ULID timestamp prefix must order ids")

    # ---------------------------------------------------------------- F46
    def test_F46_status_exhaustion_overlay_beats_pending(self):
        # v38 cycle-4 fix 6 (AUD C4-F6): with a pending window AND an
        # exhausted counter, status reports EXHAUSTED — the binding
        # path (promote) refuses on exhaustion unconditionally, so the
        # informational view must never show `ok`/`pending` instead
        # (RESOLVE BOUND: no two readers may disagree).
        self.seed(b"y" * 40 + b"\n")
        self.led = self.mk()
        self.led.faults.fsync_fault = True
        with self.assertRaises(OSError):
            self.led.append_watermark("H1", 1, "G1")   # pending window
        self.led.faults.fsync_fault = False
        side = os.path.join(self.dir, "resolve-attempts")
        fd = os.open(side, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, b"3 X" + b"\0" * 12)              # valid: flag X
        os.close(fd)
        fresh = Ledger(self.dir)
        self.assertTrue(fresh.durability_pending())
        self.assertEqual(fresh.status()["decision"], STATE_EXHAUSTED)
        st = fresh.status()
        self.assertTrue(st["durability_pending"])       # info retained
        self.assertFalse(fresh.promotion_allowed())

    # ---------------------------------------------------------------- F47
    def test_F47_protocol_paths_never_follow_symlinks(self):
        # v38 cycle-4 fix 4 (AUD C4-F4): every protocol-file open uses
        # O_NOFOLLOW — an impostor symlink at any protocol path fails
        # closed (ELOOP / journal-unreadable), never reading or writing
        # through the link. Full dirfd-anchoring is documented residual
        # risk; NOFOLLOW closes the replace-with-symlink window.
        self.led = self.mk()
        self.seed(b"")                    # create the real ledger file
        # real files first
        with self.led._lock("seed"):
            self.led._append_bytes(b"{\"t\":\"APPLIED\",\"id\":\"A47a\"}")
        # the sidecars are created on first resolve
        self.led.classify()
        link = os.path.join(self.dir, "impostor")
        with open(link, "w") as f:
            f.write("through")
        os.chmod(link, 0o600)
        # startup refuses a symlinked protocol path (lstat, never follow)
        for proto in (self.led.ledger_path, self.led.auth_path,
                      self.led._pending_side, self.led._attempts_side,
                      self.led.lock_path):
            if not os.path.lexists(proto):
                pass                        # nothing to replace; symlink in
            else:
                os.remove(proto)
            os.symlink(link, proto)
            try:
                with self.assertRaises(LedgerError) as cm:
                    Ledger(self.dir)
                self.assertEqual(cm.exception.code, "unsafe-path-permissions")
                # a live instance also never touches through the link
                # (defense in depth: every op is O_NOFOLLOW)
                with open(link) as _f:
                    self.assertEqual(_f.read(), "through")
            finally:
                os.remove(proto)
        os.remove(link)

    # ---------------------------------------------------------------- F48
    def test_F48_repair_journal_durability_contract(self):
        # v38 cycle-4 fix 2 (AUD C4-F2): journal appends go through the
        # checked-write helper (short-write loop + fsync + dir-fsync on
        # create, O_NOFOLLOW). Behavior pin: after a clean failed
        # repair the outcome line is present and PAIRED (intent +
        # failed-clean), so a fresh process counts exactly one prior
        # attempt -> second episode refuses before writing.
        bad = CORRUPT + b"-f48"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        auth = self.led.authorize([self.occ(0, bad)], auth_id="A48", test_only=True)
        self.led.faults.write_raises = True
        with self.assertRaises(LedgerError) as cm:
            self.led.repair(auth)
        self.assertEqual(cm.exception.code, "repair-failed-clean")
        with open(os.path.join(self.dir, "repair_intent.jsonl"), "rb") as _f:
            jdata = _f.read()
        self.assertIn(b"REPAIR-INTENT", jdata)
        self.assertIn(b"failed-clean", jdata)
        self.assertTrue(jdata.endswith(b"\n"))     # framing: terminated
        fresh = Ledger(self.dir)
        self.assertEqual(fresh._clean_failure_count(auth), 1)
        fresh.faults.write_raises = True      # second clean episode too
        with self.assertRaises(LedgerError) as cm:
            fresh.repair(auth)
        self.assertEqual(cm.exception.code, "repair-retry-exhausted")


class TestV38Cycle6Audit(Base):
    """v38 cycle-6 (GPT Terra audit of cycle-5 build): global journal
    refusal on EVERY decision path, plus the parser fixes. Each test
    reverts-to-red on its own fix."""

    JP = "repair_intent.jsonl"

    def _journal(self, data):
        p = os.path.join(self.dir, self.JP)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        return Ledger(self.dir)

    def test_C6_1_decision_paths_refuse_on_damaged_journal(self):
        # audit blocker: a damaged journal must serve NO decision and
        # the promotion callback must never run.
        led = self._journal(b"null\n")
        with self.assertRaises(LedgerError) as cm:
            led.status()
        self.assertEqual(cm.exception.code, "journal-unreadable")
        self.assertIs(led.promotion_allowed(), False)
        ran = []
        res = led.promote(lambda: ran.append(1) or "ran")
        self.assertEqual(res, {"allowed": False,
                               "decision": "journal-unreadable"})
        self.assertEqual(ran, [], "promotion callback executed on damage")

    def test_C6_2_malformed_outcome_types_are_typed_refusals(self):
        # audit finding 2: unhashable outcome => TypeError before fix
        for bad in (b'[]', b'{}', b'1', b'null'):
            led = self._journal(
                b'{"t":"REPAIR-OUTCOME","authId":"A1","outcome":' + bad +
                b',"durable":true,"at":1}\n')
            with self.assertRaises(LedgerError) as cm:
                led._clean_failure_count("A1")
            self.assertEqual(cm.exception.code, "journal-unreadable",
                             "outcome %r" % bad)

    def test_C6_3_read_error_is_typed_journal_unreadable(self):
        # audit finding 3: a raw OSError from os.read escaped the contract
        from unittest import mock
        led = self._journal(b'{"t":"REPAIR-INTENT","authId":"A1","at":1}\n')
        with mock.patch("p9m3.ledger.os.read",
                        side_effect=OSError(5, "EIO (injected)")):
            with self.assertRaises(LedgerError) as cm:
                led._clean_failure_count("A1")
        self.assertEqual(cm.exception.code, "journal-unreadable")

    def test_C6_4_blank_physical_line_is_damage_empty_file_is_valid(self):
        # audit finding 4: a blank TERMINATED line is not a record
        for bad in (b"\n", b'{"t":"REPAIR-INTENT","authId":"A1","at":1}\n\n'):
            led = self._journal(bad)
            with self.assertRaises(LedgerError) as cm:
                led._clean_failure_count("A1")
            self.assertEqual(cm.exception.code, "journal-unreadable",
                             "corpus %r" % bad)
        # the zero-byte FILE is the one valid empty journal
        self.assertEqual(self._journal(b"")._clean_failure_count("A1"), 0)

    def test_C6_5_every_public_entry_refuses_on_damage_zero_bytes(self):
        # audit C1-1: EVERY decision/append entry point refuses on a
        # damaged journal and writes ZERO decision bytes.
        led = self._journal(b"bad\n")
        ledger_before = os.path.exists(led.ledger_path) and \
            open(led.ledger_path, "rb").read() or b""
        for name, call in (
            ("resolve", lambda: led.resolve()),
            ("settle", lambda: led.settle()),
            ("repair", lambda: led.repair("A1")),
            ("append_applied", lambda: led.append_applied("A1")),
            ("append_applied_in_lock",
             lambda: led.promote(lambda: led.append_applied_in_lock("A1"))),
        ):
            with self.subTest(entry=name):
                try:
                    out = call()
                except LedgerError as e:
                    self.assertIn(e.code, ("journal-unreadable",
                                           "decision-append-refused"),
                                  name)
                else:
                    # promote returns a refusal dict instead of raising
                    self.assertEqual(out.get("decision"),
                                     "journal-unreadable", name)
        ledger_after = os.path.exists(led.ledger_path) and \
            open(led.ledger_path, "rb").read() or b""
        self.assertEqual(ledger_before, ledger_after,
                         "a damaged-journal entry point wrote ledger bytes")

    def test_C6_6_constructor_probe_faults_refuse_startup(self):
        # audit C1-3: a failing probe fault injected through the
        # CONSTRUCTOR must refuse startup, not be silently ignored.
        from p9m3.probe import FSProbeError
        d = os.path.join(self.dir, "probed")
        with self.assertRaises(FSProbeError):
            Ledger(d, faults=FsFaults(fsync_visibility_fails=True))

    def test_C6_7_identified_fuse_refused_at_leg1(self):
        # audit C1-4: FS PROFILE — FUSE-family is OUT OF CONTRACT. An
        # identified fuse type is refused at leg 1; a mount that only
        # REPORTS local is still judged by behavior (not refused here).
        from p9m3.probe import FSProbeError, _leg1_local_fstype, \
            _is_network_type
        for t in ("fuse", "fuse.sshfs", "fuse.s3fs"):
            self.assertTrue(_is_network_type(t), t)
            with self.assertRaises(FSProbeError, msg=t):
                _leg1_local_fstype("local",
                                   faults=FsFaults(simulated_fstype=t))
        # the behavioral path still admits a truthful local report
        _leg1_local_fstype("local", faults=FsFaults(simulated_fstype="ext4"))

    def test_C6_8_journal_writer_never_crosses_read_cap(self):
        # audit C1-2: the writer refuses before the journal can exceed the
        # reader's cap; a refused append writes ZERO bytes and the journal
        # stays readable.
        led = self.mk()
        led.JOURNAL_CAP = 200
        jp = os.path.join(self.dir, "repair_intent.jsonl")
        refused = False
        for _ in range(50):
            try:
                led._log_repair_intent("A1")
            except LedgerError as e:
                self.assertEqual(e.code, "journal-full")
                refused = True
                break
        self.assertTrue(refused, "writer never refused at cap")
        with open(jp, "rb") as f:
            before = f.read()
        self.assertLessEqual(len(before), 200)
        # still readable: refusal must not poison the journal
        led._clean_failure_count("A1")
        # an intent must leave room for its outcome: refusal happens
        # BEFORE the intent lands, so no unrecordable REPAIR can exist.
        with self.assertRaises(LedgerError):
            led._log_repair_intent("A1")
        with open(jp, "rb") as f:
            self.assertEqual(f.read(), before, "refused append wrote bytes")

    def test_C6_9_leg2_refuses_non_excluding_flock(self):
        # audit C1-5 (spec sharpening): a round-trip-only flock that never
        # excludes a competing descriptor must FAIL leg 2. Simulated by
        # making fcntl.flock succeed unconditionally for the competitor.
        from unittest import mock
        import fcntl as _fcntl
        from p9m3.probe import FSProbeError
        real = _fcntl.flock
        def non_excluding(fd, op):
            if op & _fcntl.LOCK_NB:        # competitor's nonblocking try
                return None                 # pretends success: no exclusion
            return real(fd, op)
        with mock.patch("p9m3.probe.fcntl.flock", side_effect=non_excluding):
            with self.assertRaises(FSProbeError) as cm:
                run_probe(os.path.join(self.dir, "nx"), fstype="local")
        self.assertEqual(str(cm.exception), "fs-probe-failed:leg2")
        # healthy flock still passes the same probe
        run_probe(os.path.join(self.dir, "ok"), fstype="local")

    def test_C6_10_settle_in_lock_refuses_on_damage_zero_bytes(self):
        # audit C2-1: settle_in_lock (own lock held) must refuse on a
        # damaged journal and write NOTHING to the ledger.
        led = self._journal(b"bad\n")
        with open(os.path.join(self.dir, "consumptions.jsonl"), "wb") as f:
            f.write(b"bad")
        with led._lock("append"):
            with self.assertRaises(LedgerError) as cm:
                led.settle_in_lock()
        self.assertEqual(cm.exception.code, "journal-unreadable")
        with open(os.path.join(self.dir, "consumptions.jsonl"), "rb") as f:
            self.assertEqual(f.read(), b"bad", "settle wrote through damage")

    def test_C6_11_leg2_only_contention_errno_excludes(self):
        # audit C2-3: an EIO from the competing flock is NOT exclusion.
        import errno as _errno
        from unittest import mock
        import fcntl as _fcntl
        from p9m3.probe import FSProbeError
        real = _fcntl.flock
        def eio_competitor(fd, op):
            if op & _fcntl.LOCK_NB:
                raise OSError(_errno.EIO, "I/O error (injected)")
            return real(fd, op)
        with mock.patch("p9m3.probe.fcntl.flock", side_effect=eio_competitor):
            with self.assertRaises(FSProbeError) as cm:
                run_probe(os.path.join(self.dir, "eio"), fstype="local")
        self.assertEqual(str(cm.exception), "fs-probe-failed:leg2")

    def test_C6_12_deep_or_huge_journal_is_journal_unreadable(self):
        # audit C2-4: decoder RecursionError / ValueError are damage.
        # deep nesting raises RecursionError inside json.loads: damage.
        # (A very large but well-formed integer is VALID JSON and is not
        # damage — it is excluded from this corpus on purpose.)
        for data in (b"[" * 100000 + b"\n",):
            led = self._journal(data)
            with self.assertRaises(LedgerError) as cm:
                led.status()
            self.assertEqual(cm.exception.code, "journal-unreadable")

    def test_C6_13_intent_refused_when_outcome_cannot_fit(self):
        # audit C2-2/C3-1: the RESERVE is the worst-case outcome width. A
        # cap that fits the intent but not intent + reserve refuses the
        # intent with ZERO bytes; a cap fitting intent + reserve admits it.
        led = self.mk()
        intent = json.dumps({"t": "REPAIR-INTENT", "authId": "A1",
                             "at": 1234567890}, separators=(",", ":")).encode() + b"\n"
        reserve = json.dumps({"t": "REPAIR-OUTCOME", "authId": "A1",
                              "outcome": "outcome-unknown", "durable": False,
                              "at": 10 ** 11}, separators=(",", ":")).encode() + b"\n"
        jp = os.path.join(self.dir, "repair_intent.jsonl")
        led.JOURNAL_CAP = len(intent) + len(reserve) - 1
        with self.assertRaises(LedgerError) as cm:
            led._log_repair_intent("A1")
        self.assertEqual(cm.exception.code, "journal-full")
        self.assertFalse(os.path.exists(jp) and os.path.getsize(jp) > 0,
                         "refused intent wrote bytes")
        led.JOURNAL_CAP = len(intent) + len(reserve)
        led._log_repair_intent("A1")
        self.assertEqual(led._clean_failure_count("A1"), 1)

    def test_C6_14_foreign_probe_name_neither_refuses_nor_is_deleted(self):
        # audit C3-2: a leftover/foreign .probe-* file must not make healthy
        # storage refuse startup, and the probe must not delete it.
        d = os.path.join(self.dir, "pf")
        os.makedirs(d, mode=0o700)
        foreign = os.path.join(d, ".probe-unrelated")
        with open(foreign, "wb") as f:
            f.write(b"someone else's")
        run_probe(d, fstype="local")          # must NOT raise leg4
        self.assertTrue(os.path.exists(foreign), "probe deleted a foreign file")

    def test_C6_15_helper_refuses_on_damage_with_own_lock(self):
        # audit C3-3: append_applied_in_lock's OWN gate, called under the
        # instance's own lock (not via a promote callback that refuses first).
        led = self._journal(b"bad\n")
        with led._lock("append"):
            with self.assertRaises(LedgerError) as cm:
                led.append_applied_in_lock("A1")
        self.assertEqual(cm.exception.code, "journal-unreadable")
        self.assertEqual(led.raw_bytes() if hasattr(led, "raw_bytes") else
                         (open(led.ledger_path, "rb").read()
                          if os.path.exists(led.ledger_path) else b""), b"")

    def test_C6_16_outcome_appended_after_timestamp_rollover(self):
        # audit C3-1: the reserve must cover the WIDEST outcome timestamp
        # (12 digits), not the intent's own width. The cap below admits an
        # intent whose 12-digit reserve fits, and refuses one that does not.
        # Under a mutant reserve that uses the intent's width (or 1 digit),
        # the intent is admitted and the later outcome cannot be recorded.
        now = int(time.time())
        intent_bytes = len(json.dumps({"t": "REPAIR-INTENT", "authId": "A1",
                                       "at": now},
                                      separators=(",", ":")).encode()) + 1
        reserve12 = len(json.dumps({"t": "REPAIR-OUTCOME", "authId": "A1",
                                    "outcome": "outcome-unknown",
                                    "durable": False, "at": 10 ** 11},
                                   separators=(",", ":")).encode()) + 1
        reserve_narrow = len(json.dumps({"t": "REPAIR-OUTCOME", "authId": "A1",
                                         "outcome": "outcome-unknown",
                                         "durable": False, "at": now},
                                        separators=(",", ":")).encode()) + 1
        self.assertGreater(reserve12, reserve_narrow)   # discrimination exists
        cap = intent_bytes + reserve_narrow             # too small for 12-digit
        led = self.mk()
        led.JOURNAL_CAP = cap
        with self.assertRaises(LedgerError) as cm:
            led._log_repair_intent("A1")
        self.assertEqual(cm.exception.code, "journal-full")
        # the real 12-digit reserve admits it and the outcome is recordable
        led.JOURNAL_CAP = intent_bytes + reserve12
        led._log_repair_intent("A1")
        led._journal_append({"t": "REPAIR-OUTCOME", "authId": "A1",
                             "outcome": "outcome-unknown", "durable": False,
                             "at": now + 1})
        self.assertEqual(led._clean_failure_count("A1"), 1)

    def test_C6_17_partial_auth_write_is_never_success(self):
        # audit C4-2: a short AUTH write must NEVER return an authorization.
        # The protocol forbids truncation (F10), so a partial line can
        # remain; the reader then classifies the AUTH file malformed and
        # refuses decisions. The residual is the SPEC question S-A1 (how
        # an operator recovers a partial AUTH line). This pin asserts the
        # CODE-level guarantee only: the call fails and returns no id.
        from unittest import mock
        led = self.mk()
        real_write = os.write
        calls = {"n": 0}
        def one_byte(fd, data):
            calls["n"] += 1
            return real_write(fd, data[:1]) if calls["n"] == 1 else 0
        with mock.patch("p9m3.ledger.os.write", side_effect=one_byte):
            with self.assertRaises(OSError):
                led.authorize(occurrences=[])

    def test_C6_18_declared_fuse_refused_at_leg1(self):
        # audit C4-4: the DECLARED type takes the same FUSE predicate.
        from p9m3.probe import FSProbeError, _leg1_local_fstype
        for declared in ("fuse", "fuse.s3fs", "fuse.sshfs"):
            with self.assertRaises(FSProbeError, msg=declared):
                _leg1_local_fstype(declared, faults=FsFaults(
                    simulated_fstype="ext4"))

    def test_C6_19_timestamp_is_normalized_not_assumed(self):
        # audit C4-1 + S-J3-C: non-int/bool `at` is refused with zero bytes.
        # Any int is CLAMPED into [0, AT_MAX] before it is written, so an
        # out-of-range clock can never produce an unrecordable outcome.
        led = self.mk()
        jp = os.path.join(self.dir, "repair_intent.jsonl")
        for bad_at in ("1700000000", True, None, 1.5):
            with self.assertRaises(LedgerError, msg=repr(bad_at)) as cm:
                led._journal_append({"t": "REPAIR-INTENT", "authId": "A1",
                                     "at": bad_at})
            self.assertEqual(cm.exception.code, "journal-full")
            self.assertFalse(os.path.exists(jp) and os.path.getsize(jp) > 0,
                             "invalid timestamp wrote bytes")
        led._journal_append({"t": "REPAIR-INTENT", "authId": "A1",
                             "at": 10 ** 13 + 5})
        led._journal_append({"t": "REPAIR-INTENT", "authId": "A2",
                             "at": -7})
        with open(jp, "rb") as f:
            recs = [json.loads(x) for x in f.read().splitlines()]
        self.assertEqual([r["at"] for r in recs],
                         [10 ** 12 - 1, 0], "clamp must be exact")
        self.assertEqual(led._clean_failure_count("A1"), 1)

    def test_C6_20_duplicate_member_names_are_damage(self):
        # audit C4-3 (S-J1 ratified): a duplicate member name in a journal
        # object is damage. The reader must refuse it on every decision path
        # rather than silently keep the last value.
        dup = b'{"t":"REPAIR-INTENT","authId":"A","authId":"B","at":1}\n'
        led = self._journal(dup)
        with self.assertRaises(LedgerError) as cm:
            led._clean_failure_count("B")
        self.assertEqual(cm.exception.code, "journal-unreadable")
        led = self._journal(dup)
        with self.assertRaises(LedgerError) as cm:
            led.status()
        self.assertEqual(cm.exception.code, "journal-unreadable")
        self.assertIs(self._journal(dup).promotion_allowed(), False)

    def test_C6_21_reader_enforces_timestamp_domain_both_boundaries(self):
        # audit C5-1 + S-J3-C: the reader admits exactly [0, AT_MAX] —
        # the writer's clamp range — and fails closed outside it.
        for bad in (b'{"t":"REPAIR-INTENT","authId":"A","at":-1}\n',
                    b'{"t":"REPAIR-INTENT","authId":"A","at":1000000000000}\n'):
            led = self._journal(bad)
            with self.assertRaises(LedgerError) as cm:
                led.status()
            self.assertEqual(cm.exception.code, "journal-unreadable", bad)
        for at in (0, 999999999999):
            led = self._journal(
                ('{"t":"REPAIR-INTENT","authId":"A","at":%d}\n' % at).encode())
            self.assertEqual(led._clean_failure_count("A"), 1)   # admitted

    def test_C6_22_deep_nesting_in_ledger_line_is_malformed_occurrence(self):
        # audit C5-3: RecursionError inside a ledger line is a malformed
        # occurrence, not a crash of classification.
        self.led = self.mk()
        with open(os.path.join(self.dir, "consumptions.jsonl"), "wb") as f:
            f.write(b"[" * 1100 + b"0" + b"]" * 1100 + b"\n")
        st = self.led.classify()                 # must not raise RecursionError
        self.assertEqual(st["state"], STATE_UNMASKED)

    def test_C6_23_zero_progress_journal_write_is_io_error(self):
        # audit C5-2: a write that makes no progress must raise EIO, never
        # spin while holding the exclusion lock.
        from unittest import mock
        led = self.mk()
        calls = {"n": 0}
        class _Bounded(Exception):
            pass
        def zero(fd, data):
            calls["n"] += 1
            if calls["n"] > 5:          # regression to retry: bounded fail
                raise _Bounded("journal zero-progress was retried")
            return 0
        with mock.patch("p9m3.ledger.os.write", side_effect=zero):
            with self.assertRaises(OSError) as cm:   # EIO, not _Bounded
                led._log_repair_intent("A1")
        self.assertEqual(cm.exception.errno, errno.EIO)
        self.assertEqual(calls["n"], 1, "zero journal write was retried")

    def test_C7_1_ledger_short_writes_complete_without_duplication(self):
        # audit cycle-6 finding 1: a kernel short write must be completed
        # by the remainder loop exactly once, not re-written or stalled.
        from unittest import mock
        led = self.mk()
        led.append_watermark("H0", 1, "G0")
        before = os.path.getsize(led.ledger_path)
        real = os.write
        calls = {"n": 0}
        def short(fd, data):
            calls["n"] += 1
            # first call writes only 3 bytes; later calls write 5 at a time
            return real(fd, data[:3] if calls["n"] == 1 else data[:5])
        framed = b"\n" + b'{"t":"WATERMARK","hostToken":"H0","watermark":2,"confirmGen":"G0"}\n'
        with mock.patch("p9m3.ledger.os.write", side_effect=short):
            with led._lock("append"):
                led._append_bytes(framed, intent="R")
        self.assertGreater(calls["n"], 2)
        # audit cycle-8 finding: the bytes appended after `before` must equal
        # the frame EXACTLY (a same-length corrupted frame must fail).
        with open(led.ledger_path, "rb") as f:
            f.seek(before)
            self.assertEqual(f.read(), framed, "short-write frame is not exact")

    def test_C7_2_ledger_zero_progress_remainder_raises_and_stops(self):
        # audit cycle-6 finding 1: zero progress on the remainder must raise
        # EIO after a bounded number of attempts, not loop under the lock.
        from unittest import mock
        led = self.mk()
        led.append_watermark("H0", 1, "G0")
        real = os.write
        calls = {"n": 0}
        class _Bounded(Exception):
            pass
        def stall(fd, data):
            calls["n"] += 1
            if calls["n"] == 1:
                return real(fd, data[:3])   # short first write
            if calls["n"] > 5:              # regression to retry: bounded fail
                raise _Bounded("remainder loop retried past zero progress")
            return 0                        # then no progress
        framed = b"\n" + b'{"t":"WATERMARK","hostToken":"H0","watermark":2,"confirmGen":"G0"}\n'
        with mock.patch("p9m3.ledger.os.write", side_effect=stall):
            with led._lock("append"):
                with self.assertRaises(OSError) as cm:      # EIO, not _Bounded
                    led._append_bytes(framed, intent="R")
        self.assertEqual(cm.exception.errno, errno.EIO)
        # exactly two writes: the 3-byte short write, then the ONE zero write.
        # Any retry after zero progress is a regression (audit cycle-8 finding).
        self.assertEqual(calls["n"], 2, "remainder loop retried after zero progress")

    def test_C7_3_sigkill_inside_repair_write_leaves_R_intent(self):
        # audit cycle-6 finding 2: kill a REAL repair at its ledger write.
        # The repair path writes intent 'R' into the pending sidecar before
        # the first ledger byte; the successor must see that 'R' intent and
        # an unsettled window, not merely the torn bytes.
        from unittest import mock
        bad = CORRUPT + b"-c7"
        self.seed_at([(0, bad)])
        self.led = self.mk()
        occ = self.occ(0, bad)
        auth = self.led.authorize([occ], auth_id="A7", test_only=True)
        pre_size = os.path.getsize(self.led.ledger_path)   # repair's write offset
        pid = os.fork()
        if pid == 0:
            try:
                child = self.mk()
                real = os.write
                def die_in_write(fd, data):
                    # only the LEDGER REPAIR record, not the journal intent
                    # line that repair() writes first
                    if b'"t":"REPAIR"' not in data:
                        return real(fd, data)
                    real(fd, data[: max(1, len(data) // 2)])  # half lands
                    os.kill(os.getpid(), signal.SIGKILL)
                with mock.patch("p9m3.ledger.os.write", side_effect=die_in_write):
                    child.repair(auth)
            finally:
                os._exit(3)
        _, status = os.waitpid(pid, 0)
        self.assertTrue(os.WIFSIGNALED(status)
                        and os.WTERMSIG(status) == signal.SIGKILL,
                        "child was not killed inside the repair write")
        succ = self.mk()
        pend = succ._read_pending()
        self.assertIsNotNone(pend, "no pending window after kill")
        self.assertEqual(pend[1], False, "pending marked durable after kill")
        self.assertEqual(pend[0], pre_size, "pending offset is not the interrupted repair")
        self.assertEqual(succ._pending_intent(), "R",
                         "successor does not see the repair intent")
        self.assertEqual(succ.classify()["state"], STATE_UNSETTLED)

    def test_C8_1_zero_first_ledger_write_is_refused_not_retried(self):
        # audit cycle-7 finding 1: a zero FIRST write must raise EIO at once.
        # The mock would succeed on a retry, so a loop that retries (the
        # pre-fix behaviour) would wrongly complete the append.
        from unittest import mock
        led = self.mk()
        led.append_watermark("H0", 1, "G0")
        before = os.path.getsize(led.ledger_path)
        framed = b"\n" + b'{"t":"WATERMARK","hostToken":"H0","watermark":2,"confirmGen":"G0"}\n'
        real = os.write
        calls = {"n": 0}
        class _Bounded(Exception):
            pass
        def zero_then_ok(fd, data):
            calls["n"] += 1
            if calls["n"] > 5:              # regression to retry: bounded fail
                raise _Bounded("zero first write was retried")
            return 0 if calls["n"] == 1 else real(fd, data)
        with mock.patch("p9m3.ledger.os.write", side_effect=zero_then_ok):
            with led._lock("append"):
                with self.assertRaises(OSError) as cm:
                    led._append_bytes(framed, intent="R")
        self.assertEqual(cm.exception.errno, errno.EIO)
        self.assertEqual(calls["n"], 1, "zero first write was retried")
        self.assertEqual(os.path.getsize(led.ledger_path), before)


    # ------------------------------------------------- F60 (AUD45-c3-1)
    def test_F60_no_pending_resolve_io_fault_is_bounded(self):
        # AUD45-c3-1 (major CODE): a persistent resolve-IO fault with
        # NO pending window must reach the specified bounded
        # exhaustion (spec: "Resolution attempts are BOUNDED per
        # episode ... No schedule drives an unbounded loop"). Before
        # the fix this path returned STATE_PENDING forever: the
        # counter was never consumed, so exhaustion never arrived.
        led = self.mk(repair_attempt_cap=2)
        led.faults.resolve_fsync_fault = True
        self.assertFalse(led.durability_pending())
        codes = []
        for _ in range(4):
            try:
                led.resolve()
                codes.append("resolved")
            except LedgerError as e:
                codes.append(e.code)
        self.assertEqual(codes, [STATE_PENDING, STATE_PENDING,
                                 STATE_EXHAUSTED, STATE_EXHAUSTED])
        # exhaustion is visible on the informational view and the
        # binding decision refuses with the sticky flag, not pending
        self.assertEqual(led.status()["decision"], STATE_EXHAUSTED)
        res = led.promote(lambda: {"allowed": True})
        self.assertFalse(res["allowed"])
        self.assertEqual(res["decision"], STATE_EXHAUSTED)
        # sticky across processes (fresh Ledger on the same dir)
        restarted = self.mk(repair_attempt_cap=2)
        self.assertEqual(restarted.status()["decision"], STATE_EXHAUSTED)
        # the ONLY re-arm is the explicit operator path; after it (and
        # a healthy device) the resolve succeeds and the episode clears
        restarted.operator_resolve_reset()
        healthy = self.mk(repair_attempt_cap=2)
        cls = healthy.resolve()
        self.assertEqual(cls["state"], STATE_OK)
        self.assertEqual(healthy._read_counter(), 0)
        # a SUCCESSFUL ordinary resolve ends counter-free (fix 1 is
        # counter-free ON COMPLETION — AUD46-a1: the pre-charged
        # attempt is cleared when the resolve completes; F61 pins
        # that a CRASHED attempt stays charged)
        healthy.resolve()
        self.assertEqual(healthy._read_counter(), 0)

    # ------------------------------------------------- F61 (AUD46-a1/a2)
    def test_F61_ordinary_resolve_charge_is_pre_io_and_unconfirmed_pending(self):
        # AUD46-a1 (independent-session audit, major): the AUD45-c3-1
        # charge POSTED the IO — an interruption/crash DURING the IO
        # left the counter untouched, so bounded retry was defeatable
        # by fault timing. The charge is now crash-durable PRE-IO:
        # an interrupted attempt must stay charged across a restart.
        class Boom(OSError):
            pass
        led = self.mk(repair_attempt_cap=3)
        original = led._resolve_io
        def interrupted():
            raise KeyboardInterrupt()          # models a crash mid-IO
        led._resolve_io = interrupted
        self.assertFalse(led.durability_pending())
        with self.assertRaises(KeyboardInterrupt):
            led.resolve()
        self.assertEqual(led._read_counter(), 1)   # charge survived
        # AUD46-a2 (same audit, major): the charged attempt is an
        # UNCONFIRMED outcome — the informational view must not
        # report `ok` off bytes no completed resolve confirmed.
        self.assertEqual(led.status()["decision"], STATE_PENDING)
        self.assertFalse(led.promotion_allowed())
        # the charge is crash-durable: a fresh process sees it
        restarted = self.mk(repair_attempt_cap=3)
        self.assertEqual(restarted._read_counter(), 1)
        self.assertEqual(restarted.status()["decision"], STATE_PENDING)
        # second interrupted attempt charges again...
        restarted._resolve_io = interrupted
        with self.assertRaises(KeyboardInterrupt):
            restarted.resolve()
        self.assertEqual(self.mk()._read_counter(), 2)
        # ...a third interruption is the LAST permitted attempt (cap
        # 3): the 4th call refuses BEFORE any IO (cap refusal
        # precedes IO) and persistence shows the sticky flag.
        again = self.mk(repair_attempt_cap=3)
        again._resolve_io = interrupted
        with self.assertRaises(KeyboardInterrupt):
            again.resolve()
        fourth = self.mk(repair_attempt_cap=3)
        with self.assertRaises(LedgerError) as cm:
            fourth.resolve()
        self.assertEqual(cm.exception.code, STATE_EXHAUSTED)
        fresh = self.mk()
        self.assertTrue(fresh._attempts_exhausted())
        self.assertEqual(fresh.status()["decision"], STATE_EXHAUSTED)
        # the operator reset re-arms; a HEALTHY resolve then serves
        # and clears (a non-zero counter is never latched by success)
        fresh.operator_resolve_reset()
        served = self.mk()
        self.assertEqual(served.resolve()["state"], STATE_OK)
        self.assertEqual(self.mk()._read_counter(), 0)
        self.assertEqual(self.mk().status()["decision"], STATE_OK)

    # ------------------------------------------------- F62 (AUD46-c1)
    def test_F62_owed_witness_survives_operator_reset(self):
        # AUD46-c1 (audit cycle 1, blocker): the counter is NOT the
        # only owed evidence. A resolve attempt lands the OWED WITNESS
        # before its charge+IO; if the attempt is interrupted the
        # witness survives as crash-durable evidence on disk.
        # `operator_resolve_reset()` zeroes the counter but MUST NOT
        # erase the evidence — until a resolve COMPLETES, the ledger
        # stays PENDING even at counter 0, on the informational view
        # AND on the binding promote path.
        def interrupted():
            raise KeyboardInterrupt()          # models a crash mid-IO
        led = self.mk(repair_attempt_cap=3)
        led._resolve_io = interrupted
        # AUD46-C2-1 (audit cycle 1 fold, test-strength): the ORDER
        # witness-before-charge is pinned directly — on the real code
        # the witness is already OWED when the charge write executes
        # (both branches). A mutant that swaps the two observes
        # owed=False at charge time AND re-creates the C1-1 loss when
        # crashed between the charge and a late witness write + reset.
        seen = []
        real_counter = led._write_counter
        def spy_counter(n, exhausted=None):
            seen.append((n, led._owed_attempt()))
            return real_counter(n, exhausted)
        led._write_counter = spy_counter
        with self.assertRaises(KeyboardInterrupt):
            led.resolve()
        self.assertTrue(seen and all(owed for _n, owed in seen),
                        "every charge must land with the witness set: %r"
                        % (seen,))
        led._write_counter = real_counter
        with self.assertRaises(KeyboardInterrupt):
            led.resolve()
        self.assertTrue(led._owed_attempt())   # witness landed pre-IO
        led.operator_resolve_reset()            # operator re-arms
        self.assertEqual(led._read_counter(), 0)
        # the evidence survived the reset (crash-durable, own file)
        after = self.mk()
        self.assertEqual(after._read_counter(), 0)
        self.assertTrue(after._owed_attempt())
        st = after.status()
        self.assertEqual(st["decision"], STATE_PENDING)
        self.assertTrue(st.get("owed_attempt"))
        self.assertFalse(after.promotion_allowed())
        # WITH THE FAULT STILL ACTIVE the binding promote refuses: its
        # in-lock resolve fails (OSError => fail-closed STATE_PENDING)
        # and the owed check refuses even a counter-0 window.
        after._resolve_io = lambda: (_ for _ in ()).throw(OSError("io down"))
        with self.assertRaises(LedgerError) as cm:
            after.resolve()
        self.assertEqual(cm.exception.code, STATE_PENDING)
        self.assertTrue(self.mk()._owed_attempt())   # evidence persists
        # a healthy instance's promote SELF-HEALS: its in-lock
        # resolve completes and clears every owed trace.
        res = self.mk().promote(lambda: "promoted")
        self.assertEqual(res, "promoted")
        self.assertFalse(self.mk()._owed_attempt())
        # ONLY a completed resolve clears the witness: the healthy
        # re-arm path serves once and every owed trace is gone.
        self.assertEqual(self.mk().status()["decision"], STATE_OK)
        cleared = self.mk()
        self.assertFalse(cleared._owed_attempt())
        self.assertEqual(cleared._read_counter(), 0)
        self.assertEqual(cleared.status()["decision"], STATE_OK)
        # the cleared witness reads identically to a never-created
        # one (zero-padded; F10: the protocol removes no names)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "resolve-owed")))
        self.assertEqual(os.path.getsize(os.path.join(self.dir, "resolve-owed")),
                         16)   # AUD46-C3-1: cleared = full 16 bytes, never 0

    def test_F63_witness_content_space_fails_closed(self):
        # AUD46-c3 (audit cycle 2, majors 1+2 folded): the witness's
        # content space is CLOSED. MISSING = none; EXACTLY the 16-byte
        # all-zero record = cleared-none; EVERYTHING ELSE — a torn
        # creation (empty or partial payload: the name is visible the
        # instant O_CREAT returns, the bytes are not), garbage, an
        # over-long hostile record — FAILS CLOSED as owed. A torn
        # CLEAR cannot erase the signature either: _clear_owed writes
        # the ZERO TAIL first, so a mid-clear crash leaves a nonzero
        # head that reads owed (the fix is the write ORDER, proven by
        # the tail-first mutant below).
        owed_path = os.path.join(self.dir, "resolve-owed")
        self.assertFalse(self.mk()._owed_attempt())   # missing = none
        for raw, want in ((b"", True), (b"OW", True), (b"OWED", True),
                          (b"garbage", True), (b"\0" * 15, True),
                          (b"\0" * 17, True),
                          (b"OWED" + b"\0" * 12, True), (b"\0" * 16, False)):
            with open(owed_path, "wb") as f:
                f.write(raw)
            os.chmod(owed_path, 0o600)   # the strict census requires 0600
            led = self.mk()
            self.assertEqual(led._owed_attempt(), want,
                             "raw=%r owed=%s" % (raw, want))
            st = led.status()
            self.assertEqual(st["decision"],
                             STATE_PENDING if want else STATE_OK,
                             "raw=%r status disagrees" % (raw,))
        # a torn CREATION (pwrite fault with the name already created)
        # reads owed, not none:
        d = self.dir
        led = self.mk()
        def torn(path, payload):
            if path == os.path.join(d, "resolve-owed"):
                with open(path, "wb"):
                    pass
                raise OSError("torn creation")
        led._sidecar_write = torn
        with self.assertRaises(OSError):
            led._write_owed()
        self.assertTrue(self.mk()._owed_attempt(),
                        "zero-byte witness must read OWED")
        after = self.mk()
        self.assertEqual(after.status()["decision"], STATE_PENDING)
        self.assertFalse(after.promotion_allowed())
        # a torn CLEAR (tail-first write) leaves the OWED head nonzero:
        owed2 = os.path.join(d, "resolve-owed")
        with open(owed2, "wb") as f:
            f.write(b"OWED" + b"\0" * 12)
        # model a crash after writing ONLY the tail (offset 4..16):
        with open(owed2, "r+b") as f:
            f.seek(4)
            f.write(b"\0" * 12)      # tail-first partial clear
        led3 = self.mk()
        self.assertTrue(led3._owed_attempt(),
                        "tail-first clear crash keeps the owed head")
        # AUD46-C4-1 (audit cycle 3, major): a SHORT tail pwrite must
        # retry with the REMAINING bytes only — an un-sliced retry
        # extends the fixed-width witness past 16 bytes and wedges it
        # owed forever (over-long = fail-closed). Patch a 4-byte
        # short-write once and prove a full healthy clear still lands
        # at exactly 16 bytes, owed=False.
        with open(owed2, "wb") as f:
            f.write(b"OWED" + b"\0" * 12)
        os.chmod(owed2, 0o600)
        real_pwrite = os.pwrite
        short = {"left": 1}
        def short_pwrite(fd, data, off, *a):
            if short["left"] and off == 4:
                short["left"] -= 1
                return real_pwrite(fd, data[:4], off, *a)   # 4 of 12
            return real_pwrite(fd, data, off, *a)
        led4 = self.mk()
        import sys
        led_mod = sys.modules[type(led4).__module__]
        orig = getattr(led_mod.os, "pwrite", None)
        led_mod.os.pwrite = short_pwrite
        try:
            led4._clear_owed()
        finally:
            led_mod.os.pwrite = orig
        self.assertEqual(os.path.getsize(owed2), 16,
                         "short-write retry must not extend the witness")
        self.assertFalse(self.mk()._owed_attempt())

    def test_F64_clear_fsync_fault_stays_fail_closed(self):
        # AUD46-c5 (audit cycle 5, major): a FAILED witness-clear
        # (fsync EIO during the completion of a successful resolve)
        # must NOT hand the next instance an `ok`. The completion now
        # writes in fail-closed ORDER: clear the owed witness FIRST,
        # then zero the counter. A clear that raises leaves the
        # attempt CHARGED (A2 overlay: counter > 0 => PENDING) and
        # the witness still owed — double evidence, no ok. The
        # symmetric fault (clear lands, the counter-zero then faults)
        # is equally fail-closed: charged counter, cleared witness,
        # still PENDING until the NEXT successful resolve.
        # Case A: the clear itself raises (models fsync failure).
        led = self.mk(repair_attempt_cap=3)
        led._write_pending(0, True)
        led._clear_owed = lambda: (_ for _ in ()).throw(OSError(5, "clear fsync"))
        with self.assertRaises(OSError):
            led.resolve()
        after = self.mk(repair_attempt_cap=3)
        self.assertEqual(after._read_counter(), 1,
                         "a failed clear must leave the attempt charged")
        self.assertTrue(after._owed_attempt(),
                        "a failed clear leaves the witness owed")
        self.assertEqual(after.status()["decision"], STATE_PENDING)
        self.assertFalse(after.promotion_allowed())
        # the next successful resolve still recovers (bounded):
        del led._clear_owed              # un-patch: clear works again
        res = led.resolve()
        self.assertEqual(res["state"], STATE_OK)
        healed = self.mk(repair_attempt_cap=3)
        self.assertEqual(healed._read_counter(), 0)
        self.assertFalse(healed._owed_attempt())
        # Case B: clear succeeds, the completion counter-ZERO faults.
        # AUD47-c1 (audit cycle 1, major 1) UPDATED this pin: a zero
        # that faults AFTER its pwrite leaves counter=0 page-visible
        # (F64's fault-before-write model cannot see that), so the
        # completion now RE-ARMS the owed witness on any completion
        # failure — the unconfirmed fact survives in the witness no
        # matter which bytes the fault exposed. Both the counter and
        # the witness views are now fail-closed, independently.
        led2 = self.mk(repair_attempt_cap=3)
        led2._write_pending(0, True)
        real_cw = led2._write_counter
        calls = {"n": 0}
        def flaky_zero(n, exhausted=None):
            calls["n"] += 1
            if calls["n"] == 2:      # charge lands, zero faults
                raise OSError(5, "zero fsync")
            return real_cw(n, exhausted)
        led2._write_counter = flaky_zero
        with self.assertRaises(OSError):
            led2.resolve()
        after2 = self.mk(repair_attempt_cap=3)
        self.assertEqual(after2._read_counter(), 1,
                         "a failed counter-zero must leave the charge")
        self.assertTrue(after2._owed_attempt(),
                        "AUD47-c1: a failed completion re-arms the "
                        "owed witness — fail-closed even if the fault "
                        "exposed counter=0")
        self.assertEqual(after2.status()["decision"], STATE_PENDING)
        self.assertFalse(after2.promotion_allowed())
        # and the ledger still heals: next successful resolve clears
        del led2._write_counter
        self.assertEqual(led2.resolve()["state"], STATE_OK)
        healed2 = self.mk(repair_attempt_cap=3)
        self.assertEqual(healed2._read_counter(), 0)
        self.assertFalse(healed2._owed_attempt())
        self.assertEqual(healed2.status()["decision"], STATE_OK)

    # ------------------------------------------- AUD47 cycle-1 pins F65/F66
    def test_F65_counter_zero_fsync_fault_rearms_owed_witness(self):
        """AUD47-c1 (audit cycle 1, major 1): the AUD46-c5 completion
        order (clear witness, THEN zero counter) assumed a failed
        counter-zero leaves the CHARGED counter visible. It does not:
        the zero PAYLOAD lands (page-cached) before its fsync fails,
        so a fresh instance read counter=0 with the witness already
        cleared — `ok` for a resolve whose caller got an OSError.
        NOW: `_complete_resolve` re-arms the owed witness on ANY
        completion failure — the unconfirmed fact survives in a view
        every reader honors, whatever the counter bytes show."""
        led = self.mk(repair_attempt_cap=3)
        led._write_pending(0, True)
        real_sw = led._sidecar_write    # AUD47-c3: bound method (now
                                        # an instance method carrying
                                        # the FsFaults lifecycle seams)

        def flaky_zero_fsync(path, payload, real=real_sw):
            # the zero write LANDS; only its fsync faults (the fault
            # position the AUD46-c5 pin could not reach)
            if path.endswith("resolve-attempts") and payload.startswith(b"0 "):
                fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
                try:
                    off = 0
                    while off < len(payload):
                        n = os.pwrite(fd, payload[off:], off)
                        if n <= 0:
                            raise OSError(errno.EIO, "zero progress")
                        off += n
                    raise OSError(errno.EIO, "injected counter-zero fsync")
                finally:
                    os.close(fd)
            return real(path, payload)

        led._sidecar_write = flaky_zero_fsync
        with self.assertRaises(OSError):
            led.resolve()
        nxt = self.mk(repair_attempt_cap=3)
        # the fault DID expose counter=0 (that is the finding) — the
        # re-armed witness is what keeps the fresh view fail-closed
        self.assertTrue(nxt._owed_attempt(),
                        "AUD47-c1: a failed completion re-arms the owed "
                        "witness even though the zero payload landed")
        self.assertEqual(nxt.status()["decision"], STATE_PENDING)
        self.assertFalse(nxt.promotion_allowed())
        # The binding path re-resolves first: a fresh SUCCESSFUL
        # resolve IS the resolution (designed self-heal — only real
        # confirm IO may cure the witness), so the pin is that the
        # STALE BYTES alone never served `ok` (status/overlay pinned
        # above) and the healing promote leaves a fully consistent
        # state — counter 0, witness cleared, decision ok.
        res = nxt.promote(lambda: {"ran": True})
        self.assertTrue(res.get("ran"))
        healed_now = self.mk(repair_attempt_cap=3)
        self.assertFalse(healed_now._owed_attempt())
        self.assertEqual(healed_now.status()["decision"], STATE_OK)
        # and the ledger still heals: a clean retry completes fully
        del led._sidecar_write
        self.assertEqual(led.resolve()["state"], STATE_OK)
        healed = self.mk(repair_attempt_cap=3)
        self.assertEqual(healed._read_counter(), 0)
        self.assertFalse(healed._owed_attempt())
        self.assertEqual(healed.status()["decision"], STATE_OK)
        self.assertTrue(healed.promotion_allowed())

    def test_F66_unreadable_owed_witness_blocks_decision_append(self):
        """AUD47-c1 (audit cycle 1, major 2): a fail-closed owed
        overlay (a record no reader accepts) served an APPLIED append
        while `promote()` and `status()` refused — the decision-append
        gate checked classification + durability only, not the same
        binding basis `promote()` refuses on. NOW the gate adds
        `_attempts_exhausted()`/`_owed_attempt()` — gate and binding
        path can never disagree on the owed witness. (The width-heal,
        test_F67, fixes the wedge itself; this pins the gate so a
        fail-closed overlay can NEVER be gated past.)"""
        led = self.mk(repair_attempt_cap=3)
        led._write_pending(0, True)
        p = os.path.join(self.dir, "resolve-owed")
        fd = os.open(p, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, b"X" * 17)                # over-long: fail closed
        os.close(fd)
        # disable the width-heal so the overlay STAYS unreadable —
        # this pins the GATE clause, not the heal (F67 pins the heal).
        # CLASS-level patch: `_sidecar_write` calls the heal class-
        # qualified, so an instance patch would be bypassed.
        real_heal = Ledger.__dict__["_sidecar_fix_width"]
        Ledger._sidecar_fix_width = staticmethod(lambda fd, width: None)
        try:
            r = led.resolve()                  # resolve itself is fine
            self.assertEqual(r["state"], STATE_OK)
            self.assertTrue(led._owed_attempt(),
                            "the un-healed record must still read owed")
            with self.assertRaises(LedgerError) as cm:
                led.append_applied("F66")
            self.assertEqual(cm.exception.code, "decision-append-refused")
            self.assertEqual(self.raw(), b"",
                             "a refused decision append writes ZERO bytes")
            refused = led.promote(lambda: "MUST-NOT-RUN")
            self.assertFalse(refused["allowed"],
                             "the binding path refuses on the same basis")
        finally:
            Ledger._sidecar_fix_width = real_heal

    def test_F67_overlong_sidecar_heals_on_healthy_rewrite(self):
        """AUD47-c1 (audit cycle 1, major 2): a corrupted sidecar whose
        bytes extend past the declared fixed width was FAIL-CLOSED
        FOREVER — every healthy fixed-width rewrite left the past-
        width bytes set, so the owed witness survived even a fully
        successful resolve ("ok" served over a witness no reader
        accepts), and an over-long counter/pending record outlived the
        operator resets that promise to rewrite it. NOW every healthy
        fixed-width rewrite re-establishes the declared width
        (`_sidecar_fix_width`, F10-pinned as the sole shrink site).
        A crash before the heal still reads over-long = fail closed."""
        led = self.mk(repair_attempt_cap=3)
        led._write_pending(0, True)
        p = os.path.join(self.dir, "resolve-owed")
        fd = os.open(p, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, b"X" * 17)
        os.close(fd)
        self.assertTrue(led._owed_attempt())
        self.assertEqual(led.resolve()["state"], STATE_OK)
        with open(p, "rb") as f:
            raw = f.read()
        self.assertEqual(len(raw), 16, "the clear heals the width")
        self.assertEqual(raw, b"\0" * 16)
        nxt = self.mk(repair_attempt_cap=3)
        self.assertFalse(nxt._owed_attempt())
        self.assertEqual(nxt.status()["decision"], STATE_OK)
        self.assertTrue(nxt.promotion_allowed())
        # counter record heals too: over-long corrupt = exhausted,
        # a healthy rewrite (operator reset) re-establishes grammar
        cp = os.path.join(self.dir, "resolve-attempts")
        fd = os.open(cp, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, b"0 -" + b"\0" * 13 + b"JUNK")
        os.close(fd)
        led2 = self.mk(repair_attempt_cap=3)
        self.assertTrue(led2._attempts_exhausted(),
                        "over-long counter record fails closed")
        led2.operator_resolve_reset()
        led3 = self.mk(repair_attempt_cap=3)
        self.assertEqual(led3._read_counter(), 0)
        self.assertFalse(led3._attempts_exhausted())

    def test_F68_owed_open_fault_charges_before_attempt(self):
        """AUD47-c3 (audit cycle 3, major): the owed witness is the
        first evidence an attempt exists — if its OPEN faults, the
        attempt began with NO evidence at all (counter 0, no
        witness), so a fresh instance served `ok` for a resolve whose
        caller got the error. NOW `_arm_owed` falls back to the
        counter charge before re-raising: the fresh view is fail-
        closed whatever the witness file shows."""
        led = self.mk(repair_attempt_cap=3)
        real_open = os.open

        def fail_owed_open(path, *a, **k):
            if isinstance(path, str) and path.endswith("resolve-owed"):
                raise OSError(errno.EACCES, "injected owed-open fault")
            return real_open(path, *a, **k)

        os.open = fail_owed_open
        try:
            with self.assertRaises(OSError):
                led.resolve()           # no-pending branch
        finally:
            os.open = real_open
        fresh = self.mk(repair_attempt_cap=3)
        self.assertEqual(fresh._read_counter(), 1,
                         "the fallback charge landed: the attempt is "
                         "evidenced even though the witness never opened")
        self.assertNotEqual(fresh.status()["decision"], STATE_OK)
        self.assertFalse(fresh.promotion_allowed())
        # the STALE bytes never serve ok; a fresh SUCCESSFUL resolve
        # is the resolution (designed self-heal — only real confirm
        # IO may cure the evidence)
        res = fresh.promote(lambda: {"ran": True})
        self.assertTrue(res.get("ran"))
        healed_now = self.mk(repair_attempt_cap=3)
        self.assertEqual(healed_now._read_counter(), 0)
        self.assertEqual(healed_now.status()["decision"], STATE_OK)

        # pending branch: same fault, fresh view still fail-closed
        led2 = self.mk(repair_attempt_cap=3)
        led2._write_pending(0, True)
        os.open = fail_owed_open
        try:
            with self.assertRaises(OSError):
                led2.resolve()
        finally:
            os.open = real_open
        fresh2 = self.mk(repair_attempt_cap=3)
        self.assertEqual(fresh2._read_counter(), 1)
        self.assertEqual(fresh2.status()["decision"], STATE_PENDING)
        self.assertFalse(fresh2.promotion_allowed())
        # healthy re-arm: a clean resolve heals both evidences
        self.assertEqual(led2.resolve()["state"], STATE_OK)
        healed = self.mk(repair_attempt_cap=3)
        self.assertEqual(healed._read_counter(), 0)
        self.assertFalse(healed._owed_attempt())
        self.assertEqual(healed.status()["decision"], STATE_OK)

    def test_F69_declared_sidecar_lifecycle_seams(self):
        """AUD47-c3 (audit cycle 3, minor): the lifecycle writes (owed
        witness create/clear, counter, pending window) were only
        reachable by monkeypatching OS calls, and `resolve_fsync_fault`
        was consumed via getattr without ever being DECLARED. NOW the
        seams are declared `FsFaults` constructor options and
        constructor-pinned here: an un-declared seam is not a seam."""
        import inspect
        sig = inspect.signature(FsFaults.__init__)
        for name in ("resolve_io_fault", "sidecar_open_fault",
                     "sidecar_write_fault", "sidecar_partial_write",
                     "sidecar_fsync_fault", "sidecar_dir_fsync_fault"):
            self.assertIn(name, sig.parameters,
                          "declared lifecycle seam missing: %s" % name)

        # open fault: every sidecar write refuses BEFORE any name is
        # created; the attempt never starts (raise precedes IO), so a
        # fresh `ok` is HONEST — pin that zero sidecars landed.
        f = FsFaults(sidecar_open_fault=True)
        led = self.mk(faults=f, repair_attempt_cap=3)
        with self.assertRaises(OSError):
            led.resolve()
        for side in ("resolve-owed", "resolve-attempts", "last-append"):
            self.assertFalse(os.path.exists(os.path.join(self.dir, side)),
                             "an open fault creates no name: %s" % side)

        # write fault: name visible, payload absent (torn creation).
        # The witness reads OWED (zero-length = torn) and the fallback
        # charge faults too, so the pre-IO raise stands — but the
        # evidence that DID land (the torn witness) keeps the fresh
        # view fail-closed.
        f = FsFaults(sidecar_write_fault=True)
        led = self.mk(faults=f, repair_attempt_cap=3)
        with self.assertRaises(OSError):
            led.resolve()
        fresh = self.mk(repair_attempt_cap=3)
        self.assertTrue(fresh._owed_attempt(),
                        "a torn-creation witness reads OWED (fail closed)")
        self.assertNotEqual(fresh.status()["decision"], STATE_OK,
                            "torn evidence never serves ok (the torn "
                            "counter reads exhausted, the torn witness "
                            "reads owed — both fail closed)")
        self.assertFalse(fresh.promotion_allowed())

        # partial write: the checked loop must complete the record.
        f = FsFaults(sidecar_partial_write=5)
        led = self.mk(faults=f, repair_attempt_cap=3)
        led._write_counter(3, exhausted=False)
        with open(os.path.join(self.dir, "resolve-attempts"), "rb") as fh:
            raw = fh.read()
        self.assertEqual(len(raw), 16, "fixed width re-established")
        self.assertEqual(raw.rstrip(b"\0").decode(), "3 -")
        self.assertEqual(led._read_counter(), 3)

        # fsync fault: the DURABILITY LIE is silent (payload lands,
        # fsync dropped, no error) — the written view must still be
        # consistent, exactly as `_sidecar_write` documents.
        f = FsFaults(sidecar_fsync_fault=True)
        led = self.mk(faults=f, repair_attempt_cap=3)
        led._write_pending(7, True)
        self.assertEqual(led._read_pending(), (7, True))

        # declared resolve-IO fault: consumed at the `_resolve_io`
        # head — the round fails closed as pending, evidence intact.
        # (fresh sub-dir: the parts above left sidecar evidence)
        d2 = os.path.join(self.dir, "f69-resolve")
        os.mkdir(d2, 0o700)   # the probe demands 0700 (dir-mode leg)
        led = Ledger(d2, faults=FsFaults(resolve_io_fault=True),
                     repair_attempt_cap=3)
        with self.assertRaises(LedgerError) as cm:
            led.resolve()
        self.assertEqual(cm.exception.code, STATE_PENDING)
        fresh = Ledger(d2, repair_attempt_cap=3)
        self.assertEqual(fresh._read_counter(), 1,
                         "the attempted round stays charged")
        self.assertFalse(fresh.promotion_allowed())

    def test_F70_tail_first_clear_order_pinned(self):
        """AUD47-c4 (audit cycle 4, mutant m5): reversing the clear
        order in `_clear_owed` (head-first) kept the suite GREEN while
        being REACHABLY different — the witness payload is
        b"OWED"+NULs, so a head-first clear interrupted after its
        first segment zeroes the only nonzero bytes and leaves an
        all-zero record that reads CLEARED; `operator_resolve_reset()`
        then removes the counter evidence and a fresh instance serves
        `ok` although the clear never completed. TAIL-FIRST (the
        shipped order) crashes with the OWED head intact. This test
        interrupts the clear AFTER the first segment lands and pins
        the fail-closed survivor: it is RED on any head-first order."""
        led = self.mk(repair_attempt_cap=3)
        led._write_owed()
        real_pwrite = os.pwrite
        calls = {"n": 0}

        def flaky(p, b, off, *a, **k):
            calls["n"] += 1
            if calls["n"] == 2:     # die AFTER the first clear segment
                raise OSError(errno.EIO, "injected clear-segment fault")
            return real_pwrite(p, b, off, *a, **k)

        os.pwrite = flaky
        try:
            with self.assertRaises(OSError):
                led._complete_resolve()
        finally:
            os.pwrite = real_pwrite
        self.assertTrue(led._owed_attempt(),
                        "the interrupted clear must leave a record that "
                        "READS OWED — head-first orders leave an all-zero "
                        "(cleared-reading) record: tail-first is pinned")
        # operator re-arm cannot erase the survivor (F62 discipline)
        led.operator_resolve_reset()
        fresh = self.mk(repair_attempt_cap=3)
        self.assertTrue(fresh._owed_attempt())
        self.assertNotEqual(fresh.status()["decision"], STATE_OK,
                            "counter 0 after reset must NOT serve ok over "
                            "the interrupted-clear witness")
        self.assertFalse(fresh.promotion_allowed())
        # and the ledger still heals through a real resolve
        self.assertEqual(led.resolve()["state"], STATE_OK)
        healed = self.mk(repair_attempt_cap=3)
        self.assertFalse(healed._owed_attempt())
        self.assertEqual(healed.status()["decision"], STATE_OK)

    def test_F71_sliced_clear_retry_completes_fixed_width(self):
        """AUD47-c4 (audit cycle 4, mutant m6 disposition): the sliced
        clear retry must COMPLETE the record after a short write at
        exactly the declared width. This also closes m6: an UNSLICED
        retry re-issues the full 16-byte zero buffer from `off` — it
        zero-fills PAST `end` (the clear payload IS zeros, so no
        segment is corrupted), the file grows over-long, and an
        over-long witness reads FAIL-CLOSED (owed) until the width-
        heal truncates it — every intermediate state an unsliced retry
        can expose is strictly MORE fail-closed than the sliced one
        and the settled state is identical (16 zero bytes): m6 is
        behaviorally equivalent, dropped with this argument. The pin
        here is the settled state of the sliced order: short write,
        checked retry completes, exact width, witness cleared."""
        led = self.mk(repair_attempt_cap=3)
        led._write_owed()
        real_pwrite = os.pwrite
        state = {"done": False}

        def short_first(p, b, off, *a, real=real_pwrite, st=state):
            if not st["done"] and len(b) > 6:
                st["done"] = True
                return real(p, b[:6], off, *a)   # 6 of the segment lands
            return real(p, b, off, *a)

        os.pwrite = short_first
        try:
            led._complete_resolve()           # retry must finish the job
        finally:
            os.pwrite = real_pwrite
        with open(os.path.join(self.dir, "resolve-owed"), "rb") as fh:
            raw = fh.read()
        self.assertEqual(len(raw), 16, "width re-established at the clear")
        self.assertEqual(raw, b"\0" * 16, "the sliced retry completed the "
                                          "clear byte-for-byte")
        self.assertTrue(state["done"], "the short write really was injected")
        self.assertFalse(self.mk(repair_attempt_cap=3)._owed_attempt())

    # ------------------------------------------- AUD48 cycle-1 pins F72/F73
    def test_F72_operator_reset_refused_when_charge_is_sole_evidence(self):
        """AUD48-c1 (audit cycle 1, major 2): the owed-witness overlay
        only honors records it can READ. When the counter charge is the
        SOLE durable evidence of an unconfirmed attempt (witness absent
        or cleared, counter parses to a positive charge), the old
        unconditional `operator_resolve_reset()` zeroed the counter and
        erased the only proof an attempt had started: a fresh instance
        (counter 0, no witness) served `ok` for an episode nobody
        confirmed. The F68 evidence-fallback charge is exactly that
        sole evidence. NOW the reset REFUSES
        (`reset-sole-evidence-refused`) unless the counter record is
        corrupt (untrusted bytes, not a live charge — the F67 heal
        path stays open). Sticky-exhaustion resets (flag X) and
        witness-present resets (F62) are untouched."""
        led = self.mk(repair_attempt_cap=3)
        real_open = os.open

        def fail_owed_open(path, *a, **k):
            if isinstance(path, str) and path.endswith("resolve-owed"):
                raise OSError(errno.EACCES, "injected owed-open fault")
            return real_open(path, *a, **k)

        os.open = fail_owed_open
        try:
            with self.assertRaises(OSError):
                led.resolve()               # F68 fallback: charge lands
        finally:
            os.open = real_open
        sole = self.mk(repair_attempt_cap=3)
        self.assertEqual(sole._read_counter(), 1)
        self.assertFalse(sole._owed_attempt(),
                         "precondition: the witness never landed — the "
                         "charge is the ONLY evidence")
        self.assertNotEqual(sole.status()["decision"], STATE_OK)
        # the reset that would erase it REFUSES, and writes nothing:
        with self.assertRaises(LedgerError) as cm:
            sole.operator_resolve_reset()
        self.assertEqual(cm.exception.code, "reset-sole-evidence-refused")
        self.assertEqual(self.mk(repair_attempt_cap=3)._read_counter(), 1,
                         "a refused reset must leave the evidence intact")
        self.assertNotEqual(self.mk(repair_attempt_cap=3).status()["decision"],
                            STATE_OK,
                         "after the refusal the fresh view is still "
                         "fail-closed — no ok was ever served")
        # the designed self-heal still works: a completing resolve IS
        # the resolution and clears both evidences.
        res = self.mk(repair_attempt_cap=3).promote(lambda: {"ran": True})
        self.assertTrue(res.get("ran"))
        healed = self.mk(repair_attempt_cap=3)
        self.assertEqual(healed._read_counter(), 0)
        self.assertFalse(healed._owed_attempt())
        self.assertEqual(healed.status()["decision"], STATE_OK)
        # escape hatch, pinned open: a CORRUPT counter is not a live
        # charge — the operator rewrite (F67 grammar heal) still works.
        # AUD48-c3 (finding 1) NARROWS this: corrupt damage that still
        # parses POSITIVE in its first 16 bytes IS a live charge and
        # the guard refuses (pin F78) — so the free-heal fixture is a
        # corrupt record over a ZERO count.
        cp = os.path.join(self.dir, "resolve-attempts")
        fd = os.open(cp, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, b"0 -" + b"\0" * 13 + b"JUNK")   # over-long, n=0
        os.close(fd)
        corrupt = self.mk(repair_attempt_cap=3)
        self.assertTrue(corrupt._attempts_exhausted(),
                        "over-long counter fails closed as exhausted")
        corrupt.operator_resolve_reset()    # flag=True -> refuse-guard off
        fixed = self.mk(repair_attempt_cap=3)
        self.assertEqual(fixed._read_counter(), 0)
        self.assertFalse(fixed._attempts_exhausted())
        # an EMPTY (never-written) ledger resets freely: n=0 is no
        # evidence of an attempt.
        fresh = self.mk(repair_attempt_cap=3)
        fresh.operator_resolve_reset()
        self.assertEqual(self.mk()._read_counter(), 0)

    def test_F73_completion_survives_corrupt_clear_plus_zero_fault(self):
        """AUD48-c1 (audit cycle 1, major 1): the AUD47-c1 completion
        (clear witness FIRST, then zero the counter) exposed `ok` under
        a COMBINED fault: when the clear failed over a CORRUPT witness
        the re-arm rewrote OWED over the corruption — erasing the
        evidence that the CLEAR had failed — and the following
        counter-zero then faulted: a fresh instance read counter=0
        with a readable-cleared witness for a resolve whose caller got
        an OSError. NOW the completion is ZERO-FIRST (the pre-attempt
        charge covers the window) and every compensation pin writes
        the honest charge n (the pre-attempt write already counted
        THIS attempt — pinning n+1 would double-charge, F64-A pin).
        This test reproduces the combined fault and pins the
        fail-closed survivor and the heal."""
        led = self.mk(repair_attempt_cap=3)
        led._write_owed()
        # corrupt the witness past the grammar (over-long hostile):
        p = os.path.join(self.dir, "resolve-owed")
        with open(p, "r+b") as f:
            f.write(b"OWED" + b"\0" * 12 + b"JUNK")
        real_pwrite = os.pwrite

        def fail_tail(p_, b, off, *a, **k):
            if off == 4:            # the clear's FIRST segment (tail)
                raise OSError(errno.EIO, "injected clear-tail fault")
            return real_pwrite(p_, b, off, *a, **k)

        os.pwrite = fail_tail
        try:
            with self.assertRaises(OSError):
                led._complete_resolve()
        finally:
            os.pwrite = real_pwrite
        # the corruption SURVIVED (the compensation never overwrote
        # the failed-clear evidence): the witness still fails closed.
        survivor = self.mk(repair_attempt_cap=3)
        self.assertTrue(survivor._owed_attempt(),
                        "a corrupt witness must survive the failed clear")
        self.assertNotEqual(survivor.status()["decision"], STATE_OK,
                            "counter 0 over a fail-closed witness must "
                            "NEVER serve ok")
        self.assertFalse(survivor.promotion_allowed())
        # and the ledger still heals: a real completing resolve
        # re-arms, clears the width-healed witness, zeroes the charge.
        self.assertEqual(led.resolve()["state"], STATE_OK)
        healed = self.mk(repair_attempt_cap=3)
        self.assertEqual(healed._read_counter(), 0)
        self.assertFalse(healed._owed_attempt())
        self.assertEqual(os.path.getsize(p), 16,
                         "the healed clear lands at the declared width")
        self.assertEqual(healed.status()["decision"], STATE_OK)

    def test_F74_sticky_exhaustion_does_not_demote_sole_evidence(self):
        """AUD48-c1 (audit cycle 1, major 3): the sole-evidence guard
        skipped when the sticky `X` flag was set (`not flag and n >
        0`) — but a cap refusal writes the flag over the SAME live
        charge, so a second visit armed the bypass: fallback charge
        (witness open fault), then any resolve at the cap sets `X`,
        and the reset erased the only evidence: a fresh view served
        `ok` for an episode nobody confirmed. The flag governs
        AUTOMATIC rounds, not the FACT a charge exists — a parsed
        positive count is evidence whatever the flag says. NOW the
        guard is evidence-based (a reset under `X` over a sole
        positive charge with a cleared/absent witness REFUSES), the
        corrupt-record heal path (F67) stays open, and an OWED-
        readable witness still resets freely with the witness intact
        (F62)."""
        led = self.mk(repair_attempt_cap=1)
        real_open = os.open

        def fail_owed_open(path, *a, **k):
            if isinstance(path, str) and path.endswith("resolve-owed"):
                raise OSError(errno.EACCES, "injected owed-open fault")
            return real_open(path, *a, **k)

        os.open = fail_owed_open
        try:
            with self.assertRaises(OSError):
                led.resolve()               # F68 fallback: charge n=1
        finally:
            os.open = real_open
        v = self.mk(repair_attempt_cap=1)
        self.assertEqual(v._read_counter(), 1)
        self.assertFalse(v._owed_attempt())
        # the SECOND visit: at the cap, persistence writes the sticky
        # flag over the live charge (refusal, zero IO).
        with self.assertRaises(LedgerError) as cm:
            v.resolve()
        self.assertEqual(cm.exception.code, STATE_EXHAUSTED)
        sticky = self.mk(repair_attempt_cap=1)
        n, flag, corrupt = sticky._counter_state()
        self.assertEqual((n, flag, corrupt), (1, True, False),
                         "precondition: sticky flag over a LIVE charge")
        self.assertFalse(sticky._owed_attempt(),
                         "precondition: witness absent — the charge "
                         "is still the ONLY evidence")
        with self.assertRaises(LedgerError) as cm:
            sticky.operator_resolve_reset()
        self.assertEqual(cm.exception.code, "reset-sole-evidence-refused")
        after = self.mk(repair_attempt_cap=1)
        self.assertEqual(after._read_counter(), 1,
                         "a refused reset writes nothing")
        self.assertNotEqual(after.status()["decision"], STATE_OK,
                         "the fresh view stays fail-closed")
        # the designed resolution under sticky `X`: restore the
        # WITNESS (the primary evidence), the reset then lands with
        # the witness intact (F62), and a completing resolve clears
        # both evidences.
        heal = self.mk(repair_attempt_cap=1)
        heal._write_owed()
        heal.operator_resolve_reset()
        res = self.mk(repair_attempt_cap=1).promote(lambda: {"ran": True})
        self.assertTrue(res.get("ran"))
        healed = self.mk(repair_attempt_cap=1)
        self.assertEqual(healed._read_counter(), 0)
        self.assertFalse(healed._attempts_exhausted())
        self.assertEqual(healed.status()["decision"], STATE_OK)
        # F62 untouched: sticky `X` with an OWED-READABLE witness
        # resets (the witness — the primary evidence — survives).
        w = self.mk(repair_attempt_cap=1)
        w._write_owed()
        w._write_counter(1, exhausted=True)
        w.operator_resolve_reset()
        post = self.mk(repair_attempt_cap=1)
        self.assertEqual(post._read_counter(), 0)
        self.assertTrue(post._owed_attempt(),
                        "the reset preserves the owed witness (F62)")
        self.assertNotEqual(post.status()["decision"], STATE_OK)

    def test_F75_unreadable_witness_refuses_reset_as_ambiguous(self):
        """AUD48-c1 (audit cycle 1, major 4): the guard caught the
        witness-read OSError and set owed=True, TREATING AN
        UNREADABLE WITNESS AS owed-evidence and permitting the reset
        — but "unreadable" is neither cleared nor owed-readable:
        ambiguous evidence over a live charge. The auditor's probe
        showed the reset landing, then (readability restored) a fresh
        view serving `ok` for an unconfirmed episode. NOW an OSError
        from the witness read with a live positive charge REFUSES
        (fail closed). Absent/cleared keeps the refusal (F72);
        owed-readable resets with the witness preserved (F62);
        counter n=0 resets freely with no witness rule engaged."""
        led = self.mk(repair_attempt_cap=3)
        real_open = os.open

        def fail_owed_open(path, *a, **k):
            if isinstance(path, str) and path.endswith("resolve-owed"):
                raise OSError(errno.EACCES, "injected owed-open fault")
            return real_open(path, *a, **k)

        os.open = fail_owed_open
        try:
            with self.assertRaises(OSError):
                led.resolve()               # F68 fallback charge n=1
        finally:
            os.open = real_open
        sole = self.mk(repair_attempt_cap=3)
        self.assertEqual(sole._read_counter(), 1)
        self.assertFalse(sole._owed_attempt(),
                         "precondition: witness absent")

        # make the witness UNREADABLE (any open of the owed side
        # fails) while the charge stands: ambiguous evidence.
        def fail_any_owed(path, *a, **k):
            if isinstance(path, str) and path.endswith("resolve-owed"):
                raise OSError(errno.EACCES, "injected owed-read fault")
            return real_open(path, *a, **k)

        os.open = fail_any_owed
        try:
            amb = self.mk(repair_attempt_cap=3)
            self.assertEqual(amb._owed_state(), "ERR",
                             "precondition: witness read faults")
            with self.assertRaises(LedgerError) as cm:
                amb.operator_resolve_reset()
            self.assertEqual(cm.exception.code,
                             "reset-sole-evidence-refused")
        finally:
            os.open = real_open
        mid = self.mk(repair_attempt_cap=3)
        self.assertEqual(mid._read_counter(), 1,
                         "the ambiguous refusal wrote nothing")
        # operator recovery, pinned: restore the WITNESS (the primary
        # evidence) — owed-readable — the reset then lands with the
        # witness intact (F62), and the fresh view is still refused.
        mid._write_owed()
        self.assertTrue(mid._owed_state())
        mid.operator_resolve_reset()
        post = self.mk(repair_attempt_cap=3)
        self.assertEqual(post._read_counter(), 0)
        self.assertTrue(post._owed_attempt(),
                        "the ambiguous-path reset still preserves the "
                        "witness — ok is NEVER served")
        self.assertNotEqual(post.status()["decision"], STATE_OK)
        # a completing resolve remains THE resolution:
        res = self.mk(repair_attempt_cap=3).promote(lambda: {"ran": True})
        self.assertTrue(res.get("ran"))
        self.assertEqual(self.mk(repair_attempt_cap=3).status()["decision"],
                         STATE_OK)

    def test_F76_clear_fsync_fault_repairs_owed_on_the_open_fd(self):
        """AUD48-c1 (audit cycle 1, major 2): the completion's
        compensation RE-ARMED the witness by OPENING the owed sidecar
        — but a device that faults the clear's fsync can fault that
        open too, and with the suppressed re-arm (plus the counter
        pin at n=0 after the zero landed) the fresh view read
        counter 0 with a readable-CLEARED witness: `ok` for a
        resolve whose caller got an OSError. NOW `_clear_owed`
        repairs OWED on the fd ALREADY OPEN when its fsync faults —
        BEFORE any new open can fail — so the recharged witness does
        not depend on a second open. Pinned with the exact combined
        fault (the WITNESS fd's fsync EIO — inode-matched so the
        counter/pending fsyncs stay healthy — plus every RE-ARM open
        of the witness denied): the resolve raises, the witness
        reads OWED, status/promote refuse, and a healthy completing
        resolve heals."""
        led = self.mk(repair_attempt_cap=3)
        led._write_owed()
        led._write_counter(0, exhausted=False)
        real_fsync, real_open, real_pwrite = os.fsync, os.open, os.pwrite
        owed_path = os.path.join(self.dir, "resolve-owed")
        cnt_path = os.path.join(self.dir, "resolve-attempts")
        st_owed = os.stat(owed_path)       # witness landed
        st_cnt = os.stat(cnt_path)
        state = {"fsync_fired": False, "open_fired": False,
                 "pin_fired": False, "zeroed": False}

        def fail_clear_fsync(fd):
            # ONE-SHOT: the clear's fsync — owed inode, zeros visible.
            if not state["fsync_fired"]:
                st = os.fstat(fd)
                if (st.st_dev, st.st_ino) == (st_owed.st_dev,
                                              st_owed.st_ino) \
                        and os.pread(fd, 16, 0) == b"\0" * 16:
                    state["fsync_fired"] = True
                    raise OSError(errno.EIO, "injected clear-fsync fault")
            return real_fsync(fd)

        def fail_rearm_open(path, flags, *a, **k):
            # ONE-SHOT: deny the compensation re-arm's open only —
            # the clear's own O_RDWR open passes; every later open
            # works so the heal can run.
            if isinstance(path, str) and path == owed_path \
                    and flags & (os.O_WRONLY | os.O_RDWR) \
                    and state["fsync_fired"] and not state["open_fired"]:
                state["open_fired"] = True
                raise OSError(errno.EACCES,
                              "injected owed re-arm open fault")
            return real_open(path, flags, *a, **k)

        def fail_pin_pwrite(p_, b, off, *a, **k):
            # ONE-SHOT: the counter PIN — the first counter write
            # AFTER the zero landed (arm + zero pass untouched).
            st = os.fstat(p_)
            if (st.st_dev, st.st_ino) == (st_cnt.st_dev, st_cnt.st_ino):
                if b[:1] == b"0":
                    state["zeroed"] = True
                elif state["zeroed"] and not state["pin_fired"]:
                    state["pin_fired"] = True
                    raise OSError(errno.EIO, "injected counter-pin fault")
            return real_pwrite(p_, b, off, *a, **k)

        os.fsync = fail_clear_fsync
        os.open = fail_rearm_open
        os.pwrite = fail_pin_pwrite
        try:
            with self.assertRaises(OSError):
                led.resolve()               # completion clears, fsync
                                            # faults, re-arm open AND
                                            # counter pin both fault
        finally:
            os.fsync = real_fsync
            os.open = real_open
            os.pwrite = real_pwrite
        self.assertTrue(state["fsync_fired"], "clear fsync never faulted")
        self.assertTrue(state["open_fired"], "re-arm open never faulted")
        self.assertTrue(state["zeroed"] and state["pin_fired"],
                        "counter pin never faulted (zero must land first)")
        survivor = self.mk(repair_attempt_cap=3)
        self.assertTrue(survivor._owed_attempt(),
                        "the in-fd repair must leave the witness OWED "
                        "even when EVERY re-arm open faults")
        self.assertNotEqual(survivor.status()["decision"], STATE_OK,
                            "no ok for a resolve whose caller errored")
        self.assertFalse(survivor.promotion_allowed())
        # healthy heal: a completing resolve clears witness+counter.
        self.assertEqual(led.resolve()["state"], STATE_OK)
        healed = self.mk(repair_attempt_cap=3)
        self.assertEqual(healed._read_counter(), 0)
        self.assertFalse(healed._owed_attempt())
        self.assertEqual(healed.status()["decision"], STATE_OK)


    def test_F77_repair_seeds_one_byte_before_the_full_fill(self):
        """AUD48-c2 (audit cycle 2, major): the cycle-1 in-fd repair
        rewrote the FULL 16-byte payload first — if the repair's
        FIRST pwrite faulted, no nonzero byte ever landed, and with
        the compensating re-arm open AND the counter pin faulting too
        the fresh view read counter 0 + readable-CLEARED witness:
        `ok` for a caller that got an OSError (auditor probe: faults
        {fs, repair, open, pin, zero} all fired, decision ok). NOW
        the repair SEEDS ONE BYTE at offset 0 FIRST (any non-all-zero
        record reads owed, the fail-closed reader), then fills the
        full payload best-effort — exposure needs a device rejecting
        even a one-byte pwrite on a fd whose zero write it just
        accepted: the documented all-writes-fault boundary."""
        led = self.mk(repair_attempt_cap=3)
        led._write_owed()
        led._write_counter(0, exhausted=False)
        real_fsync, real_open, real_pwrite = os.fsync, os.open, os.pwrite
        owed_path = os.path.join(self.dir, "resolve-owed")
        cnt_path = os.path.join(self.dir, "resolve-attempts")
        st_owed = os.stat(owed_path)
        st_cnt = os.stat(cnt_path)
        state = {"fs": False, "repair": False, "open": False,
                 "pin": False, "zero": False}

        def fail_clear_fsync(fd):
            if not state["fs"]:
                st = os.fstat(fd)
                if (st.st_dev, st.st_ino) == (st_owed.st_dev,
                                              st_owed.st_ino) \
                        and os.pread(fd, 16, 0) == b"\0" * 16:
                    state["fs"] = True
                    raise OSError(errno.EIO, "injected clear-fsync fault")
            return real_fsync(fd)

        def dispatcher(p_, b, off=0, *a, **k):
            st = os.fstat(p_)
            if (st.st_dev, st.st_ino) == (st_owed.st_dev, st_owed.st_ino):
                if state["fs"] and not state["repair"] \
                        and len(b) == 16 and off == 0:
                    state["repair"] = True
                    raise OSError(errno.EIO, "injected repair-fill fault")
            elif (st.st_dev, st.st_ino) == (st_cnt.st_dev, st_cnt.st_ino):
                if b[:1] == b"0":
                    state["zero"] = True
                elif state["zero"] and not state["pin"]:
                    state["pin"] = True
                    raise OSError(errno.EIO, "injected counter-pin fault")
            return real_pwrite(p_, b, off, *a, **k)

        def fail_rearm_open(path, flags, *a, **k):
            # the caller's compensating _write_owed open faults (the
            # seed-only witness must survive it)
            if isinstance(path, str) and path == owed_path \
                    and flags & (os.O_WRONLY | os.O_RDWR) \
                    and state["repair"] and not state["open"]:
                state["open"] = True
                raise OSError(errno.EACCES,
                              "injected owed re-arm open fault")
            return real_open(path, flags, *a, **k)

        os.fsync = fail_clear_fsync
        os.pwrite = dispatcher
        os.open = fail_rearm_open
        try:
            with self.assertRaises(OSError):
                led.resolve()
        finally:
            os.fsync = real_fsync
            os.open = real_open
        self.assertTrue(state["fs"] and state["repair"]
                        and state["open"] and state["zero"]
                        and state["pin"],
                        "precondition: all five combined faults fired "
                        "(clear fsync + repair fill + re-arm open + "
                        "counter zero + counter pin)")
        survivor = self.mk(repair_attempt_cap=3)
        self.assertEqual(survivor._read_counter(), 0,
                         "the zero landed and the pin faulted (the "
                         "auditor's state)")
        self.assertTrue(survivor._owed_attempt(),
                        "the one-byte seed must make the witness read "
                        "owed with EVERY other evidence write faulted")
        self.assertNotEqual(survivor.status()["decision"], STATE_OK,
                            "no ok for a resolve whose caller errored")
        self.assertFalse(survivor.promotion_allowed())
        # the seed-only witness is still a 16-byte record (width kept)
        with open(owed_path, "rb") as f:
            raw = f.read()
        self.assertEqual(len(raw), 16)
        self.assertNotEqual(raw, b"\0" * 16)
        self.assertEqual(raw[0:1], b"O",
                         "the seed lands at offset 0 (auditor survivor "
                         "a-offset: the suite must enforce WHERE the "
                         "minimum evidence sits, not just that one byte "
                         "somewhere reads owed)")
        # healthy heal: a completing resolve clears witness+counter.
        self.assertEqual(led.resolve()["state"], STATE_OK)
        healed = self.mk(repair_attempt_cap=3)
        self.assertEqual(healed._read_counter(), 0)
        self.assertFalse(healed._owed_attempt())
        self.assertEqual(healed.status()["decision"], STATE_OK)


    def test_F78_append_damage_cannot_launder_a_live_charge_past_reset(self):
        """AUD48-c3 (audit cycle 3, finding 1, high): the reset guard
        skipped the witness check when the counter record was
        'corrupt' (the F67 heal path) — but appending ONE byte to a
        live `1 -...` record makes it over-length = corrupt, so a
        hostile append LAUNDERED the sole evidence of an unconfirmed
        attempt: free heal zeroes the counter, fresh view reads
        counter 0 + no witness = `ok` (auditor probe: fallback
        charge n=1, append -> (4,True,True) corrupt -> reset ->
        (0,False,False) ok). NOW the guard runs on the RAW-GRAMMAR
        charge: the first 16 bytes parsed against the fixed grammar.
        A corrupt record whose prefix still parses POSITIVE is a live
        charge — same refusal — while damage over a ZERO count (no
        attestable charge) keeps the F67 free heal. The suite also
        pins the over-length CLASSIFICATION itself (auditor survivor
        e-length): a valid-zero record + one trailing NUL must be
        treated corrupt-and-healable, not live."""
        led = self.mk(repair_attempt_cap=3)
        real_open = os.open

        def fail_owed_open(path, *a, **k):
            if isinstance(path, str) and path.endswith("resolve-owed"):
                raise OSError(errno.EACCES, "injected owed-open fault")
            return real_open(path, *a, **k)

        os.open = fail_owed_open
        try:
            with self.assertRaises(OSError):
                led.resolve()               # F68 fallback: charge n=1
        finally:
            os.open = real_open
        sole = self.mk(repair_attempt_cap=3)
        self.assertEqual(sole._read_counter(), 1)
        self.assertFalse(sole._owed_attempt(),
                         "precondition: witness absent — the charge "
                         "is the ONLY evidence")
        # the auditor's launder: append one byte to the counter.
        cp = os.path.join(self.dir, "resolve-attempts")
        with open(cp, "ab") as f:
            f.write(b"\xff")
        damaged = self.mk(repair_attempt_cap=3)
        n, flag, corrupt = damaged._counter_state()
        self.assertTrue(corrupt,
                        "precondition: the append makes the record "
                        "over-length = corrupt (the old heal bypass)")
        self.assertEqual(damaged._counter_raw_charge(), 1,
                         "the raw 16-byte prefix still attests a live "
                         "charge of 1")
        with self.assertRaises(LedgerError) as cm:
            damaged.operator_resolve_reset()
        self.assertEqual(cm.exception.code, "reset-sole-evidence-refused")
        kept = self.mk(repair_attempt_cap=3)
        self.assertEqual(kept._counter_raw_charge(), 1,
                         "a refused reset writes nothing")
        self.assertNotEqual(kept.status()["decision"], STATE_OK)
        # escape hatch intact: the PRIMARY evidence restored (owed
        # witness) — the reset heals the damaged record (F62/F75).
        kept._write_owed()
        kept.operator_resolve_reset()
        healed = self.mk(repair_attempt_cap=3)
        self.assertEqual(healed._read_counter(), 0)
        self.assertTrue(healed._owed_attempt(),
                        "the witness survives the reset (F62)")
        self.assertNotEqual(healed.status()["decision"], STATE_OK)
        self.assertEqual(self.mk(repair_attempt_cap=3).resolve()["state"],
                         STATE_OK)
        fin = self.mk(repair_attempt_cap=3)
        self.assertEqual(fin._read_counter(), 0)
        self.assertFalse(fin._owed_attempt())
        self.assertEqual(fin.status()["decision"], STATE_OK)
        # damage over a ZERO count is no charge: the F67 free heal
        # stays open (n=1 damage above refuses; n=0 damage heals).
        cp2 = os.path.join(self.dir, "resolve-attempts")
        fd = os.open(cp2, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, b"0 -" + b"\0" * 13 + b"\xff\xff\xff")
        os.close(fd)
        z = self.mk(repair_attempt_cap=3)
        self.assertTrue(z._attempts_exhausted())
        z.operator_resolve_reset()          # must NOT refuse
        self.assertEqual(self.mk(repair_attempt_cap=3)._read_counter(), 0)
        # survivor e-length pin: a valid-zero record + ONE trailing
        # NUL (17 bytes) is corrupt-and-healable — never treated as
        # live evidence that wedges the reset.
        fd = os.open(cp2, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, b"0 -" + b"\0" * 14)   # 3 + 14 = 17 bytes
        os.close(fd)
        e = self.mk(repair_attempt_cap=3)
        _n, _f, corr = e._counter_state()
        self.assertTrue(corr, "17 bytes is outside the fixed-width "
                              "grammar: corrupt, not live")
        e.operator_resolve_reset()          # must NOT refuse
        self.assertEqual(self.mk(repair_attempt_cap=3)._read_counter(), 0)


if __name__ == "__main__":
    unittest.main()
