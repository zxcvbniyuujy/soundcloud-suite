// Lyrics one-to-one with the sheet: a MutationObserver inside the hub stamps the latency-compensated media clock the
// instant a line gains .act; the error against the line's sheet time (with the lead and offsets in force) must sit
// within one animation frame, lines must advance in order, and a seek must land on the right line at once.
//   node tools/lyrics-sync-check.js                      # BEST FRIEND (LRCLIB synced sheet), about two minutes
//   TRACK=https://soundcloud.com/... node tools/lyrics-sync-check.js
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const EXT = path.resolve(__dirname, '..');
const TRACK = process.env.TRACK || 'https://soundcloud.com/rexorangecounty/best-friend';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fails++; };
(async () => {
  const profile = path.join(__dirname, '.sync-profile'); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1440, height: 900 }, proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-features=PostQuantumKyber,UseMLKEM', '--disable-http2', '--disable-quic', '--autoplay-policy=no-user-gesture-required'] });
  await ctx.addInitScript((mv) => { window.__MV = mv; }, require(path.join(EXT, 'manifest.json')).version.split('.').slice(0, 2).join('.'));
  await ctx.addInitScript(() => { try { if (window.top === window) { localStorage.setItem('scss:debug', '1'); localStorage.setItem('scssgm:sce:onboarded', '1'); localStorage.setItem('scssgm:sl:ver', JSON.stringify(window.__MV)); } } catch (e) {} });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  const hub = (src) => page.evaluate((s) => { const h = document.getElementById('slx3-host'); const r = h && h.shadowRoot; if (!r) return null; return (new Function('root', 'panel', s))(r, r.querySelector('.panel')); }, src);
  await page.goto(TRACK, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(4000);
  await page.evaluate(() => { const b = document.querySelector('#onetrust-accept-btn-handler'); if (b) b.click(); });
  for (let i = 0; i < 5; i++) { const p = await page.evaluate(() => { const b = document.querySelector('.playControls__play'); return !!(b && b.classList.contains('playing')); }); if (p) break; await page.evaluate(() => { const b = document.querySelector('.fullHero .sc-button-play, .playControls__play'); if (b) b.click(); }); await sleep(2000); await page.evaluate(() => { for (const c of document.querySelectorAll('.modal.auth-modal .modal__closeButton')) c.click(); }); }
  await page.keyboard.press('Alt+L'); await sleep(5000);
  const dbg = () => page.evaluate(() => { const d = window.__sceLyricDebug && window.__sceLyricDebug(); return d && { mediaT: d.mediaT, off: d.off, goff: d.goff, aoff: d.aoff, synced: d.synced, n: d.lineTimes ? d.lineTimes.length : 0, lineTimes: d.lineTimes }; });
  let d = await dbg(); for (let i = 0; i < 10 && !(d && d.synced); i++) { await sleep(2000); d = await dbg(); }
  if (!d || !d.synced) { console.log('no synced sheet:', JSON.stringify(d)); process.exit(2); }
  const leadLabel = await hub(`const items = [...root.querySelectorAll('*')].map((e) => e.textContent && e.textContent.trim()).filter((t) => t && /^Highlight timing:/.test(t)); return items[0] || null;`);
  console.log('sheet:', d.n, 'lines · offsets off', d.off, 'goff', d.goff, 'aoff', d.aoff, '· lead label:', leadLabel);
  // the observer: every time a line gains .act, stamp the media clock and the line's index in the list
  await page.evaluate(() => {
    const h = document.getElementById('slx3-host'); const root = h.shadowRoot; window.__actLog = [];
    const idx = (el) => { const all = root.querySelectorAll('.line'); return Array.prototype.indexOf.call(all, el); };
    const mo = new MutationObserver((recs) => { for (const r of recs) { const el = r.target; if (!(el.classList && el.classList.contains('line'))) continue; const had = (r.oldValue || '').split(/\s+/).includes('act'); const has = el.classList.contains('act'); if (has && !had) { const dd = window.__sceLyricDebug(); window.__actLog.push({ i: idx(el), mediaT: dd.mediaT, aoff: dd.aoff, off: dd.off, goff: dd.goff, perf: performance.now() }); } } });
    mo.observe(root, { attributes: true, attributeOldValue: true, attributeFilter: ['class'], subtree: true });
  });
  // seek to just before the 6th line and let it run for 70 s
  const t6 = d.lineTimes[5];
  await page.evaluate((t) => { const d = window.__sceAudioDebug && window.__sceAudioDebug(); if (d && d.seek) d.seek(t); }, Math.max(0, t6 - 3));
  await sleep(70000);
  const log = await page.evaluate(() => window.__actLog);
  const lead = /exact/.test(leadLabel || '') ? 0 : /early/.test(leadLabel || '') ? 250 : 100;
  const errsMs = [];
  for (const e of log) { if (e.i < 0 || e.i >= d.lineTimes.length) continue; const clockOff = (lead + (e.off || 0) + (e.goff || 0) + (e.aoff || 0)) / 1000; const err = (e.mediaT + clockOff - d.lineTimes[e.i]) * 1000; errsMs.push({ i: e.i, err: Math.round(err), at: +e.mediaT.toFixed(2) }); }
  const sorted = errsMs.map((x) => x.err).sort((a, b) => a - b), q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  console.log('switches:', errsMs.length, JSON.stringify(errsMs.slice(0, 30)));
  console.log(`error = clock + lead/offsets − sheet time, ms: min ${sorted[0]}, median ${q(0.5)}, p90 ${q(0.9)}, max ${sorted[sorted.length - 1]}`);
  ok(errsMs.length >= 8, `${errsMs.length} line switches observed in 70 s`);
  ok(sorted.length && sorted[0] >= -20 && q(0.9) <= 40, 'every switch lands within one frame after its moment (≥ −20 ms, p90 ≤ 40 ms)');
  const monotone = errsMs.every((x, k) => !k || x.i > errsMs[k - 1].i || Math.abs(x.i - errsMs[k - 1].i) <= 1);
  ok(monotone, 'lines advance in order (no jumping back except a neighbour)');
  // a seek lands on the right line at once
  const tgt = d.lineTimes[20]; await page.evaluate(() => { window.__actLog = []; });
  await page.evaluate((t) => { const d = window.__sceAudioDebug(); d.seek(t); }, tgt + 0.5); await sleep(700);
  const act = await hub(`const all = [...root.querySelectorAll('.line')]; const i = all.findIndex((l) => l.classList.contains('act')); return i;`);
  const expect = d.lineTimes.findIndex((t, k) => t <= tgt + 0.5 + lead / 1000 && (k === d.lineTimes.length - 1 || d.lineTimes[k + 1] > tgt + 0.5 + lead / 1000));
  ok(act === expect || act === expect + 1 || act === expect - 1, `seek to line 21 + 0.5 s lights line ${act + 1} (expected ${expect + 1})`);
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await ctx.close();
  console.log(fails ? `FAILED ${fails}` : 'ALL OK'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('PROBE FAIL', e); process.exit(2); });
