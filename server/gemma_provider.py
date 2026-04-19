from __future__ import annotations

import json
import os
from typing import Any, Callable

import httpx


DEFAULT_GEMMA_PROVIDER = "ollama"
DEFAULT_GEMMA_BASE_URL = "http://127.0.0.1:11434"
DEFAULT_GEMMA_MODEL = "gemma4:e2b"
DEFAULT_GEMMA_TIMEOUT_SECONDS = 180.0
MAX_DEFINITION_COUNT = 3
MAX_EXAMPLE_COUNT = 3
MAX_DEFINITION_LENGTH = 180
MAX_EXAMPLE_LENGTH = 220
CONTEXT_SYSTEM_PROMPT = (
    "You are an English vocabulary coach. Produce short, grounded practice context for one English word. "
    "Stay close to the supplied meaning and examples. Prefer plain everyday situations over literary analysis. "
    "Do not mention books, novels, chapters, characters, or plot unless those details are explicitly present in the provided grounding. "
    "Return valid JSON only."
)
LESSON_SYSTEM_PROMPT = (
    "You are an English vocabulary coach. Build one short lesson for a single English vocabulary word. "
    "Use only the supplied grounding, stay concrete, and keep the learner active. Return valid JSON only."
)
COACH_SYSTEM_PROMPT = (
    "You are an English vocabulary coach. Evaluate one learner response for a vocabulary word. "
    "Be strict about meaning, brief in feedback, and always give one productive next step. Return valid JSON only."
)
SENTENCE_SYSTEM_PROMPT = (
    "You are an English vocabulary coach. Evaluate three learner-written sentences that use one vocabulary word. "
    "Keep feedback concise, concrete, and encouraging without becoming chatty. Return valid JSON only."
)

ContextGenerator = Callable[[dict[str, Any]], dict[str, Any] | None]
LessonGenerator = Callable[[dict[str, Any]], dict[str, Any] | None]
CoachGenerator = Callable[[dict[str, Any]], dict[str, Any] | None]
SentenceCoachGenerator = Callable[[dict[str, Any]], dict[str, Any] | None]


def env_value(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def gemma_runtime_configured() -> bool:
    return any(
        env_value(name)
        for name in (
            "GEMMA_PROVIDER",
            "GEMMA_BASE_URL",
            "GEMMA_MODEL",
            "GEMMA_TIMEOUT_SECONDS",
        )
    )


def _extract_json_object(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if not text:
        raise ValueError("Gemma returned an empty response.")

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
        raise ValueError("Gemma response was not a JSON object.")
    return parsed


def _coerce_string_list(value: Any, *, max_items: int) -> list[str]:
    if isinstance(value, str):
        normalized = value.strip()
        return [normalized] if normalized else []
    if not isinstance(value, list):
        return []

    items: list[str] = []
    for item in value:
        normalized = str(item).strip()
        if not normalized:
            continue
        items.append(normalized)
        if len(items) >= max_items:
            break
    return items


def _sanitize_text(value: Any, *, max_length: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split()).strip()
    if not normalized:
        return None
    return normalized[:max_length].rstrip()


def _sanitize_text_list(value: Any, *, max_items: int, max_length: int) -> list[str]:
    if not isinstance(value, list):
        return []

    items: list[str] = []
    seen: set[str] = set()
    for item in value:
        normalized = _sanitize_text(item, max_length=max_length)
        if not normalized:
            continue
        key = normalized.casefold()
        if key in seen:
            continue
        seen.add(key)
        items.append(normalized)
        if len(items) >= max_items:
            break
    return items


def _normalize_rating(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized in {"again", "hard", "good", "easy"}:
        return normalized
    return None


def _normalize_verdict(value: Any) -> str:
    if not isinstance(value, str):
        return "incorrect"
    normalized = value.strip().lower()
    if normalized in {"correct", "close", "incorrect"}:
        return normalized
    return "incorrect"


def _sanitize_history_items(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    items: list[dict[str, str]] = []
    for item in value[:6]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        if role not in {"assistant", "learner"}:
            continue
        text = _sanitize_text(item.get("text"), max_length=500)
        step = _sanitize_text(item.get("step"), max_length=40) or "answer"
        if not text:
            continue
        items.append({"role": role, "text": text, "step": step})
    return items


def _build_prompt_payload(grounding: dict[str, Any]) -> dict[str, Any]:
    return {
        "task": "Create one concise English vocabulary context block.",
        "targetWord": _sanitize_text(grounding.get("term"), max_length=80) or "",
        "pronunciation": _sanitize_text(grounding.get("pronunciation"), max_length=80),
        "primaryDefinition": _sanitize_text(grounding.get("definition"), max_length=MAX_DEFINITION_LENGTH) or "",
        "allowedDefinitions": _sanitize_text_list(
            grounding.get("definitions"),
            max_items=MAX_DEFINITION_COUNT,
            max_length=MAX_DEFINITION_LENGTH,
        ),
        "allowedExamples": _sanitize_text_list(
            grounding.get("dictionaryExamples"),
            max_items=MAX_EXAMPLE_COUNT,
            max_length=MAX_EXAMPLE_LENGTH,
        ),
        "notes": _sanitize_text(grounding.get("explanation"), max_length=MAX_EXAMPLE_LENGTH),
        "variationHint": _sanitize_text(grounding.get("variationHint"), max_length=80),
        "rules": [
            "Write only in English.",
            "Use an everyday situation unless the supplied examples clearly require a different setting.",
            "Do not invent book plots, characters, scene analysis, or literary themes unless they appear in the supplied grounding.",
            "Write 2 or 3 short sentences in contextParagraph.",
            "Use the target word naturally 1 or 2 times.",
            "Keep contextParagraph under 70 words.",
            "Return exactly 2 usageFocus bullets.",
            "Return exactly 2 practicePrompts that ask for original learner sentences.",
            "Do not copy any supplied example sentence word-for-word unless absolutely necessary.",
            "Return JSON only with the keys contextTitle, contextParagraph, usageFocus, and practicePrompts.",
        ],
    }


def _build_lesson_prompt_payload(grounding: dict[str, Any]) -> dict[str, Any]:
    return {
        "task": "Create one short English-only lesson plan for a saved vocabulary word.",
        "targetWord": _sanitize_text(grounding.get("term"), max_length=80) or "",
        "pronunciation": _sanitize_text(grounding.get("pronunciation"), max_length=80),
        "primaryDefinition": _sanitize_text(grounding.get("definition"), max_length=MAX_DEFINITION_LENGTH) or "",
        "allowedDefinitions": _sanitize_text_list(
            grounding.get("definitions"),
            max_items=MAX_DEFINITION_COUNT,
            max_length=MAX_DEFINITION_LENGTH,
        ),
        "allowedExamples": _sanitize_text_list(
            grounding.get("dictionaryExamples"),
            max_items=MAX_EXAMPLE_COUNT,
            max_length=MAX_EXAMPLE_LENGTH,
        ),
        "notes": _sanitize_text(grounding.get("explanation"), max_length=MAX_EXAMPLE_LENGTH),
        "variationHint": _sanitize_text(grounding.get("variationHint"), max_length=80),
        "rules": [
            "Write only in English.",
            "Start with a concrete mini-scene that matches the supplied meaning.",
            "Keep contextParagraph under 85 words.",
            "Return exactly 2 usageFocus bullets.",
            "recallPrompt should ask the learner to explain the word in their own words.",
            "usagePrompt should ask for a natural learner sentence, not a copy task.",
            "speakingPrompt should tell the learner to listen, then say the word or sentence aloud.",
            "productionPrompt should require 3 original sentences using the target word.",
            "Return JSON only with the keys contextTitle, contextParagraph, usageFocus, recallPrompt, usagePrompt, speakingPrompt, and productionPrompt.",
        ],
    }


def _build_coach_prompt_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "task": "Evaluate one learner response to an English vocabulary card.",
        "mode": _sanitize_text(payload.get("mode"), max_length=24) or "review",
        "step": _sanitize_text(payload.get("step"), max_length=24) or "answer",
        "turnIndex": int(payload.get("turnIndex") or 1),
        "targetWord": _sanitize_text(payload.get("term"), max_length=80) or "",
        "cue": _sanitize_text(payload.get("cue"), max_length=200),
        "correctAnswer": _sanitize_text(payload.get("correctAnswer"), max_length=MAX_EXAMPLE_LENGTH) or "",
        "primaryDefinition": _sanitize_text(payload.get("definition"), max_length=MAX_DEFINITION_LENGTH),
        "allowedDefinitions": _sanitize_text_list(
            payload.get("definitions"),
            max_items=MAX_DEFINITION_COUNT,
            max_length=MAX_DEFINITION_LENGTH,
        ),
        "allowedExamples": _sanitize_text_list(
            payload.get("dictionaryExamples"),
            max_items=MAX_EXAMPLE_COUNT,
            max_length=MAX_EXAMPLE_LENGTH,
        ),
        "learnerResponse": _sanitize_text(payload.get("learnerResponse"), max_length=600) or "",
        "history": _sanitize_history_items(payload.get("history")),
        "rules": [
            "Write only in English.",
            "Judge whether the learner meaning is correct, close, or incorrect.",
            "Stay grounded in the supplied meaning and examples.",
            "feedbackBody should be 1 or 2 short sentences.",
            "correction should restate the target meaning cleanly.",
            "nextPrompt should ask for one retry or one usage action.",
            "suggestedRating must be one of again, hard, good, easy, or null.",
            "Set canRate to true only when the learner can reasonably move on now.",
            "Return JSON only with the keys verdict, feedbackTitle, feedbackBody, correction, nextPrompt, suggestedRating, and canRate.",
        ],
    }


def _build_sentence_prompt_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "task": "Evaluate three learner-written sentences for one English vocabulary word.",
        "targetWord": _sanitize_text(payload.get("term"), max_length=80) or "",
        "primaryDefinition": _sanitize_text(payload.get("definition"), max_length=MAX_DEFINITION_LENGTH) or "",
        "allowedDefinitions": _sanitize_text_list(
            payload.get("definitions"),
            max_items=MAX_DEFINITION_COUNT,
            max_length=MAX_DEFINITION_LENGTH,
        ),
        "allowedExamples": _sanitize_text_list(
            payload.get("dictionaryExamples"),
            max_items=MAX_EXAMPLE_COUNT,
            max_length=MAX_EXAMPLE_LENGTH,
        ),
        "sentences": _sanitize_text_list(payload.get("sentences"), max_items=3, max_length=320),
        "rules": [
            "Write only in English.",
            "Judge whether each sentence uses the target word naturally and consistently with the supplied meaning.",
            "Do not rewrite the learner sentence completely unless a tiny correction is necessary.",
            "Return exactly 3 sentenceNotes items in order.",
            "Each sentence note must have accepted and note.",
            "accepted should be true only if all three sentences are acceptable.",
            "Return JSON only with the keys accepted, feedback, and sentenceNotes.",
        ],
    }


def _normalize_context_payload(parsed: dict[str, Any], grounding: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": "gemma",
        "term": grounding["term"],
        "pronunciation": grounding["pronunciation"],
        "definition": grounding["definition"],
        "contextTitle": str(parsed.get("contextTitle") or f'{grounding["term"]} in context'),
        "contextParagraph": str(parsed.get("contextParagraph") or ""),
        "usageFocus": _coerce_string_list(parsed.get("usageFocus"), max_items=3),
        "practicePrompts": _coerce_string_list(parsed.get("practicePrompts"), max_items=3),
    }


def _normalize_lesson_payload(parsed: dict[str, Any], grounding: dict[str, Any]) -> dict[str, Any]:
    return {
        "provider": "gemma",
        "term": grounding["term"],
        "pronunciation": grounding["pronunciation"],
        "definition": grounding["definition"],
        "contextTitle": str(parsed.get("contextTitle") or f'{grounding["term"]} in context'),
        "contextParagraph": str(parsed.get("contextParagraph") or ""),
        "usageFocus": _coerce_string_list(parsed.get("usageFocus"), max_items=3),
        "recallPrompt": str(parsed.get("recallPrompt") or ""),
        "usagePrompt": str(parsed.get("usagePrompt") or ""),
        "speakingPrompt": str(parsed.get("speakingPrompt") or ""),
        "productionPrompt": str(parsed.get("productionPrompt") or ""),
    }


def _normalize_coach_payload(parsed: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    turn_index = max(1, min(3, int(payload.get("turnIndex") or 1)))
    return {
        "provider": "gemma",
        "verdict": _normalize_verdict(parsed.get("verdict")),
        "feedbackTitle": str(parsed.get("feedbackTitle") or "Keep going."),
        "feedbackBody": str(parsed.get("feedbackBody") or ""),
        "correction": str(parsed.get("correction") or payload.get("correctAnswer") or ""),
        "nextPrompt": str(parsed.get("nextPrompt") or ""),
        "suggestedRating": _normalize_rating(parsed.get("suggestedRating")),
        "canRate": bool(parsed.get("canRate")),
        "turnCount": turn_index,
    }


def _normalize_sentence_payload(parsed: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    raw_notes = parsed.get("sentenceNotes")
    normalized_notes: list[dict[str, Any]] = []
    sentences = _sanitize_text_list(payload.get("sentences"), max_items=3, max_length=320)
    if isinstance(raw_notes, list):
        for index, item in enumerate(raw_notes[: len(sentences)]):
            if not isinstance(item, dict):
                continue
            normalized_notes.append(
                {
                    "sentence": sentences[index] if index < len(sentences) else "",
                    "accepted": bool(item.get("accepted")),
                    "note": str(item.get("note") or ""),
                }
            )
    for index in range(len(normalized_notes), len(sentences)):
        normalized_notes.append(
            {
                "sentence": sentences[index],
                "accepted": False,
                "note": "",
            }
        )
    return {
        "provider": "gemma",
        "accepted": bool(parsed.get("accepted")),
        "feedback": str(parsed.get("feedback") or ""),
        "sentenceNotes": normalized_notes,
    }


def _call_ollama_json(
    *,
    system_prompt: str,
    prompt_payload: dict[str, Any],
    base_url: str,
    model: str,
    timeout_seconds: float,
    temperature: float,
) -> dict[str, Any] | None:
    response = httpx.post(
        f"{base_url}/api/chat",
        json={
            "model": model,
            "stream": False,
            "format": "json",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(prompt_payload)},
            ],
            "options": {
                "temperature": temperature,
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
    if not raw_content:
        return None
    return _extract_json_object(raw_content)


def _resolve_ollama_runtime(
    *,
    provider: str | None,
    base_url: str | None,
    model: str | None,
    timeout_seconds: float | None,
) -> tuple[str, str, float]:
    provider_name = (provider or env_value("GEMMA_PROVIDER") or DEFAULT_GEMMA_PROVIDER).strip().lower()
    if provider_name != "ollama":
        raise ValueError(f"Unsupported Gemma provider: {provider_name}")

    resolved_base_url = (base_url or env_value("GEMMA_BASE_URL") or DEFAULT_GEMMA_BASE_URL).rstrip("/")
    resolved_model = model or env_value("GEMMA_MODEL") or DEFAULT_GEMMA_MODEL
    resolved_timeout = timeout_seconds
    if resolved_timeout is None:
        raw_timeout = env_value("GEMMA_TIMEOUT_SECONDS")
        resolved_timeout = float(raw_timeout) if raw_timeout else DEFAULT_GEMMA_TIMEOUT_SECONDS
    return resolved_base_url, resolved_model, resolved_timeout


def build_gemma_context_generator(
    *,
    provider: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    timeout_seconds: float | None = None,
) -> ContextGenerator:
    resolved_base_url, resolved_model, resolved_timeout = _resolve_ollama_runtime(
        provider=provider,
        base_url=base_url,
        model=model,
        timeout_seconds=timeout_seconds,
    )

    def generate(grounding: dict[str, Any]) -> dict[str, Any] | None:
        prompt = _build_prompt_payload(grounding)
        parsed = _call_ollama_json(
            system_prompt=CONTEXT_SYSTEM_PROMPT,
            prompt_payload=prompt,
            base_url=resolved_base_url,
            model=resolved_model,
            timeout_seconds=resolved_timeout,
            temperature=0.35,
        )
        if parsed is None:
            return None
        return _normalize_context_payload(parsed, grounding)

    return generate


def build_gemma_lesson_generator(
    *,
    provider: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    timeout_seconds: float | None = None,
) -> LessonGenerator:
    resolved_base_url, resolved_model, resolved_timeout = _resolve_ollama_runtime(
        provider=provider,
        base_url=base_url,
        model=model,
        timeout_seconds=timeout_seconds,
    )

    def generate(grounding: dict[str, Any]) -> dict[str, Any] | None:
        prompt = _build_lesson_prompt_payload(grounding)
        parsed = _call_ollama_json(
            system_prompt=LESSON_SYSTEM_PROMPT,
            prompt_payload=prompt,
            base_url=resolved_base_url,
            model=resolved_model,
            timeout_seconds=resolved_timeout,
            temperature=0.45,
        )
        if parsed is None:
            return None
        return _normalize_lesson_payload(parsed, grounding)

    return generate


def build_gemma_answer_coach(
    *,
    provider: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    timeout_seconds: float | None = None,
) -> CoachGenerator:
    resolved_base_url, resolved_model, resolved_timeout = _resolve_ollama_runtime(
        provider=provider,
        base_url=base_url,
        model=model,
        timeout_seconds=timeout_seconds,
    )

    def generate(payload: dict[str, Any]) -> dict[str, Any] | None:
        prompt = _build_coach_prompt_payload(payload)
        parsed = _call_ollama_json(
            system_prompt=COACH_SYSTEM_PROMPT,
            prompt_payload=prompt,
            base_url=resolved_base_url,
            model=resolved_model,
            timeout_seconds=resolved_timeout,
            temperature=0.3,
        )
        if parsed is None:
            return None
        return _normalize_coach_payload(parsed, payload)

    return generate


def build_gemma_sentence_coach(
    *,
    provider: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    timeout_seconds: float | None = None,
) -> SentenceCoachGenerator:
    resolved_base_url, resolved_model, resolved_timeout = _resolve_ollama_runtime(
        provider=provider,
        base_url=base_url,
        model=model,
        timeout_seconds=timeout_seconds,
    )

    def generate(payload: dict[str, Any]) -> dict[str, Any] | None:
        prompt = _build_sentence_prompt_payload(payload)
        parsed = _call_ollama_json(
            system_prompt=SENTENCE_SYSTEM_PROMPT,
            prompt_payload=prompt,
            base_url=resolved_base_url,
            model=resolved_model,
            timeout_seconds=resolved_timeout,
            temperature=0.25,
        )
        if parsed is None:
            return None
        return _normalize_sentence_payload(parsed, payload)

    return generate
