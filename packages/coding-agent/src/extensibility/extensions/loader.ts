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
import { isBuiltinComposerStyle, type KeyId } from "@oh-my-pi/pi-tui";
import { hasFsCode, isEacces, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { isServiceTierFamily, isServiceTierForFamily } from "../../config/service-tier";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
import { ALL_SEGMENT_IDS } from "@oh-my-pi/pi-tui/status-line/segments";
import type { CustomMessagePayload, MessageAdmission } from "../../session/messages";
import type { RuntimeRequirementDeclaration } from "../../session/runtime-requirements";
import type { SessionPersistenceReceipt } from "../../session/session-manager";
import { getCodingAgentApi } from "../host-api";
import type { SendUserMessageOptions } from "../../session/agent-session";
import type { FileDeleteFallbackHandler, FileWriteFallbackHandler } from "../../tools/file-write-fallback";
import { isFilesystemSourcePath } from "../../tools/path-utils";
import { InternalUrlRouter } from "../../internal-urls/router";
import { EventBus } from "../../utils/event-bus";
import * as TypeBox from "../legacy-typebox";
import { resolveExtensionDirectory } from "./directory-resolution";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";

import { resolvePath, withHostGuard } from "../utils";
import type { ComposerShapeDefinition } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";
import type {
	AssistantTextRenderer,
	AssistantThinkingRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionStatusSegmentDefinition,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	PreparedExtension,
	ProviderConfig,
	RegisteredCommand,
	RegisteredStatusSegment,
	SourceInfo,
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
const preparedRuntimeOrigins = new WeakMap<
	PreparedExtension,
	Readonly<{ path: string; sha256: string; factory: ExtensionFactory }>
>();
const loadedRuntimeOrigins = new WeakMap<
	Extension,
	Readonly<{ path: string; sha256: string; runtime: IExtensionRuntime }>
>();
/**
 * Files discovery found as legacy hooks (`.omp/hooks/pre|post`, hook plugin roots). They load as
 * extensions, but only the loader decides which extensions came from a hook: the runner refuses a
 * `tool_call` answer from them, since the legacy hooks API has no `result`. Paths are resolved, so
 * the mark survives the loader's own path handling; a file that is both a hook and an explicit
 * extension path is treated as a hook (the stricter reading).
 */
const hookOriginPaths = new Set<string>();
const hookOriginExtensions = new WeakSet<Extension>();

function markHookOrigin(hookPath: string): void {
	hookOriginPaths.add(path.resolve(hookPath));
}

/** Whether discovery found this extension's file as a legacy hook. Only the loader marks it. */
export function isHookOriginExtension(extension: Extension): boolean {
	return hookOriginExtensions.has(extension);
}
// Some supported platforms reuse a cached factory despite a new import tag.
// Never relabel that same executable object with newer entry bytes.
const runtimeFactoryOrigins = new WeakMap<ExtensionFactory, Readonly<{ path: string; sha256: string }>>();
const ambiguousRuntimeFactories = new WeakSet<ExtensionFactory>();

/** Loader-owned provenance; serialized/preloaded lookalikes never create an entry. */
export async function getLoadedRuntimeOrigin(
	extension: Extension,
	runtime?: IExtensionRuntime,
	disabledIds: readonly string[] = [],
): Promise<{ path: string; sha256: string } | undefined> {
	const origin = loadedRuntimeOrigins.get(extension);
	if (origin && disabledIds.includes(`extension-module:${getExtensionNameFromPath(origin.path)}`)) return undefined;
	if (
		!origin ||
		disposedExtensions.has(extension) ||
		(runtime && origin.runtime !== runtime) ||
		extension.resolvedPath !== origin.path
	)
		return undefined;
	try {
		const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(origin.path).arrayBuffer()).digest("hex");
		if (hash !== origin.sha256 || disposedExtensions.has(extension) || extension.resolvedPath !== origin.path)
			return undefined;
		return { path: origin.path, sha256: origin.sha256 };
	} catch {
		return undefined;
	}
}

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

/** RFC 3986 scheme syntax, lowercased, two characters at least so `c` cannot capture `C:/` paths. */
const LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+$/;

/** Standard schemes an extension may not claim: web, file and mail links. omp's internal URLs are refused too. */
const STANDARD_LINK_SCHEMES: Readonly<Record<string, true>> = {
	about: true,
	blob: true,
	data: true,
	file: true,
	ftp: true,
	http: true,
	https: true,
	javascript: true,
	mailto: true,
	ssh: true,
	ws: true,
	wss: true,
};

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

/**
 * Upstream-shaped provenance for an extension-registered tool. Consumers that
 * read `sourceInfo` off `getAllRegisteredTools()` (e.g. pi-fabric) receive an
 * absolute on-disk path: the tool's own `sourcePath` when it is filesystem-
 * absolute, otherwise the extension's resolved entry (`fallbackPath`). A tool
 * with no absolute origin at all falls back to the synthetic `<extension:name>`.
 */
export function extensionToolSourceInfo(
	definition: Pick<ToolDefinition, "name" | "sourcePath">,
	fallbackPath: string,
): SourceInfo {
	const sourcePath = definition.sourcePath;
	const path =
		sourcePath && isFilesystemSourcePath(sourcePath)
			? sourcePath
			: isFilesystemSourcePath(fallbackPath)
				? fallbackPath
				: `<extension:${definition.name}>`;
	return { path, source: "extension", scope: "temporary", origin: "top-level" };
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

	async sendMessageWithReceipt(): Promise<never> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	async requireRuntime(): Promise<never> {
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

	get pi() {
		return getCodingAgentApi();
	}

	constructor(
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		private readonly cwd: string,
		public readonly events: EventBus,
	) {
		// Extensions destructure `pi.on` or forward API methods as callbacks, so every
		// prototype method must keep its receiver when detached. Walk the prototype
		// rather than listing methods: a new method is bound without touching this.
		const prototype = ConcreteExtensionAPI.prototype;
		for (const name of Object.getOwnPropertyNames(prototype)) {
			if (name === "constructor") continue;
			const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
			if (typeof descriptor?.value !== "function") continue;
			Object.defineProperty(this, name, { value: descriptor.value.bind(this), writable: true, configurable: true });
		}
	}

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
			sourceInfo: extensionToolSourceInfo(tool, this.extension.resolvedPath),
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

	registerAssistantTextRenderer(renderer: AssistantTextRenderer): void {
		if (typeof renderer !== "function") {
			throw new TypeError(
				`registerAssistantTextRenderer expects a function, got ${typeof renderer} (extension ${this.extension.path})`,
			);
		}
		this.extension.assistantTextRenderers.push(renderer);
	}

	registerLinkScheme(scheme: string): void {
		const normalized = scheme.toLowerCase();
		if (!LINK_SCHEME_PATTERN.test(normalized)) {
			throw new Error(
				`registerLinkScheme: "${scheme}" is not a URL scheme of two or more characters (letters, digits, "+", "-", ".")`,
			);
		}
		// `=== true`: inherited keys such as `constructor` are not reserved.
		if (STANDARD_LINK_SCHEMES[normalized] === true || InternalUrlRouter.instance().isBuiltin(normalized)) {
			throw new Error(`registerLinkScheme: "${scheme}" is reserved for standard or omp-internal links`);
		}
		if (!this.extension.linkSchemes.includes(normalized)) this.extension.linkSchemes.push(normalized);
	}

	registerComposerShape(definition: ComposerShapeDefinition): void {
		const id = definition.style.id;
		if (id.length === 0 || id !== id.trim()) {
			throw new TypeError("Composer shape id must be a non-empty trimmed string");
		}
		if (definition.label.trim().length === 0) {
			throw new TypeError(`Composer shape "${id}" must have a label`);
		}
		if (isBuiltinComposerStyle(id)) {
			throw new Error(`Cannot replace built-in composer shape "${id}"`);
		}
		this.extension.composerShapes.set(id, definition);
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		return this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendMessageWithReceipt<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
	): Promise<MessageAdmission> {
		return this.runtime.sendMessageWithReceipt(message, options);
	}

	requireRuntime(declaration: RuntimeRequirementDeclaration): Promise<SessionPersistenceReceipt> {
		return this.runtime.requireRuntime(this.extension, declaration);
	}

	sendUserMessage(content: string | (TextContent | ImageContent)[], options?: SendUserMessageOptions): void {
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
		this.extension.registersProviders = true;
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
	const extension: Extension = {
		path: extensionPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		toolRegistrationListeners: new Set(),
		assistantThinkingRenderers: [],
		assistantTextRenderers: [],
		linkSchemes: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		statusSegments: new Map(),
	};
	if (hookOriginPaths.has(path.resolve(extensionPath)) || hookOriginPaths.has(path.resolve(resolvedPath))) {
		hookOriginExtensions.add(extension);
	}
	return extension;
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

async function importExtensionModule(extensionPath: string, cwd: string): Promise<PreparedExtension> {
	const resolvedPath = canonicalizeExtensionPath(extensionPath, cwd);
	try {
		const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(resolvedPath).arrayBuffer()).digest("hex");
		const module = (await withHostGuard(() => loadLegacyPiModule(resolvedPath))) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				path: extensionPath,
				factory: null,
				resolvedPath,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		const prepared = { path: extensionPath, factory, resolvedPath, error: null };
		const afterHash = new Bun.CryptoHasher("sha256").update(await Bun.file(resolvedPath).arrayBuffer()).digest("hex");
		const prior = runtimeFactoryOrigins.get(factory);
		if (sha256 !== afterHash) ambiguousRuntimeFactories.add(factory);
		if (
			!ambiguousRuntimeFactories.has(factory) &&
			(!prior || (prior.path === resolvedPath && prior.sha256 === sha256))
		) {
			runtimeFactoryOrigins.set(factory, Object.freeze({ path: resolvedPath, sha256 }));
			preparedRuntimeOrigins.set(prepared, Object.freeze({ path: resolvedPath, sha256, factory }));
		}
		return prepared;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { path: extensionPath, factory: null, resolvedPath, error: `Failed to load extension: ${message}` };
	}
}

async function bindExtension(
	extensionPath: string,
	imported: PreparedExtension,
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
	const api = new ConcreteExtensionAPI(extension, runtime, cwd, eventBus);
	try {
		await eventBus.runWithSubscriptionOwner(extension, () =>
			withHostGuard(() => runExtensionFactory(factory, api, runtime)),
		);
		const origin = preparedRuntimeOrigins.get(imported);
		if (origin && origin.factory === factory && origin.path === imported.resolvedPath) {
			loadedRuntimeOrigins.set(extension, Object.freeze({ path: origin.path, sha256: origin.sha256, runtime }));
		}

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
	const api = new ConcreteExtensionAPI(extension, runtime, cwd, eventBus);
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
	runtime: IExtensionRuntime = new ExtensionRuntime(),
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const seen = new Set<string>();
	const deduplicatedPaths: string[] = [];
	for (const extPath of paths) {
		const canonicalPath = canonicalizeExtensionPath(extPath, cwd);
		if (seen.has(canonicalPath)) continue;
		seen.add(canonicalPath);
		deduplicatedPaths.push(extPath);
	}
	const imported = await Promise.all(deduplicatedPaths.map(extPath => importExtensionModule(extPath, cwd)));

	for (const prepared of imported) {
		const { extension, error } = await bindExtension(prepared.path, prepared, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: prepared.path, error });
			continue;
		}

		if (extension) extensions.push(extension);
	}

	return {
		extensions,
		errors,
		runtime,
		preparedExtensions: imported,
	};
}

/**
 * Bind previously imported extension factories. A fresh session runtime is
 * created unless `runtime` is given: deferred startup extensions bind into the
 * live session's runtime so they share its flag values and wired actions.
 */
export async function bindPreparedExtensions(
	preparedExtensions: readonly PreparedExtension[],
	cwd: string,
	eventBus?: EventBus,
	runtime: IExtensionRuntime = new ExtensionRuntime(),
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();

	for (const prepared of preparedExtensions) {
		const { extension, error } = await bindExtension(prepared.path, prepared, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: prepared.path, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
		preparedExtensions: [...preparedExtensions],
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
						...(source.preloaded.preparedExtensions
							? { preparedExtensions: [...source.preloaded.preparedExtensions] }
							: {}),
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
 * Load extensions from paths. A fresh session runtime is created unless
 * `runtime` is given: deferred startup extensions bind into the live session's
 * runtime so they share its flag values and wired actions.
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: IExtensionRuntime,
): Promise<LoadExtensionsResult> {
	if (runtime) return loadExtensionPaths(paths, cwd, eventBus, runtime);
	return loadExtensionsWithRequiredAttestation({ paths }, cwd, eventBus);
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

const CONFIGURED_EXTENSION_DIRECTORY_OPTIONS = {
	indexNames: ["index.ts", "index.js"],
	isScanFile: isExtensionFile,
	throwUnexpectedStatErrors: true,
	onReadError: (filePath: string, error: unknown) => {
		logger.warn("Failed to resolve extension directory", { path: filePath, error: String(error) });
	},
};

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
 * The root session imports these paths once and forwards prepared factories to
 * subagents. Each child rebinds fresh Extension instances to its OWN
 * ExtensionAPI (cwd, eventBus, runtime) without re-evaluating the module graph.
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

	// Key on the real file so a symlink and its target load once, e.g. an
	// extensions/ symlink plus the same file passed with --extension. Missing
	// paths keep their lexical key so the loader still reports them.
	const addPath = async (extPath: string): Promise<void> => {
		const resolved = path.resolve(extPath);
		const key = await fs.realpath(resolved).catch(() => resolved);
		if (!seen.has(key)) {
			seen.add(key);
			allPaths.push(extPath);
		}
	};

	const addPaths = async (paths: string[]): Promise<void> => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			await addPath(extPath);
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
			await addPath(ext.path);
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
				markHookOrigin(hookPath);
				await addPath(hookPath);
			}
		}
	} else {
		for (const configuredPath of configuredPaths) {
			const hookPaths = await discoverHooksInPackageRoot(resolvePath(configuredPath, cwd));
			for (const hookPath of hookPaths) markHookOrigin(hookPath);
			await addPaths(hookPaths);
		}
	}

	// 3. Discover extension entry points from installed plugins.
	if (ambient) {
		await addPaths(await getAllPluginExtensionPaths(cwd));
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
			await addPaths(resolveExtensionDirectory(resolved, CONFIGURED_EXTENSION_DIRECTORY_OPTIONS).files);
			continue;
		}

		await addPath(resolved);
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
