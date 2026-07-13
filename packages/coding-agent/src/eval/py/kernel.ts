/**
 * Subprocess-backed Python runner.
 *
 * Speaks NDJSON with `runner.py` over stdin/stdout. One subprocess per kernel
 * instance; sessions reuse a single subprocess across executions. Cancellation
 * is `kill("SIGINT")` which raises a real `KeyboardInterrupt` inside user
 * code. Shutdown writes `{"type":"exit"}` and escalates to SIGTERM/SIGKILL on
 * timeout.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $flag, isBunTestRuntime, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import { BaseKernel, getRemainingTimeMs, type KernelStartOptions } from "../kernel-base";
import { PYTHON_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.py" with { type: "text" };
import {
	enumeratePythonRuntimes,
	filterEnv,
	type PythonRuntime,
	type PythonRuntimeProfile,
	resolveExplicitPythonRuntime,
	resolvePythonRuntime,
} from "./runtime";
import { hostHasInheritableConsole, shouldDetachKernel, shouldHideKernelWindow } from "./spawn-options";

export type {
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelRuntimeEnv,
	KernelShutdownOptions,
	KernelShutdownResult,
} from "../kernel-base";

export type { KernelDisplayOutput, PythonStatusEvent } from "./display";
export { renderKernelDisplay } from "./display";

const TRACE_IPC = $flag("PI_PYTHON_IPC_TRACE");

// Cache the runner script in a process-private temporary directory so the
// subprocess loads it normally. The stable inner directory name is part of the
// guarded-runner identity contract; the unpredictable parent prevents
// cross-user pre-seeding and cross-process publication races.
const RUNNER_SCRIPT_BYTES = Buffer.from(RUNNER_SCRIPT, "utf8");
let runnerCacheDirectory: string | undefined;
let preparedRunnerPath: string | undefined;
let runnerScriptPreparation: Promise<string> | undefined;

function isExactPreparedRunner(target: string): boolean {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const metadata = fs.fstatSync(descriptor);
		if (
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			(typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
			(process.platform !== "win32" && (metadata.mode & 0o222) !== 0) ||
			metadata.size !== RUNNER_SCRIPT_BYTES.byteLength
		) {
			return false;
		}
		return fs.readFileSync(descriptor).equals(RUNNER_SCRIPT_BYTES);
	} catch {
		return false;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

async function createRunnerCacheDirectory(): Promise<string> {
	if (runnerCacheDirectory) return runnerCacheDirectory;
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-python-"));
	const directory = path.join(root, "omp-python-runner");
	await fs.promises.mkdir(directory, { mode: 0o700 });
	for (const candidate of [root, directory]) {
		if (process.platform !== "win32") await fs.promises.chmod(candidate, 0o700);
		const metadata = await fs.promises.lstat(candidate);
		if (
			!metadata.isDirectory() ||
			metadata.isSymbolicLink() ||
			(typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
			(process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
		) {
			throw new Error("Unsafe Python runner cache directory");
		}
	}
	runnerCacheDirectory = directory;
	return directory;
}

async function materializePythonRunnerScript(): Promise<string> {
	const cacheDirectory = await createRunnerCacheDirectory();
	const hash = Bun.hash(RUNNER_SCRIPT).toString(36);
	const target = path.join(cacheDirectory, `runner-${hash}.py`);
	if (isExactPreparedRunner(target)) return target;

	const temporary = path.join(cacheDirectory, `.${path.basename(target)}.${process.pid}.${randomUUID()}`);
	try {
		await fs.promises.writeFile(temporary, RUNNER_SCRIPT_BYTES, { flag: "wx", mode: 0o600 });
		if (process.platform !== "win32") await fs.promises.chmod(temporary, 0o400);
		if (process.platform === "win32") await fs.promises.rm(target, { force: true });
		await fs.promises.rename(temporary, target);
		if (!isExactPreparedRunner(target)) throw new Error("Python runner cache verification failed");
		return target;
	} finally {
		await fs.promises.rm(temporary, { force: true });
	}
}

export function preparePythonRunnerScript(): Promise<string> {
	if (preparedRunnerPath && isExactPreparedRunner(preparedRunnerPath)) {
		return Promise.resolve(preparedRunnerPath);
	}
	preparedRunnerPath = undefined;
	if (!runnerScriptPreparation) {
		runnerScriptPreparation = materializePythonRunnerScript().then(
			target => {
				preparedRunnerPath = target;
				runnerScriptPreparation = undefined;
				return target;
			},
			error => {
				runnerScriptPreparation = undefined;
				throw error;
			},
		);
	}
	return runnerScriptPreparation;
}

const SHUTDOWN_GRACE_MS = 1_000;
const STARTUP_TIMEOUT_MS = 10_000;
// How long to wait after SIGINT for the runner to emit `done`. If the cell is
// stuck in code that ignores Python signals (e.g. a C extension holding the
// GIL), we escalate to a full subprocess shutdown so the host queue unblocks
// instead of hanging the session forever. The grace window is intentionally
// generous: a clean interrupt is far preferable to losing the persistent
// kernel's state, so we only kill as a last-resort recovery path.
const INTERRUPT_ESCALATION_MS = 5_000;

export interface PythonKernelAvailability {
	ok: boolean;
	pythonPath?: string;
	reason?: string;
	/** The probed-working runtime, when one was found. */
	runtime?: PythonRuntime;
}

export interface PythonKernelStartOptions extends KernelStartOptions {
	runtimeProfile?: PythonRuntimeProfile;
}

// Cache successful probes per resolved cwd + explicit interpreter + runtime
// profile: every cell otherwise pays one (or two — backend.isAvailable +
// ensureKernelAvailable) interpreter spawns even when the kernel is already
// hot. Failures are not cached so installing Python mid-session is picked up
// on the next attempt. The LRU bound prevents unique session profiles from
// retaining their spawn environments for the lifetime of an embedding process.
const AVAILABILITY_CACHE_LIMIT = 64;
const availabilityCache = new Map<string, Promise<PythonKernelAvailability>>();

export async function checkPythonKernelAvailability(
	cwd: string,
	interpreter?: string,
	runtimeProfile?: PythonRuntimeProfile,
): Promise<PythonKernelAvailability> {
	if (isBunTestRuntime() || $flag("PI_PYTHON_SKIP_CHECK")) {
		return { ok: true };
	}
	const resolvedCwd = path.resolve(cwd);
	const key = `${resolvedCwd}\0${interpreter ?? ""}\0${runtimeProfile?.key ?? ""}`;
	const cached = availabilityCache.get(key);
	if (cached) {
		availabilityCache.delete(key);
		availabilityCache.set(key, cached);
		return await cached;
	}
	const probe = probePythonKernelAvailability(resolvedCwd, interpreter, runtimeProfile);
	availabilityCache.set(key, probe);
	while (availabilityCache.size > AVAILABILITY_CACHE_LIMIT) {
		const oldest = availabilityCache.keys().next().value;
		if (oldest === undefined) break;
		availabilityCache.delete(oldest);
	}
	const result = await probe;
	if (!result.ok && availabilityCache.get(key) === probe) {
		availabilityCache.delete(key);
	}
	return result;
}

async function probePythonKernelAvailability(
	cwd: string,
	interpreter?: string,
	runtimeProfile?: PythonRuntimeProfile,
): Promise<PythonKernelAvailability> {
	try {
		const settings = await Settings.init();
		const { env } = settings.getShellConfig();
		const baseEnv = { ...filterEnv(env), ...runtimeProfile?.env };
		const runtimes = interpreter
			? [resolveExplicitPythonRuntime(interpreter, cwd, baseEnv)]
			: enumeratePythonRuntimes(cwd, baseEnv);
		if (runtimes.length === 0) {
			return { ok: false, reason: "Python executable not found on PATH" };
		}
		// Probe each candidate in priority order and use the first that actually
		// runs. A managed env left behind by a removed `uv` install can exist on
		// disk yet fail to execute; falling through to the next candidate lets a
		// working system Python take over instead of failing the whole session.
		const failures: string[] = [];
		for (const runtime of runtimes) {
			const probeEnv = Object.fromEntries(Object.entries(runtime.env).filter(([name]) => !name.startsWith("PYTHON")));
			try {
				// Availability must not execute inherited startup hooks before
				// extensions have finished their own runtime preflight.
				const probe = await $`${runtime.pythonPath} -E -S -B -c "import sys;sys.exit(0)"`
					.quiet()
					.nothrow()
					.cwd(cwd)
					.env(probeEnv);
				if (probe.exitCode === 0) {
					return { ok: true, pythonPath: runtime.pythonPath, runtime };
				}
				failures.push(`${runtime.pythonPath} (exit code ${probe.exitCode})`);
			} catch (err) {
				failures.push(`${runtime.pythonPath} (${err instanceof Error ? err.message : String(err)})`);
			}
		}
		return {
			ok: false,
			pythonPath: runtimes[0].pythonPath,
			reason: `No working Python interpreter found. Tried: ${failures.join("; ")}`,
		};
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

export class PythonKernel extends BaseKernel {
	private constructor(id: string) {
		super(id, {
			languageName: "Python",
			traceIpc: TRACE_IPC,
			exitPayload: JSON.stringify({ type: "exit" }),
			interruptEscalationMs: INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: SHUTDOWN_GRACE_MS,
			buildPayload: (code, msgId, opts) =>
				JSON.stringify({
					id: msgId,
					code,
					cwd: opts?.cwd,
					env: opts?.env,
					silent: opts?.silent ?? false,
					storeHistory: opts?.storeHistory ?? !(opts?.silent ?? false),
				}),
		});
	}

	static async start(options: PythonKernelStartOptions): Promise<PythonKernel> {
		const availability = await logger.time(
			"PythonKernel.start:availabilityCheck",
			checkPythonKernelAvailability,
			options.cwd,
			options.interpreter,
			options.runtimeProfile,
		);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Python kernel unavailable");
		}

		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			const baseEnv = { ...filterEnv(shellEnv), ...options.runtimeProfile?.env };
			runtime = options.interpreter
				? resolveExplicitPythonRuntime(options.interpreter, options.cwd, baseEnv)
				: resolvePythonRuntime(options.cwd, baseEnv);
		}
		const spawnEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(runtime.env)) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		for (const [key, value] of Object.entries(options.env ?? {})) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		spawnEnv.PYTHONUNBUFFERED = "1";
		spawnEnv.PYTHONIOENCODING = "utf-8";

		const scriptPath = await preparePythonRunnerScript();
		const kernel = new PythonKernel(Snowflake.next());

		const proc = Bun.spawn([runtime.pythonPath, "-u", scriptPath], {
			cwd: options.cwd,
			detached: shouldDetachKernel(process.platform),
			env: spawnEnv,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: shouldHideKernelWindow({
				platform: process.platform,
				hostHasInheritableConsole: hostHasInheritableConsole(),
			}),
		});

		kernel.setProcess(proc);

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const startupBudget = Math.min(getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);

		try {
			const initScript = buildInitScript(options.cwd, options.env);
			await kernel.executeWithBudget(initScript, startup.signal, startupBudget, "Python kernel init");
			await kernel.executeWithBudget(PYTHON_PRELUDE, startup.signal, startupBudget, "Python kernel prelude");
			return kernel;
		} catch (err) {
			await kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {});
			throw err;
		}
	}
}
function buildInitScript(cwd: string, env?: Record<string, string | undefined>): string {
	const envEntries = Object.entries(env ?? {}).filter(([, value]) => value !== undefined);
	const envPayload = Object.fromEntries(envEntries);
	return [
		"import os, sys",
		`__omp_cwd = ${JSON.stringify(cwd)}`,
		"os.chdir(__omp_cwd)",
		`__omp_env = ${JSON.stringify(envPayload)}`,
		"for __omp_key, __omp_val in __omp_env.items():\n    os.environ[__omp_key] = __omp_val",
		"if __omp_cwd not in sys.path:\n    sys.path.insert(0, __omp_cwd)",
	].join("\n");
}
