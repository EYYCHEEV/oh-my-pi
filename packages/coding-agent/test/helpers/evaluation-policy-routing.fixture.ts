import { afterEach, expect, spyOn, test } from "bun:test";
import * as stats from "@oh-my-pi/omp-stats";
import { runCli } from "@oh-my-pi/pi-coding-agent/cli";
import * as jsProcess from "@oh-my-pi/pi-coding-agent/eval/js/process-entry";
import * as cliRunner from "@oh-my-pi/pi-utils/cli";

// These public dispatch dependencies are trapped before any smoke worker,
// evaluator process, or command can run. The fixture owns this entire child.
const dispatchTrap = new Error("OWNED_DISPATCH_TRAP");
const smoke = spyOn(stats, "smokeTestSyncWorker").mockRejectedValue(dispatchTrap);
const worker = spyOn(jsProcess, "startJsEvalProcess").mockImplementation(() => {
	throw dispatchTrap;
});
const command = spyOn(cliRunner, "run").mockRejectedValue(dispatchTrap);
const scoped = process.env.OMP_EVALUATION_POLICY !== undefined;
afterEach(() => {
	smoke.mockClear();
	worker.mockClear();
	command.mockClear();
	process.exitCode = 0;
});

for (const [route, argv] of [
	["smoke command", ["--smoke-test", "--print"]],
	["profile-hidden worker", ["--profile", "fixture", "__omp_worker_js_eval_process", "--print"]],
	["flag-hidden management command", ["--print", "update"]],
	["global version shortcut", ["--version", "--print"]],
	["root help shortcut", ["--print", "--help"]],
] as const) {
	test(`${scoped ? "scoped CLI refuses" : "unscoped CLI retains"} ${route} dispatch`, async () => {
		if (!scoped) {
			await expect(runCli([...argv])).rejects.toBe(dispatchTrap);
			expect(smoke.mock.calls.length + worker.mock.calls.length + command.mock.calls.length).toBe(1);
			return;
		}
		let refusal: unknown;
		try {
			await runCli([...argv]);
		} catch (error) {
			refusal = error;
		}
		expect(smoke).not.toHaveBeenCalled();
		expect(worker).not.toHaveBeenCalled();
		expect(command).not.toHaveBeenCalled();
		expect(
			(refusal instanceof Error && refusal.message.includes("Evaluation policy")) || process.exitCode === 1,
		).toBe(true);
	});
}

test("public CLI retains the profile-prefixed one-shot root route", async () => {
	await expect(runCli(["--profile", "fixture", "--print", "@/owned-input"])).rejects.toBe(dispatchTrap);
	expect(command).toHaveBeenCalledTimes(1);
	expect(command.mock.calls[0][0].argv).toEqual(["launch", "--print", "@/owned-input"]);
	expect(smoke).not.toHaveBeenCalled();
	expect(worker).not.toHaveBeenCalled();
});
