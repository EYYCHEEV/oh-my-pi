/**
 * `mnemopi backup <file>` writes a consistent, standalone copy of one database while another
 * process is writing it. A plain copy of the main file cannot: committed rows live in the `-wal`
 * file until a checkpoint, and a copy taken mid-write can tear.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@oh-my-pi/pi-mnemopi/cli";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";

const WRITER = join(import.meta.dir, "fixtures", "live-writer.ts");
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-live-backup-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function capture() {
	let stdout = "";
	let stderr = "";
	return {
		context(dbPath: string) {
			return {
				dbPath,
				stdout: { write: (data: string) => (stdout += data) },
				stderr: { write: (data: string) => (stderr += data) },
			};
		},
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

async function startWriter(dbPath: string, dir: string): Promise<Bun.Subprocess> {
	const marker = join(dir, "writer-ready");
	const child = Bun.spawn([process.execPath, WRITER, dbPath, marker], {
		env: { ...process.env, MNEMOPI_NO_EMBEDDINGS: "1" },
		stdout: "ignore",
		stderr: "pipe",
	});
	cleanups.push(() => child.kill("SIGKILL"));
	const deadline = performance.now() + 20_000;
	while (!existsSync(marker)) {
		if (child.exitCode !== null) throw new Error(`writer exited early: ${await new Response(child.stderr).text()}`);
		if (performance.now() > deadline) throw new Error("writer never became ready");
		await Bun.sleep(20);
	}
	return child;
}

/** The numbers N of every `live row N` in a backup. A consistent snapshot of the writer is 1..max. */
function liveRowNumbers(path: string): number[] {
	const db = new Database(path, { readonly: true });
	try {
		const rows = db.query("SELECT content FROM working_memory").all() as { content: string }[];
		return rows.map(row => Number(/live row (\d+)/.exec(row.content)?.[1])).sort((a, b) => a - b);
	} finally {
		db.close();
	}
}

function integrity(path: string): string {
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
	} finally {
		db.close();
	}
}

describe("mnemopi backup", () => {
	it("copies a database another process is writing into a consistent standalone file", async () => {
		const dir = tempDir();
		const dbPath = join(dir, "bot", "mnemopi.db");
		const backupPath = join(dir, "snapshots", "bot-1.db");
		await startWriter(dbPath, dir);

		const io = capture();
		const code = await runCli(["backup", backupPath], io.context(dbPath));

		expect(io.stderr).toBe("");
		expect(code).toBe(0);
		expect(io.stdout).toContain(backupPath);
		expect(integrity(backupPath)).toBe("ok");
		const numbers = liveRowNumbers(backupPath);
		expect(numbers.length).toBeGreaterThanOrEqual(50);
		// The writer commits one row at a time, so any consistent snapshot is a prefix 1..N.
		expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => index + 1));
		// Standalone: nothing to carry alongside the file.
		expect(existsSync(`${backupPath}-wal`)).toBe(false);
		expect(existsSync(`${backupPath}-shm`)).toBe(false);

		// The copy is a working Mnemopi database.
		const restored = new BeamMemory({ sessionId: "live-writer", dbPath: backupPath });
		try {
			expect((await restored.recall("live row 7", 3)).length).toBeGreaterThan(0);
		} finally {
			restored.close();
		}
	});

	it("copies a database whose writer was killed without a checkpoint", async () => {
		const dir = tempDir();
		const dbPath = join(dir, "mnemopi.db");
		const writer = await startWriter(dbPath, dir);
		writer.kill("SIGKILL");
		await writer.exited;

		const backupPath = join(dir, "after-crash.db");
		const io = capture();
		expect(await runCli(["backup", backupPath], io.context(dbPath))).toBe(0);

		expect(integrity(backupPath)).toBe("ok");
		const numbers = liveRowNumbers(backupPath);
		expect(numbers.length).toBeGreaterThanOrEqual(50);
		expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => index + 1));
	});

	it("never overwrites an existing file and leaves no partial copy behind", async () => {
		const dir = tempDir();
		const dbPath = join(dir, "mnemopi.db");
		const memory = new BeamMemory({ sessionId: "s", dbPath });
		memory.remember("kept", { source: "test" });
		memory.close();
		const existing = join(dir, "existing.db");
		writeFileSync(existing, "do not touch");
		const io = capture();
		expect(await runCli(["backup", existing], io.context(dbPath))).toBe(1);

		expect(io.stderr).toContain("already exists");
		expect(readFileSync(existing, "utf8")).toBe("do not touch");
		expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("fails without creating anything when the database does not exist", async () => {
		const dir = tempDir();
		const backupPath = join(dir, "out", "backup.db");

		const io = capture();
		expect(await runCli(["backup", backupPath], io.context(join(dir, "missing.db")))).toBe(1);

		expect(io.stderr).toContain("Database not found");
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(join(dir, "missing.db"))).toBe(false);
	});

	it("explains usage when no destination is given", async () => {
		const io = capture();
		expect(await runCli(["backup"], io.context(join(tempDir(), "mnemopi.db")))).toBe(2);
		expect(io.stderr).toContain("Usage: mnemopi backup <destination.db>");
	});
});
