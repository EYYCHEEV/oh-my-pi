import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { HookEditorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/hook-editor";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	CURSOR_MARKER,
	isFocusable,
	setKeybindings,
	type TUI,
} from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

function createTui(): TUI {
	return {
		requestRender: vi.fn(),
		setFocus: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		terminal: { columns: 120 },
	} as unknown as TUI;
}

function renderText(component: HookEditorComponent, width = 120): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function renderLines(component: HookEditorComponent, width = 120): string[] {
	return Bun.stripANSI(component.render(width).join("\n")).split("\n");
}

function largePasteText(): string {
	return Array.from({ length: 11 }, (_, index) => `pasted line ${index + 1}`).join("\n");
}

type TestContext = InteractiveModeContext & {
	editorContainer: {
		children: unknown[];
		clear: () => void;
		addChild: (child: unknown) => void;
	};
};

function createControllerContext() {
	let editorText = "";
	const editor = {
		id: "core-editor",
		getText: vi.fn(() => editorText),
		setText: vi.fn((text: string) => {
			editorText = text;
		}),
		pasteText: vi.fn((text: string) => {
			editorText += text;
		}),
	};
	const editorContainer = {
		children: [] as unknown[],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	let focused: unknown;
	let toolUiContext: ExtensionUIContext | undefined;
	const ui = {
		requestRender: vi.fn(),
		setFocus: vi.fn((component: unknown) => {
			focused = component;
		}),
		getFocused: vi.fn(() => focused),
		showOverlay: vi.fn((component: unknown) => {
			const preFocus = focused;
			ui.setFocus(component);
			return {
				hide: vi.fn(() => {
					ui.setFocus(preFocus ?? null);
					ui.requestRender();
				}),
				setHidden: vi.fn(),
				isHidden: vi.fn(() => false),
			};
		}),
		start: vi.fn(),
		stop: vi.fn(),
		terminal: { columns: 120 },
	} as unknown as TestContext["ui"] & {
		setFocus: Mock<any>;
		getFocused: Mock<any>;
		requestRender: Mock<any>;
		showOverlay: Mock<any>;
	};
	const ctx = {
		editor,
		editorContainer,
		ui,
		hookEditor: undefined,
		session: { extensionRunner: undefined },
		setToolUIContext(context: ExtensionUIContext): void {
			toolUiContext = context;
		},
	} as unknown as TestContext;

	return {
		ctx,
		editor,
		editorContainer,
		ui,
		getToolUiContext() {
			if (!toolUiContext) throw new Error("expected extension UI context");
			return toolUiContext;
		},
	};
}

function createPromptAutocompleteProvider(): AutocompleteProvider {
	return {
		getSuggestions: vi.fn(async () => ({
			prefix: "/",
			items: [{ value: "goal", label: "/goal", description: "Set a goal objective" }],
		})),
		applyCompletion: vi.fn((lines, cursorLine, cursorCol, item, prefix) => {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, Math.max(0, cursorCol - prefix.length));
			const after = line.slice(cursorCol);
			const nextLine = `${before}/${item.value} ${after}`;
			const nextLines = [...lines];
			nextLines[cursorLine] = nextLine;
			return {
				lines: nextLines,
				cursorLine,
				cursorCol: before.length + item.value.length + 2,
			};
		}),
	};
}

function createSkillAutocompleteProvider(): AutocompleteProvider {
	return new CombinedAutocompleteProvider([{ name: "skill:security-scan", description: "Security scan" }], "/tmp");
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function createInteractiveGoalHarness(): Promise<{
	mode: InteractiveMode;
	session: AgentSession;
	tempDir: TempDir;
	authDir: TempDir;
}> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-hook-editor-");
	const authDir = TempDir.createSync("@pi-goal-hook-editor-auth-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"plan.enabled": true,
	});
	const authStorage = await AuthStorage.create(path.join(authDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5") as Model | undefined;
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test");
	return { mode, session, tempDir, authDir };
}

describe("HookEditorComponent default (hook) mode", () => {
	it("inserts a newline on Enter instead of submitting immediately", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel);

		component.handleInput("a");
		component.handleInput("b");
		component.handleInput("\n");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		component.handleInput("c");
		component.handleInput("d");
		component.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("ab\ncd");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits the current text on Ctrl+Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "line 1\nline 2", onSubmit, onCancel);

		component.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("line 1\nline 2");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits Ctrl+Enter variants with NumLock or keypad Enter metadata", () => {
		const variants = ["\x1b[13;133u", "\x1b[57414;5u", "\x1b[57414;133u"];

		for (const variant of variants) {
			const onSubmit = vi.fn();
			const onCancel = vi.fn();
			const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel);

			component.handleInput(variant);

			expect(onSubmit).toHaveBeenCalledTimes(1);
			expect(onSubmit).toHaveBeenCalledWith("draft");
			expect(onCancel).not.toHaveBeenCalled();
		}
	});

	it("submits LF-prefixed modified Enter sequences", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel);

		component.handleInput("\n\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("draft");
		expect(onCancel).not.toHaveBeenCalled();
	});
	it("submits the current text on Ctrl+Q (Windows Terminal fallback for #2118)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "line 1\nline 2", onSubmit, onCancel);

		// Ctrl+Q raw byte (0x11). Windows Terminal cannot deliver a distinct
		// Ctrl+Enter, so app.message.followUp also binds Ctrl+Q (#1903), and the
		// hook editor must honor it for the same reason.
		component.handleInput("\x11");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("line 1\nline 2");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("keeps Ctrl+Q working after Enter inserts a newline (Windows Terminal)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel);

		component.handleInput("a");
		component.handleInput("b");
		// Windows Terminal sends bare `\r` for both Enter and Ctrl+Enter; the
		// hook editor must treat `\r` as a newline and reserve Ctrl+Q for submit.
		component.handleInput("\r");
		component.handleInput("c");
		component.handleInput("d");
		expect(onSubmit).not.toHaveBeenCalled();

		component.handleInput("\x11");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("ab\ncd");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("expands large paste markers when submitting on Ctrl+Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel);
		const pasted = largePasteText();

		component.handleInput(`\x1b[200~${pasted}\x1b[201~`);

		expect(renderText(component)).toContain("[Paste #1, +11 lines]");

		component.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith(pasted);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("cancels on Escape", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel);

		component.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

describe("HookEditorComponent prompt-style mode", () => {
	it("submits on plain Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("a");
		component.handleInput("b");
		component.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("ab");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits on alternate Enter encodings recognized by the key matcher", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("a");
		component.handleInput("\x1bOM");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("a");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits when a terminal reports plain Enter as LF", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("a");
		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("a");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("uses the supplied command autocomplete provider while editing a prompt-style objective", async () => {
		const provider = createPromptAutocompleteProvider();
		const objectiveEditorOptions = {
			promptStyle: true,
			autocompleteProvider: provider,
		};
		const component = new HookEditorComponent(
			createTui(),
			"Goal objective",
			undefined,
			vi.fn(),
			vi.fn(),
			objectiveEditorOptions,
		);

		component.handleInput("/");
		await flushAutocomplete();

		expect(provider.getSuggestions).toHaveBeenCalledWith(["/"], 0, 1);
		expect(renderText(component)).toContain("/goal");
	});

	it("absorbs enhanced-paste payloads delivered via pasteText (kitty OSC 5522 routing)", () => {
		// Regression: pasting into the ask tool's "Other" editor on OSC 5522
		// terminals routed the payload to the hidden main prompt, because the
		// enhanced-paste focus routing only targets components exposing a
		// `pasteText` hook and the dialog wrapper had none (#2127 contract).
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});
		const pasted = largePasteText();

		component.pasteText(pasted);

		expect(renderText(component)).toContain("[Paste #1, +11 lines]");

		component.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith(pasted);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("expands large paste markers when submitting on Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});
		const pasted = largePasteText();

		component.handleInput(`\x1b[200~${pasted}\x1b[201~`);

		expect(renderText(component)).toContain("[Paste #1, +11 lines]");

		component.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith(pasted);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("inserts newline on Shift+Enter instead of submitting", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("a");
		component.handleInput("\x1b[13;2~");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		component.handleInput("b");
		component.handleInput("\r");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("a\nb");
	});

	it("submits on the Ctrl+Enter chord in prompt-style mode (#3353)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("x");
		component.handleInput("y");
		component.handleInput("\x1b[13;5u");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("xy");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("submits on Ctrl+Q in prompt-style mode (Windows Terminal fallback, #3353)", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel, {
			promptStyle: true,
		});

		// Windows Terminal swallows Ctrl+Enter, so app.message.followUp also binds
		// Ctrl+Q (#1903). The ask tool's prompt-style editor missed this chord
		// before #3353 — users hit Ctrl+Enter expecting submit, got nothing.
		component.handleInput("\x11");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("draft");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("renders prompt-style editor with legacy ask chrome", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, vi.fn(), vi.fn(), {
			promptStyle: true,
		});

		const rendered = renderText(component);
		const lines = renderLines(component);

		expect(lines[0]).toMatch(/^─+$/);
		expect(lines.at(-1)).toMatch(/^─+$/);
		expect(lines[4]?.startsWith("> ")).toBe(true);
		expect(rendered).toContain("enter or ctrl+q submit  esc cancel");
		expect(rendered).not.toContain("shift+enter newline");
		expect(rendered).toContain("ctrl+g external editor");
	});

	it("anchors the hardware cursor while entering an Other response", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, vi.fn(), vi.fn(), {
			promptStyle: true,
		});
		if (!isFocusable(component)) throw new Error("Hook editor must forward focus to its inner editor");

		component.focused = true;
		component.setUseTerminalCursor?.(true);

		expect(component.render(120).some(line => line.includes(CURSOR_MARKER))).toBe(true);
	});

	it("keeps the prompt gutter visible after typing in prompt-style mode", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", undefined, vi.fn(), vi.fn(), {
			promptStyle: true,
		});

		for (const char of "hello") {
			component.handleInput(char);
		}

		const lines = renderLines(component);
		expect(lines[4]?.startsWith("> hello")).toBe(true);
		expect(lines[4]?.startsWith("hello")).toBe(false);
	});

	it("aligns wrapped prompt-style continuation rows under the text column", () => {
		const component = new HookEditorComponent(createTui(), "Prompt", "abcdefghijklm", vi.fn(), vi.fn(), {
			promptStyle: true,
		});

		const lines = renderLines(component, 12);
		expect(lines[4]).toBe("> abcdefghij");
		expect(lines[5]?.startsWith("  klm")).toBe(true);
		expect(lines[5]?.startsWith(">")).toBe(false);
	});

	it("cancels on Escape", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("cancels on app.interrupt in prompt-style mode even when remapped", () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"app.interrupt": "ctrl+c",
			}),
		);
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookEditorComponent(createTui(), "Prompt", "draft", onSubmit, onCancel, {
			promptStyle: true,
		});

		component.handleInput("\x03");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("aligns the title and hint with the editor prompt gutter at column zero (#5313)", () => {
		const title = "◆ Other (type your own)\nEnter your response:";
		const component = new HookEditorComponent(createTui(), title, "不太清楚，", vi.fn(), vi.fn(), {
			promptStyle: true,
		});
		const lines = renderLines(component);

		const titleRow = lines.find(line => line.includes("Enter your response:"));
		const gutterRow = lines.find(line => line.startsWith("> "));
		const hintRow = lines.find(line => line.includes("esc cancel"));

		expect(titleRow).toBeDefined();
		expect(gutterRow).toBeDefined();
		expect(hintRow).toBeDefined();
		// The borderless prompt-style editor renders `> ` starting at column 0, so
		// the surrounding title/hint chrome must not carry a leading indent.
		expect(titleRow!.startsWith("Enter your response:")).toBe(true);
		expect(hintRow!.startsWith(" ")).toBe(false);
	});
});

describe("ExtensionUiController hook editor abort", () => {
	it("hides the hook editor and resolves undefined when the caller aborts", async () => {
		const { ctx, editor, editorContainer, ui } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		const abortController = new AbortController();
		const controllerWithAbort = controller as unknown as {
			showHookEditor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => Promise<string | undefined>;
		};

		const promise = controllerWithAbort.showHookEditor("Prompt", "draft", { signal: abortController.signal });

		expect(editorContainer.children).toHaveLength(1);
		expect(ctx.hookEditor).toBeDefined();

		abortController.abort();
		await Bun.sleep(0);

		expect(editorContainer.children).toEqual([editor]);
		expect(ctx.hookEditor).toBeUndefined();
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);

		const pending = Symbol("pending");
		const result = await Promise.race([promise, Bun.sleep(20).then(() => pending)]);
		expect(result).toBeUndefined();
	});

	it("forwards editorOptions to HookEditorComponent", async () => {
		const { ctx, editorContainer } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		const controllerWithOptions = controller as unknown as {
			showHookEditor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => Promise<string | undefined>;
		};

		// Start the editor with promptStyle
		const promise = controllerWithOptions.showHookEditor("Ask prompt", undefined, undefined, {
			promptStyle: true,
		});

		expect(editorContainer.children).toHaveLength(1);
		expect(ctx.hookEditor).toBeDefined();

		// The component should be a HookEditorComponent in prompt-style mode.
		// Verify by sending Enter — it should submit, not insert newline.
		const hookEditor = ctx.hookEditor!;
		hookEditor.handleInput("test-text".split("").join(""));
		hookEditor.handleInput("\r");

		// The promise should resolve since Enter submits in prompt-style mode.
		const result = await promise;
		// Result depends on what the editor captured. The key thing is it resolved.
		expect(result).toBeDefined();
	});

	it("routes clipboard text paste into the focused objective editor instead of the hidden main composer", async () => {
		const { ctx, editor } = createControllerContext();
		const controller = new ExtensionUiController(ctx) as unknown as {
			showHookEditor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => Promise<string | undefined>;
		};
		const promise = controller.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true });
		const hookEditor = ctx.hookEditor;
		if (!hookEditor) throw new Error("expected focused objective editor");

		const inputController = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => "Ship autocomplete for goal objectives",
			readMacFileUrls: async () => [],
		});

		expect(await inputController.handleImagePaste()).toBe(true);
		expect(editor.pasteText).not.toHaveBeenCalled();

		hookEditor.handleInput("\r");
		expect(await promise).toBe("Ship autocomplete for goal objectives");
	});

	it("restores focus to the main composer when a prompt-style objective editor is dismissed", async () => {
		const { ctx, editor, editorContainer, ui } = createControllerContext();
		const controller = new ExtensionUiController(ctx) as unknown as {
			showHookEditor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => Promise<string | undefined>;
		};
		const promise = controller.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true });
		const hookEditor = ctx.hookEditor;
		if (!hookEditor) throw new Error("expected focused objective editor");

		expect(editorContainer.children).toEqual([hookEditor]);
		expect(ui.setFocus).toHaveBeenLastCalledWith(hookEditor);

		hookEditor.handleInput("\x1b");

		expect(await promise).toBeUndefined();
		expect(ctx.hookEditor).toBeUndefined();
		expect(editorContainer.children).toEqual([editor]);
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);
	});

	it("routes extension dollar picker selection into the focused objective editor", async () => {
		const { ctx, editor, ui, getToolUiContext } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		await controller.initHooksAndCustomTools();
		const extensionUi = getToolUiContext();

		const objectivePromise = controller.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true });
		const hookEditor = ctx.hookEditor;
		if (!hookEditor) throw new Error("expected focused objective editor");
		hookEditor.handleInput("run a ");

		let finishPicker: ((result: string | undefined) => void) | undefined;
		const picker = {
			render: () => ["Skill"],
			handleInput: vi.fn((keyData: string) => {
				if (keyData === "\r" || keyData === "\t") {
					finishPicker?.("$security-scan ");
				}
			}),
		};
		const pickerPromise = extensionUi.custom<string | undefined>(
			(_tui, _theme, _keybindings, done) => {
				finishPicker = done;
				return picker;
			},
			{ overlay: true },
		);
		await Promise.resolve();

		expect(ui.setFocus).toHaveBeenLastCalledWith(picker);
		picker.handleInput("\r");
		const selected = await pickerPromise;
		expect(selected).toBe("$security-scan ");
		expect(ui.setFocus).toHaveBeenLastCalledWith(hookEditor);

		extensionUi.pasteToEditor(selected!);

		expect(editor.pasteText).not.toHaveBeenCalled();
		expect(renderText(hookEditor)).toContain("run a $security-scan ");

		hookEditor.handleInput("\r");
		expect(await objectivePromise).toBe("run a $security-scan ");
		expect(ctx.hookEditor).toBeUndefined();
	});

	it("restores objective focus after extension dollar picker Escape so a second Escape cancels", async () => {
		const { ctx, editor, editorContainer, ui, getToolUiContext } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		await controller.initHooksAndCustomTools();
		const extensionUi = getToolUiContext();

		const objectivePromise = controller.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true });
		const hookEditor = ctx.hookEditor;
		if (!hookEditor) throw new Error("expected focused objective editor");
		hookEditor.handleInput("run a ");

		let finishPicker: ((result: string | undefined) => void) | undefined;
		const picker = {
			render: () => ["Skill"],
			handleInput: vi.fn((keyData: string) => {
				if (keyData === "\x1b") {
					finishPicker?.(undefined);
				}
			}),
		};
		const pickerPromise = extensionUi.custom<string | undefined>(
			(_tui, _theme, _keybindings, done) => {
				finishPicker = done;
				return picker;
			},
			{ overlay: true },
		);
		await Promise.resolve();

		picker.handleInput("\x1b");

		expect(await pickerPromise).toBeUndefined();
		expect(ctx.hookEditor).toBe(hookEditor);
		expect(editorContainer.children).toEqual([hookEditor]);
		expect(ui.setFocus).toHaveBeenLastCalledWith(hookEditor);
		let resolvedAfterPickerEscape = false;
		const observedObjectivePromise = objectivePromise.then(() => {
			resolvedAfterPickerEscape = true;
		});
		await Promise.resolve();
		expect(resolvedAfterPickerEscape).toBe(false);

		hookEditor.handleInput("\x1b");

		expect(await observedObjectivePromise).toBeUndefined();
		expect(ctx.hookEditor).toBeUndefined();
		expect(editorContainer.children).toEqual([editor]);
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);

		const reopened = controller.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true });
		const reopenedHookEditor = ctx.hookEditor;
		if (!reopenedHookEditor) throw new Error("expected reopened objective editor");
		expect(reopenedHookEditor).not.toBe(hookEditor);
		expect(editorContainer.children).toEqual([reopenedHookEditor]);
		expect(ui.setFocus).toHaveBeenLastCalledWith(reopenedHookEditor);

		reopenedHookEditor.handleInput("new goal");
		reopenedHookEditor.handleInput("\r");
		expect(await reopened).toBe("new goal");
		expect(ctx.hookEditor).toBeUndefined();
		expect(editorContainer.children).toEqual([editor]);
		expect(ui.setFocus).toHaveBeenLastCalledWith(editor);
	});
});

describe("InteractiveMode goal objective editor", () => {
	it("passes the main prompt autocomplete provider to the bare /goal objective editor", async () => {
		const harness = await createInteractiveGoalHarness();
		try {
			const providerSlot: { current?: AutocompleteProvider } = {};
			vi.spyOn(harness.mode.editor, "setAutocompleteProvider").mockImplementation(provider => {
				providerSlot.current = provider;
			});
			await harness.mode.refreshSlashCommandState(harness.tempDir.path());
			expect(providerSlot.current).toBeDefined();

			const showHookEditor = vi.spyOn(harness.mode, "showHookEditor").mockResolvedValue(undefined);

			await harness.mode.handleGoalModeCommand();

			expect(showHookEditor).toHaveBeenCalledTimes(1);
			const [title, prefill, dialogOptions, editorOptions] = showHookEditor.mock.calls[0]!;
			expect(title).toBe("Goal objective");
			expect(prefill).toBeUndefined();
			expect(dialogOptions).toBeUndefined();
			expect(editorOptions?.promptStyle).toBe(true);
			expect(
				(editorOptions as { autocompleteProvider?: AutocompleteProvider } | undefined)?.autocompleteProvider,
			).toBe(providerSlot.current);
		} finally {
			harness.mode.stop();
			await harness.session.dispose();
			harness.tempDir.removeSync();
			harness.authDir.removeSync();
			resetSettingsForTest();
		}
	});
});

describe("ExtensionUiController dialog serialization", () => {
	type SelectorController = {
		showHookSelector: (
			title: string,
			options: string[],
			dialogOptions?: { signal?: AbortSignal },
		) => Promise<string | undefined>;
	};

	it("queues a second selector instead of clobbering the open one", async () => {
		const { ctx, editor, editorContainer } = createControllerContext();
		const controller = new ExtensionUiController(ctx) as unknown as SelectorController;

		const abortA = new AbortController();
		const abortB = new AbortController();

		const promiseA = controller.showHookSelector("A", ["a1", "a2"], { signal: abortA.signal });
		// First dialog is presented synchronously on the shared surface.
		const componentA = ctx.hookSelector;
		expect(componentA).toBeDefined();
		expect(editorContainer.children).toEqual([componentA]);

		const promiseB = controller.showHookSelector("B", ["b1", "b2"], { signal: abortB.signal });
		// The second request must NOT swap itself into the surface while A is open —
		// that orphaning is exactly the hang this serialization fixes.
		expect(ctx.hookSelector).toBe(componentA);
		expect(editorContainer.children).toEqual([componentA]);

		// Resolving A hands the surface to the queued B.
		abortA.abort();
		await Bun.sleep(0);
		expect(await promiseA).toBeUndefined();
		const componentB = ctx.hookSelector;
		expect(componentB).toBeDefined();
		expect(componentB).not.toBe(componentA);
		expect(editorContainer.children).toEqual([componentB]);

		// Resolving B restores the core editor.
		abortB.abort();
		await Bun.sleep(0);
		expect(await promiseB).toBeUndefined();
		expect(ctx.hookSelector).toBeUndefined();
		expect(editorContainer.children).toEqual([editor]);
	});

	it("never presents a queued selector whose signal aborts before its turn", async () => {
		const { ctx, editor, editorContainer } = createControllerContext();
		const controller = new ExtensionUiController(ctx) as unknown as SelectorController;

		const abortA = new AbortController();
		const abortB = new AbortController();

		const promiseA = controller.showHookSelector("A", ["a1"], { signal: abortA.signal });
		const componentA = ctx.hookSelector;
		const promiseB = controller.showHookSelector("B", ["b1"], { signal: abortB.signal });

		// Abort the queued B before A releases the surface.
		abortB.abort();
		expect(await promiseB).toBeUndefined();
		// A is untouched and still owns the surface.
		expect(ctx.hookSelector).toBe(componentA);
		expect(editorContainer.children).toEqual([componentA]);

		// When A resolves, the skipped B must not be shown — surface returns to editor.
		abortA.abort();
		await Bun.sleep(0);
		expect(await promiseA).toBeUndefined();
		expect(ctx.hookSelector).toBeUndefined();
		expect(editorContainer.children).toEqual([editor]);
	});
	it("dismisses a confirmation and restores the editor when its signal aborts", async () => {
		const { ctx, editor, editorContainer } = createControllerContext();
		const controller = new ExtensionUiController(ctx);
		const abortController = new AbortController();

		const result = controller.showHookConfirm("High-risk command", "Allow this command?", {
			signal: abortController.signal,
		});
		expect(ctx.hookSelector).toBeDefined();

		abortController.abort();

		expect(await result).toBe(false);
		expect(ctx.hookSelector).toBeUndefined();
		expect(editorContainer.children).toEqual([editor]);
	});
});
