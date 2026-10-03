import { afterEach, describe, expect, it, vi } from "bun:test";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as brokerClients from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
} from "../../src/launch/protocol";
import { listServices } from "../../src/launch/services";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";

function completion(name: string, owner: string): DaemonCompletionNotification {
	return {
		event: "daemon-completed",
		completionId: `${name}-completion`,
		owner,
		daemon: {
			name,
			id: name,
			state: "failed",
			createdAt: 1,
			startedAt: 1,
			exitedAt: 2,
			exitCode: 3,
			restartCount: 0,
			outputBytes: 0,
			owner,
			persist: false,
			detached: false,
		},
	};
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = performance.now() + 5_000;
	while (!(await predicate())) {
		if (performance.now() >= deadline) throw new Error("Timed out waiting for completion settlement");
		await scheduler.yield();
	}
}

interface CompletionHarness {
	client: brokerClients.DaemonBrokerClient;
	session: AgentSession;
	projectDir: string;
	pending(name: string): Promise<DaemonCompletionNotification[]>;
}

async function withBroker(
	sessionManager: SessionManager,
	completions: DaemonCompletionNotification[],
	run: (harness: CompletionHarness) => Promise<void>,
): Promise<void> {
	using temp = TempDir.createSync("@omp-completion-delivery-");
	const projectDir = path.join(temp.path(), "project");
	const runtimeDir = path.join(temp.path(), "runtime");
	await fs.mkdir(projectDir);
	for (const notification of completions) {
		await Bun.write(
			path.join(runtimeDir, "daemons", notification.daemon.name, "meta.json"),
			JSON.stringify({
				daemon: notification.daemon,
				spec: {
					name: notification.daemon.name,
					application: process.execPath,
					args: [],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
				completionEvents: true,
				pendingCompletions: [notification],
			}),
		);
	}
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		}),
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
	});
	// The retry test advances beyond the 30-second cap without letting the
	// embedded broker's last-client timer spawn an untracked replacement worker.
	const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 300_000 });
	const previousTitle = process.title;
	const previousEnvironment: Record<string, string | undefined> = {
		[DAEMON_PROJECT_DIR_ENV]: process.env[DAEMON_PROJECT_DIR_ENV],
		[DAEMON_RUNTIME_DIR_ENV]: process.env[DAEMON_RUNTIME_DIR_ENV],
		[DAEMON_IDLE_GRACE_ENV]: process.env[DAEMON_IDLE_GRACE_ENV],
	};
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "300000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	for (const [key, value] of Object.entries(previousEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		if (!(await Promise.race([listening.promise, finished.then(() => false)]))) {
			throw new Error("In-process completion broker did not claim its scope");
		}
		await run({
			client,
			session,
			projectDir,
			pending: async name => {
				const meta = (await Bun.file(path.join(runtimeDir, "daemons", name, "meta.json")).json()) as {
					pendingCompletions: DaemonCompletionNotification[];
				};
				return meta.pendingCompletions;
			},
		});
	} finally {
		// No daemon children are launched: these are terminal persisted fixtures.
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await finished;
		await session.dispose();
		authStorage.close();
		process.title = previousTitle;
	}
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("daemon completion delivery recovery", () => {
	it("retires persisted Main completions without redelivery and routes service notifications by session identity", async () => {
		const sessionManager = SessionManager.inMemory();
		const legacy = completion("legacy", "Main");
		const current = completion("current", sessionManager.getSessionId());
		const later = completion("later", "later-session");
		await withBroker(sessionManager, [legacy, current, later], async ({ client, session, projectDir, pending }) => {
			vi.spyOn(logger, "warn").mockImplementation(() => undefined);
			vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
			const deliveries: string[] = [];
			const tools: ToolSession = {
				cwd: projectDir,
				hasUI: false,
				settings: Settings.isolated(),
				getAgentId: () => "Main",
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				sessionManager,
				queueLaunchCompletion: notification => {
					deliveries.push(notification.owner);
					return session.queueLaunchCompletion(notification);
				},
			};
			await listServices(tools);
			await waitUntil(() => deliveries.length > 0);
			expect(deliveries).toEqual([sessionManager.getSessionId()]);
			await waitUntil(async () => (await pending("legacy")).length === 0);
			await waitUntil(async () => (await pending("current")).length === 0);
			expect((await pending("later")).map(value => value.completionId)).toEqual(["later-completion"]);
		});
	}, 10_000);

	it("detaches a stale session without reconnecting or deleting a completion needed on resume", async () => {
		const sessionManager = SessionManager.inMemory();
		const notification = completion("resumable", "other-session");
		await withBroker(sessionManager, [notification], async ({ client, session, pending }) => {
			const warnings = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
			let deliveries = 0;
			vi.useFakeTimers();
			try {
				client.onCompletion(notification.owner, value => {
					deliveries++;
					return session.queueLaunchCompletion(value);
				});
				await client.request({ op: "ping" });
				vi.advanceTimersByTime(1);
				await waitUntil(() => warnings.mock.calls.length > 0);
				// Real socket round trips let each fake-clock retry finish before the next tick.
				for (let retry = 0; retry < 5; retry++) {
					vi.advanceTimersByTime(1_000);
					await client.request({ op: "ping" }).catch(() => undefined);
				}
				expect(deliveries).toBe(1);
				expect((await pending("resumable")).map(value => value.completionId)).toEqual(["resumable-completion"]);

				const resumed: string[] = [];
				client.onCompletion(notification.owner, value => {
					resumed.push(value.completionId);
				});
				await client.request({ op: "ping" });
				await waitUntil(async () => (await pending("resumable")).length === 0);
				expect(resumed).toEqual(["resumable-completion"]);
			} finally {
				vi.useRealTimers();
			}
		});
	}, 10_000);

	it("backs off transient failures to a capped delay and still delivers after recovery", async () => {
		const sessionManager = SessionManager.inMemory();
		const notification = completion("retryable", sessionManager.getSessionId());
		await withBroker(sessionManager, [notification], async ({ client, pending }) => {
			const warnings = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
			const connections = vi.spyOn(net, "createConnection");
			let deliveries = 0;
			let recovered = false;
			vi.useFakeTimers();
			try {
				client.onCompletion(notification.owner, () => {
					deliveries++;
					if (!recovered) throw new Error("Temporary completion consumer failure");
				});
				const initialSocket = connections.mock.results[0]!.value;
				if (!(initialSocket instanceof net.Socket)) throw new Error("Expected the initial broker socket");
				const initiallyClosed = once(initialSocket, "close");
				await client.request({ op: "ping" }).catch(() => undefined);
				await initiallyClosed;
				await scheduler.yield();

				for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
					const before = connections.mock.calls.length;
					vi.advanceTimersByTime(delay - 1);
					expect(connections.mock.calls.length).toBe(before);
					vi.advanceTimersByTime(1);
					expect(connections.mock.calls.length).toBe(before + 1);
					const socket = connections.mock.results[before]!.value;
					if (!(socket instanceof net.Socket)) throw new Error("Expected the reconnected broker socket");
					await once(socket, "close");
					await scheduler.yield();
				}
				expect((await pending("retryable")).map(value => value.completionId)).toEqual(["retryable-completion"]);
				recovered = true;
				vi.advanceTimersByTime(30_000);
				await waitUntil(async () => (await pending("retryable")).length === 0);
				expect(deliveries).toBe(9);
				expect(warnings).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});
	}, 10_000);

	it("preserves an in-flight receipt when its session disposes before dispatch", async () => {
		const sessionManager = SessionManager.inMemory();
		const notification = completion("disposed", sessionManager.getSessionId());
		await withBroker(sessionManager, [notification], async ({ client, session, pending }) => {
			const warnings = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
			let deliveries = 0;
			vi.useFakeTimers();
			try {
				client.onCompletion(notification.owner, value => {
					deliveries++;
					return session.queueLaunchCompletion(value);
				});
				await client.request({ op: "ping" });
				await session.dispose();
				await waitUntil(() => warnings.mock.calls.length > 0);
				for (let retry = 0; retry < 5; retry++) {
					vi.advanceTimersByTime(1_000);
					await client.request({ op: "ping" });
				}
				expect(deliveries).toBe(1);
				expect((await pending("disposed")).map(value => value.completionId)).toEqual(["disposed-completion"]);
			} finally {
				vi.useRealTimers();
			}
		});
	}, 10_000);

	it("refuses a completion-capable service consumer without a session identity", async () => {
		await withBroker(SessionManager.inMemory(), [], async ({ client, projectDir }) => {
			vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);
			await expect(
				listServices({
					cwd: projectDir,
					hasUI: false,
					settings: Settings.isolated(),
					getAgentId: () => "Main",
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					queueLaunchCompletion: async () => undefined,
				}),
			).rejects.toThrow("requires a session ID");
		});
	}, 10_000);
});
