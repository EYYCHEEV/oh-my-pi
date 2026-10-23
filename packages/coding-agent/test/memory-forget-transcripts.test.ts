/**
 * With transcript auto-retain on, the transcript of the session that stored a memory is retained at
 * session end, and so is the transcript of any later session whose recall showed it. `memory_edit
 * forget` has to make the agent forget the text, so a fresh recall must not return it through those
 * transcript rows either, or through the summaries and facts built from them.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const MARKER = "Quetzalbolt-7731";
const MEMORY = `The staging deploy token is ${MARKER} and it rotates on 2027-04-01`;
const UNRELATED = "Quokka migration is scheduled for 2027-05-09 with 41 gadgets";

const states: MnemopiSessionState[] = [];
const dirs: TempDir[] = [];

afterEach(async () => {
	for (const state of states.splice(0)) await state.dispose({ consolidate: false });
	for (const dir of dirs.splice(0)) await dir.remove();
});

function startState(scoping: "global" | "per-project-tagged"): { state: MnemopiSessionState; edit: MemoryEditTool } {
	const dir = TempDir.createSync("@memory-forget-transcripts-");
	dirs.push(dir);
	const sessionManager = SessionManager.create(dir.path(), dir.join("sessions"));
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": scoping,
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
	});
	const session = {
		sessionId: sessionManager.getSessionId(),
		settings,
		sessionManager,
		modelRegistry: {
			getApiKeyForProvider: async () => undefined,
			resolver: () => async () => undefined,
		},
		getXdevToolEntries: () => [],
		emitNotice: () => {},
		getHindsightSessionState: () => undefined,
		subscribe: () => () => {},
		refreshBaseSystemPrompt: async () => {},
	};
	const state = new MnemopiSessionState({
		sessionId: session.sessionId,
		config: loadMnemopiConfig(settings, dir.path()),
		session: session as never,
	});
	setMnemopiSessionState(session as never, state);
	states.push(state);
	const toolSession = { settings, getMnemopiSessionState: () => state } as unknown as ToolSession;
	return { state, edit: new MemoryEditTool(toolSession) };
}

/** Stores `text` like the `retain` tool does (without the model-backed fact extraction). */
function retain(state: MnemopiSessionState, text: string, global = false): string {
	return state.rememberScoped(
		text,
		{
			source: "coding-agent-retain",
			importance: 0.75,
			scope: "bank",
			veracity: "tool",
			memoryType: "fact",
		},
		global ? state.getGlobalRetainTarget() : undefined,
	);
}

/** The session that stored the memory, a later session whose recall showed it, and one that never saw it. */
async function retainTranscripts(state: MnemopiSessionState): Promise<void> {
	await state.retainMessages(
		[
			{ role: "user", content: `Please remember this: ${MEMORY}` },
			{ role: "assistant", content: `Stored it. ${MEMORY}. Anything else about the staging cluster?` },
		],
		"session-1",
		{ extract: false },
	);
	await state.retainMessages(
		[
			{ role: "user", content: "What is the staging deploy token?" },
			{ role: "assistant", content: `From memory: ${MEMORY}. It is the one for the staging cluster.` },
		],
		"session-2",
		{ extract: false },
	);
	await state.retainMessages(
		[
			{ role: "user", content: "When does the quokka migration start?" },
			{ role: "assistant", content: `${UNRELATED}.` },
		],
		"session-3",
		{ extract: false },
	);
}

/** What a fresh recall hands the model for `query`, across every bank the session recalls from. */
async function recalled(state: MnemopiSessionState, query: string): Promise<string> {
	return (await state.collectScopedRecallResults(query)).map(result => result.content).join("\n");
}

function age(state: MnemopiSessionState, hours: number): void {
	const at = new Date(Date.now() - hours * 3_600_000).toISOString();
	for (const target of state.getScopedRecallTargets()) {
		target.memory.beam.db.run("UPDATE working_memory SET timestamp = ?", [at]);
	}
}

describe("memory_edit forget also scrubs the retained transcripts", () => {
	it("returns the forgotten text 0 times from transcript rows retained at session end", async () => {
		const { state, edit } = startState("global");
		const id = retain(state, MEMORY);
		await retainTranscripts(state);
		expect(await recalled(state, MARKER)).toContain(MARKER);

		const result = await edit.execute("call", { op: "forget", id });

		expect(result.details).toMatchObject({ status: "deleted" });
		expect(await recalled(state, MARKER)).not.toContain(MARKER);
		expect(await recalled(state, "staging deploy token")).not.toContain(MARKER);
		expect(await recalled(state, "2027-04-01")).not.toContain("2027-04-01");
		// What the transcripts said about everything else is still recallable.
		expect(await recalled(state, "quokka migration")).toContain(UNRELATED);
	});

	it("returns the forgotten text 0 times once sleep consolidated the transcripts into summaries and facts", async () => {
		const { state, edit } = startState("global");
		const id = retain(state, MEMORY);
		await retainTranscripts(state);
		age(state, 13);
		state.memory.sleep(false);
		expect(state.memory.beam.db.query("SELECT COUNT(*) AS n FROM episodic_memory").get()).toMatchObject({ n: 2 });
		expect(await recalled(state, MARKER)).toContain(MARKER);

		const result = await edit.execute("call", { op: "forget", id });

		expect(result.details).toMatchObject({ status: "deleted" });
		for (const query of [MARKER, "staging deploy token", "2027-04-01"]) {
			expect(await recalled(state, query)).not.toContain(MARKER);
			expect(await recalled(state, query)).not.toContain("2027-04-01");
		}
		expect(await recalled(state, "2027-05-09")).toContain("2027-05-09");
	});

	it("scrubs the project bank's transcripts when the forgotten memory lives in the shared bank", async () => {
		const { state, edit } = startState("per-project-tagged");
		const id = retain(state, MEMORY, true);
		await retainTranscripts(state);
		expect(await recalled(state, MARKER)).toContain(MARKER);

		const result = await edit.execute("call", { op: "forget", id });

		expect(result.details).toMatchObject({ status: "deleted" });
		expect(await recalled(state, MARKER)).not.toContain(MARKER);
		expect(await recalled(state, "staging deploy token")).not.toContain(MARKER);
		expect(await recalled(state, "quokka migration")).toContain(UNRELATED);
	});

	it("keeps the transcripts as history when the memory is only invalidated", async () => {
		const { state, edit } = startState("global");
		const id = retain(state, MEMORY);
		await retainTranscripts(state);

		const result = await edit.execute("call", { op: "invalidate", id });

		expect(result.details).toMatchObject({ status: "invalidated" });
		const shown = await state.collectScopedRecallResults(MARKER);
		expect(shown.map(row => row.id)).not.toContain(id);
		expect(shown.map(row => row.source)).toContain("coding-agent-transcript");
		expect(shown.map(row => row.content).join("\n")).toContain(MARKER);
	});

	it("leaves transcripts alone and says so when the forgotten text is too short to scrub", async () => {
		const { state, edit } = startState("global");
		const id = retain(state, "ok");
		await state.retainMessages(
			[
				{ role: "user", content: "ok let us go ahead with the staging deploy" },
				{ role: "assistant", content: "ok, starting the staging deploy now" },
			],
			"session-1",
			{ extract: false },
		);

		const result = await edit.execute("call", { op: "forget", id });

		expect(result.details).toMatchObject({ status: "deleted", note: expect.stringContaining("not scrubbed") });
		expect(JSON.stringify(result.content)).toContain("not scrubbed");
		expect(await recalled(state, "staging deploy")).toContain("ok let us go ahead with the staging deploy");
	});
});
