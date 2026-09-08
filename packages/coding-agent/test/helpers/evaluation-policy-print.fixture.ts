import { expect, spyOn } from "bun:test";
import * as path from "node:path";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { testSetExtensionHandlerTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInMemoryAuthStorage } from "./agent-session-setup";

// The child owns its entire module graph. Only provider/auth discovery is replaced.
const root = process.cwd();
const mode = process.env.EVALUATION_FIXTURE_MODE!;
const restricted = process.env.OMP_EVALUATION_POLICY !== undefined;
const startupFailure = mode.startsWith("startup-") || mode === "missing-tool";
const auth = createInMemoryAuthStorage();
const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider request"));
spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
spyOn(ModelRegistry.prototype, "refreshRuntimeProviders").mockResolvedValue(undefined);
spyOn(registry, "getApiKey").mockResolvedValue("model-free-fixture-key");
if (mode === "startup-timeout") testSetExtensionHandlerTimeoutMs(25);
const settings = Settings.isolated({
	"prewalk.enabled": false,
	"retry.enabled": false,
	"startup.showSplash": false,
	"startup.quiet": true,
	"requiredExtension.path": path.join(root, "probe.ts"),
	"requiredExtension.id": "extension-module:probe",
	"requiredExtension.sha256": process.env.EVALUATION_PROBE_SHA256!,
});
const responses: MockHandler[] = ["first", "revise", "blocked"].map((value, index) => context => {
	expect(context.systemPrompt?.join("\n")).toContain("GENERIC_TRUSTED_STARTUP");
	return { content: [{ type: "toolCall", id: `probe-${index}`, name: "probe", arguments: { value } }] };
});
if (restricted) {
	responses.push({ content: [{ type: "toolCall", id: "unadmitted", name: "eval", arguments: {} }] });
}
responses.push(context => {
	const results = context.messages.filter(message => message.role === "toolResult");
	expect(results).toHaveLength(restricted ? 4 : 3);
	expect(results[0].content).toEqual([{ type: "text", text: "FIRST" }]);
	expect(results[1].content).toEqual([{ type: "text", text: "REVISED" }]);
	expect(results[2].isError).toBe(true);
	expect(JSON.stringify(results[2])).toContain("FIXTURE_TOOL_BLOCKED");
	if (restricted) expect(results[3].isError).toBe(true);
	return { content: ["GENERIC_PRINT_VERIFIED"] };
});
const model = createMockModel({ responses });
let session: AgentSession | undefined;
let disposalCalls = 0;
let rejected = false;
const args = [
	"--print",
	"--cwd",
	root,
	"--system-prompt",
	path.join(root, "system.txt"),
	restricted ? "--trusted-extension" : "--extension",
	path.join(root, "probe.ts"),
	`@${path.join(root, "request.txt")}`,
];
try {
	try {
		await runRootCommand(parseArgs(args), args, {
			discoverAuthStorage: async () => auth,
			settings,
			createAgentSession: async options => {
				const result = await createAgentSession({ ...options, model, modelRegistry: registry, authStorage: auth });
				session = result.session;
				if (restricted) expect(session.agent.state.tools.map(tool => tool.name)).toEqual(["probe"]);
				else expect(session.agent.state.tools.some(tool => tool.name === "handler")).toBe(false);
				session.agent.streamFn = model.stream;
				const dispose = session.dispose.bind(session);
				spyOn(session, "dispose").mockImplementation((...args) => {
					disposalCalls++;
					return dispose(...args);
				});
				return result;
			},
		});
	} catch (error) {
		if (!startupFailure) throw error;
		expect(String(error)).toMatch(/Evaluation.*startup|requires a trusted extension tool/i);
		rejected = true;
	}
	if (startupFailure) {
		expect(rejected).toBe(true);
		expect(model.calls).toHaveLength(0);
		process.stdout.write("GENERIC_STARTUP_REFUSED\n");
	}
	if (session) expect(disposalCalls).toBeGreaterThan(0);
	expect(network).not.toHaveBeenCalled();
} finally {
	if (session && disposalCalls === 0) await session.dispose();
	auth.close();
}
