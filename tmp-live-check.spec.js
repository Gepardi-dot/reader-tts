const { test } = require('playwright/test');

test('live page boots', async ({ page }) => {
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', msg => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => pageErrors.push(String(err)));
  const response = await page.goto('https://readertts.vercel.app/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  console.log('STATUS', response && response.status());
  console.log('URL', page.url());
  console.log('TITLE', await page.title());
  console.log('BODY', (await page.locator('body').innerText()).slice(0, 1000));
  console.log('CONSOLE', JSON.stringify(consoleMessages));
  console.log('PAGEERRORS', JSON.stringify(pageErrors));
  await page.screenshot({ path: 'tmp-live-check.png', fullPage: true });
});
