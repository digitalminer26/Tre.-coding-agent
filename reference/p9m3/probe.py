"""FS PROFILE startup probe (spec §THE CONSUMPTION LOG, v37 owner decision 0A).

Local-only storage + 4-leg startup probe. Any leg failing raises
FSProbeError("fs-probe-failed:leg<N>") — no degraded mode.

This module is deliberately SEPARATE from ledger.py: it is the only place
allowed to rename/truncate (probe scratch files), which keeps the F10
static check (no rename/truncate/O_TRUNC anywhere in the live protocol)
mechanically greppable against ledger.py.
"""
from __future__ import annotations

import errno
import fcntl
import os

NETWORK_FSTYPES = {
    "nfs", "nfs4", "cifs", "smbfs", "smb2", "smb3", "9p", "webdav",
    "afs", "glusterfs", "ceph", "lustre", "fuse.sshfs", "ncpfs",
}


class FSProbeError(Exception):
    pass


class FsFaults:
    """Behavioral fault seams that model a FUSE mount that *reports* local
    but misbehaves (spec: legs 2-4 judge by behavior, not the type string).

    v38 cycle-1 (finding 4) seams for leg 1:
    - `simulated_fstype`: pretend statfs reports THIS type (e.g. "nfs"
      on a declared-local dir) — models a network mount impostor.
    - `fstype_unresolvable`: pretend the real type cannot be obtained at
      all — leg 1 must FAIL CLOSED (spec leg 1: "the mount is a local
      fs type per statfs"; no type => no local proof => refuse).

    v38 cycle-3 (finding 7) seams for exact-outcome verification:
    - `append_leaves_extra_bytes`: a filesystem that shows MORE than the
      appended bytes on fresh open (stale surplus) must fail leg 3.
    - `rename_keeps_old_content`: a rename-over whose destination keeps
      its pre-rename bytes must fail leg 4.
    - `dir_preplaced_unsafe`: model a directory the probe finds already
      present with unsafe mode (group/other access) — establishment
      must refuse BEFORE any scratch write (finding 5)."""

    def __init__(self, flock_fails=False, fsync_visibility_fails=False,
                 silly_rename_leaves_second_name=False,
                 simulated_fstype=None, fstype_unresolvable=False,
                 append_leaves_extra_bytes=False,
                 rename_keeps_old_content=False,
                 dir_preplaced_unsafe=False,
                 resolve_io_fault=False, sidecar_open_fault=False,
                 sidecar_write_fault=False, sidecar_partial_write=None,
                 sidecar_fsync_fault=False, sidecar_dir_fsync_fault=False,
                 clear_write_fault=False, clear_partial_write=None,
                 clear_fsync_fault=False, repair_seed_fault=False,
                 repair_fill_fault=False):
        self.flock_fails = flock_fails
        self.fsync_visibility_fails = fsync_visibility_fails
        self.silly_rename_leaves_second_name = silly_rename_leaves_second_name
        self.simulated_fstype = simulated_fstype
        self.fstype_unresolvable = fstype_unresolvable
        self.append_leaves_extra_bytes = append_leaves_extra_bytes
        self.rename_keeps_old_content = rename_keeps_old_content
        self.dir_preplaced_unsafe = dir_preplaced_unsafe
        # AUD47-c3 (audit cycle 3, minor): declared constructor seams
        # for the SAFETY-RELEVANT lifecycle writes (owed witness
        # create/clear, counter, pending window). The resolve-IO fault
        # was consumed via getattr at the `_resolve_io` head but was
        # never DECLARED; the sidecar seams let the fault-injection
        # matrix address lifecycle writes without monkeypatching OS
        # calls (an un-declared seam is not a seam — nothing pins it).
        self.resolve_io_fault = resolve_io_fault
        self.sidecar_open_fault = sidecar_open_fault
        self.sidecar_write_fault = sidecar_write_fault
        self.sidecar_partial_write = sidecar_partial_write
        self.sidecar_fsync_fault = sidecar_fsync_fault
        self.sidecar_dir_fsync_fault = sidecar_dir_fsync_fault
        # AUD49 implement0: DECLARED seams for the owed CLEAR path
        # (`_clear_owed`) and its in-fd repair legs — until now these
        # were the only production writes with NO seam (the fault
        # matrix reached them solely through test-side os.pwrite/
        # os.fsync monkeypatching; an un-seamed path is not addressed
        # by the matrix). Every value may be True (unconditional) or
        # a CALLABLE predicate (no-arg or single-arg path) so a
        # fixture targets one leg without patching any OS call —
        # same shape as the existing callable `size_override` seam.
        # - `clear_write_fault`: the clear's first segment pwrite raises
        #   (the compensation re-arm then re-arms a surviving owed
        #   witness).
        # - `clear_partial_write=N`: EVERY clear-segment pwrite in the
        #   checked loop is throttled to at most N bytes (a persistent
        #   per-write ceiling, consumed once per write — the checked
        #   continuation must still land all 16 zeros; N=0 is an empty
        #   pwrite that trips the zero-progress guard before any zero
        #   lands). A CALLABLE is consulted through `_dispatch_fault`
        #   like every other seam; its return value (int or None) is
        #   the limit. AUD49 c1 (finding 2): until now this value went
        #   straight through `int()` with no dispatch — a callable
        #   raised TypeError before any syscall.
        # - `clear_fsync_fault`: the clear's fsync RAISES — the RAISING
        #   variant that triggers the in-fd repair leg. Distinct from
        #   `sidecar_fsync_fault`, which is SILENTLY DROPPED in
        #   `_sidecar_write` (a lying mount): here the error is real
        #   and the repair path runs.
        # - `repair_seed_fault`: the repair's minimum-evidence seed
        #   (1 byte at offset 0) raises — the documented
        #   all-writes-fault boundary.
        # - `repair_fill_fault`: the seed landed, the full-payload
        #   fill raises (best-effort leg; evidence still owed).
        self.clear_write_fault = clear_write_fault
        self.clear_partial_write = clear_partial_write
        self.clear_fsync_fault = clear_fsync_fault
        self.repair_seed_fault = repair_seed_fault
        self.repair_fill_fault = repair_fill_fault


# statfs f_type magics (Linux); f_fstypename is used where the platform
# exposes it (macOS/BSD).  Unknown magics resolve to None => leg1 fails
# closed (finding 4: an unresolved type is NEVER a pass).
_STATFS_MAGICS = {
    0xEF53: "ext4", 0xEF51: "ext", 0x137D: "ext",
    0x01021994: "tmpfs", 0x58465342: "xfs", 0x9123683E: "btrfs",
    0x5346544E: "ntfs", 0x6589fc53: "fuse", 0x65735543: "fuse",
    0x61756673: "fuse", 0x01161970: "gfs", 0x012FF7FB: "efs",
    0x2FC12FC1: "overlay", 0x794C7630: "overlayfs",
    0x52654973: "smb", 0xFF534D42: "cifs", 0x6D7B6D: "zfs",
}


def _existing_ancestor(path):
    p = os.path.abspath(path)
    while not os.path.exists(p):
        parent = os.path.dirname(p)
        if parent == p:
            return None
        p = parent
    return p


def _real_fstype_libc(p):
    """Real fstype without os.statfs (v38 cycle-1, finding 4; Python
    < 3.12 has no os.statfs).  Linux: libc statfs(2) via ctypes — the
    buffer is an oversized byte block (the kernel writes its full
    struct; an undersized Structure would overflow), and f_type is read
    at offset 0 as a native `long`.  macOS/BSD: the canonical
    `stat -f %T` (returns f_fstypename verbatim — hand-rolled offsets
    into struct statfs vary per OS release and are NOT trusted here).
    Returns the resolved type name or None; NEVER guesses."""
    import subprocess
    import sys as _sys
    if _sys.platform.startswith("linux"):
        import ctypes
        try:
            libc = ctypes.CDLL(None)
        except OSError:
            return None
        buf = ctypes.create_string_buffer(256)
        try:
            if libc.statfs(os.fsencode(p), buf) != 0:
                return None
        except OSError:
            return None
        magic = int.from_bytes(buf.raw[:ctypes.sizeof(ctypes.c_long)],
                               _sys.byteorder) & 0xFFFFFFFF
        return _STATFS_MAGICS.get(magic)
    if _sys.platform == "darwin" or _sys.platform.startswith(("freebsd",
                                                              "netbsd",
                                                              "openbsd")):
        exe = "/usr/bin/stat"
        if not os.path.exists(exe):
            return None
        try:
            out = subprocess.run([exe, "-f", "%T", p], capture_output=True,
                                 timeout=5)
        except (OSError, subprocess.SubprocessError):
            return None
        if out.returncode != 0:
            return None
        name = out.stdout.decode("ascii", "replace").strip()
        return name or None
    return None


def _real_fstype(path):
    """REAL filesystem type of the mounted fs at `path` (v38 cycle-1,
    finding 4).  Resolution chain, in order: (1) `os.statfs` (Python
    ≥ 3.12: f_fstypename on macOS/BSD, f_type magic on Linux); (2) libc
    statfs(2) via ctypes (any Python: same fields).  Consulted against
    an EXISTING ancestor — the target dir may not exist yet (it is
    created only after the probe passes).  statvfs is NEVER consulted:
    its f_fsid is not statfs.f_type (audit finding).  Returns None when
    the type cannot be established — leg 1 fails closed on None."""
    p = _existing_ancestor(path)
    if p is None:
        return None
    try:
        st = os.statfs(p)  # Python >= 3.12
    except (AttributeError, OSError):
        st = None
    if st is not None:
        name = getattr(st, "f_fstypename", None)
        if name:
            return name.decode() if isinstance(name, bytes) else str(name)
        try:
            magic = int(getattr(st, "f_type")) & 0xFFFFFFFF
        except (TypeError, ValueError):
            return None
        return _STATFS_MAGICS.get(magic)
    return _real_fstype_libc(p)


def _is_network_type(real):
    # v38 cycle-6 (audit C1-4): the FS PROFILE puts FUSE-family mounts
    # OUT OF CONTRACT. A statfs/declared type identifying FUSE is refused
    # at leg 1. A mount that merely REPORTS a local type is still judged
    # by behavior (legs 2-4), never by the type string.
    if real is not None and (real == "fuse" or real.startswith("fuse.")):
        return True
    if real in NETWORK_FSTYPES:
        return True
    base = real.replace("fuse.", "").replace("fuse", "").strip(".")
    if base in NETWORK_FSTYPES:
        return True
    return any(real.startswith(n) for n in ("nfs", "cifs", "smb", "9p",
                                            "glusterfs", "lustre", "ceph",
                                            "webdav", "afs"))


def _leg1_local_fstype(fstype, directory=None, faults=None):
    """Leg 1 (v38 cycle-1, finding 4): reject network storage by DECLARED
    type AND by the REAL statfs type; FAIL CLOSED when the real type
    cannot be established (spec: leg 1 requires "local fs type per
    statfs" — no type, no proof, no startup)."""
    faults = faults or FsFaults()
    # v38 cycle-6 (audit C4-4): the DECLARED type takes the same predicate
    # as the real type (exact network names AND the FUSE family).
    if _is_network_type(fstype):
        raise FSProbeError("fs-probe-failed:leg1")
    if faults.fstype_unresolvable:
        raise FSProbeError("fs-probe-failed:leg1")
    if faults.simulated_fstype is not None:
        if _is_network_type(faults.simulated_fstype):
            raise FSProbeError("fs-probe-failed:leg1")
        return
    if directory is None:
        raise FSProbeError("fs-probe-failed:leg1")  # nothing to prove
    real = _real_fstype(directory)
    if real is None:
        raise FSProbeError("fs-probe-failed:leg1")
    if _is_network_type(real):
        raise FSProbeError("fs-probe-failed:leg1")


def _establish_directory(directory, faults=None):
    """v38 cycle-3 fix 5 (AUD C3-5): establish + VALIDATE the probe
    directory BEFORE any scratch write: it must be a real directory
    (O_NOFOLLOW — never a symlink), OWNED by the protocol user, and
    0700 (owner-only). A NEW directory is created 0700 and explicitly
    chmodded (makedirs' mode is umask-filtered, so the creation path
    itself is covered without relying on the caller's fallback). An
    EXISTING directory with group/other access or foreign ownership
    REFUSES the probe before a single scratch byte exists."""
    faults = faults or FsFaults()
    try:
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        os.makedirs(directory, mode=0o700, exist_ok=True)
        try:
            os.chmod(directory, 0o700)     # defeat a hostile umask
        except OSError:
            pass
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except (NotADirectoryError, OSError) as e:
        # symlink, non-dir, or unresolvable: refuse, never follow
        raise FSProbeError("fs-probe-failed:dir-unusable") from e
    try:
        st = os.fstat(fd)
        if st.st_uid != os.geteuid():
            raise FSProbeError("fs-probe-failed:dir-not-owned")
        if faults.dir_preplaced_unsafe:
            raise FSProbeError("fs-probe-failed:dir-mode")
        if st.st_mode & 0o077:
            raise FSProbeError("fs-probe-failed:dir-mode")
    except BaseException:
        os.close(fd)
        raise
    return fd      # v38 cycle-4 fix 8 (AUD C4-F8): the validated fd is
                   # THE anchor — every leg opens/rename/lists relative
                   # to it, never re-resolving the pathname


def _scratch_names(directory):
    """F7 (v38 cycle-1): scratch names are UNPREDICTABLE (pid + random
    nonce) so a local attacker cannot pre-place a symlink at a known
    probe path, and every create is O_CREAT|O_EXCL|O_NOFOLLOW — an
    existing name (ours or an impostor's) or a symlink refuses the leg
    instead of following/truncating it."""
    import secrets
    nonce = "%d.%s" % (os.getpid(), secrets.token_hex(8))
    return {k: ".probe-%s.%s" % (k, nonce)
            for k in ("lock", "append", "a", "b")}


def _list_probe_names(dir_fd):
    """Census anchored to the dir fd (v38 cycle-4 fix 8; cycle-5 owner
    decision D3-B): enumerated THROUGH the validated fd via
    `os.scandir(dir_fd)` — NO process-wide CWD side effect (the old
    fd-swap census is gone), so the probe is safe even in a
    multi-threaded host process and the census cannot be retargeted
    by a pathname swap."""
    return {e.name for e in os.scandir(dir_fd)
            if e.name.startswith(".probe-")}


def _leg2_flock_roundtrip(dir_fd, faults, names):
    try:
        fd = os.open(names["lock"],
                     os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=dir_fd)
        try:
            if faults.flock_fails:
                raise OSError(errno.EPERM, "flock unsupported")
            fcntl.flock(fd, fcntl.LOCK_EX)
            # v38 cycle-6 (audit C1-5, spec sharpening): the round-trip
            # alone is satisfied by an flock that never excludes. A
            # COMPETING independently opened descriptor must fail a
            # nonblocking exclusive acquire while the first lock is held.
            comp = os.open(names["lock"],
                           os.O_RDWR | os.O_NOFOLLOW, dir_fd=dir_fd)
            try:
                try:
                    fcntl.flock(comp, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as ce:
                    # v38 cycle-6 (audit C2-3): ONLY the platform's
                    # contention errno proves exclusion; any other error
                    # (EIO, ...) is a failed probe, never evidence.
                    if ce.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                        raise FSProbeError("fs-probe-failed:leg2") from ce
                else:
                    raise FSProbeError("fs-probe-failed:leg2")
            finally:
                os.close(comp)
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
    except FSProbeError:
        raise
    except OSError as e:
        raise FSProbeError("fs-probe-failed:leg2") from e


def _leg3_append_fsync_visible(dir_fd, faults, names):
    token = b"probe-append\n"
    try:
        fd = os.open(names["append"], os.O_WRONLY | os.O_CREAT | os.O_EXCL
                     | os.O_APPEND | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
        try:
            os.write(fd, token)
            if faults.fsync_visibility_fails:
                raise OSError(errno.EIO, "fsync does not make bytes visible")
            os.fsync(fd)
        finally:
            os.close(fd)
        if getattr(faults, "append_leaves_extra_bytes", False):
            # model a filesystem that shows surplus bytes on fresh open
            wfd = os.open(names["append"],
                          os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW,
                          dir_fd=dir_fd)
            try:
                os.write(wfd, b"surplus")
            finally:
                os.close(wfd)
        rfd = os.open(names["append"], os.O_RDONLY | os.O_NOFOLLOW,
                      dir_fd=dir_fd)
        try:
            data = b"".join(iter(lambda: os.read(rfd, 1 << 16), b""))
        finally:
            os.close(rfd)
        # v38 cycle-3 fix 7 (AUD C3-7): EXACT bytes, not a suffix match
        # (spec: a fresh open shows "exactly the appended bytes").
        if data != token:
            raise OSError(errno.EIO, "fresh open does not show exactly "
                                     "the appended bytes")
    except OSError as e:
        raise FSProbeError("fs-probe-failed:leg3") from e


def _leg4_rename_no_second_name(dir_fd, faults, names, baseline=frozenset()):
    try:
        for nm in (names["a"], names["b"]):
            fd = os.open(nm, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                         | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
            try:
                os.write(fd, b"X" if nm == names["a"] else b"Y")
            finally:
                os.close(fd)
        # v38 cycle-4 fix 8 (AUD C4-F8): renameat relative to the
        # ANCHOR fd — the paths are never re-resolved by name.
        os.rename(names["b"], names["a"], src_dir_fd=dir_fd,
                  dst_dir_fd=dir_fd)
        # v38 cycle-3 fix 7 (AUD C3-7): the destination must NOW contain
        # the SOURCE's bytes — a rename-over that keeps stale content
        # fails the leg, not just the name census.
        try:
            rfd = os.open(names["a"], os.O_RDONLY | os.O_NOFOLLOW,
                          dir_fd=dir_fd)
            try:
                dst = os.read(rfd, 4096)
            finally:
                os.close(rfd)
        except OSError as e:
            raise FSProbeError("fs-probe-failed:leg4") from e
        if getattr(faults, "rename_keeps_old_content", False):
            dst = b"X"                    # model stale destination bytes
        if dst != b"Y":
            raise OSError(errno.EIO, "rename-over did not move the "
                                     "source bytes to the destination")
        names_ = _list_probe_names(dir_fd)
        if names["b"] in names_:
            raise OSError(errno.EIO, "source name still visible after rename")
        if faults.silly_rename_leaves_second_name:
            # Model a silly-rename layer: the overwritten inode stays visible.
            names_.add(".probe-nfs00001")
        # v38 cycle-6 (audit C3-2): compare against this invocation's OWN
        # expected names plus the baseline census taken before it started.
        # A foreign or leftover .probe-* name is not ours to judge here and
        # is never a reason to refuse healthy storage.
        ours = {names["lock"], names["append"], names["a"]}
        unexpected = (names_ - ours) - baseline
        if unexpected:
            raise OSError(errno.EIO, "rename left a second visible name")
    except OSError as e:
        raise FSProbeError("fs-probe-failed:leg4") from e


def run_probe(directory, fstype="local", faults=None):
    """Run the 4-leg startup probe. Called ONCE before the first decision
    touching `directory`; any leg failing refuses startup (no degraded
    mode). Probe scratch files are best-effort removed on success."""
    faults = faults or FsFaults()
    # Leg 1 first: a rejected deployment creates NO trace (F22 — the
    # service never starts and nothing is written). Leg 1 is FAIL CLOSED
    # (v38 cycle-1 finding 4): the real statfs type (of an existing
    # ancestor when the target does not exist yet) must be resolvable
    # and local; declared `local` on an impostor or an unresolvable
    # type refuses startup.
    _leg1_local_fstype(fstype, directory, faults)
    # F3 (v38 cycle-1) + v38 cycle-3 fix 5 (AUD C3-5): establish and
    # VALIDATE the directory (real dir, owned, 0700) BEFORE any scratch
    # write — a rejected deployment still leaves zero trace, and the
    # probe never writes scratch into a directory it would refuse.
    dir_fd = _establish_directory(directory, faults)
    try:
        names = _scratch_names(directory)
        baseline = frozenset(_list_probe_names(dir_fd))
        _leg2_flock_roundtrip(dir_fd, faults, names)
        _leg3_append_fsync_visible(dir_fd, faults, names)
        _leg4_rename_no_second_name(dir_fd, faults, names, baseline)
        # cleanup: ONLY this invocation's own scratch names
        for n in (names["lock"], names["append"], names["a"], names["b"]):
            try:
                os.unlink(n, dir_fd=dir_fd)
            except OSError:
                pass
    finally:
        os.close(dir_fd)
