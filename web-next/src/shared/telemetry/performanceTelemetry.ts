import { request } from '@/shared/api/client'

export interface PerformanceTelemetryEvent {
  eventName: string
  bookId?: string | null
  provider?: string | null
  durationMs?: number | null
  value?: number | null
  cacheHit?: boolean | null
  cacheStorage?: string | null
  metadata?: Record<string, string | number | boolean | null>
}

type TelemetrySender = (events: PerformanceTelemetryEvent[]) => Promise<void>

const TELEMETRY_QUEUE_LIMIT = 60
const TELEMETRY_BATCH_SIZE = 12
const TELEMETRY_FLUSH_DELAY_MS = 1200

let queue: PerformanceTelemetryEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushPromise: Promise<void> | null = null
let sender: TelemetrySender = sendTelemetryBatch

function boundedString(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

export function performanceNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

export function elapsedMs(startMs: number, endMs = performanceNow()) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return Math.max(0, Math.round(endMs - startMs))
}

function normalizeMetadata(metadata: PerformanceTelemetryEvent['metadata']) {
  if (!metadata) return undefined
  const clean: NonNullable<PerformanceTelemetryEvent['metadata']> = {}
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = boundedString(rawKey, 48)
    if (!key) continue
    if (typeof rawValue === 'string') clean[key] = rawValue.slice(0, 240)
    else if (typeof rawValue === 'number') clean[key] = Number.isFinite(rawValue) ? rawValue : null
    else if (typeof rawValue === 'boolean' || rawValue == null) clean[key] = rawValue
  }
  return Object.keys(clean).length ? clean : undefined
}

export function normalizePerformanceTelemetryEvent(
  event: PerformanceTelemetryEvent,
): PerformanceTelemetryEvent | null {
  const eventName = boundedString(event.eventName, 80)
  if (!/^[a-z][a-z0-9_.:-]{1,79}$/i.test(eventName)) return null

  const normalized: PerformanceTelemetryEvent = { eventName }
  const bookId = boundedString(event.bookId, 80)
  const provider = boundedString(event.provider, 48)
  const cacheStorage = boundedString(event.cacheStorage, 48)
  const metadata = normalizeMetadata(event.metadata)
  if (bookId) normalized.bookId = bookId
  if (provider) normalized.provider = provider
  if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)) {
    normalized.durationMs = Math.max(0, Math.round(event.durationMs))
  }
  if (typeof event.value === 'number' && Number.isFinite(event.value)) normalized.value = event.value
  if (typeof event.cacheHit === 'boolean') normalized.cacheHit = event.cacheHit
  if (cacheStorage) normalized.cacheStorage = cacheStorage
  if (metadata) normalized.metadata = metadata
  return normalized
}

async function sendTelemetryBatch(events: PerformanceTelemetryEvent[]) {
  await request('/api/telemetry', {
    method: 'POST',
    body: JSON.stringify({ events }),
  })
}

function scheduleTelemetryFlush() {
  if (flushTimer || queue.length === 0) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPerformanceTelemetry()
  }, TELEMETRY_FLUSH_DELAY_MS)
}

export function queuePerformanceTelemetry(event: PerformanceTelemetryEvent) {
  const normalized = normalizePerformanceTelemetryEvent(event)
  if (!normalized) return
  queue.push(normalized)
  while (queue.length > TELEMETRY_QUEUE_LIMIT) queue.shift()
  scheduleTelemetryFlush()
}

export async function flushPerformanceTelemetry() {
  if (flushPromise) return flushPromise
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!queue.length) return

  const batch = queue.splice(0, TELEMETRY_BATCH_SIZE)
  flushPromise = sender(batch)
    .catch(() => undefined)
    .finally(() => {
      flushPromise = null
      scheduleTelemetryFlush()
    })
  return flushPromise
}

export function pendingPerformanceTelemetryCount() {
  return queue.length
}

export function setPerformanceTelemetrySenderForTests(nextSender: TelemetrySender | null) {
  sender = nextSender ?? sendTelemetryBatch
}

export function resetPerformanceTelemetryForTests() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  flushPromise = null
  queue = []
  sender = sendTelemetryBatch
}
