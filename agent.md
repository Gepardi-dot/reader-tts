# Storybook Reader — Agent Pointers

This is a thin index for coding agents. All standing instructions live in the files below; do not duplicate content here.

| File | What it covers |
|------|---------------|
| `AGENTS.md` | Production directive, end goal, platform policy, PR/verification rules |
| `CLAUDE.md` | Project-wide architecture, env vars, regression checklist, fragile areas |
| `web-next/CLAUDE.md` | Frontend stack, design language, paths, component library |
| `.claude/skills/seamless-tts/SKILL.md` | TTS playback invariants, cache key contract, z-index ladder |
| `.claude/skills/pdf-extraction/SKILL.md` | PDF extraction pipeline invariants, footguns |
| `.claude/settings.json` | Tool allowlist (read-only commands pre-approved) |
| `docs/ai/gemma-roadmap.md` + sibling files | Gemma integration plan, task ledger, decisions, prompts |

## Read-before-edit

Before touching `cloudflare/worker/src/index.ts`, `server/app.py` audio paths, `web-next/src/features/reader/ReaderRoute.tsx`, or `pdf_to_audio.py`, read `AGENTS.md` and the relevant skill above. Skills hold invariants that cannot be inferred from the code alone (cache-key contracts, deployment gotchas, layering rules).
