/**
 * OpenAI Codex Web Search Provider
 *
 * Uses the configured Codex Responses transport for proxy/API-key setups and
 * the official ChatGPT backend for OAuth logins.
 */
import * as os from "node:os";
import {
	type AuthStorage,
	type FetchImpl,
	type Model,
	type OAuthAccess,
	withAuth,
	withOAuthAccess,
} from "@oh-my-pi/pi-ai";
import { applyCodexResponsesLiteShape } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import {
	createOpenAICodexCompatibilityMetadata,
	resolveCodexResponsesUrl,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { $env, readSseJson } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import packageJson from "../../../../package.json" with { type: "json" };
import type { ModelRegistry } from "../../../config/model-registry";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const CODEX_SEARCH_TIMEOUT_MS = 5 * 60_000;
const FALLBACK_MODEL = "gpt-5.5";
// Live GPT-5.6 Sol leads when model discovery advertises it: this matches the
// Codex CLI's multi-step search path. Bundled non-Lite `gpt-5.5` remains the
// first fallback because it accepts a forced hosted `web_search` tool choice.
// Responses-Lite candidates run `tool_choice: "auto"` and may answer without
// searching (#5771, #6988), so the response guard must remain fail-closed.
const DEFAULT_MODEL_PREFERENCES = [
	"gpt-5.6-sol",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-terra",
	"gpt-5.4",
	"gpt-5-codex",
	"gpt-5",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.1-codex",
	"gpt-5-codex-mini",
];
const DEFAULT_INSTRUCTIONS =
	"You are a helpful assistant with web search capabilities. Search the web to answer the user's question accurately and cite your sources.";
const CODEX_STANDALONE_SEARCH_URL = `${CODEX_BASE_URL.replace(/\/$/, "")}/codex/alpha/search`;
const CODEX_WEB_RUN_DESCRIPTION =
	'Tool for accessing the internet.\n\n\n---\n\n## Examples of different commands available in this tool\n\nExamples of different commands available in this tool:\n* `search_query`: {"search_query": [{"q": "What is the capital of France?"}, {"q": "What is the capital of belgium?"}]}. Searches the internet for a given query (and optionally with a domain or recency filter)\n* `image_query`: {"image_query":[{"q": "waterfalls"}]}.\n* `open`: {"open": [{"ref_id": "turn0search0"}, {"ref_id": "https://www.openai.com", "lineno": 120}]}\n* `click`: {"click": [{"ref_id": "turn0fetch3", "id": 17}]}\n* `find`: {"find": [{"ref_id": "turn0fetch3", "pattern": "Annie Case"}]}\n* `screenshot`: {"screenshot": [{"ref_id": "turn1view0", "pageno": 0}, {"ref_id": "turn1view0", "pageno": 3}]}\n* `finance`: {"finance":[{"ticker":"AMD","type":"equity","market":"USA"}]}, {"finance":[{"ticker":"BTC","type":"crypto","market":""}]}\n* `weather`: {"weather":[{"location":"San Francisco, CA"}]}\n* `sports`: {"sports":[{"fn":"standings","league":"nfl"}, {"fn":"schedule","league":"nba","team":"GSW","date_from":"2025-02-24"}]}\n* `time`: {"time":[{"utc_offset":"+03:00"}]}\n\n---\n\n## Usage hints\nTo use this tool efficiently:\n* Use multiple commands and queries in one call to get more results faster; e.g. {"search_query": [{"q": "bitcoin news"}], "finance":[{"ticker":"BTC","type":"crypto","market":""}], "find": [{"ref_id": "turn0search0", "pattern": "Annie Case"}, {"ref_id": "turn0search1", "pattern": "John Smith"}]}\n* Use "response_length" to control the number of results returned by this tool, omit it if you intend to pass "short" in\n* Only write required parameters; do not write empty lists or nulls where they could be omitted.\n* `search_query` must have length at most 4 in each call. If it has length > 3, response_length must be medium or long\n* If you find yourself in a situation where you accidentally call the `web.run` tool, it\'s best just to send an empty query: {"search_query": [{"q": ""}]}.\n\n---\n\n## Decision boundary\n\nIf the user makes an explicit request to search the internet, find latest information, look up, etc (or to not do so), you must obey their request.\nWhen you make an assumption, always consider whether it is temporally stable; i.e. whether there\'s even a small (>10%) chance it has changed. If it is unstable, you must verify with browsing the internet for verification.\n\n<situations_where_you_must_browse_the_internet>\nBelow is a list of scenarios where browsing the internet MUST be used. PAY CLOSE ATTENTION: you MUST browse the internet in these cases. If you\'re unsure or on the fence, you MUST bias towards browsing the internet.\n- The information could have changed recently: for example news; prices; laws; schedules; product specs; sports scores; economic indicators; political/public/company figures (e.g. the question relates to \'the president of country A\' or \'the CEO of company B\', which might change over time); rules; regulations; standards; software libraries that could be updated; exchange rates; recommendations (i.e., recommendations about various topics or things might be informed by what currently exists / is popular / is safe / is unsafe / is in the zeitgeist / etc.); and many many many more categories -- again, if you\'re on the fence, you MUST browse the internet!\n  - For news queries, prioritize more recent events, ensuring you compare publish dates and the date that the event happened.\n- The user is seeking recommendations that could lead them to spend substantial time or money -- researching products, restaurants, travel plans, etc.\n- The user wants (or would benefit from) direct quotes, links, or precise source attribution.\n- A specific page, paper, dataset, PDF, or site is referenced and you haven\'t been given its contents.\n- You\'re unsure about a fact, the topic is niche or emerging, or you suspect there\'s at least a 10% chance you will incorrectly recall it\n- High-stakes accuracy matters (medical, legal, financial guidance). For these you generally should search by default because this information is highly temporally unstable\n- The user explicitly says to search, browse, verify, or look it up.\n</situations_where_you_must_browse_the_internet>\n\n---\n\n## Citations\n\nResults from `web.run` include internal reference IDs such as `turn2search5`. Use\nthose reference IDs only in calls to `web.run`; do not expose them in the final\nresponse.\n\nCite sources in the final response using Markdown links:\n\n- Cite a single source as `[descriptive source title](https://example.com/page)`.\n- Cite multiple sources with separate Markdown links, for example\n  `[first source](https://example.com/one), [second source](https://example.com/two)`.\n- Link directly to the page that supports the claim. Do not link to search result\n  pages or use bare URLs.\n\nFormatting of citations:\n\n- Place each citation as near as possible to the claim it supports, normally at\n  the end of the sentence or paragraph and after punctuation.\n- Do not place citations inside code fences.\n- Do not put citations on a line by themselves or collect all citations at the\n  end of the response.\n\nIf you browse the internet, cite statements supported by web sources. Each cited\nsource must directly support the associated claim. Prefer primary and\nauthoritative sources, and use sources from different domains when the response\nbenefits from multiple perspectives.\n\n---\n\n## Special cases\nIf these conflict with any other instructions, these should take precedence.\n\n<special_cases>\n- When the user asks for information about how to use OpenAI products, (ChatGPT, the OpenAI API, etc.), you should check the code in local env and only browse as fallback, when you browse restrict your sources to official OpenAI websites using the domains filter, unless otherwise requested.\n- When using search to answer technical questions, you must only rely on primary sources (research papers, official documentation, etc.)\n- Clearly indicate when you are making an inference from sources.\n</special_cases>\n\n---\n\n## Word limits\nResponses may not excessively quote or draw on a specific source. There are several limits here:\n- **Limit on verbatim quotes:**\n  - You may not quote more than 25 words verbatim from any single non-lyrical source, unless the source is reddit.\n  - For song lyrics, verbatim quotes must be limited to at most 10 words.\n  - Long quotes from reddit are allowed, as long as you indicate that those are direct quotes via a markdown blockquote starting with ">", copy verbatim, and link the source.\n- **Word limits:**\n  - Each webpage source in the sources has a word limit label formatted like "[wordlim N]", in which N is the maximum number of words in the whole response that are attributed to that source. If omitted, the word limit is 200 words.\n  - Non-contiguous words derived from a given source must be counted to the word limit.\n  - The summarization limit N is a maximum for each source.\n  - When using multiple sources, their summarization limits add together. However, each article used must be relevant to the response.\n- **Copyright compliance:**\n  - You must avoid providing full articles, long verbatim passages, or extensive direct quotes due to copyright concerns.\n  - If the user asked for a verbatim quote, the response should provide a short compliant excerpt and then answer with paraphrases and summaries.\n  - Again, this limit does not apply to reddit content, as long as it\'s appropriately indicated that those are direct quotes and you link to the source.\n';
const CODEX_SEARCH_QUERY_SCHEMA = {
	type: "object",
	properties: {
		domains: {
			description: "Whether to filter by a specific list of domains.",
			type: "array",
			items: { type: "string" },
		},
		q: { description: "Search query.", type: "string" },
		recency: {
			description: "Whether to filter by recency, as a number of recent days.",
			type: "integer",
		},
	},
	required: ["q"],
} as const;
const CODEX_WEB_RUN_PARAMETERS = {
	type: "object",
	properties: {
		click: {
			description: "Open links from previously opened pages.",
			type: "array",
			items: {
				type: "object",
				properties: {
					id: {
						description: "Numbered link id to open.",
						type: "integer",
					},
					ref_id: { description: "Reference id containing the numbered link.", type: "string" },
				},
				required: ["id", "ref_id"],
			},
		},
		finance: {
			description: "Look up prices for the given stock symbols.",
			type: "array",
			items: {
				type: "object",
				properties: {
					market: {
						description: 'ISO 3166-1 alpha-3 country code, "OTC", or "" for cryptocurrency.',
						type: "string",
					},
					ticker: { description: "Ticker symbol to look up.", type: "string" },
					type: {
						description: "Asset type to look up.",
						enum: ["equity", "fund", "crypto", "index"],
						type: "string",
					},
				},
				required: ["ticker", "type"],
			},
		},
		find: {
			description: "Find text patterns in pages.",
			type: "array",
			items: {
				type: "object",
				properties: {
					pattern: { description: "Text pattern to find.", type: "string" },
					ref_id: { description: "Reference id or URL to search within.", type: "string" },
				},
				required: ["pattern", "ref_id"],
			},
		},
		image_query: {
			description: "Query the image search engine for a given list of queries.",
			type: "array",
			items: CODEX_SEARCH_QUERY_SCHEMA,
		},
		open: {
			description: "Open pages by reference id or URL.",
			type: "array",
			items: {
				type: "object",
				properties: {
					lineno: {
						description: "Line number to position the page at.",
						type: "integer",
					},
					ref_id: { description: "Reference id or URL to open.", type: "string" },
				},
				required: ["ref_id"],
			},
		},
		response_length: {
			description: "Set the length of the response to be returned.",
			enum: ["short", "medium", "long"],
			type: "string",
		},
		screenshot: {
			description: "Take screenshots of PDF pages.",
			type: "array",
			items: {
				type: "object",
				properties: {
					pageno: {
						description: "Zero-indexed PDF page number.",
						type: "integer",
					},
					ref_id: { description: "Reference id or URL to screenshot.", type: "string" },
				},
				required: ["pageno", "ref_id"],
			},
		},
		search_query: {
			description: "Query the internet search engine for a given list of queries.",
			type: "array",
			items: CODEX_SEARCH_QUERY_SCHEMA,
		},
		sports: {
			description: "Look up sports schedules and standings.",
			type: "array",
			items: {
				type: "object",
				properties: {
					date_from: { description: "Start date in YYYY-MM-DD format.", type: "string" },
					date_to: { description: "End date in YYYY-MM-DD format.", type: "string" },
					fn: {
						description: "Sports function to call.",
						enum: ["schedule", "standings"],
						type: "string",
					},
					league: {
						description: "League to look up.",
						enum: ["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"],
						type: "string",
					},
					locale: { description: "Locale for the lookup.", type: "string" },
					num_games: {
						description: "Number of games to return.",
						type: "integer",
					},
					opponent: {
						description: "Opponent to use with `team` when narrowing the lookup.",
						type: "string",
					},
					team: {
						description: "Team to look up, using the common 3 or 4 letter alias used in broadcasts.",
						type: "string",
					},
					tool: { description: "Tool name for sports requests.", enum: ["sports"], type: "string" },
				},
				required: ["fn", "league"],
			},
		},
		time: {
			description: "Get time for the given UTC offsets.",
			type: "array",
			items: {
				type: "object",
				properties: {
					utc_offset: { description: 'UTC offset formatted like "+03:00".', type: "string" },
				},
				required: ["utc_offset"],
			},
		},
		weather: {
			description: "Look up weather forecasts.",
			type: "array",
			items: {
				type: "object",
				properties: {
					duration: {
						description: "Number of days to return. Defaults to 7.",
						type: "integer",
					},
					location: { description: 'Location in "Country, Area, City" format.', type: "string" },
					start: { description: "Start date in YYYY-MM-DD format. Defaults to today.", type: "string" },
				},
				required: ["location"],
			},
		},
	},
} as const;
const CODEX_WEB_RUN_TOOL = {
	type: "namespace",
	name: "web",
	description: "Tools in the web namespace.",
	tools: [
		{
			type: "function",
			name: "run",
			strict: false,
			description: CODEX_WEB_RUN_DESCRIPTION,
			parameters: CODEX_WEB_RUN_PARAMETERS,
		},
	],
} as const;

type CodexSearchModel = Model<"openai-codex-responses">;

interface CodexModelCandidate {
	modelId: string;
	catalogModel?: CodexSearchModel;
}

interface CodexSearchTransport {
	baseUrl: string;
	url: string;
	headers: Record<string, string>;
	customEndpoint: boolean;
}

interface CodexSearchResult {
	answer: string;
	sources: SearchSource[];
	model: string;
	requestId: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
const CodexStandaloneSearchResponseSchema = type({
	output: "string",
	"results?": "unknown[] | null",
	"encrypted_output?": "string | null",
});

function getBundledCodexModels(): CodexSearchModel[] {
	const models: CodexSearchModel[] = [];
	for (const model of getBundledModels("openai-codex")) {
		if (model.api === "openai-codex-responses") {
			models.push(model as CodexSearchModel);
		}
	}
	return models;
}

function findCodexModelCandidate(
	modelRegistry: ModelRegistry | undefined,
	bundledModels: readonly CodexSearchModel[],
	modelId: string,
): CodexModelCandidate | undefined {
	const registryModel = modelRegistry?.find("openai-codex", modelId);
	if (registryModel?.api === "openai-codex-responses") {
		return { modelId, catalogModel: registryModel as CodexSearchModel };
	}
	const bundledModel = bundledModels.find(model => model.id === modelId);
	return bundledModel ? { modelId, catalogModel: bundledModel } : undefined;
}

function getConfiguredModel(modelRegistry: ModelRegistry | undefined): CodexModelCandidate | undefined {
	const configuredModel = $env.PI_CODEX_WEB_SEARCH_MODEL?.trim();
	if (!configuredModel) return undefined;

	// A live registry entry is fresher than bundled metadata (e.g. a discovered
	// `useResponsesLite` flag), so it wins when it describes this exact model on
	// the Codex Responses API. The configured id is sent verbatim either way.
	return (
		findCodexModelCandidate(modelRegistry, getBundledCodexModels(), configuredModel) ?? {
			modelId: configuredModel,
		}
	);
}

function getDefaultModelCandidates(modelRegistry: ModelRegistry | undefined): CodexModelCandidate[] {
	const bundledModels = getBundledCodexModels();
	const candidates: CodexModelCandidate[] = [];
	for (const modelId of DEFAULT_MODEL_PREFERENCES) {
		if (modelId !== "gpt-5.6-sol" && !bundledModels.some(model => model.id === modelId)) continue;
		const candidate = findCodexModelCandidate(modelRegistry, bundledModels, modelId);
		if (candidate) candidates.push(candidate);
	}

	if (candidates.length > 0) {
		return candidates;
	}

	const nonMini = bundledModels.find(model => !model.id.includes("mini") && !model.id.includes("spark"));
	if (nonMini) {
		return [{ modelId: nonMini.id, catalogModel: nonMini }];
	}

	const fallbackModel = bundledModels[0];
	return fallbackModel ? [{ modelId: fallbackModel.id, catalogModel: fallbackModel }] : [{ modelId: FALLBACK_MODEL }];
}

/**
 * Raised when Codex produced an answer without invoking the hosted `web_search`
 * tool. GPT-5.6 Responses-Lite models receive `tool_choice: "auto"` (the forced
 * hosted choice is invalid under the lite shape — see #5771 / #5772), so the
 * model may skip searching and return a plain completion. A search command must
 * not present that as a successful, search-backed result (#6988); this advances
 * the candidate chain to a model that will search, or surfaces a clear failure
 * when the model was explicitly configured.
 */
class CodexNoWebSearchError extends SearchProviderError {
	constructor() {
		super(
			"codex",
			"Codex returned a completion without running web search (no web_search_call event); refusing to treat a non-search answer as a search result",
			502,
		);
		this.name = "CodexNoWebSearchError";
	}
}

function shouldRetryWithNextDefaultModel(error: unknown): boolean {
	if (error instanceof CodexNoWebSearchError) return true;
	if (!(error instanceof SearchProviderError)) return false;
	if (error.provider !== "codex" || error.status !== 400) return false;
	return /model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i.test(
		error.message,
	);
}

export interface CodexSearchParams {
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Search context size: controls how much web content to include */
	search_context_size?: "low" | "medium" | "high";
}

/** Codex API response structures validated at the SSE boundary. */
const CodexAnnotationSchema = type({
	type: "string",
	"url?": "string",
	"title?": "string",
	"start_index?": "number",
	"end_index?": "number",
});
const CodexContentPartSchema = type({
	type: "string",
	"text?": "string",
	"annotations?": CodexAnnotationSchema.array(),
});
const CodexFunctionOutputPartSchema = type({ type: "string", "text?": "string" });
const CodexSummaryPartSchema = type({ type: "string", text: "string" });
const CodexResponseItemSchema = type({
	type: "string",
	"id?": "string",
	"role?": "string",
	"name?": "string",
	"namespace?": "string",
	"call_id?": "string",
	"status?": "string",
	"arguments?": "string",
	"output?": type("string").or(CodexFunctionOutputPartSchema.array()),
	"content?": CodexContentPartSchema.array(),
	"summary?": CodexSummaryPartSchema.array(),
});
type CodexResponseItem = typeof CodexResponseItemSchema.infer;

const CodexResponseSchema = type({
	"id?": "string",
	"model?": "string",
	"status?": "string",
	"usage?": {
		"input_tokens?": "number",
		"output_tokens?": "number",
		"total_tokens?": "number",
		"input_tokens_details?": { "cached_tokens?": "number" },
	},
});

function parseCodexResponseItem(value: unknown): CodexResponseItem | undefined {
	const parsed = CodexResponseItemSchema(value);
	return parsed instanceof type.errors ? undefined : parsed;
}

function parseCodexResponse(value: unknown): typeof CodexResponseSchema.infer | undefined {
	const parsed = CodexResponseSchema(value);
	return parsed instanceof type.errors ? undefined : parsed;
}

/**
 * Known Codex "image placeholder" answers — short prose the assistant emits in
 * place of a real answer when it produced a screenshot instead of text. These
 * carry no information, so callers treat them as non-answers and advance the
 * chain to a provider that returns text. Extend by adding the normalized
 * literal below; no regex tuning required.
 */
const IMAGE_PLACEHOLDER_ANSWERS: ReadonlySet<string> = new Set([
	"see attached image",
	"attached image",
	"see the attached image",
	"see image",
	"see image above",
	"image above",
	"see image below",
	"image below",
]);

function isImagePlaceholderAnswer(text: string): boolean {
	// Strip surrounding brackets/quotes and trailing punctuation, lowercase,
	// then match against the known-placeholder set.
	const normalized = text
		.trim()
		.replace(/^[[("'`*_]+/, "")
		.replace(/[\])"'`*_.!?]+$/, "")
		.trim()
		.toLowerCase();
	return IMAGE_PLACEHOLDER_ANSWERS.has(normalized);
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	if (!sources.some(existing => existing.url === source.url)) {
		sources.push(source);
	}
}

function countCharacter(text: string, target: string): number {
	let count = 0;
	for (const char of text) {
		if (char === target) {
			count += 1;
		}
	}
	return count;
}

/**
 * Strips prose punctuation and unmatched closing delimiters from extracted URLs.
 * Codex often returns links in markdown or sentence text without structured annotations.
 */
function normalizeExtractedUrl(candidate: string): string | null {
	let url = candidate.trim();

	while (url.length > 0) {
		const lastCharacter = url.at(-1);
		if (!lastCharacter) break;
		if (/[.,!?;:'"]/u.test(lastCharacter)) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === ")" && countCharacter(url, ")") > countCharacter(url, "(")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "]" && countCharacter(url, "]") > countCharacter(url, "[")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "}" && countCharacter(url, "}") > countCharacter(url, "{")) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}

	if (!/^https?:\/\//.test(url)) {
		return null;
	}

	try {
		return new URL(url).toString();
	} catch {
		return null;
	}
}

function findMarkdownLinkUrlEnd(text: string, openParenIndex: number): number | null {
	let depth = 0;

	for (let index = openParenIndex; index < text.length; index += 1) {
		const character = text[index];
		if (!character || character === "\n") {
			return null;
		}
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") {
			continue;
		}
		depth -= 1;
		if (depth === 0) {
			return index;
		}
		if (depth < 0) {
			return null;
		}
	}

	return null;
}

/**
 * Extracts citation sources from markdown links and bare URLs in the answer text.
 * Used as a fallback when the Codex response omits `url_citation` annotations.
 */
function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];
	const markdownUrlRanges: Array<[start: number, end: number]> = [];

	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "[") {
			continue;
		}
		const titleEnd = text.indexOf("]", index + 1);
		if (titleEnd === -1 || text[titleEnd + 1] !== "(") {
			continue;
		}
		const urlEnd = findMarkdownLinkUrlEnd(text, titleEnd + 1);
		if (urlEnd === null) {
			continue;
		}
		const title = text.slice(index + 1, titleEnd).trim();
		const destination = text.slice(titleEnd + 2, urlEnd).trim();
		const titleStart = destination.search(/\s/);
		const url = normalizeExtractedUrl(titleStart === -1 ? destination : destination.slice(0, titleStart));
		if (url) {
			addSource(sources, { title: title || url, url });
			markdownUrlRanges.push([titleEnd + 2, urlEnd]);
		}
		index = urlEnd;
	}

	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		const matchIndex = match.index;
		if (
			matchIndex !== undefined &&
			markdownUrlRanges.some(([start, end]) => matchIndex >= start && matchIndex < end)
		) {
			continue;
		}
		const url = normalizeExtractedUrl(match[0] ?? "");
		if (!url) continue;
		addSource(sources, { title: url, url });
	}

	return sources;
}

/**
 * Resolve a Codex bearer + accountId through {@link AuthStorage} — the single
 * refresh authority. Returns `null` when no OAuth credential is configured,
 * when the credential cannot be refreshed (broker error, revoked token, etc.),
 * or when the access token carries no `chatgpt_account_id` claim.
 */
async function findCodexAuth(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ access: OAuthAccess; accountId: string } | null> {
	const access = await authStorage.getOAuthAccess("openai-codex", sessionId, { signal });
	if (!access) return null;
	const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
	if (!accountId) return null;
	return { access, accountId };
}

function resolveCodexSearchTransport(modelRegistry: ModelRegistry | undefined, modelId: string): CodexSearchTransport {
	const registryModel = modelRegistry?.find("openai-codex", modelId);
	const bundledModel = getBundledCodexModels().find(model => model.id === modelId);
	const providerBaseUrl = modelRegistry?.getProviderBaseUrl("openai-codex");
	let baseUrl = providerBaseUrl ?? registryModel?.baseUrl ?? CODEX_BASE_URL;
	if (registryModel?.baseUrl && registryModel.baseUrl !== (bundledModel?.baseUrl ?? CODEX_BASE_URL)) {
		baseUrl = registryModel.baseUrl;
	}

	const url = resolveCodexResponsesUrl(baseUrl);
	return {
		baseUrl,
		url,
		headers: {
			...(modelRegistry?.getProviderHeaders("openai-codex") ?? {}),
			...(registryModel?.headers ?? {}),
		},
		customEndpoint: url !== resolveCodexResponsesUrl(CODEX_BASE_URL),
	};
}

/**
 * Builds HTTP headers for Codex API requests.
 */
function buildCodexHeaders(
	accessToken: string,
	accountId: string | undefined,
	configuredHeaders: Record<string, string>,
): Headers {
	const headers = new Headers(configuredHeaders);
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (accountId) {
		headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	} else {
		headers.delete(OPENAI_HEADERS.ACCOUNT_ID);
	}
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set(OPENAI_HEADERS.VERSION, CODEX_CLIENT_VERSION);
	headers.set("User-Agent", `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`);
	headers.set("Accept", "text/event-stream");
	headers.set("Content-Type", "application/json");
	return headers;
}

/**
 * Extracts a backend error `{code, message}` from a Codex SSE event, tolerating
 * the envelope shapes the ChatGPT Codex backend emits: top-level `{code,message}`,
 * a nested `error` object, and a `response.error` object (as in `response.failed`).
 * Without this the nested shapes collapse to `Codex error (): Unknown error`,
 * discarding the backend diagnostic — e.g. a regional/model-snapshot rejection (#7200).
 */
function extractCodexSseError(rawEvent: Record<string, unknown>): { code: string; message: string } {
	const response = rawEvent.response;
	const responseError = response && typeof response === "object" && "error" in response ? response.error : undefined;
	const candidates: unknown[] = [rawEvent, rawEvent.error, responseError];
	let code = "";
	let message = "";
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "object") continue;
		if (!code && "code" in candidate && typeof candidate.code === "string" && candidate.code) {
			code = candidate.code;
		}
		if (!message && "message" in candidate && typeof candidate.message === "string" && candidate.message) {
			message = candidate.message;
		}
	}
	return { code, message };
}

/**
 * Runs GPT-5.6 Sol the same way Codex CLI does: the model calls a namespaced
 * `web.run` function, OMP executes that call through Codex's standalone search
 * endpoint, and the plain-text result is paired back into the Responses input.
 */
async function callCodexStandaloneSearch(
	auth: { accessToken: string; accountId?: string },
	query: string,
	options: {
		signal?: AbortSignal;
		systemPrompt?: string;
		searchContextSize?: "low" | "medium" | "high";
		maxOutputTokens?: number;
		model: CodexModelCandidate;
		sessionId?: string;
		fetch?: FetchImpl;
		transport: CodexSearchTransport;
	},
): Promise<CodexSearchResult> {
	const requestedModel = options.model.modelId;
	const signal = withHardTimeout(options.signal, CODEX_SEARCH_TIMEOUT_MS);
	const fetchImpl = options.fetch ?? fetch;
	const searchSessionId = options.sessionId ?? crypto.randomUUID();
	const compatibility = createOpenAICodexCompatibilityMetadata({
		sessionId: searchSessionId,
		requestKind: "turn",
		startNewTurn: true,
	});
	const modelHeaders = buildCodexHeaders(auth.accessToken, auth.accountId, options.transport.headers);
	const searchHeaders = buildCodexHeaders(auth.accessToken, auth.accountId, options.transport.headers);
	for (const name in compatibility.headers) {
		const value = compatibility.headers[name];
		if (value === undefined) continue;
		modelHeaders.set(name, value);
		searchHeaders.set(name, value);
	}
	modelHeaders.set(OPENAI_HEADERS.RESPONSES_LITE, "true");
	searchHeaders.set("Accept", "application/json");

	const userMessage: CodexResponseItem = {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: query }],
	};
	const history: CodexResponseItem[] = [userMessage];
	let webRunCallCount = 0;
	let model = requestedModel;
	let requestId = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let totalTokens = 0;
	let hasUsage = false;

	for (;;) {
		const body: Record<string, unknown> = {
			model: requestedModel,
			stream: true,
			store: false,
			input: history,
			tools: [CODEX_WEB_RUN_TOOL],
			tool_choice: webRunCallCount === 0 ? "required" : "auto",
			instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
			client_metadata: compatibility.clientMetadata,
			reasoning: { effort: "high", summary: "auto", context: "all_turns" },
		};
		applyCodexResponsesLiteShape(body);

		const response = await fetchImpl(options.transport.url, {
			method: "POST",
			headers: modelHeaders,
			body: JSON.stringify(body),
			signal,
		});
		if (!response.ok) {
			const errorText = await response.text();
			const classified = classifyProviderHttpError("codex", response.status, errorText);
			if (classified) throw classified;
			throw new SearchProviderError("codex", `Codex API error (${response.status}): ${errorText}`, response.status);
		}
		if (!response.body) {
			throw new SearchProviderError("codex", "Codex API returned no response body", 500);
		}

		const answerParts: string[] = [];
		const streamedAnswerParts: string[] = [];
		const turnItems: CodexResponseItem[] = [];
		const functionCalls: CodexResponseItem[] = [];
		const turnSources: SearchSource[] = [];
		for await (const rawEvent of readSseJson<Record<string, unknown>>(response.body, signal)) {
			const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
			if (!eventType) continue;

			if (eventType === "response.output_text.delta") {
				const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
				if (delta) streamedAnswerParts.push(delta);
			} else if (eventType === "response.output_item.done") {
				const item = parseCodexResponseItem(rawEvent.item);
				if (!item) continue;
				turnItems.push(item);
				if (
					item.type === "function_call" &&
					typeof item.call_id === "string" &&
					typeof item.arguments === "string" &&
					((item.namespace === "web" && item.name === "run") || item.name === "web.run")
				) {
					functionCalls.push(item);
				}
				if (item.type === "message" && item.content) {
					for (const part of item.content) {
						if (part.type !== "output_text" || !part.text) continue;
						answerParts.push(part.text);
						for (const annotation of part.annotations ?? []) {
							if (annotation.type === "url_citation" && annotation.url) {
								addSource(turnSources, { title: annotation.title ?? annotation.url, url: annotation.url });
							}
						}
					}
				}
			} else if (eventType === "response.completed" || eventType === "response.done") {
				const completed = parseCodexResponse(rawEvent.response);
				if (!completed) continue;
				if (completed.model) model = completed.model;
				if (completed.status && completed.status !== "completed") {
					throw new SearchProviderError("codex", `Codex response ended with status ${completed.status}`, 502);
				}
				if (completed.id) requestId = completed.id;
				if (completed.usage) {
					const cachedTokens = completed.usage.input_tokens_details?.cached_tokens ?? 0;
					inputTokens += (completed.usage.input_tokens ?? 0) - cachedTokens;
					outputTokens += completed.usage.output_tokens ?? 0;
					totalTokens += completed.usage.total_tokens ?? 0;
					hasUsage = true;
				}
			} else if (eventType === "error") {
				const { code, message } = extractCodexSseError(rawEvent);
				throw new SearchProviderError("codex", `Codex error (${code}): ${message || "Unknown error"}`, 500);
			} else if (eventType === "response.failed") {
				const { code, message } = extractCodexSseError(rawEvent);
				const detail = code
					? `Codex request failed (${code}): ${message || "Request failed"}`
					: `Codex request failed: ${message || "Request failed"}`;
				throw new SearchProviderError("codex", detail, 500);
			} else if (eventType === "response.incomplete") {
				throw new SearchProviderError("codex", "Codex response was incomplete", 502);
			}
		}

		history.push(...turnItems);
		if (functionCalls.length === 0) {
			if (webRunCallCount === 0) throw new CodexNoWebSearchError();
			const finalAnswer = answerParts.join("\n\n").trim();
			const streamedAnswer = streamedAnswerParts.join("").trim();
			const answer = finalAnswer || streamedAnswer;
			if (!answer || isImagePlaceholderAnswer(answer)) {
				throw new SearchProviderError("codex", "Codex standalone search returned no final answer", 502);
			}
			const sources = turnSources;
			for (const source of extractTextSources(answer)) addSource(sources, source);
			if (sources.length === 0) {
				throw new SearchProviderError("codex", "Codex standalone search returned no source URLs", 502);
			}
			return {
				answer,
				sources,
				model,
				requestId,
				usage: hasUsage ? { inputTokens, outputTokens, totalTokens } : undefined,
			};
		}

		for (const call of functionCalls) {
			const callId = call.call_id;
			if (!callId) continue;

			let commands: Record<string, unknown>;
			try {
				const argumentsText = call.arguments?.trim() ?? "";
				const parsed = argumentsText ? JSON.parse(argumentsText) : {};
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					throw new Error("expected a JSON object");
				}
				const validation = validateJsonSchemaValue(CODEX_WEB_RUN_PARAMETERS, parsed);
				if (!validation.success) {
					throw new Error(validation.issues.map(issue => issue.message).join("; "));
				}
				commands = parsed as Record<string, unknown>;
			} catch (error) {
				const message = error instanceof Error ? error.message : "invalid JSON";
				history.push({
					type: "function_call_output",
					call_id: callId,
					output: `Invalid web.run arguments: ${message}`,
				});
				continue;
			}

			const searchBody: Record<string, unknown> = {
				id: searchSessionId,
				model: requestedModel,
				input: [userMessage],
				commands,
				settings: {
					search_context_size: options.searchContextSize ?? "high",
					allowed_callers: ["direct"],
					external_web_access: true,
				},
			};
			if (options.maxOutputTokens !== undefined) searchBody.max_output_tokens = options.maxOutputTokens;
			const searchResponse = await fetchImpl(CODEX_STANDALONE_SEARCH_URL, {
				method: "POST",
				headers: searchHeaders,
				body: JSON.stringify(searchBody),
				signal,
			});
			if (!searchResponse.ok) {
				const errorText = await searchResponse.text();
				const classified = classifyProviderHttpError("codex", searchResponse.status, errorText);
				if (classified) throw classified;
				throw new SearchProviderError(
					"codex",
					`Codex standalone search error (${searchResponse.status}): ${errorText}`,
					searchResponse.status,
				);
			}

			let rawStandalone: unknown;
			try {
				rawStandalone = await searchResponse.json();
			} catch (error) {
				const message = error instanceof Error ? error.message : "invalid JSON";
				throw new SearchProviderError("codex", `Codex standalone search returned invalid JSON: ${message}`, 502);
			}
			const standalone = CodexStandaloneSearchResponseSchema(rawStandalone);
			if (standalone instanceof type.errors) {
				throw new SearchProviderError(
					"codex",
					`Codex standalone search response failed validation: ${standalone.summary}`,
					502,
				);
			}
			webRunCallCount += 1;
			history.push({
				type: "function_call_output",
				call_id: callId,
				output: [{ type: "input_text", text: standalone.output }],
			});
		}
	}
}

/**
 * Calls the Codex Responses API with web search tool enabled.
 * The caller provides the exact model id to send; retry / fallback policy
 * lives one layer up in `searchCodex()` so we can distinguish explicit user
 * overrides from the default ChatGPT-account model-selection path.
 */
async function callCodexSearch(
	auth: { accessToken: string; accountId?: string },
	query: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		systemPrompt?: string;
		searchContextSize?: "low" | "medium" | "high";
		model: CodexModelCandidate;
		sessionId?: string;
		fetch?: FetchImpl;
		transport: CodexSearchTransport;
	},
): Promise<CodexSearchResult> {
	const headers = buildCodexHeaders(auth.accessToken, auth.accountId, options.transport.headers);

	const requestedModel = options.model.modelId;
	const usesResponsesLite = options.model.catalogModel?.useResponsesLite === true;

	const body: Record<string, unknown> = {
		model: requestedModel,
		stream: true,
		store: false,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: query }],
			},
		],
		tools: [
			{
				type: "web_search",
				search_context_size: options.searchContextSize ?? "high",
			},
		],
		tool_choice: { type: "web_search" },
		instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
	};
	if (usesResponsesLite) {
		const metadata = createOpenAICodexCompatibilityMetadata({
			sessionId: options.sessionId,
			requestKind: "turn",
			startNewTurn: true,
		});
		for (const name in metadata.headers) {
			const value = metadata.headers[name];
			if (value !== undefined) headers.set(name, value);
		}
		headers.set(OPENAI_HEADERS.RESPONSES_LITE, "true");
		body.client_metadata = metadata.clientMetadata;
		body.reasoning = { context: "all_turns" };
		applyCodexResponsesLiteShape(body);
	}

	const fetchImpl = options.fetch ?? fetch;
	const response = await fetchImpl(options.transport.url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: withHardTimeout(options.signal, options.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("codex", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("codex", `Codex API error (${response.status}): ${errorText}`, response.status);
	}

	if (!response.body) {
		throw new SearchProviderError("codex", "Codex API returned no response body", 500);
	}

	// Parse SSE stream
	const answerParts: string[] = [];
	const streamedAnswerParts: string[] = [];
	const sources: SearchSource[] = [];
	let model = requestedModel;
	let requestId = "";
	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
	// Evidence that the hosted web_search tool actually ran. Lite models get
	// `tool_choice: "auto"` and may answer without searching (#6988); a search
	// command must reject that rather than return a non-search completion.
	let webSearchInvoked = false;

	for await (const rawEvent of readSseJson<Record<string, unknown>>(response.body, options.signal)) {
		const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
		if (!eventType) continue;

		if (eventType.startsWith("response.web_search_call")) {
			webSearchInvoked = true;
		}

		if (eventType === "response.output_text.delta") {
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (delta) {
				streamedAnswerParts.push(delta);
			}
		} else if (eventType === "response.output_item.done") {
			const item = parseCodexResponseItem(rawEvent.item);
			if (!item) continue;
			if (item.type === "web_search_call") webSearchInvoked = true;

			// Handle text message content and extract sources from annotations
			if (item.type === "message" && item.content) {
				for (const part of item.content) {
					if (part.type === "output_text" && part.text) {
						answerParts.push(part.text);

						// Extract sources from url_citation annotations
						if (part.annotations) {
							for (const annotation of part.annotations) {
								if (annotation.type === "url_citation" && annotation.url) {
									// Deduplicate by URL
									addSource(sources, { title: annotation.title ?? annotation.url, url: annotation.url });
								}
							}
						}
					}
				}
			}

			// Handle reasoning summary as part of answer
			if (item.type === "reasoning" && item.summary) {
				for (const part of item.summary) {
					if (part.type === "summary_text" && part.text) {
						answerParts.push(part.text);
					}
				}
			}
		} else if (eventType === "response.completed" || eventType === "response.done") {
			const resp = parseCodexResponse(rawEvent.response);
			if (resp) {
				if (resp.model) model = resp.model;
				if (resp.id) requestId = resp.id;
				if (resp.usage) {
					const cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0;
					usage = {
						inputTokens: (resp.usage.input_tokens ?? 0) - cachedTokens,
						outputTokens: resp.usage.output_tokens ?? 0,
						totalTokens: resp.usage.total_tokens ?? 0,
					};
				}
			}
		} else if (eventType === "error") {
			const { code, message } = extractCodexSseError(rawEvent);
			throw new SearchProviderError("codex", `Codex error (${code}): ${message || "Unknown error"}`, 500);
		} else if (eventType === "response.failed") {
			const { code, message } = extractCodexSseError(rawEvent);
			const detail = code
				? `Codex request failed (${code}): ${message || "Request failed"}`
				: `Codex request failed: ${message || "Request failed"}`;
			throw new SearchProviderError("codex", detail, 500);
		}
	}

	if (!webSearchInvoked) {
		throw new CodexNoWebSearchError();
	}

	const finalAnswer = answerParts.join("\n\n").trim();
	const streamedAnswer = streamedAnswerParts.join("").trim();
	// Throw to advance the chain whenever Codex emitted nothing but image
	// placeholder prose — including the case where the streamed delta itself
	// is the placeholder (the model occasionally streams the same text it
	// publishes as the final output_text).
	const finalIsPlaceholder = finalAnswer.length > 0 && isImagePlaceholderAnswer(finalAnswer);
	const streamedIsPlaceholder = streamedAnswer.length > 0 && isImagePlaceholderAnswer(streamedAnswer);
	const hasFinalText = finalAnswer.length > 0 && !finalIsPlaceholder;
	const hasStreamedText = streamedAnswer.length > 0 && !streamedIsPlaceholder;
	if (!hasFinalText && !hasStreamedText && sources.length === 0) {
		throw new SearchProviderError("codex", "Codex returned image-only response", 502);
	}
	const answer = hasFinalText ? finalAnswer : hasStreamedText ? streamedAnswer : "";

	// Fallback: when Codex omits url_citation annotations, scrape markdown links
	// and bare URLs from the synthesized answer so callers still receive sources.
	if (sources.length === 0 && answer.length > 0) {
		for (const source of extractTextSources(answer)) {
			addSource(sources, source);
		}
	}

	return {
		answer,
		sources,
		model,
		requestId,
		usage,
	};
}

async function runCodexSearchCandidates(options: {
	auth: { accessToken: string; accountId?: string };
	params: SearchParams;
	query: string;
	modelCandidates: CodexModelCandidate[];
	modelWasConfigured: boolean;
	transport: CodexSearchTransport;
}): Promise<CodexSearchResult> {
	let lastError: unknown;
	for (let index = 0; index < options.modelCandidates.length; index += 1) {
		const candidate = options.modelCandidates[index];
		if (!candidate) continue;

		try {
			const callOptions = {
				signal: options.params.signal,
				timeoutMs: options.params.timeoutMs,
				systemPrompt: options.params.systemPrompt,
				searchContextSize: "high" as const,
				maxOutputTokens: options.params.maxOutputTokens,
				model: candidate,
				sessionId: options.params.sessionId,
				fetch: options.params.fetch,
				transport: options.transport,
			};
			return await (candidate.modelId === "gpt-5.6-sol" && !options.transport.customEndpoint
				? callCodexStandaloneSearch(options.auth, options.query, callOptions)
				: callCodexSearch(options.auth, options.query, callOptions));
		} catch (error) {
			lastError = error;
			const isLastCandidate = index === options.modelCandidates.length - 1;
			if (options.modelWasConfigured || isLastCandidate || !shouldRetryWithNextDefaultModel(error)) {
				throw error;
			}
		}
	}
	throw lastError ?? new Error("Codex search failed without returning a result");
}

/**
 * Executes a web search using OpenAI Codex's built-in web search tool.
 *
 * Default-model behavior:
 * - If `PI_CODEX_WEB_SEARCH_MODEL` is set, use it exactly once and surface any
 *   upstream error verbatim.
 * - Otherwise prefer live-registry GPT-5.6 Sol and run its namespaced
 *   `web.run` calls through Codex's standalone search endpoint. Unsupported
 *   Sol attempts may advance through the bundled hosted-search fallbacks.
 *   Non-Sol Responses-Lite candidates remain protected by the existing
 *   `web_search_call` evidence guard.
 */
export async function searchCodex(params: SearchParams): Promise<SearchResponse> {
	const configuredModel = getConfiguredModel(params.modelRegistry);
	const modelCandidates = configuredModel ? [configuredModel] : getDefaultModelCandidates(params.modelRegistry);
	const firstCandidate = modelCandidates[0];
	if (!firstCandidate) {
		throw new SearchProviderError("codex", "No Codex web search model is configured.");
	}
	const transport = resolveCodexSearchTransport(params.modelRegistry, firstCandidate.modelId);
	// The ChatGPT-backend Codex endpoint speaks the undocumented codex-rs
	// request shape (responses-lite moves tools into an `additional_tools`
	// developer item), so the documented `web_search.filters.allowed_domains`
	// parameter cannot be assumed to survive it. Instead, re-emit directive
	// queries with the full Google-style operator syntax — the backing index
	// parses the classic operator set — and leave directive-free queries
	// byte-identical.
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query;

	let result: CodexSearchResult;
	if (transport.customEndpoint) {
		// ModelRegistry resolves command-backed provider keys before consulting
		// its AuthStorage, so a lower-priority OAuth origin is irrelevant when
		// that command source is configured.
		const credentialSource = params.modelRegistry?.authStorage ?? params.authStorage;
		const credentialOrigin = credentialSource.getCredentialOrigin("openai-codex");
		const hasCommandBackedKey = params.modelRegistry?.hasCommandBackedApiKey("openai-codex") === true;
		if (!hasCommandBackedKey && (credentialOrigin?.kind === "oauth" || credentialOrigin?.kind === "env")) {
			throw new SearchProviderError(
				"codex",
				`Refusing to send official Codex OAuth credentials to custom endpoint ${transport.baseUrl}. Configure an API key for provider "openai-codex".`,
			);
		}

		const resolverOptions = {
			sessionId: params.sessionId,
			baseUrl: transport.baseUrl,
			modelId: firstCandidate.modelId,
		};
		const keyOrResolver = params.modelRegistry
			? params.modelRegistry.resolver("openai-codex", resolverOptions)
			: params.authStorage.resolver("openai-codex", resolverOptions);
		result = await withAuth(
			keyOrResolver,
			accessToken =>
				runCodexSearchCandidates({
					auth: { accessToken },
					params,
					query,
					modelCandidates,
					modelWasConfigured: configuredModel !== undefined,
					transport,
				}),
			{
				signal: params.signal,
				missingKeyMessage: 'Codex credentials not found. Configure an API key for provider "openai-codex".',
			},
		);
	} else {
		const seed = await findCodexAuth(params.authStorage, params.sessionId, params.signal);
		if (!seed) {
			throw new Error(
				"No Codex OAuth credentials found. Login with 'omp /login openai-codex' to enable Codex web search.",
			);
		}

		result = await withOAuthAccess(
			params.authStorage,
			"openai-codex",
			access => {
				// A refreshed/rotated credential can carry a different bearer and
				// ChatGPT account id than the seed used to select the first attempt.
				const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
				if (!accountId) {
					throw new Error("Codex OAuth credential is missing a ChatGPT account id");
				}
				return runCodexSearchCandidates({
					auth: { accessToken: access.accessToken, accountId },
					params,
					query,
					modelCandidates,
					modelWasConfigured: configuredModel !== undefined,
					transport,
				});
			},
			{ sessionId: params.sessionId, signal: params.signal, seed: seed.access },
		);
	}

	let sources = result.sources;

	const numResults = params.numSearchResults ?? params.limit;
	if (numResults && sources.length > numResults) {
		sources = sources.slice(0, numResults);
	}

	return {
		provider: "codex",
		answer: result.answer || undefined,
		sources,
		usage: result.usage
			? {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
				}
			: undefined,
		model: result.model,
		requestId: result.requestId,
	};
}

/**
 * Checks whether Codex web search has an API key or OAuth credential.
 */
export async function hasCodexSearch(authStorage: AuthStorage): Promise<boolean> {
	return authStorage.hasAuth("openai-codex");
}

/** Search provider for OpenAI Codex web search. */
export class CodexProvider extends SearchProvider {
	readonly id = "codex";
	readonly label = "OpenAI";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return hasCodexSearch(authStorage);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCodex(params);
	}
}
