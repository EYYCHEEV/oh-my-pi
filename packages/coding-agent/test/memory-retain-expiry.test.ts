/**
 * `retain` takes an optional `expires` (ISO date, ISO date-time or duration) that becomes the memory's
 * `valid_until`: recall returns the memory until then and skips it afterwards.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { closeMnemopiStates, startMnemopiState } from "./helpers/mnemopi-state";

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(async () => {
	setSystemTime();
	await closeMnemopiStates();
});

function retain(tools: ToolSession, ...items: Array<{ content: string; expires?: string }>) {
	// Direct `execute` calls skip schema validation, which is exactly what a hand-written client does.
	return MemoryRetainTool.createIf(tools)!.execute("retain", { items } as never);
}

async function recalledContents(state: MnemopiSessionState, query: string): Promise<string[]> {
	return ((await state.recallResultsScoped(query)) ?? []).map(result => result.content);
}

function validUntilOf(state: MnemopiSessionState, needle: string): string | null {
	const { beam } = state.getScopedRecallTargets()[0].memory;
	const row = beam.db.query("SELECT valid_until FROM working_memory WHERE content LIKE ?").get(`%${needle}%`) as {
		valid_until: string | null;
	} | null;
	if (row === null) throw new Error(`no stored memory contains ${needle}`);
	return row.valid_until;
}

describe("retain expires", () => {
	it("hides a memory from recall once its duration has passed, and keeps it until then", async () => {
		const { state, tools } = startMnemopiState();
		await retain(tools, { content: "The staging freeze runs through the release train", expires: "2d" });
		await retain(tools, { content: "The release train owner is Priya" });

		expect(await recalledContents(state, "release train")).toHaveLength(2);

		setSystemTime(new Date(Date.now() + 3 * DAY_MS));
		expect(await recalledContents(state, "release train")).toEqual(["The release train owner is Priya"]);
	});

	it("stores a duration as an absolute UTC timestamp counted from now", async () => {
		const { state, tools } = startMnemopiState();
		const before = Date.now();
		await retain(tools, { content: "Deploy window probe thirty days", expires: "30d" });
		const stored = Date.parse(validUntilOf(state, "thirty days") ?? "");
		expect(stored).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
		expect(stored).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
	});

	it("stores a bare date as the end of that UTC day and an offset date-time as UTC", async () => {
		const { state, tools } = startMnemopiState();
		const day = new Date(Date.now() + 10 * DAY_MS).toISOString().slice(0, 10);
		await retain(
			tools,
			{ content: "Bare date probe", expires: day },
			{ content: "Offset probe", expires: "2099-01-01T00:00:00+02:00" },
		);
		expect(validUntilOf(state, "Bare date probe")).toBe(`${day}T23:59:59.999Z`);
		expect(validUntilOf(state, "Offset probe")).toBe("2098-12-31T22:00:00.000Z");
	});

	it("accepts minutes, hours, days and weeks in short and long spellings", async () => {
		setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
		const { state, tools } = startMnemopiState();
		const spellings: Array<[string, string]> = [
			["90m", "2026-10-23T13:30:00.000Z"],
			["12 hours", "2026-10-24T00:00:00.000Z"],
			["2W", "2026-11-06T12:00:00.000Z"],
			["1 day", "2026-10-24T12:00:00.000Z"],
		];
		for (const [index, [spelling]] of spellings.entries()) {
			await retain(tools, { content: `Spelling probe ${index}`, expires: spelling });
		}
		for (const [index, [, expected]] of spellings.entries()) {
			expect(validUntilOf(state, `Spelling probe ${index}`)).toBe(expected);
		}
	});

	it("leaves valid_until empty when no expiry is given", async () => {
		const { state, tools } = startMnemopiState();
		await retain(tools, { content: "Lasting knowledge probe" });
		expect(validUntilOf(state, "Lasting knowledge")).toBeNull();
	});

	it.each(["soon", "10x", "-5d", "2026-02-31", "2020-01-01", "2020-01-01T00:00:00Z", "2099-01-01T00:00:00", "0m"])(
		"rejects the whole batch for the expiry %p and stores nothing",
		async value => {
			const { state, tools } = startMnemopiState();
			await expect(
				retain(tools, { content: "Fine item" }, { content: "Item with a bad expiry", expires: value }),
			).rejects.toThrow(/Invalid expires for item 2 of 2.*Nothing was stored/s);
			expect(await recalledContents(state, "item")).toEqual([]);
		},
	);
});

describe("retain expires exposure", () => {
	const exposure = (settings: Settings) => {
		const tool = MemoryRetainTool.createIf({ settings } as unknown as ToolSession)!;
		return {
			schema: JSON.stringify(tool.parameters.toJsonSchema()).includes('"expires"'),
			prompt: tool.description.includes("`expires`"),
		};
	};

	it("is offered with Mnemopi, with and without a shared bank", () => {
		const shared = Settings.isolated({ "memory.backend": "mnemopi", "mnemopi.scoping": "global" });
		const projectOnly = Settings.isolated({ "memory.backend": "mnemopi", "mnemopi.scoping": "per-project" });
		expect(exposure(shared)).toEqual({ schema: true, prompt: true });
		expect(exposure(projectOnly)).toEqual({ schema: true, prompt: true });
	});

	it("is not offered with Hindsight, which cannot expire a memory", () => {
		const hindsight = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		expect(exposure(hindsight)).toEqual({ schema: false, prompt: false });
	});
});
