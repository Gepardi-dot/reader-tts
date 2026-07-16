/**
 * Build the SPA for same-origin /api and deploy the unified Cloudflare Worker
 * (static assets + API on one host).
 *
 * Usage (repo root): node scripts/deploy-cloudflare.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: isWin,
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

console.log('[deploy:cloudflare] Building web-next with same-origin API (VITE_API_ORIGIN=relative)…')
run(isWin ? 'npm.cmd' : 'npm', ['--prefix', 'web-next', 'run', 'build'], {
  VITE_API_ORIGIN: 'relative',
})

const dist = path.join(root, 'web-next', 'dist', 'index.html')
if (!existsSync(dist)) {
  console.error('[deploy:cloudflare] Missing web-next/dist — build failed.')
  process.exit(1)
}

console.log('[deploy:cloudflare] Deploying Worker + SPA assets…')
run(isWin ? 'npx.cmd' : 'npx', [
  'wrangler',
  'deploy',
  '--config',
  'cloudflare/worker/wrangler.toml',
])

console.log('')
console.log('[deploy:cloudflare] Done.')
console.log('  App (unified): https://reader-tts-api.reader-tts-ari.workers.dev/')
console.log('  API health:    https://reader-tts-api.reader-tts-ari.workers.dev/api/health')
console.log('  Vercel remains a backup if still configured.')
