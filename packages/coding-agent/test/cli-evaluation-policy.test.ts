import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { evaluationEnvironment, evaluationRoot, runEvaluationChild } from "./helpers/evaluation-policy-process";

// Only the child imports OMP. Neither env/cwd nor its module-level admission and
// directory caches can poison this runner or other test files in the full suite.
for (const allowedTools of [["read", "write"], ["yield"]]) {
	test(`public CLI and SDK evaluation contracts isolate host state for ${allowedTools.join("/")}`, async () => {
		const root = await evaluationRoot();
		try {
			const promptPath = path.join(root, "startup-prompt.txt");
			const policyPath = path.join(root, "evaluation-policy.json");
			await Bun.write(promptPath, "EVALUATION_STARTUP_MARKER_47c861");
			const nativeTarget = path.join(root, "native-target.txt");
			await Bun.write(nativeTarget, "PRESERVE_NATIVE_TARGET");
			const bytes = JSON.stringify({
				version: 2,
				run_id: "startup-canary",
				allowed_files: [promptPath, nativeTarget],
				allowed_tools: allowedTools,
				extension_data: { fixture: { nested: [{ value: "original" }] }, allowed_tools: ["eval"] },
			});
			await Bun.write(policyPath, bytes);
			const entry = path.join(root, "public-policy.test.ts");
			await Bun.write(
				entry,
				`import ${JSON.stringify(new URL("./helpers/evaluation-policy.fixture.ts", import.meta.url).pathname)};\n`,
			);
			const args = ["--no-env-file", "test", entry];
			if (allowedTools.includes("yield")) {
				args.push("--test-name-pattern", "SDK refuses a missing extension tool");
			}
			const result = await runEvaluationChild(root, args, {
				...evaluationEnvironment(root),
				OMP_EVALUATION_POLICY: policyPath,
				OMP_EVALUATION_POLICY_SHA256: createHash("sha256").update(bytes).digest("hex"),
			});
			expect(result.exitCode, result.stderr).toBe(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 70_000);
}

test("public CLI rejects duplicate policy keys before command dispatch", async () => {
	const root = await evaluationRoot();
	try {
		const policyPath = path.join(root, "duplicate-policy.json");
		const bytes =
			'{"version":2,"version":2,"run_id":"duplicate","allowed_files":[],"allowed_tools":["read"],"extension_data":{}}';
		await Bun.write(policyPath, bytes);
		const entry = path.join(root, "duplicate.ts");
		// Importing the public CLI must fail at admission, before any command runs.
		await Bun.write(entry, `import ${JSON.stringify(new URL("../src/cli.ts", import.meta.url).pathname)};\n`);
		const result = await runEvaluationChild(root, ["--no-env-file", entry], {
			...evaluationEnvironment(root),
			OMP_EVALUATION_POLICY: policyPath,
			OMP_EVALUATION_POLICY_SHA256: createHash("sha256").update(bytes).digest("hex"),
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Evaluation policy");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 70_000);

let nestedMetadata: unknown = {};
for (let depth = 0; depth < 65; depth++) nestedMetadata = { nested: nestedMetadata };
const invalidPolicies: Record<string, Record<string, unknown>> = {
	"legacy version": { version: 1 },
	"empty tool admission": { allowed_tools: [] },
	"duplicate tool admission": { allowed_tools: ["read", "read"] },
	"wildcard tool admission": { allowed_tools: ["*"] },
	"non-object metadata": { extension_data: [] },
	"excessively nested metadata": { extension_data: nestedMetadata },
	"unsafe numeric metadata": { extension_data: { identity: 2 ** 53 } },
};
for (const [failure, changes] of Object.entries(invalidPolicies)) {
	test(`public CLI refuses ${failure} before command dispatch`, async () => {
		const root = await evaluationRoot();
		try {
			const policyPath = path.join(root, "invalid-policy.json");
			const bytes = JSON.stringify({
				version: 2,
				run_id: "invalid-input",
				allowed_files: [],
				allowed_tools: ["read"],
				extension_data: {},
				...changes,
			});
			await Bun.write(policyPath, bytes);
			const entry = path.join(root, "admission.ts");
			await Bun.write(entry, `import ${JSON.stringify(new URL("../src/cli.ts", import.meta.url).pathname)};\n`);
			const result = await runEvaluationChild(root, ["--no-env-file", entry], {
				...evaluationEnvironment(root),
				OMP_EVALUATION_POLICY: policyPath,
				OMP_EVALUATION_POLICY_SHA256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			});
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Evaluation policy");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 70_000);
}
