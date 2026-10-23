import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import { toUtcIso } from "../../util/datetime";

/**
 * Making a forget reach the bytes on disk, not only the rows a query returns. SQLite keeps what a delete frees
 * in the free space of the main file (cleared by `PRAGMA secure_delete`, set on every connection), in the
 * write-ahead log until a checkpoint copies it over and truncates it (`settleForget`), and, for a full-text
 * index, in the segments the deleted row was indexed in (cleared by the FTS5 `secure-delete` option while the
 * forget runs, or by merging the segments when the SQLite build has no such option).
 */

/** The full-text indexes of a bank. */
const FTS_TABLES = ["fts_working", "fts_episodes", "fts_facts"] as const;

/**
 * How long a forget waits for a reader to finish its transaction before it gives up on the checkpoint and
 * leaves it pending. A checkpoint cannot truncate the log while any connection still reads an older snapshot,
 * and a hand session reading memory can hold one for minutes; the default `busy_timeout` is 5 s.
 */
const CHECKPOINT_WAIT_MS = 200;

function ftsDeletesSecurely(db: Database, table: string): boolean {
	try {
		const row = db.query(`SELECT v FROM ${table}_config WHERE k = 'secure-delete'`).get() as {
			v: number | string;
		} | null;
		return row !== null && Number(row.v) === 1;
	} catch {
		return false;
	}
}

/**
 * Run `fn`, which deletes rows, with every full-text index clearing the terms of what it deletes from its
 * segments, and return what `fn` returned with the indexes that could not (an FTS5 without the option): the
 * caller has `settleForget` merge those. Call it inside the transaction that deletes, so the setting is put back
 * with the same commit; it stays off otherwise, because a secure delete rewrites segment pages, which made a
 * 5000-row prune about 30 times slower (0.25 s to 8.5 s).
 */
export function secureFullTextDeletes<T>(db: Database, fn: () => T): { value: T; insecure: string[] } {
	const insecure: string[] = [];
	const restore: { table: string; value: 0 | 1 }[] = [];
	for (const table of FTS_TABLES) {
		const previous = ftsDeletesSecurely(db, table) ? 1 : 0;
		try {
			db.run(`INSERT INTO ${table}(${table}, rank) VALUES('secure-delete', 1)`);
			restore.push({ table, value: previous });
		} catch (error) {
			insecure.push(table);
			logger.debug("mnemopi: full-text index cannot delete securely", { table, error: String(error) });
		}
	}
	try {
		return { value: fn(), insecure };
	} finally {
		for (const { table, value } of restore)
			db.run(`INSERT INTO ${table}(${table}, rank) VALUES('secure-delete', ${value})`);
	}
}

/** A merge rewrites every segment and frees the old ones, which `secure_delete` then zeroes. */
function mergeIndexes(db: Database, tables: readonly string[]): void {
	for (const table of tables) {
		try {
			db.run(`INSERT INTO ${table}(${table}) VALUES('optimize')`);
		} catch (error) {
			logger.warn("mnemopi: could not merge a full-text index after a forget", { table, error: String(error) });
		}
	}
}

function busyTimeout(db: Database): number {
	const row = db.query("PRAGMA busy_timeout").get() as { timeout: number } | null;
	return row?.timeout ?? 0;
}

/** Copy the log into the main file and empty it. False when a reader or a transaction of this connection is in the way. */
function checkpoint(db: Database): boolean {
	if (db.inTransaction) return false;
	try {
		const previous = busyTimeout(db);
		db.exec(`PRAGMA busy_timeout=${CHECKPOINT_WAIT_MS}`);
		try {
			const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | null;
			return row === null || row.busy === 0;
		} finally {
			db.exec(`PRAGMA busy_timeout=${previous}`);
		}
	} catch (error) {
		logger.debug("mnemopi: checkpoint after a forget did not finish", { error: String(error) });
		return false;
	}
}

function hasPending(db: Database): boolean {
	try {
		return db.query("SELECT 1 FROM forget_checkpoint_pending LIMIT 1").get() !== null;
	} catch {
		return false;
	}
}

/**
 * Finish what a forget owes the file: merge the indexes that could not delete securely (`insecure`, from
 * `secureFullTextDeletes`), then checkpoint. Call it after the delete has committed, outside any transaction.
 * A checkpoint that cannot finish is recorded in the database (`forget_checkpoint_pending`), so the next process
 * to open, `sleep` or close the bank finishes it, whichever process forgot. Never throws: the memory is already
 * forgotten, and a failure here only means the old bytes stay a little longer.
 */
export function settleForget(db: Database, insecure: readonly string[] = []): void {
	try {
		mergeIndexes(db, insecure);
		if (checkpoint(db)) {
			if (hasPending(db)) db.run("DELETE FROM forget_checkpoint_pending");
		} else {
			db.run("INSERT OR REPLACE INTO forget_checkpoint_pending (id, at) VALUES (1, ?)", [toUtcIso()]);
		}
	} catch (error) {
		logger.warn("mnemopi: could not make a forget durable", { error: String(error) });
	}
}

/** Retry the checkpoint an earlier forget could not finish. Costs one indexed read when nothing is owed. */
export function finishPendingForget(db: Database): void {
	try {
		if (db.inTransaction || !hasPending(db)) return;
		if (checkpoint(db)) db.run("DELETE FROM forget_checkpoint_pending");
	} catch (error) {
		logger.warn("mnemopi: could not finish a pending forget checkpoint", { error: String(error) });
	}
}
