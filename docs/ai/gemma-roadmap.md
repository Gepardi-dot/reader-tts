# Gemma Integration Roadmap

## Goal
- Add a local Gemma-powered enrichment layer to Storybook Reader so the app can improve vocabulary coaching and document understanding without depending on cloud inference for every advanced feature.

## Non-Goals
- Do not replace existing TTS providers (`piper`, `google`, `openai`, `polly`, `qwen`).
- Do not put Gemma inference on the page-turn or reader rendering hot path in the first rollout.
- Do not expand the first phase into OCR, RAG, or full-book assistants before the vocabulary provider is stable.

## Current Repo Fit
- `server/vocabulary_studio.py` already contains a pluggable context-generation path and an OpenAI-backed fallback, which makes it the cleanest first integration target.
- `server/app.py` already owns dictionary lookup, highlights, vocabulary import, and live/provider orchestration, so Gemma-related provider wiring should stay server-side first.
- `pdf_to_audio.py` already extracts and cleans text, which creates a natural later insertion point for Gemma-assisted text cleanup and structure recovery.
- `web/src/components/VocabularyLearning.tsx` already exposes “Fresh context” generation, so the first user-visible Gemma win can reuse the current UI flow with minimal frontend churn.

## Rollout Phases

### Phase 1: Local Vocabulary Context Provider
- Add a Gemma-backed local provider for vocabulary context generation.
- Keep the existing API contract returned by `generate_card_context()`.
- Preserve dictionary-grounded fallback behavior when local inference is unavailable or fails.

### Phase 2: Pre-TTS Text Cleanup
- Add an optional Gemma-assisted text normalization pass before audiobook chunking.
- Target header/footer removal, broken hyphen repair, pagination noise cleanup, and chapter-boundary preservation.
- Keep the existing regex cleaner as the default fallback.

### Phase 3: Chapter And Structure Extraction
- Add Gemma-assisted document structure recovery for headings, chapter starts, scene breaks, and special block types.
- Feed the recovered structure into navigation and later audiobook chunking improvements where safe.

### Phase 4: Scanned PDF Fallback
- Add a fallback path for low-extraction or image-heavy PDFs using page-image understanding plus cleanup.
- Restrict the first version to salvage and cleanup, not a full OCR replacement pipeline.

### Phase 5: Book Q&A
- Add a local question-answering workflow scoped to the current book or selected passage.
- Reuse prior chunking/structure work so answers remain grounded in local content.

## Success Criteria

### Phase 1
- Vocabulary context can be generated locally without OpenAI.
- Existing frontend context rendering works without API shape changes.
- Failures degrade cleanly to the current dictionary-backed fallback.

### Phase 2
- Cleaned text produces fewer visible artifacts in generated audio inputs.
- The cleanup step can be switched off or bypassed safely.
- Existing non-Gemma extraction paths still work unchanged.

### Phase 3
- Recovered structure improves chapter detection on messy books.
- The output is deterministic enough to drive UI navigation safely.
- No regression to current reader pagination for books without Gemma processing.

### Phase 4
- Scanned or poorly extracted PDFs have a viable recovery path.
- The fallback activates only when extraction quality is poor enough to justify the extra cost.
- The recovered text is still passed through existing cleanup and chunking safeguards.

### Phase 5
- Answers are grounded in local book text, not generic model recall.
- The feature is scoped and optional, not a global chat surface across the app.
- The implementation reuses the same server-side provider boundaries created in earlier phases.

## Deferred / Out Of Scope
- Direct Gemma-based speech synthesis.
- Replacing offline dictionary lookup with Gemma.
- Fine-tuning or LoRA work before a baseline local integration exists.
- Real-time Gemma assistance during page turns or text selection.
- Full multi-book semantic search before book-scoped Q&A exists.
