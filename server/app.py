from __future__ import annotations

import importlib.util
import concurrent.futures
import hashlib
import json
import logging
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import unicodedata
import urllib.parse
import uuid
import wave
import xml.etree.ElementTree as ET
from base64 import b64decode
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from html import escape as escape_html
from http import HTTPStatus
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
_RUNTIME_ENV_LOCK = threading.Lock()
_RUNTIME_ENV_MTIME_NS: int | None = None

RUNTIME_ENV_NAMES = (
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "OPENAI_API_KEY",
    "OPENAI_CONTEXT_MODEL",
    "GEMINI_API_KEY",
    "GEMINI_TTS_MODEL",
    "GEMMA_PROVIDER",
    "GEMMA_BASE_URL",
    "GEMMA_MODEL",
    "GEMMA_TIMEOUT_SECONDS",
    "VOCAB_CONTEXT_PROVIDER",
    "NVIDIA_API_KEY",
    "KOKORO_REMOTE_URL",
    "KOKORO_REMOTE_API_KEY",
    "KOKORO_REMOTE_TIMEOUT_SECONDS",
    "SUPABASE_DB_URL",
    "SUPABASE_POOLER_URL",
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "BOOK_STORAGE_BUCKET",
    "BOOK_STORAGE_PREFIX",
    "BOOK_STORAGE_REGION",
    "BOOK_STORAGE_ENDPOINT",
    "BOOK_STORAGE_ADDRESSING_STYLE",
    "SUPABASE_JWT_SECRET",
    "ADB_EXE",
    "SAMSUNG_DICTIONARY_DEVICE_ID",
)


def prune_blank_runtime_env() -> None:
    for env_name in RUNTIME_ENV_NAMES:
        value = os.environ.get(env_name)
        if value is not None and not value.strip():
            os.environ.pop(env_name, None)


def load_runtime_env(*, force: bool = False) -> None:
    global _RUNTIME_ENV_MTIME_NS

    try:
        env_mtime_ns = ENV_FILE.stat().st_mtime_ns
    except FileNotFoundError:
        env_mtime_ns = None

    if not force and env_mtime_ns == _RUNTIME_ENV_MTIME_NS:
        return

    with _RUNTIME_ENV_LOCK:
        try:
            current_mtime_ns = ENV_FILE.stat().st_mtime_ns
        except FileNotFoundError:
            current_mtime_ns = None

        if not force and current_mtime_ns == _RUNTIME_ENV_MTIME_NS:
            return

        prune_blank_runtime_env()
        if ENV_FILE.exists():
            load_dotenv(ENV_FILE, override=True)
        prune_blank_runtime_env()
        _RUNTIME_ENV_MTIME_NS = current_mtime_ns


load_runtime_env(force=True)

logger = logging.getLogger(__name__)


def env_value(name: str) -> str | None:
    load_runtime_env()
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def env_int_value(name: str, default: int) -> int:
    value = env_value(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def env_float_value(name: str, default: float) -> float:
    value = env_value(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default

import pdf_to_audio
from server.gemma_provider import (
    build_gemma_answer_coach,
    build_gemma_context_generator,
    build_gemma_lesson_generator,
    build_gemma_sentence_coach,
    gemma_runtime_configured,
)
from server.vocabulary_studio import VocabularyStudioService, create_vocabulary_router


def runtime_root() -> Path:
    if os.environ.get("VERCEL"):
        return Path(tempfile.gettempdir()) / "storybook-reader"
    return ROOT


def frontend_root() -> Path:
    candidates = [ROOT / "web-next" / "dist", ROOT / "web-rewrite" / "dist", ROOT / "web" / "dist", ROOT / "public"]
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
DICTIONARY_BUNDLE_ROOT = ROOT / "dictionary"
RUNTIME_DICTIONARY_ROOT = RUNTIME_ROOT / "dictionary"
OFFLINE_DICTIONARY_BUNDLE_DB = DICTIONARY_BUNDLE_ROOT / "offline" / "dictionary.sqlite3"
OPEN_WORDNET_BUNDLE_DIR = DICTIONARY_BUNDLE_ROOT / "open-wordnet"
GEMINI_TTS_MODEL = env_value("GEMINI_TTS_MODEL") or "gemini-2.5-flash-preview-tts"
KOKORO_REMOTE_URL = (env_value("KOKORO_REMOTE_URL") or "").rstrip("/")
KOKORO_REMOTE_API_KEY = env_value("KOKORO_REMOTE_API_KEY") or ""
KOKORO_REMOTE_TIMEOUT_SECONDS = max(10.0, env_float_value("KOKORO_REMOTE_TIMEOUT_SECONDS", 60.0))
CANONICAL_WAV_SAMPLE_RATE = 24000
APP_SECRET_KEY = env_value("APP_SECRET_KEY")
SUPABASE_URL = (env_value("SUPABASE_URL") or "").rstrip("/")
SUPABASE_JWT_SECRET = env_value("SUPABASE_JWT_SECRET")
SUPABASE_JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else ""
BOOK_STORAGE_ENDPOINT = env_value("BOOK_STORAGE_ENDPOINT")
BOOK_STORAGE_ADDRESSING_STYLE = (env_value("BOOK_STORAGE_ADDRESSING_STYLE") or "virtual").lower()
LOCAL_DEV_USER_ID = "00000000-0000-0000-0000-000000000001"
LIVE_AUDIO_CACHE_VERSION = 7
PROVIDER_TEST_CACHE_VERSION = 2
TTSProviderId = Literal["google", "kokoro"]
GEMINI_MAX_RETRY_ATTEMPTS = 3
GEMINI_MAX_RETRY_DELAY_SECONDS = 75.0
BOOK_STORAGE_BUCKET = env_value("BOOK_STORAGE_BUCKET")
BOOK_STORAGE_PREFIX = (env_value("BOOK_STORAGE_PREFIX") or "storybook-reader").strip("/")
BOOK_STORAGE_REGION = env_value("BOOK_STORAGE_REGION") or env_value("AWS_REGION") or env_value("AWS_DEFAULT_REGION")
BOOK_STORAGE_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
BOOK_TITLE_MAX_LENGTH = 180
BOOK_EXTRACTION_CACHE_VERSION = 2
SUPPORTED_BOOK_EXTENSIONS = {
    ".pdf": "application/pdf",
    ".epub": "application/epub+zip",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".html": "text/html",
    ".htm": "text/html",
    ".xhtml": "application/xhtml+xml",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
SUPPORTED_BOOK_FORMAT_LABEL = ", ".join(
    extension.upper().lstrip(".") for extension in SUPPORTED_BOOK_EXTENSIONS
)
OFFLINE_DICTIONARY_DB = Path(
    env_value("OFFLINE_DICTIONARY_DB") or str(RUNTIME_DICTIONARY_ROOT / "offline" / "dictionary.sqlite3")
)
OPEN_WORDNET_DATA_DIR = RUNTIME_DICTIONARY_ROOT / "open-wordnet"
SAMSUNG_DICTIONARY_PACKAGE = "com.diotek.sec.lookup.dictionary"
SAMSUNG_DICTIONARY_BRIDGE_LABEL = "Samsung Dictionary · Collins English"
OPEN_WORDNET_SOURCE_LABEL = "Open English WordNet"
FREE_DICTIONARY_SOURCE_LABEL = "Free Dictionary API"
SAMSUNG_DICTIONARY_DEVICE_ID = env_value("SAMSUNG_DICTIONARY_DEVICE_ID")
_samsung_dictionary_bridge_lock = threading.Lock()
_wordnet_download_lock = threading.Lock()
_dictionary_runtime_assets_lock = threading.Lock()


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
KOKORO_VOICES = [
    voice_option("af_heart",   "Heart",   gender="female", gender_source="provider", style="Warm & Natural",        tags=["Story", "Narration", "Audiobook"]),
    voice_option("af_sarah",   "Sarah",   gender="female", gender_source="provider", style="Clear & Conversational"),
    voice_option("af_sky",     "Sky",     gender="female", gender_source="provider", style="Bright & Expressive"),
    voice_option("am_adam",    "Adam",    gender="male",   gender_source="provider", style="Natural & Steady",      tags=["Story", "Narration", "Audiobook"]),
    voice_option("am_michael", "Michael", gender="male",   gender_source="provider", style="Authoritative"),
    voice_option("bf_emma",    "Emma",    gender="female", gender_source="provider", style="British · Warm"),
    voice_option("bm_george",  "George",  gender="male",   gender_source="provider", style="British · Deep",        tags=["Story", "Narration", "Audiobook"]),
    voice_option("bm_lewis",   "Lewis",   gender="male",   gender_source="provider", style="British · Calm"),
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

_SENTRY_DSN = env_value("SENTRY_DSN")
if _SENTRY_DSN:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration

        sentry_sdk.init(
            dsn=_SENTRY_DSN,
            integrations=[StarletteIntegration(), FastApiIntegration()],
            traces_sample_rate=0.2,
            send_default_pii=False,
        )
        logger.info("Sentry error tracking enabled.")
    except ImportError:
        logger.warning("SENTRY_DSN is set but sentry-sdk is not installed. Run: pip install -r requirements.txt")

app = FastAPI(title="Storybook Reader", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/library", StaticFiles(directory=str(DATA_ROOT)), name="library")

_PROTECTED_PREFIXES = ("/api/", "/library/")


def _verify_supabase_jwt(token: str) -> str:
    """Validate a Supabase-issued JWT and return the user UUID (sub claim)."""
    try:
        import jwt as pyjwt
    except ImportError as exc:
        raise RuntimeError("PyJWT is required for Supabase auth. Run: pip install -r requirements.txt") from exc

    try:
        header = pyjwt.get_unverified_header(token)
    except pyjwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token header: {exc}")

    algorithm = str(header.get("alg") or "").upper()
    decode_kwargs: dict[str, Any] = {
        "algorithms": [algorithm] if algorithm else None,
        "audience": "authenticated",
    }

    if algorithm.startswith("HS"):
        if not SUPABASE_JWT_SECRET:
            raise HTTPException(
                status_code=401,
                detail="Supabase JWT secret is not configured for symmetric token verification.",
            )
        key = SUPABASE_JWT_SECRET
    else:
        if not SUPABASE_JWKS_URL:
            raise HTTPException(
                status_code=401,
                detail="SUPABASE_URL is required to verify Supabase JWTs signed with JWKS.",
            )
        decode_kwargs["issuer"] = f"{SUPABASE_URL}/auth/v1"
        global _supabase_jwk_client
        with _supabase_jwk_client_lock:
            if _supabase_jwk_client is None:
                _supabase_jwk_client = pyjwt.PyJWKClient(
                    SUPABASE_JWKS_URL,
                    cache_keys=True,
                    cache_jwk_set=True,
                    lifespan=300,
                    timeout=10,
                )
        try:
            key = _supabase_jwk_client.get_signing_key_from_jwt(token).key
        except Exception as exc:
            raise HTTPException(status_code=401, detail=f"Unable to resolve signing key: {exc}")

    decode_kwargs = {name: value for name, value in decode_kwargs.items() if value is not None}
    try:
        payload = pyjwt.decode(token, key, **decode_kwargs)
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired. Please sign in again.")
    except pyjwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing user identity.")
    return str(user_id)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Authenticate requests and set the per-request user identity.

    Priority:
      1. SUPABASE_URL / SUPABASE_JWT_SECRET set → validate Supabase JWT, extract real user UUID.
      2. APP_SECRET_KEY set → shared-secret fallback (local dev), fixed user ID.
      3. Neither set → unauthenticated local dev, fixed user ID, no DB isolation.
    """
    path = request.url.path

    if request.method == "OPTIONS" or path == "/api/health":
        return await call_next(request)

    if not any(path.startswith(prefix) for prefix in _PROTECTED_PREFIXES):
        return await call_next(request)

    auth_header = request.headers.get("authorization", "")
    bearer = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""

    if SUPABASE_URL or SUPABASE_JWT_SECRET:
        if not bearer:
            return JSONResponse({"detail": "Authentication required."}, status_code=401)
        try:
            user_id = _verify_supabase_jwt(bearer)
        except HTTPException as exc:
            return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    elif APP_SECRET_KEY:
        if bearer != APP_SECRET_KEY:
            return JSONResponse({"detail": "Access key required."}, status_code=401)
        user_id = LOCAL_DEV_USER_ID
    else:
        user_id = LOCAL_DEV_USER_ID

    tok = _current_user_id.set(user_id)
    try:
        return await call_next(request)
    finally:
        _current_user_id.reset(tok)


def current_user_id() -> str:
    """Return the authenticated user's UUID for the current request."""
    uid = _current_user_id.get()
    if uid:
        return uid
    raise HTTPException(status_code=403, detail="Authentication required.")


job_lock = threading.Lock()
job_state: dict[str, dict[str, Any]] = {}
# Books cache: keyed by user_id → (list[book], expires_at)
_books_cache: dict[str, tuple[list[dict[str, Any]], float]] = {}
_books_cache_lock = threading.Lock()
BOOKS_CACHE_TTL = 60.0
_book_storage_client: Any = None
_book_storage_client_lock = threading.Lock()
_supabase_jwk_client: Any = None
_supabase_jwk_client_lock = threading.Lock()
# Per-request user identity set by auth_middleware
_current_user_id: ContextVar[str | None] = ContextVar("user_id", default=None)
progress_store_lock = threading.Lock()
progress_store_ready = False
# In-memory presynthesis job tracking { job_id -> {status, completed, total} }
_presynth_jobs: dict[str, dict[str, Any]] = {}


class JobCancelledError(RuntimeError):
    pass


class GenerateAudioRequest(BaseModel):
    provider: TTSProviderId = "kokoro"
    voice: str | None = None
    model: str | None = None
    output_format: Literal["mp3", "m4b", "wav"] = "mp3"
    narration_style: str = Field(default=DEFAULT_NARRATION_STYLE, max_length=1500)
    chunk_size: int | None = Field(default=None, ge=150, le=4000)
    length_scale: float = Field(default=1.0, ge=0.6, le=1.5)
    sentence_silence: float = Field(default=0.2, ge=0.0, le=1.0)


class ProviderTestRequest(BaseModel):
    provider: TTSProviderId = "kokoro"
    voice: str | None = None
    model: str | None = None
    narration_style: str = Field(default=DEFAULT_NARRATION_STYLE, max_length=1500)
    length_scale: float = Field(default=1.0, ge=0.6, le=1.5)
    sentence_silence: float = Field(default=0.2, ge=0.0, le=1.0)


class LiveAudioRequest(BaseModel):
    provider: TTSProviderId = "kokoro"
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


class ProviderWarmupRequest(BaseModel):
    provider: str
    voice: str | None = None
    model: str | None = None


class PresynthesizeRequest(BaseModel):
    provider: TTSProviderId = "kokoro"
    voice: str | None = None
    narration_style: str = Field(default="", max_length=1500)
    length_scale: float = Field(default=1.0, ge=0.6, le=1.5)
    sentence_silence: float = Field(default=0.2, ge=0.0, le=1.0)
    start_from: int = Field(default=0, ge=0)


class HighlightCreateRequest(BaseModel):
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    color: Literal["amber", "rose", "sky"]
    kind: Literal["highlight", "note", "vocabulary"] = "highlight"
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


class LearningEventCreateRequest(BaseModel):
    type: str = Field(min_length=1, max_length=80)
    xpDelta: int = Field(default=0, ge=0, le=500)
    bookId: str | None = Field(default=None, max_length=120)
    deckId: str | None = Field(default=None, max_length=120)
    cardId: str | None = Field(default=None, max_length=120)
    label: str | None = Field(default=None, max_length=180)
    detail: str | None = Field(default=None, max_length=500)


class DirectBookUploadInitRequest(BaseModel):
    fileName: str = Field(min_length=1, max_length=260)
    contentType: str = Field(default="application/pdf", max_length=200)
    size: int = Field(gt=0, le=BOOK_STORAGE_MAX_UPLOAD_BYTES)
    title: str | None = Field(default=None, max_length=BOOK_TITLE_MAX_LENGTH)


class DirectBookUploadCompleteRequest(BaseModel):
    bookId: str = Field(min_length=12, max_length=12)
    fileName: str = Field(min_length=1, max_length=260)
    title: str | None = Field(default=None, max_length=BOOK_TITLE_MAX_LENGTH)


class DictionarySensePayload(BaseModel):
    partOfSpeech: str | None = None
    definition: str
    examples: list[str] = Field(default_factory=list)
    registerLabel: str | None = None
    notes: str | None = None
    synonyms: list[str] = Field(default_factory=list)


class DictionaryLookupPayload(BaseModel):
    term: str
    normalizedTerm: str
    available: bool
    exact: bool
    source: str | None = None
    pronunciation: str | None = None
    entries: list[DictionarySensePayload] = Field(default_factory=list)
    matchNote: str | None = None
    relatedTerms: list[str] = Field(default_factory=list)
    message: str | None = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_book_title(title: str | None, file_name: str) -> str:
    fallback = Path(file_name).stem.strip() or Path(file_name).name.strip() or "Untitled book"
    if title is None:
        return fallback

    normalized = re.sub(r"\s+", " ", title).strip()
    if not normalized:
        return fallback
    if len(normalized) > BOOK_TITLE_MAX_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Book titles must be {BOOK_TITLE_MAX_LENGTH} characters or fewer.",
        )
    return normalized


def normalize_dictionary_term(value: str) -> str:
    normalized = re.sub(r"\s+", " ", value).strip()
    normalized = normalized.strip(" \t\r\n\"“”'‘’.,;:!?()[]{}")
    return normalized[:120]


def normalize_samsung_ui_term(value: str) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    text = "".join(character for character in text if not unicodedata.combining(character))
    text = text.replace("′", "'")
    text = re.sub(r"[^A-Za-z0-9\s\-']", "", text)
    return re.sub(r"\s+", " ", text).strip().casefold()


def parse_android_bounds(value: str) -> tuple[int, int, int, int] | None:
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", value.strip())
    if not match:
        return None
    left, top, right, bottom = (int(part) for part in match.groups())
    return left, top, right, bottom


def center_of_bounds(value: str) -> tuple[int, int] | None:
    bounds = parse_android_bounds(value)
    if bounds is None:
        return None
    left, top, right, bottom = bounds
    return (left + right) // 2, (top + bottom) // 2


def resolve_adb_executable() -> Path | None:
    candidates: list[Path] = []
    explicit = env_value("ADB_EXE")
    if explicit:
        candidates.append(Path(explicit))
    which = shutil.which("adb")
    if which:
        candidates.append(Path(which))
    winget_root = Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages"
    candidates.extend(sorted(winget_root.glob("Google.PlatformTools*/platform-tools/adb.exe"), reverse=True))

    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.expanduser()
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.exists():
            return resolved
    return None


def run_adb_command(
    adb_executable: Path,
    *args: str,
    device_id: str | None = None,
    timeout: float = 20,
    check: bool = True,
) -> str:
    command = [str(adb_executable)]
    if device_id:
        command.extend(["-s", device_id])
    command.extend(args)
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        timeout=timeout,
        check=False,
    )
    if check and completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        raise RuntimeError(stderr or stdout or f"adb exited with status {completed.returncode}.")
    return completed.stdout


def resolve_samsung_dictionary_device_id(adb_executable: Path) -> str | None:
    run_adb_command(adb_executable, "start-server", timeout=15, check=False)
    output = run_adb_command(adb_executable, "devices", timeout=15)
    device_ids: list[str] = []
    for line in output.splitlines():
        line = line.strip()
        if not line or line.startswith("List of devices attached"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            device_ids.append(parts[0])
    if SAMSUNG_DICTIONARY_DEVICE_ID:
        return SAMSUNG_DICTIONARY_DEVICE_ID if SAMSUNG_DICTIONARY_DEVICE_ID in device_ids else None
    if len(device_ids) == 1:
        return device_ids[0]
    return None


def dictionary_db_schema_sql() -> str:
    return """
        create table if not exists entries (
            lookup_term text not null,
            term text not null,
            pronunciation text,
            part_of_speech text,
            definition text not null,
            examples_json text,
            register text,
            notes text,
            source text,
            priority integer not null default 0
        );
        create index if not exists idx_entries_lookup_term on entries (lookup_term);
    """


def ensure_dictionary_runtime_assets() -> None:
    with _dictionary_runtime_assets_lock:
        if OFFLINE_DICTIONARY_BUNDLE_DB.exists() and not OFFLINE_DICTIONARY_DB.exists():
            OFFLINE_DICTIONARY_DB.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(OFFLINE_DICTIONARY_BUNDLE_DB, OFFLINE_DICTIONARY_DB)

        bundled_wordnet_zip = OPEN_WORDNET_BUNDLE_DIR / "corpora" / "wordnet.zip"
        runtime_wordnet_zip = OPEN_WORDNET_DATA_DIR / "corpora" / "wordnet.zip"
        if bundled_wordnet_zip.exists() and not runtime_wordnet_zip.exists():
            runtime_wordnet_zip.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(bundled_wordnet_zip, runtime_wordnet_zip)


def ensure_dictionary_db_schema() -> None:
    ensure_dictionary_runtime_assets()
    OFFLINE_DICTIONARY_DB.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(OFFLINE_DICTIONARY_DB) as conn:
        conn.executescript(dictionary_db_schema_sql())
        conn.commit()


def dictionary_db_available() -> bool:
    ensure_dictionary_runtime_assets()
    return OFFLINE_DICTIONARY_DB.exists() and OFFLINE_DICTIONARY_DB.is_file()


def default_dictionary_unavailable_payload(term: str) -> dict[str, Any]:
    normalized = normalize_dictionary_term(term)
    return {
        "term": term,
        "normalizedTerm": normalized,
        "available": False,
        "exact": False,
        "source": None,
        "pronunciation": None,
        "entries": [],
        "matchNote": None,
        "relatedTerms": [],
        "message": "Offline dictionary data is not installed yet.",
    }


def parse_dictionary_examples(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return []
        try:
            parsed = json.loads(trimmed)
        except json.JSONDecodeError:
            parsed = [item.strip(" -\t") for item in trimmed.splitlines() if item.strip()]
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
        if isinstance(parsed, str) and parsed.strip():
            return [parsed.strip()]
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def clean_dictionary_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def normalize_dictionary_link_term(value: str | None) -> str:
    return normalize_dictionary_term((value or "").replace("_", " "))


def unique_dictionary_terms(values: list[str], *, exclude: set[str] | None = None, limit: int = 8) -> list[str]:
    excluded = {item.casefold() for item in (exclude or set()) if item}
    seen: set[str] = set()
    items: list[str] = []

    for raw_value in values:
        term = normalize_dictionary_link_term(raw_value)
        if not term:
            continue
        folded = term.casefold()
        if folded in excluded or folded in seen:
            continue
        seen.add(folded)
        items.append(term)
        if len(items) >= limit:
            break

    return items


def unique_dictionary_examples(values: list[str], *, limit: int = 3) -> list[str]:
    seen: set[str] = set()
    items: list[str] = []

    for raw_value in values:
        example = clean_dictionary_text(raw_value)
        if not example:
            continue
        folded = example.casefold()
        if folded in seen:
            continue
        seen.add(folded)
        items.append(example)
        if len(items) >= limit:
            break

    return items


def humanize_wordnet_lexname(value: str | None) -> str | None:
    if not value:
        return None
    _, _, suffix = value.partition(".")
    label = (suffix or value).replace("_", " ").strip()
    return label.title() if label else None


def fetch_dictionary_rows(term: str) -> list[sqlite3.Row]:
    if not dictionary_db_available():
        return []

    query = """
        select
            term,
            pronunciation,
            part_of_speech,
            definition,
            examples_json,
            source,
            register,
            notes
        from entries
        where lookup_term = ?
        order by priority desc, rowid asc
        limit 8
    """

    try:
        with sqlite3.connect(f"file:{OFFLINE_DICTIONARY_DB}?mode=ro", uri=True) as conn:
            conn.row_factory = sqlite3.Row
            return conn.execute(query, (term.casefold(),)).fetchall()
    except sqlite3.OperationalError as exc:
        message = str(exc).lower()
        if "no such table" in message:
            return []
        logger.error("Offline dictionary lookup failed: %s", exc)
        raise HTTPException(status_code=500, detail="Offline dictionary lookup failed.") from exc
    except sqlite3.DatabaseError as exc:
        logger.error("Offline dictionary lookup failed: %s", exc)
        raise HTTPException(status_code=500, detail="Offline dictionary lookup failed.") from exc


def build_dictionary_payload(term: str, rows: list[sqlite3.Row]) -> dict[str, Any]:
    if not rows:
        return {
            "term": term,
            "normalizedTerm": term,
            "available": True,
            "exact": False,
            "source": None,
            "pronunciation": None,
            "entries": [],
            "matchNote": None,
            "relatedTerms": [],
            "message": f"No offline definition found for “{term}”.",
        }

    first = rows[0]
    source = first["source"] if "source" in first.keys() else None
    pronunciation = first["pronunciation"] if "pronunciation" in first.keys() else None

    entries = [
        {
            "partOfSpeech": row["part_of_speech"] if "part_of_speech" in row.keys() else None,
            "definition": row["definition"],
            "examples": parse_dictionary_examples(row["examples_json"] if "examples_json" in row.keys() else None),
            "registerLabel": row["register"] if "register" in row.keys() else None,
            "notes": row["notes"] if "notes" in row.keys() else None,
            "synonyms": [],
        }
        for row in rows
    ]

    return {
        "term": first["term"] or term,
        "normalizedTerm": term,
        "available": True,
        "exact": str(first["term"] or "").casefold() == term.casefold(),
        "source": source,
        "pronunciation": pronunciation,
        "entries": entries,
        "matchNote": None,
        "relatedTerms": [],
        "message": None,
    }


def extract_ui_xml(output: str) -> str:
    start = output.find("<?xml")
    end = output.rfind("</hierarchy>")
    if start < 0 or end < 0:
        raise RuntimeError("Android UI dump did not return XML.")
    return output[start : end + len("</hierarchy>")]


def find_nodes_by_resource_id(root: ET.Element, resource_id: str) -> list[ET.Element]:
    return [node for node in root.iter("node") if node.attrib.get("resource-id") == resource_id]


def choose_samsung_search_result(root: ET.Element, normalized_term: str) -> ET.Element | None:
    candidates = find_nodes_by_resource_id(root, "com.diotek.sec.lookup.dictionary:id/list_text")
    if not candidates:
        return None

    exact = [
        node
        for node in candidates
        if normalize_samsung_ui_term(node.attrib.get("text", "")) == normalized_term.casefold()
    ]
    if exact:
        return exact[0]

    prefix = [
        node
        for node in candidates
        if normalize_samsung_ui_term(node.attrib.get("text", "")).startswith(normalized_term.casefold())
    ]
    if prefix:
        return prefix[0]
    return candidates[0]


def parse_samsung_preview_entries(keyword: str, preview_text: str, source: str) -> list[dict[str, Any]]:
    cleaned_lines = [re.sub(r"\s+", " ", line).strip() for line in preview_text.splitlines()]
    lines = [line for line in cleaned_lines if line]
    if not lines:
        return []

    entries: list[dict[str, Any]] = []
    prelude_notes: list[str] = []
    current: dict[str, Any] | None = None

    def flush_current() -> None:
        nonlocal current
        if current and current.get("definition"):
            entries.append(current)
        current = None

    for line in lines:
        if re.fullmatch(r"\([^)]*\)", line):
            prelude_notes.append(line)
            continue

        sense_match = re.match(r"^(\d+)\s+([A-Z][A-Z-]+)\s*$", line)
        if sense_match:
            flush_current()
            current = {
                "term": keyword,
                "part_of_speech": sense_match.group(2),
                "definition": "",
                "examples": [],
                "register": None,
                "notes": None,
                "source": source,
            }
            continue

        if current is None:
            current = {
                "term": keyword,
                "part_of_speech": None,
                "definition": "",
                "examples": [],
                "register": None,
                "notes": None,
                "source": source,
            }

        if line.startswith("◇"):
            example = line.lstrip("◇ ").strip()
            if example:
                current["examples"].append(example)
            continue

        if line.startswith("∙") or line.startswith("•"):
            note = line.lstrip("∙• ").strip()
            if note:
                existing_note = current.get("notes")
                current["notes"] = f"{existing_note} {note}".strip() if existing_note else note
            continue

        definition = current["definition"]
        current["definition"] = f"{definition} {line}".strip() if definition else line

    flush_current()

    if prelude_notes and entries:
        first_note = " ".join(prelude_notes)
        entries[0]["notes"] = f"{first_note} {entries[0]['notes']}".strip() if entries[0].get("notes") else first_note

    if not entries and lines:
        entries.append(
            {
                "term": keyword,
                "part_of_speech": None,
                "definition": " ".join(lines),
                "examples": [],
                "register": None,
                "notes": " ".join(prelude_notes) if prelude_notes else None,
                "source": source,
            }
        )
    return entries


def parse_samsung_exact_search(root: ET.Element, normalized_term: str) -> tuple[str | None, list[dict[str, Any]]]:
    list_view_nodes = find_nodes_by_resource_id(root, "com.diotek.sec.lookup.dictionary:id/listview")
    if not list_view_nodes:
        no_match_nodes = find_nodes_by_resource_id(root, "com.diotek.sec.lookup.dictionary:id/tv_no_dictionary")
        if no_match_nodes:
            return no_match_nodes[0].attrib.get("text") or "No matches found.", []
        return "Samsung Dictionary did not return a readable result.", []

    list_view = list_view_nodes[0]
    current_source: str | None = None
    entries: list[dict[str, Any]] = []

    for child in list_view:
        dict_name_nodes = find_nodes_by_resource_id(child, "com.diotek.sec.lookup.dictionary:id/tv_dict_name")
        if dict_name_nodes:
            current_source = dict_name_nodes[0].attrib.get("text", "").strip() or None
            continue

        body_nodes = find_nodes_by_resource_id(child, "com.diotek.sec.lookup.dictionary:id/ly_body")
        if not body_nodes or current_source != "Collins English":
            continue

        keyword_nodes = find_nodes_by_resource_id(child, "com.diotek.sec.lookup.dictionary:id/tv_keyword")
        preview_nodes = find_nodes_by_resource_id(child, "com.diotek.sec.lookup.dictionary:id/tv_preview")
        keyword = keyword_nodes[0].attrib.get("text", "").strip() if keyword_nodes else normalized_term
        preview_text = preview_nodes[0].attrib.get("text", "").strip() if preview_nodes else ""
        if not preview_text:
            continue
        entries.extend(
            parse_samsung_preview_entries(
                keyword=keyword,
                preview_text=preview_text,
                source=SAMSUNG_DICTIONARY_BRIDGE_LABEL,
            )
        )

    if entries:
        return None, entries
    return "Samsung Dictionary returned no Collins English preview for this term.", []


def cache_dictionary_entries(lookup_term: str, entries: list[dict[str, Any]]) -> None:
    if not entries:
        return
    ensure_dictionary_db_schema()
    with sqlite3.connect(OFFLINE_DICTIONARY_DB) as conn:
        conn.execute("delete from entries where lookup_term = ?", (lookup_term.casefold(),))
        for priority, entry in enumerate(entries, start=1):
            conn.execute(
                """
                insert into entries (
                    lookup_term,
                    term,
                    pronunciation,
                    part_of_speech,
                    definition,
                    examples_json,
                    register,
                    notes,
                    source,
                    priority
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    lookup_term.casefold(),
                    entry["term"],
                    entry.get("pronunciation"),
                    entry.get("part_of_speech"),
                    entry["definition"],
                    json.dumps(entry.get("examples") or []),
                    entry.get("register"),
                    entry.get("notes"),
                    entry.get("source"),
                    len(entries) - priority,
                ),
            )
        conn.commit()


def samsung_dictionary_bridge_status() -> tuple[Path | None, str | None, str | None]:
    adb_executable = resolve_adb_executable()
    if adb_executable is None:
        return None, None, "ADB is not installed on this machine."
    device_id = resolve_samsung_dictionary_device_id(adb_executable)
    if device_id is None:
        if SAMSUNG_DICTIONARY_DEVICE_ID:
            return adb_executable, None, f"Samsung dictionary device {SAMSUNG_DICTIONARY_DEVICE_ID} is not connected."
        return adb_executable, None, "Connect exactly one Samsung phone with USB debugging enabled to use the live dictionary bridge."
    return adb_executable, device_id, None


def ensure_open_wordnet_available():
    try:
        import nltk
    except ImportError:
        return None, "NLTK is not installed, so the standalone offline dictionary is unavailable."

    ensure_dictionary_runtime_assets()
    OPEN_WORDNET_DATA_DIR.mkdir(parents=True, exist_ok=True)
    if str(OPEN_WORDNET_DATA_DIR) not in nltk.data.path:
        nltk.data.path.insert(0, str(OPEN_WORDNET_DATA_DIR))

    try:
        nltk.data.find("corpora/wordnet")
    except LookupError:
        try:
            nltk.data.find("corpora/wordnet.zip")
        except LookupError:
            with _wordnet_download_lock:
                try:
                    nltk.data.find("corpora/wordnet")
                except LookupError:
                    try:
                        nltk.data.find("corpora/wordnet.zip")
                    except LookupError:
                        success = nltk.download("wordnet", download_dir=str(OPEN_WORDNET_DATA_DIR), quiet=True)
                        if not success:
                            return None, "Open English WordNet could not be downloaded for standalone offline use."
    try:
        from nltk.corpus import wordnet as wn
    except Exception as exc:  # pragma: no cover - import-path edge case
        return None, f"Open English WordNet is installed but could not be loaded: {exc}"
    return wn, None


def wordnet_part_of_speech(label: str | None) -> str | None:
    mapping = {
        "n": "noun",
        "v": "verb",
        "a": "adjective",
        "s": "adjective",
        "r": "adverb",
    }
    return mapping.get(label or "")


def resolve_wordnet_synsets(wn: Any, normalized: str) -> tuple[str | None, list[Any]]:
    candidates: list[str] = []
    seen: set[str] = set()

    def add_candidate(value: str | None) -> None:
        candidate = clean_dictionary_text((value or "").replace(" ", "_"))
        if not candidate:
            return
        folded = candidate.casefold()
        if folded in seen:
            return
        seen.add(folded)
        candidates.append(candidate)

    add_candidate(normalized)
    if " " not in normalized:
        for pos in ("n", "v", "a", "s", "r"):
            add_candidate(wn.morphy(normalized, pos))

    for candidate in candidates:
        synsets = wn.synsets(candidate)
        if synsets:
            return candidate, synsets
    return None, []


def rank_wordnet_synset(synset: Any) -> tuple[int, int]:
    counts = [max(0, int(lemma.count())) for lemma in synset.lemmas()]
    return (max(counts, default=0), sum(counts))


def build_wordnet_payload(wn: Any, term: str) -> dict[str, Any] | None:
    normalized = normalize_dictionary_term(term)
    resolved_query, synsets = resolve_wordnet_synsets(wn, normalized)
    if not synsets:
        return None

    resolved_term = normalize_dictionary_link_term(resolved_query) or normalized
    exact = resolved_term.casefold() == normalized.casefold()
    sorted_synsets = sorted(
        enumerate(synsets),
        key=lambda item: (-rank_wordnet_synset(item[1])[0], -rank_wordnet_synset(item[1])[1], item[0]),
    )

    entries: list[dict[str, Any]] = []
    seen: set[tuple[str | None, str]] = set()
    related_candidates: list[str] = []

    for _, synset in sorted_synsets:
        definition = clean_dictionary_text(synset.definition())
        if not definition:
            continue

        part_of_speech = wordnet_part_of_speech(getattr(synset, "pos", lambda: None)())
        key = (part_of_speech, definition.casefold())
        if key in seen:
            continue
        seen.add(key)

        examples = unique_dictionary_examples([example for example in synset.examples()], limit=3)
        synonyms = unique_dictionary_terms(
            [lemma.name() for lemma in synset.lemmas()],
            exclude={normalized, resolved_term},
            limit=6,
        )

        for lemma in synset.lemmas():
            related_candidates.append(lemma.name())
            for related in lemma.derivationally_related_forms():
                related_candidates.append(related.name())
            for similar in lemma.pertainyms():
                related_candidates.append(similar.name())
            for antonym in lemma.antonyms():
                related_candidates.append(antonym.name())

        entries.append(
            {
                "term": resolved_term,
                "pronunciation": None,
                "part_of_speech": part_of_speech,
                "definition": definition,
                "examples": examples,
                "register": humanize_wordnet_lexname(synset.lexname() if hasattr(synset, "lexname") else None),
                "notes": None,
                "synonyms": synonyms,
                "source": OPEN_WORDNET_SOURCE_LABEL,
            }
        )
        if len(entries) >= 8:
            break

    if not entries:
        return None

    related_terms = unique_dictionary_terms(
        related_candidates,
        exclude={normalized, resolved_term},
        limit=10,
    )
    match_note = None
    if not exact:
        match_note = f"Showing the base form “{resolved_term}” for “{normalized}”."

    return {
        "term": resolved_term,
        "normalizedTerm": normalized,
        "available": True,
        "exact": exact,
        "source": OPEN_WORDNET_SOURCE_LABEL,
        "pronunciation": None,
        "entries": [
            {
                "partOfSpeech": entry.get("part_of_speech"),
                "definition": entry["definition"],
                "examples": entry.get("examples") or [],
                "registerLabel": entry.get("register"),
                "notes": entry.get("notes"),
                "synonyms": entry.get("synonyms") or [],
            }
            for entry in entries
        ],
        "matchNote": match_note,
        "relatedTerms": related_terms,
        "message": None,
        "_cacheEntries": entries,
    }


def lookup_free_dictionary_api(term: str) -> tuple[dict[str, Any] | None, str | None]:
    """Fetch a definition from dictionaryapi.dev. Falls back to WordNet lemma if inflected form returns 404."""
    normalized = normalize_dictionary_term(term)
    if not normalized:
        return None, "Empty term."

    def _fetch(query: str) -> tuple[list[dict], str | None, str | None]:
        try:
            encoded = urllib.parse.quote(query, safe="")
            with httpx.Client(timeout=5.0) as client:
                resp = client.get(f"https://api.dictionaryapi.dev/api/v2/entries/en/{encoded}")
            if resp.status_code == 404:
                return [], None, None
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            return [], None, str(exc)

        if not isinstance(data, list) or not data:
            return [], None, None

        pronunciation: str | None = None
        for phonetic in data[0].get("phonetics", []):
            if phonetic.get("text"):
                pronunciation = phonetic["text"]
                break

        word = data[0].get("word", query)
        entries: list[dict] = []
        seen: set[tuple[str | None, str]] = set()
        for api_entry in data:
            for meaning in api_entry.get("meanings", []):
                pos = meaning.get("partOfSpeech")
                for defn in meaning.get("definitions", []):
                    definition = (defn.get("definition") or "").strip()
                    if not definition:
                        continue
                    key = (pos, definition.casefold())
                    if key in seen:
                        continue
                    seen.add(key)
                    entries.append({
                        "term": word,
                        "pronunciation": pronunciation,
                        "part_of_speech": pos,
                        "definition": definition,
                        "examples": [defn["example"]] if defn.get("example") else [],
                        "register": None,
                        "notes": None,
                        "synonyms": (defn.get("synonyms") or [])[:6],
                        "source": FREE_DICTIONARY_SOURCE_LABEL,
                    })
                    if len(entries) >= 8:
                        return entries, pronunciation, None
        return entries, pronunciation, None

    entries, pronunciation, error = _fetch(normalized)

    # For single inflected words, retry with WordNet-lemmatized base form
    if not entries and " " not in normalized:
        wn, _ = ensure_open_wordnet_available()
        if wn is not None:
            seen_bases: set[str] = set()
            for pos in ("v", "n", "a", "s", "r"):
                base = wn.morphy(normalized, pos)
                if base and base.casefold() != normalized.casefold() and base not in seen_bases:
                    seen_bases.add(base)
                    base_entries, base_pronunciation, base_error = _fetch(base)
                    if base_entries:
                        entries = base_entries
                        pronunciation = base_pronunciation
                        error = base_error
                        break

    if not entries:
        return None, error or f"Free Dictionary API: no entry for \"{normalized}\"."

    cache_dictionary_entries(normalized, entries)
    cached_rows = fetch_dictionary_rows(normalized)
    if cached_rows:
        payload = build_dictionary_payload(normalized, cached_rows)
        if pronunciation and not payload.get("pronunciation"):
            payload["pronunciation"] = pronunciation
        return payload, None

    # Cache write failed — build response directly from entries
    first = entries[0]
    return {
        "term": first["term"],
        "normalizedTerm": normalized,
        "available": True,
        "exact": str(first["term"]).casefold() == normalized.casefold(),
        "source": FREE_DICTIONARY_SOURCE_LABEL,
        "pronunciation": pronunciation,
        "entries": [
            {
                "partOfSpeech": e.get("part_of_speech"),
                "definition": e["definition"],
                "examples": e.get("examples") or [],
                "registerLabel": None,
                "notes": None,
                "synonyms": e.get("synonyms") or [],
            }
            for e in entries
        ],
        "matchNote": None,
        "relatedTerms": [],
        "message": None,
    }, None


def lookup_open_wordnet_dictionary(term: str) -> tuple[dict[str, Any] | None, str | None]:
    normalized = normalize_dictionary_term(term)
    wn, availability_error = ensure_open_wordnet_available()
    if availability_error:
        return None, availability_error
    if wn is None:
        return None, "Open English WordNet is unavailable."

    payload = build_wordnet_payload(wn, normalized)
    if payload is None:
        return None, f"No standalone offline definition found for “{normalized}”."

    cache_entries = payload.pop("_cacheEntries", [])
    cache_dictionary_entries(normalized, cache_entries)
    cached_rows = fetch_dictionary_rows(normalized)
    if cached_rows:
        payload["message"] = "Fetched from Open English WordNet and cached locally."
        return payload, None
    return None, "Open English WordNet returned data, but the local cache could not be written."


def lookup_samsung_dictionary_via_adb(term: str) -> tuple[dict[str, Any] | None, str | None]:
    normalized = normalize_dictionary_term(term)
    adb_executable, device_id, bridge_error = samsung_dictionary_bridge_status()
    if bridge_error or adb_executable is None or device_id is None:
        return None, bridge_error

    with _samsung_dictionary_bridge_lock:
        try:
            run_adb_command(adb_executable, "shell", "am", "force-stop", SAMSUNG_DICTIONARY_PACKAGE, device_id=device_id)
            time.sleep(0.6)
            run_adb_command(
                adb_executable,
                "shell",
                "monkey",
                "-p",
                SAMSUNG_DICTIONARY_PACKAGE,
                "-c",
                "android.intent.category.LAUNCHER",
                "1",
                device_id=device_id,
                timeout=20,
            )
            time.sleep(1.5)

            search_root = ET.fromstring(extract_ui_xml(run_adb_command(adb_executable, "exec-out", "uiautomator", "dump", "/dev/tty", device_id=device_id, timeout=20)))
            search_field = find_nodes_by_resource_id(search_root, "android:id/search_src_text")
            if not search_field:
                return None, "Samsung Dictionary opened, but the search field was not accessible."
            search_center = center_of_bounds(search_field[0].attrib.get("bounds", ""))
            if search_center is None:
                return None, "Samsung Dictionary search field bounds were invalid."
            run_adb_command(adb_executable, "shell", "input", "tap", str(search_center[0]), str(search_center[1]), device_id=device_id)
            time.sleep(0.3)

            encoded_term = normalized.replace(" ", "%s")
            run_adb_command(adb_executable, "shell", "input", "text", encoded_term, device_id=device_id)
            time.sleep(1.2)

            results_root = ET.fromstring(extract_ui_xml(run_adb_command(adb_executable, "exec-out", "uiautomator", "dump", "/dev/tty", device_id=device_id, timeout=20)))
            result_node = choose_samsung_search_result(results_root, normalized)
            if result_node is None:
                return None, f"Samsung Dictionary returned no matches for “{normalized}”."
            result_center = center_of_bounds(result_node.attrib.get("bounds", ""))
            if result_center is None:
                return None, "Samsung Dictionary result bounds were invalid."
            run_adb_command(adb_executable, "shell", "input", "tap", str(result_center[0]), str(result_center[1]), device_id=device_id)
            time.sleep(1.2)

            exact_root = ET.fromstring(extract_ui_xml(run_adb_command(adb_executable, "exec-out", "uiautomator", "dump", "/dev/tty", device_id=device_id, timeout=20)))
            message, entries = parse_samsung_exact_search(exact_root, normalized)
            if not entries:
                return None, message or f"Samsung Dictionary returned no matches for “{normalized}”."

            cache_dictionary_entries(normalized, entries)
            cached_rows = fetch_dictionary_rows(normalized)
            if cached_rows:
                payload = build_dictionary_payload(normalized, cached_rows)
                payload["message"] = "Fetched from the connected Samsung Dictionary and cached locally."
                return payload, None

            return None, "Samsung Dictionary returned data, but the local cache could not be written."
        except (ET.ParseError, RuntimeError, subprocess.TimeoutExpired) as exc:
            return None, f"Samsung Dictionary bridge failed: {exc}"


def lookup_offline_dictionary(term: str) -> dict[str, Any]:
    normalized = normalize_dictionary_term(term)
    if not normalized:
        raise HTTPException(status_code=400, detail="Select a word or phrase to look up.")

    rows = fetch_dictionary_rows(normalized)
    if rows:
        source = rows[0]["source"] if "source" in rows[0].keys() else None
        if source == OPEN_WORDNET_SOURCE_LABEL:
            # Upgrade stale WordNet cache entry to Free Dictionary where possible
            free_dict_payload, _ = lookup_free_dictionary_api(normalized)
            if free_dict_payload is not None:
                free_dict_payload["message"] = None
                return free_dict_payload
            wn, availability_error = ensure_open_wordnet_available()
            if not availability_error and wn is not None:
                wordnet_payload = build_wordnet_payload(wn, normalized)
                if wordnet_payload is not None:
                    wordnet_payload["message"] = None
                    wordnet_payload.pop("_cacheEntries", None)
                    return wordnet_payload
        payload = build_dictionary_payload(normalized, rows)
        payload["message"] = None
        return payload

    samsung_payload, samsung_error = lookup_samsung_dictionary_via_adb(normalized)
    if samsung_payload is not None:
        return samsung_payload

    free_dict_payload, free_dict_error = lookup_free_dictionary_api(normalized)
    if free_dict_payload is not None:
        if samsung_error and not free_dict_payload.get("message"):
            free_dict_payload["message"] = samsung_error
        return free_dict_payload

    wordnet_payload, wordnet_error = lookup_open_wordnet_dictionary(normalized)
    if wordnet_payload is not None:
        if samsung_error and not wordnet_payload.get("message"):
            wordnet_payload["message"] = samsung_error
        return wordnet_payload

    failure_notes = [message for message in (samsung_error, free_dict_error, wordnet_error) if message]
    failure_message = " ".join(dict.fromkeys(failure_notes)) if failure_notes else None

    if dictionary_db_available():
        payload = build_dictionary_payload(normalized, [])
        if failure_message:
            payload["message"] = failure_message
        return payload

    payload = default_dictionary_unavailable_payload(term)
    if failure_message:
        payload["message"] = failure_message
    return payload


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


# Each entry is a list of SQL statements for that migration version (1-indexed).
# Migrations are idempotent — use IF NOT EXISTS / IF EXISTS guards so re-running is safe.
# NEVER modify existing entries. Add new lists at the end for future schema changes.
_SCHEMA_MIGRATIONS: list[list[str]] = [
    # Version 1 — initial progress tables
    [
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
        """,
        """
        create table if not exists audio_progress (
            book_id text primary key,
            audio_url text not null,
            playback_time double precision not null,
            was_playing boolean not null,
            updated_at timestamptz not null default now()
        )
        """,
    ],
    # Version 2 — books table (primary metadata store, replaces S3 meta.json)
    [
        """
        create table if not exists books (
            id             text        primary key,
            user_id        uuid        not null references auth.users(id) on delete cascade,
            title          text        not null,
            file_name      text        not null,
            uploaded_at    timestamptz not null default now(),
            page_count     integer     not null default 0,
            text_chars     integer     not null default 0,
            excerpt        text        not null default '',
            latest_audio   jsonb,
            audio_history  jsonb       not null default '[]',
            source_storage jsonb,
            created_at     timestamptz not null default now()
        )
        """,
        "create index if not exists books_user_uploaded on books(user_id, uploaded_at desc)",
        """
        create table if not exists highlights (
            id         text        not null,
            book_id    text        not null references books(id) on delete cascade,
            user_id    uuid        not null references auth.users(id) on delete cascade,
            start_pos  integer     not null,
            end_pos    integer     not null,
            color      text        not null default 'amber',
            kind       text        not null default 'highlight',
            text       text        not null,
            note       text,
            created_at timestamptz not null default now(),
            primary key (book_id, id)
        )
        """,
        "create index if not exists highlights_book on highlights(book_id)",
        "create index if not exists highlights_user on highlights(user_id)",
    ],
    # Version 3 — add user_id to progress tables
    [
        "alter table reader_progress add column if not exists user_id uuid references auth.users(id) on delete cascade",
        "create index if not exists reader_progress_user_book on reader_progress(user_id, book_id)",
        "alter table audio_progress add column if not exists user_id uuid references auth.users(id) on delete cascade",
        "create index if not exists audio_progress_user_book on audio_progress(user_id, book_id)",
    ],
    # Version 4 — preserve local source paths when SQL is the metadata store
    [
        "alter table books add column if not exists source_path text",
    ],
    # Version 5 — per-user progress rows + durable extracted text cache
    [
        """
        create table if not exists book_text_cache (
            book_id text not null references books(id) on delete cascade,
            user_id uuid not null references auth.users(id) on delete cascade,
            text_content text not null,
            content_sha256 text not null,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            primary key (book_id, user_id)
        )
        """,
        "create index if not exists book_text_cache_user_updated on book_text_cache(user_id, updated_at desc)",
        """
        do $$
        begin
            if exists (
                select 1
                from pg_constraint
                where conrelid = 'reader_progress'::regclass
                  and conname = 'reader_progress_pkey'
            ) then
                alter table reader_progress drop constraint reader_progress_pkey;
            end if;
        exception
            when undefined_table then null;
        end
        $$;
        """,
        """
        do $$
        begin
            if exists (
                select 1
                from pg_constraint
                where conrelid = 'audio_progress'::regclass
                  and conname = 'audio_progress_pkey'
            ) then
                alter table audio_progress drop constraint audio_progress_pkey;
            end if;
        exception
            when undefined_table then null;
        end
        $$;
        """,
        "create unique index if not exists reader_progress_user_book_unique on reader_progress(book_id, user_id)",
        "create unique index if not exists audio_progress_user_book_unique on audio_progress(book_id, user_id)",
    ],
    # Version 6 — multi-format import metadata + source-hash extraction cache
    [
        "alter table books add column if not exists source_sha256 text",
        "alter table books add column if not exists source_format text",
        "create index if not exists books_user_source_sha256 on books(user_id, source_sha256)",
        """
        create table if not exists book_import_cache (
            user_id uuid not null references auth.users(id) on delete cascade,
            source_sha256 text not null,
            extraction_version integer not null,
            source_format text not null,
            cleaned_text text not null,
            page_count integer not null,
            text_chars integer not null,
            excerpt text not null default '',
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            primary key (user_id, source_sha256, extraction_version)
        )
        """,
        "create index if not exists book_import_cache_user_updated on book_import_cache(user_id, updated_at desc)",
    ],
    # Version 7 — vocabulary studio (decks/notes/cards/reviews/etc).
    # Was applied first via Supabase MCP under the name `vocabulary_studio_v1`;
    # mirrored here so a fresh DB self-bootstraps. All statements are idempotent.
    [
        """
        create table if not exists decks (
            id           text        primary key,
            user_id      uuid        not null references auth.users(id) on delete cascade,
            title        text        not null,
            description  text,
            config_json  jsonb       not null default '{}'::jsonb,
            created_at   timestamptz not null,
            updated_at   timestamptz not null
        )
        """,
        "create index if not exists idx_decks_user_updated_at on decks (user_id, updated_at desc)",
        """
        create table if not exists notes (
            id               text        primary key,
            deck_id          text        not null references decks(id) on delete cascade,
            user_id          uuid        not null references auth.users(id) on delete cascade,
            note_type        text        not null,
            front            text        not null,
            back             text,
            extra            text,
            hint             text,
            explanation      text,
            example_sentence text,
            image_url        text,
            audio_url        text,
            tags_json        jsonb       not null default '[]'::jsonb,
            topic            text,
            source_ref       text        unique,
            metadata_json    jsonb       not null default '{}'::jsonb,
            created_at       timestamptz not null,
            updated_at       timestamptz not null
        )
        """,
        "create index if not exists idx_notes_deck_updated_at on notes (deck_id, updated_at desc)",
        "create index if not exists idx_notes_user_deck_updated on notes (user_id, deck_id, updated_at desc)",
        """
        create table if not exists cards (
            id                  text        primary key,
            deck_id             text        not null references decks(id) on delete cascade,
            note_id             text        not null references notes(id) on delete cascade,
            user_id             uuid        not null references auth.users(id) on delete cascade,
            card_type           text        not null,
            state               text        not null,
            due_at              timestamptz not null,
            last_review_at      timestamptz,
            stability           double precision,
            difficulty          double precision,
            elapsed_days        integer     not null default 0,
            scheduled_days      integer     not null default 0,
            reps                integer     not null default 0,
            lapses              integer     not null default 0,
            learning_step_index integer,
            is_suspended        boolean     not null default false,
            position            integer     not null default 0,
            cloze_index         integer,
            cue                 text        not null,
            answer              text        not null,
            created_at          timestamptz not null,
            updated_at          timestamptz not null
        )
        """,
        "create index if not exists idx_cards_deck_due on cards (deck_id, is_suspended, state, due_at)",
        "create index if not exists idx_cards_note on cards (note_id, position)",
        "create index if not exists idx_cards_user_deck_due on cards (user_id, deck_id, is_suspended, state, due_at)",
        """
        create table if not exists review_logs (
            id                    text        primary key,
            card_id               text        not null references cards(id) on delete cascade,
            user_id               uuid        not null references auth.users(id) on delete cascade,
            reviewed_at           timestamptz not null,
            rating                text        not null,
            state_before          text        not null,
            state_after           text        not null,
            due_before            timestamptz not null,
            due_after             timestamptz not null,
            elapsed_days          integer     not null,
            scheduled_days_before integer     not null,
            scheduled_days_after  integer     not null,
            response_ms           integer,
            answer_mode           text        not null,
            was_auto_graded       boolean     not null default false,
            typed_response        text,
            created_at            timestamptz not null
        )
        """,
        "create index if not exists idx_review_logs_card_reviewed_at on review_logs (card_id, reviewed_at desc)",
        "create index if not exists idx_review_logs_reviewed_at on review_logs (reviewed_at desc)",
        "create index if not exists idx_review_logs_user_card on review_logs (user_id, card_id, reviewed_at desc)",
        """
        create table if not exists production_logs (
            id             text        primary key,
            card_id        text        not null references cards(id) on delete cascade,
            user_id        uuid        not null references auth.users(id) on delete cascade,
            created_at     timestamptz not null,
            sentences_json jsonb       not null default '[]'::jsonb
        )
        """,
        "create index if not exists idx_production_logs_card_created_at on production_logs (card_id, created_at desc)",
        """
        create table if not exists card_context_cache (
            id           text        primary key,
            card_id      text        not null references cards(id) on delete cascade,
            user_id      uuid        not null references auth.users(id) on delete cascade,
            cache_key    text        not null,
            payload_json jsonb       not null default '{}'::jsonb,
            source       text        not null,
            created_at   timestamptz not null,
            updated_at   timestamptz not null,
            unique (card_id, cache_key)
        )
        """,
        "create index if not exists idx_card_context_cache_card_updated_at on card_context_cache (card_id, updated_at desc)",
        """
        create table if not exists practice_attempts (
            id                 text        primary key,
            card_id            text        not null references cards(id) on delete cascade,
            user_id            uuid        not null references auth.users(id) on delete cascade,
            mode               text        not null,
            step               text        not null,
            turn_index         integer     not null default 0,
            provider           text        not null,
            learner_input_json jsonb,
            ai_payload_json    jsonb       not null default '{}'::jsonb,
            verdict            text,
            suggested_rating   text,
            created_at         timestamptz not null
        )
        """,
        "create index if not exists idx_practice_attempts_card_created_at on practice_attempts (card_id, created_at desc)",
        "create index if not exists idx_practice_attempts_mode_step on practice_attempts (mode, step, created_at desc)",
        """
        create table if not exists learning_events (
            id           text        primary key,
            user_id      uuid        not null references auth.users(id) on delete cascade,
            event_type   text        not null,
            xp_delta     integer     not null default 0,
            book_id      text,
            deck_id      text,
            card_id      text,
            label        text        not null,
            detail       text,
            payload_json jsonb       not null default '{}'::jsonb,
            created_at   timestamptz not null
        )
        """,
        "create index if not exists idx_learning_events_user_created_at on learning_events (user_id, created_at desc)",
        "alter table decks              enable row level security",
        "alter table notes              enable row level security",
        "alter table cards              enable row level security",
        "alter table review_logs        enable row level security",
        "alter table production_logs    enable row level security",
        "alter table card_context_cache enable row level security",
        "alter table practice_attempts  enable row level security",
        "alter table learning_events    enable row level security",
        # Policies are idempotent via drop-if-exists/create pairs (Postgres 15
        # has no `create policy if not exists`).
        "drop policy if exists decks_owner on decks; create policy decks_owner on decks for all using (auth.uid() = user_id)",
        "drop policy if exists notes_owner on notes; create policy notes_owner on notes for all using (auth.uid() = user_id)",
        "drop policy if exists cards_owner on cards; create policy cards_owner on cards for all using (auth.uid() = user_id)",
        "drop policy if exists review_logs_owner on review_logs; create policy review_logs_owner on review_logs for all using (auth.uid() = user_id)",
        "drop policy if exists production_logs_owner on production_logs; create policy production_logs_owner on production_logs for all using (auth.uid() = user_id)",
        "drop policy if exists card_context_cache_owner on card_context_cache; create policy card_context_cache_owner on card_context_cache for all using (auth.uid() = user_id)",
        "drop policy if exists practice_attempts_owner on practice_attempts; create policy practice_attempts_owner on practice_attempts for all using (auth.uid() = user_id)",
        "drop policy if exists learning_events_owner on learning_events; create policy learning_events_owner on learning_events for all using (auth.uid() = user_id)",
    ],
]


def _run_schema_migrations(conn: Any) -> None:
    """Apply any pending schema migrations and record them in schema_migrations."""
    with conn.cursor() as cur:
        cur.execute(
            """
            create table if not exists schema_migrations (
                version integer primary key,
                applied_at timestamptz not null default now()
            )
            """
        )
        conn.commit()

        cur.execute("select version from schema_migrations order by version")
        applied = {row[0] for row in cur.fetchall()}

        for version, statements in enumerate(_SCHEMA_MIGRATIONS, start=1):
            if version in applied:
                continue
            for sql in statements:
                cur.execute(sql)
            cur.execute("insert into schema_migrations (version) values (%s)", (version,))
            conn.commit()
            logger.info("Applied schema migration %d", version)


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
                _run_schema_migrations(conn)
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


# ── Books DB CRUD ─────────────────────────────────────────────────────────────

def _book_row_to_meta(row: tuple[Any, ...]) -> dict[str, Any]:
    """Map a books table row (SELECT *) to the meta dict used throughout the app."""
    (
        id_, user_id, title, file_name, uploaded_at, page_count,
        text_chars, excerpt, latest_audio, audio_history, source_storage, source_path,
        source_sha256, source_format, created_at, highlight_count,
        reading_page_number, reading_total_pages, reading_text_start, reading_text_end,
        reading_text_length, reading_updated_at,
        audio_url, audio_current_time, audio_was_playing, audio_updated_at,
    ) = row
    reading_progress = serialize_reading_progress_row(
        (
            reading_page_number,
            reading_total_pages,
            reading_text_start,
            reading_text_end,
            reading_text_length,
            reading_updated_at,
        )
        if reading_page_number is not None
        else None
    )
    audio_progress = serialize_audio_progress_row(
        (audio_url, audio_current_time, audio_was_playing, audio_updated_at)
        if audio_url is not None
        else None
    )
    return {
        "id": id_,
        "user_id": str(user_id),
        "title": title,
        "fileName": file_name,
        "uploadedAt": serialize_timestamp(uploaded_at),
        "pageCount": page_count,
        "textCharacters": text_chars,
        "excerpt": excerpt or "",
        "latestAudio": latest_audio,
        "audioHistory": audio_history or [],
        "sourceStorage": source_storage,
        "sourcePath": source_path,
        "sourceSha256": source_sha256,
        "sourceFormat": source_format,
        "_highlightCount": highlight_count or 0,
        "_readingProgress": reading_progress,
        "_audioProgress": audio_progress,
    }


def _list_books_sql(user_id: str) -> list[dict[str, Any]]:
    with progress_store_cursor() as cur:
        cur.execute(
            """
            SELECT b.id, b.user_id, b.title, b.file_name, b.uploaded_at,
                   b.page_count, b.text_chars, b.excerpt,
                   b.latest_audio, b.audio_history, b.source_storage, b.source_path,
                   b.source_sha256, b.source_format, b.created_at,
                   (
                       SELECT COUNT(*)
                       FROM highlights h
                       WHERE h.book_id = b.id AND h.user_id = b.user_id
                   ) AS highlight_count,
                   rp.page_number, rp.total_pages, rp.text_start, rp.text_end,
                   rp.text_length, rp.updated_at,
                   ap.audio_url, ap.playback_time, ap.was_playing, ap.updated_at
            FROM books b
            LEFT JOIN LATERAL (
                SELECT page_number, total_pages, text_start, text_end, text_length, updated_at
                FROM reader_progress
                WHERE book_id = b.id AND (user_id = b.user_id OR user_id IS NULL)
                ORDER BY (user_id = b.user_id) DESC, updated_at DESC
                LIMIT 1
            ) rp ON true
            LEFT JOIN LATERAL (
                SELECT audio_url, playback_time, was_playing, updated_at
                FROM audio_progress
                WHERE book_id = b.id AND (user_id = b.user_id OR user_id IS NULL)
                ORDER BY (user_id = b.user_id) DESC, updated_at DESC
                LIMIT 1
            ) ap ON true
            WHERE b.user_id = %s
            ORDER BY b.uploaded_at DESC
            """,
            (user_id,),
        )
        return [_book_row_to_meta(row) for row in cur.fetchall()]


def _get_book_sql(book_id: str, user_id: str) -> dict[str, Any] | None:
    with progress_store_cursor() as cur:
        cur.execute(
            """
            SELECT b.id, b.user_id, b.title, b.file_name, b.uploaded_at,
                   b.page_count, b.text_chars, b.excerpt,
                   b.latest_audio, b.audio_history, b.source_storage, b.source_path,
                   b.source_sha256, b.source_format, b.created_at,
                   (
                       SELECT COUNT(*)
                       FROM highlights h
                       WHERE h.book_id = b.id AND h.user_id = b.user_id
                   ) AS highlight_count,
                   rp.page_number, rp.total_pages, rp.text_start, rp.text_end,
                   rp.text_length, rp.updated_at,
                   ap.audio_url, ap.playback_time, ap.was_playing, ap.updated_at
            FROM books b
            LEFT JOIN LATERAL (
                SELECT page_number, total_pages, text_start, text_end, text_length, updated_at
                FROM reader_progress
                WHERE book_id = b.id AND (user_id = b.user_id OR user_id IS NULL)
                ORDER BY (user_id = b.user_id) DESC, updated_at DESC
                LIMIT 1
            ) rp ON true
            LEFT JOIN LATERAL (
                SELECT audio_url, playback_time, was_playing, updated_at
                FROM audio_progress
                WHERE book_id = b.id AND (user_id = b.user_id OR user_id IS NULL)
                ORDER BY (user_id = b.user_id) DESC, updated_at DESC
                LIMIT 1
            ) ap ON true
            WHERE b.id = %s AND b.user_id = %s
            """,
            (book_id, user_id),
        )
        row = cur.fetchone()
        return _book_row_to_meta(row) if row else None


def _upsert_book_sql(meta: dict[str, Any], user_id: str) -> None:
    uploaded_at = parse_iso_timestamp(meta.get("uploadedAt")) or datetime.now(timezone.utc)
    import json as _json
    with progress_store_cursor() as cur:
        cur.execute(
            """
            INSERT INTO books (id, user_id, title, file_name, uploaded_at,
                               page_count, text_chars, excerpt,
                               latest_audio, audio_history, source_storage, source_path,
                               source_sha256, source_format)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                title          = EXCLUDED.title,
                file_name      = EXCLUDED.file_name,
                page_count     = EXCLUDED.page_count,
                text_chars     = EXCLUDED.text_chars,
                excerpt        = EXCLUDED.excerpt,
                latest_audio   = EXCLUDED.latest_audio,
                audio_history  = EXCLUDED.audio_history,
                source_storage = EXCLUDED.source_storage,
                source_path    = EXCLUDED.source_path,
                source_sha256  = EXCLUDED.source_sha256,
                source_format  = EXCLUDED.source_format
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
                _json.dumps(meta["latestAudio"]) if meta.get("latestAudio") else None,
                _json.dumps(meta.get("audioHistory") or []),
                _json.dumps(meta["sourceStorage"]) if meta.get("sourceStorage") else None,
                meta.get("sourcePath"),
                meta.get("sourceSha256"),
                meta.get("sourceFormat"),
            ),
        )


def _delete_book_sql(book_id: str, user_id: str) -> None:
    with progress_store_cursor() as cur:
        cur.execute("DELETE FROM books WHERE id = %s AND user_id = %s", (book_id, user_id))


def _get_book_by_source_hash_sql(source_sha256: str, user_id: str) -> dict[str, Any] | None:
    if not source_sha256:
        return None
    with progress_store_cursor() as cur:
        cur.execute(
            """
            SELECT id
            FROM books
            WHERE user_id = %s AND source_sha256 = %s
            ORDER BY uploaded_at DESC
            LIMIT 1
            """,
            (user_id, source_sha256),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return _get_book_sql(row[0], user_id)


def _get_book_import_cache_sql(source_sha256: str, user_id: str) -> dict[str, Any] | None:
    if not source_sha256:
        return None
    with progress_store_cursor() as cur:
        cur.execute(
            """
            SELECT source_format, cleaned_text, page_count, text_chars, excerpt, updated_at
            FROM book_import_cache
            WHERE user_id = %s
              AND source_sha256 = %s
              AND extraction_version = %s
            """,
            (user_id, source_sha256, BOOK_EXTRACTION_CACHE_VERSION),
        )
        row = cur.fetchone()
    if row is None:
        return None
    source_format, cleaned_text, page_count, text_chars, excerpt, updated_at = row
    return {
        "sourceFormat": source_format,
        "cleanedText": cleaned_text,
        "pageCount": page_count,
        "textCharacters": text_chars,
        "excerpt": excerpt,
        "updatedAt": serialize_timestamp(updated_at),
    }


def _write_book_import_cache_sql(
    *,
    source_sha256: str,
    user_id: str,
    source_format: str,
    cleaned_text: str,
    page_count: int,
) -> None:
    if not source_sha256 or not cleaned_text:
        return
    with progress_store_cursor() as cur:
        cur.execute(
            """
            INSERT INTO book_import_cache (
                user_id, source_sha256, extraction_version, source_format,
                cleaned_text, page_count, text_chars, excerpt, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (user_id, source_sha256, extraction_version) DO UPDATE SET
                source_format = EXCLUDED.source_format,
                cleaned_text = EXCLUDED.cleaned_text,
                page_count = EXCLUDED.page_count,
                text_chars = EXCLUDED.text_chars,
                excerpt = EXCLUDED.excerpt,
                updated_at = now()
            """,
            (
                user_id,
                source_sha256,
                BOOK_EXTRACTION_CACHE_VERSION,
                source_format,
                cleaned_text,
                page_count,
                len(cleaned_text),
                cleaned_text[:260],
            ),
        )


# ── Highlights DB CRUD ────────────────────────────────────────────────────────

def _list_highlights_sql(book_id: str, user_id: str) -> list[dict[str, Any]]:
    with progress_store_cursor() as cur:
        cur.execute(
            """
            SELECT id, start_pos, end_pos, color, kind, text, note, created_at
            FROM highlights
            WHERE book_id = %s AND user_id = %s
            ORDER BY start_pos, created_at
            """,
            (book_id, user_id),
        )
        rows = cur.fetchall()
    result = []
    for (hid, start_pos, end_pos, color, kind, text, note, created_at) in rows:
        result.append({
            "id": hid,
            "start": start_pos,
            "end": end_pos,
            "color": color,
            "kind": kind,
            "text": text,
            "note": note,
            "createdAt": serialize_timestamp(created_at),
        })
    return result


def _insert_highlight_sql(book_id: str, user_id: str, h: dict[str, Any]) -> None:
    created_at = parse_iso_timestamp(h.get("createdAt")) or datetime.now(timezone.utc)
    with progress_store_cursor() as cur:
        cur.execute(
            """
            INSERT INTO highlights (id, book_id, user_id, start_pos, end_pos,
                                    color, kind, text, note, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (book_id, id) DO UPDATE SET
                start_pos = EXCLUDED.start_pos,
                end_pos   = EXCLUDED.end_pos,
                color     = EXCLUDED.color,
                kind      = EXCLUDED.kind,
                text      = EXCLUDED.text,
                note      = EXCLUDED.note
            """,
            (
                h["id"], book_id, user_id,
                h["start"], h["end"],
                h.get("color", "amber"),
                h.get("kind", "highlight"),
                h["text"],
                h.get("note"),
                created_at,
            ),
        )


def _delete_highlight_sql(book_id: str, highlight_id: str, user_id: str) -> bool:
    with progress_store_cursor() as cur:
        cur.execute(
            "DELETE FROM highlights WHERE book_id = %s AND id = %s AND user_id = %s",
            (book_id, highlight_id, user_id),
        )
        return (cur.rowcount or 0) > 0


# ─────────────────────────────────────────────────────────────────────────────

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

    uid = current_user_id()
    try:
        with progress_store_cursor() as cur:
            cur.execute(
                """
                select page_number, total_pages, text_start, text_end, text_length, updated_at
                from reader_progress
                where book_id = %s and (user_id = %s or user_id is null)
                order by (user_id = %s) desc
                limit 1
                """,
                (book_id, uid, uid),
            )
            reading = serialize_reading_progress_row(cur.fetchone())
            cur.execute(
                """
                select audio_url, playback_time, was_playing, updated_at
                from audio_progress
                where book_id = %s and (user_id = %s or user_id is null)
                order by (user_id = %s) desc
                limit 1
                """,
                (book_id, uid, uid),
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

    uid = current_user_id()
    try:
        with progress_store_cursor() as cur:
            cur.execute(
                """
                insert into reader_progress (
                    book_id, user_id,
                    page_number, total_pages,
                    text_start, text_end, text_length, updated_at
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (book_id, user_id) do update
                set
                    page_number = excluded.page_number,
                    total_pages = excluded.total_pages,
                    text_start  = excluded.text_start,
                    text_end    = excluded.text_end,
                    text_length = excluded.text_length,
                    updated_at  = excluded.updated_at
                """,
                (
                    book_id, uid,
                    request.pageNumber, request.totalPages,
                    request.textStart, request.textEnd, request.textLength,
                    updated_at,
                ),
            )
        invalidate_books_cache(uid)
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

    uid = current_user_id()
    try:
        with progress_store_cursor() as cur:
            cur.execute(
                """
                insert into audio_progress (
                    book_id, user_id,
                    audio_url, playback_time, was_playing, updated_at
                )
                values (%s, %s, %s, %s, %s, %s)
                on conflict (book_id, user_id) do update
                set
                    audio_url     = excluded.audio_url,
                    playback_time = excluded.playback_time,
                    was_playing   = excluded.was_playing,
                    updated_at    = excluded.updated_at
                """,
                (
                    book_id, uid,
                    request.audioUrl, request.currentTime, request.wasPlaying,
                    updated_at,
                ),
            )
        invalidate_books_cache(uid)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return payload


def delete_book_audio_progress(book_id: str) -> dict[str, bool]:
    load_book_or_404(book_id)

    if not progress_store_configured():
        return {"ok": True}

    uid = current_user_id()
    try:
        with progress_store_cursor() as cur:
            cur.execute(
                "delete from audio_progress where book_id = %s and (user_id = %s or user_id is null)",
                (book_id, uid),
            )
        invalidate_books_cache(uid)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {"ok": True}


def delete_book_progress_records(book_id: str) -> None:
    if not progress_store_configured():
        return
    # Only called from delete_book_files; when DB path is active, CASCADE on
    # books.id → highlights handles highlights; progress is deleted here.
    uid = _current_user_id.get() or LOCAL_DEV_USER_ID
    try:
        with progress_store_cursor() as cur:
            cur.execute(
                "delete from reader_progress where book_id = %s and (user_id = %s or user_id is null)",
                (book_id, uid),
            )
            cur.execute(
                "delete from audio_progress where book_id = %s and (user_id = %s or user_id is null)",
                (book_id, uid),
            )
    except RuntimeError:
        return


def relative_url(path: Path) -> str:
    return f"/library/{path.relative_to(DATA_ROOT).as_posix()}"


def relative_url_or_none(path: Path) -> str | None:
    try:
        return relative_url(path)
    except ValueError:
        return None


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


def book_storage_enabled() -> bool:
    return BOOK_STORAGE_BUCKET is not None


def storage_key(*parts: str) -> str:
    cleaned = [part.strip("/") for part in parts if part and part.strip("/")]
    if BOOK_STORAGE_PREFIX:
        cleaned.insert(0, BOOK_STORAGE_PREFIX)
    return "/".join(cleaned)


def book_storage_base_prefix(book_id: str) -> str:
    uid = _current_user_id.get() or LOCAL_DEV_USER_ID
    return storage_key("books", uid, book_id)


def book_source_storage_key(book_id: str, suffix: str = ".pdf") -> str:
    clean_suffix = suffix if suffix.startswith(".") else f".{suffix}"
    if clean_suffix.lower() not in SUPPORTED_BOOK_EXTENSIONS:
        clean_suffix = ".book"
    return f"{book_storage_base_prefix(book_id)}/source{clean_suffix.lower()}"


def book_meta_storage_key(book_id: str) -> str:
    return f"{book_storage_base_prefix(book_id)}/meta.json"


def book_text_storage_key(book_id: str) -> str:
    return f"{book_storage_base_prefix(book_id)}/cleaned.txt"


def book_live_audio_storage_key(book_id: str, file_name: str) -> str:
    return f"{book_storage_base_prefix(book_id)}/live-audio/{file_name}"


def book_highlights_storage_key(book_id: str) -> str:
    return f"{book_storage_base_prefix(book_id)}/highlights.json"


def preview_audio_storage_key(file_name: str) -> str:
    return storage_key("previews", file_name)


def read_storage_bytes(key: str) -> bytes | None:
    if not BOOK_STORAGE_BUCKET:
        raise RuntimeError("BOOK_STORAGE_BUCKET is not configured.")

    client = create_book_storage_client()
    _, _, _, ClientError, _, _, _ = load_boto3()

    try:
        response = client.get_object(Bucket=BOOK_STORAGE_BUCKET, Key=key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise RuntimeError(f"Failed to read book storage object {key}: {exc}") from exc

    return response["Body"].read()


def write_storage_bytes(key: str, payload: bytes, *, content_type: str) -> None:
    if not BOOK_STORAGE_BUCKET:
        raise RuntimeError("BOOK_STORAGE_BUCKET is not configured.")

    client = create_book_storage_client()
    try:
        client.put_object(
            Bucket=BOOK_STORAGE_BUCKET,
            Key=key,
            Body=payload,
            ContentType=content_type,
        )
    except Exception as exc:
        raise RuntimeError(f"Failed to write book storage object {key}: {exc}") from exc


def read_storage_json(key: str) -> dict[str, Any] | None:
    payload = read_storage_bytes(key)
    if payload is None:
        return None
    return json.loads(payload.decode("utf-8"))


def write_storage_json(key: str, payload: dict[str, Any]) -> None:
    write_storage_bytes(key, json.dumps(payload, indent=2).encode("utf-8"), content_type="application/json")


def list_storage_meta_payloads() -> list[dict[str, Any]]:
    if not BOOK_STORAGE_BUCKET:
        return []

    from concurrent.futures import ThreadPoolExecutor, as_completed

    client = create_book_storage_client()
    prefix = f"{storage_key('books')}/"
    paginator = client.get_paginator("list_objects_v2")
    meta_keys: list[str] = []

    try:
        for page in paginator.paginate(Bucket=BOOK_STORAGE_BUCKET, Prefix=prefix):
            for item in page.get("Contents", []):
                key = str(item.get("Key", ""))
                if key.endswith("/meta.json"):
                    meta_keys.append(key)
    except Exception as exc:
        raise RuntimeError(f"Failed to list stored books: {exc}") from exc

    if not meta_keys:
        return []

    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(16, len(meta_keys))) as executor:
        futures = {executor.submit(read_storage_json, key): key for key in meta_keys}
        for future in as_completed(futures):
            payload = future.result()
            if payload is not None:
                results.append(payload)
    return results


def delete_storage_prefix(prefix: str) -> None:
    if not BOOK_STORAGE_BUCKET:
        return

    client = create_book_storage_client()
    paginator = client.get_paginator("list_objects_v2")
    keys: list[dict[str, str]] = []

    for page in paginator.paginate(Bucket=BOOK_STORAGE_BUCKET, Prefix=prefix.rstrip("/") + "/"):
        for item in page.get("Contents", []):
            key = item.get("Key")
            if key:
                keys.append({"Key": str(key)})

    if not keys:
        return

    for start in range(0, len(keys), 1000):
        batch = keys[start : start + 1000]
        client.delete_objects(Bucket=BOOK_STORAGE_BUCKET, Delete={"Objects": batch, "Quiet": True})


def download_storage_object(key: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    client = create_book_storage_client()
    _, _, _, ClientError, _, _, _ = load_boto3()
    try:
        client.download_file(BOOK_STORAGE_BUCKET, key, str(destination))
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            raise FileNotFoundError(key) from exc
        raise RuntimeError(f"Failed to download book storage object {key}: {exc}") from exc


def copy_storage_object(source_key: str, destination_key: str) -> None:
    if not BOOK_STORAGE_BUCKET:
        raise RuntimeError("BOOK_STORAGE_BUCKET is not configured.")
    if source_key == destination_key:
        return

    client = create_book_storage_client()
    _, _, _, ClientError, _, _, _ = load_boto3()
    try:
        client.copy_object(
            Bucket=BOOK_STORAGE_BUCKET,
            CopySource={"Bucket": BOOK_STORAGE_BUCKET, "Key": source_key},
            Key=destination_key,
        )
    except ClientError as exc:
        raise RuntimeError(f"Failed to copy book storage object {source_key} to {destination_key}: {exc}") from exc


def read_book_meta(book_id: str) -> dict[str, Any] | None:
    if progress_store_configured():
        return _get_book_sql(book_id, current_user_id())
    if book_storage_enabled():
        return read_storage_json(book_meta_storage_key(book_id))
    path = book_meta_path(book_id)
    if not path.exists():
        return None
    return read_json(path)


def write_book_meta(book_id: str, payload: dict[str, Any]) -> None:
    if progress_store_configured():
        _upsert_book_sql(payload, current_user_id())
        return
    if book_storage_enabled():
        write_storage_json(book_meta_storage_key(book_id), payload)
        return
    write_json(book_meta_path(book_id), payload)


def read_book_text_cache_sql(book_id: str, user_id: str) -> str | None:
    with progress_store_cursor() as cur:
        cur.execute(
            """
            SELECT text_content
            FROM book_text_cache
            WHERE book_id = %s AND user_id = %s
            """,
            (book_id, user_id),
        )
        row = cur.fetchone()
    return row[0] if row else None


def write_book_text_cache_sql(book_id: str, user_id: str, text: str) -> None:
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    with progress_store_cursor() as cur:
        cur.execute(
            """
            INSERT INTO book_text_cache (book_id, user_id, text_content, content_sha256, updated_at)
            VALUES (%s, %s, %s, %s, now())
            ON CONFLICT (book_id, user_id) DO UPDATE SET
                text_content = EXCLUDED.text_content,
                content_sha256 = EXCLUDED.content_sha256,
                updated_at = now()
            """,
            (book_id, user_id, text, digest),
        )


def read_book_text(book_id: str) -> str:
    uid: str | None = None
    if progress_store_configured():
        uid = current_user_id()
        try:
            cached_text = read_book_text_cache_sql(book_id, uid)
        except RuntimeError as exc:
            logger.warning("Skipping book text cache lookup for %s: %s", book_id, exc)
            cached_text = None
        if cached_text is not None:
            return cached_text

    try:
        if book_storage_enabled():
            payload = read_storage_bytes(book_text_storage_key(book_id))
            if payload is None:
                raise FileNotFoundError(book_id)
            text = payload.decode("utf-8")
        else:
            text = book_text_path(book_id).read_text(encoding="utf-8")
    except FileNotFoundError:
        meta = read_book_meta(book_id)
        if meta is None:
            raise
        text = recover_book_text_from_source(book_id, meta, user_id=uid)

    if progress_store_configured() and uid is not None:
        try:
            write_book_text_cache_sql(book_id, uid, text)
        except RuntimeError as exc:
            logger.warning("Skipping book text cache write for %s: %s", book_id, exc)
    return text


def write_book_text(book_id: str, text: str) -> None:
    if progress_store_configured():
        try:
            write_book_text_cache_sql(book_id, current_user_id(), text)
        except RuntimeError as exc:
            logger.warning("Skipping book text cache write for %s: %s", book_id, exc)

    if book_storage_enabled():
        write_storage_bytes(book_text_storage_key(book_id), text.encode("utf-8"), content_type="text/plain; charset=utf-8")
        return

    path = book_text_path(book_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def recover_book_text_from_source(book_id: str, meta: dict[str, Any], *, user_id: str | None = None) -> str:
    file_name = str(meta.get("fileName") or f"book.{meta.get('sourceFormat') or 'pdf'}")
    suffix = normalize_book_suffix(file_name)
    source_sha256 = meta.get("sourceSha256")
    if isinstance(source_sha256, str):
        cached_import = read_book_import_cache_safely(source_sha256, user_id)
        if cached_import is not None:
            text = str(cached_import["cleanedText"])
            write_book_text(book_id, text)
            return text
    else:
        source_sha256 = None

    source_storage = meta.get("sourceStorage")
    temp_root = RUNTIME_ROOT / "direct-imports"
    temp_root.mkdir(parents=True, exist_ok=True)

    def finish_recovery(path: Path) -> str:
        computed_sha = source_sha256 or sha256_file(path)
        extracted = extract_cleaned_book_source(
            file_name,
            path,
            source_sha256=computed_sha,
            user_id=user_id,
        )
        text = str(extracted["text"])
        meta["pageCount"] = int(extracted["pageCount"])
        meta["textCharacters"] = len(text)
        meta["excerpt"] = text[:260]
        meta["sourceSha256"] = computed_sha
        meta["sourceFormat"] = str(extracted["sourceFormat"])
        try:
            write_book_meta(book_id, meta)
        except Exception as exc:
            logger.warning("Failed to refresh recovered book metadata for %s: %s", book_id, exc)
        write_book_text(book_id, text)
        return text

    if isinstance(source_storage, dict):
        key = source_storage.get("key")
        if isinstance(key, str) and key:
            with tempfile.TemporaryDirectory(prefix="storybook_recover_", dir=str(temp_root)) as temp_dir:
                temp_source = Path(temp_dir) / f"source{suffix}"
                download_storage_object(key, temp_source)
                return finish_recovery(temp_source)

    source_path = resolve_local_source_path(meta)
    if source_path.exists():
        return finish_recovery(source_path)

    raise FileNotFoundError(book_id)


def ensure_existing_book_text_from_upload(
    existing: dict[str, Any],
    uploaded_source_path: Path,
    file_name: str,
    source_sha256: str,
    source_storage: dict[str, str] | None = None,
) -> None:
    book_id = str(existing["id"])
    if source_storage is not None:
        existing["sourceStorage"] = source_storage
        existing.pop("sourcePath", None)
        existing["sourceSha256"] = source_sha256
        existing["sourceFormat"] = normalize_book_suffix(file_name).lstrip(".")

    try:
        read_book_text(book_id)
        if source_storage is not None:
            write_book_meta(book_id, existing)
        return
    except FileNotFoundError:
        pass

    uid = current_user_id() if progress_store_configured() else None
    extracted = extract_cleaned_book_source(
        file_name,
        uploaded_source_path,
        source_sha256=source_sha256,
        user_id=uid,
    )
    text = str(extracted["text"])
    existing["pageCount"] = int(extracted["pageCount"])
    existing["textCharacters"] = len(text)
    existing["excerpt"] = text[:260]
    existing["sourceSha256"] = source_sha256
    existing["sourceFormat"] = str(extracted["sourceFormat"])
    write_book_meta(book_id, existing)
    write_book_text(book_id, text)


def has_servable_book_source(meta: dict[str, Any]) -> bool:
    source_storage = meta.get("sourceStorage")
    if isinstance(source_storage, dict) and isinstance(source_storage.get("key"), str) and source_storage.get("key"):
        return True

    source_path = resolve_local_source_path(meta)
    if relative_url_or_none(source_path) is None:
        return False
    return source_path.exists()


def source_url_for_book(meta: dict[str, Any]) -> str:
    source_storage = meta.get("sourceStorage")
    if isinstance(source_storage, dict) and isinstance(source_storage.get("key"), str) and source_storage.get("key"):
        return f"/api/books/{meta['id']}/source"

    source_path = resolve_local_source_path(meta)
    local_url = relative_url_or_none(source_path)
    if local_url is not None:
        return local_url

    logger.warning("Book %s has a non-runtime local source path: %s", meta.get("id"), source_path)
    return f"/api/books/{meta['id']}/source"


def resolve_local_source_path(meta: dict[str, Any]) -> Path:
    source_path = meta.get("sourcePath")
    if isinstance(source_path, str) and source_path:
        return Path(source_path)

    suffix = Path(str(meta.get("fileName") or "book.pdf")).suffix.lower() or ".pdf"
    return book_dir(str(meta["id"])) / f"source{suffix}"


def list_book_meta_payloads() -> list[dict[str, Any]]:
    if progress_store_configured():
        return _list_books_sql(current_user_id())
    if book_storage_enabled():
        return list_storage_meta_payloads()
    results: list[dict[str, Any]] = []
    for meta_file in BOOKS_ROOT.glob("*/meta.json"):
        results.append(read_json(meta_file))
    return results


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




def load_boto3():
    try:
        import boto3
        from botocore.config import Config
        from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError, NoRegionError, ProfileNotFound
    except ImportError as exc:
        raise RuntimeError("S3 storage support requires boto3. Reinstall with `pip install -r requirements.txt`.") from exc

    return boto3, Config, BotoCoreError, ClientError, NoCredentialsError, NoRegionError, ProfileNotFound


def kokoro_configured() -> bool:
    """True when a remote Kokoro server URL is configured."""
    return bool(KOKORO_REMOTE_URL)


_KOKORO_ABBREVS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r'\bMr\.(?=\s)', re.IGNORECASE), 'Mister'),
    (re.compile(r'\bMrs\.(?=\s)', re.IGNORECASE), 'Misses'),
    (re.compile(r'\bMs\.(?=\s)', re.IGNORECASE), 'Miss'),
    (re.compile(r'\bDr\.(?=\s)', re.IGNORECASE), 'Doctor'),
    (re.compile(r'\bProf\.(?=\s)', re.IGNORECASE), 'Professor'),
    (re.compile(r'\bSt\.(?=\s)', re.IGNORECASE), 'Saint'),
    (re.compile(r'\bvs\.', re.IGNORECASE), 'versus'),
    (re.compile(r'\betc\.', re.IGNORECASE), 'et cetera'),
    (re.compile(r'\be\.g\.', re.IGNORECASE), 'for example'),
    (re.compile(r'\bi\.e\.', re.IGNORECASE), 'that is'),
]


def preprocess_kokoro_text(text: str) -> str:
    """Expand abbreviations and normalize punctuation for more natural Kokoro output."""
    for pattern, replacement in _KOKORO_ABBREVS:
        text = pattern.sub(replacement, text)
    # Em-dash / en-dash → natural comma pause
    text = re.sub(r'\s*[—–]\s*', ', ', text)
    # Ellipsis → single comma (preserves pace without an abrupt stop)
    text = re.sub(r'\.{2,}', ',', text)
    # Curly quotes → ASCII quotes
    text = text.replace('“', '"').replace('”', '"')
    text = text.replace('‘', "'").replace('’', "'")
    # Miscellaneous unicode bullets / middle-dots → period
    text = text.replace('·', '.').replace('•', '.').replace('…', ',')
    return text


def _concat_wavs(wav_paths: list[Path], output_path: Path, *, silence_seconds: float = 0.3) -> None:
    """Concatenate WAV files into output_path, inserting silence_seconds between each."""
    if not wav_paths:
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(wav_paths[0]), 'rb') as ref:
        params = ref.getparams()
        nchannels = ref.getnchannels()
        sampwidth = ref.getsampwidth()
        framerate = ref.getframerate()
    silence_frames = b'\x00' * int(silence_seconds * framerate * nchannels * sampwidth)
    with wave.open(str(output_path), 'wb') as out:
        out.setparams(params)
        for i, path in enumerate(wav_paths):
            with wave.open(str(path), 'rb') as w:
                out.writeframes(w.readframes(w.getnframes()))
            if i < len(wav_paths) - 1:
                out.writeframes(silence_frames)


def _synthesize_kokoro_parallel_sentences(
    text: str,
    voice: str,
    speed: float,
    output_path: Path,
    *,
    sentence_silence: float = 0.3,
) -> None:
    """Split text into sentences, synthesize each in parallel, concatenate with silence."""
    preprocessed = preprocess_kokoro_text(text)
    sentences: list[str] = []
    for para in split_tts_paragraphs(preprocessed):
        sentences.extend(split_tts_sentences(para))
    sentences = [s for s in sentences if s.strip()]
    if not sentences:
        sentences = [preprocessed.strip()]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_dir = output_path.parent / f".{output_path.stem}-sentences"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        wav_paths = [tmp_dir / f"s{i:04d}.wav" for i in range(len(sentences))]

        def _synth_one(args: tuple[str, Path]) -> None:
            sentence_text, path = args
            synthesize_kokoro_remote(sentence_text, voice, speed, path)

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(_synth_one, list(zip(sentences, wav_paths))))

        existing = [p for p in wav_paths if p.exists() and p.stat().st_size > 0]
        if not existing:
            raise RuntimeError("All Kokoro sentence synthesis attempts failed.")
        _concat_wavs(existing, output_path, silence_seconds=sentence_silence)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def synthesize_kokoro_remote(
    text: str,
    voice: str,
    speed: float,
    output_path: Path,
) -> None:
    """Call the remote Kokoro server, receive WAV bytes, write to output_path."""
    url = f"{KOKORO_REMOTE_URL}/v1/synthesize"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if KOKORO_REMOTE_API_KEY:
        headers["X-Api-Key"] = KOKORO_REMOTE_API_KEY

    with httpx.Client(timeout=KOKORO_REMOTE_TIMEOUT_SECONDS) as client:
        response = client.post(url, json={"text": text, "voice": voice, "speed": speed}, headers=headers)

    if response.status_code != 200:
        try:
            detail = response.json().get("detail", response.text[:200])
        except Exception:
            detail = response.text[:200]
        raise RuntimeError(f"Remote Kokoro server returned {response.status_code}: {detail}")

    if not response.content:
        raise RuntimeError("Remote Kokoro server returned an empty response.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(response.content)


def create_aws_session(*, region_name: str | None = None):
    boto3, _, _, _, _, _, ProfileNotFound = load_boto3()

    session_kwargs: dict[str, Any] = {}
    if region_name:
        session_kwargs["region_name"] = region_name
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


def regional_book_storage_api_url() -> str:
    if BOOK_STORAGE_ENDPOINT:
        return BOOK_STORAGE_ENDPOINT
    if not BOOK_STORAGE_REGION or BOOK_STORAGE_REGION == "us-east-1":
        return "https://s3.amazonaws.com"
    return f"https://s3.{BOOK_STORAGE_REGION}.amazonaws.com"


def create_book_storage_client():
    global _book_storage_client
    if _book_storage_client is not None:
        return _book_storage_client
    with _book_storage_client_lock:
        if _book_storage_client is not None:
            return _book_storage_client
        session = create_aws_session(region_name=BOOK_STORAGE_REGION)
        _, Config, _, _, _, _, _ = load_boto3()
        client_config = Config(
            connect_timeout=3,
            read_timeout=60,
            retries={"max_attempts": 1},
            s3={"addressing_style": BOOK_STORAGE_ADDRESSING_STYLE},
        )
        _book_storage_client = session.client(
            "s3",
            config=client_config,
            endpoint_url=regional_book_storage_api_url(),
        )
    return _book_storage_client


def generate_book_storage_download_url(key: str, *, expires_in: int = 3600) -> str:
    if not BOOK_STORAGE_BUCKET:
        raise RuntimeError("BOOK_STORAGE_BUCKET is not configured.")

    client = create_book_storage_client()
    try:
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": BOOK_STORAGE_BUCKET, "Key": key},
            ExpiresIn=expires_in,
        )
    except Exception as exc:
        raise RuntimeError(f"Failed to prepare a download URL for {key}: {exc}") from exc


def regional_book_storage_upload_url() -> str:
    if not BOOK_STORAGE_BUCKET:
        raise RuntimeError("BOOK_STORAGE_BUCKET is not configured.")
    if not BOOK_STORAGE_REGION or BOOK_STORAGE_REGION == "us-east-1":
        return f"https://{BOOK_STORAGE_BUCKET}.s3.amazonaws.com/"
    return f"https://{BOOK_STORAGE_BUCKET}.s3.{BOOK_STORAGE_REGION}.amazonaws.com/"


def provider_catalog() -> list[dict[str, Any]]:
    return [
        {
            "id": "kokoro",
            "name": "Kokoro TTS",
            "available": kokoro_configured(),
            "recommended": kokoro_configured(),
            "description": (
                "High-quality open-source neural TTS via a remote Kokoro server. "
                "Free, no API key required. Natural narration voices."
            ),
            "voices": KOKORO_VOICES,
            "defaultVoice": "af_heart",
            "models": [],
            "defaultModel": None,
            "voiceMetaNote": "Kokoro voices are fixed (no cloning). af_heart and bm_george are recommended for narration.",
        },
        {
            "id": "google",
            "name": "Google Gemini TTS",
            "available": bool(env_value("GEMINI_API_KEY")),
            "recommended": True,
            "description": "Preview Gemini audiobook-style TTS with a free tier and promptable delivery style.",
            "voices": GEMINI_VOICES,
            "defaultVoice": "Kore",
            "models": GEMINI_TTS_MODELS,
            "defaultModel": resolve_google_tts_model(None),
            "voiceMetaNote": "Gender tags are estimated for Gemini voices. Style labels come from Google voice demos.",
        },
    ]


def provider_details(provider_id: str) -> dict[str, Any]:
    for provider in provider_catalog():
        if provider["id"] == provider_id:
            return provider
    raise HTTPException(status_code=404, detail="Provider not found.")


def read_highlights(book_id: str) -> list[dict[str, Any]]:
    if book_storage_enabled():
        payload = read_storage_json(book_highlights_storage_key(book_id)) or {"items": []}
    else:
        path = book_highlights_path(book_id)
        if not path.exists():
            return []
        payload = read_json(path)
    items = payload.get("items")
    if isinstance(items, list):
        return items
    return []


def write_highlights(book_id: str, items: list[dict[str, Any]]) -> None:
    payload = {"items": items}
    if book_storage_enabled():
        write_storage_json(book_highlights_storage_key(book_id), payload)
        return

    write_json(book_highlights_path(book_id), payload)


def normalize_highlight_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def is_single_word_highlight_text(value: str) -> bool:
    normalized = normalize_highlight_text(value)
    return bool(normalized) and len(normalized.split()) == 1


def resolve_highlight_kind(
    kind: str | None,
    *,
    text: str,
    note: str | None = None,
) -> Literal["highlight", "note", "vocabulary"]:
    single_word = is_single_word_highlight_text(text)
    return "vocabulary" if single_word else "note"


def serialize_highlight(item: dict[str, Any]) -> dict[str, Any]:
    selected_text = item.get("text", "")
    note = item.get("note")
    kind = resolve_highlight_kind(item.get("kind"), text=selected_text, note=note)
    return {
        "id": item["id"],
        "start": item["start"],
        "end": item["end"],
        "color": item["color"],
        "kind": kind,
        "text": item["text"],
        "note": note,
        "createdAt": item["createdAt"],
    }


def list_highlights(book_id: str) -> list[dict[str, Any]]:
    if progress_store_configured():
        return _list_highlights_sql(book_id, current_user_id())
    items = [serialize_highlight(item) for item in read_highlights(book_id)]
    items.sort(key=lambda item: (item["start"], item["createdAt"]))
    return items


def serialize_book(meta: dict[str, Any]) -> dict[str, Any]:
    latest_audio = meta.get("latestAudio")
    if latest_audio:
        path_val = latest_audio.get("path")
        timing_val = latest_audio.get("timingPath")
        audio_url = relative_url_or_none(Path(path_val)) if path_val else None
        timing_url = relative_url_or_none(Path(timing_val)) if timing_val else None
        latest_audio = {
            **latest_audio,
            "url": audio_url or latest_audio.get("url", ""),
            "timingUrl": timing_url,
        }

    # _highlightCount is pre-computed by SQL JOIN in _book_row_to_meta;
    # fall back to counting from storage for legacy/local paths.
    if "_highlightCount" in meta:
        highlight_count = meta["_highlightCount"]
    else:
        highlight_count = len(read_highlights(meta["id"]))

    return {
        "id": meta["id"],
        "title": meta["title"],
        "fileName": meta["fileName"],
        "uploadedAt": meta["uploadedAt"],
        "pageCount": meta["pageCount"],
        "textCharacters": meta["textCharacters"],
        "sourceUrl": source_url_for_book(meta),
        "excerpt": meta["excerpt"],
        "highlightCount": highlight_count,
        "latestAudio": latest_audio,
        "readingProgress": meta.get("_readingProgress"),
        "audioProgress": meta.get("_audioProgress"),
        "sourceFormat": meta.get("sourceFormat"),
    }


def invalidate_books_cache(user_id: str | None = None) -> None:
    with _books_cache_lock:
        if user_id:
            _books_cache.pop(user_id, None)
        else:
            _books_cache.clear()


def list_books() -> list[dict[str, Any]]:
    # No in-process cache: on Vercel each lambda is its own process, so a
    # cache hit on lambda A wouldn't be invalidated by an upload that ran on
    # lambda B — newly uploaded books would be invisible for up to one TTL.
    # The DB-backed listing is a single indexed SELECT, cheap enough.
    current_user_id()  # keep auth-required behavior
    books = [serialize_book(meta) for meta in list_book_meta_payloads()]
    books.sort(key=lambda item: item["uploadedAt"], reverse=True)
    return books


def parse_iso_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def continue_book_payload() -> dict[str, Any] | None:
    books = list_books()
    best_book: dict[str, Any] | None = None
    best_progress: dict[str, Any] | None = None
    best_sort_key: tuple[int, datetime] | None = None

    for book in books:
        progress = book_progress_payload(book["id"])
        reading = progress.get("reading")
        audio = progress.get("audio")
        reading_updated = parse_iso_timestamp(reading.get("updatedAt")) if reading else None
        audio_updated = parse_iso_timestamp(audio.get("updatedAt")) if audio else None
        uploaded_at = parse_iso_timestamp(book.get("uploadedAt")) or datetime.fromtimestamp(0, tz=timezone.utc)
        activity_time = max(
            [timestamp for timestamp in (reading_updated, audio_updated, uploaded_at) if timestamp is not None],
            default=uploaded_at,
        )
        activity_score = 2 if reading or audio else 1 if book.get("latestAudio") else 0
        sort_key = (activity_score, activity_time)
        if best_sort_key is None or sort_key > best_sort_key:
            best_book = book
            best_progress = progress
            best_sort_key = sort_key

    if best_book is None:
        return None

    reading = best_progress.get("reading") if best_progress else None
    completion_ratio = 0.0
    if reading and reading.get("textLength"):
        completion_ratio = min(1.0, max(0.0, float(reading.get("textEnd", 0)) / float(reading["textLength"])))
    elif reading and reading.get("totalPages"):
        completion_ratio = min(1.0, max(0.0, float(reading.get("pageNumber", 1)) / float(reading["totalPages"])))

    return {
        "book": best_book,
        "progress": best_progress,
        "completionRatio": round(completion_ratio, 4),
        "ctaLabel": "Resume chapter" if reading else "Open book",
    }


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


def prepare_synthesis_chunks(text: str, provider: str, requested: int | None) -> list[str]:
    chunk_size = clamp_chunk_size(provider, requested)
    return pdf_to_audio.chunk_text(text, chunk_size)


def prepare_live_synthesis_chunks(text: str, provider: str) -> list[str]:
    if provider == "kokoro":
        # Kokoro handles up to ~1000 chars well; larger chunks = fewer round-trips
        return prepare_synthesis_chunks(text, provider, 800)
    return prepare_synthesis_chunks(text, provider, None)


def _chunk_text_for_presynth(text: str, chunk_size: int = 420) -> list[dict[str, Any]]:
    """Split full book text into sentence-aware grid chunks for background presynthesis.

    Prefers ending each chunk at a real sentence boundary (.!? followed by whitespace)
    within ±40% of the target size, so the TTS engine doesn't add end-of-utterance
    prosody at chunk seams that fall mid-sentence. Falls back to a word boundary,
    then to a hard cut. Must stay byte-for-byte identical to the frontend grid
    chunker (web-next/src/features/reader/ReaderRoute.tsx) so cache keys line up.
    """
    chunks: list[dict[str, Any]] = []
    text_len = len(text)
    min_size = max(1, int(chunk_size * 0.5))
    max_size = int(chunk_size * 1.4)
    pos = 0
    while pos < text_len:
        end = min(pos + chunk_size, text_len)
        if end < text_len:
            search_start = pos + min_size
            search_end = min(pos + max_size, text_len)
            boundary = -1
            i = search_end - 1
            while i >= search_start:
                ch = text[i]
                if ch in ".!?":
                    nxt = text[i + 1] if i + 1 < text_len else " "
                    if nxt.isspace():
                        boundary = i + 2
                        break
                i -= 1
            if 0 < boundary <= text_len:
                end = boundary
            elif not text[end].isspace():
                ws = text.rfind(" ", pos, end)
                if ws > pos:
                    end = ws + 1
        chunk_text = text[pos:end]
        if chunk_text.strip():
            chunks.append({"start": pos, "end": end, "text": chunk_text})
        pos = max(end, pos + 1)
    return [c for c in chunks if c["text"].strip()]


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


def build_audio_timing_manifest(
    text: str,
    chunks: list[str],
    chunk_wavs: list[Path],
    *,
    audio_url: str,
    source_offset: int = 0,
) -> dict[str, Any]:
    return build_audio_timing_manifest_from_durations(
        text,
        chunks,
        [max(0.0, wav_duration_seconds(chunk_wav)) for chunk_wav in chunk_wavs],
        audio_url=audio_url,
        source_offset=source_offset,
    )


def estimate_chunk_durations(chunks: list[str], total_duration: float) -> list[float]:
    if not chunks:
        return []

    safe_total = max(0.0, total_duration)
    if safe_total == 0.0:
        return [0.0 for _ in chunks]

    weights = [estimate_timing_weight(chunk) for chunk in chunks]
    total_weight = sum(weights) or float(len(chunks))
    durations = [safe_total * (weight / total_weight) for weight in weights]
    if durations:
        durations[-1] = max(0.0, safe_total - sum(durations[:-1]))
    return durations


def build_audio_timing_manifest_from_durations(
    text: str,
    chunks: list[str],
    chunk_durations: list[float],
    *,
    audio_url: str,
    source_offset: int = 0,
) -> dict[str, Any]:
    sentence_spans = build_text_sentence_spans(text)
    chunk_spans = map_chunks_to_text_spans(text, chunks)
    cues: list[dict[str, Any]] = []
    time_cursor = 0.0
    total_duration = 0.0

    for chunk_span, chunk_duration in zip(chunk_spans, chunk_durations):
        chunk_duration = max(0.0, float(chunk_duration))
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
                    "start": source_offset + int(segment["start"]),
                    "end": source_offset + int(segment["end"]),
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


def normalize_chunk_wav(wav_path: Path, *, ffmpeg_exe: Path) -> None:
    normalized_path = wav_path.with_name(f"{wav_path.stem}.normalized.wav")
    pdf_to_audio.normalize_wav_with_ffmpeg(
        wav_path,
        ffmpeg_exe=ffmpeg_exe,
        output_path=normalized_path,
        sample_rate=CANONICAL_WAV_SAMPLE_RATE,
    )
    normalized_path.replace(wav_path)


def concat_provider_audio_chunks(
    wav_paths: list[Path],
    *,
    ffmpeg_exe: Path,
    output_path: Path,
    output_format: str,
) -> None:
    if not wav_paths:
        raise RuntimeError("No audio chunks were generated for concatenation.")
    pdf_to_audio.concat_with_ffmpeg(
        wav_paths,
        ffmpeg_exe=ffmpeg_exe,
        output_path=output_path,
        codec=output_format,
    )


def restore_file_from_storage(key: str, destination: Path) -> bool:
    payload = read_storage_bytes(key)
    if payload is None:
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)
    return True


def cleanup_preview_files(limit: int = 20) -> None:
    previews = sorted(PREVIEW_ROOT.glob("provider-test-*.wav"), key=lambda path: path.stat().st_mtime, reverse=True)
    for stale_file in previews[limit:]:
        stale_file.unlink(missing_ok=True)


def normalize_book_suffix(file_name: str) -> str:
    suffix = Path(file_name).suffix.lower()
    if suffix not in SUPPORTED_BOOK_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported book format. Upload one of: {SUPPORTED_BOOK_FORMAT_LABEL}.",
        )
    return suffix


def book_content_type_for_suffix(suffix: str, fallback: str | None = None) -> str:
    if fallback and fallback.strip() and fallback != "application/octet-stream":
        return fallback.strip()
    return SUPPORTED_BOOK_EXTENSIONS.get(suffix.lower(), "application/octet-stream")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def book_format_label_for_suffix(suffix: str) -> str:
    normalized = suffix.lower().lstrip(".")
    return {
        "pdf": "PDF",
        "epub": "EPUB",
        "txt": "text",
        "md": "Markdown",
        "markdown": "Markdown",
        "html": "HTML",
        "htm": "HTML",
        "xhtml": "XHTML",
        "docx": "DOCX",
    }.get(normalized, normalized.upper() or "book")


def read_book_import_cache_safely(source_sha256: str | None, user_id: str | None) -> dict[str, Any] | None:
    if not source_sha256 or not user_id:
        return None
    try:
        return _get_book_import_cache_sql(source_sha256, user_id)
    except RuntimeError as exc:
        logger.warning("Skipping book import cache lookup for %s: %s", source_sha256[:12], exc)
        return None


def write_book_import_cache_safely(
    *,
    source_sha256: str | None,
    user_id: str | None,
    source_format: str,
    cleaned_text: str,
    page_count: int,
) -> None:
    if not source_sha256 or not user_id:
        return
    try:
        _write_book_import_cache_sql(
            source_sha256=source_sha256,
            user_id=user_id,
            source_format=source_format,
            cleaned_text=cleaned_text,
            page_count=page_count,
        )
    except RuntimeError as exc:
        logger.warning("Skipping book import cache write for %s: %s", source_sha256[:12], exc)


def extract_cleaned_book_source(
    file_name: str,
    source_path: Path,
    *,
    source_sha256: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    suffix = normalize_book_suffix(file_name)
    source_format = suffix.lstrip(".")
    cached_import = read_book_import_cache_safely(source_sha256, user_id)
    if cached_import is not None:
        cleaned_text = str(cached_import["cleanedText"])
        page_count = int(cached_import["pageCount"])
        return {
            "text": cleaned_text,
            "pageCount": page_count,
            "sourceFormat": str(cached_import.get("sourceFormat") or source_format),
            "cached": True,
        }

    try:
        extracted = pdf_to_audio.extract_book_text(source_path)
    except Exception as exc:
        label = book_format_label_for_suffix(suffix)
        logger.exception("Failed to extract text from uploaded %s file %s", label, file_name)
        raise HTTPException(
            status_code=422,
            detail=(
                f"Could not extract readable text from this {label} file. "
                "Check that the file is not corrupt, password-protected, DRM-protected, or image-only."
            ),
        ) from exc

    cleaned_text = pdf_to_audio.clean_text(extracted.text)
    if not cleaned_text:
        raise HTTPException(
            status_code=422,
            detail="No extractable text was found in this file. Scanned PDFs need OCR first, and DRM-protected ebooks must be converted before upload.",
        )

    page_count = extracted.page_count or pdf_to_audio.estimate_page_count(cleaned_text)
    if page_count <= 0:
        page_count = pdf_to_audio.estimate_page_count(cleaned_text)
    source_format = extracted.format or source_format

    write_book_import_cache_safely(
        source_sha256=source_sha256,
        user_id=user_id,
        source_format=source_format,
        cleaned_text=cleaned_text,
        page_count=page_count,
    )
    return {
        "text": cleaned_text,
        "pageCount": page_count,
        "sourceFormat": source_format,
        "cached": False,
    }


def load_book_or_404(book_id: str) -> dict[str, Any]:
    payload = read_book_meta(book_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Book not found.")
    return payload


def import_book_source(
    book_id: str,
    file_name: str,
    source_path: Path,
    *,
    source_storage: dict[str, str] | None = None,
    source_sha256: str | None = None,
    title_override: str | None = None,
) -> dict[str, Any]:
    suffix = normalize_book_suffix(file_name)
    uid = current_user_id() if progress_store_configured() else None
    try:
        extracted = extract_cleaned_book_source(
            file_name,
            source_path,
            source_sha256=source_sha256,
            user_id=uid,
        )
        cleaned_text = str(extracted["text"])
        page_count = int(extracted["pageCount"])
        source_format = str(extracted["sourceFormat"])
    except HTTPException:
        if not book_storage_enabled():
            shutil.rmtree(book_dir(book_id), ignore_errors=True)
        raise

    title = resolve_book_title(title_override, file_name)
    meta = {
        "id": book_id,
        "title": title,
        "fileName": file_name,
        "uploadedAt": utc_now(),
        "pageCount": page_count,
        "textCharacters": len(cleaned_text),
        "excerpt": cleaned_text[:260],
        "latestAudio": None,
        "audioHistory": [],
        "sourceSha256": source_sha256,
        "sourceFormat": source_format,
        "_highlightCount": 0,
    }
    if source_storage:
        meta["sourceStorage"] = source_storage
    else:
        meta["sourcePath"] = str(source_path.resolve())

    try:
        write_book_meta(book_id, meta)
        write_book_text(book_id, cleaned_text)
    except Exception:
        if progress_store_configured():
            try:
                _delete_book_sql(book_id, current_user_id())
            except Exception:
                logger.exception("Failed to roll back book metadata for %s after import error", book_id)
        raise

    try:
        kickoff_auto_presynth(book_id)
    except Exception:
        logger.exception("Auto-presynth kickoff failed for book %s", book_id)

    return serialize_book(meta)


def save_uploaded_book(upload: UploadFile, title_override: str | None = None) -> dict[str, Any]:
    if not upload.filename:
        raise HTTPException(status_code=400, detail="Missing filename.")

    suffix = normalize_book_suffix(upload.filename)

    book_id = uuid.uuid4().hex[:12]
    target_dir = book_dir(book_id)
    source_path = target_dir / f"source{suffix}"
    target_dir.mkdir(parents=True, exist_ok=True)

    with source_path.open("wb") as handle:
        shutil.copyfileobj(upload.file, handle)

    source_sha256 = sha256_file(source_path)
    source_storage: dict[str, str] | None = None
    try:
        if progress_store_configured():
            existing = _get_book_by_source_hash_sql(source_sha256, current_user_id())
            if existing is not None:
                ensure_existing_book_text_from_upload(existing, source_path, upload.filename, source_sha256)
                shutil.rmtree(target_dir, ignore_errors=True)
                return serialize_book(existing)

        if book_storage_enabled():
            object_key = book_source_storage_key(book_id, suffix)
            write_storage_bytes(
                object_key,
                source_path.read_bytes(),
                content_type=book_content_type_for_suffix(suffix, upload.content_type),
            )
            source_storage = {
                "bucket": BOOK_STORAGE_BUCKET,
                "key": object_key,
            }

        return import_book_source(
            book_id,
            upload.filename,
            source_path,
            source_storage=source_storage,
            source_sha256=source_sha256,
            title_override=title_override,
        )
    except Exception:
        if book_storage_enabled():
            delete_storage_prefix(book_storage_base_prefix(book_id))
        shutil.rmtree(target_dir, ignore_errors=True)
        raise
    finally:
        upload.file.close()


def create_direct_book_upload(request: DirectBookUploadInitRequest) -> dict[str, Any]:
    if not book_storage_enabled():
        raise HTTPException(
            status_code=503,
            detail="Direct book uploads are not configured. Set BOOK_STORAGE_BUCKET and AWS credentials for durable hosted uploads.",
        )

    suffix = normalize_book_suffix(request.fileName)
    content_type = book_content_type_for_suffix(suffix, request.contentType)

    book_id = uuid.uuid4().hex[:12]
    object_key = book_source_storage_key(book_id, suffix)
    client = create_book_storage_client()

    try:
        upload = client.generate_presigned_post(
            Bucket=BOOK_STORAGE_BUCKET,
            Key=object_key,
            Fields={
                "Content-Type": content_type,
            },
            Conditions=[
                {"Content-Type": content_type},
                ["content-length-range", 1, BOOK_STORAGE_MAX_UPLOAD_BYTES],
            ],
            ExpiresIn=3600,
        )
    except Exception as exc:
        logger.error("Failed to prepare direct upload for book %s: %s", book_id, exc)
        raise HTTPException(status_code=503, detail="Failed to prepare direct upload. Check storage configuration.") from exc

    return {
        "bookId": book_id,
        "upload": {
            "url": upload.get("url") or regional_book_storage_upload_url(),
            "fields": upload["fields"],
        },
    }


def complete_direct_book_upload(request: DirectBookUploadCompleteRequest) -> dict[str, Any]:
    if not book_storage_enabled():
        raise HTTPException(
            status_code=503,
            detail="Direct book uploads are not configured. Set BOOK_STORAGE_BUCKET and AWS credentials for durable hosted uploads.",
        )

    suffix = normalize_book_suffix(request.fileName)

    object_key = book_source_storage_key(request.bookId, suffix)
    temp_root = RUNTIME_ROOT / "direct-imports"
    temp_root.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="storybook_import_", dir=str(temp_root)) as temp_dir:
        temp_source = Path(temp_dir) / f"source{suffix}"
        try:
            download_storage_object(object_key, temp_source)
            source_sha256 = sha256_file(temp_source)
            source_storage = {
                "bucket": BOOK_STORAGE_BUCKET,
                "key": object_key,
                "contentType": book_content_type_for_suffix(suffix),
            }
            if progress_store_configured():
                existing = _get_book_by_source_hash_sql(source_sha256, current_user_id())
                if existing is not None:
                    existing_source_storage: dict[str, str] | None = None
                    if not has_servable_book_source(existing):
                        existing_key = book_source_storage_key(str(existing["id"]), suffix)
                        copy_storage_object(object_key, existing_key)
                        existing_source_storage = {
                            "bucket": BOOK_STORAGE_BUCKET,
                            "key": existing_key,
                            "contentType": book_content_type_for_suffix(suffix),
                        }
                    ensure_existing_book_text_from_upload(
                        existing,
                        temp_source,
                        request.fileName,
                        source_sha256,
                        source_storage=existing_source_storage,
                    )
                    delete_storage_prefix(book_storage_base_prefix(request.bookId))
                    return serialize_book(existing)
            return import_book_source(
                request.bookId,
                request.fileName,
                temp_source,
                source_storage=source_storage,
                source_sha256=source_sha256,
                title_override=request.title,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Uploaded book file was not found in storage.") from exc
        except HTTPException:
            delete_storage_prefix(book_storage_base_prefix(request.bookId))
            raise
        except Exception as exc:
            logger.exception("Failed to import uploaded book for book %s", request.bookId)
            delete_storage_prefix(book_storage_base_prefix(request.bookId))
            raise HTTPException(status_code=500, detail="Failed to import the uploaded book. Check storage and database configuration, then try again.") from exc


def source_file_response(book_id: str):
    meta = load_book_or_404(book_id)
    source_storage = meta.get("sourceStorage")
    if source_storage:
        key = source_storage.get("key")
        if not isinstance(key, str) or not key:
            raise HTTPException(status_code=500, detail="Stored source file metadata is invalid.")

        client = create_book_storage_client()
        _, _, _, ClientError, _, _, _ = load_boto3()
        try:
            response = client.get_object(Bucket=BOOK_STORAGE_BUCKET, Key=key)
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in {"404", "NoSuchKey", "NotFound"}:
                raise HTTPException(status_code=404, detail="Source PDF not found.") from exc
            logger.error("Failed to load source PDF from storage (book %s, key %s): %s", book_id, key, exc)
            raise HTTPException(status_code=503, detail="Failed to load the source PDF from storage.") from exc

        headers = {
            "Content-Disposition": f'inline; filename="{meta.get("fileName", "book.pdf")}"',
            "Cache-Control": "private, max-age=300",
        }
        return StreamingResponse(
            response["Body"].iter_chunks(),
            media_type=response.get("ContentType")
            or source_storage.get("contentType")
            or book_content_type_for_suffix(Path(str(meta.get("fileName") or "")).suffix.lower()),
            headers=headers,
        )

    source_path = resolve_local_source_path(meta)
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Source PDF not found.")
    return FileResponse(
        source_path,
        media_type=book_content_type_for_suffix(source_path.suffix),
        filename=meta.get("fileName") or source_path.name,
    )


def append_audio_version(book_id: str, version: dict[str, Any]) -> dict[str, Any]:
    meta = load_book_or_404(book_id)
    meta["latestAudio"] = version
    meta["audioHistory"] = [version, *meta.get("audioHistory", [])][:8]
    write_book_meta(book_id, meta)
    return serialize_book(meta)


def reader_payload(book_id: str) -> dict[str, Any]:
    meta = load_book_or_404(book_id)
    text = read_book_text(book_id)
    return {
        "book": serialize_book(meta),
        "text": text,
        "highlights": list_highlights(book_id),
    }


def create_highlight(book_id: str, request: HighlightCreateRequest) -> dict[str, Any]:
    load_book_or_404(book_id)
    text = read_book_text(book_id)
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

    note = normalize_highlight_text(request.note) if request.note else None
    kind = resolve_highlight_kind(request.kind, text=selected_text, note=note)

    highlight = {
        "id": uuid.uuid4().hex[:12],
        "start": request.start,
        "end": request.end,
        "color": request.color,
        "kind": kind,
        "text": selected_text,
        "note": note,
        "createdAt": utc_now(),
    }

    if progress_store_configured():
        # Remove any existing highlight at the same range before inserting
        uid = current_user_id()
        existing = _list_highlights_sql(book_id, uid)
        for ex in existing:
            if ex["start"] == request.start and ex["end"] == request.end:
                _delete_highlight_sql(book_id, ex["id"], uid)
        _insert_highlight_sql(book_id, uid, highlight)
        invalidate_books_cache(uid)
    else:
        items = read_highlights(book_id)
        items = [i for i in items if not (request.start == i["start"] and request.end == i["end"])]
        items.append(highlight)
        write_highlights(book_id, items)

    return serialize_highlight(highlight)


def delete_highlight(book_id: str, highlight_id: str) -> None:
    load_book_or_404(book_id)
    if progress_store_configured():
        found = _delete_highlight_sql(book_id, highlight_id, current_user_id())
        if not found:
            raise HTTPException(status_code=404, detail="Highlight not found.")
        invalidate_books_cache(current_user_id())
        return
    items = read_highlights(book_id)
    remaining = [item for item in items if item["id"] != highlight_id]
    if len(remaining) == len(items):
        raise HTTPException(status_code=404, detail="Highlight not found.")
    write_highlights(book_id, remaining)


def delete_book_files(book_id: str) -> None:
    load_book_or_404(book_id)
    if progress_store_configured():
        _delete_book_sql(book_id, current_user_id())  # CASCADE removes highlights + progress
    if book_storage_enabled():
        delete_storage_prefix(book_storage_base_prefix(book_id))
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

    chosen_model = resolve_google_tts_model(model)
    chosen_voice = voice or "Kore"

    # Gemini returns 24 kHz mono 16-bit PCM — already matches CANONICAL_WAV_SAMPLE_RATE,
    # so we skip ffmpeg normalization/concat and write/concat WAVs in pure Python.
    # ffmpeg isn't available on Vercel Lambda anyway.
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
        if not wav_paths:
            raise RuntimeError("Gemini produced no audio chunks.")
        if len(wav_paths) == 1:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(wav_paths[0], output_path)
        else:
            _concat_wavs(wav_paths, output_path, silence_seconds=sentence_silence)


def synthesize_provider_audio(
    *,
    provider_id: TTSProviderId,
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

    if provider_id == "google":
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
    elif provider_id == "kokoro":
        if not kokoro_configured():
            raise RuntimeError("Kokoro remote server is not configured (set KOKORO_REMOTE_URL).")
        full_text = " ".join(chunk.strip() for chunk in chunks if chunk.strip())
        speed = max(0.5, min(2.0, length_scale if length_scale else 1.0))
        # Preprocess text for naturalness (abbreviations, em-dashes, unicode cleanup)
        # then send as a single request — fastest path, avoids server queue buildup.
        preprocessed = preprocess_kokoro_text(full_text)
        synthesize_kokoro_remote(preprocessed, voice or "af_heart", speed, output_path)
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

    text = read_book_text(book_id)
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
    trimmed_start = request.start + len(selected_text) - len(selected_text.lstrip())

    chosen_model: str | None = None
    chosen_voice = request.voice or provider.get("defaultVoice")
    if request.provider == "google":
        chosen_model = resolve_google_tts_model(request.model)
    elif request.provider == "kokoro":
        chosen_voice = chosen_voice or "af_heart"

    playback_format = "wav"

    cache_key = {
        "version": LIVE_AUDIO_CACHE_VERSION,
        "bookId": book_id,
        "provider": request.provider,
        "voice": chosen_voice,
        "model": chosen_model or request.model,
        "outputFormat": playback_format,
        # Kokoro is an ONNX model that ignores narration_style; normalize to "" so
        # cache keys are provider-agnostic with respect to this field.
        "narrationStyle": "" if request.provider == "kokoro" else request.narration_style,
        "lengthScale": request.length_scale,
        "sentenceSilence": request.sentence_silence,
        "start": request.start,
        "end": request.end,
        "textHash": hashlib.sha256(canonical_text.encode("utf-8")).hexdigest(),
    }
    digest = hashlib.sha1(json.dumps(cache_key, sort_keys=True).encode("utf-8")).hexdigest()[:20]
    client_cache_key = f"live-audio:v{LIVE_AUDIO_CACHE_VERSION}:{digest}"
    output_dir = book_live_audio_dir(book_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{request.provider}-{digest}.{playback_format}"
    timing_path = output_dir / f"{output_path.name}.timing.json"
    storage_key = book_live_audio_storage_key(book_id, output_path.name) if book_storage_enabled() else None
    timing_storage_key = book_live_audio_storage_key(book_id, timing_path.name) if book_storage_enabled() else None
    cached = output_path.exists() and output_path.stat().st_size > 0
    if not cached and storage_key:
        cached = restore_file_from_storage(storage_key, output_path)
    timing_manifest = read_json(timing_path) if timing_path.exists() else None
    if timing_manifest is None and timing_storage_key:
        timing_manifest = read_storage_json(timing_storage_key)
        if timing_manifest is not None:
            write_json(timing_path, timing_manifest)

    resolved_model = chosen_model or ""
    chunks = prepare_live_synthesis_chunks(synthesis_text, request.provider)
    if not cached:
        chunk_dir = output_dir / f".{output_path.stem}-chunks"
        shutil.rmtree(chunk_dir, ignore_errors=True)
        chunk_dir.mkdir(parents=True, exist_ok=True)
        resolved_model = synthesize_provider_audio(
            provider_id=request.provider,
            chunks=chunks,
            output_path=output_path,
            chunk_dir=chunk_dir,
            voice=chosen_voice,
            model=request.model,
            narration_style=request.narration_style,
            output_format=playback_format,
            length_scale=request.length_scale,
            sentence_silence=request.sentence_silence,
            job_id=None,
        )
        try:
            chunk_wavs = sorted(chunk_dir.glob("chunk_*.wav"))
            if chunk_wavs:
                timing_manifest = build_audio_timing_manifest(
                    synthesis_text,
                    chunks,
                    chunk_wavs,
                    audio_url=relative_url(output_path),
                    source_offset=trimmed_start,
                )
        finally:
            shutil.rmtree(chunk_dir, ignore_errors=True)
    if storage_key and output_path.exists():
        write_storage_bytes(storage_key, output_path.read_bytes(), content_type="audio/wav")

    response_url = generate_book_storage_download_url(storage_key) if storage_key else relative_url(output_path)
    if timing_manifest is None and output_path.exists():
        timing_manifest = build_audio_timing_manifest_from_durations(
            synthesis_text,
            chunks,
            estimate_chunk_durations(chunks, wav_duration_seconds(output_path)),
            audio_url=response_url,
            source_offset=trimmed_start,
        )
    if timing_manifest is not None:
        timing_manifest["audioUrl"] = response_url
        write_json(timing_path, timing_manifest)
        if timing_storage_key:
            write_storage_json(timing_storage_key, timing_manifest)

    return {
        "provider": request.provider,
        "voice": chosen_voice,
        "model": resolved_model or None,
        "format": playback_format,
        "url": response_url,
        "cacheKey": client_cache_key,
        "cacheVersion": LIVE_AUDIO_CACHE_VERSION,
        "contentType": "audio/wav",
        "byteLength": output_path.stat().st_size if output_path.exists() else None,
        "start": request.start,
        "end": request.end,
        "pageNumber": request.pageNumber,
        "cached": cached,
        "duration": timing_manifest.get("duration") if timing_manifest else None,
        "cues": timing_manifest.get("cues", []) if timing_manifest else [],
    }


def run_generation_job(job_id: str, book_id: str, request: GenerateAudioRequest) -> None:
    raise_if_job_cancelled(job_id)
    meta = load_book_or_404(book_id)
    cleaned_text = read_book_text(book_id)
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
    uid = current_user_id()
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
        tok = _current_user_id.set(uid)
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
        finally:
            _current_user_id.reset(tok)

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


def provider_test_snippet(provider_id: str) -> str:
    return PROVIDER_TEST_SNIPPET


def provider_test_preview_path(
    *,
    provider_id: str,
    voice: str | None,
    model: str | None,
    narration_style: str,
    length_scale: float,
    sentence_silence: float,
    sample_text: str,
) -> Path:
    cache_key = {
        "version": PROVIDER_TEST_CACHE_VERSION,
        "provider": provider_id,
        "voice": voice or "",
        "model": model or "",
        "narrationStyle": narration_style,
        "lengthScale": length_scale,
        "sentenceSilence": sentence_silence,
        "sampleText": sample_text,
    }
    digest = hashlib.sha1(json.dumps(cache_key, sort_keys=True).encode("utf-8")).hexdigest()[:20]
    return PREVIEW_ROOT / f"provider-test-{provider_id}-{digest}.wav"


def run_provider_test(request: ProviderTestRequest) -> dict[str, Any]:
    provider = provider_details(request.provider)
    if not provider["available"]:
        raise HTTPException(
            status_code=400,
            detail=f"{provider['name']} is not configured yet.",
        )

    chosen_model: str | None = None
    chosen_voice = request.voice or provider.get("defaultVoice")
    if request.provider == "google":
        chosen_model = resolve_google_tts_model(request.model)

    resolved_model = chosen_model or ""
    sample_text = provider_test_snippet(request.provider)
    preview_path = provider_test_preview_path(
        provider_id=request.provider,
        voice=chosen_voice,
        model=chosen_model or request.model,
        narration_style=request.narration_style,
        length_scale=request.length_scale,
        sentence_silence=request.sentence_silence,
        sample_text=sample_text,
    )
    preview_storage_key = preview_audio_storage_key(preview_path.name) if book_storage_enabled() else None
    cached = preview_path.exists() and preview_path.stat().st_size > 0
    if not cached and preview_storage_key:
        cached = restore_file_from_storage(preview_storage_key, preview_path)
    was_cached = cached

    temporary_preview_path: Path | None = None

    try:
        if not cached:
            temporary_preview_path = PREVIEW_ROOT / f".provider-test-{request.provider}-{uuid.uuid4().hex[:10]}.wav"
            resolved_model = synthesize_provider_audio(
                provider_id=request.provider,
                chunks=[sample_text],
                output_path=temporary_preview_path,
                chunk_dir=None,
                voice=chosen_voice,
                model=request.model,
                narration_style=request.narration_style,
                output_format="wav",
                length_scale=request.length_scale,
                sentence_silence=request.sentence_silence,
                job_id=None,
            )
            temporary_preview_path.replace(preview_path)
            cached = True
            temporary_preview_path = None
    except HTTPException:
        if temporary_preview_path is not None:
            temporary_preview_path.unlink(missing_ok=True)
        raise
    except httpx.HTTPStatusError as exc:
        if temporary_preview_path is not None:
            temporary_preview_path.unlink(missing_ok=True)
        try:
            detail = exc.response.json().get("error", {}).get("message")
        except Exception:
            detail = None
        raise HTTPException(status_code=400, detail=detail or str(exc)) from exc
    except Exception as exc:
        if temporary_preview_path is not None:
            temporary_preview_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    cleanup_preview_files()
    if preview_storage_key:
        write_storage_bytes(preview_storage_key, preview_path.read_bytes(), content_type="audio/wav")
    return {
        "provider": request.provider,
        "voice": chosen_voice,
        "model": resolved_model,
        "sampleText": sample_text,
        "audioUrl": generate_book_storage_download_url(preview_storage_key) if preview_storage_key else relative_url(preview_path),
        "message": (
            f"{provider['name']} preview is ready."
            if was_cached
            else f"{provider['name']} generated a short sample successfully."
        ),
    }


def run_provider_warmup(request: ProviderWarmupRequest) -> dict[str, Any]:
    if request.provider == "kokoro":
        if not KOKORO_REMOTE_URL:
            raise HTTPException(status_code=400, detail="Kokoro remote server is not configured.")
        warmup_url = f"{KOKORO_REMOTE_URL}/v1/synthesize"
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if KOKORO_REMOTE_API_KEY:
            headers["X-Api-Key"] = KOKORO_REMOTE_API_KEY
        voice = request.voice or "af_heart"
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(warmup_url, json={"text": "Hi.", "voice": voice, "speed": 1.0}, headers=headers)
        if resp.status_code != 200:
            raise HTTPException(status_code=503, detail="Kokoro warmup request failed.")
        return {"ok": True, "provider": "kokoro"}
    raise HTTPException(status_code=400, detail=f"Warmup is unsupported for provider {request.provider}.")


def _run_presynth_job(
    job_id: str,
    book_id: str,
    request: PresynthesizeRequest,
    chunks: list[dict[str, Any]],
    uid: str | None,
) -> None:
    tok = _current_user_id.set(uid)
    total = len(chunks)
    _MAX_RETRIES = 3
    _WORKERS = 4  # parallel chunk synthesis — keeps Kokoro server load sane

    _presynth_jobs[job_id] = {"status": "running", "completed": 0, "total": total}
    completed_count = [0]
    completed_lock = threading.Lock()

    def synth_chunk(chunk: dict[str, Any]) -> None:
        if _presynth_jobs.get(job_id, {}).get("status") == "cancelled":
            return
        live_req = LiveAudioRequest(
            provider=request.provider,
            voice=request.voice,
            model=None,
            output_format="mp3",
            narration_style="",  # normalized — Kokoro ignores this field
            length_scale=request.length_scale,
            sentence_silence=request.sentence_silence,
            pageNumber=1,
            start=chunk["start"],
            end=chunk["end"],
            text=chunk["text"],
        )
        for attempt in range(_MAX_RETRIES):
            try:
                build_live_audio_payload(book_id, live_req)
                break
            except Exception:
                if attempt < _MAX_RETRIES - 1:
                    time.sleep(1.0)
        with completed_lock:
            completed_count[0] += 1
            _presynth_jobs[job_id]["completed"] = completed_count[0]

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=_WORKERS) as pool:
            futs = {pool.submit(synth_chunk, c): c for c in chunks}
            for fut in concurrent.futures.as_completed(futs):
                if _presynth_jobs.get(job_id, {}).get("status") == "cancelled":
                    for f in futs:
                        f.cancel()
                    break
                try:
                    fut.result()
                except Exception:
                    pass
        _presynth_jobs[job_id]["status"] = "done"
        marker_path = book_live_audio_dir(book_id) / ".presynth-done.json"
        try:
            write_json(marker_path, {
                "jobId": job_id,
                "provider": request.provider,
                "voice": request.voice,
                "cacheVersion": LIVE_AUDIO_CACHE_VERSION,
                "completedAt": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:
            pass
    except Exception as exc:
        _presynth_jobs[job_id] = {"status": "error", "completed": 0, "total": total, "error": str(exc)}
    finally:
        _current_user_id.reset(tok)


# Providers eligible for upload-time auto-presynth. Restricted to ones with a
# stable default voice and a cache-friendly synthesis path.
_AUTO_PRESYNTH_PROVIDERS: tuple[str, ...] = ("kokoro", "google")


def kickoff_auto_presynth(book_id: str) -> None:
    """Best-effort: warm the live-audio cache for newly imported books.

    Spawns one presynth job per configured provider in `_AUTO_PRESYNTH_PROVIDERS`,
    using each provider's default voice. Skips providers that already have a
    completion marker for that voice. On Vercel the daemon thread dies with the
    request, but any chunks completed before that still land in S3.
    """
    try:
        text = read_book_text(book_id)
    except Exception:
        return
    if not text.strip():
        return

    chunks = _chunk_text_for_presynth(text, 420)
    if not chunks:
        return

    uid = _current_user_id.get()
    catalog = {p["id"]: p for p in provider_catalog()}
    audio_dir = book_live_audio_dir(book_id)
    marker_path = audio_dir / ".presynth-done.json"

    existing_marker: dict[str, Any] | None = None
    if marker_path.exists():
        try:
            existing_marker = read_json(marker_path)
        except Exception:
            existing_marker = None

    for provider_id in _AUTO_PRESYNTH_PROVIDERS:
        prov = catalog.get(provider_id)
        if not prov or not prov.get("available"):
            continue
        voice = prov.get("defaultVoice")
        if not voice and provider_id == "kokoro":
            voice = "af_heart"
        if not voice:
            continue
        if (
            existing_marker
            and existing_marker.get("provider") == provider_id
            and existing_marker.get("voice") == voice
            and existing_marker.get("cacheVersion") == LIVE_AUDIO_CACHE_VERSION
        ):
            continue

        request = PresynthesizeRequest(
            provider=provider_id,
            voice=voice,
            narration_style="",
            length_scale=1.0,
            sentence_silence=0.2 if provider_id != "kokoro" else 0.38,
            start_from=0,
        )
        job_id = uuid.uuid4().hex
        _presynth_jobs[job_id] = {"status": "queued", "completed": 0, "total": len(chunks)}
        threading.Thread(
            target=_run_presynth_job,
            args=(job_id, book_id, request, list(chunks), uid),
            name=f"auto-presynth-{provider_id}-{job_id[:8]}",
            daemon=True,
        ).start()


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AskAIRequest(BaseModel):
    text: str                                          # highlighted passage
    context: str | None = None                         # surrounding book text
    messages: list[ChatMessage] = []                   # conversation history (explain mode)
    mode: Literal["explain", "translate"] = "explain"  # panel mode
    target_language: str | None = None                 # translate mode only


@app.post("/api/ai/ask")
async def ask_ai(req: AskAIRequest):
    """
    Stream a Gemma 4 answer from the NVIDIA API.
    mode=explain: explain/discuss the passage (chat-capable).
    mode=translate: translate the passage into target_language.
    Returns text/event-stream: data: {"delta": "..."}  …  data: [DONE]
    """
    api_key = env_value("NVIDIA_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="AI service is not configured on this server.")

    # ── Translate mode ────────────────────────────────────────────────────────
    if req.mode == "translate":
        lang = req.target_language or "Spanish"
        messages: list[dict] = [
            {
                "role": "system",
                "content": (
                    f"You are a literary translator. Translate the given text into {lang}. "
                    "Output only the translation — no explanation, no preamble, no quotation marks."
                ),
            },
            {"role": "user", "content": req.text},
        ]
    # ── Explain mode ──────────────────────────────────────────────────────────
    else:
        system_prompt = (
            "You are a reading assistant embedded in a book reader app. "
            "The reader has highlighted a passage and you are having a conversation about it. "
            "Be concise, insightful, and literary. "
            "Keep replies focused — 2-4 sentences unless the question clearly needs more."
        )
        passage_intro = f'The reader highlighted:\n\n"{req.text}"'
        if req.context:
            passage_intro += f"\n\nSurrounding text:\n{req.context}"

        if req.messages:
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": passage_intro + "\n\nExplain this passage clearly and concisely."},
            ]
            for m in req.messages:
                messages.append({"role": m.role, "content": m.content})
        else:
            # First turn: explain the passage
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": passage_intro + "\n\nExplain this passage clearly and concisely."},
            ]

    async def generate():
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                async with client.stream(
                    "POST",
                    "https://integrate.api.nvidia.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                        "Accept": "text/event-stream",
                    },
                    json={
                        "model": "google/gemma-4-31b-it",
                        "messages": messages,
                        "max_tokens": 512,
                        "temperature": 0.7,
                        "stream": True,
                    },
                ) as resp:
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        raw = line[6:]
                        if raw == "[DONE]":
                            yield "data: [DONE]\n\n"
                            break
                        try:
                            chunk = json.loads(raw)
                            delta = chunk["choices"][0]["delta"].get("content", "")
                            if delta:
                                yield f"data: {json.dumps({'delta': delta})}\n\n"
                        except Exception:
                            pass
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class AssistantChatRequest(BaseModel):
    book_title: str
    page_context: str                  # ~2 000-char window of current page text
    messages: list[ChatMessage] = []   # full conversation history


@app.post("/api/ai/chat")
async def assistant_chat(req: AssistantChatRequest):
    """
    Reading assistant: persistent chat about the book being read.
    Streams text/event-stream: data: {"delta": "..."} … data: [DONE]
    """
    api_key = env_value("NVIDIA_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="AI service is not configured on this server.")

    system = (
        f'You are a reading assistant helping someone read "{req.book_title}". '
        "Answer questions about the text, themes, characters, vocabulary, and ideas. "
        "Be concise — 2-4 sentences unless more depth is clearly needed. "
        "If the question is unrelated to reading or the book, gently redirect."
    )

    messages: list[dict] = [{"role": "system", "content": system}]

    if req.page_context.strip():
        messages.append({
            "role": "user",
            "content": f"Here is the passage I'm currently reading:\n\n{req.page_context}",
        })
        messages.append({
            "role": "assistant",
            "content": "Got it — I can see the passage you're reading. What would you like to know?",
        })

    for m in req.messages:
        messages.append({"role": m.role, "content": m.content})

    async def generate():
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                async with client.stream(
                    "POST",
                    "https://integrate.api.nvidia.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                        "Accept": "text/event-stream",
                    },
                    json={
                        "model": "google/gemma-4-31b-it",
                        "messages": messages,
                        "max_tokens": 512,
                        "temperature": 0.7,
                        "stream": True,
                    },
                ) as resp:
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        raw = line[6:]
                        if raw == "[DONE]":
                            yield "data: [DONE]\n\n"
                            break
                        try:
                            chunk = json.loads(raw)
                            delta = chunk["choices"][0]["delta"].get("content", "")
                            if delta:
                                yield f"data: {json.dumps({'delta': delta})}\n\n"
                        except Exception:
                            pass
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class VocabCheckRequest(BaseModel):
    mode: Literal["sentence", "definition", "mnemonic"]
    word: str
    definition: str
    user_input: str
    book_sentence: str | None = None


@app.post("/api/ai/vocab-check")
async def vocab_check(req: VocabCheckRequest):
    """
    AI evaluates a free-text vocabulary practice answer.
    - sentence:   did the user's sentence correctly use the word?
    - definition: how well does the user's definition match the actual one?
    - mnemonic:   is the user's memory hook vivid and tied to the meaning?
    Returns JSON: {"verdict": "correct"|"partial"|"incorrect", "feedback": str, "suggestion"?: str}
    """
    api_key = env_value("NVIDIA_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="AI service is not configured on this server.")

    word = req.word.strip()
    definition = (req.definition or "").strip()
    user_input = req.user_input.strip()

    if not word or not user_input:
        return {"verdict": "incorrect", "feedback": "Empty input.", "suggestion": None}

    if req.mode == "sentence":
        system = (
            "You are a strict but encouraging vocabulary tutor evaluating whether a learner's sentence "
            "correctly uses a target word. Reply ONLY with valid JSON in this exact shape: "
            '{"verdict":"correct"|"partial"|"incorrect","feedback":"<one sentence, max 22 words>"}. '
            "Verdict 'correct' = word used grammatically AND with a meaning consistent with the definition. "
            "Verdict 'partial' = word used but with slightly off meaning, awkward grammar, or unclear context. "
            "Verdict 'incorrect' = word missing, used wrong, or applied to the wrong concept. "
            "Be specific in feedback — name what worked or what to fix."
        )
        ctx = f'Original book sentence: "{req.book_sentence}"\n\n' if req.book_sentence else ""
        user_msg = (
            f'{ctx}'
            f'Target word: "{word}"\n'
            f'Definition: {definition}\n'
            f'Learner wrote: "{user_input}"'
        )
    elif req.mode == "definition":
        system = (
            "You are a strict but encouraging vocabulary tutor evaluating how closely a learner's "
            "definition matches the actual meaning of a word. Reply ONLY with valid JSON in this exact shape: "
            '{"verdict":"correct"|"partial"|"incorrect","feedback":"<one sentence, max 22 words>"}. '
            "Verdict 'correct' = captured the core meaning even if worded differently. "
            "Verdict 'partial' = right general area but missing nuance, or partly off. "
            "Verdict 'incorrect' = wrong meaning entirely. "
            "Be specific in feedback — name what was right or what to add."
        )
        user_msg = (
            f'Word: "{word}"\n'
            f'Actual definition: {definition}\n'
            f'Learner wrote: "{user_input}"'
        )
    else:  # mnemonic
        system = (
            "You are a vocabulary tutor evaluating a learner's mnemonic (memory hook). "
            "A great mnemonic links the word's sound or look to its meaning via a vivid image, "
            "sound association, or mini-story — using desirable difficulty and elaborative encoding. "
            "Reply ONLY with valid JSON in this exact shape: "
            '{"verdict":"correct"|"partial"|"incorrect","feedback":"<one sentence, max 22 words>","suggestion":"<optional improved mnemonic, max 28 words>"}. '
            "Verdict 'correct' = vivid AND clearly tied to the meaning. "
            "Verdict 'partial' = on the right track but could be more memorable. "
            "Verdict 'incorrect' = doesn't connect sound/look to meaning. "
            "Always include 'suggestion' for partial/incorrect; omit or use null for correct."
        )
        user_msg = (
            f'Word: "{word}"\n'
            f'Definition: {definition}\n'
            f'Learner\'s memory hook: "{user_input}"'
        )

    messages = [
        {"role": "system", "content": system},
        {"role": "user",   "content": user_msg},
    ]

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://integrate.api.nvidia.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "google/gemma-4-31b-it",
                    "messages": messages,
                    "max_tokens": 220,
                    "temperature": 0.2,
                    "stream": False,
                },
            )
            resp.raise_for_status()
            payload = resp.json()
            raw = (payload.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI check failed: {exc}")

    # Strip markdown fences if Gemma wraps the JSON
    if raw.startswith("```"):
        lines = raw.splitlines()
        raw = "\n".join(line for line in lines if not line.strip().startswith("```"))

    # Slice to the JSON object
    start = raw.find("{")
    end   = raw.rfind("}")
    json_text = raw[start:end + 1] if start >= 0 and end > start else raw

    parsed: dict[str, Any] = {}
    try:
        parsed = json.loads(json_text)
    except json.JSONDecodeError:
        low = raw.lower()
        if "incorrect" in low or "wrong" in low:
            verdict = "incorrect"
        elif "partial" in low or "close" in low or "almost" in low:
            verdict = "partial"
        elif "correct" in low or "right" in low or "good" in low:
            verdict = "correct"
        else:
            verdict = "partial"
        return {"verdict": verdict, "feedback": raw[:160] or "Could not parse AI response.", "suggestion": None}

    verdict = str(parsed.get("verdict", "partial")).lower()
    if verdict not in ("correct", "partial", "incorrect"):
        verdict = "partial"

    feedback   = str(parsed.get("feedback") or "").strip()[:240]
    suggestion = parsed.get("suggestion")
    if suggestion is not None:
        suggestion = str(suggestion).strip()[:240] or None

    return {"verdict": verdict, "feedback": feedback, "suggestion": suggestion}


class DefineWordRequest(BaseModel):
    word: str
    book_sentence: str | None = None


@app.post("/api/ai/define-word")
async def define_word(req: DefineWordRequest):
    """
    Generate a clean dictionary-style definition for a single word.
    Used by Studio at practice-start time when the saved note has no real definition.
    Optionally uses the original book sentence to disambiguate the sense.
    Returns: {"definition": str, "partOfSpeech"?: str, "example"?: str}
    """
    api_key = env_value("NVIDIA_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="AI service is not configured on this server.")

    word = req.word.strip()
    if not word:
        raise HTTPException(status_code=400, detail="Empty word.")

    system = (
        "You are a precise dictionary lexicographer. Given a single word "
        "(and optionally the sentence it appeared in for context), produce a "
        "concise dictionary-style definition. Reply ONLY with valid JSON in this exact shape: "
        '{"definition":"<one sentence, max 22 words>",'
        '"partOfSpeech":"<noun|verb|adjective|adverb|other>",'
        '"example":"<brief example sentence using the word naturally, max 18 words>"}. '
        "If the word has multiple senses and a book sentence is provided, "
        "choose the sense that fits that sentence. "
        "Definition must be self-contained — never say 'see X' or 'used to'."
    )

    user_msg = f'Word: "{word}"'
    if req.book_sentence:
        user_msg += f'\nIt appeared in this sentence: "{req.book_sentence}"'

    messages = [
        {"role": "system", "content": system},
        {"role": "user",   "content": user_msg},
    ]

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://integrate.api.nvidia.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "google/gemma-4-31b-it",
                    "messages": messages,
                    "max_tokens": 240,
                    "temperature": 0.2,
                    "stream": False,
                },
            )
            resp.raise_for_status()
            payload = resp.json()
            raw = (payload.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI define failed: {exc}")

    if raw.startswith("```"):
        lines = raw.splitlines()
        raw = "\n".join(line for line in lines if not line.strip().startswith("```"))

    start = raw.find("{")
    end   = raw.rfind("}")
    json_text = raw[start:end + 1] if start >= 0 and end > start else raw

    try:
        parsed = json.loads(json_text)
    except json.JSONDecodeError:
        return {
            "definition": (raw[:240].strip() or "Definition unavailable."),
            "partOfSpeech": None,
            "example": None,
        }

    pos = str(parsed.get("partOfSpeech") or "").strip().lower()
    if pos and pos not in ("noun", "verb", "adjective", "adverb", "other"):
        pos = "other"

    return {
        "definition":   (str(parsed.get("definition") or "").strip()[:280] or "Definition unavailable."),
        "partOfSpeech": (pos or None),
        "example":      (str(parsed.get("example") or "").strip()[:280] or None),
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    """
    Extended health check.
    Returns DB connectivity, psycopg availability, and which TTS providers are configured.
    Always returns HTTP 200 — callers should inspect the individual fields.
    """
    # --- Database / progress store ---
    db_status: dict[str, Any] = {"configured": progress_store_configured(), "ok": False, "error": None}
    if db_status["configured"]:
        try:
            psycopg = load_psycopg()
            with psycopg.connect(SUPABASE_DB_URL, connect_timeout=5) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
            db_status["ok"] = True
            db_status["error"] = None
        except ImportError:
            db_status["error"] = "psycopg not installed — run: pip install -r requirements.txt"
        except Exception as exc:
            db_status["error"] = str(exc)
    else:
        db_status["ok"] = None  # not applicable — no DB URL configured

    # --- Configured TTS providers (key-presence only, no live API call) ---
    providers_configured = {
        "gemini": bool(env_value("GEMINI_API_KEY")),
        "kokoro": kokoro_configured(),
    }

    # --- Storage ---
    storage_configured = bool(env_value("BOOK_STORAGE_BUCKET"))

    return {
        "status": "ok",
        "db": db_status,
        "providers": providers_configured,
        "storage": {"s3": storage_configured},
        "runtimeRoot": str(RUNTIME_ROOT),
    }


@app.get("/api/providers")
def providers() -> dict[str, Any]:
    return {
        "defaultNarrationStyle": DEFAULT_NARRATION_STYLE,
        "providers": provider_catalog(),
    }



@app.post("/api/providers/test")
def provider_test(request: ProviderTestRequest) -> dict[str, Any]:
    return run_provider_test(request)


@app.post("/api/providers/warmup")
def provider_warmup(request: ProviderWarmupRequest) -> dict[str, Any]:
    return run_provider_warmup(request)


@app.get("/api/dictionary/lookup")
def dictionary_lookup(term: str) -> dict[str, Any]:
    return lookup_offline_dictionary(term)


def resolve_vocab_context_provider() -> Literal["auto", "gemma", "openai", "off"]:
    raw_value = (env_value("VOCAB_CONTEXT_PROVIDER") or "auto").lower()
    if raw_value in {"auto", "gemma", "openai", "off"}:
        return raw_value
    return "auto"


def build_vocabulary_context_runtime() -> tuple[list[Any], list[Any], list[Any], list[Any], bool]:
    provider = resolve_vocab_context_provider()
    context_generators: list[Any] = []
    lesson_generators: list[Any] = []
    coach_generators: list[Any] = []
    sentence_generators: list[Any] = []
    allow_openai_fallback = provider in {"auto", "openai"}

    if provider == "gemma" or (provider == "auto" and gemma_runtime_configured()):
        context_generators.append(build_gemma_context_generator())
        lesson_generators.append(build_gemma_lesson_generator())
        coach_generators.append(build_gemma_answer_coach())
        sentence_generators.append(build_gemma_sentence_coach())

    if provider == "off":
        allow_openai_fallback = False

    return context_generators, lesson_generators, coach_generators, sentence_generators, allow_openai_fallback


(
    vocabulary_context_generators,
    vocabulary_lesson_generators,
    vocabulary_coach_generators,
    vocabulary_sentence_generators,
    vocabulary_openai_fallback,
) = build_vocabulary_context_runtime()
vocabulary_service = VocabularyStudioService(
    DATA_ROOT,
    user_id_provider=current_user_id,
    dictionary_lookup=lookup_offline_dictionary,
    context_generators=vocabulary_context_generators,
    lesson_generators=vocabulary_lesson_generators,
    coach_generators=vocabulary_coach_generators,
    sentence_generators=vocabulary_sentence_generators,
    allow_openai_fallback=vocabulary_openai_fallback,
)
app.include_router(create_vocabulary_router(vocabulary_service))


@app.get("/api/learning/home")
def learning_home() -> dict[str, Any]:
    payload = vocabulary_service.learning_home_summary()
    return {
        **payload,
        "continueBook": continue_book_payload(),
    }


@app.post("/api/learning/events")
def create_learning_event(request: LearningEventCreateRequest) -> dict[str, Any]:
    return vocabulary_service.record_learning_event(
        {
            "type": request.type,
            "xpDelta": request.xpDelta,
            "bookId": request.bookId,
            "deckId": request.deckId,
            "cardId": request.cardId,
            "label": request.label,
            "detail": request.detail,
        }
    )


@app.get("/api/books")
def books():
    return JSONResponse(
        content={"items": list_books()},
        headers={"Cache-Control": "private, max-age=30, stale-while-revalidate=60"},
    )


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


@app.post("/api/books/{book_id}/presynthesize")
def presynthesize_book(book_id: str, request: PresynthesizeRequest) -> dict[str, Any]:
    load_book_or_404(book_id)
    prov = provider_details(request.provider)
    if not prov["available"]:
        raise HTTPException(status_code=400, detail=f"{prov['name']} is not available.")
    text = read_book_text(book_id)
    chunks = _chunk_text_for_presynth(text, 420)
    if not chunks:
        raise HTTPException(status_code=400, detail="Book has no synthesizable text.")
    chunk_grid = [{"start": c["start"], "end": c["end"]} for c in chunks]
    # If already presynthesized with the same provider+voice, skip the job
    marker_path = book_live_audio_dir(book_id) / ".presynth-done.json"
    if marker_path.exists():
        try:
            marker = read_json(marker_path)
            if (marker.get("provider") == request.provider
                    and marker.get("voice") == request.voice
                    and marker.get("cacheVersion") == LIVE_AUDIO_CACHE_VERSION):
                return {"jobId": f"done-{book_id}", "total": len(chunks), "chunks": chunk_grid, "alreadyDone": True}
        except Exception:
            pass
    # Start presynthesis from the user's current reading position so that nearby
    # chunks are cached first — the rest of the book follows in background.
    start_from = max(0, min(request.start_from, len(text)))
    start_idx = next((i for i, c in enumerate(chunks) if c["end"] > start_from), 0)
    prioritized = chunks[start_idx:] + chunks[:start_idx]
    job_id = uuid.uuid4().hex
    uid = _current_user_id.get()
    _presynth_jobs[job_id] = {"status": "queued", "completed": 0, "total": len(chunks)}
    threading.Thread(
        target=_run_presynth_job,
        args=(job_id, book_id, request, prioritized, uid),
        name=f"presynth-{job_id[:8]}",
        daemon=True,
    ).start()
    return {"jobId": job_id, "total": len(chunks), "chunks": chunk_grid}


@app.get("/api/books/{book_id}/presynthesize/status")
def presynthesize_status(book_id: str, jobId: str) -> dict[str, Any]:
    job = _presynth_jobs.get(jobId)
    if not job:
        # Check for a persistent marker (server may have restarted)
        marker_path = book_live_audio_dir(book_id) / ".presynth-done.json"
        if marker_path.exists():
            try:
                m = read_json(marker_path)
                if m.get("cacheVersion") == LIVE_AUDIO_CACHE_VERSION:
                    return {"status": "done", "completed": 0, "total": 0, "percent": 100}
            except Exception:
                pass
        return {"status": "not_found", "completed": 0, "total": 0, "percent": 0}
    total = job.get("total", 0)
    completed = job.get("completed", 0)
    return {
        "status": job.get("status", "unknown"),
        "completed": completed,
        "total": total,
        "percent": round(completed / total * 100) if total > 0 else 100,
    }


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
def upload_book(file: UploadFile = File(...), title: str | None = Form(default=None)) -> dict[str, Any]:
    result = save_uploaded_book(file, title_override=title)
    invalidate_books_cache(current_user_id())
    return result


@app.post("/api/books/direct-upload")
def init_direct_book_upload(request: DirectBookUploadInitRequest) -> dict[str, Any]:
    return create_direct_book_upload(request)


@app.post("/api/books/direct-upload/complete")
def finalize_direct_book_upload(request: DirectBookUploadCompleteRequest) -> dict[str, Any]:
    result = complete_direct_book_upload(request)
    invalidate_books_cache(current_user_id())
    return result


@app.get("/api/books/{book_id}/source", response_model=None)
def book_source(book_id: str):
    return source_file_response(book_id)


@app.delete("/api/books/{book_id}")
def delete_book(book_id: str) -> dict[str, bool]:
    delete_book_files(book_id)
    invalidate_books_cache(current_user_id())
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
