import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fastembedRuntimeInstallPlan, isFastembedRuntimeInstalled } from "@oh-my-pi/pi-mnemopi/core/fastembed-runtime";
import { getFastembedRuntimeDir, refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";
import packageManifest from "../package.json" with { type: "json" };

const SPEC = packageManifest.peerDependencies.fastembed;

let home: TempDir;
let homedirSpy: Mock<typeof os.homedir>;

beforeEach(() => {
	home = TempDir.createSync("@fastembed-runtime-");
	homedirSpy = spyOn(os, "homedir").mockReturnValue(home.path());
	refreshDirsFromEnv();
});

afterEach(async () => {
	homedirSpy.mockRestore();
	refreshDirsFromEnv();
	await home.remove();
});

function seedRuntimeInstall(): string {
	const manifest = path.join(
		getFastembedRuntimeDir(),
		fastembedRuntimeInstallPlan().versionKey,
		"node_modules",
		"fastembed",
		"package.json",
	);
	fs.mkdirSync(path.dirname(manifest), { recursive: true });
	fs.writeFileSync(manifest, JSON.stringify({ name: "fastembed", version: SPEC }));
	return manifest;
}

describe("isFastembedRuntimeInstalled", () => {
	it("is true when the pinned version resolves directly, without looking at the runtime cache", async () => {
		expect(await isFastembedRuntimeInstalled(() => SPEC)).toBe(true);
	});

	it("is false when nothing resolves and the runtime cache is empty, and installs nothing", async () => {
		expect(await isFastembedRuntimeInstalled(() => undefined)).toBe(false);
		expect(fs.existsSync(getFastembedRuntimeDir())).toBe(false);
	});

	it("is false when a different version resolves directly and the runtime cache is empty", async () => {
		expect(await isFastembedRuntimeInstalled(() => "0.0.1")).toBe(false);
	});

	it("is true when the on-demand runtime install is already on disk", async () => {
		seedRuntimeInstall();
		expect(await isFastembedRuntimeInstalled(() => undefined)).toBe(true);
	});

	it("resolves the version the repo itself pins, so a source checkout needs no runtime install", async () => {
		expect(await isFastembedRuntimeInstalled()).toBe(true);
	});
});
