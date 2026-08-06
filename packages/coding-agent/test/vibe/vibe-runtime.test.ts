import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

describe("vibe parent instruction context", () => {
	let manager: AsyncJobManager;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
		manager = new AsyncJobManager({ onJobComplete: () => {} });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.dispose({ timeoutMs: 1000 });
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("inherits the parent's resolved instruction context when spawning a persistent worker", async () => {
		let dispatched: Parameters<typeof executorModule.runSubprocess>[0] | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched = options;
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: { dispose: async () => {} } as unknown as AgentSession,
				status: "idle",
			});
			return {
				index: 0,
				id: options.id,
				agent: "task",
				agentSource: "bundled",
				task: options.task,
				exitCode: 0,
				output: "All done.",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			} satisfies SingleResult;
		});

		const session = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionId: () => "vibe-test-parent",
			getAgentId: () => "Main",
			getArtifactsDir: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
		} as ToolSession;
		const contextFiles = [{ path: "/tmp/AGENTS.md", content: "# Parent policy" }];
		const appendSystemPrompt = "Parent outcome policy";
		session.contextFiles = contextFiles;
		session.appendSystemPrompt = appendSystemPrompt;

		const { jobId } = await VibeSessionRegistry.global().spawn(session, {
			cli: "fast",
			name: "Fast",
			prompt: "Build it.",
		});
		await manager.getJob(jobId)!.promise;

		expect(dispatched?.contextFiles).toBe(contextFiles);
		expect(dispatched?.appendSystemPrompt).toBe(appendSystemPrompt);
	});
});
