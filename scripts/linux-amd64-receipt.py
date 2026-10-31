#!/usr/bin/env python3
"""Allowlisted Linux release provenance and shared local trust boundaries."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
from shutil import which
import stat
import struct
import subprocess
import tarfile
import tempfile

REPOSITORY = "EYYCHEEV/oh-my-pi"
# The application commit is an input, never a constant. Toolchain pins below are the recipe's own.
BUN_VERSION = "1.4.4"
BAZEL_VERSION = "9.2.0"
ASSETS = ("omp-linux-amd64", "RELEASE_MANIFEST.json", "SHA256SUMS.txt")
RECIPES = ("build-linux-amd64.sh", "linux-amd64.Dockerfile", "linux-amd64-receipt.py",
           "qualify-linux-amd64.sh", "linux-amd64-qualify.py", "linux-amd64-smoke.sh",
           "publish-linux-amd64.sh", "linux-amd64-publish.py",
           "linux-amd64-build.sh", "linux-amd64-runtime.py")
LOCKS = ("bun.lock", "Cargo.lock", "MODULE.bazel", "MODULE.bazel.lock", "rust-toolchain.toml", ".bazelversion")
TOOLS = ("bun", "bazel", "rustc", "cargo", "cmake", "ninja")
CHECKS = ("elf", "cli", "native_runtime", "resources_workers", "builtin_smoke", "offline_session",
          "fork_boundaries", "native_grep", "coding_agent_typecheck")
HEX = r"[0-9a-f]{64}"
OID = r"[0-9a-f]{40}"
TAG = r"stronk-omp-s1-[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{4}"
DIGEST = r"sha256:" + HEX
IMAGE = r"[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]+)?@sha256:" + HEX
BASE_IMAGE = "rustlang/rust:nightly-2026-08-12@sha256:51dc497bff0c24777d2ec6a1fc12ddf7ab0483de3ee537f4ec10816b9e1eff6c"
BUN_SHA256 = "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76"
BAZEL_SHA256 = "7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694"
ATTESTATION_NAMESPACE = "stronk-omp-qualification"
ATTESTATION_IDENTITY = "stronk-omp-qualification"


class RouteError(ValueError):
    """A fixed, path-free refusal that is safe to show to the caller."""


def require(condition, message):
    if not condition:
        raise RouteError(message)


def strict_json(data):
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, "Repeated JSON key")
            value[key] = item
        return value
    return json.loads(data, object_pairs_hook=unique_object)


def canonical_json(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode()


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            result.update(chunk)
    return result.hexdigest()


def capture(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, text=True, timeout=60)


def git_bytes(root, rev, path):
    require(match(OID, rev), "A full immutable Git object is required")
    return subprocess.check_output(["git", "-C", str(root), "show", f"{rev}:{path}"],
                                   stderr=subprocess.DEVNULL, timeout=60)


def commit_exists(root, commit):
    require(match(OID, commit), "A full commit is required")
    require(capture("git", "-C", str(root), "rev-parse", "--verify", f"{commit}^{{commit}}").strip() == commit,
            "Wrong commit object")


def git_has(root, rev, path):
    require(match(OID, rev), "A full immutable Git object is required")
    return subprocess.run(["git", "-C", str(root), "cat-file", "-e", f"{rev}:{path}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False).returncode == 0


def bun_requirement(spec):
    # Only an exact pin or a ">=" floor can be judged; anything else fails closed.
    require(match(r"(?:>=)?[0-9]+\.[0-9]+(?:\.[0-9]+)?", spec),
            "The application's Bun requirement is neither an exact pin nor a floor; a new recipe commit is required")
    numbers = tuple(int(part) for part in spec.removeprefix(">=").split("."))
    pinned = tuple(int(part) for part in BUN_VERSION.split("."))
    if spec.startswith(">="):
        satisfied = pinned >= numbers
    else:
        satisfied = pinned == numbers + (0,) * (len(pinned) - len(numbers))
    require(satisfied, f"The application needs Bun {spec} but this recipe pins Bun {BUN_VERSION}; a new recipe commit is required")


def check_toolchain(root, commit):
    """Compare the toolchain this recipe pins with what the application commit declares, before any build."""
    commit_exists(root, commit)
    for name in LOCKS:
        require(git_has(root, commit, name), f"The application commit lacks {name}; a new recipe commit is required")
    bazel = git_bytes(root, commit, ".bazelversion").decode("ascii", "replace").strip()
    shown = bazel if match(r"[0-9A-Za-z.+-]{1,32}", bazel) else "an unreadable version"
    require(bazel == BAZEL_VERSION, f"The application needs Bazel {shown} but this recipe pins Bazel {BAZEL_VERSION}; a new recipe commit is required")
    package = strict_json(git_bytes(root, commit, "package.json"))
    manager = package.get("packageManager") if isinstance(package, dict) else None
    if manager is not None:
        require(match(r"bun@.{1,32}", manager), "The application uses a package manager other than Bun; a new recipe commit is required")
        bun_requirement(manager[len("bun@"):])
    application = strict_json(git_bytes(root, commit, "packages/coding-agent/package.json"))
    engines = application.get("engines") if isinstance(application, dict) else None
    if isinstance(engines, dict) and engines.get("bun") is not None:
        require(isinstance(engines["bun"], str), "The application's Bun engine declaration is unreadable; a new recipe commit is required")
        bun_requirement(engines["bun"])
    version = application.get("version") if isinstance(application, dict) else None
    require(match(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", version), "The application version is not a release version")
    return version


def assert_recipes(root, recipe_commit):
    commit_exists(root, recipe_commit)
    for name in RECIPES:
        path = root / "scripts" / name
        require(path.is_file() and not path.is_symlink() and
                path.read_bytes() == git_bytes(root, recipe_commit, f"scripts/{name}"),
                "Invoked route differs from the reviewed recipe commit")


def validate_tag(root, commit, tag, allowed_signers, revoked_signers=None):
    require(match(OID, commit) and match(TAG, tag), "A full application commit and a fleet tag name are required")
    commit_exists(root, commit)
    require(allowed_signers is not None and Path(allowed_signers).is_file() and
            Path(allowed_signers).stat().st_size > 0, "Explicit enrolled public signers are required")
    if revoked_signers is not None:
        require(Path(revoked_signers).is_file(), "Explicit public revocations are required")
    oid = capture("git", "-C", str(root), "rev-parse", "--verify", f"refs/tags/{tag}").strip()
    require(match(OID, oid) and capture("git", "-C", str(root), "cat-file", "-t", oid).strip() == "tag",
            "A signed annotated tag is required")
    raw = capture("git", "-C", str(root), "cat-file", "tag", oid)
    header = dict(line.split(" ", 1) for line in raw.split("\n\n", 1)[0].splitlines() if " " in line)
    require(header.get("type") == "commit" and header.get("tag") == tag and header.get("object") == commit,
            "The tag must name the direct exact application commit")
    require("-----BEGIN SSH SIGNATURE-----" in raw, "An SSH-signed tag is required")
    # An omitted revocation input means an explicitly empty public deny-list.
    # /dev/null avoids creating a trust store or inheriting unrelated Git config.
    command = ["git", "-C", str(root), "-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen",
               "-c", f"gpg.ssh.allowedSignersFile={Path(allowed_signers).resolve()}",
               "-c", f"gpg.ssh.revocationFile={Path(revoked_signers).resolve() if revoked_signers else '/dev/null'}",
               "verify-tag", oid]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    return oid


def validate_docker(endpoint):
    # Reject overrides before any daemon-capable subprocess. Never inspect saved builders.
    overrides = ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
                 "DOCKER_API_VERSION", "DOCKER_CONFIG", "DOCKER_BUILDKIT", "DOCKER_DEFAULT_PLATFORM",
                 "BUILDX_BUILDER", "BUILDX_CONFIG", "BUILDKIT_HOST", "BUILDX_HOST")
    require(not any(os.environ.get(name) for name in overrides), "Ambient Docker overrides are forbidden")
    require(isinstance(endpoint, str) and endpoint.startswith("unix:///"), "An explicit local Unix socket is required")
    path = endpoint[len("unix://"):]
    require(not any(char in path for char in ("\n", "\r", "\x00", "?", "#", '"', "\\")) and
            stat.S_ISSOCK(Path(path).stat().st_mode), "The local Docker socket is unavailable")
    return ["docker", "--host", endpoint]


def witness_label(run_id):
    require(not run_id or match(r"[a-z0-9][a-z0-9-]{0,47}", run_id), "Invalid witness run identifier")
    return ["--label", "org.stronk.omp-witness=" + run_id] if run_id else []


def elf(path):
    with path.open("rb") as stream:
        header = stream.read(20)
    require(len(header) == 20 and header[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", header, 18)[0] == 62,
            "Expected ELF64 little-endian x86-64 bytes")
    programs = capture("readelf", "--program-headers", "--wide", str(path))
    loader = re.search(r"Requesting program interpreter: ([^\]]+)\]", programs)
    versions = capture("readelf", "--version-info", "--wide", str(path))
    glibc = sorted(set(re.findall(r"\bGLIBC_([0-9]+(?:\.[0-9]+)+)\b", versions)),
                   key=lambda value: tuple(map(int, value.split("."))))
    libraries = re.findall(r"Shared library: \[([^\]]+)\]", capture("readelf", "--dynamic", "--wide", str(path)))
    return {"format": "ELF64-x86-64", "interpreter": Path(loader[1]).name if loader else None,
            "glibc_required": glibc[-1] if glibc else None, "needed_libraries": sorted(set(libraries))}


def save_manifest(directory, manifest):
    data = canonical_json(manifest)
    # A partial metadata replacement fails checksum verification and cannot publish.
    with tempfile.NamedTemporaryFile(dir=directory, mode="wb", delete=False) as stream:
        stream.write(data)
        temporary = Path(stream.name)
    temporary.replace(directory / ASSETS[1])
    checksums = "".join(f"{digest(directory / name)}  {name}\n" for name in ASSETS[:2])
    with tempfile.NamedTemporaryFile(dir=directory, mode="w", delete=False) as stream:
        stream.write(checksums)
        temporary = Path(stream.name)
    temporary.replace(directory / ASSETS[2])


def create(directory):
    root = Path("/src")
    binary = directory / ASSETS[0]
    native = root / "packages/natives/native/pi_natives.linux-x64-baseline.node"
    versions = {"bun": capture("bun", "--version").strip(), "bazel": capture("bazel", "--version").strip(),
                "rustc": capture("rustc", "--version").strip(), "cargo": capture("cargo", "--version").strip(),
                "cmake": capture("cmake", "--version").splitlines()[0], "ninja": capture("ninja", "--version").strip()}
    tool_paths = {tool: Path(capture("rustup", "which", tool).strip() if tool in ("rustc", "cargo") else which(tool)).resolve()
                  for tool in TOOLS}
    manifest = {
        "schema": 2, "repository": REPOSITORY, "target": "linux-amd64",
        "version": strict_json((root / "packages/coding-agent/package.json").read_text())["version"],
        "source": {"commit": os.environ["SOURCE_COMMIT"], "tag": os.environ["SOURCE_TAG"] or None,
                   "tag_object": os.environ["SOURCE_TAG_OBJECT"] or None,
                   "source_date_epoch": int(os.environ["SOURCE_DATE_EPOCH"]),
                   "recipe_committed": os.environ["RECIPE_COMMITTED"] == "1",
                   "recipe_commit": os.environ["RECIPE_COMMIT"] or None},
        "build_inputs": {"base_image": os.environ["BASE_IMAGE"], "debian_snapshot": os.environ["DEBIAN_SNAPSHOT"],
                         "bun_archive_sha256": os.environ["BUN_SHA256"], "bazel_download_sha256": os.environ["BAZEL_SHA256"],
                         "host_tools": {tool: {"version": versions[tool], "sha256": digest(tool_paths[tool])} for tool in TOOLS},
                         "system_packages_sha256": hashlib.sha256(capture("dpkg-query", "-W", "-f=${Package}=${Version}\n").encode()).hexdigest(),
                         "locks": {name: digest(root / name) for name in LOCKS},
                         "recipe": {name: digest(Path("/recipe") / name) for name in RECIPES}},
        "asset": {"name": ASSETS[0], "size": binary.stat().st_size, "sha256": digest(binary)},
        "runtime": {"binary": elf(binary), "native_baseline": {"sha256": digest(native), "elf": elf(native)},
                    "cpu": "x86-64-v2", "native_variant": "baseline", "fully_static": False},
        "checks": {name: "passed" if name == "elf" else "not_run" for name in CHECKS}, "qualification": None}
    save_manifest(directory, manifest)
    # Tree verification occurs on the Mac; Git metadata never enters the build container.
    verify(directory, manifest["source"]["commit"], manifest["source"]["tag"] or "", False,
           manifest["source"]["recipe_commit"] or "", root=False)


def keys(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected), "Unexpected public fields")


def match(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def verify_elf(value):
    keys(value, ("format", "interpreter", "glibc_required", "needed_libraries"))
    require(value["format"] == "ELF64-x86-64", "Wrong ELF target")
    require(value["interpreter"] is None or match(r"[A-Za-z0-9_.+-]+", value["interpreter"]), "Invalid loader identity")
    require(value["glibc_required"] is None or match(r"[0-9]+(?:\.[0-9]+)+", value["glibc_required"]), "Invalid libc floor")
    require(isinstance(value["needed_libraries"], list) and
            all(match(r"[A-Za-z0-9_.+-]+", item) for item in value["needed_libraries"]), "Invalid library identity")


def verify(directory, commit, tag, release, recipe_commit="", root=None):
    require(not directory.is_symlink() and directory.is_dir(), "A regular asset directory is required")
    require({entry.name for entry in directory.iterdir()} == set(ASSETS), "Only the exact three public assets are permitted")
    require(all((directory / name).is_file() and not (directory / name).is_symlink() for name in ASSETS), "Assets must be regular files")
    manifest_data = (directory / ASSETS[1]).read_bytes()
    manifest = strict_json(manifest_data)
    require(manifest_data == canonical_json(manifest), "Manifest bytes differ from canonical JSON")
    keys(manifest, ("schema", "repository", "target", "version", "source", "build_inputs", "asset", "runtime", "checks", "qualification"))
    require(type(manifest["schema"]) is int and manifest["schema"] == 2 and manifest["repository"] == REPOSITORY and
            manifest["target"] == "linux-amd64", "Wrong release identity")
    require(match(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", manifest["version"]), "Invalid version")
    source = manifest["source"]
    keys(source, ("commit", "tag", "tag_object", "source_date_epoch", "recipe_committed", "recipe_commit"))
    require(match(OID, commit) and source["commit"] == commit, "Wrong exact application commit")
    require(source["tag"] == (tag or None) and (not tag or match(TAG, tag)), "Wrong exact source tag")
    require((source["tag_object"] is None and not tag) or (bool(tag) and match(OID, source["tag_object"])), "Invalid tag object")
    require(type(source["recipe_committed"]) is bool and type(source["source_date_epoch"]) is int and source["source_date_epoch"] > 0,
            "Invalid source metadata")
    require((source["recipe_committed"] and match(OID, recipe_commit) and source["recipe_commit"] == recipe_commit) or
            (not source["recipe_committed"] and not recipe_commit and source["recipe_commit"] is None), "Wrong exact recipe commit")
    require(not release or (source["recipe_committed"] and tag), "Candidate recipes cannot be published")
    inputs = manifest["build_inputs"]
    keys(inputs, ("base_image", "debian_snapshot", "bun_archive_sha256", "bazel_download_sha256", "host_tools", "system_packages_sha256", "locks", "recipe"))
    require(inputs["base_image"] == BASE_IMAGE and inputs["debian_snapshot"] == "20260813T000000Z" and
            inputs["bun_archive_sha256"] == BUN_SHA256 and inputs["bazel_download_sha256"] == BAZEL_SHA256,
            "Build pins differ from the reviewed recipe")
    require(match(HEX, inputs["system_packages_sha256"]), "Invalid system digest")
    for field, names in (("locks", LOCKS), ("recipe", RECIPES)):
        keys(inputs[field], names)
        require(all(match(HEX, value) for value in inputs[field].values()), "Invalid input digest")
    if root is not False:
        root = root or Path(__file__).resolve().parent.parent
        commit_exists(root, commit)
        require(inputs["locks"] == {name: hashlib.sha256(git_bytes(root, commit, name)).hexdigest() for name in LOCKS},
                "Immutable application locks differ from provenance")
        require(manifest["version"] == strict_json(git_bytes(root, commit, "packages/coding-agent/package.json"))["version"],
                "Immutable application version differs from provenance")
        epoch = int(capture("git", "-C", str(root), "show", "-s", "--format=%ct", commit).strip())
        require(source["source_date_epoch"] == epoch, "Immutable source timestamp differs")
        if source["recipe_committed"]:
            commit_exists(root, recipe_commit)
            require(inputs["recipe"] == {name: hashlib.sha256(git_bytes(root, recipe_commit, f"scripts/{name}")).hexdigest() for name in RECIPES},
                    "Immutable recipe bytes differ from provenance")
    keys(inputs["host_tools"], TOOLS)
    for tool in inputs["host_tools"].values():
        keys(tool, ("version", "sha256"))
        require(match(r"[A-Za-z0-9 ._()+,:=\-]+", tool["version"]) and match(HEX, tool["sha256"]), "Invalid public tool identity")
    asset = manifest["asset"]
    keys(asset, ("name", "size", "sha256"))
    binary = directory / ASSETS[0]
    require(asset["name"] == ASSETS[0] and type(asset["size"]) is int and asset["size"] > 0 and
            asset["size"] == binary.stat().st_size and asset["sha256"] == digest(binary), "Binary bytes differ from provenance")
    with binary.open("rb") as stream:
        header = stream.read(20)
    require(len(header) == 20 and header[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", header, 18)[0] == 62,
            "Wrong binary architecture")
    runtime = manifest["runtime"]
    keys(runtime, ("binary", "native_baseline", "cpu", "native_variant", "fully_static"))
    require(runtime["cpu"] == "x86-64-v2" and runtime["native_variant"] == "baseline" and runtime["fully_static"] is False,
            "Wrong runtime contract")
    verify_elf(runtime["binary"])
    require(runtime["binary"]["interpreter"] == "ld-linux-x86-64.so.2", "Wrong GNU loader")
    keys(runtime["native_baseline"], ("sha256", "elf"))
    require(match(HEX, runtime["native_baseline"]["sha256"]), "Invalid native digest")
    verify_elf(runtime["native_baseline"]["elf"])
    keys(manifest["checks"], CHECKS)
    qualification = manifest["qualification"]
    if qualification is None:
        require(not release and manifest["checks"] == {name: "passed" if name == "elf" else "not_run" for name in CHECKS},
                "Completed qualification is required")
    else:
        keys(qualification, ("binary_sha256", "source_commit", "recipe_commit", "environment", "checks"))
        require(qualification["binary_sha256"] == asset["sha256"] and qualification["source_commit"] == commit and
                qualification["recipe_commit"] == source["recipe_commit"], "Qualification tuple differs")
        require(manifest["checks"] == qualification["checks"] == {name: "passed" for name in CHECKS}, "Incomplete qualification")
        environment = qualification["environment"]
        keys(environment, ("execution", "cpu", "glibc", "loader", "runtime_image"))
        require(environment["execution"] == "native-amd64" and environment["cpu"] == "x86-64-v2" and
                environment["loader"] == "ld-linux-x86-64.so.2" and match(r"[0-9]+(?:\.[0-9]+)+", environment["glibc"]) and
                match(DIGEST, environment["runtime_image"]), "Invalid qualified runtime baseline")
        for observation in (runtime["binary"], runtime["native_baseline"]["elf"]):
            floor = observation["glibc_required"]
            require(floor is not None and tuple(map(int, environment["glibc"].split("."))) >= tuple(map(int, floor.split("."))),
                    "Qualified libc is below the required floor")
    expected = "".join(f"{digest(directory / name)}  {name}\n" for name in ASSETS[:2])
    require((directory / ASSETS[2]).read_text() == expected, "Checksum list differs from exact asset set")
    return manifest


def attestation_bytes(manifest, fork_manifest_sha256):
    qualification = manifest["qualification"]
    require(qualification is not None and
            manifest["checks"] == qualification["checks"] == {name: "passed" for name in CHECKS},
            "Completed qualification is required")
    # The registry the boundary tests came from is bound by the private signed record only: the public manifest is read by
    # the fleet puller with exact key sets and must not carry it.
    require(match(HEX, fork_manifest_sha256), "Qualification fork manifest differs")
    return canonical_json({
        "schema": 2, "binary_sha256": manifest["asset"]["sha256"],
        "source_commit": manifest["source"]["commit"], "recipe_commit": manifest["source"]["recipe_commit"],
        "fork_manifest_sha256": fork_manifest_sha256,
        "runtime_image_digest": qualification["environment"]["runtime_image"],
        "mode": "release" if manifest["source"]["recipe_committed"] else "candidate",
        "checks": manifest["checks"], "manifest_sha256": hashlib.sha256(canonical_json(manifest)).hexdigest(),
    })


def verify_attestation(manifest, attestation, signers, fork_manifest_sha256=""):
    """Check the signed private record against the public manifest; a caller that knows the fork manifest hash must see the same one."""
    signature = Path(str(attestation) + ".sig")
    require(all(path.is_file() and not path.is_symlink() and path.stat().st_size > 0
                for path in (attestation, signature, signers)), "Explicit qualification evidence and public signers are required")
    data = attestation.read_bytes()
    value = strict_json(data)
    recorded = value.get("fork_manifest_sha256") if isinstance(value, dict) else None
    require(match(HEX, recorded) and (not fork_manifest_sha256 or recorded == fork_manifest_sha256),
            "Qualification fork manifest differs")
    expected = attestation_bytes(manifest, recorded)
    require(canonical_json(value) == data == expected, "Qualification attestation binding differs")
    result = subprocess.run(
        ["ssh-keygen", "-Y", "verify", "-f", str(signers), "-I", ATTESTATION_IDENTITY,
         "-n", ATTESTATION_NAMESPACE, "-s", str(signature)],
        input=data, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False)
    require(result.returncode == 0, "Qualification attestation is not trusted")


def build(args):
    root = Path(__file__).resolve().parent.parent
    commit_exists(root, args.commit)
    require(match(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.output), "Output must be a new dist child")
    tag_object = ""
    if args.candidate:
        require(not args.recipe_commit and not args.tag, "Candidates cannot claim committed release identity")
    else:
        assert_recipes(root, args.recipe_commit)
        tag_object = validate_tag(root, args.commit, args.tag, args.allowed_signers, args.revoked_signers)
    witness_label(getattr(args, "witness_run_id", ""))
    docker = validate_docker(args.docker_socket)
    dist = root / "dist"
    require(not dist.is_symlink(), "A symlinked dist is forbidden")
    dist.mkdir(exist_ok=True)
    destination = dist / args.output
    require(not destination.exists() and not destination.is_symlink(), "Output already exists")
    with tempfile.TemporaryDirectory(prefix=".linux-amd64-build.", dir=dist) as temporary:
        context = Path(temporary)
        client_config = context / "docker-client"
        client_config.mkdir(mode=0o700)
        source = context / "source"
        source.mkdir()
        with subprocess.Popen(["git", "-C", str(root), "archive", "--format=tar", args.commit],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as archive:
            with tarfile.open(fileobj=archive.stdout, mode="r|") as stream:
                stream.extractall(source, filter="data")
            require(archive.wait() == 0, "Immutable source export failed")
        recipe = context / "recipe"
        recipe.mkdir()
        for name in RECIPES:
            data = (root / "scripts" / name).read_bytes() if args.candidate else git_bytes(root, args.recipe_commit, f"scripts/{name}")
            (recipe / name).write_bytes(data)
        epoch = capture("git", "-C", str(root), "show", "-s", "--format=%ct", args.commit).strip()
        command = docker + ["--config", str(client_config), "build", "--platform", "linux/amd64",
                            "--file", str(recipe / "linux-amd64.Dockerfile")]
        run_id = getattr(args, "witness_run_id", "")
        command += witness_label(run_id)
        if run_id:
            command += ["--build-arg", "WITNESS_RUN_ID=" + run_id]
        for name, value in {"SOURCE_COMMIT": args.commit, "SOURCE_TAG": args.tag, "SOURCE_TAG_OBJECT": tag_object,
                            "SOURCE_DATE_EPOCH": epoch, "RECIPE_COMMITTED": "0" if args.candidate else "1",
                            "RECIPE_COMMIT": args.recipe_commit}.items():
            command += ["--build-arg", f"{name}={value}"]
        command += ["--provenance=false", "--sbom=false", "--progress=plain", "--output", f"type=local,dest={context / 'artifacts'}", str(context)]
        print("Phase: building exact application and reviewed recipe in isolated Linux layers.", flush=True)
        # Emit only known build phases, never paths, environment values or raw diagnostics.
        phases = ("Phase: locked JavaScript dependencies.", "Phase: GNU amd64 baseline native addon.",
                  "Phase: embedding native/resources and compiling baseline Bun.")
        observed = set()
        with (context / "build.log").open("wb") as log:
            with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
                for line in process.stdout:
                    log.write(line)
                    for phase in phases:
                        if phase.encode() in line and phase not in observed:
                            observed.add(phase)
                            print(phase, flush=True)
                require(process.wait() == 0, "Disposable build failed")
        verify(context / "artifacts", args.commit, args.tag, False, args.recipe_commit, root)
        destination.mkdir()
        for name in ASSETS if args.receipts else ASSETS[:1]:
            with (context / "artifacts" / name).open("rb") as source_stream, (destination / name).open("xb") as target:
                shutil.copyfileobj(source_stream, target)
        (destination / ASSETS[0]).chmod(0o755)
    print("Phase: complete; unqualified Linux-amd64 artifacts exported.")


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise SystemExit("Invalid Linux-amd64 route arguments; no action is permitted.")


def parser():
    result = Parser(description=__doc__)
    result.add_argument("mode", choices=("create", "verify", "build", "check"))
    result.add_argument("directory", type=Path, nargs="?")
    result.add_argument("--commit", default="")
    result.add_argument("--recipe-commit", default="")
    result.add_argument("--tag", default="")
    result.add_argument("--release", action="store_true")
    result.add_argument("--allowed-signers", type=Path)
    result.add_argument("--revoked-signers", type=Path)
    result.add_argument("--attestation", type=Path)
    result.add_argument("--qualification-signers", type=Path)
    result.add_argument("--docker-socket", default="")
    result.add_argument("--candidate", action="store_true")
    result.add_argument("--receipts", action="store_true")
    result.add_argument("--output", default="linux-amd64")
    result.add_argument("--witness-run-id", default="")
    result.add_argument("--fork-manifest", type=Path)
    result.add_argument("--fork-manifest-sha256", default="")
    return result


def check(args):
    # The fork-contract rules belong to the qualifier; load it only for this early refusal.
    spec = importlib.util.spec_from_file_location("linux_amd64_qualify", Path(__file__).with_name("linux-amd64-qualify.py"))
    qualifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(qualifier)
    try:
        manifest, digest, _ = qualifier.load_fork_manifest(args.fork_manifest, args.fork_manifest_sha256)
        version, contracts = qualifier.application_preflight(Path(__file__).resolve().parent.parent, args.commit, manifest)
    except ValueError as error:
        # The qualifier loads its own copy of this module, so its fixed refusals are another class.
        if type(error).__name__ == "RouteError":
            raise RouteError(str(error)) from None
        raise
    print(f"Application check passed: omp {version}, Bazel {BAZEL_VERSION}, Bun {BUN_VERSION}, {contracts} fork contracts, manifest {digest[:12]}.")


def main():
    args = parser().parse_args()
    try:
        if args.mode == "check":
            check(args)
            return
        if args.mode == "build":
            build(args)
        elif args.mode == "create":
            create(args.directory)
        else:
            require(not args.fork_manifest_sha256 or args.attestation is not None,
                    "A fork manifest SHA-256 can only be checked against qualification evidence")
            manifest = verify(args.directory, args.commit, args.tag, args.release, args.recipe_commit)
            if args.release or args.attestation is not None or args.qualification_signers is not None:
                require(args.attestation is not None and args.qualification_signers is not None,
                        "Explicit qualification evidence and public signers are required")
                verify_attestation(manifest, args.attestation, args.qualification_signers, args.fork_manifest_sha256)
        print("Public linux-amd64 receipt verified.")
    except RouteError as error:
        if args.mode == "check":
            raise SystemExit("Application check failed: " + str(error)) from None
        raise SystemExit("Public linux-amd64 route rejected; no asset publication is permitted.") from None
    except (ValueError, OSError, KeyError, TypeError, AttributeError, subprocess.SubprocessError, tarfile.TarError):
        if args.mode == "check":
            raise SystemExit("Application check failed: the application or recipe objects could not be read.") from None
        raise SystemExit("Public linux-amd64 route rejected; no asset publication is permitted.") from None


if __name__ == "__main__":
    main()
