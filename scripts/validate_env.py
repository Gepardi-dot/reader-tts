#!/usr/bin/env python3
"""
Storybook Reader — environment validation script.

Run this before starting the server or deploying to catch missing or
misconfigured environment variables early.

Usage:
    python scripts/validate_env.py
    python scripts/validate_env.py --strict   # exit 1 if any warning
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Bootstrap: load .env from the project root
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[1]
env_file = ROOT / ".env"

try:
    from dotenv import load_dotenv
    load_dotenv(env_file)
except ImportError:
    # dotenv not installed — read it manually for basic key=value lines
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
PASS  = "\033[32m✔\033[0m"
WARN  = "\033[33m⚠\033[0m"
FAIL  = "\033[31m✘\033[0m"
INFO  = "\033[36mℹ\033[0m"

warnings: list[str] = []
errors: list[str] = []

def ok(msg: str) -> None:
    print(f"  {PASS}  {msg}")

def warn(msg: str) -> None:
    warnings.append(msg)
    print(f"  {WARN}  {msg}")

def fail(msg: str) -> None:
    errors.append(msg)
    print(f"  {FAIL}  {msg}")

def info(msg: str) -> None:
    print(f"  {INFO}  {msg}")

def env(name: str) -> str | None:
    v = os.environ.get(name, "").strip()
    return v or None


# ---------------------------------------------------------------------------
# Check sections
# ---------------------------------------------------------------------------
def check_tts_providers() -> None:
    print("\n── TTS Providers ─────────────────────────────────────────")
    any_provider = False

    gemini_key = env("GEMINI_API_KEY")
    if gemini_key and gemini_key != "replace-with-a-rotated-key":
        ok(f"Gemini TTS: key present (model: {env('GEMINI_TTS_MODEL') or 'default'})")
        any_provider = True
    else:
        warn("Gemini TTS: GEMINI_API_KEY not set (or still placeholder)")

    dashscope_key = env("DASHSCOPE_API_KEY")
    if dashscope_key:
        ok(f"Qwen TTS: key present (model: {env('QWEN_TTS_MODEL') or 'default'})")
        any_provider = True
    else:
        info("Qwen TTS: DASHSCOPE_API_KEY not set (optional)")

    openai_key = env("OPENAI_API_KEY")
    if openai_key:
        ok(f"OpenAI TTS: key present (model: {env('OPENAI_TTS_MODEL') or 'default'})")
        any_provider = True
    else:
        info("OpenAI TTS: OPENAI_API_KEY not set (optional)")

    polly_region = env("POLLY_REGION") or env("AWS_REGION") or env("AWS_DEFAULT_REGION")
    polly_key = env("AWS_ACCESS_KEY_ID")
    polly_profile = env("AWS_PROFILE")
    if polly_region and (polly_key or polly_profile):
        cred_source = f"key={polly_key[:8]}…" if polly_key else f"profile={polly_profile}"
        ok(f"Amazon Polly: region={polly_region}, {cred_source}")
        any_provider = True
    elif polly_region:
        warn("Amazon Polly: region set but no credentials (AWS_ACCESS_KEY_ID or AWS_PROFILE)")
    else:
        info("Amazon Polly: not configured (optional)")

    piper_exe = env("PIPER_EXE")
    if piper_exe:
        piper_path = Path(piper_exe)
        if piper_path.exists():
            ok(f"Piper TTS: executable found at {piper_exe}")
            any_provider = True
        else:
            warn(f"Piper TTS: PIPER_EXE is set but file not found: {piper_exe}")
    else:
        info("Piper TTS: PIPER_EXE not set (optional)")

    if not any_provider:
        fail("No TTS providers are configured — the app will not be able to narrate books")


def check_database() -> None:
    print("\n── Database / Progress Sync ──────────────────────────────")
    db_url = env("SUPABASE_POOLER_URL") or env("SUPABASE_DB_URL") or env("DATABASE_URL")
    anon_key = env("SUPABASE_ANON_KEY")
    supabase_url = env("SUPABASE_URL")

    if db_url:
        # Mask password in display
        safe_url = db_url
        if "@" in db_url:
            prefix, _, rest = db_url.partition("://")
            userpass, _, hostpath = rest.partition("@")
            if ":" in userpass:
                user, _, _ = userpass.partition(":")
                safe_url = f"{prefix}://{user}:***@{hostpath}"
        ok(f"DB URL: {safe_url}")

        try:
            import psycopg  # noqa: F401
            ok("psycopg: installed")
        except ImportError:
            fail("psycopg: NOT installed — run: pip install -r requirements.txt")

    else:
        warn("SUPABASE_POOLER_URL / SUPABASE_DB_URL: not set — reading progress will not sync across devices")

    if supabase_url and anon_key:
        ok(f"Supabase project URL: {supabase_url}")
    else:
        info("SUPABASE_URL / SUPABASE_ANON_KEY: not set (needed for future auth/storage features)")


def check_storage() -> None:
    print("\n── Book Storage (S3) ────────────────────────────────────")
    bucket = env("BOOK_STORAGE_BUCKET")
    region = env("BOOK_STORAGE_REGION") or env("AWS_REGION")

    if bucket:
        ok(f"S3 bucket: {bucket} (region: {region or 'not set — check BOOK_STORAGE_REGION'})")
        if not region:
            warn("BOOK_STORAGE_REGION not set — bucket region may default incorrectly")
    else:
        info("BOOK_STORAGE_BUCKET: not set — books will be stored locally in library/")


def check_deployment() -> None:
    print("\n── Deployment ───────────────────────────────────────────")
    vercel = os.environ.get("VERCEL")
    if vercel:
        ok("Running on Vercel")
    else:
        info("VERCEL env not set — assuming local development mode")


def check_env_file() -> None:
    print("\n── .env File ────────────────────────────────────────────")
    if env_file.exists():
        ok(f".env found at {env_file}")
    else:
        warn(f".env not found at {env_file} — copy .env.example and fill in your keys")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    strict = "--strict" in sys.argv
    print("Storybook Reader — Environment Validation")
    print("=" * 50)

    check_env_file()
    check_tts_providers()
    check_database()
    check_storage()
    check_deployment()

    print("\n── Summary ──────────────────────────────────────────────")
    if errors:
        print(f"  {FAIL}  {len(errors)} error(s):")
        for e in errors:
            print(f"       • {e}")
    if warnings:
        print(f"  {WARN}  {len(warnings)} warning(s):")
        for w in warnings:
            print(f"       • {w}")
    if not errors and not warnings:
        print(f"  {PASS}  All checks passed.")

    if errors:
        return 1
    if strict and warnings:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
