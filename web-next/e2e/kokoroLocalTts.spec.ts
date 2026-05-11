import { test, expect } from '@playwright/test'

// These tests exercise the in-browser Kokoro TTS scaffolding without requiring a
// signed-in user or downloading the 82 MB model. They verify:
//   1. The dev server serves the app shell without runtime errors.
//   2. The kokoroWorker module is bundled and loadable as an ES module.
//   3. The modelCache state machine drives the worker correctly when wired in-page.

test('app shell loads without console errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Ignore expected auth/network noise on the public login page.
      if (/Failed to load resource|net::ERR|404/.test(text)) return
      errors.push(`console.error: ${text}`)
    }
  })

  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  // App shell renders something (form, button, or heading) — we don't depend on
  // exact copy, just that the React tree mounted.
  await expect(page.locator('body')).toBeVisible()
  await page.waitForTimeout(500)
  expect(errors).toEqual([])
})

test('modelCache.startWarmup spawns a worker and reaches "downloading" state', async ({ page }) => {
  // Drive the real module through a synthetic harness. We don't wait for the
  // full 82 MB model download — just for the state transition idle → downloading,
  // which proves the worker boots and our message wiring is intact.
  await page.goto('/login', { waitUntil: 'domcontentloaded' })

  const result = await page.evaluate(async () => {
    type ModelCacheModule = typeof import('/src/shared/storage/modelCache')
    const mc = (await import('/src/shared/storage/modelCache')) as unknown as ModelCacheModule

    return await new Promise<{ statuses: string[]; finalStatus: string }>((resolve) => {
      const statuses: string[] = [mc.getModelStatus().status]
      const unsub = mc.subscribeModelStatus((s) => {
        statuses.push(s.status)
        // Resolve as soon as we observe the downloading transition (or 'ready'
        // if a previous tab already cached the model and this one short-circuits).
        if (s.status === 'downloading' || s.status === 'ready') {
          unsub()
          resolve({ statuses, finalStatus: s.status })
        }
      })
      mc.startWarmup()
      // Safety timeout in case the transition never fires.
      setTimeout(() => {
        unsub()
        resolve({ statuses, finalStatus: mc.getModelStatus().status })
      }, 5000)
    })
  })

  expect(['downloading', 'ready']).toContain(result.finalStatus)
})
