import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type } from "@oh-my-pi/omptype";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	bindPreparedExtensions,
	disposeLoadedExtensions,
	getLoadedRuntimeOrigin,
	loadExtensions,
} from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { initializeExtensions } from "../src/modes/runtime-init";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager, type SessionPersistenceReceipt } from "../src/session/session-manager";
import {
	readRuntimeRequirements,
	type RequiredRuntimeExtension,
	RuntimeRequirementError,
} from "../src/session/runtime-requirements";
import { FileSessionStorage, type WriteTextAtomicOptions } from "../src/session/session-storage";
import { EventBus } from "../src/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

async function harness(
	options: {
		file?: string;
		extension?: boolean;
		extensionPath?: string;
		manager?: SessionManager;
		requiredRuntimeExtensions?: readonly RequiredRuntimeExtension[];
	} = {},
) {
	const dir = TempDir.createSync("runtime-requirement-");
	const extensionPath = options.extensionPath ?? path.resolve(dir.path(), "guard.ts");
	if (!options.extensionPath)
		await Bun.write(
			extensionPath,
			`export default function(pi) {
		let state = "pass";
		let failOnCompaction = false;
		pi.events.on("fail-on-compaction", () => { failOnCompaction = true; });
		pi.on("session_before_compact", () => { if (failOnCompaction) state = "fail"; });
		let attachOnReady = false;
		let failBeforeStart = false;
		let deferSwitch = false;
		pi.events.on("defer-switch", () => { deferSwitch = true; });
		pi.on("session_before_switch", () => {
			if (!deferSwitch) return;
			const gate = Promise.withResolvers();
			pi.events.emit("switch-deferred", gate);
			return gate.promise;
		});
		pi.events.on("attach-on-ready", () => { attachOnReady = true; });
		pi.events.on("fail-before-start", () => { failBeforeStart = true; });
		pi.on("before_agent_start", () => { if (failBeforeStart) state = "fail"; });
		pi.on("session_ready", async event => {
			if (attachOnReady) {
				await pi.requireRuntime({ sessionId: event.sessionId, id: "fixture.guard", version: 1, check: () => state === "pass" });
				pi.events.emit("ready-attached", event);
			}
		});
		pi.on("session_ready", event => { pi.events.emit("guard-ready", event); });
		pi.events.on("guard-state", value => { state = value; });
		pi.on("session_start", async (_, ctx) => {
			try {
				const receipt = await pi.requireRuntime({ sessionId: ctx.sessionManager.getSessionId(), id: "fixture.guard", version: 1, check: context => {
					pi.events.emit("guard-check", context);
					if (state === "throw") throw new Error("Check failed");
					if (state === "defer") {
						const gate = Promise.withResolvers();
						pi.events.emit("guard-deferred", { signal: context.signal, resolve: gate.resolve });
						return gate.promise;
					}
					if (state === "hang") return Promise.withResolvers().promise;
					return state === "pass";
				} });
				pi.events.emit("declared", receipt);
			} catch (error) { pi.events.emit("declaration-error", error); }
		});
	}`,
		);
	const manager =
		options.manager ??
		(options.file
			? await SessionManager.open(options.file)
			: SessionManager.create(dir.path(), path.join(dir.path(), "sessions")));
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	const registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
	const bus = new EventBus();
	const declaration = Promise.withResolvers<SessionPersistenceReceipt>();
	bus.on("declared", value => declaration.resolve(value as SessionPersistenceReceipt));
	bus.on("declaration-error", value => declaration.reject(value));
	const loaded = await loadExtensions(options.extension === false ? [] : [extensionPath], dir.path(), bus);
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, dir.path(), manager, registry);
	const mock = createMockModel({ provider: "openai", id: "runtime-test", handler: { content: ["Done."] } });
	const side = createMockModel({ provider: "openai", id: "runtime-side-test", handler: { content: ["Title"] } });
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		getApiKey: () => "test",
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry: registry,
		extensionRunner: runner,
		sideStreamFn: side.stream,
		requiredRuntimeExtensions: options.requiredRuntimeExtensions,
	});
	cleanups.push(async () => {
		await session.dispose();
		auth.close();
		dir.removeSync();
	});
	expect(loaded.errors).toEqual([]);
	const runtimeErrors: string[] = [];
	await initializeExtensions(session, {
		reportSendError: () => {},
		reportRuntimeError: error => {
			runtimeErrors.push(error.error);
		},
	});
	return {
		session,
		manager,
		bus,
		loaded,
		extensionPath,
		mock,
		side,
		registry,
		runtimeErrors,
		declaration: declaration.promise,
		modelCalls: () => mock.calls.length,
	};
}

describe("session-wide runtime requirements", () => {
	it("persists a real extension declaration before acknowledging and refuses a cold turn without that extension", async () => {
		const original = await harness();
		expect(await original.declaration).toMatchObject({
			sessionId: original.session.sessionId,
			persistence: "flushed",
		});
		const cold = await harness({ file: original.manager.getSessionFile(), extension: false });
		await expect(cold.session.prompt("Do not dispatch this draft")).rejects.toThrow("runtime requirement");
		expect(cold.modelCalls()).toBe(0);
		expect(cold.session.queuedMessageCount).toBe(0);
		expect(cold.manager.getEntries().filter(entry => entry.type === "message")).toEqual([]);
	});

	it("refuses custom follow-up admission without queuing the rejected draft", async () => {
		const original = await harness();
		await original.declaration;
		const cold = await harness({ file: original.manager.getSessionFile(), extension: false });
		await expect(
			cold.session.sendCustomMessageWithReceipt(
				{ customType: "probe", content: "REJECTED" },
				{ deliverAs: "followUp" },
			),
		).rejects.toThrow("runtime requirement");
		expect(cold.session.queuedMessageCount).toBe(0);
		expect(cold.modelCalls()).toBe(0);
	});

	it("accepts freshly checked exact code on resume, rejects a later false check, and never replays that draft", async () => {
		const original = await harness();
		await original.declaration;
		const resumed = await harness({ file: original.manager.getSessionFile(), extensionPath: original.extensionPath });
		await resumed.declaration;
		await resumed.session.prompt("FIRST");
		expect(resumed.modelCalls()).toBe(1);
		resumed.bus.emit("guard-state", "fail");
		await expect(resumed.session.prompt("REJECTED_DRAFT")).rejects.toThrow("runtime requirement");
		resumed.bus.emit("guard-state", "pass");
		await resumed.session.prompt("SECOND");
		expect(resumed.modelCalls()).toBe(2);
		expect(JSON.stringify(resumed.mock.calls.map(call => call.context.messages))).not.toContain("REJECTED_DRAFT");
	});

	it("refuses steering before it enters a protected queue", async () => {
		const original = await harness();
		await original.declaration;
		const cold = await harness({ file: original.manager.getSessionFile(), extension: false });
		await expect(cold.session.steer("REJECTED_STEER")).rejects.toThrow("runtime requirement");
		expect(cold.session.queuedMessageCount).toBe(0);
		expect(cold.modelCalls()).toBe(0);
	});

	it("keeps protected queued work untouched when a continuation cannot satisfy the saved runtime", async () => {
		const original = await harness();
		await original.declaration;
		const cold = await harness({ file: original.manager.getSessionFile(), extension: false });
		cold.session.agent.steer({ role: "user", content: [{ type: "text", text: "PROTECTED" }], timestamp: Date.now() });
		await expect(cold.session.agent.continue()).rejects.toThrow("runtime requirement");
		expect(cold.session.agent.peekSteeringQueue()).toHaveLength(1);
		expect(cold.modelCalls()).toBe(0);
	});

	for (const [name, dispatch] of [
		["follow-up", (session: AgentSession) => session.followUp("REJECTED")],
		["synthetic follow-up", (session: AgentSession) => session.followUp("REJECTED", undefined, { synthetic: true })],
		[
			"custom prompt",
			(session: AgentSession) =>
				session.promptCustomMessage({ customType: "probe", content: "REJECTED", display: true }),
		],
		["user aside", (session: AgentSession) => session.sendUserMessage("REJECTED", { deliverAs: "aside" })],
		[
			"hidden next turn",
			(session: AgentSession) =>
				session.sendCustomMessageWithReceipt(
					{ customType: "probe", content: "REJECTED" },
					{ deliverAs: "nextTurn", triggerTurn: true },
				),
		],
	] as const) {
		it(`refuses ${name} before admission or side inference`, async () => {
			const original = await harness();
			await original.declaration;
			const cold = await harness({ file: original.manager.getSessionFile(), extension: false });
			await expect(dispatch(cold.session)).rejects.toThrow("runtime requirement");
			expect(cold.session.queuedMessageCount).toBe(0);
			expect(cold.modelCalls()).toBe(0);
			expect(cold.side.calls).toHaveLength(0);
		});
	}

	it("preserves the requirement when the conversation is copied to a new journal", async () => {
		const original = await harness();
		await original.declaration;
		const copy = await original.manager.persistCopy({ sessionDir: path.dirname(original.manager.getSessionFile()!) });
		const cold = await harness({ manager: copy, extension: false });
		await expect(cold.session.prompt("COPIED_DRAFT")).rejects.toThrow("runtime requirement");
		expect(cold.modelCalls()).toBe(0);
	});

	for (const variant of ["fork", "branch", "forkFrom"] as const) {
		it(`keeps the session-wide condition across ${variant}`, async () => {
			const original = await harness();
			const entryId = original.manager.appendMessage({
				role: "user",
				content: "History stays readable",
				timestamp: Date.now(),
			});
			await original.declaration;
			await original.manager.flushSession();
			let manager = original.manager;
			if (variant === "fork") await manager.fork();
			if (variant === "branch") manager.createBranchedSession(entryId);
			if (variant === "forkFrom")
				manager = await SessionManager.forkFrom(
					manager.getSessionFile()!,
					manager.getCwd(),
					path.dirname(manager.getSessionFile()!),
				);
			const cold = await harness({ file: manager.getSessionFile(), extension: false });
			if (manager !== original.manager) await manager.close();
			expect(cold.manager.getEntries().some(entry => entry.type === "message")).toBe(true);
			await expect(cold.session.prompt("FORKED_DRAFT")).rejects.toThrow("runtime requirement");
			expect(cold.modelCalls()).toBe(0);
		});
	}

	it("refuses the first turn when the application requires a runtime that never declared", async () => {
		const h = await harness({
			extension: false,
			requiredRuntimeExtensions: [{ path: "/missing/generic-runtime.ts", id: "fixture.guard", version: 1 }],
		});
		await expect(h.session.prompt("FIRST_DRAFT")).rejects.toThrow("runtime requirement");
		expect(h.modelCalls()).toBe(0);
		expect(h.session.queuedMessageCount).toBe(0);
	});

	it("announces target readiness only after switch restoration, without changing session_switch timing", async () => {
		const source = await harness();
		await source.declaration;
		const target = await harness();
		await target.declaration;
		target.manager.appendMessage({ role: "user", content: "TARGET_HISTORY", timestamp: Date.now() });
		await target.manager.flushSession();
		const observed: Array<{ sessionId: string; messages: string }> = [];
		source.bus.on("guard-ready", event =>
			observed.push({
				sessionId: (event as { sessionId: string }).sessionId,
				messages: JSON.stringify(source.session.agent.state.messages),
			}),
		);
		expect(await source.session.switchSession(target.manager.getSessionFile()!, { preserveLocalCwd: true })).toBe(
			true,
		);
		expect(observed).toHaveLength(1);
		expect(observed[0]?.sessionId).toBe(target.session.sessionId);
		expect(observed[0]?.messages).toContain("TARGET_HISTORY");
		await expect(source.session.prompt("REFUSE_UNATTACHED_TARGET")).rejects.toThrow("runtime requirement");
	});

	it("does not consume protected hidden work while its runtime is absent", async () => {
		const original = await harness();
		await original.declaration;
		const cold = await harness({ file: original.manager.getSessionFile(), extension: false });
		cold.session.queueDeferredMessage({
			role: "custom",
			customType: "probe",
			content: "PROTECTED_HIDDEN",
			display: false,
			timestamp: Date.now(),
		});
		await cold.session.waitForIdle();
		expect(cold.session.queuedMessageCount).toBe(1);
		expect(JSON.stringify(cold.session.agent.state.messages)).not.toContain("PROTECTED_HIDDEN");
		expect(cold.modelCalls()).toBe(0);
		expect(cold.runtimeErrors.some(error => error.includes("runtime requirement"))).toBe(true);
	});

	it("refuses automatic title inference for a rejected session", async () => {
		const original = await harness();
		await original.declaration;
		const cold = await harness({ file: original.manager.getSessionFile(), extension: false });
		await expect(cold.session.generateTitle("Investigate the runtime refusal")).rejects.toThrow(
			"runtime requirement",
		);
	});

	it("refuses shared agent dispatch before appending a host-owned draft", async () => {
		const original = await harness();
		await original.declaration;
		const cold = await harness({ file: original.manager.getSessionFile(), extension: false });
		await expect(cold.session.agent.prompt("HOST_DRAFT")).rejects.toThrow("runtime requirement");
		expect(cold.session.agent.state.messages).toEqual([]);
		expect(cold.modelCalls()).toBe(0);
	});

	for (const mode of ["fail", "throw", "hang"] as const) {
		it(`refuses a fresh ${mode} check without dispatch or replay`, async () => {
			const h = await harness();
			await h.declaration;
			h.bus.emit("guard-state", mode);
			await expect(h.session.prompt("REJECTED_CHECK")).rejects.toThrow("runtime requirement");
			expect(h.modelCalls()).toBe(0);
			expect(h.session.queuedMessageCount).toBe(0);
		});
	}

	for (const change of ["disposed", "tampered"] as const) {
		it(`does not treat saved identity as authority after loaded code is ${change}`, async () => {
			const h = await harness();
			await h.declaration;
			if (change === "disposed") disposeLoadedExtensions(h.loaded);
			else await Bun.write(h.extensionPath, "export default function() {}");
			await expect(h.session.prompt("REJECTED_ORIGIN")).rejects.toThrow("runtime requirement");
			expect(h.modelCalls()).toBe(0);
		});
	}

	it("does not allow a mutable header snapshot to remove an execution condition", async () => {
		const h = await harness();
		await h.declaration;
		const header = h.manager.getHeader();
		if (!header) throw new Error("Missing session header");
		delete header.runtimeRequirements;
		h.bus.emit("guard-state", "fail");
		await expect(h.session.prompt("REJECTED_MUTATION")).rejects.toThrow("runtime requirement");
		expect(h.modelCalls()).toBe(0);
	});

	it("refuses an extension disabled after declaration", async () => {
		const h = await harness();
		await h.declaration;
		h.session.settings.set("disabledExtensions", ["extension-module:guard"]);
		await expect(h.session.prompt("REJECTED_DISABLED")).rejects.toThrow("runtime requirement");
		expect(h.modelCalls()).toBe(0);
	});

	it("retains refusal after declaration storage fails instead of acknowledging a volatile requirement", async () => {
		const dir = TempDir.createSync("runtime-storage-failure-");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(path.resolve(dir.path()), path.resolve(dir.path(), "sessions"), storage);
		const fail = spyOn(storage, "writeTextAtomic").mockRejectedValue(new Error("Injected journal failure"));
		try {
			const h = await harness({ manager });
			await expect(h.declaration).rejects.toThrow("Injected journal failure");
			await expect(h.session.prompt("REJECTED_UNDURABLE")).rejects.toThrow("runtime requirement");
			expect(h.modelCalls()).toBe(0);
		} finally {
			fail.mockRestore();
			await manager.recoverPersistenceFromCurrentState();
			cleanups.unshift(async () => dir.removeSync());
		}
	});

	it("rejects a formerly true check if the owning session changed while it was pending", async () => {
		const h = await harness();
		await h.declaration;
		const deferred = Promise.withResolvers<{ signal: AbortSignal; resolve: (value: boolean) => void }>();
		h.bus.on("guard-deferred", value =>
			deferred.resolve(value as { signal: AbortSignal; resolve: (value: boolean) => void }),
		);
		h.bus.emit("guard-state", "defer");
		const prompt = h.session.prompt("REJECTED_OLD_SESSION");
		let settled = false;
		const result = prompt.then(
			() => {
				settled = true;
				return null;
			},
			error => {
				settled = true;
				return error;
			},
		);
		const check = await deferred.promise;
		expect(settled).toBe(false);
		await h.session.newSession();
		check.resolve(true);
		expect(await result).toBeInstanceOf(RuntimeRequirementError);
		expect(h.modelCalls()).toBe(0);
		h.bus.emit("guard-state", "pass");
		await h.session.prompt("NEW_UNMARKED_SESSION");
		expect(h.modelCalls()).toBe(1);
	});

	it("cancels an in-flight satisfaction check when the caller aborts", async () => {
		const h = await harness();
		await h.declaration;
		const deferred = Promise.withResolvers<{ signal: AbortSignal; resolve: (value: boolean) => void }>();
		h.bus.on("guard-deferred", value =>
			deferred.resolve(value as { signal: AbortSignal; resolve: (value: boolean) => void }),
		);
		h.bus.emit("guard-state", "defer");
		const prompt = h.session.prompt("REJECTED_CANCELLED");
		const result = prompt.then(
			() => null,
			error => error,
		);
		const check = await deferred.promise;
		expect(check.signal.aborted).toBe(false);
		await h.session.abort();
		const wasAborted = check.signal.aborted;
		check.resolve(true);
		expect(await result).toBeInstanceOf(RuntimeRequirementError);
		expect(wasAborted).toBe(true);
		expect(h.modelCalls()).toBe(0);
	});

	for (const invalid of [null, [], { schemaVersion: 2 }, [null]] as const) {
		it(`keeps malformed requirement history readable and refuses repair by declaration: ${JSON.stringify(invalid)}`, async () => {
			const original = await harness();
			await original.declaration;
			original.manager.appendMessage({ role: "user", content: "READABLE_HISTORY", timestamp: Date.now() });
			await original.manager.flushSession();
			const file = original.manager.getSessionFile()!;
			const journal = Bun.JSONL.parse(await Bun.file(file).text());
			const header = journal.find(
				(entry): entry is Record<string, unknown> =>
					entry !== null && typeof entry === "object" && "type" in entry && entry.type === "session",
			);
			if (!header) throw new Error("Missing journal header");
			header.runtimeRequirements = invalid;
			const corruptFile = path.join(path.dirname(file), `invalid-${Bun.randomUUIDv7()}.jsonl`);
			await Bun.write(corruptFile, journal.map(entry => JSON.stringify(entry)).join("\n") + "\n");
			const cold = await harness({ file: corruptFile, extensionPath: original.extensionPath });
			await expect(cold.declaration).rejects.toThrow("runtime requirement");
			expect(cold.manager.getHeader()?.runtimeRequirements).toEqual(invalid);
			expect(JSON.stringify(cold.manager.getEntries())).toContain("READABLE_HISTORY");
			await expect(cold.session.prompt("INVALID_MARKER_DRAFT")).rejects.toThrow("runtime requirement");
			expect(cold.modelCalls()).toBe(0);
		});
	}

	it("preserves requirements through branch selection, compaction, and a replicated snapshot", async () => {
		const h = await harness();
		await h.declaration;
		const first = h.manager.appendMessage({ role: "user", content: "RETAINED_HISTORY", timestamp: Date.now() });
		h.manager.appendMessage({ role: "user", content: "Other branch", timestamp: Date.now() });
		h.manager.branch(first);
		h.manager.appendCompaction("Summary", undefined, first, 100);
		const snapshot = h.manager.snapshotForReplication();
		const replica = path.join(path.dirname(h.manager.getSessionFile()!), "replica.jsonl");
		await Bun.write(
			replica,
			[snapshot.header, ...snapshot.entries].map(entry => JSON.stringify(entry)).join("\n") + "\n",
		);
		const cold = await harness({ file: replica, extension: false });
		expect(cold.manager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		await expect(cold.session.prompt("REPLICATED_DRAFT")).rejects.toThrow("runtime requirement");
		expect(cold.modelCalls()).toBe(0);
	});

	it("reports memory-only declaration without pretending a journal was persisted", async () => {
		const h = await harness({ manager: SessionManager.inMemory() });
		expect(await h.declaration).toMatchObject({ persistence: "memory-only" });
		await h.session.prompt("VALID_MEMORY_TURN");
		expect(h.modelCalls()).toBe(1);
	});

	for (const operation of ["compact", "handoff"] as const) {
		it(`refuses host-owned ${operation} inference while the required extension is unavailable`, async () => {
			const original = await harness();
			await original.declaration;
			const cold = await harness({ file: original.manager.getSessionFile(), extension: false });
			await expect(cold.session[operation]()).rejects.toThrow("runtime requirement");
			expect(cold.side.calls).toHaveLength(0);
			expect(cold.modelCalls()).toBe(0);
		});
	}

	it("rechecks at the auxiliary provider after compaction preparation invalidates runtime satisfaction", async () => {
		const h = await harness();
		await h.declaration;
		h.session.settings.set("compaction.keepRecentTokens", 1);
		await h.session.prompt("First context message with details to summarize");
		await h.session.prompt("Second context message with further details");
		h.bus.emit("fail-on-compaction", true);
		await expect(h.session.compact()).rejects.toThrow("runtime requirement");
		expect(h.side.calls).toHaveLength(0);
	});

	it("refuses title dispatch if runtime satisfaction changes during provider preparation", async () => {
		const h = await harness();
		await h.declaration;
		h.session.settings.set("providers.tinyModel", "online");
		const key = spyOn(h.registry, "getApiKey").mockImplementation(async () => {
			h.bus.emit("guard-state", "fail");
			return "test-key";
		});
		let titleCalls = 0;
		const complete = spyOn(ai, "completeSimple").mockImplementation(async (model, context, options) => {
			titleCalls++;
			return (await h.side.stream(model, context, options)).result();
		});
		try {
			await expect(h.session.generateTitle("Inspect runtime attachment failures")).rejects.toThrow(
				"runtime requirement",
			);
			expect(titleCalls).toBe(0);
		} finally {
			key.mockRestore();
			complete.mockRestore();
		}
	});

	it("does not dispatch a tool if its runtime became unavailable during the preceding provider call", async () => {
		const h = await harness();
		await h.declaration;
		let toolCalls = 0;
		h.session.agent.setTools([
			{
				name: "probe",
				label: "Probe",
				description: "Observe tool dispatch",
				parameters: type({}),
				execute: async () => {
					toolCalls++;
					return { content: [{ type: "text", text: "Executed" }], details: {} };
				},
			},
		]);
		const response = createMockModel({
			handler: () => {
				h.bus.emit("guard-state", "fail");
				return { content: [{ type: "toolCall", name: "probe", arguments: {} }] };
			},
		});
		h.session.agent.streamFn = response.stream;
		await h.session.prompt("Initially admitted request");
		expect(response.calls).toHaveLength(1);
		expect(toolCalls).toBe(0);
	});

	it("does not drain a protected aside after satisfaction is revoked mid-turn", async () => {
		const h = await harness();
		await h.declaration;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const response = createMockModel({
			handler: async () => {
				entered.resolve();
				await release.promise;
				return { content: ["Done"] };
			},
		});
		h.session.agent.streamFn = response.stream;
		const running = h.session.prompt("Initially admitted");
		await entered.promise;
		await h.session.sendCustomMessageWithReceipt(
			{ customType: "probe", content: "PROTECTED_ASIDE" },
			{ deliverAs: "aside" },
		);
		h.bus.emit("guard-state", "fail");
		release.resolve();
		await running;
		await h.session.waitForIdle();
		expect(JSON.stringify(h.session.agent.state.messages)).not.toContain("PROTECTED_ASIDE");
		expect(response.calls).toHaveLength(1);
		h.bus.emit("guard-state", "pass");
		await h.session.prompt("Resume preserved aside");
		expect(JSON.stringify(h.session.agent.state.messages)).toContain("PROTECTED_ASIDE");
	});
	it("keeps same-journal navigation and compaction outside the ready lifecycle", async () => {
		const h = await harness();
		await h.declaration;
		let ready = 0;
		h.bus.on("guard-ready", () => {
			ready++;
		});
		const sessionId = h.session.sessionId;
		const requirements = h.manager.getRuntimeRequirements();
		const first = h.manager.appendMessage({ role: "user", content: "First history node", timestamp: Date.now() });
		h.manager.appendMessage({ role: "user", content: "Second history node", timestamp: Date.now() });
		await h.session.navigateTree(first);
		expect(h.session.sessionId).toBe(sessionId);
		expect(ready).toBe(0);
		h.session.settings.set("compaction.keepRecentTokens", 1);
		await h.session.prompt("Add enough context to retain a recent turn");
		await h.session.prompt("Add another turn to summarize");
		await h.session.compact();
		expect(ready).toBe(0);
		expect(h.manager.getRuntimeRequirements()).toEqual(requirements);
	});

	it("accepts native absolute marker paths and rejects relative executable identities", () => {
		const requirement = {
			schemaVersion: 1 as const,
			path: path.resolve("runtime.ts"),
			sha256: "a".repeat(64),
			id: "fixture.path",
			version: 1,
		};
		expect(readRuntimeRequirements([requirement], "session")).toEqual([requirement]);
		expect(() => readRuntimeRequirements([{ ...requirement, path: "runtime.ts" }], "session")).toThrow(
			"runtime requirement",
		);
	});

	it("keeps a concurrent pending declaration latched after another declaration completes", async () => {
		const h = await harness();
		await h.declaration;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<boolean>();
		const second = h.session.requireRuntime(h.loaded.extensions[0]!, {
			sessionId: h.session.sessionId,
			id: "fixture.second",
			version: 1,
			check: () => {
				entered.resolve();
				return release.promise;
			},
		});
		await entered.promise;
		await h.session.requireRuntime(h.loaded.extensions[0]!, {
			sessionId: h.session.sessionId,
			id: "fixture.third",
			version: 1,
			check: () => true,
		});
		h.session.agent.steer({ role: "user", content: "PRESERVED", timestamp: Date.now() });
		await expect(h.session.agent.continue()).rejects.toThrow("declaration has not completed");
		expect(h.session.agent.peekSteeringQueue()).toHaveLength(1);
		expect(h.modelCalls()).toBe(0);
		release.resolve(true);
		await second;
	});

	it("revalidates the requirement set when a new declaration finishes during a fresh check", async () => {
		const h = await harness();
		await h.declaration;
		const entered = Promise.withResolvers<{ resolve: (value: boolean) => void }>();
		h.bus.on("guard-deferred", value => entered.resolve(value as { resolve: (value: boolean) => void }));
		h.bus.emit("guard-state", "defer");
		let settled = false;
		const result = h.session.agent.prompt("NOT_ADMITTED").then(
			() => {
				settled = true;
				return null;
			},
			error => {
				settled = true;
				return error;
			},
		);
		const check = await entered.promise;
		await h.session.requireRuntime(h.loaded.extensions[0]!, {
			sessionId: h.session.sessionId,
			id: "fixture.concurrent",
			version: 1,
			check: () => true,
		});
		expect(settled).toBe(false);
		check.resolve(true);
		expect(await result).toBeInstanceOf(RuntimeRequirementError);
		expect(h.session.agent.state.messages).toEqual([]);
		expect(h.modelCalls()).toBe(0);
	});

	it("refuses declaration acknowledgement when restoration begins while persistence is pending", async () => {
		const dir = TempDir.createSync("runtime-pending-persistence-");
		const enteredPersistence = Promise.withResolvers<void>();
		const releasePersistence = Promise.withResolvers<void>();
		const enteredRestore = Promise.withResolvers<void>();
		const releaseRestore = Promise.withResolvers<void>();
		// Hold the real writer at its persistence boundary without mocking its implementation.
		const storage = new (class extends FileSessionStorage {
			pause = false;

			override async writeTextAtomic(
				fpath: string,
				content: string,
				options?: WriteTextAtomicOptions,
			): Promise<void> {
				if (this.pause) {
					enteredPersistence.resolve();
					await releasePersistence.promise;
				}
				await super.writeTextAtomic(fpath, content, options);
			}
		})();
		const manager = SessionManager.create(path.resolve(dir.path()), path.resolve(dir.path(), "sessions"), storage);
		cleanups.push(async () => dir.removeSync());
		const h = await harness({ manager });
		await h.declaration;
		const target = await harness({ extension: false });
		await target.manager.ensureOnDisk();
		storage.pause = true;
		// Bun may enter afterEach when a test times out before its finally has
		// unwound. Release test-owned gates before any harness disposal then too.
		cleanups.push(async () => {
			storage.pause = false;
			releasePersistence.resolve();
			releaseRestore.resolve();
		});
		h.bus.emit("defer-switch", true);
		h.bus.on("switch-deferred", value => {
			const gate = value as { resolve: () => void };
			enteredRestore.resolve();
			void releaseRestore.promise.then(() => gate.resolve());
		});
		let declaration: Promise<SessionPersistenceReceipt> | undefined;
		let switching: Promise<boolean> | undefined;
		try {
			declaration = h.session.requireRuntime(h.loaded.extensions[0]!, {
				sessionId: h.session.sessionId,
				id: "fixture.pending",
				version: 1,
				check: () => true,
			});
			let declarationSettled = false;
			// Observe settlement without invoking a rejection matcher before the
			// test has released the operation it is expecting to reject.
			const outcome = declaration.then(
				receipt => {
					declarationSettled = true;
					return receipt;
				},
				(error: unknown) => {
					declarationSettled = true;
					return error;
				},
			);
			await withTimeout(enteredPersistence.promise, 2_000, "Declaration did not reach atomic persistence");
			switching = h.session.switchSession(target.manager.getSessionFile()!, { preserveLocalCwd: true });
			await withTimeout(enteredRestore.promise, 2_000, "Session transition did not reach its before-switch event");
			expect(declarationSettled).toBe(false);
			releasePersistence.resolve();
			const result = await withTimeout(
				outcome,
				2_000,
				"Declaration acknowledgement did not settle after releasing its disk write",
			);
			expect(result).toBeInstanceOf(RuntimeRequirementError);
			expect(h.modelCalls()).toBe(0);
			await expect(
				h.session.requireRuntime(h.loaded.extensions[0]!, {
					sessionId: h.session.sessionId,
					id: "fixture.during-transition",
					version: 1,
					check: () => true,
				}),
			).rejects.toBeInstanceOf(RuntimeRequirementError);
			releaseRestore.resolve();
			await withTimeout(switching, 2_000, "Session transition did not settle after releasing its lifecycle event");
		} finally {
			storage.pause = false;
			releasePersistence.resolve();
			releaseRestore.resolve();
			await withTimeout(
				Promise.allSettled([declaration, switching]),
				2_000,
				"Persistence fixture operations did not drain after releasing both gates",
			);
		}
	});

	it("refuses provider and dequeue during restoration, then allows attachment inside session_ready", async () => {
		const h = await harness();
		await h.declaration;
		const copy = await h.manager.persistCopy({ sessionDir: path.dirname(h.manager.getSessionFile()!) });
		cleanups.push(() => copy.close());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let attached = false;
		h.bus.emit("attach-on-ready", true);
		h.bus.on("ready-attached", () => {
			attached = true;
		});
		h.session.setSessionSwitchReconciler(async () => {
			entered.resolve();
			await release.promise;
		});
		const switching = h.session.switchSession(copy.getSessionFile()!, { preserveLocalCwd: true });
		await entered.promise;
		h.session.agent.steer({ role: "user", content: "QUEUED_DURING_RESTORE", timestamp: Date.now() });
		await expect(h.session.agent.continue()).rejects.toThrow("restoring");
		expect(h.session.agent.peekSteeringQueue()).toHaveLength(1);
		expect(h.modelCalls()).toBe(0);
		expect(attached).toBe(false);
		release.resolve();
		await switching;
		expect(attached).toBe(true);
		await h.session.agent.continue();
		expect(h.modelCalls()).toBe(1);
	});

	it("preserves idle yield entries without building them on refusal and delivers them after recovery", async () => {
		const h = await harness();
		await h.declaration;
		let builds = 0;
		h.session.yieldQueue.register<string>("runtime-probe", {
			skipIdleFlush: true,
			build: entries => {
				builds++;
				return { role: "user", content: entries.join(" "), timestamp: Date.now() };
			},
		});
		h.session.yieldQueue.enqueue("runtime-probe", "PRESERVED_YIELD");
		h.bus.emit("guard-state", "fail");
		await expect(h.session.yieldQueue.flush("streaming")).rejects.toThrow("runtime requirement");
		expect(h.session.yieldQueue.has("runtime-probe")).toBe(true);
		expect(builds).toBe(0);
		expect(h.modelCalls()).toBe(0);
		h.bus.emit("guard-state", "pass");
		await h.session.prompt("Resume");
		expect(builds).toBe(1);
		expect(h.session.yieldQueue.has("runtime-probe")).toBe(false);
	});

	it("restores an idle yield batch if the shared run gate refuses after building it", async () => {
		const h = await harness();
		await h.declaration;
		h.session.yieldQueue.register<string>("runtime-idle-probe", {
			build: entries => {
				h.bus.emit("guard-state", "fail");
				return { role: "user", content: entries.join(" "), timestamp: Date.now() };
			},
		});
		h.session.yieldQueue.enqueue("runtime-idle-probe", "PRESERVED_IDLE_YIELD");
		await h.session.yieldQueue.flush("idle");
		expect(h.session.yieldQueue.has("runtime-idle-probe")).toBe(true);
		expect(h.modelCalls()).toBe(0);
		expect(JSON.stringify(h.session.agent.state.messages)).not.toContain("PRESERVED_IDLE_YIELD");
	});

	it("keeps hidden next-turn messages queued when before_agent_start revokes satisfaction", async () => {
		const h = await harness();
		await h.declaration;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const response = createMockModel({
			handler: async () => {
				entered.resolve();
				await release.promise;
				return { content: ["Done"] };
			},
		});
		h.session.agent.streamFn = response.stream;
		const running = h.session.prompt("Initial admitted turn");
		try {
			await entered.promise;
			const receipt = await h.session.sendCustomMessageWithReceipt(
				{ customType: "probe", content: "PRESERVED_HIDDEN" },
				{ deliverAs: "nextTurn" },
			);
			expect(receipt).toMatchObject({ admitted: true, location: "queue" });
			expect(h.session.queuedMessageCount).toBe(1);
		} finally {
			release.resolve();
			await running;
		}
		h.bus.emit("fail-before-start", true);
		await expect(h.session.prompt("REFUSED_DRAFT")).rejects.toThrow("runtime requirement");
		expect(h.session.queuedMessageCount).toBe(1);
		expect(response.calls).toHaveLength(1);
		expect(JSON.stringify(h.session.agent.state.messages)).not.toContain("PRESERVED_HIDDEN");
	});

	it("persists only bounded printable recovery guidance and displays it without loading it", async () => {
		const h = await harness();
		await h.declaration;
		await h.session.requireRuntime(h.loaded.extensions[0]!, {
			sessionId: h.session.sessionId,
			id: "fixture.hint",
			version: 1,
			check: () => true,
			recoveryHint: `Open the runtime settings\n\u001b[31m ${"x".repeat(2000)}`,
		});
		const hint = h.manager.getRuntimeRequirements().find(item => item.id === "fixture.hint")?.recoveryHint;
		expect(hint?.length).toBeLessThanOrEqual(512);
		expect(hint).not.toMatch(/[\p{Cc}\p{Cf}]/u);
		const cold = await harness({ file: h.manager.getSessionFile(), extension: false });
		// The first saved requirement has no hint; isolate the hinted requirement's failed check.
		await h.session
			.requireRuntime(h.loaded.extensions[0]!, {
				sessionId: h.session.sessionId,
				id: "fixture.hint",
				version: 1,
				check: () => false,
			})
			.catch(() => {});
		await expect(h.session.agent.prompt("REFUSED_HINT")).rejects.toThrow("Recovery guidance (display only)");
		expect(cold.loaded.extensions).toEqual([]);
		expect(h.modelCalls()).toBe(0);
	});

	it("rejects forged extension objects and genuine extensions owned by another runner", async () => {
		const h = await harness();
		await h.declaration;
		const other = await harness();
		await other.declaration;
		for (const extension of [{ ...h.loaded.extensions[0]! }, other.loaded.extensions[0]!]) {
			await expect(
				h.session.requireRuntime(extension, {
					sessionId: h.session.sessionId,
					id: "fixture.forged",
					version: 1,
					check: () => true,
				}),
			).rejects.toThrow("provenance");
		}
		const extension = h.loaded.extensions[0]!;
		const originalPath = extension.resolvedPath;
		extension.resolvedPath = other.extensionPath;
		try {
			await expect(
				h.session.requireRuntime(extension, {
					sessionId: h.session.sessionId,
					id: "fixture.wrong-origin",
					version: 1,
					check: () => true,
				}),
			).rejects.toThrow("provenance");
		} finally {
			extension.resolvedPath = originalPath;
		}
	});

	it("does not grant provenance to copied or modified prepared factory records", async () => {
		const h = await harness();
		await h.declaration;
		const prepared = h.loaded.preparedExtensions![0]!;
		const copied = await bindPreparedExtensions([{ ...prepared }], h.manager.getCwd());
		const modified = await bindPreparedExtensions([{ ...prepared, factory: () => {} }], h.manager.getCwd());
		try {
			expect(await getLoadedRuntimeOrigin(copied.extensions[0]!, copied.runtime)).toBeUndefined();
			expect(await getLoadedRuntimeOrigin(modified.extensions[0]!, modified.runtime)).toBeUndefined();
			const originalFactory = prepared.factory;
			prepared.factory = () => {};
			const swapped = await bindPreparedExtensions([prepared], h.manager.getCwd());
			prepared.factory = originalFactory;
			try {
				expect(await getLoadedRuntimeOrigin(swapped.extensions[0]!, swapped.runtime)).toBeUndefined();
			} finally {
				disposeLoadedExtensions(swapped);
			}
			await Bun.write(h.extensionPath, "export default function() {}");
			const stale = await bindPreparedExtensions([prepared], h.manager.getCwd());
			try {
				expect(await getLoadedRuntimeOrigin(stale.extensions[0]!, stale.runtime)).toBeUndefined();
			} finally {
				disposeLoadedExtensions(stale);
			}
		} finally {
			disposeLoadedExtensions(copied);
			disposeLoadedExtensions(modified);
		}
	});

	it("never assigns changed entry bytes to a reused executable factory object", async () => {
		const dir = TempDir.createSync("runtime-factory-cache-");
		const file = path.resolve(dir.path(), "cached.ts");
		const key = `runtimeFactory${Bun.randomUUIDv7().replaceAll("-", "")}`;
		const source = `export default (globalThis[${JSON.stringify(key)}] ??= function() {});`;
		await Bun.write(file, source);
		const first = await loadExtensions([file], dir.path());
		await Bun.write(file, `${source}\n// changed entry identity`);
		const second = await loadExtensions([file], dir.path());
		try {
			expect(first.errors).toEqual([]);
			expect(second.errors).toEqual([]);
			expect(await getLoadedRuntimeOrigin(second.extensions[0]!, second.runtime)).toBeUndefined();
		} finally {
			disposeLoadedExtensions(first);
			disposeLoadedExtensions(second);
			Reflect.deleteProperty(globalThis, key);
			dir.removeSync();
		}
	});

	it("leaves an ordinary unmarked session usable without any extension", async () => {
		const h = await harness({ extension: false });
		await h.session.prompt("ORDINARY");
		await h.session.newSession();
		await h.session.prompt("ORDINARY_NEW");
		expect(h.modelCalls()).toBe(2);
		expect(h.manager.getRuntimeRequirements()).toEqual([]);
	});
});
