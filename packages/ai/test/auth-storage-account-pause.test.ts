import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseCodexRateLimitHeaders, REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-ai";
import {
	type AuthBrokerClient,
	type FetchSnapshotResult,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
} from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthStorageOptions,
	AuthStorage,
	type OAuthAccountRerouteEvent,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { OAuthAccountPoolError, type OAuthAccountPoolErrorCode } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const PROVIDER = "openai-codex";
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

function limit(key: "primary" | "secondary", durationMs: number, usedFraction: number): UsageLimit {
	const used = usedFraction * 100;
	return {
		id: `openai-codex:${key}`,
		label: key,
		scope: { provider: "openai-codex", windowId: key === "primary" ? "5h" : "7d", shared: true },
		window: {
			id: key === "primary" ? "5h" : "7d",
			label: key,
			durationMs,
			resetsAt: Date.now() + durationMs / 2,
		},
		amount: {
			unit: "percent",
			used,
			limit: 100,
			remaining: 100 - used,
			usedFraction,
			remainingFraction: 1 - usedFraction,
		},
		status: "ok",
	};
}

function healthyReport(accountId: string): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: Date.now(),
		limits: [limit("primary", 5 * HOUR_MS, 0.1), limit("secondary", WEEK_MS, 0.1)],
		metadata: { accountId },
	};
}

function codexCredential(suffix: string, expires = Date.now() + WEEK_MS) {
	return {
		type: "oauth" as const,
		access: `access-acct-${suffix}`,
		refresh: `refresh-acct-${suffix}`,
		expires,
		accountId: `acct-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function readRow(dbPath: string, id: number): { data: string; disabled_cause: string | null } | undefined {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT data, disabled_cause FROM auth_credentials WHERE id = ?").get(id) as
			| { data: string; disabled_cause: string | null }
			| undefined;
	} finally {
		db.close();
	}
}

function tableExists(dbPath: string, name: string): boolean {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
			| { present?: number }
			| undefined;
		return row?.present === 1;
	} finally {
		db.close();
	}
}

function readSchemaVersion(dbPath: string): number | undefined {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get() as
			| { version?: number }
			| undefined;
		return row?.version;
	} finally {
		db.close();
	}
}

async function expectPoolError(
	promise: Promise<unknown>,
	code: OAuthAccountPoolErrorCode,
): Promise<OAuthAccountPoolError> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(OAuthAccountPoolError);
	expect((caught as OAuthAccountPoolError).code).toBe(code);
	return caught as OAuthAccountPoolError;
}

describe("auth_credential_pauses store", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-account-pause-store-"));
	});

	afterEach(async () => {
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	test("a fresh database gets the pause table at schema version 8", async () => {
		const dbPath = path.join(tempDir, "fresh.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.close();
		expect(tableExists(dbPath, "auth_credential_pauses")).toBe(true);
		expect(readSchemaVersion(dbPath)).toBe(8);
	});

	test("an existing version-8 database gains the table on reopen and stays version 8", async () => {
		const dbPath = path.join(tempDir, "existing.db");
		const first = await SqliteAuthCredentialStore.open(dbPath);
		await first.upsertAuthCredential(PROVIDER, codexCredential("a"));
		first.close();
		const raw = new Database(dbPath);
		try {
			raw.run("DROP TABLE IF EXISTS auth_credential_pauses");
		} finally {
			raw.close();
		}
		expect(tableExists(dbPath, "auth_credential_pauses")).toBe(false);

		const reopened = await SqliteAuthCredentialStore.open(dbPath);
		reopened.close();
		expect(tableExists(dbPath, "auth_credential_pauses")).toBe(true);
		expect(readSchemaVersion(dbPath)).toBe(8);
	});

	test("a second reopen issues no write transaction", async () => {
		const dbPath = path.join(tempDir, "reopen.db");
		const first = await SqliteAuthCredentialStore.open(dbPath);
		const [row] = await first.upsertAuthCredential(PROVIDER, codexCredential("a"));
		first.setCredentialPaused(row!.id, true, Date.now());
		first.close();
		(await SqliteAuthCredentialStore.open(dbPath)).close();

		const observer = new Database(dbPath, { readonly: true });
		try {
			const before = (observer.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
			const reopened = await SqliteAuthCredentialStore.open(dbPath);
			try {
				expect(reopened.listCredentialPauses().map(pause => pause.credentialId)).toEqual([row!.id]);
			} finally {
				reopened.close();
			}
			const after = (observer.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
			expect(after).toBe(before);
		} finally {
			observer.close();
		}
	});

	test("a pause on one connection is reported by another connection's poll", async () => {
		const dbPath = path.join(tempDir, "poll.db");
		const a = await SqliteAuthCredentialStore.open(dbPath);
		const b = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const [row] = await a.upsertAuthCredential(PROVIDER, codexCredential("a"));
			b.pollExternalChanges();
			expect(b.pollExternalChanges()).toBe(false);
			expect(a.setCredentialPaused(row!.id, true, 1234)).toBe(true);
			expect(b.pollExternalChanges()).toBe(true);
			expect(b.listCredentialPauses()).toEqual([{ credentialId: row!.id, pausedAtMs: 1234 }]);
			// Own writes are acknowledged locally, not reported as external.
			expect(a.pollExternalChanges()).toBe(false);
		} finally {
			a.close();
			b.close();
		}
	});

	test("rejects disabled and API-key rows; pause and resume are idempotent", async () => {
		const dbPath = path.join(tempDir, "reject.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const [oauthRow] = await store.upsertAuthCredential(PROVIDER, codexCredential("a"));
			const [apiKeyRow] = await store.upsertAuthCredential("unit-api-key-provider", {
				type: "api_key",
				key: "sk-unit",
			});
			expect(() => store.setCredentialPaused(apiKeyRow!.id, true, Date.now())).toThrow();
			expect(store.setCredentialPaused(oauthRow!.id, true, Date.now())).toBe(true);
			expect(store.setCredentialPaused(oauthRow!.id, true, Date.now())).toBe(false);
			expect(store.setCredentialPaused(oauthRow!.id, false, Date.now())).toBe(true);
			expect(store.setCredentialPaused(oauthRow!.id, false, Date.now())).toBe(false);
			await store.deleteAuthCredential(oauthRow!.id, "deleted by test");
			expect(() => store.setCredentialPaused(oauthRow!.id, true, Date.now())).toThrow();
			expect(() => store.setCredentialPaused(987_654, true, Date.now())).toThrow();
		} finally {
			store.close();
		}
	});

	test("a same-identity upsert keeps the row id and the pause; disabled rows are not listed", async () => {
		const dbPath = path.join(tempDir, "relogin.db");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const [row] = await store.upsertAuthCredential(PROVIDER, codexCredential("a"));
			store.setCredentialPaused(row!.id, true, 42);
			const rows = await store.upsertAuthCredential(PROVIDER, { ...codexCredential("a"), access: "access-relogin" });
			expect(rows.map(r => r.id)).toEqual([row!.id]);
			expect(store.listCredentialPauses()).toEqual([{ credentialId: row!.id, pausedAtMs: 42 }]);
			await store.deleteAuthCredential(row!.id, "deleted by test");
			expect(store.listCredentialPauses()).toEqual([]);
		} finally {
			store.close();
		}
	});
});

describe("AuthStorage paused OAuth accounts", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage;
	const usageCalls: string[] = [];
	const apiKeyCalls: string[] = [];
	const refreshCalls: number[] = [];
	const usageProvider: UsageProvider = {
		id: "openai-codex",
		parseRateLimitHeaders: parseCodexRateLimitHeaders,
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			usageCalls.push(accountId);
			return healthyReport(accountId);
		},
	};
	const usageFetch = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

	function options(extra: AuthStorageOptions = {}): AuthStorageOptions {
		return {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
			usageFetch,
			refreshOAuthCredential: async (_provider, credentialId, credential) => {
				refreshCalls.push(credentialId);
				const { type: _type, ...rest } = credential;
				return { ...rest, expires: Date.now() + WEEK_MS };
			},
			...extra,
		};
	}

	function ids(target: AuthStorage = storage): Record<string, number> {
		return Object.fromEntries(
			target.oauth.accounts(PROVIDER).map(a => [a.accountId!.replace("acct-", ""), a.credentialId]),
		);
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-account-pause-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(store, options());
		usageCalls.length = 0;
		apiKeyCalls.length = 0;
		refreshCalls.length = 0;
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[PROVIDER] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			apiKeyCalls.push(credential.accountId);
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	test("pause and resume are idempotent and never change token bytes", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const { b } = ids();
		const before = readRow(dbPath, b!)?.data;
		expect(storage.credentials.supportsPause()).toBe(true);
		expect(storage.credentials.pause(PROVIDER, b!)).toEqual({ changed: true });
		expect(storage.credentials.pause(PROVIDER, b!)).toEqual({ changed: false });
		expect(storage.credentials.isAutoSelectable(PROVIDER, b!)).toBe(false);
		expect(readRow(dbPath, b!)?.data).toBe(before);
		expect(storage.credentials.resume(PROVIDER, b!)).toEqual({ changed: true });
		expect(storage.credentials.resume(PROVIDER, b!)).toEqual({ changed: false });
		expect(storage.credentials.isAutoSelectable(PROVIDER, b!)).toBe(true);
		expect(readRow(dbPath, b!)?.data).toBe(before);
	});

	test("oauth.accounts reports pause state", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const { b } = ids();
		storage.credentials.pause(PROVIDER, b!);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		expect(accountA?.paused).toBe(false);
		expect(accountA?.pausedAtMs).toBeUndefined();
		expect(accountA?.excluded).toBeUndefined();
		expect(accountB?.paused).toBe(true);
		expect(typeof accountB?.pausedAtMs).toBe("number");
		expect(accountB?.excluded).toBe("paused");
	});

	test("a paused account is never ranked, usage-fetched, refreshed, or served", async () => {
		const expired = Date.now() - 1_000;
		await storage.credentials.set(PROVIDER, [
			codexCredential("a", expired),
			codexCredential("b", expired),
			codexCredential("c", expired),
		]);
		const { b } = ids();
		storage.credentials.pause(PROVIDER, b!);

		const served = new Set<string | undefined>();
		for (let index = 0; index < 24; index += 1) {
			served.add(await storage.keys.get(PROVIDER, `session-${index}`));
			served.add(await storage.keys.get(PROVIDER));
		}
		expect(served.has("api-acct-b")).toBe(false);
		expect(served.has("api-acct-a") || served.has("api-acct-c")).toBe(true);
		expect(usageCalls).not.toContain("acct-b");
		expect(apiKeyCalls).not.toContain("acct-b");
		expect(refreshCalls).not.toContain(b);
	});

	test("an account policy that matches a paused account neither throws nor ranks it", async () => {
		store!.close();
		store = await SqliteAuthCredentialStore.open(dbPath);
		storage = new AuthStorage(
			store,
			options({ accountPolicies: [{ provider: PROVIDER, account: { email: "b@example.com" }, priority: 100 }] }),
		);
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		storage.credentials.pause(PROVIDER, ids().b!);
		for (let index = 0; index < 8; index += 1) {
			expect(await storage.keys.get(PROVIDER, `policy-${index}`)).toBe("api-acct-a");
		}
	});

	test("the allow-blocked fallback and usage-limit rotation never pick a paused sibling", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const { a, b } = ids();
		storage.credentials.pause(PROVIDER, b!);
		const outcome = await storage.limits.markReached(PROVIDER, undefined, { credentialId: a, retryAfterMs: HOUR_MS });
		expect(outcome.switched).toBe(false);
		expect(await storage.keys.get(PROVIDER, "blocked-session")).toBe("api-acct-a");
		expect(apiKeyCalls).not.toContain("acct-b");
	});

	test("hard-auth rotation does not count a paused sibling", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const { a, b } = ids();
		storage.credentials.pause(PROVIDER, b!);
		expect(
			await storage.limits.rotate(PROVIDER, undefined, { credentialId: a, error: new Error("401 Unauthorized") }),
		).toBe(false);
	});

	test("keys.peek skips paused accounts", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b"), codexCredential("c")]);
		const { a, b } = ids();
		storage.credentials.pause(PROVIDER, a!);
		storage.credentials.pause(PROVIDER, b!);
		for (let index = 0; index < 6; index += 1) {
			expect(await storage.keys.peek(PROVIDER)).toBe("access-acct-c");
		}
	});

	test("sticky indexes stay correct when an API-key row precedes the OAuth rows", async () => {
		await storage.credentials.set(PROVIDER, [
			{ type: "api_key", key: "sk-static" },
			codexCredential("a"),
			codexCredential("b"),
		]);
		const { a, b } = ids();
		const events: OAuthAccountRerouteEvent[] = [];
		storage.sessions.onReroute(event => events.push(event));
		expect(storage.sessions.pin(PROVIDER, "indexed", b!)).toBe(true);
		storage.credentials.pause(PROVIDER, a!);
		expect(await storage.keys.get(PROVIDER, "indexed")).toBe("api-acct-b");
		expect(events).toEqual([]);
		storage.credentials.resume(PROVIDER, a!);
		storage.credentials.pause(PROVIDER, b!);
		expect(await storage.keys.get(PROVIDER, "indexed")).toBe("api-acct-a");
		expect(events).toEqual([
			{ provider: PROVIDER, sessionId: "indexed", fromCredentialId: b!, toCredentialId: a!, reason: "paused" },
		]);
	});

	for (const restored of [false, true]) {
		test(`a ${restored ? "restored" : "explicit"} pin on a paused account reroutes once`, async () => {
			await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
			const { a, b } = ids();
			const events: OAuthAccountRerouteEvent[] = [];
			const unsubscribe = storage.sessions.onReroute(event => events.push(event));
			expect(storage.sessions.pin(PROVIDER, "pinned", a!, restored ? { restoredAtMs: Date.now() } : undefined)).toBe(
				true,
			);
			expect(await storage.keys.get(PROVIDER, "pinned")).toBe("api-acct-a");
			storage.credentials.pause(PROVIDER, a!);
			expect(storage.oauth.identity(PROVIDER, "pinned")?.email).toBe("b@example.com");
			expect(await storage.keys.get(PROVIDER, "pinned")).toBe("api-acct-b");
			expect(await storage.keys.get(PROVIDER, "pinned")).toBe("api-acct-b");
			expect(events).toEqual([
				{ provider: PROVIDER, sessionId: "pinned", fromCredentialId: a!, toCredentialId: b!, reason: "paused" },
			]);
			unsubscribe();
		});
	}

	test("health.model excludes paused accounts", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const { b } = ids();
		storage.credentials.pause(PROVIDER, b!);
		usageCalls.length = 0;
		const health = await storage.health.model(PROVIDER, { modelId: "gpt-5.5", reserveFraction: 0.1 });
		expect(health.accounts.map(account => account.credentialId)).not.toContain(b);
		expect(usageCalls).not.toContain("acct-b");
	});

	test("usage.reports skips paused accounts unless includePaused is set", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		storage.credentials.pause(PROVIDER, ids().b!);
		usageCalls.length = 0;
		await storage.usage.reports();
		expect(usageCalls).toContain("acct-a");
		expect(usageCalls).not.toContain("acct-b");
		await storage.usage.reports({ includePaused: true });
		expect(usageCalls).toContain("acct-b");
	});

	test("resets.list with autoSelectableOnly never resolves a paused account", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const { a, b } = ids();
		storage.credentials.pause(PROVIDER, b!);
		const automatic = await storage.resets.list({ provider: PROVIDER, autoSelectableOnly: true });
		expect(automatic.map(entry => entry.credentialId)).toEqual([a!]);
		expect(apiKeyCalls).not.toContain("acct-b");
		const explicit = await storage.resets.list({ provider: PROVIDER });
		expect(explicit.map(entry => entry.credentialId)).toEqual([a!, b!]);
	});

	test("logging in again as a paused identity keeps the pause and says so", async () => {
		const provider = "unit-pause-login";
		let access = "access-login-1";
		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit Pause Login",
			sourceId: "auth-storage-account-pause-test",
			login: async () => ({
				access,
				refresh: "refresh-login",
				expires: Date.now() + HOUR_MS,
				email: "login@example.com",
			}),
			refreshToken: async credentials => credentials,
		});
		try {
			const first = await storage.oauth.login(provider, { onAuth: () => {}, onPrompt: async () => "" });
			expect(first?.paused).toBeUndefined();
			const [account] = storage.oauth.accounts(provider);
			storage.credentials.pause(provider, account!.credentialId);
			access = "access-login-2";
			const second = await storage.oauth.login(provider, { onAuth: () => {}, onPrompt: async () => "" });
			expect(second?.paused).toBe(true);
			const [after] = storage.oauth.accounts(provider);
			expect(after?.credentialId).toBe(account!.credentialId);
			expect(after?.paused).toBe(true);
		} finally {
			oauthUtils.unregisterOAuthProviders("auth-storage-account-pause-test");
		}
	});

	test("a pause in one process is honored by another store's next resolution without reload", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const other = await AuthStorage.create(dbPath, options());
		try {
			await other.credentials.reload();
			const { a } = ids();
			storage.credentials.pause(PROVIDER, a!);
			for (let index = 0; index < 8; index += 1) {
				expect(await other.keys.get(PROVIDER, `cross-${index}`)).toBe("api-acct-b");
			}
			expect(other.credentials.isAutoSelectable(PROVIDER, a!)).toBe(false);
		} finally {
			other.close();
		}
	});

	test("usage reports and reset listing in another store see a fresh pause", async () => {
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const other = await AuthStorage.create(dbPath, options());
		try {
			await other.credentials.reload();
			const { a, b } = ids();
			storage.credentials.pause(PROVIDER, b!);
			usageCalls.length = 0;
			await other.usage.reports();
			expect(usageCalls).not.toContain("acct-b");
			const listed = await other.resets.list({ provider: PROVIDER, autoSelectableOnly: true });
			expect(listed.map(entry => entry.credentialId)).toEqual([a!]);
		} finally {
			other.close();
		}
	});

	test("all paused fails closed without env, login key, or stored key fallback", async () => {
		await storage.credentials.set(PROVIDER, [
			codexCredential("a"),
			codexCredential("b"),
			{ type: "api_key", key: "sk-login-key", source: "login" },
		]);
		const { a, b } = ids();
		storage.credentials.pause(PROVIDER, a!);
		storage.credentials.pause(PROVIDER, b!);
		await withEnv({ OPENAI_CODEX_OAUTH_TOKEN: "env-token" }, async () => {
			const error = await expectPoolError(storage.keys.get(PROVIDER, "all-paused"), "all_paused");
			expect(error.provider).toBe(PROVIDER);
			expect(error.message).toContain("omp auth resume");
			await expectPoolError(storage.oauth.access(PROVIDER, "all-paused"), "all_paused");
			expect(await storage.keys.peek(PROVIDER)).toBeUndefined();
		});
		expect(apiKeyCalls).toEqual([]);
	});
});

class FakeBrokerClient {
	constructor(readonly current: SnapshotResponse) {}
	async fetchSnapshot(opts: { ifGenerationGt?: number } = {}): Promise<FetchSnapshotResult> {
		if (opts.ifGenerationGt !== undefined) return { status: 304, generation: this.current.generation };
		return { status: 200, snapshot: this.current, generation: this.current.generation };
	}
}

describe("broker-backed storage", () => {
	test("pause, resume, and restrict fail closed with broker_unsupported", async () => {
		const snapshot: SnapshotResponse = {
			generation: 1,
			generatedAt: Date.now(),
			serverNowMs: Date.now(),
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
			credentials: [
				{
					id: 7,
					provider: PROVIDER,
					credential: { ...codexCredential("broker"), refresh: REMOTE_REFRESH_SENTINEL },
					identityKey: "account:acct-broker",
					rotatesInMs: null,
				},
			],
		};
		const remote = new RemoteAuthCredentialStore({
			client: new FakeBrokerClient(snapshot) as unknown as AuthBrokerClient,
			initialSnapshot: snapshot,
			streamSnapshots: false,
			backgroundIdleMs: 0,
		});
		const storage = new AuthStorage(remote);
		try {
			await storage.credentials.reload();
			expect(storage.credentials.supportsPause()).toBe(false);
			expect(() => storage.credentials.pause(PROVIDER, 7)).toThrow(OAuthAccountPoolError);
			expect(() => storage.credentials.resume(PROVIDER, 7)).toThrow(OAuthAccountPoolError);
			expect(() => storage.oauth.restrict(PROVIDER, 7)).toThrow(OAuthAccountPoolError);
			try {
				storage.credentials.pause(PROVIDER, 7);
			} catch (error) {
				expect((error as OAuthAccountPoolError).code).toBe("broker_unsupported");
			}
			expect(storage.oauth.restriction(PROVIDER)).toBeUndefined();
		} finally {
			storage.close();
		}
	});
});
