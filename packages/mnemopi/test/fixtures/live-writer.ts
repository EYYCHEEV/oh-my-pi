/**
 * A separate process that keeps writing one Mnemopi database, the way a hand session does while a
 * bot's backup runs. argv[2] is the database path, argv[3] a marker file written once at least
 * `MIN_ROWS` rows are committed. It writes until the parent kills it.
 */
import { writeFileSync } from "node:fs";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";

const MIN_ROWS = 50;
const [dbPath, marker] = process.argv.slice(2);
if (!dbPath || !marker) throw new Error("usage: live-writer.ts <dbPath> <marker>");

const beam = new BeamMemory({ sessionId: "live-writer", dbPath });
for (let row = 1; ; row++) {
	beam.remember(`live row ${row}`, { source: "live-writer", importance: 0.5 });
	if (row === MIN_ROWS) writeFileSync(marker, String(row));
	// Yield so the parent's reads and signals are served while rows keep arriving.
	if (row % 10 === 0) await Bun.sleep(1);
}
