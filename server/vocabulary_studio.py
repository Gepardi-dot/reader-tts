from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Literal

import httpx
from fastapi import APIRouter, HTTPException
from fsrs import Card, Rating as FsrsRating, Scheduler, State as FsrsState
from pydantic import BaseModel, Field


def _dialect() -> str:
    """Return 'postgres' if a Supabase pooler/DB URL is configured, else 'sqlite'."""
    url = (
        os.getenv("SUPABASE_POOLER_URL")
        or os.getenv("SUPABASE_DB_URL")
        or os.getenv("DATABASE_URL")
    )
    return "postgres" if url else "sqlite"


def _supabase_db_url() -> str | None:
    return (
        os.getenv("SUPABASE_POOLER_URL")
        or os.getenv("SUPABASE_DB_URL")
        or os.getenv("DATABASE_URL")
    )


_TS_PARAM_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")


def _pg_param(value: Any) -> Any:
    """Adapt a sqlite-style param to psycopg.

    The codebase passes ISO 8601 strings for timestamps and json.dumps strings
    for JSON columns. psycopg needs datetimes for timestamptz comparisons; jsonb
    inserts go through `_jp()` which already wraps in psycopg's Jsonb adapter.
    """
    if isinstance(value, str) and _TS_PARAM_RE.match(value):
        if value.endswith("Z"):
            normalized = f"{value[:-1]}+00:00"
        else:
            normalized = value
        try:
            return datetime.fromisoformat(normalized)
        except ValueError:
            return value
    return value


def _jp(value: Any) -> Any:
    """Encode a Python value for a JSON-typed column (jsonb on Postgres, text on SQLite)."""
    if value is None:
        return None
    if _dialect() == "postgres":
        from psycopg.types.json import Jsonb

        if isinstance(value, str):
            try:
                value = json.loads(value) if value else None
            except json.JSONDecodeError:
                return None
        return Jsonb(value) if value is not None else None
    if isinstance(value, str):
        return value
    return json.dumps(value)


class _HybridRow:
    """Row that supports both sqlite3.Row (`row["col"]`, `row[0]`) and dict semantics."""

    __slots__ = ("_columns", "_values", "_lookup")

    def __init__(self, columns: list[str], values: list[Any]) -> None:
        self._columns = columns
        self._values = list(values)
        self._lookup = {name: idx for idx, name in enumerate(columns)}

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return self._values[key]
        return self._values[self._lookup[key]]

    def __contains__(self, key: Any) -> bool:
        return key in self._lookup

    def keys(self) -> list[str]:
        return list(self._columns)

    def get(self, key: str, default: Any = None) -> Any:
        idx = self._lookup.get(key)
        return self._values[idx] if idx is not None else default

    def __iter__(self):
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)


def _hybrid_row_factory(cursor: Any) -> Any:
    desc = cursor.description
    if desc is None:
        return None
    columns = [c.name for c in desc]

    def make(values: list[Any]) -> _HybridRow:
        return _HybridRow(columns, list(values))

    return make


class _DialectConn:
    """Thin wrapper that lets the existing sqlite-style code run against psycopg.

    On Postgres path: rewrites `?` placeholders to `%s`, adapts ISO timestamp
    strings to datetime, and exposes `commit()` / `close()`. The underlying
    connection's row factory yields `_HybridRow` so `row["col"]`, `row[0]`,
    and `"col" in row.keys()` all work as before.
    """

    def __init__(self, raw: Any, dialect: str) -> None:
        self._raw = raw
        self.dialect = dialect

    def execute(self, sql: str, params: Any = ()) -> Any:
        if self.dialect == "postgres":
            sql = sql.replace("?", "%s")
            if params:
                params = tuple(_pg_param(p) for p in params)
        return self._raw.execute(sql, params or ())

    def commit(self) -> None:
        self._raw.commit()

    def close(self) -> None:
        self._raw.close()


DEFAULT_USER_ID = "local-reader"
DEFAULT_DECK_TITLE = "Reader Vocabulary"
OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_CONTEXT_MODEL = os.getenv("OPENAI_CONTEXT_MODEL") or "gpt-4.1-mini"
ContextGenerator = Callable[[dict[str, Any]], dict[str, Any] | None]
LessonGenerator = Callable[[dict[str, Any]], dict[str, Any] | None]
CoachGenerator = Callable[[dict[str, Any]], dict[str, Any] | None]
SentenceCoachGenerator = Callable[[dict[str, Any]], dict[str, Any] | None]
CONTEXT_CACHE_VERSION = "v1"
DEFAULT_CONTEXT_CACHE_KEY = f"{CONTEXT_CACHE_VERSION}:default"
RATING_VALUES = ("again", "hard", "good", "easy")
CARD_STATE_VALUES = ("new", "learning", "review", "relearning")
CARD_TYPE_VALUES = ("basic", "reverse", "cloze")
NOTE_TYPE_VALUES = ("basic", "basic_reverse", "cloze")
ANSWER_MODE_VALUES = ("typed", "self_report", "reveal")
PRACTICE_FOCUS_VALUES = ("mixed", "new", "weak")
PRACTICE_MODE_VALUES = ("review", "lesson")
PRACTICE_STEP_VALUES = ("answer", "retry", "usage", "plan", "production")
CLOZE_PATTERN = re.compile(r"\{\{c(?P<index>\d+)::(?P<answer>.+?)(?:::(?P<hint>.+?))?\}\}")

DEFAULT_DECK_CONFIG = {
    "requestRetention": 0.90,
    "enableFuzz": True,
    "learningSteps": ["1m", "10m"],
    "relearningSteps": ["10m"],
    "maximumInterval": 36500,
    "newCardsPerDay": 6,
    "siblingBurying": True,
}


class DeckCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=800)
    config: dict[str, Any] | None = None


class NoteCreateRequest(BaseModel):
    noteType: Literal["basic", "basic_reverse", "cloze"]
    front: str = Field(min_length=1, max_length=5000)
    back: str | None = Field(default=None, max_length=5000)
    extra: str | None = Field(default=None, max_length=5000)
    hint: str | None = Field(default=None, max_length=1000)
    explanation: str | None = Field(default=None, max_length=5000)
    exampleSentence: str | None = Field(default=None, max_length=3000)
    imageUrl: str | None = Field(default=None, max_length=4000)
    audioUrl: str | None = Field(default=None, max_length=4000)
    tags: list[str] = Field(default_factory=list)
    topic: str | None = Field(default=None, max_length=240)
    sourceRef: str | None = Field(default=None, max_length=500)
    metadata: dict[str, Any] | None = None


class CardReviewRequest(BaseModel):
    rating: Literal["again", "hard", "good", "easy"]
    responseMs: int | None = Field(default=None, ge=0, le=3_600_000)
    answerMode: Literal["typed", "self_report", "reveal"] = "typed"
    wasAutoGraded: bool = False
    typedResponse: str | None = Field(default=None, max_length=5000)
    reviewedAt: str | None = None


class CardUpdateRequest(BaseModel):
    isSuspended: bool


class NoteMnemonicUpdateRequest(BaseModel):
    mnemonic: str | None = Field(default=None, max_length=2000)


class CardContextRequest(BaseModel):
    refreshHint: str | None = Field(default=None, max_length=200)


class CardProductionRequest(BaseModel):
    sentences: list[str] = Field(min_length=3, max_length=3)


class PracticeSessionRequest(BaseModel):
    focus: Literal["mixed", "new", "weak"] = "mixed"
    limit: int = Field(default=5, ge=1, le=12)
    cardIds: list[str] = Field(default_factory=list)


class CardLessonRequest(BaseModel):
    refreshHint: str | None = Field(default=None, max_length=200)


class CardCoachHistoryItem(BaseModel):
    role: Literal["assistant", "learner"]
    text: str = Field(min_length=1, max_length=1000)
    step: str = Field(default="answer", max_length=40)


class CardCoachRequest(BaseModel):
    mode: Literal["review", "lesson"]
    step: Literal["answer", "retry", "usage"]
    turnIndex: int = Field(ge=1, le=3)
    learnerResponse: str | None = Field(default=None, max_length=5000)
    history: list[CardCoachHistoryItem] = Field(default_factory=list)


class LearningEventRequest(BaseModel):
    type: str = Field(min_length=1, max_length=80)
    xpDelta: int = Field(default=0, ge=0, le=500)
    bookId: str | None = Field(default=None, max_length=120)
    deckId: str | None = Field(default=None, max_length=120)
    cardId: str | None = Field(default=None, max_length=120)
    label: str | None = Field(default=None, max_length=180)
    detail: str | None = Field(default=None, max_length=500)


class ArchiveImportItem(BaseModel):
    sourceId: str = Field(min_length=1, max_length=240)
    sourceText: str = Field(min_length=1, max_length=500)
    note: str | None = Field(default=None, max_length=5000)
    bookId: str = Field(min_length=1, max_length=120)
    bookTitle: str = Field(min_length=1, max_length=500)
    createdAt: str | None = None


class ArchiveImportRequest(BaseModel):
    items: list[ArchiveImportItem] = Field(default_factory=list)


def _make_id() -> str:
    return uuid.uuid4().hex[:12]


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_timestamp(value: str | datetime | None, *, fallback: datetime | None = None) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        normalized = value.strip()
        if normalized.endswith("Z"):
            normalized = f"{normalized[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            parsed = fallback or _utc_now()
    else:
        parsed = fallback or _utc_now()

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _serialize_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _local_day_bounds(reference: datetime) -> tuple[datetime, datetime]:
    local_reference = reference.astimezone()
    start_local = datetime.combine(local_reference.date(), time.min, tzinfo=local_reference.tzinfo)
    end_local = start_local + timedelta(days=1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def _normalize_line(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    return normalized or None


def _normalize_compact_text(value: str | None) -> str | None:
    normalized = _normalize_line(value)
    if normalized is None:
        return None
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized or None


def _normalize_tags(values: list[str]) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for value in values:
        cleaned = _normalize_compact_text(value)
        if cleaned is None:
            continue
        key = cleaned.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(cleaned)
    return normalized[:24]


def _json_load_dict(raw: Any) -> dict[str, Any]:
    if raw is None or raw == "":
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _metadata_mnemonic(row: sqlite3.Row) -> str | None:
    metadata_json = row["metadata_json"] if "metadata_json" in row.keys() else None
    metadata = _json_load_dict(metadata_json)
    mnemonic = _normalize_line(metadata.get("mnemonic"))
    if mnemonic:
        return mnemonic
    studio = metadata.get("studio")
    if isinstance(studio, dict):
        return _normalize_line(studio.get("mnemonic"))
    return None


def _json_load_list(raw: Any) -> list[Any]:
    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _state_priority(state: str) -> int:
    if state == "relearning":
        return 0
    if state == "learning":
        return 1
    if state == "review":
        return 2
    return 3


def _parse_step_duration(value: str) -> timedelta:
    match = re.fullmatch(r"(?P<amount>\d+)\s*(?P<unit>[mhd])", value.strip().lower())
    if not match:
        raise ValueError(f"Unsupported step duration: {value}")
    amount = int(match.group("amount"))
    unit = match.group("unit")
    if unit == "m":
        return timedelta(minutes=amount)
    if unit == "h":
        return timedelta(hours=amount)
    return timedelta(days=amount)


def _normalize_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    config = dict(DEFAULT_DECK_CONFIG)
    if not isinstance(raw, dict):
        return config

    if "requestRetention" in raw:
        try:
            config["requestRetention"] = max(0.70, min(0.97, float(raw["requestRetention"])))
        except (TypeError, ValueError):
            pass
    if "enableFuzz" in raw:
        config["enableFuzz"] = bool(raw["enableFuzz"])
    if isinstance(raw.get("learningSteps"), list) and raw["learningSteps"]:
        config["learningSteps"] = [str(value) for value in raw["learningSteps"][:6]]
    if isinstance(raw.get("relearningSteps"), list):
        config["relearningSteps"] = [str(value) for value in raw["relearningSteps"][:6]]
    if "maximumInterval" in raw:
        try:
            config["maximumInterval"] = max(1, min(36500, int(raw["maximumInterval"])))
        except (TypeError, ValueError):
            pass
    if "newCardsPerDay" in raw:
        try:
            config["newCardsPerDay"] = max(0, min(50, int(raw["newCardsPerDay"])))
        except (TypeError, ValueError):
            pass
    if "siblingBurying" in raw:
        config["siblingBurying"] = bool(raw["siblingBurying"])
    return config


def _build_scheduler(config: dict[str, Any]) -> Scheduler:
    learning_steps = tuple(_parse_step_duration(step) for step in config["learningSteps"])
    relearning_steps = tuple(_parse_step_duration(step) for step in config["relearningSteps"])
    return Scheduler(
        desired_retention=float(config["requestRetention"]),
        learning_steps=learning_steps,
        relearning_steps=relearning_steps,
        maximum_interval=int(config["maximumInterval"]),
        enable_fuzzing=bool(config["enableFuzz"]),
    )


def _format_interval_label(due_at: datetime, reference: datetime) -> str:
    delta = max(due_at - reference, timedelta())
    total_minutes = max(0, int(round(delta.total_seconds() / 60)))
    if total_minutes < 60:
        return f"{max(1, total_minutes)}m"
    total_hours = max(1, int(round(total_minutes / 60)))
    if total_hours < 48:
        return f"{total_hours}h"
    total_days = max(1, int(round(total_hours / 24)))
    return f"{total_days}d"


def _safe_retrievability(scheduler: Scheduler, card: Card, reference: datetime) -> float | None:
    try:
        value = scheduler.get_card_retrievability(card, current_datetime=reference)
    except Exception:
        return None
    if value is None:
        return None
    return round(float(value), 4)


def _spacing_preview(config: dict[str, Any], *, steps: int = 4) -> list[dict[str, Any]]:
    scheduler = _build_scheduler(config)
    reference = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    card = Card()
    preview: list[dict[str, Any]] = []
    for index in range(steps):
        card, _ = scheduler.review_card(card, FsrsRating.Good, review_datetime=reference)
        preview.append(
            {
                "step": index + 1,
                "label": _format_interval_label(card.due, reference),
                "state": _fsrs_state_to_public(card.state),
            }
        )
        reference = card.due
    return preview


def _extract_pronunciation(row: sqlite3.Row) -> str | None:
    if "metadata_json" not in row.keys():
        return None
    metadata = _json_load_dict(row["metadata_json"])
    value = metadata.get("pronunciation")
    return _normalize_line(value) if isinstance(value, str) else None


def _source_book_details(row: sqlite3.Row) -> tuple[str | None, str | None]:
    if "metadata_json" not in row.keys():
        return None, None
    metadata = _json_load_dict(row["metadata_json"])
    book_id = _normalize_compact_text(metadata.get("bookId")) if isinstance(metadata.get("bookId"), str) else None
    book_title = _normalize_line(metadata.get("bookTitle")) if isinstance(metadata.get("bookTitle"), str) else None
    return book_id, book_title


def _context_term(row: sqlite3.Row) -> str:
    keys = set(row.keys())
    note_type = row["note_type"] if "note_type" in keys else None
    card_type = row["card_type"] if "card_type" in keys else None
    if note_type == "cloze":
        return _normalize_compact_text(row["answer"]) or row["answer"]
    if card_type == "reverse":
        return _normalize_compact_text(row["answer"]) or row["answer"]
    if "front" in keys and row["front"]:
        return _normalize_compact_text(row["front"]) or row["front"]
    return _normalize_compact_text(row["cue"]) or row["cue"]


def _split_sentences(values: list[str]) -> list[str]:
    sentences: list[str] = []
    for value in values:
        normalized = _normalize_line(value)
        if not normalized:
            continue
        sentences.append(normalized)
    return sentences[:3]


def _normalize_verdict(value: str | None) -> Literal["correct", "close", "incorrect"]:
    normalized = _normalize_compact_text(value)
    if normalized in {"correct", "close", "incorrect"}:
        return normalized
    return "incorrect"


def _normalize_rating(value: str | None) -> Literal["again", "hard", "good", "easy"] | None:
    normalized = _normalize_compact_text(value)
    if normalized in RATING_VALUES:
        return normalized
    return None


def _normalize_provider(value: str | None) -> Literal["gemma", "openai", "fallback"]:
    normalized = _normalize_compact_text(value)
    if normalized in {"gemma", "openai"}:
        return normalized
    return "fallback"


def _normalize_role(value: str | None) -> Literal["assistant", "learner"] | None:
    normalized = _normalize_compact_text(value)
    if normalized in {"assistant", "learner"}:
        return normalized
    return None


def _normalize_history(items: list[CardCoachHistoryItem] | list[dict[str, Any]] | None) -> list[dict[str, str]]:
    if not items:
        return []
    normalized: list[dict[str, str]] = []
    for item in items[:6]:
        role = None
        text = None
        step = None
        if isinstance(item, CardCoachHistoryItem):
            role = item.role
            text = item.text
            step = item.step
        elif isinstance(item, dict):
            role = _normalize_role(item.get("role") if isinstance(item.get("role"), str) else None)
            text = item.get("text") if isinstance(item.get("text"), str) else None
            step = item.get("step") if isinstance(item.get("step"), str) else None
        if role is None:
            continue
        clean_text = _normalize_line(text)
        clean_step = _normalize_compact_text(step) or "answer"
        if not clean_text:
            continue
        normalized.append({"role": role, "text": clean_text[:1000], "step": clean_step[:40]})
    return normalized


def _tokenize_text(value: str | None) -> list[str]:
    if not value:
        return []
    return re.findall(r"[a-z0-9']+", value.casefold())


def _term_in_text(term: str, text: str) -> bool:
    normalized_term = _normalize_compact_text(term)
    normalized_text = _normalize_compact_text(text)
    if not normalized_term or not normalized_text:
        return False
    pattern = re.compile(rf"\b{re.escape(normalized_term.casefold())}\b")
    return bool(pattern.search(normalized_text.casefold()))


def _fallback_context_payload(
    *,
    term: str,
    definition: str,
    pronunciation: str | None,
    example_sentence: str | None,
    explanation: str | None,
) -> dict[str, Any]:
    paragraph_parts = [
        f'"{term}" means {definition}.',
    ]
    if example_sentence:
        paragraph_parts.append(f"Example: {example_sentence}")
    if explanation:
        paragraph_parts.append(explanation)

    return {
        "source": "dictionary_fallback",
        "term": term,
        "pronunciation": pronunciation,
        "definition": definition,
        "contextTitle": f"{term} in context",
        "contextParagraph": " ".join(part for part in paragraph_parts if part),
        "usageFocus": [
            "Notice how the meaning changes with the situation around the word.",
            "Use the word in a sentence about your own life, not the dictionary example.",
        ],
        "practicePrompts": [
            f"Write one sentence where {term} describes a real situation.",
            f"Write one sentence where {term} shows a feeling, action, or result.",
            f"Write one sentence connecting {term} to something you read or experienced today.",
        ],
    }


def _context_cache_key(request: CardContextRequest | None) -> str:
    refresh_hint = _normalize_compact_text(request.refreshHint) if request else None
    if refresh_hint:
        return f"{CONTEXT_CACHE_VERSION}:refresh:{refresh_hint}"
    return DEFAULT_CONTEXT_CACHE_KEY


def _cloze_card_specs(front: str) -> list[dict[str, Any]]:
    matches = list(CLOZE_PATTERN.finditer(front))
    if not matches:
        raise HTTPException(status_code=400, detail="Cloze notes need at least one {{c1::answer}} marker.")

    grouped: dict[int, list[re.Match[str]]] = {}
    for match in matches:
        index = int(match.group("index"))
        grouped.setdefault(index, []).append(match)

    specs: list[dict[str, Any]] = []
    for position, cloze_index in enumerate(sorted(grouped), start=1):
        answers: list[str] = []
        cue_parts: list[str] = []
        cursor = 0
        for match in matches:
            cue_parts.append(front[cursor : match.start()])
            answer = match.group("answer").strip()
            hint = (match.group("hint") or "").strip()
            if int(match.group("index")) == cloze_index:
                answers.append(answer)
                cue_parts.append(f"[{hint}]" if hint else "[...]")
            else:
                cue_parts.append(answer)
            cursor = match.end()
        cue_parts.append(front[cursor:])
        specs.append(
            {
                "card_type": "cloze",
                "position": position,
                "cloze_index": cloze_index,
                "cue": "".join(cue_parts).strip(),
                "answer": " / ".join(dict.fromkeys(answer for answer in answers if answer)),
            }
        )
    return specs


def _generate_card_specs(note_type: str, front: str, back: str | None) -> list[dict[str, Any]]:
    clean_front = _normalize_line(front)
    clean_back = _normalize_line(back)
    if clean_front is None:
        raise HTTPException(status_code=400, detail="Card front cannot be empty.")

    if note_type == "cloze":
        return _cloze_card_specs(clean_front)

    if clean_back is None:
        raise HTTPException(status_code=400, detail="Basic and reverse notes require a back field.")

    specs = [
        {
            "card_type": "basic",
            "position": 1,
            "cloze_index": None,
            "cue": clean_front,
            "answer": clean_back,
        }
    ]
    if note_type == "basic_reverse":
        specs.append(
            {
                "card_type": "reverse",
                "position": 2,
                "cloze_index": None,
                "cue": clean_back,
                "answer": clean_front,
            }
        )
    return specs


def _rating_to_fsrs(value: str) -> FsrsRating:
    mapping = {
        "again": FsrsRating.Again,
        "hard": FsrsRating.Hard,
        "good": FsrsRating.Good,
        "easy": FsrsRating.Easy,
    }
    return mapping[value]


def _fsrs_state_to_public(value: FsrsState) -> Literal["learning", "review", "relearning"]:
    if value == FsrsState.Review:
        return "review"
    if value == FsrsState.Relearning:
        return "relearning"
    return "learning"


def _row_to_card(row: sqlite3.Row) -> Card:
    state = row["state"]
    if state == "new":
        return Card(
            due=_parse_timestamp(row["due_at"]),
            last_review=_parse_timestamp(row["last_review_at"]) if row["last_review_at"] else None,
        )

    fsrs_state = {
        "learning": FsrsState.Learning,
        "review": FsrsState.Review,
        "relearning": FsrsState.Relearning,
    }[state]
    return Card(
        state=fsrs_state,
        step=row["learning_step_index"],
        stability=row["stability"],
        difficulty=row["difficulty"],
        due=_parse_timestamp(row["due_at"]),
        last_review=_parse_timestamp(row["last_review_at"]) if row["last_review_at"] else None,
    )


class VocabularyStudioService:
    def __init__(
        self,
        data_root: Path,
        *,
        migrations_dir: Path | None = None,
        user_id: str = DEFAULT_USER_ID,
        user_id_provider: Callable[[], str] | None = None,
        dictionary_lookup: Callable[[str], dict[str, Any]] | None = None,
        context_generator: ContextGenerator | None = None,
        context_generators: list[ContextGenerator] | None = None,
        lesson_generators: list[LessonGenerator] | None = None,
        coach_generators: list[CoachGenerator] | None = None,
        sentence_generators: list[SentenceCoachGenerator] | None = None,
        allow_openai_fallback: bool = True,
    ) -> None:
        self._data_root = Path(data_root)
        self._db_path = self._data_root / "vocabulary-studio.sqlite3"
        self._migrations_dir = migrations_dir or Path(__file__).with_name("migrations")
        self._user_id = user_id
        self._user_id_provider = user_id_provider
        self._dictionary_lookup = dictionary_lookup
        self._context_generators = list(context_generators or [])
        if context_generator is not None:
            self._context_generators.insert(0, context_generator)
        self._lesson_generators = list(lesson_generators or [])
        self._coach_generators = list(coach_generators or [])
        self._sentence_generators = list(sentence_generators or [])
        self._allow_openai_fallback = allow_openai_fallback
        self._migration_lock = threading.Lock()
        self._ready = False

    @property
    def user_id(self) -> str:
        if self._user_id_provider is not None:
            return self._user_id_provider()
        return self._user_id

    def ensure_ready(self) -> None:
        if self._ready:
            return
        with self._migration_lock:
            if self._ready:
                return
            if _dialect() == "postgres":
                # On Postgres, schema is owned by app.py's _SCHEMA_MIGRATIONS
                # (version 7+). ensure_progress_store() runs the migration once at
                # the first DB-backed request; calling it here keeps the contract
                # symmetric with the sqlite branch (after ensure_ready, schema is up).
                try:
                    from server import app as _app  # type: ignore

                    _app.ensure_progress_store()
                except Exception:
                    # If app module isn't importable from this context (e.g. tests),
                    # rely on the connection itself to surface schema errors.
                    pass
                self._ready = True
                return

            self._db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self._db_path)
            try:
                conn.execute("pragma foreign_keys = on")
                conn.execute(
                    """
                    create table if not exists schema_migrations (
                        name text primary key,
                        applied_at text not null
                    )
                    """
                )
                applied = {row[0] for row in conn.execute("select name from schema_migrations").fetchall()}
                for migration_path in sorted(self._migrations_dir.glob("*.sql")):
                    if migration_path.name in applied:
                        continue
                    conn.executescript(migration_path.read_text(encoding="utf-8"))
                    conn.execute(
                        "insert into schema_migrations (name, applied_at) values (?, ?)",
                        (migration_path.name, _serialize_timestamp(_utc_now())),
                    )
                conn.commit()
            finally:
                conn.close()
            self._ready = True

    @contextmanager
    def connection(self) -> Iterator[Any]:
        self.ensure_ready()
        if _dialect() == "postgres":
            import psycopg

            url = _supabase_db_url()
            if not url:
                raise RuntimeError("Postgres dialect selected but no SUPABASE_DB_URL/SUPABASE_POOLER_URL/DATABASE_URL is set.")
            raw = psycopg.connect(url, row_factory=_hybrid_row_factory)
            wrapped = _DialectConn(raw, "postgres")
            try:
                yield wrapped
                wrapped.commit()
            finally:
                wrapped.close()
            return

        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("pragma foreign_keys = on")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _require_deck(self, conn: sqlite3.Connection, deck_id: str) -> sqlite3.Row:
        row = conn.execute(
            """
            select *
            from decks
            where id = ? and user_id = ?
            """,
            (deck_id, self.user_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Deck not found.")
        return row

    def _require_card(self, conn: sqlite3.Connection, card_id: str) -> sqlite3.Row:
        row = conn.execute(
            """
            select
                c.*,
                n.note_type,
                n.front,
                n.back,
                n.extra,
                n.hint,
                n.explanation,
                n.example_sentence,
                n.image_url,
                n.audio_url,
                n.tags_json,
                n.topic,
                n.metadata_json,
                d.title as deck_title,
                d.config_json
            from cards c
            join notes n on n.id = c.note_id
            join decks d on d.id = c.deck_id
            where c.id = ? and c.user_id = ?
            """,
            (card_id, self.user_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Card not found.")
        return row

    def _deck_summary(self, conn: sqlite3.Connection, deck_row: sqlite3.Row, now: datetime) -> dict[str, Any]:
        config = _normalize_config(_json_load_dict(deck_row["config_json"]))
        day_start, day_end = _local_day_bounds(now)
        counts_row = conn.execute(
            """
            select
                count(*) as total_cards,
                sum(case when is_suspended = true then 1 else 0 end) as suspended_cards,
                sum(case when state = 'new' and is_suspended = false then 1 else 0 end) as new_cards,
                sum(case when state = 'learning' and is_suspended = false then 1 else 0 end) as learning_cards,
                sum(case when state = 'review' and is_suspended = false then 1 else 0 end) as review_cards,
                sum(case when state = 'relearning' and is_suspended = false then 1 else 0 end) as relearning_cards,
                sum(
                    case
                        when state in ('learning', 'review', 'relearning')
                             and is_suspended = false
                             and due_at <= ?
                        then 1 else 0
                    end
                ) as due_now,
                sum(
                    case
                        when state in ('learning', 'review', 'relearning')
                             and is_suspended = false
                             and due_at < ?
                        then 1 else 0
                    end
                ) as due_today
            from cards
            where deck_id = ?
            """,
            (_serialize_timestamp(now), _serialize_timestamp(day_end), deck_row["id"]),
        ).fetchone()
        note_count = conn.execute(
            "select count(*) from notes where deck_id = ?",
            (deck_row["id"],),
        ).fetchone()[0]
        introduced_today = conn.execute(
            """
            select count(distinct card_id)
            from review_logs rl
            join cards c on c.id = rl.card_id
            where c.deck_id = ?
              and rl.reviewed_at >= ?
              and rl.reviewed_at < ?
              and rl.state_before = 'new'
            """,
            (deck_row["id"], _serialize_timestamp(day_start), _serialize_timestamp(day_end)),
        ).fetchone()[0]
        reviews_completed_today = conn.execute(
            """
            select count(*)
            from review_logs rl
            join cards c on c.id = rl.card_id
            where c.deck_id = ?
              and rl.reviewed_at >= ?
              and rl.reviewed_at < ?
            """,
            (deck_row["id"], _serialize_timestamp(day_start), _serialize_timestamp(day_end)),
        ).fetchone()[0]
        next_due_at = conn.execute(
            """
            select min(due_at)
            from cards
            where deck_id = ?
              and is_suspended = false
              and state in ('learning', 'review', 'relearning')
              and due_at > ?
            """,
            (deck_row["id"], _serialize_timestamp(now)),
        ).fetchone()[0]
        total_new_cards = int(counts_row["new_cards"] or 0)
        new_available = min(total_new_cards, max(0, int(config["newCardsPerDay"]) - int(introduced_today or 0)))
        return {
            "id": deck_row["id"],
            "title": deck_row["title"],
            "description": deck_row["description"],
            "config": config,
            "createdAt": deck_row["created_at"],
            "updatedAt": deck_row["updated_at"],
            "noteCount": int(note_count or 0),
            "cardCount": int(counts_row["total_cards"] or 0),
            "dueNow": int(counts_row["due_now"] or 0),
            "dueToday": int(counts_row["due_today"] or 0),
            "newAvailable": int(new_available),
            "newCardCap": int(config["newCardsPerDay"]),
            "newIntroducedToday": int(introduced_today or 0),
            "reviewsCompletedToday": int(reviews_completed_today or 0),
            "cardsByState": {
                "new": int(counts_row["new_cards"] or 0),
                "learning": int(counts_row["learning_cards"] or 0),
                "review": int(counts_row["review_cards"] or 0),
                "relearning": int(counts_row["relearning_cards"] or 0),
            },
            "suspendedCards": int(counts_row["suspended_cards"] or 0),
            "nextDueAt": next_due_at,
        }

    def _candidate_rows(
        self,
        conn: sqlite3.Connection,
        *,
        deck_id: str,
        now: datetime,
        include_new: bool,
    ) -> list[sqlite3.Row]:
        day_start, day_end = _local_day_bounds(now)
        deck = self._require_deck(conn, deck_id)
        config = _normalize_config(_json_load_dict(deck["config_json"]))
        due_params: list[Any] = [deck_id, _serialize_timestamp(now)]
        new_params: list[Any] = [deck_id]
        bury_clause = ""
        if config["siblingBurying"]:
            bury_clause = """
              and not exists (
                    select 1
                    from review_logs rl
                    join cards c2 on c2.id = rl.card_id
                    where c2.deck_id = ?
                      and c2.note_id = c.note_id
                      and c2.id != c.id
                      and rl.reviewed_at >= ?
                      and rl.reviewed_at < ?
                )
            """
            bury_params = [deck_id, _serialize_timestamp(day_start), _serialize_timestamp(day_end)]
            due_params.extend(bury_params)
            new_params.extend(bury_params)

        due_rows = conn.execute(
            f"""
            select
                c.*,
                n.extra,
                n.hint,
                n.explanation,
                n.example_sentence,
                n.image_url,
                n.audio_url,
                n.tags_json,
                n.topic,
                n.metadata_json,
                d.title as deck_title,
                d.config_json
            from cards c
            join notes n on n.id = c.note_id
            join decks d on d.id = c.deck_id
            where c.deck_id = ?
              and c.is_suspended = false
              and c.state in ('learning', 'review', 'relearning')
              and c.due_at <= ?
              {bury_clause}
            order by c.due_at asc, c.updated_at asc, c.position asc
            """,
            due_params,
        ).fetchall()
        if due_rows or not include_new:
            return list(due_rows)

        summary = self._deck_summary(conn, deck, now)
        if summary["newAvailable"] <= 0:
            return []

        new_params.append(summary["newAvailable"])
        new_rows = conn.execute(
            f"""
            select
                c.*,
                n.extra,
                n.hint,
                n.explanation,
                n.example_sentence,
                n.image_url,
                n.audio_url,
                n.tags_json,
                n.topic,
                n.metadata_json,
                d.title as deck_title,
                d.config_json
            from cards c
            join notes n on n.id = c.note_id
            join decks d on d.id = c.deck_id
            where c.deck_id = ?
              and c.is_suspended = false
              and c.state = 'new'
              {bury_clause}
            order by c.created_at asc, c.position asc
            limit ?
            """,
            new_params,
        ).fetchall()
        return list(new_rows)

    def _choose_next_card(
        self,
        conn: sqlite3.Connection,
        *,
        deck_id: str,
        now: datetime,
        avoid_note_id: str | None = None,
        avoid_topic: str | None = None,
    ) -> sqlite3.Row | None:
        candidates = self._candidate_rows(conn, deck_id=deck_id, now=now, include_new=True)
        if not candidates:
            return None

        filtered = candidates
        if avoid_note_id and any(row["note_id"] != avoid_note_id for row in filtered):
            filtered = [row for row in filtered if row["note_id"] != avoid_note_id]
        if avoid_topic:
            alternate_topic = [row for row in filtered if (row["topic"] or "").strip().casefold() != avoid_topic.casefold()]
            if alternate_topic:
                filtered = alternate_topic

        filtered.sort(
            key=lambda row: (
                _state_priority(row["state"]),
                row["due_at"],
                (row["topic"] or "").casefold(),
                row["position"],
            )
        )
        return filtered[0]

    def _practice_candidate_rows(
        self,
        conn: sqlite3.Connection,
        *,
        deck_id: str,
        card_ids: list[str] | None = None,
    ) -> list[sqlite3.Row]:
        params: list[Any] = [deck_id]
        card_filter = ""
        if card_ids:
            placeholders = ", ".join(["?"] * len(card_ids))
            card_filter = f" and c.id in ({placeholders})"
            params.extend(card_ids)
        rows = conn.execute(
            f"""
            select
                c.*,
                n.note_type,
                n.front,
                n.back,
                n.extra,
                n.hint,
                n.explanation,
                n.example_sentence,
                n.image_url,
                n.audio_url,
                n.tags_json,
                n.topic,
                n.metadata_json,
                d.title as deck_title,
                d.config_json
            from cards c
            join notes n on n.id = c.note_id
            join decks d on d.id = c.deck_id
            where c.deck_id = ?
              and c.is_suspended = false
              {card_filter}
            order by c.created_at asc, c.position asc
            """,
            params,
        ).fetchall()
        return list(rows)

    def _select_practice_queue(
        self,
        conn: sqlite3.Connection,
        *,
        deck_id: str,
        focus: str,
        limit: int,
        card_ids: list[str] | None,
        now: datetime,
    ) -> list[sqlite3.Row]:
        rows = self._practice_candidate_rows(conn, deck_id=deck_id, card_ids=card_ids)
        if not rows:
            return []

        week_ago = _serialize_timestamp(now - timedelta(days=7))
        weak_card_ids = {
            row[0]
            for row in conn.execute(
                """
                select distinct rl.card_id
                from review_logs rl
                join cards c on c.id = rl.card_id
                where c.deck_id = ?
                  and rl.reviewed_at >= ?
                  and rl.rating in ('again', 'hard')
                """,
                (deck_id, week_ago),
            ).fetchall()
        }
        practiced_card_ids = {
            row[0]
            for row in conn.execute(
                """
                select distinct card_id
                from practice_attempts
                where user_id = ?
                  and mode = 'lesson'
                """,
                (self.user_id,),
            ).fetchall()
        }
        due_now_ids = {
            row["id"]
            for row in rows
            if row["state"] in {"learning", "review", "relearning"} and _parse_timestamp(row["due_at"]) <= now
        }

        def order_rows(items: list[sqlite3.Row], order_key: str) -> list[sqlite3.Row]:
            if order_key == "weak":
                return sorted(
                    items,
                    key=lambda row: (
                        row["id"] not in weak_card_ids,
                        _state_priority(row["state"]),
                        row["due_at"],
                        row["created_at"],
                    ),
                )
            if order_key == "new":
                return sorted(items, key=lambda row: (row["created_at"], row["position"]))
            return sorted(
                items,
                key=lambda row: (
                    _state_priority(row["state"]),
                    row["due_at"],
                    row["created_at"],
                    row["position"],
                ),
            )

        if focus == "new":
            candidates = order_rows([row for row in rows if row["state"] == "new"], "new")
        elif focus == "weak":
            candidates = order_rows([row for row in rows if row["id"] in weak_card_ids], "weak")
        else:
            candidates = (
                order_rows(
                    [row for row in rows if row["state"] == "new" and row["id"] not in practiced_card_ids],
                    "new",
                )
                + order_rows(
                    [row for row in rows if row["id"] in weak_card_ids and row["state"] != "new"],
                    "weak",
                )
                + order_rows(
                    [
                        row
                        for row in rows
                        if row["id"] in due_now_ids and row["id"] not in weak_card_ids
                    ],
                    "due",
                )
            )

        queue: list[sqlite3.Row] = []
        seen_ids: set[str] = set()
        used_note_ids: set[str] = set()
        last_topic: str | None = None
        for row in candidates:
            if row["id"] in seen_ids or row["note_id"] in used_note_ids:
                continue
            topic = _normalize_compact_text(row["topic"])
            if last_topic and topic and topic == last_topic:
                alternate = next(
                    (
                        candidate
                        for candidate in candidates
                        if candidate["id"] not in seen_ids
                        and candidate["note_id"] not in used_note_ids
                        and _normalize_compact_text(candidate["topic"]) != last_topic
                    ),
                    None,
                )
                if alternate is not None:
                    row = alternate
                    topic = _normalize_compact_text(row["topic"])
            queue.append(row)
            seen_ids.add(row["id"])
            used_note_ids.add(row["note_id"])
            last_topic = topic
            if len(queue) >= limit:
                break
        return queue

    def _card_debug(self, row: sqlite3.Row, now: datetime) -> dict[str, Any]:
        scheduler = _build_scheduler(_normalize_config(_json_load_dict(row["config_json"])))
        card = _row_to_card(row)
        return {
            "dueAt": row["due_at"],
            "lastReviewAt": row["last_review_at"],
            "retrievability": _safe_retrievability(scheduler, card, now),
            "scheduledDays": row["scheduled_days"],
            "elapsedDays": row["elapsed_days"],
            "stability": row["stability"],
            "difficulty": row["difficulty"],
            "reps": row["reps"],
            "lapses": row["lapses"],
            "learningStepIndex": row["learning_step_index"],
        }

    def _rating_preview(self, row: sqlite3.Row, now: datetime) -> dict[str, Any]:
        scheduler = _build_scheduler(_normalize_config(_json_load_dict(row["config_json"])))
        preview: dict[str, Any] = {}
        for rating_name in RATING_VALUES:
            next_card, _ = scheduler.review_card(_row_to_card(row), _rating_to_fsrs(rating_name), review_datetime=now)
            preview[rating_name] = {
                "dueAt": _serialize_timestamp(next_card.due),
                "label": _format_interval_label(next_card.due, now),
                "state": _fsrs_state_to_public(next_card.state),
            }
        return preview

    def _production_status(self, conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        count = conn.execute(
            "select count(*) from production_logs where card_id = ? and user_id = ?",
            (row["id"], self.user_id),
        ).fetchone()[0]
        target = _context_term(row)
        return {
            "productionTarget": target,
            "requiresProduction": row["state"] in {"new", "learning"} and int(count or 0) == 0,
            "productionCount": int(count or 0),
        }

    def _serialize_session_card(self, conn: sqlite3.Connection, row: sqlite3.Row, now: datetime) -> dict[str, Any]:
        production = self._production_status(conn, row)
        source_book_id, source_book_title = _source_book_details(row)
        return {
            "id": row["id"],
            "deckId": row["deck_id"],
            "noteId": row["note_id"],
            "deckTitle": row["deck_title"],
            "cardType": row["card_type"],
            "state": row["state"],
            "cue": row["cue"],
            "answer": row["answer"],
            "extra": row["extra"],
            "hint": row["hint"],
            "explanation": row["explanation"],
            "exampleSentence": row["example_sentence"],
            "imageUrl": row["image_url"],
            "audioUrl": row["audio_url"],
            "pronunciation": _extract_pronunciation(row),
            "mnemonic": _metadata_mnemonic(row),
            "tags": _json_load_list(row["tags_json"]),
            "topic": row["topic"],
            "sourceBookId": source_book_id,
            "sourceBookTitle": source_book_title,
            "dueAt": row["due_at"],
            "ratingPreview": self._rating_preview(row, now),
            "debug": self._card_debug(row, now),
            **production,
        }

    def _serialize_note(self, note_row: sqlite3.Row, card_rows: list[sqlite3.Row]) -> dict[str, Any]:
        source_book_id, source_book_title = _source_book_details(note_row)
        return {
            "id": note_row["id"],
            "deckId": note_row["deck_id"],
            "noteType": note_row["note_type"],
            "front": note_row["front"],
            "back": note_row["back"],
            "extra": note_row["extra"],
            "hint": note_row["hint"],
            "explanation": note_row["explanation"],
            "exampleSentence": note_row["example_sentence"],
            "imageUrl": note_row["image_url"],
            "audioUrl": note_row["audio_url"],
            "mnemonic": _metadata_mnemonic(note_row),
            "tags": _json_load_list(note_row["tags_json"]),
            "topic": note_row["topic"],
            "sourceBookId": source_book_id,
            "sourceBookTitle": source_book_title,
            "metadata": _json_load_dict(note_row["metadata_json"]),
            "createdAt": note_row["created_at"],
            "updatedAt": note_row["updated_at"],
            "cards": [
                {
                    "id": row["id"],
                    "cardType": row["card_type"],
                    "state": row["state"],
                    "cue": row["cue"],
                    "answer": row["answer"],
                    "dueAt": row["due_at"],
                    "lastReviewAt": row["last_review_at"],
                    "scheduledDays": row["scheduled_days"],
                    "reps": row["reps"],
                    "lapses": row["lapses"],
                    "isSuspended": bool(row["is_suspended"]),
                }
                for row in sorted(card_rows, key=lambda item: (item["position"], item["created_at"]))
            ],
        }

    def _analytics(
        self,
        conn: sqlite3.Connection,
        deck_id: str,
        now: datetime,
        *,
        config: dict[str, Any],
    ) -> dict[str, Any]:
        day_start, day_end = _local_day_bounds(now)
        window_7 = now - timedelta(days=7)
        window_30 = now - timedelta(days=30)

        reviews_7 = conn.execute(
            """
            select rating
            from review_logs rl
            join cards c on c.id = rl.card_id
            where c.deck_id = ? and rl.reviewed_at >= ?
            """,
            (deck_id, _serialize_timestamp(window_7)),
        ).fetchall()
        reviews_30 = conn.execute(
            """
            select rating, response_ms, state_before
            from review_logs rl
            join cards c on c.id = rl.card_id
            where c.deck_id = ? and rl.reviewed_at >= ?
            """,
            (deck_id, _serialize_timestamp(window_30)),
        ).fetchall()

        def success_rate(rows: list[sqlite3.Row]) -> float | None:
            if not rows:
                return None
            success = sum(1 for row in rows if row["rating"] != "again")
            return round(success / len(rows), 4)

        response_ms_values = [int(row["response_ms"]) for row in reviews_30 if row["response_ms"] is not None]
        lapse_count = sum(1 for row in reviews_30 if row["rating"] == "again" and row["state_before"] == "review")
        cards_learned = conn.execute(
            """
            select count(*)
            from cards
            where deck_id = ? and state != 'new'
            """,
            (deck_id,),
        ).fetchone()[0]
        projected_load: list[dict[str, Any]] = []
        horizon_end = now + timedelta(days=7)
        future_rows = conn.execute(
            """
            select due_at
            from cards
            where deck_id = ?
              and is_suspended = false
              and state in ('learning', 'review', 'relearning')
              and due_at >= ?
              and due_at < ?
            order by due_at asc
            """,
            (deck_id, _serialize_timestamp(now), _serialize_timestamp(horizon_end)),
        ).fetchall()
        buckets: dict[str, int] = {}
        for row in future_rows:
            due_at = _parse_timestamp(row["due_at"])
            label = due_at.astimezone().date().isoformat()
            buckets[label] = buckets.get(label, 0) + 1
        local_reference = now.astimezone()
        for offset in range(7):
            day = (local_reference + timedelta(days=offset)).date().isoformat()
            projected_load.append({"date": day, "count": buckets.get(day, 0)})

        due_today = conn.execute(
            """
            select count(*)
            from cards
            where deck_id = ?
              and is_suspended = false
              and state in ('learning', 'review', 'relearning')
              and due_at < ?
            """,
            (deck_id, _serialize_timestamp(day_end)),
        ).fetchone()[0]
        new_today = conn.execute(
            """
            select count(*)
            from cards
            where deck_id = ?
              and is_suspended = false
              and state = 'new'
            """,
            (deck_id,),
        ).fetchone()[0]
        reviews_completed_today = conn.execute(
            """
            select count(*)
            from review_logs rl
            join cards c on c.id = rl.card_id
            where c.deck_id = ?
              and rl.reviewed_at >= ?
              and rl.reviewed_at < ?
            """,
            (deck_id, _serialize_timestamp(day_start), _serialize_timestamp(day_end)),
        ).fetchone()[0]
        counts_row = conn.execute(
            """
            select
                sum(case when state = 'new' and is_suspended = false then 1 else 0 end) as new_cards,
                sum(case when state = 'learning' and is_suspended = false then 1 else 0 end) as learning_cards,
                sum(case when state = 'review' and is_suspended = false then 1 else 0 end) as review_cards,
                sum(case when state = 'relearning' and is_suspended = false then 1 else 0 end) as relearning_cards
            from cards
            where deck_id = ?
            """,
            (deck_id,),
        ).fetchone()

        return {
            "dueToday": int(due_today or 0),
            "newToday": int(new_today or 0),
            "reviewsCompletedToday": int(reviews_completed_today or 0),
            "rollingRetention7d": success_rate(reviews_7),
            "rollingRetention30d": success_rate(reviews_30),
            "lapseRate": round(lapse_count / len(reviews_30), 4) if reviews_30 else None,
            "averageResponseMs": round(sum(response_ms_values) / len(response_ms_values)) if response_ms_values else None,
            "cardsLearned": int(cards_learned or 0),
            "cardsByState": {
                "new": int(counts_row["new_cards"] or 0),
                "learning": int(counts_row["learning_cards"] or 0),
                "review": int(counts_row["review_cards"] or 0),
                "relearning": int(counts_row["relearning_cards"] or 0),
            },
            "projectedReviewLoad": projected_load,
            "spacingPreview": _spacing_preview(config),
        }

    def list_decks(self) -> list[dict[str, Any]]:
        now = _utc_now()
        with self.connection() as conn:
            rows = conn.execute(
                """
                select *
                from decks
                where user_id = ?
                order by updated_at desc, lower(title) asc
                """,
                (self.user_id,),
            ).fetchall()
            return [self._deck_summary(conn, row, now) for row in rows]

    def _default_deck_summary(self, conn: sqlite3.Connection, now: datetime) -> dict[str, Any] | None:
        rows = conn.execute(
            """
            select *
            from decks
            where user_id = ?
            order by updated_at desc, lower(title) asc
            """,
            (self.user_id,),
        ).fetchall()
        if not rows:
            return None

        summaries = [self._deck_summary(conn, row, now) for row in rows]
        summaries.sort(
            key=lambda item: (
                int(item["dueNow"]),
                int(item["dueToday"]),
                int(item["newAvailable"]),
                item["updatedAt"],
            ),
            reverse=True,
        )
        return summaries[0]

    def _learning_streak_days(self, conn: sqlite3.Connection, now: datetime) -> int:
        review_rows = conn.execute(
            """
            select reviewed_at
            from review_logs
            where user_id = ?
            order by reviewed_at desc
            limit 365
            """,
            (self.user_id,),
        ).fetchall()
        event_rows = conn.execute(
            """
            select created_at
            from learning_events
            where user_id = ?
            order by created_at desc
            limit 365
            """,
            (self.user_id,),
        ).fetchall()

        active_days = {
            _parse_timestamp(row["reviewed_at"]).astimezone().date().isoformat()
            for row in review_rows
            if row["reviewed_at"]
        }
        active_days.update(
            _parse_timestamp(row["created_at"]).astimezone().date().isoformat()
            for row in event_rows
            if row["created_at"]
        )

        streak = 0
        current_day = now.astimezone().date()
        while current_day.isoformat() in active_days:
            streak += 1
            current_day -= timedelta(days=1)
        return streak

    def _recent_learning_activity(self, conn: sqlite3.Connection, limit: int = 12) -> list[dict[str, Any]]:
        review_rows = conn.execute(
            """
            select
                rl.id,
                rl.reviewed_at as created_at,
                rl.rating,
                c.id as card_id,
                c.deck_id,
                c.cue,
                n.metadata_json
            from review_logs rl
            join cards c on c.id = rl.card_id
            join notes n on n.id = c.note_id
            where rl.user_id = ?
            order by rl.reviewed_at desc
            limit ?
            """,
            (self.user_id, limit),
        ).fetchall()
        event_rows = conn.execute(
            """
            select *
            from learning_events
            where user_id = ?
            order by created_at desc
            limit ?
            """,
            (self.user_id, limit),
        ).fetchall()

        events: list[dict[str, Any]] = []
        for row in review_rows:
            source_book_id, source_book_title = _source_book_details(row)
            events.append(
                {
                    "id": row["id"],
                    "type": "review_completed",
                    "xpDelta": 0,
                    "createdAt": row["created_at"],
                    "bookId": source_book_id,
                    "deckId": row["deck_id"],
                    "cardId": row["card_id"],
                    "label": f'Reviewed "{row["cue"]}"',
                    "detail": source_book_title or row["rating"],
                }
            )

        for row in event_rows:
            events.append(
                {
                    "id": row["id"],
                    "type": row["event_type"],
                    "xpDelta": int(row["xp_delta"] or 0),
                    "createdAt": row["created_at"],
                    "bookId": row["book_id"],
                    "deckId": row["deck_id"],
                    "cardId": row["card_id"],
                    "label": row["label"],
                    "detail": row["detail"],
                }
            )

        events.sort(key=lambda item: item["createdAt"], reverse=True)
        return events[:limit]

    def learning_home_summary(self) -> dict[str, Any]:
        now = _utc_now()
        day_start, day_end = _local_day_bounds(now)
        with self.connection() as conn:
            default_deck = self._default_deck_summary(conn, now)
            xp_today = conn.execute(
                """
                select coalesce(sum(xp_delta), 0)
                from learning_events
                where user_id = ?
                  and created_at >= ?
                  and created_at < ?
                """,
                (self.user_id, _serialize_timestamp(day_start), _serialize_timestamp(day_end)),
            ).fetchone()[0]
            lessons_today = conn.execute(
                """
                select count(*)
                from learning_events
                where user_id = ?
                  and event_type = 'lesson_completed'
                  and created_at >= ?
                  and created_at < ?
                """,
                (self.user_id, _serialize_timestamp(day_start), _serialize_timestamp(day_end)),
            ).fetchone()[0]
            reviews_today = conn.execute(
                """
                select count(*)
                from review_logs
                where user_id = ?
                  and reviewed_at >= ?
                  and reviewed_at < ?
                """,
                (self.user_id, _serialize_timestamp(day_start), _serialize_timestamp(day_end)),
            ).fetchone()[0]
            lesson_queue = None
            if default_deck is not None:
                next_lesson_row = conn.execute(
                    """
                    select n.topic, n.metadata_json
                    from cards c
                    join notes n on n.id = c.note_id
                    where c.deck_id = ?
                      and c.is_suspended = false
                      and c.state = 'new'
                    order by c.created_at asc
                    limit 1
                    """,
                    (default_deck["id"],),
                ).fetchone()
                source_book_title = None
                if next_lesson_row is not None:
                    _, source_book_title = _source_book_details(next_lesson_row)
                lesson_queue = {
                    "queued": int(default_deck["newAvailable"]),
                    "topic": next_lesson_row["topic"] if next_lesson_row is not None else None,
                    "sourceBookTitle": source_book_title,
                }

            return {
                "hero": {
                    "streakDays": self._learning_streak_days(conn, now),
                    "xpToday": int(xp_today or 0),
                    "xpGoal": 80,
                    "reviewsToday": int(reviews_today or 0),
                    "lessonsToday": int(lessons_today or 0),
                },
                "defaultDeck": default_deck,
                "lessonQueue": lesson_queue,
                "recentActivity": self._recent_learning_activity(conn),
            }

    def record_learning_event(self, request: LearningEventRequest | dict[str, Any]) -> dict[str, Any]:
        active_request = request if isinstance(request, LearningEventRequest) else LearningEventRequest.model_validate(request)
        now = _utc_now()
        event_type = _normalize_compact_text(active_request.type)
        if event_type is None:
            raise HTTPException(status_code=400, detail="Learning event type cannot be empty.")
        label = _normalize_line(active_request.label) or event_type.replace("_", " ").title()
        detail = _normalize_line(active_request.detail)
        payload = {
            "type": event_type,
            "bookId": _normalize_compact_text(active_request.bookId),
            "deckId": _normalize_compact_text(active_request.deckId),
            "cardId": _normalize_compact_text(active_request.cardId),
        }
        record = {
            "id": _make_id(),
            "type": event_type,
            "xpDelta": int(active_request.xpDelta),
            "createdAt": _serialize_timestamp(now),
            "bookId": payload["bookId"],
            "deckId": payload["deckId"],
            "cardId": payload["cardId"],
            "label": label,
            "detail": detail,
        }

        with self.connection() as conn:
            conn.execute(
                """
                insert into learning_events (
                    id,
                    user_id,
                    event_type,
                    xp_delta,
                    book_id,
                    deck_id,
                    card_id,
                    label,
                    detail,
                    payload_json,
                    created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    self.user_id,
                    record["type"],
                    record["xpDelta"],
                    record["bookId"],
                    record["deckId"],
                    record["cardId"],
                    record["label"],
                    record["detail"],
                    _jp(payload),
                    record["createdAt"],
                ),
            )

        return record

    def create_deck(self, request: DeckCreateRequest) -> dict[str, Any]:
        now = _utc_now()
        title = _normalize_compact_text(request.title)
        if title is None:
            raise HTTPException(status_code=400, detail="Deck title cannot be empty.")
        description = _normalize_line(request.description)
        config = _normalize_config(request.config)
        with self.connection() as conn:
            duplicate = conn.execute(
                """
                select 1
                from decks
                where user_id = ?
                  and lower(title) = lower(?)
                """,
                (self.user_id, title),
            ).fetchone()
            if duplicate is not None:
                raise HTTPException(status_code=409, detail="A deck with this title already exists.")
            deck_id = _make_id()
            timestamp = _serialize_timestamp(now)
            conn.execute(
                """
                insert into decks (
                    id,
                    user_id,
                    title,
                    description,
                    config_json,
                    created_at,
                    updated_at
                ) values (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    deck_id,
                    self.user_id,
                    title,
                    description,
                    _jp(config),
                    timestamp,
                    timestamp,
                ),
            )
            deck_row = self._require_deck(conn, deck_id)
            return self._deck_summary(conn, deck_row, now)

    def get_deck_dashboard(self, deck_id: str) -> dict[str, Any]:
        now = _utc_now()
        with self.connection() as conn:
            deck_row = self._require_deck(conn, deck_id)
            note_rows = conn.execute(
                """
                select *
                from notes
                where deck_id = ?
                order by updated_at desc, created_at desc
                limit 120
                """,
                (deck_id,),
            ).fetchall()
            note_ids = [row["id"] for row in note_rows]
            card_rows_by_note: dict[str, list[sqlite3.Row]] = {note_id: [] for note_id in note_ids}
            if note_ids:
                placeholders = ", ".join(["?"] * len(note_ids))
                card_rows = conn.execute(
                    f"""
                    select *
                    from cards
                    where note_id in ({placeholders})
                    order by position asc, created_at asc
                    """,
                    note_ids,
                ).fetchall()
                for row in card_rows:
                    card_rows_by_note.setdefault(row["note_id"], []).append(row)

            recent_reviews = conn.execute(
                """
                select
                    rl.*,
                    c.card_type,
                    c.cue,
                    n.front,
                    n.topic
                from review_logs rl
                join cards c on c.id = rl.card_id
                join notes n on n.id = c.note_id
                where c.deck_id = ?
                order by rl.reviewed_at desc
                limit 18
                """,
                (deck_id,),
            ).fetchall()
            summary = self._deck_summary(conn, deck_row, now)
            config = _normalize_config(_json_load_dict(deck_row["config_json"]))
            return {
                "deck": summary,
                "analytics": self._analytics(conn, deck_id, now, config=config),
                "notes": [self._serialize_note(row, card_rows_by_note.get(row["id"], [])) for row in note_rows],
                "recentReviews": [
                    {
                        "id": row["id"],
                        "cardId": row["card_id"],
                        "rating": row["rating"],
                        "reviewedAt": row["reviewed_at"],
                        "stateBefore": row["state_before"],
                        "stateAfter": row["state_after"],
                        "responseMs": row["response_ms"],
                        "answerMode": row["answer_mode"],
                        "cue": row["cue"],
                        "topic": row["topic"],
                        "cardType": row["card_type"],
                        "typedResponse": row["typed_response"],
                    }
                    for row in recent_reviews
                ],
            }

    def create_note(self, deck_id: str, request: NoteCreateRequest) -> dict[str, Any]:
        now = _utc_now()
        with self.connection() as conn:
            deck_row = self._require_deck(conn, deck_id)
            front = _normalize_line(request.front)
            back = _normalize_line(request.back)
            extra = _normalize_line(request.extra)
            hint = _normalize_line(request.hint)
            explanation = _normalize_line(request.explanation)
            example_sentence = _normalize_line(request.exampleSentence)
            topic = _normalize_compact_text(request.topic)
            tags = _normalize_tags(request.tags)
            metadata = request.metadata if isinstance(request.metadata, dict) else {}
            raw_source_ref = _normalize_compact_text(request.sourceRef)
            source_ref = f"user:{self.user_id}:{raw_source_ref}" if raw_source_ref else None
            if source_ref:
                duplicate = conn.execute(
                    "select id from notes where source_ref = ? and deck_id = ? and user_id = ?",
                    (source_ref, deck_id, self.user_id),
                ).fetchone()
                if duplicate is not None:
                    note_row = conn.execute("select * from notes where id = ?", (duplicate["id"],)).fetchone()
                    card_rows = conn.execute(
                        "select * from cards where note_id = ? order by position asc",
                        (duplicate["id"],),
                    ).fetchall()
                    return {
                        "note": self._serialize_note(note_row, list(card_rows)),
                        "deck": self._deck_summary(conn, deck_row, now),
                    }

            if back is None and request.noteType in {"basic", "basic_reverse"} and front and self._dictionary_lookup is not None:
                try:
                    dictionary_payload = self._dictionary_lookup(front)
                except Exception:
                    dictionary_payload = {}
                entries = dictionary_payload.get("entries") if isinstance(dictionary_payload, dict) else None
                if isinstance(entries, list) and entries:
                    first_definition = entries[0].get("definition") if isinstance(entries[0], dict) else None
                    back = _normalize_line(first_definition)
                    if back is not None:
                        metadata = {
                            **metadata,
                            "dictionarySource": dictionary_payload.get("source"),
                        }
                        pronunciation = dictionary_payload.get("pronunciation")
                        if pronunciation:
                            metadata["pronunciation"] = pronunciation
            if back is None and request.noteType in {"basic", "basic_reverse"}:
                back = "Saved from reading"
            specs = _generate_card_specs(request.noteType, front or "", back)
            note_id = _make_id()
            timestamp = _serialize_timestamp(now)
            conn.execute(
                """
                insert into notes (
                    id,
                    deck_id,
                    user_id,
                    note_type,
                    front,
                    back,
                    extra,
                    hint,
                    explanation,
                    example_sentence,
                    image_url,
                    audio_url,
                    tags_json,
                    topic,
                    source_ref,
                    metadata_json,
                    created_at,
                    updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    note_id,
                    deck_id,
                    self.user_id,
                    request.noteType,
                    front,
                    back,
                    extra,
                    hint,
                    explanation,
                    example_sentence,
                    _normalize_line(request.imageUrl),
                    _normalize_line(request.audioUrl),
                    _jp(tags),
                    topic,
                    source_ref,
                    _jp(metadata),
                    timestamp,
                    timestamp,
                ),
            )
            for spec in specs:
                conn.execute(
                    """
                    insert into cards (
                        id,
                        deck_id,
                        note_id,
                        user_id,
                        card_type,
                        state,
                        due_at,
                        last_review_at,
                        stability,
                        difficulty,
                        elapsed_days,
                        scheduled_days,
                        reps,
                        lapses,
                        learning_step_index,
                        is_suspended,
                        position,
                        cloze_index,
                        cue,
                        answer,
                        created_at,
                        updated_at
                    ) values (?, ?, ?, ?, ?, 'new', ?, null, null, null, 0, 0, 0, 0, 0, false, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        _make_id(),
                        deck_id,
                        note_id,
                        self.user_id,
                        spec["card_type"],
                        timestamp,
                        spec["position"],
                        spec["cloze_index"],
                        spec["cue"],
                        spec["answer"],
                        timestamp,
                        timestamp,
                    ),
                )
            conn.execute("update decks set updated_at = ? where id = ?", (timestamp, deck_row["id"]))
            deck_row = self._require_deck(conn, deck_id)
            note_row = conn.execute("select * from notes where id = ?", (note_id,)).fetchone()
            card_rows = conn.execute("select * from cards where note_id = ? order by position asc", (note_id,)).fetchall()
            return {
                "note": self._serialize_note(note_row, list(card_rows)),
                "deck": self._deck_summary(conn, deck_row, now),
            }

    def update_note_mnemonic(self, note_id: str, request: NoteMnemonicUpdateRequest) -> dict[str, Any]:
        now = _utc_now()
        mnemonic = _normalize_line(request.mnemonic)
        with self.connection() as conn:
            note_row = conn.execute(
                "select * from notes where id = ? and user_id = ?",
                (note_id, self.user_id),
            ).fetchone()
            if note_row is None:
                raise HTTPException(status_code=404, detail="Note not found.")

            metadata = _json_load_dict(note_row["metadata_json"])
            if mnemonic:
                metadata["mnemonic"] = mnemonic
            else:
                metadata.pop("mnemonic", None)
                studio = metadata.get("studio")
                if isinstance(studio, dict):
                    studio.pop("mnemonic", None)
                    if not studio:
                        metadata.pop("studio", None)
                    else:
                        metadata["studio"] = studio

            timestamp = _serialize_timestamp(now)
            conn.execute(
                """
                update notes
                set metadata_json = ?, updated_at = ?
                where id = ? and user_id = ?
                """,
                (_jp(metadata), timestamp, note_id, self.user_id),
            )
            conn.execute(
                "update decks set updated_at = ? where id = ?",
                (timestamp, note_row["deck_id"]),
            )
            refreshed = conn.execute("select * from notes where id = ?", (note_id,)).fetchone()
            card_rows = conn.execute("select * from cards where note_id = ? order by position asc", (note_id,)).fetchall()
            deck_row = self._require_deck(conn, note_row["deck_id"])
            return {
                "note": self._serialize_note(refreshed, list(card_rows)),
                "deck": self._deck_summary(conn, deck_row, now),
            }

    def import_archive_items(self, deck_id: str, request: ArchiveImportRequest) -> dict[str, Any]:
        now = _utc_now()
        created_notes: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        with self.connection() as conn:
            deck_row = self._require_deck(conn, deck_id)
            for item in request.items:
                source_ref = f"reader-archive:{item.bookId}:{item.sourceId}"
                duplicate = conn.execute(
                    "select id from notes where source_ref = ? and deck_id = ?",
                    (source_ref, deck_id),
                ).fetchone()
                if duplicate is not None:
                    skipped.append({"sourceId": item.sourceId, "reason": "already-imported"})
                    continue

                back = _normalize_line(item.note)
                explanation = None
                example_sentence = None
                metadata: dict[str, Any] = {
                    "source": "reader-archive",
                    "sourceId": item.sourceId,
                    "bookId": item.bookId,
                    "bookTitle": item.bookTitle,
                }
                if back is None and self._dictionary_lookup is not None:
                    dictionary_payload = self._dictionary_lookup(item.sourceText)
                    if dictionary_payload.get("entries"):
                        first_entry = dictionary_payload["entries"][0]
                        back = _normalize_line(first_entry.get("definition"))
                        explanation = _normalize_line(first_entry.get("notes"))
                        examples = first_entry.get("examples") or []
                        if examples:
                            example_sentence = _normalize_line(examples[0])
                        metadata["dictionarySource"] = dictionary_payload.get("source")
                        pronunciation = _normalize_line(dictionary_payload.get("pronunciation"))
                        if pronunciation:
                            metadata["pronunciation"] = pronunciation
                if back is None:
                    skipped.append({"sourceId": item.sourceId, "reason": "missing-definition"})
                    continue

                front = _normalize_line(item.sourceText)
                specs = _generate_card_specs("basic", front or "", back)
                note_id = _make_id()
                timestamp = _serialize_timestamp(_parse_timestamp(item.createdAt, fallback=now))
                conn.execute(
                    """
                    insert into notes (
                        id,
                        deck_id,
                        user_id,
                        note_type,
                        front,
                        back,
                        extra,
                        hint,
                        explanation,
                        example_sentence,
                        image_url,
                        audio_url,
                        tags_json,
                        topic,
                        source_ref,
                        metadata_json,
                        created_at,
                        updated_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        note_id,
                        deck_id,
                        self.user_id,
                        "basic",
                        front,
                        back,
                        f"Imported from {item.bookTitle}",
                        None,
                        explanation,
                        example_sentence,
                        None,
                        None,
                        _jp(["reader-archive"]),
                        item.bookTitle,
                        source_ref,
                        _jp(metadata),
                        timestamp,
                        timestamp,
                    ),
                )
                for spec in specs:
                    conn.execute(
                        """
                        insert into cards (
                            id,
                            deck_id,
                            note_id,
                            user_id,
                            card_type,
                            state,
                            due_at,
                            last_review_at,
                            stability,
                            difficulty,
                            elapsed_days,
                            scheduled_days,
                            reps,
                            lapses,
                            learning_step_index,
                            is_suspended,
                            position,
                            cloze_index,
                            cue,
                            answer,
                            created_at,
                            updated_at
                        ) values (?, ?, ?, ?, ?, 'new', ?, null, null, null, 0, 0, 0, 0, 0, false, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            _make_id(),
                            deck_id,
                            note_id,
                            self.user_id,
                            spec["card_type"],
                            timestamp,
                            spec["position"],
                            spec["cloze_index"],
                            spec["cue"],
                            spec["answer"],
                            timestamp,
                            timestamp,
                        ),
                    )
                note_row = conn.execute("select * from notes where id = ?", (note_id,)).fetchone()
                card_rows = conn.execute("select * from cards where note_id = ? order by position asc", (note_id,)).fetchall()
                created_notes.append(self._serialize_note(note_row, list(card_rows)))

            conn.execute(
                "update decks set updated_at = ? where id = ?",
                (_serialize_timestamp(now), deck_row["id"]),
            )
            deck_row = self._require_deck(conn, deck_id)
            return {
                "createdCount": len(created_notes),
                "skipped": skipped,
                "notes": created_notes,
                "deck": self._deck_summary(conn, deck_row, now),
            }

    def get_session(self, deck_id: str, *, avoid_note_id: str | None = None, avoid_topic: str | None = None) -> dict[str, Any]:
        now = _utc_now()
        with self.connection() as conn:
            deck_row = self._require_deck(conn, deck_id)
            summary = self._deck_summary(conn, deck_row, now)
            next_row = self._choose_next_card(
                conn,
                deck_id=deck_id,
                now=now,
                avoid_note_id=avoid_note_id,
                avoid_topic=avoid_topic,
            )
            return {
                "deck": summary,
                "summary": summary,
                "currentCard": self._serialize_session_card(conn, next_row, now) if next_row else None,
            }

    def _context_grounding(self, row: sqlite3.Row) -> tuple[dict[str, Any], dict[str, Any]]:
        term = _context_term(row)
        dictionary_payload: dict[str, Any] = {}
        if self._dictionary_lookup is not None:
            try:
                looked_up = self._dictionary_lookup(term)
            except Exception:
                looked_up = {}
            if isinstance(looked_up, dict):
                dictionary_payload = looked_up

        entries = dictionary_payload.get("entries") if isinstance(dictionary_payload.get("entries"), list) else []
        definitions = [
            _normalize_line(entry.get("definition"))
            for entry in entries
            if isinstance(entry, dict)
        ]
        definitions = [definition for definition in definitions if definition][:3]

        examples: list[str] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            raw_examples = entry.get("examples")
            if not isinstance(raw_examples, list):
                continue
            for example in raw_examples:
                normalized = _normalize_line(example if isinstance(example, str) else None)
                if normalized:
                    examples.append(normalized)
        if row["example_sentence"]:
            examples.append(_normalize_line(row["example_sentence"]))
        examples = list(dict.fromkeys(example for example in examples if example))[:4]

        definition = (
            definitions[0]
            if definitions
            else _normalize_line(row["back"])
            or _normalize_line(row["answer"])
            or "a vocabulary word in this deck"
        )
        pronunciation = _normalize_line(dictionary_payload.get("pronunciation")) or _extract_pronunciation(row)
        explanation = _normalize_line(row["explanation"])
        fallback = _fallback_context_payload(
            term=term,
            definition=definition,
            pronunciation=pronunciation,
            example_sentence=examples[0] if examples else None,
            explanation=explanation,
        )
        grounding = {
            "term": term,
            "pronunciation": pronunciation,
            "definition": definition,
            "definitions": definitions,
            "dictionaryExamples": examples,
            "explanation": explanation,
            "cardType": row["card_type"],
            "noteType": row["note_type"],
            "variationHint": uuid.uuid4().hex[:8],
        }
        return grounding, fallback

    def _lesson_fallback_payload(self, grounding: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
        term = grounding["term"]
        definition = grounding["definition"]
        return {
            "provider": "fallback",
            "term": term,
            "pronunciation": grounding["pronunciation"],
            "definition": definition,
            "contextTitle": fallback["contextTitle"],
            "contextParagraph": fallback["contextParagraph"],
            "usageFocus": fallback["usageFocus"][:2],
            "recallPrompt": f'Explain what "{term}" means in plain English before you look at the answer.',
            "usagePrompt": f'Use "{term}" in one short sentence about a real situation from your day.',
            "speakingPrompt": f'Listen to "{term}", then say it aloud once and read the context sentence aloud.',
            "productionPrompt": f'Write 3 original sentences that use "{term}" naturally in different situations.',
        }

    def _grounded_coach_payload(
        self,
        row: sqlite3.Row,
        request: CardCoachRequest,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        grounding, fallback_context = self._context_grounding(row)
        payload = {
            **grounding,
            "cue": row["cue"],
            "correctAnswer": row["answer"],
            "exampleSentence": row["example_sentence"],
            "mode": request.mode,
            "step": request.step,
            "turnIndex": request.turnIndex,
            "learnerResponse": _normalize_line(request.learnerResponse),
            "history": _normalize_history(request.history),
        }
        return payload, fallback_context

    def _score_response_match(
        self,
        learner_response: str | None,
        *,
        correct_answer: str,
        definitions: list[str],
    ) -> tuple[Literal["correct", "close", "incorrect"], float]:
        learner_tokens = set(_tokenize_text(learner_response))
        if not learner_tokens:
            return "incorrect", 0.0

        reference_texts = [correct_answer] + [value for value in definitions if value and value != correct_answer]
        best_score = 0.0
        for reference in reference_texts:
            reference_tokens = set(_tokenize_text(reference))
            if not reference_tokens:
                continue
            if learner_tokens == reference_tokens:
                return "correct", 1.0
            overlap = learner_tokens & reference_tokens
            score = len(overlap) / max(len(reference_tokens), 1)
            if reference.casefold() in " ".join(sorted(learner_tokens)):
                score = max(score, 0.85)
            best_score = max(best_score, score)

        if best_score >= 0.72:
            return "correct", best_score
        if best_score >= 0.32:
            return "close", best_score
        return "incorrect", best_score

    def _fallback_coach_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        learner_response = _normalize_line(payload.get("learnerResponse"))
        definitions = [value for value in payload.get("definitions", []) if isinstance(value, str)]
        verdict, score = self._score_response_match(
            learner_response,
            correct_answer=str(payload.get("correctAnswer") or payload.get("definition") or ""),
            definitions=definitions,
        )
        turn_index = max(1, min(3, int(payload.get("turnIndex") or 1)))
        correct_answer = str(payload.get("correctAnswer") or payload.get("definition") or "")
        term = str(payload.get("term") or "this word")
        if verdict == "correct":
            feedback_title = "You got the meaning."
            feedback_body = "That recall is strong enough to move on. Use the word once in your own phrasing."
            next_prompt = f'Use "{term}" in one quick sentence about a real situation.'
            suggested_rating = "good" if score < 0.95 else "easy"
            can_rate = True
        elif verdict == "close":
            feedback_title = "Close, but tighten the meaning."
            feedback_body = "You were in the right area, but the answer needs to be more precise."
            next_prompt = f'Retry in one short line: what does "{term}" mean exactly?'
            suggested_rating = "hard"
            can_rate = turn_index >= 2
        else:
            feedback_title = "Reset the meaning now."
            feedback_body = "Your answer missed the target meaning. Read it, say it once, then try again."
            next_prompt = f'Retry: explain "{term}" in plain English without copying the full answer.'
            suggested_rating = "again"
            can_rate = turn_index >= 3
        if payload.get("step") == "usage" and turn_index >= 2:
            can_rate = True
        return {
            "provider": "fallback",
            "verdict": verdict,
            "feedbackTitle": feedback_title,
            "feedbackBody": feedback_body,
            "correction": correct_answer,
            "nextPrompt": next_prompt,
            "suggestedRating": suggested_rating,
            "canRate": can_rate,
            "turnCount": turn_index,
        }

    def _fallback_sentence_feedback(self, row: sqlite3.Row, sentences: list[str]) -> dict[str, Any]:
        target = _context_term(row)
        definition = _normalize_line(row["back"]) or row["answer"]
        sentence_notes: list[dict[str, Any]] = []
        accepted = True
        for sentence in sentences:
            if not _term_in_text(target, sentence):
                accepted = False
                sentence_notes.append(
                    {
                        "sentence": sentence,
                        "accepted": False,
                        "note": f'Use "{target}" directly in this sentence.',
                    }
                )
                continue
            if len(_tokenize_text(sentence)) < 4:
                accepted = False
                sentence_notes.append(
                    {
                        "sentence": sentence,
                        "accepted": False,
                        "note": "Make the sentence a little fuller so the meaning is clearer.",
                    }
                )
                continue
            sentence_notes.append(
                {
                    "sentence": sentence,
                    "accepted": True,
                    "note": f'This sentence uses "{target}" in a workable way.',
                }
            )
        feedback = (
            f'All 3 sentences use "{target}" clearly enough to log.'
            if accepted
            else f'Keep revising until all 3 sentences use "{target}" naturally and clearly.'
        )
        return {
            "provider": "fallback",
            "accepted": accepted,
            "feedback": feedback if definition is None else f"{feedback} Anchor on this meaning: {definition}",
            "sentenceNotes": sentence_notes,
        }

    def _log_practice_attempt(
        self,
        conn: sqlite3.Connection,
        *,
        card_id: str,
        mode: str,
        step: str,
        turn_index: int,
        provider: str,
        learner_input: dict[str, Any] | None,
        ai_payload: dict[str, Any],
    ) -> None:
        now = _serialize_timestamp(_utc_now())
        conn.execute(
            """
            insert into practice_attempts (
                id,
                card_id,
                user_id,
                mode,
                step,
                turn_index,
                provider,
                learner_input_json,
                ai_payload_json,
                verdict,
                suggested_rating,
                created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _make_id(),
                card_id,
                self.user_id,
                mode,
                step,
                turn_index,
                provider,
                _jp(learner_input) if learner_input is not None else None,
                _jp(ai_payload),
                ai_payload.get("verdict"),
                ai_payload.get("suggestedRating"),
                now,
            ),
        )

    def _openai_json_completion(
        self,
        *,
        schema_name: str,
        schema: dict[str, Any],
        system_prompt: str,
        prompt: dict[str, Any],
        temperature: float,
    ) -> dict[str, Any] | None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            return None
        response = httpx.post(
            OPENAI_CHAT_COMPLETIONS_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": OPENAI_CONTEXT_MODEL,
                "temperature": temperature,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": json.dumps(prompt)},
                ],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema_name,
                        "strict": True,
                        "schema": schema,
                    },
                },
            },
            timeout=httpx.Timeout(30.0, connect=10.0),
        )
        response.raise_for_status()
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        if isinstance(content, list):
            raw = "".join(item.get("text", "") for item in content if isinstance(item, dict)).strip()
        else:
            raw = str(content).strip()
        if not raw:
            return None
        return json.loads(raw)

    def _get_cached_context(
        self,
        conn: sqlite3.Connection,
        *,
        card_id: str,
        cache_key: str,
    ) -> dict[str, Any] | None:
        row = conn.execute(
            """
            select payload_json
            from card_context_cache
            where card_id = ? and cache_key = ? and user_id = ?
            """,
            (card_id, cache_key, self.user_id),
        ).fetchone()
        if row is None:
            return None

        raw_payload = row["payload_json"]
        if isinstance(raw_payload, str):
            try:
                payload = json.loads(raw_payload)
            except json.JSONDecodeError:
                return None
        else:
            payload = raw_payload
        if not isinstance(payload, dict):
            return None
        if not isinstance(payload.get("contextParagraph"), str):
            return None
        return payload

    def _store_cached_context(
        self,
        conn: sqlite3.Connection,
        *,
        card_id: str,
        cache_key: str,
        payload: dict[str, Any],
    ) -> None:
        now = _serialize_timestamp(_utc_now())
        payload_json = _jp(payload)
        conn.execute(
            """
            insert into card_context_cache (
                id,
                card_id,
                user_id,
                cache_key,
                payload_json,
                source,
                created_at,
                updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(card_id, cache_key) do update set
                payload_json = excluded.payload_json,
                source = excluded.source,
                updated_at = excluded.updated_at
            """,
            (
                _make_id(),
                card_id,
                self.user_id,
                cache_key,
                payload_json,
                str(payload.get("source") or "ai"),
                now,
                now,
            ),
        )

    def _generate_context_with_openai(self, grounding: dict[str, Any]) -> dict[str, Any] | None:
        schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "contextTitle": {"type": "string"},
                "contextParagraph": {"type": "string"},
                "usageFocus": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 2,
                    "maxItems": 3,
                },
                "practicePrompts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 3,
                    "maxItems": 3,
                },
            },
            "required": ["contextTitle", "contextParagraph", "usageFocus", "practicePrompts"],
        }
        prompt = {
            "task": "Create fresh English-only vocabulary context grounded in the supplied dictionary data.",
            "rules": [
                "Use only the supplied meaning and examples as grounding.",
                "Do not translate or switch languages.",
                "Write a natural mini-context in 3 to 4 sentences.",
                "Use the target term naturally 1 or 2 times.",
                "Make the situation concrete and different each time.",
                "The practice prompts must ask the learner to write original sentences, not copy the context paragraph.",
            ],
            "word": grounding,
        }
        parsed = self._openai_json_completion(
            schema_name="vocabulary_context",
            schema=schema,
            system_prompt=(
                "You are an English vocabulary coach. Create concise, natural, grounded context for one "
                "English word. Return valid JSON only."
            ),
            prompt=prompt,
            temperature=0.9,
        )
        if not isinstance(parsed, dict):
            return None
        return {
            "source": "ai",
            "term": grounding["term"],
            "pronunciation": grounding["pronunciation"],
            "definition": grounding["definition"],
            "contextTitle": _normalize_line(parsed.get("contextTitle")) or f'{grounding["term"]} in context',
            "contextParagraph": _normalize_line(parsed.get("contextParagraph")) or "",
            "usageFocus": [
                item
                for item in (_normalize_line(value) for value in parsed.get("usageFocus", []))
                if item
            ][:3],
            "practicePrompts": [
                item
                for item in (_normalize_line(value) for value in parsed.get("practicePrompts", []))
                if item
            ][:3],
        }

    def _generate_lesson_with_openai(self, grounding: dict[str, Any]) -> dict[str, Any] | None:
        schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "contextTitle": {"type": "string"},
                "contextParagraph": {"type": "string"},
                "usageFocus": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 2,
                    "maxItems": 3,
                },
                "recallPrompt": {"type": "string"},
                "usagePrompt": {"type": "string"},
                "speakingPrompt": {"type": "string"},
                "productionPrompt": {"type": "string"},
            },
            "required": [
                "contextTitle",
                "contextParagraph",
                "usageFocus",
                "recallPrompt",
                "usagePrompt",
                "speakingPrompt",
                "productionPrompt",
            ],
        }
        prompt = {
            "task": "Create one short English-only lesson plan for a saved vocabulary word.",
            "rules": [
                "Stay grounded in the supplied meaning and examples.",
                "Make the context concrete and interactive.",
                "Keep the learner active with one recall prompt, one usage prompt, one speaking prompt, and one production prompt.",
            ],
            "word": grounding,
        }
        parsed = self._openai_json_completion(
            schema_name="vocabulary_lesson",
            schema=schema,
            system_prompt="You are an English vocabulary coach. Build a short lesson for one word. Return valid JSON only.",
            prompt=prompt,
            temperature=0.8,
        )
        if not isinstance(parsed, dict):
            return None
        return {
            "provider": "openai",
            "term": grounding["term"],
            "pronunciation": grounding["pronunciation"],
            "definition": grounding["definition"],
            "contextTitle": _normalize_line(parsed.get("contextTitle")) or f'{grounding["term"]} in context',
            "contextParagraph": _normalize_line(parsed.get("contextParagraph")) or "",
            "usageFocus": [
                item
                for item in (_normalize_line(value) for value in parsed.get("usageFocus", []))
                if item
            ][:3],
            "recallPrompt": _normalize_line(parsed.get("recallPrompt")) or "",
            "usagePrompt": _normalize_line(parsed.get("usagePrompt")) or "",
            "speakingPrompt": _normalize_line(parsed.get("speakingPrompt")) or "",
            "productionPrompt": _normalize_line(parsed.get("productionPrompt")) or "",
        }

    def _generate_coach_with_openai(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "verdict": {"type": "string"},
                "feedbackTitle": {"type": "string"},
                "feedbackBody": {"type": "string"},
                "correction": {"type": "string"},
                "nextPrompt": {"type": "string"},
                "suggestedRating": {"type": ["string", "null"]},
                "canRate": {"type": "boolean"},
            },
            "required": [
                "verdict",
                "feedbackTitle",
                "feedbackBody",
                "correction",
                "nextPrompt",
                "suggestedRating",
                "canRate",
            ],
        }
        prompt = {
            "task": "Evaluate one learner response for a vocabulary word.",
            "rules": [
                "Stay grounded in the supplied meaning and examples.",
                "Return correct, close, or incorrect.",
                "Keep feedback to 1 or 2 short sentences.",
                "suggestedRating must be one of again, hard, good, easy, or null.",
            ],
            "payload": payload,
        }
        parsed = self._openai_json_completion(
            schema_name="vocabulary_coach",
            schema=schema,
            system_prompt="You are an English vocabulary coach. Evaluate one learner response and return JSON only.",
            prompt=prompt,
            temperature=0.3,
        )
        if not isinstance(parsed, dict):
            return None
        return {
            "provider": "openai",
            "verdict": _normalize_verdict(parsed.get("verdict")),
            "feedbackTitle": _normalize_line(parsed.get("feedbackTitle")) or "Keep going.",
            "feedbackBody": _normalize_line(parsed.get("feedbackBody")) or "",
            "correction": _normalize_line(parsed.get("correction")) or str(payload.get("correctAnswer") or ""),
            "nextPrompt": _normalize_line(parsed.get("nextPrompt")) or "",
            "suggestedRating": _normalize_rating(parsed.get("suggestedRating")),
            "canRate": bool(parsed.get("canRate")),
            "turnCount": max(1, min(3, int(payload.get("turnIndex") or 1))),
        }

    def _generate_sentence_feedback_with_openai(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "accepted": {"type": "boolean"},
                "feedback": {"type": "string"},
                "sentenceNotes": {
                    "type": "array",
                    "minItems": 3,
                    "maxItems": 3,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "accepted": {"type": "boolean"},
                            "note": {"type": "string"},
                        },
                        "required": ["accepted", "note"],
                    },
                },
            },
            "required": ["accepted", "feedback", "sentenceNotes"],
        }
        prompt = {
            "task": "Evaluate three learner-written sentences for a vocabulary word.",
            "rules": [
                "Stay grounded in the supplied meaning and examples.",
                "Mark a sentence accepted only if it uses the target word naturally and correctly.",
                "Give concise notes only.",
            ],
            "payload": payload,
        }
        parsed = self._openai_json_completion(
            schema_name="vocabulary_sentence_feedback",
            schema=schema,
            system_prompt="You are an English vocabulary coach. Evaluate three learner sentences and return JSON only.",
            prompt=prompt,
            temperature=0.25,
        )
        if not isinstance(parsed, dict):
            return None
        sentence_notes: list[dict[str, Any]] = []
        raw_notes = parsed.get("sentenceNotes")
        sentences = [item for item in payload.get("sentences", []) if isinstance(item, str)]
        if isinstance(raw_notes, list):
            for index, item in enumerate(raw_notes[: len(sentences)]):
                if not isinstance(item, dict):
                    continue
                sentence_notes.append(
                    {
                        "sentence": sentences[index] if index < len(sentences) else "",
                        "accepted": bool(item.get("accepted")),
                        "note": _normalize_line(item.get("note")) or "",
                    }
                )
        for index in range(len(sentence_notes), len(sentences)):
            sentence_notes.append({"sentence": sentences[index], "accepted": False, "note": ""})
        return {
            "provider": "openai",
            "accepted": bool(parsed.get("accepted")),
            "feedback": _normalize_line(parsed.get("feedback")) or "",
            "sentenceNotes": sentence_notes,
        }

    def _resolve_context_generators(self) -> list[ContextGenerator]:
        generators = list(self._context_generators)
        if self._allow_openai_fallback:
            generators.append(self._generate_context_with_openai)
        return generators

    def _resolve_lesson_generators(self) -> list[LessonGenerator]:
        generators = list(self._lesson_generators)
        if self._allow_openai_fallback:
            generators.append(self._generate_lesson_with_openai)
        return generators

    def _resolve_coach_generators(self) -> list[CoachGenerator]:
        generators = list(self._coach_generators)
        if self._allow_openai_fallback:
            generators.append(self._generate_coach_with_openai)
        return generators

    def _resolve_sentence_generators(self) -> list[SentenceCoachGenerator]:
        generators = list(self._sentence_generators)
        if self._allow_openai_fallback:
            generators.append(self._generate_sentence_feedback_with_openai)
        return generators

    def generate_card_context(self, card_id: str, request: CardContextRequest | None = None) -> dict[str, Any]:
        cache_key = _context_cache_key(request)
        with self.connection() as conn:
            row = self._require_card(conn, card_id)
            cached = self._get_cached_context(conn, card_id=card_id, cache_key=cache_key)
            if cached is not None:
                return cached
        grounding, fallback = self._context_grounding(row)
        if request and request.refreshHint:
            grounding["variationHint"] = request.refreshHint

        generated = None
        for generator in self._resolve_context_generators():
            try:
                candidate = generator(grounding)
            except Exception:
                continue
            if isinstance(candidate, dict):
                generated = candidate
                break

        if not isinstance(generated, dict):
            return fallback

        payload = dict(generated)
        payload.setdefault("source", "ai")
        payload.setdefault("term", grounding["term"])
        payload.setdefault("pronunciation", grounding["pronunciation"])
        payload.setdefault("definition", grounding["definition"])
        payload["contextTitle"] = _normalize_line(payload.get("contextTitle")) or fallback["contextTitle"]
        payload["contextParagraph"] = _normalize_line(payload.get("contextParagraph")) or fallback["contextParagraph"]
        payload["usageFocus"] = [
            item
            for item in (_normalize_line(value) for value in payload.get("usageFocus", []))
            if item
        ][:3] or fallback["usageFocus"]
        payload["practicePrompts"] = [
            item
            for item in (_normalize_line(value) for value in payload.get("practicePrompts", []))
            if item
        ][:3] or fallback["practicePrompts"]
        with self.connection() as conn:
            self._store_cached_context(conn, card_id=card_id, cache_key=cache_key, payload=payload)
        return payload

    def create_practice_session(self, deck_id: str, request: PracticeSessionRequest | None = None) -> dict[str, Any]:
        active_request = request or PracticeSessionRequest()
        now = _utc_now()
        with self.connection() as conn:
            deck_row = self._require_deck(conn, deck_id)
            summary = self._deck_summary(conn, deck_row, now)
            queue = self._select_practice_queue(
                conn,
                deck_id=deck_id,
                focus=active_request.focus,
                limit=active_request.limit,
                card_ids=active_request.cardIds or None,
                now=now,
            )
            return {
                "deck": summary,
                "focus": active_request.focus,
                "items": [self._serialize_session_card(conn, row, now) for row in queue],
            }

    def generate_card_lesson(self, card_id: str, request: CardLessonRequest | None = None) -> dict[str, Any]:
        with self.connection() as conn:
            row = self._require_card(conn, card_id)
        grounding, fallback = self._context_grounding(row)
        if request and request.refreshHint:
            grounding["variationHint"] = request.refreshHint

        lesson_payload: dict[str, Any] | None = None
        for generator in self._resolve_lesson_generators():
            try:
                candidate = generator(grounding)
            except Exception:
                continue
            if isinstance(candidate, dict):
                lesson_payload = candidate
                break

        payload = lesson_payload if isinstance(lesson_payload, dict) else self._lesson_fallback_payload(grounding, fallback)
        normalized_payload = {
            "provider": _normalize_provider(payload.get("provider")),
            "term": grounding["term"],
            "pronunciation": grounding["pronunciation"],
            "definition": grounding["definition"],
            "contextTitle": _normalize_line(payload.get("contextTitle")) or fallback["contextTitle"],
            "contextParagraph": _normalize_line(payload.get("contextParagraph")) or fallback["contextParagraph"],
            "usageFocus": [
                item
                for item in (_normalize_line(value) for value in payload.get("usageFocus", []))
                if item
            ][:3]
            or fallback["usageFocus"][:2],
            "recallPrompt": _normalize_line(payload.get("recallPrompt"))
            or self._lesson_fallback_payload(grounding, fallback)["recallPrompt"],
            "usagePrompt": _normalize_line(payload.get("usagePrompt"))
            or self._lesson_fallback_payload(grounding, fallback)["usagePrompt"],
            "speakingPrompt": _normalize_line(payload.get("speakingPrompt"))
            or self._lesson_fallback_payload(grounding, fallback)["speakingPrompt"],
            "productionPrompt": _normalize_line(payload.get("productionPrompt"))
            or self._lesson_fallback_payload(grounding, fallback)["productionPrompt"],
        }
        with self.connection() as conn:
            self._log_practice_attempt(
                conn,
                card_id=card_id,
                mode="lesson",
                step="plan",
                turn_index=0,
                provider=normalized_payload["provider"],
                learner_input=None,
                ai_payload=normalized_payload,
            )
        return normalized_payload

    def coach_card(self, card_id: str, request: CardCoachRequest) -> dict[str, Any]:
        with self.connection() as conn:
            row = self._require_card(conn, card_id)
        payload, fallback_context = self._grounded_coach_payload(row, request)

        coach_payload: dict[str, Any] | None = None
        for generator in self._resolve_coach_generators():
            try:
                candidate = generator(payload)
            except Exception:
                continue
            if isinstance(candidate, dict):
                coach_payload = candidate
                break

        fallback = self._fallback_coach_payload(payload)
        raw = coach_payload if isinstance(coach_payload, dict) else fallback
        normalized = {
            "provider": _normalize_provider(raw.get("provider")),
            "verdict": _normalize_verdict(raw.get("verdict")),
            "feedbackTitle": _normalize_line(raw.get("feedbackTitle")) or fallback["feedbackTitle"],
            "feedbackBody": _normalize_line(raw.get("feedbackBody")) or fallback["feedbackBody"],
            "correction": _normalize_line(raw.get("correction")) or str(payload.get("correctAnswer") or ""),
            "nextPrompt": _normalize_line(raw.get("nextPrompt")) or fallback["nextPrompt"],
            "suggestedRating": _normalize_rating(raw.get("suggestedRating")) or fallback["suggestedRating"],
            "canRate": bool(raw.get("canRate")),
            "turnCount": max(1, min(3, int(raw.get("turnCount") or request.turnIndex))),
        }
        if not normalized["canRate"] and normalized["turnCount"] >= 3:
            normalized["canRate"] = True
        if normalized["verdict"] in {"close", "incorrect"}:
            normalized["context"] = fallback_context
        with self.connection() as conn:
            self._log_practice_attempt(
                conn,
                card_id=card_id,
                mode=request.mode,
                step=request.step,
                turn_index=request.turnIndex,
                provider=normalized["provider"],
                learner_input={
                    "learnerResponse": _normalize_line(request.learnerResponse),
                    "history": _normalize_history(request.history),
                },
                ai_payload=normalized,
            )
        return normalized

    def submit_card_production(self, card_id: str, request: CardProductionRequest) -> dict[str, Any]:
        sentences = _split_sentences(request.sentences)
        if len(sentences) < 3:
            return {
                "cardId": card_id,
                "accepted": False,
                "provider": "fallback",
                "feedback": "Write 3 original sentences before continuing.",
                "sentenceNotes": [
                    {
                        "sentence": sentence,
                        "accepted": False,
                        "note": "Add more sentences until there are 3.",
                    }
                    for sentence in sentences
                ],
                "productionCount": 0,
                "sentences": sentences,
            }

        now = _utc_now()
        with self.connection() as conn:
            row = self._require_card(conn, card_id)
            target = _context_term(row)
            feedback_payload = self._fallback_sentence_feedback(row, sentences)
            missing_target = [sentence for sentence in sentences if not _term_in_text(target, sentence)]

            if not missing_target:
                grounding, _ = self._context_grounding(row)
                sentence_payload = {
                    **grounding,
                    "sentences": sentences,
                }
                generated_feedback = None
                for generator in self._resolve_sentence_generators():
                    try:
                        candidate = generator(sentence_payload)
                    except Exception:
                        continue
                    if isinstance(candidate, dict):
                        generated_feedback = candidate
                        break
                if isinstance(generated_feedback, dict):
                    feedback_payload = {
                        "provider": _normalize_provider(generated_feedback.get("provider")),
                        "accepted": bool(generated_feedback.get("accepted")),
                        "feedback": _normalize_line(generated_feedback.get("feedback")) or feedback_payload["feedback"],
                        "sentenceNotes": [
                            {
                                "sentence": note.get("sentence") or sentences[index],
                                "accepted": bool(note.get("accepted")),
                                "note": _normalize_line(note.get("note")) or "",
                            }
                            for index, note in enumerate(generated_feedback.get("sentenceNotes", [])[: len(sentences)])
                        ],
                    }
                    for index in range(len(feedback_payload["sentenceNotes"]), len(sentences)):
                        feedback_payload["sentenceNotes"].append(
                            {
                                "sentence": sentences[index],
                                "accepted": False,
                                "note": "",
                            }
                        )
            else:
                feedback_payload = {
                    "provider": "fallback",
                    "accepted": False,
                    "feedback": f'Use "{target}" in each sentence before continuing.',
                    "sentenceNotes": [
                        {
                            "sentence": sentence,
                            "accepted": False,
                            "note": (f'Use "{target}" directly in this sentence.' if sentence in missing_target else f'This sentence uses "{target}" clearly enough.'),
                        }
                        for sentence in sentences
                    ],
                }

            accepted = bool(feedback_payload.get("accepted")) and not missing_target
            production_count = self._production_status(conn, row)["productionCount"]
            if accepted:
                conn.execute(
                    """
                    insert into production_logs (id, card_id, user_id, created_at, sentences_json)
                    values (?, ?, ?, ?, ?)
                    """,
                    (
                        _make_id(),
                        card_id,
                        self.user_id,
                        _serialize_timestamp(now),
                        _jp(sentences),
                    ),
                )
                production_count = self._production_status(conn, row)["productionCount"]
            return {
                "cardId": card_id,
                "accepted": accepted,
                "provider": feedback_payload.get("provider") or "fallback",
                "feedback": feedback_payload.get("feedback") or "",
                "sentenceNotes": feedback_payload.get("sentenceNotes") or [],
                "productionCount": production_count,
                "sentences": sentences,
            }

    def submit_review(self, card_id: str, request: CardReviewRequest) -> dict[str, Any]:
        reviewed_at = _parse_timestamp(request.reviewedAt, fallback=_utc_now())
        with self.connection() as conn:
            row = self._require_card(conn, card_id)
            deck_row = self._require_deck(conn, row["deck_id"])
            scheduler = _build_scheduler(_normalize_config(_json_load_dict(row["config_json"])))
            source_card = _row_to_card(row)
            next_card, _ = scheduler.review_card(
                source_card,
                _rating_to_fsrs(request.rating),
                review_datetime=reviewed_at,
            )
            state_before = row["state"]
            state_after = _fsrs_state_to_public(next_card.state)
            due_before = row["due_at"]
            due_after = _serialize_timestamp(next_card.due)
            last_review_before = _parse_timestamp(row["last_review_at"]) if row["last_review_at"] else None
            elapsed_days = 0
            if last_review_before is not None:
                elapsed_days = max(0, int((reviewed_at - last_review_before).total_seconds() // 86400))
            scheduled_days_after = max(0, int(round((next_card.due - reviewed_at).total_seconds() / 86400)))
            lapses = int(row["lapses"] or 0)
            if state_before == "review" and request.rating == "again":
                lapses += 1

            conn.execute(
                """
                update cards
                set
                    state = ?,
                    due_at = ?,
                    last_review_at = ?,
                    stability = ?,
                    difficulty = ?,
                    elapsed_days = ?,
                    scheduled_days = ?,
                    reps = ?,
                    lapses = ?,
                    learning_step_index = ?,
                    updated_at = ?
                where id = ?
                """,
                (
                    state_after,
                    due_after,
                    _serialize_timestamp(reviewed_at),
                    next_card.stability,
                    next_card.difficulty,
                    elapsed_days,
                    scheduled_days_after,
                    int(row["reps"] or 0) + 1,
                    lapses,
                    next_card.step,
                    _serialize_timestamp(reviewed_at),
                    card_id,
                ),
            )
            log_id = _make_id()
            conn.execute(
                """
                insert into review_logs (
                    id,
                    card_id,
                    user_id,
                    reviewed_at,
                    rating,
                    state_before,
                    state_after,
                    due_before,
                    due_after,
                    elapsed_days,
                    scheduled_days_before,
                    scheduled_days_after,
                    response_ms,
                    answer_mode,
                    was_auto_graded,
                    typed_response,
                    created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    log_id,
                    card_id,
                    self.user_id,
                    _serialize_timestamp(reviewed_at),
                    request.rating,
                    state_before,
                    state_after,
                    due_before,
                    due_after,
                    elapsed_days,
                    int(row["scheduled_days"] or 0),
                    scheduled_days_after,
                    request.responseMs,
                    request.answerMode,
                    bool(request.wasAutoGraded),
                    _normalize_line(request.typedResponse),
                    _serialize_timestamp(reviewed_at),
                ),
            )
            conn.execute(
                "update decks set updated_at = ? where id = ?",
                (_serialize_timestamp(reviewed_at), deck_row["id"]),
            )
            deck_row = self._require_deck(conn, row["deck_id"])
            updated_card_row = self._require_card(conn, card_id)
            summary = self._deck_summary(conn, deck_row, reviewed_at)
            next_row = self._choose_next_card(
                conn,
                deck_id=row["deck_id"],
                now=reviewed_at,
                avoid_note_id=row["note_id"],
                avoid_topic=row["topic"],
            )
            return {
                "reviewLog": {
                    "id": log_id,
                    "cardId": card_id,
                    "reviewedAt": _serialize_timestamp(reviewed_at),
                    "rating": request.rating,
                    "stateBefore": state_before,
                    "stateAfter": state_after,
                    "dueBefore": due_before,
                    "dueAfter": due_after,
                    "responseMs": request.responseMs,
                },
                "reviewedCard": self._serialize_session_card(conn, updated_card_row, reviewed_at),
                "summary": summary,
                "nextCard": self._serialize_session_card(conn, next_row, reviewed_at) if next_row else None,
            }

    def update_card(self, card_id: str, request: CardUpdateRequest) -> dict[str, Any]:
        now = _utc_now()
        with self.connection() as conn:
            row = self._require_card(conn, card_id)
            conn.execute(
                """
                update cards
                set
                    is_suspended = ?,
                    updated_at = ?
                where id = ?
                """,
                (bool(request.isSuspended), _serialize_timestamp(now), card_id),
            )
            updated_row = self._require_card(conn, card_id)
            return {
                "card": {
                    "id": updated_row["id"],
                    "deckId": updated_row["deck_id"],
                    "noteId": updated_row["note_id"],
                    "cardType": updated_row["card_type"],
                    "state": updated_row["state"],
                    "dueAt": updated_row["due_at"],
                    "lastReviewAt": updated_row["last_review_at"],
                    "isSuspended": bool(updated_row["is_suspended"]),
                },
                "deck": self._deck_summary(conn, self._require_deck(conn, updated_row["deck_id"]), now),
            }


def create_vocabulary_router(service: VocabularyStudioService) -> APIRouter:
    router = APIRouter(prefix="/api/vocabulary", tags=["vocabulary"])

    @router.get("/decks")
    def list_decks() -> dict[str, Any]:
        return {"items": service.list_decks()}

    @router.post("/decks")
    def create_deck(request: DeckCreateRequest) -> dict[str, Any]:
        deck = service.create_deck(request)
        return {**deck, "deck": deck}

    @router.get("/decks/{deck_id}")
    def get_deck(deck_id: str) -> dict[str, Any]:
        return service.get_deck_dashboard(deck_id)

    @router.post("/decks/{deck_id}/notes")
    def create_note(deck_id: str, request: NoteCreateRequest) -> dict[str, Any]:
        return service.create_note(deck_id, request)

    @router.patch("/notes/{note_id}/mnemonic")
    def update_note_mnemonic(note_id: str, request: NoteMnemonicUpdateRequest) -> dict[str, Any]:
        return service.update_note_mnemonic(note_id, request)

    @router.post("/decks/{deck_id}/imports/archive")
    def import_archive(deck_id: str, request: ArchiveImportRequest) -> dict[str, Any]:
        return service.import_archive_items(deck_id, request)

    @router.post("/decks/{deck_id}/practice-sessions")
    def create_practice_session(deck_id: str, request: PracticeSessionRequest | None = None) -> dict[str, Any]:
        return service.create_practice_session(deck_id, request)

    @router.get("/decks/{deck_id}/session")
    def get_session(deck_id: str, avoidNoteId: str | None = None, avoidTopic: str | None = None) -> dict[str, Any]:
        return service.get_session(deck_id, avoid_note_id=avoidNoteId, avoid_topic=avoidTopic)

    @router.post("/cards/{card_id}/reviews")
    def submit_review(card_id: str, request: CardReviewRequest) -> dict[str, Any]:
        return service.submit_review(card_id, request)

    @router.post("/cards/{card_id}/lesson")
    def generate_card_lesson(card_id: str, request: CardLessonRequest | None = None) -> dict[str, Any]:
        return service.generate_card_lesson(card_id, request)

    @router.post("/cards/{card_id}/coach")
    def coach_card(card_id: str, request: CardCoachRequest) -> dict[str, Any]:
        return service.coach_card(card_id, request)

    @router.post("/cards/{card_id}/context")
    def generate_card_context(card_id: str, request: CardContextRequest | None = None) -> dict[str, Any]:
        return service.generate_card_context(card_id, request)

    @router.post("/cards/{card_id}/production")
    def submit_card_production(card_id: str, request: CardProductionRequest) -> dict[str, Any]:
        return service.submit_card_production(card_id, request)

    @router.patch("/cards/{card_id}")
    def update_card(card_id: str, request: CardUpdateRequest) -> dict[str, Any]:
        return service.update_card(card_id, request)

    return router
