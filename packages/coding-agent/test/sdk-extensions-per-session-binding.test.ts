/**
 * Regression guard for PR review feedback on #2190.
 *
 * Subagents inherit the parent's extension source *paths* (a cheap FS scan
 * the parent already paid for), but each session MUST rebuild its own
 * `Extension` instances so factories see the subagent's `ExtensionAPI`
 * (cwd, eventBus, runtime). Forwarding the parent's loaded Extension
 * instances would have tools/handlers/commands close over the parent's
 * `cwd` and event bus — wrong for isolated tasks.
 *
 * Pins down `loadExtensions()` so the SDK can rely on it returning fresh
 * Extension instances per call.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ExtensionAPI,
	ExtensionRuntime,
	finalizePythonSpawnEnvResolvers,
	loadExtensionFromFactory,
	loadExtensions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("loadExtensions per-session binding (#2190 review fix)", () => {
	let tmp: string;
	let extPath: string;

	beforeAll(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ext-binding-"));
		extPath = path.join(tmp, "record-cwd.ts");
		// Factory tags the extension with the cwd + events it was bound to so
		// the test can inspect what closures captured.
		await fs.writeFile(
			extPath,
			[
				"export default function (api) {",
				"  globalThis.__pythonProfileCounter = (globalThis.__pythonProfileCounter || 0) + 1;",
				"  api.registerPythonSpawnEnv({ PI_EXTENSION_BINDING: api.pythonRuntimeSessionId || String(globalThis.__pythonProfileCounter) });",
				"  api.registerTool({",
				"    name: 'tag',",
				"    description: 'binding probe',",
				"    parameters: api.typebox.Type.Object({}),",
				"    async execute() { return { content: [{ type: 'text', text: '' }] }; },",
				"  });",
				"  Object.defineProperty(globalThis, '__lastExtBinding', {",
				"    value: { cwd: api.exec.toString().includes('cwd') ? api : api, events: api.events },",
				"    writable: true,",
				"    configurable: true,",
				"  });",
				"  globalThis.__bindings = globalThis.__bindings || [];",
				"  globalThis.__bindings.push({ events: api.events });",
				"}",
			].join("\n"),
		);
	});

	afterAll(async () => {
		await removeWithRetries(tmp);
		delete (globalThis as { __bindings?: unknown }).__bindings;
		delete (globalThis as { __lastExtBinding?: unknown }).__lastExtBinding;
		delete (globalThis as { __pythonProfileCounter?: unknown }).__pythonProfileCounter;
	});

	it("creates a distinct Extension and ExtensionAPI per call (fresh eventBus + runtime)", async () => {
		(globalThis as { __bindings?: { events: EventBus }[] }).__bindings = [];
		(globalThis as { __pythonProfileCounter?: number }).__pythonProfileCounter = 0;

		const parentEventBus = new EventBus();
		const subagentEventBus = new EventBus();
		expect(parentEventBus).not.toBe(subagentEventBus);

		const parent = await loadExtensions([extPath], "/tmp/parent-cwd", parentEventBus, {
			pythonRuntimeSessionId: "parent-session",
		});
		const subagent = await loadExtensions([extPath], "/tmp/subagent-cwd", subagentEventBus, {
			pythonRuntimeSessionId: "subagent-session",
		});

		expect(parent.errors).toEqual([]);
		expect(subagent.errors).toEqual([]);
		expect(parent.extensions).toHaveLength(1);
		expect(subagent.extensions).toHaveLength(1);

		// Distinct Extension instances — the subagent must never share with parent.
		expect(subagent.extensions[0]).not.toBe(parent.extensions[0]);
		// Distinct ExtensionRuntime instances — flagValues and pendingProviderRegistrations
		// MUST NOT be shared, or per-session flags/registrations bleed across.
		expect(subagent.runtime).not.toBe(parent.runtime);
		expect(parent.runtime.pythonSpawnEnv).toEqual(new Map([["PI_EXTENSION_BINDING", "parent-session"]]));
		expect(subagent.runtime.pythonSpawnEnv).toEqual(new Map([["PI_EXTENSION_BINDING", "subagent-session"]]));

		// Each factory saw the eventBus passed to its own loadExtensions call.
		const bindings = (globalThis as { __bindings?: { events: EventBus }[] }).__bindings ?? [];
		expect(bindings).toHaveLength(2);
		expect(bindings[0]?.events).toBe(parentEventBus);
		expect(bindings[1]?.events).toBe(subagentEventBus);
	});

	it("rejects conflicting Python spawn environment registrations without corrupting prior state", async () => {
		const runtime = new ExtensionRuntime();
		const eventBus = new EventBus();
		await loadExtensionFromFactory(
			api => api.registerPythonSpawnEnv({ PI_RUNTIME_GUARD_VERSION: "1" }),
			tmp,
			eventBus,
			runtime,
			"<profile-a>",
		);

		await expect(
			loadExtensionFromFactory(
				api => api.registerPythonSpawnEnv({ PI_RUNTIME_GUARD_VERSION: "2" }),
				tmp,
				eventBus,
				runtime,
				"<profile-b>",
			),
		).rejects.toThrow("Conflicting Python environment variable registration");
		expect(runtime.pythonSpawnEnv).toEqual(new Map([["PI_RUNTIME_GUARD_VERSION", "1"]]));
	});

	it("resolves late-bound Python spawn environment before runtime finalization", async () => {
		const runtime = new ExtensionRuntime();
		await loadExtensionFromFactory(
			api => {
				api.registerPythonSpawnEnvResolver(({ pythonPath }) => ({
					PI_RESOLVED_PYTHON: pythonPath ?? "unavailable",
				}));
			},
			tmp,
			new EventBus(),
			runtime,
			"<resolved-profile>",
		);
		expect(runtime.pythonSpawnEnv).toEqual(new Map());

		await finalizePythonSpawnEnvResolvers(runtime, { pythonPath: "/resolved/python" });

		expect(runtime.pythonSpawnEnvFinalized).toBe(true);
		expect(runtime.pythonSpawnEnv).toEqual(new Map([["PI_RESOLVED_PYTHON", "/resolved/python"]]));
	});

	it("makes concurrent Python spawn environment finalizers await one resolution", async () => {
		const runtime = new ExtensionRuntime();
		const resolverStarted = Promise.withResolvers<void>();
		const releaseResolver = Promise.withResolvers<void>();
		let resolverCalls = 0;
		await loadExtensionFromFactory(
			api => {
				api.registerPythonSpawnEnvResolver(async () => {
					resolverCalls += 1;
					resolverStarted.resolve();
					await releaseResolver.promise;
					return { PI_RESOLVED_PROFILE: "ready" };
				});
			},
			tmp,
			new EventBus(),
			runtime,
			"<concurrent-profile>",
		);

		const first = finalizePythonSpawnEnvResolvers(runtime, { pythonPath: "/resolved/python" });
		await resolverStarted.promise;
		let secondFinished = false;
		const second = finalizePythonSpawnEnvResolvers(runtime, { pythonPath: "/other/python" }).finally(() => {
			secondFinished = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(secondFinished).toBe(false);
		expect(runtime.pythonSpawnEnv).toEqual(new Map());

		releaseResolver.resolve();
		await Promise.all([first, second]);
		expect(resolverCalls).toBe(1);
		expect(runtime.pythonSpawnEnv).toEqual(new Map([["PI_RESOLVED_PROFILE", "ready"]]));
	});

	it("rejects Python spawn environment registration after extension loading", async () => {
		const runtime = new ExtensionRuntime();
		let retainedApi: ExtensionAPI | undefined;
		await loadExtensionFromFactory(
			api => {
				retainedApi = api;
			},
			tmp,
			new EventBus(),
			runtime,
			"<late-profile>",
		);
		const api = retainedApi;
		if (!api) throw new Error("Extension API unavailable");

		expect(() => api.registerPythonSpawnEnv({ PI_LATE_PROFILE: "1" })).toThrow(
			"Python spawn environment registration is closed",
		);
		expect(() => api.registerPythonSpawnEnvResolver(() => ({ PI_LATE_RESOLVER: "1" }))).toThrow(
			"Python spawn environment registration is closed",
		);
		expect(runtime.pythonSpawnEnv).toEqual(new Map());
	});
});
