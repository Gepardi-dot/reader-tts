# Gemma Execution Prompts

## Resume Gemma Work From Ledger
```text
Read `docs/ai/gemma-task-ledger.md`, `docs/ai/gemma-decisions.md`, and `docs/ai/gemma-roadmap.md` before making changes.
Summarize the active phase, the last completed step, the next concrete step, the locked decisions, and the files expected to change next.
Work only on the active phase unless the ledger explicitly says the phase changed.
After every meaningful implementation step, update `docs/ai/gemma-task-ledger.md` and add any new durable decision to `docs/ai/gemma-decisions.md`.
```

## Implement Only The Next Phase
```text
Use `docs/ai/gemma-roadmap.md` and `docs/ai/gemma-task-ledger.md` as the source of truth.
Implement only the currently active phase and do not start later phases, even if they look related.
Preserve existing behavior outside the active phase and keep changes targeted to the files listed in the ledger unless new files are clearly required.
Before finishing, record what changed, what remains, and what should happen next in `docs/ai/gemma-task-ledger.md`.
```

## Review Existing Gemma Code Before Editing
```text
Before editing, inspect the current Gemma-related code paths and compare them against `docs/ai/gemma-decisions.md` and `docs/ai/gemma-roadmap.md`.
Call out any drift from the accepted decisions or the active phase boundaries.
Do not rewrite working code just to match a new idea unless the decisions log is updated first.
```

## Update Docs / Ledger After Completing A Step
```text
After completing any meaningful Gemma task, update `docs/ai/gemma-task-ledger.md` with:
- current status
- last completed step
- next concrete step
- open risks/blockers
- files expected to change next
- validation still required

If the work introduced a new architectural constraint, tradeoff, or policy that later sessions should not re-decide, record it in `docs/ai/gemma-decisions.md`.
Keep the roadmap stable unless the rollout order or success criteria truly changed.
```

## Do Not Expand Scope Beyond The Current Phase
```text
Stay inside the active phase defined in `docs/ai/gemma-task-ledger.md`.
If a useful idea belongs to a later phase, record it in the roadmap or decisions log instead of implementing it now.
Do not mix vocabulary-provider work with OCR, chapter recovery, or book Q&A changes unless the active phase explicitly moved forward.
```
