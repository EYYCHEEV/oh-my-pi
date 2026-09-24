/**
 * `omp auth list|pause|resume <provider> [credential-id] [--json]`: scriptable
 * control of the persisted OAuth account pause. Accounts are addressed only by
 * their durable credential id; output never includes token bytes.
 */
import { OAuthAccountPoolError } from "@oh-my-pi/pi-ai/error";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { authHelp as commandHelp } from "../cli/command-help";
import { discoverAuthStorage } from "../sdk";
import type { AuthStorage, OAuthAccountSummary } from "../session/auth-storage";
import { credentialPinHash } from "../session/credential-pin";
import { ACCOUNT_PAUSE_BROKER_MESSAGE, pauseWarnings } from "../slash-commands/helpers/account-pause";
import { oauthAccountLabel } from "../slash-commands/helpers/session-pin";

const VERBS = ["list", "pause", "resume"] as const;
type AuthVerb = (typeof VERBS)[number];

/** Parsed `omp auth` invocation. */
export interface AuthCommandInput {
	verb: string;
	provider?: string;
	/** Durable credential id, `17` or `#17`; required by pause/resume. */
	selector?: string;
	json?: boolean;
}

/** Output sinks, injectable for tests. */
export interface AuthCommandIo {
	stdout(text: string): void;
	stderr(text: string): void;
}

type AuthErrorCode =
	| "invalid_arguments"
	| "invalid_selector"
	| "unknown_credential"
	| OAuthAccountPoolError["code"]
	| "error";

class AuthCommandError extends Error {
	constructor(
		readonly code: AuthErrorCode,
		message: string,
	) {
		super(message);
	}
}

function toListEntry(provider: string, account: OAuthAccountSummary) {
	return {
		credentialId: account.credentialId,
		position: account.position + 1,
		label: oauthAccountLabel(account),
		fingerprint: credentialPinHash(provider, account) ?? null,
		state: account.paused ? ("paused" as const) : ("active" as const),
		pausedAt: account.paused && account.pausedAtMs !== undefined ? new Date(account.pausedAtMs).toISOString() : null,
	};
}

function resolveAccount(
	provider: string,
	accounts: readonly OAuthAccountSummary[],
	selector: string | undefined,
): OAuthAccountSummary {
	const match = selector === undefined ? null : /^#?(\d+)$/.exec(selector.trim());
	if (!match) {
		const rejected = selector === undefined ? "" : `; ${JSON.stringify(selector)} is not one`;
		throw new AuthCommandError(
			"invalid_selector",
			`Select an account by its durable credential id (e.g. 17 or #17)${rejected}. List them with \`omp auth list ${provider}\`.`,
		);
	}
	const credentialId = Number(match[1]);
	const account = accounts.find(candidate => candidate.credentialId === credentialId);
	if (account) return account;
	const positionHint =
		credentialId >= 1 && credentialId <= accounts.length
			? " List positions are not accepted; use the credential id."
			: "";
	throw new AuthCommandError(
		"unknown_credential",
		`No stored ${provider} OAuth account has credential id ${credentialId}. List them with \`omp auth list ${provider}\`.${positionHint}`,
	);
}

/**
 * Run one `omp auth` verb against `authStorage`. Returns the process exit code.
 * Every verb fails closed on auth-broker stores, which cannot persist pauses.
 */
export async function runAuthCommand(
	authStorage: AuthStorage,
	input: AuthCommandInput,
	io: AuthCommandIo,
): Promise<number> {
	const provider = input.provider?.trim().toLowerCase();
	try {
		if (!VERBS.includes(input.verb as AuthVerb) || !provider) {
			throw new AuthCommandError(
				"invalid_arguments",
				"Usage: omp auth list <provider> | pause <provider> <credential-id> | resume <provider> <credential-id> [--json]",
			);
		}
		if (!authStorage.credentials.supportsPause()) {
			throw new AuthCommandError("broker_unsupported", ACCOUNT_PAUSE_BROKER_MESSAGE);
		}
		await authStorage.credentials.reload();
		const accounts = authStorage.oauth.accounts(provider);

		if (input.verb === "list") {
			const entries = accounts.map(account => toListEntry(provider, account));
			if (input.json) {
				io.stdout(`${JSON.stringify({ provider, accounts: entries }, null, 2)}\n`);
			} else if (entries.length === 0) {
				io.stdout(`No stored ${provider} OAuth accounts.\n`);
			} else {
				const lines = [`${provider} OAuth accounts:`];
				for (const entry of entries) {
					const state = entry.pausedAt
						? `Paused since ${entry.pausedAt}`
						: entry.state === "paused"
							? "Paused"
							: "Active";
					lines.push(`  #${entry.credentialId}  ${entry.label}  ${state}`);
				}
				io.stdout(`${lines.join("\n")}\n`);
			}
			return 0;
		}

		const account = resolveAccount(provider, accounts, input.selector);
		const pause = input.verb === "pause";
		const { changed } = pause
			? authStorage.credentials.pause(provider, account.credentialId)
			: authStorage.credentials.resume(provider, account.credentialId);
		const label = oauthAccountLabel(account);
		if (input.json) {
			io.stdout(
				`${JSON.stringify({ ok: true, provider, credentialId: account.credentialId, state: pause ? "paused" : "active", changed })}\n`,
			);
		} else if (changed) {
			io.stdout(`${pause ? "Paused" : "Resumed"} #${account.credentialId} (${label}) for ${provider}.\n`);
		} else {
			io.stdout(`#${account.credentialId} (${label}) is already ${pause ? "paused" : "active"} for ${provider}.\n`);
		}
		if (pause && changed && !input.json) {
			for (const warning of pauseWarnings(provider, authStorage.oauth.accounts(provider), account.credentialId)) {
				io.stderr(`Warning: ${warning}\n`);
			}
		}
		return 0;
	} catch (error) {
		const code: AuthErrorCode =
			error instanceof AuthCommandError || error instanceof OAuthAccountPoolError ? error.code : "error";
		const message = error instanceof Error ? error.message : String(error);
		if (input.json) {
			io.stdout(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
		} else {
			io.stderr(`Error: ${message}\n`);
		}
		return 1;
	}
}

export default class Auth extends Command {
	static description = commandHelp.description;
	static args = {
		verb: Args.string({ description: "list, pause, or resume", required: false }),
		provider: Args.string({ description: "OAuth provider id (e.g. openai-codex)", required: false }),
		credential: Args.string({
			description: "Durable credential id from `omp auth list` (17 or #17)",
			required: false,
		}),
	};
	static flags = {
		json: Flags.boolean({ description: "Output JSON", default: false }),
	};
	static examples = [
		"# List stored Codex accounts with ids and Active/Paused state\n  omp auth list openai-codex",
		"# Pause credential 17 for every running omp process\n  omp auth pause openai-codex 17",
		"# Resume it\n  omp auth resume openai-codex 17 --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Auth);
		const authStorage = await discoverAuthStorage();
		try {
			process.exitCode = await runAuthCommand(
				authStorage,
				{ verb: args.verb ?? "", provider: args.provider, selector: args.credential, json: flags.json },
				{ stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) },
			);
		} finally {
			authStorage.close();
		}
	}
}
