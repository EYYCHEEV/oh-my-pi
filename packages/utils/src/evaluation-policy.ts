import * as fs from "node:fs";
import * as path from "node:path";
import { COLON, JsonLexer, LBRACE, QUOTE, RBRACE } from "./json-lexer";

export interface EvaluationPolicy {
	readonly version: 2;
	readonly run_id: string;
	readonly allowed_files: readonly string[];
	readonly allowed_tools: readonly string[];
	/** Opaque metadata, deeply frozen at admission; it grants no host authority. */
	readonly extension_data: Readonly<Record<string, unknown>>;
}

/** Original host admission carried to trusted helpers, never reconstructed from live aliases. */
export interface EvaluationAdmission {
	readonly version: 2;
	readonly policy: { readonly path: string; readonly sha256: string; readonly dev: number; readonly ino: number };
	readonly admission: EvaluationPolicy;
	readonly files: readonly {
		readonly path: string;
		readonly canonical_path: string;
		readonly dev: number;
		readonly ino: number;
	}[];
}

const hostPath = process.env.OMP_EVALUATION_POLICY;
const hostDigest = process.env.OMP_EVALUATION_POLICY_SHA256;
const maximumBytes = 1024 * 1024;
const identities = new Map<string, { dev: number; ino: number }>();
const aliases = new Map<string, string>();
let policyIdentity: { dev: number; ino: number } | undefined;
let admitted: EvaluationPolicy | undefined;
let admissionSnapshot: EvaluationAdmission | undefined;

function fail(reason: string): never {
	throw new Error(`Evaluation policy: ${reason}`);
}

function absolutePath(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		!path.isAbsolute(value) ||
		value.includes("\0") ||
		value.includes("://") ||
		value.split(/[\\/]/).includes("..")
	) {
		fail("invalid absolute path");
	}
}

function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key)) ||
		keys.some(key => !(key in value))
	) {
		fail("invalid policy fields");
	}
}

/** JSON.parse validates the grammar first; the shared lexer preserves member occurrences. */
function assertUniqueFields(source: string): void {
	const lexer = new JsonLexer(source, "strict");
	const objects: Set<string>[] = [];
	while (!lexer.atEnd) {
		const token = lexer.peek();
		if (token === QUOTE) {
			const value = lexer.string(QUOTE).value;
			lexer.ws();
			if (lexer.peek() === COLON) {
				const fields = objects.at(-1)!;
				if (fields.has(value)) fail("duplicate policy field");
				fields.add(value);
			}
		} else {
			if (token === LBRACE) objects.push(new Set());
			else if (token === RBRACE) objects.pop();
			lexer.pos++;
		}
	}
}

function freezeMetadata(value: unknown, depth = 0): void {
	if (depth > 64) fail("extension metadata exceeds maximum nesting depth");
	if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))
		fail("extension metadata requires finite JSON numbers within the safe integer range");
	if (value === null || typeof value !== "object") return;
	for (const child of Object.values(value)) freezeMetadata(child, depth + 1);
	Object.freeze(value);
}

function readPolicyBytes(): Buffer {
	absolutePath(hostPath);
	const fd = fs.openSync(hostPath, "r");
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > maximumBytes) fail("policy must be a regular file of at most 1 MiB");
		if (policyIdentity && (stat.dev !== policyIdentity.dev || stat.ino !== policyIdentity.ino))
			fail("policy identity changed");
		policyIdentity ??= { dev: stat.dev, ino: stat.ino };
		const buffer = Buffer.allocUnsafe(stat.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (count === 0) break;
			length += count;
		}
		const bytes = buffer.subarray(0, length);
		if (length !== stat.size || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== hostDigest)
			fail("policy digest mismatch");
		return bytes;
	} finally {
		fs.closeSync(fd);
	}
}

// Capture once, before env.ts is permitted to read any dotenv source. Never
// promote a later ambient environment change into a new session admission.
if (hostPath !== undefined || hostDigest !== undefined) {
	if (!hostPath || !hostDigest || !/^[a-f0-9]{64}$/.test(hostDigest)) fail("missing or invalid host identity");
	if (!process.execArgv.includes("--no-env-file")) fail("scoped launch requires --no-env-file before module loading");
	let value: unknown;
	try {
		const source = readPolicyBytes().toString("utf8");
		value = JSON.parse(source);
		assertUniqueFields(source);
	} catch (error) {
		fail(error instanceof SyntaxError ? "invalid JSON" : "cannot admit policy");
	}
	if (value && typeof value === "object" && "version" in value && value.version !== 2)
		fail("unsupported policy version; expected 2");
	object(value, ["version", "run_id", "allowed_files", "allowed_tools", "extension_data"]);
	if (value.version !== 2 || typeof value.run_id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value.run_id))
		fail("invalid version or run identity");
	if (!Array.isArray(value.allowed_tools) || value.allowed_tools.length === 0)
		fail("allowed_tools must be a nonempty array");
	const tools = new Set<string>();
	for (const tool of value.allowed_tools) {
		if (
			typeof tool !== "string" ||
			tool.length === 0 ||
			tool.length > 128 ||
			tool.trim() !== tool ||
			/[*?]/.test(tool) ||
			tools.has(tool)
		)
			fail("allowed_tools must contain unique exact tool names");
		tools.add(tool);
	}
	if (!value.extension_data || typeof value.extension_data !== "object" || Array.isArray(value.extension_data))
		fail("extension_data must be a JSON object");
	freezeMetadata(value.extension_data);
	if (!Array.isArray(value.allowed_files)) fail("allowed_files must be an array");
	const files: string[] = [];
	for (const file of value.allowed_files) {
		absolutePath(file);
		const canonical = fs.realpathSync(file);
		const stat = fs.statSync(canonical);
		if (!stat.isFile()) fail("evidence must be a regular file");
		files.push(file);
		identities.set(canonical, { dev: stat.dev, ino: stat.ino });
		aliases.set(file, canonical);
	}
	admitted = Object.freeze({
		version: 2,
		run_id: value.run_id,
		allowed_files: Object.freeze(files),
		allowed_tools: Object.freeze(value.allowed_tools as string[]),
		extension_data: value.extension_data as Record<string, unknown>,
	});
	if (!policyIdentity) fail("missing original policy identity");
	admissionSnapshot = Object.freeze({
		version: 2,
		policy: Object.freeze({ path: fs.realpathSync(hostPath), sha256: hostDigest, ...policyIdentity }),
		admission: admitted,
		files: Object.freeze(
			[...aliases].map(([file, canonical]) => {
				const identity = identities.get(canonical);
				if (!identity) fail("missing original evidence identity");
				return Object.freeze({ path: file, canonical_path: canonical, ...identity });
			}),
		),
	});
}

export function getEvaluationPolicy(): EvaluationPolicy | undefined {
	if (process.env.OMP_EVALUATION_POLICY !== hostPath || process.env.OMP_EVALUATION_POLICY_SHA256 !== hostDigest)
		fail("host identity changed after admission");
	if (admitted) readPolicyBytes();
	return admitted;
}

export function getEvaluationAdmission(): EvaluationAdmission | undefined {
	getEvaluationPolicy();
	return admissionSnapshot;
}

/** Revalidate before cached content is returned as well as before opening it. */
export function assertEvaluationEvidence(file: string): void {
	if (!getEvaluationPolicy()) return;
	absolutePath(file);
	const canonical = fs.realpathSync(file);
	const previousTarget = aliases.get(file);
	if (previousTarget !== undefined && previousTarget !== canonical) fail("evidence alias changed");
	const expected = identities.get(canonical);
	if (!expected) fail("unadmitted evidence");
	const stat = fs.statSync(file);
	if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) fail("evidence identity changed");
	aliases.set(file, canonical);
}

/** Descriptor identity check closes the check/open alias race. */
export function readEvaluationEvidence(file: string): string {
	assertEvaluationEvidence(file);
	const fd = fs.openSync(file, "r");
	try {
		if (admitted) {
			const expected = identities.get(fs.realpathSync(file));
			const stat = fs.fstatSync(fd);
			if (!expected || !stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino)
				fail("evidence identity changed");
		}
		return fs.readFileSync(fd, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

export function denyEvaluationIngress(route: string): void {
	if (getEvaluationPolicy()) fail(`unsupported ${route}`);
}

export function assertEvaluationTool(name: string): void {
	const policy = getEvaluationPolicy();
	if (policy && !policy.allowed_tools.includes(name)) fail("tool is not admitted");
}
