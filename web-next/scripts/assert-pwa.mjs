/**
 * FAIL THE BUILD if the installable PWA regresses to an app-shell worker
 * or ships without a valid HiggsRead manifest + icons.
 *
 * Usage (from web-next/):
 *   node scripts/assert-pwa.mjs
 *   node scripts/assert-pwa.mjs --dist
 */
import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkDist = process.argv.includes('--dist')

const REQUIRED_ICONS = [
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-192.png',
  'icon-maskable-512.png',
  'icon-96.png',
  'apple-touch-icon.png',
  'screenshot-narrow.png',
  'screenshot-wide.png',
  'manifest.webmanifest',
]

function fail(file, reason) {
  console.error(`[assert-pwa] FAIL ${file}: ${reason}`)
  process.exitCode = 1
}

async function mustExist(relPath) {
  try {
    await access(path.join(root, relPath))
    console.log(`[assert-pwa] OK ${relPath}`)
  } catch {
    fail(relPath, 'file missing')
  }
}

async function assertManifest(relPath) {
  let raw
  try {
    raw = await readFile(path.join(root, relPath), 'utf8')
  } catch {
    fail(relPath, 'file missing')
    return
  }

  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    fail(relPath, 'invalid JSON')
    return
  }

  if (manifest.name !== 'HiggsRead' || manifest.short_name !== 'HiggsRead') {
    fail(relPath, 'name/short_name must be HiggsRead')
  }
  if (manifest.display !== 'standalone') {
    fail(relPath, 'display must be standalone')
  }
  if (manifest.start_url !== '/' || manifest.scope !== '/') {
    fail(relPath, 'start_url and scope must be / (never a cached login URL)')
  }
  if (manifest.theme_color !== '#F7F7F5' || manifest.background_color !== '#F7F7F5') {
    fail(relPath, 'theme/background must match app surface #F7F7F5')
  }
  const purposes = new Set(
    (manifest.icons ?? []).flatMap((icon) => String(icon.purpose || 'any').split(/\s+/)),
  )
  if (!purposes.has('any') || !purposes.has('maskable')) {
    fail(relPath, 'must ship separate any + maskable icons')
  }
  if ((manifest.icons ?? []).some((icon) => /\bany\b/.test(icon.purpose || '') && /\bmaskable\b/.test(icon.purpose || ''))) {
    fail(relPath, 'do not combine purpose "any maskable" on one file')
  }
  if (!Array.isArray(manifest.file_handlers) || manifest.file_handlers.length === 0) {
    fail(relPath, 'must declare file_handlers for Open With')
  }
  if ((manifest.file_handlers ?? []).some((handler) => handler.action !== '/upload')) {
    fail(relPath, 'file_handlers must open /upload')
  }
  console.log(`[assert-pwa] OK ${relPath}`)
}

async function assertIndexHtml() {
  const relPath = 'index.html'
  let text
  try {
    text = await readFile(path.join(root, relPath), 'utf8')
  } catch {
    fail(relPath, 'file missing')
    return
  }
  if (!text.includes('rel="manifest"') || !text.includes('/manifest.webmanifest')) {
    fail(relPath, 'must link manifest.webmanifest')
  }
  if (!text.includes('viewport-fit=cover')) {
    fail(relPath, 'viewport must include viewport-fit=cover for standalone notches')
  }
  if (!text.includes('apple-mobile-web-app-capable')) {
    fail(relPath, 'must declare iOS web-app-capable')
  }
  if (!text.includes('beforeinstallprompt') || !text.includes('__higgsPwa')) {
    fail(relPath, 'must capture beforeinstallprompt before the app module loads')
  }
  console.log(`[assert-pwa] OK ${relPath}`)
}

async function assertNoWorkbox() {
  const relPath = 'vite.config.ts'
  let text
  try {
    text = await readFile(path.join(root, relPath), 'utf8')
  } catch {
    fail(relPath, 'file missing')
    return
  }
  if (/vite-plugin-pwa|VitePWA|workbox|generateSW|navigateFallback/i.test(text)) {
    fail(relPath, 'must not add vite-plugin-pwa / Workbox app-shell caching')
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (deps['vite-plugin-pwa'] || deps.workbox || deps['workbox-build']) {
    fail('package.json', 'must not depend on vite-plugin-pwa / workbox')
  }
  console.log(`[assert-pwa] OK ${relPath} (no Workbox)`)
}

async function main() {
  const publicRoot = checkDist ? 'dist' : 'public'
  for (const name of REQUIRED_ICONS) {
    await mustExist(path.join(publicRoot, name))
  }
  await assertManifest(path.join(publicRoot, 'manifest.webmanifest'))
  await assertIndexHtml()
  await assertNoWorkbox()

  if (process.exitCode) {
    console.error(
      '\n[assert-pwa] HiggsRead PWA must stay installable without caching the app shell.\n'
      + '  Manifest + icons live in web-next/public. Do not add Workbox generateSW.',
    )
    process.exit(1)
  }
  console.log('[assert-pwa] All checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
