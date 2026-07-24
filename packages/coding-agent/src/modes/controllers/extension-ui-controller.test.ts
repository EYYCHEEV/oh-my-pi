import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import { CustomEditor } from "../components/custom-editor";
import { getEditorTheme, initTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { ExtensionUiController } from "./extension-ui-controller";

beforeAll(async () => {
	await initTheme();
});

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const requestRender = vi.fn();
	const addAutocompleteProvider = vi.fn();
	let uiContext: ExtensionUIContext | undefined;
	const setActivityWaiting = vi.fn();
	const editorContainer = { clear: vi.fn(), addChild: vi.fn() };
	const setFocus = vi.fn();
	const ctx = {
		editor,
		editorContainer,
		ui: {
			requestRender,
			setFocus,
			terminal: { rows: 40 },
		},
		session: {
			extensionRunner: undefined,
			setActivityWaiting,
			setUsageFallbackConfirmer: vi.fn(),
		},
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		requestRender,
		addAutocompleteProvider,
		setActivityWaiting,
		editorContainer,
		async init(): Promise<ExtensionUIContext> {
			await new ExtensionUiController(ctx).initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});
	it("balances waiting state after selector answer and cancellation", async () => {
		const answered = makeHarness();
		const answeredUi = await answered.init();
		const answer = answeredUi.select("answer", ["one"]);
		answered.ctx.hookSelector?.handleInput("\r");
		await expect(answer).resolves.toBe("one");
		expect(answered.setActivityWaiting.mock.calls).toEqual([[true], [false]]);

		const cancelled = makeHarness();
		const cancelledUi = await cancelled.init();
		const cancel = cancelledUi.select("cancel", ["one"]);
		cancelled.ctx.hookSelector?.handleInput("\u001b");
		await expect(cancel).resolves.toBeUndefined();
		expect(cancelled.setActivityWaiting.mock.calls).toEqual([[true], [false]]);
	});

	it("balances waiting state when presentation throws", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		harness.editorContainer.addChild.mockImplementationOnce(() => {
			throw new Error("presentation failed");
		});

		await expect(ui.select("broken", ["one"])).rejects.toThrow("presentation failed");
		expect(harness.setActivityWaiting.mock.calls).toEqual([[true], [false]]);
	});

	it("balances the public editor path", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const result = ui.editor("Other", "prefill");
		harness.ctx.hookEditor?.handleInput("\u001b");
		await expect(result).resolves.toBeUndefined();
		expect(harness.setActivityWaiting.mock.calls).toEqual([[true], [false]]);
	});

	it("balances a real collab-aware remote answer and cancels the local presentation", async () => {
		const harness = makeHarness();
		const remote = Promise.withResolvers<{ kind: "answered"; value: string | undefined }>();
		harness.ctx.collabHost = {
			requestGuestUi: vi.fn(() => remote.promise),
		} as never;
		const ui = await harness.init();

		const result = ui.select("remote", ["one", "two"]);
		expect(harness.ctx.hookSelector).toBeDefined();
		expect(harness.setActivityWaiting.mock.calls).toEqual([[true]]);
		remote.resolve({ kind: "answered", value: "two" });

		await expect(result).resolves.toBe("two");
		expect(harness.setActivityWaiting.mock.calls).toEqual([[true], [false]]);
		expect(harness.ctx.hookSelector).toBeUndefined();
		expect(harness.editorContainer.addChild).toHaveBeenLastCalledWith(harness.editor);
	});

	it("balances waiting state after selector timeout", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		await expect(ui.select("timeout", ["one"], { timeout: 1 })).resolves.toBe("one");
		expect(harness.setActivityWaiting.mock.calls).toEqual([[true], [false]]);
	});

	it("queues actual modal presentations and balances waiting state across the full depth", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const firstAbort = new AbortController();
		const secondAbort = new AbortController();

		const first = ui.select("first", ["one"], { signal: firstAbort.signal });
		const second = ui.select("second", ["two"], { signal: secondAbort.signal });
		expect(harness.editorContainer.addChild).toHaveBeenCalledTimes(1);
		expect(harness.setActivityWaiting).toHaveBeenCalledTimes(1);
		expect(harness.setActivityWaiting).toHaveBeenLastCalledWith(true);

		firstAbort.abort();
		await expect(first).resolves.toBeUndefined();
		expect(harness.editorContainer.addChild).toHaveBeenCalledTimes(3);
		expect(harness.setActivityWaiting).toHaveBeenCalledTimes(1);

		secondAbort.abort();
		await expect(second).resolves.toBeUndefined();
		expect(harness.setActivityWaiting.mock.calls).toEqual([[true], [false]]);
	});
});
