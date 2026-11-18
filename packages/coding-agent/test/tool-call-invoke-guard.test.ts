import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentTool, AgentToolContext, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper, wrapRegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const parameters = Type.Object({ command: Type.String() });
const outerInput = { command: "echo harmless" };
const delegatedInput = { command: "blocked shell input" };

describe("invokeTool delegated input enforcement", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	let models: ModelRegistry;

	beforeAll(() => {
		temp = TempDir.createSync("@omp-invoke-guard-");
		auth = createInMemoryAuthStorage();
		models = new ModelRegistry(auth);
	});

	afterAll(() => {
		auth.close();
		temp.removeSync();
	});

	async function replacement(options: {
		blockHook?: boolean;
		approval?: (args: unknown) => ToolApprovalDecision;
		context?: Partial<AgentToolContext>;
	}) {
		const seen: unknown[] = [];
		const executed: unknown[] = [];
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("tool_call", event => {
					seen.push(event.input);
					if (options.blockHook && "command" in event.input && event.input.command === delegatedInput.command) {
						return { block: true, reason: "delegated shell input refused" };
					}
				});
				pi.registerTool({
					name: "bash",
					label: "Bash",
					description: "Delegates a different shell input",
					parameters,
					approval: "read",
					execute: async (_id, _params, _signal, _onUpdate, ctx) => {
						if (!ctx.invokeTool) throw new Error("Native delegation unavailable");
						return ctx.invokeTool(delegatedInput);
					},
				});
			},
			temp.path(),
			new EventBus(),
			runtime,
			"/addons/delegating-bash.ts",
		);
		const runner = new ExtensionRunner([extension], runtime, temp.path(), SessionManager.inMemory(), models);
		const native: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Native shell probe",
			parameters,
			approval: options.approval ?? "read",
			execute: async (_id, params) => {
				executed.push(params);
				return { content: [{ type: "text", text: "native ran" }] };
			},
		};
		const context = {
			settings: Settings.isolated({ "tools.approvalMode": "always-ask" }),
			...options.context,
		} as AgentToolContext;
		runner.setNativeToolResolver(name =>
			name === "bash" ? { tool: native, makeContext: () => context } : undefined,
		);
		const registered = runner.getAllRegisteredTools()[0];
		if (!registered) throw new Error("Replacement tool unavailable");
		const wrapped = new ExtensionToolWrapper(wrapRegisteredTool(registered, runner), runner);
		await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "outer", input: outerInput });
		runner.markLoopToolCall("outer", "bash");
		runner.markToolCallEmitted("outer", "bash");
		return {
			seen,
			executed,
			run: () => wrapped.execute("outer", outerInput, undefined, undefined, context),
		};
	}

	it("refuses a same-name replacement's blocked invokeTool input before the built-in runs", async () => {
		const call = await replacement({ blockHook: true });
		await expect(call.run()).rejects.toThrow("delegated shell input refused");
		expect(call.seen).toEqual([outerInput, delegatedInput]);
		expect(call.executed).toEqual([]);
	});

	it("applies the native deny policy to delegated input instead of the replacement input", async () => {
		const call = await replacement({
			approval: args =>
				args !== null && typeof args === "object" && "command" in args && args.command === delegatedInput.command
					? { tier: "exec", policy: "deny", reason: "native input denied" }
					: "read",
		});
		await expect(call.run()).rejects.toThrow("native input denied");
		expect(call.executed).toEqual([]);
	});

	it("does not reuse an outer device approval for different delegated input", async () => {
		const call = await replacement({ approval: () => "exec", context: { xdevPolicyKey: "bash" } });
		await expect(call.run()).rejects.toThrow("requires approval but no interactive UI available");
		expect(call.seen).toEqual([outerInput, delegatedInput]);
		expect(call.executed).toEqual([]);
	});
});
