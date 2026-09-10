import { expect, it } from "bun:test";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { parseArgs, reportUnrecognizedFlags } from "../src/cli/args";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { buildSessionOptions } from "../src/main";
import { initializeExtensions } from "../src/modes/runtime-init";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { RUNTIME_REQUIREMENTS_VERSION } from "../src/session/runtime-requirements";

for (const failure of ["missing", "factory"] as const) {
	it(`carries an explicit runtime condition through ordinary CLI configuration and refuses ${failure} startup`, async () => {
		const dir = TempDir.createSync("runtime-startup-");
		const cwd = path.resolve(dir.path());
		const auth = await AuthStorage.create(path.join(cwd, "auth.db"));
		const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"));
		registry.registerProvider("mock", { apiKey: "fixture-only" });
		const manager = SessionManager.inMemory(cwd);
		const runtimePath = path.join(cwd, `${failure}.ts`);
		if (failure === "factory")
			await Bun.write(runtimePath, `export default function() { throw new Error("Fixture factory failure"); }`);
		const settings = Settings.isolated({
			requiredRuntimeExtensions: [{ path: runtimePath, id: "fixture.guard", version: 1 }],
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		try {
			const parsed = parseArgs(["--cwd", cwd, "--no-tools", "-e", runtimePath, "--require-runtime-contract=1"]);
			expect(reportUnrecognizedFlags(parsed, () => {})).toBe(false);
			const options = await buildSessionOptions(parsed, [], manager, registry, settings);
			const mock = createMockModel({ handler: { content: ["Should not run"] } });
			const { session } = await createAgentSession({
				...options,
				cwd,
				agentDir: cwd,
				model: mock.model,
				modelRegistry: registry,
				settings,
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				disableExtensionDiscovery: true,
				preloadedCustomToolPaths: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: [],
			});
			try {
				session.agent.streamFn = mock.stream;
				await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });
				await expect(session.prompt("REJECTED_STARTUP_DRAFT")).rejects.toThrow("runtime requirement");
				expect(mock.calls).toHaveLength(0);
				expect(session.queuedMessageCount).toBe(0);
				await session.newSession();
				await session.prompt("ORDINARY_AFTER_REFUSAL");
				expect(mock.calls).toHaveLength(1);
				const admittedMessages = JSON.stringify(mock.calls[0]!.context.messages);
				expect(admittedMessages).toContain("ORDINARY_AFTER_REFUSAL");
				expect(admittedMessages).not.toContain("REJECTED_STARTUP_DRAFT");
				expect(session.sessionManager.getRuntimeRequirements()).toEqual([]);
			} finally {
				await session.dispose();
			}
		} finally {
			auth.close();
			dir.removeSync();
		}
	});
}

it("refuses unsupported contract assertions instead of allowing extensions to shadow the fence", () => {
	expect(() => parseArgs(["--require-runtime-contract=2"])).toThrow("runtime contract");
	expect(() => parseArgs(["--require-runtime-contract"])).toThrow("runtime contract");
	expect(() =>
		parseArgs(["--require-runtime-contract=2"], new Map([["require-runtime-contract", { type: "string" }]])),
	).toThrow("runtime contract");
});

it("advertises runtime requirements through the read-only root CLI help entrypoint", async () => {
	const dir = TempDir.createSync("runtime-help-");
	try {
		const child = Bun.spawn(
			[process.execPath, "--no-env-file", path.resolve(import.meta.dir, "../src/cli.ts"), "--help"],
			{
				cwd: dir.path(),
				env: { HOME: dir.path(), PI_CODING_AGENT_DIR: dir.path(), NO_COLOR: "1" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const advertised = stdout.match(/^\s*runtime-requirements: (\d+)\s*$/m);
		expect(advertised?.[1]).toBe(String(RUNTIME_REQUIREMENTS_VERSION));
	} finally {
		dir.removeSync();
	}
});
