#!/usr/bin/env bash
# Shared ordinary artifact build and resource-bounded runtime preparation.
set -euo pipefail
set +x
umask 022
mode=${1:-build}
case "$mode" in build|prepare-runtime) ;; *) exit 2 ;; esac
phase() { printf 'Phase: %s\n' "$1"; }
# Network tools may report resolved addresses. Never retain or forward their logs.
quiet() { "$@" >/dev/null 2>&1; }
on_exit() {
  local result=$?
  if (( result != 0 )); then printf 'Phase: preparation failed (status %s).\n' "$result"; fi
}
trap on_exit EXIT

test "$TARGETPLATFORM" = linux/amd64
test "$(uname -m)" = x86_64
test "$BASE_IMAGE" = 'rustlang/rust:nightly-2026-08-12@sha256:51dc497bff0c24777d2ec6a1fc12ddf7ab0483de3ee537f4ec10816b9e1eff6c'
test "$BUN_VERSION" = 1.4.4
test "$BUN_SHA256" = e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76
test "$BAZEL_VERSION" = 9.2.0
test "$BAZEL_SHA256" = 7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694
test "$DEBIAN_SNAPSHOT" = 20260813T000000Z
phase 'installing pinned build tools.'
# Keep TLS and signature checks; disable only historical Release expiry.
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources
printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/%s/ trixie main\n' "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list
quiet apt-get update
quiet apt-get install -y --no-install-recommends cmake ninja-build pkg-config python3 binutils
rm -rf /var/lib/apt/lists/*
quiet curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --connect-timeout 20 --speed-limit 1024 --speed-time 90 \
  "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip" -o /tmp/bun.zip
printf '%s  /tmp/bun.zip\n' "$BUN_SHA256" | sha256sum --check --status
quiet unzip -q /tmp/bun.zip -d /tmp/bun
install -m 755 /tmp/bun/bun-linux-x64-baseline/bun /usr/local/bin/bun
rm -rf /tmp/bun /tmp/bun.zip
test "$(bun --version)" = "$BUN_VERSION"
quiet curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --connect-timeout 20 --speed-limit 1024 --speed-time 90 \
  "https://github.com/bazelbuild/bazel/releases/download/${BAZEL_VERSION}/bazel-${BAZEL_VERSION}-linux-x86_64" -o /tmp/bazel
printf '%s  /tmp/bazel\n' "$BAZEL_SHA256" | sha256sum --check --status
install -m 755 /tmp/bazel /usr/local/bin/bazel
rm /tmp/bazel
cd /src
test ! -e .bazelrc.user
test "$(cat .bazelversion)" = "$BAZEL_VERSION"
if [[ "$mode" == prepare-runtime ]]; then
  mkdir -p /opt/omp-qualification
  cp -a /src /opt/omp-qualification/source
fi
phase 'locked JavaScript dependencies.'
quiet bun install --frozen-lockfile --ignore-scripts
if [[ "$mode" == prepare-runtime ]]; then
  quiet python3 /recipe/linux-amd64-runtime.py --inside-dependencies
fi
# Baseline uses the source-pinned Bazel nightly Rust/Zig GNU toolchain,
# not the base's host Cargo compiler.
phase 'GNU amd64 baseline native addon.'
quiet bun scripts/bazel-natives.ts linux-x64-baseline --dest packages/natives/native -- --lockfile_mode=error
phase 'embedding native/resources and compiling baseline Bun.'
quiet env CROSS_TARGET=linux-x64 BUN_COMPILE_EXECUTABLE_PATH=/usr/local/bin/bun \
  bun packages/coding-agent/scripts/build-binary.ts
mkdir /out
install -m 755 packages/coding-agent/dist/omp-linux-x64 /out/omp-linux-amd64
quiet python3 /recipe/linux-amd64-receipt.py create /out
if [[ "$mode" == prepare-runtime ]]; then
  phase 'compiling canonical native regression.'
  # Qualification-only harness: GNU 2.27 for memfd_create; shipping stays GNU 2.17.
  native_args=(--lockfile_mode=error --platforms=@zig_sdk//platform:linux_amd64 -c opt
    --extra_toolchains=@zig_sdk//toolchain:linux_amd64_gnu.2.27
    '--extra_execution_platforms=@bazel_tools//tools:host_platform,@zig_sdk//platform:linux_amd64'
    --@rules_rust//rust/settings:lto=thin
    '--@rules_rust//rust/settings:extra_rustc_flags=-Ccodegen-units=16,-Cstrip=symbols,-Ctarget-cpu=x86-64-v2')
  native_target=//crates/pi-walker:pi-walker_test
  quiet bazel build "${native_args[@]}" "$native_target"
  bazel cquery "${native_args[@]}" --output=files "$native_target" > /tmp/native-output 2>/dev/null
  mapfile -t native_outputs < /tmp/native-output
  test "${#native_outputs[@]}" = 1
  test -f "${native_outputs[0]}" && test -x "${native_outputs[0]}"
  install -m 755 "${native_outputs[0]}" /opt/omp-qualification/native-grep-regression
  chmod -R a+rX /opt/omp-qualification
  phase 'validating prepared runtime contract.'
  quiet python3 /recipe/linux-amd64-runtime.py --inside-prepare
  # Build state and caches never become qualification inputs.
  cd /
  rm -rf /src /build-home /tmp/* /tmp/.[!.]* /tmp/..?*
  phase 'prepared runtime complete.'
else
  file /out/omp-linux-amd64
fi
