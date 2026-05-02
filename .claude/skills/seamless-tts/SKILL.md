---
name: seamless-tts
description: Invariants and footguns for TTS playback in storybook-reader. Read before touching any audio path code.
---

# Seamless TTS — invariants only

Line numbers drift — grep for symbols. This file contains only things invisible from the code itself.

## Hot files
- `web-next/src/features/reader/ReaderRoute.tsx` — all playback state, prefetch, gapless scheduling
- `server/app.py` — `/api/books/{id}/live-audio`, `/api/books/{id}/presynthesize`, cache, providers
- Playback entry: grep `playWord` in ReaderRoute. The audio-settings preview is a separate code path, not the reader.

## Invariants

**Cache key contract**
`build_live_audio_payload` SHA-1 fields: bookId / provider / voice / model / outputFormat / narrationStyle / lengthScale / sentenceSilence / start / end.
Adding or removing any field → bump `LIVE_AUDIO_CACHE_VERSION` (current: 7). Otherwise every S3 audio file is orphaned.

**Gapless audio = Web Audio API only**
Main reader uses `ctx.createBufferSource` scheduled at `max(now+0.002, lastScheduledEnd)`. Never replace with `new Audio()` or `<audio>` in the reader path — gaps will appear between chunks.

**Vercel thread death**
`threading.Thread(daemon=True)` dies when the lambda returns. Auto-presynth on upload won't complete on Vercel — only on long-lived hosts (uvicorn, Fly.io). Per-chunk S3 caching still lands whatever completes before the lambda dies.

**Presynth marker is single-provider**
`.presynth-done.json` records ONE provider+voice (whichever finishes last). If user switches providers and gets re-warm behavior next open, this is the cause.

**In-process caches are broken on Vercel**
Module-global dicts/sets only persist within one lambda invocation. No process-local cache without measured perf reason and correct cross-instance keying.

**MediaSource streaming not supported**
kokoro-onnx returns a complete WAV. Streaming requires rewriting the Kokoro server (chunked-transfer-encoding). Not a one-session task.

## Z-index ladder (bump one → check all)

| z-index | Element | Notes |
|--------:|---------|-------|
| `z-[54]` | Audio-follow highlight | `pointer-events-none` |
| `z-[55]` | Selection overlay | `pointer-events-none` |
| `z-[60]` | Selection action menu | Vocab/dictionary/play popup |
| `z-[65]` | BottomSheet | Container + backdrop |
| `z-[70]` | Toast | `pointer-events-none` |
| `z-[80]` | shadcn Select portal | `components/ui/select.tsx` — must stay above sheet |

New element at `z-[6x]` or higher: add it to this table AND verify against sheet/dropdown layering.

## Regression watchpoints
- Z-index bump without checking the full ladder above
- Cache key field change without `LIVE_AUDIO_CACHE_VERSION` bump → orphaned S3 audio
- `new Audio()` in main reader path → gaps between chunks
- Changing `ctx.resume()` gesture unlock → test iOS Safari (context suspension silently no-ops gapless scheduling)
- `web-rewrite/` is legacy and NOT deployed — don't edit it; production is `web-next/`
- Prefetch ahead > 6 → each chunk is a real API call, costs scale linearly

## Test commands

```bash
# Backend
uvicorn server.app:app --host 127.0.0.1 --port 8000 --reload

# Frontend
cd web-next && npm run dev   # port 5175, proxies /api → :8000

# Typecheck + build
cd web-next && npm run typecheck && npm run build
```
