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
  const padRect = (r) => { if (!r) return null; const x = Math.max(0, r.x - PAD), y = Math.max(0, r.y - PAD); const width = Math.min(VW - x, r.width + PAD * 2), height = Math.min(VH - y, r.height + PAD * 2); return { x, y, width, height, pl: r.x - x, pt: r.y - y, w: Math.min(r.width, width - (r.x - x)), h: Math.min(r.height, height - (r.y - y)) }; };
  const shot = async (name, clip) => { await closeScModals(); const p = path.join(OUT, name + '.png'); await page.screenshot({ path: p, clip: clip || undefined }); rects[name] = clip || { x: 0, y: 0, width: VW, height: VH }; console.log('shot', name, JSON.stringify(rects[name])); };
  const panelRect = () => hub(`const r = panel.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`);
  // a flat dark shade just under the hub host while its cards are captured: the panel is translucent over the page,
  // and page text would otherwise show through the card
  const shade = (on) => page.evaluate((on) => { let d = document.getElementById('__shotShade'); if (!on) { if (d) d.remove(); return; } if (!d) { d = document.createElement('div'); d.id = '__shotShade'; document.documentElement.appendChild(d); } const host = document.getElementById('slx3-host'); const z = host ? (parseInt(getComputedStyle(host).zIndex, 10) || 2147483600) : 2147483600; d.style.cssText = 'position:fixed;inset:0;background:#121214;z-index:' + (z - 1) + ';pointer-events:none'; }, on);
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
  await step('seek', () => page.evaluate(() => { const d = window.__sceAudioDebug && window.__sceAudioDebug(); if (d && d.seek) { d.seek(178); return 'debug'; } /* 2:58: the lyrics capture lands on the second verse, a window with no profanity in it */ const w = document.querySelector('.playbackTimeline__progressWrapper'); if (w) { const r = w.getBoundingClientRect(); w.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.68, clientY: r.top + r.height / 2 })); return 'click'; } return 'none'; }).then((m) => console.log('seek via', m)));
  await sleep(2500); await closeScModals();
  await step('dismiss-toasts', () => page.keyboard.press('Escape')); await sleep(400);
  // the themed page, hub closed
  await ensureHub(false); await sleep(600); await shot('page-dark');
  // the player bar's own box (48 px), not a fixed slice that would carry a sliver of the page above it
  const barR = (await elRect('.playControls__inner', false)) || (await elRect('.playControls', false)) || { y: VH - 48, height: 48 };
  await shot('bar', { x: VW - 760, y: Math.round(barR.y), width: 760, height: Math.round(barR.height) });
  // the hub on every tab, over the shade, moved in from the viewport edge so its padded capture fits whole
  await ensureHub(true); await sleep(7000); await shade(true);
  await hub(`panel.style.right = '48px';`); await sleep(400);
  await tab('lyrics'); await sleep(1500);
  // the karaoke wipe is driven every frame from the playback position, so a raw capture lands mid-word; pin the
  // active line's --fill to the word boundary nearest the middle of the line (a stylesheet !important beats the
  // loop's inline value) for the one frame the shot needs
  await step('freeze-wipe', () => hub(`const tx = root.querySelector('.line.act .tx'); if (!tx) return 'no active line';
    const box = tx.getBoundingClientRect(); const text = tx.textContent; const rng = document.createRange(); const bounds = [];
    const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) bounds.push(c); else walk(c); } }; walk(tx);
    const stops = [];
    for (const node of bounds) { const s = node.data; for (let i = 0; i < s.length; i++) { if (s[i] === ' ' && i > 0) { rng.setStart(node, 0); rng.setEnd(node, i); const r = rng.getBoundingClientRect(); if (r.width) stops.push((r.right - box.left) / box.width * 100); } } }
    if (!stops.length) return 'single word: ' + text;
    const pick = stops.reduce((a, b) => Math.abs(b - 50) < Math.abs(a - 50) ? b : a);
    let st = root.getElementById('__shotFill'); if (!st) { st = document.createElement('style'); st.id = '__shotFill'; root.appendChild(st); }
    st.textContent = '.line.act .tx{--fill:' + pick.toFixed(2) + '% !important}'; return pick.toFixed(1) + '% of "' + text + '"';`).then((m) => console.log('wipe pinned at', m)));
  await sleep(120); await shot('hub-lyrics', padRect(await panelRect()));
  await hub(`const st = root.getElementById('__shotFill'); if (st) st.remove();`);
  await tab('queue'); await shot('hub-queue', padRect(await panelRect()));
  await tab('stats'); await shot('hub-stats', padRect(await panelRect()));
  await tab('audio'); await sleep(600);
  // a shaped curve on the spectrum says "equalizer" at a glance where a flat line says nothing: pick a built-in preset
  await step('eq-preset', () => hub(`const sel = root.querySelector('#abody select.sxsel'); if (!sel) return 'no preset select'; sel.value = 'b:Loudness curve'; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value;`).then((v) => console.log('eq preset', v)));
  await sleep(1200); await shot('hub-audio', padRect(await panelRect()));
  await step('audio-playback', () => hub(`const a = root.querySelector('#abody'); const el = [...a.querySelectorAll('div')].find((d) => d.textContent.trim() === 'Enhance'); if (el) a.scrollTop = Math.max(0, el.offsetTop - a.offsetTop - 8);`)); await sleep(500); await shot('hub-audio-enhance', padRect(await panelRect()));
  await tab('tweaks'); await step('tweaks-expand', () => hub(`const heads = [...panel.querySelectorAll('button')].filter((b) => /rotate|▸/.test(b.textContent + b.innerHTML) && b.querySelector('span')); heads.slice(1, 2).forEach((b) => b.click());`)); await sleep(600); await shot('hub-tweaks', padRect(await panelRect()));
  await tab('lyrics'); await sleep(400); await shade(false); await hub(`panel.style.right = '';`);
  await step('cheatsheet', async () => { await hub(`panel.focus && panel.focus();`); await page.keyboard.press('Shift+/'); await sleep(600); }); await shot('hub-keys', padRect(await panelRect())); await page.keyboard.press('Escape'); await sleep(300);
  await step('cmdk', async () => { await page.keyboard.press('Control+k'); await sleep(700); }); await shot('page-cmdk'); await shot('cmdk', padRect(await elRect('.cmdk.on .cmdkbox', true))); await page.keyboard.press('Escape'); await sleep(300);
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
  // Shuffle Play on a public likes page (signed out): the button's queued count on the page, then the hub's Queue tab
  await step('shuffle', async () => {
    await ensureHub(false);
    await page.goto('https://soundcloud.com/flume/likes', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(6000); await closeScModals();
    for (let i = 0; i < 20 && !(await page.evaluate(() => !!document.querySelector('.bhx-shufbtn'))); i++) await sleep(1000);
    await page.evaluate(() => document.querySelector('.bhx-shufbtn').click());
    for (let i = 0; i < 120; i++) { const t = await page.evaluate(() => (document.querySelector('.bhx-shufbtn') || {}).textContent || ''); if (/✓ [\d,.]+ queued|Error/.test(t)) break; await sleep(500); }
    await sleep(1200); await closeScModals(); await page.keyboard.press('Escape'); await sleep(300);
    await page.evaluate(() => window.scrollTo(0, 0)); await sleep(400);
    await shot('page-shuffle');
    const btn = await page.evaluate(() => { const b = document.querySelector('.bhx-shufbtn'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, text: b.textContent.trim() }; });
    console.log('shuffle button', JSON.stringify(btn)); if (btn) rects['shuffle-btn'] = btn;
    await ensureHub(true); await sleep(2500); await shade(true); await hub(`panel.style.right = '48px';`); await sleep(400);
    await tab('queue'); await sleep(800); await shot('hub-queue-shuffle', padRect(await panelRect()));
    await shade(false); await hub(`panel.style.right = '';`); await ensureHub(false);
  });
  fs.writeFileSync(path.join(OUT, 'rects.json'), JSON.stringify(rects, null, 1));
  await ctx.close(); console.log('done');
})().catch((e) => { console.error('STORE-SHOTS FAIL', e); process.exit(2); });
