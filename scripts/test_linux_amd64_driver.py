#!/usr/bin/env python3
"""Offline tests for the Mac driver, scripts/ci001/build-linux-amd64-remote.

No host is contacted. `ssh` is a fake first on PATH that either records the call and fails, or runs the real door
entry locally exactly as sshd would (SSH_ORIGINAL_COMMAND), so the driver is exercised end to end against the door,
a fake Docker and fake recipe steps. Verification cases use real ed25519 signatures made with ssh-keygen.
"""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

import test_linux_amd64_door as door_tests

driver = door_tests.driver
ASSETS, EVIDENCE, TAG = door_tests.ASSETS, door_tests.EVIDENCE, door_tests.TAG
make_received, make_repository = door_tests.make_received, door_tests.make_repository
MANIFEST, MANIFEST_SHA = door_tests.MANIFEST, door_tests.MANIFEST_SHA

FAKE_SSH = r'''
import json, os, subprocess, sys

args = sys.argv[1:]
with open(os.environ["OMP_TEST_SSH_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
if os.environ.get("OMP_TEST_SSH_DOWN"):
    print("ssh: connect to host " + os.environ["OMP_TEST_ADDRESS"] + " port 22 using " + args[1] + ": Connection refused",
          file=sys.stderr)
    sys.exit(255)
environment = dict(os.environ, SSH_ORIGINAL_COMMAND=args[-1])
sys.exit(subprocess.run(["sh", os.environ["OMP_TEST_ENTRY"]], env=environment).returncode)
'''


def install_fake_ssh(directory):
    path = Path(directory) / "ssh"
    path.write_text("#!" + sys.executable + "\n" + FAKE_SSH)
    path.chmod(0o755)


def address(*parts):
    return ".".join(parts)


def reseal(directory):
    """Recompute the checksum list after a test rewrote a file, so only the intended defect remains."""
    (directory / ASSETS[2]).write_text("".join(
        f"{hashlib.sha256((directory / name).read_bytes()).hexdigest()}  {name}\n" for name in ASSETS[:2]))


class RedactorTests(unittest.TestCase):
    def test_key_paths_and_addresses_never_survive(self):
        key = "~/.ssh/omp-ci001-build"
        absolute = os.path.expanduser(key)
        redact = driver.Redactor({key, absolute})
        v4 = address("203", "0", "113", "9")
        v6 = "2001:" + "db8:0:0:0:0:0:17"
        short = "2001:" + "db8::17"
        for text in (f"Identity file {key} not accessible", f"ssh -i {absolute} host", f"connect to {v4} port 22",
                     f"connect to {v4}:22", f"via [{v6}] failed", f"via {short} failed", "from fe80::1 to ::1",
                     f"{absolute}:{v4}"):
            with self.subTest(text=text):
                shown = redact(text)
                for leaked in (key, absolute, v4, v6, short, "fe80::1", "::1"):
                    self.assertNotIn(leaked, shown)
        self.assertEqual(redact(f"x {absolute} y"), "x [redacted] y")
        self.assertEqual(redact(f"to {v4} now"), "to [address] now")

    def test_ordinary_progress_text_is_left_alone(self):
        redact = driver.Redactor({"~/.ssh/omp-ci001-build"})
        for text in ("Application check passed: omp 18.8.0, Bazel 9.2.0, Bun 1.4.2, 27 fork contracts.",
                     "started 2026-10-23T12:30:45Z", "run b20261023153012-3fa9c1d2", "sha256 " + "ab12" * 16,
                     "state: running (qualify)", "Phase: door unpack."):
            self.assertEqual(redact(text), text)

    def test_with_no_secrets_only_addresses_are_replaced(self):
        self.assertEqual(driver.Redactor(set())("a " + address("198", "51", "100", "7") + " b"), "a [address] b")


class VerifyTests(unittest.TestCase):
    app, recipe = "a" * 40, "b" * 40

    def received(self, tag="", **options):
        directory = Path(tempfile.mkdtemp(prefix="omp-verify-"))
        self.addCleanup(shutil.rmtree, directory, True)
        make_received(directory, self.app, self.recipe, tag, **options)
        return directory

    def refuses(self, directory, fragment, *, tag="", app=None, recipe=None, version="18.8.0", fork=MANIFEST_SHA):
        with self.assertRaises(driver.Failure) as raised:
            driver.verify(directory, app or self.app, recipe or self.recipe, tag, version, fork)
        self.assertEqual(raised.exception.code, 3)
        self.assertIn(fragment, str(raised.exception))

    def test_a_consistent_qualified_result_is_accepted(self):
        manifest = driver.verify(self.received(), self.app, self.recipe, "", "18.8.0", MANIFEST_SHA)
        self.assertEqual((manifest["schema"], manifest["version"]), (2, "18.8.0"))
        driver.verify(self.received(TAG), self.app, self.recipe, TAG, "18.8.0", MANIFEST_SHA)

    def test_a_returned_fork_manifest_hash_that_differs_from_what_was_sent_is_refused(self):
        sent = "5" * 64
        self.refuses(self.received(), "recorded fork manifest differs", fork=sent)  # the builder qualified another file
        for recorded in ("0" * 64, MANIFEST_SHA.upper(), MANIFEST_SHA[:12], "", None, 7, [MANIFEST_SHA]):
            with self.subTest(recorded=recorded):
                self.refuses(self.received(manifest_edit=lambda m, v=recorded: m["qualification"].update(fork_manifest_sha256=v)),
                             "recorded fork manifest differs")
        self.refuses(self.received(manifest_edit=lambda m: m["qualification"].pop("fork_manifest_sha256")),
                     "recorded fork manifest differs")

    def test_a_bad_checksum_is_refused(self):
        directory = self.received()
        with open(directory / ASSETS[0], "ab") as stream:
            stream.write(b"x")
        self.refuses(directory, "SHA256SUMS.txt does not match")
        edited = self.received()
        (edited / ASSETS[2]).write_text("0" * 64 + "  omp-linux-amd64\n")
        self.refuses(edited, "SHA256SUMS.txt does not match")
        manifest_edited = self.received()
        with open(manifest_edited / ASSETS[1], "ab") as stream:
            stream.write(b" ")
        self.refuses(manifest_edited, "SHA256SUMS.txt does not match")

    def test_a_manifest_that_lies_about_the_binary_is_refused(self):
        self.refuses(self.received(manifest_edit=lambda m: m["asset"].update(sha256="0" * 64)), "does not describe the binary")
        self.refuses(self.received(manifest_edit=lambda m: m["asset"].update(size=1)), "does not describe the binary")
        self.refuses(self.received(manifest_edit=lambda m: m["asset"].update(name="other")), "does not describe the binary")

    def test_every_check_must_have_passed(self):
        self.refuses(self.received(manifest_edit=lambda m: m["checks"].pop("native_grep")), "not all nine checks passed")
        self.refuses(self.received(manifest_edit=lambda m: m["checks"].update(cli="not_run")), "not all nine checks passed")
        self.refuses(self.received(manifest_edit=lambda m: m["checks"].update(cli="failed")), "not all nine checks passed")
        self.refuses(self.received(manifest_edit=lambda m: m["checks"].update(extra="passed")), "not all nine checks passed")
        self.refuses(self.received(manifest_edit=lambda m: m["qualification"]["checks"].update(elf="not_run")),
                     "qualification record is incomplete")
        self.refuses(self.received(manifest_edit=lambda m: m.update(qualification=None)), "qualification record is incomplete")
        self.refuses(self.received(manifest_edit=lambda m: m["qualification"].update(binary_sha256="0" * 64)),
                     "qualification record is incomplete")

    def test_the_binary_must_be_elf64_x86_64(self):
        for machine in (183, 3, 40):
            with self.subTest(machine=machine):
                self.refuses(self.received(machine=machine), "not an ELF64 x86-64 executable")
        directory = self.received()
        (directory / ASSETS[0]).write_bytes(b"#!/bin/sh\n" + b"\0" * 64)
        manifest = json.loads((directory / ASSETS[1]).read_text())
        manifest["asset"].update(size=74, sha256=hashlib.sha256((directory / ASSETS[0]).read_bytes()).hexdigest())
        manifest["qualification"]["binary_sha256"] = manifest["asset"]["sha256"]
        (directory / ASSETS[1]).write_bytes(door_tests.canonical(manifest))
        reseal(directory)
        self.refuses(directory, "not an ELF64 x86-64 executable")

    def test_the_commits_the_tag_and_the_version_must_match_what_was_asked(self):
        self.refuses(self.received(), "application commit differs", app="e" * 40)
        self.refuses(self.received(manifest_edit=lambda m: m["qualification"].update(source_commit="e" * 40)),
                     "application commit differs")
        self.refuses(self.received(), "omp version differs", version="18.9.0")
        self.refuses(self.received(version="18.9.0"), "omp version differs")
        self.refuses(self.received(), "source tag differs", tag=TAG)
        self.refuses(self.received(TAG), "source tag differs")
        self.refuses(self.received(TAG), "recipe identity differs", tag=TAG, recipe="c" * 40)
        self.refuses(self.received(manifest_edit=lambda m: m["source"].update(recipe_committed=True)), "recipe identity differs")
        self.refuses(self.received(manifest_edit=lambda m: m["source"].update(recipe_commit=self.recipe)), "recipe identity differs")

    def test_the_manifest_must_be_schema_two_for_linux_amd64_and_canonical(self):
        self.refuses(self.received(manifest_edit=lambda m: m.update(schema=1)), "not schema 2")
        self.refuses(self.received(manifest_edit=lambda m: m.update(schema=2.0)), "not schema 2")
        self.refuses(self.received(manifest_edit=lambda m: m.update(schema=True)), "not schema 2")
        self.refuses(self.received(manifest_edit=lambda m: m.update(target="linux-arm64")), "target is not linux-amd64")
        self.refuses(self.received(manifest_edit=lambda m: m.pop("asset")), "unreadable or inconsistent")
        directory = self.received()
        text = (directory / ASSETS[1]).read_text()
        for rewritten in (json.dumps(json.loads(text), indent=2) + "\n", text.replace('"schema":2', '"schema":2,"schema":2', 1)):
            (directory / ASSETS[1]).write_text(rewritten)
            reseal(directory)
            self.refuses(directory, "unreadable or inconsistent")

    def test_the_attestation_must_bind_this_manifest_and_verify(self):
        self.refuses(self.received(binding_edit=lambda b: b.replace(b"candidate", b"release")), "does not bind this manifest")
        self.refuses(self.received(binding_edit=lambda b: b + b" "), "does not bind this manifest")
        self.refuses(self.received(signer="other"), "signature does not verify")
        directory = self.received()
        (directory / "evidence" / EVIDENCE[1]).write_text("not a signature\n")
        self.refuses(directory, "signature does not verify")

    def test_missing_or_extra_or_irregular_files_are_refused(self):
        directory = self.received()
        (directory / "extra").write_text("x")
        self.refuses(directory, "unexpected files")
        for name in EVIDENCE:
            missing = self.received()
            (missing / "evidence" / name).unlink()
            self.refuses(missing, "unexpected files")
        for name in ASSETS:
            missing = self.received()
            (missing / name).unlink()
            self.refuses(missing, "unexpected files")
        linked = self.received()
        (linked / "evidence" / EVIDENCE[2]).unlink()
        (linked / "evidence" / EVIDENCE[2]).symlink_to(linked / ASSETS[2])
        self.refuses(linked, "unexpected files")
        extra = self.received()
        (extra / "evidence" / "extra").write_text("x")
        self.refuses(extra, "unexpected files")
        flat = self.received()
        shutil.rmtree(flat / "evidence")
        (flat / "evidence").write_text("not a folder")
        self.refuses(flat, "unexpected files")


class StubDoor:
    def __init__(self, data, status=0):
        self.data, self.status, self.commands = data, status, []

    def start(self, text, stdin=None):
        self.commands.append(text)
        return types.SimpleNamespace(stdout=io.BytesIO(self.data), wait=lambda: self.status)

    def finish(self, process):
        return process.wait()

    def abort(self, process):
        pass


def make_tar(members):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data, kind in members:
            info = tarfile.TarInfo(name)
            info.type = kind
            if kind == tarfile.SYMTYPE:
                info.linkname = "/etc/passwd"
            elif kind == tarfile.REGTYPE:
                info.size = len(data)
            archive.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
    return stream.getvalue()


GOOD = [(name, b"data of " + name.encode(), tarfile.REGTYPE) for name in (*ASSETS, *("evidence/" + n for n in EVIDENCE))]


class ReceiveTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="omp-receive-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.destination = self.root / "stage"
        self.destination.mkdir()

    def refuses(self, data, status=0):
        with self.assertRaises(driver.Failure) as raised:
            driver.receive(StubDoor(data, status), "b20261023153012-3fa9c1d2", self.destination)
        self.assertEqual(raised.exception.code, 3)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["stage"])  # nothing escaped the stage

    def test_exactly_the_six_expected_files_are_written(self):
        door = StubDoor(make_tar(GOOD))
        driver.receive(door, "b20261023153012-3fa9c1d2", self.destination)
        self.assertEqual(door.commands, ["fetch b20261023153012-3fa9c1d2"])
        self.assertEqual(sorted(path.name for path in self.destination.iterdir()), sorted([*ASSETS, "evidence"]))
        self.assertEqual(sorted(path.name for path in (self.destination / "evidence").iterdir()), sorted(EVIDENCE))
        self.assertEqual((self.destination / ASSETS[1]).read_bytes(), b"data of " + ASSETS[1].encode())

    def test_every_hostile_or_incomplete_archive_is_refused(self):
        regular = tarfile.REGTYPE
        cases = {
            "an extra member": GOOD + [("extra.txt", b"x", regular)],
            "a path escape": GOOD[:5] + [("../escape", b"x", regular)],
            "an absolute path": GOOD[:5] + [("/tmp/escape", b"x", regular)],
            "a nested escape": GOOD[:5] + [("evidence/../../escape", b"x", regular)],
            "a symlink": [(ASSETS[0], b"", tarfile.SYMTYPE)] + GOOD[1:],
            "a hard link": [(ASSETS[0], b"", tarfile.LNKTYPE)] + GOOD[1:],
            "a directory": [("evidence", b"", tarfile.DIRTYPE)] + GOOD,
            "a duplicate": GOOD + [GOOD[2]],
            "an oversized checksum list": GOOD[:2] + [(ASSETS[2], b"x" * 5000, regular)] + GOOD[3:],
            "a missing file": GOOD[:-1],
            "nothing": [],
        }
        for name, members in cases.items():
            with self.subTest(case=name):
                self.refuses(make_tar(members))
        for name, data in (("garbage", b"not a tar archive" * 100), ("empty output", b"")):
            with self.subTest(case=name):
                self.refuses(data)

    def test_a_door_that_reports_failure_is_refused_even_with_a_complete_archive(self):
        self.refuses(make_tar(GOOD), status=1)
        self.refuses(make_tar(GOOD), status=2)

    def test_a_truncated_archive_is_refused(self):
        data = make_tar(GOOD)
        self.refuses(data[:len(data) // 2])


class ArgumentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="omp-driver-"))
        cls.addClassCleanup(shutil.rmtree, cls.root, True)
        cls.repo, cls.app, cls.recipe = make_repository(cls.root)
        env = {**os.environ, **door_tests.GIT_ENVIRONMENT}

        def git(*args):
            return subprocess.run(["git", "-C", str(cls.repo), *args], check=True, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=env).stdout.decode().strip()

        git("tag", "stronk-omp-s1-2026.10.23.0002", cls.app)  # lightweight
        git("tag", "-a", "-m", "wrong commit", "stronk-omp-s1-2026.10.23.0003", cls.recipe)  # names the recipe
        empty = git("hash-object", "-t", "tree", "/dev/null")
        cls.versionless = git("commit-tree", empty, "-m", "no package.json")
        cls.bin = cls.root / "bin"
        cls.bin.mkdir()
        install_fake_ssh(cls.bin)
        cls.ssh_log = cls.root / "ssh.log"
        cls.manifest = cls.root / "fork_boundary.json"
        cls.manifest.write_bytes(MANIFEST)

    def setUp(self):
        self.results = Path(tempfile.mkdtemp(prefix="omp-results-"))
        self.addCleanup(shutil.rmtree, self.results, True)
        self.ssh_log.unlink(missing_ok=True)

    def drive(self, *arguments, app=None, recipe=None, output=None, manifest=None):
        argv = ["--app", app or self.app, "--recipe", recipe or self.recipe, "--output", str(output or self.results / "out"),
                "--repo", str(self.repo), "--key", str(self.root / "no-such-key"),
                *([] if manifest is False else ["--fork-manifest", str(manifest or self.manifest)]), *arguments]
        out, err = io.StringIO(), io.StringIO()
        environment = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "OMP_TEST_SSH_LOG": str(self.ssh_log),
                       "OMP_TEST_SSH_DOWN": "1", "OMP_TEST_ADDRESS": "unused"}
        with patch.dict(os.environ, environment), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = driver.main(argv)
        return code, out.getvalue(), err.getvalue()

    def assertRefusedBeforeContact(self, result, fragment):
        code, out, err = result
        self.assertEqual(code, 2, out + err)
        self.assertIn(fragment, err)
        self.assertFalse(self.ssh_log.exists(), "the driver contacted the door")
        self.assertFalse((self.results / "out").exists())

    def test_unresolvable_commits_are_refused_before_any_contact(self):
        self.assertRefusedBeforeContact(self.drive(app="0" * 40), "application commit must resolve")
        self.assertRefusedBeforeContact(self.drive(recipe="no-such-branch"), "recipe commit must resolve")
        with self.assertRaises(driver.Failure) as raised:  # a revision that looks like an option is never passed to git as one
            driver.resolve(self.repo, "--output=x", "application commit")
        self.assertEqual(raised.exception.code, 2)

    def test_a_tag_must_be_an_annotated_fleet_tag_naming_the_application_commit(self):
        self.assertRefusedBeforeContact(self.drive("--tag", "v1.0.0"), "fleet tag")
        self.assertRefusedBeforeContact(self.drive("--tag", "stronk-omp-s1-2026.10.23.0002"), "annotated tag naming exactly")
        self.assertRefusedBeforeContact(self.drive("--tag", "stronk-omp-s1-2026.10.23.0003"), "annotated tag naming exactly")
        self.assertRefusedBeforeContact(self.drive("--tag", "stronk-omp-s1-2026.10.23.0099"), "annotated tag naming exactly")

    def test_the_output_must_be_a_new_folder_in_an_existing_one(self):
        existing = self.results / "taken"
        existing.mkdir()
        self.assertRefusedBeforeContact(self.drive(output=existing), "--output must be a new folder")
        self.assertRefusedBeforeContact(self.drive(output=self.results / "missing" / "out"), "--output must be a new folder")
        (self.results / "link").symlink_to(existing)
        self.assertRefusedBeforeContact(self.drive(output=self.results / "link"), "--output must be a new folder")

    def test_an_application_without_a_readable_omp_version_is_refused(self):
        self.assertRefusedBeforeContact(self.drive(app=self.versionless), "no readable omp version")

    def test_a_folder_that_is_not_a_repository_is_refused(self):
        code, _, err = self.drive("--repo", str(self.results))
        self.assertEqual((code, self.ssh_log.exists()), (2, False))

    def test_a_resume_value_must_be_a_run_id(self):
        with self.assertRaises(SystemExit) as raised:
            self.drive("--resume", "../../etc")
        self.assertEqual(raised.exception.code, 2)
        self.assertFalse(self.ssh_log.exists())

    def test_a_bundle_over_the_door_cap_is_refused_locally(self):
        with patch.object(driver, "BUNDLE_CAP", 100):
            self.assertRefusedBeforeContact(self.drive(), "exceeds the door's size cap")

    def embedded(self, bundle):
        """What the door would find: the refs in the bundle header, the registry commit's file list and its bytes."""
        header = Path(bundle).read_bytes().split(b"\n\n", 1)[0].decode().split("\n")
        refs = dict(line.split(" ", 1)[::-1] for line in header[1:])
        scratch = Path(tempfile.mkdtemp(prefix="omp-embedded-"))
        self.addCleanup(shutil.rmtree, scratch, True)

        def git(*args):
            return subprocess.run(["git", "-C", str(scratch), *args], check=True, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env={**os.environ, **door_tests.GIT_ENVIRONMENT}).stdout

        git("init", "-q")
        git("fetch", "-q", str(bundle), "refs/omp/forkmanifest")
        return header, refs, git("ls-tree", "FETCH_HEAD").decode(), git("cat-file", "blob", "FETCH_HEAD:fork_boundary.json"), \
            git("rev-list", "--parents", "FETCH_HEAD").decode().split()

    def test_the_bundle_holds_exactly_the_two_commits_the_registry_commit_and_no_history(self):
        directory = self.results / "bundle"
        directory.mkdir()
        bundle = driver.make_bundle(self.repo, self.app, self.recipe, "", directory, MANIFEST)
        header, refs, tree, data, commits = self.embedded(bundle)
        self.assertEqual(header[0], "# v2 git bundle")
        self.assertEqual(sorted(refs), ["refs/omp/app", "refs/omp/forkmanifest", "refs/omp/recipe"])
        self.assertEqual((refs["refs/omp/app"], refs["refs/omp/recipe"]), (self.app, self.recipe))
        self.assertEqual(data, MANIFEST)  # the exact bytes, hence the exact hash
        self.assertEqual(len(tree.splitlines()), 1, tree)  # nothing but the one file
        self.assertTrue(tree.endswith("\tfork_boundary.json\n"), tree)
        self.assertEqual(commits, [refs["refs/omp/forkmanifest"]])  # parentless: no history rides along
        self.assertLess(bundle.stat().st_size, 30_000)  # the 300 kB blob of an earlier commit is not inside
        again = driver.make_bundle(self.repo, self.app, self.recipe, "", self.results / "bundle", MANIFEST)
        self.assertEqual(self.embedded(again)[1]["refs/omp/forkmanifest"], refs["refs/omp/forkmanifest"])  # a pure function of the bytes
        tagged = driver.make_bundle(self.repo, self.app, self.recipe, TAG, directory, MANIFEST)
        self.assertEqual(sorted(self.embedded(tagged)[1]),
                         ["refs/omp/app", "refs/omp/forkmanifest", "refs/omp/recipe", "refs/tags/" + TAG])

    def test_a_file_swapped_after_it_was_read_changes_neither_what_is_sent_nor_what_is_expected(self):
        original = driver.make_bundle
        sent = {}

        def swapping(repo, app, recipe, tag, directory, manifest):
            self.manifest.write_bytes(b'{"contracts": []}\n')  # the file on disk changes after it was hashed
            bundle = original(repo, app, recipe, tag, directory, manifest)
            sent["data"] = self.embedded(bundle)[3]
            return bundle

        self.addCleanup(self.manifest.write_bytes, MANIFEST)
        with patch.object(driver, "make_bundle", swapping):
            code, out, err = self.drive()
        self.assertEqual(code, 4, out + err)  # the fake ssh is down; the bundle was made and the build was attempted
        self.assertEqual(sent["data"], MANIFEST)
        self.assertIn("fork manifest " + MANIFEST_SHA[:12], out)
        self.assertEqual(json.loads(self.ssh_log.read_text().splitlines()[0])[-1].split(" ")[3], MANIFEST_SHA)

    def test_a_missing_or_unreadable_or_unsuitable_fork_manifest_is_refused_before_any_contact(self):
        with self.assertRaises(SystemExit) as raised:  # the input is required
            self.drive(manifest=False)
        self.assertEqual(raised.exception.code, 2)
        self.assertFalse(self.ssh_log.exists())
        readable = "--fork-manifest must be a readable regular file"
        self.assertRefusedBeforeContact(self.drive(manifest=self.results / "absent.json"), readable)
        self.assertRefusedBeforeContact(self.drive(manifest=self.results), readable)  # a folder
        (self.results / "link.json").symlink_to(self.manifest)
        self.assertRefusedBeforeContact(self.drive(manifest=self.results / "link.json"), readable)
        os.mkfifo(self.results / "pipe.json")  # opening it must neither block nor be accepted
        self.assertRefusedBeforeContact(self.drive(manifest=self.results / "pipe.json"), readable)
        cases = {
            "empty": (b"", "empty or larger"),
            "oversized": (MANIFEST + b" " * 1024, "empty or larger"),
            "not json": (b"contracts: []\n", "not valid JSON"),
            "invalid utf-8": (b'{"contracts": [], "x": "\xff"}', "not valid JSON"),
            "a repeated key": (b'{"contracts": [], "contracts": []}', "not valid JSON"),
            "not an object": (b"[]", "not a fork manifest"),
            "no contract list": (b'{"contracts": {}}', "not a fork manifest"),
        }
        for name, (data, fragment) in cases.items():
            with self.subTest(case=name):
                path = self.results / "case.json"
                path.write_bytes(data)
                with patch.object(driver, "MANIFEST_CAP", 1024):
                    self.assertRefusedBeforeContact(self.drive(manifest=path), fragment)

    def test_the_manifest_size_cap_is_the_one_the_door_enforces(self):
        found = re.search(r"(?m)^MANIFEST_CAP = ([0-9* ]+)$", door_tests.ENTRY.read_text())
        self.assertIsNotNone(found)
        self.assertEqual(driver.MANIFEST_CAP, eval(found[1], {"__builtins__": {}}))

    def test_ssh_is_called_with_exactly_the_agreed_options_and_nothing_else(self):
        door = driver.Door("cdm-ci-001-ompbuild", "/key/path", lambda text: text)
        self.assertEqual(door.command("status b20261023153012-3fa9c1d2"),
                         ["ssh", "-i", "/key/path", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ControlPath=none",
                          "cdm-ci-001-ompbuild", "status b20261023153012-3fa9c1d2"])
        self.assertEqual((driver.DEFAULT_ALIAS, driver.DEFAULT_KEY), ("cdm-ci-001-ompbuild", "~/.ssh/omp-ci001-build"))

    def test_the_default_key_is_never_printed_by_a_failure(self):
        code, out, err = self.drive("--key", "~/.ssh/omp-ci001-build")
        shown = out + err
        self.assertNotIn(os.path.expanduser("~/.ssh/omp-ci001-build"), shown)
        self.assertNotIn("~/.ssh/omp-ci001-build", shown)


class EndToEndTests(door_tests.DoorCase):
    """The driver talking to the real door entry through a fake ssh, fake Docker and fake recipe steps."""

    def setUp(self):
        super().setUp()
        install_fake_ssh(self.bin)
        self.ssh_log = self.temporary / "ssh.log"
        self.key = self.temporary / "keys" / "omp-ci001-build"
        self.results = self.temporary / "results"
        self.results.mkdir()
        self.address = address("198", "51", "100", "23")
        self.manifest = self.temporary / "fork_boundary.json"
        self.manifest.write_bytes(MANIFEST)

    def drive(self, *arguments, env=None, output=None, tag=None, manifest=None):
        environment = self.environment("", {"OMP_TEST_SSH_LOG": str(self.ssh_log), "OMP_TEST_ENTRY": str(door_tests.ENTRY),
                                            "OMP_TEST_ADDRESS": self.address, **(env or {})})
        del environment["SSH_ORIGINAL_COMMAND"]
        argv = [sys.executable, str(door_tests.DRIVER), "--app", self.app, "--recipe", self.recipe,
                "--fork-manifest", str(manifest or self.manifest),
                "--output", str(output or self.results / "out"), "--alias", "door-under-test", "--key", str(self.key),
                "--repo", str(self.repo), "--poll", "0.1", *(["--tag", tag] if tag else []), *arguments]
        result = subprocess.run(argv, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
        result.out, result.err = result.stdout.decode(), result.stderr.decode()
        return result

    def calls(self):
        return [json.loads(line) for line in self.ssh_log.read_text().splitlines()] if self.ssh_log.exists() else []

    def commands(self):
        return [call[-1].split(" ")[0] for call in self.calls()]

    def assertQuiet(self, result):
        shown = result.out + result.err
        for secret in (str(self.key), self.address, str(self.temporary)):
            self.assertNotIn(secret, shown)
        self.assertNotRegex(shown, r"\b\d{1,3}(?:\.\d{1,3}){3}\b")

    def test_a_candidate_build_is_driven_fetched_verified_and_cleaned_up(self):
        result = self.drive()
        self.assertEqual(result.returncode, 0, result.out + result.err)
        self.assertIn("verified: omp 18.8.0 linux-amd64,", result.out)
        self.assertIn("qualified: all nine checks passed on the builder; tag none (candidate, never publishable)", result.out)
        self.assertRegex(result.out, r"(?m)^run b[0-9]{14}-[0-9a-f]{8}$")
        self.assertQuiet(result)
        output = self.results / "out"
        self.assertEqual(sorted(path.name for path in output.iterdir()), ["assets", "evidence"])
        self.assertEqual(sorted(path.name for path in (output / "assets").iterdir()), sorted(ASSETS))
        self.assertEqual(sorted(path.name for path in (output / "evidence").iterdir()), sorted(EVIDENCE))
        self.assertEqual((output / "assets" / ASSETS[0]).read_bytes(), (self.fixture / "assets" / ASSETS[0]).read_bytes())
        self.assertEqual((output / "assets" / ASSETS[0]).stat().st_mode & 0o777, 0o755)
        self.assertEqual([path.name for path in self.results.iterdir()], ["out"])  # no staging folder left behind
        self.assertEqual(self.commands(), ["build", "fetch", "cleanup"])
        for call in self.calls():
            self.assertEqual(call[:9], ["-i", str(self.key), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
                                        "-o", "ControlPath=none", "door-under-test"])
        self.assertEqual(self.calls()[0][-1], f"build {self.app} {self.recipe} {MANIFEST_SHA}")
        self.assertIn(f"fork manifest: {MANIFEST_SHA} (the qualification names exactly the file that was sent)", result.out)
        self.assertEqual(self.runs(), [])  # the builder's run folder was removed

    def test_a_release_build_carries_the_tag_to_the_door_and_back(self):
        (self.etc / "source-allowed-signers").write_text("fixture ssh-ed25519 AAAA\n")
        (self.etc / "source-revoked-signers").write_text("")
        self.write_fixture(TAG)
        result = self.drive(tag=TAG)
        self.assertEqual(result.returncode, 0, result.out + result.err)
        self.assertIn(f"tag {TAG}", result.out)
        self.assertEqual(self.calls()[0][-1], f"build {self.app} {self.recipe} {MANIFEST_SHA} {TAG}")
        self.assertTrue((self.results / "out" / "assets" / ASSETS[0]).is_file())
        self.assertQuiet(result)

    def test_a_failed_remote_build_is_reported_with_its_fixed_reason_and_leaves_no_output(self):
        result = self.drive(env={"OMP_TEST_FAIL": "check"})
        self.assertEqual(result.returncode, 1, result.out + result.err)
        self.assertIn("the remote build did not succeed (failed): the application does not match this recipe", result.err)
        self.assertEqual(list(self.results.iterdir()), [])
        self.assertNotIn("raw diagnostic", result.out + result.err)
        self.assertEqual(self.commands(), ["build", "status"])
        self.assertQuiet(result)

    def test_a_door_refusal_is_reported_as_a_refusal(self):
        result = self.drive(env={"OMP_BUILD_MAX_BUNDLE_BYTES": "300"})
        self.assertEqual(result.returncode, 2, result.out + result.err)
        self.assertIn("refused: the bundle exceeds the size cap", result.out)
        self.assertIn("the door refused the build", result.err)
        self.assertEqual(list(self.results.iterdir()), [])

    def test_an_unreachable_door_is_a_transport_failure_and_the_key_and_address_are_redacted(self):
        result = self.drive(env={"OMP_TEST_SSH_DOWN": "1"})
        self.assertEqual(result.returncode, 4, result.out + result.err)
        self.assertIn("[redacted]", result.err)
        self.assertIn("[address]", result.err)
        self.assertQuiet(result)
        self.assertEqual(list(self.results.iterdir()), [])

    def test_the_driver_verifies_on_its_own_what_the_door_passed(self):
        self.write_fixture(version="18.9.0")  # the door does not know the version; the driver reads it from the commit
        result = self.drive()
        self.assertEqual(result.returncode, 3, result.out + result.err)
        self.assertIn("verification failed: the omp version differs from the application commit", result.err)
        self.assertEqual(list(self.results.iterdir()), [])
        self.assertNotIn("cleanup", self.commands())  # the run is kept on the builder for inspection
        self.assertEqual(len(self.runs()), 1)

    def assertDoorRefusedTheResult(self, outcome):
        self.assertEqual(outcome.returncode, 1, outcome.out + outcome.err)
        self.assertIn("the remote build did not succeed (failed): the door's own verification refused the result", outcome.err)
        self.assertEqual(list(self.results.iterdir()), [])
        self.assertNotIn("cleanup", self.commands())

    def test_a_file_that_differs_from_the_one_the_result_names_fails_at_the_door(self):
        other = self.temporary / "other.json"
        other.write_bytes(MANIFEST.replace(b"fixture-contract", b"another-contract"))
        self.assertDoorRefusedTheResult(self.drive(manifest=other))  # the fixture still reports the first file's hash

    def test_a_result_that_reports_another_fork_manifest_hash_fails_at_the_door(self):
        self.write_fixture(fork="0" * 64)
        self.assertDoorRefusedTheResult(self.drive())

    def test_the_driver_refuses_on_its_own_a_result_that_names_another_file_than_the_one_it_sent(self):
        first = self.drive("--keep-remote")
        self.assertEqual(first.returncode, 0, first.out + first.err)
        run = re.search(r"(?m)^run (b[0-9]{14}-[0-9a-f]{8})$", first.out)[1]
        other = self.temporary / "other.json"
        other.write_bytes(MANIFEST.replace(b"fixture-contract", b"another-contract"))
        second = self.drive("--resume", run, manifest=other, output=self.results / "again")  # the door has nothing to object to
        self.assertEqual(second.returncode, 3, second.out + second.err)
        self.assertIn("verification failed: the recorded fork manifest differs from the one that was sent", second.err)
        self.assertFalse((self.results / "again").exists())
        self.assertNotIn("cleanup", self.commands())

    def test_keep_remote_and_resume_fetch_again_without_uploading(self):
        first = self.drive("--keep-remote")
        self.assertEqual(first.returncode, 0, first.out + first.err)
        self.assertEqual(self.commands(), ["build", "fetch"])
        run = re.search(r"(?m)^run (b[0-9]{14}-[0-9a-f]{8})$", first.out)[1]
        second = self.drive("--resume", run, output=self.results / "again")
        self.assertEqual(second.returncode, 0, second.out + second.err)
        self.assertEqual(self.commands(), ["build", "fetch", "status", "fetch", "cleanup"])
        self.assertEqual((self.results / "again" / "assets" / ASSETS[0]).read_bytes(),
                         (self.results / "out" / "assets" / ASSETS[0]).read_bytes())
        self.assertEqual(self.runs(), [])

    def test_waiting_for_a_run_gives_up_at_the_deadline_and_says_how_to_resume(self):
        session = door_tests.Session(self, self.build_command(), self.bundles[""], {"OMP_TEST_BLOCK": "qualify"})
        self.addCleanup(door_tests.reap, session.process)
        run = session.line().split()[1]
        self.eventually(lambda: Path(str(self.gate) + ".ready").exists())
        result = self.drive("--resume", run, "--timeout", "1", "--poll", "0.2")
        self.assertEqual(result.returncode, 4, result.out + result.err)
        self.assertIn(f"resume it with --resume {run}", result.err)
        self.assertIn("state: running (qualify)", result.out)
        self.assertEqual(list(self.results.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
