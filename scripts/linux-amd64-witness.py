#!/usr/bin/env python3
"""Local-only witness inventory and narrowly scoped cleanup. Execution needs approval."""
import argparse
import grp
import importlib.util
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

SPEC = importlib.util.spec_from_file_location("receipt", Path(__file__).with_name("linux-amd64-receipt.py"))
receipt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receipt)
require = receipt.require
LABEL = "org.stronk.omp-witness"
MIN_FREE = 884 * 10**9
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
    require(docker_free >= 120 * 1024**3, "Insufficient Docker storage headroom")
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


def cleanup(docker, scratch, run_id):
    before = receipt.strict_json((scratch / "preflight.json").read_bytes())
    require(before["schema"] == 1 and before["run_id"] == run_id and
            len(identities("\n".join(before["images"]))) == 1, "Invalid preservation record")
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
        query(docker, "image", "rm", image)
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
    if before["cache_was_empty"]:
        query(docker, "builder", "prune", "--all", "--force")
        print("Initially empty default-builder cache removed; original image preserved.")
    else:
        print("Pre-existing build cache preserved; witness layers may remain in shared cache.")
    usage = [receipt.strict_json(line) for line in query(docker, "system", "df", "--format", "{{json .}}").splitlines()]
    write_new(scratch / "cleanup.json", {"schema": 1, "run_id": run_id, "remaining_images": sorted(remaining),
                                       "original_images": sorted(original), "system_df": usage,
                                       "cache_pruned": before["cache_was_empty"]})
    print("Docker cleanup passed. Remove only this scratch directory after preserving this summary.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("preflight", "cleanup"))
    parser.add_argument("--scratch", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--docker-socket", required=True)
    args = parser.parse_args()
    try:
        scratch_path(args.scratch, args.run_id)
        require(args.docker_socket == "unix:///var/run/docker.sock", "Witness socket differs")
        docker = receipt.validate_docker(args.docker_socket)
        with tempfile.TemporaryDirectory(prefix="docker-client-", dir=args.scratch) as config:
            docker += ["--config", config]
            if args.phase == "preflight":
                preflight(docker, args.scratch, args.run_id)
            else:
                cleanup(docker, args.scratch, args.run_id)
    except (ValueError, OSError, KeyError, IndexError, TypeError, subprocess.SubprocessError):
        raise SystemExit("Witness stopped. Preserve scratch; do not retry with different inputs.") from None


if __name__ == "__main__":
    main()
