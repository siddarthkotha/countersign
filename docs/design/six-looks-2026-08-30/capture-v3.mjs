// Proof script for the Countersign "oscilloscope v3" page — live canvas trace + real
// profile. Run from a checkout that has playwright installed.
// Never runs more than 1 Chromium page at a time (RESOURCE ceiling: max 2 pages).
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// playwright lives in a checked-out project's node_modules — resolve it via NODE_PATH
// (run with NODE_PATH=<checkout>/node_modules).
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESIGN_DIR = __dirname;
const FILE = '4-oscilloscope-v3-talking.html';
const OUT_DIR = path.join(DESIGN_DIR, 'contact-v3');
fs.mkdirSync(OUT_DIR, { recursive: true });
const url = 'file://' + path.join(DESIGN_DIR, FILE);

function makeWaiter(clickTime) {
  return async function waitUntil(page, targetSeconds) {
    const elapsed = (Date.now() - clickTime) / 1000;
    const remain = targetSeconds - elapsed;
    if (remain > 0) await page.waitForTimeout(remain * 1000);
  };
}

async function ch2Hash(page) {
  return page.evaluate(() => {
    const c = document.getElementById('ch2Canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < d.length; i += 7) {
      h1 = ((h1 * 33) ^ d[i]) >>> 0;
      h2 = ((h2 * 17) + d[i]) >>> 0;
    }
    return h1.toString(16) + ':' + h2.toString(16);
  });
}
async function lipsD(page) { return page.$eval('#csLips', (elm) => elm.getAttribute('d')); }

(async () => {
  const browser = await chromium.launch();
  const consoleErrors = [];
  const results = {};

  // ---- PHASE A: stills (t=1.0,2.0,4.6,6.8,8.0,19.5) + diff checks (2.0/2.3, 4.6/6.0) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    await page.goto(url);
    await page.waitForTimeout(300);
    await page.locator('[data-testid="sound"]').click(); // sound off before Play (headless-safe)
    const clickTime = Date.now();
    await page.locator('[data-testid="play"]').click();
    const waitUntil = makeWaiter(clickTime);

    await waitUntil(page, 1.0);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v3-t1_0.png') });

    await waitUntil(page, 2.0);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v3-t2_0.png') });
    results.lips_2_0 = await lipsD(page);
    results.hash_2_0 = await ch2Hash(page);

    await waitUntil(page, 2.3);
    results.lips_2_3 = await lipsD(page);
    results.hash_2_3 = await ch2Hash(page);

    await waitUntil(page, 4.6);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v3-t4_6.png') });
    results.lips_4_6 = await lipsD(page);
    results.hash_4_6 = await ch2Hash(page);

    await waitUntil(page, 6.0);
    results.lips_6_0 = await lipsD(page);
    results.hash_6_0 = await ch2Hash(page);

    await waitUntil(page, 6.8);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v3-t6_8.png') });

    await waitUntil(page, 8.0);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v3-t8_0.png') });

    await waitUntil(page, 19.5);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v3-t19_5.png') });

    await ctx.close();
  }

  // ---- PHASE B: no horizontal scrollbar at 1280x800 ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    await page.goto(url);
    await page.waitForTimeout(300);
    const scroll = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    results.scroll = scroll;
    results.noHorizontalScrollbar = scroll.scrollWidth <= scroll.clientWidth + 1;
    await ctx.close();
  }

  // ---- PHASE C: 21s webm of the full scene ----
  {
    const ctx = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
    });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForTimeout(300);
    await page.locator('[data-testid="sound"]').click();
    await page.locator('[data-testid="play"]').click();
    await page.waitForTimeout(21000);
    const video = page.video();
    await ctx.close();
    const savedPath = await video.path();
    const finalPath = path.join(OUT_DIR, '4-oscilloscope-v3.webm');
    fs.renameSync(savedPath, finalPath);
    results.videoPath = finalPath;
  }

  // ---- PHASE D: 3x crop of the profile block ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForTimeout(300);
    await page.locator('[data-testid="sound"]').click();
    const clickTime = Date.now();
    await page.locator('[data-testid="play"]').click();
    const waitUntil = makeWaiter(clickTime);
    await waitUntil(page, 1.2); // mid-word, lively
    const box = await page.locator('.profile-block').boundingBox();
    await page.screenshot({ path: path.join(OUT_DIR, 'profile-3x.png'), clip: box });
    await ctx.close();
  }

  await browser.close();

  console.log('\n=== V3 CAPTURE RESULTS ===');
  console.log('console errors:', consoleErrors.length, consoleErrors);
  console.log('lips d @2.0:', results.lips_2_0);
  console.log('lips d @2.3:', results.lips_2_3);
  console.log('lips d @4.6:', results.lips_4_6);
  console.log('lips d @6.0:', results.lips_6_0);
  const lipsDiffer_2 = results.lips_2_0 !== results.lips_2_3;
  const lipsSame_46 = results.lips_4_6 === results.lips_6_0;
  console.log('lips differ 2.0 vs 2.3:', lipsDiffer_2);
  console.log('lips identical 4.6 vs 6.0:', lipsSame_46);
  console.log('ch2 hash @2.0:', results.hash_2_0);
  console.log('ch2 hash @2.3:', results.hash_2_3);
  console.log('ch2 hash @4.6:', results.hash_4_6);
  console.log('ch2 hash @6.0:', results.hash_6_0);
  const hashDiffer_2 = results.hash_2_0 !== results.hash_2_3;
  const hashSame_46 = results.hash_4_6 === results.hash_6_0;
  console.log('ch2 trace differs 2.0 vs 2.3:', hashDiffer_2);
  console.log('ch2 trace identical 4.6 vs 6.0:', hashSame_46);
  console.log('no horizontal scrollbar @1280x800:', results.noHorizontalScrollbar, results.scroll);
  console.log('video saved to:', results.videoPath);
  console.log('profile-3x saved to:', path.join(OUT_DIR, 'profile-3x.png'));

  const allOk = consoleErrors.length === 0 && lipsDiffer_2 && lipsSame_46 && hashDiffer_2 && hashSame_46 && results.noHorizontalScrollbar;
  console.log('\nALL CHECKS PASS:', allOk);
  process.exit(allOk ? 0 : 1);
})();
