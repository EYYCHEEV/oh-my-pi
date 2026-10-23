import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clipRecallContent } from "@oh-my-pi/pi-mnemopi";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

// Embeddings install on demand; these tests never need vectors.
beforeEach(() => {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

const closers: (() => void)[] = [];

afterEach(() => {
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
	delete process.env.MNEMOPI_POLYPHONIC_RECALL;
	while (closers.length > 0) closers.pop()?.();
});

function makeMemory(): Mnemopi {
	const memory = new Mnemopi({ sessionId: "preview", dbPath: ":memory:", noEmbeddings: true });
	closers.push(() => memory.close());
	return memory;
}

const FILLER = "Routine status line about nothing in particular. ";
const NEEDLE = "The vault passphrase rotation owner is Marguerite Okonkwo.";

/** `before` characters of filler, the needle, then `after` characters of filler. */
function buried(before: number, after: number): string {
	return `${FILLER.repeat(Math.ceil(before / FILLER.length)).slice(0, before)}${NEEDLE} ${FILLER.repeat(Math.ceil(after / FILLER.length)).slice(0, after)}`;
}

describe("recall preview shows the part of the row that matched", () => {
	it("centres the preview on a fact buried deep in a long row, within the length budget", async () => {
		const memory = makeMemory();
		const content = buried(2500, 2500);
		memory.remember(content, { source: "note" });

		const [hit] = await memory.beam.recall("who owns the vault passphrase rotation", 3);

		expect(hit?.content).toContain("Marguerite Okonkwo");
		expect(hit?.content.length).toBeLessThanOrEqual(500);
		expect(hit?.content.startsWith("…")).toBe(true);
		expect(hit?.content.endsWith("…")).toBe(true);
		expect(hit?.truncated).toBe(true);
		expect(hit?.full_length).toBe(content.length);
	});

	it("keeps the head preview when the match is already in it", async () => {
		const memory = makeMemory();
		const content = `${NEEDLE} ${FILLER.repeat(40)}`;
		memory.remember(content, { source: "note" });

		const [hit] = await memory.beam.recall("who owns the vault passphrase rotation", 3);

		expect(hit?.content).toBe(`${content.slice(0, 499)}…`);
	});

	it("shows the tail when the match is at the end of the row", async () => {
		const memory = makeMemory();
		const content = buried(3000, 0);
		memory.remember(content, { source: "note" });

		const [hit] = await memory.beam.recall("vault passphrase rotation owner", 3);

		expect(hit?.content).toContain("Marguerite Okonkwo");
		expect(hit?.content.startsWith("…")).toBe(true);
		expect(hit?.content.endsWith("…")).toBe(false);
		expect(hit?.content.length).toBeLessThanOrEqual(500);
	});

	it("honours a caller-supplied preview cap on the centred window", async () => {
		const memory = makeMemory();
		memory.remember(buried(2000, 2000), { source: "note" });

		const [hit] = await memory.beam.recall("vault passphrase rotation owner", 3, { contentPreviewChars: 120 });

		expect(hit?.content.length).toBeLessThanOrEqual(120);
		expect(hit?.content).toContain("passphrase");
	});

	it("prefers the window around a rare query term over one around a term that is everywhere", async () => {
		const memory = makeMemory();
		// The head holds only the common term `status`; the specific term `quokka` occurs once, deep inside.
		const content = `${"Status update. ".repeat(60)}${FILLER.repeat(20)}The quokka migration owner is Dana Whitfield. ${FILLER.repeat(20)}`;
		memory.remember(content, { source: "note" });

		const [hit] = await memory.beam.recall("status quokka", 3);

		expect(hit?.content).toContain("Dana Whitfield");
	});

	it("covers several query terms with one window when they sit together", async () => {
		const memory = makeMemory();
		const content = `${FILLER.repeat(30)}Quokka migration freezes on Friday. Zebrafox rollout follows on Monday. ${FILLER.repeat(30)}`;
		memory.remember(content, { source: "note" });

		const [hit] = await memory.beam.recall("quokka zebrafox", 3);

		expect(hit?.content).toContain("Quokka migration");
		expect(hit?.content).toContain("Zebrafox rollout");
	});

	it("centres the preview on the polyphonic recall path too", async () => {
		process.env.MNEMOPI_POLYPHONIC_RECALL = "1";
		const memory = makeMemory();
		memory.remember(buried(2500, 2500), { source: "note" });

		const hits = await memory.beam.recallEnhanced("who owns the vault passphrase rotation", 3);

		expect(hits[0]?.content).toContain("Marguerite Okonkwo");
		expect(hits[0]?.content.length).toBeLessThanOrEqual(500);
	});

	it("clips around the given query terms and falls back to the head without a match", () => {
		const content = `${FILLER.repeat(30)}Needle fact here. ${FILLER.repeat(30)}`;

		expect(clipRecallContent(content, 200, [["needle"]]).content).toContain("Needle fact here");
		expect(clipRecallContent(content, 200, [["absent"]]).content).toBe(`${content.slice(0, 199)}…`);
		expect(clipRecallContent(content, 200).content).toBe(`${content.slice(0, 199)}…`);
		expect(clipRecallContent("short", 200, [["short"]])).toEqual({
			content: "short",
			truncated: false,
			fullLength: 5,
		});
	});
});
