// Launch gate: the extension on the public SoundCloud pages a new user reaches, signed out.
// Every route must render its own content, carry exactly one hub host, open and close the hub with Alt+L, and
// throw nothing from the extension's scripts; in-app navigation between a profile's tabs must keep one host and
// show the Shuffle Play button only on the likes tab; the hub panel must fit short and narrow windows, both when a
// saved 470×690 size is restored there and when the window shrinks under an open panel.
//   node tools/route-sweep.js                # everything (~7 min)
//   ONLY=nav,sel node tools/route-sweep.js   # a subset: routes, nav (in-app navigation and viewports), sel (selectors)
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const EXT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fails++; };
const only = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean); const want = (s) => !only.length || only.includes(s);
const ROUTES = [
  ['/', 'body'],
  ['/discover', '.l-main, #content, main'],
  ['/search?q=flume', '.searchList, .searchItem, .l-main'],
  ['/search/sounds?q=flume', '.searchList, .searchItem, .l-main'],
  ['/search/people?q=flume', '.searchList, .searchItem, .l-main'],
  ['/search/sets?q=flume', '.searchList, .searchItem, .l-main'],
  ['/charts/top?genre=all-music', '.chartTracks, .l-main'],
  ['/flume', '.profileHeader, .userMain, .l-main'],
  ['/flume/tracks', '.soundList, .userMain, .l-main'],
  ['/flume/sets', '.soundList, .userMain, .l-main'],
  ['/flume/reposts', '.soundList, .userMain, .l-main'],
  ['/flume/followers', '.userMain, .l-main'],
  ['/flume/following', '.userMain, .l-main'],
  ['/flume/likes', '.soundList, .userMain, .l-main'],
  ['/rexorangecounty/best-friend', '.fullHero, .l-main'],
  ['/rexorangecounty/best-friend/likes', '.l-main'],
  ['/rexorangecounty/best-friend/reposts', '.l-main'],
  ['/rexorangecounty/best-friend/sets', '.l-main'],
  ['/rexorangecounty/best-friend/recommended', '.l-main'],
  ['/tags/lofi', '.l-main'],
  ['/pages/contact', 'body'],
  ['/terms-of-use', 'body'],
  ['/upload', 'body'],
  ['/you/likes', 'body'],
  ['/notifications', 'body'],
  ['/signin', 'body'],
];
(async () => {
  const profile = path.join(__dirname, '.route-profile'); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-features=PostQuantumKyber,UseMLKEM', '--disable-http2', '--disable-quic', '--autoplay-policy=no-user-gesture-required'] });
  // skip the first-run card and the What's-new card, as a returning user's page would
  await ctx.addInitScript((mv) => { window.__MV = mv; }, require(path.join(EXT, 'manifest.json')).version.split('.').slice(0, 2).join('.'));
  // scss:debug exposes the audio accessor; bh_sc_cfg.debug exposes the shuffle engine (window.__scShuffle, its selfTest)
  await ctx.addInitScript(() => { try { if (window.top === window) { localStorage.setItem('scss:debug', '1'); if (!localStorage.getItem('bh_sc_cfg')) localStorage.setItem('bh_sc_cfg', JSON.stringify({ debug: true })); localStorage.setItem('scssgm:sce:onboarded', '1'); localStorage.setItem('scssgm:sl:ver', JSON.stringify(window.__MV)); } } catch (e) {} });
  const page = ctx.pages()[0] || await ctx.newPage();
  const extErrors = [], siteErrors = [], extConsole = [];
  const isExt = (s) => /chrome-extension:\/\//.test(s || '');
  page.on('pageerror', (e) => { const s = (e && e.stack) || String(e); (isExt(s) ? extErrors : siteErrors).push({ url: page.url().replace('https://soundcloud.com', ''), msg: String(e.message || e).slice(0, 200) }); });
  page.on('console', (m) => { if (m.type() !== 'error') return; const loc = m.location() || {}; if (isExt(loc.url) || /suite\.js|bridge\.js|gm-shim\.js|\[SCS|SoundCloud Suite/.test(m.text())) extConsole.push({ url: page.url().replace('https://soundcloud.com', ''), text: m.text().slice(0, 200) }); });
  const closeModals = () => page.evaluate(() => { for (const b of document.querySelectorAll('.modal__closeButton, .modal__close, #onetrust-accept-btn-handler')) { try { b.click(); } catch (e) {} } }).catch(() => {});
  const hubState = () => page.evaluate(() => { const hosts = document.querySelectorAll('#slx3-host'); const h = hosts[0], r = h && h.shadowRoot, p = r && r.querySelector('.panel'); return { hosts: hosts.length, open: !!(p && p.classList.contains('open')), gears: document.querySelectorAll('.sce-gear').length, shuf: document.querySelectorAll('.bhx-shufbtn').length }; });
  const visible = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return 'missing'; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return (r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') ? 'visible' : 'hidden'; }, sel);
  console.log('=== routes');
  for (const [route, sel] of (want('routes') ? ROUTES : [])) {
    const before = extErrors.length + extConsole.length;
    let nav = 'ok';
    try { await page.goto('https://soundcloud.com' + route, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { nav = 'goto: ' + e.message.split('\n')[0]; }
    await sleep(5000); await closeModals(); await sleep(300);
    const where = await page.evaluate(() => location.pathname + location.search).catch(() => '?');
    const vis = await visible(sel).catch((e) => 'eval: ' + e.message.split('\n')[0]);
    const s1 = await hubState().catch(() => null);
    let toggled = null;
    if (s1 && s1.hosts === 1) {
      await page.keyboard.press('Alt+L'); await sleep(700); const s2 = await hubState().catch(() => null);
      await page.keyboard.press('Alt+L'); await sleep(500); const s3 = await hubState().catch(() => null);
      toggled = !!(s2 && s2.open && s3 && !s3.open);
    }
    const fresh = extErrors.length + extConsole.length - before;
    const good = nav === 'ok' && vis === 'visible' && s1 && s1.hosts === 1 && s1.gears <= 1 && s1.shuf <= 1 && toggled === true && fresh === 0;
    ok(good, `${route} → ${where}: content ${vis}, hosts ${s1 ? s1.hosts : '?'}, gears ${s1 ? s1.gears : '?'}, shuffle buttons ${s1 ? s1.shuf : '?'}, hub toggles ${toggled}, new extension errors ${fresh}${nav !== 'ok' ? ', ' + nav : ''}`);
  }
  // the likes page carries the network tabs (Likes / Following / Followers), so the way back to Tracks is the
  // profile link; each hop is a pushState navigation the engine must follow
  console.log('=== in-app navigation');
  if (want('nav')) { await page.goto('https://soundcloud.com/flume', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(5000); await closeModals(); }
  for (const [href, wantShuf] of (want('nav') ? [['/flume/likes', 1], ['/flume', 0], ['/flume/tracks', 0], ['/flume/likes', 1], ['/flume/following', 0], ['/flume/likes', 1], ['/flume', 0], ['/flume/sets', 0]] : [])) {
    const clicked = await page.evaluate((h) => { const a = [...document.querySelectorAll(`a[href="${h}"]`)].find((el) => el.getBoundingClientRect().width > 0); if (!a) return false; a.click(); return true; }, href);
    await sleep(3500);
    const s = await hubState(); const where = await page.evaluate(() => location.pathname);
    ok(clicked && where === href && s.hosts === 1 && s.gears <= 1 && s.shuf === wantShuf, `→ ${href}: landed ${where}, clicked ${clicked}, hosts ${s.hosts}, gears ${s.gears}, shuffle buttons ${s.shuf} (want ${wantShuf})`);
  }
  console.log('=== viewports');
  await ctx.addInitScript(() => { try { if (window.top === window) localStorage.setItem('scssgm:sl:size', JSON.stringify({ w: 470, h: 690 })); } catch (e) {} });
  const geom = () => page.evaluate(() => { const h = document.getElementById('slx3-host'); const r = h && h.shadowRoot, p = r && r.querySelector('.panel'); if (!p) return null; const b = p.getBoundingClientRect(); const tabs = r.querySelector('.tabs, .tab'); const tb = tabs && tabs.getBoundingClientRect(); const gear = document.querySelector('.sce-gear'); const gb = gear && gear.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height), tabsIn: !!(tb && tb.top >= 0 && tb.bottom <= innerHeight), gearIn: !!(gb && gb.width > 0 && gb.right <= innerWidth && gb.left >= 0), iw: innerWidth, ih: innerHeight }; });
  const fits = (g) => !!(g && g.x >= 0 && g.y >= 0 && g.r <= g.iw && g.b <= g.ih && g.tabsIn && g.gearIn);
  const describe = (g) => g ? `${g.w}×${g.h} at (${g.x},${g.y})→(${g.r},${g.b}) of ${g.iw}×${g.ih}, tabs in view ${g.tabsIn}, gear in view ${g.gearIn}` : 'no panel';
  for (const [w, h] of (want('nav') ? [[1280, 800], [1024, 576], [800, 500], [640, 900]] : [])) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('https://soundcloud.com/rexorangecounty/best-friend', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(5000); await closeModals();
    await page.keyboard.press('Alt+L'); await sleep(900);
    ok(fits(await geom()), `restored at ${w}×${h}: panel ${describe(await geom())}`);
  }
  if (want('nav')) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('https://soundcloud.com/rexorangecounty/best-friend', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(5000); await closeModals();
    await page.keyboard.press('Alt+L'); await sleep(900);
    for (const [w, h] of [[1024, 576], [800, 500], [1920, 1080], [640, 900]]) {
      await page.setViewportSize({ width: w, height: h }); await sleep(700);
      ok(fits(await geom()), `resized to ${w}×${h}: panel ${describe(await geom())}`);
    }
    // fullscreen masks the saved size; a window that shrank meanwhile must be fitted again on the way out
    await page.setViewportSize({ width: 1280, height: 800 }); await sleep(600);
    const maxBtn = () => page.evaluate(() => { const h = document.getElementById('slx3-host'); const b = h && h.shadowRoot.querySelector('#bMax'); if (!b) return false; b.click(); return true; });
    const entered = await maxBtn(); await sleep(600);
    const maxed = await page.evaluate(() => { const h = document.getElementById('slx3-host'); const p = h && h.shadowRoot.querySelector('.panel'); return !!(p && p.classList.contains('max')); });
    await page.setViewportSize({ width: 1024, height: 576 }); await sleep(600);
    const left = await maxBtn(); await sleep(700);
    ok(entered && maxed && left && fits(await geom()), `fullscreen entered ${entered && maxed}, window shrunk to 1024×576, fullscreen left ${left}: panel ${describe(await geom())}`);
    await page.keyboard.press('Alt+L');
  }
  // the SoundCloud class names the suite reads or mounts on, checked on the pages that carry them: a missing one
  // names the feature that will quietly stop working after a site redesign
  console.log('=== selectors');
  // the shuffle module keeps its own registry with a self-test (window.__scShuffle.selfTest() in debug mode); the
  // keys listed per page are the ones that page is expected to carry
  const SEL = [
    ['/rexorangecounty/best-friend', 'the track page', ['.l-container', '.l-listen-wrapper, .l-main', '.l-sidebar-right', '.fullHero', '.fullHero__title', '.fullHero__artwork', '.fullHero .sc-button-play', '.listenEngagement', '.sc-button-like', '.sc-button-repost', '.sc-button-share', '.sc-button-more', '.sc-ministats', '.commentsList', '.commentsList__item', '.commentItem__body', '.commentItem__avatar', '.commentItem__timestamp', '.soundDescription, .truncatedAudioInfo__content'], ['playControl', 'barHost']],
    ['/flume/likes', 'the likes list', ['.l-container', '.l-main', '.soundList__item', '.soundTitle__title', '.soundTitle__username', '.sound__coverArt, .sound__artwork', '.sc-artwork', '.lazyLoadingList__list'], ['likesList', 'userTabs', 'tabsItems', 'rowTitle', 'playButton', 'moreButton', 'soundActions']],
    ['/flume', 'the profile', ['.sc-button-follow', '.userBadge__avatar, .profileHeaderInfo__avatar, .sc-artwork', '.l-sidebar-right'], []],
    ['/discover', 'discover', ['.audibleTile, .playableTile', '.playableTile__heading, .audibleTile__heading', '.l-main', '.l-sidebar-right'], []],
  ];
  await page.setViewportSize({ width: 1280, height: 800 });
  const selfTest = (keys) => page.evaluate((ks) => { const t = window.__scShuffle && window.__scShuffle.selfTest; if (!t) return { missing: ['(no __scShuffle: debug mode off)'] }; const r = t(); return { missing: ks.filter((k) => !r[k]) }; }, keys);
  for (const [route, label, sels, keys] of (want('sel') ? SEL : [])) {
    await page.goto('https://soundcloud.com' + route, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(6000); await closeModals();
    const missing = await page.evaluate((list) => list.filter((s) => !document.querySelector(s)), sels);
    const st = keys.length ? await selfTest(keys) : { missing: [] };
    ok(!missing.length && !st.missing.length, `${label}: ${sels.length - missing.length}/${sels.length} selectors present${missing.length ? ' — missing ' + missing.join(', ') : ''}${keys.length ? `; shuffle registry ${keys.length - st.missing.length}/${keys.length}${st.missing.length ? ' — missing ' + st.missing.join(', ') : ''}` : ''}`);
  }
  // the player bar, the sign-in nudge a signed-out play click opens, and the queue panel
  if (want('sel')) {
  // SoundCloud opens the nudge on its own a few seconds into a signed-out track page, or on the first play click,
  // once per session: start that session afresh (the init script puts the suite's own flags back) and wait for it
  // before closing anything
  await ctx.clearCookies(); await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await page.goto('https://soundcloud.com/rexorangecounty/best-friend', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(3000);
  await page.evaluate(() => { const b = document.querySelector('#onetrust-accept-btn-handler'); if (b) b.click(); });
  const nudgeNow = () => page.evaluate(() => ({ modal: !!document.querySelector('.modal.auth-modal'), close: !!document.querySelector('.modal.auth-modal .modal__closeButton, .modal.auth-modal .modal__close') }));
  let nudge = null; for (let i = 0; i < 12; i++) { nudge = await nudgeNow(); if (nudge.close) break; await sleep(500); }
  if (!nudge.close) { await page.evaluate(() => { const b = document.querySelector('.fullHero .sc-button-play'); if (b) b.click(); }); for (let i = 0; i < 12; i++) { await sleep(500); nudge = await nudgeNow(); if (nudge.close) break; } }
  ok(nudge.modal && nudge.close, `the sign-in nudge: .modal.auth-modal ${nudge.modal}, its close button ${nudge.close}`);
  await closeModals(); await sleep(1500);
  for (let i = 0; i < 4 && !(await page.evaluate(() => { const b = document.querySelector('.playControls__play'); return !!(b && b.classList.contains('playing')); })); i++) { await page.evaluate(() => { const b = document.querySelector('.playControls__play'); if (b) b.click(); }); await sleep(2000); await closeModals(); }
  const barSels = ['.playControls', '.playControls__elements', '.playControls__play', '.playControls__play.playing', '.playControls__queue', '.playControls__soundBadge', '.playbackSoundBadge', '.playbackSoundBadge__actions', '.playbackSoundBadge__lightLink', '.playbackSoundBadge__titleLink', '.playbackSoundBadge__titleContextContainer', '.playbackSoundBadge__avatar', '.playbackSoundBadge__like', '.playbackSoundBadge__queueCircle', '.playbackTimeline__progressWrapper', '.playbackTimeline__timePassed', '.playbackTimeline__duration'];
  const barMissing = await page.evaluate((list) => list.filter((s) => !document.querySelector(s)), barSels);
  const barSt = await selfTest(['playControl', 'skipNext', 'queue', 'queueToggle', 'badgeTitle', 'barHost']);
  ok(!barMissing.length && !barSt.missing.length, `the player bar while playing: ${barSels.length - barMissing.length}/${barSels.length} selectors present${barMissing.length ? ' — missing ' + barMissing.join(', ') : ''}; shuffle registry${barSt.missing.length ? ' missing ' + barSt.missing.join(', ') : ' complete'}`);
  await page.evaluate(() => { const b = document.querySelector('.playbackSoundBadge__queueCircle'); if (b) b.click(); }); await sleep(3000);
  const qSels = ['.queue', '.queue__scrollableInner', '.queue__itemsHeight', '.queue__itemWrapper', '.queueItemView__playButton', '.queue__clear'];
  const qMissing = await page.evaluate((list) => list.filter((s) => !document.querySelector(s)), qSels);
  const qSt = await selfTest(['queueScrollable', 'queueHeights', 'queueItem']);
  ok(!qMissing.length && !qSt.missing.length, `the queue panel: ${qSels.length - qMissing.length}/${qSels.length} selectors present${qMissing.length ? ' — missing ' + qMissing.join(', ') : ''}; shuffle registry${qSt.missing.length ? ' missing ' + qSt.missing.join(', ') : ' complete'}`);
  await page.evaluate(() => { const b = document.querySelector('.playbackSoundBadge__queueCircle'); if (b) b.click(); const p = document.querySelector('.playControls__play'); if (p && p.classList.contains('playing')) p.click(); });
  }
  console.log('=== errors');
  console.log('extension page errors:', JSON.stringify(extErrors));
  console.log('extension console errors:', JSON.stringify(extConsole));
  console.log('site page errors (not ours):', siteErrors.length, JSON.stringify(siteErrors.slice(0, 5)));
  ok(extErrors.length === 0 && extConsole.length === 0, 'no errors from the extension');
  await ctx.close();
  console.log(fails ? `FAILED ${fails}` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ROUTE-SWEEP FAIL', e); process.exit(2); });
