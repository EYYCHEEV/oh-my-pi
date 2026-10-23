import { describe, expect, it } from "bun:test";

import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import type { BeamConfig } from "@oh-my-pi/pi-mnemopi/core/beam";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

const FULL = "TIER_CUT_PROBE ".repeat(80).trim();

function daysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** One episodic row aged `ageDays` days, at degradation `tier`, holding the full probe text. */
function seed(beam: BeamMemory, ageDays: number, tier: 1 | 2): string {
	const id = beam.consolidateToEpisodic(FULL, ["wm-1"], "test", 0.7);
	beam.db.run("UPDATE episodic_memory SET tier = ?, created_at = ? WHERE id = ?", [tier, daysAgo(ageDays), id]);
	return id;
}

function row(beam: BeamMemory, id: string): { tier: number; content: string } {
	return beam.db.query("SELECT tier, content FROM episodic_memory WHERE id = ?").get(id) as {
		tier: number;
		content: string;
	};
}

function withBeam(config: Partial<BeamConfig>, body: (beam: BeamMemory) => void): void {
	const beam = new BeamMemory({ sessionId: "tier-days", dbPath: ":memory:", config });
	try {
		body(beam);
	} finally {
		beam.close();
	}
}

describe("per-instance episodic tier cut", () => {
	it("keeps the 30 and 180 day defaults when nothing is configured", () => {
		withBeam({}, beam => {
			const young = seed(beam, 20, 1);
			const old = seed(beam, 45, 1);
			const result = beam.degradeEpisodic(false);
			expect(result.tier1_to_tier2).toBe(1);
			expect(row(beam, young).tier).toBe(1);
			expect(row(beam, old).tier).toBe(2);
			expect(row(beam, old).content.length).toBeLessThan(FULL.length);
		});
	});

	it("tier2Days: 0 never cuts a tier 1 row, however old", () => {
		withBeam({ tier2Days: 0 }, beam => {
			const id = seed(beam, 400, 1);
			expect(beam.degradeEpisodic(true).tier1_to_tier2).toBe(0);
			beam.degradeEpisodic(false);
			expect(row(beam, id)).toEqual({ tier: 1, content: FULL });
		});
	});

	it("tier3Days: 0 never cuts a tier 2 row to its key sentences", () => {
		withBeam({ tier3Days: 0 }, beam => {
			const id = seed(beam, 900, 2);
			expect(beam.degradeEpisodic(true).tier2_to_tier3).toBe(0);
			beam.degradeEpisodic(false);
			expect(row(beam, id)).toEqual({ tier: 2, content: FULL });
		});
	});

	it("a larger tier2Days moves the cut later than the 30 day default", () => {
		withBeam({ tier2Days: 90 }, beam => {
			const id = seed(beam, 60, 1);
			beam.degradeEpisodic(false);
			expect(row(beam, id).tier).toBe(1);
			beam.db.run("UPDATE episodic_memory SET created_at = ? WHERE id = ?", [daysAgo(120), id]);
			beam.degradeEpisodic(false);
			expect(row(beam, id).tier).toBe(2);
		});
	});

	it("a smaller tier2Days cuts rows the default would still keep whole", () => {
		withBeam({ tier2Days: 7 }, beam => {
			const id = seed(beam, 10, 1);
			expect(beam.degradeEpisodic(true).tier1_to_tier2).toBe(1);
			beam.degradeEpisodic(false);
			expect(row(beam, id).tier).toBe(2);
		});
	});

	it("tier3Days moves the second cut independently of tier2Days", () => {
		withBeam({ tier3Days: 400 }, beam => {
			const id = seed(beam, 200, 2);
			beam.degradeEpisodic(false);
			expect(row(beam, id).tier).toBe(2);
			beam.db.run("UPDATE episodic_memory SET created_at = ? WHERE id = ?", [daysAgo(500), id]);
			beam.degradeEpisodic(false);
			expect(row(beam, id).tier).toBe(3);
		});
	});

	it("reaches the beam through the Mnemopi facade option", () => {
		const memory = new Mnemopi({
			sessionId: "tier-days-facade",
			dbPath: ":memory:",
			noEmbeddings: true,
			beamConfig: { tier2Days: 0, tier3Days: 0 },
		});
		try {
			expect(memory.beam.config.tier2Days).toBe(0);
			expect(memory.beam.config.tier3Days).toBe(0);
		} finally {
			memory.close();
		}
	});
});
