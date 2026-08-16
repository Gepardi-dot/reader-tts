# Unified Cloudflare host (SPA + API)

Production target for **absolute smoothness**: one Worker serves the React app and `/api` on the **same origin**.

## Architecture

```
Browser → https://reader-tts-api.reader-tts-ari.workers.dev
            ├── /*        static SPA (web-next/dist via Workers Assets)
            └── /api/*    Worker (D1, R2, Gemini, Kokoro proxy)
```

No CORS for the main app. No Vercel hop for API calls.

## Deploy

```bash
# From repo root (builds SPA with relative /api, then wrangler deploy)
npm run deploy:cloudflare
```

Requires Wrangler auth and existing secrets (`GEMINI_API_KEY`, `KOKORO_REMOTE_API_KEY`, etc.).

## Local development

Unchanged: Vite on `:5175` proxies `/api` → local Worker on `:8787`.

```bash
npm run worker:dev
npm run dev
```

## Vercel (backup only)

`vercel.json` still builds with:

`VITE_API_ORIGIN=https://reader-tts-api.reader-tts-ari.workers.dev VITE_API_MODE=absolute`

then runs `scripts/assert-vercel-api-origin.mjs` so a relative-only bundle cannot ship.

The SPA also **runtime-guards** any `*.vercel.app` host: even if a bad relative bundle is served, auth/API calls force the Worker URL (`web-next/src/shared/api/apiOrigin.ts`). Prefer the unified Workers URL for day-to-day use.

**Do not** put `VITE_API_ORIGIN=relative` in `web-next/.env.production` — that used to break Vercel login (same-origin `/api` → 405, no useful error).

## Custom domain (recommended next)

In Cloudflare DNS / Workers:

1. Add custom domain to the Worker (e.g. `app.yourdomain.com` or apex).
2. SPA + API stay same-origin automatically.
3. Point users at that domain; optional: redirect `readertts.vercel.app` there.
