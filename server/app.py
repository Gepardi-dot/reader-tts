from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
import wave
from base64 import b64decode
from contextlib import contextmanager
from datetime import datetime, timezone
from html import escape as escape_html
from http import HTTPStatus
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from pypdf import PdfReader

import pdf_to_audio


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")


def env_value(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


for env_name in (
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "POLLY_REGION",
    "AWS_POLLY_VOICE_ID",
    "POLLY_VOICE_ID",
    "AWS_POLLY_ENGINE",
    "POLLY_ENGINE",
    "AWS_POLLY_LANGUAGE_CODE",
    "POLLY_LANGUAGE_CODE",
    "OPENAI_API_KEY",
    "OPENAI_TTS_MODEL",
    "GEMINI_API_KEY",
    "GEMINI_TTS_MODEL",
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_BASE_HTTP_API_URL",
    "QWEN_TTS_MODEL",
    "PIPER_EXE",
    "PIPER_ESPEAK_DATA",
    "SUPABASE_DB_URL",
    "SUPABASE_POOLER_URL",
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
):
    if env_name in os.environ and env_value(env_name) is None:
        os.environ.pop(env_name, None)


def runtime_root() -> Path:
    if os.environ.get("VERCEL"):
        return Path(tempfile.gettempdir()) / "storybook-reader"
    return ROOT


def frontend_root() -> Path:
    candidates = [ROOT / "web" / "dist", ROOT / "public"]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


RUNTIME_ROOT = runtime_root()
DATA_ROOT = RUNTIME_ROOT / "library"
BOOKS_ROOT = DATA_ROOT / "books"
JOBS_ROOT = DATA_ROOT / "jobs"
WEB_DIST = frontend_root()
DEFAULT_AUDIO_DIR = RUNTIME_ROOT / "output"
PREVIEW_ROOT = DATA_ROOT / "previews"
VOICES_ROOT = ROOT / "voices"
OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"
OPENAI_TTS_MODEL = env_value("OPENAI_TTS_MODEL") or "gpt-4o-mini-tts"
GEMINI_TTS_MODEL = env_value("GEMINI_TTS_MODEL") or "gemini-2.5-flash-preview-tts"
DASHSCOPE_BASE_HTTP_API_URL = env_value("DASHSCOPE_BASE_HTTP_API_URL") or "https://dashscope-intl.aliyuncs.com/api/v1"
QWEN_TTS_MODEL = env_value("QWEN_TTS_MODEL") or "qwen3-tts-instruct-flash"
POLLY_REGION = env_value("POLLY_REGION") or env_value("AWS_REGION") or env_value("AWS_DEFAULT_REGION")
POLLY_VOICE_ID = env_value("AWS_POLLY_VOICE_ID") or env_value("POLLY_VOICE_ID") or "Matthew"
POLLY_ENGINE = (env_value("AWS_POLLY_ENGINE") or env_value("POLLY_ENGINE") or "standard").lower()
POLLY_LANGUAGE_CODE = env_value("AWS_POLLY_LANGUAGE_CODE") or env_value("POLLY_LANGUAGE_CODE") or "en-US"
POLLY_PCM_SAMPLE_RATE = "16000"
POLLY_CACHE_TTL_SECONDS = 300
GEMINI_MAX_RETRY_ATTEMPTS = 3
GEMINI_MAX_RETRY_DELAY_SECONDS = 75.0


def voice_option(
    voice_id: str,
    label: str,
    *,
    gender: Literal["male", "female", "neutral"] | None = None,
    gender_source: Literal["provider", "estimated"] | None = None,
    style: str | None = None,
    tags: list[str] | None = None,
    models: list[str] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"id": voice_id, "label": label}
    if gender is not None:
        payload["gender"] = gender
    if gender_source is not None:
        payload["genderSource"] = gender_source
    if style is not None:
        payload["style"] = style
    if tags:
        payload["tags"] = tags
    if models:
        payload["models"] = models
    return payload


def provider_model_option(
    model_id: str,
    label: str,
    description: str,
    *,
    storytelling: bool = False,
) -> dict[str, Any]:
    return {
        "id": model_id,
        "label": label,
        "description": description,
        "storytelling": storytelling,
    }


GEMINI_TTS_MODELS = [
    provider_model_option(
        "gemini-2.5-flash-preview-tts",
        "Gemini 2.5 Flash TTS",
        "Fast preview TTS for general narration and voice tests.",
    ),
    provider_model_option(
        "gemini-2.5-pro-preview-tts",
        "Gemini 2.5 Pro TTS",
        "Higher-capability preview TTS when you want more deliberate directed narration. May require paid Gemini quota.",
        storytelling=True,
    ),
]
GEMINI_TTS_MODEL_IDS = {item["id"] for item in GEMINI_TTS_MODELS}
QWEN_TTS_MODELS = [
    provider_model_option(
        "qwen3-tts-instruct-flash",
        "Qwen3 TTS Instruct Flash",
        "Expressive instruction-guided narration for audiobooks, dramatic reads, and premium previews.",
        storytelling=True,
    ),
    provider_model_option(
        "qwen3-tts-flash",
        "Qwen3 TTS Flash",
        "Lower-cost multilingual speech synthesis for straightforward narration and utility reads.",
    ),
]
QWEN_TTS_MODEL_IDS = {item["id"] for item in QWEN_TTS_MODELS}
OPENAI_TTS_MODELS = [
    provider_model_option(
        "gpt-4o-mini-tts",
        "GPT-4o mini TTS",
        "Fast promptable narration with a lightweight model.",
    )
]
OPENAI_VOICES = [
    voice_option("alloy", "Alloy", gender="neutral", gender_source="estimated", style="Balanced"),
    voice_option("ash", "Ash", gender="male", gender_source="estimated", style="Calm"),
    voice_option("ballad", "Ballad", gender="male", gender_source="estimated", style="Dramatic", tags=["Story"]),
    voice_option("coral", "Coral", gender="female", gender_source="estimated", style="Warm", tags=["Story"]),
    voice_option("echo", "Echo", gender="male", gender_source="estimated", style="Clear"),
    voice_option("fable", "Fable", gender="male", gender_source="estimated", style="Narrative", tags=["Story"]),
    voice_option("nova", "Nova", gender="female", gender_source="estimated", style="Bright"),
    voice_option("onyx", "Onyx", gender="male", gender_source="estimated", style="Deep", tags=["Story"]),
    voice_option("sage", "Sage", gender="female", gender_source="estimated", style="Measured"),
    voice_option("shimmer", "Shimmer", gender="female", gender_source="estimated", style="Light"),
]
QWEN_VOICES = [
    voice_option(
        "Cherry",
        "Cherry",
        gender="female",
        gender_source="provider",
        style="Lively",
        tags=["Story"],
        models=["qwen3-tts-instruct-flash", "qwen3-tts-flash"],
    ),
    voice_option(
        "Serena",
        "Serena",
        gender="female",
        gender_source="provider",
        style="Warm",
        tags=["Story"],
        models=["qwen3-tts-instruct-flash", "qwen3-tts-flash"],
    ),
    voice_option(
        "Jennifer",
        "Jennifer",
        gender="female",
        gender_source="provider",
        style="Clear",
        models=["qwen3-tts-flash"],
    ),
    voice_option(
        "Mia",
        "Mia",
        gender="female",
        gender_source="provider",
        style="Bright",
        models=["qwen3-tts-instruct-flash", "qwen3-tts-flash"],
    ),
    voice_option(
        "Bellona",
        "Bellona",
        gender="female",
        gender_source="provider",
        style="Dramatic",
        tags=["Story"],
        models=["qwen3-tts-instruct-flash", "qwen3-tts-flash"],
    ),
    voice_option(
        "Ethan",
        "Ethan",
        gender="male",
        gender_source="provider",
        style="Natural",
        models=["qwen3-tts-instruct-flash", "qwen3-tts-flash"],
    ),
    voice_option(
        "Ryan",
        "Ryan",
        gender="male",
        gender_source="provider",
        style="Conversational",
        models=["qwen3-tts-flash"],
    ),
    voice_option(
        "Aiden",
        "Aiden",
        gender="male",
        gender_source="provider",
        style="Measured",
        models=["qwen3-tts-flash"],
    ),
    voice_option(
        "Neil",
        "Neil",
        gender="male",
        gender_source="provider",
        style="Steady",
        models=["qwen3-tts-instruct-flash", "qwen3-tts-flash"],
    ),
    voice_option(
        "Vincent",
        "Vincent",
        gender="male",
        gender_source="provider",
        style="Deep",
        tags=["Story"],
        models=["qwen3-tts-instruct-flash", "qwen3-tts-flash"],
    ),
    voice_option(
        "Arthur",
        "Arthur",
        gender="male",
        gender_source="provider",
        style="Classic",
        tags=["Story"],
        models=["qwen3-tts-instruct-flash", "qwen3-tts-flash"],
    ),
    voice_option(
        "Elias",
        "Elias",
        gender="male",
        gender_source="provider",
        style="Smooth",
        models=["qwen3-tts-instruct-flash", "qwen3-tts-flash"],
    ),
]
GEMINI_VOICES = [
    voice_option("Zephyr", "Zephyr", gender="neutral", gender_source="estimated", style="Bright"),
    voice_option("Puck", "Puck", gender="male", gender_source="estimated", style="Upbeat"),
    voice_option("Charon", "Charon", gender="male", gender_source="estimated", style="Informative"),
    voice_option("Kore", "Kore", gender="female", gender_source="estimated", style="Firm", tags=["Story"]),
    voice_option("Fenrir", "Fenrir", gender="male", gender_source="estimated", style="Excitable"),
    voice_option("Leda", "Leda", gender="female", gender_source="estimated", style="Youthful"),
    voice_option("Orus", "Orus", gender="male", gender_source="estimated", style="Firm"),
    voice_option("Aoede", "Aoede", gender="female", gender_source="estimated", style="Breezy"),
    voice_option("Callirrhoe", "Callirrhoe", gender="female", gender_source="estimated", style="Easy-going"),
    voice_option("Autonoe", "Autonoe", gender="female", gender_source="estimated", style="Bright"),
    voice_option("Enceladus", "Enceladus", gender="male", gender_source="estimated", style="Breathy"),
    voice_option("Iapetus", "Iapetus", gender="male", gender_source="estimated", style="Clear"),
    voice_option("Umbriel", "Umbriel", gender="neutral", gender_source="estimated", style="Easy-going"),
    voice_option("Algieba", "Algieba", gender="neutral", gender_source="estimated", style="Smooth"),
    voice_option("Despina", "Despina", gender="female", gender_source="estimated", style="Smooth"),
    voice_option("Erinome", "Erinome", gender="female", gender_source="estimated", style="Clear"),
    voice_option("Algenib", "Algenib", gender="neutral", gender_source="estimated", style="Gravelly"),
    voice_option("Rasalgethi", "Rasalgethi", gender="neutral", gender_source="estimated", style="Informative"),
    voice_option("Laomedeia", "Laomedeia", gender="female", gender_source="estimated", style="Upbeat"),
    voice_option("Achernar", "Achernar", gender="neutral", gender_source="estimated", style="Soft", tags=["Story"]),
    voice_option("Alnilam", "Alnilam", gender="neutral", gender_source="estimated", style="Firm"),
    voice_option("Schedar", "Schedar", gender="neutral", gender_source="estimated", style="Even"),
    voice_option("Gacrux", "Gacrux", gender="neutral", gender_source="estimated", style="Mature", tags=["Story"]),
    voice_option("Pulcherrima", "Pulcherrima", gender="female", gender_source="estimated", style="Forward"),
    voice_option("Achird", "Achird", gender="neutral", gender_source="estimated", style="Friendly"),
    voice_option("Zubenelgenubi", "Zubenelgenubi", gender="neutral", gender_source="estimated", style="Casual"),
    voice_option("Vindemiatrix", "Vindemiatrix", gender="female", gender_source="estimated", style="Gentle"),
    voice_option("Sadachbia", "Sadachbia", gender="neutral", gender_source="estimated", style="Lively"),
    voice_option("Sadaltager", "Sadaltager", gender="neutral", gender_source="estimated", style="Knowledgeable"),
    voice_option("Sulafat", "Sulafat", gender="female", gender_source="estimated", style="Warm", tags=["Story"]),
]
DEFAULT_NARRATION_STYLE = (
    "Read like a premium audiobook narrator. Keep the pacing controlled, "
    "the phrasing natural, and the delivery emotionally aware without adding "
    "or changing any words from the text."
)
PROVIDER_TEST_SNIPPET = (
    "When the room quieted, the story finally found its rhythm. "
    "Read this sample with natural phrasing, steady pacing, and a warm, attentive tone."
)
SUPABASE_DB_URL = env_value("SUPABASE_POOLER_URL") or env_value("SUPABASE_DB_URL") or env_value("DATABASE_URL")

for directory in (DATA_ROOT, BOOKS_ROOT, JOBS_ROOT, DEFAULT_AUDIO_DIR, PREVIEW_ROOT):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Storybook Reader", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/library", StaticFiles(directory=str(DATA_ROOT)), name="library")

job_lock = threading.Lock()
job_state: dict[str, dict[str, Any]] = {}
polly_catalog_cache: dict[str, Any] | None = None
polly_catalog_cache_expires_at = 0.0
progress_store_lock = threading.Lock()
progress_store_ready = False


class JobCancelledError(RuntimeError):
    pass


class GenerateAudioRequest(BaseModel):
    provider: Literal["piper", "google", "openai", "polly", "qwen"] = "piper"
    voice: str | None = None
    model: str | None = None
    output_format: Literal["mp3", "m4b", "wav"] = "mp3"
    narration_style: str = Field(default=DEFAULT_NARRATION_STYLE, max_length=1500)
    chunk_size: int | None = Field(default=None, ge=300, le=4000)
    length_scale: float = Field(default=1.0, ge=0.6, le=1.5)
    sentence_silence: float = Field(default=0.2, ge=0.0, le=1.0)


class ProviderTestRequest(BaseModel):
    provider: Literal["piper", "google", "openai", "polly", "qwen"] = "piper"
    voice: str | None = None
    model: str | None = None
    narration_style: str = Field(default=DEFAULT_NARRATION_STYLE, max_length=1500)
    length_scale: float = Field(default=1.0, ge=0.6, le=1.5)
    sentence_silence: float = Field(default=0.2, ge=0.0, le=1.0)


class LiveAudioRequest(BaseModel):
    provider: Literal["piper", "google", "openai", "polly", "qwen"] = "openai"
    voice: str | None = None
    model: str | None = None
    output_format: Literal["mp3", "wav"] = "mp3"
    narration_style: str = Field(default=DEFAULT_NARRATION_STYLE, max_length=1500)
    length_scale: float = Field(default=1.0, ge=0.6, le=1.5)
    sentence_silence: float = Field(default=0.2, ge=0.0, le=1.0)
    pageNumber: int = Field(ge=1)
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    text: str = Field(min_length=1, max_length=20000)


class HighlightCreateRequest(BaseModel):
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    color: Literal["amber", "rose", "sky"]
    text: str = Field(min_length=1, max_length=800)
    note: str | None = Field(default=None, max_length=500)


class ReadingProgressRequest(BaseModel):
    pageNumber: int = Field(ge=1)
    totalPages: int = Field(ge=1)
    textStart: int = Field(ge=0)
    textEnd: int = Field(ge=0)
    textLength: int = Field(ge=0)
    updatedAt: str | None = None


class AudioProgressRequest(BaseModel):
    audioUrl: str = Field(min_length=1, max_length=4000)
    currentTime: float = Field(ge=0)
    wasPlaying: bool
    updatedAt: str | None = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    for attempt in range(10):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.05 * (attempt + 1))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    for attempt in range(10):
        try:
            temp_path.replace(path)
            return
        except PermissionError:
            if attempt == 9:
                temp_path.unlink(missing_ok=True)
                raise
            time.sleep(0.05 * (attempt + 1))


def parse_client_timestamp(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)

    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"

    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return datetime.now(timezone.utc)

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed.astimezone(timezone.utc)


def serialize_timestamp(value: datetime | None) -> str:
    if value is None:
        return utc_now()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def progress_store_configured() -> bool:
    return SUPABASE_DB_URL is not None


def load_psycopg():
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("Supabase progress syncing requires psycopg. Reinstall with `pip install -r requirements.txt`.") from exc

    return psycopg


def ensure_progress_store() -> None:
    global progress_store_ready

    if progress_store_ready or not progress_store_configured():
        return

    with progress_store_lock:
        if progress_store_ready or not progress_store_configured():
            return

        psycopg = load_psycopg()

        try:
            with psycopg.connect(SUPABASE_DB_URL) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        create table if not exists reader_progress (
                            book_id text primary key,
                            page_number integer not null,
                            total_pages integer not null,
                            text_start integer not null,
                            text_end integer not null,
                            text_length integer not null,
                            updated_at timestamptz not null default now()
                        )
                        """
                    )
                    cur.execute(
                        """
                        create table if not exists audio_progress (
                            book_id text primary key,
                            audio_url text not null,
                            playback_time double precision not null,
                            was_playing boolean not null,
                            updated_at timestamptz not null default now()
                        )
                        """
                    )
        except Exception as exc:
            raise RuntimeError(f"Failed to connect to Supabase Postgres: {exc}") from exc

        progress_store_ready = True


@contextmanager
def progress_store_cursor():
    if not progress_store_configured():
        raise RuntimeError("SUPABASE_DB_URL is not configured.")

    ensure_progress_store()
    psycopg = load_psycopg()

    try:
        with psycopg.connect(SUPABASE_DB_URL) as conn:
            with conn.cursor() as cur:
                yield cur
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Failed to access Supabase progress store: {exc}") from exc


def serialize_reading_progress_row(row: tuple[Any, ...] | None) -> dict[str, Any] | None:
    if not row:
        return None

    page_number, total_pages, text_start, text_end, text_length, updated_at = row
    return {
        "pageNumber": page_number,
        "totalPages": total_pages,
        "textStart": text_start,
        "textEnd": text_end,
        "textLength": text_length,
        "updatedAt": serialize_timestamp(updated_at),
    }


def serialize_audio_progress_row(row: tuple[Any, ...] | None) -> dict[str, Any] | None:
    if not row:
        return None

    audio_url, current_time, was_playing, updated_at = row
    return {
        "url": audio_url,
        "currentTime": current_time,
        "wasPlaying": was_playing,
        "updatedAt": serialize_timestamp(updated_at),
    }


def book_progress_payload(book_id: str) -> dict[str, Any]:
    load_book_or_404(book_id)

    if not progress_store_configured():
        return {"reading": None, "audio": None}

    try:
        with progress_store_cursor() as cur:
            cur.execute(
                """
                select page_number, total_pages, text_start, text_end, text_length, updated_at
                from reader_progress
                where book_id = %s
                """,
                (book_id,),
            )
            reading = serialize_reading_progress_row(cur.fetchone())
            cur.execute(
                """
                select audio_url, playback_time, was_playing, updated_at
                from audio_progress
                where book_id = %s
                """,
                (book_id,),
            )
            audio = serialize_audio_progress_row(cur.fetchone())
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {
        "reading": reading,
        "audio": audio,
    }


def write_book_reading_progress(book_id: str, request: ReadingProgressRequest) -> dict[str, Any]:
    load_book_or_404(book_id)

    if request.textEnd < request.textStart:
        raise HTTPException(status_code=400, detail="Reading progress end must be after the start.")
    if request.textLength and request.textEnd > request.textLength:
        raise HTTPException(status_code=400, detail="Reading progress end cannot exceed the book length.")

    updated_at = parse_client_timestamp(request.updatedAt)
    payload = {
        "pageNumber": request.pageNumber,
        "totalPages": request.totalPages,
        "textStart": request.textStart,
        "textEnd": request.textEnd,
        "textLength": request.textLength,
        "updatedAt": serialize_timestamp(updated_at),
    }

    if not progress_store_configured():
        return payload

    try:
        with progress_store_cursor() as cur:
            cur.execute(
                """
                insert into reader_progress (
                    book_id,
                    page_number,
                    total_pages,
                    text_start,
                    text_end,
                    text_length,
                    updated_at
                )
                values (%s, %s, %s, %s, %s, %s, %s)
                on conflict (book_id) do update
                set
                    page_number = excluded.page_number,
                    total_pages = excluded.total_pages,
                    text_start = excluded.text_start,
                    text_end = excluded.text_end,
                    text_length = excluded.text_length,
                    updated_at = excluded.updated_at
                """,
                (
                    book_id,
                    request.pageNumber,
                    request.totalPages,
                    request.textStart,
                    request.textEnd,
                    request.textLength,
                    updated_at,
                ),
            )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return payload


def write_book_audio_progress(book_id: str, request: AudioProgressRequest) -> dict[str, Any]:
    load_book_or_404(book_id)

    updated_at = parse_client_timestamp(request.updatedAt)
    payload = {
        "url": request.audioUrl,
        "currentTime": request.currentTime,
        "wasPlaying": request.wasPlaying,
        "updatedAt": serialize_timestamp(updated_at),
    }

    if not progress_store_configured():
        return payload

    try:
        with progress_store_cursor() as cur:
            cur.execute(
                """
                insert into audio_progress (
                    book_id,
                    audio_url,
                    playback_time,
                    was_playing,
                    updated_at
                )
                values (%s, %s, %s, %s, %s)
                on conflict (book_id) do update
                set
                    audio_url = excluded.audio_url,
                    playback_time = excluded.playback_time,
                    was_playing = excluded.was_playing,
                    updated_at = excluded.updated_at
                """,
                (
                    book_id,
                    request.audioUrl,
                    request.currentTime,
                    request.wasPlaying,
                    updated_at,
                ),
            )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return payload


def delete_book_audio_progress(book_id: str) -> dict[str, bool]:
    load_book_or_404(book_id)

    if not progress_store_configured():
        return {"ok": True}

    try:
        with progress_store_cursor() as cur:
            cur.execute("delete from audio_progress where book_id = %s", (book_id,))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {"ok": True}


def delete_book_progress_records(book_id: str) -> None:
    if not progress_store_configured():
        return

    try:
        with progress_store_cursor() as cur:
            cur.execute("delete from reader_progress where book_id = %s", (book_id,))
            cur.execute("delete from audio_progress where book_id = %s", (book_id,))
    except RuntimeError:
        return


def relative_url(path: Path) -> str:
    return f"/library/{path.relative_to(DATA_ROOT).as_posix()}"


def book_dir(book_id: str) -> Path:
    return BOOKS_ROOT / book_id


def book_meta_path(book_id: str) -> Path:
    return book_dir(book_id) / "meta.json"


def book_text_path(book_id: str) -> Path:
    return book_dir(book_id) / "cleaned.txt"


def book_live_audio_dir(book_id: str) -> Path:
    return book_dir(book_id) / "live_audio"


def book_highlights_path(book_id: str) -> Path:
    return book_dir(book_id) / "highlights.json"


def job_path(job_id: str) -> Path:
    return JOBS_ROOT / f"{job_id}.json"


def get_voice_models() -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    for voice_path in sorted(VOICES_ROOT.glob("*.onnx")):
        results.append(
            {
                "id": str(voice_path.resolve()),
                "label": voice_path.stem.replace("-", " "),
            }
        )
    return results


def polly_sdk_available() -> bool:
    return importlib.util.find_spec("boto3") is not None


def load_boto3():
    if not polly_sdk_available():
        raise RuntimeError("Amazon Polly support requires boto3. Reinstall with `pip install -r requirements.txt`.")

    try:
        import boto3
        from botocore.config import Config
        from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError, NoRegionError, ProfileNotFound
    except ImportError as exc:
        raise RuntimeError("Amazon Polly support requires boto3. Reinstall with `pip install -r requirements.txt`.") from exc

    return boto3, Config, BotoCoreError, ClientError, NoCredentialsError, NoRegionError, ProfileNotFound


def dashscope_sdk_available() -> bool:
    return importlib.util.find_spec("dashscope") is not None


def load_dashscope():
    if not dashscope_sdk_available():
        raise RuntimeError("Qwen TTS support requires dashscope. Reinstall with `pip install -r requirements.txt`.")

    try:
        import dashscope
    except ImportError as exc:
        raise RuntimeError("Qwen TTS support requires dashscope. Reinstall with `pip install -r requirements.txt`.") from exc

    dashscope.base_http_api_url = DASHSCOPE_BASE_HTTP_API_URL
    return dashscope


def create_polly_session():
    boto3, _, _, _, _, _, ProfileNotFound = load_boto3()

    session_kwargs: dict[str, Any] = {}
    if POLLY_REGION:
        session_kwargs["region_name"] = POLLY_REGION
    aws_profile = env_value("AWS_PROFILE")
    if aws_profile:
        session_kwargs["profile_name"] = aws_profile

    try:
        session = boto3.Session(**session_kwargs)
    except ProfileNotFound as exc:
        raise RuntimeError(f"AWS profile was not found: {exc}") from exc

    credentials = session.get_credentials()
    if credentials is None:
        raise RuntimeError(
            "AWS credentials were not found. Use the AWS CLI, set AWS_PROFILE, "
            "or provide AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY."
        )

    return session


def create_aws_client(service_name: str):
    session = create_polly_session()
    _, Config, _, _, _, _, _ = load_boto3()
    client_config = Config(
        connect_timeout=3,
        read_timeout=10,
        retries={"max_attempts": 1},
    )
    return session.client(service_name, config=client_config)


def create_polly_client():
    return create_aws_client("polly")


def gender_label(value: str | None) -> str:
    if not value:
        return "Voice"
    return value.title()


def get_polly_catalog(force_refresh: bool = False) -> dict[str, Any]:
    global polly_catalog_cache, polly_catalog_cache_expires_at

    if not force_refresh and polly_catalog_cache and time.monotonic() < polly_catalog_cache_expires_at:
        return polly_catalog_cache

    default_catalog = {
        "available": False,
        "description": "Configure AWS CLI credentials or AWS_PROFILE to use Amazon Polly.",
        "voices": [],
        "defaultVoice": POLLY_VOICE_ID,
    }

    try:
        client = create_polly_client()
        request: dict[str, Any] = {"Engine": POLLY_ENGINE, "LanguageCode": POLLY_LANGUAGE_CODE}
        voices: list[dict[str, str]] = []

        while True:
            response = client.describe_voices(**request)
            for voice in response.get("Voices", []):
                supported_engines = voice.get("SupportedEngines", [])
                if POLLY_ENGINE not in supported_engines:
                    continue
                voices.append(
                    {
                        "id": voice["Id"],
                        "label": f"{voice['Name']} - {gender_label(voice.get('Gender'))}, {voice.get('LanguageCode', POLLY_LANGUAGE_CODE)}",
                        "gender": (voice.get("Gender") or "").lower() or None,
                        "genderSource": "provider",
                        "style": voice.get("LanguageCode", POLLY_LANGUAGE_CODE),
                    }
                )

            next_token = response.get("NextToken")
            if not next_token:
                break
            request["NextToken"] = next_token

        voices.sort(key=lambda item: item["label"])
        if not voices:
            catalog = {
                "available": False,
                "description": f"No Polly voices matched engine {POLLY_ENGINE} in {POLLY_LANGUAGE_CODE}.",
                "voices": [],
                "defaultVoice": POLLY_VOICE_ID,
            }
        else:
            default_voice = POLLY_VOICE_ID if any(voice["id"] == POLLY_VOICE_ID for voice in voices) else voices[0]["id"]
            region_label = POLLY_REGION or env_value("AWS_REGION") or "AWS default region"
            catalog = {
                "available": True,
                "description": f"AWS Polly {POLLY_ENGINE} voices from {region_label}.",
                "voices": voices,
                "defaultVoice": default_voice,
            }
    except Exception as exc:
        catalog = {
            **default_catalog,
            "description": f"Amazon Polly unavailable: {exc}",
        }

    polly_catalog_cache = catalog
    polly_catalog_cache_expires_at = time.monotonic() + POLLY_CACHE_TTL_SECONDS
    return catalog


def get_polly_health(force_refresh: bool = False) -> dict[str, Any]:
    catalog = get_polly_catalog(force_refresh=force_refresh)
    aws_profile = env_value("AWS_PROFILE")
    region_label = POLLY_REGION or env_value("AWS_REGION") or "AWS default region"

    health = {
        "connected": False,
        "region": region_label,
        "engine": POLLY_ENGINE,
        "languageCode": POLLY_LANGUAGE_CODE,
        "profile": aws_profile,
        "defaultVoice": catalog.get("defaultVoice"),
        "voiceCount": len(catalog.get("voices", [])),
        "accountId": None,
        "arn": None,
        "message": catalog["description"],
    }

    if not catalog["available"]:
        return health

    try:
        sts_client = create_aws_client("sts")
        identity = sts_client.get_caller_identity()
    except Exception as exc:
        return {
            **health,
            "message": f"Polly voices loaded, but AWS identity lookup failed: {exc}",
        }

    return {
        **health,
        "connected": True,
        "accountId": identity.get("Account"),
        "arn": identity.get("Arn"),
        "message": f"Connected to AWS account {identity.get('Account')} in {region_label}.",
    }


def provider_catalog() -> list[dict[str, Any]]:
    polly_catalog = get_polly_catalog()

    return [
        {
            "id": "qwen",
            "name": "Qwen TTS",
            "available": bool(env_value("DASHSCOPE_API_KEY")) and dashscope_sdk_available(),
            "recommended": True,
            "description": "Instruction-guided narration through DashScope with expressive voices and lower-cost synthesis.",
            "voices": QWEN_VOICES,
            "defaultVoice": "Cherry",
            "models": QWEN_TTS_MODELS,
            "defaultModel": resolve_qwen_tts_model(None),
            "voiceMetaNote": "Gender labels for Qwen voices come from Alibaba's voice catalog. Qwen TTS currently does not expose timestamps.",
        },
        {
            "id": "google",
            "name": "Google Gemini TTS",
            "available": bool(env_value("GEMINI_API_KEY")),
            "recommended": True,
            "description": "Preview Gemini audiobook-style TTS with a free tier and promptable delivery.",
            "voices": GEMINI_VOICES,
            "defaultVoice": "Kore",
            "models": GEMINI_TTS_MODELS,
            "defaultModel": resolve_google_tts_model(None),
            "voiceMetaNote": "Gender tags are estimated for Gemini voices. Style labels come from Google's voice catalog.",
        },
        {
            "id": "polly",
            "name": "Amazon Polly",
            "available": polly_catalog["available"],
            "recommended": False,
            "description": polly_catalog["description"],
            "voices": polly_catalog["voices"],
            "defaultVoice": polly_catalog["defaultVoice"],
            "models": [],
            "defaultModel": None,
            "voiceMetaNote": "Gender labels for Polly come from AWS voice metadata.",
        },
    ]


def provider_details(provider_id: str) -> dict[str, Any]:
    for provider in provider_catalog():
        if provider["id"] == provider_id:
            return provider
    raise HTTPException(status_code=404, detail="Provider not found.")


def read_highlights(book_id: str) -> list[dict[str, Any]]:
    path = book_highlights_path(book_id)
    if not path.exists():
        return []
    payload = read_json(path)
    items = payload.get("items")
    if isinstance(items, list):
        return items
    return []


def write_highlights(book_id: str, items: list[dict[str, Any]]) -> None:
    write_json(book_highlights_path(book_id), {"items": items})


def normalize_highlight_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def serialize_highlight(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "start": item["start"],
        "end": item["end"],
        "color": item["color"],
        "text": item["text"],
        "note": item.get("note"),
        "createdAt": item["createdAt"],
    }


def list_highlights(book_id: str) -> list[dict[str, Any]]:
    items = [serialize_highlight(item) for item in read_highlights(book_id)]
    items.sort(key=lambda item: (item["start"], item["createdAt"]))
    return items


def serialize_book(meta: dict[str, Any]) -> dict[str, Any]:
    latest_audio = meta.get("latestAudio")
    if latest_audio:
        latest_audio = {
            **latest_audio,
            "url": relative_url(Path(latest_audio["path"])),
            "timingUrl": relative_url(Path(latest_audio["timingPath"])) if latest_audio.get("timingPath") else None,
        }

    highlight_count = len(read_highlights(meta["id"]))

    return {
        "id": meta["id"],
        "title": meta["title"],
        "fileName": meta["fileName"],
        "uploadedAt": meta["uploadedAt"],
        "pageCount": meta["pageCount"],
        "textCharacters": meta["textCharacters"],
        "sourceUrl": relative_url(Path(meta["sourcePath"])),
        "excerpt": meta["excerpt"],
        "highlightCount": highlight_count,
        "latestAudio": latest_audio,
    }


def list_books() -> list[dict[str, Any]]:
    books: list[dict[str, Any]] = []
    for meta_file in BOOKS_ROOT.glob("*/meta.json"):
        books.append(serialize_book(read_json(meta_file)))
    books.sort(key=lambda item: item["uploadedAt"], reverse=True)
    return books


def persist_job(payload: dict[str, Any]) -> dict[str, Any]:
    with job_lock:
        job_state[payload["id"]] = payload
        write_json(job_path(payload["id"]), payload)
    return payload


def read_job_payload(job_id: str) -> dict[str, Any]:
    payload = job_state.get(job_id)
    if payload is not None:
        return payload

    path = job_path(job_id)
    if not path.exists():
        raise KeyError(job_id)

    payload = read_json(path)
    job_state[job_id] = payload
    return payload


def update_job(job_id: str, **changes: Any) -> dict[str, Any]:
    with job_lock:
        payload = read_job_payload(job_id)
        payload.update(changes)
        job_state[job_id] = payload
        write_json(job_path(job_id), payload)
    return payload


def maybe_update_job(job_id: str | None, **changes: Any) -> None:
    if not job_id:
        return

    path = job_path(job_id)
    if job_id in job_state or path.exists():
        update_job(job_id, **changes)


def raise_if_job_cancelled(job_id: str | None) -> None:
    if not job_id:
        return

    try:
        payload = read_job_payload(job_id)
    except KeyError:
        return

    if payload.get("cancelRequested"):
        raise JobCancelledError("Audiobook generation was cancelled.")


def record_job_progress(
    *,
    job_id: str | None,
    index: int,
    total: int,
    message: str,
) -> None:
    if not job_id:
        return

    path = job_path(job_id)
    if job_id not in job_state and not path.exists():
        return

    with job_lock:
        payload = read_job_payload(job_id)
        preserve_message = payload.get("status") == "cancelling"

        payload.update(
            completedChunks=max(int(payload.get("completedChunks", 0) or 0), index),
            totalChunks=total,
            progress=round(index / total * 100, 1),
            message=payload.get("message") if preserve_message else message,
        )
        job_state[job_id] = payload
        write_json(path, payload)


def clamp_chunk_size(provider: str, requested: int | None) -> int:
    if provider == "qwen":
        return min(max(requested or 560, 200), 600)
    if provider == "google":
        return min(max(requested or 2200, 500), 4000)
    if provider == "polly":
        return min(max(requested or 2200, 500), 2800)
    if provider == "openai":
        return min(max(requested or 1400, 400), 2500)
    return min(max(requested or 900, 300), 1600)


def gemini_tts_url(model_name: str) -> str:
    return f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"


def resolve_google_tts_model(requested_model: str | None) -> str:
    model_name = requested_model or GEMINI_TTS_MODEL
    if model_name not in GEMINI_TTS_MODEL_IDS:
        if requested_model is None:
            return GEMINI_TTS_MODELS[0]["id"]
        raise RuntimeError(f"Unsupported Gemini TTS model: {model_name}")
    return model_name


def resolve_qwen_tts_model(requested_model: str | None) -> str:
    model_name = requested_model or QWEN_TTS_MODEL
    if model_name not in QWEN_TTS_MODEL_IDS:
        if requested_model is None:
            return QWEN_TTS_MODELS[0]["id"]
        raise RuntimeError(f"Unsupported Qwen TTS model: {model_name}")
    return model_name


def qwen_voices_for_model(model_name: str | None) -> list[dict[str, Any]]:
    if not model_name:
        return QWEN_VOICES
    return [voice for voice in QWEN_VOICES if not voice.get("models") or model_name in voice["models"]]


def resolve_qwen_tts_voice(requested_voice: str | None, model_name: str | None) -> str:
    voices = qwen_voices_for_model(model_name)
    if requested_voice:
        if any(voice["id"] == requested_voice for voice in voices):
            return requested_voice
        supported = ", ".join(voice["id"] for voice in voices) or "no voices"
        raise RuntimeError(f"Voice '{requested_voice}' is not supported by {model_name or 'Qwen TTS'}. Try: {supported}.")

    default_voice = "Cherry"
    if any(voice["id"] == default_voice for voice in voices):
        return default_voice
    if voices:
        return voices[0]["id"]
    raise RuntimeError(f"No Qwen voices are available for {model_name or 'the selected model'}.")


def resolve_openai_tts_model(requested_model: str | None) -> str:
    return requested_model or OPENAI_TTS_MODEL


def qwen_language_type(text: str) -> str:
    return "Chinese" if re.search(r"[\u4e00-\u9fff]", text) else "English"


def qwen_input_units(text: str) -> int:
    total = 0
    for char in text:
        codepoint = ord(char)
        if (
            0x3400 <= codepoint <= 0x4DBF
            or 0x4E00 <= codepoint <= 0x9FFF
            or 0xF900 <= codepoint <= 0xFAFF
            or 0x20000 <= codepoint <= 0x2EBEF
        ):
            total += 2
        else:
            total += 1
    return total


def qwen_split_long_text(text: str, max_units: int) -> list[str]:
    stripped = text.strip()
    if not stripped:
        return []
    if qwen_input_units(stripped) <= max_units:
        return [stripped]

    pieces: list[str] = []
    start = 0
    while start < len(stripped):
        end = min(start + max_units, len(stripped))
        while end > start and qwen_input_units(stripped[start:end]) > max_units:
            end -= 1
        if end <= start:
            end = start + 1

        if end < len(stripped):
            split_at = max(
                stripped.rfind(". ", start, end),
                stripped.rfind("? ", start, end),
                stripped.rfind("! ", start, end),
                stripped.rfind("; ", start, end),
                stripped.rfind(", ", start, end),
                stripped.rfind(" ", start, end),
            )
            if split_at > start:
                candidate_end = split_at + 1
                if qwen_input_units(stripped[start:candidate_end]) <= max_units:
                    end = candidate_end

        chunk = stripped[start:end].strip()
        if chunk:
            pieces.append(chunk)
        start = end

    return pieces


def qwen_chunk_text(text: str, max_units: int) -> list[str]:
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", text) if part.strip()]
    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", paragraph) if s.strip()]
        if not sentences:
            sentences = [paragraph]

        for sentence in sentences:
            for candidate in qwen_split_long_text(sentence, max_units):
                if not current:
                    current = candidate
                    continue

                combined = f"{current} {candidate}"
                if qwen_input_units(combined) <= max_units:
                    current = combined
                else:
                    chunks.append(current)
                    current = candidate

        if current:
            chunks.append(current)
            current = ""

    if current:
        chunks.append(current)

    return chunks


def prepare_synthesis_chunks(text: str, provider: str, requested: int | None) -> list[str]:
    chunk_size = clamp_chunk_size(provider, requested)
    if provider == "qwen":
        return qwen_chunk_text(text, chunk_size)
    return pdf_to_audio.chunk_text(text, chunk_size)


def build_qwen_tts_instructions(narration_style: str, *, length_scale: float, sentence_silence: float) -> str:
    return (
        f"{narration_style.strip()}\n"
        f"Pacing: {describe_tts_pacing(length_scale)}\n"
        f"Pause guidance: {describe_tts_pauses(sentence_silence)}"
    ).strip()


def gemini_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except Exception:
        payload = None

    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"]

    return response.text.strip()


def gemini_retry_delay_seconds(response: httpx.Response) -> float | None:
    retry_after = response.headers.get("retry-after")
    if retry_after:
        try:
            return max(0.0, min(float(retry_after), GEMINI_MAX_RETRY_DELAY_SECONDS))
        except ValueError:
            pass

    detail = gemini_error_detail(response)
    match = re.search(r"retry in\s+([0-9]+(?:\.[0-9]+)?)s", detail, re.IGNORECASE)
    if not match:
        return None

    return max(0.0, min(float(match.group(1)), GEMINI_MAX_RETRY_DELAY_SECONDS))


def gemini_response_is_retryable(response: httpx.Response) -> bool:
    if response.status_code in {429, 500, 502, 503, 504}:
        return True

    detail = gemini_error_detail(response).lower()
    return (
        "quota" in detail
        or "rate limit" in detail
        or "rate-limit" in detail
        or "too many requests" in detail
        or "retry in" in detail
    )


def post_gemini_tts_with_retry(
    client: httpx.Client,
    *,
    model: str,
    api_key: str,
    narration_style: str,
    chunk: str,
    voice: str,
    length_scale: float,
    sentence_silence: float,
) -> httpx.Response:
    attempt = 0

    while True:
        response = client.post(
            gemini_tts_url(model),
            headers={
                "x-goog-api-key": api_key,
                "Content-Type": "application/json",
            },
            json={
                "contents": [
                    {
                        "parts": [
                            {
                                "text": build_directed_transcript(
                                    narration_style,
                                    chunk,
                                    length_scale=length_scale,
                                    sentence_silence=sentence_silence,
                                ),
                            }
                        ]
                    }
                ],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {
                            "prebuiltVoiceConfig": {
                                "voiceName": voice,
                            }
                        }
                    },
                },
                "model": model,
            },
        )

        if response.is_success:
            return response

        if attempt >= GEMINI_MAX_RETRY_ATTEMPTS or not gemini_response_is_retryable(response):
            response.raise_for_status()

        delay = gemini_retry_delay_seconds(response)
        if delay is None:
            delay = min(2 ** attempt, GEMINI_MAX_RETRY_DELAY_SECONDS)

        time.sleep(delay)
        attempt += 1


def normalize_tts_transcript(transcript: str) -> str:
    text = transcript.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_tts_paragraphs(transcript: str) -> list[str]:
    normalized = normalize_tts_transcript(transcript)
    return [part.strip() for part in re.split(r"\n{2,}", normalized) if part.strip()]


def split_tts_sentences(paragraph: str) -> list[str]:
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", paragraph) if part.strip()]
    return sentences or [paragraph.strip()]


def describe_tts_pacing(length_scale: float) -> str:
    if length_scale >= 1.3:
        return "Speak noticeably slower than normal conversation, with very deliberate phrasing."
    if length_scale >= 1.1:
        return "Speak slightly slower than normal conversation, with room at sentence endings."
    if length_scale <= 0.8:
        return "Speak a bit faster than normal conversation, but keep sentence endings clear."
    if length_scale <= 0.95:
        return "Speak slightly faster than normal conversation while keeping the phrasing controlled."
    return "Speak at a natural conversational pace."


def describe_tts_pauses(sentence_silence: float) -> str:
    sentence_pause_ms = max(0, int(round(sentence_silence * 1000)))
    paragraph_pause_ms = max(350, sentence_pause_ms * 2 or 350)
    if sentence_pause_ms <= 50:
        return (
            "Keep sentence-end pauses light, but still resolve each sentence before continuing. "
            f"Use a longer pause of about {paragraph_pause_ms} milliseconds between paragraphs."
        )
    return (
        f"Pause for about {sentence_pause_ms} milliseconds at sentence endings. "
        f"At paragraph breaks, pause a little longer, around {paragraph_pause_ms} milliseconds."
    )


def build_directed_transcript(narration_style: str, transcript: str, *, length_scale: float, sentence_silence: float) -> str:
    formatted_transcript = "\n\n".join(split_tts_paragraphs(transcript))
    return (
        "Read the transcript exactly as written.\n"
        "Do not add commentary, titles, or extra words.\n"
        "Let punctuation shape the delivery naturally. Do not run sentences together.\n"
        "Use lighter pauses for commas and stronger pauses at the end of full sentences.\n"
        f"Pacing: {describe_tts_pacing(length_scale)}\n"
        f"Pause guidance: {describe_tts_pauses(sentence_silence)}\n"
        f"Direction: {narration_style}\n\n"
        f"Transcript:\n{formatted_transcript}"
    )


def build_polly_ssml(transcript: str, *, length_scale: float, sentence_silence: float) -> str:
    paragraph_parts: list[str] = []
    sentence_pause_ms = max(0, int(round(sentence_silence * 1000)))
    paragraph_pause_ms = max(350, sentence_pause_ms * 2 or 350)

    for paragraph in split_tts_paragraphs(transcript):
        sentence_parts: list[str] = []
        for sentence in split_tts_sentences(paragraph):
            escaped_sentence = escape_html(sentence)
            escaped_sentence = re.sub(r"\s+", " ", escaped_sentence).strip()
            if not escaped_sentence:
                continue
            if sentence_parts:
                if sentence_pause_ms > 0:
                    sentence_parts.append(f"<break time='{sentence_pause_ms}ms'/>")
                else:
                    sentence_parts.append("<break strength='medium'/>")
            sentence_parts.append(escaped_sentence)

        if not sentence_parts:
            continue

        if paragraph_parts:
            paragraph_parts.append(f"<break time='{paragraph_pause_ms}ms'/>")
        paragraph_parts.append(f"<p>{''.join(sentence_parts)}</p>")

    # The existing length-scale slider is slower when the value goes up,
    # so Polly's speaking rate is inverted to match the rest of the app.
    rate_percent = max(20, min(200, int(round(100 / max(length_scale, 0.1)))))
    body = "".join(paragraph_parts) or escape_html(normalize_tts_transcript(transcript))
    return f'<speak><prosody rate="{rate_percent}%">{body}</prosody></speak>'


def trim_text_range(text: str, start: int, end: int) -> tuple[int, int]:
    next_start = start
    next_end = end

    while next_start < next_end and text[next_start].isspace():
        next_start += 1

    while next_end > next_start and text[next_end - 1].isspace():
        next_end -= 1

    return next_start, next_end


def build_text_sentence_spans(text: str) -> list[dict[str, Any]]:
    if not text.strip():
        return []

    boundary_pattern = re.compile(r'(?:[.!?]["\')\]]*(?=\s+|$))|\n{2,}')
    spans: list[dict[str, Any]] = []
    cursor = 0

    for match in boundary_pattern.finditer(text):
        start, end = trim_text_range(text, cursor, match.end())
        if end > start:
            spans.append({"start": start, "end": end, "text": text[start:end]})
        cursor = match.end()

    start, end = trim_text_range(text, cursor, len(text))
    if end > start:
        spans.append({"start": start, "end": end, "text": text[start:end]})

    return spans


def tokenize_non_whitespace(text: str) -> list[dict[str, Any]]:
    return [{"token": match.group(0), "start": match.start(), "end": match.end()} for match in re.finditer(r"\S+", text)]


def map_chunks_to_text_spans(text: str, chunks: list[str]) -> list[dict[str, Any]]:
    source_tokens = tokenize_non_whitespace(text)
    token_cursor = 0
    spans: list[dict[str, Any]] = []

    for chunk in chunks:
        chunk_tokens = re.findall(r"\S+", chunk)
        if not chunk_tokens:
            continue

        matched_index = -1
        if token_cursor + len(chunk_tokens) <= len(source_tokens):
            direct_window = source_tokens[token_cursor : token_cursor + len(chunk_tokens)]
            if [item["token"] for item in direct_window] == chunk_tokens:
                matched_index = token_cursor

        if matched_index < 0:
            for candidate in range(token_cursor, len(source_tokens) - len(chunk_tokens) + 1):
                window = source_tokens[candidate : candidate + len(chunk_tokens)]
                if [item["token"] for item in window] == chunk_tokens:
                    matched_index = candidate
                    break

        if matched_index < 0:
            fallback_start = spans[-1]["end"] if spans else 0
            fallback_end = min(len(text), max(fallback_start, fallback_start + len(chunk)))
            spans.append({"start": fallback_start, "end": fallback_end, "text": text[fallback_start:fallback_end]})
            continue

        start_token = source_tokens[matched_index]
        end_token = source_tokens[matched_index + len(chunk_tokens) - 1]
        spans.append(
            {
                "start": start_token["start"],
                "end": end_token["end"],
                "text": text[start_token["start"] : end_token["end"]],
            }
        )
        token_cursor = matched_index + len(chunk_tokens)

    return spans


def estimate_timing_weight(text: str) -> float:
    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return 1.0

    token_count = len(re.findall(r"\S+", normalized))
    comma_count = normalized.count(",")
    pause_mark_count = normalized.count(";") + normalized.count(":")
    return max(1.0, token_count + comma_count * 0.35 + pause_mark_count * 0.5 + 0.25)


def wav_duration_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as wav_file:
        frame_rate = wav_file.getframerate()
        if frame_rate <= 0:
            return 0.0
        return wav_file.getnframes() / frame_rate


def build_audio_timing_manifest(text: str, chunks: list[str], chunk_wavs: list[Path], *, audio_url: str) -> dict[str, Any]:
    sentence_spans = build_text_sentence_spans(text)
    chunk_spans = map_chunks_to_text_spans(text, chunks)
    cues: list[dict[str, Any]] = []
    time_cursor = 0.0
    total_duration = 0.0

    for chunk_span, chunk_wav in zip(chunk_spans, chunk_wavs):
        chunk_duration = max(0.0, wav_duration_seconds(chunk_wav))
        chunk_start = int(chunk_span["start"])
        chunk_end = int(chunk_span["end"])
        if chunk_end <= chunk_start:
            total_duration += chunk_duration
            time_cursor += chunk_duration
            continue

        chunk_segments = [
            {
                "start": max(int(sentence["start"]), chunk_start),
                "end": min(int(sentence["end"]), chunk_end),
                "text": text[max(int(sentence["start"]), chunk_start) : min(int(sentence["end"]), chunk_end)],
            }
            for sentence in sentence_spans
            if int(sentence["end"]) > chunk_start and int(sentence["start"]) < chunk_end
        ]
        chunk_segments = [segment for segment in chunk_segments if segment["end"] > segment["start"]]

        if not chunk_segments:
            chunk_segments = [{"start": chunk_start, "end": chunk_end, "text": text[chunk_start:chunk_end]}]

        weights = [estimate_timing_weight(segment["text"]) for segment in chunk_segments]
        total_weight = sum(weights) or float(len(chunk_segments))
        chunk_time_start = time_cursor

        for index, segment in enumerate(chunk_segments):
            if index == len(chunk_segments) - 1:
                next_time = chunk_time_start + chunk_duration
            else:
                next_time = time_cursor + (chunk_duration * (weights[index] / total_weight))

            cues.append(
                {
                    "start": int(segment["start"]),
                    "end": int(segment["end"]),
                    "timeStart": round(time_cursor, 4),
                    "timeEnd": round(max(time_cursor, next_time), 4),
                }
            )
            time_cursor = max(time_cursor, next_time)

        total_duration += chunk_duration
        time_cursor = chunk_time_start + chunk_duration

    return {
        "version": 1,
        "audioUrl": audio_url,
        "textLength": len(text),
        "duration": round(total_duration, 4),
        "cues": cues,
    }


def pcm_to_wav(pcm_bytes: bytes, wav_path: Path, *, channels: int = 1, rate: int = 24000, sample_width: int = 2) -> None:
    with wave.open(str(wav_path), "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(sample_width)
        wav_file.setframerate(rate)
        wav_file.writeframes(pcm_bytes)


def cleanup_preview_files(limit: int = 20) -> None:
    previews = sorted(PREVIEW_ROOT.glob("provider-test-*.wav"), key=lambda path: path.stat().st_mtime, reverse=True)
    for stale_file in previews[limit:]:
        stale_file.unlink(missing_ok=True)


def load_book_or_404(book_id: str) -> dict[str, Any]:
    path = book_meta_path(book_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Book not found.")
    return read_json(path)


def save_uploaded_book(upload: UploadFile) -> dict[str, Any]:
    if not upload.filename:
        raise HTTPException(status_code=400, detail="Missing filename.")

    suffix = Path(upload.filename).suffix.lower()
    if suffix != ".pdf":
        raise HTTPException(status_code=400, detail="Only PDF uploads are supported in the web app.")

    book_id = uuid.uuid4().hex[:12]
    target_dir = book_dir(book_id)
    source_path = target_dir / f"source{suffix}"
    target_dir.mkdir(parents=True, exist_ok=True)

    with source_path.open("wb") as handle:
        shutil.copyfileobj(upload.file, handle)

    try:
        raw_text = pdf_to_audio.extract_text(source_path)
        cleaned_text = pdf_to_audio.clean_text(raw_text)
        page_count = len(PdfReader(str(source_path)).pages)
    except Exception:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    finally:
        upload.file.close()

    if not cleaned_text:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(
            status_code=422,
            detail="No extractable text was found in this PDF. Scanned PDFs need OCR first.",
        )

    cleaned_path = book_text_path(book_id)
    cleaned_path.write_text(cleaned_text, encoding="utf-8")

    title = Path(upload.filename).stem
    meta = {
        "id": book_id,
        "title": title,
        "fileName": upload.filename,
        "uploadedAt": utc_now(),
        "pageCount": page_count,
        "textCharacters": len(cleaned_text),
        "excerpt": cleaned_text[:260],
        "sourcePath": str(source_path.resolve()),
        "latestAudio": None,
        "audioHistory": [],
    }
    write_json(book_meta_path(book_id), meta)
    return serialize_book(meta)


def append_audio_version(book_id: str, version: dict[str, Any]) -> dict[str, Any]:
    meta = load_book_or_404(book_id)
    meta["latestAudio"] = version
    meta["audioHistory"] = [version, *meta.get("audioHistory", [])][:8]
    write_json(book_meta_path(book_id), meta)
    return serialize_book(meta)


def reader_payload(book_id: str) -> dict[str, Any]:
    meta = load_book_or_404(book_id)
    text = book_text_path(book_id).read_text(encoding="utf-8")
    return {
        "book": serialize_book(meta),
        "text": text,
        "highlights": list_highlights(book_id),
    }


def create_highlight(book_id: str, request: HighlightCreateRequest) -> dict[str, Any]:
    load_book_or_404(book_id)
    text = book_text_path(book_id).read_text(encoding="utf-8")
    if request.end > len(text):
        raise HTTPException(status_code=400, detail="Highlight extends past the end of the book text.")
    if request.end <= request.start:
        raise HTTPException(status_code=400, detail="Highlight end must be after the start.")

    selected_text = normalize_highlight_text(text[request.start:request.end])
    submitted_text = normalize_highlight_text(request.text)
    if not selected_text:
        raise HTTPException(status_code=400, detail="Highlight selection cannot be empty.")
    if selected_text != submitted_text:
        raise HTTPException(status_code=400, detail="Highlight text does not match the selected range.")

    items = read_highlights(book_id)
    items = [
        item
        for item in items
        if not (request.start < item["end"] and request.end > item["start"])
    ]

    highlight = {
        "id": uuid.uuid4().hex[:12],
        "start": request.start,
        "end": request.end,
        "color": request.color,
        "text": selected_text,
        "note": normalize_highlight_text(request.note) if request.note else None,
        "createdAt": utc_now(),
    }
    items.append(highlight)
    write_highlights(book_id, items)
    return serialize_highlight(highlight)


def delete_highlight(book_id: str, highlight_id: str) -> None:
    load_book_or_404(book_id)
    items = read_highlights(book_id)
    remaining = [item for item in items if item["id"] != highlight_id]
    if len(remaining) == len(items):
        raise HTTPException(status_code=404, detail="Highlight not found.")
    write_highlights(book_id, remaining)


def delete_book_files(book_id: str) -> None:
    load_book_or_404(book_id)
    shutil.rmtree(book_dir(book_id), ignore_errors=True)
    delete_book_progress_records(book_id)

    with job_lock:
        stale_job_ids = [job_id for job_id, payload in job_state.items() if payload.get("bookId") == book_id]
        for job_id in stale_job_ids:
            job_state.pop(job_id, None)

    for path in JOBS_ROOT.glob("*.json"):
        try:
            payload = read_json(path)
        except Exception:
            continue
        if payload.get("bookId") == book_id:
            path.unlink(missing_ok=True)


def synthesize_piper(
    *,
    chunks: list[str],
    output_path: Path,
    chunk_dir: Path | None,
    voice: str | None,
    output_format: str,
    length_scale: float,
    sentence_silence: float,
    job_id: str | None,
) -> None:
    model_path = Path(voice or provider_catalog()[0]["defaultVoice"] or pdf_to_audio.DEFAULT_MODEL).expanduser().resolve()
    config_path = Path(f"{model_path}.json")
    if not model_path.exists():
        raise RuntimeError(f"Piper voice model not found: {model_path}")
    if not config_path.exists():
        raise RuntimeError(f"Piper voice config not found: {config_path}")

    piper_exe = pdf_to_audio.find_binary(None, "PIPER_EXE", pdf_to_audio.DEFAULT_PIPER_EXE)
    ffmpeg_exe = pdf_to_audio.find_binary(None, "FFMPEG_EXE", Path("ffmpeg.exe"), pdf_to_audio.DEFAULT_FFMPEG_GLOB)
    espeak_data = Path(env_value("PIPER_ESPEAK_DATA") or str(pdf_to_audio.DEFAULT_ESPEAK_DATA)).expanduser().resolve()

    with tempfile.TemporaryDirectory(prefix="storybook_piper_", dir=str(output_path.parent)) as temp_dir:
        wav_dir = chunk_dir or Path(temp_dir)
        wav_dir.mkdir(parents=True, exist_ok=True)
        wav_paths: list[Path] = []
        total = len(chunks)

        for index, chunk in enumerate(chunks, start=1):
            raise_if_job_cancelled(job_id)
            wav_path = wav_dir / f"chunk_{index:05d}.wav"
            command = [
                str(piper_exe),
                "-m",
                str(model_path),
                "-c",
                str(config_path),
                "-f",
                str(wav_path),
                "--espeak_data",
                str(espeak_data),
                "--speaker",
                "0",
                "--length_scale",
                str(length_scale),
                "--noise_scale",
                "0.667",
                "--noise_w",
                "0.8",
                "--sentence_silence",
                str(sentence_silence),
            ]
            pdf_to_audio.run_subprocess(command, input_text=chunk)
            wav_paths.append(wav_path)
            record_job_progress(
                job_id=job_id,
                index=index,
                total=total,
                message=f"Synthesizing audio chunk {index} of {total} with Piper.",
            )

        raise_if_job_cancelled(job_id)
        pdf_to_audio.concat_with_ffmpeg(wav_paths, ffmpeg_exe=ffmpeg_exe, output_path=output_path, codec=output_format)


def synthesize_openai(
    *,
    chunks: list[str],
    output_path: Path,
    chunk_dir: Path | None,
    model: str | None,
    voice: str | None,
    narration_style: str,
    output_format: str,
    job_id: str | None,
) -> None:
    api_key = env_value("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured.")

    ffmpeg_exe = pdf_to_audio.find_binary(None, "FFMPEG_EXE", Path("ffmpeg.exe"), pdf_to_audio.DEFAULT_FFMPEG_GLOB)
    chosen_model = resolve_openai_tts_model(model)
    chosen_voice = voice or "coral"

    with tempfile.TemporaryDirectory(prefix="storybook_openai_", dir=str(output_path.parent)) as temp_dir:
        wav_dir = chunk_dir or Path(temp_dir)
        wav_dir.mkdir(parents=True, exist_ok=True)
        wav_paths: list[Path] = []
        total = len(chunks)

        with httpx.Client(timeout=120.0) as client:
            for index, chunk in enumerate(chunks, start=1):
                raise_if_job_cancelled(job_id)
                response = client.post(
                    OPENAI_TTS_URL,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": chosen_model,
                        "voice": chosen_voice,
                        "input": chunk,
                        "instructions": narration_style,
                        "response_format": "wav",
                    },
                )
                response.raise_for_status()
                wav_path = wav_dir / f"chunk_{index:05d}.wav"
                wav_path.write_bytes(response.content)
                wav_paths.append(wav_path)
                record_job_progress(
                    job_id=job_id,
                    index=index,
                    total=total,
                    message=f"Synthesizing audio chunk {index} of {total} with OpenAI.",
                )

        raise_if_job_cancelled(job_id)
        pdf_to_audio.concat_with_ffmpeg(wav_paths, ffmpeg_exe=ffmpeg_exe, output_path=output_path, codec=output_format)


def synthesize_google(
    *,
    chunks: list[str],
    output_path: Path,
    chunk_dir: Path | None,
    model: str | None,
    voice: str | None,
    narration_style: str,
    output_format: str,
    length_scale: float,
    sentence_silence: float,
    job_id: str | None,
) -> None:
    api_key = env_value("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not configured.")

    ffmpeg_exe = pdf_to_audio.find_binary(None, "FFMPEG_EXE", Path("ffmpeg.exe"), pdf_to_audio.DEFAULT_FFMPEG_GLOB)
    chosen_model = resolve_google_tts_model(model)
    chosen_voice = voice or "Kore"

    with tempfile.TemporaryDirectory(prefix="storybook_google_", dir=str(output_path.parent)) as temp_dir:
        wav_dir = chunk_dir or Path(temp_dir)
        wav_dir.mkdir(parents=True, exist_ok=True)
        wav_paths: list[Path] = []
        total = len(chunks)

        with httpx.Client(timeout=180.0) as client:
            for index, chunk in enumerate(chunks, start=1):
                raise_if_job_cancelled(job_id)
                response = post_gemini_tts_with_retry(
                    client,
                    model=chosen_model,
                    api_key=api_key,
                    narration_style=narration_style,
                    chunk=chunk,
                    voice=chosen_voice,
                    length_scale=length_scale,
                    sentence_silence=sentence_silence,
                )
                payload = response.json()
                encoded_audio = payload["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
                wav_path = wav_dir / f"chunk_{index:05d}.wav"
                pcm_to_wav(b64decode(encoded_audio), wav_path)
                wav_paths.append(wav_path)
                record_job_progress(
                    job_id=job_id,
                    index=index,
                    total=total,
                    message=f"Synthesizing audio chunk {index} of {total} with Google Gemini.",
                )

        raise_if_job_cancelled(job_id)
        pdf_to_audio.concat_with_ffmpeg(wav_paths, ffmpeg_exe=ffmpeg_exe, output_path=output_path, codec=output_format)


def synthesize_qwen(
    *,
    chunks: list[str],
    output_path: Path,
    chunk_dir: Path | None,
    model: str | None,
    voice: str | None,
    narration_style: str,
    output_format: str,
    length_scale: float,
    sentence_silence: float,
    job_id: str | None,
) -> None:
    api_key = env_value("DASHSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured.")

    dashscope = load_dashscope()
    ffmpeg_exe = pdf_to_audio.find_binary(None, "FFMPEG_EXE", Path("ffmpeg.exe"), pdf_to_audio.DEFAULT_FFMPEG_GLOB)
    chosen_model = resolve_qwen_tts_model(model)
    chosen_voice = resolve_qwen_tts_voice(voice, chosen_model)
    use_instructions = "instruct" in chosen_model

    with tempfile.TemporaryDirectory(prefix="storybook_qwen_", dir=str(output_path.parent)) as temp_dir:
        wav_dir = chunk_dir or Path(temp_dir)
        wav_dir.mkdir(parents=True, exist_ok=True)
        wav_paths: list[Path] = []
        total = len(chunks)

        with httpx.Client(timeout=180.0, follow_redirects=True) as client:
            for index, chunk in enumerate(chunks, start=1):
                raise_if_job_cancelled(job_id)
                request_kwargs: dict[str, Any] = {
                    "model": chosen_model,
                    "api_key": api_key,
                    "text": chunk,
                    "voice": chosen_voice,
                    "language_type": qwen_language_type(chunk),
                    "stream": False,
                }
                if use_instructions:
                    request_kwargs["instructions"] = build_qwen_tts_instructions(
                        narration_style,
                        length_scale=length_scale,
                        sentence_silence=sentence_silence,
                    )
                    request_kwargs["optimize_instructions"] = True

                response = dashscope.MultiModalConversation.call(**request_kwargs)
                if int(getattr(response, "status_code", HTTPStatus.INTERNAL_SERVER_ERROR)) != int(HTTPStatus.OK):
                    code = getattr(response, "code", None)
                    message = getattr(response, "message", None)
                    raise RuntimeError(message or code or "Qwen TTS request failed.")

                audio = getattr(getattr(response, "output", None), "audio", None)
                wav_path = wav_dir / f"chunk_{index:05d}.wav"
                if audio is None:
                    raise RuntimeError("Qwen TTS returned no audio output.")
                if getattr(audio, "data", None):
                    wav_path.write_bytes(b64decode(audio.data))
                elif getattr(audio, "url", None):
                    download = client.get(audio.url)
                    download.raise_for_status()
                    wav_path.write_bytes(download.content)
                else:
                    raise RuntimeError("Qwen TTS returned no downloadable audio payload.")

                wav_paths.append(wav_path)
                record_job_progress(
                    job_id=job_id,
                    index=index,
                    total=total,
                    message=f"Synthesizing audio chunk {index} of {total} with Qwen TTS.",
                )

        raise_if_job_cancelled(job_id)
        pdf_to_audio.concat_with_ffmpeg(wav_paths, ffmpeg_exe=ffmpeg_exe, output_path=output_path, codec=output_format)


def synthesize_polly(
    *,
    chunks: list[str],
    output_path: Path,
    chunk_dir: Path | None,
    voice: str | None,
    output_format: str,
    length_scale: float,
    sentence_silence: float,
    job_id: str | None,
) -> None:
    client = create_polly_client()
    ffmpeg_exe = pdf_to_audio.find_binary(None, "FFMPEG_EXE", Path("ffmpeg.exe"), pdf_to_audio.DEFAULT_FFMPEG_GLOB)
    chosen_voice = voice or POLLY_VOICE_ID

    with tempfile.TemporaryDirectory(prefix="storybook_polly_", dir=str(output_path.parent)) as temp_dir:
        wav_dir = chunk_dir or Path(temp_dir)
        wav_dir.mkdir(parents=True, exist_ok=True)
        wav_paths: list[Path] = []
        total = len(chunks)

        for index, chunk in enumerate(chunks, start=1):
            raise_if_job_cancelled(job_id)
            response = client.synthesize_speech(
                Text=build_polly_ssml(chunk, length_scale=length_scale, sentence_silence=sentence_silence),
                TextType="ssml",
                Engine=POLLY_ENGINE,
                VoiceId=chosen_voice,
                OutputFormat="pcm",
                SampleRate=POLLY_PCM_SAMPLE_RATE,
                LanguageCode=POLLY_LANGUAGE_CODE,
            )
            audio_stream = response.get("AudioStream")
            if audio_stream is None:
                raise RuntimeError("Amazon Polly returned no audio stream.")

            try:
                pcm_bytes = audio_stream.read()
            finally:
                audio_stream.close()

            wav_path = wav_dir / f"chunk_{index:05d}.wav"
            pcm_to_wav(pcm_bytes, wav_path, rate=int(POLLY_PCM_SAMPLE_RATE))
            wav_paths.append(wav_path)
            record_job_progress(
                job_id=job_id,
                index=index,
                total=total,
                message=f"Synthesizing audio chunk {index} of {total} with Amazon Polly.",
            )

        raise_if_job_cancelled(job_id)
        pdf_to_audio.concat_with_ffmpeg(wav_paths, ffmpeg_exe=ffmpeg_exe, output_path=output_path, codec=output_format)


def synthesize_provider_audio(
    *,
    provider_id: Literal["piper", "google", "openai", "polly", "qwen"],
    chunks: list[str],
    output_path: Path,
    chunk_dir: Path | None,
    voice: str | None,
    model: str | None,
    narration_style: str,
    output_format: str,
    length_scale: float,
    sentence_silence: float,
    job_id: str | None,
) -> str:
    chosen_model = ""

    if provider_id == "piper":
        synthesize_piper(
            chunks=chunks,
            output_path=output_path,
            chunk_dir=chunk_dir,
            voice=voice,
            output_format=output_format,
            length_scale=length_scale,
            sentence_silence=sentence_silence,
            job_id=job_id,
        )
    elif provider_id == "google":
        chosen_model = resolve_google_tts_model(model)
        synthesize_google(
            chunks=chunks,
            output_path=output_path,
            chunk_dir=chunk_dir,
            model=chosen_model,
            voice=voice,
            narration_style=narration_style,
            output_format=output_format,
            length_scale=length_scale,
            sentence_silence=sentence_silence,
            job_id=job_id,
        )
    elif provider_id == "openai":
        chosen_model = resolve_openai_tts_model(model)
        synthesize_openai(
            chunks=chunks,
            output_path=output_path,
            chunk_dir=chunk_dir,
            model=chosen_model,
            voice=voice,
            narration_style=narration_style,
            output_format=output_format,
            job_id=job_id,
        )
    elif provider_id == "polly":
        synthesize_polly(
            chunks=chunks,
            output_path=output_path,
            chunk_dir=chunk_dir,
            voice=voice,
            output_format=output_format,
            length_scale=length_scale,
            sentence_silence=sentence_silence,
            job_id=job_id,
        )
    elif provider_id == "qwen":
        chosen_model = resolve_qwen_tts_model(model)
        synthesize_qwen(
            chunks=chunks,
            output_path=output_path,
            chunk_dir=chunk_dir,
            model=chosen_model,
            voice=voice,
            narration_style=narration_style,
            output_format=output_format,
            length_scale=length_scale,
            sentence_silence=sentence_silence,
            job_id=job_id,
        )
    else:
        raise RuntimeError(f"Unsupported provider: {provider_id}")

    return chosen_model


def build_live_audio_payload(book_id: str, request: LiveAudioRequest) -> dict[str, Any]:
    load_book_or_404(book_id)
    provider = provider_details(request.provider)
    if not provider["available"]:
        raise HTTPException(
            status_code=400,
            detail=f"{provider['name']} is not configured yet.",
        )

    text = book_text_path(book_id).read_text(encoding="utf-8")
    if request.end > len(text):
        raise HTTPException(status_code=400, detail="Live audio range extends past the end of the book text.")
    if request.end <= request.start:
        raise HTTPException(status_code=400, detail="Live audio end must be after the start.")

    selected_text = text[request.start:request.end]
    submitted_text = normalize_highlight_text(request.text)
    canonical_text = normalize_highlight_text(selected_text)
    if not canonical_text:
        raise HTTPException(status_code=400, detail="Live audio selection cannot be empty.")
    if canonical_text != submitted_text:
        raise HTTPException(status_code=400, detail="Live audio text does not match the selected range.")

    synthesis_text = selected_text.strip()
    if not synthesis_text:
        raise HTTPException(status_code=400, detail="Live audio selection cannot be only whitespace.")

    chosen_model: str | None = None
    chosen_voice = request.voice or provider.get("defaultVoice")
    if request.provider == "google":
        chosen_model = resolve_google_tts_model(request.model)
    elif request.provider == "qwen":
        chosen_model = resolve_qwen_tts_model(request.model)
        chosen_voice = resolve_qwen_tts_voice(chosen_voice, chosen_model)
    elif request.provider == "openai":
        chosen_model = resolve_openai_tts_model(request.model)

    cache_key = {
        "bookId": book_id,
        "provider": request.provider,
        "voice": chosen_voice,
        "model": chosen_model or request.model,
        "outputFormat": request.output_format,
        "narrationStyle": request.narration_style,
        "lengthScale": request.length_scale,
        "sentenceSilence": request.sentence_silence,
        "start": request.start,
        "end": request.end,
    }
    digest = hashlib.sha1(json.dumps(cache_key, sort_keys=True).encode("utf-8")).hexdigest()[:20]
    output_dir = book_live_audio_dir(book_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{request.provider}-{digest}.{request.output_format}"
    cached = output_path.exists() and output_path.stat().st_size > 0

    resolved_model = chosen_model or ""
    if not cached:
        chunks = prepare_synthesis_chunks(synthesis_text, request.provider, None)
        resolved_model = synthesize_provider_audio(
            provider_id=request.provider,
            chunks=chunks,
            output_path=output_path,
            chunk_dir=None,
            voice=chosen_voice,
            model=request.model,
            narration_style=request.narration_style,
            output_format=request.output_format,
            length_scale=request.length_scale,
            sentence_silence=request.sentence_silence,
            job_id=None,
        )

    return {
        "provider": request.provider,
        "voice": chosen_voice,
        "model": resolved_model or None,
        "format": request.output_format,
        "url": relative_url(output_path),
        "start": request.start,
        "end": request.end,
        "pageNumber": request.pageNumber,
        "cached": cached,
    }


def run_generation_job(job_id: str, book_id: str, request: GenerateAudioRequest) -> None:
    raise_if_job_cancelled(job_id)
    meta = load_book_or_404(book_id)
    cleaned_text = book_text_path(book_id).read_text(encoding="utf-8")
    chunks = prepare_synthesis_chunks(cleaned_text, request.provider, request.chunk_size)
    chosen_model = ""

    audio_dir = book_dir(book_id) / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    output_path = audio_dir / f"{request.provider}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.{request.output_format}"
    timing_path = output_path.parent / f"{output_path.name}.timing.json"
    chunk_dir = audio_dir / f".{output_path.stem}-chunks"
    shutil.rmtree(chunk_dir, ignore_errors=True)
    chunk_dir.mkdir(parents=True, exist_ok=True)

    raise_if_job_cancelled(job_id)
    update_job(
        job_id,
        status="running",
        progress=0.0,
        message=f"Prepared {len(chunks)} chunks for synthesis.",
        startedAt=utc_now(),
        totalChunks=len(chunks),
        completedChunks=0,
    )

    timing_path_value: str | None = None
    try:
        chosen_model = synthesize_provider_audio(
            provider_id=request.provider,
            chunks=chunks,
            output_path=output_path,
            chunk_dir=chunk_dir,
            voice=request.voice,
            model=request.model,
            narration_style=request.narration_style,
            output_format=request.output_format,
            length_scale=request.length_scale,
            sentence_silence=request.sentence_silence,
            job_id=job_id,
        )

        raise_if_job_cancelled(job_id)
        try:
            chunk_wavs = sorted(chunk_dir.glob("chunk_*.wav"))
            if chunk_wavs:
                write_json(
                    timing_path,
                    build_audio_timing_manifest(
                        cleaned_text,
                        chunks,
                        chunk_wavs,
                        audio_url=relative_url(output_path),
                    ),
                )
                timing_path_value = str(timing_path.resolve())
        except Exception as exc:
            print(f"Failed to build timing manifest for {output_path.name}: {exc}")
    finally:
        shutil.rmtree(chunk_dir, ignore_errors=True)

    version = {
        "provider": request.provider,
        "voice": request.voice or "",
        "model": chosen_model,
        "format": request.output_format,
        "createdAt": utc_now(),
        "path": str(output_path.resolve()),
        "timingPath": timing_path_value,
    }
    book = append_audio_version(book_id, version)
    update_job(
        job_id,
        status="completed",
        progress=100.0,
        message=f"Finished {meta['title']}.",
        finishedAt=utc_now(),
        result={
            "audioUrl": relative_url(output_path),
            "book": book,
        },
    )


def dispatch_generation_job(book_id: str, request: GenerateAudioRequest) -> dict[str, Any]:
    job_id = uuid.uuid4().hex
    payload = {
        "id": job_id,
        "bookId": book_id,
        "provider": request.provider,
        "status": "queued",
        "progress": 0.0,
        "message": "Queued for processing.",
        "createdAt": utc_now(),
        "finishedAt": None,
        "error": None,
        "result": None,
        "totalChunks": 0,
        "completedChunks": 0,
        "cancelRequested": False,
    }
    persist_job(payload)

    def runner() -> None:
        try:
            run_generation_job(job_id, book_id, request)
        except JobCancelledError:
            update_job(
                job_id,
                status="cancelled",
                error=None,
                message="Generation cancelled before the audiobook was finalized.",
                finishedAt=utc_now(),
                result=None,
            )
        except Exception as exc:
            update_job(
                job_id,
                status="failed",
                error=str(exc),
                message="Audio generation failed.",
                finishedAt=utc_now(),
            )

    threading.Thread(
        target=runner,
        name=f"storybook-job-{job_id[:8]}",
        daemon=True,
    ).start()
    return payload


def cancel_generation_job(job_id: str) -> dict[str, Any]:
    payload = read_job_payload(job_id)
    status = payload.get("status")
    if status in {"completed", "failed", "cancelled"}:
        return payload

    if payload.get("cancelRequested"):
        return payload

    notice = (
        "Cancellation requested. The current chunk will stop after finishing."
        if status in {"running", "cancelling"}
        else "Cancellation requested. The job will stop before synthesis starts."
    )
    return update_job(
        job_id,
        status="cancelling",
        cancelRequested=True,
        message=notice,
        error=None,
    )


def run_provider_test(request: ProviderTestRequest) -> dict[str, Any]:
    provider = provider_details(request.provider)
    if not provider["available"]:
        raise HTTPException(
            status_code=400,
            detail=f"{provider['name']} is not configured yet.",
        )

    preview_path = PREVIEW_ROOT / f"provider-test-{request.provider}-{uuid.uuid4().hex[:10]}.mp3"
    chosen_model: str | None = None
    chosen_voice = request.voice or provider.get("defaultVoice")
    if request.provider == "google":
        chosen_model = resolve_google_tts_model(request.model)
    elif request.provider == "qwen":
        chosen_model = resolve_qwen_tts_model(request.model)
        chosen_voice = resolve_qwen_tts_voice(chosen_voice, chosen_model)
    elif request.provider == "openai":
        chosen_model = resolve_openai_tts_model(request.model)

    resolved_model = chosen_model or ""
    chunks = [PROVIDER_TEST_SNIPPET]

    try:
        resolved_model = synthesize_provider_audio(
            provider_id=request.provider,
            chunks=chunks,
            output_path=preview_path,
            chunk_dir=None,
            voice=chosen_voice,
            model=request.model,
            narration_style=request.narration_style,
            output_format="mp3",
            length_scale=request.length_scale,
            sentence_silence=request.sentence_silence,
            job_id=None,
        )
    except HTTPException:
        preview_path.unlink(missing_ok=True)
        raise
    except httpx.HTTPStatusError as exc:
        preview_path.unlink(missing_ok=True)
        try:
            detail = exc.response.json().get("error", {}).get("message")
        except Exception:
            detail = None
        raise HTTPException(status_code=400, detail=detail or str(exc)) from exc
    except Exception as exc:
        preview_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    cleanup_preview_files()
    return {
        "provider": request.provider,
        "voice": chosen_voice,
        "model": resolved_model,
        "sampleText": PROVIDER_TEST_SNIPPET,
        "audioUrl": relative_url(preview_path),
        "message": f"{provider['name']} generated a short sample successfully.",
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/providers")
def providers() -> dict[str, Any]:
    return {
        "defaultNarrationStyle": DEFAULT_NARRATION_STYLE,
        "providers": provider_catalog(),
    }


@app.get("/api/providers/polly/health")
def polly_health() -> dict[str, Any]:
    return get_polly_health(force_refresh=True)


@app.post("/api/providers/test")
def provider_test(request: ProviderTestRequest) -> dict[str, Any]:
    return run_provider_test(request)


@app.get("/api/books")
def books() -> dict[str, Any]:
    return {"items": list_books()}


@app.get("/api/books/{book_id}")
def book(book_id: str) -> dict[str, Any]:
    return serialize_book(load_book_or_404(book_id))


@app.get("/api/books/{book_id}/reader")
def book_reader(book_id: str) -> dict[str, Any]:
    return reader_payload(book_id)


@app.post("/api/books/{book_id}/live-audio")
def create_live_audio(book_id: str, request: LiveAudioRequest) -> dict[str, Any]:
    try:
        return build_live_audio_payload(book_id, request)
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        try:
            detail = exc.response.json().get("error", {}).get("message")
        except Exception:
            detail = None
        raise HTTPException(status_code=400, detail=detail or str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/books/{book_id}/progress")
def book_progress(book_id: str) -> dict[str, Any]:
    return book_progress_payload(book_id)


@app.put("/api/books/{book_id}/progress/reading")
def update_book_progress(book_id: str, request: ReadingProgressRequest) -> dict[str, Any]:
    return write_book_reading_progress(book_id, request)


@app.put("/api/books/{book_id}/progress/audio")
def update_book_audio(book_id: str, request: AudioProgressRequest) -> dict[str, Any]:
    return write_book_audio_progress(book_id, request)


@app.delete("/api/books/{book_id}/progress/audio")
def clear_book_audio(book_id: str) -> dict[str, bool]:
    return delete_book_audio_progress(book_id)


@app.get("/api/books/{book_id}/highlights")
def book_highlights(book_id: str) -> dict[str, Any]:
    load_book_or_404(book_id)
    return {"items": list_highlights(book_id)}


@app.post("/api/books/{book_id}/highlights")
def create_book_highlight(book_id: str, request: HighlightCreateRequest) -> dict[str, Any]:
    return create_highlight(book_id, request)


@app.delete("/api/books/{book_id}/highlights/{highlight_id}")
def remove_book_highlight(book_id: str, highlight_id: str) -> dict[str, bool]:
    delete_highlight(book_id, highlight_id)
    return {"ok": True}


@app.post("/api/books")
def upload_book(file: UploadFile = File(...)) -> dict[str, Any]:
    return save_uploaded_book(file)


@app.delete("/api/books/{book_id}")
def delete_book(book_id: str) -> dict[str, bool]:
    delete_book_files(book_id)
    return {"ok": True}


@app.post("/api/books/{book_id}/jobs")
def create_job(book_id: str, request: GenerateAudioRequest) -> dict[str, Any]:
    load_book_or_404(book_id)
    return dispatch_generation_job(book_id, request)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    path = job_path(job_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Job not found.")
    return read_json(path)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, Any]:
    try:
        return cancel_generation_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Job not found.") from exc


@app.get("/{full_path:path}", include_in_schema=False)
def spa_fallback(full_path: str) -> FileResponse:
    if not WEB_DIST.exists():
        raise HTTPException(status_code=404, detail="Frontend build not found.")

    requested = (WEB_DIST / full_path).resolve()
    if full_path and requested.exists() and requested.is_file() and WEB_DIST in requested.parents:
        return FileResponse(requested)
    return FileResponse(WEB_DIST / "index.html")
