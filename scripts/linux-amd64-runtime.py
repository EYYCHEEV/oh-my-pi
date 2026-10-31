#!/usr/bin/env python3
"""Prepare an untagged local amd64 runtime and exact unqualified assets."""
import argparse
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading


def load_qualifier():
    spec = importlib.util.spec_from_file_location("linux_amd64_runtime_qualifier", Path(__file__).with_name("linux-amd64-qualify.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


qualify = load_qualifier()
receipt = qualify.receipt
require = receipt.require
PREPARED = Path("/opt/omp-qualification")
TOOL_PATH = "/usr/local/bin:/usr/bin:/bin"
PHASES = (
    "Phase: installing pinned build tools.",
    "Phase: locked JavaScript dependencies.",
    "Phase: GNU amd64 baseline native addon.",
    "Phase: embedding native/resources and compiling baseline Bun.",
    "Phase: compiling canonical native regression.",
    "Phase: validating prepared runtime contract.",
    "Phase: prepared runtime complete.",
)


class Client:
    """Discard raw diagnostics; retain only operation, phase, and return status."""
    def __init__(self, docker, scratch):
        config = scratch / "docker-client"
        config.mkdir(mode=0o700)
        home = scratch / "client-home"
        home.mkdir(mode=0o700)
        self.command = docker + ["--config", str(config)]
        self.environment = {"PATH": os.environ.get("PATH", os.defpath), "HOME": str(home),
                            "LANG": "C", "LC_ALL": "C", "DOCKER_BUILDKIT": "1"}
        self.diagnostics = scratch / "status.jsonl"

    def record(self, value):
        descriptor = os.open(self.diagnostics, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "ab") as stream:
            stream.write(receipt.canonical_json(value))

    def call(self, args, capture=False, progress=False):
        operation = args[0]
        if progress:
            self.record({"operation": operation, "status": "started"})
            # Hard phase deadlines bound silent base pulls and compilation too.
            seconds = 1800 if operation == "build" else 14400
            expired = threading.Event()
            with subprocess.Popen(self.command + args, env=self.environment, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL) as process:
                def expire():
                    expired.set()
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass

                timer = threading.Timer(seconds, expire)
                timer.daemon = True
                timer.start()
                try:
                    for line in iter(lambda: process.stdout.readline(65536), b""):
                        text = line.decode("utf-8", errors="replace").strip()
                        if text in PHASES:
                            self.record({"phase": text})
                            print(text, flush=True)
                    status = process.wait()
                finally:
                    timer.cancel()
            if expired.is_set():
                self.record({"operation": operation, "status": "deadline_exceeded"})
                raise subprocess.TimeoutExpired("local runtime preparation", seconds)
            self.record({"operation": operation, "returncode": status})
            require(status == 0, "Local runtime preparation operation failed")
            return ""
        result = subprocess.run(self.command + args, env=self.environment, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=900 if operation == "commit" else 120, check=False)
        self.record({"operation": operation, "returncode": result.returncode})
        require(result.returncode == 0, "Local runtime preparation operation failed")
        return result.stdout.decode("ascii").strip() if capture else ""


def create_command(image, run_id):
    # A fixed, run-scoped name lets the owner prove removal in addition to the exact run label.
    return ["create", "--pull=never", "--cpus=4", "--memory=24g", "--memory-swap=24g", "--pids-limit=1024",
            "--log-driver=none", "--security-opt=no-new-privileges", "--workdir=/src",
            *receipt.witness_label(run_id), f"--name=omp-build-{run_id}-prepare", "--entrypoint=/bin/bash", image,
            "/recipe/linux-amd64-build.sh", "prepare-runtime"]


def export_inputs(root, commit, recipe_commit, context):
    # Both exports are immutable Git objects; no worktree files/caches enter.
    qualify.export_source(root, commit, context / "source")
    recipe = context / "recipe"
    recipe.mkdir()
    for name in receipt.RECIPES:
        (recipe / name).write_bytes(receipt.git_bytes(root, recipe_commit, "scripts/" + name))


def build_command(context, image_file, commit, epoch, run_id, tag="", tag_object="", recipe_commit=""):
    command = ["build", "--platform=linux/amd64", "--target=workspace", "--file", str(context / "recipe/linux-amd64.Dockerfile"),
               "--iidfile", str(image_file), "--provenance=false", "--sbom=false", "--progress=plain", "--output=type=docker"]
    command += receipt.witness_label(run_id)
    # Only explicit, validated release inputs may claim committed recipe identity.
    for name, value in {"SOURCE_COMMIT": commit, "SOURCE_TAG": tag, "SOURCE_TAG_OBJECT": tag_object, "SOURCE_DATE_EPOCH": epoch,
                        "RECIPE_COMMITTED": "1" if tag else "0", "RECIPE_COMMIT": recipe_commit, "WITNESS_RUN_ID": run_id}.items():
        command += ["--build-arg", name + "=" + value]
    return command + [str(context)]


def prepare(args, root=None):
    root = root or Path(__file__).resolve().parent.parent
    require(receipt.match(receipt.OID, args.commit), "A full application commit is required")
    require(receipt.match(receipt.OID, args.recipe_commit), "A full reviewed recipe commit is required")
    require(args.witness_run_id, "A witness run identifier is required")
    receipt.witness_label(args.witness_run_id)
    require(receipt.match(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.output), "Output must be a new dist child")
    receipt.commit_exists(root, args.commit)
    require(receipt.capture("git", "-C", str(root), "rev-parse", "HEAD").strip() == args.recipe_commit,
            "The reviewed recipe must be the checked out commit")
    receipt.assert_recipes(root, args.recipe_commit)
    # Refuse an application this recipe cannot qualify under the supplied fork manifest before any daemon contact.
    require(receipt.match(receipt.HEX, args.fork_manifest_sha256), "A fork manifest SHA-256 is required")
    fork, _, _ = qualify.load_fork_manifest(args.fork_manifest, args.fork_manifest_sha256)
    qualify.application_preflight(root, args.commit, fork)
    tag = getattr(args, "tag", "")
    allowed, revoked = getattr(args, "allowed_signers", None), getattr(args, "revoked_signers", None)
    tag_object = ""
    if tag:
        require(revoked is not None, "An explicit public revocation file is required")
        tag_object = receipt.validate_tag(root, args.commit, tag, allowed, revoked)
    else:
        require(allowed is None and revoked is None, "Source signers require release mode")
    # Validate transport and overrides before even an architecture query.
    docker = receipt.validate_docker(args.docker_socket)
    dist = root / "dist"
    require(not dist.is_symlink(), "A symlinked dist is forbidden")
    destination = dist / args.output
    require(not destination.exists() and not destination.is_symlink(), "Output already exists")
    image_file = args.image_id_file.absolute()
    require(image_file.parent.is_dir() and not image_file.exists() and not image_file.is_symlink() and
            not image_file.resolve().is_relative_to(destination.resolve()), "A fresh image ID file outside assets is required")
    epoch = receipt.capture("git", "-C", str(root), "show", "-s", "--format=%ct", args.commit).strip()
    require(receipt.match(r"[1-9][0-9]*", epoch), "Invalid immutable source timestamp")
    dist.mkdir(mode=0o700, exist_ok=True)
    # Keep private status and immutable inputs on failure, never prune inventory.
    scratch = Path(tempfile.mkdtemp(prefix=".linux-amd64-runtime.", dir=dist))
    context = scratch / "context"
    context.mkdir()
    export_inputs(root, args.commit, args.recipe_commit, context)
    client = Client(docker, scratch)
    require(client.call(["info", "--format", "{{.Architecture}}"], capture=True) in ("amd64", "x86_64"),
            "A native amd64 daemon is required")
    print("Phase: exporting a no-RUN workspace to the local daemon.", flush=True)
    workspace_file = scratch / "workspace-image-id"
    client.call(build_command(context, workspace_file, args.commit, epoch, args.witness_run_id,
                              tag, tag_object, args.recipe_commit if tag else ""), progress=True)
    image = workspace_file.read_text().strip()
    require(receipt.match(receipt.DIGEST, image), "Invalid local workspace image ID")
    require(client.call(["image", "inspect", "--format", "{{.Id}}", image], capture=True) == image and
            client.call(["image", "inspect", "--format", "{{.Architecture}}", image], capture=True) == "amd64",
            "Local workspace image identity differs")
    container = client.call(create_command(image, args.witness_run_id), capture=True)
    require(receipt.match(receipt.HEX, container), "Invalid local container ID")
    try:
        return finish_container(client, container, scratch, context, root, args, image_file, destination, tag_object)
    except (Exception, KeyboardInterrupt):
        # Preserve the known labeled container, stopped, for explicit cleanup.
        try:
            client.call(["stop", "--time=30", container])
        except (ValueError, OSError, subprocess.SubprocessError):
            client.record({"operation": "stop", "status": "failed"})
        raise


def finish_container(client, container, scratch, context, root, args, image_file, destination, tag_object=""):
    print("Phase: preparing runtime under hard CPU and memory limits.", flush=True)
    client.call(["start", "--attach", container], progress=True)
    # Docker start --attach alone is not evidence that the process succeeded.
    state = client.call(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", container], capture=True)
    require(receipt.match(r"(?:true|false) [0-9]+", state), "Invalid preparation state")
    running, exit_code = state.split()
    client.record({"operation": "container", "running": running == "true", "exit_code": int(exit_code)})
    require(state == "false 0", "Runtime preparation did not exit successfully")
    assets = scratch / "assets"
    assets.mkdir()
    for name in receipt.ASSETS:
        client.call(["cp", container + ":/out/" + name, str(assets / name)])
    tag = getattr(args, "tag", "")
    manifest = receipt.verify(assets, args.commit, tag, False, args.recipe_commit if tag else "", root)
    require(not tag or manifest["source"]["tag_object"] == tag_object, "Exported source tag object differs")
    require(manifest["build_inputs"]["recipe"] == {
        name: receipt.digest(context / "recipe" / name) for name in receipt.RECIPES}, "Exported recipe bytes differ")
    runtime_image = client.call(["commit", "--change", "USER 65532:65532", "--change", "WORKDIR /",
                                 "--change", "ENV PATH=" + TOOL_PATH, "--change", "ENV HOME=/home/qualification",
                                 "--change", "LABEL org.stronk.omp-witness=" + args.witness_run_id, container], capture=True)
    require(receipt.match(receipt.DIGEST, runtime_image), "Invalid prepared local image ID")
    require(client.call(["image", "inspect", "--format", "{{.Id}}", runtime_image], capture=True) == runtime_image and
            client.call(["image", "inspect", "--format", "{{.Architecture}}", runtime_image], capture=True) == "amd64",
            "Prepared local image identity differs")
    descriptor = os.open(image_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(runtime_image + "\n")
    destination.mkdir(mode=0o700)
    for name in receipt.ASSETS:
        with (assets / name).open("rb") as source, (destination / name).open("xb") as target:
            shutil.copyfileobj(source, target)
    (destination / receipt.ASSETS[0]).chmod(0o755)
    # Only this known stopped container, after both copy and commit succeeded.
    client.call(["rm", container])
    print("Phase: prepared runtime complete." if tag else
          "Phase: unqualified candidate assets and prepared local image exported.", flush=True)
    print(runtime_image, flush=True)
    return runtime_image


def copy_dependencies(source=Path("/src"), prepared=PREPARED / "source"):
    for module_root in qualify.dependency_roots(source):
        destination = prepared / module_root.relative_to(source)
        require(not destination.exists() and not destination.is_symlink(), "Pristine export contains dependencies")
        shutil.copytree(module_root, destination, symlinks=True)
    # Validate the final layout, including relative workspace links.
    require(qualify.dependency_digest(prepared) == qualify.dependency_digest(source), "Frozen dependency copy differs")


def prepared_metadata(prepared, manifest, bun):
    source = prepared / "source"
    grep = prepared / "native-grep-regression"
    require(receipt.match(receipt.OID, manifest["source"]["commit"]), "Prepared application differs")
    require(receipt.digest(bun) == manifest["build_inputs"]["host_tools"]["bun"]["sha256"], "Prepared Bun bytes differ")
    locks = {name: receipt.digest(source / name) for name in receipt.LOCKS}
    require(locks == manifest["build_inputs"]["locks"], "Prepared locks differ")
    require(grep.is_file() and not grep.is_symlink() and os.access(grep, os.X_OK), "Native regression executable is missing")
    require(receipt.elf(grep)["interpreter"] == "ld-linux-x86-64.so.2", "A GNU amd64 native regression is required")
    return {"schema": 1, "source_commit": manifest["source"]["commit"], "bun_version": receipt.BUN_VERSION, "locks": locks,
            "dependency_tree_sha256": qualify.dependency_digest(source), "native_grep_sha256": receipt.digest(grep)}


def inside_prepare():
    require(sys.version_info >= (3, 12), "Python 3.12 or newer is required")
    environment = {"PATH": TOOL_PATH, "HOME": "/tmp", "TMPDIR": "/tmp", "LANG": "C", "LC_ALL": "C", "TZ": "UTC"}

    def unprivileged():
        os.setgroups([])
        os.setgid(65532)
        os.setuid(65532)

    def output(command, seconds=30):
        return subprocess.check_output(command, cwd=PREPARED / "source", env=environment, stderr=subprocess.DEVNULL,
                                       timeout=seconds, preexec_fn=unprivileged)

    require(b"GNU coreutils" in output(["timeout", "--version"]).splitlines()[0], "GNU timeout is required")
    require(receipt.match(r"glibc [0-9]+(?:\.[0-9]+)+", output(["getconf", "GNU_LIBC_VERSION"]).decode().strip()),
            "GNU libc tools are required")
    require(b"GNU readelf" in output(["readelf", "--version"]).splitlines()[0], "GNU readelf is required")
    require(output(["bun", "--version"]) == f"{receipt.BUN_VERSION}\n".encode(), "Pinned Bun is required")
    manifest = receipt.strict_json(Path("/out/RELEASE_MANIFEST.json").read_bytes())
    metadata = prepared_metadata(PREPARED, manifest, Path("/usr/local/bin/bun"))
    result = output([str(PREPARED / "native-grep-regression"), qualify.NATIVE_GREP_TEST, "--exact"], 300)
    require(re.search(rb"(?m)^running 1 test$", result) and
            re.search(rb"test result: ok\. 1 passed; 0 failed;", result),
            "Canonical native regression failed or was filtered out")
    path = PREPARED / "dependencies.json"
    with path.open("xb") as stream:
        stream.write(receipt.canonical_json(metadata))
    path.chmod(0o444)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("Invalid runtime preparation arguments")


def parser():
    result = Parser(description=__doc__)
    result.add_argument("--commit", required=True)
    result.add_argument("--recipe-commit", required=True)
    result.add_argument("--tag", default="")
    result.add_argument("--allowed-signers", type=Path)
    result.add_argument("--revoked-signers", type=Path)
    result.add_argument("--docker-socket", required=True)
    result.add_argument("--witness-run-id", required=True)
    result.add_argument("--fork-manifest", required=True, type=Path)
    result.add_argument("--fork-manifest-sha256", required=True)
    result.add_argument("--output", required=True)
    result.add_argument("--image-id-file", required=True, type=Path)
    return result


def main():
    try:
        if sys.argv[1:] == ["--inside-dependencies"]:
            copy_dependencies()
            return
        if sys.argv[1:] == ["--inside-prepare"]:
            inside_prepare()
            return
        prepare(parser().parse_args())
    except (ValueError, OSError, KeyError, TypeError, AttributeError, IndexError, UnicodeError, subprocess.SubprocessError, tarfile.TarError):
        raise SystemExit("Linux-amd64 runtime preparation rejected; private status retained; no publication permitted.") from None


if __name__ == "__main__":
    main()
