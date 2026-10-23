/**
 * `omp auth`: stored provider credentials.
 *
 * `omp auth export` prints every active credential in the local credential
 * store (`agent.db`) as JSON — API keys and OAuth logins, refresh tokens
 * included. `omp auth import <file>` merges such a file into the local store:
 * an imported OAuth login replaces the stored login of the same provider
 * account, an imported API key replaces the provider's stored API key, and
 * everything else is kept.
 *
 * `omp auth list|pause|resume <provider> [credential-id] [--json]`: scriptable
 * control of the persisted OAuth account pause. Accounts are addressed only by
 * their durable credential id; output never includes token bytes.
 */
import {
	type AuthCredential,
	type AuthCredentialStore,
	isSameOAuthAccount,
	matchesReplacementCredential,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	resolveCredentialIdentityKey,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { OAuthAccountPoolError } from "@oh-my-pi/pi-ai/error";
import { getAgentDbPath, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { authHelp as commandHelp } from "../cli/command-help";
import { discoverAuthStorage } from "../sdk";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import type { AuthStorage, OAuthAccountSummary } from "../session/auth-storage";
import { credentialPinHash } from "../session/credential-pin";
import { ACCOUNT_PAUSE_BROKER_MESSAGE, pauseWarnings } from "../slash-commands/helpers/account-pause";
import { oauthAccountLabel } from "../slash-commands/helpers/session-pin";

/** Format version of the `omp auth export` document. */
export const AUTH_EXPORT_VERSION = 1;

/** One stored credential in an `omp auth export` document. */
export interface AuthExportEntry {
	/** Provider id the credential authenticates (e.g. `anthropic`). */
	provider: string;
	/** The credential exactly as stored, OAuth refresh token included. */
	credential: AuthCredential;
}

/** The document `omp auth export` prints and `omp auth import` reads. */
export interface AuthExport {
	version: typeof AUTH_EXPORT_VERSION;
	credentials: AuthExportEntry[];
}

/** Result of {@link importAuthCredentials}. */
export interface AuthImportSummary {
	/** Number of credentials written. */
	imported: number;
	/** Providers that received credentials, in first-seen order. */
	providers: string[];
}

/** A malformed or unsupported credential export. */
export class AuthTransferError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthTransferError";
	}
}

/** Every active credential in `store`, in storage order. */
export function exportAuthCredentials(store: Pick<AuthCredentialStore, "listAuthCredentials">): AuthExport {
	return {
		version: AUTH_EXPORT_VERSION,
		credentials: store.listAuthCredentials().map(row => ({ provider: row.provider, credential: row.credential })),
	};
}

function parseCredential(value: unknown, where: string): AuthCredential {
	if (!isRecord(value)) throw new AuthTransferError(`${where}: credential is not an object.`);
	if (value.type === "api_key") {
		if (typeof value.key !== "string" || value.key.length === 0) {
			throw new AuthTransferError(`${where}: API key credential has no key.`);
		}
		return value.source === "login"
			? { type: "api_key", key: value.key, source: "login" }
			: { type: "api_key", key: value.key };
	}
	if (value.type === "oauth") {
		if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") {
			throw new AuthTransferError(
				`${where}: OAuth credential needs string access/refresh tokens and a numeric expires.`,
			);
		}
		if (value.refresh === REMOTE_REFRESH_SENTINEL) {
			throw new AuthTransferError(
				`${where}: OAuth credential has no refresh token (it comes from an auth-broker snapshot).`,
			);
		}
		// Required fields are checked above; the optional identity fields are
		// carried as stored so the target store derives the same account identity.
		return value as OAuthCredential;
	}
	throw new AuthTransferError(`${where}: unknown credential type ${JSON.stringify(value.type)}.`);
}

/**
 * Parse and validate an `omp auth export` document. Throws
 * {@link AuthTransferError} naming the first offending entry.
 */
export function parseAuthExport(text: string, source = "credential file"): AuthExport {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new AuthTransferError(`${source} is not valid JSON.`);
	}
	if (!isRecord(value)) throw new AuthTransferError(`${source} is not an \`omp auth export\` document.`);
	if (value.version !== AUTH_EXPORT_VERSION) {
		throw new AuthTransferError(
			`${source} has export version ${JSON.stringify(value.version)}; this omp reads version ${AUTH_EXPORT_VERSION}.`,
		);
	}
	if (!Array.isArray(value.credentials)) throw new AuthTransferError(`${source} has no credentials array.`);
	const credentials = value.credentials.map((entry: unknown, index): AuthExportEntry => {
		const where = `${source}: credentials[${index}]`;
		if (!isRecord(entry) || typeof entry.provider !== "string" || entry.provider.length === 0) {
			throw new AuthTransferError(`${where} has no provider.`);
		}
		return {
			provider: entry.provider,
			credential: parseCredential(entry.credential, `${where} (${entry.provider})`),
		};
	});
	return { version: AUTH_EXPORT_VERSION, credentials };
}

/**
 * Whether importing `incoming` for `provider` replaces the stored `existing`
 * credential: an API key replaces the provider's API key; an OAuth login
 * replaces the stored login of the same account.
 */
function replacesCredential(provider: string, existing: AuthCredential, incoming: AuthCredential): boolean {
	if (incoming.type === "api_key") return existing.type === "api_key";
	if (existing.type !== "oauth") return false;
	return (
		matchesReplacementCredential(provider, existing, resolveCredentialIdentityKey(provider, existing), incoming) ||
		isSameOAuthAccount(existing, incoming)
	);
}

/**
 * Merge `data` into `store`, one provider at a time: stored credentials that
 * an imported one replaces (same provider and account) are swapped for it,
 * all others are kept. Each provider is written in one store transaction.
 */
export async function importAuthCredentials(
	store: Pick<AuthCredentialStore, "listAuthCredentials" | "replaceAuthCredentials">,
	data: AuthExport,
): Promise<AuthImportSummary> {
	const byProvider = new Map<string, AuthCredential[]>();
	for (const { provider, credential } of data.credentials) {
		const list = byProvider.get(provider);
		if (list) list.push(credential);
		else byProvider.set(provider, [credential]);
	}
	for (const [provider, incoming] of byProvider) {
		let merged = store.listAuthCredentials(provider).map(row => row.credential);
		for (const credential of incoming) {
			merged = merged.filter(existing => !replacesCredential(provider, existing, credential));
			merged.push(credential);
		}
		await store.replaceAuthCredentials(provider, merged);
	}
	return { imported: data.credentials.length, providers: [...byProvider.keys()] };
}

/** Account-pause verbs, handled by {@link runAuthCommand}. */
const PAUSE_VERBS = ["list", "pause", "resume"] as const;
type AuthVerb = (typeof PAUSE_VERBS)[number];

/** Parsed `omp auth list|pause|resume` invocation. */
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
 * Run one `omp auth list|pause|resume` verb against `authStorage`. Returns the
 * process exit code. Every verb fails closed on auth-broker stores, which
 * cannot persist pauses.
 */
export async function runAuthCommand(
	authStorage: AuthStorage,
	input: AuthCommandInput,
	io: AuthCommandIo,
): Promise<number> {
	const provider = input.provider?.trim().toLowerCase();
	try {
		if (!PAUSE_VERBS.includes(input.verb as AuthVerb) || !provider) {
			throw new AuthCommandError(
				"invalid_arguments",
				"Usage: omp auth export | import <file|-> | list <provider> | pause <provider> <credential-id> | resume <provider> <credential-id> [--json]",
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

/** `omp auth export` and `omp auth import <file|->`. `argv` is the positional list after the command name. */
async function runAuthTransfer(action: "export" | "import", file: string | undefined, argv: string[]): Promise<void> {
	if (action === "export" && argv.length > 1) {
		throw new CliUsageError(`Unexpected argument "${argv[1]}". Usage: omp auth export`);
	}
	if (action === "import" && !file) {
		throw new CliUsageError("Missing credential file. Usage: omp auth import <file|->");
	}
	if (action === "import" && argv.length > 2) {
		throw new CliUsageError(`Unexpected argument "${argv[2]}". Usage: omp auth import <file|->`);
	}

	const broker = await resolveAuthBrokerConfig();
	if (broker) {
		process.stderr.write(
			`${chalk.red(`error: omp uses the auth broker at ${broker.url}; credentials live there, not in this machine's agent.db.`)}\n` +
				"Run this on the broker host, or disable the broker (`omp config reset auth.broker.url`) first.\n",
		);
		process.exitCode = 1;
		return;
	}

	if (action === "export") {
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		let data: AuthExport;
		try {
			data = exportAuthCredentials(store);
		} finally {
			store.close();
		}
		const oauthCount = data.credentials.filter(entry => entry.credential.type === "oauth").length;
		if (oauthCount > 0) {
			process.stderr.write(
				`${chalk.yellow(`warning: this output holds live secrets, including ${oauthCount} OAuth refresh token(s). Providers that rotate refresh tokens on use accept only the newest one: once the importing machine refreshes, this machine may be signed out of those accounts.`)}\n`,
			);
		}
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
		return;
	}

	const path = file ?? "";
	let text: string;
	try {
		text = path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
	} catch (error) {
		if (!isEnoent(error)) throw error;
		process.stderr.write(`${chalk.red(`error: credential file not found: ${path}`)}\n`);
		process.exitCode = 1;
		return;
	}
	let data: AuthExport;
	try {
		data = parseAuthExport(text, path === "-" ? "stdin" : path);
	} catch (error) {
		if (!(error instanceof AuthTransferError)) throw error;
		process.stderr.write(`${chalk.red(`error: ${error.message}`)}\n`);
		process.exitCode = 1;
		return;
	}
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	try {
		const summary = await importAuthCredentials(store, data);
		process.stderr.write(
			summary.imported === 0
				? "No credentials to import.\n"
				: `Imported ${summary.imported} credential(s) for ${summary.providers.join(", ")}.\n`,
		);
	} finally {
		store.close();
	}
}

export default class Auth extends Command {
	static description = commandHelp.description;

	// Not `required`/`options`-checked at parse time: a missing or unknown verb is reported by
	// `runAuthCommand` so `--json` callers get a machine-readable `invalid_arguments` error.
	static args = {
		verb: Args.string({ description: "export, import, list, pause, or resume", required: false }),
		target: Args.string({
			description:
				"import: file written by `omp auth export`, or - for stdin; list, pause, resume: OAuth provider id (e.g. openai-codex)",
			required: false,
		}),
		credential: Args.string({
			description: "pause, resume: durable credential id from `omp auth list` (17 or #17)",
			required: false,
		}),
	};
	static flags = {
		json: Flags.boolean({ description: "Output JSON (list, pause, resume)", default: false }),
	};
	static examples = [
		"# Write every stored credential to a file (keep it secret)\n  omp auth export > credentials.json",
		"# Merge them into this machine's credential store\n  omp auth import credentials.json",
		"# Copy credentials to another machine over SSH\n  omp auth export | ssh host omp auth import -",
		"# List stored Codex accounts with ids and Active/Paused state\n  omp auth list openai-codex",
		"# Pause credential 17 for every running omp process\n  omp auth pause openai-codex 17",
		"# Resume it\n  omp auth resume openai-codex 17 --json",
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Auth);
		const verb = args.verb ?? "";
		if (verb === "export" || verb === "import") {
			if (flags.json) {
				throw new CliUsageError("--json applies only to `omp auth list|pause|resume`.");
			}
			await runAuthTransfer(verb, args.target, argv);
			return;
		}
		const authStorage = await discoverAuthStorage();
		try {
			process.exitCode = await runAuthCommand(
				authStorage,
				{ verb, provider: args.target, selector: args.credential, json: flags.json },
				{ stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) },
			);
		} finally {
			authStorage.close();
		}
	}
}
