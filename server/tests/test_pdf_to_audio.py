from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import pdf_to_audio


class PdfToAudioGemmaCleanupTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tempdir, ignore_errors=True)

    def test_merge_wrapped_lines_combines_prose_lines(self) -> None:
        merged = pdf_to_audio.merge_wrapped_lines(
            "Anyone who\nwants to take the stage, become a better writer, or simply tell better stories\nat Thanksgiving will benefit."
        )
        self.assertEqual(
            merged,
            "Anyone who wants to take the stage, become a better writer, or simply tell better stories at Thanksgiving will benefit.",
        )

    def test_merge_wrapped_lines_preserves_headings(self) -> None:
        merged = pdf_to_audio.merge_wrapped_lines(
            "STORY BREAK\nZombie Brother\nMy brother, Jeremy, went missing back in 2007.\nHe quit his job."
        )
        self.assertEqual(
            merged,
            "STORY BREAK\nZombie Brother\nMy brother, Jeremy, went missing back in 2007.\nHe quit his job.",
        )

    def test_chunk_needs_gemma_cleanup_detects_layout_noise(self) -> None:
        self.assertTrue(
            pdf_to_audio.chunk_needs_gemma_cleanup(
                "Praise for \nStoryworthy\n and Matthew Dicks\nAnyone who\nwants to try this."
            )
        )
        self.assertTrue(pdf_to_audio.chunk_needs_gemma_cleanup("The sto-\nry begins here."))

    def test_chunk_needs_gemma_cleanup_skips_clean_paragraphs(self) -> None:
        self.assertFalse(
            pdf_to_audio.chunk_needs_gemma_cleanup(
                "This is already a clean paragraph for narration. It has normal sentence spacing and no page noise."
            )
        )

    def test_clean_text_preserves_paragraph_breaks(self) -> None:
        cleaned = pdf_to_audio.clean_text("CHAPTER 1\n\n12\n\nThe sto-\nry begins here.")
        self.assertEqual(cleaned, "CHAPTER 1\n\nThe story begins here.")

    def test_build_cleanup_prompt_preserves_cleanup_constraints(self) -> None:
        payload = pdf_to_audio._build_cleanup_prompt("CHAPTER 1\n\n12\n\nThe sto-\nry begins here.")
        self.assertEqual(
            payload["task"],
            "Clean extracted book text for text-to-speech without changing meaning.",
        )
        self.assertIn("Return JSON only with the key cleanedText.", payload["rules"])
        self.assertEqual(payload["text"], "CHAPTER 1\n\n12\n\nThe sto-\nry begins here.")

    def test_clean_text_with_gemma_uses_cleaned_response(self) -> None:
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "message": {
                "content": '{"cleanedText":"CHAPTER 1\\n\\nThe story begins here."}'
            }
        }

        with patch("pdf_to_audio.httpx.post", return_value=response):
            cleaned = pdf_to_audio.clean_text_with_gemma(
                "CHAPTER 1\n\n12\n\nThe sto-\nry begins here.",
                base_url="http://127.0.0.1:11434",
                model="gemma4:e2b",
                timeout_seconds=30.0,
                max_chars=500,
                cache_dir=self.tempdir,
            )

        self.assertEqual(cleaned, "CHAPTER 1\n\nThe story begins here.")

    def test_clean_text_with_gemma_falls_back_to_regex_cleanup(self) -> None:
        with patch("pdf_to_audio.httpx.post", side_effect=RuntimeError("offline")):
            cleaned = pdf_to_audio.clean_text_with_gemma(
                "12\n\nThe sto-\nry begins here.\n\n13",
                base_url="http://127.0.0.1:11434",
                model="gemma4:e2b",
                timeout_seconds=30.0,
                max_chars=500,
                cache_dir=self.tempdir,
            )

        self.assertEqual(cleaned, "The story begins here.")

    def test_clean_text_with_gemma_disables_reasoning(self) -> None:
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "message": {
                "content": '{"cleanedText":"The story begins here."}'
            }
        }

        with patch("pdf_to_audio.httpx.post", return_value=response) as mocked_post:
            pdf_to_audio.clean_text_with_gemma(
                "Praise for \nStoryworthy\n and Matthew Dicks\nAnyone who\nwants to try this.",
                base_url="http://127.0.0.1:11434",
                model="gemma4:e2b",
                timeout_seconds=30.0,
                max_chars=500,
                cache_dir=self.tempdir,
            )

        self.assertTrue(mocked_post.called)
        self.assertEqual(mocked_post.call_args.kwargs["json"]["think"], False)

    def test_cleanup_output_validation_rejects_excessive_loss(self) -> None:
        self.assertFalse(
            pdf_to_audio.cleanup_output_is_valid(
                "This paragraph contains several important details and should remain intact.",
                "important details",
            )
        )
        self.assertTrue(
            pdf_to_audio.cleanup_output_is_valid(
                "This paragraph contains several important details and should remain intact.",
                "This paragraph contains several important details and should remain intact.",
            )
        )

    def test_clean_text_with_gemma_uses_cache_for_repeat_chunk(self) -> None:
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "message": {
                "content": '{"cleanedText":"Praise for Storyworthy and Matthew Dicks. Anyone who wants to try this."}'
            }
        }
        noisy = "Praise for \nStoryworthy\n and Matthew Dicks\nAnyone who\nwants to try this."

        with patch("pdf_to_audio.httpx.post", return_value=response) as mocked_post:
            first = pdf_to_audio.clean_text_with_gemma(
                noisy,
                base_url="http://127.0.0.1:11434",
                model="gemma4:e2b",
                timeout_seconds=30.0,
                max_chars=500,
                cache_dir=self.tempdir,
            )
            second = pdf_to_audio.clean_text_with_gemma(
                noisy,
                base_url="http://127.0.0.1:11434",
                model="gemma4:e2b",
                timeout_seconds=30.0,
                max_chars=500,
                cache_dir=self.tempdir,
            )

        self.assertEqual(first, second)
        self.assertEqual(mocked_post.call_count, 1)

    def test_clean_text_with_gemma_rejects_invalid_output_and_falls_back(self) -> None:
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "message": {
                "content": '{"cleanedText":"short"}'
            }
        }
        noisy = "Praise for \nStoryworthy\n and Matthew Dicks\nAnyone who\nwants to try this."

        with patch("pdf_to_audio.httpx.post", return_value=response):
            cleaned = pdf_to_audio.clean_text_with_gemma(
                noisy,
                base_url="http://127.0.0.1:11434",
                model="gemma4:e2b",
                timeout_seconds=30.0,
                max_chars=500,
                cache_dir=self.tempdir,
            )

        self.assertEqual(cleaned, pdf_to_audio.clean_text(noisy))


if __name__ == "__main__":
    unittest.main()
