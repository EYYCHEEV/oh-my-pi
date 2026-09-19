import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { streamKimi } from "../../src/providers/kimi";
import type { Context, Model } from "../../src/types";

function kimiK3(): Model<"openai-completions"> {
	const model = getBundledModel<"openai-completions">("kimi-code", "k3");
	if (!model) throw new Error("bundled Kimi K3 model is required");
	return model;
}

function context(): Context {
	return {
		systemPrompt: ["Use the available tools."],
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Inspect this image." },
					{ type: "image", data: "AQID", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_old", name: "bash", arguments: { command: "printf old" } }],
				api: "openai-responses",
				provider: "kimi-code",
				model: "k3",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: "kimi-code",
					items: [
						{ type: "reasoning", id: "reason_old", summary: [], encrypted_content: "enc_old" },
						{
							type: "function_call",
							id: "fc_old",
							call_id: "call_old",
							name: "bash",
							arguments: '{"command":"printf old"}',
						},
					],
				},
			},
			{
				role: "toolResult",
				toolCallId: "call_old",
				toolName: "bash",
				content: [{ type: "text", text: "old" }],
				isError: false,
				timestamp: 3,
			},
		],
		tools: [
			{
				name: "bash",
				description: "Run a command.",
				parameters: {
					type: "object",
					properties: { command: { type: "string" } },
					required: ["command"],
					additionalProperties: false,
				},
			},
		],
	};
}

describe("Kimi default transport policy", () => {
	it("defaults bundled K3 to Responses while retaining Anthropic for K2.7", async () => {
		const urls: string[] = [];
		const requestContext: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		for (const id of ["k3", "k3-256k", "kimi-for-coding"] as const) {
			const model = getBundledModel<"openai-completions">("kimi-code", id);
			if (!model) throw new Error(`bundled Kimi model ${id} is required`);
			const stream = streamKimi(model, requestContext, {
				apiKey: "test-key",
				fetch: async input => {
					urls.push(String(input));
					return new Response("unauthorized", { status: 401 });
				},
			});
			await stream.result();
		}
		expect(urls).toEqual([
			"https://api.kimi.com/coding/v1/responses",
			"https://api.kimi.com/coding/v1/responses",
			"https://api.kimi.com/coding/v1/messages",
		]);
	});

	it("keeps discovered K3 on Responses when protocol metadata is unset", async () => {
		const bundled = kimiK3();
		const discovered = buildModel({
			...bundled,
			compat: { ...bundled.compatConfig, kimiApiFormat: undefined },
		} as ModelSpec<"openai-completions">);
		let url: string | undefined;
		const stream = streamKimi(
			discovered,
			{
				systemPrompt: [],
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{
				apiKey: "test-key",
				fetch: async input => {
					url = String(input);
					return new Response("unauthorized", { status: 401 });
				},
			},
		);
		await stream.result();
		expect(url).toBe("https://api.kimi.com/coding/v1/responses");
	});
});

describe("Kimi K3 Responses wire contract", () => {
	it("uses full replay, data-url images, auto tool choice, and no unsupported stateful fields", async () => {
		let payload: Record<string, unknown> | undefined;
		const stream = streamKimi(kimiK3(), context(), {
			apiKey: "test-key",
			format: "responses",
			reasoning: Effort.High,
			cacheRetention: "long",
			promptCacheKey: "stable-kimi-cache",
			toolChoice: { type: "tool", name: "bash" },
			fetch: async () => new Response("", { status: 500 }),
			onPayload: body => {
				payload = body as Record<string, unknown>;
				throw new Error("capture Kimi Responses payload");
			},
		});
		await stream.result();

		expect(payload).toMatchObject({
			model: "k3",
			store: false,
			reasoning: { effort: "high" },
			prompt_cache_key: "stable-kimi-cache",
			tool_choice: "auto",
		});
		const wirePayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
		expect(wirePayload).not.toHaveProperty("prompt_cache_retention");
		expect(wirePayload).not.toHaveProperty("previous_response_id");
		expect(wirePayload).not.toHaveProperty("conversation");
		const input = payload?.input;
		expect(JSON.stringify(input)).toContain('"type":"reasoning"');
		expect(JSON.stringify(input)).toContain("call_old");
		expect(JSON.stringify(input)).toContain("enc_old");
		const imageContext: Context = {
			systemPrompt: [],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Inspect this image." },
						{ type: "image", data: "AQID", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
		};
		let imagePayload: Record<string, unknown> | undefined;
		const imageStream = streamKimi(kimiK3(), imageContext, {
			apiKey: "test-key",
			format: "responses",
			onPayload: body => {
				imagePayload = body as Record<string, unknown>;
				throw new Error("capture image payload");
			},
		});
		await imageStream.result();
		expect(JSON.stringify(imagePayload?.input)).toContain('"image_url":"data:image/png;base64,AQID"');
	});
});
