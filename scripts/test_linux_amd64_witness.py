"""Offline witness inventory/cleanup fixtures. Every subprocess boundary is fake."""
import copy
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import signal
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

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

    def test_record_is_complete_private_and_synced_before_atomic_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "record.json"
            link = os.link
            with patch.object(os, "fsync", wraps=os.fsync) as fsync:
                def publish(source, destination, **kwargs):
                    self.assertFalse(path.exists())
                    self.assertEqual(Path(source).read_bytes(), b'{"schema":1}\n')
                    self.assertEqual(stat.S_IMODE(Path(source).stat().st_mode), 0o600)
                    self.assertEqual(fsync.call_count, 1)
                    link(source, destination, **kwargs)
                with patch.object(os, "link", side_effect=publish):
                    witness.write_new(path, {"schema": 1})
                self.assertEqual(fsync.call_count, 2)
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_interrupted_write_never_exposes_incomplete_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "record.json"
            with patch.object(os, "fsync", side_effect=OSError("fixture write failure")):
                with self.assertRaises(OSError):
                    witness.write_new(path, {"schema": 1})
            self.assertFalse(path.exists())
            self.assertEqual(list(path.parent.iterdir()), [])

    def test_atomic_publish_never_replaces_a_concurrent_winner(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "record.json"
            link = os.link
            def publish(source, destination, **kwargs):
                path.write_bytes(b'{"schema":2}\n')
                link(source, destination, **kwargs)
            with patch.object(os, "link", side_effect=publish), self.assertRaises(FileExistsError):
                witness.write_new(path, {"schema": 1})
            self.assertEqual(path.read_bytes(), b'{"schema":2}\n')
            self.assertEqual(list(path.parent.iterdir()), [path])

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
             patch.object(witness.shutil, "disk_usage", side_effect=lambda path: SimpleNamespace(
                 free=witness.MIN_FREE if path == "/" else 200 * 1024**3)), \
             patch.object(witness.shutil, "which", return_value=None), patch.object(witness.sys, "version_info", (3, 14)), \
             patch.object(Path, "stat", autospec=True, side_effect=safe_stat):
            scratch = Path(temporary)
            witness.preflight(["docker"], scratch, RUN)
            record = witness.receipt.strict_json((scratch / "preflight.json").read_bytes())
            self.assertEqual(record["images"], [ORIGINAL])
            self.assertTrue(record["cache_was_empty"])
            self.assertEqual(record["system_df"], USAGE)
            self.assertEqual(record["docker_free_bytes"], 200 * 1024**3)
        self.assertFalse(any(word in call for call in calls for word in ("prune", "rm", "run", "build", "pull")))

    def test_docker_storage_requires_two_hundred_gib_without_mutation(self):
        real_stat = Path.stat

        def safe_stat(path, *args, **kwargs):
            return SOCKET if str(path) == "/var/run/docker.sock" else real_stat(path, *args, **kwargs)

        with tempfile.TemporaryDirectory() as temporary, \
             patch.object(witness, "query", side_effect=[
                 witness.receipt.canonical_json(INFO).decode(), ORIGINAL, "", "fixture v0.37.1",
                 "git version 2.53.0", witness.receipt.canonical_json(USAGE[0]).decode()]) as query, \
             patch.object(witness, "os_release", return_value=OS), patch.object(witness, "validate_inventory"), \
             patch.object(witness.shutil, "disk_usage",
                          side_effect=[SimpleNamespace(free=witness.MIN_FREE),
                                       SimpleNamespace(free=200 * 1024**3 - 1)]), \
             patch.object(witness.shutil, "which", return_value=None), \
             patch.object(witness.sys, "version_info", (3, 14)), \
             patch.object(Path, "stat", autospec=True, side_effect=safe_stat):
            scratch = Path(temporary)
            with self.assertRaises(ValueError):
                witness.preflight(["docker"], scratch, RUN)
            self.assertFalse((scratch / "preflight.json").exists())
            self.assertFalse(any(word in call.args for call in query.call_args_list
                                 for word in ("prune", "rm", "run", "build", "pull")))
            self.assertEqual(query.call_count, 6)



class CleanupTests(unittest.TestCase):
    def exercise(self, empty=True, image_label=RUN, inventory=None, acknowledged=True, *,
                 abort=False, terminal_status="success", active=False, container_label=RUN):
        calls = []
        remaining = [ORIGINAL, BASE] if inventory is None else inventory

        def query(_docker, *args):
            calls.append(args)
            if args[:2] == ("ps", "--all"):
                return CONTAINER if "--filter" in args else ""
            if args[:2] == ("container", "inspect"):
                return container_label
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
            if terminal_status is not None:
                witness.write_new(scratch / "job-terminal.json",
                                  {"schema": 1, "run_id": RUN, "status": terminal_status,
                                   "exit_code": 0 if terminal_status == "success" else 143})
            if acknowledged:
                (scratch / "mac-verified").write_bytes(b"verified\n")
            try:
                state = {"ActiveState": "active"} if active else None
                with patch.object(witness, "unit_state", return_value=state):
                    witness.cleanup(["docker"], scratch, RUN, abort=abort)
                record = witness.receipt.strict_json((scratch / ("abort.json" if abort else "cleanup.json")).read_bytes())
                self.assertEqual(record["cache_pruned"], empty and not abort)
                self.assertEqual((scratch / "mac-verified").exists(), acknowledged)
                self.assertTrue(scratch.is_dir())
            finally:
                self.calls = copy.deepcopy(calls)

    def test_only_labeled_children_before_parents_and_empty_cache_are_removed(self):
        self.exercise()
        removals = [call for call in self.calls if call[:2] == ("image", "rm")]
        self.assertEqual(removals, [("image", "rm", "--no-prune", RUNTIME),
                                    ("image", "rm", "--no-prune", WORKSPACE)])
        self.assertIn(("builder", "prune", "--all", "--force"), self.calls)
        self.assertFalse(any(call[:2] == ("image", "rm") and call[-1] in (ORIGINAL, BASE) for call in self.calls))
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

    def test_successful_handoff_requires_terminal_success_even_with_ack(self):
        for terminal_status in (None, "failed:prepare"):
            with self.subTest(status=terminal_status), self.assertRaises(ValueError):
                self.exercise(terminal_status=terminal_status)
            self.assertEqual(self.calls, [])

    def test_abort_never_needs_or_creates_ack_or_prunes_cache(self):
        self.exercise(abort=True, acknowledged=False, terminal_status="failed:prepare")
        self.assertFalse(any(call[:2] == ("builder", "prune") for call in self.calls))
        self.assertEqual([call[-1] for call in self.calls if call[:2] == ("image", "rm")], [RUNTIME, WORKSPACE])

    def test_abort_can_recover_partial_checkout_before_job_start(self):
        self.exercise(abort=True, acknowledged=False, terminal_status=None)
        self.assertFalse(any(call[:2] == ("builder", "prune") for call in self.calls))

    def test_abort_rejects_active_job_and_container_label_drift(self):
        with self.assertRaises(ValueError):
            self.exercise(abort=True, acknowledged=False, terminal_status=None, active=True)
        self.assertEqual(self.calls, [])
        with self.assertRaises(ValueError):
            self.exercise(abort=True, acknowledged=False, terminal_status="failed:qualify", container_label="other-run")
        self.assertFalse(any(call[:2] in (("container", "rm"), ("image", "rm")) for call in self.calls))


class JobTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.scratch = Path(self.temporary.name)
        self.repo = self.scratch / "repo"
        (self.repo / "scripts").mkdir(parents=True)
        (self.scratch / "evidence").mkdir()
        for name in ("linux-amd64-witness.py", "linux-amd64-receipt.py"):
            (self.scratch / name).write_bytes(b"fixture helper")
            (self.repo / "scripts" / name).write_bytes(b"fixture helper")
        witness.write_new(self.scratch / "preflight.json",
                          {"schema": 1, "run_id": RUN, "images": [ORIGINAL], "cache_was_empty": True})
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.query = self.stack.enter_context(patch.object(witness, "query", side_effect=AssertionError("unexpected query")))
        self.popen = self.stack.enter_context(patch.object(subprocess, "Popen", side_effect=AssertionError("unexpected process")))
        self.run = self.stack.enter_context(patch.object(subprocess, "run", side_effect=self.systemd))
        self.state = None
        self.fail_start = False
        self.race_start = False
        self.handler = None

        def register(sig, handler):
            self.assertEqual(sig, signal.SIGTERM)
            self.handler = handler
            return signal.SIG_DFL

        self.stack.enter_context(patch.object(signal, "signal", side_effect=register))

    @staticmethod
    def fields(active="active", sub="running", result="success", code="0"):
        return {"LoadState": "loaded", "ActiveState": active, "SubState": sub,
                "Result": result, "ExecMainStatus": code}

    def systemd(self, command, **kwargs):
        self.assertEqual(kwargs["env"], witness.CONTROL_ENV)
        for stream in ("stdin", "stderr"):
            self.assertEqual(kwargs[stream], subprocess.DEVNULL)
        if command[0] == "systemctl":
            self.assertEqual(command[-2:], ["--", "omp-witness-fixture-run.service"])
            if command[2] == "show":
                self.assertEqual(set(command[4:-2]), {"--property=" + key for key in witness.UNIT_FIELDS})
                fields = self.state or {"LoadState": "not-found", "ActiveState": "inactive", "SubState": "dead"}
                return SimpleNamespace(returncode=0 if self.state else 4,
                                       stdout="".join(key + "=" + value + "\n" for key, value in fields.items()).encode())
            self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
            if command[2] == "stop":
                self.state = self.fields("inactive", "dead")
            elif command[2] == "reset-failed":
                self.assertEqual(self.state["ActiveState"], "failed")
                self.state = None
            else:
                raise AssertionError(command)
        elif command[0] == "systemd-run":
            self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
            if self.fail_start or self.race_start:
                if self.race_start:
                    self.state = self.fields()
                raise subprocess.CalledProcessError(1, command)
            self.assertIsNone(self.state)
            self.state = self.fields()
        else:
            raise AssertionError(command)
        return SimpleNamespace(returncode=0)

    def result(self, status="success", code=0):
        witness.write_new(self.scratch / "job-terminal.json",
                          {"schema": 1, "run_id": RUN, "status": status, "exit_code": code})

    def milestones(self):
        return [witness.receipt.strict_json(path.read_bytes())["line"]
                for path in sorted((self.scratch / "job-progress").glob("*.json"))]

    def test_start_refuses_existing_systemd_unit(self):
        for active, sub in (("active", "running"), ("failed", "failed"), ("inactive", "dead")):
            with self.subTest(active=active):
                self.state = self.fields(active, sub)
                with self.assertRaises(ValueError):
                    witness.start(self.scratch, RUN, "a" * 40)
        self.assertTrue(all(call.args[0][0] == "systemctl" for call in self.run.call_args_list))
        self.popen.assert_not_called()
        self.query.assert_not_called()

    def test_start_uses_transient_service_null_streams_and_fixed_worker_environment(self):
        self.query.side_effect = None
        self.query.return_value = "a" * 40
        with contextlib.redirect_stdout(io.StringIO()):
            witness.start(self.scratch, RUN, "a" * 40)
        command = self.run.call_args.args[0]
        for option in ("--system", "--unit=omp-witness-fixture-run.service", "--service-type=exec",
                       "--property=WorkingDirectory=" + str(self.scratch), "--property=StandardInput=null",
                       "--property=StandardOutput=null", "--property=StandardError=null",
                       "--property=KillMode=control-group", "--property=TimeoutStopSec=180s",
                       "--property=RuntimeMaxSec=9h", "--property=Restart=no", "--property=UMask=0077"):
            self.assertIn(option, command)
        self.assertEqual(command[command.index("--") + 1:command.index("--") + 3], ["/usr/bin/env", "-i"])
        self.assertIn("worker", command)
        self.assertEqual(command[-2:], ["--recipe-commit", "a" * 40])
        self.assertEqual(self.run.call_args.kwargs["cwd"], self.scratch)
        self.assertNotIn("--collect", command)
        self.assertNotIn("SSH_AUTH_SOCK", " ".join(command))
        self.assertFalse((self.scratch / "job-request.json").exists())
        self.assertFalse((self.scratch / "job.json").exists())
        with self.assertRaises(ValueError):
            witness.start(self.scratch, RUN, "a" * 40)

    def test_systemd_atomic_name_collision_never_adopts_or_stops_existing_unit(self):
        self.query.side_effect = None
        self.query.return_value = "a" * 40
        self.race_start = True
        with self.assertRaises(subprocess.CalledProcessError):
            witness.start(self.scratch, RUN, "a" * 40)
        self.assertIsNone(witness.terminal(self.scratch, RUN))
        self.assertEqual(len([call for call in self.run.call_args_list if call.args[0][0] == "systemd-run"]), 1)
        self.assertFalse(any(call.args[0][2] == "stop" for call in self.run.call_args_list))

    def test_failed_start_leaves_no_reservation_and_abort_can_recover(self):
        self.query.side_effect = None
        self.query.return_value = "a" * 40
        self.fail_start = True
        with self.assertRaises(subprocess.CalledProcessError):
            witness.start(self.scratch, RUN, "a" * 40)
        self.assertIsNone(witness.terminal(self.scratch, RUN))
        self.assertFalse((self.scratch / "job-request.json").exists())
        self.query.side_effect = ["", "", ORIGINAL, "", witness.receipt.canonical_json(USAGE[0]).decode()]
        with contextlib.redirect_stdout(io.StringIO()):
            witness.cleanup(["docker"], self.scratch, RUN, abort=True)
        self.assertTrue((self.scratch / "abort.json").is_file())
        self.assertFalse((self.scratch / "mac-verified").exists())
        self.assertFalse(any("prune" in call.args for call in self.query.call_args_list))
        with self.assertRaises(ValueError):
            witness.start(self.scratch, RUN, "a" * 40)

    def test_worker_runs_entire_chain_and_binds_exact_image_then_records_success(self):
        calls = []

        def run(command, repo, scratch, seconds):
            calls.append((command, seconds))
            self.assertEqual(repo, self.repo)
            if "--image-id-file" in command:
                (self.scratch / "evidence/runtime-image-id").write_text(RUNTIME + "\n")
            return 0

        with patch.object(witness, "run_phase", side_effect=run), patch.object(witness, "stop_containers") as stop:
            self.assertEqual(witness.worker(["docker"], self.scratch, RUN, "a" * 40), 0)
        self.assertEqual(len(calls), 4)
        self.assertEqual([seconds for _, seconds in calls], [21600, 900, 5400, 900])
        qualify = calls[2][0]
        self.assertEqual(qualify[qualify.index("--runtime-image") + 1], RUNTIME)
        self.assertIn("--qualification-signers", calls[3][0])
        self.assertEqual(witness.terminal(self.scratch, RUN)["status"], "success")
        self.assertEqual(self.milestones(),
                         ["Phase: prepare.", "Phase: verify-candidate.", "Phase: qualify.", "Phase: verify."])
        stop.assert_not_called()

    def test_sigterm_stops_owned_containers_before_terminal_failure(self):
        def terminate(*args):
            self.handler(signal.SIGTERM, None)
            return -15

        def stopped(*args):
            self.assertFalse((self.scratch / "job-terminal.json").exists())

        with patch.object(witness, "run_phase", side_effect=terminate) as run, \
             patch.object(witness, "stop_containers", side_effect=stopped) as stop:
            self.assertEqual(witness.worker(["docker"], self.scratch, RUN, "a" * 40), 143)
        self.assertEqual(run.call_count, 1)
        stop.assert_called_once()
        self.assertEqual(stop.call_args.args[0][:2], ["docker", "--config"])
        self.assertEqual(stop.call_args.args[1], RUN)
        self.assertEqual(witness.terminal(self.scratch, RUN)["status"], "failed:prepare")
        self.assertEqual(witness.terminal(self.scratch, RUN)["exit_code"], 143)

    def test_phase_exception_stops_owned_containers_and_preserves_failure(self):
        with patch.object(witness, "run_phase", side_effect=OSError("fixture failure")), \
             patch.object(witness, "stop_containers") as stop:
            self.assertEqual(witness.worker(["docker"], self.scratch, RUN, "a" * 40), 1)
        stop.assert_called_once()
        self.assertEqual(witness.terminal(self.scratch, RUN)["status"], "failed:prepare")
        self.assertFalse(list(self.scratch.glob("docker-client-*")))

    def test_terminal_is_published_after_private_docker_client_cleanup(self):
        write_new = witness.write_new
        def publish(path, value):
            if path.name == "job-terminal.json":
                self.assertFalse(list(self.scratch.glob("docker-client-*")))
            write_new(path, value)
        with patch.object(witness, "run_phase", return_value=17), patch.object(witness, "stop_containers"), \
             patch.object(witness, "write_new", side_effect=publish):
            self.assertEqual(witness.worker(["docker"], self.scratch, RUN, "a" * 40), 17)

    def test_phase_failure_never_runs_the_next_phase(self):
        with patch.object(witness, "run_phase", return_value=17) as run, \
             patch.object(witness, "stop_containers") as stop:
            self.assertEqual(witness.worker(["docker"], self.scratch, RUN, "a" * 40), 17)
        self.assertEqual(run.call_count, 1)
        stop.assert_called_once()
        self.assertEqual(witness.terminal(self.scratch, RUN)["exit_code"], 17)

    def test_run_phase_uses_gnu_deadline_and_only_publishes_allowlisted_progress(self):
        process = MagicMock()
        process.__enter__.return_value = process
        process.stdout = io.BytesIO(b"untrusted diagnostic\nPhase: installing pinned build tools.\n")
        process.wait.return_value = 0
        self.popen.side_effect = None
        self.popen.return_value = process
        self.assertEqual(witness.run_phase(["fixture"], self.repo, self.scratch, 900), 0)
        self.assertEqual(self.milestones(), ["Phase: installing pinned build tools."])
        self.assertEqual(self.popen.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(self.popen.call_args.args[0],
                         ["timeout", "--signal=TERM", "--kill-after=30s", "900s", "fixture"])

    def test_status_is_read_only_path_free_and_zero_only_for_stopped_success(self):
        self.state = self.fields()
        witness.progress(self.scratch, "Phase: prepare.")
        before = {p.relative_to(self.scratch): p.read_bytes() for p in self.scratch.rglob("*") if p.is_file()}
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(witness.status(self.scratch, RUN), 2)
        self.assertIn("Witness job running.", output.getvalue())
        self.assertIn("ActiveState=active; SubState=running; Result=success; ExecMainStatus=0", output.getvalue())
        self.assertNotIn(str(self.scratch), output.getvalue())
        self.assertEqual(before, {p.relative_to(self.scratch): p.read_bytes()
                                  for p in self.scratch.rglob("*") if p.is_file()})
        self.result()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertNotEqual(witness.status(self.scratch, RUN), 0)
            self.state = None
            self.assertEqual(witness.status(self.scratch, RUN), 0)
        self.assertTrue(all(call.args[0][2] == "show" for call in self.run.call_args_list))
        self.query.assert_not_called()

    def test_terminal_success_never_overrides_systemd_failure_or_authorizes_success_cleanup(self):
        self.result()
        self.state = self.fields("failed", "failed", "signal", "15")
        (self.scratch / "mac-verified").write_bytes(b"verified\n")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertNotEqual(witness.status(self.scratch, RUN), 0)
        with self.assertRaises(ValueError):
            witness.cleanup(["docker"], self.scratch, RUN)
        self.query.assert_not_called()

    def test_status_failed_unit_and_gone_without_terminal_are_failures(self):
        for state in (None, self.fields("failed", "failed", "exit-code", "17")):
            self.state = state
            with self.subTest(state=state), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(witness.status(self.scratch, RUN), 1)
                self.assertIn("Witness failed: terminal result unavailable", output.getvalue())
        self.result("failed:prepare", 17)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(witness.status(self.scratch, RUN), 1)
        self.assertIn("Witness terminal: failed:prepare; exit code 17.", output.getvalue())

    def test_status_rejects_injected_progress_and_invalid_terminal_success(self):
        witness.progress(self.scratch, "Phase: prepare.")
        path = self.scratch / "job-progress/00.json"
        path.write_bytes(b'{"line":"synthetic/private/path"}\n')
        with self.assertRaises(ValueError):
            witness.status(self.scratch, RUN)
        path.unlink()
        self.result(status="success", code=1)
        with self.assertRaises(ValueError):
            witness.status(self.scratch, RUN)

    def test_systemctl_failure_or_invalid_state_never_looks_like_absent_unit(self):
        for response in (SimpleNamespace(returncode=1, stdout=b""),
                         SimpleNamespace(returncode=4, stdout=b"LoadState=not-found\n"),
                         SimpleNamespace(returncode=0, stdout=b"untrusted/private/path\n")):
            self.run.side_effect = None
            self.run.return_value = response
            with self.subTest(response=response), self.assertRaises(ValueError):
                witness.status(self.scratch, RUN)
        self.query.assert_not_called()

    def test_stop_uses_exact_systemd_unit_and_does_not_fabricate_terminal(self):
        self.state = self.fields()
        with contextlib.redirect_stdout(io.StringIO()):
            witness.stop(self.scratch, RUN)
        controls = [call.args[0] for call in self.run.call_args_list if call.args[0][2] != "show"]
        self.assertEqual(controls, [["systemctl", "--system", "stop", "--", "omp-witness-fixture-run.service"]])
        self.assertIsNone(witness.terminal(self.scratch, RUN))
        self.query.assert_not_called()

    def test_stop_absent_unit_is_safe_and_preserves_existing_terminal(self):
        self.result()
        before = (self.scratch / "job-terminal.json").read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            witness.stop(self.scratch, RUN)
        self.assertEqual((self.scratch / "job-terminal.json").read_bytes(), before)
        self.assertTrue(all(call.args[0][2] == "show" for call in self.run.call_args_list))

    def test_failed_unit_is_reset_only_by_exact_name_before_abort_finishes(self):
        self.state = self.fields("failed", "failed", "signal", "9")
        self.query.side_effect = ["", "", ORIGINAL, "", witness.receipt.canonical_json(USAGE[0]).decode()]
        with contextlib.redirect_stdout(io.StringIO()):
            witness.cleanup(["docker"], self.scratch, RUN, abort=True)
        self.assertIsNone(self.state)
        controls = [call.args[0] for call in self.run.call_args_list if call.args[0][2] != "show"]
        self.assertEqual(controls, [["systemctl", "--system", "reset-failed", "--", "omp-witness-fixture-run.service"]])
        self.assertFalse((self.scratch / "job-terminal.json").exists())

    def test_stop_container_requires_independent_label_check(self):
        self.query.side_effect = [CONTAINER, "other-run"]
        with self.assertRaises(ValueError):
            witness.stop_containers(["docker"], RUN)
        self.assertFalse(any(call.args[1:3] == ("container", "stop") for call in self.query.call_args_list))
        self.query.reset_mock()
        self.query.side_effect = [CONTAINER, RUN, ""]
        witness.stop_containers(["docker"], RUN)
        self.assertEqual(self.query.call_args.args[1:], ("container", "stop", "--time=30", CONTAINER))

    def test_abort_refuses_active_unit_or_wrong_baseline_before_docker(self):
        self.state = self.fields()
        with self.assertRaises(ValueError):
            witness.cleanup(["docker"], self.scratch, RUN, abort=True)
        with self.assertRaises(ValueError):
            witness.cleanup(["docker"], self.scratch, "other-run", abort=True)
        self.query.assert_not_called()

    def test_cli_status_and_stop_need_no_docker_client_or_checkout(self):
        self.state = self.fields()
        for action, expected in (("status", 2), ("stop", 0)):
            arguments = ["witness", action, "--scratch", str(self.scratch), "--run-id", RUN,
                         "--docker-socket", "unix:///var/run/docker.sock"]
            with self.subTest(action=action), patch.object(witness.sys, "argv", arguments), \
                 patch.object(witness, "scratch_path"), \
                 patch.object(witness.receipt, "validate_docker", side_effect=AssertionError("unexpected Docker")), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(witness.main(), expected)
        self.query.assert_not_called()

    def test_cli_preserves_worker_failure_for_systemd(self):
        arguments = ["witness", "worker", "--scratch", str(self.scratch), "--run-id", RUN,
                     "--docker-socket", "unix:///var/run/docker.sock", "--recipe-commit", "a" * 40]
        with patch.object(witness.sys, "argv", arguments), patch.object(witness, "scratch_path"), \
             patch.object(witness.receipt, "validate_docker", return_value=["docker"]), \
             patch.object(witness, "worker", return_value=17) as worker:
            self.assertEqual(witness.main(), 17)
        worker.assert_called_once_with(["docker"], self.scratch, RUN, "a" * 40)

    def test_explicit_retirement_requires_abort_or_verified_cleanup_record(self):
        with patch.object(witness.shutil, "rmtree") as remove, patch.object(os, "chdir"):
            with self.assertRaises(FileNotFoundError):
                witness.retire(self.scratch, RUN)
            remove.assert_not_called()
            witness.write_new(self.scratch / "abort.json",
                              {"schema": 1, "run_id": RUN, "original_images": [ORIGINAL],
                               "remaining_images": [ORIGINAL], "cache_pruned": False})
            with contextlib.redirect_stdout(io.StringIO()):
                witness.retire(self.scratch, RUN)
            remove.assert_called_once_with(self.scratch)


if __name__ == "__main__":
    unittest.main()
