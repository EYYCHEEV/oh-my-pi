# OMP Safe Context Admission

## Current Follow-up
The original source-only work below was accepted on 2026-09-08.
On 2026-09-16, the operator separately authorized finalizing the late prepared-budget recovery patch, merging published fork changes, and upgrading to pinned v18.2.1 with the managed updater.
That approval covers scoped commits, protected verification, managed installation, fork-only publication, and documented updater-owned cleanup.
The original no-install/no-commit constraints below describe the earlier source-only phase, not this approved upgrade.

## Objective
Prevent automatic requests from knowingly exceeding the configured usable-input budget while preserving asynchronous compaction and recoverable sessions.
Recognize the local gate's input-only overflow rejection and recover through OMP's existing compaction and chunked-summary paths.

## Scope
Share usable-input budget resolution across compaction scheduling, speculative deferral, and retry eligibility.
Keep maintenance before request construction, rebuild after maintenance, and do not repeatedly send an unchanged oversized request.
Recognize the exact input-only gate diagnostic without treating unrelated HTTP 400 or image-limit failures as token overflow.
Update the existing workstation-owned fork contracts and affected package changelogs.

## Constraints
Work in the local oh-my-pi checkout and preserve unrelated work in both repositories.
Keep contextWindow 272384, maxTokens 65536, and the provider gate's 206848 input ceiling unchanged.
Keep native image limiting unchanged: stronk-ai already inherits the five-image fallback.
Do not add image settings, image transforms, catalog limits, or provider policy tables.
No remote edits, runtime installation, deployment, package installation, commits, publication, or destructive Git operations.
Do not bypass Sentinel or change its policy/assets; the operator confirmed restoration and local commands succeeded on resume.
Preserve pending input, tool-call/result pairing, cancellation, model switching, valid speculative summaries, and saved session history.
Handler implementation is out of scope; its independent whole-upgrade gate is not a source-task acceptance criterion.
The operator authorized a maximum of five review-fix rounds, preferring fewer; batch the four reproduced defects into one correction checkpoint.
Local token estimates remain approximate; neither zero provider rejections nor a fixed recovery-attempt count is promised.

## Evidence
The Mac mini incident log shows speculative deferral at 207301 estimated context tokens, followed by the input-only gate HTTP 400.
The last successful prompt used 206291 tokens and its response added 571, for 206862 total occupancy.
Current retry-fit budgeting respects contextWindow minus the effective reserve, yielding 206848 here.
The speculative grace ceiling instead permits 232704, contradicting retry-fit budgeting.
The Mac mini patch adds the narrow input-only diagnostic to the classifier and one regression test; the local checkout lacks it.
The existing summarizer already partitions oversized histories and shrinks rejected chunks, so permanent unrecoverability is not established.

## Design
The existing agent compaction module owns usable-input budget calculation; session maintenance consumes that budget rather than duplicating its formula.
Keep the early compaction trigger distinct from the usable-input ceiling; speculative grace may pass an early trigger only while below that ceiling.
The agent loop owns the prepared model and passes it to admission; session maintenance must use its matching tokenizer.
Session statistics owns provider occupancy, output inclusion, signed orchestration deductions, history-rewrite corrections, and compaction epochs.
Admission uses real usage anchors, not UI-only snapshots that already include pending input; prepared growth is added once.
The gate remains read-only; a budget refusal uses the existing thrown-error path to produce a balanced terminal error for all consumers.
The session may claim one boundary-owned recovery for growth introduced during request preparation, rebuild after maintenance, and otherwise settle the exact refusal without replaying unchanged oversized input.
Agent owns a single run-preparation pass before input append or continuation recovery; host lifecycle commits wait until every preparation and model validation succeeds.
Both ordinary compaction and notebook rollover must carry the same continuation ownership through dispatch and settlement.
Invalidate the conversion module's append-only array memo when mid-run compaction splices a rewritten prefix into the live array.
Summarization retains its own output/instruction reserves and adaptive chunking; do not confuse its request shape with a normal inference request.
Keep exact text recognition in the existing error classifier and inspect structured input-overflow codes where existing transport plumbing preserves them.
Run design-pressure before implementation and re-enter only for evidenced ownership or lifecycle mismatches.

## Task Checklist
- [x] Establish working local verification without bypassing safety controls.
- [x] Share usable-input budgeting across maintenance and retry checks.
- [x] Bound speculative grace and prevent unsafe automatic sends.
- [x] Classify gate overflows and verify existing compact-and-retry recovery.
- [x] Update fork protections and affected package release notes.
- [x] Run focused behavioral checks, complete one cleanup pass, and reconcile execution records.
- [x] Bind admission to the prepared model and matching tokenizer.
- [x] Preserve total occupancy, rewrite corrections, and pending-input growth in the admission floor.
- [x] Settle retries and surface a terminal failure after budget refusal.
- [x] Verify fresh and resumed text-mode refusal without stale answers.
- [x] Reconcile source-task status separately from whole-upgrade readiness.
- [x] Pass independent review and regression verification within the round ceiling.

## Verification
Exercise the incident's context window and reserve with speculative work in flight; no oversized normal request may be sent.
Verify that grace remains available when an earlier configured trigger leaves genuine usable room.
Verify pending input, model changes, unsuccessful maintenance, cancellation, and rebuilding before retry at the affected lifecycle seams.
Exercise the production diagnostic through classifier, summary-window shrinking, and session recovery; authentication and media-limit errors remain distinct.
Use focused tests in packages/agent/test/compaction-reserve-provenance.test.ts, compaction-oversized-input.test.ts, and compaction-error-status.test.ts.
Use focused tests in packages/ai/test/overflow-utils.test.ts and packages/coding-agent/test/compaction-speculation.test.ts, agent-session-goal-midrun-compaction.test.ts, and relevant recovery/progress-guard tests.
Run package-local bun check entrypoints for affected TypeScript packages; do not install dependencies or run unrelated Rust validation.
Update agents-tools/.agents/skills/upgrade-omp/fork_boundary.json in the local agentic-workstation repository and validate with its existing source-boundary workflow without upgrading or publishing.
Keep verification claims limited to exercised paths; a live deployed stronk-ai replay is not claimed by local fixture tests.
Prior checks passed 237 tests with five skips and package-local checks, but the independent audit reproduced four missing failure combinations.
Those earlier passing checks do not establish completion; the new regression checks and independent checkpoint govern acceptance.
The status-preserving working-copy fork audit accounts for every changed path and passes both overflow contracts, but its overall status remains FAIL because three separately required Handler files are absent.
Correction verification: 378 passed, five skipped, zero failed across 20 focused files; affected package checks passed.
Independent final-source runtime checks passed all four prior failures plus fitting fresh-input and orchestration-exclusion boundaries, using real text-mode failure exits and isolated fake providers.
Independent acceptance review passed in round 1 of the operator's five-round ceiling, with no blocking findings.
No installed CLI, deployment, or live-provider readiness is claimed.

## Rollback
Leave changes uncommitted and preserve user staging.
Rollback, if requested, must remove only agent-owned changes; do not restore whole dirty files or alter installed runtimes.

## Open Questions
No unresolved behavior choices remain in the approved scope.
The previously missing Handler anchors are now present in the published fork history.
Whole-upgrade acceptance still requires fresh exact-PASS audits, protected tests, build, managed-install smoke, and fork publication verification.

## Follow-up Checklist
- [x] Commit the bounded prepared-budget recovery and protect its behavior in the fork manifest.
- [x] Resolve published-fork overlap with runtime admission and notebook rollover without duplicate run preparation.
- [x] Verify prompt/continuation preparation, runtime refusal, ordinary recovery, and notebook rollover.
The managed updater owns upgrade acceptance and its durable receipt; this source checklist does not claim installation or publication.
