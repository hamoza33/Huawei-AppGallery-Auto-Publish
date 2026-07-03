// App Info Setup via Playwright CDP (fallback when API fails)
// Sets: Category (Games/RPG/Incremental/Casual) + Countries (all except China)
//
// Usage: node scripts/setup-app-info.js <appId> [cdpUrl]
//
// This script is spawned by the workflow when the API-based template step
// fails (e.g. "US not exist" for new apps). It navigates the Huawei console
// to set category and countries via the UI.
const { chromium } = require('playwright');

const APP_ID = process.argv[2];
const CDP_URL = process.argv[3] || process.env.CDP_URL || 'http://localhost:9222';

if (!APP_ID) {
  console.error('Usage: node scripts/setup-app-info.js <appId> [cdpUrl]');
  process.exit(1);
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function ensureLoggedIn(page) {
  console.log('Checking login status...');
  await page.goto('https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await delay(6000);

  const needsLogin = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return !text.includes('jawad') && !text.includes('HANANE') &&
           (text.includes('Sign in') || text.includes('Log in') || text.includes('HUAWEI ID'));
  });

  if (!needsLogin) {
    console.log('Already logged in.');
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button, div, a');
      for (const b of btns) {
        if ((b.textContent || '').trim() === 'Accept All' && b.offsetWidth > 0) { b.click(); return; }
      }
    });
    return;
  }

  const email = process.env.HUAWEI_LOGIN_EMAIL;
  const password = process.env.HUAWEI_LOGIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Session expired and HUAWEI_LOGIN_EMAIL / HUAWEI_LOGIN_PASSWORD not set.');
  }

  console.log('Session expired. Auto-logging in...');
  await page.goto('https://developer.huawei.com/consumer/en/service/josp/agc/index.html', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await delay(3000);

  await page.evaluate(() => {
    const els = document.querySelectorAll('a, button, div, span');
    for (const el of els) {
      const text = (el.textContent || '').trim();
      if ((text === 'Sign in' || text === 'Log in') && el.offsetWidth > 0) { el.click(); return; }
    }
  });
  await delay(5000);

  const emailInput = page.locator('input.hwid-input.userAccount');
  await emailInput.click();
  await delay(200);
  await emailInput.fill(email);
  await delay(500);

  const pwdInput = page.locator('input.hwid-input.hwid-input-pwd');
  await pwdInput.click();
  await delay(200);
  await pwdInput.fill(password);
  await delay(1000);

  const loginBtn = page.locator('.hwid-login-btn');
  await loginBtn.click({ force: true });
  await delay(8000);

  const postLoginText = await page.evaluate(() => document.body.innerText);
  if (postLoginText.includes('Trust this browser')) {
    await page.evaluate(() => {
      const els = document.querySelectorAll('div, span, a, button');
      for (const el of els) {
        if ((el.textContent || '').trim() === 'TRUST' && el.offsetWidth > 0) { el.click(); return; }
      }
    });
    await delay(8000);
  }

  await page.evaluate(() => {
    const btns = document.querySelectorAll('button, div, a');
    for (const b of btns) {
      if ((b.textContent || '').trim() === 'Accept All' && b.offsetWidth > 0) { b.click(); return; }
    }
  });
  await delay(2000);

  await page.goto('https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await delay(5000);
  console.log('Login complete.');
}

(async () => {
  console.log(`Connecting to Chrome CDP at ${CDP_URL}...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  await ensureLoggedIn(page);

  // ========== STEP 1: Navigate to App Info page ==========
  const appUrl = `https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp/${APP_ID}`;
  console.log(`Navigating to app: ${appUrl}`);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(5000);

  // ========== STEP 2: Set Category ==========
  console.log('Setting category...');
  // Click the category dropdown (input with placeholder "Select")
  const catInput = await page.$('input[placeholder="Select"]');
  if (catInput) {
    await catInput.click();
    await delay(1000);

    // Click "Games"
    await page.evaluate(() => {
      const items = document.querySelectorAll('li, span, div');
      for (const item of items) {
        if (item.textContent && item.textContent.trim() === 'Games' && item.offsetWidth > 0) {
          item.click();
          return;
        }
      }
    });
    await delay(800);

    // Click "Role-playing"
    await page.evaluate(() => {
      const items = document.querySelectorAll('li, span, div');
      for (const item of items) {
        if (item.textContent && item.textContent.trim() === 'Role-playing' && item.offsetWidth > 0) {
          item.click();
          return;
        }
      }
    });
    await delay(800);

    // Click "Incremental games"
    await page.evaluate(() => {
      const items = document.querySelectorAll('li, span, div');
      for (const item of items) {
        if (item.textContent && item.textContent.trim() === 'Incremental games' && item.offsetWidth > 0) {
          item.click();
          return;
        }
      }
    });
    await delay(800);
    console.log('Category dropdown selected: Games > Role-playing > Incremental games');
  } else {
    console.log('Category already set or dropdown not found');
  }

  // Select "Casual game" radio
  await page.evaluate(() => {
    const labels = document.querySelectorAll('label');
    for (const l of labels) {
      if (l.textContent && l.textContent.trim() === 'Casual game') {
        l.click();
        return;
      }
    }
  });
  await delay(500);
  console.log('Selected Casual game');

  // Save App Information
  console.log('Saving App Information...');
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.textContent && btn.textContent.trim() === 'Save' && !btn.disabled && btn.offsetWidth > 0) {
        btn.click();
        return;
      }
    }
  });
  await delay(3000);

  // Dismiss OK dialog
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.textContent && btn.textContent.trim() === 'OK' && btn.offsetWidth > 0) {
        btn.click();
        return;
      }
    }
  });
  await delay(1000);
  console.log('App Information saved');

  // ========== STEP 3: Navigate to Draft page for Countries ==========
  console.log('Navigating to Draft page...');
  await page.evaluate(() => {
    const items = document.querySelectorAll('li');
    for (const item of items) {
      if (item.textContent && item.textContent.includes('Draft')) {
        item.click();
        return;
      }
    }
  });
  await delay(4000);

  // Check if on Draft page
  const onDraft = await page.evaluate(() => {
    return document.body.innerText.includes('Country/Region') || document.body.innerText.includes('country');
  });
  if (!onDraft) {
    console.log('Not on Draft page, trying direct navigation...');
    await page.goto(`https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp/${APP_ID}/v`, {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await delay(3000);
    await page.evaluate(() => {
      const links = document.querySelectorAll('li');
      for (const link of links) {
        if (link.textContent && link.textContent.includes('Draft')) { link.click(); break; }
      }
    });
    await delay(4000);
  }

  // ========== STEP 4: Set Countries ==========
  console.log('Setting countries...');

  // Click "Selected countries/regions" radio
  await page.evaluate(() => {
    const labels = document.querySelectorAll('label');
    for (const l of labels) {
      const span = l.querySelector('span');
      if (span && span.textContent && span.textContent.includes('Selected countries/regions')) {
        l.click();
        return;
      }
    }
  });
  await delay(2000);

  // Click "Select all" to select all countries
  await page.evaluate(() => {
    const labels = document.querySelectorAll('label');
    for (const l of labels) {
      const text = l.textContent || '';
      if (text.includes('Select all') || text.includes('All')) {
        const checkbox = l.querySelector('input[type="checkbox"]') || l;
        checkbox.click();
        return;
      }
    }
  });
  await delay(1000);

  // Uncheck "Chinese mainland"
  await page.evaluate(() => {
    const labels = document.querySelectorAll('label');
    for (const l of labels) {
      const text = l.textContent || '';
      if (text.includes('Chinese mainland') || text.includes('China')) {
        const checkbox = l.querySelector('input[type="checkbox"]') || l;
        checkbox.click();
        return;
      }
    }
  });
  await delay(1000);
  console.log('Countries selected (all except Chinese mainland)');

  // Save Draft page
  console.log('Saving Version Information...');
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.textContent && btn.textContent.trim() === 'Save' && !btn.disabled && btn.offsetWidth > 0) {
        btn.click();
        return;
      }
    }
  });
  await delay(3000);

  // Dismiss OK dialog
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.textContent && btn.textContent.trim() === 'OK' && btn.offsetWidth > 0) {
        btn.click();
        return;
      }
    }
  });
  await delay(1000);
  console.log('Version Information saved');

  console.log('App info setup complete (Category + Countries)');
  await browser.close();
})();
