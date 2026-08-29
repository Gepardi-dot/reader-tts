/**
 * Multi-layer Kokoro segment cache: memory ring + IndexedDB (via audioCache).
 *
 * Cache key = voice + speed + stable segment text hash + model version.
 * Hit path is the product "instant" path.
 */

import { decodeAudioDataSafe } from '@/lib/browser'
import { getCachedAudio, putCachedAudio } from '@/shared/storage/audioCache'
import {
  LOCAL_KOKORO_CACHE_VERSION,
  localKokoroCacheKey,
} from '@/shared/storage/modelCache'
import type { StableSegment } from './stableSegments'

export const SEGMENT_CACHE_VERSION = LOCAL_KOKORO_CACHE_VERSION

export interface SegmentAudio {
  segmentId: string
  buffer: AudioBuffer
  durationSec: number
  cacheHit: boolean
  cacheStorage: 'memory' | 'indexeddb' | 'generated'
}

interface MemoryEntry {
  key: string
  segmentId: string
  buffer: AudioBuffer
  durationSec: number
  lastAccess: number
}

const MEMORY_CAP = 64
const memory = new Map<string, MemoryEntry>()

export async function segmentCacheKey(
  voice: string,
  speed: number,
  segment: StableSegment,
): Promise<string> {
  // Reuse existing Kokoro text hash scheme so prepared audio stays compatible.
  return localKokoroCacheKey(voice, speed, segment.text)
}

export function getMemorySegment(key: string): SegmentAudio | null {
  const hit = memory.get(key)
  if (!hit) return null
  hit.lastAccess = Date.now()
  return {
    segmentId: hit.segmentId,
    buffer: hit.buffer,
    durationSec: hit.durationSec,
    cacheHit: true,
    cacheStorage: 'memory',
  }
}

export function putMemorySegment(
  key: string,
  segmentId: string,
  buffer: AudioBuffer,
  durationSec: number,
) {
  memory.set(key, {
    key,
    segmentId,
    buffer,
    durationSec,
    lastAccess: Date.now(),
  })
  trimMemory()
}

export async function getStoredSegment(
  key: string,
  ctx: AudioContext,
): Promise<SegmentAudio | null> {
  const mem = getMemorySegment(key)
  if (mem) return mem

  const hit = await getCachedAudio(key, SEGMENT_CACHE_VERSION).catch(() => null)
  if (!hit?.blob) return null

  const buffer = await decodeAudioDataSafe(ctx, hit.blob)
  const durationSec = hit.duration ?? buffer.duration
  putMemorySegment(key, key, buffer, durationSec) // segmentId filled by caller if needed
  return {
    segmentId: key,
    buffer,
    durationSec,
    cacheHit: true,
    cacheStorage: 'indexeddb',
  }
}

export async function putStoredSegment(input: {
  key: string
  segmentId: string
  buffer: AudioBuffer
  wav: ArrayBuffer
  durationSec: number
}) {
  putMemorySegment(input.key, input.segmentId, input.buffer, input.durationSec)
  const blob = new Blob([input.wav], { type: 'audio/wav' })
  await putCachedAudio({
    cacheKey: input.key,
    cacheVersion: SEGMENT_CACHE_VERSION,
    blob,
    cues: [],
    duration: input.durationSec,
    contentType: 'audio/wav',
    byteLength: blob.size,
  }).catch(() => undefined)
}

export function clearMemorySegmentCache() {
  memory.clear()
}

function trimMemory() {
  if (memory.size <= MEMORY_CAP) return
  const entries = [...memory.values()].sort((a, b) => a.lastAccess - b.lastAccess)
  const drop = entries.slice(0, memory.size - MEMORY_CAP)
  for (const entry of drop) memory.delete(entry.key)
}
