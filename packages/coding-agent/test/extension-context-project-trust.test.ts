import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";

describe("ExtensionContext project trust compatibility", () => {
	it("reports project-local inputs as trusted", () => {
		const runner = new ExtensionRunner(
			[],
			{} as never,
			"/project",
			{ getCwd: () => "/project", getSessionId: () => "extension-context-project-trust" } as never,
			{} as never,
		);

		expect(runner.createContext().isProjectTrusted()).toBe(true);
	});
});
