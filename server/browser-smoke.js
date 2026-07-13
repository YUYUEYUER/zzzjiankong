import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: process.env.TURNSTILE_DISABLE_BROWSER_SANDBOX !== 'true',
  args: ['--disable-dev-shm-usage'],
});
try {
  console.log(`[turnstile] Chromium smoke passed (${await browser.version()})`);
} finally {
  await browser.close();
}
