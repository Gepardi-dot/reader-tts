from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import server.app as server_app


class BookImportResilienceTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tempdir, ignore_errors=True)

    def test_write_book_text_ignores_optional_cache_failure(self) -> None:
        with (
            patch.object(server_app, "BOOKS_ROOT", self.tempdir / "books"),
            patch.object(server_app, "progress_store_configured", return_value=True),
            patch.object(server_app, "book_storage_enabled", return_value=False),
            patch.object(server_app, "current_user_id", return_value="00000000-0000-0000-0000-000000000001"),
            patch.object(server_app, "write_book_text_cache_sql", side_effect=RuntimeError("cache unavailable")),
        ):
            server_app.write_book_text("book-1", "Recovered text")

        self.assertEqual((self.tempdir / "books" / "book-1" / "cleaned.txt").read_text(encoding="utf-8"), "Recovered text")

    def test_recover_book_text_uses_import_cache_without_source_file(self) -> None:
        with (
            patch.object(
                server_app,
                "read_book_import_cache_safely",
                return_value={"cleanedText": "Cached book text"},
            ) as read_cache,
            patch.object(server_app, "write_book_text") as write_text,
        ):
            text = server_app.recover_book_text_from_source(
                "book-2",
                {
                    "id": "book-2",
                    "fileName": "missing.pdf",
                    "sourceSha256": "abc123",
                },
                user_id="00000000-0000-0000-0000-000000000001",
            )

        self.assertEqual(text, "Cached book text")
        read_cache.assert_called_once()
        write_text.assert_called_once_with("book-2", "Cached book text")

    def test_duplicate_upload_rebuilds_missing_existing_text(self) -> None:
        uploaded_source = self.tempdir / "source.pdf"
        uploaded_source.write_bytes(b"%PDF-1.4\n")
        existing = {"id": "book-3", "fileName": "story.pdf"}

        with (
            patch.object(server_app, "read_book_text", side_effect=FileNotFoundError("book-3")),
            patch.object(server_app, "progress_store_configured", return_value=True),
            patch.object(server_app, "current_user_id", return_value="00000000-0000-0000-0000-000000000001"),
            patch.object(
                server_app,
                "extract_cleaned_book_source",
                return_value={"text": "Recovered duplicate text", "pageCount": 1, "sourceFormat": "pdf"},
            ) as extract_source,
            patch.object(server_app, "write_book_meta") as write_meta,
            patch.object(server_app, "write_book_text") as write_text,
        ):
            server_app.ensure_existing_book_text_from_upload(
                existing,
                uploaded_source,
                "story.pdf",
                "abc123",
            )

        extract_source.assert_called_once()
        self.assertEqual(existing["textCharacters"], len("Recovered duplicate text"))
        write_meta.assert_called_once()
        write_text.assert_called_once_with("book-3", "Recovered duplicate text")

    def test_stale_local_source_path_serializes_to_api_source_url(self) -> None:
        meta = {
            "id": "book-4",
            "title": "Migrated book",
            "fileName": "story.pdf",
            "uploadedAt": "2026-04-22T00:00:00+00:00",
            "pageCount": 1,
            "textCharacters": 12,
            "excerpt": "hello",
            "latestAudio": None,
            "sourcePath": r"C:\Users\miroa\storybook-reader\library\books\book-4\source.pdf",
            "_highlightCount": 0,
        }

        with patch.object(server_app, "DATA_ROOT", Path("/tmp/storybook-reader/library")):
            serialized = server_app.serialize_book(meta)

        self.assertEqual(serialized["sourceUrl"], "/api/books/book-4/source")

    def test_duplicate_upload_updates_existing_source_storage_without_reextracting(self) -> None:
        uploaded_source = self.tempdir / "source.pdf"
        uploaded_source.write_bytes(b"%PDF-1.4\n")
        existing = {
            "id": "book-5",
            "fileName": "story.pdf",
            "sourcePath": r"C:\Users\miroa\storybook-reader\library\books\book-5\source.pdf",
        }
        source_storage = {
            "bucket": "books",
            "key": "storybook-reader/books/user/book-5/source.pdf",
            "contentType": "application/pdf",
        }

        with (
            patch.object(server_app, "read_book_text", return_value="Already cached"),
            patch.object(server_app, "write_book_meta") as write_meta,
            patch.object(server_app, "extract_cleaned_book_source") as extract_source,
        ):
            server_app.ensure_existing_book_text_from_upload(
                existing,
                uploaded_source,
                "story.pdf",
                "abc123",
                source_storage=source_storage,
            )

        self.assertEqual(existing["sourceStorage"], source_storage)
        self.assertNotIn("sourcePath", existing)
        extract_source.assert_not_called()
        write_meta.assert_called_once_with("book-5", existing)


if __name__ == "__main__":
    unittest.main()
