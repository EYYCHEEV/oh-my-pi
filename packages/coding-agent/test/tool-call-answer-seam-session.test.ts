/**
 * The tool-call answer seam end to end: a stub model asks to read a URL, an add-on answers the
 * call at arg-prep time, and the loop, the wrapper's approval gate, the persisted session and the
 * next provider request all see one consistent story. Order-rule unit tests live in
 * `tool-call-answer-seam.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import {
	type Api,
	type Context,
	clearCustomApis,
	type Model,
	type ModelSpec,
	registerCustomApi,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";
const CACHED_TEXT = "<cached page>";
const ADDON_NAME = /^<inline-\d+>$/;

interface ScriptedCall {
	id: string;
	name?: string;
	arguments: Record<string, unknown>;
	providerMetadata?: ToolCall["providerMetadata"];
}

interface ToolResultView {
	toolCallId: string;
	toolName: string;
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError: boolean;
	answeredBy?: string;
}

/** A stub model whose first reply asks for `calls` (all `read`) and whose second reply ends the run. */
function registerScript(api: string, calls: ScriptedCall[], contexts: Context[]): void {
	registerCustomApi(api, (_model, context) => {
		contexts.push(context);
		const first = contexts.length === 1;
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const message = createAssistantMessage(first ? "" : "done");
			if (!first) {
				stream.push({ type: "done", reason: "stop", message });
				return;
			}
			const toolCalls: ToolCall[] = calls.map(call => ({
				type: "toolCall",
				id: call.id,
				name: call.name ?? "read",
				arguments: call.arguments,
				...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
			}));
			message.content = toolCalls;
			message.stopReason = "toolUse";
			toolCalls.forEach((toolCall, contentIndex) => {
				stream.push({ type: "toolcall_start", contentIndex, partial: message });
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
			});
			stream.push({ type: "done", reason: "toolUse", message });
		});
		return stream;
	});
}

function stubModel(api: string): Model<Api> {
	return buildModel({
		id: "answer-seam-model",
		name: "Answer Seam Model",
		api,
		provider: "ollama",
		baseUrl: "http://127.0.0.1:11434",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

/** Re-registers `read` as a stub that records every real execution. */
function stubRead(executed: unknown[], approval: "read" | "exec" = "read", name = "read"): ExtensionFactory {
	return pi => {
		pi.registerTool({
			name,
			label: "Read",
			description: "stub read",
			approval,
			parameters: pi.arktype({ path: pi.arktype("string") }),
			async execute(_toolCallId: string, params: unknown) {
				executed.push(params);
				return { content: [{ type: "text" as const, text: "REAL" }], details: {} };
			},
		});
	};
}

/** The cache add-on: answers every https read with the cached page. */
function cacheAddon(extra: { alsoRewrite?: boolean; seen?: string[] } = {}): ExtensionFactory {
	return pi => {
		pi.on("tool_call", async event => {
			if (event.toolName !== "read") return undefined;
			const target = String(event.input.path);
			extra.seen?.push(`${event.toolCallId}:${target}`);
			if (!target.startsWith("https://")) return undefined;
			return {
				result: {
					content: [{ type: "text" as const, text: CACHED_TEXT }],
					details: { cachedAt: "2026-10-26T12:00:00Z" },
				},
				...(extra.alsoRewrite ? { input: { path: "https://example.com/rewritten" } } : {}),
			};
		});
	};
}

describe("tool-call answer seam, end to end", () => {
	const sessions: Array<{ session: AgentSession; authStorage: AuthStorage; dir: TempDir }> = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		for (const { session, authStorage, dir } of sessions.splice(0)) {
			await session.dispose();
			authStorage.close();
			dir.removeSync();
		}
	});

	async function start(options: {
		extensions: ExtensionFactory[];
		calls: ScriptedCall[];
		settings?: Record<string, unknown>;
		hookFiles?: Record<string, string>;
		toolNames?: string[];
	}) {
		const dir = TempDir.createSync("@pi-answer-seam-session-");
		for (const [file, source] of Object.entries(options.hookFiles ?? {})) {
			const hookDir = dir.join(".omp", "hooks", "pre");
			fs.mkdirSync(hookDir, { recursive: true });
			fs.writeFileSync(`${hookDir}/${file}`, source);
		}
		const api = `test-answer-seam-${sessions.length}-${Math.random().toString(36).slice(2)}`;
		const contexts: Context[] = [];
		registerScript(api, options.calls, contexts);
		const authStorage = await AuthStorage.create(dir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"tools.xdev": false,
				...options.settings,
			}),
			model: stubModel(api),
			disableExtensionDiscovery: options.hookFiles === undefined,
			extensions: options.extensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: options.toolNames ?? ["read"],
		});
		sessions.push({ session, authStorage, dir });
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});
		return { session, contexts, events };
	}

	const toolResults = (session: AgentSession): ToolResultView[] =>
		session.agent.state.messages.filter(message => message.role === "toolResult") as unknown as ToolResultView[];

	const assistantCalls = (session: AgentSession): ToolCall[] =>
		session.agent.state.messages
			.filter(message => message.role === "assistant")
			.flatMap(message => message.content.filter((block): block is ToolCall => block.type === "toolCall"));

	it("records the answer with answeredBy, keeps the model's real call, and never runs read (rules 1, 7, 10)", async () => {
		const executed: unknown[] = [];
		const { session, contexts, events } = await start({
			extensions: [stubRead(executed), cacheAddon()],
			calls: [{ id: "c1", arguments: { path: URL_A } }],
		});

		await session.sendUserMessage("read the page");

		expect(executed).toEqual([]);
		const [result] = toolResults(session);
		expect(result).toMatchObject({
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: CACHED_TEXT }],
			details: { cachedAt: "2026-10-26T12:00:00Z" },
			isError: false,
		});
		expect(result?.answeredBy).toMatch(ADDON_NAME);

		// The assistant message keeps the model's call, so the record tells the truth.
		expect(assistantCalls(session).map(call => call.arguments)).toEqual([{ path: URL_A }]);

		// The tool_execution_end event carries the same marker.
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end).toMatchObject({ toolCallId: "c1", isError: false, result: { answeredBy: result?.answeredBy } });

		// The model saw the answered text on the next request.
		expect(contexts).toHaveLength(2);
		const delivered = contexts[1]?.messages.find(message => message.role === "toolResult");
		expect(delivered?.content).toEqual([{ type: "text", text: CACHED_TEXT }]);

		// The session file has the same record.
		await session.sessionManager.flush();
		const file = session.sessionManager.getSessionFile();
		expect(file).toBeDefined();
		const entries = fs
			.readFileSync(file as string, "utf8")
			.split("\n")
			.filter(line => line.trim().length > 0)
			.map(line => JSON.parse(line) as { type?: string; message?: Record<string, unknown> });
		const storedResult = entries.find(entry => entry.message?.role === "toolResult")?.message;
		expect(storedResult).toMatchObject({ toolCallId: "c1", answeredBy: result?.answeredBy, isError: false });
		const storedCall = entries
			.map(entry => entry.message)
			.find(message => message?.role === "assistant" && Array.isArray(message.content));
		expect(JSON.stringify(storedCall)).toContain(URL_A);
	});

	it("drops an input rewrite that comes with the answer: approval and the record use the original call (rule 5)", async () => {
		const executed: unknown[] = [];
		const { session, events } = await start({
			extensions: [stubRead(executed), cacheAddon({ alsoRewrite: true })],
			calls: [{ id: "c1", arguments: { path: URL_A } }],
		});

		await session.sendUserMessage("read the page");

		expect(executed).toEqual([]);
		expect(toolResults(session)[0]?.answeredBy).toMatch(ADDON_NAME);
		expect(assistantCalls(session).map(call => call.arguments)).toEqual([{ path: URL_A }]);
		const startEvent = events.find(event => event.type === "tool_execution_start");
		expect(startEvent).toMatchObject({ toolCallId: "c1", args: { path: URL_A } });
	});

	it("delivers a non-blocking handler's additionalContext after the answered result (rule 6)", async () => {
		const executed: unknown[] = [];
		const advice: ExtensionFactory = pi => {
			pi.on("tool_call", async event =>
				event.toolName === "read" ? { additionalContext: "Prefer the cached copy next time." } : undefined,
			);
		};
		const { session, contexts } = await start({
			extensions: [stubRead(executed), cacheAddon(), advice],
			calls: [{ id: "c1", arguments: { path: URL_A } }],
		});

		await session.sendUserMessage("read the page");

		expect(executed).toEqual([]);
		expect(toolResults(session)[0]?.answeredBy).toMatch(ADDON_NAME);
		expect(contexts).toHaveLength(2);
		const messages = contexts[1]?.messages ?? [];
		const resultAt = messages.findIndex(message => message.role === "toolResult");
		const adviceAt = messages.findIndex(
			message => message.role === "developer" && JSON.stringify(message.content).includes("Prefer the cached copy"),
		);
		expect(resultAt).toBeGreaterThanOrEqual(0);
		expect(adviceAt).toBeGreaterThan(resultAt);
	});

	it("never uses an answer held for call A on call B (rule 10)", async () => {
		const executed: unknown[] = [];
		const { session } = await start({
			extensions: [stubRead(executed), cacheAddon()],
			calls: [
				{ id: "call-a", arguments: { path: URL_A } },
				{ id: "call-b", arguments: { path: "/local/b.txt" } },
			],
		});

		await session.sendUserMessage("read both");

		expect(executed).toEqual([{ path: "/local/b.txt" }]);
		const byId = new Map(toolResults(session).map(result => [result.toolCallId, result]));
		expect(byId.get("call-a")?.answeredBy).toMatch(ADDON_NAME);
		expect(byId.get("call-a")?.content).toEqual([{ type: "text", text: CACHED_TEXT }]);
		expect(byId.get("call-b")?.answeredBy).toBeUndefined();
		expect(byId.get("call-b")?.content).toEqual([{ type: "text", text: "REAL" }]);
		expect(session.extensionRunner?.consumeToolCallAnswer("call-a", "read")).toBeUndefined();
		expect(session.extensionRunner?.consumeToolCallAnswer("call-b", "read")).toBeUndefined();
	});

	it("a later block wins over the answer, and nothing is left held (rules 2 and 10, rule 12: block after answer)", async () => {
		const executed: unknown[] = [];
		const policy: ExtensionFactory = pi => {
			pi.on("tool_call", async event =>
				event.toolName === "read" ? { block: true, reason: "policy says no" } : undefined,
			);
		};
		const { session } = await start({
			extensions: [stubRead(executed), cacheAddon(), policy],
			calls: [{ id: "c1", arguments: { path: URL_A } }],
		});

		await session.sendUserMessage("read the page");

		expect(executed).toEqual([]);
		const [result] = toolResults(session);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("policy says no");
		expect(result?.answeredBy).toBeUndefined();
		expect(session.extensionRunner?.consumeToolCallAnswer("c1", "read")).toBeUndefined();
	});

	it("a deny policy stops the call before any add-on runs (rule 7)", async () => {
		const executed: unknown[] = [];
		const seen: string[] = [];
		const { session } = await start({
			extensions: [stubRead(executed), cacheAddon({ seen })],
			calls: [{ id: "c1", arguments: { path: URL_A } }],
			settings: { "tools.approval": { read: "deny" } },
		});

		await session.sendUserMessage("read the page");

		expect(seen).toEqual([]);
		expect(executed).toEqual([]);
		const [result] = toolResults(session);
		expect(result?.isError).toBe(true);
		expect(result?.answeredBy).toBeUndefined();
		expect(session.extensionRunner?.consumeToolCallAnswer("c1", "read")).toBeUndefined();
	});

	it("refuses to apply the answer when the approval gate cannot approve, and leaves nothing held (rule 7)", async () => {
		const executed: unknown[] = [];
		const { session } = await start({
			extensions: [stubRead(executed, "exec"), cacheAddon()],
			calls: [{ id: "c1", arguments: { path: URL_A } }],
			// No UI is attached, so a prompt cannot be answered and the call is refused.
			settings: { "tools.approvalMode": "always-ask" },
		});

		await session.sendUserMessage("read the page");

		expect(executed).toEqual([]);
		const [result] = toolResults(session);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("requires approval");
		expect(result?.answeredBy).toBeUndefined();
		expect(session.extensionRunner?.consumeToolCallAnswer("c1", "read")).toBeUndefined();
	});

	it("blocks an answer for a computer call, naming the add-on (rule 9)", async () => {
		const executed: unknown[] = [];
		// A computer call's event input is a synthetic {actions, pendingSafetyChecks} view with no
		// `path`, so this add-on answers every read regardless of its input.
		const answerEverything: ExtensionFactory = pi => {
			pi.on("tool_call", async () => ({ result: { content: [{ type: "text" as const, text: CACHED_TEXT }] } }));
		};
		const { session } = await start({
			extensions: [stubRead(executed), answerEverything],
			calls: [
				{
					id: "c1",
					arguments: { path: URL_A },
					providerMetadata: {
						type: "computer",
						providerItemId: "item-1",
						actions: [{ type: "screenshot" }],
						pendingSafetyChecks: [],
					},
				},
			],
		});

		await session.sendUserMessage("click something");

		expect(executed).toEqual([]);
		const [result] = toolResults(session);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toMatch(/<inline-\d+>/);
		expect(result?.content[0]?.text).toContain("computer");
		expect(result?.answeredBy).toBeUndefined();
		expect(session.extensionRunner?.consumeToolCallAnswer("c1", "read")).toBeUndefined();
	});

	it("leaves nothing held when the run is aborted after an answer was prepared (rule 10)", async () => {
		const executed: unknown[] = [];
		const gate = Promise.withResolvers<void>();
		const reachedSecond = Promise.withResolvers<void>();
		const stall: ExtensionFactory = pi => {
			pi.on("tool_call", async event => {
				if (event.toolCallId !== "call-b") return undefined;
				reachedSecond.resolve();
				await gate.promise;
				return undefined;
			});
		};
		const { session } = await start({
			extensions: [stubRead(executed), cacheAddon(), stall],
			calls: [
				{ id: "call-a", arguments: { path: URL_A } },
				{ id: "call-b", arguments: { path: URL_B } },
			],
		});

		const run = session.sendUserMessage("read both");
		await reachedSecond.promise;
		await session.abort();
		gate.resolve();
		await run.catch(() => undefined);
		await session.agent.waitForIdle();

		expect(executed).toEqual([]);
		expect(session.extensionRunner?.consumeToolCallAnswer("call-a", "read")).toBeUndefined();
		expect(session.extensionRunner?.consumeToolCallAnswer("call-b", "read")).toBeUndefined();
	});

	it("blocks an answer from a legacy hook file bound through the extension runner, naming the hook (rule 9)", async () => {
		const executed: unknown[] = [];
		const { session } = await start({
			extensions: [stubRead(executed)],
			hookFiles: {
				"answerer.ts": `export default function (pi) {
	pi.on("tool_call", async () => ({ result: { content: [{ type: "text", text: "x" }] } }));
}
`,
			},
			calls: [{ id: "c1", arguments: { path: URL_A } }],
		});

		await session.sendUserMessage("read the page");

		expect(executed).toEqual([]);
		const [result] = toolResults(session);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("answerer");
		expect(result?.content[0]?.text).toContain("hooks cannot answer tool calls");
		expect(result?.answeredBy).toBeUndefined();
		expect(session.extensionRunner?.consumeToolCallAnswer("c1", "read")).toBeUndefined();
	});

	it("blocks an answer for a call the session interprets by tool name, naming the add-on (finding 10)", async () => {
		const executed: unknown[] = [];
		const answerEverything: ExtensionFactory = pi => {
			pi.on("tool_call", async () => ({ result: { content: [{ type: "text" as const, text: CACHED_TEXT }] } }));
		};
		const { session } = await start({
			extensions: [stubRead(executed, "read", "checkpoint"), answerEverything],
			toolNames: ["checkpoint"],
			calls: [{ id: "c1", name: "checkpoint", arguments: { path: URL_A } }],
		});

		await session.sendUserMessage("save a checkpoint");

		expect(executed).toEqual([]);
		const [result] = toolResults(session);
		expect(result?.toolName).toBe("checkpoint");
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toMatch(/<inline-\d+>/);
		expect(result?.content[0]?.text).toContain("cannot be answered");
		expect(result?.answeredBy).toBeUndefined();
	});

	it("blocks an answer when the add-on edits the call input in place first, naming the add-on (F1)", async () => {
		const executed: unknown[] = [];
		const editAndAnswer: ExtensionFactory = pi => {
			pi.on("tool_call", async event => {
				if (event.toolName !== "read") return undefined;
				event.input.path = "https://example.com/evil";
				return { result: { content: [{ type: "text" as const, text: CACHED_TEXT }] } };
			});
		};
		const { session } = await start({
			extensions: [stubRead(executed), editAndAnswer],
			calls: [{ id: "c1", arguments: { path: URL_A } }],
		});

		await session.sendUserMessage("read the page");

		expect(executed).toEqual([]);
		const [result] = toolResults(session);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toMatch(/<inline-\d+>/);
		expect(result?.content[0]?.text).toContain("input was changed");
		expect(result?.answeredBy).toBeUndefined();
		expect(session.extensionRunner?.consumeToolCallAnswer("c1", "read")).toBeUndefined();
	});

	it("blocks the answer when the input changes after the add-on returned, before the call is dispatched (F1)", async () => {
		const executed: unknown[] = [];
		let retained: Record<string, unknown> | undefined;
		const answerThenEdit: ExtensionFactory = pi => {
			pi.on("tool_call", async event => {
				if (event.toolCallId === "call-a") {
					retained = event.input as Record<string, unknown>;
					return { result: { content: [{ type: "text" as const, text: CACHED_TEXT }] } };
				}
				// call-b's arg-prep runs after call-a's emission returned and before either call is dispatched.
				if (retained) retained.path = "https://example.com/evil";
				return undefined;
			});
		};
		const { session } = await start({
			extensions: [stubRead(executed), answerThenEdit],
			calls: [
				{ id: "call-a", arguments: { path: URL_A } },
				{ id: "call-b", arguments: { path: URL_B } },
			],
		});

		await session.sendUserMessage("read both");

		expect(executed).toEqual([{ path: URL_B }]);
		const byId = new Map(toolResults(session).map(result => [result.toolCallId, result]));
		expect(byId.get("call-a")?.isError).toBe(true);
		expect(byId.get("call-a")?.content[0]?.text).toMatch(/<inline-\d+>/);
		expect(byId.get("call-a")?.content[0]?.text).toContain("input was changed");
		expect(byId.get("call-a")?.answeredBy).toBeUndefined();
		expect(byId.get("call-b")?.content).toEqual([{ type: "text", text: "REAL" }]);
	});

	it("keeps the validated answer when the add-on changes every object it handed over after returning (F1 family)", async () => {
		const executed: unknown[] = [];
		let change: (() => void) | undefined;
		const keepAndChange: ExtensionFactory = pi => {
			pi.on("tool_call", async event => {
				if (event.toolCallId === "call-a") {
					const block = {
						type: "image" as const,
						data: "AAAA",
						mimeType: "image/png",
						providerFile: { provider: "openai" as const, id: "f1" },
					};
					const content: Array<Record<string, unknown>> = [{ type: "text", text: "validated text" }, block];
					const details = { hits: 1 };
					change = () => {
						block.data = "BBBB";
						block.providerFile.id = "changed";
						content.push({ type: "text", text: "smuggled" });
						details.hits = 2;
					};
					return { result: { content, details } as never };
				}
				// call-b's arg-prep runs after call-a's emission returned and before either call is dispatched.
				change?.();
				return undefined;
			});
		};
		const { session, contexts } = await start({
			extensions: [stubRead(executed), keepAndChange],
			calls: [
				{ id: "call-a", arguments: { path: URL_A } },
				{ id: "call-b", arguments: { path: URL_B } },
			],
		});

		await session.sendUserMessage("read both");

		const byId = new Map(toolResults(session).map(result => [result.toolCallId, result]));
		const answered = byId.get("call-a");
		expect(answered?.isError).toBe(false);
		expect(answered?.answeredBy).toMatch(ADDON_NAME);
		expect(answered?.details).toEqual({ hits: 1 });
		expect(answered?.content as unknown).toEqual([
			{ type: "text", text: "validated text" },
			{
				type: "image",
				data: "AAAA",
				mimeType: "image/png",
				providerFile: { provider: "openai", id: "f1" },
			},
		]);
		const nextRequest = JSON.stringify(contexts[1]?.messages);
		expect(nextRequest).toContain("validated text");
		expect(nextRequest).not.toContain("smuggled");
	});

	it("still answers a call whose arguments the loop transforms before dispatch (a timeout clamp)", async () => {
		const executed: unknown[] = [];
		const timedRead: ExtensionFactory = pi => {
			pi.registerTool({
				name: "read",
				label: "Read",
				description: "stub read with a timeout",
				approval: "read",
				parameters: pi.arktype({ path: pi.arktype("string"), "timeout?": pi.arktype("number") }),
				async execute(_toolCallId: string, params: unknown) {
					executed.push(params);
					return { content: [{ type: "text" as const, text: "REAL" }], details: {} };
				},
			});
		};
		const { session } = await start({
			extensions: [timedRead, cacheAddon()],
			calls: [{ id: "c1", arguments: { path: URL_A, timeout: 999 } }],
			settings: { "tools.maxTimeout": 5 },
		});

		await session.sendUserMessage("read the page");

		expect(executed).toEqual([]);
		const [result] = toolResults(session);
		expect(result?.isError).toBe(false);
		expect(result?.content[0]?.text).toBe(CACHED_TEXT);
		expect(result?.answeredBy).toMatch(ADDON_NAME);
		expect(session.extensionRunner?.consumeToolCallAnswer("c1", "read")).toBeUndefined();
	});

	it("blocks an image answer with a cyclic field, naming the add-on, and the session still flushes and reloads (F2)", async () => {
		const executed: unknown[] = [];
		const cyclicAnswer: ExtensionFactory = pi => {
			pi.on("tool_call", async event => {
				if (event.toolName !== "read") return undefined;
				const providerFile: Record<string, unknown> = { provider: "openai", id: "f1" };
				providerFile.self = providerFile;
				return {
					result: { content: [{ type: "image", data: "AAAA", mimeType: "image/png", providerFile }] } as never,
				};
			});
		};
		const { session } = await start({
			extensions: [stubRead(executed), cyclicAnswer],
			calls: [{ id: "c1", arguments: { path: URL_A } }],
		});

		await session.sendUserMessage("read the page");

		expect(executed).toEqual([]);
		const [result] = toolResults(session);
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toMatch(/<inline-\d+>/);
		expect(result?.content[0]?.text).toContain("invalid tool_call answer");
		expect(result?.answeredBy).toBeUndefined();

		await session.sessionManager.flush();
		const file = session.sessionManager.getSessionFile();
		expect(file).toBeDefined();
		const reopened = await SessionManager.open(file as string);
		const stored = reopened
			.getEntries()
			.map(entry => (entry as { message?: ToolResultView & { role?: string } }).message)
			.find(message => message?.role === "toolResult");
		expect(stored).toMatchObject({ toolCallId: "c1", isError: true });
		expect(stored?.answeredBy).toBeUndefined();
	});

	it("leaves no emitted or loop marker behind when a handler blocks the call at arg-prep (F3)", async () => {
		const executed: unknown[] = [];
		const policy: ExtensionFactory = pi => {
			pi.on("tool_call", async event =>
				event.toolName === "read" ? { block: true, reason: "policy says no" } : undefined,
			);
		};
		const { session } = await start({
			extensions: [stubRead(executed), policy],
			calls: [{ id: "c1", arguments: { path: URL_A } }],
		});

		await session.sendUserMessage("read the page");

		expect(executed).toEqual([]);
		expect(toolResults(session)[0]?.content[0]?.text).toContain("policy says no");
		expect(session.extensionRunner?.consumeToolCallEmitted("c1", "read")).toBe(false);
		expect(session.extensionRunner?.consumeLoopToolCall("c1", "read")).toBe(false);
	});

	it("keeps each answer with its own call when a slow miss runs beside two different hits (F8)", async () => {
		const executed: unknown[] = [];
		const missReached = Promise.withResolvers<void>();
		const missGate = Promise.withResolvers<void>();
		const cached = new Map([
			[URL_A, "<cached A>"],
			[URL_B, "<cached B>"],
		]);
		const perUrlCache: ExtensionFactory = pi => {
			pi.on("tool_call", async event => {
				if (event.toolName !== "read") return undefined;
				const target = String(event.input.path);
				if (target === "/local/slow-miss.txt") {
					// The slow miss holds arg-prep open while the run is in flight.
					missReached.resolve();
					await missGate.promise;
				}
				const text = cached.get(target);
				if (text === undefined) return undefined;
				return { result: { content: [{ type: "text" as const, text }], details: { url: target } } };
			});
		};
		const { session, contexts } = await start({
			extensions: [stubRead(executed), perUrlCache],
			calls: [
				{ id: "c1", arguments: { path: "/local/slow-miss.txt" } },
				{ id: "c2", arguments: { path: URL_A } },
				{ id: "c3", arguments: { path: URL_B } },
			],
		});

		const run = session.sendUserMessage("read three");
		await missReached.promise;
		missGate.resolve();
		await run;

		expect(executed).toEqual([{ path: "/local/slow-miss.txt" }]);
		const results = toolResults(session);
		expect(results.map(result => result.toolCallId)).toEqual(["c1", "c2", "c3"]);
		expect(results.map(result => result.content[0]?.text)).toEqual(["REAL", "<cached A>", "<cached B>"]);
		expect(results.map(result => result.answeredBy === undefined)).toEqual([true, false, false]);
		expect(results[1]?.answeredBy).toMatch(ADDON_NAME);
		expect(results[2]?.answeredBy).toBe(results[1]?.answeredBy);
		expect(results.map(result => result.details)).toEqual([{}, { url: URL_A }, { url: URL_B }]);
		expect(assistantCalls(session).map(call => call.arguments)).toEqual([
			{ path: "/local/slow-miss.txt" },
			{ path: URL_A },
			{ path: URL_B },
		]);
		const delivered = (contexts[1]?.messages ?? []).filter(message => message.role === "toolResult");
		expect(delivered.map(message => (message.content as Array<{ text?: string }>)[0]?.text)).toEqual([
			"REAL",
			"<cached A>",
			"<cached B>",
		]);
		for (const id of ["c1", "c2", "c3"]) {
			expect(session.extensionRunner?.consumeToolCallAnswer(id, "read")).toBeUndefined();
		}
	});
});
