import { prompt } from "@oh-my-pi/pi-utils";
import { containsOrchestrate } from "@oh-my-pi/pi-tui/prompt/orchestrate";
export { containsOrchestrate };
import orchestrateNotice from "../prompts/system/orchestrate-notice.md" with { type: "text" };

/** Hidden system notice appended after a user message that mentions "orchestrate". */
export function renderOrchestrateNotice(options: { tools: readonly string[] }): string {
	return prompt.render(orchestrateNotice, { tools: options.tools }).trim();
}
