import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { recall } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";

type TestBeam = BeamMemoryState & { close(): void };

const beams: TestBeam[] = [];

function makeBeam(): TestBeam {
	const db = new Database(":memory:");
	initBeam(db);
	const beam: TestBeam = {
		db,
		sessionId: "s1",
		authorId: null,
		authorType: null,
		channelId: "s1",
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
		close() {
			db.close();
		},
	};
	beams.push(beam);
	return beam;
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
});

type Tier = "working_memory" | "episodic_memory";

/**
 * One old row whose embedding is exactly the query vector and no word of the query, then `newer` rows
 * written after it whose embeddings point elsewhere. Only the vector can lead recall to the old row.
 */
function seed(beam: TestBeam, table: Tier, newer: number): void {
	const insertRow = beam.db.prepare(
		`INSERT INTO ${table} (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type) VALUES (?, ?, 'test', ?, 's1', 0.5, 'bank', 'unknown', 'general')`,
	);
	const insertEmbedding = beam.db.prepare(
		"INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'fixture')",
	);
	const start = Date.UTC(2026, 4, 1);
	beam.db.transaction(() => {
		insertRow.run(
			"old-semantic",
			"The vault selects the personal login.",
			new Date(start - 86_400_000).toISOString(),
		);
		insertEmbedding.run("old-semantic", "[1,0]");
		for (let i = 0; i < newer; i += 1) {
			const id = `newer-${i}`;
			insertRow.run(id, `Routine rollout note number ${i}.`, new Date(start + i * 60_000).toISOString());
			insertEmbedding.run(id, "[0,1]");
		}
	})();
}

async function semanticHit(beam: TestBeam): Promise<boolean> {
	const results = await recall(beam, "1Password", 5, {
		queryEmbedding: [1, 0],
		queryTime: "2026-06-01T00:00:00.000Z",
		updateRecallCounts: false,
	});
	return results.some(result => result.id === "old-semantic");
}

describe("vector recall reaches rows older than the newest 500 of a tier", () => {
	for (const table of ["working_memory", "episodic_memory"] as const) {
		for (const newer of [100, 400, 600, 1200]) {
			it(`finds an old exact-vector row in ${table} under ${newer} newer rows`, async () => {
				const beam = makeBeam();
				seed(beam, table, newer);

				expect(await semanticHit(beam)).toBe(true);
			});
		}
	}
});
