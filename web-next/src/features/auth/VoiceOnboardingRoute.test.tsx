// @vitest-environment jsdom
import { act } from 'react'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceOnboardingRoute } from './VoiceOnboardingRoute'

vi.mock('@/features/studio/studioVoice', () => ({
  warmHostedKokoro: vi.fn(),
}))

describe('voice onboarding screen', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = null
    host = null
  })

  it('keeps Continue to library outside the scrolling voice list', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <MemoryRouter>
          <VoiceOnboardingRoute />
        </MemoryRouter>,
      )
    })

    const button = [...host.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Continue to library'),
    )
    const scroller = host.querySelector('.overflow-y-auto')
    const shell = host.querySelector('.fixed')

    expect(button).toBeTruthy()
    expect(scroller).toBeTruthy()
    expect(shell).toBeTruthy()
    expect(scroller?.contains(button ?? null)).toBe(false)
    expect(shell?.contains(scroller ?? null)).toBe(true)
    expect(shell?.contains(button ?? null)).toBe(true)
  })
})