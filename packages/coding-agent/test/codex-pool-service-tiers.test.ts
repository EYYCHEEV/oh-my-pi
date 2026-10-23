import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { resetOAuthAccountRestrictions } from "@oh-my-pi/pi-ai/auth/eligibility";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { type Context, type ServiceTier, shouldSendServiceTier } from "@oh-my-pi/pi-ai/types";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Offline ChatGPT plan-tier matrix for Codex service tiers (Ultrafast, Fast).
 *
 * Two synthetic accounts stand in for different plans: `ultra` advertises
 * `priority` + `ultrafast` (a Pro Max style plan), `basic` advertises only
 * `priority` (a Pro style plan). Discovery and inference are mocked; no network.
 * Each row names the account the request is routed to and what `/fast ultra`
 * (the account-agnostic gate) and the wire request (the account-scoped gate) do.
 */

const MODEL_ID = "gpt-6.1-sol";
type AccountKey = "basic" | "ultra";

const ACCOUNTS: Record<AccountKey, { accountId: string; tiers: string[] }> = {
	basic: { accountId: "acct-basic", tiers: ["priority"] },
	ultra: { accountId: "acct-ultra", tiers: ["priority", "ultrafast"] },
};

function accessTokenFor(key: AccountKey): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNTS[key].accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

const COMPLETED_SSE = `${[
	{ type: "response.output_text.delta", delta: "ok" },
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
		},
	},
]
	.map(event => `data: ${JSON.stringify(event)}`)
	.join("\n\n")}\n\n`;

const context: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

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

describe("Codex service tiers across plan tiers (offline matrix)", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
		tempDir = path.join(os.tmpdir(), `pi-test-codex-pool-tiers-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		resetOAuthAccountRestrictions();
		vi.restoreAllMocks();
		resetSettingsForTest();
		authStorage.close();
		if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	/** Store both accounts in `order`, so the first entry is the first-listed pool member. */
	async function storeAccounts(order: readonly AccountKey[]): Promise<Record<AccountKey, number>> {
		await authStorage.credentials.set(
			"openai-codex",
			order.map(key => ({
				type: "oauth" as const,
				access: accessTokenFor(key),
				refresh: `refresh-${key}`,
				expires: Date.now() + 3_600_000,
				accountId: ACCOUNTS[key].accountId,
				email: `${key}@example.test`,
			})),
		);
		const ids = {} as Record<AccountKey, number>;
		for (const summary of authStorage.oauth.accounts("openai-codex")) {
			const key = (Object.keys(ACCOUNTS) as AccountKey[]).find(k => ACCOUNTS[k].accountId === summary.accountId);
			if (key) ids[key] = summary.credentialId;
		}
		return ids;
	}

	/** Mocked `/models`: each account answers with its own advertised tiers; records which accounts were queried. */
	function catalogFetch(queried: string[]): FetchImpl {
		return async (_input, init) => {
			const accountId = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
			queried.push(accountId);
			const account = Object.values(ACCOUNTS).find(candidate => candidate.accountId === accountId);
			return Response.json({
				models: [{ slug: MODEL_ID, service_tiers: (account?.tiers ?? []).map(id => ({ id })) }],
			});
		};
	}

	async function discover(
		queried: string[] = [],
		options: { cacheDbPath?: string; strategy?: "online" | "online-if-uncached" } = {},
	): Promise<Model<"openai-codex-responses">> {
		const registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: catalogFetch(queried),
			cacheDbPath: options.cacheDbPath,
		});
		await registry.refreshProvider("openai-codex", options.strategy ?? "online");
		return registry.find("openai-codex", MODEL_ID) as Model<"openai-codex-responses">;
	}

	/** The `service_tier` that reaches the wire when `account` serves a request that asks for `tier`. */
	async function wireTier(
		model: Model<"openai-codex-responses">,
		account: AccountKey,
		tier: ServiceTier,
	): Promise<unknown> {
		let sent: unknown = "no request";
		const fetchMock = (async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (!url.endsWith("/responses")) return new Response("not found", { status: 404 });
			sent = decodeBody(init?.body).service_tier;
			return new Response(COMPLETED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as FetchImpl;
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: accessTokenFor(account),
			fetch: fetchMock,
			serviceTier: tier,
			preferWebsockets: false,
		}).result();
		expect(result.stopReason).toBe("stop");
		return sent;
	}

	type Row = {
		cell: string;
		order: readonly AccountKey[];
		/** Hard `--oauth-account` launch restriction, applied before the registry exists. */
		pinnedTo?: AccountKey;
		routedTo: AccountKey;
		/** `/fast ultra` is accepted: the account-agnostic gate. */
		ultraAccepted: boolean;
		/** `service_tier` on the wire for a request that asks for `ultrafast`. */
		ultraOnWire: string | undefined;
		/** Behavior before the per-account fix when it differed (the bug), else undefined. */
		bugBeforeFix?: string;
	};

	const rows: Row[] = [
		{
			cell: "pinned to the Ultrafast-capable account, priority-only sibling stored first",
			order: ["basic", "ultra"],
			pinnedTo: "ultra",
			routedTo: "ultra",
			ultraAccepted: true,
			ultraOnWire: "ultrafast",
		},
		{
			cell: "pinned to the priority-only account, Ultrafast-capable sibling stored first",
			order: ["ultra", "basic"],
			pinnedTo: "basic",
			routedTo: "basic",
			ultraAccepted: false,
			ultraOnWire: undefined,
		},
		{
			cell: "unpinned, priority-only account first, request served by the Ultrafast-capable account",
			order: ["basic", "ultra"],
			routedTo: "ultra",
			ultraAccepted: true,
			ultraOnWire: "ultrafast",
			bugBeforeFix: "false negative: first account's tiers hide Ultrafast (accepted=false, wire=none)",
		},
		{
			cell: "unpinned, priority-only account first, request served by the priority-only account",
			order: ["basic", "ultra"],
			routedTo: "basic",
			ultraAccepted: true,
			ultraOnWire: undefined,
			bugBeforeFix: "`/fast ultra` refused although a pool account offers it (accepted=false)",
		},
		{
			cell: "unpinned, Ultrafast-capable account first, request served by the Ultrafast-capable account",
			order: ["ultra", "basic"],
			routedTo: "ultra",
			ultraAccepted: true,
			ultraOnWire: "ultrafast",
		},
		{
			cell: "unpinned, Ultrafast-capable account first, request served by the priority-only account",
			order: ["ultra", "basic"],
			routedTo: "basic",
			ultraAccepted: true,
			ultraOnWire: undefined,
			bugBeforeFix: "false positive: ultrafast sent to a priority-only account (wire=ultrafast)",
		},
	];

	test.each(rows)("$cell", async row => {
		const ids = await storeAccounts(row.order);
		if (row.pinnedTo) authStorage.oauth.restrict("openai-codex", ids[row.pinnedTo]);
		const queried: string[] = [];
		const model = await discover(queried);
		if (row.pinnedTo) expect(queried).toEqual([ACCOUNTS[row.pinnedTo].accountId]);

		// Fast (`priority`) is advertised by both accounts, so it always reaches the wire.
		expect({
			ultraAccepted: shouldSendServiceTier("ultrafast", model),
			ultraOnWire: await wireTier(model, row.routedTo, "ultrafast"),
			fastOnWire: await wireTier(model, row.routedTo, "priority"),
		}).toEqual({ ultraAccepted: row.ultraAccepted, ultraOnWire: row.ultraOnWire, fastOnWire: "priority" });
	});

	test("resuming a pinned session without the restricted launcher keeps Ultrafast only on the capable account", async () => {
		const ids = await storeAccounts(["basic", "ultra"]);

		// The pinned launch populates its own cache namespace and offers Ultrafast.
		authStorage.oauth.restrict("openai-codex", ids.ultra);
		const pinned = await discover();
		const pinnedView = {
			ultraAccepted: shouldSendServiceTier("ultrafast", pinned),
			ultraOnWire: await wireTier(pinned, "ultra", "ultrafast"),
		};

		// The resumed session runs unpinned over the same model cache. Its serving
		// account (the one the pinned launch used) must still get Ultrafast, and a
		// sibling must not: before the fix the shared catalog took the first stored
		// account's tiers, so the session silently lost Ultrafast on resume.
		resetOAuthAccountRestrictions();
		const resumed = await discover();
		expect({
			pinned: pinnedView,
			resumed: {
				ultraAccepted: shouldSendServiceTier("ultrafast", resumed),
				servedByPinnedAccount: await wireTier(resumed, "ultra", "ultrafast"),
				servedBySibling: await wireTier(resumed, "basic", "ultrafast"),
			},
		}).toEqual({
			pinned: { ultraAccepted: true, ultraOnWire: "ultrafast" },
			resumed: { ultraAccepted: true, servedByPinnedAccount: "ultrafast", servedBySibling: undefined },
		});
	});

	/** What a launch sees of the restricted account's model: who was queried, which accounts the row names, the gates. */
	async function restrictedView(model: Model<"openai-codex-responses">, queried: string[]) {
		return {
			queried,
			accounts: Object.keys(model.accountAccess ?? {}),
			ultraAccepted: shouldSendServiceTier("ultrafast", model),
			ultraOnWire: await wireTier(model, "ultra", "ultrafast"),
		};
	}

	const RESTRICTED_VIEW = {
		queried: [ACCOUNTS.ultra.accountId],
		accounts: [ACCOUNTS.ultra.accountId],
		ultraAccepted: true,
		ultraOnWire: "ultrafast",
	};

	test("a restricted launch whose model cache can never be created serves its tiers from memory on every launch", async () => {
		const ids = await storeAccounts(["basic", "ultra"]);
		authStorage.oauth.restrict("openai-codex", ids.ultra);
		// A regular file where a directory is expected: models.db can be neither created nor read.
		const fence = path.join(tempDir, "fenced");
		fs.writeFileSync(fence, "");
		const cacheDbPath = path.join(fence, "models.db");

		const launches = [];
		for (let launch = 0; launch < 2; launch++) {
			const queried: string[] = [];
			const model = await discover(queried, { cacheDbPath, strategy: "online-if-uncached" });
			launches.push(await restrictedView(model, queried));
		}

		// Each launch refetches (nothing could be cached) and only ever asks the restricted account.
		expect(launches).toEqual([RESTRICTED_VIEW, RESTRICTED_VIEW]);
		expect(fs.existsSync(cacheDbPath)).toBe(false);
	});

	test.skipIf(process.getuid?.() === 0)(
		"a restricted launch over a write-protected cache never falls back to the shared row",
		async () => {
			const cacheDir = path.join(tempDir, "agent-dir");
			fs.mkdirSync(cacheDir);
			const cacheDbPath = path.join(cacheDir, "models.db");
			const providerRows = () => {
				const db = new Database(cacheDbPath, { readonly: true });
				try {
					return db
						.query<{ provider_id: string }, []>("SELECT provider_id FROM model_cache ORDER BY provider_id")
						.all()
						.map(row => row.provider_id);
				} finally {
					db.close();
				}
			};
			const isWritable = () => {
				const probe = path.join(cacheDir, ".probe");
				try {
					fs.writeFileSync(probe, "");
					fs.rmSync(probe);
					return true;
				} catch {
					return false;
				}
			};
			const snapshot = () => ({
				files: fs.readdirSync(cacheDir).sort(),
				bytes: fs.statSync(cacheDbPath).size,
				modified: fs.statSync(cacheDbPath).mtimeMs,
			});

			// A normal unpinned run first fills the shared `openai-codex` row with both accounts.
			const ids = await storeAccounts(["basic", "ultra"]);
			await discover([], { cacheDbPath });
			const sharedNamespace = resolveModelCacheProviderId("openai-codex", {});
			const rowsBefore = providerRows();
			expect(rowsBefore).toContain(sharedNamespace);
			expect(rowsBefore.filter(id => id.startsWith(`${sharedNamespace}:oauth:`))).toEqual([]);
			const before = snapshot();

			// The fence: the cache stays readable but nothing in it can be written or created.
			for (const file of fs.readdirSync(cacheDir)) fs.chmodSync(path.join(cacheDir, file), 0o444);
			fs.chmodSync(cacheDir, 0o555);
			try {
				expect(isWritable()).toBe(false);
				authStorage.oauth.restrict("openai-codex", ids.ultra);
				const launches = [];
				for (let launch = 0; launch < 2; launch++) {
					const queried: string[] = [];
					const model = await discover(queried, { cacheDbPath, strategy: "online-if-uncached" });
					launches.push(await restrictedView(model, queried));
				}
				// The shared row names both accounts; seeing only the restricted one proves it was never read.
				expect(launches).toEqual([RESTRICTED_VIEW, RESTRICTED_VIEW]);
			} finally {
				fs.chmodSync(cacheDir, 0o755);
				for (const file of fs.readdirSync(cacheDir)) fs.chmodSync(path.join(cacheDir, file), 0o644);
			}
			// Nothing was written, renamed, or recreated beside the protected database.
			expect(snapshot()).toEqual(before);
			expect(providerRows()).toEqual(rowsBefore);
		},
	);
});
