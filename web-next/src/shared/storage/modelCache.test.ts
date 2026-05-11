// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Re-import the module fresh in each test so the module-level singleton
// (worker handle, state, listeners) doesn't leak between cases.

type WorkerMessage = unknown
type Listener = (event: MessageEvent<WorkerMessage>) => void

class MockWorker {
  static instances: MockWorker[] = []

  posted: WorkerMessage[] = []
  terminated = false
  private messageListeners: Listener[] = []
  private errorListeners: Array<(event: { message: string }) => void> = []

  constructor(_url: URL | string, _options?: { type?: string; name?: string }) {
    MockWorker.instances.push(this)
  }

  postMessage(message: WorkerMessage) {
    this.posted.push(message)
  }

  terminate() {
    this.terminated = true
  }

  addEventListener(type: 'message' | 'error', cb: unknown) {
    if (type === 'message') this.messageListeners.push(cb as Listener)
    if (type === 'error') this.errorListeners.push(cb as (event: { message: string }) => void)
  }

  // Test helpers
  emit(message: WorkerMessage) {
    const event = { data: message } as MessageEvent<WorkerMessage>
    for (const cb of this.messageListeners) cb(event)
  }

  emitError(message: string) {
    for (const cb of this.errorListeners) cb({ message })
  }
}

class MockBroadcastChannel {
  posted: unknown[] = []
  constructor(_name: string) { void _name }
  postMessage(msg: unknown) { this.posted.push(msg) }
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  MockWorker.instances = []
  vi.stubGlobal('Worker', MockWorker as unknown as typeof Worker)
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel as unknown as typeof BroadcastChannel)
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadModule() {
  return await import('./modelCache')
}

describe('modelCache state machine', () => {
  it('starts in idle state', async () => {
    const mc = await loadModule()
    expect(mc.getModelStatus()).toEqual({ status: 'idle', progress: 0, error: null })
    expect(mc.isModelReady()).toBe(false)
  })

  it('startWarmup spawns the worker and transitions to downloading', async () => {
    const mc = await loadModule()
    mc.startWarmup()

    expect(MockWorker.instances).toHaveLength(1)
    const w = MockWorker.instances[0]
    expect(w.posted).toEqual([{ type: 'warmup' }])
    expect(mc.getModelStatus().status).toBe('downloading')
  })

  it('startWarmup is idempotent — second call does not spawn another worker', async () => {
    const mc = await loadModule()
    mc.startWarmup()
    mc.startWarmup()
    mc.startWarmup()
    expect(MockWorker.instances).toHaveLength(1)
  })

  it('progress messages update state', async () => {
    const mc = await loadModule()
    mc.startWarmup()
    const w = MockWorker.instances[0]

    w.emit({ type: 'progress', progress: 25 })
    expect(mc.getModelStatus()).toMatchObject({ status: 'downloading', progress: 25 })

    w.emit({ type: 'progress', progress: 70 })
    expect(mc.getModelStatus().progress).toBe(70)
  })

  it('progress never moves backwards (cross-tab safety)', async () => {
    const mc = await loadModule()
    mc.startWarmup()
    const w = MockWorker.instances[0]
    w.emit({ type: 'progress', progress: 90 })
    w.emit({ type: 'progress', progress: 5 })
    expect(mc.getModelStatus().progress).toBe(90)
  })

  it('ready message flips status and isModelReady becomes true', async () => {
    const mc = await loadModule()
    mc.startWarmup()
    MockWorker.instances[0].emit({ type: 'ready' })

    expect(mc.getModelStatus()).toEqual({ status: 'ready', progress: 100, error: null })
    expect(mc.isModelReady()).toBe(true)
  })

  it('warmup:error terminates the worker and allows retry on next startWarmup', async () => {
    const mc = await loadModule()
    mc.startWarmup()
    MockWorker.instances[0].emit({ type: 'warmup:error', message: 'boom' })

    expect(MockWorker.instances[0].terminated).toBe(true)
    expect(mc.getModelStatus()).toMatchObject({ status: 'error', error: 'boom' })

    // Retry path
    mc.startWarmup()
    expect(MockWorker.instances).toHaveLength(2)
    expect(mc.getModelStatus().status).toBe('downloading')
  })

  it('subscribers receive state updates and can unsubscribe', async () => {
    const mc = await loadModule()
    const updates: string[] = []
    const unsub = mc.subscribeModelStatus((s) => updates.push(s.status))

    mc.startWarmup()
    MockWorker.instances[0].emit({ type: 'progress', progress: 50 })
    MockWorker.instances[0].emit({ type: 'ready' })

    expect(updates).toEqual(['downloading', 'downloading', 'ready'])

    unsub()
    MockWorker.instances[0].emit({ type: 'progress', progress: 10 })
    // unchanged — unsubscribed
    expect(updates).toEqual(['downloading', 'downloading', 'ready'])
  })

  it('synthesizeLocal returns null when model is not ready', async () => {
    const mc = await loadModule()
    const result = await mc.synthesizeLocal('hello', 'af_heart', 1)
    expect(result).toBeNull()
  })

  it('synthesizeLocal posts message and resolves on matching result', async () => {
    const mc = await loadModule()
    mc.startWarmup()
    MockWorker.instances[0].emit({ type: 'ready' })

    const wavBuffer = new ArrayBuffer(64)
    const pending = mc.synthesizeLocal('hello', 'af_heart', 1.0)

    // Inspect the message the cache posted to the worker
    const lastMsg = MockWorker.instances[0].posted.at(-1) as { type: string; id: string; text: string; voice: string; speed: number }
    expect(lastMsg.type).toBe('synthesize')
    expect(lastMsg.text).toBe('hello')
    expect(lastMsg.voice).toBe('af_heart')
    expect(lastMsg.speed).toBe(1.0)

    // Simulate worker emitting the result
    MockWorker.instances[0].emit({
      type: 'result',
      id: lastMsg.id,
      wav: wavBuffer,
      sampleRate: 24000,
      durationSec: 0.7,
    })

    const result = await pending
    expect(result).not.toBeNull()
    expect(result?.sampleRate).toBe(24000)
    expect(result?.durationSec).toBeCloseTo(0.7)
    expect(result?.wav.byteLength).toBe(64)
  })

  it('synthesizeLocal swallows worker errors and returns null', async () => {
    const mc = await loadModule()
    mc.startWarmup()
    MockWorker.instances[0].emit({ type: 'ready' })

    const pending = mc.synthesizeLocal('boom', 'af_heart', 1.0)
    const lastMsg = MockWorker.instances[0].posted.at(-1) as { id: string }

    MockWorker.instances[0].emit({ type: 'error', id: lastMsg.id, message: 'synth failed' })

    const result = await pending
    expect(result).toBeNull()
  })

  it('multiple concurrent synthesizeLocal calls are correlated independently', async () => {
    const mc = await loadModule()
    mc.startWarmup()
    MockWorker.instances[0].emit({ type: 'ready' })

    const a = mc.synthesizeLocal('first', 'af_heart', 1.0)
    const b = mc.synthesizeLocal('second', 'af_heart', 1.0)

    const messages = MockWorker.instances[0].posted.filter(
      (m): m is { type: 'synthesize'; id: string; text: string } =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'synthesize',
    )
    expect(messages).toHaveLength(2)
    expect(messages[0].id).not.toBe(messages[1].id)

    // Reply in reverse order to prove correlation
    MockWorker.instances[0].emit({
      type: 'result', id: messages[1].id, wav: new ArrayBuffer(8), sampleRate: 24000, durationSec: 0.2,
    })
    MockWorker.instances[0].emit({
      type: 'result', id: messages[0].id, wav: new ArrayBuffer(16), sampleRate: 24000, durationSec: 0.4,
    })

    const resA = await a
    const resB = await b
    expect(resA?.wav.byteLength).toBe(16)
    expect(resB?.wav.byteLength).toBe(8)
  })
})
