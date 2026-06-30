# Storybook Reader — Claude Agent Notes

Standing rules and architectural facts. Update when the codebase actually changes.

---

## Environment

- **Repo:** `https://github.com/Gepardi-dot/reader-tts.git` — `main` is the primary branch
- **Production direction:** Cloudflare-first. Use Cloudflare Pages for `web-next/`, Workers for the API, D1 for relational data, and R2 for durable audio/blob caching once enabled.
- **Stable Pages deploy:** deploy `web-next/dist` to Cloudflare Pages project `reader-tts` with branch `cloudflare-foundation`.
- **Worker:** `reader-tts-api` in `cloudflare/worker/`, using D1 database `reader_tts`.
- **Vercel/Supabase:** legacy-era integrations. Do not treat them as constraints if they hurt speed, reliability, cost, or maintainability.
- **Legacy app:** `web-rewrite/` — kept for reference, NOT deployed, don't edit
- **Node 22+ required for CI** (`.github/workflows/ci.yml`)

**Before editing hot files, read the relevant skill in `.claude/skills/`** (currently `seamless-tts/`, `pdf-extraction/`).

---

## Architecture

### Active API — `cloudflare/worker/src/index.ts`

- Cloudflare Worker routes for auth, books, progress, vocabulary, providers, health, and Gemini live audio.
- D1 stores ReaderTTS data. Keep it separate from KU Online/Kubazar resources.
- Gemini TTS is optional and requires `GEMINI_API_KEY` as a Worker secret.
- Worker Cache API currently caches Gemini live-audio responses opportunistically; R2 is the desired durable cache once enabled in the Cloudflare dashboard.

### Legacy Backend — `server/app.py` (~5900 lines, monolithic FastAPI)

- Legacy/Vercel-era backend retained for reference and migration. Do not preserve this path by default when it conflicts with the Cloudflare-first end goal.
- On Vercel: serverless function (no persistent workers, no ffmpeg jobs, no daemon threads)
- Locally: `uvicorn`, supports background audio generation jobs
- Storage: local `library/` OR S3-compatible bucket (`BOOK_STORAGE_BUCKET`)
- Supabase Postgres for cross-device progress sync (`reader_progress`, `audio_progress`, vocabulary studio tables); `psycopg` lazy-loaded
- Dictionary: OpenWordNet (offline) → Samsung ADB bridge → SQLite cache
- Audio job files under `library/<bookId>/jobs/`
- **Live audio providers:** `google` (Gemini Flash TTS), `kokoro` (Fly.io remote)
- Auth: `APP_SECRET_KEY` enables Bearer token on `/api/` and `/library/` routes
- Sentry: opt-in via `SENTRY_DSN` (sentry-sdk excluded from `requirements.txt` due to Vercel 245 MB Lambda limit)

### Frontend — `web-next/` (primary)

See `web-next/CLAUDE.md` for stack details and design language.

| Route | Component | Notes |
|-------|-----------|-------|
| `/library` | LibraryRoute | Book grid, search, progress badges |
| `/book/:bookId` | ReaderRoute | Reader: pagination, highlights, audio |
| `/upload` | UploadRoute | PDF upload |
| `/vocabulary` | VocabularyRoute | Saved words deck |
| `/studio` | StudioRoute | Practice / spaced repetition sessions |
| `/notes` | NotesRoute | Highlights archive |
| `/progress` | ProgressRoute | Reading stats |
| `/audio` | AudioSettingsRoute | Provider, voice, narration |

### Env variables — Cloudflare Worker

```
GEMINI_API_KEY       → Gemini TTS Worker secret (not currently set)
SIGNUP_INVITE_CODE   → Optional invite-code gate for signup
GEMINI_TTS_MODEL     → Worker var, defaults to gemini-2.5-flash-preview-tts
```

### Env variables — frontend

```
VITE_API_ORIGIN   → Override API base URL
VITE_USE_MOCKS=1  → Mock data (for Playwright E2E)
VITE_SENTRY_DSN   → Sentry frontend
```

---

## Known fragile areas

- **Project direction** — ReaderTTS is a new Cloudflare-first project. Do not keep Vercel/Supabase/old backend behavior unless it is still the best fit for the end goal.
- **In-process caches** in `server/app.py` — DO NOT survive across Vercel invocations. No module-global dicts/sets without measured perf reason and cross-instance keying.
- **`threading.Thread(daemon=True)`** — killed when Vercel lambda returns. Background work won't complete on Vercel.
- **`LIVE_AUDIO_CACHE_VERSION`** in `server/app.py` (current: 7) — must bump if cache-key fields change, otherwise every cached S3 file is orphaned.
- **Z-index ladder** — see `.claude/skills/seamless-tts/SKILL.md`.
- **Vercel 245 MB Lambda budget** — ~40–45 MB headroom. Every Python dep needs size check.
- **`web-rewrite/` is legacy and not deployed** — production is `web-next/`.

---

## Regression checklist

Run before any commit touching reader, audio, or storage:

```powershell
npm --prefix web-next run lint
npm --prefix web-next run test
npm run build
npm run worker:deploy -- --dry-run
python -m py_compile server/app.py pdf_to_audio.py
```

**Manual sanity checks** (type-check passing is NOT enough):
- Upload a PDF → confirm it appears in the library list immediately (catches in-process-cache regressions).
- Open the reader → press play → browser speech starts immediately, and warm Kokoro/Gemini cached chunks should take over smoothly where applicable.
- Open audio settings sheet while audio plays → blue highlight should NOT bleed into the sheet (z-index ladder).

---

## Open work / known limitations

- [ ] Icons (`icon-192.png`, `icon-512.png`) for `web-next/public/`
- [ ] Enable Cloudflare R2, create durable audio/blob bucket, and bind it to the Worker
- [ ] Add `GEMINI_API_KEY` as a Worker secret and run real Gemini cache-hit smoke tests
- [ ] Mobile: reader side column hidden below 1100px (highlights/progress not visible on tablet)
- [ ] Continue extracting timing-sensitive playback scheduling out of `ReaderRoute.tsx`
