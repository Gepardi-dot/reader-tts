from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server.app as server_app


class NeuTTSLocalTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tempdir, ignore_errors=True)

    def create_reference_pack(self, voice_id: str, *, meta: dict[str, object] | None = None, complete: bool = True) -> Path:
        voice_dir = self.tempdir / voice_id
        voice_dir.mkdir(parents=True, exist_ok=True)
        if complete:
            (voice_dir / "reference.wav").write_bytes(b"RIFFdemo")
            (voice_dir / "reference.txt").write_text("This is the reference transcript.", encoding="utf-8")
        if meta is not None:
            (voice_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        return voice_dir

    def test_windows_wsl_path_round_trip(self) -> None:
        windows_path = Path(r"C:\Users\miroa\storybook-reader\voices\neutts\demo\reference.wav")
        wsl_path = server_app.windows_path_to_wsl(windows_path)
        self.assertEqual(wsl_path, "/mnt/c/Users/miroa/storybook-reader/voices/neutts/demo/reference.wav")
        self.assertEqual(
            server_app.wsl_path_to_windows(wsl_path),
            windows_path,
        )

    def test_list_neutts_reference_packs_uses_meta_and_skips_incomplete(self) -> None:
        self.create_reference_pack(
            "amy",
            meta={
                "label": "Amy Story",
                "gender": "female",
                "genderSource": "estimated",
                "style": "Warm",
                "tags": ["Story"],
            },
        )
        self.create_reference_pack("broken", complete=False)

        with patch.object(server_app, "NEUTTS_VOICES_ROOT", self.tempdir):
            voices = server_app.list_neutts_reference_packs()

        self.assertEqual(len(voices), 1)
        self.assertEqual(voices[0]["id"], "amy")
        self.assertEqual(voices[0]["label"], "Amy Story")
        self.assertEqual(voices[0]["gender"], "female")
        self.assertEqual(voices[0]["style"], "Warm")
        self.assertEqual(voices[0]["tags"], ["Story"])

    def test_list_neutts_reference_packs_returns_empty_when_root_missing(self) -> None:
        with patch.object(server_app, "NEUTTS_VOICES_ROOT", self.tempdir / "missing"):
            self.assertEqual(server_app.list_neutts_reference_packs(), [])

    def test_resolve_neutts_voice_respects_model_filters(self) -> None:
        self.create_reference_pack(
            "fast-only",
            meta={"models": ["neuphonic/neutts-nano-q4-gguf"]},
        )
        self.create_reference_pack(
            "quality-only",
            meta={"models": ["neuphonic/neutts-air-q4-gguf"]},
        )

        with patch.object(server_app, "NEUTTS_VOICES_ROOT", self.tempdir):
            self.assertEqual(
                server_app.resolve_neutts_local_tts_voice(None, "neuphonic/neutts-nano-q4-gguf"),
                "fast-only",
            )
            self.assertEqual(
                server_app.resolve_neutts_local_tts_voice(None, "neuphonic/neutts-air-q4-gguf"),
                "quality-only",
            )
            with self.assertRaises(RuntimeError):
                server_app.resolve_neutts_local_tts_voice("quality-only", "neuphonic/neutts-nano-q4-gguf")

    def test_clamp_chunk_size_uses_neutts_limits(self) -> None:
        self.assertEqual(server_app.clamp_chunk_size("neutts_local", None), 320)
        self.assertEqual(server_app.clamp_chunk_size("neutts_local", 50), 150)
        self.assertEqual(server_app.clamp_chunk_size("neutts_local", 999), 450)

    def test_prepare_live_synthesis_chunks_keeps_short_neutts_segments_whole(self) -> None:
        text = " ".join(["story"] * 12)

        chunks = server_app.prepare_live_synthesis_chunks(text, "neutts_local")

        self.assertEqual(chunks, [text])

    def test_prepare_live_synthesis_chunks_splits_long_neutts_segments(self) -> None:
        text = " ".join(["story"] * 40)

        chunks = server_app.prepare_live_synthesis_chunks(text, "neutts_local")

        self.assertGreater(len(chunks), 1)

    def test_shape_neutts_local_transcript_strengthens_punctuation_breaks(self) -> None:
        shaped = server_app.shape_neutts_local_transcript(
            "She paused; then she continued. Another thought followed.\n\nA final beat: and then silence.",
            length_scale=1.0,
            sentence_silence=0.2,
        )

        self.assertIn("continued.\n\nAnother thought followed.", shaped)
        self.assertIn("paused;\nthen she continued.", shaped)
        self.assertIn("\n\n\nA final beat:\nand then silence.", shaped)

    def test_shape_neutts_local_transcript_keeps_light_pauses_compact(self) -> None:
        shaped = server_app.shape_neutts_local_transcript(
            "A quick line. Another line follows immediately.",
            length_scale=0.9,
            sentence_silence=0.0,
        )

        self.assertEqual(shaped, "A quick line.\nAnother line follows immediately.")


if __name__ == "__main__":
    unittest.main()
