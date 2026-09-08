import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** No host credentials, profile selectors, OMP/PI overrides, or preload hooks cross this boundary. */
export function evaluationEnvironment(root: string): Record<string, string> {
	return {
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_DATA_HOME: path.join(root, "data"),
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_CACHE_HOME: path.join(root, "cache"),
		TMPDIR: root,
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		BUN_OPTIONS: "",
	};
}

export async function evaluationRoot(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-evaluation-")));
	await fs.mkdir(path.join(root, "agent"));
	return root;
}

export async function runEvaluationChild(
	root: string,
	argv: string[],
	environment: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = Bun.spawn([process.execPath, "--no-install", ...argv], {
		cwd: root,
		env: environment,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	// This bounds a model-free fixture, not model inference. Always reap the exact
	// owned child, including output-read errors and failed assertions in callers.
	const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	} finally {
		clearTimeout(timeout);
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
}
