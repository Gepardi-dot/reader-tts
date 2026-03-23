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
POLLY_REGION = env_value("POLLY_REGION") or env_value("AWS_REGION") or env_value("AWS_DEFAULT_REGION")
POLLY_VOICE_ID = env_value("AWS_POLLY_VOICE_ID") or env_value("POLLY_VOICE_ID") or "Matthew"
POLLY_ENGINE = (env_value("AWS_POLLY_ENGINE") or env_value("POLLY_ENGINE") or "standard").lower()
POLLY_LANGUAGE_CODE = env_value("AWS_POLLY_LANGUAGE_CODE") or env_value("POLLY_LANGUAGE_CODE") or "en-US"
POLLY_PCM_SAMPLE_RATE = "16000"
POLLY_CACHE_TTL_SECONDS = 300


def voice_option(
    voice_id: str,
    label: str,
    *,
    gender: Literal["male", "female", "neutral"] | None = None,
    gender_source: Literal["provider", "estimated"] | None = None,
    style: str | None = None,
    tags: list[str] | None = None,
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
    provider: Literal["piper", "google", "openai", "polly"] = "piper"
    voice: str | None = None
    model: str | None = None
    output_format: Literal["mp3", "m4b", "wav"] = "mp3"
    narration_style: str = Field(default=DEFAULT_NARRATION_STYLE, max_length=1500)
    chunk_size: int | None = Field(default=None, ge=300, le=4000)
    length_scale: float = Field(default=1.0, ge=0.6, le=1.5)
    sentence_silence: float = Field(default=0.2, ge=0.0, le=1.0)


class ProviderTestRequest(BaseModel):
    provider: Literal["piper", "google", "openai", "polly"] = "piper"
    voice: str | None = None
    model: str | None = None
    narration_style: str = Field(default=DEFAULT_NARRATION_STYLE, max_length=1500)
    length_scale: float = Field(default=1.0, ge=0.6, le=1.5)
    sentence_silence: float = Field(default=0.2, ge=0.0, le=1.0)


class LiveAudioRequest(BaseModel):
    provider: Literal["piper", "google", "openai", "polly"] = "openai"
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
    piper_voices = get_voice_models()
    piper_available = bool(piper_voices)
    polly_catalog = get_polly_catalog()

    return [
        {
            "id": "piper",
            "name": "Piper Local",
            "available": piper_available,
            "recommended": True,
            "description": "Runs fully on your PC for free. Best value for personal use.",
            "voices": piper_voices,
            "defaultVoice": piper_voices[0]["id"] if piper_voices else None,
            "models": [],
            "defaultModel": None,
            "voiceMetaNote": None,
        },
        {
            "id": "google",
            "name": "Google Gemini TTS",
            "available": bool(env_value("GEMINI_API_KEY")),
            "recommended": False,
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
        {
            "id": "openai",
            "name": "OpenAI GPT-4o mini TTS",
            "available": bool(env_value("OPENAI_API_KEY")),
            "recommended": False,
            "description": "Cheap cloud narration with promptable delivery and more expressive pacing.",
            "voices": OPENAI_VOICES,
            "defaultVoice": "coral",
            "models": OPENAI_TTS_MODELS,
            "defaultModel": resolve_openai_tts_model(None),
            "voiceMetaNote": "Gender tags for OpenAI voices are estimated from the voice character, not provider metadata.",
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


def resolve_openai_tts_model(requested_model: str | None) -> str:
    return requested_model or OPENAI_TTS_MODEL


def build_directed_transcript(narration_style: str, transcript: str) -> str:
    return (
        "Read the transcript exactly as written.\n"
        "Do not add commentary, titles, or extra words.\n"
        f"Direction: {narration_style}\n\n"
        f"Transcript:\n{transcript}"
    )


def build_polly_ssml(transcript: str, *, length_scale: float, sentence_silence: float) -> str:
    escaped = escape_html(transcript).replace("\n", " ")
    escaped = re.sub(r"\s+", " ", escaped).strip()

    if sentence_silence > 0:
        pause_ms = max(0, int(round(sentence_silence * 1000)))
        escaped = re.sub(r"([.!?])\s+", rf"\1<break time='{pause_ms}ms'/>", escaped)

    # The existing length-scale slider is slower when the value goes up,
    # so Polly's speaking rate is inverted to match the rest of the app.
    rate_percent = max(20, min(200, int(round(100 / max(length_scale, 0.1)))))
    return f'<speak><prosody rate="{rate_percent}%">{escaped}</prosody></speak>'


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
                response = client.post(
                    gemini_tts_url(chosen_model),
                    headers={
                        "x-goog-api-key": api_key,
                        "Content-Type": "application/json",
                    },
                    json={
                        "contents": [
                            {
                                "parts": [
                                    {
                                        "text": build_directed_transcript(narration_style, chunk),
                                    }
                                ]
                            }
                        ],
                        "generationConfig": {
                            "responseModalities": ["AUDIO"],
                            "speechConfig": {
                                "voiceConfig": {
                                    "prebuiltVoiceConfig": {
                                        "voiceName": chosen_voice,
                                    }
                                }
                            },
                        },
                        "model": chosen_model,
                    },
                )
                response.raise_for_status()
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
    provider_id: Literal["piper", "google", "openai", "polly"],
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

    chosen_voice = request.voice or provider.get("defaultVoice")
    cache_key = {
        "bookId": book_id,
        "provider": request.provider,
        "voice": chosen_voice,
        "model": request.model,
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

    chosen_model = ""
    if not cached:
        chunks = pdf_to_audio.chunk_text(synthesis_text, clamp_chunk_size(request.provider, None))
        chosen_model = synthesize_provider_audio(
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
    elif request.provider == "google":
        chosen_model = resolve_google_tts_model(request.model)
    elif request.provider == "openai":
        chosen_model = resolve_openai_tts_model(request.model)

    return {
        "provider": request.provider,
        "voice": chosen_voice,
        "model": chosen_model or None,
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
    chunk_size = clamp_chunk_size(request.provider, request.chunk_size)
    chunks = pdf_to_audio.chunk_text(cleaned_text, chunk_size)
    chosen_model = ""

    audio_dir = book_dir(book_id) / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    output_path = audio_dir / f"{request.provider}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.{request.output_format}"

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

    chosen_model = synthesize_provider_audio(
        provider_id=request.provider,
        chunks=chunks,
        output_path=output_path,
        chunk_dir=None,
        voice=request.voice,
        model=request.model,
        narration_style=request.narration_style,
        output_format=request.output_format,
        length_scale=request.length_scale,
        sentence_silence=request.sentence_silence,
        job_id=job_id,
    )

    raise_if_job_cancelled(job_id)
    version = {
        "provider": request.provider,
        "voice": request.voice or "",
        "model": chosen_model,
        "format": request.output_format,
        "createdAt": utc_now(),
        "path": str(output_path.resolve()),
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
    chosen_voice = request.voice or provider.get("defaultVoice")
    chosen_model = ""
    chunks = [PROVIDER_TEST_SNIPPET]

    try:
        chosen_model = synthesize_provider_audio(
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
        "model": chosen_model,
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
