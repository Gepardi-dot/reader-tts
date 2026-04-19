from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import wave
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run local Qwen3-TTS synthesis for a batch of text chunks or as a daemon."
    )
    parser.add_argument("--input-json", help="Path to the synthesis request JSON file.")
    parser.add_argument("--daemon", action="store_true", help="Run an HTTP daemon that keeps Qwen runtime warm.")
    parser.add_argument("--host", default="127.0.0.1", help="Host for daemon mode.")
    parser.add_argument("--port", type=int, default=8766, help="Port for daemon mode.")
    args = parser.parse_args()
    if not args.daemon and not args.input_json:
        parser.error("--input-json is required unless --daemon is used.")
    return args


def load_request(path: Path) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Input JSON must contain an object payload.")
    return payload


def qwen_local_language(text: str) -> str:
    if re.search(r"[\u3400-\u9fff\uf900-\ufaff]", text):
        return "Chinese"
    if re.search(r"[A-Za-z]", text):
        return "English"
    return "Auto"


def batched(items: list[str], size: int) -> list[list[str]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def normalize_pcm_samples(array) -> tuple[bytes, int]:
    import numpy as np

    if hasattr(array, "detach"):
        array = array.detach()
    if hasattr(array, "cpu"):
        array = array.cpu()

    samples = np.asarray(array)
    if samples.ndim > 1:
        samples = samples.squeeze()
    if samples.ndim != 1:
        raise ValueError("Expected mono audio output from Qwen3-TTS.")

    if np.issubdtype(samples.dtype, np.floating):
        clipped = np.clip(samples, -1.0, 1.0)
        pcm = (clipped * 32767.0).astype(np.int16)
    elif samples.dtype == np.int16:
        pcm = samples
    else:
        pcm = samples.astype(np.int16)

    return pcm.tobytes(), int(pcm.shape[0])


def write_wav(path: Path, audio, sample_rate: int) -> None:
    pcm_bytes, frame_count = normalize_pcm_samples(audio)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.setnframes(frame_count)
        output.writeframes(pcm_bytes)


def resolve_torch_dtype(torch, device: str, requested: str | None):
    dtype_name = (requested or "").strip().lower()
    if not dtype_name or dtype_name == "auto":
        dtype_name = "bfloat16" if device.startswith("cuda") else "float32"

    try:
        return getattr(torch, dtype_name)
    except AttributeError as exc:
        raise ValueError(f"Unsupported torch dtype for Qwen local synthesis: {dtype_name}") from exc


def coerce_wav_batch(wavs) -> list[object]:
    try:
        import numpy as np
    except ImportError as exc:
        raise RuntimeError("numpy is required by the local Qwen helper runtime.") from exc

    if hasattr(wavs, "detach"):
        wavs = wavs.detach()
    if hasattr(wavs, "cpu"):
        wavs = wavs.cpu()

    if isinstance(wavs, np.ndarray):
        if wavs.ndim == 1:
            return [wavs]
        return [wavs[index] for index in range(wavs.shape[0])]

    if isinstance(wavs, (list, tuple)):
        return list(wavs)

    return [wavs]


def require_non_empty_text(value: object, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{label} is required.")
    return text


def normalize_chunks(value: object) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ValueError("The helper request must include a non-empty chunks list.")
    chunks = [str(item).strip() for item in value if str(item).strip()]
    if not chunks:
        raise ValueError("The helper request contained no synthesizeable text.")
    return chunks


def configure_sox_dir(request: dict[str, object]) -> None:
    sox_dir = str(request.get("sox_dir") or "").strip()
    if not sox_dir:
        return
    current_path = os.environ.get("PATH", "")
    os.environ["PATH"] = f"{sox_dir};{current_path}" if current_path else sox_dir


class QwenDaemonRuntime:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model_key: tuple[str, str, str, str] | None = None
        self._model = None
        self._torch = None
        self._model_class = None

    def _load_runtime_modules(self):
        if self._torch is not None and self._model_class is not None:
            return self._torch, self._model_class

        try:
            import torch
            from qwen_tts import Qwen3TTSModel
        except ImportError as exc:
            raise RuntimeError(
                "The local Qwen runtime is missing dependencies. Activate the qwen-tts environment "
                "and install `qwen-tts` before using qwen_local."
            ) from exc

        self._torch = torch
        self._model_class = Qwen3TTSModel
        return torch, Qwen3TTSModel

    def _load_model(self, request: dict[str, object]):
        configure_sox_dir(request)
        torch, model_class = self._load_runtime_modules()

        model_name = require_non_empty_text(request.get("model"), "Local Qwen model")
        device = str(request.get("device") or "cuda:0").strip()
        requested_dtype = str(request.get("dtype") or "").strip() or None
        dtype_name = (requested_dtype or "auto").lower()
        attn_implementation = str(request.get("attn_implementation") or "").strip()

        model_key = (model_name, device, dtype_name, attn_implementation)
        if self._model is None or self._model_key != model_key:
            model_kwargs: dict[str, object] = {
                "device_map": device,
                "dtype": resolve_torch_dtype(torch, device, requested_dtype),
            }
            if attn_implementation:
                model_kwargs["attn_implementation"] = attn_implementation
            self._model = model_class.from_pretrained(model_name, **model_kwargs)
            self._model_key = model_key

        return self._model, torch

    def health_payload(self) -> dict[str, object]:
        with self._lock:
            return {
                "status": "ok",
                "model": self._model_key[0] if self._model_key else None,
                "device": self._model_key[1] if self._model_key else None,
                "dtype": self._model_key[2] if self._model_key else None,
            }

    def warmup(self, request: dict[str, object]) -> dict[str, object]:
        speaker = require_non_empty_text(request.get("voice"), "Qwen local voice")
        narration_style = str(request.get("narration_style") or "").strip()
        warmup_text = str(request.get("warmup_text") or "Warmup voice check.")

        with self._lock:
            model, torch = self._load_model(request)
            request_kwargs: dict[str, object] = {
                "text": [warmup_text],
                "language": [qwen_local_language(warmup_text)],
                "speaker": [speaker],
            }
            if narration_style:
                request_kwargs["instruct"] = [narration_style]
            with torch.inference_mode():
                model.generate_custom_voice(**request_kwargs)

            model_name = self._model_key[0] if self._model_key else require_non_empty_text(request.get("model"), "Local Qwen model")
            return {
                "action": "warmup",
                "warmed": True,
                "model": model_name,
                "voice": speaker,
            }

    def synthesize(self, request: dict[str, object]) -> dict[str, object]:
        chunks = normalize_chunks(request.get("chunks"))
        output_dir = Path(require_non_empty_text(request.get("output_dir"), "Output directory")).expanduser().resolve()
        output_dir.mkdir(parents=True, exist_ok=True)

        speaker = require_non_empty_text(request.get("voice"), "Qwen local voice")
        batch_size = max(1, int(request.get("batch_size") or 4))
        narration_style = str(request.get("narration_style") or "").strip()

        output_files: list[str] = []
        sample_rate = 0
        chunk_index = 0

        with self._lock:
            model, torch = self._load_model(request)
            with torch.inference_mode():
                for batch in batched(chunks, batch_size):
                    languages = [qwen_local_language(item) for item in batch]
                    request_kwargs: dict[str, object] = {
                        "text": batch,
                        "language": languages,
                        "speaker": [speaker] * len(batch),
                    }
                    if narration_style:
                        request_kwargs["instruct"] = [narration_style] * len(batch)

                    wavs, sample_rate = model.generate_custom_voice(**request_kwargs)
                    for wav in coerce_wav_batch(wavs):
                        chunk_index += 1
                        output_path = output_dir / f"chunk_{chunk_index:05d}.wav"
                        write_wav(output_path, wav, sample_rate)
                        output_files.append(str(output_path))

            model_name = self._model_key[0] if self._model_key else require_non_empty_text(request.get("model"), "Local Qwen model")
            return {
                "action": "synthesize",
                "model": model_name,
                "voice": speaker,
                "sampleRate": sample_rate,
                "files": output_files,
            }


RUNTIME = QwenDaemonRuntime()


def run_request(request: dict[str, object]) -> dict[str, object]:
    action = str(request.get("action") or "synthesize").strip().lower()
    if action == "warmup":
        return RUNTIME.warmup(request)
    if action == "synthesize":
        return RUNTIME.synthesize(request)
    raise ValueError(f"Unsupported helper action: {action}")


class QwenDaemonHandler(BaseHTTPRequestHandler):
    server_version = "StorybookQwenDaemon/1.0"

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
    server = ThreadingHTTPServer((host, port), QwenDaemonHandler)
    server.daemon_threads = True
    print(json.dumps({"status": "listening", "host": host, "port": port}))
    server.serve_forever()
    return 0


def main() -> int:
    args = parse_args()
    if args.daemon:
        return serve_daemon(args.host, args.port)

    request = load_request(Path(args.input_json))
    print(json.dumps(run_request(request)))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
