// Huawei AppGallery Connect Auto-Login via Playwright CDP
// Checks if logged in; if not, navigates to login page and authenticates.
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

  // Check if already logged in by navigating to My Apps
  console.log('Checking login status...');
  await page.goto('https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await page.waitForTimeout(6000);

  const needsLogin = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return text.includes('Sign in') || text.includes('Log in') || text.includes('HUAWEI ID');
  });

  if (!needsLogin) {
    console.log('Already logged in!');
    await browser.close();
    return;
  }

  console.log('Login required. Navigating to login page...');
  await page.goto('https://id1.cloud.huawei.com/CAS/portal/loginAuth.html?validated=true&themeName=red&service=https%3A%2F%2Foauth-login1.cloud.huawei.com%2Foauth2%2Fv2%2Flogin%3Faccess_type%3Doffline%26client_id%3D6099200%26display%3Dpage%26flowID%3D81f12c6b-65a3-42d6-a498-c0ecb6544c89%26h%3D1753202482.0587%26lang%3Den-us%26redirect_uri%3Dhttps%253A%252F%252Fdeveloper.huawei.com%252Fconsumer%252Fen%252Fservice%252Fjosp%252Fagc%252Findex.html%26response_type%3Dcode%26scope%3Dopenid%2Bhttps%253A%252F%252Fwww.huawei.com%252Fauth%252Faccount%252Fcountry%2Bhttps%253A%252F%252Fwww.huawei.com%252Fauth%252Faccount%252Fbase.profile%2Bhttps%253A%252F%252Fwww.huawei.com%252Fauth%252Faccount%252Floginid%26state%3D1753202482059_19828%26v%3D5de3a2c89c24e7ef4e0fa6a3f59b0e02cb0c0e4e35d6e5b7e16f61cd6df3de53&loginChannel=89000060&reqClientType=89', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await page.waitForTimeout(3000);

  // Fill email
  console.log('Entering email...');
  const emailInput = page.locator('input.hwid-input.userAccount');
  await emailInput.fill('');
  await emailInput.type(EMAIL, { delay: 50 });
  await page.waitForTimeout(500);

  // Fill password
  console.log('Entering password...');
  const pwdInput = page.locator('input.hwid-input.hwid-input-pwd');
  await pwdInput.fill('');
  await pwdInput.type(PASSWORD, { delay: 50 });
  await page.waitForTimeout(500);

  // Click LOG IN button
  console.log('Clicking LOG IN...');
  const loginClicked = await page.evaluate(() => {
    // Find the login button - it's typically a div with "LOG IN" text or a submit
    const divs = document.querySelectorAll('div, span, a, button');
    for (const el of divs) {
      const text = (el.textContent || '').trim();
      if ((text === 'LOG IN' || text === 'Log in' || text === 'Sign in') &&
          el.offsetWidth > 0 && el.offsetHeight > 0) {
        el.click();
        return text;
      }
    }
    // Fallback: submit the form
    const form = document.querySelector('form');
    if (form) { form.submit(); return 'form-submit'; }
    return false;
  });
  console.log(`Login click: ${loginClicked}`);
  await page.waitForTimeout(8000);

  // Check result
  const currentUrl = page.url();
  console.log('Post-login URL:', currentUrl);

  const loggedIn = await page.evaluate(() => {
    const text = document.body.innerText || '';
    if (text.includes('My apps') || text.includes('App name') || text.includes('My project')) return true;
    return false;
  });

  if (loggedIn) {
    console.log('Login successful!');
  } else {
    // Check for 2FA or verification
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log('Page after login attempt:', pageText);
    console.log('Login may require 2FA or verification. Check manually.');
  }

  await browser.close();
})();
