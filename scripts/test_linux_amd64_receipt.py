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
    value = {"schema": 1, "binary_sha256": manifest["asset"]["sha256"],
             "source_commit": manifest["source"]["commit"], "recipe_commit": manifest["source"]["recipe_commit"],
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
                                 "host_tools": {name: {"version": "1.0.0", "sha256": "e" * 64} for name in receipt.TOOLS},
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
                                     "recipe_commit": manifest["source"]["recipe_commit"], "fork_manifest_sha256": FORK_SHA,
                                     "environment": {"execution": "native-amd64", "cpu": "x86-64-v2", "glibc": "2.41",
                                                     "loader": "ld-linux-x86-64.so.2", "runtime_image": "sha256:" + "c" * 64},
                                     "checks": dict(manifest["checks"])}
    receipt.save_manifest(directory, manifest)
    return manifest


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

    def test_the_qualification_names_the_registry_it_ran_and_a_caller_may_insist_on_it(self):
        self.assertEqual(self.verify()["qualification"]["fork_manifest_sha256"], FORK_SHA)
        self.assertEqual(receipt.verify(self.directory, COMMIT, TAG, True, RECIPE, Path("fixture-tree"),
                                        fork_manifest_sha256=FORK_SHA)["version"], "18.8.0")
        with self.assertRaisesRegex(ValueError, "Qualification fork manifest differs"):
            receipt.verify(self.directory, COMMIT, TAG, True, RECIPE, Path("fixture-tree"), fork_manifest_sha256="e" * 64)
        original = copy.deepcopy(self.manifest)
        for name, edit in {"absent": lambda value: value["qualification"].pop("fork_manifest_sha256"),
                           "empty": lambda value: value["qualification"].update(fork_manifest_sha256=""),
                           "short": lambda value: value["qualification"].update(fork_manifest_sha256=FORK_SHA[:-1]),
                           "upper case": lambda value: value["qualification"].update(fork_manifest_sha256=FORK_SHA.upper()),
                           "not text": lambda value: value["qualification"].update(fork_manifest_sha256=7)}.items():
            with self.subTest(defect=name):
                self.manifest = copy.deepcopy(original)
                edit(self.manifest)
                self.rewrite()
                with self.assertRaises(ValueError):
                    self.verify()
                with self.assertRaises(ValueError):
                    self.verify(release=False)

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
        self.assertEqual(self.check(manager="bun@1.4.2", engine="1.4.2"), "18.12.6")
        self.assertEqual(self.check(manager=None, engine=None), "18.12.6")

    def test_toolchain_mismatches_fail_closed_with_a_clear_reason(self):
        cases = (
            ({"bazel": "9.3.0\n"}, "Bazel 9.3.0 but this recipe pins Bazel 9.2.0"),
            ({"manager": "bun@>=1.5"}, "Bun >=1.5 but this recipe pins Bun 1.4.2"),
            ({"manager": "bun@1.4.3"}, "Bun 1.4.3 but this recipe pins Bun 1.4.2"),
            ({"engine": ">=2.0.0"}, "Bun >=2.0.0 but this recipe pins Bun 1.4.2"),
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
            self.assertEqual(passed.stdout.strip(), "Application check passed: omp 18.12.6, Bazel 9.2.0, Bun 1.4.2, 1 fork contracts, manifest "
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


if __name__ == "__main__":
    unittest.main()
