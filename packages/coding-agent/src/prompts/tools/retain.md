Store ≥1 fact in long-term memory for future sessions.

Use: durable, reusable knowledge—user preferences, project decisions, architectural choices; anything improving future responses. No ephemeral task state.

{{#if globalScope}}`scope: global` stores an item in the shared bank every project recalls; reserve it for cross-project preferences and facts.
{{/if}}{{#if expiry}}`expires` makes an item stop surfacing in recall at that moment, for facts that go stale (a freeze window, a temporary workaround): an ISO date (`2026-12-01`, valid through the end of that UTC day), an ISO date-time with a UTC offset (`2026-12-01T09:00:00Z`), or a duration from now (`90m`, `12h`, `30d`, `2w`). A malformed or past value rejects the whole batch with nothing stored. Omit it for lasting knowledge.
{{/if}}{{#if storedIds}}The result lists the id of each stored item, in item order; keep an id to change or drop that memory later with `memory_edit`.
{{/if}}Each item MUST be specific, self-contained: who, what, when, why. Batch related facts per call; deduplicated and consolidated.
