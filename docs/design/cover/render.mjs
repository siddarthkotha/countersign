// Archival render script. This repo has no Playwright dependency; run it from any
// checkout that has Playwright installed by pointing PLAYWRIGHT_PKG_JSON at that
// checkout's package.json, for example:
//   PLAYWRIGHT_PKG_JSON=/path/to/some-project/package.json node docs/design/cover/render.mjs
// (same approach as docs/design/six-looks-2026-08-30/render.mjs).
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgJson = process.env.PLAYWRIGHT_PKG_JSON;
if (!pkgJson) {
  console.error('Set PLAYWRIGHT_PKG_JSON to the package.json of a checkout that has playwright installed.');
  process.exit(1);
}
const externalRequire = createRequire(pkgJson);
const { chromium } = externalRequire('playwright');

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
