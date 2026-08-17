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

via `npm --prefix web-next run build:vercel`, which runs
`web-next/scripts/assert-vercel-api-origin.mjs` so a relative-only bundle cannot ship.

`.vercelignore` must use **`/scripts/`** (root only). A bare `scripts/` pattern also
ignores `web-next/scripts/` and breaks the Vercel build.

## Service worker policy (do not regress)

`web-next/public/sw.js` may **only** intercept cross-origin model/cover hosts
(Hugging Face, Open Library, etc.). It must **never** cache or handle:

- HTML / navigations
- `/assets/*` app JS/CSS
- `/api/*`

Caching the SPA shell previously pinned returning browsers to a stale `index.html`
and broke login after deploys. Hashed assets use normal HTTP `Cache-Control: immutable`.

**Enforced automatically** (build fails if violated):

```bash
npm --prefix web-next run assert:sw-policy
# also runs on every npm run build / build:vercel and in GitHub CI
```

See `web-next/scripts/assert-sw-policy.mjs`.

The installable PWA is **manifest + local-first data**, not an app-shell worker.
Do not add `vite-plugin-pwa` / Workbox `generateSW`. `web-next/scripts/assert-pwa.mjs`
guards the manifest, icons, and the no-Workbox rule.

The SPA also **runtime-guards** any `*.vercel.app` host: even if a bad relative bundle is served, auth/API calls force the Worker URL (`web-next/src/shared/api/apiOrigin.ts`). Prefer the unified Workers URL for day-to-day use.

**Do not** put `VITE_API_ORIGIN=relative` in `web-next/.env.production` — that used to break Vercel login (same-origin `/api` → 405, no useful error).

## Custom domain

### Vercel custom domain (current: higgsread.com)

If the SPA stays on Vercel and only the domain changes:

1. Add `higgsread.com` / `www.higgsread.com` in the Vercel project Domains settings.
2. Ensure the Worker allows those origins in CORS (`APP_ORIGIN` + `isAllowedBrowserOrigin` in `cloudflare/worker`).
3. Redeploy the Worker after origin changes (`npm run worker:deploy`).
4. SPA runtime treats `higgsread.com` as a static host and always calls the absolute Worker API.

### Unified Cloudflare host (recommended long-term)

In Cloudflare DNS / Workers:

1. Add custom domain to the Worker (e.g. `app.higgsread.com` or apex).
2. SPA + API stay same-origin automatically.
3. Point users at that domain; optional: redirect `readertts.vercel.app` there.
