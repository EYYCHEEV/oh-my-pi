/**
 * `mnemopi.graphLinkWindow` must reach episodic graph linking end to end:
 * Settings -> `loadMnemopiConfig` -> per-bank Mnemopi instance -> consolidation of a new summary.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { closeMnemopiStates, startMnemopiState } from "./helpers/mnemopi-state";

const SHARED = "deploy pipeline rollback staging release checklist owner review";

/** Consolidates 30 summaries, then one more through the session's own memory, and counts its links. */
function linkedByLastSummary(overrides: Record<string, unknown>): number {
	const { state } = startMnemopiState(overrides);
	const { beam } = state.getScopedRecallTargets()[0].memory;
	for (let index = 0; index < 30; index++) {
		beam.consolidateToEpisodic(`${SHARED} day ${index}`, [`wm-${index}`], "test", 0.6);
	}
	const last = beam.consolidateToEpisodic(`${SHARED} today`, ["wm-today"], "test", 0.6);
	const linked = beam.db
		.query("SELECT COUNT(*) AS n FROM graph_edges WHERE source = ? AND edge_type = 'related_to'")
		.get(last) as { n: number };
	return linked.n;
}

afterEach(async () => {
	delete process.env.MNEMOPI_GRAPH_LINK_WINDOW;
	await closeMnemopiStates();
});

describe("mnemopi.graphLinkWindow", () => {
	it("links a new summary to the 30 known memories under the 200 default", () => {
		expect(linkedByLastSummary({})).toBe(30);
	});

	it("limits a new summary to the newest N memories", () => {
		expect(linkedByLastSummary({ "mnemopi.graphLinkWindow": 5 })).toBe(5);
	});

	it("0 links against every memory", () => {
		expect(linkedByLastSummary({ "mnemopi.graphLinkWindow": 0 })).toBe(30);
	});

	it("wins over MNEMOPI_GRAPH_LINK_WINDOW, which still applies when the setting is unset", () => {
		process.env.MNEMOPI_GRAPH_LINK_WINDOW = "7";
		expect(linkedByLastSummary({})).toBe(7);
		expect(linkedByLastSummary({ "mnemopi.graphLinkWindow": 5 })).toBe(5);
	});

	it("reads a negative value as unset", () => {
		const config = loadMnemopiConfig(Settings.isolated({ "mnemopi.graphLinkWindow": -5 }), "/tmp/mnemopi-link");
		expect(config.graphLinkWindow).toBeUndefined();
	});

	it("floors a fractional count", () => {
		const config = loadMnemopiConfig(Settings.isolated({ "mnemopi.graphLinkWindow": 40.9 }), "/tmp/mnemopi-link");
		expect(config.graphLinkWindow).toBe(40);
	});
});
