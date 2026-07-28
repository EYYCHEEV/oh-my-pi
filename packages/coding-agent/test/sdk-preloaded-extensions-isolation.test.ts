/**
 * Regression guard for issue #2190 / PR #2193 review.
 *
 * The CLI loads extensions early to parse custom flags, then hands the result
 * back through `preloadedExtensions` so its OWN session can reuse the loaded
 * instances without redoing the FS scan. `createAgentSession()` augments the
 * result with inline extensions (autoresearch + custom-tools wrapper), so it
 * MUST clone the caller's `extensions` array before mutating it — otherwise
 * the caller's array accumulates session-local wrappers it never authored.
 *
 * Subagent forwarding is a separate path (`preloadedExtensionPaths`) which
 * reloads extensions per session so each session's `ExtensionAPI` is its own.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	loadExtensionsWithRequiredAttestation,
	type RequiredExtensionSpec,
	type RequiredExtensionStartupFailure,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("createAgentSession preloadedExtensions isolation (issue #2190)", () => {
	let sharedDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preloaded-ext-"));
		authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function expectSessionGateFailure(
		options: Pick<
			CreateAgentSessionOptions,
			| "additionalExtensionPaths"
			| "disableExtensionDiscovery"
			| "preloadedExtensionPaths"
			| "preloadedExtensions"
			| "requiredExtension"
			| "settings"
		>,
		expectedCode: RequiredExtensionStartupFailure,
		label: string,
	): Promise<void> {
		const activationMarker = path.join(sharedDir, `${label}-activated`);
		const customToolPath = path.join(sharedDir, `${label}-custom-tool.ts`);
		fs.writeFileSync(
			customToolPath,
			`import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(activationMarker)}, "custom"); export default function () { return { name: "marker" }; }`,
		);
		let mcpCalls = 0;
		const sessionManager = SessionManager.inMemory();
		try {
			await createAgentSession({
				cwd: sharedDir,
				agentDir: sharedDir,
				sessionManager,
				modelRegistry,
				settings: options.settings ?? Settings.isolated(),
				...options,
				extensions: [
					() => {
						fs.writeFileSync(activationMarker, "inline");
					},
				],
				mcpManager: {
					discoverAndConnect: async () => {
						mcpCalls++;
						return { tools: [], errors: [] };
					},
				} as never,
				enableLsp: false,
				enableMCP: true,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [
					{
						path: customToolPath,
						source: { provider: "config", providerName: "Config", level: "project" },
					},
				],
				contextFiles: [],
				promptTemplates: [],
			});
			throw new Error("expected required extension startup failure");
		} catch (error) {
			expect(error).toMatchObject({ code: expectedCode });
		}
		expect(fs.existsSync(activationMarker)).toBe(false);
		expect(mcpCalls).toBe(0);
		expect(sessionManager.getEntries().some(entry => entry.type === "session_init")).toBe(false);
	}

	it("does not mutate the caller's extensions array when preloadedExtensions is provided", async () => {
		const preloaded: LoadExtensionsResult = {
			extensions: [],
			errors: [],
			runtime: {
				flagValues: new Map(),
				pendingProviderRegistrations: [],
				// Cast: only the fields we touch matter; the SDK happily accepts a
				// minimal runtime when no extension hooks fire.
			} as unknown as LoadExtensionsResult["runtime"],
		};
		const beforeLength = preloaded.extensions.length;
		const beforeArrayRef = preloaded.extensions;

		await createAgentSession({
			cwd: sharedDir,
			agentDir: sharedDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated(),
			preloadedExtensions: preloaded,
			// Disable everything that would touch the network / FS scans.
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		});

		// The session's own `extensionsResult` carries inline wrappers, but the
		// caller's array (and its identity) must be untouched.
		expect(preloaded.extensions).toBe(beforeArrayRef);
		expect(preloaded.extensions.length).toBe(beforeLength);
	});

	it("re-attests required extensions on preloaded main and path-reloaded subagent branches", async () => {
		const content = `export default function (pi) { pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.join(sharedDir, "required-extension.ts");
		fs.writeFileSync(extensionPath, content);
		const requiredExtension: RequiredExtensionSpec = {
			path: extensionPath,
			extensionId: "extension-module:required-extension",
			expectedSha256: new Bun.SHA256().update(content).digest("hex"),
		};
		const eventBus = new EventBus();
		const preloaded = await loadExtensionsWithRequiredAttestation({ paths: [extensionPath] }, sharedDir, eventBus, {
			required: requiredExtension,
		});

		const main = await createAgentSession({
			cwd: sharedDir,
			agentDir: sharedDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated(),
			eventBus,
			preloadedExtensions: preloaded,
			requiredExtension,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		});
		const subagent = await createAgentSession({
			cwd: sharedDir,
			agentDir: sharedDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated(),
			preloadedExtensionPaths: [extensionPath],
			requiredExtension,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		});

		expect(main.session).toBeDefined();
		expect(subagent.session).toBeDefined();
	});

	it("rejects required handler replacement before construction and ignores replacement after construction", async () => {
		const content = `export default function (pi) { pi.on("tool_call", async () => ({ block: true, reason: "original" })); }`;
		const beforePath = path.join(sharedDir, "required-handler-before.ts");
		fs.writeFileSync(beforePath, content);
		const beforeRequired: RequiredExtensionSpec = {
			path: beforePath,
			extensionId: "extension-module:required-handler-before",
			expectedSha256: new Bun.SHA256().update(content).digest("hex"),
		};
		const before = await loadExtensionsWithRequiredAttestation({ paths: [beforePath] }, sharedDir, new EventBus(), {
			required: beforeRequired,
		});
		before.extensions[0]!.handlers.delete("tool_call");
		await expect(
			createAgentSession({
				cwd: sharedDir,
				agentDir: sharedDir,
				sessionManager: SessionManager.inMemory(),
				modelRegistry,
				settings: Settings.isolated(),
				preloadedExtensions: before,
				requiredExtension: beforeRequired,
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
			}),
		).rejects.toMatchObject({ code: "handler-missing" });

		const afterPath = path.join(sharedDir, "required-handler-after.ts");
		fs.writeFileSync(afterPath, content);
		const afterRequired: RequiredExtensionSpec = {
			path: afterPath,
			extensionId: "extension-module:required-handler-after",
			expectedSha256: new Bun.SHA256().update(content).digest("hex"),
		};
		const after = await loadExtensionsWithRequiredAttestation({ paths: [afterPath] }, sharedDir, new EventBus(), {
			required: afterRequired,
		});
		const created = await createAgentSession({
			cwd: sharedDir,
			agentDir: sharedDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated(),
			preloadedExtensions: after,
			requiredExtension: afterRequired,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		});
		created.extensionsResult.extensions
			.find(extension => extension.resolvedPath === afterPath)!
			.handlers.set("tool_call", [async () => ({ block: true, reason: "replacement" })] as never);
		created.extensionsResult.extensions.splice(0);
		if (!created.session.extensionRunner) throw new Error("expected extension runner");
		const result = await created.session.extensionRunner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			input: {},
			toolCallId: "immutable-required-handler",
		});
		expect(result).toEqual({ block: true, reason: "original" });
		await created.session.dispose();
	});

	it("rolls back an attested extension and restores the prior MCP singleton after late failure", async () => {
		const eventMarker = path.join(sharedDir, "late-startup-stale-event");
		const content = `import * as fs from "node:fs"; export default function (pi) {
			pi.events.on("late-startup-probe", () => fs.writeFileSync(${JSON.stringify(eventMarker)}, "stale"));
			pi.registerFlag("late-startup-flag", { type: "boolean", default: true });
			pi.registerProvider("late-startup-provider", { baseUrl: "https://late.example.com", api: "openai-completions" });
			pi.registerStatusSegment({ id: "late-startup-status", render: () => "late" });
			pi.on("tool_call", async () => {});
		}`;
		const extensionPath = path.join(sharedDir, "late-startup-required.ts");
		fs.writeFileSync(extensionPath, content);
		const requiredExtension: RequiredExtensionSpec = {
			path: extensionPath,
			extensionId: "extension-module:late-startup-required",
			expectedSha256: new Bun.SHA256().update(content).digest("hex"),
		};
		const eventBus = new EventBus();
		const registry = new AgentRegistry();
		const register = vi.spyOn(registry, "register").mockImplementationOnce(() => {
			throw new Error("late registry failure");
		});
		const previousMcpManager = MCPManager.instance();
		const priorMcpManager = new MCPManager(sharedDir, null);
		MCPManager.setInstance(priorMcpManager);
		const baseOptions: CreateAgentSessionOptions = {
			cwd: sharedDir,
			agentDir: sharedDir,
			modelRegistry,
			settings: Settings.isolated(),
			requiredExtension,
			disableExtensionDiscovery: true,
			eventBus,
			agentRegistry: registry,
			enableLsp: false,
			enableMCP: true,
			hasUI: true,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		};

		try {
			await expect(
				createAgentSession({ ...baseOptions, sessionManager: SessionManager.inMemory() }),
			).rejects.toThrow("late registry failure");
			expect(MCPManager.instance()).toBe(priorMcpManager);
			eventBus.emit("late-startup-probe", undefined);
			expect(fs.existsSync(eventMarker)).toBe(false);

			register.mockRestore();
			const retried = await createAgentSession({
				...baseOptions,
				enableMCP: false,
				hasUI: false,
				sessionManager: SessionManager.inMemory(),
			});
			expect(retried.session).toBeDefined();
			await retried.session.dispose();
		} finally {
			MCPManager.setInstance(previousMcpManager);
			await priorMcpManager.disconnectAll();
		}
	});

	it("enforces the settings-backed required extension on fresh main startup", async () => {
		const content = `export default function (pi) { pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.join(sharedDir, "settings-required-extension.ts");
		fs.writeFileSync(extensionPath, content);
		const session = await createAgentSession({
			cwd: sharedDir,
			agentDir: sharedDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated({
				"requiredExtension.path": extensionPath,
				"requiredExtension.id": "extension-module:settings-required-extension",
				"requiredExtension.sha256": new Bun.SHA256().update(content).digest("hex"),
			}),
			disableExtensionDiscovery: true,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		});
		expect(session.session).toBeDefined();
	});

	it("fails closed before tool, MCP, or Agent activation on fresh and path-reloaded branches", async () => {
		const missingPath = path.join(sharedDir, "missing-required.ts");
		await expectSessionGateFailure(
			{
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [missingPath],
				requiredExtension: {
					path: missingPath,
					extensionId: "extension-module:missing-required",
					expectedSha256: "0".repeat(64),
				},
			},
			"missing",
			"missing-main",
		);

		const factoryMarker = path.join(sharedDir, "required-factory-ran");
		const validContent = `import * as fs from "node:fs"; export default function (pi) { fs.writeFileSync(${JSON.stringify(factoryMarker)}, "yes"); pi.on("tool_call", async () => {}); }`;
		const validPath = path.join(sharedDir, "path-required.ts");
		fs.writeFileSync(validPath, validContent);
		const validRequired: RequiredExtensionSpec = {
			path: validPath,
			extensionId: "extension-module:path-required",
			expectedSha256: new Bun.SHA256().update(validContent).digest("hex"),
		};
		await expectSessionGateFailure(
			{
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [validPath],
				settings: Settings.isolated({ "requiredExtension.path": validPath }),
			},
			"load-failed",
			"partial-settings-main",
		);
		await expectSessionGateFailure(
			{
				preloadedExtensionPaths: [validPath],
				requiredExtension: { ...validRequired, expectedSha256: "0".repeat(64) },
			},
			"hash-mismatch",
			"hash-subagent",
		);
		expect(fs.existsSync(factoryMarker)).toBe(false);

		await expectSessionGateFailure(
			{
				preloadedExtensionPaths: [validPath],
				requiredExtension: validRequired,
				settings: Settings.isolated({ disabledExtensions: [validRequired.extensionId] }),
			},
			"disabled",
			"disabled-subagent",
		);
		expect(fs.existsSync(factoryMarker)).toBe(false);

		const handlerMissingContent = `export default function (pi) { pi.registerFlag("loaded", { type: "boolean", default: true }); }`;
		const handlerMissingPath = path.join(sharedDir, "handler-missing.ts");
		fs.writeFileSync(handlerMissingPath, handlerMissingContent);
		await expectSessionGateFailure(
			{
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [handlerMissingPath],
				requiredExtension: {
					path: handlerMissingPath,
					extensionId: "extension-module:handler-missing",
					expectedSha256: new Bun.SHA256().update(handlerMissingContent).digest("hex"),
				},
			},
			"handler-missing",
			"handler-main",
		);
	});

	it("rejects unbranded, hash-mismatched, and disabled preloaded handoffs before activation", async () => {
		const content = `export default function (pi) { pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.join(sharedDir, "preloaded-failure.ts");
		fs.writeFileSync(extensionPath, content);
		const required: RequiredExtensionSpec = {
			path: extensionPath,
			extensionId: "extension-module:preloaded-failure",
			expectedSha256: new Bun.SHA256().update(content).digest("hex"),
		};
		const unbranded = await loadExtensionsWithRequiredAttestation(
			{ paths: [extensionPath] },
			sharedDir,
			new EventBus(),
		);
		await expectSessionGateFailure(
			{ preloadedExtensions: unbranded, requiredExtension: required },
			"load-failed",
			"unbranded-preloaded",
		);

		const mismatched = await loadExtensionsWithRequiredAttestation(
			{ paths: [extensionPath] },
			sharedDir,
			new EventBus(),
			{ required },
		);
		await expectSessionGateFailure(
			{
				preloadedExtensions: mismatched,
				requiredExtension: { ...required, expectedSha256: "0".repeat(64) },
			},
			"hash-mismatch",
			"mismatched-preloaded",
		);

		const disabled = await loadExtensionsWithRequiredAttestation(
			{ paths: [extensionPath] },
			sharedDir,
			new EventBus(),
			{ required },
		);
		await expectSessionGateFailure(
			{
				preloadedExtensions: disabled,
				requiredExtension: required,
				settings: Settings.isolated({ disabledExtensions: [required.extensionId] }),
			},
			"disabled",
			"disabled-preloaded",
		);
	});

	it("cold revive uses the frozen attested spec and canonical additional path", async () => {
		const content = `export default function (pi) { pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.join(sharedDir, "cold-revive-required.ts");
		fs.writeFileSync(extensionPath, content);
		const required: RequiredExtensionSpec = Object.freeze({
			path: extensionPath,
			extensionId: "extension-module:cold-revive-required",
			expectedSha256: new Bun.SHA256().update(content).digest("hex"),
		});
		const settings = Settings.isolated({
			"requiredExtension.path": extensionPath,
			"requiredExtension.id": required.extensionId,
			"requiredExtension.sha256": required.expectedSha256,
		});
		vi.spyOn(SessionManager, "peekSessionInit").mockResolvedValue({
			cwd: sharedDir,
			init: {
				systemPrompt: "cold revive",
				task: "resume",
				tools: ["read", "yield"],
				spawns: "",
				readSummarize: true,
			},
		});
		vi.spyOn(SessionManager, "open").mockImplementation(async () => SessionManager.inMemory(sharedDir));
		const factory = createPersistedSubagentReviverFactory({
			session: {
				sessionManager: {
					getCwd: () => sharedDir,
					getArtifactManager: () => undefined,
				},
			} as unknown as AgentSession,
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
			requiredExtension: required,
			extensionPaths: Object.freeze([extensionPath]),
		});
		const ref = {
			id: "cold-required",
			displayName: "task",
			kind: "sub",
			parentId: "main",
			status: "parked",
			session: null,
			sessionFile: path.join(sharedDir, "cold-required.jsonl"),
			createdAt: Date.now(),
			lastActivity: Date.now(),
		} as const;
		const registeredRef = AgentRegistry.global().register(ref);
		const revive = await factory(registeredRef);
		if (!revive) throw new Error("expected cold reviver");

		settings.set("requiredExtension.path", path.join(sharedDir, "wrong.ts"));
		settings.set("requiredExtension.id", "extension-module:wrong");
		settings.set("requiredExtension.sha256", "0".repeat(64));
		const revived = await revive(registeredRef);
		expect(revived).toBeDefined();
		await revived.dispose();

		fs.writeFileSync(extensionPath, `${content}\n// changed`);
		const mismatchRef = AgentRegistry.global().register(ref);
		const mismatchedRevive = await factory(mismatchRef);
		if (!mismatchedRevive) throw new Error("expected mismatch cold reviver");
		await expect(mismatchedRevive(mismatchRef)).rejects.toMatchObject({ code: "hash-mismatch" });
	});
});
