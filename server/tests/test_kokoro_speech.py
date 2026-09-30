from __future__ import annotations

import unittest

from server.kokoro_speech import prepare_kokoro_speech


CONTENTS = (
    "Appendix A: Seductive Environment/Seductive Time page 431 Appendix B: "
    "Soft Seduction: How to Sell Anything to the Masses page 441 "
    "Selected Bibliography • 455 Index • 457Appendix A"
)
SPOKEN = (
    "Appendix A: Seductive Environment/Seductive Time page 431, Appendix B: "
    "Soft Seduction: How to Sell Anything to the Masses page 441, "
    "Selected Bibliography. 455, Index. 457, Appendix A"
)


class KokoroSpeechTests(unittest.TestCase):
    def test_pauses_after_a_number_before_the_next_title(self) -> None:
        self.assertEqual(prepare_kokoro_speech(CONTENTS), SPOKEN)
        self.assertEqual(
            prepare_kokoro_speech("page 441\nSelected Bibliography"),
            "page 441, Selected Bibliography",
        )
        self.assertEqual(prepare_kokoro_speech(prepare_kokoro_speech(CONTENTS)), SPOKEN)

    def test_leaves_a_number_inside_a_sentence(self) -> None:
        self.assertEqual(prepare_kokoro_speech("In 1984 the war ended."), "In nineteen eighty-four the war ended.")
        self.assertEqual(prepare_kokoro_speech("He turned 12 yesterday."), "He turned 12 yesterday.")
        self.assertEqual(prepare_kokoro_speech("page 3D models"), "page 3D models")
        self.assertEqual(prepare_kokoro_speech("the 1980s"), "the nineteen eighties")
        self.assertEqual(
            prepare_kokoro_speech("On the 21st, at 3:05, about 12% remained."),
            "On the twenty-first, at three oh five, about twelve percent remained.",
        )
