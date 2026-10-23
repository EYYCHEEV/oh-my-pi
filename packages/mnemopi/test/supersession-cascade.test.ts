import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

function count(db: Db, sql: string, params: string[] = []): number {
	const row = db.query(sql).get(...params);
	const value = row === null || typeof row !== "object" ? undefined : Object.values(row)[0];
	if (typeof value !== "number") throw new Error(`not a number: ${sql}`);
	return value;
}

function column(db: Db, sql: string, params: string[] = []): string[] {
	return db
		.query(sql)
		.all(...params)
		.map(row => String(row === null || typeof row !== "object" ? "" : Object.values(row)[0]));
}

/** One note per entry, aged 13 h so `sleep` takes them, then consolidated into episodic summaries. */
function rememberAndConsolidate(memory: Mnemopi, notes: readonly string[]): string[] {
	const ids = notes.map(note => memory.remember(note, { source: "coding-agent-retain" }));
	for (const id of ids) memory.beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(13), id]);
	memory.sleep(false);
	return ids;
}

/** Everything recall can show for `query`: scored rows (episodic summaries too) plus extracted facts. */
async function surfaced(memory: Mnemopi, query: string, includeWorking = true): Promise<string> {
	const rows = await memory.beam.recall(query, 20, { includeWorking });
	const facts = memory.beam.factRecall(query, 20);
	return [
		...rows.map(row => `${row.tier_label}: ${row.content}`),
		...facts.map(fact => `fact: ${fact.subject ?? ""} ${fact.predicate ?? ""} ${fact.content}`),
	].join("\n");
}

const ZEBRA = "Zebrafox rollout is scheduled for 2027-04-01 with 77 widgets";
const QUOKKA = "Quokka migration is scheduled for 2027-05-09 with 41 gadgets";

describe("retiring a consolidated working row retires what was derived from it", () => {
	it("invalidate hides the episodic copy of a single-row summary and the facts extracted from it", async () => {
		const memory = makeMemory("invalidate-single");
		const db = memory.beam.db;
		const [id] = rememberAndConsolidate(memory, [ZEBRA]);
		if (id === undefined) throw new Error("no row");
		expect(count(db, "SELECT COUNT(*) FROM episodic_memory")).toBe(1);
		expect(await surfaced(memory, "Zebrafox", false)).toContain("Zebrafox");

		expect(memory.beam.invalidate(id)).toBe(true);

		expect(await surfaced(memory, "Zebrafox")).not.toContain("Zebrafox");
		expect(await surfaced(memory, "2027-04-01")).not.toContain("2027-04-01");
		// Soft retirement: the rows stay readable by id, like the working row they came from.
		expect(memory.get(id)).not.toBeNull();
		expect(count(db, "SELECT COUNT(*) FROM episodic_memory WHERE valid_until IS NOT NULL")).toBe(1);
	});

	it("forget deletes the episodic copy of a single-row summary and the facts extracted from it", async () => {
		const memory = makeMemory("forget-single");
		const db = memory.beam.db;
		const [id] = rememberAndConsolidate(memory, [ZEBRA]);
		if (id === undefined) throw new Error("no row");
		expect(count(db, "SELECT COUNT(*) FROM facts")).toBeGreaterThan(0);

		expect(memory.forget(id)).toBe(true);

		expect(count(db, "SELECT COUNT(*) FROM episodic_memory")).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM facts")).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM fts_episodes WHERE fts_episodes MATCH 'Zebrafox'")).toBe(0);
		expect(await surfaced(memory, "Zebrafox")).not.toContain("Zebrafox");
		expect(await surfaced(memory, "2027-04-01")).not.toContain("2027-04-01");
	});

	it("forget rewrites a multi-row summary without the forgotten row and keeps the other rows' summary and facts", async () => {
		const memory = makeMemory("forget-multi");
		const db = memory.beam.db;
		const [zebraId, quokkaId] = rememberAndConsolidate(memory, [ZEBRA, QUOKKA]);
		if (zebraId === undefined || quokkaId === undefined) throw new Error("no rows");
		// One summary covers both rows.
		expect(column(db, "SELECT summary_of FROM episodic_memory")).toEqual([`${zebraId},${quokkaId}`]);
		const [oldTimestamp] = column(db, "SELECT timestamp FROM episodic_memory");

		expect(memory.forget(zebraId)).toBe(true);

		// The old summary is gone; one rewritten summary covers only the other row, at the old time.
		expect(column(db, "SELECT summary_of FROM episodic_memory")).toEqual([quokkaId]);
		expect(column(db, "SELECT timestamp FROM episodic_memory")).toEqual([oldTimestamp ?? ""]);
		expect(column(db, "SELECT content FROM episodic_memory").join("\n")).not.toContain("Zebrafox");
		expect(count(db, "SELECT COUNT(*) FROM fts_episodes WHERE fts_episodes MATCH 'Zebrafox'")).toBe(0);
		expect(column(db, "SELECT object FROM facts").join("\n")).not.toContain("2027-04-01");

		// The unrelated row keeps its summary and facts.
		expect(await surfaced(memory, "Quokka", false)).toContain("Quokka migration");
		expect(await surfaced(memory, "2027-05-09")).toContain("2027-05-09");
		expect(await surfaced(memory, "Zebrafox")).not.toContain("Zebrafox");
		expect(await surfaced(memory, "2027-04-01")).not.toContain("2027-04-01");
	});

	it("invalidate retires a multi-row summary in favour of one without the invalidated row", async () => {
		const memory = makeMemory("invalidate-multi");
		const db = memory.beam.db;
		const [zebraId, quokkaId] = rememberAndConsolidate(memory, [ZEBRA, QUOKKA]);
		if (zebraId === undefined || quokkaId === undefined) throw new Error("no rows");
		const [oldSummaryId] = column(db, "SELECT id FROM episodic_memory");

		expect(memory.beam.invalidate(zebraId)).toBe(true);

		const live = column(db, "SELECT id FROM episodic_memory WHERE valid_until IS NULL");
		expect(live).toHaveLength(1);
		expect(live[0]).not.toBe(oldSummaryId);
		// The old summary is kept, expired, and points at its replacement.
		expect(column(db, "SELECT superseded_by FROM episodic_memory WHERE id = ?", [oldSummaryId ?? ""])).toEqual(live);
		expect(column(db, "SELECT summary_of FROM episodic_memory WHERE valid_until IS NULL")).toEqual([quokkaId]);

		expect(await surfaced(memory, "Quokka", false)).toContain("Quokka migration");
		expect(await surfaced(memory, "2027-05-09")).toContain("2027-05-09");
		expect(await surfaced(memory, "Zebrafox", false)).not.toContain("Zebrafox");
		expect(await surfaced(memory, "2027-04-01")).not.toContain("2027-04-01");
	});

	it("retires a summary it cannot rewrite as a whole instead of leaving the retired text recallable", async () => {
		const memory = makeMemory("custom-digest");
		const db = memory.beam.db;
		const ids = [ZEBRA, QUOKKA].map(note => memory.remember(note, { source: "coding-agent-retain" }));
		const [zebraId, quokkaId] = ids;
		if (zebraId === undefined || quokkaId === undefined) throw new Error("no rows");
		// A caller-supplied digest, not a `sleep` summary: there is no way to cut one row out of its text.
		memory.beam.consolidateToEpisodic("Digest of the Zebrafox rollout and the Quokka migration", ids, "digest");
		expect(await surfaced(memory, "Zebrafox", false)).toContain("Zebrafox");

		expect(memory.forget(zebraId)).toBe(true);

		expect(count(db, "SELECT COUNT(*) FROM episodic_memory")).toBe(0);
		expect(await surfaced(memory, "Zebrafox")).not.toContain("Zebrafox");
		// The other row is still its own working row.
		expect(await surfaced(memory, "Quokka")).toContain("Quokka migration");
	});

	it("hides facts extracted from an episodic row once that row is invalidated", async () => {
		const memory = makeMemory("invalidate-episodic");
		const db = memory.beam.db;
		rememberAndConsolidate(memory, [ZEBRA]);
		const [summaryId] = column(db, "SELECT id FROM episodic_memory");
		expect(memory.beam.factRecall("2027-04-01", 10).map(fact => fact.content)).toContain("2027-04-01");

		expect(memory.beam.invalidate(summaryId ?? "")).toBe(true);

		expect(memory.beam.factRecall("2027-04-01", 10)).toEqual([]);
	});
});
