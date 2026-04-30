# Storybook Reader — Claude Agent Notes

This file is maintained by the Claude (Cowork) agent. It extends `agent.md` with live observations,
decisions, and improvement tracking. Update it as the codebase evolves.

---

## Environment Status (last verified: 2026-04-17)

| Tool | Status | Version | Notes |
|------|--------|---------|-------|
| Git | ✅ Connected | 2.51.0 | `origin` → `https://github.com/Gepardi-dot/reader-tts.git` |
| GitHub CLI | ✅ Authenticated | 2.82.1 | Account `Gepardi-dot`, scopes: repo, workflow |
| Vercel MCP | ✅ Connected | — | Use MCP tools for all Vercel ops (deploy, logs, inspect) |
| Vercel CLI | ⚠️ Needs login | 48.9.0 | Run `vercel login` interactively on Windows host |
| Supabase CLI | ✅ Authenticated | 2.84.2 | Project `READER-TTS` linked (`sdpamyibabqimwlwwmks`) |
| Supabase DB | ✅ Reachable | — | Pooler URL in `.env`; `psycopg` must be installed locally |
| Python | ✅ Available | — | `psycopg` must be installed locally to use DB sync |
| Node | ✅ Available | 24.x | Vite/React build works fine |

**Vercel deployment:** Vercel auto-deploys on push to `main` via GitHub integration. No manual CLI deploy needed.
**Deployed app:** `web-next/` — React Router v7, TanStack Query, Zustand, feature-based structure.
**Legacy apps:** `web/` and `web-rewrite/` — kept for reference, NOT deployed. Don't edit them.

**Worklog & skills:** Before editing hot files, read `WORKLOG.md` (running journal of recent changes + regression risks) and the relevant skill in `.claude/skills/` (currently: `seamless-tts/`, `pdf-extraction/`).

---

## Architecture Notes

### Backend (`server/app.py` — ~5900 lines)

- Single-file FastAPI app, intentionally monolithic for Vercel deployment ease.
- On Vercel: runs as a serverless function (no persistent workers, no ffmpeg jobs).
- Locally: runs with `uvicorn`, supports background audio generation jobs.
- Storage is dual: local `library/` folder OR S3-compatible bucket (set `BOOK_STORAGE_BUCKET`).
- Supabase Postgres is used for cross-device progress sync (reading + audio position).
  - `psycopg` is loaded lazily via `load_psycopg()` — fails gracefully if not installed.
  - Tables: `reader_progress`, `audio_progress` — versioned by `schema_migrations` table.
- Dictionary is multi-tier: OpenWordNet (offline) → Samsung ADB bridge → local SQLite cache.
- Job system (audio generation) uses JSON files under `library/<bookId>/jobs/`.
- Live audio (per-page TTS): `google` (Gemini Flash TTS), `polly` (AWS), `qwen` (DashScope), `openai`, `piper`.
- Auth: `APP_SECRET_KEY` env var enables Bearer token auth on all `/api/` and `/library/` routes.
- Sentry: opt-in via `SENTRY_DSN` (try/except ImportError guard; not in requirements.txt due to Lambda size).

### Frontend — `web-next/` (PRIMARY, deployed)

- **Router:** React Router v7 with `createBrowserRouter`
- **Data:** TanStack Query (staleTime 30s, no window-focus refetch)
- **State:** Zustand for audio dock state only
- **Structure:** Feature-based (`features/library`, `features/book`, `features/learn`, etc.)
- **API client:** `shared/api/client.ts` — single request() function with auth header injection, AuthError on 401
- **Auth:** stored in `localStorage['storybook-auth-key']`, injected into every request
- **PWA:** `vite-plugin-pwa` with Workbox — app shell precached, audio files CacheFirst

#### Routes
| Path | Component | Notes |
|------|-----------|-------|
| `/books` | LibraryRoute | Book grid, search, delete, progress badges |
| `/book/:bookId` | BookRoute | Full reader: pagination, highlights, audio, appearance |
| `/upload` | UploadRoute | PDF upload form |
| `/studio` | LearnRoute | Vocabulary review/lesson sessions |
| `/words` | WordsRoute | Deck dashboard |
| `/notes` | NotesRoute | All highlights archive |
| `/settings/audio` | AudioSettingsRoute | Provider/voice/narration settings |

#### Key Env Variables (frontend)
```
VITE_API_ORIGIN      → Override API base URL (for hosted deployments)
VITE_USE_MOCKS=1     → Use mock data (for Playwright E2E tests)
VITE_SENTRY_DSN      → Enable Sentry error tracking
```

### Key Env Variables (backend)
```
SUPABASE_DB_URL / SUPABASE_POOLER_URL  → DB sync
GEMINI_API_KEY                         → Gemini TTS (default live provider)
DASHSCOPE_API_KEY                      → Qwen TTS
POLLY_REGION / AWS_ACCESS_KEY_ID       → AWS Polly
OPENAI_API_KEY                         → OpenAI TTS
BOOK_STORAGE_BUCKET                    → S3 bucket for hosted uploads
APP_SECRET_KEY                         → Bearer token auth (all /api/ and /library/ routes)
SENTRY_DSN                             → Backend error tracking (install sentry-sdk manually)
PIPER_EXE / PIPER_ESPEAK_DATA          → local offline TTS
```

---

## Regression Checklist

Run before any commit touching reader, audio, or storage:

```powershell
# Primary frontend (web-next)
npm --prefix web-next run lint
npm --prefix web-next run build
npm --prefix web-next run test        # vitest unit tests

# Backend syntax
python -m py_compile server/app.py pdf_to_audio.py

# Env validation
python scripts/validate_env.py
```

**Manual sanity checks** (do these — type-check passing is NOT enough):
- Upload a PDF → confirm it appears in the library list immediately (catches in-process-cache regressions on Vercel).
- Open the reader → press play → audio starts within 1–2 s on a warm Kokoro cache.
- Open audio settings sheet while audio plays → blue highlight should NOT bleed into the sheet (z-index ladder).

---

## Migration Status (2026-04-17)

`web/` → `web-rewrite/` migration is in progress. `web-rewrite/` is now the deployed app.

### Completed phases
- **Phase 1** — Foundation: auth, Vercel build, CI switched to web-rewrite
- **Phase 2** — Reader: keyboard nav, appearance controls, proper paragraphs, highlights
- **Phase 3** — Library: deletion, search, progress badges, mobile-first AppShell (bottom nav)
- **Phase 4** — Audio: MM:SS time, playback rate, mobile-safe AudioDock positioning
- **Phase 5** — PWA: service worker (Workbox), web manifest, `viewport-fit=cover` for notched phones

### Still in legacy `web/` only (not yet migrated to `web-next/`)
- Background audio generation job system (full-book narration)
- Advanced live audio pre-fetching (segment queue, fallback provider)
- Dictionary lookup UI
- Chapter navigation

### Known limitations / Future work
- [ ] Icons (`icon-192.png`, `icon-512.png`) need to be created and placed in `web-next/public/`
- [ ] Sentry excluded from requirements.txt due to Vercel 245 MB Lambda limit — use Vercel's native integration instead
- [ ] Background audio job system not in web-next yet
- [ ] Direct-to-S3 upload flow needs CORS setup on the S3 bucket
- [ ] Mobile: reader side column hidden below 1100px (highlights/progress not visible on tablet)
- [ ] Auto-presynth on upload doesn't complete on Vercel (daemon thread killed) — needs separate worker for production guarantee. See `.claude/skills/seamless-tts/`.
