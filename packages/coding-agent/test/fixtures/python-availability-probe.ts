import { checkPythonKernelAvailability } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { createPythonRuntimeProfile } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
Bun.env.BUN_ENV = "development";
Bun.env.NODE_ENV = "development";

const cwd = process.env.OMP_TEST_CWD;
const interpreter = process.env.OMP_TEST_PYTHON;
const libraryPath = process.env.OMP_TEST_LD_LIBRARY_PATH;
const runtimeProfile = libraryPath
	? createPythonRuntimeProfile(new Map([["LD_LIBRARY_PATH", libraryPath]]))
	: undefined;
if (!cwd || !interpreter) throw new Error("Missing Python availability probe input");
const result = await checkPythonKernelAvailability(cwd, interpreter, runtimeProfile);
process.stdout.write(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
