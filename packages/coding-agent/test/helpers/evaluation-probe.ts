import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function evaluationProbe(pi: ExtensionAPI): void {
	pi.on("tool_call", event => {
		if (event.toolName !== "probe") return;
		if (event.input.value === "blocked") return { block: true, reason: "FIXTURE_TOOL_BLOCKED" };
		if (event.input.value === "revise") return { input: { value: "revised" } };
	});
	pi.on("before_agent_start", async (event, ctx) => {
		if (process.env.EVALUATION_FIXTURE_MODE === "startup-error") throw new Error("FIXTURE_STARTUP_ERROR");
		if (process.env.EVALUATION_FIXTURE_MODE === "startup-timeout") return Promise.withResolvers<never>().promise;
		if (process.env.EVALUATION_FIXTURE_MODE === "startup-abort") {
			ctx.abort();
			return;
		}
		return { systemPrompt: [...event.systemPrompt, "GENERIC_TRUSTED_STARTUP"] };
	});
	if (process.env.EVALUATION_FIXTURE_MODE === "missing-tool") return;
	pi.registerTool({
		name: "probe",
		label: "Probe",
		description: "Transform a fixture value.",
		parameters: pi.arktype({ value: "string" }),
		async execute(_id, args) {
			const input = args as { value: string };
			return { content: [{ type: "text", text: input.value.toUpperCase() }], details: {} };
		},
	});
}
