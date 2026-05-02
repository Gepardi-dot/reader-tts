# Worklog — storybook-reader

Append-only journal. **Read `## Open` before editing any hot file.** Skill files hold permanent reference — don't duplicate them here.

---

## Open — active issues and pending work

| Date | Issue | Status |
|------|-------|--------|
| 2026-05-01 | OpenAI/Piper removal — all code done (app.py, ReaderRoute, validate_env, CLAUDE.md), typecheck + build + push pending | PENDING |
| 2026-05-01 | Words page not showing saved vocab — query-key mismatch suspected between save path (`['decks']`, `['deck-dashboard']`) and VocabularyRoute fetch | PENDING |
| 2026-04-30 | Vocab save toast now surfaces real error — waiting for user to reproduce in prod to identify root cause | WATCHING |

---

## Permanent reference

### Hot files
- `server/app.py` (~5900 lines, monolithic, Vercel serverless)
- `web-next/src/features/reader/ReaderRoute.tsx` (~4100 lines, all reader state)
- `pdf_to_audio.py` (~1200 lines, ingestion pipeline)
- `requirements.txt` (Vercel 245 MB Lambda — size-budget critical)

### Known fragile areas
- In-process caches in `server/app.py` — don't survive across Vercel invocations
- `LIVE_AUDIO_CACHE_VERSION` in `server/app.py` — must bump if cache-key fields change (current: 7)
- Z-index ladder — see `.claude/skills/seamless-tts/SKILL.md`
- `web-rewrite/` — legacy, not deployed, don't edit; production is `web-next/`
- `requirements.txt` size — ~40–45 MB headroom before Vercel deploy fails

---

## Archive

### [SHIPPED] 2026-04-30 · Voice-model click fix + vocab error visibility
**What:** `select.tsx` Select portal z-50 → z-[80] (was below audio sheet backdrop). Vocab save catch now surfaces real error instead of silently swallowing it.
**Regression left open:** Vocab error toast may show a raw technical message — replace with user-friendly copy once root cause is confirmed in prod.

### [SHIPPED] 2026-04-30 · Discipline reset — skills + worklog system
**What:** Added WORKLOG.md. Added pdf-extraction skill. Updated seamless-tts skill with regression watchpoints and z-index ladder. Updated CLAUDE.md.

### [SHIPPED] 2026-04-29 · ca42214 PyMuPDF + drop broken `_books_cache`
**What:** 3-tier PDF extractor (PyMuPDF → pdfplumber → pypdf). Removed per-process `_books_cache` from `list_books()` (was invisible to new lambda invocations on Vercel).
**Regression left open:** Existing 4 books not re-extracted. PyMuPDF+pdfplumber pushed Vercel size near 245 MB ceiling — every future Python dep needs size check first.

### [SHIPPED] 2026-04-29 · 85c886a Audio-sheet z-index fix
**What:** BottomSheet z-50 → z-[65] so blue highlight bar didn't bleed into the sheet.
**Note:** This was the root cause of the voice-model click regression, fixed the next day by bumping Select portal to z-[80].

### [SHIPPED] 2026-04-29 · de37fdd Auto-presynth on upload + grid alignment
**What:** `kickoff_auto_presynth` in `import_book_source`. Frontend presynth grid aligned to backend sentence-boundary chunker.
**Regression left open:** Vercel daemon-thread limitation — auto-presynth won't complete server-side on Vercel. Needs a separate long-lived worker for a production guarantee.
