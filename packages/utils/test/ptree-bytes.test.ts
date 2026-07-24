import { describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisedProcessTree } from "@oh-my-pi/pi-natives";
import { type BoundedChildProcess, spawn, spawnBounded } from "@oh-my-pi/pi-utils/ptree";
import type { Spawn } from "bun";

describe("ptree.ChildProcess.bytes()", () => {
	// Regression for https://github.com/can1357/oh-my-pi/issues/3712:
	// `Response(stream).bytes()` returns the raw `ArrayBuffer` once the body
	// arrives in more than one chunk (which happens for subprocess stdout past
	// ~128 KB). Downstream code — e.g. the SSH read path's `decodeUtf8Text` —
	// relied on `Uint8Array` methods (`.indexOf`, `.subarray`) and crashed.
	it("returns a Uint8Array regardless of stdout size", async () => {
		// 256 KB is comfortably past the multi-chunk boundary observed on Bun
		// 1.3.x; the test then asserts only on the contract, not on the exact
		// chunk threshold, so it stays robust to future Bun runtime changes.
		const size = 256 * 1024;
		const child = spawn(["bun", "-e", `process.stdout.write("a".repeat(${size}))`]);
		const bytes = await child.bytes();
		await child.exitedCleanly;

		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(bytes.length).toBe(size);
		// The two methods the SSH read path depends on.
		expect(typeof bytes.indexOf).toBe("function");
		expect(typeof bytes.subarray).toBe("function");
		expect(bytes.indexOf(0)).toBe(-1);
		expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([0x61, 0x61, 0x61, 0x61]));
	});
});

async function waitForMarker(path: string): Promise<void> {
	// Real subprocess readiness has no in-process event; poll its filesystem
	// marker rather than guessing when the child installed its signal handler.
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) return;
		await Bun.sleep(10);
	}
	throw new Error(`marker was not created: ${path}`);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("ptree.spawnBounded()", () => {
	it("rejects invalid output caps before spawning", () => {
		const spawnSpy = spyOn(Bun, "spawn");
		try {
			for (const cap of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				expect(() =>
					spawnBounded(["bun", "-e", "process.exit(99)"], {
						tree: "required",
						stdoutCap: cap,
						stderrCap: 0,
					}),
				).toThrow();
			}
			expect(spawnSpy).not.toHaveBeenCalled();
		} finally {
			spawnSpy.mockRestore();
		}
	});

	it.skipIf(process.platform !== "darwin")(
		"does not report an empty tree before the acknowledged target starts",
		async () => {
			const child = spawnBounded(["bun", "-e", "await Bun.sleep(30_000)"], {
				tree: "required",
				stdoutCap: 0,
				stderrCap: 0,
			});
			expect(await child.waitTree({ timeoutMs: 25 })).toBe(false);
			expect(await child.terminateTree({ gracefulMs: 20, timeoutMs: 1_000 })).toBe(true);
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"rejects pre-start termination without ever spawning the target",
		async () => {
			const marker = join(tmpdir(), `omp-bounded-prestart-${randomUUID()}`);
			const child = spawnBounded(["bun", "-e", `await Bun.write(${JSON.stringify(marker)}, "started")`], {
				tree: "required",
				stdoutCap: 0,
				stderrCap: 0,
			});
			const termination = child.terminateTree({ gracefulMs: 20, timeoutMs: 1_000 });

			expect(await termination).toBe(true);
			await expect(child.output).rejects.toThrow("terminated before target startup");
			expect(existsSync(marker)).toBe(false);
		},
	);

	it.skipIf(process.platform !== "darwin")("retains exact-cap output without marking overflow", async () => {
		const child = spawnBounded(["bun", "-e", 'process.stdout.write("abcd")'], {
			tree: "required",
			stdoutCap: 4,
			stderrCap: 4,
		});
		const output = await child.output;

		expect(output.stdout).toEqual(new TextEncoder().encode("abcd"));
		expect(output.stderr).toEqual(new Uint8Array());
		expect(output.stdoutOverflow).toBe(false);
		expect(output.stderrOverflow).toBe(false);
		expect(output.exitCode).toBe(0);
		expect(await child.waitTree({ timeoutMs: 1_000 })).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")("drains normal output to EOF after supervisor release", async () => {
		const size = 256 * 1024;
		const child = spawnBounded(["bun", "-e", `process.stdout.write("z".repeat(${size}))`], {
			tree: "required",
			stdoutCap: size,
			stderrCap: 0,
		});

		const output = await child.output;
		expect(output.stdout.byteLength).toBe(size);
		expect(output.stdout[0]).toBe(0x7a);
		expect(output.stdout.at(-1)).toBe(0x7a);
		expect(output.stdoutOverflow).toBe(false);
	});

	it.skipIf(process.platform !== "darwin")(
		"makes cleanup during release await the shared release and reap",
		async () => {
			const originalSpawn = Bun.spawn;
			const releaseSent = Promise.withResolvers<void>();
			const releaseGate = Promise.withResolvers<void>();
			const spawnSpy = spyOn(Bun, "spawn");
			const spawnMock = (command: string[], options?: Spawn.SpawnOptions<"ignore", "pipe", "pipe">) => {
				const proc = originalSpawn(command, options);
				return new Proxy(proc, {
					get(target, key) {
						if (key !== "send") return Reflect.get(target, key, target);
						return (message: unknown) => {
							const sent = target.send(message);
							if (message && typeof message === "object" && "type" in message && message.type === "release") {
								releaseSent.resolve();
								return Promise.resolve(sent).then(() => releaseGate.promise);
							}
							return sent;
						};
					},
				});
			};
			// Bun.spawn is overloaded; this harness intercepts only spawnBounded's
			// concrete array-command supervisor call.
			const overloadedSpawnMock = spawnMock as typeof Bun.spawn;
			spawnSpy.mockImplementation(overloadedSpawnMock);
			try {
				const child = spawnBounded(["bun", "-e", "process.exit(0)"], {
					tree: "required",
					stdoutCap: 0,
					stderrCap: 0,
				});
				const output = child.output;
				await releaseSent.promise;
				let settled = false;
				const cleanup = child.terminateTree().finally(() => {
					settled = true;
				});
				await Promise.resolve();
				expect(settled).toBe(false);
				releaseGate.resolve();
				expect(await cleanup).toBe(true);
				expect((await output).exitCode).toBe(0);
			} finally {
				releaseGate.resolve();
				spawnSpy.mockRestore();
			}
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"bounds a stopped supervisor waiting for release acknowledgement",
		async () => {
			const originalSpawn = Bun.spawn;
			const spawnSpy = spyOn(Bun, "spawn");
			const spawnMock = (command: string[], options?: Spawn.SpawnOptions<"ignore", "pipe", "pipe">) => {
				const proc = originalSpawn(command, options);
				return new Proxy(proc, {
					get(target, key) {
						if (key !== "send") return Reflect.get(target, key, target);
						return (message: unknown) => {
							if (message && typeof message === "object" && "type" in message && message.type === "release") {
								target.kill("SIGSTOP");
								return;
							}
							return target.send(message);
						};
					},
				});
			};
			// Bun.spawn is overloaded; this harness intercepts only spawnBounded's
			// concrete array-command supervisor call.
			const overloadedSpawnMock = spawnMock as typeof Bun.spawn;
			spawnSpy.mockImplementation(overloadedSpawnMock);
			try {
				const child = spawnBounded(["bun", "-e", "process.exit(23)"], {
					tree: "required",
					stdoutCap: 0,
					stderrCap: 0,
					overflowTimeoutMs: 100,
				});
				await expect(child.output).rejects.toThrow(/release acknowledgement failed.*emergency cleanup/i);
				expect(processIsAlive(child.pid)).toBe(false);
			} finally {
				spawnSpy.mockRestore();
			}
		},
	);

	it.skipIf(process.platform !== "darwin")("rejects the first byte beyond the output cap", async () => {
		const child = spawnBounded(["bun", "-e", 'process.stdout.write("abcde")'], {
			tree: "required",
			stdoutCap: 4,
			stderrCap: 4,
		});

		await expect(child.output).rejects.toThrow(/output exceeded.*capture limit/i);
		expect(await child.waitTree({ timeoutMs: 1_000 })).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")("rejects nonempty output when the cap is zero", async () => {
		const child = spawnBounded(["bun", "-e", 'process.stdout.write("x")'], {
			tree: "required",
			stdoutCap: 0,
			stderrCap: 0,
		});

		await expect(child.output).rejects.toThrow(/output exceeded.*capture limit/i);
		expect(await child.waitTree({ timeoutMs: 1_000 })).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")(
		"rejects overflow while draining stdout and stderr concurrently",
		async () => {
			const child = spawnBounded(
				[
					"bun",
					"-e",
					'for (let i = 0; i < 256; i++) { process.stdout.write("o".repeat(1024)); process.stderr.write("e".repeat(1024)); }',
				],
				{ tree: "required", stdoutCap: 32, stderrCap: 48 },
			);

			await expect(child.output).rejects.toThrow(/output exceeded.*capture limit/i);
			expect(await child.waitTree({ timeoutMs: 1_000 })).toBe(true);
		},
	);

	it.skipIf(process.platform !== "darwin")("preserves raw non-UTF-8 bytes and reuses one output promise", async () => {
		const child = spawnBounded(["bun", "-e", "process.stdout.write(new Uint8Array([0, 255, 128, 10]))"], {
			tree: "required",
			stdoutCap: 4,
			stderrCap: 0,
		});
		const first = child.output;

		const second = child.output;

		expect(second).toBe(first);
		expect((await first).stdout).toEqual(new Uint8Array([0, 255, 128, 10]));
	});

	it.skipIf(process.platform !== "darwin")(
		"aggregates a stream-drain fault with mandatory cleanup failure",
		async () => {
			const originalRead = ReadableStreamDefaultReader.prototype.read;
			const readSpy = spyOn(ReadableStreamDefaultReader.prototype, "read");
			let child: BoundedChildProcess | undefined;
			let injected = false;
			readSpy.mockImplementation(function (this: ReadableStreamDefaultReader<unknown>) {
				if (!injected) {
					injected = true;
					return Promise.reject(new Error("injected drain failure"));
				}
				return originalRead.call(this);
			});
			const originalWait = SupervisedProcessTree.prototype.waitForEmpty;
			const waitSpy = spyOn(SupervisedProcessTree.prototype, "waitForEmpty");
			waitSpy.mockImplementation(function (this: SupervisedProcessTree, options) {
				if (options) return Promise.reject(new Error("injected cleanup failure"));
				return originalWait.call(this, options);
			});
			try {
				child = spawnBounded(["bun", "-e", "await Bun.sleep(30_000)"], {
					tree: "required",
					stdoutCap: 8,
					stderrCap: 8,
				});
				const error = await child.output.catch(error => error);
				expect(error).toBeInstanceOf(AggregateError);
				if (!(error instanceof Error)) throw new TypeError("expected drain failure");
				expect(error.message).toMatch(/failed to drain.*cleanup could not be proven/i);
			} finally {
				waitSpy.mockRestore();
				readSpy.mockRestore();
				if (child && processIsAlive(child.pid)) {
					// This case deliberately makes normal cleanup unprovable. Its test-only
					// fallback must reap its own group or a passing run leaves a busy Bun supervisor.
					process.kill(-child.pid, "SIGKILL");
					for (let attempt = 0; attempt < 100 && processIsAlive(child.pid); attempt++) {
						await Bun.sleep(10);
					}
					expect(processIsAlive(child.pid)).toBe(false);
				}
			}
		},
	);

	it.skipIf(process.platform !== "darwin")("rejects overflow only after cleaning an endless writer", async () => {
		const child = spawnBounded(["bun", "-e", 'while (true) process.stdout.write("x".repeat(4096))'], {
			tree: "required",
			stdoutCap: 8,
			stderrCap: 8,
		});

		await expect(child.output).rejects.toThrow(/output exceeded.*capture limit/i);
		expect(await child.waitTree({ timeoutMs: 1_000 })).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")(
		"keeps completion pending after the target exits while a silent descendant lives",
		async () => {
			const marker = join(tmpdir(), `omp-bounded-descendant-${randomUUID()}`);
			const descendantScript = `trap '' TERM; echo $$ > '${marker}'; while :; do sleep 1; done`;
			const child = spawnBounded(
				[
					"bun",
					"-e",
					`const child = Bun.spawn(["sh", "-c", ${JSON.stringify(descendantScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); child.unref(); process.stdout.write("target-exit");`,
				],
				{ tree: "required", stdoutCap: 32, stderrCap: 16 },
			);
			await waitForMarker(marker);
			let resolved = false;
			child.output.then(() => {
				resolved = true;
			});
			expect(await child.waitTree({ timeoutMs: 25 })).toBe(false);
			expect(resolved).toBe(false);
			expect(await child.terminateTree({ gracefulMs: 20, timeoutMs: 1_000 })).toBe(true);
			expect(new TextDecoder().decode((await child.output).stdout)).toBe("target-exit");
			unlinkSync(marker);
		},
	);

	it.skipIf(process.platform !== "darwin")("escalates cleanup for a signal-resistant descendant", async () => {
		const child = spawnBounded(
			[
				"bun",
				"-e",
				'const child = Bun.spawn(["sh", "-c", "trap \\"\\" TERM; while :; do sleep 1; done"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); console.log(child.pid); await child.exited;',
			],
			{ tree: "required", stdoutCap: 64, stderrCap: 16 },
		);
		expect(await child.waitTree({ timeoutMs: 25 })).toBe(false);
		expect(await child.terminateTree({ gracefulMs: 20, timeoutMs: 1_000 })).toBe(true);
		expect(await child.waitTree({ timeoutMs: 50 })).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")(
		"bounds a stopped supervisor waiting for cleanup hold acknowledgement",
		async () => {
			const marker = join(tmpdir(), `omp-bounded-stopped-hold-${randomUUID()}`);
			const script = `trap '' TERM; echo $$ > '${marker}'; while :; do sleep 1; done`;
			const child = spawnBounded(["sh", "-c", script], {
				tree: "required",
				stdoutCap: 0,
				stderrCap: 0,
			});
			const rejection = child.output.catch(error => error);
			await waitForMarker(marker);
			const targetPid = Number(readFileSync(marker, "utf8").trim());
			process.kill(child.pid, "SIGSTOP");
			try {
				const error = await child.terminateTree({ gracefulMs: 20, timeoutMs: 100 }).catch(error => error);
				expect(error).toBeInstanceOf(AggregateError);
				if (!(error instanceof Error)) throw new TypeError("expected hold acknowledgement failure");
				expect(error.message).toMatch(/cleanup hold acknowledgement failed.*emergency cleanup/i);
				expect(await rejection).toBeInstanceOf(Error);
				expect(processIsAlive(targetPid)).toBe(false);
				expect(processIsAlive(child.pid)).toBe(false);
			} finally {
				if (processIsAlive(child.pid)) {
					process.kill(child.pid, "SIGCONT");
					process.kill(child.pid, "SIGKILL");
				}
				if (processIsAlive(targetPid)) process.kill(targetPid, "SIGKILL");
				if (existsSync(marker)) unlinkSync(marker);
			}
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"rejects cancellation only after a TERM-resistant descendant is gone",
		async () => {
			const marker = join(tmpdir(), `omp-bounded-cancel-${randomUUID()}`);
			const descendantScript = `trap '' TERM; echo $$ > '${marker}'; while :; do sleep 1; done`;
			const controller = new AbortController();
			const child = spawnBounded(
				[
					"bun",
					"-e",
					`const child = Bun.spawn(["sh", "-c", ${JSON.stringify(descendantScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); await child.exited;`,
				],
				{
					tree: "required",
					stdoutCap: 0,
					stderrCap: 0,
					signal: controller.signal,
					overflowGracefulMs: 100,
					overflowTimeoutMs: 1_000,
				},
			);
			const rejection = child.output.catch(error => error);
			await waitForMarker(marker);
			const descendantPid = Number(readFileSync(marker, "utf8").trim());
			controller.abort(new Error("cancelled for test"));
			// This integration assertion deliberately samples inside the real native
			// 100ms TERM grace period to prove escalation has not happened yet.
			await Bun.sleep(25);
			expect(processIsAlive(descendantPid)).toBe(true);
			expect(await rejection).toBeInstanceOf(Error);
			expect(processIsAlive(descendantPid)).toBe(false);
			unlinkSync(marker);
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"settles post-final-KILL cancellation as terminal cleanup failure",
		async () => {
			const marker = join(tmpdir(), `omp-bounded-post-kill-${randomUUID()}`);
			const controller = new AbortController();
			const waitSpy = spyOn(SupervisedProcessTree.prototype, "waitForAbsenceAfterKill");
			waitSpy.mockImplementation(function (this: SupervisedProcessTree) {
				const failure = new Error("cancelled after final kill");
				controller.abort(failure);
				return Promise.reject(failure);
			});
			try {
				const child = spawnBounded(
					["sh", "-c", `trap '' TERM; echo ready > '${marker}'; while :; do sleep 1; done`],
					{ tree: "required", stdoutCap: 0, stderrCap: 0 },
				);
				await waitForMarker(marker);
				expect(await child.waitTree({ timeoutMs: 25 })).toBe(false);
				const rejection = child.output.catch(error => error);
				await expect(
					child.terminateTree({
						gracefulMs: -1,
						timeoutMs: 1_000,
						signal: controller.signal,
					}),
				).rejects.toThrow(/final supervised group kill cleanup could not be proven/i);
				expect(await rejection).toBeInstanceOf(AggregateError);
				expect(await child.waitTree({ timeoutMs: 25 })).toBe(false);
			} finally {
				waitSpy.mockRestore();
				if (existsSync(marker)) unlinkSync(marker);
			}
		},
	);

	it.skipIf(process.platform !== "darwin")("fails terminally when the target kills the supervisor group", async () => {
		const child = spawnBounded(["sh", "-c", "kill -KILL 0"], {
			tree: "required",
			stdoutCap: 0,
			stderrCap: 0,
		});
		await expect(child.output).rejects.toThrow(/supervisor exited/i);
	});

	it.skipIf(process.platform !== "darwin")(
		"rejects promptly when only the supervisor dies while the target keeps inherited pipes open",
		async () => {
			const marker = join(tmpdir(), `omp-bounded-supervisor-death-${randomUUID()}`);
			const child = spawnBounded(["sh", "-c", `echo $$ > '${marker}'; kill -KILL $PPID; sleep 30`], {
				tree: "required",
				stdoutCap: 0,
				stderrCap: 0,
			});
			const rejection = child.output.catch(error => error);
			await waitForMarker(marker);
			const targetPid = Number(readFileSync(marker, "utf8").trim());
			try {
				// This watchdog is the assertion: inherited pipes must not keep the
				// supervisor-death path pending indefinitely.
				const outcome = await Promise.race([
					rejection,
					Bun.sleep(2_000).then(() => new Error("timed out waiting for supervisor-death rejection")),
				]);
				expect(outcome).toBeInstanceOf(Error);
				if (!(outcome instanceof Error)) throw new TypeError("expected supervisor failure");
				expect(outcome.message).toMatch(/supervisor exited.*cleanup cannot be proven/i);
				expect(outcome.message).not.toContain("timed out waiting");
				expect(processIsAlive(targetPid)).toBe(true);
			} finally {
				if (processIsAlive(targetPid)) process.kill(targetPid, "SIGKILL");
				unlinkSync(marker);
			}
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"detects a live detached descendant that escapes the dedicated process group",
		async () => {
			const marker = join(tmpdir(), `omp-bounded-group-escape-${randomUUID()}`);
			const child = spawnBounded(
				[
					"bun",
					"-e",
					`const escaped = Bun.spawn(["sh", "-c", "echo $$ > '${marker}'; sleep 30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }); await escaped.exited;`,
				],
				{ tree: "required", stdoutCap: 0, stderrCap: 0 },
			);
			const rejection = child.output.catch(error => error);
			await waitForMarker(marker);
			const escapedPid = Number(readFileSync(marker, "utf8").trim());
			try {
				const error = await rejection;
				expect(error).toBeInstanceOf(Error);
				if (!(error instanceof Error)) throw new TypeError("expected group escape failure");
				expect(error.message).toMatch(/escaped.*group.*cleanup could not be proven/i);
				expect(processIsAlive(escapedPid)).toBe(true);
			} finally {
				if (processIsAlive(escapedPid)) process.kill(escapedPid, "SIGKILL");
				for (let attempt = 0; attempt < 100 && processIsAlive(escapedPid); attempt++) {
					await Bun.sleep(10);
				}
				expect(processIsAlive(escapedPid)).toBe(false);
				unlinkSync(marker);
			}
		},
	);

	it.skipIf(process.platform !== "darwin")("cleans the held supervisor after target spawn failure", async () => {
		const child = spawnBounded(["/definitely/missing/omp-bounded-target"], {
			tree: "required",
			stdoutCap: 0,
			stderrCap: 256,
		});
		const error = await child.output.catch(error => error);
		expect(error).toBeInstanceOf(Error);
		expect(await child.waitTree({ timeoutMs: 1_000 })).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")(
		"keeps a caller-cancelled cleanup retryable without false success",
		async () => {
			const child = spawnBounded(["bun", "-e", "await Bun.sleep(30_000)"], {
				tree: "required",
				stdoutCap: 0,
				stderrCap: 0,
			});
			expect(await child.waitTree({ timeoutMs: 25 })).toBe(false);
			const cancelled = new AbortController();
			cancelled.abort(new Error("cancel cleanup attempt"));
			await expect(
				child.terminateTree({ gracefulMs: 20, timeoutMs: 1_000, signal: cancelled.signal }),
			).rejects.toThrow("cancel cleanup attempt");
			expect(await child.waitTree({ timeoutMs: 25 })).toBe(false);
			expect(await child.terminateTree({ gracefulMs: 20, timeoutMs: 1_000 })).toBe(true);
			await child.output;
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"publishes target exit after a held cleanup is cancelled and reset",
		async () => {
			const ready = join(tmpdir(), `omp-bounded-held-ready-${randomUUID()}`);
			const release = join(tmpdir(), `omp-bounded-held-release-${randomUUID()}`);
			const controller = new AbortController();
			const originalWait = SupervisedProcessTree.prototype.waitForEmpty;
			const waitSpy = spyOn(SupervisedProcessTree.prototype, "waitForEmpty");
			let injected = false;
			waitSpy.mockImplementation(function (this: SupervisedProcessTree, options) {
				if (options && !injected) {
					injected = true;
					const failure = new Error("cancel held cleanup");
					controller.abort(failure);
					return Promise.reject(failure);
				}
				return originalWait.call(this, options);
			});
			try {
				const script = `trap '' TERM; echo ready > '${ready}'; while [ ! -f '${release}' ]; do sleep 0.01; done; exit 7`;
				const child = spawnBounded(["sh", "-c", script], {
					tree: "required",
					stdoutCap: 0,
					stderrCap: 0,
				});
				const output = child.output;
				await waitForMarker(ready);
				await expect(
					child.terminateTree({ gracefulMs: 1_000, timeoutMs: 1_000, signal: controller.signal }),
				).rejects.toThrow("cancel held cleanup");
				await Bun.write(release, "release");
				expect((await output).exitCode).toBe(7);
			} finally {
				waitSpy.mockRestore();
				if (existsSync(ready)) unlinkSync(ready);
				if (existsSync(release)) unlinkSync(release);
			}
		},
	);

	it("does not spawn a target or supervisor for an already-aborted signal", () => {
		const marker = join(tmpdir(), `omp-bounded-preabort-${randomUUID()}`);
		const controller = new AbortController();
		controller.abort(new Error("already aborted"));
		const spawnSpy = spyOn(Bun, "spawn");
		try {
			expect(() =>
				spawnBounded(["bun", "-e", `Bun.write(${JSON.stringify(marker)}, "spawned")`], {
					tree: "required",
					stdoutCap: 0,
					stderrCap: 0,
					signal: controller.signal,
				}),
			).toThrow("already aborted");
			expect(spawnSpy).not.toHaveBeenCalled();
			expect(existsSync(marker)).toBe(false);
		} finally {
			spawnSpy.mockRestore();
		}
	});

	it.skipIf(process.platform === "darwin")("rejects unsupported containment before spawning", () => {
		const spawnSpy = spyOn(Bun, "spawn");
		try {
			expect(() =>
				spawnBounded(["sh", "-c", "while :; do sleep 1; done"], {
					tree: "required",
					stdoutCap: 0,
					stderrCap: 0,
				}),
			).toThrow(/unsupported/i);
			expect(spawnSpy).not.toHaveBeenCalled();
		} finally {
			spawnSpy.mockRestore();
		}
	});
});
