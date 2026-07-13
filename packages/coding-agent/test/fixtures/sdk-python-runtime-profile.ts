import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PythonRuntimeProfile } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import { createAgentSession, type ExtensionFactory, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
Bun.env.BUN_ENV = "development";
Bun.env.NODE_ENV = "development";

const root = process.env.OMP_TEST_ROOT;
const cwd = process.env.OMP_TEST_CWD;
const virtualEnv = process.env.OMP_TEST_VIRTUAL_ENV;
const lateInterpreterDirectory = process.env.OMP_TEST_LATE_INTERPRETER_DIR;
if (!root || !cwd || !virtualEnv) throw new Error("Missing SDK Python profile fixture input");
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled model");

const workspaceTree: WorkspaceTree = {
	rootPath: cwd,
	rendered: ".",
	truncated: false,
	totalLines: 1,
	agentsMdFiles: [],
};
const settings = () =>
	Settings.isolated({
		"eval.js": false,
		"eval.py": true,
		"python.kernelMode": "session",
	});
const profileExtension: ExtensionFactory = api => {
	if (lateInterpreterDirectory) {
		const interpreterBin = path.join(lateInterpreterDirectory, "bin");
		api.registerPythonSpawnEnvResolver(({ pythonPath }) => ({
			PATH: `${interpreterBin}${path.delimiter}${process.env.PATH ?? ""}`,
			VIRTUAL_ENV: lateInterpreterDirectory,
			PI_RESOLVED_PYTHON: pythonPath ?? "unavailable",
		}));
		return;
	}
	api.registerPythonSpawnEnv({ PI_RUNTIME_GUARD_TEST: "shared-profile", VIRTUAL_ENV: virtualEnv });
	api.registerPythonSpawnEnvResolver(({ pythonPath }) => ({
		PI_RESOLVED_PYTHON: pythonPath ?? "unavailable",
	}));
};
const createProfileSession = async (
	identity: string,
	parent: {
		parentEvalSessionId?: string;
		parentPythonRuntimeProfile?: PythonRuntimeProfile;
		parentPythonRuntimeActive?: boolean;
		parentPythonRuntimeCwd?: string;
		parentPythonInterpreter?: string;
	} = {},
	sessionCwd = cwd,
) => {
	const agentDir = path.join(root, `agent-${identity}`);
	fs.mkdirSync(agentDir, { recursive: true });
	return (
		await createAgentSession({
			cwd: sessionCwd,
			agentDir,
			agentId: `Profile${identity}`,
			sessionManager: SessionManager.inMemory(sessionCwd),
			settings: settings(),
			model,
			disableExtensionDiscovery: true,
			extensions: [profileExtension],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			workspaceTree: { ...workspaceTree, rootPath: sessionCwd },
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["eval"],
			...parent,
		})
	).session;
};
const execute = async (session: AgentSession, code: string): Promise<string> => {
	const tool = session.getToolByName("eval");
	if (!tool) throw new Error("Eval tool unavailable");
	const result = await tool.execute("profile-call", { language: "py", code }, undefined, undefined, undefined);
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
};

if (lateInterpreterDirectory) {
	try {
		await createProfileSession("LateInterpreter");
		console.log(JSON.stringify({ error: "session unexpectedly created" }));
	} catch (error) {
		console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	}
	process.exit(0);
}

const sessionA = await createProfileSession("A");
const sessionB = await createProfileSession("B");
let inheritedSessionA: AgentSession | undefined;
let isolatedSessionA: AgentSession | undefined;
try {
	const firstA = await execute(
		sessionA,
		"import os\nprofile_sentinel = 'A-state'\nprint(os.environ.get('PI_RUNTIME_GUARD_TEST'))\nprint(os.environ.get('PI_RESOLVED_PYTHON'))",
	);
	const firstB = await execute(
		sessionB,
		"import os\nprofile_sentinel = 'B-state'\nprint(os.environ.get('PI_RUNTIME_GUARD_TEST'))\nprint(os.environ.get('PI_RESOLVED_PYTHON'))",
	);
	inheritedSessionA = await createProfileSession("InheritedA", {
		parentEvalSessionId: sessionA.getEvalSessionId() ?? undefined,
		parentPythonRuntimeProfile: sessionA.getPythonRuntimeProfile(),
		parentPythonRuntimeCwd: cwd,
		parentPythonInterpreter: undefined,
		parentPythonRuntimeActive: true,
	});
	const inheritedA = await execute(
		inheritedSessionA,
		"print(profile_sentinel)\nprint(os.environ.get('PI_RUNTIME_GUARD_TEST'))",
	);
	const isolatedCwd = path.join(root, "isolated-child-workspace");
	fs.mkdirSync(isolatedCwd);
	isolatedSessionA = await createProfileSession(
		"IsolatedA",
		{
			parentEvalSessionId: sessionA.getEvalSessionId() ?? undefined,
			parentPythonRuntimeProfile: sessionA.getPythonRuntimeProfile(),
			parentPythonRuntimeCwd: cwd,
			parentPythonInterpreter: undefined,
			parentPythonRuntimeActive: true,
		},
		isolatedCwd,
	);
	const isolatedChild = await execute(
		isolatedSessionA,
		"profile_sentinel = 'isolated-state'\nprint(profile_sentinel)",
	);
	const secondA = await execute(sessionA, "print(profile_sentinel)\nprint(os.environ.get('PI_RUNTIME_GUARD_TEST'))");
	const secondB = await execute(sessionB, "print(profile_sentinel)\nprint(os.environ.get('PI_RUNTIME_GUARD_TEST'))");
	const directA = (
		await sessionA.executePython("print(profile_sentinel)\nprint(os.environ.get('PI_RUNTIME_GUARD_TEST'))")
	).output.trim();
	console.log(JSON.stringify({ firstA, firstB, secondA, secondB, directA, inheritedA, isolatedChild }));
} finally {
	await Promise.all([sessionA.dispose(), sessionB.dispose(), inheritedSessionA?.dispose(), isolatedSessionA?.dispose()]);
}
process.exit(0);
