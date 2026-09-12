// Proof script for the two Countersign "talking profile" v2 pages.
// Run from a checkout that has playwright installed (NODE_PATH pointing at its node_modules).
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESIGN_DIR = __dirname;
const OUT_DIR = path.join(DESIGN_DIR, 'contact-v2');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PAGES = [
  { name: '3-chain-of-custody', file: '3-chain-of-custody-v2-talking.html' },
  { name: '4-oscilloscope', file: '4-oscilloscope-v2-talking.html' },
];

function fileUrl(p) { return 'file://' + p; }

async function captureOne(browser, pageDef) {
  const result = { name: pageDef.name, consoleErrors: [], checks: {} };
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') result.consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => { result.consoleErrors.push('pageerror: ' + err.message); });

  const url = fileUrl(path.join(DESIGN_DIR, pageDef.file));
  await page.goto(url);
  await page.waitForTimeout(300); // let fonts/layout settle

  // Sound toggled OFF before Play (per task instructions)
  const soundBtn = page.locator('[data-testid="sound"]');
  await soundBtn.click();
  const pressed = await soundBtn.getAttribute('aria-pressed');
  result.checks.soundToggledOff = pressed === 'false';

  const playBtn = page.locator('[data-testid="play"]');
  const clickTime = Date.now();
  await playBtn.click();

  async function waitUntil(targetSeconds) {
    const elapsed = (Date.now() - clickTime) / 1000;
    const remain = targetSeconds - elapsed;
    if (remain > 0) await page.waitForTimeout(remain * 1000);
  }
  async function lipsD() { return page.$eval('#csLips', (el) => el.getAttribute('d')); }
  async function shot(suffix) {
    await page.screenshot({ path: path.join(OUT_DIR, `${pageDef.name}-${suffix}.png`) });
  }

  await waitUntil(2.0);
  await shot('t2');
  const lips_t2_0 = await lipsD();

  await waitUntil(2.3);
  const lips_t2_3 = await lipsD();

  await waitUntil(4.6);
  await shot('t4_6');
  const lips_t4_6 = await lipsD();

  await waitUntil(6.0);
  const lips_t6_0 = await lipsD();

  await waitUntil(8.0);
  await shot('t8');

  await waitUntil(19.5);
  await shot('t19_5');

  result.checks.motion_2_0_vs_2_3_differ = lips_t2_0 !== lips_t2_3;
  result.checks.freeze_4_6_vs_6_0_identical = lips_t4_6 === lips_t6_0;
  result.lips = { t2_0: lips_t2_0, t2_3: lips_t2_3, t4_6: lips_t4_6, t6_0: lips_t6_0 };

  // wait for scene to finish and Replay to appear
  await waitUntil(20.6);
  const stateAfterEnd = await playBtn.getAttribute('data-state');
  const textAfterEnd = await playBtn.textContent();
  result.checks.replayAppeared = stateAfterEnd === 'replay' && /REPLAY/i.test(textAfterEnd || '');

  // click Replay, verify it runs again
  await playBtn.click();
  await page.waitForTimeout(250);
  const disabledDuringReplay = await playBtn.isDisabled();
  const stateDuringReplay = await playBtn.getAttribute('data-state');
  result.checks.replayWorks = disabledDuringReplay === true && stateDuringReplay === 'play';

  await context.close();

  // separate check: no horizontal scrollbar at 1280x800
  const context2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page2 = await context2.newPage();
  await page2.goto(url);
  await page2.waitForTimeout(300);
  const scrollCheck = await page2.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  result.checks.noHorizontalScrollbar_1280x800 = scrollCheck.scrollWidth <= scrollCheck.clientWidth + 1;
  result.scrollCheck = scrollCheck;
  await context2.close();

  return result;
}

async function captureVideo(browser) {
  const pageDef = PAGES[1]; // oscilloscope
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const url = fileUrl(path.join(DESIGN_DIR, pageDef.file));
  await page.goto(url);
  await page.waitForTimeout(300);
  await page.locator('[data-testid="play"]').click();
  await page.waitForTimeout(20800); // full 20.5s scene + margin
  const video = page.video();
  await context.close();
  const savedPath = await video.path();
  const finalPath = path.join(OUT_DIR, '4-oscilloscope-v2.webm');
  fs.renameSync(savedPath, finalPath);
  return finalPath;
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const p of PAGES) {
    const r = await captureOne(browser, p);
    results.push(r);
  }
  const videoPath = await captureVideo(browser);
  await browser.close();

  console.log('\n=== CAPTURE RESULTS ===');
  for (const r of results) {
    console.log(`\n-- ${r.name} --`);
    console.log('console errors:', r.consoleErrors.length, r.consoleErrors);
    console.log('checks:', JSON.stringify(r.checks, null, 2));
    console.log('lips d @2.0:', r.lips.t2_0);
    console.log('lips d @2.3:', r.lips.t2_3);
    console.log('lips d @4.6:', r.lips.t4_6);
    console.log('lips d @6.0:', r.lips.t6_0);
  }
  console.log('\nvideo saved to:', videoPath);

  const allOk = results.every(r =>
    r.consoleErrors.length === 0 &&
    r.checks.soundToggledOff &&
    r.checks.motion_2_0_vs_2_3_differ &&
    r.checks.freeze_4_6_vs_6_0_identical &&
    r.checks.noHorizontalScrollbar_1280x800 &&
    r.checks.replayAppeared &&
    r.checks.replayWorks
  );
  console.log('\nALL CHECKS PASS:', allOk);
  process.exit(allOk ? 0 : 1);
})();
