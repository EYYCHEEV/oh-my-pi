/**
 * Contract: when Mnemopi cannot start, RPC mode says so once on stderr and keeps stdout to
 * protocol frames. Runs the real CLI, because the warning is wired in `runRpcMode`.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../../src/cli.ts");
const NOTICE = "Mnemopi memory is off for this session. Startup failed:";

/** Collects a child stream as text while the child keeps running. */
function collect(stream: ReadableStream<Uint8Array>): { text: () => string; done: Promise<void> } {
	const decoder = new TextDecoder();
	let text = "";
	const done = (async () => {
		for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
	})();
	return { text: () => text, done };
}

describe("RPC mode Mnemopi startup failure", () => {
	test("warns once on stderr and keeps stdout to protocol frames", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-mnemopi-");
		const agentDir = tempDir.join("home", ".omp", "agent");
		// A file where the database folder should be: the start fails the same way for every user, root included.
		const blocker = tempDir.join("not-a-folder");
		await Bun.write(blocker, "x");
		const model = {
			id: "m",
			name: "m",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 1024,
		};
		await Bun.write(
			path.join(agentDir, "models.yml"),
			JSON.stringify({
				providers: {
					local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", auth: "none", models: [model] },
				},
			}),
		);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			JSON.stringify({
				modelRoles: { default: "local/m" },
				memory: { backend: "mnemopi" },
				mnemopi: {
					noEmbeddings: true,
					llmMode: "none",
					scoping: "global",
					dbPath: path.join(blocker, "mnemopi.db"),
				},
				retry: { enabled: false },
				compaction: { enabled: false },
			}),
		);
		const proc = Bun.spawn([process.execPath, cliEntry, "--no-title", "--no-lsp", "--mode", "rpc"], {
			cwd: tempDir.path(),
			env: {
				PATH: process.env.PATH,
				HOME: path.join(tempDir.path(), "home"),
				USERPROFILE: path.join(tempDir.path(), "home"),
				TMPDIR: process.env.TMPDIR,
				NO_COLOR: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = collect(proc.stdout);
		const stderr = collect(proc.stderr);
		try {
			const deadline = Date.now() + 20_000;
			while (!stderr.text().includes(NOTICE) && Date.now() < deadline) await Bun.sleep(50);
			// Leave time for a second copy to show up before counting.
			await Bun.sleep(500);
		} finally {
			proc.stdin.end();
			proc.kill();
			await proc.exited;
			await Promise.all([stdout.done, stderr.done]);
		}

		expect(stderr.text().split(NOTICE)).toHaveLength(2);
		expect(stderr.text()).not.toContain(tempDir.path());
		expect(stderr.text()).not.toContain(fs.realpathSync(tempDir.path()));
		const frames = stdout
			.text()
			.split("\n")
			.filter(line => line.trim());
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames) expect(() => JSON.parse(frame)).not.toThrow();
		expect(stdout.text()).not.toContain("Mnemopi memory is off");
	}, 40_000);
});
