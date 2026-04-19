# Vocabulary Studio

## Overview

Vocabulary Studio is a server-backed vocabulary trainer for Storybook Reader.

It replaces the old browser-local SRS prototype with:

- durable decks, notes, cards, and review logs
- AI-guided practice attempt logs
- FSRS scheduling on the backend
- due-first session selection
- same-day sibling burying
- a fast review loop built around retrieval before reveal and bounded AI coaching
- a separate manual lesson mode for saved vocabulary
- dictionary-grounded context generation
- pronunciation-aware review support
- productive-use enforcement for new/learning words

## Why FSRS

The scheduler runs in Python with [`fsrs`](https://pypi.org/project/fsrs/), the maintained `py-fsrs` implementation from Open Spaced Repetition.

This repo already uses a Python FastAPI backend, so keeping scheduling server-side avoids split-brain logic between the client and server while still following the FSRS requirement.

Default scheduler settings:

- `requestRetention: 0.90`
- `enableFuzz: true`
- `learningSteps: ['1m', '10m']`
- `relearningSteps: ['10m']`
- `maximumInterval: 36500`
- `newCardsPerDay: 6`
- `siblingBurying: true`

## Storage

The feature stores its data in `library/vocabulary-studio.sqlite3`.

Schema is applied through SQL migrations in:

- `server/migrations/001_vocabulary_studio.sql`
- `server/migrations/002_vocabulary_studio_production.sql`
- `server/migrations/003_vocabulary_studio_practice_attempts.sql`

Main tables:

- `decks`
- `notes`
- `cards`
- `review_logs`
- `production_logs`
- `practice_attempts`
- `card_context_cache`
- `schema_migrations`

The backend currently uses a single local user id: `local-reader`.

## Backend Shape

Implementation lives in `server/vocabulary_studio.py`.

Key responsibilities:

- `VocabularyStudioService`: schema bootstrap, deck/note/card CRUD, session selection, analytics, review logging
- `create_vocabulary_router(...)`: mounts the FastAPI endpoints under `/api/vocabulary`

Current endpoints:

- `GET /api/vocabulary/decks`
- `POST /api/vocabulary/decks`
- `GET /api/vocabulary/decks/{deck_id}`
- `POST /api/vocabulary/decks/{deck_id}/notes`
- `POST /api/vocabulary/decks/{deck_id}/imports/archive`
- `POST /api/vocabulary/decks/{deck_id}/practice-sessions`
- `GET /api/vocabulary/decks/{deck_id}/session`
- `POST /api/vocabulary/cards/{card_id}/reviews`
- `POST /api/vocabulary/cards/{card_id}/lesson`
- `POST /api/vocabulary/cards/{card_id}/coach`
- `POST /api/vocabulary/cards/{card_id}/context`
- `POST /api/vocabulary/cards/{card_id}/production`
- `PATCH /api/vocabulary/cards/{card_id}`

Additional backend notes:

- The spacing preview shown in the UI is derived from the real FSRS scheduler, not hardcoded intervals.
- Archive imports preserve dictionary-derived pronunciation when available.
- Context generation is grounded in the offline dictionary payload first, then optionally expanded with OpenAI.
- If `OPENAI_API_KEY` is unavailable or generation fails, the context endpoint falls back to dictionary-only output.
- Gemma is the first-choice provider for lesson plans, answer coaching, and sentence coaching when configured locally.
- OpenAI mirrors the same structured contracts as a fallback for lesson plans, answer coaching, and sentence feedback.
- If no AI provider is available, deterministic fallback feedback keeps review and lesson flows usable.

## Session Rules

- Due learning/review/relearning cards are always selected before new cards.
- New cards are capped by the deck config.
- Sibling burying hides other cards from the same note for the rest of the day, but does not hide the same card when it re-enters learning/relearning.
- Review logs are written on every rating and include timing, before/after state, and the typed response when present.
- Practice attempts are logged separately from review logs so AI coaching does not mutate FSRS history.
- The learner must make a recall attempt before the answer can be checked.
- Non-typed recall attempts are logged as `self_report` rather than passive reveal.
- New and learning cards require one productive-use checkpoint before the rating buttons unlock.
- The productive-use checkpoint stores exactly 3 original sentences in `production_logs`, and each sentence must include the target word.

## Current Review Flow

The current learner-facing review flow is intentionally tight:

1. See one cue.
2. Attempt recall by typing or explicitly marking that a recall attempt happened.
3. Check the answer.
4. Receive a capped 2-3 turn coaching exchange from Gemma/OpenAI/fallback.
5. See grounded corrective context inline when the answer is weak.
6. Listen to the word or sentence if needed.
7. If the card is still new/learning and has not yet been used productively, write 3 original sentences using the word and get sentence-level feedback.
8. Rate the card with `Again / Hard / Good / Easy`.

The manual lesson flow is separate from review:

1. Open `Practice with AI`.
2. Read a grounded context scene.
3. Explain the word in your own words.
4. Receive bounded AI coaching and retry if needed.
5. Listen and say the word aloud.
6. Write 3 original sentences and get sentence-level feedback.
7. Move to the next word without changing FSRS state.

## Frontend

The learner-facing UI lives in `web/src/components/VocabularyLearning.tsx` with styling in `web/src/components/vocabularyLearning.css`.

The current UI is a simplified single-flow experience, not a dashboard-heavy studio. Main behaviors:

- conservative deck home with due/new counts
- quick add for `basic`, `basic_reverse`, and `cloze`
- retrieval-first review loop
- bounded AI coaching in review mode
- manual AI lesson mode for saved vocabulary
- FSRS spacing preview
- optional multisensory support:
  - pronunciation display when available
  - browser/device speech playback fallback
  - card audio URL playback when present
- inline grounded context after weak answers
- required 3-sentence active-use block for new/learning words
- AI sentence feedback for production practice
- collapsible debug view for due date, retrievability, stability, and difficulty

The existing reader archive is integrated through the archive import action. Saved vocabulary highlights can be imported into a deck and enriched with dictionary definitions on the server when the user did not save one manually.

## Tests

Backend tests live in `server/tests/test_vocabulary_studio.py`.

Current coverage focuses on the behavior most likely to regress:

- deck and note creation through the API
- due-before-new ordering
- sibling burying
- relearning re-entry
- archive import with dictionary fallback
- archive import pronunciation propagation
- spacing growth across successful reviews
- self-reported retrieval attempt logging
- mixed practice-session queue selection
- lesson-mode non-mutation of FSRS state
- AI coaching fallback and suggestion logging
- grounded context generation and fallback behavior
- required 3-sentence production practice and validation

## Extension Points

- Add authenticated `user_id` resolution instead of `local-reader`
- Move the SQLite store to Postgres if hosted multi-user persistence becomes necessary
- Add note editing and card regeneration for cloze/basic+reverse notes
- Train per-user FSRS parameters once enough `review_logs` exist
- Add deck-level config editing in the UI
- Persist and review written production history in the learner UI
- Add stronger AI-based corrective feedback scoring if we later want semantic answer checking
