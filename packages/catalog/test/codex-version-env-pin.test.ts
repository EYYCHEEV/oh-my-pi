import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type * as CodexVersion from "../src/wire/codex-version";

const ENV_KEYS = [
	"PI_AI_CODEX_CLIENT_VERSION",
	"NODE_ENV",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
] as const;
const NPM_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";

let imports = 0;
async function freshCodexVersionModule(): Promise<typeof CodexVersion> {
	imports++;
	return import(`../src/wire/codex-version.ts?env-pin=${imports}`);
}

describe("codex client version launcher pin", () => {
	const saved = new Map<string, string | undefined>();
	let temp: TempDir;
	let fetchSpy: Mock<typeof fetch>;

	beforeEach(() => {
		for (const key of ENV_KEYS) saved.set(key, process.env[key]);
		temp = TempDir.createSync("@omp-codex-version-pin-");
		setAgentDir(temp.path());
		process.env.NODE_ENV = "production";
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async () => new Response("unavailable", { status: 503 }), { preconnect: fetch.preconnect }),
		);
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		for (const key of ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		temp.removeSync();
	});

	it("uses PI_AI_CODEX_CLIENT_VERSION without asking npm or writing the version record", async () => {
		process.env.PI_AI_CODEX_CLIENT_VERSION = "0.169.1";
		const { getCodexClientVersion } = await freshCodexVersionModule();

		expect(getCodexClientVersion()).toBe("0.169.1");
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(fs.existsSync(temp.join("codex-client-version.json"))).toBe(false);
	});

	it("asks npm when the pin is absent outside bun test", async () => {
		delete process.env.PI_AI_CODEX_CLIENT_VERSION;
		const { getCodexClientVersion } = await freshCodexVersionModule();

		getCodexClientVersion();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(NPM_LATEST_URL);
	});
});
