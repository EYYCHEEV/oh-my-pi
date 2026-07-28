import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomToolAdapter } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/wrapper";
import { renderMCPResult } from "@oh-my-pi/pi-coding-agent/mcp/render";
import { MCPTool, type MCPToolDetails } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPContent, MCPToolCallResult, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type OutputMeta, wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const JPEG_IMAGE = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/jpeg" };
const TOOL_DEFINITION: MCPToolDefinition = {
	name: "capture",
	description: "Return captured MCP content",
	inputSchema: { type: "object", properties: {} },
};

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false, undefined, undefined, "dark", "light");
}, 15_000);

function createTool(content: MCPContent[], isError = false): MCPTool {
	const response: MCPToolCallResult = { content, ...(isError ? { isError: true } : {}) };
	const transport = createMockTransport(new Map([["tools/call", [response]]]));
	return new MCPTool(createMockConnection({ tools: {} }, transport), TOOL_DEFINITION);
}

async function execute(content: MCPContent[], isError = false) {
	return createTool(content, isError).execute("call-1", {}, undefined, undefined!);
}

function textBlocks(content: ReadonlyArray<{ type: string; text?: string }>): string[] {
	return content.filter(block => block.type === "text").map(block => block.text ?? "");
}

describe("MCP image tool results", () => {
	it("forwards image-only output as an exact image block while retaining raw MCP content", async () => {
		const rawContent: MCPContent[] = [JPEG_IMAGE];
		const result = await execute(rawContent);

		expect(result.content).toEqual([JPEG_IMAGE]);
		expect(textBlocks(result.content).join("\n")).not.toContain("[Image: image/jpeg]");
		expect(result.details?.rawContent).toBe(rawContent);
	});

	it("preserves text/image/text order without copying image data into text", async () => {
		const result = await execute([{ type: "text", text: "before" }, JPEG_IMAGE, { type: "text", text: "after" }]);

		expect(result.content).toEqual([{ type: "text", text: "before" }, JPEG_IMAGE, { type: "text", text: "after" }]);
		expect(textBlocks(result.content).join("\n")).not.toContain(TINY_PNG_BASE64);
	});

	it("keeps text-only and resource formatting byte-for-byte compatible", async () => {
		const textOnly = await execute([
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		]);
		expect(textOnly.content).toEqual([{ type: "text", text: "first\n\nsecond" }]);

		const withResource = await execute([
			{ type: "text", text: "first" },
			{ type: "resource", resource: { uri: "file:///result.txt", text: "resource body" } },
			{ type: "resource", resource: { uri: "file:///blob.bin", blob: TINY_PNG_BASE64 } },
			{ type: "text", text: "last" },
		]);
		expect(withResource.content).toEqual([
			{
				type: "text",
				text: "first\n\n[Resource: file:///result.txt]\nresource body\n\n[Resource: file:///blob.bin]\n\nlast",
			},
		]);
	});

	it("retains error semantics and images without leaking image data into error text", async () => {
		const textError = await execute([{ type: "text", text: "denied" }], true);
		expect(textError.isError).toBe(true);
		expect(textError.content).toEqual([{ type: "text", text: "Error: denied" }]);

		const mixedError = await execute(
			[{ type: "text", text: "before" }, JPEG_IMAGE, { type: "text", text: "after" }],
			true,
		);
		expect(mixedError.isError).toBe(true);
		expect(mixedError.content).toEqual([
			{ type: "text", text: "Error: before" },
			JPEG_IMAGE,
			{ type: "text", text: "after" },
		]);
		expect(textBlocks(mixedError.content).join("\n")).not.toContain(TINY_PNG_BASE64);

		const imageFirstError = await execute([JPEG_IMAGE, { type: "text", text: "denied" }, JPEG_IMAGE], true);
		expect(imageFirstError.content).toEqual([
			{ type: "text", text: "Error:" },
			JPEG_IMAGE,
			{ type: "text", text: "denied" },
			JPEG_IMAGE,
		]);
		expect(imageFirstError.details?.isError).toBe(true);
		expect(textBlocks(imageFirstError.content).join("\n")).not.toContain(TINY_PNG_BASE64);

		const imageError = await execute([JPEG_IMAGE], true);
		expect(imageError.isError).toBe(true);
		expect(imageError.content).toEqual([{ type: "text", text: "Error:" }, JPEG_IMAGE]);
		expect(imageError.details?.isError).toBe(true);
		expect(textBlocks(imageError.content).join("\n")).not.toContain(TINY_PNG_BASE64);
	});

	it("renders an image-only result as an image marker instead of no output", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme missing");
		const result = {
			content: [JPEG_IMAGE],
			details: {
				serverName: "test-server",
				mcpToolName: "capture",
				rawContent: [JPEG_IMAGE],
			} satisfies MCPToolDetails,
		};

		const rendered = Bun.stripANSI(
			renderMCPResult(result, { expanded: true, isPartial: false }, theme).render(120).join("\n"),
		);
		expect(rendered).toContain("[Image: image/jpeg]");
		expect(rendered).not.toContain("(no output)");
		expect(rendered).not.toContain(TINY_PNG_BASE64);
	});

	it("renders mixed text and image summaries in order without raw image data", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme missing");
		const result = {
			content: [{ type: "text" as const, text: "before" }, JPEG_IMAGE, { type: "text" as const, text: "after" }],
			details: { serverName: "test-server", mcpToolName: "capture" } satisfies MCPToolDetails,
		};

		const rendered = Bun.stripANSI(
			renderMCPResult(result, { expanded: true, isPartial: false }, theme).render(120).join("\n"),
		);
		expect(rendered.indexOf("before")).toBeLessThan(rendered.indexOf("[Image: image/jpeg]"));
		expect(rendered.indexOf("[Image: image/jpeg]")).toBeLessThan(rendered.indexOf("after"));
		expect(rendered).not.toContain(TINY_PNG_BASE64);
	});

	it("renders an untrusted image MIME as one sanitized summary line", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme missing");
		const unsafeMimeType = "\u001b]8;;https://evil.invalid\u0007image/evil\nnext\tpart\u0000";
		const result = {
			content: [{ type: "image" as const, data: TINY_PNG_BASE64, mimeType: unsafeMimeType }],
			details: { serverName: "test-server", mcpToolName: "capture" } satisfies MCPToolDetails,
		};

		const rawRendered = renderMCPResult(result, { expanded: true, isPartial: false }, theme).render(120).join("\n");
		const rendered = Bun.stripANSI(rawRendered);
		const imageLines = rendered.split("\n").filter(line => line.includes("[Image:"));
		expect(imageLines).toHaveLength(1);
		expect(imageLines[0]).toContain("[Image: image/evil next part]");
		expect(rawRendered).not.toContain("https://evil.invalid");
		expect(rawRendered).not.toContain("\u0007");
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain(TINY_PNG_BASE64);
	});

	it("preserves text/image ordering through the real custom-tool adapter and spill wrapper", async () => {
		const before = "before\n".repeat(220);
		const after = "after\n".repeat(220);
		const mcpTool = createTool([{ type: "text", text: before }, JPEG_IMAGE, { type: "text", text: after }]);
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"tools.artifactSpillThreshold": 1,
			"tools.artifactHeadBytes": 1,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 5,
		});
		const context = {
			sessionManager,
			settings,
			modelRegistry: {} as never,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		} as unknown as AgentToolContext;
		const adapter = new CustomToolAdapter(mcpTool, () => context);
		const wrapped = wrapToolWithMetaNotice(adapter);

		const result = await wrapped.execute("call-spill", {}, undefined, undefined, context);
		expect(result.content.map(block => block.type)).toEqual(["text", "image", "text"]);
		expect(result.content[1]).toEqual(JPEG_IMAGE);
		expect(textBlocks(result.content)[0]).toContain("before");
		expect(textBlocks(result.content)[1]).toContain("after");
		expect(textBlocks(result.content).join("\n")).not.toContain(TINY_PNG_BASE64);
		const meta = (result.details as { meta?: OutputMeta } | undefined)?.meta;
		expect(meta?.truncation?.truncatedBy).toBe("middle");
		expect(meta?.truncation?.artifactId).toBeDefined();
	});

	it("projects an ambiguous tail window into the trailing text block", async () => {
		const repeated = "same\n".repeat(220);
		const mcpTool = createTool([{ type: "text", text: repeated }, JPEG_IMAGE, { type: "text", text: repeated }]);
		const context = {
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"tools.artifactSpillThreshold": 1,
				"tools.artifactHeadBytes": 0,
				"tools.artifactTailBytes": 1,
				"tools.artifactTailLines": 5,
			}),
			modelRegistry: {} as never,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		} as unknown as AgentToolContext;
		const wrapped = wrapToolWithMetaNotice(new CustomToolAdapter(mcpTool, () => context));

		const result = await wrapped.execute("call-tail", {}, undefined, undefined, context);
		expect(result.content.map(block => block.type)).toEqual(["text", "image", "text"]);
		expect(result.content[0]).toEqual({ type: "text", text: "" });
		expect(result.content[1]).toEqual(JPEG_IMAGE);
		expect(textBlocks(result.content)[1]).toStartWith("same\nsame\nsame\nsame\n");
		const meta = (result.details as { meta?: OutputMeta } | undefined)?.meta;
		expect(meta?.truncation?.direction).toBe("tail");
		expect(meta?.truncation?.artifactId).toBeDefined();
	});

	it("projects middle ranges without parsing literal marker text", async () => {
		const marker = "[…2ln elided…]";
		const firstText = `head0\n${marker}\n${"x".repeat(700)}\n${"y".repeat(700)}`;
		const secondText = "tail0\ntail1";
		const mcpTool = createTool([{ type: "text", text: firstText }, JPEG_IMAGE, { type: "text", text: secondText }]);
		const context = {
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"tools.artifactSpillThreshold": 1,
				"tools.artifactHeadBytes": 1,
				"tools.artifactTailBytes": 1,
				"tools.artifactTailLines": 2,
			}),
			modelRegistry: {} as never,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		} as unknown as AgentToolContext;
		const wrapped = wrapToolWithMetaNotice(new CustomToolAdapter(mcpTool, () => context));

		const result = await wrapped.execute("call-marker", {}, undefined, undefined, context);
		expect(result.content.map(block => block.type)).toEqual(["text", "image", "text"]);
		expect(result.content[0]).toEqual({ type: "text", text: `head0\n${marker}\n${marker}` });
		expect(result.content[1]).toEqual(JPEG_IMAGE);
		expect(textBlocks(result.content)[1]).toStartWith(secondText);
		const meta = (result.details as { meta?: OutputMeta } | undefined)?.meta;
		expect(meta?.truncation?.truncatedBy).toBe("middle");
		expect(meta?.truncation?.artifactId).toBeDefined();
	});

	it("keeps an empty retained head and its marker before the image", async () => {
		const firstText = `\n${"x".repeat(2048)}`;
		const secondText = "tail";
		const mcpTool = createTool([{ type: "text", text: firstText }, JPEG_IMAGE, { type: "text", text: secondText }]);
		const context = {
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"tools.artifactSpillThreshold": 1,
				"tools.artifactHeadBytes": 1,
				"tools.artifactTailBytes": 1,
				"tools.artifactTailLines": 5,
			}),
			modelRegistry: {} as never,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		} as unknown as AgentToolContext;
		const wrapped = wrapToolWithMetaNotice(new CustomToolAdapter(mcpTool, () => context));

		const result = await wrapped.execute("call-empty-head", {}, undefined, undefined, context);
		expect(result.content.map(block => block.type)).toEqual(["text", "image", "text"]);
		expect(result.content[0]).toEqual({ type: "text", text: "\n[…2050B elided…]" });
		expect(result.content[1]).toEqual(JPEG_IMAGE);
		expect(textBlocks(result.content)[1]).toStartWith(secondText);
		const meta = (result.details as { meta?: OutputMeta } | undefined)?.meta;
		expect(meta?.truncation?.truncatedBy).toBe("middle");
		expect(meta?.truncation?.artifactId).toBeDefined();
	});

	it("keeps a boundary marker after an intervening image", async () => {
		const firstText = "head";
		const secondText = `${"x".repeat(1500)}\ntail`;
		const mcpTool = createTool([{ type: "text", text: firstText }, JPEG_IMAGE, { type: "text", text: secondText }]);
		const context = {
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"tools.artifactSpillThreshold": 1,
				"tools.artifactHeadBytes": 1,
				"tools.artifactTailBytes": 1,
				"tools.artifactTailLines": 1,
			}),
			modelRegistry: {} as never,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		} as unknown as AgentToolContext;
		const wrapped = wrapToolWithMetaNotice(new CustomToolAdapter(mcpTool, () => context));

		const result = await wrapped.execute("call-boundary", {}, undefined, undefined, context);
		expect(result.content.map(block => block.type)).toEqual(["text", "image", "text"]);
		expect(result.content[0]).toEqual({ type: "text", text: firstText });
		expect(result.content[1]).toEqual(JPEG_IMAGE);
		expect(textBlocks(result.content)[1]).toStartWith("[…1502B elided…]\ntail");
		const meta = (result.details as { meta?: OutputMeta } | undefined)?.meta;
		expect(meta?.truncation?.truncatedBy).toBe("middle");
		expect(meta?.truncation?.artifactId).toBeDefined();
	});
});
