import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiEmbedClient } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { TempDir } from "@oh-my-pi/pi-utils";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

function createSession(options: {
	agentKind: "main" | "sub";
	modelRegistry: ModelRegistry;
	ownedAsyncJobManager?: AsyncJobManager;
}): AgentSession {
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
	});
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: options.modelRegistry,
		agentKind: options.agentKind,
		ownedAsyncJobManager: options.ownedAsyncJobManager,
	});
}

describe("AgentSession shared worker ownership", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: TempDir;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-shared-worker-ownership-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	it("does not terminate process-global workers when a parked subagent disposes", async () => {
		const tinyTerminate = vi.spyOn(tinyTitleClient, "terminate").mockResolvedValue();
		const mnemopiTerminate = vi.spyOn(mnemopiEmbedClient, "terminate").mockResolvedValue();
		const subagent = createSession({ agentKind: "sub", modelRegistry });
		sessions.push(subagent);

		await subagent.dispose();

		expect(tinyTerminate).not.toHaveBeenCalled();
		expect(mnemopiTerminate).not.toHaveBeenCalled();
	});

	it("terminates process-global workers when their primary owner disposes", async () => {
		const tinyTerminate = vi.spyOn(tinyTitleClient, "terminate").mockResolvedValue();
		const mnemopiTerminate = vi.spyOn(mnemopiEmbedClient, "terminate").mockResolvedValue();
		const owner = createSession({
			agentKind: "main",
			ownedAsyncJobManager: new AsyncJobManager({ onJobComplete: async () => {} }),
			modelRegistry,
		});
		sessions.push(owner);

		await owner.dispose();

		expect(tinyTerminate).toHaveBeenCalledTimes(1);
		expect(mnemopiTerminate).toHaveBeenCalledTimes(1);
	});
});
