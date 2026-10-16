# All downloads are versioned and SHA-256 checked. The base is the official
# rust-lang/docker-rust nightly-trixie amd64 manifest, not a floating tag/index.
ARG BASE_IMAGE=rustlang/rust:nightly-2026-08-12@sha256:51dc497bff0c24777d2ec6a1fc12ddf7ab0483de3ee537f4ec10816b9e1eff6c
FROM --platform=linux/amd64 ${BASE_IMAGE} AS build
ARG BASE_IMAGE
ARG TARGETPLATFORM
ARG BUN_VERSION=1.4.2
ARG BUN_SHA256=c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f
ARG BAZEL_VERSION=9.2.0
ARG BAZEL_SHA256=7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694
ARG DEBIAN_SNAPSHOT=20260813T000000Z
ENV BASE_IMAGE=${BASE_IMAGE} BUN_VERSION=${BUN_VERSION} BUN_SHA256=${BUN_SHA256} \
    BAZEL_VERSION=${BAZEL_VERSION} BAZEL_SHA256=${BAZEL_SHA256} DEBIAN_SNAPSHOT=${DEBIAN_SNAPSHOT} \
    RUSTUP_TOOLCHAIN=nightly-2026-08-12 HOME=/build-home \
    LC_ALL=C TZ=UTC BUN_INSTALL_CACHE_DIR=/build-home/bun-cache
RUN test "$TARGETPLATFORM" = linux/amd64 && test "$(uname -m)" = x86_64
# Frozen signed Debian snapshot also fixes CMake/Ninja and their dependencies.
# Disable only the historical Release expiry, not TLS or signature checking.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources \
    && printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/%s/ trixie main\n' "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends cmake ninja-build pkg-config python3 binutils \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 20 --speed-limit 1024 --speed-time 90 \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip" -o /tmp/bun.zip \
    && printf '%s  /tmp/bun.zip\n' "$BUN_SHA256" | sha256sum --check --status \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -m 755 /tmp/bun/bun-linux-x64-baseline/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip \
    && test "$(bun --version)" = "$BUN_VERSION"
RUN curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --connect-timeout 20 --speed-limit 1024 --speed-time 90 \
      "https://github.com/bazelbuild/bazel/releases/download/${BAZEL_VERSION}/bazel-${BAZEL_VERSION}-linux-x86_64" -o /tmp/bazel \
    && printf '%s  /tmp/bazel\n' "$BAZEL_SHA256" | sha256sum --check --status \
    && install -m 755 /tmp/bazel /usr/local/bin/bazel \
    && rm /tmp/bazel
WORKDIR /src
COPY source/ /src/
COPY recipe/ /recipe/
ARG SOURCE_COMMIT
ARG SOURCE_TAG
ARG SOURCE_TAG_OBJECT
ARG SOURCE_DATE_EPOCH
ARG RECIPE_COMMITTED
ARG RECIPE_COMMIT
ENV SOURCE_COMMIT=${SOURCE_COMMIT} SOURCE_TAG=${SOURCE_TAG} SOURCE_TAG_OBJECT=${SOURCE_TAG_OBJECT} \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} RECIPE_COMMITTED=${RECIPE_COMMITTED} RECIPE_COMMIT=${RECIPE_COMMIT}
# All state is container-owned. No Mac paths, home, keys, SSH agent, Docker
# socket, Git credentials, local rc files, or caches enter the source export.
RUN test ! -e .bazelrc.user && test "$(cat .bazelversion)" = "$BAZEL_VERSION" \
    && printf '%s\n' 'Phase: locked JavaScript dependencies.' \
    && bun install --frozen-lockfile --ignore-scripts
# Baseline ONLY: the existing GNU target builds x86-64-v2 with pinned Bazel
# Rust/Zig toolchains. Do not substitute the host Cargo or a musl/ARM addon.
RUN printf '%s\n' 'Phase: GNU amd64 baseline native addon.' \
    && bun scripts/bazel-natives.ts linux-x64-baseline --dest packages/natives/native -- --lockfile_mode=error
RUN printf '%s\n' 'Phase: embedding native/resources and compiling baseline Bun.' \
    && CROSS_TARGET=linux-x64 BUN_COMPILE_EXECUTABLE_PATH=/usr/local/bin/bun \
       bun packages/coding-agent/scripts/build-binary.ts \
    && mkdir /out \
    && install -m 755 packages/coding-agent/dist/omp-linux-x64 /out/omp-linux-amd64 \
    && python3 /recipe/linux-amd64-receipt.py create /out \
    && file /out/omp-linux-amd64
FROM scratch AS artifacts
COPY --from=build /out/omp-linux-amd64 /out/RELEASE_MANIFEST.json /out/SHA256SUMS.txt /
