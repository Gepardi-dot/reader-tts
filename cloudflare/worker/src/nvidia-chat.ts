/**
 * Reader text on NVIDIA integrate chat: page summaries, the reading assistant,
 * highlighted passages, translation, and dictionary gap-fill.
 * The key is NVIDIA_CHAT_API_KEY. It is not the Magpie speech key NVIDIA_API_KEY.
 */
export const NVIDIA_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
export const NVIDIA_CHAT_MODEL = 'stepfun-ai/step-5-preview'

const NVIDIA_CHAT_TIMEOUT_MS = 45_000

export type ReaderChatTurn = { role: 'user' | 'assistant'; content: string }

type NvidiaChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class NvidiaChatError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'NvidiaChatError'
    this.status = status
  }
}

export function redactNvidiaSecrets(text: string) {
  return text.replace(/nvapi-[A-Za-z0-9_-]+/g, 'nvapi-redacted')
}

export function textFromChatContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const text = (part as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
  }).join('')
}

/** Final answer only. Step 5 also returns reasoning_content, which is not shown. */
export function visibleChatAnswer(content: unknown): string {
  return textFromChatContent(content)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
}

/** Text part in the integrate chat content array. Image parts are not used. */
export function nvidiaTextContent(text: string) {
  return [{ type: 'text', text }]
}

export function buildReaderChatMessages(options: {
  system: string
  turns: ReaderChatTurn[]
}): NvidiaChatMessage[] {
  const messages: NvidiaChatMessage[] = []
  const system = options.system.trim()
  if (system) messages.push({ role: 'system', content: system })
  for (const turn of options.turns) {
    const content = turn.content.trim()
    if (!content) continue
    if (turn.role !== 'user' && turn.role !== 'assistant') continue
    const prev = messages[messages.length - 1]
    if (prev && prev.role === turn.role) {
      prev.content = `${prev.content}\n\n${content}`
    } else {
      messages.push({ role: turn.role, content })
    }
  }
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') {
    messages.push({ role: 'user', content: 'Please continue.' })
  }
  return messages
}

export async function nvidiaGenerateText(
  apiKey: string,
  options: {
    system: string
    turns: ReaderChatTurn[]
    maxTokens?: number
    temperature?: number
    fetchImpl?: typeof fetch
  },
): Promise<string> {
  const key = apiKey.trim()
  if (!key) {
    throw new NvidiaChatError(503, 'Reading assistant is not configured yet.')
  }

  const messages = buildReaderChatMessages(options).map((message) => ({
    role: message.role,
    content: nvidiaTextContent(message.content),
  }))
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(NVIDIA_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: NVIDIA_CHAT_MODEL,
        messages,
        max_tokens: options.maxTokens ?? 4096,
        stream: false,
        temperature: options.temperature ?? 0.5,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      }),
      signal: AbortSignal.timeout(NVIDIA_CHAT_TIMEOUT_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Reading model request failed.'
    throw new NvidiaChatError(502, redactNvidiaSecrets(message).slice(0, 300))
  }

  if (!response.ok) {
    const detail = redactNvidiaSecrets(await response.text().catch(() => response.statusText)).slice(0, 400)
    const status = response.status === 429
      ? 429
      : response.status >= 500
        ? 502
        : 400
    throw new NvidiaChatError(
      status,
      status === 429
        ? 'The reading model is busy right now. Try again in a moment.'
        : `Reading model failed (${response.status}): ${detail}`,
    )
  }

  const body = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>
  }
  const text = visibleChatAnswer(body.choices?.[0]?.message?.content)
  if (!text) throw new NvidiaChatError(502, 'The reading model returned an empty reply.')
  return text
}
