/**
 * A bot routine killed at its time limit gets SIGTERM, then SIGKILL 10 s later. The turns Mnemopi has
 * not retained yet must be stored within seconds of the SIGTERM, with no model call, whichever mode
 * the process runs in. The first three tests run a real child process; the rest pin the state's contract.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import { closeMnemopiStates, startMnemopiState } from "./helpers/mnemopi-state";

const FIXTURE = path.join(import.meta.dir, "fixtures", "mnemopi-stop-child.ts");
/** "Within about 5 s of SIGTERM" with margin on both sides of the 5 s a slow teardown step takes. */
const RETAIN_BUDGET_MS = 3_000;

interface StopRun {
	retainedAfterMs: number | undefined;
	exitCode: number | null;
	extractionRequests: number;
	retainedText: string;
}

function transcriptRows(dbPath: string): string[] {
	if (!fs.existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.query("SELECT content FROM working_memory WHERE source = 'coding-agent-transcript' ORDER BY rowid")
			.all() as Array<{ content: string }>;
		return rows.map(row => row.content);
	} catch {
		return [];
	} finally {
		db.close();
	}
}

/** Runs the child to the point it can be signalled, sends SIGTERM, and times how long retention takes. */
async function runUntilSigterm(options: {
	mode: "print" | "bare";
	cadence: number;
	slowStep: boolean;
	autoRetain?: boolean;
}): Promise<StopRun> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemopi-stop-"));
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: request => {
			requests.push(request.url);
			return new Response("{}", { status: 500 });
		},
	});
	const ready = path.join(dir, "ready");
	const child = Bun.spawn(
		[
			process.execPath,
			FIXTURE,
			JSON.stringify({ dir, ...options, llmBaseUrl: `http://127.0.0.1:${server.port}/v1`, ready }),
		],
		{ env: { ...process.env, HOME: dir, PI_TEST_RUNTIME: "1" }, stdout: "pipe", stderr: "pipe" },
	);
	try {
		const startedAt = performance.now();
		while (!fs.existsSync(ready)) {
			if (child.exitCode !== null) throw new Error(`child exited early: ${await new Response(child.stderr).text()}`);
			if (performance.now() - startedAt > 45_000) throw new Error("child never became ready");
			await Bun.sleep(25); // a real child process: there is no event to await for its readiness marker
		}
		const requestsBeforeStop = requests.length;
		const sentAt = performance.now();
		child.kill("SIGTERM");

		const dbPath = path.join(dir, "mnemopi.db");
		let retainedAfterMs: number | undefined;
		while (performance.now() - sentAt < 7_000) {
			if (transcriptRows(dbPath).join("\n").includes("second question about the stop test")) {
				retainedAfterMs = performance.now() - sentAt;
				break;
			}
			await Bun.sleep(25);
		}
		const exitCode = await Promise.race([child.exited, Bun.sleep(15_000).then(() => null)]);
		return {
			retainedAfterMs,
			exitCode,
			extractionRequests: requests.length - requestsBeforeStop,
			retainedText: transcriptRows(dbPath).join("\n"),
		};
	} finally {
		child.kill("SIGKILL");
		await child.exited;
		await server.stop(true);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

afterEach(closeMnemopiStates);

describe("SIGTERM with turns not yet retained (real child process)", () => {
	it("print mode: retains both turns within the budget although teardown has a slow step, and calls no model", async () => {
		const run = await runUntilSigterm({ mode: "print", cadence: 100, slowStep: true });
		expect(run.retainedAfterMs).toBeDefined();
		expect(run.retainedAfterMs!).toBeLessThan(RETAIN_BUDGET_MS);
		expect(run.retainedText).toContain("First answer.");
		expect(run.extractionRequests).toBe(0);
		expect(run.exitCode).toBe(143);
	}, 90_000);

	it("print mode: a retain turn that ends with the abort starts no fact extraction", async () => {
		// Guard: cadence 2 makes the second turn an eligible retain turn when the abort ends it. The unit
		// tests below pin the extraction flag; this one watches the real process for model requests.
		const run = await runUntilSigterm({ mode: "print", cadence: 2, slowStep: true });
		expect(run.retainedAfterMs).toBeDefined();
		expect(run.extractionRequests).toBe(0);
		expect(run.exitCode).toBe(143);
	}, 90_000);

	it("a mode whose session is never disposed on signals (RPC): the memory backend retains by itself", async () => {
		const run = await runUntilSigterm({ mode: "bare", cadence: 100, slowStep: false });
		expect(run.retainedAfterMs).toBeDefined();
		expect(run.retainedAfterMs!).toBeLessThan(RETAIN_BUDGET_MS);
		expect(run.retainedText).toContain("First answer.");
		expect(run.extractionRequests).toBe(0);
		expect(run.exitCode).toBe(143);
	}, 90_000);

	it("print mode with mnemopi.autoRetain off: a stop signal stores no transcript turn", async () => {
		const run = await runUntilSigterm({ mode: "print", cadence: 100, slowStep: true, autoRetain: false });
		expect(run.retainedAfterMs).toBeUndefined();
		expect(run.retainedText).toBe("");
		expect(run.extractionRequests).toBe(0);
		expect(run.exitCode).toBe(143);
	}, 90_000);

	it("a mode whose session is never disposed (RPC) with mnemopi.autoRetain off: the stop hook stores nothing", async () => {
		const run = await runUntilSigterm({ mode: "bare", cadence: 100, slowStep: false, autoRetain: false });
		expect(run.retainedAfterMs).toBeUndefined();
		expect(run.retainedText).toBe("");
		expect(run.exitCode).toBe(143);
	}, 90_000);
});

describe("MnemopiSessionState stop contract", () => {
	function turn(role: "user" | "assistant", content: string) {
		return { type: "message", message: { role, content } };
	}

	it("retainOnStop stores the unretained suffix once, and a later dispose adds nothing", async () => {
		const entries = [
			turn("user", "alpha question"),
			turn("assistant", "alpha answer"),
			turn("user", "beta question"),
		];
		const { state } = startMnemopiState({ "mnemopi.retainEveryNTurns": 100 }, () => entries);
		const remember = spyOn(state.memory, "remember");

		await state.retainOnStop();
		expect(remember).toHaveBeenCalledTimes(1);
		const [stored, options] = remember.mock.calls[0]!;
		expect(JSON.stringify(stored)).toContain("beta question");
		expect(options).toMatchObject({ extract: false });

		await state.dispose();
		expect(remember).toHaveBeenCalledTimes(1);
	});

	it("after retainOnStop an eligible agent_end retains without extraction", async () => {
		const entries = [turn("user", "first"), turn("assistant", "one")];
		const { state } = startMnemopiState({ "mnemopi.retainEveryNTurns": 2 }, () => entries);
		const remember = spyOn(state.memory, "remember");

		await state.retainOnStop();
		entries.push(turn("user", "second"), turn("assistant", "two"), turn("user", "third"));
		await state.maybeRetainOnAgentEnd([]);

		expect(remember).toHaveBeenCalledTimes(2);
		expect(remember.mock.calls[1]![1]).toMatchObject({ extract: false });
	});

	it("an agent_end before any stop still extracts facts", async () => {
		const entries = [turn("user", "first"), turn("assistant", "one"), turn("user", "second")];
		const { state } = startMnemopiState({ "mnemopi.retainEveryNTurns": 2 }, () => entries);
		const remember = spyOn(state.memory, "remember");

		await state.maybeRetainOnAgentEnd([]);

		expect(remember.mock.calls[0]![1]).toMatchObject({ extract: true });
	});

	it("retains nothing on a signal when mnemopi.autoRetain is off", async () => {
		const { state } = startMnemopiState({ "mnemopi.autoRetain": false }, () => [turn("user", "never stored")]);
		const remember = spyOn(state.memory, "remember");
		await state.retainOnStop();
		expect(remember).not.toHaveBeenCalled();
	});

	it("registers one process-stop hook per state and drops it on dispose", async () => {
		const register = spyOn(postmortem, "register");
		const { state } = startMnemopiState();
		state.attachSessionListeners();
		const hooks = register.mock.calls.filter(([id]) => id.startsWith("mnemopi-retain:"));
		expect(hooks).toHaveLength(1);

		const stoppingReasons = [postmortem.Reason.SIGTERM, postmortem.Reason.SIGINT, postmortem.Reason.SIGHUP];
		const retainOnStop = spyOn(state, "retainOnStop").mockResolvedValue();
		for (const reason of [...stoppingReasons, postmortem.Reason.EXIT, postmortem.Reason.MANUAL]) hooks[0]![1](reason);
		expect(retainOnStop).toHaveBeenCalledTimes(stoppingReasons.length);

		await state.dispose();
		register.mockRestore();
	});
});
