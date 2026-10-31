#!/usr/bin/env python3
"""Offline preparation fixtures. Every Git/build/Docker/process boundary is fake."""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch


SPEC = importlib.util.spec_from_file_location("linux_amd64_runtime", Path(__file__).with_name("linux-amd64-runtime.py"))
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
receipt = runtime.receipt
VALIDATE_DOCKER = receipt.validate_docker
RECIPE = "a" * 40
COMMIT = "5e43891a87140fb0972c982f3027f0228c4f6378"
WORKSPACE = "sha256:" + "b" * 64
IMAGE = "sha256:" + "c" * 64
CONTAINER = "d" * 64
FORK_DATA = json.dumps({
    "schemaVersion": 1, "requireDeclaredPaths": False,
    "readme": {"path": "README.md", "startMarker": "<!-- stronk-omp:fork-contracts:start -->",
               "endMarker": "<!-- stronk-omp:fork-contracts:end -->"},
    "contracts": [{"id": "fixture-contract", "title": "Fixture contract", "status": "active",
                   "verification": ["bun test packages/fixture/test/fixture.test.ts"]}]}).encode()
FORK_SHA = hashlib.sha256(FORK_DATA).hexdigest()


def recipe_bytes(name):
    return ("reviewed recipe " + name).encode()


class FakeClient:
    def __init__(self, _docker, scratch):
        self.scratch = scratch
        self.commands = []
        self.fail = ""
        self.architecture = "amd64"
        self.state = "false 0"
        self.image = IMAGE
        self.workspace = WORKSPACE

    def record(self, value):
        pass

    def call(self, args, capture=False, progress=False):
        self.commands.append(args)
        if args[0] == self.fail:
            raise ValueError("fake failure")
        if args[0] == "info":
            return self.architecture
        if args[0] == "build":
            Path(args[args.index("--iidfile") + 1]).write_text(self.workspace + "\n")
        elif args[:2] == ["image", "inspect"]:
            return "amd64" if args[3] == "{{.Architecture}}" else args[-1]
        elif args[0] == "create":
            return CONTAINER
        elif args[0] == "inspect":
            return self.state
        elif args[0] == "cp":
            Path(args[-1]).write_bytes(b"fake exported asset")
        elif args[0] == "commit":
            return self.image
        return ""


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "fork_boundary.json").write_bytes(FORK_DATA)
        self.args = argparse.Namespace(commit=COMMIT, recipe_commit=RECIPE,
                                       docker_socket="unix:///fixture/docker.sock", witness_run_id="offline-fixture",
                                       output="candidate", image_id_file=self.root / "image-id",
                                       fork_manifest=self.root / "fork_boundary.json", fork_manifest_sha256=FORK_SHA)
        self.client = FakeClient([], self.root)
        self.manifest = {"build_inputs": {"recipe": {
            name: hashlib.sha256(recipe_bytes(name)).hexdigest() for name in receipt.RECIPES}}}
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {}, clear=True))
        self.commit_exists = self.stack.enter_context(patch.object(receipt, "commit_exists"))
        self.assert_recipes = self.stack.enter_context(patch.object(receipt, "assert_recipes"))
        self.capture = self.stack.enter_context(patch.object(receipt, "capture", side_effect=lambda *args: RECIPE if args[-1] == "HEAD" else "1"))
        self.transport = self.stack.enter_context(patch.object(receipt, "validate_docker", return_value=["docker", "--host", self.args.docker_socket]))
        self.verify = self.stack.enter_context(patch.object(receipt, "verify", return_value=self.manifest))
        self.factory = self.stack.enter_context(patch.object(runtime, "Client", return_value=self.client))
        self.stack.enter_context(patch.object(runtime, "export_inputs", side_effect=self.export))
        self.preflight = self.stack.enter_context(patch.object(runtime.qualify, "application_preflight", return_value=("18.8.0", 27)))
        # A missed fake must fail closed, never contact Docker, Git, or a build.
        self.stack.enter_context(patch.object(subprocess, "Popen", side_effect=AssertionError("unexpected process")))
        self.stack.enter_context(patch.object(subprocess, "run", side_effect=AssertionError("unexpected process")))
        self.stack.enter_context(patch.object(subprocess, "check_output", side_effect=AssertionError("unexpected process")))

    def export(self, _root, _commit, _recipe, context):
        (context / "source").mkdir()
        (context / "recipe").mkdir()
        for name in receipt.RECIPES:
            (context / "recipe" / name).write_bytes(recipe_bytes(name))

    def run_preparation(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = runtime.prepare(self.args, self.root)
        return result, output.getvalue()

    def test_success_exports_exact_assets_and_private_id(self):
        result, output = self.run_preparation()
        self.assertEqual(result, IMAGE)
        self.assertEqual(self.args.image_id_file.read_text(), IMAGE + "\n")
        self.assertEqual(self.args.image_id_file.stat().st_mode & 0o777, 0o600)
        destination = self.root / "dist/candidate"
        self.assertEqual({item.name for item in destination.iterdir()}, set(receipt.ASSETS))
        self.assertTrue(os.access(destination / receipt.ASSETS[0], os.X_OK))
        self.assertIn(IMAGE, output)
        self.assertNotIn(str(self.root), output)
        self.assert_recipes.assert_called_once_with(self.root, RECIPE)
        self.assertEqual(self.verify.call_args.args[1:], (self.args.commit, "", False, "", self.root))
        commands = self.client.commands
        kinds = [command[0] for command in commands]
        self.assertEqual(kinds.count("cp"), 3)
        self.assertLess(max(index for index, kind in enumerate(kinds) if kind == "cp"), kinds.index("commit"))
        self.assertLess(kinds.index("commit"), kinds.index("rm"))
        self.assertEqual(commands[-1], ["rm", CONTAINER])
        self.assertTrue(list((self.root / "dist").glob(".linux-amd64-runtime.*")))

    def test_workspace_only_and_candidate_identity_without_pin_overrides(self):
        self.run_preparation()
        build = next(command for command in self.client.commands if command[0] == "build")
        self.assertIn("--target=workspace", build)
        self.assertIn("--output=type=docker", build)
        self.assertIn("--iidfile", build)
        self.assertIn("RECIPE_COMMITTED=0", build)
        self.assertIn("RECIPE_COMMIT=", build)
        self.assertIn("SOURCE_TAG=", build)
        self.assertIn("WITNESS_RUN_ID=offline-fixture", build)
        self.assertFalse(any(value in build for value in ("--tag", "-t", "--builder", "--push")))
        build_args = [build[index + 1] for index, value in enumerate(build) if value == "--build-arg"]
        self.assertFalse(any(value.startswith(("BASE_IMAGE=", "BUN_VERSION=", "BAZEL_VERSION=")) for value in build_args))
        commit = next(command for command in self.client.commands if command[0] == "commit")
        self.assertEqual(commit[-1], CONTAINER)
        self.assertIn("USER 65532:65532", commit)
        self.assertIn("ENV PATH=/usr/local/bin:/usr/bin:/bin", commit)
        self.assertIn("LABEL org.stronk.omp-witness=offline-fixture", commit)

    def test_release_preparation_uses_one_validated_tuple_and_one_build(self):
        self.args.tag = "stronk-omp-s1-2026.10.16.0001"
        self.args.allowed_signers = self.root / "source-allowed-signers"
        self.args.revoked_signers = self.root / "source-revoked-signers"
        self.args.allowed_signers.write_text("fixture public enrollment")
        self.args.revoked_signers.write_bytes(b"")
        self.manifest["source"] = {"tag_object": "b" * 40}
        with patch.object(receipt, "validate_tag", return_value="b" * 40) as validate:
            self.run_preparation()
        validate.assert_called_once_with(self.root, self.args.commit, self.args.tag,
                                         self.args.allowed_signers, self.args.revoked_signers)
        builds = [command for command in self.client.commands if command[0] == "build"]
        self.assertEqual(len(builds), 1)
        build = builds[0]
        self.assertEqual([build[index + 1] for index, value in enumerate(build) if value == "--build-arg"], [
            "SOURCE_COMMIT=5e43891a87140fb0972c982f3027f0228c4f6378",
            "SOURCE_TAG=stronk-omp-s1-2026.10.16.0001", "SOURCE_TAG_OBJECT=" + "b" * 40,
            "SOURCE_DATE_EPOCH=1", "RECIPE_COMMITTED=1", "RECIPE_COMMIT=" + "a" * 40,
            "WITNESS_RUN_ID=offline-fixture"])
        self.assertEqual(self.verify.call_args.args[1:],
                         (self.args.commit, self.args.tag, False, RECIPE, self.root))

    def test_invalid_release_tag_is_rejected_before_docker(self):
        self.args.tag = "stronk-omp-s1-2026.10.16.0001"
        self.args.allowed_signers = self.root / "source-allowed-signers"
        self.args.revoked_signers = self.root / "source-revoked-signers"
        with patch.object(receipt, "validate_tag", side_effect=ValueError("untrusted tag")):
            with self.assertRaises(ValueError):
                self.run_preparation()
        self.transport.assert_not_called()
        self.factory.assert_not_called()

    def test_release_tag_object_mismatch_never_snapshots_or_exports(self):
        self.args.tag = "stronk-omp-s1-2026.10.16.0001"
        self.args.allowed_signers = self.root / "source-allowed-signers"
        self.args.revoked_signers = self.root / "source-revoked-signers"
        self.manifest["source"] = {"tag_object": "c" * 40}
        with patch.object(receipt, "validate_tag", return_value="b" * 40):
            with self.assertRaisesRegex(ValueError, "source tag object differs"):
                self.run_preparation()
        self.assertNotIn("commit", [command[0] for command in self.client.commands])
        self.assertFalse(self.args.image_id_file.exists())
        self.assertFalse((self.root / "dist/candidate").exists())

    def test_candidate_rejects_ignored_source_signer_options(self):
        self.args.allowed_signers = self.root / "source-allowed-signers"
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.transport.assert_not_called()
        self.factory.assert_not_called()

    def test_any_application_commit_is_built_after_the_early_application_check(self):
        self.args.commit = "e" * 40
        self.run_preparation()
        self.preflight.assert_called_once()
        self.assertEqual(self.preflight.call_args.args[:2], (self.root, "e" * 40))
        self.assertEqual(self.preflight.call_args.args[2]["contracts"][0]["id"], "fixture-contract")
        build = next(command for command in self.client.commands if command[0] == "build")
        self.assertIn("SOURCE_COMMIT=" + "e" * 40, build)

    def test_application_the_recipe_cannot_qualify_is_refused_before_any_daemon(self):
        self.preflight.side_effect = receipt.RouteError("The application needs Bazel 9.3.0 but this recipe pins Bazel 9.2.0")
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.transport.assert_not_called()
        self.factory.assert_not_called()

    def test_a_missing_altered_or_unstated_registry_is_refused_before_any_daemon(self):
        swapped = self.root / "swapped.json"
        swapped.write_bytes(FORK_DATA.replace(b"fixture.test.ts", b"weaker.test.ts"))
        for updates in ({"fork_manifest": self.root / "absent.json"}, {"fork_manifest": swapped},
                        {"fork_manifest_sha256": "0" * 64}, {"fork_manifest_sha256": ""}, {"fork_manifest_sha256": "short"},
                        {"fork_manifest": None}):
            with self.subTest(updates={key: str(value)[-12:] for key, value in updates.items()}):
                args = argparse.Namespace(**(vars(self.args) | updates))
                with self.assertRaises(ValueError):
                    runtime.prepare(args, self.root)
        self.preflight.assert_not_called()
        self.transport.assert_not_called()
        self.factory.assert_not_called()

    def test_early_input_rejections_never_construct_client(self):
        cases = ({"commit": "short"}, {"commit": "E" * 40}, {"recipe_commit": "short"}, {"witness_run_id": ""},
                 {"witness_run_id": "bad label"}, {"witness_run_id": "a" * 49},
                 {"output": "../escape"}, {"output": "/absolute"},
                 {"image_id_file": self.root / "dist/candidate/image-id"})
        for updates in cases:
            with self.subTest(updates=updates):
                args = argparse.Namespace(**(vars(self.args) | updates))
                with self.assertRaises(ValueError):
                    runtime.prepare(args, self.root)
        self.factory.assert_not_called()

    def test_checked_out_head_and_recipe_bytes_are_required(self):
        self.capture.side_effect = lambda *args: "f" * 40
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.factory.assert_not_called()
        self.capture.side_effect = lambda *args: RECIPE if args[-1] == "HEAD" else "1"
        self.assert_recipes.side_effect = ValueError("changed recipe")
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.factory.assert_not_called()

    def test_existing_output_or_image_file_is_not_overwritten(self):
        (self.root / "dist/candidate").mkdir(parents=True)
        with self.assertRaises(ValueError):
            self.run_preparation()
        (self.root / "dist/candidate").rmdir()
        self.args.image_id_file.write_text("retain")
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.assertEqual(self.args.image_id_file.read_text(), "retain")
        self.factory.assert_not_called()

    def test_symlink_dist_and_image_file_are_rejected(self):
        (self.root / "other").mkdir()
        (self.root / "dist").symlink_to(self.root / "other", target_is_directory=True)
        with self.assertRaises(ValueError):
            self.run_preparation()
        (self.root / "dist").unlink()
        self.args.image_id_file.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.factory.assert_not_called()

    def test_ambient_selection_and_transport_rejected_before_daemon(self):
        self.transport.side_effect = VALIDATE_DOCKER
        with patch.dict(os.environ, {"DOCKER_BUILDKIT": "0"}):
            with self.assertRaises(ValueError):
                self.run_preparation()
        self.transport.side_effect = ValueError("not local")
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.factory.assert_not_called()

    def test_non_native_daemon_and_invalid_workspace_id_stop_early(self):
        self.client.architecture = "arm64"
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.assertEqual([command[0] for command in self.client.commands], ["info"])
        self.client.commands.clear()
        self.client.architecture = "amd64"
        self.client.workspace = "mutable-image"
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.assertNotIn("create", [command[0] for command in self.client.commands])

    def test_failures_preserve_stopped_container_and_do_not_remove(self):
        for operation in ("start", "cp", "commit"):
            with self.subTest(operation=operation):
                self.client.commands.clear()
                self.client.fail = operation
                with self.assertRaises(ValueError):
                    self.run_preparation()
                self.assertEqual(self.client.commands[-1], ["stop", "--time=30", CONTAINER])
                self.assertNotIn("rm", [command[0] for command in self.client.commands])
                self.assertFalse(self.args.image_id_file.exists())
                self.assertFalse((self.root / "dist/candidate").exists())

    def test_nonzero_container_and_wrong_recipe_never_commit(self):
        self.client.state = "false 1"
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.assertNotIn("cp", [command[0] for command in self.client.commands])
        self.client.commands.clear()
        self.client.state = "false 0"
        self.manifest["build_inputs"]["recipe"][receipt.RECIPES[0]] = "0" * 64
        with self.assertRaises(ValueError):
            self.run_preparation()
        self.assertNotIn("commit", [command[0] for command in self.client.commands])


class ContractTests(unittest.TestCase):
    def test_candidate_build_argv_snapshot(self):
        self.assertEqual(runtime.build_command(Path("/fixture/context"), Path("/fixture/image-id"),
                                              "5e43891a87140fb0972c982f3027f0228c4f6378", "1", "fixture-run"), [
            "build", "--platform=linux/amd64", "--target=workspace", "--file",
            "/fixture/context/recipe/linux-amd64.Dockerfile", "--iidfile", "/fixture/image-id",
            "--provenance=false", "--sbom=false", "--progress=plain", "--output=type=docker",
            "--label", "org.stronk.omp-witness=fixture-run",
            "--build-arg", "SOURCE_COMMIT=5e43891a87140fb0972c982f3027f0228c4f6378",
            "--build-arg", "SOURCE_TAG=", "--build-arg", "SOURCE_TAG_OBJECT=",
            "--build-arg", "SOURCE_DATE_EPOCH=1", "--build-arg", "RECIPE_COMMITTED=0",
            "--build-arg", "RECIPE_COMMIT=", "--build-arg", "WITNESS_RUN_ID=fixture-run", "/fixture/context"])

    def test_hard_limits_and_no_host_mounts_or_tags(self):
        command = runtime.create_command(WORKSPACE, "fixture-run")
        for value in ("--cpus=4", "--memory=24g", "--memory-swap=24g", "--pids-limit=1024", "--log-driver=none",
                      "--pull=never", "org.stronk.omp-witness=fixture-run"):
            self.assertIn(value, command)
        self.assertFalse(any(value.startswith(("--mount", "--volume", "--env", "--secret")) for value in command))
        # Only the fixed, run-scoped name; the label stays the exact sweep key.
        self.assertEqual([value for value in command if value.startswith("--name")], ["--name=omp-build-fixture-run-prepare"])
        self.assertEqual(command[-3:], [WORKSPACE, "/recipe/linux-amd64-build.sh", "prepare-runtime"])
        with self.assertRaises(ValueError):
            runtime.create_command(WORKSPACE, "invalid label")

    def test_empty_client_configuration_and_environment(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {
                "PATH": "/fixture/bin", "SECRET_TOKEN": "not-forwarded", "BUILDX_BUILDER": "not-forwarded"}, clear=True):
            client = runtime.Client(["docker", "--host", "unix:///fixture/docker.sock"], Path(temporary))
            self.assertEqual(client.environment, {"PATH": "/fixture/bin", "HOME": str(Path(temporary) / "client-home"),
                                                  "LANG": "C", "LC_ALL": "C", "DOCKER_BUILDKIT": "1"})
            config = Path(client.command[-1])
            self.assertEqual(list(config.iterdir()), [])
            self.assertEqual(config.stat().st_mode & 0o777, 0o700)
            client.record({"operation": "build", "returncode": 1})
            self.assertEqual(client.diagnostics.stat().st_mode & 0o777, 0o600)

    def test_progress_keeps_only_allowlisted_phases_and_status(self):
        process = MagicMock()
        process.__enter__.return_value = process
        process.stdout = io.BytesIO(b"untrusted network diagnostics\n" + runtime.PHASES[0].encode() + b"\n")
        process.wait.return_value = 7
        with tempfile.TemporaryDirectory() as temporary:
            client = runtime.Client(["docker"], Path(temporary))
            with patch.object(subprocess, "Popen", return_value=process), contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(ValueError):
                    client.call(["build", "--target=workspace"], progress=True)
            self.assertEqual(output.getvalue(), runtime.PHASES[0] + "\n")
            diagnostic = client.diagnostics.read_text()
            self.assertNotIn("untrusted", diagnostic)
            self.assertIn('"returncode":7', diagnostic)

    def test_progress_deadline_kills_only_owned_client(self):
        process = MagicMock()
        process.__enter__.return_value = process
        process.stdout = io.BytesIO()
        process.wait.return_value = -9
        timer = MagicMock()

        def deadline(seconds, expire):
            self.assertEqual(seconds, 1800)
            timer.start.side_effect = expire
            return timer

        with tempfile.TemporaryDirectory() as temporary:
            client = runtime.Client(["docker"], Path(temporary))
            with patch.object(subprocess, "Popen", return_value=process), \
                    patch.object(runtime.threading, "Timer", side_effect=deadline):
                with self.assertRaises(subprocess.TimeoutExpired):
                    client.call(["build", "--target=workspace"], progress=True)
            process.kill.assert_called_once()
            timer.cancel.assert_called_once()
            self.assertIn('"status":"deadline_exceeded"', client.diagnostics.read_text())

    def test_recipe_export_reads_only_immutable_objects(self):
        with tempfile.TemporaryDirectory() as temporary:
            context = Path(temporary)
            with patch.object(runtime.qualify, "export_source") as source, \
                    patch.object(receipt, "git_bytes", side_effect=lambda _root, _rev, name: name.encode()) as git:
                runtime.export_inputs(context, COMMIT, RECIPE, context)
            source.assert_called_once_with(context, COMMIT, context / "source")
            self.assertEqual(git.call_count, len(receipt.RECIPES))
            for name in receipt.RECIPES:
                self.assertEqual((context / "recipe" / name).read_bytes(), ("scripts/" + name).encode())
            self.assertTrue(all(call.args[1] == RECIPE for call in git.call_args_list))

    def test_zero_native_tests_cannot_emit_prepared_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            prepared = Path(temporary)
            outputs = [b"timeout (GNU coreutils) 9.7\n", b"glibc 2.41\n",
                       b"GNU readelf (GNU Binutils) 2.44\n", b"1.4.4\n",
                       b"running 0 tests\ntest result: ok. 0 passed; 0 failed;\n"]
            with patch.object(runtime, "PREPARED", prepared), patch.object(runtime.sys, "version_info", (3, 12)), \
                    patch.object(Path, "read_bytes", return_value=b"{}"), \
                    patch.object(runtime, "prepared_metadata", return_value={"schema": 1}), \
                    patch.object(subprocess, "check_output", side_effect=outputs):
                with self.assertRaises(ValueError):
                    runtime.inside_prepare()
            self.assertFalse((prepared / "dependencies.json").exists())

    def test_metadata_uses_exact_qualifier_digest_and_bun_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            prepared = Path(temporary)
            source = prepared / "source"
            source.mkdir()
            for name in receipt.LOCKS:
                (source / name).write_text("locked " + name)
            modules = source / "node_modules"
            modules.mkdir()
            (modules / "dependency").write_bytes(b"frozen")
            grep = prepared / "native-grep-regression"
            grep.write_bytes(b"fake GNU libtest executable")
            grep.chmod(0o755)
            bun = prepared / "bun"
            bun.write_bytes(b"pinned bun")
            manifest = {"source": {"commit": COMMIT}, "build_inputs": {
                "host_tools": {"bun": {"sha256": receipt.digest(bun)}},
                "locks": {name: receipt.digest(source / name) for name in receipt.LOCKS}}}
            with patch.object(receipt, "elf", return_value={"interpreter": "ld-linux-x86-64.so.2"}), \
                    patch.object(runtime.qualify, "dependency_digest", wraps=runtime.qualify.dependency_digest) as digest:
                metadata = runtime.prepared_metadata(prepared, manifest, bun)
            digest.assert_called_once_with(source)
            self.assertEqual(set(metadata), {"schema", "source_commit", "bun_version", "locks", "dependency_tree_sha256", "native_grep_sha256"})
            self.assertEqual(metadata["dependency_tree_sha256"], runtime.qualify.dependency_digest(source))
            self.assertEqual(metadata["native_grep_sha256"], receipt.digest(grep))
            bun.write_bytes(b"different bun")
            with self.assertRaises(ValueError):
                runtime.prepared_metadata(prepared, manifest, bun)

    def test_dependency_copy_retains_workspace_layout_without_build_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "build"
            prepared = base / "pristine"
            for root in (source, prepared):
                (root / "packages/workspace").mkdir(parents=True)
                (root / "packages/workspace/source.ts").write_text("pristine")
            (source / "node_modules").mkdir()
            (source / "node_modules/workspace").symlink_to("../packages/workspace")
            (source / "packages/workspace/node_modules").mkdir()
            (source / "packages/workspace/node_modules/frozen").write_text("dependency")
            (source / "packages/workspace/source.ts").write_text("mutated by build")
            (source / "bazel-bin").symlink_to("/not-copied")
            runtime.copy_dependencies(source, prepared)
            self.assertEqual((prepared / "packages/workspace/source.ts").read_text(), "pristine")
            self.assertFalse((prepared / "bazel-bin").is_symlink())
            self.assertTrue((prepared / "node_modules/workspace").is_symlink())
            self.assertEqual(runtime.qualify.dependency_digest(source), runtime.qualify.dependency_digest(prepared))
            with self.assertRaises(ValueError):
                runtime.copy_dependencies(source, prepared)

    def test_absolute_dependency_link_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / "source/node_modules").mkdir(parents=True)
            (base / "prepared").mkdir()
            (base / "source/node_modules/unsafe").symlink_to("/outside")
            with self.assertRaises(ValueError):
                runtime.copy_dependencies(base / "source", base / "prepared")

    def test_native_recipe_and_no_run_workspace_are_explicit(self):
        script = Path(__file__).with_name("linux-amd64-build.sh").read_text()
        for value in ("//crates/pi-natives:pi_natives_test", "--lockfile_mode=error",
                      "--platforms=@zig_sdk//platform:linux_amd64",
                      "--extra_toolchains=@zig_sdk//toolchain:linux_amd64_gnu.2.27",
                      "--extra_execution_platforms=@bazel_tools//tools:host_platform,@zig_sdk//platform:linux_amd64",
                      "--@rules_rust//rust/settings:lto=thin",
                      "--@rules_rust//rust/settings:extra_rustc_flags=-Ccodegen-units=16,-Cstrip=symbols,-Ctarget-cpu=x86-64-v2",
                      'quiet bazel build "${native_args[@]}" "$native_target"',
                      'bazel cquery "${native_args[@]}" --output=files', 'cp -a /src /opt/omp-qualification/source'):
            self.assertIn(value, script)
        self.assertLess(script.index("cp -a /src"), script.index("quiet bun install"))
        self.assertLess(script.index("--inside-dependencies"), script.index("quiet bun scripts/bazel-natives.ts"))
        self.assertIn("bun scripts/bazel-natives.ts linux-x64-baseline", script)
        dockerfile = Path(__file__).with_name("linux-amd64.Dockerfile").read_text()
        workspace = dockerfile.split("FROM workspace AS build", 1)[0]
        self.assertFalse(any(line.startswith("RUN ") for line in workspace.splitlines()))
        self.assertIn("FROM scratch AS artifacts", dockerfile)
        self.assertIn("RUN /bin/bash /recipe/linux-amd64-build.sh build", dockerfile)

    def test_inside_preparation_runs_one_exact_unprivileged_native_test(self):
        def output(command, **kwargs):
            self.assertEqual(kwargs["env"]["PATH"], runtime.TOOL_PATH)
            self.assertIn("preexec_fn", kwargs)
            if command[0] == "timeout":
                return b"timeout (GNU coreutils) 9.7\n"
            if command[0] == "getconf":
                return b"glibc 2.41\n"
            if command[0] == "readelf":
                return b"GNU readelf (GNU Binutils) 2.44\n"
            if command[0] == "bun":
                return b"1.4.4\n"
            self.assertEqual(command[1:], [runtime.qualify.NATIVE_GREP_TEST, "--exact"])
            return b"running 1 test\ntest result: ok. 1 passed; 0 failed;\n"

        with tempfile.TemporaryDirectory() as temporary:
            prepared = Path(temporary)
            with patch.object(runtime, "PREPARED", prepared), patch.object(runtime.sys, "version_info", (3, 12)), \
                    patch.object(Path, "read_bytes", return_value=b"{}"), \
                    patch.object(runtime, "prepared_metadata", return_value={"schema": 1}), \
                    patch.object(subprocess, "check_output", side_effect=output) as command:
                runtime.inside_prepare()
            self.assertEqual(command.call_count, 5)
            self.assertEqual((prepared / "dependencies.json").read_bytes(), b'{"schema":1}\n')
            self.assertEqual((prepared / "dependencies.json").stat().st_mode & 0o777, 0o444)


if __name__ == "__main__":
    unittest.main()
