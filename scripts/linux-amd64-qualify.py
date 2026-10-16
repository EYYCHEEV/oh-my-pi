#!/usr/bin/env python3
"""Qualify exact exported bytes in an approved, prepared, offline native runtime."""
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
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
REGISTRY_SHA256 = "40d36904b1bc31a09381c2fa2b523ea481aa8691801abf80344af18e6227f943"
# Reviewed active verification snapshot of the workstation-owned fork registry.
# The recipe commit authenticates this snapshot. Immutable application README IDs
# and every referenced source file must agree before any command can run.
BOUNDARIES = {
    "required-extension-enforcement": [
        "bun test packages/coding-agent/test/required-extension-gate.test.ts packages/coding-agent/test/sdk-preloaded-extensions-isolation.test.ts packages/coding-agent/test/task/executor-pass-through.test.ts packages/coding-agent/test/acp-mcp-isolation.test.ts packages/coding-agent/test/settings-manager.test.ts packages/coding-agent/test/extensibility/legacy-pi-default-resource-loader.test.ts"],
    "terminal-eintr-recovery": [
        "bun test packages/tui/test/process-terminal-input-recovery.test.ts --test-name-pattern 'reopens a Bun-destroyed TTY read stream and delivers the next input'",
        "bun test packages/tui/test/process-terminal-input-recovery.test.ts --test-name-pattern 'keeps an active input drain on the replacement stream'",
        "bun test packages/tui/test/process-terminal-input-recovery.test.ts --test-name-pattern 'keeps unrelated stdin errors fatal'",
        "bun test packages/utils/test/postmortem-cleanup-error.test.ts --test-name-pattern 'keeps unmarked uncaught exceptions fatal'",
        "bun test packages/utils/test/postmortem-cleanup-error.test.ts --test-name-pattern 'keeps uncaught read EINTR fatal outside its owner'"],
    "shared-worker-ownership": [
        "bun test packages/coding-agent/test/agent-session-shared-worker-ownership.test.ts --test-name-pattern 'does not terminate process-global workers when a parked subagent disposes'",
        "bun test packages/coding-agent/test/agent-session-shared-worker-ownership.test.ts --test-name-pattern 'terminates process-global workers when their primary owner disposes'"],
    "subagent-policy-inheritance": [
        "bun test packages/coding-agent/test/task/structured-subagent.test.ts packages/coding-agent/test/task/executor-pass-through.test.ts packages/coding-agent/test/vibe/vibe-runtime.test.ts"],
    "turn-status-lifecycle": [
        "bun test packages/coding-agent/test/agent-session-concurrent.test.ts packages/coding-agent/test/extensions-runner.test.ts packages/coding-agent/test/rpc-subagents.test.ts packages/coding-agent/test/rpc-wire/generated.test.ts"],
    "status-line-extension-state": [
        "bun test packages/coding-agent/test/modes/controllers/extension-ui-controller.test.ts packages/coding-agent/test/collab/guest-ui-request.test.ts packages/coding-agent/test/tools/ask.test.ts packages/coding-agent/test/status-line-extension-segments.test.ts packages/coding-agent/test/status-line-settings-cache.test.ts packages/coding-agent/test/status-line-overflow.test.ts packages/coding-agent/test/status-line-dispose-async-leak.test.ts"],
    "goal-objective-skill-picker": ["bun test packages/coding-agent/test/hook-editor.test.ts"],
    "tool-call-abort-signal": [
        "bun test packages/coding-agent/test/extensions-runner.test.ts --test-name-pattern 'passes the caller abort signal to the awaited extension gate'",
        "bun test packages/coding-agent/test/agent-session-message-pipeline.test.ts --test-name-pattern 'forwards the caller signal and input revision through the primary tool-call path'"],
    "mcp-image-forwarding": ["bun test packages/coding-agent/test/mcp-image-results.test.ts"],
    "task-delegation-gate": [
        "bun test packages/coding-agent/test/system-prompt-delegation.test.ts packages/coding-agent/test/system-prompt-model.test.ts packages/coding-agent/test/tools/eval-description.test.ts"],
    "agent-registry-observation": ["bun test packages/coding-agent/src/registry/__tests__/agent-registry-observation.test.ts"],
    "outcome-first-scope-control": [
        "bun test packages/coding-agent/test/system-prompt-inventory.test.ts packages/coding-agent/test/system-prompt-personality.test.ts packages/coding-agent/test/prompt-templates.test.ts packages/coding-agent/test/task/discovery.test.ts packages/coding-agent/test/agent-session-todo-reminder-loop.test.ts packages/coding-agent/test/agent-session-todo-mid-run-nudge.test.ts packages/coding-agent/test/agent-session-magic-keywords.test.ts packages/tui/test/task-yield-shape-render.test.ts packages/coding-agent/test/tools/review.test.ts"],
    "kimi-usage-account-identity": ["bun test packages/ai/test/kimi-usage.test.ts"],
    "archive-read-crash-containment": [
        "bun test packages/utils/test/ar/tar.test.ts packages/utils/test/ar/zip.test.ts",
        "bun test packages/coding-agent/test/tools.test.ts"],
    "codex-native-web-run": [
        "bun test packages/ai/test/apply-patch-freeform.test.ts packages/ai/test/azure-openai-responses-stream.test.ts packages/ai/test/openai-codex.test.ts packages/ai/test/openai-codex-stream.test.ts",
        "bun test packages/agent/test/agent-loop.test.ts",
        "bun test packages/coding-agent/test/extensions-runner.test.ts --test-name-pattern 'inherits the wrapper call.s signal and onUpdate for a bare invokeTool'",
        "bun test packages/coding-agent/test/tools/web-search-codex.test.ts --test-name-pattern 'web.run'"],
    "codex-web-search-cli-fallback": [
        "bun test packages/coding-agent/test/tools/web-search-codex.test.ts packages/coding-agent/test/web/search/default-chain.test.ts"],
    "context-occupancy-projection": [
        "bun test packages/agent/test/agent.test.ts packages/agent/test/agent-loop.test.ts packages/agent/test/compaction-reserve-provenance.test.ts packages/agent/test/live-steering.test.ts packages/coding-agent/test/compaction-speculation.test.ts packages/coding-agent/test/agent-session-goal-midrun-compaction.test.ts packages/coding-agent/test/agent-session-mid-turn-compaction-dead-end.test.ts packages/coding-agent/test/agent-session-stats.test.ts packages/coding-agent/test/agent-session-retry-recovery.test.ts packages/coding-agent/test/compaction.test.ts"],
    "local-context-overflow-classification": [
        "bun test packages/ai/test/overflow-utils.test.ts packages/agent/test/compaction-oversized-input.test.ts"],
    "terminal-resize-test-harness": [
        "bun test packages/tui/test/resize-anchor-recovery.test.ts packages/tui/test/overlay-scroll.test.ts packages/tui/test/history-frame-plan.test.ts"],
    "socket-close-tool-call-recovery": [
        "bun test packages/agent/test/agent-loop.test.ts --test-name-pattern 'runs completed tool calls after a bun fetch socket-close error'"],
    "harmony-mitigation-resolved-model-tests": [
        "bun test packages/ai/test/harmony-leak.test.ts --test-name-pattern 'does not infer policy from the provider when compatibility is absent'",
        "bun test packages/agent/test/agent-loop.test.ts --test-name-pattern 'harmony leakage reaches the committed assistant message'",
        "bun test packages/agent/test/soft-tool-requirement.test.ts --test-name-pattern 'reuses the fetched hard tool choice across a Harmony retry'"],
    "handler-scoped-session-context": [
        "bun test packages/coding-agent/test/cli-evaluation-policy.test.ts packages/coding-agent/test/evaluation-policy-launch.test.ts packages/coding-agent/test/evaluation-policy-print.test.ts packages/coding-agent/test/extension-context-budget.test.ts packages/coding-agent/test/compiled-evaluation-policy.test.ts packages/coding-agent/test/eval/process-entry-import.test.ts packages/coding-agent/test/eval/process-stdio-capture.test.ts"],
    "extension-runtime-requirements": [
        "bun test packages/coding-agent/test/extension-message-receipts.test.ts packages/coding-agent/test/runtime-requirements-startup.test.ts packages/coding-agent/test/runtime-requirements.test.ts packages/coding-agent/test/extension-context-async-jobs.test.ts packages/coding-agent/test/extension-context-project-trust.test.ts packages/coding-agent/test/issue-7955-extension-project-trusted.test.ts packages/coding-agent/test/agent-session-queued-policy.test.ts packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts packages/coding-agent/test/agent-session-cache-warming-runtime.test.ts"],
    "streamed-tool-call-normalization": [
        "bun test packages/agent/test/prompt-tools-loop.test.ts packages/coding-agent/test/sdk-dialect.test.ts"],
    "kimi-k3-responses-transport": [
        "bun test packages/ai/test/providers/kimi-responses.test.ts packages/ai/test/providers/kimi-code-thinking.test.ts packages/agent/test/kimi-k3-tool-loop.test.ts packages/catalog/test/kimi-code-provider.test.ts"],
    "oauth-account-pool-controls": [
        "bun test packages/ai/test/auth-storage-account-pause.test.ts packages/ai/test/auth-storage-oauth-account-restriction.test.ts packages/ai/test/auth-storage-codex-selection.test.ts packages/ai/test/auth-storage-oauth-account-select.test.ts packages/ai/test/auth-storage-claude-reset.test.ts",
        "bun test packages/coding-agent/test/auth-command.test.ts packages/coding-agent/test/slash-commands/login-manage.test.ts packages/coding-agent/test/modes/components/account-pause-selector.test.ts packages/coding-agent/test/modes/components/oauth-selector.test.ts packages/coding-agent/test/account-pause-session-notice.test.ts packages/coding-agent/test/oauth-account-launch-flag.test.ts packages/coding-agent/test/oauth-account-pool-automatic-readers.test.ts"],
    "daemon-completion-delivery-recovery": [
        "bun test packages/coding-agent/test/launch/completion-delivery.test.ts packages/coding-agent/test/launch/service-completion-ownership.test.ts packages/coding-agent/test/launch/broker-metadata-writes.test.ts packages/coding-agent/test/launch/protocol.test.ts packages/coding-agent/test/session/yield-queue.test.ts",
        "bun test packages/coding-agent/test/agent-session-async-delivery.test.ts --test-name-pattern 'advisor-owned launch completion'"],
}
NATIVE_GREP_TEST = "grep::tests::oversized_prefix_read_returns_stable_snapshot_after_rewrite"
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
) + tuple(f"qualify-boundary-{boundary}-{index}"
          for boundary, commands in BOUNDARIES.items() for index in range(1, len(commands) + 1))


def valid_stage(value):
    return isinstance(value, str) and receipt.match(r"qualify-[a-z0-9]+(?:-[a-z0-9]+)*", value) and value in STAGES


def announce_stage(value, *, inside=False):
    require(valid_stage(value), "Invalid qualification stage")
    print(value, file=sys.stderr if inside else sys.stdout, flush=True)


def forward_stages(stream):
    stream.seek(0)
    data = stream.read(8193)
    require(len(data) <= 8192, "Invalid qualification stages")
    lines = data.decode("ascii").splitlines(keepends=True)
    require(all(line.endswith("\n") and valid_stage(line[:-1]) for line in lines), "Invalid qualification stage")
    for line in lines:
        announce_stage(line[:-1])


def boundary_commands(source, *, with_stages=False):
    text = (source / "README.md").read_text()
    start, end = "<!-- stronk-omp:fork-contracts:start -->", "<!-- stronk-omp:fork-contracts:end -->"
    require(text.count(start) == text.count(end) == 1, "Missing immutable boundary map")
    block = text.split(start, 1)[1].split(end, 1)[0]
    ids = re.findall(r"^- `([a-z0-9-]+)`:", block, re.MULTILINE)
    require(len(ids) == len(set(ids)) and set(ids) == set(BOUNDARIES), "Active boundary snapshot differs")
    commands = []
    for contract in ids:
        require(bool(BOUNDARIES[contract]), "Active verification is missing")
        for number, command in enumerate(BOUNDARIES[contract], 1):
            args = shlex.split(command)
            require(args[:2] == ["bun", "test"], "Unsupported boundary command")
            paths = []
            index = 2
            while index < len(args):
                if args[index] == "--test-name-pattern":
                    require(index + 1 < len(args) and args[index + 1], "Invalid boundary filter")
                    index += 2
                    continue
                path = source / args[index]
                require(args[index].endswith(".test.ts") and path.is_file() and
                        path.resolve().is_relative_to(source.resolve()), "Immutable boundary test is missing")
                paths.append(path)
                index += 1
            require(paths, "Boundary command has no tests")
            # Preserve every registry command, including repeated files with distinct filters.
            commands.append((f"qualify-boundary-{contract}-{number}", args) if with_stages else args)
    return commands


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
    destination.chmod(0o755)


def validate_result(result, manifest, image):
    receipt.keys(result, ("binary_sha256", "source_commit", "recipe_commit", "environment", "checks"))
    require(result["binary_sha256"] == manifest["asset"]["sha256"] and
            result["source_commit"] == manifest["source"]["commit"] and
            result["recipe_commit"] == manifest["source"]["recipe_commit"], "Qualified tuple differs")
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


def sign_attestation(manifest, key, output):
    data = receipt.attestation_bytes(manifest)
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


def finalize(directory, before, result, image, root, commit, recipe_commit, attestation_key, attestation):
    # Recheck the actual host bytes and complete tuple after execution, not just
    # the copied binary or metadata returned by the runtime.
    after = receipt.verify(directory, commit, before["source"]["tag"] or "", False, recipe_commit, root)
    require(after == before, "Assets changed during qualification")
    validate_result(result, before, image)
    complete = copy.deepcopy(before)
    complete["checks"] = dict(result["checks"])
    complete["qualification"] = result
    receipt.save_manifest(directory, complete)
    receipt.verify(directory, commit, before["source"]["tag"] or "", False, recipe_commit, root)
    attestation_output(directory, attestation_key, attestation)
    sign_attestation(complete, attestation_key, attestation)


def qualify(args, root=None):
    announce_stage("qualify-host-inputs")
    root = root or Path(__file__).resolve().parent.parent
    require(args.commit == receipt.APPLICATION_COMMIT, "Wrong application source")
    require(receipt.match(receipt.IMAGE, args.runtime_image) or receipt.match(receipt.DIGEST, args.runtime_image),
            "Immutable runtime image is required")
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
        boundary_commands(work / "source")
        inputs, recipes = work / "input", work / "recipe"
        inputs.mkdir(mode=0o755)
        recipes.mkdir(mode=0o755)
        inputs.chmod(0o755)
        recipes.chmod(0o755)
        shutil.copyfile(directory / receipt.ASSETS[0], inputs / receipt.ASSETS[0])
        (inputs / receipt.ASSETS[0]).chmod(0o555)
        require(receipt.digest(inputs / receipt.ASSETS[0]) == before["asset"]["sha256"], "Copied binary differs")
        (inputs / "request.json").write_text(json.dumps({"manifest": before, "runtime_image": image_digest}))
        (inputs / "request.json").chmod(0o444)
        for name in ("linux-amd64-receipt.py", "linux-amd64-qualify.py", "linux-amd64-smoke.sh"):
            data = receipt.git_bytes(root, args.recipe_commit, f"scripts/{name}") if args.recipe_commit else (root / "scripts" / name).read_bytes()
            require(hashlib.sha256(data).hexdigest() == before["build_inputs"]["recipe"][name], "Invoked recipe differs")
            (recipes / name).write_bytes(data)
            (recipes / name).chmod(0o444)
        name = "omp-qualification-" + uuid.uuid4().hex
        try:
            command = container_command(docker, args.runtime_image, work, name, getattr(args, "witness_run_id", ""))
            announce_stage("qualify-host-execute")
            with tempfile.TemporaryFile() as stages:
                try:
                    output = subprocess.check_output(command, stderr=stages, timeout=3600)
                finally:
                    forward_stages(stages)
            require(len(output) <= 8192, "Invalid runtime summary")
            result = receipt.strict_json(output)
        finally:
            # A client timeout must not leave workers or runtime state alive.
            subprocess.run(docker + ["rm", "--force", name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30, check=False)
        announce_stage("qualify-host-finalize")
        finalize(directory, before, result, image_digest, root, args.commit, args.recipe_commit,
                 args.attestation_key, args.attestation)


class Runtime:
    """Keep all command diagnostics in disposable private runtime files."""
    def __init__(self, environment):
        self.environment = environment
        self.sequence = 0

    def run(self, args, cwd, seconds=240, stdin=b""):
        self.sequence += 1
        prefix = Path("/runtime") / f"command-{self.sequence}"
        with prefix.with_suffix(".out").open("wb") as out, prefix.with_suffix(".err").open("wb") as err:
            completed = subprocess.run(["timeout", "--signal=TERM", "--kill-after=5s", f"{seconds}s", *map(str, args)],
                                       cwd=cwd, env=self.environment, input=stdin, stdout=out, stderr=err, timeout=seconds + 15)
        require(completed.returncode == 0, "Runtime check failed")
        paths = (prefix.with_suffix(".out"), prefix.with_suffix(".err"))
        require(all(path.stat().st_size <= 8 * 1024 * 1024 for path in paths), "Runtime diagnostic limit exceeded")
        return tuple(path.read_bytes() for path in paths)


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
            metadata["bun_version"] == "1.4.2" and metadata["locks"] == manifest["build_inputs"]["locks"], "Prepared dependency identity differs")
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
    require(version == b"1.4.2\n", "Pinned Bun runtime is required")
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
    receipt.keys(request, ("manifest", "runtime_image"))
    manifest, image = request["manifest"], request["runtime_image"]
    require(manifest["source"]["commit"] == receipt.APPLICATION_COMMIT and receipt.match(receipt.DIGEST, image), "Wrong runtime request")
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
    commands = boundary_commands(source, with_stages=True)
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
    for stage, command in commands:
        announce_stage(stage, inside=True)
        output, error = runtime.run(command, source)
        combined = output + b"\n" + error
        require(re.search(rb"\b[1-9][0-9]* pass\b", combined) is not None and
                re.search(rb"\b[1-9][0-9]* fail\b", combined) is None, "Boundary command ran no passing tests")
    announce_stage("qualify-native-grep", inside=True)
    grep_source = (source / "crates/pi-natives/src/grep.rs").read_text()
    require(re.search(r"(?m)^\s*fn\s+" + NATIVE_GREP_TEST.rsplit("::", 1)[1] + r"\s*\(", grep_source), "Canonical native regression is missing")
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
        "recipe_commit": manifest["source"]["recipe_commit"],
        "environment": {"execution": "native-amd64", "cpu": "x86-64-v2", "glibc": libc,
                        "loader": "ld-linux-x86-64.so.2", "runtime_image": image},
        "checks": {name: "passed" for name in receipt.CHECKS},
    }
    validate_result(result, manifest, image)
    print(json.dumps(result, sort_keys=True))


class PublicParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError("Invalid qualification arguments")


def main():
    try:
        if sys.argv[1:] == ["--inside"]:
            runtime_main()
            return
        parser = PublicParser(description=__doc__)
        parser.add_argument("--commit", required=True)
        parser.add_argument("--recipe-commit", default="")
        parser.add_argument("--assets", required=True, type=Path)
        parser.add_argument("--runtime-image", required=True)
        parser.add_argument("--docker-socket", required=True)
        parser.add_argument("--attestation-key", required=True, type=Path)
        parser.add_argument("--attestation", required=True, type=Path)
        parser.add_argument("--witness-run-id", default="")
        qualify(parser.parse_args())
        print("Linux-amd64 qualification passed; exact public assets finalized.")
    except (ValueError, OSError, KeyError, TypeError, AttributeError, IndexError, subprocess.SubprocessError, tarfile.TarError):
        if sys.argv[1:] == ["--inside"]:
            raise SystemExit(1) from None
        # No paths, command output, environment values, or input documents escape.
        raise SystemExit("Linux-amd64 qualification rejected; publication is not permitted.") from None


if __name__ == "__main__":
    main()
