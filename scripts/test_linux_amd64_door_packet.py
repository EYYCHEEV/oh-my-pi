#!/usr/bin/env python3
"""Offline checks of the ci-001 install packet, docs/ci001-build-door.md.

Nothing is installed or contacted. The fenced scripts are syntax-checked, the read-only fact script is checked for
anything that writes, the address mask is exercised, and the packet is cross-checked against the entry and the Mac
driver so the three cannot drift apart.
"""
import functools
import hashlib
import http.server
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest

import test_linux_amd64_door as door_tests

ROOT = Path(__file__).resolve().parent.parent
PACKET = ROOT / "docs" / "ci001-build-door.md"
ENTRY = door_tests.ENTRY
PUBLIC_KEY = Path.home() / ".ssh" / "omp-ci001-build.pub"
FENCE_ADDRESSES = {"10.0.0.0", "172.16.0.0", "192.168.0.0", "100.64.0.0", "169.254.0.0", "198.18.0.0", "198.18.0.1", "127.0.0.0", "100.100.100.100"}


def blocks():
    found = {}
    for kind, title, body in re.findall(r"^```(\w+) ?([\w.-]*)\n(.*?)^```$", PACKET.read_text(), re.MULTILINE | re.DOTALL):
        found[title or kind + str(len(found))] = (kind, body)
    return found


def heredoc(script, header):
    found = re.search(re.escape(header) + r"\n(.*?)\nEOF\n", script, re.DOTALL)
    assert found, header
    return found[1]


BASH = shutil.which("bash") or "bash"
PROTECTED = [ipaddress.ip_network(value) for value in ("198.18.0.0/15", "127.0.0.0/8", "::1/128")]


def base_image_pin():
    return re.search(r"(?m)^ARG BASE_IMAGE=(\S+)$", (ROOT / "scripts" / "linux-amd64.Dockerfile").read_text())[1]


def smoke_blocks():
    """The bash blocks inside Part E's numbered steps (indented in the packet), dedented."""
    section = PACKET.read_text().split("## Part E. Smoke steps", 1)[1].split("\n## ", 1)[0]
    return [textwrap.dedent(body) for _, body in re.findall(r"^( +)```bash\n(.*?)^\1```$", section, re.MULTILINE | re.DOTALL)]


def fence_overlaps(fence):
    """Networks in the fence's drop sets that overlap the proxy's fake-address range or loopback (the lone gateway host rule is not a set)."""
    found = []
    for _, target in re.findall(r"(?m)^\s*meta skuid \$uid (ip6?) daddr (\{[^}]*\}|\S+) counter drop$", fence):
        if target.startswith("{"):
            for item in target.strip("{} ").split(","):
                network = ipaddress.ip_network(item.strip())
                found += [str(network) for protected in PROTECTED if network.version == protected.version and network.overlaps(protected)]
    return found


def stub_commands(work, stubs):
    """Write recording stub commands into work/bin and return an environment that finds them first."""
    (work / "bin").mkdir()
    for name, body in stubs.items():
        (work / "bin" / name).write_text("#!/bin/sh\n" + body)
        (work / "bin" / name).chmod(0o755)
    return {"PATH": f"{work / 'bin'}:/usr/bin:/bin", "HOME": str(work), "LANG": "C"}


def run_bash(script, cwd, environment, **variables):
    return subprocess.run([BASH, "-euo", "pipefail", "-c", script], cwd=cwd, env={**environment, **variables}, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, timeout=60, check=False)


class PacketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = PACKET.read_text()
        cls.blocks = blocks()
        cls.install = cls.blocks["install-host.sh"][1]
        cls.undo = cls.blocks["install-host-undo.sh"][1]
        cls.facts = cls.blocks["host-facts.sh"][1]
        cls.entry = ENTRY.read_text()

    def test_the_packet_has_every_part_the_brief_asks_for(self):
        for heading in ("## Part A. Read-only fact script", "## Part B. Install", "## Part C. The authorized_keys line",
                        "## Part D. The Mac side", "## Part E. Smoke steps", "## Part F. Undo"):
            self.assertIn(heading, self.text)
        self.assertEqual({"host-facts.sh", "install-host.sh", "install-host-undo.sh", "authorized_keys",
                          "public-key-argument"} - set(self.blocks), set())

    def test_every_fenced_shell_script_parses(self):
        for title, (kind, body) in self.blocks.items():
            if kind in ("bash", "sh"):
                with self.subTest(block=title):
                    checked = subprocess.run(["bash", "-n"], input=body.encode(), stderr=subprocess.PIPE, check=False)
                    self.assertEqual(checked.returncode, 0, checked.stderr.decode())

    def test_the_entry_hash_in_the_packet_is_the_hash_of_the_entry_file(self):
        digest = hashlib.sha256(ENTRY.read_bytes()).hexdigest()
        pin = base_image_pin()  # the recipe's base image digest is the only other 64-hex value, and it is the Dockerfile's own pin
        self.assertEqual(self.text.count(pin), 1)
        self.assertEqual(re.findall(r"[0-9a-f]{64}", self.text.replace(pin, "")), [digest, digest])
        self.assertIn(f"ENTRY_SHA={digest}", self.install)

    PROXY_CALL = "systemctl list-units --type=service --all --no-legend --plain *mihomo* *clash*"

    def run_facts(self, canned_extra=None):
        """Run the fact script for real with every host-inspecting command replaced by a recording stub.

        Returns what it printed and the recorded calls; every call must be a read-only one.
        """
        read_only = {
            "docker": lambda a: a == ["--version"] or a == ["buildx", "version"] or (a[:1] == ["info"] and "--format" in a),
            "nft": lambda a: a == ["list", "tables"],
            "systemctl": lambda a: a[:1] == ["list-units"] or (a[:1] == ["is-active"] and len(a) == 2),
            "sysctl": lambda a: a[:1] == ["-n"] and len(a) == 2,
            "dpkg-query": lambda a: a[:1] == ["-W"],
            "getent": lambda a: a == ["passwd", "ompbuild"],
            "ss": lambda a: a[:1] == ["-ltnH"],
            "ufw": lambda a: a == ["status"],
            "sshd": lambda a: a == ["-T"],
            "systemd-analyze": lambda a: a[:1] == ["cat-config"],
            "findmnt": lambda a: not any(item.startswith(("-M", "--mount", "-U", "--umount")) for item in a),
            "stat": lambda a: a[:1] == ["-fc"],
            "nproc": lambda a: a == [],
            "df": lambda a: a[:1] == ["-BG"],
            "python3": lambda a: a == ["--version"],
            "git": lambda a: a == ["--version"],
        }
        forbidden = ("rm", "mv", "cp", "tee", "install", "chmod", "chown", "mkdir", "touch", "useradd", "usermod", "mount", "umount",
                     "loginctl", "runuser", "curl", "wget", "ssh-keygen", "fallocate", "mkfs.ext4", "tailscale", "kill", "pkill", "dd")
        v4 = ".".join(("203", "0", "113", "9"))
        v6 = "2001:" + "db8::17"
        canned = {
            "ss": f"LISTEN 0 128 {v4}:2223 0.0.0.0:*\nLISTEN 0 128 [{v6}]:22 [::]:*\nLISTEN 0 128 127.0.0.1:631 0.0.0.0:*\n",
            "sshd": f"port 22\nlistenaddress {v4}:22\nacceptenv LANG\nusepam yes\n",
            "docker": f"server=29.8.1 root=/data/docker containers=0 {v4}\n",
            "nft": "table inet cdm_fence\n",
            "systemctl": f"swan-ci-sshd.service loaded active running SWAN door via {v4}\n",
            # The proxy probe is told apart by its exact arguments: a unit with an address in its description must be masked.
            self.PROXY_CALL: f"devbox-mihomo.service loaded active running Outbound proxy at {v4}\n",
            **(canned_extra or {}),
        }
        stub = "#!" + sys.executable + (
            "\nimport json, os, sys\n"
            "name = os.path.basename(sys.argv[0])\n"
            "with open(os.environ['STUB_LOG'], 'a') as log:\n"
            "    log.write(json.dumps([name, *sys.argv[1:]]) + '\\n')\n"
            "canned = json.loads(os.environ['STUB_OUTPUT'])\n"
            "sys.stdout.write(canned.get(' '.join([name, *sys.argv[1:]]), canned.get(name, '')))\n"
            "sys.exit(2 if name == 'getent' else 0)\n")
        with tempfile.TemporaryDirectory(prefix="omp-facts-") as directory:
            work = Path(directory)
            stubs = work / "stubs"
            stubs.mkdir()
            for name in (*read_only, *forbidden):
                (stubs / name).write_text(stub)
                (stubs / name).chmod(0o755)
            script = work / "host-facts.sh"
            script.write_text(re.sub(r"export LC_ALL=C PATH=\S+", f"export LC_ALL=C PATH={stubs}:/usr/bin:/bin:/usr/sbin:/sbin", self.facts))
            before = {path for path in work.rglob("*")}
            environment = {"PATH": f"{stubs}:/usr/bin:/bin", "STUB_LOG": str(work / "calls.log"), "STUB_OUTPUT": json.dumps(canned),
                           "HOME": str(work), "LANG": "C"}
            result = subprocess.run(["bash", str(script)], cwd=work, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=60, check=False)
            shown = result.stdout.decode()
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            calls = [json.loads(line) for line in (work / "calls.log").read_text().splitlines()]
            self.assertTrue(calls)
            for name, *arguments in calls:
                self.assertIn(name, read_only, f"{name} is not a read-only command: {arguments}")
                self.assertTrue(read_only[name](arguments), f"{name} {arguments} is not a read-only call")
            self.assertEqual({path for path in work.rglob("*")} - before - {work / "calls.log"}, set(), "the script created files")
            for leaked in (v4, v6):
                self.assertNotIn(leaked, shown)
            self.assertIn("<addr>", shown)
        return shown, calls

    def test_the_fact_script_only_ever_reads(self):
        shown, calls = self.run_facts()
        for section in ("== host", "== memory", "== disk", "== tools", "== rootless prerequisites", "== accounts",
                        "== ssh doors and ports", "== firewall and fences", "== outbound proxy", "== paths this install would create"):
            self.assertIn(section, shown)
        self.assertIn("listening ports: 22 631 2223", shown)
        self.assertTrue(self.facts.rstrip().endswith("facts 2>&1 | mask"))

    def test_the_proxy_check_prints_service_names_and_states_only(self):
        shown, calls = self.run_facts()
        self.assertIn(self.PROXY_CALL.split(" ", 1)[0], {call[0] for call in calls})
        self.assertIn(self.PROXY_CALL.split(" ", 1)[1].split(" "), [call[1:] for call in calls])  # the one probe, by exact arguments
        section = shown.split("== outbound proxy", 1)[1].split("\n== ", 1)[0]
        self.assertIn("outbound proxy service present: yes", section)
        self.assertIn("devbox-mihomo.service active running", section)
        self.assertNotIn("Outbound proxy at", section)  # the description column (where an address could hide) is never printed
        self.assertIn("proxy processes:", section)
        self.assertNotRegex(section, r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|:\d{2,5}\b")

    def test_the_proxy_check_says_no_when_no_such_unit_is_listed(self):
        shown, _ = self.run_facts({self.PROXY_CALL: ""})
        section = shown.split("== outbound proxy", 1)[1].split("\n== ", 1)[0]
        self.assertIn("outbound proxy service present: no", section)
        self.assertIn("no proxy service unit listed", section)

    def test_the_optional_docker_proxy_block_is_scoped_validated_and_reversible(self):
        kind, script = self.blocks["optional-docker-proxy.sh"]
        self.assertEqual(kind, "bash")
        self.assertIn("OPTIONAL", script)
        function = re.search(r"(?m)^valid_proxy\(\) \{.*\}$", script)
        self.assertIsNotNone(function)

        def valid(value):
            return subprocess.run(["bash", "-c", function[0] + '\nvalid_proxy "$1"', "bash", value], check=False).returncode == 0

        self.assertTrue(all(valid(value) for value in ("http://proxy.internal:7890", "http://a:1", "http://host-1.example:65535")))
        for bad in ("", "https://proxy:1", "http://user:secret@proxy:1", "http://proxy", "http://proxy:", "http://proxy:123456", "http://proxy:80/",
                    "http://proxy:80 x", "http://proxy:80;id", "http://pro$xy:80", "proxy:80", "http://-x:80", "http://[::1]:80", "http://x:80\nhttp://y:80"):
            with self.subTest(value=bad):
                self.assertFalse(valid(bad))
        # It touches exactly one file under the account's docker.service.d, nothing system-wide, and no real address is typed in.
        self.assertIn("FILE=$DIR/omp-build-proxy.conf", script)
        self.assertIn("DIR=$HOME_DIR/.config/systemd/user/docker.service.d", script)
        code = "\n".join(line for line in script.splitlines() if not line.lstrip().startswith("#"))
        for foreign in ("/etc/", "nft ", "swan", "cdm", "rm -rf", "usermod", "useradd", "fstab", "curl", "docker "):
            self.assertNotIn(foreign, code)
        self.assertEqual(re.findall(r"\brm -f (\S+)", code), ['"$FILE"'])
        self.assertEqual(re.findall(r"\bsystemctl --user (\S+)", code), ["daemon-reload", "restart", "is-active"])
        self.assertIn("set)", script)
        self.assertIn("undo)", script)
        # The proxy variables are the standard daemon ones, written from the validated argument only.
        for line in ('Environment="HTTP_PROXY=$PROXY"', 'Environment="HTTPS_PROXY=$PROXY"', 'Environment="NO_PROXY=localhost"'):
            self.assertIn(line, script)
        # It refuses to restart the daemon under a build that is running, and refuses links where root writes.
        self.assertIn("/srv/omp-ci/state/runs", script)
        self.assertIn("is a symbolic link", script)
        self.assertIn("### Optional: image pulls of the rootless Docker daemon through the outbound proxy", self.text)
        self.assertIn("Skip this unless Part A printed `outbound proxy service present: yes`", self.text)

    def test_the_address_mask_hides_addresses_and_keeps_names(self):
        mask = next(line for line in self.facts.splitlines() if line.startswith("mask()"))
        v4 = ".".join(("203", "0", "113", "9"))
        v6 = "2001:" + "db8:0:0:0:0:0:17"
        text = f"LISTEN {v4}:22 via {v6} and ::1 on port 2225 ({v4}) docker 29.8.1 20261023T120000Z"
        shown = subprocess.run(["bash", "-c", f"{mask}\nmask"], input=text.encode(), stdout=subprocess.PIPE, check=True).stdout.decode()
        for leaked in (v4, v6, "::1"):
            self.assertNotIn(leaked, shown)
        self.assertIn("port 2225", shown)
        self.assertIn("docker 29.8.1", shown)
        self.assertIn("20261023T120000Z", shown)

    def test_the_authorized_keys_line_is_exact_and_the_key_is_the_public_half(self):
        _, line = self.blocks["authorized_keys"]
        options = 'restrict,command="/usr/local/lib/omp-build/entry",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc'
        self.assertEqual(len(line.strip().splitlines()), 1)
        self.assertTrue(line.startswith(options + " ssh-ed25519 "), line)
        _, argument = self.blocks["public-key-argument"]
        self.assertEqual(line.strip(), options + " " + argument.strip())
        self.assertRegex(argument.strip(), r"^ssh-ed25519 [A-Za-z0-9+/]+=* omp-ci001-build \(stronk-omp linux-amd64 build door, [0-9-]+\)$")
        self.assertNotRegex(self.text, r"PRIVATE KEY")
        if PUBLIC_KEY.is_file():
            self.assertEqual(argument.strip().split()[:2], PUBLIC_KEY.read_text().split()[:2])
        self.assertIn(options.split(",command=")[0], self.install)
        for option in ("no-pty", "no-port-forwarding", "no-agent-forwarding", "no-X11-forwarding", "no-user-rc", "restrict"):
            self.assertIn(option, self.install)

    def test_no_real_address_or_email_is_in_the_packet(self):
        for found in re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", self.text):
            self.assertIn(found, FENCE_ADDRESSES, found)
        self.assertNotRegex(self.text, r"[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}")
        self.assertIn("<ci-001 tailnet address>", self.text)
        for network in re.findall(r"\b((?:\d{1,3}\.){3}\d{1,3}/\d{1,2})\b", self.text):
            self.assertTrue(ipaddress.ip_network(network).is_private or network.startswith("100.64."), network)

    def test_the_packet_and_the_entry_agree_on_paths_and_limits(self):
        for default in ("/srv/omp-ci/state", "/srv/omp-ci", "/var/log/omp-build", "/etc/omp-build"):
            self.assertIn(f'Path("{default}")', self.entry)
        for path in ("/srv/omp-ci", "/srv/omp-ci.img", "/var/log/omp-build", "/etc/omp-build", "/usr/local/lib/omp-build/entry",
                     "/usr/local/lib/omp-build/bin/busctl", "omp-build-sshd.service", "omp-build-fence.service", "omp_build_fence"):
            self.assertIn(path, self.install)
            if path not in ("/usr/local/lib/omp-build/entry", "/usr/local/lib/omp-build/bin/busctl", "/var/log/omp-build"):
                self.assertIn(path.split("/")[-1] if path.startswith("/usr") else path, self.undo.replace("/usr/local/lib/omp-build", "omp-build"))
        for value in ("256 * 1024**2", "150 * 1024**3", "12 * 1024**3", "32 * 1024**3", "14400", "150_000", "6 * 1024**3"):
            self.assertIn(value, self.entry)
        for phrase in ("256 MiB", "150 GiB", "12 GiB", "32 GiB", "4 hours", "6 GiB and 150 000 entries", "newest 3 finished runs"):
            self.assertIn(phrase, self.text)
        self.assertIn("ForceCommand /usr/local/lib/omp-build/entry", self.install)
        self.assertNotIn("AcceptEnv ", heredoc(self.install, "put_file /etc/omp-build/sshd_config 0644 root:root <<EOF").split("\n", 3)[3])

    def test_the_packet_the_entry_and_the_driver_agree_on_the_registry_input(self):
        driver = door_tests.driver
        self.assertIn(f'MANIFEST_REF = "{driver.MANIFEST_REF}"', self.entry)
        self.assertIn(f'MANIFEST_FILE = "{driver.MANIFEST_FILE}"', self.entry)
        self.assertIn("MANIFEST_CAP = 1024 * 1024", self.entry)
        self.assertEqual(driver.MANIFEST_CAP, 1024 * 1024)
        for name in ("refs/omp/app", "refs/omp/recipe", driver.MANIFEST_REF):
            self.assertIn(f"`{name}`", self.text)
        self.assertIn("build   <app-40hex> <recipe-40hex> <fork-manifest-sha256-64hex> [<stronk-omp-s1-YYYY.MM.DD.NNNN>]", self.text)
        self.assertIn("build <app-40hex> <recipe-40hex> <fork-manifest-sha256> [<stronk-omp-s1-YYYY.MM.DD.NNNN>]", self.entry)
        self.assertIn("--fork-manifest ", self.text)
        self.assertNotIn("5e43891a87140fb0972c982f3027f0228c4f6378", self.text)  # no application commit is baked into the packet

    def test_the_install_never_touches_the_other_ci_doors_and_the_undo_removes_everything_it_adds(self):
        for script in (self.install, self.undo):
            for foreign in ("/etc/swan-ci", "/etc/cdm-ci", "/usr/local/lib/swan-ci", "/usr/local/lib/cdm-ci", "swanci", "cdm_fence "):
                self.assertNotIn(foreign, "\n".join(line for line in script.splitlines() if not line.lstrip().startswith("#")))
        for added in ("omp-build-sshd.service", "omp-build-fence.service", "omp_build_fence", "/etc/omp-build", "/usr/local/lib/omp-build",
                      "disable-linger", "service.d", "fstab", "REMOVE_DATA", "REMOVE_ACCOUNT", "REMOVE_LOGS"):
            self.assertIn(added, self.undo)
        self.assertIn("pkill -TERM", self.undo)
        self.assertLess(self.undo.index("omp-build-sshd.service"), self.undo.index("pkill -TERM"), "the door must go off first")

    def test_the_install_encodes_the_security_decisions(self):
        config = heredoc(self.install, "put_file /etc/omp-build/sshd_config 0644 root:root <<EOF")
        for directive in ("AllowUsers $U", "AuthenticationMethods publickey", "PasswordAuthentication no", "PermitRootLogin no",
                          "UsePAM no", "StrictModes yes", "AuthorizedKeysFile /etc/omp-build/authorized_keys/%u",
                          "ForceCommand /usr/local/lib/omp-build/entry", "DisableForwarding yes", "AllowTcpForwarding no",
                          "PermitTTY no", "PermitUserRC no", "PermitUserEnvironment no", "ListenAddress $TAILNET_IP:$PORT"):
            self.assertIn(directive, config)
        self.assertNotRegex(config, r"(?m)^(AcceptEnv|SetEnv|PermitUserEnvironment yes|AllowAgentForwarding yes)")
        self.assertIn("KillMode=process", self.install)
        self.assertIn("usermod -p '*'", self.install)
        self.assertIn("RequiresMountsFor=/srv/omp-ci", self.install)
        self.assertIn("Delegate=cpu cpuset io memory pids", self.install)
        self.assertRegex(self.install, r"useradd --create-home --user-group --shell /bin/bash")
        self.assertIn("must not belong to sudo or docker", self.install)
        self.assertNotRegex(self.install, r"usermod -aG|usermod -a -G|adduser .* (sudo|docker)")
        fence = heredoc(self.install, "put_file /etc/omp-build/fence.nft 0644 root:root <<EOF")
        for line in ("meta skuid $uid ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 } counter drop",
                     "meta skuid $uid ip6 daddr { fc00::/7, fe80::/10 } counter drop"):
            self.assertIn(line, fence)
        self.assertIn("tailscale ip -4", self.install)
        self.assertNotRegex(self.install, r"tailscale\s+(status|netcheck|ping)")

    def test_the_door_configuration_parses_with_this_machines_sshd(self):
        sshd = shutil.which("sshd") or ("/usr/sbin/sshd" if os.access("/usr/sbin/sshd", os.X_OK) else None)
        if sshd is None or shutil.which("ssh-keygen") is None:
            self.skipTest("sshd is not available")
        config = heredoc(self.install, "put_file /etc/omp-build/sshd_config 0644 root:root <<EOF")
        with tempfile.TemporaryDirectory(prefix="omp-sshd-") as directory:
            key = Path(directory) / "host"
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)], check=True)
            text = config.replace("$U", "ompbuild").replace("$TAILNET_IP", "127.0.0.1").replace("$PORT", "2225")
            text = text.replace("/etc/omp-build/ssh_host_ed25519_key", str(key)).replace("/etc/omp-build/authorized_keys/%u", str(Path(directory) / "%u"))
            path = Path(directory) / "sshd_config"
            path.write_text(text)
            checked = subprocess.run([sshd, "-t", "-f", str(path)], stderr=subprocess.PIPE, check=False)
            message = checked.stderr.decode()
            self.assertNotRegex(message, r"Bad configuration option|Unsupported option|line \d+|Missing|Bad ", "sshd rejected the door's configuration")

    def test_the_mac_alias_block_matches_the_driver_and_resolves(self):
        _, alias = next(item for key, item in self.blocks.items() if item[0] == "sshconfig")
        self.assertIn("Host " + door_tests.driver.DEFAULT_ALIAS + "\n", alias)
        self.assertIn("IdentityFile " + door_tests.driver.DEFAULT_KEY, alias)
        for directive in ("Port 2225", "User ompbuild", "IdentitiesOnly yes", "BatchMode yes", "StrictHostKeyChecking yes",
                          "ControlPath none", "ForwardAgent no", "RequestTTY no", "ClearAllForwardings yes"):
            self.assertIn(directive, alias)
        if shutil.which("ssh") is None:
            self.skipTest("ssh is not available")
        with tempfile.TemporaryDirectory(prefix="omp-ssh-") as directory:
            config = Path(directory) / "config"
            config.write_text(alias.replace("<ci-001 tailnet address>", "door.invalid"))
            resolved = subprocess.run(["ssh", "-G", "-F", str(config), door_tests.driver.DEFAULT_ALIAS], stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, check=False)
            self.assertEqual(resolved.returncode, 0, resolved.stderr.decode())
            facts = dict(line.split(" ", 1) for line in resolved.stdout.decode().splitlines() if " " in line)
            self.assertEqual((facts["hostname"], facts["port"], facts["user"]), ("door.invalid", "2225", "ompbuild"))
            self.assertEqual((facts["identitiesonly"], facts["batchmode"], facts["forwardagent"], facts["requesttty"]),
                             ("yes", "yes", "no", "false"))
            self.assertEqual(facts.get("controlpath", "none"), "none")
            self.assertEqual((facts["stricthostkeychecking"], facts["clearallforwardings"]), ("true", "yes"))

    def test_every_smoke_and_undo_step_is_present(self):
        for step in ("refused: invalid command", "refused: no such run", "name=rootless", "omp_build_fence",
                     "ci001-smoke-1", "all nine checks passed", "cleanup", "--resume"):
            self.assertIn(step, self.text)
        for step in ("REMOVE_DATA=1", "REMOVE_ACCOUNT=1", "Host cdm-ci-001-ompbuild"):
            self.assertIn(step, self.text)

    # ---- correction round after the independent review (B1, N2 to N7) and the later ci-001 egress facts ------------------

    def fence_heredoc(self):
        return heredoc(self.install, "put_file /etc/omp-build/fence.nft 0644 root:root <<EOF")

    def test_the_data_image_stays_allocated_and_appears_only_after_mkfs_succeeded(self):  # B1 and the image part of N5
        self.assertIn('mkfs.ext4 -q -F -m 0 -E nodiscard -L omp-ci "$IMG.new"', self.install)
        self.assertNotIn('-L omp-ci "$IMG"', self.install)
        block = re.search(r"(?m)^if \[\[ ! -e \$IMG \]\]; then\n.*?^fi$", self.install, re.DOTALL)[0]
        with tempfile.TemporaryDirectory(prefix="omp-img-") as directory:
            work = Path(directory)
            environment = stub_commands(work, {
                "fallocate": 'echo "fallocate $*" >> "$STUB_LOG"\nfor last; do :; done\n: > "$last"\n',
                "mkfs.ext4": 'echo "mkfs $*" >> "$STUB_LOG"\nexit "${MKFS_EXIT:-0}"\n'})
            image, log = work / "omp-ci.img", work / "calls.log"
            script = f"IMG={image}; IMG_GIB=256\n{block}"
            interrupted = run_bash(script, work, environment, MKFS_EXIT="1", STUB_LOG=str(log))
            self.assertNotEqual(interrupted.returncode, 0)
            self.assertFalse(image.exists(), "an interrupted mkfs must not leave an image a rerun would skip")
            self.assertTrue(Path(f"{image}.new").exists())
            rerun = run_bash(script, work, environment, MKFS_EXIT="0", STUB_LOG=str(log))
            self.assertEqual(rerun.returncode, 0, rerun.stdout.decode())
            self.assertTrue(image.exists())
            self.assertFalse(Path(f"{image}.new").exists())
            self.assertEqual(image.stat().st_mode & 0o777, 0o600)
            calls = log.read_text().splitlines()
            self.assertIn(f"fallocate -l 256G {image}.new", calls)
            self.assertEqual(calls[-1], f"mkfs -q -F -m 0 -E nodiscard -L omp-ci {image}.new")
            log.unlink()
            self.assertEqual(run_bash(script, work, environment, STUB_LOG=str(log)).returncode, 0)
            self.assertFalse(log.exists(), "an existing image must be left alone")
        report = self.install.split("# 7. Report", 1)[1]
        self.assertIn('du -B1G "$IMG"\n', report)
        self.assertIn('du -B1G --apparent-size "$IMG"\n', report)

    def test_the_preflight_stops_before_any_change_without_dbus_user_session_ip_tables_or_a_tailnet_address(self):  # N4, N5
        start, end = self.install.index("[[ $(dpkg-query"), self.install.index("# The address the door listens on")
        self.assertLess(end, self.install.index("useradd "))
        checks = self.install[start:end].replace("/proc/modules", "$MODULES").replace('"/lib/modules/$(uname -r)/modules.builtin"', '"$BUILTIN"')
        self.assertIn("$MODULES", checks)
        self.assertIn("$BUILTIN", checks)
        loaded = "ip_tables 32768 3 iptable_filter,iptable_nat, Live 0x0000000000000000\n"
        other = "iptable_filter 12288 1 - Live 0x0000000000000000\nnf_tables 1 0 - Live 0x0000000000000000\n"
        lookalike = "ip_tables_extra 4096 0 - Live 0x0000000000000000\n"
        cases = (("ii ", loaded, "", 0, ""), ("hi ", loaded, "", 0, ""), ("", loaded, "", 1, "dbus-user-session"), ("rc ", loaded, "", 1, "dbus-user-session"),
                 ("iU ", loaded, "", 1, "dbus-user-session"), ("ii ", other, "kernel/net/ipv4/netfilter/iptable_nat.ko\n", 1, "ip_tables"),
                 ("ii ", "", "", 1, "ip_tables"), ("ii ", lookalike, "kernel/net/not_ip_tables.ko\n", 1, "ip_tables"),
                 ("ii ", other, "kernel/net/ipv4/netfilter/ip_tables.ko\n", 0, ""))
        for status, modules, builtin, code, message in cases:
            with self.subTest(status=status, loaded=bool(modules), builtin=bool(builtin)), tempfile.TemporaryDirectory(prefix="omp-pre-") as directory:
                work = Path(directory)
                environment = stub_commands(work, {"dpkg-query": 'printf "%s" "$DPKG_OUT"\n[ -n "$DPKG_OUT" ] || exit 1\n'})
                (work / "modules").write_text(modules)
                (work / "builtin").write_text(builtin)
                result = run_bash(checks, work, environment, DPKG_OUT=status, MODULES=str(work / "modules"), BUILTIN=str(work / "builtin"))
                self.assertEqual(result.returncode, code, result.stdout.decode())
                self.assertIn(message, result.stdout.decode())
                if code:
                    self.assertIn("stop and ask", result.stdout.decode())
        self.assertEqual(self.install.count("TAILNET_IP=${TAILNET_IP:-"), 1)
        self.assertLess(self.install.index("TAILNET_IP=${TAILNET_IP:-"), self.install.index("useradd "))
        self.assertLess(self.install.index("no tailnet address found"), self.install.index("useradd "))
        self.assertIn("`dbus-user-session`", self.text.split("## Part B. Install", 1)[0])

    def test_the_fence_loads_before_the_account_daemon_and_the_door_requires_it(self):  # N3
        self.assertLess(self.install.index("# 3. Egress fence"), self.install.index("# 4. Rootless Docker"))
        self.assertLess(self.install.index("systemctl restart omp-build-fence.service"), self.install.index("dockerd-rootless-setuptool.sh install"))
        self.assertLess(self.install.index("systemctl restart omp-build-fence.service"), self.install.index("enable --now docker.service"))
        unit = heredoc(self.install, "put_file /etc/systemd/system/omp-build-sshd.service 0644 root:root <<'EOF'").splitlines()
        after = next(index for index, line in enumerate(unit) if line.startswith("After=") and "omp-build-fence.service" in line.split())
        self.assertEqual(unit[after + 1], "Requires=omp-build-fence.service")

    def test_the_fence_runs_ahead_of_the_proxys_nat_redirect_and_never_overlaps_its_range(self):  # N1 and the A2 facts
        fence = self.fence_heredoc()
        self.assertIn("type filter hook output priority mangle - 10; policy accept;", fence)
        self.assertNotRegex(fence, r"priority (filter|mangle)\s*;")
        base, offset = re.search(r"hook output priority (\w+) - (\d+);", fence).groups()
        priority = {"raw": -300, "mangle": -150, "dstnat": -100, "filter": 0}[base] - int(offset)
        self.assertLess(priority, -150, "equal priorities run in undefined order, so stay strictly ahead of the proxy's nat output chain")
        reasons = [line for line in fence.splitlines() if line.lstrip().startswith("#")]
        self.assertEqual(len(reasons), 1)
        for word in ("mangle - 10", "-160", "mihomo", "-150", "NAT"):
            self.assertIn(word, reasons[0])
        self.assertEqual(fence_overlaps(fence), [])
        rules = re.findall(r"(?m)^\s*meta skuid \$uid (ip6?) daddr (\{[^}]*\}|\S+) counter drop$", fence)
        self.assertEqual([target for _, target in rules if not target.startswith("{")], ["198.18.0.1"])  # the one gateway host, as before
        self.assertEqual(len(rules), 3)
        # The checker itself bites: a set that covers the fake-address range, or loopback, is reported.
        self.assertEqual(fence_overlaps(fence.replace("169.254.0.0/16", "198.18.0.0/16")), ["198.18.0.0/16"])
        self.assertEqual(fence_overlaps(fence.replace("fe80::/10", "::1/128")), ["::1/128"])
        self.assertEqual(fence_overlaps(fence.replace("10.0.0.0/8", "127.0.0.0/8")), ["127.0.0.0/8"])
        note = self.text.split("```bash install-host.sh", 1)[1].split("```", 1)[1].split("Release builds also need", 1)[0]
        for phrase in ("198.18.0.0/15", "127.0.0.0/8", "198.18.0.1", "priority mangle - 10"):
            self.assertIn(phrase, note)

    def test_a_rerun_restarts_the_fence_and_the_door_so_changed_files_take_effect(self):  # N5
        for unit in ("omp-build-fence.service", "omp-build-sshd.service"):
            with self.subTest(unit=unit):
                self.assertIn(f"systemctl enable {unit}\n", self.install)
                self.assertNotIn(f"enable --now {unit}", self.install)
                self.assertLess(self.install.index(f"systemctl enable {unit}"), self.install.index(f"systemctl restart {unit}"))
        self.assertLess(self.install.index("/usr/sbin/nft -c -f /etc/omp-build/fence.nft"), self.install.index("systemctl restart omp-build-fence.service"))
        self.assertLess(self.install.index("/usr/sbin/sshd -t -f /etc/omp-build/sshd_config\n"), self.install.index("systemctl restart omp-build-sshd.service"))
        self.assertIn("KillMode=process leaves the detached supervisor alone", self.install)
        self.assertIn("A rerun restarts the fence unit and the door unit", self.text.split("```bash install-host.sh", 1)[0])

    def test_the_undo_refuses_to_remove_the_account_while_its_data_or_logs_stay(self):  # N6
        block = re.search(r"(?m)^if \[\[ \$\{REMOVE_ACCOUNT:-0\} == 1 .*?^fi$", self.undo, re.DOTALL)[0]
        self.assertLess(self.undo.index(block), self.undo.index("systemctl disable --now omp-build-sshd.service"))
        self.assertIn("a reused uid would otherwise own the old build outputs", block)
        with tempfile.TemporaryDirectory(prefix="omp-undo-") as directory:
            work = Path(directory)
            environment = stub_commands(work, {})
            for account, data, logs, refused in ((None, None, None, False), ("0", "0", "0", False), ("0", None, "1", False),
                                                 ("1", None, None, True), ("1", "1", None, True), ("1", None, "1", True),
                                                 ("1", "0", "1", True), ("1", "1", "0", True), ("1", "1", "1", False)):
                with self.subTest(account=account, data=data, logs=logs):
                    variables = {key: value for key, value in (("REMOVE_ACCOUNT", account), ("REMOVE_DATA", data), ("REMOVE_LOGS", logs)) if value is not None}
                    result = run_bash(block + "\necho passed", work, environment, **variables)
                    shown = result.stdout.decode()
                    self.assertEqual(result.returncode, 1 if refused else 0, shown)
                    self.assertEqual("passed" in shown, not refused)
                    if refused:
                        self.assertIn("REMOVE_DATA=1 and REMOVE_LOGS=1", shown)
        self.assertIn('rm -f "$IMG" "$IMG.new"', self.undo)
        self.assertIn("`REMOVE_ACCOUNT=1` is refused unless `REMOVE_DATA=1` and `REMOVE_LOGS=1` are set too", self.text)

    def test_part_e_proves_the_daemon_a_container_and_container_egress_before_the_real_build(self):  # N2, curl-free host checks
        section = self.text.split("## Part E. Smoke steps", 1)[1].split("\n## ", 1)[0]
        step2 = section[section.index("\n2. The rootless daemon"):section.index("\n3. A real candidate build")]
        parts = [step2.index(label) for label in ("a. Daemon facts", "b. A container starts", "c. Egress from a container", "d. The fence from the host")]
        self.assertEqual(parts, sorted(parts))
        self.assertIn("`curl` is not installed on ci-001 and nothing here installs it", step2)
        self.assertIn("If part c fails, stop", step2)
        self.assertIn("cannot fix container egress", step2)
        blocks_in_part_e = smoke_blocks()
        for body in blocks_in_part_e:
            checked = subprocess.run([BASH, "-n"], input=body.encode(), stderr=subprocess.PIPE, check=False)
            self.assertEqual(checked.returncode, 0, checked.stderr.decode())
        facts, limits, egress, host = (next(body for body in blocks_in_part_e if marker in body)
                                       for marker in ("docker info --format", "docker pull", "fence_drops()", "reach()"))
        # a. daemon facts, as the entry reads them
        for key in ("SecurityOptions", "CgroupVersion", "CgroupDriver", "MemoryLimit", "PidsLimit", "CpuCfsQuota", "DockerRootDir"):
            self.assertIn(f'"{key}"', facts)
        self.assertIn("docker buildx version", facts)
        for name in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            self.assertIn(f"-u {name}", facts)
        code = re.search(r"python3 -I -c '(.*?)'\n", facts, re.DOTALL)[1]
        sample = {"ServerVersion": "29.8.1", "SecurityOptions": ["name=rootless"], "CgroupVersion": "2", "CgroupDriver": "systemd",
                  "MemoryLimit": True, "PidsLimit": True, "CpuCfsQuota": True, "SwapLimit": False, "DockerRootDir": "/srv/omp-ci/docker"}
        printed = subprocess.run([sys.executable, "-I", "-c", code], input=json.dumps(sample).encode(), stdout=subprocess.PIPE, check=True).stdout.decode()
        self.assertIn("SecurityOptions ['name=rootless']", printed)
        self.assertIn("CpuCfsQuota True", printed)
        # b. the recipe's own pin, by digest, run under the build container's limits
        pin = base_image_pin()
        self.assertIn(f"BASE='{pin}'", limits)
        self.assertRegex(pin, r"@sha256:[0-9a-f]{64}$")
        self.assertIn('docker pull -q "$BASE"', limits)
        for flag in ("--cpus=4", "--memory=24g", "--memory-swap=24g", "--pids-limit=1024"):
            self.assertIn(flag, limits)
            self.assertIn(flag, egress)
        # c. from a container on the default network: names, HTTPS, and the Tailscale address blocked while the counter rises
        self.assertNotIn("--network", egress)
        for needle in ("github.com", "snapshot.debian.org", "https://100.100.100.100/", "getent hosts", "curl ", "before=$(fence_drops)", "after=$(fence_drops)"):
            self.assertIn(needle, egress)
        self.assertLess(egress.index("before=$(fence_drops)"), egress.index("docker run"))
        self.assertLess(egress.index("docker run"), egress.index("after=$(fence_drops)"))
        with tempfile.TemporaryDirectory(prefix="omp-drops-") as directory:
            work = Path(directory)
            (work / "listing").write_text(
                "table inet omp_build_fence {\n\tchain out {\n\t\ttype filter hook output priority mangle - 10; policy accept;\n"
                "\t\tmeta skuid 1008 ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } counter packets 7 bytes 420 drop\n"
                "\t\tmeta skuid 1008 ip6 daddr { fc00::/7, fe80::/10 } counter packets 0 bytes 0 drop\n"
                "\t\tmeta skuid 1008 ip daddr 198.18.0.1 counter packets 3 bytes 180 drop\n\t}\n}\n")
            environment = stub_commands(work, {"nft": 'cat "$LISTING"\n'})
            function = re.search(r"(?m)^fence_drops\(\) \{.*\}$", egress)[0]
            counted = run_bash(f"{function}\nfence_drops", work, environment, LISTING=str(work / "listing"))
            self.assertEqual(counted.stdout.decode().split(), ["7"])
        # d. the host-side checks use python3 as the account, never curl, with proxies off in the environment and in the request
        self.assertNotIn("curl", host)
        self.assertIn('"${noproxy[@]}" python3 -I -c', host)
        self.assertIn("ProxyHandler({})", host)
        self.assertIn("https://100.100.100.100/", host)
        self.assertEqual(host.count("nft list table inet omp_build_fence"), 2)
        for body in blocks_in_part_e:
            if "docker run" not in body:
                self.assertNotIn("curl", body)
        code = re.search(r"python3 -I -c '(.*?)' \"\$@\"", host, re.DOTALL)[1]

        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *arguments):
                pass

        with tempfile.TemporaryDirectory(prefix="omp-reach-") as directory:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=directory))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                url = f"http://127.0.0.1:{server.server_address[1]}/"
                dead = {"HTTP_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9"}
                outcome = subprocess.run([sys.executable, "-I", "-c", code, url, "http://127.0.0.1:1/"], env={**os.environ, **dead},
                                         stdout=subprocess.PIPE, timeout=60, check=True).stdout.decode().splitlines()
            finally:
                server.shutdown()
                server.server_close()
        self.assertEqual(outcome, [f"reached {url} 200", "failed http://127.0.0.1:1/ URLError"])
        self.assertLess(section.index("2. The rootless daemon"), section.index("3. A real candidate build"))

    def test_the_optional_proxy_block_is_described_as_image_pulls_only(self):  # N2, N1, the A2 facts
        block = self.text.split("### Optional: ", 1)[1].split("```bash optional-docker-proxy.sh", 1)[0]
        self.assertTrue(block.startswith("image pulls of the rootless Docker daemon through the outbound proxy"))
        for phrase in ("image pulls by the account's own Docker daemon only, not container egress", "Part E step 2b's image pull",
                       "not expected to be needed on ci-001", "if 2c fails this block is not the answer"):
            self.assertIn(phrase, block)
        self.assertNotIn("curl", block)
        self.assertNotIn("last `curl`", self.text)
        self.assertIn("| Optional, proxy block for the Docker daemon's image pulls only (after Part B) |", self.text)
        self.assertIn("covers pulls by the account's Docker daemon only, not container egress", self.blocks["optional-docker-proxy.sh"][1])

    def test_the_operating_notes_cover_the_held_package_the_door_limits_and_the_fence(self):  # N7, N3
        notes = self.text.split("## Part G. Operating notes (Main)", 1)[1]
        for phrase in ("`docker-ce-rootless-extras` is on hold at the same version as `docker-ce`", "rootlesskit and the rootless scripts behind",
                       "`MemoryMax=2G` and `TasksMax=512`", "detached build supervisor", "The door `Requires=` the fence",
                       "`systemctl restart omp-build-fence.service`"):
            self.assertIn(phrase, notes)


if __name__ == "__main__":
    unittest.main()
