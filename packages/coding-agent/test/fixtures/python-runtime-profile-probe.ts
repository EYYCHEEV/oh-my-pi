import { checkPythonKernelAvailability, PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { createPythonRuntimeProfile } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
Bun.env.BUN_ENV = "development";
Bun.env.NODE_ENV = "development";

const cwd = process.env.OMP_TEST_CWD;
const interpreter = process.env.OMP_TEST_PYTHON;
if (!cwd || !interpreter) throw new Error("Missing Python runtime profile probe input");

const preExtensionAvailability = await checkPythonKernelAvailability(cwd, interpreter);
const runtimeProfile = createPythonRuntimeProfile(
	new Map([
		["PI_RUNTIME_GUARD_TEST", "armed"],
		["PYTHONDONTWRITEBYTECODE", "1"],
	]),
);
if (!runtimeProfile) throw new Error("Python runtime profile unavailable");

const kernel = await PythonKernel.start({ cwd, interpreter, runtimeProfile });
const output: string[] = [];
try {
	const result = await kernel.execute("import os\nprint(os.environ.get('PI_RUNTIME_GUARD_TEST'))", {
		onChunk: chunk => {
			output.push(chunk);
		},
	});
	console.log(
		JSON.stringify({
			preExtensionAvailable: preExtensionAvailability.ok,
			status: result.status,
			output: output.join("").trim(),
		}),
	);
} finally {
	await kernel.shutdown();
}
