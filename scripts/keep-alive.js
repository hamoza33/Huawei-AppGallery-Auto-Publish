// Keeps the Huawei console session warm so the automation rarely has to log in
// (and thus rarely faces the slider CAPTCHA). Navigates the CDP browser to the
// AppGallery Connect home; if the session has expired it auto-logs in (solving
// the slider CAPTCHA via OpenCV). Intended to run on a short interval (cron/timer).
const { chromium } = require('playwright');
const { ensureLoggedIn } = require('./huawei-login-helper');

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());
    await ensureLoggedIn(page);
    console.log(`[keep-alive] ${new Date().toISOString()} session OK`);
    process.exit(0);
  } catch (err) {
    console.error(`[keep-alive] ${new Date().toISOString()} FAILED: ${err.message}`);
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
})();
