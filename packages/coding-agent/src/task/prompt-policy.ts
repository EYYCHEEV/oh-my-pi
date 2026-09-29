import type { ToolSession } from "..";
import { cfgTaskEager } from "./settings";

/** Whether explicit session policy requires forceful delegation guidance. */
export function sessionRequiresDelegation(session: ToolSession): boolean {
	return cfgTaskEager.get(session.settings) === "always";
}
