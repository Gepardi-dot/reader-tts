"""
One-time migration: copy existing single-user data into the new multi-user
Supabase schema (books + highlights tables, progress user_id column).

Usage:
    python scripts/migrate_to_supabase.py

Required env vars (in .env or environment):
    SUPABASE_POOLER_URL   or SUPABASE_DB_URL
    SUPABASE_USER_ID      UUID of the account to assign all existing data to
                          (get it from Supabase dashboard → Authentication → Users)

Optional:
    BOOK_STORAGE_BUCKET   if set, also lists S3 books and imports any missing ones
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")


def env(name: str) -> str | None:
    v = os.environ.get(name, "").strip()
    return v or None


DB_URL = env("SUPABASE_POOLER_URL") or env("SUPABASE_DB_URL") or env("DATABASE_URL")
USER_ID = env("SUPABASE_USER_ID")

if not DB_URL:
    sys.exit("ERROR: SUPABASE_POOLER_URL is not set in .env")
if not USER_ID:
    sys.exit(
        "ERROR: SUPABASE_USER_ID is not set.\n"
        "Find your UUID in Supabase dashboard → Authentication → Users."
    )

try:
    import psycopg
except ImportError:
    sys.exit("ERROR: psycopg not installed. Run: pip install -r requirements.txt")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def migrate_books_from_filesystem(conn: psycopg.Connection, user_id: str) -> int:
    library = ROOT / "library" / "books"
    if not library.exists():
        return 0

    count = 0
    for meta_file in library.glob("*/meta.json"):
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  SKIP {meta_file}: {e}")
            continue

        book_id = meta.get("id")
        if not book_id:
            continue

        # Read matching highlights.json if it exists
        highlights_file = meta_file.parent / "highlights.json"
        highlights: list[dict] = []
        if highlights_file.exists():
            try:
                raw = json.loads(highlights_file.read_text(encoding="utf-8"))
                highlights = raw.get("items", []) if isinstance(raw, dict) else []
            except Exception:
                pass

        _upsert_book(conn, meta, user_id)
        _upsert_highlights(conn, book_id, user_id, highlights)
        count += 1
        print(f"  ✓ {meta.get('title', book_id)[:60]}  ({len(highlights)} highlights)")

    return count


def migrate_books_from_storage(conn: psycopg.Connection, user_id: str) -> int:
    bucket = env("BOOK_STORAGE_BUCKET")
    if not bucket:
        return 0

    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        print("  boto3 not installed, skipping S3 import")
        return 0

    endpoint = env("BOOK_STORAGE_ENDPOINT")
    region = env("BOOK_STORAGE_REGION") or env("AWS_REGION") or "us-east-1"
    prefix = (env("BOOK_STORAGE_PREFIX") or "storybook-reader").strip("/")
    addressing = (env("BOOK_STORAGE_ADDRESSING_STYLE") or "virtual").lower()

    session = boto3.Session()
    client = session.client(
        "s3",
        config=Config(
            connect_timeout=5, read_timeout=15, retries={"max_attempts": 2},
            s3={"addressing_style": addressing},
        ),
        endpoint_url=endpoint or (
            "https://s3.amazonaws.com" if region == "us-east-1"
            else f"https://s3.{region}.amazonaws.com"
        ),
    )

    paginator = client.get_paginator("list_objects_v2")
    books_prefix = f"{prefix}/books/"
    count = 0

    print(f"  Listing s3://{bucket}/{books_prefix} …")
    for page in paginator.paginate(Bucket=bucket, Prefix=books_prefix):
        for obj in page.get("Contents", []):
            key: str = obj["Key"]
            if not key.endswith("/meta.json"):
                continue
            try:
                body = client.get_object(Bucket=bucket, Key=key)["Body"].read()
                meta = json.loads(body)
            except Exception as e:
                print(f"  SKIP {key}: {e}")
                continue

            book_id = meta.get("id")
            if not book_id:
                continue

            highlights_key = key.replace("/meta.json", "/highlights.json")
            highlights: list[dict] = []
            try:
                body = client.get_object(Bucket=bucket, Key=highlights_key)["Body"].read()
                raw = json.loads(body)
                highlights = raw.get("items", []) if isinstance(raw, dict) else []
            except Exception:
                pass

            _upsert_book(conn, meta, user_id)
            _upsert_highlights(conn, book_id, user_id, highlights)
            count += 1
            print(f"  ✓ {meta.get('title', book_id)[:60]}  ({len(highlights)} highlights)")

    return count


def _upsert_book(conn: psycopg.Connection, meta: dict, user_id: str) -> None:
    uploaded_raw = meta.get("uploadedAt", "")
    try:
        if uploaded_raw.endswith("Z"):
            uploaded_raw = uploaded_raw[:-1] + "+00:00"
        uploaded_at = datetime.fromisoformat(uploaded_raw)
    except Exception:
        uploaded_at = utc_now()

    latest_audio = meta.get("latestAudio")
    audio_history = meta.get("audioHistory", [])
    source_storage = meta.get("sourceStorage")

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO books (id, user_id, title, file_name, uploaded_at,
                               page_count, text_chars, excerpt,
                               latest_audio, audio_history, source_storage)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                user_id        = EXCLUDED.user_id,
                title          = EXCLUDED.title,
                file_name      = EXCLUDED.file_name,
                page_count     = EXCLUDED.page_count,
                text_chars     = EXCLUDED.text_chars,
                excerpt        = EXCLUDED.excerpt,
                latest_audio   = EXCLUDED.latest_audio,
                audio_history  = EXCLUDED.audio_history,
                source_storage = EXCLUDED.source_storage
            """,
            (
                meta["id"],
                user_id,
                meta.get("title", ""),
                meta.get("fileName", ""),
                uploaded_at,
                meta.get("pageCount", 0),
                meta.get("textCharacters", 0),
                meta.get("excerpt", ""),
                json.dumps(latest_audio) if latest_audio else None,
                json.dumps(audio_history),
                json.dumps(source_storage) if source_storage else None,
            ),
        )
    conn.commit()


def _upsert_highlights(conn: psycopg.Connection, book_id: str, user_id: str, items: list[dict]) -> None:
    if not items:
        return
    with conn.cursor() as cur:
        for h in items:
            created_raw = h.get("createdAt", "")
            try:
                if created_raw.endswith("Z"):
                    created_raw = created_raw[:-1] + "+00:00"
                created_at = datetime.fromisoformat(created_raw)
            except Exception:
                created_at = utc_now()

            cur.execute(
                """
                INSERT INTO highlights (id, book_id, user_id, start_pos, end_pos,
                                        color, kind, text, note, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (book_id, id) DO NOTHING
                """,
                (
                    h.get("id", uuid.uuid4().hex[:12]),
                    book_id, user_id,
                    h.get("start", 0), h.get("end", 0),
                    h.get("color", "amber"),
                    h.get("kind", "highlight"),
                    h.get("text", ""),
                    h.get("note"),
                    created_at,
                ),
            )
    conn.commit()


def migrate_progress(conn: psycopg.Connection, user_id: str) -> int:
    """Assign user_id to legacy progress rows that have NULL user_id."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE reader_progress SET user_id = %s WHERE user_id IS NULL",
            (user_id,),
        )
        rp = cur.rowcount or 0
        cur.execute(
            "UPDATE audio_progress SET user_id = %s WHERE user_id IS NULL",
            (user_id,),
        )
        ap = cur.rowcount or 0
    conn.commit()
    return rp + ap


def main() -> None:
    print(f"Connecting to Supabase …")
    with psycopg.connect(DB_URL) as conn:
        print(f"Migrating books from local library/ …")
        n_fs = migrate_books_from_filesystem(conn, USER_ID)
        print(f"  → {n_fs} books from filesystem")

        print(f"Migrating books from S3/Supabase Storage …")
        n_s3 = migrate_books_from_storage(conn, USER_ID)
        print(f"  → {n_s3} books from storage")

        print(f"Claiming legacy progress rows …")
        n_prog = migrate_progress(conn, USER_ID)
        print(f"  → {n_prog} progress rows updated")

    print("\nDone. All data is now owned by user:", USER_ID)
    if n_fs + n_s3 == 0:
        print("\nNote: no books were found. If your books are in S3, set BOOK_STORAGE_BUCKET in .env")


if __name__ == "__main__":
    main()
