# TTS Runtime

## Goal

Instant taps + continuous playback. React never schedules audio.

## Kokoro (cache-first engine)

```
Book open / scroll
  └── KokoroEngine.preheat()  → fills SegmentCache (12 segments)

Tap to play
  └── KokoroEngine.start()
        ├── model not ready → status "Downloading…" → auto-start when ready
        ├── cache hit → schedule AudioBuffer immediately
        ├── cache miss → stream PCM frames (first frame starts audio)
        └── fill loop keeps ~2.2s on the WebAudio timeline
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
