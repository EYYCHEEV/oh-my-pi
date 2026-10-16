# Fork-only Linux amd64 releases

The only fleet Linux release route is the Mac-controlled local build, qualification and publish-only commands in this guide.
The public repository is exactly `EYYCHEEV/oh-my-pi`, target `linux-amd64`, namespace `stronk-omp-s1-YYYY.MM.DD.NNNN`.
No upstream release, floating branch, latest-release lookup, ARM64 asset, legacy updater or existing-release backfill is a substitute.
The retained Actions workflow is unconditionally dormant and has no publishing permissions or tag trigger.
Keep fork Actions disabled.

## Approval and ownership

These scripts do not grant execution approval.
The operator separately owns approved builder/dependency capacity and cost, public trust enrollment, source/tag signing and pushes, repository immutability settings, and creation/upload/publication of the exact release.
No script provisions a builder, changes Docker contexts, creates keys/trust stores, changes GitHub settings, pushes, installs a runtime, contacts a deployment host, or restarts a service.
Use only the existing approved GitHub credential mechanism; never pass a token in an argument or add broader credentials as a fallback.

The publisher owns only a new release's draft/upload/read-back/publish/read-back transaction.
The workstation cohort owner later authenticates the resulting public pins with its signed fleet lock.
The future fleet puller verifies and stages; only the operator activates.
A source-tag signature does not authenticate binary assets attached afterward, and an adjacent unsigned checksum is not an independent trust root.

GitHub immutability affects future releases repository-wide, including ordinary Mac releases.
Before separately approving a setting change, establish compatibility of the Mac publisher with complete-asset drafts and immutable publication.
This route neither modifies the legacy updater nor repairs old releases.

## Exact application and independent recipe

The application pin remains `dd8d9785aa36b5b072817a089177030b1b3519df`, version `18.8.0`.
It does not contain the new release tools.
`--recipe-commit` therefore binds a separate reviewed full Git commit containing the release route.
The builder exports application bytes only from `--commit` and recipe bytes only from `--recipe-commit`.
All eight route files, including qualification and publishing code, must match the invoked local copies byte for byte.
The manifest records both full commits and every recipe digest.
Application version, timestamp and lock digests are checked against the immutable application tree, not the current checkout.
Recipe digests are checked against the immutable recipe tree.
Dirty application files never enter either export.

Release building and publication require an existing SSH-signed annotated tag in the strict namespace, naming the exact application commit directly.
Lightweight tags, nested tags, mismatched internal names, untrusted signatures and recipe mismatches fail closed.
`--allowed-signers` is an explicitly supplied independently enrolled public allowed-signers file.
Supply the enrolled public revocation file with `--revoked-signers` when one applies.
Without that input the explicit deny-list is empty; the tools do not inherit a different Git revocation setting.
No trust file is created or updated and no private signing key is read by the release helpers.
Signing and remote source/tag publication are separate approved operations.

## Pinned build inputs and isolation

| Input | Exact selection and integrity |
| --- | --- |
| Base | Official Rust amd64 manifest `rustlang/rust:nightly-2026-08-12@sha256:51dc497bff0c24777d2ec6a1fc12ddf7ab0483de3ee537f4ec10816b9e1eff6c` |
| Bun compiler/runtime/template | `1.4.2`, baseline archive SHA-256 `c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f` |
| Bazel | `9.2.0`, Linux executable SHA-256 `7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694` |
| System packages | Signed Debian trixie snapshot `20260813T000000Z`; TLS/package signature checks retained |
| JavaScript | Immutable application `bun.lock`, frozen install with lifecycle scripts disabled |
| Shipping native graph | Immutable application Cargo/Bazel manifests and locks, Bazel `--lockfile_mode=error` |

The base's host compiler is not the shipping native compiler.
The selected application's Bazel graph owns the shipping Rust toolchain, `nightly/2026-10-06`, and hermetic C/C++ inputs.
The selected Cargo.lock SHA-256 is `3130bf9a1315298827a222730a299f687c86a3f9f9306ae3a099b0fbc496d3c1`, matching its Bazel lock.
Do not repair or use the retired source branch to make this build pass.
Pinned inputs support repeatability; byte-for-byte reproducibility of two completed Bun builds has not been demonstrated.

Build prerequisites are Bash, Git, Python 3.12+, and an existing approved local Docker/buildx installation.
Both candidate and release builds require `--docker-socket` with an explicit local Unix-socket endpoint and `--builder` naming an already approved builder.
Ambient Docker/context/buildx/BuildKit overrides are rejected before a daemon is queried.
The builder must have exactly one running node bound to that same local socket, with the local Docker or Docker-container driver.
No remote endpoint inventory is printed or recorded, and no builder/context is created, bootstrapped or changed.

Only committed application data and the selected recipes enter the disposable build context.
No home, signing material, SSH agent, credential store, Docker socket, local configuration or host cache is mounted into the build.
Only the GNU baseline addon is built and embedded, even on an AVX2-capable machine.
Outputs go to a fresh non-overwriting child of `dist/`; symlinked `dist` and existing outputs are refused.
Normal BuildKit layers may remain; the helper never prunes shared caches.
Only known phase names are printed, never raw build logs.

## Candidate build and qualification

After the applicable build approval, choose a fresh output name and approved local transport inputs:

```sh
SOURCE_COMMIT=dd8d9785aa36b5b072817a089177030b1b3519df
bash scripts/build-linux-amd64.sh \
  --commit "$SOURCE_COMMIT" --candidate --receipts \
  --docker-socket "$BUILD_DOCKER_SOCKET" --builder "$APPROVED_BUILDER" \
  --output linux-amd64-candidate
python3 scripts/linux-amd64-receipt.py verify dist/linux-amd64-candidate \
  --commit "$SOURCE_COMMIT"
bash scripts/qualify-linux-amd64.sh \
  --commit "$SOURCE_COMMIT" --assets dist/linux-amd64-candidate \
  --docker-socket "$QUALIFY_DOCKER_SOCKET" --runtime-image "$QUALIFICATION_IMAGE"
```

Candidate mode uses the local recipe files and records `recipe_committed=false`, `recipe_commit=null`, with no source tag.
It cannot claim a committed release identity.
Qualification preserves this distinction: even a fully passing candidate is never publishable.
`--receipts` exports exactly `omp-linux-amd64`, `RELEASE_MANIFEST.json` and `SHA256SUMS.txt`.
Without it only the executable is copied out and the qualification/publication three-file interface is unavailable.

Qualification requires an independently approved, already present digest-pinned disposable runtime image and a native amd64 local daemon.
Mac ARM64 emulation is not accepted as native qualification.
The image must contain the pinned Bun, frozen dependencies and prebuilt canonical native grep regression; preparing it is a separate approved step.
Qualification never pulls an image, installs dependencies, resolves packages or compiles Rust.
The complete runtime-image layout/attestation contract is enforced by `linux-amd64-qualify.py`.
Use its fixed image paths and checked source/lock identities, not a host dependency or home mount.

The prepared image contract is:

- Tools on `/usr/local/bin:/usr/bin:/bin`: Python 3.12+, GNU `timeout`/`getconf`, `readelf`, `/bin/sh`, and Bun `1.4.2` with executable SHA-256 equal to `build_inputs.host_tools.bun.sha256`.
- `/opt/omp-qualification/source`: exact application lock files and frozen `node_modules` directories in their original workspace layout, with real module-root directories and only relative links that remain inside that source tree.
- `/opt/omp-qualification/native-grep-regression`: the separately compiled GNU amd64 `pi-natives` libtest executable for this exact application/toolchain/lock tuple.
- `/opt/omp-qualification/dependencies.json`: exact keys `schema` (`1`), `source_commit`, `bun_version` (`1.4.2`), `locks` (the manifest's exact lock map), `dependency_tree_sha256`, `native_grep_sha256`.
- Compute `dependency_tree_sha256` using the committed qualifier's `dependency_digest(prepared_source)`; `native_grep_sha256` hashes the exact prebuilt executable.
- All fixed inputs must be readable/executable by container user `65532:65532`.

The canonical native grep test is `grep::tests::oversized_prefix_read_returns_stable_snapshot_after_rewrite`.
The qualifier runs its prepared libtest executable with that exact selector and `--exact`, requiring exactly one passed test instead of invoking Cargo and silently compiling.
The runtime limits are four CPUs, 12 GiB memory with no additional swap, 1024 processes, and private tmpfs capacities of 8 GiB workspace, 1 GiB runtime, 1 GiB home and 2 GiB temporary state.
Individual commands have deadlines and the container smoke has a 3500-second whole-run deadline, bounded by the host's 3600-second client deadline.
Expiry or any failed assertion leaves qualification unsuccessful and the owned container is forcibly removed.

The run is offline, read-only except private disposable tmpfs state, without capabilities, with no-new-privileges and bounded process/memory/CPU/command limits.
The runtime home and all caches start empty and credential-free.
It exercises version/help, baseline-only native extraction/loading, native digest/ELF compatibility, embedded resource/worker operations through the built-in smoke, an initialized offline RPC session, every active fork-boundary command, the canonical native grep regression and coding-agent typecheck.
The active regression snapshot is recipe-authenticated, tied to its canonical registry digest, and compared with the immutable application's README contract IDs.
Missing, stale, failed or timed-out checks cannot become successful metadata.
Raw runtime/test logs stay inside the disposable environment; only the allowlisted result is returned.

This is a standalone distribution layout, not a fully statically linked executable.
Both the executable and extracted addon require compatible GNU libc, its loader and system libraries.
The native floor is x86-64-v2, not AVX2; the runtime records the actual qualified libc/loader baseline.
A writable executable extraction cache is required.
Optional ML models/packages remain on-demand inputs and are not promised offline.

## Release build and mandatory qualification

After review, trust/signing readiness and separate tag approval, use the full reviewed recipe commit and already signed local source tag:

```sh
bash scripts/build-linux-amd64.sh \
  --commit "$SOURCE_COMMIT" --recipe-commit "$RECIPE_COMMIT" --tag "$RELEASE_TAG" \
  --allowed-signers "$ALLOWED_SIGNERS" --revoked-signers "$REVOKED_SIGNERS" \
  --docker-socket "$BUILD_DOCKER_SOCKET" --builder "$APPROVED_BUILDER" \
  --receipts --output linux-amd64-release
bash scripts/qualify-linux-amd64.sh \
  --commit "$SOURCE_COMMIT" --recipe-commit "$RECIPE_COMMIT" \
  --assets dist/linux-amd64-release \
  --docker-socket "$QUALIFY_DOCKER_SOCKET" --runtime-image "$QUALIFICATION_IMAGE"
python3 scripts/linux-amd64-receipt.py verify dist/linux-amd64-release \
  --commit "$SOURCE_COMMIT" --recipe-commit "$RECIPE_COMMIT" --tag "$RELEASE_TAG" --release
```

Building alone leaves runtime/regression checks at `not_run`.
Only successful qualification of the exact binary/source/recipe tuple finalizes the allowlisted check summary and regenerates both metadata files.
The release verifier refuses missing or incomplete qualification.
No native/build/publication witness is implied by implementation or offline fixture success.

## Public manifest schema 2

The manifest's exact top-level fields are `schema`, `repository`, `target`, `version`, `source`, `build_inputs`, `asset`, `runtime`, `checks`, `qualification`.
Nested objects also reject unknown fields.
`source` records full application/tag/tag-object identities, source timestamp, recipe status and full recipe commit.
`build_inputs` records fixed image/snapshot/archive pins, tool versions and executable hashes, system-package inventory digest, immutable source-lock digests and all eight recipe digests.
`asset` records the binary basename, size and SHA-256.
`runtime` records ELF target, loader basename, libc floor, required sonames, baseline addon digest and CPU/variant/static-link contract.
`checks` requires all of `elf`, `cli`, `native_runtime`, `resources_workers`, `builtin_smoke`, `offline_session`, `fork_boundaries`, `native_grep`, `coding_agent_typecheck` to be `passed` for release.
`qualification` binds the actual binary SHA-256, application and recipe commits, the same complete check set, and only `execution`, `cpu`, `glibc`, `loader`, `runtime_image` as environment fields.
It is `null` before qualification.

The manifest hashes the binary, not itself.
`SHA256SUMS.txt` hashes the binary and finalized manifest, not itself.
The later signed workstation lock authenticates all three final digests, without a metadata hash cycle.
No local account, machine identity, address, local path, environment dump, raw log, private receipt, rollback card or raw API response belongs in these public assets.
Extra assets, private fields, altered bytes, wrong ELF targets and mismatched immutable inputs fail closed.

## Publish only, never install

Do not invoke this command before explicit approval for the exact new draft, three uploads and immutable publication.
The signed source tag must already exist remotely under its separately approved push.
Supply a recent administrator-approved public immutability witness, not a token or raw API response:

```json
{"repository":"EYYCHEEV/oh-my-pi","enabled":true,"observed_at":"2026-10-16T00:00:00Z"}
```

The example is a schema illustration, not a current setting witness.
The publisher requires a fresh UTC observation within 24 hours and does not create, refresh or change this witness or the repository setting.
After all prerequisites and exact execution approval:

```sh
bash scripts/publish-linux-amd64.sh \
  --commit "$SOURCE_COMMIT" --recipe-commit "$RECIPE_COMMIT" --tag "$RELEASE_TAG" \
  --assets dist/linux-amd64-release \
  --allowed-signers "$ALLOWED_SIGNERS" --revoked-signers "$REVOKED_SIGNERS" \
  --immutability-witness "$IMMUTABILITY_WITNESS" --pins "$NEW_PIN_RECORD" --publish
```

Without explicit `--publish` the helper refuses before any mutation, rather than leaving a draft.
It validates the signed source, committed recipes, complete qualification and public schema before any GitHub call.
It snapshots the exact three approved files privately, refuses an existing release or draft, checks the existing remote annotated tag/direct commit, creates one new draft and uploads exactly three assets without clobber.
It reads draft identities and downloads by recorded asset IDs, comparing all sizes/hashes with the snapshot before publishing.
Both creation and publication explicitly set `make_latest=false`; this fleet release does not replace the ordinary Mac release's latest marker.
After publication it requires the same exact release/tag/asset identities, `draft=false`, `prerelease=false`, `immutable=true`, uploaded asset states, unchanged remote tag-object/direct commit and independently downloaded sizes/hashes for all three assets.
Downloads use the approved `gh` authentication/redirect handling; no credential header or signed redirect is logged or manually forwarded to another origin.
Only then is the new local public pin record written.
The pin pathname is reserved as a new private file before remote access; failure leaves an empty reservation, which is not successful handoff evidence.
A failure never deletes a draft, replaces an asset, moves a tag, repairs a published release or automatically retries publication.
A failed published read-back blocks cohort publication and leaves incident handling with the operator.

## Public pin record and rollback handoff

The exact record fields are `schema`, `repository`, `tag`, `tag_object`, `commit`, `recipe_commit`, `target`, `release_id`, `assets`.
`assets` has exactly three entries, each containing only `id`, `name`, `size`, `sha256`.
All object identities are full Git OIDs, all IDs/sizes are positive integers and all hashes are SHA-256.
The record is local public-field handoff evidence, not an uploaded fourth artifact or independent discovery channel.
It feeds the existing `deploy/s1/fleet.lock.json` design after Sentinel and OMP read-back, before the separately signed workstation cohort tag.

Keep previous immutable releases and rollback bytes unchanged.
Corrections use new signed versions.
The later activation/rollback phase retains the active cohort plus three previously activated cohorts, staged/in-use/held generations and required offline inputs.
Publication never selects a runtime, activates a generation, changes Sentinel or restarts a consumer.
Demonstrating fleet activation/offline rollback belongs to that separately approved phase.

## Offline route checks

```sh
bash -n scripts/build-linux-amd64.sh scripts/qualify-linux-amd64.sh scripts/publish-linux-amd64.sh scripts/linux-amd64-smoke.sh
python3 -m py_compile scripts/linux-amd64-receipt.py scripts/linux-amd64-qualify.py scripts/linux-amd64-publish.py
python3 -m unittest discover -s scripts -p 'test_linux_amd64*.py'
```

The regression fixtures use fakes and do not build, pull images, install, sign, create tags, publish, contact deployment machines or run the normal publisher against GitHub.
They cover immutable input mismatch, tag trust/shape, local endpoint binding, public field/asset allowlists, incomplete qualification, altered bytes, reused release/draft, immutability and read-back identity failures, and absence of install/SSH/service side effects.

## References

- [Git signed-tag verification](https://git-scm.com/docs/git-verify-tag).
- [GitHub immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#immutable-releases).
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases).
- [Bun 1.4.2 official release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2).
- [Bazel 9.2.0 official release](https://github.com/bazelbuild/bazel/releases/tag/9.2.0).
