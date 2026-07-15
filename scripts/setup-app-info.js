// Setup app-info: countries, category, privacy policy via CDP automation
// Usage: node scripts/setup-app-info.js <appId> [cdpUrl]
// Load .env manually
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
const path = require('path');
const { ensureLoggedIn } = require('./huawei-login-helper');

const APP_ID = process.argv[2];
const CDP_URL = process.argv[3] || process.env.CDP_URL || 'http://localhost:9222';

if (!APP_ID) {
  console.error('Usage: node scripts/setup-app-info.js <appId> [cdpUrl]');
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

// Wait for login session to fully settle after ensureLoggedIn completes.
async function waitForSessionSettled(page, maxWaitMs = 30000) {
  console.log('[login-settle] Waiting for session to settle after login...');
  const deadline = Date.now() + maxWaitMs;
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  } catch (_) {}
  await delay(4000);
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
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  } catch (_) {}
  const finalUrl = page.url();
  console.log([login-settle] Session settled at: );
  if (/login|cas|auth/i.test(finalUrl)) {
    console.error('[login-settle] Session did not settle ? still on auth page.');
  }
}

// Set category via API (game: parentType= GAME, childType= CASUAL_GAME)
async function setCategoryViaApi() {
  const { HUAWEI_AGC_CLIENT_ID, HUAWEI_AGC_CLIENT_SECRET } = process.env;
  if (!HUAWEI_AGC_CLIENT_ID || !HUAWEI_AGC_CLIENT_SECRET) {
    console.warn('AGC credentials not set; skipping category API');
    return;
  }
  const tr = await fetch('https://connect-api.cloud.huawei.com/api/oauth2/v1/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: HUAWEI_AGC_CLIENT_ID, client_secret: HUAWEI_AGC_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const td = await tr.json();
  const token = td.access_token;
  if (!token) { console.warn('Could not get API token for category'); return; }

  const CATEGORY = {
    defaultLang: 'en-US',
    parentType: 'GAME',
    childType: 'CASUAL_GAME',
    publishCountry: ['AB', 'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW'],
    privacyPolicy: 'https://example.com/privacy',
    isFree: true,
  };

  const put = await fetch(https://connect-api.cloud.huawei.com/api/publish/v2/app-info?appId=, {
    method: 'PUT', headers: { 'Authorization': Bearer , 'client_id': HUAWEI_AGC_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(CATEGORY),
  });
  const body = await put.json().catch(() => ({}));
  console.log(API category set: code= msg=);
}


// Find the frame whose body contains a given text.
async function findFrame(page, needle) {
  for (const f of page.frames()) {
    try {
      const has = await f.evaluate((n) => document.body && document.body.innerText.includes(n), needle);
      if (has) return f;
    } catch (_) {}
  }
  return null;
}


async function verFrame(page) {
  const URL_HINT = /appVersion|app-version|distribute\/appVersion/i;
  let best = null, len = 0;
  for (const fr of page.frames()) {
    if (!URL_HINT.test(fr.url())) continue;
    let t = 0;
    try { t = await fr.evaluate(() => (document.body ? document.body.innerText.length : 0)); } catch (_) {}
    if (t > len) { len = t; best = fr; }
  }
  return len > 500 ? best : null;
}


// Click the "Draft" version in the sidebar.
const DRAFT_RE = /\b(?:Draft|??|New draft|???)\b/i;
async function clickDraftSidebar(page) {
  return await page.evaluate((rxSrc) => {
    const rx = new RegExp(rxSrc);
    const candidates = [...document.querySelectorAll('span.version-title, li.el-menu-item, li.base-menu-item__third')];
    const pick = candidates.find((el) => rx.test((el.textContent || '').trim()));
    if (!pick) return { ok: false, text: null };
    pick.click();
    return { ok: true, text: (pick.textContent || '').trim() };
  }, DRAFT_RE.source);
}


async function clickOK(f) {
  try {
    await f.evaluate(() => {
      document.querySelectorAll('.el-message-box__btns button, button').forEach((b) => {
        const t = (b.textContent || '').trim();
        if ((t === 'OK' || t === 'Confirm') && b.offsetWidth > 0) b.click();
      });
    });
  } catch (_) {}
  await delay(1200);
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
    console.log(Connecting to Chrome CDP at ...);
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0];
    const page = await context.newPage();
    ownedPage = page;
    await ensureLoggedIn(page);

    // FIX: Wait for login session to fully settle before navigating
    await waitForSessionSettled(page);

  await setCategoryViaApi();


  // ---- App Information page: compatible devices + Casual game ----
  const appInfoUrl = https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp//97458334310914199;
  console.log(Navigating to App Information: );
  await page.goto(appInfoUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await delay(6000);


  let infoFrame = null;
  for (let i = 0; i < 12; i++) {
    infoFrame = (await findFrame(page, 'Compatible devices')) || (await findFrame(page, 'Categorization'));
    if (infoFrame) break;
    await delay(3000);
  }
  if (!infoFrame) fail('App Information page did not load (Compatible devices section not found)');
  console.log(App Info frame: );

  // Dismiss guide overlays / popups.
  for (const f of [infoFrame, page.mainFrame()]) {
    try {
      await f.evaluate(() => {
        document.querySelectorAll('label.el-checkbox').forEach((l) => { if (/Do not show again/i.test(l.textContent || '')) l.click(); });
        document.querySelectorAll('button,span,a').forEach((b) => {
          const t = (b.textContent || '').trim();
          if (['I know', 'Got it', 'Close', 'Skip', 'Finish'].includes(t) && b.offsetWidth > 0) b.click();
        });
      });
    } catch (_) {}
  }
  await delay(1500);


  const devices = await infoFrame.evaluate(() => {
    const out = {};
    for (const name of ['Mobile phone', 'Tablet']) {
      const box = [...document.querySelectorAll('label.el-checkbox')].find(
        (l) => (l.querySelector('.el-checkbox__label')?.textContent || '').trim() === name,
      );
      if (!box) { out[name] = 'not-found'; continue; }
      const checked = box.classList.contains('is-checked');
      if (!checked) box.click();
      out[name] = checked ? 'already' : 'clicked';
    }
    return out;
  });
  console.log(Compatible devices: );
  await delay(1000);


  const casual = await infoFrame.evaluate(() => {
    const r = [...document.querySelectorAll('label.el-radio')].find(
      (l) => (l.querySelector('.el-radio__label')?.textContent || '').trim() === 'Casual game',
    );
    if (!r) return 'not-found';
    const checked = r.classList.contains('is-checked');
    if (!checked) r.click();
    return checked ? 'already' : 'clicked';
  });
  console.log(Casual game: );
  await delay(1000);


  const saved = await infoFrame.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent || '').trim() === 'Save' && !x.disabled && x.offsetWidth > 0,
    );
    if (b) { b.click(); return true; }
    return false;
  });
  console.log(App Info Save clicked: );
  await delay(3500);
  await clickOK(infoFrame);
  await delay(2000);


  const devVerify = await infoFrame.evaluate(() => {
    return [...document.querySelectorAll('label.el-checkbox')]
      .filter((l) => l.classList.contains('is-checked'))
      .map((l) => (l.querySelector('.el-checkbox__label')?.textContent || '').trim());
  });
  console.log(Devices checked after save: );
  if (!devVerify.includes('Mobile phone') || !devVerify.includes('Tablet')) {
    fail(compatible devices not set (Mobile phone + Tablet). Got: );
  }


  // ---- Version page: distribution countries (all except Chinese mainland) ----
  console.log('Opening Draft version page for countries...');
  const clickResult = await clickDraftSidebar(page);
  console.log(Clicked Draft: ok= text="");


  let vf = null;
  for (let i = 0; i < 14; i++) { await delay(4000); vf = await verFrame(page); if (vf) break; }
  if (!vf) fail('appVersion iframe not found (version page did not load)');


  const radio = await vf.evaluate(() => {
    const r = [...document.querySelectorAll('label.el-radio')].find(
      (l) => (l.querySelector('.el-radio__label')?.textContent || '').trim() === 'Selected countries/regions',
    );
    if (!r) return 'not-found';
    if (!r.classList.contains('is-checked')) r.click();
    return 'ok';
  });
  console.log(Selected countries/regions radio: );
  if (radio === 'not-found') fail('country selection radio not found on version page');
  await delay(3500);


  const allBox = await vf.evaluate(() => {
    const all = [...document.querySelectorAll('label.el-checkbox')].find(
      (l) => (l.querySelector('.el-checkbox__label')?.textContent || '').trim() === 'All',
    );
    if (!all) return 'not-found';
    if (!all.classList.contains('is-checked')) all.click();
    return 'ok';
  });
  console.log(All countries checkbox: );
  await delay(2500);


  const china = await vf.evaluate(() => {
    const cn = [...document.querySelectorAll('label.el-checkbox')].find(
      (l) => /Chinese mainland/i.test(l.querySelector('.el-checkbox__label')?.textContent || ''),
    );
    if (!cn) return 'not-found';
    const was = cn.classList.contains('is-checked');
    if (was) cn.click();
    return was ? 'unchecked' : 'already-off';
  });
  console.log(Chinese mainland: );
  await delay(2500);


  const countrySaved = await vf.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent || '').trim() === 'Save' && !x.disabled && x.offsetWidth > 0,
    );
    if (b) { b.click(); return true; }
    return false;
  });
  console.log(Countries Save clicked: );
  if (!countrySaved) fail('country Save button was disabled/not found (selection did not register)');
  await delay(4000);
  for (let i = 0; i < 4; i++) { await clickOK(vf); }


  const after = await vf.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Save');
    const cn = [...document.querySelectorAll('label.el-checkbox')].find(
      (l) => /Chinese mainland/i.test(l.querySelector('.el-checkbox__label')?.textContent || ''),
    );
    return { saveDisabled: b ? b.disabled : null, chinaChecked: cn ? cn.classList.contains('is-checked') : null };
  });
  console.log(After save: );
  if (after.chinaChecked === true) fail('Chinese mainland is still selected after save');
  if (after.saveDisabled === false) fail('Save still enabled after save ? country change did not persist');


  console.log('APP_INFO_SETUP_SUCCESS');
  await browser.close();
  } catch (err) {
    console.error(APP_INFO_SETUP_FAILED: );
    process.exit(1);
  } finally {
    if (ownedPage) { try { await ownedPage.close(); } catch (_) {} }
    releaseLock(lockFd, LOCK_PATH);
    console.log('[lock] released');
  }
})();
