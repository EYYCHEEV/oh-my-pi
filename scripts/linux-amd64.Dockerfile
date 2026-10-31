# All downloads are versioned and SHA-256 checked. The base is the official
# rust-lang/docker-rust nightly-trixie amd64 manifest, not a floating tag/index.
ARG BASE_IMAGE=rustlang/rust:nightly-2026-08-12@sha256:51dc497bff0c24777d2ec6a1fc12ddf7ab0483de3ee537f4ec10816b9e1eff6c
FROM --platform=linux/amd64 ${BASE_IMAGE} AS workspace
ARG BASE_IMAGE
ARG TARGETPLATFORM
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256=e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76
ARG BAZEL_VERSION=9.2.0
ARG BAZEL_SHA256=7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694
ARG DEBIAN_SNAPSHOT=20260813T000000Z
# No RUN in workspace: compilation must run in a separately bounded container
# when preparing a runtime, not in a default BuildKit worker without limits.
ARG WITNESS_RUN_ID
LABEL org.stronk.omp-witness=${WITNESS_RUN_ID}
ENV BASE_IMAGE=${BASE_IMAGE} TARGETPLATFORM=${TARGETPLATFORM} BUN_VERSION=${BUN_VERSION} BUN_SHA256=${BUN_SHA256} \
    BAZEL_VERSION=${BAZEL_VERSION} BAZEL_SHA256=${BAZEL_SHA256} DEBIAN_SNAPSHOT=${DEBIAN_SNAPSHOT} \
    RUSTUP_TOOLCHAIN=nightly-2026-08-12 HOME=/build-home \
    LC_ALL=C TZ=UTC BUN_INSTALL_CACHE_DIR=/build-home/bun-cache
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
# No host state, credentials, sockets or caches enter the immutable exports.
FROM workspace AS build
RUN /bin/bash /recipe/linux-amd64-build.sh build
FROM scratch AS artifacts
ARG WITNESS_RUN_ID
LABEL org.stronk.omp-witness=${WITNESS_RUN_ID}
COPY --from=build /out/omp-linux-amd64 /out/RELEASE_MANIFEST.json /out/SHA256SUMS.txt /
