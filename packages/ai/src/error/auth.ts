import { attach, create, Flag } from "./flags";

/**
 * No API key / credential was available to dispatch a request.
 *
 * The default message preserves the historical `"No API key for provider: X"`
 * wording, which {@link Flag.AuthFailed}'s regex (`no api key`) keys off — but
 * the flag is also attached structurally so classification never depends on the
 * exact phrasing.
 */
export class MissingApiKeyError extends Error {
	readonly provider: string | undefined;

	constructor(provider?: string, message?: string) {
		super(message ?? (provider ? `No API key for provider: ${provider}` : "No API key available"));
		this.name = "MissingApiKeyError";
		this.provider = provider;
		attach(this, create(Flag.AuthFailed));
	}
}

/** Why {@link OAuthAccountPoolError} refused to hand out a stored OAuth account. */
export type OAuthAccountPoolErrorCode =
	| "all_paused"
	| "restricted_unavailable"
	| "restricted_missing"
	| "broker_unsupported";

/**
 * The operator's OAuth account pool controls (pause, exact-account launch
 * restriction) left no usable account, or the backing store cannot honor them.
 * Raised from shared credential selection so every caller (key cascade, OAuth
 * access, auth retry, web search) fails closed instead of falling through to
 * another credential source. Messages name the provider and the recovery step
 * and never include token bytes.
 */
export class OAuthAccountPoolError extends Error {
	readonly code: OAuthAccountPoolErrorCode;
	readonly provider: string;
	readonly credentialId: number | undefined;

	constructor(code: OAuthAccountPoolErrorCode, provider: string, message: string, credentialId?: number) {
		super(message);
		this.name = "OAuthAccountPoolError";
		this.code = code;
		this.provider = provider;
		this.credentialId = credentialId;
		attach(this, create(Flag.AuthFailed));
	}
}

/** A user-facing login flow required an `onPrompt` callback that was not supplied. */
export class OnPromptRequiredError extends Error {
	constructor(providerLabel: string) {
		super(`${providerLabel} login requires onPrompt callback`);
		this.name = "OnPromptRequiredError";
	}
}

/** An interactive login asked for an API key but the user supplied an empty value. */
export class ApiKeyRequiredError extends Error {
	constructor(message = "API key is required") {
		super(message);
		this.name = "ApiKeyRequiredError";
	}
}

/**
 * A user cancelled an interactive login / device flow. Classified as an abort
 * so it is never surfaced as a retryable transient failure.
 */
export class LoginCancelledError extends Error {
	constructor(message = "Login cancelled") {
		super(message);
		this.name = "LoginCancelledError";
		attach(this, create(Flag.Abort));
	}
}
