import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, SqliteAuthCredentialStore, type UsageReport } from "@oh-my-pi/pi-ai";
import { resetOAuthAccountRestrictions } from "@oh-my-pi/pi-ai/auth/eligibility";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveCodexDiscoveryAccounts } from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { selectSecurityAuth, selectSecurityOAuthAccount } from "@oh-my-pi/pi-coding-agent/security/auth";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { OAuthAccountSummary } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { createCodexAutoRedeemCoordinator } from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "openai-codex";

function codexCredential(suffix: string, expires = Date.now() + 7 * 24 * 60 * 60 * 1000) {
	return {
		type: "oauth" as const,
		access: `access-token-${suffix}`,
		refresh: `refresh-token-${suffix}`,
		expires,
		accountId: `acct-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("automatic OAuth readers skip paused accounts", () => {
	let tempDir: TempDir | undefined;
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage;
	let ids: Record<string, number>;
	let resolved: string[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-pool-readers-");
		store = await SqliteAuthCredentialStore.open(tempDir.join("agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		ids = Object.fromEntries(
			storage.oauth
				.accounts(PROVIDER)
				.map(account => [account.accountId!.replace("acct-", ""), account.credentialId]),
		);
		resolved = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[PROVIDER] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			resolved.push(credential.accountId);
			if (credential.accountId === "acct-b") throw new Error("refresh failed for b");
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetOAuthAccountRestrictions();
		store?.close();
		store = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("Codex model discovery never resolves a paused account, so its failure cannot freeze discovery", async () => {
		storage.credentials.pause(PROVIDER, ids.b!);
		const accounts = await resolveCodexDiscoveryAccounts(storage, "api-acct-a");
		expect(accounts).not.toBeNull();
		expect(accounts!.map(account => account.accountId)).toEqual(["acct-a"]);
		expect(resolved).not.toContain("acct-b");
	});

	it("Codex model discovery sees a pause written by another store", async () => {
		const other = new AuthStorage(await SqliteAuthCredentialStore.open(tempDir!.join("agent.db")));
		try {
			await other.credentials.reload();
			other.credentials.pause(PROVIDER, ids.b!);
			const accounts = await resolveCodexDiscoveryAccounts(storage, "api-acct-a");
			expect(accounts?.map(account => account.accountId)).toEqual(["acct-a"]);
			expect(resolved).not.toContain("acct-b");
		} finally {
			other.close();
		}
	});
});

describe("security scan account auto-selection", () => {
	const model = () => {
		const value = getBundledModel(PROVIDER, "gpt-5.6-sol");
		if (!value) throw new Error("Expected bundled Codex model");
		return value;
	};
	const fake = (accounts: OAuthAccountSummary[]) =>
		({ oauth: { accounts: () => accounts } }) as unknown as AuthStorage;

	it("skips paused and restriction-excluded accounts when it picks one itself", () => {
		const accounts: OAuthAccountSummary[] = [
			{ position: 0, credentialId: 1, accountId: "acct-a", active: false, paused: true, excluded: "paused" },
			{ position: 1, credentialId: 2, accountId: "acct-b", active: false, paused: false },
			{ position: 2, credentialId: 3, accountId: "acct-c", active: false, paused: false, excluded: "restricted" },
		];
		expect(selectSecurityAuth(fake(accounts), model())).toEqual({
			provider: PROVIDER,
			credentialId: 2,
			accountId: "acct-b",
		});
		expect(selectSecurityOAuthAccount(fake(accounts), PROVIDER).credentialId).toBe(2);
	});

	it("ignores a paused sticky account", () => {
		const accounts: OAuthAccountSummary[] = [
			{ position: 0, credentialId: 1, accountId: "acct-a", active: true, paused: true, excluded: "paused" },
			{ position: 1, credentialId: 2, accountId: "acct-b", active: false, paused: false },
		];
		expect(selectSecurityOAuthAccount(fake(accounts), PROVIDER).credentialId).toBe(2);
	});

	it("refuses an explicit id the launch restriction excludes", () => {
		const accounts: OAuthAccountSummary[] = [
			{ position: 0, credentialId: 1, accountId: "acct-a", active: false, paused: false, excluded: "restricted" },
			{ position: 1, credentialId: 2, accountId: "acct-b", active: false, paused: false },
		];
		expect(() => selectSecurityOAuthAccount(fake(accounts), PROVIDER, 1)).toThrow("--oauth-account");
	});

	it("fails clearly when every account is paused", () => {
		const accounts: OAuthAccountSummary[] = [
			{ position: 0, credentialId: 1, accountId: "acct-a", active: false, paused: true, excluded: "paused" },
		];
		expect(() => selectSecurityOAuthAccount(fake(accounts), PROVIDER)).toThrow("/login manage");
	});
});

describe("session usage and reset readers", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	async function createSession() {
		tempDir = TempDir.createSync("@omp-pool-session-readers-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const model = getBundledModel(PROVIDER, "gpt-5.6-sol");
		if (!model) throw new Error("Expected bundled Codex model");
		const coordinator = createCodexAutoRedeemCoordinator();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"codexResets.autoRedeem": "yes",
				"codexResets.salvageHorizonHours": 24,
			}),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			codexResetCoordinator: coordinator,
		});
		return { session, authStorage, coordinator };
	}

	const codexReport: UsageReport = { provider: PROVIDER, fetchedAt: Date.now(), limits: [] };

	it("keeps paused accounts out of automatic usage polling and the salvage sweep", async () => {
		const { session, authStorage, coordinator } = await createSession();
		const reports = vi.spyOn(authStorage.usage, "reports").mockResolvedValue([codexReport]);
		const list = vi.spyOn(authStorage.resets, "list").mockResolvedValue([]);

		await session.fetchUsageReports();
		await coordinator.sweepPromise;

		expect(reports).toHaveBeenCalledTimes(1);
		expect(reports.mock.calls[0]?.[0]?.includePaused).toBeFalsy();
		expect(list).toHaveBeenCalled();
		for (const call of list.mock.calls) expect(call[0]?.autoSelectableOnly).toBe(true);
	});

	it("lets explicit /usage surfaces include paused accounts", async () => {
		const { session, authStorage } = await createSession();
		const reports = vi.spyOn(authStorage.usage, "reports").mockResolvedValue(null);

		await session.fetchUsageReports(undefined, { includePaused: true });
		expect(reports.mock.calls[0]?.[0]?.includePaused).toBe(true);

		const fetchUsageReports = vi.fn(async () => null);
		await buildUsageReportText({
			session: { fetchUsageReports, model: undefined },
			sessionManager: { getUsageStatistics: () => undefined },
		} as unknown as SlashCommandRuntime).catch(() => undefined);
		expect(fetchUsageReports).toHaveBeenCalledWith(undefined, { includePaused: true });
	});

	it("keeps the explicit /usage reset listing unfiltered", async () => {
		const { session, authStorage } = await createSession();
		const list = vi.spyOn(authStorage.resets, "list").mockResolvedValue([]);
		await session.listResetCredits(undefined, PROVIDER);
		expect(list.mock.calls[0]?.[0]?.autoSelectableOnly).toBeUndefined();
	});
});
