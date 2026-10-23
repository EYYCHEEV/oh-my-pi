/**
 * A separate process that holds a read transaction on one Mnemopi database, the way a long hand
 * session reading memory does while a bot's startup prune compacts the file. argv[2] is the database
 * path, argv[3] a marker file written once the read snapshot is open. It holds it until the parent kills it.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

const [dbPath, marker] = process.argv.slice(2);
if (!dbPath || !marker) throw new Error("usage: prune-reader.ts <dbPath> <marker>");

const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout=5000");
db.exec("BEGIN");
const row = db.query("SELECT COUNT(*) AS rows FROM working_memory").get() as { rows: number };
writeFileSync(marker, String(row.rows));
await new Promise<never>(() => {});
