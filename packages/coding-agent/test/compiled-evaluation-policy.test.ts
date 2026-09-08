import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileCodingAgent } from "../scripts/compile-binary";
import { evaluationEnvironment, evaluationRoot } from "./helpers/evaluation-policy-process";

test("compiled admission enforces host policy without promoting dotenv activation", async () => {
	const root = await evaluationRoot();
	try {
		const binary = path.join(root, "omp");
		await compileCodingAgent({
			repoRoot: path.resolve(import.meta.dir, "../../.."),
			entrypoint: path.join(import.meta.dir, "helpers/compiled-evaluation-policy.fixture.ts"),
			outfile: binary,
			transformersVersion: "0.0.0-test",
		});
		await Bun.write(
			path.join(root, ".env"),
			"COMPILED_EVALUATION_DOTENV_CANARY=untrusted\nOMP_EVALUATION_POLICY=untrusted-policy\nOMP_EVALUATION_POLICY_SHA256=untrusted-digest\n",
		);
		const environment = evaluationEnvironment(root);
		const ordinary = Bun.spawnSync([binary], { cwd: root, env: environment, timeout: 10_000 });
		expect(ordinary.exitCode, ordinary.stderr.toString()).toBe(0);
		expect(JSON.parse(ordinary.stdout.toString())).toEqual({ restricted: false, denied: false, dotenv: null });

		const policyPath = path.join(root, "policy.json");
		for (const version of [2, 1]) {
			const bytes = JSON.stringify({
				version,
				run_id: "compiled-admission",
				allowed_files: [],
				allowed_tools: ["fixture"],
				extension_data: {},
			});
			await Bun.write(policyPath, bytes);
			const scoped = Bun.spawnSync([binary], {
				cwd: root,
				env: {
					...environment,
					OMP_EVALUATION_POLICY: policyPath,
					OMP_EVALUATION_POLICY_SHA256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
				},
				timeout: 10_000,
			});
			if (version === 2) {
				expect(scoped.exitCode, scoped.stderr.toString()).toBe(0);
				expect(JSON.parse(scoped.stdout.toString())).toEqual({ restricted: true, denied: true, dotenv: null });
			} else {
				expect(scoped.exitCode).not.toBe(0);
				expect(scoped.stderr.toString()).toContain("unsupported policy version");
			}
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 120_000);
