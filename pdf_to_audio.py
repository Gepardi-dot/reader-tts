from __future__ import annotations

import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from bs4 import BeautifulSoup
from ebooklib import ITEM_DOCUMENT, epub
from pypdf import PdfReader


HOME = Path.home()
DEFAULT_ROOT = HOME / "piper-audiobooks"
DEFAULT_PIPER_EXE = HOME / "tools" / "piper" / "piper" / "piper.exe"
DEFAULT_ESPEAK_DATA = HOME / "tools" / "piper" / "piper" / "espeak-ng-data"
DEFAULT_MODEL = DEFAULT_ROOT / "voices" / "en_US-lessac-medium.onnx"
DEFAULT_FFMPEG_GLOB = (
    HOME
    / "AppData"
    / "Local"
    / "Microsoft"
    / "WinGet"
    / "Packages"
    / "*"
    / "*"
    / "bin"
    / "ffmpeg.exe"
)
SUPPORTED_EXTENSIONS = {".pdf", ".epub", ".txt"}


def find_binary(explicit: str | None, env_name: str, fallback: Path, glob_pattern: Path | None = None) -> Path:
    if explicit:
        candidate = Path(explicit).expanduser()
        if candidate.exists():
            return candidate
        raise FileNotFoundError(f"{env_name} path does not exist: {candidate}")

    env_value = os.environ.get(env_name)
    if env_value:
        candidate = Path(env_value).expanduser()
        if candidate.exists():
            return candidate
        raise FileNotFoundError(f"{env_name} path does not exist: {candidate}")

    if fallback.exists():
        return fallback

    which_name = fallback.name
    located = shutil.which(which_name)
    if located:
        return Path(located)

    if glob_pattern is not None:
        matches = sorted(Path(match) for match in glob.glob(str(glob_pattern)))
        if matches:
            return matches[-1]

    raise FileNotFoundError(f"Unable to locate {which_name}.")


def collect_inputs(input_paths: list[str]) -> list[Path]:
    results: list[Path] = []
    for raw_path in input_paths:
        path = Path(raw_path).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Input not found: {path}")

        if path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix.lower() in SUPPORTED_EXTENSIONS:
                    results.append(child)
        elif path.suffix.lower() in SUPPORTED_EXTENSIONS:
            results.append(path)

    unique: list[Path] = []
    seen: set[Path] = set()
    for path in results:
        if path not in seen:
            seen.add(path)
            unique.append(path)

    if not unique:
        raise FileNotFoundError("No supported input files were found.")

    return unique


def extract_pdf_text(path: Path) -> str:
    reader = PdfReader(str(path))
    pages: list[str] = []
    for page in reader.pages:
        pages.append(page.extract_text() or "")
    return "\n\n".join(pages)


def extract_epub_text(path: Path) -> str:
    book = epub.read_epub(str(path))
    parts: list[str] = []
    for item in book.get_items_of_type(ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_body_content(), "lxml")
        text = soup.get_text(" ", strip=True)
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def extract_txt_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return extract_pdf_text(path)
    if suffix == ".epub":
        return extract_epub_text(path)
    if suffix == ".txt":
        return extract_txt_text(path)
    raise ValueError(f"Unsupported file type: {path.suffix}")


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"(?m)^\s*\d+\s*$", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n +", "\n", text)
    text = re.sub(r" +\n", "\n", text)
    text = re.sub(r"\s*\n\s*", "\n", text)
    text = re.sub(r"\n{2,}", "\n\n", text)
    text = re.sub(r"[^\S\n]+", " ", text)
    return text.strip()


def split_long_text(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]

    pieces: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + max_chars, len(text))
        if end < len(text):
            split_at = max(
                text.rfind(". ", start, end),
                text.rfind("? ", start, end),
                text.rfind("! ", start, end),
                text.rfind("; ", start, end),
                text.rfind(", ", start, end),
                text.rfind(" ", start, end),
            )
            if split_at > start + int(max_chars * 0.5):
                end = split_at + 1
        chunk = text[start:end].strip()
        if chunk:
            pieces.append(chunk)
        start = end
    return pieces


def chunk_text(text: str, max_chars: int) -> list[str]:
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", text) if part.strip()]
    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", paragraph) if s.strip()]
        if not sentences:
            sentences = [paragraph]

        for sentence in sentences:
            candidates = split_long_text(sentence, max_chars)
            for candidate in candidates:
                if not current:
                    current = candidate
                    continue

                combined = f"{current} {candidate}"
                if len(combined) <= max_chars:
                    current = combined
                else:
                    chunks.append(current)
                    current = candidate

        if current:
            chunks.append(current)
            current = ""

    if current:
        chunks.append(current)

    return chunks


def run_subprocess(command: list[str], *, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        input=input_text,
        text=True,
        capture_output=True,
        check=True,
    )


def synthesize_chunks(
    chunks: list[str],
    *,
    piper_exe: Path,
    model_path: Path,
    config_path: Path,
    espeak_data: Path,
    output_dir: Path,
    speaker: int,
    length_scale: float,
    noise_scale: float,
    noise_w: float,
    sentence_silence: float,
) -> list[Path]:
    wav_paths: list[Path] = []
    for index, chunk in enumerate(chunks, start=1):
        wav_path = output_dir / f"chunk_{index:05d}.wav"
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
            str(speaker),
            "--length_scale",
            str(length_scale),
            "--noise_scale",
            str(noise_scale),
            "--noise_w",
            str(noise_w),
            "--sentence_silence",
            str(sentence_silence),
        ]
        run_subprocess(command, input_text=chunk)
        wav_paths.append(wav_path)
        print(f"[{index}/{len(chunks)}] synthesized {wav_path.name}")
    return wav_paths


def concat_with_ffmpeg(
    wav_paths: list[Path],
    *,
    ffmpeg_exe: Path,
    output_path: Path,
    codec: str,
) -> None:
    list_path = output_path.parent / f"{output_path.stem}_concat.txt"
    list_content = "\n".join(f"file '{path.as_posix()}'" for path in wav_paths)
    list_path.write_text(list_content, encoding="utf-8")

    if codec == "wav":
        command = [
            str(ffmpeg_exe),
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-c",
            "copy",
            str(output_path),
        ]
    elif codec == "mp3":
        command = [
            str(ffmpeg_exe),
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "22050",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "64k",
            str(output_path),
        ]
    elif codec == "m4b":
        command = [
            str(ffmpeg_exe),
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "22050",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    else:
        raise ValueError(f"Unsupported output format: {codec}")

    try:
        run_subprocess(command)
    finally:
        list_path.unlink(missing_ok=True)


def convert_file(
    input_path: Path,
    *,
    output_dir: Path,
    piper_exe: Path,
    ffmpeg_exe: Path,
    model_path: Path,
    config_path: Path,
    espeak_data: Path,
    format_name: str,
    chunk_size: int,
    speaker: int,
    length_scale: float,
    noise_scale: float,
    noise_w: float,
    sentence_silence: float,
    keep_chunks: bool,
) -> Path:
    print(f"Extracting text from {input_path} ...")
    raw_text = extract_text(input_path)
    cleaned = clean_text(raw_text)
    if not cleaned:
        raise ValueError(f"No extractable text found in {input_path}")

    chunks = chunk_text(cleaned, chunk_size)
    print(f"Prepared {len(chunks)} text chunk(s)")

    target_dir = output_dir / input_path.stem
    target_dir.mkdir(parents=True, exist_ok=True)
    final_path = target_dir / f"{input_path.stem}.{format_name}"

    if keep_chunks:
        chunk_dir = target_dir / "chunks"
        chunk_dir.mkdir(exist_ok=True)
        wav_dir_context = None
        wav_dir = chunk_dir
    else:
        wav_dir_context = tempfile.TemporaryDirectory(prefix="piper_chunks_", dir=str(target_dir))
        wav_dir = Path(wav_dir_context.name)

    try:
        wav_paths = synthesize_chunks(
            chunks,
            piper_exe=piper_exe,
            model_path=model_path,
            config_path=config_path,
            espeak_data=espeak_data,
            output_dir=wav_dir,
            speaker=speaker,
            length_scale=length_scale,
            noise_scale=noise_scale,
            noise_w=noise_w,
            sentence_silence=sentence_silence,
        )
        print(f"Combining audio into {final_path} ...")
        concat_with_ffmpeg(wav_paths, ffmpeg_exe=ffmpeg_exe, output_path=final_path, codec=format_name)
    finally:
        if wav_dir_context is not None:
            wav_dir_context.cleanup()

    return final_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert PDF, EPUB, or TXT files into speech using Piper.")
    parser.add_argument("inputs", nargs="+", help="One or more PDF/EPUB/TXT files or directories.")
    parser.add_argument("--output-dir", default=str(DEFAULT_ROOT / "output"), help="Directory for generated audio.")
    parser.add_argument("--voice-model", default=str(DEFAULT_MODEL), help="Path to a Piper .onnx voice model.")
    parser.add_argument("--voice-config", default=None, help="Path to the model config JSON.")
    parser.add_argument("--piper-exe", default=None, help="Path to piper.exe.")
    parser.add_argument("--ffmpeg-exe", default=None, help="Path to ffmpeg.exe.")
    parser.add_argument("--espeak-data", default=str(DEFAULT_ESPEAK_DATA), help="Path to Piper espeak-ng-data.")
    parser.add_argument("--format", choices=["mp3", "m4b", "wav"], default="mp3", help="Final audio format.")
    parser.add_argument("--chunk-size", type=int, default=900, help="Max characters per Piper synthesis chunk.")
    parser.add_argument("--speaker", type=int, default=0, help="Speaker id for multi-speaker voices.")
    parser.add_argument("--length-scale", type=float, default=1.0, help="Speech speed. Lower is faster.")
    parser.add_argument("--noise-scale", type=float, default=0.667, help="Voice variability.")
    parser.add_argument("--noise-w", type=float, default=0.8, help="Phoneme width noise.")
    parser.add_argument("--sentence-silence", type=float, default=0.2, help="Pause after each sentence in seconds.")
    parser.add_argument("--keep-chunks", action="store_true", help="Keep intermediate WAV files.")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    model_path = Path(args.voice_model).expanduser().resolve()
    if not model_path.exists():
        parser.error(f"Voice model not found: {model_path}")

    config_path = (
        Path(args.voice_config).expanduser().resolve()
        if args.voice_config
        else Path(f"{model_path}.json").resolve()
    )
    if not config_path.exists():
        parser.error(f"Voice config not found: {config_path}")

    espeak_data = Path(args.espeak_data).expanduser().resolve()
    if not espeak_data.exists():
        parser.error(f"espeak-ng data path not found: {espeak_data}")

    try:
        piper_exe = find_binary(args.piper_exe, "PIPER_EXE", DEFAULT_PIPER_EXE)
        ffmpeg_exe = find_binary(args.ffmpeg_exe, "FFMPEG_EXE", Path("ffmpeg.exe"), DEFAULT_FFMPEG_GLOB)
        input_files = collect_inputs(args.inputs)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    for input_file in input_files:
        try:
            final_path = convert_file(
                input_file,
                output_dir=output_dir,
                piper_exe=piper_exe,
                ffmpeg_exe=ffmpeg_exe,
                model_path=model_path,
                config_path=config_path,
                espeak_data=espeak_data,
                format_name=args.format,
                chunk_size=args.chunk_size,
                speaker=args.speaker,
                length_scale=args.length_scale,
                noise_scale=args.noise_scale,
                noise_w=args.noise_w,
                sentence_silence=args.sentence_silence,
                keep_chunks=args.keep_chunks,
            )
            print(f"Done: {final_path}")
        except subprocess.CalledProcessError as exc:
            print(exc.stderr or exc.stdout or str(exc), file=sys.stderr)
            return exc.returncode or 1
        except Exception as exc:
            print(f"Failed on {input_file}: {exc}", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
