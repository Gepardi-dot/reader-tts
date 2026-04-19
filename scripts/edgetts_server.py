#!/usr/bin/env python3
"""
Edge-TTS remote server — free, fast, neural TTS via Microsoft's Edge endpoint.

No API key required from Microsoft. Set EDGETTS_API_KEY to protect this server.
Responds to POST /v1/synthesize in ~300-500 ms. Caches results on disk.

Deploy on Railway or Fly.io (see railway.edgetts.toml / fly.edgetts.toml).

API:
  GET  /v1/health      — health check
  GET  /v1/voices      — list available voices
  POST /v1/synthesize  — synthesize text → MP3 bytes (cached)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path

import edge_tts
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────

API_KEY   = os.environ.get("EDGETTS_API_KEY", "")
CACHE_DIR = Path(os.environ.get("EDGETTS_CACHE_DIR", "/tmp/edgetts_cache"))
HOST      = os.environ.get("HOST", "0.0.0.0")
PORT      = int(os.environ.get("PORT", "8766"))

CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Best voices for audiobook narration, in recommended order
RECOMMENDED_VOICES = [
    {"id": "en-US-JennyNeural",   "label": "Jenny",   "gender": "female", "locale": "en-US", "style": "Warm"},
    {"id": "en-US-AndrewNeural",  "label": "Andrew",  "gender": "male",   "locale": "en-US", "style": "Natural"},
    {"id": "en-US-EmmaNeural",    "label": "Emma",    "gender": "female", "locale": "en-US", "style": "Expressive"},
    {"id": "en-US-AriaNeural",    "label": "Aria",    "gender": "female", "locale": "en-US", "style": "Versatile"},
    {"id": "en-US-GuyNeural",     "label": "Guy",     "gender": "male",   "locale": "en-US", "style": "Authoritative"},
    {"id": "en-GB-SoniaNeural",   "label": "Sonia",   "gender": "female", "locale": "en-GB", "style": "British"},
    {"id": "en-GB-RyanNeural",    "label": "Ryan",    "gender": "male",   "locale": "en-GB", "style": "British"},
    {"id": "en-AU-NatashaNeural", "label": "Natasha", "gender": "female", "locale": "en-AU", "style": "Australian"},
]
DEFAULT_VOICE = "en-US-JennyNeural"

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Edge-TTS Server", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


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
    return {"status": "ok", "service": "edgetts"}


@app.get("/v1/voices")
async def list_voices(request: Request) -> dict:
    check_auth(request)
    return {"voices": RECOMMENDED_VOICES}


class SynthesizeRequest(BaseModel):
    text: str
    voice: str | None = None
    rate:  str | None = None   # e.g. "+10%", "-5%"
    pitch: str | None = None   # e.g. "+0Hz"


@app.post("/v1/synthesize")
async def synthesize(body: SynthesizeRequest, request: Request) -> Response:
    check_auth(request)

    text  = body.text.strip()
    voice = body.voice or DEFAULT_VOICE
    rate  = body.rate  or "+0%"
    pitch = body.pitch or "+0Hz"

    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    # Disk cache keyed by (text, voice, rate, pitch)
    cache_key  = hashlib.sha1(
        json.dumps({"t": text, "v": voice, "r": rate, "p": pitch}, sort_keys=True).encode()
    ).hexdigest()[:24]
    cache_path = CACHE_DIR / f"{cache_key}.mp3"

    if cache_path.exists() and cache_path.stat().st_size > 0:
        return Response(content=cache_path.read_bytes(), media_type="audio/mpeg")

    # Synthesize via edge-tts (streams from Microsoft's neural TTS endpoint)
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    chunks: list[bytes] = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])

    if not chunks:
        raise HTTPException(status_code=500, detail="No audio data returned by edge-tts")

    audio = b"".join(chunks)
    cache_path.write_bytes(audio)
    return Response(content=audio, media_type="audio/mpeg")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
