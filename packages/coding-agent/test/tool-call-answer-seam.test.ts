/**
 * The tool-call answer seam: a `tool_call` handler may answer the call itself, and the
 * tool then does not run. These tests cover the runner (order rules, validation, fail
 * closed), the wrapper (approval gate, postflight, `tool_result`, direct calls) and the
 * legacy hook runner. The end-to-end session tests live in
 * `tool-call-answer-seam-session.test.ts`.
 *
 * "Rule N" in a test name is the numbered order rule of the seam design:
 *  1 handler order, 2 a block always wins, 3 an answer does not stop the loop, 4 last
 *  answer wins and is tracked on its own, 5 an answer cancels input rewrites, 6 context
 *  is kept, 7 approval is unchanged, 8 `tool_result` still runs, 9 fail closed,
 *  10 one answer per call.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { HookRunner, type LoadedHook } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { HookToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/tool-wrapper";
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

/** An add-on whose `tool_call` handlers are `handlers`, registered in order. */
function toolCallAddon(path: string, ...handlers: ToolCallHandler[]): Addon {
	return {
		path,
		register: pi => {
			for (const handler of handlers) pi.on("tool_call", handler as never);
		},
	};
}

/** An add-on that answers every call with {@link CACHED}. */
function answeringAddon(path = CACHE_PATH): Addon {
	return toolCallAddon(path, () => ({ result: CACHED }));
}

describe("tool-call answer seam", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessionManager: SessionManager;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-answer-seam-");
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

	const emit = (runner: ExtensionRunner, signal?: AbortSignal, toolCallId = "c1") =>
		runner.emitToolCall(
			{ type: "tool_call", toolName: "read", toolCallId, input: { path: ORIGINAL_URL } } as never,
			signal,
		);

	describe("runner: order rules", () => {
		it("returns the answer with answeredBy set to the add-on name, never its path (rules 1 and 9)", async () => {
			for (const [path, name] of [
				["/addons/stronk-web-cache/index.ts", "stronk-web-cache"],
				["/addons/stronk-web-cache/index.js", "stronk-web-cache"],
				["/addons/solo.ts", "solo"],
				["C:\\addons\\winlike.js", "winlike"],
			] as const) {
				const runner = await makeRunner([answeringAddon(path)]);
				const result = await emit(runner);
				expect(result).toEqual({ result: CACHED, answeredBy: name });
				expect(JSON.stringify(result)).not.toContain("addons");
			}
		});

		it("keeps an answer without details as content only", async () => {
			const runner = await makeRunner([toolCallAddon(CACHE_PATH, () => ({ result: { content: CACHED.content } }))]);
			expect(await emit(runner)).toEqual({ result: { content: CACHED.content }, answeredBy: CACHE_NAME });
		});

		it("a later block discards an earlier answer (rule 2)", async () => {
			const runner = await makeRunner([
				answeringAddon(),
				toolCallAddon("/addons/policy.ts", () => ({ block: true, reason: "not allowed" })),
			]);
			expect(await emit(runner)).toEqual({ block: true, reason: "not allowed" });
		});

		it("a block before an answer wins and the later handler never runs (rule 2)", async () => {
			const later = vi.fn(() => ({ result: CACHED }));
			const runner = await makeRunner([
				toolCallAddon("/addons/policy.ts", () => ({ block: true, reason: "not allowed" })),
				toolCallAddon(CACHE_PATH, later),
			]);
			expect(await emit(runner)).toEqual({ block: true, reason: "not allowed" });
			expect(later).not.toHaveBeenCalled();
		});

		it("a block that also carries an answer returns only the block (rules 2 and 9)", async () => {
			const runner = await makeRunner([
				toolCallAddon(CACHE_PATH, () => ({ block: true, reason: "no", result: CACHED, answeredBy: "forged" })),
			]);
			expect(await emit(runner)).toEqual({ block: true, reason: "no" });
		});

		it("an answer does not stop the loop: every later handler still runs (rule 3)", async () => {
			const seen: string[] = [];
			const runner = await makeRunner([
				toolCallAddon(CACHE_PATH, () => {
					seen.push("cache");
					return { result: CACHED };
				}),
				toolCallAddon(
					"/addons/audit.ts",
					() => {
						seen.push("audit-1");
						return undefined;
					},
					() => {
						seen.push("audit-2");
						return undefined;
					},
				),
			]);
			expect(await emit(runner)).toEqual({ result: CACHED, answeredBy: CACHE_NAME });
			expect(seen).toEqual(["cache", "audit-1", "audit-2"]);
		});

		it("with two answers the last one wins, in registration order (rule 4)", async () => {
			const second = { content: [{ type: "text" as const, text: "second answer" }] };
			const runner = await makeRunner([
				answeringAddon("/addons/first/index.ts"),
				toolCallAddon("/addons/second.ts", () => ({ result: second })),
			]);
			expect(await emit(runner)).toEqual({ result: second, answeredBy: "second" });
		});

		it("a later handler that only adds context cannot erase an earlier answer (rule 4)", async () => {
			const runner = await makeRunner([
				answeringAddon(),
				toolCallAddon("/addons/context.ts", () => ({ additionalContext: "use the cached copy" })),
				toolCallAddon("/addons/quiet.ts", () => undefined),
			]);
			expect(await emit(runner)).toEqual({
				result: CACHED,
				answeredBy: CACHE_NAME,
				additionalContext: "use the cached copy",
			});
		});

		it("context collected before the answer is kept too (rule 6)", async () => {
			const runner = await makeRunner([
				toolCallAddon("/addons/context.ts", () => ({ additionalContext: "first context" })),
				toolCallAddon(CACHE_PATH, () => ({ result: CACHED, additionalContext: "second context" })),
			]);
			expect(await emit(runner)).toEqual({
				result: CACHED,
				answeredBy: CACHE_NAME,
				additionalContext: "first context\n\nsecond context",
			});
		});

		it("an input rewrite after an answer is dropped (rule 5)", async () => {
			const runner = await makeRunner([
				answeringAddon(),
				toolCallAddon("/addons/rewrite.ts", () => ({ input: { path: "https://example.com/other" } })),
			]);
			const result = await emit(runner);
			expect(result).toEqual({ result: CACHED, answeredBy: CACHE_NAME });
			expect(result).not.toHaveProperty("input");
		});

		it("an input rewrite before an answer is dropped (rule 5)", async () => {
			const runner = await makeRunner([
				toolCallAddon("/addons/rewrite.ts", () => ({ input: { path: "https://example.com/other" } })),
				answeringAddon(),
			]);
			const result = await emit(runner);
			expect(result).toEqual({ result: CACHED, answeredBy: CACHE_NAME });
			expect(result).not.toHaveProperty("input");
		});

		it("an input rewrite in the same result as the answer is dropped (rule 5)", async () => {
			const runner = await makeRunner([
				toolCallAddon(CACHE_PATH, () => ({ result: CACHED, input: { path: "https://example.com/other" } })),
			]);
			expect(await emit(runner)).toEqual({ result: CACHED, answeredBy: CACHE_NAME });
		});

		it("without an answer an input rewrite still applies as today (rule 5 boundary)", async () => {
			const runner = await makeRunner([
				toolCallAddon("/addons/rewrite.ts", () => ({ input: { path: "https://example.com/other" } })),
			]);
			expect(await emit(runner)).toEqual({ input: { path: "https://example.com/other" } });
		});

		it("a handler cannot set answeredBy (rule 9)", async () => {
			const withAnswer = await makeRunner([
				toolCallAddon(CACHE_PATH, () => ({ result: CACHED, answeredBy: "forged" })),
			]);
			expect(await emit(withAnswer)).toEqual({ result: CACHED, answeredBy: CACHE_NAME });

			const withoutAnswer = await makeRunner([
				toolCallAddon(CACHE_PATH, () => ({ additionalContext: "note", answeredBy: "forged" })),
			]);
			const result = await emit(withoutAnswer);
			expect(result).toEqual({ additionalContext: "note" });
			expect(result).not.toHaveProperty("answeredBy");
		});
	});

	describe("runner: fail closed (rule 9)", () => {
		const text = { type: "text", text: "cached" };
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const malformed: Array<[string, unknown]> = [
			["content missing", {}],
			["content that is not a list", { content: "cached" }],
			["content that is an empty list", { content: [] }],
			["a block of an unknown type", { content: [{ type: "audio", data: "x" }] }],
			["a null block", { content: [null] }],
			["a text block without text", { content: [{ type: "text" }] }],
			["a text block whose text is not a string", { content: [{ type: "text", text: 5 }] }],
			["an image block without data", { content: [{ type: "image", mimeType: "image/png" }] }],
			["an image block without a mime type", { content: [{ type: "image", data: "AAAA" }] }],
			["isError set to true", { content: [text], isError: true }],
			["isError set to false", { content: [text], isError: false }],
			["details with a cycle", { content: [text], details: circular }],
			["details with a bigint", { content: [text], details: { n: 1n } }],
			["details that is a function", { content: [text], details: () => 1 }],
			["an answer that is null", null],
			["an answer that is a string", "cached"],
			["an answer that is a list", [text]],
		];

		it.each(malformed)(
			"blocks a malformed answer: %s, naming the add-on (rule 12: malformed answer)",
			async (_label, shape) => {
				const later = vi.fn(() => undefined);
				const runner = await makeRunner([
					toolCallAddon(CACHE_PATH, () => ({ result: shape })),
					toolCallAddon("/addons/later.ts", later),
				]);
				const result = await emit(runner);
				expect(result?.block).toBe(true);
				expect(result?.reason).toContain(CACHE_NAME);
				expect(result?.reason).not.toContain("/addons/");
				expect(result).not.toHaveProperty("result");
				expect(result).not.toHaveProperty("answeredBy");
				expect(later).not.toHaveBeenCalled();
			},
		);

		it("accepts an image answer and details that survive JSON", async () => {
			const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
			const answer = {
				content: [image, { type: "text" as const, text: "caption" }],
				details: { n: 1, list: [null, "a"] },
			};
			const runner = await makeRunner([toolCallAddon(CACHE_PATH, () => ({ result: answer }))]);
			expect(await emit(runner)).toEqual({ result: answer, answeredBy: CACHE_NAME });
		});

		it("blocks when a handler throws after an answer (rule 12: error after answer)", async () => {
			const runner = await makeRunner([
				answeringAddon(),
				toolCallAddon("/addons/broken.ts", () => {
					throw new Error("boom");
				}),
			]);
			runner.onError(() => {});
			const result = await emit(runner);
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("boom");
			expect(result).not.toHaveProperty("result");
			expect(result).not.toHaveProperty("answeredBy");
		});

		it("blocks when a handler times out after an answer (rule 12: timeout after answer)", async () => {
			vi.spyOn(logger, "warn").mockImplementation(() => {});
			const runner = await makeRunner(
				[answeringAddon(), toolCallAddon("/addons/hung.ts", () => Promise.withResolvers<void>().promise)],
				Settings.isolated({ "extensionHandlers.toolCallTimeoutMs": 10 }),
			);
			runner.onError(() => {});
			const result = await emit(runner);
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("timed out after 10ms");
			expect(result).not.toHaveProperty("result");
			expect(result).not.toHaveProperty("answeredBy");
		});

		it("blocks when the call is aborted while a later handler is pending (rule 10)", async () => {
			const controller = new AbortController();
			const hold = Promise.withResolvers<void>();
			const runner = await makeRunner([
				answeringAddon(),
				toolCallAddon("/addons/slow.ts", async () => {
					controller.abort();
					await hold.promise;
				}),
			]);
			const result = await emit(runner, controller.signal);
			hold.resolve();
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("cancelled");
			expect(result).not.toHaveProperty("result");
			expect(result).not.toHaveProperty("answeredBy");
		});
	});

	describe("runner: one answer per call (rule 10)", () => {
		const held = { answer: CACHED, answeredBy: CACHE_NAME };

		it("holds an answer for that exact call id and tool name and hands it out once", async () => {
			const runner = await makeRunner([]);
			runner.holdToolCallAnswer("c1", "read", held);
			expect(runner.consumeToolCallAnswer("c2", "read")).toBeUndefined();
			expect(runner.consumeToolCallAnswer("c1", "write")).toBeUndefined();
			expect(runner.consumeToolCallAnswer("c1", "read")).toEqual(held);
			expect(runner.consumeToolCallAnswer("c1", "read")).toBeUndefined();
		});

		it("drops a held answer when the loop dispatch is cleared", async () => {
			const runner = await makeRunner([]);
			runner.markLoopToolCall("c1", "read");
			runner.holdToolCallAnswer("c1", "read", held);
			runner.clearLoopToolCall("c1", "read");
			expect(runner.consumeToolCallAnswer("c1", "read")).toBeUndefined();
		});

		it("drops a held answer when a fresh dispatch of the same call starts", async () => {
			const runner = await makeRunner([]);
			runner.holdToolCallAnswer("c1", "read", held);
			runner.markLoopToolCall("c1", "read");
			expect(runner.consumeToolCallAnswer("c1", "read")).toBeUndefined();
		});

		it("drops one held answer by key and every held answer at once", async () => {
			const runner = await makeRunner([]);
			runner.holdToolCallAnswer("c1", "read", held);
			runner.holdToolCallAnswer("c2", "read", held);
			runner.clearToolCallAnswer("c1", "read");
			expect(runner.consumeToolCallAnswer("c1", "read")).toBeUndefined();
			expect(runner.consumeToolCallAnswer("c2", "read")).toEqual(held);
			runner.holdToolCallAnswer("c3", "read", held);
			runner.holdToolCallAnswer("c4", "read", held);
			runner.clearToolCallAnswers();
			expect(runner.consumeToolCallAnswer("c3", "read")).toBeUndefined();
			expect(runner.consumeToolCallAnswer("c4", "read")).toBeUndefined();
		});
	});

	describe("wrapper: direct calls", () => {
		const yolo = { settings: Settings.isolated({ "tools.approvalMode": "yolo" }) } as unknown as AgentToolContext;

		function readTool(executed: unknown[], extra: Record<string, unknown> = {}): AgentTool {
			return {
				name: "read",
				label: "Read",
				description: "Test read tool",
				parameters: Type.Object({ path: Type.String() }),
				strict: true,
				approval: "read",
				execute: async (_id: string, params: unknown) => {
					executed.push(params);
					return { content: [{ type: "text", text: "REAL" }] };
				},
				...extra,
			} as AgentTool;
		}

		function withContext(delivered: string[], base: object = yolo): AgentToolContext {
			return {
				...base,
				addAdditionalContext: (context: string) => delivered.push(context),
			} as unknown as AgentToolContext;
		}

		it("never calls the tool's execute and returns the answer with answeredBy (rules 1 and 7)", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([answeringAddon()]);
			const wrapped = new ExtensionToolWrapper(readTool(executed), runner);

			const result = await wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, yolo);

			expect(executed).toEqual([]);
			expect(result).toEqual({ content: CACHED.content, details: CACHED.details, answeredBy: CACHE_NAME });
			expect(result.isError).toBeUndefined();
		});

		it("never lets a tool that really ran claim answeredBy, in the result or the tool_result event (rule 9)", async () => {
			const seen: Array<Record<string, unknown>> = [];
			const runner = await makeRunner([
				{
					path: "/addons/audit.ts",
					register: pi => {
						pi.on("tool_result", ((event: Record<string, unknown>) => {
							seen.push(event);
						}) as never);
					},
				},
			]);
			const forging = readTool([], {
				execute: async () => ({ content: [{ type: "text", text: "REAL" }], answeredBy: CACHE_NAME }),
			});

			const result = await new ExtensionToolWrapper(forging, runner).execute(
				"c1",
				{ path: ORIGINAL_URL },
				undefined,
				undefined,
				yolo,
			);

			expect(result.content).toEqual([{ type: "text", text: "REAL" }]);
			expect(result).not.toHaveProperty("answeredBy");
			expect(seen).toHaveLength(1);
			expect(seen[0]).not.toHaveProperty("answeredBy");
		});

		it("applies the model's original input to approval and ignores a rewrite (rule 5)", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([
				toolCallAddon(CACHE_PATH, () => ({ result: CACHED, input: { path: "https://example.com/other" } })),
			]);
			const seen: unknown[] = [];
			const wrapped = new ExtensionToolWrapper(
				readTool(executed, {
					approval: (args: unknown) => {
						seen.push(args);
						return "read";
					},
				}),
				runner,
			);

			await wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, yolo);

			expect(executed).toEqual([]);
			expect(seen.length).toBeGreaterThan(0);
			for (const args of seen) expect(args).toEqual({ path: ORIGINAL_URL });
		});

		it("lets tool_result handlers see the answered result, with answeredBy (rule 8)", async () => {
			const seen: Array<Record<string, unknown>> = [];
			const runner = await makeRunner([
				answeringAddon(),
				{
					path: "/addons/audit.ts",
					register: pi => {
						pi.on("tool_result", ((event: Record<string, unknown>) => {
							seen.push(event);
						}) as never);
					},
				},
			]);
			const wrapped = new ExtensionToolWrapper(readTool([]), runner);

			await wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, yolo);

			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatchObject({
				toolName: "read",
				toolCallId: "c1",
				input: { path: ORIGINAL_URL },
				content: CACHED.content,
				details: CACHED.details,
				isError: false,
				answeredBy: CACHE_NAME,
			});
		});

		it("lets a tool_result handler change the answered result and still marks it answered (rule 8)", async () => {
			const runner = await makeRunner([
				answeringAddon(),
				{
					path: "/addons/redact.ts",
					register: pi => {
						pi.on("tool_result", (() => ({ content: [{ type: "text", text: "<redacted>" }] })) as never);
					},
				},
			]);
			const wrapped = new ExtensionToolWrapper(readTool([]), runner);

			const result = await wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, yolo);

			expect(result.content).toEqual([{ type: "text", text: "<redacted>" }]);
			expect(result.isError).toBeUndefined();
			expect(result.answeredBy).toBe(CACHE_NAME);
		});

		it("still runs the preflight before and postflight after an answered call (rule 7)", async () => {
			const runner = await makeRunner([answeringAddon()]);
			const before = vi.fn(async () => undefined);
			const after = vi.fn((_id: string, result: { content: unknown[] }) => ({
				...result,
				content: [{ type: "text", text: "[reminder]" }, ...result.content],
			}));
			const cancel = vi.fn();
			runner.setToolCallPreflight({ before, after: after as never, cancel });
			const wrapped = new ExtensionToolWrapper(readTool([]), runner);

			const result = await wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, yolo);

			expect(before).toHaveBeenCalledTimes(1);
			expect(after).toHaveBeenCalledTimes(1);
			expect(after.mock.calls[0]?.[1]).toMatchObject({ content: CACHED.content, answeredBy: CACHE_NAME });
			expect(cancel).not.toHaveBeenCalled();
			expect(result.content).toEqual([{ type: "text", text: "[reminder]" }, ...CACHED.content]);
			expect(result.answeredBy).toBe(CACHE_NAME);
		});

		it("delivers pending additionalContext after an answered result, as for any successful call (rule 6)", async () => {
			const runner = await makeRunner([
				answeringAddon(),
				toolCallAddon("/addons/context.ts", () => ({ additionalContext: "use the cached copy" })),
			]);
			const delivered: string[] = [];
			const wrapped = new ExtensionToolWrapper(readTool([]), runner);

			await wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, withContext(delivered));

			expect(delivered).toEqual(["use the cached copy"]);
		});

		it("does not deliver context for a call that a later handler blocks (rules 2 and 6)", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([
				answeringAddon(),
				toolCallAddon("/addons/context.ts", () => ({ additionalContext: "must not leak" })),
				toolCallAddon("/addons/policy.ts", () => ({ block: true, reason: "not allowed" })),
			]);
			const delivered: string[] = [];
			const wrapped = new ExtensionToolWrapper(readTool(executed), runner);

			await expect(
				wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, withContext(delivered)),
			).rejects.toThrow("not allowed");
			expect(executed).toEqual([]);
			expect(delivered).toEqual([]);
		});

		it("a deny policy stops the call before any handler runs (rule 7)", async () => {
			const handler = vi.fn(() => ({ result: CACHED }));
			const executed: unknown[] = [];
			const runner = await makeRunner([toolCallAddon(CACHE_PATH, handler)]);
			const wrapped = new ExtensionToolWrapper(
				readTool(executed, { approval: () => ({ policy: "deny", reason: "dangerous" }) }),
				runner,
			);

			await expect(wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, yolo)).rejects.toThrow(
				'Tool "read" is blocked by tool policy.\nReason: dangerous',
			);
			expect(handler).not.toHaveBeenCalled();
			expect(executed).toEqual([]);
		});

		describe("with a prompt", () => {
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
			const promptingTool = (executed: unknown[]) =>
				readTool(executed, {
					approval: "exec",
					formatApprovalDetails: (args: unknown) => JSON.stringify(args),
				});

			it("returns the answer only after the prompt is approved, and never runs execute (rule 7)", async () => {
				const executed: unknown[] = [];
				const runner = await makeRunner([answeringAddon()]);
				const select = vi.fn(async () => "Approve");
				initUi(runner, select);
				const wrapped = new ExtensionToolWrapper(promptingTool(executed), runner);

				const result = await wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, askContext());

				expect(select).toHaveBeenCalledTimes(1);
				const title = (select.mock.calls[0] as unknown as [string])[0];
				expect(title).toContain(ORIGINAL_URL);
				expect(title).not.toContain("<cached page>");
				expect(executed).toEqual([]);
				expect(result).toEqual({ content: CACHED.content, details: CACHED.details, answeredBy: CACHE_NAME });
			});

			it("discards the answer when the prompt is denied (rule 7, rule 12: denied prompt)", async () => {
				const executed: unknown[] = [];
				const runner = await makeRunner([
					answeringAddon(),
					toolCallAddon("/addons/context.ts", () => ({ additionalContext: "must not leak" })),
				]);
				initUi(runner, async () => "Deny");
				const delivered: string[] = [];
				const wrapped = new ExtensionToolWrapper(promptingTool(executed), runner);

				await expect(
					wrapped.execute(
						"c1",
						{ path: ORIGINAL_URL },
						undefined,
						undefined,
						withContext(delivered, askContext()),
					),
				).rejects.toThrow("Tool call denied by user: read");
				expect(executed).toEqual([]);
				expect(delivered).toEqual([]);
			});

			it("a held answer is not used when the prompt is denied, and nothing stays held (rules 7 and 10)", async () => {
				const executed: unknown[] = [];
				const runner = await makeRunner([]);
				initUi(runner, async () => "Deny");
				runner.markLoopToolCall("c1", "read");
				runner.markToolCallEmitted("c1", "read");
				runner.holdToolCallAnswer("c1", "read", { answer: CACHED, answeredBy: CACHE_NAME });
				const wrapped = new ExtensionToolWrapper(promptingTool(executed), runner);

				await expect(
					wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, askContext()),
				).rejects.toThrow("Tool call denied by user: read");
				expect(executed).toEqual([]);
				expect(runner.consumeToolCallAnswer("c1", "read")).toBeUndefined();
			});
		});

		it("blocks an answer for a computer tool call, naming the add-on (rule 9)", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([answeringAddon()]);
			const computer = {
				...yolo,
				toolCall: {
					providerMetadata: { type: "computer", actions: [{ type: "screenshot" }], pendingSafetyChecks: [] },
					toolCalls: [{ id: "c1", name: "read" }],
					index: 0,
				},
			} as unknown as AgentToolContext;
			const wrapped = new ExtensionToolWrapper(readTool(executed), runner);

			await expect(wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, computer)).rejects.toThrow(
				CACHE_NAME,
			);
			expect(executed).toEqual([]);
		});
	});

	describe("wrapper: loop dispatches", () => {
		const yolo = { settings: Settings.isolated({ "tools.approvalMode": "yolo" }) } as unknown as AgentToolContext;
		const held = { answer: CACHED, answeredBy: CACHE_NAME };
		const tool = (executed: unknown[]) =>
			({
				name: "read",
				label: "Read",
				description: "Test read tool",
				parameters: Type.Object({ path: Type.String() }),
				strict: true,
				approval: "read",
				execute: async (_id: string, params: unknown) => {
					executed.push(params);
					return { content: [{ type: "text", text: "REAL" }] };
				},
			}) as AgentTool;
		const dispatch = (runner: ExtensionRunner, id: string, name = "read") => {
			runner.markLoopToolCall(id, name);
			runner.markToolCallEmitted(id, name);
		};

		it("applies the answer the loop held, without emitting tool_call a second time (rules 7 and 10)", async () => {
			const handler = vi.fn(() => undefined);
			const executed: unknown[] = [];
			const runner = await makeRunner([toolCallAddon("/addons/watch.ts", handler)]);
			dispatch(runner, "c1");
			runner.holdToolCallAnswer("c1", "read", held);
			const wrapped = new ExtensionToolWrapper(tool(executed), runner);

			const result = await wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, yolo);

			expect(handler).not.toHaveBeenCalled();
			expect(executed).toEqual([]);
			expect(result).toEqual({ content: CACHED.content, details: CACHED.details, answeredBy: CACHE_NAME });
		});

		it("uses a held answer once: a second dispatch of the same call runs the tool (rule 10)", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([]);
			dispatch(runner, "c1");
			runner.holdToolCallAnswer("c1", "read", held);
			const wrapped = new ExtensionToolWrapper(tool(executed), runner);

			await wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, yolo);
			dispatch(runner, "c1");
			const second = await wrapped.execute("c1", { path: ORIGINAL_URL }, undefined, undefined, yolo);

			expect(executed).toEqual([{ path: ORIGINAL_URL }]);
			expect(second.content).toEqual([{ type: "text", text: "REAL" }]);
			expect(second).not.toHaveProperty("answeredBy");
		});

		it("never gives an answer held for call A to call B (rule 10)", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([]);
			dispatch(runner, "call-a");
			dispatch(runner, "call-b");
			runner.holdToolCallAnswer("call-a", "read", held);
			const wrapped = new ExtensionToolWrapper(tool(executed), runner);

			const b = await wrapped.execute("call-b", { path: "/local/b.txt" }, undefined, undefined, yolo);

			expect(executed).toEqual([{ path: "/local/b.txt" }]);
			expect(b).not.toHaveProperty("answeredBy");
			// Call A's answer is still waiting for call A.
			expect(runner.consumeToolCallAnswer("call-a", "read")).toEqual(held);
		});

		it("never gives an answer held for one tool name to the same call id under another name (rule 10)", async () => {
			const executed: unknown[] = [];
			const runner = await makeRunner([]);
			dispatch(runner, "c1", "write");
			runner.holdToolCallAnswer("c1", "read", held);
			const wrapped = new ExtensionToolWrapper({ ...tool(executed), name: "write" } as AgentTool, runner);

			const result = await wrapped.execute("c1", { path: "/local/b.txt" }, undefined, undefined, yolo);

			expect(executed).toEqual([{ path: "/local/b.txt" }]);
			expect(result).not.toHaveProperty("answeredBy");
		});
	});

	describe("hooks", () => {
		function makeHook(handler: (event: unknown) => unknown): LoadedHook {
			const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
			handlers.set("tool_call", [async (event: unknown) => handler(event)]);
			return {
				path: "legacy-cache-hook",
				resolvedPath: "/test/legacy-cache-hook.ts",
				handlers,
				messageRenderers: new Map(),
				commands: new Map(),
				setSendMessageHandler: () => {},
				setAppendEntryHandler: () => {},
			} as unknown as LoadedHook;
		}
		const makeHookRunner = (hooks: LoadedHook[]) =>
			new HookRunner(hooks, tempDir.path(), SessionManager.inMemory(), modelRegistry);

		it("blocks a hook that returns a result, with a clear reason naming the hook", async () => {
			const runner = makeHookRunner([makeHook(() => ({ result: CACHED }))]);
			const result = await runner.emitToolCall({
				type: "tool_call",
				toolName: "read",
				toolCallId: "c1",
				input: { path: ORIGINAL_URL },
			} as never);
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("legacy-cache-hook");
			expect(result?.reason).toContain("cannot answer");
			expect(result).not.toHaveProperty("result");
		});

		it("stops the tool from running when a hook tries to answer", async () => {
			const executed: unknown[] = [];
			const runner = makeHookRunner([makeHook(() => ({ result: CACHED }))]);
			const wrapped = new HookToolWrapper(
				{
					name: "read",
					label: "Read",
					description: "Test read tool",
					parameters: Type.Object({ path: Type.String() }),
					strict: true,
					execute: async (_id: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text", text: "REAL" }] };
					},
				} as AgentTool,
				runner,
			);

			await expect(wrapped.execute("c1", { path: ORIGINAL_URL } as never)).rejects.toThrow(/cannot answer/);
			expect(executed).toEqual([]);
		});

		it("a hook that answers after another hook added context still blocks, and its context is dropped", async () => {
			const runner = makeHookRunner([
				makeHook(() => ({ additionalContext: "first" })),
				makeHook(() => ({ result: CACHED })),
			]);
			const result = await runner.emitToolCall({
				type: "tool_call",
				toolName: "read",
				toolCallId: "c1",
				input: { path: ORIGINAL_URL },
			} as never);
			expect(result?.block).toBe(true);
			expect(result).not.toHaveProperty("additionalContext");
		});
	});
});
