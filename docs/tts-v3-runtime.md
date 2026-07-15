# TTS Runtime

## Goal

Instant, continuous Kokoro/Gemini playback. React never schedules audio.

## Architecture

```
TtsRuntime (commands + snapshot)
  ├── KokoroPipeline (kokoro only)
  │     ├── stableSegments   sentence/clause map (cache-stable)
  │     ├── SegmentCache     memory + IndexedDB
  │     ├── producer pump    keep ~2s WebAudio watermark
  │     └── AudioClock       append-only consumer
  ├── BufferPool + chunkLoader (Gemini / cloud)
  └── BrowserSpeechLane (selected browser provider only)
```

Browser speech is a **selected provider only**. It does not mask Kokoro/Gemini.

## Instant play path (Kokoro)

1. Warm model on app/book open (`startWarmup`).
2. Map tap → stable segment id.
3. **Cache hit** (memory/IDB) → schedule whole segment immediately.
4. **Cache miss** → stream sentence PCM into the clock; write full segment to cache.
5. Producer keeps ~2s scheduled ahead (serialized ONNX).
6. Idle scroll prep fills SegmentCache around the viewport.

## Gemini path

1. Short first chunk, sequential prefetch (quota-safe).
2. Edge/R2 cache hits decode and append as one unit.
3. Cold miss → buffering until first frame; no silent browser voice.

## React surface

`useTtsSessionController` is a thin adapter: subscribe to snapshots, forward
`start` / `pause` / `resume` / `stop` / `prepareKokoroWindow`.

## Telemetry

- `tts.play_start_v2` (`engine: 'kokoro-pipeline' | 'v3'`)
- `tts.first_audio_v2`
- Existing live-audio fetch/error/backoff events
