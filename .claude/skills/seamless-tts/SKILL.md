---
name: seamless-tts
description: Invariants, current state, and known problems for TTS playback in storybook-reader. Read before touching any audio path code — and treat the "current state" section as replaceable, not sacred.
---

# Seamless TTS

Line numbers drift — grep for symbols. This file separates correctness rules (don't violate) from current implementation (replaceable) from known problems (rethink-worthy).

## Hot files
- `web-next/src/features/reader/ReaderRoute.tsx` — playback state, prefetch, gapless scheduling
- `web-next/src/workers/kokoroWorker.ts` — on-device ONNX/Kokoro inference (Web Worker)
- `web-next/src/shared/storage/modelCache.ts` — worker lifecycle, status broadcast, `synthesizeLocal` + `synthesizeLocalStreaming`, shared `localKokoroCacheKey`
- `web-next/src/shared/storage/rollingVoiceCache.ts` — "Use this voice" background queue that walks the presynth grid, synth-and-persists every chunk to IndexedDB, and yields the worker to playback synths via `notePlaybackFetchStart`/`End`
- `web-next/public/sw.js` — service worker; caches Hugging Face Hub model bytes (`kokoro-model-v1`) and injects CORP for COEP compliance
- `vercel.json` + `web-next/vite.config.ts` — COOP/COEP headers; required for SharedArrayBuffer (multi-threaded WASM)
- `server/app.py` — `/api/books/{id}/live-audio`, `/api/books/{id}/presynthesize`, cache, providers
- `scripts/kokoro_server.py` — Fly.io Kokoro server (not yet deployed)
- Playback entry: grep `playWord` in ReaderRoute. The audio-settings preview is a separate code path.

---

## Hard invariants — violating these breaks correctness

**Cache key bump on field change.**
`build_live_audio_payload` SHA-1s: bookId / provider / voice / model / outputFormat / narrationStyle / lengthScale / sentenceSilence / start / end. Adding or removing any field → bump `LIVE_AUDIO_CACHE_VERSION` (current: 7). Skipping the bump orphans every cached S3 audio file.

**No module-global caches on Vercel.**
Per-process dicts/sets only persist within one lambda invocation. Any cache must be S3 / Supabase / external — never in-memory.

**Vercel cannot run background work.**
`threading.Thread(daemon=True)` dies when the lambda returns. Any "fire and forget" path on Vercel will be killed mid-flight. Per-chunk S3 caching still lands whatever completes before death.

**Speed control must preserve pitch.**
`AudioBufferSourceNode.playbackRate` shifts pitch with speed (chipmunk effect). Web Audio is therefore restricted to exactly 1.0×; any non-1.0 rate plays through `HTMLAudioElement` with `audio.preservesPitch = true`. Mid-chunk rate change while on the Web Audio path swaps engines at the current buffer position. Don't reintroduce `source.playbackRate.value = audioRate` on a bufferSource — pitch will distort.

**Z-index ladder (bump one → check all).**

| z-index | Element | Notes |
|--------:|---------|-------|
| `z-[54]` | *(removed)* | Playback highlight is an inline `mark`, not a fixed overlay |
| `z-[55]` | Selection overlay | `pointer-events-none` |
| `z-[60]` | Selection action menu | Vocab/dictionary/play popup |
| `z-[65]` | BottomSheet | Container + backdrop |
| `z-[70]` | Toast | `pointer-events-none` |
| `z-[200]` | Audio/Appearance panel backdrop | `fixed inset-0`, `pointer-events: all` when open |
| `z-[201]` | Audio/Appearance panel | Inline popover, bottom-right |
| `z-[300]` | shadcn Select portal | `components/ui/select.tsx` — must stay above panel+backdrop |

New element at `z-[6x]` or higher: add it to this table AND verify against sheet/dropdown layering.

---

## Current implementation — descriptive, not prescriptive

If a user reports a quality problem, suspect the implementation before defending it. Each item below is a choice that was made, not a law of nature.

- **TTS v3 runtime** (`tts-engine/ttsRuntime.ts`): imperative producer/consumer. React only observes snapshots. See `docs/tts-v3-runtime.md`.
- **Playback window**: hosted Kokoro/Gemini chunk from the tap through the rest of the book. `AUDIO_SLICE_CHARS` is only the scroll-warmup window, not session length.
- **AudioClock** appends WebAudio buffers end-to-end; underruns wait for the producer instead of stop/restarting the graph. A silent keep-alive keeps the context running; missed `onended` is recovered from the timeline; a watchdog retries the next chunk if the clock goes dry.
- **Gesture unlock**: `AudioClock.unlock()` runs on pointerdown/keydown and again synchronously at Play, before any live-audio await.
- **Kokoro streams sentence PCM** via `synthesizeLocalStreaming` → `pcmToAudioBuffer` → clock.append as each frame arrives (first-audio no longer waits for full WAV). Full WAV still cached to IndexedDB on complete.
- **Gemini** loads full live-audio chunks (edge/R2 cache) and appends when decoded; cold miss shows buffering, never silent browser-speech mask.
- **Live-audio fetch** has a 50s client timeout and one retry on 502/timeout so a hung Fly request cannot occupy the in-memory cache forever.
- **Browser speech** is a selected provider only (`browser`), not a hidden fallback for native voices.
- **On-device Kokoro model path** unchanged: worker + `kokoro-model-v1` SW cache + COOP/COEP for WASM threads.
- **Chunk sizes** (approx): Kokoro first ~95 / mid ~160 / steady ~280; Gemini first ~110 / follow ~280; Kokoro prefetch ahead 2, Gemini 1.

---

## Known problems worth rethinking

These are *not* "things to work around" — they are signals that the architecture should change.

| Problem | Likely better path |
|---------|-------------------|
| Gemini cold-start latency on every fresh chunk | Warm first 1–2 chunks on book open / play intent; keep edge+R2 cache hot |
| Voice switch re-warms whole book (single-provider marker) | Marker keyed per `provider+voice`; warm caches stay warm |
| Non-1.0 rate still uses `playbackRate` (pitch shift) | Pitch-preserving path for rate ≠ 1 (HTMLAudio or time-stretch) |
| Preview panel may still use a separate audio path | Route preview through `TtsRuntime` with a short text range |

If you fix one of these, **delete the corresponding row** and update "Current implementation" to match.

---

## When the user reports bad TTS

1. **Don't reach for a patch inside the current architecture by default.** A 2026-frustrated user reporting "TTS is fucked up" is evidence the architecture is wrong, not that one line needs tweaking.
2. **Ask for the specific symptom:** which provider, gaps vs. latency vs. cutoff vs. wrong voice vs. robotic, desktop vs. mobile, cold load vs. mid-session.
3. **Pull evidence before guessing:** Vercel runtime logs for `/api/books/*/live-audio`, browser console, network tab waterfall.
4. **If the root cause requires breaking an "invariant" in this file, propose that.** The Hard Invariants list is correctness-only; everything else can be replaced. Update or delete the section that contradicts the fix in the same commit.
5. **`web-rewrite/` is legacy and not deployed** — production is `web-next/`, don't go diff-archaeology there.

---

## Sanity checks before claiming done

Type-check passing is NOT enough. Exercise the actual user path:

```bash
# Backend
uvicorn server.app:app --host 127.0.0.1 --port 8000 --reload

# Frontend
cd web-next && npm run dev   # port 5175, proxies /api → :8000

# Typecheck + build
cd web-next && npm run typecheck && npm run build
```

Manual UX checks:
- Open reader → press play → first audio within 1–2s on warm cache, ≤4s cold
- Switch voice mid-book → next page synthesizes with new voice without errors
- Open audio settings sheet while audio plays → no z-index bleed
- Let it play across a page boundary → no audible gap
- iOS Safari: lock screen, return → audio resumes (or fails predictably)
