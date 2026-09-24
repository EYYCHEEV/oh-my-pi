import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Component } from "@oh-my-pi/pi-tui";
import { SessionAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-account-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { toSessionPinAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as piAi from "@oh-my-pi/pi-ai";
import * as loginDialog from "@oh-my-pi/pi-tui/overlays/login-dialog";
import * as logoutAccountSelector from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import * as oauthSelector from "@oh-my-pi/pi-tui/overlays/oauth-selector";

// `bun test` cannot resolve the controller's lazy `require()` boundary once the
// controller graph (via cli/git-tui) is loaded; re-register the real modules
// under the exact specifiers `loadProviderAuthUi` requires.
mock.module("@oh-my-pi/pi-ai/index.js", () => piAi);
mock.module("@oh-my-pi/pi-ai/registry/oauth/index.js", () => oauthUtils);
mock.module("@oh-my-pi/pi-tui/overlays/login-dialog.js", () => loginDialog);
mock.module("@oh-my-pi/pi-tui/overlays/logout-account-selector.js", () => logoutAccountSelector);
mock.module("@oh-my-pi/pi-tui/overlays/oauth-selector.js", () => oauthSelector);

const PROVIDER = "openai-codex";
const PAUSED_PIN_MESSAGE = "b@example.com is paused; resume it with /login manage first.";

function codexCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-token-${suffix}`,
		refresh: `refresh-token-${suffix}`,
		expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
		accountId: `acct-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("paused OAuth accounts in a live session", () => {
	let tempDir: TempDir | undefined;
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage;
	let session: AgentSession | undefined;
	let notices: { level: string; message: string; source?: string }[];
	let ids: Record<string, number>;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-account-pause-notice-");
		store = await SqliteAuthCredentialStore.open(tempDir.join("agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		ids = Object.fromEntries(
			storage.oauth
				.accounts(PROVIDER)
				.map(account => [account.accountId!.replace("acct-", ""), account.credentialId]),
		);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[PROVIDER] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});
		const model = getBundledModel(PROVIDER, "gpt-5.6-sol");
		if (!model) throw new Error("Expected bundled Codex model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(storage, tempDir.join("models.yml")),
		});
		notices = [];
		session.subscribe(event => {
			if (event.type === "notice")
				notices.push({ level: event.level, message: event.message, source: event.source });
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
		store?.close();
		store = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("turns this session's reroute into exactly one warning naming both accounts", async () => {
		const sessionId = session!.sessionId;
		expect(storage.sessions.pin(PROVIDER, sessionId, ids.a!)).toBe(true);
		expect(await storage.keys.get(PROVIDER, sessionId)).toBe("api-acct-a");

		storage.credentials.pause(PROVIDER, ids.a!);
		expect(await storage.keys.get(PROVIDER, sessionId)).toBe("api-acct-b");
		expect(await storage.keys.get(PROVIDER, sessionId)).toBe("api-acct-b");

		expect(notices).toEqual([
			{
				level: "warning",
				message:
					"a@example.com is paused; this session switched to b@example.com for openai-codex. Resume it with /login manage.",
				source: "oauth-account-pause",
			},
		]);
	});

	it("ignores reroutes of other sessions and follows the current session id after a switch", async () => {
		const original = session!.sessionId;
		expect(storage.sessions.pin(PROVIDER, "someone-else", ids.a!)).toBe(true);
		expect(storage.sessions.pin(PROVIDER, original, ids.a!)).toBe(true);
		await session!.newSession();
		const current = session!.sessionId;
		expect(current).not.toBe(original);
		expect(storage.sessions.pin(PROVIDER, current, ids.a!)).toBe(true);

		storage.credentials.pause(PROVIDER, ids.a!);
		await storage.keys.get(PROVIDER, "someone-else");
		await storage.keys.get(PROVIDER, original);
		expect(notices).toEqual([]);

		await storage.keys.get(PROVIDER, current);
		expect(notices.map(notice => notice.source)).toEqual(["oauth-account-pause"]);
	});

	it("refuses to pin a paused account through the session API", () => {
		storage.credentials.pause(PROVIDER, ids.b!);
		expect(session!.pinCurrentProviderOAuthAccount(ids.b!)).toBe(false);
		expect(session!.pinCurrentProviderOAuthAccount(ids.a!)).toBe(true);
	});

	it("refuses a paused account on the /session pin path and points to /login manage", async () => {
		storage.credentials.pause(PROVIDER, ids.b!);
		const statuses: string[] = [];
		const ctx = {
			session,
			editor: { setText: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			showStatus: (text: string) => statuses.push(text),
		} as unknown as InteractiveModeContext;

		await executeBuiltinSlashCommand("/session pin 2", { ctx } as never);
		await executeBuiltinSlashCommand("/session pin b@example.com", { ctx } as never);

		expect(statuses).toEqual([PAUSED_PIN_MESSAGE, PAUSED_PIN_MESSAGE]);
		expect(storage.oauth.accounts(PROVIDER, session!.sessionId).find(account => account.active)).toBeUndefined();
	});

	it("refuses a paused account on the interactive selector path and marks it", async () => {
		storage.credentials.pause(PROVIDER, ids.b!);
		let selector: Component | undefined;
		const ctx = {
			session,
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
		controller.showSelector = create => {
			selector = create(() => {}).component;
		};

		await controller.showSessionPinSelector();
		expect(selector).toBeInstanceOf(SessionAccountSelectorComponent);
		const rendered = selector!
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("b@example.com (paused)");

		selector!.handleInput?.("\u001b[B");
		selector!.handleInput?.("\n");
		expect(ctx.showWarning).toHaveBeenCalledWith(PAUSED_PIN_MESSAGE);
		expect(storage.oauth.accounts(PROVIDER, session!.sessionId).find(account => account.active)).toBeUndefined();
	});

	it("marks paused accounts in session pin rows", () => {
		storage.credentials.pause(PROVIDER, ids.b!);
		const rows = toSessionPinAccounts(storage.oauth.accounts(PROVIDER));
		expect(rows.map(row => [row.label, row.paused])).toEqual([
			["a@example.com", false],
			["b@example.com", true],
		]);
	});
});
