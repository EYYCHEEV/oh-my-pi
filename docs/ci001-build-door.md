# ci-001 build door: install packet and command reference

The stronk-omp Linux amd64 binary is built on ci-001, not on the Mac and not on devbox-s1.
Access is one dedicated account, `ompbuild`, with its own rootless Docker and the egress fence, reached from the Mac by one SSH key that can run one forced command.
The Captain approved this access design on 2026-10-23.
Agents never sign in to ci-001: Main installs the host side in one root sitting, and only the Mac side calls the door.
Signing the source tag and publishing the GitHub Release stay on the Mac and each need separate Captain approval.
Nothing in this packet has been run on ci-001 yet.

## Who does what

| Step | Owner | Where |
| --- | --- | --- |
| Part A, read-only fact script, return its output | Main | ci-001, as root |
| Part B, install in one root sitting, return the report | Main | ci-001, as root |
| Optional, proxy block for the Docker daemon's image pulls only (after Part B) | Main, only if Part A shows the proxy service, Part E step 2b cannot pull directly and the Captain wants it | ci-001, as root |
| Part D, ssh alias and known-hosts line | Mac owner or the Mac agent | Mac |
| Part E, smoke steps | Main for the box checks, the Mac for the door and build checks | both |
| Part F, undo | Main, with the Captain's approval | ci-001, as root |

Files that go to ci-001 (Main copies them by the usual route): `scripts/ci001/omp-build-entry` only.
This guide's scripts are pasted by Main.
The entry file is the exact reviewed bytes: its SHA-256 is `1f6ac7db0946f07aecbc49ddd63ea145bf61cf64021bf386ac12eadaac0784e7`, and the install script refuses any other bytes.

## The door at a glance

The Mac sends `ssh -i <key> -o IdentitiesOnly=yes -o BatchMode=yes -o ControlPath=none <alias> '<command>'`.
sshd ignores everything the caller types except the command text, which arrives as `SSH_ORIGINAL_COMMAND`.
The entry matches that text in full against exactly one of the four shapes below and never lets a shell evaluate it.
Anything else prints `refused: invalid command`, exits 2 and is not logged.

```text
build   <app-40hex> <recipe-40hex> <fork-manifest-sha256-64hex> [<stronk-omp-s1-YYYY.MM.DD.NNNN>]   (a git bundle on standard input)
status  <run-id>
fetch   <run-id>
cleanup <run-id>
run-id  = b<14 digits>-<8 hex>
```

| Command | Does | Prints | Exit |
| --- | --- | --- | --- |
| `build` | Takes the one build slot, checks the host, reads at most 256 MiB of bundle, checks the fork manifest inside it against the stated SHA-256, starts a detached supervisor | `run <id>`, allowlisted phase lines, then `state: <final>` | 0 succeeded, 1 failed, timed out or cancelled, 2 refused |
| `status` | Reads the run record | `run`, `state`, `phase`, `qualified`, `cleanup`, `started`, `reason` | 0 succeeded, 1 failed, 2 refused, 3 still running |
| `fetch` | Re-verifies the finished run, then streams a tar of exactly six regular files | the tar | 0, or 2 refused (no tar) |
| `cleanup` | Cancels a running build if needed, removes its containers and images, deletes the run folder | `cleaned <id>` | 0, or 2 refused (the run is kept) |

`fetch` returns `omp-linux-amd64`, `RELEASE_MANIFEST.json`, `SHA256SUMS.txt` and `evidence/qualification.json`, `evidence/qualification.json.sig`, `evidence/qualification-signers`.
It refuses a run that is still going, failed, timed out, was cancelled, or whose result does not verify.
A `build` call that loses its SSH connection leaves the detached build running; reconnect and poll `status`, or call `cleanup` to cancel.

Limits, all fixed in the entry (an SSH caller cannot change them):

| Limit | Value | Why |
| --- | --- | --- |
| Bundle | 256 MiB, upload within 20 minutes | A shallow bundle of the two commits plus the one-file registry commit measured about 78 MiB; a full-history one is over 600 MiB |
| Fork manifest | 1 MiB, exactly one regular file | The workstation's `fork_boundary.json` is about 78 KB for 31 contracts |
| Builds at once | 1 | An exclusive lock the supervisor holds for the whole run |
| Whole run | 4 hours, then the step's process group is killed and the run is swept | The recipe's own prepare deadline is 4 hours; the observed run is about 20 minutes |
| Cancel grace | 120 seconds | `cleanup` on a running build |
| Run folder | 6 GiB and 150 000 entries | Checked about every 5 seconds |
| Free space on the data filesystem | at least 150 GiB to start, at least 12 GiB while running | The peak is estimated at 40 to 120 GiB (never measured) |
| Available memory to start | 32 GiB | The recipe caps its build container at 24 GiB |
| Kept runs | the newest 3 finished runs, at most 7 days | Older ones are purged under the lock at the next `build` |

The log is one line per command that matched the grammar: UTC time, verb, run id, status, seconds, the first 12 characters of each commit, `candidate` or `release`, and the first 12 characters of the fork manifest hash.
It never holds a path, a key, an address or an environment value.

## Security choices

- A dedicated account with no sudo, no docker group and no password.
  Its shell is bash only because sshd runs the forced command through it.
- A separate sshd instance on its own port, `AllowUsers ompbuild`, public key only, `ForceCommand` set both there and in `authorized_keys` (`restrict` plus the explicit `no-*` options), no TTY, no forwarding, no `AcceptEnv`, no user rc.
- The entry reads `SSH_CONNECTION` to know it is under sshd, and then ignores every test-only override (`OMP_BUILD_*`).
  Keep `AcceptEnv` and `PermitUserEnvironment` unset so a caller can never set it.
- The command is matched with an anchored regular expression and never evaluated.
  The run id and the commits are fixed-form, so nothing the caller sends becomes a path or an argument without passing that match.
- Python runs with `-I` (no `PYTHON*` variables, no user site folders), and every build step gets a minimal environment: no `SSH_*`, no secrets, no door variables.
- The bundle must hold exactly `refs/omp/app`, `refs/omp/recipe`, `refs/omp/forkmanifest` and (release only) the tag, no prerequisites, and nothing else.
  It is unpacked with `fsckObjects` and no hooks into an empty repository; only `scripts/` from the recipe commit is extracted, and the application commit is only ever read through the recipe's own checks.
- The contract registry is an input, never part of the recipe.
  `refs/omp/forkmanifest` must be one parentless commit holding exactly one regular file, `fork_boundary.json`, of at most 1 MiB, whose SHA-256 equals the 64 hex characters in the command.
  The door writes those exact bytes into the run folder and passes the file and its hash to the early check, the runtime preparation and the qualifier, and the hash to the final verification, which requires the signed qualification to name it.
  A missing, oversized or altered file, an application README contract block that is not exactly the manifest's active contract ids in order, a verification command that is not `bun test <relative .test.ts files> [--test-name-pattern <text>]` (shell syntax, absolute or parent paths and URIs are refused as the updater refuses them; a `cargo test` command parses but this recipe cannot run it offline, so it is refused until a new recipe commit exists), an active contract whose test file is missing in the application commit, and a result whose qualification names another hash all refuse the build with a fixed message.
  The hash is recorded in the signed private record (`evidence/qualification.json`), never in the public `RELEASE_MANIFEST.json` (the fleet puller reads that file with exact key sets), and the Mac driver checks the recorded value against the file it sent and keeps both values in a private `build-receipt.json`.
- The build runs in the account's own rootless Docker, never as root, with `cpus 4`, 24 GiB, no swap, 1024 processes, no mounts from the host and no network inside the qualification container.
  The door refuses to run as euid 0, refuses a rootful daemon, and requires Docker's data on the capped data filesystem.
- Egress is fenced by an nftables table keyed on the account's uid: private ranges, Tailscale, link-local and the SWAN benchmarking address are dropped; public internet is allowed.
- The door generates a fresh qualification key inside each run, verifies the signed result itself (checksums, all nine checks, ELF64 x86-64, commit and tag binding, signature) and only then lets `fetch` work.
  It never holds a signing key for the source tag or the release.
- Raw build output never leaves the builder.
  Only fixed progress shapes, with any address-shaped text dropped, are streamed.
- Container removal is proved, not assumed: by exact run label and by fixed name prefix, images never forced.
  An unproven run keeps its folder and blocks the next build until `cleanup` proves removal.

## Part A. Read-only fact script (Main runs, returns the output)

It changes nothing, prints names, versions, sizes and counts, and masks every address before anything is shown.
Run it as root on ci-001, then return the whole output:

```bash host-facts.sh
#!/bin/bash
# Read-only. Run as root on ci-001: bash host-facts.sh 2>&1 | tee /root/omp-ci-facts.txt
set -u
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin
mask() { sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<addr>/g; s/([0-9A-Fa-f]{1,4}:){1,7}:[0-9A-Fa-f]{0,4}/<addr6>/g; s/([0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{0,4}/<addr6>/g; s/::[0-9A-Fa-f]{1,4}/<addr6>/g'; }
section() { printf '\n== %s\n' "$1"; }
have() { if command -v "$1" >/dev/null 2>&1; then echo "$1: present"; else echo "$1: missing"; fi; }
facts() {
  section host
  date -u +%Y%m%dT%H%M%SZ
  (. /etc/os-release && echo "$PRETTY_NAME")
  uname -srm
  echo "threads: $(nproc)"
  python3 --version 2>&1
  git --version 2>&1
  section memory
  awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ { printf "%s %.1f GiB\n", $1, $2 / 1048576 }' /proc/meminfo
  section disk
  df -BG --output=target,size,used,avail,fstype / /srv /var/log 2>&1
  findmnt -no TARGET,FSTYPE -T /srv 2>&1
  ls -ld /srv /srv/* 2>&1
  section tools
  for tool in docker nft systemctl loginctl runuser fallocate mkfs.ext4 mount losetup tailscale ssh-keygen sshd git python3 sha256sum timeout; do have "$tool"; done
  docker --version 2>&1
  docker buildx version 2>&1 | head -n 1
  dpkg-query -W -f='${Package} ${Version} ${db:Status-Abbrev}\n' docker-ce docker-ce-cli docker-buildx-plugin docker-ce-rootless-extras uidmap slirp4netns passt fuse-overlayfs openssh-server nftables 2>&1
  section "rootless prerequisites"
  for tool in newuidmap newgidmap slirp4netns pasta rootlesskit dockerd-rootless.sh dockerd-rootless-setuptool.sh; do have "$tool"; done
  ls -l /usr/bin/newuidmap /usr/bin/newgidmap 2>&1
  echo "user.max_user_namespaces: $(sysctl -n user.max_user_namespaces 2>&1)"
  echo "kernel.unprivileged_userns_clone: $(sysctl -n kernel.unprivileged_userns_clone 2>&1)"
  echo "kernel.apparmor_restrict_unprivileged_userns: $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>&1)"
  stat -fc 'cgroup filesystem: %T' /sys/fs/cgroup 2>&1
  echo "cgroup controllers: $(cat /sys/fs/cgroup/cgroup.controllers 2>&1)"
  echo "proc mount options: $(findmnt -no OPTIONS /proc 2>&1)"
  systemd-analyze cat-config systemd/logind.conf 2>/dev/null | grep -E '^(KillUserProcesses|UserTasksMax|RemoveIPC)' || echo "logind: defaults"
  section accounts
  getent passwd ompbuild | awk -F: '{ print $1, "uid=" $3, "home=" $6, "shell=" $7 }'
  id -nG ompbuild 2>&1
  awk -F: '$3 >= 1000 && $3 < 65534 { print $1, "uid=" $3, "shell=" $7 }' /etc/passwd
  echo "linger: $(ls /var/lib/systemd/linger 2>&1 | tr '\n' ' ')"
  for file in /etc/subuid /etc/subgid; do awk -F: -v file="$file" '{ end = $2 + $3; if (end > max) max = end; n++ } END { print file ": " n " entries, highest end " max }' "$file"; done
  section "ssh doors and ports"
  systemctl list-units --type=service --all --no-legend --plain '*ssh*' 2>&1 | awk '{ print $1, $3, $4 }'
  ls /etc/ssh/sshd_config.d /etc/swan-ci /etc/cdm-ci 2>&1
  echo "listening ports: $(ss -ltnH | awk '{ n = split($4, a, ":"); print a[n] }' | sort -n | uniq | tr '\n' ' ')"
  echo "port 2225 listeners: $(ss -ltnH 'sport = :2225' | wc -l)"
  sshd -T 2>/dev/null | grep -E '^(port|passwordauthentication|permitrootlogin|usepam|acceptenv|permituserenvironment|authorizedkeysfile) '
  section "firewall and fences"
  nft list tables 2>&1
  for unit in cdm-ci-fence swan-ci-sshd omp-build-fence omp-build-sshd; do printf '%s: ' "$unit"; systemctl is-active "$unit.service" 2>&1; done
  ufw status 2>&1 | head -n 1
  section "outbound proxy (service and process names only)"
  proxy_units=$(systemctl list-units --type=service --all --no-legend --plain '*mihomo*' '*clash*' 2>/dev/null | awk '{ print $1, $3, $4 }')
  echo "outbound proxy service present: $([[ -n $proxy_units ]] && echo yes || echo no)"
  echo "${proxy_units:-no proxy service unit listed}"
  echo "proxy processes: $(cat /proc/[0-9]*/comm 2>/dev/null | grep -ixE 'mihomo|clash|clash-meta' | sort -u | tr '\n' ' ')"
  section "paths this install would create"
  for path in /srv/omp-ci /srv/omp-ci.img /etc/omp-build /usr/local/lib/omp-build /var/log/omp-build /home/ompbuild /etc/systemd/system/omp-build-sshd.service /etc/systemd/system/omp-build-fence.service; do ls -ld "$path" 2>&1; done
  ls -d /etc/systemd/system/user@*.service.d 2>&1
  section "docker (rootful daemon: versions and counts only)"
  docker info --format 'server={{.ServerVersion}} driver={{.Driver}} cgroup={{.CgroupVersion}}/{{.CgroupDriver}} root={{.DockerRootDir}} containers={{.Containers}} images={{.Images}}' 2>&1
}
facts 2>&1 | mask
```

Main reads the output before Part B, and stops and asks the Captain if any of these is true:

- `newuidmap`, `newgidmap`, `dockerd-rootless-setuptool.sh` or one of `slirp4netns` / `pasta` is missing (installing a package is a separate approval).
- Port 2225 already has a listener, or `/srv/omp-ci`, `/srv/omp-ci.img` or `/home/ompbuild` already exist and are not from an earlier run of this packet.
- `/srv` has under about 300 GiB available (the data image takes 256 GiB), or `/srv` is not on a local ext4 or xfs filesystem.
- The account `ompbuild` already exists and is in the `sudo` or `docker` group.

Part A did not record `dbus-user-session` or the `ip_tables` kernel module; Part B's preflight checks both, and the tailnet address, and stops before changing anything if one is missing.

`KillUserProcesses=yes` in the logind lines is only a note, not a stop: the door's sessions are not logind sessions (`UsePAM no`), and Part E step 5 proves that a detached build survives a dropped connection.
The "outbound proxy" section only decides whether the optional proxy block for image pulls after Part B is relevant: `outbound proxy service present: yes` means the design notes' proxy (`devbox-mihomo`) runs on this box, `no` means skip the block.
It prints unit and process names and states only, never an address or a port.

## Part B. Install (Main, one root sitting)

Run once, as root on ci-001, after Part A is clean and the entry file is at `/root/omp-ci-install/omp-build-entry`.
The public key line to pass is the one in Part C.
Every step adds only new things and is safe to run again; it never touches `swan-ci`, `cdm-ci`, any other account, unit, table or mount.
A rerun restarts the fence unit and the door unit so that changed files take effect; the door's `KillMode=process` leaves a running build alone.

```bash install-host.sh
#!/bin/bash
# Main's host install for the stronk-omp Linux amd64 build door on ci-001.
# Run as root: bash install-host.sh "<public key line from docs/ci001-build-door.md Part C>"
# Expects /root/omp-ci-install/omp-build-entry already copied.  Undo: install-host-undo.sh (Part F).
set -euo pipefail

U=ompbuild
PORT=2225
DATA=/srv/omp-ci
IMG=/srv/omp-ci.img
IMG_GIB=256
ENTRY_SRC=/root/omp-ci-install/omp-build-entry
ENTRY_SHA=1f6ac7db0946f07aecbc49ddd63ea145bf61cf64021bf386ac12eadaac0784e7
PUB=${1:?public key line required}
HOME_DIR=/home/$U

[[ $(id -u) -eq 0 ]] || { echo "must run as root"; exit 1; }
[[ $(sha256sum "$ENTRY_SRC" | cut -d' ' -f1) == "$ENTRY_SHA" ]] || { echo "entry sha mismatch"; exit 1; }
[[ $PUB =~ ^ssh-ed25519\ [A-Za-z0-9+/]+=*(\ [[:print:]]*)?$ ]] || { echo "expected exactly one ssh-ed25519 public key line"; exit 1; }
for tool in newuidmap newgidmap nft tailscale fallocate mkfs.ext4 runuser loginctl; do
  command -v "$tool" >/dev/null || { echo "$tool is missing; stop and ask"; exit 1; }
done
[[ -x /usr/bin/dockerd-rootless-setuptool.sh ]] || { echo "docker-ce-rootless-extras is missing; stop and ask"; exit 1; }
command -v slirp4netns >/dev/null || command -v pasta >/dev/null || { echo "slirp4netns or passt is missing; stop and ask"; exit 1; }
[[ $(dpkg-query -W -f='${db:Status-Abbrev}' dbus-user-session 2>/dev/null) == [ih]i* ]] || { echo "dbus-user-session is not installed; stop and ask"; exit 1; }
grep -q '^ip_tables ' /proc/modules || grep -qE '(^|/)ip_tables\.ko$' "/lib/modules/$(uname -r)/modules.builtin" 2>/dev/null \
  || { echo "the ip_tables kernel module is neither loaded nor built in; stop and ask"; exit 1; }
# The address the door listens on, checked before anything is changed; kept in a variable, never printed.
TAILNET_IP=${TAILNET_IP:-$(tailscale ip -4 2>/dev/null | head -n 1 || true)}
[[ $TAILNET_IP =~ ^100\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "no tailnet address found; stop and ask"; exit 1; }
if ! systemctl is-active --quiet omp-build-sshd.service && [[ -n $(ss -ltnH "sport = :$PORT") ]]; then
  echo "port $PORT is already in use"; exit 1
fi

put_file() { # put_file <path> <mode> <owner:group>   (content on standard input; replaced atomically)
  local path=$1 mode=$2 owner=$3 tmp
  tmp=$(mktemp "$path.XXXXXX")
  cat > "$tmp"
  chmod "$mode" "$tmp"
  chown "$owner" "$tmp"
  mv -f "$tmp" "$path"
}

# 1. The account: no sudo, no docker group, no password.
if getent passwd "$U" >/dev/null; then
  IFS=: read -r _ _ uid _ _ actual_home shell < <(getent passwd "$U")
  [[ $actual_home == "$HOME_DIR" && $shell == /bin/bash ]] || { echo "$U has an unexpected home or shell"; exit 1; }
  case " $(id -nG "$U") " in *" sudo "*|*" docker "*) echo "$U must not belong to sudo or docker"; exit 1 ;; esac
else
  useradd --create-home --user-group --shell /bin/bash "$U"
fi
# A "!" password would make sshd refuse even key logins when UsePAM is off; "*" accepts no password at all.
usermod -p '*' "$U"
uid=$(id -u "$U")
chmod 0700 "$HOME_DIR"

# Subordinate ids after all existing ranges, without changing any other account's mapping.
ensure_subids() {
  local file=$1 option=$2 range
  range=$(awk -F: -v account="$U" -v uid="$uid" '
    BEGIN { next_id = 100000 }
    ($1 == account || $1 == uid) && $3 >= 65536 { found = 1 }
    $2 + $3 > next_id { next_id = $2 + $3 }
    END { if (!found) printf "%.0f-%.0f", next_id, next_id + 65535 }' "$file")
  [[ -z $range ]] || usermod "$option" "$range" "$U"
}
ensure_subids /etc/subuid --add-subuids
ensure_subids /etc/subgid --add-subgids

# 2. Data: a fully allocated 256 GiB ext4 image mounted at /srv/omp-ci. This is the size cap.
# The image is built as a .new file and renamed only after mkfs succeeds, so an interrupted run never leaves an unformatted image that a rerun would skip.
# nodiscard: by default mkfs discards the whole file, which punches holes and hands the reserved 256 GiB back to the root filesystem.
if [[ ! -e $IMG ]]; then
  rm -f "$IMG.new"
  fallocate -l "${IMG_GIB}G" "$IMG.new"
  chmod 0600 "$IMG.new"
  mkfs.ext4 -q -F -m 0 -E nodiscard -L omp-ci "$IMG.new"
  mv "$IMG.new" "$IMG"
fi
install -d -m 0755 -o root -g root "$DATA"
FSTAB_LINE="$IMG $DATA ext4 loop,nodev,nosuid,nofail 0 0"
if ! grep -qxF "$FSTAB_LINE" /etc/fstab; then
  cp -p /etc/fstab "/etc/fstab.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  { grep -v "^$IMG " /etc/fstab || true; printf '%s\n' "$FSTAB_LINE"; } > /etc/fstab.new
  chmod --reference=/etc/fstab /etc/fstab.new
  mv /etc/fstab.new /etc/fstab
  systemctl daemon-reload
fi
mountpoint -q "$DATA" || mount "$DATA"
chown "$U:$U" "$DATA"
chmod 0750 "$DATA"
install -d -m 0700 -o "$U" -g "$U" "$DATA/state" "$DATA/docker"
install -d -m 0750 -o "$U" -g "$U" /var/log/omp-build
install -d -m 0755 -o root -g root /etc/omp-build /etc/omp-build/authorized_keys /usr/local/lib/omp-build /usr/local/lib/omp-build/bin

# 3. Egress fence for this account only, in its own table (separate from cdm_fence and SWAN's fence). It goes in before the account's Docker daemon starts.
put_file /etc/omp-build/fence.nft 0644 root:root <<EOF
table inet omp_build_fence
delete table inet omp_build_fence
table inet omp_build_fence {
  chain out {
    # priority mangle - 10 (-160) runs before the mihomo nat output chain (-150) and any other NAT redirect, so the fence sees the original destination; equal priorities run in undefined order
    type filter hook output priority mangle - 10; policy accept;
    meta skuid $uid ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 } counter drop
    meta skuid $uid ip6 daddr { fc00::/7, fe80::/10 } counter drop
    meta skuid $uid ip daddr 198.18.0.1 counter drop
  }
}
EOF
put_file /etc/systemd/system/omp-build-fence.service 0644 root:root <<'EOF'
[Unit]
Description=stronk-omp build account egress fence
Before=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/omp-build/fence.nft
ExecReload=/usr/sbin/nft -f /etc/omp-build/fence.nft
ExecStop=/usr/sbin/nft delete table inet omp_build_fence

[Install]
WantedBy=multi-user.target
EOF
/usr/sbin/nft -c -f /etc/omp-build/fence.nft
systemctl daemon-reload
systemctl enable omp-build-fence.service
# Restart, not "enable --now": on a rerun, a changed fence.nft must take effect.
# The door Requires the fence, so a restart also restarts the door; that is safe because the door unit has KillMode=process.
systemctl restart omp-build-fence.service

# 4. Rootless Docker, on the capped filesystem, now that the fence is already loaded.
# The shim adds OwnerUID for runc when /proc is mounted with hidepid (same shim as the other CI accounts).
put_file /usr/local/lib/omp-build/bin/busctl 0755 root:root <<'EOF'
#!/bin/sh
if [ "$*" = "--user --no-pager status" ]; then
  out=$(/usr/bin/busctl --user --no-pager status) || exit $?
  printf '%s\n' "$out"
  case "$out" in
    *OwnerUID=*) ;;
    *) uid=$(awk '$1 == 0 { print $2; exit }' /proc/self/uid_map)
       [ -n "$uid" ] && printf 'OwnerUID=%s\n' "$uid" ;;
  esac
  exit 0
fi
exec /usr/bin/busctl "$@"
EOF
install -d -m 0755 -o root -g root "/etc/systemd/system/user@$uid.service.d"
put_file "/etc/systemd/system/user@$uid.service.d/omp-build.conf" 0644 root:root <<'EOF'
[Unit]
RequiresMountsFor=/srv/omp-ci

[Service]
Delegate=cpu cpuset io memory pids
EOF
systemctl daemon-reload
loginctl enable-linger "$U"
systemctl start "user@$uid.service"

# Root writes into the account's folders below, and install, mv and chown follow links; refuse any link there.
for path in "$HOME_DIR/.config" "$HOME_DIR/.config/docker" "$HOME_DIR/.config/docker/daemon.json" \
  "$HOME_DIR/.config/systemd" "$HOME_DIR/.config/systemd/user" "$HOME_DIR/.config/systemd/user/docker.service.d" \
  "$HOME_DIR/.config/systemd/user/docker.service.d/omp-build-busctl.conf" "$DATA/docker"; do
  [[ ! -L $path ]] || { echo "$path is a symbolic link; inspect it first"; exit 1; }
done
install -d -m 0700 -o "$U" -g "$U" "$HOME_DIR/.config" "$HOME_DIR/.config/docker" "$HOME_DIR/.config/systemd" \
  "$HOME_DIR/.config/systemd/user" "$HOME_DIR/.config/systemd/user/docker.service.d"
put_file "$HOME_DIR/.config/docker/daemon.json" 0600 "$U:$U" <<EOF
{
  "data-root": "$DATA/docker"
}
EOF
put_file "$HOME_DIR/.config/systemd/user/docker.service.d/omp-build-busctl.conf" 0644 "$U:$U" <<'EOF'
[Service]
Environment=PATH=/usr/local/lib/omp-build/bin:/usr/bin:/bin:/usr/sbin:/sbin
EOF
as_u=(runuser -u "$U" -- env "HOME=$HOME_DIR" "XDG_RUNTIME_DIR=/run/user/$uid"
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" "DOCKER_HOST=unix:///run/user/$uid/docker.sock")
# The host may also have an idle rootful daemon; --force leaves it alone.
"${as_u[@]}" /usr/bin/dockerd-rootless-setuptool.sh install --force
"${as_u[@]}" systemctl --user daemon-reload
"${as_u[@]}" systemctl --user enable --now docker.service

# 5. The entry (root-owned, the only thing the key can run).
install -m 0755 -o root -g root "$ENTRY_SRC" /usr/local/lib/omp-build/entry

# 6. The door: a separate sshd on the tailnet address, port 2225, this account only, forced command only.
[[ -f /etc/omp-build/ssh_host_ed25519_key ]] || ssh-keygen -q -t ed25519 -N '' -C omp-build-sshd -f /etc/omp-build/ssh_host_ed25519_key
chmod 0600 /etc/omp-build/ssh_host_ed25519_key
printf 'restrict,command="/usr/local/lib/omp-build/entry",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc %s\n' "$PUB" \
  > "/etc/omp-build/authorized_keys/$U"
chmod 0644 "/etc/omp-build/authorized_keys/$U"
put_file /etc/omp-build/sshd_config 0644 root:root <<EOF
# stronk-omp Linux build door. Separate from Tailscale SSH on port 22 and from the SWAN doors.
# Only $U, only by key, only the reviewed forced command. No AcceptEnv and no PermitUserEnvironment: a caller
# must never be able to set SSH_CONNECTION or any OMP_BUILD_* override.
ListenAddress $TAILNET_IP:$PORT
HostKey /etc/omp-build/ssh_host_ed25519_key
PidFile none
AllowUsers $U
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
UsePAM no
StrictModes yes
AuthorizedKeysFile /etc/omp-build/authorized_keys/%u
AuthorizedPrincipalsFile none
ForceCommand /usr/local/lib/omp-build/entry
DisableForwarding yes
AllowAgentForwarding no
AllowTcpForwarding no
AllowStreamLocalForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
PermitTTY no
PermitUserRC no
PermitUserEnvironment no
PrintMotd no
PrintLastLog no
MaxStartups 4:30:8
MaxSessions 4
MaxAuthTries 2
LoginGraceTime 20
ClientAliveInterval 30
ClientAliveCountMax 4
LogLevel VERBOSE
SyslogFacility AUTH
EOF
/usr/sbin/sshd -t -f /etc/omp-build/sshd_config
# KillMode=process: restarting the door must not kill a build that is running in a detached supervisor.
put_file /etc/systemd/system/omp-build-sshd.service 0644 root:root <<'EOF'
[Unit]
Description=stronk-omp Linux build door (separate sshd instance, forced command only)
After=network-online.target tailscaled.service omp-build-fence.service
Requires=omp-build-fence.service
Wants=network-online.target
RequiresMountsFor=/srv/omp-ci

[Service]
Type=exec
RuntimeDirectory=sshd
RuntimeDirectoryPreserve=yes
ExecStartPre=/usr/sbin/sshd -t -f /etc/omp-build/sshd_config
ExecStart=/usr/sbin/sshd -D -e -f /etc/omp-build/sshd_config
ExecReload=/bin/kill -HUP $MAINPID
KillMode=process
Restart=always
RestartSec=10
MemoryMax=2G
TasksMax=512

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable omp-build-sshd.service
# Restart, not "enable --now": on a rerun, a changed sshd_config must take effect.
# A restart is safe even while a build runs, because KillMode=process leaves the detached supervisor alone.
systemctl restart omp-build-sshd.service
sleep 1
systemctl is-active omp-build-sshd.service

# 7. Report: names, hashes and a masked port check. Return this output.
mask() { sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<addr>/g'; }
echo "entry $(sha256sum /usr/local/lib/omp-build/entry | cut -d' ' -f1)"
id "$U"
findmnt -no SOURCE,SIZE,OPTIONS "$DATA" | mask
du -B1G "$IMG"
du -B1G --apparent-size "$IMG"
df -BG --output=avail / | tail -n 1 | sed 's/^/root filesystem free: /'
ls -ld "$DATA" "$DATA/state" "$DATA/docker" /var/log/omp-build /etc/omp-build /usr/local/lib/omp-build/entry
"${as_u[@]}" docker info --format 'rootless-daemon server={{.ServerVersion}} arch={{.Architecture}} cgroup={{.CgroupVersion}}/{{.CgroupDriver}} security={{.SecurityOptions}} root={{.DockerRootDir}} memlimit={{.MemoryLimit}} swaplimit={{.SwapLimit}} pids={{.PidsLimit}}'
"${as_u[@]}" docker buildx version | head -n 1
nft list table inet omp_build_fence | grep -c 'counter' | sed 's/^/fence rules: /'
ss -ltnH "sport = :$PORT" | mask
echo "hostkey $(ssh-keygen -lf /etc/omp-build/ssh_host_ed25519_key.pub)"
echo "hostkey-line $(cut -d' ' -f1,2 /etc/omp-build/ssh_host_ed25519_key.pub)"
```

The fence's drop sets must never overlap `198.18.0.0/15` (the outbound proxy's fake-address range) or `127.0.0.0/8` (local DNS), or proxied traffic and name lookups would be dropped; only the single gateway address `198.18.0.1` is dropped.
On ci-001 the proxy answers names with fake addresses, policy routing sends them to its tun device and a NAT output chain at priority -150 redirects them, so the fence runs at `priority mangle - 10` to see the original destination first (equal priorities run in undefined order).
The packet test parses the fence and fails on any overlap or on a changed priority.

Release builds also need `/etc/omp-build/source-allowed-signers` and `/etc/omp-build/source-revoked-signers` (root-owned, mode 0644, the allowed file non-empty, the revoked file empty when nothing is revoked).
They hold public keys only and come from the Captain after he separately approves release signing; the candidate smoke below does not need them.

### Optional: image pulls of the rootless Docker daemon through the outbound proxy

Skip this unless Part A printed `outbound proxy service present: yes`, Part E step 2b's image pull cannot reach the registry directly, and the Captain wants it.
It is not expected to be needed on ci-001: host egress there is transparent (read-only check, 2026-10-24: as the system account `nobody`, with proxy variables cleared, `github.com` and `snapshot.debian.org` answered HTTPS 200), and the four existing rootless CI accounts set no proxy variables.
It stays here only as a fallback for image pulls, and it covers image pulls by the account's own Docker daemon only, not container egress: the build's `apt-get`, downloads and `bun install` run inside containers that get no proxy variables from it, so Part E step 2c must pass without this block, and if 2c fails this block is not the answer.
The design notes list an outbound proxy (`devbox-mihomo`) on this box.
This block only gives the account's own Docker daemon the standard proxy variables (a systemd user drop-in), so image pulls use the proxy.
It does not change the egress fence, container networking or the recipe, and it needs the proxy's address from the box owner: put it in the command by hand, nothing here holds a real one.
The script refuses an address with credentials, refuses to run while any build run folder exists (restarting the daemon would end it), writes only `~/.config/systemd/user/docker.service.d/omp-build-proxy.conf` and prints no address.
Undo: `bash optional-docker-proxy.sh undo` removes that one file and restarts the daemon; Part F's `REMOVE_ACCOUNT=1` removes it with the account's home.

```bash optional-docker-proxy.sh
#!/bin/bash
# OPTIONAL. Run as root on ci-001 after Part B, only if Part A printed "outbound proxy service present: yes" and image pulls fail. It covers pulls by the account's Docker daemon only, not container egress.
#   bash optional-docker-proxy.sh set "http://<proxy-host>:<proxy-port>"   write the drop-in, restart the account's Docker daemon
#   bash optional-docker-proxy.sh undo                                     remove that one drop-in, restart it
set -euo pipefail
U=ompbuild
HOME_DIR=/home/$U
DIR=$HOME_DIR/.config/systemd/user/docker.service.d
FILE=$DIR/omp-build-proxy.conf
valid_proxy() { [[ $1 =~ ^http://[A-Za-z0-9][A-Za-z0-9.-]*:[0-9]{1,5}$ ]]; }

[[ $(id -u) -eq 0 ]] || { echo "must run as root"; exit 1; }
uid=$(id -u "$U")
for path in "$HOME_DIR/.config" "$HOME_DIR/.config/systemd" "$HOME_DIR/.config/systemd/user" "$DIR" "$FILE"; do
  [[ ! -L $path ]] || { echo "$path is a symbolic link; inspect it first"; exit 1; }
done
[[ -z $(ls -A /srv/omp-ci/state/runs 2>/dev/null) ]] || { echo "a build run folder exists; clean it up first"; exit 1; }
as_u=(runuser -u "$U" -- env "HOME=$HOME_DIR" "XDG_RUNTIME_DIR=/run/user/$uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus")
case ${1:-} in
  set)
    PROXY=${2:?proxy URL required}
    valid_proxy "$PROXY" || { echo "expected http://<host>:<port> with no credentials"; exit 1; }
    install -d -m 0700 -o "$U" -g "$U" "$DIR"
    tmp=$(mktemp "$FILE.XXXXXX")
    cat > "$tmp" <<EOF
[Service]
Environment="HTTP_PROXY=$PROXY"
Environment="HTTPS_PROXY=$PROXY"
Environment="NO_PROXY=localhost"
EOF
    chmod 0644 "$tmp"
    chown "$U:$U" "$tmp"
    mv -f "$tmp" "$FILE"
    ;;
  undo) rm -f "$FILE" ;;
  *) echo "usage: optional-docker-proxy.sh set <proxy-url> | undo"; exit 2 ;;
esac
"${as_u[@]}" systemctl --user daemon-reload
"${as_u[@]}" systemctl --user restart docker.service
"${as_u[@]}" systemctl --user is-active docker.service
echo "proxy drop-in present: $([[ -e $FILE ]] && echo yes || echo no)"
```

## Part C. The authorized_keys line

`install-host.sh` writes this line to `/etc/omp-build/authorized_keys/ompbuild`.
The key is the public half of `~/.ssh/omp-ci001-build` on the Mac; the private half never leaves the Mac.

```text authorized_keys
restrict,command="/usr/local/lib/omp-build/entry",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP6moBaqKurCumIXaEubYKtZkXsI8ds7umcRayX52fqH omp-ci001-build (stronk-omp linux-amd64 build door, 2026-10-23)
```

The argument for `install-host.sh` is only the part after the options:

```text public-key-argument
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP6moBaqKurCumIXaEubYKtZkXsI8ds7umcRayX52fqH omp-ci001-build (stronk-omp linux-amd64 build door, 2026-10-23)
```

Run it as `bash install-host.sh "<that line>"` (keep the double quotes).

## Part D. The Mac side

Main returns the install report; the line that starts `hostkey-line` holds the door's host key (type and key, no address).
Add the alias block to `~/.ssh/config` and replace the placeholder with ci-001's tailnet address by hand; nothing in this packet contains a real address.

```sshconfig
Host cdm-ci-001-ompbuild
    HostName <ci-001 tailnet address>
    Port 2225
    User ompbuild
    IdentityFile ~/.ssh/omp-ci001-build
    IdentitiesOnly yes
    HostKeyAlias omp-ci001-build
    UserKnownHostsFile ~/.ssh/known_hosts_omp_ci001_build
    GlobalKnownHostsFile /dev/null
    StrictHostKeyChecking yes
    UpdateHostKeys no
    PreferredAuthentications publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    BatchMode yes
    ForwardAgent no
    ForwardX11 no
    ClearAllForwardings yes
    RequestTTY no
    ControlMaster no
    ControlPath none
    ServerAliveInterval 30
    ServerAliveCountMax 4
    ConnectTimeout 20
```

Create the host-key file from the report line (both forms, because ssh looks the alias up with or without the port):

```sh
umask 077
KEY_LINE='<the type and key after "hostkey-line " in the install report>'
printf 'omp-ci001-build %s\n[omp-ci001-build]:2225 %s\n' "$KEY_LINE" "$KEY_LINE" > ~/.ssh/known_hosts_omp_ci001_build
```

The Mac driver already passes `-i ~/.ssh/omp-ci001-build -o IdentitiesOnly=yes -o BatchMode=yes -o ControlPath=none`, and redacts the key path and any address from what it prints.

## Part E. Smoke steps

Stop at the first step that does not match, keep the output, and report it; do not try another route.

1. Door refuses everything but the grammar (Mac). Each must print the exact refusal and exit 2; none starts anything:

   ```sh
   ssh -i ~/.ssh/omp-ci001-build -o IdentitiesOnly=yes -o BatchMode=yes -o ControlPath=none cdm-ci-001-ompbuild 'id'
   ssh -i ~/.ssh/omp-ci001-build -o IdentitiesOnly=yes -o BatchMode=yes -o ControlPath=none cdm-ci-001-ompbuild 'status b20261023153012-3fa9c1d2'
   ```

   Expected: `refused: invalid command`, then `refused: no such run`.
   A terminal request (`ssh -tt ...`) gets no terminal, `sftp cdm-ci-001-ompbuild` fails, and `ssh -L 9999:localhost:22 ...` is refused (forwarding is disabled).
2. The rootless daemon, a container under the build limits, the egress and the fence (Main, as root on ci-001).
   Do parts a to d in order, in one root shell, and stop at the first one that does not match.
   `curl` is not installed on ci-001 and nothing here installs it: the checks from the host use the system `python3` as the account, and the checks inside a container use that container image's own tools.

   a. Daemon facts (the entry refuses to start a build unless rootless mode, cgroup 2, the three limit flags and the data root all hold):

      ```bash
      cd /
      U=ompbuild; uid=$(id -u "$U")
      noproxy=(env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY)
      as_u=(runuser -u "$U" -- "${noproxy[@]}" "XDG_RUNTIME_DIR=/run/user/$uid" "DOCKER_HOST=unix:///run/user/$uid/docker.sock")
      "${as_u[@]}" docker info --format '{{json .}}' | python3 -I -c '
      import json, sys
      info = json.load(sys.stdin)
      for key in ("ServerVersion", "SecurityOptions", "CgroupVersion", "CgroupDriver", "MemoryLimit", "PidsLimit", "CpuCfsQuota", "SwapLimit", "DockerRootDir"):
          print(key, info.get(key))'
      "${as_u[@]}" docker buildx version | head -n 1
      ```

      Expected: `SecurityOptions` lists `name=rootless`; `CgroupVersion 2` and `CgroupDriver systemd`; `MemoryLimit`, `PidsLimit` and `CpuCfsQuota` all `True`; `DockerRootDir` under `/srv/omp-ci/docker`; a buildx version line.
      `SwapLimit` may read `False`: the entry does not need it, and the recipe's `--memory-swap` setting then only warns.
   b. A container starts under the build limits.
      This pulls the recipe's pinned base image by digest (`BASE_IMAGE` in `scripts/linux-amd64.Dockerfile`; the packet test fails if this copy drifts) and runs it with the same limits as the build's runtime container, which proves the account's user bus, cgroup delegation and limits before the 20-minute build:

      ```bash
      BASE='rustlang/rust:nightly-2026-08-12@sha256:51dc497bff0c24777d2ec6a1fc12ddf7ab0483de3ee537f4ec10816b9e1eff6c'
      "${as_u[@]}" docker pull -q "$BASE"
      "${as_u[@]}" docker run --rm --pull=never --cpus=4 --memory=24g --memory-swap=24g --pids-limit=1024 "$BASE" \
        sh -c 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max'
      ```

      Expected: `25769803776`, `1024` and `400000 100000` (24 GiB, 1024 processes, 4 CPUs).
      A Docker warning about swap limit support is normal.
      If only the pull fails, the optional proxy block below may fix pulls; part c must still pass afterwards.
   c. Egress from a container on the default network, which is where the build's `apt-get` and downloads run: DNS and HTTPS to `github.com` and `snapshot.debian.org` must work, and the Tailscale service address must fail while the fence counter rises:

      ```bash
      fence_drops() { nft list table inet omp_build_fence | awk '/100\.64\.0\.0\/10/ { for (i = 1; i < NF; i++) if ($i == "packets") print $(i + 1) }'; }
      before=$(fence_drops)
      "${as_u[@]}" docker run --rm --pull=never --cpus=4 --memory=24g --memory-swap=24g --pids-limit=1024 "$BASE" sh -c '
        for host in github.com snapshot.debian.org; do
          getent hosts "$host" >/dev/null && echo "dns $host: ok" || echo "dns $host: FAILED"
          curl -sSI --noproxy "*" --proto "=https" --tlsv1.2 --connect-timeout 10 --max-time 30 "https://$host/" | head -n 1
        done
        curl -sS --noproxy "*" --connect-timeout 5 --max-time 6 https://100.100.100.100/ >/dev/null \
          && echo "TAILSCALE ADDRESS REACHED: the fence does not hold" || echo "tailscale address: blocked, as expected"'
      after=$(fence_drops)
      echo "fence counter before=$before after=$after"
      ```

      Expected: `dns github.com: ok` and `dns snapshot.debian.org: ok`, an `HTTP/` status line for each site (200 or a redirect), `tailscale address: blocked, as expected`, and `after` higher than `before` (the fence saw the packets before any redirect).
      If part c fails, stop: the build's network-heavy step runs in exactly such a container, and the optional proxy block below cannot fix container egress.
   d. The fence from the host, as the account, with proxy variables cleared and proxies also switched off in the request (`runuser` passes root's environment through, so a proxy variable would otherwise make this pass for the wrong reason):

      ```bash
      reach() { runuser -u "$U" -- "${noproxy[@]}" python3 -I -c '
      import sys, urllib.request
      opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
      for url in sys.argv[1:]:
          try:
              with opener.open(urllib.request.Request(url, method="HEAD"), timeout=8) as reply:
                  print("reached", url, reply.status)
          except Exception as error:
              print("failed", url, type(error).__name__)' "$@"; }
      nft list table inet omp_build_fence
      reach https://100.100.100.100/
      nft list table inet omp_build_fence
      reach https://github.com/ https://snapshot.debian.org/
      ```

      Expected: `failed https://100.100.100.100/ URLError` (a timeout) and a higher drop counter in the second listing; then `reached ... 200` for GitHub and for snapshot.debian.org.
3. A real candidate build (Mac, after the Captain's go-ahead; it takes roughly 20 minutes the first time and is the first native end-to-end run of this route).
   The application commit is the head of `stronk-omp`, and the fork manifest is the workstation's current `fork_boundary.json`; the driver sends exactly that file and its hash with the build:

   ```sh
   cd ~/Documents/Work/Dev/worktrees/omp-linux-ci001-20261023
   python3 scripts/ci001/build-linux-amd64-remote \
     --app "$(git rev-parse stronk-omp)" \
     --recipe "$(git rev-parse release/omp-linux-ci001-20261023)" \
     --fork-manifest "<workstation worktree>/agents-tools/.agents/skills/upgrade-omp/fork_boundary.json" \
     --output ~/.local/state/omp-team/2026-10-23/ci001-smoke-1
   ```

   Before this, run `python3 scripts/linux-amd64-receipt.py check --commit "$(git rev-parse stronk-omp)" --fork-manifest "<the same file>"` on the Mac: it refuses early, and offline, a manifest that the application's README block or test files do not satisfy.
   Expected: a `run <id>` line, `Phase: door ...` progress lines (the check line names `manifest <12 hex>`), `state: succeeded`, then `verified: omp 18.8.0 linux-amd64 ...`, `qualified: all nine checks passed on the builder; tag none (candidate, never publishable)`, `fork manifest: <64 hex> (the signed qualification record names exactly the file that was sent)` and a `receipt:` line.
   The output folder holds `assets/` (three public files), `evidence/` (three private files) and `build-receipt.json` (private, mode 0600, never published).
   Exit codes: 1 the remote build failed, 2 refused, 3 the Mac's own verification failed (the run is then kept on the box), 4 transport.
4. Proof of removal (Main, as root, after step 3):

   ```bash
   ls -A /srv/omp-ci/state/runs
   runuser -u ompbuild -- env "XDG_RUNTIME_DIR=/run/user/$(id -u ompbuild)" "DOCKER_HOST=unix:///run/user/$(id -u ompbuild)/docker.sock" \
     docker ps -a --format '{{.Names}}'
   df -BG /srv/omp-ci | tail -n 1
   tail -n 5 /var/log/omp-build/runs.log
   ```

   Expected: no run folder (the driver calls `cleanup`), no `omp-build-*` containers, the data filesystem back near its start size, and log lines with no paths, keys or addresses.
5. The door is single-flight and survives a drop (Mac, optional): start a build, kill the `ssh` process with `kill`, run the driver again with `--resume <run id>`; it picks the same run up from `status`.

## Part F. Undo

Run as root, with the Captain's approval.
It stops the door first, then removes what Part B added.
It keeps the 256 GiB image, the account and its home, and the log folder unless asked:
`REMOVE_DATA=1` deletes the image and every build artefact on it, `REMOVE_ACCOUNT=1` removes the account and its home, `REMOVE_LOGS=1` removes `/var/log/omp-build`.
`REMOVE_ACCOUNT=1` is refused unless `REMOVE_DATA=1` and `REMOVE_LOGS=1` are set too: the next new account would reuse the freed user id and subordinate id block, and so would own the old build outputs.

```bash install-host-undo.sh
#!/bin/bash
# Undo for install-host.sh. Run as root, with the Captain's approval.
set -euo pipefail
U=ompbuild
DATA=/srv/omp-ci
IMG=/srv/omp-ci.img
[[ $(id -u) -eq 0 ]] || { echo "must run as root"; exit 1; }
# Refuse first, before anything is stopped or removed.
if [[ ${REMOVE_ACCOUNT:-0} == 1 && ( ${REMOVE_DATA:-0} != 1 || ${REMOVE_LOGS:-0} != 1 ) ]]; then
  echo "REMOVE_ACCOUNT=1 also needs REMOVE_DATA=1 and REMOVE_LOGS=1: a reused uid would otherwise own the old build outputs"; exit 1
fi
uid=$(id -u "$U" 2>/dev/null || true)

# 1. Door off first, so no new build can start.
systemctl disable --now omp-build-sshd.service 2>/dev/null || true
rm -f /etc/systemd/system/omp-build-sshd.service
# 2. Stop whatever the account is still running (a build, its Docker daemon), then stop its user manager.
if [[ -n $uid ]]; then
  pkill -TERM -u "$U" 2>/dev/null || true
  sleep 5
  pkill -KILL -u "$U" 2>/dev/null || true
  runuser -u "$U" -- env "XDG_RUNTIME_DIR=/run/user/$uid" systemctl --user disable --now docker.service 2>/dev/null || true
  loginctl disable-linger "$U" 2>/dev/null || true
  systemctl stop "user@$uid.service" 2>/dev/null || true
  rm -rf "/etc/systemd/system/user@$uid.service.d"
fi
# 3. Fence off.
systemctl disable --now omp-build-fence.service 2>/dev/null || true
rm -f /etc/systemd/system/omp-build-fence.service
nft delete table inet omp_build_fence 2>/dev/null || true
systemctl daemon-reload
# 4. Files this install added.
rm -rf /usr/local/lib/omp-build /etc/omp-build
if [[ ${REMOVE_LOGS:-0} == 1 ]]; then rm -rf /var/log/omp-build; fi
# 5. Data and account, only on request.
if [[ ${REMOVE_DATA:-0} == 1 ]]; then
  if mountpoint -q "$DATA"; then umount "$DATA"; fi
  if grep -q "^$IMG " /etc/fstab; then
    cp -p /etc/fstab "/etc/fstab.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    grep -v "^$IMG " /etc/fstab > /etc/fstab.new || true
    chmod --reference=/etc/fstab /etc/fstab.new
    mv /etc/fstab.new /etc/fstab
    systemctl daemon-reload
  fi
  rm -f "$IMG" "$IMG.new"
  rmdir "$DATA" 2>/dev/null || true
fi
if [[ ${REMOVE_ACCOUNT:-0} == 1 ]] && [[ -n $uid ]]; then
  userdel -r "$U" || true
fi
echo undone
```

The Mac side of the undo: delete the `Host cdm-ci-001-ompbuild` block and `~/.ssh/known_hosts_omp_ci001_build`.
The optional Docker daemon proxy drop-in is removed by `bash optional-docker-proxy.sh undo`, or goes with the account's home under `REMOVE_ACCOUNT=1`.
The private key `~/.ssh/omp-ci001-build` is the Captain's to keep or destroy.

## Part G. Operating notes (Main)

- Stop new builds at once without touching the box: remove the line from `/etc/omp-build/authorized_keys/ompbuild` (sshd re-reads it on every login), or `systemctl stop omp-build-sshd.service`.
  A build already running keeps running in its own supervisor; end it with `cleanup <run-id>` through the door, or `pkill -TERM -u ompbuild -f 'omp-build/entry'`.
- To use the entry on the box without sshd (for example `status`), run it with `SSH_CONNECTION=ops` set, which makes it ignore every override: `runuser -u ompbuild -- env SSH_CONNECTION=ops SSH_ORIGINAL_COMMAND='status <run-id>' sh /usr/local/lib/omp-build/entry`.
- Restart or reload the door with `systemctl reload omp-build-sshd.service` (a restart is also safe, because `KillMode=process` leaves detached builds alone).
- Runs live in `/srv/omp-ci/state/runs/<run-id>/` (mode 0700, owned by `ompbuild`); the log is `/var/log/omp-build/runs.log`.
- If `systemd-logind` has `KillUserProcesses=yes`, set `KillUserProcesses=no` for this account with a drop-in under `/etc/systemd/logind.conf.d/`, because a detached build must outlive its SSH session.
  With `UsePAM no` the door's sessions are not logind sessions at all, so the default does not apply; the smoke test in step 5 proves it on the real box.
- A run is `cleanup: unproven` when Docker would not confirm removal.
  Fix the daemon (`runuser -u ompbuild -- env XDG_RUNTIME_DIR=/run/user/$(id -u ompbuild) systemctl --user status docker.service`), then `cleanup <run-id>` through the door.
- Rotating the key: generate a new pair on the Mac, replace the line in Part C, run `install-host.sh` again, and delete the old public key line.
- `docker-ce-rootless-extras` is on hold at the same version as `docker-ce`: upgrade both together, or a `docker-ce` upgrade alone leaves rootlesskit and the rootless scripts behind.
  `MemoryMax=2G` and `TasksMax=512` on the door unit also cap the detached build supervisor and every host-side step, because they live in the door's cgroup (enough for a 256 MiB bundle; Part E step 3 proves it).
- The door `Requires=` the fence, so stopping or restarting `omp-build-fence.service` also stops or restarts the door (a running build is not touched).
  If something flushes the whole nftables ruleset (for example restarting `nftables.service`), the table is gone while the unit still reports active: check `nft list table inet omp_build_fence` and run `systemctl restart omp-build-fence.service`.
