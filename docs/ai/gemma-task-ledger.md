# Gemma Task Ledger

## Current Status
- [x] Memory system for Gemma integration created and repo-tracked.
- [x] Phase 1 implementation completed.
- [x] Runtime choice for local Gemma execution locked in code.
- [x] Backend provider chain now supports Gemma-first, OpenAI fallback, and dictionary fallback behavior.
- [x] Backend compile and vocabulary test suite passed in the project virtual environment.
- [x] Ollama installed locally and verified.
- [x] Gemma 4 model installed locally and verified.
- [x] Real local Gemma smoke test completed against a running model.
- [x] Frontend request budget updated for slow local vocabulary generation.
- [x] Live Vocabulary Studio flow validated end-to-end against a stable current-code backend.
- [x] UI now distinguishes local Gemma output from dictionary fallback output.
- [x] Generated vocabulary context is now cached persistently in the vocabulary database.
- [x] The first context request for a card now uses the cacheable default path; explicit retries still request a new variation.
- [x] Live cache validation proved a repeated default context request drops from about 115 seconds to about 0.01 seconds on this machine.
- [x] Gemma prompt and grounding were tightened to prefer short everyday contexts over invented literary analysis.
- [x] A real post-tuning sample for card `98b5c5ed95a1` returned a grounded everyday context in about 76 seconds.
- [x] Additional real saved-card samples for `recurring`, `architecture`, and `insightful` all returned grounded local Gemma context without drifting into book-analysis filler.
- [x] Phase 2 started with an optional Gemma cleanup path in `pdf_to_audio.py`.
- [x] Phase 2 now has tests for prompt construction, successful cleanup parsing, regex fallback, and paragraph-break preservation.
- [x] A real Storyworthy extraction sample completed successfully through Gemma cleanup after switching to `think: false` and smaller cleanup chunks.
- [x] A cheap structural heuristic now keeps cleaner extraction chunks on the regex path and only sends noisy chunks to Gemma.
- [x] Phase 2 now caches successful cleanup chunks persistently and validates cleanup output before accepting it.
- [x] A repeated Storyworthy cleanup run dropped from about 180 seconds to about 39 seconds because cached cleanup chunks were reused.

## Completed Phases
- [x] Phase 1: Local vocabulary context provider

## Active Phase
- Phase 2: Pre-TTS text cleanup

## Next Phase
- Phase 3: Chapter and structure extraction

## Last Completed Step
- Added persistent cleanup chunk caching plus validation guards in `pdf_to_audio.py`, then re-ran the Storyworthy sample twice and measured the second run dropping from about 180 seconds to about 39 seconds because four previously cleaned Gemma chunks were reused from cache.

## Next Concrete Step
- Compare Gemma-cleaned audiobook input against the regex-only baseline on one or two real books and decide whether the cleanup quality improvement justifies wiring phase 2 into the broader audio pipeline instead of keeping it CLI-only.

## Open Risks / Blockers
- `gemma4:latest` is installed but is too memory-hungry for this machine under current free RAM, so larger tags remain optional rather than safe defaults.
- Resource requirements and latency for acceptable local output quality are only partially measured so far; the real provider path is working but slow on this machine.
- The frontend still retries port `8000` when a local same-origin backend is down, which can mask validation if the intended backend process is not kept stable.
- Real `pdf_to_audio.py` cleanup now succeeds on a Storyworthy sample, the heuristic gate plus cache materially reduce repeat cost, but first-run cleanup is still expensive enough that broader app integration needs a quality-versus-cost decision.

## Files Expected To Change Next
- `pdf_to_audio.py`
- `README.md`
- `.env.example`
- `docs/ai/gemma-task-ledger.md`

## Validation Still Required
- Compare Gemma-cleaned audiobook input against the regex-only baseline on one or two real books and evaluate whether the cleanup quality justifies the extra runtime.
- Verify failures return the current dictionary-grounded payload instead of a raw provider error in a live server run.
- Decide whether `gemma4:e2b` remains the default for phase 1 and early phase 2 work on this hardware.

## Update Rules
- Update this file after every meaningful Gemma implementation step.
- Keep entries operational and short.
- Move durable architectural decisions to `docs/ai/gemma-decisions.md`.
