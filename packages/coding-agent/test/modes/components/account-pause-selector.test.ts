import { beforeAll, describe, expect, it } from "bun:test";
import { AccountPauseSelectorComponent } from "@oh-my-pi/pi-tui/overlays/account-pause-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { OAuthAccountSummary } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { pauseWarnings, toAccountPauseRows } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/account-pause";

beforeAll(async () => {
	await initTheme();
});

const PAUSED_AT = Date.UTC(2026, 8, 24, 12, 30);

function summary(overrides: Partial<OAuthAccountSummary> & { credentialId: number }): OAuthAccountSummary {
	return { position: 0, active: false, paused: false, ...overrides };
}

function render(component: AccountPauseSelectorComponent): string {
	return component
		.render(120)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

describe("toAccountPauseRows", () => {
	it("labels active and paused accounts and marks the account serving this session", () => {
		const rows = toAccountPauseRows(
			[
				summary({ credentialId: 11, position: 0, email: "a@example.com", active: true }),
				summary({
					credentialId: 12,
					position: 1,
					email: "b@example.com",
					paused: true,
					pausedAtMs: PAUSED_AT,
					excluded: "paused",
				}),
				summary({ credentialId: 13, position: 2 }),
			],
			ms => `T${ms}`,
		);
		expect(rows).toEqual([
			{ credentialId: 11, label: "a@example.com", status: "Active", paused: false, current: true },
			{
				credentialId: 12,
				label: "b@example.com",
				status: `Paused since T${PAUSED_AT}`,
				paused: true,
				current: false,
			},
			{ credentialId: 13, label: "OAuth credential #13", status: "Active", paused: false, current: false },
		]);
	});
});

describe("pauseWarnings", () => {
	it("warns when the paused account was serving this session", () => {
		const warnings = pauseWarnings(
			"openai-codex",
			[
				summary({ credentialId: 11, email: "a@example.com", active: true, paused: true, excluded: "paused" }),
				summary({ credentialId: 12, email: "b@example.com" }),
			],
			11,
		);
		expect(warnings).toEqual([
			"a@example.com was serving this session; the next openai-codex request switches to another account.",
		]);
	});

	it("warns when the last active account was paused", () => {
		const warnings = pauseWarnings(
			"openai-codex",
			[
				summary({ credentialId: 11, email: "a@example.com", paused: true, excluded: "paused" }),
				summary({ credentialId: 12, email: "b@example.com", paused: true, excluded: "paused" }),
			],
			12,
		);
		expect(warnings).toEqual([
			"Every openai-codex account is now paused; requests fail until you resume one with /login manage.",
		]);
	});

	it("stays quiet for an idle account with active siblings", () => {
		expect(
			pauseWarnings(
				"openai-codex",
				[
					summary({ credentialId: 11, email: "a@example.com", paused: true, excluded: "paused" }),
					summary({ credentialId: 12, email: "b@example.com", active: true }),
				],
				11,
			),
		).toEqual([]);
	});
});

describe("AccountPauseSelectorComponent", () => {
	it("renders state rows, toggles on Enter, redraws in place, and closes on Esc", () => {
		const accounts = [
			summary({ credentialId: 11, position: 0, email: "a@example.com", active: true }),
			summary({ credentialId: 12, position: 1, email: "b@example.com" }),
		];
		const toggled: number[] = [];
		let cancelled = 0;
		const component = new AccountPauseSelectorComponent(
			"OpenAI Codex",
			toAccountPauseRows(accounts, () => "NOW"),
			row => toggled.push(row.credentialId),
			() => {
				cancelled += 1;
			},
		);

		let rendered = render(component);
		expect(rendered).toContain("a@example.com · Active (this session)");
		expect(rendered).toContain("b@example.com · Active");

		component.handleInput("\u001b[B");
		component.handleInput("\n");
		expect(toggled).toEqual([12]);

		component.setAccounts(
			toAccountPauseRows(
				[accounts[0]!, { ...accounts[1]!, paused: true, pausedAtMs: PAUSED_AT, excluded: "paused" }],
				() => "NOW",
			),
		);
		rendered = render(component);
		expect(rendered).toContain("b@example.com · Paused since NOW");
		// Selection stays on the toggled row after the in-place redraw.
		component.handleInput("\n");
		expect(toggled).toEqual([12, 12]);

		component.handleInput("\u001b");
		expect(cancelled).toBe(1);
	});
});
