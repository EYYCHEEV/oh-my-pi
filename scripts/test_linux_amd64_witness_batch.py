"""Offline fixtures for the witness batch's public command/output boundary.

Only Bash and synthetic local files are used. No witness, SSH, Docker, Git,
network, signing or build command is executed. The private report is optional
outside the preparation worktree; when present, its exact wrapper block must
match these executable fixtures.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


REPORT = Path(os.environ["OMP_WITNESS_REPORT"]) if os.environ.get("OMP_WITNESS_REPORT") else None
BEGIN = "# BEGIN MAC OUTPUT WRAPPERS\n"
END = "# END MAC OUTPUT WRAPPERS"
TRANSPORT_BEGIN = "# BEGIN MAC TRANSPORT WRAPPERS\n"
TRANSPORT_END = "# END MAC TRANSPORT WRAPPERS"
# This is the exact report block, not an alternate implementation of the seam.
MAC_OUTPUT_WRAPPERS = r'''mac_quiet() {
  local result
  if { "$@" >/dev/null 2>&1; } 2>/dev/null; then
    return 0
  else
    result=$?
    printf '%s\n' 'Local step failed.' >&2
    return "$result"
  fi
}
mac_export() {
  local destination=$1 result
  shift
  if { "$@" >"$destination" 2>/dev/null; } 2>/dev/null; then
    return 0
  else
    result=$?
    printf '%s\n' 'Local step failed.' >&2
    return "$result"
  fi
}
mac_compare() {
  mac_quiet cmp -s "$1" "$2"
}
mac_signer_bytes() {
  printf '%s ' 'stronk-omp-qualification namespaces="stronk-omp-qualification"' &&
    cat "$1"
}
'''
MAC_TRANSPORT_WRAPPERS = r'''witness_ssh() {
  local -a options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o LogLevel=QUIET)
  ssh "${options[@]}" "$@"
}
witness_scp() {
  local -a options=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o LogLevel=QUIET)
  scp -q "${options[@]}" "$@"
}
'''
FAILURE = b"Local step failed.\n"


class MacBatchOutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = shutil.which("bash")
        if cls.bash is None:
            raise unittest.SkipTest("Bash is required for the command/output fixtures")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="omp-witness-batch-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "synthetic-home"
        self.home.mkdir()

    def shell(self, command, *arguments):
        script = "set -euo pipefail\nset -C\numask 077\n" + MAC_OUTPUT_WRAPPERS + MAC_TRANSPORT_WRAPPERS + command
        return subprocess.run(
            [self.bash, "--noprofile", "--norc", "-c", script, "fixture", *map(str, arguments)],
            cwd=self.root,
            env={"PATH": os.defpath, "HOME": str(self.home), "LC_ALL": "C"},
            capture_output=True,
            check=False,
            timeout=10,
        )

    def assert_private_failure(self, result, code):
        self.assertEqual(result.returncode, code)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, FAILURE)
        self.assertNotIn(os.fsencode(self.root), result.stdout + result.stderr)
        self.assertNotIn(b"synthetic-home", result.stdout + result.stderr)

    def test_exact_private_report_wrappers_when_report_is_available(self):
        if REPORT is None or not REPORT.exists():
            self.skipTest("Private report is not distributed with the public fixtures")
        report = REPORT.read_text()
        self.assertEqual(report.count(BEGIN), 1)
        self.assertEqual(report.count(END), 1)
        wrappers = report.split(BEGIN, 1)[1].split(END, 1)[0]
        self.assertEqual(wrappers, MAC_OUTPUT_WRAPPERS)
        self.assertEqual(report.count(TRANSPORT_BEGIN), 1)
        self.assertEqual(report.count(TRANSPORT_END), 1)
        transport = report.split(TRANSPORT_BEGIN, 1)[1].split(TRANSPORT_END, 1)[0]
        self.assertEqual(transport, MAC_TRANSPORT_WRAPPERS)

    def test_fresh_recovery_shell_owns_all_transport_options(self):
        command = r'''ssh() {
  [[ $# == 10 && $1 == -o && $2 == BatchMode=yes &&
     $3 == -o && $4 == StrictHostKeyChecking=yes &&
     $5 == -o && $6 == UpdateHostKeys=no &&
     $7 == -o && $8 == LogLevel=QUIET &&
     $9 == fixture-alias && ${10} == fixture-command ]]
}
scp() {
  [[ $# == 11 && $1 == -q && $2 == -o && $3 == BatchMode=yes &&
     $4 == -o && $5 == StrictHostKeyChecking=yes &&
     $6 == -o && $7 == UpdateHostKeys=no &&
     $8 == -o && $9 == LogLevel=QUIET &&
     ${10} == fixture-source && ${11} == fixture-destination ]]
}
unset SSH_OPTIONS
mac_quiet witness_ssh fixture-alias fixture-command
mac_quiet witness_scp fixture-source fixture-destination
SSH_OPTIONS=(-o StrictHostKeyChecking=no)
mac_quiet witness_ssh fixture-alias fixture-command
mac_quiet witness_scp fixture-source fixture-destination
'''
        result = self.shell(command)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout + result.stderr, b"")

    def test_exact_report_status_accepts_unit_fields_but_never_promotes_transport_success(self):
        if REPORT is None or not REPORT.exists():
            self.skipTest("Private report is not distributed with the public fixtures")
        report = REPORT.read_text()
        function = "witness_status() {\n" + report.split("witness_status() {\n", 1)[1].split("\nwitness_stop()", 1)[0]
        cases = [
            ("Witness unit absent.\nWitness terminal: success; exit code 0.", 0, 0),
            ("Witness unit: ActiveState=active; SubState=running; Result=success; ExecMainStatus=0.\n"
             "Witness job running.", 2, 2),
            ("Witness unit: ActiveState=failed; SubState=failed; Result=exit-code; ExecMainStatus=17.\n"
             "Witness terminal: failed:prepare; exit code 17.", 1, 1),
            ("Witness unit absent.\nWitness failed: terminal result unavailable; preserve scratch.", 1, 1),
            ("Witness unit absent.", 0, 2),
        ]
        for output, remote_code, expected in cases:
            with self.subTest(remote_code=remote_code, expected=expected):
                command = function + r'''
witness_command() {
  printf '%s\n' "$FIXTURE_OUTPUT"
  return "$FIXTURE_CODE"
}
FIXTURE_OUTPUT=$1
FIXTURE_CODE=$2
result=0
witness_status || result=$?
exit "$result"
'''
                result = self.shell(command, output, remote_code)
                self.assertEqual(result.returncode, expected)
                self.assertEqual(result.stdout.decode(), output + "\n")
                if expected:
                    self.assertEqual(result.stderr, b"Witness status is not successful; do not advance or rebuild.\n")
                else:
                    self.assertEqual(result.stderr, b"")

    def test_existing_private_directory_fails_without_disclosing_its_path(self):
        existing = self.home / "private-already-exists"
        existing.mkdir()
        result = self.shell('mac_quiet mkdir -m 700 "$1"\nprintf "unreachable\\n"\n', existing)
        self.assert_private_failure(result, 1)
        self.assertTrue(existing.is_dir())

    def test_public_key_mismatch_is_silent_and_keeps_cmp_status(self):
        enrolled = self.home / "enrolled-fixture.pub"
        returned = self.home / "returned-fixture.pub"
        enrolled.write_bytes(b"synthetic-enrolled-public-input\n")
        returned.write_bytes(b"synthetic-different-public-input\n")
        result = self.shell('mac_compare "$1" "$2"\nprintf "unreachable\\n"\n', enrolled, returned)
        self.assert_private_failure(result, 1)

    def test_missing_comparison_input_keeps_distinct_cmp_error_status(self):
        present = self.home / "present-fixture.pub"
        present.write_bytes(b"synthetic-public-input\n")
        result = self.shell('mac_compare "$1" "$2"\n', present, self.home / "missing-fixture.pub")
        self.assert_private_failure(result, 2)

    def test_permission_failure_is_path_free_even_under_root(self):
        protected = self.home / "protected"
        protected.mkdir(mode=0o500)
        self.addCleanup(protected.chmod, 0o700)
        if os.geteuid() == 0:
            # Root bypasses DAC permissions: use a deterministic command fake.
            # Deliberately contaminate both streams with the synthetic path.
            command = r'''mkdir() {
  printf 'mkdir: %s: Permission denied\n' "$*" >&2
  printf 'untrusted diagnostic: %s\n' "$*"
  return 13
}
mac_quiet mkdir -m 700 "$1"
printf 'unreachable\n'
'''
            expected = 13
        else:
            command = 'mac_quiet mkdir -m 700 "$1"\nprintf "unreachable\\n"\n'
            expected = 1
        result = self.shell(command, protected / "blocked-child")
        self.assert_private_failure(result, expected)
        self.assertFalse((protected / "blocked-child").exists())

    def test_failing_command_suppresses_both_streams_and_keeps_exact_status(self):
        command = r'''fixture_failure() {
  printf 'stdout contains %s\n' "$1"
  printf 'stderr contains %s\n' "$1" >&2
  return 37
}
mac_quiet fixture_failure "$1"
printf 'unreachable\n'
'''
        result = self.shell(command, self.home / "private-input")
        self.assert_private_failure(result, 37)

    def test_export_open_failure_suppresses_shell_diagnostics(self):
        # These fail before printf is invoked, so redirecting command stderr
        # alone would leak the expanded destination from Bash itself.
        destinations = (self.home, self.home / "absent-parent" / "output")
        for destination in destinations:
            with self.subTest(kind="directory" if destination == self.home else "missing-parent"):
                result = self.shell('mac_export "$1" printf "fixture\\n"\n', destination)
                self.assert_private_failure(result, 1)

    def test_export_permission_failure_suppresses_shell_open_error(self):
        if os.geteuid() == 0:
            self.skipTest("Root permission bypass is covered by the deterministic command fixture")
        protected = self.home / "export-protected"
        protected.mkdir(mode=0o500)
        self.addCleanup(protected.chmod, 0o700)
        result = self.shell('mac_export "$1" printf "fixture\\n"\n', protected / "blocked-output")
        self.assert_private_failure(result, 1)

    def test_existing_export_is_not_overwritten_or_disclosed(self):
        destination = self.home / "existing-evidence"
        destination.write_bytes(b"keep-existing-bytes\n")
        result = self.shell('mac_export "$1" printf "replacement\\n"\n', destination)
        self.assert_private_failure(result, 1)
        self.assertEqual(destination.read_bytes(), b"keep-existing-bytes\n")

    def test_signer_input_failure_is_silent_and_prevents_forward_progress(self):
        destination = self.home / "signers"
        missing = self.home / "missing-public-input"
        result = self.shell(
            'mac_export "$1" mac_signer_bytes "$2"\nprintf "unreachable\\n"\n',
            destination, missing,
        )
        self.assert_private_failure(result, 1)

    def test_successful_export_and_comparison_are_silent(self):
        source = self.home / "public-fixture.pub"
        source.write_bytes(b"synthetic-public-input\n")
        destination = self.home / "signers"
        result = self.shell(
            'mac_quiet mkdir -m 700 "$1"\n'
            'mac_compare "$2" "$2"\n'
            'mac_export "$3" mac_signer_bytes "$2"\n',
            self.home / "new-private-directory", source, destination,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")
        self.assertEqual(
            destination.read_bytes(),
            b'stronk-omp-qualification namespaces="stronk-omp-qualification" synthetic-public-input\n',
        )
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
