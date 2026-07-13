import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface ProfileProbeResult {
	firstA: string;
	firstB: string;
	secondA: string;
	secondB: string;
	directA: string;
	inheritedA: string;
	isolatedChild: string;
}

describe("SDK Python runtime profiles", () => {
	it("isolates cold-start and retained kernels across same-process sessions", () => {
		const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-python-runtime-profile-"));
		const cwd = path.join(temporaryRoot, "workspace");
		fs.mkdirSync(cwd);
		try {
			const virtualEnv = path.join(temporaryRoot, "profile-venv");
			const isolatedPath = path.join(temporaryRoot, "isolated-path");
			fs.mkdirSync(isolatedPath);
			if (process.platform !== "win32") {
				const interpreter = Bun.which("python3");
				if (!interpreter) throw new Error("python3 unavailable");
				const virtualEnvBin = path.join(virtualEnv, "bin");
				fs.mkdirSync(virtualEnvBin, { recursive: true });
				fs.symlinkSync(interpreter, path.join(virtualEnvBin, "python"));
			}
			const fixture = path.resolve(import.meta.dir, "fixtures", "sdk-python-runtime-profile.ts");
			const probe = Bun.spawnSync([process.execPath, fixture], {
				cwd: path.resolve(import.meta.dir, ".."),
				env: {
					...process.env,
					BUN_ENV: "development",
					NODE_ENV: "development",
					PI_PYTHON_SKIP_CHECK: undefined,
					PI_RUNTIME_GUARD_TEST: undefined,
					HOME: temporaryRoot,
					XDG_CACHE_HOME: path.join(temporaryRoot, "xdg-cache"),
					XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg-config"),
					XDG_DATA_HOME: path.join(temporaryRoot, "xdg-data"),
					XDG_STATE_HOME: path.join(temporaryRoot, "xdg-state"),
					PATH: process.platform === "win32" ? process.env.PATH : isolatedPath,
					OMP_TEST_ROOT: temporaryRoot,
					OMP_TEST_CWD: cwd,
					OMP_TEST_VIRTUAL_ENV: virtualEnv,
				},
				stdout: "pipe",
				stderr: "pipe",
			});

			expect(probe.exitCode, Buffer.from(probe.stderr).toString("utf8")).toBe(0);
			const lines = Buffer.from(probe.stdout)
				.toString("utf8")
				.split("\n")
				.filter(line => line.startsWith('{"firstA"'));
			expect(lines).toHaveLength(1);
			const result = JSON.parse(lines[0]) as ProfileProbeResult;
			expect(result.firstA).toContain("shared-profile");
			if (process.platform !== "win32") {
				expect(result.firstA).toContain(path.join(virtualEnv, "bin", "python"));
				expect(result.firstB).toContain(path.join(virtualEnv, "bin", "python"));
			}
			expect(result.firstB).toContain("shared-profile");
			expect(result.secondA).toContain("A-state");
			expect(result.secondA).toContain("shared-profile");
			expect(result.secondB).toContain("B-state");
			expect(result.secondB).toContain("shared-profile");
			expect(result.secondA).not.toContain("B-state");
			expect(result.secondB).not.toContain("A-state");
			expect(result.directA).toContain("A-state");
			expect(result.directA).toContain("shared-profile");
			expect(result.inheritedA).toContain("A-state");
			expect(result.inheritedA).toContain("shared-profile");
			expect(result.inheritedA).not.toContain("B-state");
			expect(result.isolatedChild).toContain("isolated-state");
			expect(result.isolatedChild).not.toContain("A-state");
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	}, 30_000);

	it("rejects a resolver that changes an unavailable interpreter into the selected runtime", () => {
		if (process.platform === "win32") return;
		const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-python-late-interpreter-"));
		try {
			const cwd = path.join(temporaryRoot, "workspace");
			const interpreterDirectory = path.join(temporaryRoot, "late-interpreter");
			const isolatedPath = path.join(temporaryRoot, "isolated-path");
			fs.mkdirSync(cwd);
			fs.mkdirSync(path.join(interpreterDirectory, "bin"), { recursive: true });
			fs.mkdirSync(isolatedPath);
			fs.writeFileSync(path.join(interpreterDirectory, "bin", "python"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			const fixture = path.resolve(import.meta.dir, "fixtures", "sdk-python-runtime-profile.ts");
			const probe = Bun.spawnSync([process.execPath, fixture], {
				cwd: path.resolve(import.meta.dir, ".."),
				env: {
					...process.env,
					BUN_ENV: "development",
					NODE_ENV: "development",
					PI_PYTHON_SKIP_CHECK: undefined,
					VIRTUAL_ENV: undefined,
					HOME: temporaryRoot,
					XDG_CACHE_HOME: path.join(temporaryRoot, "xdg-cache"),
					XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg-config"),
					XDG_DATA_HOME: path.join(temporaryRoot, "xdg-data"),
					XDG_STATE_HOME: path.join(temporaryRoot, "xdg-state"),
					PATH: isolatedPath,
					OMP_TEST_ROOT: temporaryRoot,
					OMP_TEST_CWD: cwd,
					OMP_TEST_VIRTUAL_ENV: temporaryRoot,
					OMP_TEST_LATE_INTERPRETER_DIR: interpreterDirectory,
				},
				stdout: "pipe",
				stderr: "pipe",
			});

			expect(probe.exitCode, Buffer.from(probe.stderr).toString("utf8")).toBe(0);
			const lines = Buffer.from(probe.stdout)
				.toString("utf8")
				.split("\n")
				.filter(line => line.startsWith('{"error"'));
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0])).toEqual({
				error: "Resolved Python spawn environment changed the selected interpreter",
			});
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});
});
