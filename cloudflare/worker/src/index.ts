type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>
}

interface R2ObjectBody {
  size: number
  customMetadata?: Record<string, string>
  arrayBuffer(): Promise<ArrayBuffer>
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: {
      httpMetadata?: {
        contentType?: string
        cacheControl?: string
      }
      customMetadata?: Record<string, string>
    },
  ): Promise<unknown>
}

interface Env {
  DB: D1Database
  AUDIO_CACHE?: R2Bucket
  APP_ORIGIN?: string
  SESSION_DAYS?: string
  GEMINI_API_KEY?: string
  GEMINI_TTS_MODEL?: string
  /** Optional chat/text model for reader assistant (defaults to gemini-2.0-flash). */
  GEMINI_CHAT_MODEL?: string
  /** Base URL of the hosted Kokoro FastAPI server (e.g. https://kokoro-reader.fly.dev). */
  KOKORO_REMOTE_URL?: string
  /** Shared secret matching KOKORO_API_KEY on the Kokoro server. */
  KOKORO_REMOTE_API_KEY?: string
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

interface User {
  id: string
  email: string
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const encoder = new TextEncoder()
const PASSWORD_ITERATIONS = 100_000
const DEFAULT_SESSION_DAYS = 30
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-preview-tts'
const GEMINI_CHAT_DEFAULT_MODEL = 'gemini-2.0-flash'
const GEMINI_SAMPLE_RATE = 24_000
const KOKORO_SAMPLE_RATE = 24_000
const KOKORO_DEFAULT_VOICE = 'af_heart'
const LIVE_AUDIO_CACHE_VERSION = 2
const EDGE_AUDIO_CACHE_SECONDS = 7 * 24 * 60 * 60
const R2_AUDIO_CACHE_PREFIX = `live-audio/v${LIVE_AUDIO_CACHE_VERSION}`
const TELEMETRY_MAX_EVENTS = 20
const TELEMETRY_MAX_TEXT = 160
const TELEMETRY_MAX_METADATA_CHARS = 1800
const TELEMETRY_RETENTION_DAYS = 14
const PROVIDER_PREVIEW_TEXT = (
  'When the room quieted, the story finally found its rhythm. ' +
  'Read this sample with natural phrasing, steady pacing, and a warm, attentive tone.'
)

const GEMINI_TTS_MODELS = [
  {
    id: 'gemini-3.1-flash-tts-preview',
    label: 'Gemini 3.1 Flash TTS',
    description: 'Current low-latency Gemini TTS preview model.',
  },
  {
    id: 'gemini-2.5-flash-preview-tts',
    label: 'Gemini 2.5 Flash TTS',
    description: 'Fast Gemini TTS for short narration chunks.',
  },
  {
    id: 'gemini-2.5-pro-preview-tts',
    label: 'Gemini 2.5 Pro TTS',
    description: 'Higher-capability Gemini TTS when quota allows.',
  },
]

const GEMINI_VOICES = [
  { id: 'Kore', label: 'Kore', gender: 'female', style: 'Firm', tags: ['Story'] },
  { id: 'Sulafat', label: 'Sulafat', gender: 'female', style: 'Warm', tags: ['Story'] },
  { id: 'Achernar', label: 'Achernar', gender: 'neutral', style: 'Soft', tags: ['Story'] },
  { id: 'Gacrux', label: 'Gacrux', gender: 'neutral', style: 'Mature', tags: ['Story'] },
  { id: 'Zephyr', label: 'Zephyr', gender: 'neutral', style: 'Bright' },
  { id: 'Puck', label: 'Puck', gender: 'male', style: 'Upbeat' },
  { id: 'Charon', label: 'Charon', gender: 'male', style: 'Informative' },
  { id: 'Aoede', label: 'Aoede', gender: 'female', style: 'Breezy' },
  { id: 'Algieba', label: 'Algieba', gender: 'neutral', style: 'Smooth' },
  { id: 'Erinome', label: 'Erinome', gender: 'female', style: 'Clear' },
]

const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart', gender: 'female', style: 'Warm & Natural', tags: ['Story'] },
  { id: 'af_sarah', label: 'Sarah', gender: 'female', style: 'Clear & Conversational' },
  { id: 'af_sky', label: 'Sky', gender: 'female', style: 'Bright & Expressive' },
  { id: 'af_bella', label: 'Bella', gender: 'female', style: 'Soft' },
  { id: 'am_adam', label: 'Adam', gender: 'male', style: 'Natural & Steady', tags: ['Story'] },
  { id: 'am_michael', label: 'Michael', gender: 'male', style: 'Authoritative' },
  { id: 'bf_emma', label: 'Emma', gender: 'female', style: 'British & Warm' },
  { id: 'bm_george', label: 'George', gender: 'male', style: 'British & Deep', tags: ['Story'] },
  { id: 'bm_lewis', label: 'Lewis', gender: 'male', style: 'British & Calm' },
]

function kokoroRemoteConfigured(env: Env) {
  return Boolean(env.KOKORO_REMOTE_URL?.trim())
}

function configuredKokoroVoice(requestedVoice: string | null) {
  if (requestedVoice && KOKORO_VOICES.some((voice) => voice.id === requestedVoice)) {
    return requestedVoice
  }
  return KOKORO_DEFAULT_VOICE
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) })
    }

    try {
      const url = new URL(request.url)
      const response = await route(request, env, url, ctx)
      return withCors(response, request, env)
    } catch (error) {
      if (error instanceof ApiError) {
        return withCors(json({ detail: error.message }, error.status), request, env)
      }
      console.error(error)
      return withCors(json({ detail: 'Internal server error' }, 500), request, env)
    }
  },
}

function primaryAppOrigin(env: Env) {
  const configured = (env.APP_ORIGIN ?? '')
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean)
  return configured[0] || 'https://readertts.vercel.app'
}

/** Friendly landing when someone opens the API host in a browser (not the SPA). */
function apiLanding(env: Env, request: Request) {
  const app = primaryAppOrigin(env)
  const accept = request.headers.get('Accept') || ''
  if (accept.includes('text/html')) {
    // Send humans to the real app UI.
    return Response.redirect(app, 302)
  }
  return json({
    service: 'reader-tts-api',
    status: 'ok',
    message: 'This host is the API only. Open the app URL in your browser to use the reader.',
    app,
    health: '/api/health',
  })
}

async function route(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = normalizePath(url.pathname)

  // Root / non-API paths: never demand auth (browsers often open the workers.dev URL).
  if (path === '/' || path === '' || !path.startsWith('/api/')) {
    return apiLanding(env, request)
  }

  if (path === '/api/health' && request.method === 'GET') return health(env)
  if (path.startsWith('/api/auth/')) return handleAuth(request, env, path)
  if (path === '/api/providers' && request.method === 'GET') return providers(env)
  if (path === '/api/providers/warmup' && request.method === 'POST') return json({ ok: true })
  if (path === '/api/dictionary/lookup' && request.method === 'GET') return dictionaryLookup(url, env)

  const user = await requireUser(request, env)

  if (path === '/api/providers/test' && request.method === 'POST') return testProvider(request, env)
  if (path === '/api/telemetry/tts-summary' && request.method === 'GET') return ttsTelemetrySummary(env, user)
  if (path === '/api/telemetry' && request.method === 'POST') return recordTelemetry(request, env, user)

  if (path === '/api/books' && request.method === 'GET') return listBooks(env, user)
  if (path === '/api/books' && request.method === 'POST') return createBook(request, env, user)
  if (path === '/api/vocabulary/decks' && request.method === 'GET') return listDecks(env, user)
  if (path === '/api/vocabulary/decks' && request.method === 'POST') return createDeck(request, env, user)
  if (path === '/api/vocabulary/learning-summary' && request.method === 'GET') {
    return learningSummary(env, user)
  }

  const bookMatch = path.match(/^\/api\/books\/([^/]+)(?:\/(.*))?$/)
  if (bookMatch) {
    return handleBookRoute(request, env, user, decodeURIComponent(bookMatch[1]), bookMatch[2] ?? '', ctx)
  }

  const deckMatch = path.match(/^\/api\/vocabulary\/decks\/([^/]+)(?:\/(.*))?$/)
  if (deckMatch) {
    return handleDeckRoute(request, env, user, decodeURIComponent(deckMatch[1]), deckMatch[2] ?? '')
  }

  const noteRefreshMatch = path.match(/^\/api\/vocabulary\/notes\/([^/]+)\/refresh-definition$/)
  if (noteRefreshMatch && request.method === 'POST') {
    return json(await getNote(env, user, decodeURIComponent(noteRefreshMatch[1])))
  }

  const noteMnemonicMatch = path.match(/^\/api\/vocabulary\/notes\/([^/]+)\/mnemonic$/)
  if (noteMnemonicMatch && request.method === 'PATCH') {
    return updateMnemonic(request, env, user, decodeURIComponent(noteMnemonicMatch[1]))
  }

  const cardMatch = path.match(/^\/api\/vocabulary\/cards\/([^/]+)(?:\/(.*))?$/)
  if (cardMatch) {
    const cardId = decodeURIComponent(cardMatch[1])
    const rest = cardMatch[2] ?? ''
    if (rest === 'reviews' && request.method === 'POST') {
      return reviewCard(request, env, user, cardId)
    }
    if (rest === 'context' && request.method === 'POST') {
      return cardContext(request, env, user, cardId)
    }
    if (rest === 'coach' && request.method === 'POST') {
      return cardCoach(request, env, user, cardId)
    }
    if (rest === 'production' && request.method === 'POST') {
      return cardProduction(request, env, user, cardId)
    }
  }

  if (path === '/api/ai/vocab-check' && request.method === 'POST') {
    return aiVocabCheck(request)
  }
  if (path === '/api/ai/chat' && request.method === 'POST') {
    return aiReaderChat(request, env)
  }
  if (path === '/api/ai/ask' && request.method === 'POST') {
    return aiAskPassage(request, env)
  }

  if (
    path.startsWith('/api/ai/') ||
    path.includes('/coach') ||
    path.includes('/context') ||
    path.includes('/production')
  ) {
    return json({ detail: 'This AI endpoint is not available in the Cloudflare starter backend yet.' }, 501)
  }

  throw new ApiError(404, 'Not found')
}

function normalizePath(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
}

function json(body: JsonValue, status = 200, initHeaders?: HeadersInit) {
  const headers = new Headers(initHeaders)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(body), { status, headers })
}

function withCors(response: Response, request: Request, env: Env) {
  const headers = new Headers(response.headers)
  for (const [key, value] of corsHeaders(request, env)) headers.set(key, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function corsHeaders(request: Request, env: Env) {
  const headers = new Headers()
  const origin = request.headers.get('Origin')
  const configured = (env.APP_ORIGIN ?? '')
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean)
  // Always allow the production Vercel app + local Vite ports, even if APP_ORIGIN is unset.
  const defaults = [
    'https://readertts.vercel.app',
    'http://localhost:5175',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5175',
    'http://127.0.0.1:5173',
  ]
  const allowed = new Set([...configured, ...defaults])
  const allowOrigin = origin && allowed.has(origin)
    ? origin
    : (configured[0] || defaults[0])
  headers.set('Access-Control-Allow-Origin', allowOrigin)
  headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type')
  headers.set('Access-Control-Max-Age', '86400')
  // Required so the Vercel app can use COEP require-corp (SharedArrayBuffer / Kokoro WASM).
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  headers.set('Vary', 'Origin')
  return headers
}

async function readJson<T extends Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const value = await request.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value as T
  } catch {
    throw new ApiError(400, 'Expected a JSON request body.')
  }
}

async function health(env: Env) {
  try {
    await env.DB.prepare('SELECT 1 AS ok').first()
    return json({ status: 'ok', db: { configured: true, ok: true }, runtime: 'cloudflare-workers' })
  } catch (error) {
    return json({
      status: 'ok',
      db: { configured: true, ok: false, error: error instanceof Error ? error.message : String(error) },
      runtime: 'cloudflare-workers',
    })
  }
}

async function handleAuth(request: Request, env: Env, path: string) {
  if (path === '/api/auth/signup' && request.method === 'POST') {
    const body = await readJson<{ email?: unknown; password?: unknown }>(request)
    const email = normalizeEmail(body.email)
    const password = requirePassword(body.password)

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
    if (existing) throw new ApiError(409, 'An account already exists for this email.')

    const now = new Date().toISOString()
    const user = { id: crypto.randomUUID(), email }
    const deckId = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .bind(user.id, user.email, await hashPassword(password), now),
      env.DB.prepare(
        'INSERT INTO vocabulary_decks (id, user_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(deckId, user.id, 'My Vocabulary', 'Words saved while reading', now, now),
    ])
    return json(await issueSession(env, user), 201)
  }

  if (path === '/api/auth/login' && request.method === 'POST') {
    const body = await readJson<{ email?: unknown; password?: unknown }>(request)
    const email = normalizeEmail(body.email)
    const password = requirePassword(body.password)
    const row = await env.DB.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: string; email: string; password_hash: string }>()
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new ApiError(401, 'Invalid email or password.')
    }
    return json(await issueSession(env, { id: row.id, email: row.email }))
  }

  if (path === '/api/auth/session' && request.method === 'GET') {
    const user = await requireUser(request, env)
    return json({ user })
  }

  if (path === '/api/auth/logout' && request.method === 'POST') {
    const token = bearerToken(request)
    if (token) {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Base64Url(token)).run()
    }
    return json({ ok: true })
  }

  throw new ApiError(404, 'Not found')
}

function normalizeEmail(value: unknown) {
  if (typeof value !== 'string') throw new ApiError(400, 'Email is required.')
  const email = value.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'Enter a valid email address.')
  return email
}

function requirePassword(value: unknown) {
  if (typeof value !== 'string') throw new ApiError(400, 'Password is required.')
  if (value.length < 8) throw new ApiError(400, 'Password must be at least 8 characters.')
  return value
}

async function issueSession(env: Env, user: User) {
  const rawToken = randomBase64Url(32)
  const tokenHash = await sha256Base64Url(rawToken)
  const days = Number(env.SESSION_DAYS ?? DEFAULT_SESSION_DAYS)
  const now = new Date()
  const expiresAt = now.getTime() + Math.max(1, days) * 24 * 60 * 60 * 1000
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(tokenHash, user.id, expiresAt, now.toISOString(), now.toISOString()).run()
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()).run()
  return { token: rawToken, user, expiresAt }
}

function bearerToken(request: Request) {
  const header = request.headers.get('Authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

async function requireUser(request: Request, env: Env): Promise<User> {
  const token = bearerToken(request)
  if (!token) throw new ApiError(401, 'Unauthorized')
  const tokenHash = await sha256Base64Url(token)
  const row = await env.DB.prepare(
    `SELECT u.id, u.email
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(tokenHash, Date.now()).first<User>()
  if (!row) throw new ApiError(401, 'Unauthorized')
  await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
    .bind(new Date().toISOString(), tokenHash)
    .run()
  return { id: row.id, email: row.email }
}

async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const digest = await pbkdf2(password, salt, PASSWORD_ITERATIONS)
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${base64Url(salt)}$${base64Url(digest)}`
}

async function verifyPassword(password: string, encoded: string) {
  const [scheme, iterationRaw, saltRaw, digestRaw] = encoded.split('$')
  if (scheme !== 'pbkdf2-sha256') return false
  const iterations = Number(iterationRaw)
  if (!Number.isFinite(iterations) || iterations < PASSWORD_ITERATIONS) return false
  const expected = base64UrlToBytes(digestRaw)
  const actual = await pbkdf2(password, base64UrlToBytes(saltRaw), iterations)
  return timingSafeEqual(actual, expected)
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  )
  return new Uint8Array(bits)
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i]
  return diff === 0
}

async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return base64Url(new Uint8Array(digest))
}

function randomBase64Url(bytes: number) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function listBooks(env: Env, user: User) {
  const rows = await env.DB.prepare(
    `SELECT b.*,
            COALESCE(h.highlight_count, 0) AS highlight_count,
            rp.page_number, rp.total_pages, rp.text_start, rp.text_end, rp.text_length, rp.updated_at AS progress_updated_at
     FROM books b
     LEFT JOIN (
       SELECT book_id, COUNT(*) AS highlight_count FROM highlights WHERE user_id = ? GROUP BY book_id
     ) h ON h.book_id = b.id
     LEFT JOIN reader_progress rp ON rp.book_id = b.id AND rp.user_id = ?
     WHERE b.user_id = ?
     ORDER BY b.uploaded_at DESC`,
  ).bind(user.id, user.id, user.id).all<Record<string, unknown>>()
  return json({ items: rows.results.map(serializeBook) })
}

async function createBook(request: Request, env: Env, user: User) {
  const contentType = request.headers.get('Content-Type') ?? ''
  let title = ''
  let fileName = ''
  let text = ''
  let sourceFormat = ''
  let pageCount: number | null = null

  if (contentType.includes('application/json')) {
    const body = await readJson<Record<string, unknown>>(request)
    title = stringField(body.title) || stringField(body.fileName) || 'Untitled book'
    fileName = stringField(body.fileName) || `${title}.txt`
    text = stringField(body.text)
    sourceFormat = stringField(body.sourceFormat)
    pageCount = requestedPageCount(body.pageCount)
  } else if (contentType.includes('multipart/form-data')) {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) throw new ApiError(400, 'File is required.')
    title = stringField(form.get('title')) || titleFromFileName(file.name)
    fileName = file.name
    sourceFormat = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!isPlainTextLike(file.name, file.type)) {
      throw new ApiError(415, 'PDF and ebook extraction will run in the browser in the Cloudflare build. Upload TXT or Markdown for this API path.')
    }
    text = await file.text()
  } else {
    throw new ApiError(415, 'Unsupported upload content type.')
  }

  if (!text.trim()) throw new ApiError(400, 'No readable text was provided.')

  const now = new Date().toISOString()
  const book = {
    id: crypto.randomUUID(),
    userId: user.id,
    title: title.trim(),
    fileName,
    uploadedAt: now,
    pageCount: pageCount ?? estimatePages(text),
    textCharacters: text.length,
    text,
    excerpt: text.trim().slice(0, 320),
    sourceUrl: '',
    sourceFormat,
  }
  await env.DB.prepare(
    `INSERT INTO books
     (id, user_id, title, file_name, uploaded_at, page_count, text_characters, text, excerpt, source_url, source_format)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    book.id,
    book.userId,
    book.title,
    book.fileName,
    book.uploadedAt,
    book.pageCount,
    book.textCharacters,
    book.text,
    book.excerpt,
    book.sourceUrl,
    book.sourceFormat,
  ).run()
  return json(serializeBook({
    ...book,
    user_id: book.userId,
    file_name: book.fileName,
    uploaded_at: book.uploadedAt,
    page_count: book.pageCount,
    text_characters: book.textCharacters,
    source_url: book.sourceUrl,
    source_format: book.sourceFormat,
    highlight_count: 0,
  }), 201)
}

function serializeBook(row: Record<string, unknown>) {
  const progress = row.page_number == null ? null : {
    pageNumber: Number(row.page_number),
    totalPages: Number(row.total_pages),
    textStart: Number(row.text_start ?? 0),
    textEnd: Number(row.text_end ?? 0),
    textLength: Number(row.text_length ?? row.text_characters ?? 0),
    updatedAt: String(row.progress_updated_at ?? row.updated_at ?? ''),
  }
  return {
    id: String(row.id),
    title: String(row.title),
    fileName: String(row.file_name ?? row.fileName ?? ''),
    uploadedAt: String(row.uploaded_at ?? row.uploadedAt ?? ''),
    pageCount: Number(row.page_count ?? row.pageCount ?? 0),
    textCharacters: Number(row.text_characters ?? row.textCharacters ?? 0),
    sourceUrl: String(row.source_url ?? row.sourceUrl ?? ''),
    excerpt: String(row.excerpt ?? ''),
    highlightCount: Number(row.highlight_count ?? 0),
    readingProgress: progress,
  }
}

function stringField(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function titleFromFileName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled book'
}

function isPlainTextLike(fileName: string, contentType: string) {
  const ext = fileName.split('.').pop()?.toLowerCase()
  return contentType.startsWith('text/') || ext === 'txt' || ext === 'md' || ext === 'markdown'
}

function estimatePages(text: string) {
  return Math.max(1, Math.ceil(text.length / 2400))
}

function requestedPageCount(value: unknown) {
  const pageCount = Number(value)
  return Number.isFinite(pageCount) && pageCount > 0 ? Math.round(pageCount) : null
}

async function handleBookRoute(request: Request, env: Env, user: User, bookId: string, rest: string, ctx: ExecutionContext) {
  if (!rest && request.method === 'GET') return json(await getBook(env, user, bookId))
  if (!rest && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM books WHERE id = ? AND user_id = ?').bind(bookId, user.id).run()
    return json({ ok: true })
  }
  if (rest === 'reader' && request.method === 'GET') return bookReader(env, user, bookId)
  if (rest === 'source' && request.method === 'GET') {
    const row = await bookRow(env, user, bookId)
    return new Response(String(row.text ?? ''), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  if (rest === 'progress' && request.method === 'GET') return bookProgress(env, user, bookId)
  if (rest === 'progress/reading' && request.method === 'PUT') return updateReadingProgress(request, env, user, bookId)
  if (rest === 'highlights' && request.method === 'GET') return listHighlights(env, user, bookId)
  if (rest === 'highlights' && request.method === 'POST') return createHighlight(request, env, user, bookId)
  const highlightDelete = rest.match(/^highlights\/([^/]+)$/)
  if (highlightDelete && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM highlights WHERE id = ? AND user_id = ? AND book_id = ?')
      .bind(decodeURIComponent(highlightDelete[1]), user.id, bookId)
      .run()
    return json({ ok: true })
  }
  if (rest === 'live-audio' && request.method === 'POST') {
    return liveAudio(request, env, user, bookId, ctx)
  }
  if (rest.startsWith('presynthesize')) {
    return json({ detail: 'Server presynthesis is disabled. Use Browser speech or on-device Kokoro for instant playback.' }, 501)
  }
  throw new ApiError(404, 'Not found')
}

async function getBook(env: Env, user: User, bookId: string) {
  return serializeBook(await bookRow(env, user, bookId))
}

async function bookRow(env: Env, user: User, bookId: string) {
  const row = await env.DB.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?').bind(bookId, user.id).first<Record<string, unknown>>()
  if (!row) throw new ApiError(404, 'Book not found.')
  return row
}

async function bookReader(env: Env, user: User, bookId: string) {
  const book = await bookRow(env, user, bookId)
  const highlights = await highlightRows(env, user, bookId)
  return json({
    book: { id: String(book.id), title: String(book.title) },
    text: String(book.text ?? ''),
    highlights,
  })
}

async function bookProgress(env: Env, user: User, bookId: string) {
  await bookRow(env, user, bookId)
  const row = await env.DB.prepare('SELECT * FROM reader_progress WHERE book_id = ? AND user_id = ?')
    .bind(bookId, user.id)
    .first<Record<string, unknown>>()
  return json({ reading: row ? serializeReadingProgress(row) : null, audio: null })
}

function configuredGeminiModel(env: Env, requested?: string | null) {
  const requestedModel = requested?.trim()
  if (requestedModel && GEMINI_TTS_MODELS.some((model) => model.id === requestedModel)) return requestedModel
  if (requestedModel) throw new ApiError(400, `Unsupported Gemini TTS model: ${requestedModel}`)
  const configured = env.GEMINI_TTS_MODEL?.trim()
  return configured && GEMINI_TTS_MODELS.some((model) => model.id === configured)
    ? configured
    : GEMINI_DEFAULT_MODEL
}

function configuredGeminiVoice(requested?: string | null) {
  const requestedVoice = requested?.trim()
  if (requestedVoice && GEMINI_VOICES.some((voice) => voice.id === requestedVoice)) return requestedVoice
  if (requestedVoice) throw new ApiError(400, `Unsupported Gemini voice: ${requestedVoice}`)
  return 'Kore'
}

function normalizeSelectionText(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

function pacingInstruction(lengthScale: number) {
  if (lengthScale >= 1.25) return 'Speak slower than normal conversation, with deliberate phrasing.'
  if (lengthScale >= 1.08) return 'Speak slightly slower than normal conversation, with room at sentence endings.'
  if (lengthScale <= 0.85) return 'Speak a bit faster than normal conversation while keeping the words clear.'
  if (lengthScale <= 0.95) return 'Speak slightly faster than normal conversation while keeping phrasing controlled.'
  return 'Speak at a natural audiobook pace.'
}

function pauseInstruction(sentenceSilence: number) {
  const ms = Math.max(0, Math.round(sentenceSilence * 1000))
  if (ms >= 450) return 'Use generous pauses after sentences.'
  if (ms >= 250) return 'Use natural pauses after sentences.'
  return 'Keep sentence pauses compact.'
}

function geminiDirectedText(text: string, narrationStyle: string, lengthScale: number, sentenceSilence: number) {
  const style = narrationStyle.trim() || 'Read like a premium audiobook narrator. Keep the delivery natural, warm, and attentive.'
  return [
    style,
    pacingInstruction(lengthScale),
    pauseInstruction(sentenceSilence),
    'Read only the passage below. Do not add introductions, labels, commentary, or sound effects.',
    '',
    text,
  ].join('\n')
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function pcmToWav(pcm: Uint8Array, sampleRate = GEMINI_SAMPLE_RATE) {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)

  const wav = new Uint8Array(44 + pcm.byteLength)
  wav.set(new Uint8Array(header), 0)
  wav.set(pcm, 44)
  return wav
}

function edgeAudioCacheRequest(cacheDigest: string) {
  return new Request(`https://reader-tts.internal/audio-cache/${cacheDigest}.json`, {
    method: 'GET',
  })
}

async function readEdgeAudioCache(cacheDigest: string): Promise<Record<string, JsonValue> | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cached = await caches.default.match(edgeAudioCacheRequest(cacheDigest))
    if (!cached || !cached.ok) return null
    const payload = await cached.json()
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, JsonValue>
      : null
  } catch {
    return null
  }
}

function writeEdgeAudioCache(ctx: ExecutionContext, cacheDigest: string, payload: Record<string, JsonValue>) {
  if (typeof caches === 'undefined') return
  const response = json(payload, 200, {
    'Cache-Control': `public, max-age=${EDGE_AUDIO_CACHE_SECONDS}`,
  })
  ctx.waitUntil(
    caches.default
      .put(edgeAudioCacheRequest(cacheDigest), response)
      .catch(() => undefined),
  )
}

function r2AudioCacheKey(cacheDigest: string) {
  return `${R2_AUDIO_CACHE_PREFIX}/${cacheDigest}.wav`
}

function liveAudioPayloadFromWav(
  cacheDigest: string,
  wav: Uint8Array,
  options: {
    duration: number | null
    cacheStorage?: string
  },
): Record<string, JsonValue> {
  return {
    url: `data:audio/wav;base64,${bytesToBase64(wav)}`,
    duration: options.duration,
    cues: [],
    cacheKey: `live-audio:v${LIVE_AUDIO_CACHE_VERSION}:${cacheDigest}`,
    cacheVersion: LIVE_AUDIO_CACHE_VERSION,
    contentType: 'audio/wav',
    byteLength: wav.byteLength,
    cacheHit: false,
    cacheStorage: options.cacheStorage ?? 'generated',
  }
}

async function readR2AudioCache(env: Env, cacheDigest: string): Promise<Record<string, JsonValue> | null> {
  if (!env.AUDIO_CACHE) return null
  try {
    const object = await env.AUDIO_CACHE.get(r2AudioCacheKey(cacheDigest))
    if (!object) return null
    const wav = new Uint8Array(await object.arrayBuffer())
    const durationRaw = object.customMetadata?.duration
    const duration = durationRaw && Number.isFinite(Number(durationRaw))
      ? Number(durationRaw)
      : null
    return liveAudioPayloadFromWav(cacheDigest, wav, {
      duration,
      cacheStorage: 'r2',
    })
  } catch {
    return null
  }
}

function writeR2AudioCache(
  ctx: ExecutionContext,
  env: Env,
  cacheDigest: string,
  result: { duration: number; wav: Uint8Array },
) {
  if (!env.AUDIO_CACHE) return
  const metadata: Record<string, string> = {
    duration: String(result.duration),
    cacheVersion: String(LIVE_AUDIO_CACHE_VERSION),
    contentType: 'audio/wav',
    byteLength: String(result.wav.byteLength),
  }
  ctx.waitUntil(
    env.AUDIO_CACHE
      .put(r2AudioCacheKey(cacheDigest), result.wav, {
        httpMetadata: {
          contentType: 'audio/wav',
          cacheControl: `public, max-age=${EDGE_AUDIO_CACHE_SECONDS}`,
        },
        customMetadata: metadata,
      })
      .catch(() => undefined),
  )
}

async function geminiLiveAudioCacheDigest(input: {
  bookId: string
  provider: string
  voice: string
  model: string
  narrationStyle: string
  lengthScale: number
  sentenceSilence: number
  start: number
  end: number
  text: string
}) {
  return sha256Base64Url(JSON.stringify({
    version: LIVE_AUDIO_CACHE_VERSION,
    ...input,
  }))
}

function extractGeminiAudioBase64(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const candidates = Array.isArray(root.candidates) ? root.candidates : []
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const content = (candidate as Record<string, unknown>).content
    const parts = content && typeof content === 'object'
      ? (content as Record<string, unknown>).parts
      : null
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const inlineData = (part as Record<string, unknown>).inlineData ?? (part as Record<string, unknown>).inline_data
      if (!inlineData || typeof inlineData !== 'object') continue
      const data = (inlineData as Record<string, unknown>).data
      if (typeof data === 'string' && data) return data
    }
  }
  return null
}

async function synthesizeGeminiAudio(env: Env, options: {
  text: string
  voice: string | null
  model: string | null
  narrationStyle: string
  lengthScale: number
  sentenceSilence: number
}) {
  const apiKey = env.GEMINI_API_KEY?.trim()
  if (!apiKey) throw new ApiError(400, 'Gemini TTS is not configured yet. Add GEMINI_API_KEY to the Cloudflare Worker secrets.')

  const model = configuredGeminiModel(env, options.model)
  const voice = configuredGeminiVoice(options.voice)
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: geminiDirectedText(
            options.text,
            options.narrationStyle,
            options.lengthScale,
            options.sentenceSilence,
          ),
        }],
      }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      },
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText)
    const status = response.status === 429
      ? 429
      : (response.status >= 500 ? 502 : 400)
    throw new ApiError(status, `Gemini TTS failed (${response.status}): ${detail.slice(0, 500)}`)
  }

  const payload = await response.json()
  const audioBase64 = extractGeminiAudioBase64(payload)
  if (!audioBase64) throw new ApiError(502, 'Gemini TTS returned no audio.')

  const pcm = base64ToBytes(audioBase64)
  const wav = pcmToWav(pcm)
  return {
    model,
    voice,
    wav,
    duration: pcm.byteLength / 2 / GEMINI_SAMPLE_RATE,
  }
}

async function synthesizeKokoroRemote(
  env: Env,
  input: {
    text: string
    voice: string | null
    lengthScale: number
  },
): Promise<{ model: string; voice: string; wav: Uint8Array; duration: number }> {
  const base = env.KOKORO_REMOTE_URL?.trim().replace(/\/+$/, '')
  if (!base) {
    throw new ApiError(
      400,
      'Hosted Kokoro is not configured. Set KOKORO_REMOTE_URL (and optional KOKORO_REMOTE_API_KEY) on the Worker.',
    )
  }

  const voice = configuredKokoroVoice(input.voice)
  const speed = input.lengthScale > 0 ? Math.max(0.5, Math.min(2, 1 / input.lengthScale)) : 1
  const apiKey = env.KOKORO_REMOTE_API_KEY?.trim()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'audio/wav,application/octet-stream',
  }
  if (apiKey) {
    headers['X-Api-Key'] = apiKey
    headers.Authorization = `Bearer ${apiKey}`
  }

  let response: Response
  try {
    response = await fetch(`${base}/v1/synthesize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: input.text,
        voice,
        speed,
      }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiError(502, `Hosted Kokoro unreachable: ${message.slice(0, 300)}`)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const status = response.status === 401 || response.status === 403
      ? 502
      : response.status === 429
        ? 429
        : (response.status >= 500 ? 502 : 400)
    throw new ApiError(status, `Hosted Kokoro failed (${response.status}): ${detail.slice(0, 500)}`)
  }

  const wav = new Uint8Array(await response.arrayBuffer())
  if (wav.byteLength < 44) throw new ApiError(502, 'Hosted Kokoro returned empty audio.')
  // WAV: estimate duration from PCM payload when header is standard 16-bit mono.
  const duration = Math.max(0.05, (wav.byteLength - 44) / 2 / KOKORO_SAMPLE_RATE)
  return {
    model: 'kokoro-remote',
    voice,
    wav,
    duration,
  }
}

async function liveAudio(request: Request, env: Env, user: User, bookId: string, ctx: ExecutionContext) {
  const book = await bookRow(env, user, bookId)
  const body = await readJson<Record<string, unknown>>(request)
  const provider = stringField(body.provider)
  if (provider !== 'google' && provider !== 'kokoro') {
    throw new ApiError(400, 'Supported cloud audio providers: google (Gemini), kokoro (hosted).')
  }
  if (provider === 'kokoro' && !kokoroRemoteConfigured(env)) {
    throw new ApiError(400, 'Hosted Kokoro is not configured on this API.')
  }
  if (provider === 'google' && !env.GEMINI_API_KEY?.trim()) {
    throw new ApiError(400, 'Gemini TTS is not configured on this API.')
  }

  const fullText = String(book.text ?? '')
  const start = Number(body.start ?? 0)
  const end = Number(body.end ?? 0)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > fullText.length) {
    throw new ApiError(400, 'Invalid live audio range.')
  }

  const selectedText = fullText.slice(start, end)
  const submittedText = stringField(body.text)
  if (normalizeSelectionText(selectedText) !== normalizeSelectionText(submittedText)) {
    throw new ApiError(400, 'Live audio text does not match the selected range.')
  }

  const synthesisText = selectedText.trim()
  if (!synthesisText) throw new ApiError(400, 'Live audio selection cannot be empty.')

  const lengthScale = Number(body.length_scale ?? body.lengthScale ?? 1)
  const sentenceSilence = Number(body.sentence_silence ?? body.sentenceSilence ?? 0.2)
  const safeLengthScale = Number.isFinite(lengthScale) ? lengthScale : 1
  const safeSentenceSilence = Number.isFinite(sentenceSilence) ? sentenceSilence : 0.2
  const model = provider === 'google'
    ? configuredGeminiModel(env, stringField(body.model) || null)
    : 'kokoro-remote'
  const voice = provider === 'google'
    ? configuredGeminiVoice(stringField(body.voice) || null)
    : configuredKokoroVoice(stringField(body.voice) || null)
  const narrationStyle = stringField(body.narration_style ?? body.narrationStyle)
  const normalizedText = normalizeSelectionText(synthesisText)
  const cacheDigest = await geminiLiveAudioCacheDigest({
    bookId,
    provider,
    voice,
    model,
    narrationStyle,
    lengthScale: safeLengthScale,
    sentenceSilence: safeSentenceSilence,
    start,
    end,
    text: normalizedText,
  })
  const cacheKey = `live-audio:v${LIVE_AUDIO_CACHE_VERSION}:${cacheDigest}`
  const cached = await readEdgeAudioCache(cacheDigest)
  if (cached) {
    return json({ ...cached, cacheHit: true, cacheStorage: 'edge' })
  }

  const durableCached = await readR2AudioCache(env, cacheDigest)
  if (durableCached) {
    writeEdgeAudioCache(ctx, cacheDigest, durableCached)
    return json({ ...durableCached, cacheHit: true, cacheStorage: 'r2' })
  }

  const result = provider === 'google'
    ? await synthesizeGeminiAudio(env, {
      text: synthesisText,
      voice,
      model,
      narrationStyle,
      lengthScale: safeLengthScale,
      sentenceSilence: safeSentenceSilence,
    })
    : await synthesizeKokoroRemote(env, {
      text: synthesisText,
      voice,
      lengthScale: safeLengthScale,
    })

  const payload = {
    ...liveAudioPayloadFromWav(cacheDigest, result.wav, {
      duration: result.duration,
      cacheStorage: 'generated',
    }),
    cacheKey,
  }
  writeR2AudioCache(ctx, env, cacheDigest, result)
  writeEdgeAudioCache(ctx, cacheDigest, payload)
  return json(payload)
}

async function testProvider(request: Request, env: Env) {
  const body = await readJson<Record<string, unknown>>(request)
  const provider = stringField(body.provider)
  if (provider !== 'google' && provider !== 'kokoro') {
    throw new ApiError(400, 'Supported previews: google, kokoro.')
  }

  const lengthScale = Number(body.length_scale ?? body.lengthScale ?? 1)
  const sentenceSilence = Number(body.sentence_silence ?? body.sentenceSilence ?? 0.2)
  const safeLengthScale = Number.isFinite(lengthScale) ? lengthScale : 1
  const safeSentenceSilence = Number.isFinite(sentenceSilence) ? sentenceSilence : 0.2
  // Allow short custom text (practice word pronounce, vocabulary cards).
  // Cap length so this endpoint cannot be used as a bulk TTS sink.
  const requestedText = stringField(body.text) || stringField(body.sampleText) || stringField(body.sample_text)
  const sampleText = (requestedText || PROVIDER_PREVIEW_TEXT).slice(0, 280)

  const result = provider === 'google'
    ? await synthesizeGeminiAudio(env, {
      text: sampleText,
      voice: stringField(body.voice) || null,
      model: stringField(body.model) || null,
      narrationStyle: stringField(body.narration_style ?? body.narrationStyle),
      lengthScale: safeLengthScale,
      sentenceSilence: safeSentenceSilence,
    })
    : await synthesizeKokoroRemote(env, {
      text: sampleText,
      voice: stringField(body.voice) || null,
      lengthScale: safeLengthScale,
    })

  return json({
    provider,
    voice: result.voice,
    model: result.model,
    sampleText,
    audioUrl: `data:audio/wav;base64,${bytesToBase64(result.wav)}`,
    message: provider === 'google' ? 'Gemini preview ready.' : 'Hosted Kokoro preview ready.',
  })
}

function telemetryString(value: unknown, maxLength = TELEMETRY_MAX_TEXT) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function telemetryNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function telemetryDuration(value: unknown) {
  const number = telemetryNumber(value)
  if (number == null) return null
  return Math.max(0, Math.min(10 * 60_000, Math.round(number)))
}

function telemetryBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : null
}

function telemetryMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const metadata: Record<string, JsonValue> = {}
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = telemetryString(key, 48)
    if (!safeKey) continue
    if (typeof raw === 'string') {
      metadata[safeKey] = raw.slice(0, 240)
    } else if (typeof raw === 'number') {
      metadata[safeKey] = Number.isFinite(raw) ? raw : null
    } else if (typeof raw === 'boolean' || raw == null) {
      metadata[safeKey] = raw
    }
  }
  const encoded = JSON.stringify(metadata)
  return encoded.length <= TELEMETRY_MAX_METADATA_CHARS
    ? encoded
    : null
}

function sanitizeTelemetryEvent(raw: unknown, now: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const eventName = telemetryString(input.eventName ?? input.event_name, 80)
  if (!/^[a-z][a-z0-9_.:-]{1,79}$/i.test(eventName)) return null
  const provider = telemetryString(input.provider, 48) || null
  const bookId = telemetryString(input.bookId ?? input.book_id, 80) || null
  const cacheHit = telemetryBoolean(input.cacheHit ?? input.cache_hit)
  return {
    id: crypto.randomUUID(),
    bookId,
    eventName,
    provider,
    durationMs: telemetryDuration(input.durationMs ?? input.duration_ms),
    value: telemetryNumber(input.value),
    cacheHit: cacheHit == null ? null : (cacheHit ? 1 : 0),
    cacheStorage: telemetryString(input.cacheStorage ?? input.cache_storage, 48) || null,
    metadataJson: telemetryMetadata(input.metadata),
    createdAt: now,
  }
}

async function recordTelemetry(request: Request, env: Env, user: User) {
  const body = await readJson<Record<string, unknown>>(request)
  const rawEvents = Array.isArray(body.events) ? body.events : [body]
  const now = new Date().toISOString()
  const events = rawEvents
    .slice(0, TELEMETRY_MAX_EVENTS)
    .map((event) => sanitizeTelemetryEvent(event, now))
    .filter((event): event is NonNullable<ReturnType<typeof sanitizeTelemetryEvent>> => Boolean(event))

  if (!events.length) return json({ ok: true, accepted: 0 })

  const statements = events.map((event) => env.DB.prepare(
    `INSERT INTO performance_events
     (id, user_id, book_id, event_name, provider, duration_ms, value, cache_hit, cache_storage, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    event.id,
    user.id,
    event.bookId,
    event.eventName,
    event.provider,
    event.durationMs,
    event.value,
    event.cacheHit,
    event.cacheStorage,
    event.metadataJson,
    event.createdAt,
  ))

  const retentionCutoff = new Date(Date.now() - TELEMETRY_RETENTION_DAYS * 24 * 60 * 60_000).toISOString()
  statements.push(
    env.DB.prepare('DELETE FROM performance_events WHERE created_at < ?').bind(retentionCutoff),
  )
  await env.DB.batch(statements)
  return json({ ok: true, accepted: events.length })
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function durationSummary(values: number[]) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, Math.round(value)))
    .sort((left, right) => left - right)
  if (!sorted.length) {
    return {
      count: 0,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      minMs: null,
      maxMs: null,
    }
  }
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    count: sorted.length,
    avgMs: Math.round(total / sorted.length),
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  }
}

function valueSummary(values: number[]) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, Math.round(value)))
    .sort((left, right) => left - right)
  if (!sorted.length) {
    return {
      count: 0,
      avg: null,
      p50: null,
      p95: null,
      min: null,
      max: null,
    }
  }
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    count: sorted.length,
    avg: Math.round(total / sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

interface TtsMetadataSummary {
  mode: string | null
  lane: string | null
  reason: string | null
  chunkStatus: string | null
  chunkIndex: number | null
  chunkChars: number | null
  totalChunks: number | null
  readyChunks: number | null
  bufferedSeconds: number | null
  currentIndex: number | null
  startOffset: number | null
  selectedChars: number | null
  background: boolean | null
  browserFallback: boolean | null
  kokoroModelReady: boolean | null
}

function metadataStringField(metadata: Record<string, unknown>, key: string) {
  return typeof metadata[key] === 'string' ? String(metadata[key]) : null
}

function metadataNumberField(metadata: Record<string, unknown>, key: string) {
  return Number.isFinite(Number(metadata[key])) ? Number(metadata[key]) : null
}

function metadataBooleanField(metadata: Record<string, unknown>, key: string) {
  return typeof metadata[key] === 'boolean' ? Boolean(metadata[key]) : null
}

function safeMetadataSummary(metadataJson: unknown): TtsMetadataSummary | null {
  if (typeof metadataJson !== 'string' || !metadataJson) return null
  try {
    const parsed = JSON.parse(metadataJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const metadata = parsed as Record<string, unknown>
    return {
      mode: metadataStringField(metadata, 'mode'),
      lane: metadataStringField(metadata, 'lane'),
      reason: metadataStringField(metadata, 'reason'),
      chunkStatus: metadataStringField(metadata, 'chunkStatus'),
      chunkIndex: metadataNumberField(metadata, 'chunkIndex'),
      chunkChars: metadataNumberField(metadata, 'chunkChars'),
      totalChunks: metadataNumberField(metadata, 'totalChunks'),
      readyChunks: metadataNumberField(metadata, 'readyChunks'),
      bufferedSeconds: metadataNumberField(metadata, 'bufferedSeconds'),
      currentIndex: metadataNumberField(metadata, 'currentIndex'),
      startOffset: metadataNumberField(metadata, 'startOffset'),
      selectedChars: metadataNumberField(metadata, 'selectedChars'),
      background: metadataBooleanField(metadata, 'background'),
      browserFallback: metadataBooleanField(metadata, 'browserFallback'),
      kokoroModelReady: metadataBooleanField(metadata, 'kokoroModelReady'),
    }
  } catch {
    return null
  }
}

function rowDuration(row: Record<string, unknown>) {
  if (row.duration_ms == null) return null
  const duration = Number(row.duration_ms)
  return Number.isFinite(duration) ? duration : null
}

function rowProvider(row: Record<string, unknown>) {
  return row.provider == null ? null : String(row.provider)
}

function bumpCounter(record: Record<string, number>, key: string | null | undefined) {
  if (!key) return
  record[key] = (record[key] ?? 0) + 1
}

function summarizeTtsDiagnostics(rows: Array<Record<string, unknown>>) {
  const firstAudio = new Map<string, {
    provider: string | null
    lane: string | null
    count: number
    durations: number[]
    reasons: Record<string, number>
  }>()
  const liveFetches = new Map<string, {
    provider: string | null
    background: boolean | null
    count: number
    durations: number[]
    cacheHits: number
    cacheMisses: number
    storage: Record<string, number>
  }>()
  const nativeReady = new Map<string, {
    provider: string | null
    count: number
    readyChunks: number[]
  }>()
  const nativeHandoffs = new Map<string, {
    provider: string | null
    count: number
    durations: number[]
    readyChunks: number[]
    bufferedSeconds: number[]
    cacheHits: number
    cacheMisses: number
    storage: Record<string, number>
    reasons: Record<string, number>
  }>()
  const underruns = new Map<string, {
    provider: string | null
    count: number
    chunkStatus: Record<string, number>
  }>()

  for (const row of rows) {
    const eventName = String(row.event_name ?? '')
    const provider = rowProvider(row)
    const metadata = safeMetadataSummary(row.metadata_json)
    const duration = rowDuration(row)

    if (eventName === 'tts.first_audio_v2') {
      const lane = metadata?.lane ?? 'unknown'
      const key = `${provider ?? ''}:${lane}`
      const group = firstAudio.get(key) ?? {
        provider,
        lane,
        count: 0,
        durations: [],
        reasons: {},
      }
      group.count += 1
      if (duration != null) group.durations.push(duration)
      bumpCounter(group.reasons, metadata?.reason ?? 'unknown')
      firstAudio.set(key, group)
    }

    if (eventName === 'tts.live_audio_fetch_v2') {
      const background = metadata?.background ?? null
      const key = `${provider ?? ''}:${background == null ? '' : String(background)}`
      const group = liveFetches.get(key) ?? {
        provider,
        background,
        count: 0,
        durations: [],
        cacheHits: 0,
        cacheMisses: 0,
        storage: {},
      }
      group.count += 1
      if (duration != null) group.durations.push(duration)
      if (row.cache_hit === 1) group.cacheHits += 1
      if (row.cache_hit === 0) group.cacheMisses += 1
      bumpCounter(group.storage, row.cache_storage == null ? null : String(row.cache_storage))
      liveFetches.set(key, group)
    }

    if (eventName === 'tts.native_ready_v2') {
      const key = provider ?? ''
      const group = nativeReady.get(key) ?? {
        provider,
        count: 0,
        readyChunks: [],
      }
      group.count += 1
      if (metadata?.readyChunks != null) group.readyChunks.push(metadata.readyChunks)
      nativeReady.set(key, group)
    }

    if (eventName === 'tts.native_handoff_v2') {
      const key = provider ?? ''
      const group = nativeHandoffs.get(key) ?? {
        provider,
        count: 0,
        durations: [],
        readyChunks: [],
        bufferedSeconds: [],
        cacheHits: 0,
        cacheMisses: 0,
        storage: {},
        reasons: {},
      }
      group.count += 1
      if (duration != null) group.durations.push(duration)
      if (metadata?.readyChunks != null) group.readyChunks.push(metadata.readyChunks)
      if (metadata?.bufferedSeconds != null) group.bufferedSeconds.push(metadata.bufferedSeconds)
      if (row.cache_hit === 1) group.cacheHits += 1
      if (row.cache_hit === 0) group.cacheMisses += 1
      bumpCounter(group.storage, row.cache_storage == null ? null : String(row.cache_storage))
      bumpCounter(group.reasons, metadata?.reason ?? 'unknown')
      nativeHandoffs.set(key, group)
    }

    if (eventName === 'tts.native_underrun_bridge_v2') {
      const key = provider ?? ''
      const group = underruns.get(key) ?? {
        provider,
        count: 0,
        chunkStatus: {},
      }
      group.count += 1
      bumpCounter(group.chunkStatus, metadata?.chunkStatus ?? 'unknown')
      underruns.set(key, group)
    }
  }

  const sortProvider = <T extends { provider: string | null }>(items: T[]) => (
    items.sort((left, right) => String(left.provider ?? '').localeCompare(String(right.provider ?? '')))
  )

  return {
    firstAudioByLane: Array.from(firstAudio.values())
      .sort((left, right) => (
        String(left.provider ?? '').localeCompare(String(right.provider ?? '')) ||
        String(left.lane ?? '').localeCompare(String(right.lane ?? ''))
      ))
      .map((group) => ({
        provider: group.provider,
        lane: group.lane,
        count: group.count,
        duration: durationSummary(group.durations),
        reasons: group.reasons,
      })),
    liveAudioFetches: Array.from(liveFetches.values())
      .sort((left, right) => (
        String(left.provider ?? '').localeCompare(String(right.provider ?? '')) ||
        String(left.background).localeCompare(String(right.background))
      ))
      .map((group) => ({
        provider: group.provider,
        background: group.background,
        count: group.count,
        duration: durationSummary(group.durations),
        cache: {
          hits: group.cacheHits,
          misses: group.cacheMisses,
          hitRate: group.cacheHits + group.cacheMisses
            ? Math.round((group.cacheHits / (group.cacheHits + group.cacheMisses)) * 1000) / 1000
            : null,
          storage: group.storage,
        },
      })),
    nativeReady: sortProvider(Array.from(nativeReady.values()))
      .map((group) => ({
        provider: group.provider,
        count: group.count,
        readyChunks: valueSummary(group.readyChunks),
      })),
    nativeHandoffs: sortProvider(Array.from(nativeHandoffs.values()))
      .map((group) => ({
        provider: group.provider,
        count: group.count,
        duration: durationSummary(group.durations),
        readyChunks: valueSummary(group.readyChunks),
        bufferedSeconds: valueSummary(group.bufferedSeconds),
        cache: {
          hits: group.cacheHits,
          misses: group.cacheMisses,
          hitRate: group.cacheHits + group.cacheMisses
            ? Math.round((group.cacheHits / (group.cacheHits + group.cacheMisses)) * 1000) / 1000
            : null,
          storage: group.storage,
        },
        reasons: group.reasons,
      })),
    underrunBridges: sortProvider(Array.from(underruns.values()))
      .map((group) => ({
        provider: group.provider,
        count: group.count,
        chunkStatus: group.chunkStatus,
      })),
  }
}

async function ttsTelemetrySummary(env: Env, user: User) {
  const since = new Date(Date.now() - TELEMETRY_RETENTION_DAYS * 24 * 60 * 60_000).toISOString()
  const rows = await env.DB.prepare(
    `SELECT event_name, provider, duration_ms, cache_hit, cache_storage, metadata_json, created_at
     FROM performance_events
     WHERE user_id = ? AND event_name LIKE 'tts.%' AND created_at >= ?
     ORDER BY created_at DESC
     LIMIT 1000`,
  ).bind(user.id, since).all<Record<string, unknown>>()

  const groups = new Map<string, {
    eventName: string
    provider: string | null
    count: number
    durations: number[]
    cacheHits: number
    cacheMisses: number
    cacheStorage: Record<string, number>
  }>()

  for (const row of rows.results) {
    const eventName = String(row.event_name ?? '')
    const provider = row.provider == null ? null : String(row.provider)
    const key = `${eventName}:${provider ?? ''}`
    const group = groups.get(key) ?? {
      eventName,
      provider,
      count: 0,
      durations: [],
      cacheHits: 0,
      cacheMisses: 0,
      cacheStorage: {},
    }
    group.count += 1
    if (row.duration_ms != null) {
      const duration = Number(row.duration_ms)
      if (Number.isFinite(duration)) group.durations.push(duration)
    }
    if (row.cache_hit === 1) group.cacheHits += 1
    if (row.cache_hit === 0) group.cacheMisses += 1
    const storage = row.cache_storage == null ? '' : String(row.cache_storage)
    if (storage) group.cacheStorage[storage] = (group.cacheStorage[storage] ?? 0) + 1
    groups.set(key, group)
  }

  const byEvent = Array.from(groups.values())
    .sort((left, right) => left.eventName.localeCompare(right.eventName) || String(left.provider ?? '').localeCompare(String(right.provider ?? '')))
    .map((group) => ({
      eventName: group.eventName,
      provider: group.provider,
      count: group.count,
      duration: durationSummary(group.durations),
      cache: {
        hits: group.cacheHits,
        misses: group.cacheMisses,
        hitRate: group.cacheHits + group.cacheMisses
          ? Math.round((group.cacheHits / (group.cacheHits + group.cacheMisses)) * 1000) / 1000
          : null,
        storage: group.cacheStorage,
      },
    }))

  const recent = rows.results.slice(0, 20).map((row) => ({
    eventName: String(row.event_name ?? ''),
    provider: row.provider == null ? null : String(row.provider),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    cacheHit: row.cache_hit == null ? null : row.cache_hit === 1,
    cacheStorage: row.cache_storage == null ? null : String(row.cache_storage),
    metadata: safeMetadataSummary(row.metadata_json),
    createdAt: String(row.created_at ?? ''),
  }))

  return json({
    windowDays: TELEMETRY_RETENTION_DAYS,
    totalEvents: rows.results.length,
    byEvent,
    diagnostics: summarizeTtsDiagnostics(rows.results),
    recent,
  })
}

async function updateReadingProgress(request: Request, env: Env, user: User, bookId: string) {
  const book = await bookRow(env, user, bookId)
  const body = await readJson<Record<string, unknown>>(request)
  const pageNumber = Number(body.pageNumber ?? body.page_number ?? 1)
  const totalPages = Number(body.totalPages ?? body.total_pages ?? estimatePages(String(book.text ?? '')))
  const textStart = Number(body.textStart ?? body.text_start ?? 0)
  const textEnd = Number(body.textEnd ?? body.text_end ?? textStart)
  const textLength = Number(body.textLength ?? body.text_length ?? String(book.text ?? '').length)
  if (!Number.isFinite(pageNumber) || !Number.isFinite(totalPages)) throw new ApiError(400, 'Invalid progress payload.')
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO reader_progress (book_id, user_id, page_number, total_pages, text_start, text_end, text_length, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id, user_id) DO UPDATE SET
       page_number = excluded.page_number,
       total_pages = excluded.total_pages,
       text_start = excluded.text_start,
       text_end = excluded.text_end,
       text_length = excluded.text_length,
       updated_at = excluded.updated_at`,
  ).bind(bookId, user.id, pageNumber, totalPages, textStart, textEnd, textLength, now).run()
  return json({
    pageNumber,
    totalPages,
    textStart,
    textEnd,
    textLength,
    updatedAt: now,
  })
}

function serializeReadingProgress(row: Record<string, unknown>) {
  return {
    pageNumber: Number(row.page_number),
    totalPages: Number(row.total_pages),
    textStart: Number(row.text_start),
    textEnd: Number(row.text_end),
    textLength: Number(row.text_length),
    updatedAt: String(row.updated_at),
  }
}

async function listHighlights(env: Env, user: User, bookId: string) {
  await bookRow(env, user, bookId)
  return json({ items: await highlightRows(env, user, bookId) })
}

async function highlightRows(env: Env, user: User, bookId: string) {
  const rows = await env.DB.prepare(
    'SELECT * FROM highlights WHERE book_id = ? AND user_id = ? ORDER BY start_offset ASC',
  ).bind(bookId, user.id).all<Record<string, unknown>>()
  return rows.results.map(serializeHighlight)
}

async function createHighlight(request: Request, env: Env, user: User, bookId: string) {
  await bookRow(env, user, bookId)
  const body = await readJson<Record<string, unknown>>(request)
  const id = crypto.randomUUID()
  const start = Number(body.start ?? body.startOffset ?? 0)
  const end = Number(body.end ?? body.endOffset ?? start)
  const text = stringField(body.text)
  if (!text || end <= start) throw new ApiError(400, 'Invalid highlight.')
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO highlights (id, book_id, user_id, start_offset, end_offset, text, note, color, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    bookId,
    user.id,
    start,
    end,
    text,
    stringField(body.note) || null,
    stringField(body.color) || 'amber',
    stringField(body.kind) || 'highlight',
    now,
  ).run()
  return json(serializeHighlight({
    id,
    book_id: bookId,
    start_offset: start,
    end_offset: end,
    text,
    note: stringField(body.note) || null,
    color: stringField(body.color) || 'amber',
    kind: stringField(body.kind) || 'highlight',
    created_at: now,
  }), 201)
}

function serializeHighlight(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    start: Number(row.start_offset),
    end: Number(row.end_offset),
    text: String(row.text),
    note: row.note == null ? null : String(row.note),
    color: String(row.color || 'amber'),
    kind: String(row.kind || 'highlight'),
    createdAt: String(row.created_at),
  }
}

async function listDecks(env: Env, user: User) {
  const rows = await env.DB.prepare('SELECT * FROM vocabulary_decks WHERE user_id = ? ORDER BY created_at ASC')
    .bind(user.id)
    .all<Record<string, unknown>>()
  const items = []
  for (const row of rows.results) items.push(await deckSummary(env, user, String(row.id), row))
  return json({ items })
}

async function createDeck(request: Request, env: Env, user: User) {
  const body = await readJson<Record<string, unknown>>(request)
  const now = new Date().toISOString()
  const deck = {
    id: crypto.randomUUID(),
    title: stringField(body.title) || 'My Vocabulary',
    description: stringField(body.description) || null,
  }
  await env.DB.prepare(
    'INSERT INTO vocabulary_decks (id, user_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(deck.id, user.id, deck.title, deck.description, now, now).run()
  return json({ ...deck, deck }, 201)
}

async function handleDeckRoute(request: Request, env: Env, user: User, deckId: string, rest: string) {
  if (!rest && request.method === 'GET') return deckDashboard(env, user, deckId)
  if (rest === 'notes' && request.method === 'POST') return createVocabularyNote(request, env, user, deckId)
  if (rest === 'practice-sessions' && request.method === 'POST') return practiceSession(request, env, user, deckId)
  if (rest === 'session' && request.method === 'GET') return practiceSession(null, env, user, deckId)
  throw new ApiError(404, 'Not found')
}

async function deckRow(env: Env, user: User, deckId: string) {
  const row = await env.DB.prepare('SELECT * FROM vocabulary_decks WHERE id = ? AND user_id = ?')
    .bind(deckId, user.id)
    .first<Record<string, unknown>>()
  if (!row) throw new ApiError(404, 'Deck not found.')
  return row
}

async function deckSummary(env: Env, user: User, deckId: string, existingDeck?: Record<string, unknown>) {
  const deck = existingDeck ?? await deckRow(env, user, deckId)
  const notes = await env.DB.prepare('SELECT COUNT(*) AS count FROM vocabulary_notes WHERE deck_id = ? AND user_id = ?')
    .bind(deckId, user.id)
    .first<{ count: number }>()
  const cards = await env.DB.prepare('SELECT state, due_at FROM vocabulary_cards WHERE deck_id = ? AND user_id = ?')
    .bind(deckId, user.id)
    .all<{ state: string; due_at: string }>()
  const now = Date.now()
  const cardsByState: Record<string, number> = { new: 0, learning: 0, review: 0, relearning: 0 }
  let dueNow = 0
  for (const card of cards.results) {
    cardsByState[card.state] = (cardsByState[card.state] ?? 0) + 1
    if (Date.parse(card.due_at) <= now) dueNow += 1
  }
  return {
    id: String(deck.id),
    title: String(deck.title),
    description: deck.description == null ? null : String(deck.description),
    cardCount: cards.results.length,
    noteCount: Number(notes?.count ?? 0),
    dueNow,
    dueToday: dueNow,
    newAvailable: cardsByState.new,
    newIntroducedToday: 0,
    reviewsCompletedToday: 0,
    nextDueAt: cards.results.map((card) => card.due_at).sort()[0] ?? null,
    cardsByState,
  }
}

async function deckDashboard(env: Env, user: User, deckId: string) {
  const summary = await deckSummary(env, user, deckId)
  const rows = await env.DB.prepare(
    'SELECT * FROM vocabulary_notes WHERE deck_id = ? AND user_id = ? ORDER BY created_at DESC',
  ).bind(deckId, user.id).all<Record<string, unknown>>()
  const notes = []
  for (const note of rows.results) notes.push(await serializeNoteWithCards(env, user, note))
  return json({
    deck: summary,
    notes,
    analytics: { cardsLearned: 0, rollingRetention7d: null, studyStreak: 0 },
  })
}

async function createVocabularyNote(request: Request, env: Env, user: User, deckId: string) {
  await deckRow(env, user, deckId)
  const body = await readJson<Record<string, unknown>>(request)
  const front = stringField(body.front)
  if (!front) throw new ApiError(400, 'Word is required.')

  const metadata = typeof body.metadata === 'object' && body.metadata ? body.metadata as Record<string, unknown> : {}
  const sourceBookId = stringField(metadata.bookId)
  const sourceBook = sourceBookId
    ? await env.DB.prepare('SELECT id, title FROM books WHERE id = ? AND user_id = ?')
      .bind(sourceBookId, user.id)
      .first<{ id: string; title: string }>()
    : null

  const existing = await env.DB.prepare(
    'SELECT * FROM vocabulary_notes WHERE deck_id = ? AND user_id = ? AND lower(front) = lower(?)',
  ).bind(deckId, user.id, front).first<Record<string, unknown>>()

  const now = new Date().toISOString()
  const back = stringField(body.back) || null
  const extra = stringField(body.extra) || null
  const hint = stringField(body.hint) || null
  const explanation = stringField(body.explanation) || null
  const exampleSentence = stringField(body.exampleSentence) || null
  const topic = stringField(body.topic) || null
  const answer = back || explanation || front

  if (existing) {
    const prevMeta = safeJsonObject(existing.metadata_json) ?? {}
    const mergedMeta = { ...prevMeta, ...metadata }
    const nextBack = back ?? (existing.back == null ? null : String(existing.back))
    const nextAnswer = back || explanation
      || (existing.back == null ? null : String(existing.back))
      || front

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE vocabulary_notes
         SET back = ?,
             extra = COALESCE(?, extra),
             hint = COALESCE(?, hint),
             explanation = COALESCE(?, explanation),
             // Allow clearing fabricated templates with '' (COALESCE would keep the old junk if null).
             example_sentence = CASE WHEN ? IS NOT NULL THEN ? ELSE example_sentence END,
             topic = COALESCE(?, topic),
             source_book_id = COALESCE(?, source_book_id),
             source_book_title = COALESCE(?, source_book_title),
             metadata_json = ?,
             updated_at = ?
         WHERE id = ? AND user_id = ?`,
      ).bind(
        nextBack,
        extra,
        hint,
        explanation,
        exampleSentence,
        exampleSentence,
        topic,
        sourceBook?.id ?? null,
        sourceBook?.title ?? null,
        JSON.stringify(mergedMeta),
        now,
        existing.id,
        user.id,
      ),
      // Keep study cards in sync when definition is filled in later.
      env.DB.prepare(
        `UPDATE vocabulary_cards
         SET answer = ?, cue = ?, updated_at = ?
         WHERE note_id = ? AND user_id = ?`,
      ).bind(nextAnswer, front, now, existing.id, user.id),
    ])

    return json(await getNote(env, user, String(existing.id)))
  }

  const noteId = crypto.randomUUID()
  const cardId = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vocabulary_notes
       (id, deck_id, user_id, front, back, extra, hint, explanation, example_sentence, topic,
        source_book_id, source_book_title, mnemonic, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      noteId,
      deckId,
      user.id,
      front,
      back,
      extra,
      hint,
      explanation,
      exampleSentence,
      topic,
      sourceBook?.id ?? null,
      sourceBook?.title ?? null,
      null,
      JSON.stringify(metadata),
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO vocabulary_cards
       (id, note_id, deck_id, user_id, card_type, state, cue, answer, due_at, scheduled_days, reps, lapses, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(cardId, noteId, deckId, user.id, 'basic', 'new', front, answer, now, 0, 0, 0, now, now),
  ])
  return json(await getNote(env, user, noteId), 201)
}

async function getNote(env: Env, user: User, noteId: string) {
  const note = await env.DB.prepare('SELECT * FROM vocabulary_notes WHERE id = ? AND user_id = ?')
    .bind(noteId, user.id)
    .first<Record<string, unknown>>()
  if (!note) throw new ApiError(404, 'Note not found.')
  return serializeNoteWithCards(env, user, note)
}

async function serializeNoteWithCards(env: Env, user: User, note: Record<string, unknown>) {
  const cards = await env.DB.prepare('SELECT * FROM vocabulary_cards WHERE note_id = ? AND user_id = ? ORDER BY created_at ASC')
    .bind(note.id, user.id)
    .all<Record<string, unknown>>()
  return {
    id: String(note.id),
    front: String(note.front),
    back: note.back == null ? null : String(note.back),
    extra: note.extra == null ? null : String(note.extra),
    hint: note.hint == null ? null : String(note.hint),
    explanation: note.explanation == null ? null : String(note.explanation),
    exampleSentence: note.example_sentence == null ? null : String(note.example_sentence),
    topic: note.topic == null ? null : String(note.topic),
    sourceBookId: note.source_book_id == null ? null : String(note.source_book_id),
    sourceBookTitle: note.source_book_title == null ? null : String(note.source_book_title),
    mnemonic: note.mnemonic == null ? null : String(note.mnemonic),
    metadata: safeJsonObject(note.metadata_json),
    cards: cards.results.map(serializeCard),
  }
}

function serializeCard(row: Record<string, unknown>) {
  const cue = String(row.cue ?? row.front ?? '')
  const answer = String(row.answer ?? row.back ?? cue)
  const cardType = String(row.card_type ?? 'basic')
  const front = String(row.front ?? cue)
  const back = row.back == null ? null : String(row.back)
  const extra = row.extra == null ? null : String(row.extra)
  const explanation = row.explanation == null ? null : String(row.explanation)
  const exampleSentence = row.example_sentence == null ? null : String(row.example_sentence)
  const topic = row.topic == null ? null : String(row.topic)
  const sourceBookTitle = row.source_book_title == null ? null : String(row.source_book_title)
  const mnemonic = row.mnemonic == null ? null : String(row.mnemonic)
  const pronunciation = extra && extra.startsWith('/') ? extra : null
  const productionTarget = cardType === 'reverse' ? (back || answer) : front || cue

  return {
    id: String(row.id),
    deckId: String(row.deck_id),
    noteId: String(row.note_id),
    cardType,
    state: String(row.state ?? 'new'),
    cue: cue || front,
    answer: answer || back || front,
    extra,
    hint: row.hint == null ? null : String(row.hint),
    explanation,
    exampleSentence,
    pronunciation,
    mnemonic,
    topic,
    sourceBookTitle,
    productionTarget,
    dueAt: String(row.due_at),
    scheduledDays: Number(row.scheduled_days ?? 0),
    reps: Number(row.reps ?? 0),
    lapses: Number(row.lapses ?? 0),
    debug: { scheduledDays: Number(row.scheduled_days ?? 0) },
    ratingPreview: {
      again: { dueAt: new Date(Date.now() + 5 * 60_000).toISOString(), label: '5m', state: 'learning' },
      hard: { dueAt: new Date(Date.now() + 30 * 60_000).toISOString(), label: '30m', state: 'learning' },
      good: { dueAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), label: '1d', state: 'review' },
      easy: { dueAt: new Date(Date.now() + 4 * 24 * 60 * 60_000).toISOString(), label: '4d', state: 'review' },
    },
  }
}

async function loadSessionCardRows(
  env: Env,
  user: User,
  deckId: string,
  limit = 20,
  options?: { includeNotDue?: boolean },
) {
  const now = new Date().toISOString()
  const capped = Math.max(1, Math.min(limit, 40))
  const dueRows = await env.DB.prepare(
    `SELECT c.*,
            n.front, n.back, n.extra, n.hint, n.explanation, n.example_sentence,
            n.topic, n.source_book_title, n.mnemonic
     FROM vocabulary_cards c
     JOIN vocabulary_notes n ON n.id = c.note_id
     WHERE c.deck_id = ? AND c.user_id = ?
       AND (
         c.due_at <= ?
         OR c.state IN ('new', 'learning', 'relearning')
       )
     ORDER BY
       CASE c.state
         WHEN 'new' THEN 0
         WHEN 'learning' THEN 1
         WHEN 'relearning' THEN 2
         ELSE 3
       END,
       c.due_at ASC
     LIMIT ?`,
  ).bind(deckId, user.id, now, capped).all<Record<string, unknown>>()

  const results = [...(dueRows.results ?? [])]
  // After a session, cards may all be "review" with future due dates.
  // Still allow practice-again / full sessions by filling from the rest of the deck.
  const includeNotDue = options?.includeNotDue !== false
  if (includeNotDue && results.length < capped) {
    const excludeIds = results.map((r) => String(r.id))
    const placeholders = excludeIds.length > 0
      ? ` AND c.id NOT IN (${excludeIds.map(() => '?').join(', ')})`
      : ''
    const filler = await env.DB.prepare(
      `SELECT c.*,
              n.front, n.back, n.extra, n.hint, n.explanation, n.example_sentence,
              n.topic, n.source_book_title, n.mnemonic
       FROM vocabulary_cards c
       JOIN vocabulary_notes n ON n.id = c.note_id
       WHERE c.deck_id = ? AND c.user_id = ?${placeholders}
       ORDER BY c.due_at ASC, c.updated_at DESC
       LIMIT ?`,
    ).bind(
      deckId,
      user.id,
      ...excludeIds,
      capped - results.length,
    ).all<Record<string, unknown>>()
    results.push(...(filler.results ?? []))
  }
  return results
}

async function getCardWithNote(env: Env, user: User, cardId: string) {
  const row = await env.DB.prepare(
    `SELECT c.*,
            n.front, n.back, n.extra, n.hint, n.explanation, n.example_sentence,
            n.topic, n.source_book_title, n.mnemonic, n.metadata_json
     FROM vocabulary_cards c
     JOIN vocabulary_notes n ON n.id = c.note_id
     WHERE c.id = ? AND c.user_id = ?`,
  ).bind(cardId, user.id).first<Record<string, unknown>>()
  if (!row) throw new ApiError(404, 'Card not found.')
  return row
}

function tokenizeForMatch(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2)
}

function overlapScore(learner: string, target: string) {
  const learnerTokens = new Set(tokenizeForMatch(learner))
  const targetTokens = tokenizeForMatch(target)
  if (targetTokens.length === 0) return learner.trim().length > 8 ? 0.5 : 0
  let hits = 0
  for (const token of targetTokens) {
    if (learnerTokens.has(token)) hits += 1
  }
  return hits / targetTokens.length
}

function heuristicVerdict(learner: string, target: string): {
  verdict: 'correct' | 'partial' | 'incorrect'
  score: number
} {
  const score = overlapScore(learner, target)
  if (score >= 0.55 || learner.toLowerCase().includes(target.toLowerCase().slice(0, Math.min(12, target.length)))) {
    return { verdict: 'correct', score }
  }
  if (score >= 0.25 || learner.trim().split(/\s+/).length >= 4) {
    return { verdict: 'partial', score }
  }
  return { verdict: 'incorrect', score }
}

function safeJsonObject(value: unknown) {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function updateMnemonic(request: Request, env: Env, user: User, noteId: string) {
  const body = await readJson<Record<string, unknown>>(request)
  const mnemonic = stringField(body.mnemonic) || null
  await env.DB.prepare('UPDATE vocabulary_notes SET mnemonic = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(mnemonic, new Date().toISOString(), noteId, user.id)
    .run()
  return json(await getNote(env, user, noteId))
}

async function practiceSession(request: Request | null, env: Env, user: User, deckId: string) {
  await deckRow(env, user, deckId)
  let focus = 'mixed'
  let limit = 8
  if (request && request.method === 'POST') {
    try {
      const body = await readJson<Record<string, unknown>>(request)
      focus = stringField(body.focus) || 'mixed'
      const requested = Number(body.limit ?? 8)
      if (Number.isFinite(requested) && requested > 0) limit = Math.round(requested)
    } catch {
      // GET /session has no body; empty POST is fine.
    }
  }

  // Always fill with non-due cards when the due queue is short so "practice again"
  // after a session still has cards (reviewed cards have future due dates).
  const rows = await loadSessionCardRows(env, user, deckId, limit, {
    includeNotDue: focus !== 'due-only',
  })
  // Prefer single-word cues for the studio practice loop.
  const items = rows
    .map(serializeCard)
    .filter((card) => {
      const target = String(card.productionTarget || card.cue || '').trim()
      return target.length > 0 && target.split(/\s+/).length <= 2
    })

  return json({
    id: crypto.randomUUID(),
    deckId,
    focus,
    deck: await deckSummary(env, user, deckId),
    items,
    // Back-compat for older clients that read `cards`.
    cards: items,
  })
}

async function cardContext(_request: Request, env: Env, user: User, cardId: string) {
  const row = await getCardWithNote(env, user, cardId)
  const card = serializeCard(row)
  const term = String(card.productionTarget || card.cue || row.front || '')
  const definition = String(
    card.answer
    || row.back
    || row.explanation
    || row.extra
    || `A word from your reading: ${term}`,
  )
  const metadata = safeJsonObject(row.metadata_json)
  const metadataContext = metadata && typeof metadata.context === 'string' ? metadata.context : ''
  const contextParagraph = String(
    row.example_sentence
    || metadataContext
    || `${term} — ${definition}`,
  )
  return json({
    source: 'note',
    term,
    pronunciation: card.pronunciation,
    definition,
    contextTitle: String(row.source_book_title || row.topic || 'Reader Vocabulary'),
    contextParagraph,
    usageFocus: [
      `Use "${term}" in a short sentence from your reading.`,
      `Explain "${term}" in plain words.`,
    ],
    practicePrompts: [
      `What does ${term} mean here?`,
      `Write one original sentence with ${term}.`,
    ],
  })
}

async function cardCoach(request: Request, env: Env, user: User, cardId: string) {
  const row = await getCardWithNote(env, user, cardId)
  const card = serializeCard(row)
  const body = await readJson<Record<string, unknown>>(request)
  const learner = stringField(body.learnerResponse) || stringField(body.user_input) || ''
  const target = String(card.answer || row.back || row.explanation || card.cue)
  const { verdict, score } = heuristicVerdict(learner, target)
  const suggestedRating = verdict === 'correct' ? 'good' : verdict === 'partial' ? 'hard' : 'again'
  return json({
    provider: 'local-heuristic',
    verdict: verdict === 'partial' ? 'close' : verdict,
    feedbackTitle: verdict === 'correct'
      ? 'Nice work'
      : verdict === 'partial'
        ? 'Close'
        : 'Not quite',
    feedbackBody: verdict === 'correct'
      ? `That matches the idea of “${target}”.`
      : verdict === 'partial'
        ? `You’re partly there. Aim for: “${target}”.`
        : `Remember: “${target}”.`,
    correction: target,
    nextPrompt: `Try using “${card.productionTarget || card.cue}” in a fresh sentence.`,
    suggestedRating,
    canRate: true,
    turnCount: Number(body.turnIndex ?? 1) || 1,
    score,
  })
}

async function cardProduction(request: Request, env: Env, user: User, cardId: string) {
  const row = await getCardWithNote(env, user, cardId)
  const card = serializeCard(row)
  const body = await readJson<Record<string, unknown>>(request)
  const sentences = Array.isArray(body.sentences)
    ? body.sentences.map((s) => String(s ?? '').trim()).filter(Boolean)
    : []
  const target = String(card.productionTarget || card.cue || '').toLowerCase()
  const stem = target.slice(0, Math.max(3, Math.min(5, target.length)))
  const notes = sentences.map((sentence) => {
    const lower = sentence.toLowerCase()
    const usesWord = Boolean(target) && (lower.includes(target) || (stem.length >= 3 && lower.includes(stem)))
    const longEnough = sentence.split(/\s+/).filter(Boolean).length >= 4
    const accepted = usesWord && longEnough
    return {
      sentence,
      accepted,
      note: accepted
        ? 'Looks good.'
        : !usesWord
          ? `Include the word “${card.productionTarget || card.cue}”.`
          : 'Make the sentence a bit longer.',
    }
  })
  const accepted = notes.length >= 1 && notes.every((n) => n.accepted)
  return json({
    cardId,
    accepted,
    provider: 'local-heuristic',
    feedback: accepted
      ? 'Solid production set.'
      : 'Some sentences need the target word or more detail.',
    sentenceNotes: notes,
    productionCount: notes.length,
    sentences,
  })
}

async function aiVocabCheck(request: Request) {
  const body = await readJson<Record<string, unknown>>(request)
  const mode = stringField(body.mode) || 'definition'
  const word = stringField(body.word)
  const definition = stringField(body.definition)
  const userInput = stringField(body.user_input) || stringField(body.userInput) || ''
  const target = mode === 'mnemonic' ? `${word} ${definition}` : definition || word
  const { verdict } = heuristicVerdict(userInput, target)
  return json({
    verdict,
    feedback: verdict === 'correct'
      ? 'That works well.'
      : verdict === 'partial'
        ? 'Close — add a bit more precision.'
        : `Focus on: ${definition || word}`,
    suggestion: definition || null,
  })
}

// ── Reader AI (Gemini) ───────────────────────────────────────────────────────

function configuredGeminiChatModel(env: Env) {
  const configured = env.GEMINI_CHAT_MODEL?.trim()
  if (configured) return configured
  // Prefer a free-tier-friendly text model — TTS model ids are not valid for chat.
  return GEMINI_CHAT_DEFAULT_MODEL
}

function geminiChatModelCandidates(env: Env): string[] {
  const primary = configuredGeminiChatModel(env)
  // Keep this list to models that support generateContent on v1beta.
  const fallbacks = [
    primary,
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.5-flash',
    'gemini-1.5-flash',
  ]
  return [...new Set(fallbacks.filter(Boolean))]
}

type GeminiChatTurn = { role: 'user' | 'model'; parts: Array<{ text: string }> }

function sseData(payload: Record<string, unknown> | string) {
  if (typeof payload === 'string') return `data: ${payload}\n\n`
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sseResponse(stream: ReadableStream<Uint8Array>, status = 200) {
  return new Response(stream, {
    status,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

function chunkTextForSse(text: string, maxChunk = 48): string[] {
  if (!text) return []
  const chunks: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(text.length, i + maxChunk)
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end)
      if (space > i + 12) end = space + 1
    }
    chunks.push(text.slice(i, end))
    i = end
  }
  return chunks
}

async function geminiGenerateText(
  env: Env,
  options: {
    system: string
    contents: GeminiChatTurn[]
    maxOutputTokens?: number
    temperature?: number
  },
): Promise<string> {
  const apiKey = env.GEMINI_API_KEY?.trim()
  if (!apiKey) {
    throw new ApiError(
      503,
      'AI is not configured yet. Add GEMINI_API_KEY to the Cloudflare Worker secrets.',
    )
  }

  let lastError: ApiError | null = null
  for (const model of geminiChatModelCandidates(env)) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: options.system }],
          },
          contents: options.contents,
          generationConfig: {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.maxOutputTokens ?? 700,
          },
        }),
      },
    )

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText)
      const status = response.status === 429
        ? 429
        : response.status >= 500
          ? 502
          : 400
      lastError = new ApiError(
        status,
        status === 429
          ? 'Gemini quota exceeded for this API key. Wait a bit, enable billing, or set GEMINI_CHAT_MODEL to another free-tier model.'
          : `Gemini chat failed (${response.status}): ${detail.slice(0, 400)}`,
      )
      // Try next model on rate limit / not found.
      if (response.status === 429 || response.status === 404) continue
      throw lastError
    }

    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    const text = (payload.candidates ?? [])
      .flatMap((c) => c.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim()

    if (!text) {
      lastError = new ApiError(502, 'Gemini returned an empty reply.')
      continue
    }
    return text
  }

  throw lastError ?? new ApiError(502, 'Gemini chat failed.')
}

/** Offline extractive fallback so the assistant still answers when Gemini is rate-limited. */
function localReadingFallback(options: {
  bookTitle: string
  pageContext: string
  question: string
}): string {
  const passage = options.pageContext.replace(/\s+/g, ' ').trim()
  const q = options.question.toLowerCase()
  const sentences = passage
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30)
    .slice(0, 8)

  if (/theme|main idea|about/.test(q)) {
    const sample = sentences.slice(0, 3).join(' ')
    return (
      `From the passage of “${options.bookTitle}” currently on screen, the text focuses on craft, storytelling, and what makes a story land with an audience. `
      + (sample
        ? `Key lines include: ${sample.slice(0, 320)}${sample.length > 320 ? '…' : ''}`
        : 'Scroll or select more of the page for a richer local summary while Gemini is unavailable.')
      + '\n\n(Local preview — Gemini quota is temporarily exceeded.)'
    )
  }

  if (/summar|just read|recap/.test(q)) {
    const summary = sentences.slice(0, 4).join(' ')
    return (
      (summary
        ? `Here’s a tight recap of the text near your place in “${options.bookTitle}”:\n\n${summary.slice(0, 700)}${summary.length > 700 ? '…' : ''}`
        : `I don’t have enough page text yet to summarize “${options.bookTitle}”. Scroll a bit and ask again.`)
      + '\n\n(Local preview — Gemini quota is temporarily exceeded.)'
    )
  }

  if (/character|who are|people/.test(q)) {
    return (
      `Based on the visible passage of “${options.bookTitle}”, names and roles are only clear if they appear on this page. `
      + `Scan the current text for proper names and repeated roles; ask again with a character name for a closer read.`
      + '\n\n(Local preview — Gemini quota is temporarily exceeded.)'
    )
  }

  if (/context|passage|explain|mean/.test(q)) {
    const sample = sentences[0] || passage.slice(0, 280)
    return (
      `This part of “${options.bookTitle}” sits in the section you’re reading now. `
      + (sample ? `It opens with: “${sample.slice(0, 240)}${sample.length > 240 ? '…' : ''}” ` : '')
      + 'Use Ask AI on a highlighted sentence for a tighter explanation once Gemini is available again.'
      + '\n\n(Local preview — Gemini quota is temporarily exceeded.)'
    )
  }

  const sample = sentences.slice(0, 2).join(' ') || passage.slice(0, 240)
  return (
    `I’m temporarily using a local reading helper for “${options.bookTitle}” because the Gemini quota is exhausted. `
    + (sample ? `From your current page: ${sample.slice(0, 360)}${sample.length > 360 ? '…' : ''}` : 'Provide more page text and try again.')
  )
}

function streamTextAsSse(fullText: string) {
  const chunks = chunkTextForSse(fullText)
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.enqueue(encoder.encode(sseData('[DONE]')))
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(sseData({ delta: chunks[index] })))
      index += 1
    },
  })
}

function parseChatMessages(raw: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const role = stringField(row.role)
    const content = stringField(row.content)
    if (!content) continue
    if (role === 'user' || role === 'assistant') out.push({ role, content })
  }
  return out.slice(-16)
}

function toGeminiContents(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  preamble?: Array<{ role: 'user' | 'model'; text: string }>,
): GeminiChatTurn[] {
  const contents: GeminiChatTurn[] = []
  for (const p of preamble ?? []) {
    contents.push({ role: p.role, parts: [{ text: p.text }] })
  }
  for (const m of messages) {
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })
  }
  // Gemini requires the conversation to end with a user turn.
  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: [{ text: 'Please continue.' }] })
  }
  // Merge consecutive same-role turns (API is picky about alternation).
  const merged: GeminiChatTurn[] = []
  for (const turn of contents) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === turn.role) {
      prev.parts[0].text = `${prev.parts[0].text}\n\n${turn.parts[0].text}`
    } else {
      merged.push({ role: turn.role, parts: [{ text: turn.parts[0].text }] })
    }
  }
  // Ensure it starts with user
  if (merged[0]?.role === 'model') {
    merged.unshift({ role: 'user', parts: [{ text: 'Hello.' }] })
  }
  return merged
}

async function aiReaderChat(request: Request, env: Env) {
  const body = await readJson<Record<string, unknown>>(request)
  const bookTitle = stringField(body.book_title) || stringField(body.bookTitle) || 'this book'
  const pageContext = stringField(body.page_context) || stringField(body.pageContext) || ''
  const messages = parseChatMessages(body.messages)

  const system = (
    `You are a reading assistant helping someone read "${bookTitle}". `
    + 'Answer questions about the text, themes, characters, vocabulary, and ideas. '
    + 'Be concise — 2–5 short sentences unless more depth is clearly needed. '
    + 'Ground answers in the provided passage when relevant. '
    + 'If the question is unrelated to reading or the book, gently redirect.'
  )

  const preamble: Array<{ role: 'user' | 'model'; text: string }> = []
  if (pageContext.trim()) {
    preamble.push({
      role: 'user',
      text: `Here is the passage I'm currently reading from "${bookTitle}":\n\n${pageContext.slice(0, 4500)}`,
    })
    preamble.push({
      role: 'model',
      text: 'Got it — I can see the passage you are reading. What would you like to know?',
    })
  }

  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content
    || 'Summarize what I just read'

  try {
    const text = await geminiGenerateText(env, {
      system,
      contents: toGeminiContents(messages, preamble),
      maxOutputTokens: 700,
      temperature: 0.7,
    })
    return sseResponse(streamTextAsSse(text))
  } catch (err) {
    // Always keep the assistant usable — fall back locally on Gemini outages/quota.
    if (err instanceof ApiError && (err.status === 429 || err.status === 502 || err.status === 404 || err.status === 400)) {
      const fallback = localReadingFallback({
        bookTitle,
        pageContext,
        question: lastUser,
      })
      return sseResponse(streamTextAsSse(fallback))
    }
    if (err instanceof ApiError) {
      return json({ detail: err.message }, err.status)
    }
    const fallback = localReadingFallback({
      bookTitle,
      pageContext,
      question: lastUser,
    })
    return sseResponse(streamTextAsSse(fallback))
  }
}

async function aiAskPassage(request: Request, env: Env) {
  const body = await readJson<Record<string, unknown>>(request)
  const text = stringField(body.text)
  if (!text) throw new ApiError(400, 'Highlighted text is required.')
  const context = stringField(body.context)
  const mode = stringField(body.mode) || 'explain'
  const targetLanguage = stringField(body.target_language) || stringField(body.targetLanguage) || 'Spanish'
  const messages = parseChatMessages(body.messages)

  if (mode === 'translate') {
    try {
      const translated = await geminiGenerateText(env, {
        system: (
          `You are a literary translator. Translate the given text into ${targetLanguage}. `
          + 'Output only the translation — no explanation, no preamble, no quotation marks.'
        ),
        contents: [{ role: 'user', parts: [{ text }] }],
        maxOutputTokens: 800,
        temperature: 0.3,
      })
      return sseResponse(streamTextAsSse(translated))
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        return sseResponse(streamTextAsSse(
          `[Translation unavailable — Gemini quota exceeded.]\n\nOriginal:\n${text.slice(0, 1200)}`,
        ))
      }
      if (err instanceof ApiError) return json({ detail: err.message }, err.status)
      return json({ detail: 'Translation failed.' }, 500)
    }
  }

  const system = (
    'You are a reading assistant embedded in a book reader app. '
    + 'The reader has highlighted a passage and you are having a conversation about it. '
    + 'Be concise, insightful, and literary. '
    + 'Keep replies focused — 2–4 sentences unless the question clearly needs more.'
  )

  let passageIntro = `The reader highlighted:\n\n"${text.slice(0, 3000)}"`
  if (context) passageIntro += `\n\nSurrounding text:\n${context.slice(0, 2000)}`

  const preamble: Array<{ role: 'user' | 'model'; text: string }> = [
    {
      role: 'user',
      text: `${passageIntro}\n\nExplain this passage clearly and concisely.`,
    },
  ]
  if (messages.length > 0) {
    preamble.push({
      role: 'model',
      text: 'Happy to discuss this passage. What would you like to explore?',
    })
  }

  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content
    || 'Explain this passage clearly and concisely.'

  try {
    const reply = await geminiGenerateText(env, {
      system,
      contents: toGeminiContents(messages, preamble),
      maxOutputTokens: 700,
      temperature: 0.7,
    })
    return sseResponse(streamTextAsSse(reply))
  } catch (err) {
    if (err instanceof ApiError && (err.status === 429 || err.status === 502 || err.status === 404 || err.status === 400)) {
      const fallback = localReadingFallback({
        bookTitle: 'this passage',
        pageContext: `${text}\n\n${context}`,
        question: lastUser,
      })
      return sseResponse(streamTextAsSse(fallback))
    }
    if (err instanceof ApiError) return json({ detail: err.message }, err.status)
    const fallback = localReadingFallback({
      bookTitle: 'this passage',
      pageContext: `${text}\n\n${context}`,
      question: lastUser,
    })
    return sseResponse(streamTextAsSse(fallback))
  }
}

function xpForRating(rating: string) {
  if (rating === 'easy') return 20
  if (rating === 'good') return 15
  if (rating === 'hard') return 10
  if (rating === 'again') return 5
  return 10
}

async function ensureLearningEventsTable(env: Env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS learning_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      xp_delta INTEGER NOT NULL DEFAULT 0,
      book_id TEXT,
      deck_id TEXT,
      card_id TEXT,
      label TEXT NOT NULL DEFAULT '',
      detail TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
  ).run()
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS learning_events_user_created_idx
     ON learning_events (user_id, created_at DESC)`,
  ).run()
}

function utcDayString(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

function addUtcDays(day: string, delta: number) {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + delta)
  return utcDayString(dt)
}

async function recordReviewEvent(
  env: Env,
  user: User,
  input: {
    cardId: string
    deckId: string
    rating: string
    xp: number
    cue?: string
  },
) {
  await ensureLearningEventsTable(env)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO learning_events
     (id, user_id, event_type, xp_delta, book_id, deck_id, card_id, label, detail, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    user.id,
    'review',
    input.xp,
    null,
    input.deckId,
    input.cardId,
    input.cue || 'card review',
    `rating:${input.rating}`,
    JSON.stringify({ rating: input.rating, xp: input.xp }),
    now,
  ).run()
}

async function learningSummary(env: Env, user: User) {
  await ensureLearningEventsTable(env)
  const now = new Date()
  const today = utcDayString(now)
  const startOfToday = `${today}T00:00:00.000Z`
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString()
  const dailyGoal = 20

  const xpTodayRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(xp_delta), 0) AS xp
     FROM learning_events
     WHERE user_id = ? AND created_at >= ?`,
  ).bind(user.id, startOfToday).first<{ xp: number }>()

  const xpWeekRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(xp_delta), 0) AS xp
     FROM learning_events
     WHERE user_id = ? AND created_at >= ?`,
  ).bind(user.id, weekAgo).first<{ xp: number }>()

  const reviewsTodayRow = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM learning_events
     WHERE user_id = ? AND event_type = 'review' AND created_at >= ?`,
  ).bind(user.id, startOfToday).first<{ count: number }>()

  const dayRows = await env.DB.prepare(
    `SELECT DISTINCT substr(created_at, 1, 10) AS day
     FROM learning_events
     WHERE user_id = ? AND event_type = 'review'
     ORDER BY day DESC
     LIMIT 400`,
  ).bind(user.id).all<{ day: string }>()

  const activeDays = new Set((dayRows.results ?? []).map((r) => r.day))
  let streakDays = 0
  // Streak can still count if the user practiced yesterday but not yet today.
  let cursor = activeDays.has(today) ? today : addUtcDays(today, -1)
  while (activeDays.has(cursor)) {
    streakDays += 1
    cursor = addUtcDays(cursor, -1)
  }

  const reviewsToday = Number(reviewsTodayRow?.count ?? 0)
  const xpToday = Number(xpTodayRow?.xp ?? 0)
  const xpThisWeek = Number(xpWeekRow?.xp ?? 0)

  return json({
    streakDays,
    xpToday,
    xpThisWeek,
    dailyGoal,
    dailyGoalProgress: Math.min(1, reviewsToday / dailyGoal),
    reviewsToday,
  })
}

async function reviewCard(request: Request, env: Env, user: User, cardId: string) {
  const body = await readJson<Record<string, unknown>>(request)
  const rating = stringField(body.rating) || 'good'
  const now = new Date()
  const nextMs = rating === 'again'
    ? 5 * 60_000
    : rating === 'hard'
      ? 30 * 60_000
      : rating === 'easy'
        ? 4 * 24 * 60 * 60_000
        : 24 * 60 * 60_000
  const next = new Date(now.getTime() + nextMs).toISOString()
  const state = rating === 'again' || rating === 'hard' ? 'learning' : 'review'
  await env.DB.prepare(
    `UPDATE vocabulary_cards
     SET state = ?, due_at = ?, reps = reps + 1, lapses = lapses + ?, scheduled_days = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).bind(state, next, rating === 'again' ? 1 : 0, Math.max(0, Math.round(nextMs / 86_400_000)), now.toISOString(), cardId, user.id).run()
  const card = await getCardWithNote(env, user, cardId)
  const xp = xpForRating(rating)
  try {
    await recordReviewEvent(env, user, {
      cardId,
      deckId: String(card.deck_id),
      rating,
      xp,
      cue: String(card.cue ?? card.front ?? ''),
    })
  } catch (err) {
    // XP logging should not block the review itself.
    console.error('Failed to record learning event', err)
  }
  const summary = await deckSummary(env, user, String(card.deck_id))
  const serialized = serializeCard(card)
  return json({
    card: serialized,
    nextCard: serialized,
    summary,
    xpAwarded: xp,
    rating,
  })
}

async function providers(env: Env) {
  const geminiConfigured = Boolean(env.GEMINI_API_KEY?.trim())
  const kokoroConfigured = kokoroRemoteConfigured(env)
  return json({
    defaultNarrationStyle: 'warm',
    defaultProvider: 'kokoro',
    providers: [
      {
        id: 'kokoro',
        name: 'Kokoro',
        available: kokoroConfigured,
        recommended: true,
        voices: KOKORO_VOICES,
        defaultVoice: KOKORO_DEFAULT_VOICE,
        description: kokoroConfigured
          ? 'Default neural TTS with edge/R2 audio cache (hosted Kokoro).'
          : 'Set KOKORO_REMOTE_URL on the Worker to enable hosted Kokoro (see docs/hosted-kokoro.md).',
      },
      {
        id: 'google',
        name: 'Gemini TTS',
        available: geminiConfigured,
        recommended: false,
        voices: GEMINI_VOICES,
        defaultVoice: 'Kore',
        models: GEMINI_TTS_MODELS,
        defaultModel: configuredGeminiModel(env, null),
        description: geminiConfigured
          ? 'Cloud Gemini TTS for higher quality narrated chunks.'
          : 'Add GEMINI_API_KEY as a Cloudflare Worker secret to enable Gemini TTS.',
      },
    ],
  })
}

function dictionaryTermVariants(term: string): string[] {
  const base = term.trim().toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')
  if (!base) return []
  const out: string[] = [base]
  const push = (v: string) => {
    const t = v.trim().toLowerCase()
    if (t && t.length >= 2 && !out.includes(t)) out.push(t)
  }
  // possessives / trailing punctuation already stripped
  if (base.endsWith("'s") || base.endsWith("’s")) push(base.slice(0, -2))
  if (base.endsWith('ies') && base.length > 4) push(`${base.slice(0, -3)}y`)
  if (base.endsWith('ves') && base.length > 4) push(`${base.slice(0, -3)}f`)
  if (base.endsWith('ing') && base.length > 5) {
    push(base.slice(0, -3))
    push(`${base.slice(0, -3)}e`)
  }
  if (base.endsWith('ed') && base.length > 4) {
    push(base.slice(0, -2))
    push(`${base.slice(0, -1)}`) // loved -> love
    push(base.slice(0, -2))
  }
  if (base.endsWith('es') && base.length > 3) push(base.slice(0, -2))
  if (base.endsWith('s') && !base.endsWith('ss') && base.length > 3) push(base.slice(0, -1))
  if (base.endsWith('ly') && base.length > 4) push(base.slice(0, -2))
  return out
}

function normalizeFreeDictionaryJson(raw: unknown, term: string) {
  const rows = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : [])
  const first = rows[0] as Record<string, unknown> | undefined
  if (!first) {
    return {
      term,
      available: false,
      message: 'No definition found.',
      pronunciation: null as string | null,
      entries: [] as Array<Record<string, unknown>>,
      relatedTerms: [] as string[],
      source: 'none',
    }
  }

  const meanings = Array.isArray(first.meanings) ? first.meanings as Array<Record<string, unknown>> : []
  const phonetics = Array.isArray(first.phonetics) ? first.phonetics as Array<Record<string, unknown>> : []
  const phoneticText = stringField(first.phonetic)
    || phonetics.map((p) => stringField(p.text)).find(Boolean)
    || null

  const entries = meanings.slice(0, 6).map((m) => {
    const defs = Array.isArray(m.definitions) ? m.definitions as Array<Record<string, unknown>> : []
    const meaningSynonyms = Array.isArray(m.synonyms) ? m.synonyms.map(String) : []
    return {
      partOfSpeech: stringField(m.partOfSpeech) || '',
      definitions: defs.slice(0, 5).map((d) => ({
        definition: stringField(d.definition),
        examples: stringField(d.example) ? [stringField(d.example)] : [],
        synonyms: [
          ...(Array.isArray(d.synonyms) ? d.synonyms.map(String) : []),
          ...meaningSynonyms,
        ].filter(Boolean).slice(0, 8),
      })).filter((d) => d.definition),
    }
  }).filter((e) => e.definitions.length > 0)

  return {
    term: stringField(first.word) || term,
    available: entries.length > 0,
    message: entries.length > 0 ? null : 'No definition found.',
    pronunciation: phoneticText,
    entries,
    relatedTerms: [] as string[],
    source: 'online',
  }
}

async function fetchFreeDictionaryNormalized(term: string) {
  const upstream = await fetch(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(term)}`,
    { signal: AbortSignal.timeout(7000) },
  )
  if (!upstream.ok) return null
  const raw = await upstream.json().catch(() => null)
  const normalized = normalizeFreeDictionaryJson(raw, term)
  return normalized.available ? normalized : null
}

async function geminiDefineWord(env: Env, term: string) {
  if (!env.GEMINI_API_KEY?.trim()) return null
  try {
    const text = await geminiGenerateText(env, {
      system: (
        'You are a concise English dictionary. '
        + 'Given a headword, reply with plain text only in this exact format:\n'
        + 'POS: <part of speech>\n'
        + 'DEF: <one clear definition, max 28 words>\n'
        + 'DEF2: <optional second sense, or NONE>\n'
        + 'EX: <short example sentence using the word, or NONE>\n'
        + 'Do not add any other lines.'
      ),
      contents: [{ role: 'user', parts: [{ text: `Define the English word: ${term}` }] }],
      maxOutputTokens: 220,
      temperature: 0.2,
    })
    const pos = text.match(/^POS:\s*(.+)$/im)?.[1]?.trim() || 'word'
    const def1 = text.match(/^DEF:\s*(.+)$/im)?.[1]?.trim()
    const def2Raw = text.match(/^DEF2:\s*(.+)$/im)?.[1]?.trim()
    const exRaw = text.match(/^EX:\s*(.+)$/im)?.[1]?.trim()
    const defs = [def1, def2Raw && def2Raw.toUpperCase() !== 'NONE' ? def2Raw : null]
      .filter((d): d is string => Boolean(d && d.length > 3 && d.toUpperCase() !== 'NONE'))
    if (defs.length === 0) return null
    const example = exRaw && exRaw.toUpperCase() !== 'NONE' ? [exRaw] : []
    return {
      term,
      available: true,
      message: null as string | null,
      pronunciation: null as string | null,
      entries: [{
        partOfSpeech: pos,
        definitions: defs.map((definition, i) => ({
          definition,
          examples: i === 0 ? example : [],
          synonyms: [] as string[],
        })),
      }],
      relatedTerms: [] as string[],
      source: 'gemini',
    }
  } catch {
    return null
  }
}

async function dictionaryLookup(url: URL, env: Env) {
  const term = url.searchParams.get('term')?.trim()
  if (!term) throw new ApiError(400, 'Dictionary term is required.')
  const variants = dictionaryTermVariants(term)
  if (variants.length === 0) {
    return json({
      term,
      available: false,
      message: 'No definition found.',
      pronunciation: null,
      entries: [],
      relatedTerms: [],
      source: 'none',
    })
  }

  for (const candidate of variants) {
    try {
      const hit = await fetchFreeDictionaryNormalized(candidate)
      if (hit) return json(hit)
    } catch {
      // try next variant / fallback
    }
  }

  // Last resort: Gemini so uncommon / missing Free Dictionary terms still define.
  const gemini = await geminiDefineWord(env, variants[0])
  if (gemini) return json(gemini)

  return json({
    term: variants[0],
    available: false,
    message: 'No definition found.',
    pronunciation: null,
    entries: [],
    relatedTerms: [],
    source: 'none',
  })
}
