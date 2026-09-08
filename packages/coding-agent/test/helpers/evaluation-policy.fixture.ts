import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { DeleteArgsSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import * as main from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type } from "@oh-my-pi/omptype";
import { assertEvaluationTool, getEvaluationAdmission } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./agent-session-setup";
import { asGlobalFetch } from "./fetch-mock";

// This module is imported only by a generated test entry in an isolated child.
// The parent establishes every path and policy before Bun can load this graph.
const { join } = path;
const { writeFile, symlink, unlink } = fs;
const root = process.cwd();
const promptPath = join(root, "startup-prompt.txt");
const policyPath = process.env.OMP_EVALUATION_POLICY!;
const policyDigest = process.env.OMP_EVALUATION_POLICY_SHA256!;
const marker = "EVALUATION_STARTUP_MARKER_47c861";
const auth = createInMemoryAuthStorage();
const settings = Settings.isolated({ "prewalk.enabled": false });
const registry = new ModelRegistry(auth, join(root, "models.yml"));
const network = spyOn(globalThis, "fetch").mockImplementation(
	asGlobalFetch(() => {
		throw new Error("Fixture attempted network access");
	}),
);
afterAll(() => {
	auth.close();
	try {
		expect(network).not.toHaveBeenCalled();
	} finally {
		network.mockRestore();
	}
});

function startup(path: string) {
	return main.buildSessionOptions(
		parseArgs(["--cwd", root, "--system-prompt", path]),
		[],
		undefined,
		registry,
		settings,
	);
}

test("an admitted startup prompt contributes its real file contents through CLI options", async () => {
	const options = await startup(promptPath);
	expect(options.customSystemPrompt).toBe(marker);
});

test("an unadmitted startup prompt is refused before opening the evidence file", async () => {
	const forbiddenPath = join(root, "unadmitted-prompt.txt");
	await writeFile(forbiddenPath, "FORBIDDEN_STARTUP_MARKER_d193a2");
	const fileAccess = spyOn(Bun, "file");
	try {
		await expect(startup(forbiddenPath)).rejects.toThrow();
		expect(fileAccess.mock.calls.some(([path]) => String(path) === forbiddenPath)).toBe(false);
	} finally {
		fileAccess.mockRestore();
	}
});

test("a malformed policy digest refuses startup even for an admitted prompt", async () => {
	process.env.OMP_EVALUATION_POLICY_SHA256 = "not-a-sha256";
	const fileAccess = spyOn(Bun, "file");
	try {
		await expect(startup(promptPath)).rejects.toThrow();
		expect(fileAccess.mock.calls.some(([path]) => String(path) === promptPath)).toBe(false);
	} finally {
		fileAccess.mockRestore();
		process.env.OMP_EVALUATION_POLICY_SHA256 = policyDigest;
	}
});

test("SDK refuses raw context before invoking supplied extension roots", async () => {
	// Rejection must precede extension discovery.
	let activated = false;
	await expect(
		createAgentSession({
			cwd: root,
			settings,
			modelRegistry: registry,
			systemPrompt: "UNATTESTED_SDK_CONTEXT",
			extensionRoots: () => {
				activated = true;
				return { explicit: [], configured: [], configuredLevel: "user", mode: "explicit-only" };
			},
		}),
	).rejects.toThrow();
	expect(activated).toBe(false);
});

test("SDK exposes the admitted extension rather than a same-name native tool and denies alternate ingress", async () => {
	let executions = 0;
	const refresh = spyOn(registry, "refreshRuntimeProviders").mockResolvedValue(undefined);
	const apiKey = spyOn(registry, "getApiKey").mockResolvedValue("model-free-fixture-key");
	let session: AgentSession | undefined;
	try {
		({ session } = await createAgentSession({
			cwd: root,
			agentDir: process.env.PI_CODING_AGENT_DIR,
			settings,
			modelRegistry: registry,
			model: createMockModel(),
			evaluationPromptFile: promptPath,
			requireYieldTool: true,
			extensions: [
				pi => {
					pi.on("before_agent_start", event => ({
						systemPrompt: [...event.systemPrompt, "TRUSTED_EXTENSION_CONTEXT_MARKER"],
					}));
					pi.registerTool({
						name: "read",
						label: "Evidence fixture",
						description: "Return an admitted fixture fact.",
						parameters: type({ operation: "string", "action?": "string", "confirmed?": "boolean" }),
						async execute(_id, _args, _signal, _update, context) {
							executions++;
							return {
								content: [{ type: "text", text: marker }],
								details: { nativeAvailable: context.invokeTool !== undefined },
							};
						},
					});
					pi.registerTool({
						name: "write",
						label: "Write-named fixture",
						description: "Return a fixture fact without writing files.",
						parameters: type({}),
						async execute() {
							return { content: [{ type: "text", text: "EXTENSION_WRITE_ONLY" }], details: {} };
						},
					});
				},
			],
		}));
		expect(session.agent.state.tools.map(tool => tool.name)).toEqual(["read", "write"]);
		const tool = session.agent.state.tools[0];
		const result = await tool.execute("admitted", { operation: "arbitrary-domain-operation", confirmed: true });
		expect(result.content.some(item => item.type === "text" && item.text.includes(marker))).toBe(true);
		expect(result.details).toMatchObject({ nativeAvailable: false });
		expect(executions).toBe(1);
		expect(() => assertEvaluationTool("handler")).toThrow("tool is not admitted");
		await expect(session.prompt("UNATTESTED_MESSAGE")).rejects.toThrow();
		await expect(session.switchSession(join(root, "unadmitted-session.jsonl"))).rejects.toThrow();
		await expect(session.steer("UNATTESTED_STEER")).rejects.toThrow();
		await expect(session.followUp("UNATTESTED_FOLLOWUP")).rejects.toThrow();
		await expect(session.sendUserMessage("UNATTESTED_USER_MESSAGE")).rejects.toThrow();
		await expect(
			session.sendCustomMessage({ customType: "report", content: "UNATTESTED_REPORT", display: false }),
		).rejects.toThrow();
		await expect(session.newSession()).rejects.toThrow();
		await expect(session.fork()).rejects.toThrow();
		expect(() => session!.setActiveToolsByName(["eval"])).toThrow();
		let forwardedSystemPrompt: readonly string[] = [];
		const modelPrompt = spyOn(session.agent, "prompt").mockImplementation(async () => {
			forwardedSystemPrompt = [...session!.agent.state.systemPrompt];
		});
		try {
			await session.prompt("", { evaluationInputFile: promptPath });
			expect(modelPrompt).toHaveBeenCalled();
			expect(forwardedSystemPrompt.join("\\n")).toContain("TRUSTED_EXTENSION_CONTEXT_MARKER");
		} finally {
			modelPrompt.mockRestore();
		}
		const writeTool = session.agent.state.tools.find(tool => tool.name === "write")!;
		const written = await writeTool.execute("extension-write", {});
		expect(written.content).toEqual([{ type: "text", text: "EXTENSION_WRITE_ONLY" }]);
		let bridge: CursorExecHandlers | undefined;
		const captureBridge = spyOn(session.agent, "streamFn").mockImplementation((_model, _context, options) => {
			bridge = options?.cursorExecHandlers as CursorExecHandlers | undefined;
			throw new Error("Fixture captured the provider bridge");
		});
		try {
			await session.prompt("", { evaluationInputFile: promptPath });
			if (!bridge) throw new Error("Native bridge did not reach the provider interface");
			const target = join(root, "native-target.txt");
			const deleted = await bridge.delete(create(DeleteArgsSchema, { toolCallId: "native-delete", path: target }));
			expect(deleted.isError).toBe(true);
			expect(await Bun.file(target).text()).toBe("PRESERVE_NATIVE_TARGET");
		} finally {
			captureBridge.mockRestore();
		}
	} finally {
		await session?.dispose();
		refresh.mockRestore();
		apiKey.mockRestore();
	}
});

test("SDK refuses a missing extension tool even when native yield is required", async () => {
	const refresh = spyOn(registry, "refreshRuntimeProviders").mockResolvedValue(undefined);
	let session: AgentSession | undefined;
	try {
		const creation = createAgentSession({
			cwd: root,
			agentDir: process.env.PI_CODING_AGENT_DIR,
			settings,
			modelRegistry: registry,
			model: createMockModel(),
			evaluationPromptFile: promptPath,
			requireYieldTool: true,
			extensions: [],
		}).then(result => {
			session = result.session;
		});
		await expect(creation).rejects.toThrow("Evaluation policy requires a trusted extension tool");
	} finally {
		await session?.dispose();
		refresh.mockRestore();
	}
});

test("startup rejects an alias retargeted after an admitted read", async () => {
	const alias = join(root, "prompt-alias.txt");
	const forbidden = join(root, "alias-target.txt");
	await writeFile(forbidden, "FORBIDDEN_ALIAS_MARKER");
	await symlink(promptPath, alias);
	expect((await startup(alias)).customSystemPrompt).toBe(marker);
	await unlink(alias);
	await symlink(forbidden, alias);
	await expect(startup(alias)).rejects.toThrow();
});

test("root CLI refuses unadmitted file input before startup dependencies activate", async () => {
	let activated = false;
	const forbidden = join(root, "root-unadmitted.txt");
	await writeFile(forbidden, "FORBIDDEN_ROOT_INPUT");
	const parsed = parseArgs([
		"--print",
		"--system-prompt",
		promptPath,
		"--trusted-extension",
		join(root, "probe.ts"),
		`@${forbidden}`,
	]);
	await expect(
		main.runRootCommand(parsed, [], {
			discoverAuthStorage: async () => {
				activated = true;
				throw new Error("unreachable auth discovery");
			},
		}),
	).rejects.toThrow();
	expect(activated).toBe(false);
});

test("SDK denies descendants before activating trusted extension factories", async () => {
	let activated = false;
	await expect(
		createAgentSession({
			cwd: root,
			settings,
			modelRegistry: registry,
			evaluationPromptFile: promptPath,
			taskDepth: 1,
			extensions: [
				() => {
					activated = true;
				},
			],
		}),
	).rejects.toThrow();
	expect(activated).toBe(false);
});

test("changed policy bytes refuse an already admitted public prompt", async () => {
	const original = await Bun.file(policyPath).text();
	try {
		await writeFile(policyPath, "{}");
		await expect(startup(promptPath)).rejects.toThrow();
	} finally {
		await writeFile(policyPath, original);
	}
});

test("fresh helper admission retains original evidence identities after same-path replacement", async () => {
	const original = await fs.stat(promptPath);
	const saved = `${promptPath}.original`;
	const runner = new ExtensionRunner([], {} as never, root, { getCwd: () => root } as never, registry);
	await fs.rename(promptPath, saved);
	try {
		await writeFile(promptPath, "REPLACEMENT_MUST_NOT_BE_READMITTED");
		const admission = runner.createContext().evaluationAdmission;
		if (!admission) throw new Error("Original helper admission is unavailable");
		const evidence = admission.files.find(file => file.path === promptPath);
		expect(evidence?.ino).toBe(original.ino);
		expect(evidence?.ino).not.toBe((await fs.stat(promptPath)).ino);
		expect(Object.isFrozen(evidence)).toBe(true);
	} finally {
		await fs.unlink(promptPath);
		await fs.rename(saved, promptPath);
	}
});

test("nested extension metadata cannot mutate admission or expand tool authority", () => {
	const admission = getEvaluationAdmission();
	if (!admission) throw new Error("Original host admission is unavailable");
	const fixture = admission.admission.extension_data.fixture as { nested: { value: string }[] };
	expect(() => {
		fixture.nested[0].value = "changed";
	}).toThrow();
	expect(() => {
		(admission.admission.allowed_tools as string[]).push("eval");
	}).toThrow();
	expect(() => assertEvaluationTool("eval")).toThrow("tool is not admitted");
	expect(fixture.nested[0].value).toBe("original");
});
