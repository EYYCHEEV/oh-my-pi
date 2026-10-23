import { afterEach, describe, expect, it } from "bun:test";

import { type BeamConfig, BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { EpisodicGraph, type GraphEdge } from "@oh-my-pi/pi-mnemopi/core/episodic-graph";

// Every memory below shares these words, so each new memory is lexically related to all earlier ones.
const SHARED = "deploy pipeline rollback staging release checklist owner review";
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW = 200;

const closers: (() => void)[] = [];
afterEach(() => {
	while (closers.length > 0) closers.pop()?.();
});

function makeBeam(): BeamMemory {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
	const beam = new BeamMemory({ sessionId: "graph-window", dbPath: ":memory:" });
	closers.push(() => beam.close());
	return beam;
}

/** Gist timestamps order "newest": memory `index` of `count` gets a time `count - index` days back. */
function backdate(beam: BeamMemory, memoryId: string, index: number, count: number): void {
	const at = new Date(Date.now() - (count - index) * DAY_MS).toISOString();
	beam.db.run("UPDATE gists SET timestamp = ? WHERE memory_id = ?", [at, memoryId]);
}

function seedGraphOnly(count: number): { beam: BeamMemory; graph: EpisodicGraph; ids: string[] } {
	const beam = makeBeam();
	const graph = new EpisodicGraph({ db: beam.db });
	const ids: string[] = [];
	for (let index = 0; index < count; index++) {
		const id = `mem-${String(index).padStart(4, "0")}`;
		graph.ingestMemory(`${SHARED} note ${index}`, id, { sessionId: "graph-window", linkExisting: false });
		backdate(beam, id, index, count);
		ids.push(id);
	}
	return { beam, graph, ids };
}

const relatedTargets = (edges: readonly GraphEdge[]): string[] =>
	edges.filter(edge => edge.edgeType === "related_to").map(edge => edge.target);

describe("graph linking window", () => {
	it("links a new memory to the newest 200 memories only, not to the whole history", () => {
		const { graph, ids } = seedGraphOnly(500);
		const result = graph.ingestMemory(`${SHARED} fresh`, "mem-new", { sessionId: "graph-window" });
		const linked = relatedTargets(result.edges);

		expect(linked).toHaveLength(WINDOW);
		expect(new Set(linked)).toEqual(new Set(ids.slice(-WINDOW)));
	});

	it("keeps the edge count of a new memory constant while the history grows", () => {
		const small = seedGraphOnly(250);
		const large = seedGraphOnly(1000);
		const smallEdges = small.graph.ingestMemory(`${SHARED} fresh`, "mem-new", { sessionId: "graph-window" }).edges;
		const largeEdges = large.graph.ingestMemory(`${SHARED} fresh`, "mem-new", { sessionId: "graph-window" }).edges;

		expect(largeEdges.length).toBe(smallEdges.length);
	});

	it("linkWindow: 0 still links against every memory", () => {
		const { graph } = seedGraphOnly(300);
		const result = graph.ingestMemory(`${SHARED} fresh`, "mem-new", { sessionId: "graph-window", linkWindow: 0 });
		expect(relatedTargets(result.edges)).toHaveLength(300);
	});
});

describe("consolidation after a long history", () => {
	it("links one more summary to a bounded number of memories, however old the database is", () => {
		const beam = makeBeam();
		const total = 250;
		for (let index = 0; index < total; index++) {
			const id = beam.consolidateToEpisodic(`${SHARED} day ${index}`, [`wm-${index}`], "test", 0.6);
			backdate(beam, id, index, total);
		}

		const today = beam.consolidateToEpisodic(`${SHARED} today`, ["wm-today"], "test", 0.6);

		const linked = beam.db
			.query("SELECT COUNT(*) AS n FROM graph_edges WHERE source = ? AND edge_type = 'related_to'")
			.get(today) as { n: number };
		expect(linked.n).toBeLessThanOrEqual(WINDOW);
	});
});

describe("graphLinkWindow beam setting", () => {
	afterEach(() => {
		delete process.env.MNEMOPI_GRAPH_LINK_WINDOW;
	});

	/** Consolidates `count` summaries, then one more, and counts what that last summary linked to. */
	function linkedByLastSummary(config: Partial<BeamConfig>, count: number): number {
		process.env.MNEMOPI_NO_EMBEDDINGS = "1";
		const beam = new BeamMemory({ sessionId: "graph-window", dbPath: ":memory:", config });
		closers.push(() => beam.close());
		for (let index = 0; index < count; index++) {
			const id = beam.consolidateToEpisodic(`${SHARED} day ${index}`, [`wm-${index}`], "test", 0.6);
			backdate(beam, id, index, count);
		}
		const last = beam.consolidateToEpisodic(`${SHARED} today`, ["wm-today"], "test", 0.6);
		const linked = beam.db
			.query("SELECT COUNT(*) AS n FROM graph_edges WHERE source = ? AND edge_type = 'related_to'")
			.get(last) as { n: number };
		return linked.n;
	}

	it("links a consolidation to the configured number of newest memories", () => {
		expect(linkedByLastSummary({ graphLinkWindow: 5 }, 30)).toBe(5);
	});

	it("0 links a consolidation against every memory", () => {
		expect(linkedByLastSummary({ graphLinkWindow: 0 }, 250)).toBe(250);
	});

	it("unset keeps the MNEMOPI_GRAPH_LINK_WINDOW default", () => {
		expect(linkedByLastSummary({}, 30)).toBe(30);
		process.env.MNEMOPI_GRAPH_LINK_WINDOW = "7";
		expect(linkedByLastSummary({}, 30)).toBe(7);
	});

	it("a configured window wins over MNEMOPI_GRAPH_LINK_WINDOW", () => {
		process.env.MNEMOPI_GRAPH_LINK_WINDOW = "7";
		expect(linkedByLastSummary({ graphLinkWindow: 5 }, 30)).toBe(5);
	});
});
