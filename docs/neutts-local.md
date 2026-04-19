# NeuTTS Local Setup

This repo integrates NeuTTS as a `neutts_local` provider that runs inside WSL2 Ubuntu and is called from the Windows FastAPI backend.

## Why this shape

- Native Windows CPU support has been less reliable than WSL2 for recent NeuTTS users.
- This laptop is a CPU-only 16 GB machine, so the right target is local inference plus voice cloning, not local finetuning.
- The backend already uses sidecar runtimes for local TTS, so WSL fits the existing architecture.

## Runtime install

From Windows PowerShell:

```powershell
cd C:\Users\miroa\storybook-reader
powershell -ExecutionPolicy Bypass -File .\scripts\setup_neutts_wsl.ps1
```

That script:

- installs Ubuntu packages needed by `neutts`
- creates a Linux venv at `~/.venvs/neutts` by default
- installs `neutts[onnx]==1.2.0`
- rebuilds `llama-cpp-python` with OpenBLAS for CPU use

## Backend env

Set these in `C:\Users\miroa\storybook-reader\.env`:

```text
NEUTTS_WSL_DISTRO=Ubuntu
NEUTTS_WSL_USER=
NEUTTS_WSL_PYTHON=/home/<your-linux-user>/.venvs/neutts/bin/python
NEUTTS_WSL_HF_HOME=/home/<your-linux-user>/.cache/huggingface/neutts
NEUTTS_LOCAL_MODEL=neuphonic/neutts-nano-q4-gguf
NEUTTS_LOCAL_CODEC=neuphonic/neucodec-onnx-decoder
NEUTTS_LOCAL_TIMEOUT_SECONDS=3600
```

Recommended defaults for this laptop:

- model: `neuphonic/neutts-nano-q4-gguf`
- codec: `neuphonic/neucodec-onnx-decoder`
- timeout: keep `3600` unless the runtime proves stable enough to lower it

If the distro only starts as `root`, install with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup_neutts_wsl.ps1 -User root -VenvPath /root/.venvs/neutts
```

and set:

```text
NEUTTS_WSL_USER=root
NEUTTS_WSL_PYTHON=/root/.venvs/neutts/bin/python
NEUTTS_WSL_HF_HOME=/root/.cache/huggingface/neutts
```

## Reference packs

Each local voice is a folder under `voices/neutts/<voice_id>` with:

- `reference.wav`
- `reference.txt`
- optional `meta.json`
- optional `reference.pt`

Minimal `meta.json` example:

```json
{
  "label": "Warm Narrator",
  "gender": "female",
  "genderSource": "estimated",
  "style": "Warm",
  "tags": ["Story"]
}
```

Recommended reference clip:

- 3 to 15 seconds
- clean speech
- no music bed
- one speaker only
- transcript that matches the audio exactly

## Preparing a voice pack

The helper below creates the folder and pre-encodes `reference.pt` through WSL:

```powershell
cd C:\Users\miroa\storybook-reader
python .\scripts\prepare_neutts_reference.py `
  --voice-id warm-narrator `
  --reference-audio C:\path\to\sample.wav `
  --reference-text C:\path\to\sample.txt `
  --wsl-python /home/<your-linux-user>/.venvs/neutts/bin/python `
  --label "Warm Narrator" `
  --style "Warm" `
  --tag Story
```

If you overwrite the pack, rerun with `--force` so the stale `reference.pt` is discarded and rebuilt.

If WSL is down and you only want to stage the files, add `--skip-encode`. You can build `reference.pt` later once the Linux runtime is back.

## Current behavior in the app

- `neutts_local` appears in `/api/providers` only when the WSL runtime is configured and at least one complete reference pack exists.
- Provider test and full-book generation are supported.
- Live per-page playback is intentionally not wired to NeuTTS.
- Chunk sizing is clamped to a much smaller range than the hosted providers because NeuTTS has a tighter effective context window.

## Practical limits

- `neutts-air-q4-gguf` is available, but it is slower on this hardware.
- First-run latency is dominated by model download and cold start.
- Finetuning is not part of this local path. If you want true custom training, do dataset prep here and train on a Linux GPU machine separately.
