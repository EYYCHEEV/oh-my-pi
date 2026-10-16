"""Offline publisher boundary tests. No subprocess, network, or trust store is used."""
import argparse
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("linux_amd64_publish", Path(__file__).with_name("linux-amd64-publish.py"))
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)
FIXTURE_SPEC = importlib.util.spec_from_file_location("publish_receipt_fixture", Path(__file__).with_name("test_linux_amd64_receipt.py"))
fixture = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(fixture)
VERIFY_RECEIPT = publisher.receipt.verify
COMMIT = "dd8d9785aa36b5b072817a089177030b1b3519df"
RECIPE = "a" * 40
TAG_OBJECT = "b" * 40
TAG = "stronk-omp-s1-2026.10.16.0001"


class FakeGH:
    """Subprocess-shaped state machine, including HTTP errors and binary reads."""
    def __init__(self, fixture, failure=None):
        self.fixture = fixture
        self.failure = failure
        self.events = fixture.events
        self.published = False
        self.created = False
        self.uploaded = False
        self.tag_reads = 0
        self.downloads = 0
        self.list_pages = []
        self.calls = []

    def response(self, arguments, value, status=200):
        raw = f"HTTP/2.0 {status} Status\r\nContent-Type: application/json\r\n\r\n".encode() + json.dumps(value).encode()
        return subprocess.CompletedProcess(arguments, 0 if status < 400 else 1, raw, b"private error text is never forwarded")

    def release(self):
        assets = []
        if self.uploaded:
            for index, name in enumerate(publisher.receipt.ASSETS, 1):
                assets.append({"id": index, "name": name, "size": len(self.fixture.contents[name]), "state": "uploaded"})
        value = {"id": 41, "tag_name": TAG, "target_commitish": COMMIT, "name": TAG,
                 "draft": not self.published, "prerelease": False, "immutable": self.published,
                 "assets": assets}
        if self.failure == "draft_identity" and self.uploaded and not self.published:
            value["target_commitish"] = "c" * 40
        if self.failure == "draft_asset_id" and self.uploaded and not self.published:
            value["assets"][1]["id"] = value["assets"][0]["id"]
        if self.published:
            if self.failure == "immutable":
                value["immutable"] = False
            if self.failure == "published_identity":
                value["id"] = 42
            if self.failure == "published_asset_id":
                value["assets"][0]["id"] = 99
            if self.failure == "published_size":
                value["assets"][0]["size"] += 1
        return value

    def __call__(self, arguments, **kwargs):
        self.calls.append(list(arguments))
        assert arguments[0] == "gh"
        assert kwargs["stderr"] == subprocess.PIPE
        assert kwargs["env"]["GH_HOST"] == "github.com"
        assert self.fixture.args.pins.exists(), "Pin destination must be reserved before remote access"
        assert self.events[:3] == ["recipes", "signature", "receipt"], "Local trust and qualification must precede remote access"
        if arguments[1:3] == ["release", "upload"]:
            self.events.append("upload")
            assert self.created and not self.uploaded and not self.published
            assert "--clobber" not in arguments
            assert arguments[-2:] == ["--repo", f"github.com/{publisher.REPOSITORY}"]
            paths = arguments[4:-2]
            assert len(paths) == 3
            assert [Path(path).name for path in paths] == list(publisher.receipt.ASSETS)
            for path in paths:
                assert Path(path).read_bytes() == self.fixture.contents[Path(path).name]
            self.uploaded = True
            return subprocess.CompletedProcess(arguments, 0, b"", b"")
        assert arguments[1:4] == ["api", "--hostname", "github.com"]
        method = arguments[arguments.index("--method") + 1]
        endpoint = arguments[arguments.index("--header") + 2]
        assert endpoint.startswith(publisher.PREFIX + "/")
        route = endpoint.removeprefix(publisher.PREFIX)
        body = json.loads(kwargs["input"]) if kwargs["input"] else None
        if route.startswith("/git/ref/tags/"):
            self.tag_reads += 1
            self.events.append("remote_tag")
            different = self.failure == "remote_tag" or (self.failure == "changed_tag" and self.tag_reads >= 2)
            # Also alter originals after approval: only private snapshot bytes may upload.
            if self.failure == "changed_originals":
                for name in publisher.receipt.ASSETS:
                    (self.fixture.args.assets / name).write_bytes(b"changed after qualification")
            return self.response(arguments, {"ref": f"refs/tags/{TAG}", "object": {"type": "tag", "sha": "c" * 40 if different else TAG_OBJECT}})
        if route == f"/git/tags/{TAG_OBJECT}":
            return self.response(arguments, {"sha": TAG_OBJECT, "tag": TAG, "object": {"type": "tag" if self.failure == "nested_remote" else "commit", "sha": "c" * 40 if self.failure == "remote_commit" else COMMIT}})
        if route.startswith("/releases?per_page=100&page="):
            page = int(route.rsplit("=", 1)[1])
            self.list_pages.append(page)
            self.events.append("list")
            if self.failure in ("existing_draft", "existing_release"):
                return self.response(arguments, [{"tag_name": TAG, "draft": self.failure == "existing_draft"}])
            if self.failure == "paginated_draft":
                if page == 1:
                    return self.response(arguments, [{"tag_name": f"unrelated-{index}"} for index in range(100)])
                return self.response(arguments, [{"tag_name": TAG, "draft": True}])
            return self.response(arguments, [])
        if route == f"/releases/tags/{TAG}":
            self.events.append("by_tag")
            if not self.created:
                if self.failure == "lookup_network":
                    return self.response(arguments, {"message": "Unavailable"}, 503)
                if self.failure == "lookup_auth":
                    return self.response(arguments, {"message": "Unauthorized"}, 401)
                if self.failure == "lookup_existing":
                    return self.response(arguments, self.release())
                return self.response(arguments, {"message": "Not Found"}, 404)
            value = self.release()
            if self.failure == "tag_release_identity":
                value["id"] = 43
            return self.response(arguments, value)
        if route == "/releases" and method == "POST":
            self.events.append("create")
            assert body == {"tag_name": TAG, "target_commitish": COMMIT, "name": TAG,
                            "draft": True, "prerelease": False, "generate_release_notes": False, "make_latest": "false"}
            assert not self.created
            self.created = True
            return self.response(arguments, self.release(), 201)
        if route == "/releases/41" and method == "PATCH":
            self.events.append("publish")
            assert body == {"draft": False, "make_latest": "false"}
            assert self.uploaded and self.downloads == 3 and self.tag_reads == 2
            assert not self.published
            self.published = True
            return self.response(arguments, self.release())
        if route == "/releases/41" and method == "GET":
            self.events.append("release_readback")
            return self.response(arguments, self.release())
        if route.startswith("/releases/assets/"):
            self.events.append("download")
            assert "Accept: application/octet-stream" in arguments
            asset_id = int(route.rsplit("/", 1)[1])
            assert 1 <= asset_id <= 3
            name = publisher.receipt.ASSETS[asset_id - 1]
            content = self.fixture.contents[name]
            if self.failure == "draft_hash" or (self.failure == "published_hash" and self.published):
                content = b"corrupt downloaded bytes"
            kwargs["stdout"].write(content)
            self.downloads += 1
            return subprocess.CompletedProcess(arguments, 0, None, b"")
        raise AssertionError("Unexpected fake API operation")


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="publisher-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        assets = self.directory / "assets"
        assets.mkdir()
        self.events = []
        fixture.make_assets(assets)
        self.contents = {name: (assets / name).read_bytes() for name in publisher.receipt.ASSETS}
        witness = self.directory / "witness.json"
        witness.write_text(json.dumps({"repository": publisher.REPOSITORY, "enabled": True,
                                       "observed_at": datetime.now(timezone.utc).isoformat()}))
        self.args = argparse.Namespace(commit=COMMIT, recipe_commit=RECIPE, tag=TAG,
                                       assets=assets, allowed_signers=self.directory / "public-signers",
                                       revoked_signers=None, immutability_witness=witness,
                                       pins=self.directory / "pins.json", publish=True)

    def write_assets(self):
        for name, data in self.contents.items():
            (self.directory / "assets" / name).write_bytes(data)

    def local_recipes(self, root, recipe_commit):
        self.assertEqual(recipe_commit, RECIPE)
        self.events.append("recipes")

    def local_signature(self, root, commit, tag, allowed, revoked):
        self.assertEqual((commit, tag, allowed, revoked), (COMMIT, TAG, self.args.allowed_signers, None))
        self.events.append("signature")
        return TAG_OBJECT

    def local_receipt(self, directory, commit, tag, release, recipe_commit, root):
        self.events.append("receipt")
        self.assertEqual((commit, tag, release, recipe_commit), (COMMIT, TAG, True, RECIPE))
        self.assertNotEqual(directory, self.args.assets)
        # Exercise the real release receipt gate with only immutable Git reads faked.
        return VERIFY_RECEIPT(directory, commit, tag, release, recipe_commit=recipe_commit, root=root)

    def invoke(self, failure=None):
        fake = FakeGH(self, failure)
        self.fake = fake
        with patch.object(publisher.receipt, "assert_recipes", self.local_recipes), \
             patch.object(publisher.receipt, "validate_tag", self.local_signature), \
             patch.object(publisher.receipt, "verify", self.local_receipt), \
             patch.object(publisher.receipt, "git_bytes", side_effect=fixture.tree_bytes), \
             patch.object(publisher.receipt, "commit_exists"), \
             patch.object(publisher.receipt, "capture", return_value=str(fixture.EPOCH)), \
             patch.object(publisher.subprocess, "run", fake):
            return publisher.publish(self.args)

    def rejected(self, failure=None):
        with self.assertRaises(ValueError):
            self.invoke(failure)
        self.assertNotIn("publish", self.events)
        if self.args.pins.exists():
            self.assertEqual(self.args.pins.read_bytes(), b"")

    def test_success_order_and_allowlisted_pins(self):
        result = self.invoke()
        self.assertEqual(set(result), {"schema", "repository", "tag", "tag_object", "commit", "recipe_commit", "target", "release_id", "assets"})
        self.assertEqual(json.loads(self.args.pins.read_text()), result)
        self.assertEqual(result["release_id"], 41)
        self.assertEqual(self.fake.downloads, 6)
        self.assertEqual(self.fake.tag_reads, 3)
        self.assertEqual(self.events.count("create"), 1)
        self.assertEqual(self.events.count("upload"), 1)
        self.assertEqual(self.events.count("publish"), 1)
        self.assertLess(self.events.index("receipt"), self.events.index("create"))
        self.assertLess(self.events.index("upload"), self.events.index("download"))
        self.assertLess(self.events.index("download"), self.events.index("publish"))
        for item in result["assets"]:
            self.assertEqual(set(item), {"id", "name", "size", "sha256"})
            self.assertEqual(item["size"], len(self.contents[item["name"]]))
        self.assertEqual(self.args.pins.stat().st_mode & 0o777, 0o600)

    def test_explicit_publish_required_before_any_work(self):
        self.args.publish = False
        self.rejected()
        self.assertEqual(self.events, [])
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(self.args.pins.exists())

    def test_missing_qualification_before_gh(self):
        manifest = json.loads(self.contents[publisher.receipt.ASSETS[1]])
        manifest["qualification"] = None
        self.contents[publisher.receipt.ASSETS[1]] = json.dumps(manifest).encode()
        self.write_assets()
        self.rejected()
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(self.args.pins.exists())

    def test_incomplete_checks_before_gh(self):
        manifest = json.loads(self.contents[publisher.receipt.ASSETS[1]])
        manifest["checks"]["cli"] = "not_run"
        self.contents[publisher.receipt.ASSETS[1]] = json.dumps(manifest).encode()
        self.write_assets()
        self.rejected()
        self.assertEqual(self.fake.calls, [])

    def test_local_signed_tag_oid_must_match_receipt(self):
        manifest = json.loads(self.contents[publisher.receipt.ASSETS[1]])
        manifest["source"]["tag_object"] = "c" * 40
        publisher.receipt.save_manifest(self.args.assets, manifest)
        self.rejected()
        self.assertEqual(self.fake.calls, [])

    def test_private_manifest_field_is_rejected_before_gh(self):
        manifest = json.loads(self.contents[publisher.receipt.ASSETS[1]])
        manifest["private_detail"] = "not-a-public-release-field"
        publisher.receipt.save_manifest(self.args.assets, manifest)
        self.rejected()
        self.assertEqual(self.fake.calls, [])

    def test_false_immutability_witness_before_gh(self):
        value = json.loads(self.args.immutability_witness.read_text())
        value["enabled"] = False
        self.args.immutability_witness.write_text(json.dumps(value))
        self.rejected()
        self.assertEqual(self.fake.calls, [])

    def test_stale_or_future_witness_before_gh(self):
        now = datetime(2026, 10, 16, tzinfo=timezone.utc)
        for observed in (now - timedelta(hours=25), now + timedelta(seconds=1)):
            with self.subTest(observed=observed):
                self.args.immutability_witness.write_text(json.dumps({"repository": publisher.REPOSITORY, "enabled": True, "observed_at": observed.isoformat()}))
                with self.assertRaises(ValueError):
                    publisher.witness(self.args.immutability_witness, now=now)

    def test_existing_draft_or_release_is_never_reused(self):
        for failure in ("existing_draft", "existing_release", "paginated_draft", "lookup_existing"):
            with self.subTest(failure=failure):
                self.events.clear()
                if self.args.pins.exists():
                    self.args.pins.unlink()  # Test-owned empty reservation only.
                self.rejected(failure)
                self.assertNotIn("create", self.events)
                if failure == "paginated_draft":
                    self.assertEqual(self.fake.list_pages, [1, 2])

    def test_lookup_errors_are_not_absence(self):
        for failure in ("lookup_network", "lookup_auth"):
            with self.subTest(failure=failure):
                self.events.clear()
                if self.args.pins.exists():
                    self.args.pins.unlink()
                self.rejected(failure)
                self.assertNotIn("create", self.events)

    def test_remote_tag_and_direct_commit_must_match(self):
        for failure in ("remote_tag", "nested_remote", "remote_commit", "changed_tag"):
            with self.subTest(failure=failure):
                self.events.clear()
                if self.args.pins.exists():
                    self.args.pins.unlink()
                self.rejected(failure)

    def test_draft_identity_or_hash_mismatch_blocks_publication(self):
        for failure in ("draft_identity", "draft_asset_id", "draft_hash"):
            with self.subTest(failure=failure):
                self.events.clear()
                if self.args.pins.exists():
                    self.args.pins.unlink()
                self.rejected(failure)

    def test_postpublication_failure_never_emits_pins_or_repairs_release(self):
        for failure in ("immutable", "published_identity", "published_asset_id", "published_size", "published_hash", "tag_release_identity"):
            with self.subTest(failure=failure):
                self.events.clear()
                if self.args.pins.exists():
                    self.args.pins.unlink()
                with self.assertRaises(ValueError):
                    self.invoke(failure)
                self.assertEqual(self.args.pins.read_bytes(), b"")
                self.assertEqual(self.events.count("create"), 1)
                self.assertEqual(self.events.count("publish"), 1)
                self.assertTrue(all("DELETE" not in call for call in self.fake.calls))

    def test_original_assets_cannot_change_upload_after_approval(self):
        self.invoke("changed_originals")
        self.assertEqual(self.fake.downloads, 6)
        self.assertTrue(self.fake.published)

    def test_existing_pin_file_never_overwritten(self):
        self.args.pins.write_bytes(b"retained existing pins")
        with self.assertRaises(FileExistsError):
            self.invoke()
        self.assertEqual(self.args.pins.read_bytes(), b"retained existing pins")
        self.assertEqual(self.fake.calls, [])

    def test_symlink_asset_refused_before_gh(self):
        path = self.args.assets / publisher.receipt.ASSETS[0]
        path.unlink()
        path.symlink_to("unavailable-fixture")
        with self.assertRaises(OSError):
            self.invoke()
        self.assertEqual(self.fake.calls, [])

    def test_output_is_sanitized_on_failure(self):
        with patch.object(publisher, "publish", side_effect=ValueError("private failure details")), \
             patch("sys.argv", ["publisher", "--commit", COMMIT, "--recipe-commit", RECIPE, "--tag", TAG,
                                "--assets", "fixture-assets", "--allowed-signers", "fixture-signers",
                                "--immutability-witness", "fixture-witness", "--pins", "fixture-pins", "--publish"]):
            with self.assertRaises(SystemExit) as caught:
                publisher.main()
        self.assertNotIn("private failure details", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
