import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { executeBash, releaseShellSessions } from "../src/exec/bash-executor";
import * as shellSnapshot from "../src/utils/shell-snapshot";

let directory: string;
let snapshotPath: string | null;
const sessionKey = "tool-shell-guard-parity";

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tool-shell-parity-"));
	snapshotPath = null;
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: directory });
	vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
		shell: "/bin/bash",
		args: ["-c"],
		env: { HOME: directory, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", SHELL: "/bin/bash" },
		prefix: undefined,
	});
	vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockImplementation(async () => snapshotPath);
});

afterEach(async () => {
	releaseShellSessions(sessionKey);
	vi.restoreAllMocks();
	resetSettingsForTest();
	await fs.rm(directory, { recursive: true, force: true });
});

function run(command: string) {
	return executeBash(command, {
		cwd: directory,
		sessionKey,
		timeout: 5_000,
		minimize: false,
		env: { HOME: directory, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
	});
}

describe("bash tool guard parity after native rebuild", () => {
	it("refuses both no-fork forms before running any part of the call", async () => {
		for (const command of [
			"printf before; printf '%s' ${ printf forbidden; }",
			"printf before; printf '%s' ${| printf forbidden; }",
			'printf before; printf "%s" "${ printf forbidden; }"',
			'printf before; printf "%s" "${| printf forbidden; }"',
			'printf before; printf "%s" "$(printf "%s" ${ printf forbidden; })"',
			'printf before; printf "%s" "$(printf "%s" ${| printf forbidden; })"',
			"printf before; cat <<EOF\n${ printf forbidden; }\nEOF",
			"printf before; cat <<EOF\n${| printf forbidden; }\nEOF",
		]) {
			let refused = false;
			let output = "";
			try {
				const result = await run(command);
				refused = result.exitCode !== 0 && /syntax/i.test(result.output);
				output = result.output;
			} catch (error) {
				refused = error instanceof Error && /syntax/i.test(error.message);
			}
			expect(refused).toBe(true);
			expect(output.includes("before") || output.includes("forbidden")).toBe(false);
		}
	});

	it("keeps ordinary expansions and same-call functions", async () => {
		const result = await run(
			'name=control; local_fn() { printf "%s" "${name}:$(printf normal):`printf backtick`"; }; local_fn',
		);
		expect(result.exitCode === 0).toBe(true);
		expect(result.output === "control:normal:backtick").toBe(true);
	});

	it("cannot enable alias expansion in the tool session", async () => {
		const result = await run("shopt -s expand_aliases\nalias omp_guard_alias='printf forbidden'\nomp_guard_alias");
		expect(result.exitCode !== 0).toBe(true);
		expect(result.output.includes("forbidden")).toBe(false);
		const enabled = await run("shopt -q expand_aliases");
		expect(enabled.exitCode !== 0).toBe(true);
	});

	it("restores neither saved aliases nor saved functions", async () => {
		snapshotPath = path.join(directory, "snapshot.sh");
		await fs.writeFile(
			snapshotPath,
			"shopt -s expand_aliases\nalias omp_guard_alias='printf forbidden'\nomp_guard_function() { printf forbidden; }\n",
		);
		for (const command of ["omp_guard_alias", "omp_guard_function"]) {
			const result = await run(command);
			expect(result.exitCode !== 0).toBe(true);
			expect(result.output.includes("forbidden")).toBe(false);
		}
	});

	it("does not carry functions from one call to the next", async () => {
		const first = await run("omp_guard_function() { printf forbidden; }; printf ready");
		expect(first.exitCode === 0 && first.output === "ready").toBe(true);
		const second = await run("omp_guard_function");
		expect(second.exitCode !== 0).toBe(true);
		expect(second.output.includes("forbidden")).toBe(false);
	});

	it("refuses emulate command text and keeps later calls in bash", async () => {
		const command = await run("emulate sh -c 'printf forbidden'");
		expect(command.exitCode === 1).toBe(true);
		expect(command.output.includes("forbidden")).toBe(false);
		expect(command.output.includes("emulate: disabled in tool shells")).toBe(true);
		const switchMode = await run("emulate zsh");
		expect(switchMode.exitCode === 1).toBe(true);
		const later = await run("shopt -s extglob; emulate");
		expect(later.exitCode === 0 && later.output === "bash\n").toBe(true);
	});
});
