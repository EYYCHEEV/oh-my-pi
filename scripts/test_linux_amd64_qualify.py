#!/usr/bin/env python3
"""Offline qualification fixtures: no Docker, Bun, OMP, build, or network execution."""
import argparse
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import socket
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location("qualify_linux_amd64", Path(__file__).with_name("linux-amd64-qualify.py"))
qualify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qualify)
receipt = qualify.receipt
IMAGE = "qualification/runtime@sha256:" + "1" * 64
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
        "source": {"commit": receipt.APPLICATION_COMMIT, "tag": TAG if committed else None,
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
        "environment": {"execution": "native-amd64", "cpu": "x86-64-v2", "glibc": "2.41", "loader": "ld-linux-x86-64.so.2", "runtime_image": IMAGE},
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
        with patch.object(qualify, "docker_output", side_effect=["x86_64", "amd64"]) as output:
            qualify.approved_daemon(docker, IMAGE)
        self.assertEqual(output.call_args_list[0].args[1], ["info", "--format", "{{.Architecture}}"])
        self.assertEqual(output.call_args_list[1].args[1], ["image", "inspect", "--format", "{{.Architecture}}", IMAGE])

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
        self.assertNotIn("--platform", command)
        self.assertNotIn("--privileged", command)
        self.assertEqual(command[-3:], ["--entrypoint=/bin/sh", IMAGE, "/recipe/linux-amd64-smoke.sh"])


class BoundaryTests(unittest.TestCase):
    def test_every_active_snapshot_command_runs_in_order_without_shell(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            source_fixture(source)
            commands = qualify.boundary_commands(source)
            expected = [shlex.split(command) for group in qualify.BOUNDARIES.values() for command in group]
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
            self.assertEqual([command[-1] for command in qualify.boundary_commands(source)], ["first filter", "second filter"])
            boundaries["fixture"] = ["bun install"]
            with self.assertRaises(ValueError):
                qualify.boundary_commands(source)


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
        metadata = {"schema": 1, "source_commit": receipt.APPLICATION_COMMIT, "bun_version": "1.4.2",
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
            self.assertEqual(runtime.calls, [["bun", "--version"]])
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
    def test_candidate_can_qualify_but_can_never_publish(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = fixture(directory)
            qualify.finalize(directory, manifest, success(manifest), IMAGE, False, receipt.APPLICATION_COMMIT, "")
            completed = receipt.verify(directory, receipt.APPLICATION_COMMIT, "", False, root=False)
            self.assertIs(completed["source"]["recipe_committed"], False)
            self.assertIsNone(completed["source"]["recipe_commit"])
            self.assertEqual(completed["checks"], {check: "passed" for check in receipt.CHECKS})
            with self.assertRaises(ValueError):
                receipt.verify(directory, receipt.APPLICATION_COMMIT, "", True, root=False)
            self.assertEqual({item.name for item in directory.iterdir()}, set(receipt.ASSETS))

    def test_committed_tuple_qualifies_exactly(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = fixture(directory, committed=True)
            qualify.finalize(directory, manifest, success(manifest), IMAGE, False, receipt.APPLICATION_COMMIT, RECIPE)
            self.assertEqual(receipt.verify(directory, receipt.APPLICATION_COMMIT, TAG, True, RECIPE, root=False)["qualification"], success(manifest))

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
                    qualify.finalize(directory, manifest, result, IMAGE, False, receipt.APPLICATION_COMMIT, "")
                self.assertEqual((directory / receipt.ASSETS[1]).read_bytes(), original)

    def test_altered_binary_or_manifest_never_finalizes(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest = fixture(directory)
            with (directory / receipt.ASSETS[0]).open("ab") as binary:
                binary.write(b"changed")
            with self.assertRaises(ValueError):
                qualify.finalize(directory, manifest, success(manifest), IMAGE, False, receipt.APPLICATION_COMMIT, "")
            manifest = fixture(directory)
            other = copy.deepcopy(manifest)
            other["source"]["source_date_epoch"] = 2
            receipt.save_manifest(directory, other)
            with self.assertRaises(ValueError):
                qualify.finalize(directory, manifest, success(manifest), IMAGE, False, receipt.APPLICATION_COMMIT, "")

    def test_wrong_tuple_or_environment_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest = fixture(Path(temporary))
            for field, replacement in (("binary_sha256", "f" * 64), ("source_commit", "c" * 40), ("recipe_commit", RECIPE)):
                result = success(manifest)
                result[field] = replacement
                with self.assertRaises(ValueError):
                    qualify.validate_result(result, manifest, IMAGE)
            for field, replacement in (("execution", "emulated"), ("cpu", "x86-64-v3"), ("glibc", "2.17"),
                                       ("loader", "other.so"), ("runtime_image", "qualification/runtime:mutable")):
                result = success(manifest)
                result["environment"][field] = replacement
                with self.assertRaises(ValueError):
                    qualify.validate_result(result, manifest, IMAGE)


class HostFlowTests(unittest.TestCase):
    def run_fixture(self, directory, *, committed=False, fail=False, changed=False):
        assets, root = directory / "assets", directory / "root"
        assets.mkdir()
        (root / "scripts").mkdir(parents=True)
        manifest = fixture(assets, committed)
        for name in receipt.RECIPES:
            (root / "scripts" / name).write_text("offline recipe fixture\n")
            manifest["build_inputs"]["recipe"][name] = receipt.digest(root / "scripts" / name)
        receipt.save_manifest(assets, manifest)
        args = argparse.Namespace(commit=receipt.APPLICATION_COMMIT, recipe_commit=RECIPE if committed else "", assets=assets,
                                  runtime_image=IMAGE, docker_socket="unix:///runtime/docker.sock")
        real_verify = receipt.verify
        calls = []

        def fake_output(command, **kwargs):
            calls.append(command)
            if "info" in command:
                return b"x86_64\n"
            if "image" in command:
                return b"amd64\n"
            self.assertIn("run", command)
            self.assertIn("--config", command)
            if fail:
                raise subprocess.CalledProcessError(1, command, output=b"private fixture diagnostics")
            if changed:
                with (assets / receipt.ASSETS[0]).open("ab") as binary:
                    binary.write(b"changed")
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
             patch.object(subprocess, "run") as cleanup:
            if fail or changed:
                with self.assertRaises((ValueError, subprocess.SubprocessError)):
                    qualify.qualify(args, root)
                self.assertIsNone(json.loads((assets / receipt.ASSETS[1]).read_text())["qualification"])
            else:
                qualify.qualify(args, root)
                self.assertEqual(json.loads((assets / receipt.ASSETS[1]).read_text())["qualification"], success(manifest))
            self.assertEqual(assert_recipes.call_count, int(committed))
            cleanup.assert_called_once()
            self.assertEqual(cleanup.call_args.args[0][-3:-1], ["rm", "--force"])
            self.assertEqual(len(calls), 3)

    def test_normal_candidate_and_committed_flows_with_fake_daemon(self):
        for committed in (False, True):
            with self.subTest(committed=committed), tempfile.TemporaryDirectory() as temporary:
                self.run_fixture(Path(temporary), committed=committed)

    def test_runtime_failure_or_host_binary_change_does_not_mark_success(self):
        for options in ({"fail": True}, {"changed": True}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as temporary:
                self.run_fixture(Path(temporary), **options)

    def test_cli_sanitizes_subprocess_failures(self):
        arguments = ["qualify", "--commit", receipt.APPLICATION_COMMIT, "--assets", "/fixture/assets", "--runtime-image", IMAGE,
                     "--docker-socket", "unix:///runtime/docker.sock"]
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


if __name__ == "__main__":
    unittest.main()
