"""Real local Git/SSH trust fixtures using only disposable repos, homes and keys."""
import argparse
import contextlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("release_runtime", Path(__file__).with_name("linux-amd64-runtime.py"))
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
receipt = runtime.receipt
TAG = "stronk-omp-s1-2026.10.16.0001"


class SignedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.scratch = Path(self.temporary.name)
        self.repo = self.scratch / "repo"
        self.repo.mkdir()
        home = self.scratch / "home"
        home.mkdir()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {
            "PATH": os.defpath, "HOME": str(home), "LANG": "C", "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0",
            "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@invalid",
            "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@invalid",
            "GIT_AUTHOR_DATE": "2026-10-16T00:00:00Z", "GIT_COMMITTER_DATE": "2026-10-16T00:00:00Z",
            "SSH_ASKPASS_REQUIRE": "never", "PYTHONDONTWRITEBYTECODE": "1",
        }, clear=True))
        self.key, self.other = self.scratch / "source-key", self.scratch / "other-key"
        for key in (self.key, self.other):
            self.execute(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", str(key)])
        self.allowed = self.scratch / "source-allowed-signers"
        self.revoked = self.scratch / "source-revoked-signers"
        self.allowed.write_text('fixture namespaces="git" ' + Path(str(self.key) + ".pub").read_text())
        self.revoked.write_bytes(b"")
        self.git("init", "--template=", "--initial-branch=release/s1-linux-amd64")
        (self.repo / "source").write_text("throwaway application\n")
        self.git("add", "source")
        self.git("commit", "-m", "Fixture application")
        self.source = self.git("rev-parse", "HEAD")
        self.stack.enter_context(patch.object(receipt, "APPLICATION_COMMIT", self.source))
        (self.repo / "scripts").mkdir()
        for name in receipt.RECIPES:
            (self.repo / "scripts" / name).write_bytes(Path(__file__).with_name(name).read_bytes())
        self.git("add", "scripts")
        self.git("commit", "-m", "Fixture recipe")
        self.recipe = self.git("rev-parse", "HEAD")
        self.args = argparse.Namespace(commit=self.source, recipe_commit=self.recipe, tag=TAG,
                                       allowed_signers=self.allowed, revoked_signers=self.revoked,
                                       docker_socket="unix:///fixture/docker.sock", witness_run_id="release-fixture",
                                       output="witness-release", image_id_file=self.scratch / "image-id")

    def execute(self, command):
        result = subprocess.run(command, cwd=self.repo, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                check=True, timeout=30)
        return result.stdout.decode().strip()

    def git(self, *args):
        return self.execute(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                             "-c", "tag.gpgsign=false", *args])

    def signed_tag(self, target=None, key=None):
        self.git("-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen",
                 "-c", "user.signingKey=" + str(key or self.key),
                 "tag", "--sign", "-m", "Throwaway source release", TAG, target or self.source)
        return self.git("rev-parse", "refs/tags/" + TAG)

    def rejected_before_docker(self):
        with patch.object(receipt, "validate_docker", side_effect=AssertionError("unexpected daemon boundary")) as docker, \
             patch.object(runtime, "Client", side_effect=AssertionError("unexpected client")) as client:
            with self.assertRaises((ValueError, OSError, subprocess.SubprocessError)):
                runtime.prepare(self.args, self.repo)
        docker.assert_not_called()
        client.assert_not_called()
        self.assertFalse((self.repo / "dist").exists())
        self.assertFalse(self.args.image_id_file.exists())

    def test_signed_annotated_tag_survives_exact_branch_and_tag_bundle(self):
        oid = self.signed_tag()
        bundle = self.scratch / "source.bundle"
        self.git("bundle", "create", str(bundle), "refs/heads/release/s1-linux-amd64", "refs/tags/" + TAG)
        refs = self.git("bundle", "list-heads", str(bundle))
        self.assertEqual({line.split()[1] for line in refs.splitlines()},
                         {"refs/heads/release/s1-linux-amd64", "refs/tags/" + TAG})
        clone = self.scratch / "clone"
        self.git("clone", "--no-checkout", "--template=", str(bundle), str(clone))
        self.assertEqual(receipt.validate_tag(clone, self.source, TAG, self.allowed, self.revoked), oid)
        # Reach the daemon boundary only after real signature and immutable recipe checks.
        with patch.object(receipt, "validate_docker", side_effect=ValueError("fixture boundary reached")) as docker:
            with self.assertRaisesRegex(ValueError, "fixture boundary reached"):
                runtime.prepare(self.args, self.repo)
        docker.assert_called_once_with("unix:///fixture/docker.sock")

    def test_missing_tag_is_rejected_before_build(self):
        self.rejected_before_docker()

    def test_lightweight_tag_is_rejected_before_build(self):
        self.git("tag", TAG, self.source)
        self.rejected_before_docker()

    def test_wrong_direct_target_is_rejected_before_build(self):
        self.signed_tag(target=self.recipe)
        self.rejected_before_docker()

    def test_wrong_signer_is_rejected_before_build(self):
        self.signed_tag(key=self.other)
        self.rejected_before_docker()

    def test_revoked_signer_is_rejected_before_build(self):
        self.signed_tag()
        self.revoked.write_bytes(Path(str(self.key) + ".pub").read_bytes())
        self.rejected_before_docker()

    def test_missing_allowed_signers_is_rejected_before_build(self):
        self.signed_tag()
        self.allowed.unlink()
        self.rejected_before_docker()

    def test_missing_revocations_is_rejected_before_build(self):
        self.signed_tag()
        self.revoked.unlink()
        self.rejected_before_docker()
        self.args.revoked_signers = None
        self.rejected_before_docker()


if __name__ == "__main__":
    unittest.main()
