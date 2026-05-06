from __future__ import annotations

import gc
import json
import shutil
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import mkdtemp
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.gemma_provider import build_gemma_context_generator
from server.gemma_provider import _build_prompt_payload
from server.vocabulary_studio import (
    CardCoachRequest,
    CardProductionRequest,
    CardContextRequest,
    CardLessonRequest,
    CardReviewRequest,
    DeckCreateRequest,
    NoteCreateRequest,
    NoteMnemonicUpdateRequest,
    PracticeSessionRequest,
    VocabularyStudioService,
    create_vocabulary_router,
)


class VocabularyStudioTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = Path(mkdtemp())
        self.service = VocabularyStudioService(
            self.tempdir,
            dictionary_lookup=lambda term: {
                "source": "stub-dictionary",
                "pronunciation": f"/{term}/",
                "entries": [
                    {
                        "definition": f"{term} definition",
                        "notes": "dictionary note",
                        "examples": [f"{term} example"],
                    }
                ],
            },
        )
        app = FastAPI()
        app.include_router(create_vocabulary_router(self.service))
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()
        del self.client
        del self.service
        gc.collect()
        shutil.rmtree(self.tempdir, ignore_errors=True)

    def test_create_deck_note_and_dashboard_via_api(self) -> None:
        deck = self.client.post(
            "/api/vocabulary/decks",
            json={"title": "Spanish verbs", "description": "Core conjugation prompts"},
        )
        self.assertEqual(deck.status_code, 200)
        deck_id = deck.json()["id"]
        self.assertEqual(deck.json()["deck"]["id"], deck_id)

        note = self.client.post(
            f"/api/vocabulary/decks/{deck_id}/notes",
            json={
                "noteType": "basic_reverse",
                "front": "venir",
                "back": "to come",
                "topic": "travel",
                "tags": ["verbs", "starter"],
            },
        )
        self.assertEqual(note.status_code, 200)

        dashboard = self.client.get(f"/api/vocabulary/decks/{deck_id}")
        self.assertEqual(dashboard.status_code, 200)
        payload = dashboard.json()
        self.assertEqual(payload["deck"]["noteCount"], 1)
        self.assertEqual(payload["deck"]["cardCount"], 2)
        self.assertEqual(payload["notes"][0]["cards"][0]["cardType"], "basic")
        self.assertEqual(payload["notes"][0]["cards"][1]["cardType"], "reverse")

    def test_reader_saved_word_without_back_uses_dictionary_definition(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Reader deck"))
        note = self.service.create_note(
            deck["id"],
            NoteCreateRequest(
                noteType="basic",
                front="luminous",
                back=None,
                sourceRef="reader-vocab:luminous",
                metadata={"source": "reader-selection"},
            ),
        )

        self.assertEqual(note["note"]["front"], "luminous")
        self.assertEqual(note["note"]["back"], "luminous definition")
        self.assertEqual(note["note"]["metadata"]["dictionarySource"], "stub-dictionary")

        duplicate = self.service.create_note(
            deck["id"],
            NoteCreateRequest(
                noteType="basic",
                front="luminous",
                back=None,
                sourceRef="reader-vocab:luminous",
            ),
        )
        self.assertEqual(duplicate["note"]["id"], note["note"]["id"])
        dashboard = self.service.get_deck_dashboard(deck["id"])
        self.assertEqual(dashboard["deck"]["noteCount"], 1)

    def test_note_mnemonic_is_persisted_and_returned_in_sessions(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Mnemonic deck"))
        note = self.service.create_note(
            deck["id"],
            NoteCreateRequest(noteType="basic", front="laconic", back="using few words"),
        )
        note_id = note["note"]["id"]

        updated = self.service.update_note_mnemonic(
            note_id,
            NoteMnemonicUpdateRequest(mnemonic="Laconic sounds like lacking talk."),
        )
        self.assertEqual(updated["note"]["mnemonic"], "Laconic sounds like lacking talk.")
        self.assertEqual(updated["note"]["metadata"]["mnemonic"], "Laconic sounds like lacking talk.")

        session = self.service.get_session(deck["id"])
        self.assertEqual(session["currentCard"]["mnemonic"], "Laconic sounds like lacking talk.")

        cleared = self.client.patch(f"/api/vocabulary/notes/{note_id}/mnemonic", json={"mnemonic": None})
        self.assertEqual(cleared.status_code, 200)
        self.assertIsNone(cleared.json()["note"]["mnemonic"])

    def test_dynamic_user_provider_isolates_vocabulary_data(self) -> None:
        active_user = {"id": "user-a"}
        service = VocabularyStudioService(
            self.tempdir,
            user_id_provider=lambda: active_user["id"],
        )

        service.create_deck(DeckCreateRequest(title="A deck"))
        active_user["id"] = "user-b"
        service.create_deck(DeckCreateRequest(title="B deck"))

        self.assertEqual([deck["title"] for deck in service.list_decks()], ["B deck"])
        active_user["id"] = "user-a"
        self.assertEqual([deck["title"] for deck in service.list_decks()], ["A deck"])

    def test_due_cards_are_served_before_new_cards(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Priority deck"))
        self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="cue one", back="answer one"))
        first_session = self.service.get_session(deck["id"])
        current = first_session["currentCard"]
        self.assertIsNotNone(current)

        reviewed_at = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
        self.service.submit_review(
            current["id"],
            CardReviewRequest(rating="again", reviewedAt=reviewed_at),
        )
        self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="cue two", back="answer two"))

        next_session = self.service.get_session(deck["id"])
        self.assertIsNotNone(next_session["currentCard"])
        self.assertEqual(next_session["currentCard"]["id"], current["id"])
        self.assertEqual(next_session["currentCard"]["state"], "learning")

    def test_sibling_cards_are_buried_for_the_day(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Sibling deck"))
        self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic_reverse", front="architect", back="designer"))
        self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="atlas", back="collection of maps"))

        first_session = self.service.get_session(deck["id"])
        current = first_session["currentCard"]
        self.assertIsNotNone(current)

        review = self.service.submit_review(current["id"], CardReviewRequest(rating="good"))
        self.assertIsNotNone(review["nextCard"])
        self.assertNotEqual(review["nextCard"]["noteId"], current["noteId"])

    def test_review_logs_are_persisted_and_learning_card_returns(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Logs deck"))
        self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="opaque", back="not transparent"))
        first_session = self.service.get_session(deck["id"])
        current = first_session["currentCard"]
        self.assertIsNotNone(current)

        reviewed_at = (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
        review = self.service.submit_review(
            current["id"],
            CardReviewRequest(rating="again", answerMode="typed", typedResponse="unclear", reviewedAt=reviewed_at),
        )
        self.assertEqual(review["reviewLog"]["stateBefore"], "new")
        self.assertEqual(review["reviewLog"]["stateAfter"], "learning")

        next_session = self.service.get_session(deck["id"])
        self.assertEqual(next_session["currentCard"]["id"], current["id"])

        dashboard = self.service.get_deck_dashboard(deck["id"])
        self.assertEqual(len(dashboard["recentReviews"]), 1)
        self.assertEqual(dashboard["recentReviews"][0]["typedResponse"], "unclear")

    def test_self_report_retrieval_attempt_is_logged(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Retrieval deck"))
        self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="abundant", back="more than enough"))
        session = self.service.get_session(deck["id"])
        current = session["currentCard"]
        self.assertIsNotNone(current)

        review = self.service.submit_review(
            current["id"],
            CardReviewRequest(rating="good", answerMode="self_report"),
        )
        self.assertEqual(review["reviewLog"]["rating"], "good")

        dashboard = self.service.get_deck_dashboard(deck["id"])
        self.assertEqual(dashboard["recentReviews"][0]["answerMode"], "self_report")
        self.assertIsNone(dashboard["recentReviews"][0]["typedResponse"])

    def test_new_card_requires_three_sentence_production_before_completion(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Production deck"))
        self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="abundant", back="more than enough"))
        session = self.service.get_session(deck["id"])
        current = session["currentCard"]
        self.assertTrue(current["requiresProduction"])
        self.assertEqual(current["productionTarget"], "abundant")

        result = self.service.submit_card_production(
            current["id"],
            CardProductionRequest(
                sentences=[
                    "Abundant rain filled the river by morning.",
                    "We had abundant choices on the menu tonight.",
                    "The garden looked abundant after the long summer.",
                ]
            ),
        )
        self.assertTrue(result["accepted"])
        self.assertEqual(len(result["sentenceNotes"]), 3)
        self.assertEqual(result["productionCount"], 1)

        refreshed = self.service.get_session(deck["id"])
        self.assertFalse(refreshed["currentCard"]["requiresProduction"])
        self.assertEqual(refreshed["currentCard"]["productionCount"], 1)

    def test_production_requires_target_word_in_each_sentence(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Production validation deck"))
        self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="abundant", back="more than enough"))
        session = self.service.get_session(deck["id"])
        current = session["currentCard"]

        result = self.service.submit_card_production(
            current["id"],
            CardProductionRequest(
                sentences=[
                    "There was a lot of food at dinner.",
                    "Abundant rain filled the river by morning.",
                    "The garden looked abundant after the long summer.",
                ]
            ),
        )
        self.assertFalse(result["accepted"])
        self.assertIn('Use "abundant"', result["feedback"])
        self.assertEqual(result["productionCount"], 0)

    def test_good_reviews_expand_spacing_over_time(self) -> None:
        deck = self.service.create_deck(
            DeckCreateRequest(
                title="Spacing deck",
                config={"enableFuzz": False},
            )
        )
        self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="abate", back="become less intense"))
        session = self.service.get_session(deck["id"])
        current = session["currentCard"]
        self.assertIsNotNone(current)

        review_at = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
        intervals: list[timedelta] = []
        for _ in range(4):
            result = self.service.submit_review(
                current["id"],
                CardReviewRequest(
                    rating="good",
                    reviewedAt=review_at.isoformat().replace("+00:00", "Z"),
                ),
            )
            due_after = datetime.fromisoformat(result["reviewLog"]["dueAfter"].replace("Z", "+00:00"))
            intervals.append(due_after - review_at)
            review_at = due_after

        self.assertEqual(sorted(intervals), intervals)
        self.assertLess(intervals[0], timedelta(days=1))
        self.assertGreater(intervals[1], timedelta(days=1))
        self.assertGreater(intervals[-1], intervals[-2])

    def test_archive_import_uses_dictionary_lookup_for_missing_notes(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Import deck"))
        response = self.client.post(
            f"/api/vocabulary/decks/{deck['id']}/imports/archive",
            json={
                "items": [
                    {
                        "sourceId": "abc123",
                        "sourceText": "insightful",
                        "bookId": "book-1",
                        "bookTitle": "Storyworthy",
                    }
                ]
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["createdCount"], 1)
        self.assertEqual(payload["notes"][0]["back"], "insightful definition")
        session = self.service.get_session(deck["id"])
        self.assertEqual(session["currentCard"]["pronunciation"], "/insightful/")

    def test_practice_session_prioritizes_new_items_and_avoids_siblings(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Practice deck"))
        sibling_note = self.service.create_note(
            deck["id"],
            NoteCreateRequest(noteType="basic_reverse", front="abundant", back="plentiful", topic="nature"),
        )
        weak_note = self.service.create_note(
            deck["id"],
            NoteCreateRequest(noteType="basic", front="brief", back="short in duration", topic="writing"),
        )
        weak_card_id = weak_note["note"]["cards"][0]["id"]
        self.service.submit_review(weak_card_id, CardReviewRequest(rating="hard"))

        session = self.service.create_practice_session(
            deck["id"],
            PracticeSessionRequest(focus="mixed", limit=3),
        )
        items = session["items"]
        self.assertGreaterEqual(len(items), 2)
        self.assertEqual(items[0]["noteId"], sibling_note["note"]["id"])
        self.assertEqual(items[1]["id"], weak_card_id)
        self.assertEqual(len({item["noteId"] for item in items}), len(items))

    def test_lesson_generation_does_not_change_fsrs_state(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Lesson deck"))
        self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="steady", back="firm and stable"))
        before = self.service.get_session(deck["id"])["currentCard"]
        lesson = self.service.generate_card_lesson(before["id"], CardLessonRequest(refreshHint="lesson-1"))
        after = self.service.get_session(deck["id"])["currentCard"]

        self.assertEqual(lesson["contextTitle"], "steady in context")
        self.assertEqual(before["id"], after["id"])
        self.assertEqual(before["state"], after["state"])
        self.assertEqual(before["dueAt"], after["dueAt"])

    def test_fallback_coach_logs_suggested_rating_and_caps_turns(self) -> None:
        deck = self.service.create_deck(DeckCreateRequest(title="Coach deck"))
        note = self.service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="steady", back="firm and stable"))
        card_id = note["note"]["cards"][0]["id"]

        payload = self.service.coach_card(
            card_id,
            CardCoachRequest(mode="review", step="answer", turnIndex=3, learnerResponse="not moving"),
        )
        self.assertEqual(payload["provider"], "fallback")
        self.assertEqual(payload["turnCount"], 3)
        self.assertTrue(payload["canRate"])
        self.assertIn(payload["suggestedRating"], {"again", "hard", "good", "easy"})

        with self.service.connection() as conn:
            row = conn.execute(
                "select provider, suggested_rating from practice_attempts where card_id = ? order by created_at desc limit 1",
                (card_id,),
            ).fetchone()
        self.assertEqual(row["provider"], "fallback")
        self.assertEqual(row["suggested_rating"], payload["suggestedRating"])

    def test_openai_coach_fallback_is_used_when_local_generators_are_missing(self) -> None:
        service = VocabularyStudioService(
            self.tempdir,
            dictionary_lookup=lambda term: {
                "source": "stub-dictionary",
                "entries": [{"definition": f"{term} definition", "examples": [f"{term} example"]}],
            },
        )
        deck = service.create_deck(DeckCreateRequest(title="OpenAI coach deck"))
        note = service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="steady", back="firm and stable"))
        card_id = note["note"]["cards"][0]["id"]

        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "verdict": "close",
                                "feedbackTitle": "Almost there",
                                "feedbackBody": "Tighten the meaning a little more.",
                                "correction": "firm and stable",
                                "nextPrompt": "Try again in one short line.",
                                "suggestedRating": "hard",
                                "canRate": False,
                            }
                        )
                    }
                }
            ]
        }

        with patch("server.vocabulary_studio.os.getenv", side_effect=lambda name: "test-key" if name == "OPENAI_API_KEY" else None):
            with patch("server.vocabulary_studio.httpx.post", return_value=response):
                payload = service.coach_card(
                    card_id,
                    CardCoachRequest(mode="review", step="answer", turnIndex=1, learnerResponse="sort of steady"),
                )

        self.assertEqual(payload["provider"], "openai")
        self.assertEqual(payload["verdict"], "close")
        self.assertEqual(payload["suggestedRating"], "hard")

    def test_context_generation_uses_grounded_generator_payload(self) -> None:
        captured: dict[str, object] = {}
        def generator(grounding: dict[str, object]) -> dict[str, object]:
            captured["grounding"] = grounding
            return {
                "source": "ai",
                "term": grounding["term"],
                "pronunciation": grounding["pronunciation"],
                "definition": grounding["definition"],
                "contextTitle": "Fresh scene",
                "contextParagraph": f'{grounding["term"]} appears in a new everyday scene.',
                "usageFocus": [grounding["definition"], "Keep the tone natural."],
                "practicePrompts": [
                    "Write about school.",
                    "Write about work.",
                    "Write about home.",
                ],
            }

        service = VocabularyStudioService(
            self.tempdir,
            dictionary_lookup=lambda term: {
                "source": "stub-dictionary",
                "pronunciation": f"/{term}/",
                "entries": [
                    {
                        "definition": f"{term} definition",
                        "notes": "dictionary note",
                        "examples": [f"{term} example"],
                    }
                ],
            },
            context_generator=generator,
        )
        deck = service.create_deck(DeckCreateRequest(title="Context deck"))
        note = service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="steady", back="firm and stable"))
        card_id = note["note"]["cards"][0]["id"]

        payload = service.generate_card_context(card_id)
        grounding = captured["grounding"]
        self.assertEqual(payload["source"], "ai")
        self.assertEqual(payload["term"], "steady")
        self.assertEqual(payload["definition"], "steady definition")
        self.assertEqual(payload["contextTitle"], "Fresh scene")
        self.assertEqual(grounding["term"], "steady")

    def test_context_generation_tries_multiple_generators_before_fallback(self) -> None:
        attempted: list[str] = []

        def failing(grounding: dict[str, object]) -> dict[str, object] | None:
            attempted.append(f"fail:{grounding['term']}")
            raise RuntimeError("boom")

        def succeeding(grounding: dict[str, object]) -> dict[str, object] | None:
            attempted.append(f"success:{grounding['term']}")
            return {
                "source": "gemma",
                "contextTitle": "Recovered locally",
                "contextParagraph": "A grounded local context for the target word.",
                "usageFocus": ["Notice the precise meaning.", "Use it in your own sentence."],
                "practicePrompts": [
                    "Write about school.",
                    "Write about work.",
                    "Write about home.",
                ],
            }

        service = VocabularyStudioService(
            self.tempdir,
            dictionary_lookup=lambda term: {
                "source": "stub-dictionary",
                "entries": [
                    {
                        "definition": f"{term} definition",
                        "examples": [f"{term} example"],
                    }
                ],
            },
            context_generators=[failing, succeeding],
            allow_openai_fallback=False,
        )
        deck = service.create_deck(DeckCreateRequest(title="Multi-provider deck"))
        note = service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="brief", back="short in duration"))
        card_id = note["note"]["cards"][0]["id"]

        payload = service.generate_card_context(card_id)
        self.assertEqual(payload["source"], "gemma")
        self.assertEqual(payload["contextTitle"], "Recovered locally")
        self.assertEqual(attempted, ["fail:brief", "success:brief"])

    def test_context_generation_falls_back_to_dictionary_when_generator_fails(self) -> None:
        service = VocabularyStudioService(
            self.tempdir,
            dictionary_lookup=lambda term: {
                "source": "stub-dictionary",
                "entries": [
                    {
                        "definition": f"{term} definition",
                        "notes": "dictionary note",
                        "examples": [f"{term} example"],
                    }
                ],
            },
            context_generator=lambda grounding: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        deck = service.create_deck(DeckCreateRequest(title="Fallback deck"))
        note = service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="brief", back="short in duration"))
        card_id = note["note"]["cards"][0]["id"]

        payload = service.generate_card_context(card_id)
        self.assertEqual(payload["source"], "dictionary_fallback")
        self.assertEqual(payload["term"], "brief")
        self.assertIn("brief definition", payload["contextParagraph"])

    def test_context_generation_caches_default_payload_per_card(self) -> None:
        call_count = 0

        def generator(grounding: dict[str, object]) -> dict[str, object]:
            nonlocal call_count
            call_count += 1
            return {
                "source": "gemma",
                "contextTitle": f"Context #{call_count}",
                "contextParagraph": f'{grounding["term"]} appears in context #{call_count}.',
                "usageFocus": ["Notice the exact meaning.", "Use the word naturally."],
                "practicePrompts": [
                    "Write about school.",
                    "Write about work.",
                    "Write about home.",
                ],
            }

        service = VocabularyStudioService(
            self.tempdir,
            dictionary_lookup=lambda term: {
                "source": "stub-dictionary",
                "entries": [
                    {
                        "definition": f"{term} definition",
                        "examples": [f"{term} example"],
                    }
                ],
            },
            context_generator=generator,
            allow_openai_fallback=False,
        )
        deck = service.create_deck(DeckCreateRequest(title="Cached context deck"))
        note = service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="brief", back="short in duration"))
        card_id = note["note"]["cards"][0]["id"]

        first = service.generate_card_context(card_id)
        second = service.generate_card_context(card_id)

        self.assertEqual(call_count, 1)
        self.assertEqual(first["contextTitle"], "Context #1")
        self.assertEqual(second["contextTitle"], "Context #1")
        self.assertEqual(second["source"], "gemma")

    def test_context_generation_caches_by_refresh_hint_for_retries(self) -> None:
        call_count = 0

        def generator(grounding: dict[str, object]) -> dict[str, object]:
            nonlocal call_count
            call_count += 1
            return {
                "source": "gemma",
                "contextTitle": f"Variation #{call_count}",
                "contextParagraph": f'{grounding["term"]} variation {grounding["variationHint"]}.',
                "usageFocus": ["Notice the exact meaning.", "Use the word naturally."],
                "practicePrompts": [
                    "Write about school.",
                    "Write about work.",
                    "Write about home.",
                ],
            }

        service = VocabularyStudioService(
            self.tempdir,
            dictionary_lookup=lambda term: {
                "source": "stub-dictionary",
                "entries": [
                    {
                        "definition": f"{term} definition",
                        "examples": [f"{term} example"],
                    }
                ],
            },
            context_generator=generator,
            allow_openai_fallback=False,
        )
        deck = service.create_deck(DeckCreateRequest(title="Refresh cache deck"))
        note = service.create_note(deck["id"], NoteCreateRequest(noteType="basic", front="brief", back="short in duration"))
        card_id = note["note"]["cards"][0]["id"]

        first = service.generate_card_context(card_id, CardContextRequest(refreshHint="same-token"))
        second = service.generate_card_context(card_id, CardContextRequest(refreshHint="same-token"))
        third = service.generate_card_context(card_id, CardContextRequest(refreshHint="new-token"))

        self.assertEqual(call_count, 2)
        self.assertEqual(first["contextTitle"], "Variation #1")
        self.assertEqual(second["contextTitle"], "Variation #1")
        self.assertEqual(third["contextTitle"], "Variation #2")

    def test_gemma_generator_parses_ollama_chat_payload(self) -> None:
        generator = build_gemma_context_generator(
            provider="ollama",
            base_url="http://127.0.0.1:11434",
            model="gemma4:test",
            timeout_seconds=12.0,
        )
        response = Mock()
        response.json.return_value = {
            "message": {
                "content": (
                    '{"contextTitle":"Fresh local scene","contextParagraph":"The word appears in a clear everyday setting.",'
                    '"usageFocus":["Pay attention to the meaning.","Keep the tone natural."],'
                    '"practicePrompts":["Write about school.","Write about work.","Write about home."]}'
                )
            }
        }
        response.raise_for_status.return_value = None

        with patch("server.gemma_provider.httpx.post", return_value=response) as mocked_post:
            payload = generator(
                {
                    "term": "steady",
                    "pronunciation": "/steady/",
                    "definition": "firm and stable",
                    "dictionaryExamples": ["steady example"],
                }
            )

        self.assertEqual(payload["source"], "gemma")
        self.assertEqual(payload["term"], "steady")
        self.assertEqual(payload["contextTitle"], "Fresh local scene")
        self.assertEqual(payload["practicePrompts"][0], "Write about school.")
        self.assertTrue(mocked_post.called)

    def test_gemma_prompt_payload_trims_and_deduplicates_grounding(self) -> None:
        payload = _build_prompt_payload(
            {
                "term": " recurring ",
                "pronunciation": " /rɪˈkɜːrɪŋ/ ",
                "definition": " happen or occur again " * 20,
                "definitions": [
                    " happen or occur again ",
                    "happen or occur again",
                    "return at intervals",
                    "repeat often",
                ],
                "dictionaryExamples": [
                    "The meetings are recurring every Monday.",
                    "The meetings are recurring every Monday.",
                    "A recurring charge appears on the bill.",
                    "A recurring dream kept him awake at night.",
                ],
                "explanation": " Use it for something that repeats over time. ",
                "variationHint": " token-123 ",
            }
        )

        self.assertEqual(payload["targetWord"], "recurring")
        self.assertEqual(payload["pronunciation"], "/rɪˈkɜːrɪŋ/")
        self.assertEqual(len(payload["allowedDefinitions"]), 3)
        self.assertEqual(payload["allowedDefinitions"][0], "happen or occur again")
        self.assertEqual(len(payload["allowedExamples"]), 3)
        self.assertEqual(payload["allowedExamples"][0], "The meetings are recurring every Monday.")
        self.assertEqual(payload["notes"], "Use it for something that repeats over time.")
        self.assertEqual(payload["variationHint"], "token-123")
        self.assertIn("Do not invent book plots", payload["rules"][2])

    def test_gemma_generator_sends_tighter_everyday_prompt(self) -> None:
        generator = build_gemma_context_generator(
            provider="ollama",
            base_url="http://127.0.0.1:11434",
            model="gemma4:test",
            timeout_seconds=12.0,
        )
        response = Mock()
        response.json.return_value = {
            "message": {
                "content": (
                    '{"contextTitle":"Fresh local scene","contextParagraph":"The word appears in a clear everyday setting.",'
                    '"usageFocus":["Pay attention to the meaning.","Keep the tone natural."],'
                    '"practicePrompts":["Write about school.","Write about work."]}'
                )
            }
        }
        response.raise_for_status.return_value = None

        with patch("server.gemma_provider.httpx.post", return_value=response) as mocked_post:
            generator(
                {
                    "term": "steady",
                    "pronunciation": "/steady/",
                    "definition": "firm and stable",
                    "definitions": ["firm and stable"],
                    "dictionaryExamples": ["A steady hand kept the glass from spilling."],
                    "variationHint": "abc123",
                }
            )

        self.assertTrue(mocked_post.called)
        request_payload = mocked_post.call_args.kwargs["json"]
        self.assertEqual(request_payload["options"]["temperature"], 0.35)
        self.assertIn("Prefer plain everyday situations", request_payload["messages"][0]["content"])
        user_prompt = json.loads(request_payload["messages"][1]["content"])
        self.assertEqual(user_prompt["targetWord"], "steady")
        self.assertIn("Do not invent book plots", user_prompt["rules"][2])
        self.assertEqual(user_prompt["allowedExamples"], ["A steady hand kept the glass from spilling."])


class StudioSummaryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = Path(mkdtemp())
        self.service = VocabularyStudioService(self.tempdir)

    def tearDown(self) -> None:
        del self.service
        gc.collect()
        shutil.rmtree(self.tempdir, ignore_errors=True)

    def _insert_event(self, when: datetime, *, xp_delta: int = 10) -> None:
        from server.vocabulary_studio import _make_id  # noqa: WPS433
        with self.service.connection() as conn:
            conn.execute(
                """
                insert into learning_events (id, user_id, event_type, xp_delta, label, payload_json, created_at)
                values (?, ?, ?, ?, ?, '{}', ?)
                """,
                (_make_id(), self.service.user_id, "review_completed", xp_delta, "test", when.isoformat()),
            )

    def test_studio_summary_returns_zeros_when_no_events(self) -> None:
        result = self.service.studio_summary()
        self.assertEqual(result["streakDays"], 0)
        self.assertEqual(result["xpToday"], 0)
        self.assertEqual(result["xpThisWeek"], 0)
        self.assertEqual(result["dailyGoalProgress"], 0)
        self.assertGreater(result["dailyGoal"], 0)

    def test_studio_summary_breaks_streak_when_yesterday_is_missed(self) -> None:
        # Event 2 days ago, nothing today or yesterday → streak ends at 0 (today is empty).
        two_days_ago = datetime.now(timezone.utc) - timedelta(days=2)
        self._insert_event(two_days_ago, xp_delta=15)
        result = self.service.studio_summary()
        self.assertEqual(result["streakDays"], 0)
        # That older event is still inside the 7-day window:
        self.assertEqual(result["xpThisWeek"], 15)
        self.assertEqual(result["xpToday"], 0)

    def test_studio_summary_counts_continuous_streak(self) -> None:
        # Insert one event for each of the last 5 days (today and 4 prior).
        now = datetime.now(timezone.utc)
        for offset in range(5):
            self._insert_event(now - timedelta(days=offset, hours=1), xp_delta=20)
        result = self.service.studio_summary()
        self.assertEqual(result["streakDays"], 5)
        self.assertEqual(result["xpToday"], 20)
        # All 5 events are within the rolling 7-day window:
        self.assertEqual(result["xpThisWeek"], 100)


if __name__ == "__main__":
    unittest.main()
