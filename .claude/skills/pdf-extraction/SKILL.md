---
name: pdf-extraction
description: Invariants and footguns for PDF text extraction in storybook-reader. Read before touching pdf_to_audio.py.
---

# PDF extraction — invariants only

## Pipeline
3-tier in `pdf_to_audio.py`: PyMuPDF → pdfplumber → pypdf. Orchestrator picks the candidate with highest space-density when none pass `_looks_extracted_correctly`.

`_looks_extracted_correctly` thresholds: len > 200, < 8% tokens longer than 18 chars, > 10% space density. Cliff function — changing a threshold requires testing against all known-good files before shipping.

## Invariants

**Never re-extract existing books** without an explicit user action. User said so 2026-04-29.

**Don't make pypdf the primary tier.** It's the historical source of mingled-word bugs for several books already in the user's library.

**Don't add OCR wheels to `requirements.txt`.** Vercel 245 MB Lambda budget is already tight after PyMuPDF + pdfplumber. If OCR is ever needed: hosted API only (Google Document AI, AWS Textract, Mathpix), gated behind a feature flag, only when all three local tiers fail `_looks_extracted_correctly`.

**sha256 cache in `extract_cleaned_book_source`** makes re-uploads of the same file instant. Don't change or bypass it.

## Vercel size discipline
Before adding any Python dep:
```bash
pip install <new-dep> --target /tmp/sizecheck && du -sh /tmp/sizecheck
```
~40–45 MB headroom remaining. A 50 MB dep will fail Vercel deploy.

## Quick offline test
```bash
python -c "from pathlib import Path; from pdf_to_audio import extract_pdf_text; print(extract_pdf_text(Path('path/to/book.pdf'))[:2000])"
```
