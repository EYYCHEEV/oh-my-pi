import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	normalizeAssistantToolCallContent,
	normalizeAssistantToolCallStream,
	normalizeFinalAssistantMessage,
	resolveDialect,
} from "@oh-my-pi/pi-coding-agent/sdk";

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason,
		timestamp: 1,
	};
}

async function normalizeStream(events: AssistantMessageEvent[]): Promise<AssistantMessageEvent[]> {
	const inner = new AssistantMessageEventStream();
	for (const event of events) inner.push(event);
	const normalized: AssistantMessageEvent[] = [];
	for await (const event of normalizeAssistantToolCallStream(inner)) normalized.push(event);
	return normalized;
}

async function waitForStreamToNeedInput(stream: AssistantMessageEventStream): Promise<void> {
	while (stream.queue.length > 0 || stream.waiting.length === 0) await Promise.resolve();
}

describe("resolveDialect", () => {
	it("uses preferred owned dialects in auto mode for models without native tools", () => {
		expect(resolveDialect("auto", { id: "MiniMax-M3", supportsTools: false })).toBe("minimax");
		expect(resolveDialect("auto", { id: "qwen3-coder-plus", supportsTools: false })).toBe("qwen3");
		expect(resolveDialect("auto", { id: "unclassified-model-id", supportsTools: false })).toBe("glm");
		expect(resolveDialect("auto", { supportsTools: false })).toBe("glm");
		expect(resolveDialect("auto", { supportsTools: true })).toBeUndefined();
		expect(resolveDialect("auto", {})).toBeUndefined();
		expect(resolveDialect("auto", undefined)).toBeUndefined();
	});

	it("keeps native unset and passes explicit in-band dialects through", () => {
		expect(resolveDialect("native", { supportsTools: false })).toBeUndefined();
		expect(resolveDialect("qwen3", undefined)).toBe("qwen3");
		expect(resolveDialect("minimax", undefined)).toBe("minimax");
	});
});

describe("normalizeAssistantToolCallContent", () => {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: "call-read",
		name: "read",
		arguments: { path: "src/index.ts" },
	};

	it("preserves mixed substantive text and tool content without copying", () => {
		const content: AssistantMessage["content"] = [
			{ type: "text", text: "Found １２３ entries." },
			{ type: "text", text: "\u0301" },
			toolCall,
		];

		expect(normalizeAssistantToolCallContent(content)).toBe(content);
	});

	it("removes punctuation-only text from tool-call messages", () => {
		const content: AssistantMessage["content"] = [{ type: "text", text: " ...!?\n\t " }, toolCall];

		expect(normalizeAssistantToolCallContent(content)).toEqual([toolCall]);
		expect(content).toHaveLength(2);
	});

	it("removes Unicode symbols and punctuation from tool-call messages", () => {
		const content: AssistantMessage["content"] = [{ type: "text", text: "—※★♜∞" }, toolCall];

		expect(normalizeAssistantToolCallContent(content)).toEqual([toolCall]);
	});

	it("preserves punctuation-only final text without a tool call", () => {
		const content: AssistantMessage["content"] = [{ type: "text", text: "…!?" }];

		expect(normalizeAssistantToolCallContent(content)).toBe(content);
		expect(content).toEqual([{ type: "text", text: "…!?" }]);
	});
});

describe("normalizeAssistantToolCallStream", () => {
	const call = (arguments_: Record<string, unknown> = {}): ToolCall => ({
		type: "toolCall",
		id: "call-read",
		name: "read",
		arguments: arguments_,
	});

	it("hides a punctuation-only prefix and remaps cumulative tool-call events", async () => {
		const punctuation = { type: "text" as const, text: "…!?" };
		const events = await normalizeStream([
			{ type: "start", partial: assistant([]) },
			{ type: "text_start", contentIndex: 0, partial: assistant([{ type: "text", text: "" }]) },
			{ type: "text_delta", contentIndex: 0, delta: "…!?", partial: assistant([punctuation]) },
			{ type: "text_end", contentIndex: 0, content: "…!?", partial: assistant([punctuation]) },
			{
				type: "toolcall_start",
				contentIndex: 1,
				partial: assistant([punctuation, call()], "toolUse"),
			},
			{
				type: "toolcall_delta",
				contentIndex: 1,
				delta: '{"path":"src/',
				partial: assistant([punctuation, call({ path: "src/" })], "toolUse"),
			},
			{
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: call({ path: "src/index.ts" }),
				partial: assistant([punctuation, call({ path: "src/index.ts" })], "toolUse"),
			},
			{
				type: "done",
				reason: "toolUse",
				message: assistant([punctuation, call({ path: "src/index.ts" })], "toolUse"),
			},
		]);

		expect(events.map(event => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		const toolEvents = events.filter(
			(
				event,
			): event is Extract<AssistantMessageEvent, { type: "toolcall_start" | "toolcall_delta" | "toolcall_end" }> =>
				event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end",
		);
		expect(toolEvents.map(event => event.contentIndex)).toEqual([0, 0, 0]);
		expect(toolEvents.map(event => event.partial.content.map(block => block.type))).toEqual([
			["toolCall"],
			["toolCall"],
			["toolCall"],
		]);
		const done = events.at(-1);
		expect(done?.type === "done" && done.message.content.map(block => block.type)).toEqual(["toolCall"]);
	});

	it("flushes the uncertain prefix when a substantive Unicode delta arrives", async () => {
		const events = await normalizeStream([
			{ type: "start", partial: assistant([]) },
			{ type: "text_start", contentIndex: 0, partial: assistant([{ type: "text", text: "" }]) },
			{
				type: "text_delta",
				contentIndex: 0,
				delta: "…",
				partial: assistant([{ type: "text", text: "…" }]),
			},
			{
				type: "text_delta",
				contentIndex: 0,
				delta: "\u0301",
				partial: assistant([{ type: "text", text: "…\u0301" }]),
			},
			{
				type: "text_end",
				contentIndex: 0,
				content: "…\u0301",
				partial: assistant([{ type: "text", text: "…\u0301" }]),
			},
			{
				type: "toolcall_start",
				contentIndex: 1,
				partial: assistant([{ type: "text", text: "…\u0301" }, call()], "toolUse"),
			},
			{
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: call({ path: "src/index.ts" }),
				partial: assistant([{ type: "text", text: "…\u0301" }, call({ path: "src/index.ts" })], "toolUse"),
			},
			{
				type: "done",
				reason: "toolUse",
				message: assistant([{ type: "text", text: "…\u0301" }, call({ path: "src/index.ts" })], "toolUse"),
			},
		]);

		expect(events.map(event => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_end",
			"done",
		]);
		const toolStart = events.find(event => event.type === "toolcall_start");
		expect(toolStart?.contentIndex).toBe(1);
		const done = events.at(-1);
		expect(done?.type === "done" && done.message.content[0]).toEqual({ type: "text", text: "…\u0301" });
	});

	it("flushes punctuation when the terminal message has no tool call", async () => {
		const punctuation = { type: "text" as const, text: "…!?" };
		const events = await normalizeStream([
			{ type: "start", partial: assistant([]) },
			{ type: "text_start", contentIndex: 0, partial: assistant([{ type: "text", text: "" }]) },
			{ type: "text_delta", contentIndex: 0, delta: "…!?", partial: assistant([punctuation]) },
			{ type: "text_end", contentIndex: 0, content: "…!?", partial: assistant([punctuation]) },
			{ type: "done", reason: "stop", message: assistant([punctuation]) },
		]);

		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		const done = events.at(-1);
		expect(done?.type === "done" && done.message.content).toEqual([punctuation]);
	});

	it("drops an earlier punctuation block while preserving substantive post-tool text", async () => {
		const punctuation = { type: "text" as const, text: "…!?" };
		const postToolText = { type: "text" as const, text: "Done." };
		const events = await normalizeStream([
			{ type: "start", partial: assistant([]) },
			{ type: "text_start", contentIndex: 0, partial: assistant([{ type: "text", text: "" }]) },
			{ type: "text_delta", contentIndex: 0, delta: "…!?", partial: assistant([punctuation]) },
			{ type: "text_end", contentIndex: 0, content: "…!?", partial: assistant([punctuation]) },
			{
				type: "toolcall_start",
				contentIndex: 1,
				partial: assistant([punctuation, call()], "toolUse"),
			},
			{
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: call({ path: "src/index.ts" }),
				partial: assistant([punctuation, call({ path: "src/index.ts" })], "toolUse"),
			},
			{
				type: "text_start",
				contentIndex: 2,
				partial: assistant([punctuation, call({ path: "src/index.ts" }), { type: "text", text: "" }], "toolUse"),
			},
			{
				type: "text_delta",
				contentIndex: 2,
				delta: "Done.",
				partial: assistant([punctuation, call({ path: "src/index.ts" }), postToolText], "toolUse"),
			},
			{
				type: "text_end",
				contentIndex: 2,
				content: "Done.",
				partial: assistant([punctuation, call({ path: "src/index.ts" }), postToolText], "toolUse"),
			},
			{
				type: "done",
				reason: "toolUse",
				message: assistant([punctuation, call({ path: "src/index.ts" }), postToolText], "toolUse"),
			},
		]);

		expect(events.map(event => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		const indexedEvents = events.filter(
			event => event.type !== "start" && event.type !== "done" && event.type !== "error",
		);
		expect(indexedEvents.map(event => event.contentIndex)).toEqual([0, 0, 1, 1, 1]);
		for (const event of events) {
			if ("partial" in event) {
				expect(event.partial.content.some(block => block.type === "text" && block.text === punctuation.text)).toBe(
					false,
				);
			}
		}
		const done = events.at(-1);
		expect(done?.type === "done" && done.message.content).toEqual([call({ path: "src/index.ts" }), postToolText]);
	});

	it("waits across intervening thinking blocks before removing punctuation", async () => {
		const punctuation = { type: "text" as const, text: "…" };
		const thinking = { type: "thinking" as const, thinking: "Check first." };
		const events = await normalizeStream([
			{ type: "start", partial: assistant([]) },
			{ type: "text_start", contentIndex: 0, partial: assistant([{ type: "text", text: "" }]) },
			{ type: "text_delta", contentIndex: 0, delta: "…", partial: assistant([punctuation]) },
			{ type: "text_end", contentIndex: 0, content: "…", partial: assistant([punctuation]) },
			{
				type: "thinking_start",
				contentIndex: 1,
				partial: assistant([punctuation, { type: "thinking", thinking: "" }]),
			},
			{
				type: "thinking_delta",
				contentIndex: 1,
				delta: "Check first.",
				partial: assistant([punctuation, thinking]),
			},
			{
				type: "thinking_end",
				contentIndex: 1,
				content: "Check first.",
				partial: assistant([punctuation, thinking]),
			},
			{
				type: "toolcall_start",
				contentIndex: 2,
				partial: assistant([punctuation, thinking, call()], "toolUse"),
			},
			{
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: call({ path: "src/index.ts" }),
				partial: assistant([punctuation, thinking, call({ path: "src/index.ts" })], "toolUse"),
			},
			{
				type: "done",
				reason: "toolUse",
				message: assistant([punctuation, thinking, call({ path: "src/index.ts" })], "toolUse"),
			},
		]);

		expect(events.map(event => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"toolcall_start",
			"toolcall_end",
			"done",
		]);
		const indexedEvents = events.filter(
			event => event.type !== "start" && event.type !== "done" && event.type !== "error",
		);
		expect(indexedEvents.map(event => event.contentIndex)).toEqual([0, 0, 0, 1, 1]);
		expect(indexedEvents.map(event => event.partial.content.map(block => block.type))).toEqual([
			["thinking"],
			["thinking"],
			["thinking"],
			["thinking", "toolCall"],
			["thinking", "toolCall"],
		]);
	});

	it("snapshots buffered cumulative partials before providers mutate them", async () => {
		const inner = new AssistantMessageEventStream();
		const normalized: AssistantMessageEvent[] = [];
		const collecting = (async () => {
			for await (const event of normalizeAssistantToolCallStream(inner)) normalized.push(event);
		})();
		const partial = assistant([], "toolUse");
		const punctuation = { type: "text" as const, text: "" };

		inner.push({ type: "start", partial });
		partial.content.push(punctuation);
		inner.push({ type: "text_start", contentIndex: 0, partial });
		punctuation.text = "…";
		inner.push({ type: "text_delta", contentIndex: 0, delta: "…", partial });
		inner.push({ type: "text_end", contentIndex: 0, content: "…", partial });
		await waitForStreamToNeedInput(inner);

		const thinking = { type: "thinking" as const, thinking: "" };
		partial.content.push(thinking);
		inner.push({ type: "thinking_start", contentIndex: 1, partial });
		await waitForStreamToNeedInput(inner);
		thinking.thinking = "First state.";
		inner.push({ type: "thinking_delta", contentIndex: 1, delta: "First state.", partial });
		await waitForStreamToNeedInput(inner);
		thinking.thinking = "Mutated later.";

		const toolCall = call({ path: "src/" });
		partial.content.push(toolCall);
		inner.push({ type: "toolcall_start", contentIndex: 2, partial });
		await waitForStreamToNeedInput(inner);
		toolCall.arguments.path = "src/index.ts";
		inner.push({ type: "toolcall_end", contentIndex: 2, toolCall, partial });
		inner.push({ type: "done", reason: "toolUse", message: partial });
		await collecting;

		const thinkingStart = normalized.find(event => event.type === "thinking_start");
		const thinkingDelta = normalized.find(event => event.type === "thinking_delta");
		expect(thinkingStart?.partial.content[0]).toEqual({ type: "thinking", thinking: "" });
		expect(thinkingDelta?.partial.content[0]).toEqual({ type: "thinking", thinking: "First state." });
		const toolStart = normalized.find(event => event.type === "toolcall_start");
		const startedCall = toolStart?.partial.content[1];
		expect(startedCall?.type === "toolCall" && startedCall.arguments).toEqual({ path: "src/" });
	});
});

describe("normalizeFinalAssistantMessage", () => {
	it("recovers an inline edit before removing its punctuation-only remainder", () => {
		const payload = [
			'<SM:EDIT path="src/a.ts">',
			"<SM:FIND>",
			"const x = 1;",
			"</SM:FIND>",
			"<SM:PUT>",
			"const x = 2;",
			"</SM:PUT>",
			"</SM:EDIT>",
		].join("\n");
		const message = assistant([{ type: "text", text: `…\n${payload}\n!?` }]);

		expect(normalizeFinalAssistantMessage(message, true)).toBe(1);
		expect(message.content.map(block => block.type)).toEqual(["toolCall"]);
		const recovered = message.content[0];
		expect(recovered?.type === "toolCall" && recovered.arguments).toEqual({ input: payload });
	});
});
