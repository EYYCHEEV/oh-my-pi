import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { resetOAuthAccountRestrictions } from "@oh-my-pi/pi-ai/auth/eligibility";
import {
	type AuthBrokerClient,
	type FetchSnapshotResult,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
} from "@oh-my-pi/pi-ai/auth-broker";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, setInteractiveHost, TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.6-sol";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

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

describe("--oauth-account parsing", () => {
	it("parses <provider>:<credential-id>", () => {
		const parsed = parseArgs(["--oauth-account", "openai-codex:17", "-p", "hi"]);
		expect(parsed.oauthAccount).toEqual({ provider: "openai-codex", credentialId: 17 });
		expect(parsed.print).toBe(true);
		expect(parsed.messages).toEqual(["hi"]);
	});

	it("rejects malformed values as usage errors", () => {
		for (const value of [
			"openai-codex",
			"openai-codex:",
			":17",
			"openai-codex:abc",
			"openai-codex:0",
			"openai-codex:1.5",
		]) {
			expect(() => parseArgs(["--oauth-account", value])).toThrow(CliUsageError);
		}
	});
});

describe("--oauth-account startup", () => {
	let tempDir: TempDir | undefined;
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage;
	let ids: Record<string, number>;
	let previousAgentDir: string;
	let previousInteractive: boolean;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-oauth-account-flag-");
		previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		previousInteractive = setInteractiveHost(false);
		store = await SqliteAuthCredentialStore.open(tempDir.join("agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		ids = Object.fromEntries(
			storage.oauth
				.accounts(PROVIDER)
				.map(account => [account.accountId!.replace("acct-", ""), account.credentialId]),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetOAuthAccountRestrictions();
		setInteractiveHost(previousInteractive);
		setAgentDir(previousAgentDir);
		store?.close();
		store = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	async function launch(
		args: string[],
		authStorage: AuthStorage = storage,
	): Promise<{ exitCodes: number[]; stderr: string; sessionCreated: boolean; thrown: unknown }> {
		const parsed = parseArgs(args);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir!.path();
		const exitCodes: number[] = [];
		let stderr = "";
		let sessionCreated = false;
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new ProcessExitSignal(code ?? 0);
		}) as typeof process.exit);
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		});
		// Print mode reads a non-TTY stdin to EOF as prompt text; runners that keep
		// stdin open (CI, agent harnesses) would block startup. Present a TTY.
		const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		let thrown: unknown;
		try {
			await runRootCommand(parsed, args, {
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
				createAgentSession: async () => {
					sessionCreated = true;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			thrown = error;
		} finally {
			vi.restoreAllMocks();
			if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
			else Reflect.deleteProperty(process.stdin, "isTTY");
		}
		return { exitCodes, stderr, sessionCreated, thrown };
	}

	it("restricts the process to the target and reaches session creation", async () => {
		const result = await launch([
			"--oauth-account",
			`${PROVIDER}:${ids.b}`,
			"--model",
			`${PROVIDER}/${MODEL_ID}`,
			"-p",
			"hi",
		]);
		expect((result.thrown as Error | undefined)?.message).toBe("stop after session options");
		expect(result.exitCodes).toEqual([]);
		expect(result.sessionCreated).toBe(true);
		expect(storage.oauth.restriction(PROVIDER)).toBe(ids.b);
	});

	it("exits before any model call for a missing credential id", async () => {
		const missing = Math.max(ids.a!, ids.b!) + 50;
		const result = await launch(["--oauth-account", `${PROVIDER}:${missing}`, "-p", "hi"]);
		expect(result.exitCodes).toEqual([1]);
		expect(result.sessionCreated).toBe(false);
		expect(result.stderr).toContain(`${PROVIDER}:${missing}`);
		expect(storage.oauth.restriction(PROVIDER)).toBeUndefined();
	});

	it("exits for a disabled credential id", async () => {
		expect(await storage.credentials.disable(ids.a!, "test disabled")).toBe(true);
		const result = await launch(["--oauth-account", `${PROVIDER}:${ids.a}`, "-p", "hi"]);
		expect(result.exitCodes).toEqual([1]);
		expect(result.sessionCreated).toBe(false);
	});

	it("exits in broker mode", async () => {
		const snapshot: SnapshotResponse = {
			generation: 1,
			generatedAt: Date.now(),
			serverNowMs: Date.now(),
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
			credentials: [],
		};
		const client = {
			async fetchSnapshot(): Promise<FetchSnapshotResult> {
				return { status: 200, snapshot, generation: 1 };
			},
		};
		const brokerStorage = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: client as unknown as AuthBrokerClient,
				initialSnapshot: snapshot,
				streamSnapshots: false,
				backgroundIdleMs: 0,
			}),
		);
		try {
			const result = await launch(["--oauth-account", `${PROVIDER}:7`, "-p", "hi"], brokerStorage);
			expect(result.exitCodes).toEqual([1]);
			expect(result.sessionCreated).toBe(false);
			expect(result.stderr).toContain("auth broker");
		} finally {
			brokerStorage.close();
		}
	});

	it("exits when --api-key overrides the restricted provider", async () => {
		const result = await launch([
			"--oauth-account",
			`${PROVIDER}:${ids.a}`,
			"--model",
			`${PROVIDER}/${MODEL_ID}`,
			"--api-key",
			"sk-runtime-override",
			"-p",
			"hi",
		]);
		expect(result.exitCodes).toEqual([1]);
		expect(result.sessionCreated).toBe(false);
		expect(result.stderr).toContain("--api-key");
		expect(result.stderr).not.toContain("sk-runtime-override");
	});

	it("exits when models.yml sets an apiKey for the restricted provider", async () => {
		await Bun.write(tempDir!.join("models.yml"), `providers:\n  ${PROVIDER}:\n    apiKey: sk-config-override\n`);
		const result = await launch([
			"--oauth-account",
			`${PROVIDER}:${ids.a}`,
			"--model",
			`${PROVIDER}/${MODEL_ID}`,
			"-p",
			"hi",
		]);
		expect(result.exitCodes).toEqual([1]);
		expect(result.sessionCreated).toBe(false);
		expect(result.stderr).toContain("models.yml");
		expect(result.stderr).not.toContain("sk-config-override");
	});
});

describe("restricted usage-limit recovery", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("fails fast without waiting or falling back to another provider", async () => {
		const primary = getBundledModel(PROVIDER, MODEL_ID);
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled models");
		tempDir = TempDir.createSync("@omp-restricted-usage-limit-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		// The restriction itself is stubbed below; a runtime key just lets the turn dispatch.
		authStorage.keys.setRuntime(PROVIDER, "codex-test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		vi.spyOn(authStorage.oauth, "restriction").mockImplementation(provider =>
			provider === PROVIDER ? 17 : undefined,
		);
		const markReached = vi.spyOn(authStorage.limits, "markReached").mockResolvedValue({ switched: false });

		const requested: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				if (model.provider === PROVIDER) {
					mock.push({ throw: "You've hit your usage limit. Try again in 3 hours." });
				} else {
					mock.push({ content: ["fallback ok"] });
				}
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 3,
				"retry.modelFallback": true,
				"retry.waitForUsageReset": true,
				"retry.fallbackChains": { [`${PROVIDER}/${MODEL_ID}`]: ["openai/gpt-4o-mini"] },
			}),
			modelRegistry,
		});
		const retryEnds: Extract<AgentSessionEvent, { type: "auto_retry_end" }>[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});

		await session.prompt("probe");
		await session.waitForIdle();

		expect(markReached).toHaveBeenCalled();
		expect(requested).toEqual([`${PROVIDER}/${MODEL_ID}`]);
		expect(session.model?.provider).toBe(PROVIDER);
		expect(retryEnds.at(-1)?.success).toBe(false);
		expect(retryEnds.at(-1)?.finalError).toContain("--oauth-account");
		const last = session.messages.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") expect(last.errorMessage).toContain("--oauth-account");
	}, 20_000);
});
