import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ExtensionRuntime,
	getRequiredExtensionAttestation,
	loadExtensionFromFactory,
	loadExtensionsWithRequiredAttestation,
	type RequiredExtensionSpec,
	RequiredExtensionStartupError,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

function sha256(content: string): string {
	return new Bun.SHA256().update(content).digest("hex");
}

describe("required extension startup gate", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("required-extension-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("attests the exact path, hash, enabled state, and tool_call handler", async () => {
		const content = `export default function (pi) { pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.resolve(tempDir.path(), "guard.ts");
		fs.writeFileSync(extensionPath, content);

		const result = await loadExtensionsWithRequiredAttestation(
			{ paths: [extensionPath] },
			path.resolve(tempDir.path()),
			new EventBus(),
			{
				required: {
					path: extensionPath,
					extensionId: "extension-module:guard",
					expectedSha256: sha256(content),
				},
			},
		);

		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.resolvedPath).toBe(extensionPath);
	});

	it("rejects a hash mismatch before any extension factory executes", async () => {
		const marker = path.resolve(tempDir.path(), "factory-ran");
		const content = `import * as fs from "node:fs"; export default function (pi) { fs.writeFileSync(${JSON.stringify(marker)}, "yes"); pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.resolve(tempDir.path(), "guard.ts");
		fs.writeFileSync(extensionPath, content);

		try {
			await loadExtensionsWithRequiredAttestation(
				{ paths: [extensionPath] },
				path.resolve(tempDir.path()),
				new EventBus(),
				{
					required: {
						path: extensionPath,
						extensionId: "extension-module:guard",
						expectedSha256: "0".repeat(64),
					},
				},
			);
			throw new Error("expected required extension startup failure");
		} catch (error) {
			expect(error).toBeInstanceOf(RequiredExtensionStartupError);
			expect((error as RequiredExtensionStartupError).code).toBe("hash-mismatch");
		}
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("rejects a disabled required extension before loading it", async () => {
		const marker = path.resolve(tempDir.path(), "disabled-ran");
		const content = `import * as fs from "node:fs"; export default function (pi) { fs.writeFileSync(${JSON.stringify(marker)}, "yes"); pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.resolve(tempDir.path(), "disabled.ts");
		fs.writeFileSync(extensionPath, content);

		await expect(
			loadExtensionsWithRequiredAttestation(
				{ paths: [extensionPath] },
				path.resolve(tempDir.path()),
				new EventBus(),
				{
					required: {
						path: extensionPath,
						extensionId: "extension-module:disabled",
						expectedSha256: sha256(content),
					},
					disabledExtensionIds: ["extension-module:disabled"],
				},
			),
		).rejects.toMatchObject({ code: "disabled" });
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("rejects a missing required extension", async () => {
		const extensionPath = path.resolve(tempDir.path(), "missing.ts");
		await expect(
			loadExtensionsWithRequiredAttestation(
				{ paths: [extensionPath] },
				path.resolve(tempDir.path()),
				new EventBus(),
				{
					required: {
						path: extensionPath,
						extensionId: "extension-module:missing",
						expectedSha256: "0".repeat(64),
					},
				},
			),
		).rejects.toMatchObject({ code: "missing" });
	});

	it("rejects factory failures as terminal load failures", async () => {
		const content = `export default function () { throw new Error("factory exploded"); }`;
		const extensionPath = path.resolve(tempDir.path(), "broken.ts");
		fs.writeFileSync(extensionPath, content);
		await expect(
			loadExtensionsWithRequiredAttestation(
				{ paths: [extensionPath] },
				path.resolve(tempDir.path()),
				new EventBus(),
				{
					required: {
						path: extensionPath,
						extensionId: "extension-module:broken",
						expectedSha256: sha256(content),
					},
				},
			),
		).rejects.toMatchObject({ code: "load-failed" });
	});

	it("rejects import failures as terminal load failures", async () => {
		const content = `export default function (`;
		const extensionPath = path.resolve(tempDir.path(), "invalid-syntax.ts");
		fs.writeFileSync(extensionPath, content);
		await expect(
			loadExtensionsWithRequiredAttestation(
				{ paths: [extensionPath] },
				path.resolve(tempDir.path()),
				new EventBus(),
				{
					required: {
						path: extensionPath,
						extensionId: "extension-module:invalid-syntax",
						expectedSha256: sha256(content),
					},
				},
			),
		).rejects.toMatchObject({ code: "load-failed" });
	});

	it("does not accept a sibling extension's tool_call handler", async () => {
		const requiredContent = `export default function (pi) { pi.on("session_start", async () => {}); }`;
		const siblingContent = `export default function (pi) { pi.on("tool_call", async () => {}); }`;
		const requiredPath = path.resolve(tempDir.path(), "required.ts");
		const siblingPath = path.resolve(tempDir.path(), "sibling.ts");
		fs.writeFileSync(requiredPath, requiredContent);
		fs.writeFileSync(siblingPath, siblingContent);

		await expect(
			loadExtensionsWithRequiredAttestation(
				{ paths: [requiredPath, siblingPath] },
				path.resolve(tempDir.path()),
				new EventBus(),
				{
					required: {
						path: requiredPath,
						extensionId: "extension-module:required",
						expectedSha256: sha256(requiredContent),
					},
				},
			),
		).rejects.toMatchObject({ code: "handler-missing" });
	});

	it("preserves optional extension load errors when no requirement is configured", async () => {
		const content = `export default function () { throw new Error("optional failure"); }`;
		const extensionPath = path.resolve(tempDir.path(), "optional.ts");
		fs.writeFileSync(extensionPath, content);

		const result = await loadExtensionsWithRequiredAttestation(
			{ paths: [extensionPath] },
			path.resolve(tempDir.path()),
			new EventBus(),
		);
		expect(result.extensions).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain("optional failure");
	});

	it("re-attests an exact preloaded extension result", async () => {
		const content = `export default function (pi) { pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.resolve(tempDir.path(), "preloaded.ts");
		fs.writeFileSync(extensionPath, content);
		const required = {
			path: extensionPath,
			extensionId: "extension-module:preloaded",
			expectedSha256: sha256(content),
		};
		const preloaded = await loadExtensionsWithRequiredAttestation(
			{ paths: [extensionPath] },
			path.resolve(tempDir.path()),
			new EventBus(),
			{ required },
		);

		const result = await loadExtensionsWithRequiredAttestation(
			{ preloaded },
			path.resolve(tempDir.path()),
			new EventBus(),
			{ required },
		);
		expect(result).not.toBe(preloaded);
		expect(result.extensions).toEqual(preloaded.extensions);
	});

	it("rejects caller-forged replacement of a loader-attested preloaded extension", async () => {
		const content = `export default function (pi) { pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.resolve(tempDir.path(), "provenance-required.ts");
		fs.writeFileSync(extensionPath, content);
		const required = {
			path: extensionPath,
			extensionId: "extension-module:provenance-required",
			expectedSha256: sha256(content),
		};
		const preloaded = await loadExtensionsWithRequiredAttestation(
			{ paths: [extensionPath] },
			path.resolve(tempDir.path()),
			new EventBus(),
			{ required },
		);
		const original = preloaded.extensions[0];
		if (!original) throw new Error("expected loader-produced extension");
		preloaded.extensions[0] = {
			...original,
			handlers: new Map([["tool_call", [async () => undefined]]]),
		};
		await expect(
			loadExtensionsWithRequiredAttestation({ preloaded }, path.resolve(tempDir.path()), new EventBus(), {
				required,
			}),
		).rejects.toMatchObject({ code: "load-failed" });
	});

	it("rejects a forged runtime on a loader-attested preloaded result", async () => {
		const content = `export default function (pi) {
			pi.registerFlag("runtime-bound-flag", { type: "boolean", default: true });
			pi.registerStatusSegment({ id: "runtime-bound-status", placement: { afterBuiltin: "model", fallback: "anchor-side-end-else-right" }, render: () => "bound" });
			pi.on("tool_call", async () => {});
		}`;
		const extensionPath = path.resolve(tempDir.path(), "runtime-bound-required.ts");
		fs.writeFileSync(extensionPath, content);
		const required = {
			path: extensionPath,
			extensionId: "extension-module:runtime-bound-required",
			expectedSha256: sha256(content),
		};
		const preloaded = await loadExtensionsWithRequiredAttestation(
			{ paths: [extensionPath] },
			path.resolve(tempDir.path()),
			new EventBus(),
			{ required },
		);
		const attestedRuntime = preloaded.runtime;
		preloaded.runtime = new ExtensionRuntime();
		await expect(
			loadExtensionsWithRequiredAttestation({ preloaded }, path.resolve(tempDir.path()), new EventBus(), {
				required,
			}),
		).rejects.toMatchObject({ code: "load-failed" });
		expect(attestedRuntime.flagValues.size).toBe(0);
		const replacement = await loadExtensionFromFactory(
			pi => {
				pi.registerStatusSegment({
					id: "runtime-bound-status",
					placement: { afterBuiltin: "model", fallback: "anchor-side-end-else-right" },
					render: () => "replacement",
				});
			},
			path.resolve(tempDir.path()),
			new EventBus(),
			attestedRuntime,
			"runtime-replacement",
		);
		expect(replacement.statusSegments?.size).toBe(1);
	});

	it("rolls back every runtime registration from a failed optional factory", async () => {
		const failedContent = `export default function (pi) {
			pi.registerFlag("failed-flag", { type: "boolean", default: true });
			pi.registerProvider("failed-provider", { baseUrl: "https://failed.example.com", api: "openai-completions" });
			pi.registerStatusSegment({ id: "shared-status", render: () => "failed" });
			throw new Error("rollback me");
		}`;
		const successContent = `export default function (pi) {
			pi.registerFlag("success-flag", { type: "boolean", default: true });
			pi.registerProvider("success-provider", { baseUrl: "https://success.example.com", api: "openai-completions" });
			pi.registerStatusSegment({ id: "shared-status", render: () => "success" });
		}`;
		const failedPath = path.resolve(tempDir.path(), "failed-transaction.ts");
		const successPath = path.resolve(tempDir.path(), "success-transaction.ts");
		fs.writeFileSync(failedPath, failedContent);
		fs.writeFileSync(successPath, successContent);

		const result = await loadExtensionsWithRequiredAttestation(
			{ paths: [failedPath, successPath] },
			path.resolve(tempDir.path()),
			new EventBus(),
		);
		expect(result.errors).toHaveLength(1);
		expect(result.extensions).toHaveLength(1);
		expect(result.runtime.flagValues.has("failed-flag")).toBe(false);
		expect(result.runtime.flagValues.get("success-flag")).toBe(true);
		expect(result.runtime.pendingProviderRegistrations.map(item => item.name)).toEqual(["success-provider"]);
		expect(result.extensions[0]?.statusSegments?.size).toBe(1);
	});

	it("disposes all loaded status and runtime state when terminal attestation fails", async () => {
		const nestedEventMarker = path.resolve(tempDir.path(), "nested-event-listener-ran");
		const content = `import * as fs from "node:fs"; export default function (pi) {
			pi.registerFlag("guard-flag", { type: "boolean", default: true });
			pi.registerProvider("guard-provider", { baseUrl: "https://guard.example.com", api: "openai-completions" });
			pi.registerStatusSegment({ id: "guard-status", render: () => "guard" });
			pi.events.on("register-nested", () => {
				pi.events.on("nested-required-probe", () => fs.writeFileSync(${JSON.stringify(nestedEventMarker)}, "yes"));
			});
			pi.on("tool_call", async () => {});
		}`;
		const extensionPath = path.resolve(tempDir.path(), "unattested-status.ts");
		fs.writeFileSync(extensionPath, content);
		const required = {
			path: extensionPath,
			extensionId: "extension-module:unattested-status",
			expectedSha256: sha256(content),
		};
		const eventBus = new EventBus();
		const preloaded = await loadExtensionsWithRequiredAttestation(
			{ paths: [extensionPath] },
			path.resolve(tempDir.path()),
			eventBus,
			{ required },
		);
		eventBus.emit("register-nested", undefined);
		const originalToolCallHandlers = preloaded.extensions[0]?.handlers.get("tool_call");
		if (!originalToolCallHandlers) throw new Error("expected required tool_call handlers");
		preloaded.extensions[0]?.handlers.delete("tool_call");
		let disposeCalls = 0;
		const registration = preloaded.extensions[0]?.statusSegments?.values().next().value;
		if (!registration) throw new Error("expected registered status segment");
		registration.disposeUI = () => {
			disposeCalls++;
		};

		await expect(
			loadExtensionsWithRequiredAttestation({ preloaded }, path.resolve(tempDir.path()), new EventBus(), {
				required,
			}),
		).rejects.toMatchObject({ code: "handler-missing" });
		eventBus.emit("nested-required-probe", undefined);
		expect(fs.existsSync(nestedEventMarker)).toBe(false);
		expect(disposeCalls).toBe(1);
		expect(preloaded.extensions[0]?.statusSegments?.size).toBe(0);
		expect(preloaded.runtime.flagValues.size).toBe(0);
		expect(preloaded.runtime.pendingProviderRegistrations).toHaveLength(0);
		expect(getRequiredExtensionAttestation(preloaded)).toBeUndefined();
		preloaded.extensions[0]?.handlers.set("tool_call", originalToolCallHandlers);
		await expect(
			loadExtensionsWithRequiredAttestation({ preloaded }, path.resolve(tempDir.path()), new EventBus(), {
				required,
			}),
		).rejects.toMatchObject({ code: "load-failed" });
	});

	it("removes EventBus subscriptions from a required factory rejected for a missing handler", async () => {
		const eventMarker = path.resolve(tempDir.path(), "event-listener-ran");
		const content = `import * as fs from "node:fs"; export default function (pi) {
			pi.events.on("required-probe", () => fs.writeFileSync(${JSON.stringify(eventMarker)}, "yes"));
			pi.registerStatusSegment({ id: "event-status", render: () => "event" });
		}`;
		const extensionPath = path.resolve(tempDir.path(), "event-required.ts");
		fs.writeFileSync(extensionPath, content);
		const eventBus = new EventBus();
		await expect(
			loadExtensionsWithRequiredAttestation({ paths: [extensionPath] }, path.resolve(tempDir.path()), eventBus, {
				required: {
					path: extensionPath,
					extensionId: "extension-module:event-required",
					expectedSha256: sha256(content),
				},
			}),
		).rejects.toMatchObject({ code: "handler-missing" });
		eventBus.emit("required-probe", undefined);
		expect(fs.existsSync(eventMarker)).toBe(false);
	});

	it("keeps a rejected factory's deferred EventBus registrations closed", async () => {
		const release = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const state = { release: release.promise, done: completed.resolve };
		const testGlobal = globalThis as typeof globalThis & {
			__ompRequiredExtensionLateRegistration?: typeof state;
		};
		testGlobal.__ompRequiredExtensionLateRegistration = state;
		const eventMarker = path.resolve(tempDir.path(), "late-event-listener-ran");
		const content = `import * as fs from "node:fs"; export default function (pi) {
			globalThis.__ompRequiredExtensionLateRegistration.release.then(() => {
				pi.events.on("late-required-probe", () => fs.writeFileSync(${JSON.stringify(eventMarker)}, "yes"));
				pi.registerFlag("late-required-flag", { type: "boolean", default: true });
				globalThis.__ompRequiredExtensionLateRegistration.done();
			});
		}`;
		const extensionPath = path.resolve(tempDir.path(), "late-event-required.ts");
		fs.writeFileSync(extensionPath, content);
		const eventBus = new EventBus();
		try {
			await expect(
				loadExtensionsWithRequiredAttestation({ paths: [extensionPath] }, path.resolve(tempDir.path()), eventBus, {
					required: {
						path: extensionPath,
						extensionId: "extension-module:late-event-required",
						expectedSha256: sha256(content),
					},
				}),
			).rejects.toMatchObject({ code: "handler-missing" });
			release.resolve();
			await completed.promise;
			eventBus.emit("late-required-probe", undefined);
			expect(fs.existsSync(eventMarker)).toBe(false);
		} finally {
			delete testGlobal.__ompRequiredExtensionLateRegistration;
		}
	});

	it("canonical-deduplicates source paths and preserves a required-path factory error", async () => {
		const counterPath = path.resolve(tempDir.path(), "factory-count");
		const content = `import * as fs from "node:fs";
			export default function (pi) {
				let count = 0;
				try { count = Number(fs.readFileSync(${JSON.stringify(counterPath)}, "utf8")); } catch {}
				fs.writeFileSync(${JSON.stringify(counterPath)}, String(count + 1));
				if (count === 0) throw new Error("first call fails");
				pi.on("tool_call", async () => {});
			}`;
		const extensionPath = path.resolve(tempDir.path(), "stateful-required.ts");
		fs.writeFileSync(extensionPath, content);
		await expect(
			loadExtensionsWithRequiredAttestation(
				{ paths: [extensionPath, `${path.dirname(extensionPath)}/./${path.basename(extensionPath)}`] },
				path.resolve(tempDir.path()),
				new EventBus(),
				{
					required: {
						path: extensionPath,
						extensionId: "extension-module:stateful-required",
						expectedSha256: sha256(content),
					},
				},
			),
		).rejects.toMatchObject({ code: "load-failed" });
		expect(fs.readFileSync(counterPath, "utf8")).toBe("1");
	});

	it("snapshots the required spec before its first asynchronous read", async () => {
		const content = `export default function (pi) { pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.resolve(tempDir.path(), "frozen-required.ts");
		fs.writeFileSync(extensionPath, content);
		const required = {
			path: extensionPath,
			extensionId: "extension-module:frozen-required",
			expectedSha256: "0".repeat(64),
		};
		const loading = loadExtensionsWithRequiredAttestation(
			{ paths: [extensionPath] },
			path.resolve(tempDir.path()),
			new EventBus(),
			{ required },
		);
		required.expectedSha256 = sha256(content);
		await expect(loading).rejects.toMatchObject({ code: "hash-mismatch" });
	});

	it("detects a required entry swap between pre-import hash and completed factory load", async () => {
		const replacement = `export default function () {}`;
		const content = `export default async function (pi) {
			pi.registerFlag("swap-flag", { type: "boolean", default: true });
			pi.on("tool_call", async () => {});
			await Bun.write(import.meta.path, ${JSON.stringify(replacement)});
		}`;
		const extensionPath = path.resolve(tempDir.path(), "swapped-required.ts");
		fs.writeFileSync(extensionPath, content);
		await expect(
			loadExtensionsWithRequiredAttestation(
				{ paths: [extensionPath] },
				path.resolve(tempDir.path()),
				new EventBus(),
				{
					required: {
						path: extensionPath,
						extensionId: "extension-module:swapped-required",
						expectedSha256: sha256(content),
					},
				},
			),
		).rejects.toMatchObject({ code: "hash-mismatch" });
	});

	it("rejects empty or partial requirement shapes before loading any extension", async () => {
		const marker = path.resolve(tempDir.path(), "shape-factory-ran");
		const content = `import * as fs from "node:fs"; export default function (pi) { fs.writeFileSync(${JSON.stringify(marker)}, "yes"); pi.on("tool_call", async () => {}); }`;
		const extensionPath = path.resolve(tempDir.path(), "shape-required.ts");
		fs.writeFileSync(extensionPath, content);
		const cases: Array<{ required: RequiredExtensionSpec; code: RequiredExtensionStartupError["code"] }> = [
			{
				required: { path: "", extensionId: "extension-module:shape", expectedSha256: sha256(content) },
				code: "missing",
			},
			{
				required: { path: extensionPath, extensionId: "", expectedSha256: sha256(content) },
				code: "load-failed",
			},
			{
				required: {
					path: extensionPath,
					extensionId: "extension-module:some-other-file",
					expectedSha256: sha256(content),
				},
				code: "load-failed",
			},
			{
				required: { path: extensionPath, extensionId: "extension-module:shape-required", expectedSha256: "" },
				code: "hash-mismatch",
			},
		];
		for (const testCase of cases) {
			await expect(
				loadExtensionsWithRequiredAttestation(
					{ paths: [extensionPath] },
					path.resolve(tempDir.path()),
					new EventBus(),
					{ required: testCase.required },
				),
			).rejects.toMatchObject({ code: testCase.code });
		}
		expect(fs.existsSync(marker)).toBe(false);
	});
});
