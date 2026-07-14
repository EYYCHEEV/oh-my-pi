import { describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnBounded } from "@oh-my-pi/pi-utils/ptree";

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

	it.skipIf(process.platform !== "darwin")("retains only the cap and detects the first additional byte", async () => {
		const child = spawnBounded(["bun", "-e", 'process.stdout.write("abcde")'], {
			tree: "required",
			stdoutCap: 4,
			stderrCap: 4,
		});
		const output = await child.output;

		expect(output.stdout).toEqual(new TextEncoder().encode("abcd"));
		expect(output.stdoutOverflow).toBe(true);
		expect(await child.waitTree({ timeoutMs: 1_000 })).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")("cap zero retains nothing and detects nonempty output", async () => {
		const child = spawnBounded(["bun", "-e", 'process.stdout.write("x")'], {
			tree: "required",
			stdoutCap: 0,
			stderrCap: 0,
		});
		const output = await child.output;

		expect(output.stdout).toEqual(new Uint8Array());
		expect(output.stdoutOverflow).toBe(true);
	});

	it.skipIf(process.platform !== "darwin")(
		"drains stdout and stderr concurrently under independent caps",
		async () => {
			const child = spawnBounded(
				[
					"bun",
					"-e",
					'for (let i = 0; i < 256; i++) { process.stdout.write("o".repeat(1024)); process.stderr.write("e".repeat(1024)); }',
				],
				{ tree: "required", stdoutCap: 32, stderrCap: 48 },
			);
			const output = await child.output;

			expect(output.stdout).toEqual(new Uint8Array(32).fill(0x6f));
			expect(output.stderr).toEqual(new Uint8Array(48).fill(0x65));
			expect(output.stdoutOverflow).toBe(true);
			expect(output.stderrOverflow).toBe(true);
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

	it.skipIf(process.platform !== "darwin")("fails closed on overflow from an endless writer", async () => {
		const child = spawnBounded(["bun", "-e", 'while (true) process.stdout.write("x".repeat(4096))'], {
			tree: "required",
			stdoutCap: 8,
			stderrCap: 8,
		});
		const output = await child.output;

		expect(output.stdout).toEqual(new Uint8Array(8).fill(0x78));
		expect(output.stdoutOverflow).toBe(true);
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
		expect(await child.terminateTree({ gracefulMs: 20, timeoutMs: 1_000 })).toBe(true);
		expect(await child.waitTree({ timeoutMs: 50 })).toBe(true);
	});

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

	it.skipIf(process.platform !== "darwin")("fails terminally when the target kills the supervisor group", async () => {
		const child = spawnBounded(["sh", "-c", "kill -KILL 0"], {
			tree: "required",
			stdoutCap: 0,
			stderrCap: 0,
		});
		await expect(child.output).rejects.toThrow(/supervisor exited/i);
	});

	it.skipIf(process.platform !== "darwin")("cleans the held supervisor after target spawn failure", async () => {
		const child = spawnBounded(["/definitely/missing/omp-bounded-target"], {
			tree: "required",
			stdoutCap: 0,
			stderrCap: 256,
		});
		await expect(child.output).rejects.toThrow();
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
