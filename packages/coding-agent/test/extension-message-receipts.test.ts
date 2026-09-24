import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager, type SessionPersistenceReceipt } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanup.length) await cleanup.pop()!();
});

async function createHarness(
	options: {
		persistent?: boolean;
		storage?: SessionStorage;
		register?: (api: ExtensionAPI) => void;
	} = {},
) {
	const dir = TempDir.createSync("extension-receipts-");
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	const registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
	const manager = options.persistent
		? SessionManager.create(path.resolve(dir.path()), path.resolve(dir.path(), "sessions"), options.storage)
		: SessionManager.inMemory(path.resolve(dir.path()));
	const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const contexts: Context[] = [];
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		getApiKey: () => "test-key",
		convertToLlm,
		streamFn: (_model, context) => {
			contexts.push(structuredClone(context));
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			entered.resolve();
			void release.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
			return stream;
		},
	});
	let api!: ExtensionAPI;
	let context!: ExtensionContext;
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			api = pi;
			pi.on("session_start", (_event, ctx) => {
				context = ctx;
			});
			options.register?.(pi);
		},
		dir.path(),
		new EventBus(),
		runtime,
		"generic-receipt-probe",
	);
	const runner = new ExtensionRunner([extension], runtime, dir.path(), manager, registry);
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		extensionRunner: runner,
	});
	cleanup.push(async () => {
		release.resolve();
		await session.dispose();
		auth.close();
		dir.removeSync();
	});
	const invocations: Promise<boolean>[] = [];
	await initializeExtensions(session, {
		reportSendError: () => {},
		reportRuntimeError: () => {},
		trackAgentInvokingMessage: task => {
			invocations.push(
				task.then(
					() => true,
					() => false,
				),
			);
		},
	});
	return { api, context, session, manager, registry, settings, runner, entered, release, contexts, invocations };
}

describe("extension message receipts", () => {
	it("admits a streaming follow-up before the provider settles and delivers it on the next call", async () => {
		const h = await createHarness();
		const run = h.session.prompt("Start");
		await h.entered.promise;
		try {
			const receipt = await h.api.sendMessageWithReceipt(
				{ customType: "probe", content: "FOLLOW_UP", details: { correlation: "job-1" } },
				{ deliverAs: "followUp" },
			);
			expect(receipt).toEqual({
				sessionId: h.manager.getSessionId(),
				admitted: true,
				location: "queue",
				deliverAs: "followUp",
			});
			expect(h.session.isStreaming).toBe(true);
		} finally {
			h.release.resolve();
			await run;
		}
		expect(JSON.stringify(h.contexts[1]?.messages)).toContain("FOLLOW_UP");
	});

	it("admits an idle triggered message before provider completion", async () => {
		const h = await createHarness();
		const sending = h.api.sendMessageWithReceipt("TRIGGERED", { triggerTurn: true });
		await h.entered.promise;
		try {
			expect(await sending).toMatchObject({ admitted: true, location: "context" });
			expect(h.session.isStreaming).toBe(true);
			expect(JSON.stringify(h.contexts[0]?.messages)).toContain("TRIGGERED");
		} finally {
			h.release.resolve();
			await h.session.waitForIdle();
		}
		expect(await Promise.all(h.invocations)).toEqual([true]);
	});

	it("queues one follow-up when an operator turn wins the idle dispatch race", async () => {
		const h = await createHarness();
		const prompt = h.session.agent.prompt.bind(h.session.agent);
		let operatorTurn: Promise<void> | undefined;
		const dispatch = spyOn(h.session.agent, "prompt").mockImplementationOnce(async () => {
			operatorTurn = prompt("OPERATOR_TURN");
			await h.entered.promise;
			throw new AgentBusyError();
		});
		try {
			const receipt = await h.api.sendMessageWithReceipt(
				{ customType: "probe", content: "RACING_FOLLOW_UP", display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
			expect(receipt).toEqual({
				sessionId: h.manager.getSessionId(),
				admitted: true,
				location: "queue",
				deliverAs: "followUp",
			});
			expect(h.session.queuedMessageCount).toBe(1);
			h.release.resolve();
			await operatorTurn;
			await h.session.waitForIdle();
			expect(JSON.stringify(h.contexts).match(/RACING_FOLLOW_UP/g)).toHaveLength(1);
		} finally {
			h.release.resolve();
			dispatch.mockRestore();
		}
	});

	it("settles a pre-admission failure while an operator turn waits behind its preflight", async () => {
		const h = await createHarness();
		h.settings.override("retry.modelFallback", false);
		h.settings.override("retry.usageAwareFallback", true);
		h.settings.override("retry.usageReservePolicy", "fail-closed");
		const preflightEntered = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		let preflightChecks = 0;
		const usageHealth = spyOn(h.registry.authStorage.health, "model").mockImplementation(async () => {
			preflightChecks++;
			if (preflightChecks === 1) {
				preflightEntered.resolve();
				await releasePreflight.promise;
				return { state: "reserve", accounts: [] };
			}
			return { state: "healthy", accounts: [] };
		});
		try {
			const sending = h.api.sendMessageWithReceipt(
				{ customType: "probe", content: "FAILED_BEFORE_ADMISSION" },
				{ deliverAs: "followUp", triggerTurn: true },
			);
			const outcome = sending.catch((error: unknown) => error);
			await preflightEntered.promise;

			expect(await h.session.prompt("OPERATOR_TURN", { streamingBehavior: "steer" })).toBe(true);
			expect(h.session.queuedMessageCount).toBe(1);
			releasePreflight.resolve();

			expect(await outcome).toEqual({
				sessionId: h.manager.getSessionId(),
				admitted: false,
				reason: "admission-failed",
			});
			await h.entered.promise;
			h.release.resolve();
			await h.session.waitForIdle();
			expect(JSON.stringify(h.contexts).match(/OPERATOR_TURN/g)).toHaveLength(1);
			expect(JSON.stringify(h.contexts)).not.toContain("FAILED_BEFORE_ADMISSION");
			expect(usageHealth).toHaveBeenCalledTimes(2);
		} finally {
			releasePreflight.resolve();
			h.release.resolve();
			usageHealth.mockRestore();
		}
	});

	it("settles context admission before a queued operator turn can block input emission", async () => {
		const h = await createHarness();
		const beforeRunEntered = Promise.withResolvers<void>();
		const releaseBeforeRun = Promise.withResolvers<void>();
		const dequeueEntered = Promise.withResolvers<void>();
		const releaseDequeue = Promise.withResolvers<void>();
		let beforeRuns = 0;
		const removeBeforeRun = h.session.agent.addBeforeRunHook(async () => {
			beforeRuns++;
			if (beforeRuns !== 1) return;
			beforeRunEntered.resolve();
			await releaseBeforeRun.promise;
		});
		const removeDequeue = h.session.agent.addBeforeQueuedMessageDequeueHook(async () => {
			dequeueEntered.resolve();
			await releaseDequeue.promise;
		});
		const sending = h.api.sendMessageWithReceipt(
			{ customType: "probe", content: "RACING_REPORT" },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		try {
			await beforeRunEntered.promise;
			expect(await h.session.prompt("OPERATOR_TURN", { streamingBehavior: "steer" })).toBe(true);
			expect(h.session.queuedMessageCount).toBe(1);
			releaseBeforeRun.resolve();
			await dequeueEntered.promise;

			expect(h.contexts).toHaveLength(0);
			expect(await withTimeout(sending, 250, "receipt remained pending after context admission")).toEqual({
				sessionId: h.manager.getSessionId(),
				admitted: true,
				location: "context",
				deliverAs: "followUp",
			});
		} finally {
			removeBeforeRun();
			removeDequeue();
			releaseBeforeRun.resolve();
			releaseDequeue.resolve();
			h.release.resolve();
			await h.session.waitForIdle();
			await sending;
		}
		expect(JSON.stringify(h.contexts).match(/RACING_REPORT/g)).toHaveLength(1);
		expect(JSON.stringify(h.contexts).match(/OPERATOR_TURN/g)).toHaveLength(1);
	});

	it("flushes a lazy pre-assistant journal and preserves correlation after reopening", async () => {
		const h = await createHarness({ persistent: true });
		const file = h.manager.getSessionFile()!;
		await h.api.sendMessageWithReceipt({
			customType: "probe",
			content: "CORRELATED",
			details: { correlation: "job-2" },
		});
		expect(await Bun.file(file).exists()).toBe(false);
		const receipt = await h.context.flushSession();
		const reopened = await SessionManager.open(file);
		const entry = reopened.getEntries().find(item => item.type === "custom_message" && item.customType === "probe");
		if (!entry) throw new Error("Reopened session lost the correlated custom message");
		expect(entry).toMatchObject({ content: "CORRELATED", details: { correlation: "job-2" } });
		expect(receipt).toEqual({
			sessionId: h.manager.getSessionId(),
			throughEntryId: entry.id,
			persistence: "flushed",
		});
		await reopened.close();
	});

	it("reports memory-only with the physical journal cutoff rather than the active branch leaf", async () => {
		const h = await createHarness();
		expect(await h.context.flushSession()).toEqual({
			sessionId: h.manager.getSessionId(),
			throughEntryId: null,
			persistence: "memory-only",
		});
		const first = h.manager.appendCustomEntry("probe-state", { revision: 1 });
		const abandoned = h.manager.appendCustomEntry("probe-state", { revision: 2 });
		h.manager.branch(first);
		expect(h.manager.getLeafId()).toBe(first);
		expect(await h.context.flushSession()).toEqual({
			sessionId: h.manager.getSessionId(),
			throughEntryId: abandoned,
			persistence: "memory-only",
		});
	});

	it("flushes from message_end without waiting for itself or claiming its unrecorded input", async () => {
		const barrier = Promise.withResolvers<SessionPersistenceReceipt>();
		const h = await createHarness({
			persistent: true,
			register: pi =>
				pi.on("message_end", async (event, ctx) => {
					if (event.message.role === "custom" && event.message.customType === "pending-input") {
						barrier.resolve(await ctx.flushSession());
					}
				}),
		});
		const prior = h.manager.appendCustomEntry("prior-state", { correlation: "before-input" });
		const sending = h.api.sendMessageWithReceipt(
			{ customType: "pending-input", content: "NOT_YET_RECORDED" },
			{ triggerTurn: true },
		);
		try {
			const receipt = await barrier.promise;
			expect(receipt.throughEntryId).toBe(prior);
			expect(await sending).toMatchObject({ admitted: true, location: "context" });
		} finally {
			h.release.resolve();
			await h.session.waitForIdle();
		}
		const finalReceipt = await h.context.flushSession();
		const reopened = await SessionManager.open(h.manager.getSessionFile()!);
		expect(
			reopened.getEntries().find(entry => entry.type === "custom_message" && entry.customType === "pending-input"),
		).toMatchObject({ content: "NOT_YET_RECORDED" });
		expect(finalReceipt.throughEntryId).not.toBe(prior);
		await reopened.close();
	});

	it("rejects an uncertain storage publication instead of issuing a flushed receipt", async () => {
		const storage = new FileSessionStorage();
		const h = await createHarness({ persistent: true, storage });
		h.api.appendEntry("probe-state", { correlation: "uncertain" });
		const originalWrite = storage.writeTextAtomic.bind(storage);
		const failure = spyOn(storage, "writeTextAtomic").mockImplementation(async (...args) => {
			await originalWrite(...args);
			throw new Error("publication acknowledgement lost");
		});
		try {
			await expect(h.context.flushSession()).rejects.toThrow("publication acknowledgement lost");
			const reopened = await SessionManager.open(h.manager.getSessionFile()!);
			expect(
				reopened.getEntries().find(entry => entry.type === "custom" && entry.customType === "probe-state"),
			).toMatchObject({ data: { correlation: "uncertain" } });
			await reopened.close();
		} finally {
			failure.mockRestore();
			await h.manager.recoverPersistenceFromCurrentState();
		}
	});

	it("rejects stale extension contexts after a session switch and admission after disposal", async () => {
		const h = await createHarness();
		const previousId = h.manager.getSessionId();
		await h.session.newSession();
		await expect(h.context.flushSession()).rejects.toThrow("Session changed");
		expect(h.manager.getSessionId()).not.toBe(previousId);
		await h.session.dispose();
		await expect(h.context.flushSession()).rejects.toThrow("disposed");
		expect(await h.api.sendMessageWithReceipt("AFTER_DISPOSAL")).toMatchObject({
			admitted: false,
			reason: "session-disposed",
		});
	});

	it("types normalization failures before admission and preserves the legacy rejection", async () => {
		const h = await createHarness();
		const failure = spyOn(imageLoading, "normalizeModelContextImages").mockRejectedValue(
			new Error("image decode failed"),
		);
		try {
			expect(await h.api.sendMessageWithReceipt({ content: [image] })).toEqual({
				sessionId: h.manager.getSessionId(),
				admitted: false,
				reason: "admission-failed",
			});
			await expect(h.session.sendCustomMessage({ content: [image] })).rejects.toThrow("image decode failed");
			expect(h.session.agent.state.messages.some(message => message.role === "custom")).toBe(false);
		} finally {
			failure.mockRestore();
		}
	});

	for (const deliverAs of ["steer", "followUp", "nextTurn", "aside"] as const) {
		it(`does not admit ${deliverAs} into a replacement session when normalization spans the switch`, async () => {
			const h = await createHarness();
			const oldSession = h.manager.getSessionId();
			const normalizing = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const normalization = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
				normalizing.resolve();
				await resume.promise;
				return images;
			});
			try {
				const send = h.api.sendMessageWithReceipt(
					{ content: [{ type: "text", text: "OLD_SESSION_INPUT" }, image] },
					{ deliverAs },
				);
				await normalizing.promise;
				await h.session.newSession();
				resume.resolve();
				expect(await send).toEqual({ sessionId: oldSession, admitted: false, reason: "session-changed" });
				expect(h.session.queuedMessageCount).toBe(0);
				expect(h.session.agent.state.messages.some(message => message.role === "custom")).toBe(false);
			} finally {
				resume.resolve();
				normalization.mockRestore();
			}
		});
	}

	it("keeps nextTurn hidden until a deliberate prompt, then delivers it", async () => {
		const h = await createHarness();
		const run = h.session.prompt("FIRST");
		await h.entered.promise;
		const receipt = await h.api.sendMessageWithReceipt("NEXT_TURN", { deliverAs: "nextTurn" });
		expect(receipt).toMatchObject({ admitted: true, location: "queue", deliverAs: "nextTurn" });
		h.release.resolve();
		await run;
		await h.session.waitForIdle();
		expect(h.contexts).toHaveLength(1);
		await h.session.prompt("SECOND");
		expect(JSON.stringify(h.contexts[1]?.messages)).toContain("NEXT_TURN");
	});

	it("admits idle nextTurn directly without starting a provider call", async () => {
		const h = await createHarness();
		expect(await h.api.sendMessageWithReceipt("IDLE_NEXT", { deliverAs: "nextTurn" })).toMatchObject({
			admitted: true,
			location: "context",
			deliverAs: "nextTurn",
		});
		expect(h.contexts).toHaveLength(0);
		expect(h.manager.getEntries().find(entry => entry.type === "custom_message")).toMatchObject({
			content: "IDLE_NEXT",
		});
	});

	it("folds idle plan-mode asides into context without starting a turn", async () => {
		const h = await createHarness();
		h.session.setPlanModeState({ enabled: true, planFilePath: "local://plan.md" });
		expect(await h.api.sendMessageWithReceipt("PLAN_ASIDE", { deliverAs: "aside" })).toMatchObject({
			admitted: true,
			location: "context",
			deliverAs: "aside",
		});
		expect(h.contexts).toHaveLength(0);
		expect(JSON.stringify(h.session.agent.state.messages)).toContain("PLAN_ASIDE");
	});

	it("admits deferred client turns to a queue without reporting provider ownership", async () => {
		const h = await createHarness();
		h.session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
		expect(await h.api.sendMessageWithReceipt("DEFERRED", { triggerTurn: true })).toMatchObject({
			admitted: true,
			location: "queue",
		});
		expect(await h.session.sendCustomMessage("LEGACY_DEFERRED", { triggerTurn: true })).toBe(false);
		expect(h.contexts).toHaveLength(0);
		h.release.resolve();
		await h.session.prompt("CLIENT_TURN");
		expect(JSON.stringify(h.contexts[0]?.messages)).toContain("DEFERRED");
		expect(await Promise.all(h.invocations)).toEqual([false]);
	});

	it("keeps legacy triggered completion pending after receipt admission has resolved", async () => {
		const h = await createHarness();
		let completed = false;
		const legacy = h.session.sendCustomMessage("LEGACY_TRIGGER", { triggerTurn: true }).then(started => {
			completed = true;
			return started;
		});
		await h.entered.promise;
		expect(completed).toBe(false);
		h.release.resolve();
		expect(await legacy).toBe(true);
	});

	it("rejects a persistence barrier whose storage drain spans a session replacement", async () => {
		const storage = new FileSessionStorage();
		const h = await createHarness({ persistent: true, storage });
		h.api.appendEntry("old-state", { correlation: "old" });
		await h.context.flushSession();
		const draining = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const drain = spyOn(storage, "drain").mockImplementationOnce(async () => {
			draining.resolve();
			await resume.promise;
		});
		try {
			const barrier = h.context.flushSession();
			const rejected = barrier.catch((error: unknown) => error);
			await draining.promise;
			const switched = h.session.newSession();
			resume.resolve();
			expect(await rejected).toMatchObject({ message: "Session changed during persistence barrier." });
			await switched;
			const reopened = await SessionManager.open(h.manager.getSessionFile()!);
			expect(reopened.getEntries().some(entry => entry.type === "custom" && entry.customType === "old-state")).toBe(
				false,
			);
			await reopened.close();
		} finally {
			resume.resolve();
			drain.mockRestore();
		}
	});

	it("admits a normalized message after a failed switch rolls back to its original session", async () => {
		const storage = new MemorySessionStorage();
		const h = await createHarness({ persistent: true, storage });
		const originalId = h.manager.getSessionId();
		const target = SessionManager.create(h.manager.getCwd(), h.manager.getSessionDir(), storage);
		await target.ensureOnDisk();
		const targetPath = target.getSessionFile()!;
		const normalizing = Promise.withResolvers<void>();
		const resumeNormalize = Promise.withResolvers<void>();
		const loading = Promise.withResolvers<void>();
		const resumeLoad = Promise.withResolvers<void>();
		const normalize = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizing.resolve();
			await resumeNormalize.promise;
			return images;
		});
		const originalRead = storage.readText.bind(storage);
		const load = spyOn(storage, "readText").mockImplementation(async file => {
			if (file !== targetPath) return originalRead(file);
			loading.resolve();
			await resumeLoad.promise;
			throw new Error("target storage unavailable");
		});
		try {
			const sending = h.api.sendMessageWithReceipt(
				{ content: [{ type: "text", text: "ROLLBACK_INPUT" }, image] },
				{ deliverAs: "followUp" },
			);
			await normalizing.promise;
			const switched = h.session.switchSession(targetPath);
			const rejected = switched.catch((error: unknown) => error);
			await loading.promise;
			resumeNormalize.resolve();
			resumeLoad.resolve();
			expect(await rejected).toMatchObject({ message: "target storage unavailable" });
			expect(await sending).toMatchObject({ sessionId: originalId, admitted: true, location: "context" });
			expect(JSON.stringify(h.session.agent.state.messages)).toContain("ROLLBACK_INPUT");
		} finally {
			resumeNormalize.resolve();
			resumeLoad.resolve();
			normalize.mockRestore();
			load.mockRestore();
			await target.close();
		}
	});

	for (const deliverAs of ["steer", "aside"] as const) {
		it(`admits a streaming ${deliverAs} while the provider is pending and eventually delivers it`, async () => {
			const h = await createHarness();
			const run = h.session.prompt("FIRST");
			await h.entered.promise;
			try {
				expect(await h.api.sendMessageWithReceipt("STREAM_INPUT", { deliverAs })).toMatchObject({
					admitted: true,
					location: "queue",
					deliverAs,
				});
				expect(h.session.isStreaming).toBe(true);
			} finally {
				h.release.resolve();
				await run;
				await h.session.waitForIdle();
			}
			expect(JSON.stringify(h.contexts.slice(1).map(context => context.messages))).toContain("STREAM_INPUT");
		});
	}

	it("admits an idle aside into a new turn even without triggerTurn", async () => {
		const h = await createHarness();
		try {
			expect(await h.api.sendMessageWithReceipt("IDLE_ASIDE", { deliverAs: "aside" })).toMatchObject({
				admitted: true,
				location: "context",
				deliverAs: "aside",
			});
			await h.entered.promise;
			expect(JSON.stringify(h.contexts[0]?.messages)).toContain("IDLE_ASIDE");
		} finally {
			h.release.resolve();
			await h.session.waitForIdle();
		}
	});

	it("rejects ownership when disposal occurs during image normalization", async () => {
		const h = await createHarness();
		const normalizing = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const normalize = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizing.resolve();
			await resume.promise;
			return images;
		});
		try {
			const sending = h.api.sendMessageWithReceipt({ content: [image] }, { triggerTurn: true });
			await normalizing.promise;
			await h.session.dispose();
			resume.resolve();
			expect(await sending).toMatchObject({ admitted: false, reason: "session-disposed" });
			expect(h.contexts).toHaveLength(0);
		} finally {
			resume.resolve();
			normalize.mockRestore();
		}
	});

	it("does not change an admission into a negative receipt when persistence fails after context append", async () => {
		const storage = new FileSessionStorage();
		const h = await createHarness({ persistent: true, storage });
		await h.context.flushSession();
		const failure = spyOn(storage, "openWriter").mockImplementation(() => {
			throw new Error("writer unavailable");
		});
		try {
			expect(await h.api.sendMessageWithReceipt("OWNED_IN_MEMORY")).toMatchObject({
				admitted: true,
				location: "context",
			});
			expect(JSON.stringify(h.session.agent.state.messages)).toContain("OWNED_IN_MEMORY");
			await expect(h.context.flushSession()).rejects.toThrow("writer unavailable");
		} finally {
			failure.mockRestore();
			await h.manager.recoverPersistenceFromCurrentState();
		}
	});

	it("captures its cutoff after an atomic batch rolls back, never claiming a removed entry", async () => {
		const storage = new MemorySessionStorage();
		const h = await createHarness({ persistent: true, storage });
		const prior = h.manager.appendCustomEntry("retained", { revision: 1 });
		await h.context.flushSession();
		const publishing = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const failure = spyOn(storage, "writeTextAtomic").mockImplementationOnce(async () => {
			publishing.resolve();
			await resume.promise;
			throw new Error("atomic publish failed");
		});
		try {
			const batch = h.manager.appendEntriesAtomically(() =>
				h.manager.appendCustomEntry("rolled-back", { revision: 2 }),
			);
			const rejected = batch.catch((error: unknown) => error);
			await publishing.promise;
			const barrier = h.context.flushSession();
			resume.resolve();
			expect(await rejected).toMatchObject({ message: "atomic publish failed" });
			expect(await barrier).toMatchObject({ throughEntryId: prior, persistence: "flushed" });
			const reopened = await SessionManager.open(h.manager.getSessionFile()!, undefined, storage);
			expect(
				reopened.getEntries().some(entry => entry.type === "custom" && entry.customType === "rolled-back"),
			).toBe(false);
			await reopened.close();
		} finally {
			resume.resolve();
			failure.mockRestore();
		}
	});
});
