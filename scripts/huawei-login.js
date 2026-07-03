// Huawei AppGallery Connect Auto-Login via Playwright CDP
// Checks if logged in; if not, navigates to login page and authenticates.
// After first successful login with trusted browser, session persists.
//
// Usage: node scripts/huawei-login.js [cdpUrl]
//
// Env vars: HUAWEI_LOGIN_EMAIL, HUAWEI_LOGIN_PASSWORD
const { chromium } = require('playwright');

const CDP_URL = process.argv[2] || process.env.CDP_URL || 'http://localhost:9222';
const EMAIL = process.env.HUAWEI_LOGIN_EMAIL;
const PASSWORD = process.env.HUAWEI_LOGIN_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('HUAWEI_LOGIN_EMAIL and HUAWEI_LOGIN_PASSWORD env vars are required');
  process.exit(1);
}

(async () => {
  console.log(`Connecting to Chrome CDP at ${CDP_URL}...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  // Check if already logged in
  console.log('Checking login status...');
  await page.goto('https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await page.waitForTimeout(6000);

  const needsLogin = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return !text.includes('jawad') && !text.includes('HANANE') &&
           (text.includes('Sign in') || text.includes('Log in') || text.includes('HUAWEI ID'));
  });

  if (!needsLogin) {
    console.log('Already logged in!');
    await browser.close();
    return;
  }

  console.log('Login required. Navigating to login page...');

  // First navigate to AGC which will redirect to login with fresh OAuth params
  await page.goto('https://developer.huawei.com/consumer/en/service/josp/agc/index.html', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await page.waitForTimeout(3000);

  // Click Sign in / Log in if visible
  await page.evaluate(() => {
    const els = document.querySelectorAll('a, button, div, span');
    for (const el of els) {
      const text = (el.textContent || '').trim();
      if ((text === 'Sign in' || text === 'Log in') && el.offsetWidth > 0 && el.offsetHeight > 0) {
        el.click();
        return;
      }
    }
  });
  await page.waitForTimeout(5000);

  // We should now be on the Huawei ID login page
  console.log('On login page:', page.url());

  // Fill email using keyboard (triggers proper events)
  const emailInput = page.locator('input.hwid-input.userAccount');
  await emailInput.click();
  await page.waitForTimeout(200);
  await emailInput.fill(EMAIL);
  await page.waitForTimeout(500);

  // Fill password
  const pwdInput = page.locator('input.hwid-input.hwid-input-pwd');
  await pwdInput.click();
  await page.waitForTimeout(200);
  await pwdInput.fill(PASSWORD);
  await page.waitForTimeout(1000);

  // Click LOG IN button via Playwright (force click to bypass disabled state)
  const loginBtn = page.locator('.hwid-login-btn');
  await loginBtn.click({ force: true });
  console.log('Clicked LOG IN');
  await page.waitForTimeout(8000);

  // Check if there's a trust/verification dialog
  const postLoginText = await page.evaluate(() => document.body.innerText);

  if (postLoginText.includes('Trust this browser')) {
    console.log('Clicking TRUST...');
    await page.evaluate(() => {
      const els = document.querySelectorAll('div, span, a, button');
      for (const el of els) {
        if ((el.textContent || '').trim() === 'TRUST' && el.offsetWidth > 0) {
          el.click();
          return;
        }
      }
    });
    await page.waitForTimeout(8000);
  }

  if (postLoginText.includes('Verify identity') || postLoginText.includes('verification code')) {
    console.log('VERIFICATION CODE REQUIRED - check email and run again with code');
    process.exit(2);
  }

  // Accept cookies if shown
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button, div, a');
    for (const b of btns) {
      if ((b.textContent || '').trim() === 'Accept All' && b.offsetWidth > 0) {
        b.click();
        return;
      }
    }
  });
  await page.waitForTimeout(2000);

  // Navigate to My Apps to verify
  await page.goto('https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await page.waitForTimeout(5000);

  const loggedIn = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return text.includes('jawad') || text.includes('HANANE') || text.includes('My apps');
  });

  if (loggedIn) {
    console.log('Login successful!');
  } else {
    console.log('Login status uncertain. Check browser manually.');
    process.exit(1);
  }

  await browser.close();
})();
