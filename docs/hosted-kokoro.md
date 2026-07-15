# Hosted Kokoro TTS

Kokoro playback uses the **same live-audio path as Gemini**: short chunks, edge Cache API + R2 durable cache, sequential read-ahead. Synthesis runs on a dedicated FastAPI server (`scripts/kokoro_server.py`), not in the browser.

## Architecture

```
Reader → Worker POST /api/books/:id/live-audio (provider=kokoro)
       → edge cache / R2 hit? return WAV
       → else POST {KOKORO_REMOTE_URL}/v1/synthesize
       → cache WAV → client BufferPool → AudioClock
```

## Deploy Kokoro server (Fly.io)

```bash
# From repo root
fly launch --dockerfile Dockerfile.kokoro --name kokoro-reader --no-deploy --copy-config
# or use existing fly.kokoro.toml
fly volumes create kokoro_data --size 5 --region ams
fly secrets set KOKORO_API_KEY="$(openssl rand -hex 32)"
fly deploy --config fly.kokoro.toml
fly info   # note the URL
```

## Configure Cloudflare Worker

```bash
# Secrets (production)
cd cloudflare/worker
npx wrangler secret put KOKORO_REMOTE_URL
# paste: https://kokoro-reader.fly.dev

npx wrangler secret put KOKORO_REMOTE_API_KEY
# paste: same value as KOKORO_API_KEY on Fly

npx wrangler deploy
```

## Local development

### 1. Run Kokoro server

```powershell
# Option A: Docker
docker build -f Dockerfile.kokoro -t kokoro-tts .
docker run --rm -p 8767:8767 -e KOKORO_API_KEY=dev-local -e KOKORO_CACHE_DIR=/tmp/kokoro -e HF_HOME=/tmp/hf kokoro-tts

# Option B: Python (first run downloads ~330 MB model)
pip install kokoro-onnx numpy fastapi "uvicorn[standard]" pydantic
$env:KOKORO_API_KEY="dev-local"
$env:KOKORO_CACHE_DIR="$env:TEMP\kokoro-cache"
$env:HF_HOME="$env:TEMP\hf-kokoro"
python scripts/kokoro_server.py
```

Health: http://127.0.0.1:8767/v1/health

### 2. Point the Worker at it

Add to `cloudflare/worker/.dev.vars` (gitignored):

```
KOKORO_REMOTE_URL=http://127.0.0.1:8767
KOKORO_REMOTE_API_KEY=dev-local
GEMINI_API_KEY=...
```

Restart:

```powershell
npm run worker:dev
npm run dev   # web-next on :5175
```

### 3. Confirm

```powershell
# After login session cookie/token as usual
Invoke-RestMethod http://127.0.0.1:8787/api/providers
# kokoro.available should be true
```

## Client behavior

- Provider id remains `kokoro` (catalog label: **Kokoro (hosted)**).
- Playback uses `BufferPool` + `live-audio` (identical mechanics to Gemini).
- On-device ONNX engine is no longer the primary path.

## Chunk sizing

See `audioPlayback.ts`: first ~120 chars, follow ~260, prefetch ahead 2.
