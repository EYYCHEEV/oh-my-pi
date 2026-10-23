/**
 * Credential-shaped token redaction for memory writes, shared by every backend.
 *
 * `recall` puts stored memories back into the prompt, so a stored credential reaches
 * every provider on every later turn. The `local` and `sharpshooter` backends each
 * carried a private copy of this pattern list. `mnemopi` carried none.
 */

// Fixed-prefix provider tokens. Each is anchored on a literal, so it matches in one
// pass with no backtracking.
const PATTERNS = [
	/(?:AKIA|ASIA)[A-Z0-9]{16}/g,
	// Common provider token prefixes (GitHub, npm, Slack, Google).
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
	/github_pat_[A-Za-z0-9_]{20,}/g,
	/npm_[A-Za-z0-9]{30,}/g,
	/xox[baprs]-[A-Za-z0-9-]{10,}/g,
	/AIza[A-Za-z0-9_-]{30,}/g,
];

// Longest first, so `token_` wins over `tok` and reports the full match start.
const KEYWORDS = ["password", "secret", "token", "key", "tok", "sk", "pk", "rk"];
// A segment mixing letters and digits is credential-like at 12 characters. Letters
// alone need 16, which still catches `password-supersecretvalue` and
// `token-abcdefghijklmnop` while leaving `authentication` and `configuration` alone.
const MIN_MIXED_SEGMENT = 12;
const MIN_LETTERS_SEGMENT = 16;

const isDelimiter = (code: number) => code === 45 || code === 95;

function isCredentialSegment(length: number, letter: boolean, digit: boolean): boolean {
	if (!letter && !digit) return false;
	if (letter && digit) return length >= MIN_MIXED_SEGMENT;
	return length >= MIN_LETTERS_SEGMENT;
}
const isTokenChar = (code: number) =>
	(code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || isDelimiter(code);

function keywordStart(input: string, delimiter: number): number {
	for (const keyword of KEYWORDS) {
		const start = delimiter - keyword.length;
		if (start >= 0 && input.startsWith(keyword, start)) return start;
	}
	return -1;
}

/**
 * Redact a keyword, a delimiter, and the credential-looking run after it, as in
 * `secret_aB3dEfGh1JkLmN`.
 *
 * A regex cannot express "some later segment of this run mixes letters and digits"
 * without a lookahead over the tail, which rescans it once per candidate. Text like
 * `token_aaaa-token_aaaa-…` is one unbroken run, so that rescan is quadratic, and
 * `retainMessages` runs this synchronously over a whole transcript. Instead each run is
 * visited once: split it into segments, mark which ones look like credentials, then
 * sweep the flags backwards so every delimiter can be judged in constant time.
 */
function redactKeywordSecrets(input: string): string {
	let out = "";
	let copied = 0;
	let index = 0;
	while (index < input.length) {
		if (!isTokenChar(input.charCodeAt(index))) {
			index++;
			continue;
		}

		const runStart = index;
		const starts: number[] = [runStart];
		const credential: boolean[] = [];
		let length = 0;
		let letter = false;
		let digit = false;
		while (index < input.length && isTokenChar(input.charCodeAt(index))) {
			const current = input.charCodeAt(index);
			if (isDelimiter(current)) {
				credential.push(isCredentialSegment(length, letter, digit));
				starts.push(index + 1);
				length = 0;
				letter = false;
				digit = false;
			} else {
				length++;
				if (current >= 48 && current <= 57) digit = true;
				else letter = true;
			}
			index++;
		}
		credential.push(isCredentialSegment(length, letter, digit));
		const runEnd = index;

		// suffix[k] answers "does any segment from k onwards look like a credential".
		const suffix: boolean[] = Array.from({ length: credential.length + 1 }, () => false);
		for (let k = credential.length - 1; k >= 0; k--) suffix[k] = suffix[k + 1] || credential[k]!;

		for (let k = 1; k < starts.length; k++) {
			if (!suffix[k]) continue;
			const start = keywordStart(input, starts[k]! - 1);
			if (start < 0 || start < copied || start < runStart) continue;
			out += `${input.slice(copied, start)}[REDACTED]`;
			copied = runEnd;
			break;
		}
	}
	return copied === 0 ? input : out + input.slice(copied);
}

const MIN_JWT_SEGMENT = 16;

/**
 * Redact `header.payload.signature` tokens.
 *
 * The regex this replaces, `[A-Za-z0-9_-]{16,}\.` twice over, re-scanned the tail from
 * every start position when the text held long identifier runs and no dots, which is
 * what a coding transcript looks like. Dots are sparse, so anchoring on them and
 * measuring outward visits each character a constant number of times.
 */
function redactJwts(input: string): string {
	let out = "";
	let copied = 0;
	let dot = input.indexOf(".");
	while (dot > 0) {
		let start = dot;
		while (start > copied && isTokenChar(input.charCodeAt(start - 1))) start--;
		let middle = dot + 1;
		while (middle < input.length && isTokenChar(input.charCodeAt(middle))) middle++;
		let end = middle + 1;
		while (end < input.length && isTokenChar(input.charCodeAt(end))) end++;
		const looksLikeJwt =
			dot - start >= MIN_JWT_SEGMENT &&
			input.charCodeAt(middle) === 46 &&
			middle - dot - 1 >= MIN_JWT_SEGMENT &&
			end - middle - 1 >= MIN_JWT_SEGMENT;
		if (looksLikeJwt) {
			out += `${input.slice(copied, start)}[REDACTED]`;
			copied = end;
			dot = input.indexOf(".", end);
			continue;
		}
		dot = input.indexOf(".", dot + 1);
	}
	return copied === 0 ? input : out + input.slice(copied);
}

// PEM private keys span lines, which the single-pass token scanners cannot see. A block cut off before
// its footer (a truncated paste) is redacted to the end of the text: what follows the header is key.
const PEM_PRIVATE_KEY =
	/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g;

// `Authorization: Bearer <token>`. The scheme word stays; a run of 16+ token characters after it goes
// when it looks like a credential (digits, mixed case or very long), so prose that only mentions the
// scheme is left alone.
const BEARER_TOKEN = /\b(Bearer\s{1,8})([A-Za-z0-9._~+/=-]{16,})/gi;

// `password=...`, `"api_key": "..."`, `client_secret: ...`. The key and its separator stay. The value is a
// quoted literal (spaces allowed) or an unquoted run.
const CREDENTIAL_ASSIGNMENT =
	/((?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|token)["']?[ \t]{0,3}[:=][ \t]{0,3})(?:"([^"\n]{4,200})"|'([^'\n]{4,200})'|([^\s"'`,;&)}\]]{6,}))/gi;

const MIN_ASSIGNED_LETTERS_VALUE = 16;

function looksLikeBearerCredential(token: string): boolean {
	return /\d/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token)) || token.length >= 32;
}

/**
 * Whether the value of `password=...` is a literal credential rather than a reference or placeholder:
 * a quoted literal, a value with a digit or symbol, or a long run of letters. Template markers
 * (`${X}`, `<x>`, `{{x}}`, `%x%`, `$x`), `None`-style words and masks stay readable.
 */
function looksLikeAssignedCredential(value: string, quoted: boolean): boolean {
	if (/^(?:\[REDACTED\]|[$<{%*]|none$|null$|nil$|undefined$|true$|false$)/i.test(value)) return false;
	if (quoted) return true;
	return /[\d!@#^+/=~]/.test(value) || value.length >= MIN_ASSIGNED_LETTERS_VALUE;
}

function redactStructuredSecrets(input: string): string {
	return input
		.replace(PEM_PRIVATE_KEY, "[REDACTED]")
		.replace(BEARER_TOKEN, (match, scheme: string, token: string) =>
			looksLikeBearerCredential(token) ? `${scheme}[REDACTED]` : match,
		)
		.replace(
			CREDENTIAL_ASSIGNMENT,
			(match, key: string, double: string | undefined, single: string | undefined, bare: string | undefined) => {
				const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
				const value = double ?? single ?? bare ?? "";
				return looksLikeAssignedCredential(value, quote !== "") ? `${key}${quote}[REDACTED]${quote}` : match;
			},
		);
}

export function redactMemorySecrets(input: string): string {
	let out = redactJwts(redactKeywordSecrets(redactStructuredSecrets(input)));
	for (const pattern of PATTERNS) out = out.replace(pattern, "[REDACTED]");
	return out;
}

// Recalled text is scanned again on the way out: rows written before redaction existed, by another
// tool or by hand in SQLite never saw the write-side scrub. The rule families match the scan the
// stronk-bot journal runs on every entry it shows: injection phrases, hidden Unicode, credentials,
// and a download piped into a shell.

/** Soft hyphen, zero-width and bidirectional-control characters, the byte order mark and invisible tag characters. */
const HIDDEN_UNICODE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

// A memory that quotes `</memories>` would end the recall block early and let the rest read as
// prompt text. Escaping the `<` keeps the characters and breaks the tag. Only the block's own tags
// are escaped: other markup in a memory stays as written.
const FORGED_TAG = /<(?=\/?(?:memories|mental_models)\b)/gi;

// An override verb needs a qualifier that marks the target as the model's own instructions ("ignore the
// previous instructions"); a bare "ignore the lint rules" is ordinary advice and stays readable.
// "instructions", "prompts" and "directives" are model-facing nouns, so any qualifier word is enough
// ("ignore all instructions"). "rules" and "guidelines" are everyday nouns ("ignore all rules marked
// deprecated"), so they additionally need a word that points at the model's own side: "your", "previous",
// "above", "system" and the like.
const OVERRIDE_VERB = "(?:ignore|disregard|forget|override|bypass)";
const DETERMINER = "(?:the|my|these|those)";
const SCOPE_WORD = "(?:all|any|every)";
const TARGET_WORD = "(?:your|previous|prior|earlier|above|preceding|system|developer|safety|original)";
const INJECTION_PATTERN = new RegExp(
	[
		`\\b${OVERRIDE_VERB}\\s+(?:${DETERMINER}\\s+)*(?:(?:${SCOPE_WORD}|${TARGET_WORD})\\s+(?:${DETERMINER}\\s+)*){1,5}(?:instructions?|prompts?|directives)\\b`,
		`\\b${OVERRIDE_VERB}\\s+(?:${DETERMINER}\\s+)*(?:${SCOPE_WORD}\\s+(?:${DETERMINER}\\s+)*)*${TARGET_WORD}\\s+(?:${DETERMINER}\\s+)*(?:(?:${SCOPE_WORD}|${TARGET_WORD})\\s+(?:${DETERMINER}\\s+)*){0,4}(?:rules|guidelines)\\b`,
		"\\b(?:do\\s+not|don'?t)\\s+tell\\s+the\\s+user\\b",
		"\\bsystem\\s+prompt\\s+override\\b",
		"\\b(?:reveal|print|repeat|output|leak)\\s+(?:\\w+\\s+){0,3}(?:system|developer)\\s+prompt\\b",
	].join("|"),
	"i",
);
const WITHHOLD_RULES: readonly { name: string; pattern: RegExp }[] = [
	{ name: "prompt injection", pattern: INJECTION_PATTERN },
	{
		name: "download piped into a shell",
		pattern: /\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:sudo\s+)?(?:ba|z|da|k|c|a)?sh\b/i,
	},
];

export interface RecalledTextVerdict {
	/** The text to show: hidden characters stripped, credentials redacted, forged tags broken. */
	text: string;
	/** The scan rule that matched when the text must not be shown at all. */
	withheld?: string;
}

/**
 * Scan recalled memory text before it is rendered into a prompt. Hidden characters, credentials and
 * forged tags are neutralised in place. Text that reads as an instruction to the model, or as a
 * download piped into a shell, is flagged `withheld`: rewriting it reliably is not possible, so the
 * caller shows a notice instead. Hidden characters go first, so they cannot split a phrase past the scan.
 */
export function vetRecalledMemoryText(input: string): RecalledTextVerdict {
	const visible = input.replace(HIDDEN_UNICODE, "");
	const text = redactMemorySecrets(visible).replace(FORGED_TAG, "&lt;");
	const rule = WITHHOLD_RULES.find(candidate => candidate.pattern.test(visible));
	return rule ? { text, withheld: rule.name } : { text };
}

/**
 * Text-bearing fields a memory write can carry. The mnemopi facade accepts camelCase
 * and snake_case for the extraction and embedding overrides, and writes each to its own
 * column, so clearing `content` alone would leave a credential in `embed_text`.
 */
const TEXT_FIELDS = [
	"content",
	"extractText",
	"extract_text",
	"embedText",
	"embed_text",
	// `source` is persisted, returned by search, and appended to prompt context by
	// `formatRecallBlock`, and callers pass arbitrary strings for it.
	"source",
] as const;

/**
 * `metadata` is serialized whole into `working_memory.metadata_json`, and callers put
 * free text in it (`mnemopi/backend.ts` copies `MemoryBackendSaveInput.context` to
 * `metadata.context`), so its strings need the same treatment as `content`.
 */
function redactNested(value: unknown): unknown {
	if (typeof value === "string") return redactMemorySecrets(value);
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map(item => {
			const next = redactNested(item);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? out : value;
	}
	if (!value || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	let out: Record<string, unknown> | undefined;
	for (const [key, item] of Object.entries(source)) {
		const next = redactNested(item);
		if (next === item) continue;
		out ??= { ...source };
		out[key] = next;
	}
	return out ?? value;
}

/**
 * Copy `value` with every text-bearing field and all nested metadata strings redacted.
 * Returns `value` itself when nothing changed, so a clean write allocates nothing.
 */
export function redactMemoryTextFields<T extends object>(value: T): T {
	const source = value as Record<string, unknown>;
	let out: Record<string, unknown> | undefined;
	for (const field of TEXT_FIELDS) {
		const text = source[field];
		if (typeof text !== "string") continue;
		const clean = redactMemorySecrets(text);
		if (clean === text) continue;
		out ??= { ...source };
		out[field] = clean;
	}
	if ("metadata" in source) {
		const metadata = redactNested(source.metadata);
		if (metadata !== source.metadata) {
			out ??= { ...source };
			out.metadata = metadata;
		}
	}
	return (out ?? value) as T;
}

/**
 * Scrub a `remember(memory, options)` call pair. `memory` is either the content string
 * or an input object. `options` is `undefined` when the caller takes the facade default.
 */
export function redactRememberWrite<M extends string | object, O>(memory: M, options: O): [M, O] {
	const scrubbedMemory = (
		typeof memory === "string" ? redactMemorySecrets(memory) : redactMemoryTextFields(memory)
	) as M;
	const scrubbedOptions = (
		options === undefined || options === null ? options : redactMemoryTextFields(options as object)
	) as O;
	return [scrubbedMemory, scrubbedOptions];
}
