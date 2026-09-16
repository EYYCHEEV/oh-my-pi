import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

function activeGoalState(): GoalModeState {
	const now = Date.now();
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: "goal-midrun-compaction",
			objective: "Ship the release",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		},
	};
}

function highUsage(input: number, output = 100) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
// These tests await real cross-pipeline concurrency signals; fake timers cannot
// drive those queues. Keep a failure-only watchdog, and cancel it as soon as
// the signal wins so successful cases never leave a wall-clock delay behind.
async function raceWithTimeout<T, F>(promise: Promise<T>, timeoutMs: number, timeoutValue: F): Promise<T | F> {
	const timeout = Promise.withResolvers<F>();
	const timer = setTimeout(() => timeout.resolve(timeoutValue), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("AgentSession mid-run threshold compaction", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-agent-goal-midrun-compaction-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-goal-midrun-compaction-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(
		settingsOverride: Record<string, unknown> = {},
		options: {
			extensionRunner?: ExtensionRunner;
			firstTurnUsageInput?: number;
			firstTurnUsageOutput?: number;
			contextWindow?: number;
			model?: Model;
			intentTracing?: boolean;
			providerErrorAt?: number;
			providerErrorStatus?: 400 | 503;
			withHistory?: boolean;
			onProviderCall?: (index: number) => void;
			onToolExecute?: () => void;
			configureAgent?: (agent: Agent) => void;
			transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
			toolOutput?: string;
			toolResultDetails?: unknown;
		} = {},
	): Promise<{
		session: AgentSession;
		observedContexts: string[][];
		sessionManager: SessionManager;
	}> {
		const observedContexts: string[][] = [];
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const model = options.model ?? { ...bundled, contextWindow: options.contextWindow ?? bundled.contextWindow };

		const modelRegistry = sharedModelRegistry;
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": true,
			"compaction.midTurnEnabled": true,
			"compaction.thresholdTokens": 1000,
			"compaction.thresholdPercent": -1,
			"contextPromotion.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		if (options.withHistory) {
			sessionManager.appendMessage({
				role: "user",
				content: "Earlier completed request ".repeat(100),
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Earlier completed response ".repeat(100) }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: highUsage(100, 20),
				stopReason: "stop",
				timestamp: Date.now(),
			});
		}

		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => {
				options.onToolExecute?.();
				return {
					content: [{ type: "text" as const, text: options.toolOutput ?? "tool output" }],
					...(options.toolResultDetails === undefined ? {} : { details: options.toolResultDetails }),
				};
			},
		};

		let call = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			intentTracing: options.intentTracing,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [mockBashTool],
				messages: sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			transformContext: options.transformContext,
			streamFn: (_model, context) => {
				const index = call++;
				options.onProviderCall?.(index);
				observedContexts.push(context.messages.map(message => JSON.stringify(message)));
				const stream = new AssistantMessageEventStream();
				const isToolTurn = index === 0;
				const message =
					options.providerErrorAt === index
						? {
								role: "assistant" as const,
								content: [],
								api: "anthropic-messages" as const,
								provider: "anthropic" as const,
								model: "claude-sonnet-4-5",
								usage: highUsage(0, 0),
								stopReason: "error" as const,
								errorStatus: options.providerErrorStatus ?? 400,
								errorMessage:
									options.providerErrorStatus === 503
										? "503 service unavailable: overloaded_error"
										: "400 litellm.BadRequestError: OpenAIException - rendered input exceeds configured limit. Received Model Group=deepseek-v4-flash-vision-exp Available Model Group Fallbacks=None",
								timestamp: Date.now(),
							}
						: isToolTurn
							? {
									role: "assistant" as const,
									content: [
										{ type: "toolCall" as const, id: `tc-${index}`, name: "bash", arguments: { cmd: "pwd" } },
									],
									api: "anthropic-messages" as const,
									provider: "anthropic" as const,
									model: "claude-sonnet-4-5",
									usage: highUsage(options.firstTurnUsageInput ?? 50_000, options.firstTurnUsageOutput),
									stopReason: "toolUse" as const,
									timestamp: Date.now(),
								}
							: {
									role: "assistant" as const,
									content: [{ type: "text" as const, text: "All done." }],
									api: "anthropic-messages" as const,
									provider: "anthropic" as const,
									model: "claude-sonnet-4-5",
									usage: highUsage(200),
									stopReason: "stop" as const,
									timestamp: Date.now(),
								};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (message.stopReason === "error") {
						stream.push({ type: "error", reason: "error", error: message });
					} else {
						stream.push({ type: "done", reason: message.stopReason, message });
					}
				});
				return stream;
			},
		});
		options.configureAgent?.(agent);

		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[mockBashTool.name, mockBashTool]]),
			extensionRunner: options.extensionRunner,
		});

		cleanups.push(() => session.dispose());
		return { session, sessionManager, observedContexts };
	}

	function mockCompaction(summary: string, onCompact?: () => void) {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			onCompact?.();
			return {
				summary,
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});
	}

	function collectPreparedBudgetWarnings(session: AgentSession): string[] {
		const warnings: string[] = [];
		session.subscribe(event => {
			if (
				event.type === "notice" &&
				event.level === "warning" &&
				event.source === "compaction" &&
				event.message.includes("usable budget")
			) {
				warnings.push(event.message);
			}
		});
		return warnings;
	}

	it("compacts in place between tool-call turns outside goal mode", async () => {
		const { session, observedContexts } = await createHarness();
		const compactSpy = mockCompaction("MID-RUN-COMPACTED");

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		expect(observedContexts[1].join("\n")).toContain("MID-RUN-COMPACTED");
	});

	it("runs overflow maintenance for a trailing tool result before the next provider request", async () => {
		const onProviderCall = vi.fn();
		const onToolExecute = vi.fn();
		const runAutoSpy = vi.spyOn(SessionMaintenance.prototype, "runAutoCompaction");
		const toolOutput = "large tool result ".repeat(500);
		const { session, observedContexts } = await createHarness(
			{ "compaction.asyncEnabled": true, "compaction.thresholdTokens": 51_000 },
			{
				firstTurnUsageInput: 50_000,
				onProviderCall,
				onToolExecute,
				toolOutput,
			},
		);

		await session.prompt("process the large tool result");

		expect(onProviderCall).toHaveBeenNthCalledWith(1, 0);
		expect(onProviderCall).toHaveBeenNthCalledWith(2, 1);
		expect(runAutoSpy).toHaveBeenCalledTimes(1);
		expect(onProviderCall.mock.invocationCallOrder[0]).toBeLessThan(onToolExecute.mock.invocationCallOrder[0]);
		expect(onToolExecute.mock.invocationCallOrder[0]).toBeLessThan(runAutoSpy.mock.invocationCallOrder[0]);
		expect(runAutoSpy.mock.invocationCallOrder[0]).toBeLessThan(onProviderCall.mock.invocationCallOrder[1]);
		expect(await runAutoSpy.mock.results[0]?.value).toMatchObject({ historyRewritten: true });
		expect(observedContexts[1].join("\n")).not.toContain(toolOutput);
	});

	it("compacts before sending when the prior response already filled the reserved input budget", async () => {
		const { session, observedContexts } = await createHarness(
			{
				"compaction.asyncEnabled": true,
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 65_536,
				"compaction.keepRecentTokens": 20_000,
			},
			{
				withHistory: true,
				contextWindow: 272_384,
				firstTurnUsageInput: 206_291,
				firstTurnUsageOutput: 571,
			},
		);
		mockCompaction("RESERVE-SAFE-CONTEXT");

		await session.prompt("continue without spending the output reserve");

		expect(observedContexts).toHaveLength(2);
		expect(observedContexts[1].some(message => message.includes("RESERVE-SAFE-CONTEXT"))).toBe(true);
	});

	it("does not count unchanged normalized tool schemas twice near the input budget", async () => {
		const { session, observedContexts } = await createHarness(
			{
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 65_536,
			},
			{
				contextWindow: 272_384,
				firstTurnUsageInput: 206_738,
				firstTurnUsageOutput: 100,
				intentTracing: true,
				toolOutput: "ok",
			},
		);
		const compactSpy = mockCompaction("must not compact");

		await session.prompt("continue with the same tool schema");

		expect(observedContexts).toHaveLength(2);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("compacts and retries when a previously shrinking transform stops removing history", async () => {
		let transforms = 0;
		const { session, observedContexts } = await createHarness(
			{ "compaction.thresholdTokens": -1, "compaction.reserveTokens": 65_536 },
			{
				withHistory: true,
				contextWindow: 272_384,
				firstTurnUsageInput: 206_738,
				firstTurnUsageOutput: 100,
				toolOutput: "ok",
				transformContext: async messages => (transforms++ === 0 ? messages.slice(-1) : messages),
			},
		);
		const compactSpy = mockCompaction("PREPARED-BUDGET-RECOVERED");
		const refusalWarnings = collectPreparedBudgetWarnings(session);

		await session.prompt("recover after the transform restores history");

		expect(transforms).toBe(3);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts).toHaveLength(2);
		expect(observedContexts[1].join("\n")).toContain("PREPARED-BUDGET-RECOVERED");
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(refusalWarnings).toHaveLength(0);
	});

	it("persists one prepared-budget refusal after a real recovery rewrite cannot make the next request fit", async () => {
		let transforms = 0;
		const oversized = "persistent prepared growth ".repeat(10_000);
		const { session, sessionManager, observedContexts } = await createHarness(
			{
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 1_000,
				"compaction.keepRecentTokens": 100,
			},
			{
				withHistory: true,
				contextWindow: 8_192,
				firstTurnUsageInput: 100,
				firstTurnUsageOutput: 20,
				toolOutput: "ok",
				transformContext: async messages =>
					transforms++ === 0
						? messages.slice(-1)
						: [...messages, { role: "user", content: oversized, timestamp: Date.now() }],
			},
		);
		const compactSpy = mockCompaction("REAL-REWRITE-BEFORE-TERMINAL-REFUSAL");
		const compactionWarnings: string[] = [];
		const terminalStates: boolean[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.level === "warning" && event.source === "compaction") {
				compactionWarnings.push(event.message);
			}
			if (event.type === "agent_end") terminalStates.push(event.isTerminal === true);
		});

		await session.prompt("preserve the refusal after rewritten recovery cannot continue");

		expect(transforms).toBe(3);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts).toHaveLength(1);
		expect(compactionWarnings).toHaveLength(1);
		expect(compactionWarnings[0]).toContain("usable budget");
		expect(terminalStates).toEqual([true]);
		const terminalRefusal = session.getLastAssistantMessage();
		expect(terminalRefusal?.stopReason).toBe("error");
		expect(terminalRefusal?.errorMessage).toContain("usable budget");
		const branch = sessionManager.getBranch();
		const compactionIndex = branch.findIndex(entry => entry.type === "compaction");
		const refusalIndexes = branch.flatMap((entry, index) => {
			if (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.stopReason === "error" &&
				entry.message.errorMessage?.includes("usable budget")
			) {
				return [index];
			}
			return [];
		});
		expect(compactionIndex).toBeGreaterThanOrEqual(0);
		expect(refusalIndexes).toHaveLength(1);
		expect(refusalIndexes[0]).toBeGreaterThan(compactionIndex);
	});

	it("offers only one new prepared-budget recovery attempt on the next explicit prompt", async () => {
		const oversized = "repeatable prepared growth ".repeat(10_000);
		const { session, observedContexts } = await createHarness(
			{
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 1_000,
				"compaction.keepRecentTokens": 100,
			},
			{
				contextWindow: 4_096,
				transformContext: async messages => [
					...messages,
					{ role: "user", content: oversized, timestamp: Date.now() },
				],
			},
		);
		const maintenanceSpy = vi.spyOn(SessionMaintenance.prototype, "runAutoCompaction").mockResolvedValue({
			deferredHandoff: false,
			continuationScheduled: false,
		});
		const refusalWarnings = collectPreparedBudgetWarnings(session);

		await session.prompt("first bounded recovery");
		await session.prompt("second bounded recovery");

		expect(observedContexts).toHaveLength(0);
		expect(maintenanceSpy).toHaveBeenCalledTimes(2);
		expect(refusalWarnings).toHaveLength(2);
	});

	it("recovers the exact model whose prepared request crossed the budget", async () => {
		let transforms = 0;
		let hookCalls = 0;
		const oversized = "prepared-model growth ".repeat(10_000);
		const { session, observedContexts } = await createHarness(
			{
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 1_000,
				"compaction.keepRecentTokens": 100,
			},
			{
				withHistory: true,
				contextWindow: 272_384,
				firstTurnUsageInput: 200,
				firstTurnUsageOutput: 100,
				toolOutput: "ok",
				configureAgent: agent => {
					agent.addBeforeModelCallHook(() => {
						hookCalls++;
						if (hookCalls !== 2) return;
						const model = agent.state.model;
						if (model) {
							agent.setModel({ ...model, id: "prepared-model-fixture", contextWindow: 4_096 });
						}
					});
				},
				transformContext: async messages => {
					transforms++;
					return transforms === 2
						? [...messages, { role: "user", content: oversized, timestamp: Date.now() }]
						: messages;
				},
			},
		);
		const compactSpy = mockCompaction("PREPARED-MODEL-RECOVERED");
		const preparedRefusalEvents: Array<{
			type: "message_start" | "message_end";
			model: string;
			provider: string;
			contextOverflow: boolean;
		}> = [];
		session.agent.subscribe(event => {
			if (
				(event.type === "message_start" || event.type === "message_end") &&
				event.message.role === "assistant" &&
				event.message.errorMessage?.includes("usable budget")
			) {
				preparedRefusalEvents.push({
					type: event.type,
					model: event.message.model,
					provider: event.message.provider,
					contextOverflow: AIError.is(event.message.errorId, AIError.Flag.ContextOverflow),
				});
			}
		});

		await session.prompt("recover on the model selected during provider preparation");
		expect(preparedRefusalEvents).toEqual([
			{
				type: "message_start",
				model: "prepared-model-fixture",
				provider: "anthropic",
				contextOverflow: true,
			},
			{
				type: "message_end",
				model: "prepared-model-fixture",
				provider: "anthropic",
				contextOverflow: true,
			},
		]);

		expect({
			hookCalls,
			transforms,
			compactions: compactSpy.mock.calls.length,
			providerCalls: observedContexts.length,
			lastStop: session.getLastAssistantMessage()?.stopReason,
		}).toEqual({
			hookCalls: 3,
			transforms: 3,
			compactions: 1,
			providerCalls: 2,
			lastStop: "stop",
		});
	});

	it("releases the recovery claim after promotion so the promoted request can compact once", async () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const promotedModel: Model = {
			...bundled,
			id: "prepared-promotion-target",
			contextWindow: 8_192,
			contextPromotionTarget: undefined,
		};
		const sourceModel: Model = {
			...bundled,
			id: "prepared-promotion-source",
			contextWindow: 4_096,
			contextPromotionTarget: `anthropic/${promotedModel.id}`,
		};
		vi.spyOn(sharedModelRegistry, "getAvailable").mockReturnValue([sourceModel, promotedModel]);
		let transforms = 0;
		const oversized = "post-promotion growth ".repeat(10_000);
		const { session, observedContexts } = await createHarness(
			{
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 1_000,
				"compaction.keepRecentTokens": 100,
				"contextPromotion.enabled": true,
			},
			{
				model: sourceModel,
				withHistory: true,
				firstTurnUsageInput: 100,
				firstTurnUsageOutput: 20,
				toolOutput: "ok",
				transformContext: async messages => {
					transforms++;
					return transforms <= 2
						? [...messages, { role: "user", content: oversized, timestamp: Date.now() }]
						: messages;
				},
			},
		);
		const compactSpy = mockCompaction("PROMOTED-PREPARED-BUDGET-RECOVERED");
		const refusalWarnings = collectPreparedBudgetWarnings(session);

		await session.prompt("promote, then compact the still-oversized prepared request");

		expect(session.model?.id).toBe(promotedModel.id);
		expect(transforms).toBe(4);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts).toHaveLength(2);
		expect(observedContexts[0]?.join("\n")).toContain("PROMOTED-PREPARED-BUDGET-RECOVERED");
		expect(refusalWarnings).toHaveLength(0);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
	});

	it("settles rewritten prepared recovery before a direct Agent run can overtake its delayed continuation", async () => {
		let transforms = 0;
		const lifecycle: string[] = [];
		const oversized = "delayed refusal growth ".repeat(10_000);
		const directRunStarted = Promise.withResolvers<void>();
		let directPrompt: Promise<void> | undefined;
		const { session, sessionManager, observedContexts } = await createHarness(
			{
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 1_000,
				"compaction.keepRecentTokens": 100,
			},
			{
				withHistory: true,
				contextWindow: 8_192,
				firstTurnUsageInput: 100,
				firstTurnUsageOutput: 20,
				onProviderCall: index => lifecycle.push(`provider:${index}`),
				transformContext: async messages => {
					transforms++;
					if (transforms === 1) return messages.slice(-1);
					if (transforms === 2) {
						return [...messages, { role: "user", content: oversized, timestamp: Date.now() }];
					}
					return messages.slice(-1);
				},
			},
		);
		const compactSpy = mockCompaction("REWRITE-BEFORE-DIRECT-RUN");
		const warnings = collectPreparedBudgetWarnings(session);
		const terminalStates: boolean[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_end" && !directPrompt) {
				directPrompt = session.agent.prompt("direct run after the refusal settles");
				directRunStarted.resolve();
			}
			if (event.type === "notice" && event.source === "compaction") lifecycle.push("warning");
			if (event.type === "agent_end") terminalStates.push(event.isTerminal === true);
		});

		await session.prompt("create a rewritten prepared refusal");
		await directRunStarted.promise;
		await directPrompt;

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(transforms).toBe(3);
		expect(observedContexts).toHaveLength(2);
		expect(warnings).toHaveLength(1);
		expect(lifecycle.indexOf("warning")).toBeLessThan(lifecycle.indexOf("provider:1"));
		expect(terminalStates).toEqual([true]);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		const branch = sessionManager.getBranch();
		const compactionIndex = branch.findIndex(entry => entry.type === "compaction");
		const refusalIndexes = branch.flatMap((entry, index) => {
			if (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.errorMessage?.includes("usable budget")
			) {
				return [index];
			}
			return [];
		});
		expect(compactionIndex).toBeGreaterThanOrEqual(0);
		expect(refusalIndexes).toHaveLength(1);
		expect(refusalIndexes[0]).toBeGreaterThan(compactionIndex);
	});

	it("settles rewritten prepared recovery before abort returns", async () => {
		let transforms = 0;
		const oversized = "aborted refusal growth ".repeat(10_000);
		const continuationDelayStarted = Promise.withResolvers<void>();
		const { session, sessionManager, observedContexts } = await createHarness(
			{
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 1_000,
				"compaction.keepRecentTokens": 100,
			},
			{
				withHistory: true,
				contextWindow: 8_192,
				firstTurnUsageInput: 100,
				firstTurnUsageOutput: 20,
				transformContext: async messages => {
					transforms++;
					if (transforms === 1) return messages.slice(-1);
					if (transforms === 2) {
						return [...messages, { role: "user", content: oversized, timestamp: Date.now() }];
					}
					return messages.slice(-1);
				},
			},
		);
		const schedulerWait = scheduler.wait.bind(scheduler);
		vi.spyOn(scheduler, "wait").mockImplementation(async (delay, options) => {
			if (delay !== 100) return schedulerWait(delay, options);
			const signal = options?.signal;
			if (!signal) throw new Error("Expected continuation delay to be abortable");
			if (signal.aborted) throw signal.reason;
			const cancelled = Promise.withResolvers<void>();
			const onAbort = () => cancelled.reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			continuationDelayStarted.resolve();
			try {
				await cancelled.promise;
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		});
		const compactSpy = mockCompaction("REWRITE-BEFORE-ABORT");
		const warnings = collectPreparedBudgetWarnings(session);
		const terminalStates: boolean[] = [];
		session.subscribe(event => {
			if (event.type === "agent_end") terminalStates.push(event.isTerminal === true);
		});

		const prompt = session.prompt("abort the delayed recovery");
		await continuationDelayStarted.promise;
		await session.abort();
		await prompt;

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(transforms).toBe(2);
		expect(observedContexts).toHaveLength(1);
		expect(warnings).toHaveLength(1);
		expect(terminalStates.filter(Boolean)).toHaveLength(1);
		const branch = sessionManager.getBranch();
		const compactionIndex = branch.findIndex(entry => entry.type === "compaction");
		const refusalIndex = branch.findIndex(
			entry =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.errorMessage?.includes("usable budget"),
		);
		expect(compactionIndex).toBeGreaterThanOrEqual(0);
		expect(refusalIndex).toBeGreaterThan(compactionIndex);
	});

	it("compacts and transparently retries the input-only gate rejection with no usage data", async () => {
		const retry = Promise.withResolvers<void>();
		const { session, observedContexts } = await createHarness(
			{ "compaction.thresholdTokens": 100_000, "compaction.keepRecentTokens": 50 },
			{
				withHistory: true,
				firstTurnUsageInput: 200,
				providerErrorAt: 1,
				onProviderCall: index => {
					if (index === 2) retry.resolve();
				},
			},
		);
		mockCompaction("GATE-OVERFLOW-RECOVERED");

		await session.prompt("recover this request if the proxy rejects its input");

		expect(
			await raceWithTimeout(
				retry.promise.then(() => true),
				3_000,
				false,
			),
		).toBe(true);
		expect(observedContexts).toHaveLength(3);
		expect(observedContexts[2].join("\n")).toContain("GATE-OVERFLOW-RECOVERED");
	});

	it("emits only the exact prepared-budget warning when configured compaction has no cut point", async () => {
		const { session, observedContexts } = await createHarness(
			{
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 1_000,
				"compaction.keepRecentTokens": 100,
			},
			{
				contextWindow: 4_096,
				transformContext: async messages => [
					...messages,
					{ role: "user", content: "uncut prepared growth ".repeat(10_000), timestamp: Date.now() },
				],
			},
		);
		const notices: string[] = [];
		const terminalStates: boolean[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.level === "warning" && event.source === "compaction") {
				notices.push(event.message);
			}
			if (event.type === "agent_end") terminalStates.push(event.isTerminal === true);
		});

		await session.prompt("do not duplicate the terminal warning");

		expect(observedContexts).toHaveLength(0);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("usable budget");
		expect(terminalStates).toEqual([true]);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
	});

	it("checks pending input against a switched model and removes its gate on disposal", async () => {
		const { session, observedContexts } = await createHarness(
			{ "compaction.midTurnEnabled": false, "compaction.reserveTokens": 1_000 },
			{
				contextWindow: 100_000,
				configureAgent: agent => {
					agent.addBeforeModelCallHook(() => {
						const model = agent.state.model;
						if (model) agent.setModel({ ...model, contextWindow: 4_096 });
					});
				},
				transformContext: async messages => [
					...messages,
					{ role: "user", content: "pending ".repeat(10_000), timestamp: Date.now() },
				],
			},
		);

		await session.prompt("small original prompt");
		expect(observedContexts).toHaveLength(0);
		await session.dispose();

		await session.agent.prompt("the detached session must no longer gate this agent");
		expect(observedContexts).toHaveLength(2);
	});

	it("counts fresh pending input once when it fits the usable budget", async () => {
		const { session, observedContexts } = await createHarness(
			{
				"compaction.midTurnEnabled": false,
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 1_000,
			},
			{ contextWindow: 4_096, firstTurnUsageInput: 100 },
		);
		await session.prompt("pending ".repeat(1_000));
		expect(observedContexts).toHaveLength(2);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
	});

	it("refuses incident occupancy even when mid-turn maintenance is disabled", async () => {
		const { session, observedContexts } = await createHarness(
			{
				"compaction.midTurnEnabled": false,
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 65_536,
			},
			{ contextWindow: 272_384, firstTurnUsageInput: 206_291, firstTurnUsageOutput: 571, toolOutput: "ok" },
		);
		const compactSpy = mockCompaction("must not compact");
		await session.prompt("continue");
		expect(observedContexts).toHaveLength(1);
		expect(compactSpy).not.toHaveBeenCalled();
		expect(session.getLastAssistantMessage()).toMatchObject({
			stopReason: "error",
			errorMessage: expect.stringContaining("206,848-token usable budget"),
		});
	});

	it("surfaces the prepared-budget refusal when no compaction method is configured", async () => {
		const { session, observedContexts } = await createHarness(
			{ "compaction.methodOrder": [], "compaction.reserveTokens": 1_000 },
			{
				contextWindow: 4_096,
				transformContext: async messages => [
					...messages,
					{ role: "user", content: "prepared growth ".repeat(10_000), timestamp: Date.now() },
				],
			},
		);
		const maintenanceSpy = vi.spyOn(SessionMaintenance.prototype, "runAutoCompaction");
		const refusalWarnings = collectPreparedBudgetWarnings(session);

		await session.prompt("surface an unavailable recovery");

		expect(observedContexts).toHaveLength(0);
		expect(maintenanceSpy).not.toHaveBeenCalled();
		expect(refusalWarnings).toHaveLength(1);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
	});

	it.each([false, true])(
		"charges transformed growth after a larger deferred first prompt (in-place=%s)",
		async inPlace => {
			let transforms = 0;
			const { session, observedContexts } = await createHarness(
				{
					"compaction.midTurnEnabled": false,
					"compaction.thresholdTokens": -1,
					"compaction.reserveTokens": 65_536,
				},
				{
					contextWindow: 272_384,
					firstTurnUsageInput: 206_698,
					firstTurnUsageOutput: 100,
					transformContext: async messages => {
						if (++transforms === 1) return messages;
						const transformed = inPlace ? messages : [...messages];
						transformed.push({ role: "user", content: "x".repeat(400), timestamp: Date.now() });
						return transformed;
					},
				},
			);
			await session.prompt("x".repeat(4_000));
			expect(observedContexts).toHaveLength(1);
			expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
		},
	);

	it("keeps one-shot in-place transform additions request-local without recharging them", async () => {
		let transforms = 0;
		const injectedText = "x".repeat(400);
		const { session, observedContexts } = await createHarness(
			{
				"compaction.midTurnEnabled": false,
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 65_536,
			},
			{
				contextWindow: 272_384,
				firstTurnUsageInput: 206_698,
				firstTurnUsageOutput: 100,
				transformContext: async messages => {
					if (++transforms === 1) {
						messages.push({ role: "user", content: injectedText, timestamp: Date.now() });
					}
					return messages;
				},
			},
		);

		await session.prompt("continue with the retained input");

		expect(observedContexts).toHaveLength(2);
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(observedContexts[0].some(message => message.includes(injectedText))).toBe(true);
		expect(observedContexts[1].some(message => message.includes(injectedText))).toBe(false);
	});

	it("checks the captured model when selection changes during an awaited transform", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let transformSignal: AbortSignal | undefined;
		const { session, observedContexts } = await createHarness(
			{ "compaction.midTurnEnabled": false, "compaction.reserveTokens": 1_000 },
			{
				contextWindow: 4_096,
				transformContext: async (messages, signal) => {
					transformSignal = signal;
					entered.resolve();
					await release.promise;
					return [...messages, { role: "user", content: "pending ".repeat(10_000), timestamp: Date.now() }];
				},
			},
		);
		const prompt = session.prompt("small request");
		try {
			expect(
				await raceWithTimeout(
					entered.promise.then(() => true),
					3_000,
					false,
				),
			).toBe(true);
			const model = session.model;
			if (!model) throw new Error("Expected model");
			await session.setModelTemporary({ ...model, id: "larger-fixture", contextWindow: 100_000 });
			expect(transformSignal?.aborted).toBe(false);
			release.resolve();
			expect(
				await raceWithTimeout(
					prompt.then(() => true),
					3_000,
					false,
				),
			).toBe(true);
			expect(observedContexts).toHaveLength(0);
			expect(session.getLastAssistantMessage()).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("3,096-token usable budget"),
			});
		} finally {
			release.resolve();
			await session.abort();
			await prompt;
		}
	});

	it("settles automatic retry when oversized steering is refused before dispatch", async () => {
		const { session, observedContexts } = await createHarness(
			{
				"compaction.midTurnEnabled": false,
				"compaction.reserveTokens": 1_000,
				"retry.baseDelayMs": 20,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 1,
				"retry.modelFallback": false,
			},
			{ contextWindow: 4_096, providerErrorAt: 0, providerErrorStatus: 503 },
		);
		const retryEnds: Array<{ success: boolean; finalError?: string }> = [];
		let steering: Promise<void> | undefined;
		session.subscribe(event => {
			if (event.type === "auto_retry_start") steering = session.steer("pending ".repeat(10_000));
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});
		const prompt = session.prompt("start");
		try {
			expect(
				await raceWithTimeout(
					prompt.then(() => true),
					3_000,
					false,
				),
			).toBe(true);
			await steering;
			expect(observedContexts).toHaveLength(1);
			expect(retryEnds).toHaveLength(1);
			expect(retryEnds[0]).toMatchObject({
				success: false,
				finalError: expect.stringContaining("usable budget"),
			});
			expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
		} finally {
			await session.abort();
			await prompt;
			await steering;
		}
	});

	it("settles an active-goal retry when a later before-run hook rejects the recovery continuation", async () => {
		let transforms = 0;
		const { session, sessionManager, observedContexts } = await createHarness(
			{
				"compaction.thresholdTokens": -1,
				"compaction.reserveTokens": 1_000,
				"compaction.keepRecentTokens": 100,
				"retry.baseDelayMs": 20,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 1,
				"retry.modelFallback": false,
			},
			{
				withHistory: true,
				contextWindow: 8_192,
				providerErrorAt: 0,
				providerErrorStatus: 503,
				transformContext: async messages =>
					++transforms === 2
						? [
								...messages,
								{ role: "user", content: "retry prepared growth ".repeat(10_000), timestamp: Date.now() },
							]
						: messages,
			},
		);
		session.setGoalModeState(activeGoalState());
		const compactSpy = mockCompaction("REWRITE-BEFORE-CONTINUATION-FAILURE");
		const continueSpy = vi.spyOn(session.agent, "continue");
		let beforeRunCalls = 0;
		session.agent.addBeforeRunHook(() => {
			beforeRunCalls++;
			if (beforeRunCalls === 3) throw new Error("continuation launch failed");
		});
		const retryEnds: Array<{ success: boolean; finalError?: string }> = [];
		const warnings: string[] = [];
		const terminalStates: boolean[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event);
			if (event.type === "notice" && event.level === "warning" && event.source === "compaction") {
				warnings.push(event.message);
			}
			if (event.type === "agent_end") terminalStates.push(event.isTerminal === true);
		});
		const prompt = session.prompt("start an active goal retry");
		try {
			expect(
				await raceWithTimeout(
					prompt.then(() => true),
					3_000,
					false,
				),
			).toBe(true);
			expect(transforms).toBe(2);
			expect(observedContexts).toHaveLength(1);
			expect(compactSpy).toHaveBeenCalledTimes(1);
			expect(continueSpy).toHaveBeenCalledTimes(2);
			expect(beforeRunCalls).toBe(3);
			expect(retryEnds).toHaveLength(1);
			expect(retryEnds[0]).toMatchObject({
				success: false,
				finalError: expect.stringContaining("usable budget"),
			});
			expect(session.isRetrying).toBe(false);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("usable budget");
			expect(terminalStates.filter(Boolean)).toHaveLength(1);
			expect(terminalStates.at(-1)).toBe(true);
			const branch = sessionManager.getBranch();
			const compactionIndex = branch.findIndex(entry => entry.type === "compaction");
			const refusalIndex = branch.findIndex(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.errorMessage?.includes("usable budget"),
			);
			expect(compactionIndex).toBeGreaterThanOrEqual(0);
			expect(refusalIndex).toBeGreaterThan(compactionIndex);
		} finally {
			await session.abort();
			await prompt;
		}
	});

	it.each([false, true])("surfaces text-mode refusal without stale output (history=%s)", async withHistory => {
		const { session, observedContexts } = await createHarness(
			{ "compaction.midTurnEnabled": false, "compaction.reserveTokens": 1_000 },
			{
				withHistory,
				contextWindow: 4_096,
				transformContext: async messages => [
					...messages,
					{ role: "user", content: "pending ".repeat(10_000), timestamp: Date.now() },
				],
			},
		);
		const stderr: string[] = [];
		const stdout: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			stdout.push(String(args[0]));
			const callback = args.at(-1);
			if (typeof callback === "function") callback();
			return true;
		});
		const exit = new Error("captured print-mode exit");
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw exit;
		});
		await expect(runPrintMode(session, { mode: "text", initialMessage: "new request" })).rejects.toBe(exit);
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(stderr.join("")).toContain("3,096-token usable budget");
		expect(stdout.join("")).toBe("");
		expect(observedContexts).toHaveLength(0);
	});

	it("compacts in place between tool-call turns during an active goal run", async () => {
		const { session, observedContexts } = await createHarness();
		session.setGoalModeState(activeGoalState());
		const compactSpy = mockCompaction("ACTIVE-GOAL-MID-RUN-COMPACTED");

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		expect(observedContexts[1].join("\n")).toContain("ACTIVE-GOAL-MID-RUN-COMPACTED");
	});

	it("uses request-local schema accounting before delayed message persistence", async () => {
		const releaseMessageEnd = Promise.withResolvers<void>();
		const messageEndEntered = Promise.withResolvers<void>();
		const nextProviderCall = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end"),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (
					event.type === "message_end" &&
					event.message?.role === "assistant" &&
					event.message.stopReason === "toolUse"
				) {
					messageEndEntered.resolve();
					await releaseMessageEnd.promise;
				}
			}),
		} as unknown as ExtensionRunner;
		const { session } = await createHarness(
			{ "compaction.thresholdTokens": -1, "compaction.reserveTokens": 65_536 },
			{
				extensionRunner,
				contextWindow: 272_384,
				firstTurnUsageInput: 206_738,
				firstTurnUsageOutput: 100,
				intentTracing: true,
				toolOutput: "ok",
				onProviderCall: index => {
					if (index === 1) nextProviderCall.resolve();
				},
			},
		);
		const compactSpy = mockCompaction("SHOULD-NOT-RUN");

		const prompt = session.prompt("work below the maintenance threshold");
		const messageEndOutcome = await raceWithTimeout(
			messageEndEntered.promise.then(() => "entered" as const),
			2_000,
			"blocked" as const,
		);
		const providerOutcome =
			messageEndOutcome === "entered"
				? await raceWithTimeout(
						nextProviderCall.promise.then(() => "dispatched" as const),
						2_000,
						"blocked" as const,
					)
				: "blocked";
		releaseMessageEnd.resolve();
		const promptOutcome = await raceWithTimeout(
			prompt.then(() => "settled" as const),
			2_000,
			"blocked" as const,
		);

		expect(messageEndOutcome).toBe("entered");
		expect(providerOutcome).toBe("dispatched");
		expect(promptOutcome).toBe("settled");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("persists a tool result when its message_end listener rejects below the mid-run threshold", async () => {
		let rejected = false;
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end"),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (!rejected && event.type === "message_end" && event.message?.role === "toolResult") {
					rejected = true;
					throw new Error("intentional message_end failure");
				}
			}),
		} as unknown as ExtensionRunner;
		const { session, sessionManager } = await createHarness(
			{ "compaction.thresholdTokens": 100_000 },
			{ extensionRunner },
		);

		await session.prompt("work below the maintenance threshold");

		const persistedToolResults = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && entry.message.role === "toolResult");
		expect(rejected).toBe(true);
		expect(persistedToolResults).toHaveLength(1);
	});

	it("isolates late message_end mutations from the next provider request", async () => {
		const releaseMutation = Promise.withResolvers<void>();
		const mutationApplied = Promise.withResolvers<void>();
		const toolResultHookEntered = Promise.withResolvers<void>();
		const secondModelCallEntered = Promise.withResolvers<void>();
		const releaseSecondModelCall = Promise.withResolvers<void>();
		const mutationMarker = `LATE-MESSAGE-END-MUTATION-${"x".repeat(500_000)}`;
		const liveDetails = {
			nested: { state: "original" },
			nonCloneable: () => "third-party callback",
		};
		let interceptedToolResult = false;
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end"),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (interceptedToolResult || event.type !== "message_end" || event.message?.role !== "toolResult") return;
				interceptedToolResult = true;
				toolResultHookEntered.resolve();
				await releaseMutation.promise;
				event.message.content = [{ type: "text", text: mutationMarker }];
				(event.message.details as { nested: { state: string } }).nested.state = "mutated";
				mutationApplied.resolve();
			}),
		} as unknown as ExtensionRunner;
		let modelCall = 0;
		const { session, observedContexts } = await createHarness(
			{ "compaction.thresholdTokens": 100_000 },
			{
				extensionRunner,
				toolResultDetails: liveDetails,
				configureAgent: agent => {
					agent.addBeforeModelCallHook(async () => {
						if (modelCall++ !== 1) return;
						secondModelCallEntered.resolve();
						await releaseSecondModelCall.promise;
					});
				},
			},
		);

		const prompt = session.prompt("keep notification mutations out of live context");
		const toolResultHookOutcome = await raceWithTimeout(
			toolResultHookEntered.promise.then(() => "entered" as const),
			2_000,
			"blocked" as const,
		);
		const secondModelCallOutcome =
			toolResultHookOutcome === "entered"
				? await raceWithTimeout(
						secondModelCallEntered.promise.then(() => "dispatched" as const),
						2_000,
						"blocked" as const,
					)
				: "blocked";
		releaseMutation.resolve();
		const mutationOutcome = await raceWithTimeout(
			mutationApplied.promise.then(() => "applied" as const),
			2_000,
			"blocked" as const,
		);
		releaseSecondModelCall.resolve();
		const promptOutcome = await raceWithTimeout(
			prompt.then(() => "settled" as const),
			2_000,
			"blocked" as const,
		);

		expect(toolResultHookOutcome).toBe("entered");
		expect(secondModelCallOutcome).toBe("dispatched");
		expect(mutationOutcome).toBe("applied");
		expect(promptOutcome).toBe("settled");
		expect(observedContexts).toHaveLength(2);
		expect(observedContexts[1].join("\n")).not.toContain("LATE-MESSAGE-END-MUTATION");
		expect(JSON.stringify(session.messages)).not.toContain("LATE-MESSAGE-END-MUTATION");
		expect(liveDetails.nested.state).toBe("original");
		const storedToolResult = session.messages.find(message => message.role === "toolResult");
		if (!storedToolResult) throw new Error("Expected a stored tool result");
		expect((storedToolResult.details as { nested: { state: string } }).nested.state).toBe("original");
	});

	it("preserves the just-finished tool turn when message_end hooks are still pending", async () => {
		const releaseMessageEnd = Promise.withResolvers<void>();
		const messageEndEntered = Promise.withResolvers<void>();
		const turnEndEntered = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end" || eventType === "turn_end"),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (event.type === "turn_end") {
					turnEndEntered.resolve();
					return;
				}
				if (
					event.type === "message_end" &&
					event.message?.role === "assistant" &&
					event.message.stopReason === "toolUse"
				) {
					messageEndEntered.resolve();
					await releaseMessageEnd.promise;
				}
			}),
		} as unknown as ExtensionRunner;
		const { session, sessionManager, observedContexts } = await createHarness({}, { extensionRunner });
		const compactSpy = mockCompaction("MID-RUN-COMPACTED-WITH-PENDING-HOOK");

		const prompt = session.prompt("work on the release");
		await messageEndEntered.promise;
		await turnEndEntered.promise;
		releaseMessageEnd.resolve();
		await prompt;

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		const nextProviderContext = observedContexts[1];
		const toolUseAssistantIndex = nextProviderContext.findIndex(
			serialized =>
				serialized.includes('"role":"assistant"') &&
				serialized.includes('"stopReason":"toolUse"') &&
				serialized.includes('"id":"tc-0"'),
		);
		const toolResultIndex = nextProviderContext.findIndex(
			serialized => serialized.includes('"role":"toolResult"') && serialized.includes('"toolCallId":"tc-0"'),
		);
		expect(toolUseAssistantIndex).toBeGreaterThanOrEqual(0);
		expect(toolResultIndex).toBeGreaterThan(toolUseAssistantIndex);
		expect(nextProviderContext.filter(serialized => serialized.includes('"id":"tc-0"'))).toHaveLength(1);
		expect(nextProviderContext.filter(serialized => serialized.includes('"toolCallId":"tc-0"'))).toHaveLength(1);
		expect(nextProviderContext.join("\n")).toContain("MID-RUN-COMPACTED-WITH-PENDING-HOOK");
		expect(nextProviderContext.join("\n")).toContain("tool output");

		const persistedToolTurnRoles = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message)
			.filter(message => {
				const serialized = JSON.stringify(message);
				return (
					(message.role === "assistant" || message.role === "toolResult") &&
					(serialized.includes('"id":"tc-0"') || serialized.includes('"toolCallId":"tc-0"'))
				);
			})
			.map(message => message.role);
		expect(persistedToolTurnRoles).toEqual(["assistant", "toolResult"]);
	});

	it("keeps synchronous message_end mutations notification-local during mid-run compaction", async () => {
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", event => {
					if (event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return;
					const [block] = event.message.content;
					if (block?.type !== "toolCall") return;
					event.message.content = [{ ...block, arguments: { cmd: "display-variant" } }];
				});
			},
			tempDir.path(),
			new EventBus(),
			extensionRuntime,
			"assistant-display-variant",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir.path(),
			SessionManager.inMemory(),
			sharedModelRegistry,
		);
		const { session, observedContexts } = await createHarness({}, { extensionRunner });
		const compactSpy = mockCompaction("MID-RUN-COMPACTED-WITH-CONTENT-VARIANT");

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		expect(observedContexts[1].join("\n")).toContain("MID-RUN-COMPACTED-WITH-CONTENT-VARIANT");
		expect(JSON.stringify(session.messages)).not.toContain("display-variant");
	});

	it.each([
		["auto_compaction_end", "context-full", ["soft"]],
		["session_compact", "context-full", ["soft"]],
		["auto_compaction_end", "shake", ["shake", "soft"]],
		["session_compact", "shake", ["shake", "soft"]],
	] as const)("hung %s handlers do not pin the mid-run %s loop", async (handlerType, action, methodOrder) => {
		const releaseHandler = Promise.withResolvers<void>();
		const handlerEntered = Promise.withResolvers<void>();
		const nextProviderCall = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === handlerType),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string }) => {
				if (event.type === handlerType) {
					handlerEntered.resolve();
					await releaseHandler.promise;
				}
			}),
		} as unknown as ExtensionRunner;
		const { session, observedContexts } = await createHarness(
			{ "compaction.methodOrder": methodOrder },
			{
				extensionRunner,
				onProviderCall: index => {
					if (index === 1) nextProviderCall.resolve();
				},
			},
		);
		const shakeSpy =
			action === "shake"
				? vi
						.spyOn(session, "shake")
						.mockResolvedValue({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 })
				: undefined;
		const compactSpy = mockCompaction("MID-RUN-COMPACTED-WITHOUT-WAITING-ON-LIFECYCLE");

		const prompt = session.prompt("work on the release");
		const handlerOutcome = await raceWithTimeout(
			handlerEntered.promise.then(() => "entered" as const),
			2_000,
			"blocked" as const,
		);
		const providerOutcome =
			handlerOutcome === "entered"
				? await raceWithTimeout(
						nextProviderCall.promise.then(() => "dispatched" as const),
						2_000,
						"blocked" as const,
					)
				: "blocked";
		const promptOutcome = await raceWithTimeout(
			prompt.then(() => "settled" as const),
			2_000,
			"blocked" as const,
		);
		releaseHandler.resolve();

		expect(handlerOutcome).toBe("entered");
		expect(providerOutcome).toBe("dispatched");
		expect(promptOutcome).toBe("settled");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		if (shakeSpy) expect(shakeSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts[1].join("\n")).toContain("MID-RUN-COMPACTED-WITHOUT-WAITING-ON-LIFECYCLE");
	});

	it("does not compact mid-run outside goal mode when disabled", async () => {
		const { session } = await createHarness({ "compaction.midTurnEnabled": false });
		const compactSpy = mockCompaction("SHOULD-NOT-RUN");

		await session.prompt("work on the release");

		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("does not compact mid-run during active goal mode when disabled", async () => {
		const { session } = await createHarness({ "compaction.midTurnEnabled": false });
		session.setGoalModeState(activeGoalState());
		const compactSpy = mockCompaction("SHOULD-NOT-RUN");

		await session.prompt("work on the release");

		expect(compactSpy).not.toHaveBeenCalled();
	});
});
