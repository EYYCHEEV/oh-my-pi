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

    def test_process_identity_selects_only_group_session_and_start_time(self):
        fields = ["S", "1", "321", "321"] + ["0"] * 15 + ["100"]
        with patch.object(Path, "read_text", return_value="321 (fixture worker) " + " ".join(fields)):
            self.assertEqual(witness.process_identity(321),
                             {"state": "S", "pgid": 321, "session": 321, "start_ticks": 100})
        with patch.object(Path, "read_text", side_effect=FileNotFoundError):
            self.assertIsNone(witness.process_identity(321))


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
            if active:
                witness.write_new(scratch / "job-request.json", {"schema": 1})
                witness.write_new(scratch / "job.json",
                                  {"schema": 1, "run_id": RUN, "pid": 321, "pgid": 321, "start_ticks": 100})
            if acknowledged:
                (scratch / "mac-verified").write_bytes(b"verified\n")
            try:
                with patch.object(witness, "job_alive", return_value=active):
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
        self.killpg = self.stack.enter_context(patch.object(os, "killpg", side_effect=AssertionError("unexpected signal")))
        self.identity = self.stack.enter_context(patch.object(
            witness, "process_identity", return_value={"state": "S", "pgid": 321, "session": 321, "start_ticks": 100}))
        self.stack.enter_context(patch.object(os, "getpid", return_value=321))
        self.handler = None

        def register(sig, handler):
            self.assertEqual(sig, signal.SIGTERM)
            self.handler = handler
            return signal.SIG_DFL

        self.stack.enter_context(patch.object(signal, "signal", side_effect=register))

    def request(self):
        witness.write_new(self.scratch / "job-request.json",
                          {"schema": 1, "run_id": RUN, "recipe_commit": "a" * 40})

    def record(self):
        witness.write_new(self.scratch / "job.json",
                          {"schema": 1, "run_id": RUN, "pid": 321, "pgid": 321, "start_ticks": 100})

    def result(self, status="success", code=0):
        witness.write_new(self.scratch / "job-terminal.json",
                          {"schema": 1, "run_id": RUN, "status": status, "exit_code": code})

    def test_start_detaches_all_streams_and_never_allows_a_second_launch(self):
        self.query.side_effect = None
        self.query.return_value = "a" * 40
        self.popen.side_effect = None
        with contextlib.redirect_stdout(io.StringIO()):
            witness.start(self.scratch, RUN, "a" * 40)
        self.assertTrue(self.popen.call_args.kwargs["start_new_session"])
        for stream in ("stdin", "stdout", "stderr"):
            self.assertEqual(self.popen.call_args.kwargs[stream], subprocess.DEVNULL)
        self.assertEqual(self.popen.call_args.kwargs["cwd"], self.scratch)
        self.assertIn("worker", self.popen.call_args.args[0])
        self.assertNotIn("SSH_AUTH_SOCK", self.popen.call_args.kwargs["env"])
        with self.assertRaises(FileExistsError):
            witness.start(self.scratch, RUN, "a" * 40)
        self.assertEqual(self.popen.call_count, 1)

    def test_failed_launch_has_terminal_failure_and_still_forbids_restart(self):
        self.query.side_effect = None
        self.query.return_value = "a" * 40
        self.popen.side_effect = OSError("synthetic path error")
        with self.assertRaises(OSError):
            witness.start(self.scratch, RUN, "a" * 40)
        self.assertEqual(witness.terminal(self.scratch, RUN)["status"], "failed:launch")
        with self.assertRaises(ValueError):
            witness.start(self.scratch, RUN, "a" * 40)
        self.assertEqual(self.popen.call_count, 1)

    def test_worker_runs_entire_chain_and_binds_exact_image_then_records_success(self):
        self.request()
        calls = []

        def run(command, repo, scratch, cancelled, seconds):
            calls.append((command, seconds))
            self.assertEqual(repo, self.repo)
            if "--image-id-file" in command:
                (self.scratch / "evidence/runtime-image-id").write_text(RUNTIME + "\n")
            return 0

        with patch.object(witness, "run_phase", side_effect=run), patch.object(witness, "stop_containers") as stop:
            witness.worker(["docker"], self.scratch, RUN)
        self.assertEqual(len(calls), 4)
        self.assertEqual([seconds for _, seconds in calls], [21600, 900, 5400, 900])
        qualify = calls[2][0]
        self.assertEqual(qualify[qualify.index("--runtime-image") + 1], RUNTIME)
        self.assertIn("--qualification-signers", calls[3][0])
        self.assertEqual(witness.terminal(self.scratch, RUN)["status"], "success")
        self.assertEqual((self.scratch / "job-progress").read_text().splitlines(),
                         ["Phase: prepare.", "Phase: verify-candidate.", "Phase: qualify.", "Phase: verify."])
        stop.assert_not_called()

    def test_phase_failure_and_group_termination_stop_owned_containers_before_terminal(self):
        self.request()

        def terminate(*args):
            self.handler(signal.SIGTERM, None)
            return -15

        def stopped(*args):
            self.assertFalse((self.scratch / "job-terminal.json").exists())

        with patch.object(witness, "run_phase", side_effect=terminate) as run, \
             patch.object(witness, "stop_containers", side_effect=stopped) as stop:
            witness.worker(["docker"], self.scratch, RUN)
        self.assertEqual(run.call_count, 1)
        stop.assert_called_once_with(["docker"], RUN)
        self.assertEqual(witness.terminal(self.scratch, RUN)["status"], "failed:prepare")
        self.assertEqual(witness.terminal(self.scratch, RUN)["exit_code"], 143)

    def test_phase_failure_never_runs_the_next_phase(self):
        self.request()
        with patch.object(witness, "run_phase", return_value=17) as run, \
             patch.object(witness, "stop_containers") as stop:
            witness.worker(["docker"], self.scratch, RUN)
        self.assertEqual(run.call_count, 1)
        stop.assert_called_once()
        self.assertEqual(witness.terminal(self.scratch, RUN)["exit_code"], 17)

    def test_run_phase_discards_unknown_output_and_preserves_only_allowlist(self):
        process = MagicMock()
        process.__enter__.return_value = process
        process.stdout = io.BytesIO(b"untrusted diagnostic\nPhase: installing pinned build tools.\n")
        process.wait.return_value = 0
        process.poll.return_value = 0
        self.popen.side_effect = None
        self.popen.return_value = process
        with patch.object(witness.threading, "Timer") as timer:
            self.assertEqual(witness.run_phase(["fixture"], self.repo, self.scratch, {"code": 0}, 900), 0)
        self.assertEqual((self.scratch / "job-progress").read_text(), "Phase: installing pinned build tools.\n")
        self.assertEqual(self.popen.call_args.kwargs["stderr"], subprocess.DEVNULL)
        timer.return_value.start.assert_called_once()
        timer.return_value.cancel.assert_called_once()

    def test_status_is_read_only_path_free_and_zero_only_for_success(self):
        self.record()
        witness.progress(self.scratch, "Phase: prepare.")
        before = {p.name: p.read_bytes() for p in self.scratch.iterdir() if p.is_file()}
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(witness.status(self.scratch, RUN), 2)
        self.assertIn("Witness job running.", output.getvalue())
        self.assertNotIn(str(self.scratch), output.getvalue())
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.scratch.iterdir() if p.is_file()})
        self.result()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(witness.status(self.scratch, RUN), 0)
        self.assertIn("Witness terminal: success; exit code 0.", output.getvalue())
        self.query.assert_not_called()

    def test_status_rejects_injected_progress_and_invalid_terminal_success(self):
        (self.scratch / "job-progress").write_text("synthetic/private/path\n")
        with self.assertRaises(ValueError):
            witness.status(self.scratch, RUN)
        (self.scratch / "job-progress").unlink()
        self.result(status="success", code=1)
        with self.assertRaises(ValueError):
            witness.status(self.scratch, RUN)

    def test_stop_signals_only_verified_group_and_waits_for_terminal_evidence(self):
        self.record()
        self.identity.side_effect = [
            {"state": "S", "pgid": 321, "session": 321, "start_ticks": 100}, None]

        def kill(group, sig):
            self.assertEqual((group, sig), (321, signal.SIGTERM))
            self.result("failed:prepare", 143)

        self.killpg.side_effect = kill
        with contextlib.redirect_stdout(io.StringIO()):
            witness.stop(["docker"], self.scratch, RUN)
        self.killpg.assert_called_once_with(321, signal.SIGTERM)
        self.query.assert_not_called()

    def test_explicit_stop_recovers_dead_driver_only_after_group_disappears(self):
        self.record()
        self.identity.return_value = None
        self.killpg.side_effect = ProcessLookupError
        with patch.object(witness, "stop_containers") as stop, contextlib.redirect_stdout(io.StringIO()):
            witness.stop(["docker"], self.scratch, RUN)
        stop.assert_called_once_with(["docker"], RUN)
        self.assertEqual(witness.terminal(self.scratch, RUN)["status"], "failed:stop")
        self.killpg.assert_called_once_with(321, 0)

    def test_dead_driver_with_live_group_does_not_authorize_cleanup(self):
        self.record()
        self.identity.return_value = None
        self.killpg.side_effect = None
        with patch.object(witness, "stop_containers") as stop, self.assertRaises(ValueError):
            witness.stop(["docker"], self.scratch, RUN)
        stop.assert_not_called()
        self.assertIsNone(witness.terminal(self.scratch, RUN))

    def test_reused_pid_never_receives_a_signal_or_authorizes_abort(self):
        self.record()
        self.identity.return_value = {"state": "S", "pgid": 321, "session": 321, "start_ticks": 101}
        with self.assertRaises(ValueError):
            witness.stop(["docker"], self.scratch, RUN)
        with self.assertRaises(ValueError):
            witness.cleanup(["docker"], self.scratch, RUN, abort=True)
        self.killpg.assert_not_called()
        self.query.assert_not_called()

    def test_stop_container_requires_independent_label_check(self):
        self.query.side_effect = [CONTAINER, "other-run"]
        with self.assertRaises(ValueError):
            witness.stop_containers(["docker"], RUN)
        self.assertFalse(any(call.args[1:3] == ("container", "stop") for call in self.query.call_args_list))
        self.query.reset_mock()
        self.query.side_effect = [CONTAINER, RUN, ""]
        witness.stop_containers(["docker"], RUN)
        self.assertEqual(self.query.call_args.args[1:], ("container", "stop", "--time=30", CONTAINER))

    def test_abort_refuses_missing_terminal_result_or_wrong_baseline_before_docker(self):
        self.request()
        with self.assertRaises(ValueError):
            witness.cleanup(["docker"], self.scratch, RUN, abort=True)
        with self.assertRaises(ValueError):
            witness.cleanup(["docker"], self.scratch, "other-run", abort=True)
        self.query.assert_not_called()

    def test_dead_job_identity_without_request_still_needs_explicit_stop(self):
        self.record()
        self.identity.return_value = None
        with self.assertRaises(ValueError):
            witness.cleanup(["docker"], self.scratch, RUN, abort=True)
        self.query.assert_not_called()

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
