# Storybook Reader Agent Guide

This file is for coding agents working in this repository.

## Project Summary

Storybook Reader is a PDF reading and audiobook app with:

- a FastAPI backend in `server/app.py`
- a React + Vite frontend in `web/`
- a shared CLI/audio pipeline in `pdf_to_audio.py`
- local and hosted storage flows for books and generated audio

The app supports:

- local reading and annotation
- live narration (`google`, `polly`, `qwen`)
- full audiobook generation
- hosted deployment on Vercel

## Important Paths

- `server/app.py`: main backend, API routes, provider synthesis, storage, dictionary, highlights
- `web/src/App.tsx`: main frontend app state, reader flow, live playback, library routing
- `web/src/App.css`: main UI styling
- `web/src/components/ReaderDesk.tsx`: reader surface, selection menu, notes/highlights/dictionary
- `web/src/components/LibraryScreen.tsx`: library homepage and archive views
- `web/src/components/library.css`: library-specific styling
- `web/src/components/readerChapters.ts`: chapter extraction and summaries
- `web/src/components/readerPagination.ts`: client-side pagination for reader/live playback
- `pdf_to_audio.py`: chunking, concatenation, ffmpeg helpers
- `vercel.json`: Vercel routing and cache-control behavior
- `web/index.html` and `web/src/main.tsx`: startup shell and boot recovery logic

## Local Run

Backend:

```powershell
.\start-api.ps1
```

Frontend:

```powershell
.\start-web.ps1
```

The wrappers now safely no-op if the expected app is already running on the default port.

## Validation

Frontend validation:

```powershell
npm --prefix web run lint
npm --prefix web run build
```

Backend validation:

```powershell
python -m py_compile server/app.py pdf_to_audio.py
```

Use all three when touching reader, playback, provider, or storage behavior.

## Deployment Notes

- Production is hosted on Vercel at `https://readertts.vercel.app/`
- Root HTML startup behavior is intentionally hardened in `web/index.html`, `web/src/main.tsx`, and `vercel.json`
- Do not casually remove startup recovery or `Cache-Control: no-store` behavior for the root shell
- Hosted uploads depend on S3 environment variables and direct browser upload flow

## Reader And Audio Notes

- Live playback is orchestrated in `web/src/App.tsx`
- Qwen live playback is slower than Polly and Gemini, so it uses smaller chained segments instead of whole-page requests
- Reader page boundaries come from `paginateReaderText()`
- Selection behavior and highlight/note/vocabulary logic live mainly in `ReaderDesk.tsx` and backend highlight serialization in `server/app.py`

## Annotation Rules

Current archive behavior is intentional:

- single-word saves => `vocabulary`
- two-or-more-word saves => `note`

That routing is enforced on the backend and should stay server-driven.

## Mobile UX Notes

- Mobile reader controls are intentionally different from desktop
- Mobile selection tries to prioritize the app popup over the Android/native text menu
- Mobile floating header, mobile chapter popover placement, and mobile audio dock have all been customized and are easy to regress
- When changing reader UI, verify both desktop and mobile behavior

## Repo Hygiene

- Avoid editing or relying on `tmp-*` files, `*.log`, or screenshot artifacts unless debugging
- Treat `library/` as app data, not source code
- Keep changes targeted; this repo has many UX-specific fixes and regressions often happen when unrelated reader/header/mobile behavior is changed together
- If fixing production boot issues, verify the actual deployed domain and not only a deployment preview URL

## Gemma Work Memory

- For Gemma integration work, use `docs/ai/gemma-roadmap.md` for the stable rollout plan, `docs/ai/gemma-task-ledger.md` for live status, `docs/ai/gemma-decisions.md` for locked decisions, and `docs/ai/gemma-prompts.md` for reusable resume/execution prompts.

## If You Touch These Areas

- Reader header or floating controls: verify scroll-up/show and scroll-down/hide on both desktop and mobile
- Selection menu: verify desktop and mobile layout, note save, vocabulary save, delete, dictionary, and Google action visibility
- Live audio: verify at least one real provider flow, especially Qwen if the change affects segmenting or queue behavior
- Chapter navigation: verify popup placement, search focus, and jump-to-chapter behavior
- Startup shell: verify the public domain does not get stuck on the loading shell
