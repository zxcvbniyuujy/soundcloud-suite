// Store-listing captures on real soundcloud.com at 2× device pixels: the hub on each tab, the themed page,
// the shuffle card, the player-bar tools, the track-info popover, the mini lyric bar and the command palette.
// First-run path: the onboarding card's "Use recommended" applies the dark theme + enhancer, as a new user would see it.
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const EXT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'raw'); fs.mkdirSync(OUT, { recursive: true });
const TRACK = 'https://soundcloud.com/rexorangecounty/best-friend';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VW = 1280, VH = 800, PAD = 28;
(async () => {
  const profile = path.join(__dirname, '.profile'); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: VW, height: VH }, deviceScaleFactor: 2,
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-features=PostQuantumKyber,UseMLKEM', '--disable-http2', '--disable-quic', '--disable-background-networking', '--disable-component-update', '--autoplay-policy=no-user-gesture-required'],
  });
  await ctx.addInitScript(() => { try { if (window.top === window) { localStorage.setItem('scss:debug', '1'); localStorage.setItem('scssgm:sl:size', JSON.stringify({ w: 470, h: 690 })); } } catch (e) {} });
  const page = ctx.pages()[0] || await ctx.newPage();
  const rects = {};
  const step = async (name, fn) => { try { return await fn(); } catch (e) { console.log(`step FAIL ${name}: ${e.message.split('\n')[0]}`); return null; } };
  const hub = (src) => page.evaluate((s) => { const h = document.getElementById('slx3-host'); const r = h && h.shadowRoot; if (!r) return null; return (new Function('root', 'panel', s))(r, r.querySelector('.panel')); }, src);
  const hubOpen = () => hub(`return !!(panel && panel.classList.contains('open'));`);
  const ensureHub = async (open) => { const is = await hubOpen(); if (!!is !== open) { await page.keyboard.press('Alt+L'); await sleep(800); } };
  const tab = async (t) => { await ensureHub(true); await hub(`const b = root.querySelector('.tab[data-tab="${t}"]'); if (b) b.click();`); await sleep(900); };
  const closeScModals = () => step('close-sc-modals', () => page.evaluate(() => { for (const b of document.querySelectorAll('.modal__closeButton, .modal__close, [class*="modal"] button[aria-label*="Close" i]')) { try { b.click(); } catch (e) {} } }));
  const padRect = (r) => { if (!r) return null; const x = Math.max(0, r.x - PAD), y = Math.max(0, r.y - PAD); return { x, y, width: Math.min(VW - x, r.width + PAD * 2), height: Math.min(VH - y, r.height + PAD * 2) }; };
  const shot = async (name, clip) => { await closeScModals(); const p = path.join(OUT, name + '.png'); await page.screenshot({ path: p, clip: clip || undefined }); rects[name] = clip || { x: 0, y: 0, width: VW, height: VH }; console.log('shot', name, JSON.stringify(rects[name])); };
  const panelRect = () => hub(`const r = panel.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`);
  const elRect = (sel, inHub) => inHub ? hub(`const e = root.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;`) : page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; }, sel);

  await step('goto', () => page.goto(TRACK, { waitUntil: 'domcontentloaded', timeout: 60000 }));
  await sleep(5000);
  await step('cookies', async () => { const b = page.locator('#onetrust-accept-btn-handler'); if (await b.count()) await b.first().click({ timeout: 2000 }); });
  await sleep(3000);
  await step('recommended', async () => { const b = page.getByRole('button', { name: /use recommended/i }); if (await b.count()) await b.first().click({ timeout: 3000 }); else console.log('no onboarding card'); });
  await sleep(1500);
  await step('play', () => page.evaluate(() => { const b = document.querySelector('.fullHero .sc-button-play, .listenEngagement .sc-button-play, .sc-button-play'); if (b) b.click(); }));
  await sleep(4000); await closeScModals(); await sleep(500);
  const playing = () => page.evaluate(() => { const b = document.querySelector('.playControls__play'); return !!(b && b.classList.contains('playing')); });
  for (let i = 0; i < 4 && !(await playing()); i++) { await step('play-again', () => page.evaluate(() => { const b = document.querySelector('.playControls__play'); if (b) b.click(); })); await sleep(2500); await closeScModals(); }
  console.log('playing:', await playing());
  await step('seek', () => page.evaluate(() => { const d = window.__sceAudioDebug && window.__sceAudioDebug(); if (d && d.seek) { d.seek(31); return 'debug'; } const w = document.querySelector('.playbackTimeline__progressWrapper'); if (w) { const r = w.getBoundingClientRect(); w.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.12, clientY: r.top + r.height / 2 })); return 'click'; } return 'none'; }).then((m) => console.log('seek via', m)));
  await sleep(2500); await closeScModals();
  await step('dismiss-toasts', () => page.keyboard.press('Escape')); await sleep(400);
  // the themed page, hub closed
  await ensureHub(false); await sleep(600); await shot('page-dark');
  await shot('bar', { x: VW - 760, y: VH - 56, width: 760, height: 56 });
  // the hub on every tab
  await ensureHub(true); await sleep(7000);
  await tab('lyrics'); await sleep(1500); await shot('hub-lyrics', padRect(await panelRect()));
  await tab('queue'); await shot('hub-queue', padRect(await panelRect()));
  await tab('stats'); await shot('hub-stats', padRect(await panelRect()));
  await tab('audio'); await sleep(600); await shot('hub-audio', padRect(await panelRect()));
  await step('audio-playback', () => hub(`const a = root.querySelector('#abody'); const el = [...a.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Enhance'); if (el) a.scrollTop = Math.max(0, el.offsetTop - a.offsetTop - 8);`)); await sleep(500); await shot('hub-audio-enhance', padRect(await panelRect()));
  await tab('tweaks'); await step('tweaks-expand', () => hub(`const heads = [...panel.querySelectorAll('button')].filter((b) => /rotate|▸/.test(b.textContent + b.innerHTML) && b.querySelector('span')); heads.slice(1, 2).forEach((b) => b.click());`)); await sleep(600); await shot('hub-tweaks', padRect(await panelRect()));
  await tab('lyrics'); await sleep(400);
  await step('cheatsheet', async () => { await hub(`panel.focus && panel.focus();`); await page.keyboard.press('Shift+/'); await sleep(600); }); await shot('hub-keys', padRect(await panelRect())); await page.keyboard.press('Escape'); await sleep(300);
  await step('cmdk', async () => { await page.keyboard.press('Control+k'); await sleep(700); }); await shot('cmdk', padRect(await elRect('.cmdk.on .box, .cmdk.on > div, .cmdk.on', true))); await page.keyboard.press('Escape'); await sleep(300);
  // the mini lyric bar with the hub closed
  await step('mini-on', async () => { await ensureHub(true); await page.keyboard.press('Control+k'); await sleep(500); await page.keyboard.type('mini'); await sleep(400); await page.keyboard.press('Enter'); await sleep(700); });
  await ensureHub(false); await sleep(1500); await shot('page-mini'); const mini = await elRect('.mini', true); if (mini) await shot('mini', padRect(mini)); else console.log('no mini bar');
  await step('mini-off', async () => { await ensureHub(true); await page.keyboard.press('Control+k'); await sleep(500); await page.keyboard.type('mini'); await sleep(300); await page.keyboard.press('Enter'); await sleep(500); await ensureHub(false); });
  // player-bar tools
  await step('info', () => page.evaluate(() => { const b = document.querySelector('.sce-info'); if (b) b.click(); })); await sleep(1200);
  const info = await elRect('[style*="2147483350"]', false); if (info) { await shot('track-info', padRect(info)); await shot('page-info'); } else console.log('no track info'); await page.keyboard.press('Escape'); await sleep(300);
  await step('speed', () => page.evaluate(() => { const b = document.querySelector('.sce-speed'); if (b) b.click(); })); await sleep(700); await shot('bar-speed', { x: VW - 760, y: VH - 120, width: 760, height: 120 });
  await step('speed-reset', () => page.evaluate(() => { for (let i = 0; i < 8; i++) { const b = document.querySelector('.sce-speed'); if (b && b.textContent.trim() !== '1×') b.click(); } }));
  await step('gear', () => page.evaluate(() => { const b = document.querySelector('.sce-gear'); if (b) b.click(); })); await sleep(1200); await shot('page-gear'); await shot('hub-gear', padRect(await panelRect())); await page.keyboard.press('Escape');
  fs.writeFileSync(path.join(OUT, 'rects.json'), JSON.stringify(rects, null, 1));
  await ctx.close(); console.log('done');
})().catch((e) => { console.error('STORE-SHOTS FAIL', e); process.exit(2); });
