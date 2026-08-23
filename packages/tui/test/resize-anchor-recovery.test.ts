import { expect, it } from "bun:test";
import { VirtualTerminal } from "./virtual-terminal";

function makeTerm(columns: number, rows: number): VirtualTerminal {
	return new VirtualTerminal(columns, rows, 2000);
}

function findRow(term: VirtualTerminal, prefix: string): number {
	return term.getViewport().findIndex(line => line.startsWith(prefix));
}

/** The anchor recovery formula under test: top = min(R, height - staleReflowedRows). */
function recoverTop(reported: number, staleReflowedRows: number, height: number): number {
	return Math.max(0, Math.min(reported, height - staleReflowedRows));
}

it("height shrink with blank rows below the viewport", () => {
	// Content occupies rows 0..8 (viewport 6..8), rows 9..11 erased blanks.
	const term = makeTerm(40, 12);
	term.write(`${Array.from({ length: 6 }, (_, i) => `hist-${i}`).join("\r\n")}\r\n`);
	term.write("VIEW-TOP\r\nVIEW-MID\r\nVIEW-BOT");
	term.write("\x1b[J"); // erase below (BCE blanks)
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);

	// Shrink by 3: exactly the blank rows. If the terminal clips blanks first, no push.
	term.resize(40, 9);
	expect(recoverTop(term.getCursor().row, 3, 9)).toBe(findRow(term, "VIEW-TOP"));

	// Shrink 2 more: now content must push into scrollback.
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	term.resize(40, 7);
	expect(recoverTop(term.getCursor().row, 3, 7)).toBe(findRow(term, "VIEW-TOP"));
});

it("recovery formula on full-screen height shrink", () => {
	const term = makeTerm(40, 12);
	term.write(`${Array.from({ length: 9 }, (_, i) => `hist-${i}`).join("\r\n")}\r\n`);
	term.write("VIEW-TOP\r\nVIEW-MID\r\nVIEW-BOT");
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	term.resize(40, 7);
	expect(recoverTop(term.getCursor().row, 3, 7)).toBe(findRow(term, "VIEW-TOP"));
});

it("recovery formula on combined width+height resize", () => {
	const term = makeTerm(40, 12);
	term.write(`hist-long-${"y".repeat(70)}\r\n`);
	term.write(`${Array.from({ length: 6 }, (_, i) => `hist-${i}`).join("\r\n")}\r\n`);
	// A viewport row that wraps at the new width (34 visible cells).
	const wide = `VIEW-TOP-${"z".repeat(25)}`;
	term.write(`${wide}\r\nVIEW-MID\r\nVIEW-BOT`);
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	term.resize(28, 8);
	// Stale viewport at width 28: wide(34) -> 2, mid -> 1, bot -> 1 = 4 rows.
	expect(recoverTop(term.getCursor().row, 4, 8)).toBe(findRow(term, "VIEW-TOP"));
});

it("recovery formula on width grow (unwrap)", () => {
	const term = makeTerm(30, 12);
	term.write(`hist-long-${"y".repeat(45)}\r\n`); // wraps to 2 rows at 30
	term.write(`${Array.from({ length: 4 }, (_, i) => `hist-${i}`).join("\r\n")}\r\n`);
	term.write("VIEW-TOP\r\nVIEW-MID\r\nVIEW-BOT");
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	term.resize(60, 12);
	expect(recoverTop(term.getCursor().row, 3, 12)).toBe(findRow(term, "VIEW-TOP"));
});

it("recovery formula across a multi-step drag with an alt-screen borrow", () => {
	const term = makeTerm(40, 12);
	term.write(`hist-long-${"y".repeat(70)}\r\n`);
	term.write(`${Array.from({ length: 6 }, (_, i) => `hist-${i}`).join("\r\n")}\r\n`);
	const wide = `VIEW-TOP-${"z".repeat(25)}`;
	term.write(`${wide}\r\nVIEW-MID\r\nVIEW-BOT`);
	term.write(`\x1b[${findRow(term, "VIEW-TOP") + 1};1H`);
	// Enter alt (saves main cursor), drag through several sizes, exit alt.
	term.write("\x1b[?1049h");
	term.resize(36, 11);
	term.write("\x1b[2J\x1b[HALT");
	term.resize(31, 9);
	term.write("\x1b[2J\x1b[HALT");
	term.resize(28, 8);
	term.write("\x1b[?1049l");
	// Stale viewport at width 28: 2 + 1 + 1 = 4 rows.
	expect(recoverTop(term.getCursor().row, 4, 8)).toBe(findRow(term, "VIEW-TOP"));
});
