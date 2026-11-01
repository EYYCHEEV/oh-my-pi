# Changelog

## [Unreleased]

### Added

- Added `mnemopi backup <destination.db>` and `backupDatabase()`: a consistent, standalone single-file copy of a database another process is writing (`VACUUM INTO` of one snapshot, integrity-checked, never overwrites, no partial file on failure), instead of copying the main file and the `-wal` by hand
- Added the `beamConfig` option of `Mnemopi` and the `tier2Days` / `tier3Days` beam settings so one instance can set the episodic tier cut ages (`0` never cuts) instead of only the process-wide `MNEMOPI_TIER2_DAYS` / `MNEMOPI_TIER3_DAYS`; unset keeps the environment defaults
- Added the `graphLinkWindow` beam setting so one `Mnemopi` instance (`beamConfig`) sets how many of the newest memories a new episodic summary links against; unset keeps `MNEMOPI_GRAPH_LINK_WINDOW`
- Added the `embeddings.allowDownload` option of `Mnemopi`: `false` never installs fastembed or downloads model files; the local embedding model is used only when it is already on disk, otherwise embeddings are skipped (keyword recall only) and one warning is logged. Unset keeps the first-use install and download
- Added the `pruneConsolidatedDays` beam setting (`beamConfig`; unset or `0` is off) to bound a long-lived database: `sleep` and `sleepAllSessions` delete a working row that was summarized that many days ago, with its full-text entry, vector, annotations and graph nodes, and return `pruned: { status, pruned, reclaimed }`. Only consolidated, non-`IMPORTED` rows that a live episodic row lists in `summary_of` qualify; the summary and the facts extracted from the row stay. A run removes at most 5000 rows, and one that frees a quarter of the file (4 MiB or more) compacts it with `VACUUM`, which is safe while other processes read and write a WAL database

### Fixed

- Fixed the working-memory trim deleting unconsolidated rows: a session that stayed open past the 24-hour TTL, or wrote more than `workingMemoryLimit` rows, silently lost memories that consolidation had not reached yet. Trim now promotes those rows to episodic memory with the same pipeline as `sleep` instead of deleting them, in batches so a steady writer does not leave one tiny summary per write: when a row passes the TTL it promotes every row `sleep` would take (older than half the TTL), and on count overflow it promotes the oldest rows down to 90% of the limit. A failed promotion is rolled back and logged so the rows stay for the next write.
- Fixed a bank database created by two sessions at the same moment failing the loser with `database is locked`, which left that session memory-inert. Switching a new database to WAL needs an exclusive lock that SQLite refuses at once, ignoring `busy_timeout`, so the switch (`enablePragmas`, and the query cache's own database) now retries with a short backoff, about 1.3 s at most, before reporting the error. Only a busy answer is retried; any other error still throws.
- Fixed `memory_edit invalidate` and `forget` on a working row that `sleep` had already consolidated leaving its episodic summary, and the facts extracted from it, recallable. A summary that covered only that row is now expired (invalidate) or deleted (forget); a summary that also covers other rows is rewritten from their live text and the old one is retired or deleted, so unrelated memories keep their summary and facts; a summary that cannot be rewritten (a caller-supplied digest) is retired or deleted whole. Fact recall also hides facts whose episodic source summary is superseded or expired.
- Fixed recall previews showing the first 499 characters of a long row even when the query matched far past them, so the fact the query found was missing from the result. When the match lies past the head, the preview is now a window around the matched terms (with `…` on each cut side, within the same `contentPreviewChars` budget), preferring terms that are rare in that row; a match in the head keeps the head preview. `clipRecallContent` accepts the query term groups as an optional third argument.
- Fixed vector recall reaching only the newest 500 rows of each memory tier: a memory whose embedding matched the query exactly was missed once more than 500 newer rows existed, and only a keyword could find it. The vector pass now compares the newest 5000 rows per tier, which bounds a recall at about 190 ms per tier with 768-dimension embeddings (about 100 ms at 384).
- Fixed consolidation, and with it session start, getting slower as a database aged: the episodic graph linked every new summary against every known memory (reading and tokenizing all their text), so a year of history cost seconds per start and the edge count grew quadratically. A new memory now links to the newest 200 known memories; `MNEMOPI_GRAPH_LINK_WINDOW` changes the window and `0` restores linking against everything, and `ingestMemory` takes a per-call `linkWindow`
- Fixed `forget` leaving the forgotten text recallable through retained session transcripts. The coding-agent retains the transcript of the session that stored a memory and of any later session whose recall showed it, so after `forget` a fresh recall still returned the text from those rows. `forget` now replaces the exact text with `[forgotten]` in the `content` and `embed_text` of every transcript row (`source = 'coding-agent-transcript'`) and keeps the rest of each row. Only whole occurrences are cut (a non-word character or the edge of the text on both sides), so `password` is cut out of a row but `passwords` is left alone, and a text shorter than 8 characters is not scrubbed from transcripts at all: `forgetDetailed` reports it and one warning names the memory id, never its text. It drops the facts, memoria rows, graph links and vector extracted from a scrubbed row's old text (annotations stay) and re-embeds the row after the commit, and it rewrites the summaries `sleep` built from scrubbed rows from their scrubbed text, deleting the old summary and its facts. A retired or caller-written summary of a scrubbed row is deleted whole. The full-text indexes follow through their triggers. `invalidate` keeps history and does not touch transcripts. Added `Mnemopi.forgetDetailed(id)` and `Mnemopi.scrubForgottenText(text)` to scrub another bank without deleting a memory.
- Fixed `forget` still leaving the forgotten text recallable when a retained transcript quoted it another way, or was retained after the forget. A recall shows what the fact extractor made of a memory, in the extractor's wording, and the transcript of a recall session quotes that, so `forget` now also cuts the facts' wording out of transcripts, and finds a quote by word windows instead of exact text: another case or punctuation, the AAAK compaction of a summary (`and` became `+`), or a partial quote of five consecutive words or more (a text under 8 characters, one word, or only numbers has no windows). It keeps the windows as salted hashes, never as text, in `forget_tombstones` (newest 50 000 per bank, `MNEMOPI_FORGET_TOMBSTONE_LIMIT`), and a transcript retained afterwards (`remember` with source `coding-agent-transcript`) is cut by them before it is stored, embedded or mined for facts, so the transcript of the session that forgot a memory cannot keep it. A `sleep` summary of transcripts whose rows `pruneConsolidatedDays` deleted is cut in place (`rewriteSleepSummary`), and the facts of pruned rows that quote the text are deleted, so pruning no longer keeps a quote out of reach. `ForgetOutcome` gains `forgottenTexts`, and `Mnemopi.scrubForgottenText(text)` is now `scrubForgottenTexts(texts)`, which also records the tombstones in the other banks of a session
- Fixed `forget` leaving the forgotten text in the database files. SQLite keeps what a delete frees in the free space of the main file, in the write-ahead log until a checkpoint, and in the segments of a full-text index, so anything that opened `mnemopi.db` and `mnemopi.db-wal` (or a copy of them) could still read a forgotten memory, its facts and the transcripts that quoted it, although no query returned them. Every pragma'd connection now sets `PRAGMA secure_delete=ON` (the build default is FAST or OFF). While a forget (or a `scrubForgottenTexts` that rewrites rows) deletes, the three full-text indexes get the FTS5 `secure-delete` option, put back with the same commit, because a secure full-text delete rewrites segment pages and left on it made a 5000-row prune about 30 times slower; an SQLite whose FTS5 refuses the option gets an `optimize` merge of each index after the forget instead. The forget then ends with `PRAGMA wal_checkpoint(TRUNCATE)`, which waits at most 200 ms for readers. A checkpoint a reader blocks is recorded in the new `forget_checkpoint_pending` table and finished by the next open, `sleep` or close of the bank, in any process. Bytes that earlier non-secure deletes left in the free space of an existing file stay until a `VACUUM`.
## [18.14.2] - 2026-10-31

### Fixed

- Fixed heuristic episodic facts storing word fragments (`Drafting is active.` → `ctive`), truncated multiword objects, or nothing for `has an …` sentences ([#17511](https://github.com/can1357/oh-my-pi/issues/17511))

## [18.13.3] - 2026-10-28

### Changed

- Updated Bun engine requirement to ≥1.4.4

## [18.13.2] - 2026-10-27

### Fixed

- Fixed local embeddings using one spinning CPU thread per core, so a single recall query cost several CPU-seconds on a many-core machine ([#17109](https://github.com/can1357/oh-my-pi/pull/17109) by [@sjawhar](https://github.com/sjawhar))

## [18.13.0] - 2026-10-26

### Fixed

- Fixed polyphonic recall's graph voice finding no memories for non-English names (e.g. `Hà Nội`) or names of three or more words, and Vietnamese words like `tôi` being stored as the participant `i` ([#16723](https://github.com/can1357/oh-my-pi/issues/16723))

## [18.12.4] - 2026-10-20

### Fixed

- Fixed background fact extraction storing only the first 5 facts of a plain-line extractor answer; it now keeps up to 20, matching JSON answers ([#16377](https://github.com/can1357/oh-my-pi/pull/16377) by [@alphastorm](https://github.com/alphastorm))

## [18.11.2] - 2026-10-16

### Fixed

- Fixed `MNEMOPI_<LABEL>_WEIGHT` and `MNEMOPI_TIER<N>_WEIGHT` having no effect on recall ranking ([#13824](https://github.com/can1357/oh-my-pi/pull/13824) by [@sjawhar](https://github.com/sjawhar))

## [18.11.1] - 2026-10-15

### Fixed

- Fixed a failing `mnemopi` CLI command or MCP memory call dropping the embeddings of memories it had just stored ([#15804](https://github.com/can1357/oh-my-pi/pull/15804) by [@yuzu-octopus](https://github.com/yuzu-octopus))

## [18.11.0] - 2026-10-14

### Fixed

- Fixed polyphonic recall ranking unrelated memories above relevant ones when the query shared only a common word such as "that" with an extracted fact subject ([#15512](https://github.com/can1357/oh-my-pi/issues/15512)).

## [18.9.0] - 2026-10-11

### Added

- Exported `clipRecallContent` for applications that need to format content consistently with Mnemopi recall previews.

### Fixed

- Fixed memory-save performance degradation and excessive memory-database growth when date-related terms such as “today” appeared in otherwise unrelated memories.

## [18.8.8] - 2026-10-10

### Fixed

- Fixed long retained transcripts exhausting local memory extraction models by limiting each extraction input to 8192 characters while keeping the opening context and newest turns ([#14956](https://github.com/can1357/oh-my-pi/issues/14956)).

## [18.8.7] - 2026-10-09

### Fixed

- Fixed proactive linking freezing the host for seconds per stored memory on large banks; a memory's graph links are now written in one commit instead of one per link ([#14998](https://github.com/can1357/oh-my-pi/issues/14998)).

## [18.8.5] - 2026-10-08

### Fixed

- Fixed new memories gaining graph links (`related_to`, `references`, `ctx`) to memories that were already invalidated, superseded, or expired; proactive linking and consolidation now link only to memories recall can still return, so the graph stops growing toward retired memories ([#14427](https://github.com/can1357/oh-my-pi/pull/14427) by [@tickernelz](https://github.com/tickernelz)).

## [18.5.1] - 2026-10-03

### Changed

- Upgraded local embedding support to fastembed 3.0.0. Models now download from Hugging Face into the updated cache layout, with interrupted downloads resuming automatically; existing models are migrated on first use while producing the same vectors.

### Fixed

- Fixed enhanced recall returning cached results from an unrelated longer query when answering a shorter query.
- Fixed local embedding setup on fresh caches and Linux ARM64, including compatibility with current model downloads and ARM64 tokenization support.

## [18.4.4] - 2026-09-29

### Added

- Added per-instance `polyphonicRecall` and `enhancedRecall` options to `Mnemopi` and `BeamMemory`, so memories opened side by side can use different recall policies; `configureRecallFeatures` remains the process-wide default and the env vars still win

### Fixed

- Fixed `MNEMOPI_POLYPHONIC_RECALL` / `polyphonicRecall` having no effect: `recallEnhanced` now fuses its ranking with the vector, graph, fact and temporal voices, and extracted subject/predicate/object facts are consolidated so the fact voice has data ([#2323](https://github.com/can1357/oh-my-pi/issues/2323))
- Fixed `MNEMOPI_ENHANCED_RECALL` / `enhancedRecall` having no effect: `recallEnhanced` now caches results, keyed on every recall option so a different limit, fact inclusion, channel, query time or bank never reuses another call's ranking, and any database write clears it ([#2323](https://github.com/can1357/oh-my-pi/issues/2323))
- Fixed polyphonic recall's graph voice taking seconds on densely linked banks (`proactiveLinking`): it now walks from at most 16 seeds in one batched edge query per hop and reports at most 64 memories, and `recallEnhanced` no longer drops rows below `topK` to a token budget
- Fixed a failed `consolidated_facts` backfill never being retried; backfill and fact consolidation failures are now logged

## [18.4.1] - 2026-09-28

### Fixed

- Fixed extracted facts still being recalled after their source memory was invalidated or expired. ([#12825](https://github.com/can1357/oh-my-pi/pull/12825) by [@Jpei1994](https://github.com/Jpei1994))

## [18.3.3] - 2026-09-27

### Fixed

- Fixed recall search matching query terms inside unrelated words, improving result relevance and ensuring exact matches are prioritized.
- Fixed sleep summaries replacing shortened terms within larger words, preventing unintended word corruption.

## [18.2.5] - 2026-09-17

### Fixed

- Improved SQLite vector search and import performance by reducing repeated database metadata checks.

## [18.2.1] - 2026-09-15

### Fixed

- Fixed an explicitly invalidated memory still being returned by an identical repeat query until the recall cache expired.
- Fixed recall continuing to serve a stale, pre-embedding ranking for up to an hour after background embeddings finished, when the enhanced recall cache is enabled.

## [18.0.11] - 2026-08-29

### Fixed

- Fixed working-memory recall returning too few or no results after matching memories were invalidated.

## [18.0.9] - 2026-08-28

### Fixed

- Fixed working-memory search returning too few or no results when the most relevant matches had been superseded, ensuring valid older entries are still returned.

## [18.0.0] - 2026-08-22

### Fixed

- Fixed false-positive location extraction in episodic gists by properly enforcing capitalization constraints for proper nouns.
- Improved episodic gist participant extraction with Unicode support to properly capture names in non-Latin scripts (e.g., Cyrillic, Greek).

## [17.3.8] - 2026-08-19

### Added

- Added optional task metadata to the runtime LLM completion interface so hosts can tell an extraction call from a consolidation call and choose the matching prompt

## [17.3.5] - 2026-08-16

### Fixed

- Fixed an issue where transient provider failures (such as Anthropic overload or rate limit errors) were incorrectly treated as empty responses; these failures are now retried automatically before falling back.

## [17.3.4] - 2026-08-14

### Fixed

- Fixed `recall()` silently dropping `scope='global'` rows whenever a `channelId` filter was active: `buildWhere()` appended a redundant hard `channel_id = ?` clause on top of the `(session_id = ? OR scope = 'global' OR channel_id = ?)` visibility clause, so global rows whose `channel_id` didn't match (e.g. imported rows with `channel_id NULL`) were excluded. Channel isolation is preserved by the visibility clause alone. This made imported/global episodic memory permanently unrecallable through callers that always pass a channel (such as the coding-agent memory backend). ([#8525](https://github.com/can1357/oh-my-pi/issues/8525))

## [17.2.11] - 2026-08-07

### Fixed

- Fixed an issue where an interrupted local embedding model download could permanently corrupt the cache and silently disable semantic recall. The system now automatically detects incomplete model files, clears the corrupted cache, and retries the download.

## [17.2.10] - 2026-08-06

### Changed

- Updated internal LRU cache implementation.

## [17.2.6] - 2026-08-03

### Added

- Added opt-in SQLite page-size configuration for file-backed databases, configurable via the `MNEMOPI_DB_PAGE_SIZE` environment variable or the `pageSize` option in `openDatabase`. Existing databases retain their original page size.

## [17.2.3] - 2026-08-01

### Fixed

- Stripped `<think>…</think>` reasoning blocks from remote LLM output in `cleanOutput`, so reasoning-model responses no longer leak into consolidated memories or corrupt fact extraction (the reasoning wrapper previously survived parsing and every stored fact became reasoning prose). ([#7231](https://github.com/can1357/oh-my-pi/issues/7231))

## [17.2.2] - 2026-07-31

### Fixed

- Fixed a resource leak where SQLite prepared statements were not properly released, keeping the database connection alive after calling close(). This resolves file locking issues on Windows (which prevented deleting, moving, or rotating database files) and silent file handle leaks on POSIX systems.

## [17.0.8] - 2026-07-22

### Changed

- Optimized vector operations (exact vector-index search, SHMR similarity clustering, and default-similarity MMR rerank) by migrating hot loops to native batch kernels, resulting in significant performance improvements (up to 1.8x faster top-K search, 2.4x faster pairwise clustering, and 22-36x faster MMR reranking).

## [17.0.4] - 2026-07-18

### Fixed

- Fixed a corrupt cached embedding model (truncated `model_optimized.onnx`, `Protobuf parsing failed` on load) permanently disabling local embeddings: init now quarantines the broken cache file (rename to `*.corrupt-<ts>`, only when the path resolves inside the fastembed cache directory) and retries once so the model re-downloads.

## [17.0.1] - 2026-07-16

### Fixed

- Fixed working-memory TTL trim silently deleting restored or imported durable rows: rows keeping `consolidated_at = NULL` with an old `timestamp` are no longer trimmed when flagged `IMPORTED`, `importFromDict` stamps imported rows as consolidated, and every working-memory delete path (trim, `forgetWorking`, force-import overwrite) now cascades linked annotations, embeddings, facts, memoria projections, gists, and graph edges instead of leaving orphans. ([#4819](https://github.com/can1357/oh-my-pi/issues/4819))
- Fixed Mnemopi local embeddings on Windows loading an unrelated `onnxruntime.dll` from the inherited system path instead of fastembed's cached ORT runtime. ([#4849](https://github.com/can1357/oh-my-pi/issues/4849))

## [16.3.9] - 2026-07-06

### Fixed

- Fixed extractor JSON parsing to correctly unwrap object-shaped facts, instructions, preferences, and timeline items from known text fields instead of persisting literal `[object Object]` rows.

## [16.3.7] - 2026-07-05

### Added

- Added `RecallOptions.contentPreviewChars` to allow customizing or disabling the content preview cap (default is 500, set to 0 for full content).
- Added `RecallResult.truncated` and `RecallResult.full_length` properties to easily identify clipped previews without parsing trailing markers.

### Fixed

- Fixed background LLM fact extraction to preserve specific extractor categories (`instructions`, `preferences`, `timelines`, and `kg` triples) in MEMORIA tables and graph triples instead of flattening them into generic `fact/entity` rows.
- Improved recall previews and `factLine` context to append a trailing ellipsis (`…`) when content is clipped, preventing mid-word truncation without a marker.

## [16.3.5] - 2026-07-04

### Fixed

- Fixed `remember(..., { embedText })` so hosts can store full transcripts while embedding, FTS-indexing, and rebuild-reembedding a marker-free projection. ([#4395](https://github.com/can1357/oh-my-pi/issues/4395))

## [16.2.2] - 2026-06-27

### Fixed

- Improved resilience during API extraction calls by enhancing the handling of rate limits and transient errors.

## [16.1.17] - 2026-06-24

### Fixed

- Fixed `remember(..., { extract: true })` fact/entity extraction accepting an `extractText` override so hosts can store full transcripts while mining facts from a safer projection; also tightened deterministic `Instruction:` extraction to require an explicit `I`/`you` subject instead of treating every `always`/`never` clause as a user instruction. ([#3372](https://github.com/can1357/oh-my-pi/issues/3372))

## [16.1.8] - 2026-06-20

### Fixed

- Capped per-input length in `embed()` at `MNEMOPI_EMBEDDING_MAX_INPUT_CHARS` (default 8192 chars, override via the env var or `embeddings.maxInputChars` runtime option; `0` disables) so a long retention transcript can no longer overflow the embedding model's context window. Oversized inputs are clipped with a head/tail split so chronological transcripts keep both the opening setup and the most recent turns instead of losing the latest content under a naive prefix slice. llama.cpp's `/embeddings` server used to reject the request with `request (N tokens) exceeds the available context size`, silently dropping vector recall for that memory ([#3126](https://github.com/can1357/oh-my-pi/issues/3126)).
- Fixed the proactive-linking write path ignoring host configuration: `proactiveLinkIfEnabled` read `MNEMOPI_PROACTIVE_LINKING` directly, so a host that enabled proactive linking through `configureRecallFeatures()` had no effect unless the environment variable was also set. `proactiveLinking` is now a `RecallFeatureFlags` option resolved through a `proactiveLinkingEnabled()` fallback, matching the existing polyphonic and enhanced recall flags, with the `MNEMOPI_PROACTIVE_LINKING` environment variable still taking precedence whenever it is set. ([#2440](https://github.com/can1357/oh-my-pi/issues/2440))

## [16.1.3] - 2026-06-19

### Added

- Exposed `setLocalModelInitializer` (and the `LocalEmbeddingModel`, `LocalModelInitializer`, `LocalModelInitOptions`, `StandardEmbeddingModel` types) so hosts can route fastembed loads through a dedicated subprocess and keep `onnxruntime-node`'s NAPI constructor + finalizer out of their own address space. Same wipe semantics as the existing `setLocalModelInitializerForTests` seam; the agent CLI uses it to crash-proof Windows when `memory.backend: mnemopi` is enabled ([#3031](https://github.com/can1357/oh-my-pi/issues/3031)).

### Fixed

- Fixed background fact extraction skipping runtime-configured remote LLM endpoints when `MNEMOPI_LLM_BASE_URL` was unset, so `remember(..., { extract: true })` now stores remote-distilled facts from `mnemopi.llm` config instead of falling back to regex heuristics. ([#3041](https://github.com/can1357/oh-my-pi/issues/3041))
- Fixed local fastembed startup on macOS ARM64 by letting `fastembed@2.1.0` install its matching `onnxruntime-node@1.21.0` native runtime instead of forcing `1.26.0`, and by repairing missing tokenizer sidecars from the upstream Hugging Face model cache when a stale fastembed archive lacks them. ([#3054](https://github.com/can1357/oh-my-pi/issues/3054))

## [16.0.6] - 2026-06-18

### Fixed

- Forced the on-demand fastembed runtime install to override fastembed's archived `onnxruntime-node@1.21.0` transitive pin with Mnemopi's `onnxruntime-node@1.26.0` pin, fixing local embedding startup on macOS ARM64. ([#2920](https://github.com/can1357/oh-my-pi/issues/2920))

### Changed

- Updated OpenRouter request headers to use standard shared headers from the pi-ai package

## [16.0.5] - 2026-06-17

### Fixed

- Capped `sleep_consolidation` episodic rows at `maxEpisodeChars` (default 100KB, `MNEMOPI_MAX_EPISODE_CHARS`) so raw session transcripts cannot be stored and extracted as multi-megabyte episodes. ([#2869](https://github.com/can1357/oh-my-pi/issues/2869))
- Skipped regex-only entity and pattern fact extraction for oversized raw transcripts so progress/log noise cannot flood MEMORIA with junk facts. ([#2868](https://github.com/can1357/oh-my-pi/issues/2868))

## [15.13.1] - 2026-06-15

### Added

- Added a wipe-and-rebuild reconcile (`reconcileEmbeddingModel`) that runs when the configured embedding model changes. At store open, if the model stamped on stored `memory_embeddings` rows differs from the active `currentEmbeddingModel()`, the stale embeddings and their binary vectors are dropped and every existing memory is enqueued for background re-embedding (in bounded batches) at the new model/dimension. The destructive wipe is skipped whenever it could not be rebuilt — embeddings disabled via the runtime option or the `MNEMOPI_NO_EMBEDDINGS` env, an unresolved (empty) active model, or a read-only open (`reconcile: false`, used by ephemeral stats readers that would exit before the async rebuild finished) — so a stale-but-valid corpus is never destroyed without a replacement. Recall degrades gracefully (FTS-only) for memories whose vectors are not yet rebuilt ([#2476](https://github.com/can1357/oh-my-pi/issues/2476))

### Fixed

- Normalized enhanced recall fact scoring against lexical coverage so high-confidence facts that only match generic query tokens no longer outrank exact working-memory hits. ([#2441](https://github.com/can1357/oh-my-pi/issues/2441))

## [15.12.4] - 2026-06-13

### Fixed

- Fixed `consolidateToEpisodic` (the function backing `sleep` / `sleepAllSessions`) never populating the episodic graph: the `gists` and `graph_edges` tables stayed at 0 rows across every bank even after multiple consolidation cycles, so Polyphonic Recall's `graph` voice (BFS over `findGistsByParticipant` / `findRelatedMemories`) always returned nothing. Consolidation now best-effort ingests the new episodic memory into `EpisodicGraph` so the gist row, gist→memory `ctx` edge, fact edges, and cross-memory similarity/entity/temporal edges land alongside the episodic row. Independent of the existing `MNEMOPI_PROACTIVE_LINKING` flag, which still gates the same enrichment on the `remember()` write path. ([#2435](https://github.com/can1357/oh-my-pi/issues/2435))

## [15.12.0] - 2026-06-12

### Changed

- Moved `fastembed` and `onnxruntime-node` from `dependencies` to optional `peerDependencies` pinned to exact versions. When the peers are absent (bundled CLI, compiled binary, or installs that skip optional peers), the local embedding path `bun install`s the pinned pair into `~/.omp/cache/fastembed-runtime/<version-key>` on first use and loads fastembed from there — restoring local embeddings in bundled distributions and removing ~270MB of eager native downloads from default installs ([#2389](https://github.com/can1357/oh-my-pi/issues/2389))

## [15.11.4] - 2026-06-12

### Added

- Added `configureRecallFeatures()` (exported from the package root, `core`, and `config`) so hosts can enable the polyphonic recall engine and the enhanced recall query cache programmatically. `polyphonicRecallEnabled()`, `enhancedRecallEnabled()`, and `isEnhancedRecallEnabled()` now fall back to these configured defaults, with the `MNEMOPI_POLYPHONIC_RECALL` / `MNEMOPI_ENHANCED_RECALL` environment variables still taking precedence whenever they are set. ([#2323](https://github.com/can1357/oh-my-pi/issues/2323))

### Fixed

- Fixed the embedding pipeline's silent `catch {}` blocks (`runEmbedding()`, `getLocalModel()`, and the local-model path of `embed()`) swallowing failures with zero diagnostics. These best-effort paths still degrade gracefully (return `null` / skip the write), but now emit structured `logger.debug` entries with the error and per-site context (item count, model name). The `mnemopi.debug` config flag now propagates into the core library via runtime options (`MnemopiOptions.debug` → `ResolvedMnemopiRuntimeOptions.debug`) and escalates these logs to `warn` so they surface at the default log level. ([#2322](https://github.com/can1357/oh-my-pi/issues/2322))

### Changed

- Extraction, embedding, and remote-LLM clients now accept an `ApiKey` (static string or resolver) and resolve it per request through `withAuth`, so 401s force-refresh and rotate credentials via the central auth-retry policy instead of failing with a stale key. Empty-key setups (local/proxy endpoints without `Authorization`) and pinned literal keys behave exactly as before.
- Embedding and remote-LLM 401 errors now throw pi-ai's typed `ProviderHttpError` instead of `Object.assign`-patched `Error`s, keeping the same structural `.status` contract for the auth-retry classifier.
- SHMR consolidation clustering (`core/shmr`) now uses the real embedding provider when one is configured instead of always hashing: `embed()`, the new `embedBatch()`, `clusterBySimilarity()`, `computeHarmonyScore()`, `harmonize()`, and `recallBeliefs()` are now async, batch-embed candidate texts in a single provider call, and reuse precomputed vectors from `memory_embeddings` for episodic candidates. The SHA1 bag-of-words hash remains as the deterministic fallback when no provider is available or embedding fails. ([#2324](https://github.com/can1357/oh-my-pi/issues/2324))

## [15.10.12] - 2026-06-10

### Changed

- Reworked the in-memory fallback vector search to build a normalized exact vector index per query, matching the shape needed for future quantized or TurboVec-style backends without adding a new dependency yet.

## [15.10.11] - 2026-06-10

### Fixed

- Fixed embedding provider detection to match `openrouter` by URL host, so custom embedding endpoints are now recognized correctly instead of being misclassified by substring matching
- Fixed the check for OpenRouter base URLs so only true `openrouter` hosts are treated as non-custom

## [15.10.8] - 2026-06-09

### Added

- Added a `fetch` option to `ExtractionClient` to inject a custom fetch implementation for remote LLM requests
- Added an optional `fetch` option to `extractFacts` to control the transport used for remote extraction calls
- Added support for passing a custom `fetch` implementation through `complete` and `summarizeMemories` via remote LLM options

## [15.9.1] - 2026-06-04

### Breaking Changes

- Changed `Mnemopi.recall()`, `Mnemopi.recallEnhanced()`, `Mnemopi.search()`, `Mnemopi.query()`, the module-level `recall`/`recallEnhanced`/`search`/`query` exports, the `BeamMemory.recall`/`recallEnhanced` methods, the free `recall`/`recallEnhanced` functions in `core/beam/recall`, and `orchestrateRecall` to return `Promise<RecallResult[]>` so the recall pipeline can auto-derive `queryEmbedding` from the query text via `embedQuery`. Callers must `await` recall calls; pass `queryEmbedding: null` to opt out of auto-embedding and stay on FTS-only.
- Changed the MCP entrypoints `handleToolCall`, `callToolJson`, and `handleJsonRpc` in `mcp-server`/`mcp-tools` to async so the recall/shared-recall handlers can await the new `Promise<ToolResult[]>` shape; external MCP transports must `await` these.

### Fixed

- Fixed `memory_embeddings` never being populated by the production `remember`/`rememberBatch`/`updateWorking`/`consolidateToEpisodic` paths; embedding generation is now scheduled as a background task on `beam.pendingExtractions` (mirroring `scheduleFactExtraction`), so configured providers (fastembed, OpenAI-compatible API, custom) actually run and rows land in `memory_embeddings(memory_id, embedding_json, model)`. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832))
- Fixed `recall()`/`recallEnhanced()` never deriving a query embedding from the query text, which silently degraded every deployment to FTS-only regardless of provider configuration. The recall pipeline now auto-calls `embedQuery(query)` when `options.queryEmbedding` is undefined; pass `null` to keep the old FTS-only behaviour. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832))
- Fixed `toRecallOptions` dropping `queryEmbedding` between the `Mnemopi` facade and the beam layer, so callers can now explicitly pin or disable the query vector through the public API.
- Fixed `withMemory` (CLI) and `withBeam`/`withSharedBeam` (MCP) closing the SQLite handle before background fact-extraction and embedding tasks finished, so short-lived `mnemopi store`/`mnemopi sleep` and MCP `remember`/`update` paths now drain `flushExtractions` before close instead of silently dropping `memory_embeddings` rows. CLI handlers and MCP `handleRemember`/`handleUpdate`/`handleSleep`/etc. are async as a result. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832), follow-up to [#1833](https://github.com/can1357/oh-my-pi/pull/1833) review)
- Fixed the process-wide `embedQuery()` cache in `core/embeddings.ts` keying by query text alone, which let two `Mnemopi` instances in the same process with different providers/models cross-contaminate their `dense_score` rankings. The cache key now includes a WeakMap-assigned provider identity, the resolved model name, and the configured `apiUrl`, so disjoint runtimes never read each other's cached vectors. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832), follow-up to [#1833](https://github.com/can1357/oh-my-pi/pull/1833) review)

## [15.7.4] - 2026-05-31

### Fixed

- Fixed the `darwin-x64` release build failing in `bun build --compile` because the Windows ORT 1.24 preload pulled `onnxruntime-node` into the static graph and there is no `darwin/x64` prebuilt for that line. The preload is now guarded behind a `process.platform === "win32"` literal that Bun dead-code-eliminates on non-Windows targets; macOS/Linux load fastembed's bundled ORT 1.21 binding as before.

## [15.7.3] - 2026-05-31

### Changed

- Changed embedding result normalization to return `Float32Array` vectors so `embed` and `embedQuery` now cache and emit float32 rows
- Changed the embedding provider contract to a single typed `EmbeddingOutput` (`AsyncIterable<number[][]>`) instead of `unknown`, matching fastembed's `embed()`, so `EmbeddingProvider.embed` and the `provider` runtime option stream the embedding matrix as async batches (`async *embed(texts) { yield texts.map(embedOne); }`)
- Changed local model cache directory resolution for `fastembed` to use `getFastembedCacheDir` instead of the hard-coded `~/.hermes/cache/fastembed` path

### Fixed

- Fixed cosine similarity behavior across retrieval, clustering, and caching to consistently handle mismatched vector lengths as zero-padded and ignore non-finite values
- Fixed embedding API requests to retry transient failures with backoff via shared retry logic before returning null
- Fixed compiled `omp` binaries losing local Mnemopi embeddings by keeping `fastembed` and `onnxruntime-node` reachable to Bun's static compiler while preserving lazy runtime loading.

## [15.7.2] - 2026-05-31

### Fixed

- Fixed Windows startup crashes by keeping fastembed's older ONNX Runtime binding lazy until local embeddings are used.
- Fixed a segfault at startup from eagerly loading fastembed: importing the embeddings module pulled in `fastembed`, which eagerly loads the `onnxruntime-node` native addon. The import is now deferred until a local fastembed model is actually initialized, so API-model, disabled-embeddings, and test runtimes never load the native addon.

## [15.6.0] - 2026-05-30

### Added

- Added `llm.extractionPrompt` runtime option to override the fact-extraction prompt template using `{text}` and `{lang}` placeholders
- Added `llm.consolidationPrompt` runtime option to override the consolidation sleep prompt template using `{memories}`, `{source}`, and `{memory_count}` placeholders
- Published `@oh-my-pi/pi-mnemopi` to npm: the local SQLite memory engine is now built, checked, tested, and released through the monorepo CI pipeline alongside the other workspace packages.
- Exported the diagnostic inspector as the `@oh-my-pi/pi-mnemopi/diagnose` subpath for coding-agent memory maintenance commands.
- Added `flushExtractions()` (on `Mnemopi`, `BeamMemory`, and as a module-level export) to drain in-flight background fact extraction; used by tests and graceful shutdown so facts are persisted before the database closes.

### Changed

- Changed fact extraction to prefer a configured runtime LLM completion path before host extraction, with automatic fallback when the configured completion returns no output or fails

### Fixed

- Fixed `rememberBatch(..., { extract: true })` to run background fact extraction for batch uploads (including per-item `extract` flags) so extracted facts are generated and recallable after extraction
- Fixed `extract: true` fact extraction to continue safely when no LLM is configured by turning extraction failures into no-op background tasks
- Fixed configured LLM fact extraction by using temperature 0 so re-ingesting the same text is deterministic and avoids near-duplicate extractions
- Fixed `remember(..., { extract: true })` silently dropping the flag: it now schedules the LLM fact extractor (`extractFactsSafe`) over the stored content and persists the extracted facts so they become recallable. Previously the LLM extractor had no production callers and `extract` was dead.
