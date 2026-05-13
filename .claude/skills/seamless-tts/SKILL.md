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
| `z-[54]` | Audio-follow highlight | `pointer-events-none` |
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

- **Gapless playback uses Web Audio API at 1.0× only.** `ctx.createBufferSource` scheduled at `max(now+0.002, lastScheduledEnd)`. Non-1.0 rates fall back to `HTMLAudioElement` (preservesPitch=true) — slight chunk-boundary gap, no pitch distortion. The single-shot synth path requires the full WAV in memory before playback starts; sentence-level chunks are produced by the worker (`synthesizeLocalStreaming`) but not yet plumbed into the Web Audio scheduler.
- **On-device Kokoro is the primary fast path.** Worker downloads `onnx-community/Kokoro-82M-v1.0-ONNX` (q8, ~82 MB) on app boot via `startWarmup()` in `main.tsx`. Service worker caches the bytes in `kokoro-model-v1` Cache Storage; `navigator.storage.persist()` is requested up-front. After model load, the worker runs a dummy `generate('a')` to compile WASM kernels — only then does it post `'ready'`. WASM threading is on when `crossOriginIsolated === true` (COOP/COEP headers).
- **Per-page synthesis (remote path).** Each request synthesizes one page worth of chunks. Page boundaries come from `paginateReaderText()` upstream of TTS.
- **Presynth marker is single-provider.** `.presynth-done.json` records ONE provider+voice (whichever finishes last). Voice switch → entire book re-warms.
- **kokoro-onnx returns complete WAVs.** Streaming would require the Kokoro server (`scripts/kokoro_server.py`) to switch to chunked-transfer-encoding.
- **SHA-1 cache key over 10 fields.** Any one field changing → cache miss → cold synth.
- **Live audio providers:** on-device `kokoro` (default, in-browser via kokoro-js + ONNX Runtime Web) plus remote fallbacks `google` (Gemini Flash TTS) and remote `kokoro` (via Fly.io, not yet deployed).

---

## Known problems worth rethinking

These are *not* "things to work around" — they are signals that the architecture should change.

| Problem | Likely better path |
|---------|-------------------|
| Web Audio API requires full WAV (single-shot synth) — first-audio latency = full chunk synth time | Use the streaming infrastructure already in `kokoroWorker.ts` (`pipeline.stream()` + `synthesizeLocalStreaming` in `modelCache.ts`) — wire sentence-level PCM chunks directly into the Web Audio scheduler |
| Voice switch re-warms whole book (single-provider marker) | Marker keyed per `provider+voice`; warm caches stay warm |
| Auto-presynth on Vercel never completes (daemon thread death) | Move synth to Fly.io worker; Vercel is wrong host for long-lived work |
| Gemini cold-start latency on every fresh chunk | Pre-warm on book open; or move default provider to Kokoro (in-browser path now warms on app boot) |
| `ctx.resume()` gesture unlock fragile on iOS Safari | Replace with persistent unlocked context on first user interaction |
| Cost-bounded prefetch (`ahead > 6 = expensive`) | Cost shouldn't gate UX; if latency is the complaint, lift the cap and use cheaper provider |

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
