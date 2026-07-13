import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import RUNNER_SCRIPT from "../src/eval/py/runner.py" with { type: "text" };

type PreparationProbeResult = {
	paths: string[];
	repaired: string;
};

describe("preparePythonRunnerScript", () => {
	it("prepares one private runner and repairs in-process tampering for concurrent callers", () => {
		const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-runner-preparation-"));
		try {
			const packageRoot = path.resolve(import.meta.dir, "..");
			const probePath = path.join(import.meta.dir, "fixtures", "python-runner-preparation-probe.ts");
			const probe = Bun.spawnSync([process.execPath, probePath], {
				cwd: packageRoot,
				env: { ...process.env, TMPDIR: temporaryRoot, TEMP: temporaryRoot, TMP: temporaryRoot },
				stdout: "pipe",
				stderr: "pipe",
			});

			expect(probe.exitCode, Buffer.from(probe.stderr).toString("utf8")).toBe(0);
			const result = JSON.parse(Buffer.from(probe.stdout).toString("utf8")) as PreparationProbeResult;
			expect(result.paths).toHaveLength(16);
			const runnerPath = result.paths[0];
			if (!runnerPath) throw new Error("Prepared runner path unavailable");
			expect(result.paths.every(candidate => candidate === runnerPath)).toBe(true);
			expect(result.repaired).toBe(runnerPath);
			expect(path.basename(path.dirname(runnerPath))).toBe("omp-python-runner");
			const cacheRoot = path.dirname(path.dirname(runnerPath));
			expect(path.relative(temporaryRoot, cacheRoot).startsWith("..")).toBe(false);
			expect(fs.readFileSync(runnerPath, "utf8")).toBe(RUNNER_SCRIPT);
			const metadata = fs.lstatSync(runnerPath);
			expect(metadata.isFile()).toBe(true);
			expect(metadata.isSymbolicLink()).toBe(false);
			expect(metadata.nlink).toBe(1);
			if (process.platform !== "win32") {
				expect(metadata.mode & 0o777).toBe(0o400);
				expect(fs.lstatSync(cacheRoot).mode & 0o777).toBe(0o700);
			}
			expect(fs.readdirSync(path.dirname(runnerPath))).toEqual([path.basename(runnerPath)]);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});
});
