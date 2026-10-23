#!/usr/bin/env python3
"""Offline checks of the ci-001 install packet, docs/ci001-build-door.md.

Nothing is installed or contacted. The fenced scripts are syntax-checked, the read-only fact script is checked for
anything that writes, the address mask is exercised, and the packet is cross-checked against the entry and the Mac
driver so the three cannot drift apart.
"""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import test_linux_amd64_door as door_tests

ROOT = Path(__file__).resolve().parent.parent
PACKET = ROOT / "docs" / "ci001-build-door.md"
ENTRY = door_tests.ENTRY
PUBLIC_KEY = Path.home() / ".ssh" / "omp-ci001-build.pub"
FENCE_ADDRESSES = {"10.0.0.0", "172.16.0.0", "192.168.0.0", "100.64.0.0", "169.254.0.0", "198.18.0.1", "100.100.100.100"}


def blocks():
    found = {}
    for kind, title, body in re.findall(r"^```(\w+) ?([\w.-]*)\n(.*?)^```$", PACKET.read_text(), re.MULTILINE | re.DOTALL):
        found[title or kind + str(len(found))] = (kind, body)
    return found


def heredoc(script, header):
    found = re.search(re.escape(header) + r"\n(.*?)\nEOF\n", script, re.DOTALL)
    assert found, header
    return found[1]


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
        self.assertEqual(re.findall(r"[0-9a-f]{64}", self.text), [digest, digest])
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
        self.assertIn("### Optional: the rootless Docker daemon through the outbound proxy", self.text)
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


if __name__ == "__main__":
    unittest.main()
