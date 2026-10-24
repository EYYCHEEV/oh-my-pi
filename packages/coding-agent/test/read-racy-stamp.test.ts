import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { isRacyStat, RACY_STAMP_WINDOW_MS } from "@oh-my-pi/pi-coding-agent/tools/racy-stamp";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import * as archives from "@oh-my-pi/pi-utils/ar";

/**
 * Fork-owned. Linux file times come from a coarse kernel clock (a tick of a few milliseconds), so a rewrite in
 * the same tick as a cached open leaves the inode, size, mtime and ctime unchanged and the stale archive reader is
 * returned. The read tool therefore never caches a stamp whose change time is younger than the racy window
 * (git's racy-clean rule, as grep.ts already does). macOS timestamps are nanosecond-fine, so none of this can go
 * red there on its own: the clock tests below pin `Date.now`, and one test sticks the file clock to one tick.
 *
 * The seek identity in read.ts (`SeekFileIdentity`) is deliberately not covered: it is built and consumed inside one
 * `execute` call (`resolveFileTailSelector` then `streamLinesFromFile`) and never outlives it, so it cannot go
 * stale between tool calls.
 */

const WINDOW_MS = 2_000;

function createSession(cwd: string): ToolSession {
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			fs.mkdirSync(sessionDir, { recursive: true });
			return { id: "1", path: path.join(sessionDir, `1.${toolType}.log`) };
		},
		settings: Settings.isolated(),
	};
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

async function writeZip(archivePath: string, entries: Record<string, string>): Promise<void> {
	fs.writeFileSync(archivePath, await archives.encodeArchive("zip", Object.entries(entries)));
}

describe("racy stat rule", () => {
	it("calls a stat racy while its change time is inside the window, whichever of mtime and ctime is newer", () => {
		const now = 1_700_000_000_000;
		expect(RACY_STAMP_WINDOW_MS).toBe(WINDOW_MS);
		expect(isRacyStat({ mtimeMs: now, ctimeMs: now }, now)).toBe(true);
		expect(isRacyStat({ mtimeMs: now - WINDOW_MS + 1, ctimeMs: now - WINDOW_MS + 1 }, now)).toBe(true);
		expect(isRacyStat({ mtimeMs: now - WINDOW_MS, ctimeMs: now - WINDOW_MS }, now)).toBe(false);
		expect(isRacyStat({ mtimeMs: now - 60_000, ctimeMs: now - 60_000 }, now)).toBe(false);
		// Either time can be the recent one: a restored mtime hides a fresh ctime, a touch hides an old ctime.
		expect(isRacyStat({ mtimeMs: now - 60_000, ctimeMs: now - 10 }, now)).toBe(true);
		expect(isRacyStat({ mtimeMs: now - 10, ctimeMs: now - 60_000 }, now)).toBe(true);
	});

	it("treats a future-dated or unreadable stamp as racy, and defaults to the current time", () => {
		const now = 1_700_000_000_000;
		expect(isRacyStat({ mtimeMs: now + 5_000, ctimeMs: now + 5_000 }, now)).toBe(true);
		expect(isRacyStat({ mtimeMs: Number.NaN, ctimeMs: Number.NaN }, now)).toBe(true);
		expect(isRacyStat({ mtimeMs: now - 60_000, ctimeMs: Number.NaN }, now)).toBe(true);
		const spy = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			expect(isRacyStat({ mtimeMs: now - 10, ctimeMs: now - 10 })).toBe(true);
			expect(isRacyStat({ mtimeMs: now - 60_000, ctimeMs: now - 60_000 })).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("read tool archive cache", () => {
	let testDir: string;
	let readTool: ReadTool;
	let nowSpy: Mock<typeof Date.now> | undefined;
	let openSpy: Mock<typeof archives.openArchive>;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-racy-stamp-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		readTool = wrapToolWithMetaNotice(new ReadTool(createSession(testDir)));
		openSpy = vi.spyOn(archives, "openArchive");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		nowSpy = undefined;
		removeSyncWithRetries(testDir);
	});

	/** Pin `Date.now` to `afterMs` past the file's change time, so "just written" and "old" never depend on machine speed. */
	function pinClock(file: string, afterMs: number): void {
		const stat = fs.statSync(file);
		nowSpy?.mockRestore();
		nowSpy = vi.spyOn(Date, "now").mockReturnValue(Math.ceil(Math.max(stat.mtimeMs, stat.ctimeMs)) + afterMs);
	}

	/** A file clock stuck in one tick: every stat of `file` reports the same mtime and ctime, as a coarse Linux clock does. */
	function stickFileClock(file: string, tick: number): void {
		const realFile = Bun.file.bind(Bun) as (target: unknown, ...rest: unknown[]) => Bun.BunFile;
		vi.spyOn(Bun, "file").mockImplementation(((target: unknown, ...rest: unknown[]) => {
			const handle = realFile(target, ...rest);
			if (String(target) !== file) return handle;
			return new Proxy(handle, {
				get(owner, key) {
					if (key === "stat") {
						return async () =>
							new Proxy(await owner.stat(), {
								get(stat, field) {
									if (field === "mtimeMs" || field === "ctimeMs") return tick;
									const member = Reflect.get(stat, field, stat);
									return typeof member === "function" ? member.bind(stat) : member;
								},
							});
					}
					const value = Reflect.get(owner, key, owner);
					return typeof value === "function" ? value.bind(owner) : value;
				},
			});
		}) as typeof Bun.file);
	}

	let calls = 0;
	async function read(archivePath: string, member = ""): Promise<string> {
		const target = member ? `${archivePath}:${member}` : archivePath;
		return textOf(await readTool.execute(`call-${++calls}`, { path: target }));
	}

	it("does not cache an archive that changed just now: two reads in a row both open it", async () => {
		const archivePath = path.join(testDir, "fresh.zip");
		await writeZip(archivePath, { "alpha.txt": "first\n" });
		pinClock(archivePath, 50);

		expect(await read(archivePath)).toContain("alpha.txt");
		expect(await read(archivePath)).toContain("alpha.txt");
		expect(openSpy).toHaveBeenCalledTimes(2);
	});

	it("re-reads a same-size rewrite that a coarse file clock stamps in the same tick", async () => {
		const archivePath = path.join(testDir, "coarse.zip");
		await writeZip(archivePath, { "alpha.txt": "first\n" });
		const sizeBefore = fs.statSync(archivePath).size;
		const tick = Date.now();
		stickFileClock(archivePath, tick);
		nowSpy = vi.spyOn(Date, "now").mockReturnValue(tick + 50);

		expect(await read(archivePath)).toContain("alpha.txt");
		// Same inode, same size, same mtime and ctime: nothing in the stamp can show this rewrite.
		await writeZip(archivePath, { "bravo.txt": "other\n" });
		expect(fs.statSync(archivePath).size).toBe(sizeBefore);
		const output = await read(archivePath);

		expect(output).toContain("bravo.txt");
		expect(output).not.toContain("alpha.txt");
	});

	it("caches an archive whose last change is older than the window: paging through members opens it once", async () => {
		const archivePath = path.join(testDir, "old.zip");
		await writeZip(archivePath, { "alpha.txt": "first\n", "bravo.txt": "second\n" });
		pinClock(archivePath, WINDOW_MS + 1);

		expect(await read(archivePath)).toContain("alpha.txt");
		expect(await read(archivePath, "alpha.txt")).toContain("first");
		expect(await read(archivePath, "bravo.txt")).toContain("second");
		expect(openSpy).toHaveBeenCalledTimes(1);
	});

	it("still sees a rewrite of a cached archive once the stamp changes", async () => {
		const archivePath = path.join(testDir, "rewritten.zip");
		const pinned = new Date("2024-01-01T00:00:00Z");
		await writeZip(archivePath, { "alpha.txt": "first\n" });
		pinClock(archivePath, 10_000);
		expect(await read(archivePath)).toContain("alpha.txt");
		expect(openSpy).toHaveBeenCalledTimes(1);

		await writeZip(archivePath, { "bravo.txt": "other\n" });
		fs.utimesSync(archivePath, pinned, pinned);
		pinClock(archivePath, 10_000);
		const output = await read(archivePath);

		expect(output).toContain("bravo.txt");
		expect(output).not.toContain("alpha.txt");
		expect(openSpy).toHaveBeenCalledTimes(2);
	});

	it("stores nothing for a racy stat: reads inside the window open the archive each time, and caching resumes once it is old", async () => {
		const archivePath = path.join(testDir, "lifecycle.zip");
		await writeZip(archivePath, { "alpha.txt": "first\n" });
		pinClock(archivePath, 10_000);
		await read(archivePath);
		await read(archivePath);
		expect(openSpy).toHaveBeenCalledTimes(1); // old enough: stored, then reused

		// A rewrite inside the window: seen, and not stored, so the read after it opens the archive again.
		await writeZip(archivePath, { "bravo.txt": "other\n" });
		pinClock(archivePath, 50);
		expect(await read(archivePath)).toContain("bravo.txt");
		expect(openSpy).toHaveBeenCalledTimes(2);
		expect(await read(archivePath)).toContain("bravo.txt");
		expect(openSpy).toHaveBeenCalledTimes(3);

		// Once the new stamp is old enough the archive is cached again.
		pinClock(archivePath, WINDOW_MS + 1);
		await read(archivePath);
		await read(archivePath);
		expect(openSpy).toHaveBeenCalledTimes(4);
	});

	it("drops the entry of a rewritten archive, so a dead entry does not push a live archive out of the cache", async () => {
		// The cache holds 4 archives. A rewrite leaves the old entry unmatched for good: only dropping it frees its slot.
		const names = ["a", "b", "c", "d", "e"].map(name => path.join(testDir, `${name}.zip`));
		for (const [index, name] of names.entries()) await writeZip(name, { [`member-${index}.txt`]: "x\n" });
		const [a, b, c, d, e] = names;
		pinClock(e, 10_000);
		for (const name of [a, b, c, d]) await read(name);
		expect(openSpy).toHaveBeenCalledTimes(4);

		await writeZip(a, { "rewritten.txt": "y\n" });
		pinClock(a, 50);
		expect(await read(a)).toContain("rewritten.txt");
		expect(openSpy).toHaveBeenCalledTimes(5);

		pinClock(a, 10_000);
		await read(e);
		expect(openSpy).toHaveBeenCalledTimes(6);
		await read(b); // still cached: the dead entry of `a` took no slot
		expect(openSpy).toHaveBeenCalledTimes(6);
	});
});
