#!/usr/bin/env python3
"""Offline qualification fixtures: no Docker, Bun, OMP, build, or network execution."""
import argparse
import ast
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import struct
import subprocess
import tempfile
import tarfile
import unittest
from unittest.mock import Mock, patch
from test_linux_amd64_receipt import REAL_RUN, signing_fixture


SPEC = importlib.util.spec_from_file_location("qualify_linux_amd64", Path(__file__).with_name("linux-amd64-qualify.py"))
qualify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qualify)
receipt = qualify.receipt
IMAGE_DIGEST = "sha256:" + "1" * 64
COMMIT = "5e43891a87140fb0972c982f3027f0228c4f6378"
IMAGE = "registry.invalid/private-account/runtime@" + IMAGE_DIGEST
RECIPE = "a" * 40
TAG = "stronk-omp-s1-2026.10.16.0001"


def fixture(directory, committed=False):
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", header, 18, 62)
    (directory / receipt.ASSETS[0]).write_bytes(header)
    elf = {"format": "ELF64-x86-64", "interpreter": "ld-linux-x86-64.so.2", "glibc_required": "2.34", "needed_libraries": ["libc.so.6"]}
    native_elf = dict(elf, interpreter=None, glibc_required="2.28")
    manifest = {
        "schema": 2, "repository": receipt.REPOSITORY, "target": "linux-amd64", "version": "18.8.0",
        "source": {"commit": COMMIT, "tag": TAG if committed else None,
                   "tag_object": "b" * 40 if committed else None, "source_date_epoch": 1,
                   "recipe_committed": committed, "recipe_commit": RECIPE if committed else None},
        "build_inputs": {
            "base_image": receipt.BASE_IMAGE, "debian_snapshot": "20260813T000000Z", "bun_archive_sha256": receipt.BUN_SHA256,
            "bazel_download_sha256": receipt.BAZEL_SHA256, "system_packages_sha256": "0" * 64,
            "host_tools": {tool: {"version": "1", "sha256": "0" * 64} for tool in receipt.TOOLS},
            "locks": {lock: "0" * 64 for lock in receipt.LOCKS}, "recipe": {name: "0" * 64 for name in receipt.RECIPES}},
        "asset": {"name": receipt.ASSETS[0], "size": len(header), "sha256": receipt.digest(directory / receipt.ASSETS[0])},
        "runtime": {"binary": elf, "native_baseline": {"sha256": "2" * 64, "elf": native_elf},
                    "cpu": "x86-64-v2", "native_variant": "baseline", "fully_static": False},
        "checks": {check: "passed" if check == "elf" else "not_run" for check in receipt.CHECKS}, "qualification": None,
    }
    receipt.save_manifest(directory, manifest)
    return manifest


START, END = "<!-- stronk-omp:fork-contracts:start -->", "<!-- stronk-omp:fork-contracts:end -->"
# Shapes taken from the workstation's real registry: several files per command and filters with odd characters.
FORK_CONTRACTS = {
    "alpha-contract": ["bun test packages/a/test/alpha.test.ts",
                       "bun test packages/a/test/alpha.test.ts --test-name-pattern 'inherits the wrapper call.s signal'"],
    "beta-contract": ["bun test packages/b/test/beta.test.ts packages/b/test/nested/gamma.test.ts"],
}


def fork_manifest(contracts=None, edit=None):
    """A registry in the updater's shape, with an inactive contract the recipe must ignore entirely."""
    contracts = FORK_CONTRACTS if contracts is None else contracts
    entries = [{"id": name, "title": f"Title of {name}", "status": "active", "verification": list(commands)}
               for name, commands in contracts.items()]
    entries.insert(1, {"id": "retired-contract", "title": "Retired", "status": "retired", "verification": ["sh -c 'ignored'"]})
    value = {"schemaVersion": 1, "requireDeclaredPaths": False,
             "readme": {"path": "README.md", "startMarker": START, "endMarker": END}, "contracts": entries}
    if edit:
        edit(value)
    return json.dumps(value, indent=2).encode() + b"\n"


FORK_DATA = fork_manifest()
FORK_SHA = hashlib.sha256(FORK_DATA).hexdigest()


def fork_file(directory, data=FORK_DATA):
    path = Path(directory) / "fork_boundary.json"
    path.write_bytes(data)
    return path


def active(data=FORK_DATA):
    return [item for item in json.loads(data)["contracts"] if item["status"] == "active"]


def readme_text(data=FORK_DATA, ids=None, titles=None):
    chosen = [item["id"] for item in active(data)] if ids is None else ids
    names = {item["id"]: item["title"] for item in json.loads(data)["contracts"]} | (titles or {})
    lines = "".join(f"- `{name}`: {names.get(name, 'Unreviewed')}\n" for name in chosen)
    return f"# Fixture application\n\nText before.\n\n{START}\n{lines}{END}\n\nText after.\n"


def success(manifest):
    return {
        "binary_sha256": manifest["asset"]["sha256"], "source_commit": manifest["source"]["commit"],
        "recipe_commit": manifest["source"]["recipe_commit"], "fork_manifest_sha256": FORK_SHA,
        "environment": {"execution": "native-amd64", "cpu": "x86-64-v2", "glibc": "2.41", "loader": "ld-linux-x86-64.so.2", "runtime_image": IMAGE_DIGEST},
        "checks": {check: "passed" for check in receipt.CHECKS},
    }


def source_fixture(source, data=FORK_DATA, readme=None):
    source.mkdir(parents=True, exist_ok=True)
    (source / "README.md").write_text(readme_text(data) if readme is None else readme)
    for contract in active(data):
        for command in contract["verification"]:
            for item in shlex.split(command):
                if item.endswith(".test.ts"):
                    path = source / item
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("// offline fixture\n")


def fork_commands(data=FORK_DATA):
    return [[*shlex.split(command), "--timeout=30000"] for contract in active(data) for command in contract["verification"]]


class DaemonTests(unittest.TestCase):
    def test_native_architecture_only_queries(self):
        docker = ["docker", "--host", "unix:///runtime/docker.sock"]
        with patch.object(qualify, "docker_output", side_effect=["x86_64", "amd64", "verified"]) as output:
            self.assertEqual(qualify.approved_daemon(docker, IMAGE), IMAGE_DIGEST)
        self.assertEqual(output.call_args_list[0].args[1], ["info", "--format", "{{.Architecture}}"])
        self.assertEqual(output.call_args_list[1].args[1], ["image", "inspect", "--format", "{{.Architecture}}", IMAGE])

    def test_tagged_digest_selection_matches_untagged_cached_repo_digest(self):
        tagged = IMAGE.replace("@", ":approved@")

        def output(_docker, args):
            if args[0] == "info" or args[3] == "{{.Architecture}}":
                return "amd64"
            self.assertEqual(args[-1], tagged)
            # Docker's RepoDigests entries have repository@digest, without tags.
            return "verified" if json.dumps(IMAGE) in args[3] else ""

        with patch.object(qualify, "docker_output", side_effect=output):
            self.assertEqual(qualify.approved_daemon(["docker"], tagged), IMAGE_DIGEST)

    def test_arm_daemon_rejected_before_image_or_container(self):
        for architecture in ("arm64", "aarch64", "", "x86_64\nextra"):
            with self.subTest(architecture=architecture), patch.object(qualify, "docker_output", return_value=architecture) as output:
                with self.assertRaises(ValueError):
                    qualify.approved_daemon(["docker"], IMAGE)
                output.assert_called_once()

    def test_arm_image_on_amd64_daemon_rejected(self):
        with patch.object(qualify, "docker_output", side_effect=["amd64", "arm64"]):
            with self.assertRaises(ValueError):
                qualify.approved_daemon(["docker"], IMAGE)

    def test_unverified_image_digest_is_rejected(self):
        with patch.object(qualify, "docker_output", side_effect=["amd64", "amd64", ""]):
            with self.assertRaises(ValueError):
                qualify.approved_daemon(["docker"], IMAGE)

    def test_local_image_id_is_verified_without_registry_metadata(self):
        with patch.object(qualify, "docker_output", side_effect=["amd64", "amd64", IMAGE_DIGEST]) as output:
            self.assertEqual(qualify.approved_daemon(["docker"], IMAGE_DIGEST), IMAGE_DIGEST)
        self.assertEqual(output.call_args_list[-1].args[1],
                         ["image", "inspect", "--format", "{{.Id}}", IMAGE_DIGEST])
        with patch.object(qualify, "docker_output", side_effect=["amd64", "amd64", "sha256:" + "2" * 64]):
            with self.assertRaises(ValueError):
                qualify.approved_daemon(["docker"], IMAGE_DIGEST)

    def test_witness_container_has_exact_run_label(self):
        command = qualify.container_command(["docker"], IMAGE_DIGEST, Path("/fixture"), "fixture", "fixture-run")
        self.assertIn("org.stronk.omp-witness=fixture-run", command)
        with self.assertRaises(ValueError):
            qualify.container_command(["docker"], IMAGE_DIGEST, Path("/fixture"), "fixture", "bad label")

    def test_exported_source_tree_is_readable_under_private_umask(self):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as stream:
            for name in ("nested", "nested/deeper"):
                member = tarfile.TarInfo(name)
                member.type = tarfile.DIRTYPE
                member.mode = 0o700
                stream.addfile(member)
            for name, mode in (("nested/deeper/private.txt", 0o600), ("nested/tool", 0o755),
                               ("nested/writable.txt", 0o666), ("implicit/parents/data.txt", 0o644)):
                member = tarfile.TarInfo(name)
                member.mode = mode
                member.size = len(b"fixture\n")
                stream.addfile(member, io.BytesIO(b"fixture\n"))
            for name, target in (("file-link", "nested/deeper/private.txt"), ("directory-link", "nested"),
                                 ("dangling-link", "missing")):
                member = tarfile.TarInfo(name)
                member.type = tarfile.SYMTYPE
                member.linkname = target
                stream.addfile(member)
        with tempfile.TemporaryDirectory() as temporary, patch.object(
                qualify.subprocess, "check_output", return_value=archive.getvalue()):
            old = os.umask(0o077)
            try:
                reference_link = Path(temporary) / "reference-link"
                reference_link.symlink_to("missing")
                symlink_mode = reference_link.lstat().st_mode & 0o777
                destination = Path(temporary) / "source"
                qualify.export_source(Path("/fixture"), COMMIT, destination)
                self.assertEqual(destination.stat().st_mode & 0o777, 0o755)
                for path in (destination / "nested", destination / "nested/deeper",
                             destination / "implicit", destination / "implicit/parents"):
                    with self.subTest(directory=path.relative_to(destination)):
                        self.assertEqual(path.stat().st_mode & 0o777, 0o755)
                for name in ("nested/deeper/private.txt", "nested/tool", "nested/writable.txt", "implicit/parents/data.txt"):
                    path = destination / name
                    mode = path.stat().st_mode
                    with self.subTest(file=name):
                        self.assertTrue(mode & 0o004)
                        self.assertEqual(mode & 0o022, 0)
                        self.assertEqual(path.read_bytes(), b"fixture\n")
                self.assertEqual((destination / "nested/tool").stat().st_mode & 0o111, 0o111)
                self.assertEqual((destination / "nested/deeper/private.txt").stat().st_mode & 0o111, 0)
                for name, target in (("file-link", "nested/deeper/private.txt"), ("directory-link", "nested"),
                                     ("dangling-link", "missing")):
                    path = destination / name
                    self.assertTrue(path.is_symlink())
                    self.assertEqual(path.readlink(), Path(target))
                    self.assertEqual(path.lstat().st_mode & 0o777, symlink_mode)
                self.assertFalse((destination / "dangling-link").exists())
            finally:
                os.umask(old)

    def test_explicit_local_transport_and_ambient_override_rejection(self):
        with tempfile.TemporaryDirectory() as temporary, socket.socket(socket.AF_UNIX) as server:
            socket_path = Path(temporary) / "docker.sock"
            server.bind(str(socket_path))
            endpoint = "unix://" + str(socket_path)
            with patch.dict(os.environ, {}, clear=True), patch.object(subprocess, "check_output") as execute:
                self.assertEqual(receipt.validate_docker(endpoint), ["docker", "--host", endpoint])
                for name in ("DOCKER_HOST", "DOCKER_CONTEXT", "BUILDX_BUILDER", "DOCKER_TLS_VERIFY", "BUILDKIT_HOST"):
                    with patch.dict(os.environ, {name: "forbidden"}):
                        with self.assertRaises(ValueError):
                            receipt.validate_docker(endpoint)
                for remote in ("tcp://daemon.invalid:2376", "ssh://daemon.invalid", "default", "unix://relative"):
                    with self.assertRaises(ValueError):
                        receipt.validate_docker(remote)
                execute.assert_not_called()

    def test_bounded_container_has_only_owned_readonly_mounts(self):
        command = qualify.container_command(["docker", "--host", "unix:///runtime/docker.sock"], IMAGE, Path("/fixture"), "qualification-fixture")
        for required in ("--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                         "--pids-limit=1024", "--memory=12g", "--memory-swap=12g", "--cpus=4", "--user=65532:65532", "--log-driver=none"):
            self.assertIn(required, command)
        mounts = [command[index + 1] for index, item in enumerate(command) if item == "--mount"]
        self.assertEqual(len(mounts), 3)
        self.assertTrue(all(item.endswith(",readonly") for item in mounts))
        self.assertFalse(any("docker.sock" in item or ".ssh" in item or "sign" in item or "/home" in item for item in mounts))
        tmpfs = [command[index + 1] for index, item in enumerate(command) if item == "--tmpfs"]
        self.assertEqual(tmpfs, [
            "/workspace:rw,exec,nosuid,nodev,size=8g,mode=1777",
            "/runtime:rw,exec,nosuid,nodev,size=1g,mode=1777",
            "/home/qualification:rw,nosuid,nodev,size=1g,mode=1777",
            "/tmp:rw,nosuid,nodev,size=2g,mode=1777",
        ])
        self.assertNotIn("--platform", command)
        self.assertNotIn("--privileged", command)
        self.assertEqual(command[-3:], ["--entrypoint=/bin/sh", IMAGE, "/recipe/linux-amd64-smoke.sh"])


class ForkManifestTests(unittest.TestCase):
    def load(self, data, expected=None):
        with tempfile.TemporaryDirectory() as temporary:
            return qualify.load_fork_manifest(fork_file(temporary, data), hashlib.sha256(data).hexdigest() if expected is None else expected)

    def refuses(self, data, fragment, expected=None):
        with self.assertRaises(receipt.RouteError) as raised:
            self.load(data, expected)
        self.assertIn(fragment, str(raised.exception))

    def test_a_valid_registry_loads_with_its_hash_and_exact_bytes(self):
        manifest, digest, data = self.load(FORK_DATA)
        self.assertEqual((digest, data), (FORK_SHA, FORK_DATA))
        self.assertEqual([item["id"] for item in qualify.active_contracts(manifest)], ["alpha-contract", "beta-contract"])
        with tempfile.TemporaryDirectory() as temporary:  # the check mode may run without a stated hash
            self.assertEqual(qualify.load_fork_manifest(fork_file(temporary))[1], FORK_SHA)

    def test_a_missing_unreadable_or_irregular_registry_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            real = fork_file(directory)
            (directory / "link.json").symlink_to(real)
            for path in (directory / "missing.json", directory, directory / "link.json", None):
                with self.subTest(path=str(path)), self.assertRaises(receipt.RouteError) as raised:
                    qualify.load_fork_manifest(path, FORK_SHA)
                self.assertIn("The fork manifest is missing or unreadable", str(raised.exception))
                self.assertNotIn(temporary, str(raised.exception))

    def test_a_registry_over_the_fixed_cap_is_refused_and_one_at_the_cap_is_accepted(self):
        cap = qualify.FORK_MANIFEST_CAP
        self.refuses(FORK_DATA + b" " * cap, "exceeds its size cap")
        self.refuses(b"x" * (cap + 1), "exceeds its size cap")
        padded = FORK_DATA + b" " * (cap - len(FORK_DATA))
        self.assertEqual(len(padded), cap)
        self.assertEqual(self.load(padded)[1], hashlib.sha256(padded).hexdigest())

    def test_a_registry_swapped_after_it_was_hashed_is_refused(self):
        weaker = fork_manifest({"alpha-contract": ["bun test packages/a/test/alpha.test.ts"], "beta-contract": ["bun test packages/b/test/beta.test.ts"]})
        self.assertNotEqual(weaker, FORK_DATA)
        self.refuses(weaker, "differs from its stated SHA-256", expected=FORK_SHA)
        for malformed in ("abc", FORK_SHA.upper(), FORK_SHA[:-1], "x" * 64):
            with self.subTest(expected=malformed[:8]):
                self.refuses(FORK_DATA, "differs from its stated SHA-256", expected=malformed)

    def test_a_registry_that_is_not_the_updaters_shape_is_refused(self):
        def contract(index, **changes):
            return lambda value: value["contracts"][index].update(changes)

        def drop(index, key):
            return lambda value: value["contracts"][index].pop(key)

        cases = {
            "wrong schema": (lambda value: value.update(schemaVersion=2), "unsupported schema"),
            "boolean schema": (lambda value: value.update(schemaVersion=True), "unsupported schema"),
            "declared paths required": (lambda value: value.update(requireDeclaredPaths=True), "unsupported schema"),
            "foreign marker": (lambda value: value["readme"].update(startMarker="<!-- other -->"), "README declaration"),
            "absolute readme": (lambda value: value["readme"].update(path="/etc/passwd"), "README declaration"),
            "parent readme": (lambda value: value["readme"].update(path="../README.md"), "README declaration"),
            "no readme": (lambda value: value.pop("readme"), "README declaration"),
            "no contracts": (lambda value: value.update(contracts=[]), "holds no contracts"),
            "no active contract": (lambda value: [item.update(status="deferred") for item in value["contracts"]], "no active contract"),
            "repeated id": (contract(2, id="alpha-contract"), "invalid or repeated"),
            "id with capitals": (contract(0, id="Alpha_Contract"), "invalid or repeated"),
            "unknown status": (contract(0, status="enabled"), "invalid status (alpha-contract)"),
            "unhashable status": (contract(0, status=["active"]), "invalid status (alpha-contract)"),
            "blank title": (contract(0, title="  "), "no title (alpha-contract)"),
            "no verification": (drop(0, "verification"), "declares no verification (alpha-contract)"),
            "empty verification": (contract(0, verification=[]), "declares no verification (alpha-contract)"),
            "contract not an object": (lambda value: value["contracts"].append("alpha"), "not an object"),
        }
        for name, (edit, fragment) in cases.items():
            with self.subTest(case=name):
                self.refuses(fork_manifest(edit=edit), fragment)
        for name, data in {"not json": b"{", "empty": b"", "a list": b"[]", "invalid UTF-8": b"\xff\xfe",
                           "repeated key": FORK_DATA.replace(b'"schemaVersion": 1', b'"schemaVersion": 1, "schemaVersion": 1', 1)}.items():
            with self.subTest(case=name):
                self.refuses(data, "not valid JSON" if name in ("not json", "empty", "invalid UTF-8", "repeated key") else "unsupported schema")

    def test_only_active_contracts_are_judged(self):
        # An inactive entry may name anything; it is neither parsed nor run.
        manifest, _, _ = self.load(fork_manifest(edit=lambda value: value["contracts"][1].update(verification=["rm -rf / | sh"])))
        self.assertEqual(len(qualify.active_contracts(manifest)), 2)


class VerificationRuleTests(unittest.TestCase):
    """The updater's parse_fork_verification, mirrored: argv only, never a shell, never outside the application tree."""

    def test_accepted_shapes_become_plain_argv(self):
        self.assertEqual(qualify.parse_verification("bun test packages/a/test/alpha.test.ts"),
                         ["bun", "test", "packages/a/test/alpha.test.ts"])
        self.assertEqual(qualify.parse_verification("bun test a.test.ts --test-name-pattern 'inherits the wrapper call.s signal'")[-1],
                         "inherits the wrapper call.s signal")
        self.assertEqual(qualify.parse_verification("cargo test -p crate some::test"), ["cargo", "test", "-p", "crate", "some::test"])

    def test_every_unsafe_or_malformed_command_is_refused_with_a_fixed_reason(self):
        cases = {
            "sh -c 'bun test a.test.ts'": "must start with bun test or cargo test",
            "bash -lc 'bun test a.test.ts'": "must start with bun test or cargo test",
            "bun install": "must start with bun test or cargo test",
            "bun test": "must start with bun test or cargo test",
            "npm test a.test.ts": "must start with bun test or cargo test",
            "bun test a.test.ts | tee out": "contains shell syntax",
            "bun test a.test.ts || true": "contains shell syntax",
            "bun test a.test.ts && id": "contains shell syntax",
            "bun test a.test.ts; id": "contains shell syntax",
            "bun test a.test.ts > out": "contains shell syntax",
            "bun test a.test.ts < in": "contains shell syntax",
            "bun test $(id).test.ts": "contains shell syntax",
            "bun test `id`.test.ts": "contains shell syntax",
            "bun test a.test.ts\nid": "contains shell syntax",
            "bun test /etc/passwd.test.ts": "leaves the application tree",
            "bun test ../outside.test.ts": "leaves the application tree",
            "bun test dir/../../outside.test.ts": "leaves the application tree",
            "bun test a.test.ts --preload=/abs/hook.ts": "leaves the application tree",
            "bun test https://example.invalid/a.test.ts": "names an external URI",
            "bun test a.test.ts --preload=file:hook": "names an external URI",
            "bun test ./a.test.ts": "not an exact relative path",
            "bun test dir//a.test.ts": "not an exact relative path",
            "bun test dir/*.test.ts": "not an exact relative path",
            "bun test dir/[a].test.ts": "not an exact relative path",
            "bun test 'unterminated": "cannot be parsed",
            "": "is empty",
            "   ": "is empty",
            None: "is empty",
            7: "is empty",
        }
        for command, reason in cases.items():
            with self.subTest(command=command), self.assertRaises(receipt.RouteError) as raised:
                qualify.parse_verification(command)
            self.assertIn(reason, str(raised.exception))

    def test_the_recipe_only_runs_bun_test_files_and_name_filters(self):
        args, paths = qualify.registry_command("bun test a.test.ts b/c.test.ts --test-name-pattern 'first filter'")
        self.assertEqual((args, paths), (["bun", "test", "a.test.ts", "b/c.test.ts", "--test-name-pattern", "first filter"],
                                          ["a.test.ts", "b/c.test.ts"]))
        for command, reason in {"cargo test -p crate": "cannot be run by this recipe",
                                "bun test a.test.ts --timeout=5": "neither a test file nor a name filter",
                                "bun test a.test.ts --bail": "neither a test file nor a name filter",
                                "bun test a.ts": "neither a test file nor a name filter",
                                "bun test --test-name-pattern x": "has no tests",
                                "bun test a.test.ts --test-name-pattern": "Invalid boundary filter"}.items():
            with self.subTest(command=command), self.assertRaises(receipt.RouteError) as raised:
                qualify.registry_command(command)
            self.assertIn(reason, str(raised.exception))

    def test_a_registry_whose_active_contract_has_an_unsafe_command_is_refused_naming_only_the_contract(self):
        for command in ("sh -c 'bun test packages/a/test/alpha.test.ts'", "bun test packages/a/test/alpha.test.ts | cat",
                        "bun test /abs/alpha.test.ts", "cargo test -p natives"):
            data = fork_manifest(edit=lambda value, command=command: value["contracts"][0]["verification"].append(command))
            with self.subTest(command=command), tempfile.TemporaryDirectory() as temporary, self.assertRaises(receipt.RouteError) as raised:
                qualify.load_fork_manifest(fork_file(temporary, data), hashlib.sha256(data).hexdigest())
            self.assertTrue(str(raised.exception).endswith("(alpha-contract)"), str(raised.exception))
            self.assertNotIn(command, str(raised.exception))


class BoundaryTests(unittest.TestCase):
    def manifest(self, data=FORK_DATA):
        return qualify.parse_fork_manifest(data)

    def test_every_active_registry_command_runs_in_order_without_shell(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            source_fixture(source)
            self.assertEqual(qualify.boundary_commands(source, self.manifest()), fork_commands())
            staged = qualify.boundary_commands(source, self.manifest(), with_stages=True)
            self.assertEqual([name for name, _ in staged], [
                "qualify-boundary-alpha-contract-1", "qualify-boundary-alpha-contract-2", "qualify-boundary-beta-contract-1"])
            self.assertTrue(all(command[:2] == ["bun", "test"] and command[-1] == "--timeout=30000" for _, command in staged))
            self.assertTrue(all(qualify.valid_stage(name, frozenset(name for name, _ in staged)) for name, _ in staged))

    def test_the_registry_alone_decides_which_contracts_run(self):
        data = fork_manifest({"gamma-contract": ["bun test packages/g/test/gamma.test.ts"]})
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            source_fixture(source, data)
            self.assertEqual(qualify.boundary_commands(source, self.manifest(data)),
                             [["bun", "test", "packages/g/test/gamma.test.ts", "--timeout=30000"]])

    def test_a_readme_block_that_is_not_exactly_the_active_contracts_in_order_is_refused(self):
        stale = "fork-contract block differs from the manifest's active contracts or their order"
        ids = ["alpha-contract", "beta-contract"]
        cases = {
            "a missing id": (readme_text(ids=ids[1:]), stale),
            "an extra id": (readme_text(ids=ids + ["unreviewed-contract"]), stale),
            "a repeated id": (readme_text(ids=ids + ["alpha-contract"]), stale),
            "a reordered pair": (readme_text(ids=ids[::-1]), stale),
            "an inactive contract listed": (readme_text(ids=["alpha-contract", "retired-contract", "beta-contract"]), stale),
            "a changed title": (readme_text(titles={"beta-contract": "Another title"}), stale),
            "an empty block": (readme_text(ids=[]), stale),
            "no markers": ("# Fixture\n\nno contract block here\n", "exactly one fork-contract start marker and one end marker"),
            "two blocks": (readme_text() + readme_text(), "exactly one fork-contract start marker and one end marker"),
            "reversed markers": (readme_text().replace(START, "@@").replace(END, START).replace("@@", END),
                                 "markers are reversed"),
        }
        for name, (readme, reason) in cases.items():
            with self.subTest(case=name), tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary)
                source_fixture(source, readme=readme)
                with self.assertRaises(receipt.RouteError) as raised:
                    qualify.boundary_commands(source, self.manifest())
                self.assertIn(reason, str(raised.exception))
        with tempfile.TemporaryDirectory() as temporary:  # the control: the same text around the exact block is fine
            source = Path(temporary)
            source_fixture(source, readme=readme_text() + "\nMore text after the block.\n")
            self.assertEqual(len(qualify.boundary_commands(source, self.manifest())), 3)

    def test_an_active_contract_whose_test_file_is_missing_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            source_fixture(source)
            (source / "packages/b/test/nested/gamma.test.ts").unlink()
            with self.assertRaises(receipt.RouteError) as raised:
                qualify.boundary_commands(source, self.manifest())
            self.assertIn("missing from the application: packages/b/test/nested/gamma.test.ts", str(raised.exception))
            self.assertNotIn(temporary, str(raised.exception))

    def test_a_readme_or_test_that_is_a_link_out_of_the_tree_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as outside:
            source = Path(temporary)
            source_fixture(source)
            (Path(outside) / "alpha.test.ts").write_text("// outside\n")
            (source / "packages/a/test/alpha.test.ts").unlink()
            (source / "packages/a/test/alpha.test.ts").symlink_to(Path(outside) / "alpha.test.ts")
            with self.assertRaises(receipt.RouteError):
                qualify.boundary_commands(source, self.manifest())
            source_fixture(source)
            (source / "README.md").unlink()
            (source / "README.md").symlink_to(Path(outside) / "alpha.test.ts")
            with self.assertRaises(receipt.RouteError):
                qualify.boundary_commands(source, self.manifest())

    def test_filters_are_preserved_for_repeated_files(self):
        data = fork_manifest({"fixture": ["bun test fixture.test.ts --test-name-pattern 'first filter'",
                                          "bun test fixture.test.ts --test-name-pattern 'second filter'"]})
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            source_fixture(source, data)
            self.assertEqual(qualify.boundary_commands(source, self.manifest(data)), [
                ["bun", "test", "fixture.test.ts", "--test-name-pattern", "first filter", "--timeout=30000"],
                ["bun", "test", "fixture.test.ts", "--test-name-pattern", "second filter", "--timeout=30000"],
            ])

    def files(self, data=FORK_DATA, readme=None):
        files = {"README.md": (readme_text(data) if readme is None else readme).encode()}
        for contract in active(data):
            for command in contract["verification"]:
                files.update({item: b"" for item in shlex.split(command) if item.endswith(".test.ts")})
        return files

    def preflight(self, files, data=FORK_DATA, commit="c" * 40):
        with patch.object(receipt, "check_toolchain", return_value="18.12.6") as toolchain, \
             patch.object(receipt, "git_has", side_effect=lambda _root, _rev, path: path in files), \
             patch.object(receipt, "git_bytes", side_effect=lambda _root, _rev, path: files[path]):
            result = qualify.application_preflight(Path("fixture-tree"), commit, self.manifest(data))
        toolchain.assert_called_once_with(Path("fixture-tree"), commit)
        return result

    def test_application_preflight_accepts_a_matching_application_without_a_checkout(self):
        self.assertEqual(self.preflight(self.files()), ("18.12.6", 2))
        data = fork_manifest({"only-contract": ["bun test x/only.test.ts"]})
        self.assertEqual(self.preflight(self.files(data), data), ("18.12.6", 1))

    def test_application_preflight_refuses_a_changed_block_or_a_missing_test_with_a_clear_reason(self):
        ids = ["alpha-contract", "beta-contract"]
        for files, reason in (
                (self.files(readme=readme_text(ids=ids[1:])), "fork-contract block differs from the manifest's active contracts"),
                (self.files(readme=readme_text(ids=ids + ["unreviewed-contract"])), "fork-contract block differs"),
                (self.files(readme=readme_text(ids=ids[::-1])), "fork-contract block differs"),
                ({**self.files(), "README.md": b"no contract block here\n"}, "exactly one fork-contract start marker"),
                ({**self.files(), "README.md": b"\xff\xfe"}, "not valid UTF-8"),
                ({name: data for name, data in self.files().items() if name != "README.md"}, "has no README")):
            with self.subTest(reason=reason), self.assertRaises(receipt.RouteError) as raised:
                self.preflight(files)
            self.assertIn(reason, str(raised.exception))
        files = self.files()
        del files["packages/b/test/nested/gamma.test.ts"]
        with self.assertRaises(receipt.RouteError) as raised:
            self.preflight(files)
        self.assertIn("missing from the application: packages/b/test/nested/gamma.test.ts", str(raised.exception))

    def test_toolchain_mismatch_surfaces_before_any_contract_work(self):
        with patch.object(receipt, "check_toolchain", side_effect=receipt.RouteError("The application needs Bazel 9.3.0")), \
             patch.object(receipt, "git_bytes") as read:
            with self.assertRaises(receipt.RouteError):
                qualify.application_preflight(Path("fixture-tree"), "c" * 40, self.manifest())
        read.assert_not_called()


class BaselineTests(unittest.TestCase):
    FLAGS = {"ssse3", "sse4_1", "sse4_2", "popcnt", "cx16", "lahf_lm", "pni"}

    def test_avx2_does_not_change_baseline_expectation(self):
        qualify.baseline_cpu("x86_64", self.FLAGS)
        qualify.baseline_cpu("x86_64", self.FLAGS | {"avx2"})
        with self.assertRaises(ValueError):
            qualify.baseline_cpu("aarch64", self.FLAGS | {"avx2"})
        with self.assertRaises(ValueError):
            qualify.baseline_cpu("x86_64", self.FLAGS - {"popcnt"})

    def test_extracted_baseline_digest_and_elf_must_match(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = fixture(directory)
            native_dir = directory / "natives"
            native_dir.mkdir()
            native = native_dir / "pi_natives.linux-x64-baseline.node"
            native.write_bytes(b"baseline fixture")
            manifest["runtime"]["native_baseline"]["sha256"] = receipt.digest(native)
            stdout = b"--oauth-account= --require-runtime-contract= runtime-requirements: 1\n"
            stderr = b"[startup] native:require:pi_natives.linux-x64-baseline.node\n[startup] native:extractEmbeddedAddon:start\n[startup] native:loadNative:done\n"
            with patch.object(receipt, "elf", return_value=manifest["runtime"]["native_baseline"]["elf"]):
                self.assertEqual(qualify.native_help(stdout, stderr, native_dir, manifest), native)
                with self.assertRaises(ValueError):
                    qualify.native_help(stdout, stderr.replace(b"baseline.node", b"modern.node"), native_dir, manifest)
                native.write_bytes(b"changed native fixture")
                with self.assertRaises(ValueError):
                    qualify.native_help(stdout, stderr, native_dir, manifest)
                native.write_bytes(b"baseline fixture")
                (native_dir / "pi_natives.linux-x64-modern.node").write_bytes(b"unexpected")
                with self.assertRaises(ValueError):
                    qualify.native_help(stdout, stderr, native_dir, manifest)

    def test_dependency_attestation_detects_changed_bytes_and_escaping_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            modules = source / "node_modules"
            modules.mkdir()
            item = modules / "dependency.js"
            item.write_text("pinned")
            before = qualify.dependency_digest(source)
            item.write_text("modified")
            self.assertNotEqual(qualify.dependency_digest(source), before)
            (modules / "escape").symlink_to("../../outside")
            with self.assertRaises(ValueError):
                qualify.dependency_digest(source)


class PreparedRuntimeTests(unittest.TestCase):
    def prepare_fixture(self, root):
        assets = root / "assets"
        assets.mkdir()
        manifest = fixture(assets)
        prepared = root / "prepared"
        frozen = prepared / "source"
        source = root / "source"
        source.mkdir()
        frozen.mkdir(parents=True)
        modules = frozen / "node_modules"
        modules.mkdir()
        (modules / "dependency.js").write_text("frozen dependency")
        for name in receipt.LOCKS:
            (frozen / name).write_text("immutable lock")
            (source / name).write_text("immutable lock")
            manifest["build_inputs"]["locks"][name] = receipt.digest(frozen / name)
        bun = root / "bun-fixture"
        bun.write_bytes(b"pinned runtime fixture")
        manifest["build_inputs"]["host_tools"]["bun"]["sha256"] = receipt.digest(bun)
        grep = prepared / "native-grep-regression"
        grep.write_bytes(b"prebuilt test fixture")
        metadata = {"schema": 1, "source_commit": COMMIT, "bun_version": "1.4.4",
                    "locks": manifest["build_inputs"]["locks"], "dependency_tree_sha256": qualify.dependency_digest(frozen),
                    "native_grep_sha256": receipt.digest(grep)}
        (prepared / "dependencies.json").write_text(json.dumps(metadata))
        return source, prepared, manifest, bun

    def test_only_verified_prepared_dependencies_are_copied_without_resolution(self):
        class FakeRuntime:
            environment = {"PATH": "/fixture/bin"}
            calls = []

            def run(self, command, cwd, seconds):
                self.calls.append(command)
                return b"1.4.4\n", b""

        with tempfile.TemporaryDirectory() as temporary:
            source, prepared, manifest, bun = self.prepare_fixture(Path(temporary))
            runtime = FakeRuntime()
            with patch.object(qualify, "PREPARED", prepared), patch.object(qualify.shutil, "which", return_value=str(bun)), \
                 patch.object(receipt, "elf", return_value={"interpreter": "ld-linux-x86-64.so.2"}):
                self.assertEqual(qualify.prepare_dependencies(source, manifest, runtime), prepared / "native-grep-regression")
            self.assertEqual(runtime.calls, [["bun", "--version"],
                                            ["bun", "run", "--cwd", "packages/collab-web", "gen:tool-views"]])
            self.assertEqual((source / "node_modules/dependency.js").read_text(), "frozen dependency")

    def test_lock_or_dependency_changes_fail_before_any_command(self):
        for changed in ("bun.lock", "node_modules/dependency.js"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temporary:
                source, prepared, manifest, _bun = self.prepare_fixture(Path(temporary))
                (prepared / "source" / changed).write_text("changed")
                runtime = Mock()
                with patch.object(qualify, "PREPARED", prepared):
                    with self.assertRaises(ValueError):
                        qualify.prepare_dependencies(source, manifest, runtime)
                runtime.run.assert_not_called()
                self.assertFalse((source / "node_modules").exists())


class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.evidence = tempfile.TemporaryDirectory()
        self.addCleanup(self.evidence.cleanup)
        directory = Path(self.evidence.name)
        self.key, self.signers = signing_fixture(directory)
        self.attestation = directory / "qualification.json"

    def finalize(self, *args, fork=FORK_SHA):
        qualify.finalize(*args, self.key, self.attestation, fork_manifest_sha256=fork)

    def test_candidate_can_qualify_but_can_never_publish(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = fixture(directory)
            self.finalize(directory, manifest, success(manifest), IMAGE_DIGEST, False, COMMIT, "")
            completed = receipt.verify(directory, COMMIT, "", False, root=False)
            self.assertIs(completed["source"]["recipe_committed"], False)
            self.assertIsNone(completed["source"]["recipe_commit"])
            self.assertEqual(completed["checks"], {check: "passed" for check in receipt.CHECKS})
            with self.assertRaises(ValueError):
                receipt.verify(directory, COMMIT, "", True, root=False)
            self.assertEqual({item.name for item in directory.iterdir()}, set(receipt.ASSETS))
            receipt.verify_attestation(completed, self.attestation, self.signers)
            evidence = receipt.strict_json(self.attestation.read_bytes())
            self.assertEqual(evidence["mode"], "candidate")
            self.assertIsNone(evidence["recipe_commit"])
            self.assertEqual(evidence["manifest_sha256"], hashlib.sha256((directory / receipt.ASSETS[1]).read_bytes()).hexdigest())
            self.assertEqual(self.attestation.stat().st_mode & 0o777, 0o600)
            self.assertEqual(Path(str(self.attestation) + ".sig").stat().st_mode & 0o777, 0o600)

    def test_committed_tuple_qualifies_exactly(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = fixture(directory, committed=True)
            self.finalize(directory, manifest, success(manifest), IMAGE_DIGEST, False, COMMIT, RECIPE)
            completed = receipt.verify(directory, COMMIT, TAG, True, RECIPE, root=False)
            receipt.verify_attestation(completed, self.attestation, self.signers)
            self.assertEqual(receipt.strict_json(self.attestation.read_bytes()), {
                "schema": 2, "binary_sha256": receipt.digest(directory / receipt.ASSETS[0]),
                "source_commit": COMMIT, "recipe_commit": RECIPE, "fork_manifest_sha256": FORK_SHA,
                "runtime_image_digest": IMAGE_DIGEST, "mode": "release",
                "checks": {check: "passed" for check in receipt.CHECKS},
                "manifest_sha256": hashlib.sha256((directory / receipt.ASSETS[1]).read_bytes()).hexdigest(),
            })

    def test_incomplete_failed_extra_or_metadata_only_result_never_finalizes(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = fixture(directory)
            bad_results = []
            for check in receipt.CHECKS:
                for state in ("not_run", "failed"):
                    result = success(manifest)
                    result["checks"][check] = state
                    bad_results.append(result)
            missing = success(manifest)
            missing["checks"].pop("offline_session")
            extra = success(manifest)
            extra["raw_log"] = "forbidden"
            bad_results.extend((missing, extra, {"checks": {check: "passed" for check in receipt.CHECKS}}))
            original = (directory / receipt.ASSETS[1]).read_bytes()
            for result in bad_results:
                with self.assertRaises(ValueError):
                    self.finalize(directory, manifest, result, IMAGE_DIGEST, False, COMMIT, "")
                self.assertEqual((directory / receipt.ASSETS[1]).read_bytes(), original)
                self.assertFalse(self.attestation.exists())
                self.assertFalse(Path(str(self.attestation) + ".sig").exists())

    def test_altered_binary_or_manifest_never_finalizes(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = fixture(directory)
            with (directory / receipt.ASSETS[0]).open("ab") as binary:
                binary.write(b"changed")
            with self.assertRaises(ValueError):
                self.finalize(directory, manifest, success(manifest), IMAGE_DIGEST, False, COMMIT, "")
            manifest = fixture(directory)
            other = copy.deepcopy(manifest)
            other["source"]["source_date_epoch"] = 2
            receipt.save_manifest(directory, other)
            with self.assertRaises(ValueError):
                self.finalize(directory, manifest, success(manifest), IMAGE_DIGEST, False, COMMIT, "")

    def test_a_result_for_another_registry_never_finalizes_and_only_the_signed_record_carries_the_registry_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = fixture(directory)
            original = (directory / receipt.ASSETS[1]).read_bytes()
            with self.assertRaises(ValueError):
                self.finalize(directory, manifest, success(manifest), IMAGE_DIGEST, False, COMMIT, "", fork="e" * 64)
            self.assertEqual((directory / receipt.ASSETS[1]).read_bytes(), original)
            self.assertFalse(self.attestation.exists())
            self.finalize(directory, manifest, success(manifest), IMAGE_DIGEST, False, COMMIT, "")
            completed = receipt.verify(directory, COMMIT, "", False, root=False)
            # The public manifest keeps the fleet puller's exact qualification fields; the hash lives in the signed record only.
            self.assertNotIn("fork_manifest_sha256", completed["qualification"])
            self.assertNotIn(FORK_SHA.encode(), (directory / receipt.ASSETS[1]).read_bytes())
            self.assertEqual(receipt.strict_json(self.attestation.read_bytes())["fork_manifest_sha256"], FORK_SHA)
            receipt.verify_attestation(completed, self.attestation, self.signers, FORK_SHA)
            with self.assertRaises(ValueError):
                receipt.verify_attestation(completed, self.attestation, self.signers, "e" * 64)
            # The signed attestation binds the whole manifest, so the registry hash cannot change without a new signature.
            evidence = receipt.strict_json(self.attestation.read_bytes())
            self.assertEqual(evidence["manifest_sha256"], hashlib.sha256((directory / receipt.ASSETS[1]).read_bytes()).hexdigest())

    def test_wrong_tuple_or_environment_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = fixture(Path(temporary))
            for field, replacement in (("binary_sha256", "f" * 64), ("source_commit", "c" * 40), ("recipe_commit", RECIPE),
                                       ("fork_manifest_sha256", "f" * 64), ("fork_manifest_sha256", "short")):
                result = success(manifest)
                result[field] = replacement
                with self.assertRaises(ValueError):
                    qualify.validate_result(result, manifest, IMAGE_DIGEST, FORK_SHA)
            for field, replacement in (("execution", "emulated"), ("cpu", "x86-64-v3"), ("glibc", "2.17"),
                                       ("loader", "other.so"), ("runtime_image", "qualification/runtime:mutable")):
                result = success(manifest)
                result["environment"][field] = replacement
                with self.assertRaises(ValueError):
                    qualify.validate_result(result, manifest, IMAGE_DIGEST, FORK_SHA)


class HostFlowTests(unittest.TestCase):
    def run_fixture(self, directory, *, committed=False, fail=False, changed=False, duplicate=False, stages=b"", invalid_stages=False, run_id=""):
        assets, root = directory / "assets", directory / "root"
        assets.mkdir()
        (root / "scripts").mkdir(parents=True)
        manifest = fixture(assets, committed)
        for name in receipt.RECIPES:
            (root / "scripts" / name).write_text("offline recipe fixture\n")
            manifest["build_inputs"]["recipe"][name] = receipt.digest(root / "scripts" / name)
        receipt.save_manifest(assets, manifest)
        args = argparse.Namespace(commit=COMMIT, recipe_commit=RECIPE if committed else "", assets=assets,
                                  runtime_image=IMAGE, docker_socket="unix:///runtime/docker.sock", witness_run_id=run_id,
                                  fork_manifest=fork_file(directory), fork_manifest_sha256=FORK_SHA)
        args.attestation_key, signers = signing_fixture(directory)
        args.attestation = directory / "qualification.json"
        cleanup = Mock()

        def execute(command, **kwargs):
            if command[0] == "ssh-keygen":
                if "sign" in command:
                    self.assertEqual(command[command.index("-f") + 1], str(args.attestation_key))
                    self.assertNotIn("SSH_AUTH_SOCK", kwargs["env"])
                    self.assertNotIn("SSH_AGENT_PID", kwargs["env"])
                    self.assertNotIn("SSH_ASKPASS", kwargs["env"])
                return REAL_RUN(command, **kwargs)
            self.assertEqual(command[0], "docker")
            return cleanup(command, **kwargs)
        real_verify = receipt.verify
        calls = []

        def fake_output(command, **kwargs):
            calls.append(command)
            if "info" in command:
                return b"x86_64\n"
            if "image" in command:
                if command[command.index("--format") + 1] != "{{.Architecture}}":
                    return b"verified\n"
                return b"amd64\n"
            self.assertIn("run", command)
            self.assertIn("--config", command)
            work = Path(command[command.index("--config") + 1]).parent
            for child in ("input", "recipe"):
                self.assertEqual((work / child).stat().st_mode & 0o777, 0o755)
            request = receipt.strict_json((Path(command[command.index("--config") + 1]).parent / "input/request.json").read_bytes())
            self.assertEqual(request["runtime_image"], IMAGE_DIGEST)
            self.assertNotIn(b"private-account", json.dumps(request).encode())
            # The exact registry bytes the host hashed reach the container beside the request, read-only.
            self.assertEqual(request["fork_manifest_sha256"], FORK_SHA)
            self.assertEqual((work / "input/fork_boundary.json").read_bytes(), FORK_DATA)
            self.assertEqual((work / "input/fork_boundary.json").stat().st_mode & 0o777, 0o444)
            kwargs["stderr"].write(stages)
            if fail:
                raise subprocess.CalledProcessError(1, command, output=b"private fixture diagnostics")
            if changed:
                with (assets / receipt.ASSETS[0]).open("ab") as binary:
                    binary.write(b"changed")
            if duplicate:
                raw = json.dumps(success(manifest))
                if duplicate == "nested":
                    return raw.replace('"cli":', '"cli":"failed","cli":', 1).encode()
                return ('{"checks":{"cli":"failed"},' + raw[1:]).encode()
            return json.dumps(success(manifest)).encode()

        def archive(_root, _commit, destination):
            source_fixture(destination)

        with patch.object(receipt, "verify", side_effect=lambda path, commit, tag, release, recipe_commit="", root=None:
                          real_verify(path, commit, tag, release, recipe_commit, root=False)), \
             patch.object(receipt, "assert_recipes") as assert_recipes, \
             patch.object(receipt, "validate_docker", return_value=["docker", "--host", args.docker_socket]), \
             patch.object(receipt, "git_bytes", side_effect=lambda _root, _rev, name: (root / name).read_bytes()), \
             patch.object(qualify, "export_source", side_effect=archive), \
             patch.object(subprocess, "check_output", side_effect=fake_output), \
             patch.object(subprocess, "run", side_effect=execute):
            if fail or changed or duplicate or invalid_stages:
                with self.assertRaises((ValueError, subprocess.SubprocessError)):
                    qualify.qualify(args, root)
                self.assertIsNone(receipt.strict_json((assets / receipt.ASSETS[1]).read_text())["qualification"])
                self.assertFalse(args.attestation.exists())
            else:
                qualify.qualify(args, root)
                completed = receipt.strict_json((assets / receipt.ASSETS[1]).read_text())
                self.assertEqual(completed["qualification"],
                                 {name: value for name, value in success(manifest).items() if name != "fork_manifest_sha256"})
                receipt.verify_attestation(completed, args.attestation, signers, FORK_SHA)
                for name in receipt.ASSETS:
                    self.assertNotIn(b"private-account", (assets / name).read_bytes())
            self.assertEqual(assert_recipes.call_count, int(committed))
            cleanup.assert_called_once()
            self.assertEqual(cleanup.call_args.args[0][-3:-1], ["rm", "--force"])
            self.assertEqual(len(calls), 4)
            if run_id:
                # A fixed, run-scoped name lets the owner prove removal; the run label is the sweep key.
                self.assertEqual(cleanup.call_args.args[0][-1], f"omp-build-{run_id}-qualify")
                self.assertEqual(calls[3][calls[3].index("--name") + 1], f"omp-build-{run_id}-qualify")
                self.assertIn("org.stronk.omp-witness=" + run_id, calls[3])

    def test_run_scoped_container_name_is_fixed_and_removed_by_that_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.run_fixture(Path(temporary), run_id="b20261023153012-3fa9c1d2")

    def test_normal_candidate_and_committed_flows_with_fake_daemon(self):
        old = os.umask(0o077)
        try:
            for committed in (False, True):
                with self.subTest(committed=committed), tempfile.TemporaryDirectory() as temporary:
                    self.run_fixture(Path(temporary), committed=committed)
        finally:
            os.umask(old)

    def test_runtime_failure_or_host_binary_change_does_not_mark_success(self):
        for options in ({"fail": True}, {"changed": True}, {"duplicate": True}, {"duplicate": "nested"}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as temporary:
                self.run_fixture(Path(temporary), **options)

    def test_runtime_failure_forwards_only_allowlisted_stage_ids(self):
        with tempfile.TemporaryDirectory() as temporary, contextlib.redirect_stdout(io.StringIO()) as output:
            self.run_fixture(Path(temporary), fail=True, stages=b"qualify-help\nqualify-smoke\n")
        self.assertEqual(output.getvalue().splitlines(), [
            "qualify-host-inputs", "qualify-host-runtime", "qualify-host-source",
            "qualify-host-execute", "qualify-help", "qualify-smoke"])

    def test_unknown_runtime_stage_fails_without_forwarding_untrusted_text(self):
        with tempfile.TemporaryDirectory() as temporary, contextlib.redirect_stdout(io.StringIO()) as output:
            self.run_fixture(Path(temporary), stages=b"qualify-smoke\nqualify-unknown private diagnostic\n", invalid_stages=True)
        self.assertEqual(output.getvalue().splitlines(), [
            "qualify-host-inputs", "qualify-host-runtime", "qualify-host-source", "qualify-host-execute"])

    def test_a_boundary_stage_is_forwarded_only_when_the_registry_names_it(self):
        with tempfile.TemporaryDirectory() as temporary, contextlib.redirect_stdout(io.StringIO()) as output:
            self.run_fixture(Path(temporary), fail=True, stages=b"qualify-boundary-alpha-contract-2\nqualify-smoke\n")
        self.assertEqual(output.getvalue().splitlines()[-2:], ["qualify-boundary-alpha-contract-2", "qualify-smoke"])
        for stage in (b"qualify-boundary-alpha-contract-9\n", b"qualify-boundary-unknown-contract-1\n",
                      b"qualify-boundary-retired-contract-1\n", b"qualify-boundary-alpha-contract-1 extra\n"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as temporary, contextlib.redirect_stdout(io.StringIO()) as output:
                self.run_fixture(Path(temporary), stages=stage, invalid_stages=True)
            self.assertNotIn("qualify-boundary", output.getvalue())

    def test_failed_test_lines_from_a_failed_runtime_are_forwarded_and_nothing_else_is(self):
        stages = b"qualify-boundary-alpha-contract-2\nqualify-failed-suite-one-fails-twice\nqualify-failed-timeout\n"
        with tempfile.TemporaryDirectory() as temporary, contextlib.redirect_stdout(io.StringIO()) as output:
            self.run_fixture(Path(temporary), fail=True, stages=stages)
        self.assertEqual(output.getvalue().splitlines()[-3:],
                         ["qualify-boundary-alpha-contract-2", "qualify-failed-suite-one-fails-twice", "qualify-failed-timeout"])
        ninth = b"".join(b"qualify-failed-case-%d\n" % number for number in range(1, 10))
        for payload in (b"qualify-failed-a.b\n", b"qualify-failed-/etc/passwd\n", b"qualify-failed-" + b"a" * 98 + b"\n", ninth,
                        b"qualify-smoke\nqualify-failed-suite one\n"):
            with self.subTest(payload=payload[:40]), tempfile.TemporaryDirectory() as temporary, \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                self.run_fixture(Path(temporary), stages=payload, invalid_stages=True)
            self.assertEqual(output.getvalue().splitlines(),
                             ["qualify-host-inputs", "qualify-host-runtime", "qualify-host-source", "qualify-host-execute"])

    def test_a_missing_altered_or_unstated_registry_is_refused_before_any_daemon_contact(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            good = fork_file(directory)
            swapped = directory / "swapped.json"
            swapped.write_bytes(fork_manifest({"alpha-contract": ["bun test packages/a/test/alpha.test.ts"]}))
            for path, digest in ((directory / "missing.json", FORK_SHA), (swapped, FORK_SHA), (good, "0" * 64), (good, ""), (good, "short")):
                args = argparse.Namespace(commit=COMMIT, recipe_commit="", assets=directory / "assets", runtime_image=IMAGE,
                                          docker_socket="unix:///runtime/docker.sock", witness_run_id="",
                                          fork_manifest=path, fork_manifest_sha256=digest)
                with self.subTest(path=path.name, digest=digest[:6]), contextlib.redirect_stdout(io.StringIO()), \
                     patch.object(subprocess, "check_output", side_effect=AssertionError("contacted")), \
                     patch.object(subprocess, "run", side_effect=AssertionError("contacted")), \
                     patch.object(subprocess, "Popen", side_effect=AssertionError("contacted")):
                    with self.assertRaises(ValueError):
                        qualify.qualify(args, directory)

    def test_cli_sanitizes_subprocess_failures(self):
        arguments = ["qualify", "--commit", COMMIT, "--assets", "/fixture/assets", "--runtime-image", IMAGE,
                     "--docker-socket", "unix:///runtime/docker.sock",
                     "--attestation-key", "fixture-key", "--attestation", "fixture-attestation",
                     "--fork-manifest", "/fixture/fork_boundary.json", "--fork-manifest-sha256", FORK_SHA]
        output = io.StringIO()
        with patch.object(qualify.sys, "argv", arguments), patch.object(qualify, "qualify", side_effect=subprocess.CalledProcessError(1, "fixture", output=b"private diagnostics")), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(SystemExit) as failure:
                qualify.main()
        self.assertEqual(str(failure.exception), "Linux-amd64 qualification rejected; publication is not permitted.")
        self.assertEqual(output.getvalue(), "")

    def test_cli_rejects_invalid_arguments_without_echoing_values(self):
        output = io.StringIO()
        with patch.object(qualify.sys, "argv", ["qualify", "--unexpected=private-fixture"]), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(SystemExit) as failure:
                qualify.main()
        self.assertEqual(str(failure.exception), "Linux-amd64 qualification rejected; publication is not permitted.")
        self.assertEqual(output.getvalue(), "")


    def test_inside_failure_emits_only_the_stage_id(self):
        def failing_runtime():
            qualify.announce_stage("qualify-smoke", inside=True)
            raise ValueError("private diagnostic")

        with patch.object(qualify.sys, "argv", ["qualify", "--inside"]), \
             patch.object(qualify, "runtime_main", side_effect=failing_runtime), \
             contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as error:
            with self.assertRaises(SystemExit) as failure:
                qualify.main()
        self.assertEqual(failure.exception.code, 1)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(error.getvalue(), "qualify-smoke\n")


# Real Bun 1.4.2 output for failing tests (captured on the Mac): one `(fail) <describe > test> [timing]` line per failure.
BUN_FAILURES = "\n".join([
    "bun test v1.4.2 (744846f84)",
    "(pass) suite one > passes fine [0.02ms]",
    "(fail) suite one > fails with a path /home/ompbuild/x.ts and 10.1.2.3 and a@b.example [0.64ms]",
    "(fail) suite one > fails twice [0.26ms]",
    "(fail) suite one > unicode \u00fcn\u00ef \u65e5\u672c name [0.01ms]",
    "(fail) suite one > slow one [51.03ms]",
    "(fail) top level fail [0.40ms]",
    "",
    " 1 pass",
    " 5 fail",
    "Ran 6 tests across 1 file. [55.00ms]",
    "",
]).encode()
FAILED_LINES = [
    "qualify-failed-suite-one-fails-with-a-path-home-ompbuild-x-ts-and-10-1-2-3-and-a-b-example",
    "qualify-failed-suite-one-fails-twice",
    "qualify-failed-suite-one-unicode-n-name",
    "qualify-failed-suite-one-slow-one",
    "qualify-failed-top-level-fail",
]
PASSING = (0, b"bun test v1.4.2 (744846f84)\n",
           b"(pass) a > b [0.10ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]\n")
SETUP_STAGES = ["qualify-request", "qualify-cpu", "qualify-source", "qualify-binary", "qualify-libc", "qualify-version",
                "qualify-help", "qualify-smoke", "qualify-offline-session", "qualify-markers", "qualify-native-addon"]
BOUNDARY_STAGES = ["qualify-boundary-alpha-contract-1", "qualify-boundary-alpha-contract-2", "qualify-boundary-beta-contract-1"]

# Real Bun 1.4.2 output for failing tests, captured on the Mac from a throwaway test file that is not kept. Its folder is shown as
# the container's source root, and the fake token in one thrown message is the only other edit. Three shapes matter here: the
# error block (with its source context) comes before its `(fail)` line; an error class other than Error prints without the
# `error: ` prefix; and a test timeout adds a note line after its `(fail)` line.
REAL_HEAD = b"\n".join([
    b'',
    b'throwaway.test.ts:',
    b'error: noise from a passing test',
    b'(pass) suite one > passes fine [0.02ms]',
]) + b"\n"
REAL_FAILURES = {
    'expect toBe fails': b"\n".join([
        b' 5 | \ttest("passes fine", () => {',
        b' 6 | \t\tconsole.error("error: noise from a passing test");',
        b' 7 | \t\texpect(1).toBe(1);',
        b' 8 | \t});',
        b' 9 | \ttest("expect toBe fails", () => {',
        b'10 | \t\texpect(1).toBe(2);',
        b'                 ^',
        b'error: expect(received).toBe(expected)',
        b'',
        b'Expected: 2',
        b'Received: 1',
        b'',
        b'      at <anonymous> (/workspace/source/throwaway.test.ts:10:13)',
        b'(fail) suite one > expect toBe fails [0.18ms]',
    ]) + b"\n",
    'expect not toBe fails': b"\n".join([
        b' 8 | \t});',
        b' 9 | \ttest("expect toBe fails", () => {',
        b'10 | \t\texpect(1).toBe(2);',
        b'11 | \t});',
        b'12 | \ttest("expect not toBe fails", () => {',
        b'13 | \t\texpect(1).not.toBe(1);',
        b'                     ^',
        b'error: expect(received).not.toBe(expected)',
        b'',
        b'Expected: not 1',
        b'',
        b'      at <anonymous> (/workspace/source/throwaway.test.ts:13:17)',
        b'(fail) suite one > expect not toBe fails [0.03ms]',
    ]) + b"\n",
    'expect toEqual fails': b"\n".join([
        b'11 | \t});',
        b'12 | \ttest("expect not toBe fails", () => {',
        b'13 | \t\texpect(1).not.toBe(1);',
        b'14 | \t});',
        b'15 | \ttest("expect toEqual fails", () => {',
        b'16 | \t\texpect({ a: 1 }).toEqual({ a: 2 });',
        b'                        ^',
        b'error: expect(received).toEqual(expected)',
        b'',
        b'  {',
        b'-   "a": 2,',
        b'+   "a": 1,',
        b'  }',
        b'',
        b'- Expected  - 1',
        b'+ Received  + 1',
        b'',
        b'      at <anonymous> (/workspace/source/throwaway.test.ts:16:20)',
        b'(fail) suite one > expect toEqual fails [0.14ms]',
    ]) + b"\n",
    'expect toHaveLength fails': b"\n".join([
        b'14 | \t});',
        b'15 | \ttest("expect toEqual fails", () => {',
        b'16 | \t\texpect({ a: 1 }).toEqual({ a: 2 });',
        b'17 | \t});',
        b'18 | \ttest("expect toHaveLength fails", () => {',
        b'19 | \t\texpect([1]).toHaveLength(3);',
        b'                   ^',
        b'error: expect(received).toHaveLength(expected)',
        b'',
        b'Expected length: 3',
        b'Received length: 1',
        b'',
        b'      at <anonymous> (/workspace/source/throwaway.test.ts:19:15)',
        b'(fail) suite one > expect toHaveLength fails [0.03ms]',
    ]) + b"\n",
    'thrown Error': b"\n".join([
        b'17 | \t});',
        b'18 | \ttest("expect toHaveLength fails", () => {',
        b'19 | \t\texpect([1]).toHaveLength(3);',
        b'20 | \t});',
        b'21 | \ttest("thrown Error", () => {',
        b'22 | \t\tthrow new Error("boom /home/ompbuild/secret 10.1.2.3 sk-test-0123456789abcdef");',
        b'                                                                                    ^',
        b'error: boom /home/ompbuild/secret 10.1.2.3 sk-test-0123456789abcdef',
        b'      at <anonymous> (/workspace/source/throwaway.test.ts:22:80)',
        b'(fail) suite one > thrown Error [0.03ms]',
    ]) + b"\n",
    'thrown TypeError': b"\n".join([
        b'20 | \t});',
        b'21 | \ttest("thrown Error", () => {',
        b'22 | \t\tthrow new Error("boom /home/ompbuild/secret 10.1.2.3 sk-test-0123456789abcdef");',
        b'23 | \t});',
        b'24 | \ttest("thrown TypeError", () => {',
        b'25 | \t\tthrow new TypeError("x is not a function");',
        b'                                                ^',
        b'TypeError: x is not a function',
        b'      at <anonymous> (/workspace/source/throwaway.test.ts:25:44)',
        b'(fail) suite one > thrown TypeError [0.02ms]',
    ]) + b"\n",
    'thrown EACCES': b"\n".join([
        b'23 | \t});',
        b'24 | \ttest("thrown TypeError", () => {',
        b'25 | \t\tthrow new TypeError("x is not a function");',
        b'26 | \t});',
        b'27 | \ttest("thrown EACCES", () => {',
        b'28 | \t\tthrow new Error("EACCES: permission denied, open \'/home/ompbuild/x\'");',
        b'                                                                           ^',
        b"error: EACCES: permission denied, open '/home/ompbuild/x'",
        b'      at <anonymous> (/workspace/source/throwaway.test.ts:28:71)',
        b'(fail) suite one > thrown EACCES [0.02ms]',
    ]) + b"\n",
    'real fs EROFS or ENOENT': b"\n".join([
        b'26 | \t});',
        b'27 | \ttest("thrown EACCES", () => {',
        b'28 | \t\tthrow new Error("EACCES: permission denied, open \'/home/ompbuild/x\'");',
        b'29 | \t});',
        b'30 | \ttest("real fs EROFS or ENOENT", () => {',
        b'31 | \t\tfs.writeFileSync("/nonexistent-dir-a6/x.txt", "x");',
        b'          ^',
        b"error: ENOENT: no such file or directory, open '/nonexistent-dir-a6/x.txt'",
        b'      at <anonymous> (/workspace/source/throwaway.test.ts:31:6)',
        b'(fail) suite one > real fs EROFS or ENOENT [0.05ms]',
    ]) + b"\n",
    'times out': b"\n".join([
        b'(fail) suite one > times out [100.54ms]',
        b'  ^ this test timed out after 100ms.',
    ]) + b"\n",
    'async rejection': b"\n".join([
        b'32 | \t});',
        b'33 | \ttest("times out", async () => {',
        b'34 | \t\tawait new Promise(resolve => setTimeout(resolve, 600));',
        b'35 | \t}, 100);',
        b'36 | \ttest("async rejection", async () => {',
        b'37 | \t\tawait Promise.reject(new RangeError("out of range"));',
        b'                                ^',
        b'RangeError: out of range',
        b'      at <anonymous> (/workspace/source/throwaway.test.ts:37:28)',
        b'(fail) suite one > async rejection [0.21ms]',
    ]) + b"\n",
}
REAL_TAIL = b"\n".join([
    b'',
    b' 1 pass',
    b' 10 fail',
    b' 5 expect() calls',
    b'Ran 11 tests across 1 file. [105.00ms]',
]) + b"\n"
REAL_ALL = REAL_HEAD + b"".join(REAL_FAILURES.values()) + REAL_TAIL
SOURCE = Path("/workspace/source")
# Why each real failure failed, as the recipe must say it: the kind, then the base file name and line of the first frame in the root.
REAL_REASONS = {
    "expect toBe fails": "qualify-failed-why-expect-tobe-at-throwaway-test-ts-10",
    "expect not toBe fails": "qualify-failed-why-expect-not-tobe-at-throwaway-test-ts-13",
    "expect toEqual fails": "qualify-failed-why-expect-toequal-at-throwaway-test-ts-16",
    "expect toHaveLength fails": "qualify-failed-why-expect-tohavelength-at-throwaway-test-ts-19",
    "thrown Error": "qualify-failed-why-error-at-throwaway-test-ts-22",
    "thrown TypeError": "qualify-failed-why-typeerror-at-throwaway-test-ts-25",
    "thrown EACCES": "qualify-failed-why-eacces-at-throwaway-test-ts-28",
    "real fs EROFS or ENOENT": "qualify-failed-why-enoent-at-throwaway-test-ts-31",
    "times out": "qualify-failed-why-timeout",
    "async rejection": "qualify-failed-why-rangeerror-at-throwaway-test-ts-37",
}
# The first eight of the ten real failures, named as before (the cap is eight).
REAL_NAME_LINES = [
    "qualify-failed-suite-one-expect-tobe-fails", "qualify-failed-suite-one-expect-not-tobe-fails",
    "qualify-failed-suite-one-expect-toequal-fails", "qualify-failed-suite-one-expect-tohavelength-fails",
    "qualify-failed-suite-one-thrown-error", "qualify-failed-suite-one-thrown-typeerror",
    "qualify-failed-suite-one-thrown-eacces", "qualify-failed-suite-one-real-fs-erofs-or-enoent",
]
# A `(fail)` line with no error block before it has no error line: that is the reason the older fixtures now also carry.
NO_REASON = ["qualify-failed-why-no-error-line"]


def drive_runtime(runtime_class, entry=None, argv=("qualify",), offline=None):
    """Run runtime_main (or `entry`) in a fixture tree, against a Runtime double, up to the native-grep stage.

    The real announce_stage runs, so every announced line is validated and captured. `offline` stands in for the offline
    session (default: does nothing). Returns (raised, stdout, stderr)."""
    real_announce = qualify.announce_stage

    def stage(name, **kwargs):
        real_announce(name, **kwargs)
        if name == "qualify-native-grep":
            raise RuntimeError("boundary fixture complete")

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        assets = root / "assets"
        assets.mkdir()
        manifest = fixture(assets)
        source = root / "source"
        source_fixture(source)
        (source / "packages/coding-agent").mkdir(parents=True, exist_ok=True)
        (source / "packages/coding-agent/package.json").write_text('{"version":"18.8.0"}')
        for name in receipt.LOCKS:
            (source / name).write_text("fixture lock")
            manifest["build_inputs"]["locks"][name] = receipt.digest(source / name)
        request = root / "request.json"
        request.write_text(json.dumps({"manifest": manifest, "runtime_image": IMAGE_DIGEST, "fork_manifest_sha256": FORK_SHA}))
        cpu = root / "cpuinfo"
        cpu.write_text("flags: ssse3 sse4_1 sse4_2 popcnt cx16 lahf_lm pni\n")
        native = root / "native.node"
        native.write_bytes(b"fixture native")
        paths = {"/input/assets/request.json": request, "/input/assets/fork_boundary.json": fork_file(root),
                 "/proc/cpuinfo": cpu,
                 "/runtime": root / "runtime", "/workspace/source": source,
                 "/workspace/omp": root / "omp", "/input/assets/omp-linux-amd64": assets / receipt.ASSETS[0]}
        real_copyfile = shutil.copyfile

        def copyfile(origin, destination):
            return real_copyfile(paths.get(str(origin), origin), destination)

        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(qualify, "Path", side_effect=lambda value: paths.get(str(value), Path(value))), \
             patch.object(qualify.os, "uname", return_value=type("Uname", (), {"machine": "x86_64"})()), \
             patch.object(qualify, "Runtime", runtime_class), \
             patch.object(qualify, "prepare_dependencies", return_value=root / "grep"), \
             patch.object(qualify.shutil, "copytree"), patch.object(qualify.shutil, "copyfile", side_effect=copyfile), \
             patch.object(receipt, "elf", return_value=manifest["runtime"]["binary"]), \
             patch.object(qualify, "native_help", return_value=native), \
             patch.object(qualify, "offline_session", side_effect=offline), patch.object(qualify, "require_markers"), \
             patch.object(qualify, "announce_stage", side_effect=stage), \
             patch.object(qualify.sys, "argv", list(argv)), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                (entry or qualify.runtime_main)()
                raised = None
            except (Exception, SystemExit) as error:
                raised = error
    return raised, stdout.getvalue(), stderr.getvalue()


def scripted_runtime(answers, bun_calls):
    """A Runtime double. Each boundary `bun test` command answers with the next of `answers`, as (status, stdout, stderr).

    Every other command succeeds as it does in a good run."""
    queue = iter(answers)

    class Scripted:
        def __init__(self, environment):
            self.environment = environment

        def run(self, command, _cwd, seconds=240):
            args = list(map(str, command))
            if args == ["getconf", "GNU_LIBC_VERSION"]:
                return b"glibc 2.41\n", b""
            if args[-1] == "--version":
                return b"omp/18.8.0\n", b""
            if args[-1] == "--smoke-test":
                return b"smoke-test: ok\n", b""
            return b"1 pass\n", b""

        def run_unchecked(self, command, cwd, seconds=240):
            args = list(map(str, command))
            if args[:2] == ["bun", "test"]:
                bun_calls.append(args)
                status, out, err = next(queue)
                # The fixtures name the container's source root; the double answers with the root this run really uses.
                root = str(cwd).encode()
                return status, out.replace(b"/workspace/source", root), err.replace(b"/workspace/source", root)
            return (0, *self.run(command, cwd, seconds))

    return Scripted


def door_filters():
    """The door's own PROGRESS and ADDRESS patterns, read from the entry file; nothing else in that file runs."""
    text = (Path(__file__).resolve().parent / "ci001" / "omp-build-entry").read_text()
    tree = ast.parse(text.split("\n#PY\n", 1)[1])
    wanted = {"SAFE_TEXT", "PROGRESS", "ADDRESS"}
    body = [node for node in tree.body if isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name) and node.targets[0].id in wanted]
    assert [node.targets[0].id for node in body] == ["SAFE_TEXT", "PROGRESS", "ADDRESS"], "the door's filters moved; update this reader"
    scope = {"re": re}
    exec(compile(ast.Module(body=body, type_ignores=[]), "omp-build-entry", "exec"), scope)
    return scope["PROGRESS"], scope["ADDRESS"]


class RuntimeStartupTests(unittest.TestCase):
    def test_initializes_native_xdg_namespace_on_executable_runtime_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = root / "request.json"
            request.write_text(json.dumps({"manifest": {"source": {"commit": COMMIT}},
                                           "runtime_image": IMAGE_DIGEST, "fork_manifest_sha256": FORK_SHA}))
            cpu = root / "cpuinfo"
            cpu.write_text("flags: ssse3 sse4_1 sse4_2 popcnt cx16 lahf_lm pni\n")
            runtime = root / "runtime"
            paths = {"/input/assets/request.json": request, "/input/assets/fork_boundary.json": fork_file(root),
                     "/proc/cpuinfo": cpu, "/runtime": runtime}

            def path(value):
                return paths.get(str(value), Path(value))

            with patch.object(qualify, "Path", side_effect=path), \
                 patch.object(qualify.os, "uname", return_value=type("Uname", (), {"machine": "x86_64"})()), \
                 patch.object(qualify, "Runtime", side_effect=RuntimeError("fixture stop")) as start, \
                 contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, "fixture stop"):
                    qualify.runtime_main()
            self.assertEqual(start.call_args.args[0]["XDG_DATA_HOME"], str(runtime / "data"))
            self.assertTrue((runtime / "data/omp").is_dir())

    def test_every_boundary_uses_ordinary_test_controls_after_binary_smoke(self):
        calls = []

        class FakeRuntime:
            def __init__(self, environment):
                self.environment = environment

            def run(self, command, _cwd, seconds=240):
                args = list(map(str, command))
                calls.append((args, dict(self.environment), seconds))
                if args == ["getconf", "GNU_LIBC_VERSION"]:
                    return b"glibc 2.41\n", b""
                if args[-1] == "--version":
                    return b"omp/18.8.0\n", b""
                if args[-1] == "--smoke-test":
                    return b"smoke-test: ok\n", b""
                return b"1 pass\n", b""

            def run_unchecked(self, command, cwd, seconds=240):
                return (0, *self.run(command, cwd, seconds))

        raised, _, _ = drive_runtime(FakeRuntime)
        self.assertIsInstance(raised, RuntimeError)
        self.assertRegex(str(raised), "boundary fixture complete")
        boundaries = [call for call in calls if call[0][:2] == ["bun", "test"]]
        self.assertEqual([call[0] for call in boundaries], fork_commands())
        self.assertEqual(len(boundaries), 3)
        controls = {"PI_TEST_RUNTIME": "1", "BUN_JSC_useConcurrentGC": "0", "BUN_JSC_numberOfGCMarkers": "1"}
        for _command, environment, seconds in boundaries:
            self.assertEqual({key: environment.get(key) for key in controls}, controls)
            self.assertEqual(seconds, 240)
        smoke = next(call for call in calls if call[0][-1] == "--smoke-test")
        self.assertTrue(all(key not in smoke[1] for key in controls))

    def test_boundaries_run_in_an_empty_agent_dir_the_offline_fence_never_reaches(self):
        fenced, seen = [], []

        def offline(_runtime, _binary, _cwd, agent):
            # What the real offline session leaves in its agent dir: only its fake provider on, every real one off.
            (agent / "config.yml").write_text("enabledProviders: [offline-smoke]\ndisabledProviders:\n  - anthropic\n")
            (agent / "models.yml").write_text("providers: {}\n")
            fenced.append(agent.resolve())

        class FakeRuntime:
            def __init__(self, environment):
                self.environment = environment

            def run(self, command, _cwd, seconds=240):
                args = list(map(str, command))
                if args == ["getconf", "GNU_LIBC_VERSION"]:
                    return b"glibc 2.41\n", b""
                if args[-1] == "--version":
                    return b"omp/18.8.0\n", b""
                if args[-1] == "--smoke-test":
                    return b"smoke-test: ok\n", b""
                return b"1 pass\n", b""

            def run_unchecked(self, command, cwd, seconds=240):
                if list(map(str, command))[:2] == ["bun", "test"]:
                    agent = Path(self.environment["PI_CODING_AGENT_DIR"]).resolve()
                    seen.append((agent, sorted(path.name for path in agent.iterdir()) if agent.is_dir() else None))
                return (0, *self.run(command, cwd, seconds))

        raised, _, _ = drive_runtime(FakeRuntime, offline=offline)
        self.assertRegex(str(raised), "boundary fixture complete")
        self.assertEqual(len(fenced), 1)
        self.assertEqual(len(seen), 3)
        for agent, contents in seen:
            self.assertFalse(agent == fenced[0] or agent.is_relative_to(fenced[0]) or fenced[0].is_relative_to(agent))
            self.assertIsNotNone(contents, "the boundary agent dir must exist")
            self.assertNotIn("config.yml", contents)
            self.assertNotIn("models.yml", contents)
        self.assertEqual(seen[0][1], [])


class StageTests(unittest.TestCase):
    def test_stage_channel_contains_only_allowlisted_ids_and_rejects_unknown_text(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            qualify.announce_stage("qualify-smoke")
            for invalid in ("qualify-unknown", "qualify-smoke private diagnostic", "qualify-smoke\n", "private diagnostic"):
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    qualify.announce_stage(invalid)
        self.assertEqual(output.getvalue(), "qualify-smoke\n")

    def test_runtime_stage_forwarding_validates_all_bytes_before_emitting_anything(self):
        for payload in (b"qualify-smoke\nqualify-unknown\n", b"qualify-smoke\nprivate diagnostic\n",
                        b"qualify-smoke \n", b"\xff\n", b"x" * 32769):
            with self.subTest(payload=payload), contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(ValueError):
                    qualify.forward_stages(io.BytesIO(payload))
                self.assertEqual(output.getvalue(), "")
        with contextlib.redirect_stdout(io.StringIO()) as output:
            qualify.forward_stages(io.BytesIO(b"qualify-help\nqualify-smoke\n"))
        self.assertEqual(output.getvalue(), "qualify-help\nqualify-smoke\n")

    def test_boundary_stage_names_are_valid_only_for_the_exact_set_the_caller_computed(self):
        names = frozenset({"qualify-boundary-alpha-contract-1"})
        self.assertTrue(qualify.valid_stage("qualify-boundary-alpha-contract-1", names))
        self.assertFalse(qualify.valid_stage("qualify-boundary-alpha-contract-1"))
        self.assertFalse(qualify.valid_stage("qualify-boundary-alpha-contract-2", names))
        self.assertFalse(qualify.valid_stage("qualify-boundary-alpha-contract-1\n", names))
        self.assertFalse(qualify.valid_stage(None, names))
        with contextlib.redirect_stdout(io.StringIO()) as output:
            qualify.forward_stages(io.BytesIO(b"qualify-boundary-alpha-contract-1\nqualify-smoke\n"), names)
            with self.assertRaises(ValueError):
                qualify.forward_stages(io.BytesIO(b"qualify-boundary-alpha-contract-2\n"), names)
        self.assertEqual(output.getvalue(), "qualify-boundary-alpha-contract-1\nqualify-smoke\n")

    def test_failed_test_lines_are_valid_stages_only_in_their_exact_shape(self):
        for line in ("qualify-failed-timeout", "qualify-failed-no-test-name", "qualify-failed-a", "qualify-failed-a1-b2-c3",
                     "qualify-failed-" + "a" * 96, "qualify-failed-" + "a" * 97):
            self.assertTrue(qualify.valid_stage(line), line)
        for line in ("qualify-failed-", "qualify-failed", "qualify-failed--a", "qualify-failed-a-", "qualify-failed-A",
                     "qualify-failed-a_b", "qualify-failed-a.b", "qualify-failed-a b", "qualify-failed-a/b", "qualify-failed-a:b",
                     "qualify-failed-a@b", "qualify-failed-a\n", "qualify-failed-\u00fc", "Qualify-failed-a", " qualify-failed-a",
                     "qualify-failed-a ", "qualify-failed-" + "a" * 98, "qualify-failedx", "qualify-failed-\x00"):
            self.assertFalse(qualify.valid_stage(line), repr(line))
        self.assertEqual(len("qualify-failed-" + "a" * 97), 112)
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            qualify.announce_stage("qualify-failed-top-level-fail")
            qualify.announce_stage("qualify-failed-timeout", inside=True)
            for invalid in ("qualify-failed-a.b", "qualify-failed-" + "a" * 98):
                with self.assertRaises(ValueError):
                    qualify.announce_stage(invalid, inside=True)
        self.assertEqual((out.getvalue(), err.getvalue()), ("qualify-failed-top-level-fail\n", "qualify-failed-timeout\n"))

    def test_runtime_stage_forwarding_accepts_failed_test_lines_and_refuses_bad_ones_before_emitting(self):
        names = frozenset({"qualify-boundary-alpha-contract-1"})
        good = b"qualify-boundary-alpha-contract-1\nqualify-failed-suite-one-fails-twice\nqualify-failed-timeout\n"
        eight = b"".join(b"qualify-failed-case-%d\n" % number for number in range(1, 9))
        for payload in (good, eight, b"qualify-smoke\n" + eight + b"qualify-help\n"):
            with self.subTest(payload=payload[:40]), contextlib.redirect_stdout(io.StringIO()) as output:
                qualify.forward_stages(io.BytesIO(payload), names)
            self.assertEqual(output.getvalue(), payload.decode())
        ninth = eight + b"qualify-failed-case-9\n"
        malformed = (b"qualify-smoke\nqualify-failed-a.b\n", b"qualify-failed-\n", b"qualify-failed-A\n", b"qualify-failed-a b\n",
                     b"qualify-failed-a\n\n", b"qualify-failed-a", b"qualify-failed-a\xc3\xbc\n", b"qualify-failed-a/../b\n")
        too_long = (b"qualify-failed-" + b"a" * 98 + b"\n", b"qualify-smoke\nqualify-failed-" + b"a-" * 60 + b"a\n")
        for payload in (*malformed, *too_long, ninth, b"qualify-smoke\n" + ninth):
            with self.subTest(payload=payload[:40]), contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(ValueError):
                    qualify.forward_stages(io.BytesIO(payload), names)
                self.assertEqual(output.getvalue(), "")
        # Only failed-test lines are counted: eight of them plus any number of ordinary stages is fine, and the cap is per run.
        with contextlib.redirect_stdout(io.StringIO()) as output:
            qualify.forward_stages(io.BytesIO(eight + b"qualify-help\n" * 5), names)
        self.assertEqual(output.getvalue(), (eight + b"qualify-help\n" * 5).decode())

    def test_reason_lines_are_valid_stages_only_in_their_exact_shape_and_up_to_140_characters(self):
        for line in ("qualify-failed-why-error", "qualify-failed-why-no-error-line", "qualify-failed-why-expect-not-tobe-at-a-test-ts-12",
                     "qualify-failed-why-" + "a" * 121):
            self.assertTrue(qualify.valid_stage(line), line)
        self.assertEqual(len("qualify-failed-why-" + "a" * 121), 140)
        for line in ("qualify-failed-why-", "qualify-failed-why--a", "qualify-failed-why-a-", "qualify-failed-why-A", "qualify-failed-why-a_b",
                     "qualify-failed-why-a.b", "qualify-failed-why-a b", "qualify-failed-why-a/b", "qualify-failed-why-a:b",
                     "qualify-failed-why-a@b", "qualify-failed-why-\u00fc", "qualify-failed-why-a\n", "qualify-failed-why-" + "a" * 122):
            self.assertFalse(qualify.valid_stage(line), repr(line))
        # A name line keeps its own, shorter cap: only a line that starts with the reason prefix gets the longer one.
        self.assertTrue(qualify.valid_stage("qualify-failed-whyx-" + "a" * 92))
        self.assertFalse(qualify.valid_stage("qualify-failed-whyx-" + "a" * 93))
        self.assertFalse(qualify.valid_stage("qualify-failed-" + "a" * 98))

    def test_forwarding_accepts_eight_names_and_four_reasons_and_refuses_one_more_of_either(self):
        names = frozenset({"qualify-boundary-alpha-contract-1"})
        eight = b"".join(b"qualify-failed-case-%d\n" % number for number in range(1, 9))
        four = b"".join(b"qualify-failed-why-error-at-a-test-ts-%d\n" % number for number in range(1, 5))
        fifth, ninth = b"qualify-failed-why-error-at-a-test-ts-5\n", b"qualify-failed-case-9\n"
        # Names that merely start with `why` are names, not reasons, so they never use up the four.
        why_names = b"".join(b"qualify-failed-whyx-%d\n" % number for number in range(1, 9))
        for payload in (eight + four, four + eight, four, eight, b"qualify-smoke\n" + eight + four + b"qualify-help\n",
                        b"qualify-failed-why-no-error-line\n", why_names + four, b"qualify-failed-why\n" * 8 + four,
                        b"qualify-failed-why-" + b"a" * 121 + b"\n"):
            with self.subTest(payload=payload[:40]), contextlib.redirect_stdout(io.StringIO()) as output:
                qualify.forward_stages(io.BytesIO(payload), names)
            self.assertEqual(output.getvalue(), payload.decode())
        refused = (eight + four + fifth, four + fifth, fifth * 5, eight + ninth + four, eight + four + ninth, four + ninth * 9,
                   b"qualify-failed-why-" + b"a" * 122 + b"\n", b"qualify-failed-why-\n", b"qualify-failed-why-a.b\n",
                   b"qualify-failed-why-A\n", b"qualify-failed-why-a b\n", b"qualify-failed-why-a/b\n", b"qualify-failed-why-a:b\n",
                   b"qualify-failed-why-a\xc3\xbc\n", b"qualify-failed-why-a-\n", b"qualify-smoke\n" + four + fifth)
        for payload in refused:
            with self.subTest(payload=payload[:40]), contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(ValueError):
                    qualify.forward_stages(io.BytesIO(payload), names)
                self.assertEqual(output.getvalue(), "")


class FailedStageTests(unittest.TestCase):
    """qualify-failed-<name> lines: which boundary tests failed, as hyphenated names and nothing else."""

    def test_bun_failure_output_names_each_failed_test_in_order(self):
        self.assertEqual(qualify.failed_stages(1, BUN_FAILURES), FAILED_LINES)

    def test_a_command_passes_only_with_exit_zero_a_passing_test_and_no_failure(self):
        self.assertTrue(qualify.boundary_passed(0, b"\n 12 pass\n 0 fail\nRan 12 tests\n"))
        self.assertTrue(qualify.boundary_passed(0, b"1 pass\n\n"))
        for status, output in ((1, b" 12 pass\n"), (124, b" 12 pass\n"), (0, b" 0 pass\n"), (0, b""),
                               (0, b" 12 pass\n 1 fail\n"), (0, b" 12 pass\n 10 fail\n")):
            self.assertFalse(qualify.boundary_passed(status, output), (status, output))

    def test_a_name_with_a_path_an_address_an_email_and_non_ascii_text_is_only_letters_digits_and_hyphens(self):
        hostile = ("(fail) \u00fc/etc/passwd 192.168.0.1 fe80::1 user@example.org C:\\temp \x1b[31m\u65e5\u672c ../.. [1.00ms]\n").encode()
        self.assertEqual(qualify.failed_stages(1, hostile),
                         ["qualify-failed-etc-passwd-192-168-0-1-fe80-1-user-example-org-c-temp-31m"])
        for output in (BUN_FAILURES, hostile, b"(fail) " + bytes(range(1, 256)).replace(b"\n", b"") + b"\n"):
            for line in qualify.failed_stages(1, output):
                self.assertRegex(line, r"\Aqualify-failed-[a-z0-9]+(-[a-z0-9]+)*\Z")
                self.assertLessEqual(len(line), 112)
                self.assertTrue(qualify.valid_stage(line))
                for forbidden in "/\\.:@ \x1b\x00\n":
                    self.assertNotIn(forbidden, line)

    def test_a_long_name_is_cut_to_96_characters_and_never_ends_in_a_hyphen(self):
        self.assertEqual(qualify.failed_stages(1, b"(fail) " + b"x" * 200 + b" [1.00ms]\n"), ["qualify-failed-" + "x" * 96])
        self.assertEqual(qualify.failed_stages(1, b"(fail) " + b"x" * 95 + b" tail [1.00ms]\n"), ["qualify-failed-" + "x" * 95])
        self.assertEqual(qualify.failed_stages(1, b"(fail) " + b"x" * 96 + b" tail [1.00ms]\n"), ["qualify-failed-" + "x" * 96])
        for line in qualify.failed_stages(1, b"(fail) " + b"word " * 60 + b"[1.00ms]\n"):
            self.assertLessEqual(len(line), 111)
            self.assertFalse(line.endswith("-"))

    def test_a_trailing_timing_and_a_carriage_return_are_dropped_but_other_brackets_stay(self):
        self.assertEqual(qualify.failed_stages(1, b"(fail) a > b [12.34ms]\r\n(fail) c [1.50s]\n(fail) d [x]\n(fail) e [5ms] f\n"),
                         ["qualify-failed-a-b", "qualify-failed-c", "qualify-failed-d-x", "qualify-failed-e-5ms-f"])

    def test_a_test_name_that_starts_with_why_cannot_pose_as_a_reason_line(self):
        output = b"(fail) Why not [1.00ms]\n(fail) why [1.00ms]\n(fail) whyx [1.00ms]\n(fail) a why [1.00ms]\n(fail) why-it-fails\n"
        self.assertEqual(qualify.failed_stages(1, output),
                         ["qualify-failed-test-why-not", "qualify-failed-test-why", "qualify-failed-whyx", "qualify-failed-a-why",
                          "qualify-failed-test-why-it-fails"])
        for line in qualify.failed_stages(1, b"(fail) why " + b"x" * 200 + b"\n"):
            self.assertLessEqual(len(line), 112)
            self.assertFalse(line.startswith("qualify-failed-why-"))
            self.assertTrue(qualify.valid_stage(line))

    def test_a_name_that_slugs_to_nothing_is_skipped(self):
        output = b"(fail) >>> [1.00ms]\n(fail) \n(fail) \xe6\x97\xa5\xe6\x9c\xac\n(fail) real one [2.00ms]\n"
        self.assertEqual(qualify.failed_stages(1, output), ["qualify-failed-real-one"])
        self.assertEqual(qualify.failed_stages(1, b"(fail) >>> [1.00ms]\n(fail) \n"), ["qualify-failed-no-test-name"])

    def test_repeated_names_are_announced_once(self):
        output = b"(fail) a > b [1.00ms]\n(fail) c [2.00ms]\n(fail) a > b [3.50ms]\n(fail) a.b\n(fail) A/B\n"
        self.assertEqual(qualify.failed_stages(1, output), ["qualify-failed-a-b", "qualify-failed-c"])

    def test_at_most_eight_lines_are_announced_and_a_timeout_line_is_never_cut(self):
        output = b"".join(b"(fail) case %d [1.00ms]\n" % number for number in range(1, 13))
        first_eight = [f"qualify-failed-case-{number}" for number in range(1, 9)]
        self.assertEqual(qualify.failed_stages(1, output), first_eight)
        self.assertEqual(qualify.failed_stages(124, output), ["qualify-failed-timeout", *first_eight[:7]])
        self.assertEqual(len(qualify.failed_stages(1, output * 3)), 8)

    def test_a_timeout_and_a_failure_without_a_test_name_have_their_own_lines(self):
        for status in (124, 137):
            self.assertEqual(qualify.failed_stages(status, b""), ["qualify-failed-timeout", "qualify-failed-no-test-name"])
            self.assertEqual(qualify.failed_stages(status, b"(fail) slow one [30000.10ms]\n"),
                             ["qualify-failed-timeout", "qualify-failed-slow-one"])
        for status in (1, 2, 126, 127, 139, -9):
            self.assertEqual(qualify.failed_stages(status, b"error: something private happened\n"), ["qualify-failed-no-test-name"])
        self.assertEqual(qualify.failed_stages(0, b" 0 pass\n"), ["qualify-failed-no-test-name"])
        self.assertEqual(qualify.failed_stages(0, b" 3 pass\n 1 fail\n(fail) one [1.00ms]\n"), ["qualify-failed-one"])

    def test_only_a_fail_marker_at_the_start_of_a_line_names_a_test(self):
        output = b"error: (fail) not a marker\n  (fail) indented\nlog (fail) x\n(fail)\n(fail)x\n(FAIL) upper\n"
        self.assertEqual(qualify.failed_stages(1, output), ["qualify-failed-no-test-name"])


def stack_frame(path, line=3, column=5, shape="paren"):
    """One Bun stack frame line: `at <anonymous> (path:line:column)`, or the bare `at path:line:column`."""
    if shape == "paren":
        return b"      at <anonymous> (%s:%d:%d)" % (path, line, column)
    return b"      at %s:%d:%d" % (path, line, column)


def reasons_of(*lines, source=SOURCE):
    """The reason lines for one failure made of `lines`, followed by its `(fail)` line."""
    return qualify.failed_reasons(b"\n".join([*lines, b"(fail) x [1.00ms]", b""]), source)


class FailedReasonTests(unittest.TestCase):
    """qualify-failed-why-<kind>[-at-<file>-<line>] lines: why a failed test failed, as hyphenated words and nothing else."""

    def test_each_real_bun_failure_gives_its_kind_and_the_base_file_and_line(self):
        for name, expected in REAL_REASONS.items():
            with self.subTest(test=name):
                self.assertEqual(qualify.failed_reasons(REAL_HEAD + REAL_FAILURES[name] + REAL_TAIL, SOURCE), [expected])

    def test_the_whole_real_stream_is_split_at_each_failure_and_capped_at_four(self):
        every = list(REAL_REASONS.values())
        self.assertEqual(qualify.failed_reasons(REAL_ALL, SOURCE), every[:4])
        with patch.object(qualify, "FAILED_REASON_LINES", 20):
            self.assertEqual(qualify.failed_reasons(REAL_ALL, SOURCE), every)

    def test_the_kind_follows_the_documented_rules_in_order(self):
        cases = {
            b"error: expect(received).toBe(expected)": "expect-tobe",
            b"error: expect(received).not.toBe(expected)": "expect-not-tobe",
            b"error: expect(received).resolves.toBe(expected)": "expect-resolves-tobe",
            b"error: expect(received).rejects.not.toThrow(expected)": "expect-rejects-not-tothrow",
            b"error: expect(received).resolves.rejects.toBe(x)": "error",
            b"error: expect(received).other.toBe(x)": "error",
            b"error: expect(received).toHaveBeenCalledWith(...expected)": "expect-tohavebeencalledwith",
            b"error: expect(received).to" + b"a" * 38 + b"(x)": "expect-to" + "a" * 38,
            b"error: expect(received).to" + b"a" * 39 + b"(x)": "error",
            b"error: expect(received).toBe(expected) timed out": "expect-tobe",
            b"error: EACCES: permission denied": "eacces",
            b"error: EROFS: read-only file system, open 'x'": "erofs",
            b"error: E12: x": "e12",
            b"error: E" + b"A" * 15 + b": x": "e" + "a" * 15,
            b"error: E" + b"A" * 16 + b": x": "error",
            b"error: E1: x": "error",
            b"error: ERR_INVALID_ARG_TYPE: x": "error",
            b"error: EACCES permission denied": "error",
            b"error: TypeError: nested class": "typeerror",
            b"error: TypeError: request timed out": "typeerror",
            b"TypeError: bare class line": "typeerror",
            b"RangeError: bare class line": "rangeerror",
            b"AggregateError: bare class line": "aggregateerror",
            b"Error: bare class line": "error",
            b"A" * 35 + b"Error: forty letters": "a" * 35 + "error",
            b"error: " + b"A" * 36 + b"Error: forty-one letters": "error",
            b"error: Test \"x\" timed out after 5000ms": "timeout",
            b"error: request TIMEOUT reached": "timeout",
            b"error: Timed Out waiting": "timeout",
            b"error: something else entirely": "error",
            b"error: ": "error",
            b"error: EACCES: x\r": "eacces",
        }
        for header, kind in cases.items():
            with self.subTest(header=header[:60]):
                self.assertEqual(reasons_of(header), [f"qualify-failed-why-{kind}"])
        self.assertEqual(reasons_of(b"A" * 36 + b"Error: forty-one letters, bare"), ["qualify-failed-why-no-error-line"])

    def test_only_a_line_that_starts_with_the_error_header_decides_the_kind(self):
        noise = [b"console noise", b"  error: EACCES: indented", b'Expected: "error: EROFS: quoted"', b"Received: TypeError: a value",
                 b"10 | error: EROFS: in the source context", b"at error: EROFS: mid-line", b"ERROR: EROFS upper case", b"errors: EROFS: x"]
        self.assertEqual(reasons_of(*noise), ["qualify-failed-why-no-error-line"])
        self.assertEqual(reasons_of(*noise, b"error: expect(received).toBe(expected)", b"error: EACCES: a second header",
                                    b"TypeError: a bare class line after it"), ["qualify-failed-why-expect-tobe"])
        self.assertEqual(reasons_of(b"TypeError: first", b"error: EACCES: second"), ["qualify-failed-why-typeerror"])

    def test_a_failure_with_no_error_line_says_so_and_names_no_location(self):
        self.assertEqual(reasons_of(stack_frame(b"/workspace/source/a.test.ts")), ["qualify-failed-why-no-error-line"])
        self.assertEqual(qualify.failed_reasons(b"(fail) x [1.00ms]\n", SOURCE), ["qualify-failed-why-no-error-line"])

    def test_the_location_is_the_first_frame_inside_the_source_root_after_the_header(self):
        cases = {
            "a parenthesised frame": ([stack_frame(b"/workspace/source/a/b/c.test.ts", 7, 9)], "c-test-ts-7"),
            "a bare frame": ([stack_frame(b"/workspace/source/pkg/index.ts", 12, 1, "bare")], "index-ts-12"),
            "an async frame": ([b"      at async run (/workspace/source/x.ts:4:2)"], "x-ts-4"),
            "a frame in a module inside the root": ([stack_frame(b"/workspace/source/node_modules/pkg/lib/index.js", 70000, 3)], "index-js-70000"),
            "a six digit line": ([stack_frame(b"/workspace/source/x.ts", 999999, 1)], "x-ts-999999"),
            "a leading zero": ([b"      at f (/workspace/source/x.ts:007:1)"], "x-ts-7"),
            "the first of two": ([stack_frame(b"/workspace/source/first.ts", 1, 1), stack_frame(b"/workspace/source/second.ts", 2, 2)], "first-ts-1"),
            "a carriage return": ([stack_frame(b"/workspace/source/x.ts", 4, 2) + b"\r"], "x-ts-4"),
        }
        for label, (frames, location) in cases.items():
            with self.subTest(label):
                self.assertEqual(reasons_of(b"error: boom", *frames), [f"qualify-failed-why-error-at-{location}"])
        self.assertEqual(reasons_of(b"error: EACCES: x", b"      at f (/workspace/source/x.ts:4:2)"), ["qualify-failed-why-eacces-at-x-ts-4"])

    def test_frames_outside_the_root_or_without_a_usable_location_are_skipped(self):
        skipped = [stack_frame(b"/usr/lib/bun/internal.js"), stack_frame(b"/home/ompbuild/x.ts", 5, 5), b"      at c (native:1:2)",
                   stack_frame(b"/workspace/source-other/y.ts"), stack_frame(b"/workspace/sourcex.ts"),
                   stack_frame(b"/workspace/source/../../etc/passwd", 1, 1), stack_frame(b"/workspace/source/a/../b.ts"),
                   stack_frame(b"/workspace/source/___", 3, 3), stack_frame(b"/workspace/source/x.ts", 1234567, 1),
                   b"      at <anonymous>", b"      at /workspace/source/x.ts", b"      at (/workspace/source/x.ts:3:4",
                   b"at f (/workspace/source/not-indented.ts:3:4)", b"   /workspace/source/no-at.ts:3:4",
                   b"      at f (/workspace/source/x.ts:3)", b"      at f (/workspace/source/x.ts:a:4)"]
        self.assertEqual(reasons_of(b"error: boom", *skipped), ["qualify-failed-why-error"])
        good = stack_frame(b"/workspace/source/pkg/inside.ts", 8, 9)
        self.assertEqual(reasons_of(b"error: boom", *skipped, good), ["qualify-failed-why-error-at-inside-ts-8"])
        self.assertEqual(reasons_of(stack_frame(b"/workspace/source/before.ts"), b"error: boom", good), ["qualify-failed-why-error-at-inside-ts-8"])
        self.assertEqual(reasons_of(stack_frame(b"/workspace/source/before.ts"), b"error: boom"), ["qualify-failed-why-error"])

    def test_the_root_comes_from_the_source_argument_and_not_from_a_constant(self):
        lines = (b"error: boom", stack_frame(b"/workspace/source/w.ts", 1, 1), stack_frame(b"/tmp/other-root/pkg/z.ts", 5, 5))
        self.assertEqual(reasons_of(*lines), ["qualify-failed-why-error-at-w-ts-1"])
        self.assertEqual(reasons_of(*lines, source=Path("/tmp/other-root")), ["qualify-failed-why-error-at-z-ts-5"])
        self.assertEqual(reasons_of(*lines, source=Path("/tmp/other-root/")), ["qualify-failed-why-error-at-z-ts-5"])
        self.assertEqual(reasons_of(*lines, source=Path("/tmp/other")), ["qualify-failed-why-error"])

    def test_the_file_is_the_base_name_as_lowercase_letters_digits_and_single_hyphens_up_to_48_characters(self):
        cases = {
            b"agent-session-handoff.test.ts": "agent-session-handoff-test-ts",
            b"My_File  Name.TS": "my-file-name-ts",
            b"a\xc3\xbcb\xe6\x97\xa5.ts": "a-b-ts",
            b"--lead--and--trail--.ts--": "lead-and-trail-ts",
            b"1.2.3.ts": "1-2-3-ts",
            b"x" * 60 + b".ts": "x" * 48,
            b"y" * 47 + b".ts": "y" * 47,
            b"z" * 46 + b".ts": "z" * 46 + "-t",
        }
        for base, slug in cases.items():
            with self.subTest(base=base[:30]):
                (line,) = reasons_of(b"error: boom", stack_frame(b"/workspace/source/secret dir/sub folder/" + base))
                self.assertEqual(line, f"qualify-failed-why-error-at-{slug}-3")
                self.assertNotIn("secret", line)
                self.assertNotIn("folder", line)

    def test_a_failure_block_starts_after_the_previous_result_line(self):
        output = b"\n".join([
            b"error: EACCES: noise printed by a passing test", b"(pass) a [1.00ms]",
            b"error: expect(received).toBe(expected)", stack_frame(b"/workspace/source/one.test.ts", 3, 3), b"(fail) b [1.00ms]",
            b"console noise", b"(skip) c", b"error: EROFS: noise before a todo test", b"(todo) d", b"(fail) e [1.00ms]",
            b"TypeError: x", stack_frame(b"/workspace/source/two.test.ts", 4, 4), b"(fail) f [1.00ms]", b""])
        self.assertEqual(qualify.failed_reasons(output, SOURCE),
                         ["qualify-failed-why-expect-tobe-at-one-test-ts-3", "qualify-failed-why-no-error-line",
                          "qualify-failed-why-typeerror-at-two-test-ts-4"])

    def test_a_test_timeout_note_after_the_fail_line_is_a_timeout_and_nothing_else_is(self):
        note = b"  ^ this test timed out after 30000ms.\n"
        self.assertEqual(qualify.failed_reasons(b"(fail) a [30000.10ms]\n" + note, SOURCE), ["qualify-failed-why-timeout"])
        self.assertEqual(qualify.failed_reasons(b"(fail) a [30000.10ms]\n" + note.rstrip(b"\n"), SOURCE), ["qualify-failed-why-timeout"])
        noisy = b"error: noise\n" + stack_frame(b"/workspace/source/x.ts") + b"\n(fail) a [30000.10ms]\n" + note
        self.assertEqual(qualify.failed_reasons(noisy, SOURCE), ["qualify-failed-why-timeout"])
        self.assertEqual(qualify.failed_reasons(b"(fail) a [1.00ms]\nconsole noise\n" + note + b"(fail) b [1.00ms]\n", SOURCE),
                         ["qualify-failed-why-no-error-line"])
        for text in (b"  ^ this test timed out after 30s.\n", b"  ^ this test timed out after ms.\n", b"  ^ this test timed out after 5ms. more\n",
                     b"this test timed out after 5ms.\n", b"  ^ this test failed after 5ms.\n"):
            self.assertEqual(qualify.failed_reasons(b"(fail) a [1.00ms]\n" + text, SOURCE), ["qualify-failed-why-no-error-line"], text)

    def test_duplicates_collapse_and_at_most_four_reasons_are_kept_in_order_of_first_appearance(self):
        def failure(line):
            return b"error: boom\n      at f (/workspace/source/a.test.ts:%d:3)\n(fail) t [1.00ms]\n" % line

        def expected(*lines):
            return [f"qualify-failed-why-error-at-a-test-ts-{line}" for line in lines]

        def run(*lines):
            return qualify.failed_reasons(b"".join(failure(line) for line in lines), SOURCE)

        self.assertEqual(run(1, 1, 1), expected(1))
        self.assertEqual(run(1, 2, 3, 4, 5, 6), expected(1, 2, 3, 4))
        self.assertEqual(run(1, 2, 1, 3, 2, 4, 5, 4), expected(1, 2, 3, 4))
        self.assertEqual(run(3, 1, 2), expected(3, 1, 2))
        other_file = b"error: boom\n      at f (/workspace/source/b.test.ts:1:3)\n(fail) t [1.00ms]\n"
        self.assertEqual(qualify.failed_reasons(failure(1) + other_file + failure(1), SOURCE),
                         ["qualify-failed-why-error-at-a-test-ts-1", "qualify-failed-why-error-at-b-test-ts-1"])

    def test_no_fail_line_means_no_reason(self):
        for output in (b"", b"error: EACCES: x\n      at f (/workspace/source/x.ts:3:3)\n 1 pass\n 0 fail\n",
                       b"error: (fail) not a marker\n  (fail) indented\nlog (fail) x\n(fail)\n(fail)x\n(FAIL) upper\n"):
            self.assertEqual(qualify.failed_reasons(output, SOURCE), [], output)

    def test_the_longest_possible_line_is_137_characters_and_valid(self):
        header = b"error: expect(received).rejects.not.to" + b"a" * 38 + b"(x)"
        (line,) = reasons_of(header, stack_frame(b"/workspace/source/" + b"f" * 60 + b".ts", 999999, 1))
        self.assertEqual(line, "qualify-failed-why-expect-rejects-not-to" + "a" * 38 + "-at-" + "f" * 48 + "-999999")
        self.assertEqual(len(line), 137)
        self.assertTrue(qualify.valid_stage(line))

    def test_two_more_real_bun_shapes_a_node_assert_failure_and_a_refused_connection(self):
        # Captured with Bun 1.4.2 like the stream above. The assert frames are in `node:assert`, outside the root, so the location
        # is the test file; the refused connection puts an address, a path and a code in the message, and none of them is reported.
        assertion = b"\n".join([
            b'             ^', b'AssertionError: Expected values to be strictly equal:', b'', b'1 !== 2', b'',
            b'      at innerFail (node:assert:50:32)', b'      at strictEqual (node:assert:181:14)',
            b'      at <anonymous> (/workspace/source/second.test.ts:6:10)', b'(fail) shapes > node assert strictEqual [6.11ms]', b''])
        refused = b"\n".join([
            b'             ^', b'TypeError: Unable to connect. Is the computer able to access the url?', b'  path: "http://127.0.0.1:9/",',
            b' errno: 0,', b'  code: "ConnectionRefused"', b'', b'      at async <anonymous> (/workspace/source/second.test.ts:21:9)',
            b'(fail) shapes > fetch refused [0.44ms]', b''])
        self.assertEqual(qualify.failed_reasons(assertion, SOURCE), ["qualify-failed-why-assertionerror-at-second-test-ts-6"])
        self.assertEqual(qualify.failed_reasons(refused, SOURCE), ["qualify-failed-why-typeerror-at-second-test-ts-21"])
        self.assertEqual(qualify.failed_reasons(assertion + refused, SOURCE),
                         ["qualify-failed-why-assertionerror-at-second-test-ts-6", "qualify-failed-why-typeerror-at-second-test-ts-21"])

    def test_nothing_from_a_message_a_path_an_address_or_a_token_is_ever_emitted(self):
        hostile = b"\n".join([
            b"error: EACCES: open '/home/ompbuild/.ssh/id_rsa' 10.1.2.3 fe80::1 sk-test-0123456789abcdef user@example.org",
            b"      at secret-fn-sk-test-0123456789abcdef (/home/ompbuild/private/key.pem:9:9)",
            stack_frame(b"/workspace/source/pkg/ok.ts", 5, 6), b"(fail) hostile [1.00ms]",
            b"error: boom /home/ompbuild/secret 10.1.2.3 sk-test-0123456789abcdef a@b.example", b"(fail) other [1.00ms]",
            b"error: expect(received).toBe(expected)", b"", b'Expected: "sk-test-0123456789abcdef"', b'Received: "10.1.2.3"',
            b"(fail) third [1.00ms]", b""])
        self.assertEqual(qualify.failed_reasons(hostile, SOURCE),
                         ["qualify-failed-why-eacces-at-ok-ts-5", "qualify-failed-why-error", "qualify-failed-why-expect-tobe"])
        noise = bytes(range(1, 256)).replace(b"\n", b"")
        fuzz = b"\n".join([b"error: " + noise, stack_frame(b"/workspace/source/" + noise.replace(b"/", b"")), b"(fail) a",
                           b"TypeError: " + noise, b"(fail) b", b""])
        self.assertEqual(qualify.failed_reasons(fuzz, SOURCE), ["qualify-failed-why-error", "qualify-failed-why-typeerror"])
        forbidden = ("ompbuild", "home", "10.1.2.3", "10-1-2-3", "sk-", "secret", "key-pem", "id-rsa", "ssh", "example", "boom", "expected",
                     "received", "permission", "noise", "workspace", "source", "/", "\\", ".", ":", "@", " ")
        for output in (hostile, REAL_ALL, fuzz):
            for line in qualify.failed_reasons(output, SOURCE):
                self.assertRegex(line, r"\Aqualify-failed-why-[a-z0-9]+(-[a-z0-9]+)*\Z")
                self.assertLessEqual(len(line), 140)
                self.assertTrue(qualify.valid_stage(line))
                for word in forbidden:
                    self.assertNotIn(word, line)


class RuntimeCommandTests(unittest.TestCase):
    """Runtime keeps every command's output in private files; the unchecked form also hands back a failing command's output."""

    @contextlib.contextmanager
    def fake(self, status, out=b"standard output", err=b"standard error"):
        with tempfile.TemporaryDirectory() as temporary:
            directory, calls = Path(temporary), []

            def fake_run(command, **kwargs):
                calls.append((command, kwargs))
                kwargs["stdout"].write(out)
                kwargs["stderr"].write(err)
                return subprocess.CompletedProcess(command, status)

            with patch.object(qualify, "Path", side_effect=lambda value: directory if str(value) == "/runtime" else Path(value)), \
                 patch.object(subprocess, "run", side_effect=fake_run):
                yield qualify.Runtime({"PATH": "/fixture"}), calls, directory

    def test_a_failing_command_returns_its_status_and_output_instead_of_raising(self):
        with self.fake(3) as (runtime, calls, directory):
            self.assertEqual(runtime.run_unchecked(["bun", "test", "a.test.ts"], "src"), (3, b"standard output", b"standard error"))
            command, options = calls[0]
            self.assertEqual(command, ["timeout", "--signal=TERM", "--kill-after=5s", "240s", "bun", "test", "a.test.ts"])
            self.assertEqual((options["cwd"], options["timeout"], options["input"], options["env"]), ("src", 255, b"", {"PATH": "/fixture"}))
            self.assertEqual(sorted(path.name for path in directory.iterdir()), ["command-1.err", "command-1.out"])
            with self.assertRaises(ValueError):
                runtime.run(["bun", "test", "a.test.ts"], "src")

    def test_a_passing_command_reads_the_same_through_both_forms(self):
        with self.fake(0) as (runtime, calls, _directory):
            self.assertEqual(runtime.run(["x"], "src", 30), (b"standard output", b"standard error"))
            self.assertEqual(runtime.run_unchecked(["x"], "src", 30), (0, b"standard output", b"standard error"))
            self.assertEqual([call[0][3] for call in calls], ["30s", "30s"])
            self.assertEqual([call[1]["timeout"] for call in calls], [45, 45])

    def test_oversized_diagnostics_are_refused_by_both_forms(self):
        big = b"x" * (8 * 1024 * 1024 + 1)
        for status in (0, 1):
            with self.subTest(status=status), self.fake(status, out=big) as (runtime, _calls, _directory):
                with self.assertRaises(ValueError):
                    runtime.run_unchecked(["x"], "src")
        with self.fake(0, err=big) as (runtime, _calls, _directory):
            with self.assertRaises(ValueError):
                runtime.run(["x"], "src")
        with self.fake(0, out=b"x" * (8 * 1024 * 1024)) as (runtime, _calls, _directory):
            self.assertEqual(runtime.run_unchecked(["x"], "src")[0], 0)


class BoundaryFailureTests(unittest.TestCase):
    """The boundary loop names the failing tests on stderr (the stage channel) and then fails closed, as it always did."""

    def drive(self, answers, **options):
        calls = []
        raised, stdout, stderr = drive_runtime(scripted_runtime(answers, calls), **options)
        return raised, stdout, stderr.splitlines(), calls

    def test_a_passing_run_announces_exactly_the_stages_it_always_did(self):
        raised, stdout, stages, calls = self.drive([PASSING] * 3)
        self.assertRegex(str(raised), "boundary fixture complete")
        self.assertEqual(stages, SETUP_STAGES + BOUNDARY_STAGES + ["qualify-native-grep"])
        self.assertEqual(stdout, "")
        self.assertEqual(len(calls), 3)

    def test_a_failing_command_announces_its_failed_tests_then_fails_closed_and_runs_nothing_more(self):
        raised, stdout, stages, calls = self.drive([PASSING, (1, b"bun test v1.4.2 (744846f84)\n", BUN_FAILURES), PASSING])
        self.assertIsInstance(raised, ValueError)
        self.assertEqual(stages, SETUP_STAGES + BOUNDARY_STAGES[:2] + FAILED_LINES + NO_REASON)
        self.assertEqual(stdout, "")
        self.assertEqual(len(calls), 2)

    def test_a_timed_out_command_and_an_unnamed_failure_are_announced(self):
        for status in (124, 137):
            with self.subTest(status=status):
                raised, _stdout, stages, _calls = self.drive([(status, b"", b"")])
                self.assertIsInstance(raised, ValueError)
                self.assertEqual(stages, SETUP_STAGES + BOUNDARY_STAGES[:1] + ["qualify-failed-timeout", "qualify-failed-no-test-name"])
        raised, _stdout, stages, _calls = self.drive([(1, b"error: private text\n", b"panic at /home/ompbuild/secret 10.1.2.3\n")])
        self.assertIsInstance(raised, ValueError)
        self.assertEqual(stages, SETUP_STAGES + BOUNDARY_STAGES[:1] + ["qualify-failed-no-test-name"])

    def test_exit_zero_without_a_passing_test_or_with_a_failure_is_named_too(self):
        raised, _stdout, stages, _calls = self.drive([(0, b"", b" 0 pass\n")])
        self.assertIsInstance(raised, ValueError)
        self.assertEqual(stages[-1:], ["qualify-failed-no-test-name"])
        raised, _stdout, stages, _calls = self.drive([(0, b"", b"(fail) one [1.00ms]\n 3 pass\n 1 fail\n")])
        self.assertIsInstance(raised, ValueError)
        self.assertEqual(stages[-2:], ["qualify-failed-one", *NO_REASON])

    def test_the_inside_entry_point_prints_only_stage_lines_and_exits_one(self):
        raised, stdout, stages, _calls = self.drive([PASSING, (1, b"", BUN_FAILURES)], entry=qualify.main, argv=("qualify", "--inside"))
        self.assertIsInstance(raised, SystemExit)
        self.assertEqual(raised.code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(stages, SETUP_STAGES + BOUNDARY_STAGES[:2] + FAILED_LINES + NO_REASON)
        shown = "\n".join(stages)
        for private in ("/home/ompbuild", "10.1.2.3", "a@b.example", "bun test", "744846f84", "[0.64ms]", "Ran 6 tests", "\u00fc"):
            self.assertNotIn(private, shown)

    def test_the_hosts_forwarding_and_the_doors_own_filters_pass_the_failed_lines_on(self):
        progress, address = door_filters()
        raised, _stdout, stages, _calls = self.drive([PASSING, (124, b"", BUN_FAILURES)])
        self.assertIsInstance(raised, ValueError)
        with contextlib.redirect_stdout(io.StringIO()) as forwarded:
            qualify.forward_stages(io.BytesIO(("\n".join(stages) + "\n").encode()), frozenset(BOUNDARY_STAGES))
        lines = forwarded.getvalue().splitlines()
        self.assertEqual(lines, stages)
        self.assertEqual([line for line in lines if line.startswith("qualify-failed-")], ["qualify-failed-timeout", *FAILED_LINES, *NO_REASON])
        for line in lines:
            self.assertIsNotNone(progress.fullmatch(line), line)
            self.assertIsNone(address.search(line), line)

    def test_a_real_bun_failure_announces_names_then_reasons_and_nothing_else(self):
        raised, stdout, stages, calls = self.drive([PASSING, (1, b"", REAL_ALL), PASSING])
        self.assertIsInstance(raised, ValueError)
        self.assertEqual(stages, SETUP_STAGES + BOUNDARY_STAGES[:2] + REAL_NAME_LINES + list(REAL_REASONS.values())[:4])
        self.assertEqual(stdout, "")
        self.assertEqual(len(calls), 2)
        shown = "\n".join(stages)
        for private in ("/home/ompbuild", "10.1.2.3", "sk-test", "boom", "Expected", "Received", "/workspace", "no such file", "permission"):
            self.assertNotIn(private, shown)

    def test_a_test_timeout_note_is_reported_as_the_reason(self):
        output = REAL_HEAD + REAL_FAILURES["times out"] + REAL_TAIL
        raised, _stdout, stages, _calls = self.drive([(1, b"", output)])
        self.assertIsInstance(raised, ValueError)
        self.assertEqual(stages[-2:], ["qualify-failed-suite-one-times-out", "qualify-failed-why-timeout"])

    def test_the_hosts_forwarding_and_the_doors_own_filters_pass_eight_names_and_four_reasons_on(self):
        progress, address = door_filters()
        raised, _stdout, stages, _calls = self.drive([(124, b"", REAL_ALL)])
        self.assertIsInstance(raised, ValueError)
        failed = [line for line in stages if line.startswith("qualify-failed-")]
        self.assertEqual(failed, ["qualify-failed-timeout", *REAL_NAME_LINES[:7], *list(REAL_REASONS.values())[:4]])
        with contextlib.redirect_stdout(io.StringIO()) as forwarded:
            qualify.forward_stages(io.BytesIO(("\n".join(stages) + "\n").encode()), frozenset(BOUNDARY_STAGES))
        self.assertEqual(forwarded.getvalue().splitlines(), stages)
        for line in stages:
            self.assertIsNotNone(progress.fullmatch(line), line)
            self.assertIsNone(address.search(line), line)


class DoorFilterTests(unittest.TestCase):
    """The door (scripts/ci001/omp-build-entry, installed on ci-001, never edited here) forwards only allowlisted shapes."""

    def test_the_doors_filters_were_read_from_the_entry_file(self):
        progress, address = door_filters()
        self.assertIsNotNone(progress.fullmatch("qualify-boundary-alpha-contract-1"))
        self.assertIsNotNone(progress.fullmatch("Phase: door qualify."))
        self.assertIsNotNone(address.search("10.1.2.3"))
        self.assertIsNotNone(address.search("fe80::1:"))

    def test_every_failed_line_the_recipe_can_make_is_forwarded_and_never_dropped_as_an_address(self):
        progress, address = door_filters()
        hostile = b"(fail) 192.168.0.1 fe80::1 10.0.0.1:8080 user@example.org /home/ompbuild/x.ts a:b:c dead:beef:: [1.00ms]\n"
        numbers = b"".join(b"(fail) %d.%d.%d.%d\n" % (n, n, n, n) for n in (1, 10, 100, 255)) + b"(fail) 1:2:3:4\n(fail) ::1\n(fail) abcd:ef12:\n"
        samples = [*qualify.failed_stages(1, BUN_FAILURES), *qualify.failed_stages(124, hostile), *qualify.failed_stages(1, numbers),
                   *qualify.failed_stages(137, b""), *qualify.failed_stages(1, b""), "qualify-failed-" + "a" * 97, "qualify-failed-0"]
        self.assertGreater(len(samples), 12)
        for line in samples:
            self.assertTrue(qualify.valid_stage(line), line)
            self.assertIsNotNone(progress.fullmatch(line), line)
            self.assertIsNone(address.search(line), line)

    def test_every_reason_line_the_recipe_can_make_is_forwarded_and_never_dropped_as_an_address(self):
        progress, address = door_filters()
        longest = "qualify-failed-why-expect-not-to" + "a" * 38 + "-at-" + "f" * 48 + "-999999"
        digits = qualify.failed_reasons(b"error: E12: 10.1.2.3\n" + b"      at f (/workspace/source/1.2.3.4.ts:10:20)\n(fail) a\n", SOURCE)
        samples = [*REAL_REASONS.values(), longest, *digits, *NO_REASON, "qualify-failed-why-" + "a" * 121, "qualify-failed-why-timeout"]
        self.assertEqual(digits, ["qualify-failed-why-e12-at-1-2-3-4-ts-10"])
        for line in samples:
            self.assertTrue(qualify.valid_stage(line), line)
            self.assertIsNotNone(progress.fullmatch(line), line)
            self.assertIsNone(address.search(line), line)

    def test_the_door_still_drops_anything_that_is_not_a_plain_hyphenated_name(self):
        progress, address = door_filters()

        def forwarded(text):
            return progress.fullmatch(text) is not None and address.search(text) is None

        for dropped in ("qualify-failed-a.b", "qualify-failed-a:b:c", "qualify-failed-10.1.2.3", "qualify-failed-a/b", "qualify-failed-a@b",
                        "qualify-failed-A", "qualify-failed-a b", "qualify-failed-", "(fail) suite one > x", "qualify-failed-a\n"):
            self.assertFalse(forwarded(dropped), dropped)


if __name__ == "__main__":
    unittest.main()
