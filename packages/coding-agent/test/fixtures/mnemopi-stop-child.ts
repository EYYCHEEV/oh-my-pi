/**
 * Child process for `mnemopi-stop-retention.test.ts`: a real `AgentSession` with the Mnemopi backend on,
 * driven the way an unattended bot is, until the parent sends SIGTERM.
 *
 * argv[2] is a JSON `StopChildConfig`. The child writes `ready` once the second turn is hanging (print
 * mode) or the transcript is in place (bare mode), then waits to be signalled.
 *
 * - `print`: the real `runPrintMode` (what `omp -p` runs). Turn 1 answers; turn 2 hangs in the model.
 * - `bare`: no mode at all, so nothing but the memory backend itself reacts to the signal (the RPC case).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { runPrintMode } from "../../src/modes/print-mode";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

interface StopChildConfig {
	dir: string;
	mode: "print" | "bare";
	/** `mnemopi.retainEveryNTurns`. */
	cadence: number;
	/** A post-prompt task that never settles: dispose waits out its 5 s cap before reaching Mnemopi. */
	slowStep: boolean;
	/** OpenAI-compatible endpoint standing in for the model Mnemopi would call to extract facts. */
	llmBaseUrl: string;
	ready: string;
}

const config = JSON.parse(process.argv[2] ?? "{}") as StopChildConfig;
const dbPath = path.join(config.dir, "mnemopi.db");

const settings = Settings.isolated({
	"compaction.enabled": false,
	"memory.backend": "mnemopi",
	"mnemopi.scoping": "global",
	"mnemopi.dbPath": dbPath,
	"mnemopi.noEmbeddings": true,
	"mnemopi.retainEveryNTurns": config.cadence,
	"mnemopi.llmMode": "remote",
	"mnemopi.llmBaseUrl": config.llmBaseUrl,
	"mnemopi.llmApiKey": "stop-test-key",
	"mnemopi.llmModel": "stop-test-model",
});

let calls = 0;
const model = createMockModel({
	id: "mock-stop",
	handler: () => {
		calls++;
		if (calls === 1) return { content: ["First answer."] };
		// Print mode waits for post-prompt work between prompts, so the slow step joins only once the
		// second turn is hanging: from here dispose waits out its 5 s drain cap before reaching Mnemopi.
		if (config.slowStep) session.trackPostPromptTaskForTests(Promise.withResolvers<void>().promise);
		fs.writeFileSync(config.ready, "hung");
		return { content: ["Working on it."], delayMs: 120_000 };
	},
});
const agent = new Agent({
	getApiKey: () => "mock-key",
	initialState: { model, systemPrompt: ["Test"], tools: [] },
	streamFn: (m, context, options) => model.stream(m, context, options),
});
const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("mock", "mock-key");

const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(config.dir),
	settings,
	modelRegistry: new ModelRegistry(authStorage, path.join(config.dir, "models.yml")),
	memoryAgentDir: config.dir,
	memoryTaskDepth: 0,
	createMemoryTools: async () => [],
});
await session.applyMemoryBackend();
if (!session.getMnemopiSessionState()) throw new Error("Mnemopi backend did not start");

if (config.mode === "print") {
	const code = await runPrintMode(session, {
		mode: "text",
		initialMessage: "first question about the stop test",
		messages: ["second question about the stop test"],
	});
	process.exit(code);
}

const now = Date.now();
session.sessionManager.appendMessage({ role: "user", content: "first question about the stop test", timestamp: now });
session.sessionManager.appendMessage({
	role: "assistant",
	content: [{ type: "text", text: "First answer." }],
	api: "mock",
	provider: "mock",
	model: "mock-stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: now + 1,
});
session.sessionManager.appendMessage({
	role: "user",
	content: "second question about the stop test",
	timestamp: now + 2,
});
fs.writeFileSync(config.ready, "waiting");
// A pending promise alone does not keep the process alive.
setInterval(() => {}, 1_000);
