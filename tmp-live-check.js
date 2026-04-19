const { chromium } = require('playwright');
(async() => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', msg => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => pageErrors.push(String(err)));
  const response = await page.goto('https://readertts.vercel.app/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  const title = await page.title();
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const html = await page.content();
  await page.screenshot({ path: 'tmp-readertts-live.png', fullPage: true });
  console.log(JSON.stringify({
    status: response && response.status(),
    title,
    url: page.url(),
    bodySample: bodyText.slice(0, 1000),
    hasLibrary: bodyText.includes('Library') || bodyText.includes('Storybook Reader'),
    hasRoot: html.includes('id="root"'),
    consoleMessages,
    pageErrors
  }, null, 2));
  await browser.close();
})();
