import type { MemoryRetainDetails } from "@oh-my-pi/pi-tui/tools/memory";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";
import { isGlobalMemoryScopeAvailable } from "../mnemopi/settings";

const memoryRetainSchemaBase = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

const EXPIRES_DESCRIPTION =
	"when the memory stops being recalled: an ISO date (end of that day, UTC), an ISO date-time with a UTC offset, or a duration from now such as 90m, 12h, 30d, 2w";

/** Mnemopi without a shared bank: project-local items, optional expiry. */
const memoryRetainSchemaWithExpiry = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
		"expires?": type("string").describe(EXPIRES_DESCRIPTION),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

/** Offered only where a shared bank exists; see {@link isGlobalMemoryScopeAvailable}. */
const memoryRetainSchemaWithScope = type({
	items: type({
		content: type("string").describe("information to remember"),
		"context?": type("string").describe("source context"),
		"scope?": type("'project' | 'global'").describe(
			"storage scope; defaults to project, global is for durable cross-project knowledge",
		),
		"expires?": type("string").describe(EXPIRES_DESCRIPTION),
	})
		.array()
		.atLeastLength(1)
		.describe("memories to retain"),
});

type MemoryRetainSchema =
	| typeof memoryRetainSchemaBase
	| typeof memoryRetainSchemaWithExpiry
	| typeof memoryRetainSchemaWithScope;

export type MemoryRetainParams = typeof memoryRetainSchemaWithScope.infer;

const EXPIRES_FORMS =
	"an ISO date (2026-12-01), an ISO date-time with a UTC offset (2026-12-01T09:00:00Z), or a duration (90m, 12h, 30d, 2w)";
const DURATION_PATTERN = /^(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)$/i;
const DURATION_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/**
 * Resolves a `retain` expiry to the UTC ISO timestamp Mnemopi stores as `valid_until`; recall skips the
 * memory from that instant on. A bare date expires at the end of that UTC day. Throws on anything that
 * is not an ISO date, an ISO date-time with an explicit offset, or a `<n><m|h|d|w>` duration, and on a
 * moment that is not in the future.
 */
export function parseRetainExpiry(raw: string, now: number = Date.now()): string {
	const text = raw.trim();
	const duration = DURATION_PATTERN.exec(text);
	let expiresAt: number;
	if (duration) {
		const unit = duration[2].charAt(0).toLowerCase() as keyof typeof DURATION_UNIT_MS;
		expiresAt = now + Number(duration[1]) * DURATION_UNIT_MS[unit];
	} else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
		expiresAt = Date.parse(`${text}T23:59:59.999Z`);
		// Date rolls an impossible day (2026-02-31) forward instead of rejecting it.
		if (!Number.isNaN(expiresAt) && new Date(expiresAt).toISOString().slice(0, 10) !== text) expiresAt = Number.NaN;
	} else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
		expiresAt = Date.parse(text);
	} else {
		expiresAt = Number.NaN;
	}
	if (!Number.isFinite(expiresAt)) throw new Error(`"${raw}" is not ${EXPIRES_FORMS}.`);
	if (expiresAt <= now) throw new Error(`"${raw}" is already in the past; an expiry must be in the future.`);
	return new Date(expiresAt).toISOString();
}

export class MemoryRetainTool implements AgentTool<MemoryRetainSchema, MemoryRetainDetails> {
	readonly name = "retain";
	/** A global item reaches every project's recall, so it needs the same approval as a file write. */
	readonly approval = (args: unknown) =>
		(args as Partial<MemoryRetainParams>).items?.some(item => item.scope === "global") ? "write" : "read";
	readonly label = "Retain";
	get description(): string {
		return prompt.render(retainDescription, {
			globalScope: isGlobalMemoryScopeAvailable(this.session.settings),
			expiry: cfgMemoryBackend.get(this.session.settings) === "mnemopi",
		});
	}
	get parameters(): MemoryRetainSchema {
		if (isGlobalMemoryScopeAvailable(this.session.settings)) return memoryRetainSchemaWithScope;
		return cfgMemoryBackend.get(this.session.settings) === "mnemopi"
			? memoryRetainSchemaWithExpiry
			: memoryRetainSchemaBase;
	}
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Store important facts in long-term memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRetainTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryRetainTool(session);
	}

	async execute(_id: string, params: MemoryRetainParams): Promise<AgentToolResult<MemoryRetainDetails>> {
		const backend = cfgMemoryBackend.get(this.session.settings);
		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error("Mnemopi backend is not initialised for this session.");
			}
			// Resolve the global bank first, so an unsupported scoping mode rejects the batch before any item is stored.
			const globalTarget = params.items.some(item => item.scope === "global")
				? state.getGlobalRetainTarget()
				: undefined;

			// Resolve every expiry up front too: one malformed value rejects the whole batch with nothing stored.
			const now = Date.now();
			const validUntil = params.items.map((item, index) => {
				if (item.expires === undefined) return undefined;
				try {
					return parseRetainExpiry(item.expires, now);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					throw new Error(
						`Invalid expires for item ${index + 1} of ${params.items.length}: ${reason} Nothing was stored.`,
						{ cause: error },
					);
				}
			});

			// A failed write stored nothing. Stop there and say why, and what the batch
			// kept, so the caller retries only what failed instead of trusting a
			// success count.
			const storedIds: string[] = [];
			for (const [index, item] of params.items.entries()) {
				let id: string;
				try {
					id = state.rememberScoped(
						item.content,
						{
							source: "coding-agent-retain",
							importance: 0.75,
							metadata: {
								session_id: state.sessionId,
								cwd: state.session.sessionManager.getCwd(),
								context: item.context ?? null,
								tool: "retain",
							},
							scope: "bank",
							extract: true,
							extractEntities: true,
							veracity: "tool",
							memoryType: "fact",
							...(validUntil[index] === undefined ? {} : { validUntil: validUntil[index] }),
						},
						item.scope === "global" ? globalTarget : undefined,
					);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					const kept =
						storedIds.length === 0
							? "Nothing was stored."
							: `Stored before the failure and kept: ${storedIds.map((storedId, storedIndex) => `item ${storedIndex + 1} (id ${storedId})`).join(", ")}.`;
					const untried = index + 1 < params.items.length ? " Later items were not attempted." : "";
					throw new Error(
						`Mnemopi did not store item ${index + 1} of ${params.items.length}: ${reason}. ${kept}${untried}`,
						{ cause: error },
					);
				}
				storedIds.push(id);
			}

			const count = params.items.length;
			const noun = count === 1 ? "memory" : "memories";
			return {
				content: [{ type: "text", text: `${count} ${noun} stored.` }],
				details: { count },
			};
		}

		const state = this.session.getHindsightSessionState?.();
		if (!state) {
			throw new Error("Hindsight backend is not initialised for this session.");
		}
		if (params.items.some(item => item.scope === "global")) {
			throw new Error("Global memory scope is only available with the Mnemopi backend.");
		}
		if (params.items.some(item => item.expires !== undefined)) {
			throw new Error("Expiry is only available with the Mnemopi backend.");
		}

		// Push every item onto the session-owned queue and return immediately.
		// The queue flushes either when it reaches its batch threshold or when
		// its debounce timer fires. If the eventual batch fails, the queue
		// surfaces a UI-only warning notice — the LLM is not informed.
		for (const item of params.items) {
			state.enqueueRetain(item.content, item.context);
		}

		const count = params.items.length;
		const noun = count === 1 ? "memory" : "memories";
		return {
			content: [{ type: "text", text: `${count} ${noun} queued.` }],
			details: { count },
		};
	}
}
