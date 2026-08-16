/**
 * FAIL THE BUILD if the service worker can cache or intercept the app shell.
 *
 * Historical bug: cache-first index.html/assets pinned returning browsers to a
 * broken auth build after deploys. Policy is permanent:
 *   - SW may only handle cross-origin model + cover hosts
 *   - Same-origin (HTML, JS, CSS, /api) must never use event.respondWith
 *
 * Usage (from web-next/):
 *   node scripts/assert-sw-policy.mjs
 *   node scripts/assert-sw-policy.mjs --dist   # also check dist/sw.js after build
 */
import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkDist = process.argv.includes('--dist')

const REQUIRED = [
  {
    re: /url\.origin\s*===\s*self\.location\.origin/,
    msg: 'must early-return on same-origin requests (never intercept app/API)',
  },
  {
    re: /MODEL_CACHE|kokoro-model/,
    msg: 'must define model cache for Kokoro/HF bytes',
  },
  {
    re: /COVER_CACHE|book-covers/,
    msg: 'must define cover cache',
  },
]

/** Patterns that reintroduce the login-breaking shell cache. */
const FORBIDDEN = [
  {
    re: /storybook-shell/i,
    msg: 'must not use storybook-shell caches (legacy HTML/asset shell)',
  },
  {
    re: /cacheFirstShell|cacheFirstAsset|SHELL_CACHE|SHELL_URLS/,
    msg: 'must not define shell/asset cache helpers',
  },
  {
    re: /cache\.addAll\s*\(/,
    msg: 'must not precache URLs (addAll) — shell precache caused sticky HTML',
  },
  {
    re: /pathname\s*===\s*['"`]\/index\.html['"`]/,
    msg: 'must not special-case /index.html for caching',
  },
  {
    re: /pathname\.startsWith\s*\(\s*['"`]\/assets\//,
    msg: 'must not intercept /assets/* (app JS/CSS must stay on network/HTTP cache)',
  },
  {
    re: /pathname\s*===\s*['"`]\/['"`]/,
    msg: 'must not special-case pathname "/" for SW responses',
  },
  {
    re: /mode\s*===\s*['"`]navigate['"`]/,
    msg: 'must not intercept navigate mode (documents always network)',
  },
  {
    re: /['"`]\/api\//,
    msg: 'must not reference /api/ paths (API must never go through SW)',
  },
  {
    re: /staleWhileRevalidate/,
    msg: 'must not use stale-while-revalidate for same-origin APIs',
  },
]

function fail(file, reason) {
  console.error(`[assert-sw-policy] FAIL ${file}: ${reason}`)
  process.exitCode = 1
}

async function checkFile(relPath) {
  const abs = path.join(root, relPath)
  let text
  try {
    text = await readFile(abs, 'utf8')
  } catch {
    fail(relPath, 'file missing')
    return
  }

  // Strip block comments so docs examples don't trip forbidden checks.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '\n').replace(/^\s*\/\/.*$/gm, '')

  for (const rule of REQUIRED) {
    if (!rule.re.test(code)) fail(relPath, `missing required policy — ${rule.msg}`)
  }
  for (const rule of FORBIDDEN) {
    if (rule.re.test(code)) fail(relPath, `forbidden pattern — ${rule.msg}`)
  }

  // Same-origin guard must appear BEFORE any event.respondWith in the fetch handler.
  const fetchIdx = code.search(/addEventListener\s*\(\s*['"`]fetch['"`]/)
  if (fetchIdx < 0) {
    fail(relPath, 'missing fetch event listener')
    return
  }
  const fetchBody = code.slice(fetchIdx)
  const sameOriginIdx = fetchBody.search(/url\.origin\s*===\s*self\.location\.origin/)
  const respondIdx = fetchBody.search(/event\.respondWith/)
  if (sameOriginIdx < 0) {
    fail(relPath, 'fetch handler missing same-origin early return')
  } else if (respondIdx >= 0 && respondIdx < sameOriginIdx) {
    fail(relPath, 'event.respondWith appears before same-origin guard')
  }

  if (process.exitCode) return
  console.log(`[assert-sw-policy] OK ${relPath}`)
}

async function main() {
  await checkFile(path.join('public', 'sw.js'))
  if (checkDist) {
    try {
      await access(path.join(root, 'dist', 'sw.js'))
      await checkFile(path.join('dist', 'sw.js'))
    } catch {
      fail('dist/sw.js', 'expected after vite build (public/sw.js → dist/sw.js)')
    }
  }
  if (process.exitCode) {
    console.error(
      '\n[assert-sw-policy] Service worker must ONLY cache cross-origin models/covers.\n'
      + '  See docs/cloudflare-unified-host.md — "Service worker policy".\n'
      + '  Do not reintroduce shell/HTML/asset caching; it breaks returning logins.',
    )
    process.exit(1)
  }
  console.log('[assert-sw-policy] All checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
