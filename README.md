# Storybook Reader

Personal PDF-to-audiobook app for desktop and mobile browsers.

## What it does

- Uploads PDF books through a local web UI
- Shows a realistic two-page reading desk preview
- Generates audiobook audio as `mp3`, `m4b`, or `wav`
- Uses local Piper voices for the fully free path
- Supports self-hosted Qwen3-TTS through a separate local Python runtime
- Supports local NeuTTS voice cloning through a WSL2 sidecar runtime and reference packs
- Supports Google Gemini TTS for a generous cloud free tier
- Supports hosted Qwen TTS through DashScope
- Supports Amazon Polly through your normal AWS CLI or AWS profile credentials
- Supports optional OpenAI narration for another premium cloud option
- Lets you test the selected provider and voice before generating a full book

## Project layout

- `server/app.py`: FastAPI backend and job runner
- `web/`: React + Vite frontend
- `pdf_to_audio.py`: original CLI conversion pipeline
- `voices/`: local Piper `.onnx` voice models
- `voices/neutts/`: local NeuTTS reference packs (`reference.wav`, `reference.txt`, optional `reference.pt`)
- `library/`: uploaded books and generated metadata
- `output/`: generated audio from the CLI workflow

## Setup

### Backend

```powershell
cd C:\Users\miroa\storybook-reader
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### Frontend

```powershell
cd C:\Users\miroa\storybook-reader\web
npm install
```

## Provider setup

The backend automatically loads `C:\Users\miroa\storybook-reader\.env` on startup, so you can keep provider keys out of your terminal history.

### Piper local

Place a Piper voice model and its matching JSON config in:

`C:\Users\miroa\storybook-reader\voices`

Example:

- `en_US-lessac-medium.onnx`
- `en_US-lessac-medium.onnx.json`

If `piper.exe` is not in the default location, set:

```powershell
$env:PIPER_EXE="C:\path\to\piper.exe"
$env:PIPER_ESPEAK_DATA="C:\path\to\espeak-ng-data"
```

### Google Gemini TTS

Rotate any previously exposed key first, then set a fresh key:

```powershell
$env:GEMINI_API_KEY="your-new-key"
```

Optional:

```powershell
$env:GEMINI_TTS_MODEL="gemini-2.5-flash-preview-tts"
```

### Hosted Qwen TTS

```powershell
$env:DASHSCOPE_API_KEY="your-key-here"
```

Optional:

```powershell
$env:QWEN_TTS_MODEL="qwen3-tts-instruct-flash"
```

### Local Qwen3-TTS

The `qwen_local` provider runs Qwen3-TTS on your machine through a separate Python environment. This keeps the main API environment light while avoiding per-chunk hosted API calls.

Create a dedicated runtime first:

```powershell
conda create -n qwen3-tts python=3.12 -y
conda activate qwen3-tts
pip install -U qwen-tts
```

Optional, but recommended on compatible CUDA hardware:

```powershell
pip install -U flash-attn --no-build-isolation
```

Then point the backend at that runtime in `C:\Users\miroa\storybook-reader\.env`:

```text
QWEN_LOCAL_PYTHON=C:\path\to\miniconda3\envs\qwen3-tts\python.exe
QWEN_LOCAL_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
QWEN_LOCAL_DEVICE=cuda:0
QWEN_LOCAL_DTYPE=auto
QWEN_LOCAL_ATTN_IMPLEMENTATION=
QWEN_LOCAL_BATCH_SIZE=6
QWEN_LOCAL_TIMEOUT_SECONDS=3600
QWEN_LOCAL_SOX_DIR=C:\Users\miroa\AppData\Local\Microsoft\WinGet\Packages\ChrisBagwell.SoX_Microsoft.Winget.Source_8wekyb3d8bbwe\sox-14.4.2
```

Notes:

- The first local run can take a while because model weights may download and warm up.
- `QWEN_LOCAL_BATCH_SIZE=6` is the default compromise between throughput and VRAM pressure.
- For CPU-only runs, set `QWEN_LOCAL_DEVICE=cpu` and typically `QWEN_LOCAL_DTYPE=float32`.
- If `sox` is not already on PATH in the shell that starts the API, set `QWEN_LOCAL_SOX_DIR` explicitly.
- The initial integration is optimized for provider tests and full-book generation. Live per-page playback still uses the hosted providers.

### Local NeuTTS

The `neutts_local` provider runs NeuTTS inside WSL2 Ubuntu and uses local reference packs for instant voice cloning. This is the practical path on this laptop: CPU-only inference with pre-encoded references, not local finetuning.

Install the WSL runtime first:

```powershell
cd C:\Users\miroa\storybook-reader
powershell -ExecutionPolicy Bypass -File .\scripts\setup_neutts_wsl.ps1
```

That wrapper runs `scripts/setup_neutts_wsl.sh` in your `Ubuntu` WSL distro and prints the Linux Python path it created. Then point the backend at that runtime in `C:\Users\miroa\storybook-reader\.env`:

```text
NEUTTS_WSL_DISTRO=Ubuntu
NEUTTS_WSL_USER=
NEUTTS_WSL_PYTHON=/home/<your-linux-user>/.venvs/neutts/bin/python
NEUTTS_WSL_HF_HOME=/home/<your-linux-user>/.cache/huggingface/neutts
NEUTTS_LOCAL_MODEL=neuphonic/neutts-nano-q4-gguf
NEUTTS_LOCAL_CODEC=neuphonic/neucodec-onnx-decoder
NEUTTS_LOCAL_TIMEOUT_SECONDS=3600
```

If the distro only starts reliably as `root`, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup_neutts_wsl.ps1 -User root -VenvPath /root/.venvs/neutts
```

and set:

```text
NEUTTS_WSL_USER=root
NEUTTS_WSL_PYTHON=/root/.venvs/neutts/bin/python
NEUTTS_WSL_HF_HOME=/root/.cache/huggingface/neutts
```

Create a voice pack under `C:\Users\miroa\storybook-reader\voices\neutts\<voice_id>` with:

- `reference.wav`
- `reference.txt`
- optional `meta.json`
- optional `reference.pt` after pre-encoding

Recommended reference audio:

- mono or close to mono
- 3 to 15 seconds
- clean speech with minimal background noise
- same language as the NeuTTS backbone you plan to use

To build a pack and pre-encode `reference.pt` in one step:

```powershell
cd C:\Users\miroa\storybook-reader
python .\scripts\prepare_neutts_reference.py `
  --voice-id demo-voice `
  --reference-audio C:\path\to\sample.wav `
  --reference-text C:\path\to\sample.txt `
  --wsl-python /home/<your-linux-user>/.venvs/neutts/bin/python `
  --label "Demo Voice" `
  --style "Warm"
```

If WSL is temporarily unavailable and you just want to stage the pack files, add `--skip-encode`. That creates `reference.wav`, `reference.txt`, and `meta.json` without building `reference.pt` yet.

Notes:

- The default model for this laptop is `neuphonic/neutts-nano-q4-gguf`. `neuphonic/neutts-air-q4-gguf` is available as a slower quality profile.
- NeuTTS chunk sizes are intentionally much smaller than the other providers because the model context is tighter.
- The first run is slower while WSL, Hugging Face downloads, and the model cache warm up.
- Live per-page playback still stays on the hosted providers. NeuTTS is wired for provider tests and full-book generation.
- More detail lives in [docs/neutts-local.md](docs/neutts-local.md).

### OpenAI

```powershell
$env:OPENAI_API_KEY="your-key-here"
```

Optional:

```powershell
$env:OPENAI_TTS_MODEL="gpt-4o-mini-tts"
```

### Local Gemma vocabulary context

Phase 1 Gemma support is server-side only and currently targets Vocabulary Studio context generation, not TTS.

Set the vocabulary provider mode:

```powershell
$env:VOCAB_CONTEXT_PROVIDER="gemma"
```

Optional Gemma runtime settings:

```powershell
$env:GEMMA_PROVIDER="ollama"
$env:GEMMA_BASE_URL="http://127.0.0.1:11434"
$env:GEMMA_MODEL="gemma4:e2b"
$env:GEMMA_TIMEOUT_SECONDS="180"
```

Provider behavior:

- `VOCAB_CONTEXT_PROVIDER=gemma` forces the local Gemma path
- `VOCAB_CONTEXT_PROVIDER=openai` uses the existing OpenAI context path
- `VOCAB_CONTEXT_PROVIDER=auto` tries Gemma first only when Gemma env vars are configured, then falls back to OpenAI
- `VOCAB_CONTEXT_PROVIDER=off` disables AI context generation and keeps the dictionary-grounded fallback only

Practical note for this repo:

- `gemma4:latest` may be too large for 16 GB machines depending on current free RAM.
- `gemma4:e2b` is the safer default for local Vocabulary Studio work and is the model currently used by the backend when `GEMMA_MODEL` is not set.
- A 180 second timeout is the safer default for the full vocabulary-context prompt on local Windows machines.

### Optional Gemma cleanup for `pdf_to_audio.py`

Phase 2 Gemma work starts in the original CLI pipeline and is optional. The default regex cleaner is still the safe baseline.

Use the local cleanup pass only when you want Gemma to repair extraction artifacts before Piper chunking:

```powershell
python pdf_to_audio.py book.pdf --gemma-cleanup
```

Optional cleanup-specific overrides:

```powershell
$env:GEMMA_CLEANUP_BASE_URL="http://127.0.0.1:11434"
$env:GEMMA_CLEANUP_MODEL="gemma4:e2b"
$env:GEMMA_CLEANUP_TIMEOUT_SECONDS="60"
$env:GEMMA_CLEANUP_CACHE_DIR="$HOME\\piper-audiobooks\\cleanup-cache"
python pdf_to_audio.py book.pdf --gemma-cleanup
```

Behavior:

- Gemma cleanup is chunked and runs before text-to-speech chunking.
- The CLI now applies a cheap structural heuristic first and only sends noisy chunks to Gemma; cleaner chunks stay on the local regex path.
- Successful cleanup output is cached persistently by chunk so repeated CLI runs reuse prior Gemma work instead of paying the same cleanup cost again.
- Each cleanup chunk falls back to the existing regex cleaner if the local model is unavailable or returns unusable output.
- Cleanup output is validated before it is accepted; if the model drops too much text or otherwise looks unsafe, that chunk falls back to regex cleanup.
- The cleanup prompt is intended to preserve wording, chapter headings, paragraph breaks, and dialogue while removing headers, footers, page numbers, and broken extraction artifacts.
- On this machine, real book-extraction cleanup is still experimental and may fall back frequently; the shorter default timeout is meant to fail fast instead of hanging the CLI for many minutes.
- The current default cleanup chunk size is intentionally small (`700` characters) because larger chunks timed out reliably on this hardware.

### Amazon Polly

Recommended setup: authenticate once with the AWS CLI, then let the backend use the same credential chain.

If you already have a working AWS CLI profile, you only need this in `C:\Users\miroa\storybook-reader\.env`:

```text
AWS_PROFILE=default
AWS_REGION=us-east-1
AWS_POLLY_VOICE_ID=Matthew
AWS_POLLY_ENGINE=standard
AWS_POLLY_LANGUAGE_CODE=en-US
```

If you prefer raw environment credentials instead, these are also supported:

```text
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_SESSION_TOKEN=
```

The backend discovers Polly voices dynamically from your account and selected region, so the voice list in the app should match what your current AWS setup can actually use.

## Run the app

Start the API:

```powershell
cd C:\Users\miroa\storybook-reader
.\start-api.ps1
```

Start the frontend:

```powershell
cd C:\Users\miroa\storybook-reader
.\start-web.ps1
```

Open:

- `http://localhost:5173` on your PC
- `http://<your-pc-lan-ip>:5173` on your phone while both devices are on the same network

## Production-style local build

Build the frontend:

```powershell
cd C:\Users\miroa\storybook-reader\web
npm run build
```

Then start only the API:

```powershell
cd C:\Users\miroa\storybook-reader
.\start-api.ps1
```

When `web/dist` exists, the FastAPI server will serve the built frontend too.

## Hosted uploads on Vercel

The Vercel-hosted site cannot safely store uploaded books on the function filesystem, and large PDFs exceed the request-body limit for hosted functions. For production uploads, configure durable S3 storage and let the browser upload PDFs there directly.

Required environment variables:

```text
BOOK_STORAGE_BUCKET=your-s3-bucket
BOOK_STORAGE_PREFIX=storybook-reader
BOOK_STORAGE_REGION=us-east-1
```

The same AWS credential chain used for Polly can be reused here, but it also needs S3 permissions for the configured bucket.

Minimum S3 bucket CORS for direct browser uploads:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["POST"],
    "AllowedOrigins": ["https://your-app.vercel.app"]
  }
]
```

On hosted deployments, the web app will automatically switch to the direct-to-storage upload flow.

## CLI converter

```powershell
cd C:\Users\miroa\storybook-reader
.\convert-book.ps1 "C:\path\to\book.pdf"
```

## Notes

- Text-based PDFs work immediately. Scanned PDFs need OCR before upload.
- Google and OpenAI use the narration prompt directly for more expressive delivery.
- Gemma phase 1 currently generates local vocabulary context only. It does not synthesize speech.
- Piper ignores narration instructions and reads the cleaned text directly.
- Polly uses SSML-based rate and pause control, but not free-form narration prompting.
- Polly voices are loaded from AWS at runtime using your current CLI/profile credentials.
- The default Polly engine is `standard` for better region compatibility. Switch to `neural` only if your selected AWS region exposes the voices you want.
- Gemini TTS is still a preview model, so expect occasional voice or style inconsistencies.
- Use the `Test current voice` button in the UI to verify your key, voice, and narration settings before a full run.
