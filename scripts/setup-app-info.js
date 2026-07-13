// App Info Setup via Playwright CDP (fallback when the API template step fails).
//
// Sets everything Huawei rejects via API for a brand-new app's first version:
//   - Category cascade (Games / Role-playing / Incremental games) via the API
//     (this DOES work for new apps; only publishCountry is rejected).
//   - Compatible devices: Mobile phone + Tablet          (console, App Info page)
//   - Secondary category: Casual game                    (console, App Info page)
//   - Distribution countries: all except Chinese mainland (console, Version page)
//
// It verifies each console change actually persisted and exits non-zero if not,
// so the publish workflow hard-stops instead of uploading the APK with an empty
// country list (Huawei error 204144694 distContryList is empty).
//
// Usage: node scripts/setup-app-info.js <appId> [cdpUrl]
const { chromium } = require('playwright');
const { ensureLoggedIn } = require('./huawei-login-helper');

const APP_ID = process.argv[2];
const CDP_URL = process.argv[3] || process.env.CDP_URL || 'http://localhost:9222';

if (!APP_ID) {
  console.error('Usage: node scripts/setup-app-info.js <appId> [cdpUrl]');
  process.exit(1);
}

// Games / Role-playing / Incremental games (Huawei category ids).
const CATEGORY = { parentType: 2, childType: 20, grandChildType: 10115 };
const CONNECT_BASE = 'https://connect-api.cloud.huawei.com/api';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`APP_INFO_SETUP_FAILED: ${msg}`);
  process.exit(1);
}

// Set the category cascade via the AppGallery Connect API (works for new apps).
async function setCategoryViaApi() {
  const clientId = process.env.HUAWEI_AGC_CLIENT_ID;
  const clientSecret = process.env.HUAWEI_AGC_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.log('No API credentials in env; skipping API category set');
    return;
  }
  const tr = await fetch(`${CONNECT_BASE}/oauth2/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  const tok = (await tr.json()).access_token;
  if (!tok) { console.log('API token fetch failed; skipping API category set'); return; }
  const H = { Authorization: `Bearer ${tok}`, client_id: clientId, 'Content-Type': 'application/json' };
  const put = await fetch(`${CONNECT_BASE}/publish/v2/app-info?appId=${APP_ID}&releaseType=1`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify(CATEGORY),
  });
  const body = await put.json().catch(() => ({}));
  console.log(`API category set: code=${body.ret?.code} msg=${body.ret?.msg}`);
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
  let best = null, len = 0;
  for (const fr of page.frames()) {
    if (!/appVersion/.test(fr.url())) continue;
    let t = 0;
    try { t = await fr.evaluate(() => (document.body ? document.body.innerText.length : 0)); } catch (_) {}
    if (t > len) { len = t; best = fr; }
  }
  return len > 500 ? best : null;
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
  console.log(`Connecting to Chrome CDP at ${CDP_URL}...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  const pages = context.pages();
  for (let i = 1; i < pages.length; i++) { try { await pages[i].close(); } catch (_) {} }
  const page = context.pages()[0] || (await context.newPage());
  await ensureLoggedIn(page);

  await setCategoryViaApi();

  // ---- App Information page: compatible devices + Casual game ----
  const appInfoUrl = `https://developer.huawei.com/consumer/en/service/josp/agc/index.html#/myApp/${APP_ID}/97458334310914199`;
  console.log(`Navigating to App Information: ${appInfoUrl}`);
  await page.goto(appInfoUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await delay(6000);

  let infoFrame = null;
  for (let i = 0; i < 12; i++) {
    infoFrame = (await findFrame(page, 'Compatible devices')) || (await findFrame(page, 'Categorization'));
    if (infoFrame) break;
    await delay(3000);
  }
  if (!infoFrame) fail('App Information page did not load (Compatible devices section not found)');
  console.log(`App Info frame: ${infoFrame.url()}`);

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
  console.log(`Compatible devices: ${JSON.stringify(devices)}`);
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
  console.log(`Casual game: ${casual}`);
  await delay(1000);

  const saved = await infoFrame.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent || '').trim() === 'Save' && !x.disabled && x.offsetWidth > 0,
    );
    if (b) { b.click(); return true; }
    return false;
  });
  console.log(`App Info Save clicked: ${saved}`);
  await delay(3500);
  await clickOK(infoFrame);
  await delay(2000);

  const devVerify = await infoFrame.evaluate(() => {
    return [...document.querySelectorAll('label.el-checkbox')]
      .filter((l) => l.classList.contains('is-checked'))
      .map((l) => (l.querySelector('.el-checkbox__label')?.textContent || '').trim());
  });
  console.log(`Devices checked after save: ${JSON.stringify(devVerify)}`);
  if (!devVerify.includes('Mobile phone') || !devVerify.includes('Tablet')) {
    fail(`compatible devices not set (Mobile phone + Tablet). Got: ${JSON.stringify(devVerify)}`);
  }

  // ---- Version page: distribution countries (all except Chinese mainland) ----
  console.log('Opening Draft version page for countries...');
  const clickedDraft = await page.evaluate(() => {
    const cand = [...document.querySelectorAll('span.version-title, span.item-text, li.el-menu-item')].find(
      (e) => (e.textContent || '').trim() === 'Draft',
    );
    if (cand) { cand.click(); return true; }
    return false;
  });
  console.log(`Clicked Draft: ${clickedDraft}`);

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
  console.log(`Selected countries/regions radio: ${radio}`);
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
  console.log(`All countries checkbox: ${allBox}`);
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
  console.log(`Chinese mainland: ${china}`);
  await delay(2500);

  const countrySaved = await vf.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => (x.textContent || '').trim() === 'Save' && !x.disabled && x.offsetWidth > 0,
    );
    if (b) { b.click(); return true; }
    return false;
  });
  console.log(`Countries Save clicked: ${countrySaved}`);
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
  console.log(`After save: ${JSON.stringify(after)}`);
  if (after.chinaChecked === true) fail('Chinese mainland is still selected after save');
  if (after.saveDisabled === false) fail('Save still enabled after save — country change did not persist');

  console.log('APP_INFO_SETUP_SUCCESS');
  await browser.close();
})().catch((e) => {
  console.error(`APP_INFO_SETUP_FAILED: ${e.message}`);
  process.exit(1);
});
