import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { kimiUsageProvider } from "@oh-my-pi/pi-ai/usage/kimi";

function makeCredential(): UsageFetchParams["credential"] {
	return {
		type: "oauth",
		accessToken: "kimi-test-token",
	};
}

function makeCtx(payload: unknown): UsageFetchContext {
	const fetch: FetchImpl = async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	return { fetch };
}

describe("kimi usage provider", () => {
	it("surfaces the 5h limit reset time from the limit detail onto the window", async () => {
		// Live payload shape: `resetTime` lives on `detail`, while `window`
		// carries only duration/timeUnit. The 5h row must still render
		// "resets in …" in `omp usage`.
		const detailReset = "2026-07-18T05:43:35.355947Z";
		const usageReset = "2026-07-21T07:43:35.355947Z";
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				usage: { limit: "100", used: "28", remaining: "72", resetTime: usageReset },
				limits: [
					{
						window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
						detail: { limit: "100", remaining: "100", resetTime: detailReset },
					},
				],
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(2);

		const total = report!.limits[0]!;
		expect(total.label).toBe("Total quota");
		expect(total.window?.resetsAt).toBe(Date.parse(usageReset));

		const fiveHour = report!.limits[1]!;
		expect(fiveHour.label).toBe("5h limit");
		expect(fiveHour.window?.durationMs).toBe(5 * 60 * 60 * 1000);
		expect(fiveHour.window?.resetsAt).toBe(Date.parse(detailReset));
	});

	it("surfaces the payload user id as report accountId metadata", async () => {
		// Live payload shape: `user.userId` identifies the underlying Kimi
		// account. Reports must carry it so `omp usage` labels accounts and
		// AuthStorage dedupes/attributes per account instead of falling back
		// to generic "account N" rows.
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				user: { userId: "d8ombrsdeijirk63r0tg", membership: { level: "LEVEL_ADVANCED" } },
				usage: { limit: "100", used: "56", remaining: "44", resetTime: "2026-07-24T01:25:38.188285Z" },
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.metadata?.accountId).toBe("d8ombrsdeijirk63r0tg");
	});

	it("omits accountId metadata when the payload has no user id", async () => {
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				usage: { limit: "100", used: "1", remaining: "99", resetTime: "2026-07-24T01:25:38.188285Z" },
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.metadata?.accountId).toBeUndefined();
	});

	it("keeps an explicit window resetTime authoritative over the detail one", async () => {
		const windowReset = "2026-07-18T06:00:00.000Z";
		const detailReset = "2026-07-18T05:43:35.355947Z";
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				limits: [
					{
						window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE", resetTime: windowReset },
						detail: { limit: "100", remaining: "40", resetTime: detailReset },
					},
				],
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(1);
		expect(report!.limits[0]!.window?.resetsAt).toBe(Date.parse(windowReset));
	});
});
