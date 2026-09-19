/**
 * Kimi Code provider - wraps OpenAI Chat Completions, Anthropic Messages, or
 * OpenAI Responses based on model policy and explicit format settings.
 *
 * Kimi offers:
 * - OpenAI Chat Completions: https://api.kimi.com/coding/v1/chat/completions
 * - Anthropic Messages: https://api.kimi.com/coding/v1/messages
 * - OpenAI Responses: https://api.kimi.com/coding/v1/responses
 *
 * Explicit discovered protocol metadata and request overrides win; K3 rows
 * with `protocol: null` use the native Responses policy.
 */
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimOptions,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";
import { streamOpenAIResponses, type OpenAIResponsesOptions } from "./openai-responses";

export type KimiApiFormat = OpenAIAnthropicApiFormat | "responses";

export interface KimiOptions extends Omit<OpenAIAnthropicShimOptions, "format"> {
	/** Explicit API format override. Defaults to the model's resolved protocol policy. */
	format?: KimiApiFormat;
}

/**
 * Stream from Kimi Code, routing K3 through Responses when its catalog policy
 * selects that transport and retaining the OpenAI/Anthropic compatibility shim
 * for legacy models and explicit overrides.
 */
export function streamKimi(
	model: Model<"openai-completions">,
	context: Context,
	options?: KimiOptions,
): AssistantMessageEventStream {
	const requestedFormat = options?.format ?? model.compatConfig?.kimiApiFormat;
	const defaultFormat = requestedFormat ?? (model.compat.kimiResponses ? "responses" : model.compat.kimiApiFormat);
	if (defaultFormat === undefined) {
		throw new Error(`Kimi Code model ${model.id} has no resolved API format`);
	}
	if (defaultFormat === "responses") return streamKimiResponses(model, context, options);
	const { format: _format, ...shimOptions } = options ?? {};
	return streamOpenAIAnthropicShim(model, context, shimOptions, {
		anthropicBaseUrl: model.baseUrl.replace(/\/v1\/?$/, ""),
		defaultFormat,
		anthropicThinkingMode: model.compat.thinkingFormat === "kimi" ? "anthropic-adaptive" : undefined,
		forwardCacheOptions: true,
		extraHeaders: getKimiCommonHeaders,
	});
}

function streamKimiResponses(
	model: Model<"openai-completions">,
	context: Context,
	options?: KimiOptions,
): AssistantMessageEventStream {
	const { format: _format, kimiApiFormat: _kimiApiFormat, ...rest } = options ?? {};
	const responsesModel = buildModel({
		...model,
		api: "openai-responses",
		compat: model.compatConfig,
	} as ModelSpec<"openai-responses">);
	const responseOptions: OpenAIResponsesOptions = {
		...(rest as OpenAIResponsesOptions),
		headers: { ...getKimiCommonHeaders(), ...options?.headers },
		statefulResponses: false,
		toolChoice: context.tools && context.tools.length > 0 ? "auto" : undefined,
	};
	return streamOpenAIResponses(responsesModel, context, responseOptions);
}

/**
 * Check if a model is a Kimi Code model.
 */
export function isKimiModel(model: Model<Api>): boolean {
	return model.provider === "kimi-code";
}
