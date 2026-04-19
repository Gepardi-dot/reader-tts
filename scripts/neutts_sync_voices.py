#!/usr/bin/env python3
"""
neutts_sync_voices.py — Push local voice packs to the remote NeuTTS server.

Usage:
    python scripts/neutts_sync_voices.py
    python scripts/neutts_sync_voices.py --voice arthur-storyteller
    python scripts/neutts_sync_voices.py --url https://neutts.railway.app --key mysecret

The script reads NEUTTS_REMOTE_URL and NEUTTS_REMOTE_API_KEY from the environment
(or .env file at the repo root) if not passed via flags.

Voice pack directory: voices/neutts/<voice_id>/
Required files:  reference.wav, reference.txt
Optional files:  meta.json
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env() -> None:
    """Load .env from repo root if present (no external deps)."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def read_voice_pack(voice_dir: Path) -> dict | None:
    """Return the upload payload for a voice pack, or None if incomplete."""
    wav_path = voice_dir / "reference.wav"
    txt_path = voice_dir / "reference.txt"
    if not wav_path.exists() or not txt_path.exists():
        return None

    files: dict[str, str] = {
        "reference.wav": base64.b64encode(wav_path.read_bytes()).decode(),
        "reference.txt": txt_path.read_text(encoding="utf-8"),
    }
    meta_path = voice_dir / "meta.json"
    if meta_path.exists():
        files["meta.json"] = meta_path.read_text(encoding="utf-8")

    return {"voice_id": voice_dir.name, "files": files}


def sync_voice(url: str, api_key: str, payload: dict) -> None:
    voice_id = payload["voice_id"]
    wav_size_kb = len(base64.b64decode(payload["files"]["reference.wav"])) // 1024
    print(f"  → uploading {voice_id}  ({wav_size_kb} kB reference.wav) ... ", end="", flush=True)

    body = json.dumps(payload).encode()
    headers = {
        "Content-Type": "application/json",
        "Content-Length": str(len(body)),
    }
    if api_key:
        headers["X-Api-Key"] = api_key

    req = urllib.request.Request(f"{url}/v1/voices/sync", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
        if result.get("ok"):
            print(f"done  (wrote: {', '.join(result.get('written', []))})")
        else:
            print(f"FAILED: {result.get('error', 'unknown error')}")
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")[:200]
        print(f"FAILED  HTTP {exc.code}: {body_text}")
    except Exception as exc:
        print(f"FAILED: {exc}")


def main() -> None:
    load_env()

    parser = argparse.ArgumentParser(description="Sync NeuTTS voice packs to remote server.")
    parser.add_argument("--url",   default=os.environ.get("NEUTTS_REMOTE_URL", ""),   help="Remote server URL")
    parser.add_argument("--key",   default=os.environ.get("NEUTTS_REMOTE_API_KEY", ""), help="API key")
    parser.add_argument("--voice", default="", help="Sync only this voice pack (e.g. arthur-storyteller)")
    parser.add_argument("--voices-dir", default=str(ROOT / "voices" / "neutts"), help="Local voices directory")
    args = parser.parse_args()

    url = args.url.rstrip("/")
    if not url:
        print("ERROR: NEUTTS_REMOTE_URL is not set. Pass --url or set it in .env", file=sys.stderr)
        sys.exit(1)

    voices_dir = Path(args.voices_dir)
    if not voices_dir.is_dir():
        print(f"ERROR: voices directory not found: {voices_dir}", file=sys.stderr)
        sys.exit(1)

    # Check server is reachable
    print(f"Connecting to {url} ...")
    try:
        with urllib.request.urlopen(f"{url}/v1/health", timeout=10) as resp:
            health = json.loads(resp.read())
        print(f"  Server status: {health.get('status')}  model={health.get('model') or 'not loaded'}")
    except Exception as exc:
        print(f"ERROR: cannot reach server: {exc}", file=sys.stderr)
        sys.exit(1)

    # Collect voice packs
    if args.voice:
        target_dirs = [voices_dir / args.voice]
    else:
        target_dirs = sorted(d for d in voices_dir.iterdir() if d.is_dir())

    if not target_dirs:
        print("No voice packs found.")
        return

    print(f"\nSyncing {len(target_dirs)} voice pack(s):")
    skipped = 0
    for voice_dir in target_dirs:
        payload = read_voice_pack(voice_dir)
        if payload is None:
            print(f"  → skipping {voice_dir.name}  (missing reference.wav or reference.txt)")
            skipped += 1
            continue
        sync_voice(url, args.key, payload)

    print(f"\nDone. ({skipped} skipped — no reference.wav)")
    if skipped:
        print("  Add a reference.wav recording to complete those voice packs.")


if __name__ == "__main__":
    main()
