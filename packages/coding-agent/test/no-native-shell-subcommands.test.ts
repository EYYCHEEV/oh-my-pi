import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { executeBash, releaseShellSessions } from "../src/exec/bash-executor";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
const directories: string[] = [];

afterEach(async () => {
	releaseShellSessions("no-native-shell-subcommands");
	vi.restoreAllMocks();
	resetSettingsForTest();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function isolatedDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-native-shell-"));
	directories.push(directory);
	return directory;
}

describe("no native shell subcommands", () => {
	for (const word of ["zsh", "bash", "sh"]) {
		it(`does not execute a command through ${word}`, async () => {
			const directory = await isolatedDirectory();
			const marker = "omp-native-shell-should-not-run";
			const child = Bun.spawn([process.execPath, cliEntry, word, "-c", `printf '${marker}'`], {
				cwd: directory,
				env: { HOME: directory, PI_CODING_AGENT_DIR: directory, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stdout.includes(marker)).toBe(false);
			expect(stderr.includes(marker)).toBe(false);
			expect(exitCode !== 0 || /unknown|unrecognized|unexpected/i.test(stderr)).toBe(true);
		}, 45_000);
	}

	it("keeps the ordinary bash tool execution path working", async () => {
		const directory = await isolatedDirectory();
		await Settings.init({ inMemory: true, cwd: directory });
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-c"],
			env: { HOME: directory, PATH: "/usr/bin:/bin", SHELL: "/bin/bash", LANG: "C.UTF-8" },
			prefix: undefined,
		});
		const result = await executeBash("printf omp-bash-tool-control", {
			cwd: directory,
			sessionKey: "no-native-shell-subcommands",
			timeout: 5_000,
			env: { HOME: directory, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
		});
		expect(result.exitCode === 0).toBe(true);
		expect(result.output.includes("omp-bash-tool-control")).toBe(true);
	}, 30_000);
});
