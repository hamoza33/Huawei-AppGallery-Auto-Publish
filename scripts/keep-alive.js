// Keeps the Huawei console session warm so the automation rarely has to log in
// (and thus rarely faces the slider CAPTCHA). Navigates the CDP browser to the
// AppGallery Connect home; if the session has expired it auto-logs in (solving
// the slider CAPTCHA via OpenCV). Intended to run on a short interval (cron/timer).
const { chromium } = require('playwright');
const fs = require('fs');
const { ensureLoggedIn } = require('./huawei-login-helper');

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const LOCK_PATH = '/tmp/huawei-cdp.lock';

// Best-effort one-shot lock: returns the FD if acquired, or null if the lock
// is held by another script. Never blocks, never throws on EEXIST.
function tryLock(path) {
  try {
    return fs.openSync(path, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    throw err;
  }
}

function releaseLock(fd, path) {
  try { if (fd != null) fs.closeSync(fd); } catch (_) {}
  try { fs.unlinkSync(path); } catch (_) {}
}

(async () => {
  // If content-rating / setup-app-info is currently driving the browser, skip
  // this round so we never reach into the page they own.
  const lockFd = tryLock(LOCK_PATH);
  if (lockFd == null) {
    console.log('keep-alive: lock busy, skipping');
    process.exit(0);
  }
  console.log('[lock] acquired');
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    const ctx = browser.contexts()[0];
    // Read-only: only touch pages we didn't create. Do not spawn a new page
    // here; if the context has no page, just verify connectivity and exit.
    const page = ctx.pages()[0];
    if (page) await ensureLoggedIn(page);
    console.log(`[keep-alive] ${new Date().toISOString()} session OK`);
    process.exit(0);
  } catch (err) {
    console.error(`[keep-alive] ${new Date().toISOString()} FAILED: ${err.message}`);
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    releaseLock(lockFd, LOCK_PATH);
    console.log('[lock] released');
  }
})();
