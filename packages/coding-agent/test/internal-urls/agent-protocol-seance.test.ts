import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import type { ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("agent:// seance source isolation", () => {
	let temp: TempDir;
	let sourceDir: string;
	let context: ResolveContext;
	let unregisterForeign: () => void;

	beforeEach(async () => {
		temp = TempDir.createSync("@omp-agent-seance-");
		sourceDir = temp.join("source");
		await Bun.write(path.join(sourceDir, "Historical.md"), "source-only result");
		const foreignDir = temp.join("foreign");
		await Bun.write(path.join(foreignDir, "ForeignPublished.md"), "unrelated output");
		unregisterForeign = registerArtifactsDir(foreignDir);
		const registry = new AgentRegistry();
		registry.register({
			id: "ForeignLive",
			displayName: "ForeignLive",
			kind: "sub",
			status: "running",
			session: {
				messages: [{ role: "assistant", content: [{ type: "text", text: "unrelated live transcript" }] }],
			} as unknown as AgentSession,
		});
		vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
		context = {
			agentRegistry: registry,
			session: {
				cwd: temp.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "",
				settings: Settings.isolated(),
				seanceSourceArtifactsDir: sourceDir,
			},
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
		unregisterForeign();
		temp.removeSync();
	});

	it("refuses foreign live progress from both the caller registry and global fallback", async () => {
		const router = InternalUrlRouter.instance();
		expect((await router.resolve("agent://ForeignLive")).content).toContain("unrelated live transcript");
		await expect(router.resolve("agent://ForeignLive", context)).rejects.toThrow("Not found: ForeignLive");
		const { agentRegistry: _registry, ...globalFallback } = context;
		await expect(router.resolve("agent://ForeignLive", globalFallback)).rejects.toThrow("Not found: ForeignLive");
		expect((await router.resolve("agent://Historical", context)).content).toBe("source-only result");
	});

	it("completes only source IDs for tool and editor seance contexts", async () => {
		const router = InternalUrlRouter.instance();
		expect(await router.complete("agent", "")).toContainEqual({ value: "ForeignPublished" });
		expect(await router.complete("agent", "", context)).toEqual([{ value: "Historical" }]);
		expect(await router.complete("agent", "", { seanceSourceArtifactsDir: sourceDir })).toEqual([
			{ value: "Historical" },
		]);
	});

	it("resolves and locates source output without consulting a live registry", async () => {
		vi.spyOn(AgentRegistry, "global").mockImplementation(() => {
			throw new Error("Seance must not consult the live registry");
		});
		const { agentRegistry: _registry, ...sourceContext } = context;
		const router = InternalUrlRouter.instance();
		expect((await router.resolve("agent://Historical", sourceContext)).content).toBe("source-only result");
		expect(await router.locate("agent://Historical", sourceContext)).toBe(path.join(sourceDir, "Historical.md"));
		expect(await new AgentProtocolHandler().complete(undefined, sourceContext)).toEqual([{ value: "Historical" }]);
	});
});
