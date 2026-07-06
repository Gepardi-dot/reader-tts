# TTS Product Finish Plan

## Objective

Finish ReaderTTS as a fast reader first: tapping text should produce audio immediately when possible, and selected Kokoro or Gemini voices should play continuously without confusing fallbacks, stale voices, or broken controls.

## Current Diagnosis

The current TTS path is better than the original implementation, but it is still too fragile. `useTtsSessionController` owns React state, provider selection, chunking, caching, network calls, decoding, queueing, WebAudio scheduling, pause/resume, cleanup, and telemetry. That shape makes every bug look local while the real problem is lifecycle coupling.

The product should move to a small imperative TTS runtime observed by React. React should render controls and highlights; it should not be responsible for audio timing.

## Architecture Target

Build a `TtsRuntime` under `web-next/src/features/reader/tts-engine/` with these boundaries:

- `Source`: turns a provider/voice/text range into audio chunks. Browser speech, Kokoro, and Gemini are separate source implementations.
- `Buffer`: owns request dedupe, cache lookup, active fetch cancellation, provider cooldown, and read-ahead.
- `Scheduler`: owns WebAudio scheduling and can append newly-ready chunks to an active run before the current chunk ends.
- `Session`: owns start/pause/resume/stop/voice-change state transitions and emits a small snapshot to React.
- `Telemetry`: records first audio, buffer depth, underruns, provider errors, and cache source without touching scheduling logic.

## Fastest Finish Path

1. Stabilize scheduling first. Replace one-chunk-at-a-time native handoff behavior with an appendable WebAudio scheduler so ready follow-up chunks are scheduled before gaps can happen.
2. Extract the session state machine from `useTtsSessionController` into pure tested code. Voice changes must create a new session generation and reject every stale async result.
3. Split provider sources. Kokoro and Gemini should expose the same `loadChunk()` contract and hide their cache/network/model details internally.
4. Replace the React hook with a thin adapter around `TtsRuntime`. The hook should subscribe to snapshots and forward commands only.
5. Use telemetry to tune, not guess. Every test session should be checked against first-audio latency, underrun count, native buffer depth, and provider errors.

## Product Rules

- Voice correctness wins. Kokoro/Gemini must never silently play a browser-default voice.
- Browser speech is the instant provider and emergency fallback, not a hidden mask for broken native playback.
- Gemini cache misses may buffer, but cache hits should start quickly and never burn read-ahead quota while idle.
- Kokoro may need warmup, but once warm, repeated chunks must come from IndexedDB or an already-hot worker.
- Every long operation must have cancellation, timeout, and user-visible recovery.

## Immediate Next Slice

Implement the appendable native scheduler. This is the smallest structural change that directly improves continuous playback and removes a major gap source without rewriting the whole runtime in one risky pass.

