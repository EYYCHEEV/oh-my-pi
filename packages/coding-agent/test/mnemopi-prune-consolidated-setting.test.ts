/**
 * `mnemopi.pruneConsolidatedDays` must reach the session-start maintenance end to end:
 * Settings -> `loadMnemopiConfig` -> per-bank Mnemopi instance -> `promoteEligibleWorkingMemory` (`sleep`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { closeMnemopiStates, startMnemopiState } from "./helpers/mnemopi-state";

const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

/** Working rows summarized 40 and 10 days ago, then the session-start step; returns the surviving ids. */
function survivorsAfterSessionStart(overrides: Record<string, unknown>): string[] {
	const { state } = startMnemopiState(overrides);
	const { beam } = state.getScopedRecallTargets()[0].memory;
	const ids = new Map<string, string>();
	for (const [label, days] of [
		["old", 40],
		["recent", 10],
	] as const) {
		const id = beam.remember(`${label} zebrafox rollout note`, { source: "coding-agent-retain" });
		beam.consolidateToEpisodic(`${label} zebrafox rollout summary`, [id], "sleep_consolidation", 0.6);
		beam.db.run("UPDATE working_memory SET timestamp = ?, consolidated_at = ? WHERE id = ?", [
			daysAgo(days),
			daysAgo(days),
			id,
		]);
		ids.set(id, label);
	}
	state.promoteEligibleWorkingMemory();
	const left = beam.db.query("SELECT id FROM working_memory").all() as { id: string }[];
	const summaries = beam.db.query("SELECT COUNT(*) AS n FROM episodic_memory").get() as { n: number };
	expect(summaries.n).toBe(2);
	return left.map(row => ids.get(row.id) ?? "?").sort();
}

afterEach(async () => {
	await closeMnemopiStates();
});

describe("mnemopi.pruneConsolidatedDays", () => {
	it("keeps every consolidated row when unset", () => {
		expect(survivorsAfterSessionStart({})).toEqual(["old", "recent"]);
	});

	it("deletes rows summarized longer ago than the setting at session start", () => {
		expect(survivorsAfterSessionStart({ "mnemopi.pruneConsolidatedDays": 30 })).toEqual(["recent"]);
	});

	it("keeps rows summarized more recently than the setting", () => {
		expect(survivorsAfterSessionStart({ "mnemopi.pruneConsolidatedDays": 90 })).toEqual(["old", "recent"]);
	});

	it("0 keeps everything", () => {
		expect(survivorsAfterSessionStart({ "mnemopi.pruneConsolidatedDays": 0 })).toEqual(["old", "recent"]);
	});

	it("reads a negative value as unset", () => {
		const config = loadMnemopiConfig(
			Settings.isolated({ "mnemopi.pruneConsolidatedDays": -5 }),
			"/tmp/mnemopi-prune",
		);
		expect(config.pruneConsolidatedDays).toBeUndefined();
	});

	it("floors a fractional count", () => {
		const config = loadMnemopiConfig(
			Settings.isolated({ "mnemopi.pruneConsolidatedDays": 40.9 }),
			"/tmp/mnemopi-prune",
		);
		expect(config.pruneConsolidatedDays).toBe(40);
	});

	it("is unset by default", () => {
		const config = loadMnemopiConfig(Settings.isolated({}), "/tmp/mnemopi-prune");
		expect(config.pruneConsolidatedDays).toBeUndefined();
	});
});
