#!/usr/bin/env node
/* SoundCloud SuperSuite — visual preview.
 *
 * Loads the unpacked extension into Playwright's Chromium, opens a public
 * SoundCloud playlist, starts playback and screenshots every suite surface
 * (hub tabs, menu, hotkey sheet, search, command palette, settings, track
 * info) so a UI change can be checked without clicking through by hand.
 *
 *   npm i -g playwright && npx playwright install chromium   # once
 *   node tools/preview.js [outDir] [playlistUrl]
 *
 * Honours HTTPS_PROXY when set. Headless Chromium runs the extension via the
 * "chromium" channel (the headless shell cannot load extensions).
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'preview-shots');
const playlist = process.argv[3] || '';
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(out, '.profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox',
      '--disable-background-networking', '--disable-component-update', '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + String(e).slice(0, 240)));
  page.on('console', (m) => { if (m.type() === 'error' && /SuperSuite|scss|bhx|sce-/.test(m.text())) problems.push('console: ' + m.text().slice(0, 240)); });
  const shot = async (name) => { await page.screenshot({ path: path.join(out, name + '.png') }); console.log('  ' + name + '.png'); };
  const step = async (name, fn) => { try { await fn(); } catch (e) { console.log('  (skipped ' + name + ': ' + e.message.split('\n')[0] + ')'); } };
  const hub = (src) => page.evaluate((s) => { const h = document.getElementById('slx3-host'); const r = h && h.shadowRoot; return (new Function('root', 'panel', s))(r, r && r.querySelector('.panel')); }, src);

  const closeScModal = () => page.evaluate(() => { const b = document.querySelector('.modal__closeButton, .modal__close, [class*="modal"] button[aria-label*="Close" i]'); if (b) b.click(); }).catch(() => {});
  await page.goto('https://soundcloud.com/discover', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  await step('cookie banner', async () => { const b = page.locator('#onetrust-accept-btn-handler'); if (await b.count()) await b.first().click({ timeout: 2000 }); });
  console.log('shots →', out);
  await shot('00-first-run');
  await step('first-run dialog', async () => { const b = page.getByRole('button', { name: /set it up myself/i }); if (await b.count()) await b.first().click({ timeout: 3000 }); });
  const setUrl = playlist || await page.evaluate(() => { const a = document.querySelector('a[href*="/sets/"]'); return a ? a.href : null; });
  if (setUrl) { await page.goto(setUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(4000); }
  await step('play', () => page.evaluate(() => { const b = document.querySelector('.fullHero .sc-button-play, .listenEngagement .sc-button-play, .sc-button-play'); if (b) b.click(); }));
  await sleep(3000); await closeScModal(); await sleep(500);
  await shot('01-page');
  await page.keyboard.press('Alt+L'); await sleep(8000);
  await shot('02-hub-lyrics');
  for (const t of ['queue', 'stats', 'audio', 'tweaks']) {
    await step('tab ' + t, async () => { await hub(`root.querySelector('.tab[data-tab="${t}"]').click();`); await sleep(700); });
    await shot('03-hub-' + t);
  }
  await step('global hotkey sheet', async () => { await hub(`const b=[...root.querySelectorAll('#ebody .ss-btn')].find(x=>/View all/.test(x.textContent)); if(!b) throw new Error('no button'); b.click();`); await sleep(500); });
  await shot('04-global-keys'); await page.keyboard.press('Escape'); await sleep(300);
  await step('lyrics tab', () => hub(`root.querySelector('.tab[data-tab="lyrics"]').click();`));
  await step('menu', async () => { await hub(`root.querySelector('#bMenu').click();`); await sleep(400); }); await shot('05-hub-menu');
  await step('toast', async () => { await hub(`const m=[...root.querySelectorAll('.mi')].find(x=>/Mini lyric bar/.test(x.textContent)); if(m) m.click();`); await sleep(350); }); await shot('06-toast');
  await page.keyboard.press('?'); await sleep(400); await shot('07-hub-keys');
  await step('keys close', () => hub(`root.querySelector('#keys').click();`));
  await step('search', async () => { await hub(`root.querySelector('#bSearch').click();`); await sleep(600); }); await shot('08-hub-search');
  await step('search close', () => hub(`root.querySelector('#bSearch').click();`));
  await page.keyboard.press('Control+K'); await sleep(500); await shot('09-palette'); await page.keyboard.press('Escape'); await sleep(300);
  await step('immersive', async () => { await hub(`root.querySelector('#bMax').click();`); await sleep(700); }); await shot('10-immersive');
  await step('immersive off', () => hub(`root.querySelector('#bMax').click();`));
  await page.keyboard.press('Alt+L'); await sleep(300);
  await step('track info', async () => { await page.evaluate(() => { const b = document.querySelector('.playControls .sce-info'); if (b) b.click(); }); await sleep(3000); }); await shot('11-track-info');
  await page.keyboard.press('Escape'); await sleep(300);
  if (problems.length) { console.log('problems:'); problems.forEach((p) => console.log('  ' + p)); }
  else console.log('no page errors from the suite');
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
