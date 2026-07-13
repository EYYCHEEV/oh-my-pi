import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	disposeAllKernelSessions,
	disposeKernelSessionsByOwner,
	executePython,
	hasPythonKernelSession,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelShutdownResult,
} from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { createPythonRuntimeProfile } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

class FakeKernel {
	executeCalls = 0;
	shutdownCalls = 0;
	alive = true;
	shutdownConfirmed = true;
	readonly id: string;

	constructor(id: string) {
		this.id = id;
	}

	async execute(_code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.executeCalls += 1;
		options?.onChunk?.("ok\n");
		return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
	}

	async shutdown(): Promise<KernelShutdownResult> {
		this.shutdownCalls += 1;
		if (this.shutdownConfirmed) this.alive = false;
		return { confirmed: this.shutdownConfirmed };
	}

	isAlive(): boolean {
		return this.alive;
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}
}

describe("executePython kernel reuse", () => {
	const originalStart = PythonKernel.start;
	let startCalls = 0;
	let kernels: FakeKernel[] = [];

	beforeEach(() => {
		Bun.env.PI_PYTHON_SKIP_CHECK = "1";
		startCalls = 0;
		kernels = [];
		PythonKernel.start = (async () => {
			startCalls += 1;
			const kernel = new FakeKernel(`kernel-${startCalls}`);
			kernels.push(kernel);
			return kernel as unknown as PythonKernel;
		}) as typeof PythonKernel.start;
	});

	afterEach(async () => {
		PythonKernel.start = originalStart;
		await disposeAllKernelSessions();
	});

	it("reuses kernels for session mode", async () => {
		using tempDir = TempDir.createSync("@python-kernel-session-");
		await executePython("print('one')", { cwd: tempDir.path(), sessionId: "session-a", kernelMode: "session" });
		await executePython("print('two')", { cwd: tempDir.path(), sessionId: "session-a", kernelMode: "session" });

		expect(startCalls).toBe(1);
		expect(kernels[0]?.executeCalls).toBe(2);
		expect(hasPythonKernelSession("session-a", tempDir.path())).toBe(true);
	});

	it("isolates retained kernels by runtime profile", async () => {
		using tempDir = TempDir.createSync("@python-kernel-session-");
		const profileA = createPythonRuntimeProfile(new Map([["PI_RUNTIME_GUARD_SESSION_ID", "a"]]));
		const profileB = createPythonRuntimeProfile(new Map([["PI_RUNTIME_GUARD_SESSION_ID", "b"]]));

		await executePython("print('a1')", {
			cwd: tempDir.path(),
			sessionId: "shared-session",
			kernelMode: "session",
			runtimeProfile: profileA,
		});
		await executePython("print('a2')", {
			cwd: tempDir.path(),
			sessionId: "shared-session",
			kernelMode: "session",
			runtimeProfile: profileA,
		});
		await executePython("print('b1')", {
			cwd: tempDir.path(),
			sessionId: "shared-session",
			kernelMode: "session",
			runtimeProfile: profileB,
		});

		expect(startCalls).toBe(2);
		expect(kernels[0]?.executeCalls).toBe(2);
		expect(kernels[1]?.executeCalls).toBe(1);
	});

	it("shuts down a kernel that finishes starting after its owner is disposed", async () => {
		using tempDir = TempDir.createSync("@python-kernel-session-");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		PythonKernel.start = (async () => {
			startCalls += 1;
			const kernel = new FakeKernel(`kernel-${startCalls}`);
			kernels.push(kernel);
			started.resolve();
			await release.promise;
			return kernel as unknown as PythonKernel;
		}) as typeof PythonKernel.start;

		const execution = executePython("print('late')", {
			cwd: tempDir.path(),
			sessionId: "late-session",
			kernelOwnerId: "disposed-owner",
			kernelMode: "session",
		});
		await started.promise;
		const disposal = disposeKernelSessionsByOwner("disposed-owner");
		release.resolve();
		const [result] = await Promise.all([execution, disposal]);

		expect(result.cancelled).toBe(true);
		expect(kernels[0]?.executeCalls).toBe(0);
		expect(kernels[0]?.shutdownCalls).toBe(1);
	});

	it("starts a fresh kernel when a new owner arrives during ownerless startup shutdown", async () => {
		using tempDir = TempDir.createSync("@python-kernel-session-");
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		PythonKernel.start = (async () => {
			startCalls += 1;
			const kernel = new FakeKernel(`kernel-${startCalls}`);
			kernels.push(kernel);
			if (startCalls === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			} else {
				secondStarted.resolve();
			}
			return kernel as unknown as PythonKernel;
		}) as typeof PythonKernel.start;

		const disposedExecution = executePython("print('old')", {
			cwd: tempDir.path(),
			sessionId: "owner-race-session",
			kernelOwnerId: "disposed-owner",
			kernelMode: "session",
		});
		await firstStarted.promise;
		const disposal = disposeKernelSessionsByOwner("disposed-owner");
		const replacementExecution = executePython("print('new')", {
			cwd: tempDir.path(),
			sessionId: "owner-race-session",
			kernelOwnerId: "new-owner",
			kernelMode: "session",
		});
		await secondStarted.promise;
		releaseFirst.resolve();
		const [disposedResult, replacementResult] = await Promise.all([disposedExecution, replacementExecution, disposal]);

		expect(disposedResult.cancelled).toBe(true);
		expect(replacementResult.cancelled).toBe(false);
		expect(startCalls).toBe(2);
		expect(kernels[0]?.shutdownCalls).toBe(1);
		expect(kernels[1]?.executeCalls).toBe(1);
	});

	it("retains an ownerless startup kernel until shutdown is confirmed", async () => {
		using tempDir = TempDir.createSync("@python-kernel-session-");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		PythonKernel.start = (async () => {
			startCalls += 1;
			const kernel = new FakeKernel(`kernel-${startCalls}`);
			kernel.shutdownConfirmed = false;
			kernels.push(kernel);
			started.resolve();
			await release.promise;
			return kernel as unknown as PythonKernel;
		}) as typeof PythonKernel.start;

		const execution = executePython("print('late')", {
			cwd: tempDir.path(),
			sessionId: "unconfirmed-ownerless-session",
			kernelOwnerId: "disposed-owner",
			kernelMode: "session",
		});
		await started.promise;
		const disposal = disposeKernelSessionsByOwner("disposed-owner");
		release.resolve();
		const [result] = await Promise.all([execution, disposal]);

		expect(result.cancelled).toBe(true);
		expect(kernels[0]?.shutdownCalls).toBe(1);
		expect(kernels[0]?.isAlive()).toBe(true);
		kernels[0]!.shutdownConfirmed = true;
		await disposeAllKernelSessions();
		expect(kernels[0]?.shutdownCalls).toBe(2);
		expect(kernels[0]?.isAlive()).toBe(false);
	});

	it("creates and disposes per-call kernels", async () => {
		using tempDir = TempDir.createSync("@python-kernel-session-");
		await executePython("print('one')", { cwd: tempDir.path(), kernelMode: "per-call" });
		await executePython("print('two')", { cwd: tempDir.path(), kernelMode: "per-call" });

		expect(startCalls).toBe(2);
		expect(kernels[0]?.shutdownCalls).toBe(1);
		expect(kernels[1]?.shutdownCalls).toBe(1);
	});

	it("resets the session kernel when requested", async () => {
		using tempDir = TempDir.createSync("@python-kernel-session-");
		await executePython("print('one')", { cwd: tempDir.path(), sessionId: "session-b", kernelMode: "session" });
		await executePython("print('two')", {
			cwd: tempDir.path(),
			sessionId: "session-b",
			kernelMode: "session",
			reset: true,
		});

		expect(startCalls).toBe(2);
		expect(kernels[0]?.shutdownCalls).toBe(1);
	});
});
