import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession cache-warming runtime admission", () => {
	let authStorage: AuthStorage;
	let tempDir: TempDir;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-cache-warming-runtime-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	});

	afterEach(async () => {
		vi.useRealTimers();
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	it.each([false, true])("checks required runtime attachment before idle replay (required=%s)", async required => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const model = {
			...bundled,
			promptCache: { short: 300, long: 3600 },
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		};
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const warmer = new CacheWarmer({
			stream: mock.stream,
			getPromptTokens: () => 100_000,
			getMode: () => "idle",
		});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "providers.cacheWarming": "idle" }),
			modelRegistry: new ModelRegistry(authStorage),
			cacheWarmer: warmer,
			...(required
				? {
						requiredRuntimeExtensions: [
							{ path: tempDir.join("missing-runtime.ts"), id: "required-runtime", version: 1 },
						],
					}
				: {}),
		});

		vi.useFakeTimers();
		warmer.start({ model, context: { messages: [] }, options: { cacheRetention: "short" } }, () => true);
		vi.advanceTimersByTime(270_000);
		for (let i = 0; i < 100; i++) await Promise.resolve();

		expect(mock.calls).toHaveLength(required ? 0 : 1);
		expect(warmer.status.state).toBe("inactive");
	});
});
