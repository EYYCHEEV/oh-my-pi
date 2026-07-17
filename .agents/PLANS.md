# ExecPlans

Use an ExecPlan for complex features and significant refactors that need durable sequencing, decisions, or recovery across sessions.

## Requirements

- Keep each plan concise, concrete, and editable by maintainers.
- Treat `PLAN.md` and `LOGS.md` as living documents throughout execution.
- Define observable outcomes, verification commands, constraints, and rollback boundaries.
- Record progress only after the corresponding behavior is verified.
- Keep active work under `docs/exec-plans/active/<slug>/` and move completed work to `docs/exec-plans/completed/<slug>/`.
- Preserve workspace artifacts that explain decisions or provide reproducible proof.
