# Worklog — storybook-reader

Append-only journal. Most recent at top. **Read this before editing code in a hot area.** Companion to `.claude/skills/`.

Format per entry:
- date · short title
- **What changed** (files + 1-line per file)
- **Why** (the user-visible problem or constraint that motivated it)
- **Regression risks introduced** (things to watch when next editing nearby code)
- **Tested how** (real test, not "it compiled")
- **Status** (shipped / pending / rolled back)

---

## 2026-04-30 · Voice-model click fix + vocab error visibility

- **What changed:**
  - `web-next/src/components/ui/select.tsx` — bumped `Select` portal `z-50` → `z-[80]` (both Positioner and Popup). The audio sheet sits at `z-[65]`, so dropdown content was rendering UNDER the sheet's backdrop and clicks landed on the backdrop (which closes the sheet).
  - `web-next/src/features/reader/ReaderRoute.tsx` — replaced the silent `catch { onToast('Could not save') }` in the vocabulary save path with one that `console.error`s the real error and surfaces it (or "Sign in to save" for `AuthError`). Imports `AuthError` from the api client.
- **Why:**
  - Bug 1 was a regression I introduced in `85c886a` (audio-sheet z-index bump). All `Select` dropdowns inside the audio sheet — Provider, Voice, etc. — were unclickable because their portal-rendered content was behind the sheet.
  - Bug 2: backend confirmed working end-to-end with the exact frontend payload (TestClient round-trip succeeds: `getOrCreateDeck` → POST `/decks/{id}/notes` returns 200 with the saved note). The catch was hiding whatever was actually failing in production. Now the error is visible.
- **Regression risks introduced:**
  - **Anything else portaled at z-50 is now also under the audio sheet.** Audited: Popover, Dialog, Tooltip, Sheet, DropdownMenu — none are used inside the audio sheet right now, but if you add one, it'll be invisible until its z is bumped to ≥ z-[70]. Updated z-index ladder in seamless-tts skill.
  - **The new vocab error toast can leak technical messages to users** (e.g. "Could not save: 500: deadlock detected"). Trimmed to 60 chars, but still — once the underlying production error is identified, replace with a user-friendly message.
- **Tested how:**
  - Backend: TestClient round-trip with real frontend payload — list decks (empty) → create deck (200) → list decks (now has 1) → create note (200, with dictionary auto-fill).
  - Frontend: `npm run typecheck` clean, `npm run build` clean, `npm run dev` starts and serves on 5175 without errors.
  - Did NOT manually click voice models in the audio sheet (would need a real Supabase session). Z-index fix is verified by code inspection — sheet is z-[65], dropdown was z-50, now z-[80]; ladder is well-defined.
- **Status:** Shipped to local — NOT pushed. User asked for fix + test, no push request yet.
- **Open follow-up:** Once user tries vocab save in production, the toast will show the actual error (auth? 500? validation?). Iterate from there.

## 2026-04-30 · Discipline reset — skills + worklog system

- **What changed:** Added this `WORKLOG.md`. Added `.claude/skills/pdf-extraction/SKILL.md`. Updated `.claude/skills/seamless-tts/SKILL.md` with a new regression-watchpoints section. Updated `CLAUDE.md` to fix stale `web-rewrite` → `web-next` references and stale file-size numbers.
- **Why:** User asked for disciplined, regression-aware execution because previous fixes kept breaking adjacent features (e.g. the `_books_cache` upload-visibility regression while implementing auto-presynth).
- **Regression risks introduced:** None — pure docs.
- **Tested how:** N/A.
- **Status:** Shipped (docs only).

## 2026-04-29 · `ca42214` PyMuPDF + drop broken `_books_cache`

- **What changed:** `pdf_to_audio.py` — `extract_pdf_text` is now 3-tier: PyMuPDF → pdfplumber → pypdf, picks best by space-density when none "look correct". `requirements.txt` — added `pymupdf` and `pdfplumber`. `server/app.py` — replaced `list_books()` to drop the in-process `_books_cache` (it was per-Vercel-lambda and made uploads invisible for ~60 s).
- **Why:** Two reports: (a) certain PDFs upload with mingled words / typos; (b) "not all uploaded files show up". Single combined commit.
- **Regression risks introduced:**
  - **Vercel size budget** — pymupdf+pdfplumber landed near the 245 MB ceiling. Verified `dpl_4kHV4T53pBnVVj5jP5XNYDNkthHC` deployed READY, but every future Python dep needs to be sized first.
  - **Removing the cache slows hot list_books calls slightly** — was a per-process dict, now hits the storage backend each call. If this becomes a perf issue, replace with a TTL'd cache that's keyed correctly across instances (e.g. Supabase row read with `staleTime`).
  - **Existing 4 books were NOT re-extracted.** Per user constraint. They still show whatever pypdf produced. If quality complaints persist for those specific books, gate a one-shot reextract behind an explicit user action.
- **Tested how:** Vercel deployment READY for production. Did not local-test the actual upload flow on a mingled-words PDF — flag for follow-up.
- **Status:** Shipped.

## 2026-04-29 · `85c886a` Audio-sheet z-index fix

- **What changed:** `web-next/src/features/reader/ReaderRoute.tsx` — BottomSheet bumped from `z-50` to `z-[65]` (line 638). Sits above the audio-follow highlight (`z-[54]`) and selection overlay (`z-[55]`).
- **Why:** Screenshot showed the blue "currently playing" bar bleeding into the audio settings sheet UI.
- **Regression risks introduced:**
  - Anything with `z-[60..64]` in the reader is now BELOW the sheet — verify before adding new overlays in that range.
  - If a future overlay needs to sit above the sheet (toast, modal), use `z-[70]+`.
- **Tested how:** Screenshot validation only. No automated test for z-index ordering.
- **Status:** Shipped.

## 2026-04-29 · `de37fdd` Auto-presynth on upload + grid alignment

- **What changed:** `server/app.py` — added `kickoff_auto_presynth(book_id)` and `_AUTO_PRESYNTH_PROVIDERS = ("kokoro", "google")`. Hooked into `import_book_source`. `web-next/.../ReaderRoute.tsx` — client-side presynth grid aligned to backend's sentence-boundary chunker (cache-key alignment, line ~2911).
- **Why:** TTS playback had ~5–30 s cold-start; user wanted Speechify-grade seamless play.
- **Regression risks introduced:**
  - **Vercel daemon-thread limitation** — `threading.Thread(daemon=True)` is killed when the function returns. Auto-presynth on upload will NOT complete on Vercel. It only fully completes on `uvicorn` local. Per-chunk caching still lands what does complete in S3 before the lambda dies.
  - **Marker file is single-provider** — `.presynth-done.json` is overwritten by whichever provider finishes last. Re-runs of the OTHER provider treat it as "done" and skip. Known limitation; document if user reports kokoro→google switch not pre-warming.
- **Tested how:** Local uvicorn upload → confirmed `.presynth-done.json` and `*.wav` files appeared in `library/<bookId>/live_audio/`. Did NOT test Vercel completion path (known to be partial there).
- **Status:** Shipped.

## Hot files to handle with care

- `server/app.py` (~5900 lines, monolithic, intentionally so for Vercel)
- `web-next/src/features/reader/ReaderRoute.tsx` (~4100 lines, all reader state)
- `pdf_to_audio.py` (~1200 lines, ingestion pipeline)
- `requirements.txt` (size-budget sensitive — Vercel 245 MB Lambda)

## Known fragile areas

- **In-process caches in `server/app.py`** — must work across Vercel lambda invocations. Default suspicion: any module-global dict or set is broken on Vercel.
- **`LIVE_AUDIO_CACHE_VERSION`** — must bump if cache-key fields change, else every existing audio file in S3 orphans.
- **z-index in `ReaderRoute.tsx`** — current ladder: highlight `z-[54]` < selection `z-[55]` < ... < bottom sheet `z-[65]`. Future overlays should declare their tier explicitly.
- **`web-rewrite/`** — legacy frontend, kept around but NOT deployed. Don't edit it. Production is `web-next/`.
