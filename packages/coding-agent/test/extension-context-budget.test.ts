import { expect, test } from "bun:test";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../src/config/settings";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { SessionManager } from "../src/session/session-manager";
import { wrapToolWithMetaNotice } from "../src/tools/output-meta";

// The consumer must receive the execution's limit, not the runner's larger
// default, or the normal output wrapper spills a supposedly bounded page.
test("extension consumers can fit serialized pages to the actual execution spill limit", async () => {
	const manager = SessionManager.inMemory();
	const settings = Settings.isolated({ "tools.artifactSpillThreshold": 1 });
	const runner = new ExtensionRunner(
		[],
		{} as never,
		"/fixture",
		manager,
		{} as never,
		undefined,
		Settings.isolated({ "tools.artifactSpillThreshold": 50 }),
	);
	const context: AgentToolContext = { ...runner.createContext(), settings, hasQueuedMessages: () => false };
	const tool: AgentTool = {
		name: "context-window",
		label: "Context",
		description: "Bounded test window",
		parameters: {} as never,
		execute: async (_id, _args, _signal, _update, execution) => {
			const limit = runner.createContext(undefined, {
				toolName: "context-window",
				context: execution,
			}).toolOutputBudgetBytes;
			if (limit === undefined) throw new Error("Host delivery budget is unavailable");
			let text = 'quoted "line"\n雪'.repeat(1000);
			while (Buffer.byteLength(JSON.stringify({ text })) > limit) text = text.slice(0, -1);
			return { content: [{ type: "text", text: JSON.stringify({ text }) }], details: {} };
		},
	};
	try {
		const result = await wrapToolWithMetaNotice(tool).execute("page", {}, undefined, undefined, context);
		const text = result.content
			.filter(item => item.type === "text")
			.map(item => item.text)
			.join("\n");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
		expect(JSON.parse(text).text).toStartWith('quoted "line"\n雪');
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	} finally {
		await manager.close();
	}
});
