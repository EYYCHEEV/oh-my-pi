/**
 * Why a session runs without Mnemopi.
 *
 * A Mnemopi start that throws (database or folder not writable, a read-only `-wal` left by an
 * earlier run, a locked file) leaves the session with memory off. This module keeps the reason
 * on the session, so startup can announce it once and the memory tools can name it instead of
 * saying only that the backend is not initialised.
 *
 * Reporting only: nothing here changes a file mode or retries a start. Paths are shown relative
 * to the agent dir; an absolute home path never leaves this module.
 *
 * Kept free of the Mnemopi package so the CLI startup module graph stays small.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/** The generic sentence the memory tools used before a reason was recorded. */
export const MNEMOPI_NOT_INITIALISED = "Mnemopi backend is not initialised for this session.";

export interface MnemopiStartupFailure {
	/** Error class of the failure, e.g. `SQLiteError`. */
	errorClass: string;
	/** Error code when it has one, e.g. `SQLITE_READONLY` or `EACCES`. */
	code?: string;
	/** One short line with absolute paths removed. */
	message: string;
	/** The database the session tried to open, relative to the agent dir. */
	file?: string;
	/**
	 * Files and folders that were not writable right after the failure, relative to the agent dir:
	 * the database folder, the database, and its `-wal` and `-shm` sidecars.
	 */
	notWritable: readonly string[];
	/** Set on a child session that took the reason from its parent. */
	inherited?: true;
}

const MAX_MESSAGE_CHARS = 240;
const SIDECAR_SUFFIXES = ["", "-wal", "-shm"] as const;
const OUTSIDE_AGENT_DIR = "<outside agent dir>";

/** Any absolute path in an error message; the first character must not continue a word or a relative path. */
const ABSOLUTE_PATH =
	/(?<![\w.~<>:/\\-])(?:[A-Za-z]:[\\/]|[\\/])(?:[^\s'"`<>|:;,()[\]{}\\/]+[\\/])*[^\s'"`<>|:;,()[\]{}\\/]+/g;

function isWritable(target: string): boolean {
	try {
		fs.accessSync(target, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** The path as the report shows it: relative to the agent dir, or the bare name outside it. */
function displayPath(target: string, agentDir: string): string {
	const relative = path.relative(agentDir, target);
	if (relative === "") return "<agent dir>";
	if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
	return `${OUTSIDE_AGENT_DIR}/${path.basename(target)}`;
}

function scrubPaths(text: string, agentDir: string): string {
	let scrubbed = text;
	const roots: Array<[string, string]> = [
		[agentDir.replace(/[\\/]+$/, ""), "<agent dir>"],
		[os.homedir().replace(/[\\/]+$/, ""), "~"],
	];
	for (const [root, label] of roots) {
		if (root.length > 1) scrubbed = scrubbed.split(root).join(label);
	}
	return scrubbed.replace(ABSOLUTE_PATH, match => `<path>/${match.split(/[\\/]/).pop()}`);
}

/** Folder, database and sidecars of `dbPath` that exist but are not writable, nearest existing folder first. */
function findNotWritable(dbPath: string): string[] {
	const blocked: string[] = [];
	// A folder that does not exist yet cannot be created when its nearest existing parent is read-only.
	let folder = path.dirname(dbPath);
	while (!fs.existsSync(folder)) {
		const parent = path.dirname(folder);
		if (parent === folder) break;
		folder = parent;
	}
	if (fs.existsSync(folder) && !isWritable(folder)) blocked.push(folder);
	for (const suffix of SIDECAR_SUFFIXES) {
		const file = `${dbPath}${suffix}`;
		if (fs.existsSync(file) && !isWritable(file)) blocked.push(file);
	}
	return blocked;
}

/**
 * Builds the record for a failed start. `dbPaths` are the databases the session would open, the
 * retain bank first. Never throws: a probe that cannot run leaves its part of the record out.
 */
export function describeMnemopiStartupFailure(
	error: unknown,
	context: { agentDir: string; dbPaths: readonly string[] },
): MnemopiStartupFailure {
	const { agentDir, dbPaths } = context;
	const errorClass = error instanceof Error ? error.name || "Error" : typeof error;
	const rawCode = (error as { code?: unknown } | null | undefined)?.code;
	const code = typeof rawCode === "string" && rawCode.length > 0 ? rawCode : undefined;
	const raw = error instanceof Error ? error.message : String(error);
	let message = scrubPaths(raw, agentDir).replace(/\s+/g, " ").trim();
	if (message.length > MAX_MESSAGE_CHARS) message = `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…`;

	const notWritable = new Set<string>();
	let culprit: string | undefined = dbPaths[0];
	for (const dbPath of dbPaths) {
		let blocked: string[] = [];
		try {
			blocked = findNotWritable(dbPath);
		} catch {
			// A probe that cannot run says nothing about this database.
		}
		if (blocked.length > 0 && !notWritable.size) culprit = dbPath;
		for (const entry of blocked) notWritable.add(displayPath(entry, agentDir));
	}

	const failure: MnemopiStartupFailure = { errorClass, message, notWritable: [...notWritable] };
	if (code) failure.code = code;
	if (culprit) failure.file = displayPath(culprit, agentDir);
	return failure;
}

/** The reason on one line, without a leading sentence: `SQLiteError (SQLITE_READONLY): ...; not writable: ...; database: ...`. */
export function formatMnemopiStartupFailure(failure: MnemopiStartupFailure): string {
	const label = failure.code ? `${failure.errorClass} (${failure.code})` : failure.errorClass;
	const parts = [`${label}: ${failure.message.replace(/[.\s]+$/u, "")}`];
	if (failure.notWritable.length > 0) parts.push(`not writable: ${failure.notWritable.join(", ")}`);
	if (failure.file) parts.push(`database: ${failure.file}`);
	const text = parts.join("; ");
	return failure.inherited ? `${text} (same reason as the parent session)` : text;
}

/** The line startup shows once: stderr in print and RPC modes, a warning in the TUI. */
export function mnemopiStartupNotice(failure: MnemopiStartupFailure): string {
	return `Mnemopi memory is off for this session. Startup failed: ${formatMnemopiStartupFailure(failure)}.`;
}

/** What a memory tool or backend result says when there is no Mnemopi state: the cause when one was recorded. */
export function mnemopiNotInitialisedMessage(failure: MnemopiStartupFailure | undefined): string {
	return failure
		? `${MNEMOPI_NOT_INITIALISED} Startup failed: ${formatMnemopiStartupFailure(failure)}.`
		: MNEMOPI_NOT_INITIALISED;
}

type StartupFailureWatcher = (failure: MnemopiStartupFailure) => void;

interface WatcherEntry {
	deliver: StartupFailureWatcher;
	/** Forget what was delivered, so a failure that returns after a recovery is announced again. */
	reset: () => void;
}

interface FailureSlot {
	failure?: MnemopiStartupFailure;
	watchers: Set<WatcherEntry>;
}

// Keyed by the session object so a fake or frozen session needs no extra property.
const slots = new WeakMap<object, FailureSlot>();

function slotFor(session: object): FailureSlot {
	let slot = slots.get(session);
	if (!slot) {
		slot = { watchers: new Set() };
		slots.set(session, slot);
	}
	return slot;
}

export function getMnemopiStartupFailure(session: object | undefined): MnemopiStartupFailure | undefined {
	return session ? slots.get(session)?.failure : undefined;
}

/** Remembers why `session` has no Mnemopi and tells its watchers. */
export function recordMnemopiStartupFailure(session: object, failure: MnemopiStartupFailure): void {
	const slot = slotFor(session);
	slot.failure = failure;
	for (const watcher of slot.watchers) watcher.deliver(failure);
}

/**
 * A child session takes its parent's reason so its memory tools can name it. A child is never
 * announced: the top-level session already was.
 */
export function inheritMnemopiStartupFailure(session: object, failure: MnemopiStartupFailure): void {
	slotFor(session).failure = { ...failure, inherited: true };
}

/** A start that worked supersedes the reason a failed one left. Watchers are not told. */
export function clearMnemopiStartupFailure(session: object): void {
	const slot = slots.get(session);
	if (!slot?.failure) return;
	slot.failure = undefined;
	for (const watcher of slot.watchers) watcher.reset();
}

/**
 * Calls `watcher` with the session's startup failure: at once for one recorded before this call,
 * and later for each new one. The same reason is delivered once. Returns the unsubscribe function.
 */
export function watchMnemopiStartupFailure(session: object, watcher: StartupFailureWatcher): () => void {
	const slot = slotFor(session);
	let delivered: string | undefined;
	const entry: WatcherEntry = {
		deliver: failure => {
			const text = formatMnemopiStartupFailure(failure);
			if (text === delivered) return;
			delivered = text;
			try {
				watcher(failure);
			} catch (error) {
				logger.warn("Mnemopi: startup failure watcher threw", { error: String(error) });
			}
		},
		reset: () => {
			delivered = undefined;
		},
	};
	slot.watchers.add(entry);
	if (slot.failure && !slot.failure.inherited) entry.deliver(slot.failure);
	return () => {
		slot.watchers.delete(entry);
	};
}
