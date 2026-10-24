/**
 * A stat whose change time is younger than this cannot vouch for the file (git's racy-clean rule, the same window as
 * grep.ts). Linux file times come from a coarse kernel clock, one tick of a few milliseconds, so a rewrite in the same
 * tick as a recorded stat leaves its inode, size, mtime and ctime unchanged and a cache keyed on that stamp serves
 * stale data. macOS and other nanosecond-fine clocks hide the problem.
 */
export const RACY_STAMP_WINDOW_MS = 2_000;

/**
 * Whether `stat` is racy: its newest change time (a writer can restore mtime, a touch leaves ctime or mtime alone) is
 * inside the window of `now`. A future-dated or non-finite stamp is racy too, since it never proves the file is old.
 * Callers must not store a racy stat as a cache key, and should drop any entry they hold for that path.
 */
export function isRacyStat(stat: { mtimeMs: number; ctimeMs: number }, now: number = Date.now()): boolean {
	return !(now - Math.max(stat.mtimeMs, stat.ctimeMs) >= RACY_STAMP_WINDOW_MS);
}
