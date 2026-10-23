/**
 * `mnemopi.tier2Days` / `mnemopi.tier3Days` must reach the episodic tier cut end to end:
 * Settings -> `loadMnemopiConfig` -> per-bank Mnemopi instance -> `degradeEpisodic`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { closeMnemopiStates, startMnemopiState } from "./helpers/mnemopi-state";

const FULL = "TIER_CUT_PROBE ".repeat(80).trim();
const daysAgo = (days: number): string => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

/** Seeds one 400 day old tier 1 episodic row and runs the tier cut on the session's own memory. */
function degradedTier(overrides: Record<string, unknown>): { tier: number; content: string } {
	const { state } = startMnemopiState(overrides);
	const { beam } = state.getScopedRecallTargets()[0].memory;
	const id = beam.consolidateToEpisodic(FULL, ["wm-1"], "test", 0.7);
	beam.db.run("UPDATE episodic_memory SET created_at = ? WHERE id = ?", [daysAgo(400), id]);
	beam.degradeEpisodic(false);
	return beam.db.query("SELECT tier, content FROM episodic_memory WHERE id = ?").get(id) as {
		tier: number;
		content: string;
	};
}

afterEach(closeMnemopiStates);

describe("mnemopi.tier2Days / mnemopi.tier3Days", () => {
	it("cut a 400 day old memory under the 30 and 180 day defaults", () => {
		const row = degradedTier({});
		expect(row.tier).toBe(2);
		expect(row.content.length).toBeLessThan(FULL.length);
	});

	it("keep it whole with tier2Days = 0", () => {
		expect(degradedTier({ "mnemopi.tier2Days": 0 })).toEqual({ tier: 1, content: FULL });
	});

	it("keep it whole with tier2Days beyond its age", () => {
		expect(degradedTier({ "mnemopi.tier2Days": 800 })).toEqual({ tier: 1, content: FULL });
	});

	it("reads a negative value as unset", () => {
		const config = loadMnemopiConfig(Settings.isolated({ "mnemopi.tier2Days": -5 }), "/tmp/mnemopi-tier-days");
		expect(config.tier2Days).toBeUndefined();
	});

	it("floors a fractional day count", () => {
		const config = loadMnemopiConfig(Settings.isolated({ "mnemopi.tier3Days": 90.9 }), "/tmp/mnemopi-tier-days");
		expect(config.tier3Days).toBe(90);
	});
});
