// Builds index.html with all images embedded as base64 data URIs (no external src).
// Run with: node build-index.mjs   (from anywhere; only uses core node, no deps)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const thumbs = path.join(__dirname, 'thumbs');

function b64(file, mime){
  const buf = fs.readFileSync(file);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const looks = [
  {
    n: 1,
    file: '1-flight-deck.html',
    label: '1 · Cockpit instrument panel',
    render: b64(path.join(thumbs, '1-flight-deck-render.jpg'), 'image/jpeg'),
    photo: b64(path.join(thumbs, '1-photo.jpg'), 'image/jpeg'),
  },
  {
    n: 2,
    file: '2-broadcast-control-room.html',
    label: '2 · TV control room',
    render: b64(path.join(thumbs, '2-broadcast-control-room-render.jpg'), 'image/jpeg'),
    photo: b64(path.join(thumbs, '2-photo.jpg'), 'image/jpeg'),
  },
  {
    n: 3,
    file: '3-chain-of-custody.html',
    label: '3 · Signed evidence record',
    render: b64(path.join(thumbs, '3-chain-of-custody-render.jpg'), 'image/jpeg'),
    photo: b64(path.join(thumbs, '3-photo.jpg'), 'image/jpeg'),
  },
  {
    n: 4,
    file: '4-oscilloscope.html',
    label: '4 · Oscilloscope',
    render: b64(path.join(thumbs, '4-oscilloscope-render.jpg'), 'image/jpeg'),
    photo: b64(path.join(thumbs, '4-photo.jpg'), 'image/jpeg'),
  },
  {
    n: 5,
    file: '5-atc-strips.html',
    label: '5 · Air-traffic paper strips',
    render: b64(path.join(thumbs, '5-atc-strips-render.jpg'), 'image/jpeg'),
    photo: b64(path.join(thumbs, '5-photo.jpg'), 'image/jpeg'),
  },
  {
    n: 6,
    file: '6-swiss-departure-board.html',
    label: '6 · Train departure board',
    render: b64(path.join(thumbs, '6-swiss-departure-board-render.jpg'), 'image/jpeg'),
    photo: b64(path.join(thumbs, '6-photo.jpg'), 'image/jpeg'),
  },
];

const cards = looks.map(l => `
      <div class="card">
        <a href="${l.file}"><img class="render" src="${l.render}" alt="${l.label} rendering of the Countersign screen"></a>
        <div class="label">${l.label}</div>
        <a class="open-link" href="${l.file}">Open this page</a>
        <div class="borrowed">
          <img class="thumb" src="${l.photo}" alt="Reference photo this look borrows from">
          <div class="borrowed-caption">Borrowed from this photo</div>
        </div>
      </div>`).join('\n');

const html = `<meta charset="UTF-8">
<title>Countersign: six looks</title>
<style>
  *{box-sizing:border-box;}
  body{
    margin:0;background:#fbfbfa;color:#1a1a1a;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    padding:48px 40px 64px;
  }
  .wrap{max-width:1240px;margin:0 auto;}
  h1{font-size:28px;font-weight:600;margin:0 0 10px;letter-spacing:.2px;}
  .intro{font-size:16px;color:#444;margin:0 0 36px;line-height:1.5;border-bottom:1px solid #ddd;padding-bottom:24px;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:40px 32px;}
  .card{border-top:1px solid #ddd;padding-top:20px;}
  .render{width:100%;height:auto;display:block;border:1px solid #ddd;}
  .render:hover{border-color:#999;}
  .label{font-size:18px;font-weight:600;margin:14px 0 6px;}
  .open-link{font-size:16px;color:#1a1a1a;text-decoration:underline;text-underline-offset:3px;}
  .borrowed{display:flex;align-items:center;gap:12px;margin-top:18px;padding-top:16px;border-top:1px solid #eee;}
  .thumb{width:120px;height:auto;border:1px solid #ddd;display:block;flex:none;}
  .borrowed-caption{font-size:16px;color:#666;}
  .pick{margin-top:56px;padding-top:24px;border-top:1px solid #ddd;font-size:16px;color:#444;}
  @media (max-width:900px){ .grid{grid-template-columns:1fr;} }
</style>
<div class="wrap">
  <h1>Countersign: six looks</h1>
  <p class="intro">Same screen, same moment (the wire is frozen), six looks. Click a picture to open that page.</p>
  <div class="grid">${cards}
  </div>
  <p class="pick">Claude's pick: 3, the signed record, because the record is the product and the frozen stamp is the image judges keep.</p>
</div>
`;

fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('index.html written, bytes:', Buffer.byteLength(html));
