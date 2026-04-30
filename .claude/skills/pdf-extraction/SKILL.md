---
name: pdf-extraction
description: When working on PDF upload, text extraction, or "mingled words / typos" reports in storybook-reader — use this. Codifies the 3-tier extractor and what NOT to do.
---

# PDF extraction — pipeline cheat sheet

This exists because PDF text extraction is fragile and we keep getting "garbled / mingled words" reports from real user files.

## The pipeline (in `pdf_to_audio.py`)

```
extract_pdf_text(path)
  → tier 1: _extract_pdf_text_pymupdf   (PyMuPDF, primary — best Unicode + ligatures)
  → tier 2: _extract_pdf_text_pdfplumber (slower, better for column-heavy layouts)
  → tier 3: _extract_pdf_text_pypdf      (fallback — was the historical primary)
```

Each tier is wrapped in try/except. The orchestrator:

1. Runs tier 1. If `_looks_extracted_correctly(text)` returns True → return.
2. Otherwise runs tier 2. If "looks correct" → return.
3. Otherwise runs tier 3.
4. From the candidates that returned non-empty text, returns the one with the highest space-density (proxy for "real words separated by spaces", since the failure mode is `WordsAllSmushedTogether`).

## `_looks_extracted_correctly` heuristic

True when:
- text length > 200 chars
- < 8% of tokens are longer than 18 chars (catches the mingled-word failure)
- space-density > 10% (catches the "no whitespace at all" failure)

If you change these thresholds, do it for a real failing file and re-test all known-good files — it's a cliff function.

## What NOT to do

- **Don't make pypdf the primary again.** It's the historical default and is the source of the mingled-words bug for several books in the user's library.
- **Don't add OCR (tesseract / paddleocr / etc.) directly to `requirements.txt`.** Their wheels are huge — Vercel's 245 MB Lambda budget is already tight after PyMuPDF + pdfplumber. If OCR is needed, call out to a hosted API (Google Document AI, AWS Textract, Mathpix) — see "OCR strategy" below.
- **Don't re-extract existing books on deploy.** The user explicitly said "no don't reextract those four files" on 2026-04-29. Existing books keep their (possibly bad) extraction unless the user explicitly triggers a reextract action.
- **Don't change `extract_cleaned_book_source`'s caching by sha256** — it's what makes re-uploads of the same file instant.

## How to verify a fix

Smallest end-to-end test:

```bash
cd C:/Users/miroa/storybook-reader
uvicorn server.app:app --host 127.0.0.1 --port 8000 --reload
# Then upload the failing PDF via the UI at http://localhost:5175
# Check library/<bookId>/source.txt for the extracted text — readable words, real spaces
```

For an offline check on a specific PDF without going through the API:

```python
from pathlib import Path
from pdf_to_audio import extract_pdf_text
print(extract_pdf_text(Path("path/to/book.pdf"))[:2000])
```

## Vercel-size discipline

Current `requirements.txt` already includes `pymupdf` and `pdfplumber`. Before adding ANY new Python dep, check:

```bash
pip install <new-dep> --target /tmp/sizecheck && du -sh /tmp/sizecheck
```

The combined deploy is in the 200–245 MB range. A 50 MB dep will fail Vercel deploy. If you must add one, look at:
- Whether it can be a hosted API call instead.
- Whether `pypdf` (small) can be removed — but only after confirming nothing in the codebase references it directly.

## OCR strategy (if user asks for scanned PDF support)

Don't add a local OCR engine. Two viable paths:

1. **Hosted OCR via API** (preferred): Mathpix for math+text, Google Document AI for general, AWS Textract if user already has AWS creds. Add an env-gated branch in `extract_pdf_text` that falls through to the API only when all three local tiers return text that fails `_looks_extracted_correctly`.
2. **Side-loaded OCR worker**: deploy a separate Fly machine running tesseract; call it from `extract_pdf_text` with a 30-s timeout and a skip-on-fail.

Either way, gate behind a feature flag — don't change extraction behavior silently.

## Where this fits in the ingestion pipeline

```
upload (POST /api/books/import) 
  → import_book_source(...)
    → extract_cleaned_book_source(...)      # sha256-keyed cache, returns existing if present
      → extract_pdf_text(...)               # the 3-tier extractor (this skill's subject)
      → ... cleanup, dictionary lookups ...
    → save serialized book meta
    → kickoff_auto_presynth(book_id)        # see seamless-tts skill
```

Touching extraction without preserving the sha256 short-circuit means re-running on every upload of a book the user already has — wasteful and slow.
