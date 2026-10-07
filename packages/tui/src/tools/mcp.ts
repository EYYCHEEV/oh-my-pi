/**
 * TUI rendering for MCP tools.
 *
 * Provides structured display of MCP tool calls and results,
 * showing args and output in JSON tree format similar to task tool.
 */
import { type Component, Markdown } from "../index";
import { sanitizeText } from "@oh-my-pi/pi-utils";

import type { NativeToolHead, NativeToolView, RenderResultOptions } from "./renderer";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { ansi, md } from "../native/describe";
import type { NativeChild } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorText, noteText, truncationNotice } from "./native-view";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import {
	describeJsonTree,
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree";
import { formatStyledTruncationWarning, stripOutputNotice } from "./output-meta";
import { formatExpandHint, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../render/render-utils";
import { formatOutputPaneLines, styleToolOutputLine } from "../render/output-pane";
import type { StatusLineOptions } from "../render/status-line";
import { plainToolCard, type ToolCardPhase } from "../render/tool-card";

/** Expanded Args tree shared by the MCP result cards. */
function buildMcpArgsSection(args: Record<string, unknown>, theme: Theme): readonly string[] {
	const lines: string[] = [theme.fg("dim", "Args")];
	const tree = renderJsonTreeLines(
		args,
		theme,
		JSON_TREE_MAX_DEPTH_EXPANDED,
		JSON_TREE_MAX_LINES_EXPANDED,
		JSON_TREE_SCALAR_LEN_EXPANDED,
	);
	lines.push(...tree.lines);
	if (tree.truncated) lines.push(theme.fg("dim", "…"));
	lines.push("");
	return lines;
}

/**
 * Render MCP tool call.
 */
export function renderMCPCall(args: Record<string, unknown>, theme: Theme, label: string): Component {
	return plainToolCard(
		theme,
		({ contentWidth }) => {
			const body: string[] = [];
			if (args && typeof args === "object" && Object.keys(args).length > 0) {
				// Inline preview budgeted against the render width, leaving room for
				// the ` └─ ` connector prefix instead of a fixed cap.
				const inlineBudget = Math.max(20, contentWidth - Bun.stringWidth(theme.tree.last) - 2);
				const preview = formatArgsInline(args, inlineBudget);
				if (preview) {
					body.push(` ${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", preview)}`);
				}
			}

			return {
				status: { icon: "pending", title: label },
				phase: "pending",
				body,
				applyBg: false,
			};
		},
		{ paddingX: 0, paddingY: 0 },
	);
}

/** Render an MCP status/args prefix followed by Markdown-aware text output. */
function renderMarkdownMCPResult(
	result: { details?: MCPToolDetails; isError?: boolean },
	trimmedOutput: string,
	truncationWarning: string | null,
	options: RenderResultOptions,
	theme: Theme,
	args?: Record<string, unknown>,
): Component {
	const markdown = new Markdown(trimmedOutput, 0, 0, getMarkdownTheme(), {
		color: text => theme.fg("toolOutput", text),
	});
	// Args tree and output pane rows are spinner-invariant; rebuild only on
	// expansion or width change instead of every animated frame.
	let bodyMemo: { expanded: boolean; width: number; lines: readonly string[] } | undefined;
	return plainToolCard(
		theme,
		({ contentWidth }) => {
			const isError = result.isError ?? result.details?.isError ?? false;
			const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
			if (bodyMemo === undefined || bodyMemo.expanded !== options.expanded || bodyMemo.width !== contentWidth) {
				bodyMemo = {
					expanded: options.expanded,
					width: contentWidth,
					lines: buildMarkdownMcpBody(markdown, truncationWarning, options.expanded, contentWidth, theme, args),
				};
			}
			const body = bodyMemo.lines;
			const status: StatusLineOptions = options.isPartial
				? {
						icon: options.spinnerFrame !== undefined ? "running" : "pending",
						spinnerFrame: options.spinnerFrame,
						title,
					}
				: isError
					? { icon: "error", title }
					: { iconOverride: theme.styledSymbol("tool.mcp", "accent"), title };
			const phase: ToolCardPhase = options.isPartial ? "partial" : isError ? "error" : "success";
			return {
				status,
				phase,
				body,
				applyBg: false,
			};
		},
		{ paddingX: 0, paddingY: 0, onInvalidate: () => (bodyMemo = undefined) },
	);
}

function buildMarkdownMcpBody(
	markdown: Markdown,
	truncationWarning: string | null,
	expanded: boolean,
	contentWidth: number,
	theme: Theme,
	args: Record<string, unknown> | undefined,
): string[] {
	const body: string[] = [];
	if (expanded && args && Object.keys(args).length > 0) {
		body.push(...buildMcpArgsSection(args, theme));
	}
	const rendered = markdown.render(Math.max(1, contentWidth));
	body.push(
		...formatOutputPaneLines(
			{
				lines: rendered,
				expanded,
				collapsedMaxLines: 4,
				expandedMaxLines: 12,
				showExpandHintWhenUncapped: true,
			},
			theme,
		).lines,
	);
	if (truncationWarning) body.push(truncationWarning);
	return body;
}

type MCPRenderResult = {
	content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
	details?: MCPToolDetails;
	isError?: boolean;
};

/** Preserve result order without exposing image bytes to either renderer. */
function mcpDisplayOutput(result: MCPRenderResult): string {
	const displayBlocks: string[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "image") {
			const mimeType = truncateToWidth(
				replaceTabs(sanitizeText(block.mimeType ?? ""))
					.replace(/\s+/g, " ")
					.trim(),
				TRUNCATE_LENGTHS.CONTENT,
			);
			displayBlocks.push(`[Image: ${mimeType || "unknown"}]`);
		} else if (block.type === "text") {
			const text = stripOutputNotice(block.text ?? "", result.details?.meta).trimEnd();
			if (text) displayBlocks.push(text);
		}
	}
	return displayBlocks.join("\n\n");
}

/**
 * Render MCP tool result.
 */
export function renderMCPResult(
	result: MCPRenderResult,
	options: RenderResultOptions,
	theme: Theme,
	args?: Record<string, unknown>,
): Component {
	const { expanded } = options;
	const trimmedOutput = mcpDisplayOutput(result);
	const singleTextOutput =
		result.content.length === 1 && result.content[0]?.type === "text" ? trimmedOutput : undefined;
	const truncationWarning = result.details?.meta?.truncation
		? formatStyledTruncationWarning(result.details.meta, theme)
		: null;
	let parsedOutput: unknown;
	let isJsonOutput = false;
	if (singleTextOutput?.startsWith("{") || singleTextOutput?.startsWith("[")) {
		try {
			parsedOutput = JSON.parse(trimmedOutput);
			isJsonOutput = true;
		} catch {
			// Non-JSON text beginning with a bracket is still eligible for Markdown.
		}
	}
	if (singleTextOutput && renderMarkdownResults && !isJsonOutput) {
		return renderMarkdownMCPResult(result, trimmedOutput, truncationWarning, options, theme, args);
	}
	// `expanded`, args and output are fixed for this card; only width varies the body.
	let bodyMemo: { width: number; lines: readonly string[] } | undefined;
	return plainToolCard(
		theme,
		({ contentWidth }) => {
			const isError = result.isError ?? result.details?.isError ?? false;
			const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
			const status: StatusLineOptions = options.isPartial
				? {
						icon: options.spinnerFrame !== undefined ? "running" : "pending",
						spinnerFrame: options.spinnerFrame,
						title,
					}
				: isError
					? { icon: "error", title }
					: { iconOverride: theme.styledSymbol("tool.mcp", "accent"), title };
			const phase: ToolCardPhase = options.isPartial ? "partial" : isError ? "error" : "success";
			if (bodyMemo === undefined || bodyMemo.width !== contentWidth) {
				bodyMemo = { width: contentWidth, lines: buildMcpResultBody(contentWidth) };
			}
			return { status, phase, body: bodyMemo.lines, applyBg: false };
		},
		{ paddingX: 0, paddingY: 0, onInvalidate: () => (bodyMemo = undefined) },
	);

	function buildMcpResultBody(contentWidth: number): string[] {
		const body: string[] = [];
		// Args section (when expanded)
		if (expanded && args && typeof args === "object" && Object.keys(args).length > 0) {
			body.push(...buildMcpArgsSection(args, theme));
		}

		// Output section. The body and spill metadata are normalized before
		// component selection so the opt-in Markdown path can use its own renderer.

		if (!trimmedOutput) {
			body.push(theme.fg("dim", "(no output)"));
			return body;
		}

		// Preserve the existing structured JSON renderer regardless of the
		// Markdown preference; JSON trees remain more useful than styled source.
		if (isJsonOutput) {
			const maxDepth = expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
			const maxLines = expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
			const maxScalarLen = expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
			const tree = renderJsonTreeLines(parsedOutput, theme, maxDepth, maxLines, maxScalarLen);

			if (tree.lines.length > 0) {
				body.push(...tree.lines);
				if (!expanded) {
					body.push(formatExpandHint(theme, expanded, true));
				} else if (tree.truncated) {
					body.push(theme.fg("dim", "…"));
				}
				if (truncationWarning) body.push(truncationWarning);
				return body;
			}
		}

		// Raw text output, capped to the first rows with an expand hint while collapsed.
		body.push(
			...formatOutputPaneLines(
				{
					lines: trimmedOutput.split("\n"),
					expanded,
					collapsedMaxLines: 4,
					expandedMaxLines: 12,
					styleLine: line => truncateToWidth(styleToolOutputLine(line, theme), contentWidth),
					showExpandHintWhenUncapped: true,
				},
				theme,
			).lines,
		);

		if (truncationWarning) body.push(truncationWarning);
		return body;
	}
}

/** Visible MCP argument entries (streaming/intent bookkeeping keys dropped). */
function visibleMcpArgs(args: Record<string, unknown> | undefined): [string, unknown][] {
	if (!args || typeof args !== "object") return [];
	return Object.entries(args).filter(([key]) => key !== INTENT_FIELD && key !== "__partialJson");
}

/** Inline args summary budget in characters (a data cap, not a width). */
const MCP_ARGS_SUMMARY_CHARS = 160;

/** Native MCP head: the tool title with a one-line args summary as target. */
function mcpHead(title: string, args: Record<string, unknown> | undefined): NativeToolHead {
	const entries = visibleMcpArgs(args);
	const summary =
		entries.length > 0
			? formatArgsInline(Object.fromEntries(entries), MCP_ARGS_SUMMARY_CHARS, { characterBudget: true })
			: "";
	return { title, target: summary ? plainText(summary) : undefined, targetKind: "text" };
}

/** Native MCP call view: the head only, inline while pending. */
export function describeMCPCall(args: Record<string, unknown>, label: string): NativeToolView {
	return { tool: mcpHead(label, args), inline: true };
}

const mcpResultMemo = new OwnerMemo<NativeToolView | undefined>();

/**
 * Native MCP result view: JSON output as a JSON tree, Markdown when the
 * preference is on, otherwise the raw text as tool output. The head's args
 * summary stands in for the ANSI card's Args tree.
 */
export function describeMCPResult(
	result: MCPRenderResult,
	_options: RenderResultOptions,
	args?: Record<string, unknown>,
): NativeToolView | undefined {
	// Callers allocate a fresh args object per streamed delta, so identity is a sound dep.
	return mcpResultMemo.get(result, [renderMarkdownResults, args], () => {
		const output = mcpDisplayOutput(result);
		const singleTextOutput = result.content.length === 1 && result.content[0]?.type === "text";
		const isError = result.isError ?? result.details?.isError ?? false;
		const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
		const body: NativeChild[] = [];
		let parsed: unknown;
		let isJson = false;
		if (singleTextOutput && (output.startsWith("{") || output.startsWith("["))) {
			try {
				parsed = JSON.parse(output);
				isJson = true;
			} catch {
				// Bracketed non-JSON text falls through to Markdown/raw output.
			}
		}
		if (!output) body.push(noteText("(no output)"));
		else if (isError) body.push(errorText(output));
		else if (isJson) body.push(describeJsonTree(parsed));
		else if (singleTextOutput && renderMarkdownResults) body.push(md(output));
		else body.push(ansi(output));
		const warning = truncationNotice(result.details?.meta);
		if (warning) body.push(warning);
		return {
			tool: mcpHead(title, args),
			tone: isError ? "error" : undefined,
			body,
			preview: { lines: 4 },
		};
	});
}

import type { OutputMeta } from "./output-meta";

let renderMarkdownResults = false;

/** Set whether plain MCP text results render as Markdown. */
export function setMcpRenderMarkdownResults(enabled: boolean): void {
	renderMarkdownResults = enabled;
}

/** Content types in tool results */
export interface MCPTextContent {
	type: "text";
	text: string;
}

/** Base64-encoded image returned by an MCP tool. */
export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

/** Embedded text or binary resource returned by an MCP tool. */
export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

/** Supported MCP result content blocks retained in display metadata. */
export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

/** MCP result details shared by renderers and programmatic tool consumers. */
export interface MCPToolDetails {
	/** Server name */
	serverName: string;
	/** Original MCP tool name */
	mcpToolName: string;
	/** Whether the call resulted in an error */
	isError?: boolean;
	/** Raw content from MCP response */
	rawContent?: MCPContent[];
	/** Server-supplied structured data, independent of the model-facing text rendering. */
	structuredContent?: Record<string, unknown>;
	/** Structured metadata from the MCP response */
	mcpMeta?: Record<string, unknown>;
	/** Provider ID (e.g., "claude", "mcp-json") */
	provider?: string;
	/** Provider display name (e.g., "Claude Code", "MCP Config") */
	providerName?: string;
	/** Structured output metadata (set by the spill wrapper when output is truncated to an artifact). */
	meta?: OutputMeta;
}

/** Registry prefix every minted MCP tool name carries. */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/**
 * Parse an MCP tool name back to server and tool components.
 *
 * Note: This returns the normalized tool name (with server prefix stripped).
 * The original MCP tool name may have had the server name as a prefix.
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return null;

	const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}
