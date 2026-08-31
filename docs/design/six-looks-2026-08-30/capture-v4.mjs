// Proof script for the Countersign "oscilloscope v4" page — live canvas trace + a
// REAL traced human profile (STATIC/LIPS/JAW segments, replacing v3's hand-drawn
// silhouette). Run from /Users/siddarthkotha/shadepath-app so playwright resolves.
// Never runs more than 1 Chromium page at a time (RESOURCE ceiling: max 2 pages).
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
// playwright lives in shadepath-app/node_modules, not here — resolve it via NODE_PATH
// (run with NODE_PATH=/Users/siddarthkotha/shadepath-app/node_modules).
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const DESIGN_DIR = '/Users/siddarthkotha/countersign/docs/design/six-looks-2026-08-30';
const FILE = '4-oscilloscope-v4-talking.html';
const OUT_DIR = path.join(DESIGN_DIR, 'contact-v4');
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
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v4-t1_0.png') });

    await waitUntil(page, 2.0);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v4-t2_0.png') });
    results.lips_2_0 = await lipsD(page);
    results.hash_2_0 = await ch2Hash(page);

    await waitUntil(page, 2.3);
    results.lips_2_3 = await lipsD(page);
    results.hash_2_3 = await ch2Hash(page);

    await waitUntil(page, 4.6);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v4-t4_6.png') });
    results.lips_4_6 = await lipsD(page);
    results.hash_4_6 = await ch2Hash(page);

    await waitUntil(page, 6.0);
    results.lips_6_0 = await lipsD(page);
    results.hash_6_0 = await ch2Hash(page);

    await waitUntil(page, 6.8);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v4-t6_8.png') });

    await waitUntil(page, 8.0);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v4-t8_0.png') });

    await waitUntil(page, 19.5);
    await page.screenshot({ path: path.join(OUT_DIR, '4-oscilloscope-v4-t19_5.png') });

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
    const finalPath = path.join(OUT_DIR, '4-oscilloscope-v4.webm');
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

  // ---- PHASE E: source-vs-trace side-by-side (so the orchestrator can see the trace
  // is faithful to the real photo it was walked from) ----
  {
    const SCRATCH = '/private/tmp/claude-501/-Users-siddarthkotha-shadepath-app/dcff9dfe-cb00-4bda-9bdd-0338126b90ec/scratchpad';
    const sourceImg = fs.readFileSync(path.join(SCRATCH, 'hubard-source-crop.jpg'));
    const sourceB64 = 'data:image/jpeg;base64,' + sourceImg.toString('base64');
    const traceSvg = fs.readFileSync(path.join(DESIGN_DIR, 'profile-trace.svg'), 'utf8');
    const html = `<!doctype html><html><head><style>
      html,body{margin:0;background:#111;}
      .row{display:flex;align-items:flex-start;}
      .col{width:520px;padding:16px;box-sizing:border-box;}
      img,svg{width:488px;height:auto;display:block;background:#0a0d0b;}
      .lbl{color:#9fd;font:14px monospace;margin-bottom:8px;}
      </style></head><body>
      <div class="row">
        <div class="col"><div class="lbl">SOURCE (cropped) — Wikimedia Commons, William James Hubard, Public domain</div><img src="${sourceB64}"></div>
        <div class="col"><div class="lbl">TRACED OUTLINE (this file's profile-trace.svg)</div>${traceSvg}</div>
      </div>
      </body></html>`;
    const tmpHtml = path.join(OUT_DIR, '_source-and-trace.html');
    fs.writeFileSync(tmpHtml, html);
    const ctx = await browser.newContext({ viewport: { width: 1060, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto('file://' + tmpHtml);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT_DIR, 'source-and-trace.png') });
    await ctx.close();
    fs.unlinkSync(tmpHtml);
  }

  await browser.close();

  console.log('\n=== V4 CAPTURE RESULTS ===');
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
  console.log('source-and-trace saved to:', path.join(OUT_DIR, 'source-and-trace.png'));

  const allOk = consoleErrors.length === 0 && lipsDiffer_2 && lipsSame_46 && hashDiffer_2 && hashSame_46 && results.noHorizontalScrollbar;
  console.log('\nALL CHECKS PASS:', allOk);
  process.exit(allOk ? 0 : 1);
})();
