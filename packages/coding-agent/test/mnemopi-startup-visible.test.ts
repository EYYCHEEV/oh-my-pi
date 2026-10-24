/**
 * Contract: when Mnemopi cannot start for a session (database or folder not writable, a
 * read-only `-wal` left behind by an earlier run), the session says why instead of silently
 * running with memory off. The reason is remembered on the session, surfaced once at startup,
 * named by every memory tool, and inherited by child sessions. Paths are relative to the agent
 * dir; no absolute home path ever appears. Nothing here changes a file mode.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import {
	describeMnemopiStartupFailure,
	formatMnemopiStartupFailure,
	getMnemopiStartupFailure,
	type MnemopiStartupFailure,
	mnemopiNotInitialisedMessage,
	mnemopiStartupNotice,
	recordMnemopiStartupFailure,
	watchMnemopiStartupFailure,
} from "@oh-my-pi/pi-coding-agent/mnemopi/startup-failure";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { LearnTool } from "@oh-my-pi/pi-coding-agent/tools/learn";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";

// File modes only constrain a non-root user on a POSIX filesystem.
const canRestrictModes = process.platform !== "win32" && process.getuid?.() !== 0;
const describeModes = canRestrictModes ? describe : describe.skip;

const GENERIC = "Mnemopi backend is not initialised for this session.";
const modelRegistry = { getApiKeyForProvider: async () => undefined, resolver: () => async () => undefined };

let temp: TempDir;
let agentDir: string;
let dbDir: string;
let dbFile: string;
let started: object[] = [];

beforeEach(() => {
	temp = TempDir.createSync("@mnemopi-startup-visible-");
	agentDir = temp.path();
	dbDir = path.join(agentDir, "memories", "mnemopi");
	dbFile = path.join(dbDir, "mnemopi.db");
	started = [];
});

afterEach(async () => {
	for (const session of started) await getMnemopiSessionState(session as never)?.dispose({ consolidate: false });
	resetMemoryForTests();
	// A read-only folder or file cannot be removed with its parent.
	for (const entry of [dbDir, dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
		try {
			fs.chmodSync(entry, fs.statSync(entry).isDirectory() ? 0o700 : 0o644);
		} catch {}
	}
	temp.removeSync();
});

function makeSettings(): Settings {
	return Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		"mnemopi.scoping": "global",
		"mnemopi.bank": "default",
		"mnemopi.dbPath": dbFile,
	});
}

function fakeSession(id: string): object {
	const settings = makeSettings();
	return {
		sessionId: id,
		settings,
		modelRegistry,
		sessionManager: { getEntries: () => [], getCwd: () => agentDir },
		emitNotice: () => {},
		getHindsightSessionState: () => undefined,
		subscribe: () => () => {},
	};
}

async function start(
	session: object,
	extra: { taskDepth?: number; parentMnemopiStartupFailure?: MnemopiStartupFailure } = {},
): Promise<void> {
	started.push(session);
	await mnemopiBackend.start({
		session: session as never,
		settings: (session as { settings: Settings }).settings,
		modelRegistry: modelRegistry as never,
		agentDir,
		taskDepth: extra.taskDepth ?? 0,
		...(extra.parentMnemopiStartupFailure ? { parentMnemopiStartupFailure: extra.parentMnemopiStartupFailure } : {}),
	} as never);
}

/** Opens and closes one healthy session so the database, its `-wal` and `-shm` exist. */
async function seedDatabase(): Promise<void> {
	const seed = fakeSession("seed");
	await start(seed);
	expect(getMnemopiSessionState(seed as never)).toBeDefined();
	await getMnemopiSessionState(seed as never)?.dispose({ consolidate: false });
	started = started.filter(entry => entry !== seed);
	resetMemoryForTests();
}

/**
 * Leaves a read-only `-wal` with content beside the database. SQLite resets the mode of an empty
 * `-wal` to the database's mode each time it opens one, so only a `-wal` with content can block
 * the next start: the write to it fails with `SQLITE_IOERR_WRITE` ("disk I/O error").
 */
function leaveReadOnlyWal(wal: string): void {
	if (fs.existsSync(wal)) fs.chmodSync(wal, 0o644);
	fs.writeFileSync(wal, Buffer.alloc(64));
	fs.chmodSync(wal, 0o444);
}

function expectNoAbsolutePath(text: string): void {
	expect(text).not.toContain(agentDir);
	expect(text).not.toContain(fs.realpathSync(agentDir));
	const home = os.homedir();
	if (home.length > 1) expect(text).not.toContain(home);
	expect(text).not.toMatch(/(^|[\s'"(=])\/[\w.-]+\/[\w.-]/);
}

function toolSessionFor(session: object): ToolSession {
	return {
		cwd: agentDir,
		hasUI: false,
		settings: (session as { settings: Settings }).settings,
		getSessionFile: () => null,
		getSessionId: () => (session as { sessionId: string }).sessionId,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => getMnemopiSessionState(session as never),
		getMnemopiStartupFailure: () => getMnemopiStartupFailure(session),
	} as unknown as ToolSession;
}

function watch(session: object): MnemopiStartupFailure[] {
	const seen: MnemopiStartupFailure[] = [];
	watchMnemopiStartupFailure(session, failure => seen.push(failure));
	return seen;
}

describeModes("Mnemopi startup failure is visible", () => {
	it("starts normally with no failure and no warning", async () => {
		const session = fakeSession("normal");
		const seen = watch(session);
		await start(session);

		expect(getMnemopiSessionState(session as never)).toBeDefined();
		expect(getMnemopiStartupFailure(session)).toBeUndefined();
		expect(seen).toEqual([]);
	});

	it("keeps the generic sentence when no startup failure was recorded", () => {
		const session = fakeSession("never-started");
		expect(mnemopiNotInitialisedMessage(getMnemopiStartupFailure(session))).toBe(GENERIC);
		expect(mnemopiNotInitialisedMessage(undefined)).toBe(GENERIC);
	});

	it("remembers why a read-only database in a read-only folder cannot start (444 and 555)", async () => {
		await seedDatabase();
		fs.chmodSync(dbFile, 0o444);
		fs.chmodSync(dbDir, 0o555);

		const session = fakeSession("readonly-db");
		const seen = watch(session);
		await start(session);

		expect(getMnemopiSessionState(session as never)).toBeUndefined();
		const failure = getMnemopiStartupFailure(session);
		expect(failure).toBeDefined();
		expect(failure?.errorClass).toBe("SQLiteError");
		expect(failure?.code).toBe("SQLITE_READONLY");
		expect(failure?.message).toMatch(/readonly/i);
		expect(failure?.file).toBe("memories/mnemopi/mnemopi.db");
		expect(failure?.notWritable).toContain("memories/mnemopi");
		expect(failure?.notWritable).toContain("memories/mnemopi/mnemopi.db");

		const text = formatMnemopiStartupFailure(failure!);
		expect(text).toContain("SQLITE_READONLY");
		expect(text).toContain("memories/mnemopi/mnemopi.db");
		expectNoAbsolutePath(text);
		// Surfaced exactly once, with the same reason the session remembers.
		expect(seen).toEqual([failure!]);
		expectNoAbsolutePath(mnemopiStartupNotice(failure!));
		// Reporting only: a failed start never edits a mode.
		expect(fs.statSync(dbFile).mode & 0o777).toBe(0o444);
		expect(fs.statSync(dbDir).mode & 0o777).toBe(0o555);
	});

	it("remembers why a read-only folder with no database yet cannot start (555)", async () => {
		fs.mkdirSync(dbDir, { recursive: true });
		fs.chmodSync(dbDir, 0o555);

		const session = fakeSession("readonly-folder");
		const seen = watch(session);
		await start(session);

		expect(getMnemopiSessionState(session as never)).toBeUndefined();
		const failure = getMnemopiStartupFailure(session);
		expect(failure?.errorClass).toBe("SQLiteError");
		expect(failure?.code).toBe("SQLITE_CANTOPEN");
		expect(failure?.file).toBe("memories/mnemopi/mnemopi.db");
		expect(failure?.notWritable).toEqual(["memories/mnemopi"]);
		expect(seen).toHaveLength(1);
		expectNoAbsolutePath(formatMnemopiStartupFailure(failure!));
	});

	it("names a -wal left read-only when the database and folder are writable again", async () => {
		await seedDatabase();
		const wal = `${dbFile}-wal`;
		// Session 1: a read-only database in a read-only folder. SQLite copies the database's
		// read-only mode onto the -wal it keeps beside it.
		fs.chmodSync(dbFile, 0o444);
		fs.chmodSync(dbDir, 0o555);
		const first = fakeSession("wal-first");
		await start(first);
		expect(getMnemopiStartupFailure(first)?.code).toBe("SQLITE_READONLY");

		// The operator restores the database and the folder; the -wal stays 444.
		fs.chmodSync(dbDir, 0o700);
		fs.chmodSync(dbFile, 0o644);
		leaveReadOnlyWal(wal);

		const second = fakeSession("wal-second");
		const seen = watch(second);
		await start(second);

		expect(getMnemopiSessionState(second as never)).toBeUndefined();
		const failure = getMnemopiStartupFailure(second);
		expect(failure?.errorClass).toBe("SQLiteError");
		expect(failure?.code).toMatch(/^SQLITE_(IOERR|READONLY|BUSY|CANTOPEN)/);
		// The database and the folder are fine now; only the sidecar is named.
		expect(failure?.file).toBe("memories/mnemopi/mnemopi.db");
		expect(failure?.notWritable).toEqual(["memories/mnemopi/mnemopi.db-wal"]);
		const text = formatMnemopiStartupFailure(failure!);
		expect(text).toContain("mnemopi.db-wal");
		expect(text).toMatch(/not writable: memories\/mnemopi\/mnemopi\.db-wal/);
		expectNoAbsolutePath(text);
		expect(seen).toHaveLength(1);
		// Reporting only: the database and folder modes are the ones the operator set.
		expect(fs.statSync(dbFile).mode & 0o777).toBe(0o644);
		expect(fs.statSync(dbDir).mode & 0o777).toBe(0o700);
	});

	it("a later successful start clears the remembered failure without warning again", async () => {
		await seedDatabase();
		const wal = `${dbFile}-wal`;
		leaveReadOnlyWal(wal);

		const session = fakeSession("recovers");
		const seen = watch(session);
		await start(session);
		expect(getMnemopiStartupFailure(session)).toBeDefined();
		expect(seen).toHaveLength(1);

		fs.chmodSync(wal, 0o644);
		await start(session);

		expect(getMnemopiSessionState(session as never)).toBeDefined();
		expect(getMnemopiStartupFailure(session)).toBeUndefined();
		expect(mnemopiNotInitialisedMessage(getMnemopiStartupFailure(session))).toBe(GENERIC);
		expect(seen).toHaveLength(1);
	});

	it("names the cause in every memory tool and backend result instead of the generic sentence", async () => {
		await seedDatabase();
		fs.chmodSync(dbFile, 0o444);
		fs.chmodSync(dbDir, 0o555);
		const session = fakeSession("tools");
		await start(session);
		const toolSession = toolSessionFor(session);
		const reason =
			/^Mnemopi backend is not initialised for this session\. Startup failed: .*SQLITE_READONLY.*memories\/mnemopi\/mnemopi\.db/s;

		const failures = [
			new MemoryRetainTool(toolSession).execute("t", { items: [{ content: "remember this" }] } as never),
			new MemoryRecallTool(toolSession).execute("t", { query: "anything" } as never),
			new MemoryReflectTool(toolSession).execute("t", { query: "anything" } as never),
			new MemoryEditTool(toolSession).execute("t", { op: "forget", id: "missing" } as never),
			new LearnTool(toolSession).execute("t", { memory: "a durable lesson" } as never),
		];
		for (const call of failures) {
			const error = await call.then(
				() => undefined,
				(caught: unknown) => caught as Error,
			);
			expect(error?.message).toMatch(reason);
			expectNoAbsolutePath(error!.message);
		}

		const context = { agentDir, cwd: agentDir, session } as never;
		const status = await mnemopiBackend.status!(context);
		const search = await mnemopiBackend.search!(context, "anything");
		const save = await mnemopiBackend.save!(context, { content: "remember this" });
		for (const message of [status.message, search.message, save.message]) {
			expect(message).toMatch(reason);
		}
	});

	it("a child session inherits the parent's reason and does not warn again", async () => {
		await seedDatabase();
		fs.chmodSync(dbFile, 0o444);
		fs.chmodSync(dbDir, 0o555);
		const parent = fakeSession("parent");
		await start(parent);
		const parentFailure = getMnemopiStartupFailure(parent);
		expect(parentFailure).toBeDefined();

		const child = fakeSession("child");
		const seen = watch(child);
		await start(child, { taskDepth: 1, parentMnemopiStartupFailure: parentFailure });

		expect(getMnemopiSessionState(child as never)).toBeUndefined();
		const inherited = getMnemopiStartupFailure(child);
		expect(inherited).toMatchObject({
			errorClass: parentFailure!.errorClass,
			code: parentFailure!.code,
			message: parentFailure!.message,
			file: parentFailure!.file,
			notWritable: parentFailure!.notWritable,
			inherited: true,
		});
		expect(mnemopiNotInitialisedMessage(inherited)).toMatch(/SQLITE_READONLY/);
		expect(mnemopiNotInitialisedMessage(inherited)).toContain("parent session");
		// Only the top-level session is surfaced at startup; a child is never announced again.
		expect(seen).toEqual([]);
	});

	it("a child of a session with no Mnemopi failure records nothing", async () => {
		const child = fakeSession("orphan-child");
		await start(child, { taskDepth: 1 });
		expect(getMnemopiSessionState(child as never)).toBeUndefined();
		expect(getMnemopiStartupFailure(child)).toBeUndefined();
		expect(mnemopiNotInitialisedMessage(getMnemopiStartupFailure(child))).toBe(GENERIC);
	});
});

describe("Mnemopi startup failure record", () => {
	const failure = (message: string): MnemopiStartupFailure => ({
		errorClass: "SQLiteError",
		code: "SQLITE_READONLY",
		message,
		file: "memories/mnemopi/mnemopi.db",
		notWritable: [],
	});

	it("replays a failure recorded before the watcher attached, once, and skips an identical repeat", () => {
		const session = {};
		recordMnemopiStartupFailure(session, failure("first"));
		const seen = watch(session);
		expect(seen).toEqual([failure("first")]);

		recordMnemopiStartupFailure(session, failure("first"));
		expect(seen).toHaveLength(1);
		recordMnemopiStartupFailure(session, failure("second"));
		expect(seen.map(entry => entry.message)).toEqual(["first", "second"]);
	});

	it("stops delivering after the watcher is removed", () => {
		const session = {};
		const seen: MnemopiStartupFailure[] = [];
		const stop = watchMnemopiStartupFailure(session, entry => seen.push(entry));
		stop();
		recordMnemopiStartupFailure(session, failure("late"));
		expect(seen).toEqual([]);
		expect(getMnemopiStartupFailure(session)?.message).toBe("late");
	});

	it("keeps a throwing watcher from breaking the others or the recording", () => {
		const session = {};
		const seen: MnemopiStartupFailure[] = [];
		watchMnemopiStartupFailure(session, () => {
			throw new Error("watcher failed");
		});
		watchMnemopiStartupFailure(session, entry => seen.push(entry));
		recordMnemopiStartupFailure(session, failure("still delivered"));
		expect(seen).toHaveLength(1);
	});

	it("describes an error with class, code and a message free of absolute paths", () => {
		const agent = path.join(os.tmpdir(), "someone", ".omp", "agent");
		const error = Object.assign(
			new Error(
				`EACCES: permission denied, mkdir '${path.join(agent, "memories", "mnemopi")}' then open '/etc/shadow-like/x.db'`,
			),
			{ code: "EACCES" },
		);
		const described = describeMnemopiStartupFailure(error, {
			agentDir: agent,
			dbPaths: [path.join(agent, "memories", "mnemopi", "mnemopi.db")],
		});

		expect(described.errorClass).toBe("Error");
		expect(described.code).toBe("EACCES");
		expect(described.file).toBe("memories/mnemopi/mnemopi.db");
		expect(described.message).toContain("<agent dir>/memories/mnemopi");
		expect(described.message).not.toContain("someone");
		expect(described.message).not.toContain("/etc/");
		expect(described.message).not.toContain("\n");
		expect(described.message.length).toBeLessThanOrEqual(240);
	});

	it("shows a database outside the agent dir by file name only", () => {
		const outside = path.join(os.tmpdir(), "elsewhere", "custom.db");
		const described = describeMnemopiStartupFailure(new Error("boom"), {
			agentDir: path.join(os.tmpdir(), "agent-root"),
			dbPaths: [outside],
		});
		expect(described.file).toBe("<outside agent dir>/custom.db");
		expect(JSON.stringify(described)).not.toContain("elsewhere");
	});

	it("describes a thrown non-error value", () => {
		const described = describeMnemopiStartupFailure("plain string failure", { agentDir: "/agent", dbPaths: [] });
		expect(described.errorClass).toBe("string");
		expect(described.message).toBe("plain string failure");
		expect(described.file).toBeUndefined();
		expect(described.notWritable).toEqual([]);
	});
});
