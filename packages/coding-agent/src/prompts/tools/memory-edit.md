Edit Mnemopi long-term memories by id. Only ids returned by `{{toolRefs.recall}}`.

Operations:
- `update`: working memory; replace content and/or importance.
- `forget`: permanently delete working memory, and cut its exact text out of retained session transcripts and the summaries and facts built from them.
- `invalidate`: softly supersede working or episodic memory; optional `replacement_id`. Retained transcripts that quote it stay as history.

Fact ids — `{{toolRefs.recall}}` results marked `[facts]`: read-only. Inspect with `read memory://<id>`; any edit op → `not_editable`.

Prefer `invalidate` for stale memory whose history may still be useful. Use `forget` only for content requiring hard deletion.

MUST read full memory before `update`. Recall previews clipped: trailing `…` marks truncation; `full_length` original size. `update` replaces content wholesale → updating a preview deletes its unseen tail. First `read memory://<id>`; pass merged content in `content`.
