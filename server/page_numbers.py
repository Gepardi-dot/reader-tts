"""Printed page furniture left in extracted book text.

Keep in sync with web-next/src/shared/books/pageNumbers.ts and
cloudflare/worker/src/pageNumbers.ts.
"""

from __future__ import annotations

import re
import wave
from pathlib import Path

_PAGE_LABEL = re.compile(
    r"^(?:page|pg|p)\.?\s*\d{1,4}(?:\s*(?:of|/)\s*\d{1,4})?$",
    re.IGNORECASE,
)
_PAGE_FRACTION = re.compile(r"^\d{1,4}\s*(?:/|of)\s*\d{1,4}$", re.IGNORECASE)
_DECORATED = re.compile(r"^[-–—~*•.]+\s*\d{1,4}\s*[-–—~*•.]+$")
_BRACKETED = re.compile(r"^(?:\[|\()\s*\d{1,4}\s*(?:\]|\))$")
_BARE = re.compile(r"^(\d{1,4})[.)]?$")
_TRAILING_PAGE = re.compile(r"^(.*[.!?])([\"'”’)]*)\s+(\d{1,4})\s*$")
_TRAILING_ABBREV = re.compile(
    r"\b(?:Mr|Mrs|Ms|Dr|St|Prof|Jr|Sr|vs|etc|fig|vol|no|pp|p|ch|sec|ed|rev|gen|cf)\.$",
    re.IGNORECASE,
)


def prose_without_trailing_page_number(line: str) -> str | None:
    match = _TRAILING_PAGE.match(line)
    if not match:
        return None
    value = int(match.group(3))
    if 1000 <= value <= 2099:
        return None
    prose = f"{match.group(1)}{match.group(2)}"
    if not prose.strip() or _TRAILING_ABBREV.search(prose):
        return None
    return prose


def is_page_number_line(line: str) -> bool:
    trimmed = line.strip()
    if not trimmed:
        return False
    if _PAGE_LABEL.match(trimmed) or _PAGE_FRACTION.match(trimmed) or _DECORATED.match(trimmed):
        return True
    if _BRACKETED.match(trimmed):
        return True
    bare = _BARE.match(trimmed)
    if not bare:
        return False
    value = int(bare.group(1))
    if 1000 <= value <= 2099:
        return False
    return True


def speech_text_without_page_numbers(text: str) -> str:
    """Return the original string when nothing was removed, so cache hashes stay stable."""
    if not text:
        return text
    lines = text.split("\n")
    removed = False
    kept: list[str] = []
    for line in lines:
        if is_page_number_line(line):
            removed = True
            continue
        prose = prose_without_trailing_page_number(line)
        if prose is not None:
            removed = True
            if prose:
                kept.append(prose)
            continue
        kept.append(line)
    if not removed:
        return text
    spoken = "\n".join(kept)
    spoken = re.sub(r"\n{3,}", "\n\n", spoken)
    return spoken.strip()


def write_silent_wav(path: Path, duration_sec: float = 0.12, sample_rate: int = 24000) -> None:
    frames = max(1, int(duration_sec * sample_rate))
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * frames)
