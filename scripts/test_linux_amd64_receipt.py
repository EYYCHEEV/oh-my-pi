"""Offline fixtures for the public receipt, immutable trees and trust boundaries."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import shutil
from pathlib import Path
import socket
import struct
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("receipt", Path(__file__).with_name("linux-amd64-receipt.py"))
receipt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receipt)
COMMIT = "5e43891a87140fb0972c982f3027f0228c4f6378"
RECIPE = "a" * 40
TAG = "stronk-omp-s1-2026.10.16.0001"
TAG_OID = "b" * 40
EPOCH = 1792108800
TREE = {name: b"immutable-application-input\n" for name in receipt.LOCKS}
TREE["packages/coding-agent/package.json"] = b'{"version":"18.8.0"}'
RECIPE_TREE = {"scripts/" + name: ("reviewed-recipe:" + name).encode() for name in receipt.RECIPES}
REAL_RUN = subprocess.run
START, END = "<!-- stronk-omp:fork-contracts:start -->", "<!-- stronk-omp:fork-contracts:end -->"
FORK_DATA = json.dumps({
    "schemaVersion": 1, "requireDeclaredPaths": False, "readme": {"path": "README.md", "startMarker": START, "endMarker": END},
    "contracts": [{"id": "fixture-contract", "title": "Fixture contract", "status": "active",
                   "verification": ["bun test packages/fixture/test/fixture.test.ts"]}]}, indent=2).encode() + b"\n"
FORK_SHA = hashlib.sha256(FORK_DATA).hexdigest()


def signing_fixture(directory):
    key = directory / "fixture-key"
    REAL_RUN(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "qualification-fixture", "-f", str(key)],
             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=30,
             env={"PATH": os.defpath, "SSH_ASKPASS_REQUIRE": "never"})
    signers = directory / "qualification-signers"
    signers.write_text('stronk-omp-qualification namespaces="stronk-omp-qualification" ' +
                       Path(str(key) + ".pub").read_text())
    return key, signers


def sign_fixture(manifest, key, path, namespace="stronk-omp-qualification", changes=None, raw=None):
    def canonical(value):
        return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    value = {"schema": 2, "binary_sha256": manifest["asset"]["sha256"],
             "source_commit": manifest["source"]["commit"], "recipe_commit": manifest["source"]["recipe_commit"],
             "fork_manifest_sha256": FORK_SHA,
             "runtime_image_digest": manifest["qualification"]["environment"]["runtime_image"],
             "mode": "release" if manifest["source"]["recipe_committed"] else "candidate",
             "checks": manifest["checks"], "manifest_sha256": hashlib.sha256(canonical(manifest)).hexdigest()}
    value.update(changes or {})
    data = canonical(value) if raw is None else raw
    signature = REAL_RUN(["ssh-keygen", "-Y", "sign", "-f", str(key), "-n", namespace],
                         input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=30,
                         env={"PATH": os.defpath, "SSH_ASKPASS_REQUIRE": "never"}).stdout
    path.write_bytes(data)
    Path(str(path) + ".sig").write_bytes(signature)


def tree_bytes(_root, rev, name):
    if rev == COMMIT:
        return TREE[name]
    if rev == RECIPE:
        return RECIPE_TREE[name]
    raise ValueError("Unexpected immutable tree")


# What the recipe's tools print, in the shapes the fleet puller accepts.
TOOL_VERSIONS = {"bun": "1.4.4", "bazel": "bazel 9.2.0", "rustc": "rustc 1.97.0-nightly (a1b2c3d 2026-10-06)",
                 "cargo": "cargo 1.97.0-nightly (a1b2c3d 2026-10-06)", "cmake": "cmake version 3.31.0", "ninja": "1.12.1"}


def make_assets(directory, qualified=True, candidate=False):
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", header, 18, 62)
    (directory / receipt.ASSETS[0]).write_bytes(header + b"fixture-executable")
    elf = {"format": "ELF64-x86-64", "interpreter": "ld-linux-x86-64.so.2", "glibc_required": "2.34", "needed_libraries": ["libc.so.6"]}
    manifest = {"schema": 2, "repository": receipt.REPOSITORY, "target": "linux-amd64", "version": "18.8.0",
                "source": {"commit": COMMIT, "tag": None if candidate else TAG, "tag_object": None if candidate else TAG_OID,
                           "source_date_epoch": EPOCH, "recipe_committed": not candidate,
                           "recipe_commit": None if candidate else RECIPE},
                "build_inputs": {"base_image": receipt.BASE_IMAGE, "debian_snapshot": "20260813T000000Z",
                                 "bun_archive_sha256": receipt.BUN_SHA256, "bazel_download_sha256": receipt.BAZEL_SHA256,
                                 "system_packages_sha256": "d" * 64,
                                 "host_tools": {name: {"version": TOOL_VERSIONS[name], "sha256": "e" * 64} for name in receipt.TOOLS},
                                 "locks": {name: hashlib.sha256(TREE[name]).hexdigest() for name in receipt.LOCKS},
                                 "recipe": {name: hashlib.sha256(RECIPE_TREE["scripts/" + name]).hexdigest() for name in receipt.RECIPES}},
                "asset": {"name": receipt.ASSETS[0], "size": (directory / receipt.ASSETS[0]).stat().st_size,
                          "sha256": receipt.digest(directory / receipt.ASSETS[0])},
                "runtime": {"binary": elf, "native_baseline": {"sha256": "f" * 64, "elf": copy.deepcopy(elf)},
                            "cpu": "x86-64-v2", "native_variant": "baseline", "fully_static": False},
                "checks": {name: "passed" if qualified or name == "elf" else "not_run" for name in receipt.CHECKS},
                "qualification": None}
    if qualified:
        manifest["qualification"] = {"binary_sha256": manifest["asset"]["sha256"], "source_commit": COMMIT,
                                     "recipe_commit": manifest["source"]["recipe_commit"],
                                     "environment": {"execution": "native-amd64", "cpu": "x86-64-v2", "glibc": "2.41",
                                                     "loader": "ld-linux-x86-64.so.2", "runtime_image": "sha256:" + "c" * 64},
                                     "checks": dict(manifest["checks"])}
    receipt.save_manifest(directory, manifest)
    return manifest


# ---- mirror of the fleet puller's public-manifest rules -----------------------------------------------
# devbox-s1's puller reads RELEASE_MANIFEST.json with exact key sets: any new field at any depth rejects every release.
# Read only from agentic-workstation origin/main at commit c17ed05084f687f8d55ebf408f2f5351109c0e19,
# scripts/s1-update/s1_update.py (2026-10-23); nothing is imported from it. Line numbers below refer to that file.
# If the puller changes, update this block and the recipe's own key lists together.
PULLER_COMMIT = "c17ed05084f687f8d55ebf408f2f5351109c0e19"
PULLER_FIELDS = {  # `_object(value, fields)` at :134-135 requires value.keys() == fields for each of these
    "manifest": {"schema", "repository", "target", "version", "source", "build_inputs", "asset", "runtime", "checks", "qualification"},  # :1262-1265
    "source": {"commit", "tag", "tag_object", "source_date_epoch", "recipe_committed", "recipe_commit"},  # :1271
    "build_inputs": {"base_image", "debian_snapshot", "bun_archive_sha256", "bazel_download_sha256",
                     "host_tools", "system_packages_sha256", "locks", "recipe"},  # :1277 (OMP_BUILD_PINS keys :1118-1123 plus four)
    "locks": {"bun.lock", "Cargo.lock", "MODULE.bazel", "MODULE.bazel.lock", "rust-toolchain.toml", ".bazelversion"},  # OMP_LOCKS :1111
    "recipe": {"build-linux-amd64.sh", "linux-amd64.Dockerfile", "linux-amd64-receipt.py", "qualify-linux-amd64.sh",
               "linux-amd64-qualify.py", "linux-amd64-smoke.sh", "publish-linux-amd64.sh", "linux-amd64-publish.py",
               "linux-amd64-build.sh", "linux-amd64-runtime.py"},  # OMP_RECIPES :1113-1117
    "host_tools": {"bun", "bazel", "rustc", "cargo", "cmake", "ninja"},  # OMP_TOOLS :1110
    "host_tool": {"version", "sha256"},  # :1287
    "asset": {"name", "size", "sha256"},  # :1291
    "runtime": {"binary", "native_baseline", "cpu", "native_variant", "fully_static"},  # :1296
    "elf": {"format", "interpreter", "glibc_required", "needed_libraries"},  # runtime.binary and native_baseline.elf, :1248
    "native_baseline": {"sha256", "elf"},  # :1303
    "checks": {"elf", "cli", "native_runtime", "resources_workers", "builtin_smoke",
               "offline_session", "fork_boundaries", "native_grep", "coding_agent_typecheck"},  # OMP_CHECKS :1106-1109; used at :1306 and :1312
    "qualification": {"binary_sha256", "source_commit", "recipe_commit", "environment", "checks"},  # :1309
    "environment": {"execution", "cpu", "glibc", "loader", "runtime_image"},  # :1315
}
PULLER_PINS = {  # OMP_BUILD_PINS :1118-1123, compared literally at :1278-1279
    "base_image": "rustlang/rust:nightly-2026-08-12@sha256:51dc497bff0c24777d2ec6a1fc12ddf7ab0483de3ee537f4ec10816b9e1eff6c",
    "debian_snapshot": "20260813T000000Z",
    "bun_archive_sha256": "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76",
    "bazel_download_sha256": "7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694",
}
PULLER_LOADER = "ld-linux-x86-64.so.2"  # OMP_LOADER :1124
_TOOL = r"[0-9]+\.[0-9]+\.[0-9]+"
_RUST = _TOOL + r"(?:-[A-Za-z0-9-]+(?:\.[0-9]+)*)?(?: \([0-9a-f]{7,} [0-9]{4}-[0-9]{2}-[0-9]{2}\))?"  # :1127-1130
PULLER_TOOL_VERSIONS = {"bun": _TOOL, "ninja": _TOOL, "bazel": r"bazel " + _TOOL, "cmake": r"cmake version " + _TOOL,
                        "cargo": r"cargo " + _RUST, "rustc": r"rustc " + _RUST}  # _HOST_TOOL_VERSIONS :1131-1138
PULLER_PRIVATE = re.compile(  # `_manifest_public` :1228-1244, applied to every string value
    r"(?:^|[\s=:(])(?:/|~|[A-Za-z]:[/\\])|\\|\b(?:file|https?|ssh)://"
    r"|(?:^|[^a-z0-9])(?:home|users?|username|hostname|host|localhost|private|address|account)(?:$|[^a-z0-9])"
    r"|(?<![0-9.])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9.])", re.IGNORECASE)


def puller_problems(payload, *, qualified, sums=None):
    """What the puller's `_omp_manifest` (:1260-1328) and `_omp_sums` (:1331-1345) would object to, as a list of short texts."""
    problems = []

    def exact(value, name, path):
        if type(value) is not dict or set(value) != PULLER_FIELDS[name]:
            shown = sorted(set(value) ^ PULLER_FIELDS[name]) if type(value) is dict else "not an object"
            problems.append(f"{path}: unexpected or missing fields {shown}")
            return False
        return True

    def strings(value):
        if type(value) is dict:
            for child in value.values():
                yield from strings(child)
        elif type(value) is list:
            for child in value:
                yield from strings(child)
        elif type(value) is str:
            yield value

    try:
        manifest = receipt.strict_json(payload)
    except ValueError:
        return ["manifest: not strict JSON"]
    if not exact(manifest, "manifest", "manifest"):
        return problems
    if payload != (json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode("ascii"):
        problems.append("manifest: noncanonical bytes")  # :1326-1327
    if type(manifest["schema"]) is not int or manifest["schema"] != 2 or manifest["target"] != "linux-amd64":
        problems.append("manifest: wrong schema or target")
    exact(manifest["source"], "source", "source")
    inputs = manifest["build_inputs"]
    if exact(inputs, "build_inputs", "build_inputs"):
        problems += [f"build_inputs.{name}: differs from the puller's pin" for name, pin in PULLER_PINS.items() if inputs[name] != pin]
        exact(inputs["locks"], "locks", "build_inputs.locks")
        exact(inputs["recipe"], "recipe", "build_inputs.recipe")
        if exact(inputs["host_tools"], "host_tools", "build_inputs.host_tools"):
            for name, tool in inputs["host_tools"].items():
                if exact(tool, "host_tool", f"build_inputs.host_tools.{name}") and \
                        re.fullmatch(PULLER_TOOL_VERSIONS[name], str(tool["version"])) is None:
                    problems.append(f"build_inputs.host_tools.{name}: version is not in the puller's shape")
    exact(manifest["asset"], "asset", "asset")
    runtime = manifest["runtime"]
    if exact(runtime, "runtime", "runtime"):
        if exact(runtime["binary"], "elf", "runtime.binary") and runtime["binary"]["interpreter"] != PULLER_LOADER:
            problems.append("runtime.binary: not the GNU loader")
        if exact(runtime["native_baseline"], "native_baseline", "runtime.native_baseline"):
            exact(runtime["native_baseline"]["elf"], "elf", "runtime.native_baseline.elf")
        if (runtime["cpu"], runtime["native_variant"], runtime["fully_static"]) != ("x86-64-v2", "baseline", False):
            problems.append("runtime: wrong contract")
    exact(manifest["checks"], "checks", "checks")
    qualification = manifest["qualification"]
    if not qualified:
        if qualification is not None:
            problems.append("qualification: expected null before qualification")
    else:
        if not all(value == "passed" for value in manifest["checks"].values()):
            problems.append("checks: not all passed")
        if exact(qualification, "qualification", "qualification"):
            exact(qualification["checks"], "checks", "qualification.checks")
            if qualification["checks"] != manifest["checks"]:
                problems.append("qualification.checks: differ from checks")
            if exact(qualification["environment"], "environment", "qualification.environment"):
                environment = qualification["environment"]
                if (environment["execution"], environment["loader"]) != ("native-amd64", PULLER_LOADER):
                    problems.append("qualification.environment: wrong execution or loader")
    for value in strings(manifest):
        if PULLER_PRIVATE.search(value) or ("@" in value and re.fullmatch(r"rustlang/rust:[A-Za-z0-9.-]+@sha256:[0-9a-f]{64}", value) is None):
            problems.append("a string value looks private")  # :1243-1244 never names the value
    if sums is not None:
        lines = sums.splitlines()
        if not sums.endswith("\n") or len(lines) != 2 or "\r" in sums or \
                {line.split("  ")[1] for line in lines if "  " in line} != {"omp-linux-amd64", "RELEASE_MANIFEST.json"}:
            problems.append("SHA256SUMS.txt: not exactly the binary and the manifest")
    return problems



class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.manifest = make_assets(self.directory)
        self.addCleanup(patch.stopall)
        patch.object(receipt, "git_bytes", side_effect=tree_bytes).start()
        patch.object(receipt, "commit_exists").start()
        patch.object(receipt, "capture", return_value=str(EPOCH)).start()

    def verify(self, release=True, candidate=False):
        return receipt.verify(self.directory, COMMIT, "" if candidate else TAG, release,
                              "" if candidate else RECIPE, Path("fixture-tree"))

    def rewrite(self):
        receipt.save_manifest(self.directory, self.manifest)

    def test_qualified_exact_tuple_is_accepted(self):
        self.assertEqual(self.verify()["source"]["recipe_commit"], RECIPE)

    def test_the_signed_private_record_names_the_registry_and_a_caller_may_insist_on_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary)
            key, signers = signing_fixture(evidence)
            attestation = evidence / "qualification.json"
            sign_fixture(self.manifest, key, attestation)
            receipt.verify_attestation(self.manifest, attestation, signers)  # a publisher has no file to compare with
            receipt.verify_attestation(self.manifest, attestation, signers, FORK_SHA)
            self.assertEqual(receipt.strict_json(attestation.read_bytes())["fork_manifest_sha256"], FORK_SHA)
            with self.assertRaisesRegex(ValueError, "Qualification fork manifest differs"):
                receipt.verify_attestation(self.manifest, attestation, signers, "e" * 64)
            value = receipt.strict_json(attestation.read_bytes())
            without = {name: item for name, item in value.items() if name != "fork_manifest_sha256"}
            for name, signed in {"absent": dict(without), "empty": {**without, "fork_manifest_sha256": ""},
                                 "short": {**without, "fork_manifest_sha256": FORK_SHA[:-1]},
                                 "upper case": {**without, "fork_manifest_sha256": FORK_SHA.upper()},
                                 "not text": {**without, "fork_manifest_sha256": 7}}.items():
                with self.subTest(defect=name):
                    # Even a really signed record is refused: its fields are exact and the hash must be 64 lowercase hex.
                    sign_fixture(self.manifest, key, attestation, raw=receipt.canonical_json(signed))
                    with self.assertRaises(ValueError):
                        receipt.verify_attestation(self.manifest, attestation, signers)
            sign_fixture(self.manifest, key, attestation, changes={"schema": 1})
            with self.assertRaisesRegex(ValueError, "attestation binding differs"):
                receipt.verify_attestation(self.manifest, attestation, signers)

    def test_the_public_manifest_never_carries_the_registry_hash(self):
        # The fleet puller (s1_update.py) reads the manifest with exact key sets, so a new field would reject every release.
        for name, edit in {"the registry hash": lambda value: value["qualification"].update(fork_manifest_sha256=FORK_SHA),
                           "any other field": lambda value: value["qualification"].update(extra="x")}.items():
            with self.subTest(defect=name):
                self.manifest = make_assets(self.directory)
                edit(self.manifest)
                self.rewrite()
                with self.assertRaisesRegex(ValueError, "Unexpected public fields"):
                    self.verify()
                with self.assertRaisesRegex(ValueError, "Unexpected public fields"):
                    self.verify(release=False)
        self.manifest = make_assets(self.directory)
        self.assertNotIn("fork_manifest_sha256", json.dumps(self.verify()))

    def test_manifest_bytes_must_be_canonical_with_valid_checksums(self):
        path = self.directory / receipt.ASSETS[1]
        original = path.read_bytes()
        variants = {
            "indented": (json.dumps(self.manifest, sort_keys=True, indent=2) + "\n").encode(),
            "crlf": original.replace(b"\n", b"\r\n"),
            "no_final_newline": original.removesuffix(b"\n"),
        }
        for serialization, data in variants.items():
            with self.subTest(serialization=serialization):
                self.assertEqual(receipt.strict_json(data), self.manifest)
                path.write_bytes(data)
                (self.directory / receipt.ASSETS[2]).write_text("".join(
                    f"{receipt.digest(self.directory / name)}  {name}\n" for name in receipt.ASSETS[:2]))
                with self.assertRaisesRegex(ValueError, "Manifest bytes differ from canonical JSON"):
                    self.verify()

    def test_release_cli_requires_real_verified_completion_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary)
            key, signers = signing_fixture(evidence)
            attestation = evidence / "qualification.json"
            sign_fixture(self.manifest, key, attestation)
            command = ["receipt", "verify", str(self.directory), "--commit", COMMIT,
                       "--recipe-commit", RECIPE, "--tag", TAG, "--release"]
            with patch("sys.argv", command), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    receipt.main()
            command += ["--attestation", str(attestation), "--qualification-signers", str(signers)]
            with patch("sys.argv", command), contextlib.redirect_stdout(io.StringIO()):
                receipt.main()
                Path(str(attestation) + ".sig").write_text("not a signature")
                with self.assertRaises(SystemExit):
                    receipt.main()

    def test_cli_checks_the_registry_hash_only_against_the_signed_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary)
            key, signers = signing_fixture(evidence)
            attestation = evidence / "qualification.json"
            sign_fixture(self.manifest, key, attestation)
            base = ["receipt", "verify", str(self.directory), "--commit", COMMIT, "--recipe-commit", RECIPE, "--tag", TAG, "--release",
                    "--attestation", str(attestation), "--qualification-signers", str(signers)]
            for extra, accepted in ((["--fork-manifest-sha256", FORK_SHA], True), ([], True),
                                    (["--fork-manifest-sha256", "e" * 64], False), (["--fork-manifest-sha256", "short"], False)):
                with self.subTest(extra=extra), patch("sys.argv", base + extra), contextlib.redirect_stdout(io.StringIO()):
                    if accepted:
                        receipt.main()
                    else:
                        with self.assertRaises(SystemExit):
                            receipt.main()
            # A hash with no signed record to be checked against is refused, never silently ignored.
            command = ["receipt", "verify", str(self.directory), "--commit", COMMIT, "--recipe-commit", RECIPE, "--tag", TAG,
                       "--fork-manifest-sha256", FORK_SHA]
            with patch("sys.argv", command), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
                receipt.main()

    def test_application_and_recipe_are_verified_against_separate_trees(self):
        # No working-tree package or lock files exist here. Only immutable inputs count.
        self.verify()
        self.manifest["build_inputs"]["locks"]["Cargo.lock"] = "0" * 64
        self.rewrite()
        with self.assertRaises(ValueError):
            self.verify()

    def test_recipe_mismatch_is_rejected(self):
        self.manifest["build_inputs"]["recipe"]["linux-amd64.Dockerfile"] = "0" * 64
        self.rewrite()
        with self.assertRaises(ValueError):
            self.verify()
        with self.assertRaises(ValueError):
            receipt.verify(self.directory, COMMIT, TAG, True, "c" * 40, Path("fixture-tree"))

    def test_unknown_private_fields_at_each_boundary_are_rejected(self):
        original = copy.deepcopy(self.manifest)
        for field in (None, "source", "build_inputs", "asset", "runtime", "qualification"):
            with self.subTest(field=field):
                self.manifest = copy.deepcopy(original)
                target = self.manifest if field is None else self.manifest[field]
                target["private_detail"] = "forbidden"
                self.rewrite()
                with self.assertRaises(ValueError):
                    self.verify()

    def test_candidate_never_becomes_publishable_even_after_checks_pass(self):
        self.manifest = make_assets(self.directory, candidate=True)
        self.verify(release=False, candidate=True)
        with self.assertRaises(ValueError):
            self.verify(candidate=True)

    def test_not_run_or_partial_checks_cannot_publish(self):
        self.manifest = make_assets(self.directory, qualified=False)
        self.verify(release=False)
        with self.assertRaises(ValueError):
            self.verify()
        self.manifest = make_assets(self.directory)
        self.manifest["checks"]["fork_boundaries"] = "not_run"
        self.rewrite()
        with self.assertRaises(ValueError):
            self.verify()

    def test_qualification_wrong_binary_or_environment_is_rejected(self):
        original = copy.deepcopy(self.manifest)
        for key, value in (("binary_sha256", "0" * 64), ("source_commit", "c" * 40), ("recipe_commit", "c" * 40)):
            self.manifest = copy.deepcopy(original)
            self.manifest["qualification"][key] = value
            self.rewrite()
            with self.assertRaises(ValueError):
                self.verify()
        for key, value in (("execution", "emulated"), ("glibc", "2.17"), ("runtime_image", "floating:latest")):
            self.manifest = copy.deepcopy(original)
            self.manifest["qualification"]["environment"][key] = value
            self.rewrite()
            with self.assertRaises(ValueError):
                self.verify()

    def test_changed_bytes_wrong_elf_extra_asset_and_checksum_are_rejected(self):
        binary = self.directory / receipt.ASSETS[0]
        binary.write_bytes(binary.read_bytes() + b"changed")
        with self.assertRaises(ValueError):
            self.verify()
        self.manifest = make_assets(self.directory)
        data = bytearray(binary.read_bytes())
        struct.pack_into("<H", data, 18, 183)
        binary.write_bytes(data)
        self.manifest["asset"]["sha256"] = receipt.digest(binary)
        self.manifest["qualification"]["binary_sha256"] = self.manifest["asset"]["sha256"]
        self.rewrite()
        with self.assertRaises(ValueError):
            self.verify()
        self.manifest = make_assets(self.directory)
        (self.directory / "private-receipt.json").write_text("{}")
        with self.assertRaises(ValueError):
            self.verify()
        (self.directory / "private-receipt.json").unlink()
        (self.directory / receipt.ASSETS[2]).write_text("incorrect\n")
        with self.assertRaises(ValueError):
            self.verify()


class LocalBoundaryTests(unittest.TestCase):
    def test_remote_or_ambient_docker_selection_rejected_before_any_query(self):
        with patch.object(receipt, "capture") as query:
            with patch.dict(os.environ, {}, clear=True):
                for endpoint in ("ssh://unapproved", "tcp://unapproved", "default", ""):
                    with self.assertRaises(ValueError):
                        receipt.validate_docker(endpoint)
            with patch.dict(os.environ, {"DOCKER_CONTEXT": "unapproved"}, clear=True):
                with self.assertRaises(ValueError):
                    receipt.validate_docker("unix:///fixture.sock")
            query.assert_not_called()

    def test_local_socket_preflight_never_inspects_saved_builders(self):
        with tempfile.TemporaryDirectory() as temporary, socket.socket(socket.AF_UNIX) as engine:
            endpoint = "unix://" + str(Path(temporary) / "engine.sock")
            engine.bind(endpoint[len("unix://"):])
            with patch.dict(os.environ, {}, clear=True), patch.object(receipt.subprocess, "check_output") as query, \
                 patch.object(receipt.subprocess, "Popen") as process, patch.object(receipt.subprocess, "run") as run:
                self.assertEqual(receipt.validate_docker(endpoint), ["docker", "--host", endpoint])
                query.assert_not_called()
                process.assert_not_called()
                run.assert_not_called()

    def test_build_uses_only_selected_daemons_default_builder(self):
        from argparse import Namespace
        with tempfile.TemporaryDirectory() as temporary, socket.socket(socket.AF_UNIX) as engine:
            root = Path(temporary)
            (root / "scripts").mkdir()
            for name in receipt.RECIPES:
                (root / "scripts" / name).write_text("fixture recipe\n")
            endpoint = "unix://" + str(root / "engine.sock")
            engine.bind(endpoint[len("unix://"):])
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w"):
                pass
            commands = []

            def execute(command, **kwargs):
                commands.append(command)
                process = Mock()
                process.__enter__ = Mock(return_value=process)
                process.__exit__ = Mock(return_value=False)
                process.wait.return_value = 0
                if command[0] == "git":
                    process.stdout = io.BytesIO(archive.getvalue())
                else:
                    self.assertEqual(command[:3], ["docker", "--host", endpoint])
                    self.assertEqual(command[3], "--config")
                    self.assertEqual(list(Path(command[4]).iterdir()), [])
                    self.assertEqual(command[5:8], ["build", "--platform", "linux/amd64"])
                    self.assertNotIn("--builder", command)
                    self.assertNotIn("buildx", command)
                    artifacts = Path(command[-1]) / "artifacts"
                    artifacts.mkdir()
                    for name in receipt.ASSETS:
                        (artifacts / name).write_bytes(b"synthetic build output")
                    process.stdout = io.BytesIO()
                return process

            args = Namespace(commit=COMMIT, output="fixture", candidate=True, recipe_commit="", tag="",
                             docker_socket=endpoint, receipts=True)
            with patch.dict(os.environ, {}, clear=True), patch.object(receipt, "__file__", str(root / "scripts/receipt.py")), \
                 patch.object(receipt, "commit_exists"), patch.object(receipt, "capture", return_value=str(EPOCH)), \
                 patch.object(receipt, "verify"), patch.object(receipt.subprocess, "Popen", side_effect=execute):
                receipt.build(args)
            self.assertEqual([command[0] for command in commands], ["git", "docker"])

    def test_build_rejects_invalid_endpoint_before_daemon_capable_subprocess(self):
        from argparse import Namespace
        args = Namespace(commit=COMMIT, output="fixture", candidate=True, recipe_commit="", tag="",
                         docker_socket="ssh://unapproved")
        with patch.dict(os.environ, {}, clear=True), patch.object(receipt, "commit_exists"), \
             patch.object(receipt.subprocess, "check_output") as query, patch.object(receipt.subprocess, "Popen") as process, \
             patch.object(receipt.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                receipt.build(args)
            query.assert_not_called()
            process.assert_not_called()
            run.assert_not_called()

    def test_lightweight_nested_misnamed_unsigned_wrong_signer_tags_rejected(self):
        def run_tag(kind="tag", direct_type="commit", internal_tag=TAG, signed=True, trusted=True):
            def query(*args):
                if "rev-parse" in args:
                    return COMMIT if args[-1].endswith("^{commit}") else TAG_OID
                if args[-2:] == ("-t", TAG_OID):
                    return kind
                return (f"object {COMMIT}\ntype {direct_type}\ntag {internal_tag}\n\nrelease\n" +
                        ("-----BEGIN SSH SIGNATURE-----\nfixture\n" if signed else ""))
            with patch.object(receipt, "capture", side_effect=query), \
                 patch.object(Path, "is_file", return_value=True), \
                 patch.object(Path, "stat") as info, \
                 patch.object(receipt.subprocess, "run") as verify:
                info.return_value.st_size = 1
                if not trusted:
                    verify.side_effect = subprocess.CalledProcessError(1, "git")
                result = receipt.validate_tag(Path("fixture-tree"), COMMIT, TAG, Path("public-signers"), Path("public-revocations"))
                self.assertIn("gpg.ssh.allowedSignersFile=", " ".join(verify.call_args.args[0]))
                self.assertIn("gpg.ssh.revocationFile=", " ".join(verify.call_args.args[0]))
                return result
        self.assertEqual(run_tag(), TAG_OID)
        for options in ({"kind": "commit"}, {"direct_type": "tag"}, {"internal_tag": "wrong"}, {"signed": False}, {"trusted": False}):
            with self.subTest(options=options), self.assertRaises((ValueError, subprocess.CalledProcessError)):
                run_tag(**options)
        with self.assertRaises(ValueError):
            receipt.validate_tag(Path("fixture-tree"), COMMIT, "stronk-omp-legacy", Path("public-signers"))

    def test_invoked_recipe_must_match_immutable_recipe_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            for name in receipt.RECIPES:
                (root / "scripts" / name).write_bytes(RECIPE_TREE["scripts/" + name])
            with patch.object(receipt, "git_bytes", side_effect=tree_bytes), patch.object(receipt, "commit_exists"):
                receipt.assert_recipes(root, RECIPE)
                (root / "scripts" / "build-linux-amd64.sh").write_bytes(b"unreviewed-recipe")
                with self.assertRaises(ValueError):
                    receipt.assert_recipes(root, RECIPE)

    def test_release_preflight_rejects_unreviewed_recipe_before_docker(self):
        from argparse import Namespace
        args = Namespace(commit=COMMIT, output="fixture", candidate=False, recipe_commit=RECIPE)
        with patch.object(receipt, "commit_exists"), \
             patch.object(receipt, "assert_recipes", side_effect=ValueError("Unreviewed recipe")), \
             patch.object(receipt, "validate_docker") as docker:
            with self.assertRaises(ValueError):
                receipt.build(args)
            docker.assert_not_called()

    def test_candidate_cannot_claim_release_identity(self):
        from argparse import Namespace
        args = Namespace(commit=COMMIT, output="fixture", candidate=True, recipe_commit=RECIPE, tag="")
        with patch.object(receipt, "commit_exists"), patch.object(receipt, "validate_docker") as docker:
            with self.assertRaises(ValueError):
                receipt.build(args)
            docker.assert_not_called()


OTHER = "c" * 40


class ApplicationCommitTests(unittest.TestCase):
    """The application commit is an input; the recipe only checks it against its own pins."""

    def tree(self, bazel="9.2.0\n", manager="bun@>=1.4", engine=">=1.3.14", version="18.12.6", missing=()):
        files = {name: b"locked\n" for name in receipt.LOCKS if name not in missing}
        files[".bazelversion"] = bazel.encode()
        root = {"name": "root"}
        if manager is not None:
            root["packageManager"] = manager
        application = {"version": version}
        if engine is not None:
            application["engines"] = {"bun": engine}
        files["package.json"] = json.dumps(root).encode()
        files["packages/coding-agent/package.json"] = json.dumps(application).encode()
        return files

    def check(self, **options):
        files = self.tree(**options)
        with patch.object(receipt, "commit_exists"), \
             patch.object(receipt, "git_has", side_effect=lambda _root, _rev, path: path in files), \
             patch.object(receipt, "git_bytes", side_effect=lambda _root, _rev, path: files[path]):
            return receipt.check_toolchain(Path("fixture-tree"), OTHER)

    def test_matching_pins_and_floors_pass_and_report_the_version(self):
        self.assertEqual(self.check(), "18.12.6")
        self.assertEqual(self.check(manager="bun@1.4.4", engine="1.4.4"), "18.12.6")
        self.assertEqual(self.check(manager=None, engine=None), "18.12.6")

    def test_toolchain_mismatches_fail_closed_with_a_clear_reason(self):
        cases = (
            ({"bazel": "9.3.0\n"}, "Bazel 9.3.0 but this recipe pins Bazel 9.2.0"),
            ({"manager": "bun@>=1.5"}, "Bun >=1.5 but this recipe pins Bun 1.4.4"),
            ({"manager": "bun@1.4.3"}, "Bun 1.4.3 but this recipe pins Bun 1.4.4"),
            ({"engine": ">=2.0.0"}, "Bun >=2.0.0 but this recipe pins Bun 1.4.4"),
            ({"manager": "bun@^1.4"}, "neither an exact pin nor a floor"),
            ({"manager": "pnpm@9.0.0"}, "package manager other than Bun"),
            ({"missing": ("Cargo.lock",)}, "lacks Cargo.lock"),
            ({"version": "latest"}, "not a release version"),
        )
        for options, reason in cases:
            with self.subTest(options=options), self.assertRaises(receipt.RouteError) as raised:
                self.check(**options)
            self.assertIn(reason, str(raised.exception))

    def test_check_cli_end_to_end_in_a_throwaway_repository(self):
        environment = {"PATH": os.defpath, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repository"
            (root / "scripts").mkdir(parents=True)
            for name in ("linux-amd64-receipt.py", "linux-amd64-qualify.py"):
                shutil.copy(Path(__file__).with_name(name), root / "scripts" / name)
            files = self.tree()
            readme = "# Application\n\n" + START + "\n- `fixture-contract`: Fixture contract\n" + END + "\n"
            files["README.md"] = readme.encode()
            files["packages/fixture/test/fixture.test.ts"] = b"// fixture\n"
            for name, data in files.items():
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_bytes(data)

            def git(*arguments):
                return REAL_RUN(["git", "-C", str(root), "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", *arguments],
                                capture_output=True, text=True, check=True, timeout=60, env=environment).stdout.strip()
            git("init", "-q")
            git("add", "-A")
            git("commit", "-q", "-m", "application")
            commit = git("rev-parse", "HEAD")
            manifest = Path(temporary) / "fork_boundary.json"
            manifest.write_bytes(FORK_DATA)

            def check(*arguments, repository=root):
                return REAL_RUN([sys.executable, str(repository / "scripts/linux-amd64-receipt.py"), "check", "--commit", commit, *arguments],
                                capture_output=True, text=True, timeout=60, env=environment)
            passed = check("--fork-manifest", str(manifest), "--fork-manifest-sha256", FORK_SHA)
            self.assertEqual(passed.returncode, 0, passed.stderr)
            self.assertEqual(passed.stdout.strip(), "Application check passed: omp 18.12.6, Bazel 9.2.0, Bun 1.4.4, 1 fork contracts, manifest "
                             + FORK_SHA[:12] + ".")
            self.assertEqual(check("--fork-manifest", str(manifest)).returncode, 0)  # the hash is optional for the early check
            stale = Path(temporary) / "stale.json"
            stale.write_bytes(FORK_DATA.replace(b"Fixture contract", b"Another title"))
            oversized = Path(temporary) / "oversized.json"
            oversized.write_bytes(FORK_DATA + b" " * (1024 * 1024))
            unsafe = Path(temporary) / "unsafe.json"
            unsafe.write_bytes(FORK_DATA.replace(b"bun test packages/fixture/test/fixture.test.ts", b"sh -c 'bun test packages/fixture/test/fixture.test.ts'"))
            piped = Path(temporary) / "piped.json"
            piped.write_bytes(FORK_DATA.replace(b"fixture.test.ts\"", b"fixture.test.ts | cat\""))
            absolute = Path(temporary) / "absolute.json"
            absolute.write_bytes(FORK_DATA.replace(b"bun test packages", b"bun test /packages"))
            gone = Path(temporary) / "gone.json"
            gone.write_bytes(FORK_DATA.replace(b"fixture.test.ts", b"deleted.test.ts"))
            for arguments, reason in (
                    ((), "The fork manifest is missing or unreadable"),
                    (("--fork-manifest", str(Path(temporary) / "absent.json")), "The fork manifest is missing or unreadable"),
                    (("--fork-manifest", str(manifest), "--fork-manifest-sha256", "0" * 64), "differs from its stated SHA-256"),
                    (("--fork-manifest", str(stale)), "fork-contract block differs from the manifest's active contracts"),
                    (("--fork-manifest", str(oversized)), "exceeds its size cap"),
                    (("--fork-manifest", str(unsafe)), "must start with bun test or cargo test (fixture-contract)"),
                    (("--fork-manifest", str(piped)), "contains shell syntax (fixture-contract)"),
                    (("--fork-manifest", str(absolute)), "leaves the application tree (fixture-contract)"),
                    (("--fork-manifest", str(gone)), "missing from the application: packages/fixture/test/deleted.test.ts")):
                with self.subTest(reason=reason, arguments=arguments[:1]):
                    result = check(*arguments)
                    self.assertEqual(result.returncode, 1, result.stdout)
                    self.assertIn("Application check failed: ", result.stderr)
                    self.assertIn(reason, result.stderr)
                    self.assertEqual(result.stdout, "")
                    self.assertNotIn(temporary, result.stdout + result.stderr)
            (root / "README.md").write_text("# An application without the fork contract map\n")
            git("add", "-A")
            git("commit", "-q", "-m", "no contract block")
            commit = git("rev-parse", "HEAD")
            missing = check("--fork-manifest", str(manifest), "--fork-manifest-sha256", FORK_SHA)
            self.assertEqual(missing.returncode, 1)
            self.assertIn("Application check failed: The application's README must hold exactly one fork-contract start marker", missing.stderr)
            self.assertNotIn(temporary, missing.stdout + missing.stderr)

    def test_unprintable_application_text_never_reaches_the_reason(self):
        with self.assertRaises(receipt.RouteError) as raised:
            self.check(bazel="9.9.9\n\x1b[31m$(touch pwn)\n")
        self.assertNotIn("touch", str(raised.exception))
        self.assertNotIn("\x1b", str(raised.exception))

    def test_check_mode_prints_only_a_fixed_reason(self):
        arguments = ["linux-amd64-receipt.py", "check", "--commit", OTHER]
        for failure, expected in (
                (receipt.RouteError("The application needs Bazel 9.3.0 but this recipe pins Bazel 9.2.0"),
                 "Application check failed: The application needs Bazel 9.3.0"),
                (subprocess.CalledProcessError(128, ["git", "/private/path"]),
                 "Application check failed: the application or recipe objects could not be read.")):
            with self.subTest(expected=expected), patch("sys.argv", arguments), patch.object(receipt, "check", side_effect=failure):
                with self.assertRaises(SystemExit) as raised:
                    receipt.main()
                self.assertTrue(str(raised.exception).startswith(expected))
                self.assertNotIn("private", str(raised.exception))
        with patch("sys.argv", ["linux-amd64-receipt.py", "verify", "dist/x", "--commit", OTHER]), \
             patch.object(receipt, "verify", side_effect=receipt.RouteError("detail with /private/path")):
            with self.assertRaises(SystemExit) as raised:
                receipt.main()
            self.assertNotIn("private", str(raised.exception))

    def test_any_application_commit_is_verified_against_its_own_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = make_assets(directory)
            manifest["source"]["commit"] = OTHER
            manifest["qualification"]["source_commit"] = OTHER
            receipt.save_manifest(directory, manifest)
            with patch.object(receipt, "git_bytes", side_effect=lambda root, rev, name: tree_bytes(root, COMMIT if rev == OTHER else rev, name)), \
                 patch.object(receipt, "commit_exists"), patch.object(receipt, "capture", return_value=str(EPOCH)):
                self.assertEqual(receipt.verify(directory, OTHER, TAG, True, RECIPE, Path("fixture-tree"))["source"]["commit"], OTHER)
                # The tuple must still name exactly the commit the caller asked for.
                with self.assertRaises(ValueError):
                    receipt.verify(directory, COMMIT, TAG, True, RECIPE, Path("fixture-tree"))
                with self.assertRaises(ValueError):
                    receipt.verify(directory, "short", TAG, True, RECIPE, Path("fixture-tree"))

    def test_tag_validation_names_only_a_full_commit_and_the_fleet_namespace(self):
        with patch.object(receipt, "commit_exists") as exists:
            for commit, tag in (("short", TAG), (OTHER, "stronk-omp-legacy"), (OTHER.upper(), TAG)):
                with self.subTest(commit=commit, tag=tag), self.assertRaises(ValueError):
                    receipt.validate_tag(Path("fixture-tree"), commit, tag, Path("public-signers"))
            exists.assert_not_called()


class PullerMirrorTests(unittest.TestCase):
    """The public manifest stays exactly what the fleet puller accepts; anything private lives in the signed evidence instead."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.addCleanup(patch.stopall)
        patch.object(receipt, "git_bytes", side_effect=tree_bytes).start()
        patch.object(receipt, "commit_exists").start()
        patch.object(receipt, "capture", return_value=str(EPOCH)).start()

    def payload(self, manifest):
        receipt.save_manifest(self.directory, manifest)
        return (self.directory / receipt.ASSETS[1]).read_bytes()

    def test_the_mirror_agrees_with_the_recipes_own_lists_and_pins(self):
        self.assertEqual(len(PULLER_COMMIT), 40)
        self.assertEqual(set(receipt.LOCKS), PULLER_FIELDS["locks"])
        self.assertEqual(set(receipt.RECIPES), PULLER_FIELDS["recipe"])
        self.assertEqual(set(receipt.TOOLS), PULLER_FIELDS["host_tools"])
        self.assertEqual(set(receipt.CHECKS), PULLER_FIELDS["checks"])
        self.assertEqual({"base_image": receipt.BASE_IMAGE, "bun_archive_sha256": receipt.BUN_SHA256,
                          "bazel_download_sha256": receipt.BAZEL_SHA256},
                         {name: PULLER_PINS[name] for name in ("base_image", "bun_archive_sha256", "bazel_download_sha256")})
        self.assertEqual(set(PULLER_TOOL_VERSIONS), PULLER_FIELDS["host_tools"])

    def test_a_qualified_manifest_and_its_checksums_match_the_pullers_key_sets(self):
        manifest = make_assets(self.directory)
        self.assertEqual(puller_problems((self.directory / receipt.ASSETS[1]).read_bytes(), qualified=True,
                                         sums=(self.directory / receipt.ASSETS[2]).read_text()), [])
        self.assertEqual(receipt.verify(self.directory, COMMIT, TAG, True, RECIPE, Path("fixture-tree")), manifest)

    def test_adding_the_fork_manifest_key_to_the_public_manifest_breaks_the_mirror(self):
        manifest = make_assets(self.directory)
        manifest["qualification"]["fork_manifest_sha256"] = FORK_SHA
        self.assertEqual(puller_problems(self.payload(manifest), qualified=True),
                         ["qualification: unexpected or missing fields ['fork_manifest_sha256']"])
        with self.assertRaisesRegex(ValueError, "Unexpected public fields"):  # and the recipe's own verification refuses it too
            receipt.verify(self.directory, COMMIT, TAG, True, RECIPE, Path("fixture-tree"))

    def test_a_new_field_at_any_depth_breaks_both_the_mirror_and_the_recipes_own_verification(self):
        paths = [(), ("source",), ("build_inputs",), ("build_inputs", "locks"), ("build_inputs", "recipe"),
                 ("build_inputs", "host_tools"), ("build_inputs", "host_tools", "bun"), ("asset",), ("runtime",),
                 ("runtime", "binary"), ("runtime", "native_baseline"), ("runtime", "native_baseline", "elf"), ("checks",),
                 ("qualification",), ("qualification", "checks"), ("qualification", "environment")]
        for path in paths:
            with self.subTest(path=".".join(path) or "top level"):
                manifest = make_assets(self.directory)
                target = manifest
                for step in path:
                    target = target[step]
                target["fork_manifest_sha256"] = FORK_SHA
                self.assertTrue(puller_problems(self.payload(manifest), qualified=True))
                with self.assertRaises(ValueError):
                    receipt.verify(self.directory, COMMIT, TAG, True, RECIPE, Path("fixture-tree"))

    def test_a_missing_field_or_a_private_looking_value_breaks_the_mirror(self):
        manifest = make_assets(self.directory)
        del manifest["qualification"]["environment"]["glibc"]
        self.assertEqual(puller_problems(self.payload(manifest), qualified=True),
                         ["qualification.environment: unexpected or missing fields ['glibc']"])
        manifest = make_assets(self.directory)
        manifest["build_inputs"]["host_tools"]["cmake"]["version"] = "cmake version 3.31.0 at /home/builder"
        self.assertTrue(puller_problems(self.payload(manifest), qualified=True))
        manifest = make_assets(self.directory)
        manifest["source"]["tag"] = "contact 10.1.2.3"
        self.assertEqual(puller_problems(self.payload(manifest), qualified=True), ["a string value looks private"])
        manifest = make_assets(self.directory)
        self.assertEqual(puller_problems(self.payload(manifest).replace(b",", b", "), qualified=True), ["manifest: noncanonical bytes"])

    def test_a_freshly_built_manifest_from_the_recipes_own_builder_matches_the_pullers_key_sets(self):
        header = bytearray(64)
        header[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", header, 18, 62)
        outputs = {"bun": "1.4.4\n", "bazel": "bazel 9.2.0\n", "rustc": TOOL_VERSIONS["rustc"] + "\n",
                   "cargo": TOOL_VERSIONS["cargo"] + "\n", "cmake": "cmake version 3.31.0\n\nCMake suite maintained and supported.\n",
                   "ninja": "1.12.1\n"}
        readelf = {"--program-headers": "  [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]\n",
                   "--version-info": "  0x0010: Name: GLIBC_2.34  Flags: none  Version: 3\n  0x0020: Name: GLIBC_2.17\n",
                   "--dynamic": " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]\n"}
        for flavor, committed in (("candidate", False), ("release", True)):
            with self.subTest(flavor=flavor), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                src, recipe, tools, out = base / "src", base / "recipe", base / "tools", base / "out"
                for name in receipt.LOCKS:
                    (src / name).parent.mkdir(parents=True, exist_ok=True)
                    (src / name).write_bytes(TREE[name])
                (src / "packages/coding-agent").mkdir(parents=True)
                (src / "packages/coding-agent/package.json").write_bytes(TREE["packages/coding-agent/package.json"])
                native = src / "packages/natives/native/pi_natives.linux-x64-baseline.node"
                native.parent.mkdir(parents=True)
                native.write_bytes(bytes(header) + b"native")
                recipe.mkdir()
                for name in receipt.RECIPES:
                    (recipe / name).write_bytes(RECIPE_TREE["scripts/" + name])
                tools.mkdir()
                for name in receipt.TOOLS:
                    (tools / name).write_bytes(b"tool " + name.encode())
                out.mkdir()
                (out / receipt.ASSETS[0]).write_bytes(bytes(header) + b"binary")
                real_path = Path

                def remap(*parts):
                    path = real_path(*parts)
                    for prefix, target in (("/src", src), ("/recipe", recipe)):
                        text = str(path)
                        if text == prefix or text.startswith(prefix + "/"):
                            return target / text[len(prefix):].lstrip("/")
                    return path

                def capture(*arguments):
                    if arguments[0] == "readelf":
                        return readelf[arguments[1]]
                    if arguments[0] == "rustup":
                        return str(tools / arguments[2])
                    return "package=1.0\n" if arguments[0] == "dpkg-query" else outputs[arguments[0]]

                environment = {"SOURCE_COMMIT": COMMIT, "SOURCE_TAG": TAG if committed else "", "SOURCE_TAG_OBJECT": TAG_OID if committed else "",
                               "SOURCE_DATE_EPOCH": str(EPOCH), "RECIPE_COMMITTED": "1" if committed else "0",
                               "RECIPE_COMMIT": RECIPE if committed else "", "BASE_IMAGE": receipt.BASE_IMAGE,
                               "DEBIAN_SNAPSHOT": PULLER_PINS["debian_snapshot"], "BUN_SHA256": receipt.BUN_SHA256,
                               "BAZEL_SHA256": receipt.BAZEL_SHA256}
                with patch.dict(os.environ, environment), patch.object(receipt, "Path", remap), \
                     patch.object(receipt, "capture", capture), patch.object(receipt, "which", lambda tool: str(tools / tool)):
                    receipt.create(out)
                payload = (out / receipt.ASSETS[1]).read_bytes()
                self.assertEqual(puller_problems(payload, qualified=False, sums=(out / receipt.ASSETS[2]).read_text()), [])
                manifest = receipt.strict_json(payload)
                self.assertIsNone(manifest["qualification"])
                self.assertEqual(manifest["runtime"]["binary"]["glibc_required"], "2.34")


if __name__ == "__main__":
    unittest.main()
