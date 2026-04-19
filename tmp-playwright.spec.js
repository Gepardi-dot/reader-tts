const { test } = require('playwright/test');

test('inspect readertts', async ({ page }) => {
  const logs = [];
  page.on('console', msg => logs.push(`console:${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => logs.push(`pageerror: ${err.stack || err.message}`));
  page.on('requestfailed', req => logs.push(`requestfailed: ${req.url()} -> ${req.failure()?.errorText}`));
  page.on('response', res => {
    const url = res.url();
    if (url.includes('/api/') || url.includes('/assets/')) logs.push(`response:${res.status()} ${url}`);
  });
  await page.goto('https://readertts.vercel.app/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  console.log('TITLE=' + await page.title());
  console.log('BODY=' + ((await page.textContent('body')) || '').replace(/\s+/g, ' ').trim());
  console.log('ROOT=' + (await page.locator('#root').innerHTML()).slice(0, 3000));
  for (const line of logs) console.log(line);
});
