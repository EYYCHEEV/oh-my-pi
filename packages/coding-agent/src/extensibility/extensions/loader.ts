/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	ImageContent,
	Model,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	TextContent,
	TSchema,
} from "@oh-my-pi/pi-ai";
import type { KeyId } from "@oh-my-pi/pi-tui";
import { hasFsCode, isEacces, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { isServiceTierFamily, isServiceTierForFamily } from "../../config/service-tier";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
// Runtime self-reference: dereference this namespace only inside loader functions to keep the index.ts cycle safe.
import * as PiCodingAgent from "../../index";
import { ALL_SEGMENT_IDS } from "../../modes/components/status-line/segments";
import type { CustomMessagePayload } from "../../session/messages";
import type { FileDeleteFallbackHandler, FileWriteFallbackHandler } from "../../tools/file-write-fallback";
import { EventBus } from "../../utils/event-bus";
import * as TypeBox from "../legacy-typebox";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";

import { resolvePath, withHostGuard } from "../utils";
import type {
	AssistantThinkingRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionStatusSegmentDefinition,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	RegisteredStatusSegment,
	ToolDefinition,
	ToolInfo,
} from "./types";

installLegacyPiSpecifierShim();

export type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type LoadedExtensionModule = ExtensionFactory | { default?: ExtensionFactory };
const statusSegmentIdsByRuntime = new WeakMap<IExtensionRuntime, Set<string>>();
const requiredAttestations = new WeakMap<LoadExtensionsResult, RequiredExtensionAttestation>();
const eventBusByExtension = new WeakMap<Extension, EventBus>();
const disposedExtensions = new WeakSet<Extension>();
const disposedResults = new WeakSet<LoadExtensionsResult>();

interface RuntimeRegistrationSnapshot {
	flagValues: Map<string, boolean | string>;
	providerRegistrations: IExtensionRuntime["pendingProviderRegistrations"];
}

interface RequiredExtensionAttestation {
	spec: Readonly<RequiredExtensionSpec>;
	extension: Extension;
	runtime: IExtensionRuntime;
	toolCallHandlers: object;
}

function snapshotRuntimeRegistrations(runtime: IExtensionRuntime): RuntimeRegistrationSnapshot {
	return {
		flagValues: new Map(runtime.flagValues),
		providerRegistrations: [...runtime.pendingProviderRegistrations],
	};
}

function restoreRuntimeRegistrations(runtime: IExtensionRuntime, snapshot: RuntimeRegistrationSnapshot): void {
	runtime.flagValues.clear();
	for (const [name, value] of snapshot.flagValues) runtime.flagValues.set(name, value);
	runtime.pendingProviderRegistrations.splice(
		0,
		runtime.pendingProviderRegistrations.length,
		...snapshot.providerRegistrations,
	);
}

function disposeExtensionRegistrations(extension: Extension, runtime: IExtensionRuntime): void {
	disposedExtensions.add(extension);
	const registeredIds = statusSegmentIdsByRuntime.get(runtime);
	for (const registration of extension.statusSegments?.values() ?? []) {
		registeredIds?.delete(registration.definition.id);
		registration.disposeUI?.();
	}
	extension.statusSegments?.clear();
	eventBusByExtension.get(extension)?.disposeSubscriptions(extension);
	eventBusByExtension.delete(extension);
}

export function disposeLoadedExtensions(result: LoadExtensionsResult): void {
	if (disposedResults.has(result)) return;
	disposedResults.add(result);
	requiredAttestations.delete(result);
	for (const extension of result.extensions) disposeExtensionRegistrations(extension, result.runtime);
	result.runtime.flagValues.clear();
	result.runtime.pendingProviderRegistrations.splice(0);
}

function hasMatchingRequiredAttestation(
	attested: RequiredExtensionAttestation | undefined,
	required: RequiredExtensionSpec,
): boolean {
	return (
		attested !== undefined &&
		!disposedExtensions.has(attested.extension) &&
		attested.spec.path === required.path &&
		attested.spec.extensionId === required.extensionId &&
		attested.spec.expectedSha256 === required.expectedSha256
	);
}

export interface RequiredExtensionSpec {
	readonly path: string;
	readonly extensionId: string;
	readonly expectedSha256: string;
}

export type RequiredExtensionStartupFailure =
	| "missing"
	| "disabled"
	| "hash-mismatch"
	| "load-failed"
	| "handler-missing";

export function getRequiredExtensionAttestation(
	result: LoadExtensionsResult,
): Readonly<RequiredExtensionSpec> | undefined {
	return requiredAttestations.get(result)?.spec;
}

export interface RequiredExtensionHandlerSnapshot {
	readonly extension: Extension;
	readonly handlers: readonly HandlerFn[];
}

export function getRequiredExtensionHandlerSnapshot(
	result: LoadExtensionsResult,
): RequiredExtensionHandlerSnapshot | undefined {
	const attestation = requiredAttestations.get(result);
	if (!attestation) return undefined;
	return {
		extension: attestation.extension,
		handlers: attestation.toolCallHandlers as readonly HandlerFn[],
	};
}

function canonicalizeExtensionPath(extensionPath: string, cwd: string): string {
	return path.resolve(resolvePath(extensionPath, cwd));
}

export class RequiredExtensionStartupError extends Error {
	override readonly name = "RequiredExtensionStartupError";

	constructor(
		readonly code: RequiredExtensionStartupFailure,
		message: string,
		readonly extensionPath?: string,
	) {
		super(message);
	}
}

export type ExtensionLoadSource = { paths: readonly string[] } | { preloaded: LoadExtensionsResult };

export interface RequiredExtensionLoadOptions {
	required?: RequiredExtensionSpec;
	disabledExtensionIds?: readonly string[];
}

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		super("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	}
}

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }> = [];
	requestStatusLineRender = (): void => {};
	hostStatusSegment = (): undefined => undefined;

	registerProvider(name: string, config: ProviderConfig, sourceId: string): void {
		this.pendingProviderRegistrations.push({ name, config, sourceId });
	}

	unregisterProvider(name: string): void {
		const remaining = this.pendingProviderRegistrations.filter(registration => registration.name !== name);
		this.pendingProviderRegistrations.splice(0, this.pendingProviderRegistrations.length, ...remaining);
	}

	sendMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	sendUserMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	appendEntry(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setLabel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getActiveTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAllTools(): ToolInfo[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setActiveTools(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getCommands(): never {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModel(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingLevel(): ThinkingLevel {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getServiceTiers(): ServiceTierByFamily {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setServiceTier(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getSessionName(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

/**
 * ExtensionAPI implementation for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
class ConcreteExtensionAPI implements ExtensionAPI {
	readonly logger = logger;
	readonly typebox = TypeBox;
	readonly arktype = type;
	readonly zod = zod;
	readonly flagValues = new Map<string, boolean | string>();
	readonly pendingProviderRegistrations: Array<{
		name: string;
		config: ProviderConfig;
		sourceId: string;
	}> = [];

	constructor(
		public readonly pi: typeof PiCodingAgent,
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		private readonly cwd: string,
		public readonly events: EventBus,
	) {}
	private canRegister(): boolean {
		return !disposedExtensions.has(this.extension);
	}

	on<F extends HandlerFn>(event: string, handler: F): void {
		if (!this.canRegister()) return;
		const list = this.extension.handlers.get(event) ?? [];
		list.push(handler);
		this.extension.handlers.set(event, list);
	}

	registerStatusSegment(definition: ExtensionStatusSegmentDefinition): () => void {
		if (!this.canRegister()) return () => {};
		if (ALL_SEGMENT_IDS.includes(definition.id as never)) {
			throw new Error(`Status segment id "${definition.id}" is reserved by a built-in segment`);
		}
		let registeredIds = statusSegmentIdsByRuntime.get(this.runtime);
		if (!registeredIds) {
			registeredIds = new Set();
			statusSegmentIdsByRuntime.set(this.runtime, registeredIds);
		}
		if (registeredIds.has(definition.id)) {
			throw new Error(`Duplicate status segment: ${definition.id}`);
		}
		const key = `${this.extension.path}:${definition.id}`;
		const registration: RegisteredStatusSegment = { key, definition };
		registeredIds.add(definition.id);
		this.extension.statusSegments?.set(key, registration);
		registration.disposeUI = this.runtime.hostStatusSegment(key, {
			...definition,
			render: () => (this.extension.statusSegments?.has(key) ? definition.render() : undefined),
		});
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			registeredIds.delete(definition.id);
			if (!this.extension.statusSegments?.delete(key)) return;
			if (registration.disposeUI) registration.disposeUI();
			else this.runtime.requestStatusLineRender();
		};
	}

	rollbackStatusSegments(): void {
		disposeExtensionRegistrations(this.extension, this.runtime);
	}

	requestStatusLineRender(): void {
		if (!this.canRegister()) return;
		this.runtime.requestStatusLineRender();
	}

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		if (!this.canRegister()) return;
		const registered = {
			definition: tool,
			extensionPath: this.extension.path,
		};
		this.extension.tools.set(tool.name, registered);
		for (const listener of this.extension.toolRegistrationListeners ?? []) listener(tool.name);
	}

	registerFileWriteFallback(handler: FileWriteFallbackHandler): void {
		this.extension.fileWriteFallbackHandlers.push(handler);
	}

	registerFileDeleteFallback(handler: FileDeleteFallbackHandler): void {
		this.extension.fileDeleteFallbackHandlers.push(handler);
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		if (!this.canRegister()) return;
		this.extension.commands.set(name, { name, ...options });
	}

	setLabel(label: string): void {
		if (!this.canRegister()) return;
		this.extension.label = label;
	}

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void {
		if (!this.canRegister()) return;
		this.extension.shortcuts.set(shortcut, { shortcut, extensionPath: this.extension.path, ...options });
	}

	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void {
		if (!this.canRegister()) return;
		this.extension.flags.set(name, { name, extensionPath: this.extension.path, ...options });
		if (options.default !== undefined) {
			this.runtime.flagValues.set(name, options.default);
		}
	}

	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
		if (!this.canRegister()) return;
		this.extension.messageRenderers.set(customType, renderer as MessageRenderer);
	}

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void {
		if (!this.canRegister()) return;
		this.extension.assistantThinkingRenderers.push(renderer);
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		return this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void {
		this.runtime.sendUserMessage(content, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.runtime.appendEntry(customType, data);
	}

	exec(command: string, args: string[], options?: ExecOptions) {
		return execCommand(command, args, options?.cwd ?? this.cwd, options);
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	getAllTools(): ToolInfo[] {
		return this.runtime.getAllTools();
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.runtime.setActiveTools(toolNames);
	}

	getCommands() {
		return this.runtime.getCommands();
	}

	setModel(model: Model): Promise<boolean> {
		return this.runtime.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void {
		this.runtime.setThinkingLevel(level, persist);
	}

	getServiceTiers(): Readonly<ServiceTierByFamily> {
		return { ...this.runtime.getServiceTiers() };
	}

	setServiceTier(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (!isServiceTierFamily(family) || (tier !== undefined && !isServiceTierForFamily(family, tier))) {
			throw new TypeError(`Invalid service tier "${String(tier)}" for family "${String(family)}"`);
		}
		this.runtime.setServiceTier(family, tier);
	}

	getSessionName(): string | undefined {
		return this.runtime.getSessionName();
	}

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: ProviderConfig): void {
		if (!this.canRegister()) return;
		this.runtime.registerProvider(name, config, this.extension.path);
	}

	unregisterProvider(name: string): void {
		if (!this.canRegister()) return;
		this.runtime.unregisterProvider(name, this.extension.path);
	}
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		toolRegistrationListeners: new Set(),
		assistantThinkingRenderers: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		statusSegments: new Map(),
	};
}

/**
 * Runs an extension factory with runtime registration rollback on failure.
 * Restores flag values and the complete provider queue because an extension
 * may unregister entries queued by an earlier extension.
 */
async function runExtensionFactory(
	factory: ExtensionFactory,
	api: ExtensionAPI,
	runtime: IExtensionRuntime,
): Promise<void> {
	const runtimeSnapshot = snapshotRuntimeRegistrations(runtime);

	try {
		await factory(api);
	} catch (error) {
		restoreRuntimeRegistrations(runtime, runtimeSnapshot);
		throw error;
	}
}

interface ImportedExtensionModule {
	factory: ExtensionFactory | null;
	resolvedPath: string;
	error: string | null;
}

async function importExtensionModule(extensionPath: string, cwd: string): Promise<ImportedExtensionModule> {
	const resolvedPath = canonicalizeExtensionPath(extensionPath, cwd);
	try {
		const module = (await withHostGuard(() => loadLegacyPiModule(resolvedPath))) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				factory: null,
				resolvedPath,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		return { factory, resolvedPath, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { factory: null, resolvedPath, error: `Failed to load extension: ${message}` };
	}
}

async function bindExtension(
	extensionPath: string,
	imported: ImportedExtensionModule,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const factory = imported.factory;
	if (imported.error !== null || factory === null) {
		return { extension: null, error: imported.error };
	}
	const extension = createExtension(extensionPath, imported.resolvedPath);
	eventBusByExtension.set(extension, eventBus);
	const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus);
	try {
		await eventBus.runWithSubscriptionOwner(extension, () =>
			withHostGuard(() => runExtensionFactory(factory, api, runtime)),
		);

		return { extension, error: null };
	} catch (err) {
		api.rollbackStatusSegments();
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	name = "<inline>",
): Promise<Extension> {
	const extension = createExtension(name, name);
	eventBusByExtension.set(extension, eventBus);
	const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus);
	try {
		await eventBus.runWithSubscriptionOwner(extension, () => runExtensionFactory(factory, api, runtime));
		return extension;
	} catch (error) {
		api.rollbackStatusSegments();
		throw error;
	}
}

function normalizeRequiredExtensionSpec(
	required: RequiredExtensionSpec,
	cwd: string,
	disabledExtensionIds: readonly string[],
): Readonly<RequiredExtensionSpec> {
	if (required.path.trim().length === 0) {
		throw new RequiredExtensionStartupError("missing", "Required extension path must not be empty");
	}
	const resolvedPath = canonicalizeExtensionPath(required.path, cwd);
	if (required.extensionId.trim().length === 0) {
		throw new RequiredExtensionStartupError("load-failed", "Required extension ID must not be empty", resolvedPath);
	}
	const expectedExtensionId = `extension-module:${getExtensionNameFromPath(resolvedPath)}`;
	if (required.extensionId !== expectedExtensionId) {
		throw new RequiredExtensionStartupError(
			"load-failed",
			`Required extension ID must match its exact path (${expectedExtensionId}): ${resolvedPath}`,
			resolvedPath,
		);
	}
	if (!/^[a-f0-9]{64}$/.test(required.expectedSha256)) {
		throw new RequiredExtensionStartupError(
			"hash-mismatch",
			`Required extension SHA-256 must be exactly 64 lowercase hexadecimal characters: ${resolvedPath}`,
			resolvedPath,
		);
	}
	if (disabledExtensionIds.includes(required.extensionId)) {
		throw new RequiredExtensionStartupError(
			"disabled",
			`Required extension is disabled: ${required.extensionId}`,
			resolvedPath,
		);
	}
	return Object.freeze({
		path: resolvedPath,
		extensionId: required.extensionId,
		expectedSha256: required.expectedSha256,
	});
}

async function verifyRequiredExtensionHash(
	required: Readonly<RequiredExtensionSpec>,
): Promise<Readonly<RequiredExtensionSpec>> {
	const resolvedPath = required.path;

	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(resolvedPath).bytes();
	} catch (error) {
		if (isEnoent(error)) {
			throw new RequiredExtensionStartupError(
				"missing",
				`Required extension is missing: ${resolvedPath}`,
				resolvedPath,
			);
		}
		throw new RequiredExtensionStartupError(
			"load-failed",
			`Failed to read required extension: ${error instanceof Error ? error.message : String(error)}`,
			resolvedPath,
		);
	}
	const actualSha256 = new Bun.SHA256().update(bytes).digest("hex");
	if (actualSha256 !== required.expectedSha256) {
		throw new RequiredExtensionStartupError(
			"hash-mismatch",
			`Required extension SHA-256 mismatch: ${resolvedPath}`,
			resolvedPath,
		);
	}
	return required;
}

function attestRequiredExtension(
	result: LoadExtensionsResult,
	required: RequiredExtensionSpec,
	cwd: string,
): Extension {
	const failedLoad = result.errors.find(error => canonicalizeExtensionPath(error.path, cwd) === required.path);
	if (failedLoad) {
		throw new RequiredExtensionStartupError("load-failed", failedLoad.error, required.path);
	}
	const exactExtension = result.extensions.find(
		extension => canonicalizeExtensionPath(extension.resolvedPath, cwd) === required.path,
	);
	if (!exactExtension) {
		throw new RequiredExtensionStartupError(
			"missing",
			`Required extension did not load from the exact configured path: ${required.path}`,
			required.path,
		);
	}
	const handlers = exactExtension.handlers.get("tool_call");
	if (!handlers?.some(handler => typeof handler === "function")) {
		throw new RequiredExtensionStartupError(
			"handler-missing",
			`Required extension did not register a callable tool_call handler: ${required.path}`,
			required.path,
		);
	}
	return exactExtension;
}

async function loadExtensionPaths(
	paths: readonly string[],
	cwd: string,
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const runtime = new ExtensionRuntime();
	const seen = new Set<string>();

	const deduplicatedPaths: string[] = [];
	for (const extPath of paths) {
		const canonicalPath = canonicalizeExtensionPath(extPath, cwd);
		if (seen.has(canonicalPath)) continue;
		seen.add(canonicalPath);
		deduplicatedPaths.push(extPath);
	}
	const imported = await Promise.all(deduplicatedPaths.map(extPath => importExtensionModule(extPath, cwd)));

	for (let i = 0; i < deduplicatedPaths.length; i++) {
		const extPath = deduplicatedPaths[i]!;
		const { extension, error } = await bindExtension(extPath, imported[i]!, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) extensions.push(extension);
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

export async function loadExtensionsWithRequiredAttestation(
	source: ExtensionLoadSource,
	cwd: string,
	eventBus?: EventBus,
	options: RequiredExtensionLoadOptions = {},
): Promise<LoadExtensionsResult> {
	const preloadedSource = "preloaded" in source ? source.preloaded : undefined;
	const preloadedAttestation = preloadedSource ? requiredAttestations.get(preloadedSource) : undefined;
	const sourceSnapshot: ExtensionLoadSource =
		"paths" in source
			? { paths: [...source.paths] }
			: {
					preloaded: {
						...source.preloaded,
						extensions: [...source.preloaded.extensions],
						errors: [...source.preloaded.errors],
					},
				};
	const requiredInput = options.required;
	if (!requiredInput) {
		return "paths" in sourceSnapshot
			? loadExtensionPaths(sourceSnapshot.paths, cwd, eventBus)
			: sourceSnapshot.preloaded;
	}
	const disabledExtensionIds = [...(options.disabledExtensionIds ?? [])];

	let loadedResult: LoadExtensionsResult | undefined;
	try {
		const required = normalizeRequiredExtensionSpec(requiredInput, cwd, disabledExtensionIds);
		const hashedRequired = await verifyRequiredExtensionHash(required);
		if (
			"paths" in sourceSnapshot &&
			!sourceSnapshot.paths.some(
				extensionPath => canonicalizeExtensionPath(extensionPath, cwd) === hashedRequired.path,
			)
		) {
			throw new RequiredExtensionStartupError(
				"missing",
				`Required extension path is not present in the extension load set: ${hashedRequired.path}`,
				hashedRequired.path,
			);
		}
		if ("preloaded" in sourceSnapshot && !hasMatchingRequiredAttestation(preloadedAttestation, hashedRequired)) {
			throw new RequiredExtensionStartupError(
				"load-failed",
				`Preloaded required extension lacks matching loader attestation: ${hashedRequired.path}`,
				hashedRequired.path,
			);
		}
		loadedResult =
			"paths" in sourceSnapshot
				? await loadExtensionPaths(sourceSnapshot.paths, cwd, eventBus)
				: sourceSnapshot.preloaded;
		if ("paths" in sourceSnapshot) await verifyRequiredExtensionHash(hashedRequired);
		const exactExtension = attestRequiredExtension(loadedResult, hashedRequired, cwd);
		const toolCallHandlers = Object.freeze([...(exactExtension.handlers.get("tool_call") ?? [])]);
		if (
			"preloaded" in sourceSnapshot &&
			(preloadedAttestation?.extension !== exactExtension ||
				preloadedAttestation.runtime !== loadedResult.runtime ||
				exactExtension.handlers.get("tool_call") !== preloadedAttestation.toolCallHandlers)
		) {
			throw new RequiredExtensionStartupError(
				"load-failed",
				`Preloaded required extension provenance does not match its loader attestation: ${hashedRequired.path}`,
				hashedRequired.path,
			);
		}
		exactExtension.handlers.set("tool_call", toolCallHandlers as HandlerFn[]);
		requiredAttestations.set(loadedResult, {
			spec: Object.freeze({ ...hashedRequired }),
			extension: exactExtension,
			runtime: loadedResult.runtime,
			toolCallHandlers,
		});
		return loadedResult;
	} catch (error) {
		const resultToDispose = loadedResult ?? ("preloaded" in sourceSnapshot ? sourceSnapshot.preloaded : undefined);
		if (preloadedAttestation) {
			disposeExtensionRegistrations(preloadedAttestation.extension, preloadedAttestation.runtime);
			preloadedAttestation.runtime.flagValues.clear();
			preloadedAttestation.runtime.pendingProviderRegistrations.splice(0);
		}
		if (resultToDispose) disposeLoadedExtensions(resultToDispose);
		if (preloadedSource) requiredAttestations.delete(preloadedSource);
		throw error;
	}
}

/**
 * Load extensions from paths.
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	return loadExtensionsWithRequiredAttestation({ paths }, cwd, eventBus);
}

interface ExtensionManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
}

async function readExtensionManifest(packageJsonPath: string): Promise<ExtensionManifest | null> {
	try {
		const pkg = (await Bun.file(packageJsonPath).json()) as { omp?: ExtensionManifest; pi?: ExtensionManifest };
		const manifest = pkg.omp ?? pkg.pi;
		if (manifest && typeof manifest === "object") {
			return manifest;
		}
		return null;
	} catch (error) {
		if (isEnoent(error) || isEacces(error) || hasFsCode(error, "EPERM")) {
			return null;
		}
		logger.warn("Failed to read extension manifest", { path: packageJsonPath, error: String(error) });
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 */
async function resolveExtensionEntries(dir: string): Promise<string[] | null> {
	const packageJsonPath = path.join(dir, "package.json");
	const manifest = await readExtensionManifest(packageJsonPath);
	if (manifest?.extensions?.length) {
		const entries: string[] = [];
		for (const extPath of manifest.extensions) {
			const resolvedExtPath = path.resolve(dir, extPath);
			try {
				await fs.stat(resolvedExtPath);
				entries.push(resolvedExtPath);
			} catch (err) {
				if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) continue;
				throw err;
			}
		}
		if (entries.length > 0) {
			return entries;
		}
	}

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	try {
		await fs.stat(indexTs);
		return [indexTs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}
	try {
		await fs.stat(indexJs);
		return [indexJs];
	} catch (err) {
		if (isEnoent(err) || isEacces(err) || hasFsCode(err, "EPERM")) {
			// Ignore
		} else {
			throw err;
		}
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/<ext>/index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/<ext>/package.json` with "omp"/"pi" field → load declared paths
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
async function discoverExtensionsInDir(dir: string): Promise<string[]> {
	const discovered: string[] = [];

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = await resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	let entries: fs1.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Failed to discover extensions in directory", { path: dir, error: String(err) });
		return [];
	}

	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);

		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			discovered.push(entryPath);
			continue;
		}

		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const resolved = await resolveExtensionEntries(entryPath);
			if (resolved) {
				discovered.push(...resolved);
			}
		}
	}

	return discovered;
}
async function discoverHooksInPackageRoot(root: string): Promise<string[]> {
	const hooks: string[] = [];
	for (const hookType of ["pre", "post"]) {
		const hookDir = path.join(root, "hooks", hookType);
		let entries: fs1.Dirent[];
		try {
			entries = await fs.readdir(hookDir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || isEacces(err) || hasFsCode(err, "ENOTDIR") || hasFsCode(err, "EPERM")) continue;
			throw err;
		}
		for (const entry of entries) {
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				hooks.push(path.join(hookDir, entry.name));
			}
		}
	}
	return hooks;
}

/**
 * Discover absolute paths of extensions to load, without importing or
 * binding factories. Hot path on session startup — the scan walks native
 * `.omp`/`.pi` extension capabilities, JS/TS hook factories, the
 * installed-plugin tree, and any configured paths.
 *
 * Subagents reuse the parent's collected paths via the SDK's
 * `preloadedExtensionPaths` option, then call {@link loadExtensions} themselves
 * so each session rebuilds Extension instances bound to its OWN
 * `ExtensionAPI` (cwd, eventBus, runtime). Forwarding the parent's
 * `LoadExtensionsResult` directly would reuse handlers/tools/commands that
 * closed over the parent's `cwd` and event bus.
 */
export interface DiscoverExtensionPathOptions {
	/** Include ambient native extensions, hooks, and installed plugins. */
	ambient?: boolean;
	/** Include ambient hook factories. Disable for read-only catalog commands. */
	includeAmbientHooks?: boolean;
}

export async function discoverExtensionPaths(
	configuredPaths: string[],
	cwd: string,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<string[]> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds ?? []);
	const loadOptions = disabledExtensionIds ? { cwd, disabledExtensions: disabledExtensionIds } : { cwd };

	const isDisabledName = (name: string): boolean => disabled.has(`extension-module:${name}`);

	const addPath = (extPath: string): void => {
		const resolved = path.resolve(extPath);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPaths.push(extPath);
		}
	};

	const addPaths = (paths: string[]) => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			addPath(extPath);
		}
	};

	const ambient = options.ambient !== false;
	if (ambient) {
		// 1. Discover extension modules via capability API (native .omp/.pi only).
		// Scope the load to the native provider — the extension-module capability
		// also has claude/codex/gemini/opencode providers, and their items were
		// discarded here anyway (see #4198). The provider filter skips the walk
		// entirely instead of running four foreign directory scans and dropping
		// the results.
		const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
			...loadOptions,
			providers: ["native"],
		});
		for (const ext of discovered.items) {
			addPath(ext.path);
		}
	}

	// 2. Discover JS/TS hook factories and bind them through the extension
	// runner, which owns the current runtime event bus. Non-ambient discovery
	// scans only this invocation's configured package roots; it must not consult
	// settings, installed packages, or process-global CLI injection state.
	if (ambient) {
		if (options.includeAmbientHooks !== false) {
			const hooks = await loadCapability<Hook>(hookCapability.id, loadOptions);
			for (const hookPath of hooks.items
				.map(hook => hook.path)
				.filter(hookPath => isExtensionFile(path.basename(hookPath)))) {
				addPath(hookPath);
			}
		}
	} else {
		for (const configuredPath of configuredPaths) {
			addPaths(await discoverHooksInPackageRoot(resolvePath(configuredPath, cwd)));
		}
	}

	// 3. Discover extension entry points from installed plugins.
	if (ambient) {
		addPaths(await getAllPluginExtensionPaths(cwd));
	}

	// 4. Explicitly configured paths
	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);

		let stat: fs1.Stats | null = null;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		if (stat?.isDirectory()) {
			const entries = await resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}

			const discovered = await discoverExtensionsInDir(resolved);
			if (discovered.length > 0) {
				addPaths(discovered);
			}
			continue;
		}

		addPath(resolved);
	}

	return allPaths;
}

/**
 * Discover and load extensions from standard locations. Composed of
 * {@link discoverExtensionPaths} (FS scan) + {@link loadExtensions}
 * (per-session binding).
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<LoadExtensionsResult> {
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, options);
	return loadExtensions(paths, cwd, eventBus);
}
