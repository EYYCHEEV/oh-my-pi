/**
 * Contract: when Mnemopi could not start, print mode says so once on stderr, whether the
 * failure was recorded before the run began or while the first turn was running, in text and
 * JSON mode alike. A healthy start prints nothing.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import {
	type MnemopiStartupFailure,
	mnemopiStartupNotice,
	recordMnemopiStartupFailure,
} from "../../src/mnemopi/startup-failure";
import { runPrintMode } from "../../src/modes/print-mode";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

const failure: MnemopiStartupFailure = {
	errorClass: "SQLiteError",
	code: "SQLITE_IOERR_WRITE",
	message: "disk I/O error",
	file: "memories/mnemopi/mnemopi.db",
	notWritable: ["memories/mnemopi/mnemopi.db-wal"],
};

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		stopReason: "stop",
		timestamp: 1,
	} as unknown as AssistantMessage;
}

function captureStderr(): { written: () => string; restore: () => void } {
	const chunks: string[] = [];
	const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as never);
	return { written: () => chunks.join(""), restore: () => spy.mockRestore() };
}

function makeSession(onPrompt: (session: AgentSession) => void = () => {}): AgentSession {
	const dir = TempDir.createSync("@pi-print-mnemopi-");
	tempDirs.push(dir);
	const manager = SessionManager.create(dir.path(), `${dir.path()}/sessions`);
	const session = {
		extensionRunner: undefined,
		subscribe: () => {},
		settings: Settings.isolated(),
		sessionManager: manager,
		getLastAssistantMessage: () => assistant(""),
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForIdle: async () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		prompt: async () => onPrompt(session),
		dispose: async () => {
			await manager.close();
		},
	} as unknown as AgentSession;
	return session;
}

async function run(session: AgentSession, mode: "text" | "json"): Promise<string> {
	const stderr = captureStderr();
	const stdout = spyOn(process.stdout, "write").mockImplementation(((_chunk: unknown, callback?: unknown) => {
		if (typeof callback === "function") (callback as () => void)();
		return true;
	}) as never);
	try {
		await runPrintMode(session, { mode, initialMessage: "hello" });
	} finally {
		stdout.mockRestore();
		stderr.restore();
	}
	return stderr.written();
}

describe("print mode Mnemopi startup warning", () => {
	it("prints a failure recorded before the run once, in text mode", async () => {
		const session = makeSession();
		recordMnemopiStartupFailure(session, failure);

		const written = await run(session, "text");

		expect(written).toContain(`Warning: ${mnemopiStartupNotice(failure)}`);
		expect(written.match(/Mnemopi memory is off for this session/g)).toHaveLength(1);
		expect(written).toContain("SQLITE_IOERR_WRITE");
		expect(written).toContain("memories/mnemopi/mnemopi.db-wal");
	});

	it("prints a failure recorded while the first turn runs, in JSON mode", async () => {
		const session = makeSession(running => recordMnemopiStartupFailure(running, failure));

		const written = await run(session, "json");

		expect(written.match(/Mnemopi memory is off for this session/g)).toHaveLength(1);
	});

	it("prints nothing when Mnemopi started", async () => {
		const session = makeSession();

		const written = await run(session, "text");

		expect(written).not.toContain("Mnemopi");
	});
});
