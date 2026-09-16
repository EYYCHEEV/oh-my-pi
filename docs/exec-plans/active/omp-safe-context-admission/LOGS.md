# Project Log: OMP Safe Context Admission
Created: 2026-09-08
Plan: ./PLAN.md
Workspace: docs/exec-plans/active/omp-safe-context-admission/

## Progress
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

## Session History
[2026-09-08] Created the operator-approved workspace from the audited incident and accepted bounded design.
The operator authorized local implementation and fork protection updates, not installation or deployment.
[2026-09-08] Began source implementation after workspace confirmation; command-based verification remains blocked.
[2026-09-08] Added source changes, behavioral regression cases, package changelogs, compaction documentation, and exact fork manifest paths/verification commands.
[2026-09-08] Source work and fork documentation are prepared; final editor diagnostics have no errors. The workspace remains active and blocked pending behavioral tests, package checks, formatting, and the working-copy-aware fork audit after Sentinel is restored.
[2026-09-08] Resumed after the operator confirmed Sentinel restoration; read-only Git commands and Bun tests execute normally.
[2026-09-08] Initial focused run: 126 passed and five failed across nine files. Budget, classifier, and summary checks passed; session fixtures and budget-stop settlement need correction.
[2026-09-08] The remaining regression proved compaction committed successfully but conversion reused an old prefix from the same array identity. Added explicit array-cache invalidation at the mid-run rewrite; all 20 affected session tests now pass.
[2026-09-08] Final focused suite: 237 passed, five skipped, zero failed across 15 files. The pending-input test was then extended to switch models immediately before admission and passed in a focused rerun.
[2026-09-08] All three affected package-local bun check commands passed lint, formatting, and types; final coding-agent check and git diff --check also passed.
[2026-09-08] Bounded clean-code pass completed: temporary tracing was removed; the shared budget resolver, explicit conversion-cache invalidation, and stable overhead-cache adapter were retained because they enforce tested contracts.
[2026-09-08] Source implementation is verified locally. The ExecPlan remains active with one blocked task because the whole-fork audit requires absent, separately owned Handler files.
[2026-09-08] Correction: the preceding completion claim was overstated. Independent agents reproduced retry non-settlement, hidden/stale text-mode output, a prepared-model race, and omitted-output admission with mid-turn maintenance disabled.
[2026-09-08] Operator authorized Stronk-only corrections with independent Super Agents oversight and at most five review-fix rounds, preferring fewer. The main thread is the sole writer; independent children review and verify after the coherent correction batch.
[2026-09-08] Final correction checks: 378 passed, five skipped, zero failed across 20 focused files; affected package checks and diff whitespace check passed.
[2026-09-08] Independent final-source runtime verification passed all four prior failures and two positive accounting boundaries. Both real text-mode processes exited 1 with the refusal reason and no stale answer; all seven isolated process roots were removed and processes exited. Acceptance review is pending.
[2026-09-08] Independent acceptance reviewer returned accept with no blocking findings. All current source-task criteria are complete after one correction-and-acceptance-review round; no further implementation or review round is needed.
[2026-09-08] The reviewer retained only an unmeasured overhead-cache performance observation as advisory. No optional optimization, Handler repair, installation, deployment, or commit was added.

## Decisions
[2026-09-08] Decision: repair contradictory usable-budget rules and retain the narrow overflow classifier fix, rather than rely only on rejection recovery.
[2026-09-08] Decision: reuse native image limiting without new machinery; stronk-ai already inherits the five-image provider fallback.
[2026-09-08] Decision: use exec-plan, design-pressure, bug-slayer, and one post-verification clean-code pass; keep shared-state implementation on the main thread.
[2026-09-08] Decision: preserve contextWindow 272384, maxTokens 65536, and the 206848 gate cap.
[2026-09-08] Decision: continue available source work, but do not retry blocked command execution until the operator verifies the pinned Sentinel precise-mode assets.
[2026-09-08] Decision: design-pressure preflight PASS; the compaction module owns budget calculation, session maintenance owns recovery, and the existing agent gate may only stop an already-prepared request.
[2026-09-08] Decision: retain a stable private adapter to reuse the existing non-message token cache without mutating provider contexts or repeatedly allocating cache inputs.
[2026-09-08] Decision: design-pressure implementation REVISE; assuming a core gate stop settled session maintenance was contradicted by repeated compaction warnings. Reuse the existing one-shot post-turn skip state on a budget stop.
[2026-09-08] Decision: preserve soft-threshold dead-end tests below the hard usable budget, and add prior history to the summary/retry fixtures so they test recoverable sessions rather than a single unreducible turn.
[2026-09-08] Decision: design-pressure implementation REVISE; a rebuilt live context was assumed to imply a rebuilt provider request, but the append-only conversion memo replayed its old prefix. The conversion module now exposes explicit array-cache invalidation, called by the existing mid-run splice owner.
[2026-09-08] Decision: mark the already-performed fork metadata and release-note task complete, add the newly demonstrated acceptance failures as follow-up tasks, and separate unrelated upgrade readiness from source-task status.
[2026-09-08] DESIGN PRESSURE - PLAN PREFLIGHT - PASS
Evidence: agent-loop.prepareProviderCall already captures the dispatch model; gate throws already create balanced terminal error turns; SessionStatsTracker owns corrected usage anchors and compaction epochs.
Pressure: admission read a later model, omitted output, and treated a normal gate stop as a complete session failure. That split ownership left retry and print-mode consumers without a terminal outcome.
Action: pass the captured model through the existing gate callback; extend the existing stats projection for admission; throw deliberate budget refusals into the existing error path and settle them through TurnRecovery without another maintenance pass.
[2026-09-08] DESIGN PRESSURE - IMPLEMENTATION - REVISE
Evidence: the independent runtime proof reported a fresh request estimate twice its prepared size. AgentSession sets a UI pending snapshot before calling agent.prompt; that snapshot already includes the uncommitted input.
Pressure: treating every stats projection as a provider anchor and adding prepared growth duplicated pending input across the stats/maintenance boundary.
Action: admission selects only current-epoch provider anchors; without one, use the complete prepared estimate. Keep UI pending snapshots unchanged. Apply signed provider-orchestration deductions before history-rewrite savings.
[2026-09-08] The independent trace exposed pending-input double-counting; a direct tracker probe and regression reproduced clamped orchestration savings (200000 estimated versus 193000 canonical occupancy). Corrected both before acceptance review. The fitting-input fixture was sized to the actual tokenizer; all 36 session/occupancy tests then passed.

## Blockers
None for the completed Stronk source task.
The historical missing-anchor warning below was superseded by the 2026-09-16 published-fork integration.

## Separate Whole-Upgrade Readiness
The last whole-fork audit was FAIL for the separately registered handler-scoped-session-context contract.
Its required files were absent: packages/utils/src/evaluation-policy.ts, packages/coding-agent/test/cli-evaluation-policy.test.ts, and packages/coding-agent/test/extension-context-budget.test.ts.
The README projection matched all 23 active contracts, with zero unknown changed paths and both overflow-related contracts accounted for.
Preserve that contract unchanged. It limits a future whole-fork upgrade, not completion of these Stronk-only source corrections.

## Open Questions
No unresolved behavior choices in the approved scope.

## Field Notes
Remote evidence was inspected through SSH with allowlisted metadata; session text, request headers, credentials, and image contents were not exposed.
The failed request had 197 messages, 11 tool schemas, max_tokens 64000, reasoning_effort max, and no image blocks.
The later idle retry had 199 messages and no image blocks.
The log records speculative deferral at 207301, then the exact input-only gate rejection.
The successful preceding response had 206291 prompt tokens plus 571 output tokens, totaling 206862.
The existing retry-fit budget is 206848 while the speculative grace ceiling is 232704.
Both checked source trees already contain chunked summarization and adaptive shrink-on-overflow behavior.
The existing pre-send gate is stop-only; integration must not send a stale prepared request after any maintenance mutation.
The workstation-owned fork manifest already protects context-occupancy-projection and local-context-overflow-classification.
No source implementation edits or behavioral checks have been performed when initializing this log.
Source changes now share the usable-input budget, clamp late triggers and speculative grace, and register a read-only pre-send backstop with session disposal.
The backstop counts the prepared messages and request overhead, including input not yet emitted to the session, and retains provider-reported occupancy as a floor.
Classifier changes recognize the exact production text and surviving structured token-overflow codes across cause links.
Behavioral verification passed, including actual AgentSession request rebuilding, gate stop settlement, zero-usage gate-error retry, adaptive summary shrinking, model switching, and gate disposal.
Initial editor diagnostics were followed by executed behavioral tests and package-local checks after Sentinel restoration.
They found a configured-settings versus engine-settings type mismatch and a synchronous test transform where the Agent interface requires a Promise; both were corrected.
The overflow contract IDs and titles stayed unchanged. The README projection was refreshed to include the already-registered Handler contract and now passes the canonical validator.
The manifest changed independently during the session before our edits; fresh anchors were used and unrelated additions were preserved.
The final boundary audit used the existing audit_contracts API with actual Git name-status entries from the locally recorded upstream/main baseline to the working copy, including staged/unstaged final content and the two explicitly named ignored plan files.
No temporary Git index, commit, fetch, dependency install, runtime rebuild, or deployment was used.
A path-only --changed-files fixture was not used as deletion-sensitive proof.
The bounded cleanup pass retained the budget resolver for its shared policy consumers and the array-cache invalidator for the reproduced stale-prefix failure; no speculative framework or image machinery was added.
Plan and log checklists were reconciled without changing task labels or marking unverified behavior complete.
[2026-09-08] Bounded post-implementation pass finished without optional refactoring. The signed occupancy and pending-snapshot corrections address observed arithmetic defects; provider limits, native image handling, and Handler implementation remain unchanged.

## Artifacts
- [Implementation plan](./PLAN.md)

## Client Feedback
[2026-09-08] Operator requested local final changes, a stronger architectural repair than classifier-only handling, and fork-boundary protection.
[2026-09-08] Operator explicitly narrowed image work to existing native provider-wide five-image machinery, without redesign.
[2026-09-08] Operator approved creation of this workspace after the skill-loadout and ExecPlan preview.
[2026-09-08] Operator rejected the Handler handoff and requested independent review of intent alignment; the audit confirmed the scope/status error.

## 2026-09-16 Follow-up and Published-Fork Integration
The operator authorized scoped source and manifest commits, published-fork integration, and a managed upgrade to pinned v18.2.1 with protected tests and fork-only publication.
The late prepared-budget patch was committed as d5cda56716; its manifest protection was committed separately in the workstation repository.
A backup branch preserves that source before merging the published fork.
The original missing Handler anchors now exist; fresh whole-upgrade audits still govern installation.

DESIGN PRESSURE - IMPLEMENTATION - REVISE
Evidence: both the local recovery patch and published runtime-admission feature added Agent.addBeforeRunHook and independent invocations around continuation dispatch.
Pressure: the mechanical merge duplicated lifecycle ownership and would prepare a run multiple times; notebook rollover also introduced a continuation route that did not carry the recovery control.
Action: Agent prepares hooks once before input append or continuation recovery, carries prepared commits into the claimed run, and commits only after all preparations and model validation succeed.
SessionMaintenance forwards recovery ownership and warning suppression through notebook rollover as well as ordinary compaction.

Verification after resolution: 143 tests passed across Agent, prepared-budget recovery, and runtime-requirement suites.
The extended recovery and experimental-context suites then passed 48 tests, including late-growth notebook recovery with an empty ordinary method list.
The remaining seven protected compaction suites passed 204 tests with one skip.
Agent and coding-agent package lint, formatting, and type checks passed; coding-agent reports an existing unused-variable warning in an unrelated subagent-reminder test.
A fixture tool-type mismatch found by type checking was corrected using the repository's existing Tool type.
No live-provider inference or managed-install success is claimed by these source checks.
The managed updater receipt owns subsequent baseline, build, installation, rollback, and publication evidence.

## 2026-09-16 Pinned v18.2.1 Integration
The first managed apply stopped at upstream merge conflicts, restored its pre-sync source, and left the installed runtime unchanged.
The approved manual integration preserves both upstream input-retention and fork runtime-admission behavior.
Custom message admission and receipt sends share one dispatch path, including manual-compaction resume ownership.
Upstream now owns conversion-array cache invalidation; all affected maintenance consumers use that owner.
Overflow recovery carries both fork continuation controls and upstream media-exclusion controls.

The concurrent-turn regression exposed a deadlock in the prepared-recovery patch: run preparation drained all end-of-turn handlers, including a normal TTSR handler awaiting the retry itself.
Preparation now waits only for a captured budget-refusal dispatch and its settlement, not unrelated end-of-turn work.
Normal delayed agent-end notifications remain observable without marking a newer run idle.
The combined concurrent-turn, queued-policy, and prepared-budget suites passed 113 tests after that correction.
Agent, coding-agent, AI, and utilities package checks passed during integration.

Upstream print mode now returns an exit code; refusal tests assert its nonzero result, empty stdout, and exact budget warning instead of intercepting process.exit.
The trailing-output maintenance fixture supplies a synthetic summary and checks that the next request contains the rewritten context; recent kept history remains allowed.
Upstream policy fixtures now add handlers to a pre-registered extension identity rather than mutating the loader-owned identity roster.
The parked-extension-send fixture exercises real Agent admission with a mock provider and real timers; the reminder fixture waits for session settlement rather than a fixed microtask count.
These are local synthetic-provider proofs, not authenticated live-provider or installed-runtime proof.
