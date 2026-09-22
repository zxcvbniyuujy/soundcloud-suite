// Store graphics: five 1280×800 screenshots, the 440×280 tile and the 1400×560 marquee, composed from the 2× UI
// captures in store/raw. One system: a brand-orange column carries the message, the real UI floats over the seam.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { svg } = require('./logo');
const RAW = path.join(__dirname, 'raw'), OUT = path.resolve(__dirname, '..', '..', 'store');
fs.mkdirSync(OUT, { recursive: true });
const rects = JSON.parse(fs.readFileSync(path.join(RAW, 'rects.json'), 'utf8'));
const PAD = 28, ORANGE = '#FF5500';
const dataUri = (name) => 'data:image/png;base64,' + fs.readFileSync(path.join(RAW, name + '.png')).toString('base64');
const markSvg = (px, fill, badge, plus) => svg(512, { fill, badge, plus }).replace(/width="\d+" height="\d+"/, `width="${px}" height="${Math.round(px * 15.8 / 34.2)}"`);
// a hub / popover capture shown at 1× CSS size with its padding trimmed and its corners rounded: a clean floating card
const card = (name, radius = 22, extra = '') => { const r = rects[name]; const w = r.width - PAD * 2, h = r.height - PAD * 2; return `<div class="card" style="width:${w}px;height:${h}px;border-radius:${radius}px;${extra}"><img src="${dataUri(name)}" style="width:${r.width}px;height:${r.height}px;margin:-${PAD}px 0 0 -${PAD}px"></div>`; };
// a card cut straight out of a full-page 2× capture, by its CSS-pixel rect
const cardFrom = (name, x, y, w, h, radius = 22, extra = '') => `<div class="card" style="width:${w}px;height:${h}px;border-radius:${radius}px;background:url(${dataUri(name)}) -${x}px -${y}px / 1280px 800px no-repeat;${extra}"></div>`;
// a full-page capture inside a slim browser frame, scaled to `w`
const frame = (name, w, extra = '') => { const s = w / 1280; return `<div class="frame" style="width:${w}px;${extra}"><div class="chrome"><i></i><i></i><i></i><b>soundcloud.com</b></div><div style="width:${w}px;height:${Math.round(800 * s)}px;overflow:hidden"><img src="${dataUri(name)}" style="width:${w}px;height:${Math.round(800 * s)}px;display:block"></div></div>`; };
const CSS = `
@font-face { font-family: Inter; src: local('Inter'), local('InterVariable'); }
* { box-sizing: border-box; margin: 0; }
body { font-family: Inter, system-ui, sans-serif; background: #fff; -webkit-font-smoothing: antialiased; }
.stage { position: relative; overflow: hidden; background: #F5F4F2; }
.band { position: absolute; left: 0; top: 0; bottom: 0; background: ${ORANGE}; }
.copy { position: absolute; left: 64px; top: 72px; color: #fff; }
.eyebrow { font-size: 15px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; opacity: .82; margin-bottom: 22px; }
h1 { font-size: 58px; line-height: 1.02; font-weight: 800; letter-spacing: -.035em; max-width: 440px; }
.sub { font-size: 20px; line-height: 1.42; font-weight: 500; max-width: 420px; margin-top: 26px; opacity: .94; }
.brand { position: absolute; left: 64px; bottom: 60px; display: flex; align-items: center; gap: 14px; color: #fff; font-weight: 700; font-size: 19px; letter-spacing: -.01em; }
.card { position: absolute; overflow: hidden; box-shadow: 0 40px 90px rgba(0,0,0,.42), 0 8px 24px rgba(0,0,0,.25); }
.frame { position: absolute; border-radius: 14px; overflow: hidden; box-shadow: 0 40px 90px rgba(0,0,0,.42), 0 8px 24px rgba(0,0,0,.25); background: #111; }
.chrome { height: 34px; background: #1c1c1e; display: flex; align-items: center; gap: 7px; padding: 0 14px; }
.chrome i { width: 10px; height: 10px; border-radius: 50%; background: #3a3a3e; display: block; }
.chrome b { margin-left: 12px; font: 500 12px Inter; color: #9a9aa0; background: #2a2a2e; border-radius: 6px; padding: 5px 12px; flex: 1; text-align: center; }
.strip { position: absolute; border-radius: 16px; overflow: hidden; box-shadow: 0 30px 60px rgba(0,0,0,.4); }
.strip img { display: block; }
`;
const brand = (px = 34) => `<div class="brand">${markSvg(px, '#fff', ORANGE, '#fff')}<span>SoundCloud Suite</span></div>`;
// the right column runs from 560 to 1280: a hub card sits centred in it, a browser frame fits it whole (680 px wide,
// 24 px off the seam and the edge), and a card can bleed off the bottom on purpose but never off the right
const COL_X = 560, COL_W = 720;
const centred = (w) => COL_X + Math.round((COL_W - w) / 2);
const cardW = (name) => rects[name].width - PAD * 2, cardH = (name) => rects[name].height - PAD * 2;
const centredCard = (name, top) => card(name, 22, `left:${centred(cardW(name))}px;top:${top}px`);
const shuffleUi = () => {
  // the likes page in a frame, the Shuffle Play button's queued count readable, the hub's Queue tab over its lower half
  const fw = 680, fx = COL_X + 20, fy = 60;
  const qw = Math.round(cardW('hub-queue-shuffle') * 0.86), qh = Math.round(cardH('hub-queue-shuffle') * 0.86);
  return frame('page-shuffle', fw, `left:${fx}px;top:${fy}px`) + card('hub-queue-shuffle', 22, `left:${COL_X + COL_W - qw - 36}px;top:${fy + 180}px;transform:scale(.86);transform-origin:top left`);
};
const shots = [
  { file: 'screenshot-1-lyrics', eyebrow: 'Lyrics', h1: 'Lyrics that follow the song', sub: 'Synced line by line from seven sources and locked to the vocals — even on sped-up and edited uploads.', ui: () => centredCard('hub-lyrics', 56) },
  { file: 'screenshot-2-audio', eyebrow: 'Audio', h1: 'Studio-grade sound, right in the player', sub: 'A ten-band EQ on a live spectrum, Enhance, loudness normalization and a true-peak clip guard. Exact passthrough when off.', ui: () => centredCard('hub-audio', 44) },
  { file: 'screenshot-3-shuffle', eyebrow: 'Shuffle', h1: 'Shuffle every track you ever liked', sub: 'True random across your whole library — not the first page the site loads. Filter by genre or artist, skip what you just heard.', ui: shuffleUi },
  { file: 'screenshot-4-themes', eyebrow: 'Themes', h1: 'A darker, cleaner SoundCloud', sub: 'Eleven dark themes, the upsells and clutter gone, and a Zen mode that leaves nothing but the music.', ui: () => frame('page-dark', 680, `left:${COL_X + 20}px;top:170px`) },
  { file: 'screenshot-5-tools', eyebrow: 'Player tools', h1: 'Every tool in the bar', sub: 'Speed, A–B loop, sleep timer, track info, a floating lyric line, and a Ctrl+K palette that reaches every setting.', ui: () => frame('cmdk', 680, `left:${COL_X + 20}px;top:118px`) + `<div class="strip" style="left:${COL_X + 20 + 60}px;top:616px;width:560px;height:56px"><img src="${dataUri('bar')}" style="width:760px;height:56px;margin-left:-200px"></div>` },
];
const page1280 = (s) => `<html><head><style>${CSS}</style></head><body><div class="stage" style="width:1280px;height:800px"><div class="band" style="width:560px"></div><div class="copy"><div class="eyebrow">${s.eyebrow}</div><h1>${s.h1}</h1><div class="sub">${s.sub}</div></div>${brand()}${s.ui()}</div></body></html>`;
const tile440 = () => `<html><head><style>${CSS} .t { width:440px;height:280px;background:${ORANGE};position:relative;overflow:hidden;color:#fff } .t h1 { font-size:34px;letter-spacing:-.03em;position:absolute;left:36px;top:132px } .t .tag { position:absolute;left:36px;top:190px;font-size:15px;font-weight:600;opacity:.9;letter-spacing:.01em } .t .m { position:absolute;left:36px;top:44px }</style></head><body><div class="t"><div class="m">${markSvg(150, '#fff', ORANGE, '#fff')}</div><h1>SoundCloud Suite</h1><div class="tag">Lyrics · Audio · Shuffle · Themes</div></div></body></html>`;
const marquee1400 = () => `<html><head><style>${CSS} .stage { background:${ORANGE} } .mq h1 { font-size:64px;max-width:560px } .mq .sub { font-size:22px;max-width:520px }</style></head><body><div class="stage mq" style="width:1400px;height:560px"><div class="copy" style="top:104px"><div style="margin-bottom:34px">${markSvg(170, '#fff', ORANGE, '#fff')}</div><h1>SoundCloud Suite</h1><div class="sub">Synced lyrics, studio-grade audio, full-library shuffle and a cleaner SoundCloud.</div></div>${card('hub-audio', 22, 'left:704px;top:36px;transform:scale(.78);transform-origin:top left')}${card('hub-lyrics', 22, `left:${1400 - 40 - Math.round(cardW('hub-lyrics') * 0.78)}px;top:96px;transform:scale(.78);transform-origin:top left`)}</div></body></html>`;
(async () => {
  const b = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
  const pg = await b.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
  const render = async (html, file, w, h) => { await pg.setViewportSize({ width: w, height: h }); await pg.setContent(html); await pg.waitForTimeout(150); await pg.screenshot({ path: path.join(OUT, file + '.png'), clip: { x: 0, y: 0, width: w, height: h } }); console.log('wrote', file, `${w}x${h}`); };
  for (const s of shots) await render(page1280(s), s.file, 1280, 800);
  await render(tile440(), 'promo-small-440x280', 440, 280);
  await render(marquee1400(), 'promo-marquee-1400x560', 1400, 560);
  await b.close();
})();
