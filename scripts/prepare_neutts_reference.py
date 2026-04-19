from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NEUTTS_VOICES_ROOT = ROOT / "voices" / "neutts"
NEUTTS_HELPER = ROOT / "scripts" / "neutts_wsl_tts.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a local NeuTTS reference pack and pre-encode reference.pt in WSL.")
    parser.add_argument("--voice-id", required=True, help="Folder name under voices/neutts.")
    parser.add_argument("--reference-audio", required=True, help="Path to a mono-ish WAV voice sample.")
    parser.add_argument(
        "--reference-text",
        required=True,
        help="Path to a text transcript file, or the transcript text itself.",
    )
    parser.add_argument("--label", help="Human-friendly label shown in the UI.")
    parser.add_argument("--gender", choices=["male", "female", "neutral"])
    parser.add_argument("--style", help="Optional style label shown in the UI.")
    parser.add_argument("--tag", action="append", default=[], help="Optional UI tag. Repeat for multiple tags.")
    parser.add_argument("--model", action="append", default=[], help="Optional allowed model id. Repeat for multiple models.")
    parser.add_argument("--distro", default=os.environ.get("NEUTTS_WSL_DISTRO", "Ubuntu"))
    parser.add_argument("--user", default=os.environ.get("NEUTTS_WSL_USER"))
    parser.add_argument("--wsl-python", default=os.environ.get("NEUTTS_WSL_PYTHON"))
    parser.add_argument("--hf-home", default=os.environ.get("NEUTTS_WSL_HF_HOME"))
    parser.add_argument("--skip-encode", action="store_true", help="Only create the reference pack files; do not build reference.pt.")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing reference pack.")
    return parser.parse_args()


def windows_path_to_wsl(path: Path | str) -> str:
    resolved = str(Path(path).expanduser().resolve()).replace("\\", "/")
    if len(resolved) >= 3 and resolved[1:3] == ":/":
        return f"/mnt/{resolved[0].lower()}{resolved[2:]}"
    return resolved


def resolve_wsl_executable() -> Path:
    for candidate in ("wsl.exe", "wsl"):
        located = shutil.which(candidate)
        if located:
            return Path(located).resolve()

    system_root = os.environ.get("SystemRoot")
    if system_root:
        candidate = Path(system_root) / "System32" / "wsl.exe"
        if candidate.exists():
            return candidate.resolve()

    raise RuntimeError("WSL is not available on this machine.")


def load_reference_text(value: str) -> str:
    candidate = Path(value).expanduser()
    if candidate.exists():
        return candidate.read_text(encoding="utf-8").strip()
    return value.strip()


def write_reference_pack(args: argparse.Namespace) -> Path:
    voice_dir = NEUTTS_VOICES_ROOT / args.voice_id
    if voice_dir.exists() and not args.force:
        raise RuntimeError(f"Reference pack already exists: {voice_dir}. Use --force to overwrite it.")

    audio_path = Path(args.reference_audio).expanduser().resolve()
    if not audio_path.exists():
        raise RuntimeError(f"Reference audio file not found: {audio_path}")
    if audio_path.suffix.lower() != ".wav":
        raise RuntimeError("NeuTTS reference audio must be provided as a WAV file.")

    voice_dir.mkdir(parents=True, exist_ok=True)
    stale_codes = voice_dir / "reference.pt"
    stale_codes.unlink(missing_ok=True)
    shutil.copyfile(audio_path, voice_dir / "reference.wav")
    (voice_dir / "reference.txt").write_text(load_reference_text(args.reference_text), encoding="utf-8")

    meta: dict[str, object] = {}
    if args.label:
        meta["label"] = args.label.strip()
    if args.gender:
        meta["gender"] = args.gender
        meta["genderSource"] = "estimated"
    if args.style:
        meta["style"] = args.style.strip()
    tags = [item.strip() for item in args.tag if item.strip()]
    if tags:
        meta["tags"] = tags
    models = [item.strip() for item in args.model if item.strip()]
    if models:
        meta["models"] = models
    meta_path = voice_dir / "meta.json"
    if meta:
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    else:
        meta_path.unlink(missing_ok=True)

    return voice_dir


def encode_reference_pack(
    voice_dir: Path,
    *,
    distro: str,
    user: str | None,
    wsl_python: str,
    hf_home: str | None,
) -> dict[str, object]:
    if not NEUTTS_HELPER.exists():
        raise RuntimeError(f"Missing NeuTTS helper script: {NEUTTS_HELPER}")

    payload: dict[str, object] = {
        "action": "prepare_reference",
        "reference_dir": windows_path_to_wsl(voice_dir),
    }
    if hf_home:
        payload["hf_home"] = hf_home

    with tempfile.TemporaryDirectory(prefix="storybook_neutts_ref_") as temp_dir:
        request_path = Path(temp_dir) / "request.json"
        request_path.write_text(json.dumps(payload), encoding="utf-8")

        command = [str(resolve_wsl_executable()), "-d", distro]
        if user:
            command.extend(["-u", user])
        command.extend(
            [
                "--",
                wsl_python,
                windows_path_to_wsl(NEUTTS_HELPER),
                "--input-json",
                windows_path_to_wsl(request_path),
            ]
        )
        completed = subprocess.run(command, text=True, capture_output=True, check=True)

    lines = [line.strip() for line in (completed.stdout or "").splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("NeuTTS reference preparation did not return a result manifest.")
    return json.loads(lines[-1])


def main() -> int:
    args = parse_args()
    if not args.skip_encode and not args.wsl_python:
        raise RuntimeError("Set --wsl-python or NEUTTS_WSL_PYTHON to the Linux Python path inside your NeuTTS venv.")

    voice_dir = write_reference_pack(args)
    if args.skip_encode:
        result = {
            "action": "prepare_reference",
            "voicePack": voice_dir.name,
            "codesPath": None,
            "codeCount": None,
            "encoded": False,
        }
    else:
        result = encode_reference_pack(
            voice_dir,
            distro=args.distro,
            user=(args.user or "").strip() or None,
            wsl_python=args.wsl_python,
            hf_home=(args.hf_home or "").strip() or None,
        )
        result["encoded"] = True

    print(json.dumps({"voiceDir": str(voice_dir), **result}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
