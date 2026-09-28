from __future__ import annotations

import unittest

from server.page_numbers import is_page_number_line, speech_text_without_page_numbers


class PageNumberTests(unittest.TestCase):
    def test_recognizes_furniture_and_keeps_prose(self) -> None:
        self.assertTrue(is_page_number_line("42"))
        self.assertTrue(is_page_number_line("Page 12"))
        self.assertTrue(is_page_number_line("- 18 -"))
        self.assertTrue(is_page_number_line("12 / 340"))
        self.assertFalse(is_page_number_line("He turned 12."))
        self.assertFalse(is_page_number_line("Chapter 1"))
        self.assertFalse(is_page_number_line("1984"))
        self.assertFalse(is_page_number_line("1. Buy milk"))

    def test_speech_drops_the_number_and_keeps_the_sentence(self) -> None:
        text = "He left the room.\n\n42\n\nShe opened the door."
        self.assertEqual(
            speech_text_without_page_numbers(text),
            "He left the room.\n\nShe opened the door.",
        )

    def test_unchanged_text_is_the_same_object_string(self) -> None:
        text = "He left the room.\n\nShe opened the door."
        self.assertEqual(speech_text_without_page_numbers(text), text)

    def test_glued_page_number_drops_and_figure_reference_stays(self) -> None:
        text = "She opened the door. 42\nSee fig. 12 tomorrow."
        self.assertEqual(
            speech_text_without_page_numbers(text),
            "She opened the door.\nSee fig. 12 tomorrow.",
        )

    def test_number_only_slice_is_silent(self) -> None:
        self.assertEqual(speech_text_without_page_numbers("\n\n42\n\n"), "")


if __name__ == "__main__":
    unittest.main()
