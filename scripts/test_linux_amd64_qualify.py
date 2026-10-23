#!/usr/bin/env python3
"""Offline qualification fixtures: no Docker, Bun, OMP, build, or network execution."""
import argparse
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
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


def success(manifest):
    return {
        "binary_sha256": manifest["asset"]["sha256"], "source_commit": manifest["source"]["commit"],
        "recipe_commit": manifest["source"]["recipe_commit"],
        "environment": {"execution": "native-amd64", "cpu": "x86-64-v2", "glibc": "2.41", "loader": "ld-linux-x86-64.so.2", "runtime_image": IMAGE_DIGEST},
        "checks": {check: "passed" for check in receipt.CHECKS},
    }


def source_fixture(source, boundaries=None):
    boundaries = qualify.BOUNDARIES if boundaries is None else boundaries
    source.mkdir(parents=True, exist_ok=True)
    block = "\n".join(f"- `{name}`: Fixture" for name in boundaries)
    (source / "README.md").write_text("<!-- stronk-omp:fork-contracts:start -->\n" + block + "\n<!-- stronk-omp:fork-contracts:end -->\n")
    for commands in boundaries.values():
        for command in commands:
            for item in shlex.split(command):
                if item.endswith(".test.ts"):
                    path = source / item
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("// offline fixture\n")


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


class BoundaryTests(unittest.TestCase):
    def test_every_active_snapshot_command_runs_in_order_without_shell(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            source_fixture(source)
            commands = qualify.boundary_commands(source)
            expected = [[*shlex.split(command), "--timeout=30000"] for group in qualify.BOUNDARIES.values() for command in group]
            self.assertEqual(commands, expected)
            self.assertEqual(len(qualify.BOUNDARIES), 27)
            self.assertEqual(len(commands), 41)
            self.assertEqual(len(qualify.REGISTRY_SHA256), 64)
            self.assertTrue(all(command[:2] == ["bun", "test"] for command in commands))

    def test_missing_active_id_or_file_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            source_fixture(source)
            readme = source / "README.md"
            readme.write_text(readme.read_text().replace("- `required-extension-enforcement`: Fixture\n", ""))
            with self.assertRaises(ValueError):
                qualify.boundary_commands(source)
            source_fixture(source)
            next(source.glob("packages/coding-agent/test/required-extension-gate.test.ts")).unlink()
            with self.assertRaises(ValueError):
                qualify.boundary_commands(source)

    def test_duplicate_or_unrecognized_active_id_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            source_fixture(source)
            readme = source / "README.md"
            for item in ("required-extension-enforcement", "unreviewed-contract"):
                original = readme.read_text()
                readme.write_text(original.replace("<!-- stronk-omp:fork-contracts:end -->", f"- `{item}`: Fixture\n<!-- stronk-omp:fork-contracts:end -->"))
                with self.assertRaises(ValueError):
                    qualify.boundary_commands(source)
                readme.write_text(original)

    def test_filters_preserved_and_unsupported_commands_rejected(self):
        boundaries = {"fixture": ["bun test fixture.test.ts --test-name-pattern 'first filter'", "bun test fixture.test.ts --test-name-pattern 'second filter'"]}
        with tempfile.TemporaryDirectory() as temporary, patch.object(qualify, "BOUNDARIES", boundaries):
            source = Path(temporary)
            source_fixture(source, boundaries)
            self.assertEqual(qualify.boundary_commands(source), [
                ["bun", "test", "fixture.test.ts", "--test-name-pattern", "first filter", "--timeout=30000"],
                ["bun", "test", "fixture.test.ts", "--test-name-pattern", "second filter", "--timeout=30000"],
            ])
            boundaries["fixture"] = ["bun install"]
            with self.assertRaises(ValueError):
                qualify.boundary_commands(source)

    def preflight(self, files, commit="c" * 40):
        with patch.object(receipt, "check_toolchain", return_value="18.12.6") as toolchain, \
             patch.object(receipt, "git_has", return_value=True), \
             patch.object(receipt, "git_bytes", side_effect=lambda _root, _rev, path: files[path]):
            result = qualify.application_preflight(Path("fixture-tree"), commit)
        toolchain.assert_called_once_with(Path("fixture-tree"), commit)
        return result

    def readme(self, names=None):
        names = list(qualify.BOUNDARIES) if names is None else names
        block = "\n".join(f"- `{name}`: Fixture" for name in names)
        return {"README.md": ("<!-- stronk-omp:fork-contracts:start -->\n" + block +
                              "\n<!-- stronk-omp:fork-contracts:end -->\n").encode()}

    def test_application_preflight_accepts_a_matching_application_without_a_checkout(self):
        self.assertEqual(self.preflight(self.readme()), ("18.12.6", 27))

    def test_application_preflight_refuses_changed_contracts_or_missing_tests_with_a_clear_reason(self):
        names = list(qualify.BOUNDARIES)
        for files, reason in (
                (self.readme(names[1:]), "fork contracts differ from this recipe's registry snapshot"),
                (self.readme(names + ["unreviewed-contract"]), "fork contracts differ from this recipe's registry snapshot"),
                ({"README.md": b"no contract block here\n"}, "Missing immutable boundary map")):
            with self.subTest(reason=reason), self.assertRaises(receipt.RouteError) as raised:
                self.preflight(files)
            self.assertIn(reason, str(raised.exception))
        with patch.object(receipt, "check_toolchain", return_value="18.12.6"), \
             patch.object(receipt, "git_has", return_value=False), \
             patch.object(receipt, "git_bytes", side_effect=lambda _root, _rev, path: self.readme()[path]):
            with self.assertRaises(receipt.RouteError) as raised:
                qualify.application_preflight(Path("fixture-tree"), "c" * 40)
        self.assertIn("missing from the application: packages/coding-agent/test/required-extension-gate.test.ts", str(raised.exception))

    def test_toolchain_mismatch_surfaces_before_any_contract_work(self):
        with patch.object(receipt, "check_toolchain", side_effect=receipt.RouteError("The application needs Bazel 9.3.0")), \
             patch.object(receipt, "git_bytes") as read:
            with self.assertRaises(receipt.RouteError):
                qualify.application_preflight(Path("fixture-tree"), "c" * 40)
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
        metadata = {"schema": 1, "source_commit": COMMIT, "bun_version": "1.4.2",
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
                return b"1.4.2\n", b""

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

    def finalize(self, *args):
        qualify.finalize(*args, self.key, self.attestation)

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
                "schema": 1, "binary_sha256": receipt.digest(directory / receipt.ASSETS[0]),
                "source_commit": COMMIT, "recipe_commit": RECIPE,
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

    def test_wrong_tuple_or_environment_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = fixture(Path(temporary))
            for field, replacement in (("binary_sha256", "f" * 64), ("source_commit", "c" * 40), ("recipe_commit", RECIPE)):
                result = success(manifest)
                result[field] = replacement
                with self.assertRaises(ValueError):
                    qualify.validate_result(result, manifest, IMAGE_DIGEST)
            for field, replacement in (("execution", "emulated"), ("cpu", "x86-64-v3"), ("glibc", "2.17"),
                                       ("loader", "other.so"), ("runtime_image", "qualification/runtime:mutable")):
                result = success(manifest)
                result["environment"][field] = replacement
                with self.assertRaises(ValueError):
                    qualify.validate_result(result, manifest, IMAGE_DIGEST)


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
                                  runtime_image=IMAGE, docker_socket="unix:///runtime/docker.sock", witness_run_id=run_id)
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
                self.assertEqual(completed["qualification"], success(manifest))
                receipt.verify_attestation(completed, args.attestation, signers)
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

    def test_cli_sanitizes_subprocess_failures(self):
        arguments = ["qualify", "--commit", COMMIT, "--assets", "/fixture/assets", "--runtime-image", IMAGE,
                     "--docker-socket", "unix:///runtime/docker.sock",
                     "--attestation-key", "fixture-key", "--attestation", "fixture-attestation"]
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


class RuntimeStartupTests(unittest.TestCase):
    def test_initializes_native_xdg_namespace_on_executable_runtime_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = root / "request.json"
            request.write_text(json.dumps({"manifest": {"source": {"commit": COMMIT}},
                                           "runtime_image": IMAGE_DIGEST}))
            cpu = root / "cpuinfo"
            cpu.write_text("flags: ssse3 sse4_1 sse4_2 popcnt cx16 lahf_lm pni\n")
            runtime = root / "runtime"
            paths = {"/input/assets/request.json": request, "/proc/cpuinfo": cpu, "/runtime": runtime}

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

        def stage(name, **_kwargs):
            if name == "qualify-native-grep":
                raise RuntimeError("boundary fixture complete")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            assets = root / "assets"
            assets.mkdir()
            manifest = fixture(assets)
            source = root / "source"
            source_fixture(source)
            (source / "packages/coding-agent/package.json").write_text('{"version":"18.8.0"}')
            for name in receipt.LOCKS:
                (source / name).write_text("fixture lock")
                manifest["build_inputs"]["locks"][name] = receipt.digest(source / name)
            request = root / "request.json"
            request.write_text(json.dumps({"manifest": manifest, "runtime_image": IMAGE_DIGEST}))
            cpu = root / "cpuinfo"
            cpu.write_text("flags: ssse3 sse4_1 sse4_2 popcnt cx16 lahf_lm pni\n")
            native = root / "native.node"
            native.write_bytes(b"fixture native")
            paths = {"/input/assets/request.json": request, "/proc/cpuinfo": cpu,
                     "/runtime": root / "runtime", "/workspace/source": source,
                     "/workspace/omp": root / "omp", "/input/assets/omp-linux-amd64": assets / receipt.ASSETS[0]}
            real_copyfile = shutil.copyfile

            def copyfile(source, destination):
                return real_copyfile(paths.get(str(source), source), destination)

            with patch.object(qualify, "Path", side_effect=lambda value: paths.get(str(value), Path(value))), \
                 patch.object(qualify.os, "uname", return_value=type("Uname", (), {"machine": "x86_64"})()), \
                 patch.object(qualify, "Runtime", FakeRuntime), \
                 patch.object(qualify, "prepare_dependencies", return_value=root / "grep"), \
                 patch.object(qualify.shutil, "copytree"), patch.object(qualify.shutil, "copyfile", side_effect=copyfile), \
                 patch.object(receipt, "elf", return_value=manifest["runtime"]["binary"]), \
                 patch.object(qualify, "native_help", return_value=native), \
                 patch.object(qualify, "offline_session"), patch.object(qualify, "require_markers"), \
                 patch.object(qualify, "announce_stage", side_effect=stage):
                with self.assertRaisesRegex(RuntimeError, "boundary fixture complete"):
                    qualify.runtime_main()
            boundaries = [call for call in calls if call[0][:2] == ["bun", "test"]]
            self.assertEqual([call[0] for call in boundaries], [
                [*shlex.split(command), "--timeout=30000"]
                for group in qualify.BOUNDARIES.values() for command in group
            ])
            self.assertEqual(len(boundaries), 41)
            controls = {"PI_TEST_RUNTIME": "1", "BUN_JSC_useConcurrentGC": "0", "BUN_JSC_numberOfGCMarkers": "1"}
            for _command, environment, seconds in boundaries:
                self.assertEqual({key: environment.get(key) for key in controls}, controls)
                self.assertEqual(seconds, 240)
            smoke = next(call for call in calls if call[0][-1] == "--smoke-test")
            self.assertTrue(all(key not in smoke[1] for key in controls))


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
                        b"qualify-smoke \n", b"\xff\n", b"x" * 8193):
            with self.subTest(payload=payload), contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(ValueError):
                    qualify.forward_stages(io.BytesIO(payload))
                self.assertEqual(output.getvalue(), "")
        with contextlib.redirect_stdout(io.StringIO()) as output:
            qualify.forward_stages(io.BytesIO(b"qualify-help\nqualify-smoke\n"))
        self.assertEqual(output.getvalue(), "qualify-help\nqualify-smoke\n")


if __name__ == "__main__":
    unittest.main()
