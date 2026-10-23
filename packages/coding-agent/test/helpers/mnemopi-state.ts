/**
 * A real `MnemopiSessionState` over a temp database, for tests of the settings -> backend -> Mnemopi
 * path. `startMnemopiState` returns the state and its tool session; `closeMnemopiStates` disposes them.
 */
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const SESSION_ID = "mnemopi-test-session";
const states: MnemopiSessionState[] = [];
const dirs: TempDir[] = [];

export interface StartedMnemopi {
	state: MnemopiSessionState;
	tools: ToolSession;
	dir: TempDir;
	settings: Settings;
}

export function startMnemopiState(
	overrides: Record<string, unknown> = {},
	entries: () => unknown[] = () => [],
): StartedMnemopi {
	const dir = TempDir.createSync("@mnemopi-test-");
	dirs.push(dir);
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		...overrides,
	});
	const state = new MnemopiSessionState({
		sessionId: SESSION_ID,
		config: loadMnemopiConfig(settings, dir.path()),
		session: {
			sessionId: SESSION_ID,
			settings,
			modelRegistry: {
				getApiKeyForProvider: async () => undefined,
				resolver: () => async () => undefined,
			} as never,
			sessionManager: { getEntries: entries, getCwd: () => dir.path() } as never,
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			subscribe: () => () => {},
		} as never,
	});
	setMnemopiSessionState(state.session as never, state);
	states.push(state);
	const tools = {
		cwd: dir.path(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => SESSION_ID,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => state,
	} as unknown as ToolSession;
	return { state, tools, dir, settings };
}

export async function closeMnemopiStates(): Promise<void> {
	for (const state of states.splice(0)) await state.dispose();
	for (const dir of dirs.splice(0)) await dir.remove();
}
