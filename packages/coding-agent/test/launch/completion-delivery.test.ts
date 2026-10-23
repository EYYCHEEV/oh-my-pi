import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { IpcConnection } from "@oh-my-pi/pi-natives";
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
	// Bounded by event-loop turns, not time: fake timers freeze every clock, so a missed condition
	// would otherwise spin forever instead of failing.
	for (let turn = 0; turn < 200_000; turn++) {
		if (await predicate()) return;
		await scheduler.yield();
	}
	throw new Error("Timed out waiting for completion settlement");
}

/** The broker connection opened by the `index`th `IpcConnection.connect` call. */
async function connectionAt(
	connections: { mock: { results: ReadonlyArray<{ value: unknown }> } },
	index: number,
): Promise<IpcConnection> {
	await waitUntil(() => connections.mock.results[index] !== undefined);
	const connection = await connections.mock.results[index]?.value;
	if (!(connection instanceof IpcConnection)) throw new Error(`Expected broker connection ${index}`);
	return connection;
}

/** Event-loop turns, not time: lets queued I/O callbacks run before the caller asserts an absence. */
async function flushTurns(turns = 2_000): Promise<void> {
	for (let turn = 0; turn < turns; turn++) await scheduler.yield();
}

/**
 * Observes the client's native close callbacks. `IpcConnection.closed` flips as soon as
 * `destroy()` runs, but the callback that schedules the reconnect timer reaches JS later, so the
 * returned function waits for that callback to finish for one connection.
 */
function observeCloseCallbacks(): (connection: IpcConnection) => Promise<void> {
	const settled = new Map<IpcConnection, Promise<void>>();
	const start = IpcConnection.prototype.start;
	vi.spyOn(IpcConnection.prototype, "start").mockImplementation(function (
		this: IpcConnection,
		onLine: (line: string) => void,
		onClose: (reason: string | null) => void,
	) {
		const done = Promise.withResolvers<void>();
		settled.set(this, done.promise);
		return start.call(this, onLine, reason => {
			try {
				onClose(reason);
			} finally {
				done.resolve();
			}
		});
	});
	return async connection => {
		const done = settled.get(connection);
		if (!done) throw new Error("Broker connection was never started");
		let finished = false;
		void done.then(() => {
			finished = true;
		});
		await waitUntil(() => finished);
	};
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
			const connections = vi.spyOn(IpcConnection, "connect");
			const closeObserved = observeCloseCallbacks();
			let deliveries = 0;
			let recovered = false;
			vi.useFakeTimers();
			try {
				client.onCompletion(notification.owner, () => {
					deliveries++;
					if (!recovered) throw new Error("Temporary completion consumer failure");
				});
				const initialSocket = await connectionAt(connections, 0);
				await client.request({ op: "ping" }).catch(() => undefined);
				await closeObserved(initialSocket);

				for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
					const before = connections.mock.calls.length;
					vi.advanceTimersByTime(delay - 1);
					await flushTurns();
					expect(connections.mock.calls.length).toBe(before);
					vi.advanceTimersByTime(1);
					// The reconnect reads the token file before it connects, so the call lands a few turns later.
					await waitUntil(() => connections.mock.calls.length === before + 1);
					const socket = await connectionAt(connections, before);
					await closeObserved(socket);
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

	it("restores the normal reconnect delay after a transient failure becomes stale", async () => {
		const sessionManager = SessionManager.inMemory();
		const notification = completion("retired-retry", "other-session");
		await withBroker(sessionManager, [notification], async ({ client, session, pending }) => {
			const warnings = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
			const connections = vi.spyOn(IpcConnection, "connect");
			const closeObserved = observeCloseCallbacks();
			let deliveries = 0;
			vi.useFakeTimers();
			try {
				client.onCompletion(notification.owner, value => {
					deliveries++;
					if (deliveries === 1) throw new Error("Temporary completion consumer failure");
					return session.queueLaunchCompletion(value);
				});
				client.onCompletion(sessionManager.getSessionId(), value => session.queueLaunchCompletion(value));
				const initialSocket = await connectionAt(connections, 0);
				await client.request({ op: "ping" }).catch(() => undefined);
				await closeObserved(initialSocket);

				vi.advanceTimersByTime(1_000);
				await waitUntil(() => deliveries === 2 && warnings.mock.calls.length === 2);
				await client.request({ op: "ping" });
				const socket = await connectionAt(connections, 1);
				socket.destroy();
				await closeObserved(socket);

				const before = connections.mock.calls.length;
				vi.advanceTimersByTime(49);
				await flushTurns();
				expect(connections.mock.calls.length).toBe(before);
				vi.advanceTimersByTime(1);
				await waitUntil(() => connections.mock.calls.length === before + 1);
				await client.request({ op: "ping" });
				expect(deliveries).toBe(2);
				expect((await pending("retired-retry")).map(value => value.completionId)).toEqual([
					"retired-retry-completion",
				]);
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
