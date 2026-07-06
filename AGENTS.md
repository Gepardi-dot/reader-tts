# Repository Guidelines

## Project Directive

ReaderTTS is a new production project, separate from KU Online, KU Online Staging, and Kubazar. Shared accounts do not imply shared infrastructure, data, domains, deployment targets, or assumptions.

Treat every change as production work that may be reviewed, shipped, maintained, and depended on. The job is not to make something appear to work; it is to understand the real system, implement the correct solution, verify it properly, and leave the codebase healthier.

## End Goal

The product goal is a highly responsive PDF reader with near-instant, smooth TTS. Tapping text should produce immediate audible feedback, and Kokoro/Gemini playback should continue without stalls during normal reading.

## Platform Policy

Treat the project as greenfield when making architecture decisions. Existing code, Vercel configuration, Supabase-era data, and old backend/TTS paths are not constraints unless they demonstrably serve the end goal. If a platform, tool, service, or implementation causes slowness, fragility, cost, or maintenance drag, recommend replacing it.

Current direction is Cloudflare-first: Pages for the frontend, Workers for the API, D1 for relational data, and R2 for durable audio/blob caching once enabled. Prefer free or generous free-tier services, but do not trade away responsiveness or correctness without calling out the cost.

## Production Rules

- Understand the real code path before editing.
- Keep changes scoped, explicit, and compatible with the current deployment target.
- Preserve the design and useful features unless there is a measured reason to change them.
- Prefer tested helpers and small controller extractions over broad rewrites.
- Verify with lint, tests, build, deployment, and browser/API smoke checks when relevant.
- For GitHub work, use named PRs, wait for checks, merge them, and report the PR number and merge commit.

## Current Priority

Continue improving TTS responsiveness and playback smoothness. Browser speech remains the instant default and emergency fallback, but selected Kokoro/Gemini voices should not be masked by browser speech during normal playback. Kokoro is the preferred free high-quality path after warmup, and Gemini is the optional cloud-quality path that must be cached aggressively.
