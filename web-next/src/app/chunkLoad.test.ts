import { describe, expect, it } from 'vitest'
import { isChunkLoadError } from './chunkLoad'

describe('isChunkLoadError', () => {
  it('detects Vite/browser dynamic import failures', () => {
    expect(
      isChunkLoadError(
        new TypeError(
          'Failed to fetch dynamically imported module: https://readertts.vercel.app/assets/UploadRoute-CGTAzmcC.js',
        ),
      ),
    ).toBe(true)
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new Error('Loading chunk 5 failed'))).toBe(true)
  })

  it('ignores normal errors', () => {
    expect(isChunkLoadError(new Error('Invalid email or password'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})
