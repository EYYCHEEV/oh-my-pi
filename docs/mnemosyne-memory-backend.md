# Mnemopi memory backend

omp can use `@oh-my-pi/pi-mnemopi` as a local long-term memory backend.

Set:

```yaml
memory:
   backend: mnemopi
```

Example:

```yaml
memory:
   backend: mnemopi
mnemopi:
   scoping: per-project-tagged
```

With this backend enabled, the coding agent:

1. Opens one or more local Mnemopi SQLite databases according to the configured bank scoping.
2. Recalls relevant memories into a `<memories>` block for the first model turn of a session and refreshes the base prompt if recall happens from the `agent_start` listener.
3. Retains completed conversation turns into the retain bank after agent turns, no more often than `mnemopi.retainEveryNTurns`.
4. Adds recalled memory as extra compaction context when compaction asks the memory backend for `preCompactionContext`.
5. Uses the normal `/memory view`, `/memory stats`, `/memory diagnose`, `/memory clear`, and `/memory enqueue` commands through the shared memory backend interface.

Recalled memory is background context, not instructions. Current user messages and tool output take precedence when they conflict.

## Agent tools

Selecting Mnemopi makes these discoverable tools available:

- `recall` — search scoped memories. Results are previews and include memory IDs.
- `retain` — store durable facts explicitly.
- `reflect` — synthesize an answer across recalled memories.
- `memory_edit` — `update`, `forget`, or `invalidate` an editable memory by ID. Fact-table rows are read-only.

Read the full content and metadata for a recalled result with `read memory://<memory-id>` before replacing it; clipped recall previews are not safe update payloads. The optional `learn` tool is also able to retain into Mnemopi when `autolearn.enabled: true`.

The first-turn recall is part of the transcript's history and is stored in the session file as a `memory_recall` entry. Resuming, switching to, or forking the session sends that block unchanged instead of recalling again, so the system prompt (and the provider prompt cache built on it) stays the same across processes. If a recalled memory was since deleted, invalidated, expired, or its recall preview changed (including by `/memory clear` or `memory_edit`), the next turn started from a prompt carries a one-time hidden note listing what changed; the original block is not rewritten. The session recalls afresh after a context reset, from a different memory database, and on a branch that edits the first prompt. Recalled text stays in the session file even after the memory is deleted from the store.

`memory_edit invalidate` and `forget` on a working row also retire the copies consolidation made of it, so a retired memory does not resurface through its episodic summary or the facts extracted from it. A summary that covered only that row is expired (invalidate) or deleted (forget). A summary that also covers other rows is rewritten from their live text, and the old one is retired or deleted, so the other rows keep their summary and facts. A summary that cannot be rewritten (one written by a caller instead of `sleep`) is retired or deleted whole. `update` does not cascade: a consolidated summary keeps the row's earlier text.

`memory_edit forget` also makes the agent forget the text where it was quoted. With transcript auto-retain on (`mnemopi.autoRetain`), the transcript of the session that stored a memory, and of every later session whose recall showed it, is retained as rows with source `coding-agent-transcript`, so a deleted memory would still be recallable through them. `forget` cuts it out of those rows too: the text, and the wording the fact extractor gave it, become `[forgotten]`, in any case, punctuation or AAAK compaction, wherever five consecutive words of it recur (a text of one word, or only numbers, is cut only where it stands whole, and a text under 8 characters is not cut at all, which the tool says). The rest of each row stays. What was built from a cut row is rebuilt: its facts, its vector, and the `sleep` summaries that list it. A summary whose transcript rows pruning already deleted is cut in place, and the facts of pruned rows that quote the text are deleted. The forgotten text is not kept: `forget` keeps salted hashes of its five-word windows (`forget_tombstones`, the newest 50 000 per bank, `MNEMOPI_FORGET_TOMBSTONE_LIMIT`), which cut it out of transcripts retained later, such as the transcript of the session that forgot it. A quote of fewer than five words, a memory the user stored again on purpose, and the session files on disk are not touched. `invalidate` keeps transcripts as history.

`forget` also reaches the bytes on disk, not only the rows a query returns. SQLite keeps what a delete frees in the free space of the file, in the write-ahead log until a checkpoint, and in the full-text index segments, so a deleted memory could still be read from `mnemopi.db` and `mnemopi.db-wal` (or a copy of them) by anything that opens the files. Every connection now runs with `PRAGMA secure_delete=ON`. While a forget deletes, the three full-text indexes use the FTS5 `secure-delete` option, set and put back inside the same transaction (it stays off otherwise: a secure full-text delete rewrites segment pages, and on a 5000-row prune it cost about 30 times more); an SQLite whose FTS5 refuses the option gets an `optimize` merge of each index after the forget. A forget ends with `PRAGMA wal_checkpoint(TRUNCATE)`, which copies the log into the main file and empties it. The checkpoint waits at most 200 ms for readers: another process holding a read transaction (a hand session reading memory) blocks it, and then the owed checkpoint is recorded in the table `forget_checkpoint_pending` and finished by the next open, `sleep` or close of the bank, in any process; until then the old bytes stay in the log. A database that earlier, non-secure deletes already touched keeps what they left in its free space until a `VACUUM` rewrites the file (`forget` does not run one), and a backup or copy made before the forget keeps the text.

Memory text is scanned on the way in and on the way out. Writes redact provider tokens, PEM private-key blocks, `Bearer` tokens and `password=` / `api_key=` style assignments (the key name stays, the value becomes `[REDACTED]`). Recalled text is scanned again before it is rendered, because rows written earlier, by another tool or by hand never saw the write scrub: hidden Unicode characters are stripped, credentials are redacted, and a quoted `</memories>` tag is broken so a memory cannot close the recall block. A row that reads as an instruction to the model (`ignore all previous instructions`) or as a download piped into a shell is withheld: the first-turn block, the pre-compaction recall and `reflect` omit it, and `recall` and the memory search list it as `[withheld: ...]` with its id so you can inspect it with `read memory://<id>` or remove it with `memory_edit`. The scan is a list of patterns, not a guarantee; withheld rows stay in the store.

## Settings

| Setting                       | Default            | Description                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`              | `off`              | Set to `mnemopi` to enable this backend.                                                                                                                                                                                                                                                                      |
| `mnemopi.dbPath`              | agent memories dir | Optional SQLite database path.                                                                                                                                                                                                                                                                                |
| `mnemopi.bank`                | unset              | Optional shared bank base name passed to `Mnemopi`; the coding-agent wrapper scopes from this base according to `mnemopi.scoping`. Unset → shared bank `default`; per-project modes derive a project bank from the working-directory basename plus a stable hash of its absolute path.                        |
| `mnemopi.scoping`             | `per-project`      | Memory visibility mode: `global` = one shared bank, `per-project` = isolated project memory, `per-project-tagged` = project-local writes plus global recall visibility.                                                                                                                                       |
| `mnemopi.autoRecall`          | `true`             | Recall memory on the first turn of a session.                                                                                                                                                                                                                                                                 |
| `mnemopi.autoRetain`          | `true`             | Retain completed turns automatically.                                                                                                                                                                                                                                                                         |
| `mnemopi.polyphonicRecall`    | `false`            | Fuse the standard ranking by reciprocal rank with vector, graph, fact and temporal voices, so memories linked in the episodic graph (by `mnemopi.proactiveLinking` or consolidation) or through consolidated extracted facts surface without a keyword match. `MNEMOPI_POLYPHONIC_RECALL` overrides when set. |
| `mnemopi.enhancedRecall`      | `false`            | Cache recall results per query for up to 5 minutes. Entries are keyed on every recall option (limit, facts, channel, time, bank), similar queries only reuse entries with identical options, and any write to the bank drops the cache. `MNEMOPI_ENHANCED_RECALL` overrides when set.  |
| `mnemopi.proactiveLinking`    | `false`            | Ingest new memories into the episodic graph and link them to related entities/memories as they are stored; `MNEMOPI_PROACTIVE_LINKING` overrides when set.                                                                                                                             |
| `mnemopi.retainEveryNTurns`   | `4`                | Minimum user turns between automatic retain writes.                                                                                                                                                                                                                                    |
| `mnemopi.recallLimit`         | `8`                | Maximum recalled memories in the prompt block.                                                                                                                                                                                                                                         |
| `mnemopi.recallContextTurns`  | `3`                | Prior user-bounded turns included in recall queries.                                                                                                                                                                                                                                   |
| `mnemopi.recallMaxQueryChars` | `4000`             | Maximum composed recall query length.                                                                                                                                                                                                                                                  |
| `mnemopi.injectionTokenLimit` | `5000`             | Approximate token budget for memory prompt injection.                                                                                                                                                                                                                                  |
| `mnemopi.tier2Days`           | env/`30`           | Age in days at which an episodic memory is cut to its first 800 characters and loses its vector. `0` never cuts. Unset keeps `MNEMOPI_TIER2_DAYS` (default `30`). |
| `mnemopi.tier3Days`           | env/`180`          | Age in days at which a tier 2 memory is cut to its key sentences (300 characters). `0` never cuts. Unset keeps `MNEMOPI_TIER3_DAYS` (default `180`). |
| `mnemopi.graphLinkWindow`     | env/`200`          | Newest memories a new episodic summary is linked against when consolidation runs (session start does). `0` links against every memory, at a cost that grows with history. Negative or non-numeric reads as unset; unset keeps `MNEMOPI_GRAPH_LINK_WINDOW`. |
| `mnemopi.pruneConsolidatedDays` | unset (off)      | Days a working-memory row is kept after session-start consolidation summarized it. Past that age the row and its full-text, vector and annotation entries are deleted and the episodic summary stays. Unset or `0` keeps every row. Negative or non-numeric reads as unset. See Bounded growth. |
| `mnemopi.debug`               | `false`            | Enable debug logging for backend failures.                                                                                                                                                                                                                                             |
| `mnemopi.noEmbeddings`        | `false`            | Pass `noEmbeddings` to `Mnemopi` and force FTS-only recall.                                                                                                                                                                                                                            |
| `mnemopi.allowModelDownload`  | `true`             | `true` keeps the first-use install and download of the local embedding model; `false` never downloads or installs: the model is used only if it is already cached, otherwise the run uses keyword search and logs one warning. See Embedding downloads and unattended runs. |
| `mnemopi.embeddingVariant`    | `en`               | Local embedding model variant: `en` = `BAAI/bge-base-en-v1.5` (768d), `multilingual` = `intfloat/multilingual-e5-large` (1024d). `mnemopi.embeddingModel`/`MNEMOPI_EMBEDDING_MODEL` override it; changing it rebuilds stored embeddings on the next writable start.                    |
| `mnemopi.embeddingModel`      | variant default    | Explicit embedding model id; overrides `mnemopi.embeddingVariant`. Precedence: this setting > `MNEMOPI_EMBEDDING_MODEL` env > variant default; a blank or `null` setting counts as unset.                                                                                                                                         |
| `mnemopi.embeddingApiUrl`     | env/default        | OpenAI-compatible embedding endpoint passed to `Mnemopi`.                                                                                                                                                                                                                              |
| `mnemopi.embeddingApiKey`     | env/default        | Embedding API key passed to `Mnemopi`.                                                                                                                                                                                                                                                 |
| `mnemopi.llmMode`             | `smol`             | `smol` resolves the `memory` model role and its retry chain; `remote` uses the settings below; `none` disables LLM calls. |
| `mnemopi.llmBaseUrl`          | env/default        | OpenAI-compatible LLM endpoint for `llmMode: remote`.                                                                                                                                                                                                                                  |
| `mnemopi.llmApiKey`           | env/default        | LLM API key for `llmMode: remote`.                                                                                                                                                                                                                                                     |
| `mnemopi.llmModel`            | env/default        | LLM model id for `llmMode: remote`.                                                                                                                                                                                                                                                    |

## Scoping

The coding-agent wrapper applies scoping on top of the underlying `Mnemopi` package:

- `global` uses one shared bank for recall and writes.
- `per-project` writes to and recalls from a bank derived from the current working directory alone — its basename plus a stable hash of its absolute path, independent of the surrounding git layout.
- `per-project-tagged` writes to the project-local bank and recalls from both the project-local bank and the shared global bank, with duplicate recall results merged.

Under `global` and `per-project-tagged`, the `retain` and `learn` tools also accept `scope: "global"`, which writes an item or lesson to the shared bank so every project recalls it. Under `per-project` the option is not offered, because no bank is recalled by every project.

Non-global modes also recall legacy sibling banks whose working-memory rows all carry the current absolute cwd in `metadata.cwd`; mixed-cwd, empty, corrupt, or unreadable banks are excluded. Startup probes at most 64 additional bank directories. New writes still use the current project bank.

The combined project-plus-global behavior lives in the wrapper. The `@oh-my-pi/pi-mnemopi` package itself still exposes banks and constructor options directly, including `bank` for selecting a bank name. Project-local banks other than the shared bank are stored as sibling bank databases managed by Mnemopi's `BankManager`.

## Recall previews and full-row reads

Recall results carry clipped content previews, not full rows. Content longer than the preview cap is truncated with `…` on each cut side; the result also sets `truncated: true` and `full_length` (original character count), so callers can detect clipping without parsing the marker. The cap is `RecallOptions.contentPreviewChars` (default `500`; `0` disables clipping). The preview is the head of the row, unless the query matched only past the head: then it is a window around the match (a leading `…` marks it), preferring the query terms that are rare in that row, so a fact buried deep in a long row appears in the recall result instead of its first 499 characters.

The full row is always reachable by reading `memory://<memory-id>`, which resolves the live working or episodic row and returns its full content behind a small YAML frontmatter header (`id`, `bank`, `store`, `memory_type`, timestamps, `importance`, `veracity`, `session_id`, `metadata`). The coding-agent's model-facing prompts require this read before any `memory_edit update`, since `update` replaces content wholesale and would otherwise discard the unseen tail of a clipped preview.

Retention writes a marker-free transcript projection: when the host supplies an `embedText` override alongside the stored transcript, that projection is used for embedding, working-memory FTS indexing (`COALESCE(embed_text, content)`), and rebuild-reembedding, so retention protocol markers in the stored transcript do not pollute vector and full-text recall.

## Recall ranking weights

Recall multiplies each memory's score by a weight for its stored `veracity` label and, for episodic memories, by a weight for its degradation tier. Each weight is read from its environment variable on every recall:

| Variable                  | Default | Applies to                                                                                                             |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MNEMOPI_STATED_WEIGHT`   | `1.0`   | `veracity: stated`, which the coding agent's explicit memory save (the extension `memory.save` API) writes             |
| `MNEMOPI_UNKNOWN_WEIGHT`  | `0.8`   | `veracity: unknown`, which the coding agent's automatic transcript retention writes, and any write that names no label |
| `MNEMOPI_INFERRED_WEIGHT` | `0.7`   | `veracity: inferred`                                                                                                   |
| `MNEMOPI_IMPORTED_WEIGHT` | `0.6`   | `veracity: imported`                                                                                                   |
| `MNEMOPI_TOOL_WEIGHT`     | `0.5`   | `veracity: tool`, which the coding agent's `retain` and `learn` tools write                                            |
| `MNEMOPI_TIER1_WEIGHT`    | `1.0`   | episodic memories at degradation tier 1                                                                                |
| `MNEMOPI_TIER2_WEIGHT`    | `0.85`  | episodic memories at degradation tier 2                                                                                |
| `MNEMOPI_TIER3_WEIGHT`    | `0.7`   | episodic memories at degradation tier 3 or beyond                                                                      |

Sleep consolidation carries a working memory's label onto the episodic memory it produces.

Memories labelled `true` or `likely_true` always weigh `1.0`, and `false` weighs `0`. With `mnemopi.polyphonicRecall`, these weights order the standard ranking that becomes the fused `hybrid` voice; the vector, graph, fact and temporal voices do not apply them.

## Episodic tier cut

`sleep` shrinks old episodic memories so a long-lived database stays small: after `mnemopi.tier2Days` (30) a memory keeps only its first 800 characters and loses its vector (tier 2), and after `mnemopi.tier3Days` (180) a tier 2 memory keeps only about 300 characters of key sentences (tier 3). The cut runs when `sleep` runs, and a cut memory is never re-embedded. Facts or details that sat past the kept prefix are no longer reachable through the episodic row; working-memory rows that were consolidated into it still hold the full text for keyword search.

The setting is per config, so each project or bot can choose its own cut. `0` turns a tier off (`tier2Days: 0` keeps every episodic memory whole; `tier3Days` only applies to memories already at tier 2). Negative values read as unset. When the setting is absent, the `MNEMOPI_TIER2_DAYS` / `MNEMOPI_TIER3_DAYS` environment variables keep working exactly as before; a configured setting wins over them.

## Bounded growth

`sleep` turns working rows into episodic summaries but keeps the rows, so every memory is stored twice, and the working copy is the larger one: the full text, a full-text index entry of about the same size again, two annotation rows, and with embeddings a vector of about 16 KB of JSON. On a synthetic Commander year (50 transcript rows of 3 KB a day, autoRetain on) the working rows and their indexes are 88% of a 215 MB file with embeddings off and 91% of a 539 MB file with embeddings on. An explicit-retain bot (3 notes a day) grows about 5 MB a year with embeddings off and 41 MB with them on.

`mnemopi.pruneConsolidatedDays: N` bounds that part. It is off by default. When it is on, `sleep` (session start and `/memory enqueue`) deletes a working row `N` days after it was consolidated, with its full-text entry, vector, annotations, validation log and graph nodes and edges. The episodic summary stays, and so do the facts extracted from the row. A row goes only if all of these hold: it is consolidated, it is not `IMPORTED`, and a live (not superseded, not expired) episodic row lists it in `summary_of`. An unconsolidated row, a row a schema migration merely marked, and a row whose only summary was retired are never touched, so the only copy of a memory is never deleted. With the default tier cut the summary keeps only 800 characters after 30 days and the working row is the only full text, so pruning at 30 days gives that text up; set `tier2Days: 0` as well when the summary has to stay whole, as for an explicit-retain bot.

What you give up: the verbatim row. The summary holds the same text with light AAAK abbreviation, up to `maxEpisodeChars`, then cut to 800 and 300 characters by the tier cut. `forget` and `memory_edit update` act on working rows, so they no longer find a pruned memory; `invalidate` still hides it through its summary. A forget or invalidate of a row whose summary also covers a pruned row cannot rewrite that summary without the pruned text, so the summary is deleted or retired whole. Facts extracted from a pruned row keep their source id, which no longer resolves, and stay recallable until a forget finds their text. Forgetting a memory also cuts its text out of the retained session transcripts that quote it, and pruning does not put a quote out of reach: the summary built from a pruned transcript is cut in place, and the facts of pruned rows that quote the text are deleted, found by the same five-word windows the transcripts are (a quote the windows cannot match, such as one of fewer than five words, stays).

Cost and space. A run removes at most 5000 rows, in batches of 500 per write transaction, and ends with one full-text index merge (`optimize`, about 70 ms for a 10 MB index; deletes otherwise leave the index four times its fresh size). Enabling it on an existing 539 MB bank took four session starts (3.6, 1.6, 1.5 and 1.3 s), the last of which also compacted the file to 89 MB. SQLite reuses freed pages but never returns them, so a run compacts the file with `VACUUM` once it has no backlog and a quarter of the file (4 MiB or more) is free; a steady prune frees about what new writes need and never gets there. In WAL mode `VACUUM` is one write transaction: readers in other processes keep reading, writers wait out the 5 s busy timeout, and it needs free disk of about the database size while it runs. It was exercised against a process holding a read transaction and another writing without pause, with no lost write and a clean integrity check. Failures are logged and retried at the next start.

Synthetic results (fake clock, one year, file size after a WAL checkpoint, MB):

| Profile | Setting | Day 30 | Day 180 | Day 365 |
| --- | --- | --- | --- | --- |
| Bot, 3 retains a day, FTS only, `tier2Days: 0` | off | 0.8 | 2.8 | 5.2 |
| | `30` | 0.8 | 1.7 | 2.7 |
| Bot, same, with embeddings | off | 3.7 | 20.5 | 41.1 |
| | `30` | 3.7 | 12.0 | 22.1 |
| Commander, 50 rows of 3 KB a day, FTS only, default tier cut | off | 22.8 | 109.7 | 214.7 |
| | `30` | 22.8 | 35.4 | 43.9 |
| Commander, same, with embeddings | off | 49.4 | 269.8 | 539.3 |
| | `30` | 49.4 | 72.0 | 93.3 |

Growth does not stop: what is left is the episodic side, about 5 KB a day for the bot and 46 KB a day for the Commander with embeddings off (the episodic rows, their graph edges, gists and logs), and the summaries' own vectors with embeddings on. Bounding that means expiring summaries, which forgets the memory; it is not part of this setting.

## LLM and embeddings

FTS and embedding paths use the settings below. `llmMode: smol` resolves the `memory` role and its configured retry chain, fetching credentials at call time. When unset, the role reuses `tiny`, then the fast (`smol`) defaults. It supports both local-inference and online models. `llmMode: remote` uses the OpenAI-compatible endpoint settings; `llmMode: none` disables LLM calls. If no usable model or credential resolves, Mnemopi continues without LLM-backed work. The legacy `providers.memoryModel` setting is migrated into the `memory` role.

Vector recall (the default ranking whenever embeddings are on) compares the query embedding with the stored embeddings of the newest 5000 rows of each memory tier, so a purely semantic match is still found when thousands of newer memories were written after it. The bound keeps a recall near 190 ms per tier with the default 768-dimension model (about 100 ms at 384 dimensions); a row older than the newest 5000 of its tier is found by keyword only.

FTS-only:

```yaml
memory:
   backend: mnemopi
mnemopi:
   noEmbeddings: true
```

Equivalent constructor shape:

```ts
new Mnemopi({ noEmbeddings: true });
```

Remote embeddings:

```yaml
mnemopi:
   embeddingModel: text-embedding-3-small
   embeddingApiUrl: https://api.openai.com/v1
   embeddingApiKey: ${OPENAI_API_KEY}
```

Equivalent constructor shape:

```ts
new Mnemopi({
	embeddingModel: "text-embedding-3-small",
	embeddingApiUrl: "https://api.openai.com/v1",
	embeddingApiKey,
});
```

Remote LLM:

```yaml
mnemopi:
   llmMode: remote
   llmBaseUrl: https://api.openai.com/v1
   llmApiKey: ${OPENAI_API_KEY}
   llmModel: gpt-4.1-mini
```

Equivalent constructor shapes:

```ts
new Mnemopi({ llm: { baseUrl, apiKey, model } });
new Mnemopi({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
```

Dynamic function LLM for rotating OAuth tokens:

```ts
new Mnemopi({
	llm: async (prompt, opts) => {
		const token = await getFreshOauthToken();
		return await completeWithPiAi(prompt, {
			token,
			maxTokens: opts?.maxTokens,
			temperature: opts?.temperature,
		});
	},
});
```

Managed memory-role LLM:

```yaml
mnemopi:
   llmMode: smol
```

The coding agent resolves the `memory` role and passes a dynamic completion function so every Mnemopi LLM call can fetch current provider credentials at call time and try the role's fallback candidates:

```ts
new Mnemopi({
	llm: async (prompt, opts) => completeMemoryRoleWithCurrentAuth(prompt, opts),
});
```

## Embedding downloads and unattended runs

With embeddings on (the default), the first run that needs a vector fetches up to two things: the first remember, the first recall, or a session start that finds stored memories without vectors. Nothing else in Mnemopi downloads or installs anything.

1. The fastembed runtime, when it does not resolve from the omp install (the compiled binary and the bundle never carry it): a `bun install` of the pinned fastembed and its dependencies into `~/.omp/cache/fastembed-runtime/<version key>` (about 270 MB of native assets across platforms, plus onnxruntime's own install step).
2. The model. The default `mnemopi.embeddingVariant: en` is `BAAI/bge-base-en-v1.5`, whose quantized ONNX files come from Hugging Face into `~/.omp/cache/fastembed`.

Both caches live under the home folder, so every bot on one home shares them: the first run that needs them pays, later runs reuse them with no network. That first load has no time limit, and the first-turn recall waits for it, so a cold cache on a slow or blocked network can hold the first turn of an unattended run. Stored memories are never lost to this: a memory saved while no model is available is kept without a vector and is re-embedded the next time the database opens with a working model.

Choose one for a bot:

| Config | A run fetches | Recall |
| --- | --- | --- |
| `mnemopi.noEmbeddings: true` | nothing: no worker, no install, no model | keyword (FTS) only |
| `mnemopi.allowModelDownload: false` | nothing: the cached model is used if both caches below are complete, otherwise embeddings are skipped and one warning is logged | vector plus keyword when cached, keyword only otherwise |
| defaults | the runtime and the model, on first use | vector plus keyword |

`allowModelDownload: false` checks the disk before it starts the embedding worker: fastembed must resolve (directly, or as `~/.omp/cache/fastembed-runtime/<version key>/node_modules/fastembed/package.json`) and every file of the model must exist under `~/.omp/cache/fastembed/Qdrant_bge-base-en-v1.5-onnx-Q/` (`model_optimized.onnx`, `tokenizer.json`, `tokenizer_config.json`, `config.json`, `special_tokens_map.json`). One gap: if fastembed resolves directly but its native library then fails to load, omp falls back to a runtime install that this setting does not stop.

Warm the cache once, with network, by running a normal hand session with `allowModelDownload` unset and embeddings on, saving one memory and asking one question, then leave it open until the files above exist (print mode stops its embedding worker about 1.5 seconds after the turn, which can cut a download short; the next attempt resumes it). Then set `allowModelDownload: false` in the bot configs.

## When Mnemopi cannot start

If opening the database throws (a database or folder that is not writable, a read-only `-wal` or `-shm` left by an earlier run, a locked file), the session runs with memory off. It does not do so silently:

- The cause is shown once at startup: a `Warning:` line on stderr in print and RPC modes (stdout stays clean for JSON and protocol frames) and a warning in the TUI. For example: `Mnemopi memory is off for this session. Startup failed: SQLiteError (SQLITE_IOERR_WRITE): disk I/O error; not writable: memories/mnemopi/mnemopi.db-wal; database: memories/mnemopi/mnemopi.db.`
- `retain`, `recall`, `reflect`, `memory_edit` and `learn`, and the backend status, search and save results, add the same cause after "Mnemopi backend is not initialised for this session." Task, structured-subagent and vibe children keep their parent's reason.
- Paths are relative to the agent folder, and only files that exist and are not writable are named: the database folder, the database, its `-wal` and its `-shm`. omp never changes a file mode and never retries; the next start tries again, and a successful one clears the reason.

SQLite gives an empty `-wal` the database's mode each time it opens one, so a read-only `-wal` blocks a start only when it holds data. After a run on a read-only database or folder, restoring the modes of the database and the folder is not enough while that `-wal` stays read-only: make `mnemopi.db-wal` and `mnemopi.db-shm` writable by the user that runs omp, then start again. Do not delete a `-wal` that has data: it holds committed rows (see "Backing up a database that is in use").

## Operational notes

- The default shared database lives under the agent memories directory in `mnemopi/mnemopi.db`; project-scoped banks use sibling database paths under that Mnemopi directory.
- `/memory clear` removes every scoped Mnemopi SQLite database and sidecar WAL/SHM files for the active configuration.
- `/memory enqueue` forces retention of the current session, flushes pending fact extractions, and runs Mnemopi sleep/consolidation for eligible working-memory rows.
- `/memory stats` and `/memory diagnose` render backend-specific bank statistics/diagnostics when the Mnemopi backend is active.
- Subagents do not own separate Mnemopi retain loops; they alias the parent state when a parent Mnemopi state exists, and otherwise remain inert.
- At primary backend startup, eligible working-memory rows are promoted across owned banks before the first write can TTL-trim them. Promotion failures are logged without disabling the backend.
- Consolidation links each new episodic summary to the newest 200 known memories in the episodic graph, not to the whole history, so session-start cost stays flat as a database ages (a year of 50 transcript rows a day started in about the same time as the first day). Memories older than the window are linked only by the links made while they were new. `mnemopi.graphLinkWindow` changes the window per config (`MNEMOPI_GRAPH_LINK_WINDOW` is the fallback when it is unset); `0` links against every memory again at a cost that grows with history.
- Every write also runs Mnemopi's working-memory trim, which never deletes unconsolidated rows. It promotes them to episodic memory with the same consolidation `sleep` uses, in batches: when a row passes the 24-hour TTL, every row `sleep` would take (older than half the TTL, 12 hours by default) is promoted together, so a long session consolidates in groups about every 12 hours; when more than the 1000-row working-memory limit is live, the oldest rows are promoted down to 90% of the limit. A session that stays open longer than the TTL therefore keeps its memories. A failed promotion is logged and retried on the next write.
- Two sessions creating the same bank database at the same moment both succeed: switching a new database to WAL needs an exclusive lock that SQLite refuses at once (it skips `busy_timeout`), so that switch retries on a busy answer with a backoff of about 1.3 s in total. Other errors are not retried.
- Backend startup is best-effort. If database/model initialization fails, the session continues with Mnemopi inert and logs a warning; memory tools then report that the backend is not initialized.
- Local embedding models load once per machine, not once per session: each (model, fastembed cache dir) pair is served by one detached `omp mnemopi embed <model>` server owning an IPC endpoint under `~/.omp/run/mnemopi/` (log beside it). The first omp process that needs it spawns it; others connect. Inference runs in the server's private `onnxruntime` child. The server exits after 15 minutes without a request, freeing the model's memory, and is replaced when an omp process of another version connects. A steady-state embed that takes longer than 2 minutes fails, and the server kills and respawns its inference child.

## Shutdown and durability

Normal interactive and print-mode exit uses a deliberately lighter path than `/memory enqueue`:

1. The primary state retains the current transcript with new fact extraction disabled.
2. It flushes extractions that were already in flight, but does not run per-session sleep or full cross-session promotion.
3. Only after that drain settles does it close the owned SQLite bank handles; the process drops its embedding-server connection after state disposal because the drain may still embed. The server keeps running for other sessions (and finishes a model download already in flight) until it idles out.

Aliased subagent states do not own or close the shared banks; the parent state owns final retention, flushing, and handle closure.

Interactive and print exits give this drain 1.5 seconds. If the budget expires, shutdown detaches the in-flight drain and arranges for handles to close when it settles rather than racing writes against closed databases. The process may exit first. Working-memory rows already written remain durable, but promotion or embedding for the last few turns can remain incomplete; earlier turn retention performed at agent end is unaffected.

`/memory enqueue` is the explicit stronger durability boundary: it forces retention, flushes pending extraction, and runs full sleep/consolidation across the owned banks. It does not bypass Mnemopi's age gate: `sleepAllSessions` selects unconsolidated working-memory rows older than `Math.floor(workingMemoryTtlHours / 2)` hours (12 hours with the default 24-hour TTL). Fresh rows therefore remain in working memory after an immediate enqueue. Use the command before exit to force retention and flush pending work, or after the age gate to promote eligible rows; normal shutdown does not promote them.

### Signals and unattended runs

On SIGTERM, SIGINT, SIGHUP or a fatal error the primary state retains the turns it has not retained yet **at the moment the signal lands**, through the process cleanup hook (`postmortem`), without fact extraction and with a 1.5 second SQLite lock wait. The write is synchronous and takes milliseconds. It does not wait behind the session's slower teardown steps (post-prompt drain up to 5 s, extension `session_shutdown` handlers up to 2 s, auto-learn drain up to 3 s, then the 1.5 second Mnemopi drain above), and it also covers a mode that never disposes its session on a signal (RPC). The dispose retention that follows adds only turns that arrived after the signal. From the moment a stop begins, automatic retention schedules no model-backed fact extraction, so a stop never starts a model call. Nothing of this runs when `mnemopi.autoRetain` is off.

What a hard kill still loses: SIGKILL (also an out-of-memory kill or power loss) runs no code. Everything since the last retain is gone: with `mnemopi.retainEveryNTurns = N`, up to N-1 completed user turns plus the running one. A print-mode (`-p`) run is one user turn, so its transcript is retained when the turn ends or when a stop signal arrives, never in between. Rows already written stay durable (SQLite WAL); embeddings and fact extraction still in flight are lost, and embeddings are rebuilt the next time the database opens.

Recommended stop sequence for an unattended runner: send SIGTERM to omp and its descendants, wait up to 10 seconds (omp's own cleanup deadline; retention itself finishes within milliseconds), then SIGKILL the process group. Set `mnemopi.retainEveryNTurns: 1` for multi-turn sessions to shrink the SIGKILL window.

### Backing up a database that is in use

Do not copy a live database with `cp`. Mnemopi runs SQLite in WAL mode, so committed rows sit in `mnemopi.db-wal` until a checkpoint: the main file alone can be missing almost everything (a probe with a busy writer had a 4 KB main file and a 156 MB `-wal`), and copying `db`, `-wal` and `-shm` one after the other can tear. `-shm` is only a rebuildable index; the main file and the `-wal` are one unit. A `.pre_e6_backup` beside the database is the one-time copy the triple-store migration made before it ran; it is an old-format snapshot, not part of the live set.

`mnemopi backup <destination.db>` writes one consistent, standalone file (no `-wal` or `-shm` to carry) while another process writes the database. It reads a single snapshot with `VACUUM INTO` (the writer is never blocked), checks the copy with `PRAGMA integrity_check`, refuses to overwrite an existing file, and leaves no partial file on failure. It backs up `$MNEMOPI_DATA_DIR/mnemopi.db`, like the other `mnemopi` subcommands. The compiled `omp` binary does not carry this CLI; from any program or shell the same call works against the file named by `mnemopi.dbPath`:

```sh
sqlite3 /path/to/mnemopi.db "VACUUM INTO '/path/to/backup.db'"
```

Restore by copying the backup to the new database path and deleting any `-wal` / `-shm` found there first: a leftover `-wal` from another database would be replayed into the restored file. Banks other than the shared one (`scoping: per-project` or `per-project-tagged`) are separate files under `<dbDir>/banks/`; back each up the same way, or set `mnemopi.scoping: "global"` so the whole memory is the one file.
