import { expect, test } from '@playwright/test'

test('books, notes, words, and studio behave like one workspace section', async ({ page }) => {
  await page.goto('/books')
  await expect(page.getByRole('heading', { name: /your reading shelf sits in the same workspace/i })).toBeVisible()
  await expect(page).toHaveURL(/\/books$/)

  await page.getByRole('link', { name: 'Studio' }).click()
  await expect(page).toHaveURL(/\/studio$/)
  await expect(page.getByRole('heading', { name: /keep the book open/i })).toBeVisible()
  await page.getByRole('button', { name: /start review/i }).click()
  await expect(page.getByRole('heading', { name: 'wretched' })).toBeVisible()

  await page.getByRole('link', { name: 'Notes' }).click()
  await expect(page).toHaveURL(/\/notes$/)
  await expect(page.getByRole('heading', { name: /annotations stay in the same reading workspace/i })).toBeVisible()

  await page.getByRole('link', { name: 'Words' }).click()
  await expect(page).toHaveURL(/\/words$/)
  await expect(page.getByRole('heading', { name: /vocabulary and spaced repetition stay connected/i })).toBeVisible()

  await page.getByRole('link', { name: 'Books' }).click()
  await expect(page).toHaveURL(/\/books$/)
  await expect(page.getByRole('heading', { name: /your reading shelf sits in the same workspace/i })).toBeVisible()
  await page.getByRole('link', { name: /open book/i }).first().click()
  await expect(page.getByRole('heading', { name: /the secret garden/i })).toBeVisible()

  await page.getByRole('link', { name: 'Audio' }).click()
  await expect(page.getByRole('heading', { name: /keep the learner-facing surface simple/i })).toBeVisible()
})
