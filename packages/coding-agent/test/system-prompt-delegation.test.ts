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
		const gpt = await renderDelegation({ model: "openai-codex/gpt-6-astra" });
		const claude = await renderDelegation({ model: "anthropic/claude-opus-4" });

		expect(gpt).toBe(claude);
	});
});
