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
- The Reader chunks audio and prefetches ahead, but orchestration still lives inside `ReaderRoute.tsx`.

## Engineering Plan

1. Keep edge caching for local Gemini WAV chunk repeat hits.
2. Use R2 for persistent cross-colo Gemini storage.
3. Keep Browser speech as the immediate fallback for uncached Gemini or cold Kokoro.
4. Move playback scheduling into a dedicated audio controller so React rendering does not drive timing.
5. Add lightweight telemetry for tap latency, cache hits, chunk generation time, and stalls.
6. Tune chunk sizes separately for Browser, Kokoro, and Gemini.

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
- Next: run real Gemini R2 cache-hit smoke tests after deployment, add latency telemetry, then move imperative media handles out of `ReaderRoute.tsx`.
