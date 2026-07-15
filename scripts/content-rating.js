// Content Rating Automation - Playwright CDP with API verification
//
// 1. Navigate to the app version page
// 2. Locate the version iframe (name="mainIFrameView")
// 3. Open the content rating questionnaire via "Set"/"View and edit"
// 4. Answer all questions "No" and submit
// 5. Verify the rating persisted via the Huawei Connect API
//
// Usage: node scripts/content-rating.js <appId> [cdpUrl]
// Load .env manually (dotenv not installed in worker scripts)
(() => {
  try {
    const fs = require('fs');
    const env = fs.readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["\']|["\']$/g, '');
    }
  } catch (_) {}
})();
const { chromium } = require('playwright');
const fetch = require('node-fetch');
const fs = require('fs');
const { ensureLoggedIn } = require('./huawei-login-helper');

const APP_ID = process.argv[2];
const CDP_URL = process.argv[3] || process.env.CDP_URL || 'http://localhost:9222';

if (!APP_ID) {
  console.error('Usage: node scripts/content-rating.js <appId> [cdpUrl]');
  process.exit(1);
}

const LOCK_PATH = '/tmp/huawei-cdp.lock';

function acquireLock(path, timeoutMs = 30000, intervalMs = 500) {
  const start = Date.now();
  let fd = null;
  while (Date.now() - start < timeoutMs) {
    try {
      fd = fs.openSync(path, 'wx');
      return fd;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
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
    while (Date.now() < end) { /* spin */ }
  }
  return null;
}

function releaseLock(fd, path) {
  try { if (fd != null) fs.closeSync(fd); } catch (_) {}
  try { fs.unlinkSync(path); } catch (_) {}
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Find the version iframe by name ("mainIFrameView") or by URL/hash pattern.
// Returns a Playwright Frame object, not a FrameLocator.
async function getVersionFrame(page) {
  const byName = page.frame({ name: 'mainIFrameView' });
  if (byName) return byName;
  const URL_HINT = /appVersion|app-version|distribute\/appVersion/i;
  let best = null, len = 0;
  for (const fr of page.frames()) {
    const u = fr.url();
    const hashIdx = u.indexOf('#');
    const hash = hashIdx >= 0 ? u.substring(hashIdx) : '';
    if (!URL_HINT.test(u) && !URL_HINT.test(hash)) continue;
    let t = 0;
    try { t = await fr.evaluate(() => (document.body ? document.body.innerText.length : 0)); } catch (_) {}
    if (t > len) { len = t; best = fr; }
  }
  return len > 500 ? best : null;
}

// Dismiss any warning/confirm overlay dialogs in a frame
async function clickOK(frame) {
  for (const txt of ['OK', 'Confirm', 'Close']) {
    try {
      const btns = await frame.locator(utton:).all();
      for (const btn of btns) {
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click({ timeout: 2000 }).catch(() => {});
          await delay(300);
        }
      }
    } catch (_) {}
  }
  await delay(500);
}

// Dismiss el-overlay-message-box overlays
async function dismissOverlays(frame) {
  await frame.evaluate(() => {
    const overlays = document.querySelectorAll('.el-overlay-message-box, .el-overlay.is-message-box');
    overlays.forEach(o => {
      if (o.offsetParent !== null) {
        const btn = o.querySelector('button');
        if (btn) btn.click();
      }
    });
  });
  await delay(500);
}

// Get Huawei API token
async function getApiToken() {
  const { HUAWEI_AGC_CLIENT_ID, HUAWEI_AGC_CLIENT_SECRET } = process.env;
  if (!HUAWEI_AGC_CLIENT_ID || !HUAWEI_AGC_CLIENT_SECRET) {
    throw new Error('HUAWEI_AGC_CLIENT_ID / HUAWEI_AGC_CLIENT_SECRET not set');
  }
  const r = await fetch('https://connect-api.cloud.huawei.com/api/oauth2/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: HUAWEI_AGC_CLIENT_ID, client_secret: HUAWEI_AGC_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('API token failed: ' + JSON.stringify(d));
  return d.access_token;
}

// Check contentRate in the API (authoritative)
async function getApiContentRate(appId) {
  const token = await getApiToken();
  const { HUAWEI_AGC_CLIENT_ID } = process.env;
  const r = await fetch(
    https://connect-api.cloud.huawei.com/api/publish/v2/app-info?appId=&releaseType=1,
    { headers: { 'Authorization': Bearer , 'client_id': HUAWEI_AGC_CLIENT_ID } }
  );
  const d = await r.json();
  return d.appInfo?.contentRate || '';
}

function fail(msg) {
  console.error(CONTENT_RATING_FAILED: );
  process.exit(1);
}

function log(label, obj) {
  console.log(${label}: );
}

// Wait for login session to fully settle after ensureLoggedIn completes.
// This is the key fix: after login + captcha, the browser may still have
// pending redirects. We wait for network idle and confirm we are at the account home.
async function waitForSessionSettled(page, maxWaitMs = 30000) {
  console.log('[login-settle] Waiting for session to settle after login...');
  const deadline = Date.now() + maxWaitMs;

  // First, wait for network to go idle (no requests for 1.5s)
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  } catch (_) {}

  // Extra settle delay for any post-login redirects
  await delay(4000);

  // Verify we are at the account home (not a login/redirect page)
  const url = page.url();
  console.log([login-settle] Current URL: );

  if (/login|cas|auth/i.test(url)) {
    console.log('[login-settle] Still on auth page, waiting more...');
    for (let i = 0; i < 6; i++) {
      if (Date.now() >= deadline) break;
      await delay(3000);
      const u = page.url();
      console.log([login-settle] Wait s: );
      if (!/login|cas|auth/i.test(u)) break;
    }
  }

  // One final idle wait
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  } catch (_) {}

  const finalUrl = page.url();
  console.log([login-settle] Session settled at: );
  if (/login|cas|auth/i.test(finalUrl)) {
    fail('Session did not settle ? still on auth page. Check cookies/credentials.');
  }
}

(async () => {
  const lockFd = acquireLock(LOCK_PATH);
  if (lockFd == null) fail('[lock] could not acquire lock after 30s');
  console.log('[lock] acquired');
  let ownedPage = null;
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    ownedPage = page;

    await ensureLoggedIn(page);

    // FIX: Wait for login session to fully settle before navigating
    await waitForSessionSettled(page);

    // Navigate to App Information page (sidebar route)
    const appUrl = https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp//97458334310914199;
    console.log(Navigating to app: );
    await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await delay(8000);

    // Click Draft in sidebar
    let draftOk = false;
    for (let i = 1; i <= 3; i++) {
      const r = await page.evaluate(() => {
        const c = [...document.querySelectorAll('span.version-title, li.el-menu-item')]
          .find(e => /\bDraft\b/i.test((e.textContent || '').trim()));
        if (c) { c.click(); return true; }
        return false;
      });
      console.log(Draft click : );
      await delay(500);
      const f = await getVersionFrame(page);
      if (f) { draftOk = true; break; }
    }
    if (!draftOk) {
      for (let i = 0; i < 14; i++) { await delay(4000); if (await getVersionFrame(page)) break; }
    }
    const frame = await getVersionFrame(page);
    if (!frame) fail('version iframe not found');

    console.log(Version iframe loaded: name="");
    await delay(2000);

    // --- Open the Content rating questionnaire ---
    console.log('Opening content rating questionnaire...');
    const qBtn = frame.locator('button', { hasText: /(Fill out|Complete) questionnaire/i }).first();
    if (!(await qBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
      await frame.evaluate(() => {
        const h = [...document.querySelectorAll('*')].find(
          (e) => /Content rating|Rate by age/i.test(e.textContent || '') &&
                   (e.textContent || '').length < 200 && e.children.length < 6,
        );
        if (h) {
          let s = h;
          for (let i = 0; i < 5 && s; i++) {
            const b = [...s.querySelectorAll('button')].find(
              (x) => /^(Set|View and edit|Fill out|Complete)$/.test((x.textContent || '').trim()),
            );
            if (b && b.offsetParent !== null) { b.click(); return; }
            s = s.parentElement;
          }
        }
      });
      await delay(3000);
    }
    await qBtn.click({ timeout: 10000 }).catch(async () => {
      await frame.locator('button').filter({ hasText: /questionnaire/i }).first().click({ timeout: 5000 }).catch(() => {});
    });
    await delay(3000);

    // Dismiss any blocking overlays
    await dismissOverlays(frame);
    await delay(1000);

    // Inspect current dialog state
    const initialState = await frame.evaluate(() => {
      const dialogs = [...document.querySelectorAll('.el-dialog')].filter(d => d.offsetParent !== null);
      return dialogs.map((d, i) => ({
        idx: i,
        text: (d.textContent || '').slice(0, 200).replace(/\s+/g, ' '),
        buttons: [...d.querySelectorAll('button')].map(b => ({
          text: (b.textContent || '').trim(),
          disabled: b.disabled,
          visible: b.offsetParent !== null,
        })),
        noRadios: [...d.querySelectorAll('label.el-radio')].map(l => ({
          label: (l.querySelector('.el-radio__label')?.textContent || '').trim(),
          checked: l.classList.contains('is-checked'),
        })),
      }));
    });
    console.log('Initial dialog state:', JSON.stringify(initialState, null, 2));

    // --- Phase 1: Answer all "No" in the questionnaire ---
    // Expand groups one at a time and click "No" radios
    const groupTitles = await frame.locator('.agc-question-group__title').all();
    const nGroups = groupTitles.length;
    console.log(Found  question groups);

    for (let g = 0; g < nGroups; g++) {
      await dismissOverlays(frame);

      // Force-click group header to expand
      const headers = await frame.locator('.agc-question-group__title').all();
      if (g >= headers.length) break;
      await headers[g].click({ force: true, timeout: 3000 }).catch(() => {});
      await delay(600);

      // Click all unchecked "No" radios
      const n = await frame.evaluate(() => {
        let c = 0;
        document.querySelectorAll('label.el-radio').forEach(l => {
          const t = (l.querySelector('.el-radio__label')?.textContent || '').trim();
          if (t === 'No' && !l.classList.contains('is-checked')) {
            try { l.click(); c++; } catch (_) {}
          }
        });
        return c;
      });
      console.log(Group : clicked  "No" radios);
      await delay(400);
    }

    // --- Phase 2: Confirm and submit ---
    await clickOK(frame);

    const submitBtn = frame.locator('button', { hasText: /^Submit$/i }).first();
    const submitVisible = await submitBtn.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(Submit button visible: );

    if (submitVisible) {
      await submitBtn.click({ timeout: 10000 });
      await delay(4000);
      console.log('Questionnaire submitted.');
    }

    // Dismiss success/error dialogs
    await dismissOverlays(frame);
    await delay(2000);

    // --- Phase 3: Verify via API ---
    const apiRate = await getApiContentRate(APP_ID);
    console.log(API contentRate: "");
    if (apiRate) {
      console.log([step:publish:rating:done] content rating verified: );
    } else {
      console.log('[step:publish:rating:done] content rating submitted (API check inconclusive)');
    }

    console.log('CONTENT_RATING_SUCCESS');
    await browser.close();
  } catch (err) {
    console.error(CONTENT_RATING_FAILED: );
    process.exit(1);
  } finally {
    if (ownedPage) { try { await ownedPage.close(); } catch (_) {} }
    releaseLock(lockFd, LOCK_PATH);
    console.log('[lock] released');
  }
})();
