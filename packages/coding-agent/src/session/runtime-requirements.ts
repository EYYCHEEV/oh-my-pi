import * as path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Explicit startup/SDK feature contract. Older hosts must not be assumed to honor saved requirements. */
export const RUNTIME_REQUIREMENTS_VERSION = 1;

/** A requirement is saved identity, not evidence that runtime code is currently available. */
export interface RuntimeRequirement {
	readonly schemaVersion: 1;
	readonly path: string;
	readonly sha256: string;
	readonly id: string;
	readonly version: number;
	/** Nonsecret, display-only recovery guidance. */
	readonly recoveryHint?: string;
}

export interface RuntimeRequirementDeclaration {
	readonly sessionId: string;
	readonly id: string;
	readonly version: number;
	readonly recoveryHint?: string;
	readonly check: (context: {
		readonly sessionId: string;
		readonly signal: AbortSignal;
	}) => boolean | Promise<boolean>;
}

export interface RequiredRuntimeExtension {
	readonly path: string;
	readonly id: string;
	readonly version: number;
}

export class RuntimeRequirementError extends Error {
	override readonly name = "RuntimeRequirementError";
	constructor(
		readonly sessionId: string,
		reason: string,
		recoveryHint?: string,
	) {
		const hint = sanitizeRuntimeRecoveryHint(recoveryHint);
		super(
			`Session runtime requirement refused execution: ${reason}. Attach the required runtime in a supported host, or leave this conversation. History remains available.${hint ? ` Recovery guidance (display only): ${hint}` : ""}`,
		);
	}
}

export function validRuntimeRequirementId(id: unknown, version: unknown): boolean {
	return (
		typeof id === "string" &&
		/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) &&
		typeof version === "number" &&
		Number.isSafeInteger(version) &&
		version > 0
	);
}

/** Never interpret guidance as commands, paths to load, or proof of attachment. */
export function sanitizeRuntimeRecoveryHint(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// A single bounded printable line prevents terminal controls and forged log lines.
	const hint = sanitizeText(value.slice(0, 2048))
		.replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return sanitizeText(hint.slice(0, 512)) || undefined;
}

export function readRuntimeRequirements(value: unknown, sessionId: string): readonly RuntimeRequirement[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		!value.every((item: unknown): item is RuntimeRequirement => {
			if (!item || typeof item !== "object") return false;
			const record = item as Record<string, unknown>;
			return (
				record.schemaVersion === 1 &&
				typeof record.path === "string" &&
				path.isAbsolute(record.path) &&
				typeof record.sha256 === "string" &&
				/^[a-f0-9]{64}$/.test(record.sha256) &&
				validRuntimeRequirementId(record.id, record.version) &&
				(record.recoveryHint === undefined ||
					(typeof record.recoveryHint === "string" &&
						record.recoveryHint === sanitizeRuntimeRecoveryHint(record.recoveryHint)))
			);
		})
	)
		throw new RuntimeRequirementError(sessionId, "saved requirement data is invalid or unsupported");
	return value;
}

export function sameRuntimeRequirement(a: RuntimeRequirement, b: RuntimeRequirement): boolean {
	return a.path === b.path && a.sha256 === b.sha256 && a.id === b.id && a.version === b.version;
}
