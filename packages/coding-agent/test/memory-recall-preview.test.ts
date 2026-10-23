/**
 * A recall preview of a long memory is a window around what the query matched, not its head. The
 * first-turn block, the `recall` tool and the `reflect` tool all render those previews, so the fact the
 * query found must be in them without a second read by id.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const PROMPT = "Where is the deploy host?";
const FILLER = "Routine rollout note about nothing in particular. ";

const states: MnemopiSessionState[] = [];
const dirs: TempDir[] = [];

afterEach(async () => {
	for (const state of states.splice(0)) await state.dispose({ consolidate: false });
	for (const dir of dirs.splice(0)) await dir.remove();
});

/** One omp process: a session with its own Mnemopi state on a store inside a fresh temp directory. */
function startProcess(): { dir: TempDir; state: MnemopiSessionState } {
	const dir = TempDir.createSync("@memory-recall-preview-");
	dirs.push(dir);
	const sessionManager = SessionManager.create(dir.path(), dir.join("sessions"));
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
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
	return { dir, state };
}

const memoryText = (host: string): string => `${FILLER.repeat(40)}The deploy host is ${host}. ${FILLER.repeat(40)}`;

describe("recall preview of a long memory", () => {
	it("puts the matched part of a long memory in the first-turn block", async () => {
		const { state } = startProcess();
		const original = memoryText("alpha-7");
		state.rememberScoped(original);

		const preparation = await mnemopiBackend.beforeAgentStartPrompt?.(state.session, PROMPT);
		if (!preparation) throw new Error("no first-turn recall was prepared");

		expect(preparation.context).toContain("The deploy host is alpha-7.");
		expect(preparation.context).toContain("…");
		expect(preparation.context).not.toContain(original);
	});

	it("lists the matched part in the recall tool output, with the id to read the full row", async () => {
		const { state } = startProcess();
		const id = state.rememberScoped(memoryText("alpha-7"));

		const results = await state.recallResultsScoped(PROMPT);
		const listed = state.formatScopedRecallWithIds(results);

		expect(listed).toContain("The deploy host is alpha-7.");
		expect(listed).toContain(`id: ${id}`);
	});

	it("keeps the head of a long memory when the query matches there", async () => {
		const { state } = startProcess();
		const original = `The deploy host is alpha-7. ${FILLER.repeat(60)}`;
		state.rememberScoped(original);

		const results = await state.recallResultsScoped(PROMPT);
		const [hit] = results;

		expect(hit?.content.startsWith("The deploy host is alpha-7.")).toBe(true);
		expect(hit?.content.endsWith("…")).toBe(true);
	});
});
