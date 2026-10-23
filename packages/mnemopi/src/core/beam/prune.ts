import { logger } from "@oh-my-pi/pi-utils";
import { transaction } from "../../db";
import type { BeamMemoryState, PruneResult } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most rows one run removes, so the first run on a large database cannot hold session start for minutes. The next run takes the rest. */
export const PRUNE_ROWS_PER_RUN = 5000;
/** Rows per write transaction, so other connections wait for milliseconds, not for the whole run. */
const PRUNE_BATCH_SIZE = 500;
/** A run compacts the file when the pages it freed are at least this share of it, and at least this many bytes. */
const RECLAIM_MIN_FREE_RATIO = 0.25;
const RECLAIM_MIN_FREE_BYTES = 4 * 1024 * 1024;

type IdRow = { id: string };

function tableExists(beam: BeamMemoryState, table: string): boolean {
	using statement = beam.db.prepare(
		"SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ? LIMIT 1",
	);
	return statement.get(table) !== null;
}

/** Ids of the working rows that a live episodic summary lists in `summary_of`. */
function summarizedIds(beam: BeamMemoryState, nowIso: string): Set<string> {
	const covered = new Set<string>();
	using statement = beam.db.prepare(
		`SELECT summary_of FROM episodic_memory
		 WHERE summary_of IS NOT NULL AND summary_of != '' AND superseded_by IS NULL
		   AND (valid_until IS NULL OR valid_until > ?)`,
	);
	for (const row of statement.iterate(nowIso) as Iterable<{ summary_of: string }>) {
		for (const id of row.summary_of.split(",")) if (id !== "") covered.add(id);
	}
	return covered;
}

/** Oldest-first ids of consolidated, non-`IMPORTED` rows past `cutoff` that a live summary covers, up to one run's worth. */
function candidateIds(beam: BeamMemoryState, cutoff: string, covered: ReadonlySet<string>): string[] {
	const ids: string[] = [];
	using statement = beam.db.prepare(
		"SELECT id FROM working_memory WHERE consolidated_at < ? AND trust_tier IS NOT 'IMPORTED' ORDER BY timestamp",
	);
	for (const row of statement.iterate(cutoff) as Iterable<IdRow>) {
		if (!covered.has(row.id)) continue;
		ids.push(row.id);
		if (ids.length >= PRUNE_ROWS_PER_RUN) break;
	}
	return ids;
}

/**
 * Delete one batch with everything that only that row owned: its full-text entry, vector, annotations,
 * validation log, and the graph nodes and edges built on its id. The summary's own rows and the facts
 * extracted from the row are the distilled copy and stay. The guards run again inside the delete itself:
 * another process may have re-stamped a row (an exact duplicate write clears `consolidated_at`) since
 * the candidates were read.
 *
 * `wm_ad` deletes the full-text entry with a scan of the whole full-text table, once per row: tens of
 * milliseconds each on a bank with thousands of transcripts, minutes per run. So the full-text entries go
 * with one `IN`, and the trigger is dropped for this transaction and put back before the commit (DDL is
 * transactional, and no other writer runs while the transaction holds the write lock). The first statement
 * is a write, so the transaction takes the write lock under the busy timeout instead of failing at once
 * when another process has committed since a read began.
 */
function deleteBatch(beam: BeamMemoryState, ids: readonly string[], cutoff: string, triggerSql: string | null): number {
	const db = beam.db;
	let removed = 0;
	transaction(db, () => {
		if (triggerSql !== null) db.run("DROP TRIGGER IF EXISTS wm_ad");
		const marks = ids.map(() => "?").join(",");
		const batch = (
			db
				.query(
					`DELETE FROM working_memory WHERE id IN (${marks}) AND consolidated_at < ? AND trust_tier IS NOT 'IMPORTED' RETURNING id`,
				)
				.all(...ids, cutoff) as IdRow[]
		).map(row => row.id);
		if (batch.length > 0) {
			const batchMarks = batch.map(() => "?").join(",");
			db.run(`DELETE FROM fts_working WHERE id IN (${batchMarks})`, batch);
			db.run(`DELETE FROM annotations WHERE memory_id IN (${batchMarks})`, batch);
			db.run(`DELETE FROM memory_embeddings WHERE memory_id IN (${batchMarks})`, batch);
			db.run(`DELETE FROM memory_validations WHERE memory_id IN (${batchMarks})`, batch);
			if (tableExists(beam, "gists")) db.run(`DELETE FROM gists WHERE memory_id IN (${batchMarks})`, batch);
			if (tableExists(beam, "graph_edges")) {
				const refs = [...batch, ...batch.map(id => `gist_${id}`)];
				const refMarks = refs.map(() => "?").join(",");
				db.run(`DELETE FROM graph_edges WHERE source IN (${refMarks})`, refs);
				db.run(`DELETE FROM graph_edges WHERE target IN (${refMarks})`, refs);
			}
		}
		if (triggerSql !== null) db.run(triggerSql);
		removed = batch.length;
	});
	return removed;
}

function pragmaInt(beam: BeamMemoryState, name: string): number {
	const row = beam.db.query(`PRAGMA ${name}`).get() as Record<string, number> | null;
	return row === null ? 0 : (Object.values(row)[0] ?? 0);
}

/**
 * Deleting rows leaves their tokens in the full-text index as delete markers until the segments merge, and the
 * index of a bank that deletes a day of rows every day never catches up: on the synthetic Commander year it
 * was four times the size of the same rows indexed fresh. One `optimize` rewrites it without them (70 ms for a
 * 10 MB index) and puts the pages on the freelist. A write transaction like any other; best-effort.
 */
function optimizeFullText(beam: BeamMemoryState): void {
	try {
		beam.db.run("INSERT INTO fts_working(fts_working) VALUES ('optimize')");
	} catch (error) {
		logger.warn("mnemopi: full-text index merge after pruning failed; it merges on a later run", {
			error: String(error),
		});
	}
}

/**
 * Give freed pages back to the file. SQLite only reuses them, so without this a pruned file stops growing
 * but never shrinks. `VACUUM` rewrites the whole file, so it runs only when the run freed a quarter of it
 * (and 4 MiB or more); a steady prune frees about what new writes need and never gets there. In WAL mode
 * `VACUUM` is one write transaction: readers in other processes keep reading their snapshot, writers wait
 * out the 5 s busy timeout, and it needs free disk of about the database size while it runs. Rowids are
 * kept, which the external-content full-text tables depend on. A failure is logged and retried next run.
 */
function reclaimFreePages(beam: BeamMemoryState): boolean {
	if (beam.db.inTransaction) return false;
	const free = pragmaInt(beam, "freelist_count");
	const total = pragmaInt(beam, "page_count");
	if (total === 0 || free / total < RECLAIM_MIN_FREE_RATIO) return false;
	if (free * pragmaInt(beam, "page_size") < RECLAIM_MIN_FREE_BYTES) return false;
	try {
		beam.db.run("VACUUM");
		return true;
	} catch (error) {
		logger.warn("mnemopi: compaction after pruning failed; the file keeps its size until the next run", {
			error: String(error),
		});
		return false;
	}
}

/**
 * The bounded-growth step of `sleep`: delete the working rows `sleep` summarized `pruneConsolidatedDays` ago or
 * longer. Returns `undefined` when the setting is off. A row goes only when all of these hold: it is consolidated
 * (`consolidated_at` set and past the cutoff), it is not `IMPORTED`, and a live (not superseded, not expired)
 * episodic row lists it in `summary_of`. Unconsolidated rows, rows a migration merely marked, and rows whose
 * summary was retired never qualify, so the only copy of a memory is never deleted. Never throws: a failure is
 * logged and the rows stay for the next run.
 */
export function pruneConsolidatedWorkingMemory(beam: BeamMemoryState, dryRun = false): PruneResult | undefined {
	const days = beam.config.pruneConsolidatedDays;
	if (days === undefined || !Number.isFinite(days) || days <= 0) return undefined;
	let pruned = 0;
	try {
		const now = Date.now();
		const cutoff = new Date(now - days * DAY_MS).toISOString();
		const ids = candidateIds(beam, cutoff, summarizedIds(beam, new Date(now).toISOString()));
		// Nothing eligible still checks the freelist: a capped run left the compaction for the run that clears the backlog.
		if (ids.length === 0) return { status: "no_op", pruned: 0, reclaimed: !dryRun && reclaimFreePages(beam) };
		if (dryRun) return { status: "dry_run", pruned: ids.length, reclaimed: false };
		const trigger = beam.db
			.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'wm_ad'")
			.get() as {
			sql: string;
		} | null;
		for (let start = 0; start < ids.length; start += PRUNE_BATCH_SIZE) {
			pruned += deleteBatch(beam, ids.slice(start, start + PRUNE_BATCH_SIZE), cutoff, trigger?.sql ?? null);
		}
		if (pruned > 0) optimizeFullText(beam);
		// A capped run has more rows waiting: compact once, after the last of them, not after every run.
		const backlog = ids.length >= PRUNE_ROWS_PER_RUN;
		return { status: pruned > 0 ? "pruned" : "no_op", pruned, reclaimed: !backlog && reclaimFreePages(beam) };
	} catch (error) {
		logger.warn("mnemopi: pruning consolidated working rows failed; rows stay for the next run", {
			error: String(error),
		});
		return { status: "failed", pruned, reclaimed: false };
	}
}
