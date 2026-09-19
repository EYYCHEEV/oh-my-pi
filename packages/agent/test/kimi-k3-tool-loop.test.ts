import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentMessage, AgentTool, AgentLoopConfig } from "@oh-my-pi/pi-agent-core/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";

const KIMI_K3: Model<"openai-completions"> = buildModel({
	id: "k3",
	name: "K3",
	api: "openai-completions",
	provider: "kimi-code",
	baseUrl: "https://api.kimi.com/coding/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 131_072,
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.High, Effort.Max],
		defaultLevel: Effort.High,
		requiresEffort: true,
	},
	compat: {
		thinkingFormat: "kimi",
		reasoningContentField: "reasoning_content",
		supportsDeveloperRole: false,
	},
} satisfies ModelSpec<"openai-completions">);
const GPT_CHAT: Model<"openai-completions"> = buildModel({
	id: "gpt-4o-mini",
	name: "GPT-4o mini",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
} satisfies ModelSpec<"openai-completions">);

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }> =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function sseResponse(events: readonly Record<string, unknown>[]): Response {
	const body = events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolTurnEvents(): Record<string, unknown>[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_tool",
				type: "message",
				role: "assistant",
				content: [],
				model: "k3",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_bash", name: "bash", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"command":"printf ok"}' },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: { output_tokens: 4 },
		},
		{ type: "message_stop" },
	];
}

function finalTurnEvents(): Record<string, unknown>[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_final",
				type: "message",
				role: "assistant",
				content: [],
				model: "k3",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 20, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 2 },
		},
		{ type: "message_stop" },
	];
}
function chatResponse(events: readonly Record<string, unknown>[]): Response {
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chatToolTurnEvents(): Record<string, unknown>[] {
	return [
		{
			id: "chatcmpl_tool",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		},
		{
			id: "chatcmpl_tool",
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_bash",
								type: "function",
								function: { name: "bash", arguments: '{"command":"printf ok"}' },
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			id: "chatcmpl_tool",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		},
	];
}

function chatFinalTurnEvents(): Record<string, unknown>[] {
	return [
		{
			id: "chatcmpl_final",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }],
		},
	];
}

const bashParameters = type({ command: "string" });
const bashTool: AgentTool<typeof bashParameters, unknown> = {
	name: "bash",
	label: "bash",
	description: "Run a shell command.",
	parameters: bashParameters,
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

function context(): AgentContext {
	return { systemPrompt: ["You are helpful."], messages: [], tools: [bashTool] };
}

function responsesResponse(events: readonly Record<string, unknown>[]): Response {
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function responsesToolTurnEvents(): Record<string, unknown>[] {
	const argumentsJson = '{"command":"printf ok"}';
	return [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", id: "fc_bash", call_id: "call_bash", name: "bash", arguments: "" },
		},
		{
			type: "response.function_call_arguments.delta",
			output_index: 0,
			item_id: "fc_bash",
			delta: argumentsJson,
		},
		{
			type: "response.function_call_arguments.done",
			output_index: 0,
			item_id: "fc_bash",
			arguments: argumentsJson,
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_bash",
				call_id: "call_bash",
				name: "bash",
				arguments: argumentsJson,
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_tool",
				status: "completed",
				usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
			},
		},
	];
}

function responsesFinalTurnEvents(): Record<string, unknown>[] {
	return [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_final", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			output_index: 0,
			item_id: "msg_final",
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: "msg_final", delta: "done" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_final",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "done", annotations: [] }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_final",
				status: "completed",
				usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 },
			},
		},
	];
}

describe("Kimi K3 post-tool continuation", () => {
	it("dispatches the next Anthropic request after an explicit override", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetch: FetchImpl = async (input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			requests.push({ url: String(input), body });
			return sseResponse(requests.length === 1 ? toolTurnEvents() : finalTurnEvents());
		};
		const config: AgentLoopConfig = {
			model: KIMI_K3,
			convertToLlm: identityConverter,
			apiKey: "test-key",
			kimiApiFormat: "anthropic",
			reasoning: Effort.High,
		};
		const events = [] as Array<{ type: string; toolResults?: unknown[] }>;
		const stream = agentLoop(
			[{ role: "user", content: "Run the command.", timestamp: Date.now() }],
			context(),
			config,
			undefined,
			(model, llmContext, options) => streamSimple(model, llmContext, { ...options, fetch }),
		);
		for await (const event of stream) events.push(event);
		const messages = await stream.result();

		expect(requests).toHaveLength(2);
		expect(requests.map(request => request.url)).toEqual([
			"https://api.kimi.com/coding/v1/messages",
			"https://api.kimi.com/coding/v1/messages",
		]);
		const secondRequest = requests[1];
		if (!secondRequest) throw new Error("second Kimi request was not captured");
		expect((secondRequest.body.messages as Array<Record<string, unknown>>).at(-1)).toMatchObject({ role: "user" });
		expect(JSON.stringify(secondRequest.body.messages)).toContain("toolu_bash");
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(2);
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
		});
	});
	it("dispatches the next Chat Completions request under an explicit override", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetch: FetchImpl = async (input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			requests.push({ url: String(input), body });
			return chatResponse(requests.length === 1 ? chatToolTurnEvents() : chatFinalTurnEvents());
		};
		const config: AgentLoopConfig = {
			model: KIMI_K3,
			convertToLlm: identityConverter,
			apiKey: "test-key",
			kimiApiFormat: "openai",
			reasoning: Effort.High,
		};
		const events = [] as Array<{ type: string }>;
		const stream = agentLoop(
			[{ role: "user", content: "Run the command.", timestamp: Date.now() }],
			context(),
			config,
			undefined,
			(model, llmContext, options) => streamSimple(model, llmContext, { ...options, fetch }),
		);
		for await (const event of stream) events.push(event);
		const messages = await stream.result();

		expect(requests).toHaveLength(2);
		expect(requests.map(request => request.url)).toEqual([
			"https://api.kimi.com/coding/v1/chat/completions",
			"https://api.kimi.com/coding/v1/chat/completions",
		]);
		expect(JSON.stringify(requests[1]?.body.messages)).toContain("call_bash");
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(2);
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
		});
	});
	it("dispatches the same Chat Completions continuation for GPT", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetch: FetchImpl = async (input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			requests.push({ url: String(input), body });
			return chatResponse(requests.length === 1 ? chatToolTurnEvents() : chatFinalTurnEvents());
		};
		const config: AgentLoopConfig = { model: GPT_CHAT, convertToLlm: identityConverter, apiKey: "test-key" };
		const stream = agentLoop(
			[{ role: "user", content: "Run the command.", timestamp: Date.now() }],
			context(),
			config,
			undefined,
			(model, llmContext, options) => streamSimple(model, llmContext, { ...options, fetch }),
		);
		for await (const _event of stream) {
			// Drain the lifecycle to prove the second request is observable.
		}
		const messages = await stream.result();

		expect(requests).toHaveLength(2);
		expect(requests.map(request => request.url)).toEqual([
			"https://api.openai.com/v1/chat/completions",
			"https://api.openai.com/v1/chat/completions",
		]);
		expect(JSON.stringify(requests[1]?.body.messages)).toContain("call_bash");
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
		});
	});

	it("dispatches the next Responses request by default", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetch: FetchImpl = async (input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			requests.push({ url: String(input), body });
			return responsesResponse(requests.length === 1 ? responsesToolTurnEvents() : responsesFinalTurnEvents());
		};
		const config: AgentLoopConfig = {
			model: KIMI_K3,
			convertToLlm: identityConverter,
			apiKey: "test-key",
			reasoning: Effort.High,
			toolChoice: { type: "tool", name: "bash" },
		};
		const events = [] as Array<{ type: string }>;
		const stream = agentLoop(
			[{ role: "user", content: "Run the command.", timestamp: Date.now() }],
			context(),
			config,
			undefined,
			(model, llmContext, options) => streamSimple(model, llmContext, { ...options, fetch }),
		);
		for await (const event of stream) events.push(event);
		const messages = await stream.result();

		expect(requests).toHaveLength(2);
		expect(requests.map(request => request.url)).toEqual([
			"https://api.kimi.com/coding/v1/responses",
			"https://api.kimi.com/coding/v1/responses",
		]);
		expect(requests[0]?.body).toMatchObject({
			model: "k3",
			store: false,
			reasoning: { effort: "high" },
			tool_choice: "auto",
		});
		expect(requests[0]?.body).not.toHaveProperty("previous_response_id");
		expect(requests[0]?.body).not.toHaveProperty("conversation");
		expect(JSON.stringify(requests[1]?.body.input)).toContain("call_bash");
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(2);
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
		});
	});
});
