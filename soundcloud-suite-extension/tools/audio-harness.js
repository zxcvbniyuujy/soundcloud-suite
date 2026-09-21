// Audio tab test harness (spec §5.0). Loads the unpacked extension into Chromium
// against the live soundcloud.com, drives SYNTHETIC playback through the suite's
// own Web Audio hooks (new Audio + createMediaElementSource) and reads the
// debug accessor (SUITE.audioDebug, mirrored on window.__sceAudioDebug when
// localStorage 'scss:debug' === '1').
//
//   node tools/audio-harness.js [--only a,b,c] [--shot name] [--list]   (needs the playwright package + Chromium)
//
// Every scenario prints PASS/FAIL with the assertion that failed; the run ends
// with a summary line. Page errors are collected for the whole run and every
// scenario asserts none happened while it ran.
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const SCRATCH = __dirname;
const EXT = process.env.EXT || path.resolve(__dirname, '..');   // the unpacked extension (this repo)
const SHOTS = process.env.SHOTS || path.join(SCRATCH, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const ONLY = (argOf('--only') || '').split(/[\s,]+/).filter(Boolean);
const SHOT = argOf('--shot') || 'audio-tab';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= (tol == null ? 0.01 : tol);

/* ───────── fixtures + synthetic playback (runs IN the page) ───────── */
// Installed once per page. WAVs are generated in-page as data URLs so nothing
// is fetched; `new Audio` and `createMediaElementSource` are the suite's hooks,
// so captureMedia / installFx fire exactly as they do for SoundCloud's player.
const FIXTURE_SRC = `
(() => {
  if (window.__afx) return;
  const SR = 48000;
  const wav = (fill, secs, fillR) => {
    const n = Math.round(SR * secs), data = new Int16Array(n * 2);
    const q16 = (v) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
    for (let i = 0; i < n; i++) { const t = i / SR, v = fill(t, i); data[i * 2] = q16(v); data[i * 2 + 1] = q16(fillR ? fillR(t, i) : v); }
    const bytes = new Uint8Array(44 + data.byteLength), dv = new DataView(bytes.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + data.byteLength, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, data.byteLength, true);
    bytes.set(new Uint8Array(data.buffer), 44);
    let b64 = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return 'data:audio/wav;base64,' + btoa(b64);
  };
  const sine = (t) => Math.sin(2 * Math.PI * 997 * t);
  // 8 kHz mono 8-bit WAV (small enough for a minutes-long fixture)
  const wav8 = (fill, secs) => {
    const sr = 8000, n = Math.round(sr * secs), bytes = new Uint8Array(44 + n), dv = new DataView(bytes.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    str(36, 'data'); dv.setUint32(40, n, true);
    for (let i = 0; i < n; i++) bytes[44 + i] = Math.max(0, Math.min(255, Math.round(128 + fill(i / sr, i) * 127)));
    let b64 = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return 'data:audio/wav;base64,' + btoa(b64);
  };
  const gens = {
    // A: stereo 997 Hz at −23 dBFS, 12 s
    A: () => wav((t) => sine(t) * Math.pow(10, -23 / 20), 12),
    // B: 2 s silence, then 0 dBFS full-scale square bursts (100 ms on / 400 ms off), 6 s
    B: () => wav((t) => (t < 2 ? 0 : ((t % 0.5) < 0.1 ? (sine(t) >= 0 ? 1 : -1) : 0)), 6),
    // C: 997 Hz at −20 dBFS, 10 s
    C: () => wav((t) => sine(t) * Math.pow(10, -20 / 20), 10),
    // K: a 128 BPM kick pattern (60 Hz decaying bursts, a soft 8th-note tick between), 15 s, for the tempo estimator
    K: () => wav((t) => { const beat = 60 / 128, p = t % beat, q = (t + beat / 2) % beat; const kick = p < 0.12 ? Math.sin(2 * Math.PI * 60 * t) * Math.exp(-p * 28) * 0.85 : 0; const tick = q < 0.02 ? Math.sin(2 * Math.PI * 4000 * t) * Math.exp(-q * 250) * 0.2 : 0; return kick + tick; }, 15),
    // D: 997 Hz tone bursts, peak −3 dBFS, 50 ms on / 350 ms off, 12 s (≈ −13 LUFS)
    D: () => wav((t) => ((t % 0.4) < 0.05 ? sine(t) * Math.pow(10, -3 / 20) : 0), 12),
    // E: 997 Hz bed at −26 dBFS with 10 ms bursts at −3 dBFS every 400 ms, 12 s (≈ −18.2 LUFS, peak 0.708):
    //    the normalizer's source-peak clamp binds before the Loud target does
    E: () => wav((t) => sine(t) * Math.pow(10, ((t % 0.4) < 0.01 ? -3 : -26) / 20), 12),
    // M: a music-like stereo clip (kick, snare, hats, saw bass, pad, a vocal band, 9 kHz roll-off) mastered like an
    //    upload — +4 dB into a hard clip at −1 dBFS (≈ −11.6 LUFS, 11 dB crest), 12 s: the Enhance level-match programme
    M: () => { const n = Math.round(SR * 12), L = new Float32Array(n), R = new Float32Array(n); let seed = 1; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; }; const beat = 60 / 96, notes = [55, 55, 65.4, 73.4, 55, 55, 49, 65.4];
      for (let i = 0; i < n; i++) { const t = i / SR, tb = t % beat, bar = Math.floor(t / beat); const kick = Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-tb * 18)) * tb) * Math.exp(-tb * 7) * 0.9; const ts = (t + beat) % (2 * beat); const snare = ts < 0.25 ? (rnd() * Math.exp(-ts * 22) * 0.55 + Math.sin(2 * Math.PI * 190 * ts) * Math.exp(-ts * 30) * 0.4) : 0; const th = t % (beat / 2), hat = rnd() * Math.exp(-th * 90) * 0.18; const f0 = notes[bar % notes.length], saw = 2 * ((t * f0) % 1) - 1, pf = f0 * 4; const pad = (2 * ((t * pf * 1.003) % 1) - 1 + 2 * ((t * pf * 0.997) % 1) - 1) * 0.12; const vEnv = Math.max(0, Math.sin(2 * Math.PI * t / 4)) * 0.35; const voc = vEnv * (Math.sin(2 * Math.PI * 220 * t) + 0.6 * Math.sin(2 * Math.PI * 440 * t) + 0.5 * Math.sin(2 * Math.PI * 660 * t) + 0.35 * Math.sin(2 * Math.PI * 1100 * t) + 0.2 * Math.sin(2 * Math.PI * 2600 * t)) * 0.4; const m = kick + snare + hat + pad + voc, bass = saw * 0.5; L[i] = m + bass * 0.9 + rnd() * 0.01; R[i] = m * 0.96 + bass * 0.9 - rnd() * 0.01 + pad * 0.3; }
      const k = Math.exp(-2 * Math.PI * 9000 / SR); for (const d of [L, R]) { let y = 0; for (let i = 0; i < n; i++) { y = k * y + (1 - k) * d[i]; d[i] = y; } }
      let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); const g = Math.pow(10, 3 / 20) / pk, c = Math.pow(10, -1 / 20), clip = (v) => (v > c ? c : v < -c ? -c : v);
      return wav((t, i) => clip(L[i] * g), 12, (t, i) => clip(R[i] * g)); },
    // F: a real stereo pair — 997 Hz left, 1237 Hz right, both −20 dBFS, 10 s (correlation ≈ 0)
    F: () => wav((t) => sine(t) * 0.1, 10, (t) => Math.sin(2 * Math.PI * 1237 * t) * 0.1),
    // L: a 9-minute track (8 kHz mono 8-bit, 440 Hz at −20 dBFS) — long enough that the sleep timer fades instead of
    //    arming "after this track" (its grace window is 8 min)
    L: () => wav8((t) => Math.sin(2 * Math.PI * 440 * t) * 0.1, 540),
    // H: 50 Hz at −6 dBFS, 10 s — sub-bass for the harmonic branch (its x·|x| shaper is level-dependent)
    H: () => wav((t) => Math.sin(2 * Math.PI * 50 * t) * 0.5, 10),
    // G: 36 s — tone 0–2 s, silence 2–5 s (mid-track: more than 30 s left), tone 5–8 s, silence 8–36 s (the ending)
    G: () => wav8((t) => ((t < 2 || (t >= 5 && t < 8)) ? Math.sin(2 * Math.PI * 440 * t) * 0.1 : 0), 36),
  };
  const urls = {};
  const ctxs = {};
  const afx = {
    url(kind) { if (!urls[kind]) urls[kind] = gens[kind](); return urls[kind]; },
    ctx(rate) { const k = String(rate || 'default'); if (!ctxs[k] || ctxs[k].state === 'closed') ctxs[k] = rate ? new AudioContext({ sampleRate: rate }) : new AudioContext(); return ctxs[k]; },
    cur: null,
    anchor(href) {
      let a = document.querySelector('.playbackSoundBadge__titleLink');
      if (!a) { a = document.createElement('a'); a.className = 'playbackSoundBadge__titleLink'; a.style.display = 'none'; (document.body || document.documentElement).appendChild(a); }
      a.setAttribute('href', href || '/test/track-a');
    },
    async stop() {
      const c = afx.cur; afx.cur = null; if (!c) return;
      try { c.el.pause(); } catch (e) {}
      try { c.src.disconnect(); } catch (e) {}
      try { c.el.removeAttribute('src'); c.el.load(); } catch (e) {}
    },
    async play(kind, opts) {
      opts = opts || {};
      await afx.stop();
      afx.anchor(opts.href);
      const el = new Audio(afx.url(kind));
      el.loop = !!opts.loop;
      if (opts.volume != null) el.volume = opts.volume;
      const ctx = afx.ctx(opts.sampleRate);
      const src = ctx.createMediaElementSource(el);
      // the harness's own tap right before the destination: what the speakers get,
      // whether the source is wired straight through or via the suite's chain
      const out = ctx.createAnalyser(); out.fftSize = 32768; out.smoothingTimeConstant = 0;
      src.connect(out); out.connect(ctx.destination);
      try { await ctx.resume(); } catch (e) {}
      afx.cur = { el, ctx, src, kind, out, buf: new Float32Array(out.fftSize) };
      await el.play();
      return { sampleRate: ctx.sampleRate, state: ctx.state, paused: el.paused };
    },
    // sample peak (dBFS) of the last 32768 output samples (analyser reads are mono-summed: identical channels read exactly)
    outPeakDb() {
      const c = afx.cur; if (!c) return null;
      c.out.getFloatTimeDomainData(c.buf); let pk = 0;
      for (let i = 0; i < c.buf.length; i++) { const v = Math.abs(c.buf[i]); if (v > pk) pk = v; }
      return pk > 0 ? 20 * Math.log10(pk) : -120;
    },
    // peak per channel (dBFS) at an arbitrary node's output, over ~0.5 s
    async chanPeaks(node) {
      const ctx = node.context, sp = ctx.createChannelSplitter(2), aL = ctx.createAnalyser(), aR = ctx.createAnalyser();
      aL.fftSize = aR.fftSize = 32768; aL.smoothingTimeConstant = aR.smoothingTimeConstant = 0;
      node.connect(sp); sp.connect(aL, 0); sp.connect(aR, 1);
      await new Promise((r) => setTimeout(r, 800));
      const rd = (a) => { const b = new Float32Array(a.fftSize); a.getFloatTimeDomainData(b); let pk = 0; for (let i = 0; i < b.length; i++) { const v = Math.abs(b[i]); if (v > pk) pk = v; } return pk > 0 ? 20 * Math.log10(pk) : -120; };
      const res = [rd(aL), rd(aR)];
      try { node.disconnect(sp); } catch (e) {}
      return res;
    },
    el() { return afx.cur && afx.cur.el; },
  };
  window.__afx = afx;
})();`;

(async () => {
  // a fresh profile every run (unless --keep-profile): remembered hub state must not leak between runs
  const profile = path.join(SCRATCH, '.audio-profile');
  if (!argv.includes('--keep-profile')) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox',
      '--disable-features=PostQuantumKyber,UseMLKEM', '--disable-http2', '--disable-quic',
      '--disable-background-networking', '--disable-component-update', '--autoplay-policy=no-user-gesture-required'],
  });
  // debug accessor on; the "What's new" card (fires once per minor version and opens the hub) pre-seeded as seen
  const minor = (() => { try { return JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version.split('.').slice(0, 2).join('.'); } catch (e) { return ''; } })();
  await ctx.addInitScript((mv) => { try { localStorage.setItem('scss:debug', '1'); if (window.top === window && mv && !localStorage.getItem('scssgm:sl:ver')) localStorage.setItem('scssgm:sl:ver', JSON.stringify(mv)); } catch (e) {} }, minor);
  const page = ctx.pages()[0] || await ctx.newPage();
  const logs = [], pageerrors = [];
  const wire = (p) => {
    p.on('console', (m) => { const t = m.text(); if (/SoundCloud Suite|SoundCloud Suite|scss|sce-|Uncaught|TypeError|ReferenceError/i.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 240)}`); });
    p.on('pageerror', (e) => pageerrors.push(String(e).slice(0, 300)));
  };
  wire(page);

  /* ── helpers ── */
  const hub = (src) => page.evaluate((s) => { const h = document.getElementById('slx3-host'); const r = h && h.shadowRoot; return (new Function('root', 'panel', s))(r, r && r.querySelector('.panel')); }, src);
  const hubOpen = () => hub(`return !!(panel && panel.classList.contains('open'));`);
  // the hub's keydown gate ignores Alt+L while an input has focus (typing guard) — SoundCloud's search box can keep focus
  // after a stray key (the `?` cheat-sheet press lands there), so drop any focus before toggling
  const blurInputs = () => page.evaluate(() => { try { const ae = document.activeElement; if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) ae.blur(); } catch (e) {} });
  const openHub = async () => { if (!(await hubOpen())) { await blurInputs(); await page.keyboard.press('Alt+L'); await sleep(700); } };
  const closeHub = async () => { if (await hubOpen()) { await blurInputs(); await page.keyboard.press('Alt+L'); await sleep(500); } };
  const audioTab = async () => { await openHub(); await hub(`root.querySelector('.tab[data-tab="audio"]').click();`); await sleep(700); };
  // run `src` with `d`/`dbg` = the debug accessor's snapshot object (functions included)
  const dbg = (src) => page.evaluate((s) => { const d = window.__sceAudioDebug && window.__sceAudioDebug(); return (new Function('dbg', 'd', s))(d, d); }, src);
  // every audible param is ramped (≤ 50 ms), so a read right after a write would see the ramp in flight
  const set = async (k, v) => { const r = await dbg(`d.set(${JSON.stringify(k)}, ${JSON.stringify(v)}); return d.get(${JSON.stringify(k)});`); await sleep(90); return r; };
  const get = (k) => dbg(`return d.get(${JSON.stringify(k)});`);
  // the clip guard has two legs: 'tp' (the true-peak worklet, ceiling −1 dBTP, bypass exact) or 'comp' (thr −3 / ratio 20)
  const guardOn = (s) => (s.guard ? s.guard.on : s.params.lim.ratio === 20);
  const guardCeil = (s) => (s.guard && s.guard.mode === 'tp' ? -1 : -3);
  const guardTrim = (s) => (s.guard && s.guard.mode === 'tp' ? 1 : 0.821);
  const snap = () => dbg(`return { routed: d.routed, bypassed: d.bypassed, chains: d.chains, latencyMs: d.latencyMs, outLatMs: d.outLatMs, tabOn: d.tabOn, sampleRate: d.sampleRate, params: d.params, guard: d.guard, shaperHasCurve: d.shaperHasCurve, loudTimer: d.loudTimer, meter: d.meter, latency: d.latency(), rate: d.rate() };`);
  const fixtures = () => page.evaluate(FIXTURE_SRC);
  const play = async (kind, opts) => { await fixtures(); const r = await page.evaluate(([k, o]) => window.__afx.play(k, o), [kind, opts || {}]); await sleep(400); return r; };
  const stopPlay = () => page.evaluate(() => window.__afx && window.__afx.stop());
  const elProp = (prop) => page.evaluate((p) => { const el = window.__afx && window.__afx.el(); return el ? el[p] : null; }, prop);
  // Audio tab DOM (inside the hub's shadow root, #abody)
  const abody = (src) => hub("const a = root.querySelector('#abody'); return (new Function('a', 'root', " + JSON.stringify(src) + "))(a, root);");

  /* ── scenario runner ── */
  const results = [];
  const scenarios = [];
  const scenario = (name, fn) => scenarios.push({ name, fn });
  class AssertError extends Error {}
  const assert = (cond, msg) => { if (!cond) throw new AssertError(msg); };
  const eq = (a, b, msg) => assert(a === b, `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  const approx = (a, b, tol, msg) => assert(near(a, b, tol), `${msg}: got ${JSON.stringify(a)}, want ${b} ± ${tol == null ? 0.01 : tol}`);
  // reset every audio setting a scenario may have touched so scenarios are independent
  const AUDIO_DEFAULTS = { eqOn: false, eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eqPreamp: 0, eqAutoPre: true, eqPerTrack: false, peqOn: false, peq: [], peqPreamp: 0, peqName: '',
    bassDb: 0, bassHarm: 0, tiltDb: 0, vocalAmt: 0, loudCompOn: false, loudCompAmt: 6, listenOn: '', stereoWidth: 100, crossfeedOn: false, crossfeedMode: 'natural', balance: 0, monoOn: false, swapLR: false,
    loudnessOn: false, loudTarget: -14, boostAmt: 100, limiterOn: true, nightOn: false, nightAmt: 50, enhanceOn: false, enhanceAmt: 50, fadeOn: false, fadeIn: 0.6, fadeOut: 2.5, vinylMode: false, skipSilence: false, reverbAmt: 0, speed: 100 };
  const resetAudio = async () => {
    await dbg(`for (const [k, v] of Object.entries(${JSON.stringify(AUDIO_DEFAULTS)})) d.set(k, v); d.bypass(false); if (d.abOn()) d.abClear(); if (d.loudMemClear) d.loudMemClear(); if (d.eqMemClear) d.eqMemClear(); if (d.bpmClear) d.bpmClear(); d.gm('enh:vol', '1');`);
    await sleep(90);
  };

  /* ═══════════ scenarios ═══════════ */

  scenario('boot', async () => {
    // page loads with no errors; the accessor exists; new keys have their defaults; removed keys are gone
    assert(await page.evaluate(() => typeof window.__sceAudioDebug === 'function'), 'debug accessor missing (localStorage scss:debug gate?)');
    eq(await get('stereoWidth'), 100, 'stereoWidth default');
    eq(await get('cfgVer'), 2, 'cfgVer');
    eq(await get('widenAmt'), undefined, 'widenAmt removed');
    eq(await get('abLoop'), undefined, 'abLoop removed');
    eq(await get('eqAutoPre'), true, 'eqAutoPre default');
    eq(await get('limiterOn'), true, 'limiterOn default');
    eq(await get('boostAmt'), 100, 'boostAmt default');
    eq(await get('loudTarget'), -14, 'loudTarget default');
    eq(await get('crossfeedMode'), 'natural', 'crossfeedMode default');
    const s = await snap();
    eq(s.routed, false, 'nothing routed at boot');
    eq(s.bypassed, false, 'not bypassed at boot');
    eq(s.latencyMs, 0, 'fx latency 0 when not routed');
    eq(s.rate, 1, 'SUITE.audioRate at speed 100');
  });

  scenario('migrate', async () => {
    // an existing user's stored CFG (schema 1) migrates once: widenAmt → stereoWidth, boosting EQ → eqAutoPre false, cfgVer 2
    const KEY = 'scssgm:enh:cfg';
    const before = await page.evaluate((k) => localStorage.getItem(k), KEY);
    const old = { widenAmt: 40, eqOn: true, eqBands: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0], abLoop: true, speed: 100 };
    const p2 = await ctx.newPage(); wire(p2);
    try {
      // top frame only: the init script also runs in soundcloud's same-origin iframes, which would re-write the old CFG after the migration
      await p2.addInitScript((arg) => { try { if (window.top === window) localStorage.setItem(arg.k, JSON.stringify(arg.v)); } catch (e) {} }, { k: KEY, v: old });
      await p2.goto('https://soundcloud.com/discover', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);
      const d2 = (src) => p2.evaluate((s) => { const d = window.__sceAudioDebug && window.__sceAudioDebug(); return (new Function('d', s))(d); }, src);
      assert(await p2.evaluate(() => typeof window.__sceAudioDebug === 'function'), 'accessor missing on the migration page');
      eq(await d2(`return d.get('stereoWidth');`), 136, 'widenAmt 40 → stereoWidth 136');
      eq(await d2(`return d.get('eqAutoPre');`), false, 'boosting EQ keeps its level (eqAutoPre false)');
      eq(await d2(`return d.get('cfgVer');`), 2, 'cfgVer bumped');
      eq(await d2(`return d.get('widenAmt');`), undefined, 'widenAmt deleted from CFG');
      eq(await d2(`return d.get('abLoop');`), undefined, 'abLoop deleted from CFG');
      const stored = await p2.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
      eq(stored.cfgVer, 2, 'stored cfgVer');
      eq(stored.stereoWidth, 136, 'stored stereoWidth');
      eq('widenAmt' in stored, false, 'stored widenAmt gone');
      // a fresh user (nothing stored) keeps the defaults and is not marked as migrated-from-old
      const p3 = await ctx.newPage(); wire(p3);
      try {
        await p3.addInitScript((k) => { try { if (window.top === window) localStorage.removeItem(k); } catch (e) {} }, KEY);
        await p3.goto('https://soundcloud.com/discover', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);
        const d3 = (src) => p3.evaluate((s) => { const d = window.__sceAudioDebug && window.__sceAudioDebug(); return (new Function('d', s))(d); }, src);
        eq(await d3(`return d.get('stereoWidth');`), 100, 'fresh user stereoWidth');
        eq(await d3(`return d.get('eqAutoPre');`), true, 'fresh user eqAutoPre');
      } finally { await p3.close(); }
    } finally {
      // put the main page's storage back exactly as it was
      await page.evaluate(([k, v]) => { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); }, [KEY, before]);
      await p2.close();
    }
  });

  scenario('remembered-audio-tab', async () => {
    // the hub restores its last tab at build time with the panel CLOSED; a remembered
    // Audio tab must not route the chain (12 ms + CPU with nothing visible)
    const p2 = await ctx.newPage(); wire(p2);
    try {
      await p2.addInitScript(() => { try { if (window.top === window) localStorage.setItem('scssgm:sl:tab', JSON.stringify('audio')); } catch (e) {} });
      await p2.goto('https://soundcloud.com/discover', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);
      const d2 = (src) => p2.evaluate((s) => { const d = window.__sceAudioDebug && window.__sceAudioDebug(); return (new Function('d', s))(d); }, src);
      const h2 = (src) => p2.evaluate((s) => { const h = document.getElementById('slx3-host'); const r = h && h.shadowRoot; return (new Function('root', 'panel', s))(r, r && r.querySelector('.panel')); }, src);
      eq(await h2(`return !!(panel && panel.classList.contains('open'));`), false, 'hub closed at boot');
      eq(await h2(`return root.querySelector('.tab.on').dataset.tab;`), 'audio', 'Audio tab remembered');
      eq(await d2(`return d.tabOn;`), false, 'audio tab not active while the hub is closed');
      eq(await d2(`return d.routed;`), false, 'nothing routed at boot');
      await p2.keyboard.press('Alt+L'); await sleep(800);
      eq(await d2(`return d.tabOn;`), true, 'opening the hub on the Audio tab activates it');
      await p2.keyboard.press('Alt+L'); await sleep(500);
      eq(await d2(`return d.tabOn;`), false, 'closing deactivates it again');
    } finally {
      await page.evaluate(() => { try { localStorage.setItem('scssgm:sl:tab', JSON.stringify('lyrics')); } catch (e) {} });
      await p2.close();
    }
  });

  scenario('passthrough-routing', async () => {
    // with a fixture playing and nothing enabled the chain is built but detached; the
    // Audio tab routes it (spectrum needs signal) with every param at its inert value
    const r = await play('A', { loop: true });
    eq(r.paused, false, 'fixture A playing');
    let s = await snap();
    assert(s.chains >= 1, 'chain built for the captured source (chains=' + s.chains + ')');
    eq(s.routed, false, 'not routed with nothing enabled');
    eq(s.latencyMs, 0, 'latency 0 while detached');
    eq(s.chains, 1, 'exactly one chain for the one captured source');
    // every stage of the final chain at its inert value (spec §3 / WP1 test)
    const inert = (p, label) => {
      assert(p, label + ': no params snapshot');
      eq(p.preamp.gain, 1, label + ' preamp');
      eq(p.rumble.type, 'peaking', label + ' rumble type'); eq(p.rumble.gain, 0, label + ' rumble gain');
      eq(p.tiltLo.gain, 0, label + ' tiltLo'); eq(p.tiltHi.gain, 0, label + ' tiltHi');
      eq(p.lcLo.gain, 0, label + ' lcLo'); eq(p.lcHi.gain, 0, label + ' lcHi');
      eq(p.bands.length, 10, label + ' ten bands');
      for (let i = 0; i < p.bands.length; i++) eq(p.bands[i].gain, 0, label + ' band ' + i);
      eq(p.bands[0].frequency, 48, label + ' band 0 corner'); eq(p.bands[9].frequency, 11000, label + ' band 9 corner');
      eq(p.bands[0].type, 'lowshelf', label + ' band 0 type'); eq(p.bands[9].type, 'highshelf', label + ' band 9 type');
      eq(p.peq.length, 10, label + ' ten peq filters');
      for (let i = 0; i < p.peq.length; i++) { eq(p.peq[i].gain, 0, label + ' peq ' + i); eq(p.peq[i].type, 'peaking', label + ' peq type ' + i); }
      eq(p.bass.gain, 0, label + ' bass');
      eq(p.enhPre.gain, 1, label + ' enhPre'); eq(p.sub.gain, 0, label + ' sub'); eq(p.warm.gain, 0, label + ' warm'); eq(p.mud.gain, 0, label + ' mud'); eq(p.pres.gain, 0, label + ' pres'); eq(p.air.gain, 0, label + ' air');
      eq(p.sub.frequency, 55, label + ' sub corner'); eq(p.mud.frequency, 280, label + ' mud centre'); eq(p.pres.frequency, 3000, label + ' presence centre'); eq(p.air.frequency, 8500, label + ' air corner');
      eq(p.shaper.hasCurve, false, label + ' shaper curve null'); eq(p.shaperOversample, 'none', label + ' shaper oversample');
      eq(p.exShape.hasCurve, true, label + ' exciter curve fixed'); eq(p.exOversample, 'none', label + ' exciter oversample'); eq(p.exGain.gain, 0, label + ' exGain');
      eq(p.cpG.gain, 1, label + ' cpG'); eq(p.mbG.gain, 0, label + ' mbG'); eq(p.mbOut.gain, 1, label + ' mbOut');
      for (const k of ['mbLo', 'mbMid', 'mbHi']) { eq(p[k].ratio, 1, label + ' ' + k + '.ratio'); eq(p[k].threshold, 0, label + ' ' + k + '.threshold'); }
      eq(p.comp.ratio, 1, label + ' comp.ratio'); eq(p.comp.threshold, 0, label + ' comp.threshold'); eq(p.compTrim.gain, 1, label + ' compTrim');
      eq(p.widener.gain, 1, label + ' widener'); eq(p.vGain.gain, 1, label + ' vGain');
      eq(p.cfFeedL.gain, 0, label + ' cfFeedL'); eq(p.cfFeedR.gain, 0, label + ' cfFeedR'); eq(p.cfNegL.gain, 0, label + ' cfNegL'); eq(p.cfNegR.gain, 0, label + ' cfNegR');
      eq(p.cfLpL.frequency, 700, label + ' cfLpL corner');
      eq(p.gLL.gain, 1, label + ' gLL'); eq(p.gLR.gain, 0, label + ' gLR'); eq(p.gRL.gain, 0, label + ' gRL'); eq(p.gRR.gain, 1, label + ' gRR');
      eq(p.makeup.gain, 1, label + ' makeup'); eq(p.boost.gain, 1, label + ' boost');
      eq(p.lim.ratio, 1, label + ' lim.ratio'); eq(p.lim.threshold, 0, label + ' lim.threshold'); eq(p.limTrim.gain, 1, label + ' limTrim');
      approx(p.gA.gain + p.gB.gain, 1, 1e-6, label + ' guard legs sum to 1');
      eq(p.output.gain, 1, label + ' output');
      eq(p.kL.fftSize, 32768, label + ' K tap size'); eq(p.pL.fftSize, 32768, label + ' peak tap size'); eq(p.oL.fftSize, 32768, label + ' output tap size');
      eq(p.analyser.fftSize, 2048, label + ' spectrum analyser');
      assert(p.probe && p.probe.bands.length === 10 && p.probe.peq.length === 10 && p.probe.bass && p.probe.lcHi, label + ' probe bank present');
    };
    inert(s.params, 'detached');
    eq(s.shaperHasCurve, false, 'shaperHasCurve');
    eq(await dbg(`return d.needsLimiter;`), false, 'nothing needs the clip guard');
    // the level the speakers get on the native path (tab closed, chain detached)
    await sleep(900);
    const outPeak = () => page.evaluate(() => window.__afx.outPeakDb());
    const pre = await outPeak();
    approx(pre, -23, 0.1, 'native path: fixture A peaks at −23 dBFS');
    await audioTab();
    s = await snap();
    eq(s.tabOn, true, 'tab active');
    eq(s.routed, true, 'routed while the Audio tab is open');
    eq(s.latencyMs, 12, 'fixed chain latency while routed');
    inert(s.params, 'routed');
    await sleep(900);   // the 683 ms taps need to fill through the routed chain
    const m = await dbg(`return d.meterTick();`);
    approx(m.srcPeak, -23, 0.1, 'source tap (at input) reads the fixture peak');
    approx(m.peak, -23, 0.1, 'post-limiter tap reads the same peak — the chain is a passthrough');
    approx(m.peak, m.srcPeak, 0.02, 'output tap equals the source tap');
    const mid = await outPeak();
    approx(mid, pre, 0.1, 'what the speakers get is unchanged with the chain in the path');
    await closeHub();
    await sleep(300);
    s = await snap();
    eq(s.tabOn, false, 'tab inactive after close');
    eq(s.routed, false, 'detached again after close');
    eq(s.latencyMs, 0, 'latency back to 0');
    await sleep(900);
    approx(await outPeak(), pre, 0.1, 'native level again after detaching');
    await stopPlay();
  });

  scenario('installfx-indices', async () => {
    // spec 2.32: connect(dest, out, in) indices survive the reroute, per-entry routing state
    await play('A', { loop: true });
    const r = await page.evaluate(() => {
      const c = window.__afx.cur, ctx = c.ctx;
      const merger = ctx.createChannelMerger(2);
      window.__afx.testMerger = merger;
      c.src.connect(merger, 0, 1);   // the source into the merger's RIGHT input only
      merger.connect(ctx.destination);
      const d = window.__sceAudioDebug();
      return { routed: d.routed, has: d.dests.some((x) => x[0] === merger && x[1] === 0 && x[2] === 1), n: d.dests.length };
    });
    eq(r.routed, false, 'still detached (nothing enabled)');
    eq(r.has, true, 'dests records [merger, 0, 1] while detached');
    let pk = await page.evaluate(() => window.__afx.chanPeaks(window.__afx.testMerger));
    assert(pk[0] < -60, 'native path: merger left input silent (got ' + pk[0].toFixed(1) + ')');
    approx(pk[1], -23, 0.2, 'native path: merger right input carries the source');
    await set('monoOn', true);   // enable an effect → routed through the chain (mono of identical channels = the same level)
    const r2 = await page.evaluate(() => { const d = window.__sceAudioDebug(); return { routed: d.routed, has: d.dests.some((x) => x[0] === window.__afx.testMerger && x[1] === 0 && x[2] === 1) }; });
    eq(r2.routed, true, 'routed after enabling an effect');
    eq(r2.has, true, 'dests still reports [merger, 0, 1]');
    pk = await page.evaluate(() => window.__afx.chanPeaks(window.__afx.testMerger));
    assert(pk[0] < -60, 'routed: merger left input still silent (chain.output → input 1 preserved), got ' + pk[0].toFixed(1));
    approx(pk[1], -23, 0.2, 'routed: merger right input still carries the source at its level');
    await set('monoOn', false);
    eq((await snap()).routed, false, 'detached again');
    await page.evaluate(() => { try { window.__afx.cur.src.disconnect(window.__afx.testMerger); } catch (e) {} });
    eq(await page.evaluate(() => window.__sceAudioDebug().dests.some((x) => x[0] === window.__afx.testMerger)), false, 'disconnect(dest) drops it from dests');
    await stopPlay();
  });

  scenario('applyfx-rules', async () => {
    // the applyFx rules section 3 references, driven through CFG (their UI lands in later packages)
    await play('A', { loop: true });
    let s;
    // volume boost + clip guard (2.1 / 2.2): boost above 100 % engages the guard even with the switch off
    await set('boostAmt', 200); s = await snap();
    approx(s.params.boost.gain, 2, 0.001, 'boost 200 % → gain 2');
    eq(guardOn(s), true, 'guard ratio'); eq(s.guard.ceiling, guardCeil(s), 'guard ceiling');
    approx(s.params.limTrim.gain, guardTrim(s), 0.03, 'guard trim (1 on the true-peak leg, ≈ 0.821 on the compressor leg)');
    eq(s.routed, true, 'routed while boosting');
    await set('limiterOn', false); s = await snap();
    eq(guardOn(s), true, 'boost > 100 keeps the guard on with the switch off');
    await set('boostAmt', 100); s = await snap();
    eq(guardOn(s), false, 'guard off'); eq(s.params.lim.threshold, 0, 'guard threshold 0'); eq(s.params.limTrim.gain, 1, 'guard trim 1');
    eq(s.params.boost.gain, 1, 'boost 1'); eq(s.routed, false, 'detached again');
    await set('limiterOn', true);
    // bass shelf + automatic rumble filter (2.10)
    await set('bassDb', 4); s = await snap();
    approx(s.params.bass.gain, 4, 0.001, 'bass +4'); eq(s.params.rumble.type, 'highpass', 'rumble engaged'); eq(s.params.rumble.frequency, 25, 'rumble 25 Hz'); approx(s.params.rumble.Q, -3.01, 0.001, 'rumble Butterworth');
    eq(guardOn(s), true, 'bass boost engages the guard'); eq(s.routed, true, 'routed');
    await set('bassDb', 0); s = await snap();
    eq(s.params.bass.gain, 0, 'bass 0'); eq(s.params.rumble.type, 'peaking', 'rumble back to identity'); eq(s.params.rumble.gain, 0, 'rumble gain 0'); eq(s.routed, false, 'detached');
    // tilt (2.11), clamped to ±4
    await set('tiltDb', 3); s = await snap(); approx(s.params.tiltLo.gain, -3, 0.001, 'tiltLo −3'); approx(s.params.tiltHi.gain, 3, 0.001, 'tiltHi +3');
    await set('tiltDb', 6); s = await snap(); approx(s.params.tiltHi.gain, 4, 0.001, 'tilt clamped to 4');
    await set('tiltDb', 0);
    // vocals (2.12)
    await set('vocalAmt', -100); s = await snap(); approx(s.params.vGain.gain, 0.1, 0.001, 'vocals softer 100 → 0.1');
    await set('vocalAmt', 100); s = await snap(); approx(s.params.vGain.gain, 1.585, 0.002, 'vocals lift 100 → +4 dB');
    await set('vocalAmt', 0); s = await snap(); eq(s.params.vGain.gain, 1, 'vocals 0 → 1');
    // crossfeed (2.16): exact-complement gains per mode
    await set('crossfeedOn', true); s = await snap();
    approx(s.params.cfFeedL.gain, 0.334, 0.001, 'natural feed'); approx(s.params.cfNegL.gain, -0.334, 0.001, 'natural complement'); approx(s.params.cfFeedR.gain, 0.334, 0.001, 'natural feed R');
    eq(s.params.cfLpL.frequency, 700, 'crossfeed lowpass 700'); approx(s.params.cfLpL.Q, -3.01, 0.001, 'crossfeed Butterworth');
    await set('crossfeedMode', 'strong'); s = await snap(); approx(s.params.cfFeedL.gain, 0.373, 0.001, 'strong feed');
    await set('crossfeedMode', 'subtle'); s = await snap(); approx(s.params.cfFeedL.gain, 0.251, 0.001, 'subtle feed');
    // mono-sum identity: fixture A has identical channels, so crossfeed must not change the output level
    await sleep(800); const cfOn = await dbg(`return d.meterTick().outDb;`);
    await set('crossfeedOn', false); await set('stereoWidth', 105); await sleep(800); const cfOff = await dbg(`return d.meterTick().outDb;`);   // width 105 keeps it routed for the read
    await set('stereoWidth', 100); await set('crossfeedMode', 'natural');
    approx(cfOn, cfOff, 0.1, 'crossfeed on a mono-summed signal is level-identical');
    s = await snap(); eq(s.params.cfFeedL.gain, 0, 'crossfeed off → 0'); eq(s.params.cfNegL.gain, 0, 'complement off → 0');
    // balance / mono (2.17 / 2.18): attenuate only, identity when off
    await set('balance', 50); s = await snap(); approx(s.params.gLL.gain, 0.5, 0.001, 'balance 50 → L 0.5'); eq(s.params.gRR.gain, 1, 'R untouched'); eq(s.params.gLR.gain, 0, 'no bleed'); eq(s.params.gRL.gain, 0, 'no bleed');
    await set('balance', -100); s = await snap(); eq(s.params.gLL.gain, 1, 'balance −100 → L 1'); approx(s.params.gRR.gain, 0, 0.001, 'R 0');
    await set('balance', 0); await set('monoOn', true); s = await snap();
    for (const k of ['gLL', 'gLR', 'gRL', 'gRR']) approx(s.params[k].gain, 0.5, 0.001, 'mono ' + k);
    await set('monoOn', false); s = await snap(); eq(s.params.gLL.gain, 1, 'identity LL'); eq(s.params.gLR.gain, 0, 'identity LR'); eq(s.routed, false, 'detached');
    // Enhance v2 (2.25): its own headroom, five tone stages, the unity-gain cubic + exciter at 4×, the three-band
    // bank in place of the wideband compressor (cpG 0 / mbG 1), the measured level match on compTrim
    await set('enhanceOn', true); await set('enhanceAmt', 100); s = await snap();
    approx(s.params.enhPre.gain, Math.pow(10, -3.5 / 20), 0.001, 'pre-gain −3.5 dB (sub + warm stacked)');
    approx(s.params.sub.gain, 2, 0.001, 'sub +2'); approx(s.params.warm.gain, 1.5, 0.001, 'warm +1.5'); approx(s.params.mud.gain, -1.5, 0.001, 'mud −1.5'); approx(s.params.pres.gain, 2, 0.001, 'presence +2');
    eq(s.params.air.frequency, 8500, 'air 8.5 kHz'); approx(s.params.air.gain, 3, 0.001, 'air +3');
    const tm = await dbg(`return d.enhToneMaxDb(1);`); assert(tm > 3.3 && tm <= 3.5, 'the tone never boosts past the pre-gain (max ' + tm + ' dB)');
    approx(s.params.exGain.gain, 0.22, 0.001, 'exciter mix 0.22'); eq(s.params.exOversample, '4x', 'exciter 4×');
    eq(s.params.comp.ratio, 1, 'wideband comp inert'); eq(s.params.comp.threshold, 0, 'comp thr 0'); eq(s.params.cpG.gain, 0, 'cpG 0');
    assert(s.params.mbG.gain > 0 && Math.abs(s.params.mbG.gain * s.params.mbOut.gain - 1) < 0.02, 'the bank is in and its offset wrap nets to 1 (mbG ' + s.params.mbG.gain.toFixed(3) + ' · mbOut ' + s.params.mbOut.gain.toFixed(3) + ')');
    approx(s.params.mbLo.threshold, -23.5, 0.001, 'lo thr −23.5'); approx(s.params.mbLo.ratio, 1.6, 0.001, 'lo ratio 1.6'); approx(s.params.mbLo.attack, 0.03, 0.001, 'lo attack'); approx(s.params.mbLo.release, 0.2, 0.001, 'lo release');
    approx(s.params.mbMid.threshold, -21.5, 0.001, 'mid thr −21.5'); approx(s.params.mbMid.ratio, 1.5, 0.001, 'mid ratio 1.5'); approx(s.params.mbMid.attack, 0.012, 0.001, 'mid attack'); approx(s.params.mbMid.release, 0.15, 0.001, 'mid release');
    approx(s.params.mbHi.threshold, -27.5, 0.001, 'hi thr −27.5'); approx(s.params.mbHi.ratio, 1.7, 0.001, 'hi ratio 1.7'); approx(s.params.mbHi.attack, 0.005, 0.001, 'hi attack'); approx(s.params.mbHi.release, 0.1, 0.001, 'hi release');
    for (const k of ['mbLo', 'mbMid', 'mbHi']) approx(s.params[k].knee, 12, 0.001, k + ' knee 12');
    eq(s.shaperHasCurve, true, 'shaper has a curve'); eq(s.params.shaperOversample, '4x', 'oversample 4x'); eq(s.latencyMs, 12 + Math.round(192000 / s.sampleRate), 'latency + shapers');
    approx(await dbg(`return d.curveSample(0.01);`), 0.01, 1e-4, 'unity small-signal gain'); approx(await dbg(`return d.curveSample(1);`), 0.88, 0.01, 'curve ≤ 0.88 at full scale');
    // the level match: the bench's table stands in until the offline render lands, then the exact figure takes over
    const enhKey = '20|' + s.sampleRate, tableDb = -0.56;   // the bench's figure at 100 % — the stand-in until the render lands
    let ec = (await dbg(`return d.enhCalib();`))[enhKey]; assert(ec, enhKey + ' not in the Enhance calibration map');
    for (let i = 0; i < 30 && !ec.exact; i++) { await sleep(100); ec = (await dbg(`return d.enhCalib();`))[enhKey]; }
    assert(ec.exact, 'the offline level calibration landed'); assert(Math.abs(ec.db - tableDb) < 0.5, 'the measured block gain agrees with the bench table (' + ec.db.toFixed(2) + ' vs ' + tableDb + ' dB)');
    await sleep(120); s = await snap(); approx(s.params.compTrim.gain, Math.pow(10, -ec.db / 20), 0.005, 'compTrim = −(block gain ' + ec.db.toFixed(2) + ' dB)');
    console.log('  Enhance calibration: ' + JSON.stringify(await dbg(`const c = d.enhCalib(); const o = {}; for (const k in c) o[k] = +c[k].db.toFixed(2) + (c[k].exact ? '' : ' (table)'); return o;`)));
    // trim = makeup − Chromium's auto-makeup. The suite's synchronous estimate replicates Chromium's static-curve
    // maths (chromium-makeup.js here does the same); the offline calibration must agree with it within 0.3 dB.
    const expTrim = async (makeupDb, key, chromiumDb) => { const cal = await dbg(`return d.calib();`); const c = cal[key]; assert(c, key + ' not in the calibration map'); assert(Math.abs(c.db - chromiumDb) < 0.3, key + ' auto-makeup ' + c.db.toFixed(2) + ' dB (exact=' + c.exact + ') disagrees with Chromium\'s static curve ' + chromiumDb); return Math.pow(10, (makeupDb - c.db) / 20); };
    eq(guardOn(s), true, 'Enhance engages the guard');
    await dbg(`d.bypass(true);`); await sleep(100); s = await snap();
    eq(s.shaperHasCurve, false, 'Compare nulls the curve'); eq(s.params.shaperOversample, '4x', 'Compare leaves oversample alone'); eq(s.params.exOversample, '4x', 'exciter oversample too');
    eq(s.params.air.gain, 0, 'Compare nulls air'); eq(s.params.sub.gain, 0, 'Compare nulls sub'); eq(s.params.enhPre.gain, 1, 'Compare nulls the pre-gain'); eq(s.params.exGain.gain, 0, 'Compare nulls the exciter');
    eq(s.params.mbG.gain, 0, 'Compare parks the bank'); eq(s.params.cpG.gain, 1, 'cpG back to 1'); eq(s.params.mbLo.ratio, 1, 'bank inert'); eq(s.params.compTrim.gain, 1, 'compTrim 1');
    eq(s.params.rumble.type, 'highpass', 'Compare never flips the rumble filter');
    await dbg(`d.bypass(false);`); await sleep(100);
    // Night mode wins the compressor (2.7)
    await set('nightOn', true); await set('nightAmt', 50); await sleep(150); s = await snap();   // the calibration promise re-ramps the trim once it lands
    approx(s.params.comp.threshold, -30, 0.001, 'night thr −30'); approx(s.params.comp.ratio, 3, 0.001, 'night ratio 3'); approx(s.params.comp.knee, 24, 0.001, 'night knee 24');
    approx(s.params.comp.attack, 0.02, 0.001, 'night attack'); approx(s.params.comp.release, 0.5, 0.001, 'night release');
    // Enhance (still on at 100 %) keeps its tone under Night; its −3.5 dB pre-gain is given back on the trim
    approx(s.params.compTrim.gain, (await expTrim(14.7, '-30|24|3', 6.03)) * Math.pow(10, 3.5 / 20), 0.03, 'night compTrim = makeup 14.7 dB − auto-makeup 6.03 dB + Enhance pre-gain 3.5 dB');
    eq(s.params.cpG.gain, 1, 'Night takes the wideband leg'); eq(s.params.mbG.gain, 0, 'the bank idles under Night'); approx(s.params.air.gain, 3, 0.001, 'Enhance tone stays');
    console.log('  calibration: ' + JSON.stringify(await dbg(`const c = d.calib(); const o = {}; for (const k in c) o[k] = +c[k].db.toFixed(2) + (c[k].exact ? '' : ' (analytic)'); return o;`)));
    await set('nightOn', false); await set('enhanceOn', false); s = await snap();
    eq(s.params.comp.ratio, 1, 'comp inert'); eq(s.params.comp.threshold, 0, 'comp thr 0'); eq(s.params.compTrim.gain, 1, 'compTrim 1'); eq(s.params.shaperOversample, 'none', 'oversample none'); eq(s.params.exOversample, 'none', 'exciter oversample none'); eq(s.routed, false, 'detached');
    // headphone-correction bank (2.8, DSP part) + auto-headroom folding peqPreamp in
    await set('peq', [{ t: 'PK', f: 105, g: 3.1, q: 0.7 }, { t: 'HSC', f: 10000, g: -2, q: 0.7 }]); await set('peqPreamp', -6); await set('peqOn', true); s = await snap();
    eq(s.params.peq[0].frequency, 105, 'peq 0 freq'); approx(s.params.peq[0].gain, 3.1, 0.001, 'peq 0 gain'); approx(s.params.peq[0].Q, 0.7, 0.001, 'peq 0 Q'); eq(s.params.peq[1].type, 'highshelf', 'peq 1 type');
    eq(s.params.peq[2].gain, 0, 'unused peq slot inert');
    approx(s.params.preamp.gain, Math.pow(10, -6 / 20), 0.01, 'preamp = peqPreamp (profile preamp covers its own boost, no extra headroom)');
    eq(s.params.rumble.type, 'highpass', 'peq engages the rumble filter');
    await set('peqOn', false); s = await snap();
    for (let i = 0; i < 10; i++) eq(s.params.peq[i].gain, 0, 'peq ' + i + ' off');
    eq(s.params.preamp.gain, 1, 'preamp back to 1');
    // auto-headroom from the composite (2.9)
    await set('eqOn', true); await set('eqBands', [6, 0, 0, 0, 0, 0, 0, 0, 0, 0]); s = await snap();
    approx(s.params.preamp.gain, Math.pow(10, -6 / 20), 0.02, 'one +6 band → −6 dB headroom');
    eq(s.params.bands[0].gain, 6, 'band 0 +6');
    await set('eqBands', [6, 6, 0, 0, 0, 0, 0, 0, 0, 0]); s = await snap();
    assert(s.params.preamp.gain < Math.pow(10, -6 / 20), 'overlapping bands count (got ' + s.params.preamp.gain.toFixed(3) + ')');
    assert(s.params.preamp.gain > Math.pow(10, -9 / 20), 'but not absurdly (got ' + s.params.preamp.gain.toFixed(3) + ')');
    const hr = await dbg(`return d.headroomDb;`); assert(hr > 6 && hr < 9, 'headroomDb ≈ 7.5 (got ' + hr + ')');
    await set('eqAutoPre', false); s = await snap(); eq(s.params.preamp.gain, 1, 'auto-headroom off → 1');
    // the overlap sits near 62 Hz (the 48 Hz shelf's tail + the +6 peak), not at 31 Hz where the Q-1.4 peak is an octave away
    const c31 = await dbg(`return d.curveAt(31);`), c62 = await dbg(`return d.curveAt(62);`);
    approx(c31, 6, 1, 'composite at 31 Hz ≈ the shelf alone');
    assert(c62 > 7 && c62 < 10.5 && c62 > c31 + 1, 'composite at 62 Hz shows the overlap (got ' + c62.toFixed(2) + ', 31 Hz ' + c31.toFixed(2) + ')');
    await set('eqBands', [0, 0, 0, 0, 0, 6, 0, 0, 0, 0]);   // index 5 is the 1 kHz band (EQ_FREQS: 31, 62, 125, 250, 500, 1000, …)
    approx(await dbg(`return d.curveAt(1000);`), 6, 0.5, 'curveAt(1000) with the 1 kHz band at +6');
    assert((await dbg(`return d.curveAt(4000);`)) < 1.5, 'curveAt(4000) < 1.5');
    // loudness contour + loudness normalize gates (values only in WP1: contour k is 0 until the enforce tick drives it)
    await set('loudCompOn', true); s = await snap(); eq(s.params.lcLo.gain, 0, 'contour shelves stay 0 at k = 0'); eq(s.params.rumble.type, 'highpass', 'contour engages the rumble filter'); eq(s.routed, true, 'contour routes');
    await set('loudCompOn', false);
    await set('eqOn', false); await set('eqAutoPre', true);
    await set('loudnessOn', true); s = await snap(); eq(s.loudTimer, true, 'loudness timer runs while routed'); eq(guardOn(s), true, 'loudness engages the guard');
    await set('loudnessOn', false); s = await snap(); eq(s.loudTimer, false, 'loudness timer stopped'); eq(s.params.makeup.gain, 1, 'makeup back to 1'); eq(s.routed, false, 'detached');
    // the calibration promise landed and refined the guard trim
    await set('boostAmt', 150); await sleep(400); s = await snap();
    const cal = await dbg(`return d.calib();`);
    if (s.guard.mode === 'tp') eq(s.params.limTrim.gain, 1, 'true-peak leg: no makeup to cancel');
    else {
      assert(cal['-3|0|20'] && cal['-3|0|20'].exact === true, 'guard makeup calibrated offline');
      approx(s.params.limTrim.gain, Math.pow(10, -cal['-3|0|20'].db / 20), 0.002, 'limTrim uses the calibrated value');
      approx(cal['-3|0|20'].db, 1.71, 0.5, 'calibrated auto-makeup near the analytic 1.71 dB (got ' + cal['-3|0|20'].db.toFixed(2) + ')');
    }
    await set('boostAmt', 100);
    await stopPlay();
  });

  scenario('stereo-width', async () => {
    // stereoWidth 0..200 drives the M/S widener: 100 = bit-exact, 0 = mono, 200 = side +6 dB; alone at 100 nothing is routed
    await play('A', { loop: true });
    await set('stereoWidth', 150);
    let s = await snap();
    approx(s.params.widener.gain, 1.5, 0.001, 'widener at 150');
    eq(s.routed, true, 'routed at 150');
    await set('stereoWidth', 200); s = await snap(); approx(s.params.widener.gain, 2, 0.001, 'widener at 200');
    await set('stereoWidth', 0); s = await snap(); approx(s.params.widener.gain, 0, 0.001, 'widener at 0');
    await set('stereoWidth', 100); s = await snap(); approx(s.params.widener.gain, 1, 0.001, 'widener at 100');
    eq(s.routed, false, 'not routed at 100 (tab closed, nothing else on)');
    // the slider in the tab: 0..200, reads Normal at 100, label double-click resets
    await audioTab();
    const row = await abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.max === '200' && x.parentElement.firstChild.textContent === 'Stereo width'); if (!r) return null; const row = r.parentElement; return { min: r.min, max: r.max, value: r.value, label: row.firstChild.textContent, val: row.lastChild.textContent, title: row.firstChild.title };`);
    assert(row, 'Stereo width slider present (max 200; the Speed row shares that max, so it is found by label)');
    eq(row.label, 'Stereo width', 'slider label');
    eq(row.value, '100', 'slider value');
    eq(row.val, 'Normal', 'value text at 100');
    assert(/double-click resets/.test(row.title), 'label title mentions double-click reset');
    await abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.max === '200' && x.parentElement.firstChild.textContent === 'Stereo width'); r.value = 150; r.dispatchEvent(new Event('input', { bubbles: true }));`);
    await sleep(350);
    eq(await get('stereoWidth'), 150, 'slider input writes stereoWidth');
    eq(await abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.max === '200' && x.parentElement.firstChild.textContent === 'Stereo width'); return r.parentElement.lastChild.textContent;`), '150%', 'value text at 150');
    await abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.max === '200' && x.parentElement.firstChild.textContent === 'Stereo width'); r.parentElement.firstChild.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`);
    await sleep(350);
    eq(await get('stereoWidth'), 100, 'label double-click resets to 100');
    await closeHub();
    await stopPlay();
  });

  scenario('latency-accounting', async () => {
    // SUITE.audioLatency = device latency + chain latency: 12 ms when routed (two compressor stages, rate-independent),
    // + round(192000/sr) while Enhance is on (two 4× shapers in parallel legs); 0 when detached. SUITE.audioRate follows the speed.
    await play('A', { loop: true, sampleRate: 48000 });
    await audioTab();
    let s = await snap();
    eq(s.sampleRate, 48000, 'context at 48 kHz');
    eq(s.latency - s.outLatMs, 12, 'routed @48k');
    await set('enhanceOn', true); s = await snap();
    eq(s.latency - s.outLatMs, 16, 'routed + Enhance @48k');
    await set('enhanceOn', false);
    await play('A', { loop: true, sampleRate: 44100 });
    s = await snap();
    eq(s.sampleRate, 44100, 'context at 44.1 kHz');
    eq(s.latency - s.outLatMs, 12, 'routed @44.1k');
    await set('enhanceOn', true); s = await snap();
    eq(s.latency - s.outLatMs, 16, 'routed + Enhance @44.1k');
    await set('enhanceOn', false);
    await closeHub(); await sleep(300);
    s = await snap();
    eq(s.latency - s.outLatMs, 0, 'detached → 0');
    await set('speed', 150); s = await snap();
    approx(s.rate, 1.5, 0.001, 'SUITE.audioRate at speed 150');
    await sleep(1500);   // applySpeed runs on the ~1 s enforce tick
    approx(await elProp('playbackRate'), 1.5, 0.01, 'fixture element rate follows');
    await set('speed', 100);
    await stopPlay();
  });

  scenario('save-debounce', async () => {
    // dragging a band through 12 values in 200 ms writes storage at most twice (saveSoon)
    const n = await page.evaluate(async () => {
      const orig = window.GM_setValue; let count = 0;
      window.GM_setValue = function (k, v) { if (k === 'enh:cfg') count++; return orig.apply(this, arguments); };
      try {
        const d = window.__sceAudioDebug();
        for (let i = 1; i <= 12; i++) { d.setBand(0, i); await new Promise((r) => setTimeout(r, 15)); }
        await new Promise((r) => setTimeout(r, 600));
      } finally { window.GM_setValue = orig; }
      return count;
    });
    assert(n <= 2, 'GM_setValue calls during a 12-step drag: ' + n);
    eq((await get('eqBands'))[0], 12, 'band 0 ended at 12');
    eq(await get('eqOn'), true, 'touching the EQ turned it on');
    await resetAudio();
  });

  scenario('compare-scaffold', async () => {
    // fxBypass is live state: bypass nulls the tone stages (routing stays), the tab closing and a window blur clear it
    await play('A', { loop: true });
    await set('eqAutoPre', false);   // auto-headroom would (correctly) take the +6 dB band off the pre-amp; this scenario is about Compare
    await set('eqOn', true); await set('eqBands', [6, 0, 0, 0, 0, 0, 0, 0, 0, 0]); await set('eqPreamp', -3);
    let s = await snap();
    eq(s.params.bands[0].gain, 6, 'band 0 applied');
    approx(s.params.preamp.gain, Math.pow(10, -3 / 20), 0.001, 'preamp applied');
    await dbg(`d.bypass(true);`); await sleep(100);
    s = await snap();
    eq(s.bypassed, true, 'bypassed flag');
    eq(s.params.bands[0].gain, 0, 'band 0 nulled during compare');
    eq(s.params.preamp.gain, 1, 'preamp nulled during compare');
    eq(s.routed, true, 'routing untouched during compare');
    await dbg(`d.bypass(false);`); await sleep(100);
    s = await snap();
    eq(s.bypassed, false, 'bypass cleared');
    eq(s.params.bands[0].gain, 6, 'band 0 back');
    // lifetime: the tab going inactive clears a latched compare
    await audioTab();
    await dbg(`d.bypass(true);`);
    eq((await snap()).bypassed, true, 'bypassed while the tab is open');
    await closeHub(); await sleep(200);
    eq((await snap()).bypassed, false, 'closing the hub clears the compare');
    // a lost keyup: window blur clears it
    await dbg(`d.bypass(true);`);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(100);
    eq((await snap()).bypassed, false, 'window blur clears the compare');
    await resetAudio();
    await stopPlay();
  });

  scenario('ab-live-state', async () => {
    // the A–B loop is live state (abOn), no longer a persisted flag: the enforce tick still wraps
    await play('C', { loop: true });
    await dbg(`d.ab(2, 3);`);
    eq(await dbg(`return d.abOn();`), true, 'abOn after marking');
    eq(await get('abLoop'), undefined, 'no persisted abLoop key');
    await dbg(`d.seek(2.2);`);
    let maxT = 0;
    for (let i = 0; i < 40; i++) { const t = await elProp('currentTime'); if (t > maxT) maxT = t; await sleep(100); }
    assert(maxT < 4.5, 'the loop wraps (max currentTime ' + maxT.toFixed(2) + ')');
    await dbg(`d.abClear();`);
    eq(await dbg(`return d.abOn();`), false, 'abClear clears abOn');
    await stopPlay();
  });

  /* ── WP2 helpers: the header sub-line, the Compare button, a toggle row's description, a slider row by its max ── */
  const subLine = () => abody(`return a.firstElementChild.firstElementChild.children[1].textContent;`);
  const cmpBtn = () => abody(`const b = [...a.querySelectorAll('button')].find((x) => x.textContent === 'Compare'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: b.title, bg: b.style.background, color: b.style.color, w: r.width, h: r.height };`);
  const bodyOpacity = () => abody(`return a.children[2] ? (a.children[2].style.opacity || '1') : null;`);
  const toggleDesc = (label) => abody(`const b = [...a.querySelectorAll('button[role=switch]')].find((x) => x.previousElementSibling && x.previousElementSibling.firstChild && x.previousElementSibling.firstChild.textContent === ${JSON.stringify(label)}); return b ? b.previousElementSibling.children[1].textContent : null;`);
  const sliderByMax = (max) => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.max === ${JSON.stringify(String(max))}); if (!r) return null; const row = r.parentElement; return { min: r.min, max: r.max, step: r.step, value: r.value, label: row.firstChild.textContent, val: row.lastChild.textContent, color: row.lastChild.style.color, title: row.firstChild.title };`);
  const sliderInput = (max, v) => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.max === ${JSON.stringify(String(max))}); r.value = ${+v}; r.dispatchEvent(new Event('input', { bubbles: true }));`);
  const sliderDbl = (max) => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.max === ${JSON.stringify(String(max))}); r.parentElement.firstChild.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`);
  const TINT = { bg: 'rgba(255, 85, 0, 0.22)', color: 'rgb(255, 176, 131)' }, PLAIN = { bg: 'rgba(255, 255, 255, 0.06)', color: 'rgb(196, 196, 202)' };
  // n meter reads `every` ms apart (each read = a fresh 683 ms tap buffer)
  const meterReads = async (n, every) => { const out = []; for (let i = 0; i < n; i++) { out.push(await dbg(`return d.meterTick();`)); await sleep(every); } return out; };
  const powerAvg = (dbs) => 10 * Math.log10(dbs.reduce((acc, v) => acc + Math.pow(10, v / 10), 0) / dbs.length);

  scenario('clip-guard', async () => {
    // 2.1: fixture B (0 dBFS square bursts) through the routed, otherwise-transparent chain: the post-limiter tap
    // reads the bursts at full scale (it sees the chain output); boost 300 % then never gets past −1 dBFS
    await play('B', { loop: true, sampleRate: 48000 });
    await audioTab();
    await sleep(2600);   // the fixture opens with 2 s of silence
    let s = await snap();
    eq(guardOn(s), false, 'guard inert with nothing on'); eq(s.params.boost.gain, 1, 'boost 1');
    let rs = await meterReads(12, 250);
    approx(Math.max(...rs.map((m) => m.peak)), 0, 0.2, 'post-limiter tap reads the 0 dBFS bursts with boost 100 % and nothing on');
    await set('boostAmt', 300); await sleep(800);   // the ramp + a full tap buffer
    s = await snap();
    eq(guardOn(s), true, 'boost 300 % engages the guard');
    eq(s.guard.mode, 'tp', 'the true-peak limiter leg is in the chain'); eq(s.guard.bypass, 0, 'and engaged (bypass 0)');
    eq(s.guard.latencySamples, Math.round(0.005 * s.sampleRate), '5 ms look-ahead'); eq(s.guard.alignSamples, Math.floor(0.006 * s.sampleRate) - s.guard.latencySamples, 'padded to the compressor pre-delay');
    approx(s.params.gA.gain, 0, 1e-6, 'compressor leg silent'); approx(s.params.gB.gain, 1, 1e-6, 'true-peak leg live');
    console.log('  guard: ' + JSON.stringify(s.guard)); eq(s.guard.ceiling, guardCeil(s), 'ceiling (−1 dBTP true-peak leg / −3 dB compressor leg)'); approx(s.params.boost.gain, 3, 0.001, 'boost ×3');
    approx(s.params.limTrim.gain, guardTrim(s), 0.03, 'guard trim');
    rs = await meterReads(12, 250);
    const worst = Math.max(...rs.map((m) => m.peak));
    assert(worst <= -1.0, 'boost 300 %: every post-limiter peak ≤ −1.0 dBFS over 3 s (worst ' + worst.toFixed(2) + ')');
    assert(rs.some((m) => m.limGr < -0.3), 'the guard reports gain reduction during the bursts');
    // the row: last in Loudness & dynamics; its description gains the live GR suffix while limiting (bursts are 100 ms, so poll)
    const base = 'Stops boosts from distorting · on automatically when boosting or enhancing';
    let seenGr = null, seenSub = null;
    for (let i = 0; i < 30 && !(seenGr && seenSub); i++) { const d = await toggleDesc('Clip guard'); assert(d && d.indexOf(base) === 0, 'Clip guard description (got ' + d + ')'); if (/· −\d+\.\d dB$/.test(d)) seenGr = d; const sub = await subLine(); if (/guard −\d+\.\d dB/.test(sub)) seenSub = sub; await sleep(100); }
    assert(seenGr, 'live GR suffix on the Clip guard row while limiting');
    assert(seenSub, 'header sub-line shows the guard segment while limiting');
    assert(/boost 300 %/.test(seenSub), 'sub-line carries the boost (got ' + seenSub + ')');
    assert(/peak −\d+\.\d dB/.test(seenSub), 'sub-line carries the post-limiter peak (got ' + seenSub + ')');
    const order = await abody(`return [...a.querySelectorAll('button[role=switch]')].map((b) => b.previousElementSibling.firstChild.textContent);`);
    eq(order.indexOf('Clip guard') > order.indexOf('Loudness normalize'), true, 'Clip guard after Loudness normalize');
    // the switch drives limiterOn (rows read CFG at render time, so the UI switch is the honest way to flip it)
    const guardSw = (src) => abody(`const b = [...a.querySelectorAll('button[role=switch]')].find((x) => x.previousElementSibling.firstChild.textContent === 'Clip guard'); ` + src);
    await set('boostAmt', 100); await sleep(100);
    eq(await guardSw(`return b.getAttribute('aria-checked');`), 'true', 'switch on at render (limiterOn default)');
    await guardSw(`b.click();`); await sleep(200);
    eq(await get('limiterOn'), false, 'clicking the switch turns the guard off');
    eq(await guardSw(`return b.getAttribute('aria-checked');`), 'false', 'switch reflects limiterOn');
    s = await snap();
    eq(guardOn(s), false, 'guard off'); eq(s.params.lim.threshold, 0, 'threshold 0'); eq(s.params.limTrim.gain, 1, 'trim 1');
    // lim.reduction is a meter with its own ~325 ms release, so the suffix decays away within ~1.5 s of the guard disengaging
    let cleared = false;
    for (let i = 0; i < 30 && !cleared; i++) { await sleep(100); if ((await toggleDesc('Clip guard')) === base) cleared = true; }
    assert(cleared, 'suffix gone once nothing limits (got ' + await toggleDesc('Clip guard') + ')');
    eq(await subLine(), '10-band · drag the curve · double-click resets', 'sub-line back to the hint');
    await guardSw(`b.click();`); await sleep(200);
    eq(await get('limiterOn'), true, 'clicking again turns it back on');
    await closeHub(); await stopPlay();
  });

  scenario('volume-boost', async () => {
    // 2.2: the slider (100..300, step 5, resets to 100, orange value above 100), the boost gain, the guard, the header sub-line
    await play('A', { loop: true });
    await set('boostAmt', 250);
    await audioTab(); await sleep(500);
    let s = await snap();
    approx(s.params.boost.gain, 2.5, 0.001, 'boost 250 % → gain 2.5'); eq(s.routed, true, 'routed'); eq(guardOn(s), true, 'guard engaged');
    let sub = await subLine();
    assert(/boost 250 %/.test(sub), 'header sub-text contains the boost (got ' + sub + ')');
    const pk = /peak (−?\d+\.\d) dB/.exec(sub); assert(pk, 'header sub-text carries the post-limiter peak (got ' + sub + ')');
    approx(parseFloat(pk[1].replace('−', '-')), -23 + 20 * Math.log10(2.5), 0.3, 'peak segment = source −23 dBFS + the boost');
    let row = await sliderByMax(300);
    assert(row, 'Volume boost slider present');
    eq(row.label, 'Volume boost', 'label'); eq(row.min, '100', 'min'); eq(row.step, '5', 'step'); eq(row.value, '250', 'slider value follows CFG at render');
    eq(row.val, '250%', 'value text'); eq(row.color, 'rgb(255, 106, 31)', 'value text is orange above 100 %');
    assert(/double-click resets/.test(row.title), 'label title mentions the reset');
    await sliderInput(300, 150); await sleep(400);
    eq(await get('boostAmt'), 150, 'slider input writes boostAmt');
    s = await snap(); approx(s.params.boost.gain, 1.5, 0.001, 'gain follows the slider');
    row = await sliderByMax(300); eq(row.val, '150%', 'value text at 150');
    await sliderDbl(300); await sleep(400);
    eq(await get('boostAmt'), 100, 'label double-click resets to 100');
    row = await sliderByMax(300); eq(row.val, '100%', 'value text at 100'); eq(row.color, 'rgb(134, 134, 142)', 'value text back to grey at 100 %');
    s = await snap(); eq(s.params.boost.gain, 1, 'gain 1'); eq(guardOn(s), false, 'guard disengaged');
    eq(await subLine(), '10-band · drag the curve · double-click resets', 'hint back');
    // the row sits in Loudness & dynamics (section 4: Loudness normalize · Night mode · Strength · Volume boost · Clip guard)
    const seq = await abody(`return [...a.querySelectorAll('input[type=range], button[role=switch]')].map((el) => el.type === 'range' ? el.parentElement.firstChild.textContent : el.previousElementSibling.firstChild.textContent);`);
    const i1 = seq.indexOf('Loudness normalize'), i2 = seq.indexOf('Volume boost'), i3 = seq.indexOf('Clip guard');
    assert(i1 >= 0 && seq[i1 + 1] === 'Night mode' && seq[i1 + 2] === 'Strength' && i2 === i1 + 3 && i3 === i2 + 1, 'Loudness normalize → Night mode → Strength → Volume boost → Clip guard (got ' + JSON.stringify(seq) + ')');
    // with the tab closed the boost alone routes; 100 % detaches
    await closeHub(); await sleep(300);
    eq((await snap()).routed, false, 'detached with boost 100 and the tab closed');
    await set('boostAmt', 250); eq((await snap()).routed, true, 'boost 250 alone routes');
    await set('boostAmt', 100); eq((await snap()).routed, false, 'back to 100 → detached');
    await stopPlay();
  });

  scenario('compare-ui', async () => {
    // 2.3: Compare is level-honest (tone nulled, the loudness gain / boost / guard kept, routing untouched), the button
    // holds and latches, the body dims, the latch never outlives the tab
    await play('A', { loop: true });
    await set('eqAutoPre', false);
    await set('eqOn', true); await set('eqBands', [6, 0, 0, 0, 0, 0, 0, 0, 0, 0]); await set('enhanceOn', true); await set('loudnessOn', true);
    await audioTab();
    // the loudness gain lands on fixture A after 3 s of measurement and rises toward 2.82 with tau 3 s: wait until
    // it is past 2.5 (then 120 ms of ramp moves it by < 0.02), so the 'unchanged' check measures Compare, not the ramp
    let s = await snap();
    for (let i = 0; i < 40 && s.params.makeup.gain < 2.5; i++) { await sleep(400); s = await snap(); }
    assert(s.params.makeup.gain > 2.5, 'loudness gain measured and mostly settled (makeup ' + s.params.makeup.gain + ')');
    const mk = s.params.makeup.gain;
    await dbg(`d.bypass(true);`); await sleep(120);
    s = await snap();
    eq(s.params.bands[0].gain, 0, 'band 0 nulled'); eq(s.params.preamp.gain, 1, 'preamp 1');
    approx(s.params.makeup.gain, mk, 0.03, 'loudness gain unchanged'); eq(s.params.shaperOversample, '4x', 'oversample stays 4x'); eq(s.shaperHasCurve, false, 'curve nulled');
    eq(s.routed, true, 'routing untouched'); eq(guardOn(s), true, 'guard stays for the kept loudness gain');
    eq(await subLine(), 'Comparing · original tone', 'held sub-line');
    let b = await cmpBtn(); assert(b, 'Compare button in the header'); eq(b.bg, TINT.bg, 'tinted while comparing'); eq(b.color, TINT.color, 'tinted text');
    eq(parseFloat(await bodyOpacity()), 0.45, 'body dimmed');
    await dbg(`d.bypass(false);`); await sleep(120);
    s = await snap(); approx(s.params.bands[0].gain, 6, 0.001, 'band 0 back'); eq(await bodyOpacity(), '1', 'body back');
    b = await cmpBtn(); eq(b.bg, PLAIN.bg, 'un-tinted'); eq(b.title, 'Hold to hear the original · click to keep comparing', 'tooltip');
    assert(/^−\d+\.\d LUFS · peak −\d+\.\d dB · \+\d+\.\d dB applied/.test(await subLine()), 'meter sub-line back (got ' + await subLine() + ')');
    // hold with the mouse: comparing while down, back on release (≥ 350 ms → no latch)
    await page.mouse.move(b.x, b.y); await page.mouse.down(); await sleep(150);
    eq((await snap()).bypassed, true, 'held → comparing');
    await sleep(500); await page.mouse.up(); await sleep(150);
    eq((await snap()).bypassed, false, 'release after a hold → back');
    // a quick click latches; the tint survives the pointer leaving; a second click releases
    await page.mouse.down(); await sleep(60); await page.mouse.up(); await sleep(150);
    eq((await snap()).bypassed, true, 'quick click latches');
    eq(await subLine(), 'Comparing · original tone — click Compare to return', 'latched sub-line');
    eq(parseFloat(await bodyOpacity()), 0.45, 'body dimmed while latched');
    await page.mouse.move(b.x, b.y + 200); await sleep(150);
    b = await cmpBtn(); eq(b.bg, TINT.bg, 'tint kept after the pointer leaves');
    eq((await snap()).bypassed, true, 'still latched after the pointer leaves');
    await page.mouse.move(b.x, b.y); await page.mouse.down(); await sleep(60); await page.mouse.up(); await sleep(150);
    eq((await snap()).bypassed, false, 'second click releases the latch');
    eq(await bodyOpacity(), '1', 'body back'); b = await cmpBtn(); eq(b.bg, PLAIN.bg, 'un-tinted again');
    // latch, close the tab (SUITE.audioTabActive(false)), reopen: cleared and un-tinted
    await page.mouse.down(); await sleep(60); await page.mouse.up(); await sleep(150);
    eq((await snap()).bypassed, true, 'latched');
    await page.mouse.move(b.x, b.y + 200); await sleep(100);   // park the pointer off the header so the rebuilt button is not hovered
    await closeHub(); await sleep(200);
    eq((await snap()).bypassed, false, 'closing the tab clears the latch');
    await audioTab();
    eq((await snap()).bypassed, false, 'still clear on reopen');
    b = await cmpBtn(); eq(b.bg, PLAIN.bg, 'reopened tab: Compare un-tinted'); eq(await bodyOpacity(), '1', 'reopened tab: body not dimmed');
    // a reopened tab while bypassed paints the tint at build time
    await dbg(`d.bypass(true);`); await closeHub(); await sleep(100);   // closing clears it …
    eq((await snap()).bypassed, false, 'cleared by close');
    await openHub(); await hub(`root.querySelector('.tab[data-tab="lyrics"]').click();`); await sleep(300);
    await dbg(`d.bypass(true);`); await hub(`root.querySelector('.tab[data-tab="audio"]').click();`); await sleep(600);   // … but a bypass set before the render is painted
    b = await cmpBtn(); eq(b.bg, TINT.bg, 'render paints the current bypass'); eq(parseFloat(await bodyOpacity()), 0.45, 'render dims the body');
    await dbg(`d.bypass(false);`);
    await closeHub(); await resetAudio(); await stopPlay();
  });

  scenario('enhance-adaptive', async () => {
    // v2.1: the bank sits between +off / −off gains that follow the source's short-term loudness (reference −11.6 LUFS,
    // the calibration clip): fixture M (≈ −11.6) → offset near 0; fixture A (a −23 dBFS sine, ≈ −26 LUFS K-weighted) →
    // clamped +10 dB; the wrap nets to 1 at every instant (reciprocal exponential ramps); off → the offset rests at 0
    await play('M', { loop: true, sampleRate: 48000 });
    await audioTab();
    await set('enhanceOn', true); await set('enhanceAmt', 100);
    await sleep(5000);   // 6 blocks of 400 ms, then the 4 s smoothing settles
    let s = await snap(), tr = await dbg(`return d.enhTrack();`);
    assert(isFinite(tr.lufs) && Math.abs(tr.off) < 2, 'mastered clip: offset near 0 (got ' + (+tr.off).toFixed(2) + ' dB at ' + (+tr.lufs).toFixed(1) + ' LUFS)');
    approx(s.params.mbG.gain * s.params.mbOut.gain, 1, 0.02, 'the wrap nets to 1'); eq(s.params.cpG.gain, 0, 'bank leg in');
    console.log('  adaptive: M ' + (+tr.lufs).toFixed(1) + ' LUFS → offset ' + (+tr.off).toFixed(2) + ' dB');
    await play('A', { loop: true, sampleRate: 48000 }); await sleep(8000);
    s = await snap(); tr = await dbg(`return d.enhTrack();`);
    assert(tr.off > 9.5, 'quiet sine: offset clamped to +10 (got ' + (+tr.off).toFixed(2) + ' at ' + (+tr.lufs).toFixed(1) + ' LUFS)');
    assert(Math.abs(s.params.mbG.gain / Math.pow(10, tr.off / 20) - 1) < 0.15, 'mbG carries +off (' + s.params.mbG.gain.toFixed(3) + ')');
    approx(s.params.mbG.gain * s.params.mbOut.gain, 1, 0.02, 'the wrap still nets to 1');
    console.log('  adaptive: A ' + (+tr.lufs).toFixed(1) + ' LUFS → offset ' + (+tr.off).toFixed(2) + ' dB, mbG ' + s.params.mbG.gain.toFixed(3));
    await set('enhanceOn', false); await sleep(100); s = await snap(); tr = await dbg(`return d.enhTrack();`);
    eq(tr.off, 0, 'off → offset 0'); eq(s.params.mbG.gain, 0, 'mbG 0'); eq(s.params.mbOut.gain, 1, 'mbOut 1');
    await closeHub(); await stopPlay();
  });

  scenario('enhance-level-match', async () => {
    // 2.25: the row copy, and the level match on fixture M (the mastered music-like clip the offline calibration
    // renders too): post-limiter mean power over one full 12 s loop with Enhance 100 % vs off differs by < 1 dB
    await dbg(`d.gm('enh:vol', '1');`);   // the remembered volume lands on the fixture element at its first enforce tick
    await play('M', { loop: true, sampleRate: 48000 });
    await audioTab();
    const desc = await abody(`const d = [...a.querySelectorAll('div')].find((x) => x.textContent === 'Enhance audio'); return d ? d.nextElementSibling.textContent : null;`);
    eq(desc, 'Clarity, warmth & punch — level-matched, no loudness trick', 'Enhance description');
    const intOpacity = () => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.parentElement.firstChild.textContent === 'Intensity'); return r.parentElement.style.opacity;`);
    eq(await intOpacity(), '0.45', 'Intensity dimmed while Enhance is off');
    await sleep(1000);
    const off = powerAvg((await meterReads(24, 500)).map((m) => m.outDb));   // 24 × 500 ms: one whole loop of the clip
    await set('enhanceOn', true); await set('enhanceAmt', 100);
    let ec = null; for (let i = 0; i < 30; i++) { await sleep(100); ec = (await dbg(`return d.enhCalib();`))['20|48000']; if (ec && ec.exact) break; }
    assert(ec && ec.exact, 'the offline level calibration landed'); await sleep(500);
    const s = await snap();
    eq(s.shaperHasCurve, true, 'curve set'); approx(s.params.mbMid.threshold, -21.5, 0.001, 'mid band thr −21.5'); eq(s.params.comp.ratio, 1, 'wideband comp idle'); approx(s.params.air.gain, 3, 0.001, 'air +3');
    const rs = await meterReads(24, 500);
    const on = powerAvg(rs.map((m) => m.outDb));
    console.log('  level match: off ' + off.toFixed(2) + ' dB, on ' + on.toFixed(2) + ' dB, block gain ' + ec.db.toFixed(2) + ' dB, guard GR min ' + Math.min(...rs.map((m) => m.limGr)).toFixed(2) + ' dB');
    assert(Math.abs(on - off) < 1.0, 'Enhance on vs off within 1 dB (off ' + off.toFixed(2) + ', on ' + on.toFixed(2) + ')');
    await abody(`const r = [...a.querySelectorAll('button[role=switch]')].find((b) => b.previousElementSibling.firstChild.textContent === 'Enhance audio'); r.click();`);
    await sleep(150);
    eq(await get('enhanceOn'), false, 'switch turns Enhance off'); eq(await intOpacity(), '0.45', 'Intensity dims again');
    await closeHub(); await stopPlay();
  });

  scenario('audio-tab-render', async () => {
    // the tab keeps its original structure and look: header (Compare + switch), canvas, Pre-amp, then the section 4 order
    await play('A', { loop: true });
    await audioTab();
    const info = await abody(`
      const txt = (el) => (el ? el.textContent.trim() : null);
      const hd = a.firstElementChild, htx = hd && hd.firstElementChild;
      const title = htx && htx.children[0];
      const sections = [...a.querySelectorAll('div')].filter((d) => /uppercase/.test(d.style.cssText)).map((d) => d.textContent.trim());
      const sliders = [...a.querySelectorAll('input[type=range]')].map((r) => r.parentElement.firstChild.textContent);
      const switches = a.querySelectorAll('button[role=switch]').length;
      const toggles = [...a.querySelectorAll('button[role=switch]')].map((b) => { const tx = b.previousElementSibling; return tx && tx.tagName === 'DIV' && tx.firstChild ? tx.firstChild.textContent : (tx ? tx.textContent : ''); });
      const sub = htx && htx.children[1];
      const hdKids = [...hd.children].map((c) => c.tagName + (c.textContent === 'Compare' ? ':Compare' : c.getAttribute('role') === 'switch' ? ':switch' : ''));
      return { title: txt(title), sub: txt(sub), sections, sliders, switches, toggles, hdKids, body: a.children.length, canvas: !!a.querySelector('canvas'), note: txt([...a.querySelectorAll('div')].pop()), selects: a.querySelectorAll('select.sxsel').length };
    `);
    eq(info.title, 'Equalizer', 'header title');
    eq(info.sub, '10-band · drag the curve · double-click resets', 'header sub-line');
    eq(JSON.stringify(info.hdKids), JSON.stringify(['DIV', 'BUTTON:Compare', 'BUTTON:switch']), 'header: title block, Compare, EQ switch');
    eq(info.canvas, true, 'EQ canvas');
    eq(info.body, 3, 'header, canvas stage, one body div');
    eq(JSON.stringify(info.sections), JSON.stringify(['Preset', 'Listening on', 'Playback', 'Tone', 'Enhance', 'Loudness & dynamics', 'Stereo', 'Headphone correction']), 'section labels in the section 4 order');
    eq(JSON.stringify(info.sliders), JSON.stringify(['Pre-amp', 'Speed', 'Reverb', 'Fade in', 'Fade out', 'Bass', 'Harmonic bass', 'Vocals', 'Tilt', 'Intensity', 'Strength', 'Volume boost', 'Stereo width', 'Balance']), 'slider rows');
    eq(info.switches, 15, 'fifteen switches (EQ, Auto-headroom, Remember EQ, Pitch follows speed, Fade, Skip silence, Loudness contour, Enhance, Loudness, Night mode, Clip guard, Crossfeed, Mono, Swap, Headphone correction)');
    eq(JSON.stringify(info.toggles.slice(1)), JSON.stringify(['Auto-headroom', 'Remember EQ per track', 'Pitch follows speed', 'Fade in / out', 'Skip silent endings', 'Loudness contour', 'Enhance audio', 'Loudness normalize', 'Night mode', 'Clip guard', 'Crossfeed', 'Mono', 'Swap left / right', 'Headphone correction']), 'toggle rows');
    eq(await abody(`return [...a.querySelectorAll('textarea')].map((t) => t.style.display).join(',');`), 'none,none', 'both paste boxes hidden at render');
    eq(info.selects, 3, 'preset select + loudness Target select + crossfeed Mode select');
    eq(await abody(`return a.querySelector('input[type=text]').parentElement.style.display;`), 'none', 'preset-name row hidden at render');
    eq(await abody(`return a.querySelector('select.sxsel').value;`), 'b:Flat', 'a flat curve reads as the Flat preset');
    assert(/These shape SoundCloud/.test(info.note), 'footnote present');
    await sleep(2500);   // let any toast from the previous scenario fade before the visual check
    await page.screenshot({ path: path.join(SHOTS, SHOT + '.png') });
    console.log('  shot →', path.join(SHOTS, SHOT + '.png'));
    // the lower half of the tab (the panel scrolls): the rows below the fold
    await abody(`a.lastElementChild.scrollIntoView({ block: 'end' });`); await sleep(300);
    await page.screenshot({ path: path.join(SHOTS, SHOT + '-lower.png') });
    console.log('  shot →', path.join(SHOTS, SHOT + '-lower.png'));
    await abody(`a.firstElementChild.scrollIntoView({ block: 'start' });`);
    await closeHub();
    await stopPlay();
  });

  /* ── WP3 helpers: the preset select, the name row, canvas geometry + pixel reads ── */
  const selVal = () => abody(`return a.querySelector('select.sxsel').value;`);
  const selChoose = (v) => abody(`const s = a.querySelector('select.sxsel'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  const btnClick = (txt) => abody(`const b = [...a.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(txt)}); if (!b) throw new Error('no button ' + ${JSON.stringify(txt)}); b.click();`);
  const nameRow = () => abody(`const i = a.querySelector('input[type=text]'); return { display: i.parentElement.style.display, value: i.value, focused: a.getRootNode().activeElement === i };`);
  const nameType = async (txt, key) => { await abody(`const i = a.querySelector('input[type=text]'); i.focus(); i.value = ${JSON.stringify(txt)};`); if (key) await page.keyboard.press(key); };
  const toastText = () => page.evaluate(() => { const t = [...document.body.children].find((el) => el.style && el.style.position === 'fixed' && /border-radius: 99px/.test(el.style.cssText) && el.style.opacity === '1'); return t ? t.textContent : null; });
  const preVal = () => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.parentElement.firstChild.textContent === 'Pre-amp'); return r.parentElement.lastChild.textContent;`);
  // the Pre-amp row as drawn: the range's value and its value text
  const preRow = () => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.parentElement.firstChild.textContent === 'Pre-amp'); return { value: r.value, text: r.parentElement.lastChild.textContent };`);
  const switchClick = (label) => abody(`const b = [...a.querySelectorAll('button[role=switch]')].find((x) => x.previousElementSibling && x.previousElementSibling.firstChild && x.previousElementSibling.firstChild.textContent === ${JSON.stringify(label)}); if (!b) throw new Error('no switch ' + ${JSON.stringify(label)}); b.click(); return b.getAttribute('aria-checked');`);
  // canvas geometry (mirrors the renderer): 880×380 backing, padX 30, padY 48, the log axis through the handles
  const G = { CW: 880, CH: 380, padX: 30, padY: 48, N: 10, F0: 31, F9: 16000 };
  G.usableH = G.CH - G.padY * 2; G.midY = G.padY + G.usableH / 2;
  G.bandX = (i) => G.padX + (i / (G.N - 1)) * (G.CW - G.padX * 2);
  G.freqX = (f) => G.padX + Math.log2(f / G.F0) / Math.log2(G.F9 / G.F0) * (G.CW - G.padX * 2);
  G.gainToY = (g) => G.midY - (Math.max(-12, Math.min(12, g)) / 12) * (G.usableH / 2);
  // pixel column read: every pixel [r,g,b,a] of column x between y0 and y1
  const column = (x, y0, y1) => abody(`const c = a.querySelector('canvas').getContext('2d'); const d = c.getImageData(${Math.round(x)}, ${y0}, 1, ${y1 - y0}).data; const out = []; for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2], d[i + 3]]); return out;`);
  const isCurve = (p) => p[3] > 200 && p[0] > 200 && p[1] > 90 && p[1] < 160 && p[2] < 110;   // #ff7a3d, the composite line
  const topCurveY = async (x) => { const col = await column(x, 0, G.CH); for (let y = 0; y < col.length; y++) if (isCurve(col[y])) return y; return -1; };
  const canvasRect = () => abody(`const r = a.querySelector('canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };`);

  scenario('auto-headroom-ui', async () => {
    // 2.9: the Pre-amp value shows what auto-headroom took off, the toggle row closes the EQ block and drives eqAutoPre
    await play('A', { loop: true });
    await audioTab();
    eq(await preVal(), '0 dB', 'plain value with nothing boosting');
    const order = await abody(`return [...a.children[2].children].map((el) => el.textContent.trim().slice(0, 13));`);
    const iPre = order.indexOf('Preset');
    assert(iPre >= 0 && order[iPre + 1].indexOf('Choose a pres') === 0 && order[iPre + 2] === 'OKCancel' && order[iPre + 3] === 'Auto-headroom', 'Preset label → select row → hidden name row → Auto-headroom (got ' + JSON.stringify(order.slice(0, 8)) + ')');
    await set('eqOn', true); await set('eqBands', [6, 0, 0, 0, 0, 0, 0, 0, 0, 0]); await sleep(200);   // the draw loop repaints the value on the next version
    const h = await dbg(`return d.headroomDb;`);
    assert(h > 5.5 && h < 6.2, 'headroom from the composite ≈ 6 dB (got ' + h + ')');
    eq(await preVal(), '0 dB · auto −' + Math.round(h * 10) / 10, 'value carries the auto part');
    let s = await snap(); approx(s.params.preamp.gain, Math.pow(10, -h / 20), 0.002, 'preamp gain = −headroom');
    await sliderInput(12, -2); await sleep(200);
    eq(await get('eqPreamp'), -2, 'pre-amp slider writes eqPreamp');
    eq(await preVal(), '-2 dB · auto −' + Math.round(h * 10) / 10, 'user pre-amp and the auto part together');
    s = await snap(); approx(s.params.preamp.gain, Math.pow(10, (-2 - h) / 20), 0.002, 'preamp gain = user − headroom');
    eq(await switchClick('Auto-headroom'), 'false', 'switch turns auto-headroom off');
    await sleep(200);
    eq(await get('eqAutoPre'), false, 'eqAutoPre false');
    eq(await preVal(), '-2 dB', 'auto part gone');
    s = await snap(); approx(s.params.preamp.gain, Math.pow(10, -2 / 20), 0.002, 'preamp = the user value alone');
    eq(await switchClick('Auto-headroom'), 'true', 'switch turns it back on');
    await sleep(200);
    eq(await preVal(), '-2 dB · auto −' + Math.round(h * 10) / 10, 'auto part back');
    // the row copy
    eq(await toggleDesc('Auto-headroom'), 'Lowers the volume by your biggest boost so nothing clips', 'row description');
    await closeHub(); await resetAudio(); await stopPlay();
  });

  scenario('eq-truth', async () => {
    // 2.26: shelf corners, curveAt, and the canvas draws the TRUE composite on a log axis (pixel reads),
    // the spectrum on the same axis, the value label while dragging
    await play('A', { loop: true, sampleRate: 48000 });
    await audioTab();
    let s = await snap();
    eq(s.params.bands[0].frequency, 48, 'lowshelf 48 Hz'); eq(s.params.bands[9].frequency, 11000, 'highshelf 11 kHz');
    // flat: the curve sits on the midline everywhere
    await sleep(300);
    for (const f of [40, 300, 3000]) approx(await topCurveY(G.freqX(f)), G.gainToY(0) - 1, 2, 'flat curve on the midline at ' + f + ' Hz');
    // the spectrum: fixture A is a 997 Hz tone → the brightest bar sits at x(997) on the log axis
    const bottom = await abody(`const c = a.querySelector('canvas').getContext('2d'); const d = c.getImageData(0, ${G.CH - 4}, ${G.CW}, 1).data; const out = []; for (let i = 0; i < d.length; i += 4) out.push(d[i + 3]); return out;`);
    let best = 0; for (let x = 0; x < bottom.length; x++) if (bottom[x] > bottom[best]) best = x;
    assert(bottom[best] > 8, 'spectrum bars visible (max alpha ' + bottom[best] + ')');
    approx(best, G.freqX(997), 15, 'brightest bar at x(997 Hz) on the log axis');
    // a +12 lowshelf: at 62 Hz the drawn curve equals the probe bank's response (the old spline drew 0 there)
    await set('eqOn', true); await set('eqBands', [12, 0, 0, 0, 0, 0, 0, 0, 0, 0]); await sleep(250);
    const c62 = await dbg(`return d.curveAt(62);`);
    assert(c62 > 2 && c62 < 10, 'composite at 62 Hz is the shelf tail (got ' + c62.toFixed(2) + ')');
    approx(await topCurveY(G.bandX(1)), G.gainToY(c62) - 1, 4, 'drawn curve at 62 Hz = the true response');
    approx(await topCurveY(G.freqX(300)), G.gainToY(0) - 1, 2, 'and back on the midline at 300 Hz');
    // the 1 kHz band at +6 (index 5): curveAt agrees, the drawn peak too
    await set('eqBands', [0, 0, 0, 0, 0, 6, 0, 0, 0, 0]); await sleep(250);
    approx(await dbg(`return d.curveAt(1000);`), 6, 0.5, 'curveAt(1000) ≈ 6');
    assert((await dbg(`return d.curveAt(4000);`)) < 1.5, 'curveAt(4000) < 1.5');
    const c1094 = await dbg(`return d.curveAt(1094);`);
    approx(await topCurveY(G.bandX(5) + 12), G.gainToY(c1094) - 1, 4, 'drawn curve beside the 1 kHz handle = the true response');
    // EQ off: the handles stay, the curve is honest (flat)
    await set('eqOn', false); await sleep(250);
    approx(await topCurveY(G.bandX(5) + 12), G.gainToY(0) - 1, 2, 'EQ off → the drawn curve is flat');
    const dot = await column(G.bandX(5), Math.round(G.gainToY(6)) - 1, Math.round(G.gainToY(6)) + 2);
    assert(dot.some((p) => p[0] > 230 && p[1] > 230 && p[2] > 230 && p[3] > 200), 'the handle still shows the stored +6');
    await set('eqOn', true); await sleep(250);
    // drag: press on the 1 kHz handle → the value label appears 16 px above it; released → gone
    const r = await canvasRect(); const sx = r.w / G.CW, sy = r.h / G.CH;
    const region = () => abody(`const c = a.querySelector('canvas').getContext('2d'); const d = c.getImageData(${Math.round(G.bandX(5) - 24)}, ${Math.round(G.gainToY(6) - 30)}, 48, 18).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 90 && d[i] > 200 && d[i + 1] > 140) n++; return n;`);
    eq(await region(), 0, 'no label above the handle before the drag');
    await page.mouse.move(r.x + G.bandX(5) * sx, r.y + G.gainToY(6) * sy); await page.mouse.down(); await sleep(200);
    eq(await get('eqBands').then((b) => b[5]), 6, 'pointerdown on the handle keeps +6');
    assert((await region()) > 10, 'value label drawn above the handle while dragging');
    await page.mouse.move(r.x + G.bandX(5) * sx, r.y + G.gainToY(3) * sy, { steps: 3 }); await sleep(200);
    eq(await get('eqBands').then((b) => b[5]), 3, 'dragging moves the band');
    await page.mouse.up(); await sleep(250);
    eq(await region(), 0, 'label gone after release');
    // frame skipping: paused + unchanged → the loop keeps running (it still paints the meter line)
    await page.evaluate(() => window.__afx.el().pause()); await sleep(300);
    eq(await get('eqBands').then((b) => b[5]), 3, 'state intact while paused');
    await closeHub(); await resetAudio(); await stopPlay();
  });

  scenario('presets', async () => {
    // 2.27: the preset list, { b, pre } custom saves, the dirty state, the inline Save row, the name guard
    await play('A', { loop: true });
    await audioTab();
    const opts = await abody(`return [...a.querySelector('select.sxsel').options].map((o) => o.value);`);
    for (const k of ['Loudness curve', 'Bass reducer', 'Small speakers', 'Late night', 'Classical', 'Dance', 'R&B', 'Deep', 'Piano', 'Soft highs', 'Podcast']) assert(opts.includes('b:' + k), 'preset ' + k + ' listed');
    eq(opts.includes('b:Loudness'), false, 'Loudness renamed');
    eq(opts.filter((v) => v.charAt(0) === 'b').length, 23, '23 built-ins');
    eq(await selVal(), 'b:Flat', 'flat curve → Flat selected');
    await selChoose('b:Bass boost'); await sleep(150);
    let b = await get('eqBands'); eq(b[0], 7, 'Bass boost band 0'); eq(await get('eqOn'), true, 'choosing a preset turns the EQ on');
    eq(await selVal(), 'b:Bass boost', 'select shows Bass boost');
    eq((await snap()).params.bands[0].gain, 7, 'band 0 applied to the node');
    await dbg(`d.setBand(0, 5);`); await sleep(50);
    eq(await selVal(), '', 'editing a band clears the select');
    await selChoose('b:Podcast'); await sleep(150);
    eq(JSON.stringify(await get('eqBands')), JSON.stringify([-8, -6, 0, 3, 4, 4, 3, 1, -2, -4]), 'Podcast deepened');
    // inline Save: the row opens, a bad name is refused, a good one saves { b, pre } and selects it
    let nr = await nameRow(); eq(nr.display, 'none', 'name row hidden');
    await btnClick('Save'); await sleep(100);
    nr = await nameRow(); eq(nr.display, 'flex', 'Save opens the name row'); eq(nr.focused, true, 'input focused');
    await nameType('__proto__'); await btnClick('OK'); await sleep(150);
    eq(await toastText(), 'Not a valid name', 'prototype name refused');
    assert(await dbg(`const c = d.get('eqCustom'); return Object.getPrototypeOf(c) === Object.prototype && !Object.keys(c).includes('__proto__');`), 'eqCustom stays a plain object');
    eq((await nameRow()).display, 'flex', 'row stays open after a refused name');
    await nameType('   '); await page.keyboard.press('Enter'); await sleep(150);
    eq(await toastText(), 'Not a valid name', 'blank name refused');
    await nameType('Mine', 'Enter'); await sleep(200);
    eq(await toastText(), 'Saved “Mine”', 'saved toast');
    eq((await nameRow()).display, 'none', 'row closes after saving');
    const cu = await get('eqCustom');
    assert(cu && cu.Mine && Array.isArray(cu.Mine.b), 'custom preset stored as { b, pre }');
    eq(JSON.stringify(cu.Mine.b), JSON.stringify([-8, -6, 0, 3, 4, 4, 3, 1, -2, -4]), 'stored bands'); eq(cu.Mine.pre, 0, 'stored pre-amp');
    eq(await selVal(), 'c:Mine', 'the new preset is selected');
    eq(await abody(`return [...a.querySelectorAll('button')].find((x) => x.textContent === '✕').style.display;`), '', 'delete button shown for a custom preset');
    // the pre-amp is part of a custom preset's identity: moved, "Mine" no longer matches — the built-in
    // Podcast curve (no pre-amp stored) still does, honestly; back at 0 the last-saved preset wins the tie
    await set('eqPreamp', -3); await sleep(200);
    eq(await selVal(), 'b:Podcast', 'a moved pre-amp drops the custom preset, the built-in curve still matches');
    await set('eqPreamp', 0); await sleep(200);
    eq(await selVal(), 'c:Mine', 'back at the stored pre-amp the saved preset matches again');
    await set('eqBands', [2, 0, 0, 0, 0, 0, 0, 0, 0, 0]); await set('eqPreamp', -3); await sleep(200);
    eq(await selVal(), '', 'a curve no preset has → blank');
    await btnClick('Save'); await sleep(100); await nameType('Quiet', 'Enter'); await sleep(200);
    const q = (await get('eqCustom')).Quiet; assert(q && q.pre === -3 && q.b[0] === 2, 'Quiet stored with pre −3');
    eq(await selVal(), 'c:Quiet', 'Quiet selected');
    await set('eqPreamp', 0); await sleep(200);
    eq(await selVal(), '', 'the pre-amp alone un-matches a custom preset');
    // choosing the custom preset restores its pre-amp, and the slider follows (2.26 EQ truth): thumb and text, not just CFG
    await selChoose('c:Quiet'); await sleep(250);
    eq(await get('eqPreamp'), -3, 'choosing Quiet restores its pre-amp');
    { const pr = await preRow(); eq(pr.value, '-3', 'the Pre-amp range moved to −3'); assert(pr.text.startsWith('-3 dB'), 'the Pre-amp text reads −3 dB, got ' + JSON.stringify(pr.text)); }
    eq(await selVal(), 'c:Quiet', 'and the select shows it');
    await set('eqPreamp', 0); await sleep(200);
    eq(await selVal(), '', 'un-matched again once the pre-amp moves');
    { const pr = await preRow(); eq(pr.value, '0', 'the debug accessor resyncs the slider too'); }
    await set('eqPreamp', -3); await sleep(200);
    eq(await selVal(), 'c:Quiet', 'and matches it again');
    await selChoose('b:Podcast'); await set('eqPreamp', 0); await sleep(200);
    // an old array-shaped custom preset still works (listed on the next render)
    await dbg(`d.set('eqCustom', Object.assign({}, d.get('eqCustom'), { Old: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }));`);
    await hub(`root.querySelector('.tab[data-tab="lyrics"]').click();`); await sleep(200); await hub(`root.querySelector('.tab[data-tab="audio"]').click();`); await sleep(600);
    assert((await abody(`return [...a.querySelector('select.sxsel').options].map((o) => o.value);`)).includes('c:Old'), 'array-shaped custom preset listed');
    await selChoose('c:Old'); await sleep(150);
    eq(JSON.stringify(await get('eqBands')), JSON.stringify([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), 'array preset applied'); eq(await selVal(), 'c:Old', 'selected');
    await btnClick('✕'); await sleep(150);
    eq(await toastText(), 'Removed “Old”', 'removed toast');
    eq('Old' in (await get('eqCustom')), false, 'deleted from eqCustom');
    assert(!(await abody(`return [...a.querySelector('select.sxsel').options].map((o) => o.value);`)).includes('c:Old'), 'and from the list');
    eq(await selVal(), '', 'nothing selected (the curve no longer matches a preset)');
    // Escape cancels the name row; Reset flattens and selects Flat
    await btnClick('Save'); await sleep(100); eq((await nameRow()).display, 'flex', 'row open');
    await nameType('Nope', 'Escape'); await sleep(100); eq((await nameRow()).display, 'none', 'Escape closes it'); eq('Nope' in (await get('eqCustom')), false, 'nothing saved');
    await btnClick('Reset'); await sleep(150);
    eq(JSON.stringify(await get('eqBands')), JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'Reset → flat'); eq(await selVal(), 'b:Flat', 'Flat selected');
    await dbg(`d.set('eqCustom', {});`);
    await closeHub(); await resetAudio(); await stopPlay();
  });

  scenario('curve-before-play', async () => {
    // before the first play there is no chain: the curve, curveAt and the auto-headroom value still come from
    // a fallback probe bank, so the tab is never a flat lie (a fresh page, nothing ever played)
    const p2 = await ctx.newPage(); wire(p2);
    try {
      await p2.goto('https://soundcloud.com/discover', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);
      const d2 = (src) => p2.evaluate((s) => { const d = window.__sceAudioDebug && window.__sceAudioDebug(); return (new Function('d', s))(d); }, src);
      const h2 = (src) => p2.evaluate((s) => { const h = document.getElementById('slx3-host'); const r = h && h.shadowRoot; return (new Function('root', 'a', s))(r, r && r.querySelector('#abody')); }, src);
      eq(await d2(`return d.chains;`), 0, 'no chain yet');
      await p2.keyboard.press('Alt+L'); await sleep(700);
      await h2(`root.querySelector('.tab[data-tab="audio"]').click();`); await sleep(600);
      await h2(`const s = a.querySelector('select.sxsel'); s.value = 'b:Bass boost'; s.dispatchEvent(new Event('change', { bubbles: true }));`); await sleep(300);
      eq(await h2(`return a.querySelector('select.sxsel').value;`), 'b:Bass boost', 'preset chosen');
      approx(await d2(`return d.curveAt(31);`), 7, 1, 'curveAt(31) from the fallback bank');
      const hr = await d2(`return d.headroomDb;`); assert(hr > 7 && hr < 10, 'auto-headroom computed without a chain (got ' + hr + ')');
      eq(await h2(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.parentElement.firstChild.textContent === 'Pre-amp'); return r.parentElement.lastChild.textContent;`), '0 dB · auto −' + Math.round(hr * 10) / 10, 'pre-amp value shows the auto part');
      const c62 = await d2(`return d.curveAt(62);`);
      const top = await h2(`const c = a.querySelector('canvas').getContext('2d'); const d = c.getImageData(${Math.round(G.bandX(1))}, 0, 1, ${G.CH}).data; for (let y = 0; y < ${G.CH}; y++) { const i = y * 4; if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] > 90 && d[i + 1] < 160 && d[i + 2] < 110) return y; } return -1;`);
      approx(top, G.gainToY(c62) - 1, 4, 'the drawn curve at 62 Hz is the true response with no chain');
      await p2.keyboard.press('Alt+L'); await sleep(300);
    } finally { await p2.close(); }
  });


  /* ── WP4 helpers: the loudness state, the memory, the Target select ── */
  const loudState = () => dbg(`return d.loud();`);
  const loudMem = () => dbg(`return d.loudMem();`);
  const TG_SEL = `[...a.querySelectorAll('select.sxsel')].find((x) => x.options.length === 3 && x.options[0].text === 'Quiet')`;
  const targetSel = () => abody(`const s = ${TG_SEL}; if (!s) return null; const row = s.parentElement; const prev = row.previousElementSibling; return { value: s.value, opts: [...s.options].map((o) => [o.value, o.text]), label: row.firstChild.textContent, labelW: row.firstChild.style.width, opacity: row.style.opacity, flex: s.style.flexGrow, afterLoudness: !!(prev && prev.firstChild && prev.firstChild.firstChild && prev.firstChild.firstChild.textContent === 'Loudness normalize') };`);
  const targetChoose = (v) => abody(`const s = ${TG_SEL}; s.value = ${JSON.stringify(String(v))}; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  const loudSwitch = () => abody(`const b = [...a.querySelectorAll('button[role=switch]')].find((x) => x.previousElementSibling && x.previousElementSibling.firstChild && x.previousElementSibling.firstChild.textContent === 'Loudness normalize'); return b.getAttribute('aria-checked');`);
  const SUB_RX = /^−?\d+\.\d LUFS · peak −?\d+\.\d dB · [+−]\d+\.\d dB applied$/;

  scenario('loudness-normalize', async () => {
    // 2.4: K-weighted gated measurement at the source taps; no gain before 3 s; +9 dB for fixture A at −14 with the
    // slow upward ramp (tau 3 s); the Target select re-applies at once; off → unity within 200 ms, timer stopped
    await play('A', { loop: true, href: '/test/ln-a' });
    await set('loudnessOn', true);
    let s = await snap();
    eq(s.routed, true, 'routed'); eq(s.loudTimer, true, 'loudness timer running'); eq(guardOn(s), true, 'loudness engages the guard');
    let ls = await loudState(); eq(ls.href, '/test/ln-a', 'measuring this track'); eq(ls.src, '', 'no gain source yet'); eq(ls.measuring, true, 'measuring');
    await sleep(2000);   // ≈ 2.1 s: four blocks
    s = await snap();
    eq(s.params.makeup.gain, 1, 'no gain before 3 s of audio (makeup ' + s.params.makeup.gain + ')');
    approx(s.meter.i, -23, 0.5, 'integrated loudness after four blocks');
    approx(s.meter.m, -23, 0.5, 'momentary'); approx(s.meter.s, -23, 0.5, 'short-term');
    await sleep(2200);   // ≈ 4.3 s
    s = await snap();
    approx(s.meter.i, -23, 0.3, 'integrated loudness of fixture A');
    approx(s.meter.gainDb, 9, 0.6, 'gain target −14 − (−23)');
    const g1 = s.params.makeup.gain;
    assert(g1 > 1.05 && g1 < 2.7, 'makeup rising toward 2.82 with tau 3 s (got ' + g1 + ')');
    await sleep(1000);
    const g2 = (await snap()).params.makeup.gain;
    assert(g2 > g1 + 0.08 && g2 < 2.83, 'still rising a second later (' + g1.toFixed(3) + ' → ' + g2.toFixed(3) + ')');
    ls = await loudState();
    eq(ls.src, 'measured', 'gain from the measurement'); approx(ls.trackPeak, Math.pow(10, -23 / 20), 0.002, 'source peak from the pre-chain taps'); assert(ls.blocks >= 8, 'blocks counted');
    // the tab: the header meter line (2.6), the live row description, the Target row right after it
    await audioTab(); await sleep(600);
    const sub = await subLine();
    assert(SUB_RX.test(sub), 'header sub-line LUFS · peak · applied (got ' + sub + ')');
    approx(parseFloat(sub.replace('−', '-')), -23, 0.3, 'sub-line LUFS is the source loudness');
    assert(/\+9\.\d dB applied$/.test(sub), 'sub-line applied gain (got ' + sub + ')');
    const desc = await toggleDesc('Loudness normalize');
    assert(/^Even out quiet & loud tracks · \+9\.\d dB applied$/.test(desc), 'row description carries the applied gain (got ' + desc + ')');
    let tg = await targetSel();
    assert(tg, 'Target select present');
    eq(tg.label, 'Target', 'label'); eq(tg.labelW, '86px', 'label width like sliderRow'); eq(tg.flex, '1', 'select flex 1');
    eq(JSON.stringify(tg.opts), JSON.stringify([['-18', 'Quiet'], ['-14', 'Normal'], ['-11', 'Loud']]), 'options');
    eq(tg.value, '-14', 'Normal selected'); eq(tg.opacity, '1', 'row lit while loudness is on'); eq(tg.afterLoudness, true, 'Target row follows the Loudness row');
    await targetChoose(-11); await sleep(250);
    eq(await get('loudTarget'), -11, 'select writes loudTarget');
    s = await snap(); approx(s.meter.gainDb, 12, 0.01, 'Loud: +12 (the +12 clamp)'); approx(s.params.makeup.gain, Math.pow(10, 12 / 20), 0.05, 'gain re-applied immediately');
    await targetChoose(-18); await sleep(250);
    s = await snap(); approx(s.meter.gainDb, 5, 0.01, 'Quiet: +5'); approx(s.params.makeup.gain, Math.pow(10, 5 / 20), 0.05, 'gain follows at once');
    assert(/\+5\.0 dB applied$/.test(await subLine()), 'sub-line follows the target');
    // off: unity within 200 ms, timer stopped, plain description, Target row dimmed
    await switchClick('Loudness normalize'); await sleep(200);
    s = await snap();
    eq(await get('loudnessOn'), false, 'switch off'); eq(s.params.makeup.gain, 1, 'makeup back to 1'); eq(s.loudTimer, false, 'timer stopped');
    eq(s.meter.gainDb, undefined, 'no applied gain reported'); eq(s.routed, true, 'still routed (tab open)');
    tg = await targetSel(); eq(tg.opacity, '0.45', 'Target row dimmed');
    await sleep(300);
    eq(await toggleDesc('Loudness normalize'), 'Even out quiet & loud tracks', 'plain description when off');
    eq(await subLine(), '10-band · drag the curve · double-click resets', 'hint back');
    // choosing a target while off wakes the switch (like Intensity wakes Enhance); the track is remembered by now
    await targetChoose(-14); await sleep(350);
    eq(await get('loudnessOn'), true, 'Target choice turns loudness on'); eq(await get('loudTarget'), -14, 'target set');
    eq(await loudSwitch(), 'true', 'switch repainted'); tg = await targetSel(); eq(tg.opacity, '1', 'row lit again');
    s = await snap(); approx(s.params.makeup.gain, Math.pow(10, 9 / 20), 0.05, 'remembered +9 dB applied at once');
    assert(/remembered · \+9\.0 dB$/.test(await toggleDesc('Loudness normalize')), 'description says remembered (got ' + await toggleDesc('Loudness normalize') + ')');
    await closeHub(); await stopPlay();
  });

  scenario('loudness-clamp', async () => {
    // 2.4 step 5: the source-peak clamp is always applied — fixture E (≈ −18.2 LUFS, peaks −3 dBFS) at Loud gets
    // 20·log10(0.98/0.708) + 3 = 5.8 dB, not the 7.2 dB target delta; at Normal the target wins; the 3 dB budget goes
    // with the guard. Fixture D (the spec's case) at Loud: ≤ 5.8 and exactly min(−11 − Lint, 5.8).
    await play('E', { loop: true, href: '/test/ln-e', sampleRate: 48000 });   // 48 k: the burst edges must not pick up resampler overshoot
    await set('loudTarget', -11); await set('loudnessOn', true);
    await sleep(4200);
    let s = await snap();
    approx(s.meter.i, -18.2, 0.5, 'fixture E integrated loudness');
    const clampDb = 20 * Math.log10(0.98 / Math.pow(10, -3 / 20)) + 3;   // 5.82
    approx(s.meter.gainDb, clampDb, 0.6, 'Loud: clamped by the source peak + the guard budget');
    assert(-11 - s.meter.i > clampDb + 0.8, 'the target delta is larger than the clamp (delta ' + (-11 - s.meter.i).toFixed(2) + ')');
    const ls = await loudState(); approx(ls.trackPeak, Math.pow(10, -3 / 20), 0.01, 'trackPeak sees the 10 ms bursts');
    await set('loudTarget', -14); await sleep(200);
    s = await snap(); approx(s.meter.gainDb, -14 - s.meter.i, 0.6, 'Normal: the target wins'); assert(s.meter.gainDb < clampDb - 0.8, 'below the clamp');
    await set('limiterOn', false); await set('loudTarget', -11); await sleep(200);
    s = await snap(); approx(s.meter.gainDb, clampDb - 3, 0.6, 'guard off: no limiting budget'); eq(guardOn(s), false, 'guard inert');
    await set('limiterOn', true); await sleep(200);
    s = await snap(); approx(s.meter.gainDb, clampDb, 0.6, 'guard on: budget back'); eq(guardOn(s), true, 'guard engaged');
    approx(s.params.makeup.gain, Math.pow(10, clampDb / 20), 0.1, 'makeup follows the re-target at once');
    // fixture D at Loud, as the spec states it
    await play('D', { loop: true, href: '/test/ln-d', sampleRate: 48000 });
    await sleep(4200);
    s = await snap();
    assert(s.meter.gainDb <= clampDb + 0.3, 'fixture D at Loud: ≤ 5.8 dB (got ' + s.meter.gainDb + ')');
    approx(s.meter.gainDb, Math.max(-15, Math.min(12, Math.min(-11 - s.meter.i, clampDb))), 0.3, 'fixture D gain = min(target delta, peak clamp)');
    await set('loudnessOn', false); await stopPlay();
  });

  scenario('loudness-96k', async () => {
    // 2.4 guard: at 96 kHz the 400 ms window would be 38 400 samples — capped at the 32 768 tap so nothing indexes below 0 (no NaN)
    const r = await play('A', { loop: true, href: '/test/ln-96', sampleRate: 96000 });
    eq(r.sampleRate, 96000, '96 kHz context');
    await set('loudnessOn', true);
    await sleep(4200);
    const s = await snap();
    eq(s.sampleRate, 96000, 'the chain runs at 96 kHz');
    approx(s.meter.i, -23, 0.5, 'integrated loudness at 96 kHz');
    approx(s.meter.gainDb, 9, 0.6, 'gain target at 96 kHz');
    assert(typeof s.params.makeup.gain === 'number' && s.params.makeup.gain > 1.05, 'makeup rising, not NaN (got ' + s.params.makeup.gain + ')');
    const ls = await loudState(); assert(ls.blocks >= 6, 'blocks counted'); approx(ls.trackPeak, Math.pow(10, -23 / 20), 0.002, 'source peak');
    await set('loudnessOn', false); await stopPlay();
  });

  scenario('loudness-memory', async () => {
    // 2.5: the track's source loudness is remembered; a fresh page applies it within 300 ms with no slow ramp and the
    // row says so; tone / balance changes downstream never move the source measurement or the remembered gain
    const HREF = '/test/mem-a';
    await play('A', { loop: true, href: HREF });
    await set('loudnessOn', true);
    await sleep(5000);
    const e1 = (await loudMem())[HREF];
    assert(e1, 'memory entry after 5 s');
    approx(e1.l, -23, 0.3, 'remembered LUFS'); approx(e1.p, Math.pow(10, -23 / 20), 0.002, 'remembered source peak'); approx(e1.d, 12, 0.2, 'duration');
    assert(e1.s >= 3 && e1.s <= 6, 'seconds measured (got ' + e1.s + ')'); eq(e1.f, 0, 'partial: less than half the track heard'); assert(typeof e1.t === 'number', 'timestamp');
    await stopPlay();   // loudness stays on (persisted); the paused element measures nothing more
    const p2 = await ctx.newPage(); wire(p2);
    try {
      await p2.goto('https://soundcloud.com/discover', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);
      const d2 = (src) => p2.evaluate((s) => { const d = window.__sceAudioDebug && window.__sceAudioDebug(); return (new Function('d', s))(d); }, src);
      const h2 = (src) => p2.evaluate((s) => { const h = document.getElementById('slx3-host'); const r = h && h.shadowRoot; return (new Function('root', 'a', s))(r, r && r.querySelector('#abody')); }, src);
      eq(await d2(`return d.get('loudnessOn');`), true, 'loudness on in the fresh page (persisted)');
      await p2.evaluate(FIXTURE_SRC);
      await p2.evaluate(([k, o]) => window.__afx.play(k, o), ['A', { loop: true, href: HREF }]);
      // read as soon as the memory has landed (within 300 ms): the seeded meter keeps folding in real audio, so a
      // late read on a busy page drifts from the remembered value by a few tenths of a dB
      const SNAP = `return { routed: d.routed, makeup: d.params.makeup.gain, loud: d.loud(), timer: d.loudTimer, gainDb: d.meter.gainDb, i: d.meter.i };`;
      const t0 = Date.now(); let sRestore = null;
      while (Date.now() - t0 < 300) { sRestore = await d2(SNAP); if (sRestore && sRestore.loud && sRestore.loud.src === 'remembered') break; await sleep(30); }
      const seededI = sRestore && sRestore.loud && sRestore.loud.src === 'remembered' ? sRestore.i : NaN;   // the meter the moment the memory landed
      await sleep(Math.max(0, 300 - (Date.now() - t0)));
      let s2 = await d2(SNAP);
      eq(s2.routed, true, 'routed'); eq(s2.timer, true, 'timer');
      approx(s2.makeup, Math.pow(10, 9 / 20), 0.03, 'remembered gain applied within 300 ms of play');
      eq(s2.loud.src, 'remembered', 'gain source = memory'); eq(s2.loud.measuring, true, 'a partial value keeps measuring'); approx(s2.gainDb, 9, 0.01, 'applied 9 dB'); approx(seededI, -23, 0.6, 'meter.i from memory');
      await p2.keyboard.press('Alt+L'); await sleep(700);
      await h2(`root.querySelector('.tab[data-tab="audio"]').click();`); await sleep(700);
      const desc = await h2(`const b = [...a.querySelectorAll('button[role=switch]')].find((x) => x.previousElementSibling.firstChild.textContent === 'Loudness normalize'); return b.previousElementSibling.children[1].textContent;`);
      eq(desc, 'Even out quiet & loud tracks · remembered · +9.0 dB', 'row says remembered');
      const sub2 = await h2(`return a.firstElementChild.firstElementChild.children[1].textContent;`);
      assert(SUB_RX.test(sub2), 'header meter line in the fresh page (got ' + sub2 + ')');
      await p2.keyboard.press('Alt+L'); await sleep(300);
      // downstream changes: bass +6 (auto-headroom moves the pre-amp), balance −100 (the matrix) — the source taps see none of it
      await d2(`d.set('bassDb', 6); d.set('balance', -100);`);
      await sleep(10000);
      s2 = await d2(`return { makeup: d.params.makeup.gain, loud: d.loud(), preamp: d.params.preamp.gain, gLL: d.params.gLL.gain, mem: d.loudMem()[${JSON.stringify(HREF)}] };`);
      assert(s2.preamp < 0.9, 'auto-headroom took the pre-amp down for bass +6 (got ' + s2.preamp + ')'); eq(s2.gLL, 1, 'balance −100 in the matrix');
      approx(s2.loud.lint, -23, 0.3, 'live source measurement unmoved by bass / balance'); assert(s2.loud.blocks >= 16, 'measured through (blocks ' + s2.loud.blocks + ')');
      approx(s2.makeup, Math.pow(10, 9 / 20), 0.03, 'remembered gain unmoved');
      approx(s2.mem.l, -23, 0.3, 'memory still the source value'); assert(s2.mem.s >= e1.s, 'memory never shortened');
      await d2(`d.set('bassDb', 0); d.set('balance', 0); d.set('loudnessOn', false);`);
      await p2.evaluate(() => window.__afx.stop());
    } finally { await p2.close(); }
    await set('loudnessOn', false);
  });

  scenario('meter-line', async () => {
    // 2.6: with loudness on and fixture A the sub-line reads LUFS · peak · applied; with boost 300 % and fixture B it
    // carries the guard's gain reduction and the boost; the guard row suffix mirrors it
    await play('A', { loop: true, href: '/test/meter-a' });
    await set('loudnessOn', true);
    await audioTab();
    let sub = null;
    for (let i = 0; i < 40 && !(sub && SUB_RX.test(sub)); i++) { await sleep(250); sub = await subLine(); }
    assert(sub && SUB_RX.test(sub), 'sub-line within ~3 s of play (got ' + sub + ')');
    const lufs = parseFloat(sub.replace('−', '-')), pk = /peak (−?\d+\.\d) dB/.exec(sub);
    approx(lufs, -23, 0.3, 'LUFS segment'); assert(pk, 'peak segment');
    // the peak is post-limiter: source −23 dBFS + the applied gain (the makeup is still ramping up, so it lies between)
    const pkDb = parseFloat(pk[1].replace('−', '-')); assert(pkDb > -23.2 && pkDb < -13.8, 'peak between the source level and the target (got ' + pkDb + ')');
    await set('loudnessOn', false);
    await play('B', { loop: true, href: '/test/meter-b', sampleRate: 48000 });
    await set('boostAmt', 300); await sleep(2600);
    let seen = null;
    for (let i = 0; i < 30 && !seen; i++) { const t = await subLine(); if (/guard −\d+\.\d dB/.test(t) && /boost 300 %/.test(t)) seen = t; await sleep(100); }
    assert(seen, 'sub-line shows guard GR and boost 300 % (last ' + await subLine() + ')');
    assert(!/LUFS/.test(seen) && !/applied/.test(seen), 'no LUFS / applied segments with loudness off (got ' + seen + ')');
    assert(/^peak −?\d+\.\d dB · boost 300 % · guard −\d+\.\d dB$/.test(seen), 'segment order peak · boost · guard (got ' + seen + ')');
    await closeHub(); await stopPlay();
  });

  /* ── WP5 helpers: rows by label, the chips, the section walk, labelled selects ── */
  const sliderByLabel = (label) => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.parentElement.firstChild.textContent === ${JSON.stringify(label)}); if (!r) return null; const row = r.parentElement; return { min: r.min, max: r.max, step: r.step, value: r.value, label: row.firstChild.textContent, val: row.lastChild.textContent, title: row.firstChild.title, valW: row.lastChild.getBoundingClientRect().width, valScroll: row.lastChild.scrollWidth };`);
  const sliderSet = (label, v) => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.parentElement.firstChild.textContent === ${JSON.stringify(label)}); r.value = ${JSON.stringify(String(v))}; r.dispatchEvent(new Event('input', { bubbles: true }));`);
  const sliderReset = (label) => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.parentElement.firstChild.textContent === ${JSON.stringify(label)}); r.parentElement.firstChild.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`);
  const chipInfo = () => abody(`return [...a.querySelectorAll('button')].filter((b) => /^(Headphones|Laptop|Speakers)$/.test(b.textContent)).map((b) => ({ txt: b.textContent, bg: b.style.background, color: b.style.color, flex: b.style.flex, padding: b.style.padding }));`);
  const sectionOrder = () => abody(`return [...a.children[2].children].map((el) => el.textContent.trim().slice(0, 16));`);
  const switchState = (label) => abody(`const b = [...a.querySelectorAll('button[role=switch]')].find((x) => x.previousElementSibling && x.previousElementSibling.firstChild && x.previousElementSibling.firstChild.textContent === ${JSON.stringify(label)}); return b ? b.getAttribute('aria-checked') : null;`);
  const selectByLabel = (label) => abody(`const s = [...a.querySelectorAll('span')].find((x) => x.textContent === ${JSON.stringify(label)}); const sel = s && s.nextElementSibling; return sel && sel.tagName === 'SELECT' ? { value: sel.value, opacity: sel.parentElement.style.opacity, opts: [...sel.options].map((o) => o.value + ':' + o.textContent).join(','), css: sel.style.cssText, cls: sel.className, labelW: s.getBoundingClientRect().width } : null;`);
  const selectChoose = (label, v) => abody(`const s = [...a.querySelectorAll('span')].find((x) => x.textContent === ${JSON.stringify(label)}); const sel = s.nextElementSibling; sel.value = ${JSON.stringify(v)}; sel.dispatchEvent(new Event('change', { bubbles: true }));`);
  const rowStarts = (order, i, p) => assert(order[i] != null && order[i].indexOf(p) === 0, 'row ' + i + ' starts with ' + JSON.stringify(p) + ' (got ' + JSON.stringify(order[i]) + ')');

  scenario('tone-ui', async () => {
    // 2.10 – 2.12: the Tone rows (Bass · Vocals · Loudness contour · Tilt) between Playback and Enhance, their value
    // copy and tooltips, the label double-click reset, and the one-time "softened, not removed" hint from applyFx
    await dbg(`d.gm('enh:vocalHint', 0);`);   // applyfx-rules already dipped the vocals once this run: start the hint fresh
    await play('A', { loop: true });
    await audioTab();
    const order = await sectionOrder();
    const iT = order.indexOf('Tone');
    assert(iT > 0, 'Tone section present');
    rowStarts(order, iT - 1, 'Skip silent endi'); rowStarts(order, iT + 1, 'Bass'); rowStarts(order, iT + 2, 'Harmonic bass'); rowStarts(order, iT + 3, 'Vocals'); rowStarts(order, iT + 4, 'Loudness contour'); rowStarts(order, iT + 5, 'Tilt'); rowStarts(order, iT + 6, 'Enhance');
    // bass: 0..9 step .5, "+3.5 dB", the rumble tooltip plus the reset hint
    let r = await sliderByLabel('Bass');
    eq(r.min + '..' + r.max + '/' + r.step, '0..9/0.5', 'bass range'); eq(r.val, '0 dB', 'bass at 0');
    assert(/Sub-25 Hz rumble is removed automatically while bass is boosted/.test(r.title) && /double-click resets/.test(r.title), 'bass tooltip (got ' + r.title + ')');
    await sliderSet('Bass', 3.5); await sleep(350);
    eq(await get('bassDb'), 3.5, 'bass slider writes bassDb'); eq((await sliderByLabel('Bass')).val, '+3.5 dB', 'bass value copy');
    let s = await snap(); approx(s.params.bass.gain, 3.5, 0.001, 'bass node'); eq(s.params.rumble.type, 'highpass', 'rumble engaged');
    await sliderReset('Bass'); await sleep(350);
    eq(await get('bassDb'), 0, 'bass label double-click resets'); eq((await sliderByLabel('Bass')).val, '0 dB', 'bass back to 0 dB');
    s = await snap(); eq(s.params.rumble.type, 'peaking', 'rumble back to identity');
    // vocals: −100..100, Softer / Normal / Lift; the hint once, from applyFx, the first time the value goes below −50
    r = await sliderByLabel('Vocals'); eq(r.min + '..' + r.max + '/' + r.step, '-100..100/5', 'vocals range'); eq(r.val, 'Normal', 'vocals at 0');
    assert(/double-click resets/.test(r.title) && /stereo/.test(r.title), 'vocals tooltip: the stereo cue + the reset hint (got ' + r.title + ')');
    await sliderSet('Vocals', -40); await sleep(350);
    eq(await get('vocalAmt'), -40, 'vocals slider writes vocalAmt'); eq((await sliderByLabel('Vocals')).val, 'Softer 40', 'Softer 40');
    eq(await toastText(), null, 'no hint above −50');
    await set('vocalAmt', -100); await sleep(250);
    eq(await toastText(), 'Vocals are softened, not removed — works on stereo mixes', 'the hint the first time below −50');
    eq((await sliderByLabel('Vocals')).val, 'Softer 100', 'a debug write repaints the row: Softer 100');
    r = await sliderByLabel('Vocals'); assert(r.valScroll <= r.valW + 0.5, 'the value fits its column (' + r.valScroll + ' in ' + r.valW + ')');
    s = await snap(); approx(s.params.vGain.gain, 0.1, 0.001, 'vGain 0.1');
    await sleep(2300);   // the toast has faded
    await set('vocalAmt', 0); await set('vocalAmt', -80); await sleep(250);
    eq(await toastText(), null, 'the hint shows once');
    await sliderSet('Vocals', 40); await sleep(350); eq((await sliderByLabel('Vocals')).val, 'Lift 40', 'Lift 40');
    s = await snap(); approx(s.params.vGain.gain, Math.pow(10, 1.6 / 20), 0.002, 'lift 40 → +1.6 dB');
    await sliderReset('Vocals'); await sleep(350); eq(await get('vocalAmt'), 0, 'vocals reset'); s = await snap(); eq(s.params.vGain.gain, 1, 'vGain 1');
    // tilt: −4..4 step .5, Warm / Flat / Bright (the per-shelf figure), last in Tone
    r = await sliderByLabel('Tilt'); eq(r.min + '..' + r.max + '/' + r.step, '-4..4/0.5', 'tilt range'); eq(r.val, 'Flat', 'tilt at 0');
    await sliderSet('Tilt', -2); await sleep(350); eq((await sliderByLabel('Tilt')).val, 'Warm 2', 'Warm 2');
    s = await snap(); approx(s.params.tiltLo.gain, 2, 0.001, 'tiltLo +2 (warm)'); approx(s.params.tiltHi.gain, -2, 0.001, 'tiltHi −2');
    await sliderSet('Tilt', 2.5); await sleep(350); eq((await sliderByLabel('Tilt')).val, 'Bright 2.5', 'Bright 2.5'); eq(await get('tiltDb'), 2.5, 'tiltDb 2.5');
    r = await sliderByLabel('Tilt'); assert(r.valScroll <= r.valW + 0.5, 'the value fits its column (' + r.valScroll + ' in ' + r.valW + ')');
    await set('tiltDb', 6); await sleep(200); s = await snap(); approx(s.params.tiltHi.gain, 4, 0.001, 'tilt clamped to 4'); eq((await sliderByLabel('Tilt')).val, 'Bright 4', 'the row shows the clamped value');
    await sliderReset('Tilt'); await sleep(350); eq(await get('tiltDb'), 0, 'tilt reset'); eq((await sliderByLabel('Tilt')).val, 'Flat', 'Flat again');
    s = await snap(); eq(s.routed, true, 'still routed while the tab is open');
    await closeHub(); await sleep(150); s = await snap(); eq(s.routed, false, 'everything at its default, tab closed → detached');
    await stopPlay();
  });

  scenario('loudness-contour', async () => {
    // 2.14: SoundCloud's volume slider (element.volume) drives the contour from the enforce tick: at 0.2 the shelves
    // rise to 6·(0.25/0.45) = 3.33 dB (bass) and a third of it (treble); at 1 they return to 0. The row says which.
    const LC = 'Keeps bass & sparkle when SoundCloud’s volume slider is low';
    await play('A', { loop: true });
    await sleep(1200);   // rememberVol restores the stored volume once per element on the first tick; the slider moves after that
    await page.evaluate(() => { window.__afx.el().volume = 0.2; });
    await audioTab();
    eq(await toggleDesc('Loudness contour'), LC, 'row copy while off');
    eq(await switchState('Loudness contour'), 'false', 'switch off');
    eq(await switchClick('Loudness contour'), 'true', 'switch on');
    let s = null;
    for (let i = 0; i < 14 && !(s && near(s.params.lcLo.gain, 3.33, 0.2)); i++) { await sleep(250); s = await snap(); }
    approx(s.params.lcLo.gain, 3.33, 0.2, 'lcLo ≈ +3.3 dB at volume 0.2 within ~3 s');
    approx(s.params.lcHi.gain, 1.11, 0.1, 'lcHi a third of it');
    eq(s.params.rumble.type, 'highpass', 'the contour engages the rumble filter');
    eq(guardOn(s), true, 'the contour engages the guard');
    eq(s.routed, true, 'routed');
    approx(await dbg(`return d.contourK();`), 0.5556, 0.01, 'k = (0.45 − 0.2) / 0.45');
    const hd = await dbg(`return d.headroomDb;`); assert(hd > 2.8 && hd < 3.6, 'the contour counts in the auto-headroom (got ' + hd + ')');
    let desc = null;
    for (let i = 0; i < 10 && !/\+3\.3 dB bass/.test(desc || ''); i++) { await sleep(250); desc = await toggleDesc('Loudness contour'); }
    eq(desc, LC + ' · +3.3 dB bass', 'the row suffix shows the live depth');
    // Compare bypasses it (a tone stage) without touching the switch; back after
    await dbg(`d.bypass(true);`); await sleep(150); s = await snap(); eq(s.params.lcLo.gain, 0, 'Compare → 0'); eq(s.params.lcHi.gain, 0, 'Compare → 0 (hi)');
    eq(await switchState('Loudness contour'), 'true', 'the switch stays on while comparing');
    await dbg(`d.bypass(false);`); await sleep(1300); s = await snap(); approx(s.params.lcLo.gain, 3.33, 0.2, 'back after Compare');
    // the volume slider back up: off within the next ticks, the headroom released, and the row says so
    await page.evaluate(() => { window.__afx.el().volume = 1; });
    s = null;
    for (let i = 0; i < 14 && !(s && Math.abs(s.params.lcLo.gain) < 0.05); i++) { await sleep(250); s = await snap(); }
    approx(s.params.lcLo.gain, 0, 0.05, 'lcLo → 0 at volume 1 within ~3 s'); approx(s.params.lcHi.gain, 0, 0.05, 'lcHi → 0');
    desc = null;
    for (let i = 0; i < 10 && !/off at this volume/.test(desc || ''); i++) { await sleep(250); desc = await toggleDesc('Loudness contour'); }
    eq(desc, LC + ' · off at this volume', 'the row suffix reads off at this volume');
    eq(await dbg(`return d.headroomDb;`), 0, 'headroom released');
    eq(await dbg(`return d.contourK();`), 0, 'k = 0 at volume 1');
    // half-way: 0.3 → k 1/3 → 2 dB
    await page.evaluate(() => { window.__afx.el().volume = 0.3; });
    s = null;
    for (let i = 0; i < 14 && !(s && near(s.params.lcLo.gain, 2, 0.15)); i++) { await sleep(250); s = await snap(); }
    approx(s.params.lcLo.gain, 2, 0.15, 'lcLo ≈ +2 dB at volume 0.3');
    eq(await switchClick('Loudness contour'), 'false', 'switch off');
    await sleep(150); eq(await toggleDesc('Loudness contour'), LC, 'plain copy again'); s = await snap(); eq(s.params.lcLo.gain, 0, 'off → 0');
    // the suite remembers the element volume (rememberVol) and restores it to every later fixture element: leave 1 behind
    await page.evaluate(() => { window.__afx.el().volume = 1; }); await dbg(`d.gm('enh:vol', '1');`);
    await closeHub(); await stopPlay();
  });

  scenario('listening-on', async () => {
    // 2.13: three chips directly after the Auto-headroom row; a tap applies a bundle, lights the chip and toasts;
    // any edit of what the bundle set un-lights it (a debug write + repaint, a slider or switch in the tab)
    await play('A', { loop: true });
    await set('tiltDb', 2);   // Headphones leaves tilt alone
    await audioTab();
    const order = (await sectionOrder()).filter((t) => !/^(No scenes saved|Scenes ·)/.test(t));   // the scenes row sits between the chips and Playback
    const iL = order.indexOf('Listening on');
    assert(iL > 0, 'Listening on section present');
    rowStarts(order, iL - 1, 'Remember EQ per '); eq(order[iL + 1], 'HeadphonesLaptop', 'the chip row'); eq(order[iL + 2], 'Playback', 'before Playback');
    let chips = await chipInfo();
    eq(chips.map((c) => c.txt).join(','), 'Headphones,Laptop,Speakers', 'three chips');
    assert(chips.every((c) => /^1( 1 0%)?$/.test(c.flex) && c.padding === '8px 0px'), 'chips flex:1 · padding 8px 0 (got ' + JSON.stringify(chips[0]) + ')');
    assert(chips.every((c) => c.bg === PLAIN.bg && c.color === PLAIN.color), 'no chip lit with listenOn empty');
    await btnClick('Headphones'); await sleep(250);
    eq(await get('crossfeedOn'), true, 'headphones: crossfeed on'); eq(await get('crossfeedMode'), 'natural', 'natural'); eq(await get('bassDb'), 2, 'bass +2'); eq(await get('loudCompOn'), false, 'contour off'); eq(await get('tiltDb'), 2, 'tilt untouched');
    eq(await get('listenOn'), 'headphones', 'listenOn headphones');
    eq(await toastText(), 'Headphones · crossfeed + bass +2 dB', 'headphones toast');
    chips = await chipInfo(); eq(chips[0].bg + '|' + chips[0].color, TINT.bg + '|' + TINT.color, 'Headphones chip lit'); assert(chips[1].bg === PLAIN.bg && chips[2].bg === PLAIN.bg, 'the others plain');
    let s = await snap(); approx(s.params.cfFeedL.gain, 0.334, 0.001, 'crossfeed natural in the chain'); approx(s.params.bass.gain, 2, 0.001, 'bass +2 in the chain'); eq(s.params.rumble.type, 'highpass', 'rumble under the bass lift');
    // the rows the bundle touched mirror it without a re-render
    eq((await sliderByLabel('Bass')).val, '+2 dB', 'the Bass row follows the profile');
    eq(await switchState('Crossfeed'), 'true', 'the Crossfeed switch follows');
    eq((await selectByLabel('Mode')).value, 'natural', 'the Mode select follows');
    // a debug write to one of the five keys + a re-render un-lights the chip
    await set('bassDb', 5); await sleep(200);
    eq(await get('listenOn'), '', 'listenOn cleared by the edit');
    await audioTab();
    chips = await chipInfo(); assert(chips.every((c) => c.bg === PLAIN.bg && c.color === PLAIN.color), 'no chip lit after the edit');
    eq(await get('crossfeedOn'), true, 'the rest of the bundle stays (crossfeed on)');
    // laptop
    await btnClick('Laptop'); await sleep(250);
    eq(await get('crossfeedOn'), false, 'laptop: crossfeed off'); eq(await get('bassDb'), 3, 'bass +3'); eq(await get('tiltDb'), 1, 'tilt +1'); eq(await get('loudCompOn'), true, 'contour on');
    eq(await get('listenOn'), 'laptop', 'listenOn laptop'); eq(await toastText(), 'Laptop · bass +3 dB, brighter, loudness contour', 'laptop toast');
    chips = await chipInfo(); assert(chips[1].bg === TINT.bg && chips[0].bg === PLAIN.bg && chips[2].bg === PLAIN.bg, 'Laptop chip lit alone');
    eq((await sliderByLabel('Tilt')).val, 'Bright 1', 'the Tilt row follows'); eq(await switchState('Loudness contour'), 'true', 'the contour switch follows');
    s = await snap(); approx(s.params.tiltHi.gain, 1, 0.001, 'tilt +1 in the chain'); eq(s.params.cfFeedL.gain, 0, 'crossfeed off in the chain');
    // an edit in the tab itself (the Tilt slider) un-lights it live — no re-render
    await sliderSet('Tilt', 0); await sleep(300);
    eq(await get('listenOn'), '', 'a tilt slider edit clears listenOn');
    chips = await chipInfo(); assert(chips.every((c) => c.bg === PLAIN.bg), 'chip un-lit live');
    eq(await get('loudCompOn'), true, 'the rest of the bundle stays (contour on)');
    // speakers
    await btnClick('Speakers'); await sleep(250);
    eq(await get('bassDb'), 0, 'speakers: bass 0'); eq(await get('tiltDb'), 0, 'tilt 0'); eq(await get('crossfeedOn'), false, 'crossfeed off'); eq(await get('loudCompOn'), false, 'contour off');
    eq(await get('listenOn'), 'speakers', 'listenOn speakers'); eq(await toastText(), 'Speakers · neutral', 'speakers toast');
    chips = await chipInfo(); assert(chips[2].bg === TINT.bg && chips[0].bg === PLAIN.bg && chips[1].bg === PLAIN.bg, 'Speakers chip lit alone');
    // a key outside the bundle (vocals) leaves the chip lit; so does a re-render
    await set('vocalAmt', -30); await sleep(200); eq(await get('listenOn'), 'speakers', 'a key outside the bundle leaves the chip lit');
    await audioTab(); chips = await chipInfo(); assert(chips[2].bg === TINT.bg, 'still lit after a re-render');
    // the contour switch in the tab clears it (one of the five keys)
    await switchClick('Loudness contour'); await sleep(200); eq(await get('listenOn'), '', 'the contour switch clears it');
    chips = await chipInfo(); assert(chips.every((c) => c.bg === PLAIN.bg), 'chip un-lit');
    await switchClick('Loudness contour');
    // the tapped profile survives a re-render of the tab and the hub closing
    await btnClick('Headphones'); await sleep(200); await closeHub(); await audioTab();
    chips = await chipInfo(); assert(chips[0].bg === TINT.bg, 'Headphones still lit after close + reopen'); eq(await get('listenOn'), 'headphones', 'listenOn kept');
    await closeHub(); await stopPlay();
  });

  scenario('stereo-ui', async () => {
    // 2.15 – 2.18: the Stereo section = Stereo width · Crossfeed · Mode · Balance · Mono; the Mode select wakes the
    // switch like the loudness Target does; Balance reads L / Centre / R and its label double-click resets it
    await play('A', { loop: true });
    await audioTab();
    const order = await sectionOrder();
    const iS = order.indexOf('Stereo');
    assert(iS > 0, 'Stereo section present');
    rowStarts(order, iS - 1, 'Clip guard'); rowStarts(order, iS + 1, 'Stereo width'); rowStarts(order, iS + 2, 'Crossfeed'); rowStarts(order, iS + 3, 'Mode'); rowStarts(order, iS + 4, 'Balance'); rowStarts(order, iS + 5, 'Mono');
    rowStarts(order, iS + 6, 'Swap left / righ'); rowStarts(order, iS + 7, 'Headphone correc');
    // crossfeed row copy + the Mode select (the preset select's clothes, dimmed while off)
    eq(await toggleDesc('Crossfeed'), 'Headphones sound like speakers in a room · less ping-pong fatigue', 'crossfeed copy');
    eq(await toggleDesc('Mono'), 'Same sound in both ears · for one earbud or a single speaker', 'mono copy');
    let md = await selectByLabel('Mode');
    assert(md, 'Mode select present'); eq(md.opts, 'subtle:Subtle,natural:Natural,strong:Strong', 'mode options'); eq(md.value, 'natural', 'natural by default');
    eq(md.opacity, '0.45', 'Mode row dimmed while crossfeed is off'); eq(md.cls, 'sxsel', 'select class'); approx(md.labelW, 86, 1, 'Mode label 86 px');
    assert(/border-radius: 10px/.test(md.css) && /padding: 10px 12px/.test(md.css), 'the preset select\'s cssText');
    await selectChoose('Mode', 'strong'); await sleep(200);
    eq(await get('crossfeedMode'), 'strong', 'select writes crossfeedMode'); eq(await get('crossfeedOn'), true, 'choosing a mode wakes the switch');
    eq(await switchState('Crossfeed'), 'true', 'switch painted on'); eq((await selectByLabel('Mode')).opacity, '1', 'Mode row lit');
    let s = await snap(); approx(s.params.cfFeedL.gain, 0.373, 0.001, 'strong in the chain');
    eq(await switchClick('Crossfeed'), 'false', 'switch off'); await sleep(200);
    eq(await get('crossfeedOn'), false, 'crossfeedOn false'); eq((await selectByLabel('Mode')).opacity, '0.45', 'Mode row dimmed again'); s = await snap(); eq(s.params.cfFeedL.gain, 0, 'off in the chain');
    await set('crossfeedMode', 'subtle'); await sleep(200); eq((await selectByLabel('Mode')).value, 'subtle', 'a debug write repaints the select');
    // balance: −100..100 step 5, L / Centre / R, attenuate-only in the chain, double-click resets
    let r = await sliderByLabel('Balance'); eq(r.min + '..' + r.max + '/' + r.step, '-100..100/5', 'balance range'); eq(r.val, 'Centre', 'Centre at 0');
    assert(/double-click resets/.test(r.title), 'balance reset hint');
    await sliderSet('Balance', -20); await sleep(350); eq((await sliderByLabel('Balance')).val, 'L 20', 'L 20'); eq(await get('balance'), -20, 'balance −20');
    s = await snap(); eq(s.params.gLL.gain, 1, 'L untouched'); approx(s.params.gRR.gain, 0.8, 0.001, 'R attenuated to 0.8');
    await sliderSet('Balance', 50); await sleep(350); eq((await sliderByLabel('Balance')).val, 'R 50', 'R 50');
    s = await snap(); approx(s.params.gLL.gain, 0.5, 0.001, 'L 0.5'); eq(s.params.gRR.gain, 1, 'R untouched'); eq(s.params.gLR.gain, 0, 'no bleed');
    await sliderReset('Balance'); await sleep(350); eq(await get('balance'), 0, 'label double-click → 0'); eq((await sliderByLabel('Balance')).val, 'Centre', 'Centre again');
    s = await snap(); eq(s.params.gLL.gain, 1, 'identity LL'); eq(s.params.gRR.gain, 1, 'identity RR');
    // mono: the switch drives monoOn; composes with balance
    eq(await switchClick('Mono'), 'true', 'mono on'); await sleep(200);
    s = await snap(); for (const k of ['gLL', 'gLR', 'gRL', 'gRR']) approx(s.params[k].gain, 0.5, 0.001, 'mono ' + k);
    await sliderSet('Balance', 100); await sleep(350); s = await snap();
    approx(s.params.gLL.gain, 0, 0.001, 'mono + balance R 100: L output silent'); approx(s.params.gRL.gain, 0, 0.001, 'L output silent (from R)'); approx(s.params.gRR.gain, 0.5, 0.001, 'R output mono');
    await sliderReset('Balance'); eq(await switchClick('Mono'), 'false', 'mono off'); await sleep(200);
    s = await snap(); eq(s.params.gLL.gain, 1, 'identity'); eq(s.params.gLR.gain, 0, 'identity'); eq(await get('monoOn'), false, 'monoOn false');
    // the width row keeps its copy (it moved under Stereo in WP1); the section's value columns line up
    r = await sliderByLabel('Stereo width'); eq(r.val, 'Normal', 'width Normal');
    const widths = await abody(`return ['Bass', 'Vocals', 'Tilt', 'Stereo width', 'Balance'].map((l) => { const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.parentElement.firstChild.textContent === l); return Math.round(r.getBoundingClientRect().width); });`);
    assert(widths.every((w) => w === widths[0]), 'the tone / stereo tracks share one width (got ' + widths.join(',') + ')');
    await closeHub(); await sleep(150); s = await snap(); eq(s.routed, false, 'crossfeed off (its mode alone is inert), width 100, balance 0, mono off, tab closed → detached');
    await stopPlay();
  });

  scenario('night-mode', async () => {
    // 2.7: Night mode = the comp as a leveller. Params at 50 %; compTrim = makeup − Chromium's auto-makeup (the offline
    // calibration, checked against the static-curve replica); on fixture D the post-limiter mean power with Night on
    // vs off stays within 3 dB and the comp's gain reduction reads −5..−22 dB during the bursts; the rows sit between
    // the loudness Target and Volume boost, Strength dims while off and wakes the switch; the row shows the live GR;
    // off (with Enhance off) leaves the comp exactly inert, and Night off hands the comp back to Enhance.
    await dbg(`d.gm('enh:vol', '1');`);   // the remembered volume lands on the fixture element at its first enforce tick
    await play('D', { loop: true, sampleRate: 48000 });
    await audioTab();
    const order = await sectionOrder();
    const iL = order.indexOf('Loudness & dynam');
    assert(iL > 0, 'Loudness & dynamics section present');
    rowStarts(order, iL + 1, 'Loudness normali'); rowStarts(order, iL + 2, 'Target'); rowStarts(order, iL + 3, 'Night mode'); rowStarts(order, iL + 4, 'Strength');
    rowStarts(order, iL + 5, 'Volume boost'); rowStarts(order, iL + 6, 'Clip guard'); rowStarts(order, iL + 7, 'Stereo');
    eq(await toggleDesc('Night mode'), 'Quiet parts up, loud parts down · late-night & commute listening', 'night copy');
    eq(await switchState('Night mode'), 'false', 'off by default');
    let r = await sliderByLabel('Strength');
    eq(r.min + '..' + r.max + '/' + r.step, '0..100/5', 'strength range'); eq(r.val, '50%', 'strength 50 %'); assert(/double-click resets/.test(r.title), 'strength reset hint');
    const strOpacity = () => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.parentElement.firstChild.textContent === 'Strength'); return r.parentElement.style.opacity;`);
    eq(await strOpacity(), '0.45', 'Strength dimmed while Night is off');
    // the level reference with Night off (post-limiter mean power, 3 s): the open tab routes the (transparent) chain,
    // and the output tap is only read from a routed chain — wait for that rather than for a fixed time
    let pre = null;
    for (let i = 0; i < 30; i++) { pre = await snap(); if (pre.routed && pre.tabOn) break; await sleep(100); }
    assert(pre.routed && pre.tabOn, 'tab open routes the chain before the reference read (tabOn ' + pre.tabOn + ', routed ' + pre.routed + ', chains ' + pre.chains + ')');
    // …and for the tap to carry the fixture's bursts (sample peak −3 dBFS, one every 0.4 s within the 683 ms window)
    let pk = null;
    for (let i = 0; i < 50; i++) { pk = (await dbg(`return d.meterTick().peak;`)); if (pk > -6 && pk < 0) break; await sleep(100); }
    assert(pk > -6 && pk < 0, 'fixture D reaches the output tap (peak ' + (pk == null ? 'null' : pk.toFixed(1)) + ' dBFS)');
    await sleep(800);
    const offReads = await meterReads(12, 250);
    const off = powerAvg(offReads.map((m) => m.outDb));
    assert(off > -18 && off < -12, 'reference is fixture D through the transparent chain, ≈ −15 dB (got ' + off.toFixed(2) + '; peaks ' + offReads.map((m) => m.peak.toFixed(1)).join(' ') + ')');
    // 50 %: thr −30, knee 24, ratio 3, attack 20 ms, release 0.5 s; makeup = max(0, −8 − thr)·(1 − 1/ratio) = 14.67 dB
    // (the spec's "14.7") minus Chromium's auto-makeup; 100 %: thr −36, ratio 4 → 21 dB
    const MK50 = Math.min(22, 22 * (1 - 1 / 3)), MK100 = Math.min(22, 28 * (1 - 1 / 4));
    await set('nightOn', true); await set('nightAmt', 50); await sleep(150);
    let s = await snap();
    approx(s.params.comp.threshold, -30, 0.001, 'thr −30'); approx(s.params.comp.ratio, 3, 0.001, 'ratio 3'); approx(s.params.comp.knee, 24, 0.001, 'knee 24');
    approx(s.params.comp.attack, 0.02, 0.001, 'attack 0.02'); approx(s.params.comp.release, 0.5, 0.001, 'release 0.5');
    eq(guardOn(s), true, 'Night engages the guard'); eq(s.routed, true, 'routed');
    const trimFor = async (makeupDb, key) => { const cal = await dbg(`return d.calib();`); const c = cal[key]; assert(c, key + ' not in the calibration map'); return { g: Math.pow(10, (makeupDb - c.db) / 20), db: c.db, exact: c.exact }; };
    let t = await trimFor(MK50, '-30|24|3');
    approx(s.params.compTrim.gain, t.g, 0.02, 'compTrim = makeup ' + MK50.toFixed(2) + ' dB − auto-makeup ' + t.db.toFixed(2) + ' dB');
    assert(Math.abs(t.db - 6.03) < 0.3, 'auto-makeup for −30/24/3 matches Chromium\'s static curve (6.03 dB; got ' + t.db.toFixed(2) + ')');
    await sleep(500); t = await trimFor(MK50, '-30|24|3'); s = await snap();
    eq(t.exact, true, 'offline calibration landed'); approx(s.params.compTrim.gain, t.g, 0.002, 'compTrim follows the calibrated value');
    assert(s.params.compTrim.gain > 1, 'the trim adds makeup beyond Chromium\'s (got ' + s.params.compTrim.gain.toFixed(3) + ')');
    // level match + gain reduction on fixture D
    await sleep(800);
    const rs = await meterReads(12, 250);
    const on = powerAvg(rs.map((m) => m.outDb));
    const grs = (await meterReads(20, 70)).map((m) => m.gr).concat(rs.map((m) => m.gr));
    const grMin = Math.min(...grs);
    console.log('  night: off ' + off.toFixed(2) + ' dB, on ' + on.toFixed(2) + ' dB, comp GR min ' + grMin.toFixed(2) + ' dB, lim GR min ' + Math.min(...rs.map((m) => m.limGr)).toFixed(2) + ' dB');
    assert(Math.abs(on - off) < 3, 'Night on vs off within 3 dB (off ' + off.toFixed(2) + ', on ' + on.toFixed(2) + ')');
    assert(grMin <= -5 && grMin >= -22, 'comp GR between −5 and −22 dB during bursts (got ' + grMin.toFixed(2) + ')');
    // the row carries the live gain reduction (release 0.5 s over a 0.35 s gap: it never fully recovers)
    let desc = null;
    for (let i = 0; i < 15 && !/dB$/.test(desc || ''); i++) { desc = await toggleDesc('Night mode'); await sleep(120); }
    assert(/^Quiet parts up, loud parts down · late-night & commute listening · −\d+\.\d dB$/.test(desc), 'live GR suffix (got ' + JSON.stringify(desc) + ')');
    eq(await switchState('Night mode'), 'true', 'a debug write repaints the switch'); eq(await strOpacity(), '1', 'Strength lit');
    // Compare bypasses Night: the comp goes inert, the suffix goes with it
    await dbg(`d.bypass(true);`); await sleep(150); s = await snap();
    eq(s.params.comp.ratio, 1, 'Compare nulls the comp'); eq(s.params.compTrim.gain, 1, 'Compare nulls the trim');
    // the comp's reduction meter decays at its 0.5 s release once the curve is flat: the suffix follows within a few seconds
    for (let i = 0; i < 25 && /dB$/.test(desc || ''); i++) { await sleep(120); desc = await toggleDesc('Night mode'); }
    eq(desc, 'Quiet parts up, loud parts down · late-night & commute listening', 'suffix gone while comparing');
    await dbg(`d.bypass(false);`); await sleep(150);
    // 100 %: thr −36, ratio 4, makeup 21 dB (a fresh calibration key)
    await sliderSet('Strength', 100); await sleep(350); s = await snap();
    eq(await get('nightAmt'), 100, 'slider writes nightAmt'); approx(s.params.comp.threshold, -36, 0.001, 'thr −36'); approx(s.params.comp.ratio, 4, 0.001, 'ratio 4');
    t = await trimFor(MK100, '-36|24|4'); approx(s.params.compTrim.gain, t.g, 0.02, 'compTrim = makeup 21 dB − auto-makeup ' + t.db.toFixed(2) + ' dB');
    await sleep(500); t = await trimFor(MK100, '-36|24|4'); s = await snap(); eq(t.exact, true, '100 % calibration landed'); approx(s.params.compTrim.gain, t.g, 0.002, 'trim follows it');
    // label double-click → 50 (Night stays on); the switch turns it off and dims Strength; touching Strength wakes it
    await sliderReset('Strength'); await sleep(350);
    eq(await get('nightAmt'), 50, 'label double-click resets Strength'); eq(await get('nightOn'), true, 'Night stays on'); eq((await sliderByLabel('Strength')).val, '50%', '50 % again');
    eq(await switchClick('Night mode'), 'false', 'switch turns Night off'); await sleep(200);
    eq(await get('nightOn'), false, 'nightOn false'); eq(await strOpacity(), '0.45', 'Strength dims again');
    s = await snap(); eq(s.params.comp.ratio, 1, 'comp inert'); eq(s.params.comp.threshold, 0, 'thr 0'); eq(s.params.comp.knee, 0, 'knee 0'); eq(s.params.compTrim.gain, 1, 'compTrim 1');
    await sliderSet('Strength', 70); await sleep(350);
    eq(await get('nightOn'), true, 'touching Strength wakes Night'); eq(await switchState('Night mode'), 'true', 'switch painted on'); eq(await strOpacity(), '1', 'Strength lit');
    s = await snap(); approx(s.params.comp.threshold, -32.4, 0.001, 'thr at 70 %'); approx(s.params.comp.ratio, 3.4, 0.001, 'ratio at 70 %');
    // Night wins over Enhance; Night off hands the comp back to Enhance (2.25 keeps its level match — its own scenario re-runs it)
    await set('enhanceOn', true); s = await snap(); approx(s.params.comp.threshold, -32.4, 0.001, 'Night keeps the comp with Enhance on');
    eq(s.params.cpG.gain, 1, 'Night: the wideband path'); eq(s.params.mbG.gain, 0, 'Night parks the bank'); eq(s.params.mbLo.ratio, 1, 'bank inert under Night'); approx(s.params.air.gain, 1.5, 0.001, 'Enhance tone stays under Night');
    await set('nightOn', false); s = await snap(); eq(s.params.comp.ratio, 1, 'Night off: Enhance 50 % takes its bank back (comp idle)'); eq(s.params.comp.threshold, 0, 'comp thr 0');
    eq(s.params.cpG.gain, 0, 'cpG 0'); assert(s.params.mbG.gain > 0 && Math.abs(s.params.mbG.gain * s.params.mbOut.gain - 1) < 0.02, 'bank in, wrap nets to 1'); approx(s.params.mbLo.threshold, -19.75, 0.001, 'lo band thr at 50 %'); approx(s.params.mbLo.ratio, 1.3, 0.001, 'lo band ratio at 50 %'); approx(s.params.mbLo.knee, 12, 0.001, 'bank knee');
    await set('enhanceOn', false); await set('nightAmt', 50); s = await snap();
    eq(s.params.comp.ratio, 1, 'both off: ratio 1'); eq(s.params.comp.threshold, 0, 'threshold 0'); eq(s.params.compTrim.gain, 1, 'compTrim 1'); eq(s.params.cpG.gain, 1, 'cpG 1'); eq(s.params.mbG.gain, 0, 'mbG 0');
    await closeHub(); await sleep(150); s = await snap(); eq(s.routed, false, 'nothing on → detached');
    await stopPlay();
  });

  /* ── WP7 helpers: the two paste boxes (0 = Headphone correction, 1 = the footer) and the footnote ── */
  const boxState = (i) => abody(`const t = a.querySelectorAll('textarea')[${i}]; if (!t) return null; const act = t.nextElementSibling; return { display: t.style.display, act: act.style.display, actBtns: [...act.querySelectorAll('button')].map((b) => b.textContent).join(','), ph: t.placeholder, css: t.style.cssText, value: t.value, focused: a.getRootNode().activeElement === t, tag: t.tagName };`);
  const boxType = (i, txt) => abody(`a.querySelectorAll('textarea')[${i}].value = ${JSON.stringify(txt)};`);
  const boxBtn = (i, txt) => abody(`const t = a.querySelectorAll('textarea')[${i}]; const b = [...t.nextElementSibling.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(txt)}); if (!b) throw new Error('no box button ' + ${JSON.stringify(txt)}); b.click();`);
  const btnDisplay = (txt) => abody(`const b = [...a.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(txt)}); return b ? b.style.display : null;`);
  const noteText = () => abody(`return [...a.querySelectorAll('div')].pop().textContent;`);
  const headerTitle = () => abody(`try { return a.firstElementChild.firstElementChild.children[0].textContent; } catch (e) { return null; }`);
  const AUTOEQ_2 = 'Preamp: -6.0 dB\nFilter 1: ON PK Fc 105 Hz Gain 3.1 dB Q 0.70\nFilter 2: ON HSC Fc 10000 Hz Gain -2.0 dB';
  // twelve filters, pasted out of frequency order, with a name line; filters 3 (210 Hz, +0.3) and 7 (3300 Hz, −0.2)
  // carry the two smallest |gain| and are the ones the ten-filter cap must drop; one OFF filter and an LS alias
  const AUTOEQ_12 = ['Sony WH-1000XM4', 'Preamp: -5.5 dB',
    'Filter 12: ON PK Fc 16000 Hz Gain 5.0 dB Q 0.70', 'Filter 1: ON PK Fc 40 Hz Gain 4.0 dB Q 0.70', 'Filter 2: ON LS Fc 105 Hz Gain -3.0 dB Q 0.70',
    'Filter 3: ON PK Fc 210 Hz Gain 0.3 dB Q 1.40', 'Filter 4: ON PK Fc 500 Hz Gain -2.5 dB Q 1.20', 'Filter 5: ON PK Fc 1000 Hz Gain 1.5 dB Q 2.00',
    'Filter 6: ON PK Fc 2500 Hz Gain -4.5 dB Q 1.10', 'Filter 7: ON PK Fc 3300 Hz Gain -0.2 dB Q 3.00', 'Filter 8: ON PK Fc 4800 Hz Gain 2.0 dB Q 1.50',
    'Filter 9: ON PK Fc 6000 Hz Gain -3.5 dB Q 2.50', 'Filter 10: ON PK Fc 8000 Hz Gain 1.0 dB Q 1.80', 'Filter 11: ON HSC Fc 10000 Hz Gain -2.0 dB Q 0.70',
    'Filter 13: OFF PK Fc 12000 Hz Gain 9.0 dB Q 1.00'].join('\n');

  scenario('headphone-correction', async () => {
    // 2.8: the last section; a debug paste fills the bank (types / frequencies / gains, the preamp folded into
    // the pre-amp node, the guard engaged); a 12-filter profile keeps the ten largest |gain| in frequency
    // order; peqOn off zeroes every filter; the row / buttons / paste box round-trip in the tab
    await play('A', { loop: true });
    await audioTab();
    const order = await sectionOrder();
    const iH = order.indexOf('Headphone correc');
    assert(iH > 0, 'Headphone correction section present');
    rowStarts(order, iH - 1, 'Swap left / righ'); rowStarts(order, iH + 1, 'Headphone correc'); rowStarts(order, iH + 2, 'Paste AutoEQClea');
    eq(order[iH + 3], '', 'the paste box row (empty text)'); rowStarts(order, iH + 4, 'ApplyCancel'); rowStarts(order, iH + 5, 'Copy settingsPas');
    eq(await abody(`return [...a.querySelectorAll('div')].filter((d) => /uppercase/.test(d.style.cssText)).map((d) => d.textContent).pop();`), 'Headphone correction', 'the label text (uppercase via CSS)');
    eq(await toggleDesc('Headphone correction'), 'Paste an AutoEQ profile for your headphones', 'hint while nothing is loaded');
    eq(await switchState('Headphone correction'), 'false', 'off by default'); eq(await btnDisplay('Clear'), 'none', 'Clear hidden with no profile');
    // the spec's two-filter paste through the debug accessor
    eq(await dbg(`return d.pasteAutoEq(${JSON.stringify(AUTOEQ_2)});`), true, 'paste accepted'); await sleep(150);
    let peq = await get('peq');
    eq(peq.length, 2, 'two filters'); eq(peq[0].t + '/' + peq[0].f + '/' + peq[0].g + '/' + peq[0].q, 'PK/105/3.1/0.7', 'filter 1'); eq(peq[1].t + '/' + peq[1].f + '/' + peq[1].g + '/' + peq[1].q, 'HSC/10000/-2/0.7', 'filter 2 (default Q 0.7)');
    eq(await get('peqOn'), true, 'peqOn set'); eq(await get('peqPreamp'), -6, 'preamp parsed'); eq(await get('peqName'), 'AutoEQ profile', 'no name line → AutoEQ profile');
    let s = await snap();
    eq(s.params.peq[0].frequency, 105, 'peq[0] 105 Hz'); approx(s.params.peq[0].gain, 3.1, 0.01, 'peq[0] +3.1 dB'); eq(s.params.peq[0].type, 'peaking', 'peq[0] peaking'); approx(s.params.peq[0].Q, 0.7, 0.001, 'peq[0] Q');
    eq(s.params.peq[1].type, 'highshelf', 'peq[1] highshelf'); eq(s.params.peq[1].frequency, 10000, 'peq[1] 10 kHz'); approx(s.params.peq[1].gain, -2, 0.01, 'peq[1] −2 dB');
    for (let i = 2; i < 10; i++) { eq(s.params.peq[i].gain, 0, 'peq[' + i + '] inert'); eq(s.params.peq[i].type, 'peaking', 'peq[' + i + '] peaking'); }
    eq(await dbg(`return d.headroomDb;`), 0, 'a profile carrying its own preamp needs no extra headroom');
    approx(s.params.preamp.gain, Math.pow(10, -6 / 20), 0.002, 'preamp = 10^(−6/20)');
    eq(guardOn(s), true, 'the guard is engaged while peqOn'); eq(s.routed, true, 'routed');
    const c = await dbg(`return d.composite(105);`); approx(c.peqDb[0], 3.1, 0.4, 'probe bank: the AutoEQ composite at 105 Hz');
    eq(await toggleDesc('Headphone correction'), 'AutoEQ profile · 2 filters (shelf Q ignored)', 'row shows the profile (a shelf → its Q is ignored)');
    eq(await switchState('Headphone correction'), 'true', 'switch repainted on'); eq(await btnDisplay('Clear'), '', 'Clear shown');
    // the 12-filter profile: ten kept, the two smallest |g| dropped, frequency ascending, the OFF line skipped, LS → LSC
    eq(await dbg(`return d.pasteAutoEq(${JSON.stringify(AUTOEQ_12)});`), true, '12-filter paste accepted'); await sleep(150);
    peq = await get('peq');
    eq(peq.length, 10, 'ten filters kept');
    eq(peq.map((f) => f.f).join(','), '40,105,500,1000,2500,4800,6000,8000,10000,16000', 'frequency ascending, 210 / 3300 Hz dropped, 12 kHz (OFF) skipped');
    eq(peq.map((f) => f.t).join(','), 'PK,LSC,PK,PK,PK,PK,PK,PK,HSC,PK', 'LS → LSC'); eq(peq[0].q, 0.7, 'q kept'); eq(peq[4].q, 1.1, 'q kept (2500 Hz)');
    eq(await get('peqName'), 'Sony WH-1000XM4', 'the name line'); eq(await get('peqPreamp'), -5.5, 'preamp −5.5');
    s = await snap();
    eq(s.params.peq[1].type, 'lowshelf', 'LSC → lowshelf'); eq(s.params.peq[9].frequency, 16000, 'the treble filter survived'); approx(s.params.peq[9].gain, 5, 0.01, '+5 dB at 16 kHz');
    eq(await toggleDesc('Headphone correction'), 'Sony WH-1000XM4 · 10 filters (shelf Q ignored)', 'row copy with a name');
    // peqOn off: every filter reads 0 dB, the preamp fold goes with it, the profile stays loaded
    await set('peqOn', false); s = await snap();
    for (let i = 0; i < 10; i++) eq(s.params.peq[i].gain, 0, 'peq[' + i + '] gain 0 with peqOn off');
    eq(s.params.preamp.gain, 1, 'preamp back to unity'); eq(guardOn(s), false, 'guard released');
    eq(await switchState('Headphone correction'), 'false', 'switch repainted off'); eq((await get('peq')).length, 10, 'profile kept');
    await set('peqOn', true); s = await snap(); approx(s.params.peq[9].gain, 5, 0.01, 'back on');
    // the tab: Paste AutoEQ opens the box (Apply / Cancel under it), Cancel closes it, junk is refused and keeps it open
    let b = await boxState(0); eq(b.display, 'none', 'box hidden'); eq(b.act, 'none', 'actions hidden');
    await btnClick('Paste AutoEQ'); b = await boxState(0);
    eq(b.display, 'block', 'box opens'); eq(b.act, 'flex', 'Apply / Cancel shown'); eq(b.actBtns, 'Apply,Cancel', 'the two buttons'); eq(b.focused, true, 'box focused');
    eq(b.ph, 'Preamp: -6.2 dB\nFilter 1: ON PK Fc 105 Hz Gain 3.1 dB Q 0.7 …', 'placeholder');
    assert(/height: 96px/.test(b.css) && /resize: vertical/.test(b.css) && /border-radius: 10px/.test(b.css) && /padding: 10px 12px/.test(b.css), 'the preset select\'s clothes + height 96 / resize vertical');
    await boxBtn(0, 'Cancel'); b = await boxState(0); eq(b.display, 'none', 'Cancel hides it'); eq(b.act, 'none', 'actions hidden again');
    await btnClick('Paste AutoEQ'); await boxType(0, 'hello there, no filters here'); await boxBtn(0, 'Apply'); await sleep(120);
    eq(await toastText(), 'No filters found in that text', 'junk refused'); eq((await boxState(0)).display, 'block', 'box stays open after a refusal');
    eq((await get('peq')).length, 10, 'profile untouched by the refusal');
    await boxType(0, 'Test cans\nFilter 1: ON PK Fc 2000 Hz Gain -3.0 dB Q 1.00'); await boxBtn(0, 'Apply'); await sleep(150);
    b = await boxState(0); eq(b.display, 'none', 'Apply closes the box'); eq(b.value, '', 'box cleared');
    peq = await get('peq'); eq(peq.length, 1, 'one filter'); eq(peq[0].f, 2000, '2 kHz'); eq(await get('peqPreamp'), 0, 'no Preamp line → 0');
    eq(await toggleDesc('Headphone correction'), 'Test cans · 1 filter', 'singular, no shelf note');
    s = await snap(); approx(s.params.peq[0].gain, -3, 0.01, 'in the chain'); eq(s.params.peq[9].gain, 0, 'the old treble filter gone');
    // Clear: bank empty, switch off, hint back, params inert
    await btnClick('Clear'); await sleep(150);
    eq(await toastText(), 'Headphone profile cleared', 'clear toast');
    eq((await get('peq')).length, 0, 'peq empty'); eq(await get('peqOn'), false, 'peqOn off'); eq(await get('peqName'), '', 'name cleared');
    eq(await toggleDesc('Headphone correction'), 'Paste an AutoEQ profile for your headphones', 'hint again'); eq(await btnDisplay('Clear'), 'none', 'Clear hidden');
    s = await snap(); for (let i = 0; i < 10; i++) eq(s.params.peq[i].gain, 0, 'peq[' + i + '] inert after Clear'); eq(s.params.preamp.gain, 1, 'preamp unity');
    // the switch with nothing loaded stays off and opens the paste box instead (routing an empty bank would do nothing)
    eq(await switchClick('Headphone correction'), 'false', 'the switch stays off with nothing loaded'); eq((await boxState(0)).display, 'block', 'the box opens for an empty bank');
    eq(await get('peqOn'), false, 'peqOn untouched'); await boxBtn(0, 'Cancel'); eq((await boxState(0)).display, 'none', 'Cancel closes it'); await sleep(120);
    await closeHub(); await sleep(150); s = await snap(); eq(s.routed, false, 'nothing on, tab closed → detached');
    await stopPlay();
  });

  scenario('copy-paste-reset', async () => {
    // 2.22: Copy puts { v, audio, loudMem } on the clipboard (recorded for the test); Paste validates + clamps
    // every key, ignores unknown ones, keeps a key of the wrong shape, restores the loudness memory, re-renders;
    // either box routes JSON / AutoEQ by its first character; Reset all audio restores every default, clears
    // the loudness memory, keeps saved presets, re-renders, and leaves the chain detached once the tab closes
    await play('A', { loop: true });
    await audioTab();
    await set('bassDb', 3); await set('tiltDb', 1.5); await set('speed', 150);
    await dbg(`d.gm('loud:bytrack', { '/test/track-a': { l: -16.2, p: 0.5, s: 30, d: 120, t: 1, f: 1 } });`);
    await btnClick('Copy settings'); await sleep(120);
    eq(await toastText(), 'Audio settings copied', 'copy toast');
    const clipS = await dbg(`return d.lastClip();`);
    let obj = null; try { obj = JSON.parse(clipS); } catch (e) {}
    assert(obj && typeof obj === 'object', 'the clipboard text parses');
    eq(obj.v, 1, 'payload version'); eq(obj.audio.bassDb, 3, 'audio.bassDb 3'); eq(obj.audio.tiltDb, 1.5, 'audio.tiltDb'); eq(obj.audio.speed, 150, 'audio.speed');
    eq(Object.keys(obj.audio).length, 41, 'every AUDIO_KEYS entry (37 + eqPerTrack, bassHarm, skipSilence, reverbAmt)');
    for (const k of ['speed', 'speedPerTrack', 'eqOn', 'eqBands', 'eqPreamp', 'eqCustom', 'eqAutoPre', 'peqOn', 'peq', 'peqPreamp', 'peqName', 'stereoWidth', 'fadeOut', 'vinylMode', 'loopTrack', 'rememberVol']) assert(k in obj.audio, 'audio.' + k + ' present');
    eq(obj.loudMem['/test/track-a'].l, -16.2, 'loudMem exported');
    // change things, then paste a tampered copy
    await set('bassDb', 0); await set('tiltDb', 0); await dbg(`d.loudMemClear();`);
    const tp = JSON.parse(clipS);
    tp.audio.bassDb = 50; tp.audio.eqBands = [20, -20, 'x', 1, 2, 3, 4, 5, 6, 7, 8, 9]; tp.audio.tiltDb = 'abc'; tp.audio.bogus = 1; tp.audio.stereoWidth = 999;
    tp.audio.crossfeedMode = 'wild'; tp.audio.peqName = 'x'.repeat(80); tp.audio.eqCustom = null; tp.audio.speed = 100;
    tp.audio.peq = [{ t: 'LS', f: 5, g: 40, q: 99 }, 'junk', { t: 'HSC', f: 12000, g: -1, q: 0.5 }];
    tp.loudMem = { '/test/track-a': { l: -16.2, p: 0.5, s: 30, d: 120, t: 1, f: 1 }, '/bad': 'str', __proto__: { l: -10 }, '/other': { l: -99, p: 9, s: -5, d: 60, t: 2, f: 0 } };
    let b = await boxState(1); eq(b.display, 'none', 'footer box hidden'); eq(b.actBtns, 'Apply,Cancel', 'Apply / Cancel under it');
    await btnClick('Paste settings'); b = await boxState(1); eq(b.display, 'block', 'Paste settings opens the box'); eq(b.focused, true, 'focused');
    await boxType(1, JSON.stringify(tp)); await boxBtn(1, 'Apply'); await sleep(250);
    eq(await toastText(), 'Audio settings pasted', 'paste toast');
    eq(await get('bassDb'), 9, 'bassDb clamped to 9'); eq((await get('eqBands')).join(','), '12,-12,0,1,2,3,4,5,6,7', 'eqBands clamped element-wise, length 10');
    eq(await get('tiltDb'), 0, 'a wrong-shape key keeps its value'); eq(await get('bogus'), undefined, 'unknown key ignored');
    eq(await get('stereoWidth'), 200, 'stereoWidth clamped'); eq(await get('crossfeedMode'), 'natural', 'bad enum → default'); eq((await get('peqName')).length, 40, 'peqName capped');
    const peq = await get('peq');
    eq(JSON.stringify(peq), JSON.stringify([{ t: 'PK', f: 20, g: 15, q: 10 }, { t: 'HSC', f: 12000, g: -1, q: 0.5 }]), 'peq entries re-validated through the PEQ clamps, junk dropped');
    const mem = await dbg(`return d.loudMem();`);
    eq(Object.keys(mem).sort().join(','), '/other,/test/track-a', 'loudMem restored, the bad entry dropped'); eq(mem['/test/track-a'].l, -16.2, 'entry intact'); eq(mem['/other'].l, -70, 'entry clamped');
    eq(typeof (await get('eqCustom')), 'object', 'eqCustom null → kept as an object');
    eq(await headerTitle(), 'Equalizer', 'tab re-rendered'); eq((await boxState(1)).display, 'none', 'box hidden after the re-render');
    eq((await sliderByLabel('Bass')).value, '9', 'the Bass row shows the pasted value'); eq(await get('speed'), 100, 'speed pasted');
    let s = await snap(); eq(s.params.bass.gain, 9, 'bass in the chain'); eq(s.params.widener.gain, 2, 'width in the chain');
    // garbage JSON is refused and keeps the box open; an object without `audio` too
    await btnClick('Paste settings'); await boxType(1, '{not json'); await boxBtn(1, 'Apply'); await sleep(120);
    eq(await toastText(), 'That isn’t audio settings JSON', 'garbage refused'); eq((await boxState(1)).display, 'block', 'box stays open');
    await boxType(1, '{"hello": 1}'); await boxBtn(1, 'Apply'); await sleep(120); eq(await toastText(), 'That isn’t audio settings JSON', 'no audio block refused');
    // routing: the footer box takes an AutoEQ profile, the AutoEQ box takes settings JSON
    await boxType(1, 'Filter 1: ON PK Fc 300 Hz Gain 2.0 dB Q 1.00'); await boxBtn(1, 'Apply'); await sleep(150);
    eq((await get('peq')).length, 1, 'AutoEQ text in the footer box → the AutoEQ parser'); eq((await get('peq'))[0].f, 300, '300 Hz'); eq(await get('peqOn'), true, 'peqOn');
    await btnClick('Paste AutoEQ'); await boxType(0, '{"v":1,"audio":{"bassDb":2,"peqOn":false}}'); await boxBtn(0, 'Apply'); await sleep(250);
    eq(await toastText(), 'Audio settings pasted', 'JSON in the AutoEQ box → the settings importer'); eq(await get('bassDb'), 2, 'bassDb 2'); eq(await get('peqOn'), false, 'peqOn false');
    // Reset all audio: every key back to its default, saved presets kept, loudness memory cleared, tab rebuilt
    await dbg(`d.set('eqCustom', { Mine: { b: [1, 2, 3, 0, 0, 0, 0, 0, 0, 0], pre: -1 } });`);
    await set('speed', 150); await set('nightOn', true);
    await btnClick('Reset all audio'); await sleep(250);
    const rt = await toastText(); assert(/loudness memory cleared/.test(rt || ''), 'reset toast (got ' + JSON.stringify(rt) + ')'); eq(rt, 'Audio reset · track loudness memory cleared', 'exact reset toast');
    eq(await get('bassDb'), 0, 'bassDb 0'); eq(await get('stereoWidth'), 100, 'stereoWidth 100'); eq((await get('peq')).length, 0, 'peq empty'); eq(await get('peqName'), '', 'peqName empty');
    eq((await get('eqBands')).join(','), '0,0,0,0,0,0,0,0,0,0', 'bands flat'); eq(await get('nightOn'), false, 'nightOn off'); eq(await get('speed'), 100, 'speed 100'); eq(await dbg(`return d.rate();`), 1, 'rate 1');
    eq(await get('crossfeedMode'), 'natural', 'crossfeedMode default'); eq(await get('limiterOn'), true, 'limiterOn default true'); eq(await get('eqAutoPre'), true, 'eqAutoPre default');
    eq(JSON.stringify(await dbg(`return d.loudMem();`)), '{}', 'loudness memory cleared');
    eq(JSON.stringify(await get('eqCustom')), JSON.stringify({ Mine: { b: [1, 2, 3, 0, 0, 0, 0, 0, 0, 0], pre: -1 } }), 'saved presets survive a reset');
    eq(await headerTitle(), 'Equalizer', 'tab re-rendered'); eq((await sliderByLabel('Bass')).value, '0', 'Bass row reads 0'); eq(await switchState('Night mode'), 'false', 'Night switch off');
    s = await snap(); eq(s.params.bass.gain, 0, 'bass inert'); eq(s.params.comp.ratio, 1, 'comp inert'); eq(s.routed, true, 'still routed while the tab is open');
    await closeHub(); await sleep(150); s = await snap(); eq(s.routed, false, 'tab closed → detached');
    await stopPlay();
  });

  /* ── WP8 helpers: the output gain as heard, the fixture's clock, the tempo chips, the bar pill ── */
  const outGain = () => dbg(`return d.params && d.params.output ? d.params.output.gain : null;`);
  const curTime = () => elProp('currentTime');
  const gainAt = () => page.evaluate(() => { const d = window.__sceAudioDebug(); const el = window.__afx.el(); return { g: d.params.output.gain, t: el.currentTime, paused: el.paused }; });
  const waitCur = async (t, maxMs) => { const t0 = Date.now(); for (;;) { const c = await curTime(); if (c >= t) return c; if (Date.now() - t0 > (maxMs || 15000)) throw new AssertError('fixture never reached ' + t + ' s (at ' + c + ')'); await sleep(40); } };
  const tempoInfo = () => abody(`return [...a.querySelectorAll('button')].filter((b) => /^(0\.5|0\.75|1|1\.25|1\.5|2)×$/.test(b.textContent)).map((b) => ({ txt: b.textContent, bg: b.style.background, color: b.style.color, flex: b.style.flex, padding: b.style.padding, gap: b.parentElement.style.gap }));`);
  const barPill = () => page.evaluate(() => { const p = document.querySelector('.sce-barwrap .sce-speed'); return p ? p.textContent : null; });
  const rowOpacity = (label) => abody(`const r = [...a.querySelectorAll('input[type=range]')].find((x) => x.parentElement.firstChild.textContent === ${JSON.stringify(label)}); return r ? r.parentElement.style.opacity : null;`);

  scenario('speed-tab', async () => {
    // 2.19 + 2.20: Speed 50..200 step 5 right under the Listening on chips, six tempo chips (the lit one = the current
    // speed), the element's playbackRate follows within 200 ms, the bar pill mirrors it; Pitch follows speed flips
    // preservesPitch on the element and, while it is on, shows the semitone shift (12·log2(rate)) in its description
    await play('A', { loop: true });
    await audioTab();
    const order = (await sectionOrder()).filter((t) => !/^(Tempo |Listening for th|No scenes saved|Scenes ·)/.test(t));   // the tempo line and the scenes row are their own rows; the order below is about the controls
    const iP = order.indexOf('Playback');
    assert(iP > 0, 'Playback section present');
    rowStarts(order, iP - 1, 'HeadphonesLaptop'); rowStarts(order, iP + 1, 'Speed'); rowStarts(order, iP + 2, '0.5×0.75×1×1.25'); rowStarts(order, iP + 3, 'Pitch follows sp');
    rowStarts(order, iP + 4, 'Reverb'); rowStarts(order, iP + 5, 'Slowed + reverb'); rowStarts(order, iP + 6, 'Fade in / out'); rowStarts(order, iP + 7, 'Fade in'); rowStarts(order, iP + 8, 'Fade out'); rowStarts(order, iP + 9, 'Skip silent endi'); rowStarts(order, iP + 10, 'Tone');
    let r = await sliderByLabel('Speed');
    eq(r.min + '..' + r.max + '/' + r.step, '50..200/5', 'speed range'); eq(r.val, '1×', '1× at 100'); assert(/double-click resets/.test(r.title), 'speed reset hint');
    let chips = await tempoInfo();
    eq(chips.map((c) => c.txt).join(','), '0.5×,0.75×,1×,1.25×,1.5×,2×', 'six tempo chips');
    assert(chips.every((c) => /^1( 1 0%)?$/.test(c.flex) && c.padding === '8px 0px' && c.gap === '6px'), 'chips flex:1 · padding 8px 0 · gap 6px (got ' + JSON.stringify(chips[0]) + ')');
    eq(chips[2].bg + '|' + chips[2].color, TINT.bg + '|' + TINT.color, 'the 1× chip lit'); assert(chips.filter((c) => c.bg === TINT.bg).length === 1, 'one chip lit');
    // the 1.5× chip
    await btnClick('1.5×'); await sleep(200);
    eq(await get('speed'), 150, 'CFG.speed 150'); eq(await elProp('playbackRate'), 1.5, 'element playbackRate 1.5 within 200 ms');
    eq(await dbg(`return d.rate();`), 1.5, 'SUITE.audioRate 1.5');
    eq(await barPill(), '1.5×', 'the player-bar pill reads 1.5×');
    r = await sliderByLabel('Speed'); eq(r.value, '150', 'the slider follows the chip'); eq(r.val, '1.5×', 'value 1.5×');
    chips = await tempoInfo(); eq(chips[4].bg, TINT.bg, '1.5× chip lit'); assert(chips.filter((c) => c.bg === TINT.bg).length === 1, 'only that one');
    eq(await toggleDesc('Pitch follows speed'), 'Vinyl / tape feel · slowed sounds deeper, sped-up sounds higher', 'no semitone figure while pitch is preserved');
    await set('vinylMode', true);
    eq(await toggleDesc('Pitch follows speed'), 'Vinyl / tape feel · slowed sounds deeper, sped-up sounds higher · +7.0 semitones', 'semitones at 1.5× once pitch follows (12·log2 1.5 = 7.02)');
    // the 0.5× chip
    await btnClick('0.5×'); await sleep(200);
    eq(await get('speed'), 50, 'CFG.speed 50'); eq(await elProp('playbackRate'), 0.5, 'element 0.5'); eq(await barPill(), '0.5×', 'pill 0.5×');
    eq(await toggleDesc('Pitch follows speed'), 'Vinyl / tape feel · slowed sounds deeper, sped-up sounds higher · −12.0 semitones', 'an octave down at 0.5×');
    // the slider: 85 → 0.85×, −2.8 semitones (12·log2 0.85 = −2.81; the spec's "−2.9" is a rounding slip)
    await sliderSet('Speed', 85); await sleep(200);
    eq(await get('speed'), 85, 'slider writes CFG.speed'); eq(await elProp('playbackRate'), 0.85, 'element 0.85'); eq((await sliderByLabel('Speed')).val, '0.85×', 'value 0.85×');
    chips = await tempoInfo(); assert(chips.every((c) => c.bg === PLAIN.bg), 'no chip lit off a stop');
    assert(/−2\.8 semitones$/.test(await toggleDesc('Pitch follows speed')), 'the vinyl row reads −2.8 semitones at 0.85× (got ' + JSON.stringify(await toggleDesc('Pitch follows speed')) + ')');
    // pitch follows speed: preservesPitch on the element, immediately, both ways; the figure leaves with the mode
    await set('vinylMode', false); eq(await toggleDesc('Pitch follows speed'), 'Vinyl / tape feel · slowed sounds deeper, sped-up sounds higher', 'the figure leaves with the mode');
    eq(await elProp('preservesPitch'), true, 'preservesPitch true with the mode off');
    await set('vinylMode', true); eq(await elProp('preservesPitch'), false, 'vinylMode → preservesPitch false');
    eq(await switchState('Pitch follows speed'), 'true', 'the switch follows a debug write');
    await set('vinylMode', false); eq(await elProp('preservesPitch'), true, 'off → true again');
    eq(await switchClick('Pitch follows speed'), 'true', 'switch on'); await sleep(60); eq(await elProp('preservesPitch'), false, 'the switch flips the element at once');
    assert(/−2\.8 semitones$/.test(await toggleDesc('Pitch follows speed')), 'the switch click paints the figure at once');
    eq(await switchClick('Pitch follows speed'), 'false', 'switch off'); await sleep(60); eq(await elProp('preservesPitch'), true, 'restored');
    // a new element inherits the mode
    await set('vinylMode', true); await play('A', { loop: true }); eq(await elProp('preservesPitch'), false, 'a freshly captured element gets preservesPitch false'); eq(await elProp('playbackRate'), 0.85, 'and the speed');
    await set('vinylMode', false);
    // label double-click → 1×, description back to the plain copy
    await sliderReset('Speed'); await sleep(200);
    eq(await get('speed'), 100, 'double-click → 100'); eq(await elProp('playbackRate'), 1, 'element 1'); eq(await barPill(), '1×', 'pill 1×');
    eq(await toggleDesc('Pitch follows speed'), 'Vinyl / tape feel · slowed sounds deeper, sped-up sounds higher', 'no semitone suffix at 1×');
    // speed is not an effect: with everything else off the chain detaches when the tab closes
    await btnClick('1.25×'); await closeHub(); await sleep(150); const s = await snap(); eq(s.routed, false, 'detached'); eq(await elProp('playbackRate'), 1.25, 'speed stays');
    await set('speed', 100); await dbg(`d.applySpeed();`); await stopPlay();
  });

  scenario('bpm-detect', async () => {
    // tempo: a 128 BPM kick pattern is measured within ~30 s of the chain being routed, the figure is the track's own even
    // at 1.25×, and it is remembered per track
    await play('K', { loop: true, href: '/test/bpm' });
    await audioTab(); await sleep(30000);
    let b = await dbg(`return d.bpm();`);
    assert(b && Math.abs(b.bpm - 128) < 2, 'detected ≈ 128 BPM (got ' + JSON.stringify(b) + ', diag ' + JSON.stringify(await dbg(`return d.bpmDiag();`)) + ')');
    eq(b.src, 'measured', 'measured, not remembered');
    const line = await abody(`const el = [...a.querySelectorAll('div')].find((d) => /^Tempo ≈/.test(d.textContent)); return el ? el.textContent : null;`);
    assert(line && /Tempo ≈ 12[78](\.\d)? BPM/.test(line), 'the Audio tab shows it (got ' + JSON.stringify(line) + ')');
    await set('speed', 125); await sleep(40000);
    b = await dbg(`return d.bpm();`);
    assert(b && Math.abs(b.bpm - 128) < 3, 'still the track\'s own tempo at 1.25× (got ' + JSON.stringify(b) + ')');
    const mem = await dbg(`return d.gm('enh:bpm');`);
    assert(mem && mem['/test/bpm'] && Math.abs(mem['/test/bpm'].b - 128) < 3, 'remembered per track');
    await set('speed', 100); await stopPlay();
    // a steady tone has no beat: the estimator must stay silent rather than confidently number the noise
    await play('A', { loop: true, href: '/test/tone' }); await sleep(26000);
    b = await dbg(`return d.bpm();`);
    assert(!b, 'no tempo on a steady tone (got ' + JSON.stringify(b) + ')');
    await closeHub(); await stopPlay();
  });

  scenario('tempo-lock', async () => {
    // the palette's "170 bpm": once the tempo is known the speed follows (lock ÷ tempo, 0.5×–2×), the estimator keeps
    // reporting the track's own tempo under the new rate, a remembered tempo applies the lock at once on the next
    // play, and turning the lock off leaves the speed where it is
    await play('K', { loop: true, href: '/test/lock' });
    await audioTab(); await sleep(30000);
    let b = await dbg(`return d.bpm();`);
    assert(b && Math.abs(b.bpm - 128) < 2, 'tempo known first (got ' + JSON.stringify(b) + ')');
    await dbg(`d.audioCmd('tempoLock', 160);`); await sleep(600);
    eq(await get('speed'), 125, 'speed = 160 / 128'); approx(await elProp('playbackRate'), 1.25, 0.01, 'element rate follows');
    const line = await abody(`const el = [...a.querySelectorAll('div')].find((d) => /^Tempo ≈/.test(d.textContent)); return el ? el.textContent : null;`);
    assert(line && /locked to 160 BPM/.test(line), 'the Audio tab says so (got ' + JSON.stringify(line) + ')');
    await sleep(30000);
    b = await dbg(`return d.bpm();`);
    assert(b && Math.abs(b.bpm - 128) < 3, 'still the track\'s own tempo under the lock (got ' + JSON.stringify(b) + ')');
    eq(await get('speed'), 125, 'speed unchanged by the re-estimate');
    await dbg(`d.audioCmd('tempoLock', 96);`); await sleep(600);
    eq(await get('speed'), 75, 'a new lock re-sets the speed (96 / 128)');
    await dbg(`d.audioCmd('tempoLock', 0);`); await sleep(600);
    eq(await get('speed'), 75, 'lock off keeps the speed'); eq(await get('tempoLock'), 0, 'lock cleared');
    await stopPlay(); await closeHub();
  });

  scenario('fades', async () => {
    // 2.21: fixture C (10 s) with fadeOn, fadeIn 0.6, fadeOut 2.5 — the output gain fades in on `playing`, ≈ 1 by 2 s,
    // fades out into the last 2.5 s, a seek restores unity within 100 ms, a pause + play resumes with a short fade;
    // the suite's own seeks never dip; the fade-out is shortened in proportion at 2×; the rows dim while off
    await audioTab();
    let r = await sliderByLabel('Fade in'); eq(r.min + '..' + r.max + '/' + r.step, '0..3/0.1', 'fade-in range'); eq(r.val, '0.6 s', '0.6 s');
    r = await sliderByLabel('Fade out'); eq(r.min + '..' + r.max + '/' + r.step, '0..8/0.1', 'fade-out range'); eq(r.val, '2.5 s', '2.5 s');
    eq(await toggleDesc('Fade in / out'), 'Smooth the gap between tracks', 'fade copy');
    eq(await rowOpacity('Fade in') + '|' + await rowOpacity('Fade out'), '0.45|0.45', 'both length rows dimmed while off');
    await sliderSet('Fade in', 1); await sleep(200);
    eq(await get('fadeOn'), true, 'touching a length turns the fade on'); eq(await get('fadeIn'), 1, 'fadeIn 1'); eq(await switchState('Fade in / out'), 'true', 'switch painted on');
    eq(await rowOpacity('Fade in') + '|' + await rowOpacity('Fade out'), '1|1', 'rows lit');
    await sliderReset('Fade in'); await sleep(200); eq(await get('fadeIn'), 0.6, 'double-click → 0.6');
    eq(await switchClick('Fade in / out'), 'false', 'switch off'); await sleep(100); eq(await rowOpacity('Fade in'), '0.45', 'dimmed again');
    await set('fadeOut', 2.5); await set('fadeOn', true); eq(await rowOpacity('Fade out'), '1', 'a debug write repaints the rows');
    await closeHub();
    // fade in on `playing`: read right after play() resolves (audio flowing), well inside the ramp
    await fixtures();
    await page.evaluate(() => window.__afx.play('C', { href: '/test/track-c' }));
    await sleep(120);
    let g = await gainAt();
    assert(g.t < 0.45, 'read inside the ramp (at ' + g.t + ' s)'); assert(g.g < 0.6, 'gain < 0.6 at ' + g.t.toFixed(2) + ' s (got ' + g.g + ')'); assert(g.g >= 0.04, 'never below the floor (got ' + g.g + ')');
    let s = await snap(); eq(s.routed, true, 'routed for the fade');
    await waitCur(2); g = await gainAt(); approx(g.g, 1, 0.02, 'gain ≈ 1 at ' + g.t.toFixed(2) + ' s');
    await waitCur(4); g = await gainAt(); approx(g.g, 1, 0.005, 'still 1 at 4 s'); eq((await dbg(`return d.fade();`)).outScheduled, false, 'no fade-out yet');
    // fade out into the last 2.5 s
    await waitCur(9.5); g = await gainAt(); assert(g.g < 0.3, 'gain < 0.3 at ' + g.t.toFixed(2) + ' s (got ' + g.g + ')'); eq((await dbg(`return d.fade();`)).outScheduled, true, 'fade-out scheduled');
    // a seek out of the window restores unity within 100 ms and re-arms the fade-out
    await dbg(`d.seek(5);`); await sleep(100); g = await gainAt(); approx(g.g, 1, 0.02, 'seek to 5 s → ≈ 1 within 100 ms (at ' + g.t.toFixed(2) + ')');
    eq((await dbg(`return d.fade();`)).outScheduled, false, 'fade-out cleared by the seek');
    // pause + play: a short resume fade, back at 1 within 250 ms
    await page.evaluate(() => window.__afx.el().pause()); await sleep(150);
    await page.evaluate(() => window.__afx.el().play()); await sleep(250); g = await gainAt();
    assert(g.g >= 0.98, 'resume: gain back at 1 within 250 ms (got ' + g.g + ' at ' + g.t.toFixed(2) + ')'); eq(g.paused, false, 'playing');
    // the suite's own seeks (restart / nudge / seekPct) never dip the level
    await dbg(`d.nudgeSeek(-2);`); await sleep(80); g = await gainAt(); approx(g.g, 1, 0.01, 'nudge: no dip'); assert(g.t < 4.5, 'nudged back (at ' + g.t.toFixed(2) + ')');
    await dbg(`d.restartTrack();`); await sleep(60); g = await gainAt(); approx(g.g, 1, 0.01, 'restart: no dip at ' + g.t.toFixed(2) + ' s'); await sleep(300); g = await gainAt(); approx(g.g, 1, 0.01, 'and still none');
    await dbg(`d.seekPct(0.5);`); await sleep(80); g = await gainAt(); approx(g.g, 1, 0.01, 'seekPct: no dip');
    // a new track on the same element (the badge changes while playing) fades in once
    await page.evaluate(() => window.__afx.anchor('/test/track-c2')); await sleep(1300); g = await gainAt(); approx(g.g, 1, 0.01, 'the href change alone (mid-track) does not dip');
    // the fade-out is divided by the playback rate: at 2× it is ≈ 1.3 s of wall clock, so by 8.6 s the gain is well down
    await set('speed', 200); await dbg(`d.applySpeed();`); eq(await elProp('playbackRate'), 2, 'element at 2×');
    await dbg(`d.seek(6.5);`); await sleep(100); g = await gainAt(); approx(g.g, 1, 0.02, 'unity after the seek at 2×');
    await waitCur(9.0); g = await gainAt(); assert(g.t < 9.4, 'read near 9 s (at ' + g.t.toFixed(2) + ')'); assert(g.g < 0.3, 'at 2× the fade-out runs at twice the pace: gain < 0.3 at ' + g.t.toFixed(2) + ' s (got ' + g.g.toFixed(3) + ')');
    const fo = (await dbg(`return d.fade();`)).out;
    assert(fo && fo.rate === 2 && fo.at >= 7.2 && fo.at <= 7.8, 'scheduled on entering the window at 2× (got ' + JSON.stringify(fo) + ')');
    approx(fo.remain, (fo.dur - fo.at) / 2, 0.005, 'the ramp length is the remaining time divided by the rate');
    await set('speed', 100); await dbg(`d.applySpeed();`);
    // off: unity at once, and the chain detaches when nothing else is on
    await set('fadeOn', false); g = await gainAt(); eq(g.g, 1, 'fade off → unity'); s = await snap(); eq(s.routed, false, 'detached');
    await stopPlay();
  });

  scenario('capture-hygiene', async () => {
    // 2.31: a raw buffer source is only rate-forced at start() and only for real tracks (> 30 s); the captured-element
    // set stays bounded (a paused element is dropped past eight)
    await play('A', { loop: true });
    await set('speed', 150); await dbg(`d.applySpeed();`);
    eq(await elProp('playbackRate'), 1.5, 'element at 1.5');
    const bs = await page.evaluate(() => {
      const ctx = window.__afx.ctx();
      const mk = (secs) => { const n = ctx.createBufferSource(); n.buffer = ctx.createBuffer(2, Math.round(ctx.sampleRate * secs), ctx.sampleRate); return n; };
      const a = mk(0.5), b = mk(40), c = mk(0.5);
      const before = [a.playbackRate.value, b.playbackRate.value];
      a.start(); b.start();
      const after = [a.playbackRate.value, b.playbackRate.value];
      const noStart = c.playbackRate.value;
      try { a.stop(); b.stop(); } catch (e) {}
      return { before, after, noStart };
    });
    eq(bs.before.join(','), '1,1', 'no rate written at creation (blip 0.5 s, track 40 s)');
    eq(bs.after[0], 1, 'a 0.5 s buffer is never pitch-shifted (start)'); eq(bs.after[1], 1.5, 'a 40 s buffer follows the speed at start');
    eq(bs.noStart, 1, 'an unstarted node stays at 1');
    // the applySpeed loop applies the same guard
    const loop = await page.evaluate(() => {
      const ctx = window.__afx.ctx();
      const mk = (secs) => { const n = ctx.createBufferSource(); n.buffer = ctx.createBuffer(2, Math.round(ctx.sampleRate * secs), ctx.sampleRate); return n; };
      const a = mk(0.5), b = mk(40);
      window.__sceAudioDebug().applySpeed();
      const r = [a.playbackRate.value, b.playbackRate.value];
      try { a.disconnect(); b.disconnect(); } catch (e) {}
      return r;
    });
    eq(loop.join(','), '1,1.5', 'applySpeed: short buffer untouched, long buffer at 1.5');
    await set('speed', 100); await dbg(`d.applySpeed();`);
    // the set of captured elements is bounded: twelve idle `new Audio()`s leave at most eight behind
    const cap = await page.evaluate(() => { for (let i = 0; i < 12; i++) new Audio(); return window.__sceAudioDebug().status(); });
    assert(cap.cap <= 8, 'captured set bounded at 8 (got ' + cap.cap + ')');
    eq(await elProp('paused'), false, 'the playing fixture survives the pruning');
    // the bound must not become a listener loop: ten paused <audio> elements IN the document are re-scanned by the
    // 1 Hz enforce tick; a pruned one that is re-captured rejoins the set without registering its listeners again
    const n1 = await page.evaluate(() => {
      window.__capN = 0; window.__capEls = [];
      for (let i = 0; i < 10; i++) {
        const a = document.createElement('audio');
        a.addEventListener = function (t, f, o) { window.__capN++; return HTMLMediaElement.prototype.addEventListener.call(this, t, f, o); };
        document.body.appendChild(a); window.__capEls.push(a);
      }
      return window.__capN;
    });
    eq(n1, 0, 'nothing registered before the scan');
    await sleep(1500);
    const n2 = await page.evaluate(() => window.__capN);
    // per-element listener count read off captureMedia itself (rate/play/playing/loadeddata/playing(loudness) + 3 A–B re-aims
    // (2.28) + 6 fade hooks (2.21) = 14 today), so the check follows the code instead of a literal that goes stale
    const perEl = (() => { const s = fs.readFileSync(path.join(EXT, 'js', 'suite.js'), 'utf8'); const i = s.indexOf('function captureMedia(m) {'); const j = s.indexOf('\n  function syncPitch', i); return i < 0 || j < 0 ? -1 : (s.slice(i, j).match(/m\.addEventListener\(/g) || []).length; })();
    assert(perEl >= 10, 'captureMedia registers its listeners per element (counted ' + perEl + ')');
    eq(n2, 10 * perEl, 'the scan captured the ten elements exactly once (' + perEl + ' listeners each)');
    await sleep(3200);
    const n3 = await page.evaluate(() => window.__capN);
    eq(n3, n2, 'listener count flat after 3 s of ticks (was ' + n2 + ', now ' + n3 + ')');
    const cap2 = await dbg(`return d.status();`);
    assert(cap2.cap <= 8, 'set still bounded at 8 (got ' + cap2.cap + ')');
    eq(await elProp('paused'), false, 'the playing fixture still plays');
    await page.evaluate(() => { (window.__capEls || []).forEach((a) => { try { a.remove(); } catch (e) {} }); window.__capEls = []; });
    await stopPlay();
  });

  scenario('engine-footnote', async () => {
    // 2.24: the footnote reads "<rate> kHz · <total> ms delay (<output> ms output + <fx> ms effects) · …", from the
    // context's rate, the output latency and fxLatencyMs, refreshed every 60 frames; the footer buttons sit right above it
    await play('A', { loop: true });
    await audioTab();
    const RE = /^(\d+) kHz · (\d+) ms delay \((\d+) ms output \+ (0|12|14|16) ms effects\) · These shape SoundCloud’s audio in real time; turn them off and playback returns to normal instantly\. Crossfade and higher bitrates aren’t possible in the browser; the system volume is invisible to the loudness contour\.$/;
    let t = await noteText(), m = RE.exec(t);
    assert(m, 'footnote matches the engine format (got ' + JSON.stringify(t) + ')');
    assert(/\d+ kHz · \d+ ms delay \(\d+ ms output \+ (0|12|14|16) ms effects\)/.test(t), 'the spec regex');
    let s = await snap();
    eq(+m[1], Math.round(s.sampleRate / 1000), 'the rate of the context SoundCloud routes through (' + s.sampleRate + ')'); eq(+m[2], +m[3] + +m[4], 'total = output + effects'); eq(+m[4], s.latencyMs, 'effects = fxLatencyMs'); eq(+m[3], s.outLatMs, 'output = the smoothed output latency');
    eq(+m[4], 12, '12 ms effects (two compressors)'); assert(s.sampleRate === 44100 || s.sampleRate === 48000, 'a default-rate context');
    const st = await abody(`const n = [...a.querySelectorAll('div')].pop(); return n.style.fontSize + '|' + n.style.color + '|' + n.style.marginTop + '|' + n.style.lineHeight;`);
    eq(st, '10px|rgb(103, 103, 111)|20px|1.5', 'the note keeps its 10 px #67676f look');
    const order = await sectionOrder(), L = order.length;
    rowStarts(order, L - 1, m[1] + ' kHz'); rowStarts(order, L - 2, 'ApplyCancel'); eq(order[L - 3], '', 'the footer paste box'); rowStarts(order, L - 4, 'Copy settingsPas');
    const ft = await abody(`const b = [...a.querySelectorAll('button')].find((x) => x.textContent === 'Copy settings'); return { css: b.parentElement.style.cssText, btns: [...b.parentElement.children].map((c) => c.textContent).join(','), weight: getComputedStyle(b).fontWeight, size: getComputedStyle(b).fontSize, radius: b.style.borderRadius, bg: b.style.background, ref: (() => { const c = [...a.querySelectorAll('button')].find((x) => x.textContent === 'Save'); return c ? getComputedStyle(c).fontWeight + '/' + getComputedStyle(c).fontSize + '/' + c.style.borderRadius + '/' + c.style.background : null; })() };`);
    eq(ft.btns, 'Copy settings,Paste settings,Reset all audio', 'the three footer buttons'); assert(/display: flex/.test(ft.css) && /gap: 8px/.test(ft.css) && /margin-top: 18px/.test(ft.css), 'footer row style (got ' + ft.css + ')');
    eq(ft.weight + '/' + ft.size + '/' + ft.radius + '/' + ft.bg, ft.ref, 'the footer buttons wear exactly what the preset Save button wears (mkBtn)');
    // Enhance adds the 4× shapers' 192 samples (4 ms at 48 kHz → 16); the line follows within 60 frames
    await set('enhanceOn', true); await sleep(1600); t = await noteText(); m = RE.exec(t);
    assert(m && +m[4] === 16, '16 ms effects with Enhance (got ' + JSON.stringify(t) + ')'); eq(+m[2], +m[3] + 16, 'total follows');
    await set('enhanceOn', false); await sleep(1600); t = await noteText(); m = RE.exec(t); assert(m && +m[4] === 12, 'back to 12 ms');
    // a 96 kHz context: the rate line follows the context SoundCloud routes through (14 ms with Enhance)
    await play('A', { loop: true, sampleRate: 96000 }); await sleep(1600); t = await noteText(); m = RE.exec(t);
    assert(m && +m[1] === 96, '96 kHz (got ' + JSON.stringify(t) + ')');
    await set('enhanceOn', true); await sleep(1600); t = await noteText(); m = RE.exec(t); assert(m && +m[4] === 14, '14 ms effects at 96 kHz with Enhance (got ' + JSON.stringify(t) + ')');
    await set('enhanceOn', false);
    await closeHub(); await sleep(150); s = await snap(); eq(s.routed, false, 'detached');
    await stopPlay();
  });

  /* ── WP9 helpers: the hub's Tweaks / Stats tabs, its toast, the sleep chips ── */
  const tweaksTab = async () => { await openHub(); await hub(`root.querySelector('.tab[data-tab="tweaks"]').click();`); await sleep(700); };
  const statsTab = async () => { await openHub(); await hub(`root.querySelector('.tab[data-tab="stats"]').click();`); await sleep(500); };
  const hubToast = () => hub(`const t = root.querySelector('#toast'); return t ? t.textContent : null;`);
  const clearHubToast = () => hub(`const t = root.querySelector('#toast'); if (t) t.textContent = '';`);
  const sleepChips = () => hub(`const w = root.querySelector('#ebody'); const cs = [...w.querySelectorAll('button[data-min]')]; return { chips: cs.map((c) => ({ min: +c.dataset.min, text: c.textContent, lit: /linear-gradient/.test(c.style.background) })), label: cs[0] ? cs[0].parentElement.previousElementSibling.querySelector('small').textContent : null };`);
  const clickChip = async (min) => { await hub(`[...root.querySelector('#ebody').querySelectorAll('button[data-min]')].find((c) => +c.dataset.min === ${min}).click();`); await sleep(150); };
  const statsHeads = () => hub(`return [...root.querySelector('#sbody').querySelectorAll('.qhead')].map((h) => h.textContent);`);
  const lsGet = (k) => page.evaluate((key) => { try { return localStorage.getItem(key); } catch (e) { return null; } }, k);

  scenario('ab-precision', async () => {
    // 2.28: the wrap is a rate-aware timer aimed 30 ms before B plus a 100 ms backstop — never the 1 Hz tick — so over
    // 4 s of 50 ms samples currentTime never passes B by more than 60 ms; seeking out of the loop switches it off
    await play('C', { loop: true });
    await dbg(`d.ab(2.0, 3.0);`);
    eq(await dbg(`return d.abOn();`), true, 'abOn');
    await dbg(`d.seek(2.1);`); await sleep(200);
    let maxT = 0, minT = 99, wraps = 0, last = 0;
    for (let i = 0; i < 80; i++) { const t = await elProp('currentTime'); if (t > maxT) maxT = t; if (t < minT) minT = t; if (t < last - 0.5) wraps++; last = t; await sleep(50); }
    assert(maxT <= 3.06, 'currentTime never exceeds 3.06 (max ' + maxT.toFixed(3) + ')');
    assert(minT >= 1.9, 'never below A (min ' + minT.toFixed(3) + ')');
    assert(wraps >= 3, 'wrapped at least 3 times in 4 s (got ' + wraps + ')');
    eq(await dbg(`return d.abOn();`), true, 'still looping');
    // a rate change re-aims the timer: at 2× the loop still holds
    await set('speed', 200); await dbg(`d.applySpeed();`); await sleep(300);
    eq(await elProp('playbackRate'), 2, '2×');
    maxT = 0; wraps = 0; last = 0;
    for (let i = 0; i < 40; i++) { const t = await elProp('currentTime'); if (t > maxT) maxT = t; if (t < last - 0.5) wraps++; last = t; await sleep(50); }
    assert(maxT <= 3.08, 'at 2× currentTime never exceeds 3.08 (max ' + maxT.toFixed(3) + ')');
    assert(wraps >= 3, 'wrapped at 2× (got ' + wraps + ')');
    await set('speed', 100); await dbg(`d.applySpeed();`);
    // the listener seeks well past B → the loop turns itself off (backstop within 100 ms)
    await dbg(`d.seek(6);`); await sleep(400);
    eq(await dbg(`return d.abOn();`), false, 'seek outside → A–B off');
    const t6 = await elProp('currentTime'); assert(t6 > 5.5, 'playback continued from the seek (' + t6.toFixed(2) + ')');
    // a track change ends the loop even when A sits at the very start: a fresh element starts at 0, which the `< A − 0.5`
    // test alone cannot tell from the loop — the loop belongs to the element it was set on
    await dbg(`d.seek(0.3); d.ab(0.2, 1.2);`); await sleep(300);   // seek first: setting the loop while parked at 6 s would be an outside-the-loop clear
    eq(await dbg(`return d.abOn();`), true, 'a tight loop at the start of the track');
    await play('A', { loop: true }); await sleep(1600);
    eq(await dbg(`return d.abOn();`), false, 'a new track switches the loop off');
    const tNew = await elProp('currentTime'); assert(tNew > 1.3, 'the new track plays on past B (' + tNew.toFixed(2) + ')');
    // the persisted flag is gone; the bar button reads the live state
    eq(await get('abLoop'), undefined, 'no abLoop key');
    await stopPlay();
  });

  scenario('sleep-chips', async () => {
    // 2.29: module 3's own timer is gone — the chips drive module 1's SUITE.sleep (one clock for the whole suite);
    // the label / lit chip read it back, the Stats tab shows the same timer, Track end joins the row
    await play('C', { loop: true });
    await tweaksTab();
    let c = await sleepChips();
    eq(c.chips.map((x) => x.text).join(','), '15m,30m,45m,1h,1.5h,Track end,Off', 'seven chips, Track end before Off');
    eq(c.chips.map((x) => x.min).join(','), '15,30,45,60,90,-1,0', 'chip minutes');
    eq(c.chips.filter((x) => x.lit).length, 0, 'nothing lit'); eq(c.label, 'Pause playback automatically', 'idle label');
    await clickChip(15);
    let sl = await dbg(`return d.sleep();`);
    assert(sl.rem > 14.9 * 60000 && sl.rem <= 15 * 60000, '15m → remainingMs between 14.9 and 15 min (' + sl.rem + ')');
    eq(sl.armed, false, 'not the after-this-track kind'); eq(sl.chip, 15, 'chip 15 remembered');
    c = await sleepChips(); eq(c.chips.filter((x) => x.lit).map((x) => x.min).join(','), '15', 'only the 15m chip lit'); eq(c.label, 'Pausing playback in ~15 min', 'label reads the shared timer');
    // the hub's Stats tab reads the same timer
    await statsTab();
    assert((await statsHeads()).includes('Sleep timer · 15m left'), 'Stats tab: Sleep timer · 15m left (got ' + JSON.stringify(await statsHeads()) + ')');
    // set from the Stats tab (30m) → the Tweaks chips follow
    await hub(`const h = [...root.querySelector('#sbody').querySelectorAll('.qhead')].find((x) => x.textContent.startsWith('Sleep timer')); [...h.nextElementSibling.querySelectorAll('button.sbtn')].find((b) => b.textContent === '30m').click();`); await sleep(150);
    await tweaksTab(); c = await sleepChips();
    eq(c.chips.filter((x) => x.lit).map((x) => x.min).join(','), '30', 'the 30m chip lights for a timer set elsewhere'); eq(c.label, 'Pausing playback in ~30 min', 'label follows');
    // Track end: fires 0.12 min before the end of the track (fixture C is 10 s → the 0.01 min floor)
    await clickChip(-1);
    sl = await dbg(`return d.sleep();`);
    assert(sl.rem > 0 && sl.rem <= 601, 'Track end on a 10 s fixture → the 0.01 min floor (' + sl.rem + ' ms)'); eq(sl.chip, -1, 'Track end chip remembered');
    c = await sleepChips(); eq(c.chips.filter((x) => x.lit).map((x) => x.min).join(','), '-1', 'Track end lit'); eq(c.label, 'Pausing playback in ~1 min', 'label');
    await clickChip(0);
    sl = await dbg(`return d.sleep();`); eq(sl.rem, 0, 'Off → 0'); eq(sl.chip, 0, 'chip cleared');
    c = await sleepChips(); eq(c.chips.filter((x) => x.lit).length, 0, 'nothing lit'); eq(c.label, 'Pause playback automatically', 'idle label again');
    await statsTab(); assert((await statsHeads()).includes('Sleep timer'), 'Stats tab: timer off');
    await closeHub(); await stopPlay();
  });

  scenario('volume-mute', async () => {
    // 2.30: the remembered volume never records a mute (or a near-silent level), and a stored 0 is ignored on restore
    await dbg(`d.gm('enh:vol', '1');`);
    await play('A', { loop: true });
    await sleep(1300);   // the first enforce tick restores the remembered level onto the fixture element
    eq(await elProp('volume'), 1, 'restored 1');
    await page.evaluate(() => { window.__afx.el().volume = 0.8; }); await sleep(3200);
    eq(await dbg(`return d.gm('enh:vol');`), '0.8', 'the new level is remembered');
    await dbg(`d.toggleMute();`);
    eq(await elProp('volume'), 0, 'muted'); eq(await dbg(`return d.muted();`), true, 'mute state');
    await sleep(2200);
    eq(await dbg(`return d.gm('enh:vol');`), '0.8', 'enh:vol unchanged 2 s after muting');
    await dbg(`d.toggleMute();`);
    approx(await elProp('volume'), 0.8, 0.001, 'unmuted back to 0.8'); eq(await dbg(`return d.muted();`), false, 'mute cleared');
    // M then + : the bump is a real unmute, so the memory resumes (a stale mute state used to keep the save branch skipped until the next M)
    await dbg(`d.toggleMute();`); eq(await elProp('volume'), 0, 'muted again');
    await dbg(`d.bumpVol(0.05);`); approx(await elProp('volume'), 0.05, 0.001, '+ raises from the mute'); eq(await dbg(`return d.muted();`), false, '+ clears the mute state');
    await page.evaluate(() => { window.__afx.el().volume = 0.8; }); await sleep(2200);
    eq(await dbg(`return d.gm('enh:vol');`), '0.8', 'the memory runs again after the bump');
    // a near-silent level (< 0.02) is not remembered either
    await page.evaluate(() => { window.__afx.el().volume = 0.01; }); await sleep(2200);
    eq(await dbg(`return d.gm('enh:vol');`), '0.8', '0.01 not remembered');
    await page.evaluate(() => { window.__afx.el().volume = 0.5; }); await sleep(2200);
    eq(await dbg(`return d.gm('enh:vol');`), '0.5', '0.5 remembered');
    // restore: a stored 0 is ignored (the element keeps its own level). The previous element stays at 1, so a save tick
    // landing between the write and the new element's first tick can only re-write '1' — and the new element starts at
    // its own 0.6, which tells "ignored" (0.6) from "applied" (0) and from a raced restore (1)
    await page.evaluate(() => { window.__afx.el().volume = 1; }); await sleep(2200);
    await page.evaluate(() => { window.__sceAudioDebug().gm('enh:vol', '0'); });
    await play('C', { loop: true, volume: 0.6 }); await sleep(1300);
    approx(await elProp('volume'), 0.6, 0.001, 'stored 0 ignored — the element keeps its own level');
    // a stored 0.5 lands: the previous element is parked at 0.5 first (so the tick can only ever store 0.5), the new one starts at 0.9
    await page.evaluate(() => { window.__afx.el().volume = 0.5; }); await sleep(2200);
    eq(await dbg(`return d.gm('enh:vol');`), '0.5', 'stored 0.5');
    await play('A', { loop: true, volume: 0.9 }); await sleep(1300);
    approx(await elProp('volume'), 0.5, 0.001, 'stored 0.5 restored');
    await dbg(`d.gm('enh:vol', '1');`);
    await page.evaluate(() => { window.__afx.el().volume = 1; }); await sleep(2200);
    eq(await dbg(`return d.gm('enh:vol');`), '1', 'left at 1 for the next scenario');
    await stopPlay();
  });

  scenario('audio-hotkeys', async () => {
    // 2.23: opt-in A (hold to compare) · N (night) · , . (speed ∓5 %) — dispatched by SUITE.audioKey from module 3's
    // window listeners when the hub is closed and from the hub's own hotkeys() on its Audio tab, where tap-align,
    // the mini bar and lyric nudging would otherwise take those keys; on any other hub tab the hub keeps them
    await play('A', { loop: true });
    await set('eqOn', true); await set('eqBands', [6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // off by default: nothing happens
    await page.keyboard.press('n'); await sleep(100); eq(await get('nightOn'), false, 'hotkeys off: N inert');
    await page.keyboard.down('a'); await sleep(100); eq((await snap()).bypassed, false, 'hotkeys off: A inert'); await page.keyboard.up('a');
    await set('hotkeys', true);
    // hub closed → module 3's listeners
    await page.keyboard.down('a'); await sleep(120);
    let s = await snap(); eq(s.bypassed, true, 'A down → comparing'); eq(s.params.bands[0].gain, 0, 'band nulled while held');
    await page.keyboard.up('a'); await sleep(120);
    s = await snap(); eq(s.bypassed, false, 'A up → back'); approx(s.params.bands[0].gain, 6, 0.001, 'band back');
    await page.keyboard.press('n'); await sleep(100); eq(await get('nightOn'), true, 'N → night on');
    await page.keyboard.press('n'); await sleep(100); eq(await get('nightOn'), false, 'N again → off');
    await page.keyboard.press('.'); await sleep(250); eq(await get('speed'), 105, '. → 105 %'); eq(await elProp('playbackRate'), 1.05, 'element follows');
    await page.keyboard.press(','); await sleep(250); eq(await get('speed'), 100, ', → 100 %');
    // auto-repeat is ignored; typing targets are ignored; modifier chords are ignored
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', repeat: true, bubbles: true })));
    await sleep(100); eq(await get('speed'), 100, 'repeat ignored');
    await page.evaluate(() => { const i = document.createElement('input'); i.id = '__wp9in'; document.body.appendChild(i); i.focus(); });
    await page.keyboard.press('n'); await page.keyboard.press('.'); await sleep(100);
    eq(await get('nightOn'), false, 'typing: N ignored'); eq(await get('speed'), 100, 'typing: . ignored');
    await page.evaluate(() => { const i = document.getElementById('__wp9in'); i.blur(); i.remove(); });
    await page.keyboard.press('Control+n'); await sleep(100); eq(await get('nightOn'), false, 'Ctrl+N ignored');
    // a lost keyup: window blur releases the hold
    await page.keyboard.down('a'); await sleep(120); eq((await snap()).bypassed, true, 'held');
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await sleep(120);
    eq((await snap()).bypassed, false, 'blur releases the hold');
    await page.keyboard.up('a'); await sleep(60);
    // hub open on the Audio tab: the hub yields the four keys (tap-align / mini bar / nudge stay untouched)
    const miniBefore = await lsGet('scssgm:sl:mini');
    await openHub(); await page.keyboard.press('4'); await sleep(500);
    await clearHubToast();
    await page.keyboard.down('a'); await sleep(120);
    eq((await snap()).bypassed, true, 'Audio tab: A down → comparing'); eq(await hubToast(), '', 'tap-align did not start');
    await page.keyboard.up('a'); await sleep(120); eq((await snap()).bypassed, false, 'Audio tab: A up → back');
    await page.keyboard.press('n'); await sleep(120); eq(await get('nightOn'), true, 'Audio tab: N → night on');
    eq(await lsGet('scssgm:sl:mini'), miniBefore, 'the mini lyric bar did not toggle'); eq(await hubToast(), '', 'no hub toast');
    await page.keyboard.press('n'); await sleep(120); eq(await get('nightOn'), false, 'night off again');
    await page.keyboard.press(','); await sleep(250); eq(await get('speed'), 95, 'Audio tab: , → 95 %'); eq(await hubToast(), '', 'no lyric-sync toast');
    await page.keyboard.press('.'); await sleep(250); eq(await get('speed'), 100, 'Audio tab: . → 100 %');
    // a physically held key auto-repeats after ~500 ms; Playwright never does, so synthesize the repeats: they are audioKey's
    // to swallow — a leak would reach tap-align (A → 'Play a track with lyrics first'), the mini bar (N) or lyric nudging (, .)
    await clearHubToast();
    await page.keyboard.down('a'); await sleep(80);
    for (const key of ['a', 'n', ',', '.']) await page.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, repeat: true, bubbles: true, cancelable: true })), key);
    await sleep(150);
    eq((await snap()).bypassed, true, 'Audio tab: still comparing through the repeats');
    eq(await hubToast(), '', 'repeats: no hub toast (tap-align / mini bar / nudge untouched)');
    eq(await lsGet('scssgm:sl:mini'), miniBefore, 'repeats: the mini lyric bar did not toggle');
    eq(await get('nightOn'), false, 'repeats: night mode untouched'); eq(await get('speed'), 100, 'repeats: speed untouched');
    await page.keyboard.up('a'); await sleep(120); eq((await snap()).bypassed, false, 'Audio tab: A released after the repeats');
    // the tab's Speed row follows the key
    const spd = await sliderByMax(200); eq(spd.value, '100', 'Speed row follows');
    // other hub keys still work on the Audio tab (3 → Stats)
    await page.keyboard.press('3'); await sleep(300); eq(await hub(`return root.querySelector('#sbody').style.display;`), '', 'Stats tab shown (3 still reaches the hub)');
    // hub open on the Lyrics tab: the hub owns A (tap-align) and the audio keys are dead
    await page.keyboard.press('1'); await sleep(300); await clearHubToast();
    await page.keyboard.down('a'); await sleep(120);
    eq((await snap()).bypassed, false, 'Lyrics tab: A does not compare');
    assert(/lyrics/i.test(await hubToast() || ''), 'Lyrics tab: A went to tap-align (toast ' + JSON.stringify(await hubToast()) + ')');
    await page.keyboard.up('a'); await sleep(60);
    await page.keyboard.press('.'); await sleep(200); eq(await get('speed'), 100, 'Lyrics tab: . does not change speed');
    await page.keyboard.press('n'); await sleep(200); eq(await get('nightOn'), false, 'Lyrics tab: N does not touch night mode');
    if (await lsGet('scssgm:sl:mini') !== miniBefore) { await page.keyboard.press('n'); await sleep(200); }   // put the mini bar back
    await closeHub();
    // the cheat-sheet carries the Audio group and its note; the settings row lists the keys
    await page.keyboard.press('?'); await sleep(400);
    const sheet = await page.evaluate(() => { const els = [...document.querySelectorAll('div')].filter((d) => /Keyboard shortcuts/.test(d.textContent) && d.style.position === 'fixed'); return els.length ? els[0].textContent : null; });
    assert(sheet, 'cheat-sheet opened');
    assert(/AUDIO|Audio/.test(sheet) && /Hold to compare with the original/.test(sheet) && /Night mode on \/ off/.test(sheet) && /Speed −5 % \/ \+5 %/.test(sheet), 'Audio group rows');
    assert(/Also work inside the hub on the Audio tab/.test(sheet), 'the note');
    await page.keyboard.press('Escape'); await sleep(300);
    await tweaksTab();
    const desc = await hub(`return root.querySelector('#ebody').textContent;`);
    assert(/A compare · N night · , \. speed/.test(desc), 'settings description lists the audio keys');
    await closeHub();
    await set('hotkeys', false); await set('nightOn', false); await set('speed', 100); await dbg(`d.applySpeed();`);
    await stopPlay();
  });

  /* ═══════════ WP10 — "ship if cheap" ═══════════ */

  scenario('swap-lr', async () => {
    // WP10 Swap L/R: a toggle after Mono; the matrix rows swap (gLR = gRL = 1, gLL = gRR = 0), balance still scales per output
    await play('A', { loop: true });
    await audioTab();
    eq(await toggleDesc('Swap left / right'), 'Left channel in the right ear and vice versa · for reversed headphones', 'swap copy');
    eq(await switchClick('Swap left / right'), 'true', 'switch on'); await sleep(200);
    eq(await get('swapLR'), true, 'swapLR true');
    let s = await snap(); eq(s.params.gLL.gain, 0, 'LL 0'); eq(s.params.gLR.gain, 1, 'LR 1'); eq(s.params.gRL.gain, 1, 'RL 1'); eq(s.params.gRR.gain, 0, 'RR 0');
    await sliderSet('Balance', -40); await sleep(350); s = await snap();
    approx(s.params.gLR.gain, 0.6, 0.001, 'swap + balance L 40: the right output is attenuated'); eq(s.params.gRL.gain, 1, 'the left output untouched');
    await sliderReset('Balance'); await sleep(200);
    eq(await switchClick('Swap left / right'), 'false', 'switch off'); await sleep(200);
    s = await snap(); eq(s.params.gLL.gain, 1, 'identity LL'); eq(s.params.gLR.gain, 0, 'identity LR'); eq(s.params.gRL.gain, 0, 'identity RL'); eq(s.params.gRR.gain, 1, 'identity RR');
    await set('swapLR', true); await sleep(150); eq(await switchState('Swap left / right'), 'true', 'a debug write repaints the switch');
    await closeHub(); await sleep(150); s = await snap(); eq(s.routed, true, 'swap alone keeps the chain routed');
    await set('swapLR', false); await sleep(150); s = await snap(); eq(s.routed, false, 'off, tab closed → detached');
    await stopPlay();
  });

  scenario('fx-glow', async () => {
    // WP10 player-bar FX glow: the pill's hub button wears the speed pill's accent while the listener's own settings are
    // engaged — an open Audio tab alone (which routes the chain) does not light it; the tooltip names the boost
    const hubBtn = () => page.evaluate(() => { const w = document.querySelector('.sce-barwrap'), b = w && w.querySelector('.sce-hub'); return b ? { color: b.style.color, shadow: b.style.textShadow, opacity: b.style.opacity, tip: b._tip || '', title: b.title, tipText: w.firstChild.textContent, tipOpacity: w.firstChild.style.opacity } : null; });
    await play('A', { loop: true });
    let b = await hubBtn(); assert(b, 'the player-bar pill exists');
    eq(b.color, '', 'nothing on → no glow'); eq(b.title, 'Open / close the lyrics hub', 'plain title');
    await audioTab(); await sleep(200);
    eq((await snap()).routed, true, 'the open tab routes the chain'); b = await hubBtn(); eq(b.color, '', 'the open tab alone does not glow');
    await set('bassDb', 4); await sleep(150);
    b = await hubBtn(); eq(b.color, 'rgb(255, 106, 31)', 'bass on → accent colour'); assert(/10px/.test(b.shadow), 'accent glow'); eq(b.opacity, '0.95', 'opacity .95');
    eq(b.tip, 'Audio FX on', 'tooltip'); eq(b.title, 'Open / close the lyrics hub · Audio FX on', 'title carries it');
    await set('boostAmt', 200); await sleep(150); b = await hubBtn(); eq(b.tip, 'Audio FX on · boost 200 %', 'boost in the tooltip');
    // hovering shows the live tooltip text
    await page.evaluate(() => document.querySelector('.sce-barwrap .sce-hub').dispatchEvent(new Event('mouseenter'))); await sleep(100);
    b = await hubBtn(); eq(b.tipText, 'Audio FX on · boost 200 %', 'the floating tip reads it'); eq(b.tipOpacity, '1', 'tip shown');
    await page.evaluate(() => document.querySelector('.sce-barwrap .sce-hub').dispatchEvent(new Event('mouseleave'))); await sleep(100);
    b = await hubBtn(); eq(b.color, 'rgb(255, 106, 31)', 'still lit after the hover ends');
    await set('bassDb', 0); await sleep(150); b = await hubBtn(); eq(b.tip, 'Audio FX on · boost 200 %', 'boost alone is an FX');
    // Compare (parameter bypass) lifts the glow while held
    await dbg(`d.bypass(true);`); await sleep(150); b = await hubBtn(); eq(b.color, '', 'compare held → no glow');
    await dbg(`d.bypass(false);`); await sleep(150); b = await hubBtn(); eq(b.color, 'rgb(255, 106, 31)', 'released → lit');
    await set('boostAmt', 100); await sleep(150); b = await hubBtn(); eq(b.color, '', 'all off → plain'); eq(b.title, 'Open / close the lyrics hub', 'title restored');
    await page.evaluate(() => document.querySelector('.sce-barwrap .sce-hub').dispatchEvent(new Event('mouseenter'))); await sleep(100);
    eq((await hubBtn()).tipText, 'Lyrics hub', 'the plain label is back');
    await page.evaluate(() => document.querySelector('.sce-barwrap .sce-hub').dispatchEvent(new Event('mouseleave')));
    await closeHub(); await stopPlay();
  });

  scenario('ab-markers', async () => {
    // WP10 A–B timeline markers: 2-px accent spans in SoundCloud's progress wrapper at A/dur and B/dur (A alone as soon as
    // it is set), gone on clear and on a track change. The harness stands in a wrapper (no real SoundCloud playback headless).
    await play('C', { loop: true });
    // SoundCloud's own wrapper is on the page even without playback; the stand-in only covers a page that lacks it
    await page.evaluate(() => { let w = document.querySelector('.playbackTimeline__progressWrapper'); if (!w) { w = document.createElement('div'); w.className = 'playbackTimeline__progressWrapper'; w.dataset.harness = '1'; w.style.cssText = 'width:500px;height:8px'; document.body.appendChild(w); } });
    const marks = () => page.evaluate(() => { const w = document.querySelector('.playbackTimeline__progressWrapper'); return { pos: getComputedStyle(w).position, marks: [...document.querySelectorAll('.sce-abmark')].map((e) => ({ left: e.style.left, w: e.style.width, bg: e.style.background, inWrap: e.parentNode === w })) }; });
    await dbg(`d.seek(2.1); d.ab(2.0, 3.0);`); await sleep(200);   // seek first: a loop armed while the head sits outside it clears itself
    let m = await marks();
    eq(m.marks.length, 2, 'two markers'); approx(parseFloat(m.marks[0].left), 20, 0.01, 'A at 2 s of 10 → 20 %'); approx(parseFloat(m.marks[1].left), 30, 0.01, 'B at 3 s of 10 → 30 %');
    eq(m.marks[0].w, '2px', '2 px wide'); eq(m.marks[0].bg, 'rgb(255, 106, 31)', 'accent colour'); assert(m.marks.every((x) => x.inWrap), 'inside the wrapper'); eq(m.pos, 'relative', 'the wrapper anchors them');
    await dbg(`d.abClear();`); await sleep(200); m = await marks(); eq(m.marks.length, 0, 'cleared → none');
    // the bar button path: A alone shows one marker, B the second, right-click clears
    await dbg(`d.seek(4);`); await sleep(150);
    await page.evaluate(() => document.querySelector('.sce-barwrap .sce-ab').click()); await sleep(200);
    m = await marks(); eq(m.marks.length, 1, 'A set → one marker'); assert(parseFloat(m.marks[0].left) >= 39.5 && parseFloat(m.marks[0].left) < 46, 'A near 40 % (got ' + m.marks[0].left + ')');
    await dbg(`d.seek(6);`); await sleep(150);
    await page.evaluate(() => document.querySelector('.sce-barwrap .sce-ab').click()); await sleep(200);
    m = await marks(); eq(m.marks.length, 2, 'B set → two markers'); assert(parseFloat(m.marks[1].left) >= 59.5 && parseFloat(m.marks[1].left) < 66, 'B near 60 % (got ' + m.marks[1].left + ')');
    eq(await dbg(`return d.abOn();`), true, 'looping');
    await page.evaluate(() => document.querySelector('.sce-barwrap .sce-ab').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))); await sleep(200);
    m = await marks(); eq(m.marks.length, 0, 'right-click → none'); eq(await dbg(`return d.abOn();`), false, 'loop cleared');
    // a track change ends the loop and takes the markers with it
    await dbg(`d.seek(0.3); d.ab(0.2, 1.2);`); await sleep(300); m = await marks(); eq(m.marks.length, 2, 'markers for the new loop');
    await play('A', { loop: true }); await sleep(1600);
    eq(await dbg(`return d.abOn();`), false, 'a new track switches the loop off'); m = await marks(); eq(m.marks.length, 0, 'markers gone');
    await page.evaluate(() => { const w = document.querySelector('.playbackTimeline__progressWrapper'); if (w && w.dataset.harness) w.remove(); });
    await stopPlay();
  });

  scenario('mono-badge', async () => {
    // WP10 correlation / mono badge: Pearson r of the source taps rides in the meter; while the Vocals knob is in use, a
    // dual-mono upload (r > 0.98 for 3 s) forces the vocal gain to 1 and the row reads "Mono upload" — there is no side
    // signal to soften, only a whole-mix dip — until a stereo track (r ≤ 0.98) or Vocals back at Normal lifts it
    await play('F', { loop: true });
    await audioTab();
    await set('vocalAmt', -100); await sleep(4500);
    let s = await snap(); assert(s.meter.corr < 0.5, 'stereo fixture: r < 0.5 (got ' + s.meter.corr + ')'); eq(!!s.meter.monoSrc, false, 'no verdict on a stereo track');
    approx(s.params.vGain.gain, 0.1, 0.01, 'softer 100 → 0.1'); eq((await sliderByLabel('Vocals')).val, 'Softer 100', 'value Softer 100');
    await play('A', { loop: true });
    await sleep(600); s = await snap(); approx(s.params.vGain.gain, 0.1, 0.01, 'still 0.1 before the 3 s verdict');
    // the verdict needs 3 s of high reads after the first tick; poll up to 10 s for it (a busy machine ticks late)
    let tv = 0; for (; tv < 100; tv++) { await sleep(100); s = await snap(); if (s.meter.monoSrc) break; }
    assert(tv >= 15, 'no verdict inside the first 2 s (came at ' + ((tv + 6) / 10).toFixed(1) + ' s)');
    // r comes from two tap reads that a render quantum can straddle (the engine's verdict votes over three ticks for
    // exactly that reason): read fresh ticks until one is clean, up to three
    let corr = s.meter.corr; for (let i = 0; i < 3 && !(corr > 0.98); i++) { await sleep(150); corr = (await dbg(`return d.meterTick();`)).corr; }
    assert(corr > 0.98, 'dual-mono fixture: r > 0.98 (got ' + corr + ')'); eq(s.meter.monoSrc, true, 'mono upload detected within 10 s');
    await sleep(200); s = await snap();   // the verdict's 50 ms gain ramp
    approx(s.params.vGain.gain, 1, 0.01, 'vGain forced to 1'); eq((await sliderByLabel('Vocals')).val, 'Mono upload', 'the Vocals value reads Mono upload');
    eq(await get('vocalAmt'), -100, 'the setting itself is untouched');
    // the corner tick is painted lit (the canvas top-right scale)
    const lit = await abody(`const c = a.querySelector('canvas').getContext('2d'); const d = c.getImageData(${G.CW - G.padX - 43}, 8, 46, 12).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 120 && d[i + 1] < 200 && d[i + 3] > 150) n++; return n;`);
    assert(lit >= 18, 'the correlation tick is lit at the mono end (' + lit + ' accent pixels)');
    await play('F', { loop: true });
    for (let i = 0; i < 60; i++) { await sleep(100); s = await snap(); if (!s.meter.monoSrc) break; }   // three low 1 Hz votes
    eq(s.meter.monoSrc, false, 'a stereo track lifts the verdict (within 6 s)'); await sleep(200); s = await snap(); approx(s.params.vGain.gain, 0.1, 0.01, 'softening resumes'); eq((await sliderByLabel('Vocals')).val, 'Softer 100', 'value back');
    await play('A', { loop: true });
    const trace = [];
    for (let i = 0; i < 200; i++) { await sleep(100); s = await snap(); if (i % 5 === 0) trace.push(s.meter.corr == null ? 'nil' : (+s.meter.corr).toFixed(2)); if (s.meter.monoSrc) break; }
    eq(s.meter.monoSrc, true, 'mono again (within 20 s; r every 0.5 s: ' + trace.join(' ') + ')'); await set('vocalAmt', 0); await sleep(150);
    s = await snap(); eq(s.meter.monoSrc, false, 'Normal clears the verdict'); eq(s.params.vGain.gain, 1, 'vGain 1'); eq((await sliderByLabel('Vocals')).val, 'Normal', 'Normal');
    await closeHub(); await stopPlay();
  });

  scenario('sleep-fade', async () => {
    // WP10 sleep fade through the chain: with the chain routed the sleep timer's fade is a linear ramp of the chain's
    // output gain to 0.02 over 8 s (the element's volume — SoundCloud's slider — stays put), then the play button is
    // clicked and the gain quietly restored; with nothing routed the element's volume steps down in 50 ms steps instead
    const trap = () => page.evaluate(() => { const pc = document.querySelector('.playControl'); pc.classList.add('playing'); window.__pcClicks = 0; window.__pcTrap = (e) => { e.stopImmediatePropagation(); e.preventDefault(); window.__pcClicks++; }; pc.addEventListener('click', window.__pcTrap, true); });
    const untrap = () => page.evaluate(() => { const pc = document.querySelector('.playControl'); pc.classList.remove('playing'); pc.removeEventListener('click', window.__pcTrap, true); });
    const watch = async (read) => {   // poll ≤ 14 s: the lowest level seen, the level at the pause click, whether it was restored after
      let minV = 1, clickV = null, restored = false;
      for (let i = 0; i < 70; i++) { await sleep(200); const x = await read(); if (x.v < minV) minV = x.v; if (x.n >= 1 && clickV == null) clickV = x.v; if (clickV != null && x.v > 0.99) { restored = true; break; } }
      return { minV, clickV, restored, clicks: await page.evaluate(() => window.__pcClicks) };
    };
    // 1. through the chain (a 9-minute track: the timer fades instead of arming "after this track")
    await play('L', { loop: true });
    await set('bassDb', 2); eq((await snap()).routed, true, 'bass on → routed with the hub closed');
    await trap();
    await dbg(`d.sleepSet(0.01);`);   // 0.6 s; the shuffle watcher checks every 2 s
    approx((await snap()).params.output.gain, 1, 0.001, 'gain 1 before the fade');
    const clock = () => dbg(`const c = d.nodes().output.context; return { t: c.currentTime, w: performance.now() / 1000, st: c.state, chains: d.chains };`);
    const c0 = await clock();
    await sleep(3200);
    let s = await snap(); const g3 = s.params.output.gain; assert(g3 < 0.97 && g3 > 0.25, 'fading through the chain (' + g3.toFixed(3) + ')');
    eq(await dbg(`return d.sleepFading();`), true, 'sleep fade flagged'); eq(await elProp('volume'), 1, 'the element volume is untouched');
    await set('tiltDb', 1); s = await snap(); assert(s.params.output.gain < g3, 'an applyFx mid-fade leaves the ramp alone (' + s.params.output.gain.toFixed(3) + ')');
    let w = await watch(() => dbg(`return { v: d.params.output.gain, n: window.__pcClicks };`));
    const c1 = await clock();
    console.log('  clock: audio advanced ' + (c1.t - c0.t).toFixed(2) + ' s while the wall clock advanced ' + (c1.w - c0.w).toFixed(2) + ' s (' + c1.st + ', ' + c1.chains + ' chains)');
    assert(w.clickV != null, 'the play button was clicked at the end of the fade'); assert(w.clickV <= 0.06, 'at the click the gain rests near the floor (' + w.clickV + ')');
    approx(w.minV, 0.02, 0.01, 'floor 0.02'); assert(w.restored, 'gain restored after the pause click'); eq(w.clicks, 1, 'exactly one click');
    eq(await dbg(`return d.sleepFading();`), false, 'flag cleared'); eq(await elProp('volume'), 1, 'volume still untouched');
    await untrap(); await set('bassDb', 0); await set('tiltDb', 0);
    // 2. nothing routed: the element's volume steps down (the fixture joins the DOM so module 1 can see it)
    await stopPlay(); await play('L', { loop: true });
    await page.evaluate(() => document.body.appendChild(window.__afx.el()));
    eq((await snap()).routed, false, 'not routed');
    await trap();
    await dbg(`d.sleepSet(0.01);`); await sleep(3200);
    const v3 = await elProp('volume'); assert(v3 < 0.97 && v3 > 0.25, 'the volume steps down (' + v3.toFixed(3) + ')');
    w = await watch(() => page.evaluate(() => ({ v: window.__afx.el().volume, n: window.__pcClicks })));
    assert(w.clickV != null, 'clicked at the end'); assert(w.clickV <= 0.06, 'near silent at the click (' + w.clickV + ')'); assert(w.restored, 'volume restored'); eq(w.clicks, 1, 'one click');
    approx((await snap()).params.output.gain, 1, 0.001, 'the chain gain never moved');
    eq(await dbg(`return d.gm('enh:vol');`), '1', 'the volume memory ignored the fade (still 1)');
    await untrap(); await page.evaluate(() => window.__afx.el().remove());
    await stopPlay();
  });

  scenario('eq-memory', async () => {
    // WP10 per-track EQ memory (opt-in, the spd:bytrack pattern): the curve / pre-amp / switch are saved when a canvas
    // drag ends, a band is double-clicked or a preset is picked — never mid-drag — and restored on the 1 Hz tick when the
    // track changes; untracked tracks keep whatever is current; the map is capped at 250
    const ROCK = [5, 3, 2, 0, -1, 0, 2, 3, 4, 4];
    const mem = () => dbg(`return d.eqMem();`);
    const pointer = (type) => abody(`a.querySelector('canvas').dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true }));`);
    await play('A', { loop: true, href: '/test/track-a' });
    await audioTab();
    eq(await toggleDesc('Remember EQ per track'), 'Each track keeps the curve you last gave it', 'row copy');
    eq(await switchClick('Remember EQ per track'), 'true', 'switch on'); await sleep(100); eq(await get('eqPerTrack'), true, 'eqPerTrack');
    // a drag in flight saves nothing; the pointerup saves
    await pointer('pointerdown'); await dbg(`d.setBand(3, 6);`); await sleep(100);
    eq(Object.keys(await mem()).length, 0, 'nothing saved mid-drag');
    await pointer('pointerup'); await sleep(100);
    let m = await mem(); assert(m['/test/track-a'], 'saved for the track'); eq(m['/test/track-a'].b[3], 6, 'band 4 = +6'); eq(m['/test/track-a'].on, true, 'EQ on'); eq(m['/test/track-a'].pre, 0, 'pre-amp 0');
    // a preset pick saves too
    await selChoose('b:Rock'); await sleep(150);
    m = await mem(); eq(JSON.stringify(m['/test/track-a'].b), JSON.stringify(ROCK), 'Rock remembered');
    // an untracked track keeps the current curve; flattening it there is remembered for that track
    await play('C', { loop: true, href: '/test/track-b' }); await sleep(1600);
    eq(JSON.stringify(await get('eqBands')), JSON.stringify(ROCK), 'untracked track keeps the current curve');
    await btnClick('Reset'); await sleep(150);
    m = await mem(); eq(JSON.stringify(m['/test/track-b'].b), JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'flat remembered for track b');
    // back to the first track: its curve returns within the tick, with a toast; the tab follows
    await play('A', { loop: true, href: '/test/track-a' });
    let seen = false; for (let i = 0; i < 12 && !seen; i++) { await sleep(150); const t = await toastText(); if (t === 'EQ restored for this track') seen = true; }
    await sleep(200);
    eq(JSON.stringify(await get('eqBands')), JSON.stringify(ROCK), 'Rock restored for track a'); eq(await get('eqOn'), true, 'EQ on'); assert(seen, 'toast seen');
    eq(await selVal(), 'b:Rock', 'the preset select follows'); const s = await snap(); eq(s.params.bands[0].gain, 5, 'the chain follows');
    // the pre-amp and the switch ride along
    await sliderSet('Pre-amp', -3); await sleep(300); eq(await get('eqPreamp'), -3, 'pre-amp −3');
    await pointer('pointerdown'); await dbg(`d.setBand(0, 2);`); await pointer('pointerup'); await sleep(100);
    m = await mem(); eq(m['/test/track-a'].pre, -3, 'pre-amp remembered'); eq(m['/test/track-a'].b[0], 2, 'band remembered');
    await play('C', { loop: true, href: '/test/track-b' }); await sleep(1600);
    eq(await get('eqPreamp'), 0, 'track b restores its own pre-amp (0)'); eq((await get('eqBands'))[0], 0, 'and its flat curve');
    // the cap: 250 entries stay 250 after a save
    await dbg(`const big = {}; for (let i = 0; i < 250; i++) big['/t/' + i] = { on: true, b: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], pre: 0 }; d.gm('eq:bytrack', big);`);
    await play('A', { loop: true, href: '/test/track-a' }); await sleep(300);
    await dbg(`d.rememberEq();`); m = await mem(); eq(Object.keys(m).length, 250, 'capped at 250'); assert(m['/test/track-a'], 'the newest entry kept'); assert(!m['/t/0'], 'the oldest dropped');
    // off: nothing is restored on a track change
    await dbg(`d.eqMemClear();`);
    eq(await switchClick('Remember EQ per track'), 'false', 'switch off'); await sleep(100);
    await dbg(`d.gm('eq:bytrack', { '/test/track-b': { on: true, b: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9], pre: 0 } });`);
    await play('C', { loop: true, href: '/test/track-b' }); await sleep(1600);
    assert((await get('eqBands'))[0] !== 9, 'off → not restored');
    await closeHub(); await stopPlay();
  });

  scenario('end-trim', async () => {
    // WP10 end-of-track silence trim: with the toggle on (which routes the chain so the source taps can listen), a
    // source peak below −60 dBFS for 2 s inside the last 30 s seeks to duration − 0.2; a silence earlier in the track is
    // left alone; off, the ending plays out
    await audioTab();
    eq(await toggleDesc('Skip silent endings'), 'Jumps to the end when the last 30 s of a track go quiet · never mid-track', 'row copy');
    eq(await switchClick('Skip silent endings'), 'true', 'switch on'); await closeHub();
    await play('G', { loop: false });
    let s = await snap(); eq(s.routed, true, 'the trim alone routes the chain (the taps listen at the source)');
    await sleep(4100); const t4 = await elProp('currentTime'); assert(t4 > 2.5 && t4 < 5.5 && !(await elProp('paused')), 'the mid-track silence (32 s left) is left alone — no jump (' + t4.toFixed(2) + ')');
    // 8 s → silent with 28 s left: after 2 s of it the head jumps to the end
    let jumped = null, toastSeen = false;
    for (let i = 0; i < 60 && jumped == null; i++) { await sleep(200); const t = await elProp('currentTime'); if (!toastSeen && (await toastText()) === 'Skipped the silent ending') toastSeen = true; if (t > 30 || (await elProp('ended'))) jumped = t; }
    assert(jumped != null, 'jumped to the end (currentTime ' + jumped + ')'); assert(toastSeen, 'toast seen');
    const at = Date.now(); await sleep(600); assert((await elProp('ended')) || (await elProp('currentTime')) > 35.5, 'the track ends right after the jump');
    // off: the ending plays out
    await set('skipSilence', false); await play('G', { loop: false }); await sleep(13000);
    const t13 = await elProp('currentTime'); assert(t13 > 9 && t13 < 15 && !(await elProp('paused')), 'off → still playing through the silence at ' + t13.toFixed(1) + ' s (no jump)');
    eq((await snap()).routed, false, 'off and nothing else on → detached');
    await stopPlay();
  });

  scenario('harmonic-bass', async () => {
    // WP10 harmonic bass: a parallel branch off `bass` (lowpass 120 → x·|x|·0.8 + 0.2x → bandpass 180 Q 0.9 → 0..0.5)
    // summed with the direct path; its input is disconnected at 0. Band-limited: a 997 Hz tone gets nothing, a 50 Hz
    // tone gets harmonics; the direct path's level is untouched
    const branchPk = () => page.evaluate(async () => { const n = window.__sceAudioDebug().nodes().hGain; const p = await window.__afx.chanPeaks(n); return Math.max(p[0], p[1]); });
    await play('A', { loop: true });
    await audioTab();
    let r = await sliderByLabel('Harmonic bass'); eq(r.min + '..' + r.max + '/' + r.step, '0..100/5', 'range'); eq(r.val, 'Off', 'Off at 0'); assert(/double-click resets/.test(r.title), 'reset hint');
    const offDb = await dbg(`return d.meterTick().outDb;`);
    await sliderSet('Harmonic bass', 50); await sleep(350);
    eq(await get('bassHarm'), 50, 'slider writes bassHarm'); eq((await sliderByLabel('Harmonic bass')).val, '50%', '50%');
    let s = await snap(); approx(s.params.hGain.gain, 0.25, 0.001, 'gain 0.25 at 50'); eq(s.params.hLP.frequency, 120, 'lowpass 120'); approx(s.params.hLP.Q, -3.01, 0.001, 'Butterworth');
    eq(s.params.hBP.type, 'bandpass', 'bandpass'); eq(s.params.hBP.frequency, 180, '180 Hz'); approx(s.params.hBP.Q, 0.9, 0.001, 'Q 0.9');
    eq(s.params.hShape.hasCurve, true, 'shaper curve'); eq(s.params.hShape.oversample, 'none', 'no oversampling');
    eq(await dbg(`return d.branches.harm;`), true, 'branch connected'); eq(s.latencyMs, 12, 'no latency added');
    eq(await dbg(`return d.needsLimiter;`), true, 'the clip guard engages'); eq(s.guard.ceiling, guardCeil(s), 'guard ceiling'); eq(guardOn(s), true, 'guard on');
    await sleep(400); const onDb = await dbg(`return d.meterTick().outDb;`); approx(onDb, offDb, 0.1, 'a 997 Hz tone: the direct level is untouched');
    assert((await branchPk()) < -60, 'a 997 Hz tone yields nothing in the branch');
    // sub-bass: the branch carries harmonics
    await play('H', { loop: true }); await sleep(1000);   // let the new element actually flow before the 0.8 s read
    const hp = await branchPk(); assert(hp > -50 && hp < -20, '50 Hz at −6 dBFS: harmonics in the branch, ≈ −36 dBFS at gain 0.25 (' + hp.toFixed(1) + ' dBFS)');
    await sliderSet('Harmonic bass', 100); await sleep(300); s = await snap(); approx(s.params.hGain.gain, 0.5, 0.001, 'gain 0.5 at 100');
    const hp2 = await branchPk(); approx(hp2, hp + 6.02, 0.5, 'twice the gain, +6 dB');
    // off: gain 0, the branch input cut, silent
    await sliderReset('Harmonic bass'); await sleep(400);
    eq(await get('bassHarm'), 0, 'label double-click → 0'); s = await snap(); eq(s.params.hGain.gain, 0, 'gain 0');
    eq(await dbg(`return d.branches.harm;`), false, 'branch disconnected'); assert((await branchPk()) < -90, 'silent');
    await set('bassHarm', 30); await sleep(150); eq((await sliderByLabel('Harmonic bass')).val, '30%', 'a debug write repaints the row');
    await set('bassHarm', 0); await closeHub(); await sleep(150); eq((await snap()).routed, false, 'off, tab closed → detached');
    await stopPlay();
  });

  scenario('reverb', async () => {
    // WP10 reverb: a parallel ConvolverNode off the matrix output with a generated 1.6 s decorrelated-noise IR (built on
    // first use), wet ≤ 0.35, disconnected at 0; the "Slowed + reverb" chip bundles speed 85 · pitch follows speed ·
    // reverb 25 and a second tap undoes it
    const wetPk = () => page.evaluate(async () => { const n = window.__sceAudioDebug().nodes().rvWet; const p = await window.__afx.chanPeaks(n); return Math.max(p[0], p[1]); });
    await play('A', { loop: true });
    await audioTab();
    let r = await sliderByLabel('Reverb'); eq(r.min + '..' + r.max + '/' + r.step, '0..100/5', 'range'); eq(r.val, 'Off', 'Off at 0');
    eq(await dbg(`return d.ir;`), null, 'no IR until first use');
    await sliderSet('Reverb', 40); await sleep(350);
    eq(await get('reverbAmt'), 40, 'slider writes reverbAmt'); eq((await sliderByLabel('Reverb')).val, '40%', '40%');
    let s = await snap(); approx(s.params.rvWet.gain, 0.14, 0.001, 'wet 0.14 at 40'); eq(s.params.conv.normalize, true, 'normalized IR');
    const ir = await dbg(`return d.ir;`); approx(ir.sec, 1.6, 0.01, '1.6 s IR'); eq(ir.ch, 2, 'stereo IR'); assert(Math.abs(ir.corr) < 0.1, 'decorrelated channels (' + ir.corr + ')');
    eq(await dbg(`return d.branches.reverb;`), true, 'convolver connected'); eq(s.latencyMs, 12, 'no latency added');
    // a −23 dBFS tone through the seeded, normalized noise IR at wet 0.14 reads −45.9 dBFS (the IR is deterministic)
    await sleep(600); const wp = await wetPk(); assert(wp > -49 && wp < -43, 'the wet path carries the tone (' + wp.toFixed(1) + ' dBFS, want ≈ −45.9)');
    await sliderSet('Reverb', 100); await sleep(600); s = await snap(); approx(s.params.rvWet.gain, 0.35, 0.001, 'wet caps at 0.35');
    const wp100 = await wetPk(); approx(wp100, wp + 7.96, 0.6, 'wet 0.35 vs 0.14: +8 dB');
    await sliderReset('Reverb');
    for (let i = 0; i < 20; i++) { await sleep(100); s = await snap(); if (s.params.rvWet.gain === 0) break; }   // a 50 ms ramp; a stalled page may read late
    eq(await get('reverbAmt'), 0, 'label double-click → 0'); eq(s.params.rvWet.gain, 0, 'wet 0 (within 2 s)'); eq(await dbg(`return d.branches.reverb;`), false, 'convolver disconnected');
    assert((await wetPk()) < -90, 'silent');
    // the chip: a bundle in, a bundle out; the Speed and Reverb rows follow
    const chip = () => abody(`const b = [...a.querySelectorAll('button')].find((x) => x.textContent === 'Slowed + reverb'); return { bg: b.style.background, color: b.style.color };`);
    eq((await chip()).bg, 'rgba(255, 255, 255, 0.06)', 'chip unlit');
    await btnClick('Slowed + reverb'); await sleep(300);
    eq(await get('speed'), 85, 'speed 85'); eq(await get('vinylMode'), true, 'pitch follows speed'); eq(await get('reverbAmt'), 25, 'reverb 25');
    eq(await elProp('playbackRate'), 0.85, 'element at 0.85×'); eq(await elProp('preservesPitch'), false, 'pitch follows');
    s = await snap(); approx(s.params.rvWet.gain, 0.0875, 0.001, 'wet 0.0875'); eq(await dbg(`return d.branches.reverb;`), true, 'convolver back on');
    eq((await chip()).bg, 'rgba(255, 85, 0, 0.22)', 'chip lit'); eq((await chip()).color, 'rgb(255, 176, 131)', 'lit colour');
    eq((await sliderByLabel('Speed')).val, '0.85×', 'the Speed row follows'); eq((await sliderByLabel('Reverb')).val, '25%', 'the Reverb row follows');
    eq(await switchState('Pitch follows speed'), 'true', 'the vinyl switch follows');
    await btnClick('Slowed + reverb'); await sleep(300);
    eq(await get('speed'), 100, 'speed back to 100'); eq(await get('vinylMode'), false, 'pitch off'); eq(await get('reverbAmt'), 0, 'reverb off'); eq((await chip()).bg, 'rgba(255, 255, 255, 0.06)', 'chip unlit again');
    eq(await elProp('playbackRate'), 1, 'element at 1×');
    await closeHub(); await sleep(150); eq((await snap()).routed, false, 'all off, tab closed → detached');
    await stopPlay();
  });

  /* ═══════════ run ═══════════ */
  if (argv.includes('--list')) { scenarios.forEach((s) => console.log(s.name)); await ctx.close(); return; }
  console.log('loading soundcloud.com …');
  await page.goto('https://soundcloud.com/discover', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  try { const b = page.locator('#onetrust-accept-btn-handler'); if (await b.count()) await b.first().click({ timeout: 2000 }); } catch (e) {}
  try { const b = page.getByRole('button', { name: /set it up myself/i }); if (await b.count()) await b.first().click({ timeout: 3000 }); } catch (e) {}
  await sleep(1500);
  const bootErrors = pageerrors.length;
  if (bootErrors) console.log('page errors during load:\n  ' + pageerrors.join('\n  '));
  // leave the page in a known state before the first scenario
  try { await resetAudio(); } catch (e) {}
  for (const sc of scenarios) {
    if (ONLY.length && !ONLY.includes(sc.name)) continue;
    const errBefore = pageerrors.length;
    const t0 = Date.now();
    let failed = null;
    try { await sc.fn(); } catch (e) { failed = (e instanceof AssertError) ? e.message : ('exception: ' + (e && e.message ? e.message.split('\n')[0] : String(e))); }
    if (!failed && pageerrors.length > errBefore) failed = 'page errors: ' + pageerrors.slice(errBefore).join(' | ');
    if (!failed && bootErrors) failed = 'page errors during load: ' + pageerrors.slice(0, bootErrors).join(' | ');
    results.push({ name: sc.name, ok: !failed, msg: failed });
    console.log((failed ? 'FAIL ' : 'PASS ') + sc.name + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)' + (failed ? '\n  → ' + failed : ''));
    try { await closeHub(); await stopPlay(); await resetAudio(); } catch (e) {}
  }
  const nOk = results.filter((r) => r.ok).length;
  console.log(`\nSUMMARY: ${nOk}/${results.length} passed${results.length - nOk ? ' — FAILED: ' + results.filter((r) => !r.ok).map((r) => r.name).join(', ') : ''}; page errors: ${pageerrors.length}`);
  if (logs.length) console.log('console (first 20):\n  ' + logs.slice(0, 20).join('\n  '));
  await ctx.close();
  process.exit(nOk === results.length ? 0 : 1);
})().catch((e) => { console.error('HARNESS FAIL', e); process.exit(2); });
