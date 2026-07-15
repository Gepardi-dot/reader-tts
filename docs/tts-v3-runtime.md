# TTS v3 Runtime

## Goal

Instant, continuous Kokoro/Gemini playback. React never schedules audio.

## Architecture

```
TtsRuntime (commands + snapshot)
  ├── segmenter          text → chunks
  ├── BufferPool         producer: load/dedupe/prefetch
  │     └── chunkLoader  Kokoro stream PCM | Gemini live-audio
  └── AudioClock         consumer: append-only WebAudio timeline
```

Browser speech is a **selected provider only**. It does not mask Kokoro/Gemini.

## Instant play path (Kokoro)

1. Warm model on app/book open (`startWarmup`).
2. First text unit is short (~48 chars).
3. `synthesizeLocalStreaming` emits sentence PCM frames.
4. Each frame becomes an `AudioBuffer` and is **appended to the clock immediately**.
5. Follow-up chunks prefetch while audio plays.
6. Completed WAV is written to IndexedDB for cache hits.

## Gemini path

1. Short first chunk, sequential prefetch (quota-safe).
2. Edge/R2 cache hits decode and append as one unit.
3. Cold miss → `buffering` UI until first frame; no silent browser voice.

## Underruns

- If more frames are still loading → stay in `buffering`, wait for producer.
- If the next chunk is already ready → schedule it without stop/start.
- If the producer is idle → `ensure(next)` then append.
- When no more audio is expected and the timeline is dry → session ends.

## React surface

`useTtsSessionController` is a thin adapter: subscribe to snapshots, forward
`start` / `pause` / `resume` / `stop`. Same public API as v2 for `ReaderRoute`.

## Telemetry

- `tts.play_start_v2` (metadata includes `engine: 'v3'`)
- `tts.first_audio_v2`
- `tts.native_underrun_v3`
- Existing live-audio fetch/error/backoff events
