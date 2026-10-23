#!/usr/bin/env python3
"""Offline tests for the ci-001 build door, scripts/ci001/omp-build-entry.

Nothing here contacts a host. Docker is a fake script first on PATH that keeps its containers and images in a JSON
file. The three recipe steps are tiny fake scripts committed into a throwaway Git repository; Git itself is the real
binary working on that repository only, so the real bundle and unpack path is exercised. ssh-keygen is real because
the door verifies a real signature. The door runs exactly as sshd would run it: `sh entry` with SSH_ORIGINAL_COMMAND.
"""
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tarfile
import io
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
ENTRY = HERE / "ci001" / "omp-build-entry"
DRIVER = HERE / "ci001" / "build-linux-amd64-remote"
TAG = "stronk-omp-s1-2026.10.23.0001"
CHECKS = ("elf", "cli", "native_runtime", "resources_workers", "builtin_smoke", "offline_session",
          "fork_boundaries", "native_grep", "coding_agent_typecheck")
ASSETS = ("omp-linux-amd64", "RELEASE_MANIFEST.json", "SHA256SUMS.txt")
EVIDENCE = ("qualification.json", "qualification.json.sig", "qualification-signers")
NAMESPACE = "stronk-omp-qualification"
RUN_ID = r"b[0-9]{14}-[0-9a-f]{8}"
TOOLS_PRESENT = shutil.which("git") is not None and shutil.which("ssh-keygen") is not None
GIT_ENVIRONMENT = {
    "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
    "GIT_AUTHOR_NAME": "door test", "GIT_AUTHOR_EMAIL": "door@test.invalid",
    "GIT_COMMITTER_NAME": "door test", "GIT_COMMITTER_EMAIL": "door@test.invalid"}


def load_driver():
    loader = importlib.machinery.SourceFileLoader("ci001_driver_under_test", str(DRIVER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


driver = load_driver()

# ---- fake recipe steps (committed into the throwaway recipe commit) ---------------------------------

FAKE_COMMON = r'''#!/usr/bin/env python3
import hashlib, json, os, shutil, subprocess, sys, time
from pathlib import Path

ARGS = sys.argv[1:]
NOISE = ["token=hunter2 for the build", "/home/ompbuild/private/path", "Phase: reaching 10.1.2.3 now",
         "Phase: fine line from the recipe.", "qualify-host-source"]


def value(flag):
    return ARGS[ARGS.index(flag) + 1]


def hook(step):
    log = os.environ.get("OMP_TEST_LOG")
    if log:
        with open(log, "a") as stream:
            stream.write(json.dumps({"step": step, "argv": ARGS, "env": sorted(os.environ), "cwd": os.getcwd()}) + "\n")
    if os.environ.get("OMP_TEST_NOISE") == step:
        for line in NOISE:
            print(line, flush=True)
    if os.environ.get("OMP_TEST_FAIL") == step:
        print("raw diagnostic that must never leave the builder", flush=True)
        sys.exit(1)
    flood = os.environ.get("OMP_TEST_FLOOD")
    if flood and os.environ.get("OMP_TEST_BLOCK") == step:
        if flood == "bytes":
            Path("big.bin").write_bytes(b"x" * 400000)
        else:
            Path("many").mkdir()
            for index in range(300):
                Path("many", str(index)).write_bytes(b"")
    if os.environ.get("OMP_TEST_BLOCK") == step:
        child = subprocess.Popen(["sleep", "300"])
        Path(os.environ["OMP_TEST_PID"]).write_text(f"{os.getpid()} {child.pid}\n")
        Path(os.environ["OMP_TEST_GATE"] + ".ready").write_text("ready")
        while not Path(os.environ["OMP_TEST_GATE"]).exists():
            time.sleep(0.02)
        child.kill()


def leave(step):
    """Like a killed build: leave a labelled container and image behind in the fake daemon."""
    path = os.environ.get("OMP_TEST_STORE")
    if not path:
        return
    run = value("--witness-run-id")
    store = json.load(open(path))
    seed = hashlib.sha256((run + step).encode()).hexdigest()
    store["containers"][seed] = {"run": run, "name": f"omp-build-{run}-{step}"}
    store["images"]["sha256:" + seed] = {"run": run, "created": "2026-10-23T00:00:0" + str(len(step) % 9) + "Z"}
    json.dump(store, open(path, "w"))
'''

FAKE_RECEIPT = FAKE_COMMON + r'''
if ARGS[0] == "check":
    hook("check")
    print("Application check passed: omp 18.8.0, Bazel 9.2.0, Bun 1.4.2, 27 fork contracts.", flush=True)
elif ARGS[0] == "verify":
    hook("verify-final" if "--attestation" in ARGS else "verify-candidate")
else:
    sys.exit(64)
'''

FAKE_RUNTIME = FAKE_COMMON + r'''
hook("prepare")
fixture = Path(os.environ["OMP_TEST_FIXTURE"])
dist = Path(__file__).resolve().parent.parent / "dist" / value("--output")
dist.mkdir(parents=True)
shutil.copyfile(fixture / "assets" / "omp-linux-amd64", dist / "omp-linux-amd64")
(dist / "RELEASE_MANIFEST.json").write_bytes(b"{}\n")
(dist / "SHA256SUMS.txt").write_bytes(b"")
Path(value("--image-id-file")).write_text(os.environ.get("OMP_TEST_IMAGE", "sha256:" + "1" * 64) + "\n")
leave("prepare")
print("Phase: prepared runtime complete.", flush=True)
'''

FAKE_QUALIFY = FAKE_COMMON + r'''
hook("qualify")
if os.environ.get("OMP_TEST_QUALIFY") != "skip":
    fixture = Path(os.environ["OMP_TEST_FIXTURE"])
    assets = Path(value("--assets"))
    for name in ("RELEASE_MANIFEST.json", "SHA256SUMS.txt"):
        shutil.copyfile(fixture / "assets" / name, assets / name)
    attestation = Path(value("--attestation"))
    attestation.write_bytes((fixture / "qualification.json").read_bytes())
    subprocess.run(["ssh-keygen", "-Y", "sign", "-f", value("--attestation-key"), "-n", "stronk-omp-qualification",
                    str(attestation)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
leave("qualify")
print("qualify-host-source", flush=True)
'''

FAKE_DOCKER = r'''#!{python}
import json, os, sys

args = sys.argv[1:]
assert args[0] == "--host" and args[1].startswith("unix://") and args[2] == "--config", args
args = args[4:]
path = os.environ["OMP_TEST_STORE"]
store = json.load(open(path))
store["calls"].append(args)
INFO = {{"ServerVersion": "29.1.0", "Architecture": "x86_64", "OSType": "linux", "CgroupVersion": "2",
         "SecurityOptions": ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"],
         "MemoryLimit": True, "SwapLimit": True, "PidsLimit": True, "CpuCfsQuota": True,
         "DockerRootDir": os.environ["OMP_TEST_DOCKER_ROOT"]}}
LABEL = "label=org.stronk.omp-witness="
code = 0
if args[:1] == ["info"]:
    print(json.dumps(dict(INFO, **json.loads(os.environ.get("OMP_TEST_INFO", "{{}}")))))
elif args[:2] == ["buildx", "version"]:
    code = 1 if os.environ.get("OMP_TEST_NO_BUILDX") else 0
elif args[:1] == ["ps"]:
    selector = args[args.index("--filter") + 1]
    if selector.startswith(LABEL):
        found = [key for key, item in store["containers"].items() if item["run"] == selector[len(LABEL):]]
    else:
        found = [key for key, item in store["containers"].items() if selector[len("name="):] in item["name"]]
    print("\n".join(found))
elif args[:2] == ["image", "ls"]:
    selector = args[args.index("--filter") + 1]
    print("\n".join(key for key, item in store["images"].items() if item["run"] == selector[len(LABEL):]))
elif args[:2] == ["image", "inspect"]:
    print(store["images"][args[-1]]["created"])
elif args[:2] == ["image", "rm"]:
    if not os.environ.get("OMP_TEST_STUBBORN"):
        store["images"].pop(args[-1], None)
elif args[:2] == ["rm", "--force"]:
    if not os.environ.get("OMP_TEST_STUBBORN"):
        store["containers"].pop(args[-1], None)
elif args[:2] == ["builder", "prune"]:
    pass
else:
    code = 64
json.dump(store, open(path, "w"))
sys.exit(code)
'''

ALLOWED_DOCKER = {("info",), ("buildx", "version"), ("ps",), ("image", "ls"), ("image", "inspect"), ("image", "rm"),
                  ("rm", "--force"), ("builder", "prune")}


# ---- result fixtures (shared with the driver tests) -------------------------------------------------

def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n").encode()


def elf(machine=62):
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", header, 18, machine)
    return bytes(header) + b"fixture binary\n"


def make_outputs(assets, app, recipe, tag="", *, machine=62, version="18.8.0", manifest_edit=None, binding_edit=None):
    """Write the three public assets into `assets` and return the attestation binding bytes.

    The edits run before the manifest, checksums and binding are computed, so only the targeted defect appears.
    """
    assets = Path(assets)
    assets.mkdir(parents=True, exist_ok=True)
    binary = elf(machine)
    digest = hashlib.sha256(binary).hexdigest()
    passed = {name: "passed" for name in CHECKS}
    manifest = {
        "schema": 2, "repository": "EYYCHEEV/oh-my-pi", "target": "linux-amd64", "version": version,
        "source": {"commit": app, "tag": tag or None, "tag_object": "b" * 40 if tag else None,
                   "source_date_epoch": 1792108800, "recipe_committed": bool(tag),
                   "recipe_commit": recipe if tag else None},
        "asset": {"name": ASSETS[0], "size": len(binary), "sha256": digest},
        "checks": dict(passed),
        "qualification": {"binary_sha256": digest, "source_commit": app, "recipe_commit": recipe if tag else None,
                          "environment": {"execution": "native-amd64", "cpu": "x86-64-v2", "glibc": "2.36",
                                          "loader": "ld-linux-x86-64.so.2", "runtime_image": "sha256:" + "1" * 64},
                          "checks": dict(passed)}}
    if manifest_edit:
        manifest_edit(manifest)
    manifest_bytes = canonical(manifest)
    try:
        source, asset, qualification = manifest["source"], manifest["asset"], manifest["qualification"]
        binding = canonical({
            "schema": 1, "binary_sha256": asset["sha256"], "source_commit": source["commit"],
            "recipe_commit": source["recipe_commit"], "runtime_image_digest": qualification["environment"]["runtime_image"],
            "mode": "release" if source["recipe_committed"] else "candidate", "checks": manifest["checks"],
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest()})
    except (KeyError, TypeError):  # a deliberately broken manifest has nothing coherent to bind
        binding = canonical({"unbindable": True})
    if binding_edit:
        binding = binding_edit(binding)
    (assets / ASSETS[0]).write_bytes(binary)
    (assets / ASSETS[1]).write_bytes(manifest_bytes)
    (assets / ASSETS[2]).write_text("".join(
        f"{hashlib.sha256((assets / name).read_bytes()).hexdigest()}  {name}\n" for name in ASSETS[:2]))
    return binding


def make_key(directory, name="key"):
    key = Path(directory) / name
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", str(key)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fields = key.with_name(name + ".pub").read_text().split()
    return key, f'{NAMESPACE} namespaces="{NAMESPACE}" {fields[0]} {fields[1]}\n'


def sign(key, path):
    subprocess.run(["ssh-keygen", "-Y", "sign", "-f", str(key), "-n", NAMESPACE, str(path)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def make_received(root, app, recipe, tag="", *, signer="good", **options):
    """The layout the driver verifies: the three assets, plus evidence/ with a real signature."""
    root = Path(root)
    binding = make_outputs(root, app, recipe, tag, **options)
    evidence = root / "evidence"
    evidence.mkdir()
    (evidence / EVIDENCE[0]).write_bytes(binding)
    with tempfile.TemporaryDirectory(prefix="omp-keys-") as keys:
        key, signers = make_key(keys, "signing")
        if signer == "other":
            _, signers = make_key(keys, "enrolled")
        sign(key, evidence / EVIDENCE[0])
        (evidence / EVIDENCE[2]).write_text(signers)
    return root


def make_repository(root):
    """A throwaway fork: an application commit with an omp version, then a recipe commit with the fake steps."""
    repo = Path(root) / "source"
    repo.mkdir()

    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, env={**os.environ, **GIT_ENVIRONMENT}).stdout.decode().strip()

    git("init", "-q", "-b", "main")
    # Earlier history with a large incompressible blob: the bundle must not carry it.
    (repo / "history.bin").write_bytes(os.urandom(300_000))
    git("add", "-A")
    git("commit", "-q", "-m", "history")
    (repo / "history.bin").unlink()
    (repo / "packages" / "coding-agent").mkdir(parents=True)
    (repo / "packages" / "coding-agent" / "package.json").write_text('{"version": "18.8.0"}\n')
    git("add", "-A")
    git("commit", "-q", "-m", "application")
    app = git("rev-parse", "HEAD")
    (repo / "scripts").mkdir()
    for name, text in (("linux-amd64-receipt.py", FAKE_RECEIPT), ("linux-amd64-runtime.py", FAKE_RUNTIME),
                       ("linux-amd64-qualify.py", FAKE_QUALIFY)):
        (repo / "scripts" / name).write_text(text)
    git("add", "-A")
    git("commit", "-q", "-m", "recipe")
    recipe = git("rev-parse", "HEAD")
    git("tag", "-a", "-m", "release", TAG, app)
    return repo, app, recipe


def reap(process):
    process.kill()
    process.wait()
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream is not None and not stream.closed:
            stream.close()


class Session:
    """One door call running in the background, like one ssh connection."""

    def __init__(self, case, command, stdin=b"", extra=None):
        self.process = subprocess.Popen(["sh", str(ENTRY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=case.environment(command, extra), bufsize=0)
        self.process.stdin.write(stdin)
        self.process.stdin.close()
        self.buffer = b""

    def line(self, timeout=20):
        deadline = time.monotonic() + timeout
        while b"\n" not in self.buffer:
            if time.monotonic() > deadline:
                raise AssertionError("no output from the door: " + repr(self.buffer))
            if select.select([self.process.stdout], [], [], 0.2)[0]:
                chunk = os.read(self.process.stdout.fileno(), 4096)
                if not chunk:
                    raise AssertionError("the door closed its output: " + repr(self.buffer))
                self.buffer += chunk
        text, _, self.buffer = self.buffer.partition(b"\n")
        return text.decode()


@unittest.skipUnless(TOOLS_PRESENT, "git and ssh-keygen are required")
@unittest.skipIf(os.geteuid() == 0, "the door refuses to run as root")
class DoorCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="omp-door-repo-"))
        cls.addClassCleanup(shutil.rmtree, cls.root, True)
        cls.repo, cls.app, cls.recipe = make_repository(cls.root)
        cls.bundles = {}
        for tag in ("", TAG):
            directory = cls.root / ("bundle-" + (tag or "candidate"))
            directory.mkdir()
            cls.bundles[tag] = driver.make_bundle(cls.repo, cls.app, cls.recipe, tag, directory).read_bytes()

    def setUp(self):
        self.temporary = Path(tempfile.mkdtemp(prefix="omp-door-"))
        self.addCleanup(shutil.rmtree, self.temporary, True)
        self.addCleanup(self.stop_everything)
        t = self.temporary
        self.state, self.data, self.logs, self.etc, self.bin = t / "state", t / "data", t / "logs", t / "etc", t / "bin"
        for directory in (self.state, self.data, self.logs, self.etc, self.bin, self.data / "docker", t / "home"):
            directory.mkdir()
        (self.bin / "docker").write_text(FAKE_DOCKER.format(python=sys.executable))
        (self.bin / "docker").chmod(0o755)
        self.listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(self.listener.close)
        self.socket_path = t / "docker.sock"
        self.listener.bind(str(self.socket_path))
        (t / "meminfo").write_text("MemTotal: 134217728 kB\nMemAvailable: 100000000 kB\n")
        self.store_path = t / "store.json"
        self.store_path.write_text(json.dumps({"calls": [], "containers": {}, "images": {}}))
        self.gate, self.pids, self.log = t / "gate", t / "pids", t / "steps.log"
        self.fixture = t / "fixture"
        self.write_fixture()

    def write_fixture(self, tag="", **options):
        shutil.rmtree(self.fixture, ignore_errors=True)
        binding = make_outputs(self.fixture / "assets", self.app, self.recipe, tag, **options)
        (self.fixture / "qualification.json").write_bytes(binding)

    def environment(self, command, extra=None):
        t = self.temporary
        environment = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "HOME": str(t / "home"), "LANG": "C",
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
            "SSH_ORIGINAL_COMMAND": command,
            "OMP_BUILD_STATE_DIR": str(self.state), "OMP_BUILD_DATA_ROOT": str(self.data),
            "OMP_BUILD_LOG_DIR": str(self.logs), "OMP_BUILD_ETC_DIR": str(self.etc),
            "OMP_BUILD_SOCKET": str(self.socket_path), "OMP_BUILD_PLAIN_DATA": "1",
            "OMP_BUILD_FREE_START_BYTES": "0", "OMP_BUILD_FREE_RUNNING_BYTES": "0", "OMP_BUILD_MEMORY_BYTES": "0",
            "OMP_BUILD_MEMINFO": str(t / "meminfo"), "OMP_BUILD_TICK_SECONDS": "0.1",
            "OMP_BUILD_FOLLOW_SECONDS": "0.05", "OMP_BUILD_SCAN_SECONDS": "0.3",
            "OMP_TEST_STORE": str(self.store_path), "OMP_TEST_DOCKER_ROOT": str(self.data / "docker"),
            "OMP_TEST_FIXTURE": str(self.fixture), "OMP_TEST_LOG": str(self.log),
            "OMP_TEST_GATE": str(self.gate), "OMP_TEST_PID": str(self.pids)}
        environment.update(extra or {})
        return environment

    def door(self, command, stdin=b"", extra=None, timeout=60):
        result = subprocess.run(["sh", str(ENTRY)], input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=self.environment(command, extra), timeout=timeout, check=False)
        result.out = result.stdout.decode()
        result.err = result.stderr.decode()
        return result

    def build_command(self, tag=""):
        return f"build {self.app} {self.recipe}" + (f" {tag}" if tag else "")

    def build(self, tag="", extra=None, bundle=None, **options):
        return self.door(self.build_command(tag), self.bundles[tag] if bundle is None else bundle, extra, **options)

    def run_of(self, result):
        found = re.search(rf"^run ({RUN_ID})$", result.out, re.MULTILINE)
        self.assertIsNotNone(found, result.out + result.err)
        return found[1]

    def status(self, run):
        result = self.door(f"status {run}")
        values = dict(line.split(": ", 1) for line in result.out.splitlines() if ": " in line)
        return result.returncode, values

    def finished(self, run, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            code, values = self.status(run)
            if values.get("state") != "running":
                return code, values
            time.sleep(0.05)
        self.fail("the run did not finish")

    def eventually(self, condition, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.02)
        self.fail("timed out waiting for a condition")

    def block_extra(self, step, **more):
        return {"OMP_TEST_BLOCK": step, **more}

    def store(self):
        return json.loads(self.store_path.read_text())

    def steps(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def run_dir(self, run):
        return self.state / "runs" / run

    def log_text(self):
        path = self.logs / "runs.log"
        return path.read_text() if path.exists() else ""

    def runs(self):
        directory = self.state / "runs"
        return sorted(item.name for item in directory.iterdir()) if directory.exists() else []

    def stop_everything(self):
        self.gate.write_text("open")
        for line in (self.pids.read_text().split() if self.pids.exists() else []):
            self.kill(int(line))
        for run in self.runs():
            try:
                self.kill(json.loads((self.run_dir(run) / "state.json").read_text()).get("pid"))
            except (OSError, ValueError):
                pass

    @staticmethod
    def kill(pid):
        if isinstance(pid, int) and pid > 1:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def assertDockerStayedInside(self):
        for call in self.store()["calls"]:
            key = tuple(call[:2]) if call[0] in ("image", "buildx", "builder", "rm") else (call[0],)
            self.assertIn(key, ALLOWED_DOCKER, call)
            if call[0] == "rm":
                self.assertRegex(call[2], "^[0-9a-f]{64}$")
            if call[:2] == ["image", "rm"]:
                self.assertEqual(call[2], "--no-prune")

    def assertRefused(self, result, reason, code=2):
        self.assertEqual(result.returncode, code, result.out + result.err)
        self.assertIn(reason, result.out)
        self.assertEqual(result.err, "")


class GrammarTests(DoorCase):
    def test_every_invalid_command_is_refused_before_any_state_is_touched(self):
        h, o = "a" * 40, "b" * 40
        cases = ["", "rm -rf /", "build", f"build {h}", f"build {h} {o} extra", f"build {h.upper()} {o}",
                 f"build {h[:39]} {o}", f"build {h}  {o}", f"build {h} {o} stronk-omp-s1-2026.10.23",
                 f"build {h} {o} v1.0.0", f"build {h} {o};id", f"build {h} {o}\n", f"build {h} {o} $(id)",
                 "status", "status ../../etc", "status b20261023153012-3fa9c1d2 extra", "status B20261023153012-3FA9C1D2",
                 "status b20261023153012-3fa9c1d", "fetch b20261023153012-3fa9c1d2;ls", "cleanup $(id)",
                 "cleanup b20261023153012-3fa9c1d2\nstatus b20261023153012-3fa9c1d2", "STATUS b20261023153012-3fa9c1d2",
                 "scp -t /tmp", "sftp", "git-upload-pack /x", "status b20261023153012-3fa9c1d2 && id",
                 "status b2026102315301\u00e9-3fa9c1d2", "-- --supervise", "--supervise x 1 2"]
        for command in cases:
            with self.subTest(command=command):
                result = self.door(command)
                self.assertRefused(result, "refused: invalid command")
                self.assertEqual(result.out, "refused: invalid command\n")
        self.assertEqual(self.runs(), [])
        self.assertEqual(self.log_text(), "")
        self.assertEqual(self.store()["calls"], [])

    def test_an_absent_command_is_refused(self):
        environment = self.environment("")
        del environment["SSH_ORIGINAL_COMMAND"]
        result = subprocess.run(["sh", str(ENTRY)], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                stdin=subprocess.DEVNULL, check=False)
        self.assertEqual((result.returncode, result.stdout), (2, b"refused: invalid command\n"))

    def test_the_loader_is_plain_sh_and_never_evaluates_the_command(self):
        text = ENTRY.read_text()
        self.assertEqual(text.splitlines()[0], "#!/bin/sh")
        shell, _, python = text.partition("\n#PY\n")
        code = "\n".join(line for line in shell.splitlines() if not line.startswith("#"))
        self.assertNotIn("SSH_ORIGINAL_COMMAND", code)
        self.assertNotRegex(code, r"\beval\b|\bsource\b|\$\(|`")
        self.assertNotRegex(python, r"shell\s*=\s*True|os\.system|os\.popen|\beval\(|\bexec\(\s*(?!compile)")
        self.assertTrue(os.access(ENTRY, os.X_OK))
        # sh executes up to its exec and never reads the Python that follows, so only the loader is syntax-checked.
        syntax = subprocess.run(["sh", "-n"], input=(shell + "\n").encode(), check=False, stderr=subprocess.PIPE)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        compile(python, str(ENTRY), "exec")

    def test_a_command_with_shell_syntax_never_runs(self):
        marker = self.temporary / "pwned"
        for command in (f"status b20261023153012-3fa9c1d2; touch {marker}", f"build $(touch {marker}) {'b' * 40}"):
            self.assertRefused(self.door(command), "invalid command")
        self.assertFalse(marker.exists())

    def test_over_ssh_the_test_only_overrides_are_ignored(self):
        run = "b20261023153012-3fa9c1d2"
        (self.state / "runs" / run).mkdir(parents=True)
        result = self.door(f"status {run}", extra={"SSH_CONNECTION": "client 1 server 22"})
        self.assertRefused(result, "refused: no such run")
        self.assertEqual(self.log_text(), "", "the override pointing the log at the test folder was honoured")
        self.assertEqual(self.store()["calls"], [])


class IntakeTests(DoorCase):
    def assertNothingLeftBehind(self):
        self.assertEqual(self.runs(), [])
        self.assertEqual([call for call in self.store()["calls"] if call[0] == "rm"], [])

    def test_a_bundle_over_the_size_cap_is_refused_and_removed(self):
        result = self.build(extra={"OMP_BUILD_MAX_BUNDLE_BYTES": "300"})
        self.assertRefused(result, "refused: the bundle exceeds the size cap")
        self.assertGreater(len(self.bundles[""]), 300)
        self.assertNothingLeftBehind()

    def test_a_bundle_just_inside_the_cap_is_accepted(self):
        result = self.build(extra={"OMP_BUILD_MAX_BUNDLE_BYTES": str(len(self.bundles[""]))})
        self.assertEqual(result.returncode, 0, result.out)

    def test_an_empty_or_foreign_input_is_refused(self):
        for data, reason in ((b"", "a git bundle is required"), (b"hello\n\nPACK", "not a git bundle"),
                             (b"# v2 git bundle\n" + b"x" * 20000, "not a git bundle"),
                             (b"# v9 git bundle\n\nPACK", "not a git bundle"),
                             (self.bundles[""].replace(b"PACK", b"PUCK", 1), "not a git bundle")):
            with self.subTest(data=data[:24]):
                self.assertRefused(self.build(bundle=data), reason)
        self.assertNothingLeftBehind()

    def test_a_bundle_that_is_not_exactly_the_requested_commits_is_refused(self):
        other = "c" * 40
        good = self.bundles[""]
        header = good.split(b"\n\n", 1)[0].decode().split("\n")
        body = good.split(b"\n\n", 1)[1]

        def forge(lines):
            return ("\n".join(lines) + "\n\n").encode() + body

        cases = {
            "wrong application commit": forge([header[0], f"{other} refs/omp/app", header[2]]),
            "wrong recipe commit": forge([header[0], header[1], f"{other} refs/omp/recipe"]),
            "extra ref": forge(header + [f"{other} refs/heads/main"]),
            "missing ref": forge(header[:2]),
            "prerequisite": forge(header + [f"-{other} some comment"]),
            "repeated ref": forge(header + [header[1]]),
            "traversal ref": forge([header[0], header[1], f"{other} refs/omp/../../x"]),
            "other hash algorithm": forge(["# v3 git bundle", "@object-format=sha256", *header[1:]]),
            "unrequested tag": self.bundles[TAG],
        }
        for name, data in cases.items():
            with self.subTest(case=name):
                result = self.build(bundle=data)
                self.assertEqual(result.returncode, 2, result.out)
                self.assertRegex(result.out, "refused: the bundle (carries unexpected content|does not carry exactly)")
        self.assertNothingLeftBehind()

    def test_a_tag_that_is_requested_but_not_bundled_is_refused(self):
        self.prepare_signers()
        self.assertRefused(self.build(tag=TAG, bundle=self.bundles[""]), "does not carry exactly the requested commits")

    def test_a_stalled_upload_is_cut_off(self):
        stalled = subprocess.Popen(["sh", str(ENTRY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE,
                                   env=self.environment(self.build_command(), {"OMP_BUILD_UPLOAD_SECONDS": "0.5"}))
        self.addCleanup(reap, stalled)
        started = time.monotonic()
        out = stalled.stdout.read()  # stdin is never written and never closed
        stalled.wait(timeout=20)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual((stalled.returncode, out.decode()), (2, "refused: the bundle upload took too long\n"))
        self.assertNothingLeftBehind()

    def test_a_bundle_with_a_valid_header_but_hostile_content_fails_without_a_build(self):
        header = self.bundles[""].split(b"\n\n", 1)[0]
        result = self.build(bundle=header + b"\n\nPACK" + b"\x00" * 64)
        self.assertEqual(result.returncode, 1, result.out)
        run = self.run_of(result)
        code, values = self.status(run)
        self.assertEqual((code, values["state"], values["qualified"]), (1, "failed", "no"))
        self.assertEqual(values["reason"], "the bundle could not be unpacked")
        self.assertEqual(self.steps(), [])

    def prepare_signers(self):
        (self.etc / "source-allowed-signers").write_text("fixture ssh-ed25519 AAAA\n")
        (self.etc / "source-revoked-signers").write_text("")

    def test_release_builds_need_enrolled_source_signers(self):
        self.assertRefused(self.build(tag=TAG), "release builds need enrolled source signers on this host")
        (self.etc / "source-allowed-signers").write_text("")
        (self.etc / "source-revoked-signers").write_text("")
        self.assertRefused(self.build(tag=TAG), "release builds need enrolled source signers")
        self.prepare_signers()
        (self.etc / "source-allowed-signers").chmod(0o666)
        self.assertRefused(self.build(tag=TAG), "release builds need enrolled source signers")
        (self.etc / "source-allowed-signers").chmod(0o644)
        (self.etc / "source-revoked-signers").unlink()
        self.assertRefused(self.build(tag=TAG), "release builds need enrolled source signers")
        self.assertNothingLeftBehind()


class PreflightTests(DoorCase):
    def test_every_host_condition_that_would_make_a_build_unsafe_refuses_before_anything_starts(self):
        cases = {
            "the daemon is not in rootless mode": {"OMP_TEST_INFO": json.dumps({"SecurityOptions": ["name=seccomp"]})},
            "Docker is older than the supported floor": {"OMP_TEST_INFO": json.dumps({"ServerVersion": "26.1.3"})},
            "a native amd64 Linux daemon is required": {"OMP_TEST_INFO": json.dumps({"Architecture": "aarch64"})},
            "cgroup v2 is required": {"OMP_TEST_INFO": json.dumps({"CgroupVersion": "1"})},
            "the rootless daemon cannot enforce container limits": {"OMP_TEST_INFO": json.dumps({"MemoryLimit": False})},
            "Docker data is not on the build data folder": {"OMP_TEST_INFO": json.dumps({"DockerRootDir": "/var/lib/other"})},
            "BuildKit (buildx) is not available": {"OMP_TEST_NO_BUILDX": "1"},
            "free space on the build data folder is below the start floor": {"OMP_BUILD_FREE_START_BYTES": str(10**18)},
            "available memory is below the start floor": {"OMP_BUILD_MEMORY_BYTES": str(10**18)},
            "the rootless Docker socket is unavailable": {"OMP_BUILD_SOCKET": str(self.temporary / "missing.sock")},
            "the build data filesystem is not mounted": {"OMP_BUILD_PLAIN_DATA": "0"},
        }
        for reason, extra in cases.items():
            with self.subTest(reason=reason):
                self.assertRefused(self.build(extra=extra), "refused: " + reason)
        self.assertEqual(self.runs(), [])
        self.assertEqual(self.steps(), [])
        self.assertDockerStayedInside()

    def test_a_regular_file_is_not_a_docker_socket(self):
        fake = self.temporary / "plain"
        fake.write_text("")
        self.assertRefused(self.build(extra={"OMP_BUILD_SOCKET": str(fake)}), "the rootless Docker socket is unavailable")

    def test_a_host_without_swap_accounting_is_still_accepted(self):
        extra = {"OMP_TEST_INFO": json.dumps({"SwapLimit": False}), "OMP_TEST_FAIL": "check"}
        result = self.build(extra=extra)
        self.assertEqual(result.returncode, 1, result.out)  # accepted, then failed at the first recipe step as arranged
        self.assertNotIn("refused:", result.out)

    def test_memory_that_cannot_be_read_refuses(self):
        (self.temporary / "meminfo").write_text("MemTotal: 1 kB\n")
        self.assertRefused(self.build(), "available memory cannot be established")

    def test_a_missing_tool_refuses(self):
        tools = self.temporary / "tools"
        tools.mkdir()
        for name in ("python3", "ssh-keygen", "sh"):
            (tools / name).symlink_to(shutil.which(name) if name != "python3" else sys.executable)
        (tools / "docker").symlink_to(self.bin / "docker")
        result = self.build(extra={"PATH": str(tools)})
        self.assertRefused(result, "refused: git is not available to the build account")


class LifecycleTests(DoorCase):
    def test_a_candidate_build_runs_the_whole_chain_and_cleans_up_after_itself(self):
        foreign = {"run": "b20200101000000-deadbeef", "name": "omp-build-b20200101000000-deadbeef-prepare"}
        unlabeled = {"run": "", "name": "somebody-elses-container"}
        store = self.store()
        store["containers"].update({"f" * 64: foreign, "e" * 64: unlabeled})
        store["images"]["sha256:" + "f" * 64] = {"run": foreign["run"], "created": "2020-01-01T00:00:00Z"}
        self.store_path.write_text(json.dumps(store))
        result = self.build(extra={"AWS_SECRET_CANARY": "do-not-forward", "SSH_AUTH_SOCK": "/nonexistent"})
        self.assertEqual(result.returncode, 0, result.out + result.err)
        self.assertEqual(result.err, "")
        lines = result.out.splitlines()
        run = self.run_of(result)
        self.assertEqual(lines[0], f"run {run}")
        self.assertEqual(lines[-1], "state: succeeded")
        self.assertEqual([line for line in lines if line.startswith("Phase: door ")],
                         [f"Phase: door {phase}." for phase in
                          ("unpack", "check", "prepare", "verify-candidate", "qualify", "verify", "collect", "cleanup")])
        self.assertIn("Application check passed: omp 18.8.0, Bazel 9.2.0, Bun 1.4.2, 27 fork contracts.", lines)
        self.assertIn("Phase: prepared runtime complete.", lines)
        self.assertIn("qualify-host-source", lines)
        code, values = self.status(run)
        self.assertEqual(code, 0)
        self.assertEqual((values["state"], values["qualified"], values["cleanup"]), ("succeeded", "yes", "proven"))
        # The sweep removed exactly this run's labelled leftovers and nothing that belongs to anyone else.
        self.assertEqual(set(self.store()["containers"]), {"f" * 64, "e" * 64})
        self.assertEqual(set(self.store()["images"]), {"sha256:" + "f" * 64})
        self.assertDockerStayedInside()
        self.assertEqual(sorted(os.listdir(self.run_dir(run))), ["lock", "out", "progress.log", "state.json"])
        for path in (self.state / "runs", self.run_dir(run), *self.run_dir(run).rglob("*")):
            self.assertEqual(path.stat().st_mode & 0o077, 0, f"{path.name} is reachable by others")
        steps = self.steps()
        self.assertEqual([step["step"] for step in steps], ["check", "prepare", "verify-candidate", "qualify", "verify-final"])
        self.assertEqual(steps[0]["argv"], ["check", "--commit", self.app])
        prepare = steps[1]["argv"]
        self.assertEqual(prepare[:6], ["--commit", self.app, "--recipe-commit", self.recipe, "--docker-socket",
                                       "unix://" + str(self.socket_path)])
        self.assertEqual(prepare[6:10], ["--witness-run-id", run, "--output", "candidate"])
        self.assertNotIn("--tag", prepare)
        self.assertNotIn("--release", steps[4]["argv"])
        for step in steps:
            self.assertTrue(step["cwd"].endswith("/repo"), step["cwd"])
            names = set(step["env"])
            self.assertFalse({"AWS_SECRET_CANARY", "SSH_AUTH_SOCK", "SSH_CONNECTION", "SSH_ORIGINAL_COMMAND"} & names, names)
            self.assertFalse([name for name in names if name.startswith("OMP_BUILD_")], names)
        text = self.log_text()
        self.assertRegex(text, r"(?m)^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ build " + run + r" 0 \d+\.\d "
                         + self.app[:12] + " " + self.recipe[:12] + " candidate$")
        self.assertEqual(len(text.splitlines()), 2, text)  # the build and the status call
        for forbidden in (str(self.temporary), "SECRET", "key", "hunter2"):
            self.assertNotIn(forbidden, text)

    def test_a_release_build_carries_the_tag_and_signers_and_the_release_identity(self):
        (self.etc / "source-allowed-signers").write_text("fixture ssh-ed25519 AAAA\n")
        (self.etc / "source-revoked-signers").write_text("")
        self.write_fixture(TAG)
        result = self.build(tag=TAG)
        self.assertEqual(result.returncode, 0, result.out)
        run = self.run_of(result)
        steps = {step["step"]: step["argv"] for step in self.steps()}
        self.assertEqual(steps["prepare"][-6:], ["--tag", TAG, "--allowed-signers", str(self.etc / "source-allowed-signers"),
                                                 "--revoked-signers", str(self.etc / "source-revoked-signers")])
        self.assertEqual(steps["prepare"][steps["prepare"].index("--output") + 1], "release")
        self.assertEqual(steps["verify-candidate"][-4:], ["--tag", TAG, "--recipe-commit", self.recipe])
        self.assertIn("--release", steps["verify-final"])
        self.assertEqual(steps["qualify"][steps["qualify"].index("--recipe-commit") + 1], self.recipe)
        self.assertRegex(self.log_text(), r" release\n")
        self.assertEqual(self.status(run)[1]["qualified"], "yes")

    def test_fetch_returns_exactly_the_three_assets_and_the_signed_qualification(self):
        run = self.run_of(self.build())
        result = self.door(f"fetch {run}")
        self.assertEqual(result.returncode, 0, result.err)
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            members = archive.getmembers()
            self.assertEqual([member.name for member in members],
                             [*ASSETS, *("evidence/" + name for name in EVIDENCE)])
            self.assertTrue(all(member.isreg() and member.uid == 0 and member.gid == 0 and member.uname == "" for member in members))
            self.assertEqual([oct(member.mode) for member in members], ["0o755"] + ["0o644"] * 5)
            sent = {member.name: archive.extractfile(member).read() for member in members}
        self.assertEqual(sent[ASSETS[0]], (self.fixture / "assets" / ASSETS[0]).read_bytes())
        self.assertEqual(sent[ASSETS[1]], (self.fixture / "assets" / ASSETS[1]).read_bytes())
        self.assertEqual(sent["evidence/qualification.json"], (self.fixture / "qualification.json").read_bytes())
        self.assertNotIn(b"PRIVATE KEY", b"".join(sent.values()))
        self.assertEqual(self.door(f"fetch {run}").stdout, result.stdout)  # fetch never changes the run

    def test_the_door_prints_only_allowlisted_progress_never_raw_output(self):
        result = self.build(extra={"OMP_TEST_NOISE": "prepare"})
        self.assertEqual(result.returncode, 0, result.out)
        for leaked in ("hunter2", "/home/ompbuild", "10.1.2.3", "raw diagnostic"):
            self.assertNotIn(leaked, result.out)
        self.assertIn("Phase: fine line from the recipe.", result.out)
        failed = self.build(extra={"OMP_TEST_FAIL": "prepare"})
        self.assertEqual(failed.returncode, 1)
        self.assertNotIn("raw diagnostic", failed.out)

    def test_a_failing_step_ends_the_run_failed_with_a_fixed_reason_and_nothing_to_fetch(self):
        cases = {"check": "the application does not match this recipe", "qualify": "qualification failed",
                 "verify-final": "final verification failed"}
        for step, reason in cases.items():
            with self.subTest(step=step):
                result = self.build(extra={"OMP_TEST_FAIL": step})
                self.assertEqual(result.returncode, 1, result.out)
                self.assertEqual(result.out.splitlines()[-1], "state: failed")
                run = self.run_of(result)
                code, values = self.status(run)
                self.assertEqual((code, values["state"], values["qualified"], values["reason"], values["cleanup"]),
                                 (1, "failed", "no", reason, "proven"))
                self.assertFalse((self.run_dir(run) / "out").exists())
                self.assertRefused(self.door(f"fetch {run}"), "the run is not a finished successful build")
                self.assertEqual(self.store()["containers"], {})
                self.door(f"cleanup {run}")

    def test_a_run_that_never_qualified_never_returns_a_binary(self):
        result = self.build(extra={"OMP_TEST_QUALIFY": "skip"})
        self.assertEqual(result.returncode, 1, result.out)
        run = self.run_of(result)
        code, values = self.status(run)
        self.assertEqual((values["state"], values["qualified"]), ("failed", "no"))
        self.assertRefused(self.door(f"fetch {run}"), "the run is not a finished successful build")

    def test_the_door_refuses_a_defective_result_at_the_end_of_its_own_build(self):
        for name, options in (("a check is not passed", {"manifest_edit": lambda manifest: manifest["checks"].update(elf="not_run")}),
                              ("the binary is not x86-64", {"machine": 183})):
            with self.subTest(defect=name):
                self.write_fixture(**options)
                result = self.build()
                self.assertEqual(result.returncode, 1, result.out)
                run = self.run_of(result)
                code, values = self.status(run)
                self.assertEqual((values["state"], values["qualified"]), ("failed", "no"), name)
                self.assertEqual(values["reason"], "the door's own verification refused the result")
                self.assertFalse((self.run_dir(run) / "out").exists())
                self.assertRefused(self.door(f"fetch {run}"), "not a finished successful build")
                self.door(f"cleanup {run}")

    def test_the_door_verifies_a_result_independently_and_refuses_each_defect(self):
        run = self.run_of(self.build())
        out = self.run_dir(run) / "out"

        def install(**options):
            """Replace the run's outputs with a self-consistent, really signed set that has exactly one defect."""
            with tempfile.TemporaryDirectory() as received:
                received = Path(received)
                make_received(received, self.app, self.recipe, **options)
                for name in ASSETS:
                    shutil.copyfile(received / name, out / "assets" / name)
                for name in EVIDENCE:
                    shutil.copyfile(received / "evidence" / name, out / "evidence" / name)

        cases = {
            "a check is missing": {"manifest_edit": lambda manifest: manifest["checks"].pop("native_grep")},
            "a check is not passed": {"manifest_edit": lambda manifest: manifest["checks"].update(elf="not_run")},
            "the application commit differs": {"manifest_edit": lambda manifest: manifest["source"].update(commit="d" * 40)},
            "the schema is wrong": {"manifest_edit": lambda manifest: manifest.update(schema=1)},
            "an unexpected tag": {"manifest_edit": lambda manifest: manifest["source"].update(tag=TAG)},
            "a partial qualification": {"manifest_edit": lambda manifest: manifest["qualification"]["checks"].update(cli="failed")},
            "the qualification names another binary": {"manifest_edit": lambda manifest: manifest["qualification"].update(binary_sha256="0" * 64)},
            "the target is wrong": {"manifest_edit": lambda manifest: manifest.update(target="linux-arm64")},
            "the binary is not x86-64": {"machine": 183},
            "the attestation does not bind the manifest": {"binding_edit": lambda binding: binding.replace(b"candidate", b"release")},
            "the attestation is signed by a key the signers file does not hold": {"signer": "other"},
        }
        for name, options in cases.items():
            with self.subTest(defect=name):
                install(**options)
                result = self.door(f"fetch {run}")
                self.assertEqual(result.returncode, 2, name)
                self.assertTrue(result.stdout.startswith(b"refused: the run is not qualified"), result.stdout[:80])
                self.assertNotIn(b"ustar", result.stdout)
        install()  # control: the same construction without a defect is accepted
        self.assertEqual(self.door(f"fetch {run}").returncode, 0)

    def test_a_result_tampered_with_at_rest_is_refused_at_fetch(self):
        run = self.run_of(self.build())
        out = self.run_dir(run) / "out"
        original = {path: path.read_bytes() for path in out.rglob("*") if path.is_file()}

        def restore():
            for path in list(out.rglob("*")):
                if path.is_symlink() or path.is_file():
                    path.unlink()
            for path, data in original.items():
                path.write_bytes(data)

        def append_to_binary():
            with open(out / "assets" / ASSETS[0], "ab") as stream:
                stream.write(b"x")

        def swap_signature():
            with tempfile.TemporaryDirectory() as keys:
                key, _ = make_key(keys)
                copy = Path(keys) / EVIDENCE[0]
                copy.write_bytes((out / "evidence" / EVIDENCE[0]).read_bytes())
                sign(key, copy)
                shutil.copyfile(Path(keys) / EVIDENCE[1], out / "evidence" / EVIDENCE[1])

        def delete_signature():
            (out / "evidence" / EVIDENCE[1]).unlink()

        def symlink_binary():
            (out / "assets" / ASSETS[0]).unlink()
            (out / "assets" / ASSETS[0]).symlink_to(self.fixture / "assets" / ASSETS[0])

        def extra_file():
            (out / "assets" / "extra").write_text("x")

        def flip_sums():
            (out / "assets" / ASSETS[2]).write_text("0" * 64 + "  omp-linux-amd64\n")

        for tamper in (append_to_binary, swap_signature, delete_signature, symlink_binary, extra_file, flip_sums):
            with self.subTest(tamper=tamper.__name__):
                tamper()
                result = self.door(f"fetch {run}")
                self.assertEqual(result.returncode, 2, result.out)
                self.assertIn(b"refused: the run is not qualified", result.stdout)
                self.assertNotIn(b"ustar", result.stdout)
                restore()
        self.assertEqual(self.door(f"fetch {run}").returncode, 0)

    def test_fetch_of_an_unknown_or_symlinked_run_is_refused(self):
        self.assertRefused(self.door("fetch b20261023153012-3fa9c1d2"), "refused: no such run")
        runs = self.state / "runs"
        runs.mkdir(parents=True)
        target = self.temporary / "elsewhere"
        target.mkdir()
        (runs / "b20261023153012-3fa9c1d2").symlink_to(target)
        for verb in ("status", "fetch", "cleanup"):
            self.assertRefused(self.door(f"{verb} b20261023153012-3fa9c1d2"), "refused: no such run")
        self.assertTrue(target.is_dir())


class ConcurrencyAndLimitTests(DoorCase):
    def blocked(self, step="qualify", **more):
        extra = {"OMP_TEST_BLOCK": step, **more}
        session = Session(self, self.build_command(), self.bundles[""], extra)
        self.addCleanup(reap, session.process)
        first = session.line()
        self.assertRegex(first, rf"^run {RUN_ID}$")
        self.eventually(lambda: Path(str(self.gate) + ".ready").exists())
        return session, first.split()[1], extra

    def test_only_one_build_runs_at_a_time_and_the_lock_outlives_the_connection(self):
        session, run, extra = self.blocked()
        second = self.build(extra=extra)
        self.assertRefused(second, "refused: another build is running")
        session.process.kill()
        session.process.wait()
        self.assertRefused(self.build(extra=extra), "refused: another build is running")
        self.assertEqual(self.runs(), [run])
        self.gate.write_text("open")
        code, values = self.finished(run)
        self.assertEqual((code, values["state"]), (0, "succeeded"))
        third = self.build()
        self.assertEqual(third.returncode, 0, third.out)

    def test_a_disconnect_leaves_the_detached_build_running_and_it_finishes(self):
        session, run, _ = self.blocked()
        session.process.kill()  # the ssh connection is gone
        session.process.wait()
        code, values = self.status(run)
        self.assertEqual((code, values["state"], values["phase"]), (3, "running", "qualify"))
        self.gate.write_text("open")
        code, values = self.finished(run)
        self.assertEqual((code, values["state"], values["qualified"], values["cleanup"]), (0, "succeeded", "yes", "proven"))
        self.assertEqual(self.door(f"fetch {run}").returncode, 0)

    def test_a_client_that_stops_reading_ends_quietly_while_the_build_goes_on(self):
        session, run, _ = self.blocked()
        session.process.stdout.close()
        self.gate.write_text("open")
        self.assertEqual(session.process.wait(timeout=30), 0)
        self.assertEqual(session.process.stderr.read(), b"")
        self.assertEqual(self.finished(run)[1]["state"], "succeeded")

    def test_cleanup_cancels_a_running_build_and_proves_removal(self):
        session, run, _ = self.blocked()
        pids = [int(value) for value in self.pids.read_text().split()]
        self.assertEqual(len(self.store()["containers"]), 1)  # the prepare step's leftover
        result = self.door(f"cleanup {run}")
        self.assertEqual((result.returncode, result.out), (0, f"cleaned {run}\n"))
        self.assertEqual(self.runs(), [])
        self.assertEqual((self.store()["containers"], self.store()["images"]), ({}, {}))
        for pid in pids:  # the whole process group of the step died, not just its leader
            self.eventually(lambda pid=pid: not self.alive(pid))
        self.assertRegex(self.log_text(), rf"build {run} 143 ")
        self.assertDockerStayedInside()
        self.assertEqual(session.process.wait(timeout=20), 1)  # the follower saw its run removed

    @staticmethod
    def alive(pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        stat = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], stdout=subprocess.PIPE, check=False).stdout.strip()
        return stat != b"" and not stat.startswith(b"Z")

    def test_the_whole_run_timeout_kills_the_step_and_cleans_up(self):
        result = self.build(extra={"OMP_TEST_BLOCK": "qualify", "OMP_BUILD_RUN_SECONDS": "2.5"})
        self.assertEqual(result.returncode, 1, result.out)
        self.assertEqual(result.out.splitlines()[-1], "state: timeout")
        run = self.run_of(result)
        code, values = self.status(run)
        self.assertEqual((code, values["state"], values["qualified"], values["cleanup"]), (1, "timeout", "no", "proven"))
        self.assertEqual(values["reason"], "the whole-run timeout expired")
        for pid in [int(value) for value in self.pids.read_text().split()]:
            self.eventually(lambda pid=pid: not self.alive(pid))
        self.assertEqual(self.store()["containers"], {})
        self.assertRegex(self.log_text(), rf"build {run} 124 ")
        self.assertRefused(self.door(f"fetch {run}"), "not a finished successful build")

    def test_the_run_folder_watch_stops_a_runaway_step(self):
        for flood, limit in (("bytes", {"OMP_BUILD_RUN_MAX_BYTES": "100000"}), ("files", {"OMP_BUILD_RUN_MAX_ENTRIES": "150"})):
            with self.subTest(flood=flood):
                result = self.build(extra={"OMP_TEST_BLOCK": "prepare", "OMP_TEST_FLOOD": flood, **limit})
                self.assertEqual(result.returncode, 1, result.out)
                code, values = self.status(self.run_of(result))
                self.assertEqual((values["state"], values["qualified"]), ("failed", "no"))
                self.assertIn("the run folder exceeds its", values["reason"])
                self.door("cleanup " + self.run_of(result))

    def test_free_space_falling_below_the_floor_stops_the_run(self):
        result = self.build(extra={"OMP_TEST_BLOCK": "prepare", "OMP_BUILD_FREE_RUNNING_BYTES": str(10**18)})
        self.assertEqual(result.returncode, 1, result.out)
        code, values = self.status(self.run_of(result))
        self.assertEqual(values["reason"], "free space on the build data folder fell below the floor")

    def test_a_vanished_supervisor_is_reported_and_its_leftovers_are_swept_by_the_next_build(self):
        session, run, extra = self.blocked()
        pid = json.loads((self.run_dir(run) / "state.json").read_text())["pid"]
        os.kill(pid, signal.SIGKILL)
        self.eventually(lambda: self.status(run)[1]["state"] == "failed")
        code, values = self.status(run)
        self.assertEqual((code, values["reason"]), (1, "the supervisor vanished (host restart?)"))
        self.assertTrue(self.store()["containers"])  # not yet swept
        self.gate.write_text("open")
        for line in self.pids.read_text().split():
            self.kill(int(line))
        follow = session.process.wait(timeout=30)
        self.assertEqual(follow, 1)
        self.gate.unlink()
        Path(str(self.gate) + ".ready").unlink()
        third = self.build()
        self.assertEqual(third.returncode, 0, third.out)
        self.assertEqual(self.store()["containers"], {})
        recovered = json.loads((self.run_dir(run) / "state.json").read_text())
        self.assertEqual((recovered["state"], recovered["cleanup"], recovered["qualified"]), ("failed", "proven", False))

    def test_only_the_newest_three_finished_runs_are_kept_for_at_most_a_week(self):
        runs = self.state / "runs"
        runs.mkdir(parents=True)
        now = time.time()

        def finished(name, age):
            folder = runs / name
            folder.mkdir()
            (folder / "state.json").write_text(json.dumps({"schema": 1, "state": "succeeded", "cleanup": "proven"}))
            os.utime(folder, (now - age, now - age))
            return folder

        names = [f"b2026102300000{index}-0000000{index}" for index in range(5)]
        folders = [finished(name, 100 - 10 * index) for index, name in enumerate(names)]  # the last is the newest
        (runs / "notes").mkdir()
        (runs / "link").symlink_to(self.temporary)
        sweep = {"OMP_BUILD_MEMORY_BYTES": str(10**18)}  # a refused build still runs the purge under the lock
        self.assertRefused(self.build(extra=sweep), "available memory is below the start floor")
        self.assertEqual(sorted(path.name for path in runs.iterdir() if path.name.startswith("b")), names[2:])
        self.assertTrue((runs / "notes").is_dir() and (runs / "link").is_symlink())
        self.assertTrue(self.temporary.is_dir())
        os.utime(folders[2], (now - 8 * 86400, now - 8 * 86400))
        self.assertRefused(self.build(extra=sweep), "available memory is below the start floor")
        self.assertEqual(sorted(path.name for path in runs.iterdir() if path.name.startswith("b")), names[3:])


class RemovalProofTests(DoorCase):
    def test_unproven_removal_keeps_the_run_and_blocks_the_next_build_until_it_is_cleaned(self):
        result = self.build(extra={"OMP_TEST_STUBBORN": "1"})
        self.assertEqual(result.returncode, 0, result.out)
        run = self.run_of(result)
        code, values = self.status(run)
        self.assertEqual((values["state"], values["cleanup"]), ("succeeded", "unproven"))
        self.assertTrue(self.store()["containers"])
        self.assertRefused(self.build(), f"refused: run {run} has unproven container removal; run cleanup for it first")
        stubborn = self.door(f"cleanup {run}", extra={"OMP_TEST_STUBBORN": "1"})
        self.assertRefused(stubborn, "refused: container removal could not be proven; the run is kept")
        self.assertTrue(self.run_dir(run).is_dir())
        self.assertEqual(self.status(run)[1]["cleanup"], "unproven")
        cleaned = self.door(f"cleanup {run}")
        self.assertEqual((cleaned.returncode, cleaned.out), (0, f"cleaned {run}\n"))
        self.assertEqual(self.store()["containers"], {})
        self.assertFalse(self.run_dir(run).exists())
        self.assertEqual(self.build().returncode, 0)
        self.assertDockerStayedInside()

    def test_removal_sweeps_by_exact_run_label_and_by_fixed_name_and_never_forces_images(self):
        run = self.run_of(self.build())
        store = self.store()
        by_name = "9" * 64
        by_label = "8" * 64
        store["containers"][by_name] = {"run": "", "name": f"omp-build-{run}-prepare"}
        store["containers"][by_label] = {"run": run, "name": "renamed"}
        store["containers"]["7" * 64] = {"run": "b20200101000000-deadbeef", "name": "omp-build-b20200101000000-deadbeef-prepare"}
        store["images"]["sha256:" + "6" * 64] = {"run": run, "created": "2026-10-23T00:00:09Z"}
        store["calls"] = []
        self.store_path.write_text(json.dumps(store))
        self.assertEqual(self.door(f"cleanup {run}").returncode, 0)
        self.assertEqual(set(self.store()["containers"]), {"7" * 64})
        self.assertEqual(self.store()["images"], {})
        removed = [call for call in self.store()["calls"] if call[:2] == ["image", "rm"]]
        self.assertTrue(removed)
        self.assertTrue(all(call[:3] == ["image", "rm", "--no-prune"] and "--force" not in call for call in removed))
        self.assertDockerStayedInside()

    def test_a_daemon_that_stops_answering_never_counts_as_proof(self):
        run = self.run_of(self.build())
        broken = self.bin / "docker"
        broken.write_text("#!/bin/sh\nexit 1\n")
        result = self.door(f"cleanup {run}")
        self.assertRefused(result, "container removal could not be proven; the run is kept")
        self.assertTrue(self.run_dir(run).is_dir())


if __name__ == "__main__":
    unittest.main()
