import type { Database, SQLQueryBindings } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import { transaction } from "../../db";
import { toUtcIso } from "../../util/datetime";
import { generateId } from "../../util/ids";
import { currentEmbeddingModel, embeddingsDisabled } from "../embeddings";
import { EpisodicGraph } from "../episodic-graph";
import { countExtractedFactCategories, extractFactCategoriesSafe } from "../extraction";
import { getMnemopiRuntimeOptions, withMnemopiRuntimeOptions } from "../runtime-options";
import {
	consolidateEligibleWorkingRows,
	consolidateWorkingRowsById,
	rebuildSleepSummary,
	rewriteSleepSummary,
	storeExtractedFactCategories,
} from "./consolidate";
import { settleForget } from "./forget-durability";
import {
	FORGOTTEN_MARK,
	MIN_SCRUB_CHARS,
	recordTombstones,
	tombstoneSalt,
	tombstoneWindows,
	type WindowEntry,
	WindowSet,
	windowEntries,
	windowPrefilter,
} from "./forget-windows";
import { type EmbedItem, scheduleEmbedding, vecAvailable, vecInsert } from "./helpers";
import type {
	BeamEvent,
	BeamMemoryState,
	BeamStats,
	ForgetOutcome,
	ImportStats,
	Metadata,
	RememberBatchItem,
	RememberBatchOptions,
	RememberOptions,
	TrustTier,
	Veracity,
} from "./types";

type Row = Record<string, unknown>;
type EventPayload = Omit<BeamEvent, "type" | "sessionId" | "timestamp">;

type StoreRememberOptions = RememberOptions & {
	memoryId?: string;
	memory_id?: string;
	validUntil?: string | null;
	valid_until?: string | null;
	authorId?: string | null;
	author_id?: string | null;
	authorType?: string | null;
	author_type?: string | null;
	extractEntities?: boolean;
	extract_entities?: boolean;
	extract_text?: string;
	embed_text?: string;
	channelId?: string | null;
	channel_id?: string | null;
};

type StoreRememberBatchOptions = RememberBatchOptions & {
	forceVeracity?: boolean;
	force_veracity?: boolean;
};

const CANONICAL_VERACITY: Record<string, true> = {
	true: true,
	false: true,
	stated: true,
	inferred: true,
	tool: true,
	imported: true,
	unknown: true,
};
const TRUST_TIERS: Record<string, true> = {
	STATED: true,
	DERIVED: true,
	EXTERNAL_WRITE: true,
	IMPORTED: true,
};
const SCRATCHPAD_MAX_ITEMS = Number.parseInt(process.env.MNEMOPI_SP_MAX ?? "1000", 10);

function metadataJson(metadata: Metadata | null | undefined): string | null {
	return metadata == null ? null : JSON.stringify(metadata);
}

function jsonObject(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isSqlBinding(value: unknown): value is SQLQueryBindings {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "boolean" ||
		value instanceof ArrayBuffer ||
		(ArrayBuffer.isView(value) && !(value instanceof DataView))
	);
}

function sqlBinding(value: unknown, fallback: SQLQueryBindings): SQLQueryBindings {
	return isSqlBinding(value) ? value : fallback;
}

function embeddingText(content: string, options: { embedText?: string; embed_text?: string }): string {
	return options.embedText ?? options.embed_text ?? content;
}

function storedEmbeddingText(content: string, embedText: string): string | null {
	return embedText === content ? null : embedText;
}

function clampVeracity(value: unknown): Veracity {
	if (typeof value !== "string") return "unknown";
	const normalized = value.trim().toLowerCase();
	return CANONICAL_VERACITY[normalized] === true ? normalized : "unknown";
}

function sourceToTrustTier(source: string | null | undefined): TrustTier {
	switch ((source ?? "").toLowerCase()) {
		case "conversation":
		case "user":
		case "assistant":
			return "STATED";
		case "tool":
		case "api":
		case "system":
			return "EXTERNAL_WRITE";
		case "import":
		case "imported":
		case "backup":
			return "IMPORTED";
		default:
			return "STATED";
	}
}

function normalizeTrustTier(value: unknown, source: string): TrustTier {
	if (value === null || value === undefined) return sourceToTrustTier(source);
	if (typeof value === "string" && TRUST_TIERS[value] === true) return value;
	return "STATED";
}

function emitEvent(beam: BeamMemoryState, type: string, data: EventPayload): void {
	const event: BeamEvent = {
		...data,
		type,
		sessionId: beam.sessionId,
		timestamp: toUtcIso(),
	};
	const candidate = beam as BeamMemoryState & {
		emitEvent?: (type: string, data: EventPayload) => void;
	};
	if (typeof candidate.emitEvent === "function") {
		candidate.emitEvent(type, data);
		return;
	}
	beam.eventEmitter?.(event);
	void beam.pluginManager?.emit?.(event);
}

/** Drop cached recall results after a write that can change what recall returns. */
function invalidateCaches(beam: BeamMemoryState): void {
	beam.caches.queryCache?.invalidate();
}

function findDuplicate(beam: BeamMemoryState, content: string): string | null {
	using statement = beam.db.prepare("SELECT id FROM working_memory WHERE content = ? AND session_id = ? LIMIT 1");
	const row = statement.get(content, beam.sessionId) as { id: string } | null;
	return row?.id ?? null;
}

function tableExists(db: BeamMemoryState["db"], table: string): boolean {
	using statement = db.prepare(
		"SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ? LIMIT 1",
	);
	return statement.get(table) !== null;
}

/** Tables whose rows point back to a `working_memory` id via `source_memory_id`. */
const MEMORIA_SOURCE_TABLES = [
	"memoria_facts",
	"memoria_instructions",
	"memoria_kg",
	"memoria_preferences",
	"memoria_timelines",
] as const;

/**
 * Remove every artifact linked to the given `working_memory` (or `episodic_memory`) ids so no
 * deletion path leaves orphans behind. Covers annotations, embeddings, extracted facts
 * (`facts.source_msg_id`), memoria projections (`*.source_memory_id`), episodic
 * gists, and the graph edges tied to those memory / gist / fact node ids.
 *
 * Idempotent and schema-tolerant: `gists` / `graph_edges` only exist once an
 * `EpisodicGraph` has initialised, so they are guarded. Callers own the
 * transaction and the base `working_memory` delete. `keepAnnotations` leaves the annotations of rows that
 * stay: they record dates and sources, not text.
 */
function purgeWorkingMemoryArtifacts(
	db: BeamMemoryState["db"],
	ids: readonly string[],
	options: { keepAnnotations?: boolean } = {},
): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(", ");

	const graphRefs = new Set<string>(ids);
	for (const id of ids) graphRefs.add(`gist_${id}`);
	if (tableExists(db, "facts")) {
		using factStatement = db.prepare(`SELECT fact_id FROM facts WHERE source_msg_id IN (${placeholders})`);
		const factRows = factStatement.all(...ids) as {
			fact_id: string;
		}[];
		for (const row of factRows) graphRefs.add(row.fact_id);
		db.run(`DELETE FROM facts WHERE source_msg_id IN (${placeholders})`, [...ids]);
	}

	if (options.keepAnnotations !== true)
		db.run(`DELETE FROM annotations WHERE memory_id IN (${placeholders})`, [...ids]);
	db.run(`DELETE FROM memory_embeddings WHERE memory_id IN (${placeholders})`, [...ids]);
	for (const table of MEMORIA_SOURCE_TABLES) {
		db.run(`DELETE FROM ${table} WHERE source_memory_id IN (${placeholders})`, [...ids]);
	}

	if (tableExists(db, "gists")) {
		db.run(`DELETE FROM gists WHERE memory_id IN (${placeholders})`, [...ids]);
	}
	if (tableExists(db, "graph_edges")) {
		const refs = [...graphRefs];
		const refPlaceholders = refs.map(() => "?").join(", ");
		db.run(`DELETE FROM graph_edges WHERE source IN (${refPlaceholders}) OR target IN (${refPlaceholders})`, [
			...refs,
			...refs,
		]);
	}
}

type SummaryRetirement = { kind: "invalidate"; at: string; replacementId: string | null } | { kind: "forget" };

/**
 * A working row that `memory_edit invalidate` or `forget` retires must leave the episodic summaries
 * `sleep` built from it, otherwise the retirement is undone as soon as the working row drops out of
 * recall: the summary, and the facts extracted from its text, keep surfacing the same words. Each
 * summary whose `summary_of` lists the row gets the narrowest cut that hides the row's text:
 * - It covered only that row: invalidate expires it the same way, forget deletes it.
 * - It also covers other rows: it is rewritten from their live text (`rebuildSleepSummary`) and the old
 *   one is retired or deleted, so the other rows keep a summary and the facts extracted from it. One
 *   summary mixes many rows, so retiring it whole would hide unrelated memories.
 * - It cannot be rewritten (a caller-supplied digest, or another row exists only inside it): it is
 *   retired or deleted whole. Text in a row we cannot cut must not stay recallable.
 * Facts extracted from a retired summary stop surfacing through the source check in `recall`.
 * A summary that is already retired needs nothing on invalidate; forget deletes it anyway, because the
 * forgotten text has to go.
 */
function retireDerivedSummaries(beam: BeamMemoryState, sourceId: string, retirement: SummaryRetirement): void {
	using statement = beam.db.prepare(
		`SELECT id, rowid, source, summary_of, metadata_json, timestamp, created_at, valid_until, superseded_by
		 FROM episodic_memory WHERE instr(',' || summary_of || ',', ?) > 0`,
	);
	const now = toUtcIso();
	for (const summary of statement.all(`,${sourceId},`) as Row[]) {
		const id = String(summary.id);
		const retired = isRetiredSummary(summary, now);
		if (retired && retirement.kind === "invalidate") continue;
		let supersededBy = retirement.kind === "invalidate" ? retirement.replacementId : null;
		if (!retired) {
			const others = String(summary.summary_of)
				.split(",")
				.filter(part => part.length > 0 && part !== sourceId);
			const rewritten = others.length > 0 ? rebuildSleepSummary(beam, summary, others) : null;
			if (rewritten !== null) supersededBy = rewritten[0] ?? supersededBy;
		}
		if (retirement.kind === "invalidate") {
			beam.db.run("UPDATE episodic_memory SET valid_until = ?, superseded_by = ? WHERE id = ?", [
				retirement.at,
				supersededBy,
				id,
			]);
			continue;
		}
		deleteEpisodicSummary(beam, summary);
	}
}

/** A summary that is superseded or past its `valid_until`: recall no longer shows it. */
function isRetiredSummary(summary: Row, now: string): boolean {
	const validUntil = summary.valid_until;
	return summary.superseded_by != null || (typeof validUntil === "string" && validUntil <= now);
}

/** Delete an episodic summary for good: its vector, facts, graph links and full-text row go with it. */
function deleteEpisodicSummary(beam: BeamMemoryState, summary: Row): void {
	if (vecAvailable(beam.db)) {
		try {
			beam.db.run("DELETE FROM vec_episodes WHERE rowid = ?", [Number(summary.rowid)]);
		} catch {
			// sqlite-vec cleanup is best-effort, as in import: the row delete takes precedence.
		}
	}
	const id = String(summary.id);
	beam.db.run("DELETE FROM episodic_memory WHERE id = ?", [id]);
	purgeWorkingMemoryArtifacts(beam.db, [id]);
}

/** The `source` the coding-agent retains session transcripts under. */
const TRANSCRIPT_SOURCE = "coding-agent-transcript";
/** Rows per purge: it binds each id and its fact ids twice, so one bank-wide scrub must not bind them all at once. */
const SCRUB_BATCH_SIZE = 200;
/** Rows read per step of a scrub, so a bank-wide rewrite holds a bounded amount of text at a time. */
const SCRUB_READ_BATCH = 100;
/** A character that continues a word, in any script. */
const WORD_CHAR = "[\\p{L}\\p{N}_]";
/** The columns a scrub reads of a `sleep` summary to rewrite it. */
const SUMMARY_COLUMNS =
	"id, rowid, content, source, summary_of, metadata_json, timestamp, created_at, valid_until, superseded_by, scope, veracity";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How a scrub recognizes the forgotten texts. A text of at least `MIN_SCRUB_CHARS` characters is cut where it stands
 * whole in a text: literal, case-sensitive, with a non-word character or the edge on both sides. It is also cut
 * where a quote of it stands, by word windows (`forget-windows.ts`): another case or punctuation, AAAK compaction,
 * a partial quote. A text of one word, or only numbers, has no windows and is cut whole only.
 */
interface ScrubPlan {
	/** The texts, trimmed, longest first. */
	readonly texts: readonly string[];
	/** Their windows, to keep as tombstones. */
	readonly entries: readonly WindowEntry[];
	/** `value` with every copy and quote replaced by `[forgotten]`. */
	cut(value: string): string;
}

/** `null` when no text is long enough to cut. Writes the bank's salt on the first call: run it in the caller's transaction. */
function planScrub(beam: BeamMemoryState, texts: readonly string[]): ScrubPlan | null {
	// Longest first, so a text that contains another is cut whole before its part is.
	const spans = [...new Set(texts.map(text => text.trim()).filter(text => text.length >= MIN_SCRUB_CHARS))].sort(
		(a, b) => b.length - a.length,
	);
	if (spans.length === 0) return null;
	const salt = tombstoneSalt(beam.db);
	const entries = windowEntries(spans, salt);
	const windows = new WindowSet(salt, entries);
	const patterns = spans.map(span => new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(span)}(?!${WORD_CHAR})`, "gu"));
	return {
		texts: spans,
		entries,
		cut: value =>
			windows.cut(patterns.reduce((cutValue, pattern) => cutValue.replace(pattern, () => FORGOTTEN_MARK), value)),
	};
}

/** Ids of the transcript rows that may hold a copy: `instr` finds a whole text, the full-text index finds a window. */
function transcriptCandidates(beam: BeamMemoryState, plan: ScrubPlan): string[] {
	const holdsText = plan.texts.map(() => "instr(content, ?) > 0 OR instr(embed_text, ?) > 0").join(" OR ");
	using find = beam.db.prepare(`SELECT id FROM working_memory WHERE source = ? AND (${holdsText})`);
	const ids = new Set(
		(find.all(TRANSCRIPT_SOURCE, ...plan.texts.flatMap(text => [text, text])) as { id: string }[]).map(row => row.id),
	);
	if (plan.entries.length > 0) {
		const match = windowPrefilter(plan.texts);
		using findWindows = beam.db.prepare(
			match === undefined
				? "SELECT id FROM working_memory WHERE source = ?"
				: "SELECT id FROM working_memory WHERE source = ? AND id IN (SELECT id FROM fts_working WHERE fts_working MATCH ?)",
		);
		for (const row of findWindows.all(
			...(match === undefined ? [TRANSCRIPT_SOURCE] : [TRANSCRIPT_SOURCE, match]),
		) as {
			id: string;
		}[]) {
			ids.add(row.id);
		}
	}
	return [...ids];
}

/**
 * Replace each copy and quote of the forgotten texts with `[forgotten]` in the transcript rows, in `content` and in
 * the `embed_text` projection, and return the ids of the rows that changed. The candidate rows come from SQL
 * (`transcriptCandidates`), the rewrite runs on them in bounded batches. The `fts_working` row follows through the
 * `wm_au` trigger.
 */
function scrubTranscriptRows(beam: BeamMemoryState, plan: ScrubPlan): string[] {
	const candidates = transcriptCandidates(beam, plan);
	using update = beam.db.prepare("UPDATE working_memory SET content = ?, embed_text = ? WHERE id = ?");
	const scrubbed: string[] = [];
	for (let start = 0; start < candidates.length; start += SCRUB_READ_BATCH) {
		const batch = candidates.slice(start, start + SCRUB_READ_BATCH);
		using read = beam.db.prepare(
			`SELECT id, content, embed_text FROM working_memory WHERE id IN (${batch.map(() => "?").join(", ")})`,
		);
		for (const row of read.all(...batch) as { id: string; content: string; embed_text: string | null }[]) {
			const content = plan.cut(row.content);
			const embedText = row.embed_text === null ? null : plan.cut(row.embed_text);
			if (content === row.content && embedText === row.embed_text) continue;
			update.run(content, embedText, row.id);
			scrubbed.push(row.id);
		}
	}
	return scrubbed;
}

/**
 * Cut the forgotten texts out of the `sleep` summary `summary` (read with `SUMMARY_COLUMNS`) in place: the
 * replacement says what the old one did with each copy as `[forgotten]` (`rewriteSleepSummary`), and the old one
 * goes with its facts. This is the cut for a summary that its rows can no longer rebuild, because pruning deleted
 * them. Returns false, changing nothing, when the summary holds no copy or is not a `sleep` summary.
 */
function cutSummary(beam: BeamMemoryState, summary: Row, plan: ScrubPlan): boolean {
	const content = String(summary.content);
	const cut = plan.cut(content);
	if (cut === content || rewriteSleepSummary(beam, summary, cut) === null) return false;
	deleteEpisodicSummary(beam, summary);
	return true;
}

/**
 * Rewrite every summary that lists a scrubbed row from the rows' scrubbed text, and delete the old one with its
 * facts, as `retireDerivedSummaries` does for a forgotten row. One scan serves the whole set, so a summary that
 * lists many scrubbed rows is rewritten once. A summary that its rows cannot rebuild (some are pruned) is cut in
 * place; it goes whole only when no copy is found in it, and a caller-written digest goes whole. `droppedId` is a
 * forgotten row that is already gone: it is left out of the rewrite.
 */
function rebuildScrubbedSummaries(
	beam: BeamMemoryState,
	scrubbed: ReadonlySet<string>,
	droppedId: string | null,
	plan: ScrubPlan,
): void {
	using statement = beam.db.prepare(
		`SELECT id, rowid, source, summary_of, metadata_json, timestamp, created_at, valid_until, superseded_by
		 FROM episodic_memory WHERE summary_of != ''`,
	);
	using full = beam.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM episodic_memory WHERE id = ?`);
	const now = toUtcIso();
	for (const summary of statement.all() as Row[]) {
		const kept = String(summary.summary_of)
			.split(",")
			.filter(part => part.length > 0 && part !== droppedId);
		if (!kept.some(part => scrubbed.has(part))) continue;
		if (!isRetiredSummary(summary, now) && rebuildSleepSummary(beam, summary, kept) === null) {
			const current = full.get(String(summary.id)) as Row | null;
			if (current !== null && cutSummary(beam, current, plan)) continue;
		}
		deleteEpisodicSummary(beam, summary);
	}
}

/**
 * Cut the forgotten texts out of the summaries `sleep` made from transcripts that still hold them. A summary is
 * not found through its rows when pruning (`mnemopi.pruneConsolidatedDays`) deleted the transcript rows it lists,
 * so the summary is read for the copies itself: AAAK wrote them compacted, and the windows match that. A retired
 * summary that holds one is deleted, because the forgotten text has to go.
 */
function scrubSummaries(beam: BeamMemoryState, plan: ScrubPlan): void {
	const holds = plan.texts.map(() => "instr(content, ?) > 0");
	const params: string[] = [...plan.texts];
	if (plan.entries.length > 0) {
		const match = windowPrefilter(plan.texts);
		holds.push(match === undefined ? "1" : "rowid IN (SELECT rowid FROM fts_episodes WHERE fts_episodes MATCH ?)");
		if (match !== undefined) params.push(match);
	}
	using statement = beam.db.prepare(
		`SELECT ${SUMMARY_COLUMNS} FROM episodic_memory
		 WHERE source = 'sleep_consolidation'
		   AND CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.source') END = ?
		   AND (${holds.join(" OR ")})`,
	);
	const now = toUtcIso();
	for (const summary of statement.all(TRANSCRIPT_SOURCE, ...params) as Row[]) {
		if (!isRetiredSummary(summary, now)) cutSummary(beam, summary, plan);
		else if (plan.cut(String(summary.content)) !== String(summary.content)) deleteEpisodicSummary(beam, summary);
	}
}

/** The tables a fact is extracted into, the column that names the row it came from, and the columns that hold its text. */
const DERIVED_TEXT_TABLES = [
	{ table: "facts", source: "source_msg_id", columns: ["subject", "predicate", "object"] },
	{ table: "memoria_facts", source: "source_memory_id", columns: ["key", "value", "context_snippet"] },
	{ table: "memoria_instructions", source: "source_memory_id", columns: ["instruction", "topic", "context_snippet"] },
	{ table: "memoria_kg", source: "source_memory_id", columns: ["subject", "predicate", "object"] },
	{ table: "memoria_preferences", source: "source_memory_id", columns: ["preference", "topic", "context_snippet"] },
	{ table: "memoria_timelines", source: "source_memory_id", columns: ["description"] },
] as const;

/**
 * Delete the extracted facts that hold a copy of the forgotten texts and whose source row is gone. Pruning deletes
 * the transcript rows but keeps the facts extracted from them, so nothing links those facts to the forgotten row
 * any more: the text itself is the only link. A fact whose source row exists is left to that row's own scrub.
 */
function purgeOrphanDerivedRows(beam: BeamMemoryState, plan: ScrubPlan): void {
	for (const { table, source, columns } of DERIVED_TEXT_TABLES) {
		if (!tableExists(beam.db, table)) continue;
		const text = columns.map(column => `COALESCE(${column}, '')`).join(" || ' ' || ");
		using orphans = beam.db.prepare(
			`SELECT rowid AS row_id, ${text} AS text${table === "facts" ? ", fact_id" : ""} FROM ${table}
			 WHERE ${source} IS NOT NULL AND ${source} != ''
			   AND NOT EXISTS (SELECT 1 FROM working_memory WHERE working_memory.id = ${table}.${source})
			   AND NOT EXISTS (SELECT 1 FROM episodic_memory WHERE episodic_memory.id = ${table}.${source})`,
		);
		const doomed: { row_id: number; fact_id?: string }[] = [];
		for (const row of orphans.iterate() as Iterable<{ row_id: number; text: string; fact_id?: string }>) {
			if (plan.cut(row.text) !== row.text) doomed.push(row);
		}
		for (let start = 0; start < doomed.length; start += SCRUB_BATCH_SIZE) {
			const batch = doomed.slice(start, start + SCRUB_BATCH_SIZE);
			const marks = batch.map(() => "?").join(", ");
			beam.db.run(
				`DELETE FROM ${table} WHERE rowid IN (${marks})`,
				batch.map(row => row.row_id),
			);
			const factIds = batch.flatMap(row => (row.fact_id === undefined ? [] : [row.fact_id]));
			if (factIds.length > 0 && tableExists(beam.db, "graph_edges")) {
				const refMarks = factIds.map(() => "?").join(", ");
				beam.db.run(`DELETE FROM graph_edges WHERE source IN (${refMarks}) OR target IN (${refMarks})`, [
					...factIds,
					...factIds,
				]);
			}
		}
	}
}

/**
 * Cut forgotten text out of the retained session transcripts. The coding-agent retains whole transcripts that
 * quote a memory: the session that stored it, and any later session whose recall showed it. Forgetting the
 * memory alone leaves its text recallable through them, so `texts` (what the memory said, and the facts the
 * extractor made of it) is removed there too, and everything built from the old text of a scrubbed row goes with it:
 * - Transcript rows keep everything but the copies and quotes of the texts, which become `[forgotten]`.
 * - Their facts, memoria rows, graph links and vector are dropped, because they were extracted from the old text.
 *   Annotations stay. The vector is rebuilt after the commit (`reembedWorkingRows`).
 * - The summaries `sleep` made from them are rewritten from the scrubbed text and the old ones deleted, which
 *   also replaces the facts extracted from them. A summary whose rows were pruned is cut in place, and the facts
 *   whose rows were pruned are deleted when they quote the text.
 * - The windows of the texts are kept as tombstones, so a transcript retained after the forget is cut the same
 *   way (`remember`).
 * Runs in the caller's transaction and returns the ids of the transcript rows it rewrote.
 */
function scrubTranscripts(beam: BeamMemoryState, texts: readonly string[], droppedId: string | null): string[] {
	const plan = planScrub(beam, texts);
	if (plan === null) return [];
	const ids = scrubTranscriptRows(beam, plan);
	for (let start = 0; start < ids.length; start += SCRUB_BATCH_SIZE) {
		purgeWorkingMemoryArtifacts(beam.db, ids.slice(start, start + SCRUB_BATCH_SIZE), { keepAnnotations: true });
	}
	if (ids.length > 0) rebuildScrubbedSummaries(beam, new Set(ids), droppedId, plan);
	scrubSummaries(beam, plan);
	purgeOrphanDerivedRows(beam, plan);
	recordTombstones(beam.db, plan.entries);
	return ids;
}

/** Embed scrubbed rows again, as `remember` embeds a new row, so vector recall sees their new text. */
function reembedWorkingRows(beam: BeamMemoryState, ids: readonly string[]): void {
	if (ids.length === 0 || embeddingsDisabled()) return;
	for (let start = 0; start < ids.length; start += EMBED_REBUILD_BATCH) {
		const batch = ids.slice(start, start + EMBED_REBUILD_BATCH);
		using statement = beam.db.prepare(
			`SELECT id AS memoryId, COALESCE(embed_text, content) AS content FROM working_memory
			 WHERE id IN (${batch.map(() => "?").join(", ")})`,
		);
		scheduleEmbedding(beam, statement.all(...batch) as EmbedItem[]);
	}
}

/**
 * Cut `texts` out of this bank's transcript rows, summaries and facts without deleting any memory, and keep their
 * windows as tombstones. A session that forgets a memory in one bank calls it on the other banks it recalls from,
 * whose transcripts may quote the same text. Returns the number of transcript rows rewritten (0 for texts shorter
 * than `MIN_SCRUB_CHARS`).
 */
export function scrubForgottenTexts(beam: BeamMemoryState, texts: readonly string[]): number {
	const scrubbed = transaction(beam.db, () => scrubTranscripts(beam, texts, null));
	invalidateCaches(beam);
	reembedWorkingRows(beam, scrubbed);
	if (scrubbed.length > 0) settleForget(beam.db);
	return scrubbed.length;
}

/** True when `text` has content but too little of it to scrub from transcripts without hitting unrelated words. */
function tooShortToScrub(text: string): boolean {
	const length = text.trim().length;
	return length > 0 && length < MIN_SCRUB_CHARS;
}

/**
 * Count overflow promotes down to this fraction of `workingMemoryLimit`, not to the limit itself, so
 * a steady writer consolidates in chunks of about a tenth of the limit instead of one row per write.
 */
const WORKING_MEMORY_LOW_WATER_RATIO = 0.9;

/** Scratch rows the trim may act on. Rows flagged `IMPORTED` are durable (issue #4819). */
const TRIMMABLE_WORKING_ROWS = "session_id = ? AND consolidated_at IS NULL AND trust_tier IS NOT 'IMPORTED'";

function countTrimmableWorkingRows(beam: BeamMemoryState, cutoff: string): { live: number; expired: number } {
	using statement = beam.db.prepare(
		`SELECT COUNT(*) AS live, COALESCE(SUM(timestamp < ?), 0) AS expired FROM working_memory WHERE ${TRIMMABLE_WORKING_ROWS}`,
	);
	return statement.get(cutoff, beam.sessionId) as { live: number; expired: number };
}

/** Oldest-first ids of every trimmable row except the newest `keep`. */
function trimmableIdsBeyondNewest(beam: BeamMemoryState, keep: number): string[] {
	using statement = beam.db.prepare(`
		SELECT id FROM working_memory
		WHERE ${TRIMMABLE_WORKING_ROWS}
		  AND id NOT IN (
			SELECT id FROM working_memory WHERE ${TRIMMABLE_WORKING_ROWS} ORDER BY timestamp DESC LIMIT ?
		  )
		ORDER BY timestamp ASC
	`);
	return (statement.all(beam.sessionId, beam.sessionId, keep) as { id: string }[]).map(row => row.id);
}

/**
 * TTL / overflow guard for transient working memory. It never deletes an unconsolidated row: it
 * promotes rows to episodic memory with the consolidation pipeline `sleep` runs, so a session that
 * stays open past the TTL keeps its memories even though session-start consolidation only runs once
 * (#10770). Promotion is batched, so a steady writer does not leave one tiny summary per write:
 * - TTL: when a row is older than `workingMemoryTtlHours`, promote every row `sleep` would take now
 *   (older than half the TTL, same selection as `sleep`), about one grouped pass per half TTL.
 * - Count: when more than `workingMemoryLimit` rows are live, promote the oldest down to a low-water
 *   mark below the limit, so overflow arrives in chunks.
 * `consolidated_at IS NULL` alone does not mark scratch: restored or imported durable rows carry a
 * NULL marker with an old event timestamp (issue #4819), so the trigger and the count path skip
 * `IMPORTED` rows; the TTL batch matches `sleep`, which has no trust-tier filter.
 * A failed promotion is rolled back and logged; every row stays unconsolidated for the next write.
 */
function trimWorkingMemory(beam: BeamMemoryState): void {
	const limit = beam.config.workingMemoryLimit;
	if (!Number.isFinite(limit) || limit <= 0) return;
	const ttlHours = beam.config.workingMemoryTtlHours;
	const cutoff = toUtcIso(new Date(Date.now() - ttlHours * 3_600_000));
	transaction(beam.db, () => {
		const { live, expired } = countTrimmableWorkingRows(beam, cutoff);
		if (expired === 0 && live <= limit) return;
		// A savepoint, so a failure cannot leave rows claimed but unconsolidated, even when this runs
		// inside `rememberBatch`'s transaction.
		beam.db.run("SAVEPOINT promote_working_memory");
		try {
			if (expired > 0) consolidateEligibleWorkingRows(beam);
			// The TTL batch may already have cleared the overflow, so count again after it ran.
			if ((expired > 0 ? countTrimmableWorkingRows(beam, cutoff).live : live) > limit) {
				const lowWater = Math.max(1, Math.min(limit - 1, Math.floor(limit * WORKING_MEMORY_LOW_WATER_RATIO)));
				consolidateWorkingRowsById(beam, trimmableIdsBeyondNewest(beam, lowWater));
			}
			beam.db.run("RELEASE promote_working_memory");
		} catch (error) {
			beam.db.run("ROLLBACK TO promote_working_memory");
			beam.db.run("RELEASE promote_working_memory");
			logger.warn("mnemopi: working-memory promotion failed; rows stay unconsolidated", {
				sessionId: beam.sessionId,
				error: String(error),
			});
		}
	});
}

function addTemporalAnnotations(beam: BeamMemoryState, memoryId: string, timestamp: string, source: string): void {
	try {
		beam.annotations?.add?.(memoryId, "occurred_on", timestamp.slice(0, 10));
		if (source && source !== "conversation" && source !== "user" && source !== "assistant") {
			beam.annotations?.add?.(memoryId, "has_source", source);
		}
	} catch {
		// Annotation enrichment is best-effort, matching Python's non-blocking path.
	}
}

function proactiveLinkingAllowed(beam: BeamMemoryState): boolean {
	const override = process.env.MNEMOPI_PROACTIVE_LINKING;
	return override === undefined ? beam.config.proactiveLinking === true : override === "1";
}

function proactiveLinkIfEnabled(
	beam: BeamMemoryState,
	memoryId: string,
	content: string,
	extractEntities: boolean,
): void {
	if (!proactiveLinkingAllowed(beam)) return;
	try {
		const graph =
			beam.episodicGraph instanceof EpisodicGraph
				? beam.episodicGraph
				: new EpisodicGraph({ db: beam.db, dbPath: beam.dbPath });
		graph.ingestMemory(content, memoryId, {
			sessionId: beam.sessionId,
			linkExisting: true,
			extractEntities,
			linkWindow: beam.config.graphLinkWindow,
		});
	} catch {
		// Proactive graph enrichment must never block durable memory storage.
	}
}

/**
 * Run the LLM fact extractor over freshly stored content and persist the
 * resulting facts. Best-effort: failures (no LLM, closed DB, malformed output)
 * are swallowed so they can never disrupt the synchronous `remember` that
 * scheduled them.
 */
async function runFactExtraction(beam: BeamMemoryState, memoryId: string, content: string): Promise<void> {
	try {
		const extracted = await extractFactCategoriesSafe(content);
		if (countExtractedFactCategories(extracted) === 0) return;
		storeExtractedFactCategories(beam, extracted, 0, memoryId);
		invalidateCaches(beam);
	} catch {
		// Background fact extraction is best-effort and never surfaces to the caller.
	}
}

/**
 * Schedule background fact extraction for a stored memory. `remember` is
 * synchronous, so the async extractor is fired-and-forgotten; the promise is
 * tracked on `beam.pendingExtractions` so callers can drain it via
 * `flushExtractions()` (tests, graceful shutdown). The active runtime options
 * (host LLM `complete`, model, prompt overrides) are captured here and
 * re-entered inside the task because the AsyncLocalStorage scope set by
 * `Mnemopi.#withRuntimeOptions` has already exited by the time the task runs.
 */
function scheduleFactExtraction(beam: BeamMemoryState, memoryId: string, content: string): void {
	if (content.trim() === "") return;
	const runtimeOptions = getMnemopiRuntimeOptions();
	const task = withMnemopiRuntimeOptions(runtimeOptions, () => runFactExtraction(beam, memoryId, content));
	const pending = beam.pendingExtractions;
	if (pending !== undefined) {
		pending.add(task);
		void task.finally(() => pending.delete(task));
	}
}

function rowToDict(row: Row): Row {
	return { ...row };
}

/** Re-embedding batch size for a model-change rebuild — bounds each background
 *  embedding request instead of embedding the whole corpus in one call. */
const EMBED_REBUILD_BATCH = 128;

/**
 * Reconcile stored embeddings against the active embedding model at store open.
 *
 * Every `memory_embeddings` row is stamped with the model that produced it (see
 * `runEmbedding` in `helpers.ts`). When the configured embedding model changes,
 * its vector dimension changes too, so the previously-stored vectors are no
 * longer comparable. On a mismatch we wipe every stored vector — the
 * `memory_embeddings` table, the `episodic_memory.binary_vector` column, and the
 * sqlite-vec `vec_episodes` index — then enqueue all live memories for
 * background re-embedding under the new model via `scheduleEmbedding`.
 *
 * Runs once per store open; a fresh store (no embeddings) or an already-current
 * store is a no-op. The destructive wipe is skipped whenever it could not be
 * rebuilt — embeddings disabled via the runtime option OR the
 * `MNEMOPI_NO_EMBEDDINGS` env, or an unresolved (empty) active model — so a
 * stale-but-valid corpus is never destroyed without a replacement. MUST run
 * inside the active runtime-options scope so `currentEmbeddingModel()` /
 * `embeddingsDisabled()` reflect the per-instance configuration.
 */
export function reconcileEmbeddingModel(beam: BeamMemoryState): void {
	if (embeddingsDisabled()) return;
	const active = currentEmbeddingModel().trim();
	if (active === "") return;

	// Re-embed in bounded batches so a corpus-wide rebuild never issues one giant
	// embedding request; each batch is its own tracked background task.
	const rebuild = (items: readonly EmbedItem[]): void => {
		for (let offset = 0; offset < items.length; offset += EMBED_REBUILD_BATCH) {
			scheduleEmbedding(beam, items.slice(offset, offset + EMBED_REBUILD_BATCH));
		}
	};

	// Stop at the first row whose stamped model differs from the active one
	// (NULL/unstamped counts as a mismatch via `IS NOT`).
	const mismatch = beam.db.query("SELECT 1 FROM memory_embeddings WHERE model IS NOT ? LIMIT 1").get(active);
	if (mismatch) {
		const staleModels = beam.db
			.query("SELECT DISTINCT model FROM memory_embeddings WHERE model IS NOT ?")
			.all(active) as { model: string | null }[];
		const live = beam.db
			.query(`
				SELECT id AS memoryId, COALESCE(embed_text, content) AS content FROM working_memory WHERE superseded_by IS NULL
				UNION ALL
				SELECT id AS memoryId, content FROM episodic_memory WHERE superseded_by IS NULL
			`)
			.all() as EmbedItem[];

		transaction(beam.db, () => {
			beam.db.run("DELETE FROM memory_embeddings");
			beam.db.run("UPDATE episodic_memory SET binary_vector = NULL");
			if (vecAvailable(beam.db)) {
				try {
					beam.db.run("DELETE FROM vec_episodes");
				} catch {
					// sqlite-vec cleanup is best-effort; rebuild correctness takes precedence.
				}
			}
		});

		logger.info("mnemopi: embedding model changed, rebuilding", {
			from: staleModels.map(row => row.model ?? "(unstamped)"),
			to: active,
			count: live.length,
		});
		rebuild(live);
		return;
	}

	// No stale embeddings, but a previously-interrupted rebuild (a failed embed or a process
	// exit after the wipe) can leave live memories with no active-model embedding. Treating an
	// empty/partial table as "reconciled" would strand them FTS-only, so re-enqueue any live
	// row still missing an active-model embedding.
	const missing = beam.db
		.query(`
			SELECT id AS memoryId, COALESCE(embed_text, content) AS content FROM working_memory
			WHERE superseded_by IS NULL AND id NOT IN (SELECT memory_id FROM memory_embeddings WHERE model = ?)
			UNION ALL
			SELECT id AS memoryId, content FROM episodic_memory
			WHERE superseded_by IS NULL AND id NOT IN (SELECT memory_id FROM memory_embeddings WHERE model = ?)
		`)
		.all(active, active) as EmbedItem[];
	if (missing.length === 0) return;
	logger.info("mnemopi: resuming interrupted embedding rebuild", { to: active, count: missing.length });
	rebuild(missing);
}

/**
 * Store a memory. A transcript retained after a forget (`source = 'coding-agent-transcript'`) is first cut by the
 * bank's tombstones: the forgotten texts are replaced by `[forgotten]` in what is stored, embedded and mined for
 * facts, so the session that forgot a memory, and every session still open that had recalled it, cannot retain it
 * again.
 */
export function remember(beam: BeamMemoryState, content: string, options: StoreRememberOptions = {}): string {
	const windows = (options.source ?? "conversation") === TRANSCRIPT_SOURCE ? tombstoneWindows(beam.db) : null;
	if (windows === null) return storeRemembered(beam, content, options);
	const cut = (text: string | undefined): string | undefined => (text === undefined ? undefined : windows.cut(text));
	return storeRemembered(beam, windows.cut(content), {
		...options,
		embedText: cut(options.embedText),
		embed_text: cut(options.embed_text),
		extractText: cut(options.extractText),
		extract_text: cut(options.extract_text),
	});
}

function storeRemembered(beam: BeamMemoryState, content: string, options: StoreRememberOptions): string {
	const source = options.source ?? "conversation";
	const importance = options.importance ?? 0.5;
	const timestamp = options.timestamp ?? toUtcIso();
	const scope = options.scope ?? "session";
	const veracity = clampVeracity(options.veracity);
	const trustTier = normalizeTrustTier(options.trustTier, source);
	const memoryType = options.memoryType ?? "unknown";
	const validUntil = options.validUntil ?? options.valid_until ?? null;
	const authorId = options.authorId ?? options.author_id ?? beam.authorId;
	const authorType = options.authorType ?? options.author_type ?? beam.authorType;
	const channelId = options.channelId ?? options.channel_id ?? beam.channelId;
	const metadata = options.metadata ?? null;
	const embedText = embeddingText(content, options);

	const existingId = findDuplicate(beam, content);
	if (existingId !== null) {
		beam.db.run(
			`
				UPDATE working_memory
				SET importance = MAX(importance, ?), timestamp = ?, source = ?,
					valid_until = COALESCE(?, valid_until),
					scope = COALESCE(?, scope),
					author_id = COALESCE(?, author_id),
					author_type = COALESCE(?, author_type),
					channel_id = COALESCE(?, channel_id),
					memory_type = COALESCE(?, memory_type),
					veracity = CASE WHEN ? != 'unknown' THEN ? ELSE veracity END,
					trust_tier = COALESCE(?, trust_tier),
					embed_text = COALESCE(?, embed_text),
					consolidated_at = NULL
				WHERE id = ? AND session_id = ?
			`,
			[
				importance,
				timestamp,
				source,
				validUntil,
				scope,
				authorId,
				authorType,
				channelId,
				memoryType,
				veracity,
				veracity,
				trustTier,
				storedEmbeddingText(content, embedText),
				existingId,
				beam.sessionId,
			],
		);
		emitEvent(beam, "MEMORY_UPDATED", {
			memoryId: existingId,
			content,
			source,
			importance,
			metadata: metadata ?? undefined,
		});
		if (embedText !== content) scheduleEmbedding(beam, [{ memoryId: existingId, content: embedText }]);
		invalidateCaches(beam);
		return existingId;
	}

	const memoryId = options.memoryId ?? options.memory_id ?? generateId(content, new Date(timestamp));
	beam.db.run(
		`
			INSERT INTO working_memory
			(id, content, embed_text, source, timestamp, session_id, importance, metadata_json, valid_until, scope,
			 author_id, author_type, channel_id, veracity, memory_type, trust_tier)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		[
			memoryId,
			content,
			storedEmbeddingText(content, embedText),
			source,
			timestamp,
			beam.sessionId,
			importance,
			metadataJson(metadata),
			validUntil,
			scope,
			authorId,
			authorType,
			channelId,
			veracity,
			memoryType,
			trustTier,
		],
	);
	addTemporalAnnotations(beam, memoryId, timestamp, source);
	// `extractText` lets a caller decouple "what gets stored" from "what facts are
	// mined". coding-agent retains full multi-author transcripts but wants
	// fact/entity heuristics to read only the user-authored turns (issue #3372).
	const extractionSource = options.extractText ?? options.extract_text ?? content;
	proactiveLinkIfEnabled(
		beam,
		memoryId,
		extractionSource,
		Boolean(options.extractEntities ?? options.extract_entities),
	);
	trimWorkingMemory(beam);
	emitEvent(beam, "MEMORY_ADDED", {
		memoryId,
		content,
		source,
		importance,
		metadata: metadata ?? undefined,
	});
	scheduleEmbedding(beam, [{ memoryId, content: embedText }]);
	if (options.extract === true) scheduleFactExtraction(beam, memoryId, extractionSource);
	invalidateCaches(beam);
	return memoryId;
}

export function rememberBatch(
	beam: BeamMemoryState,
	items: readonly RememberBatchItem[],
	options: StoreRememberBatchOptions = {},
): string[] {
	const timestamp = toUtcIso();
	const ids: string[] = [];
	const forceVeracity = options.forceVeracity ?? options.force_veracity ?? false;
	const defaultVeracity = clampVeracity(options.veracity);
	const defaultScope = options.scope ?? "session";
	const trustTier = normalizeTrustTier(options.trustTier ?? "IMPORTED", "imported");

	transaction(beam.db, () => {
		using statement = beam.db.prepare(`
			INSERT INTO working_memory
			(id, content, embed_text, source, timestamp, session_id, importance, metadata_json,
			 author_id, author_type, channel_id, memory_type, veracity, trust_tier, scope)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const item of items) {
			const itemTimestamp = item.timestamp ?? timestamp;
			const memoryId = generateId(item.content, new Date(itemTimestamp));
			ids.push(memoryId);
			const source = item.source ?? "conversation";
			const storeItem = item as StoreRememberOptions;
			const embedText = embeddingText(item.content, storeItem);
			const itemVeracity = forceVeracity
				? defaultVeracity
				: item.veracity !== undefined
					? clampVeracity(item.veracity)
					: defaultVeracity;
			statement.run(
				memoryId,
				item.content,
				storedEmbeddingText(item.content, embedText),
				source,
				itemTimestamp,
				beam.sessionId,
				item.importance ?? 0.5,
				metadataJson(item.metadata ?? null),
				storeItem.authorId ?? storeItem.author_id ?? beam.authorId,
				storeItem.authorType ?? storeItem.author_type ?? beam.authorType,
				storeItem.channelId ?? storeItem.channel_id ?? beam.channelId,
				item.memoryType ?? options.memoryType ?? "unknown",
				itemVeracity,
				trustTier,
				item.scope ?? defaultScope,
			);
			addTemporalAnnotations(beam, memoryId, itemTimestamp, source);
			emitEvent(beam, "MEMORY_ADDED", {
				memoryId,
				content: item.content,
				source,
				importance: item.importance ?? 0.5,
				metadata: item.metadata ?? undefined,
			});
		}
		trimWorkingMemory(beam);
	});
	invalidateCaches(beam);
	const embeddingItems: { memoryId: string; content: string }[] = [];
	items.forEach((item, index) => {
		const id = ids[index];
		if (id === undefined) return;
		embeddingItems.push({ memoryId: id, content: embeddingText(item.content, item as StoreRememberOptions) });
	});
	scheduleEmbedding(beam, embeddingItems);
	items.forEach((item, index) => {
		const id = ids[index];
		if (id !== undefined && (item.extract === true || options.extract === true)) {
			scheduleFactExtraction(beam, id, item.content);
		}
	});
	return ids;
}

export function getContext(beam: BeamMemoryState, limit = 10): Row[] {
	const now = toUtcIso();
	using statement = beam.db.prepare(`
		SELECT id, content, source, timestamp, importance, scope
		FROM working_memory
		WHERE (session_id = ? OR scope = 'global')
		  AND (valid_until IS NULL OR valid_until > ?)
		  AND superseded_by IS NULL
		ORDER BY
			CASE WHEN scope = 'global' THEN 0 ELSE 1 END,
			importance DESC,
			timestamp DESC
		LIMIT ?
	`);
	return (statement.all(beam.sessionId, now, limit) as Row[]).map(rowToDict);
}

/**
 * Invalidating keeps history: the row stays readable by id, and the retained transcripts that quote it stay as
 * they were, so recall can still show what was said and when. Only `forgetWorking` scrubs transcripts.
 */
export function invalidate(beam: BeamMemoryState, memoryId: string, replacementId: string | null = null): boolean {
	const now = toUtcIso();
	let retiredWorking = false;
	transaction(beam.db, () => {
		const working = beam.db.run(
			`
			UPDATE working_memory
			SET valid_until = ?, superseded_by = ?
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`,
			[now, replacementId, memoryId, beam.sessionId],
		);
		if (working.changes === 0) return;
		retiredWorking = true;
		retireDerivedSummaries(beam, memoryId, { kind: "invalidate", at: now, replacementId });
	});
	if (retiredWorking) {
		// Recall filters `valid_until`/`superseded_by` in SQL, but the enhanced path consults the
		// query cache BEFORE it reaches SQL. Without this the row a caller just retired keeps being
		// served to an identical query for the rest of the cache TTL -- the one thing an explicit
		// invalidation is supposed to guarantee against. Every other mutator here already does this;
		// this one was the omission. Gated on an actual row change, like `forgetWorking`, so a
		// no-op invalidation never discards a valid cache.
		invalidateCaches(beam);
		return true;
	}
	const episodic = beam.db.run(
		`
			UPDATE episodic_memory
			SET valid_until = ?, superseded_by = ?
			WHERE id = ? AND (session_id = ? OR scope = 'global')
		`,
		[now, replacementId, memoryId, beam.sessionId],
	);
	if (episodic.changes > 0) {
		invalidateCaches(beam);
		return true;
	}
	return false;
}

export function getWorkingStats(
	beam: BeamMemoryState,
	authorId: string | null = null,
	authorType: string | null = null,
	channelId: string | null = null,
): BeamStats {
	const clauses: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (authorId) {
		clauses.push("author_id = ?");
		params.push(authorId);
	}
	if (authorType) {
		clauses.push("author_type = ?");
		params.push(authorType);
	}
	if (channelId) {
		clauses.push("channel_id = ?");
		params.push(channelId);
	}
	const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
	using totalStatement = beam.db.prepare(`SELECT COUNT(*) AS total FROM working_memory${where}`);
	const total = totalStatement.get(...params) as {
		total: number;
	};
	using lastStatement = beam.db.prepare(
		`SELECT timestamp FROM working_memory${where} ORDER BY timestamp DESC LIMIT 1`,
	);
	const last = lastStatement.get(...params) as { timestamp: string | null } | null;
	return { total: total.total, count: total.total, last: last?.timestamp ?? null };
}

export function getGlobalWorkingStats(beam: BeamMemoryState): BeamStats {
	return getWorkingStats(beam);
}

export function updateWorking(
	beam: BeamMemoryState,
	memoryId: string,
	content: string | null = null,
	importance: number | null = null,
): boolean {
	const assignments: string[] = [];
	const params: SQLQueryBindings[] = [];
	if (content !== null) {
		assignments.push("content = ?", "embed_text = NULL");
		params.push(content);
	}
	if (importance !== null) {
		assignments.push("importance = ?");
		params.push(importance);
	}
	if (assignments.length === 0) return false;
	params.push(memoryId, beam.sessionId);
	const result = beam.db.run(
		`UPDATE working_memory SET ${assignments.join(", ")} WHERE id = ? AND session_id = ?`,
		params,
	);
	if (result.changes > 0) {
		invalidateCaches(beam);
		if (content !== null) scheduleEmbedding(beam, [{ memoryId, content }]);
	}
	return result.changes > 0;
}

export function get(beam: BeamMemoryState, memoryId: string): Row | null {
	using workingStatement = beam.db.prepare(`
		SELECT id, content, source, timestamp, session_id,
			   importance, metadata_json, veracity, created_at
		FROM working_memory
		WHERE id = ?
	`);
	const working = workingStatement.get(memoryId) as Row | null | undefined;
	if (working != null) return { ...working, metadata: working.metadata_json, memory_store: "working" };

	using episodicStatement = beam.db.prepare(`
		SELECT id, content, source, timestamp, session_id,
			   importance, metadata_json, veracity, created_at
		FROM episodic_memory
		WHERE id = ? AND (session_id = ? OR scope = 'global')
	`);
	const episodic = episodicStatement.get(memoryId, beam.sessionId) as Row | null | undefined;
	if (episodic != null) return { ...episodic, metadata: episodic.metadata_json, memory_store: "episodic" };

	return getFact(beam, memoryId);
}

/**
 * Read-only resolution for ids minted from the `facts` table. `recall`
 * surfaces `facts.fact_id` as a result id (`factRecall`), so `get` must
 * resolve those ids too — otherwise every surfaced fact id is a dead end
 * for the read path (issue #4725). Visibility mirrors `factRecall`:
 * same-session facts plus explicitly global ones (`scope` is an optional
 * column on `facts`; `SELECT *` tolerates banks without it, in which case
 * only same-session facts resolve). The row is shaped like the
 * working/episodic hits with the full triple as content;
 * `memory_store: "fact"` marks it read-only — no update/forget/invalidate
 * path mutates `facts`.
 */
function getFact(beam: BeamMemoryState, memoryId: string): Row | null {
	using statement = beam.db.prepare("SELECT * FROM facts WHERE fact_id = ?");
	const fact = statement.get(memoryId) as Row | null | undefined;
	if (fact == null) return null;
	if (fact.session_id !== beam.sessionId && fact.scope !== "global") return null;
	const subject = typeof fact.subject === "string" ? fact.subject : "";
	const predicate = typeof fact.predicate === "string" ? fact.predicate : "";
	const object = typeof fact.object === "string" ? fact.object : "";
	return {
		id: fact.fact_id,
		content: [subject, predicate, object].filter(part => part.length > 0).join(" "),
		source: "facts",
		timestamp: fact.timestamp ?? null,
		session_id: fact.session_id ?? null,
		importance: fact.confidence ?? null,
		metadata: JSON.stringify({
			subject,
			predicate,
			object,
			source_msg_id: fact.source_msg_id ?? null,
		}),
		created_at: fact.created_at ?? null,
		memory_store: "fact",
	};
}

/**
 * What the extractor made of a row, in its own wording: the text of its facts, as recall shows it. A later recall
 * quotes that wording, not the row's. Read before the row's artifacts are purged.
 */
function derivedTexts(db: BeamMemoryState["db"], memoryId: string): string[] {
	if (!tableExists(db, "facts")) return [];
	using statement = db.prepare("SELECT subject, predicate, object FROM facts WHERE source_msg_id = ?");
	const rows = statement.all(memoryId) as {
		subject: string | null;
		predicate: string | null;
		object: string | null;
	}[];
	return rows.map(row =>
		(row.object ?? "").length > 0 ? (row.object ?? "") : `${row.subject ?? ""} ${row.predicate ?? ""}`,
	);
}

/**
 * Delete a working row for good, with everything derived from it, and scrub its text out of the retained
 * transcripts and the summaries and facts built from them (`scrubTranscripts`): the row's text and the wording of
 * the facts extracted from it, and what is built from either. A text shorter than `MIN_SCRUB_CHARS` is not
 * scrubbed from transcripts: the outcome says so, and one warning names the memory id (never its text).
 */
export function forgetWorkingDetailed(beam: BeamMemoryState, memoryId: string): ForgetOutcome {
	const done = transaction(beam.db, () => {
		const row = beam.db
			.query("DELETE FROM working_memory WHERE id = ? AND session_id = ? RETURNING content, embed_text")
			.get(memoryId, beam.sessionId) as { content: string; embed_text: string | null } | null;
		if (row === null) return null;
		const tooShort = tooShortToScrub(row.content);
		const texts = tooShort ? [] : [row.content, row.embed_text ?? "", ...derivedTexts(beam.db, memoryId)];
		purgeWorkingMemoryArtifacts(beam.db, [memoryId]);
		// Scrub first, so a summary that lists the forgotten row and a scrubbed one is rewritten once.
		const scrubbed = tooShort ? [] : scrubTranscripts(beam, texts, memoryId);
		retireDerivedSummaries(beam, memoryId, { kind: "forget" });
		return { scrubbed, tooShort, texts };
	});
	if (done === null) return { deleted: false, scrubbedRows: 0, skippedBelowChars: null, forgottenTexts: [] };
	invalidateCaches(beam);
	reembedWorkingRows(beam, done.scrubbed);
	settleForget(beam.db);
	if (done.tooShort) {
		logger.warn("mnemopi: forgotten text too short to scrub from retained transcripts; they keep any copy", {
			memoryId,
			minChars: MIN_SCRUB_CHARS,
		});
	}
	return {
		deleted: true,
		scrubbedRows: done.scrubbed.length,
		skippedBelowChars: done.tooShort ? MIN_SCRUB_CHARS : null,
		forgottenTexts: [...new Set(done.texts.map(text => text.trim()).filter(text => text.length > 0))],
	};
}

export function forgetWorking(beam: BeamMemoryState, memoryId: string): boolean {
	return forgetWorkingDetailed(beam, memoryId).deleted;
}

export function scratchpadWrite(beam: BeamMemoryState, content: string): string {
	const padId = generateId(content);
	const timestamp = toUtcIso();
	beam.db.run(
		`
			INSERT INTO scratchpad (id, content, session_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
		`,
		[padId, content, beam.sessionId, timestamp, timestamp],
	);
	return padId;
}

export function scratchpadRead(beam: BeamMemoryState): Row[] {
	using statement = beam.db.prepare(`
		SELECT id, content, created_at, updated_at
		FROM scratchpad
		WHERE session_id = ?
		ORDER BY updated_at DESC
		LIMIT ?
	`);
	return (
		statement.all(beam.sessionId, Number.isFinite(SCRATCHPAD_MAX_ITEMS) ? SCRATCHPAD_MAX_ITEMS : 1000) as Row[]
	).map(rowToDict);
}

export function scratchpadClear(beam: BeamMemoryState): void {
	beam.db.run("DELETE FROM scratchpad WHERE session_id = ?", [beam.sessionId]);
}

export function exportToDict(beam: BeamMemoryState): Record<string, unknown> {
	const db = beam.db;
	using workingStatement = db.prepare(`
		SELECT id, content, source, timestamp, session_id, importance,
			   embed_text,
			   metadata_json, valid_until, superseded_by, scope,
			   recall_count, last_recalled, created_at, veracity, consolidated_at,
			   memory_type, author_id, author_type, channel_id, trust_tier,
			   event_date, event_date_precision, temporal_tags
		FROM working_memory
		ORDER BY session_id, timestamp
	`);
	using episodicStatement = db.prepare(`
		SELECT rowid, id, content, source, timestamp, session_id, importance,
			   metadata_json, summary_of, valid_until, superseded_by, scope,
			   recall_count, last_recalled, created_at, veracity, memory_type,
			   author_id, author_type, channel_id, trust_tier,
			   event_date, event_date_precision, temporal_tags
		FROM episodic_memory
		ORDER BY session_id, timestamp
	`);
	using scratchpadStatement = db.prepare(`
		SELECT id, content, session_id, created_at, updated_at
		FROM scratchpad
		ORDER BY session_id, updated_at
	`);
	using consolidationStatement = db.prepare(`
		SELECT id, session_id, items_consolidated, summary_preview, created_at
		FROM consolidation_log
		ORDER BY session_id, created_at
	`);
	return {
		mnemopi_export: {
			version: "1.0",
			export_date: toUtcIso(),
			source_db: beam.dbPath ?? ":memory:",
			component: "beam",
		},
		working_memory: workingStatement.all(),
		episodic_memory: episodicStatement.all(),
		episodic_embeddings: [],
		scratchpad: scratchpadStatement.all(),
		consolidation_log: consolidationStatement.all(),
	};
}

export function importFromDict(beam: BeamMemoryState, data: Record<string, unknown>, force = false): ImportStats {
	const stats = {
		working_memory: { inserted: 0, skipped: 0, overwritten: 0 },
		episodic_memory: { inserted: 0, skipped: 0, overwritten: 0, embeddings_inserted: 0 },
		scratchpad: { inserted: 0, updated: 0 },
		consolidation_log: { inserted: 0 },
	} satisfies ImportStats;
	const db: Database = beam.db;
	// Imported working-memory rows are durable, not scratch: stamp any that
	// arrive unconsolidated so the TTL trim treats them as consolidated and can
	// never silently discard a restored bank (issue #4819).
	const importedAt = toUtcIso();
	const oldToNewRowid = new Map<number, number>();

	// Hoisted out of the per-row loops: `db.query` is Bun's cached-statement
	// API (no per-row prepare/finalize churn), and the vec availability probe
	// is loop-invariant (schema is fixed at open).
	const workingExists = db.query("SELECT 1 FROM working_memory WHERE id = ?");
	const episodicExists = db.query("SELECT 1 FROM episodic_memory WHERE id = ?");
	const episodicRowid = db.query("SELECT rowid FROM episodic_memory WHERE id = ?");
	const scratchExists = db.query("SELECT 1 FROM scratchpad WHERE id = ?");
	const vecEpisodesAvailable = vecAvailable(db);
	transaction(db, () => {
		for (const raw of Array.isArray(data.working_memory) ? data.working_memory : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = workingExists.get(id) !== null;
			if (exists && !force) {
				stats.working_memory.skipped++;
				continue;
			}
			if (exists) {
				db.run("DELETE FROM working_memory WHERE id = ?", [id]);
				purgeWorkingMemoryArtifacts(db, [id]);
				stats.working_memory.overwritten++;
			} else {
				stats.working_memory.inserted++;
			}
			db.run(
				`
				INSERT INTO working_memory
				(id, content, source, timestamp, session_id, importance, metadata_json,
				 valid_until, superseded_by, scope, recall_count, last_recalled, created_at,
				 veracity, consolidated_at, memory_type, embed_text, author_id, author_type, channel_id,
				 trust_tier, event_date, event_date_precision, temporal_tags)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
				[
					id,
					sqlBinding(item.content, ""),
					sqlBinding(item.source, null),
					sqlBinding(item.timestamp, null),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.importance, 0.5),
					sqlBinding(item.metadata_json, "{}"),
					sqlBinding(item.valid_until, null),
					sqlBinding(item.superseded_by, null),
					sqlBinding(item.scope, "session"),
					sqlBinding(item.recall_count, 0),
					sqlBinding(item.last_recalled, null),
					sqlBinding(item.created_at, null),
					clampVeracity(item.veracity),
					item.consolidated_at == null ? importedAt : sqlBinding(item.consolidated_at, importedAt),
					sqlBinding(item.memory_type, "unknown"),
					sqlBinding(item.embed_text, null),
					sqlBinding(item.author_id, null),
					sqlBinding(item.author_type, null),
					sqlBinding(item.channel_id, null),
					sqlBinding(item.trust_tier, "STATED"),
					sqlBinding(item.event_date, null),
					sqlBinding(item.event_date_precision, "unknown"),
					sqlBinding(item.temporal_tags, "[]"),
				],
			);
		}

		for (const raw of Array.isArray(data.episodic_memory) ? data.episodic_memory : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = episodicExists.get(id) !== null;
			if (exists && !force) {
				stats.episodic_memory.skipped++;
				continue;
			}
			if (exists) {
				const existingRow = episodicRowid.get(id) as {
					rowid: number;
				} | null;
				if (existingRow !== null && vecEpisodesAvailable) {
					try {
						db.run("DELETE FROM vec_episodes WHERE rowid = ?", [existingRow.rowid]);
					} catch {
						// sqlite-vec cleanup is best-effort; import correctness takes precedence.
					}
				}
				db.run("DELETE FROM episodic_memory WHERE id = ?", [id]);
				stats.episodic_memory.overwritten++;
			} else {
				stats.episodic_memory.inserted++;
			}
			db.run(
				`
				INSERT INTO episodic_memory
				(id, content, source, timestamp, session_id, importance, metadata_json,
				 summary_of, valid_until, superseded_by, scope, recall_count, last_recalled, created_at,
				 veracity, memory_type, author_id, author_type, channel_id, trust_tier,
				 event_date, event_date_precision, temporal_tags)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
				[
					id,
					sqlBinding(item.content, ""),
					sqlBinding(item.source, null),
					sqlBinding(item.timestamp, null),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.importance, 0.5),
					sqlBinding(item.metadata_json, "{}"),
					sqlBinding(item.summary_of, ""),
					sqlBinding(item.valid_until, null),
					sqlBinding(item.superseded_by, null),
					sqlBinding(item.scope, "session"),
					sqlBinding(item.recall_count, 0),
					sqlBinding(item.last_recalled, null),
					sqlBinding(item.created_at, null),
					clampVeracity(item.veracity),
					sqlBinding(item.memory_type, "unknown"),
					sqlBinding(item.author_id, null),
					sqlBinding(item.author_type, null),
					sqlBinding(item.channel_id, null),
					sqlBinding(item.trust_tier, "STATED"),
					sqlBinding(item.event_date, null),
					sqlBinding(item.event_date_precision, "unknown"),
					sqlBinding(item.temporal_tags, "[]"),
				],
			);
			const oldRowid = Number(item.rowid);
			const newRow = episodicRowid.get(id) as {
				rowid: number;
			} | null;
			if (Number.isFinite(oldRowid) && newRow !== null) oldToNewRowid.set(oldRowid, newRow.rowid);
		}

		for (const raw of Array.isArray(data.episodic_embeddings) ? data.episodic_embeddings : []) {
			const item = jsonObject(raw);
			const oldRowid = Number(item.rowid);
			const mappedRowid = oldToNewRowid.get(oldRowid);
			const embedding = Array.isArray(item.embedding) ? item.embedding.map(value => Number(value)) : null;
			if (mappedRowid === undefined || embedding === null || embedding.some(v => !Number.isFinite(v))) {
				continue;
			}
			if (!vecEpisodesAvailable) continue;
			try {
				vecInsert(db, mappedRowid, embedding);
				stats.episodic_memory.embeddings_inserted++;
			} catch {
				// Embedding import is best-effort when sqlite-vec is unavailable or degraded.
			}
		}

		for (const raw of Array.isArray(data.scratchpad) ? data.scratchpad : []) {
			const item = jsonObject(raw);
			const id = String(item.id ?? "");
			if (id.length === 0) continue;
			const exists = scratchExists.get(id) !== null;
			if (exists) {
				db.run("UPDATE scratchpad SET content = ?, session_id = ?, created_at = ?, updated_at = ? WHERE id = ?", [
					sqlBinding(item.content, ""),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.created_at, null),
					sqlBinding(item.updated_at, null),
					id,
				]);
				stats.scratchpad.updated++;
			} else {
				db.run("INSERT INTO scratchpad (id, content, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
					id,
					sqlBinding(item.content, ""),
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.created_at, null),
					sqlBinding(item.updated_at, null),
				]);
				stats.scratchpad.inserted++;
			}
		}

		for (const raw of Array.isArray(data.consolidation_log) ? data.consolidation_log : []) {
			const item = jsonObject(raw);
			db.run(
				"INSERT INTO consolidation_log (session_id, items_consolidated, summary_preview, created_at) VALUES (?, ?, ?, ?)",
				[
					sqlBinding(item.session_id, "default"),
					sqlBinding(item.items_consolidated, 0),
					sqlBinding(item.summary_preview, ""),
					sqlBinding(item.created_at, null),
				],
			);
			stats.consolidation_log.inserted++;
		}
	});
	invalidateCaches(beam);
	return stats;
}
