/**
 * Natural Voices: NVIDIA Magpie TTS Multilingual on the hosted HTTP API.
 * The endpoint returns a WAV. A response over about 4 MB is rejected, so long
 * text is split and the PCM parts are concatenated.
 */
export const NVIDIA_SAMPLE_RATE = 44_100
export const NVIDIA_MAX_CHARS = 480

const NVIDIA_ENDPOINT = 'https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize'
const NVIDIA_DEFAULT_VOICE = 'Magpie-Multilingual.EN-US.Aria'
const NVIDIA_CALL_TIMEOUT_MS = 28_000

export const NVIDIA_VOICES = [
  { id: 'Magpie-Multilingual.EN-US.Aria', label: 'Aria · English' },
  { id: 'Magpie-Multilingual.EN-US.Aria.Calm', label: 'Aria · English, calm' },
  { id: 'Magpie-Multilingual.EN-US.Jason', label: 'Jason · English' },
  { id: 'Magpie-Multilingual.EN-US.Jason.Calm', label: 'Jason · English, calm' },
  { id: 'Magpie-Multilingual.EN-US.Mia', label: 'Mia · English' },
  { id: 'Magpie-Multilingual.EN-US.Leo', label: 'Leo · English' },
  { id: 'Magpie-Multilingual.EN-US.Sofia', label: 'Sofia · English' },
  { id: 'Magpie-Multilingual.EN-US.Ray', label: 'Ray · English' },
  { id: 'Magpie-Multilingual.AR-XA.Sofia', label: 'Sofia · Arabic' },
  { id: 'Magpie-Multilingual.AR-XA.Jason', label: 'Jason · Arabic' },
  { id: 'Magpie-Multilingual.ZH-CN.HouZhen', label: 'HouZhen · Chinese' },
  { id: 'Magpie-Multilingual.ZH-CN.Siwei', label: 'Siwei · Chinese' },
  { id: 'Magpie-Multilingual.FR-FR.Louise', label: 'Louise · French' },
  { id: 'Magpie-Multilingual.FR-FR.Pascal', label: 'Pascal · French' },
  { id: 'Magpie-Multilingual.DE-DE.Mia', label: 'Mia · German' },
  { id: 'Magpie-Multilingual.DE-DE.Pascal', label: 'Pascal · German' },
  { id: 'Magpie-Multilingual.HI-IN.Sofia', label: 'Sofia · Hindi' },
  { id: 'Magpie-Multilingual.HI-IN.Leo', label: 'Leo · Hindi' },
  { id: 'Magpie-Multilingual.IT-IT.Isabela', label: 'Isabela · Italian' },
  { id: 'Magpie-Multilingual.IT-IT.Diego', label: 'Diego · Italian' },
  { id: 'Magpie-Multilingual.JA-JP.Louise', label: 'Louise · Japanese' },
  { id: 'Magpie-Multilingual.JA-JP.HouZhen', label: 'HouZhen · Japanese' },
  { id: 'Magpie-Multilingual.KO-KR.Aria', label: 'Aria · Korean' },
  { id: 'Magpie-Multilingual.KO-KR.Ray', label: 'Ray · Korean' },
  { id: 'Magpie-Multilingual.PT-BR.Louise', label: 'Louise · Portuguese' },
  { id: 'Magpie-Multilingual.PT-BR.Diego', label: 'Diego · Portuguese' },
  { id: 'Magpie-Multilingual.ES-US.Isabela', label: 'Isabela · Spanish' },
  { id: 'Magpie-Multilingual.ES-US.Diego', label: 'Diego · Spanish' },
  { id: 'Magpie-Multilingual.VI-VN.Louise', label: 'Louise · Vietnamese' },
  { id: 'Magpie-Multilingual.VI-VN.Long', label: 'Long · Vietnamese' },
]

const NVIDIA_MODELS = [
  {
    id: 'magpie-tts-multilingual',
    label: 'Magpie Multilingual',
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

export function languageCodeForNvidiaVoice(voice: string) {
  const match = String(voice).match(/\.([A-Za-z]{2})-([A-Za-z]{2})\./)
  const language = match?.[1]
  const region = match?.[2]
  if (!language || !region) return 'en-US'
  return `${language.toLowerCase()}-${region.toUpperCase()}`
}

export function splitNvidiaText(text: string) {
  const source = text.replace(/\s+/g, ' ').trim()
  if (!source) return []
  if (source.length <= NVIDIA_MAX_CHARS) return [source]
  const parts: string[] = []
  let rest = source
  while (rest.length > NVIDIA_MAX_CHARS) {
    let cut = rest.lastIndexOf(' ', NVIDIA_MAX_CHARS)
    if (cut < 40) cut = NVIDIA_MAX_CHARS
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

function safeDetail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300)
}

interface WavPcm {
  pcm: Uint8Array
  rate: number
  channels: number
  bits: number
}

function wavPcm(wav: Uint8Array): WavPcm {
  if (wav.byteLength < 44) {
    throw new NvidiaSpeechError(502, 'Natural Voices returned audio that is too short.')
  }
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const riff = String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)
  const wave = String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!)
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new NvidiaSpeechError(502, 'Natural Voices returned audio that is not a WAV.')
  }
  const rate = view.getUint32(24, true)
  const channels = view.getUint16(22, true)
  const bits = view.getUint16(34, true)
  let offset = 12
  while (offset + 8 <= wav.byteLength) {
    const id = String.fromCharCode(wav[offset]!, wav[offset + 1]!, wav[offset + 2]!, wav[offset + 3]!)
    const size = view.getUint32(offset + 4, true)
    if (id === 'data') {
      const start = offset + 8
      const end = Math.min(wav.byteLength, start + size)
      return { pcm: wav.subarray(start, end), rate, channels, bits }
    }
    offset += 8 + size + (size % 2)
  }
  throw new NvidiaSpeechError(502, 'Natural Voices returned audio without PCM.')
}

function pcmToWav(pcm: Uint8Array, sampleRate: number) {
  const bytes = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  bytes.set(pcm, 44)
  return bytes
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

async function synthesizeMagpieWav(apiKey: string, text: string, voice: string) {
  const body = new FormData()
  body.set('text', text)
  body.set('language', languageCodeForNvidiaVoice(voice))
  body.set('voice', voice)
  body.set('encoding', 'LINEAR_PCM')
  body.set('sample_rate_hz', String(NVIDIA_SAMPLE_RATE))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NVIDIA_CALL_TIMEOUT_MS)
  try {
    const response = await fetch(NVIDIA_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
      signal: controller.signal,
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!response.ok) {
      const detail = safeDetail(new TextDecoder().decode(bytes))
      const status = response.status === 401 || response.status === 403 || /unauth|permission|denied|api key|forbidden/i.test(detail)
        ? 401
        : 502
      throw new NvidiaSpeechError(status, `Natural Voices failed: ${detail || response.status}`)
    }
    const parsed = wavPcm(bytes)
    if (!parsed.pcm.byteLength) throw new NvidiaSpeechError(502, 'Natural Voices returned no audio.')
    return { wav: bytes, parsed }
  } catch (error) {
    if (error instanceof NvidiaSpeechError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NvidiaSpeechError(502, 'Natural Voices timed out.')
    }
    const detail = safeDetail(error)
    const status = /unauth|permission|denied|api key|forbidden/i.test(detail) ? 401 : 502
    throw new NvidiaSpeechError(status, `Natural Voices failed: ${detail}`)
  } finally {
    clearTimeout(timer)
  }
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

  const clips = []
  for (const part of parts) clips.push(await synthesizeMagpieWav(key, part, voiceName))
  const first = clips[0]
  if (!first) throw new NvidiaSpeechError(502, 'Natural Voices returned no audio.')
  if (clips.length === 1) {
    const { pcm, rate, channels, bits } = first.parsed
    const bytesPerSecond = rate * channels * (bits / 8)
    return {
      model: chosen.id,
      voice: voiceName,
      wav: first.wav,
      duration: pcm.byteLength / bytesPerSecond,
    }
  }

  const rate = first.parsed.rate
  for (const clip of clips) {
    if (clip.parsed.rate !== rate || clip.parsed.channels !== 1 || clip.parsed.bits !== 16) {
      throw new NvidiaSpeechError(502, 'Natural Voices returned audio that cannot be joined.')
    }
  }
  const pcm = concatPcm(clips.map((clip) => clip.parsed.pcm))
  return {
    model: chosen.id,
    voice: voiceName,
    wav: pcmToWav(pcm, rate),
    duration: pcm.byteLength / 2 / rate,
  }
}
