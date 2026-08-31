// Run from /Users/siddarthkotha/shadepath-app so playwright resolves:
//   cd /Users/siddarthkotha/shadepath-app
//   node /Users/siddarthkotha/countersign/docs/design/six-looks-2026-08-30/render.mjs
//
// (playwright lives in shadepath-app/node_modules; this script resolves it from
// shadepath-app's package.json explicitly so it works regardless of how it's invoked.)
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shadepathRequire = createRequire('/Users/siddarthkotha/shadepath-app/package.json');
const { chromium } = shadepathRequire('playwright');

const pages = [
  { file: '1-flight-deck.html', out: '1-flight-deck.png' },
  { file: '2-broadcast-control-room.html', out: '2-broadcast-control-room.png' },
  { file: '3-chain-of-custody.html', out: '3-chain-of-custody.png' },
  { file: '4-oscilloscope.html', out: '4-oscilloscope.png' },
  { file: '5-atc-strips.html', out: '5-atc-strips.png' },
  { file: '6-swiss-departure-board.html', out: '6-swiss-departure-board.png' },
];

const browser = await chromium.launch();
let anyErrors = false;

for (const p of pages) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(String(err)));

  const abs = path.join(__dirname, p.file);
  await page.goto('file://' + abs);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);

  const outPath = path.join(__dirname, p.out);
  await page.screenshot({ path: outPath });

  if (errors.length) {
    anyErrors = true;
    console.error(`[${p.file}] console errors:`, errors);
  } else {
    console.log(`[${p.file}] OK -> ${p.out}`);
  }
  await page.close();
}

await browser.close();

if (anyErrors) {
  console.error('One or more pages had console errors.');
  process.exit(1);
} else {
  console.log('All six pages rendered with zero console errors.');
}
