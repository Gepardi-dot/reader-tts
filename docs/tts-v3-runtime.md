# TTS Runtime

## Goal

Instant taps + continuous playback. React never schedules audio.

## Kokoro (cache-first engine)

```
Book open / scroll
  └── KokoroEngine.preheat()  → fills SegmentCache (12 segments)

Tap to play
  └── TtsRuntime.start() (hosted Kokoro / Gemini)
        ├── unlock AudioContext on the tap (before any await)
        ├── chunk from tap offset through end of book
        ├── cache hit → schedule AudioBuffer immediately
        ├── cache miss → live-audio fetch with timeout + one retry
        └── AudioClock keep-alive + underrun watchdog until user stops
```

**Product rule:** Instant is a **cache property**, not a synth-latency hope.
Preheat is first-class. Play is mostly “play what is already ready.”

| Piece | File |
|-------|------|
| Stable segments | `stableSegments.ts` |
| Memory + IDB cache | `segmentCache.ts` |
| Engine | `kokoroEngine.ts` |
| Clock | `audioClock.ts` |

## Gemini

Unchanged BufferPool + live-audio path (cloud chunk + edge/R2 cache).

## Browser speech

Selected provider only — never silently masks Kokoro/Gemini.
