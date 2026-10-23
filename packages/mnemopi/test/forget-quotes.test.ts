import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { aaakEncode } from "@oh-my-pi/pi-mnemopi/core/aaak";
import { windowEntries, WindowSet } from "@oh-my-pi/pi-mnemopi/core/beam/forget-windows";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import type { MnemopiLlmCompletion } from "@oh-my-pi/pi-mnemopi/core/runtime-options";

/**
 * A forgotten memory also lives in what was made from it: the facts the extractor worded their own way, the
 * transcripts that quote it in any case or punctuation, and the `sleep` summaries of those transcripts, even once
 * pruning deleted the transcript rows they list. `forget` cuts all of that, and keeps cutting it out of transcripts
 * retained after the forget, without ever storing the forgotten text.
 */
beforeEach(() => {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

const closers: (() => void)[] = [];

afterEach(() => {
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
	delete process.env.MNEMOPI_FORGET_TOMBSTONE_LIMIT;
	while (closers.length > 0) closers.pop()?.();
});

type Db = Mnemopi["beam"]["db"];
type Turn = readonly [role: "user" | "assistant", text: string];

const TRANSCRIPT = "coding-agent-transcript";
const MARKER = "OLIVE-MNEMO-6150";
// Holds " for ": a sleep summary writes it as "code→the east door", so only the compacted form is in a summary.
const MEMORY = `The delta bot's locker code for the east door is ${MARKER}.`;
// The wording the extractor gave the memory: not a substring of it.
const FACT = `delta bot east door locker code ${MARKER}`;
const UNRELATED = "Quokka migration is scheduled for 2027-05-09 with 41 gadgets";
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();
const daysAgo = (days: number): string => hoursAgo(days * 24);

/** The extractor of a real session: it words the fact its own way, for the memory and for any quote of it. */
const complete: MnemopiLlmCompletion = prompt =>
	JSON.stringify({
		facts: prompt.includes(MARKER) ? [FACT] : [],
		instructions: [],
		preferences: [],
		timelines: [],
		kg: [],
	});

function makeMemory(sessionId: string, beamConfig: { pruneConsolidatedDays?: number } = {}): Mnemopi {
	const memory = new Mnemopi({
		sessionId,
		dbPath: ":memory:",
		noEmbeddings: true,
		llm: { enabled: true, complete },
		beamConfig,
	});
	closers.push(() => memory.close());
	return memory;
}

function rows(db: Db, sql: string, params: string[] = []): string[] {
	return db
		.query(sql)
		.all(...params)
		.map(row => String(row === null || typeof row !== "object" ? "" : Object.values(row)[0]));
}

function count(db: Db, sql: string, params: string[] = []): number {
	return Number(rows(db, sql, params)[0]);
}

/** One retained transcript, framed and projected the way the coding-agent retains it, with its extraction. */
async function retainTranscript(memory: Mnemopi, turns: readonly Turn[], ageHours = 0): Promise<string> {
	const frame = (list: readonly Turn[]): string =>
		list.map(([role, text]) => `[role: ${role}]\n${text}\n[${role}:end]`).join("\n\n");
	const id = memory.remember(frame(turns), {
		source: TRANSCRIPT,
		memoryType: "episode",
		scope: "bank",
		embedText: turns.map(([, text]) => text).join("\n\n"),
		extractText: frame(turns.filter(([role]) => role === "user")),
		extract: true,
		metadata: { session_id: "s", source_id: `s-${Date.now()}`, message_count: turns.length },
	});
	await memory.flushExtractions();
	if (ageHours > 0)
		memory.beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(ageHours), id]);
	return id;
}

/** The memory, stored the way the `retain` tool stores it (with extraction). */
async function retainMemory(memory: Mnemopi, ageHours = 0, text = MEMORY): Promise<string> {
	const id = memory.remember(text, { source: "coding-agent-retain", extract: true });
	await memory.flushExtractions();
	if (ageHours > 0)
		memory.beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(ageHours), id]);
	return id;
}

const embedTextOf = (db: Db, id: string): string =>
	rows(db, "SELECT embed_text FROM working_memory WHERE id = ?", [id])[0] ?? "";

/** Every stored text a reader or a recall could reach, one blob. */
function everything(db: Db): string {
	return [
		...rows(db, "SELECT content FROM working_memory"),
		...rows(db, "SELECT COALESCE(embed_text, '') FROM working_memory"),
		...rows(db, "SELECT content FROM episodic_memory"),
		...rows(db, "SELECT subject || ' ' || predicate || ' ' || object FROM facts"),
		...rows(db, "SELECT key || ' ' || value || ' ' || context_snippet FROM memoria_facts"),
	].join("\n");
}

/** Every row of every table except the full-text and vector indexes, which keep delete markers until they merge. */
function dumpTables(db: Db): string {
	const names = rows(
		db,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_%' AND name NOT LIKE 'vec_%'",
	);
	return names
		.flatMap(name =>
			db
				.query(`SELECT * FROM "${name}"`)
				.all()
				.map(row => JSON.stringify(row)),
		)
		.join("\n")
		.toLowerCase();
}

async function recalled(memory: Mnemopi, query: string): Promise<string> {
	const found = await memory.beam.recall(query, 50, { includeWorking: true });
	const facts = memory.beam.factRecall(query, 50);
	return [...found.map(row => row.content), ...facts.map(fact => fact.content)].join("\n");
}

/** No query that reaches the forgotten memory by its words or its marker finds the marker, and none is stored. */
async function expectMarkerGone(memory: Mnemopi): Promise<void> {
	for (const query of [MARKER, "locker code", "delta bot", "east door", "olive mnemo"]) {
		expect(await recalled(memory, query)).not.toContain(MARKER);
	}
	expect(everything(memory.beam.db)).not.toContain(MARKER);
}

describe("word windows", () => {
	const salt = "fixture-salt";
	const cutWith = (forgotten: string, text: string): string =>
		new WindowSet(salt, windowEntries([forgotten], salt)).cut(text);

	it("cuts a quote in another case, other punctuation or other whitespace", () => {
		expect(cutWith(MEMORY, `Note: THE DELTA BOT'S  LOCKER CODE for the east door is olive-mnemo-6150, ok`)).toBe(
			"Note: [forgotten], ok",
		);
	});

	it("cuts the compacted form a sleep summary writes, in which `for` became an arrow", () => {
		const summary = `[${TRANSCRIPT}] ${aaakEncode(`Please remember this: ${MEMORY} | Stored it.`)}`;
		expect(summary).toContain("code→the east door");

		expect(cutWith(MEMORY, summary)).toBe(`[${TRANSCRIPT}] Please remember this: [forgotten]. | Stored it.`);
	});

	it("cuts a partial quote of five words or more, and leaves a shorter one", () => {
		expect(cutWith(MEMORY, `Code: door is ${MARKER}`)).toBe("Code: [forgotten]");
		expect(cutWith(MEMORY, `Code: the code is ${MARKER}`)).toBe(`Code: the code is ${MARKER}`);
	});

	it("marks two quotes separately, and a chain of windows as one mark", () => {
		expect(cutWith(MEMORY, `${MEMORY} and also ${MEMORY}`)).toBe("[forgotten]. and also [forgotten].");
	});

	it("keeps no window for a text under eight characters, of one word, or of only numbers", () => {
		for (const text of ["ab cd", "supercalifragilistic", "2027-04-01 2027-05-09", "12345678"]) {
			expect(windowEntries([text], salt)).toEqual([]);
		}
		expect(windowEntries(["Quetzalbolt-7731"], salt)).toHaveLength(1);
	});

	it("keeps hashes, never words", () => {
		const entries = windowEntries([MEMORY], salt);

		expect(entries.length).toBeGreaterThan(5);
		expect(JSON.stringify(entries).toLowerCase()).not.toMatch(/olive|mnemo|6150|delta|locker/);
		for (const entry of entries) expect(entry.digest).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("forget scrubs the wording the extractor gave the memory", () => {
	it("cuts the wording of an extracted fact out of a transcript that quoted only the fact", async () => {
		const memory = makeMemory("derived-fact");
		const db = memory.beam.db;
		const note = await retainMemory(memory);
		expect(rows(db, "SELECT object FROM facts WHERE source_msg_id = ?", [note])).toEqual([FACT]);
		// The recall session's transcript quotes what the recall showed: the fact's wording, not the memory's.
		const quoted = await retainTranscript(memory, [
			["user", "What is the locker code of the delta bot?"],
			["assistant", `From memory: ${FACT}. Anything else?`],
		]);
		expect(await recalled(memory, MARKER)).toContain(MARKER);

		expect(memory.forget(note)).toBe(true);

		expect(embedTextOf(db, quoted)).toBe(
			"What is the locker code of the delta bot?\n\nFrom memory: [forgotten]. Anything else?",
		);
		await expectMarkerGone(memory);
	});

	it("hands the memory's text and the extractor's wording to the other banks of a session", async () => {
		const memory = makeMemory("report-texts");
		const note = await retainMemory(memory);

		const outcome = memory.forgetDetailed(note);

		expect(outcome.deleted).toBe(true);
		expect([...outcome.forgottenTexts].sort()).toEqual([FACT, MEMORY].sort());
	});
});

describe("a tombstone cuts the forgotten text out of transcripts retained after the forget", () => {
	it("cuts the memory, the fact's wording and a reformatted quote, and keeps the rest", async () => {
		const memory = makeMemory("tombstone-retain");
		const db = memory.beam.db;
		const note = await retainMemory(memory);
		expect(memory.forget(note)).toBe(true);

		// The forgetting session, and a session that was open before the forget, end after it.
		const forgetting = await retainTranscript(memory, [
			["user", "Forget the locker code of the delta bot."],
			["assistant", `Forgotten: ${MEMORY} (stored as: ${FACT}). Done.`],
		]);
		const open = await retainTranscript(memory, [
			["user", `Earlier I recalled: ${MEMORY.toUpperCase()}`],
			["assistant", "Noted that earlier recall."],
		]);

		expect(embedTextOf(db, forgetting)).toBe(
			"Forget the locker code of the delta bot.\n\nForgotten: [forgotten]. (stored as: [forgotten]). Done.",
		);
		expect(embedTextOf(db, open)).toBe("Earlier I recalled: [forgotten].\n\nNoted that earlier recall.");
		expect(rows(db, "SELECT content FROM working_memory WHERE id = ?", [open])[0]).toStartWith(
			"[role: user]\nEarlier I recalled: [forgotten].",
		);
		// The facts mined from those transcripts do not carry the text either.
		await expectMarkerGone(memory);
	});

	it("leaves an unrelated transcript, a short quote and a memory stored again on purpose alone", async () => {
		const memory = makeMemory("tombstone-bounds");
		const db = memory.beam.db;
		const note = await retainMemory(memory);
		expect(memory.forget(note)).toBe(true);

		const unrelated = await retainTranscript(memory, [["user", UNRELATED]]);
		const partial = await retainTranscript(memory, [["user", `The code is ${MARKER}`]]);
		const again = memory.remember(MEMORY, { source: "coding-agent-retain" });

		expect(embedTextOf(db, unrelated)).toBe(UNRELATED);
		// A quote of fewer than five words is not the forgotten text.
		expect(embedTextOf(db, partial)).toBe(`The code is ${MARKER}`);
		// A memory the user stores again is theirs to keep.
		expect(rows(db, "SELECT content FROM working_memory WHERE id = ?", [again])).toEqual([MEMORY]);
	});

	it("leaves transcripts alone after invalidate, which keeps history", async () => {
		const memory = makeMemory("tombstone-invalidate");
		const db = memory.beam.db;
		const note = await retainMemory(memory);
		expect(memory.beam.invalidate(note)).toBe(true);

		const later = await retainTranscript(memory, [["assistant", `Recalled: ${MEMORY}`]]);

		expect(count(db, "SELECT COUNT(*) FROM forget_tombstones")).toBe(0);
		expect(embedTextOf(db, later)).toBe(`Recalled: ${MEMORY}`);
	});

	it("never stores the forgotten text", async () => {
		const memory = makeMemory("tombstone-plaintext");
		const db = memory.beam.db;
		const note = await retainMemory(memory);
		await retainTranscript(memory, [["assistant", `Recalled: ${FACT}`]]);
		expect(memory.forget(note)).toBe(true);
		await retainTranscript(memory, [["assistant", `Forgot ${MEMORY}`]]);

		expect(count(db, "SELECT COUNT(*) FROM forget_tombstones")).toBeGreaterThan(5);
		const dump = dumpTables(db);
		for (const piece of ["olive", "mnemo", "6150", "east door"]) expect(dump).not.toContain(piece);
		// What is stored: a window size, two hashes and a time, and one random salt.
		const [tombstone] = db.query("SELECT * FROM forget_tombstones LIMIT 1").all() as Record<string, unknown>[];
		expect(Object.keys(tombstone ?? {}).sort()).toEqual(["created_at", "digest", "id", "ntokens", "roll"]);
		expect(count(db, "SELECT COUNT(*) FROM forget_tombstone_salt")).toBe(1);
	});

	it("keeps each window once, however often it is forgotten", async () => {
		const memory = makeMemory("tombstone-dedupe");
		const db = memory.beam.db;
		expect(memory.forget(memory.remember(MEMORY, { source: "coding-agent-retain" }))).toBe(true);
		const once = count(db, "SELECT COUNT(*) FROM forget_tombstones");

		expect(memory.forget(memory.remember(MEMORY, { source: "coding-agent-retain" }))).toBe(true);

		expect(count(db, "SELECT COUNT(*) FROM forget_tombstones")).toBe(once);
	});

	it("keeps the newest tombstones and drops the oldest once the list is full", async () => {
		process.env.MNEMOPI_FORGET_TOMBSTONE_LIMIT = "3";
		const memory = makeMemory("tombstone-limit");
		const db = memory.beam.db;
		const texts = [0, 1, 2, 3, 4].map(index => `Zeta${index} omega${index} sigma${index} kappa${index}`);
		for (const text of texts) {
			expect(memory.forget(memory.remember(text, { source: "coding-agent-retain" }))).toBe(true);
		}

		expect(count(db, "SELECT COUNT(*) FROM forget_tombstones")).toBe(3);
		const oldest = await retainTranscript(memory, [["user", `Quote: ${texts[0]}`]]);
		const newest = await retainTranscript(memory, [["user", `Quote: ${texts[4]}`]]);
		expect(embedTextOf(db, oldest)).toBe(`Quote: ${texts[0]}`);
		expect(embedTextOf(db, newest)).toBe("Quote: [forgotten]");
	});

	it("records no tombstone for a text of one word or only numbers", () => {
		const memory = makeMemory("tombstone-generic");
		const db = memory.beam.db;
		for (const text of ["supercalifragilistic", "2027-04-01 2027-05-09", "12345678"]) {
			expect(memory.forget(memory.remember(text, { source: "coding-agent-retain" }))).toBe(true);
		}
		expect(count(db, "SELECT COUNT(*) FROM forget_tombstones")).toBe(0);

		expect(memory.forget(memory.remember("Quetzalbolt-7731", { source: "coding-agent-retain" }))).toBe(true);
		expect(count(db, "SELECT COUNT(*) FROM forget_tombstones")).toBeGreaterThan(0);
	});

	it("finds a quote in a very long memory, which has too many windows to name in the candidate query", async () => {
		const memory = makeMemory("tombstone-long");
		const db = memory.beam.db;
		const words = Array.from({ length: 600 }, (_, index) => `w${index}alpha`);
		const note = memory.remember(words.join(" "), { source: "coding-agent-retain" });
		const quoted = await retainTranscript(memory, [["user", `Intro: ${words.slice(100, 160).join(" ")} outro`]]);

		expect(memory.forget(note)).toBe(true);

		expect(embedTextOf(db, quoted)).toBe("Intro: [forgotten] outro");
	});
});

describe("forget cuts the summaries of transcripts whose rows were pruned", () => {
	/** The memory, three transcripts (two quote it, one does not) and a `sleep` that summarizes them, then a prune. */
	async function seedPruned(memory: Mnemopi): Promise<{ note: string; pruned: string[]; kept: string }> {
		const db = memory.beam.db;
		const note = await retainMemory(memory, 13);
		const stored = await retainTranscript(
			memory,
			[
				["user", `Please remember this: ${MEMORY}`],
				["assistant", "Stored it."],
			],
			13,
		);
		const recalledBy = await retainTranscript(
			memory,
			[
				["user", "What is the locker code of the delta bot?"],
				["assistant", `From memory: ${FACT}.`],
			],
			13,
		);
		const kept = await retainTranscript(
			memory,
			[
				["user", "When does the quokka migration start?"],
				["assistant", `${UNRELATED}.`],
			],
			13,
		);
		memory.sleep(false);
		// The two quoting transcripts were summarized three days ago: the next sleep prunes them.
		for (const id of [stored, recalledBy])
			db.run("UPDATE working_memory SET consolidated_at = ? WHERE id = ?", [daysAgo(3), id]);
		memory.sleep(false);
		return { note, pruned: [stored, recalledBy], kept };
	}

	it("cuts the text out of a summary that also covers rows that are gone, and keeps the rest of it", async () => {
		const memory = makeMemory("pruned-summary", { pruneConsolidatedDays: 1 });
		const db = memory.beam.db;
		const { note, pruned, kept } = await seedPruned(memory);
		for (const id of pruned) expect(count(db, "SELECT COUNT(*) FROM working_memory WHERE id = ?", [id])).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM working_memory WHERE id IN (?, ?)", [note, kept])).toBe(2);
		const [summaryId = ""] = rows(db, "SELECT id FROM episodic_memory WHERE summary_of LIKE ?", [`%${kept}%`]);
		const [before = ""] = rows(db, "SELECT content FROM episodic_memory WHERE id = ?", [summaryId]);
		// Pruning kept the summary and the facts extracted from the rows it deleted: the text is still recallable.
		expect(before).toContain(MARKER);
		expect(count(db, "SELECT COUNT(*) FROM facts WHERE object LIKE ?", [`%${MARKER}%`])).toBeGreaterThan(1);
		expect(await recalled(memory, MARKER)).toContain(MARKER);

		expect(memory.forget(note)).toBe(true);

		await expectMarkerGone(memory);
		// The summary was rewritten from the old one: the same rows, the text cut, the rest of it kept.
		const [replacement = ""] = rows(db, "SELECT id FROM episodic_memory WHERE summary_of LIKE ?", [`%${kept}%`]);
		expect(replacement).not.toBe(summaryId);
		expect(count(db, "SELECT COUNT(*) FROM episodic_memory WHERE id = ?", [summaryId])).toBe(0);
		const [content = ""] = rows(db, "SELECT content FROM episodic_memory WHERE id = ?", [replacement]);
		expect(content).toContain("[forgotten]");
		expect(content).toContain("Quokka migration");
		expect(content).toContain("41 gadgets");
		expect(
			rows(db, "SELECT summary_of FROM episodic_memory WHERE id = ?", [replacement])[0]?.split(",").sort(),
		).toEqual([...pruned, kept].sort());
		expect(
			JSON.parse(rows(db, "SELECT metadata_json FROM episodic_memory WHERE id = ?", [replacement])[0] ?? "{}"),
		).toMatchObject({
			source: TRANSCRIPT,
			rebuilt_from: summaryId,
		});
		// Its full-text rows and its facts follow the new text.
		expect(count(db, "SELECT COUNT(*) FROM fts_episodes WHERE fts_episodes MATCH ?", ['"olive"'])).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM facts WHERE source_msg_id = ?", [summaryId])).toBe(0);
		// The facts extracted from the pruned rows are gone with the text; the other transcripts' facts stay.
		for (const id of pruned) expect(count(db, "SELECT COUNT(*) FROM facts WHERE source_msg_id = ?", [id])).toBe(0);
	});

	it("keeps the part of a summary that its pruned rows wrote when a live row it lists has to be cut too", async () => {
		const memory = makeMemory("pruned-mixed", { pruneConsolidatedDays: 1 });
		const db = memory.beam.db;
		const note = await retainMemory(memory, 13);
		const live = await retainTranscript(
			memory,
			[
				["user", `Please remember this: ${MEMORY}`],
				["assistant", "Stored it."],
			],
			13,
		);
		const gone = await retainTranscript(
			memory,
			[
				["user", "When does the quokka migration start?"],
				["assistant", `${UNRELATED}.`],
			],
			13,
		);
		memory.sleep(false);
		db.run("UPDATE working_memory SET consolidated_at = ? WHERE id = ?", [daysAgo(3), gone]);
		memory.sleep(false);
		expect(count(db, "SELECT COUNT(*) FROM working_memory WHERE id = ?", [gone])).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM working_memory WHERE id = ?", [live])).toBe(1);

		expect(memory.forget(note)).toBe(true);

		expect(embedTextOf(db, live)).toBe("Please remember this: [forgotten]\n\nStored it.");
		// The summary lists the live row it had to cut and the pruned one it cannot rebuild from: it is cut in place, not deleted.
		const [summary = ""] = rows(db, "SELECT content FROM episodic_memory WHERE summary_of LIKE ?", [`%${gone}%`]);
		expect(summary).toContain("[forgotten]");
		expect(summary).toContain("Quokka migration");
		await expectMarkerGone(memory);
	});

	it("embeds the rewritten summary again from its new text, and its old vector goes with it", async () => {
		delete process.env.MNEMOPI_NO_EMBEDDINGS;
		const embedded: string[] = [];
		const provider = async function* (texts: readonly string[]) {
			embedded.push(...texts);
			yield texts.map(text => (text.toLowerCase().includes("olive") ? [1, 0, 0, 0] : [0, 0, 0, 1]));
		};
		const memory = new Mnemopi({
			db: new Database(":memory:"),
			sessionId: "pruned-embed",
			embeddings: { provider },
			llm: { enabled: true, complete },
			beamConfig: { pruneConsolidatedDays: 1 },
		});
		closers.push(() => memory.close());
		const db = memory.beam.db;
		const { note, kept } = await seedPruned(memory);
		await memory.flushExtractions();
		const [summaryId = ""] = rows(db, "SELECT id FROM episodic_memory WHERE summary_of LIKE ?", [`%${kept}%`]);
		const vectorOf = (id: string): string[] =>
			rows(db, "SELECT embedding_json FROM memory_embeddings WHERE memory_id = ?", [id]);
		expect(vectorOf(summaryId)).toEqual(["[1,0,0,0]"]);
		embedded.length = 0;

		expect(memory.forget(note)).toBe(true);

		expect(vectorOf(summaryId)).toEqual([]);
		await memory.flushExtractions();
		const [replacement = ""] = rows(db, "SELECT id FROM episodic_memory WHERE summary_of LIKE ?", [`%${kept}%`]);
		const [content = ""] = rows(db, "SELECT content FROM episodic_memory WHERE id = ?", [replacement]);
		expect(embedded).toContain(content);
		expect(vectorOf(replacement)).toEqual(["[0,0,0,1]"]);
	});

	it("deletes a retired summary that holds the text, because the text has to go", async () => {
		const memory = makeMemory("pruned-retired", { pruneConsolidatedDays: 1 });
		const db = memory.beam.db;
		const { note, kept } = await seedPruned(memory);
		const [summaryId = ""] = rows(db, "SELECT id FROM episodic_memory WHERE summary_of LIKE ?", [`%${kept}%`]);
		expect(memory.beam.invalidate(summaryId)).toBe(true);

		expect(memory.forget(note)).toBe(true);

		expect(count(db, "SELECT COUNT(*) FROM episodic_memory WHERE content LIKE ?", [`%${MARKER}%`])).toBe(0);
		await expectMarkerGone(memory);
	});

	it("leaves the summary of a deliberately retained row alone", async () => {
		const memory = makeMemory("pruned-learned", { pruneConsolidatedDays: 1 });
		const db = memory.beam.db;
		const lesson = memory.remember(`Lesson: ${MEMORY}`, { source: "coding-agent-learn" });
		db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(13), lesson]);
		const { note } = await seedPruned(memory);

		expect(memory.forget(note)).toBe(true);

		// Its source row and its summary are the user's own memory of the same words.
		expect(rows(db, "SELECT content FROM working_memory WHERE id = ?", [lesson])[0]).toContain(MARKER);
		expect(rows(db, "SELECT content FROM episodic_memory WHERE summary_of LIKE ?", [`%${lesson}%`])[0]).toContain(
			MARKER,
		);
	});

	it("cuts a one-word secret by its literal text, which has no windows, out of a pruned summary and its facts", async () => {
		const memory = makeMemory("pruned-literal", { pruneConsolidatedDays: 1 });
		const db = memory.beam.db;
		const key = "Xk9VmQ2rTz7WnLb4HpYcRv3S";
		const note = memory.remember(key, { source: "coding-agent-retain" });
		const quoting = await retainTranscript(memory, [
			["user", `My key is ${key}, keep it safe`],
			["assistant", "Noted."],
		]);
		const other = await retainTranscript(memory, [["user", UNRELATED]]);
		for (const id of [note, quoting, other])
			db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(13), id]);
		memory.sleep(false);
		db.run("UPDATE working_memory SET consolidated_at = ? WHERE id = ?", [daysAgo(3), quoting]);
		memory.sleep(false);
		expect(count(db, "SELECT COUNT(*) FROM working_memory WHERE id = ?", [quoting])).toBe(0);
		expect(rows(db, "SELECT content FROM episodic_memory").join("\n")).toContain(key);

		expect(memory.forget(note)).toBe(true);

		expect(everything(db)).not.toContain(key);
		expect(rows(db, "SELECT content FROM episodic_memory WHERE summary_of LIKE ?", [`%${other}%`])[0]).toContain(
			"[forgotten]",
		);
		expect(count(db, "SELECT COUNT(*) FROM forget_tombstones")).toBe(0);
	});
});
