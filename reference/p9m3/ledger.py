"""Reference implementation of the P9/M3 consumption-ledger contract
(spec docs/21-p9-m3-promotion-rollback-fleet-budget.md, DRAFT v42 as
amended by the v38-v42 review/audit cycles — (b-O) effective read, (c-O) forced
repair as an append, DURABILITY + RESOLVE-ON-USE with the resolve
attempt bound + sticky exhaustion, EXCLUSION LOCK, RESERVE-ON-APPEND,
staged classification with DEAD REPAIRs, AUTH files).

Scope: the ledger contract + fixtures F1-F62 plus the C6_* v42
round-5 pins (F60: no-pending resolve IO fault is bounded,
AUD45-c3-1; F61: the charge is crash-durable PRE-IO and an
unconfirmed charged attempt renders PENDING, AUD46-a1/a2; F62: the
OWED WITNESS survives `operator_resolve_reset()` — counter-0 owed
evidence keeps status/promote PENDING until a resolve COMPLETES,
AUD46-c1).
COVERAGE IS BY FIXTURE FAMILY, not one test per
label (D4A-c5-3 mapping): F14 is pinned inside test_F9_F14
(combined), F15's behavior is pinned by test_F6 (duplicate spec
row), and V33 rows F23/F25 share numbers with DIFFERENT v38
fixtures — the V33 late-AUTH-activation and crash-prefix semantics
are pinned by test_F23v33_* / test_F25v33_* (added by the
D4-scopeA cycle-5 fold, mutation-checked). (F23-F27 pin the v38 audit fixes; F28-F33 the v38
cycle-1/2 pins; F35-F57 the v40-v42 audit pins — mint
freshness/ULID conformance, cap-refusal preflight, F19 forced-order
serialization; F58-F59 pin the clamped diagnostic clock label and
the exact-cap reserve boundary; F1-F22 are re-verified against the
cycle-1 corrections: per-generation authority, resolve-before-act,
intent-before-byte settlement, fail-closed sidecars, strict schema
shape, outcome-unknown plumbing, owner-only paths). Pure stdlib.
Fault injection through FsFaults models hostile IO (EIO, partial
writes, lock contention, visibility failures) without real crashes;
F27 (and the fork + kill -9 partial-bytes case in
TestV38CyclePins) use a REAL SIGKILL — F20 simulates its crash with
an INJECTED EXCEPTION and does not kill a process (D4A-c1 finding 1).

F10 static rule honored by construction: this module performs NO
os.rename / os.truncate / unlink / write-mode open against the ledger,
the AUTH file, or the lock sidecar. Ledger growth is append-only
(O_WRONLY|O_APPEND, one logical append per record — a checked
short-write loop under the exclusion lock, v39 FRAMING); sidecars are
fixed-width in-place
rewrites. The only file creation that removes names is probe.py's probe
scratch cleanup (out of the live protocol) and tests seeding fixtures.

Modeling notes (reference-level choices where the spec is prose):
- "durability-pending" is re-derived from disk state via an
  INTENT-FIRST protocol: every ledger append writes the pending-sidecar
  P intent (fixed-width in-place rewrite + fsync) BEFORE any ledger
  byte, and only rewrites D after BOTH fsyncs covered the bytes. A
  crash between intent and D leaves the successor conservative (P
  visible); a crash after D leaves nothing to repair. D is written last
  (never before durability), so the window where bytes exist with no
  marker is eliminated (audit finding 1).
- The resolve attempt bound writes a crash-durable attempt counter
  BEFORE each attempt — recovery rounds (pending window) AND
  no-pending resolves alike (AUD45-c3-1 charged the failed IO;
  AUD46-a1 made the charge pre-IO: an interruption or crash DURING
  the IO leaves the attempt owed, so bounded retry cannot be
  defeated by fault timing). Success resets the counter ON
  COMPLETION; a crash between a successful IO and the completion-
  clear leaves the charge (conservative). Exhaustion is STICKY
  (counter + flag in one sidecar
  rewrite): once `resolve-exhausted`, no further automatic attempt is
  made — only the explicit operator path `operator_resolve_reset()`
  re-arms resolution (owner: exhaustion exits service, no silent pass).
- A CHARGED attempt with no pending window is an UNCONFIRMED
  resolve outcome, and `status()`/`promotion_allowed()` render it
  `durability-pending`, never `ok` (AUD46-a2): the default-deny
  premise holds the informational view until a resolve sequence
  SUCCEEDS and clears the counter.
- BINDING promotion decisions run through `promote(callback)` which
  holds ONE exclusion-lock acquisition across resolve + classification
  + decision + any in-lock appends (EXCLUSION LOCK (ii)). The
  read-only `promotion_allowed()` is an INFORMATIONAL snapshot only.
- A REPAIR whose authId names no AUTH cannot satisfy (c-O)(iii) =>
  reported `authorization-stale` (unknown-authId reasons surface in
  status.dead_repairs).
"""
from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import os
import stat
import time

from .probe import FSProbeError, FsFaults, run_probe

LOG_CAP = 64 * 1024 * 1024  # 64 MiB, reserve-on-append (v36 AUD35-M3)
CAPS = {"WATERMARK": 512, "APPLIED": 128, "REPAIR": 4096, "AUTH": 64 * 1024}

STATE_UNKNOWN = "unknown"
STATE_UNSETTLED = "unsettled-tail"
STATE_CONFLICT = "repair-conflict"
STATE_UNMASKED = "unmasked-malformed"
STATE_OK = "ok"
STATE_PENDING = "durability-pending"
STATE_EXHAUSTED = "resolve-exhausted"
STATE_LOCK_TIMEOUT = "ledger-lock-timeout"
AUTH_FILE_MALFORMED = "authorization-file-malformed"
# v38 cycle-3 fix 3 (AUD C3-3): the ONE strict resolve-attempts grammar
# (digits, single space, flag -|X); everything else on an EXISTING file
# is corrupt => exhausted. Compiled once at module level.
import re as _re
_COUNTER_RE = _re.compile(rb"(?:\d{1,10}) ([-X])")
# v38 cycle-3 fix 4 (AUD C3-4, spec draft AUTH READER BOUNDS): total
# valid-AUTH inventory bound — the 1025th valid line fails the file
# closed (unspent-AUTH leak, not legitimate load).
AUTH_INVENTORY_CAP = 1024


def _no_dup_keys(pairs):
    """json object_pairs_hook: refuse duplicate member names (v38 cycle-6,
    audit C4-3). Raising ValueError routes through the damage path."""
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate member name in journal object")
    return dict(pairs)


class LedgerError(Exception):
    """Rejection; .code is the spec's named reject code."""

    def __init__(self, code, **detail):
        super().__init__(code)
        self.code = code
        self.detail = detail


class _IOError0(OSError):
    def __init__(self, msg):
        super().__init__(errno.EIO, msg)


class Ledger:
    """One host's consumption ledger + AUTH file + lock sidecar.

    Construction runs the FS PROFILE startup probe (0A) on `directory`;
    any probe leg failing raises FSProbeError("fs-probe-failed:legN")
    and NO ledger service starts (no degraded mode).
    """

    def __init__(self, directory, *, fstype="local", faults=None,
                 repair_attempt_cap=3, lock_attempts=20,
                 lock_backoff=0.05, lock_backoff_cap=2.0, probe=True):
        self.dir = directory
        self.faults = faults or FsFaults()
        self.repair_attempt_cap = repair_attempt_cap
        self.lock_attempts = lock_attempts
        self.lock_backoff = lock_backoff
        self.lock_backoff_cap = lock_backoff_cap
        self.ledger_path = os.path.join(directory, "consumptions.jsonl")
        self.auth_path = os.path.join(directory, "authorizations.jsonl")
        self.lock_path = self.ledger_path + ".lock"
        self._pending_side = os.path.join(directory, "last-append")
        self._attempts_side = os.path.join(directory, "resolve-attempts")
        # AUD46-c1-1: the owed evidence must survive operator_reset —
        # the counter alone cannot carry it (reset zeroes it), so a
        # one-byte owed marker rides its own sidecar.
        # AUD46-c1 (audit cycle 1): OWED-ATTEMPT WITNESS. A resolve
        # attempt writes this marker BEFORE its charge+IO; a resolve
        # that completes fully clears it. `operator_resolve_reset()`
        # deliberately does NOT clear it: zeroing the counter must not
        # silently discard the evidence that an attempt was started and
        # never confirmed — until a resolve SUCCEEDS, the ledger stays
        # PENDING even at counter 0 (witness-overlay, status/promote).
        self._owed_side = os.path.join(directory, "resolve-owed")
        # v38 cycle-3 fix 6: the exclusion lock is tracked per instance —
        # `_append_bytes` REFUSES a write whose acquisition the caller
        # never performed (an unenforced caller contract is no contract).
        self._lock_fd = None
        self._lock_who = None
        self._lock_stat = None
        if probe:
            # Probe BEFORE creating anything: a rejected deployment leaves
            # zero trace (F22: service never starts, nothing written).
            # v38 cycle-6 (audit C1-3): the constructor's fault seam
            # must reach the probe — a modeled failing probe refuses.
            run_probe(directory, fstype=fstype, faults=self.faults)
        existed = os.path.isdir(directory)
        os.makedirs(directory, exist_ok=True, mode=0o700)
        if not existed:
            try:
                os.chmod(directory, 0o700)  # makedirs' mode is umask-filtered
            except OSError:
                pass
        self._check_access_controls()

    def _check_access_controls(self):
        """STRICT owner-only access controls (v38 cycle-3 fix 5,
        AUD C3-5; this docstring restated by AUD45-c2-1 after the
        v38 cycle-1 wording described the SUPERSEDED permissive
        policy): the protocol creates EVERY file 0600 and the ledger
        directory 0700, and at startup EVERY protocol path is checked
        against that premise — the protocol user must OWN every path,
        the directory must be exactly 0700, and EVERY protocol file
        must be exactly 0600: ANY bit outside 0600 (group READ
        included) is refused with `unsafe-path-permissions`, fail
        closed. There is NO "operator read-bit policy" exemption for
        the consumption evidence — an externally created 0644 fixture
        REFUSES, it is not tolerated. Symlinked protocol paths
        REFUSE (never followed). We never silently chmod a policy we
        do not own."""
        # v38 cycle-3 fix 5 (AUD C3-5): STRICT rules — the protocol
        # user must OWN every path, the directory is 0700 (owner-only),
        # and every protocol file is 0600: ANY bit outside 0600 (group
        # READ included) is refused, not just group/other write. There
        # is no "operator read-bit policy" exemption for the
        # consumption evidence: the spec's lock-conformance premise is
        # 0700 dirs / 0600 files owned by the protocol user.
        path = self.dir
        if os.path.isdir(path):
            st = os.stat(path)
            if st.st_uid != os.geteuid():
                raise LedgerError("unsafe-path-permissions", path=path,
                                  hint="ledger dir not owned by the "
                                       "protocol user")
            if st.st_mode & 0o077:
                raise LedgerError("unsafe-path-permissions", path=path,
                                  hint="ledger dir must be 0700 (owner-only)")
        for p in (self.ledger_path, self.auth_path, self.lock_path,
                  self._pending_side, self._attempts_side, self._owed_side,
                  os.path.join(self.dir, "repair_intent.jsonl")):
            try:
                st = os.lstat(p)          # never follow (v38 cycle-4 F4)
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(st.st_mode):
                raise LedgerError("unsafe-path-permissions", path=p,
                                  hint="protocol path is a symlink; the "
                                       "protocol never follows links")
            if st.st_uid != os.geteuid():
                raise LedgerError("unsafe-path-permissions", path=p,
                                  hint="protocol file not owned by the "
                                       "protocol user")
            if st.st_mode & 0o777 & ~0o600:
                raise LedgerError("unsafe-path-permissions", path=p,
                                  hint="protocol file must be 0600 "
                                       "(strict owner-only)")

    # ---------------- exclusion lock (v37 1A) ----------------

    def _acquire(self, who):
        delay = self.lock_backoff
        # TEST SEAM (v42 R5-c1, finding 1): invoked with the attempt
        # index each time flock() MISSES (contention), before the
        # retry sleep. It lets a fixture prove a rival DEMONSTRABLY
        # hit the busy lock (instead of trusting a sleep), so a
        # forced-order test trips its hang guard on a non-exclusive
        # lock instead of passing. Inert in production (unset => None).
        _miss_hook = getattr(self, "_test_hook_lock_miss", None)
        for i in range(self.lock_attempts):
            fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
                                 | os.O_NOFOLLOW, 0o600)
            try:
                # v38 cycle-4 fix 7 (AUD C4-F7): the `lock_busy` seam
                # models CONTENTION — like a real busy lock it must
                # fail every attempt (retry loop, then `ledger-lock-
                # held`), NEVER hand out an fd with no acquisition.
                if getattr(self.faults, "lock_busy", False):
                    raise BlockingIOError(errno.EWOULDBLOCK,
                                          "contention (modeled)")
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fd
            except OSError:
                os.close(fd)
            if _miss_hook is not None:
                _miss_hook(i, who)   # fires on EVERY miss incl. the last
            if i < self.lock_attempts - 1:
                time.sleep(min(delay, self.lock_backoff_cap))
                delay = min(delay * 2, self.lock_backoff_cap)
        raise LedgerError("ledger-lock-held" if who == "append"
                          else STATE_LOCK_TIMEOUT)

    class _Lock:
        def __init__(self, led, who):
            self.led, self.who = led, who
            self.fd = None

        def __enter__(self):
            self.fd = self.led._acquire(self.who)
            # v38 cycle-3 fix 6: record the acquisition on the instance
            # so `_append_bytes` can VERIFY the exclusion lock is held
            # (flock is per-fd; the public appends take their own fd,
            # so the flag is per-Ledger-instance, never cross-process).
            self.prev = (self.led._lock_fd, self.led._lock_who,
                         self.led._lock_stat)
            # v38 cycle-5 D4-B: record the lock file's IDENTITY at
            # acquisition; `_lock_held` re-verifies it, so an fd closed
            # behind our back and the NUMBER reused for a different
            # file is NOT accepted as "still held".
            self.led._lock_fd = self.fd
            self.led._lock_who = self.who
            self.led._lock_stat = os.fstat(self.fd)
            return self

        def __exit__(self, *exc):
            (self.led._lock_fd, self.led._lock_who,
             self.led._lock_stat) = self.prev
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd)
            return False

    def _lock(self, who):
        return self._Lock(self, who)

    def _lock_held(self, who=None):
        """True iff THIS instance currently holds an exclusion lock
        (optionally of the given kind) — set only by `_Lock.__enter__`
        (v38 cycle-3 fix 6). Verification is IDENTITY + LIVENESS
        (v38 cycle-5 D4-B): the stored fd must still be open AND refer
        to the SAME file (dev/ino match). HONEST SCOPE (v38 cycle-6
        audit correction): the check detects a stored fd that now
        refers to a DIFFERENT inode. It does NOT prove the fd still
        holds the flock: a same-inode reopen can reuse the fd number
        without holding any lock, and a replaced lock PATHNAME is not
        detected while the original fd stays open. Userspace cannot
        query flock ownership; continued exclusion rests on the same
        trust premise as append-only-ness (0700 dir, same host,
        single-writer discipline). Open spec question: docs/21 §D4-B."""
        fd = getattr(self, "_lock_fd", None)
        if fd is None:
            return False
        # a stored fd is verified ALIVE, and ALIVE-AS-THE-SAME-FILE
        # (v38 cycle-4 fix 7 + cycle-5 D4-B).
        try:
            st = os.fstat(fd)
        except OSError:
            self._lock_fd = None
            self._lock_who = None
            self._lock_stat = None
            return False
        held_st = getattr(self, "_lock_stat", None)
        if held_st is None or (st.st_dev, st.st_ino) != \
                (held_st.st_dev, held_st.st_ino):
            self._lock_fd = None
            self._lock_who = None
            self._lock_stat = None
            return False
        return who is None or self._lock_who == who

    # ---------------- sidecars (fixed-width in-place rewrites) ----------

    def _parse_counter(self):
        """THE counter reader (v38 cycle-3 fix 3, AUD C3-3): ONE strict
        parser serves EVERY path (status, the resolve loop, admission)
        — two readers can never disagree on the same bytes. Grammar:
        `<count>` 0–10 ASCII digits, ONE single space, flag exactly
        `-` or `X`, left-justified, NUL-padded to 16 bytes. MISSING file
        = (0, not exhausted). An EXISTING file failing the grammar for
        ANY reason (empty — torn creation; truncated; unparsable or
        negative count; unknown flag; wrong padding) = (cap+1, EXHAUSTED
        — fail closed; a corrupt bound never re-arms automatic
        rounds; only `operator_resolve_reset()` rewrites the record)."""
        try:
            fd = os.open(self._attempts_side, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return 0, False
        try:
            raw = os.pread(fd, 17, 0)      # 17 > 16: overlength is CORRUPT
        finally:
            os.close(fd)
        # strict: exactly the grammar, NUL padding to 16 (and only 16).
        # v38 cycle-4 fix 3 (AUD C4-F3): the record is FIXED WIDTH — a
        # SHORT existing file is a torn write, not a fresh counter:
        # truncated prefixes of valid records ("0 -", "0 -\0") never
        # re-arm resolution (fail closed like every other corruption).
        if len(raw) != 16:
            return self.repair_attempt_cap + 1, True
        body = raw.rstrip(b"\0")
        if _COUNTER_RE.fullmatch(body):
            n, flag = body.decode().split(" ")
            n = int(n)
            if n > self.repair_attempt_cap:      # range check: over-cap
                return n, True                   #   counts are exhausted
            return n, flag == "X"
        # EXISTING but corrupt (incl. empty file: torn creation)
        return self.repair_attempt_cap + 1, True

    def _read_counter(self):
        return self._parse_counter()[0]

    def _attempts_exhausted(self):
        return self._parse_counter()[1]

    # ---- AUD46-c1: owed-attempt witness (counter-0 survivor) ----

    def _write_owed(self):
        """Mark an attempt OWED — written BEFORE the charge+IO of every
        resolve attempt, fixed-width, same durability contract as the
        counter. A crash after this byte leaves the witness even if the
        charge itself was lost; `operator_resolve_reset()` preserves it
        (evidence of an unconfirmed attempt survives an operator
        re-arm — the only clear is a COMPLETED resolve)."""
        self._sidecar_write(self._owed_side, b"OWED".ljust(16, b"\0"))

    def _clear_owed(self):
        """Fixed-width zero rewrite — NEVER an unlink (F10: the
        protocol removes no names; a zeroed witness reads as none).
        AUD46-c3 (audit cycle 2, major 2): the ZERO TAIL is written
        FIRST — a crash mid-clear leaves the nonzero OWED head, which
        reads owed, instead of a zeroed head whose surviving tail
        bytes a head-first writer can no longer distinguish from a
        completed clear."""
        if os.path.exists(self._owed_side):
            fd = os.open(self._owed_side, os.O_RDWR | os.O_NOFOLLOW)
            try:
                # AUD46-c4 (audit cycle 3, major): retries slice the
                # REMAINING bytes — an un-sliced retry of a short
                # write writes past offset 16 and EXTENDS the fixed-
                # width witness (a wedged over-long record no healthy
                # resolve can ever clear). Same discipline as
                # _sidecar_write's payload[off:] loop.
                buf = b"\0" * 16
                for start, end in ((4, 16), (0, 4)):   # tail first
                    off = start
                    while off < end:
                        n = os.pwrite(fd, buf[off:end], off)
                        if n <= 0:
                            raise OSError(errno.EIO,
                                          "owed clear: zero progress")
                        off += n
                os.fsync(fd)
            finally:
                os.close(fd)

    def _owed_attempt(self):
        """True when a resolve attempt was started and never confirmed.
        MISSING = none; EXACTLY the 16-byte all-zero record = cleared
        none; EVERYTHING ELSE FAILS CLOSED as owed (AUD46-c3, audit
        cycle 2 majors 1+2): a torn creation — the name is visible the
        instant O_CREAT returns, the bytes are not, so a zero-LENGTH
        file is a torn creation, never a cleared record — partial or
        garbage payloads, and over-long hostile records."""
        try:
            fd = os.open(self._owed_side, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return False
        try:
            raw = os.pread(fd, 17, 0)     # 17: detect over-long too
        finally:
            os.close(fd)
        if len(raw) == 16:
            return raw != b"\0" * 16
        return True                     # torn/over-long: fail closed

    @staticmethod
    def _sidecar_write(path, payload):
        """Fixed-width in-place sidecar rewrite with CHECKED pwrite (loop
        on short writes) and, when the sidecar is CREATED by this call,
        a parent-directory fsync — the same durability contract (C22-F4)
        every other byte gets (v38 cycle-1 fix 5)."""
        existed = os.path.exists(path)
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            off = 0
            while off < len(payload):
                n = os.pwrite(fd, payload[off:], off)
                if n <= 0:
                    raise OSError(errno.EIO, "sidecar write: zero progress")
                off += n
            os.fsync(fd)
        finally:
            os.close(fd)
        if not existed:
            dirfd = os.open(os.path.dirname(path), os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)

    def _write_counter(self, n, exhausted=None):
        if exhausted is None:
            exhausted = self._attempts_exhausted()
        # v38 cycle-3 fix 3: exact drafted grammar — "N nnn flag", NUL-
        # padded to 16 (ljust spaces were a second, laxer dialect).
        payload = ("%d %s" % (n, "X" if exhausted else "-")).encode()
        payload = payload + b"\0" * (16 - len(payload))
        self._sidecar_write(self._attempts_side, payload)

    def _read_pending(self):
        """(offset, durable) of the last byte-producing append, or None.
        v38 cycle-1 fix 5: a CORRUPT record fails CLOSED as PENDING
        (offset 0) — never `None` (which would read as no window)."""
        try:
            fd = os.open(self._pending_side, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        try:
            raw = os.pread(fd, 24, 0)
        finally:
            os.close(fd)
        if not raw.strip(b"\0").strip():
            # v38 cycle-1 fix 8: an EXISTING but EMPTY sidecar is a
            # torn creation (the file landed, its payload did not) —
            # fail CLOSED as pending offset 0, never None ("no window").
            # A sidecar that was never created raises FileNotFoundError
            # above, which legitimately means no window.
            return (0, False)
        parts = raw.decode("utf-8", "replace").strip().split()
        if len(parts) not in (2, 3) or parts[1] not in ("D", "P"):
            return (0, False)
        try:
            return int(parts[0]), parts[1] == "D"
        except ValueError:
            return (0, False)

    def _write_pending(self, offset, durable, intent="-"):
        """INTENT-FIRST protocol: callers write the P INTENT (intent='-')
        BEFORE any ledger byte and D only after both fsyncs covered the
        bytes. `intent` carries the pending operation ('-' = plain
        append, 'R' = repair) so a successor can tell which protocol
        owns the unresolved window."""
        payload = ("%d %s %s" % (offset, "D" if durable else "P",
                                 intent)).ljust(24).encode()
        self._sidecar_write(self._pending_side, payload)

    def _pending_intent(self):
        rec = self._read_pending()
        if rec is None:
            return "-"
        # intent field (3rd token) is absent on legacy 2-token records
        try:
            fd = os.open(self._pending_side, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return "-"
        try:
            raw = os.pread(fd, 24, 0)
        finally:
            os.close(fd)
        parts = raw.decode().strip().split()
        return parts[2] if len(parts) >= 3 else "-"

    def _log_repair_intent(self, auth_id):
        """Append-only journal of repair attempts: one intent line before
        the REPAIR write, one outcome line when the outcome is known.
        A window closed by crash/SIGKILL leaves NO outcome line — the
        successor's re-derivation (classify: the REPAIR is present or
        not) is the authority; the journal is operator evidence that
        distinguishes `outcome-unknown` from a repair that never began."""
        self._journal_append({"t": "REPAIR-INTENT", "authId": auth_id,
                              "at": int(time.time())})

    def _log_repair_outcome(self, auth_id, outcome, durable):
        self._journal_append({"t": "REPAIR-OUTCOME", "authId": auth_id,
                              "outcome": outcome, "durable": durable,
                              "at": int(time.time())})

    AT_MAX = 10 ** 12 - 1        # S-J3-C: largest serialized `at` (12 digits)
    JOURNAL_CAP = 1 << 20        # journal READING is bounded (closes
                                 # the unbounded-read DoS seam)

    def _journal_append(self, rec):
        """Append one journal line with a CHECKED write (short-write
        loop) + file fsync + parent-directory fsync when the journal
        file is CREATED by this call — the same durability contract
        every other byte gets (v38 cycle-4 fix 2, AUD C4-F2).
        v38 cycle-6 (audit C1-2): the writer REFUSES any append that
        would take the journal past JOURNAL_CAP — otherwise a valid
        append could itself make the journal globally unreadable and
        stop every decision. Refusal is `journal-full` with ZERO bytes
        written. Operator recovery: S-J2 was RATIFIED (rotation via
        ROTATE-SNAPSHOT journal records + in-flight marker — see the
        S-J2 FINAL entry in docs/21a) but rotation is OUT OF SCOPE
        for this reference implementation (D4A-c4-1 SPEC note: the
        implementation-workstream decision is the owner's; here the
        refusal stands as the only behavior)."""
        p = os.path.join(self.dir, "repair_intent.jsonl")
        # `at` normalization (S-J3, FINAL — owner ratified the clamp
        # 2026-11-14: "ok. clamp for s-j3"). A non-int or bool `at` is
        # refused with zero bytes. Any int is CLAMPED into [0, AT_MAX]
        # (AT_MAX = 10**12-1, at most 12 digits) before serialization.
        # RATIFIED CONTRACT: `at` is a diagnostic label ONLY — no
        # ordering, counting, or inertness decision may consume it;
        # the sequence authority is journal append order under the
        # exclusion lock. Lossy saturation of out-of-domain clocks is
        # accepted behavior (docs/21a S-J3 FINAL).
        at = rec.get("at")
        if isinstance(at, bool) or not isinstance(at, int):
            raise LedgerError("journal-full", reason="timestamp-not-int")
        rec = dict(rec, at=min(max(at, 0), self.AT_MAX))
        data = json.dumps(rec, separators=(",", ":")).encode() + b"\n"
        try:
            cur = os.path.getsize(p)
        except FileNotFoundError:
            cur = 0
        # An intent must also leave room for its OUTCOME line: a REPAIR
        # that lands with no durable outcome record would be unrecordable.
        need = len(data)
        if rec.get("t") == "REPAIR-INTENT":
            # v38 cycle-6 (audit C2-2/C3-1): reserve the outcome at its
            # WORST serialized size: the maximum-width `at` (AT_MAX) with
            # the longest outcome token and durable:false. CAPACITY
            # RESERVATION only, for valid integer timestamps and the same
            # authId: it does not promise successful I/O, and a crash can
            # still leave an intent without an outcome line.
            need += len(json.dumps(
                {"t": "REPAIR-OUTCOME", "authId": rec.get("authId", ""),
                 "outcome": "outcome-unknown", "durable": False,
                 "at": self.AT_MAX},
                separators=(",", ":")).encode()) + 1
        if cur + need > self.JOURNAL_CAP:
            raise LedgerError("journal-full", cap=self.JOURNAL_CAP)
        existed = os.path.exists(p)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND
                             | os.O_NOFOLLOW, 0o600)
        try:
            off = 0
            while off < len(data):
                n = os.write(fd, data[off:])
                if n <= 0:
                    raise OSError(errno.EIO, "journal write: zero progress")
                off += n
            os.fsync(fd)
        finally:
            os.close(fd)
        if not existed:
            dirfd = os.open(self.dir, os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)

    # Journal record grammar (v38 cycle-5, owner decisions D2-A ratifies
    # the drafted strictness; AUD audit findings 2/3): every TERMINATED
    # line must parse as a JSON OBJECT with EXACTLY these keys —
    #   REPAIR-INTENT:   {"t","authId","at"}
    #   REPAIR-OUTCOME:  {"t","authId","outcome","durable","at"}
    # outcome in {repaired, failed-clean, outcome-unknown}; authId a
    # non-empty string; at an int. ANY damage — non-object JSON, schema
    # violation, unknown kind, unterminated tail, over-cap, unreadable
    # file — fails CLOSED as `journal-unreadable` for EVERY reader.
    # There is NO per-record quarantine and NO keyword heuristics: a
    # torn write usually cuts off before the authId field completes, so
    # "count only if identity is complete" (option C) would forgive the
    # attempt in exactly the crash window it exists to catch, and
    # skipping undecidable records (option B) lets two readers disagree.
    _J_INTENT_KEYS = frozenset({"t", "authId", "at"})
    _J_OUTCOME_KEYS = frozenset({"t", "authId", "outcome", "durable",
                                 "at"})
    _J_OUTCOMES = frozenset({"repaired", "failed-clean",
                             "outcome-unknown"})

    def _journal_records(self):
        """Read the journal BOUNDED (JOURNAL_CAP) and STRICTLY validate
        every record; returns the list of records, or raises
        `journal-unreadable` on ANY damage. A MISSING file (ENOENT
        alone) is the empty journal; a dangling symlink or any other
        read error is damage, never "absent"."""
        p = os.path.join(self.dir, "repair_intent.jsonl")
        try:
            fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return []                     # ENOENT ONLY = fresh journal
        except OSError:
            raise LedgerError("journal-unreadable",
                              detail="repair_intent.jsonl cannot be "
                                     "opened (symlink? corrupt?); fail "
                                     "closed")
        try:
            chunks = []
            total = 0
            while True:
                try:
                    c = os.read(fd, 1 << 16)
                except OSError:
                    # v38 cycle-6 (audit finding 3): a read error is
                    # damage, never a raw OSError past the contract
                    raise LedgerError(
                        "journal-unreadable",
                        detail="repair_intent.jsonl read failed; "
                               "fail closed")
                if not c:
                    break
                chunks.append(c)
                total += len(c)
                if total > self.JOURNAL_CAP:
                    raise LedgerError(
                        "journal-unreadable",
                        detail="repair_intent.jsonl exceeds %d bytes; "
                               "fail closed" % self.JOURNAL_CAP)
        finally:
            os.close(fd)
        data = b"".join(chunks)
        if data and not data.endswith(b"\n"):
            raise LedgerError("journal-unreadable",
                              detail="unterminated trailing record: the "
                                     "journal's frame boundary is damaged; "
                                     "no attempt may be re-armed from it")
        records = []
        # v38 cycle-6 (audit finding 4): every TERMINATED line is a
        # record; a blank line is not JSON and is damage. The empty FILE
        # (zero bytes) is the only valid empty journal.
        for raw in (data.split(b"\n")[:-1] if data else []):
            if not raw:
                raise LedgerError("journal-unreadable",
                                  detail="blank physical line in journal; "
                                         "fail closed")
            try:
                # v38 cycle-6 (audit C4-3, spec sharpening S-J1 ratified
                # here as the implementation of D2-A): a duplicate member
                # name in a journal object is damage. Python's default
                # last-wins collapse would let two readers disagree about
                # which AUTH consumed the attempt.
                rec = json.loads(raw.decode("utf-8"),
                                 object_pairs_hook=_no_dup_keys)
            except (UnicodeDecodeError, ValueError, RecursionError):
                # v38 cycle-6 (audit C2-4): JSONDecodeError is a
                # ValueError; deep nesting raises RecursionError. Both
                # are damage, never a raw exception.
                raise LedgerError(
                    "journal-unreadable",
                    detail="torn/unparsable line; the AUTH identity of "
                           "a damaged record is undecidable; fail closed")
            self._journal_check(rec)
            records.append(rec)
        return records

    @classmethod
    def _journal_check(cls, rec):
        """Per-record schema (D2-A): object, exact key set, valid enum
        and field types. ANY violation => `journal-unreadable`."""
        if not isinstance(rec, dict):
            raise LedgerError("journal-unreadable",
                              detail="non-object journal record "
                                     "(%s); fail closed"
                                     % type(rec).__name__)
        t = rec.get("t")
        if t == "REPAIR-INTENT":
            keys = cls._J_INTENT_KEYS
        elif t == "REPAIR-OUTCOME":
            keys = cls._J_OUTCOME_KEYS
        else:
            raise LedgerError("journal-unreadable",
                              detail="unknown journal record kind %r; "
                                     "fail closed" % (t,))
        if frozenset(rec) != keys:
            raise LedgerError("journal-unreadable",
                              detail="journal %s key-set violation; "
                                     "fail closed" % t)
        a = rec.get("authId")
        if not isinstance(a, str) or not a:
            raise LedgerError("journal-unreadable",
                              detail="journal authId missing/empty; "
                                     "fail closed")
        at = rec.get("at")
        # S-J3-C: the writer only ever emits `at` in [0, AT_MAX] (see
        # _journal_append); anything else is damage.
        if isinstance(at, bool) or not isinstance(at, int) \
                or not (0 <= at <= cls.AT_MAX):
            raise LedgerError("journal-unreadable",
                              detail="journal 'at' outside [0, AT_MAX]; "
                                     "fail closed")
        if t == "REPAIR-OUTCOME":
            oc = rec.get("outcome")
            if not isinstance(oc, str) or oc not in cls._J_OUTCOMES:
                raise LedgerError("journal-unreadable",
                                  detail="unknown journal outcome %r; "
                                         "fail closed"
                                         % (rec.get("outcome"),))
            if not isinstance(rec.get("durable"), bool):
                raise LedgerError("journal-unreadable",
                                  detail="journal 'durable' not a bool; "
                                         "fail closed")

    def _clean_failure_count(self, auth_id):
        """CONSUMED (c-O) ATTEMPTS for authId (v38 cycle-5, owner
        decision D1-A — TOTAL-ATTEMPT CAP): the crash-durable journal
        is the enforcement record and every `REPAIR-INTENT` for this
        authId is one consumed attempt, PERIOD — orphan intents (crash
        before the outcome landed), paired intents, and outcomes
        included. The cap (2) applies to the total; a resolved
        `outcome-unknown` grants NO free slot and an orphan is NOT
        reabsolved by ledger evidence. The ONLY reset is a VALID,
        DURABLE `repaired` outcome (`durable is True`) for this authId
        — a `durable:false` "repaired" never resets (AUD finding 2:
        the old code reset on any repaired outcome, re-arming the
        bound on a NON-durable success). Any journal damage fails
        CLOSED as `journal-unreadable` (D2-A); only ENOENT (fresh
        journal) counts as zero."""
        n = 0
        for rec in self._journal_records():
            if rec["authId"] != auth_id:
                continue
            if rec["t"] == "REPAIR-INTENT":
                n += 1
            elif (rec.get("outcome") == "repaired"
                  and rec.get("durable") is True):
                n = 0                       # strict durable success
        return n

    def durability_pending(self):
        rec = self._read_pending()
        return rec is not None and not rec[1]

    # ---------------- (b-O) framing, parsing, classification ----------------

    @staticmethod
    def _sha(data):
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def _schema_kind(raw, allow_auth=False):
        """Return kind if raw bytes parse as a schema-valid known-kind
        record, else None (stage-2: any other terminated line is a
        MALFORMED OCCURRENCE — no third class). v38 cycle-1 fix 9:
        STRICT shape — exact key sets (unknown/extraneous keys make the
        line malformed, not a valid record of a looser schema), bools
        rejected where ints are required, hashes must be 64 lowercase
        hex. C2 cycle-2 fix 9: AUTH is NOT a consumption-log kind —
        an AUTH-shaped line inside the consumption log is a malformed
        occurrence (authorizations live ONLY in the separate AUTH file;
        `allow_auth=True` is used solely by the AUTH-file reader)."""
        try:
            rec = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            # v38 cycle-6 (audit C5-3): RecursionError from deep nesting is
            # a malformed occurrence, never a raw exception.
            return None
        if not isinstance(rec, dict):
            return None
        t = rec.get("t")
        if t == "WATERMARK":
            ok = (set(rec) == {"t", "hostToken", "watermark", "confirmGen"}
                  or set(rec) == {"t", "hostToken", "watermark",
                                  "confirmGen", "consumedAt"})
            ok = ok and isinstance(rec.get("hostToken"), str) and rec["hostToken"]
            ok = ok and _is_int(rec.get("watermark"))
            ok = ok and isinstance(rec.get("confirmGen"), str) and rec["confirmGen"]
        elif t == "APPLIED":
            ok = (set(rec) == {"t", "authId"}
                  and isinstance(rec.get("authId"), str) and rec["authId"])
        elif t == "REPAIR":
            ok = set(rec) == {"t", "authId", "masks", "all"}
            ok = ok and isinstance(rec.get("authId"), str) and rec["authId"]
            if ok:
                ok = Ledger._valid_mask_list(rec.get("masks"))
            if ok:
                allc = rec.get("all")
                ok = (isinstance(allc, dict)
                      and set(allc) == {"hostToken", "watermark", "confirmGen"}
                      and allc.get("hostToken") == "ALL"
                      and _is_int(allc.get("watermark"))
                      and isinstance(allc.get("confirmGen"), str)
                      and allc["confirmGen"])
        elif t == "AUTH":
            if not allow_auth:
                # C2 cycle-2 fix 9: AUTH is not a consumption-log kind.
                return None
            ok = (set(rec) == {"t", "authId", "occurrences", "createdAt"}
                  and isinstance(rec.get("authId"), str) and rec["authId"])
            if ok:
                ok = Ledger._valid_mask_list(rec.get("occurrences"))
        else:
            return None
        return t if ok else None

    def _read_bytes(self):
        """BOUNDED full read (v38 cycle-1 fix 11): reads never exceed
        LOG_CAP + slack — an over-cap log is classified `unknown` (the
        check in classify), so reading past the cap has no decision
        value and must not pull unbounded attacker-controlled bytes
        into memory.
        R3-c3 CODE-2 (v40): fault seams `open_raises` / `read_raises`
        inject EIO on the open and on the read independently (pins
        prove classification fails CLOSED to `unknown`, not raw
        OSError)."""
        if getattr(self.faults, "open_raises", False):
            raise OSError(errno.EIO, "injected open failure")
        try:
            fd = os.open(self.ledger_path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return b""
        try:
            chunks = []
            total = 0
            limit = LOG_CAP + (1 << 20)
            while True:
                if getattr(self.faults, "read_raises", False):
                    raise OSError(errno.EIO, "injected read failure")
                c = os.read(fd, min(1 << 20, limit - total))
                if not c:
                    break
                chunks.append(c)
                total += len(c)
                if total >= limit:
                    break
            return b"".join(chunks)
        finally:
            os.close(fd)

    def classify(self, data=None):
        """(b-O) ALGORITHM over a FULL read — staged, total, first-match,
        precedence stage 1 > stage 4 > stage 5. Exactly one state.
        Returns a dict; `state` excludes the observer-gate overlay."""
        if data is None:
            # R3-c3 CODE-2 (v40): an UNREADABLE consumption log is
            # `unknown` (contract: stage 1 "log > 64 MiB or unreadable
            # => unknown"). ENOENT-as-empty is preserved by
            # _read_bytes; every other open/read OSError fails CLOSED
            # to `unknown` instead of escaping as a raw exception.
            try:
                data = self._read_bytes()
            except OSError:
                res0 = {"state": STATE_UNKNOWN, "dead_repairs": [],
                        "masked": 0, "spent": set(), "effective_all": 0,
                        "authorization_file_malformed": False, "auths": [],
                        "valid_repairs": []}
                return res0
        res = {"dead_repairs": [], "masked": 0, "spent": set(),
               "effective_all": 0, "authorization_file_malformed": False,
               "auths": [], "valid_repairs": []}

        # stage 1 (framing)
        if len(data) > LOG_CAP:
            res["state"] = STATE_UNKNOWN
            return res
        tail_unsettled = False
        blank_occ = None
        if data and not data.endswith(b"\n"):
            tail = data[data.rfind(b"\n") + 1:]
            if tail.strip(b" \t\r"):
                tail_unsettled = True
            blank_occ = blank_occurrence(data, tail)

        # line inventory: EVERY terminated physical line (blank ones
        # included) is an entry — a blank line is a MALFORMED OCCURRENCE
        # (stage 2 has no third class; owner 2A).
        inventory = physical_lines(data)
        lines = [(off, raw) for off, raw in inventory if raw.strip(b" \t\r")]

        auths, auth_file_malformed = self._read_auths()
        res["auths"] = auths
        res["authorization_file_malformed"] = auth_file_malformed
        l_c = self.confirmation_length()

        # stage 2 (syntax)
        valid_records = []  # (offset, kind, rec, raw)
        occurrences = []    # malformed occurrences (offset, hash, raw)
        for offset, raw in lines:
            kind = self._schema_kind(raw)
            if kind is None:
                occurrences.append({"offset": offset,
                                    "hash": self._sha(raw), "raw": raw})
            else:
                valid_records.append((offset, kind, json.loads(raw.decode()), raw))

        by_auth = {}
        for a in auths:
            by_auth.setdefault(a["authId"], []).append(a)

        # stage 3 (semantics): REPAIR VALID or DEAD (never an occurrence)
        dead = []
        repairs = []
        for offset, kind, rec, raw in valid_records:
            if kind != "REPAIR":
                continue
            reason = None
            named = by_auth.get(rec["authId"], []) if not auth_file_malformed else []
            if len(named) != 1:
                reason = "unknown-authId"
            elif rec["masks"] != named[0]["occurrences"]:
                reason = "mask-mismatch"
            else:
                occ_at = {o["offset"]: o for o in occurrences}
                for e in rec["masks"]:
                    o = occ_at.get(e["offset"])
                    if o is None or o["hash"] != e["hash"]:
                        reason = "mask-mismatch"
                        break
            if reason is None and rec["all"]["watermark"] > l_c:
                reason = "mask-mismatch"  # ALL.watermark > current L_C
            # v39 R2-B2 generation binding (R3-c1 CODE-1 fix): the
            # REPAIR is bound to the confirmation-log generation it
            # recorded in all.confirmGen at (c-O) step (i); on EVERY
            # read the confirmation log's CURRENT generation header
            # must equal it, else the REPAIR is DEAD (a confirmation-
            # log repair publishing a NEW generation leaves
            # old-generation REPAIRs permanently DEAD - F24). Reported
            # under the closed 2-reason set (mask-mismatch = "bound
            # precondition not met on this read").
            if reason is None and self.confirmation_gen() != \
                    rec["all"]["confirmGen"]:
                reason = "mask-mismatch"  # generation header moved on
            if reason is not None:
                dead.append({"offset": offset, "hash": self._sha(raw),
                             "reason": reason})
            else:
                repairs.append({"offset": offset, "rec": rec})
        res["dead_repairs"] = dead
        res["valid_repairs"] = [r["rec"] for r in repairs]

        # stage 1 continued: unsettled tail dominates stage 4/5
        if tail_unsettled:
            res["state"] = STATE_UNSETTLED
            res["occurrences"] = occurrences
            return res

        # stage 4 (conflict): same authId, unequal masks or confirmGen
        seen = {}
        conflict = False
        for r in repairs:
            key = r["rec"]["authId"]
            sig = (json.dumps(r["rec"]["masks"], sort_keys=True),
                   r["rec"]["all"]["confirmGen"])
            if key in seen and seen[key] != sig:
                conflict = True
            seen[key] = sig

        # (6) effective authority: max-per-(confirmGen, hostToken)
        # algebra (v38 cycle-1 fix 1): watermarks and REPAIR ALLs are
        # keyed by generation — an old generation's watermark never
        # suppresses a newer one (spec: generations are distinct; a
        # generation with no watermark lines is fully active).
        max_per_gen = {}          # flat view (per hostToken; legacy/test)
        by_generation = {}        # (confirmGen, hostToken) -> max
        for offset, kind, rec, raw in valid_records:
            if kind == "WATERMARK":
                max_per_gen[rec["hostToken"]] = max(
                    max_per_gen.get(rec["hostToken"], 0), rec["watermark"])
                key = (rec["confirmGen"], rec["hostToken"])
                by_generation[key] = max(by_generation.get(key, 0),
                                         rec["watermark"])
        for r in repairs:
            gen = r["rec"]["all"]["confirmGen"]
            max_per_gen["ALL"] = max(max_per_gen.get("ALL", 0),
                                     r["rec"]["all"]["watermark"])
            key = (gen, "ALL")
            by_generation[key] = max(by_generation.get(key, 0),
                                     r["rec"]["all"]["watermark"])
        res["max_per_host"] = max_per_gen
        res["by_generation"] = by_generation
        # Flat cross-generation ALL max (conservative aggregate view);
        # the per-generation algebra above is the decision basis for
        # inertness (`confirmation_clears`): a confirmation is judged
        # against the ALL watermark OF ITS OWN GENERATION — a
        # generation with no ALL line is fully active (effective 0).
        res["effective_all"] = max_per_gen.get("ALL", 0)

        # (7) SPENT: authIds of VALID REPAIR and APPLIED lines
        spent = {r["rec"]["authId"] for r in repairs}
        for offset, kind, rec, raw in valid_records:
            if kind == "APPLIED":
                spent.add(rec["authId"])
        res["spent"] = spent

        # stage 5 (coverage): every malformed occurrence masked at its
        # exact (offset,hash) by a VALID REPAIR
        masked_offsets = set()
        for r in repairs:
            for e in r["rec"]["masks"]:
                masked_offsets.add((e["offset"], e["hash"]))
        unmasked = [o for o in occurrences
                    if (o["offset"], o["hash"]) not in masked_offsets]
        res["masked"] = len(occurrences) - len(unmasked)
        res["occurrences"] = occurrences
        res["unmasked"] = unmasked

        if conflict:
            res["state"] = STATE_CONFLICT
            return res
        if unmasked:
            res["state"] = STATE_UNMASKED
            return res
        res["state"] = STATE_OK
        return res

    @staticmethod
    def _valid_mask_list(lst):
        if not isinstance(lst, list):
            return False
        for e in lst:
            if not isinstance(e, dict) or set(e) != {"offset", "hash"}:
                return False
            if not _is_int(e["offset"]):
                return False
            h = e["hash"]
            if not isinstance(h, str) or len(h) != 64 or \
                    any(c not in "0123456789abcdef" for c in h):
                return False
        return True

    # ---------------- AUTH file ----------------

    def _read_auths(self):
        """Returns (valid_auths, malformed_flag). Any unterminated
        NONBLANK tail or terminated nonblank-malformed line fails
        CLOSED for every authorization (v34 AUTH rule, F9/F14); a
        whitespace-only unterminated tail is stripped, consistent
        with the (b-O) blank-tail rule (AUD45-c5-1).
        v38 cycle-3 fix 4 (AUD C3-4): the read STREAMS in bounded chunks
        and counts the CURRENT physical line incrementally — the 64 KiB
        per-line cap is enforced the moment it is crossed, BEFORE the
        remainder is read, parsed, or retained, so no legal or hostile
        AUTH file can make this reader allocate unbounded memory (the
        old whole-file join did). The 1025th schema-valid AUTH line is
        itself malformed (AUTH_INVENTORY_CAP, spec draft): a healthy
        fleet stays far below — reaching it is an unspent-AUTH leak."""
        try:
            fd = os.open(self.auth_path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return [], False
        auths = []
        malformed = False
        carry = b""            # bytes of the current line kept so far
        chunk_size = 1 << 14   # 16 KiB: strictly below the line cap
        try:
            while True:
                if malformed:
                    break    # cap crossed mid-line: stop reading entirely
                chunk = os.read(fd, chunk_size)
                if not chunk:
                    break
                pos = 0
                while pos < len(chunk):
                    nl = chunk.find(b"\n", pos)
                    if nl == -1:
                        piece = chunk[pos:]
                        carry += piece
                        if len(carry) > CAPS["AUTH"]:
                            # cap crossed MID-LINE: fail closed without
                            # reading or retaining any more of the file
                            malformed = True
                            break
                        pos = len(chunk)
                    else:
                        line = carry + chunk[pos:nl]
                        carry = b""
                        pos = nl + 1
                        if line.strip(b" \t\r"):
                            if len(line) > CAPS["AUTH"] or \
                                    Ledger._schema_kind(
                                        line, allow_auth=True) != "AUTH":
                                malformed = True
                            else:
                                if len(auths) >= AUTH_INVENTORY_CAP:
                                    malformed = True   # inventory bound
                                else:
                                    auths.append(json.loads(
                                        line.decode()))
            # unterminated tail: nonblank run after the last \n is
            # malformed; a tail still under the cap only proves the
            # file ends mid-line (v34 rule: fail closed).
            if carry.strip(b" \t\r"):
                malformed = True
        finally:
            os.close(fd)
        return auths, malformed

    # ---------------- confirmation log (test seam) ----------------

    def confirmation_length(self):
        p = os.path.join(self.dir, "confirmations.jsonl")
        try:
            return os.path.getsize(p)
        except FileNotFoundError:
            return 0

    def seed_confirmation_log(self, data):
        """TEST SEAM ONLY: the confirmation log lives outside the live
        protocol (test stand-in for the confirmation service)."""
        p = os.path.join(self.dir, "confirmations.jsonl")
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)

    def confirmation_clears(self, offset, cls=None, gen=None):
        """ALL inertness (v38 cycle-1 fix 1): a confirmation issued in
        generation `gen` at byte `offset` is inert iff offset < the ALL
        watermark OF THAT GENERATION; ACTIVE otherwise (F2/F3). A
        generation with no ALL line is fully active (threshold 0), so an
        old generation's watermark NEVER suppresses a newer one. With
        `gen` omitted the conservative flat cross-generation max is
        used (a caller that knows the confirmation's generation must
        pass it)."""
        cls = cls or self.classify()
        if gen is None:
            return offset >= cls["effective_all"]
        threshold = cls["by_generation"].get((gen, "ALL"), 0)
        return offset >= threshold

    # ---------------- append paths ----------------

    def _frame(self, record_json):
        return b"\n" + record_json.encode() + b"\n"

    def _append_bytes(self, framed, kind_cap_checked=None, intent="-"):
        """One reserved logical append under the EXCLUSION LOCK — HELD
        VERIFIED (v38 cycle-3 fix 6 / cycle-4 fix 1; v39 AUDV1-M3:
        "single write" conformed to the FRAMING loop — the first write
        plus any short-write continuations, all under this one
        acquisition): EVERY write requires a live
        lock acquisition BY THIS INSTANCE (fstat-verified fd, v38
        cycle-4 fix 7); there is NO declaration that skips the
        assertion — a write whose acquisition this instance did not
        perform REFUSES with `lock-required-not-held` BEFORE any intent
        or ledger byte.
        INTENT-FIRST: the P intent (offset + intent tag) is durably
        written BEFORE any ledger byte, D only after both fsyncs — so
        there is no window where ledger bytes exist with no marker.
        Returns the byte offset written. Raises LedgerError/IOError per
        fault seam; any byte-producing attempt leaves the pending sidecar
        at P (re-derived durability, v36 rule)."""
        if not self._lock_held():
            raise LedgerError("lock-required-not-held",
                              hint="_append_bytes must run under this "
                                   "instance's exclusion lock")
        size = getattr(self.faults, "size_override", None)
        if callable(size):
            size = size()
        if size is None:
            size = os.path.getsize(self.ledger_path) if os.path.exists(
                self.ledger_path) else 0
        if size + len(framed) > LOG_CAP:
            # R5-c4 f1: the detail reports the SAME local operands the
            # comparison above consumed (no re-read, no recompute), so
            # a fixture asserting these values pins the comparison
            # itself — reported-vs-compared divergence is impossible
            # here by construction.
            raise LedgerError("log-cap-exceeded", size=size,
                              framed=len(framed))
        # TEST SEAM (v42, R5-audit F1): a callable invoked under the
        # exclusion lock AFTER the reserve check and BEFORE any intent
        # or ledger byte. It lets a fixture DETERMINISTICALLY force
        # each serial order (the holder parks inside its reservation
        # while the rival blocks on the lock), so the contract F19 row
        # is proven in BOTH orders instead of trusting kernel wake-up.
        # Production passes nothing (None => no effect).
        _order_hook = getattr(self, "_test_hook_after_reserve", None)
        if _order_hook:
            _order_hook()
        if getattr(self.faults, "write_raises", False):
            raise _IOError0("hostile-io:before-write")
        # INTENT: P + operation ('R' for repair) before the first ledger
        # byte (v38 audit fix 1). Every later P-update preserves the
        # intent: if we die mid-write the successor must see WHICH
        # protocol owns the unresolved window.
        partial = getattr(self.faults, "partial_write", None)
        self._write_pending(size, False, intent)
        fd = os.open(self.ledger_path, os.O_WRONLY | os.O_CREAT
                             | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        try:
            data = framed if partial is None else framed[:partial]
            written = os.write(fd, data)
            if partial is not None:
                self._write_pending(size, False, intent)
                raise _IOError0("hostile-io:partial-write")
            if written <= 0:
                # audit cycle-7 finding 1: a zero FIRST write is no progress;
                # it must not be treated as a short write and then retried.
                raise OSError(errno.EIO, "ledger write: zero progress")
            if written < len(framed):  # kernel short write: loop per spec
                rest = framed[written:]
                while rest:
                    n = os.write(fd, rest)
                    if n <= 0:
                        raise OSError(errno.EIO, "ledger write: zero progress")
                    rest = rest[n:]
            self._write_pending(size, False, intent)
            if getattr(self.faults, "fsync_fault", False):
                raise _IOError0("hostile-io:fsync")
            os.fsync(fd)
        finally:
            os.close(fd)
        if getattr(self.faults, "dir_fsync_fault", False):
            self._write_pending(size, False, intent)
            raise _IOError0("hostile-io:dir-fsync")
        dirfd = os.open(self.dir, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
        self._write_pending(size, True)
        return size

    def _resolve_io(self):
        """THE RESOLVE SEQUENCE's IO body: fsync(file) (skipped only when
        the ledger file does not exist — nothing to make durable),
        fsync(parent dir), then the (b-O) FULL read. The full read MUST
        SUCCEED for the round to count (v38 fix 6): a failed read leaves
        the round failed, never a cleared marker over an unread basis.
        Returns the read bytes (the decision basis). C2 cycle-2 fix 1:
        this runs on EVERY resolve — pending or not — the sidecar is a
        conservative crash marker, never proof of durability (spec
        DURABILITY: "any process making an AUTHORITY or SPEND decision
        must first perform the RESOLVE SEQUENCE")."""
        if getattr(self.faults, "resolve_fsync_fault", False):
            raise _IOError0("hostile-io:resolve-fsync")
        try:
            fd = os.open(self.ledger_path,
                         os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except FileNotFoundError:
            pass                       # no ledger file: nothing to fsync
        dirfd = os.open(self.dir, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
        return self._read_bytes()

    def _resolve_locked(self):
        """RESOLVE SEQUENCE under the held lock (C2 cycle-2 fixes 1+4).
        v38 cycle-2 fix 1: the sequence (fsync file, fsync parent dir,
        FULL read) is performed on EVERY resolve — ALWAYS — regardless
        of the pending sidecar. A missing or durable-marked sidecar is
        NEVER a substitute for the durable resolution; its absence does
        not prove visible bytes are durable. Bounded by
        repair_attempt_cap per PENDING episode (v37 AUD36-M1): the
        crash-durable counter is bumped BEFORE EVERY attempt — each
        recovery round AND each no-pending resolve (AUD45-c3-1 +
        AUD46-a1: a crashed/interrupted attempt counts; success
        clears on completion).
        v38 cycle-2 fix 4: once the cap attempts are
        consumed the NEXT round REFUSES BEFORE ANY RESOLVE IO — a cap of
        N never permits an (N+1)-st automatic round, and exhaustion is
        persisted before the refusal raises. STICKY (v38 fix 4): the
        exhausted flag refuses every further automatic attempt across
        processes; only `operator_resolve_reset()` re-arms. A round
        that completes fully IS the resolution: clears counter+pending.
        Returns classification over the FULL READ."""
        # v38 cycle-6 (audit C1-1): the strict journal gate is part of
        # the SHARED resolve path — every decision and every decision-
        # bearing append resolves here first, so none can act on a
        # damaged journal (D2-A global refusal, zero bytes written).
        self._journal_records()
        if self._attempts_exhausted():
            raise LedgerError(STATE_EXHAUSTED)
        if not self.durability_pending():
            # AUD45-c3-1 (CODE fix): a FAILED no-pending resolve IS a
            # bounded attempt. The v38 comment ("the resolve is owed
            # but is not a recovery ATTEMPT — no counter is consumed")
            # was true of SUCCESS only: a persistent resolve-IO fault
            # on this path never consumed the counter, so the loop
            # retried forever and the sticky exhaustion the spec
            # requires ("Resolution attempts are BOUNDED per episode
            # ... No schedule drives an unbounded loop") never
            # arrived. NOW: the cap refusal precedes the IO (persist-
            # first, same discipline as the recovery round below).
            n = self._read_counter()
            if n >= self.repair_attempt_cap:
                self._write_counter(n, exhausted=True)
                raise LedgerError(STATE_EXHAUSTED)
            # AUD46-a1 (independent-session audit, major): the
            # AUD45-c3-1 charge POSTED THE IO ("consumed ONLY on IO
            # failure") — an interruption or crash DURING the IO
            # left the counter untouched, so bounded retry was
            # defeatable by fault timing. NOW the charge is
            # CRASH-DURABLE PRE-IO (same discipline as the recovery
            # round): the attempt is owed the moment the service
            # starts it; a successful resolve clears it (success is
            # counter-free on completion — fix 1 — but a CRASHED
            # attempt is charged; AUD46-a1 verdict).
            # AUD46-c1 (audit cycle 1): the OWED WITNESS lands BEFORE
            # the charge — an attempt is owed the moment the service
            # commits to starting it; a crash anywhere before the
            # completion-clear leaves the evidence, and
            # `operator_resolve_reset()` cannot erase it (only a
            # successful resolve clears it).
            self._write_owed()
            self._write_counter(n + 1, exhausted=False)
            try:
                data = self._resolve_io()
            except OSError:
                # cannot even establish the durable basis => fail
                # closed; the pre-charged attempt is already durable
                raise LedgerError(STATE_PENDING)
            # success closes the episode: clear the pre-charged
            # attempt (fix 1: success is counter-free ON COMPLETION;
            # a crash between the IO and this clear leaves the
            # charge owed — conservative, same discipline as the
            # recovery round, whose crashed rounds count)
            self._write_counter(0, exhausted=False)
            self._clear_owed()          # AUD46-c1: witness clears
                                        # ONLY on confirmed success
            return self.classify(data)
        # C2 fix 4: refusal BEFORE starting a round whose attempts are
        # already consumed — persist exhaustion first, then raise; the
        # extra round never touches IO.
        n = self._read_counter()
        if n >= self.repair_attempt_cap:
            self._write_counter(n, exhausted=True)
            raise LedgerError(STATE_EXHAUSTED)
        n += 1
        self._write_owed()              # AUD46-c1: witness before charge+IO
        self._write_counter(n, exhausted=False)
        try:
            data = self._resolve_io()
        except OSError:
            raise LedgerError(STATE_PENDING)
        self._write_pending(self._pending_offset(), True)
        self._write_counter(0, exhausted=False)
        self._clear_owed()              # AUD46-c1: confirmed success
        return self.classify(data)

    def _pending_offset(self):
        rec = self._read_pending()
        return rec[0] if rec else 0

    def resolve(self):
        """Public resolve-on-use: one lock acquisition around the whole
        resolve sequence + read (EXCLUSION LOCK (ii))."""
        with self._lock("reconcile"):
            return self._resolve_locked()

    # ---------------- settlement (v35 AUD34-M1 + v36 AUD35-M2) ----------

    def settle(self):
        with self._lock("append"):
            # v38 cycle-1 fix 2: resolve-before-act ALWAYS. The public
            # settle is its own lock acquisition; an unresolved prior
            # append must be resolved here (never skipped on an
            # already-terminated fast path), so the service can never
            # forget a pending window across entry points.
            self._resolve_locked()
            data = self._read_bytes()
            if data.endswith(b"\n") or not data[data.rfind(b"\n") + 1:].strip(b" \t\r"):
                return self._resolve_locked()
            size = len(data)
            if size + 1 > LOG_CAP:
                raise LedgerError("log-cap-exceeded", size=size, framed=1)
            self._write_pending(size, False)   # INTENT before the byte
            fd = os.open(self.ledger_path, os.O_WRONLY | os.O_CREAT
                             | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            try:
                # R3-c2 CODE (R3-2-2): the settlement byte is a WRITE and
                # is subject to the checked-write rule (framing (c-O)(v):
                # a zero-return is no progress). A zero return must NOT
                # be fsynced and reported as a durable settlement.
                if getattr(self.faults, "settle_write_zero", False):
                    n = 0                      # no byte lands: no progress
                else:
                    n = os.write(fd, b"\n")
                if n != 1:
                    raise OSError(errno.EIO, "settlement write: zero progress")
                if getattr(self.faults, "fsync_fault", False):
                    raise _IOError0("hostile-io:settle-fsync")
                os.fsync(fd)
            except OSError:
                # AUD35-M2: bytes landed but not durable => the decision
                # state is `durability-pending` (REFUSE) until resolve.
                raise LedgerError(STATE_PENDING)
            finally:
                os.close(fd)
            dirfd = os.open(self.dir, os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
            self._write_pending(size, True)
            return self.classify(self._read_bytes())

    # ---------------- operator: authorize ----------------

    def authorize(self, occurrences=None, auth_id=None, test_only=False):
        """`--authorize-consumption-repair`: appends one AUTH under the
        lock, after resolve-on-use (observer gate). `occurrences` is the
        list the operator reviewed [{offset,hash}]; default = the current
        unmasked-malformed occurrence list.
        R3-c3 CODE-1 (v40): the PRODUCTION path mints a FRESH ULID and
        cannot be handed an ID — a caller-selected `auth_id` is an
        explicit TEST-ONLY seam (fixture determinism) and is refused
        unless `test_only=True`, refused if any AUTH already carries it,
        and refused if ANY terminated schema-valid record in the
        consumption log already names it (this closes the DEAD-REPAIR
        activation path: authorizing to match a pre-existing DEAD
        REPAIR's authId, and AUTH-id duplication poisoning)."""
        with self._lock("append"):
            cls = self._resolve_locked()
            auths, malformed = self._read_auths()
            if malformed:
                raise LedgerError(AUTH_FILE_MALFORMED)

            def _log_names(cid):
                """True iff ANY terminated schema-valid log record
                names authId `cid` (DEAD REPAIRs and APPLIED lines
                included)."""
                for raw in self._read_bytes().split(b"\n"):
                    if self._schema_kind(raw) is not None:
                        try:
                            rid = json.loads(raw.decode())["authId"]
                        except Exception:
                            continue
                        if rid == cid:
                            return True
                return False

            auth_ids = {a["authId"] for a in auths}
            if auth_id is not None:
                if not test_only:
                    raise LedgerError("auth-id-caller-chosen-forbidden",
                                      detail="production authorize mints a "
                                             "fresh ULID; caller-chosen ids "
                                             "require test_only=True")
                if auth_id in auth_ids:
                    raise LedgerError("auth-id-exists", authId=auth_id)
                if _log_names(auth_id):
                    raise LedgerError("auth-id-already-used", authId=auth_id)
            else:
                # INLINE-AUDIT F-A1 (v40): the minted id is checked for
                # collision UNDER THIS SAME LOCK — freshness is enforced
                # on the minted path, not just the test-only seam. A
                # conforming ULID's 80-bit suffix makes real collisions
                # astronomically unlikely; a PERSISTENT collision means a
                # hostile/broken CSPRNG consumer, so the bounded retry
                # REFUSES FAIL-CLOSED with zero bytes.
                for _ in range(64):
                    cand = _mint_ulid()
                    if cand not in auth_ids and not _log_names(cand):
                        auth_id = cand
                        break
                else:
                    raise LedgerError("auth-id-mint-collision",
                                      detail="64 minted ids all collided; "
                                             "refusing to write (fail closed)")
            # v38 cycle-4 fix 5 (AUD C4-F5): the writer respects the
            # reader's inventory bound — at capacity the AUTH file's
            # NEXT valid line would make the whole file malformed
            # (refusing every AUTH), so authorize refuses BEFORE any
            # byte instead of creating that terminal state itself.
            if len(auths) >= AUTH_INVENTORY_CAP:
                raise LedgerError("auth-inventory-full",
                                  detail="%d valid AUTHs: the file's next "
                                         "entry would be malformed"
                                         % len(auths))
            if occurrences is None:
                if cls["state"] != STATE_UNMASKED:
                    raise LedgerError("authorize-not-unmasked",
                                      state=cls["state"])
                occurrences = [{"offset": o["offset"], "hash": o["hash"]}
                               for o in cls["unmasked"]]
            # entry validity: entries must be malformed occurrences; a
            # schema-valid terminated line (incl. a DEAD REPAIR) refuses.
            data = self._read_bytes()
            for e in occurrences:
                raw = _line_at(data, e["offset"])
                if raw is None or self._sha(raw) != e["hash"]:
                    raise LedgerError("auth-entry-unknown-occurrence",
                                      **e)
                if self._schema_kind(raw) is not None:
                    raise LedgerError("auth-entry-not-malformed", **e)
            # replay refusal: valid UNSPENT AUTH with the same occurrence list
            for a in auths:
                if a["authId"] in cls["spent"]:
                    continue
                if a["occurrences"] == occurrences:
                    raise LedgerError("authorization-replay", authId=a["authId"])
            # v38 audit fix 6: AND every entry must be in the CURRENT
            # unmasked-occurrence list — authorizing an already-masked
            # line would mint an AUTH whose REPAIR is DEAD-on-arrival
            # (mask-mismatch). NOTE: authorize does NOT require the
            # submitted list to equal the whole unmasked list: fixtures
            # F21/F1 pin that partial coverage is accepted at authorize
            # and refused later as `authorization-stale` at (c-O)(iii).
            unmasked_set = {(o["offset"], o["hash"])
                            for o in cls.get("unmasked", cls["occurrences"])}
            for e in occurrences:
                if (e["offset"], e["hash"]) not in unmasked_set:
                    raise LedgerError("auth-entry-not-unmasked", **e)
            rec = {"t": "AUTH", "authId": auth_id,
                   "occurrences": occurrences, "createdAt": int(time.time())}
            payload = json.dumps(rec, separators=(",", ":"))
            if len(payload.encode()) + 2 > CAPS["AUTH"]:
                raise LedgerError("auth-too-large")
            fd = os.open(self.auth_path, os.O_WRONLY | os.O_CREAT
                         | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            try:
                # v38 cycle-6 (audit C4-2): a checked short-write loop. A
                # partial write (or zero progress) is a FAILURE: the AUTH
                # is never reported authorized over a malformed line.
                data = (payload + "\n").encode()
                off = 0
                while off < len(data):
                    n = os.write(fd, data[off:])
                    if n <= 0:
                        raise OSError(errno.EIO, "AUTH write made no progress")
                    off += n
                os.fsync(fd)
            finally:
                os.close(fd)
            dirfd = os.open(self.dir, os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
            return rec["authId"]

    def revive_dead_repair(self, *_a):
        raise LedgerError("no-such-operator-command",
                          hint="DEAD REPAIRs are inert by rule (owner 3A); "
                               "revival is only a fresh AUTH + fresh REPAIR")

    def operator_resolve_reset(self):
        """Explicit operator action re-arming resolution after sticky
        `resolve-exhausted` (v38 audit fix 4). Resets ONLY the sticky
        counter/flag — it does NOT clear the pending mark (the bytes are
        still unresolved) and performs no ledger write; the next
        resolve-on-use gets a fresh attempt bound.
        AUD46-c1: it does NOT clear the OWED WITNESS either — zeroing
        the counter must not silently discard the evidence that an
        attempt was started and never confirmed. Until a resolve
        COMPLETES (the only clearer), status/promote keep refusing at
        counter 0 (`owed_attempt` overlay)."""
        with self._lock("reconcile"):
            self._write_counter(0, exhausted=False)

    # ---------------- (c-O) forced repair ----------------

    def repair(self, auth_id):
        """(c-O): the forced repair IS AN APPEND. One lock acquisition
        spans resolve + occurrence-list check + reserve + one logical
        write executed by the checked short-write loop (v39 R2-M3:
        "single write" REVOKED as a description — D4A-c4-2; the
        one-lock guarantee is unchanged) (v37 1A closes AUD36-B1/B2)."""
        with self._lock("append"):
            cls = self._resolve_locked()

            if cls["authorization_file_malformed"]:
                raise LedgerError(AUTH_FILE_MALFORMED)
            auths, _ = self._read_auths()
            named = [a for a in auths if a["authId"] == auth_id]
            if len(named) != 1:
                raise LedgerError("authorization-stale", reason="no-valid-auth")
            if auth_id in cls["spent"]:
                raise LedgerError("authorization-spent")

            # v38 cycle-3 fix 2 (AUD C3-2) + cycle-5 owner decision
            # D1-A (TOTAL-ATTEMPT CAP): every REPAIR-INTENT ever landed
            # for this authId is one consumed attempt (orphans and
            # unknowns included); the cap (2) applies to the TOTAL and
            # is enforced off the crash-durable journal BEFORE any byte,
            # across processes. Journal damage refuses here too
            # (`journal-unreadable` propagates — D2-A fail-closed).
            if self._clean_failure_count(auth_id) >= 2:
                raise LedgerError("repair-retry-exhausted", authId=auth_id,
                                  detail="attempts-exhausted (D1-A total "
                                         "cap: this authId already has "
                                         ">=2 landed repair intents)")

            if cls["state"] == STATE_UNSETTLED:
                cls = self.settle_in_lock()
                if self.durability_pending():
                    raise LedgerError(STATE_PENDING)
            # SPENT predicate (c-O)(ii) is judged on the read the repair
            # ACTS ON: settlement above can newly reveal a VALID
            # APPLIED/REPAIR naming this authId (v38 cycle-1 fix 7).
            if auth_id in cls["spent"]:
                raise LedgerError("authorization-spent")
            if cls["state"] in (STATE_UNKNOWN, STATE_CONFLICT):
                raise LedgerError(cls["state"])

            # (c-O)(iii): "the current occurrence list of
            # `unmasked-malformed` equals the AUTH's occurrence list
            # exactly" — the UNMASKED list, not every occurrence
            # (v38 cycle-1 fix 7).
            current = [{"offset": o["offset"], "hash": o["hash"]}
                       for o in cls["unmasked"]]
            if named[0]["occurrences"] != current:
                raise LedgerError("authorization-stale",
                                  reason="occurrence-list-changed")

            # (iv) build REPAIR; caps BEFORE any write
            l_c = self.confirmation_length()
            g_c = self.confirmation_gen()
            # TEST SEAM (v41, R4-c1): window hook invoked AFTER the L_C
            # read and BEFORE any ledger byte — lets fixture F3 land a
            # confirmation inside the race window the contract's F3
            # row prescribes (production passes no hook).
            hook = getattr(self, "_test_hook_after_lc_read", None)
            if hook:
                hook()
            rec = {"t": "REPAIR", "authId": auth_id,
                   "masks": named[0]["occurrences"],
                   "all": {"hostToken": "ALL", "watermark": l_c,
                           "confirmGen": g_c}}
            framed = self._frame(json.dumps(rec, separators=(",", ":")))
            if len(framed) - 2 > CAPS["REPAIR"]:
                raise LedgerError("repair-too-large", framed=len(framed))

            size = os.path.getsize(self.ledger_path) if os.path.exists(
                self.ledger_path) else 0

            # (v) the reserved logical write (reserve check inside),
            # executed by the checked short-write loop (v39 R2-M3;
            # D4A-c4-2), with the 'R' INTENT landed before the first
            # ledger byte, plus
            # the append-only repair-intent journal entry (operator
            # evidence for a window closed by crash — v38 audit fix 5).
            # R4-c2-1 (v41): the CAPACITY reservation is checked BEFORE
            # the intent is journaled — a preflight `log-cap-exceeded`
            # writes NOTHING anywhere (the D1-A attempt definition is a
            # LANDED intent, so a refusal that lands no intent consumes
            # no allowance). This is the same preflight the contract's
            # "(iv) build REPAIR; caps BEFORE any write" clause states;
            # it merely closes the gap where the journal counted as a
            # write the ledger never performed.
            preflight_size = getattr(self.faults, "size_override", None)
            if callable(preflight_size):
                preflight_size = preflight_size()
            if preflight_size is None:
                preflight_size = os.path.getsize(self.ledger_path) \
                    if os.path.exists(self.ledger_path) else 0
            if preflight_size + len(framed) > LOG_CAP:
                raise LedgerError("log-cap-exceeded", size=preflight_size,
                                  framed=len(framed))
            self._log_repair_intent(auth_id)
            # (vi) any write/fsync failure propagates as OSError with
            # the pending sidecar already at P: the outcome is
            # `outcome-unknown` and the observer is in
            # `durability-pending` until the next resolve-on-use —
            # never a silent `failed-clean` (F5).
            try:
                self._append_bytes(framed, intent="R")
            except OSError:
                # (c-O)(vi): any write/fsync failure leaves the pending
                # sidecar at P — the observer is `durability-pending`
                # until the next resolve-on-use, never a silent
                # `failed-clean` (F5). v38 cycle-1 fix 10: a CLEAN
                # failure (no new bytes on disk through the failed
                # call) is FAILED — journal the outcome, AUTH stays
                # unspent, ONE fresh attempt with the same AUTH is
                # permitted (the next repair() just runs). A
                # byte-producing failure is the crash-like window:
                # re-raise the OSError with NO outcome line (F23),
                # sidecar P + intent 'R' carry the uncertainty.
                now = os.path.getsize(self.ledger_path) if os.path.exists(
                    self.ledger_path) else 0
                if now == size:
                    # v38 cycle-3 fix 2 (AUD C3-2): a clean-looking error
                    # is NOT a definite FAILED until the RESOLVE SEQUENCE
                    # has run (fsync file + fsync dir + FULL read). Only a
                    # DURABLE-RESOLVED clean read (nothing new on disk, no
                    # unsettled tail, AUTH not spent) licenses FAILED; a
                    # resolve that reveals the REPAIR durable is SUCCESS;
                    # anything else (including a failed resolution) stays
                    # `outcome-unknown` with the observer pending.
                    try:
                        rcls = self._resolve_locked()
                    except LedgerError:
                        self._log_repair_outcome(auth_id, "outcome-unknown",
                                                 True)
                        raise LedgerError(
                            "repair-outcome-unknown", authId=auth_id,
                            detail="clean error but durable resolution "
                                   "did not complete; no FAILED verdict")
                    rsize = os.path.getsize(self.ledger_path) \
                        if os.path.exists(self.ledger_path) else 0
                    if auth_id in rcls["spent"]:
                        # the REPAIR (or an APPLIED) IS durable after all
                        self._log_repair_outcome(auth_id, "repaired", True)
                        return {"outcome": "repaired", "durable": True,
                                "pending": False}
                    if (rsize == size and not self.durability_pending()
                            and rcls["state"] not in
                                (STATE_UNSETTLED, STATE_UNKNOWN,
                                 STATE_CONFLICT)):
                        # D1-A total cap: this attempt's INTENT is
                        # already counted; a SECOND intent ever landed
                        # for this authId means the allowance is spent
                        # — refuse persistently instead of writing.
                        total = self._clean_failure_count(auth_id)
                        self._log_repair_outcome(auth_id, "failed-clean",
                                                 False)
                        if total >= 2:
                            raise LedgerError(
                                "repair-retry-exhausted", authId=auth_id,
                                detail="this authId already has >=2 "
                                       "landed repair intents (D1-A "
                                       "total cap); new AUTH required")
                        raise LedgerError(
                            "repair-failed-clean", authId=auth_id,
                            detail="clean error, nothing on disk after "
                                   "durable resolution; one fresh (c-O) "
                                   "attempt is permitted")
                    # resolution clean-of-bytes failed the other tests
                    self._log_repair_outcome(auth_id, "outcome-unknown",
                                             True)
                    return {"outcome": "outcome-unknown", "durable": False,
                            "pending": self.durability_pending()}
                raise

            # post-write full re-read (F6/F15): SUCCESS requires the
            # frame to be VISIBLE at its reserved offset — the reread
            # verifies content, not just a flag.
            if getattr(self.faults, "reread_fails", False):
                self._log_repair_outcome(auth_id, "outcome-unknown", True)
                return {"outcome": "outcome-unknown", "durable": True,
                        "pending": False}
            data = self._read_bytes()
            stale = getattr(self.faults, "reread_stale", False)
            verified = (not stale) and \
                data[size:size + len(framed)] == framed
            if not verified:
                self._log_repair_outcome(auth_id, "outcome-unknown", True)
                return {"outcome": "outcome-unknown", "durable": True,
                        "pending": self.durability_pending()}
            self._log_repair_outcome(auth_id, "repaired", True)
            return {"outcome": "repaired", "durable": True, "pending": False}

    def settle_in_lock(self):
        """Settlement called WHILE THIS INSTANCE HOLDS the exclusion
        lock (v38 cycle-5, audit finding 1 — always-fix): like every
        other writer this entry point VERIFIES its own acquisition and
        refuses with `lock-required-not-held` and ZERO bytes otherwise
        — `settle_in_lock` on an instance that never acquired the lock
        is a protocol violation, not a licence to append. When held,
        no re-acquire happens (the caller's acquisition spans the
        steps; this inlines them)."""
        if not self._lock_held():
            raise LedgerError("lock-required-not-held",
                              hint="settle_in_lock must run under this "
                                   "instance's exclusion lock")
        # v38 cycle-6 (audit C2-1): the D2-A global journal gate applies
        # here too — a damaged journal writes ZERO settlement bytes.
        self._journal_records()
        data = self._read_bytes()
        if not (data and not data.endswith(b"\n")):
            return self.classify(data)
        size = len(data)
        if size + 1 > LOG_CAP:
            raise LedgerError("log-cap-exceeded")
        fd = os.open(self.ledger_path, os.O_WRONLY | os.O_CREAT
                             | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        try:
            self._write_pending(size, False)   # INTENT before the first byte
            # R3-c2 CODE (R3-2-2): checked write applies to the
            # settlement byte here too — a zero return is no progress
            # and must not be fsynced as a durable settlement.
            if getattr(self.faults, "settle_write_zero", False):
                n = 0                          # no byte lands: no progress
            else:
                n = os.write(fd, b"\n")
            if n != 1:
                raise OSError(errno.EIO, "settlement write: zero progress")
            if getattr(self.faults, "fsync_fault", False):
                raise _IOError0("hostile-io:settle-fsync")
            os.fsync(fd)
        finally:
            os.close(fd)
        dirfd = os.open(self.dir, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
        self._write_pending(size, True)
        return self.classify(self._read_bytes())

    def confirmation_gen(self):
        p = os.path.join(self.dir, "confirmations.jsonl")
        try:
            fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return "GEN0"
        try:
            head = os.pread(fd, 4096, 0)
        finally:
            os.close(fd)
        first = head.split(b"\n", 1)[0]
        try:
            return json.loads(first.decode()).get("confirmGen", "GEN0")
        except (UnicodeDecodeError, json.JSONDecodeError):
            return "GEN0"

    # ---------------- watermark / applied appends ----------------

    def append_watermark(self, host_token, watermark, confirm_gen,
                         consumed_at=None):
        rec = {"t": "WATERMARK", "hostToken": host_token,
               "watermark": watermark, "confirmGen": confirm_gen,
               "consumedAt": consumed_at if consumed_at is not None
               else int(time.time())}
        return self._capped_append(rec, "WATERMARK")

    def append_applied(self, auth_id):
        # v38 cycle-3 fix 1 (BLOCKER): a DECISION APPEND is gated on
        # EVERY entry point — the public append no longer bypasses the
        # gate `_capped_append` resolves and classifies INSIDE the same
        # lock, and a non-`ok` basis refuses (same rule as
        # `append_applied_in_lock`).
        rec = {"t": "APPLIED", "authId": auth_id}
        return self._capped_append(rec, "APPLIED", gate=True)

    def append_applied_in_lock(self, auth_id):
        """APPLIED append for use INSIDE a `promote()` callback: the
        exclusion lock is already held (flock is per-fd, so calling the
        public append here would deadlock on a second fd).
        v38 cycle-1 fix 10: a DECISION APPEND refuses a non-`ok`
        classification — the gate is re-checked on the IN-LOCK read,
        never on a snapshot released before the lock was taken.
        v38 cycle-3 fix 6: the caller contract is ENFORCED, not
        assumed — this method REFUSES (`lock-required-not-held`) unless
        THIS instance holds a live exclusion lock (taken via
        `led._lock(...)` / `promote()`), and it performs its OWN
        in-lock resolve-on-use rather than trusting the caller resolved
        earlier. v38 cycle-4 fix 1 (AUD C4-F1 BLOCKER): the former
        `lock_held_on_foreign_fd=True` DECLARATION was an unvalidated
        escape hatch (a boolean is not a lock) — REMOVED. Code holding
        a foreign flock fd must run its decision through this Ledger
        instance's own lock: exclusion is a capability, never a word."""
        if not self._lock_held():
            raise LedgerError("lock-required-not-held",
                              hint="append_applied_in_lock requires this "
                                   "instance's exclusion lock (call inside "
                                   "promote()/on_allowed)")
        cls = self._resolve_locked()      # self-enforced, never assumed
        if cls["state"] != STATE_OK or self.durability_pending() \
                or cls["authorization_file_malformed"]:
            raise LedgerError("decision-append-refused",
                              classification=cls["state"])
        payload = json.dumps({"t": "APPLIED", "authId": auth_id},
                             separators=(",", ":"))
        if len(payload.encode()) > CAPS["APPLIED"]:
            raise LedgerError("record-too-large", kind="APPLIED")
        return self._append_bytes(self._frame(payload))

    def _capped_append(self, rec, kind, gate=False):
        payload = json.dumps(rec, separators=(",", ":"))
        if len(payload.encode()) > CAPS[kind]:
            raise LedgerError("record-too-large", kind=kind)
        with self._lock("append"):
            # v38 cycle-1 fix 2: resolve-before-act — an unresolved
            # prior window is never carried across entry points.
            cls = self._resolve_locked()
            if gate:
                # v38 cycle-3 fix 1: the resolve's classification IS the
                # gate basis (in-lock read, never a stale snapshot).
                if cls["state"] != STATE_OK or self.durability_pending() \
                        or cls["authorization_file_malformed"]:
                    raise LedgerError("decision-append-refused",
                                      classification=cls["state"])
            return self._append_bytes(self._frame(payload))

    # ---------------- status (observer-gate overlay) ----------------

    def status(self):
        """Read-only: need not resolve, but MUST print `durability-pending`
        when the most recent append left it unresolved, and annotate DEAD
        REPAIRs. Returns the decision-state view (gate applied).
        v38 cycle-6 (audit blocker): a DAMAGED repair journal serves NO
        decision — the strict reader is consulted here, so the
        informational view and `promotion_allowed()` refuse with
        `journal-unreadable` exactly like the binding path."""
        self._journal_records()          # D2-A global refusal (raises)
        cls = self.classify()
        pending = self.durability_pending()
        out = {"classification": cls["state"], "decision": cls["state"],
               "dead_repairs": cls["dead_repairs"],
               "masked": cls["masked"],
               "authorization_file_malformed": cls["authorization_file_malformed"],
               "durability_pending": pending,
               "effective_all": cls["effective_all"]}
        # v38 cycle-4 fix 6 (AUD C4-F6): exhaustion is an OVERLAY on
        # the decision REGARDLESS of the pending marker — the binding
        # path (`promote`) refuses on it unconditionally, so the
        # informational view can never contradict it (RESOLVE BOUND:
        # exhaustion stops the ledger from serving decisions).
        if self._attempts_exhausted():
            out["decision"] = STATE_EXHAUSTED
        elif pending:
            out["decision"] = STATE_PENDING
        elif self._read_counter() > 0:
            # AUD46-a2 (independent-session audit, major): a charged
            # attempt with NO pending window is an UNCONFIRMED
            # resolve outcome — a failed no-pending resolve, or a
            # crash between the resolve IO and its completion-clear.
            # The default-deny premise (docs/21, RESOLVE BOUND): the
            # log stays `durability-pending` until a resolve
            # sequence SUCCEEDS; reporting `ok` off bytes that no
            # completed resolve ever confirmed contradicted the
            # binding path's discipline. Cleared by the next
            # successful resolve (which clears the counter).
            out["decision"] = STATE_PENDING
        elif self._owed_attempt():
            # AUD46-c1 (audit cycle 1, blocker): the OWED WITNESS at
            # counter 0 — an attempt was STARTED (witness written
            # before charge+IO) but never confirmed, and
            # `operator_resolve_reset()` zeroed the counter WITHOUT
            # erasing the evidence. Counter alone could not carry the
            # owed fact across a reset; the witness does. Same
            # default-deny as the charged case: PENDING until a
            # resolve COMPLETES (the only thing that clears it).
            out["decision"] = STATE_PENDING
            out["owed_attempt"] = True
        if cls["state"] == STATE_OK and cls["masked"] > 0:
            auth = cls["valid_repairs"][0]["authId"] if cls["valid_repairs"] else "?"
            out["renders"] = ("repaired (overlay active: %d lines masked by "
                              "REPAIR{%s})" % (cls["masked"], auth))
        return out

    def promotion_allowed(self):
        """INFORMATIONAL snapshot only (v38 audit fix 2): the snapshot is
        released with the lock and may be stale by the time it is acted
        on. A BINDING promotion decision runs through `promote()`."""
        try:
            st = self.status()
        except LedgerError:
            return False          # journal damage: no informational OK
        return st["decision"] == STATE_OK and not st["authorization_file_malformed"]

    def promote(self, on_allowed):
        """BINDING promotion transaction (v38 audit fix 2, EXCLUSION
        LOCK (ii)): ONE lock acquisition spans resolve-on-use + the
        classification + the decision + every journal write the decision
        makes (`on_allowed` runs IN the lock and uses the in-lock append
        helpers). Returns {"allowed": False, ...} when the gate refuses;
        otherwise returns whatever `on_allowed` returns. A caller acting
        on the lock-free `promotion_allowed()` snapshot may act on a
        decision the next reconcile invalidates — that is why the
        binding path is this method."""
        with self._lock("reconcile"):
            try:
                self._journal_records()  # D2-A: damaged journal => no decision
                cls = self._resolve_locked()
            except LedgerError as e:
                return {"allowed": False, "decision": e.code}
            if cls["state"] != STATE_OK or self.durability_pending() \
                    or self._attempts_exhausted() or self._owed_attempt():
                # AUD46-c1: the OWED WITNESS is a BINDING refusal too
                # — the informational overlay above is not enough; the
                # lock-held decision refuses exactly like exhaustion
                # until a resolve completes in THIS or a later call.
                return {"allowed": False, "decision": (
                    STATE_EXHAUSTED if self._attempts_exhausted()
                    else (STATE_PENDING if self.durability_pending()
                          or self._owed_attempt()
                          else cls["state"]))}
            if cls["authorization_file_malformed"]:
                return {"allowed": False, "decision": AUTH_FILE_MALFORMED}
            return on_allowed()


def _line_at(data, offset):
    if offset >= len(data):
        return None
    end = data.find(b"\n", offset)
    if end == -1:
        return None  # unterminated => not a physical line
    return data[offset:end]


def _split_unterminated(data):
    """(complete_bytes, tail_bytes): tail = bytes after the last '\\n'."""
    i = data.rfind(b"\n")
    return (data[:i + 1], data[i + 1:]) if i >= 0 else (b"", data)


def physical_lines(data):
    """Every terminated PHYSICAL line as (offset, raw) — including blank
    ones (line inventory; AUD36-M5/M7)."""
    out = []
    off = 0
    for chunk in data.split(b"\n")[:-1]:  # drop the unterminated remainder
        out.append((off, chunk))
        off += len(chunk) + 1
    return out


def blank_occurrence(data, tail):
    """The tail's first physical line is blank but the tail carries
    non-whitespace content => ONE occurrence (offset, hash) — the
    leading-whitespace rule (AUD36-M6): content is never discarded, the
    occurrence is the FIRST PHYSICAL LINE of the fragment.
    Returns None if no such occurrence."""
    if not tail or tail.strip(b" \t\r") == b"":
        return None
    if data.endswith(b"\n"):
        return None  # fully terminated => blanks are inventory only
    first = tail.split(b"\n", 1)[0]
    if first.strip(b" \t\r"):
        return None  # first line nonblank => the unsettled-tail rule owns it
    nl = tail.find(b"\n")
    frag = tail if nl == -1 else tail[:nl + 1]
    off = len(data) - len(tail)
    return {"offset": off, "hash": Ledger._sha(frag)}


_ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _is_int(v):
    """Non-negative int, bools excluded (True/False are not watermarks)."""
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _mint_ulid():
    """A CONFORMING ULID (v40, inline-audit F-A2): 128-bit value =
    48-bit big-endian epoch-milliseconds || 80-bit random, encoded
    Crockford base32 (uppercase, no padding) into exactly 26 chars —
    time-ordering prefix included, unlike the previous random-26
    which was NOT a ULID (some values exceeded the 128-bit range)."""
    import secrets
    value = ((int(time.time() * 1000) & ((1 << 48) - 1)) << 80) \
        | secrets.randbelow(1 << 80)
    out = []
    for _ in range(26):
        out.append(_ULID_ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(out))
