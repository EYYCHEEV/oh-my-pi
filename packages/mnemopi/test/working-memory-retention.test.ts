import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

// Embeddings install on demand; these tests never need vectors.
beforeEach(() => {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

const closers: (() => void)[] = [];

afterEach(() => {
	setSystemTime();
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
	while (closers.length > 0) closers.pop()?.();
});

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

type Db = Mnemopi["beam"]["db"];

function makeMemory(sessionId: string): Mnemopi {
	const memory = new Mnemopi({ sessionId, dbPath: ":memory:", noEmbeddings: true });
	closers.push(() => memory.close());
	return memory;
}

/** First column of the first row, which every query below names `n` or `at`. */
function firstValue(db: Db, sql: string, column: string, params: string[] = []): unknown {
	const row = db.query(sql).get(...params);
	if (row === null || typeof row !== "object" || !(column in row)) {
		throw new Error(`no ${column} in the result of: ${sql}`);
	}
	return Object.entries(row).find(([key]) => key === column)?.[1];
}

function scalar(db: Db, sql: string, params: string[] = []): number {
	const value = firstValue(db, sql, "n", params);
	if (typeof value !== "number") throw new Error(`not a number: ${sql}`);
	return value;
}

function consolidatedAt(db: Db, id: string): string | null {
	const value = firstValue(db, "SELECT consolidated_at AS at FROM working_memory WHERE id = ?", "at", [id]);
	return typeof value === "string" ? value : null;
}

function episodicContents(db: Db): string {
	return db
		.query("SELECT content FROM episodic_memory")
		.all()
		.map(row => String(Object.values(row ?? {})[0]))
		.join("\n");
}

function contentOf(value: unknown): unknown {
	return value !== null && typeof value === "object" && "content" in value ? value.content : undefined;
}

describe("working-memory retention across the TTL and count trim", () => {
	it("consolidates unconsolidated rows older than the TTL on the next write instead of deleting them", () => {
		// A session that outlived the 24h working-memory TTL: session-start consolidation already
		// ran, so only `remember` can act on rows that aged past the TTL since then.
		const memory = makeMemory("long-session");
		const db = memory.beam.db;
		// Each note carries one distinctive word; the episodic summary is AAAK-compressed, so assert on words.
		const expired = [
			{ content: "The deploy key rotates every Friday at noon", word: "Friday" },
			{ content: "Staging database lives behind the bastion host", word: "bastion" },
		];
		const expiredIds = expired.map(note => memory.remember(note.content, { source: "coding-agent-retain" }));
		const midId = memory.remember("Release owner for October is Dana", { source: "coding-agent-retain" });
		const youngId = memory.remember("The pager rotation starts on Monday", { source: "coding-agent-retain" });
		for (const id of expiredIds) db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(30), id]);
		// Inside the TTL but past half of it: `sleep` would take it, so it joins the batch.
		db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(20), midId]);
		// Younger than half the TTL: `sleep` would leave it, so it stays live in working memory.
		db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(6), youngId]);

		const freshId = memory.remember("A fresh note written after the long idle gap", { source: "conversation" });

		// The episodic summary is AAAK-compressed, so assert on one distinctive word per note.
		const summaries = episodicContents(db);
		for (const [index, id] of expiredIds.entries()) {
			expect(contentOf(memory.get(id))).toBe(expired[index]?.content);
			expect(consolidatedAt(db, id)).not.toBeNull();
			expect(summaries).toContain(expired[index]?.word ?? "");
		}
		// One summary for the whole batch (one source), written by the regular sleep pipeline.
		expect(scalar(db, "SELECT COUNT(*) AS n FROM episodic_memory")).toBe(1);
		expect(consolidatedAt(db, midId)).not.toBeNull();
		expect(consolidatedAt(db, youngId)).toBeNull();
		expect(consolidatedAt(db, freshId)).toBeNull();
	});

	it("keeps rows unconsolidated, and the write succeeding, when promotion fails, then retries on the next write", () => {
		const memory = makeMemory("failing-promotion");
		const db = memory.beam.db;
		const id = memory.remember("A memory that must not be lost", { source: "coding-agent-retain" });
		db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(30), id]);
		db.run(
			"CREATE TRIGGER block_episodic BEFORE INSERT ON episodic_memory BEGIN SELECT RAISE(ABORT, 'episodic blocked'); END",
		);

		expect(() => memory.remember("write while promotion is broken", { source: "conversation" })).not.toThrow();
		expect(consolidatedAt(db, id)).toBeNull();
		expect(scalar(db, "SELECT COUNT(*) AS n FROM consolidation_log")).toBe(0);

		db.run("DROP TRIGGER block_episodic");
		memory.remember("write after promotion recovered", { source: "conversation" });
		expect(consolidatedAt(db, id)).not.toBeNull();
		expect(episodicContents(db)).toContain("lost");
	});

	it("leaves episodic tier degradation to sleep when a write promotes rows", () => {
		const memory = makeMemory("no-degrade-on-write");
		const db = memory.beam.db;
		const longContent = "durable episode detail ".repeat(100);
		db.run(
			"INSERT INTO episodic_memory (id, content, source, timestamp, created_at, tier) VALUES ('old-episode', ?, 'test', ?, ?, 1)",
			[longContent, hoursAgo(24 * 60), hoursAgo(24 * 60)],
		);
		const id = memory.remember("An expired note that triggers promotion", { source: "coding-agent-retain" });
		db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(30), id]);

		memory.remember("The write that promotes it", { source: "conversation" });

		expect(consolidatedAt(db, id)).not.toBeNull();
		expect(scalar(db, "SELECT tier AS n FROM episodic_memory WHERE id = 'old-episode'")).toBe(1);
		expect(scalar(db, "SELECT length(content) AS n FROM episodic_memory WHERE id = 'old-episode'")).toBe(
			longContent.length,
		);
	});

	it("promotes the oldest rows beyond workingMemoryLimit instead of deleting them", () => {
		const beam = new BeamMemory({ sessionId: "count-limit", dbPath: ":memory:", config: { workingMemoryLimit: 3 } });
		closers.push(() => beam.close());
		const words = ["alpha", "bravo", "charlie", "delta", "echo"];
		// Oldest first, all well inside the TTL so only the count limit can act.
		const ids = words.map((word, index) =>
			beam.remember(`${word} entry`, {
				source: "coding-agent-retain",
				timestamp: new Date(Date.now() - (50 - index * 10) * 60_000).toISOString(),
			}),
		);

		// A fourth row is over the limit of 3, so the trim promotes the two oldest (down to the low-water
		// mark of 2); the newest three stay live.
		expect(ids.map(id => consolidatedAt(beam.db, id) !== null)).toEqual([true, true, false, false, false]);
		const summaries = episodicContents(beam.db);
		expect(summaries).toContain("alpha");
		expect(summaries).toContain("bravo");
		expect(summaries).not.toContain("charlie");
	});

	it("consolidates a steady writer in half-TTL groups, not one summary per write", () => {
		const memory = makeMemory("steady-writer");
		const db = memory.beam.db;
		const writes = 80;
		const start = Date.now() - 40 * 3_600_000;
		// One row every 30 minutes on a controlled clock, so rows cross the 24h TTL one at a time.
		for (let index = 0; index < writes; index++) {
			setSystemTime(new Date(start + index * 30 * 60_000));
			memory.remember(`Observation ${index} about the nightly pipeline`, { source: "coding-agent-retain" });
		}

		// Nothing is lost: every row is still in working memory.
		expect(scalar(db, "SELECT COUNT(*) AS n FROM working_memory")).toBe(writes);
		// None was left behind past the TTL...
		expect(
			scalar(db, "SELECT COUNT(*) AS n FROM working_memory WHERE consolidated_at IS NULL AND timestamp < ?", [
				hoursAgo(24),
			]),
		).toBe(0);
		// ...and the consolidation log accounts for exactly the rows that were marked consolidated.
		const consolidated = scalar(db, "SELECT COUNT(*) AS n FROM working_memory WHERE consolidated_at IS NOT NULL");
		expect(consolidated).toBeGreaterThan(0);
		expect(scalar(db, "SELECT SUM(items_consolidated) AS n FROM consolidation_log")).toBe(consolidated);
		// Bound: after a pass, every row older than 12h is consolidated, so the rows still live are younger
		// than 12h and cannot reach the 24h trigger before 12h later. The first trigger is at 24h, the last
		// write at 39.5h, so there are at most 2 passes. All rows share one source, so one summary per pass.
		// Promoting only the rows that crossed the TTL gave one summary per write, about 31 here.
		const summaries = scalar(db, "SELECT COUNT(*) AS n FROM episodic_memory");
		expect(summaries).toBeGreaterThanOrEqual(1);
		expect(summaries).toBeLessThanOrEqual(2);
	});

	it("promotes count overflow in chunks down to a low-water mark, never one row per write", () => {
		const limit = 1000;
		const writes = 1500;
		const beam = new BeamMemory({
			sessionId: "overflow-chunks",
			dbPath: ":memory:",
			config: { workingMemoryLimit: limit },
		});
		closers.push(() => beam.close());
		// Spread the rows over 25 minutes, all well inside the TTL so only the count limit can act.
		const base = Date.now() - 20 * 3_600_000;
		const importedId = beam.remember("A restored durable row the overflow path must leave alone", {
			source: "restore",
			trustTier: "IMPORTED",
			timestamp: new Date(base - 3_600_000).toISOString(),
		});
		for (let index = 0; index < writes; index++) {
			beam.remember(`Overflow observation ${index} from the build bot`, {
				source: "coding-agent-retain",
				timestamp: new Date(base + index * 1000).toISOString(),
			});
		}

		// Nothing is lost.
		expect(scalar(beam.db, "SELECT COUNT(*) AS n FROM working_memory")).toBe(writes + 1);
		// Overflow writes were writes 1001 to 1500. Each promotion takes the live rows from just over the
		// limit down to 90% of it, so a chunk covers 101 rows and arrives every 101 writes: 5 summaries for
		// 500 overflow writes (one source, so one summary per chunk), not 500.
		const overflowWrites = writes - limit;
		const summaries = scalar(
			beam.db,
			"SELECT COUNT(*) AS n FROM episodic_memory WHERE source = 'sleep_consolidation'",
		);
		expect(summaries).toBeGreaterThanOrEqual(1);
		expect(summaries).toBeLessThanOrEqual(Math.ceil(overflowWrites / 101) + 1);
		// The live scratch rows end between the low-water mark and the limit.
		const live = scalar(
			beam.db,
			"SELECT COUNT(*) AS n FROM working_memory WHERE consolidated_at IS NULL AND trust_tier IS NOT 'IMPORTED'",
		);
		expect(live).toBeGreaterThanOrEqual(900);
		expect(live).toBeLessThanOrEqual(limit);
		// The imported durable row is never counted or promoted by the overflow path (#4819).
		expect(consolidatedAt(beam.db, importedId)).toBeNull();
	});

	it("does not start a TTL promotion for an old IMPORTED row, but the batch it joins matches sleep", () => {
		const beam = new BeamMemory({ sessionId: "imported-ttl", dbPath: ":memory:" });
		closers.push(() => beam.close());
		const importedId = beam.remember("A restored durable row with an old event time", {
			source: "restore",
			trustTier: "IMPORTED",
			timestamp: hoursAgo(30),
		});
		beam.remember("A fresh note", { source: "conversation" });
		// Alone, an old IMPORTED row is durable, not expired scratch: no promotion starts.
		expect(consolidatedAt(beam.db, importedId)).toBeNull();
		expect(scalar(beam.db, "SELECT COUNT(*) AS n FROM episodic_memory")).toBe(0);

		const scratchId = beam.remember("Expired scratch from the same idle gap", {
			source: "coding-agent-retain",
			timestamp: hoursAgo(30),
		});
		// Once real scratch expires, the batch is the one `sleep` would take, which has no trust-tier filter.
		expect(consolidatedAt(beam.db, scratchId)).not.toBeNull();
		expect(consolidatedAt(beam.db, importedId)).not.toBeNull();
	});
});
