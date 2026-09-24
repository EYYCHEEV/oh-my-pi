import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseCodexRateLimitHeaders } from "@oh-my-pi/pi-ai";
import { resetOAuthAccountRestrictions } from "@oh-my-pi/pi-ai/auth/eligibility";
import { type AuthStorageOptions, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { OAuthAccountPoolError, type OAuthAccountPoolErrorCode } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageProvider } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const PROVIDER = "openai-codex";
const HOUR_MS = 60 * 60 * 1000;

function codexCredential(suffix: string, expires = Date.now() + 24 * HOUR_MS) {
	return {
		type: "oauth" as const,
		access: `access-acct-${suffix}`,
		refresh: `refresh-acct-${suffix}`,
		expires,
		accountId: `acct-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

async function expectPoolError(
	action: Promise<unknown> | (() => unknown),
	code: OAuthAccountPoolErrorCode,
): Promise<OAuthAccountPoolError> {
	let caught: unknown;
	try {
		await (typeof action === "function" ? action() : action);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(OAuthAccountPoolError);
	expect((caught as OAuthAccountPoolError).code).toBe(code);
	return caught as OAuthAccountPoolError;
}

describe("exact-account OAuth restriction", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage;
	const usageCalls: string[] = [];
	const apiKeyCalls: string[] = [];
	const refreshCalls: number[] = [];
	let refreshImpl: (credentialId: number, credential: OAuthCredentials) => Promise<OAuthCredentials>;
	const usageProvider: UsageProvider = {
		id: "openai-codex",
		parseRateLimitHeaders: parseCodexRateLimitHeaders,
		async fetchUsage(params) {
			if (params.credential.accountId) usageCalls.push(params.credential.accountId);
			return null;
		},
	};

	function options(): AuthStorageOptions {
		return {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
			refreshOAuthCredential: async (_provider, credentialId, credential) => {
				refreshCalls.push(credentialId);
				const { type: _type, ...rest } = credential;
				return refreshImpl(credentialId, rest);
			},
		};
	}

	function ids(): Record<string, number> {
		return Object.fromEntries(
			storage.oauth
				.accounts(PROVIDER)
				.map(account => [account.accountId!.replace("acct-", ""), account.credentialId]),
		);
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-restriction-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store, options());
		usageCalls.length = 0;
		apiKeyCalls.length = 0;
		refreshCalls.length = 0;
		refreshImpl = async (_id, credential) => ({ ...credential, expires: Date.now() + HOUR_MS });
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[PROVIDER] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			apiKeyCalls.push(credential.accountId);
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});
	});

	afterEach(async () => {
		resetOAuthAccountRestrictions();
		vi.restoreAllMocks();
		store?.close();
		store = null;
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	test("uses only the target, including from a second AuthStorage in the process", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b"), codexCredential("c")]);
		const { b } = ids();
		storage.oauth.restrict(PROVIDER, b!);
		expect(storage.oauth.restriction(PROVIDER)).toBe(b);
		for (let index = 0; index < 12; index += 1) {
			expect(await storage.keys.get(PROVIDER, `restricted-${index}`)).toBe("api-acct-b");
		}
		expect(await storage.keys.get(PROVIDER)).toBe("api-acct-b");
		const other = await AuthStorage.create(dbPath, options());
		try {
			await other.credentials.reload();
			expect(other.oauth.restriction(PROVIDER)).toBe(b);
			expect(await other.keys.get(PROVIDER, "other-session")).toBe("api-acct-b");
			expect((await other.oauth.access(PROVIDER, "other-session"))?.accountId).toBe("acct-b");
			expect(other.oauth.accounts(PROVIDER).map(account => account.excluded)).toEqual([
				"restricted",
				undefined,
				"restricted",
			]);
		} finally {
			other.close();
		}
		expect(new Set(apiKeyCalls)).toEqual(new Set(["acct-b"]));
		expect(usageCalls.every(accountId => accountId === "acct-b")).toBe(true);
	});

	test("the restriction overrides a pause", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const { b } = ids();
		storage.credentials.pause(PROVIDER, b!);
		storage.oauth.restrict(PROVIDER, b!);
		expect(await storage.keys.get(PROVIDER, "paused-target")).toBe("api-acct-b");
	});

	test("a usage-limited or blocked target fails closed without a sibling", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const { a } = ids();
		storage.oauth.restrict(PROVIDER, a!);
		expect(await storage.keys.get(PROVIDER, "limited")).toBe("api-acct-a");
		const outcome = await storage.limits.markReached(PROVIDER, "limited", { retryAfterMs: HOUR_MS });
		expect(outcome.switched).toBe(false);
		const error = await expectPoolError(storage.keys.get(PROVIDER, "limited"), "restricted_unavailable");
		expect(error.message).toContain("blocked until");
		expect(error.message).toContain(`--oauth-account ${PROVIDER}:${a}`);
		expect(apiKeyCalls).not.toContain("acct-b");
	});

	test("a definitive refresh failure uses no sibling", async () => {
		const expired = Date.now() - 1_000;
		await storage.credentials.set(PROVIDER, [codexCredential("a", expired), codexCredential("b", expired)]);
		const { a } = ids();
		storage.oauth.restrict(PROVIDER, a!);
		refreshImpl = async () => {
			throw new Error("invalid_grant: refresh token revoked");
		};
		const error = await expectPoolError(storage.keys.get(PROVIDER, "dead"), "restricted_unavailable");
		expect(error.message).toContain("refresh");
		expect(refreshCalls.every(id => id === a)).toBe(true);
		expect(apiKeyCalls).toEqual([]);
	});

	test("never falls through to env, login key, or stored key credentials", async () => {
		await storage.credentials.set(PROVIDER, [
			codexCredential("a", Date.now() - 1_000),
			codexCredential("b"),
			{ type: "api_key", key: "sk-login-key", source: "login" },
		]);
		const { a, b } = ids();
		await withEnv({ OPENAI_CODEX_OAUTH_TOKEN: "env-token" }, async () => {
			storage.oauth.restrict(PROVIDER, a!);
			// Target is not fresh: peek must not substitute the sibling, login key, or env token.
			expect(await storage.keys.peek(PROVIDER)).toBeUndefined();
			refreshImpl = async () => {
				throw new Error("network down");
			};
			await expectPoolError(storage.keys.get(PROVIDER, "fallthrough"), "restricted_unavailable");
			await expectPoolError(storage.oauth.access(PROVIDER, "fallthrough"), "restricted_unavailable");
			resetOAuthAccountRestrictions();
			storage.oauth.restrict(PROVIDER, b!);
			expect(await storage.keys.peek(PROVIDER)).toBe("access-acct-b");
		});
		expect(apiKeyCalls).not.toContain("acct-a");
	});

	test("runtime and config overrides stay settable but fail closed on use", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		storage.oauth.restrict(PROVIDER, ids().a!);
		expect(() => storage.keys.setRuntime(PROVIDER, "sk-runtime")).not.toThrow();
		await expectPoolError(storage.keys.get(PROVIDER, "override"), "restricted_unavailable");
		await expectPoolError(storage.keys.peek(PROVIDER), "restricted_unavailable");
		await expectPoolError(storage.oauth.access(PROVIDER, "override"), "restricted_unavailable");
		storage.keys.removeRuntime(PROVIDER);
		expect(() => storage.keys.setConfig(PROVIDER, "sk-config")).not.toThrow();
		await expectPoolError(storage.keys.get(PROVIDER, "override"), "restricted_unavailable");
		storage.keys.removeConfig(PROVIDER);
		expect(await storage.keys.get(PROVIDER, "override")).toBe("api-acct-a");
	});

	test("restrict rejects missing, disabled, and overridden targets", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const { a, b } = ids();
		await expectPoolError(() => storage.oauth.restrict(PROVIDER, 987_654), "restricted_missing");
		await storage.credentials.disable(b!, "disabled by test");
		await expectPoolError(() => storage.oauth.restrict(PROVIDER, b!), "restricted_missing");
		storage.keys.setRuntime(PROVIDER, "sk-runtime");
		await expectPoolError(() => storage.oauth.restrict(PROVIDER, a!), "restricted_unavailable");
		expect(storage.oauth.restriction(PROVIDER)).toBeUndefined();
	});

	test("a restricted target refresh persists through compare-and-swap", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a", Date.now() - 1_000), codexCredential("b")]);
		const { a, b } = ids();
		storage.oauth.restrict(PROVIDER, a!);
		refreshImpl = async (_id, credential) => ({
			...credential,
			access: "access-refreshed",
			expires: Date.now() + HOUR_MS,
		});
		const casSpy = vi.spyOn(store!, "tryUpdateAuthCredentialIfMatches");
		expect(await storage.keys.get(PROVIDER, "cas")).toBe("api-acct-a");
		expect(casSpy.mock.calls.some(call => call[0] === a)).toBe(true);
		expect(casSpy.mock.calls.some(call => call[0] === b)).toBe(false);
		const persisted = store!.listAuthCredentials(PROVIDER).find(row => row.id === a);
		expect(persisted?.credential.type === "oauth" && persisted.credential.access).toBe("access-refreshed");
	});
});
