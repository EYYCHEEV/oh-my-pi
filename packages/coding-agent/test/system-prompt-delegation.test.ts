import { describe, expect, it } from "bun:test";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

const EMPTY_TREE = {
	rootPath: import.meta.dir,
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

type DelegationOptions = Pick<
	BuildSystemPromptOptions,
	"eagerTasks" | "eagerTasksAlways" | "model" | "taskBatch" | "taskMaxConcurrency"
>;

async function renderDelegation(options: DelegationOptions = {}): Promise<string> {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: import.meta.dir,
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["task"],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
		personality: "none",
		includeModelInPrompt: false,
		...options,
	});
	return systemPrompt.join("\n\n");
}

describe("system prompt delegation policy", () => {
	it("uses one conservative policy for every model", async () => {
		const gpt = await renderDelegation({ model: "openai/gpt-5.6" });
		const claude = await renderDelegation({ model: "anthropic/claude-opus-4" });

		expect(gpt).toBe(claude);
		expect(gpt).toContain("working on the main thread is the default");
		expect(gpt).toContain("Delegation must earn its cost");
		expect(gpt).toContain("Wait for the complete set");
		expect(gpt).toContain("Verify, then synthesize once");
	});

	it("keeps preferred soft and reserves forceful delegation for always", async () => {
		const preferred = await renderDelegation({ eagerTasks: true });
		const always = await renderDelegation({ eagerTasks: true, eagerTasksAlways: true });

		expect(preferred).toContain("this is a nudge, not a requirement to spawn");
		expect(preferred).not.toContain("Delegation is explicitly required");
		expect(always).toContain("Delegation is explicitly required for substantial work");
	});

	it("renders only enabled batch and concurrency guidance", async () => {
		const boundedBatch = await renderDelegation({ taskBatch: true, taskMaxConcurrency: 4 });
		const unboundedSingle = await renderDelegation({ taskBatch: false, taskMaxConcurrency: 0 });

		expect(boundedBatch).toContain("batch genuinely independent units in one `tasks[]` call");
		expect(boundedBatch).toContain("At most 4 subagents can run in this session");
		expect(unboundedSingle).not.toContain("batch genuinely independent units");
		expect(unboundedSingle).not.toContain("Respect the concurrency cap");
	});
});
