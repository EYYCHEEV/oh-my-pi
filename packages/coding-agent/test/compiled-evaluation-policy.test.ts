import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
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

// The small policy fixture does not exercise the full CLI module graph. Keep
// this on the production compiler path so bytecode loader failures are visible.
test("compiled CLI starts with bytecode and retains host ingress admission", async () => {
	const root = await evaluationRoot();
	try {
		const binary = path.join(root, "omp");
		const build = Bun.spawnSync(
			[process.execPath, path.join(import.meta.dir, "helpers/compile-cli.fixture.ts"), binary],
			{ cwd: path.resolve(import.meta.dir, ".."), timeout: 90_000 },
		);
		expect(build.exitCode, build.stderr.toString()).toBe(0);
		await Bun.write(path.join(root, ".env"), "OMP_EVALUATION_POLICY=untrusted-policy\n");
		const environment = evaluationEnvironment(root);
		const ordinary = Bun.spawnSync([binary, "--version"], { cwd: root, env: environment, timeout: 10_000 });
		expect(ordinary.exitCode, ordinary.stderr.toString()).toBe(0);
		expect(ordinary.stdout.toString()).toBe(`omp/${VERSION}\n`);
		expect(ordinary.stderr.toString()).toBe("");

		const policyPath = path.join(root, "policy.json");
		const bytes = JSON.stringify({
			version: 2,
			run_id: "compiled-cli-admission",
			allowed_files: [],
			allowed_tools: ["fixture"],
			extension_data: {},
		});
		await Bun.write(policyPath, bytes);
		const scoped = Bun.spawnSync([binary, "--version"], {
			cwd: root,
			env: {
				...environment,
				OMP_EVALUATION_POLICY: policyPath,
				OMP_EVALUATION_POLICY_SHA256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			},
			timeout: 10_000,
		});
		expect(scoped.exitCode).toBe(1);
		expect(scoped.stdout.toString()).toBe("");
		expect(scoped.stderr.toString()).toContain("Evaluation policy: unsupported CLI command or worker");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 120_000);
