from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
import wave
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import httpx
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
SUPPORTED_EXTENSIONS = {
    ".pdf",
    ".epub",
    ".txt",
    ".md",
    ".markdown",
    ".html",
    ".htm",
    ".xhtml",
    ".docx",
}
DEFAULT_GEMMA_CLEANUP_BASE_URL = (
    os.getenv("GEMMA_CLEANUP_BASE_URL") or os.getenv("GEMMA_BASE_URL") or "http://127.0.0.1:11434"
)
DEFAULT_GEMMA_CLEANUP_MODEL = os.getenv("GEMMA_CLEANUP_MODEL") or os.getenv("GEMMA_MODEL") or "gemma4:e2b"
DEFAULT_GEMMA_CLEANUP_TIMEOUT_SECONDS = float(
    os.getenv("GEMMA_CLEANUP_TIMEOUT_SECONDS") or "60"
)
DEFAULT_GEMMA_CLEANUP_MAX_CHARS = 700
DEFAULT_GEMMA_CLEANUP_CACHE_DIR = Path(
    os.getenv("GEMMA_CLEANUP_CACHE_DIR") or (DEFAULT_ROOT / "cleanup-cache")
).expanduser()
CLEANUP_CACHE_VERSION = "v1"
GEMMA_CLEANUP_SYSTEM_PROMPT = (
    "You clean extracted book text before text-to-speech. "
    "Repair extraction artifacts without rewriting the content. "
    "Preserve chapter headings, paragraph breaks, dialogue, and reading order. "
    "Merge single line breaks that only come from page layout into normal sentence spacing. "
    "Remove repeated headers, repeated footers, standalone page numbers, and obvious pagination noise. "
    "Fix broken line-wrap hyphenation only when the word clearly continues across the line break. "
    "Do not summarize, do not paraphrase, do not add new sentences, and do not censor the text. "
    "Return valid JSON only."
)


@dataclass(frozen=True)
class ExtractedBookText:
    text: str
    page_count: int
    format: str


def find_binary(explicit: str | None, env_name: str, fallback: Path, glob_pattern: Path | None = None) -> Path:
    def resolve_candidate(raw_value: str) -> Path | None:
        candidate = Path(raw_value).expanduser()
        if candidate.exists():
            return candidate

        located = shutil.which(raw_value)
        if located:
            return Path(located)

        return None

    if explicit:
        candidate = resolve_candidate(explicit)
        if candidate is not None:
            return candidate
        raise FileNotFoundError(f"{env_name} path does not exist: {explicit}")

    env_value = os.environ.get(env_name)
    if env_value:
        candidate = resolve_candidate(env_value)
        if candidate is not None:
            return candidate

    if fallback.exists():
        return fallback

    which_names = [fallback.name]
    if fallback.suffix.lower() == ".exe":
        which_names.append(fallback.stem)

    for which_name in which_names:
        located = shutil.which(which_name)
        if located:
            return Path(located)

    if glob_pattern is not None:
        matches = sorted(Path(match) for match in glob.glob(str(glob_pattern)))
        if matches:
            return matches[-1]

    if fallback.stem == "ffmpeg":
        try:
            import imageio_ffmpeg

            return Path(imageio_ffmpeg.get_ffmpeg_exe())
        except Exception:
            pass

    raise FileNotFoundError(f"Unable to locate {which_names[0]}.")


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
    try:
        reader = PdfReader(str(path), strict=False)
    except Exception as exc:
        raise ValueError(f"Invalid or unsupported PDF file: {path.name}") from exc

    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:
            pass

    pages: list[str] = []
    try:
        page_iterable = reader.pages
    except Exception as exc:
        raise ValueError(f"Invalid or unsupported PDF file: {path.name}") from exc

    for page in page_iterable:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            pages.append("")
    return "\n\n".join(pages)


def _html_to_reading_text(markup: bytes | str) -> str:
    soup = BeautifulSoup(markup, "lxml")
    for tag in soup(["script", "style", "noscript", "svg", "canvas"]):
        tag.decompose()

    root = soup.body or soup
    block_selectors = [
        "h1", "h2", "h3", "h4", "h5", "h6",
        "p", "blockquote", "li", "pre", "td", "th",
    ]
    parts: list[str] = []
    for node in root.find_all(block_selectors):
        text = node.get_text(" ", strip=True)
        if text:
            parts.append(text)

    if not parts:
        fallback = root.get_text("\n\n", strip=True)
        return fallback
    return "\n\n".join(parts)


def extract_epub_text(path: Path) -> str:
    book = epub.read_epub(str(path))
    item_by_id = {item.get_id(): item for item in book.get_items_of_type(ITEM_DOCUMENT)}
    parts: list[str] = []

    ordered_items = []
    for spine_item in book.spine:
        item_id = spine_item[0] if isinstance(spine_item, tuple) else spine_item
        item = item_by_id.get(str(item_id))
        if item is not None:
            ordered_items.append(item)
    if not ordered_items:
        ordered_items = list(book.get_items_of_type(ITEM_DOCUMENT))

    seen: set[str] = set()
    for item in ordered_items:
        item_id = item.get_id()
        if item_id in seen:
            continue
        seen.add(item_id)
        text = _html_to_reading_text(item.get_body_content())
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def extract_txt_text(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def extract_markdown_text(path: Path) -> str:
    text = extract_txt_text(path)
    text = re.sub(r"(?s)\A---\s*\n.*?\n---\s*\n", "", text, count=1)
    text = re.sub(r"(?s)```.*?```", "", text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", text)
    text = re.sub(r"(?m)^\s{0,3}>\s?", "", text)
    text = re.sub(r"(?m)^\s*[-*+]\s+", "", text)
    text = re.sub(r"(?m)^\s*\d+[.)]\s+", "", text)
    text = re.sub(r"[*_`]{1,3}", "", text)
    return text


def extract_html_text(path: Path) -> str:
    return _html_to_reading_text(path.read_bytes())


def extract_docx_text(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            xml_bytes = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile) as exc:
        raise ValueError(f"Invalid DOCX file: {path.name}") from exc

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise ValueError(f"Invalid DOCX document XML: {path.name}") from exc
    paragraphs: list[str] = []
    for paragraph in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p"):
        pieces: list[str] = []
        for node in paragraph.iter():
            tag = node.tag.rsplit("}", 1)[-1]
            if tag == "t" and node.text:
                pieces.append(node.text)
            elif tag == "tab":
                pieces.append("\t")
            elif tag in {"br", "cr"}:
                pieces.append("\n")
        text = "".join(pieces).strip()
        if text:
            paragraphs.append(text)
    return "\n\n".join(paragraphs)


def estimate_page_count(text: str, *, chars_per_page: int = 1800) -> int:
    stripped = text.strip()
    if not stripped:
        return 0
    return max(1, (len(stripped) + chars_per_page - 1) // chars_per_page)


def extract_book_text(path: Path) -> ExtractedBookText:
    suffix = path.suffix.lower()
    text = extract_text(path)
    if suffix == ".pdf":
        try:
            page_count = len(PdfReader(str(path)).pages)
        except Exception:
            page_count = estimate_page_count(text)
    elif suffix == ".epub":
        try:
            book = epub.read_epub(str(path))
            page_count = len(book.spine) or estimate_page_count(text)
        except Exception:
            page_count = estimate_page_count(text)
    else:
        page_count = estimate_page_count(text)
    return ExtractedBookText(text=text, page_count=page_count, format=suffix.lstrip("."))


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return extract_pdf_text(path)
    if suffix == ".epub":
        return extract_epub_text(path)
    if suffix == ".txt":
        return extract_txt_text(path)
    if suffix in {".md", ".markdown"}:
        return extract_markdown_text(path)
    if suffix in {".html", ".htm", ".xhtml"}:
        return extract_html_text(path)
    if suffix == ".docx":
        return extract_docx_text(path)
    raise ValueError(f"Unsupported file type: {path.suffix}")


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = merge_wrapped_lines(text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"(?m)^\s*\d+\s*$", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n +", "\n", text)
    text = re.sub(r" +\n", "\n", text)
    text = re.sub(r"[ \t]*\n[ \t]*", "\n", text)
    text = re.sub(r"\n{2,}", "\n\n", text)
    text = re.sub(r"[^\S\n]+", " ", text)
    return text.strip()


def _normalize_cleanup_input(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\t+", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    text = merge_wrapped_lines(text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def _looks_like_heading_or_label(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if len(stripped) <= 40 and stripped.isupper():
        return True
    if len(stripped) <= 40 and re.fullmatch(r"[A-Z][A-Za-z0-9'’\-]*(?: [A-Z][A-Za-z0-9'’\-]*){0,5}", stripped):
        return True
    if re.fullmatch(r"\d{1,2}/\d{1,2}/\d{2,4}", stripped):
        return True
    return False


def _should_merge_line_break(current: str, following: str) -> bool:
    current = current.rstrip()
    following = following.lstrip()
    if not current or not following:
        return False
    if _looks_like_heading_or_label(current) or _looks_like_heading_or_label(following):
        return False
    if re.match(r"^[—-]\s*[A-Z]", following):
        return False
    if current.endswith((".", "!", "?", ":", ";")):
        return False
    if len(current) < 35 and current[-1:].isalnum() and not re.match(r"^[a-z]", following):
        return False
    return True


def merge_wrapped_lines(text: str) -> str:
    lines = text.split("\n")
    merged: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index].rstrip()
        if not line.strip():
            merged.append("")
            index += 1
            continue

        current = line.strip()
        index += 1
        while index < len(lines):
            next_line = lines[index].rstrip()
            if not next_line.strip():
                break
            if not _should_merge_line_break(current, next_line):
                break
            current = f"{current} {next_line.strip()}"
            index += 1
        merged.append(current)
    return "\n".join(merged)


def chunk_needs_gemma_cleanup(text: str) -> bool:
    if not text.strip():
        return False

    score = 0
    if re.search(r"(\w)-\n(\w)", text):
        score += 3
    if re.search(r"(?m)^\s*\d+\s*$", text):
        score += 2
    if re.search(r"\w[^\n]{0,80}\n[a-z]", text):
        score += 2
    if re.search(r"(?m)^[—-]\s*[A-Z]", text):
        score += 1

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    short_lines = [line for line in lines if len(line) < 60]
    if len(lines) >= 5 and len(short_lines) >= max(2, len(lines) // 2):
        score += 2

    return score >= 2


def _extract_json_object(raw: str) -> dict[str, object]:
    text = raw.strip()
    if not text:
        raise ValueError("Gemma cleanup returned an empty response.")
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
        if text.lower().startswith("json"):
            text = text[4:].lstrip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end <= start:
            raise
        parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("Gemma cleanup response was not a JSON object.")
    return parsed


def _build_cleanup_prompt(text: str) -> dict[str, object]:
    return {
        "task": "Clean extracted book text for text-to-speech without changing meaning.",
        "rules": [
            "Keep the original wording and reading order.",
            "Preserve chapter headings and paragraph breaks when they are present.",
            "Merge single wrapped line breaks inside normal paragraphs into spaces.",
            "Remove repeated headers, repeated footers, standalone page numbers, and obvious scanner noise.",
            "Repair broken line-wrap hyphenation only when the continuation is obvious.",
            "Keep dialogue and punctuation natural for narration.",
            "Do not summarize, paraphrase, annotate, or continue the text.",
            "Return JSON only with the key cleanedText.",
        ],
        "text": text,
    }


def _cleanup_chunk_cache_key(
    text: str,
    *,
    model: str,
    max_chars: int,
) -> str:
    digest = hashlib.sha256()
    digest.update(CLEANUP_CACHE_VERSION.encode("utf-8"))
    digest.update(b"\0")
    digest.update(model.encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(max_chars).encode("utf-8"))
    digest.update(b"\0")
    digest.update(GEMMA_CLEANUP_SYSTEM_PROMPT.encode("utf-8"))
    digest.update(b"\0")
    digest.update(text.encode("utf-8"))
    return digest.hexdigest()


def _cleanup_cache_path(cache_dir: Path, cache_key: str) -> Path:
    return cache_dir / cache_key[:2] / f"{cache_key}.json"


def read_cleanup_cache(cache_dir: Path, cache_key: str) -> str | None:
    cache_path = _cleanup_cache_path(cache_dir, cache_key)
    if not cache_path.exists():
        return None
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    cleaned_text = payload.get("cleanedText")
    return str(cleaned_text) if isinstance(cleaned_text, str) and cleaned_text.strip() else None


def write_cleanup_cache(cache_dir: Path, cache_key: str, cleaned_text: str) -> None:
    cache_path = _cleanup_cache_path(cache_dir, cache_key)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": CLEANUP_CACHE_VERSION,
        "cleanedText": cleaned_text,
    }
    cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def cleanup_output_is_valid(original_text: str, cleaned_text: str) -> bool:
    original = clean_text(original_text)
    cleaned = clean_text(cleaned_text)
    if not cleaned:
        return False
    if not original:
        return bool(cleaned)

    original_len = len(original)
    cleaned_len = len(cleaned)
    if cleaned_len < max(40, int(original_len * 0.55)):
        return False
    if cleaned_len > int(original_len * 1.2):
        return False

    original_words = {word.lower() for word in re.findall(r"[A-Za-z][A-Za-z'’-]*", original)}
    cleaned_words = {word.lower() for word in re.findall(r"[A-Za-z][A-Za-z'’-]*", cleaned)}
    if original_words:
        retained_ratio = len(original_words & cleaned_words) / max(1, len(original_words))
        if retained_ratio < 0.7:
            return False

    if original.count("\n\n") >= 1 and cleaned.count("\n\n") == 0 and len(cleaned) > 300:
        return False

    return True


def clean_text_with_gemma(
    text: str,
    *,
    base_url: str,
    model: str,
    timeout_seconds: float,
    max_chars: int,
    cache_dir: Path | None = None,
) -> str:
    prepared = _normalize_cleanup_input(text)
    if not prepared:
        return ""

    cleanup_chunks = chunk_text(prepared, max_chars=max_chars)
    cleaned_chunks: list[str] = []
    stats = {
        "cache_hits": 0,
        "gemma_cleaned": 0,
        "regex_skipped": 0,
        "fallback_errors": 0,
        "fallback_invalid": 0,
    }
    resolved_cache_dir = cache_dir.expanduser() if cache_dir is not None else DEFAULT_GEMMA_CLEANUP_CACHE_DIR

    for index, chunk in enumerate(cleanup_chunks, start=1):
        if not chunk_needs_gemma_cleanup(chunk):
            cleaned_chunks.append(clean_text(chunk))
            stats["regex_skipped"] += 1
            print(f"[cleanup {index}/{len(cleanup_chunks)}] regex-clean chunk was already structurally clean")
            continue
        cache_key = _cleanup_chunk_cache_key(chunk, model=model, max_chars=max_chars)
        cached = read_cleanup_cache(resolved_cache_dir, cache_key)
        if cached is not None and cleanup_output_is_valid(chunk, cached):
            cleaned_chunks.append(clean_text(cached))
            stats["cache_hits"] += 1
            print(f"[cleanup {index}/{len(cleanup_chunks)}] cache hit")
            continue
        prompt = _build_cleanup_prompt(chunk)
        try:
            response = httpx.post(
                f"{base_url.rstrip('/')}/api/chat",
                json={
                    "model": model,
                    "stream": False,
                    "format": "json",
                    "think": False,
                    "messages": [
                        {
                            "role": "system",
                            "content": GEMMA_CLEANUP_SYSTEM_PROMPT,
                        },
                        {
                            "role": "user",
                            "content": json.dumps(prompt),
                        },
                    ],
                    "options": {
                        "temperature": 0.1,
                    },
                },
                timeout=httpx.Timeout(timeout_seconds, connect=min(10.0, timeout_seconds)),
            )
            response.raise_for_status()
            payload = response.json()
            message = payload.get("message") if isinstance(payload, dict) else None
            raw_content = ""
            if isinstance(message, dict):
                raw_content = str(message.get("content") or "").strip()
            if not raw_content and isinstance(payload, dict):
                raw_content = str(payload.get("response") or "").strip()
            parsed = _extract_json_object(raw_content)
            cleaned_text = str(parsed.get("cleanedText") or "").strip()
            if cleaned_text and cleanup_output_is_valid(chunk, cleaned_text):
                normalized_cleaned = clean_text(cleaned_text)
                cleaned_chunks.append(normalized_cleaned)
                write_cleanup_cache(resolved_cache_dir, cache_key, normalized_cleaned)
                stats["gemma_cleaned"] += 1
                print(f"[cleanup {index}/{len(cleanup_chunks)}] Gemma cleaned text chunk")
            else:
                cleaned_chunks.append(clean_text(chunk))
                stats["fallback_invalid"] += 1
                print(f"[cleanup {index}/{len(cleanup_chunks)}] invalid Gemma cleanup, used regex fallback")
        except Exception:
            cleaned_chunks.append(clean_text(chunk))
            stats["fallback_errors"] += 1
            print(f"[cleanup {index}/{len(cleanup_chunks)}] Gemma unavailable, used regex fallback")

    print(
        "[cleanup summary] "
        f"cache_hits={stats['cache_hits']} "
        f"gemma_cleaned={stats['gemma_cleaned']} "
        f"regex_skipped={stats['regex_skipped']} "
        f"fallback_errors={stats['fallback_errors']} "
        f"fallback_invalid={stats['fallback_invalid']}"
    )
    return clean_text("\n\n".join(part for part in cleaned_chunks if part))


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


def chunk_paragraph(paragraph: str, max_chars: int) -> list[str]:
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", paragraph) if s.strip()]
    if not sentences:
        sentences = [paragraph]

    chunks: list[str] = []
    current = ""

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

    return chunks


def chunk_text(text: str, max_chars: int) -> list[str]:
    paragraphs = [part.strip() for part in re.split(r"\n{2,}", text) if part.strip()]
    chunks: list[str] = []
    current_parts: list[str] = []
    current_length = 0

    def flush_current() -> None:
        nonlocal current_parts, current_length
        if current_parts:
            chunks.append("\n\n".join(current_parts))
            current_parts = []
            current_length = 0

    for paragraph in paragraphs:
        paragraph_chunks = chunk_paragraph(paragraph, max_chars)
        for paragraph_chunk in paragraph_chunks:
            if not current_parts:
                current_parts = [paragraph_chunk]
                current_length = len(paragraph_chunk)
                continue

            combined_length = current_length + 2 + len(paragraph_chunk)
            if combined_length <= max_chars:
                current_parts.append(paragraph_chunk)
                current_length = combined_length
            else:
                flush_current()
                current_parts = [paragraph_chunk]
                current_length = len(paragraph_chunk)

    flush_current()

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
            "-vn",
            "-ac",
            "1",
            "-ar",
            "24000",
            "-c:a",
            "pcm_s16le",
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


def normalize_wav_with_ffmpeg(
    input_path: Path,
    *,
    ffmpeg_exe: Path,
    output_path: Path,
    sample_rate: int = 24000,
) -> None:
    command = [
        str(ffmpeg_exe),
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    run_subprocess(command)


def concat_wav_files(wav_paths: list[Path], *, output_path: Path) -> None:
    if not wav_paths:
        raise ValueError("No WAV chunks were provided.")

    with wave.open(str(wav_paths[0]), "rb") as first:
        params = first.getparams()
        chunks = [first.readframes(first.getnframes())]

    for wav_path in wav_paths[1:]:
        with wave.open(str(wav_path), "rb") as handle:
            if handle.getparams()[:4] != params[:4]:
                raise ValueError("WAV chunks do not share the same audio format.")
            chunks.append(handle.readframes(handle.getnframes()))

    with wave.open(str(output_path), "wb") as output:
        output.setparams(params)
        for chunk in chunks:
            output.writeframes(chunk)


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
    gemma_cleanup: bool,
    gemma_cleanup_base_url: str,
    gemma_cleanup_model: str,
    gemma_cleanup_timeout_seconds: float,
    gemma_cleanup_max_chars: int,
    gemma_cleanup_cache_dir: Path,
) -> Path:
    print(f"Extracting text from {input_path} ...")
    raw_text = extract_text(input_path)
    if gemma_cleanup:
        print("Running optional Gemma cleanup before chunking ...")
        cleaned = clean_text_with_gemma(
            raw_text,
            base_url=gemma_cleanup_base_url,
            model=gemma_cleanup_model,
            timeout_seconds=gemma_cleanup_timeout_seconds,
            max_chars=gemma_cleanup_max_chars,
            cache_dir=gemma_cleanup_cache_dir,
        )
    else:
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
    parser.add_argument(
        "--gemma-cleanup",
        action="store_true",
        help="Use a local Gemma/Ollama cleanup pass before TTS chunking. Falls back to regex cleanup on failure.",
    )
    parser.add_argument(
        "--gemma-cleanup-base-url",
        default=DEFAULT_GEMMA_CLEANUP_BASE_URL,
        help="Base URL for the local Gemma/Ollama runtime.",
    )
    parser.add_argument(
        "--gemma-cleanup-model",
        default=DEFAULT_GEMMA_CLEANUP_MODEL,
        help="Local Gemma model to use for pre-TTS cleanup.",
    )
    parser.add_argument(
        "--gemma-cleanup-timeout",
        type=float,
        default=DEFAULT_GEMMA_CLEANUP_TIMEOUT_SECONDS,
        help="Timeout in seconds for each Gemma cleanup chunk.",
    )
    parser.add_argument(
        "--gemma-cleanup-max-chars",
        type=int,
        default=DEFAULT_GEMMA_CLEANUP_MAX_CHARS,
        help="Maximum characters per Gemma cleanup chunk.",
    )
    parser.add_argument(
        "--gemma-cleanup-cache-dir",
        default=str(DEFAULT_GEMMA_CLEANUP_CACHE_DIR),
        help="Directory for persistent Gemma cleanup chunk cache files.",
    )
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
                gemma_cleanup=args.gemma_cleanup,
                gemma_cleanup_base_url=args.gemma_cleanup_base_url,
                gemma_cleanup_model=args.gemma_cleanup_model,
                gemma_cleanup_timeout_seconds=args.gemma_cleanup_timeout,
                gemma_cleanup_max_chars=args.gemma_cleanup_max_chars,
                gemma_cleanup_cache_dir=Path(args.gemma_cleanup_cache_dir).expanduser().resolve(),
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
