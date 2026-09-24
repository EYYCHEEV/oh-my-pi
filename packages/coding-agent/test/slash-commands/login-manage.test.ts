import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { AccountPauseSelectorComponent } from "@oh-my-pi/pi-tui/overlays/account-pause-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { OAuthManualInputManager } from "@oh-my-pi/pi-coding-agent/modes/oauth-manual-input";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { ACCOUNT_PAUSE_BROKER_MESSAGE } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/account-pause";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as piAi from "@oh-my-pi/pi-ai";
import * as oauthRegistry from "@oh-my-pi/pi-ai/registry/oauth";
import * as loginDialog from "@oh-my-pi/pi-tui/overlays/login-dialog";
import * as logoutAccountSelector from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import * as oauthSelector from "@oh-my-pi/pi-tui/overlays/oauth-selector";

// `bun test` cannot resolve the controller's lazy `require()` boundary once the
// controller graph (via cli/git-tui) is loaded; re-register the real modules
// under the exact specifiers `loadProviderAuthUi` requires.
mock.module("@oh-my-pi/pi-ai/index.js", () => piAi);
mock.module("@oh-my-pi/pi-ai/registry/oauth/index.js", () => oauthRegistry);
mock.module("@oh-my-pi/pi-tui/overlays/login-dialog.js", () => loginDialog);
mock.module("@oh-my-pi/pi-tui/overlays/logout-account-selector.js", () => logoutAccountSelector);
mock.module("@oh-my-pi/pi-tui/overlays/oauth-selector.js", () => oauthSelector);

type SelectorMode = "login" | "logout" | "manage";

function createSlashHarness(manualInput: OAuthManualInputManager) {
	const calls: { mode: SelectorMode; provider?: string }[] = [];
	const ctx = {
		oauthManualInput: manualInput,
		editor: { setText: () => {} } as unknown as InteractiveModeContext["editor"],
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showOAuthSelector: async (mode: SelectorMode, provider?: string) => {
			calls.push({ mode, provider });
		},
	} as unknown as InteractiveModeContext;
	return { runtime: { ctx }, calls };
}

describe("/login manage routing", () => {
	it("opens the manage flow without consuming a pending manual callback", async () => {
		const manualInput = new OAuthManualInputManager();
		const pending = manualInput.waitForInput("openai-codex");
		const submit = vi.spyOn(manualInput, "submit");
		const harness = createSlashHarness(manualInput);

		expect(await executeBuiltinSlashCommand("/login manage", harness.runtime)).toBe(true);
		expect(await executeBuiltinSlashCommand("/login manage openai-codex", harness.runtime)).toBe(true);

		expect(harness.calls).toEqual([
			{ mode: "manage", provider: undefined },
			{ mode: "manage", provider: "openai-codex" },
		]);
		expect(submit).not.toHaveBeenCalled();
		expect(manualInput.hasPending()).toBe(true);
		void pending.catch(() => {});
		manualInput.clear("test done");
	});
});

const PROVIDER = "openai-codex";

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

function renderText(component: Component): string {
	return component
		.render(120)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

describe("SelectorController manage flow", () => {
	let tempDir: TempDir | undefined;
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-login-manage-");
		store = await SqliteAuthCredentialStore.open(tempDir.join("agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	function createControllerHarness(authStorage: unknown, sessionId = "manage-session") {
		let component: Component | undefined;
		let closed = 0;
		const ctx = {
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			statusLine: { invalidate: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			present: vi.fn(),
			session: {
				sessionId,
				modelRegistry: { authStorage, refreshProvider: vi.fn(async () => {}) },
			},
		};
		const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
		controller.showSelector = create => {
			component = create(() => {
				closed += 1;
			}).component;
		};
		return {
			ctx,
			controller,
			component: () => component,
			closed: () => closed,
		};
	}

	it("toggles pause and resume in place and warns about the serving account", async () => {
		const [a] = storage.oauth.accounts(PROVIDER);
		expect(storage.sessions.pin(PROVIDER, "manage-session", a!.credentialId)).toBe(true);
		const harness = createControllerHarness(storage);

		await harness.controller.showOAuthSelector("manage", PROVIDER);
		const selector = harness.component();
		expect(selector).toBeInstanceOf(AccountPauseSelectorComponent);
		expect(renderText(selector!)).toContain("a@example.com · Active (this session)");

		selector!.handleInput?.("\n");
		expect(storage.credentials.isAutoSelectable(PROVIDER, a!.credentialId)).toBe(false);
		expect(renderText(selector!)).toMatch(/a@example\.com · Paused since .+ \(this session\)/);
		expect(harness.ctx.showWarning).toHaveBeenCalledWith(
			"a@example.com was serving this session; the next openai-codex request switches to another account.",
		);

		selector!.handleInput?.("\n");
		expect(storage.credentials.isAutoSelectable(PROVIDER, a!.credentialId)).toBe(true);
		expect(renderText(selector!)).toContain("a@example.com · Active (this session)");

		selector!.handleInput?.("\u001b");
		expect(harness.closed()).toBe(1);
	});

	it("warns when the last active account is paused", async () => {
		const [, b] = storage.oauth.accounts(PROVIDER);
		storage.credentials.pause(PROVIDER, b!.credentialId);
		const harness = createControllerHarness(storage);

		await harness.controller.showOAuthSelector("manage", PROVIDER);
		harness.component()!.handleInput?.("\n");

		expect(harness.ctx.showWarning).toHaveBeenCalledWith(
			"Every openai-codex account is now paused; requests fail until you resume one with /login manage.",
		);
	});

	it("shows the broker message instead of the overlay", async () => {
		const brokerStorage = {
			credentials: { supportsPause: () => false, reload: vi.fn(async () => {}), has: () => true },
			oauth: { accounts: () => [] },
		};
		const harness = createControllerHarness(brokerStorage);

		await harness.controller.showOAuthSelector("manage", PROVIDER);
		await harness.controller.showOAuthSelector("manage");

		expect(harness.component()).toBeUndefined();
		expect(harness.ctx.showError).toHaveBeenCalledTimes(2);
		expect(harness.ctx.showError).toHaveBeenCalledWith(ACCOUNT_PAUSE_BROKER_MESSAGE);
	});

	it("says a re-logged-in account is still paused", async () => {
		const login = vi.fn(async () => ({ type: "oauth" as const, email: "a@example.com", paused: true as const }));
		const harness = createControllerHarness({
			oauth: { login },
			keys: { describe: () => undefined },
		});

		await harness.controller.showOAuthSelector("login", PROVIDER);

		expect(login).toHaveBeenCalledTimes(1);
		const block = harness.ctx.present.mock.calls[0]?.[0] as Component | undefined;
		expect(block).toBeDefined();
		const text = renderText(block!);
		expect(text).toContain("Successfully logged in to openai-codex as a@example.com");
		expect(text).toContain("This account is paused; resume it with /login manage.");
	});
});
