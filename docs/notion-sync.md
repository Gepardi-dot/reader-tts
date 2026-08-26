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
5. Copy credentials from **OAuth connection**:
   - **Client ID:** use the `client_id=` value inside **Authorization URL** (Select All in that field). Do not trust the Client ID box if it differs — Notion’s install page rejects the wrong one as “Missing or incomplete Client ID”.
   - **Client secret:** the secret field, not the client id.
   - Put the client id in `wrangler.toml` `[vars]` as `NOTION_CLIENT_ID`. Never `wrangler secret put` the client id (PowerShell adds a newline).
   - Put only the client secret as a Worker secret.

```powershell
cd cloudflare/worker
# Client ID belongs in wrangler.toml [vars], not secrets.
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
3. Each book becomes its own page in **Private** (Library), titled with the book name. Notes live inside that page.
4. New highlights/notes append there. **Sync existing notes** copies what they already saved, and lifts older nested book pages into the library when Notion allows it.
