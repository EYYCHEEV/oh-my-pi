/**
 * Event payload and result shapes shared between the extensions and hooks
 * subsystems.
 *
 * Both subsystems observe the same agent/session lifecycle, so the *event*
 * payloads (what happened) and the simpler *result* shapes (handler return
 * values that don't depend on subsystem-specific identifiers like
 * `AgentMessage` vs `Message`) are intentionally identical.
 *
 * Anything that diverges between the two subsystems — UI context, runtime
 * context, command context, tool-call discrimination, or return shapes that
 * carry subsystem-specific message types — lives in the per-subsystem
 * `types.ts` files and is documented there.
 */
import { type AgentMessage, isNonBlankContext, joinAdditionalContext } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation, CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantRetryRecovery, ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Rule } from "../capability/rule";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { GoalModeState } from "../goals/state";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry } from "../session/session-entries";
import type { CacheWarmingAction } from "../session/cache-warmer";
import type { TodoItem } from "@oh-my-pi/pi-tui/tools/todo";

// ============================================================================
// Session Events
// ============================================================================

/** Fired on initial session load */
export interface SessionStartEvent {
	type: "session_start";
}

/**
 * Target history and model state have been restored; handlers may await runtime attachment.
 * Emitted on initialization and successful new/resume/fork/branch restoration.
 * Same-journal tree navigation and compaction keep their existing events, not a new ready event.
 * Not runtime satisfaction or provider completion; session_switch timing is unchanged.
 */
export interface SessionReadyEvent {
	type: "session_ready";
	sessionId: string;
}

/** Fired before switching to another session (can be cancelled) */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	/** Reason for the switch */
	reason: "new" | "resume" | "fork";
	/** Session file we're switching to (only for "resume") */
	targetSessionFile?: string;
}

/** Fired after switching to another session */
export interface SessionSwitchEvent {
	type: "session_switch";
	/** Reason for the switch */
	reason: "new" | "resume" | "fork";
	/** Session file we came from */
	previousSessionFile: string | undefined;
}

/**
 * What a branch transition does with {@link SessionBeforeBranchEvent.entryId}:
 * - `"branch"`: rewinds to a user message; `entryId` and everything after it are dropped.
 * - `"fork"`: forks at a transcript entry; `entryId` is the last entry kept.
 * - `"btw"`: promotes a `/btw` answer; `entryId` is the last entry kept before it.
 */
export type SessionBranchReason = "branch" | "fork" | "btw";

/** Fired before branching a session (can be cancelled) */
export interface SessionBeforeBranchEvent {
	type: "session_before_branch";
	/** Which transition is running; it decides whether `entryId` is kept or dropped. */
	reason: SessionBranchReason;
	/** The entry the transition cuts at; see {@link SessionBranchReason}. */
	entryId: string;
}

/** Fired after branching a session */
export interface SessionBranchEvent {
	type: "session_branch";
	reason: SessionBranchReason;
	previousSessionFile: string | undefined;
}

/** Fired before context compaction (can be cancelled or customized) */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	/** Compaction preparation with messages to summarize, file ops, previous summary, etc. */
	preparation: CompactionPreparation;
	/** Branch entries (root to current leaf). Use to inspect custom state or previous compactions. */
	branchEntries: SessionEntry[];
	/** Optional user-provided instructions for the summary */
	customInstructions?: string;
	/** Abort signal - handlers should pass this to LLM calls and check it periodically */
	signal: AbortSignal;
}

/** Fired before compaction summarization to customize prompts/context */
export interface SessionCompactingEvent {
	type: "session.compacting";
	sessionId: string;
	messages: AgentMessage[];
}

/** Fired after context compaction */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	/** Whether the compaction entry was provided by an extension/hook */
	fromExtension: boolean;
}

/** Fired on process exit (SIGINT/SIGTERM) */
export interface SessionShutdownEvent {
	type: "session_shutdown";
}

/** Fired when a main-agent turn is about to settle; handlers may request one continuation turn. */
export interface SessionStopEvent {
	type: "session_stop";
	messages: AgentMessage[];
	turn_id: number;
	last_assistant_message?: AgentMessage;
	session_id: string;
	session_file?: string;
	stop_hook_active: boolean;
	/** Cancels handler waiting when the active settle pass is aborted. */
	signal: AbortSignal;
}

/** Preparation data for tree navigation (used by session_before_tree event) */
export interface TreePreparation {
	/** Node being switched to */
	targetId: string;
	/** Current active leaf (being abandoned), null if no current position */
	oldLeafId: string | null;
	/** Common ancestor of target and old leaf, null if no common ancestor */
	commonAncestorId: string | null;
	/** Entries to summarize (old leaf back to common ancestor or compaction) */
	entriesToSummarize: SessionEntry[];
	/** Whether user chose to summarize */
	userWantsSummary: boolean;
}

/** Fired before navigating to a different node in the session tree (can be cancelled) */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	/** Preparation data for the navigation */
	preparation: TreePreparation;
	/** Abort signal - honors Escape during summarization (model available via ctx.model) */
	signal: AbortSignal;
}

/** Fired after navigating to a different node in the session tree */
export interface SessionTreeEvent {
	type: "session_tree";
	/** The new active leaf, null if navigated to before first entry */
	newLeafId: string | null;
	/** Previous active leaf, null if there was no position */
	oldLeafId: string | null;
	/** Branch summary entry if one was created */
	summaryEntry?: BranchSummaryEntry;
	/** Whether summary came from extension/hook */
	fromExtension?: boolean;
}

/** Union of all session event types */
export interface GoalUpdatedEvent {
	type: "goal_updated";
	goal: Goal | null;
	state?: GoalModeState;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionReadyEvent
	| SessionBeforeSwitchEvent
	| SessionSwitchEvent
	| SessionBeforeBranchEvent
	| SessionBranchEvent
	| SessionBeforeCompactEvent
	| SessionCompactingEvent
	| SessionCompactEvent
	| SessionStopEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent
	| GoalUpdatedEvent;

// ============================================================================
// Agent / Turn Events
// ============================================================================

/**
 * Fired before each LLM call.
 *
 * Original session messages are NOT modified - only the messages sent to the
 * LLM are affected when a handler returns a replacement (the return shape
 * differs between extensions and hooks; see each subsystem's
 * `ContextEventResult`).
 */
export interface ContextEvent {
	type: "context";
	/** Messages about to be sent to the LLM (deep copy, safe to modify) */
	messages: AgentMessage[];
}

/**
 * Fired when an agent loop starts (once per user prompt).
 */
export interface AgentStartEvent {
	type: "agent_start";
}

export type AgentActivityState = "running" | "waiting_for_human" | "settled";
export type AgentActivityOutcome = "completed" | "interrupted" | "error";

/**
 * Fired for the user-visible lifecycle of one root prompt. Unlike the raw
 * agent_start/agent_end pair, continuation and retry loops do not create new
 * activity runs.
 */
export interface AgentActivityStateEvent {
	type: "agent_activity_state";
	runId: string;
	state: AgentActivityState;
	outcome?: AgentActivityOutcome;
}

/** Fired when an agent loop ends */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
	/**
	 * When true, this is not a terminal settle: an automatic continuation is
	 * scheduled, or background work may resume the session. See
	 * `awaitingAsyncWork` to distinguish the latter.
	 */
	willContinue?: boolean;
	/**
	 * True when this settle is awaiting background work rather than an
	 * agent-owned continuation. Prompt unwinding may still be in progress,
	 * and a background result may already be queued.
	 */
	awaitingAsyncWork?: boolean;
}

/** Fired at the start of each turn */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** Fired at the end of each turn */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

// ============================================================================
// Auto-compaction / Auto-retry Events
// ============================================================================

/** Fired when auto-compaction starts */
export interface AutoCompactionStartEvent {
	type: "auto_compaction_start";
	reason: "threshold" | "overflow" | "idle" | "incomplete";
	action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
}

/** Fired when auto-compaction ends */
export interface AutoCompactionEndEvent {
	type: "auto_compaction_end";
	action: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
	result: CompactionResult | undefined;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;
	/** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
	skipped?: boolean;
}

/** Fired when auto-retry starts */
export interface AutoRetryStartEvent {
	type: "auto_retry_start";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
	errorId?: number;
}

/** Persisted retry error whose transcript presentation changed when the retry saga settled. */
export interface RetryErrorUpdate {
	entryId: string;
	persistenceKey?: string;
	note: string;
	retryRecovery: AssistantRetryRecovery;
}

/** Fired when auto-retry ends */
export interface AutoRetryEndEvent {
	type: "auto_retry_end";
	success: boolean;
	attempt: number;
	finalError?: string;
	retryErrors?: RetryErrorUpdate[];
}

/** Fired when auto-retry switches to a configured fallback model/provider. */
export interface RetryFallbackAppliedEvent {
	type: "retry_fallback_applied";
	from: string;
	to: string;
	role: string;
	/** Decision-time cause, including whether the source request was skipped. */
	reason?: string;
}

/** Fired when a request succeeds on the fallback model applied by auto-retry. */
export interface RetryFallbackSucceededEvent {
	type: "retry_fallback_succeeded";
	model: string;
	role: string;
}

// ============================================================================
// TTSR / Todo Reminders
// ============================================================================

/** Fired when TTSR rule matching interrupts generation */
export interface TtsrTriggeredEvent {
	type: "ttsr_triggered";
	rules: Rule[];
}

/** Fired when todo reminder logic detects unfinished todos */
export interface TodoReminderEvent {
	type: "todo_reminder";
	todos: TodoItem[];
	attempt: number;
	maxAttempts: number;
}

// ============================================================================
// Shared Event Result Shapes
// ============================================================================

/**
 * An answer a `tool_call` handler gives for the call itself. The tool does not run: the model sees
 * `content` as the call's result. An answer is always a normal, non-error result; a handler that
 * wants to refuse the call returns `block` instead.
 */
export interface ToolCallAnswer {
	/** What the model sees: at least one text or image block. */
	content: (TextContent | ImageContent)[];
	/** Optional details stored with the result; must survive `JSON.stringify` because the session stores them. */
	details?: unknown;
}

/** An answer together with the name of the add-on that gave it (never its path). */
export interface HeldToolCallAnswer {
	answer: ToolCallAnswer;
	answeredBy: string;
}

/**
 * Return type for `tool_call` handlers.
 * Allows handlers to block tool execution, revise the input the tool runs with, or answer the call
 * themselves.
 */
export interface ToolCallEventResult {
	/** If true, block the tool from executing */
	block?: boolean;
	/** Reason for blocking (returned to LLM as error) */
	reason?: string;
	/**
	 * Replacement input the tool executes with, instead of the original arguments. Ignored when
	 * `block` is true, and dropped whenever the final result carries an answer (`result`). This is
	 * the raw execution input passed to the tool's `execute` (the handler owns its correctness) —
	 * not the normalized `event.input` view, which may carry derived gate-only fields (e.g. hashline
	 * `edit` `path`/`paths`) that are not real parameters. When multiple handlers set `input`, the
	 * last one wins; handlers do not observe each other's revisions (each sees the original
	 * `event.input`). Not applied to `computer` tool calls.
	 *
	 * For model-issued tool calls the event fires at arg-prep time in the agent loop, before
	 * concurrency scheduling, `tool_execution_start`, and the approval gate: the revision is
	 * revalidated against the tool schema and becomes what the loop schedules, displays, persists,
	 * and executes — the user always approves what actually runs. For dispatches the loop never
	 * sees (nested `write xd://` device calls, Cursor direct execution) the tool wrapper applies
	 * the revision before its own approval gate; a revised nested xd:// input forfeits the outer
	 * write gate's approval and faces the full prompt again.
	 */
	input?: Record<string, unknown>;
	/**
	 * Trusted handler-authored instructions for the next provider request. The
	 * host emits them after tool results with developer/system priority where
	 * supported. Raw tool output and other untrusted data must stay in the tool
	 * result. Distinct non-empty values from every non-blocking handler are preserved in
	 * registration order; ignored when this or a later handler blocks the call.
	 */
	additionalContext?: string;
	/**
	 * Answer the call: the tool does not run and the model sees this result. Every later handler
	 * still runs and can still block (a block discards the answer); with several answers the last
	 * one wins; the model's original call is what approval and the session record use, so any
	 * `input` revision is dropped; `additionalContext` from non-blocking handlers is still
	 * delivered. Approval is unchanged: the answer is used only after the normal approval gate
	 * approves the original call. `tool_result` handlers still see the answered result (with
	 * `answeredBy`) and may change it. A malformed answer, an answer for a `computer` tool call,
	 * and an answer from a legacy hook each block the call, naming the add-on. The stored result
	 * message carries `answeredBy`, set by the host to the add-on's name; a handler cannot set it.
	 */
	result?: ToolCallAnswer;
}

/**
 * What the extension runner returns for a `tool_call` emission: the merged handler results plus
 * `answeredBy`, which the runner (never a handler) sets to the answering add-on's name.
 */
export interface ToolCallEmitResult extends ToolCallEventResult {
	answeredBy?: string;
}

/** Running aggregation of the `tool_call` handlers' results; see {@link accumulateToolCallResult}. */
export interface ToolCallAggregate {
	input?: Record<string, unknown>;
	additionalContext: string[];
	/** Tracked on its own, so a later handler that only adds context cannot erase an earlier answer. */
	answered?: HeldToolCallAnswer;
}

function isAnswerBlock(block: unknown): boolean {
	if (typeof block !== "object" || block === null || !("type" in block)) return false;
	if (block.type === "text") return "text" in block && typeof block.text === "string";
	if (block.type === "image") {
		return (
			"data" in block && typeof block.data === "string" && "mimeType" in block && typeof block.mimeType === "string"
		);
	}
	return false;
}

/**
 * Why `answer` cannot be a tool call's result, or undefined when it can: the content must be a
 * non-empty list of text or image blocks, `isError` must not be set (use `block` to refuse a
 * call), and `details` must survive `JSON.stringify` because the session stores it.
 */
export function toolCallAnswerProblem(answer: unknown): string | undefined {
	if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return "the answer is not an object";
	if (!("content" in answer) || !Array.isArray(answer.content) || answer.content.length === 0) {
		return "content must be a non-empty list of text or image blocks";
	}
	if (!answer.content.every(isAnswerBlock)) return "content has a block that is not a valid text or image block";
	if ("isError" in answer && answer.isError !== undefined) {
		return "an answer is never an error result (return block to refuse the call)";
	}
	if ("details" in answer && answer.details !== undefined) {
		try {
			if (JSON.stringify(answer.details) === undefined) return "details cannot be stored as JSON";
		} catch {
			return "details cannot be stored as JSON";
		}
	}
	return undefined;
}

/** What a caller does with a `tool_call` emission's answer; see {@link decideToolCallAnswer}. */
export type ToolCallAnswerDecision =
	| { kind: "none" }
	| { kind: "refused"; reason: string }
	| { kind: "answered"; held: HeldToolCallAnswer };

const NO_TOOL_CALL_ANSWER: ToolCallAnswerDecision = { kind: "none" };

/**
 * Decide what to do with the answer, if any, in a `tool_call` emission's result. An answer needs the
 * add-on's name for the record, and `computer` calls cannot be answered (there is no safe way to
 * fake a screenshot): both refuse. The caller blocks a refused call with the returned reason.
 */
export function decideToolCallAnswer(
	callResult: ToolCallEmitResult | undefined,
	isComputerCall: boolean,
): ToolCallAnswerDecision {
	if (callResult?.result === undefined) return NO_TOOL_CALL_ANSWER;
	const answeredBy = callResult.answeredBy;
	if (typeof answeredBy !== "string" || answeredBy.length === 0) {
		return {
			kind: "refused",
			reason: "A tool_call answer arrived without the name of the add-on that gave it. The call was blocked.",
		};
	}
	if (isComputerCall) {
		return {
			kind: "refused",
			reason: `Extension ${answeredBy} tried to answer a computer tool call, which cannot be answered. The call was blocked.`,
		};
	}
	return { kind: "answered", held: { answer: callResult.result, answeredBy } };
}

/**
 * Merge one handler's `tool_call` result into the running aggregation.
 * Non-blank `additionalContext` values accumulate in registration order and
 * join (repeats dropped) at the end; `input` stays last-wins. An answer
 * (`result`, already validated by the caller, which passes the add-on's
 * name) is last-wins too but tracked separately from the control result. A
 * `block` result short-circuits the caller, discarding everything collected so far.
 */
export function accumulateToolCallResult(
	aggregated: ToolCallAggregate,
	handlerResult: ToolCallEventResult,
	answeredBy?: string,
): void {
	if (isNonBlankContext(handlerResult.additionalContext)) {
		aggregated.additionalContext.push(handlerResult.additionalContext);
	}
	if (handlerResult.input !== undefined) {
		aggregated.input = handlerResult.input;
	}
	if (handlerResult.result !== undefined && answeredBy !== undefined) {
		const { content, details } = handlerResult.result;
		aggregated.answered = { answer: { content, ...(details !== undefined ? { details } : {}) }, answeredBy };
	}
}

/**
 * Build the aggregated `tool_call` result from collected context, input and answer.
 * Returns undefined when there is nothing to carry beyond the control result.
 * An answer cancels any input rewrite: the model's original call is what approval
 * and the session record use.
 */
export function buildAggregatedToolCallResult(
	result: ToolCallEventResult | undefined,
	aggregated: ToolCallAggregate,
): ToolCallEmitResult | undefined {
	const { input, answered } = aggregated;
	const additionalContext = joinAdditionalContext(aggregated.additionalContext);
	if (additionalContext === undefined && input === undefined && answered === undefined) return result;
	const { additionalContext: _dropped, input: _droppedInput, ...controlResult } = result ?? {};
	return {
		...controlResult,
		...(input !== undefined && answered === undefined ? { input } : {}),
		...(answered !== undefined ? { result: answered.answer, answeredBy: answered.answeredBy } : {}),
		...(additionalContext !== undefined ? { additionalContext } : {}),
	};
}

/**
 * Return type for `tool_result` handlers.
 * Allows handlers to modify tool results and attach passive context.
 */
export interface ToolResultEventResult {
	/** Replacement content array (text and images) */
	content?: (TextContent | ImageContent)[];
	/** Replacement details */
	details?: unknown;
	/** Override isError flag */
	isError?: boolean;
	/**
	 * Trusted handler-authored instructions for the next provider request,
	 * delivered like `ToolCallEventResult.additionalContext` but outside the tool
	 * result. Unlike `tool_call` context it is also delivered when the call
	 * failed: the handler sees the outcome (`event.isError`) and decides, which is
	 * how failure-specific guidance reaches the model. Distinct non-blank values from
	 * every handler are preserved in registration order (repeats are dropped) and precede the call's
	 * `tool_call` context. Dropped only when the loop skips the call.
	 */
	additionalContext?: string;
}

/** Return type for `session_before_switch` handlers */
export interface SessionBeforeSwitchResult {
	/** If true, cancel the switch */
	cancel?: boolean;
}

/**
 * Fired before each prompt-cache warming refresh with the warmer's economics
 * filled in. Return `{ action }` to override whether the refresh is sent.
 */
export interface CacheWarmingDecisionEvent {
	type: "cache_warming_decision";
	/** Price of this refresh: a cache read of the prompt plus one output token. */
	warmCost: number;
	/** Extra price of the next real request if the cache entry is lost. */
	missCost: number;
	/** Estimated chance that a real request arrives before the entry expires. */
	continuationProbability: number;
	/** The warmer's own decision. */
	action: CacheWarmingAction;
}

/** Return type for `cache_warming_decision` handlers. */
export interface CacheWarmingDecisionEventResult {
	/** Override whether this refresh is sent. "stop" ends warming until the next real request. */
	action?: CacheWarmingAction;
}

/** Return type for `session_before_branch` handlers */
export interface SessionBeforeBranchResult {
	/**
	 * If true, abort the branch entirely. No new session file is created,
	 * conversation stays unchanged.
	 */
	cancel?: boolean;
	/**
	 * If true, the branch proceeds (new session file created, session state updated)
	 * but the in-memory conversation is NOT rewound to the branch point.
	 *
	 * Use case: git-checkpoint handler that restores code state separately.
	 * The handler handles state restoration itself, so it doesn't want the
	 * agent's conversation to be rewound (which would lose recent context).
	 *
	 * - `cancel: true` → nothing happens, user stays in current session
	 * - `skipConversationRestore: true` → branch happens, but messages stay as-is
	 * - neither → branch happens AND messages rewind to branch point (default)
	 */
	skipConversationRestore?: boolean;
}

/** Return type for `session_before_compact` handlers */
export interface SessionBeforeCompactResult {
	/** If true, cancel the compaction */
	cancel?: boolean;
	/** Custom compaction result - SessionManager adds id/parentId */
	compaction?: CompactionResult;
}

/** Return type for `session.compacting` handlers */
export interface SessionCompactingResult {
	/** Additional context lines to include in summary */
	context?: string[];
	/** Override the default compaction prompt */
	prompt?: string;
	/** Custom data to store in compaction entry */
	preserveData?: Record<string, unknown>;
}

/** Return type for `session_stop` handlers */
export interface SessionStopEventResult {
	/** Continue the main session with additional context before settling */
	continue?: boolean;
	/** OMP-native model-visible context for the continuation */
	additionalContext?: string;
	/** Claude/Codex-compatible block decision; maps to a continuation */
	decision?: "block";
	/** Claude/Codex-compatible model-visible continuation reason */
	reason?: string;
}

/** Return type for `session_before_tree` handlers */
export interface SessionBeforeTreeResult {
	/** If true, cancel the navigation entirely */
	cancel?: boolean;
	/**
	 * Custom summary (skips default summarizer).
	 * Only used if preparation.userWantsSummary is true.
	 */
	summary?: {
		summary: string;
		details?: unknown;
	};
}
