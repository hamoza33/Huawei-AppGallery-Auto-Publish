const ACCOUNT_HOME = 'https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp';

async function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function visibleBodyText(page) {
  return page.evaluate(() => document.body.innerText || '').catch(() => '');
}

async function clickVisibleText(page, matcher) {
  return page.evaluate(({ source, flags }) => {
    const regex = new RegExp(source, flags);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const elements = [...document.querySelectorAll('button, a, div, span')];
    const target = elements.find((el) => visible(el) && regex.test((el.textContent || '').trim()));
    if (!target) return false;
    target.click();
    return true;
  }, { source: matcher.source, flags: matcher.flags }).catch(() => false);
}

async function fillVisibleInput(page, matcher, value) {
  return page.evaluate(({ source, flags, value }) => {
    const regex = new RegExp(source, flags);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const input = inputs.find((el) => regex.test(el.placeholder || '') || regex.test(el.className || '') || regex.test(el.getAttribute('aria-label') || ''));
    if (!input) return false;
    input.focus();
    input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { source: matcher.source, flags: matcher.flags, value }).catch(() => false);
}

async function needsLogin(page) {
  const text = await visibleBodyText(page);
  const url = page.url();
  if (url.includes('loginAuth') || url.includes('cloud.huawei.com/CAS')) return true;
  if (/Phone\/Email\/Login ID|HUAWEI ID login|LOG IN|Verify identity/i.test(text)) return true;
  return /Sign in|Log in|HUAWEI ID/i.test(text) && !/Apps and atomic services|HANANE|jawad/i.test(text);
}

async function handleVerification(page) {
  let text = await visibleBodyText(page);
  if (!/Verify identity|verification code|Email code/i.test(text)) return;

  await clickVisibleText(page, /^Get code$/i);
  await delay(1000);

  const code = (process.env.HUAWEI_LOGIN_VERIFICATION_CODE || '').trim();
  if (!code) {
    throw new Error('Huawei verification code required. I clicked Get code if available; set HUAWEI_LOGIN_VERIFICATION_CODE to the email code and rerun.');
  }

  console.log('Entering Huawei email verification code...');
  const filled = await fillVisibleInput(page, /Email code|verification code|code/i, code) || await page.evaluate((value) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const input = [...document.querySelectorAll('input')].filter(visible).find((el) => (el.type || '').toLowerCase() !== 'password');
    if (!input) return false;
    input.focus();
    input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, code).catch(() => false);
  if (!filled) throw new Error('Huawei verification code field was not found.');

  await clickVisibleText(page, /^OK$/i);
  await delay(7000);
}

async function handleTrustPrompt(page) {
  const text = await visibleBodyText(page);
  if (!/Trust this browser\?/i.test(text)) return;
  if (/^(0|false|no|off)$/i.test(process.env.HUAWEI_TRUST_BROWSER || '1')) {
    await clickVisibleText(page, /DECIDE LATER/i);
    await delay(3000);
    return;
  }
  console.log('Trusting Huawei browser session...');
  await clickVisibleText(page, /^TRUST$/i);
  await delay(7000);
}

async function acceptCookies(page) {
  await clickVisibleText(page, /^Accept All$/i);
  await delay(1000);
}

async function ensureLoggedIn(page) {
  console.log('Checking Huawei login status...');
  await page.goto(ACCOUNT_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(6000);
  if (!(await needsLogin(page))) {
    console.log('Already logged in.');
    await acceptCookies(page);
    return;
  }

  const email = process.env.HUAWEI_LOGIN_EMAIL;
  const password = process.env.HUAWEI_LOGIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Session expired and HUAWEI_LOGIN_EMAIL / HUAWEI_LOGIN_PASSWORD are not set.');
  }

  console.log('Session expired. Auto-logging in...');
  await page.goto('https://developer.huawei.com/consumer/en/service/josp/agc/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(3000);
  await clickVisibleText(page, /^(Sign in|Log in)$/i);
  await delay(5000);

  const emailInput = page.locator('input.hwid-input.userAccount, input[placeholder="Phone/Email/Login ID"]').first();
  await emailInput.click({ timeout: 5000 });
  await page.keyboard.press('Control+A').catch(() => undefined);
  await page.keyboard.type(email, { delay: 20 });
  await delay(500);

  const passwordInput = page.locator('input.hwid-input.hwid-input-pwd, input[placeholder="Password"]').first();
  await passwordInput.click({ timeout: 5000 });
  await page.keyboard.press('Control+A').catch(() => undefined);
  await page.keyboard.type(password, { delay: 20 });
  await delay(1000);

  const loginButton = page.locator('.hwid-login-btn').first();
  if (await loginButton.count().catch(() => 0)) {
    await loginButton.click({ force: true, timeout: 5000 });
  } else if (!(await clickVisibleText(page, /^LOG IN$/i))) {
    await page.keyboard.press('Enter').catch(() => undefined);
  }
  await delay(8000);

  const afterLoginText = await visibleBodyText(page);
  if (/Please complete verification|Drag the pieces|Switch To Voice Verification|captcha/i.test(afterLoginText)) {
    throw new Error('Huawei CAPTCHA required. Open the noVNC browser, complete the slider/voice verification manually, then rerun the login script.');
  }

  await handleVerification(page);
  await handleTrustPrompt(page);
  await acceptCookies(page);

  await page.goto(ACCOUNT_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(5000);
  if (await needsLogin(page)) {
    throw new Error('Huawei auto-login did not complete. Check credentials, CAPTCHA, or verification code.');
  }
  console.log('Auto-login successful.');
}

module.exports = { ensureLoggedIn };
