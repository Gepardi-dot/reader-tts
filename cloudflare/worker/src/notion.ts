/** Notion public OAuth + one-way note sync. Tokens never leave the Worker. */

export const NOTION_VERSION = '2022-06-28'
/** Workspace-level Private pages require a current Notion-Version. */
const NOTION_PAGES_VERSION = '2026-03-11'
const NOTION_AUTH = 'https://api.notion.com/v1/oauth/authorize'
const NOTION_TOKEN = 'https://api.notion.com/v1/oauth/token'
const NOTION_API = 'https://api.notion.com/v1'
const STATE_TTL_MS = 15 * 60 * 1000
const TITLE_MAX = 80
const TEXT_MAX = 1900
const WORKSPACE_PARENT = { type: 'workspace', workspace: true } as const
const LIBRARY_BOOK_ICON = { type: 'emoji', emoji: '📖' } as const

type NotionStatement = {
  bind: (...values: unknown[]) => NotionStatement
  first: <T = Record<string, unknown>>() => Promise<T | null>
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>
  run: () => Promise<unknown>
}

export type NotionEnv = {
  DB: {
    prepare: (query: string) => NotionStatement
  }
  APP_ORIGIN?: string
  NOTION_CLIENT_ID?: string
  NOTION_CLIENT_SECRET?: string
  NOTION_REDIRECT_URI?: string
}

export type NotionUser = { id: string; email: string }

export type NotionSearchHit = {
  id: string
  object: 'page' | 'database'
  title: string
}

export type NotionHighlight = {
  id: string
  text: string
  note: string | null
  color: string
  kind: string
}

export class NotionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function cleanNotionCredential(value: string | undefined | null): string {
  return (value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[\r\n\t]+/g, '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
}

export function notionConfigured(env: NotionEnv): boolean {
  return Boolean(cleanNotionCredential(env.NOTION_CLIENT_ID) && cleanNotionCredential(env.NOTION_CLIENT_SECRET))
}

export function notionRedirectUri(env: NotionEnv, requestUrl: string): string {
  const configured = env.NOTION_REDIRECT_URI?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return `${new URL(requestUrl).origin}/api/integrations/notion/callback`
}

export function isAllowedReturnOrigin(origin: string, env: NotionEnv, requestOrigin?: string): boolean {
  const allowed = new Set<string>()
  if (requestOrigin) allowed.add(requestOrigin.replace(/\/+$/, ''))
  for (const item of (env.APP_ORIGIN ?? '').split(',')) {
    const trimmed = item.trim().replace(/\/+$/, '')
    if (trimmed) allowed.add(trimmed)
  }
  allowed.add('https://higgsread.com')
  allowed.add('https://www.higgsread.com')
  allowed.add('https://readertts.vercel.app')
  allowed.add('http://localhost:5175')
  allowed.add('http://127.0.0.1:5175')
  allowed.add('http://localhost:5173')
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    if (allowed.has(url.origin)) return true
    if (url.hostname.endsWith('.vercel.app')) return true
    return false
  } catch {
    return false
  }
}

export function pickNotionHome(items: NotionSearchHit[]): NotionSearchHit | null {
  const pages = items.filter((item) => item.object === 'page')
  const named = pages.find((item) => item.title.trim().toLowerCase() === 'higgsread')
  if (named) return named
  if (pages[0]) return pages[0]
  return items.find((item) => item.object === 'database') ?? null
}

export function clipPlain(value: string, max = TEXT_MAX): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function highlightToBlocks(highlight: NotionHighlight): unknown[] {
  const quote = clipPlain(highlight.text)
  const note = highlight.note ? clipPlain(highlight.note) : ''
  const emoji = highlight.color === 'rose' ? '🌹' : highlight.color === 'sky' ? '💧' : '✨'
  const tint = highlight.color === 'rose'
    ? 'red_background'
    : highlight.color === 'sky'
      ? 'blue_background'
      : 'yellow_background'
  const caption = highlight.kind === 'note' ? 'Note' : 'Highlight'
  const children: unknown[] = [
    {
      object: 'block',
      type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content: quote || caption } }],
        icon: { type: 'emoji', emoji },
        color: tint,
      },
    },
  ]
  if (note) {
    children.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: note } }],
      },
    })
  }
  return children
}

export async function ensureNotionTables(env: NotionEnv): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS notion_connections (
      user_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      workspace_id TEXT,
      workspace_name TEXT,
      bot_id TEXT,
      parent_page_id TEXT,
      parent_kind TEXT NOT NULL DEFAULT 'page',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run()
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS notion_book_pages (
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      PRIMARY KEY (user_id, book_id)
    )
  `).run()
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS notion_oauth_states (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      return_origin TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run()
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS notion_synced_highlights (
      user_id TEXT NOT NULL,
      highlight_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      PRIMARY KEY (user_id, highlight_id)
    )
  `).run()
}

function notionHeaders(token: string, version = NOTION_VERSION): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': version,
    'Content-Type': 'application/json',
  }
}

export function workspacePageCreateBody(title: string) {
  return {
    parent: WORKSPACE_PARENT,
    icon: LIBRARY_BOOK_ICON,
    properties: {
      title: {
        title: [{ type: 'text', text: { content: clipPlain(title, TITLE_MAX) } }],
      },
    },
  }
}

async function notionFetch(
  token: string,
  path: string,
  init: RequestInit = {},
  version = NOTION_VERSION,
): Promise<unknown> {
  const response = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      ...notionHeaders(token, version),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new NotionHttpError(response.status, text.slice(0, 400) || response.statusText)
  }
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export async function notionStatus(env: NotionEnv, user: NotionUser) {
  await ensureNotionTables(env)
  const configured = notionConfigured(env)
  const row = await env.DB.prepare(
    `SELECT access_token, workspace_name, parent_page_id, parent_kind, updated_at
     FROM notion_connections WHERE user_id = ?`,
  ).bind(user.id).first<{
    access_token: string
    workspace_name: string | null
    parent_page_id: string | null
    parent_kind: string | null
    updated_at: string
  }>()
  let parentKind = row?.parent_kind ?? null
  if (row?.access_token && parentKind !== 'workspace') {
    await liftExistingBookPages(env, row.access_token, user.id)
    parentKind = 'workspace'
  }
  return {
    configured,
    connected: Boolean(row?.parent_page_id),
    workspaceName: row?.workspace_name ?? null,
    parentKind,
    updatedAt: row?.updated_at ?? null,
  }
}

export async function startNotionOAuth(
  env: NotionEnv,
  user: NotionUser,
  requestUrl: string,
  returnOrigin: string,
): Promise<{ url: string }> {
  if (!notionConfigured(env)) {
    throw new NotionHttpError(503, 'Notion sync is not configured on this server yet.')
  }
  await ensureNotionTables(env)
  const state = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    'INSERT INTO notion_oauth_states (state, user_id, return_origin, created_at) VALUES (?, ?, ?, ?)',
  ).bind(state, user.id, returnOrigin, now).run()
  const params = new URLSearchParams({
    client_id: cleanNotionCredential(env.NOTION_CLIENT_ID),
    response_type: 'code',
    owner: 'user',
    state,
    redirect_uri: notionRedirectUri(env, requestUrl),
  })
  return { url: `${NOTION_AUTH}?${params.toString()}` }
}

async function exchangeCode(env: NotionEnv, requestUrl: string, code: string) {
  const basic = btoa(`${cleanNotionCredential(env.NOTION_CLIENT_ID)}:${cleanNotionCredential(env.NOTION_CLIENT_SECRET)}`)
  const response = await fetch(NOTION_TOKEN, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: notionRedirectUri(env, requestUrl),
    }),
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || typeof payload.access_token !== 'string') {
    throw new NotionHttpError(502, 'Notion did not return an access token.')
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    workspaceId: typeof payload.workspace_id === 'string' ? payload.workspace_id : null,
    workspaceName: typeof payload.workspace_name === 'string' ? payload.workspace_name : null,
    botId: typeof payload.bot_id === 'string' ? payload.bot_id : null,
    duplicatedTemplateId: typeof payload.duplicated_template_id === 'string'
      ? payload.duplicated_template_id
      : null,
  }
}

async function createChildPage(token: string, parentPageId: string, title: string): Promise<string> {
  const payload = await notionFetch(token, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { page_id: parentPageId },
      properties: {
        title: {
          title: [{ type: 'text', text: { content: clipPlain(title, TITLE_MAX) } }],
        },
      },
    }),
  }) as Record<string, unknown>
  if (typeof payload.id !== 'string') throw new NotionHttpError(502, 'Notion did not create a page.')
  return payload.id
}

async function createWorkspacePage(token: string, title: string): Promise<string> {
  const payload = await notionFetch(token, '/pages', {
    method: 'POST',
    body: JSON.stringify(workspacePageCreateBody(title)),
  }, NOTION_PAGES_VERSION) as Record<string, unknown>
  if (typeof payload.id !== 'string') throw new NotionHttpError(502, 'Notion did not create a page.')
  return payload.id
}

async function tryMovePageToLibrary(token: string, pageId: string): Promise<void> {
  try {
    await notionFetch(token, `/pages/${pageId}/move`, {
      method: 'POST',
      body: JSON.stringify({ parent: WORKSPACE_PARENT }),
    }, NOTION_PAGES_VERSION)
  } catch {
    /* older nested pages stay put if Notion rejects a workspace move */
  }
}

async function liftExistingBookPages(env: NotionEnv, token: string, userId: string): Promise<void> {
  const pages = await env.DB.prepare(
    'SELECT page_id FROM notion_book_pages WHERE user_id = ?',
  ).bind(userId).all<{ page_id: string }>()
  for (const page of pages.results ?? []) {
    if (page.page_id) await tryMovePageToLibrary(token, page.page_id)
  }
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE notion_connections SET parent_kind = 'workspace', updated_at = ? WHERE user_id = ?`,
  ).bind(now, userId).run()
}

async function createLibraryBookPage(
  token: string,
  title: string,
  fallbackParentId: string | null,
  fallbackKind: string,
): Promise<string> {
  try {
    return await createWorkspacePage(token, title)
  } catch (error) {
    if (fallbackKind === 'database' && fallbackParentId) {
      return createDatabaseItem(token, fallbackParentId, title)
    }
    if (fallbackParentId && fallbackParentId !== 'workspace') {
      return createChildPage(token, fallbackParentId, title)
    }
    throw error
  }
}

async function createDatabaseItem(token: string, databaseId: string, title: string): Promise<string> {
  const db = await notionFetch(token, `/databases/${databaseId}`) as Record<string, unknown>
  const properties = db.properties && typeof db.properties === 'object'
    ? db.properties as Record<string, unknown>
    : {}
  let titleKey = 'Name'
  for (const [key, value] of Object.entries(properties)) {
    if (value && typeof value === 'object' && (value as { type?: string }).type === 'title') {
      titleKey = key
      break
    }
  }
  const payload = await notionFetch(token, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        [titleKey]: {
          title: [{ type: 'text', text: { content: clipPlain(title, TITLE_MAX) } }],
        },
      },
    }),
  }) as Record<string, unknown>
  if (typeof payload.id !== 'string') throw new NotionHttpError(502, 'Notion did not create a page.')
  return payload.id
}

export async function finishNotionOAuth(
  env: NotionEnv,
  requestUrl: string,
  code: string | null,
  state: string | null,
  error: string | null,
): Promise<{ origin: string; query: string }> {
  await ensureNotionTables(env)
  const row = state
    ? await env.DB.prepare(
      'SELECT user_id, return_origin, created_at FROM notion_oauth_states WHERE state = ?',
    ).bind(state).first<{ user_id: string; return_origin: string; created_at: string }>()
    : null
  if (state) {
    await env.DB.prepare('DELETE FROM notion_oauth_states WHERE state = ?').bind(state).run()
  }
  const origin = row && isAllowedReturnOrigin(row.return_origin, env)
    ? row.return_origin
    : 'https://www.higgsread.com'
  if (error) return { origin, query: 'notion=denied' }
  if (!row || !code) return { origin, query: 'notion=error' }
  const created = Date.parse(row.created_at)
  if (!Number.isFinite(created) || Date.now() - created > STATE_TTL_MS) {
    return { origin, query: 'notion=error' }
  }

  try {
    const token = await exchangeCode(env, requestUrl, code)
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO notion_connections (
        user_id, access_token, refresh_token, workspace_id, workspace_name, bot_id,
        parent_page_id, parent_kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        workspace_id = excluded.workspace_id,
        workspace_name = excluded.workspace_name,
        bot_id = excluded.bot_id,
        parent_page_id = excluded.parent_page_id,
        parent_kind = excluded.parent_kind,
        updated_at = excluded.updated_at`,
    ).bind(
      row.user_id,
      token.accessToken,
      token.refreshToken,
      token.workspaceId,
      token.workspaceName,
      token.botId,
      token.workspaceId || 'workspace',
      'workspace',
      now,
      now,
    ).run()
    return { origin, query: 'notion=connected' }
  } catch (err) {
    console.error('notion oauth finish', err)
    return { origin, query: 'notion=error' }
  }
}

export async function disconnectNotion(env: NotionEnv, user: NotionUser) {
  await ensureNotionTables(env)
  await env.DB.prepare('DELETE FROM notion_synced_highlights WHERE user_id = ?').bind(user.id).run()
  await env.DB.prepare('DELETE FROM notion_book_pages WHERE user_id = ?').bind(user.id).run()
  await env.DB.prepare('DELETE FROM notion_connections WHERE user_id = ?').bind(user.id).run()
  return { ok: true, connected: false }
}

async function connectionRow(env: NotionEnv, userId: string) {
  return env.DB.prepare(
    `SELECT access_token, parent_page_id, parent_kind
     FROM notion_connections WHERE user_id = ?`,
  ).bind(userId).first<{
    access_token: string
    parent_page_id: string | null
    parent_kind: string | null
  }>()
}

async function bookPageId(
  env: NotionEnv,
  token: string,
  userId: string,
  bookId: string,
  bookTitle: string,
  parentId: string,
  parentKind: string,
): Promise<string> {
  const existing = await env.DB.prepare(
    'SELECT page_id FROM notion_book_pages WHERE user_id = ? AND book_id = ?',
  ).bind(userId, bookId).first<{ page_id: string }>()
  if (existing?.page_id) {
    if (parentKind !== 'workspace') await tryMovePageToLibrary(token, existing.page_id)
    return existing.page_id
  }
  const title = clipPlain(bookTitle || 'Untitled book', TITLE_MAX)
  const pageId = await createLibraryBookPage(token, title, parentId, parentKind)
  await env.DB.prepare(
    'INSERT OR REPLACE INTO notion_book_pages (user_id, book_id, page_id) VALUES (?, ?, ?)',
  ).bind(userId, bookId, pageId).run()
  return pageId
}

export async function syncHighlightToNotion(
  env: NotionEnv,
  user: NotionUser,
  bookId: string,
  highlight: NotionHighlight,
): Promise<boolean> {
  await ensureNotionTables(env)
  const conn = await connectionRow(env, user.id)
  if (!conn?.access_token || !conn.parent_page_id) return false
  const already = await env.DB.prepare(
    'SELECT highlight_id FROM notion_synced_highlights WHERE user_id = ? AND highlight_id = ?',
  ).bind(user.id, highlight.id).first()
  if (already) return true
  const book = await env.DB.prepare(
    'SELECT title FROM books WHERE id = ? AND user_id = ?',
  ).bind(bookId, user.id).first<{ title: string }>()
  if (!book) return false
  const pageId = await bookPageId(
    env,
    conn.access_token,
    user.id,
    bookId,
    book.title,
    conn.parent_page_id,
    conn.parent_kind || 'page',
  )
  await notionFetch(conn.access_token, `/blocks/${pageId}/children`, {
    method: 'PATCH',
    body: JSON.stringify({ children: highlightToBlocks(highlight) }),
  })
  await env.DB.prepare(
    'INSERT OR IGNORE INTO notion_synced_highlights (user_id, highlight_id, page_id) VALUES (?, ?, ?)',
  ).bind(user.id, highlight.id, pageId).run()
  return true
}

export async function syncAllNotesToNotion(env: NotionEnv, user: NotionUser): Promise<{ synced: number }> {
  await ensureNotionTables(env)
  const conn = await connectionRow(env, user.id)
  if (!conn?.access_token || !conn.parent_page_id) {
    throw new NotionHttpError(409, 'Connect Notion first.')
  }
  const rows = await env.DB.prepare(
    `SELECT h.id, h.book_id, h.text, h.note, h.color, h.kind
     FROM highlights h
     WHERE h.user_id = ?
       AND h.id NOT IN (
         SELECT highlight_id FROM notion_synced_highlights WHERE user_id = ?
       )
     ORDER BY h.created_at ASC
     LIMIT 80`,
  ).bind(user.id, user.id).all<{
    id: string
    book_id: string
    text: string
    note: string | null
    color: string
    kind: string
  }>()
  let synced = 0
  for (const row of rows.results ?? []) {
    const ok = await syncHighlightToNotion(env, user, row.book_id, {
      id: row.id,
      text: row.text,
      note: row.note,
      color: row.color,
      kind: row.kind,
    })
    if (ok) synced += 1
  }
  return { synced }
}
