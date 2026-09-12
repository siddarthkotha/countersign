// Run from /Users/siddarthkotha/shadepath-app so playwright resolves:
//   cd /Users/siddarthkotha/shadepath-app
//   node /Users/siddarthkotha/countersign/docs/design/cover/render.mjs
//
// (playwright lives in shadepath-app/node_modules; this script resolves it from
// shadepath-app's package.json explicitly, same approach as
// docs/design/six-looks-2026-08-30/render.mjs, so it works regardless of how it's
// invoked and without an npm install in this repo.)
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shadepathRequire = createRequire('/Users/siddarthkotha/shadepath-app/package.json');
const { chromium } = shadepathRequire('playwright');

const pages = [
  { file: 'cover-1.html', out: 'cover-1.png' },
  { file: 'cover-2.html', out: 'cover-2.png' },
  { file: 'cover-3.html', out: 'cover-3.png' },
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
  console.log('All three cover candidates rendered with zero console errors.');
}
