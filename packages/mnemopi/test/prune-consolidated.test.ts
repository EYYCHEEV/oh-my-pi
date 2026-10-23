/**
 * `pruneConsolidatedDays` bounds database growth for long-lived banks: once a working row has been
 * summarized into a live episodic row for N days, its verbatim copy (and its search, vector and
 * annotation entries) goes, the summary stays. Off unless the beam setting is positive. It must never
 * touch an unconsolidated row, an IMPORTED row, or a row no live summary covers.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRUNE_ROWS_PER_RUN } from "@oh-my-pi/pi-mnemopi/core/beam/prune";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

// Embeddings install on demand; these tests never need vectors.
beforeEach(() => {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

type Db = Mnemopi["beam"]["db"];

function makeMemory(sessionId: string, dbPath = ":memory:"): Mnemopi {
	const memory = new Mnemopi({ sessionId, dbPath, noEmbeddings: true });
	cleanups.push(() => memory.close());
	return memory;
}

/** Turn the setting on after seeding, so the seeding `sleep` calls cannot prune what a test just built. */
function setPrune(memory: Mnemopi, days: number): void {
	memory.beam.config.pruneConsolidatedDays = days;
}

function count(db: Db, sql: string, params: string[] = []): number {
	const row = db.query(sql).get(...params);
	const value = row === null || typeof row !== "object" ? undefined : Object.values(row)[0];
	if (typeof value !== "number") throw new Error(`not a number: ${sql}`);
	return value;
}

const workingIds = (db: Db): string[] =>
	db
		.query("SELECT id FROM working_memory ORDER BY id")
		.all()
		.map(row => String((row as { id: string }).id));

/** One note per entry, aged 13 h so `sleep` takes them, consolidated, then marked as consolidated `daysSince` ago. */
function consolidated(memory: Mnemopi, notes: readonly string[], daysSince: number): string[] {
	const ids = notes.map(note => memory.remember(note, { source: "coding-agent-retain" }));
	for (const id of ids) memory.beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(13), id]);
	memory.sleep(false);
	for (const id of ids) {
		memory.beam.db.run("UPDATE working_memory SET consolidated_at = ? WHERE id = ?", [daysAgo(daysSince), id]);
	}
	return ids;
}

/** Everything recall can show for `query`, working rows included or not. */
async function surfaced(memory: Mnemopi, query: string, includeWorking: boolean): Promise<string> {
	const rows = await memory.beam.recall(query, 20, { includeWorking });
	return rows.map(row => `${row.tier_label}: ${row.content}`).join("\n");
}

const ZEBRA = "Zebrafox rollout is scheduled for 2027-04-01 with 77 widgets";
const QUOKKA = "Quokka migration is scheduled for 2027-05-09 with 41 gadgets";

describe("pruneConsolidatedDays", () => {
	it("is off by default: a consolidated row of any age stays", () => {
		const memory = makeMemory("off");
		const ids = consolidated(memory, [ZEBRA], 400);

		const result = memory.sleep(false);

		expect(workingIds(memory.beam.db)).toEqual(ids);
		expect(result.pruned).toBeUndefined();
	});

	it("0 means off too", () => {
		const memory = makeMemory("zero");
		const ids = consolidated(memory, [ZEBRA], 400);
		setPrune(memory, 0);

		memory.sleep(false);

		expect(workingIds(memory.beam.db)).toEqual(ids);
	});

	it("deletes a row N days after it was summarized and the summary still answers recall", async () => {
		const memory = makeMemory("prune");
		const db = memory.beam.db;
		consolidated(memory, [ZEBRA, QUOKKA], 40);
		setPrune(memory, 30);
		expect(await surfaced(memory, "Zebrafox", true)).toContain("working:");

		const result = memory.sleep(false);

		expect(result.pruned).toMatchObject({ status: "pruned", pruned: 2 });
		expect(count(db, "SELECT COUNT(*) FROM working_memory")).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM fts_working")).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM episodic_memory")).toBe(1);
		const text = await surfaced(memory, "Zebrafox", true);
		expect(text).toContain("Zebrafox");
		expect(text).not.toContain("working:");
		expect(await surfaced(memory, "Quokka", false)).toContain("Quokka");
	});

	it("keeps a row that was summarized less than N days ago", () => {
		const memory = makeMemory("fresh");
		const ids = consolidated(memory, [ZEBRA], 10);
		setPrune(memory, 30);

		const result = memory.sleep(false);

		expect(workingIds(memory.beam.db)).toEqual(ids);
		expect(result.pruned).toMatchObject({ pruned: 0 });
	});

	it("keeps an old unconsolidated row of another session, and a row an old backlog only just summarized", () => {
		const memory = makeMemory("backlog");
		const db = memory.beam.db;
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, consolidated_at) VALUES ('other', 'old note of another session', 'x', ?, 'other-session', NULL)",
			[daysAgo(400)],
		);
		const own = memory.remember(QUOKKA, { source: "coding-agent-retain" });
		db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [daysAgo(400), own]);
		setPrune(memory, 30);

		memory.sleep(false);

		// The other session's row is not consolidated, so it is not prunable; our own overdue row is
		// summarized by this very sleep and then kept for the full N days.
		expect(workingIds(db).sort()).toEqual([own, "other"].sort());
		expect(count(db, "SELECT COUNT(*) FROM working_memory WHERE id = 'other' AND consolidated_at IS NULL")).toBe(1);
		expect(count(db, "SELECT COUNT(*) FROM episodic_memory")).toBe(1);
	});

	it("never deletes an IMPORTED row", () => {
		const memory = makeMemory("imported");
		const [id] = consolidated(memory, [ZEBRA], 400);
		if (id === undefined) throw new Error("no row");
		memory.beam.db.run("UPDATE working_memory SET trust_tier = 'IMPORTED' WHERE id = ?", [id]);
		setPrune(memory, 30);

		memory.sleep(false);

		expect(workingIds(memory.beam.db)).toEqual([id]);
	});

	it("never deletes a consolidated row that no summary covers", () => {
		const memory = makeMemory("uncovered");
		const db = memory.beam.db;
		// What the old-schema migration leaves behind: a consolidation marker with no summary.
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, consolidated_at) VALUES ('legacy', 'legacy note', 'x', ?, 'uncovered', ?)",
			[daysAgo(500), daysAgo(500)],
		);
		setPrune(memory, 30);

		memory.sleep(false);

		expect(workingIds(db)).toEqual(["legacy"]);
	});

	it("keeps a row whose only summary is retired", () => {
		const memory = makeMemory("retired-summary");
		const db = memory.beam.db;
		const [id] = consolidated(memory, [ZEBRA], 400);
		if (id === undefined) throw new Error("no row");
		db.run("UPDATE episodic_memory SET superseded_by = 'someone-else'");
		setPrune(memory, 30);

		memory.sleep(false);

		expect(workingIds(db)).toEqual([id]);

		db.run("UPDATE episodic_memory SET superseded_by = NULL, valid_until = ?", [daysAgo(1)]);
		memory.sleep(false);

		expect(workingIds(db)).toEqual([id]);
	});

	it("removes the row's annotations, vector and graph nodes, and leaves the summary's and the extracted facts", () => {
		const memory = makeMemory("artifacts");
		const db = memory.beam.db;
		const [id] = consolidated(memory, [ZEBRA], 40);
		const summary = String((db.query("SELECT id FROM episodic_memory").get() as { id: string }).id);
		if (id === undefined) throw new Error("no row");
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[1,2,3]', 'm')", [id]);
		db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[1,2,3]', 'm')", [summary]);
		db.run("INSERT INTO gists (id, text, memory_id) VALUES (?, 'gist', ?)", [`gist_${id}`, id]);
		db.run("INSERT OR IGNORE INTO graph_edges (source, target, edge_type) VALUES (?, ?, 'ctx')", [id, `gist_${id}`]);
		db.run("INSERT OR IGNORE INTO graph_edges (source, target, edge_type) VALUES (?, ?, 'related_to')", [
			summary,
			id,
		]);
		// Facts and memoria rows extracted from the row are distilled knowledge: they stay.
		db.run(
			"INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) VALUES ('f1', 's', 'Zebrafox', 'rolls out', 'soon', ?)",
			[id],
		);
		db.run(
			"INSERT INTO memoria_facts (session_id, fact_type, key, value, source_memory_id) VALUES ('s', 'date', 'rollout', '2027-04-01', ?)",
			[id],
		);
		expect(count(db, "SELECT COUNT(*) FROM annotations WHERE memory_id = ?", [id])).toBeGreaterThan(0);
		const summaryAnnotations = count(db, "SELECT COUNT(*) FROM annotations WHERE memory_id = ?", [summary]);
		const summaryEdges = count(db, "SELECT COUNT(*) FROM graph_edges WHERE source = ? AND target LIKE 'gist_%'", [
			summary,
		]);
		setPrune(memory, 30);

		memory.sleep(false);

		expect(workingIds(db)).toEqual([]);
		expect(count(db, "SELECT COUNT(*) FROM annotations WHERE memory_id = ?", [id])).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?", [id])).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM gists WHERE memory_id = ?", [id])).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM graph_edges WHERE source = ? OR target = ?", [id, id])).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?", [summary])).toBe(1);
		expect(count(db, "SELECT COUNT(*) FROM annotations WHERE memory_id = ?", [summary])).toBe(summaryAnnotations);
		expect(count(db, "SELECT COUNT(*) FROM graph_edges WHERE source = ? AND target LIKE 'gist_%'", [summary])).toBe(
			summaryEdges,
		);
		expect(count(db, "SELECT COUNT(*) FROM facts WHERE fact_id = 'f1'")).toBe(1);
		expect(count(db, "SELECT COUNT(*) FROM memoria_facts WHERE source_memory_id = ?", [id])).toBe(1);
	});

	it("dry run counts what would go and deletes nothing", () => {
		const memory = makeMemory("dry-run");
		const ids = consolidated(memory, [ZEBRA, QUOKKA], 40);
		setPrune(memory, 30);

		const result = memory.sleep(true);

		expect(result.pruned).toMatchObject({ status: "dry_run", pruned: 2 });
		expect(workingIds(memory.beam.db)).toEqual([...ids].sort());
	});

	it(`removes at most ${PRUNE_ROWS_PER_RUN} rows per run, and the next run takes the rest`, () => {
		const memory = makeMemory("cap");
		const db = memory.beam.db;
		const total = PRUNE_ROWS_PER_RUN + 25;
		const old = daysAgo(60);
		const insert = db.prepare(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, consolidated_at) VALUES (?, ?, 'x', ?, 'cap', ?)",
		);
		const ids: string[] = [];
		db.transaction(() => {
			for (let index = 0; index < total; index++) {
				const id = `wm-${index}`;
				ids.push(id);
				insert.run(id, `note ${index}`, old, old);
			}
		})();
		db.run(
			"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, summary_of, created_at) VALUES ('summary', 'all notes', 'sleep_consolidation', ?, 'cap', ?, ?)",
			[old, ids.join(","), old],
		);
		setPrune(memory, 30);

		const first = memory.sleep(false);
		expect(first.pruned).toMatchObject({ pruned: PRUNE_ROWS_PER_RUN });
		expect(count(db, "SELECT COUNT(*) FROM working_memory")).toBe(25);

		const second = memory.sleep(false);
		expect(second.pruned).toMatchObject({ pruned: 25 });
		expect(count(db, "SELECT COUNT(*) FROM working_memory")).toBe(0);
	});

	it("sleepAllSessions prunes rows of every session, once", () => {
		const memory = makeMemory("all-a");
		const db = memory.beam.db;
		const [first] = consolidated(memory, [ZEBRA], 40);
		db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, consolidated_at) VALUES ('b-row', 'note from the other session', 'x', ?, 'all-b', ?)",
			[daysAgo(60), daysAgo(40)],
		);
		db.run(
			"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, summary_of, created_at) VALUES ('b-summary', 'note from the other session', 'sleep_consolidation', ?, 'all-b', 'b-row', ?)",
			[daysAgo(40), daysAgo(40)],
		);
		if (first === undefined) throw new Error("no row");
		setPrune(memory, 30);

		const result = memory.sleepAllSessions(false);

		expect(workingIds(db)).toEqual([]);
		expect(result.pruned).toMatchObject({ status: "pruned", pruned: 2 });
	});
});

describe("pruning next to forget and invalidate", () => {
	it("a row that is still there keeps its forget cascade; the summary of a pruned row stays recallable", async () => {
		const memory = makeMemory("forget");
		const db = memory.beam.db;
		const [zebraId] = consolidated(memory, [ZEBRA], 40);
		if (zebraId === undefined) throw new Error("no row");
		setPrune(memory, 30);
		const [quokkaId] = consolidated(memory, [QUOKKA], 0);
		if (quokkaId === undefined) throw new Error("no row");
		// The sleep inside the second `consolidated` pruned the old row.
		expect(workingIds(db)).toEqual([quokkaId]);
		expect(count(db, "SELECT COUNT(*) FROM episodic_memory")).toBe(2);

		expect(memory.forget(quokkaId)).toBe(true);

		expect(count(db, "SELECT COUNT(*) FROM episodic_memory")).toBe(1);
		expect(await surfaced(memory, "Quokka", true)).not.toContain("Quokka");
		// The pruned row is gone, so `forget` cannot find it; its summary is the copy that remains.
		expect(memory.forget(zebraId)).toBe(false);
		expect(await surfaced(memory, "Zebrafox", true)).toContain("Zebrafox");
		// Pruning put the full-text delete trigger back: the forget above removed its row's full-text entry too.
		expect(count(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'wm_ad'")).toBe(1);
		expect(count(db, "SELECT COUNT(*) FROM fts_working")).toBe(count(db, "SELECT COUNT(*) FROM working_memory"));
	});
});

describe("space reclaim", () => {
	const BIG = `${"lorem ipsum dolor sit amet consectetur ".repeat(550)}`;

	/** A file database with `rows` big consolidated working rows, all listed by one small live summary. */
	function bigDatabase(dir: string, rows: number): { memory: Mnemopi; path: string } {
		const path = join(dir, "m.db");
		const memory = makeMemory("reclaim", path);
		const db = memory.beam.db;
		const old = daysAgo(60);
		const insert = db.prepare(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id, consolidated_at) VALUES (?, ?, 'x', ?, 'reclaim', ?)",
		);
		const ids: string[] = [];
		db.transaction(() => {
			for (let index = 0; index < rows; index++) {
				ids.push(`wm-${index}`);
				insert.run(`wm-${index}`, `${BIG} ${index}`, old, old);
			}
		})();
		db.run(
			"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, summary_of, created_at) VALUES ('summary', 'digest of the notes', 'sleep_consolidation', ?, 'reclaim', ?, ?)",
			[old, ids.join(","), old],
		);
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		return { memory, path };
	}

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "mnemopi-prune-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		return dir;
	}

	it("returns the freed pages to the file once a prune frees a quarter of it", () => {
		const { memory, path } = bigDatabase(tempDir(), 400);
		const before = statSync(path).size;
		expect(before).toBeGreaterThan(8_000_000);
		setPrune(memory, 30);

		const result = memory.sleep(false);
		memory.beam.db.run("PRAGMA wal_checkpoint(TRUNCATE)");

		expect(result.pruned).toMatchObject({ status: "pruned", pruned: 400, reclaimed: true });
		expect(statSync(path).size).toBeLessThan(before * 0.2);
		expect(count(memory.beam.db, "PRAGMA freelist_count")).toBe(0);
		expect(count(memory.beam.db, "SELECT COUNT(*) FROM episodic_memory")).toBe(1);
	});

	it("merges the full-text index so deleted rows leave no delete markers behind", () => {
		const { memory } = bigDatabase(tempDir(), 400);
		const db = memory.beam.db;
		db.run("UPDATE working_memory SET consolidated_at = ? WHERE id LIKE 'wm-2%' OR id LIKE 'wm-3%'", [daysAgo(1)]);
		const kept = count(db, "SELECT COUNT(*) FROM working_memory WHERE consolidated_at > ?", [daysAgo(2)]);
		const indexBytes = (): number => count(db, "SELECT SUM(pgsize) FROM dbstat WHERE name = 'fts_working_data'");
		const before = indexBytes();
		setPrune(memory, 30);

		const result = memory.sleep(false);

		expect(kept).toBeGreaterThan(100);
		expect(result.pruned).toMatchObject({ pruned: 400 - kept });
		// Without the merge the index only grows by the delete markers of the removed rows.
		expect(indexBytes()).toBeLessThan(before * 0.75);
		expect(count(db, "SELECT COUNT(*) FROM fts_working")).toBe(kept);
		db.run("INSERT INTO fts_working(fts_working) VALUES ('integrity-check')");
	});

	it("compacts on a run with nothing to prune when a quarter of the file is already free", () => {
		const { memory, path } = bigDatabase(tempDir(), 400);
		const db = memory.beam.db;
		// What a capped run leaves behind: the rows are gone, the pages are not yet returned.
		db.run("DROP TRIGGER wm_ad");
		db.run("DELETE FROM fts_working");
		db.run("DELETE FROM working_memory");
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		const before = statSync(path).size;
		setPrune(memory, 30);

		const result = memory.sleep(false);
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");

		expect(result.pruned).toMatchObject({ status: "no_op", pruned: 0, reclaimed: true });
		expect(statSync(path).size).toBeLessThan(before * 0.2);
	});

	it("does not compact the file when the prune frees little; the freed pages wait for reuse", () => {
		const { memory, path } = bigDatabase(tempDir(), 400);
		const db = memory.beam.db;
		// Only 4 of the 400 rows are old enough.
		db.run("UPDATE working_memory SET consolidated_at = ? WHERE id NOT IN ('wm-0', 'wm-1', 'wm-2', 'wm-3')", [
			daysAgo(1),
		]);
		const before = statSync(path).size;
		setPrune(memory, 30);

		const result = memory.sleep(false);
		db.run("PRAGMA wal_checkpoint(TRUNCATE)");

		expect(result.pruned).toMatchObject({ status: "pruned", pruned: 4, reclaimed: false });
		// The index merge writes its new segment before the old pages are freed, so the file may grow a little, never shrink.
		expect(statSync(path).size).toBeGreaterThanOrEqual(before);
		expect(count(db, "PRAGMA freelist_count")).toBeGreaterThan(0);
	});

	it("is safe while other processes read and write the same database", async () => {
		const dir = tempDir();
		const { memory, path } = bigDatabase(dir, 400);
		const before = statSync(path).size;
		const children: Bun.Subprocess[] = [];
		const start = async (script: string, marker: string): Promise<void> => {
			const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", script), path, marker], {
				env: { ...process.env, MNEMOPI_NO_EMBEDDINGS: "1" },
				stdout: "ignore",
				stderr: "pipe",
			});
			children.push(child);
			cleanups.push(() => child.kill("SIGKILL"));
			const deadline = performance.now() + 20_000;
			while (!existsSync(marker)) {
				if (child.exitCode !== null)
					throw new Error(`${script} exited early: ${await new Response(child.stderr).text()}`);
				if (performance.now() > deadline) throw new Error(`${script} never became ready`);
				await Bun.sleep(20);
			}
		};
		await start("prune-reader.ts", join(dir, "reader-ready"));
		await start("live-writer.ts", join(dir, "writer-ready"));
		setPrune(memory, 30);

		const result = memory.sleep(false);
		for (const child of children) child.kill("SIGKILL");
		await Promise.all(children.map(child => child.exited));
		memory.beam.db.run("PRAGMA wal_checkpoint(TRUNCATE)");

		expect(result.pruned).toMatchObject({ pruned: 400, reclaimed: true });
		expect(statSync(path).size).toBeLessThan(before * 0.3);
		// Every row the writer committed is there, in order, none lost to the compaction.
		const writer = memory.beam.db
			.query("SELECT content FROM working_memory WHERE source = 'live-writer'")
			.all()
			.map(row => Number(/live row (\d+)/.exec(String((row as { content: string }).content))?.[1]));
		expect(writer.length).toBeGreaterThanOrEqual(50);
		expect(writer.sort((a, b) => a - b)).toEqual(Array.from({ length: writer.length }, (_, index) => index + 1));
		expect(count(memory.beam.db, "SELECT COUNT(*) FROM fts_working")).toBe(writer.length);
		// The compaction left the file and its external-content full-text index consistent.
		expect(memory.beam.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		memory.beam.db.run("INSERT INTO fts_episodes(fts_episodes) VALUES ('integrity-check')");
		memory.beam.db.run("INSERT INTO fts_working(fts_working) VALUES ('integrity-check')");
	});
});
