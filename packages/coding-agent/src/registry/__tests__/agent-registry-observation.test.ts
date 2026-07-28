import { afterEach, describe, expect, it } from "bun:test";

import type { AgentSession } from "../../session/agent-session";
import { AgentRegistry, listRegisteredAgents, onAgentRegistryChange, type RegistryEvent } from "../agent-registry";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

describe("agent registry observation", () => {
	it("lists the global registry and subscribes without exposing mutation helpers", () => {
		const events: RegistryEvent[] = [];
		const dispose = onAgentRegistryChange(event => events.push(event));
		const registry = AgentRegistry.global();
		registry.register({
			id: "reviewer",
			displayName: "Reviewer",
			kind: "sub",
			session: {} as AgentSession,
		});

		expect(listRegisteredAgents().map(ref => ref.id)).toEqual(["reviewer"]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "registered", ref: { id: "reviewer" } });

		dispose();
		registry.setStatus("reviewer", "idle");
		expect(events).toHaveLength(1);
	});
});
