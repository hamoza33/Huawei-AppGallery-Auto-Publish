const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readCaptchaGeometry(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const bg = document.querySelector('.yidun_bg-img');
    const piece = document.querySelector('.yidun_jigsaw');
    const slider = document.querySelector('.yidun_slider');
    if (!visible(bg) || !visible(piece) || !visible(slider)) return null;
    const br = bg.getBoundingClientRect();
    const sr = slider.getBoundingClientRect();
    return {
      bgSrc: bg.src,
      pieceSrc: piece.src,
      dispW: br.width,
      dispH: br.height,
      naturalW: bg.naturalWidth,
      sliderX: sr.x + sr.width / 2,
      sliderY: sr.y + sr.height / 2,
    };
  });
}

async function downloadTo(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
}

// Human-like drag: ease-in-out velocity, vertical jitter, small overshoot + settle.
async function humanDrag(page, startX, startY, distance) {
  await page.mouse.move(startX, startY, { steps: 3 });
  await sleep(rand(120, 260));
  await page.mouse.down();
  await sleep(rand(60, 140));

  const steps = Math.round(rand(28, 46));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const x = startX + distance * eased;
    const y = startY + (Math.random() - 0.5) * 3;
    await page.mouse.move(x, y);
    await sleep(rand(6, 22));
  }
  // slight overshoot then settle back onto the target
  await page.mouse.move(startX + distance + rand(2, 5), startY + rand(-1, 1));
  await sleep(rand(50, 110));
  await page.mouse.move(startX + distance, startY);
  await sleep(rand(90, 180));
  await page.mouse.up();
}

async function captchaVisible(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.yidun_bg-img');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

// Classify the outcome after a drag: 'success' | 'failed' | 'pending'.
// Uses the Yidun tips text plus a stable (double-sampled) check of whether the
// puzzle is still on screen, so a transient re-render is not read as success.
async function checkOutcome(page) {
  const sample = () => page.evaluate(() => {
    const tips = [...document.querySelectorAll('[class*="yidun_tips"]')]
      .map((el) => (el.textContent || '').trim()).filter(Boolean).join(' | ');
    const bg = document.querySelector('.yidun_bg-img');
    const bgVisible = !!bg && (() => { const r = bg.getBoundingClientRect(); return r.width > 0 && r.height > 0; })();
    return { tips, bgVisible };
  });

  const a = await sample();
  if (/pass|success|通过|成功/i.test(a.tips)) return 'success';
  if (/fail|again|error|失败|重试|错误/i.test(a.tips)) return 'failed';

  // No explicit tip: confirm the puzzle is gone with a second sample.
  await sleep(700);
  const b = await sample();
  if (!a.bgVisible && !b.bgVisible) return 'success';
  return b.bgVisible ? 'failed' : 'pending';
}

async function refreshCaptcha(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('.yidun_refresh, .yidun_control .yidun_refresh, .yidun_tips__answer');
    if (btn) btn.click();
  });
}

/**
 * Detect and solve a NetEase Yidun sliding-puzzle CAPTCHA on the page.
 * Returns true if solved (or none present), false if it could not be solved.
 */
async function solveSliderCaptcha(page, opts = {}) {
  const log = opts.onLog || ((l) => console.log(l));
  const solverPath = path.join(__dirname, 'solve-slider.py');
  const maxAttempts = opts.maxAttempts || 6;

  if (!(await captchaVisible(page))) return true;
  log('Slider CAPTCHA detected — solving with OpenCV...');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const geo = await readCaptchaGeometry(page);
    if (!geo) {
      log('CAPTCHA no longer present — solved.');
      return true;
    }

    const bgFile = path.join(os.tmpdir(), `yidun_bg_${Date.now()}.jpg`);
    const pieceFile = path.join(os.tmpdir(), `yidun_piece_${Date.now()}.png`);
    try {
      await downloadTo(geo.bgSrc, bgFile);
      await downloadTo(geo.pieceSrc, pieceFile);
    } catch (e) {
      log(`Attempt ${attempt}: image download failed: ${e.message}`);
      await refreshCaptcha(page);
      await sleep(1500);
      continue;
    }

    let solution;
    try {
      const { stdout } = await execFileAsync('python3', [solverPath, bgFile, pieceFile], { timeout: 20000 });
      solution = JSON.parse(stdout.trim());
    } catch (e) {
      log(`Attempt ${attempt}: solver error: ${e.message}`);
      await refreshCaptcha(page);
      await sleep(1500);
      continue;
    } finally {
      fs.rmSync(bgFile, { force: true });
      fs.rmSync(pieceFile, { force: true });
    }

    if (solution.error) {
      log(`Attempt ${attempt}: ${solution.error}`);
      await refreshCaptcha(page);
      await sleep(1500);
      continue;
    }

    const scale = geo.dispW / solution.bg_w;
    const distance = solution.slide_natural * scale;
    log(`Attempt ${attempt}: gap@${solution.gap_x_natural}px (score ${solution.score}) -> slide ${distance.toFixed(1)}px`);

    await humanDrag(page, geo.sliderX, geo.sliderY, distance);
    await sleep(rand(1200, 1800));

    let outcome;
    try {
      outcome = await checkOutcome(page);
    } catch (e) {
      // A destroyed execution context / navigation means the login page moved
      // on after the CAPTCHA passed — treat that as success.
      if (/context was destroyed|navigation|Target closed|detached/i.test(e.message)) {
        log('CAPTCHA solved (login navigated away).');
        return true;
      }
      throw e;
    }
    if (outcome === 'success') {
      log('CAPTCHA solved.');
      return true;
    }

    log(`Attempt ${attempt} did not pass (${outcome}) — retrying with a fresh puzzle.`);
    // On failure Yidun usually resets the same puzzle; refresh to get a new one.
    await refreshCaptcha(page);
    await sleep(rand(1400, 2200));
  }

  log(`Failed to solve slider CAPTCHA after ${maxAttempts} attempts.`);
  return false;
}

module.exports = { solveSliderCaptcha };
