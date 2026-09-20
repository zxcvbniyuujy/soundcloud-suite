// The SoundCloud Suite mark: the SoundCloud cloud (official geometry) in flat brand orange with a "+" badge tucked
// into the cloud's lower-right corner. Exports svg(size) so every icon size can tune the badge for legibility.
const fs = require('fs'), path = require('path');
const MARK = fs.readFileSync(path.join(__dirname, 'mark-path.txt'), 'utf8');
const ORANGE = '#FF5500';
// small sizes: five thick bars stand in for the thirteen hairlines, which would smear at 16–32 px
const SMALL_BARS = [[1.5, 8.3, 12.3], [4.5, 6.6, 13.4], [7.5, 4.7, 13.8], [10.5, 3.0, 14.1], [13.5, 1.4, 14.1]];
const CLOUD_ONLY = MARK.split('M').filter(Boolean).map((p) => 'M' + p).filter((p) => parseFloat(p.slice(1)) >= 17).join('');
function svg(size, opts = {}) {
  const small = size <= 32;
  const W = 32.5, H = 14.1;
  // badge in mark units: bigger and bolder when the icon is tiny
  const r = small ? 4.6 : 3.4, ring = small ? 0.7 : 0.55, stroke = small ? 1.9 : 1.15, arm = small ? 2.5 : 1.85;
  const cx = W - r + (small ? 0.4 : 0.2), cy = H - r + (small ? 0.4 : 0.2);
  const fill = opts.fill || ORANGE, badge = opts.badge || '#FFFFFF', plus = opts.plus || ORANGE;
  const body = small
    ? SMALL_BARS.map(([x, y0, y1]) => `<rect x="${(x - 1.15).toFixed(2)}" y="${y0}" width="2.3" height="${(y1 - y0).toFixed(2)}" rx="1.15"/>`).join('') + `<path d="${CLOUD_ONLY}"/>`
    : `<path d="${MARK}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-ring - 0.2} ${-0.2} ${W + ring * 2 + 0.6} ${H + ring * 2 + 0.6}" width="${size}" height="${size}">
<defs><mask id="k"><rect x="-2" y="-2" width="${W + 6}" height="${H + 6}" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="${(r + ring).toFixed(2)}" fill="#000"/></mask></defs>
<g fill="${fill}" mask="url(#k)">${body}</g>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="${badge}"/>
<path d="M${cx - arm} ${cy}H${cx + arm}M${cx} ${cy - arm}V${cy + arm}" stroke="${plus}" stroke-width="${stroke}" stroke-linecap="round" fill="none"/>
</svg>`;
}
module.exports = { svg, ORANGE, MARK, CLOUD_ONLY };
if (require.main === module) {
  const { chromium } = require('playwright');
  (async () => {
    const out = process.argv[2] || path.resolve(__dirname, '..', '..', 'icons'); fs.mkdirSync(out, { recursive: true });
    const b = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
    const pg = await b.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
    for (const size of [16, 32, 48, 128, 256, 512]) {
      // the mark is 2.3:1, so it sits centred in the square; small icons run edge to edge, big ones keep store padding
      const w = size <= 48 ? size : Math.round(size * 0.9), scale = w / 33.9, h = Math.round(14.9 * scale);
      const html = `<html><body style="margin:0;background:transparent"><div id="c" style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">${svg(size).replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}"`)}</div></body></html>`;
      await pg.setContent(html); await pg.waitForTimeout(50);
      await pg.locator('#c').screenshot({ path: path.join(out, `icon-${size}.png`), omitBackground: true });
      console.log('icon', size, '→', w + 'x' + h, 'mark');
    }
    fs.writeFileSync(path.join(out, 'mark.svg'), svg(512));
    await b.close();
  })();
}
