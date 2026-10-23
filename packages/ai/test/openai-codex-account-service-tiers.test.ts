import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import {
	type Context,
	type FetchImpl,
	type Model,
	type ServiceTier,
	shouldSendServiceTier,
	shouldSendServiceTierForAccount,
} from "@oh-my-pi/pi-ai/types";
import * as piUtils from "@oh-my-pi/pi-utils";
import { createCodexModel } from "./helpers";

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
	vi.restoreAllMocks();
});

function accessTokenFor(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

const context: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

const COMPLETED_SSE = `${[
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
]
	.map(event => `data: ${JSON.stringify(event)}`)
	.join("\n\n")}\n\n`;

function decodeBody(body: RequestInit["body"]): Record<string, unknown> {
	const text =
		typeof body === "string"
			? body
			: body instanceof Uint8Array
				? new TextDecoder().decode(Bun.zstdDecompressSync(body))
				: undefined;
	if (text === undefined) throw new Error("expected a string or binary Codex request body");
	return JSON.parse(text) as Record<string, unknown>;
}

/** The `service_tier` on the wire when `apiKey` serves a request that asks for `tier`. */
async function wireTier(model: Model<"openai-codex-responses">, apiKey: string, tier: ServiceTier): Promise<unknown> {
	let sent: unknown = "no request";
	const fetchMock = (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (!url.endsWith("/responses")) return new Response("not found", { status: 404 });
		sent = decodeBody(init?.body).service_tier;
		return new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as FetchImpl;
	const result = await streamOpenAICodexResponses(model, context, {
		apiKey,
		fetch: fetchMock,
		serviceTier: tier,
		preferWebsockets: false,
	}).result();
	expect(result.stopReason).toBe("stop");
	return sent;
}

const pool = (
	modelLevel: string[] | undefined,
	accounts: Record<string, readonly string[] | undefined>,
): Model<"openai-codex-responses"> =>
	createCodexModel("gpt-6.1-sol", {
		preferWebsockets: false,
		...(modelLevel ? { serviceTiers: modelLevel } : {}),
		accountAccess: Object.fromEntries(
			Object.entries(accounts).map(([accountId, serviceTiers]) => [
				accountId,
				serviceTiers === undefined ? {} : { serviceTiers },
			]),
		),
	});

describe("Codex service tiers are an account entitlement", () => {
	it("sends Ultrafast only to the account that advertises it, whichever account the merge listed first", async () => {
		const accounts = { "acct-basic": ["priority"], "acct-ultra": ["priority", "ultrafast"] };
		// The model-level list is the first listing account's view: priority-only, then Ultrafast-capable.
		for (const modelLevel of [["priority"], ["priority", "ultrafast"]]) {
			const model = pool(modelLevel, accounts);
			expect(await wireTier(model, accessTokenFor("acct-ultra"), "ultrafast")).toBe("ultrafast");
			expect(await wireTier(model, accessTokenFor("acct-basic"), "ultrafast")).toBeUndefined();
			expect(await wireTier(model, accessTokenFor("acct-basic"), "priority")).toBe("priority");
		}
	});

	it("applies the priority drop rule to the serving account's own list", async () => {
		const model = pool(["priority"], {
			"acct-basic": ["priority"],
			"acct-ultra-only": ["ultrafast"],
			"acct-free": [],
			"acct-silent": undefined,
		});
		const sent = async (accountId: string) => wireTier(model, accessTokenFor(accountId), "priority");
		expect(await sent("acct-basic")).toBe("priority");
		// A non-empty list that omits `priority` drops Fast for that account only.
		expect(await sent("acct-ultra-only")).toBeUndefined();
		// `[]` and a missing list mean "not reported": Fast stays available.
		expect(await sent("acct-free")).toBe("priority");
		expect(await sent("acct-silent")).toBe("priority");
	});

	it("withholds Ultrafast from an account the catalog row does not know", async () => {
		// A stale or foreign cache row (for example a reused credential id) records only another account.
		const model = pool(["priority", "ultrafast"], { "acct-other": ["priority", "ultrafast"] });
		expect(await wireTier(model, accessTokenFor("acct-basic"), "ultrafast")).toBeUndefined();
		// A bearer token that carries no account id cannot be matched to an entry either.
		expect(await wireTier(model, "opaque-token-without-account", "ultrafast")).toBeUndefined();
		expect(await wireTier(model, accessTokenFor("acct-other"), "ultrafast")).toBe("ultrafast");
	});

	it("keeps the model-level list when discovery recorded no per-account tiers", async () => {
		// Caches written before per-account tiers, and gateways without account ids, carry only the model list.
		const legacy = createCodexModel("gpt-6.1-sol", {
			preferWebsockets: false,
			serviceTiers: ["priority", "ultrafast"],
			accountAccess: { "acct-basic": { cyberPrograms: ["standard"] } },
		});
		expect(await wireTier(legacy, accessTokenFor("acct-basic"), "ultrafast")).toBe("ultrafast");
		expect(shouldSendServiceTierForAccount("ultrafast", legacy, undefined)).toBe(true);
		const priorityOnly = createCodexModel("gpt-6.1-sol", { preferWebsockets: false, serviceTiers: ["priority"] });
		expect(await wireTier(priorityOnly, accessTokenFor("acct-basic"), "ultrafast")).toBeUndefined();
	});

	it("answers account-agnostic questions with whether some pool account can serve the tier", () => {
		const mixed = pool(["priority"], { "acct-basic": ["priority"], "acct-ultra": ["priority", "ultrafast"] });
		expect(shouldSendServiceTier("ultrafast", mixed)).toBe(true);
		expect(shouldSendServiceTier("priority", mixed)).toBe(true);

		const noUltra = pool(["priority"], { "acct-basic": ["priority"], "acct-free": [] });
		expect(shouldSendServiceTier("ultrafast", noUltra)).toBe(false);
		expect(shouldSendServiceTier("priority", noUltra)).toBe(true);

		// Every account lists a non-empty set without `priority`: nobody can serve Fast.
		const ultraOnly = pool(["ultrafast"], { "acct-a": ["ultrafast"], "acct-b": ["ultrafast"] });
		expect(shouldSendServiceTier("priority", ultraOnly)).toBe(false);
		// One account that reports nothing keeps Fast available for the pool.
		const oneSilent = pool(["ultrafast"], { "acct-a": ["ultrafast"], "acct-free": [] });
		expect(shouldSendServiceTier("priority", oneSilent)).toBe(true);
	});
});
