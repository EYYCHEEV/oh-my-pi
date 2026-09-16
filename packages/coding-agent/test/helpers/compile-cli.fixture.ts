import * as path from "node:path";
import { compileCodingAgent } from "../../scripts/compile-binary";

// Bun test owns a module resolver; compile the full graph in the same fresh
// process boundary as the production build instead of sharing that resolver.
const outfile = process.argv[2];
if (!outfile) throw new Error("Expected compiled CLI output path");
await compileCodingAgent({
	repoRoot: path.resolve(import.meta.dir, "../../../.."),
	entrypoint: path.resolve(import.meta.dir, "../../src/cli.ts"),
	outfile,
	transformersVersion: "0.0.0-test",
});
