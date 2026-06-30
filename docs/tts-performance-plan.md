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
- Gemini TTS is implemented in the Cloudflare Worker but remains disabled until `GEMINI_API_KEY` is added as a Worker secret.
- The Reader chunks audio and prefetches ahead, but orchestration still lives inside `ReaderRoute.tsx`.

## Engineering Plan

1. Add edge caching for Gemini WAV chunks.
2. Enable R2 for persistent cross-colo Gemini storage when the Cloudflare account allows it.
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
- 2026-06-30: Added a Worker Cache API fallback plan for Gemini chunks. This gives repeat-request wins without extra account setup, but it is not a durable replacement for R2.
- Next: deploy Worker Cache API chunk caching, then enable real Gemini smoke tests after `GEMINI_API_KEY` is configured.
