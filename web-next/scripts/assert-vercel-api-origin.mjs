/**
 * Fail a Vercel (or local Vercel-mode) build if the SPA bundle still points
 * auth at same-origin /api (relative). That misconfig makes login look broken
 * because Vercel has no Worker backend.
 *
 * Lives under web-next/ so Vercel includes it (.vercelignore excludes repo
 * root scripts/ but not web-next/).
 *
 * Usage (after vite build, from web-next/):
 *   node scripts/assert-vercel-api-origin.mjs
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const webNextRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = path.join(webNextRoot, 'dist', 'assets')
const WORKER = 'reader-tts-api.reader-tts-ari.workers.dev'

async function main() {
  let files
  try {
    files = await readdir(assetsDir)
  } catch {
    console.error('[assert-vercel-api-origin] Missing web-next/dist/assets — build first.')
    process.exit(1)
  }

  const jsFiles = files.filter((f) => f.endsWith('.js'))
  let foundWorker = false
  let foundRelativeAuthTrap = false

  for (const name of jsFiles) {
    const text = await readFile(path.join(assetsDir, name), 'utf8')
    if (text.includes(WORKER)) foundWorker = true
    // Bundled trap from VITE_API_ORIGIN=relative without runtime host guard:
    // configuredApiOrigin hardcodes `relative` and never embeds the Worker URL.
    if (
      text.includes('/api/auth/login')
      && text.includes('`relative`')
      && !text.includes(WORKER)
    ) {
      foundRelativeAuthTrap = true
      console.error(`[assert-vercel-api-origin] Suspicious relative-only auth chunk: ${name}`)
    }
  }

  if (!foundWorker) {
    console.error(
      `[assert-vercel-api-origin] FAIL: no bundle references ${WORKER}.\n`
      + '  Vercel builds must set:\n'
      + '  VITE_API_ORIGIN=https://reader-tts-api.reader-tts-ari.workers.dev VITE_API_MODE=absolute\n'
      + '  (see vercel.json buildCommand). Do not deploy a Cloudflare-relative dist to Vercel.',
    )
    process.exit(1)
  }

  if (foundRelativeAuthTrap) {
    console.error(
      '[assert-vercel-api-origin] FAIL: auth chunk looks relative-only without Worker URL.',
    )
    process.exit(1)
  }

  console.log(`[assert-vercel-api-origin] OK — Worker API origin present (${WORKER}).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
