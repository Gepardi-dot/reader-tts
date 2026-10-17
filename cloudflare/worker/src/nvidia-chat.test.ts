import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  NVIDIA_CHAT_MODEL,
  NVIDIA_CHAT_URL,
  buildReaderChatMessages,
  nvidiaGenerateText,
  textFromChatContent,
  visibleChatAnswer,
} from './nvidia-chat.ts'

describe('buildReaderChatMessages', () => {
  it('keeps the page passage ahead of the question and ends on a user turn', () => {
    const messages = buildReaderChatMessages({
      system: 'You are a reading assistant.',
      turns: [
        { role: 'user', content: 'Passage from the page.' },
        { role: 'assistant', content: 'Got it.' },
        { role: 'user', content: 'Summarize what I just read.' },
      ],
    })
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user'])
    assert.match(messages[1].content, /Passage from the page/)
    assert.equal(messages.at(-1)?.content, 'Summarize what I just read.')
  })

  it('asks the model to continue when the history ends on the assistant', () => {
    const messages = buildReaderChatMessages({
      system: '',
      turns: [{ role: 'assistant', content: 'Earlier note.' }],
    })
    assert.deepEqual(messages.map((message) => message.role), ['assistant', 'user'])
    assert.equal(messages[1].content, 'Please continue.')
  })
})

describe('textFromChatContent', () => {
  it('reads a string or a text-part array', () => {
    assert.equal(textFromChatContent('Hello'), 'Hello')
    assert.equal(textFromChatContent([{ type: 'text', text: 'Left ' }, { type: 'text', text: 'right' }]), 'Left right')
  })

  it('drops a think block and leaves the answer', () => {
    assert.equal(visibleChatAnswer('<think>private</think>The page is about rivers.'), 'The page is about rivers.')
  })
})

describe('nvidiaGenerateText', () => {
  it('posts Step 5 Preview with the sample sampling settings', async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | null = null
    const fetchImpl: typeof fetch = async (input, init) => {
      seen = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: [{ type: 'text', text: 'A short recap.' }] } }],
      }), { status: 200 })
    }

    const text = await nvidiaGenerateText('test-key', {
      system: 'Be concise.',
      turns: [{ role: 'user', content: 'Summarize this page.' }],
      maxTokens: 1024,
      temperature: 0.5,
      fetchImpl,
    })

    assert.equal(text, 'A short recap.')
    assert.ok(seen)
    assert.equal(seen.url, NVIDIA_CHAT_URL)
    assert.equal(seen.headers.get('authorization'), 'Bearer test-key')
    assert.equal(seen.headers.get('accept'), 'application/json')
    assert.equal(seen.body.model, NVIDIA_CHAT_MODEL)
    assert.equal(seen.body.model, 'stepfun-ai/step-5-preview')
    assert.equal(seen.body.stream, false)
    assert.equal(seen.body.max_tokens, 1024)
    assert.equal(seen.body.temperature, 0.5)
    assert.equal(seen.body.top_p, 1)
    assert.equal(seen.body.frequency_penalty, 0)
    assert.equal(seen.body.presence_penalty, 0)
    const messages = seen.body.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>
    assert.equal(messages[0].role, 'system')
    assert.deepEqual(messages[1].content, [{ type: 'text', text: 'Summarize this page.' }])
  })

  it('hides a key that the error body echoes', async () => {
    const fetchImpl: typeof fetch = async () => new Response(
      'invalid key nvapi-secretvalue',
      { status: 401 },
    )
    await assert.rejects(
      () => nvidiaGenerateText('nvapi-secretvalue', {
        system: 'Be concise.',
        turns: [{ role: 'user', content: 'Hello' }],
        fetchImpl,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal(err.message.includes('nvapi-secretvalue'), false)
        assert.match(err.message, /nvapi-redacted/)
        return true
      },
    )
  })

  it('returns the answer and leaves out the reasoning trace', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'A short recap.',
          reasoning_content: 'Think about the page first.',
        },
      }],
    }), { status: 200 })
    const text = await nvidiaGenerateText('test-key', {
      system: 'Be concise.',
      turns: [{ role: 'user', content: 'Summarize this page.' }],
      fetchImpl,
    })
    assert.equal(text, 'A short recap.')
  })

  it('treats a reasoning-only reply as empty', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'Still thinking.' } }],
    }), { status: 200 })
    await assert.rejects(
      () => nvidiaGenerateText('test-key', {
        system: 'Be concise.',
        turns: [{ role: 'user', content: 'Summarize this page.' }],
        fetchImpl,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /empty reply/)
        assert.equal(err.message.includes('Still thinking'), false)
        return true
      },
    )
  })

  it('refuses to call the model without a key', async () => {
    let called = false
    const fetchImpl: typeof fetch = async () => {
      called = true
      return new Response('nope', { status: 500 })
    }
    await assert.rejects(
      () => nvidiaGenerateText('  ', {
        system: 'Be concise.',
        turns: [{ role: 'user', content: 'Hello' }],
        fetchImpl,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /not configured/)
        return true
      },
    )
    assert.equal(called, false)
  })
})
