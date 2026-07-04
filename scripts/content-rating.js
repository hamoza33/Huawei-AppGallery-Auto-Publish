// Content Rating Automation - Playwright CDP
// Navigates to app's version draft page, opens the content rating questionnaire,
// expands all 11 categories, clicks "No" for every question, then verifies.
// Auto-logs in if the Huawei session has expired.
//
// Usage: node scripts/content-rating.js <appId> [cdpUrl]
//
// Env vars: HUAWEI_LOGIN_EMAIL, HUAWEI_LOGIN_PASSWORD (for auto-login)
// Prerequisites: Category and Countries must already be set (mandatory order)
const { chromium } = require('playwright');
const { ensureLoggedIn } = require('./huawei-login-helper');

const APP_ID = process.argv[2];
const CDP_URL = process.argv[3] || process.env.CDP_URL || 'http://localhost:9222';

if (!APP_ID) {
  console.error('Usage: node scripts/content-rating.js <appId> [cdpUrl]');
  process.exit(1);
}

(async () => {
  console.log(`Connecting to Chrome CDP at ${CDP_URL}...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  // Ensure we're logged in first
  await ensureLoggedIn(page);

  // Navigate to the app's version draft page
  const appUrl = `https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp/${APP_ID}`;
  console.log(`Navigating to app: ${appUrl}`);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Click on "1.0.x Draft" in sidebar to go to version draft page
  const clickedDraft = await page.evaluate(() => {
    const items = document.querySelectorAll('li');
    for (const item of items) {
      if (item.textContent && item.textContent.includes('Draft')) {
        item.click();
        return true;
      }
    }
    return false;
  });
  console.log(`Clicked Draft: ${clickedDraft}`);
  await page.waitForTimeout(3000);

  // Scroll to Content rating section and click "Set"
  console.log('Step 1: Opening content rating dialog...');
  const clickedSet = await page.evaluate(() => {
    const sections = document.querySelectorAll('section');
    for (const section of sections) {
      if (section.textContent && section.textContent.includes('Content rating') &&
          section.textContent.includes('Rate by age')) {
        const btn = section.querySelector('button');
        if (btn && btn.textContent.trim() === 'Set') {
          btn.scrollIntoView({ behavior: 'instant', block: 'center' });
          btn.click();
          return 'set';
        }
      }
    }
    // Fallback: find any "Set" button
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === 'Set') {
        btn.scrollIntoView({ behavior: 'instant', block: 'center' });
        btn.click();
        return 'fallback';
      }
    }
    return false;
  });
  console.log(`Clicked Set: ${clickedSet}`);
  await page.waitForTimeout(2000);

  // Click "Fill out questionnaire"
  console.log('Step 2: Click Fill out questionnaire...');
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.includes('Fill out questionnaire')) {
        btn.click();
        return true;
      }
    }
    return false;
  });
  await page.waitForTimeout(3000);

  // Dismiss any warning/OK dialog (user said: "if that warning appears click ok")
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === 'OK') { btn.click(); return; }
    }
  });
  await page.waitForTimeout(1500);

  // Process all 11 categories: expand each, click "No" for all questions
  console.log('Step 3: Processing all categories...');

  const categoryNames = [
    'Violence', 'Fear', 'Sexuality', 'Strong language', 'Crude humor',
    'Controlled substances', 'Simulated gambling', 'Legal and ethical',
    'Interactions among players', 'Player information collection', 'Others'
  ];

  for (const name of categoryNames) {
    // Click category header to expand
    const expanded = await page.evaluate((catName) => {
      const allDivs = document.querySelectorAll('div');
      for (const div of allDivs) {
        const text = div.textContent || '';
        if (text.includes(catName) && div.childElementCount <= 3 && text.length < 120) {
          const parent = div.parentElement;
          if (parent && parent.tagName === 'DIV') {
            parent.click();
            return true;
          }
          div.click();
          return true;
        }
      }
      return false;
    }, name);

    await page.waitForTimeout(600);

    // Click all visible "No" labels
    const clicked = await page.evaluate(() => {
      let count = 0;
      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        const text = (label.textContent || '').trim();
        if (text === 'No') {
          const rect = label.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.top > 0) {
            const radio = label.querySelector('input[type="radio"]');
            if (radio && !radio.checked) {
              label.click();
              count++;
            } else if (!radio) {
              label.click();
              count++;
            }
          }
        }
      }
      return count;
    });

    console.log(`  ${name}: expanded=${expanded}, No clicked=${clicked}`);
    await page.waitForTimeout(300);

    // Dismiss any warning dialog that appears
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === 'OK') { btn.click(); return; }
      }
    });
    await page.waitForTimeout(200);
  }

  // Click Verify
  console.log('Step 4: Clicking Verify...');
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === 'Verify') {
        btn.click();
        return true;
      }
    }
    return false;
  });
  await page.waitForTimeout(5000);

  // Handle confirmation/OK dialog
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      if (text === 'OK' || text === 'Confirm') { btn.click(); return; }
    }
  });
  await page.waitForTimeout(2000);

  // Dismiss any final warning
  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim() === 'OK') { btn.click(); return; }
    }
  });
  await page.waitForTimeout(1000);

  console.log('Content rating complete!');
  await browser.close();
})();
