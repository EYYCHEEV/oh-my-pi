import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	type AuthBrokerClient,
	type FetchSnapshotResult,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
} from "@oh-my-pi/pi-ai/auth-broker";
import { type AuthCommandInput, runAuthCommand } from "@oh-my-pi/pi-coding-agent/commands/auth";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "openai-codex";
const TOKEN_MARKER = "SECRET-TOKEN";

function codexCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `${TOKEN_MARKER}-access-${suffix}`,
		refresh: `${TOKEN_MARKER}-refresh-${suffix}`,
		expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
		accountId: `acct-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

describe("omp auth", () => {
	let tempDir: TempDir | undefined;
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage;
	let ids: Record<string, number>;
	const transcripts: string[] = [];

	async function run(storageUnderTest: AuthStorage, input: AuthCommandInput): Promise<Run> {
		let stdout = "";
		let stderr = "";
		const code = await runAuthCommand(storageUnderTest, input, {
			stdout: text => {
				stdout += text;
			},
			stderr: text => {
				stderr += text;
			},
		});
		transcripts.push(stdout, stderr);
		return { code, stdout, stderr };
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-auth-command-");
		store = await SqliteAuthCredentialStore.open(tempDir.join("agent.db"));
		storage = new AuthStorage(store);
		await storage.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		ids = Object.fromEntries(
			storage.oauth
				.accounts(PROVIDER)
				.map(account => [account.accountId!.replace("acct-", ""), account.credentialId]),
		);
	});

	afterEach(() => {
		store?.close();
		store = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
		for (const text of transcripts) expect(text).not.toContain(TOKEN_MARKER);
		transcripts.length = 0;
	});

	it("lists accounts as JSON with ids, labels, fingerprints, and state", async () => {
		storage.credentials.pause(PROVIDER, ids.b!);
		const result = await run(storage, { verb: "list", provider: PROVIDER, json: true });
		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		const pausedAt = parsed.accounts[1].pausedAt;
		expect(typeof pausedAt).toBe("string");
		expect(Number.isNaN(Date.parse(pausedAt))).toBe(false);
		expect(parsed).toEqual({
			provider: PROVIDER,
			accounts: [
				{
					credentialId: ids.a,
					position: 1,
					label: "a@example.com",
					fingerprint: credentialPinHash(PROVIDER, { accountId: "acct-a", email: "a@example.com" }),
					state: "active",
					pausedAt: null,
				},
				{
					credentialId: ids.b,
					position: 2,
					label: "b@example.com",
					fingerprint: credentialPinHash(PROVIDER, { accountId: "acct-b", email: "b@example.com" }),
					state: "paused",
					pausedAt,
				},
			],
		});
		for (const account of parsed.accounts) {
			expect(Object.keys(account).sort()).toEqual(
				["credentialId", "fingerprint", "label", "pausedAt", "position", "state"].sort(),
			);
		}
	});

	it("lists accounts as text", async () => {
		storage.credentials.pause(PROVIDER, ids.b!);
		const result = await run(storage, { verb: "list", provider: PROVIDER });
		expect(result.code).toBe(0);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines[0]).toBe("openai-codex OAuth accounts:");
		expect(lines[1]).toBe(`  #${ids.a}  a@example.com  Active`);
		expect(lines[2]).toMatch(new RegExp(`^  #${ids.b}  b@example\\.com  Paused since \\S+`));
	});

	it("emits a null fingerprint for an account without identity", async () => {
		await storage.credentials.set(PROVIDER, [
			{
				type: "oauth",
				access: `${TOKEN_MARKER}-anon`,
				refresh: `${TOKEN_MARKER}-anon-refresh`,
				expires: Date.now() + 60_000,
			},
		]);
		const result = await run(storage, { verb: "list", provider: PROVIDER, json: true });
		const [account] = JSON.parse(result.stdout).accounts;
		expect(account.fingerprint).toBeNull();
		expect(account.label).toBe(`OAuth credential #${account.credentialId}`);
	});

	it("pauses and resumes idempotently with JSON and text output", async () => {
		const first = await run(storage, { verb: "pause", provider: PROVIDER, selector: String(ids.a), json: true });
		expect(first.code).toBe(0);
		expect(JSON.parse(first.stdout)).toEqual({
			ok: true,
			provider: PROVIDER,
			credentialId: ids.a,
			state: "paused",
			changed: true,
		});
		expect(storage.credentials.isAutoSelectable(PROVIDER, ids.a!)).toBe(false);

		const repeat = await run(storage, { verb: "pause", provider: PROVIDER, selector: `#${ids.a}`, json: true });
		expect(JSON.parse(repeat.stdout).changed).toBe(false);

		const text = await run(storage, { verb: "resume", provider: PROVIDER, selector: `#${ids.a}` });
		expect(text.code).toBe(0);
		expect(text.stdout).toBe(`Resumed #${ids.a} (a@example.com) for openai-codex.\n`);
		expect(storage.credentials.isAutoSelectable(PROVIDER, ids.a!)).toBe(true);

		const again = await run(storage, { verb: "resume", provider: PROVIDER, selector: String(ids.a) });
		expect(again.stdout).toBe(`#${ids.a} (a@example.com) is already active for openai-codex.\n`);

		const paused = await run(storage, { verb: "pause", provider: PROVIDER, selector: String(ids.b) });
		expect(paused.stdout).toBe(`Paused #${ids.b} (b@example.com) for openai-codex.\n`);
	});

	it("rejects unknown ids and selectors that look like list positions", async () => {
		const unknownId = Math.max(ids.a!, ids.b!) + 100;
		const unknown = await run(storage, {
			verb: "pause",
			provider: PROVIDER,
			selector: String(unknownId),
			json: true,
		});
		expect(unknown.code).toBe(1);
		expect(JSON.parse(unknown.stdout)).toEqual({
			ok: false,
			error: {
				code: "unknown_credential",
				message: `No stored openai-codex OAuth account has credential id ${unknownId}. List them with \`omp auth list openai-codex\`.`,
			},
		});

		for (const selector of ["2.", "first", "a@example.com", "-1", "1-2"]) {
			const invalid = await run(storage, { verb: "pause", provider: PROVIDER, selector, json: true });
			expect(invalid.code).toBe(1);
			expect(JSON.parse(invalid.stdout).error.code).toBe("invalid_selector");
		}

		const textError = await run(storage, { verb: "resume", provider: PROVIDER, selector: "first" });
		expect(textError.code).toBe(1);
		expect(textError.stdout).toBe("");
		expect(textError.stderr).toContain("durable credential id");
	});

	it("rejects a missing selector and unknown verbs", async () => {
		const missing = await run(storage, { verb: "pause", provider: PROVIDER, json: true });
		expect(missing.code).toBe(1);
		expect(JSON.parse(missing.stdout).error.code).toBe("invalid_selector");
		const verb = await run(storage, { verb: "delete", provider: PROVIDER, selector: "1", json: true });
		expect(verb.code).toBe(1);
		expect(JSON.parse(verb.stdout).error.code).toBe("invalid_arguments");
	});

	it("fails closed on every verb with an auth broker", async () => {
		const snapshot: SnapshotResponse = {
			generation: 1,
			generatedAt: Date.now(),
			serverNowMs: Date.now(),
			refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
			credentials: [
				{
					id: 7,
					provider: PROVIDER,
					credential: { ...codexCredential("broker"), refresh: REMOTE_REFRESH_SENTINEL },
					identityKey: "account:acct-broker",
					rotatesInMs: null,
				},
			],
		};
		const client = {
			async fetchSnapshot(opts: { ifGenerationGt?: number } = {}): Promise<FetchSnapshotResult> {
				if (opts.ifGenerationGt !== undefined) return { status: 304, generation: snapshot.generation };
				return { status: 200, snapshot, generation: snapshot.generation };
			},
		};
		const remote = new RemoteAuthCredentialStore({
			client: client as unknown as AuthBrokerClient,
			initialSnapshot: snapshot,
			streamSnapshots: false,
			backgroundIdleMs: 0,
		});
		const brokerStorage = new AuthStorage(remote);
		try {
			for (const input of [
				{ verb: "list", provider: PROVIDER, json: true },
				{ verb: "pause", provider: PROVIDER, selector: "7", json: true },
				{ verb: "resume", provider: PROVIDER, selector: "7", json: true },
			] satisfies AuthCommandInput[]) {
				const result = await run(brokerStorage, input);
				expect(result.code).toBe(1);
				const parsed = JSON.parse(result.stdout);
				expect(parsed.ok).toBe(false);
				expect(parsed.error.code).toBe("broker_unsupported");
				expect(parsed.error.message).toContain("not supported with an auth broker");
			}
			const text = await run(brokerStorage, { verb: "list", provider: PROVIDER });
			expect(text.code).toBe(1);
			expect(text.stderr).toContain("not supported with an auth broker");
		} finally {
			brokerStorage.close();
		}
	});
});

describe("omp auth CLI entrypoint", () => {
	it("runs `auth list --json` against the agent directory", async () => {
		using tempDir = TempDir.createSync("@omp-auth-cli-");
		const dbPath = tempDir.join("agent.db");
		const seedStore = await SqliteAuthCredentialStore.open(dbPath);
		const seed = new AuthStorage(seedStore);
		await seed.credentials.set(PROVIDER, [codexCredential("a"), codexCredential("b")]);
		const [, b] = seed.oauth.accounts(PROVIDER);
		seed.credentials.pause(PROVIDER, b!.credentialId);
		seed.close();

		const proc = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "..", "src", "cli.ts"), "auth", "list", PROVIDER, "--json"],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					...process.env,
					NO_COLOR: "1",
					OMP_AUTH_BROKER_TOKEN: undefined,
					OMP_AUTH_BROKER_URL: undefined,
					PI_CODING_AGENT_DIR: tempDir.path(),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).not.toContain(TOKEN_MARKER);
		expect(stderr).not.toContain(TOKEN_MARKER);
		const parsed = JSON.parse(stdout);
		expect(parsed.provider).toBe(PROVIDER);
		expect(parsed.accounts.map((account: { state: string }) => account.state)).toEqual(["active", "paused"]);
	}, 30_000);
});
