import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import type { MnemopiLlmCompletion } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

/**
 * Forgetting has to reach the bytes on disk, not only the rows a query returns. SQLite keeps what it deleted in
 * the freed space of the main file, in the write-ahead log until a checkpoint copies it over, and (for the
 * full-text index) in segments until they merge. These tests forget a memory in a real file and read the raw
 * bytes of `mnemopi.db`, `-wal` and `-shm` for it, the way `strings` or a forensic copy would.
 */
beforeEach(() => {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

const dirs: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
	while (closers.length > 0) closers.pop()?.();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MARKER = "OLIVE-MNEMO-6150";
const MEMORY = `The delta bot's locker code for the east door is ${MARKER}.`;
// The wording the extractor gave the memory: a recall shows this, and a transcript quotes it.
const FACT = `delta bot east door locker code ${MARKER}`;
const UNRELATED = "Quokka migration is scheduled for 2027-05-09 with 41 gadgets";
// The marker as the full-text tokenizer stores it (case-folded, split at the hyphens), and the marker whole.
const TOKENS = [MARKER.toLowerCase(), "olive", "mnemo", "6150"];
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

const complete: MnemopiLlmCompletion = prompt =>
	JSON.stringify({
		facts: prompt.includes(MARKER) ? [FACT] : [],
		instructions: [],
		preferences: [],
		timelines: [],
		kg: [],
	});

function bankPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-forget-durability-"));
	dirs.push(dir);
	return join(dir, "mnemopi.db");
}

function openBank(file: string, sessionId = "bank"): Mnemopi {
	const memory = new Mnemopi({ sessionId, dbPath: file, noEmbeddings: true, llm: { enabled: true, complete } });
	closers.push(() => memory.close());
	return memory;
}

type Db = Mnemopi["beam"]["db"];
type Turn = readonly [role: "user" | "assistant", text: string];

/** How often each token occurs in each of the database files, only the files and tokens that have a hit. */
function leaks(file: string): Record<string, number> {
	const found: Record<string, number> = {};
	for (const suffix of ["", "-wal", "-shm"]) {
		if (!existsSync(file + suffix)) continue;
		const bytes = readFileSync(file + suffix)
			.toString("latin1")
			.toLowerCase();
		for (const token of TOKENS) {
			const hits = bytes.split(token).length - 1;
			if (hits > 0) found[`${suffix || "main"}:${token}`] = hits;
		}
	}
	return found;
}

function count(db: Db, sql: string): number {
	return Number((db.query(sql).get() as Record<string, number>).n);
}

async function retainTranscript(memory: Mnemopi, turns: readonly Turn[], ageHours = 0): Promise<string> {
	const frame = (list: readonly Turn[]): string =>
		list.map(([role, text]) => `[role: ${role}]\n${text}\n[${role}:end]`).join("\n\n");
	const id = memory.remember(frame(turns), {
		source: "coding-agent-transcript",
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

/** The memory stored by the `retain` tool, the transcripts that quote it and the summary `sleep` makes of them. */
async function seedBank(memory: Mnemopi): Promise<string> {
	const note = memory.remember(MEMORY, { source: "coding-agent-retain", extract: true });
	await memory.flushExtractions();
	memory.beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [hoursAgo(13), note]);
	await retainTranscript(
		memory,
		[
			["user", `Please remember this: ${MEMORY}`],
			["assistant", "Stored it."],
		],
		13,
	);
	await retainTranscript(
		memory,
		[
			["user", "What is the locker code of the delta bot?"],
			["assistant", `From memory: ${FACT}.`],
		],
		13,
	);
	await retainTranscript(
		memory,
		[
			["user", "When does the quokka migration start?"],
			["assistant", `${UNRELATED}.`],
		],
		13,
	);
	memory.sleep(false);
	return note;
}

/** A second connection with a read transaction open, as another process reading the bank has. */
function holdSnapshot(file: string): () => void {
	const reader = new Database(file);
	reader.exec("BEGIN");
	reader.query("SELECT COUNT(*) AS n FROM working_memory").get();
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		reader.exec("COMMIT");
		reader.close();
	};
	closers.push(release);
	return release;
}

const pendingFlags = (db: Db): number => count(db, "SELECT COUNT(*) AS n FROM forget_checkpoint_pending");

describe("every connection zeroes what it deletes", () => {
	it("opens a file connection with secure_delete on, however the platform builds SQLite", () => {
		const db = openDatabase(bankPath());
		closers.push(() => db.close());

		expect(db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
	});

	it("opens the connection of a memory bank with secure_delete on", () => {
		const memory = openBank(bankPath());

		expect(memory.beam.db.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
	});

	it("tells each full-text index to delete securely, so a deleted term does not stay in a segment", () => {
		const db = openBank(bankPath()).beam.db;

		for (const table of ["fts_working", "fts_episodes", "fts_facts"]) {
			expect(db.query(`SELECT v FROM ${table}_config WHERE k = 'secure-delete'`).get()).toEqual({ v: 1 });
		}
	});
});

describe("forget leaves nothing of the text in the database files", () => {
	it("scrubs the main file, the log and the index of a bank that was checkpointed before, with the connection open", async () => {
		const file = bankPath();
		const memory = openBank(file);
		const note = await seedBank(memory);
		// A long-lived bank: everything reached the main file long ago.
		memory.beam.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect(Object.keys(leaks(file))).toContain(`main:${MARKER.toLowerCase()}`);
		expect(Object.keys(leaks(file))).toContain("main:olive");

		expect(memory.forget(note)).toBe(true);

		expect(leaks(file)).toEqual({});
		expect(pendingFlags(memory.beam.db)).toBe(0);
	});

	it("scrubs the log of a bank whose rows have not been checkpointed yet", async () => {
		const file = bankPath();
		const memory = openBank(file);
		const note = await seedBank(memory);
		expect(Object.keys(leaks(file)).some(key => key.startsWith("-wal:"))).toBe(true);

		expect(memory.forget(note)).toBe(true);

		expect(leaks(file)).toEqual({});
	});

	it("scrubs the bytes of a bank that a second session writes to after the forget", async () => {
		const file = bankPath();
		const memory = openBank(file);
		const note = await seedBank(memory);
		memory.beam.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect(memory.forget(note)).toBe(true);

		// The forgetting session ends after the forget: its transcript quotes what it forgot.
		await retainTranscript(memory, [["assistant", `Forgot ${MEMORY} (stored as: ${FACT}).`]]);
		memory.close();

		expect(leaks(file)).toEqual({});
	});

	it("scrubs the other banks of a session the same way (scrubForgottenTexts)", async () => {
		const file = bankPath();
		const other = openBank(file, "other-bank");
		await retainTranscript(other, [
			["user", `Please remember this: ${MEMORY}`],
			["assistant", `From memory: ${FACT}.`],
		]);
		other.beam.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect(Object.keys(leaks(file))).toContain("main:olive");

		expect(other.scrubForgottenTexts([MEMORY, FACT])).toBeGreaterThan(0);

		expect(leaks(file)).toEqual({});
	});
});

describe("a checkpoint that cannot finish is kept pending and retried", () => {
	async function forgetWhileHeld(file: string): Promise<{ memory: Mnemopi; release: () => void; ms: number }> {
		const memory = openBank(file);
		const note = await seedBank(memory);
		const release = holdSnapshot(file);
		const start = performance.now();
		expect(memory.forget(note)).toBe(true);
		return { memory, release, ms: performance.now() - start };
	}

	it("does not make forget wait out the busy timeout for a reader, and records that the checkpoint is owed", async () => {
		const { memory, ms } = await forgetWhileHeld(bankPath());

		expect(ms).toBeLessThan(1_500);
		expect(pendingFlags(memory.beam.db)).toBe(1);
	});

	it("keeps the flag, without an error, while the reader still holds its snapshot", async () => {
		const file = bankPath();
		const { memory } = await forgetWhileHeld(file);
		memory.sleep(false);

		expect(pendingFlags(memory.beam.db)).toBe(1);
		const second = openBank(file, "second");
		expect(pendingFlags(second.beam.db)).toBe(1);
	});

	it("finishes it on the next open once the reader is gone, and the files are clean", async () => {
		const file = bankPath();
		const { memory, release } = await forgetWhileHeld(file);
		expect(pendingFlags(memory.beam.db)).toBe(1);
		release();

		// The forgetting connection stays open and idle: only the open of the next one can finish the checkpoint.
		const next = openBank(file, "next");

		expect(pendingFlags(next.beam.db)).toBe(0);
		expect(leaks(file)).toEqual({});
	});

	it("finishes it at the next sleep", async () => {
		const file = bankPath();
		const { memory, release } = await forgetWhileHeld(file);
		expect(pendingFlags(memory.beam.db)).toBe(1);
		release();

		memory.sleep(false);

		expect(pendingFlags(memory.beam.db)).toBe(0);
		expect(leaks(file)).toEqual({});
	});

	it("finishes it at a clean close", async () => {
		const file = bankPath();
		const { memory, release } = await forgetWhileHeld(file);
		release();

		memory.close();

		const raw = new Database(file, { readonly: true });
		closers.push(() => raw.close());
		expect(pendingFlags(raw)).toBe(0);
		expect(leaks(file)).toEqual({});
	});

	it("holds when the reader is another process, and finishes on the next open after it is killed", async () => {
		const file = bankPath();
		const memory = openBank(file);
		const note = await seedBank(memory);
		const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "forget-reader.ts"), file], {
			env: { ...process.env, MNEMOPI_NO_EMBEDDINGS: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const first = await child.stdout.getReader().read();
			if (first.done || !new TextDecoder().decode(first.value).includes("ready")) {
				throw new Error(`reader did not open its snapshot: ${await new Response(child.stderr).text()}`);
			}

			expect(memory.forget(note)).toBe(true);

			expect(pendingFlags(memory.beam.db)).toBe(1);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}

		const next = openBank(file, "next");

		expect(pendingFlags(next.beam.db)).toBe(0);
		expect(leaks(file)).toEqual({});
	});
});

describe("a full-text index that cannot delete securely is merged after a forget", () => {
	const mergesAfterForget = async (secure: boolean): Promise<string[]> => {
		const memory = openBank(bankPath());
		const note = await seedBank(memory);
		if (!secure) {
			// A build of SQLite whose FTS5 does not know the `secure-delete` option is an index that has it off.
			for (const table of ["fts_working", "fts_episodes", "fts_facts"]) {
				memory.beam.db.run(`INSERT INTO ${table}(${table}, rank) VALUES('secure-delete', 0)`);
			}
		}
		const run = spyOn(memory.beam.db, "run");
		expect(memory.forget(note)).toBe(true);
		return run.mock.calls.map(call => String(call[0])).filter(sql => sql.includes("'optimize'"));
	};

	it("runs the optimize of each index when the index does not delete securely", async () => {
		const merges = await mergesAfterForget(false);

		expect(merges.map(sql => /fts_\w+/.exec(sql)?.[0]).sort()).toEqual(["fts_episodes", "fts_facts", "fts_working"]);
	});

	it("does not merge a secure index, which would rewrite it for nothing", async () => {
		expect(await mergesAfterForget(true)).toEqual([]);
	});
});
