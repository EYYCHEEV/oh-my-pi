#!/usr/bin/env python3
"""Scratch-owned witness lifecycle, safe inventory and narrowly scoped cleanup."""
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
import threading
import time

SPEC = importlib.util.spec_from_file_location("receipt", Path(__file__).with_name("linux-amd64-receipt.py"))
receipt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receipt)
require = receipt.require
LABEL = "org.stronk.omp-witness"
MIN_FREE = 884 * 10**9
MIN_DOCKER_FREE = 200 * 1024**3
JOB_PHASES = ("launch", "prepare", "verify-candidate", "qualify", "verify", "stop")
PROGRESS = (
    "Phase: prepare.", "Phase: verify-candidate.", "Phase: qualify.", "Phase: verify.",
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
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(receipt.canonical_json(value))


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


def process_identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    except FileNotFoundError:
        return None
    return {"state": fields[0], "pgid": int(fields[2]), "session": int(fields[3]), "start_ticks": int(fields[19])}


def job_record(scratch, run_id):
    record = receipt.strict_json((scratch / "job.json").read_bytes())
    require(set(record) == {"schema", "run_id", "pid", "pgid", "start_ticks"} and
            record["schema"] == 1 and record["run_id"] == run_id and
            all(type(record[key]) is int and record[key] > 1 for key in ("pid", "pgid", "start_ticks")) and
            record["pid"] == record["pgid"], "Invalid job identity")
    return record


def job_alive(record):
    current = process_identity(record["pid"])
    if current is None or current["state"] == "Z":
        return False
    require(current["start_ticks"] == record["start_ticks"] and
            current["pgid"] == current["session"] == record["pgid"], "Job process identity differs")
    return True


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
    result = terminal(scratch, run_id)
    if (scratch / "job.json").exists():
        require(not job_alive(job_record(scratch, run_id)), "Witness job is still active")
    require(result is not None or not any((scratch / name).exists() for name in ("job-request.json", "job.json")),
            "Witness job has no terminal result; preserve scratch")
    return result


def progress(scratch, text):
    require(text in PROGRESS, "Invalid progress")
    descriptor = os.open(scratch / "job-progress", os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a") as stream:
        stream.write(text + "\n")


def start(scratch, run_id, recipe_commit):
    baseline(scratch, run_id)
    require(receipt.match(receipt.OID, recipe_commit), "A reviewed recipe commit is required")
    require(not any((scratch / name).exists() for name in
                    ("job.json", "job-progress", "job-terminal.json", "abort.json", "cleanup.json")),
            "Witness job state already exists")
    repo = scratch / "repo"
    require(query([], "git", "-C", str(repo), "rev-parse", "HEAD") == recipe_commit, "Recipe checkout differs")
    for name in ("linux-amd64-witness.py", "linux-amd64-receipt.py"):
        require((scratch / name).read_bytes() == (repo / "scripts" / name).read_bytes(), "Scratch helper differs")
    write_new(scratch / "job-request.json", {"schema": 1, "run_id": run_id, "recipe_commit": recipe_commit})
    environment = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                   "HOME": str(scratch), "TMPDIR": str(scratch / "tmp"), "LANG": "C", "LC_ALL": "C",
                   "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "PYTHONDONTWRITEBYTECODE": "1"}
    try:
        # start_new_session invokes setsid. No SSH stream or journald log is inherited.
        subprocess.Popen([sys.executable, str(scratch / "linux-amd64-witness.py"), "worker",
                          "--scratch", str(scratch), "--run-id", run_id,
                          "--docker-socket", "unix:///var/run/docker.sock"],
                         cwd=scratch, env=environment, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        write_new(scratch / "job-terminal.json",
                  {"schema": 1, "run_id": run_id, "status": "failed:launch", "exit_code": 1})
        raise
    print("Witness job launched. Poll status; never restart after a disconnect.")


def stop_containers(docker, run_id):
    containers = query(docker, "ps", "--all", "--quiet", "--no-trunc", "--filter", f"label={LABEL}={run_id}").splitlines()
    for container in containers:
        require(receipt.match(receipt.HEX, container), "Invalid container identity")
        require(query(docker, "container", "inspect", "--format",
                      '{{index .Config.Labels "' + LABEL + '"}}', container) == run_id, "Container label differs")
        query(docker, "container", "stop", "--time=30", container)


def run_phase(command, repo, scratch, cancelled, seconds):
    def expire():
        cancelled["code"] = 124
        os.killpg(os.getpgrp(), signal.SIGTERM)

    timer = threading.Timer(seconds, expire)
    timer.daemon = True
    with subprocess.Popen(command, cwd=repo, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        timer.start()
        try:
            if cancelled["code"]:
                process.terminate()
            for line in iter(lambda: process.stdout.readline(65536), b""):
                text = line.decode("utf-8", errors="replace").strip()
                if text in PROGRESS:
                    progress(scratch, text)
            return process.wait()
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()
                process.wait()


def worker(docker, scratch, run_id):
    baseline(scratch, run_id)
    request = receipt.strict_json((scratch / "job-request.json").read_bytes())
    require(request["schema"] == 1 and request["run_id"] == run_id and
            receipt.match(receipt.OID, request["recipe_commit"]), "Invalid job request")
    pid = os.getpid()
    identity = process_identity(pid)
    require(identity is not None and identity["pgid"] == identity["session"] == pid, "Job must own a new session")
    cancelled = {"code": 0}

    def terminate(_signal, _frame):
        if not cancelled["code"]:
            cancelled["code"] = 143

    previous = signal.signal(signal.SIGTERM, terminate)
    phase, code = "launch", 1
    try:
        write_new(scratch / "job.json", {"schema": 1, "run_id": run_id, "pid": pid,
                                        "pgid": pid, "start_ticks": identity["start_ticks"]})
        repo, evidence = scratch / "repo", scratch / "evidence"
        python = sys.executable
        source = receipt.APPLICATION_COMMIT
        assets = "dist/witness-candidate"
        common_verify = [python, "scripts/linux-amd64-receipt.py", "verify", assets, "--commit", source]
        prepare = [python, "scripts/linux-amd64-runtime.py", "--commit", source,
                   "--recipe-commit", request["recipe_commit"], "--docker-socket", "unix:///var/run/docker.sock",
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
            code = run_phase(command, repo, scratch, cancelled, seconds)
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
        write_new(scratch / "job-terminal.json", {"schema": 1, "run_id": run_id,
                  "status": "failed:" + phase if code else "success", "exit_code": min(code, 255)})
        signal.signal(signal.SIGTERM, previous)


def status(scratch, run_id):
    path = scratch / "job-progress"
    if path.exists():
        lines = path.read_text().splitlines()
        require(all(line in PROGRESS for line in lines), "Invalid progress record")
        for line in lines:
            print(line)
    result = terminal(scratch, run_id)
    if result is not None:
        print("Witness terminal: " + result["status"] + "; exit code " + str(result["exit_code"]) + ".")
        return 0 if result["status"] == "success" else 1
    if (scratch / "job.json").exists():
        alive = job_alive(job_record(scratch, run_id))
        print("Witness job running." if alive else "Witness terminal result unavailable; preserve scratch.")
    else:
        print("Witness job launch pending." if (scratch / "job-request.json").exists() else "Witness job not started.")
    return 2


def stop(docker, scratch, run_id):
    baseline(scratch, run_id)
    record = job_record(scratch, run_id)
    if job_alive(record) and terminal(scratch, run_id) is None:
        os.killpg(record["pgid"], signal.SIGTERM)
    deadline = time.monotonic() + 180
    while job_alive(record):
        require(time.monotonic() < deadline, "Job has not stopped; preserve scratch")
        time.sleep(0.2)
    if terminal(scratch, run_id) is None:
        # A dead leader alone does not prove that its children have stopped.
        try:
            os.killpg(record["pgid"], 0)
        except ProcessLookupError:
            pass
        else:
            raise ValueError("Job group is still present; preserve scratch")
        stop_containers(docker, run_id)
        write_new(scratch / "job-terminal.json",
                  {"schema": 1, "run_id": run_id, "status": "failed:stop", "exit_code": 143})
    print("Witness job terminal. Inspect status before cleanup.")


def cleanup(docker, scratch, run_id, *, abort=False):
    before = baseline(scratch, run_id)
    require(not (scratch / ("abort.json" if abort else "cleanup.json")).exists(), "Cleanup evidence already exists")
    result = quiescent(scratch, run_id)
    if not abort:
        require(result is not None and result["status"] == "success", "Witness terminal success is required")
        require((scratch / "mac-verified").read_bytes() == b"verified\n", "Mac artifact verification is not acknowledged")
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
        docker = receipt.validate_docker(args.docker_socket)
        if args.phase == "start":
            start(args.scratch, args.run_id, args.recipe_commit)
            return 0
        with tempfile.TemporaryDirectory(prefix="docker-client-", dir=args.scratch) as config:
            docker += ["--config", config]
            if args.phase == "preflight":
                preflight(docker, args.scratch, args.run_id)
            elif args.phase == "worker":
                worker(docker, args.scratch, args.run_id)
            elif args.phase == "stop":
                stop(docker, args.scratch, args.run_id)
            else:
                cleanup(docker, args.scratch, args.run_id, abort=args.phase == "abort")
        return 0
    except (ValueError, OSError, KeyError, IndexError, TypeError, subprocess.SubprocessError):
        raise SystemExit("Witness stopped. Preserve scratch; do not retry with different inputs.") from None


if __name__ == "__main__":
    sys.exit(main())
