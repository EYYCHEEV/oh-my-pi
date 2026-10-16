#!/usr/bin/env python3
"""Systemd-owned witness lifecycle, safe inventory and narrowly scoped cleanup."""
import argparse
import grp
import importlib.util
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

SPEC = importlib.util.spec_from_file_location("receipt", Path(__file__).with_name("linux-amd64-receipt.py"))
receipt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receipt)
require = receipt.require
LABEL = "org.stronk.omp-witness"
MIN_FREE = 884 * 10**9
MIN_DOCKER_FREE = 200 * 1024**3
JOB_PHASES = ("launch", "prepare", "verify-candidate", "qualify", "verify", "stop")
CONTROL_ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
               "LANG": "C", "LC_ALL": "C", "SYSTEMD_COLORS": "0"}
UNIT_FIELDS = ("LoadState", "ActiveState", "SubState", "Result", "ExecMainStatus")
UNIT_RESULTS = ("success", "resources", "timeout", "exit-code", "signal", "core-dump",
                "watchdog", "start-limit-hit", "oom-kill", "exec-condition", "protocol")
PROGRESS = (
    "Phase: prepare.",
    "Phase: exporting a no-RUN workspace to the local daemon.",
    "Phase: preparing runtime under hard CPU and memory limits.",
    "Phase: installing pinned build tools.",
    "Phase: locked JavaScript dependencies.",
    "Phase: GNU amd64 baseline native addon.",
    "Phase: embedding native/resources and compiling baseline Bun.",
    "Phase: compiling canonical native regression.",
    "Phase: validating prepared runtime contract.",
    "Phase: prepared runtime complete.",
    "Phase: unqualified candidate assets and prepared local image exported.",
    "Phase: verify-candidate.", "Phase: qualify.", "Phase: verify.",
)
INFO = ('{"architecture":"{{.Architecture}}","os":"{{.OSType}}",'
        '"version":"{{.ServerVersion}}","driver":"{{.Driver}}",'
        '"root":"{{.DockerRootDir}}","cgroup":"{{.CgroupVersion}}",'
        '"cpus":{{.NCPU}},"containers":{{.Containers}},"images":{{.Images}},'
        '"proxy":{{if or .HTTPProxy .HTTPSProxy .NoProxy}}true{{else}}false{{end}}}')


def query(docker, *args):
    return subprocess.check_output(docker + list(args), stderr=subprocess.DEVNULL, timeout=60).decode().strip()


def identities(text):
    values = sorted(set(text.splitlines()))
    require(all(receipt.match(receipt.DIGEST, value) for value in values), "Invalid image inventory")
    return values


def validate_inventory(info, images, containers, free, operating_system, socket):
    require(info == {"architecture": "x86_64", "os": "linux", "version": "29.8.1", "driver": "overlayfs",
                     "root": "/data/docker", "cgroup": "2", "cpus": 24, "containers": 0, "images": 1,
                     "proxy": False}, "Daemon facts differ from the approved witness")
    require(len(images) == 1 and not containers and free >= MIN_FREE, "Inventory or disk differs")
    require(operating_system.get("ID") == "ubuntu" and operating_system.get("VERSION_ID") == "26.04" and
            operating_system.get("VERSION", "").split()[0] == "26.04.1", "Operating system differs")
    require(stat.S_ISSOCK(socket.st_mode) and socket.st_uid == 0 and grp.getgrgid(socket.st_gid).gr_name == "docker",
            "Docker socket ownership differs")


def os_release():
    # Select only public product/version fields. Never inspect network or machine identity.
    fields = {}
    for line in Path("/etc/os-release").read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator and key in ("ID", "VERSION_ID", "VERSION"):
            fields[key] = value.strip('"')
    return fields


def available_memory():
    fields = next((line.split() for line in Path("/proc/meminfo").read_text().splitlines()
                   if line.startswith("MemAvailable:")), [])
    require(len(fields) == 3 and fields[1].isdigit() and fields[2] == "kB",
            "Available memory cannot be established")
    amount = int(fields[1]) * 1024
    require(amount >= 32 * 1024**3, "A 24 GiB build needs at least 8 GiB host headroom")
    return amount


def scratch_path(path, run_id):
    receipt.witness_label(run_id)
    require(bool(run_id) and path == Path("/root") / ("omp-witness-" + run_id), "Wrong scratch directory")
    require(os.geteuid() == 0 and path.is_dir() and not path.is_symlink() and path.resolve() == path,
            "A real root-owned scratch directory is required")
    metadata = path.stat()
    require(metadata.st_uid == 0 and stat.S_IMODE(metadata.st_mode) == 0o700, "Scratch ownership or mode differs")


def write_new(path, value):
    # Publish only fully written, durable bytes. link() refuses an existing name.
    descriptor, temporary = tempfile.mkstemp(prefix=".record-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(receipt.canonical_json(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path, follow_symlinks=False)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)


def preflight(docker, scratch, run_id):
    require(not (scratch / "preflight.json").exists(), "Preflight evidence already exists")
    info = receipt.strict_json(query(docker, "info", "--format", INFO))
    # A normal list never exposes endpoint, registry, account, hostname or address fields.
    images = identities(query(docker, "image", "ls", "--all", "--quiet", "--no-trunc"))
    containers = query(docker, "ps", "--all", "--quiet")
    free = shutil.disk_usage("/").free
    system = os_release()
    validate_inventory(info, images, containers, free, system, Path("/var/run/docker.sock").stat())
    require(query(docker, "buildx", "version").split()[1] == "v0.37.1", "Buildx version differs")
    require(query([], "git", "--version").startswith("git version 2.53.") and sys.version_info[:2] == (3, 14),
            "Host Git or Python version differs")
    require(not any(shutil.which(tool) for tool in ("bun", "node")), "Host runtime installation differs")
    usage = [receipt.strict_json(line) for line in query(docker, "system", "df", "--format", "{{json .}}").splitlines()]
    require(all(set(row) == {"Type", "TotalCount", "Active", "Size", "Reclaimable"} for row in usage), "Unexpected disk fields")
    docker_free = shutil.disk_usage("/data/docker").free
    require(docker_free >= MIN_DOCKER_FREE, "Insufficient Docker storage headroom")
    memory = available_memory()
    cache = [row for row in usage if row["Type"] == "Build Cache"]
    require(len(cache) == 1 and str(cache[0]["TotalCount"]).isdigit(), "Missing cache inventory")
    require(not query(docker, "image", "ls", "--all", "--quiet", "--filter", f"label={LABEL}={run_id}"),
            "Witness label is already in use")
    value = {"schema": 1, "run_id": run_id, "images": images, "daemon": info, "free_bytes": free,
             "system_df": usage, "cache_was_empty": int(cache[0]["TotalCount"]) == 0,
             "docker_free_bytes": docker_free, "memory_available_bytes": memory}
    write_new(scratch / "preflight.json", value)
    print("Preflight passed; initial image and cache inventory recorded privately.")


def baseline(scratch, run_id):
    before = receipt.strict_json((scratch / "preflight.json").read_bytes())
    require(before["schema"] == 1 and before["run_id"] == run_id and
            len(identities("\n".join(before["images"]))) == 1 and
            type(before["cache_was_empty"]) is bool, "Invalid preservation record")
    return before


def unit_name(run_id):
    receipt.witness_label(run_id)
    require(bool(run_id), "A witness run identifier is required")
    return "omp-witness-" + run_id + ".service"


def unit_state(run_id):
    command = ["systemctl", "--system", "show", "--no-pager"]
    command += ["--property=" + field for field in UNIT_FIELDS]
    result = subprocess.run(command + ["--", unit_name(run_id)], env=CONTROL_ENV,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=60, check=False)
    fields = {}
    for line in result.stdout.decode().splitlines():
        key, separator, value = line.partition("=")
        require(separator and key in UNIT_FIELDS and key not in fields, "Invalid unit state")
        fields[key] = value
    if fields.get("LoadState") == "not-found":
        require(result.returncode in (0, 4) and fields.get("ActiveState") == "inactive" and
                fields.get("SubState") == "dead", "Unit absence cannot be established")
        return None
    require(result.returncode == 0 and set(fields) == set(UNIT_FIELDS) and fields["LoadState"] == "loaded" and
            fields["ActiveState"] in ("inactive", "activating", "active", "deactivating", "failed", "reloading") and
            receipt.match(r"[a-z][a-z-]{0,47}", fields["SubState"]) and fields["Result"] in UNIT_RESULTS and
            fields["ExecMainStatus"].isdigit() and 0 <= int(fields["ExecMainStatus"]) <= 255, "Invalid unit state")
    return fields


def unit_control(action, run_id):
    subprocess.run(["systemctl", "--system", action, "--", unit_name(run_id)], env=CONTROL_ENV,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=240, check=True)


def inactive(state):
    return state is None or state["ActiveState"] in ("inactive", "failed")


def successful_unit(state):
    return state is None or (state["ActiveState"] == "inactive" and
                             state["Result"] == "success" and state["ExecMainStatus"] == "0")


def clear_unit(run_id, *, success=False):
    state = unit_state(run_id)
    require(inactive(state), "Witness unit is still active")
    require(not success or successful_unit(state), "Witness unit did not exit successfully")
    if state is not None and state["ActiveState"] == "failed":
        unit_control("reset-failed", run_id)
    deadline = time.monotonic() + 10
    while state is not None:
        require(time.monotonic() < deadline, "Witness unit has not unloaded; preserve scratch")
        time.sleep(0.1)
        state = unit_state(run_id)


def terminal(scratch, run_id):
    path = scratch / "job-terminal.json"
    if not path.exists():
        return None
    result = receipt.strict_json(path.read_bytes())
    require(set(result) == {"schema", "run_id", "status", "exit_code"} and
            result["schema"] == 1 and result["run_id"] == run_id and
            type(result["exit_code"]) is int and 0 <= result["exit_code"] <= 255 and
            ((result["status"] == "success" and result["exit_code"] == 0) or
             (result["status"] in {"failed:" + phase for phase in JOB_PHASES} and result["exit_code"] != 0)),
            "Invalid terminal result")
    return result


def quiescent(scratch, run_id):
    require(inactive(unit_state(run_id)), "Witness unit is still active")
    return terminal(scratch, run_id)


def progress(scratch, text):
    require(text in PROGRESS, "Invalid progress")
    directory = scratch / "job-progress"
    directory.mkdir(mode=0o700, exist_ok=True)
    require(directory.is_dir() and not directory.is_symlink(), "Invalid progress directory")
    path = directory / f"{PROGRESS.index(text):02d}.json"
    value = {"line": text}
    if path.exists():
        require(receipt.strict_json(path.read_bytes()) == value, "Invalid progress record")
    else:
        write_new(path, value)


def start(scratch, run_id, recipe_commit):
    baseline(scratch, run_id)
    require(receipt.match(receipt.OID, recipe_commit), "A reviewed recipe commit is required")
    require(unit_state(run_id) is None, "Witness unit already exists")
    require(not any((scratch / name).exists() for name in
                    ("job-progress", "job-terminal.json", "job-failure.json", "abort.json", "cleanup.json")),
            "Witness job state already exists")
    repo = scratch / "repo"
    require(query([], "git", "-C", str(repo), "rev-parse", "HEAD") == recipe_commit, "Recipe checkout differs")
    for name in ("linux-amd64-witness.py", "linux-amd64-receipt.py"):
        require((scratch / name).read_bytes() == (repo / "scripts" / name).read_bytes(), "Scratch helper differs")
    environment = dict(CONTROL_ENV, HOME=str(scratch), TMPDIR=str(scratch / "tmp"),
                       GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", PYTHONDONTWRITEBYTECODE="1")
    command = ["systemd-run", "--system", "--quiet", "--unit=" + unit_name(run_id), "--service-type=exec"]
    command += ["--property=" + value for value in (
        "WorkingDirectory=" + str(scratch), "StandardInput=null", "StandardOutput=null", "StandardError=null",
        "KillMode=control-group", "TimeoutStopSec=180s", "SendSIGKILL=yes", "Restart=no", "UMask=0077",
        "RuntimeMaxSec=9h")]
    # env -i excludes manager and transport environment, not just the client's.
    command += ["--", "/usr/bin/env", "-i"] + [key + "=" + value for key, value in environment.items()]
    command += [sys.executable, str(scratch / "linux-amd64-witness.py"), "worker", "--scratch", str(scratch),
                "--run-id", run_id, "--docker-socket", "unix:///var/run/docker.sock",
                "--recipe-commit", recipe_commit]
    subprocess.run(command, cwd=scratch, env=CONTROL_ENV, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True)
    print("Witness unit submitted. Poll status; never restart after a disconnect.")


def stop_containers(docker, run_id):
    containers = query(docker, "ps", "--all", "--quiet", "--no-trunc", "--filter", f"label={LABEL}={run_id}").splitlines()
    for container in containers:
        require(receipt.match(receipt.HEX, container), "Invalid container identity")
        require(query(docker, "container", "inspect", "--format",
                      '{{index .Config.Labels "' + LABEL + '"}}', container) == run_id, "Container label differs")
        query(docker, "container", "stop", "--time=30", container)


def load_qualifier(repo):
    # The worker already binds this checkout to the reviewed recipe commit.
    spec = importlib.util.spec_from_file_location("witness_qualifier", repo / "scripts/linux-amd64-qualify.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_phase(command, repo, scratch, seconds, *, stages=None):
    # GNU timeout owns each child deadline; systemd owns cancellation of the unit.
    command = ["timeout", "--signal=TERM", "--kill-after=30s", str(seconds) + "s"] + command
    qualifier = load_qualifier(repo) if stages is not None else None
    with subprocess.Popen(command, cwd=repo, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        for line in iter(lambda: process.stdout.readline(65536), b""):
            raw = line.decode("utf-8", errors="replace")
            if raw.startswith("qualify-"):
                if qualifier is None or not raw.endswith("\n") or not qualifier.valid_stage(raw[:-1]):
                    process.terminate()
                    raise ValueError("Invalid qualification stage")
                stages[:] = [raw[:-1]]
                continue
            text = raw.strip()
            if text in PROGRESS:
                progress(scratch, text)
        return process.wait()


def worker(docker, scratch, run_id, recipe_commit):
    cancelled = {"code": 0}

    def terminate(_signal, _frame):
        if not cancelled["code"]:
            cancelled["code"] = 143

    previous = signal.signal(signal.SIGTERM, terminate)
    phase, code = "launch", 1
    stages = []
    try:
        with tempfile.TemporaryDirectory(prefix="docker-client-", dir=scratch) as config:
            docker = docker + ["--config", config]
            try:
                baseline(scratch, run_id)
                require(receipt.match(receipt.OID, recipe_commit), "A reviewed recipe commit is required")
                (scratch / "job-progress").mkdir(mode=0o700)
                repo, evidence = scratch / "repo", scratch / "evidence"
                python = sys.executable
                source = receipt.APPLICATION_COMMIT
                assets = "dist/witness-candidate"
                common_verify = [python, "scripts/linux-amd64-receipt.py", "verify", assets, "--commit", source]
                prepare = [python, "scripts/linux-amd64-runtime.py", "--commit", source,
                           "--recipe-commit", recipe_commit, "--docker-socket", "unix:///var/run/docker.sock",
                           "--witness-run-id", run_id, "--output", "witness-candidate",
                           "--image-id-file", str(evidence / "runtime-image-id")]
                for phase, command, seconds in (("prepare", prepare, 21600), ("verify-candidate", common_verify, 900),
                                                ("qualify", None, 5400), ("verify", common_verify + [
                                                    "--attestation", str(evidence / "qualification.json"),
                                                    "--qualification-signers", str(evidence / "qualification-signers")], 900)):
                    if cancelled["code"]:
                        break
                    progress(scratch, "Phase: " + phase + ".")
                    if phase == "qualify":
                        image = (evidence / "runtime-image-id").read_text().strip()
                        require(receipt.match(receipt.DIGEST, image), "Invalid runtime image")
                        command = ["bash", "scripts/qualify-linux-amd64.sh", "--commit", source, "--assets", assets,
                                   "--docker-socket", "unix:///var/run/docker.sock", "--runtime-image", image,
                                   "--witness-run-id", run_id, "--attestation-key", str(evidence / "qualification-key"),
                                   "--attestation", str(evidence / "qualification.json")]
                    if phase == "qualify":
                        code = run_phase(command, repo, scratch, seconds, stages=stages)
                    else:
                        code = run_phase(command, repo, scratch, seconds)
                    if code or cancelled["code"]:
                        break
            except (ValueError, OSError, KeyError, IndexError, TypeError, subprocess.SubprocessError):
                code = 1
            finally:
                code = cancelled["code"] or (128 - code if code < 0 else code)
                if code:
                    try:
                        stop_containers(docker, run_id)
                    except (ValueError, OSError, subprocess.SubprocessError):
                        phase, code = "stop", 1
    except (ValueError, OSError, KeyError, IndexError, TypeError, subprocess.SubprocessError):
        code = cancelled["code"] or 1
    finally:
        signal.signal(signal.SIGTERM, previous)
        # Client cleanup and owned-container stopping precede the last publication.
        if code:
            stage = stages[-1] if phase == "qualify" and stages else phase
            require(receipt.match(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", stage) and
                    (stage in JOB_PHASES or load_qualifier(scratch / "repo").valid_stage(stage)), "Invalid failure stage")
            write_new(scratch / "job-failure.json", {"schema": 1, "run_id": run_id, "stage": stage})
        write_new(scratch / "job-terminal.json", {"schema": 1, "run_id": run_id,
                  "status": "failed:" + phase if code else "success", "exit_code": min(code, 255)})
    return min(code, 255)


def status(scratch, run_id):
    state = unit_state(run_id)
    if state is None:
        print("Witness unit absent.")
    else:
        print("Witness unit: " + "; ".join(key + "=" + state[key] for key in UNIT_FIELDS[1:]) + ".")
    for index, text in enumerate(PROGRESS):
        path = scratch / "job-progress" / f"{index:02d}.json"
        if path.exists():
            require(receipt.strict_json(path.read_bytes()) == {"line": text}, "Invalid progress record")
            print(text)
    result = terminal(scratch, run_id)
    if result is not None:
        print("Witness terminal: " + result["status"] + "; exit code " + str(result["exit_code"]) + ".")
        return 0 if result["status"] == "success" and successful_unit(state) else 1
    if not inactive(state):
        print("Witness job running.")
        return 2
    print("Witness failed: terminal result unavailable; preserve scratch.")
    return 1


def stop(scratch, run_id):
    baseline(scratch, run_id)
    if unit_state(run_id) is not None:
        unit_control("stop", run_id)
    require(inactive(unit_state(run_id)), "Witness unit has not stopped; preserve scratch")
    print("Witness unit stopped or absent; inspect status before abort.")


def cleanup(docker, scratch, run_id, *, abort=False):
    before = baseline(scratch, run_id)
    require(not (scratch / ("abort.json" if abort else "cleanup.json")).exists(), "Cleanup evidence already exists")
    result = quiescent(scratch, run_id)
    if not abort:
        require(result is not None and result["status"] == "success", "Witness terminal success is required")
        require((scratch / "mac-verified").read_bytes() == b"verified\n", "Mac artifact verification is not acknowledged")
    clear_unit(run_id, success=not abort)
    original = set(before["images"])
    # Never force image deletion. Every target gets an independent label and baseline check.
    container_ids = query(docker, "ps", "--all", "--quiet", "--no-trunc", "--filter", f"label={LABEL}={run_id}").splitlines()
    for container in container_ids:
        require(receipt.match(r"[0-9a-f]{64}", container), "Invalid container identity")
        label = query(docker, "container", "inspect", "--format", '{{index .Config.Labels "' + LABEL + '"}}', container)
        require(label == run_id, "Container label differs")
        query(docker, "container", "rm", "--force", container)
    images = identities(query(docker, "image", "ls", "--all", "--quiet", "--no-trunc", "--filter", f"label={LABEL}={run_id}"))
    require(not original.intersection(images), "Cleanup would touch a pre-existing image")
    # Descendants are newer than their parent snapshots. Do not force parent removal.
    images.sort(key=lambda image: query(docker, "image", "inspect", "--format", "{{.Created}}", image), reverse=True)
    for image in images:
        require(query(docker, "image", "inspect", "--format", '{{index .Config.Labels "' + LABEL + '"}}', image) == run_id,
                "Image label differs")
        query(docker, "image", "rm", "--no-prune", image)
    remaining = set(identities(query(docker, "image", "ls", "--all", "--quiet", "--no-trunc")))
    require(original <= remaining, "Pre-existing image is missing")
    # BuildKit may retain the pinned base only in cache, not image inventory.
    allowed = original.copy()
    if remaining != original:
        base = query(docker, "image", "inspect", "--format", "{{.Id}}", receipt.BASE_IMAGE)
        require(receipt.match(receipt.DIGEST, base), "Pinned base identity is unavailable")
        allowed.add(base)
    require(not query(docker, "ps", "--all", "--quiet") and remaining <= allowed,
            "Unowned Docker state changed; preserve scratch and stop")
    prune = not abort and before["cache_was_empty"]
    if prune:
        query(docker, "builder", "prune", "--all", "--force")
        print("Initially empty default-builder cache removed; original image preserved.")
    else:
        print("Build cache preserved; witness layers may remain in shared cache.")
    usage = [receipt.strict_json(line) for line in query(docker, "system", "df", "--format", "{{json .}}").splitlines()]
    write_new(scratch / ("abort.json" if abort else "cleanup.json"),
              {"schema": 1, "run_id": run_id, "remaining_images": sorted(remaining),
               "original_images": sorted(original), "system_df": usage, "cache_pruned": prune})
    print("Abort cleanup passed; scratch, evidence and key preserved." if abort else
          "Docker cleanup passed; preserve summary before explicit scratch retirement.")


def retire(scratch, run_id):
    before = baseline(scratch, run_id)
    result = quiescent(scratch, run_id)
    aborted = (scratch / "abort.json").exists()
    record = receipt.strict_json((scratch / ("abort.json" if aborted else "cleanup.json")).read_bytes())
    require(record["schema"] == 1 and record["run_id"] == run_id and
            record["original_images"] == before["images"] and
            set(before["images"]) <= set(record["remaining_images"]), "Invalid cleanup evidence")
    if aborted:
        require(record["cache_pruned"] is False, "Abort must preserve cache")
    else:
        require(result is not None and result["status"] == "success" and
                (scratch / "mac-verified").read_bytes() == b"verified\n", "Successful handoff required")
    clear_unit(run_id, success=not aborted)
    os.chdir("/")
    shutil.rmtree(scratch)
    print("Only the validated witness scratch directory removed; dedicated key retired.")


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("Invalid witness arguments")


def main():
    try:
        parser = Parser(description=__doc__)
        parser.add_argument("phase", choices=("preflight", "start", "worker", "status", "stop", "cleanup", "abort", "retire"))
        parser.add_argument("--scratch", required=True, type=Path)
        parser.add_argument("--run-id", required=True)
        parser.add_argument("--docker-socket", required=True)
        parser.add_argument("--recipe-commit", default="")
        args = parser.parse_args()
        scratch_path(args.scratch, args.run_id)
        require(args.docker_socket == "unix:///var/run/docker.sock", "Witness socket differs")
        if args.phase == "status":
            return status(args.scratch, args.run_id)
        if args.phase == "retire":
            retire(args.scratch, args.run_id)
            return 0
        if args.phase == "stop":
            stop(args.scratch, args.run_id)
            return 0
        docker = receipt.validate_docker(args.docker_socket)
        if args.phase == "start":
            start(args.scratch, args.run_id, args.recipe_commit)
            return 0
        if args.phase == "worker":
            return worker(docker, args.scratch, args.run_id, args.recipe_commit)
        with tempfile.TemporaryDirectory(prefix="docker-client-", dir=args.scratch) as config:
            docker += ["--config", config]
            if args.phase == "preflight":
                preflight(docker, args.scratch, args.run_id)
            else:
                cleanup(docker, args.scratch, args.run_id, abort=args.phase == "abort")
        return 0
    except (ValueError, OSError, KeyError, IndexError, TypeError, subprocess.SubprocessError):
        raise SystemExit("Witness stopped. Preserve scratch; do not retry with different inputs.") from None


if __name__ == "__main__":
    sys.exit(main())
