# Linux bash sandbox — Bubblewrap boundary

## 1. What it is

Linux uses Bubblewrap (`bwrap`) for the bash child; Darwin continues to use Seatbelt. The Linux backend creates user, pid, ipc and uts namespaces. It does **not** create a network namespace in v1, so networking is shared.

The filesystem uses an empty-root model. The backend first self-binds host runtime paths, the workspace and any `--extra-root` paths; it then mounts the caller-created empty directory read-only over `/` as the last bind. This order is load-bearing: bwrap resolves each mount source against the current root as it applies mounts. Mounting the empty root earlier would hide the host source paths needed by the later binds. The argv order is pinned by `test/sandbox-linux.test.ts`.

## 2. The boundary (what the sandboxed bash can/cannot touch)

| Surface | Access inside the sandbox |
|---|---|
| Workspace (`cwd`) | Read/write bind; child working directory. |
| Extra roots (`--extra-root`) | Read/write binds, after the workspace and before the empty root. |
| `/usr`, `/bin`, `/lib`, `/lib64`, `/sbin` | Read-only `--ro-bind-try`; absent paths are tolerated, including merged-usr layouts. |
| `/etc/ssl`, `/etc/resolv.conf` | Read-only `--ro-bind-try`; TLS and resolver runtime configuration only. |
| `/tmp` | Private tmpfs; the spawned child's `TMPDIR` is forced to `/tmp`. |
| `/dev` | Bubblewrap's minimal device set (`--dev`). |
| `/proc` | Fresh proc mount in the child pid namespace. |
| Network | **Shared with the host in v1**; no `--unshare-net`. |

Not visible through the sandbox root: other homes, `/etc` except for the two mounted configuration surfaces above, host `/tmp`, `/var`, `/run`, sockets, and `/root`. User-local toolchains under `$HOME` (for example `~/.local`) are not implicitly mounted; make one available explicitly with `--extra-root`. On the lab VM, Node is at `/home/agent/.local/share/node22`, so use `--extra-root /home/agent/.local/share/node22` when that toolchain is needed.

## 3. Availability + the probe

`bashSandboxAvailable()` dispatches by platform: Darwin checks for `sandbox-exec`; Linux calls `linuxSandboxAvailable()`. On Linux, availability requires both a located bwrap executable and a successful real spawn probe. `bwrapPath()` checks `/usr/bin/bwrap`, `/bin/bwrap`, and `/usr/local/bin/bwrap`, then scans the caller's `PATH` (supporting no-root installs). The probe builds the sandbox mounts and runs `/bin/true` under bwrap with a 3,000 ms spawn timeout. A present binary is insufficient because kernel policy may reject creation or mapping of the user namespace.

The result is cached. `__resetLinuxSandboxAvailability()` clears both the availability and bwrap-path caches for tests.

## 4. The Ubuntu 24.04 AppArmor blocker (verified on the lab VM, 2026-10-05)

On the lab Ubuntu 24.04 VM, `kernel.apparmor_restrict_unprivileged_userns = 1` blocks the uid-map write required by bwrap. The observed symptoms were:

```text
unshare -U -r id
write failed /proc/self/uid_map: Operation not permitted

bwrap …
setting up uid map: Permission denied
```

A bare `unshare -U true` passes there, but does not require a uid map and is not a valid bwrap availability probe. The one-time runtime unlock (root required) is:

```sh
echo 0 | sudo tee /proc/sys/kernel/apparmor_restrict_unprivileged_userns
```

To persist it, put `kernel.apparmor_restrict_unprivileged_userns = 0` in `/etc/sysctl.d/99-allow-userns.conf`. Until unlocked, availability is false: the existing C42 “unsupported” banner is shown and bash uses the existing unsandboxed fallback.

## 5. Kernel verification recipe

Run on a Linux host with bwrap installed and usable. The OS tests in `test/sandbox-linux.test.ts` cover the generated argv, uid and root view, a sibling canary, and workspace read/write; they skip when bwrap is missing or the spawn is rejected. For a manual canary pass, create a workspace and sibling under one temporary parent, plus a marker in host `/tmp`, then run each command through the normal sandboxed bash spawn with `cwd` set to the workspace:

| Check | Command inside sandbox | Expected |
|---|---|---|
| Basic | `id -u; ls /; test -w .; touch ./.sandbox-write; test -e /tmp` | uid is `0` in the user namespace; root listing has no `home`; workspace is writable; `/tmp` is present as the private tmpfs. |
| Sibling canary | `cat "<sibling>/canary"`; `ls "<sibling>"`; then `cat ./workspace-marker` and `touch ./workspace-write` | Canary read fails and sibling listing does not show it; workspace read and write still succeed. |
| Host `/tmp` privacy | `cat "<host-tmp-marker>"` | Fails: the host marker is not visible in the sandbox tmpfs. |

The automated sibling test specifically asserts failed `cat`, absent canary name from the sibling listing, and successful workspace read/write. The test suite does not currently assert host-`/tmp` marker invisibility; treat that row as a manual kernel canary.

## 6. Nesting + env

The child environment sets `GIT_CONFIG_NOSYSTEM` to `1` unless the caller already supplied a value, forces `TMPDIR=/tmp`, and sets `TRE_SANDBOX=1`. If the spawning tre process already has `TRE_SANDBOX=1`, the backend starts the shell directly rather than applying another bwrap layer. The child inherits the caller's existing namespace and confinement; it does not get a new per-call workspace policy. This matches the Darwin nesting behavior.

## 7. Reverting

The change was split into three increments: (1) new `src/tools/sandbox-linux.ts` and `test/sandbox-linux.test.ts`; (2) the Linux dispatch hunk in guardrail-zone `src/tools/sandbox.ts`; (3) this document. The `pre-bwrap-9cd5978` tag marks the pre-change state. Runtime opt-out remains `--no-sandbox`; if bwrap is absent or its probe fails, the existing behavior is an honest unsupported banner with unsandboxed fallback.

## 8. v1 known boundaries / v2 candidates

- **Shared network:** v1 has no network namespace. A v2 candidate is `--unshare-net`, with a LAN-allow mode for lab endpoints.
- **Limited `/etc` runtime config:** only SSL and resolver configuration are mounted. A v2 candidate is a per-tool allowlist of additional read-only surfaces.
- **No resource caps:** v1 does not configure resource limits. A v2 candidate is rlimits and/or cgroups.
