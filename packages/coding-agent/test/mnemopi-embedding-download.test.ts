/**
 * What an unattended bot run fetches, shown offline. The local embedding model is the only thing Mnemopi
 * downloads: the first `embed()` calls the local-model initializer, which (in the real process) installs
 * fastembed if it is missing and downloads the model into the shared `~/.omp/cache/fastembed`. The tests
 * replace the initializer with a recorder, so nothing is downloaded or installed, and count its calls:
 *
 * - default settings: the first remember and the first recall both reach the initializer;
 * - `mnemopi.noEmbeddings: true`: it is never reached;
 * - `mnemopi.allowModelDownload: false`: it is reached only when the model is already in the cache, and
 *   otherwise the run answers from keyword search and says so once in the log.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetEmbeddingProviderForTests, setLocalModelInitializerForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { getFastembedCacheDir, logger, refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";
import { closeMnemopiStates, startMnemopiState } from "./helpers/mnemopi-state";

/** fast-bge-base-en-v1.5: the model `mnemopi.embeddingVariant: en` (the default) resolves to. */
const DEFAULT_MODEL_DIR = "Qdrant_bge-base-en-v1.5-onnx-Q";
const MODEL_FILES = [
	"model_optimized.onnx",
	"tokenizer.json",
	"tokenizer_config.json",
	"config.json",
	"special_tokens_map.json",
];

let home: TempDir;
let homedirSpy: Mock<typeof os.homedir>;
const savedEnv: Record<string, string | undefined> = {};
const initCalls: { model: string; cacheDir: string | undefined }[] = [];

beforeEach(() => {
	home = TempDir.createSync("@mnemopi-g10-home-");
	homedirSpy = spyOn(os, "homedir").mockReturnValue(home.path());
	refreshDirsFromEnv();
	// Embeddings are skipped under the test runtime flags; the real path must run.
	for (const key of ["NODE_ENV", "BUN_ENV", "MNEMOPI_NO_EMBEDDINGS", "MNEMOPI_EMBEDDING_MODEL"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	initCalls.length = 0;
	setLocalModelInitializerForTests(async options => {
		initCalls.push({ model: options.model, cacheDir: options.cacheDir });
		return {
			embed: async function* (texts: string[]) {
				yield texts.map(() => [1, 0, 0]);
			},
		};
	});
});

afterEach(async () => {
	await closeMnemopiStates();
	resetEmbeddingProviderForTests();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	homedirSpy.mockRestore();
	refreshDirsFromEnv();
	await home.remove();
});

function warmCache(): void {
	const dir = path.join(getFastembedCacheDir(), DEFAULT_MODEL_DIR);
	fs.mkdirSync(dir, { recursive: true });
	for (const file of MODEL_FILES) fs.writeFileSync(path.join(dir, file), "");
}

/** Remembers one note, then recalls it, on a real session state with embeddings on unless overridden. */
async function rememberAndRecall(overrides: Record<string, unknown>): Promise<string[]> {
	const { state } = startMnemopiState({ "mnemopi.noEmbeddings": false, ...overrides });
	const { memory } = state.getScopedRecallTargets()[0];
	memory.remember("the deploy runbook lives in the ops wiki", { source: "test", scope: "bank" });
	await memory.flushExtractions();
	const hits = await memory.recall("deploy runbook", 3);
	return hits.map(hit => hit.content);
}

describe("what a run fetches", () => {
	it("keeps the shared model cache under the isolated home, never the real one", () => {
		expect(getFastembedCacheDir().startsWith(home.path())).toBe(true);
	});

	it("default settings: remember and recall reach the local model initializer for the default model", async () => {
		await rememberAndRecall({});
		expect(initCalls.length).toBeGreaterThanOrEqual(1);
		expect(initCalls[0]).toEqual({ model: "fast-bge-base-en-v1.5", cacheDir: getFastembedCacheDir() });
	});

	it("mnemopi.noEmbeddings: never reaches the initializer, whatever the run does", async () => {
		const hits = await rememberAndRecall({ "mnemopi.noEmbeddings": true });
		expect(hits).toContain("the deploy runbook lives in the ops wiki");
		expect(initCalls).toEqual([]);
		expect(fs.existsSync(getFastembedCacheDir())).toBe(false);
	});
});

describe("mnemopi.allowModelDownload: false", () => {
	it("with an empty cache: no initializer call, no cache directory created, keyword recall still answers", async () => {
		const hits = await rememberAndRecall({ "mnemopi.allowModelDownload": false });
		expect(hits).toContain("the deploy runbook lives in the ops wiki");
		expect(initCalls).toEqual([]);
		expect(fs.existsSync(getFastembedCacheDir())).toBe(false);
	});

	it("says once in the log that the run uses keyword search", async () => {
		const warn = spyOn(logger, "warn");
		try {
			const { state } = startMnemopiState({ "mnemopi.noEmbeddings": false, "mnemopi.allowModelDownload": false });
			const { memory } = state.getScopedRecallTargets()[0];
			memory.remember("first note about the ops wiki", { source: "test", scope: "bank" });
			await memory.flushExtractions();
			await memory.recall("ops wiki", 3);
			await memory.recall("runbook", 3);
			const notices = warn.mock.calls.filter(call => String(call[0]).includes("keyword search"));
			expect(notices).toHaveLength(1);
			expect(JSON.stringify(notices[0])).toContain("mnemopi.allowModelDownload");
		} finally {
			warn.mockRestore();
		}
	});

	it("with the model already cached: the cached model is used, nothing else is needed", async () => {
		warmCache();
		await rememberAndRecall({ "mnemopi.allowModelDownload": false });
		expect(initCalls.length).toBeGreaterThanOrEqual(1);
		expect(initCalls[0]).toEqual({ model: "fast-bge-base-en-v1.5", cacheDir: getFastembedCacheDir() });
	});

	it("with one model file missing: treated as not cached", async () => {
		warmCache();
		fs.rmSync(path.join(getFastembedCacheDir(), DEFAULT_MODEL_DIR, "tokenizer.json"));
		await rememberAndRecall({ "mnemopi.allowModelDownload": false });
		expect(initCalls).toEqual([]);
	});

	it("is on by default, so a hand session still downloads on first use", async () => {
		await rememberAndRecall({ "mnemopi.noEmbeddings": false });
		expect(initCalls.length).toBeGreaterThanOrEqual(1);
	});
});
