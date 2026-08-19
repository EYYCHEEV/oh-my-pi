import { afterEach, describe, expect, it } from "bun:test";

import type { AgentSession } from "../../session/agent-session";
import {
	AgentRegistry,
	listRegisteredAgents,
	onAgentRegistryChange,
	type AgentRegistryObservationEvent,
} from "../agent-registry";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

describe("agent registry observation", () => {
	it("returns detached snapshots without exposing live sessions or registry mutation", () => {
		const events: AgentRegistryObservationEvent[] = [];
		const dispose = onAgentRegistryChange(event => events.push(event));
		const registry = AgentRegistry.global();
		registry.register({
			id: "reviewer",
			displayName: "Reviewer",
			kind: "sub",
			session: {} as AgentSession,
			history: {
				metrics: { tokens: 1, requests: 1, tools: 1, cost: 0, durationMs: 1 },
			},
		});

		const listed = listRegisteredAgents()[0]!;
		expect("session" in listed).toBe(false);
		expect("session" in events[0]!.ref).toBe(false);

		Object.assign(listed, { status: "aborted" });
		Object.assign(listed.history!.metrics!, { tokens: 99 });
		Object.assign(events[0]!.ref, { displayName: "Mutated" });
		expect(registry.get("reviewer")).toMatchObject({
			displayName: "Reviewer",
			status: "running",
			history: { metrics: { tokens: 1 } },
		});

		dispose();
		registry.setStatus("reviewer", "idle");
		expect(events).toHaveLength(1);
	});
});
