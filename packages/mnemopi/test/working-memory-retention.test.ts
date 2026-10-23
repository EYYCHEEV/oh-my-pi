import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

// Embeddings install on demand; these tests never need vectors.
beforeEach(() => {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

const closers: (() => void)[] = [];

afterEach(() => {
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

function consolidatedAt(db: Db, id: string): string | null {
	const row = db.query("SELECT consolidated_at AS at FROM working_memory WHERE id = ?").get(id) as {
		at: string | null;
	} | null;
	if (row === null) throw new Error(`working row ${id} was deleted`);
	return row.at;
}

function episodicContents(db: Db): string {
	const rows = db.query("SELECT content FROM episodic_memory").all() as { content: string }[];
	return rows.map(row => row.content).join("\n");
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
		const youngId = memory.remember("Release owner for October is Dana", { source: "coding-agent-retain" });
		for (const id of expiredIds) db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(30), id]);
		// Still inside the TTL: it must stay live in working memory, not be promoted early.
		db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(20), youngId]);

		const freshId = memory.remember("A fresh note written after the long idle gap", { source: "conversation" });

		// The episodic summary is AAAK-compressed, so assert on one distinctive word per note.
		const summaries = episodicContents(db);
		for (const [index, id] of expiredIds.entries()) {
			expect((memory.get(id) as { content: string } | null)?.content).toBe(expired[index]?.content);
			expect(consolidatedAt(db, id)).not.toBeNull();
			expect(summaries).toContain(expired[index]?.word as string);
		}
		// One summary for the expired batch, written by the regular sleep pipeline.
		expect(db.query("SELECT COUNT(*) AS n FROM episodic_memory").get()).toEqual({ n: 1 });
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
		expect(db.query("SELECT COUNT(*) AS n FROM consolidation_log").get()).toEqual({ n: 0 });

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
		expect(
			db.query("SELECT tier, length(content) AS chars FROM episodic_memory WHERE id = 'old-episode'").get(),
		).toEqual({ tier: 1, chars: longContent.length });
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

		const promoted = ids.map(id =>
			beam.db.query("SELECT consolidated_at AS at FROM working_memory WHERE id = ?").get(id),
		);
		// The two oldest were over the limit and are promoted; the newest three stay live.
		expect(promoted.map(row => (row as { at: string | null } | null)?.at != null)).toEqual([
			true,
			true,
			false,
			false,
			false,
		]);
		const summaries = (beam.db.query("SELECT content FROM episodic_memory").all() as { content: string }[])
			.map(row => row.content)
			.join("\n");
		expect(summaries).toContain("alpha");
		expect(summaries).toContain("bravo");
		expect(summaries).not.toContain("charlie");
	});
});
