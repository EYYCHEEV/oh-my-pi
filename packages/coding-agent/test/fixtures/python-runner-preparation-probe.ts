import fs from "node:fs";
import { preparePythonRunnerScript } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";

const paths = await Promise.all(Array.from({ length: 16 }, () => preparePythonRunnerScript()));
const target = paths[0];
if (!target) throw new Error("Python runner preparation returned no path");

fs.chmodSync(target, 0o600);
fs.writeFileSync(target, "tampered after preparation");
const repaired = await preparePythonRunnerScript();

process.stdout.write(JSON.stringify({ paths, repaired }));
