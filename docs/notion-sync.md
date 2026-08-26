# Notion note sync

Users tap **Connect Notion** once. HiggsRead writes each book's notes under a page titled with the book.

## Operator setup (one time)

1. Open [Notion integrations](https://www.notion.so/my-integrations) → **New integration**.
2. Type: **Public**.
3. Capabilities: **Read content**, **Update content**, **Insert content**. No user email needed.
4. Redirect URIs (exact):
   - `https://reader-tts-api.reader-tts-ari.workers.dev/api/integrations/notion/callback`
   - `http://127.0.0.1:8787/api/integrations/notion/callback`
   - `http://localhost:8787/api/integrations/notion/callback`
5. Copy the OAuth client id and secret.

```powershell
cd cloudflare/worker
npx wrangler secret put NOTION_CLIENT_ID --config wrangler.toml
npx wrangler secret put NOTION_CLIENT_SECRET --config wrangler.toml
npx wrangler d1 migrations apply reader_tts --remote --config wrangler.toml
npx wrangler deploy --config wrangler.toml
```

Local:

```powershell
# Add to cloudflare/worker/.dev.vars (gitignored)
NOTION_CLIENT_ID=...
NOTION_CLIENT_SECRET=...

npx wrangler d1 migrations apply reader_tts --local --config wrangler.toml
```

## What the user sees

1. Notes or Settings → **Connect Notion**.
2. Notion asks them to pick **any page** (required by Notion — we cannot skip this).
3. We create a **HiggsRead** folder under that page and a child page per book title.
4. New highlights/notes append there. **Sync existing notes** copies what they already saved.
