#!/usr/bin/env python3
"""
Storybook Reader — NeuTTS Remote Synthesis Server
==================================================
A self-contained HTTP service that runs NeuTTS natively on Linux.
Deploy on Railway, Fly.io, Hetzner, or any Linux VPS — no WSL2 needed.

Required Python packages:
    neutts neucodec soundfile librosa numpy torch

Environment variables:
    NEUTTS_API_KEY          Required in production. Shared secret for request auth.
    NEUTTS_VOICES_DIR       Directory that holds voice packs. Default: ./voices
    NEUTTS_CACHE_DIR        Directory for generated audio cache. Default: ./cache
    NEUTTS_MODEL            Default backbone model. Default: neuphonic/neutts-nano-q4-gguf
    NEUTTS_CODEC            Default codec. Default: neuphonic/neucodec-onnx-decoder
    HF_HOME                 HuggingFace model cache directory.
    HOST                    Bind address. Default: 0.0.0.0
    PORT                    Port. Default: 8765

Voice pack layout (same as the local voices/neutts/ directory):
    <NEUTTS_VOICES_DIR>/
      arthur-storyteller/
        reference.wav   <- required: 15-30s recording of the voice
        reference.txt   <- required: exact transcript of the recording
        meta.json       <- optional: {label, gender, style, tags}
      elara-storyteller/
        ...

API:
    GET  /v1/health              -> {"status": "ok", "model": "..."}
    GET  /v1/voices              -> {"voices": [...]}  (requires auth)
    POST /v1/synthesize          -> audio/wav binary   (requires auth)
         body: {"chunks": ["text..."], "voice": "arthur-storyteller",
                "model": "...", "codec": "..."}

Auth header: X-Api-Key: <NEUTTS_API_KEY>
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Configuration ────────────────────────────────────────────────────────────

VOICES_DIR    = Path(os.environ.get("NEUTTS_VOICES_DIR") or "./voices").expanduser().resolve()
CACHE_DIR     = Path(os.environ.get("NEUTTS_CACHE_DIR")  or "./cache").expanduser().resolve()
DEFAULT_MODEL = (os.environ.get("NEUTTS_MODEL") or "neuphonic/neutts-nano-q4-gguf").strip()
DEFAULT_CODEC = (os.environ.get("NEUTTS_CODEC") or "neuphonic/neucodec-onnx-decoder").strip()
API_KEY       = (os.environ.get("NEUTTS_API_KEY") or "").strip()
HOST          = os.environ.get("HOST") or "0.0.0.0"
PORT          = int(os.environ.get("PORT") or "8765")

VOICES_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

if not API_KEY:
    log.warning("NEUTTS_API_KEY is not set — server is unauthenticated. Set it before exposing publicly.")


# ── NeuTTS runtime (singleton, thread-safe) ──────────────────────────────────

class NeuTTSRuntime:
    """Caches the loaded model and voice reference codes across requests."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._engine_key: tuple[str, str] | None = None
        self._engine: Any = None
        self._ref_cache: dict[str, tuple[str, Any]] = {}  # voice_dir → (text, codes)

    # ── Engine ──────────────────────────────────────────────────────────────

    def _load_engine(self, model: str, codec: str) -> Any:
        from neutts import NeuTTS
        key = (model, codec)
        if self._engine is None or self._engine_key != key:
            log.info("Loading NeuTTS engine: model=%s codec=%s", model, codec)
            self._engine = NeuTTS(
                backbone_repo=model,
                backbone_device="cpu",
                codec_repo=codec,
                codec_device="cpu",
            )
            self._engine_key = key
            log.info("NeuTTS engine ready.")
        return self._engine

    # ── Voice reference ──────────────────────────────────────────────────────

    def _load_ref_codes(self, voice_dir: Path) -> Any:
        """Build (or load cached) reference codes for a voice pack."""
        import torch
        codes_path = voice_dir / "reference.pt"
        if codes_path.exists():
            log.info("Loading cached reference codes: %s", codes_path)
            return torch.load(codes_path, map_location="cpu")

        log.info("Encoding reference audio for: %s (first-run, may take a minute)", voice_dir.name)
        from librosa import load
        from neucodec import NeuCodec

        wav, _ = load(str(voice_dir / "reference.wav"), sr=16000, mono=True)
        import torch as _torch
        wav_t = _torch.from_numpy(wav).float().unsqueeze(0).unsqueeze(0)
        codec_model = NeuCodec.from_pretrained("neuphonic/neucodec")
        codec_model.eval()
        with _torch.no_grad():
            codes = codec_model.encode_code(audio_or_path=wav_t).squeeze(0).squeeze(0).cpu()
        _torch.save(codes, codes_path)
        log.info("Reference codes saved to %s", codes_path)
        return codes

    def _load_reference(self, voice_dir: Path) -> tuple[str, Any]:
        key = str(voice_dir)
        cached = self._ref_cache.get(key)
        if cached is not None:
            return cached
        ref_text = (voice_dir / "reference.txt").read_text(encoding="utf-8").strip()
        ref_codes = self._load_ref_codes(voice_dir)
        self._ref_cache[key] = (ref_text, ref_codes)
        return ref_text, ref_codes

    # ── Synthesis ────────────────────────────────────────────────────────────

    def synthesize(self, chunks: list[str], voice: str, model: str, codec: str) -> bytes:
        """
        Synthesize text chunks with the given voice and return WAV bytes.
        Multiple chunks are concatenated into one continuous audio file.
        """
        import numpy as np
        import soundfile as sf

        voice_dir = (VOICES_DIR / voice).resolve()
        if not voice_dir.is_dir() or VOICES_DIR not in voice_dir.parents:
            raise ValueError(f"Voice pack not found: {voice!r}")
        if not (voice_dir / "reference.wav").exists():
            raise ValueError(
                f"Voice pack {voice!r} is missing reference.wav. "
                "Drop a 15-30s recording into the voice directory."
            )

        filtered = [c.strip() for c in chunks if c.strip()]
        if not filtered:
            raise ValueError("No synthesizable text in chunks.")

        log.info("Synthesizing %d chunk(s) with voice=%s model=%s", len(filtered), voice, model)

        with self._lock:
            tts = self._load_engine(model, codec)
            ref_text, ref_codes = self._load_reference(voice_dir)
            wavs = []
            for i, chunk in enumerate(filtered, 1):
                log.info("  chunk %d/%d (%d chars)", i, len(filtered), len(chunk))
                wav = tts.infer(chunk, ref_codes, ref_text)
                wavs.append(wav)

        combined = np.concatenate(wavs)
        buf = io.BytesIO()
        sf.write(buf, combined, samplerate=24000, format="WAV")
        wav_bytes = buf.getvalue()
        log.info("Synthesis complete: %.1f s of audio, %.1f kB", len(combined) / 24000, len(wav_bytes) / 1024)
        return wav_bytes

    def model_info(self) -> dict[str, str | None]:
        return {
            "model": self._engine_key[0] if self._engine_key else None,
            "codec": self._engine_key[1] if self._engine_key else None,
        }


RUNTIME = NeuTTSRuntime()


# ── Voice pack helpers ────────────────────────────────────────────────────────

def list_voices() -> list[dict[str, Any]]:
    voices = []
    for d in sorted(VOICES_DIR.iterdir()):
        if not d.is_dir():
            continue
        has_wav = (d / "reference.wav").exists()
        has_txt = (d / "reference.txt").exists()
        meta: dict[str, Any] = {}
        meta_path = d / "meta.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        voices.append({
            "id":     d.name,
            "label":  meta.get("label") or d.name.replace("-", " ").title(),
            "gender": meta.get("gender"),
            "style":  meta.get("style"),
            "tags":   meta.get("tags") or [],
            "ready":  has_wav and has_txt,
        })
    return voices


# ── Audio cache ───────────────────────────────────────────────────────────────

def _cache_key(chunks: list[str], voice: str, model: str) -> str:
    payload = json.dumps({"c": chunks, "v": voice, "m": model}, sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()[:24]


def cached_audio(chunks: list[str], voice: str, model: str) -> bytes | None:
    path = CACHE_DIR / f"{voice}-{_cache_key(chunks, voice, model)}.wav"
    if path.exists() and path.stat().st_size > 0:
        log.info("Cache hit: %s", path.name)
        return path.read_bytes()
    return None


def write_audio_cache(chunks: list[str], voice: str, model: str, data: bytes) -> None:
    path = CACHE_DIR / f"{voice}-{_cache_key(chunks, voice, model)}.wav"
    path.write_bytes(data)


# ── HTTP handler ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "StorybookNeuTTSRemote/1.0"

    def log_message(self, *_args: Any) -> None:  # silence default access log
        pass

    # ── Auth ─────────────────────────────────────────────────────────────────

    def _is_authorized(self) -> bool:
        if not API_KEY:
            return True  # unauthenticated mode (dev only)
        return self.headers.get("X-Api-Key", "") == API_KEY

    # ── I/O helpers ──────────────────────────────────────────────────────────

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def _json(self, data: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _wav(self, data: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    # ── Routes ───────────────────────────────────────────────────────────────

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Api-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?")[0].rstrip("/")
        if path == "/v1/health":
            self._json({"status": "ok", **RUNTIME.model_info()})
        elif path == "/v1/voices":
            if not self._is_authorized():
                self._json({"error": "Unauthorized"}, 401)
                return
            self._json({"voices": list_voices()})
        else:
            self._json({"error": "Not found"}, 404)

    def do_POST(self) -> None:
        path = self.path.split("?")[0].rstrip("/")

        if not self._is_authorized():
            self._json({"error": "Unauthorized"}, 401)
            return

        if path == "/v1/synthesize":
            self._handle_synthesize()
        elif path == "/v1/voices/sync":
            self._handle_voice_sync()
        else:
            self._json({"error": "Not found"}, 404)

    def _handle_synthesize(self) -> None:
        try:
            req    = self._read_json()
            chunks = [str(c).strip() for c in (req.get("chunks") or []) if str(c).strip()]
            voice  = str(req.get("voice") or "").strip()
            model  = str(req.get("model") or DEFAULT_MODEL).strip() or DEFAULT_MODEL
            codec  = str(req.get("codec") or DEFAULT_CODEC).strip() or DEFAULT_CODEC

            if not chunks:
                self._json({"error": "'chunks' list is required and must not be empty."}, 400)
                return
            if not voice:
                self._json({"error": "'voice' is required."}, 400)
                return

            # Disk cache first — same text + voice = instant response
            wav = cached_audio(chunks, voice, model)
            if wav is None:
                wav = RUNTIME.synthesize(chunks, voice, model, codec)
                write_audio_cache(chunks, voice, model, wav)

            self._wav(wav)

        except ValueError as exc:
            self._json({"error": str(exc)}, 400)
        except Exception as exc:
            log.exception("Synthesis error")
            self._json({"error": str(exc)}, 500)

    def _handle_voice_sync(self) -> None:
        """
        Receive a voice pack from the sync script and write it to VOICES_DIR.

        Body: {
          "voice_id": "arthur-storyteller",
          "files": {
            "reference.wav":  "<base64>",
            "reference.txt":  "the transcript text",
            "meta.json":      "{...json string...}"
          }
        }

        Only reference.wav and reference.txt are required.
        Existing reference.pt cache is deleted so codes are rebuilt from the new wav.
        """
        import base64

        try:
            req      = self._read_json()
            voice_id = str(req.get("voice_id") or "").strip()
            files    = req.get("files") or {}

            if not voice_id or "/" in voice_id or ".." in voice_id:
                self._json({"error": "Invalid voice_id."}, 400)
                return
            if not isinstance(files, dict) or not files.get("reference.wav") or not files.get("reference.txt"):
                self._json({"error": "files.reference.wav and files.reference.txt are required."}, 400)
                return

            voice_dir = VOICES_DIR / voice_id
            voice_dir.mkdir(parents=True, exist_ok=True)

            written: list[str] = []

            # reference.wav — base64 encoded binary
            wav_b64 = files["reference.wav"]
            (voice_dir / "reference.wav").write_bytes(base64.b64decode(wav_b64))
            written.append("reference.wav")

            # reference.txt — plain text
            (voice_dir / "reference.txt").write_text(str(files["reference.txt"]), encoding="utf-8")
            written.append("reference.txt")

            # meta.json — optional
            if files.get("meta.json"):
                (voice_dir / "meta.json").write_text(str(files["meta.json"]), encoding="utf-8")
                written.append("meta.json")

            # Bust reference.pt cache so codes are rebuilt from the new wav
            codes_path = voice_dir / "reference.pt"
            if codes_path.exists():
                codes_path.unlink()
                log.info("Cleared stale reference.pt for %s", voice_id)

            # Bust audio synthesis cache for this voice
            for f in CACHE_DIR.glob(f"{voice_id}-*.wav"):
                f.unlink()

            # Invalidate in-memory reference cache
            RUNTIME._ref_cache.pop(str(voice_dir), None)

            log.info("Voice pack synced: %s (files: %s)", voice_id, written)
            self._json({"ok": True, "voice_id": voice_id, "written": written})

        except (ValueError, KeyError, Exception) as exc:
            log.exception("Voice sync error")
            self._json({"error": str(exc)}, 500)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info("NeuTTS remote server starting on %s:%d", HOST, PORT)
    log.info("Voices dir : %s  (%d packs)", VOICES_DIR, len(list_voices()))
    log.info("Cache dir  : %s", CACHE_DIR)
    log.info("Default    : model=%s codec=%s", DEFAULT_MODEL, DEFAULT_CODEC)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()
