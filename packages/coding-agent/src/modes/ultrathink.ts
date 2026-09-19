import ultrathinkNotice from "../prompts/system/ultrathink-notice.md" with { type: "text" };
import { containsUltrathink } from "@oh-my-pi/pi-tui/prompt/ultrathink";
export { containsUltrathink };

/** Hidden system notice appended after a user message that mentions "ultrathink". */
export const ULTRATHINK_NOTICE: string = ultrathinkNotice.trim();
