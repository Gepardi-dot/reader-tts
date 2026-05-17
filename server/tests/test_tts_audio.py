from __future__ import annotations

import shutil
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import server.app as server_app


def write_demo_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(22050)
        wav_file.writeframes(b"\x00\x00" * 220)


class TtsAudioTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tempdir, ignore_errors=True)

    def test_live_audio_request_accepts_kokoro_provider(self) -> None:
        request = server_app.LiveAudioRequest(
            provider="kokoro",
            voice="af_heart",
            pageNumber=1,
            start=6,
            end=17,
            text="reader text",
        )

        self.assertEqual(request.provider, "kokoro")

    def test_kokoro_live_audio_uses_submitted_absolute_offsets(self) -> None:
        book_text = "Intro reader text continues for a while."
        start = book_text.index("reader")
        end = len(book_text)
        live_audio_dir = self.tempdir / "live_audio"

        def synthesize_stub(**kwargs):
            write_demo_wav(kwargs["output_path"])
            return ""

        with (
            patch.object(server_app, "load_book_or_404", return_value={"id": "book-1"}),
            patch.object(server_app, "read_book_text", return_value=book_text),
            patch.object(server_app, "book_live_audio_dir", return_value=live_audio_dir),
            patch.object(server_app, "book_storage_enabled", return_value=False),
            patch.object(
                server_app,
                "provider_details",
                return_value={
                    "id": "kokoro",
                    "name": "Kokoro TTS",
                    "available": True,
                    "defaultVoice": "af_heart",
                },
            ),
            patch.object(server_app, "synthesize_provider_audio", side_effect=synthesize_stub) as synthesize,
            patch.object(server_app, "relative_url", return_value="/library/books/book-1/live_audio/kokoro-demo.wav"),
        ):
            payload = server_app.build_live_audio_payload(
                "book-1",
                server_app.LiveAudioRequest(
                    provider="kokoro",
                    voice=None,
                    pageNumber=1,
                    start=start,
                    end=end,
                    text=book_text[start:end],
                ),
            )

        self.assertEqual(payload["provider"], "kokoro")
        self.assertEqual(payload["start"], start)
        self.assertEqual(payload["end"], end)
        self.assertEqual(payload["voice"], "af_heart")
        self.assertEqual(payload["cacheVersion"], server_app.LIVE_AUDIO_CACHE_VERSION)
        self.assertEqual(payload["contentType"], "audio/wav")
        self.assertTrue(payload["cacheKey"].startswith(f"live-audio:v{server_app.LIVE_AUDIO_CACHE_VERSION}:"))
        self.assertGreater(payload["byteLength"], 0)
        synthesize.assert_called_once()

    def test_live_audio_cache_key_changes_when_text_changes_at_same_offsets(self) -> None:
        def payload_for(book_text: str) -> dict[str, object]:
            live_audio_dir = self.tempdir / f"live_audio_{hash(book_text)}"

            def synthesize_stub(**kwargs):
                write_demo_wav(kwargs["output_path"])
                return ""

            with (
                patch.object(server_app, "load_book_or_404", return_value={"id": "book-1"}),
                patch.object(server_app, "read_book_text", return_value=book_text),
                patch.object(server_app, "book_live_audio_dir", return_value=live_audio_dir),
                patch.object(server_app, "book_storage_enabled", return_value=False),
                patch.object(
                    server_app,
                    "provider_details",
                    return_value={
                        "id": "kokoro",
                        "name": "Kokoro TTS",
                        "available": True,
                        "defaultVoice": "af_heart",
                    },
                ),
                patch.object(server_app, "synthesize_provider_audio", side_effect=synthesize_stub),
                patch.object(server_app, "relative_url", return_value="/library/books/book-1/live_audio/kokoro-demo.wav"),
            ):
                return server_app.build_live_audio_payload(
                    "book-1",
                    server_app.LiveAudioRequest(
                        provider="kokoro",
                        voice=None,
                        pageNumber=1,
                        start=0,
                        end=len(book_text),
                        text=book_text,
                    ),
                )

        first = payload_for("Same offsets with first text.")
        second = payload_for("Same offsets with other text.")

        self.assertNotEqual(first["cacheKey"], second["cacheKey"])

    def test_audio_manifest_builds_chunk_grid_without_synthesizing(self) -> None:
        book_text = (
            "First sentence for narration. Second sentence follows with enough text to chunk. "
            "Third sentence keeps going so the manifest has more than one planned audio chunk. "
            "Fourth sentence adds a little more material for the sentence-aware grid."
        )
        live_audio_dir = self.tempdir / "manifest_audio"

        with (
            patch.object(server_app, "load_book_or_404", return_value={"id": "book-1"}),
            patch.object(server_app, "read_book_text", return_value=book_text),
            patch.object(server_app, "book_live_audio_dir", return_value=live_audio_dir),
            patch.object(server_app, "book_storage_enabled", return_value=False),
            patch.object(server_app, "progress_store_configured", return_value=False),
            patch.object(
                server_app,
                "provider_details",
                return_value={
                    "id": "kokoro",
                    "name": "Kokoro TTS",
                    "available": True,
                    "defaultVoice": "af_heart",
                },
            ),
        ):
            payload = server_app.ensure_audio_manifest_payload(
                "book-1",
                server_app.AudioManifestRequest(
                    provider="kokoro",
                    voice=None,
                    length_scale=0.93,
                    sentence_silence=0.38,
                    chunk_size=150,
                ),
            )

        self.assertEqual(payload["provider"], "kokoro")
        self.assertEqual(payload["voice"], "af_heart")
        self.assertEqual(payload["status"], "pending")
        self.assertEqual(payload["readyChunks"], 0)
        self.assertGreater(payload["totalChunks"], 1)
        self.assertTrue(payload["chunks"][0]["cacheKey"].startswith(f"live-audio:v{server_app.LIVE_AUDIO_CACHE_VERSION}:"))
        self.assertTrue((live_audio_dir / f".audio-manifest-{payload['id']}.json").exists())

    def test_audio_manifest_marks_existing_chunk_ready(self) -> None:
        book_text = "One complete narration chunk."
        live_audio_dir = self.tempdir / "manifest_ready_audio"
        provider = {
            "id": "kokoro",
            "name": "Kokoro TTS",
            "available": True,
            "defaultVoice": "af_heart",
        }
        chosen_voice, chosen_model = server_app.resolve_live_audio_voice_model("kokoro", provider, None, None)
        identity = server_app.build_live_audio_cache_identity(
            book_id="book-1",
            provider_id="kokoro",
            voice=chosen_voice,
            model=chosen_model,
            narration_style="",
            length_scale=0.93,
            sentence_silence=0.38,
            start=0,
            end=len(book_text),
            canonical_text=server_app.normalize_highlight_text(book_text),
        )
        live_audio_dir.mkdir(parents=True, exist_ok=True)
        write_demo_wav(live_audio_dir / identity["fileName"])

        with (
            patch.object(server_app, "load_book_or_404", return_value={"id": "book-1"}),
            patch.object(server_app, "read_book_text", return_value=book_text),
            patch.object(server_app, "book_live_audio_dir", return_value=live_audio_dir),
            patch.object(server_app, "book_storage_enabled", return_value=False),
            patch.object(server_app, "progress_store_configured", return_value=False),
            patch.object(server_app, "provider_details", return_value=provider),
        ):
            payload = server_app.ensure_audio_manifest_payload(
                "book-1",
                server_app.AudioManifestRequest(
                    provider="kokoro",
                    voice=None,
                    length_scale=0.93,
                    sentence_silence=0.38,
                    chunk_size=420,
                ),
            )

        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["readyChunks"], 1)
        self.assertEqual(payload["totalChunks"], 1)
        self.assertEqual(payload["chunks"][0]["status"], "ready")
        self.assertEqual(payload["chunks"][0]["cacheKey"], identity["cacheKey"])


if __name__ == "__main__":
    unittest.main()
