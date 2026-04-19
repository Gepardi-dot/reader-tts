# Gemma Decisions

## D-001: Gemma augments existing TTS providers
- Status: Accepted
- Date: 2026-04-03
- Decision: Gemma is an enrichment and document-understanding layer. It does not replace `piper`, `google`, `openai`, `polly`, or `qwen` for speech synthesis.
- Rationale: The repo already has working TTS providers and the immediate value of Gemma is local reasoning, grounding, and text transformation.

## D-002: First integration target is vocabulary context generation
- Status: Accepted
- Date: 2026-04-03
- Decision: The first Gemma feature will be local vocabulary context generation in `server/vocabulary_studio.py`.
- Rationale: That path already exists, has a narrow response contract, and can deliver offline value with minimal frontend disruption.

## D-003: Keep provider abstraction server-side first
- Status: Accepted
- Date: 2026-04-03
- Decision: Provider selection and Gemma orchestration should stay server-side initially, with the frontend continuing to call the existing vocabulary endpoints.
- Rationale: This keeps UI churn low and isolates runtime-specific complexity to the backend.

## D-004: Prefer local inference for privacy and offline capability
- Status: Accepted
- Date: 2026-04-03
- Decision: Where Gemma is used, prefer local execution over cloud inference for privacy-sensitive enrichment and offline support.
- Rationale: The app already positions itself around local reading, local storage paths, and offline-capable workflows.

## D-005: Keep Gemma off latency-critical reader interactions initially
- Status: Accepted
- Date: 2026-04-03
- Decision: Do not place Gemma in page-turn, text-selection, or other latency-sensitive reader interactions during the first rollout.
- Rationale: Local inference latency is variable and should not degrade the baseline reading experience.

## D-006: Start with an Ollama-compatible local HTTP runtime
- Status: Accepted
- Date: 2026-04-03
- Decision: Phase 1 Gemma integration uses an Ollama-compatible local HTTP endpoint rather than embedding `transformers` directly into the FastAPI process.
- Rationale: This keeps dependency weight down, simplifies runtime swapping, and makes timeouts and failure handling easier to isolate.

## D-007: Default to `gemma4:e2b` for local phase 1 work
- Status: Accepted
- Date: 2026-04-03
- Decision: Use `gemma4:e2b` as the practical default model for phase 1 vocabulary context generation, while allowing overrides through `GEMMA_MODEL`.
- Rationale: The machine used for implementation can install `gemma4:latest` but cannot run it reliably with the currently available memory, while `gemma4:e2b` runs successfully.

## D-008: Raise the default local Gemma timeout to 180 seconds
- Status: Accepted
- Date: 2026-04-03
- Decision: Use a 180 second default timeout for the local Gemma provider.
- Rationale: The real vocabulary-context prompt takes about 110 seconds on this Windows machine, so shorter defaults are too aggressive even though the model itself is working.

## D-009: Normalize imperfect Gemma JSON responses defensively
- Status: Accepted
- Date: 2026-04-03
- Decision: Accept minor schema drift from the local model, such as a string where an array was requested, and normalize it server-side before returning payloads to the UI.
- Rationale: Real local output can be close enough to salvage even when it does not perfectly match the requested JSON shape.

## D-010: Give the vocabulary context UI its own long request budget
- Status: Accepted
- Date: 2026-04-03
- Decision: Use a dedicated frontend timeout budget for `/api/vocabulary/cards/:id/context` instead of the standard 30 second API timeout.
- Rationale: The backend path is functioning, but local Gemma inference is slow enough that the UI must not treat it like a normal lightweight API request.

## D-011: Preserve provider provenance in the vocabulary UI
- Status: Accepted
- Date: 2026-04-03
- Decision: Keep distinct `source` values for local Gemma output and dictionary fallback output, and label them differently in the UI.
- Rationale: During live validation, masking local Gemma output as dictionary context made it hard to tell whether the provider path succeeded or silently fell back.

## D-012: Cache generated vocabulary context in SQLite and keep refresh explicit
- Status: Accepted
- Date: 2026-04-03
- Decision: Store successful generated vocabulary context in the vocabulary SQLite database, reuse it for the default card-context path, and reserve `refreshHint` for explicit “try another context” requests.
- Rationale: Local Gemma latency is the main usability problem in phase 1, so the first context fetch for a card must become cheap on repeat access without removing the ability to request a fresh variation.

## D-013: Constrain phase 1 Gemma output to everyday grounded scenarios
- Status: Accepted
- Date: 2026-04-03
- Decision: Sanitize the grounding payload passed to Gemma, prefer short everyday situations in the system prompt, lower generation randomness, and explicitly forbid invented literary-analysis context unless it appears in the supplied grounding.
- Rationale: Early live samples drifted into generic book-analysis language, which was less useful than concrete everyday practice context for vocabulary review.

## D-014: Start phase 2 as an opt-in CLI cleanup pass with per-chunk fallback
- Status: Accepted
- Date: 2026-04-03
- Decision: Gemma-assisted pre-TTS cleanup begins in `pdf_to_audio.py` as an explicit opt-in CLI flag, processes extracted text in chunks, and falls back to the existing regex cleaner for any chunk that fails.
- Rationale: This limits risk while testing whether local cleanup materially improves audiobook input quality, and it avoids breaking the existing free local CLI path when the model is slow or unavailable.

## D-015: Make phase 2 cleanup fail fast on this hardware
- Status: Accepted
- Date: 2026-04-03
- Decision: Use smaller default cleanup chunks and a shorter cleanup timeout for `pdf_to_audio.py` Gemma cleanup than for vocabulary generation, so real-book cleanup falls back quickly instead of stalling the CLI for many minutes.
- Rationale: A real extracted book sample timed out on every cleanup chunk on this machine, so the operationally correct default is fast fallback rather than long waits.

## D-016: Disable Gemma reasoning for phase 2 cleanup
- Status: Accepted
- Date: 2026-04-03
- Decision: Send `think: false` for `pdf_to_audio.py` Gemma cleanup requests.
- Rationale: On this hardware, cleanup requests only became reliable after reasoning was disabled; otherwise the model spent the budget on hidden thinking and frequently timed out or returned unusable empty output.

## D-017: Gate phase 2 cleanup by structural noise
- Status: Accepted
- Date: 2026-04-03
- Decision: Apply a cheap wrapped-line merge plus a per-chunk structural-noise heuristic before calling Gemma, and keep already-clean chunks on the regex path.
- Rationale: On the Storyworthy sample, this reduced Gemma cleanup from 10 chunks to 5 and cut runtime from about 323 seconds to about 143 seconds while preserving the ability to clean genuinely noisy extraction chunks.

## D-018: Cache accepted cleanup chunks and validate model output
- Status: Accepted
- Date: 2026-04-03
- Decision: Persist accepted cleanup output by chunk in a dedicated cleanup cache, and reject model output that drops too much text or otherwise fails basic retention checks before falling back to regex cleanup.
- Rationale: Phase 2 needs both repeat-run speedups and hard safety rails; on the Storyworthy sample, caching reduced a repeated cleanup run from about 180 seconds to about 39 seconds, while validation prevents low-quality cleanup from polluting TTS input.

## Decision Update Rule
- Add a new decision when an implementation choice would otherwise be rediscovered or re-debated in a later session.
- Do not store transient task status here; keep that in `docs/ai/gemma-task-ledger.md`.
