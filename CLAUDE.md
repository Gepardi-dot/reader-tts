# Storybook Reader — Claude Agent Notes

Standing rules and architectural facts. Update when the codebase actually changes.

---

## Environment

- **Repo:** `https://github.com/Gepardi-dot/reader-tts.git` — `master` = local default, `main` = Vercel production target
- **Deployed app:** `web-next/` (auto-deploys on push to `main`)
- **Legacy app:** `web-rewrite/` — kept for reference, NOT deployed, don't edit
- **Vercel:** project `prj_P00Pcd5jNN6EWClYuBtLknZ2aFDB`. Use Vercel MCP for deploy/logs/inspect
- **Supabase:** project `READER-TTS` (`sdpamyibabqimwlwwmks`). Pooler URL in `.env`; `psycopg` required locally
- **Node 22+ required for CI** (`.github/workflows/ci.yml`)

**Before editing hot files, read the relevant skill in `.claude/skills/`** (currently `seamless-tts/`, `pdf-extraction/`).

---

## Architecture

### Backend — `server/app.py` (~5900 lines, monolithic FastAPI)

- On Vercel: serverless function (no persistent workers, no ffmpeg jobs, no daemon threads)
- Locally: `uvicorn`, supports background audio generation jobs
- Storage: local `library/` OR S3-compatible bucket (`BOOK_STORAGE_BUCKET`)
- Supabase Postgres for cross-device progress sync (`reader_progress`, `audio_progress`, vocabulary studio tables); `psycopg` lazy-loaded
- Dictionary: OpenWordNet (offline) → Samsung ADB bridge → SQLite cache
- Audio job files under `library/<bookId>/jobs/`
- **Live audio providers:** `google` (Gemini Flash TTS), `kokoro` (Fly.io remote)
- Auth: `APP_SECRET_KEY` enables Bearer token on `/api/` and `/library/` routes
- Sentry: opt-in via `SENTRY_DSN` (sentry-sdk excluded from `requirements.txt` due to Vercel 245 MB Lambda limit)

### Frontend — `web-next/` (deployed, primary)

See `web-next/CLAUDE.md` for stack details and design language.

| Route | Component | Notes |
|-------|-----------|-------|
| `/library` | LibraryRoute | Book grid, search, progress badges |
| `/book/:bookId` | BookRoute | Reader: pagination, highlights, audio |
| `/upload` | UploadRoute | PDF upload |
| `/vocabulary` | VocabularyRoute | Saved words deck |
| `/studio` | StudioRoute | Practice / spaced repetition sessions |
| `/notes` | NotesRoute | Highlights archive |
| `/progress` | ProgressRoute | Reading stats |
| `/settings/audio` | AudioSettingsRoute | Provider, voice, narration |

### Env variables — backend

```
SUPABASE_DB_URL / SUPABASE_POOLER_URL  → DB sync
GEMINI_API_KEY                         → Gemini TTS (default live provider)
KOKORO_REMOTE_URL / *_API_KEY          → Kokoro TTS via Fly.io
OPENAI_API_KEY                         → Context AI (vocab/dictionary; NOT TTS)
BOOK_STORAGE_BUCKET                    → S3 bucket for hosted uploads
AWS_ACCESS_KEY_ID / _SECRET_ACCESS_KEY / AWS_REGION → S3 PUT for synthesized WAV (must be set in PROD env, not just preview)
APP_SECRET_KEY                         → Bearer token auth
SENTRY_DSN                             → Backend error tracking (install sentry-sdk manually)
```

### Env variables — frontend

```
VITE_API_ORIGIN   → Override API base URL
VITE_USE_MOCKS=1  → Mock data (for Playwright E2E)
VITE_SENTRY_DSN   → Sentry frontend
```

---

## Known fragile areas

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
npm --prefix web-next run build
npm --prefix web-next run test
python -m py_compile server/app.py pdf_to_audio.py
python scripts/validate_env.py
```

**Manual sanity checks** (type-check passing is NOT enough):
- Upload a PDF → confirm it appears in the library list immediately (catches in-process-cache regressions).
- Open the reader → press play → audio starts within 1–2 s on a warm Kokoro cache.
- Open audio settings sheet while audio plays → blue highlight should NOT bleed into the sheet (z-index ladder).

---

## Open work / known limitations

- [ ] Icons (`icon-192.png`, `icon-512.png`) for `web-next/public/`
- [ ] Direct-to-S3 upload flow needs CORS setup on the bucket
- [ ] Mobile: reader side column hidden below 1100px (highlights/progress not visible on tablet)
- [ ] Auto-presynth on upload doesn't complete on Vercel (daemon thread killed) — needs separate worker for production guarantee. See `.claude/skills/seamless-tts/SKILL.md`.
- [ ] Kokoro server (`scripts/kokoro_server.py`, `Dockerfile.kokoro`, `fly.kokoro.toml`) not yet deployed to Fly.io
