// Content Rating Automation - Playwright CDP (iframe-aware)
//
// Huawei renders the version page (and the content-rating questionnaire) inside
// an `appVersion` iframe. The questionnaire is a branching Element-UI form whose
// categories are collapsed by default (their "No" radios are hidden until the
// category is expanded). This script:
//   1. navigates to the app's draft version page and locates the appVersion frame
//   2. opens the content-rating questionnaire
//   3. expands every category and selects "No" for every question
//   4. clicks Verify, then on step 2 confirms the auto-computed rating and Submit
//   5. verifies the rating was actually recorded, and exits non-zero otherwise
//
// Usage: node scripts/content-rating.js <appId> [cdpUrl]
// Env vars: HUAWEI_LOGIN_EMAIL, HUAWEI_LOGIN_PASSWORD (for auto-login)
// Prerequisites: Category and Countries must already be set (mandatory order).
const { chromium } = require('playwright');
const fs = require('fs');
const { ensureLoggedIn } = require('./huawei-login-helper');

const APP_ID = process.argv[2];
const CDP_URL = process.argv[3] || process.env.CDP_URL || 'http://localhost:9222';

if (!APP_ID) {
  console.error('Usage: node scripts/content-rating.js <appId> [cdpUrl]');
  process.exit(1);
}

const LOCK_PATH = '/tmp/huawei-cdp.lock';

// flock-style acquire: try to create the file with 'wx'; if it exists, retry
// with backoff for up to ~30s. Returns the file descriptor on success, or null.
function acquireLock(path, timeoutMs = 30000, intervalMs = 500) {
  const start = Date.now();
  let fd = null;
  while (Date.now() - start < timeoutMs) {
    try {
      fd = fs.openSync(path, 'wx');
      return fd;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Stale lock recovery: if it's older than 10 minutes, take it over.
        try {
          const st = fs.statSync(path);
          if (st && Date.now() - st.mtimeMs > 10 * 60 * 1000) {
            try { fs.unlinkSync(path); } catch (_) {}
          }
        } catch (_) {}
      } else {
        throw err;
      }
    }
    const end = Date.now() + intervalMs;
    while (Date.now() < end) { /* spin-sleep */ }
  }
  return null;
}

function releaseLock(fd, path) {
  try { if (fd != null) fs.closeSync(fd); } catch (_) {}
  try { fs.unlinkSync(path); } catch (_) {}
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function verFrame(page) {
  for (const fr of page.frames()) {
    if (!/appVersion/.test(fr.url())) continue;
    let t = 0;
    try { t = await fr.evaluate(() => (document.body ? document.body.innerText.length : 0)); } catch (_) {}
    if (t > 500) return fr;
  }
  return null;
}

// Click any visible OK/Confirm button (the recurring Huawei warning dialog).
async function clickOK(f) {
  try {
    await f.evaluate(() => {
      document
        .querySelectorAll('.el-message-box__btns button, .el-dialog__footer button, .el-message-box button')
        .forEach((b) => {
          const t = (b.textContent || '').trim();
          if ((t === 'OK' || t === 'Confirm') && b.offsetParent !== null) b.click();
        });
    });
  } catch (_) {}
  await delay(400);
}

function fail(msg) {
  console.error(`CONTENT_RATING_FAILED: ${msg}`);
  process.exit(1);
}

(async () => {
  const lockFd = acquireLock(LOCK_PATH);
  if (lockFd == null) {
    console.error('[lock] could not acquire lock at ' + LOCK_PATH + ' after 30s; aborting');
    process.exit(1);
  }
  console.log('[lock] acquired');
  let ownedPage = null;
  try {
    console.log(`Connecting to Chrome CDP at ${CDP_URL}...`);
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0];
    // Isolate: own a fresh page on the existing context so the keep-alive
    // timer's page is independent. Do not close other pages.
    const page = await context.newPage();
    ownedPage = page;

    await ensureLoggedIn(page);

  // Navigate to the app's App Information page. This route renders the left
  // sidebar (Version information > Draft); the bare /myApp/<id> route does not.
  // "97458334310914199" is the account-level App Information node.
  const appUrl = `https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp/${APP_ID}/97458334310914199`;
  console.log(`Navigating to app: ${appUrl}`);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await delay(9000);

  // Click the "Draft" version in the sidebar to open the version page, which
  // loads the appVersion iframe (containing countries, category, content rating).
  // Retry the click itself (not just the poll) because the click sometimes misses
  // and polling-only hides that. 3 attempts max, then fall back to polling.
  let f = null;
  let draftClickLanded = false;
  for (let clickAttempt = 1; clickAttempt <= 3; clickAttempt++) {
    const clickedDraft = await page.evaluate(() => {
      const cand = [...document.querySelectorAll('span.version-title, span.item-text, li.el-menu-item')].find(
        (e) => (e.textContent || '').trim() === 'Draft',
      );
      if (cand) { cand.click(); return true; }
      return false;
    });
    console.log(`Draft click attempt ${clickAttempt}: clicked=${clickedDraft}`);
    await delay(500);
    f = await verFrame(page);
    if (f) { draftClickLanded = true; break; }
  }
  if (!draftClickLanded) {
    console.warn('content-rating: Draft click did not land in 3 attempts; falling back to polling');
  }
  console.log(`Clicked Draft version: ${draftClickLanded}`);

  if (!f) { for (let i = 0; i < 14; i++) { await delay(4000); f = await verFrame(page); if (f) break; } }
  if (!f) fail('appVersion iframe not found (version page did not load)');

  // Open the questionnaire: click Set/View and edit near the Content rating section,
  // then the "Fill out questionnaire" / "Complete questionnaire" button.
  async function nTitles() {
    return await f.evaluate(() => {
      const d = [...document.querySelectorAll('.el-dialog')].find(
        (x) => x.offsetParent !== null && /Complete questionnaire/i.test(x.textContent || ''),
      );
      return d ? d.querySelectorAll('.agc-question-group__title').length : 0;
    });
  }

  let titles = 0;
  for (let attempt = 0; attempt < 3 && titles <= 0; attempt++) {
    await f.evaluate(() => {
      const all = [...document.querySelectorAll('*')];
      const h = all.find(
        (e) => /Content rating|Rate by age/i.test(e.textContent || '') && (e.textContent || '').length < 200 && e.children.length < 6,
      );
      let s = h;
      for (let i = 0; i < 5 && s; i++) {
        const b = [...s.querySelectorAll('button')].find((x) => /^(Set|View and edit)$/.test((x.textContent || '').trim()));
        if (b) { b.click(); return; }
        s = s.parentElement;
      }
    });
    await delay(2500);
    await f.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => /(Fill out|Complete) questionnaire/i.test(x.textContent || '') && x.offsetParent !== null,
      );
      if (b) b.click();
    });
    for (let i = 0; i < 8 && titles <= 0; i++) { await delay(2000); await clickOK(f); titles = await nTitles(); }
  }
  console.log(`Question categories found: ${titles}`);
  if (titles <= 0) fail('questionnaire did not open (no question categories found)');

  // Expand every category so its hidden "No" radios become clickable, then click
  // all "No". The form is branching, so loop until nothing left to answer.
  let totalNo = 0;
  for (let pass = 0; pass < 14; pass++) {
    await f.evaluate(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].find(
        (x) => x.offsetParent !== null && /Complete questionnaire/i.test(x.textContent || ''),
      );
      if (!dlg) return;
      dlg.querySelectorAll('.agc-question-group__title, .agc-question-group_tips').forEach((t) => { try { t.click(); } catch (_) {} });
    });
    await delay(600);
    await clickOK(f);
    const n = await f.evaluate(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].find(
        (x) => x.offsetParent !== null && /Complete questionnaire/i.test(x.textContent || ''),
      );
      if (!dlg) return 0;
      let c = 0;
      dlg.querySelectorAll('label.el-radio').forEach((l) => {
        const t = (l.querySelector('.el-radio__label')?.textContent || '').trim();
        if (t === 'No' && !l.classList.contains('is-checked')) { l.click(); c++; }
      });
      return c;
    });
    totalNo += n;
    await clickOK(f);
    const remaining = await f.evaluate(() => {
      const dlg = [...document.querySelectorAll('.el-dialog')].find(
        (x) => x.offsetParent !== null && /Complete questionnaire/i.test(x.textContent || ''),
      );
      if (!dlg) return 0;
      return [...dlg.querySelectorAll('label.el-radio')].filter(
        (l) => (l.querySelector('.el-radio__label')?.textContent || '').trim() === 'No' && !l.classList.contains('is-checked'),
      ).length;
    });
    if (remaining === 0 && n === 0) break;
    await delay(800);
  }
  console.log(`"No" answers selected: ${totalNo}`);

  const st = await f.evaluate(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(
      (x) => x.offsetParent !== null && /Complete questionnaire/i.test(x.textContent || ''),
    );
    if (!dlg) return { noTotal: 0, noChecked: 0 };
    const noR = [...dlg.querySelectorAll('label.el-radio')].filter(
      (l) => (l.querySelector('.el-radio__label')?.textContent || '').trim() === 'No',
    );
    return { noTotal: noR.length, noChecked: noR.filter((l) => l.classList.contains('is-checked')).length };
  });
  console.log(`Answered ${st.noChecked}/${st.noTotal} questions with No`);
  if (st.noTotal === 0 || st.noChecked < st.noTotal) fail(`not all questions answered (${st.noChecked}/${st.noTotal})`);

  // Click Verify (advances to step 2). Some already-answered states skip it.
  const verified = await f.evaluate(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(
      (x) => x.offsetParent !== null && /Complete questionnaire/i.test(x.textContent || ''),
    );
    if (!dlg) return false;
    const b = [...dlg.querySelectorAll('button')].find(
      (x) => (x.textContent || '').trim() === 'Verify' && x.offsetParent !== null && !x.disabled && !x.classList.contains('is-disabled'),
    );
    if (b) { b.click(); return true; }
    return false;
  });
  console.log(`Verify clicked: ${verified}`);
  await delay(4000);
  await clickOK(f);
  await delay(2000);

  // Step 2 "Verify your age rating": ensure lowest rating selected, then Submit.
  await f.evaluate(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null);
    if (!dlg) return;
    const r = [...dlg.querySelectorAll('label.el-radio')].find(
      (l) => (l.querySelector('.el-radio__label')?.textContent || '').trim() === 'Rated 3+',
    );
    if (r && !r.classList.contains('is-checked')) r.click();
  });
  await delay(600);
  const submitted = await f.evaluate(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(
      (x) => x.offsetParent !== null && /(Verify your age|Complete questionnaire)/i.test(x.textContent || ''),
    );
    if (!dlg) return false;
    const b = [...dlg.querySelectorAll('button')].find(
      (x) => /^(Submit|Save)$/.test((x.textContent || '').trim()) && x.offsetParent !== null && !x.disabled && !x.classList.contains('is-disabled'),
    );
    if (b) { b.click(); return true; }
    return false;
  });
  console.log(`Submit clicked: ${submitted}`);
  if (!submitted) fail('Submit button was not available on step 2');
  await delay(3000);
  await clickOK(f);
  await delay(2000);
  await clickOK(f);
  await delay(2000);

  // Verify the rating was actually recorded: reopen the panel and check
  // "Your current rating" is no longer empty.
  await f.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    const h = all.find(
      (e) => /Content rating|Rate by age/i.test(e.textContent || '') && (e.textContent || '').length < 200 && e.children.length < 6,
    );
    let s = h;
    for (let i = 0; i < 5 && s; i++) {
      const b = [...s.querySelectorAll('button')].find((x) => /^(Set|View and edit)$/.test((x.textContent || '').trim()));
      if (b) { b.click(); return; }
      s = s.parentElement;
    }
  });
  await delay(4000);
  const panel = await f.evaluate(() => {
    const dlg = [...document.querySelectorAll('.el-dialog')].find(
      (x) => x.offsetParent !== null && /Complete age rating/i.test(x.textContent || ''),
    );
    return dlg ? (dlg.textContent || '').replace(/\s+/g, ' ') : '';
  });
  const recorded = /Rated|3\+|7\+|12\+|16\+|18\+/.test(panel) && !/current rating\s*Submitted\s*Rating\s*No data available/i.test(panel);
  console.log(`Rating panel: ${panel.slice(0, 200)}`);
  if (!recorded) fail('rating was not recorded (current rating still empty)');

  console.log('CONTENT_RATING_SUCCESS');
  await browser.close();
  } catch (err) {
    console.error(`CONTENT_RATING_FAILED: ${err.message}`);
    process.exit(1);
  } finally {
    if (ownedPage) { try { await ownedPage.close(); } catch (_) {} }
    releaseLock(lockFd, LOCK_PATH);
    console.log('[lock] released');
  }
})();
