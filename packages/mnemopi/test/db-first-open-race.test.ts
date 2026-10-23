import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";

const WORKERS = 6;
const SLOTS = 12;
const SLOT_MS = 100;

// Real processes, not threads or promises: the race is between SQLite connections on one file.
// Every worker walks the same wall-clock slots and opens that slot's fresh bank database at the
// slot's start, so each slot is one first-creation race between WORKERS sessions. A failed open is
// what leaves a session memory-inert, so it is reported with the slot it failed in.
const WORKER = `
import { join } from "node:path";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const { OPEN_RACE_DIR, OPEN_RACE_START_AT, OPEN_RACE_SLOTS, OPEN_RACE_SLOT_MS } = process.env;
const failures = [];
for (let slot = 0; slot < Number(OPEN_RACE_SLOTS); slot++) {
	while (Date.now() < Number(OPEN_RACE_START_AT) + slot * Number(OPEN_RACE_SLOT_MS)) {
		// spin until the slot starts
	}
	try {
		const db = openDatabase(join(OPEN_RACE_DIR, "bank-" + slot, "mnemopi.db"));
		db.exec("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, content TEXT)");
		db.run("INSERT INTO memories (content) VALUES (?)", ["written by " + process.pid]);
		db.close();
	} catch (error) {
		failures.push("slot " + slot + ": " + (error instanceof Error ? error.message : String(error)));
	}
}
console.log(JSON.stringify(failures));
`;

describe("sessions creating the same bank database at the same moment", () => {
	it("all open it and write: none runs memory-inert on 'database is locked'", async () => {
		using root = TempDir.createSync("@mnemopi-open-race-");
		const startAt = String(Date.now() + 1000);
		const children = Array.from({ length: WORKERS }, () =>
			Bun.spawn([process.execPath, "-e", WORKER], {
				cwd: import.meta.dir,
				env: {
					...process.env,
					OPEN_RACE_DIR: root.path(),
					OPEN_RACE_START_AT: startAt,
					OPEN_RACE_SLOTS: String(SLOTS),
					OPEN_RACE_SLOT_MS: String(SLOT_MS),
				},
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const outputs = await Promise.all(children.map(child => new Response(child.stdout).text()));
		await Promise.all(children.map(child => child.exited));

		const failures = outputs.flatMap(output => JSON.parse(output.trim()) as string[]);
		expect(failures).toEqual([]);
		expect(outputs).toHaveLength(WORKERS);
	}, 60_000);
});
