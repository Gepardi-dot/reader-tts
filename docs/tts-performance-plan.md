# TTS Performance Plan

## End Goal

ReaderTTS should feel instant and stay smooth: tapping text should start audible playback immediately, and Kokoro/Gemini narration should continue without stalls during normal reading.

## Success Targets

- Tap-to-first-audio: under 100 ms for cached or browser fallback playback.
- Kokoro after warmup: first high-quality chunk scheduled under 200 ms.
- Gemini cache hit: first chunk returned from Cloudflare storage under 150 ms.
- Gemini cache miss: browser speech masks the network round trip, then Gemini takes over at a chunk boundary.
- Playback quality: no repeated gaps between chunks once two chunks are buffered.

## Current State

- Browser speech is the default instant provider and starts on word tap.
- Kokoro runs in a browser Worker, caches model assets, and can synthesize locally after warmup.
- Gemini TTS is enabled in the Cloudflare Worker and passes authenticated provider-preview synthesis.
- R2 is active for durable Gemini live-audio cache storage, with the edge Cache API still serving as the fastest first-level cache.
- The Reader chunks audio and prefetches ahead, and records lightweight TTS latency events for tuning.

## Engineering Plan

1. Keep edge caching for local Gemini WAV chunk repeat hits.
2. Use R2 for persistent cross-colo Gemini storage.
3. Keep Browser speech as the immediate fallback for uncached Gemini or cold Kokoro.
4. Move playback scheduling into a dedicated audio engine so React rendering does not drive timing.
5. Use lightweight telemetry for tap latency, cache hits, chunk generation time, stalls, and handoffs.
6. Tune chunk sizes separately for Browser, Kokoro, and Gemini.

## TTS v2 Architecture

The legacy `wordAudioController.ts` path mixed React state, browser speech, HTMLAudio, WebAudio, provider fetches, streaming, cache writes, and cancellation in one hook. TTS v2 replaces that with a small engine under `web-next/src/features/reader/tts-engine/`.

The invariant is: tapping text starts audible browser speech immediately when the browser supports it. Kokoro and Gemini run in the native lane in parallel, but native playback may only take over at a chunk boundary after the queue has enough contiguous buffered audio. If native audio underruns, playback bridges back to browser speech instead of entering silent loading.

The reader UI remains the same playbar contract: phase, current chunk, total chunks, toggle, stop, and word tap playback. React observes engine state; it does not schedule audio timing.

## Decisions

- Browser speech remains the fastest default because it has no model download or network dependency.
- Kokoro is the preferred free high-quality path after warmup.
- Gemini is an optional cloud quality path and must be cached aggressively to control latency and cost.
- Do not reintroduce the old Vercel/Supabase audio path.

## Working Notes

- 2026-06-30: Cloudflare Worker and Pages are the active deployment targets.
- 2026-06-30: PR #9 made Browser speech first-class and instant on tap.
- 2026-06-30: PR #10 added Gemini TTS provider support in the Worker.
- 2026-06-30: R2 bucket creation failed with Cloudflare `10042`; R2 must be enabled in the Cloudflare dashboard before a bucket can be created.
- 2026-06-30: PR #11 deployed Worker Cache API chunk caching for Gemini live-audio responses. This gives repeat-request wins without extra account setup, but it is not a durable replacement for R2.
- 2026-06-30: Added a tested frontend startup policy so Gemini/cloud playback starts browser speech immediately while native chunks fetch, then switches at chunk boundaries when native audio is ready.
- 2026-06-30: Reduced playback-time allocations by patching ref-held audio chunks in place instead of cloning the chunk array on each stream/status update.
- 2026-06-30: Primed and cached browser speech voice selection before first playback so the instant fallback path avoids synchronous voice discovery on tap.
- 2026-06-30: Browser speech now keeps one utterance queued ahead for browser-only and cold-Kokoro fallback playback, reducing chunk-boundary gaps without blocking Gemini native handoff.
- 2026-07-01: Added `GEMINI_API_KEY` as a Cloudflare Worker secret, redeployed `reader-tts-api`, and confirmed `/api/providers` reports Gemini available. Authenticated `/api/providers/test` produced a WAV data URL with `gemini-2.5-flash-preview-tts` in about 6 seconds.
- 2026-07-01: Extracted Web Audio buffer start/end/seek calculations into tested playback helpers so the next controller pass can focus on imperative media handles instead of duplicated timing math.
- 2026-07-01: Enabled R2, created `reader-tts-audio-cache`, and added the Worker `AUDIO_CACHE` binding for durable Gemini WAV cache storage.
- 2026-07-01: Added authenticated performance telemetry for TTS play starts, first-audio latency, and Gemini live-audio fetch timing with cache source metadata.
- 2026-07-01: Added an authenticated TTS telemetry summary endpoint for p50/p95 timing, cache hit rates, cache-source counts, and recent compact events.
- 2026-07-01: Staged provider/voice changes inside the audio panel so dropdown movement previews locally and only the explicit Apply action mutates reader playback or persisted preferences.
- 2026-07-01: Extracted the reader word-audio playback controller from `ReaderRoute.tsx` so media refs, chunk fetches, streaming buffers, pause/resume, and stop cleanup are isolated from route rendering.
- 2026-07-01: Made the playbar primary control deterministic: loading clicks cancel, playing clicks pause, and paused clicks resume or restart the current chunk if the underlying media handle has gone stale.
- 2026-07-01: D1 telemetry showed cold Kokoro browser fallback sometimes spoke 585-character grid chunks with first-audio near 1.8s, so the cold-grid path now re-chunks from the tapped offset with Kokoro's short first chunk.
- 2026-07-01: Word-audio native startup now primes a reusable HTMLAudio element during the original tap whenever Gemini handoff or native Kokoro playback may need HTMLAudio fallback, matching the existing mobile unlock pattern from the audio preview player.
- 2026-07-01: D1 telemetry showed a generated Gemini miss on a 571-character chunk taking 22.4s and cached 346-424 character follow-up chunks still taking hundreds of ms, so Gemini now uses 160-character first chunks, 320-character follow-up chunks, and three-chunk bootstrap/read-ahead.
- 2026-07-01: Gemini native playback now bridges late native chunks with browser speech at chunk boundaries instead of going silent in a loading state, and records `tts.native_gap_bridge` telemetry for follow-up tuning.
- 2026-07-05: Started TTS v2 reengineering. The reader now has a separate engine scaffold for deterministic segmentation, native queue buffering, browser fallback, and native handoff policy.
- 2026-07-05: Verified TTS v2 with unit tests, typecheck, lint, production build, and Playwright against browser-speech and Gemini-selected reader playback controls.
- Next: gather `tts.*_v2` telemetry from real use, tune handoff thresholds, then move low-level live-audio helpers out of the legacy controller so `wordAudioController.ts` can be retired.
