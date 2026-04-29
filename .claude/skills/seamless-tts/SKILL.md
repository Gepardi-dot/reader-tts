---
name: seamless-tts
description: When working on TTS playback latency, gapless audio, or buffering issues in storybook-reader — use this. Codifies the architecture so we stop re-deriving it each session.
---

# Seamless TTS — architecture cheat sheet

This skill exists because TTS playback in `storybook-reader` keeps getting "fixed"
incrementally and regressing. Read this **before** touching anything in the audio
path. The shape is non-obvious and the codebase is large.

## The four hot files

| File | Lines | What lives here |
|------|------:|-----------------|
| `web-next/src/features/reader/ReaderRoute.tsx` | ~4100 | Frontend reader, all playback state, prefetch, gapless scheduling |
| `server/app.py` | ~5800 | FastAPI monolith: `/api/books/{id}/live-audio`, `/api/books/{id}/presynthesize`, upload, cache, providers |
| `scripts/kokoro_server.py` | small | Fly.io kokoro-onnx FastAPI server (`/v1/synthesize`) |
| `web-next/src/features/reader/ReaderRoute.tsx` (`playWord` ~line 3650) | — | The actual playback entry point — NOT the audio-settings preview |

## Architecture (don't re-derive this)

### Backend

- **Synthesis is per-chunk** (`prepare_live_synthesis_chunks` → `synthesize_provider_audio`). Each chunk gets a deterministic SHA-1 cache key (`build_live_audio_payload`, `LIVE_AUDIO_CACHE_VERSION`).
- **Cache key fields:** `bookId / provider / voice / model / outputFormat / narrationStyle / lengthScale / sentenceSilence / start / end`. Voice changes = full re-synth. Same voice = instant.
- **Presynth job** (`_run_presynth_job`) walks the book in 420-char chunks (boundaries at `.!?`), 4 workers parallel, retries 3×. Writes `.presynth-done.json` marker with provider+voice+cacheVersion.
- **Vercel limitation:** `threading.Thread(daemon=True)` is killed when the serverless function returns. Auto-presynth only actually completes on a long-lived host (uvicorn local, or the Fly.io Kokoro server itself). On Vercel the marker may never be written, but per-chunk caching in S3 still works for any chunk that DID complete before the lambda died.

### Frontend

- **The reader playback entry is `playWord` (line ~3650)**, not the audio-settings preview at line 2300. Don't be confused — the preview also has play/buffer/chunk machinery but is a separate component.
- **Gapless scheduling is already in place** via Web Audio API: `wordAudioCtxRef` / `ctx.createBufferSource` / `wordAudioScheduledEndRef`. Each chunk's `AudioBuffer` is decoded and scheduled at `max(now+0.002, lastScheduledEnd)`. Don't replace this with `new Audio()` — it WILL gap.
- **Bootstrap parallel chunks:** `PLAYBACK_BOOTSTRAP_CHUNKS` (line ~194). Default 2.
- **Prefetch ahead window:** `PREFETCH_AHEAD_TARGET` (line ~207). Default 3 for kokoro, 2 elsewhere.
- **Client-side presynth gate:** `useEffect` at line ~2954 only fires for `effectiveTtsProvider === 'kokoro'`. To enable Gemini presynth, widen this gate.
- **Live-audio memory cache:** `liveAudioMemoryCache` (line ~212). 10-min TTL, key matches backend exactly. Read-ahead prefetch on scroll uses it (line ~3001).
- **Per-chunk double-fetch:** `playableAudioUrl` (line ~367) — when audio is local-served (`/library/...`), the frontend fetches the URL a second time as an authenticated blob. S3-served URLs skip this.

## Where latency actually comes from (in order)

1. **Kokoro Fly.io cold start** — shared-cpu-2x machine sleeps after idle. First synth = 5–30 s. Mitigated by `/api/providers/warmup` (line ~5552) firing on reader open. NOT mitigated for first-ever upload.
2. **Per-chunk synthesis time** — Gemini ~2–4 s/chunk, Kokoro ~0.5–2 s/chunk warm. With prefetch=3 ahead and chunks=420 chars (~30 s audio each), the queue stays full as long as synthesis is faster than playback. If synthesis is slower, you starve.
3. **No upload-time presynth** — was kokoro-only and only fired when the reader opened. Now fires from `import_book_source` via `_kickoff_auto_presynth` for any available provider with a known default voice (best effort; Vercel kills the thread but caches partial work).
4. **Auth blob double-fetch** — only on local serving. On S3 it's a single fetch.

## What NOT to do

- **Don't replace Web Audio gapless with `new Audio()` or `<audio>` element** in the main reader path. Gaps WILL appear between chunks. `new Audio()` is fine for the audio-settings preview (single chunk, user is auditioning a voice).
- **Don't bump prefetch ahead past ~6** — each prefetched chunk is a real Kokoro/Gemini API request. Costs scale linearly. Hard ceiling: budget × cost/chunk.
- **Don't add MediaSource streaming without rewriting Kokoro server** — kokoro-onnx returns a complete WAV. To stream you'd need to chunk the model output and send via chunked-transfer-encoding. Doable but not a one-session task.
- **Don't change the cache key shape** without bumping `LIVE_AUDIO_CACHE_VERSION` or every cached audio file in S3 becomes orphaned.
- **Don't presynth without a marker** — the existence check at `book_live_audio_dir(book_id) / ".presynth-done.json"` is what makes re-opens instant. Skipping it = re-running synth on every open.

## How to test changes

```bash
# Terminal 1 — backend
cd C:/Users/miroa/storybook-reader
uvicorn server.app:app --host 127.0.0.1 --port 8000 --reload

# Terminal 2 — frontend
cd C:/Users/miroa/storybook-reader/web-next
npm run dev   # port 5175, proxies /api → 127.0.0.1:8000
```

Upload a small text file via the UI. Watch terminal 1 for `presynth-` thread logs.
Open the book — first play should be a cache hit (instant). If it's not, check
`library/<bookId>/live_audio/.presynth-done.json` and the `*.wav` files there.

For E2E:

```bash
cd web-next
npm run test:e2e   # Playwright; uses VITE_USE_MOCKS=1 — does NOT exercise real TTS
```

Real TTS testing requires `VITE_USE_MOCKS` unset and live API keys.

## Vercel-specific gotchas

- `threading.Thread` daemon dies on lambda return. Auto-presynth on upload won't complete server-side on Vercel. The frontend's `useEffect` presynth call DOES still work because it returns a `jobId` and the work runs in the same lambda invocation that handles each `live-audio` chunk request — but only chunks the user actually scrolls past will get cached.
- For true server-side presynth in production: deploy a separate worker (Fly machine, Cloud Run job, or a Vercel Cron that walks pending books).
- `BOOK_STORAGE_BUCKET` + AWS creds must be set in Vercel **production** env (not just preview/dev). Without S3 the cache is local to one lambda invocation and lost.
