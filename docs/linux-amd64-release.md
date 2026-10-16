# Fork-only Linux amd64 releases

The only fleet Linux release route is the Mac-controlled local build, qualification and publish-only commands in this guide.
The public repository is exactly `EYYCHEEV/oh-my-pi`, target `linux-amd64`, namespace `stronk-omp-s1-YYYY.MM.DD.NNNN`.
No upstream release, floating branch, latest-release lookup, ARM64 asset, legacy updater or existing-release backfill is a substitute.
The retained Actions workflow is unconditionally dormant and has no publishing permissions or tag trigger.
Keep fork Actions disabled.

## Approval and ownership

These scripts do not grant execution approval.
The operator separately owns approved builder/dependency capacity and cost, public trust enrollment, source/tag signing and pushes, qualification signing-key custody, repository immutability settings, and creation/upload/publication of the exact release.
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

The application pin is `5e43891a87140fb0972c982f3027f0228c4f6378`, version `18.8.0`.
It does not contain the new release tools.
`--recipe-commit` therefore binds a separate reviewed full Git commit containing the release route.
The builder exports application bytes only from `--commit` and recipe bytes only from `--recipe-commit`.
All route files named by `linux-amd64-receipt.py:RECIPES`, including preparation, qualification and publishing code, must match the invoked local copies byte for byte.
The manifest records both full commits and every recipe digest.
Application version, timestamp and lock digests are checked against the immutable application tree, not the current checkout.
Recipe digests are checked against the immutable recipe tree.
Dirty application files never enter either export.

Release building and publication require an existing SSH-signed annotated tag in the strict namespace, naming the exact application commit directly.
Lightweight tags, nested tags, mismatched internal names, untrusted signatures and recipe mismatches fail closed.
`--allowed-signers` is an explicitly supplied independently enrolled public allowed-signers file.
Supply the enrolled public revocation file with `--revoked-signers` when one applies.
Without that input the explicit deny-list is empty; the tools do not inherit a different Git revocation setting.
No trust file is created or updated, and source-tag verification never reads a private signing key.
The qualifier alone signs completion evidence using its explicitly supplied key after all checks pass.
Source signing and remote source/tag publication are separate approved operations.

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
Both candidate and release builds require `--docker-socket` with an explicit local Unix-socket endpoint.
Ambient Docker/context/buildx/BuildKit overrides are rejected before any daemon-capable subprocess.
Builds use `docker --host ... --config ... build`, with a fresh empty client configuration and only that daemon's default builder.
Named/saved builders are unsupported: there is no builder-selection option or saved-builder inspection.
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
SOURCE_COMMIT=5e43891a87140fb0972c982f3027f0228c4f6378
: "${BUILD_DOCKER_SOCKET:?bind the approved local Unix socket}"
: "${QUALIFY_DOCKER_SOCKET:?bind the approved native-amd64 local Unix socket}"
: "${QUALIFICATION_IMAGE:?bind the approved already-present image by digest}"
: "${ATTESTATION_KEY:?bind the explicitly approved qualification key}"
: "${QUALIFICATION_SIGNERS:?bind the independently enrolled qualification public signers}"
: "${CANDIDATE_ATTESTATION:?choose a new private evidence pathname outside dist}"
bash scripts/build-linux-amd64.sh \
  --commit "$SOURCE_COMMIT" --candidate --receipts \
  --docker-socket "$BUILD_DOCKER_SOCKET" \
  --output linux-amd64-candidate
python3 scripts/linux-amd64-receipt.py verify dist/linux-amd64-candidate \
  --commit "$SOURCE_COMMIT"
bash scripts/qualify-linux-amd64.sh \
  --commit "$SOURCE_COMMIT" --assets dist/linux-amd64-candidate \
  --docker-socket "$QUALIFY_DOCKER_SOCKET" --runtime-image "$QUALIFICATION_IMAGE" \
  --attestation-key "$ATTESTATION_KEY" --attestation "$CANDIDATE_ATTESTATION"
python3 scripts/linux-amd64-receipt.py verify dist/linux-amd64-candidate \
  --commit "$SOURCE_COMMIT" --attestation "$CANDIDATE_ATTESTATION" \
  --qualification-signers "$QUALIFICATION_SIGNERS"
```

Candidate mode uses the local recipe files and records `recipe_committed=false`, `recipe_commit=null`, with no source tag.
It cannot claim a committed release identity.
Qualification preserves this distinction: even a fully passing candidate is never publishable.
`--receipts` exports exactly `omp-linux-amd64`, `RELEASE_MANIFEST.json` and `SHA256SUMS.txt`.
Without it only the executable is copied out and the qualification/publication three-file interface is unavailable.

Qualification requires an independently approved, already present digest-pinned disposable runtime image or full local `sha256:` image ID, and a native amd64 local daemon.
Mac ARM64 emulation is not accepted as native qualification.
The image must contain the pinned Bun, frozen dependencies and prebuilt canonical native grep regression; preparing it is a separate approved step.
The full runtime-image reference is used only for local Docker selection and digest verification.
A registry digest is checked against the image's repository digests; a locally prepared image ID is checked against Docker's exact `.Id`, without inventing a repository digest or tag.
Only the verified `sha256:` digest enters the runtime request, result, public manifest or completion attestation; registry and account names never enter uploaded bytes.
Qualification never pulls an image, installs dependencies, resolves packages or compiles Rust.
The complete runtime-image layout/attestation contract is enforced by `linux-amd64-qualify.py`.
Use its fixed image paths and checked source/lock identities, not a host dependency or home mount.

Fresh qualification source exports and runtime-preparation source contexts are normalized after extraction: real directories are `0755`, and regular files are readable by all users without group/other write permission.
Existing executable bits are preserved, and the permission walk neither follows nor changes symlinks.
The host umask and private Docker client directories remain unchanged.

The prepared image contract is:

- Tools on `/usr/local/bin:/usr/bin:/bin`: Python 3.12+, GNU `timeout`/`getconf`, `readelf`, `/bin/sh`, and Bun `1.4.2` with executable SHA-256 equal to `build_inputs.host_tools.bun.sha256`.
- `/opt/omp-qualification/source`: exact application lock files and frozen `node_modules` directories in their original workspace layout, with real module-root directories and only relative links that remain inside that source tree.
- `/opt/omp-qualification/native-grep-regression`: the separately compiled GNU amd64 `pi-natives` libtest executable for this exact application/toolchain/lock tuple, with a qualification-only GNU libc 2.27 floor and explicit `x86-64-v2` CPU.
- `/opt/omp-qualification/dependencies.json`: exact keys `schema` (`1`), `source_commit`, `bun_version` (`1.4.2`), `locks` (the manifest's exact lock map), `dependency_tree_sha256`, `native_grep_sha256`.
- Compute `dependency_tree_sha256` using the committed qualifier's `dependency_digest(prepared_source)`; `native_grep_sha256` hashes the exact prebuilt executable.
- All fixed inputs must be readable/executable by container user `65532:65532`.

The canonical native grep test is `grep::tests::oversized_prefix_read_returns_stable_snapshot_after_rewrite`.
The qualifier runs its prepared libtest executable with that exact selector and `--exact`, requiring exactly one passed test instead of invoking Cargo and silently compiling.
The runtime limits are four CPUs, 12 GiB memory with no additional swap, 1024 processes, and private tmpfs capacities of 8 GiB workspace, 1 GiB runtime, 1 GiB home and 2 GiB temporary state.
Only `/workspace` and `/runtime` explicitly enable `exec`, allowing application execution and native mappings; all four tmpfs mounts retain `nosuid`, `nodev`, size limits and mode `1777`.
Before launching the CLI, qualification creates the `omp` namespace beneath its XDG data directory on the executable runtime tmpfs.
The native loader selects that directory only when the namespace already exists; otherwise it falls back to the non-executable home mount and Linux refuses to map the extracted addon.
The home and general temporary mounts remain non-executable; no broader mount permission is needed.
Individual commands have deadlines and the container smoke has a 3500-second whole-run deadline, bounded by the host's 3600-second client deadline.
Expiry or any failed assertion leaves qualification unsuccessful and the owned container is forcibly removed.

The run is offline, read-only except private disposable tmpfs state, without capabilities, with no-new-privileges and bounded process/memory/CPU/command limits.
The runtime home and all caches start empty and credential-free.
It exercises version/help, baseline-only native extraction/loading, native digest/ELF compatibility, embedded resource/worker operations through the built-in smoke, an initialized offline RPC session, every active fork-boundary command, the canonical native grep regression and coding-agent typecheck.
The active regression snapshot is recipe-authenticated, tied to its canonical registry digest, and compared with the immutable application's README contract IDs.
Missing, stale, failed or timed-out checks cannot become successful metadata.
Qualification regenerates the HTML tool-view bundle from the immutable source and verified frozen dependencies before running source tests.
The pristine source export deliberately excludes build-generated files; the active compiled-CLI boundary test needs this local JavaScript bundle.
This step and that test's temporary Bun compilation run offline with the pinned Bun; neither invokes Cargo or resolves packages.
Raw runtime/test logs stay inside the disposable environment; only the allowlisted result and fixed qualification stage IDs are returned.
Each step announces one `qualify-...` ID from the qualifier's closed stage list, including the boundary ID and one-based command number for source tests.
The runtime stage channel accepts only exact allowlisted IDs, not error messages, paths or command output; malformed or unknown text fails closed.

This is a standalone distribution layout, not a fully statically linked executable.
Both the executable and extracted addon require compatible GNU libc, its loader and system libraries.
The native floor is x86-64-v2, not AVX2; the runtime records the actual qualified libc/loader baseline.
A writable executable extraction cache is required.
Optional ML models/packages remain on-demand inputs and are not promised offline.

### Preparing a bounded, one-time native witness

This is a separately approved preparation step, not permission to execute it on any shared host.
`linux-amd64-runtime.py` uses the same exact application archive, pinned base, signed Debian snapshot, Bun archive checksum and Bazel/Rust graph as the ordinary candidate recipe.
Supply the full reviewed preparation commit with `--recipe-commit`; this checks the invoked route files but does not turn the resulting candidate into a release.
All generated workspace/runtime images and build/qualification containers carry `org.stronk.omp-witness=<run-id>`.
The downloaded immutable parent base is not relabeled or deleted.

```sh
python3 scripts/linux-amd64-runtime.py \
  --commit 5e43891a87140fb0972c982f3027f0228c4f6378 \
  --recipe-commit "$RECIPE_COMMIT" \
  --docker-socket unix:///var/run/docker.sock \
  --witness-run-id "$RUN_ID" --output witness-candidate \
  --image-id-file "$PRIVATE_SCRATCH/runtime-image-id"
```

The default builder only assembles a workspace image without executing `RUN` instructions.
All dependency installation, downloads and compilation run in a dedicated container limited to four CPUs, 24 GiB memory with no additional swap, and 1024 processes.
This avoids pretending that BuildKit honors legacy `docker build --memory` flags.
No host directory, signing key, Docker socket, credential, or home is mounted into that container.
The shared build script keeps the shipped addon and `omp-linux-amd64` on the application's GNU libc 2.17 baseline recipe.
Only the canonical Bazel `//crates/pi-natives:pi_natives_test` build and matching output query use `--platforms=@zig_sdk//platform:linux_amd64`, `--extra_toolchains=@zig_sdk//toolchain:linux_amd64_gnu.2.27`, host-first `--extra_execution_platforms=@bazel_tools//tools:host_platform,@zig_sdk//platform:linux_amd64`, and explicit `-Ctarget-cpu=x86-64-v2`, preserving the pinned Zig/Rust toolchain, locked graph, optimization and thin LTO.
The complete libtest harness needs GNU libc 2.27 because an unrelated Wayland test imports `memfd_create`; selecting the grep test at runtime cannot remove that link dependency.
This qualification-only executable proves the grep logic, not GNU libc 2.17 compatibility, and must never be described as supporting that older runtime.
The shipped executable and extracted addon are actually loaded and exercised separately during qualification; the recorded runtime facts describe that environment, not a test on every older libc.
The preparation image retains the pinned base's GNU library closure and validates the exact standalone libtest selector.
A pristine application tree is captured before build-generated files can change it, then populated only with the frozen dependency trees.
The dependency metadata uses the qualifier's own tree digest and verifies the Bun executable against the candidate receipt.
The resulting stopped-container snapshot is a local image ID, not a fabricated registry digest.
Its normal user is `65532:65532`, and it is consumed by the existing offline qualifier with `--witness-run-id "$RUN_ID"`.

`linux-amd64-witness.py preflight` records only allowlisted Docker product facts, image IDs, disk/cache usage and the approved source-host prerequisites in a new private scratch evidence file.
It refuses fact drift, an existing run label, less than 884 decimal GB free on `/`, less than 200 GiB free on Docker storage, less than 32 GiB available host memory (leaving 8 GiB beyond the build cap), host Bun/Node, remote transport and ambient Docker overrides.
The Docker reserve exceeds the 120-GiB upper disk estimate by 80 GiB; the estimate is not a writable-layer quota.

The phase-1 scratch copies of `linux-amd64-witness.py` and `linux-amd64-receipt.py` own recovery even if the repository checkout is incomplete.
With the standard `--scratch`, `--run-id` and explicit local `--docker-socket` inputs, the witness commands are:

| Command | Contract |
| --- | --- |
| `start --recipe-commit "$RECIPE_COMMIT"` | Submits the whole prepare, candidate-verify, qualify and signed-verify chain as the transient system service `omp-witness-<run-id>.service`. Refuses any existing unit of that name; systemd also rejects a concurrent name collision. The scratch working directory, fixed `env -i` environment and null stdin/stdout/stderr exclude SSH streams, journald output and raw logs. |
| `status` | Read-only, path-free `systemctl show` state plus allowlisted progress and terminal status. Exit zero requires terminal `success` and an absent or cleanly inactive unit; a gone unit without success is failure, never permission for handoff or another build. |
| `stop` | Uses `systemctl stop` for that exact unit, with systemd control-group termination and a 180-second stop deadline. The worker handles SIGTERM by stopping independently label-checked run containers before recording failure. Stop never fabricates terminal evidence; abort removes leftovers if the worker cannot finish. |
| `cleanup` | Requires terminal success and the Mac verification acknowledgment before any Docker query or removal. |
| `abort` | Requires the preflight baseline and an inactive, failed or absent unit, including failed submission or abrupt worker death without terminal evidence. Never needs or creates a Mac acknowledgment, never prunes cache, and preserves scratch, evidence and key. |
| `retire` | Explicitly deletes only the validated private scratch directory after a valid cleanup or abort record. Preserve that record and required evidence on the Mac first; abort itself does not authorize retirement. |

Systemd is the sole lifecycle owner: Type=exec, Restart=no, KillMode=control-group, TimeoutStopSec=180s, RuntimeMaxSec=9h and UMask=0077.
No detached session, PID file, process-group identity or job-request record is used.
Fixed private scratch records are immutable allowlisted milestones under `job-progress/`, `job-terminal.json`, and, only on failure, `job-failure.json`.
The terminal record is exactly one `success` with exit code zero, or `failed:<phase>` with a nonzero exit code; only the job itself writes it as its last lifecycle step.
Every helper JSON record is written to a private temporary file, flushed and fsynced, then published atomically by a no-overwrite hard link and directory fsync.
Pollers therefore never see an incomplete final record.
The failure record is mode `0600` inside the existing root-owned mode-`0700` scratch directory and contains exactly `{schema, run_id, stage}` with schema `1`.
Its stage is the last validated qualification ID, or the fixed lifecycle phase if qualification had not announced one.
The witness validates qualification IDs against the checked-out recipe's own allowlist; raw diagnostics are never persisted or echoed.
Successful jobs write no failure record, and `status` and existing progress lines are unchanged.
Preserve the failure record before separately approved scratch retirement when investigating a failed witness.
Status selects only LoadState, ActiveState, SubState, Result and ExecMainStatus, validates the fields and prints no paths.
Successful transient units unload normally; cleanup/abort reset only the exact failed unit with `systemctl reset-failed` and confirm that no unit remains.
No unit is enabled, persisted or written by the helper.
Existing workspace-export, four-hour preparation, snapshot and qualification deadlines and container resource limits remain intact.
GNU timeout enforces the additional 21600/900/5400/900-second child ceilings without Python process/group signaling.
An SSH drop changes none of this state: reconnect and poll `status`, never restart the build.

Both cleanup branches recheck every container/image label and preserve the initial image inventory.
Image removal is newest-first, never forced, and always uses `docker image rm --no-prune` so no unchecked parent is removed implicitly.
They never delete a separately registered pinned base or require BuildKit's cached base to be registered as a Docker image.
Only successful `cleanup` may prune default-builder cache, and only when preflight proved it was initially empty and no unexpected Docker state appeared.
Otherwise cache is preserved and its remaining size recorded; abort always preserves it.
Use an exclusive Docker maintenance window for this batch because shared default-builder cache has no per-witness ownership boundary.
The helpers never contact a remote machine, provision a builder, change daemon settings/networks, create tags, publish, or install Bun/Node on the host.
The private operator batch owns bundle transfer, dedicated one-time key generation outside containers, public-key return, local attestation verification and separate scratch retirement.
Mac-side path-bearing commands discard both streams and preserve exit status, including shell redirection errors; comparisons use `cmp -s`, and only fixed path-free messages escape.
The SSH/SCP functions own their fixed noninteractive authentication, strict host-key, disabled host-key-update and quiet options, including in a fresh recovery shell.
Any failed phase stops the success path; use the explicit approved abort branch to recover without changing inputs, fabricating verification, rebuilding or working around a download failure.


## Release build and mandatory qualification

Qualification also requires `ssh-keygen`, an explicit noninteractive private `--attestation-key`, and a new private `--attestation` output pathname outside the three-file asset directory.
There is no default key, key discovery or SSH-agent lookup; the key and signature are never mounted into the container.
After successful checks and a recheck of the unchanged host tuple, the qualifier finalizes canonical public JSON and signs a canonical local attestation using `ssh-keygen -Y sign -n stronk-omp-qualification`.
It writes the attestation and adjacent `<attestation>.sig` as new mode-0600 files, never overwriting earlier evidence.
Signing failure is not qualification success; metadata alone cannot authorize publication.

The exact attestation fields are `schema` (`1`), `binary_sha256`, `source_commit`, `recipe_commit`, `runtime_image_digest`, `mode` (`candidate` or `release`), `checks`, and `manifest_sha256`.
The manifest digest hashes canonical public manifest bytes, without an embedded attestation: ASCII-escaped JSON with sorted keys, compact separators, no non-finite numbers and one final newline.
The check map must contain every required check as `passed`.
Candidates bind `recipe_commit=null` and `mode=candidate`; relabeling one invalidates its evidence.
Protect the qualification key independently from untrusted asset producers, and enroll its public key separately before use.
The publisher requires an explicit `--qualification-signers` allowed-signers file for principal `stronk-omp-qualification`, with namespace `stronk-omp-qualification`.
The attestation and signature are private local publisher inputs, not a fourth or fifth public release asset or an alternative fleet trust root.

After review, trust/signing readiness and separate tag approval, use the full reviewed recipe commit and already signed local source tag:

```sh
: "${RECIPE_COMMIT:?bind the full reviewed release-route commit}"
: "${RELEASE_TAG:?bind the already signed exact source tag}"
: "${RELEASE_ATTESTATION:?choose a new private evidence pathname outside dist}"
bash scripts/build-linux-amd64.sh \
  --commit "$SOURCE_COMMIT" --recipe-commit "$RECIPE_COMMIT" --tag "$RELEASE_TAG" \
  --allowed-signers "$ALLOWED_SIGNERS" --revoked-signers "$REVOKED_SIGNERS" \
  --docker-socket "$BUILD_DOCKER_SOCKET" \
  --receipts --output linux-amd64-release
bash scripts/qualify-linux-amd64.sh \
  --commit "$SOURCE_COMMIT" --recipe-commit "$RECIPE_COMMIT" \
  --assets dist/linux-amd64-release \
  --docker-socket "$QUALIFY_DOCKER_SOCKET" --runtime-image "$QUALIFICATION_IMAGE" \
  --attestation-key "$ATTESTATION_KEY" --attestation "$RELEASE_ATTESTATION"
python3 scripts/linux-amd64-receipt.py verify dist/linux-amd64-release \
  --commit "$SOURCE_COMMIT" --recipe-commit "$RECIPE_COMMIT" --tag "$RELEASE_TAG" --release \
  --attestation "$RELEASE_ATTESTATION" --qualification-signers "$QUALIFICATION_SIGNERS"
```

Building alone leaves runtime/regression checks at `not_run`.
Only successful qualification of the exact binary/source/recipe tuple finalizes the allowlisted check summary and regenerates both metadata files.
Release CLI verification and publication refuse missing, incomplete, unauthenticated or mismatched qualification.
No native/build/publication witness is implied by implementation or offline fixture success.

## Public manifest schema 2

The manifest's exact top-level fields are `schema`, `repository`, `target`, `version`, `source`, `build_inputs`, `asset`, `runtime`, `checks`, `qualification`.
Nested objects reject unknown fields, and one strict JSON decoder rejects repeated keys at every depth in every manifest, qualification result, attestation and other route JSON read.
`source` records full application/tag/tag-object identities, source timestamp, recipe status and full recipe commit.
`build_inputs` records fixed image/snapshot/archive pins, tool versions and executable hashes, system-package inventory digest, immutable source-lock digests and all eight recipe digests.
`asset` records the binary basename, size and SHA-256.
`runtime` records ELF target, loader basename, libc floor, required sonames, baseline addon digest and CPU/variant/static-link contract.
`checks` requires all of `elf`, `cli`, `native_runtime`, `resources_workers`, `builtin_smoke`, `offline_session`, `fork_boundaries`, `native_grep`, `coding_agent_typecheck` to be `passed` for release.
`qualification` binds the actual binary SHA-256, application and recipe commits, the same complete check set, and only `execution`, `cpu`, `glibc`, `loader`, `runtime_image` as environment fields.
It is `null` before qualification.
`qualification.environment.runtime_image` is strictly the verified `sha256:` digest, never a registry/repository/account reference.

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
  --attestation "$RELEASE_ATTESTATION" --qualification-signers "$QUALIFICATION_SIGNERS" \
  --immutability-witness "$IMMUTABILITY_WITNESS" --pins "$NEW_PIN_RECORD" --publish
```

Without explicit `--publish` the helper refuses before any mutation, rather than leaving a draft.
It validates the signed source, committed recipes, complete qualification and public schema, then verifies the exact completion binding with `ssh-keygen -Y verify` against the explicit qualification signers, fixed principal and namespace before any GitHub call.
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

The regression fixtures use fakes for Docker/build/GitHub and generate only throwaway SSH keys inside temporary directories for real local signing and verification.
They never use real keys, build, pull images, install, create tags, publish, contact deployment machines or run the normal publisher against GitHub.
They cover duplicate JSON keys with valid checksums/signatures, digest-only runtime privacy, consistent receipt forgery, candidate relabeling, missing/wrong completion signatures and bindings, immutable inputs, tag trust/shape, pre-contact endpoint rejection, exact executable tmpfs options, release reuse and read-back failures.
Fixture success is not a native execution witness; actual tmpfs execution and prepared-runtime qualification remain separately approved work.

## References

- [Git signed-tag verification](https://git-scm.com/docs/git-verify-tag).
- [GitHub immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases#immutable-releases).
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases).
- [Bun 1.4.2 official release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2).
- [Bazel 9.2.0 official release](https://github.com/bazelbuild/bazel/releases/tag/9.2.0).
