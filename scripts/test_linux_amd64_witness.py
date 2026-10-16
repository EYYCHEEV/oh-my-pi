"""Offline witness inventory/cleanup fixtures. Every subprocess boundary is fake."""
import copy
import importlib.util
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("witness", Path(__file__).with_name("linux-amd64-witness.py"))
witness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(witness)
ORIGINAL = "sha256:" + "a" * 64
BASE = "sha256:" + "b" * 64
WORKSPACE = "sha256:" + "c" * 64
RUNTIME = "sha256:" + "d" * 64
CONTAINER = "e" * 64
RUN = "fixture-run"
INFO = {"architecture": "x86_64", "os": "linux", "version": "29.8.1", "driver": "overlayfs",
        "root": "/data/docker", "cgroup": "2", "cpus": 24, "containers": 0, "images": 1, "proxy": False}
OS = {"ID": "ubuntu", "VERSION_ID": "26.04", "VERSION": "26.04.1 LTS"}
SOCKET = SimpleNamespace(st_mode=stat.S_IFSOCK | 0o660, st_uid=0, st_gid=42)
USAGE = [{"Type": "Build Cache", "TotalCount": "0", "Active": "0", "Size": "0B", "Reclaimable": "0B"}]


class InventoryTests(unittest.TestCase):
    def test_approved_inventory_and_fact_drift(self):
        with patch.object(witness.grp, "getgrgid", return_value=SimpleNamespace(gr_name="docker")):
            witness.validate_inventory(INFO, [ORIGINAL], "", witness.MIN_FREE, OS, SOCKET)
            for field, value in (("architecture", "arm64"), ("cpus", 16), ("images", 2), ("containers", 1),
                                 ("proxy", True), ("driver", "other"), ("version", "29.8.2"), ("root", "/other")):
                changed = dict(INFO, **{field: value})
                with self.subTest(field=field), self.assertRaises(ValueError):
                    witness.validate_inventory(changed, [ORIGINAL], "", witness.MIN_FREE, OS, SOCKET)
            with self.assertRaises(ValueError):
                witness.validate_inventory(INFO, [ORIGINAL], "", witness.MIN_FREE - 1, OS, SOCKET)
            with self.assertRaises(ValueError):
                witness.validate_inventory(INFO, [ORIGINAL], "unexpected", witness.MIN_FREE, OS, SOCKET)
            with self.assertRaises(ValueError):
                witness.validate_inventory(INFO, [ORIGINAL], "", witness.MIN_FREE, dict(OS, VERSION="26.04.2 LTS"), SOCKET)

    def test_scratch_requires_fixed_private_root_directory(self):
        with self.assertRaises(ValueError):
            witness.scratch_path(Path("/tmp/omp-witness-fixture-run"), RUN)
        with self.assertRaises(ValueError):
            witness.scratch_path(Path("/root/omp-witness-../other"), "../other")

    def test_new_evidence_is_private_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "evidence.json"
            witness.write_new(path, {"schema": 1})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.read_bytes(), b'{"schema":1}\n')
            with self.assertRaises(FileExistsError):
                witness.write_new(path, {"schema": 2})

    def test_memory_capacity_keeps_eight_gib_available_to_the_host(self):
        with patch.object(Path, "read_text", return_value="MemAvailable: 33554432 kB\n"):
            self.assertEqual(witness.available_memory(), 32 * 1024**3)
        for contents in ("MemAvailable: 33554431 kB\n", "MemTotal: 67108864 kB\n", "MemAvailable: invalid kB\n"):
            with self.subTest(contents=contents), patch.object(Path, "read_text", return_value=contents):
                with self.assertRaises(ValueError):
                    witness.available_memory()

    def test_preflight_records_safe_fields_and_never_mutates_docker(self):
        calls = []
        real_stat = Path.stat

        def safe_stat(path, *args, **kwargs):
            return SOCKET if str(path) == "/var/run/docker.sock" else real_stat(path, *args, **kwargs)

        def query(_docker, *args):
            calls.append(args)
            if args[0] == "info":
                return witness.receipt.canonical_json(INFO).decode()
            if args[:2] == ("image", "ls"):
                return "" if "--filter" in args else ORIGINAL
            if args[0] == "ps":
                return ""
            if args[0] == "buildx":
                return "github.com/docker/buildx v0.37.1 fixture"
            if args[0] == "git":
                return "git version 2.53.0"
            if args[:2] == ("system", "df"):
                return witness.receipt.canonical_json(USAGE[0]).decode()
            raise AssertionError(args)

        with tempfile.TemporaryDirectory() as temporary, patch.object(witness, "query", side_effect=query), \
             patch.object(witness, "os_release", return_value=OS), patch.object(witness, "validate_inventory"), \
             patch.object(witness, "available_memory", return_value=32 * 1024**3), \
             patch.object(witness.shutil, "disk_usage", return_value=SimpleNamespace(free=witness.MIN_FREE)), \
             patch.object(witness.shutil, "which", return_value=None), patch.object(witness.sys, "version_info", (3, 14)), \
             patch.object(Path, "stat", autospec=True, side_effect=safe_stat):
            scratch = Path(temporary)
            witness.preflight(["docker"], scratch, RUN)
            record = witness.receipt.strict_json((scratch / "preflight.json").read_bytes())
            self.assertEqual(record["images"], [ORIGINAL])
            self.assertTrue(record["cache_was_empty"])
            self.assertEqual(record["system_df"], USAGE)
        self.assertFalse(any(word in call for call in calls for word in ("prune", "rm", "run", "build", "pull")))


class CleanupTests(unittest.TestCase):
    def exercise(self, empty=True, image_label=RUN, inventory=None, acknowledged=True):
        calls = []
        remaining = [ORIGINAL, BASE] if inventory is None else inventory

        def query(_docker, *args):
            calls.append(args)
            if args[:2] == ("ps", "--all"):
                return CONTAINER if "--filter" in args else ""
            if args[:2] == ("container", "inspect"):
                return RUN
            if args[:2] == ("container", "rm"):
                return CONTAINER
            if args[:2] == ("image", "ls"):
                return "\n".join([WORKSPACE, RUNTIME] if "--filter" in args else remaining)
            if args[:2] == ("image", "inspect"):
                if args[3] == "{{.Created}}":
                    return "2026-10-16T00:00:02Z" if args[-1] == RUNTIME else "2026-10-16T00:00:01Z"
                if args[3] == "{{.Id}}":
                    if BASE not in remaining:
                        raise ValueError("Pinned base is absent from image inventory")
                    return BASE
                return image_label
            if args[:2] in (("image", "rm"), ("builder", "prune")):
                return ""
            if args[:2] == ("system", "df"):
                return witness.receipt.canonical_json(USAGE[0]).decode()
            raise AssertionError(args)

        with tempfile.TemporaryDirectory() as temporary, patch.object(witness, "query", side_effect=query):
            scratch = Path(temporary)
            witness.write_new(scratch / "preflight.json", {"schema": 1, "run_id": RUN, "images": [ORIGINAL],
                                                          "cache_was_empty": empty})
            if acknowledged:
                (scratch / "mac-verified").write_bytes(b"verified\n")
            try:
                witness.cleanup(["docker"], scratch, RUN)
            finally:
                self.calls = copy.deepcopy(calls)

    def test_only_labeled_children_before_parents_and_empty_cache_are_removed(self):
        self.exercise()
        removals = [call for call in self.calls if call[:2] == ("image", "rm")]
        self.assertEqual(removals, [("image", "rm", RUNTIME), ("image", "rm", WORKSPACE)])
        self.assertIn(("builder", "prune", "--all", "--force"), self.calls)
        self.assertNotIn(("image", "rm", ORIGINAL), self.calls)
        self.assertNotIn(("image", "rm", BASE), self.calls)
        self.assertTrue(all("--force" not in call for call in removals))

    def test_base_only_in_buildkit_cache_does_not_block_cleanup(self):
        self.exercise(inventory=[ORIGINAL])
        self.assertFalse(any(call[:2] == ("image", "inspect") and call[-1] == witness.receipt.BASE_IMAGE
                             for call in self.calls))
        self.assertIn(("builder", "prune", "--all", "--force"), self.calls)

    def test_existing_cache_is_preserved(self):
        self.exercise(empty=False)
        self.assertFalse(any(call[:2] == ("builder", "prune") for call in self.calls))

    def test_label_drift_and_new_unowned_state_stop_cleanup(self):
        with self.assertRaises(ValueError):
            self.exercise(image_label="different-run")
        self.assertFalse(any(call[:2] == ("image", "rm") for call in self.calls))
        with self.assertRaises(ValueError):
            self.exercise(inventory=[ORIGINAL, BASE, "sha256:" + "f" * 64])
        self.assertFalse(any(call[:2] == ("builder", "prune") for call in self.calls))

    def test_mac_verification_is_required_before_any_docker_operation(self):
        with self.assertRaises(FileNotFoundError):
            self.exercise(acknowledged=False)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
