import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { logger } from "@oh-my-pi/pi-utils";

// Embeddings install on demand; these tests never run an embedding model.
beforeEach(() => {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

const closers: (() => void)[] = [];

afterEach(() => {
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
	while (closers.length > 0) closers.pop()?.();
});

type Db = Mnemopi["beam"]["db"];

const TRANSCRIPT = "coding-agent-transcript";
const MARKER = "Quetzalbolt-7731";
const SECRET = `The staging deploy token is ${MARKER} and it rotates on 2027-04-01`;
const UNRELATED = "Quokka migration is scheduled for 2027-05-09 with 41 gadgets";
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

function makeMemory(sessionId: string): Mnemopi {
	const memory = new Mnemopi({ sessionId, dbPath: ":memory:", noEmbeddings: true });
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

type Turn = readonly [role: "user" | "assistant", text: string];

/** One retained session transcript, framed and projected the way the coding-agent retains it. */
function retainTranscript(memory: Mnemopi, turns: readonly Turn[], ageHours = 0): string {
	const content = turns.map(([role, text]) => `[role: ${role}]\n${text}\n[${role}:end]`).join("\n\n");
	const embedText = turns.map(([, text]) => text).join("\n\n");
	const id = memory.remember(content, {
		source: TRANSCRIPT,
		memoryType: "episode",
		scope: "bank",
		embedText,
		metadata: { session_id: "s", source_id: `s-${Date.now()}`, message_count: turns.length },
	});
	if (ageHours > 0)
		memory.beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(ageHours), id]);
	return id;
}

/** The session that stored the memory, and a later one whose recall showed it, plus one that never saw it. */
function seedTranscripts(memory: Mnemopi, ageHours = 0): { stored: string; recalled: string; unrelated: string } {
	return {
		stored: retainTranscript(
			memory,
			[
				["user", `Please remember this: ${SECRET}`],
				["assistant", `Stored it. ${SECRET}. Anything else about the staging cluster?`],
			],
			ageHours,
		),
		recalled: retainTranscript(
			memory,
			[
				["user", "What is the staging deploy token?"],
				["assistant", `From memory: ${SECRET}. It is the one for the staging cluster.`],
			],
			ageHours,
		),
		unrelated: retainTranscript(
			memory,
			[
				["user", "When does the quokka migration start?"],
				["assistant", `${UNRELATED}.`],
			],
			ageHours,
		),
	};
}

/** Every stored text a reader or a recall could reach, one blob. */
function everything(db: Db): string {
	return [
		...rows(db, "SELECT content FROM working_memory"),
		...rows(db, "SELECT COALESCE(embed_text, '') FROM working_memory"),
		...rows(db, "SELECT content FROM episodic_memory"),
		...rows(db, "SELECT subject || ' ' || predicate || ' ' || object FROM facts"),
		...rows(db, "SELECT key || ' ' || value || ' ' || context_snippet FROM memoria_facts"),
		...rows(db, "SELECT description FROM memoria_timelines"),
		...rows(db, "SELECT subject || ' ' || predicate || ' ' || object FROM memoria_kg"),
	].join("\n");
}

/** What `recall` can show for `query` from every tier, plus extracted facts. */
async function surfaced(memory: Mnemopi, query: string): Promise<string> {
	const found = await memory.beam.recall(query, 50, { includeWorking: true });
	const facts = memory.beam.factRecall(query, 50);
	return [
		...found.map(row => `${row.tier_label}: ${row.content}`),
		...facts.map(fact => `fact: ${fact.subject ?? ""} ${fact.predicate ?? ""} ${fact.content}`),
	].join("\n");
}

describe("forget scrubs the forgotten text out of retained transcripts", () => {
	it("cuts the text out of working transcript rows, keeps the rest of each row and every index in step", async () => {
		const memory = makeMemory("scrub-working");
		const db = memory.beam.db;
		const forgotten = memory.remember(SECRET, { source: "coding-agent-retain" });
		const { stored, recalled, unrelated } = seedTranscripts(memory);
		const unrelatedBefore = rows(
			db,
			"SELECT content || '|' || COALESCE(embed_text, '') FROM working_memory WHERE id = ?",
			[unrelated],
		);
		expect(await surfaced(memory, MARKER)).toContain(MARKER);

		expect(memory.forget(forgotten)).toBe(true);

		expect(everything(db)).not.toContain(MARKER);
		expect(everything(db)).not.toContain("2027-04-01");
		expect(count(db, "SELECT COUNT(*) FROM fts_working WHERE fts_working MATCH ?", [`"${MARKER}"`])).toBe(0);
		expect(await surfaced(memory, MARKER)).not.toContain(MARKER);
		expect(await surfaced(memory, "staging deploy token")).not.toContain(MARKER);

		// Only the span goes: the framing, the other words and the metadata of each row stay.
		const [storedContent] = rows(db, "SELECT content FROM working_memory WHERE id = ?", [stored]);
		expect(storedContent).toBe(
			"[role: user]\nPlease remember this: [forgotten]\n[user:end]\n\n[role: assistant]\nStored it. [forgotten]. Anything else about the staging cluster?\n[assistant:end]",
		);
		const [recalledProjection] = rows(db, "SELECT embed_text FROM working_memory WHERE id = ?", [recalled]);
		expect(recalledProjection).toBe(
			"What is the staging deploy token?\n\nFrom memory: [forgotten]. It is the one for the staging cluster.",
		);
		expect(
			rows(db, "SELECT json_extract(metadata_json, '$.message_count') FROM working_memory WHERE id = ?", [stored]),
		).toEqual(["2"]);

		// A transcript that never held the text is not touched at all.
		expect(
			rows(db, "SELECT content || '|' || COALESCE(embed_text, '') FROM working_memory WHERE id = ?", [unrelated]),
		).toEqual(unrelatedBefore);
		expect(await surfaced(memory, "quokka migration")).toContain(UNRELATED);
	});

	it("rebuilds the summary sleep made from the transcripts, with its facts, without the text", async () => {
		const memory = makeMemory("scrub-consolidated");
		const db = memory.beam.db;
		const forgotten = memory.remember(SECRET, { source: "coding-agent-retain" });
		db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(13), forgotten]);
		const { stored, recalled, unrelated } = seedTranscripts(memory, 13);
		memory.sleep(false);
		// One summary of the retained note, one of the three transcripts.
		expect(count(db, "SELECT COUNT(*) FROM episodic_memory")).toBe(2);
		const [oldSummary] = rows(db, "SELECT id FROM episodic_memory WHERE summary_of LIKE ?", [`%${stored}%`]);
		expect(rows(db, "SELECT content FROM episodic_memory WHERE id = ?", [oldSummary ?? ""]).join()).toContain(MARKER);
		expect(count(db, "SELECT COUNT(*) FROM facts WHERE object = '2027-04-01'")).toBeGreaterThan(0);

		expect(memory.forget(forgotten)).toBe(true);

		expect(everything(db)).not.toContain(MARKER);
		expect(everything(db)).not.toContain("2027-04-01");
		expect(count(db, "SELECT COUNT(*) FROM fts_episodes WHERE fts_episodes MATCH ?", [`"${MARKER}"`])).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM fts_working WHERE fts_working MATCH ?", [`"${MARKER}"`])).toBe(0);
		expect(await surfaced(memory, MARKER)).not.toContain(MARKER);
		expect(await surfaced(memory, "2027-04-01")).not.toContain("2027-04-01");

		// The transcripts keep one summary of their own: a new one, from their live (scrubbed) text.
		const live = rows(db, "SELECT id FROM episodic_memory");
		expect(live).toHaveLength(1);
		expect(live).not.toContain(oldSummary ?? "");
		const [summaryOf] = rows(db, "SELECT summary_of FROM episodic_memory");
		expect(summaryOf?.split(",").sort()).toEqual([stored, recalled, unrelated].sort());
		const [summaryText] = rows(db, "SELECT content FROM episodic_memory");
		expect(summaryText).toContain("[forgotten]");
		// Summaries are compacted text, so look for the unrelated transcript by its words.
		expect(summaryText).toContain("Quokka migration");
		expect(summaryText).toContain("41 gadgets");
		// The unrelated transcript still has its facts, now through the rebuilt summary.
		expect(await surfaced(memory, "2027-05-09")).toContain("2027-05-09");
	});

	it("drops the facts extracted from a scrubbed transcript row and keeps the other rows' facts", async () => {
		const memory = makeMemory("scrub-facts");
		const db = memory.beam.db;
		const forgotten = memory.remember(SECRET, { source: "coding-agent-retain" });
		const { stored, recalled, unrelated } = seedTranscripts(memory);
		memory.beam.extractAndStoreFacts(`I prefer ${MARKER} for staging deploys`, 0, stored);
		memory.beam.extractAndStoreFacts(`I use ${MARKER} when I deploy`, 0, recalled);
		memory.beam.extractAndStoreFacts("I use Neovim every day", 0, unrelated);
		expect(count(db, "SELECT COUNT(*) FROM facts WHERE object LIKE ?", [`%${MARKER}%`])).toBeGreaterThan(1);
		expect(count(db, "SELECT COUNT(*) FROM memoria_facts WHERE source_memory_id = ?", [stored])).toBeGreaterThan(0);

		expect(memory.forget(forgotten)).toBe(true);

		expect(count(db, "SELECT COUNT(*) FROM facts WHERE source_msg_id IN (?, ?)", [stored, recalled])).toBe(0);
		expect(count(db, "SELECT COUNT(*) FROM memoria_facts WHERE source_memory_id IN (?, ?)", [stored, recalled])).toBe(
			0,
		);
		expect(memory.beam.factRecall(MARKER, 20)).toEqual([]);
		expect(rows(db, "SELECT object FROM facts WHERE source_msg_id = ?", [unrelated]).join()).toContain("Neovim");
		// The temporal annotations of a scrubbed row are not derived from its text and stay.
		expect(count(db, "SELECT COUNT(*) FROM annotations WHERE memory_id = ?", [stored])).toBeGreaterThan(0);
	});

	it("drops a stale vector of a scrubbed row and leaves the other rows' vectors", async () => {
		const memory = makeMemory("scrub-vectors");
		const db = memory.beam.db;
		const forgotten = memory.remember(SECRET, { source: "coding-agent-retain" });
		const { stored, unrelated } = seedTranscripts(memory);
		for (const id of [forgotten, stored, unrelated]) {
			db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[1,0]', 'fixture')", [
				id,
			]);
		}
		const hit = async (): Promise<string> =>
			(await memory.beam.recall("zzz-no-word-in-common", 20, { queryEmbedding: [1, 0] }))
				.map(row => row.content)
				.join("\n");
		expect(await hit()).toContain(MARKER);

		expect(memory.forget(forgotten)).toBe(true);

		expect(rows(db, "SELECT memory_id FROM memory_embeddings")).toEqual([unrelated]);
		expect(await hit()).not.toContain(MARKER);
		expect(await hit()).toContain(UNRELATED);
	});

	it("embeds a scrubbed transcript row again from its scrubbed text", async () => {
		// A fake embedding provider: text that mentions `alpha` points one way, everything else another.
		delete process.env.MNEMOPI_NO_EMBEDDINGS;
		const embedded: string[] = [];
		const provider = async function* (texts: readonly string[]) {
			embedded.push(...texts);
			yield texts.map(text => (text.includes("alpha") ? [1, 0, 0, 0] : [0, 0, 0, 1]));
		};
		const memory = new Mnemopi({ db: new Database(":memory:"), embeddings: { provider } });
		closers.push(() => memory.close());
		const db = memory.beam.db;
		const secret = "The alpha rollback phrase is Quetzalbolt-7731";
		const note = memory.remember(secret, { source: "coding-agent-retain" });
		const transcript = retainTranscript(memory, [
			["user", `Please remember: ${secret}`],
			["assistant", "Done."],
		]);
		await memory.flushExtractions();
		const vectorOf = (id: string): string[] =>
			rows(db, "SELECT embedding_json FROM memory_embeddings WHERE memory_id = ?", [id]);
		expect(vectorOf(transcript)).toEqual(["[1,0,0,0]"]);
		embedded.length = 0;

		expect(memory.forget(note)).toBe(true);

		// The stale vector goes at once; the row is embedded again from its new text in the background.
		expect(vectorOf(transcript)).toEqual([]);
		await memory.flushExtractions();
		expect(embedded).toEqual(["Please remember: [forgotten]\n\nDone."]);
		expect(vectorOf(transcript)).toEqual(["[0,0,0,1]"]);
		expect(vectorOf(note)).toEqual([]);
	});

	it("deletes a retired or caller-written summary of a scrubbed transcript instead of leaving the text recallable", async () => {
		const memory = makeMemory("scrub-retired");
		const db = memory.beam.db;
		const forgotten = memory.remember(SECRET, { source: "coding-agent-retain" });
		const { stored, recalled } = seedTranscripts(memory, 13);
		memory.sleep(false);
		const [summaryId] = rows(db, "SELECT id FROM episodic_memory WHERE summary_of LIKE ?", [`%${stored}%`]);
		// The summary is already retired, and a caller wrote a digest over the same rows.
		expect(memory.beam.invalidate(summaryId ?? "")).toBe(true);
		memory.beam.consolidateToEpisodic(`Digest: ${SECRET}`, [stored, recalled], "digest");
		expect(count(db, "SELECT COUNT(*) FROM episodic_memory WHERE content LIKE ?", [`%${MARKER}%`])).toBe(2);

		expect(memory.forget(forgotten)).toBe(true);

		expect(count(db, "SELECT COUNT(*) FROM episodic_memory WHERE content LIKE ?", [`%${MARKER}%`])).toBe(0);
		expect(everything(db)).not.toContain(MARKER);
	});

	it("scrubs a forgotten transcript row out of a cumulative row that contains it", async () => {
		const memory = makeMemory("scrub-cumulative");
		const db = memory.beam.db;
		const early: Turn[] = [
			["user", `Note the rollback phrase ${MARKER}`],
			["assistant", "Noted the rollback phrase."],
		];
		const later: Turn[] = [
			["user", "Now plan the release."],
			["assistant", "Release planned for Friday."],
		];
		const first = retainTranscript(memory, early);
		const cumulative = retainTranscript(memory, [...early, ...later]);
		const other = retainTranscript(memory, [
			["user", "A separate note about the kanban board."],
			["assistant", "Kanban noted."],
		]);

		expect(memory.forget(first)).toBe(true);

		expect(rows(db, "SELECT COUNT(*) FROM working_memory WHERE id = ?", [first])).toEqual(["0"]);
		const [content] = rows(db, "SELECT content FROM working_memory WHERE id = ?", [cumulative]);
		expect(content).not.toContain(MARKER);
		expect(content).toStartWith("[forgotten]\n\n[role: user]\nNow plan the release.");
		expect(rows(db, "SELECT embed_text FROM working_memory WHERE id = ?", [cumulative])).toEqual([
			"[forgotten]\n\nNow plan the release.\n\nRelease planned for Friday.",
		]);
		expect(rows(db, "SELECT content FROM working_memory WHERE id = ?", [other])[0]).toContain("kanban board");
		expect(everything(db)).not.toContain(MARKER);
	});

	it("scrubbing by text alone cuts transcripts without touching any other memory", async () => {
		const memory = makeMemory("scrub-by-text");
		const db = memory.beam.db;
		const note = memory.remember(SECRET, { source: "coding-agent-retain" });
		const { stored } = seedTranscripts(memory);

		expect(memory.scrubForgottenTexts([SECRET])).toBe(2);

		expect(rows(db, "SELECT content FROM working_memory WHERE id = ?", [note])).toEqual([SECRET]);
		expect(rows(db, "SELECT content FROM working_memory WHERE id = ?", [stored])[0]).not.toContain(MARKER);
		expect(memory.scrubForgottenTexts([SECRET])).toBe(0);
		expect(memory.scrubForgottenTexts(["  "])).toBe(0);
	});
});

describe("the scrub only cuts whole words of a text long enough to be specific", () => {
	const transcriptText = (db: Db, id: string): string =>
		rows(db, "SELECT content || '|' || COALESCE(embed_text, '') FROM working_memory WHERE id = ?", [id])[0] ?? "";

	it("leaves transcripts untouched when the forgotten text is shorter than 8 characters", () => {
		const memory = makeMemory("scrub-short");
		const db = memory.beam.db;
		for (const text of ["ok", "abcdefg", "  abcdefg  "]) {
			const note = memory.remember(text, { source: "coding-agent-retain" });
			const id = retainTranscript(memory, [
				["user", `${text.trim()} let us go, ${text.trim()}`],
				["assistant", `Noted: ${text.trim()}.`],
			]);
			const before = transcriptText(db, id);

			expect(memory.forget(note)).toBe(true);

			expect(transcriptText(db, id)).toBe(before);
			expect(before).toContain(text.trim());
		}
	});

	it("reports a skipped scrub by memory id, never by the text, and scrubs from 8 characters up", () => {
		const memory = makeMemory("scrub-skip-report");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const short = memory.remember("abcdefg", { source: "coding-agent-retain" });
			retainTranscript(memory, [["user", "abcdefg is the word"]]);
			expect(memory.forgetDetailed(short)).toEqual({
				deleted: true,
				scrubbedRows: 0,
				skippedBelowChars: 8,
				forgottenTexts: [],
			});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[1]).toEqual({ memoryId: short, minChars: 8 });

			warn.mockClear();
			const long = memory.remember("abcdefgh", { source: "coding-agent-retain" });
			retainTranscript(memory, [["user", "abcdefgh is the word"]]);
			expect(memory.forgetDetailed(long)).toEqual({
				deleted: true,
				scrubbedRows: 1,
				skippedBelowChars: null,
				forgottenTexts: ["abcdefgh"],
			});
			expect(warn).not.toHaveBeenCalled();
			expect(memory.forgetDetailed(long)).toEqual({
				deleted: false,
				scrubbedRows: 0,
				skippedBelowChars: null,
				forgottenTexts: [],
			});
		} finally {
			warn.mockRestore();
		}
	});

	it("does not rewrite a longer word that contains the forgotten word", () => {
		const memory = makeMemory("scrub-boundary");
		const db = memory.beam.db;
		const note = memory.remember("password", { source: "coding-agent-retain" });
		const mixed = retainTranscript(memory, [
			["user", "The password is hunter42. Rotate the passwords monthly, not passwordless_flow or password2."],
			["assistant", "Not my_password, nor épassword or passwordé: (password), password"],
		]);
		const onlyLonger = retainTranscript(memory, [["user", "Rotate the passwords monthly, passwordless_flow."]]);
		const onlyLongerBefore = transcriptText(db, onlyLonger);

		expect(memory.forget(note)).toBe(true);

		expect(rows(db, "SELECT embed_text FROM working_memory WHERE id = ?", [mixed])).toEqual([
			"The [forgotten] is hunter42. Rotate the passwords monthly, not passwordless_flow or password2.\n\nNot my_password, nor épassword or passwordé: ([forgotten]), [forgotten]",
		]);
		// A row whose only matches sit inside longer words is not rewritten.
		expect(transcriptText(db, onlyLonger)).toBe(onlyLongerBefore);
	});

	it("cuts the text where a non-word character or the edge of the row stands on both sides", () => {
		const memory = makeMemory("scrub-edges");
		const db = memory.beam.db;
		const note = memory.remember("Quetzalbolt-7731", { source: "coding-agent-retain" });
		const id = retainTranscript(memory, [
			["user", "Quetzalbolt-7731"],
			["assistant", '"Quetzalbolt-7731", Quetzalbolt-7731; (Quetzalbolt-7731) Quetzalbolt-77319 xQuetzalbolt-7731'],
		]);

		expect(memory.forget(note)).toBe(true);

		expect(rows(db, "SELECT embed_text FROM working_memory WHERE id = ?", [id])).toEqual([
			'[forgotten]\n\n"[forgotten]", [forgotten]; ([forgotten]) Quetzalbolt-77319 xQuetzalbolt-7731',
		]);
	});
});

describe("invalidate keeps history", () => {
	it("hides the memory and its own summary but leaves the transcripts as they were", async () => {
		const memory = makeMemory("invalidate-transcripts");
		const db = memory.beam.db;
		const note = memory.remember(SECRET, { source: "coding-agent-retain" });
		db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(13), note]);
		seedTranscripts(memory, 13);
		memory.sleep(false);
		const before = rows(db, "SELECT id || content || COALESCE(embed_text, '') FROM working_memory WHERE source = ?", [
			TRANSCRIPT,
		]);
		const summaries = rows(
			db,
			"SELECT id FROM episodic_memory WHERE source = 'sleep_consolidation' AND summary_of NOT LIKE ?",
			[`%${note}%`],
		);

		expect(memory.beam.invalidate(note)).toBe(true);

		expect(
			rows(db, "SELECT id || content || COALESCE(embed_text, '') FROM working_memory WHERE source = ?", [
				TRANSCRIPT,
			]),
		).toEqual(before);
		expect(rows(db, "SELECT id FROM episodic_memory WHERE valid_until IS NULL")).toEqual(summaries);
		// The retained note is hidden; the dated transcripts still tell what was said.
		const shown = await surfaced(memory, MARKER);
		expect(shown).toContain(MARKER);
		expect(shown).not.toContain("coding-agent-retain");
	});
});
