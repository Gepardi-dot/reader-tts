#!/usr/bin/env python3
"""
Kokoro TTS remote server — high-quality, free, open-source neural TTS.

Uses kokoro-onnx (Apache 2.0) — no PyTorch needed, runs well on CPU.
Model is ~330 MB; first startup downloads it from HuggingFace once.

Critical: synthesis runs in a worker thread with a single-flight lock so the
HTTP event loop stays responsive (health checks never hang mid-synth).

API:
  GET  /v1/health      — health + model status (always fast)
  GET  /v1/voices      — list curated narration voices
  POST /v1/synthesize  — synthesize text → WAV bytes (disk-cached)

Deploy:
  fly deploy --config fly.kokoro.toml --dockerfile Dockerfile.kokoro
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────

API_KEY = os.environ.get("KOKORO_API_KEY", "")
CACHE_DIR = Path(os.environ.get("KOKORO_CACHE_DIR", "/data/cache"))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8767"))
HF_HOME = os.environ.get("HF_HOME", "/data/hf_cache")
# Cap concurrent ONNX work — shared-cpu machines thrash hard above 1.
SYNTH_WORKERS = max(1, min(2, int(os.environ.get("KOKORO_SYNTH_WORKERS", "1"))))
MAX_TEXT_CHARS = max(64, int(os.environ.get("KOKORO_MAX_TEXT_CHARS", "800")))

CACHE_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro-server")

VOICES = [
    {"id": "af_heart", "label": "Heart", "gender": "female", "locale": "en-US", "style": "Warm & Natural"},
    {"id": "af_sarah", "label": "Sarah", "gender": "female", "locale": "en-US", "style": "Clear & Conversational"},
    {"id": "af_sky", "label": "Sky", "gender": "female", "locale": "en-US", "style": "Bright & Expressive", "tags": ["Story", "Narration"]},
    {"id": "am_adam", "label": "Adam", "gender": "male", "locale": "en-US", "style": "Natural & Steady", "tags": ["Story", "Narration"]},
    {"id": "am_michael", "label": "Michael", "gender": "male", "locale": "en-US", "style": "Authoritative"},
    {"id": "bf_emma", "label": "Emma", "gender": "female", "locale": "en-GB", "style": "British & Warm"},
    {"id": "bm_george", "label": "George", "gender": "male", "locale": "en-GB", "style": "British & Deep", "tags": ["Story", "Narration"]},
    {"id": "bm_lewis", "label": "Lewis", "gender": "male", "locale": "en-GB", "style": "British & Calm"},
]
DEFAULT_VOICE = "af_sky"
VOICE_IDS = {v["id"] for v in VOICES}

_kokoro: "Kokoro | None" = None  # type: ignore[name-defined]
_sample_rate: int = 24000
_executor = ThreadPoolExecutor(max_workers=SYNTH_WORKERS, thread_name_prefix="kokoro-synth")
# Serialize model.generate — kokoro-onnx is not reliably multi-threaded.
_synth_lock = asyncio.Lock()

_GH_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
_MODEL_FILE = CACHE_DIR / "kokoro-v1.0.onnx"
_VOICES_FILE = CACHE_DIR / "voices-v1.0.bin"


def _download(url: str, dest: Path) -> None:
    import urllib.request
    log.info("Downloading %s …", dest.name)
    urllib.request.urlretrieve(url, dest)
    log.info("Downloaded %s (%.1f MB)", dest.name, dest.stat().st_size / 1_048_576)


def load_model() -> None:
    global _kokoro, _sample_rate
    log.info("Loading Kokoro model (first run downloads ~330 MB)…")
    try:
        from kokoro_onnx import Kokoro  # type: ignore
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        if not _MODEL_FILE.exists() or _MODEL_FILE.stat().st_size == 0:
            _download(f"{_GH_BASE}/kokoro-v1.0.onnx", _MODEL_FILE)
        if not _VOICES_FILE.exists() or _VOICES_FILE.stat().st_size == 0:
            _download(f"{_GH_BASE}/voices-v1.0.bin", _VOICES_FILE)
        _kokoro = Kokoro(str(_MODEL_FILE), str(_VOICES_FILE))
        _sample_rate = 24000
        log.info("Kokoro model ready.")
    except Exception as exc:
        log.error("Failed to load Kokoro model: %s", exc)
        raise


def synthesize_sync(text: str, voice: str, speed: float) -> bytes:
    """Blocking synth — always call from the thread pool, never the event loop."""
    assert _kokoro is not None, "Model not loaded"
    samples, sr = _kokoro.create(text, voice=voice, speed=speed, lang="en-us")
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


app = FastAPI(title="Kokoro TTS Server", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup() -> None:
    # Load in a thread so startup health can flip once ready without blocking deploy forever.
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(_executor, load_model)


def check_auth(request: Request) -> None:
    if not API_KEY:
        return
    auth = request.headers.get("Authorization", "")
    key = request.headers.get("X-Api-Key", "")
    if auth != f"Bearer {API_KEY}" and key != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/v1/health")
async def health() -> dict:
    # Never touch the model here — must stay instant even during long synth.
    return {
        "status": "ok" if _kokoro is not None else "loading",
        "model_loaded": _kokoro is not None,
        "service": "kokoro",
        "synth_workers": SYNTH_WORKERS,
    }


@app.get("/v1/voices")
async def list_voices(request: Request) -> dict:
    check_auth(request)
    return {"voices": VOICES}


class SynthesizeRequest(BaseModel):
    text: str
    voice: str | None = None
    speed: float = 1.0


@app.post("/v1/synthesize")
async def synthesize_endpoint(body: SynthesizeRequest, request: Request) -> Response:
    check_auth(request)

    if _kokoro is None:
        raise HTTPException(status_code=503, detail="Model is still loading, retry in a moment.")

    text = body.text.strip()
    voice = body.voice or DEFAULT_VOICE
    speed = max(0.5, min(2.0, body.speed))

    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS]
    if voice not in VOICE_IDS:
        voice = DEFAULT_VOICE

    cache_key = hashlib.sha1(
        json.dumps({"t": text, "v": voice, "s": round(speed, 2)}, sort_keys=True).encode()
    ).hexdigest()[:24]
    cache_path = CACHE_DIR / f"{cache_key}.wav"

    if cache_path.exists() and cache_path.stat().st_size > 0:
        return Response(content=cache_path.read_bytes(), media_type="audio/wav")

    loop = asyncio.get_event_loop()
    # Single-flight: one ONNX job at a time keeps shared-cpu machines responsive.
    async with _synth_lock:
        # Re-check cache after waiting for the lock (another request may have filled it).
        if cache_path.exists() and cache_path.stat().st_size > 0:
            return Response(content=cache_path.read_bytes(), media_type="audio/wav")
        try:
            audio = await loop.run_in_executor(
                _executor,
                synthesize_sync,
                text,
                voice,
                speed,
            )
        except Exception as exc:
            log.error("Synthesis failed: %s", exc)
            raise HTTPException(status_code=500, detail=f"Synthesis failed: {exc}") from exc

    try:
        cache_path.write_bytes(audio)
    except Exception as exc:
        log.warning("Cache write failed: %s", exc)

    return Response(content=audio, media_type="audio/wav")


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
