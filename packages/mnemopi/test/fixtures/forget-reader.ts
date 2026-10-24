/**
 * A separate process that holds a read transaction on one Mnemopi database, the way a hand session reading
 * memory does while a bot forgets: a checkpoint cannot truncate the write-ahead log past its snapshot.
 * argv[2] is the database path. It prints `ready` once the snapshot is open and holds it until the parent kills it.
 */
import { Database } from "bun:sqlite";

const [dbPath] = process.argv.slice(2);
if (!dbPath) throw new Error("usage: forget-reader.ts <dbPath>");

const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout=5000");
db.exec("BEGIN");
db.query("SELECT COUNT(*) AS rows FROM working_memory").get();
console.log("ready");
await new Promise<never>(() => {});
