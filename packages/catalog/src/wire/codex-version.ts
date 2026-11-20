import { CODEX_CLIENT_VERSION } from "./codex";

export function getCodexClientVersion(): string {
	return process.env.PI_AI_CODEX_CLIENT_VERSION || CODEX_CLIENT_VERSION;
}
