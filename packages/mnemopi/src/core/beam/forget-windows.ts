import type { Database } from "bun:sqlite";
import { sha256Hex16 } from "../../util/ids";

/**
 * Finding a forgotten text again, wherever it was quoted. A retained transcript, a `sleep` summary and a fact
 * extracted from either carry the text in another shape: another case, other punctuation, compacted by AAAK
 * (`and` became `+`, `on` became `@`), cut to a preview, or worded another way by the fact extractor. So the
 * match is on word windows: the text is split into words (letters and digits, lowercased, minus the words
 * AAAK rewrites into symbols), and a run of `WINDOW_TOKENS` words of the text that turns up in another text is
 * a quote of it.
 *
 * A window is kept as a pair of hashes, never as text, so a `forget_tombstones` row can outlive the memory it
 * came from and cut the text out of transcripts retained later without keeping a copy of it:
 * - `roll`, a 32-bit hash of the window's word hashes, seeded by the bank's salt. A transcript is scanned with
 *   this one only: one multiply per word.
 * - `digest`, the first 16 hex characters of SHA-256 over the salt and the window's words. It confirms a `roll` hit.
 */

/** Stands in for scrubbed text, so a reader can see that something was cut. */
export const FORGOTTEN_MARK = "[forgotten]";

/**
 * A forgotten text shorter than this (trimmed) is not cut out of transcripts: so short a text is a common word or
 * number, and cutting it would damage rows that say something else.
 */
export const MIN_SCRUB_CHARS = 8;

/** Words in a window: five is more than the stock of a short sentence shared by chance, and short enough to survive a partial quote. */
export const WINDOW_TOKENS = 5;

/** Windows one forget may keep: a very long memory is covered by its first windows, not by an unbounded table. */
const MAX_WINDOWS_PER_FORGET = 4096;

/** Tombstone rows a bank keeps, newest first. `MNEMOPI_FORGET_TOMBSTONE_LIMIT` overrides it. */
const DEFAULT_TOMBSTONE_LIMIT = 50_000;

/** Most `AND` pairs the candidate query of a scrub carries; past it the scrub reads every transcript row instead. */
const MAX_PREFILTER_PAIRS = 256;

const WORD = /[\p{L}\p{N}]+/gu;
const ROLL_MULTIPLIER = 0x9e3779b1;

/** Words AAAK writes as a symbol when it compacts a summary (`STRUCTURAL_REPLACEMENTS`), so no window holds them. */
const COMPACTED_WORDS: ReadonlySet<string> = new Set([
	"and",
	"or",
	"for",
	"to",
	"with",
	"over",
	"instead",
	"of",
	"because",
	"due",
	"using",
	"built",
	"in",
	"at",
	"on",
	"from",
]);

interface Word {
	readonly norm: string;
	readonly start: number;
	readonly end: number;
	readonly hash: number;
}

/** One window, as stored. */
export interface WindowEntry {
	readonly ntokens: number;
	readonly roll: number;
	readonly digest: string;
}

function words(text: string, seed: number): Word[] {
	const found: Word[] = [];
	for (const match of text.matchAll(WORD)) {
		const norm = match[0].toLowerCase();
		if (COMPACTED_WORDS.has(norm)) continue;
		found.push({ norm, start: match.index, end: match.index + match[0].length, hash: Bun.hash.xxHash32(norm, seed) });
	}
	return found;
}

function windowRoll(found: readonly Word[], from: number, size: number): number {
	let value = 0;
	for (let index = from; index < from + size; index++) {
		value = (Math.imul(value, ROLL_MULTIPLIER) + (found[index]?.hash ?? 0)) | 0;
	}
	return value >>> 0;
}

function windowDigest(salt: string, found: readonly Word[], from: number, size: number): string {
	return sha256Hex16(
		`${salt}\0${found
			.slice(from, from + size)
			.map(word => word.norm)
			.join(" ")}`,
	);
}

/**
 * The words of `text` when it is specific enough to be tracked by windows: long enough (`MIN_SCRUB_CHARS`), at
 * least two words, and at least one of them is not a number. A single word or a bare number or date would
 * match everything that says it.
 */
function specificWords(text: string, seed: number): Word[] | null {
	if (text.trim().length < MIN_SCRUB_CHARS) return null;
	const found = words(text, seed);
	if (found.length < 2 || !found.some(word => /\p{L}/u.test(word.norm))) return null;
	return found;
}

/** The windows of `texts`: every run of `WINDOW_TOKENS` words (the whole text when it has fewer), hashed. */
export function windowEntries(texts: readonly string[], salt: string): WindowEntry[] {
	const seed = Bun.hash.xxHash32(salt);
	const entries = new Map<string, WindowEntry>();
	for (const text of texts) {
		const found = specificWords(text, seed);
		if (found === null) continue;
		const size = Math.min(found.length, WINDOW_TOKENS);
		for (let from = 0; from + size <= found.length; from++) {
			if (entries.size >= MAX_WINDOWS_PER_FORGET) return [...entries.values()];
			const digest = windowDigest(salt, found, from, size);
			if (!entries.has(digest)) entries.set(digest, { ntokens: size, roll: windowRoll(found, from, size), digest });
		}
	}
	return [...entries.values()];
}

/**
 * An FTS5 `MATCH` expression that every row holding a window of `texts` satisfies: for each window, the two
 * longest of its words must both be in the row. `undefined` when `texts` have no windows or too many to name;
 * the caller then reads every candidate row. The unicode61 tokenizer splits words the way `words` does and
 * folds case and accents, so the expression is a superset of the rows the windows match.
 */
export function windowPrefilter(texts: readonly string[]): string | undefined {
	const pairs = new Set<string>();
	for (const text of texts) {
		const found = specificWords(text, 0);
		if (found === null) continue;
		const size = Math.min(found.length, WINDOW_TOKENS);
		for (let from = 0; from + size <= found.length; from++) {
			const norms = [...new Set(found.slice(from, from + size).map(word => word.norm))];
			norms.sort((left, right) => right.length - left.length);
			pairs.add(
				norms
					.slice(0, 2)
					.map(norm => `"${norm}"`)
					.join(" AND "),
			);
			if (pairs.size > MAX_PREFILTER_PAIRS) return undefined;
		}
	}
	return pairs.size === 0 ? undefined : [...pairs].map(pair => `(${pair})`).join(" OR ");
}

/** A set of windows, and the cut that replaces every quote of them in a text. */
export class WindowSet {
	readonly #salt: string;
	readonly #seed: number;
	/** ntokens -> roll -> digests. */
	readonly #sizes = new Map<number, Map<number, Set<string>>>();

	constructor(salt: string, entries: readonly WindowEntry[]) {
		this.#salt = salt;
		this.#seed = Bun.hash.xxHash32(salt);
		for (const entry of entries) {
			let byRoll = this.#sizes.get(entry.ntokens);
			if (byRoll === undefined) {
				byRoll = new Map();
				this.#sizes.set(entry.ntokens, byRoll);
			}
			let digests = byRoll.get(entry.roll);
			if (digests === undefined) {
				digests = new Set();
				byRoll.set(entry.roll, digests);
			}
			digests.add(entry.digest);
		}
	}

	get isEmpty(): boolean {
		return this.#sizes.size === 0;
	}

	/**
	 * `text` with each quote of a window replaced by `[forgotten]`. Consecutive windows chain, so a quote of a whole
	 * text is one mark, from its first word to its last; punctuation after the last word stays.
	 */
	cut(text: string): string {
		if (this.#sizes.size === 0) return text;
		const found = words(text, this.#seed);
		const spans: [start: number, end: number][] = [];
		for (const [size, byRoll] of this.#sizes) {
			for (let from = 0; from + size <= found.length; from++) {
				const digests = byRoll.get(windowRoll(found, from, size));
				if (digests === undefined || !digests.has(windowDigest(this.#salt, found, from, size))) continue;
				spans.push([found[from].start, found[from + size - 1].end]);
			}
		}
		if (spans.length === 0) return text;
		spans.sort((left, right) => left[0] - right[0]);
		let result = "";
		let cursor = 0;
		let [start, end] = spans[0];
		for (const [nextStart, nextEnd] of spans.slice(1)) {
			if (nextStart <= end) {
				end = Math.max(end, nextEnd);
				continue;
			}
			result += text.slice(cursor, start) + FORGOTTEN_MARK;
			cursor = end;
			[start, end] = [nextStart, nextEnd];
		}
		return result + text.slice(cursor, start) + FORGOTTEN_MARK + text.slice(end);
	}
}

function randomSalt(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

/** The bank's salt, or `null` before the first forget. */
function readSalt(db: Database): string | null {
	const row = db.query("SELECT salt FROM forget_tombstone_salt ORDER BY rowid LIMIT 1").get() as {
		salt: string;
	} | null;
	return row?.salt ?? null;
}

/** The bank's salt, drawn on the first forget. Runs in the forget's transaction. */
export function tombstoneSalt(db: Database): string {
	const existing = readSalt(db);
	if (existing !== null) return existing;
	db.run("INSERT INTO forget_tombstone_salt (salt) VALUES (?)", [randomSalt()]);
	return readSalt(db) ?? "";
}

function tombstoneLimit(): number {
	const parsed = Number.parseInt(process.env.MNEMOPI_FORGET_TOMBSTONE_LIMIT ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOMBSTONE_LIMIT;
}

/**
 * Keep `entries` so a transcript retained after the forget is cut the same way (`tombstoneWindows`). The table
 * holds the newest `MNEMOPI_FORGET_TOMBSTONE_LIMIT` windows (50 000 by default); a window forgotten again is kept
 * once.
 */
export function recordTombstones(db: Database, entries: readonly WindowEntry[]): void {
	if (entries.length === 0) return;
	const now = new Date().toISOString();
	using insert = db.prepare(
		"INSERT OR IGNORE INTO forget_tombstones (ntokens, roll, digest, created_at) VALUES (?, ?, ?, ?)",
	);
	for (const entry of entries) insert.run(entry.ntokens, entry.roll, entry.digest, now);
	db.run("DELETE FROM forget_tombstones WHERE id NOT IN (SELECT id FROM forget_tombstones ORDER BY id DESC LIMIT ?)", [
		tombstoneLimit(),
	]);
}

const tombstoneCaches = new WeakMap<Database, { stamp: string; windows: WindowSet | null }>();

/**
 * The windows of everything this bank has forgotten, or `null` when nothing was. Loaded once and kept until the
 * table changes (another process included), so a retain that finds none costs one count.
 */
export function tombstoneWindows(db: Database): WindowSet | null {
	const state = db.query("SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS last FROM forget_tombstones").get() as {
		total: number;
		last: number;
	};
	const stamp = `${state.total}:${state.last}`;
	const cached = tombstoneCaches.get(db);
	if (cached?.stamp === stamp) return cached.windows;
	const salt = readSalt(db);
	const entries =
		salt === null ? [] : (db.query("SELECT ntokens, roll, digest FROM forget_tombstones").all() as WindowEntry[]);
	const windows = salt === null || entries.length === 0 ? null : new WindowSet(salt, entries);
	tombstoneCaches.set(db, { stamp, windows });
	return windows;
}
