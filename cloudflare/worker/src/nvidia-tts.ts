/**
 * Natural Voices: NVIDIA Riva Chatterbox over gRPC.
 * Cloudflare fetch cannot speak HTTP/2 trailers, so synthesis uses a raw TLS socket.
 * Add another free NVIDIA model by appending its function id to NVIDIA_MODELS.
 */
import {
  NVIDIA_SAMPLE_RATE,
  languageCodeForNvidiaVoice,
  pcmToWav,
  splitNvidiaText,
  synthesizeNvidiaPcm,
} from './nvidia-grpc.mjs'

export { NVIDIA_SAMPLE_RATE }

const NVIDIA_HOST = 'grpc.nvcf.nvidia.com'
const NVIDIA_DEFAULT_VOICE = 'Chatterbox-Multilingual.en-US.Male'
const NVIDIA_CALL_TIMEOUT_MS = 28_000

export const NVIDIA_VOICES = [
  { id: 'Chatterbox-Multilingual.en-US.Male', label: 'English (US)' },
  { id: 'Chatterbox-Multilingual.ar-SA.Male', label: 'Arabic' },
  { id: 'Chatterbox-Multilingual.zh-CN.Male', label: 'Chinese' },
  { id: 'Chatterbox-Multilingual.da-DK.Male', label: 'Danish' },
  { id: 'Chatterbox-Multilingual.nl-NL.Male', label: 'Dutch' },
  { id: 'Chatterbox-Multilingual.fi-FI.Male', label: 'Finnish' },
  { id: 'Chatterbox-Multilingual.fr-FR.Male', label: 'French' },
  { id: 'Chatterbox-Multilingual.de-DE.Male', label: 'German' },
  { id: 'Chatterbox-Multilingual.el-GR.Male', label: 'Greek' },
  { id: 'Chatterbox-Multilingual.he-IL.Male', label: 'Hebrew' },
  { id: 'Chatterbox-Multilingual.hi-IN.Male', label: 'Hindi' },
  { id: 'Chatterbox-Multilingual.it-IT.Male', label: 'Italian' },
  { id: 'Chatterbox-Multilingual.ja-JP.Male', label: 'Japanese' },
  { id: 'Chatterbox-Multilingual.ko-KR.Male', label: 'Korean' },
  { id: 'Chatterbox-Multilingual.ms-MY.Male', label: 'Malay' },
  { id: 'Chatterbox-Multilingual.nb-NO.Male', label: 'Norwegian' },
  { id: 'Chatterbox-Multilingual.pl-PL.Male', label: 'Polish' },
  { id: 'Chatterbox-Multilingual.pt-BR.Male', label: 'Portuguese (Brazil)' },
  { id: 'Chatterbox-Multilingual.ru-RU.Male', label: 'Russian' },
  { id: 'Chatterbox-Multilingual.es-ES.Male', label: 'Spanish' },
  { id: 'Chatterbox-Multilingual.sw-KE.Male', label: 'Swahili' },
  { id: 'Chatterbox-Multilingual.sv-SE.Male', label: 'Swedish' },
  { id: 'Chatterbox-Multilingual.tr-TR.Male', label: 'Turkish' },
]

const NVIDIA_MODELS = [
  {
    id: 'chatterbox-multilingual',
    label: 'Chatterbox Multilingual',
    functionId: 'ddacc747-1269-4fab-bfd9-8f593dead106',
  },
]

export class NvidiaSpeechError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function nvidiaModelsForClient() {
  return NVIDIA_MODELS.map(({ id, label }) => ({ id, label }))
}

export function configuredNvidiaModel(requested: string | null | undefined) {
  const fallback = NVIDIA_MODELS[0]
  if (!fallback) throw new NvidiaSpeechError(500, 'Natural Voices have no model configured.')
  const id = requested?.trim()
  return NVIDIA_MODELS.find((model) => model.id === id) ?? fallback
}

export function configuredNvidiaVoice(requested: string | null | undefined) {
  const id = requested?.trim()
  if (id && NVIDIA_VOICES.some((voice) => voice.id === id)) return id
  return NVIDIA_DEFAULT_VOICE
}

interface NvidiaSocket {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  close: () => void | Promise<void>
}

async function openNvidiaConnection() {
  const { connect } = await import('cloudflare:sockets') as {
    connect: (
      address: { hostname: string; port: number },
      options?: { secureTransport?: 'on' },
    ) => NvidiaSocket
  }
  const socket = connect(
    { hostname: NVIDIA_HOST, port: 443 },
    { secureTransport: 'on' },
  )
  const reader = socket.readable.getReader()
  const writer = socket.writable.getWriter()
  return {
    async read() {
      const { done, value } = await reader.read()
      return done ? null : (value ?? new Uint8Array())
    },
    async write(bytes: Uint8Array) {
      await writer.write(bytes)
    },
    close() {
      try { void reader.cancel() } catch { /* already closed */ }
      try { void writer.close() } catch { /* already closed */ }
      try { void socket.close() } catch { /* already closed */ }
    },
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NvidiaSpeechError(502, message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function concatPcm(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const pcm = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    pcm.set(part, offset)
    offset += part.byteLength
  }
  return pcm
}

function safeDetail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300)
}

export async function synthesizeNvidiaAudio(
  apiKey: string | undefined,
  options: { text: string; voice: string | null; model: string | null },
) {
  const key = apiKey?.trim()
  if (!key) {
    throw new NvidiaSpeechError(400, 'Natural Voices are not configured yet. Add NVIDIA_API_KEY to the Cloudflare Worker secrets.')
  }

  const chosen = configuredNvidiaModel(options.model)
  const voiceName = configuredNvidiaVoice(options.voice)
  const parts = splitNvidiaText(options.text)
  if (!parts.length) throw new NvidiaSpeechError(400, 'Natural Voices need text to read.')

  const pcmParts: Uint8Array[] = []
  for (const part of parts) {
    const conn = await openNvidiaConnection()
    let timedOut = false
    const pending = synthesizeNvidiaPcm(conn, {
      apiKey: key,
      functionId: chosen.functionId,
      text: part,
      voice: voiceName,
      languageCode: languageCodeForNvidiaVoice(voiceName),
    }).catch((error: unknown) => {
      if (timedOut) return new Uint8Array()
      throw error
    })
    try {
      const pcm = await withDeadline(pending, NVIDIA_CALL_TIMEOUT_MS, 'Natural Voices timed out.')
      if (!pcm.byteLength) throw new NvidiaSpeechError(502, 'Natural Voices returned no audio.')
      pcmParts.push(pcm)
    } catch (error) {
      timedOut = true
      if (error instanceof NvidiaSpeechError) throw error
      const detail = safeDetail(error)
      const status = /unauth|permission|denied|api key|forbidden/i.test(detail) ? 401 : 502
      throw new NvidiaSpeechError(status, `Natural Voices failed: ${detail}`)
    } finally {
      conn.close()
    }
  }

  const pcm = concatPcm(pcmParts)
  return {
    model: chosen.id,
    voice: voiceName,
    wav: pcmToWav(pcm, NVIDIA_SAMPLE_RATE),
    duration: pcm.byteLength / 2 / NVIDIA_SAMPLE_RATE,
  }
}
