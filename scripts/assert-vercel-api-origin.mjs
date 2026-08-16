/**
 * Repo-root wrapper — delegates to web-next/scripts (the copy Vercel ships).
 * Prefer: npm --prefix web-next run assert:api-origin
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'web-next', 'scripts', 'assert-vercel-api-origin.mjs')
const result = spawnSync(process.execPath, [script], { stdio: 'inherit', cwd: root })
process.exit(result.status ?? 1)
