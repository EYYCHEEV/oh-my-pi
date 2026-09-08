import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluationEnvironment, evaluationRoot, runEvaluationChild } from "./helpers/evaluation-policy-process";

const { join } = path;
const { writeFile, rm } = fs;

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

for (const launch of ["runtime-argv", "host-BUN_OPTIONS"] as const) {
	test(`source CLI characterizes ${launch} without weakening parsed-flag admission`, async () => {
		const root = await evaluationRoot();
		try {
			const policyPath = join(root, "policy.json");
			const bytes = JSON.stringify({
				version: 2,
				run_id: "launch-canary",
				allowed_files: [],
				allowed_tools: ["probe"],
				extension_data: {},
			});
			await writeFile(policyPath, bytes);
			await writeFile(join(root, ".env"), "EVALUATION_DOTENV_MARKER=must-not-load\n");
			// The probe samples runtime state before importing OMP, then imports the
			// real public CLI. It never dispatches a prompt, provider, or live pane.
			const probe = `
const observed = {
  dotenvLoaded: process.env.EVALUATION_DOTENV_MARKER !== undefined,
  runtimeFlag: process.execArgv.includes("--no-env-file"),
  cliAdmitted: false,
  commandRefused: false,
};
try {
  const { runCli } = await import(${JSON.stringify(cliPath)});
  observed.cliAdmitted = true;
  try { await runCli(["--version"]); }
  catch { observed.commandRefused = true; }
} catch {}
process.stdout.write("EVALUATION_LAUNCH_RESULT=" + JSON.stringify(observed) + "\\n");
`;
			const result = await runEvaluationChild(
				root,
				[...(launch === "runtime-argv" ? ["--no-env-file"] : []), "--eval", probe],
				{
					...evaluationEnvironment(root),
					BUN_OPTIONS: launch === "host-BUN_OPTIONS" ? "--no-env-file" : "",
					OMP_EVALUATION_POLICY: policyPath,
					OMP_EVALUATION_POLICY_SHA256: createHash("sha256").update(bytes).digest("hex"),
				},
			);
			expect(result.exitCode, result.stderr).toBe(0);
			const line = result.stdout.split("\n").find(line => line.startsWith("EVALUATION_LAUNCH_RESULT="));
			expect(line).toBeDefined();
			const observed = JSON.parse(line!.slice("EVALUATION_LAUNCH_RESULT=".length));
			if (launch === "runtime-argv") {
				expect(observed.dotenvLoaded).toBe(false);
				expect(observed.runtimeFlag).toBe(true);
				expect(observed.cliAdmitted).toBe(true);
				expect(observed.commandRefused).toBe(true);
			} else {
				// An env string is not runtime attestation. If Bun does not expose
				// it as a parsed flag, this route must remain unsupported.
				expect(observed.cliAdmitted).toBe(observed.runtimeFlag);
				if (observed.cliAdmitted) expect(observed.dotenvLoaded).toBe(false);
				process.stdout.write(`BUN_OPTIONS activation: ${JSON.stringify(observed)}\n`);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 70_000);
}

for (const identity of ["absent", "path-only", "digest-only", "empty", "bad-digest"] as const) {
	test(`public CLI admission treats ${identity} host identity fail-closed except both absent`, async () => {
		const root = await evaluationRoot();
		try {
			const policyPath = join(root, "policy.json");
			const bytes = JSON.stringify({
				version: 2,
				run_id: "identity-canary",
				allowed_files: [],
				allowed_tools: ["probe"],
				extension_data: {},
			});
			await writeFile(policyPath, bytes);
			const entry = join(root, "admission.ts");
			await writeFile(entry, `import ${JSON.stringify(cliPath)};\n`);
			const environment = evaluationEnvironment(root);
			if (identity !== "absent" && identity !== "digest-only")
				environment.OMP_EVALUATION_POLICY = identity === "empty" ? "" : policyPath;
			if (identity !== "absent" && identity !== "path-only") {
				environment.OMP_EVALUATION_POLICY_SHA256 =
					identity === "bad-digest" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
			}
			const result = await runEvaluationChild(root, ["--no-env-file", entry], environment);
			if (identity === "absent") expect(result.exitCode, result.stderr).toBe(0);
			else {
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain("Evaluation policy");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 70_000);
}

test("scoped public CLI rejects special and profile-hidden routes before dispatch", async () => {
	const root = await evaluationRoot();
	try {
		const policyPath = join(root, "policy.json");
		const bytes = JSON.stringify({
			version: 2,
			run_id: "route-canary",
			allowed_files: [],
			allowed_tools: ["probe"],
			extension_data: {},
		});
		await writeFile(policyPath, bytes);
		const entry = join(root, "routing.test.ts");
		await writeFile(
			entry,
			`import ${JSON.stringify(new URL("./helpers/evaluation-policy-routing.fixture.ts", import.meta.url).pathname)};\n`,
		);
		for (const scoped of [true, false]) {
			const environment = evaluationEnvironment(root);
			if (scoped) {
				environment.OMP_EVALUATION_POLICY = policyPath;
				environment.OMP_EVALUATION_POLICY_SHA256 = createHash("sha256").update(bytes).digest("hex");
			}
			const result = await runEvaluationChild(root, ["--no-env-file", "test", entry], environment);
			expect(result.exitCode, result.stderr).toBe(0);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 70_000);
