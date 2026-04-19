#!/usr/bin/env python3
"""
Kokoro TTS remote server — high-quality, free, open-source neural TTS.

Uses kokoro-onnx (Apache 2.0) — no PyTorch needed, runs well on CPU.
Model is ~330 MB; first startup downloads it from HuggingFace once.
After warmup: ~300-600 ms per request. Model stays loaded between requests.

API:
  GET  /v1/health      — health + model status
  GET  /v1/voices      — list curated narration voices
  POST /v1/synthesize  — synthesize text → WAV bytes (disk-cached)

Deploy:
  fly launch --dockerfile Dockerfile.kokoro (see fly.kokoro.toml)
  railway up --dockerfile Dockerfile.kokoro  (see railway.kokoro.toml)
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import wave
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────

API_KEY    = os.environ.get("KOKORO_API_KEY", "")
CACHE_DIR  = Path(os.environ.get("KOKORO_CACHE_DIR", "/data/cache"))
HOST       = os.environ.get("HOST", "0.0.0.0")
PORT       = int(os.environ.get("PORT", "8767"))
HF_HOME    = os.environ.get("HF_HOME", "/data/hf_cache")

CACHE_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro-server")

# ── Voices curated for audiobook narration ────────────────────────────────────
#
# These are the best Kokoro-v1.0 voices for long-form narration.
# af_heart is the flagship — warm, natural, very close to commercial quality.
#
VOICES = [
    {"id": "af_heart",   "label": "Heart",   "gender": "female", "locale": "en-US", "style": "Warm & Natural",       "tags": ["Story", "Narration"]},
    {"id": "af_sarah",   "label": "Sarah",   "gender": "female", "locale": "en-US", "style": "Clear & Conversational"},
    {"id": "af_sky",     "label": "Sky",     "gender": "female", "locale": "en-US", "style": "Bright & Expressive"},
    {"id": "am_adam",    "label": "Adam",    "gender": "male",   "locale": "en-US", "style": "Natural & Steady",      "tags": ["Story", "Narration"]},
    {"id": "am_michael", "label": "Michael", "gender": "male",   "locale": "en-US", "style": "Authoritative"},
    {"id": "bf_emma",    "label": "Emma",    "gender": "female", "locale": "en-GB", "style": "British & Warm"},
    {"id": "bm_george",  "label": "George",  "gender": "male",   "locale": "en-GB", "style": "British & Deep",        "tags": ["Story", "Narration"]},
    {"id": "bm_lewis",   "label": "Lewis",   "gender": "male",   "locale": "en-GB", "style": "British & Calm"},
]
DEFAULT_VOICE = "af_heart"
VOICE_IDS     = {v["id"] for v in VOICES}

# ── Model (loaded once at startup) ───────────────────────────────────────────

_kokoro: "Kokoro | None" = None  # type: ignore[name-defined]
_sample_rate: int = 24000


def load_model() -> None:
    global _kokoro, _sample_rate
    log.info("Loading Kokoro model from HuggingFace (first run downloads ~330 MB)…")
    try:
        from kokoro_onnx import Kokoro  # type: ignore
        _kokoro = Kokoro.from_pretrained()
        _sample_rate = 24000
        log.info("Kokoro model ready.")
    except Exception as exc:
        log.error("Failed to load Kokoro model: %s", exc)
        raise


def synthesize(text: str, voice: str, speed: float) -> bytes:
    """Return raw WAV bytes for the given text."""
    assert _kokoro is not None, "Model not loaded"
    samples, sr = _kokoro.create(text, voice=voice, speed=speed, lang="en-us")
    # Convert float32 numpy → 16-bit WAV bytes
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Kokoro TTS Server", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])


@app.on_event("startup")
async def on_startup() -> None:
    load_model()


def check_auth(request: Request) -> None:
    if not API_KEY:
        return
    auth = request.headers.get("Authorization", "")
    key  = request.headers.get("X-Api-Key", "")
    if auth != f"Bearer {API_KEY}" and key != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/v1/health")
async def health() -> dict:
    return {"status": "ok", "model_loaded": _kokoro is not None, "service": "kokoro"}


@app.get("/v1/voices")
async def list_voices(request: Request) -> dict:
    check_auth(request)
    return {"voices": VOICES}


class SynthesizeRequest(BaseModel):
    text:  str
    voice: str | None = None
    speed: float = 1.0


@app.post("/v1/synthesize")
async def synthesize_endpoint(body: SynthesizeRequest, request: Request) -> Response:
    check_auth(request)

    if _kokoro is None:
        raise HTTPException(status_code=503, detail="Model is still loading, retry in a moment.")

    text  = body.text.strip()
    voice = body.voice or DEFAULT_VOICE
    speed = max(0.5, min(2.0, body.speed))

    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if voice not in VOICE_IDS:
        voice = DEFAULT_VOICE

    # Disk cache
    cache_key  = hashlib.sha1(
        json.dumps({"t": text, "v": voice, "s": round(speed, 2)}, sort_keys=True).encode()
    ).hexdigest()[:24]
    cache_path = CACHE_DIR / f"{cache_key}.wav"

    if cache_path.exists() and cache_path.stat().st_size > 0:
        return Response(content=cache_path.read_bytes(), media_type="audio/wav")

    try:
        audio = synthesize(text, voice, speed)
    except Exception as exc:
        log.error("Synthesis failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {exc}")

    cache_path.write_bytes(audio)
    return Response(content=audio, media_type="audio/wav")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
