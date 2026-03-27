# Storybook Reader

Personal PDF-to-audiobook app for desktop and mobile browsers.

## What it does

- Uploads PDF books through a local web UI
- Shows a realistic two-page reading desk preview
- Generates audiobook audio as `mp3`, `m4b`, or `wav`
- Uses local Piper voices for the fully free path
- Supports Google Gemini TTS for a generous cloud free tier
- Supports Amazon Polly through your normal AWS CLI or AWS profile credentials
- Supports optional OpenAI narration for another premium cloud option
- Lets you test the selected provider and voice before generating a full book

## Project layout

- `server/app.py`: FastAPI backend and job runner
- `web/`: React + Vite frontend
- `pdf_to_audio.py`: original CLI conversion pipeline
- `voices/`: local Piper `.onnx` voice models
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

### OpenAI

```powershell
$env:OPENAI_API_KEY="your-key-here"
```

Optional:

```powershell
$env:OPENAI_TTS_MODEL="gpt-4o-mini-tts"
```

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
- Piper ignores narration instructions and reads the cleaned text directly.
- Polly uses SSML-based rate and pause control, but not free-form narration prompting.
- Polly voices are loaded from AWS at runtime using your current CLI/profile credentials.
- The default Polly engine is `standard` for better region compatibility. Switch to `neural` only if your selected AWS region exposes the voices you want.
- Gemini TTS is still a preview model, so expect occasional voice or style inconsistencies.
- Use the `Test current voice` button in the UI to verify your key, voice, and narration settings before a full run.
