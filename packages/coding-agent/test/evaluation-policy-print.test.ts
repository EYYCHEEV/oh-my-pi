import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { evaluationEnvironment, evaluationRoot, runEvaluationChild } from "./helpers/evaluation-policy-process";

for (const mode of ["normal", "restricted", "startup-error", "startup-timeout", "startup-abort", "missing-tool"]) {
	test(`public print workflow uses a product-neutral trusted extension (${mode})`, async () => {
		const root = await evaluationRoot();
		try {
			const system = path.join(root, "system.txt");
			const request = path.join(root, "request.txt");
			await Bun.write(system, "Use the selected fixture interface.");
			await Bun.write(request, "Transform the fixture inputs.");
			const source = await Bun.file(new URL("./helpers/evaluation-probe.ts", import.meta.url)).text();
			await Bun.write(path.join(root, "probe.ts"), source);
			const environment: Record<string, string> = {
				...evaluationEnvironment(root),
				EVALUATION_FIXTURE_MODE: mode,
				EVALUATION_PROBE_SHA256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
			};
			if (mode !== "normal") {
				const policy = JSON.stringify({
					version: 2,
					run_id: "generic-print",
					allowed_files: [system, request],
					allowed_tools: ["probe"],
					extension_data: { fixture: { label: "opaque" } },
				});
				environment.OMP_EVALUATION_POLICY = path.join(root, "policy.json");
				environment.OMP_EVALUATION_POLICY_SHA256 = new Bun.CryptoHasher("sha256").update(policy).digest("hex");
				await Bun.write(environment.OMP_EVALUATION_POLICY, policy);
			}
			const result = await runEvaluationChild(
				root,
				["--no-env-file", new URL("./helpers/evaluation-policy-print.fixture.ts", import.meta.url).pathname],
				environment,
			);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toContain(
				mode.startsWith("startup-") || mode === "missing-tool"
					? "GENERIC_STARTUP_REFUSED"
					: "GENERIC_PRINT_VERIFIED",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 70_000);
}
