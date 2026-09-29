import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	const separators = theme.sep;
	Object.defineProperty(theme, "sep", {
		configurable: true,
		get: () => ({ ...separators, pipe: "|" }),
	});
});

afterAll(() => {
	delete (theme as unknown as Record<string, unknown>).sep;
	resetSettingsForTest();
});

function session(options: { cost?: number; subscription?: boolean } = {}) {
	const model = { name: "test", contextWindow: 128000 };
	return {
		state: { messages: [], model },
		messages: [],
		model,
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isAdvisorActive: () => false,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		isFastModeEnabled: () => false,
		getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }),
		getGoalModeState: () => null,
		modelRegistry: { isUsingOAuth: () => options.subscription ?? false },
		sessionManager: {
			getSessionName: () => "session",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: options.cost ?? 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function component(
	leftSegments: string[],
	rightSegments: string[],
	options: { cost?: number; subscription?: boolean; separator?: "space" | "pipe" } = {},
) {
	const value = new StatusLineComponent(session(options), statusLineHost);
	value.updateSettings({
		preset: "custom",
		leftSegments,
		rightSegments,
		separator: options.separator ?? "space",
		sessionAccent: false,
	} as never);
	return value;
}

function plain(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("extension status-line segments", () => {
	it("renders immediately after actual cost on the left and right", () => {
		for (const side of ["left", "right"] as const) {
			const status = component(side === "left" ? ["cost"] : [], side === "right" ? ["cost"] : [], {
				cost: 0.74,
				subscription: true,
				separator: "pipe",
			});
			status.registerExtensionSegment(`${side}-timer`, {
				id: `${side}-timer`,
				placement: { afterBuiltin: "cost", fallback: "anchor-side-end-else-right" },
				color: "statusLineOutput",
				render: () => "42s",
			});
			const raw = status.getTopBorder(80).content;
			expect(plain(raw)).toContain("S0.74 | 42s");
			expect(raw).toContain(`${theme.getFgAnsi("statusLineOutput")}42s`);
		}
	});

	it("puts a right-side timer at side end when configured cost is invisible", () => {
		const status = component(["pi"], ["cost", "session_name"], { separator: "pipe" });
		status.registerExtensionSegment("hidden-right-anchor", {
			id: "hidden-right-anchor",
			placement: { afterBuiltin: "cost", fallback: "anchor-side-end-else-right" },
			render: () => "42s",
		});
		expect(plain(status.getTopBorder(100).content)).toContain("session | 42s");
	});

	it("falls back to the right edge when cost is absent", () => {
		const status = component(["pi"], ["session_name"], { separator: "pipe" });
		status.registerExtensionSegment("absent", {
			id: "absent",
			placement: { afterBuiltin: "cost", fallback: "anchor-side-end-else-right" },
			render: () => "42s",
		});
		expect(plain(status.getTopBorder(100).content)).toContain("session | 42s");
	});

	it("isolates renderer faults without disturbing built-ins", () => {
		const baseline = component(["pi"], ["session_name"]);
		const expected = baseline.getTopBorder(100);
		const status = component(["pi"], ["session_name"]);
		status.registerExtensionSegment("fault", {
			id: "fault",
			placement: { afterBuiltin: "pi", fallback: "anchor-side-end-else-right" },
			render: () => {
				throw new Error("boom");
			},
		});
		const actual = status.getTopBorder(100);
		expect(actual.content).toBe(expected.content);
		expect(actual.width).toBe(expected.width);
	});

	it("keeps extension segments on their configured composer side", () => {
		const status = component(["pi"], ["session_name"]);
		status.registerExtensionSegment("left-only", {
			id: "left-only",
			placement: { afterBuiltin: "pi", fallback: "anchor-side-end-else-right" },
			render: () => "LEFT",
		});
		status.registerExtensionSegment("right-only", {
			id: "right-only",
			placement: { afterBuiltin: "session_name", fallback: "anchor-side-end-else-right" },
			render: () => "RIGHT",
		});

		expect(plain(status.renderBottomBar(100, "left"))).toContain("LEFT");
		expect(plain(status.renderBottomBar(100, "left"))).not.toContain("RIGHT");
		expect(plain(status.getStandaloneTopBorder(100).content)).toContain("RIGHT");
		expect(plain(status.getStandaloneTopBorder(100).content)).not.toContain("LEFT");
	});

	it("invalidates on registration and idempotent disposal", () => {
		const status = component(["pi"], []);
		const invalidate = vi.spyOn(status, "invalidate");
		const dispose = status.registerExtensionSegment("live", {
			id: "live",
			placement: { afterBuiltin: "pi", fallback: "anchor-side-end-else-right" },
			render: () => "LIVE",
		});
		expect(invalidate).toHaveBeenCalledTimes(1);
		dispose();
		dispose();
		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(plain(status.getTopBorder(80).content)).not.toContain("LIVE");
	});

	it("rejects a synchronous key collision without replacing the first registration", () => {
		const status = component(["pi"], []);
		status.registerExtensionSegment("same-key", {
			id: "first",
			placement: { afterBuiltin: "pi", fallback: "anchor-side-end-else-right" },
			render: () => "FIRST",
		});
		expect(() =>
			status.registerExtensionSegment("same-key", {
				id: "second",
				placement: { afterBuiltin: "pi", fallback: "anchor-side-end-else-right" },
				render: () => "SECOND",
			}),
		).toThrow("Duplicate status segment: second");
		const rendered = plain(status.getTopBorder(80).content);
		expect(rendered).toContain("FIRST");
		expect(rendered).not.toContain("SECOND");
	});

	it("drops the newest extension first when width overflows", () => {
		const status = component(["pi"], []);
		status.registerExtensionSegment("first", {
			id: "first",
			placement: { afterBuiltin: "pi", fallback: "anchor-side-end-else-right" },
			render: () => "FIRST",
		});
		status.registerExtensionSegment("second", {
			id: "second",
			placement: { afterBuiltin: "pi", fallback: "anchor-side-end-else-right" },
			render: () => "SECOND_LONG",
		});
		const wide = plain(status.getTopBorder(80).content);
		expect(wide).toContain("FIRST");
		expect(wide).toContain("SECOND_LONG");
		let observed: string | undefined;
		for (let width = 79; width > 0; width--) {
			const rendered = plain(status.getTopBorder(width).content);
			if (rendered.includes("FIRST") && !rendered.includes("SECOND_LONG")) {
				observed = rendered;
				break;
			}
		}
		expect(observed).toContain("FIRST");
	});

	it("keeps extension identity when embedded context removes its built-in anchor", () => {
		const status = component(["pi", "context_pct"], ["session_name"]);
		status.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "context_pct"],
			rightSegments: ["session_name"],
			contextLine: "embedded",
			sessionAccent: false,
		});
		status.registerExtensionSegment("context-note", {
			id: "context-note",
			placement: { afterBuiltin: "context_pct", fallback: "anchor-side-end-else-right" },
			render: () => "CONTEXT_NOTE",
		});
		status.registerExtensionSegment("fallback-note", {
			id: "fallback-note",
			placement: { afterBuiltin: "cost", fallback: "anchor-side-end-else-right" },
			render: () => "FALLBACK_NOTE",
		});
		const rendered = plain(status.getTopBorder(120).content);
		expect(rendered).toContain("CONTEXT_NOTE");
		expect(rendered).toContain("FALLBACK_NOTE");
		status.dispose();
	});

	it("projects placement, color, overflow priority and disposal into native status surfaces", () => {
		const status = component(["cost"], ["session_name"], { cost: 0.74 });
		const dispose = status.registerExtensionSegment("first", {
			id: "first",
			placement: { afterBuiltin: "cost", fallback: "anchor-side-end-else-right" },
			color: "statusLineOutput",
			render: () => "FIRST",
		});
		status.registerExtensionSegment("second", {
			id: "second",
			placement: { afterBuiltin: "cost", fallback: "anchor-side-end-else-right" },
			render: () => "SECOND",
		});
		status.registerExtensionSegment("fallback", {
			id: "fallback",
			placement: { afterBuiltin: "pi", fallback: "anchor-side-end-else-right" },
			render: () => "FALLBACK",
		});

		const preview = status.describePreview().c as readonly NativeNode[];
		expect(preview.map(part => part.key)).toEqual([
			"cost",
			"extension:first",
			"extension:second",
			"session_name",
			"extension:fallback",
		]);
		const facts = status.describeComposerFacts();
		const extras = facts.extras.c as readonly NativeNode[];
		expect(extras.map(part => part.key)).toEqual(["extension:first", "extension:second", "extension:fallback"]);
		for (const parts of [preview, extras]) {
			const first = parts.find(part => part.key === "extension:first");
			const second = parts.find(part => part.key === "extension:second");
			const fallback = parts.find(part => part.key === "extension:fallback");
			if (first?.k !== "seg" || second?.k !== "seg" || fallback?.k !== "seg") {
				throw new Error("Missing native extension segment");
			}
			expect(first.p?.side).toBe("left");
			expect(first.p?.spans).toEqual([{ t: "FIRST", s: "statusLineOutput" }]);
			expect(fallback.p?.side).toBe("right");
			expect(second.p?.priority).toBeLessThan(first.p?.priority ?? 0);
			expect(first.p?.priority).toBeLessThan(0);
		}
		dispose();
		const afterDispose = status.describeComposerFacts();
		expect(afterDispose).not.toBe(facts);
		expect((afterDispose.extras.c as readonly NativeNode[]).map(part => part.key)).not.toContain("extension:first");
		status.dispose();
	});
});
