from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run NeuTTS inside WSL from a JSON request manifest or as a daemon.")
    parser.add_argument("--input-json", help="Path to the helper request JSON file.")
    parser.add_argument("--daemon", action="store_true", help="Run an HTTP daemon that caches the NeuTTS runtime.")
    parser.add_argument("--host", default="127.0.0.1", help="Host for daemon mode.")
    parser.add_argument("--port", type=int, default=8765, help="Port for daemon mode.")
    args = parser.parse_args()
    if not args.daemon and not args.input_json:
        parser.error("--input-json is required unless --daemon is used.")
    return args


def load_request(path: Path) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Input JSON must contain an object payload.")
    return payload


def configure_cache(request: dict[str, object]) -> None:
    hf_home = str(request.get("hf_home") or "").strip()
    if not hf_home:
        return
    expanded = str(Path(hf_home).expanduser())
    os.environ["HF_HOME"] = expanded
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(Path(expanded) / "hub"))


def require_directory(path_value: object, label: str) -> Path:
    path = Path(str(path_value or "")).expanduser().resolve()
    if not path.is_dir():
        raise ValueError(f"{label} directory was not found: {path}")
    return path


def require_non_empty_text(value: object, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{label} is required.")
    return text


def load_reference_text(reference_dir: Path) -> str:
    reference_text_path = reference_dir / "reference.txt"
    if not reference_text_path.exists():
        raise ValueError(f"Reference text file was not found: {reference_text_path}")
    return reference_text_path.read_text(encoding="utf-8").strip()


def reference_audio_path(reference_dir: Path) -> Path:
    audio_path = reference_dir / "reference.wav"
    if not audio_path.exists():
        raise ValueError(f"Reference audio file was not found: {audio_path}")
    return audio_path


def prepare_reference_codes(reference_dir: Path):
    import torch
    from librosa import load
    from neucodec import NeuCodec

    codes_path = reference_dir / "reference.pt"
    if codes_path.exists():
        return torch.load(codes_path, map_location="cpu")

    audio_path = reference_audio_path(reference_dir)
    wav, _ = load(audio_path, sr=16000, mono=True)
    wav_tensor = torch.from_numpy(wav).float().unsqueeze(0).unsqueeze(0)

    codec = NeuCodec.from_pretrained("neuphonic/neucodec")
    codec.eval().to("cpu")
    with torch.no_grad():
        ref_codes = codec.encode_code(audio_or_path=wav_tensor).squeeze(0).squeeze(0).cpu()
    torch.save(ref_codes, codes_path)
    return ref_codes


def load_reference_codes(reference_dir: Path):
    import torch

    codes_path = reference_dir / "reference.pt"
    if codes_path.exists():
        return torch.load(codes_path, map_location="cpu")
    return prepare_reference_codes(reference_dir)


def prepare_reference(request: dict[str, object]) -> dict[str, object]:
    configure_cache(request)
    reference_dir = require_directory(request.get("reference_dir"), "Reference")
    load_reference_text(reference_dir)
    codes = prepare_reference_codes(reference_dir)
    codes_path = reference_dir / "reference.pt"
    return {
        "action": "prepare_reference",
        "voicePack": reference_dir.name,
        "codesPath": str(codes_path),
        "codeCount": int(getattr(codes, "shape", [0])[-1]),
    }


class NeuTTSDaemonRuntime:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._engine_key: tuple[str, str] | None = None
        self._engine = None
        self._reference_cache: dict[str, tuple[str, Any]] = {}

    def _load_engine(self, model_name: str, codec_name: str):
        from neutts import NeuTTS

        key = (model_name, codec_name)
        if self._engine is None or self._engine_key != key:
            self._engine = NeuTTS(
                backbone_repo=model_name,
                backbone_device="cpu",
                codec_repo=codec_name,
                codec_device="cpu",
            )
            self._engine_key = key
        return self._engine

    def _load_reference(self, reference_dir: Path) -> tuple[str, Any]:
        cache_key = str(reference_dir)
        cached = self._reference_cache.get(cache_key)
        if cached is not None:
            return cached

        ref_payload = (load_reference_text(reference_dir), load_reference_codes(reference_dir))
        self._reference_cache[cache_key] = ref_payload
        return ref_payload

    def health_payload(self) -> dict[str, object]:
        with self._lock:
            return {
                "status": "ok",
                "model": self._engine_key[0] if self._engine_key else None,
                "codec": self._engine_key[1] if self._engine_key else None,
                "referenceCount": len(self._reference_cache),
            }

    def warmup(self, request: dict[str, object]) -> dict[str, object]:
        configure_cache(request)
        model_name = require_non_empty_text(request.get("model"), "NeuTTS model")
        codec_name = require_non_empty_text(request.get("codec"), "NeuTTS codec")
        reference_dir = require_directory(request.get("reference_dir"), "Reference")

        with self._lock:
            self._load_engine(model_name, codec_name)
            ref_text, ref_codes = self._load_reference(reference_dir)

        return {
            "action": "warmup",
            "warmed": True,
            "model": model_name,
            "codec": codec_name,
            "voicePack": reference_dir.name,
            "referenceTextLength": len(ref_text),
            "codeCount": int(getattr(ref_codes, "shape", [0])[-1]),
        }

    def synthesize(self, request: dict[str, object]) -> dict[str, object]:
        import soundfile as sf

        configure_cache(request)
        model_name = require_non_empty_text(request.get("model"), "NeuTTS model")
        codec_name = require_non_empty_text(request.get("codec"), "NeuTTS codec")
        reference_dir = require_directory(request.get("reference_dir"), "Reference")
        output_dir = Path(require_non_empty_text(request.get("output_dir"), "Output directory")).expanduser().resolve()
        output_dir.mkdir(parents=True, exist_ok=True)

        chunks = request.get("chunks")
        if not isinstance(chunks, list) or not chunks:
            raise ValueError("The helper request must include a non-empty chunks list.")
        chunk_text = [str(item).strip() for item in chunks if str(item).strip()]
        if not chunk_text:
            raise ValueError("The helper request contained no synthesizeable text.")

        output_files: list[str] = []
        with self._lock:
            tts = self._load_engine(model_name, codec_name)
            ref_text, ref_codes = self._load_reference(reference_dir)

            for index, chunk in enumerate(chunk_text, start=1):
                wav = tts.infer(chunk, ref_codes, ref_text)
                output_path = output_dir / f"chunk_{index:05d}.wav"
                sf.write(output_path, wav, 24000)
                output_files.append(str(output_path))

        return {
            "action": "synthesize",
            "model": model_name,
            "codec": codec_name,
            "voicePack": reference_dir.name,
            "sampleRate": 24000,
            "files": output_files,
        }


RUNTIME = NeuTTSDaemonRuntime()


class NeuTTSDaemonHandler(BaseHTTPRequestHandler):
    server_version = "StorybookNeuTTSDaemon/1.0"

    def log_message(self, format: str, *args: object) -> None:
        return

    def _read_json(self) -> dict[str, object]:
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        if content_length <= 0:
            return {}
        raw = self.rfile.read(content_length)
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Daemon requests must contain a JSON object.")
        return payload

    def _send_json(self, payload: dict[str, object], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/health":
            self._send_json(RUNTIME.health_payload())
            return
        self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        try:
            payload = self._read_json()
            if self.path.rstrip("/") == "/v1/warmup":
                result = RUNTIME.warmup(payload)
            elif self.path.rstrip("/") == "/v1/synthesize":
                result = RUNTIME.synthesize(payload)
            else:
                self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
                return
            self._send_json(result)
        except Exception as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)


def serve_daemon(host: str, port: int) -> int:
    server = ThreadingHTTPServer((host, port), NeuTTSDaemonHandler)
    server.daemon_threads = True
    print(json.dumps({"status": "listening", "host": host, "port": port}))
    server.serve_forever()
    return 0


def main() -> int:
    args = parse_args()
    if args.daemon:
        return serve_daemon(args.host, args.port)

    request = load_request(Path(args.input_json))
    action = str(request.get("action") or "synthesize").strip().lower()
    if action == "prepare_reference":
        result = prepare_reference(request)
    elif action == "synthesize":
        result = RUNTIME.synthesize(request)
    elif action == "warmup":
        result = RUNTIME.warmup(request)
    else:
        raise ValueError(f"Unsupported NeuTTS helper action: {action}")

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
