// Huawei AppGallery Connect Auto-Login via Playwright CDP
// Env vars: HUAWEI_LOGIN_EMAIL, HUAWEI_LOGIN_PASSWORD, optional HUAWEI_LOGIN_VERIFICATION_CODE
const { chromium } = require('playwright');
const { ensureLoggedIn } = require('./huawei-login-helper');

const CDP_URL = process.argv[2] || process.env.CDP_URL || 'http://localhost:9222';

(async () => {
  console.log(`Connecting to Chrome CDP at ${CDP_URL}...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();
  await ensureLoggedIn(page);
  await browser.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
