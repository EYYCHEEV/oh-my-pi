/**
 * Fix round 1 for the tool-call answer seam: each test pins one finding from the builder's
 * self-check (finding numbers in the test names). The order rules themselves live in
 * `tool-call-answer-seam.test.ts`; end-to-end cases for findings 1 and 10 live in
 * `tool-call-answer-seam-session.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	discoverAndLoadExtensions,
	ExtensionRuntime,
	loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { decideToolCallAnswer } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const CACHE_PATH = "/addons/stronk-web-cache/index.ts";
const CACHE_NAME = "stronk-web-cache";
const ORIGINAL_URL = "https://example.com/page";
const CACHED = {
	content: [{ type: "text" as const, text: "<cached page>" }],
	details: { cachedAt: "2026-10-26T12:00:00Z" },
};

interface Addon {
	path: string;
	register: ExtensionFactory;
}

type ToolCallHandler = (event: { toolName: string; toolCallId: string }) => unknown;

function toolCallAddon(addonPath: string, ...handlers: ToolCallHandler[]): Addon {
	return {
		path: addonPath,
		register: pi => {
			for (const handler of handlers) pi.on("tool_call", handler as never);
		},
	};
}

const answeringAddon = (addonPath = CACHE_PATH): Addon => toolCallAddon(addonPath, () => ({ result: CACHED }));

describe("tool-call answer seam, fix round 1", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessionManager: SessionManager;
	const yolo = { settings: Settings.isolated({ "tools.approvalMode": "yolo" }) } as unknown as AgentToolContext;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-answer-seam-fixes-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.inMemory(tempDir.path());
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function makeRunner(addons: Addon[], settings?: Settings): Promise<ExtensionRunner> {
		const runtime = new ExtensionRuntime();
		const eventBus = new EventBus();
		const extensions = [];
		for (const addon of addons) {
			extensions.push(await loadExtensionFromFactory(addon.register, tempDir.path(), eventBus, runtime, addon.path));
		}
		return new ExtensionRunner(
			extensions,
			runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			settings,
		);
	}

	const emit = (runner: ExtensionRunner, toolName = "read", input: Record<string, unknown> = { path: ORIGINAL_URL }) =>
		runner.emitToolCall({ type: "tool_call", toolName, toolCallId: "c1", input } as never);

	function namedTool(name: string, executed: unknown[], extra: Record<string, unknown> = {}): AgentTool {
		return {
			name,
			label: name,
			description: `Test ${name} tool`,
			parameters: Type.Object({ path: Type.Optional(Type.String()) }),
			strict: true,
			approval: "read",
			execute: async (_id: string, params: unknown) => {
				executed.push(params);
				return { content: [{ type: "text", text: "REAL" }] };
			},
			...extra,
		} as AgentTool;
	}

	describe("finding 1: hook files bound through the extension runner cannot answer", () => {
		const hookSource = `export default function (pi) {
	pi.on("tool_call", async () => ({ result: { content: [{ type: "text", text: "x" }] } }));
}
`;

		it("blocks an answer from a hook file found by the production loader, naming the hook", async () => {
			using root = TempDir.createSync("@pi-answer-hook-");
			const hookDir = path.join(root.path(), ".omp", "hooks", "pre");
			fs.mkdirSync(hookDir, { recursive: true });
			const hookFile = path.join(hookDir, "answerer.ts");
			fs.writeFileSync(hookFile, hookSource);

			const loaded = await discoverAndLoadExtensions([], root.path(), new EventBus());
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions.map(extension => extension.path)).toContain(hookFile);

			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				root.path(),
				sessionManager,
				modelRegistry,
			);
			const result = await emit(runner);

			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("answerer");
			expect(result?.reason).toContain("hooks cannot answer tool calls");
			expect(result?.reason).not.toContain(root.path());
			expect(result).not.toHaveProperty("result");
			expect(result).not.toHaveProperty("answeredBy");
		});

		it("still lets the same file answer when it is loaded as an extension, not as a hook", async () => {
			using root = TempDir.createSync("@pi-answer-ext-");
			const extDir = path.join(root.path(), "addons");
			fs.mkdirSync(extDir, { recursive: true });
			const extFile = path.join(extDir, "answerer-ext.ts");
			fs.writeFileSync(extFile, hookSource);

			const loaded = await discoverAndLoadExtensions([extFile], root.path(), new EventBus());
			expect(loaded.errors).toEqual([]);
			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				root.path(),
				sessionManager,
				modelRegistry,
			);
			const result = await emit(runner);

			expect(result?.block).toBeUndefined();
			expect(result?.answeredBy).toBe("answerer-ext");
			expect(result?.result?.content).toEqual([{ type: "text", text: "x" }]);
		});
	});

	describe("finding 2: an answer is never applied after the call was aborted", () => {
		function initUi(
			runner: ExtensionRunner,
			select: (title: string, options: string[]) => Promise<string | undefined>,
		) {
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				} as never,
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				} as never,
				undefined,
				{ select, notify: () => {} } as never,
			);
		}
		const askContext = () =>
			({
				sessionManager,
				modelRegistry,
				model: undefined,
				isIdle: () => true,
				hasQueuedMessages: () => false,
				abort: () => {},
				settings: Settings.isolated({ "tools.approvalMode": "always-ask" }),
			}) as unknown as AgentToolContext;

		it("rejects when the prompt is approved late, after the run was aborted", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([answeringAddon()]);
			const controller = new AbortController();
			initUi(runner, async () => {
				controller.abort();
				return "Approve";
			});
			const wrapped = new ExtensionToolWrapper(
				namedTool("read", executed, {
					approval: "exec",
					formatApprovalDetails: (args: unknown) => JSON.stringify(args),
				}),
				runner,
			);

			await expect(
				wrapped.execute("c1", { path: ORIGINAL_URL }, controller.signal, undefined, askContext()),
			).rejects.toThrow("Operation aborted");
			expect(executed).toEqual([]);
		});

		it("rejects a direct dispatch that starts with an already-aborted signal", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([answeringAddon()]);
			const controller = new AbortController();
			controller.abort();
			const wrapped = new ExtensionToolWrapper(namedTool("read", executed), runner);

			await expect(
				wrapped.execute("c1", { path: ORIGINAL_URL }, controller.signal, undefined, yolo),
			).rejects.toThrow("Operation aborted");
			expect(executed).toEqual([]);
		});
	});

	describe("finding 3: the answer is snapshotted when it is validated", () => {
		it("keeps the validated answer when the add-on changes its objects afterwards", async () => {
			const kept = {
				content: [{ type: "text" as const, text: "original" }],
				details: { hits: 1, nested: { a: 1 } },
			};
			const runner = await makeRunner([toolCallAddon(CACHE_PATH, () => ({ result: kept }))]);

			const result = await emit(runner);
			kept.content[0].text = "changed";
			kept.details.hits = 2;
			kept.details.nested.a = 2;

			expect(result?.result?.content).toEqual([{ type: "text", text: "original" }]);
			expect(result?.result?.details).toEqual({ hits: 1, nested: { a: 1 } });
			expect(result?.result?.details).not.toBe(kept.details);
			expect(result?.result?.content).not.toBe(kept.content);
		});

		it("does not let two answered calls share one details object", async () => {
			const shared = { cachedAt: "now" };
			const runner = await makeRunner([
				toolCallAddon(CACHE_PATH, () => ({ result: { content: CACHED.content, details: shared } })),
			]);

			const first = await emit(runner);
			const second = await emit(runner);

			expect(first?.result?.details).toEqual(shared);
			expect(first?.result?.details).not.toBe(second?.result?.details);
		});

		it("reads a getter-backed answer once, so what was validated is what is kept", async () => {
			let reads = 0;
			const answer = {
				get content() {
					reads += 1;
					return reads === 1 ? [{ type: "text", text: "validated" }] : [{ type: "text", text: "swapped" }];
				},
			};
			const runner = await makeRunner([toolCallAddon(CACHE_PATH, () => ({ result: answer }))]);

			const result = await emit(runner);

			expect(result?.result?.content).toEqual([{ type: "text", text: "validated" }]);
		});
	});

	describe("finding 4: evicting a held answer also drops its emitted marker", () => {
		it("re-emits tool_call for a call whose held answer was evicted, so it fails closed", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([answeringAddon()]);
			const held = { answer: CACHED, answeredBy: CACHE_NAME };
			runner.markToolCallEmitted("c0", "read");
			for (let index = 0; index <= 512; index++) runner.holdToolCallAnswer(`c${index}`, "read", held);
			const wrapped = new ExtensionToolWrapper(namedTool("read", executed), runner);

			const result = await wrapped.execute("c0", { path: ORIGINAL_URL }, undefined, undefined, yolo);

			expect(executed).toEqual([]);
			expect(result.answeredBy).toBe(CACHE_NAME);
		});
	});

	describe("finding 6: a held answer is cleared by call id whatever the wire name", () => {
		it("clears every answer held for the primary agent's call id, and no other agent's", async () => {
			const runner = await makeRunner([]);
			const held = { answer: CACHED, answeredBy: CACHE_NAME };
			const advisor = { kind: "sub", id: "advisor", name: "advisor", depth: 0 } as never;
			runner.holdToolCallAnswer("c1", "read", held);
			runner.holdToolCallAnswer("c1", "alias", held);
			runner.holdToolCallAnswer("c1", "read", held, advisor);

			runner.clearToolCallAnswersForCall("c1");

			expect(runner.consumeToolCallAnswer("c1", "read")).toBeUndefined();
			expect(runner.consumeToolCallAnswer("c1", "alias")).toBeUndefined();
			expect(runner.consumeToolCallAnswer("c1", "read", advisor)).toEqual(held);
		});
	});

	describe("finding 9: held answers are scoped to the agent that prepared them", () => {
		it("never gives the primary agent's answer to an advisor call that reuses the call id", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([]);
			const held = { answer: CACHED, answeredBy: CACHE_NAME };
			runner.markToolCallEmitted("c1", "read");
			runner.holdToolCallAnswer("c1", "read", held);
			const advisor = { kind: "sub", id: "advisor", name: "advisor", depth: 0 } as never;
			const advisorWrapped = new ExtensionToolWrapper(namedTool("read", executed), runner, advisor);
			const primaryWrapped = new ExtensionToolWrapper(namedTool("read", executed), runner);

			const advisorResult = await advisorWrapped.execute("c1", { path: "/own" }, undefined, undefined, yolo);
			const primaryResult = await primaryWrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, yolo);

			expect(advisorResult.answeredBy).toBeUndefined();
			expect(advisorResult.content).toEqual([{ type: "text", text: "REAL" }]);
			expect(primaryResult.answeredBy).toBe(CACHE_NAME);
			expect(executed).toEqual([{ path: "/own" }]);
		});
	});

	describe("finding 10: calls the session interprets by tool name cannot be answered", () => {
		const answered = { answeredBy: CACHE_NAME, result: CACHED };

		it.each([
			["yield", {}],
			["checkpoint", {}],
			["rewind", {}],
			["todo", {}],
			["goal", {}],
			["ask", {}],
			["new_context", {}],
			["xd://rewind", {}],
			["write", { path: "xd://checkpoint" }],
			["write", { path: " XD://propose" }],
		])("refuses an answer for %s %j, naming the add-on", (toolName, input) => {
			const decision = decideToolCallAnswer(answered, false, toolName, input);
			expect(decision.kind).toBe("refused");
			if (decision.kind !== "refused") return;
			expect(decision.reason).toContain(CACHE_NAME);
			expect(decision.reason).toContain("The call was blocked.");
		});

		it("still allows an answer for read, bash and a write to an ordinary path", () => {
			expect(decideToolCallAnswer(answered, false, "read", { path: ORIGINAL_URL }).kind).toBe("answered");
			expect(decideToolCallAnswer(answered, false, "bash", { command: "ls" }).kind).toBe("answered");
			expect(decideToolCallAnswer(answered, false, "write", { path: "/tmp/a.txt" }).kind).toBe("answered");
		});

		it("blocks a direct dispatch of yield that an add-on tries to answer, and never runs the tool", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([answeringAddon()]);
			const wrapped = new ExtensionToolWrapper(namedTool("yield", executed), runner);

			await expect(wrapped.execute("c1", {}, undefined, undefined, yolo)).rejects.toThrow(CACHE_NAME);
			expect(executed).toEqual([]);
		});
	});

	describe("finding 11: timeout and error blocks name the extension, not its path", () => {
		it("names the extension when a handler throws", async () => {
			const runner = await makeRunner([
				toolCallAddon("/secret/dir/flaky.ts", () => {
					throw new Error("boom");
				}),
			]);

			const result = await emit(runner);

			expect(result?.block).toBe(true);
			expect(result?.reason).toBe("Extension flaky failed: boom");
			expect(result?.reason).not.toContain("/secret/dir");
		});

		it("names the extension when a handler times out", async () => {
			vi.spyOn(logger, "warn").mockImplementation(() => {});
			const runner = await makeRunner(
				[toolCallAddon("/secret/dir/hung.ts", () => new Promise(() => {}))],
				Settings.isolated({ "extensionHandlers.toolCallTimeoutMs": 10 }),
			);

			const result = await emit(runner);

			expect(result?.block).toBe(true);
			expect(result?.reason).toBe("Extension hung timed out after 10ms");
			expect(result?.reason).not.toContain("/secret/dir");
		});
	});
});
