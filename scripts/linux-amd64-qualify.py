#!/usr/bin/env python3
"""Qualify exact exported bytes in an approved, prepared, offline native runtime."""
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid


def load_receipt():
    spec = importlib.util.spec_from_file_location("linux_amd64_receipt", Path(__file__).with_name("linux-amd64-receipt.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


receipt = load_receipt()
require = receipt.require
PREPARED = Path("/opt/omp-qualification")
# The fork-contract registry is an input, never part of this recipe. The Mac sends the workstation's fork_boundary.json
# with the build; its SHA-256 is bound into the signed qualification record. The rules below mirror the updater that
# owns the file (parse_fork_verification and its README check), strictly and without importing it.
FORK_MANIFEST_CAP = 1024 * 1024
README_MARKERS = ("<!-- stronk-omp:fork-contracts:start -->", "<!-- stronk-omp:fork-contracts:end -->")
CONTRACT_STATUSES = frozenset({"active", "retire_candidate", "retired", "deferred", "maintenance"})
SHELL_SYNTAX = ("\n", "\r", ";", "&&", "||", "|", "`", "$(", ">", "<")
STAGE_BYTES = 32768
NATIVE_GREP_TEST = "fs::tests::read_into_honours_limit_and_open_time_size"
TYPECHECK = ["bun", "run", "--cwd", "packages/coding-agent", "check:types"]
MARKERS = (
    b"requiredExtension.path", b"--oauth-account", b"--require-runtime-contract",
    b"Soft delegation nudge when value exceeds coordination cost",
    b"scoped launch requires --no-env-file before module loading", b"Duplicate status segment:",
    b"drop or block stale and optional work", b"Session runtime requirement refused execution:",
)
DISABLED_PROVIDERS = """native agents agents-md claude-md claude codex gemini github opencode
abliteration aiand aimlapi alibaba-coding-plan alibaba-token-plan amazon-bedrock anthropic apple azure
baseten bedrock-mantle cerebras charm-hyper cline-pass cloudflare-ai-gateway commandcode coreweave cursor
deepinfra deepseek devin factory-droid firepass fireworks github-copilot gitlab-duo-agent gmi-cloud google
google-antigravity google-gemini-cli google-vertex groq helmcode huggingface kilo kimi-code litellm
llama.cpp lm-studio local meta minimax minimax-cn minimax-code minimax-code-cn mistral moonshot muse-code
nanogpt novita nvidia ollama ollama-cloud openai openai-codex opencode-go opencode-zen openrouter qianfan
qwen-portal sakana siliconflow siliconflow-cn singularityapi-dev singularityapi-tech stepfun synthetic
together typesafe umans venice vercel-ai-gateway vllm wafer-serverless web xai xai-oauth xiaomi
xiaomi-token-plan-ams xiaomi-token-plan-cn xiaomi-token-plan-sgp yolo-auto zai zenmux zhipu-coding-plan""".split()

STAGES = (
    "qualify-host-inputs", "qualify-host-runtime", "qualify-host-source",
    "qualify-host-execute", "qualify-host-finalize",
    "qualify-request", "qualify-cpu", "qualify-source", "qualify-dependencies",
    "qualify-bun", "qualify-tool-views", "qualify-binary", "qualify-libc",
    "qualify-version", "qualify-help", "qualify-smoke", "qualify-offline-session",
    "qualify-markers", "qualify-native-addon", "qualify-native-grep",
    "qualify-typecheck", "qualify-integrity", "qualify-result",
)
# A failed boundary command names the tests that failed, as hyphenated lowercase words and nothing else (see failed_stages).
FAILED_PREFIX = "qualify-failed-"
FAILED_STAGE = re.compile(r"qualify-failed-[a-z0-9]+(?:-[a-z0-9]+)*")
FAILED_STAGE_CHARS = 112
FAILED_STAGE_LINES = 8
FAILED_SLUG_CHARS = 96
FAILED_TIMEOUT_STATUSES = (124, 137)  # the timeout command's own status, and its status after the kill
BUN_TIMING = re.compile(rb" \[[0-9.]+(?:ms|s)\]$")
# After the names, up to four more lines say why a test failed (see failed_reasons): a kind chosen from fixed shapes, then the base
# name and line of the first stack frame inside the source root. Message text, values and paths are never used.
FAILED_REASON_PREFIX = FAILED_PREFIX + "why-"
FAILED_REASON_CHARS = 140
FAILED_REASON_LINES = 4
FAILED_FILE_CHARS = 48
BUN_RESULT_LINES = (b"(pass) ", b"(skip) ", b"(todo) ", b"(fail) ")
BUN_TIMEOUT_NOTE = re.compile(rb"\s*\^ this test timed out after [0-9]+ms\.?\s*")
BUN_EXPECT = re.compile(rb"expect\(received\)\.(?:(resolves|rejects)\.)?(?:(not)\.)?(to[A-Za-z]{0,38})\(")
BUN_ERROR_CODE = re.compile(rb"(E[A-Z0-9]{2,15}):")
BUN_ERROR_CLASS = re.compile(rb"([A-Za-z]{0,35}Error):")
BUN_CLASS_LINE = re.compile(rb"[A-Za-z]{0,35}Error: ")
BUN_FRAME = re.compile(rb"\s+at (?:[^()]* \()?(/[^()]*):([0-9]{1,6}):[0-9]+\)?\s*")


def boundary_stage(contract, number):
    return f"qualify-boundary-{contract}-{number}"


def reason_stage(value):
    return value.startswith(FAILED_REASON_PREFIX)


def failed_stage(value):
    # A reason line may be longer than a name line, and only a line that starts with the reason prefix gets the longer limit.
    limit = FAILED_REASON_CHARS if reason_stage(value) else FAILED_STAGE_CHARS
    return len(value) <= limit and FAILED_STAGE.fullmatch(value) is not None


def valid_stage(value, boundaries=frozenset()):
    # Boundary stages come from the supplied registry, so every caller names the exact set it computed.
    # A failed-test line holds letters, digits and hyphens only: no path, dot, colon, address or other output.
    return isinstance(value, str) and (value in STAGES or value in boundaries or failed_stage(value))


def announce_stage(value, *, inside=False, boundaries=frozenset()):
    require(valid_stage(value, boundaries), "Invalid qualification stage")
    print(value, file=sys.stderr if inside else sys.stdout, flush=True)


def forward_stages(stream, boundaries=frozenset()):
    stream.seek(0)
    data = stream.read(STAGE_BYTES + 1)
    require(len(data) <= STAGE_BYTES, "Invalid qualification stages")
    lines = data.decode("ascii").splitlines(keepends=True)
    require(all(line.endswith("\n") and valid_stage(line[:-1], boundaries) for line in lines), "Invalid qualification stage")
    failed = [line[:-1] for line in lines if failed_stage(line[:-1])]
    reasons = sum(reason_stage(line) for line in failed)
    require(len(failed) - reasons <= FAILED_STAGE_LINES and reasons <= FAILED_REASON_LINES, "Invalid qualification stages")
    for line in lines:
        announce_stage(line[:-1], boundaries=boundaries)


def exact_path(value):
    """The updater's exact-relative-path rule: no glob, no absolute path, no parent step, already normalised."""
    if not isinstance(value, str) or not value.strip():
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and ".." not in path.parts and value == path.as_posix() and not any(c in value for c in "*?[")


def parse_verification(text):
    """Mirror of the updater's strict verification rule. Returns argv; nothing is run or touched."""
    require(isinstance(text, str) and bool(text.strip()), "A fork-contract verification command is empty")
    require(not any(token in text for token in SHELL_SYNTAX), "A fork-contract verification command contains shell syntax")
    try:
        argv = shlex.split(text, posix=True)
    except ValueError:
        raise receipt.RouteError("A fork-contract verification command cannot be parsed") from None
    require(len(argv) >= 3 and argv[:2] in (["bun", "test"], ["cargo", "test"]),
            "A fork-contract verification command must start with bun test or cargo test")
    for argument in argv[2:]:
        candidate = argument.split("=", 1)[1] if argument.startswith("-") and "=" in argument else argument
        require(re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:(?!:)", candidate) is None,
                "A fork-contract verification argument names an external URI")
        path = PurePosixPath(candidate)
        require(not path.is_absolute() and ".." not in path.parts,
                "A fork-contract verification argument leaves the application tree")
        if argument.startswith("-") or not argument.endswith((".ts", ".tsx")):
            continue
        require(exact_path(argument), "A fork-contract test path is not an exact relative path")
    return argv


def registry_command(command):
    """argv and relative test files of one verification command, in the one shape this recipe can run offline."""
    args = parse_verification(command)
    require(args[:2] == ["bun", "test"], "A cargo verification command cannot be run by this recipe; a new recipe commit is required")
    paths, index = [], 2
    while index < len(args):
        if args[index] == "--test-name-pattern":
            require(index + 1 < len(args) and args[index + 1], "Invalid boundary filter")
            index += 2
            continue
        require(args[index].endswith(".test.ts"),
                "A verification argument is neither a test file nor a name filter; a new recipe commit is required")
        paths.append(args[index])
        index += 1
    require(paths, "Boundary command has no tests")
    return args, paths


def parse_fork_manifest(data):
    try:
        manifest = receipt.strict_json(data)
    except (ValueError, RecursionError):
        raise receipt.RouteError("The fork manifest is not valid JSON") from None
    require(isinstance(manifest, dict) and type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 1 and
            manifest.get("requireDeclaredPaths") is False, "The fork manifest has an unsupported schema")
    readme = manifest.get("readme")
    require(isinstance(readme, dict) and exact_path(readme.get("path")) and
            (readme.get("startMarker"), readme.get("endMarker")) == README_MARKERS,
            "The fork manifest's README declaration is invalid")
    contracts = manifest.get("contracts")
    require(isinstance(contracts, list) and bool(contracts), "The fork manifest holds no contracts")
    seen = set()
    for contract in contracts:
        require(isinstance(contract, dict), "A fork contract is not an object")
        name = contract.get("id")
        require(receipt.match(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) and name not in seen, "A fork contract id is invalid or repeated")
        seen.add(name)
        status, title, verification = contract.get("status"), contract.get("title"), contract.get("verification")
        require(isinstance(status, str) and status in CONTRACT_STATUSES, f"A fork contract has an invalid status ({name})")
        require(isinstance(title, str) and bool(title.strip()), f"A fork contract has no title ({name})")
        require(isinstance(verification, list) and bool(verification), f"A fork contract declares no verification ({name})")
        if status == "active":
            for command in verification:
                try:
                    registry_command(command)
                except receipt.RouteError as error:
                    raise receipt.RouteError(f"{error} ({name})") from None
    require(bool(active_contracts(manifest)), "The fork manifest has no active contract")
    return manifest


def load_fork_manifest(path, expected_sha256=""):
    """(manifest, sha256, bytes) of the supplied registry; a missing, oversized, altered or invalid file fails closed."""
    try:
        # No link may be followed and a named pipe must never block the open; only a regular file is read.
        with open(path, "rb", opener=lambda name, flags: os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK)) as stream:
            require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "The fork manifest is missing or unreadable")
            data = stream.read(FORK_MANIFEST_CAP + 1)
    except (OSError, TypeError, ValueError):
        raise receipt.RouteError("The fork manifest is missing or unreadable") from None
    require(len(data) <= FORK_MANIFEST_CAP, "The fork manifest exceeds its size cap")
    digest = hashlib.sha256(data).hexdigest()
    require(not expected_sha256 or (receipt.match(receipt.HEX, expected_sha256) and digest == expected_sha256),
            "The fork manifest differs from its stated SHA-256")
    return parse_fork_manifest(data), digest, data


def active_contracts(manifest):
    return [contract for contract in manifest["contracts"] if contract["status"] == "active"]


def readme_block(manifest):
    start, end = README_MARKERS
    return "\n".join([start, *(f"- `{contract['id']}`: {contract['title']}" for contract in active_contracts(manifest)), end])


def check_readme(data, manifest):
    """The updater's README rule: the block between the markers is exactly the active contracts, in order."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise receipt.RouteError("The application's README is not valid UTF-8") from None
    start, end = README_MARKERS
    require(text.count(start) == 1 and text.count(end) == 1,
            "The application's README must hold exactly one fork-contract start marker and one end marker")
    first, last = text.index(start), text.index(end)
    require(last > first, "The application's README fork-contract markers are reversed")
    require(text[first:last + len(end)] == readme_block(manifest),
            "The application's fork-contract block differs from the manifest's active contracts or their order; regenerate it from the manifest")


def boundary_commands(source, manifest, *, with_stages=False):
    readme = source / manifest["readme"]["path"]
    require(readme.is_file() and readme.resolve().is_relative_to(source.resolve()), "The application's README is missing")
    check_readme(readme.read_bytes(), manifest)
    commands = []
    for contract in active_contracts(manifest):
        for number, command in enumerate(contract["verification"], 1):
            args, paths = registry_command(command)
            for relative in paths:
                path = source / relative
                require(path.is_file() and path.resolve().is_relative_to(source.resolve()),
                        f"A fork-boundary test named by the manifest is missing from the application: {relative}")
            # Preserve every registry command, including repeated files with distinct filters.
            args.append("--timeout=30000")
            commands.append((boundary_stage(contract["id"], number), args) if with_stages else args)
    return commands


def application_preflight(root, commit, manifest):
    """Refuse an application commit this recipe cannot qualify under the supplied registry, before any daemon contact."""
    version = receipt.check_toolchain(root, commit)
    readme = manifest["readme"]["path"]
    require(receipt.git_has(root, commit, readme), "The application commit has no README for its fork contracts")
    check_readme(receipt.git_bytes(root, commit, readme), manifest)
    contracts = active_contracts(manifest)
    for contract in contracts:
        for command in contract["verification"]:
            for relative in registry_command(command)[1]:
                require(receipt.git_has(root, commit, relative),
                        f"A fork-boundary test named by the manifest is missing from the application: {relative}")
    return version, len(contracts)


def docker_output(docker, args, timeout=30):
    return subprocess.check_output(docker + args, stderr=subprocess.DEVNULL, timeout=timeout).decode().strip()


def approved_daemon(docker, image):
    require(receipt.match(receipt.IMAGE, image) or receipt.match(receipt.DIGEST, image),
            "Immutable runtime image is required")
    # No general daemon info, endpoint enumeration, context inspection, or inventory.
    require(docker_output(docker, ["info", "--format", "{{.Architecture}}"]) in ("x86_64", "amd64"),
            "Native amd64 daemon is required")
    require(docker_output(docker, ["image", "inspect", "--format", "{{.Architecture}}", image]) == "amd64",
            "Prepared local amd64 image is required")
    if receipt.match(receipt.DIGEST, image):
        require(docker_output(docker, ["image", "inspect", "--format", "{{.Id}}", image]) == image,
                "Prepared local image ID differs")
        return image
    repository, image_digest = image.rsplit("@", 1)
    reference = repository.split(":", 1)[0] + "@" + image_digest
    template = "{{range .RepoDigests}}{{if eq . " + json.dumps(reference) + "}}verified{{end}}{{end}}"
    require(docker_output(docker, ["image", "inspect", "--format", template, image]) == "verified",
            "Prepared image digest differs")
    return image_digest


def container_command(docker, image, directory, name, witness_run_id=""):
    command = docker + [
        "run", "--rm", "--name", name, "--pull=never", "--network=none", "--read-only",
        "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=1024",
        "--memory=12g", "--memory-swap=12g", "--cpus=4", "--user=65532:65532",
        "--hostname=qualification", "--workdir=/workspace", "--log-driver=none", "--ulimit=nofile=4096:4096",
        "--ulimit=fsize=1073741824:1073741824", "--shm-size=256m",
    ]
    command += receipt.witness_label(witness_run_id)
    for destination, size in (("/workspace", "8g"), ("/runtime", "1g"), ("/home/qualification", "1g"), ("/tmp", "2g")):
        execution = ",exec" if destination in ("/workspace", "/runtime") else ""
        command += ["--tmpfs", f"{destination}:rw{execution},nosuid,nodev,size={size},mode=1777"]
    for child, destination in (("source", "/input/source"), ("input", "/input/assets"), ("recipe", "/recipe")):
        path = directory / child
        require("," not in str(path), "Unsupported mount path")
        command += ["--mount", f"type=bind,src={path},dst={destination},readonly"]
    return command + ["--entrypoint=/bin/sh", image, "/recipe/linux-amd64-smoke.sh"]


def export_source(root, commit, destination):
    archive = subprocess.check_output(["git", "-C", str(root), "archive", "--format=tar", commit], stderr=subprocess.DEVNULL)
    destination.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(destination, filter="data")
    # The data filter leaves directory modes to the host's potentially private umask.
    destination.chmod(0o755)
    for directory, directories, files in os.walk(destination, followlinks=False):
        parent = Path(directory)
        for name in directories:
            child = parent / name
            if stat.S_ISDIR(child.lstat().st_mode):
                child.chmod(0o755, follow_symlinks=False)
        for name in files:
            child = parent / name
            mode = child.lstat().st_mode
            if stat.S_ISREG(mode):
                child.chmod((stat.S_IMODE(mode) | 0o444) & ~0o022, follow_symlinks=False)


def validate_result(result, manifest, image, fork_manifest_sha256):
    receipt.keys(result, ("binary_sha256", "source_commit", "recipe_commit", "fork_manifest_sha256", "environment", "checks"))
    require(result["binary_sha256"] == manifest["asset"]["sha256"] and
            result["source_commit"] == manifest["source"]["commit"] and
            result["recipe_commit"] == manifest["source"]["recipe_commit"], "Qualified tuple differs")
    require(receipt.match(receipt.HEX, fork_manifest_sha256) and result["fork_manifest_sha256"] == fork_manifest_sha256,
            "Qualified fork manifest differs")
    require(result["checks"] == {check: "passed" for check in receipt.CHECKS}, "Qualification checks are incomplete")
    environment = result["environment"]
    receipt.keys(environment, ("execution", "cpu", "glibc", "loader", "runtime_image"))
    require(environment["execution"] == "native-amd64" and environment["cpu"] == "x86-64-v2" and
            environment["loader"] == "ld-linux-x86-64.so.2" and receipt.match(receipt.DIGEST, image) and
            environment["runtime_image"] == image and
            receipt.match(r"[0-9]+(?:\.[0-9]+)+", environment["glibc"]), "Invalid qualified baseline")
    for observation in (manifest["runtime"]["binary"], manifest["runtime"]["native_baseline"]["elf"]):
        floor = observation["glibc_required"]
        require(floor is not None and version_tuple(environment["glibc"]) >= version_tuple(floor), "Insufficient qualified libc")


def version_tuple(value):
    return tuple(map(int, value.split(".")))


def attestation_output(directory, key, output):
    require(key.is_file() and not key.is_symlink() and key.suffix != ".pub",
            "An explicit private attestation key is required")
    require(not output.resolve().is_relative_to(directory.resolve()) and output.parent.is_dir(),
            "Attestation must stay outside the public asset directory")
    for path in (output, Path(str(output) + ".sig")):
        require(not path.exists() and not path.is_symlink(), "Qualification evidence already exists")


def sign_attestation(manifest, key, output, fork_manifest_sha256):
    data = receipt.attestation_bytes(manifest, fork_manifest_sha256)
    environment = os.environ.copy()
    for name in ("SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_ASKPASS"):
        environment.pop(name, None)
    environment["SSH_ASKPASS_REQUIRE"] = "never"
    signed = subprocess.run(
        ["ssh-keygen", "-Y", "sign", "-f", str(key), "-n", receipt.ATTESTATION_NAMESPACE],
        input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment, timeout=60, check=True)
    require(signed.stdout.startswith(b"-----BEGIN SSH SIGNATURE-----\n"), "Missing qualification signature")
    for path, content in ((output, data), (Path(str(output) + ".sig"), signed.stdout)):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)


def finalize(directory, before, result, image, root, commit, recipe_commit, attestation_key, attestation, *, fork_manifest_sha256):
    # Recheck the actual host bytes and complete tuple after execution, not just
    # the copied binary or metadata returned by the runtime.
    after = receipt.verify(directory, commit, before["source"]["tag"] or "", False, recipe_commit, root)
    require(after == before, "Assets changed during qualification")
    validate_result(result, before, image, fork_manifest_sha256)
    complete = copy.deepcopy(before)
    complete["checks"] = dict(result["checks"])
    # The container echoes the registry hash it ran against; only the private signed record keeps it. The public manifest
    # keeps the fleet puller's exact qualification fields.
    complete["qualification"] = {name: value for name, value in result.items() if name != "fork_manifest_sha256"}
    receipt.save_manifest(directory, complete)
    receipt.verify(directory, commit, before["source"]["tag"] or "", False, recipe_commit, root)
    attestation_output(directory, attestation_key, attestation)
    sign_attestation(complete, attestation_key, attestation, fork_manifest_sha256)


def qualify(args, root=None):
    announce_stage("qualify-host-inputs")
    root = root or Path(__file__).resolve().parent.parent
    require(receipt.match(receipt.OID, args.commit), "A full application commit is required")
    require(receipt.match(receipt.IMAGE, args.runtime_image) or receipt.match(receipt.DIGEST, args.runtime_image),
            "Immutable runtime image is required")
    require(receipt.match(receipt.HEX, args.fork_manifest_sha256), "A fork manifest SHA-256 is required")
    fork, fork_sha, fork_data = load_fork_manifest(args.fork_manifest, args.fork_manifest_sha256)
    receipt.witness_label(getattr(args, "witness_run_id", ""))
    directory = args.assets
    require(directory.is_dir() and not directory.is_symlink() and
            (directory / receipt.ASSETS[1]).is_file() and not (directory / receipt.ASSETS[1]).is_symlink(),
            "Regular public assets are required")
    initial = receipt.strict_json((directory / receipt.ASSETS[1]).read_text())
    tag = initial["source"]["tag"] or ""
    before = receipt.verify(directory, args.commit, tag, False, args.recipe_commit, root)
    for name in receipt.RECIPES:
        path = root / "scripts" / name
        require(path.is_file() and not path.is_symlink() and
                receipt.digest(path) == before["build_inputs"]["recipe"][name], "Invoked recipe differs")
    if args.recipe_commit:
        receipt.assert_recipes(root, args.recipe_commit)
    else:
        require(not before["source"]["recipe_committed"], "Candidate recipe identity differs")
    attestation_output(directory, args.attestation_key, args.attestation)
    # Transport validation runs before any subprocess capable of daemon contact.
    docker = receipt.validate_docker(args.docker_socket)
    with tempfile.TemporaryDirectory(prefix="omp-qualification-") as temporary:
        work = Path(temporary)
        work.chmod(0o755)
        # Explicit empty client configuration also excludes host credential helpers.
        client_config = work / "docker-client"
        client_config.mkdir(mode=0o700)
        docker += ["--config", str(client_config)]
        announce_stage("qualify-host-runtime")
        image_digest = approved_daemon(docker, args.runtime_image)
        announce_stage("qualify-host-source")
        export_source(root, args.commit, work / "source")
        known = frozenset(name for name, _ in boundary_commands(work / "source", fork, with_stages=True))
        inputs, recipes = work / "input", work / "recipe"
        inputs.mkdir(mode=0o755)
        recipes.mkdir(mode=0o755)
        inputs.chmod(0o755)
        recipes.chmod(0o755)
        shutil.copyfile(directory / receipt.ASSETS[0], inputs / receipt.ASSETS[0])
        (inputs / receipt.ASSETS[0]).chmod(0o555)
        require(receipt.digest(inputs / receipt.ASSETS[0]) == before["asset"]["sha256"], "Copied binary differs")
        (inputs / "request.json").write_text(json.dumps({"manifest": before, "runtime_image": image_digest,
                                                         "fork_manifest_sha256": fork_sha}))
        (inputs / "request.json").chmod(0o444)
        (inputs / "fork_boundary.json").write_bytes(fork_data)
        (inputs / "fork_boundary.json").chmod(0o444)
        for name in ("linux-amd64-receipt.py", "linux-amd64-qualify.py", "linux-amd64-smoke.sh"):
            data = receipt.git_bytes(root, args.recipe_commit, f"scripts/{name}") if args.recipe_commit else (root / "scripts" / name).read_bytes()
            require(hashlib.sha256(data).hexdigest() == before["build_inputs"]["recipe"][name], "Invoked recipe differs")
            (recipes / name).write_bytes(data)
            (recipes / name).chmod(0o444)
        run_id = getattr(args, "witness_run_id", "")
        # A run-scoped fixed name lets a supervisor prove removal; a one-off run keeps a random name.
        name = f"omp-build-{run_id}-qualify" if run_id else "omp-qualification-" + uuid.uuid4().hex
        try:
            command = container_command(docker, args.runtime_image, work, name, getattr(args, "witness_run_id", ""))
            announce_stage("qualify-host-execute")
            with tempfile.TemporaryFile() as stages:
                try:
                    output = subprocess.check_output(command, stderr=stages, timeout=3600)
                finally:
                    forward_stages(stages, known)
            require(len(output) <= 8192, "Invalid runtime summary")
            result = receipt.strict_json(output)
        finally:
            # A client timeout must not leave workers or runtime state alive.
            subprocess.run(docker + ["rm", "--force", name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30, check=False)
        announce_stage("qualify-host-finalize")
        finalize(directory, before, result, image_digest, root, args.commit, args.recipe_commit,
                 args.attestation_key, args.attestation, fork_manifest_sha256=fork_sha)


class Runtime:
    """Keep all command diagnostics in disposable private runtime files."""
    def __init__(self, environment):
        self.environment = environment
        self.sequence = 0

    def execute(self, args, cwd, seconds, stdin):
        """Run one command under `timeout`, its output going to two private files. Returns (status, (stdout path, stderr path))."""
        self.sequence += 1
        prefix = Path("/runtime") / f"command-{self.sequence}"
        paths = (prefix.with_suffix(".out"), prefix.with_suffix(".err"))
        with paths[0].open("wb") as out, paths[1].open("wb") as err:
            completed = subprocess.run(["timeout", "--signal=TERM", "--kill-after=5s", f"{seconds}s", *map(str, args)],
                                       cwd=cwd, env=self.environment, input=stdin, stdout=out, stderr=err, timeout=seconds + 15)
        return completed.returncode, paths

    @staticmethod
    def read(paths):
        require(all(path.stat().st_size <= 8 * 1024 * 1024 for path in paths), "Runtime diagnostic limit exceeded")
        return tuple(path.read_bytes() for path in paths)

    def run(self, args, cwd, seconds=240, stdin=b""):
        status, paths = self.execute(args, cwd, seconds, stdin)
        require(status == 0, "Runtime check failed")
        return self.read(paths)

    def run_unchecked(self, args, cwd, seconds=240, stdin=b""):
        """Like run, but a non-zero exit status comes back with the output, so the caller can name what failed first."""
        status, paths = self.execute(args, cwd, seconds, stdin)
        return (status, *self.read(paths))


def boundary_passed(status, combined):
    """A boundary command passes only with exit status 0, at least one passing test and no failing one."""
    return (status == 0 and re.search(rb"\b[1-9][0-9]* pass\b", combined) is not None and
            re.search(rb"\b[1-9][0-9]* fail\b", combined) is None)


def failed_name(line):
    """The name in one Bun `(fail) <describe > test> [12.34ms]` line: lowercase letters and digits with single hyphens, at most 96 characters."""
    name = BUN_TIMING.sub(b"", line[len(b"(fail) "):].rstrip(b"\r")).lower()
    slug = re.sub(rb"[^a-z0-9]+", b"-", name).strip(b"-")
    if slug == b"why" or slug.startswith(b"why-"):
        slug = b"test-" + slug  # a test name never poses as a reason line
    return slug[:FAILED_SLUG_CHARS].strip(b"-").decode("ascii")


def failed_stages(status, combined):
    """Up to eight `qualify-failed-<name>` stage lines for one failed boundary command: test names only, never output text.

    One line per Bun `(fail) ` line, in order and without repeats; an empty name is skipped. A timeout (the timeout command's
    own status, 124, or 137 after the kill) is announced first, so the cap can never hide it. A failure that named no test is
    announced as `no-test-name`."""
    names = []
    for line in combined.split(b"\n"):
        if line.startswith(b"(fail) "):
            name = failed_name(line)
            if name and name not in names:
                names.append(name)
    words = ["timeout"] if status in FAILED_TIMEOUT_STATUSES else []
    words += [name for name in names if name not in words]
    if not names:
        words.append("no-test-name")
    return [FAILED_PREFIX + word for word in words[:FAILED_STAGE_LINES]]


def failure_header(block):
    """(index, message) of the first Bun error header in a failure block: `error: <message>`, or the bare `<Name>Error: <message>`
    that Bun 1.4.2 prints for every error class except Error itself. Nothing else decides the kind."""
    for index, line in enumerate(block):
        line = line.rstrip(b"\r")
        if line.startswith(b"error: "):
            return index, line[len(b"error: "):]
        if BUN_CLASS_LINE.match(line):
            return index, line
    return None


def failure_kind(message):
    """One of a fixed set of shapes, in this order: `expect-[resolves-|rejects-][not-]<matcher>`, an error code (`eacces`), an
    error class (`typeerror`), `timeout`, `error`. Each is lowercase letters and digits; a name over its limit is not shortened,
    it just falls through to the next shape."""
    found = BUN_EXPECT.match(message)
    if found:
        modifiers = [part.decode() for part in found.group(1, 2) if part]
        return "-".join(["expect", *modifiers, found[3].lower().decode()])
    found = BUN_ERROR_CODE.match(message) or BUN_ERROR_CLASS.match(message)
    if found:
        return found[1].lower().decode()
    lowered = message.lower()
    return "timeout" if b"timed out" in lowered or b"timeout" in lowered else "error"


def failure_location(lines, root):
    """(file, line) of the first stack frame inside `root`: the base name as a slug of at most 48 characters, and the line number.

    Frames outside the root, with a `..` step, with an empty slug or with a line over six digits are skipped."""
    for line in lines:
        found = BUN_FRAME.fullmatch(line.rstrip(b"\r"))
        if found is None or not found[1].startswith(root) or b".." in found[1].split(b"/"):
            continue
        base = re.sub(rb"[^a-z0-9]+", b"-", found[1].rsplit(b"/", 1)[1].lower()).strip(b"-")[:FAILED_FILE_CHARS].strip(b"-")
        if base:
            return base.decode("ascii"), int(found[2])
    return None


def failure_reason(block, note, root):
    """One `qualify-failed-why-` line for one failed test, or None when it cannot be made a valid stage line.

    `block` is the output after the previous test result line, up to this test's `(fail) ` line; `note` is the line right after
    that `(fail) ` line. Bun prints a per-test timeout as `  ^ this test timed out after 100ms.` there, and prints no error."""
    header = failure_header(block)
    if BUN_TIMEOUT_NOTE.fullmatch(note):
        words = ["timeout"]
    elif header is None:
        words = ["no-error-line"]
    else:
        index, message = header
        words = [failure_kind(message)]
        where = failure_location(block[index + 1:], root)
        if where is not None:
            words += ["at", where[0], str(where[1])]
    line = FAILED_REASON_PREFIX + "-".join(words)
    return line if failed_stage(line) else None


def failed_reasons(combined, source):
    """Up to four `qualify-failed-why-<kind>[-at-<file>-<line>]` lines for one failed boundary command, one per distinct reason.

    Bun prints a failure's error header and stack before its `(fail) ` line, so a failure's block starts after the previous
    test result line (pass, skip, todo or fail). The location is the first frame inside `source`: only the base file name and the
    line number are used. No `(fail) ` line, no reason."""
    root = str(source).rstrip("/").encode() + b"/"
    lines = combined.split(b"\n")
    reasons, start = [], 0
    for index, line in enumerate(lines):
        if not line.startswith(BUN_RESULT_LINES):
            continue
        if line.startswith(b"(fail) "):
            reason = failure_reason(lines[start:index], lines[index + 1] if index + 1 < len(lines) else b"", root)
            if reason is not None and reason not in reasons:
                reasons.append(reason)
                if len(reasons) == FAILED_REASON_LINES:
                    break
        start = index + 1
    return reasons


def dependency_roots(source):
    roots = []
    for directory, children, _files in os.walk(source, followlinks=False):
        children.sort()
        if "node_modules" in children:
            require(not (Path(directory) / "node_modules").is_symlink(), "Prepared module root must be a directory")
            roots.append(Path(directory) / "node_modules")
            children.remove("node_modules")
    require(roots, "Prepared dependency tree is missing")
    return roots


def dependency_digest(source):
    result = hashlib.sha256()
    for root in dependency_roots(source):
        for path in [root, *sorted(root.rglob("*"))]:
            relative = path.relative_to(source).as_posix()
            if path.is_symlink():
                target = os.readlink(path)
                require(not Path(target).is_absolute() and path.resolve().is_relative_to(source.resolve()), "Unsafe prepared dependency link")
                value = "link:" + target
            elif path.is_file():
                value = "file:" + receipt.digest(path)
            else:
                require(path.is_dir(), "Invalid prepared dependency entry")
                value = "directory"
            result.update((json.dumps([relative, value], ensure_ascii=True) + "\n").encode())
    return result.hexdigest()


def prepare_dependencies(source, manifest, runtime):
    announce_stage("qualify-dependencies", inside=True)
    prepared_source = PREPARED / "source"
    metadata = receipt.strict_json((PREPARED / "dependencies.json").read_text())
    receipt.keys(metadata, ("schema", "source_commit", "bun_version", "locks", "dependency_tree_sha256", "native_grep_sha256"))
    require(type(metadata["schema"]) is int and metadata["schema"] == 1 and metadata["source_commit"] == manifest["source"]["commit"] and
            metadata["bun_version"] == receipt.BUN_VERSION and metadata["locks"] == manifest["build_inputs"]["locks"], "Prepared dependency identity differs")
    require(all(receipt.digest(prepared_source / lock) == value for lock, value in metadata["locks"].items()), "Prepared locks differ")
    require(metadata["dependency_tree_sha256"] == dependency_digest(prepared_source), "Prepared dependency bytes differ")
    grep = PREPARED / "native-grep-regression"
    require(not grep.is_symlink() and grep.is_file() and metadata["native_grep_sha256"] == receipt.digest(grep), "Prepared native regression differs")
    require(receipt.elf(grep)["interpreter"] == "ld-linux-x86-64.so.2", "Native regression must be a GNU amd64 executable")
    bun = shutil.which("bun", path=runtime.environment["PATH"])
    require(bun is not None and receipt.digest(Path(bun).resolve()) == manifest["build_inputs"]["host_tools"]["bun"]["sha256"],
            "Prepared Bun bytes differ from the pinned build runtime")
    announce_stage("qualify-bun", inside=True)
    version, _ = runtime.run(["bun", "--version"], source, 30)
    require(version == f"{receipt.BUN_VERSION}\n".encode(), "Pinned Bun runtime is required")
    for root in dependency_roots(prepared_source):
        destination = source / root.relative_to(prepared_source)
        require(not destination.exists() and not destination.is_symlink(), "Source contains unexpected dependencies")
        shutil.copytree(root, destination, symlinks=True)
    # Relative workspace links now resolve into the immutable exported source,
    # not into a possibly different source tree prepared inside the image.
    require(dependency_digest(source) == metadata["dependency_tree_sha256"], "Copied dependency bytes differ")
    # The pristine export excludes this generated input required by CLI compile tests.
    announce_stage("qualify-tool-views", inside=True)
    runtime.run(["bun", "run", "--cwd", "packages/collab-web", "gen:tool-views"], source, 120)
    return grep


def baseline_cpu(machine, flags):
    require(machine == "x86_64", "In-container native amd64 execution is required")
    required = {"ssse3", "sse4_1", "sse4_2", "popcnt", "cx16", "lahf_lm"}
    require(required <= flags and bool({"pni", "sse3"} & flags), "CPU is below x86-64-v2")
    # AVX2 is deliberately irrelevant: the shipped embedded set is baseline only.


def native_help(stdout, stderr, native_dir, manifest):
    native = native_dir / "pi_natives.linux-x64-baseline.node"
    lines = stderr.splitlines()
    requires = [line for line in lines if line.startswith(b"[startup] native:require:")]
    require(requires == [b"[startup] native:require:pi_natives.linux-x64-baseline.node"] and
            b"[startup] native:extractEmbeddedAddon:start" in lines and b"[startup] native:loadNative:done" in lines,
            "Baseline extraction or loading failed")
    require(native.is_file() and not native.is_symlink() and
            not (native_dir / "pi_natives.linux-x64-modern.node").exists(), "Wrong embedded native set")
    require(receipt.digest(native) == manifest["runtime"]["native_baseline"]["sha256"] and
            receipt.elf(native) == manifest["runtime"]["native_baseline"]["elf"], "Extracted native bytes or ABI differ")
    require(all(marker in stdout for marker in (b"--oauth-account=", b"--require-runtime-contract=", b"runtime-requirements: 1")),
            "Fork help behavior differs")
    return native


def require_markers(binary):
    pending = set(MARKERS)
    overlap = b""
    with binary.open("rb") as stream:
        while pending:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            data = overlap + chunk
            pending = {marker for marker in pending if marker not in data}
            overlap = data[-max(map(len, MARKERS)):]
    require(not pending, "Required fork marker is absent")


def offline_session(runtime, binary, cwd, agent):
    (agent / "models.yml").write_text("""providers:
  offline-smoke:
    baseUrl: https://offline-qualification.invalid/v1
    api: openai-completions
    auth: none
    models:
      - id: offline
        name: Offline qualification
        contextWindow: 32768
        maxTokens: 1024
        reasoning: false
        input: [text]
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
""")
    (agent / "config.yml").write_text("enabledProviders: [offline-smoke]\ndisabledProviders:\n" +
                                      "".join(f"  - {name}\n" for name in DISABLED_PROVIDERS) +
                                      "mcp:\n  enableProjectConfig: false\n")
    output, error = runtime.run([binary, "--mode", "rpc", "--no-ui", "--no-session", "--model", "offline-smoke/offline",
                                 "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp", "--no-title"],
                                cwd, 90, b'{"id":"smoke-state","type":"get_available_models"}\n')
    messages = [receipt.strict_json(line) for line in output.splitlines() if line.strip()]
    require(any(message.get("type") == "ready" for message in messages), "Session did not initialize")
    responses = [message for message in messages if message.get("id") == "smoke-state"]
    require(len(responses) == 1 and responses[0].get("type") == "response" and
            responses[0].get("command") == "get_available_models" and responses[0].get("success") is True and
            '"provider": "offline-smoke"' in json.dumps(responses[0]) and
            b"[startup] createAgentSession:done" in error.splitlines(), "Initialized offline session failed")


def runtime_main():
    announce_stage("qualify-request", inside=True)
    request = receipt.strict_json(Path("/input/assets/request.json").read_text())
    receipt.keys(request, ("manifest", "runtime_image", "fork_manifest_sha256"))
    manifest, image = request["manifest"], request["runtime_image"]
    require(receipt.match(receipt.OID, manifest["source"]["commit"]) and receipt.match(receipt.DIGEST, image) and
            receipt.match(receipt.HEX, request["fork_manifest_sha256"]), "Wrong runtime request")
    fork, fork_sha, _ = load_fork_manifest(Path("/input/assets/fork_boundary.json"), request["fork_manifest_sha256"])
    announce_stage("qualify-cpu", inside=True)
    # Inspect architecture and CPU flags only, never host/network identity.
    flags = re.findall(r"^flags\s*:\s*(.*)$", Path("/proc/cpuinfo").read_text(), re.MULTILINE)
    require(flags, "CPU baseline is unavailable")
    for value in flags:
        baseline_cpu(os.uname().machine, set(value.split()))
    base = Path("/runtime")
    # The native loader honors XDG only when its omp namespace already exists.
    for child in ("agent", "data/omp", "state", "cache/bun", "config", "run", "tmp", "session/cwd", "session/.git/objects", "session/.git/refs/heads", "session/.jj/repo"):
        (base / child).mkdir(parents=True, exist_ok=True)
    (base / "session/.git/HEAD").write_text("ref: refs/heads/offline-smoke\n")
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/qualification", "LANG": "C", "LC_ALL": "C", "TZ": "UTC",
        "PI_CODING_AGENT_DIR": str(base / "agent"), "XDG_DATA_HOME": str(base / "data"), "XDG_STATE_HOME": str(base / "state"),
        "XDG_CACHE_HOME": str(base / "cache"), "XDG_CONFIG_HOME": str(base / "config"), "XDG_RUNTIME_DIR": str(base / "run"),
        "TMPDIR": str(base / "tmp"), "TMP": str(base / "tmp"), "TEMP": str(base / "tmp"),
        "BUN_INSTALL_CACHE_DIR": str(base / "cache/bun"), "BUN_RUNTIME_TRANSPILER_CACHE_PATH": str(base / "cache/bun/transpiler"),
        "USER": "qualification", "LOGNAME": "qualification", "SHELL": "/bin/sh", "TERM": "dumb", "NO_COLOR": "1", "PI_DEBUG_STARTUP": "1",
    }
    runtime = Runtime(environment)
    announce_stage("qualify-source", inside=True)
    source = Path("/workspace/source")
    shutil.copytree("/input/source", source, symlinks=True)
    require({name: receipt.digest(source / name) for name in receipt.LOCKS} == manifest["build_inputs"]["locks"], "Runtime source locks differ")
    require(receipt.strict_json((source / "packages/coding-agent/package.json").read_text())["version"] == manifest["version"], "Runtime source version differs")
    commands = boundary_commands(source, fork, with_stages=True)
    known = frozenset(name for name, _ in commands)
    grep = prepare_dependencies(source, manifest, runtime)
    announce_stage("qualify-binary", inside=True)
    binary = Path("/workspace/omp")
    shutil.copyfile("/input/assets/omp-linux-amd64", binary)
    binary.chmod(0o500)
    require(receipt.digest(binary) == manifest["asset"]["sha256"] and receipt.elf(binary) == manifest["runtime"]["binary"], "Runtime binary bytes or ABI differ")
    announce_stage("qualify-libc", inside=True)
    libc_out, _ = runtime.run(["getconf", "GNU_LIBC_VERSION"], source, 30)
    libc_match = re.fullmatch(rb"glibc ([0-9]+(?:\.[0-9]+)+)\n", libc_out)
    require(libc_match is not None, "GNU libc is required")
    libc = libc_match[1].decode()
    cwd = base / "session/cwd"
    announce_stage("qualify-version", inside=True)
    output, _ = runtime.run([binary, "--version"], cwd, 30)
    require(output == f"omp/{manifest['version']}\n".encode(), "Binary version behavior differs")
    announce_stage("qualify-help", inside=True)
    output, error = runtime.run([binary, "--help"], cwd, 60)
    native = native_help(output, error, base / "data/omp/natives" / manifest["version"], manifest)
    announce_stage("qualify-smoke", inside=True)
    output, _ = runtime.run([binary, "--smoke-test"], cwd, 180)
    require(output == b"smoke-test: ok\n", "Native resource and worker smoke failed")
    announce_stage("qualify-offline-session", inside=True)
    offline_session(runtime, binary, cwd, base / "agent")
    announce_stage("qualify-markers", inside=True)
    require_markers(binary)
    announce_stage("qualify-native-addon", inside=True)
    native_destination = source / "packages/natives/native/pi_natives.linux-x64-baseline.node"
    native_destination.parent.mkdir(parents=True, exist_ok=True)
    require(not native_destination.exists() and not native_destination.is_symlink(), "Source contains unexpected native addon")
    shutil.copyfile(native, native_destination)
    # Match the pinned application's scripts/ci-test-ts.ts child-test environment. The tests start from an empty agent
    # dir of their own: the offline session's config (only its fake provider enabled, every real one disabled) stays in
    # its dir, or every test that resolves a provider key through the default settings finds none.
    boundary_agent = base / "boundary-agent"
    boundary_agent.mkdir()
    runtime.environment.update({
        "PI_TEST_RUNTIME": "1", "BUN_JSC_useConcurrentGC": "0", "BUN_JSC_numberOfGCMarkers": "1",
        "PI_CODING_AGENT_DIR": str(boundary_agent),
    })
    for stage, command in commands:
        announce_stage(stage, inside=True, boundaries=known)
        status, output, error = runtime.run_unchecked(command, source)
        combined = output + b"\n" + error
        passed = boundary_passed(status, combined)
        if not passed:
            # Test names, then why each failed (kind, file, line), on the stage channel before failing closed; the output itself
            # stays in the private files.
            for line in (*failed_stages(status, combined), *failed_reasons(combined, source)):
                announce_stage(line, inside=True, boundaries=known)
        require(passed, "Boundary command failed or ran no passing tests")
    announce_stage("qualify-native-grep", inside=True)
    grep_source = (source / "crates/pi-walker/src/fs/tests.rs").read_text()
    require(re.search(r"(?m)^\s*(?:async\s+)?fn\s+" + NATIVE_GREP_TEST.rsplit("::", 1)[1] + r"\s*\(", grep_source), "Canonical native regression is missing")
    output, _ = runtime.run([grep, NATIVE_GREP_TEST, "--exact"], source)
    require(re.search(rb"(?m)^running 1 test$", output) and
            re.search(rb"test result: ok\. 1 passed; 0 failed;", output), "Canonical native regression failed or was filtered out")
    announce_stage("qualify-typecheck", inside=True)
    runtime.run(TYPECHECK, source, 300)
    announce_stage("qualify-integrity", inside=True)
    require(receipt.digest(binary) == manifest["asset"]["sha256"] and
            receipt.digest(native) == manifest["runtime"]["native_baseline"]["sha256"] and
            receipt.digest(native_destination) == manifest["runtime"]["native_baseline"]["sha256"], "Qualified runtime bytes changed")
    announce_stage("qualify-result", inside=True)
    result = {
        "binary_sha256": receipt.digest(binary), "source_commit": manifest["source"]["commit"],
        "recipe_commit": manifest["source"]["recipe_commit"], "fork_manifest_sha256": fork_sha,
        "environment": {"execution": "native-amd64", "cpu": "x86-64-v2", "glibc": libc,
                        "loader": "ld-linux-x86-64.so.2", "runtime_image": image},
        "checks": {name: "passed" for name in receipt.CHECKS},
    }
    validate_result(result, manifest, image, fork_sha)
    print(json.dumps(result, sort_keys=True))


class PublicParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("Invalid qualification arguments")


def parser():
    result = PublicParser(description=__doc__)
    result.add_argument("--commit", required=True)
    result.add_argument("--recipe-commit", default="")
    result.add_argument("--assets", required=True, type=Path)
    result.add_argument("--runtime-image", required=True)
    result.add_argument("--docker-socket", required=True)
    result.add_argument("--attestation-key", required=True, type=Path)
    result.add_argument("--attestation", required=True, type=Path)
    result.add_argument("--witness-run-id", default="")
    result.add_argument("--fork-manifest", required=True, type=Path)
    result.add_argument("--fork-manifest-sha256", required=True)
    return result


def main():
    try:
        if sys.argv[1:] == ["--inside"]:
            runtime_main()
            return
        qualify(parser().parse_args())
        print("Linux-amd64 qualification passed; exact public assets finalized.")
    except (ValueError, OSError, KeyError, TypeError, AttributeError, IndexError, subprocess.SubprocessError, tarfile.TarError):
        if sys.argv[1:] == ["--inside"]:
            raise SystemExit(1) from None
        # No paths, command output, environment values, or input documents escape.
        raise SystemExit("Linux-amd64 qualification rejected; publication is not permitted.") from None


if __name__ == "__main__":
    main()
