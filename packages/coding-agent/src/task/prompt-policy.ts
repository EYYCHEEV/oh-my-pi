import type { ToolSession } from "..";

/** Whether explicit session policy requires forceful delegation guidance. */
export function sessionRequiresDelegation(session: ToolSession): boolean {
	return session.settings.get("task.eager") === "always";
}
