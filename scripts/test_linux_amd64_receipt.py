"""Offline fixtures for the public receipt, immutable trees and trust boundaries."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("receipt", Path(__file__).with_name("linux-amd64-receipt.py"))
receipt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receipt)
COMMIT = receipt.APPLICATION_COMMIT
RECIPE = "a" * 40
TAG = "stronk-omp-s1-2026.10.16.0001"
TAG_OID = "b" * 40
EPOCH = 1792108800
TREE = {name: b"immutable-application-input\n" for name in receipt.LOCKS}
TREE["packages/coding-agent/package.json"] = b'{"version":"18.8.0"}'
RECIPE_TREE = {"scripts/" + name: ("reviewed-recipe:" + name).encode() for name in receipt.RECIPES}
REAL_RUN = subprocess.run


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
                                     "recipe_commit": manifest["source"]["recipe_commit"],
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


if __name__ == "__main__":
    unittest.main()
