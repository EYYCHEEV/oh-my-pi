import { describe, expect, it } from "bun:test";
import { isNativeShell } from "../../src/cli/native-shell";
import { commands, resolveCliArgv } from "../../src/cli-commands";
import { generateLiveCompletion } from "../../src/commands/completions";

const SHELLS = ["zsh", "bash", "sh"] as const;

describe("native shell words are not omp subcommands", () => {
	it("keeps internal dialect recognition separate from CLI registration", () => {
		for (const shell of SHELLS) expect(isNativeShell(shell)).toBe(true);
		for (const other of [undefined, "shell", "fish", "-c", "launch"]) expect(isNativeShell(other)).toBe(false);
	});

	it("routes each word like any unknown word without registering shell help", () => {
		for (const shell of SHELLS) {
			expect(commands.find(c => c.name === shell)).toBeUndefined();
			expect(resolveCliArgv([shell, "-c", "printf control"])).toEqual({
				argv: ["launch", shell, "-c", "printf control"],
			});
		}
	});

	it("omits shell subcommands from the generated completions", async () => {
		const zsh = await generateLiveCompletion("zsh");
		const bash = await generateLiveCompletion("bash");
		const fish = await generateLiveCompletion("fish");
		for (const shell of SHELLS) {
			expect(zsh.includes(`'${shell}:Run `)).toBe(false);
			expect(zsh.includes(`_omp_cmd_${shell}()`)).toBe(false);
			expect(bash.includes(`_omp_cmd_${shell}()`)).toBe(false);
			expect(fish.includes(`-a '${shell}' -d 'Run `)).toBe(false);
		}
	}, 30_000);
});
