// ==UserScript==
// @name         SoundCloud Suite — Lyrics + Shuffle
// @namespace    sc-supersuite
// @version      4.53.1
// @description  All-in-one SoundCloud enhancer: themes & declutter, player upgrades (speed, loop, volume memory), Genius-first lyrics hub (six sources, true sync + tap-along calibration, .lrc import/publish), and full-library crypto shuffle (cache, filters, goals, scrobbling) — one script, cross-wired.
// @author       you + bhackel
// @match        https://soundcloud.com/*
// @run-at       document-start
// @noframes
// @license      MIT
// @grant        unsafeWindow
// @grant        GM_info
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      lrclib.net
// @connect      genius.com
// @connect      api.genius.com
// @connect      itunes.apple.com
// @connect      soundcloud.com
// @connect      apic-desktop.musixmatch.com
// @connect      html.duckduckgo.com
// @connect      api.lyrics.ovh
// @connect      web.archive.org
// @connect      api.allorigins.win
// @connect      www.bing.com
// @connect      www.mojeek.com
// @connect      api.codetabs.com
// @connect      krcs.kugou.com
// @connect      lyrics.kugou.com
// @connect      music.163.com
// @connect      api.listenbrainz.org
// @connect      translate.googleapis.com
//
// Auto-updates: publish this file somewhere stable (GitHub raw / Greasy Fork)
// and add these two lines above with your real URL — Tampermonkey will then
// pick up new versions automatically:
//   @updateURL   https://example.com/soundcloud-suite.user.js
//   @downloadURL https://example.com/soundcloud-suite.user.js
// ==/UserScript==

/* ════════════════════ SOUNDCLOUD SUITE ═════════════════════════
 *
 *  ONE script, TWO engines, shared power.
 *
 *  INSTALL: enable this file and REMOVE/DISABLE both originals
 *  ("SuperLyrics for SoundCloud" and "soundcloud shuffle likes") —
 *  running them alongside the suite would double-patch fetch/XHR.
 *  All settings, caches, stats, blocklists and the lyric cache carry
 *  over automatically (same storage keys, nothing to migrate).
 *
 *  CROSS-WIRING (what the merge buys you)
 *  • One shared Worker ticker → lyric searches AND queue loading keep
 *    running at full speed in background tabs.
 *  • The shuffler's likes-library cache feeds canonical artist / title /
 *    duration straight into lyric matching — instant, zero network, and
 *    a big accuracy win on archive/leak uploads with junk titles.
 *  • Lyrics resolves tracks through the api-v2 client_id the shuffler
 *    sniffs — lighter and more exact than scraping the track page HTML.
 *  • The NEXT track in your shuffle queue gets its lyrics pre-warmed in
 *    the background → skipping ahead lands on an instant cache hit.
 *  • While the shuffle queue is loading, lyric searches wait their turn
 *    instead of fighting it for VPN connections.
 *  • Polite UI: Alt+S never opens lyric search, Esc closes the shuffle
 *    card before the lyrics panel, shuffle toasts slide left when the
 *    lyrics panel is open, and cards/toasts always render above it.
 *
 *  Hotkeys: Alt+L lyrics · Alt+S shuffle · Alt+B block current track ·
 *  panel open: S search, [ ] nudge sync, 0 reset, Esc close.
 * ═════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    /* ── suite bus: tiny shared surface between the two modules ── */
    const SUITE = {
        W: (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window,
        lyricsOpen: null, cardOpen: null, shuffleBusy: null,
        clientId: null, nextUp: null, libByUrl: null,
    };
    try { if (SUITE.W.__SCSUITE__) return; SUITE.W.__SCSUITE__ = true; } catch (e) {}
    // shared "is the page dark?" sniff. A transparent body (rgba(…,0)) used to
    // read as black → dark; walk up to <html>, then fall back to the OS scheme.
    SUITE.pageIsDark = () => {
        try {
            const rgb = (el) => {
                const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
                if (!m || m.length < 3 || (m.length >= 4 && +m[3] === 0)) return null;
                return m;
            };
            const m = rgb(document.body) || rgb(document.documentElement);
            if (m) return (+m[0] + +m[1] + +m[2]) / 3 < 110;
            return !!(matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
        } catch (e) { return false; }
    };

    // single source of truth for the displayed version — no more drift across the
    // header banner / "what's new" / diagnostics strings (which had silently
    // diverged to v4.23). Userscript managers fill GM_info from @version; the
    // extension's gm-shim injects it from the manifest. Fallback only if absent.
    const VER = (() => { try { return (GM_info && GM_info.script && GM_info.script.version) || ''; } catch (e) { return ''; } })() || '4.53.1';

    // lightweight error ring — most catch blocks swallow silently, which made
    // user-reported "it's broken" bugs un-diagnosable. Route key catches through
    // Log.err so the last ~60 failures are copyable (⋯ → Copy error log). Console
    // output only when the user opts into debug (localStorage 'scss:debug').
    const Log = (() => {
      const ring = [];
      let dbg = false; try { dbg = SUITE.W.localStorage.getItem('scss:debug') === '1'; } catch (e) {}
      const ts = () => { try { return new Date().toISOString().slice(11, 19); } catch (e) { return ''; } };
      // strip token-shaped substrings before exposing the ring on clipboard. The
      // ring should never have raw tokens today (callers log opaque errors), but
      // a future contributor's stack trace or URL could carry one — redaction
      // here is the last line of defense against an "I'll paste my log" leak.
      const redact = (s) => String(s == null ? '' : s)
        // Bearer/Basic FIRST so the standalone token gets redacted before the
        // Authorization rule strips the surrounding header (otherwise a token
        // immediately following "Authorization: Bearer" survives — the
        // Authorization rule stops at whitespace and the now-tokenless Bearer
        // rule can't recover).
        .replace(/(?:Bearer|Basic|OAuth|Token)\s+[A-Za-z0-9._\-+/=]{8,}/gi, (m) => m.split(/\s+/)[0] + ' ‹REDACTED›')
        // Authorization header value (anything not whitespace/punct) — the
        // Bearer rule above will have already neutralized any token; this
        // catches schemes we don't enumerate (Digest, OAuth1 header form, etc.).
        .replace(/Authorization\s*:\s*[^\s,;)"']+(?:\s+‹REDACTED›)?/gi, 'Authorization: ‹REDACTED›')
        // OAuth token format SC uses (2-app-USERID-…). Suffix can have _ and -.
        .replace(/OAuth\s+\d+-\d+-\d+-[A-Za-z0-9_\-]+/gi, 'OAuth ‹REDACTED›')
        // typical query-string token params; stop at the URL-component terminators
        // (today's [^&\s] kept reading through ; # " ' ) etc., spilling into the
        // adjacent text and producing oversized REDACTED captures).
        .replace(/([?&](?:client_id|token|access_token|user_token|usertoken|api_key|apikey|key)=)[^&\s;#"')<>,}\]]+/gi, '$1‹REDACTED›')
        // JSON-body token forms ({"access_token":"…"} from MXM/LB responses).
        .replace(/(["'](?:client_id|token|access_token|user_token|usertoken|api_key|apikey|key)["']\s*[:=]\s*["'])[^"']+/gi, '$1‹REDACTED›')
        // long opaque strings that look like Genius / MXM API tokens (≥40 chars)
        // — but never touch data:/blob: URIs which routinely contain long base64
        // chunks in stack traces and CSS attribute values. The \b boundary breaks
        // for leading/trailing '-' and '_', so use an explicit non-token guard.
        .replace(/(^|[^A-Za-z0-9_\-])([A-Za-z0-9_\-]{40,})(?=$|[^A-Za-z0-9_\-])/g, (m, lead, body, offset, full) => {
          const before = full.slice(Math.max(0, offset - 8), offset + lead.length);
          if (/(?:data:|blob:|;base64,)/i.test(before)) return m;
          if ((body.match(/-/g) || []).length >= 3) return m;   // a track or page slug, not a token
          return lead + '‹REDACTED-' + body.length + 'ch›';
        });
      // session-scoped counter map for "I want to know how often X happened
      // without writing a full error". Diagnostics view can render this; "Copy
      // error log" already redacts the strings around it. Counts are never
      // persisted — fresh page = fresh counters.
      const metrics = Object.create(null);
      return {
        err(where, e) {
          try { ring.push(ts() + '  ' + where + ': ' + ((e && (e.message || e.name)) || e)); if (ring.length > 60) ring.shift(); } catch (x) {}
          if (dbg) { try { console.warn('[SoundCloud Suite]', where, e); } catch (x) {} }
        },
        note(s) { try { ring.push(ts() + '  · ' + s); if (ring.length > 60) ring.shift(); } catch (x) {} },
        metric(name, by) { try { metrics[name] = (metrics[name] || 0) + (by == null ? 1 : +by); } catch (x) {} },
        metrics() { return Object.assign({}, metrics); },
        dump() {
          const m = Object.keys(metrics);
          const mline = m.length ? '\nmetrics: ' + m.map((k) => k + '=' + metrics[k]).join(', ') : '';
          return ring.length ? redact(ring.join('\n') + mline) : ('(no errors logged this session)' + mline);
        },
        redact,   // exposed so other clipboard sinks (Copy sync debug, etc.) reuse the same scrubber
      };
    })();

    /* ── shared Worker-pool ticker: background-tab-proof timers ── */
    const Ticker = (() => {
        let worker = null, seq = 0;
        const subs = new Map();
        function ensure() {
            if (worker !== null) return worker;
            try {
                const src = 'const t={};onmessage=e=>{const d=e.data;'
                    + 'if(d.cmd==="start"){t[d.id]=setInterval(()=>postMessage(d.id),d.ms)}'
                    + 'else if(d.cmd==="stop"&&t[d.id]!=null){clearInterval(t[d.id]);delete t[d.id]}};';
                const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
                const w = new Worker(url);
                w.onmessage = (e) => { const fn = subs.get(e.data); if (fn) { try { fn(); } catch (err) {} } };
                w.onerror = () => {};
                worker = w; // lives for the page lifetime; one blob URL total
            } catch (e) { worker = false; }
            return worker;
        }
        const every = (fn, ms) => {
            const w = ensure();
            if (w) {
                const id = ++seq;
                subs.set(id, fn);
                try { w.postMessage({ cmd: 'start', id, ms }); } catch (e) {}
                return { stop() { subs.delete(id); try { w.postMessage({ cmd: 'stop', id }); } catch (e) {} } };
            }
            const iid = setInterval(fn, ms);
            return { stop() { clearInterval(iid); } };
        };
        const after = (fn, ms) => {
            let fired = false;
            const h = every(() => {
                if (fired) return;
                fired = true;
                h.stop();
                try { fn(); } catch (e) {}
            }, Math.max(20, (ms | 0) || 1));
            return { stop() { fired = true; h.stop(); } };
        };
        return { every, after, usingWorker: () => !!ensure() };
    })();

/* ═══════════════════ MODULE 1 · SHUFFLE (bhackel v8.0) ═══════════════════ */

/* ─────────────────────────────── USAGE ───────────────────────────────
 *
 *  • "Shuffle Play" on Likes pages & playlists (Alt+S works anywhere).
 *    Click again while loading to cancel.
 *  • Player bar: bolt = shuffle your Likes from any page, bars = stats.
 *  • Sliders icon next to Shuffle Play = settings (auto-saved).
 *
 *  THE FLOW (unchanged from v7 — simple and honest)
 *  -------------------------------------------------
 *    1. FETCH  — pulls your ENTIRE likes library straight from the API
 *                (500 per request, auto step-down, retry with backoff).
 *                The library is cached on disk: refreshes and reopened
 *                tabs shuffle instantly, new likes merge in the
 *                background, and a full refetch happens every cacheHours
 *                (settings · default 24 h · 0 disables the cache).
 *    2. SHUFFLE — one global crypto-grade shuffle with your filters,
 *                blocklist, fresh-picks, queue cap and artist-spreading.
 *    3. LOAD   — the whole pre-shuffled queue is filled locally and the
 *                button counts up to the EXACT total.
 *    4. PLAY   — instantly: music starts as soon as the first shuffled
 *                page is in the queue, while the rest streams in behind.
 *                Completion is still verified — the button counts to the
 *                exact total and short runs get an honest warning, never
 *                a fake checkmark. (Prefer the old wait-for-everything
 *                behavior? Turn off "Instant playback" in settings.)
 *  Playlists & Discover (and any failure on Likes) automatically use the
 *  compatibility loader instead.
 *
 *  Suite build: patches fetch/XHR through unsafeWindow (grants enabled
 *  for the lyrics module). Everything is stored locally. Settings → Export to back up.
 *
 *  CHANGELOG
 *  ---------
 *  8.0  Reliability: centralized selector map with fallbacks + self-test
 *       (CFG.debug), median-based queue counting, feed-served counts used
 *       as the source of truth for completion/reporting, tightened feed
 *       arming so stray requests can't hijack page 0, retry with
 *       exponential backoff + Retry-After on 429/5xx, partial-fetch
 *       salvage, cookie-based auth fallback, auth-capture wait, shared
 *       Worker pool for background-proof timers (with a heads-up when CSP
 *       blocks Workers), API-origin guard on the captured OAuth header.
 *       Playback: instant playback by default (music starts once the
 *       first page lands; the rest loads behind, still fully verified),
 *       unplayable filter now fails OPEN — only region-blocked/removed
 *       tracks are dropped, never Go+ catalog (previously this could
 *       silently shrink a big library), likes templates are page-local so
 *       another profile's endpoint can never be replayed, ended sessions
 *       serve sealed empty pages instead of leaking to the real API,
 *       auto-skip for tracks that refuse to start, sleep timer, no-repeat
 *       no longer wipes your heard history when a small list runs dry.
 *       Library: persistent IndexedDB cache of your full likes library —
 *       refresh the page and shuffle instantly, new likes synced in the
 *       background, full refetch on a schedule you control (default 24 h),
 *       queue size cap (uniform sample of the full shuffle), in-session
 *       reshuffle without refetching, "rediscover older likes" weighted
 *       order, artist/track blocklist.
 *       Stats: now-playing hero with live equalizer + one-tap block,
 *       7-day listening sparkline with streaks, top artists, up-next
 *       preview + copy queue, real titles on the repeat/skip lists,
 *       configurable played-threshold. Smart touches: rapid-skip
 *       reshuffle nudge (tap the toast), Alt+B blocks & skips the
 *       current track, the sleep timer fades out over ~8 s like a
 *       candle. Data: export/import backup of settings, history,
 *       stats, blocklist and daily listening.
 *       UI: keyboard-accessible switches, focus rings, reduced-motion
 *       support, scrollable cards, throttled progress repaints,
 *       what's-new toast. Optional experimental "start while loading".
 *  7.0  Simplified linear engine: fetch everything, shuffle, load, play.
 *  6.0  Trustworthy completion logic, aligned icon set, hardening.
 *  5.0  Parallel pipeline, glassy minimal UI.
 *  4.0  Player-bar buttons, stats panel, caching, prefetch.
 *  3.0  Pro engine, filters, fresh-picks rotation, artist spreading.
 *  2.0  Boosted pagination, event-driven loading.
 *  1.7  Original by bhackel.
 * ──────────────────────────────────────────────────────────────────────*/

(function () {
    'use strict';

    /* ───────────────────────── SETTINGS / CONFIG ───────────────────────── */
    const DEFAULTS = {
        spreadArtists: true,
        noRepeat: false,
        autoSkipStuck: true,     // skip tracks that refuse to start
        smartSuggest: true,      // offer a reshuffle after a burst of rapid skips
        orderMode: 'random',     // 'random' | 'rediscover'
        filterMode: 'all',       // 'all' | 'songs' | 'mixes'
        filterMinutes: 20,
        genreFilter: [],         // shuffle only these genres ([] = everything)
        likedDays: 0,            // only tracks liked in the last N days (0 = any time)
        skipUnplayable: true,    // drop region-blocked / removed / preview-only
        sampleCap: 0,            // 0 = whole library, else queue at most N tracks
        silentSetup: true,
        cacheHours: 24,          // keep the fetched library on disk this long (0 = always refetch)
        earlyStart: true,        // start playing once the first page lands; the rest loads behind
        playThresholdSec: 30,    // listening this long counts as "played"
        boostedLimit: 200,       // compatibility-engine pagination boost
        feedPageSize: 500,       // tracks per locally-served queue page
        tickMs: 100,
        stallKickTicks: 8,
        stallDoneTicks: 90,      // ~9 s hard stall (last resort)
        debug: false,
        _v: 0,
        _r: 0,                   // config revision within v8
    };
    const LS = {
        get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
        del(k) { try { localStorage.removeItem(k); } catch (e) {} },
    };
    const SS = {
        get(k, fb) { try { const v = sessionStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } },
        set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
        del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
    };
    const saved = LS.get('bh_sc_cfg', {});
    const prevV = typeof saved._v === 'number' ? saved._v : 0;
    const CFG = Object.assign({}, DEFAULTS, saved);
    if (!saved.filterMode) {
        if (saved.maxMinutes > 0) { CFG.filterMode = 'songs'; CFG.filterMinutes = saved.maxMinutes; }
        else if (saved.minMinutes > 0) { CFG.filterMode = 'mixes'; CFG.filterMinutes = saved.minMinutes; }
    }
    // Clamp anything a hand-edited config (or an imported backup) could push
    // out of safe bounds — runs at boot AND after every import.
    function clampCfg() {
        CFG.feedPageSize = Math.min(500, Math.max(100, (CFG.feedPageSize | 0) || 500));
        CFG.boostedLimit = Math.min(500, Math.max(50, (CFG.boostedLimit | 0) || 200));
        CFG.playThresholdSec = Math.min(300, Math.max(5, (CFG.playThresholdSec | 0) || 30));
        CFG.sampleCap = Math.max(0, (CFG.sampleCap | 0) || 0);
        CFG.cacheHours = Math.min(168, Math.max(0, CFG.cacheHours | 0));
        if (CFG.orderMode !== 'rediscover') CFG.orderMode = 'random';
        if (CFG.filterMode !== 'songs' && CFG.filterMode !== 'mixes') CFG.filterMode = 'all';
        CFG.filterMinutes = Math.min(600, Math.max(1, (CFG.filterMinutes | 0) || 20));
        if (!Array.isArray(CFG.genreFilter)) CFG.genreFilter = [];
        CFG.genreFilter = CFG.genreFilter.filter(g => typeof g === 'string' && g).slice(0, 30);
        CFG.likedDays = Math.min(3650, Math.max(0, CFG.likedDays | 0));
        // loader timing has no UI, but an imported backup can carry anything
        CFG.tickMs = Math.min(1000, Math.max(20, (CFG.tickMs | 0) || 100));
        CFG.stallKickTicks = Math.min(1000, Math.max(1, (CFG.stallKickTicks | 0) || 8));
        CFG.stallDoneTicks = Math.min(10000, Math.max(10, (CFG.stallDoneTicks | 0) || 90));
    }
    clampCfg();
    const prevR = saved._r | 0;
    if (prevV === 8 && prevR < 2) CFG.earlyStart = true;   // one-time: instant playback became the default
    if (CFG._v !== 8 || CFG._r !== 2) { CFG._v = 8; CFG._r = 2; LS.set('bh_sc_cfg', CFG); }
    const SHOW_UPDATE_NOTE = prevV > 0 && prevV < 8;
    const saveCfg = () => LS.set('bh_sc_cfg', CFG);
    const log = (...a) => CFG.debug && console.log('[SC-Shuffle]', ...a);
    // Most failures here are non-fatal by design — but never invisible in debug mode.
    const swallow = (e, ctx) => { if (CFG.debug) console.warn('[SC-Shuffle]', ctx || '', e); };

    /* Timings that used to live inline — tune in one place. */
    const T = {
        seedClickWait: 2500, seedSwapWait: 2000, queueAppear: 4000,
        feedConsume1: 1600, feedConsume2: 2400, queueReopenPause: 180,
        menuWait: 1500, playVerify: 1800, autorunWait: 12000,
        authWait: 5000, fetchGuard: 400, fetchRetries: 4,
        stuckAfterMs: 10000, stuckMinCT: 0.8, sleepGraceMs: 8 * 60000,
        libReuseMs: 30 * 60000, itemRemeasureMs: 5000,
    };

    /* ─────────────── SELECTORS (single source of truth) ───────────────
     * Every SoundCloud class name lives here, each with ordered fallbacks.
     * When SoundCloud redesigns, fix it here once; run selfTest() (auto in
     * debug mode, or window.__scShuffle.selfTest()) to see what broke.
     * Note: list/page selectors are only present on their own pages. */
    const SEL = {
        playControl:      ['.playControl'],
        skipNext:         ['.skipControl__next'],
        shuffleControl:   ['.shuffleControl'],
        queue:            ['.queue'],
        queueToggle:      ['.playbackSoundBadge__queueCircle'],
        queueScrollable:  ['.queue__scrollableInner'],
        queueHeights:     ['.queue__itemsHeight'],
        queueItem:        ['.queue__itemWrapper', '.queueItemView'],
        queueFallback:    ['.queue__fallback'],
        badgeTitle:       ['.playbackSoundBadge__titleLink'],
        playButton:       ['.playButton'],
        rowTitle:         ['a.soundTitle__title', '.soundTitle__title a'],
        moreButton:       ['.sc-button-more'],
        addToNextUp:      ['.moreActions__button.addToNextUp'],
        likesList:        ['.lazyLoadingList__list'],
        playlistList:     ['.trackList__list'],
        discoverList:     ['.systemPlaylistTrackList__list'],
        collectionTop:    ['.collectionSection__top'],
        userTabs:         ['.userNetworkTabs'],
        discoverControls: ['.systemPlaylistDetails__controls'],
        soundActions:     ['.soundActions'],
        barHost:          ['.playControls__elements', '.playControls'],
        tabsItems:        ['.g-tabs-item', '.g-tabs-link'],
        trackCount:       ['.genericTrackCount__title'],
    };
    function q(key, root) {
        const list = SEL[key] || [key];
        for (const s of list) { const el = (root || document).querySelector(s); if (el) return el; }
        return null;
    }
    function qa(key, root) {
        const list = SEL[key] || [key];
        for (const s of list) { const els = (root || document).querySelectorAll(s); if (els.length) return els; }
        return [];
    }
    function selfTest() {
        const report = {}; let missing = 0;
        for (const k of Object.keys(SEL)) { const ok = !!q(k); report[k] = ok; if (!ok) missing++; }
        try {
            console.groupCollapsed('[SC-Shuffle] selector self-test — ' + missing + ' not found on this page (page-specific ones are expected to be absent elsewhere)');
            console.table(report);
            console.groupEnd();
        } catch (e) { console.log('[SC-Shuffle] selfTest', report); }
        return report;
    }

    /* ───────────────────────────── STATE ────────────────────────────── */
    const S = {
        active: false, cancelled: false, startedAt: 0,
        boosting: false, boostFails: 0, endSeen: false,
        expected: 0, poolSize: 0,
        btn: null, ticker: null, mo: null,
        mutedByUs: [], muteWatch: null, queueHidden: false,
        itemH: 0, itemHAt: 0, total: null,
        startTime: 0, startCount: 0, lastCount: 0, stall: 0,
        playingStarted: false, beganPlayback: false, earlyBegun: false, seeded: false,
        auth: null, clientId: null, tpl: null,
        apiFails: 0, apiNoticeShown: false,   // R23: api-v2 degradation watchdog (see ApiHealth)
        fetchAbort: null,
        sessionLib: null, sessionLibAt: 0, sessionLibKey: '',
        poolList: null,   // [{u,t,a,ai}] order of the last shuffle, for Up next / copy queue
        poolIdx: null,    // url → position in poolList (O(1) Up-next lookups)
        prevPoolList: null, prevPoolIdx: null, poolAssigned: false,   // cancel() decides which pool survives
        lastRunPath: '',  // where the last shuffle started, for context-aware reshuffle
    };
    const F = { active: false, armed: false, sid: '', pages: [], served: 0 };
    const W = { last: 0, href: null, curMs: 0, saveTick: 0, stuckMs: 0, stuckKicks: 0 };

    const sess = Object.assign({ start: Date.now(), listenMs: 0, played: 0, skipped: 0 }, SS.get('bh_sc_sess', {}));
    const allTime = Object.assign({ listenMs: 0, played: 0 }, LS.get('bh_sc_alltime', {}));
    const daily = LS.get('bh_sc_daily', {});   // 'YYYY-MM-DD' → listened ms (last ~3 weeks)
    const hourly = LS.get('bh_sc_hours', {});  // '0'..'23' → lifetime listened ms per hour of day
    function localDayKey(offsetDays) {
        const d = new Date(Date.now() - (offsetDays || 0) * 86400000);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    let skipTimes = [], lastSuggestAt = 0;     // rapid-skip "not feeling it?" nudge
    let endNudgeAt = 0;                        // end-of-queue "reshuffle?" nudge
    let lastBlockNudgeAt = 0;                  // "skipped it again — block it?" nudge
    let fading = false;                        // sleep-timer fade-out in progress
    let sleepAt = SS.get('bh_sc_sleep', 0) || 0;
    let sleepArmed = false;

    const $ = (sel, root) => (root || document).querySelector(sel);
    const clickIt = el => { if (el) { el.click(); return true; } return false; };
    // take keyboard focus only when nothing else owns it — never mid-word in a field, a menu or the hub
    const focusIdle = el => { const ae = document.activeElement; if (el && (!ae || ae === document.body || ae === S.btn)) el.focus(); };
    const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
    const fmtH = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
    const fmtTime = ms => { const m = Math.floor(ms / 60000); if (m < 1) return '<1m'; if (m < 60) return m + 'm'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
    const ago = ts => {
        const m = Math.round((Date.now() - ts) / 60000);
        if (m < 1) return 'now';
        if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60);
        if (h < 24) return h + 'h ago';
        return Math.floor(h / 24) + 'd ago';
    };

    /* ───────────── Compact library accessor (memoized) ─────────────
     * bh_sc_lib holds [id, url, durMs, artistId, artist, title] tuples for
     * the whole likes library — up to ~1 MB of JSON. It used to be re-parsed
     * and linearly scanned on every lookup (every 2s watcher tick, every
     * lyric search, every Alt+B). Parse once into a url→tuple Map; the only
     * writers (saveCompactCache / Forget) invalidate it. */
    let LIBMAP = null;
    function invalidateLibMap() { LIBMAP = null; }
    // another tab rewriting bh_sc_lib must not leave this tab's map stale
    try { window.addEventListener('storage', e => { if (!e || e.key === null || e.key === 'bh_sc_lib') invalidateLibMap(); }); } catch (e) {}
    function getLibMap() {
        if (LIBMAP) return LIBMAP;
        const c = LS.get('bh_sc_lib', null);
        if (!c || !c.items) return null;
        const m = new Map();
        for (const it of c.items) m.set(it[1], it);
        m.__items = c.items;
        LIBMAP = m;
        return m;
    }

    /* ───────────── Blocklist + per-track play counts (local) ───────────── */
    const BLOCK_KEY = 'bh_sc_block';
    const loadBlock = () => {
        const b = Object.assign({ tracks: [], urls: [], artists: [] }, LS.get(BLOCK_KEY, {}));
        for (const k of ['tracks', 'urls', 'artists']) if (!Array.isArray(b[k])) b[k] = [];   // hand-edited storage or an odd backup
        return b;
    };
    const saveBlock = b => LS.set(BLOCK_KEY, b);
    const PLAYS_KEY = 'bh_sc_plays';
    function bumpPlay(url, kind) {
        try {
            const m = LS.get(PLAYS_KEY, {});
            const e = m[url] || [0, 0];
            if (kind === 'p') e[0]++; else e[1]++;
            m[url] = e;
            const keys = Object.keys(m);
            if (keys.length > 600) { // keep the map small: prune the least active
                keys.sort((a, b) => (m[a][0] + m[a][1]) - (m[b][0] + m[b][1]));
                for (let i = 0; i < 150; i++) delete m[keys[i]];
            }
            LS.set(PLAYS_KEY, m);
        } catch (e) { swallow(e, 'bumpPlay'); }
    }

    /* ───────────── Broken-likes register (dead / geo-blocked / won't start) ─────────────
     * The shuffler already KNOWS which likes can't play — it used to throw
     * that away as a toast count. Keep the list so the user can clean up. */
    const BROKEN_KEY = 'bh_sc_broken';
    function recordBroken(items) {
        try {
            if (!items || !items.length) return;
            const cur = LS.get(BROKEN_KEY, []);
            const seen = new Set(cur.map(x => x.u));
            for (const x of items) if (x.u && !seen.has(x.u)) { seen.add(x.u); cur.push(x); }
            LS.set(BROKEN_KEY, cur.slice(-200));
        } catch (e) { swallow(e, 'recordBroken'); }
    }

    /* ───────────── ListenBrainz scrobbler (off until a token is set) ─────────────
     * Fires at the same moment a track "counts as played"; queued in LS and
     * retried so flaky connections never lose listens. Token lives in GM
     * storage (Tampermonkey: private; extension build: soundcloud.com
     * localStorage under the scssgm: prefix). */
    const LB_QKEY = 'bh_sc_lbq';
    const lbToken = () => { try { return GM_getValue('bh:lbtok', '') || ''; } catch (e) { return ''; } };
    function lbSubmit(listens) {
        return new Promise((resolve, reject) => {
            try {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: 'https://api.listenbrainz.org/1/submit-listens',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Token ' + lbToken() },
                    data: JSON.stringify({ listen_type: 'import', payload: listens }),
                    timeout: 10000,
                    anonymous: true,
                    onload: r => { if (r.status >= 200 && r.status < 300) return resolve(); const err = new Error('lb ' + r.status); err.status = r.status; reject(err); },
                    onerror: () => reject(new Error('lb neterr')),
                    ontimeout: () => reject(new Error('lb timeout')),
                });
            } catch (e) { reject(e); }
        });
    }
    let lbFlushing = false;
    let lbBadTok = '';   // a token ListenBrainz rejected — no more flushes until it changes
    function lbFlush() {
        if (lbFlushing || !lbToken() || lbToken() === lbBadTok) return;
        const q = LS.get(LB_QKEY, []);
        if (!q.length) return;
        lbFlushing = true;
        const batch = q.slice(0, 25);
        const sentKey = x => x.listened_at + '|' + (((x.track_metadata || {}).additional_info || {}).origin_url || '');
        lbSubmit(batch).then(() => {
            // remove by IDENTITY, not position — a second tab flushing the same
            // queue (or a new scrobble landing mid-flight) must never make the
            // positional slice discard listens that were never submitted
            const sent = new Set(batch.map(sentKey));
            const rest = LS.get(LB_QKEY, []).filter(x => !sent.has(sentKey(x)));
            LS.set(LB_QKEY, rest);
            lbFlushing = false;
            if (rest.length) setTimeout(lbFlush, 4000);
        }).catch(e => {
            lbFlushing = false;
            const st = e && e.status;
            if (st === 401 || st === 403) {
                // bad or expired token: say so once and keep the listens queued for a working one
                lbBadTok = lbToken();
                showToast('ListenBrainz token rejected — check it in Tweaks');
            } else if (st === 400) {
                // a listen ListenBrainz refuses would block every newer one behind it — drop the batch
                const sent = new Set(batch.map(sentKey));
                LS.set(LB_QKEY, LS.get(LB_QKEY, []).filter(x => !sent.has(sentKey(x))));
            }
            swallow(e, 'lbFlush');
        });
    }
    function lbScrobble(url) {
        try {
            if (!lbToken()) return;
            const lm = getLibMap();
            const hit = lm && lm.get(url);
            if (!hit || !hit[4] || !hit[5]) return;   // LB needs artist + title — library tracks have both
            // prefer full-fidelity names from the session library — the compact
            // tuples truncate artist/title and would pollute the LB history
            let artist = hit[4], title = hit[5];
            if (S.sessionLib) {
                const full = S.sessionLib.find(it => (it.track.permalink_url || '').split('?')[0] === url);
                if (full) {
                    artist = (full.track.user && full.track.user.username) || artist;
                    title = full.track.title || title;
                }
            }
            const q = LS.get(LB_QKEY, []);
            q.push({
                listened_at: Math.round(Date.now() / 1000),
                track_metadata: {
                    artist_name: artist, track_name: title,
                    additional_info: { origin_url: url, music_service: 'soundcloud.com', submission_client: 'SoundCloud Suite', duration_ms: hit[2] || undefined },
                },
            });
            LS.set(LB_QKEY, q.slice(-50));
            lbFlush();
        } catch (e) { swallow(e, 'lbScrobble'); }
    }

    /* ════════════════════════ NETWORK LAYER ════════════════════════
     *  1. SNIFF  – learn the page's api-v2 client_id, OAuth header, and a
     *              template likes request to replay for the full fetch.
     *  2. FEED   – while a shuffle is loading, answer the queue's
     *              track_likes pagination locally with pre-shuffled pages.
     *  3. BOOST  – compatibility engine: raise limit≈30 → 200.
     *  4. END    – spot next_href == null so loaders can finish instantly. */
    const LIKES_RE = /api-v2\.soundcloud\.com\/[^?]*track_likes/;
    const BOOSTABLE = /api-v2\.soundcloud\.com\/[^?]*(?:track_likes|playlists\/\d+\/tracks)/;
    const API_RE = /api-v2\.soundcloud\.com\//;
    const SC_API_ORIGIN = /^https:\/\/api(?:-v2)?\.soundcloud\.com\//;
    // The captured OAuth header must never travel anywhere but SoundCloud's API.
    function assertScApi(u) { if (!SC_API_ORIGIN.test(u)) throw new Error('refusing non-SoundCloud URL: ' + u); }
    function cookieAuth() {
        try {
            const m = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/);
            return m ? 'OAuth ' + decodeURIComponent(m[1]) : null;
        } catch (e) { return null; }
    }
    /* The user id rides inside SC's OAuth token ("2-app-USERID-…") — use it to
     * key the cached library per account, so switching accounts never shuffles
     * the other account's likes. Empty string = legacy shared key. */
    function userTag() {
        try {
            const a = S.auth || cookieAuth() || '';
            const m = String(a).match(/OAuth\s+\d+-\d+-(\d+)-/);
            return m ? m[1] : '';
        } catch (e) { return ''; }
    }
    function ownLibKey() { const t = userTag(); return 'Likes:you' + (t ? '@' + t : ''); }

    function sniffUrl(url, method) {
        try {
            if (!API_RE.test(url)) return;
            const u = new URL(url, location.href);
            const cid = u.searchParams.get('client_id');
            if (cid) S.clientId = cid;
            // template only a GET of the likes COLLECTION: a like/unlike PUT/DELETE
            // (…/track_likes/<id>) or /me/track_likes/ids would poison the replay
            if ((method || 'GET').toUpperCase() === 'GET' && LIKES_RE.test(url) && /\/track_likes\/?$/.test(u.pathname) && !u.searchParams.has('bh_sid')) S.tpl = u.href;
        } catch (e) { swallow(e, 'sniffUrl'); }
    }
    function sniffHeaders(headers) {
        try {
            if (!headers) return;
            let a = null;
            if (typeof headers.get === 'function') a = headers.get('Authorization') || headers.get('authorization');
            else a = headers.Authorization || headers.authorization;
            if (a) S.auth = a;
        } catch (e) { swallow(e, 'sniffHeaders'); }
    }
    function sniffBodyForEnd(json) {
        try { if (json && 'collection' in json && !json.next_href) S.endSeen = true; } catch (e) {}
    }

    /* ──────────────────────── R23 · API HEALTH WATCHDOG ────────────────────
     * Today every api-v2 failure (client_id never sniffed, endpoint moved,
     * resolve 404s) degrades silently — features just stop working. Surface
     * it ONCE per page load via the standard toast, with a Copy-error-log
     * action so a user-reported "it's broken" comes with diagnostic context.
     *
     * Two fire conditions, both narrow on purpose to avoid noise:
     *  • cold:      30s after boot we still have no client_id / template URL
     *               (the sniffer never saw an api-v2 call — strongest signal
     *               that SC changed how it makes requests).
     *  • endpoints: 3 consecutive api-v2 responses with status 404 or ≥500
     *               while a client_id IS set (auth 401/403 deliberately
     *               excluded — that's a logged-out user, not an API change).
     */
    const ApiHealth = (() => {
        const FAIL_LIMIT = 3, COLD_DELAY = 30000;
        function notice(reason) {
            if (S.apiNoticeShown) return;
            S.apiNoticeShown = true;
            try { Log.note('api-v2 degraded · ' + reason + ' · cid=' + (S.clientId ? 'set' : 'none') + ' · fails=' + S.apiFails); } catch (e) {}
            const msg = 'SoundCloud API may have changed';
            const sub = reason === 'cold'
                ? 'No client_id seen yet — shuffle, track info & downloads need it. Reload; if it persists, check for a Suite update.'
                : 'Calls to api-v2 keep failing — features that depend on it may be degraded right now.';
            try { showToast(msg, sub, { label: 'Copy log', fn: () => { try { GM_setClipboard(Log.dump()); } catch (e) {} } }); } catch (e) {}
        }
        return {
            markFail(status) {
                // only count "endpoint moved / server broken" signals; auth (401/403)
                // and rate limits (429) are normal user states, not API changes.
                if (status !== 404 && status < 500) return;
                if (!S.clientId) return;   // cold-path is handled by the watchdog timer
                S.apiFails++;
                if (S.apiFails >= FAIL_LIMIT) notice('endpoints');
            },
            markOk() { S.apiFails = 0; },
            armColdCheck() {
                setTimeout(() => {
                    try { if (!S.clientId && !S.tpl) notice('cold'); } catch (e) {}
                }, COLD_DELAY);
            },
        };
    })();

    function mkNextHref(page) {
        const base = new URL(S.tpl || `https://api-v2.soundcloud.com/me/track_likes?client_id=${S.clientId || ''}&limit=${CFG.boostedLimit}&linked_partitioning=1`);
        base.searchParams.set('limit', String(CFG.boostedLimit));
        base.searchParams.set('bh_sid', F.sid);
        base.searchParams.set('bh_page', String(page));
        return base.href;
    }
    function feedBody(page) {
        const dead = page < 0;
        const coll = (!dead && F.active && F.pages[page]) || [];
        const last = dead || page + 1 >= F.pages.length;
        if (coll.length) F.served += coll.length;
        if (last && !dead) S.endSeen = true;
        log('feed page', page, coll.length, last ? '(last)' : '');
        return JSON.stringify({ collection: coll, next_href: (last || !F.active) ? null : mkNextHref(page + 1), query_urn: null });
    }
    /* The "armed" hand-off claims the queue's FIRST real pagination request
     * as page 0. v8: only claim it when the request targets the same likes
     * endpoint we templated (path match), so a stray track_likes call from
     * another widget can't hijack the shuffled order. */
    function resolveFeed(url) {
        try {
            if (!LIKES_RE.test(url)) return null;
            const u = new URL(url, location.href);
            const sid = u.searchParams.get('bh_sid');
            if (sid) {
                // Ours, always. After a run ends, serve an empty terminal page
                // rather than letting our minted URLs hit the real API and
                // append chronological junk to the queue tail.
                if (F.active && sid === F.sid) return parseInt(u.searchParams.get('bh_page'), 10) || 0;
                return -1;
            }
            if (F.active && F.armed) {
                if (S.tpl) {
                    try { if (new URL(S.tpl).pathname !== u.pathname) return null; } catch (e) {}
                }
                F.armed = false;
                return 0;
            }
        } catch (e) { swallow(e, 'resolveFeed'); }
        return null;
    }
    const jsonResponse = body => new PResponse(body, { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } });

    function boostUrl(url) {
        if (!S.boosting || S.boostFails >= 2 || typeof url !== 'string') return url;
        try {
            if (!BOOSTABLE.test(url)) return url;
            const u = new URL(url, location.href);
            const lim = parseInt(u.searchParams.get('limit'), 10);
            if (!lim || lim >= CFG.boostedLimit) return url;
            u.searchParams.set('limit', String(CFG.boostedLimit));
            return u.href;
        } catch (e) { return url; }
    }

    /* Suite build: all page-level patching goes through SUITE.W (the real
     * page window). The merged script runs in Tampermonkey's sandbox
     * (grants are needed for the lyrics module), where plain `window` is
     * a wrapper — patching that would do nothing. */
    const PW = SUITE.W;
    const PResponse = PW.Response || Response;
    const PRequest = PW.Request || Request;
    const origFetch = PW.fetch.bind(PW);
    PW.fetch = function (input, init) {
        let rawUrl = '';
        try {
            const isReq = !!(input && typeof input === 'object' && typeof input.url === 'string');
            rawUrl = isReq ? input.url : String(input);
            const reqMethod = String((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
            sniffUrl(rawUrl, reqMethod);
            if (API_RE.test(rawUrl)) sniffHeaders(isReq ? input.headers : (init && init.headers));

            // only the queue's GET pagination is ours to answer — a like/unlike
            // PUT/DELETE on a track_likes path must always reach SoundCloud
            const page = reqMethod === 'GET' ? resolveFeed(rawUrl) : null;
            if (page !== null) {
                let body;
                // a feed bug must fail CLOSED: a sealed empty page, never a
                // fall-through to the real API with our minted bh_sid URL
                try { body = feedBody(page); }
                catch (e2) { swallow(e2, 'feedBody'); body = '{"collection":[],"next_href":null,"query_urn":null}'; }
                return Promise.resolve(jsonResponse(body));
            }

            const boosted = boostUrl(rawUrl);
            if (boosted !== rawUrl) {
                const fallback = () => origFetch(input, init);
                const p = isReq ? origFetch(new PRequest(boosted, input), init)
                                : origFetch(boosted, init);
                return p.then(res => {
                    if (res && res.status >= 400) { S.boostFails++; return fallback(); }
                    try { res.clone().json().then(sniffBodyForEnd).catch(() => {}); } catch (e) {}
                    try { ApiHealth.markOk(); } catch (e) {}
                    return res;
                }, () => { S.boostFails++; return fallback(); });
            }
        } catch (e) {
            swallow(e, 'fetch patch');
            // same fail-closed rule for errors thrown before the feed branch
            if (/[?&]bh_sid=/.test(rawUrl)) return Promise.resolve(jsonResponse('{"collection":[],"next_href":null,"query_urn":null}'));
        }
        // R23: tally api-v2 endpoint health on the un-boosted path too. Boosted
        // responses get markOk above; markFail covers persistent 404 / 5xx.
        const isApi = API_RE.test(rawUrl);
        const p = origFetch(input, init);
        if (!isApi) return p;
        return p.then(res => {
            try {
                if (res && (res.status === 404 || res.status >= 500)) ApiHealth.markFail(res.status);
                else if (res && res.status < 400) ApiHealth.markOk();
            } catch (e) {}
            return res;
        });
    };

    const XP = PW.XMLHttpRequest.prototype;
    const origOpen = XP.open, origSend = XP.send, origSRH = XP.setRequestHeader;
    XP.open = function (method, url, ...rest) {
        let u = url;
        try {
            this.__bhFeedPage = null;   // a re-open()ed XHR must never answer with a stale feed page
            const raw = String(url);
            sniffUrl(raw, method);
            this.__bhApi = API_RE.test(raw);
            if ((method || '').toUpperCase() === 'GET') {
                const page = resolveFeed(raw);
                if (page !== null) { this.__bhFeedPage = page; return origOpen.call(this, method, raw, ...rest); }
            }
            const boosted = boostUrl(raw);
            if (boosted !== raw) {
                u = boosted;
                // XHR objects can be reused (open() called again) — guard so we
                // never attach the load listener twice and double-count boostFails.
                if (!this.__bhBoostHooked) {
                    this.__bhBoostHooked = true;
                    this.addEventListener('load', () => {
                        if (this.status >= 400) S.boostFails++;
                        else { try { sniffBodyForEnd(JSON.parse(this.responseText)); } catch (e) {} }
                    });
                }
            }
            // R23: tally api-v2 health on every XHR (boosted or not). Same
            // hook-once guard so a re-used XHR can't double-count.
            if (this.__bhApi && !this.__bhHealthHooked) {
                this.__bhHealthHooked = true;
                this.addEventListener('load', () => {
                    try {
                        if (this.status === 404 || this.status >= 500) ApiHealth.markFail(this.status);
                        else if (this.status > 0 && this.status < 400) ApiHealth.markOk();
                    } catch (e) {}
                });
            }
        } catch (e) { swallow(e, 'xhr open patch'); }
        return origOpen.call(this, method, u, ...rest);
    };
    XP.setRequestHeader = function (name, value) {
        try { if (this.__bhApi && /^authorization$/i.test(name)) S.auth = value; } catch (e) {}
        return origSRH.call(this, name, value);
    };
    XP.send = function (...args) {
        if (this.__bhFeedPage != null) {
            const xhr = this, page = this.__bhFeedPage;
            setTimeout(() => {
                let body;
                try { body = feedBody(page); }
                catch (e) { body = '{"collection":[],"next_href":null,"query_urn":null}'; }
                const def = (k, v) => { try { Object.defineProperty(xhr, k, { configurable: true, get: () => v }); } catch (e) {} };
                def('readyState', 4); def('status', 200); def('statusText', 'OK');
                def('response', xhr.responseType === 'json' ? JSON.parse(body) : body);
                def('responseText', body);
                def('getAllResponseHeaders', () => 'content-type: application/json\r\n');
                def('getResponseHeader', h => /content-type/i.test(h) ? 'application/json' : null);
                try { xhr.dispatchEvent(new Event('readystatechange')); } catch (e) {}
                try { xhr.dispatchEvent(new Event('load')); } catch (e) {}
                try { xhr.dispatchEvent(new Event('loadend')); } catch (e) {}
            }, 5);
            return;
        }
        return origSend.apply(this, args);
    };

    /* Worker-pool Ticker comes from the shared suite scaffold above —
     * one Worker now drives BOTH the shuffle loader and lyric searches. */
    const makeTicker = (fn, ms) => Ticker.every(fn, ms);
    function waitFor(test, timeoutMs, intervalMs) {
        return new Promise(resolve => {
            let done = false;
            const t0 = Date.now();
            const tick = makeTicker(check, intervalMs || 80);
            function check() {
                if (done) return;
                let v = null;
                try { v = test(); } catch (e) {}
                if (v) { done = true; tick.stop(); resolve(v); }
                else if (Date.now() - t0 >= timeoutMs) { done = true; tick.stop(); resolve(null); }
            }
            check();
        });
    }
    const pause = ms => new Promise(r => { const t = makeTicker(() => { t.stop(); r(); }, ms); });

    /* ───────────────────────── MUTE / QUEUE ────────────────────────── */
    /* SoundCloud's player <audio> never enters the DOM: the enhancer captures it
     * at createMediaElementSource and shares it as SUITE.mediaEls (oldest first). */
    const capturedMedia = () => { try { return (SUITE.mediaEls && SUITE.mediaEls()) || []; } catch (e) { return []; } };
    function muteAll() {
        if (!CFG.silentSetup) return;
        const grab = () => capturedMedia().concat(Array.from(document.querySelectorAll('audio, video'))).forEach(m => {
            if (m && !m.muted) { m.muted = true; S.mutedByUs.push(m); }
        });
        grab();
        // never stack a second watcher: an orphaned one would re-mute every
        // <audio> 100 ms after any unmute for the rest of the session
        if (!S.muteWatch) S.muteWatch = makeTicker(grab, 100);
    }
    function unmuteAll() {
        if (S.muteWatch) { S.muteWatch.stop(); S.muteWatch = null; }
        S.mutedByUs.forEach(m => { try { m.muted = false; } catch (e) {} });
        S.mutedByUs = [];
    }
    function activeMedia() {
        // captured elements win: a playing one first, else the freshest; an in-DOM
        // element counts only while it plays, so a paused promo <video> is never picked
        let playing = null, last = null;
        capturedMedia().forEach(m => {
            if (!m) return;
            last = m;
            if (!playing && !m.paused && m.readyState > 0) playing = m;
        });
        if (playing || last) return playing || last;
        document.querySelectorAll('audio, video').forEach(m => {
            if (!playing && !m.paused && m.readyState > 0) playing = m;
        });
        return playing;
    }
    function queueOpen() { const qEl = q('queue'); return !!(qEl && qEl.classList.contains('m-visible')); }
    function toggleQueue(state) {
        const open = queueOpen();
        if ((open && state === 'close') || (!open && state === 'open')) clickIt(q('queueToggle'));
    }
    function hideQueuePanel(hide) {
        const qEl = q('queue');
        if (!qEl) return;
        if (hide && CFG.silentSetup) { qEl.style.opacity = '0.03'; qEl.style.pointerEvents = 'none'; S.queueHidden = true; }
        else if (S.queueHidden) { qEl.style.opacity = ''; qEl.style.pointerEvents = ''; S.queueHidden = false; }
    }
    /* v8: item height = MEDIAN of several rendered rows (the single-row
     * measurement was the root of the old "27 queued" bug), re-measured
     * every few seconds in case the layout shifts mid-load. The DOM count
     * is now only a progress estimate for the likes engine — completion
     * and reporting trust F.served, which we hand to the queue ourselves. */
    function measureItemH() {
        const wrap = q('queueHeights');
        if (!wrap) return 0;
        let items = null;
        for (const s of SEL.queueItem) { const n = wrap.querySelectorAll(s); if (n.length) { items = n; break; } }
        if (!items || !items.length) { const c = wrap.firstElementChild; items = c ? [c] : []; }
        const hs = [];
        for (const it of items) { const h = it.offsetHeight; if (h > 10) hs.push(h); if (hs.length >= 9) break; }
        if (!hs.length) return 0;
        hs.sort((a, b) => a - b);
        return hs[Math.floor(hs.length / 2)];
    }
    function loadedCount() {
        const hWrap = q('queueHeights');
        if (!hWrap) return 0;
        const h = parseInt(hWrap.style.height, 10) || hWrap.scrollHeight || 0;
        if (!S.itemH || Date.now() - S.itemHAt > T.itemRemeasureMs) {
            const m = measureItemH();
            if (m) { S.itemH = m; S.itemHAt = Date.now(); }
        }
        return S.itemH ? Math.round(h / S.itemH) : 0;
    }
    function findTotal(pageType) {
        const parse = txt => {
            if (!txt || /\d\s*[kKmM]\b/.test(txt)) return null;
            const m = txt.replace(/[,.\u00A0]/g, '').match(/(\d{1,7})/);
            return m ? parseInt(m[1], 10) : null;
        };
        let n = null;
        if (pageType === 'Likes' || pageType === 'GenericLikes') {
            // the compact cache is YOUR library — only trust it on your own likes page
            if (pageType === 'Likes') {
                const lm = getLibMap();
                if (lm) n = lm.size;
            }
            qa('tabsItems').forEach(el => {
                if (!n && /like/i.test(el.textContent)) n = parse(el.textContent);
            });
        }
        if (!n) { const tc = q('trackCount'); if (tc) n = parse(tc.textContent); }
        return n && n > 2 ? n : null;
    }

    /* ───────────────────────── UI KIT (minimal / aligned) ────────────────────────── */
    const stroke = (s, d) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
    const ICONS = {
        zap: s => stroke(s, 'M13 2 3 14h9l-1 8 10-12h-9l1-8z'),
        bars: s => stroke(s, 'M18 20V10M12 20V4M6 20v-6'),
        sliders: s => stroke(s, 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'),
        x: s => stroke(s, 'M18 6 6 18M6 6l12 12'),
    };
    let styled = false;
    function injectStyle() {
        if (styled || !document.head) return;
        styled = true;
        const st = document.createElement('style');
        st.textContent = `
.bhx-card svg,.bhx-barbtn svg,.bhx-gear svg,.bhx-x svg{display:block;flex:none}
.bhx-card{position:fixed;z-index:2147483210;width:294px;display:flex;flex-direction:column;max-height:min(78vh,620px);
 border-radius:20px;background:var(--bhx-bg,rgba(255,255,255,.9));
 backdrop-filter:blur(36px) saturate(1.7);-webkit-backdrop-filter:blur(36px) saturate(1.7);
 border:1px solid var(--bhx-bd,rgba(0,0,0,.1));color:var(--bhx-fg,#1b1b1f);
 box-shadow:0 20px 52px rgba(0,0,0,.32),0 0 0 1px rgba(255,85,0,.05),inset 0 1px 0 var(--bhx-hi,rgba(255,255,255,.28));
 font:12.5px/1.5 -apple-system,"SoundCloud Sans",Interstate,"Segoe UI",Roboto,sans-serif;animation:bhxin .22s cubic-bezier(.3,.9,.4,1.05)}
@keyframes bhxin{from{opacity:0;transform:translateY(10px) scale(.96);filter:blur(5px)}to{opacity:1;transform:none;filter:none}}
.bhx-head{position:relative;display:flex;align-items:center;gap:9px;padding:12px 16px;font-weight:600;font-size:13px;flex:none;
 border-bottom:1px solid var(--bhx-line,rgba(0,0,0,.06))}
.bhx-head::after{content:"";position:absolute;left:16px;bottom:-1px;width:74px;height:2px;border-radius:2px;
 background:linear-gradient(90deg,#f50,#ff8a3d 70%,transparent)}
.bhx-head svg{color:#f50;filter:drop-shadow(0 0 4px rgba(255,85,0,.45))}
.bhx-x{margin-left:auto;width:24px;height:24px;display:flex;align-items:center;justify-content:center;background:none;border:0;
 color:inherit;opacity:.4;cursor:pointer;border-radius:7px;padding:0;transition:.15s}
.bhx-x:hover{opacity:1;background:var(--bhx-line,rgba(0,0,0,.06))}
.bhx-body{padding:2px 16px 14px;overflow-y:auto;overscroll-behavior:contain}
.bhx-sec{margin:11px 0 1px;font-size:9.5px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;opacity:.5;
 display:flex;align-items:center;gap:6px}
.bhx-sec::before{content:"";width:10px;height:2px;border-radius:2px;background:linear-gradient(90deg,#f50,#ff8a3d);flex:none}
.bhx-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--bhx-line,rgba(0,0,0,.06))}
.bhx-row:last-of-type{border-bottom:0}
.bhx-lab{flex:1;min-width:0;font-weight:500;overflow-wrap:anywhere}
.bhx-sub{display:block;font-size:10.5px;opacity:.5;font-weight:400;margin-top:1px;line-height:1.4}
.bhx-sw{position:relative;width:32px;height:18px;border-radius:18px;background:var(--bhx-line2,rgba(0,0,0,.14));cursor:pointer;
 flex:none;transition:background .18s,box-shadow .18s;border:0;padding:0;-webkit-appearance:none;appearance:none}
.bhx-sw.on{background:linear-gradient(135deg,#f50,#ff8a3d);box-shadow:0 0 10px rgba(255,85,0,.35),inset 0 1px 1px rgba(255,255,255,.3)}
.bhx-sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;
 transition:left .18s cubic-bezier(.3,.9,.4,1.2),width .12s;box-shadow:0 1px 3px rgba(0,0,0,.35)}
.bhx-sw:active::after{width:17px}
.bhx-sw.on:active::after{left:13px}
.bhx-sw.on::after{left:16px}
.bhx-sw:focus-visible,.bhx-btn:focus-visible,.bhx-x:focus-visible,.bhx-barbtn:focus-visible,.bhx-gear:focus-visible,
.bhx-num:focus-visible,.bhx-sel:focus-visible{outline:2px solid #f50;outline-offset:2px}
.bhx-num{width:48px;text-align:center;background:var(--bhx-line,rgba(0,0,0,.06));border:0;border-radius:7px;padding:3px 4px;
 color:inherit;font:inherit;font-variant-numeric:tabular-nums;appearance:textfield;-moz-appearance:textfield}
.bhx-num::-webkit-outer-spin-button,.bhx-num::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.bhx-sel{background:var(--bhx-line,rgba(0,0,0,.06));border:0;border-radius:7px;padding:4px 8px;color:inherit;font:inherit;max-width:152px;cursor:pointer}
.bhx-btn{flex:1;background:transparent;border:1px solid var(--bhx-bd,rgba(0,0,0,.12));border-radius:8px;padding:6px 4px;
 color:inherit;font:inherit;font-size:11px;cursor:pointer;transition:.15s;white-space:nowrap}
.bhx-btn:hover{border-color:#f50;color:#f50;background:rgba(255,85,0,.07);box-shadow:0 0 12px rgba(255,85,0,.14)}
.bhx-btn:active{transform:scale(.96)}
.bhx-btn.sm{flex:none;padding:3px 9px;font-size:10px;border-radius:7px}
.bhx-btnrow{display:flex;gap:5px;flex:none}
.bhx-foot{display:flex;gap:8px;margin-top:12px}
.bhx-hint{margin-top:10px;font-size:9px;opacity:.38;text-align:center;letter-spacing:.06em}
.bhx-grid{display:flex;margin:7px 0 2px}
.bhx-cell{flex:1;text-align:center;padding:5px 0;border-left:1px solid var(--bhx-line,rgba(0,0,0,.06))}
.bhx-cell:first-child{border-left:0}
.bhx-big{font-size:19px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15;
 background:linear-gradient(135deg,#ff5500,#ff8a3d);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.bhx-small{font-size:9.5px;opacity:.5;margin-top:2px;letter-spacing:.04em}
.bhx-prog{height:3px;border-radius:3px;background:var(--bhx-line,rgba(0,0,0,.07));overflow:hidden;margin:9px 0 5px}
.bhx-prog i{display:block;position:relative;overflow:hidden;height:100%;background:linear-gradient(90deg,#f50,#ff8a3d);border-radius:3px;transition:width .3s;
 box-shadow:0 0 8px rgba(255,85,0,.55)}
.bhx-prog i::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);
 transform:translateX(-100%);animation:bhxsheen 2.4s ease-in-out infinite}
@keyframes bhxsheen{60%,100%{transform:translateX(100%)}}
.bhx-toast{position:fixed;right:18px;bottom:74px;z-index:2147483205;max-width:340px;display:flex;align-items:center;gap:9px;
 background:var(--bhx-bg,rgba(255,255,255,.9));backdrop-filter:blur(28px) saturate(1.6);-webkit-backdrop-filter:blur(28px) saturate(1.6);
 border:1px solid var(--bhx-bd,rgba(0,0,0,.1));border-radius:14px;padding:10px 14px;color:var(--bhx-fg,#1b1b1f);
 font:12px/1.45 -apple-system,"SoundCloud Sans",Interstate,"Segoe UI",Roboto,sans-serif;
 box-shadow:0 10px 30px rgba(0,0,0,.26),0 0 0 1px rgba(255,85,0,.06);opacity:0;transform:translateY(10px) scale(.98);transition:.32s cubic-bezier(.3,.9,.4,1.1);pointer-events:none}
.bhx-toast.show{opacity:1;transform:none;pointer-events:auto}
.bhx-toast.shifted{right:374px}
.bhx-toast b{display:block;font-weight:600}
.bhx-toast i{display:block;font-style:normal;font-size:11px;opacity:.6;margin-top:1px}
.bhx-dot{width:7px;height:7px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#ff8a3d,#f50);flex:none;
 box-shadow:0 0 6px rgba(255,85,0,.7)}
@keyframes bhxdone{0%{transform:scale(1)}45%{transform:scale(1.045);box-shadow:0 0 14px rgba(255,85,0,.45)}100%{transform:scale(1)}}
.bhx-pulse{animation:bhxdone .55s ease-out}
.bhx-barwrap{display:inline-flex;align-items:center;height:100%;margin:0 3px;vertical-align:middle}
.bhx-barbtn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;background:none;border:0;
 color:inherit;opacity:.55;cursor:pointer;border-radius:7px;transition:.15s;padding:0;margin:0 1px}
.bhx-barbtn:hover{opacity:1;background:rgba(255,85,0,.12);color:#f50;transform:scale(1.08)}
.bhx-barbtn.busy{color:#f50;opacity:1;animation:bhxpulse 1.1s ease-in-out infinite}
@keyframes bhxpulse{50%{opacity:.45}}
.bhx-gear{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:0;
 color:inherit;opacity:.45;cursor:pointer;border-radius:7px;padding:0;margin-left:8px;vertical-align:middle;transition:.18s}
.bhx-gear:hover{opacity:1;background:rgba(128,128,128,.15);color:#f50;transform:rotate(28deg)}
.bhx-now{display:flex;align-items:center;gap:10px;padding:10px 0 4px}
.bhx-nowmeta{flex:1;min-width:0}
.bhx-nowtitle{font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bhx-eq{display:flex;gap:2px;align-items:flex-end;height:14px;width:15px;flex:none}
.bhx-eq span{flex:1;border-radius:1px;background:linear-gradient(180deg,#ff8a3d,#f50);animation:bhxeq 1s ease-in-out infinite}
.bhx-eq span:nth-child(1){animation-delay:-.9s}
.bhx-eq span:nth-child(2){animation-delay:-.45s}
.bhx-eq span:nth-child(3){animation-delay:-.15s}
.bhx-eq.paused span{animation:none;height:30%}
@keyframes bhxeq{0%,100%{height:25%}50%{height:100%}}
.bhx-spark{display:flex;gap:3px;align-items:flex-end;height:36px;margin:8px 0 2px}
.bhx-spark b{flex:1;min-height:3px;border-radius:3px 3px 1px 1px;background:linear-gradient(180deg,#ff8a3d,#f50);opacity:.4;transition:opacity .15s}
.bhx-spark b:hover{opacity:.85}
.bhx-spark b.today{opacity:1;box-shadow:0 0 8px rgba(255,85,0,.45)}
.bhx-spark-l{display:flex;gap:3px;font-size:8px;opacity:.4;letter-spacing:.04em}
.bhx-spark-l span{flex:1;text-align:center}
.bhx-toast-act{margin-left:2px;flex:none;background:linear-gradient(135deg,#f50,#ff8a3d);color:#fff;border:0;border-radius:8px;
 padding:6px 12px;font:inherit;font-weight:600;font-size:11px;cursor:pointer;box-shadow:0 2px 10px rgba(255,85,0,.45);transition:.15s}
.bhx-toast-act:hover{filter:brightness(1.1);transform:translateY(-1px)}
@media (prefers-reduced-motion:reduce){
 .bhx-card{animation:none}
 .bhx-barbtn.busy{animation:none;opacity:.85}
 .bhx-barbtn:hover{transform:none}
 .bhx-toast{transition:opacity .15s;transform:none}
 .bhx-sw::after{transition:none}
 .bhx-pulse{animation:none}
 .bhx-gear:hover{transform:none}
 .bhx-eq span{animation:none;height:55%}
 .bhx-prog i::after{animation:none}
 .bhx-toast-act:hover{transform:none}
}`;
        document.head.appendChild(st);
    }
    function applyTheme() {
        let dark = false;
        try {
            dark = SUITE.pageIsDark();
        } catch (e) {}
        const r = document.documentElement.style;
        r.setProperty('--bhx-bg', dark ? 'rgba(24,24,28,.88)' : 'rgba(255,255,255,.92)');
        r.setProperty('--bhx-fg', dark ? '#ececf0' : '#1b1b1f');
        r.setProperty('--bhx-bd', dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.1)');
        r.setProperty('--bhx-line', dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)');
        r.setProperty('--bhx-line2', dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)');
        r.setProperty('--bhx-hi', dark ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.45)');
    }

    /* ───────────────────────── PROGRESS / TOAST ────────────────────────── */
    // Per-element text cache: skip the innerHTML write (and reflow) when unchanged.
    function setBtn(t) { if (S.btn && S.btn.__bhTxt !== t) { S.btn.__bhTxt = t; S.btn.innerHTML = t; } }
    /* The button doubles as its own progress bar: an orange fill sweeps
     * left → right behind the label while the queue loads. */
    function setBtnProgress(p) {
        if (!S.btn) return;
        if (p == null) { S.btn.style.background = ''; return; }
        const pct = Math.max(2, Math.min(100, p));
        S.btn.style.background = 'linear-gradient(90deg, rgba(255,85,0,.30) ' + pct + '%, rgba(255,85,0,.07) ' + pct + '%)';
    }
    function setBusy(on) { const bb = $('.bhx-barbtn.bhx-shuf'); if (bb) bb.classList.toggle('busy', !!on); }
    function fmtETA(sec) {
        if (!isFinite(sec) || sec <= 0) return '';
        return sec < 60 ? `${Math.ceil(sec)}s` : `${Math.ceil(sec / 60)}m`;
    }
    function updateProgress(nNow) {
        const counted = nNow == null ? loadedCount() : nNow;   // reuse the caller's count: one layout read per tick
        const n = F.active ? Math.max(counted, F.served) : counted;
        const dt = (Date.now() - S.startTime) / 1000;
        const rate = dt > 1 ? (n - S.startCount) / dt : 0;
        let txt;
        if (S.total) {
            txt = `Loading ${Math.min(n, S.total).toLocaleString()}/${S.total.toLocaleString()}`;
            const eta = rate > 0.5 && n < S.total ? fmtETA((S.total - n) / rate) : '';
            if (eta) txt += ` · ${eta}`;
            setBtnProgress(Math.min(n, S.total) / S.total * 100);
        } else txt = n ? `Loading ${n.toLocaleString()}…` : 'Loading…';
        setBtn(txt);
        setBusy(S.active);
    }
    let toastEl = null, toastTimer = 0;
    function showToast(msg, sub, action) {
        if (!document.body) return;
        injectStyle(); applyTheme();
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.className = 'bhx-toast';
            toastEl.setAttribute('role', 'status');
            toastEl.title = 'Dismiss';
            // every toast dismisses on tap — none can sit on screen stuck
            toastEl.addEventListener('click', (ev) => {
                if (ev.target && ev.target.closest && ev.target.closest('.bhx-toast-act')) return;
                toastEl.classList.remove('show');
                clearTimeout(toastTimer);
            });
            document.body.appendChild(toastEl);
        }
        toastEl.classList.toggle('shifted', !!(SUITE.lyricsOpen && SUITE.lyricsOpen()));
        if (sub) {
            toastEl.innerHTML = `<span class="bhx-dot"></span><span><b></b><i></i></span>`;
            toastEl.querySelector('b').textContent = msg;
            toastEl.querySelector('i').textContent = sub;
        } else {
            toastEl.innerHTML = `<span class="bhx-dot"></span><span></span>`;
            toastEl.lastChild.textContent = msg;
        }
        if (action && action.label) {
            const ab = document.createElement('button');
            ab.className = 'bhx-toast-act';
            ab.type = 'button';
            ab.textContent = action.label;
            ab.addEventListener('click', () => {
                toastEl.classList.remove('show');
                clearTimeout(toastTimer);
                try { action.fn(); } catch (e) { swallow(e, 'toast action'); }
            });
            toastEl.appendChild(ab);
        }
        requestAnimationFrame(() => toastEl.classList.add('show'));
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('show'), action ? 9000 : 6000);
    }

    /* ───────────── STATS + HISTORY + WATCHDOGS (local only) ─────────────
     * One 2-second tick handles: listen-time stats, played/skipped counts,
     * per-track play map, history for fresh picks, the sleep timer, and
     * the stuck-track auto-skip. */
    const HIST_KEY = 'bh_sc_history';
    const loadHistory = () => {
        const h = Object.assign({ ids: [], urls: [], ts: [] }, LS.get(HIST_KEY, {}));
        if (!Array.isArray(h.ts)) h.ts = [];   // ts pairs with urls, aligned from the END (legacy entries lack it)
        return h;
    };
    const clearHistory = () => LS.del(HIST_KEY);
    function currentTrackInfo() {
        const a = q('badgeTitle');
        const href = a && a.getAttribute('href');
        if (!href) return null;
        const url = 'https://soundcloud.com' + href.split('?')[0];
        const lm = getLibMap();
        const hit = lm && lm.get(url);
        return {
            url,
            id: hit ? hit[0] : null,
            artistId: hit ? hit[3] : null,
            artist: hit ? (hit[4] || '') : '',
            title: (a.textContent || '').trim() || url,
        };
    }
    /* One gesture, three entry points: settings card, stats hero, Alt+B. */
    function blockCurrentTrack(andSkip) {
        const info = currentTrackInfo();
        if (!info) { showToast('Play a track first'); return false; }
        const bk = loadBlock();
        if (info.id != null) { if (!bk.tracks.includes(info.id)) bk.tracks.push(info.id); }
        else if (!bk.urls.includes(info.url)) bk.urls.push(info.url);
        saveBlock(bk);
        // (no pool purge here: the only matching entry is the PLAYING track —
        // the Up-next anchor. Removing it blanks Up next and the lyric pre-warm.)
        if (andSkip) clickIt(q('skipNext'));
        showToast('Blocked “' + info.title.slice(0, 40) + '”', andSkip ? 'Skipped ahead — it won’t be shuffled again' : 'It won’t be shuffled again', {
            label: 'Undo',
            fn: () => {
                const b2 = loadBlock();
                if (info.id != null) b2.tracks = b2.tracks.filter(id => id !== info.id);
                b2.urls = b2.urls.filter(u => u !== info.url);
                saveBlock(b2);
                showToast('Unblocked', 'Back in the pool from the next shuffle');
            },
        });
        return true;
    }
    /* Sleep timer goes out like a candle, not a light switch: ~8 s volume
     * fade, then pause, then quietly restore the volume for next time. */
    function fadeOutAndPause() {
        const m = activeMedia();
        const pc = q('playControl');
        if (fading) { if (pc && pc.classList.contains('playing')) clickIt(pc); return false; }
        // Through the enhancer's audio chain when it is routed (SoundCloud's own player element never enters the
        // DOM, so that is the path that actually fades there and the volume slider stays put); otherwise the
        // element's volume in 50 ms steps. Either way 8 s, then the pause click, then a quiet restore.
        let viaChain = false;
        try { viaChain = !!(SUITE.audioFadeOut && SUITE.audioFadeOut(8)); } catch (e) {}
        if (!viaChain && !m) { if (pc && pc.classList.contains('playing')) clickIt(pc); return false; }
        fading = true;
        const v0 = m ? m.volume : 1, t0 = Date.now();
        // wall-clock, not step-counted: the ticker's worker messages queue through a main-thread stall and then
        // burst, which would end the countdown early and click pause before the chain's ramp has landed
        const t = makeTicker(() => {
            const k = Math.min(1, (Date.now() - t0) / 8000);
            if (!viaChain) { try { m.volume = Math.max(0, v0 * (1 - k)); } catch (e) {} }
            if (k >= 1) {
                t.stop();
                fading = false;
                const p = q('playControl');
                if (p && p.classList.contains('playing')) clickIt(p);
                setTimeout(() => { try { if (viaChain) SUITE.audioFadeOut(0); else m.volume = v0; } catch (e) {} }, 600);
            }
        }, 50);
        return true;
    }
    function sleepRemainingMs() { return sleepAt ? Math.max(0, sleepAt - Date.now()) : 0; }
    function clearSleep() { sleepAt = 0; sleepArmed = false; SS.del('bh_sc_sleep'); }
    let statsTick = null;
    function startWatcher() {
        if (statsTick) return;
        W.last = Date.now();
        let dirty = false;   // write storage only when something actually changed
        statsTick = makeTicker(() => {
            const now = Date.now();
            const dt = Math.min(now - W.last, 5000);
            W.last = now;
            const pc = q('playControl');
            const playing = pc && pc.classList.contains('playing');
            if (playing) {
                sess.listenMs += dt; allTime.listenMs += dt; W.curMs += dt;
                const dk = localDayKey(0);
                daily[dk] = (daily[dk] || 0) + dt;
                const hr = new Date().getHours();
                hourly[hr] = (hourly[hr] || 0) + dt;
                dirty = true;
            }

            const a = q('badgeTitle');
            const href = a && a.getAttribute('href');
            if (href && href !== W.href) {
                if (W.href) {
                    const prevUrl = 'https://soundcloud.com' + W.href.split('?')[0];
                    // a like shorter than the threshold counts as played once most of it was heard
                    const lmPrev = getLibMap();
                    const hitPrev = lmPrev && lmPrev.get(prevUrl);
                    const needMs = Math.min(CFG.playThresholdSec * 1000, hitPrev && hitPrev[2] > 0 ? hitPrev[2] * 0.8 : Infinity);
                    if (W.curMs >= needMs) { sess.played++; allTime.played++; bumpPlay(prevUrl, 'p'); lbScrobble(prevUrl); }
                    else if (W.curMs >= 2000) {
                        sess.skipped++; bumpPlay(prevUrl, 's');
                        // chronic skipper? close the loop: offer to block it
                        try {
                            const pe = LS.get(PLAYS_KEY, {})[prevUrl];
                            if (pe && pe[1] >= 4 && pe[1] > pe[0] && now - lastBlockNudgeAt > 10 * 60000) {
                                const lm2 = getLibMap();
                                const hit2 = lm2 && lm2.get(prevUrl);
                                const bk2 = loadBlock();
                                const already = bk2.urls.includes(prevUrl) || (hit2 && bk2.tracks.includes(hit2[0]));
                                if (!already) {
                                    lastBlockNudgeAt = now;
                                    const ttl = ((hit2 && hit2[5]) || prevUrl.split('/').pop().replace(/-/g, ' ')).slice(0, 40);
                                    showToast('Skipped this ' + pe[1] + ' times', ttl, { label: 'Block', fn: () => {
                                        const b3 = loadBlock();
                                        if (hit2 && !b3.tracks.includes(hit2[0])) b3.tracks.push(hit2[0]);
                                        else if (!b3.urls.includes(prevUrl)) b3.urls.push(prevUrl);
                                        saveBlock(b3);
                                        showToast('Blocked — it won’t be shuffled again');
                                    } });
                                }
                            }
                        } catch (e) { swallow(e, 'skip nudge'); }
                        // Three quick skips in a row? Offer a fresh shuffle.
                        skipTimes.push(now);
                        skipTimes = skipTimes.filter(t2 => now - t2 < 30000).slice(-5);
                        if (CFG.smartSuggest && skipTimes.length >= 3 && S.playingStarted && !S.active &&
                            now - lastSuggestAt > 5 * 60000) {
                            lastSuggestAt = now;
                            skipTimes = [];
                            showToast('Not feeling this run?', 'Three quick skips in a row', { label: 'Reshuffle', fn: () => {
                                // reshuffle in the SAME context (playlist stays a playlist);
                                // only fall back to likes when we've navigated away
                                const b = document.querySelector('.bhx-shufbtn');
                                if (b && S.lastRunPath === location.pathname) run(b); else barShuffleClick();
                            } });
                        }
                    }
                }
                dirty = true;
                W.href = href; W.curMs = 0; W.stuckMs = 0; W.stuckKicks = 0;
                if (sleepArmed) { // "finish this track" sleep: pause on the change
                    clearSleep();
                    if (playing && pc) clickIt(pc);
                    showToast('Sleep timer', 'Paused — good night');
                }
                const url = 'https://soundcloud.com' + href.split('?')[0];
                const h = loadHistory();
                if (h.urls[h.urls.length - 1] !== url) {
                    h.urls.push(url);
                    h.ts.push(now);
                    const lm = getLibMap();
                    const hit = lm && lm.get(url);
                    if (hit) h.ids.push(hit[0]);
                    if (h.urls.length > 2000) { h.urls = h.urls.slice(-2000); h.ts = h.ts.slice(-2000); }
                    if (h.ids.length > 2000) h.ids = h.ids.slice(-2000);
                    LS.set(HIST_KEY, h);
                }

                // Nearing the tail of the shuffled run? Offer a fresh one
                // before SoundCloud's autoplay quietly takes over.
                if (S.poolList && S.poolList.length > 5 && !S.active && now - endNudgeAt > 10 * 60000) {
                    const qi = S.poolIdx && S.poolIdx.has(url) ? S.poolIdx.get(url) : -1;
                    if (qi >= S.poolList.length - 2) {
                        endNudgeAt = now;
                        showToast('Queue almost done', 'That was the tail of this shuffle', { label: 'Reshuffle', fn: () => barShuffleClick() });
                    }
                }
            }

            // Sleep timer: fade out now, or arm "after this track" when it's nearly over.
            if (sleepAt && now >= sleepAt && !sleepArmed) {
                if (playing) {
                    const m = activeMedia();
                    const rem = m && isFinite(m.duration) && m.duration > 0 ? (m.duration - m.currentTime) * 1000 : Infinity;
                    if (rem <= T.sleepGraceMs) { sleepArmed = true; showToast('Sleep timer', 'Pausing after this track'); }
                    else { clearSleep(); const faded = fadeOutAndPause(); showToast('Sleep timer', faded ? 'Fading out — good night' : 'Paused — good night'); }
                } else clearSleep();
            }

            // Stuck-track watchdog: "playing" but audio never leaves 0 → skip.
            // Armed as soon as real playback begins — including during an
            // instant-playback load (S.active stays true for the whole load).
            if (CFG.autoSkipStuck && playing && S.playingStarted && (S.beganPlayback || !S.active)) {
                const m = activeMedia();
                const ct = m ? m.currentTime : null;
                if (ct != null) {
                    if (ct < T.stuckMinCT) {
                        W.stuckMs += dt;
                        if (W.stuckMs >= T.stuckAfterMs && W.stuckKicks < 2) {
                            W.stuckKicks++; W.stuckMs = 0;
                            // a track that refused to start TWICE is a broken like —
                            // but only when it's actually in YOUR library (the compact
                            // cache holds nothing else), and never on the first kick,
                            // which a 10s buffering stall can trip on its own
                            if (W.stuckKicks >= 2 && W.href) {
                                const su = 'https://soundcloud.com' + W.href.split('?')[0];
                                const lm3 = getLibMap();
                                const hit3 = lm3 && lm3.get(su);
                                if (hit3) recordBroken([{ u: su, t: hit3[5] || '', a: hit3[4] || '', p: 'won’t start' }]);
                            }
                            clickIt(q('skipNext'));
                            const p2 = q('playControl');
                            if (p2 && !p2.classList.contains('playing')) clickIt(p2);
                            showToast('That track wouldn’t start — skipped it');
                        }
                    } else W.stuckMs = 0;
                }
            }

            if (dirty) SS.set('bh_sc_sess', sess);
            if (++W.saveTick % 5 === 0 && dirty) {
                LS.set('bh_sc_alltime', allTime);
                const dks = Object.keys(daily).sort();
                while (dks.length > 35) delete daily[dks.shift()];   // 35 days kept: the streak counter looks back 30
                LS.set('bh_sc_daily', daily);
                LS.set('bh_sc_hours', hourly);
                dirty = false;
            }
        }, 2000);
    }

    /* ═══════════════════ LIKES ENGINE: FETCH EVERYTHING ═══════════════════ */
    async function buildFirstPageUrl(pageType, limit) {
        // a template is only replayed when it targets THIS page's likes: the queue
        // of another profile keeps paginating after navigation and would otherwise
        // be fetched and cached as this account's library
        let tplPath = '';
        try { tplPath = S.tpl ? new URL(S.tpl).pathname : ''; } catch (e) {}
        const fromTpl = () => {
            const u = new URL(S.tpl);
            u.searchParams.delete('offset');
            u.searchParams.set('limit', String(limit));
            u.searchParams.set('linked_partitioning', '1');
            return u.href;
        };
        if (pageType === 'Likes') {
            const me = userTag();
            if (tplPath === '/me/track_likes' || (me && tplPath === '/users/' + me + '/track_likes')) return fromTpl();
        }
        if (!S.clientId) throw new Error('no client_id seen yet');
        if (pageType === 'GenericLikes') {
            const profile = location.origin + '/' + location.pathname.split('/')[1];
            const rUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(profile)}&client_id=${S.clientId}`;
            assertScApi(rUrl);
            const r = await origFetch(rUrl, { credentials: 'include' });
            if (!r.ok) throw new Error('resolve failed');
            const user = await r.json();
            if (!user || !user.id) throw new Error('no user id');
            if (tplPath === '/users/' + user.id + '/track_likes') return fromTpl();
            return `https://api-v2.soundcloud.com/users/${user.id}/track_likes?client_id=${S.clientId}&limit=${limit}&linked_partitioning=1`;
        }
        if (!S.auth && !cookieAuth()) throw new Error('no auth captured for /me');
        return `https://api-v2.soundcloud.com/me/track_likes?client_id=${S.clientId}&limit=${limit}&linked_partitioning=1`;
    }

    async function backoff(attempt, retryAfter, detached) {
        let ms = Math.min(15000, 800 * Math.pow(2, attempt - 1)) + Math.random() * 400;
        const ra = parseFloat(retryAfter);
        if (isFinite(ra) && ra > 0) ms = Math.max(ms, Math.min(ra * 1000, 60000));   // an hour-long Retry-After must not park the tab
        log('backoff', Math.round(ms) + 'ms');
        // a foreground run wakes up as soon as it is cancelled; a detached refresh
        // must keep its full delay (S.cancelled stays true after any earlier cancel)
        if (detached) await pause(ms);
        else await waitFor(() => S.cancelled, ms, 100);
    }

    /* Fetch the WHOLE library: 500/request, auto step-down to 200 if refused,
     * exponential backoff + Retry-After on 429/5xx and network blips. On a
     * fatal error, whatever was fetched rides along on err.partial so the
     * caller can salvage a near-complete run instead of starting over. */
    async function fetchLibrary(pageType, onProgress, opts) {
        // detached: a background refresh must NOT hang on the global abort
        // handle or the foreground cancel flag — finish()/cancel() killing
        // the run must never kill the refresh riding behind it
        const detached = !!(opts && opts.detached);
        let limit = 500;
        let url = await buildFirstPageUrl(pageType, limit);
        const headers = {};
        const auth = S.auth || cookieAuth();
        if (auth) headers.Authorization = auth;
        const ac = new AbortController();
        if (!detached) S.fetchAbort = ac;
        const items = [];
        let guard = 0, firstTry = true, retries = 0, badJson = 0;
        const fail = msg => { const err = new Error(msg); err.partial = items; return err; };
        while (url && guard++ < T.fetchGuard) {
            if (!detached && S.cancelled) throw new Error('cancelled');
            assertScApi(url);
            let r;
            try {
                r = await origFetch(url, { credentials: 'include', headers, signal: ac.signal });
            } catch (e) {
                if (!detached && (S.cancelled || (e && e.name === 'AbortError'))) throw e;
                if (retries++ < T.fetchRetries) { await backoff(retries, null, detached); continue; }
                throw fail('network: ' + (e && e.message));
            }
            if (!r.ok) {
                if (firstTry && r.status >= 400 && limit > 200) { limit = 200; url = await buildFirstPageUrl(pageType, limit); continue; }
                if ((r.status === 429 || r.status >= 500) && retries < T.fetchRetries) {
                    retries++;
                    await backoff(retries, r.headers && r.headers.get('Retry-After'), detached);
                    continue;
                }
                throw fail('api ' + r.status);
            }
            retries = 0; firstTry = false;
            let j;
            try { j = await r.json(); }
            catch (e) {
                // a 200 with a truncated/non-JSON body must not throw away
                // everything fetched so far — retry, then fail with .partial
                // (its own counter: `retries` was just reset by the OK status)
                if (badJson++ < T.fetchRetries) { await backoff(badJson, null, detached); continue; }
                throw fail('bad json');
            }
            badJson = 0;
            for (const it of (j.collection || [])) if (it && it.track) items.push(it);
            if (onProgress) onProgress(items.length);
            url = j.next_href || null;
        }
        if (S.fetchAbort === ac) S.fetchAbort = null;
        return items;
    }

    function saveCompactCache(lib) {
        try {
            const items = lib.map(it => [
                it.track.id,
                (it.track.permalink_url || '').split('?')[0],
                Math.max(it.track.full_duration || 0, it.track.duration || 0),
                it.track.user_id || (it.track.user && it.track.user.id) || 0,
                ((it.track.user && it.track.user.username) || '').slice(0, 40),
                (it.track.title || '').slice(0, 80),
            ]);
            LS.set('bh_sc_lib', { t: Date.now(), items });
            invalidateLibMap();
        } catch (e) { swallow(e, 'saveCompactCache'); }
    }
    /* ──────────── PERSISTENT LIBRARY CACHE (IndexedDB) ────────────
     * The compact bh_sc_lib in localStorage only holds [id, url, duration,
     * artist] for stats / history / blocklist lookups — SoundCloud's queue
     * can't play from that. To survive refreshes we cache the FULL track
     * objects (exactly as the API returned them) in IndexedDB, which has
     * the room localStorage doesn't. Freshness model:
     *   · t = time of the last FULL fetch; the cache expires CFG.cacheHours
     *     after that (default 24 h, 0 disables caching entirely),
     *   · every cache hit triggers a background "top-up": page 1 of your
     *     likes is fetched and any NEW likes are merged in for the next
     *     shuffle — WITHOUT resetting t, so tracks you un-liked still get
     *     purged by the scheduled full refetch. */
    const LibCache = (() => {
        const DB = 'bh_sc_shuffle', STORE = 'lib';
        const open = () => new Promise((res, rej) => {
            try {
                const rq = indexedDB.open(DB, 1);
                rq.onupgradeneeded = () => { try { rq.result.createObjectStore(STORE); } catch (e) {} };
                rq.onsuccess = () => res(rq.result);
                rq.onerror = () => rej(rq.error || new Error('idb open failed'));
            } catch (e) { rej(e); }
        });
        const op = (mode, fn) => open().then(db => new Promise((res, rej) => {
            let rq;
            try {
                const tx = db.transaction(STORE, mode);
                rq = fn(tx.objectStore(STORE));
                tx.oncomplete = () => { try { db.close(); } catch (e) {} res(rq ? rq.result : undefined); };
                tx.onerror = () => { try { db.close(); } catch (e) {} rej(tx.error); };
                tx.onabort = () => { try { db.close(); } catch (e) {} rej(tx.error); };
            } catch (e) { try { db.close(); } catch (e2) {} rej(e); }
        }));
        return {
            get: key => op('readonly', s => s.get(key)),
            set: (key, val) => op('readwrite', s => s.put(val, key)),
            del: key => op('readwrite', s => s.delete(key)),
            clear: () => op('readwrite', s => s.clear()),
        };
    })();
    async function idbLoadLib(libKey) {
        try {
            const v = await LibCache.get(libKey);
            return v && Array.isArray(v.items) ? v : null;
        } catch (e) { swallow(e, 'idbLoadLib'); return null; }
    }
    function idbSaveLib(libKey, items, t) {
        LibCache.set(libKey, { t: t || Date.now(), items }).catch(e => swallow(e, 'idbSaveLib'));
    }
    function idbClearLib() { libGen++; LibCache.clear().catch(e => swallow(e, 'idbClearLib')); }

    /* Background delta-sync: walk the newest pages and merge anything you
     * liked since the cache was written. Never blocks playback; new likes
     * land in the pool from the NEXT shuffle on. v8.1: paginates until it
     * overlaps the cache (up to 5 pages ≈ 1000 likes), so heavy likers
     * aren't capped at one page anymore. */
    const lastTopUpAt = new Map();   // per-library; cleared on failure so a flaky sync can retry
    let libGen = 0;   // bumped whenever the cache is forgotten or fully refreshed — a top-up started before that must not write
    async function topUpCache(pageType, libKey, lib, fullFetchT) {
        try {
            if (bgRefreshing) return;   // a full refresh is in flight — don't race it with stale merges
            const gen0 = libGen;
            if (Date.now() - (lastTopUpAt.get(libKey) || 0) < 5 * 60000) return;   // a reshuffle burst needs one sync, not five
            lastTopUpAt.set(libKey, Date.now());
            await waitFor(() => (S.tpl || S.clientId) && (S.auth || cookieAuth() || pageType === 'GenericLikes'), T.authWait, 200);
            let url = await buildFirstPageUrl(pageType, 200);
            const auth = S.auth || cookieAuth();
            const have = new Set(lib.map(it => it.track.id));
            const fresh = [];
            for (let page = 0; page < 5 && url; page++) {
                assertScApi(url);
                const r = await origFetch(url, { credentials: 'include', headers: auth ? { Authorization: auth } : {} });
                if (!r.ok) { if (page === 0) lastTopUpAt.delete(libKey); break; }
                const j = await r.json();
                let overlap = false;
                for (const it of (j.collection || [])) {
                    if (!it || !it.track) continue;
                    if (have.has(it.track.id)) { overlap = true; continue; }
                    have.add(it.track.id);
                    fresh.push(it);
                }
                if (overlap || !j.next_href) break;   // reached known territory (or the end)
                url = j.next_href;
            }
            if (!fresh.length) return;
            if (gen0 !== libGen) return;   // Forget / full refresh landed meanwhile — our merge is stale
            const merged = fresh.concat(lib);   // likes arrive newest-first
            if (S.sessionLibKey === libKey) { S.sessionLib = merged; S.sessionLibAt = Date.now(); }
            if (pageType !== 'GenericLikes') saveCompactCache(merged);   // never poison YOUR library with someone else's
            idbSaveLib(libKey, merged, fullFetchT);   // keep t: scheduled full refetch stays due
            showToast(fresh.length + ' new like' + (fresh.length === 1 ? '' : 's') + ' synced — in the pool from the next shuffle');
        } catch (e) { lastTopUpAt.delete(libKey); swallow(e, 'topUpCache'); }
    }

    /* Stale-while-revalidate companion: shuffle the old cache instantly,
     * refetch the WHOLE library behind the music for next time. */
    let bgRefreshing = false;
    async function refreshLibInBackground(pageType, libKey) {
        if (bgRefreshing) return;
        bgRefreshing = true;
        try {
            await waitFor(() => (S.tpl || S.clientId) && (S.auth || cookieAuth() || pageType === 'GenericLikes'), T.authWait, 200);
            const fresh = await fetchLibrary(pageType, null, { detached: true });
            if (!fresh || fresh.length < 3) return;
            if (S.sessionLibKey === libKey) { S.sessionLib = fresh; S.sessionLibAt = Date.now(); }
            if (pageType !== 'GenericLikes') saveCompactCache(fresh);
            idbSaveLib(libKey, fresh);
            libGen++;
            showToast('Library refreshed', fresh.length.toLocaleString() + ' likes ready for the next shuffle');
        } catch (e) { swallow(e, 'bg refresh'); }
        finally { bgRefreshing = false; }
    }

    /* ─────────────────────── SHUFFLE POOL ───────────────────────
     * Pure functions (no DOM): dedupe → unplayable filter → blocklist →
     * length filter → fresh picks → order (uniform or rediscover-weighted)
     * → sample cap → artist spreading. */
    function randInt(n) {
        try {
            // rejection sampling: plain % n is biased toward small values
            const u = new Uint32Array(1);
            const lim = 4294967296 - (4294967296 % n);
            do { crypto.getRandomValues(u); } while (u[0] >= lim);
            return u[0] % n;
        } catch (e) { return Math.floor(Math.random() * n); }
    }
    function rand01() {
        try { const u = new Uint32Array(1); crypto.getRandomValues(u); return (u[0] + 0.5) / 4294967296; } catch (e) { return Math.random(); }
    }
    function shuffle(a) {
        const b = a.slice();
        for (let i = b.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = b[i]; b[i] = b[j]; b[j] = t; }
        return b;
    }
    /* Weighted shuffle without replacement (Efraimidis–Spirakis): older
     * likes (the API returns newest first, so larger index = older) and
     * never-heard tracks get higher weight, but everything can appear. */
    function weightedShuffle(arr, heardIds, heardUrls, plays) {
        const n = Math.max(1, arr.length - 1);
        return arr
            .map((it, i) => {
                let w = 1 + 2 * (i / n);
                const t = it.track;
                const u = (t.permalink_url || '').split('?')[0];
                if (!heardIds.has(t.id) && !heardUrls.has(u)) w += 1.2;
                // tracks you demonstrably bail on come around less often
                if (plays) {
                    const e = plays[u];
                    if (e && e[1] >= 3 && e[1] > e[0]) w *= Math.max(0.35, (e[0] + 1) / (e[1] + 1));
                }
                return [it, Math.pow(rand01(), 1 / w)];
            })
            .sort((a, b) => b[1] - a[1])
            .map(x => x[0]);
    }
    const artistOf = it => (it.track && (it.track.user_id || (it.track.user && it.track.user.id))) || 0;
    // post-shuffle pass: avoid clustering 3+ short tracks in a row. SC has a
    // long tail of <90s sketches/interludes; getting 4 in a row reads as a
    // glitch even though each individual pick is fine. Walk window-of-3 and
    // swap the third short track with a longer one further down the pool.
    function spreadShorts(arr, shortMs, run) {
        shortMs = shortMs || 90000;   // <90s is "short" by default
        run = run || 3;               // 3 in a row = the threshold
        const ms = (it) => (it && it.track && Math.max(it.track.full_duration || 0, it.track.duration || 0)) || 0;
        let streak = 0;
        for (let i = 0; i < arr.length; i++) {
            if (ms(arr[i]) < shortMs) streak++; else { streak = 0; continue; }
            if (streak < run) continue;
            for (let j = i + 1; j < arr.length; j++) {
                if (ms(arr[j]) >= shortMs) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; streak = 0; break; }
            }
        }
        return arr;
    }
    function spreadArtists(arr, gap) {
        gap = gap || 2;
        for (let i = 1; i < arr.length; i++) {
            const a = artistOf(arr[i]);
            let conflict = false;
            for (let k = 1; k <= gap && i - k >= 0; k++) if (artistOf(arr[i - k]) === a) { conflict = true; break; }
            if (!conflict) continue;
            let fallback = -1;
            for (let j = i + 1; j < arr.length; j++) {
                const b = artistOf(arr[j]);
                let ok = true;
                for (let k = 1; k <= gap && i - k >= 0; k++) if (artistOf(arr[i - k]) === b) { ok = false; break; }
                if (!ok) continue;
                if (fallback < 0) fallback = j;
                // don't just fix position i — make sure the displaced artist
                // doesn't land next to itself around j either
                let clean = true;
                for (let k = 1; k <= gap; k++) {
                    const before = j - k, after = j + k;
                    if (before >= 0 && before !== i && artistOf(arr[before]) === a) { clean = false; break; }
                    if (after < arr.length && artistOf(arr[after]) === a) { clean = false; break; }
                }
                if (!clean) continue;
                const t = arr[i]; arr[i] = arr[j]; arr[j] = t; fallback = -2; break;
            }
            // no double-clean candidate: fall back to the old single-sided swap
            if (fallback >= 0) { const t = arr[i]; arr[i] = arr[fallback]; arr[fallback] = t; }
        }
        return arr;
    }
    /* Fail OPEN: only drop tracks that definitively cannot play — explicit
     * streamable:false or policy BLOCK (region-blocked / removed). Go+
     * catalog tracks carry policy SNIP and play fine (full with Go+, 30 s
     * preview without) — filtering those out silently gutted big libraries. */
    const isStreamable = t => t.streamable !== false && t.policy !== 'BLOCK';

    function buildPool(lib, pageType) {
        const seen = new Set();
        const deduped = [];
        for (const it of lib) {
            const t = it.track;
            if (!t || seen.has(t.id)) continue;
            seen.add(t.id);
            deduped.push(it);
        }
        let pool = deduped;
        const stats = { durFiltered: 0, histFiltered: 0, blockFiltered: 0, unplayable: 0, sampledFrom: 0,
                        genreFiltered: 0, ageFiltered: 0,
                        rotationBypassed: false, totalMs: 0, libSize: deduped.length };

        if (CFG.skipUnplayable) {
            const kept = [], dropped = [];
            for (const it of pool) (isStreamable(it.track) ? kept : dropped).push(it);
            stats.unplayable = dropped.length;
            if (kept.length >= 3) {
                pool = kept;
                // remember WHICH likes are dead so the user can clean them up —
                // but only YOUR likes (never another user's GenericLikes page),
                // and dedupe BEFORE capping so big graveyards record fully over time
                if (pageType !== 'GenericLikes') {
                    const known = new Set(LS.get(BROKEN_KEY, []).map(x => x.u));
                    recordBroken(dropped
                        .filter(it => !known.has((it.track.permalink_url || '').split('?')[0]))
                        .slice(0, 50)
                        .map(it => ({
                            u: (it.track.permalink_url || '').split('?')[0],
                            t: (it.track.title || '').slice(0, 60),
                            a: ((it.track.user && it.track.user.username) || '').slice(0, 30),
                            p: it.track.policy === 'BLOCK' ? 'region-blocked / removed' : 'unstreamable',
                        })));
                }
            } else stats.unplayable = 0;
        }

        const blk = loadBlock();
        if (blk.tracks.length || blk.urls.length || blk.artists.length) {
            const tb = new Set(blk.tracks), ub = new Set(blk.urls), ab = new Set(blk.artists);
            const kept = pool.filter(it => {
                const t = it.track;
                const u = (t.permalink_url || '').split('?')[0];
                return !tb.has(t.id) && !ub.has(u) && !ab.has(artistOf(it));
            });
            stats.blockFiltered = pool.length - kept.length;
            if (kept.length >= 3) pool = kept;
            else { stats.blockFiltered = 0; showToast('Blocklist would remove almost everything — ignored this time'); }
        }

        const maxMin = CFG.filterMode === 'songs' ? CFG.filterMinutes : 0;
        const minMin = CFG.filterMode === 'mixes' ? CFG.filterMinutes : 0;
        if (maxMin > 0 || minMin > 0) {
            const kept = pool.filter(it => {
                const dur = Math.max(it.track.full_duration || 0, it.track.duration || 0);
                if (maxMin > 0 && dur > maxMin * 60000) return false;
                if (minMin > 0 && dur < minMin * 60000) return false;
                return true;
            });
            stats.durFiltered = pool.length - kept.length;
            if (kept.length >= Math.max(3, Math.ceil(pool.length * 0.05))) pool = kept;
            else { stats.durFiltered = 0; showToast('Length filter would remove almost everything — ignored this time'); }
        }

        // Genre filter — the full track objects carry genre tags; zero network.
        if (CFG.genreFilter.length) {
            const want = new Set(CFG.genreFilter.map(g => g.toLowerCase()));
            const kept = pool.filter(it => want.has(String(it.track.genre || '').trim().toLowerCase()));
            stats.genreFiltered = pool.length - kept.length;
            if (kept.length >= 3) pool = kept;
            else { stats.genreFiltered = 0; showToast('Genre filter would remove almost everything — ignored this time'); }
        }

        // "Liked since" — every like item carries its created_at. Unknown dates fail open.
        if (CFG.likedDays > 0) {
            const cutoff = Date.now() - CFG.likedDays * 86400000;
            const kept = pool.filter(it => {
                // like date ONLY — the upload date would wrongly exclude old
                // tracks liked recently (a like is always newer than the upload)
                const ts = Date.parse(it.created_at || '');
                return isFinite(ts) ? ts >= cutoff : true;
            });
            stats.ageFiltered = pool.length - kept.length;
            if (kept.length >= 3) pool = kept;
            else { stats.ageFiltered = 0; showToast('“Liked since” filter would remove almost everything — ignored this time'); }
        }

        // Fresh picks. v8: when nearly everything has been heard we simply
        // include repeats for THIS run — we no longer wipe the global heard
        // history (which used to happen even when shuffling someone else's
        // tiny likes list). Manual reset stays in settings.
        const h = loadHistory();
        const heardIds = new Set(h.ids), heardUrls = new Set(h.urls);
        if (CFG.noRepeat) {
            const remaining = pool.filter(it => !heardIds.has(it.track.id) && !heardUrls.has((it.track.permalink_url || '').split('?')[0]));
            if (remaining.length < Math.max(10, pool.length * 0.05)) stats.rotationBypassed = true;
            else { stats.histFiltered = pool.length - remaining.length; pool = remaining; }
        }

        // rotationBypassed = almost everything heard: still float the last
        // unheard tracks to the front instead of burying them at random
        pool = (CFG.orderMode === 'rediscover' || stats.rotationBypassed)
            ? weightedShuffle(pool, heardIds, heardUrls, LS.get(PLAYS_KEY, {}))
            : shuffle(pool);

        const cap = CFG.sampleCap | 0;
        if (cap > 2 && pool.length > cap) { stats.sampledFrom = pool.length; pool = pool.slice(0, cap); }

        if (CFG.spreadArtists) spreadArtists(pool);
        spreadShorts(pool);   // avoid 3+ sub-90s tracks in a row — see helper above

        stats.totalMs = pool.reduce((s, it) => s + Math.max(it.track.full_duration || 0, it.track.duration || 0), 0);
        return { pool, stats };
    }

    /* ─────────────────────── SEED + PLAY ─────────────────────── */
    async function seedFromLastRow(list) {
        const rows = Array.from(list.children).filter(r => q('playButton', r));
        if (!rows.length) return false;
        const last = rows[rows.length - 1];
        const pLast = q('playButton', last);

        muteAll();
        S.seeded = true;   // the run owns playback from here: cancel() pauses the seed, never earlier music
        const pc0 = q('playControl');
        if (pc0 && pc0.classList.contains('playing')) clickIt(pc0);

        const rowLink = q('rowTitle', last);
        const badge = q('badgeTitle');
        const isCurrent = pLast.classList.contains('sc-button-pause') ||
            (rowLink && badge && rowLink.getAttribute('href') === badge.getAttribute('href'));
        if (isCurrent && rows.length > 1) {
            const other = q('playButton', rows[0]);
            clickIt(other);
            await waitFor(() => other.classList.contains('sc-button-pause'), T.seedSwapWait, 50);
        }
        if (S.cancelled) return false;

        clickIt(pLast);
        toggleQueue('open');   // warm the queue panel while the track roots
        await waitFor(() => pLast.classList.contains('sc-button-pause') ||
            ((q('playControl') || { classList: { contains: () => false } }).classList.contains('playing')), T.seedClickWait, 50);
        if (S.cancelled) return false;

        // Pause while everything loads — playback begins only when ready.
        const pc = q('playControl');
        if (pc && pc.classList.contains('playing')) clickIt(pc);
        return true;
    }

    /* Jump off the seed track into the shuffled region — verified, with one
     * retry if SoundCloud swallowed the click. Guarded so the experimental
     * early start and the normal completion path can't both fire it. */
    function beginPlaybackTrue() {
        if (S.beganPlayback) return;
        S.beganPlayback = true;
        unmuteAll();
        const sh = q('shuffleControl');
        if (sh && sh.classList.contains('m-shuffling')) clickIt(sh); // our order IS the shuffle
        const badge = q('badgeTitle');
        const seedHref = badge && badge.getAttribute('href');
        clickIt(q('skipNext'));
        S.playingStarted = true;
        const pc = q('playControl');
        if (pc) { if (!pc.classList.contains('playing')) clickIt(pc); focusIdle(pc); }
        waitFor(() => {
            const b = q('badgeTitle');
            return b && b.getAttribute('href') !== seedHref;
        }, T.playVerify).then(changed => {
            if (!changed && S.playingStarted && !S.cancelled) {
                clickIt(q('skipNext'));
                const p2 = q('playControl');
                if (p2 && !p2.classList.contains('playing')) clickIt(p2);
            }
        });
    }

    /* ─────────────────────── LIKES RUN (linear) ───────────────────────
     *  fetch everything → shuffle → load whole queue → play  */
    async function runTrue(btn, list, pageType) {
        // 1. FETCH — or reuse: memory (this session) → disk cache (last fetch) → network.
        // Own likes are keyed per ACCOUNT (user id from the OAuth token), so
        // switching accounts can never shuffle the other account's cache.
        const legacyKey = pageType + ':' + location.pathname.split('/')[1];
        let acct = pageType === 'Likes' ? userTag() : '';
        if (pageType === 'Likes' && !acct) {
            // cold load: give the auth sniffers a beat. If still no acct after the
            // window we used to silently collapse to the legacy SHARED key — which
            // mixed two accounts' libraries on cold reshuffles. Now: defer with a
            // toast instead of poisoning the cache. The user clicks Shuffle again
            // a second later when the sniffer has caught up.
            await waitFor(() => userTag(), 1500, 100);
            acct = userTag();
            if (!acct) {
                // unwind every UI lock that run() set up so the button isn't stuck
                // in busy state until the next successful shuffle
                showToast('Still authenticating', 'Wait a beat then click Shuffle again — keeps each account’s library separate');
                setBtn('Shuffle Play');
                setBtnProgress(null);
                setBusy(false);
                S.active = false;
                // restore the previous pool (mirrors cancel() semantics) so the
                // queue tab still shows whatever the user was looking at
                if (!S.poolAssigned && S.prevPoolList) {
                    S.poolList = S.prevPoolList; S.poolIdx = S.prevPoolIdx;
                    S.prevPoolList = null; S.prevPoolIdx = null;
                }
                return;
            }
        }
        const libKey = legacyKey + (acct ? '@' + acct : '');
        let lib = null, salvaged = false;
        if (CFG.cacheHours > 0 && S.sessionLib && S.sessionLibKey === libKey && Date.now() - S.sessionLibAt < T.libReuseMs) {
            lib = S.sessionLib;
            const age = Math.max(1, Math.round((Date.now() - S.sessionLibAt) / 60000));
            showToast('Reshuffling', `Library from ${age}m ago — Forget in settings to refetch`);
            // reshuffles see fresh likes too (topUpCache self-throttles to one
            // sync / 5 min). Only when a persisted cache exists: a salvaged
            // PARTIAL library must stay session-only, never get written to
            // IndexedDB as if it were a fresh full fetch.
            if (CFG.cacheHours > 0) {
                const libNow = lib;
                idbLoadLib(libKey).then(h => { if (h && h.t) topUpCache(pageType, libKey, libNow, h.t); }).catch(e => swallow(e, 'reuse topUp'));
            }
        }
        if (!lib && CFG.cacheHours > 0) {
            setBtn('Opening cache…');
            let hit = await idbLoadLib(libKey);
            if (!hit && acct) {
                // one-time claim of the pre-account-keying cache, then delete it
                // so a second account can never inherit the first one's library
                const legacy = await idbLoadLib(legacyKey);
                if (legacy && legacy.items) {
                    hit = legacy;
                    idbSaveLib(libKey, legacy.items, legacy.t);
                    LibCache.del(legacyKey).catch(e => swallow(e, 'legacy del'));
                }
            }
            if (hit && hit.items.length >= 3 && !S.cancelled) {
                const cacheAge = Date.now() - (hit.t || 0);
                if (cacheAge < CFG.cacheHours * 3600000) {
                    lib = hit.items;
                    S.sessionLib = lib; S.sessionLibAt = Date.now(); S.sessionLibKey = libKey;
                    const ageM = Math.max(1, Math.round(cacheAge / 60000));
                    const ageTxt = ageM < 60 ? ageM + 'm' : Math.round(ageM / 60) + 'h';
                    showToast(`Instant start — ${lib.length.toLocaleString()} likes from cache`, `${ageTxt} old · syncing new likes in the background`);
                    topUpCache(pageType, libKey, lib, hit.t);   // fire-and-forget
                } else if (cacheAge < 7 * 86400000) {
                    // expired but recent: stale-while-revalidate — instant music
                    // from the old cache, full refresh runs behind it
                    lib = hit.items;
                    S.sessionLib = lib; S.sessionLibAt = Date.now(); S.sessionLibKey = libKey;
                    const ageH = Math.max(1, Math.round(cacheAge / 3600000));
                    showToast(`Instant start — ${lib.length.toLocaleString()} likes from cache`, `${ageH}h old · refreshing your full library in the background`);
                    refreshLibInBackground(pageType, libKey);
                }
            }
        }
        if (S.cancelled) return;
        if (!lib) {
            setBtn('Fetching…');
            // Give the sniffers a moment on cold loads instead of failing
            // straight into the slow compatibility engine.
            await waitFor(() => (S.tpl || S.clientId) && (S.auth || cookieAuth() || pageType === 'GenericLikes'), T.authWait, 150);
            if (S.cancelled) return;
            const est = S.total;
            try {
                lib = await fetchLibrary(pageType, n =>
                    setBtn(`Fetching ${n.toLocaleString()}${est ? '/' + est.toLocaleString() : ''}…`));
            } catch (e) {
                if (S.cancelled) return;
                // Salvage a near-complete fetch rather than throwing it away.
                if (e && e.partial && e.partial.length >= 50) {
                    lib = e.partial;
                    salvaged = true;
                    S.fetchAbort = null;
                    showToast(`Couldn’t fetch everything — shuffling the ${lib.length.toLocaleString()} tracks that made it`);
                } else throw e;
            }
            if (S.cancelled) return;
            if (!lib || lib.length < 3) throw new Error('library too small');
            S.sessionLib = lib; S.sessionLibAt = Date.now(); S.sessionLibKey = libKey;
            if (pageType !== 'GenericLikes') saveCompactCache(lib);   // bh_sc_lib is YOUR library, not theirs
            if (!salvaged && CFG.cacheHours > 0) idbSaveLib(libKey, lib);   // partial fetches stay session-only
        }

        // 2. SHUFFLE
        const { pool, stats } = buildPool(lib, pageType);
        if (pool.length < 3) throw new Error('pool too small');
        LS.set('bh_sc_lastpool', { n: pool.length, ms: stats.totalMs, t: Date.now() });
        S.poolList = pool.map(it => ({
            u: (it.track.permalink_url || '').split('?')[0],
            t: it.track.title || '',
            a: (it.track.user && it.track.user.username) || '',
            ai: it.track.user_id || (it.track.user && it.track.user.id) || 0,
        }));
        S.poolIdx = new Map(S.poolList.map((x, i) => [x.u, i]));
        S.poolAssigned = true;

        F.sid = Math.random().toString(36).slice(2, 9);
        F.pages = chunk(pool, CFG.feedPageSize);
        F.served = 0;
        F.active = true;
        F.armed = true;
        S.poolSize = pool.length;
        S.expected = pool.length + 1;   // + the seed track
        S.total = pool.length + 1;

        // 3. LOAD
        if (!(await seedFromLastRow(list))) throw new Error('seed failed');
        if (S.cancelled) return;

        toggleQueue('open');
        await waitFor(() => q('queueScrollable'), T.queueAppear);
        hideQueuePanel(true);

        if (!startLoader(onLoaderDone)) throw new Error('queue not available');

        let consumed = await waitFor(() => F.served > 0 || S.cancelled, T.feedConsume1);
        if (!consumed && !S.cancelled) {
            toggleQueue('close');
            await pause(T.queueReopenPause);
            toggleQueue('open');
            consumed = await waitFor(() => F.served > 0 || S.cancelled, T.feedConsume2);
        }
        if (S.cancelled) return;
        if (!consumed) throw new Error('feed not consumed');

        const bits = [];
        if (stats.sampledFrom) bits.push(`sampled from ${stats.sampledFrom.toLocaleString()}`);
        if (stats.unplayable) bits.push(`${stats.unplayable} unplayable skipped`);
        if (stats.blockFiltered) bits.push(`${stats.blockFiltered} blocklisted`);
        if (stats.durFiltered) bits.push(`${stats.durFiltered} length-filtered`);
        if (stats.genreFiltered) bits.push(`${stats.genreFiltered} other-genre`);
        if (stats.ageFiltered) bits.push(`${stats.ageFiltered} liked earlier`);
        if (stats.histFiltered) bits.push(`${stats.histFiltered} already heard`);
        if (stats.rotationBypassed) bits.push('nearly all heard — repeats included');
        showToast(`${pool.length.toLocaleString()} tracks · ${fmtH(stats.totalMs)}`, bits.length ? bits.join(' · ') : 'Shuffled fresh, every single one');

        // Instant playback (default): the first page is already in the queue,
        // so start the music now and let the rest stream in behind it. The
        // loader keeps verifying; finish() still reports the honest count.
        if (CFG.earlyStart) { S.earlyBegun = true; beginPlaybackTrue(); }

        // 4. PLAY — handled by onLoaderDone once the whole queue is in.
        function onLoaderDone(ok) {
            if (S.cancelled) return;
            beginPlaybackTrue();
            finish(ok);
        }
    }

    /* ═══════════════════ COMPATIBILITY ENGINE (playlists etc.) ═══════════════════ */
    async function resetQueueToList(listEl) {
        const rows = listEl.children;
        const p1 = q('playButton', rows[0]);
        const p2 = q('playButton', rows[1]);
        if (!p1 || !p2) return false;

        muteAll();
        S.seeded = true;   // the run owns playback from here: cancel() pauses the seed, never earlier music
        const pc0 = q('playControl');
        if (pc0 && pc0.classList.contains('playing')) clickIt(pc0);

        clickIt(p2);
        await waitFor(() => p2.classList.contains('sc-button-pause') ||
            (q('playControl') || { classList: { contains: () => false } }).classList.contains('playing'), T.seedClickWait, 50);
        if (S.cancelled) return false;

        clickIt(p1);
        await waitFor(() => p1.classList.contains('sc-button-pause'), T.seedClickWait, 50);

        const pc = q('playControl');
        if (pc && pc.classList.contains('playing')) clickIt(pc);

        let dupAdded = false;
        const more = q('moreButton', listEl);
        if (more && !S.cancelled) {
            clickIt(more);
            const item = await waitFor(() => q('addToNextUp'), T.menuWait);
            if (item) { clickIt(item); dupAdded = true; }
            else if (document.body) document.body.click();
        }
        return dupAdded;
    }
    function ensureShuffleOn(reshuffle) {
        const sh = q('shuffleControl');
        if (!sh) return;
        const on = sh.classList.contains('m-shuffling');
        if (on && reshuffle) { clickIt(sh); clickIt(sh); }
        else if (!on) clickIt(sh);
    }
    function beginPlayback(skipDup) {
        if (S.beganPlayback) return;
        S.beganPlayback = true;
        unmuteAll();
        ensureShuffleOn(true);
        if (skipDup !== false) clickIt(q('skipNext'));
        S.playingStarted = true;
        const pc = q('playControl');
        if (pc) { if (!pc.classList.contains('playing')) clickIt(pc); focusIdle(pc); }
    }
    async function runClassic(btn, list) {
        S.boosting = true;
        const dupAdded = await resetQueueToList(list);
        if (S.cancelled) return;

        toggleQueue('open');
        await waitFor(() => q('queueScrollable'), T.queueAppear);
        if (S.cancelled) return;
        hideQueuePanel(true);

        if (!startLoader(ok => {
            if (S.cancelled) return;
            beginPlayback(dupAdded);
            finish(ok);
        })) throw new Error('queue not available');
    }

    /* ───────────────────────── SHARED LOADER ──────────────────────────
     * Completion, in order of trust:
     *   1. (likes) every pre-shuffled page has been SERVED to the queue
     *      and the API said done — we handed the data over ourselves, so
     *      this is independent of pixel math,
     *   2. exact DOM target reached,
     *   3. API said "no more pages" AND the queue grew,
     *   4. SoundCloud's end-of-queue block present AND a sustained stall
     *      well past startup,
     *   5. long hard stall (last resort). */
    function startLoader(onDone) {
        const scrollable = q('queueScrollable');
        const heights = q('queueHeights');
        if (!scrollable || !heights) { return false; }

        S.lastCount = S.startCount = loadedCount();
        S.startTime = Date.now();
        S.stall = 0;

        const kick = () => {
            const h = parseInt(heights.style.height, 10) || scrollable.scrollHeight;
            scrollable.scrollTop = h;
            try { scrollable.scroll(0, h); } catch (e) {}
            scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
        };

        // throttle the mutation storm: during a 10k-track load every row insert
        // fires this, and the 100ms ticker kicks anyway
        let lastMoKick = 0;
        S.mo = new MutationObserver(() => {
            const now2 = Date.now();
            if (now2 - lastMoKick > 80) { lastMoKick = now2; kick(); }
        });
        S.mo.observe(heights, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true });

        S.ticker = makeTicker(() => {
            if (!S.active) return;
            if (!queueOpen()) toggleQueue('open');
            kick();

            const n = loadedCount();
            if (n > S.lastCount) { S.lastCount = n; S.stall = 0; }
            else S.stall++;

            updateProgress(n);

            const elapsed = Date.now() - S.startTime;
            const grew = n > S.startCount + 2;
            const fedAll = F.active && S.poolSize > 0 && F.served >= S.poolSize;
            const done =
                (fedAll && S.endSeen && S.stall >= 2) ||
                (S.expected && (!F.active || fedAll) && n >= S.expected - 2 && S.stall >= 2) ||   // feed runs: n also counts rows loaded before the seed
                (S.endSeen && grew && S.stall >= 4) ||
                (q('queueFallback') && S.stall >= 12 && elapsed > 4000) ||
                S.stall >= CFG.stallDoneTicks;
            if (done) { stopLoader(); onDone(true); return; }

            if (S.stall && S.stall % CFG.stallKickTicks === 0) {
                scrollable.scrollTop = Math.max(0, scrollable.scrollTop - 500);
                kick();
            }
        }, CFG.tickMs);

        kick();
        return true;
    }
    function stopLoader() {
        if (S.ticker) { S.ticker.stop(); S.ticker = null; }
        if (S.mo) { S.mo.disconnect(); S.mo = null; }
    }

    /* ───────────────────────── DISPATCH / LIFECYCLE ───────────────────────── */
    const LIST_KEY = { Likes: 'likesList', GenericLikes: 'likesList', Playlist: 'playlistList', Discover: 'discoverList' };

    async function run(btn) {
        if (S.active) {
            if (Date.now() - S.startedAt < 800) return;   // accidental double-click guard
            cancel('Shuffle Play');
            return;
        }
        // a cancelled run can still be parked in an await (auth wait, cache
        // load, queue seed). Let it unwind before starting another, or two
        // loaders fight over the same queue and the first one's observer and
        // ticker leak for the rest of the session.
        if (S.runInFlight) { showToast('Still stopping the last shuffle — try again in a moment'); return; }
        S.runInFlight = runOnce(btn).catch(e => swallow(e, 'run')).then(() => { S.runInFlight = null; });
    }
    async function runOnce(btn) {
        S.btn = btn;
        const pageType = btn.dataset.pageType;
        const list = q(LIST_KEY[pageType]);
        if (!list || list.childElementCount < 3) {
            setBtn('Too few tracks');
            if (pageType === 'Likes') showToast('Nothing to shuffle here yet — make sure you’re signed in and your Likes have loaded');
            const at = S.startedAt; setTimeout(() => { if (!S.active && S.startedAt === at) setBtn('Shuffle Play'); }, 3000);
            return;
        }

        S.active = true; S.cancelled = false; S.startedAt = Date.now();
        S.boosting = false; S.boostFails = 0; S.endSeen = false; S.expected = 0; S.poolSize = 0;
        S.btn = btn; S.playingStarted = false; S.seeded = false; S.beganPlayback = false; S.earlyBegun = false; S.itemH = 0; S.itemHAt = 0;
        S.lastRunPath = location.pathname;
        S.prevPoolList = S.poolList; S.prevPoolIdx = S.poolIdx; S.poolAssigned = false;
        S.total = findTotal(pageType);
        startWatcher();
        setBtn('Starting…');
        setBusy(true);
        if (!Ticker.usingWorker() && !SS.get('bh_sc_wkwarn', 0)) {
            SS.set('bh_sc_wkwarn', 1);
            showToast('Heads-up: background timers are limited here — keep this tab visible while it loads');
        }

        try {
            const likesPage = pageType === 'Likes' || pageType === 'GenericLikes';
            if (likesPage) {
                try {
                    await runTrue(btn, list, pageType);
                    return;
                } catch (e) {
                    log('Likes engine failed → compatibility:', e);
                    stopLoader();
                    cleanupFeed();
                    if (S.cancelled) return;
                    S.endSeen = false; S.playingStarted = false; S.beganPlayback = false; S.earlyBegun = false; S.expected = 0; S.poolSize = 0;
                    // native shuffle order is unknowable — never advertise a stale
                    // pool, and don't let a later cancel() "restore" one either
                    S.poolList = null; S.poolIdx = null;
                    S.prevPoolList = null; S.prevPoolIdx = null;
                    S.total = findTotal(pageType);   // progress must count the native queue, not the failed run's pool
                    showToast('Compatibility mode for this one (a bit slower)');
                    setBtn('Loading…');
                }
            }
            await runClassic(btn, list);
        } catch (e) {
            console.error('[SC-Shuffle]', e);
            cancel('Error – try again');
        }
    }

    function cleanupFeed() {
        F.active = false; F.armed = false; F.pages = []; F.served = 0; F.sid = '';
        if (S.fetchAbort) { try { S.fetchAbort.abort(); } catch (e) {} S.fetchAbort = null; }
    }
    function finish(ok) {
        stopLoader();
        S.boosting = false;
        const wasFeed = F.active;
        const served = wasFeed ? F.served : 0;     // exact: WE handed these pages over
        cleanupFeed();
        hideQueuePanel(false);
        toggleQueue('close');
        unmuteAll();
        let n = Math.max(S.lastCount || 0, loadedCount());
        const target = wasFeed ? S.poolSize : 0;
        S.expected = 0; S.poolSize = 0;
        if (wasFeed && served) n = Math.min(served, target || served);   // report the precise pool size
        S.active = false;
        if (target && n < Math.floor(target * 0.9)) {
            showToast(`Heads up — only ${n.toLocaleString()} of ${target.toLocaleString()} made it in`, 'Tap Shuffle Play to retry');
            setBtn('Shuffle Play');
        } else {
            setBtn(ok && n ? `✓ ${n.toLocaleString()} queued` : 'Shuffle Play');
            if (ok && n && S.btn) {
                S.btn.classList.add('bhx-pulse');
                setTimeout(() => { if (S.btn) S.btn.classList.remove('bhx-pulse'); }, 700);
            }
            if (ok && n && wasFeed && S.earlyBegun) showToast(`All ${n.toLocaleString()} tracks in`, 'Queue fully loaded & verified');
            const at = S.startedAt; setTimeout(() => { if (!S.active && S.startedAt === at) setBtn('Shuffle Play'); }, 3500);
        }
        setBtnProgress(null);
        setBusy(false);
        S.beganPlayback = false; S.earlyBegun = false;
        focusIdle(q('playControl'));
    }
    function cancel(label) {
        S.cancelled = true;
        stopLoader();
        S.boosting = false;
        cleanupFeed();
        hideQueuePanel(false);
        toggleQueue('close');
        unmuteAll();
        if (S.seeded && !S.playingStarted) {   // pause only a seed WE started, never music the run never touched
            const pc = q('playControl');
            if (pc && pc.classList.contains('playing')) clickIt(pc);
        }
        S.active = false; S.expected = 0; S.poolSize = 0; S.beganPlayback = false; S.earlyBegun = false;
        // which pool survives a cancel?
        //  · new pool assigned + its playback already began → it IS the queue, keep it
        //  · new pool assigned but never played → queue was replaced mid-load, no pool is true
        //  · no pool assigned yet (cancelled during fetch) → the previous run's pool still plays
        if (S.poolAssigned && !S.playingStarted) { S.poolList = null; S.poolIdx = null; }
        else if (!S.poolAssigned) { S.poolList = S.prevPoolList; S.poolIdx = S.prevPoolIdx; }
        if (label) setBtn(label);
        setBtnProgress(null);
        setBusy(false);
    }

    /* ───────────────────────── CARDS (settings / stats) ─────────────────────────
     * One card at a time, anchored to its trigger, closed by Esc / outside
     * click / the × button. Switches are real buttons (role="switch") so
     * keyboard and screen-reader users can change every setting. */
    let card = null;
    function onDocDown(e) {
        if (!card) return;
        // composedPath: anchors inside the lyrics panel's shadow root retarget
        // e.target to the host div — contains() alone closes the card wrongly
        const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
        if (path ? path.includes(card) : card.contains(e.target)) return;
        const a = card.__anchor;
        if (a && (path ? path.includes(a) : (a === e.target || a.contains(e.target)))) return; // anchor click toggles instead
        closeCard();
    }
    function onDocKey(e) { if (e.key === 'Escape') closeCard(true); }
    function closeCard(restoreFocus) {
        if (!card) return;
        const a = card.__anchor;
        const had = card.contains(document.activeElement);   // keyboard users: hand focus back to the trigger
        card.remove();
        card = null;
        document.removeEventListener('mousedown', onDocDown, true);
        document.removeEventListener('keydown', onDocKey, true);
        // only Escape and the close button restore it (=== true: the button listener used to get the event)
        if (restoreFocus === true && had && a && a.isConnected) { try { a.focus({ preventScroll: true }); } catch (e) {} }
    }
    function showCard(anchor, build) {
        injectStyle(); applyTheme();
        closeCard();
        card = document.createElement('div');
        card.className = 'bhx-card';
        card.setAttribute('role', 'dialog');
        card.__anchor = anchor;
        card.style.visibility = 'hidden';
        build(card);
        document.body.appendChild(card);
        const r = anchor.getBoundingClientRect();
        const cw = card.offsetWidth || 294, ch = card.offsetHeight || 320;
        let left = Math.min(Math.max(8, r.left + r.width / 2 - cw / 2), innerWidth - cw - 8);
        let top = r.top - ch - 10;
        if (top < 8) top = Math.min(innerHeight - ch - 8, r.bottom + 10);
        card.style.left = left + 'px';
        card.style.top = Math.max(8, top) + 'px';
        card.style.visibility = '';
        setTimeout(() => {
            document.addEventListener('mousedown', onDocDown, true);
            document.addEventListener('keydown', onDocKey, true);
        }, 0);
        const x = card.querySelector('.bhx-x');
        if (x) { try { x.focus({ preventScroll: true }); } catch (e) { x.focus(); } }
    }
    function el(tag, cls, html) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html != null) n.innerHTML = html;
        return n;
    }
    function head(c, iconName, title) {
        c.setAttribute('aria-label', title);
        const h = el('div', 'bhx-head', ICONS[iconName](14) + '<span></span>');
        h.querySelector('span').textContent = title;
        const x = el('button', 'bhx-x', ICONS.x(12));
        x.type = 'button';
        x.setAttribute('aria-label', 'Close');
        x.addEventListener('click', () => closeCard(true));
        h.appendChild(x);
        c.appendChild(h);
    }
    function swRow(parent, key, label, sub) {
        const row = el('div', 'bhx-row');
        row.appendChild(el('div', 'bhx-lab', label + (sub ? '<span class="bhx-sub">' + sub + '</span>' : '')));
        const sw = el('button', 'bhx-sw' + (CFG[key] ? ' on' : ''));
        sw.type = 'button';
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', String(!!CFG[key]));
        sw.setAttribute('aria-label', label);
        sw.addEventListener('click', () => {
            CFG[key] = !CFG[key];
            saveCfg();
            sw.classList.toggle('on', CFG[key]);
            sw.setAttribute('aria-checked', String(!!CFG[key]));
        });
        row.appendChild(sw);
        parent.appendChild(row);
        return row;
    }
    function numRow(parent, key, label, sub, min, max) {
        const row = el('div', 'bhx-row');
        row.appendChild(el('div', 'bhx-lab', label + (sub ? '<span class="bhx-sub">' + sub + '</span>' : '')));
        const inp = el('input', 'bhx-num');
        inp.type = 'number';
        inp.min = min; inp.max = max;
        inp.value = CFG[key];
        inp.setAttribute('aria-label', label);
        inp.addEventListener('change', () => {
            let v = parseInt(inp.value, 10);
            if (!isFinite(v)) v = min;
            v = Math.min(max, Math.max(min, v));
            inp.value = v;
            CFG[key] = v;
            saveCfg();
        });
        row.appendChild(inp);
        parent.appendChild(row);
        return row;
    }

    /* Full-library CSV: the IDB cache already holds everything in full
     * fidelity — one click turns it into a portable backup of your likes. */
    function exportLibraryCsv() {
        const doIt = (items) => {
            try {
                if (!items || !items.length) { showToast('No library cached — run a shuffle first'); return; }
                const esc2 = v => {
                    v = String(v == null ? '' : v);
                    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;   // spreadsheet formula-injection guard (OWASP set)
                    return /[",\r\n\t]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
                };
                const rows = ['id,url,artist,title,duration_ms,genre,liked_at,playback_count'];
                for (const it of items) {
                    const t = it.track || {};
                    rows.push([
                        t.id, (t.permalink_url || '').split('?')[0],
                        (t.user && t.user.username) || '', t.title || '',
                        Math.max(t.full_duration || 0, t.duration || 0),
                        t.genre || '', it.created_at || '',
                        t.playback_count != null ? t.playback_count : '',
                    ].map(esc2).join(','));
                }
                const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'soundcloud-likes-' + new Date().toISOString().slice(0, 10) + '.csv';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
                showToast('Library exported', items.length.toLocaleString() + ' tracks as CSV');
            } catch (e) { swallow(e, 'exportLibraryCsv'); showToast('Export failed'); }
        };
        // only trust the session lib when it's YOUR likes — a GenericLikes or
        // playlist run leaves someone else's library in memory
        if (S.sessionLib && String(S.sessionLibKey).indexOf('Likes:you') === 0) { doIt(S.sessionLib); return; }
        idbLoadLib(ownLibKey()).then(h => {
            if (h && h.items) doIt(h.items);
            else idbLoadLib('Likes:you').then(h2 => doIt(h2 && h2.items)).catch(() => doIt(null));
        }).catch(() => doIt(null));
    }

    function exportData() {
        try {
            const data = { v: 8, cfg: CFG, history: loadHistory(), alltime: allTime, block: loadBlock(), plays: LS.get(PLAYS_KEY, {}), daily, hours: hourly, broken: LS.get(BROKEN_KEY, []) };
            try { if (SUITE.lyricsDump) { const ld = SUITE.lyricsDump(); if (ld) data.lyrics = ld; } } catch (e) {}
            try { if (SUITE.enhancerDump) { const ed = SUITE.enhancerDump(); if (ed) data.enhancer = ed; } } catch (e) {}   // whole-suite backup
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'soundcloud-suite-backup-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
            showToast('Full backup downloaded', 'Shuffle + lyrics + enhancer settings');
        } catch (e) { swallow(e, 'export'); showToast('Export failed'); }
    }
    function importData(file) {
        const r = new FileReader();
        r.onload = () => {
            try {
                const d = JSON.parse(r.result);
                if (!d || typeof d !== 'object') throw new Error('not an object');
                if (d.cfg && typeof d.cfg === 'object') {
                    // whitelist known keys (and re-clamp): never Object.assign
                    // untrusted JSON into live config
                    for (const k of Object.keys(DEFAULTS)) {
                        if (k === '_v' || k === '_r') continue;
                        if (Object.prototype.hasOwnProperty.call(d.cfg, k) && typeof d.cfg[k] === typeof DEFAULTS[k]) CFG[k] = d.cfg[k];
                    }
                    clampCfg();
                    saveCfg();
                }
                // every list below is untrusted JSON: coerce shapes and cap sizes so a
                // hand-edited or oversized backup can't wedge the stats card or the quota
                const arr = x => Array.isArray(x) ? x.slice(-2000) : [];
                if (d.history && typeof d.history === 'object') LS.set(HIST_KEY, { ids: arr(d.history.ids), urls: arr(d.history.urls), ts: arr(d.history.ts) });
                if (Array.isArray(d.broken)) LS.set(BROKEN_KEY, d.broken.filter(x => x && typeof x.u === 'string' && x.u).slice(-200));
                try { if (d.lyrics && SUITE.lyricsRestore) SUITE.lyricsRestore(d.lyrics); } catch (e) {}
                try { if (d.enhancer && SUITE.enhancerRestore) SUITE.enhancerRestore(d.enhancer); } catch (e) {}
                if (d.alltime && typeof d.alltime === 'object') {
                    allTime.listenMs = Math.max(0, +d.alltime.listenMs || 0);
                    allTime.played = Math.max(0, d.alltime.played | 0);
                    LS.set('bh_sc_alltime', allTime);
                }
                if (d.block && typeof d.block === 'object') saveBlock({ tracks: arr(d.block.tracks), urls: arr(d.block.urls), artists: arr(d.block.artists) });
                if (d.plays && typeof d.plays === 'object') {
                    const plays = {};
                    for (const k2 of Object.keys(d.plays)) if (Array.isArray(d.plays[k2])) plays[k2] = d.plays[k2];
                    LS.set(PLAYS_KEY, plays);
                }
                if (d.hours && typeof d.hours === 'object') {
                    for (let h2 = 0; h2 < 24; h2++) { const v = +d.hours[h2]; if (isFinite(v) && v >= 0) hourly[h2] = v; }
                    LS.set('bh_sc_hours', hourly);
                }
                if (d.daily && typeof d.daily === 'object') {
                    Object.keys(daily).forEach(k2 => delete daily[k2]);
                    Object.assign(daily, d.daily);
                    LS.set('bh_sc_daily', daily);
                }
                showToast('Backup imported — settings, history and stats restored');
                closeCard();
            } catch (e) { swallow(e, 'import'); showToast('That file doesn’t look like a SoundCloud Suite backup'); }
        };
        r.onerror = () => showToast('Couldn’t read that file');
        r.readAsText(file);
    }

    /* Genre picker: a sub-card listing the library's top genres as switches.
     * Loads from the session lib or the IndexedDB cache (full objects only —
     * the compact cache doesn't carry genre). */
    function openGenrePicker(anchor, onChange) {
        showCard(anchor, c => {
            head(c, 'sliders', 'Genres');
            const b = el('div', 'bhx-body');
            c.appendChild(b);
            b.appendChild(el('div', 'bhx-row', '<div class="bhx-lab"><span class="bhx-sub">Loading your library…</span></div>'));
            const fill = (items) => {
                b.replaceChildren();
                if (!items || !items.length) {
                    b.appendChild(el('div', 'bhx-row', '<div class="bhx-lab">No library cached yet<span class="bhx-sub">Run a shuffle once, then pick genres here.</span></div>'));
                    return;
                }
                const counts = new Map();
                for (const it of items) {
                    const g = String((it.track && it.track.genre) || '').trim();
                    if (!g) continue;
                    const k = g.toLowerCase();
                    const e2 = counts.get(k) || { label: g, n: 0 };
                    e2.n++;
                    counts.set(k, e2);
                }
                const top = [...counts.entries()].filter(([, v]) => v.n >= 2).sort((x, y) => y[1].n - x[1].n).slice(0, 16);
                if (!top.length) {
                    b.appendChild(el('div', 'bhx-row', '<div class="bhx-lab">No genre tags in this library<span class="bhx-sub">Uploaders didn’t tag these tracks.</span></div>'));
                    return;
                }
                b.appendChild(el('div', 'bhx-sec', 'Shuffle only these genres'));
                const sel = new Set(CFG.genreFilter.map(g => g.toLowerCase()));
                for (const [k, v] of top) {
                    const row = el('div', 'bhx-row');
                    const lab = el('div', 'bhx-lab');
                    lab.textContent = v.label;
                    const sub = el('span', 'bhx-sub');
                    sub.textContent = v.n.toLocaleString() + ' tracks';
                    lab.appendChild(sub);
                    row.appendChild(lab);
                    const sw = el('button', 'bhx-sw' + (sel.has(k) ? ' on' : ''));
                    sw.type = 'button';
                    sw.setAttribute('role', 'switch');
                    sw.setAttribute('aria-checked', String(sel.has(k)));
                    sw.setAttribute('aria-label', v.label);
                    sw.addEventListener('click', () => {
                        if (sel.has(k)) sel.delete(k); else sel.add(k);
                        CFG.genreFilter = [...sel];
                        saveCfg();
                        if (onChange) { try { onChange(); } catch (e) {} }
                        sw.classList.toggle('on', sel.has(k));
                        sw.setAttribute('aria-checked', String(sel.has(k)));
                    });
                    row.appendChild(sw);
                    b.appendChild(row);
                }
                const foot = el('div', 'bhx-foot');
                const allB = el('button', 'bhx-btn', 'Everything');
                allB.type = 'button';
                allB.title = 'Clear the genre filter';
                allB.addEventListener('click', () => {
                    sel.clear();
                    CFG.genreFilter = [];
                    saveCfg();
                    if (onChange) { try { onChange(); } catch (e) {} }
                    b.querySelectorAll('.bhx-sw').forEach(s2 => { s2.classList.remove('on'); s2.setAttribute('aria-checked', 'false'); });
                    showToast('Genre filter off — shuffling everything');
                });
                foot.appendChild(allB);
                const backB = el('button', 'bhx-btn', 'Back');
                backB.type = 'button';
                backB.addEventListener('click', () => { closeCard(); if (SUITE.openLyricsTweaks) { try { SUITE.openLyricsTweaks(); return; } catch (e) {} } openSettings(anchor); });
                foot.appendChild(backB);
                b.appendChild(foot);
                b.appendChild(el('div', 'bhx-hint', 'Applies from the next shuffle · genre comes from each track’s tag'));
                // the card was positioned at "Loading…" height — re-clamp after growing
                requestAnimationFrame(() => {
                    try {
                        const r2 = c.getBoundingClientRect();
                        if (r2.bottom > innerHeight - 8) c.style.top = Math.max(8, innerHeight - 8 - r2.height) + 'px';
                    } catch (e) {}
                });
            };
            if (S.sessionLib && String(S.sessionLibKey).indexOf('Likes:you') === 0) fill(S.sessionLib);
            else idbLoadLib(ownLibKey()).then(h => {
                if (h && h.items) fill(h.items);
                else idbLoadLib('Likes:you').then(h2 => fill(h2 && h2.items)).catch(() => fill(null));
            }).catch(() => fill(null));
        });
    }

    function openSettings(anchor) {
        showCard(anchor, c => {
            head(c, 'sliders', 'Shuffle settings');
            const b = el('div', 'bhx-body');
            c.appendChild(b);

            b.appendChild(el('div', 'bhx-sec', 'Playback'));
            swRow(b, 'spreadArtists', 'Spread artists', 'No artist twice in a row');
            swRow(b, 'noRepeat', 'Fresh picks', 'Skip tracks you’ve already heard');
            swRow(b, 'autoSkipStuck', 'Auto-skip broken tracks', 'Skip tracks that refuse to start');
            swRow(b, 'smartSuggest', 'Smart nudges', 'Offer a reshuffle after rapid skips');
            const oRow = el('div', 'bhx-row');
            oRow.appendChild(el('div', 'bhx-lab', 'Order'));
            const oSel = el('select', 'bhx-sel');
            [['random', 'Surprise me'], ['rediscover', 'Rediscover older likes']].forEach(([v, t]) => {
                const o = el('option'); o.value = v; o.textContent = t;
                if (CFG.orderMode === v) o.selected = true;
                oSel.appendChild(o);
            });
            oSel.setAttribute('aria-label', 'Shuffle order');
            oSel.addEventListener('change', () => { CFG.orderMode = oSel.value; saveCfg(); });
            oRow.appendChild(oSel);
            b.appendChild(oRow);
            const sleepSub = () => {
                if (sleepArmed) return '<span class="bhx-sub">Pausing after this track</span>';
                const rem = sleepRemainingMs();
                return rem ? '<span class="bhx-sub">' + Math.max(1, Math.ceil(rem / 60000)) + 'm left</span>'
                           : '<span class="bhx-sub">Pause the music later</span>';
            };
            const sRow = el('div', 'bhx-row');
            const sLab = el('div', 'bhx-lab', 'Sleep timer' + sleepSub());
            sRow.appendChild(sLab);
            const sGrp = el('div', 'bhx-btnrow');
            [[30, '30m'], [60, '1h'], [120, '2h'], [0, 'Off']].forEach(([m, t]) => {
                const bb = el('button', 'bhx-btn sm', t);
                bb.type = 'button';
                bb.addEventListener('click', () => {
                    if (m) { sleepArmed = false; sleepAt = Date.now() + m * 60000; SS.set('bh_sc_sleep', sleepAt); showToast('Sleep timer set — pausing in ' + t); }
                    else { clearSleep(); showToast('Sleep timer off'); }
                    sLab.innerHTML = 'Sleep timer' + sleepSub();
                });
                sGrp.appendChild(bb);
            });
            sRow.appendChild(sGrp);
            b.appendChild(sRow);

            b.appendChild(el('div', 'bhx-sec', 'Include'));
            const fRow = el('div', 'bhx-row');
            fRow.appendChild(el('div', 'bhx-lab', 'Tracks'));
            const fSel = el('select', 'bhx-sel');
            [['all', 'Everything'], ['songs', 'Songs only (skip long)'], ['mixes', 'Mixes only (skip short)']].forEach(([v, t]) => {
                const o = el('option'); o.value = v; o.textContent = t;
                if (CFG.filterMode === v) o.selected = true;
                fSel.appendChild(o);
            });
            fSel.setAttribute('aria-label', 'Which tracks to include');
            fRow.appendChild(fSel);
            b.appendChild(fRow);
            const mRow = numRow(b, 'filterMinutes', 'Long = over', 'minutes', 1, 600);
            const updF = () => { mRow.style.display = CFG.filterMode === 'all' ? 'none' : ''; };
            fSel.addEventListener('change', () => { CFG.filterMode = fSel.value; saveCfg(); updF(); });
            updF();
            swRow(b, 'skipUnplayable', 'Skip unplayable', 'Region-blocked or removed tracks');
            numRow(b, 'sampleCap', 'Queue size cap', '0 = your whole library', 0, 100000);
            const gRow = el('div', 'bhx-row');
            const gLab = el('div', 'bhx-lab', 'Genres<span class="bhx-sub">' + (CFG.genreFilter.length ? CFG.genreFilter.length + ' selected' : 'All genres') + '</span>');
            gRow.appendChild(gLab);
            const gGrp = el('div', 'bhx-btnrow');
            const gBtn = el('button', 'bhx-btn sm', 'Pick');
            gBtn.type = 'button';
            gBtn.title = 'Shuffle only certain genres';
            gBtn.addEventListener('click', () => openGenrePicker(anchor));
            gGrp.appendChild(gBtn);
            gRow.appendChild(gGrp);
            b.appendChild(gRow);
            numRow(b, 'likedDays', 'Liked in the last', 'days · 0 = any time', 0, 3650);

            b.appendChild(el('div', 'bhx-sec', 'Setup'));
            swRow(b, 'silentSetup', 'Silent setup', 'Mute and hide the queue while loading');
            swRow(b, 'earlyStart', 'Instant playback', 'Play as soon as the first page lands — the rest loads behind');

            b.appendChild(el('div', 'bhx-sec', 'Stats'));
            numRow(b, 'playThresholdSec', 'Counts as played after', 'seconds', 5, 300);

            b.appendChild(el('div', 'bhx-sec', 'Blocklist'));
            const cur = el('div', 'bhx-row');
            cur.appendChild(el('div', 'bhx-lab', 'Block current<span class="bhx-sub">Never shuffle it again</span>'));
            const curGrp = el('div', 'bhx-btnrow');
            const counts = el('div', 'bhx-row');
            const cLab = el('div', 'bhx-lab');
            const cText = () => {
                const bk = loadBlock();
                const t = bk.tracks.length + bk.urls.length, ar = bk.artists.length;
                return 'Blocked<span class="bhx-sub">' + t + ' track' + (t === 1 ? '' : 's') + ' · ' + ar + ' artist' + (ar === 1 ? '' : 's') + '</span>';
            };
            cLab.innerHTML = cText();
            const mkSm = (parentGrp, txt, fn) => {
                const bb = el('button', 'bhx-btn sm', txt);
                bb.type = 'button';
                bb.addEventListener('click', () => { fn(); cLab.innerHTML = cText(); });
                parentGrp.appendChild(bb);
            };
            mkSm(curGrp, 'Track', () => { blockCurrentTrack(false); });
            mkSm(curGrp, 'Artist', () => {
                const info = currentTrackInfo();
                if (!info) { showToast('Play a track first'); return; }
                if (info.artistId == null) { showToast('Can’t identify this artist yet — run a shuffle first'); return; }
                const bk = loadBlock();
                if (!bk.artists.includes(info.artistId)) bk.artists.push(info.artistId);
                saveBlock(bk);
                if (S.poolList) {
                    // purge by artist ID (usernames are truncated to 24 chars in the
                    // compact cache) and keep the playing track — it's the Up-next anchor
                    S.poolList = S.poolList.filter(x => x.ai !== info.artistId || x.u === info.url);
                    S.poolIdx = new Map(S.poolList.map((x, i) => [x.u, i]));
                }
                showToast('Artist blocked' + (info.artist ? ' — ' + info.artist : ''), 'None of their tracks will be shuffled');
            });
            cur.appendChild(curGrp);
            b.appendChild(cur);
            const cGrp = el('div', 'bhx-btnrow');
            mkSm(cGrp, 'Clear', () => { saveBlock({ tracks: [], urls: [], artists: [] }); showToast('Blocklist cleared'); });
            counts.appendChild(cLab);
            counts.appendChild(cGrp);
            b.appendChild(counts);

            b.appendChild(el('div', 'bhx-sec', 'Data'));
            numRow(b, 'cacheHours', 'Keep library cached for', 'hours · 0 = refetch every time', 0, 168);
            const rRow = el('div', 'bhx-row');
            const ccm = getLibMap();
            const cc = ccm ? { items: ccm.__items } : null;
            const libSub = S.sessionLib
                ? S.sessionLib.length.toLocaleString() + ' tracks in memory'
                : (cc && cc.items && cc.items.length ? cc.items.length.toLocaleString() + ' tracks cached on disk' : 'empty — next shuffle fetches fresh');
            rRow.appendChild(el('div', 'bhx-lab', 'Cached library<span class="bhx-sub">' + libSub + '</span>'));
            const rGrp = el('div', 'bhx-btnrow');
            mkSm(rGrp, 'Forget', () => {
                S.sessionLib = null; S.sessionLibAt = 0; S.sessionLibKey = '';
                idbClearLib();
                LS.del('bh_sc_lib');
                invalidateLibMap();
                rRow.querySelector('.bhx-lab').innerHTML = 'Cached library<span class="bhx-sub">cleared — next shuffle fetches fresh</span>';
                showToast('Cache cleared — the next shuffle will refetch everything');
            });
            rRow.appendChild(rGrp);
            b.appendChild(rRow);

            // ListenBrainz scrobbling (token lives in GM storage, off by default)
            const lbRow = el('div', 'bhx-row');
            const lbSubTxt = () => 'ListenBrainz<span class="bhx-sub">' +
                (lbToken() ? 'Scrobbling plays' + (LS.get(LB_QKEY, []).length ? ' · ' + LS.get(LB_QKEY, []).length + ' queued' : '') : 'Off — add your user token to scrobble') + '</span>';
            const lbLab = el('div', 'bhx-lab', lbSubTxt());
            lbRow.appendChild(lbLab);
            const lbGrp = el('div', 'bhx-btnrow');
            const lbBtn = el('button', 'bhx-btn sm', 'Token');
            lbBtn.type = 'button';
            lbBtn.title = 'Set or clear your ListenBrainz user token';
            lbBtn.addEventListener('click', () => {
                let t = null;
                try { t = prompt('ListenBrainz user token (listenbrainz.org → Settings). Leave empty to turn scrobbling off. It is kept in this browser’s site data for soundcloud.com.', lbToken() || ''); } catch (e) {}
                if (t === null) return;
                t = t.replace(/^\s*token\s+/i, '');
                try { GM_setValue('bh:lbtok', t.trim()); } catch (e) {}
                lbLab.innerHTML = lbSubTxt();
                showToast(t.trim() ? 'ListenBrainz on — plays will scrobble' : 'ListenBrainz off');
                if (t.trim()) lbFlush();
            });
            lbGrp.appendChild(lbBtn);
            lbRow.appendChild(lbGrp);
            b.appendChild(lbRow);

            const foot = el('div', 'bhx-foot');
            const mkFoot = (txt, fn, title) => {
                const bb = el('button', 'bhx-btn', txt);
                bb.type = 'button';
                if (title) bb.title = title;
                bb.addEventListener('click', fn);
                foot.appendChild(bb);
            };
            const heardN = loadHistory().urls.length;
            mkFoot('Reset heard' + (heardN ? ' (' + heardN + ')' : ''), () => {
                clearHistory();
                showToast('Heard history cleared — everything is a fresh pick again');
                closeCard();
            }, 'Clear the fresh-picks history');
            mkFoot('Export', exportData, 'Download settings, history, stats & lyrics as JSON');
            mkFoot('CSV', exportLibraryCsv, 'Download your whole likes library as a CSV');
            const fileInp = el('input');
            fileInp.type = 'file';
            fileInp.accept = 'application/json,.json';
            fileInp.style.display = 'none';
            fileInp.addEventListener('change', () => { if (fileInp.files && fileInp.files[0]) importData(fileInp.files[0]); fileInp.value = ''; });   // same file twice must fire again
            mkFoot('Import', () => fileInp.click(), 'Restore from a backup file');
            b.appendChild(foot);
            b.appendChild(fileInp);
            b.appendChild(el('div', 'bhx-hint', 'Alt+S shuffle · Alt+B block playing · local-only'));
        });
    }

    // Render the shuffle settings INLINE into a container (no modal card) so the
    // lyrics hub's Tweaks tab can host them — fully inline styles so nothing
    // depends on the shuffle module's page CSS (which can't reach the shadow DOM).
    function shuffleRender(container) {
      try {
        if (!container) return;
        const D2 = document;
        container.replaceChildren();
        const mkLabel = (label, desc) => {
          const lab = D2.createElement('div'); lab.style.cssText = 'flex:1;min-width:0;font-size:12px;font-weight:500;color:#e8e8ec';
          const ls = D2.createElement('span'); ls.textContent = label; lab.appendChild(ls);
          if (desc) { const sm = D2.createElement('small'); sm.textContent = desc; sm.style.cssText = 'display:block;font-size:10px;color:#8a8a92;font-weight:400;margin-top:1px'; lab.appendChild(sm); }
          return lab;
        };
        const mkRow = () => { const row = D2.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid rgba(255,255,255,.05)'; return row; };
        const subHead = (t) => { const s = D2.createElement('div'); s.textContent = t; s.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:#83838c;margin:12px 0 2px'; container.appendChild(s); };
        const toggle = (key, label, desc) => {
          const row = mkRow(); row.appendChild(mkLabel(label, desc));
          const sw = D2.createElement('button'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', label);
          sw.style.cssText = 'position:relative;width:34px;height:19px;border-radius:19px;border:0;cursor:pointer;flex:none;transition:background .18s';
          const knob = D2.createElement('span'); knob.style.cssText = 'position:absolute;top:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left .18s;box-shadow:0 1px 3px rgba(0,0,0,.4)'; sw.appendChild(knob);
          const paint = () => { const on = !!CFG[key]; sw.style.background = on ? '#ff5500' : 'rgba(255,255,255,.18)'; knob.style.left = on ? '17px' : '2px'; sw.setAttribute('aria-checked', String(on)); };
          paint(); sw.addEventListener('click', () => { CFG[key] = !CFG[key]; paint(); saveCfg(); }); row.appendChild(sw); container.appendChild(row); return row;
        };
        const select = (key, label, desc, opts, onchange) => {
          const row = mkRow(); row.appendChild(mkLabel(label, desc));
          const sel = D2.createElement('select'); sel.setAttribute('aria-label', label);
          sel.style.cssText = 'background:rgba(255,255,255,.08);border:0;border-radius:8px;color:#fff;font:inherit;font-size:11.5px;padding:5px 8px;cursor:pointer;max-width:165px';
          for (const [v, t] of opts) { const o = D2.createElement('option'); o.value = v; o.textContent = t; o.style.color = '#111'; if (CFG[key] === v) o.selected = true; sel.appendChild(o); }
          sel.addEventListener('change', () => { CFG[key] = sel.value; saveCfg(); if (onchange) onchange(); }); row.appendChild(sel); container.appendChild(row); return row;
        };
        const number = (key, label, desc, min, max) => {
          const row = mkRow(); row.appendChild(mkLabel(label, desc));
          const inp = D2.createElement('input'); inp.type = 'number'; inp.min = min; inp.max = max; inp.value = CFG[key];
          inp.style.cssText = 'width:66px;flex:none;background:rgba(255,255,255,.08);border:0;border-radius:8px;color:#fff;font:inherit;font-size:11.5px;padding:5px 8px;text-align:right;outline:none';
          inp.addEventListener('keydown', (e) => e.stopPropagation());
          inp.addEventListener('change', () => { let v = parseInt(inp.value, 10); if (isNaN(v)) v = min; v = Math.max(min, Math.min(max, v)); CFG[key] = v; inp.value = v; saveCfg(); });
          row.appendChild(inp); container.appendChild(row); return row;
        };
        const btnRow = (label, desc, buttons) => {
          const row = mkRow(); const lab = mkLabel(label, desc); row.appendChild(lab);
          const grp = D2.createElement('div'); grp.style.cssText = 'display:flex;gap:5px;flex:none';
          for (const [t, fn] of buttons) { const b = D2.createElement('button'); b.type = 'button'; b.textContent = t; b.style.cssText = 'background:rgba(255,255,255,.1);border:0;border-radius:7px;color:#eaeaee;font:600 10.5px inherit;padding:5px 9px;cursor:pointer'; b.addEventListener('click', () => { try { fn(lab, b); } catch (e) {} }); grp.appendChild(b); }
          row.appendChild(grp); container.appendChild(row); return row;
        };

        subHead('Playback');
        toggle('spreadArtists', 'Spread artists', 'No artist twice in a row');
        toggle('noRepeat', 'Fresh picks', 'Skip tracks you’ve already heard');
        toggle('autoSkipStuck', 'Auto-skip broken', 'Skip tracks that refuse to start');
        toggle('smartSuggest', 'Smart nudges', 'Offer a reshuffle after rapid skips');
        select('orderMode', 'Order', '', [['random', 'Surprise me'], ['rediscover', 'Rediscover older likes']]);

        subHead('Include');
        let fmRow = null;
        const updMin = () => { if (fmRow) fmRow.style.display = CFG.filterMode === 'all' ? 'none' : ''; };
        select('filterMode', 'Tracks', '', [['all', 'Everything'], ['songs', 'Songs only (skip long)'], ['mixes', 'Mixes only (skip short)']], updMin);
        fmRow = number('filterMinutes', 'Long = over', 'minutes', 1, 600); updMin();
        toggle('skipUnplayable', 'Skip unplayable', 'Region-blocked or removed tracks');
        number('sampleCap', 'Queue size cap', '0 = your whole library', 0, 100000);
        number('likedDays', 'Liked within', 'days · 0 = any time', 0, 3650);
        btnRow('Genres', (CFG.genreFilter && CFG.genreFilter.length ? CFG.genreFilter.length + ' selected' : 'All genres'), [['Pick', (lab, b) => { try { openGenrePicker(b, () => { const sm = lab.querySelector('small'); if (sm) sm.textContent = CFG.genreFilter.length ? CFG.genreFilter.length + ' selected' : 'All genres'; }); } catch (e) {} }]]);

        subHead('Setup');
        toggle('silentSetup', 'Silent setup', 'Mute & hide the queue while loading');
        toggle('earlyStart', 'Instant playback', 'Start on the first page, the rest loads behind');

        subHead('Stats & data');
        number('playThresholdSec', 'Counts as played after', 'seconds', 5, 300);
        number('cacheHours', 'Keep library cached', 'hours · 0 = always refetch', 0, 168);
        const bkText = () => { try { const bk = loadBlock(); const t = bk.tracks.length + bk.urls.length, a = bk.artists.length; return t + ' track' + (t === 1 ? '' : 's') + ' · ' + a + ' artist' + (a === 1 ? '' : 's'); } catch (e) { return ''; } };
        btnRow('Blocklist', bkText(), [
          ['Block track', (lab) => { try { blockCurrentTrack(false); } catch (e) {} const sm = lab.querySelector('small'); if (sm) sm.textContent = bkText(); }],
          ['Artist', (lab) => {
            try {
              const info = currentTrackInfo();
              if (!info) { showToast('Play a track first'); return; }
              if (info.artistId == null) { showToast('Can’t identify this artist yet — run a shuffle first'); return; }
              const bk = loadBlock(); if (!bk.artists.includes(info.artistId)) bk.artists.push(info.artistId); saveBlock(bk);
              if (S.poolList) { S.poolList = S.poolList.filter((x) => x.ai !== info.artistId || x.u === info.url); S.poolIdx = new Map(S.poolList.map((x, i) => [x.u, i])); }
              showToast('Artist blocked' + (info.artist ? ' — ' + info.artist : ''), 'None of their tracks will be shuffled');
            } catch (e) {}
            const sm = lab.querySelector('small'); if (sm) sm.textContent = bkText();
          }],
          ['Clear', (lab) => { try { saveBlock({ tracks: [], urls: [], artists: [] }); showToast('Blocklist cleared'); } catch (e) {} const sm = lab.querySelector('small'); if (sm) sm.textContent = bkText(); }],
        ]);
        btnRow('Heard history', 'Reset the fresh-picks memory', [['Reset', () => { try { clearHistory(); showToast('Heard history cleared — everything is a fresh pick again'); } catch (e) {} }]]);
        btnRow('Cached library', 'Forget the on-disk cache', [['Forget', () => {
          try { S.sessionLib = null; S.sessionLibAt = 0; S.sessionLibKey = ''; idbClearLib(); LS.del('bh_sc_lib'); invalidateLibMap(); showToast('Cache cleared — the next shuffle refetches everything'); } catch (e) {}
        }]]);
        btnRow('ListenBrainz', (lbToken() ? 'Scrobbling plays' : 'Off — add a token to scrobble'), [['Token', (lab) => {
          let t = null; try { t = prompt('ListenBrainz user token (listenbrainz.org → Settings). Leave empty to turn scrobbling off. It is kept in this browser’s site data for soundcloud.com.', lbToken() || ''); } catch (e) {}
          if (t === null) return; t = t.replace(/^\s*token\s+/i, ''); try { GM_setValue('bh:lbtok', t.trim()); } catch (e) {}
          const sm = lab.querySelector('small'); if (sm) sm.textContent = t.trim() ? 'Scrobbling plays' : 'Off — add a token to scrobble';
          showToast(t.trim() ? 'ListenBrainz on — plays will scrobble' : 'ListenBrainz off'); if (t.trim()) { try { lbFlush(); } catch (e) {} }
        }]]);
      } catch (e) {}
    }

    function openStats(anchor) {
        showCard(anchor, c => {
            head(c, 'bars', 'Listening stats');
            const b = el('div', 'bhx-body');
            c.appendChild(b);
            const cell = (big, small) => {
                const d = el('div', 'bhx-cell');
                const bg = el('div', 'bhx-big'); bg.textContent = big;
                const sm = el('div', 'bhx-small'); sm.textContent = small;
                d.appendChild(bg); d.appendChild(sm);
                return d;
            };

            // ── Now playing hero ──
            const info = currentTrackInfo();
            if (info) {
                const pcEl = q('playControl');
                const live = pcEl && pcEl.classList.contains('playing');
                const nowRow = el('div', 'bhx-now');
                nowRow.appendChild(el('span', 'bhx-eq' + (live ? '' : ' paused'), '<span></span><span></span><span></span>'));
                const meta = el('div', 'bhx-nowmeta');
                const t1 = el('div', 'bhx-nowtitle'); t1.textContent = info.title;
                meta.appendChild(t1);
                if (info.artist) { const t2 = el('div', 'bhx-sub'); t2.textContent = info.artist; meta.appendChild(t2); }
                nowRow.appendChild(meta);
                const ng = el('div', 'bhx-btnrow');
                const nb = el('button', 'bhx-btn sm', 'Block');
                nb.type = 'button';
                nb.title = 'Never shuffle this track again (Alt+B)';
                nb.addEventListener('click', () => blockCurrentTrack(true));
                ng.appendChild(nb);
                nowRow.appendChild(ng);
                b.appendChild(nowRow);
            }

            b.appendChild(el('div', 'bhx-sec', 'This session'));
            const g1 = el('div', 'bhx-grid');
            g1.appendChild(cell(fmtTime(sess.listenMs), 'listened'));
            g1.appendChild(cell(String(sess.played), 'played'));
            g1.appendChild(cell(String(sess.skipped), 'skipped'));
            b.appendChild(g1);

            // ── Last 7 days sparkline + streak ──
            {
                const days = [];
                for (let i = 6; i >= 0; i--) {
                    const k = localDayKey(i);
                    days.push({ k, ms: daily[k] || 0, d: new Date(Date.now() - i * 86400000) });
                }
                const weekMs = days.reduce((s, x) => s + x.ms, 0);
                if (weekMs > 0) {
                    b.appendChild(el('div', 'bhx-sec', 'Last 7 days'));
                    const max = Math.max(...days.map(x => x.ms), 1);
                    const spark = el('div', 'bhx-spark');
                    const labels = el('div', 'bhx-spark-l');
                    days.forEach((x, i2) => {
                        const bar = el('b', i2 === 6 ? 'today' : '');
                        bar.style.height = Math.max(7, Math.round(x.ms / max * 100)) + '%';
                        bar.title = x.d.toLocaleDateString(undefined, { weekday: 'short' }) + ' · ' + fmtTime(x.ms);
                        spark.appendChild(bar);
                        labels.appendChild(el('span', '', 'SMTWTFS'[x.d.getDay()]));
                    });
                    b.appendChild(spark);
                    b.appendChild(labels);
                    let streak = 0;
                    for (let i2 = 0; i2 < 30; i2++) {
                        if ((daily[localDayKey(i2)] || 0) >= 5 * 60000) streak++;
                        else if (i2 === 0) continue;
                        else break;
                    }
                    const wl = el('div', 'bhx-small');
                    wl.textContent = fmtTime(weekMs) + ' this week' + (streak >= 2 ? ' · 🔥 ' + streak + '-day streak' : '');
                    b.appendChild(wl);
                }
            }

            b.appendChild(el('div', 'bhx-sec', 'All time'));
            const g2 = el('div', 'bhx-grid');
            g2.appendChild(cell(fmtTime(allTime.listenMs), 'listened'));
            g2.appendChild(cell(allTime.played.toLocaleString(), 'played'));
            b.appendChild(g2);

            if (sleepAt || sleepArmed) {
                const sr = el('div', 'bhx-row');
                const rem = sleepRemainingMs();
                sr.appendChild(el('div', 'bhx-lab', 'Sleep timer<span class="bhx-sub">' +
                    (sleepArmed ? 'Pausing after this track' : Math.max(1, Math.ceil(rem / 60000)) + 'm left') + '</span>'));
                const og = el('div', 'bhx-btnrow');
                const off = el('button', 'bhx-btn sm', 'Off');
                off.type = 'button';
                off.addEventListener('click', () => { clearSleep(); sr.remove(); showToast('Sleep timer off'); });
                og.appendChild(off);
                sr.appendChild(og);
                b.appendChild(sr);
            }

            const lm0 = getLibMap();
            const cache = lm0 ? { items: lm0.__items } : null;
            if (cache && cache.items && cache.items.length) {
                b.appendChild(el('div', 'bhx-sec', 'Library'));
                const total = cache.items.length;
                const heard = loadHistory();
                const ids = new Set(heard.ids);
                let heardCount = 0;
                for (const it of cache.items) if (ids.has(it[0])) heardCount++;
                const pct = Math.min(100, Math.round(heardCount / total * 100));
                const lr = el('div', 'bhx-row');
                lr.appendChild(el('div', 'bhx-lab', total.toLocaleString() + ' liked tracks<span class="bhx-sub">' +
                    heardCount.toLocaleString() + ' heard · ' + pct + '%</span>'));
                b.appendChild(lr);
                const prog = el('div', 'bhx-prog', '<i></i>');
                prog.firstChild.style.width = pct + '%';
                b.appendChild(prog);
                const lp = LS.get('bh_sc_lastpool', null);
                if (lp && lp.n) b.appendChild(el('div', 'bhx-small', 'Last shuffle: ' + lp.n.toLocaleString() + ' tracks · ' + fmtH(lp.ms || 0)));
            }

            // ── Up next (this shuffle's order) ──
            if (S.poolList && S.poolList.length) {
                b.appendChild(el('div', 'bhx-sec', 'Up next'));
                const idx = info ? S.poolList.findIndex(x => x.u === info.url) : -1;
                const next = idx >= 0 ? S.poolList.slice(idx + 1, idx + 4) : [];
                if (next.length) {
                    next.forEach(x => {
                        const r = el('div', 'bhx-row');
                        const l = el('div', 'bhx-lab');
                        l.textContent = x.t || x.u;
                        if (x.a) { const s2 = el('span', 'bhx-sub'); s2.textContent = x.a; l.appendChild(s2); }
                        r.appendChild(l);
                        b.appendChild(r);
                    });
                } else {
                    const r = el('div', 'bhx-row');
                    r.appendChild(el('div', 'bhx-lab', '<span class="bhx-sub">Play from the shuffled queue to see what’s next.</span>'));
                    b.appendChild(r);
                }
                const cqRow = el('div', 'bhx-btnrow');
                cqRow.style.marginTop = '7px';
                const cq = el('button', 'bhx-btn sm', 'Copy queue');
                cq.type = 'button';
                cq.title = 'Copy the full shuffled list to your clipboard';
                cq.addEventListener('click', () => {
                    const txt = S.poolList.map((x, i2) => (i2 + 1) + '. ' + (x.t || x.u) + (x.a ? ' — ' + x.a : '') + '\n' + x.u).join('\n');
                    try {
                        navigator.clipboard.writeText(txt).then(
                            () => showToast('Queue copied', S.poolList.length.toLocaleString() + ' tracks on your clipboard'),
                            () => showToast('Couldn’t copy — clipboard blocked'));
                    } catch (e) { showToast('Couldn’t copy — clipboard blocked'); }
                });
                cqRow.appendChild(cq);
                b.appendChild(cqRow);
            }

            // ── Recently played (from the history the watcher already keeps) ──
            {
                const h = loadHistory();
                if (h.urls.length > 1) {
                    b.appendChild(el('div', 'bhx-sec', 'Recently played'));
                    const lm = getLibMap();
                    const tsOff = h.urls.length - h.ts.length;   // legacy entries lack timestamps
                    let shown = 0;
                    for (let i = h.urls.length - 1; i >= 0 && shown < 8; i--) {
                        const u = h.urls[i];
                        if (shown === 0 && info && u === info.url) continue;   // the hero already shows it
                        const hit = lm && lm.get(u);
                        const r = el('div', 'bhx-row');
                        const l = el('div', 'bhx-lab');
                        l.textContent = (hit && hit[5]) || (u.split('/').filter(Boolean).pop() || u).replace(/-/g, ' ').slice(0, 40);
                        if (hit && hit[4]) { const s2 = el('span', 'bhx-sub'); s2.textContent = hit[4]; l.appendChild(s2); }
                        r.appendChild(l);
                        const tsv = i - tsOff >= 0 ? h.ts[i - tsOff] : 0;
                        if (tsv) { const v = el('div', 'bhx-small'); v.textContent = ago(tsv); r.appendChild(v); }
                        b.appendChild(r);
                        shown++;
                    }
                }
            }

            const pm = LS.get(PLAYS_KEY, {});
            const entries = Object.entries(pm);
            if (entries.length) {
                const tMap = {}, aMap = {};
                if (cache && cache.items) cache.items.forEach(it => { if (it[5]) tMap[it[1]] = it[5]; if (it[4]) aMap[it[1]] = it[4]; });
                const slug = u => {
                    const s = (u.split('/').filter(Boolean).pop() || u).replace(/-/g, ' ');
                    return s.length > 34 ? s.slice(0, 33) + '…' : s;
                };
                const rowFor = (u, txt) => {
                    const r = el('div', 'bhx-row');
                    const l = el('div', 'bhx-lab');
                    l.textContent = tMap[u] || slug(u);
                    if (aMap[u]) { const s2 = el('span', 'bhx-sub'); s2.textContent = aMap[u]; l.appendChild(s2); }
                    r.appendChild(l);
                    const v = el('div', 'bhx-small');
                    v.textContent = txt;
                    r.appendChild(v);
                    return r;
                };
                // Top artists, by your actual plays
                const ac = {};
                entries.forEach(([u, v]) => { const nm = aMap[u]; if (nm && v[0] > 0) ac[nm] = (ac[nm] || 0) + v[0]; });
                const topA = Object.entries(ac).filter(e => e[1] >= 2).sort((x, y) => y[1] - x[1]).slice(0, 3);
                if (topA.length) {
                    b.appendChild(el('div', 'bhx-sec', 'Top artists'));
                    topA.forEach(([nm, n2]) => {
                        const r = el('div', 'bhx-row');
                        const l = el('div', 'bhx-lab'); l.textContent = nm;
                        r.appendChild(l);
                        const v = el('div', 'bhx-small'); v.textContent = n2 + ' plays';
                        r.appendChild(v);
                        b.appendChild(r);
                    });
                }
                const top = entries.filter(e => e[1][0] >= 2).sort((a2, b2) => b2[1][0] - a2[1][0]).slice(0, 3);
                if (top.length) {
                    b.appendChild(el('div', 'bhx-sec', 'On repeat'));
                    top.forEach(([u, v]) => b.appendChild(rowFor(u, v[0] + '×')));
                }
                const skips = entries.filter(e => e[1][1] >= 3).sort((a2, b2) => b2[1][1] - a2[1][1]).slice(0, 3);
                if (skips.length) {
                    b.appendChild(el('div', 'bhx-sec', 'Often skipped'));
                    skips.forEach(([u, v]) => b.appendChild(rowFor(u, v[1] + '× skipped')));
                }
            }

            // ── Broken likes (region-blocked / removed / won't start) ──
            {
                const broken = LS.get(BROKEN_KEY, []);
                if (broken.length) {
                    b.appendChild(el('div', 'bhx-sec', 'Broken likes (' + broken.length + ')'));
                    broken.slice(-5).reverse().forEach(x => {
                        const r = el('div', 'bhx-row');
                        const l = el('div', 'bhx-lab');
                        l.textContent = x.t || (x.u.split('/').filter(Boolean).pop() || '').replace(/-/g, ' ').slice(0, 40);
                        const s2 = el('span', 'bhx-sub');
                        s2.textContent = (x.a ? x.a + ' · ' : '') + (x.p || 'unplayable');
                        l.appendChild(s2);
                        r.appendChild(l);
                        b.appendChild(r);
                    });
                    const bg = el('div', 'bhx-btnrow');
                    bg.style.marginTop = '7px';
                    const cp = el('button', 'bhx-btn sm', 'Copy list');
                    cp.type = 'button';
                    cp.title = 'Copy all broken likes so you can go un-like them';
                    cp.addEventListener('click', () => {
                        const txt = broken.map(x => (x.t || '?') + (x.a ? ' — ' + x.a : '') + ' [' + (x.p || 'unplayable') + ']\n' + x.u).join('\n');
                        try {
                            navigator.clipboard.writeText(txt).then(
                                () => showToast('Copied', broken.length + ' broken likes on your clipboard'),
                                () => showToast('Couldn’t copy — clipboard blocked'));
                        } catch (e) { showToast('Couldn’t copy — clipboard blocked'); }
                    });
                    bg.appendChild(cp);
                    const cl = el('button', 'bhx-btn sm', 'Clear');
                    cl.type = 'button';
                    cl.addEventListener('click', () => { LS.del(BROKEN_KEY); showToast('Broken-likes list cleared'); closeCard(); });
                    bg.appendChild(cl);
                    b.appendChild(bg);
                }
            }

            const foot = el('div', 'bhx-foot');
            const rb = el('button', 'bhx-btn', 'Reset session');
            rb.type = 'button';
            rb.addEventListener('click', () => {
                sess.listenMs = 0; sess.played = 0; sess.skipped = 0; sess.start = Date.now();
                SS.set('bh_sc_sess', sess);
                closeCard();
            });
            foot.appendChild(rb);
            const ch = el('button', 'bhx-btn', 'Copy history');
            ch.type = 'button';
            ch.title = 'Copy your play history (with timestamps) to the clipboard';
            ch.addEventListener('click', () => {
                const h = loadHistory();
                if (!h.urls.length) { showToast('No history yet'); return; }
                const lm = getLibMap();
                const tsOff = h.urls.length - h.ts.length;
                const lines = h.urls.map((u, i) => {
                    const hit = lm && lm.get(u);
                    const tsv = i - tsOff >= 0 ? h.ts[i - tsOff] : 0;
                    return (tsv ? new Date(tsv).toISOString().slice(0, 16).replace('T', ' ') + '  ' : '')
                        + (hit && hit[5] ? hit[5] + (hit[4] ? ' — ' + hit[4] : '') + '  ' : '') + u;
                });
                try {
                    navigator.clipboard.writeText(lines.join('\n')).then(
                        () => showToast('History copied', lines.length.toLocaleString() + ' plays on your clipboard'),
                        () => showToast('Couldn’t copy — clipboard blocked'));
                } catch (e) { showToast('Couldn’t copy — clipboard blocked'); }
            });
            foot.appendChild(ch);
            b.appendChild(foot);
            b.appendChild(el('div', 'bhx-hint', 'Played = ' + CFG.playThresholdSec + 's+ · stored locally'));
        });
    }

    /* ───────────────────────── PLAYER-BAR BUTTONS ───────────────────────── */
    function barShuffleClick() {
        if (S.active) {
            if (Date.now() - S.startedAt < 800) return;   // same double-fire guard as run()
            cancel('Shuffle Play');
            return;
        }
        const onLikes = /^\/you\/likes\/?$/.test(location.pathname);
        const btn = document.querySelector('.bhx-shufbtn');
        // the button can still be the previous page's (SPA nav re-renders it
        // ~400 ms later) — only run it when it really belongs to /you/likes
        if (onLikes && btn && btn.dataset.pageType === 'Likes') { run(btn); return; }
        SS.set('bh_sc_autorun', 1);
        if (!onLikes) {
            // SPA-navigate via a real link so SoundCloud's router handles it;
            // if the router doesn't catch it, a normal navigation still works
            // because the autorun flag lives in sessionStorage.
            const a = document.createElement('a');
            a.href = '/you/likes';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
        maybeAutoRun();
    }
    let autoRunWaiting = false;
    async function maybeAutoRun() {
        if (autoRunWaiting || !SS.get('bh_sc_autorun', 0)) return;
        autoRunWaiting = true;
        // the button mounts on the page header before the Likes list has any
        // rows — wait for both, or runOnce answers 'Too few tracks' straight away
        let btn = await waitFor(() => {
            const bEl = document.querySelector('.bhx-shufbtn');
            if (!bEl || bEl.dataset.pageType !== 'Likes') return null;
            const l = q('likesList');
            return l && l.childElementCount >= 3 ? bEl : null;
        }, T.autorunWait, 200);
        if (!btn) {
            // a list that never fills (signed out, no likes) still gets the 'Too few tracks' feedback
            const bEl = document.querySelector('.bhx-shufbtn');
            if (bEl && bEl.dataset.pageType === 'Likes') btn = bEl;
        }
        autoRunWaiting = false;
        if (!SS.get('bh_sc_autorun', 0)) return;
        SS.del('bh_sc_autorun');
        if (!btn) { showToast('Couldn’t find your Likes to shuffle', 'Sign in and open /you/likes, then press Shuffle Play'); return; }
        if (!S.active) run(btn);
    }
    function ensureBarButtons() {
        const host = q('barHost');
        if (!host) return;
        const existing = host.querySelector('.bhx-barwrap');
        // the all-in-one enhancer pill already carries a Shuffle button, so the
        // old bolt here is a duplicate — drop it whenever that pill is present
        if (document.querySelector('.sce-barwrap')) { if (existing) existing.remove(); return; }
        if (existing) return;
        injectStyle(); applyTheme();
        const wrap = el('span', 'bhx-barwrap');
        const sb = el('button', 'bhx-barbtn bhx-shuf', ICONS.zap(13));
        sb.type = 'button';
        sb.title = 'Shuffle your Likes (Alt+S)';
        sb.setAttribute('aria-label', 'Shuffle your Likes (Alt+S)');
        sb.addEventListener('click', barShuffleClick);
        wrap.appendChild(sb);
        host.appendChild(wrap);
    }

    /* ───────────────────── SHUFFLE PLAY BUTTON (per page) ───────────────────── */
    const PAGES = [
        { type: 'Likes',        test: () => /^\/you\/likes\/?$/.test(location.pathname),                                   mount: () => q('collectionTop') },
        { type: 'GenericLikes', test: () => /^\/[^/]+\/likes\/?$/.test(location.pathname) && !/^\/you\//.test(location.pathname), mount: () => q('userTabs') },
        { type: 'Discover',     test: () => /^\/discover\/sets\//.test(location.pathname),                                 mount: () => q('discoverControls') },
        { type: 'Playlist',     test: () => !!q('playlistList'),                                                           mount: () => q('soundActions') },
    ];
    function ensureButton() {
        ensureBarButtons();
        maybeAutoRun();
        let page = null;
        for (const p of PAGES) { if (p.test()) { page = p; break; } }
        let btnEl = document.querySelector('.bhx-shufbtn');
        if (btnEl && (!page || btnEl.dataset.pageType !== page.type)) {
            const w = btnEl.closest('.bhx-mountwrap');
            if (w) w.remove(); else btnEl.remove();
            btnEl = null;
        }
        if (!page) return;
        if (btnEl) {
            if (S.active && S.btn !== btnEl) S.btn = btnEl;  // SPA re-render replaced the node mid-run
            return;
        }
        const host = page.mount();
        if (!host) return;
        injectStyle(); applyTheme();
        const wrap = el('span', 'bhx-mountwrap');
        wrap.style.cssText = 'display:inline-flex;align-items:center;gap:2px;margin-left:10px;vertical-align:middle';
        btnEl = el('button', 'sc-button sc-button-medium sc-button-responsive bhx-shufbtn', 'Shuffle Play');
        btnEl.type = 'button';
        btnEl.dataset.pageType = page.type;
        btnEl.title = page.type === 'Playlist' ? 'Shuffle this playlist' :
                      page.type === 'Discover' ? 'Shuffle this mix' : 'Shuffle these likes';
        btnEl.addEventListener('click', () => run(btnEl));
        const gear = el('button', 'bhx-gear', ICONS.sliders(13));
        gear.type = 'button';
        gear.title = 'Shuffle settings';
        gear.setAttribute('aria-label', 'Shuffle settings');
        // opens the all-in-one hub (Tweaks tab → Shuffle section) when present,
        // else the standalone card as a fallback
        gear.addEventListener('click', () => { if (SUITE.openLyricsTweaks) { try { SUITE.openLyricsTweaks(); return; } catch (e) {} } (card && card.__anchor === gear) ? closeCard() : openSettings(gear); });
        wrap.appendChild(btnEl);
        wrap.appendChild(gear);
        host.appendChild(wrap);
        if (S.active) S.btn = btnEl;
    }

    /* ───────────────────── NAVIGATION (SPA) + HOTKEY + BOOT ───────────────────── */
    let lastPath = location.pathname;
    function onNav() {
        const p = location.pathname;
        if (p !== lastPath) {
            lastPath = p;
            S.tpl = null;   // templates are page-local: never replay another page's likes endpoint
            if (S.active) cancel('Shuffle Play');
            closeCard();
        }
        setTimeout(ensureButton, 400);
        setTimeout(ensureButton, 1500);
    }
    try {
        const origPush = PW.history.pushState, origReplace = PW.history.replaceState;
        PW.history.pushState = function (...a) { const r = origPush.apply(this, a); try { onNav(); } catch (e) {} return r; };
        PW.history.replaceState = function (...a) { const r = origReplace.apply(this, a); try { onNav(); } catch (e) {} return r; };
        PW.addEventListener('popstate', onNav);
    } catch (e) { swallow(e, 'history patch'); }

    window.addEventListener('keydown', e => {
        if (!e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;   // key auto-repeat must not start/cancel/start…
        // e.code, not e.key: on macOS Option+S types 'ß' and Option+B types '∫',
        // which silently killed both hotkeys for Mac users
        if (e.code !== 'KeyS' && e.code !== 'KeyB') return;
        // composedPath: inputs inside the lyrics panel's shadow root retarget
        // e.target to the host — check the real target too
        const t = (e.composedPath ? e.composedPath()[0] : null) || e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        if (e.code === 'KeyS') barShuffleClick();
        else blockCurrentTrack(true);   // Alt+B: never again + skip ahead
    });

    /* ── Suite bus: what the lyrics module is allowed to know ── */
    SUITE.shuffleBusy = () => S.active;
    SUITE.cardOpen = () => !!card;
    SUITE.clientId = () => S.clientId || null;
    SUITE.debug = () => !!CFG.debug;
    SUITE.nextUp = (url) => {
        try {
            if (!S.poolList || !url) return null;
            const i = S.poolIdx && S.poolIdx.has(url) ? S.poolIdx.get(url) : -1;
            return (i >= 0 && S.poolList[i + 1]) ? S.poolList[i + 1] : null;
        } catch (e) { return null; }
    };
    SUITE.libByUrl = (url) => {
        try {
            const m = getLibMap();
            const hit = m && m.get(url);
            return hit ? { id: hit[0], url: hit[1], durMs: hit[2] || 0, artistId: hit[3], artist: hit[4] || '', title: hit[5] || '' } : null;
        } catch (e) { return null; }
    };
    SUITE.shuffleNow = () => { try { if (S.active) return 'Shuffle is still loading — give it a moment'; barShuffleClick(); return ''; } catch (e) { return 'Couldn’t start the shuffle'; } };
    SUITE.shuffleRender = (c) => { try { shuffleRender(c); } catch (e) {} };   // inline shuffle settings for the hub
    // shuffle settings now live in the all-in-one hub (Tweaks tab); fall back to
    // the standalone card only if the lyrics module isn't present
    SUITE.openShuffleSettings = (a) => { try { if (SUITE.openLyricsTweaks) SUITE.openLyricsTweaks(); else openSettings(a); } catch (e) { try { openSettings(a); } catch (e2) {} } };
    SUITE.backupAll = () => { try { exportData(); } catch (e) {} };          // whole-suite export
    SUITE.restoreAll = (file) => { try { importData(file); } catch (e) {} };  // whole-suite import
    SUITE.openShuffleStats = (a) => { try { openStats(a); } catch (e) {} };
    // v2 hub bridges: the lyrics panel hosts Queue and Stats tabs now
    SUITE.queueList = () => (S.poolList && S.poolList.length ? S.poolList : null);
    SUITE.statsSnapshot = () => {
        try {
            let streak = 0;
            for (let i = 0; i < 30; i++) {
                if ((daily[localDayKey(i)] || 0) >= 5 * 60000) streak++;
                else if (i === 0) continue;
                else break;
            }
            return {
                sessMs: sess.listenMs, played: sess.played, skipped: sess.skipped,
                todayMs: daily[localDayKey(0)] || 0,
                allMs: allTime.listenMs, allPlayed: allTime.played,
                streak, queueN: S.poolList ? S.poolList.length : 0,
                heardN: loadHistory().urls.length,
                libN: (getLibMap() || { size: 0 }).size,
            };
        } catch (e) { return null; }
    };
    /* v2.3: the panel's Stats tab absorbed the old player-bar stats card —
     * these bridges hand it the detail data (sparkline, tops, history). */
    SUITE.statsExtra = () => {
        try {
            const lm = getLibMap();
            const days = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date(Date.now() - i * 86400000);
                days.push({ ms: daily[localDayKey(i)] || 0, w: 'SMTWTFS'[d.getDay()], today: i === 0 });
            }
            const pm = LS.get(PLAYS_KEY, {});
            const entries = Object.entries(pm);
            const tMap = {}, aMap = {};
            if (lm && lm.__items) lm.__items.forEach(it => { if (it[5]) tMap[it[1]] = it[5]; if (it[4]) aMap[it[1]] = it[4]; });
            const name = u => tMap[u] || (u.split('/').filter(Boolean).pop() || u).replace(/-/g, ' ').slice(0, 40);
            const ac = {};
            entries.forEach(([u, v]) => { const nm = aMap[u]; if (nm && v[0] > 0) ac[nm] = (ac[nm] || 0) + v[0]; });
            const topArtists = Object.entries(ac).filter(e => e[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, p]) => ({ n, p }));
            const onRepeat = entries.filter(e => e[1][0] >= 2).sort((a, b) => b[1][0] - a[1][0]).slice(0, 5)
                .map(([u, v]) => ({ t: name(u), a: aMap[u] || '', n: v[0] }));
            const skipped = entries.filter(e => e[1][1] >= 3).sort((a, b) => b[1][1] - a[1][1]).slice(0, 5)
                .map(([u, v]) => ({ t: name(u), a: aMap[u] || '', n: v[1] }));
            const h = loadHistory();
            const tsOff = h.urls.length - h.ts.length;
            const recent = [];
            for (let i = h.urls.length - 1; i >= 0 && recent.length < 6; i--) {
                const u = h.urls[i];
                const tsv = i - tsOff >= 0 ? h.ts[i - tsOff] : 0;
                recent.push({ t: name(u), a: aMap[u] || '', when: tsv ? ago(tsv) : '' });
            }
            return {
                days, topArtists, onRepeat, skipped, recent,
                brokenN: LS.get(BROKEN_KEY, []).length,
                hours: Array.from({ length: 24 }, (_, i) => hourly[i] || 0),
            };
        } catch (e) { return null; }
    };
    /* one tap: shuffle only the playing track's genre. Returns a message
     * for the caller's toast — empty string means "shuffle started". */
    SUITE.moreLikeThis = () => {
        try {
            const info = currentTrackInfo();
            if (!info) return 'Play a track first';
            let g = '';
            if (S.sessionLib) {
                const hit = S.sessionLib.find(it => (it.track.permalink_url || '').split('?')[0] === info.url);
                g = (hit && hit.track && hit.track.genre ? String(hit.track.genre) : '').trim();
            }
            if (!g) return 'No genre tag here — run one shuffle first so the library is in memory';
            if (S.active) return 'Shuffle is still loading — try again in a moment';
            CFG.genreFilter = [g];
            saveCfg();
            barShuffleClick();
            return 'Shuffling only “' + g + '” — clear the genre filter in shuffle settings when done';
        } catch (e) { return 'Couldn’t read this track’s genre'; }
    };
    SUITE.resetSession = () => {
        try { sess.listenMs = 0; sess.played = 0; sess.skipped = 0; sess.start = Date.now(); SS.set('bh_sc_sess', sess); } catch (e) {}
    };
    SUITE.historyText = () => {
        try {
            const h = loadHistory();
            if (!h.urls.length) return '';
            const lm = getLibMap();
            const tsOff = h.urls.length - h.ts.length;
            return h.urls.map((u, i) => {
                const hit = lm && lm.get(u);
                const tsv = i - tsOff >= 0 ? h.ts[i - tsOff] : 0;
                return (tsv ? new Date(tsv).toISOString().slice(0, 16).replace('T', ' ') + '  ' : '')
                    + (hit && hit[5] ? hit[5] + (hit[4] ? ' — ' + hit[4] : '') + '  ' : '') + u;
            }).join('\n');
        } catch (e) { return ''; }
    };
    SUITE.brokenText = () => {
        try {
            const broken = LS.get(BROKEN_KEY, []);
            if (!broken.length) return '';
            return broken.map(x => (x.t || '?') + (x.a ? ' — ' + x.a : '') + ' [' + (x.p || 'unplayable') + ']\n' + x.u).join('\n');
        } catch (e) { return ''; }
    };
    SUITE.sleep = {
        set(min) { try { sleepArmed = false; sleepAt = Date.now() + min * 60000; SS.set('bh_sc_sleep', sleepAt); } catch (e) {} },
        clear() { try { clearSleep(); } catch (e) {} },
        remainingMs() { try { return sleepRemainingMs(); } catch (e) { return 0; } },
        armed() { try { return sleepArmed; } catch (e) { return false; } },
        fading() { try { return fading; } catch (e) { return false; } },   // the enhancer's volume memory pauses during the fade
    };

    function boot() {
        injectStyle();
        applyTheme();
        ensureButton();
        setInterval(ensureButton, 3000);  // survives SPA re-renders; not time-critical
        startWatcher();
        try { ApiHealth.armColdCheck(); } catch (e) {}   // R23: one-shot 30s degradation check
        if (SHOW_UPDATE_NOTE) setTimeout(() =>
            showToast('Shuffle updated to v8 — auto-skip for dead tracks, sleep timer, blocklist, queue size cap, backups & more behind the gear next to Shuffle Play'), 1800);
        setTimeout(lbFlush, 6000);   // retry any scrobbles queued while offline
        if (CFG.debug) {
            selfTest();
            try { window.__scShuffle = { version: '8.0', selfTest, S, F, CFG }; } catch (e) {}
        }
        log('booted v8.0');
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    // bfcache restore: the page can be navigated-away-and-back without a full
    // load (event.persisted = true). Re-mount the toolbar button + re-arm the
    // sniffer watchdog so the suite isn't a ghost UI after history navigation.
    window.addEventListener('pageshow', (e) => {
        if (!e.persisted) return;
        try { ensureButton(); } catch (x) {}
        try { ApiHealth.armColdCheck(); } catch (x) {}
    });
})();

/* ═══════════════════ MODULE 2 · LYRICS (SuperLyrics v4.6) ═══════════════════ */

/*
 *  SuperLyrics 4.0 — small, fast, accurate, VPN-proof.
 *
 *  Sources (all raced in parallel)
 *  • LRCLIB        synced lyrics, open API
 *  • Musixmatch    synced + text, huge catalog (token fetched & cached automatically)
 *  • Kugou         synced lyrics, huge catalog, keyless and VPN-friendly
 *  • Genius        text lyrics, best catalog for unreleased/leaks
 *  • lyrics.ovh    plain-text last resort
 *  plus iTunes canonicalization and SoundCloud's own hidden track metadata.
 *
 *  The VPN story
 *  Genius sits behind Cloudflare, which dislikes VPN IPs (Mullvad etc).
 *  Search: Genius' API plus a real web search (DuckDuckGo → Bing → Mojeek)
 *  that finds pages the way a browser does, spelling variants included.
 *  Pages: direct first, then mirrors (Wayback Machine, codetabs,
 *  allorigins) that fetch genius.com from other servers, so Cloudflare
 *  never sees this device. A global request gate (max 10 in flight) and
 *  staggered search waves keep slow VPN tunnels from queueing up, and the
 *  resolver waits up to ~30s while anything useful is still in flight —
 *  results landing even later are delivered live instead of dropped.
 *
 *  Sync
 *  True synced lyrics (LRCLIB / Musixmatch / NetEase / Kugou) highlight the
 *  exact line; text lyrics get ESTIMATED sync — syllable-weighted timing
 *  spread across the track — and can be calibrated by double-tapping a line
 *  the moment it's sung. Anchors warp the timeline piecewise, so sped-up or
 *  slowed sections in mixes track correctly. Click any line to seek; [ / ]
 *  nudge ±100ms; 0 resets sync and anchors. Never faked as exact: estimated
 *  mode is labeled.
 *
 *  Keys: Alt+L toggle · click line = seek · S search · Esc close
 *        [ / ] nudge sync ±100ms · 0 reset
 */

(() => {
  'use strict';

  const W = SUITE.W;
  if (W.__SLX3__) {
    // The standalone SuperLyrics script grabbed the guard first — the suite's
    // lyrics module (library-fed matching, client_id resolve, pre-warm) is NOT
    // running. Say so instead of failing silently.
    try { console.warn('[SoundCloud Suite] Standalone SuperLyrics detected — disable it; the suite already includes a newer copy.'); } catch (e) {}
    try {
      GM_registerMenuCommand('⚠ Lyrics conflict — disable standalone SuperLyrics', () => {
        try { SUITE.W.alert('Two SuperLyrics installs are running.\n\nDisable or remove the standalone "SuperLyrics for SoundCloud" userscript in Tampermonkey (keep only the SoundCloud Suite), then reload SoundCloud.'); } catch (e) {}
      });
    } catch (e) {}
    return;
  }
  try { W.__SLX3__ = 1; } catch (e) {}

  /* ------------------------------------------------------------------ *
   *  1. MEDIA HOOK — smooth time + seeking through SC's own timeline
   * ------------------------------------------------------------------ */

  // auto-align state shared by the renderer (defined first) and App (defined later): ms on the clock side,
  // the latest estimate, and App's apply() for the menu
  const SyncAuto = { ms: 0, conf: 0, last: null, apply: null, MIN_SEC: 0.2 };
  /* lyric-align.js — constant-lag estimator for per-line synced lyrics (LRC sheets).
   *
   * LYRIC_ALIGN.create(ctx, sourceNode, opts) → tracker
   *   Taps sourceNode (SoundCloud's MediaElementAudioSourceNode, or any AudioNode) with two
   *   analyser branches of its own. The branches have NO downstream connections, so the audible
   *   path is untouched (Chromium still renders analysers that have no outputs). The tap is made
   *   with AudioNode.prototype.connect so an instance-level connect() wrapper on the source (the
   *   extension's FX router installs one) is neither triggered nor confused.
   *
   *   Branch A "mid":  source → Gain(channelCount 1, explicit → 0.5·(L+R)) → HP 250 Hz ×2 → LP 3.5 kHz → Analyser
   *   Branch B "side": source → Splitter → (+0.5·L) + (−0.5·R) → same filters → Analyser
   *   Every hop (20 ms) a timer reads both analysers' 2048-sample time-domain buffers, takes the
   *   mean square of each and adds them to a grid keyed by MEDIA time (opts.mediaTime()), so seeks
   *   and pauses do not corrupt the envelope; frames past opts.windowSec (default 90 s) are ignored
   *   and the timer idles there (no analyser reads).
   *
   *   opts.mediaTime()      REQUIRED — the media element's currentTime in seconds.
   *   opts.paused()         optional — true while paused (frames are dropped).
   *   opts.playbackRate()   optional — when != 1 frames are stamped straight from mediaTime().
   *   opts.windowSec        recorded media-time span (default 90).
   *   opts.hopMs            grid step (default 20; the analysis constants assume 20).
   *
   * tracker.estimate(lineStartsSec) → { lagSec, confidence, peak, runnerUp, samples, linesUsed, reason, stats }
   *   SIGN CONVENTION — lagSec is the constant to ADD to every lyric timestamp so the sheet lines up
   *   with the audio the page is playing:  displayTime(line) = lrcTime(line) + lagSec.
   *   lagSec > 0 ⇒ the vocal entries happen LATER than the sheet says (the sheet is EARLY / fires too
   *   soon) and delaying it by lagSec fixes that. lagSec < 0 ⇒ the sheet is LATE; add the negative.
   *   confidence ∈ [0, 1]. When the estimator declines, lagSec is 0, confidence 0 and reason is set
   *   ('too-few-lines' | 'no-audio' | 'silence' | 'no-activity' | 'flat').
   *   peak = { lagSec, score, z }  runnerUp = { lagSec, score, ratio }  samples = covered frames.
   * tracker.stats()    → { ticks, cpuMs, frames, hop }  timer CPU accounting (performance.now only).
   * tracker.envelope() → { mid, side, cnt, hop } copy of the raw grid (for offline analysis).
   * tracker.dispose()  → stops the timer and disconnects the taps.
   *
   * LYRIC_ALIGN.analyse(envelope, lineStartsSec, opts) is the pure DSP core (no Web Audio), used by
   * estimate() and by offline tests. All timing comes from ctx.currentTime / mediaTime(); the wall clock
   * is never used (wall-clock-free).
   *
   * Method: per frame, the "centre" band energy c = max(mid − side, 0.05·mid) (a centred vocal has
   * mid ≫ side; wide-panned instruments have mid ≈ side) is taken in dB and floored 60 dB below the
   * loudest frame. A sustain-aware onset function is the half-wave-rectified STEP response: the mean
   * level of the next W frames minus the mean of the previous W frames, at W = 6 (120 ms) and W = 12
   * (240 ms), each compressed by tanh(step / 6 dB) and summed. A drum hit that lasts 50 ms raises the
   * 240 ms forward mean by only ~1/5 of its height, a vocal phrase that sustains ≥ 250 ms raises it
   * fully — that is the "sustain-aware" part. The onset function is cross-correlated with the sheet's
   * line-start impulse train (Gaussian-smoothed by ±1 frame) for lags in ±2.5 s at 20 ms steps;
   * lags out to ±6 s are also computed and serve as the null distribution (median and MAD → robust σ).
   * Peaks: local maxima inside ±2.5 s whose height is within NEAR_PEAK_FRAC (15 %) of the best
   * prominence compete, and the one nearest 0 wins (community sheets are usually within ±0.5 s; a
   * secondary peak at ± one beat period is the classic ambiguity and this rule states the prior
   * explicitly). Confidence = pz·√pr·pn with pz = clamp((z − 4)/4) from the peak's prominence in
   * robust σ units, pr = clamp((1 − ratio)/0.5) from the runner-up (best local maximum outside
   * ±150 ms of the winner) relative to the winner's prominence, and pn = clamp((linesUsed − 4)/8)
   * so 6-line sheets cannot be fully confident.
   */
  const LYRIC_ALIGN = (function () {
    'use strict';

    var DEFAULT_HOP_MS = 20;
    var MAX_LAG_SEC = 2.5;        // decision range for the lag
    var NULL_LAG_SEC = 6;         // range whose correlation values form the null statistics
    var STEP_SHORT = 6;           // 120 ms step detector (frames at 20 ms)
    var STEP_LONG = 12;           // 240 ms step detector
    var ONSET_SCALE_DB = 6;       // tanh compression scale for a rectified step, in dB
    var LEVEL_FLOOR_DB = 60;      // per-frame level floored this far below the loudest frame
    var NEAR_PEAK_FRAC = 0.15;    // peaks within 15 % of the top prominence compete; nearest 0 wins
    var EXCLUDE_SEC = 0.15;       // runner-up must sit outside ±150 ms of the chosen peak
    var Z_LO = 4, Z_HI = 8;       // prominence (robust σ) → 0..1
    var RATIO_FULL = 0.5;         // runner-up ratio ≤ 0.5 → full marks, 1.0 → none
    var MIN_LINES = 6;            // fewer usable lines → decline
    var MIN_COVER_SEC = 15;       // less recorded audio than this → decline
    var SILENCE_DB = -60;         // loudest mid-band frame below this (dBFS of mean square) → 'silence'
    var ACTIVITY_MIN = 0.004;     // fraction of frames with onset > 0.3 required (else 'no-activity')
    var GAP_W_LO = 1, GAP_W_HI = 4;  // line weight 0.5 → 1 as the gap to the previous line goes 1 → 4 s
    var EPS = 1e-10;

    function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
    function median(a) {
      if (!a.length) return NaN;
      var b = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; });
      var h = b.length >> 1;
      return b.length % 2 ? b[h] : 0.5 * (b[h - 1] + b[h]);
    }
    function meanSq(buf) { var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return s / buf.length; }
    function tanh(x) { if (x > 20) return 1; if (x < -20) return -1; var e = Math.exp(2 * x); return (e - 1) / (e + 1); }
    function round3(x) { return Math.round(x * 1000) / 1000; }

    function decline(reason, extra) {
      var r = { lagSec: 0, confidence: 0, peak: null, runnerUp: null, samples: 0, linesUsed: 0, reason: reason };
      if (extra) for (var k in extra) r[k] = extra[k];
      return r;
    }

    /* ── pure DSP core ─────────────────────────────────────────────────────────────── */
    function analyse(env, lineStarts, opts) {
      opts = opts || {};
      var hop = env.hop > 0 ? env.hop : DEFAULT_HOP_MS / 1000;
      var mid = env.mid, side = env.side, cnt = env.cnt, n = mid.length;
      var maxLag = Math.round((opts.maxLagSec > 0 ? opts.maxLagSec : MAX_LAG_SEC) / hop);
      var nullLag = Math.max(maxLag, Math.round(NULL_LAG_SEC / hop));
      var i, k;

      // 1. per-frame centre level in dB; validity from the sample count
      var lvl = new Float32Array(n), valid = new Uint8Array(n);
      var covered = 0, maxMid = -Infinity, maxC = -Infinity;
      for (i = 0; i < n; i++) {
        if (!cnt[i]) continue;
        var m = mid[i] / cnt[i], s = side[i] / cnt[i];
        var c = m - s; if (c < 0.05 * m) c = 0.05 * m;
        var ml = 10 * Math.log10(m + EPS), cl = 10 * Math.log10(c + EPS);
        lvl[i] = cl; valid[i] = 1; covered++;
        if (ml > maxMid) maxMid = ml;
        if (cl > maxC) maxC = cl;
      }
      var stats = { coveredSec: round3(covered * hop), maxMidDb: round3(maxMid) };
      if (covered * hop < MIN_COVER_SEC) return decline('no-audio', { samples: covered, stats: stats });
      if (maxMid < SILENCE_DB) return decline('silence', { samples: covered, stats: stats });
      var floor = maxC - LEVEL_FLOOR_DB;
      for (i = 0; i < n; i++) if (valid[i] && lvl[i] < floor) lvl[i] = floor;

      // 2. sustain-aware onset function: rectified step response at two scales
      var on = new Float32Array(n), onValid = new Uint8Array(n);
      var runValid = new Int32Array(n + 1), pre = new Float64Array(n + 1);   // prefix sums
      for (i = 0; i < n; i++) { runValid[i + 1] = runValid[i] + valid[i]; pre[i + 1] = pre[i] + (valid[i] ? lvl[i] : 0); }
      var step = function (i0, W) {
        // mean(lvl[i0 .. i0+W-1]) − mean(lvl[i0-W .. i0-1]); NaN unless every frame is valid
        if (i0 - W < 0 || i0 + W > n) return NaN;
        if (runValid[i0 + W] - runValid[i0 - W] !== 2 * W) return NaN;
        return (pre[i0 + W] - pre[i0]) / W - (pre[i0] - pre[i0 - W]) / W;
      };
      var active = 0;
      for (i = 0; i < n; i++) {
        var a = step(i, STEP_SHORT), b = step(i, STEP_LONG);
        if (isNaN(a) || isNaN(b)) continue;   // NaN → gap
        var v = tanh(Math.max(0, a) / ONSET_SCALE_DB) + tanh(Math.max(0, b) / ONSET_SCALE_DB);
        on[i] = v; onValid[i] = 1;
        if (v > 0.3) active++;
      }
      var onCount = 0; for (i = 0; i < n; i++) onCount += onValid[i];
      stats.activity = onCount ? round3(active / onCount) : 0;
      if (!onCount || active / onCount < ACTIVITY_MIN) return decline('no-activity', { samples: covered, stats: stats });
      // ±1-frame Gaussian smoothing of the impulse train ≡ smoothing the onset function
      var sm = new Float32Array(n);
      for (i = 0; i < n; i++) {
        if (!onValid[i]) continue;
        var acc = 0.5 * on[i], wsum = 0.5;
        if (i > 0 && onValid[i - 1]) { acc += 0.25 * on[i - 1]; wsum += 0.25; }
        if (i + 1 < n && onValid[i + 1]) { acc += 0.25 * on[i + 1]; wsum += 0.25; }
        sm[i] = acc / wsum;
      }

      // 3. line impulses (frame index + weight from the gap to the previous line)
      var lines = [];
      var ls = Array.prototype.slice.call(lineStarts || []).map(Number).filter(function (t) { return !isNaN(t) && t >= 0; }).sort(function (x, y) { return x - y; });
      var windowSec = n * hop;
      for (i = 0; i < ls.length; i++) {
        if (i > 0 && ls[i] - ls[i - 1] < 0.05) continue;   // duplicate timestamp (bilingual sheets)
        if (ls[i] > windowSec) break;
        var gap = i > 0 ? ls[i] - ls[i - 1] : GAP_W_HI;
        var w = 0.5 + 0.5 * clamp01((gap - GAP_W_LO) / (GAP_W_HI - GAP_W_LO));
        lines.push({ f: Math.round(ls[i] / hop), w: w });
      }
      // usable = the line's own frame is inside the recorded envelope
      var used = 0, wTotal = 0;
      for (i = 0; i < lines.length; i++) { var f = lines[i].f; if (f >= 0 && f < n && onValid[f]) { used++; wTotal += lines[i].w; } }
      stats.linesInWindow = lines.length;
      if (used < MIN_LINES) return decline('too-few-lines', { samples: covered, linesUsed: used, stats: stats });

      // 4. cross-correlation over lags (lag > 0 ⇒ audio event later than the sheet ⇒ sheet early)
      var L = 2 * nullLag + 1, cc = new Float64Array(L), ccOk = new Uint8Array(L);
      for (k = -nullLag; k <= nullLag; k++) {
        var sum = 0, ws = 0;
        for (i = 0; i < lines.length; i++) {
          var idx = lines[i].f + k;
          if (idx < 0 || idx >= n || !onValid[idx]) continue;
          sum += lines[i].w * sm[idx]; ws += lines[i].w;
        }
        if (ws >= 0.5 * wTotal) { cc[k + nullLag] = sum / ws; ccOk[k + nullLag] = 1; }
      }
      var fin = []; for (k = 0; k < L; k++) if (ccOk[k]) fin.push(cc[k]);
      if (fin.length < 20) return decline('no-audio', { samples: covered, linesUsed: used, stats: stats });
      var med = median(fin), dev = []; for (k = 0; k < fin.length; k++) dev.push(Math.abs(fin[k] - med));
      var sd = 1.4826 * median(dev);
      stats.ccMedian = round3(med); stats.ccSigma = round3(sd);
      if (!(sd > 1e-6)) return decline('flat', { samples: covered, linesUsed: used, stats: stats });

      // 5. local maxima inside the decision range
      var peaks = [], top = -Infinity;
      for (k = -maxLag; k <= maxLag; k++) {
        var j = k + nullLag;
        if (!ccOk[j]) continue;
        var lft = j > 0 && ccOk[j - 1] ? cc[j - 1] : -Infinity, rgt = j + 1 < L && ccOk[j + 1] ? cc[j + 1] : -Infinity;
        if (cc[j] > lft && cc[j] >= rgt) { peaks.push({ k: k, v: cc[j] }); if (cc[j] > top) top = cc[j]; }
      }
      if (!peaks.length || !(top > med)) return decline('flat', { samples: covered, linesUsed: used, stats: stats });
      var thresh = top - NEAR_PEAK_FRAC * (top - med), chosen = null;
      for (i = 0; i < peaks.length; i++) {
        if (peaks[i].v < thresh) continue;
        if (!chosen || Math.abs(peaks[i].k) < Math.abs(chosen.k)) chosen = peaks[i];
      }
      var excl = Math.round(EXCLUDE_SEC / hop), ru = null;
      for (i = 0; i < peaks.length; i++) {
        if (Math.abs(peaks[i].k - chosen.k) <= excl) continue;
        if (!ru || peaks[i].v > ru.v) ru = peaks[i];
      }
      // parabolic interpolation for a sub-frame lag
      var jc = chosen.k + nullLag, frac = 0;
      if (jc > 0 && jc + 1 < L && ccOk[jc - 1] && ccOk[jc + 1]) {
        var y0 = cc[jc - 1], y1 = cc[jc], y2 = cc[jc + 1], den = y0 - 2 * y1 + y2;
        if (den < 0) { frac = 0.5 * (y0 - y2) / den; if (frac > 0.5) frac = 0.5; if (frac < -0.5) frac = -0.5; }
      }
      var prom = chosen.v - med, z = prom / sd;
      var ratio = ru ? Math.max(0, (ru.v - med) / prom) : 0;
      var pz = clamp01((z - Z_LO) / (Z_HI - Z_LO));
      var pr = clamp01((1 - ratio) / (1 - RATIO_FULL));
      var pn = clamp01((used - 4) / 8);
      var conf = pz * Math.sqrt(pr) * pn;
      stats.pz = round3(pz); stats.pr = round3(pr); stats.pn = round3(pn); stats.globalMaxLagSec = round3(peaks.filter(function (p) { return p.v === top; })[0].k * hop);
      return {
        lagSec: round3((chosen.k + frac) * hop),
        confidence: round3(conf),
        peak: { lagSec: round3(chosen.k * hop), score: round3(chosen.v), z: round3(z) },
        runnerUp: ru ? { lagSec: round3(ru.k * hop), score: round3(ru.v), ratio: round3(ratio) } : null,
        samples: covered, linesUsed: used, reason: '', stats: stats,
      };
    }

    /* ── live tracker on a Web Audio graph ─────────────────────────────────────────── */
    function create(ctx, src, opts) {
      opts = opts || {};
      if (!ctx || !src || typeof opts.mediaTime !== 'function') throw new Error('LYRIC_ALIGN.create: ctx, sourceNode and opts.mediaTime() are required');
      var hopMs = opts.hopMs > 0 ? +opts.hopMs : DEFAULT_HOP_MS, hop = hopMs / 1000;
      var windowSec = opts.windowSec > 0 ? +opts.windowSec : 90;
      var n = Math.ceil(windowSec / hop) + 1;
      var env = { mid: new Float32Array(n), side: new Float32Array(n), cnt: new Uint16Array(n), hop: hop };
      var FFT = 2048, buf = new Float32Array(FFT);
      var own = [];
      var gain = function (g) { var nd = ctx.createGain(); nd.gain.value = g; own.push(nd); return nd; };
      var biquad = function (type, f) { var nd = ctx.createBiquadFilter(); nd.type = type; nd.frequency.value = f; nd.Q.value = 0.7071; own.push(nd); return nd; };
      var branch = function (input) {
        var hp1 = biquad('highpass', 250), hp2 = biquad('highpass', 250), lp = biquad('lowpass', 3500);
        var an = ctx.createAnalyser(); an.fftSize = FFT; an.smoothingTimeConstant = 0; own.push(an);
        input.connect(hp1); hp1.connect(hp2); hp2.connect(lp); lp.connect(an);
        return an;
      };
      // mid: explicit mono down-mix = 0.5·(L+R)
      var midIn = gain(1); midIn.channelCount = 1; midIn.channelCountMode = 'explicit'; midIn.channelInterpretation = 'speakers';
      // side: 0.5·L − 0.5·R summed into a mono gain
      var split = ctx.createChannelSplitter(2); own.push(split);
      var gl = gain(0.5), gr = gain(-0.5), sideIn = gain(1); sideIn.channelCount = 1; sideIn.channelCountMode = 'explicit';
      split.connect(gl, 0); split.connect(gr, 1); gl.connect(sideIn); gr.connect(sideIn);
      var anM = branch(midIn), anS = branch(sideIn);
      var rawConnect = (opts.rawConnect === false || !W.AudioNode) ? src.connect : W.AudioNode.prototype.connect;
      var rawDisconnect = (opts.rawConnect === false || !W.AudioNode) ? src.disconnect : W.AudioNode.prototype.disconnect;
      rawConnect.call(src, midIn); rawConnect.call(src, split);

      var halfWin = (FFT / 2) / ctx.sampleRate;
      var lastMt = -1, seg = null, ticks = 0, cpuMs = 0, frames = 0, disposed = false;
      var now = function () { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0; };
      var body = function () {
        var mt = +opts.mediaTime();
        if (!(mt >= 0) || mt === Infinity) { seg = null; lastMt = -1; return; }
        if (opts.paused && opts.paused()) { seg = null; lastMt = mt; return; }
        if (mt === lastMt) { seg = null; return; }   // frozen clock: paused / stalled
        lastMt = mt;
        var t, rate = opts.playbackRate ? +opts.playbackRate() : 1;
        if (rate && Math.abs(rate - 1) > 0.01) t = mt;
        else {
          // media time = render clock + offset; the offset is constant between seeks, so a running
          // median of it removes the jitter of individual currentTime reads. A jump > 200 ms = seek.
          var ct = ctx.currentTime, off = mt - ct;
          if (seg && Math.abs(off - seg.off) > 0.2) seg = null;
          if (!seg) seg = { offs: [], off: off };
          seg.offs.push(off); if (seg.offs.length > 15) seg.offs.shift();
          seg.off = median(seg.offs);
          t = ct + seg.off;
        }
        var idx = Math.round((t - halfWin) / hop);   // stamp the frame at the centre of the analyser window
        if (idx < 0 || idx >= n) return;             // outside the recorded window → idle
        anM.getFloatTimeDomainData(buf); var m2 = meanSq(buf);
        anS.getFloatTimeDomainData(buf); var s2 = meanSq(buf);
        if (env.cnt[idx] < 65535) { env.mid[idx] += m2; env.side[idx] += s2; env.cnt[idx]++; frames++; }
      };
      var tick = function () { if (disposed) return; var t0 = now(); ticks++; try { body(); } catch (e) {} cpuMs += now() - t0; };
      var timer = setInterval(tick, hopMs);

      return {
        estimate: function (lineStarts) {
          var t0 = now();
          var r = analyse(env, lineStarts, { maxLagSec: opts.maxLagSec });
          r.stats = r.stats || {}; r.stats.estimateMs = round3(now() - t0);
          return r;
        },
        stats: function () { return { ticks: ticks, cpuMs: round3(cpuMs), frames: frames, hop: hop, sampleRate: ctx.sampleRate }; },
        envelope: function () { return { mid: Array.prototype.slice.call(env.mid), side: Array.prototype.slice.call(env.side), cnt: Array.prototype.slice.call(env.cnt), hop: hop }; },
        dispose: function () {
          if (disposed) return; disposed = true;
          clearInterval(timer);
          try { rawDisconnect.call(src, midIn); } catch (e) {}
          try { rawDisconnect.call(src, split); } catch (e) {}
          for (var i = 0; i < own.length; i++) { try { own[i].disconnect(); } catch (e) {} }
          own.length = 0;
        },
      };
    }

    return { create: create, analyse: analyse, VERSION: '0.1' };
  })();

  const Media = (() => {
    let active = null, seekSeq = 0;
    const reg = (el) => {
      try {
        if (!el || el.__slxHook) return;
        el.__slxHook = 1;
        const set = () => { active = el; };
        el.addEventListener('play', set, { passive: true });
        el.addEventListener('playing', set, { passive: true });
        if (!el.paused) active = el;
      } catch (e) {}
    };
    try {
      const NativeAudio = W.Audio;
      if (NativeAudio) {
        const Hooked = function (...args) { const el = new NativeAudio(...args); reg(el); return el; };
        Hooked.prototype = NativeAudio.prototype;
        W.Audio = Hooked;
      }
      const doc = W.document;
      const ce = doc.createElement;
      doc.createElement = function (name, ...rest) {
        const el = ce.call(this, name, ...rest);
        // hottest function in the SPA — only normalize names that could match
        if (typeof name === 'string' && name.length === 5) {
          const n = name.toLowerCase();
          if (n === 'audio' || n === 'video') reg(el);
        }
        return el;
      };
    } catch (e) {}

    setInterval(() => {
      try { document.querySelectorAll('audio,video').forEach(reg); } catch (e) {}
    }, 3000);

    // cached element refs: these used to be querySelector'd EVERY rAF frame
    let pbBtn = null, tlEl = null, tpWrap = null;
    const playBtn = () => {
      if (!pbBtn || !pbBtn.isConnected) pbBtn = document.querySelector('.playControls__play');
      return pbBtn;
    };
    const tlWrap = () => {
      if (!tlEl || !tlEl.isConnected) tlEl = document.querySelector('.playbackTimeline__progressWrapper');
      return tlEl;
    };
    const playingNow = () => {
      if (active) return !active.paused;
      const b = playBtn();
      return !!(b && b.classList.contains('playing'));
    };

    // aria fallback with interpolation (the attribute only updates ~1/sec)
    let ariaV = 0, ariaAt = 0;
    const ariaTime = () => {
      const el = tlWrap();
      if (!el) return 0;
      const v = parseFloat(el.getAttribute('aria-valuenow'));
      if (!isFinite(v)) return 0;
      const now = performance.now();
      if (v !== ariaV) { ariaV = v; ariaAt = now; }
      const extra = playingNow() ? Math.min((now - ariaAt) / 1000, 1.2) : 0;
      return ariaV + extra;
    };

    // the visible elapsed-time text as a last-resort source, interpolated too
    let tpV = 0, tpAt = 0;
    const passedTime = () => {
      if (!tpWrap || !tpWrap.isConnected) tpWrap = document.querySelector('.playbackTimeline__timePassed');
      const tp = tpWrap;
      if (!tp) return 0;
      const sp = tp.querySelector('span[aria-hidden="true"]') || tp;
      const v = parseClock((sp.textContent || '').trim());
      if (!(v >= 0)) return 0;
      const now = performance.now();
      if (v !== tpV) { tpV = v; tpAt = now; }
      const extra = playingNow() ? Math.min((now - tpAt) / 1000, 1.2) : 0;
      return tpV + extra;
    };

    const fireSeq = (el, x, y) => {
      const base = { bubbles: true, cancelable: true, composed: true, view: W, clientX: x, clientY: y, button: 0 };
      const pe = (type, extra) => { try { el.dispatchEvent(new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, base, extra))); } catch (e) {} };
      const me = (type, extra) => { try { el.dispatchEvent(new MouseEvent(type, Object.assign({}, base, extra))); } catch (e) {} };
      pe('pointerdown', { buttons: 1 }); me('mousedown', { buttons: 1 });
      pe('pointermove', { buttons: 1 }); me('mousemove', { buttons: 1 });
      pe('pointerup', { buttons: 0 }); me('mouseup', { buttons: 0 });
      me('click', { buttons: 0 });
    };

    // phase-locked clock smoother: media currentTime is read once per frame, which
    // leaves tiny stair-steps + read jitter. We predict the position from a sampled
    // anchor + real elapsed wall-time (×playbackRate) and gently slew toward each
    // fresh sample — giving a continuous, sub-frame-accurate position. A large gap
    // (seek / pause / track change) hard re-anchors so it never lags behind a jump.
    const clk = (() => {
      let pos = null, wall = 0, last = 0;
      return {
        reset() { pos = null; },
        smooth(raw) {
          const now = performance.now();
          if (pos == null || !playingNow()) { pos = raw; wall = now; last = raw; return raw; }
          const rate = (active && isFinite(active.playbackRate) && active.playbackRate > 0) ? active.playbackRate : 1;
          const pred = pos + (now - wall) / 1000 * rate;
          const err = raw - pred;
          if (Math.abs(err) > 0.35) { pos = raw; wall = now; last = raw; return raw; }   // seek / jump (incl. backwards) → snap
          pos = pred + err * 0.1;   // converge ~10%/frame: smooth, no visible lurch
          wall = now;
          // the predictor can briefly extrapolate past a frozen currentTime sample;
          // clamp so playback time is strictly non-decreasing (no backwards flicker)
          if (pos < last) pos = last; else last = pos;
          return pos;
        },
      };
    })();

    return {
      el: () => active,
      time() {
        // PRIMARY: the real decoder clock — prefer the enhancer's reliably-captured
        // element, then our own. On this accurate source we subtract the measured
        // AudioContext output latency so the highlight tracks what you HEAR, not
        // what's merely been decoded (the buffer + device delay is ~50–200 ms).
        const a = ariaTime();   // SoundCloud's own timeline — coarse, but authoritative for the CURRENT position
        let raw = null;
        try { if (SUITE.audioClock) { const c = SUITE.audioClock(); if (c != null && c > 0) raw = c; } } catch (e) {}
        if (raw == null && active && isFinite(active.currentTime) && active.currentTime > 0) raw = active.currentTime;
        if (raw != null) {
          // sanity-gate the precise element clock against the UI timeline: aria lags
          // ≤1.2 s, so a gap beyond that means the element clock is for a different
          // track (preload/stale) — trust the timeline instead of drifting away.
          if (a > 0 && Math.abs(raw - a) > 2.5) { clk.reset(); return a; }
          let L = 0; try { if (SUITE.audioLatency) L = (SUITE.audioLatency() || 0) / 1000; } catch (e) {}
          try { if (SUITE.audioRate) L *= (SUITE.audioRate() || 1); } catch (e) {}   // output seconds → media seconds
          return Math.max(0, clk.smooth(raw) - L);
        }
        // FALLBACKS (these already lag ~1 s by nature): no extra latency on top
        clk.reset();
        if (a > 0) return a;
        return passedTime();
      },
      playing: playingNow,
      seek(sec) {
        // primary: the captured element itself. SoundCloud's player reads the position back from the
        // element's own timeupdate, so the waveform, the timecode and its persisted position all follow;
        // a synthetic click on the timeline, the old primary path, opens the sign-in modal (and pauses)
        // for anyone not logged in
        if (active && isFinite(active.duration) && active.duration > 0) {
          try { active.currentTime = Math.min(Math.max(0, sec), active.duration - 0.25); seekSeq++; return true; } catch (e) {}
        }
        // fallback: drive SoundCloud's own timeline (pointer + mouse sequences)
        const wrap = tlWrap();
        const max = (wrap && parseFloat(wrap.getAttribute('aria-valuemax')))
          || (active && isFinite(active.duration) && active.duration) || 0;
        let fired = false;
        if (wrap && max > 0) {
          const r = wrap.getBoundingClientRect();
          if (r.width > 10) {
            const ratio = Math.min(Math.max(sec / max, 0), 0.995);
            fireSeq(wrap, r.left + r.width * ratio, r.top + r.height / 2);
            fired = true;
          }
        }
        // verify the jump landed; if the UI ignored us, set the time directly — but only for the
        // newest seek: a held arrow key or two quick line clicks must not be yanked back in turn
        const mySeq = ++seekSeq;
        setTimeout(() => {
          if (mySeq !== seekSeq) return;
          const now = this.time();
          if (Math.abs(now - sec) > 3 && active && isFinite(active.duration)) {
            try { active.currentTime = sec; } catch (e) {}
          }
        }, 380);
        if (!fired && active && isFinite(active.duration)) {
          try { active.currentTime = sec; return true; } catch (e) {}
        }
        return fired;
      },
    };
  })();

  /* ------------------------------------------------------------------ *
   *  2. TEXT UTILS
   * ------------------------------------------------------------------ */

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const deFancy = (s) => {
    try { return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); }
    catch (e) { return String(s); }
  };

  const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

  const NK_MEMO = new Map();
  const normCompute = (key) => {
    let s = deFancy(key.toLowerCase()).replace(/[\u2018\u2019]/g, "'");
    s = s.replace(/[^\p{L}\p{N}\s'@$]/gu, ' ');
    s = s.split(/\s+/).map((tok) => {
      if (/[a-z]/.test(tok) && /[013457@$]/.test(tok)) {
        return tok.replace(/[013457@$]/g, (ch) => LEET[ch] || ch);
      }
      return tok.replace(/[@$]/g, '');
    }).join(' ');
    return s.replace(/'/g, '').replace(/\s+/g, ' ').trim();
  };
  const normKey = (input) => {
    const key = String(input == null ? '' : input);
    // never memoize lyric bodies: one cross-check would flush the hot title keys
    if (key.length > 200) return normCompute(key);
    const hit = NK_MEMO.get(key);
    if (hit !== undefined) return hit;
    const s = normCompute(key);
    if (NK_MEMO.size > 1600) NK_MEMO.clear();
    NK_MEMO.set(key, s);
    return s;
  };

  const lev = (a, b) => {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  };

  const sim = (a, b) => {
    a = normKey(a); b = normKey(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const sa = a.split(' ').join(''), sb = b.split(' ').join('');
    if (sa === sb) return 0.98;
    let best = 0;
    // containment only counts between COMPARABLE lengths — "The Corn" is a
    // substring of "Children of the Corn - Chronic Time" yet a completely
    // different song; the unguarded shortcut rendered exactly that
    if (sa.length > 3 && sb.length > 3 && (sa.includes(sb) || sb.includes(sa))
        && Math.min(sa.length, sb.length) / Math.max(sa.length, sb.length) >= 0.4) best = 0.93;
    if (!best && sa.length > 8 && Math.abs(sa.length - sb.length) <= 2) {
      const d = lev(sa, sb);
      if (d <= Math.max(1, Math.floor(sa.length / 12))) best = 0.93; // Demons vs Demonz etc.
    }
    const ta = [...new Set(a.split(' '))], tb = [...new Set(b.split(' '))];
    const inter = ta.filter((t) => tb.includes(t)).length;
    const jac = inter / (ta.length + tb.length - inter || 1);
    const L = Math.max(a.length, b.length);
    const lv = 1 - lev(a, b) / (L || 1);
    return Math.max(best, 0.5 * jac + 0.5 * lv);
  };

  // fraction of letters that are Latin-script — used to reject CJK/Cyrillic
  // junk candidates when the playing track has a Latin title
  const latinish = (s) => {
    const letters = String(s == null ? '' : s).match(/\p{L}/gu) || [];
    if (!letters.length) return 1;
    let lat = 0;
    for (const ch of letters) if (/[\u0041-\u024F]/.test(ch)) lat++;
    return lat / letters.length;
  };

  const sameTitle = (a, b) => {
    a = normKey(a).split(' ').join(''); b = normKey(b).split(' ').join('');
    return !!a && a === b;
  };

  const parseClock = (str) => {
    const p = String(str || '').trim().split(':').map((x) => parseInt(x, 10));
    if (!p.length || p.some((x) => !isFinite(x))) return 0;
    return p.reduce((acc, x) => acc * 60 + x, 0);
  };

  // Map a synced lyric's timestamps onto SoundCloud's ACTUAL track length.
  // A duration mismatch on SC is almost always a sped-up / edited / re-pitched
  // upload — i.e. a TEMPO change — so the raw timestamps drift LINEARLY across
  // the song (fine at the start, way off by the end). Scaling every timestamp by
  // wantDur/srcDur cancels that drift exactly. We scale for any mismatch beyond
  // ~0.8% (≈1.5 s on a 3-min track) instead of waving 8% mismatches through raw.
  //   → { lines, scaled }  ·  or null when the version is too far off to trust.
  function fitSync(lines, srcDur, wantDur) {
    if (!lines || !lines.length) return null;
    if (!(srcDur > 0 && wantDur > 0)) return { lines, scaled: false };   // unknown duration → trust raw
    const ratio = wantDur / srcDur;
    if (ratio < 0.6 || ratio > 1.7) return null;                        // wildly off = wrong version
    if (Math.abs(ratio - 1) <= 0.008) return { lines, scaled: false };  // already aligned (sub-2 s)
    return { lines: lines.map((l) => [l[0] * ratio, l[1]]), scaled: true };
  }

  /* ------------------------------------------------------------------ *
   *  3. TITLE CLEANING / GUESS ENGINE
   * ------------------------------------------------------------------ */

  const JUNK = 'cdq|hq|lq|leak(?:ed)?|unreleased|snippet|preview|teaser|og(?:\\s*file)?|grail|throwaway|vault|archived?|archive|exclusive|rip|remaster(?:ed)?|tag(?:ged)?|untagged|no\\s*(?:dj|tags?)|free\\s*(?:dl|d(?:ownload)?)?|download|dl\\s*in\\s*desc(?:ription)?|wav|mp3|m4a|flac|aiff|320|256|192|kbps|official(?:\\s*(?:audio|video|music\\s*video|visuali[sz]er))?|audio|visuali[sz]er|lyric(?:s)?(?:\\s*video)?|music\\s*video|mv|hd|4k|explicit|clean(?:\\s*version)?|sped\\s*up|slowed(?:\\s*(?:\\+|and|&|n)?\\s*reverb)?|reverb|nightcore|(?:normal\\s*)?pitch(?:ed)?(?:\\s*(?:up|down))?|8d|bass\\s*boost(?:ed)?|cover|remake|ai(?:\\s*(?:cover|version|remake))?|stems?|ac(?:c)?ap(?:p)?ella|bonus|full(?:\\s*(?:song|version))?|final|v\\d+|version|demo|session[s]?|reference|ref\\s*track|alt(?:ernate)?|edit(?:ed)?|extended|loop(?:ed)?|best\\s*(?:part|version)|prod(?:\\.|uced)?(?:\\s*by)?[^\\)\\]\\}]*';

  // parenthetical content that belongs to the song title itself —
  // "(SpeedBuster)", "(Remix)", "(pt 2)" — never an "Artist (Song)" split
  const VERSIONISH = /\b(?:speed\w*|slow\w*|fast\w*|mix|remix\w*|mash\s?up|flip|boot(?:leg)?|vip|redux|redo|instrumental|interlude|intro|outro|pt\.?\s*\d+|part\s*\d+|take\s*\d+|version|ver\.?|edit(?:ed)?|extended|pitch(?:ed)?|with|w\/)\b/i;

  // version markers that change WHICH lyrics are right, not just how they're
  // timed — a "(Remix)" upload must never get the plain original's lyrics
  const VTAGS = [
    [/\bremix\w*|\bflip\b|\bbootleg\b|\bvip\b|\bmashup\b|\bedit\b/i, 'remix'],
    [/\blive\b|\bunplugged\b|\bconcert\b/i, 'live'],
    [/\bacoustic\b/i, 'acoustic'],
    [/\bcover\b|\bremake\b/i, 'cover'],
    [/\binstrumental\b|\bkaraoke\b/i, 'instrumental'],
    [/\bdemo\b/i, 'demo'],
    [/\bfreestyle\b/i, 'freestyle'],
    [/\b(?:pt|part)\.?\s*(\d+|i{1,3}v?)\b/i, 'part'],
    [/\bremaster(?:ed)?\b/i, 'remaster'],
  ];
  function versionTags(s) {
    const out = new Set();
    s = deFancy(String(s || ''));
    for (const [re, tag] of VTAGS) {
      const m = s.match(re);
      if (m) out.add(tag === 'part' ? 'part' + String(m[1]).toLowerCase() : tag);
    }
    return out;
  }

  const RX = {
    emoji: /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu,
    stars: /[\*★☆✰✦✧♡♥◆◇▶►•~_]+/g,
    trackNo: /^\s*#?\d{1,3}\s*[\.\)\]\-–—:]\s+/,
    junkBracket: new RegExp('[\\(\\[\\{][^\\)\\]\\}]*\\b(?:' + JUNK + ')\\b[^\\)\\]\\}]*[\\)\\]\\}]', 'gi'),
    bareProd: /(^|[\s\-–—])prod(?:\.|uced)?\s*(?:by)?\s+[^\-\(\[\)\]]{1,50}/gi,
    feat: /[\(\[\{]\s*(?:feat\.?|ft\.?|featuring|with|w\/)\s+([^\)\]\}]+)[\)\]\}]/i,
    featTrail: /(?:^|\s)(?:feat\.?|ft\.?|featuring)\s+(.+)$/i,
    trailJunk: new RegExp('\\s*[\\-–—|/•·]+\\s*\\(?(?:cdq|hq|lq|leak(?:ed)?|unreleased|snippet|og|rip|full|final|v\\d+|wav|mp3|flac|320|free\\s*dl|exclusive|tag(?:ged)?|untagged|remaster(?:ed)?)\\)?\\s*$', 'i'),
    anyBracket: /[\(\[\{][^\)\]\}]*[\)\]\}]/g,
    spaces: /\s{2,}/g,
    credit: /(作词|作曲|编曲|混音|制作|词|曲|작사|작곡|편곡)\s*[:：]|^\s*(?:lyrics?|composed?|written|produced|arranged|mixed|performed|engineered|mastered)\s*(?:by)?\s*[:：]|^\[(?:verse|chorus|bridge|intro|outro|hook|pre[\-\s]?chorus|refrain)\s*\d*\]\s*$/i,
  };

  function cleanTitle(raw) {
    let s = deFancy(String(raw || ''));
    s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
    // capture version markers BEFORE the junk-stripper erases them \u2014 they
    // change how lyrics should be matched and synced (cover \u2260 original
    // timestamps, sped-up wants the scaled path, instrumental wants none)
    const flags = {
      cover: /[\(\[\{][^\)\]\}]*\b(?:cover|remake)\b[^\)\]\}]*[\)\]\}]/i.test(s) || /\bai\s*cover\b/i.test(s),
      spedUp: /\bsped\s*up\b|\bnightcore\b/i.test(s),
      slowed: /\bslowed\b/i.test(s),
      instrumental: /\binstrumentals?\b|\bkaraoke\b|\bno\s*vocals?\b/i.test(s),
    };
    s = s.replace(RX.emoji, ' ').replace(RX.stars, ' ');
    s = s.replace(RX.trackNo, '');

    // underground-SC patterns: "@HANDLE TITLE" (the handle IS the artist),
    // "#CATALOG/CODES" suffixes, and "inst: @producer" beat credits — capture
    // a leading handle as an artist hint, then strip all of it from the title
    let handle = '';
    const hm = s.match(/^\s*@([\w.\-]{2,30})\b/);
    if (hm) handle = hm[1].replace(/[._\-]+/g, ' ').trim();
    s = s.replace(/(?:^|\s)inst\s*[:：]\s*@?[\w.\-]+/gi, ' ');
    s = s.replace(/@[\w.\-]+/g, ' ');
    s = s.replace(/#[^\s#]+/g, ' ');

    const feats = [];
    const grabFeat = (m, g1) => {
      String(g1 || '').replace(RX.anyBracket, ' ').replace(RX.bareProd, ' ').split(/\s*(?:,|&|\+|\bx\b|\band\b)\s*/i)
        .map((x) => x.trim()).filter((x) => x.length > 1).forEach((x) => feats.push(x));
      return ' ';
    };
    s = s.replace(RX.feat, grabFeat);
    s = s.replace(RX.featTrail, grabFeat);

    s = s.replace(RX.junkBracket, ' ');
    s = s.replace(RX.junkBracket, ' ');
    s = s.replace(RX.bareProd, ' ');
    for (let i = 0; i < 4 && RX.trailJunk.test(s); i++) s = s.replace(RX.trailJunk, '');
    s = s.replace(RX.spaces, ' ').trim().replace(/^["']+|["']+$/g, '').replace(/^[\-–—|]+|[\-–—|]+$/g, '').trim();

    let artist = '';
    let title = s;
    let src = '';
    const dash = s.match(/^(.{1,60}?)\s+[-–—]\s+(.{1,90})$/);
    if (dash && dash[1].trim() && dash[2].trim()) {
      artist = dash[1].trim();
      title = dash[2].trim();
      src = 'dash';
    } else {
      // lowercase "by" only: Title-Case song titles ("Stand By Me", "Blinded By
      // The Light") must not be split into a bogus artist; uploads that mean it
      // write "track by artist". A pronoun/article tail is a title, not a name.
      const by = s.match(/^(.{2,80}?)\s+by\s+(.{2,50})$/);
      if (by && !/^(?:me|you|us|now|myself|yourself|(?:the|a|an|my|your|his|her|their)\s+\S+|night|day|default|design|chance|force|heart|hand|nature|law|name)$/i.test(by[2].trim())) {
        title = by[1].trim(); artist = by[2].trim(); src = 'by';
      }
    }
    if (!artist) {
      // archive style: `Knzck x Hi-c (Drown)` → artists + (song)
      const pm = s.match(/^(.{3,60}?)\s*[\(\[]([^\)\]]{2,40})[\)\]]\s*$/);
      if (pm && pm[1].split(/\s+/).length <= 7
          && !/[#!?]/.test(pm[1]) && !/\S\+\S/.test(pm[1])
          && !new RegExp('\\b(?:' + JUNK + ')\\b', 'i').test(pm[2])
          && !VERSIONISH.test(pm[2])) {
        artist = pm[1].trim();
        title = pm[2].trim();
        src = 'parens';
      }
    }
    if (!artist) {
      // `Artist "Song"` style
      const qm = s.match(/^(.{2,50}?)\s+["\u201C\u2018']([^"\u201C\u201D\u2018\u2019']{2,60})["\u201D\u2019']\s*$/);
      if (qm) { artist = qm[1].trim(); title = qm[2].trim(); src = 'quote'; }
    }

    const bare = title.replace(RX.anyBracket, ' ').replace(RX.spaces, ' ').trim() || title;
    return { title, artist, feats, bare, full: s, src, flags, handle };
  }

  function uploaderCore(up) {
    let s = deFancy(String(up || '')).replace(RX.emoji, ' ').replace(RX.stars, ' ');
    s = s.replace(/\b(archives?|leaks?|leaked|vault|snippets?|chronicles|world|central|hub|files|uploads?|exclusives?|unreleased|music|sounds?|audio|hq|team|gang|nation|updates?|access|cuts?|library|collection|page|fan\s*page|official)\b/gi, ' ');
    s = s.replace(RX.spaces, ' ').trim();
    return s.length >= 2 ? s : '';
  }

  function buildGuesses(meta) {
    const c = cleanTitle(meta.title);
    const upC = uploaderCore(meta.uploader);
    const up = deFancy(String(meta.uploader || '')).trim();
    const featStr = c.feats.join(' ');

    const titles = [c.title];
    if (normKey(c.bare) !== normKey(c.title)) titles.push(c.bare);
    if (c.full && !titles.some((t) => normKey(t) === normKey(c.full))) titles.push(c.full);

    const hints = [];
    const hint = (a, conf) => {
      a = (a || '').trim();
      if (!a) return;
      const k = normKey(a);
      if (!k || hints.some((h) => normKey(h.a) === k)) return;
      hints.push({ a, conf });
    };
    if (c.artist) hint(c.artist, c.src === 'parens' ? 0.8 : 1.0);
    if (c.handle) hint(c.handle, 0.85);   // "@HANDLE Title" uploads: the handle IS the artist
    // archive collabs: "Knzck x Hi-c" → individual artist hints too
    if (c.artist && /\s(?:x|&|,|\+|and)\s/i.test(c.artist)) {
      c.artist.split(/\s*(?:,|&|\+|\bx\b|\band\b)\s*/i)
        .map((p) => p.trim()).filter((p) => p.length > 1).slice(0, 3)
        .forEach((p) => hint(p, 0.75));
    }
    if (c.artist && featStr) hint(c.artist + ' ' + featStr, 0.85);
    c.feats.slice(0, 2).forEach((f) => hint(f, 0.55));
    hint(upC, 0.7);   // artists usually upload their own tracks — trust the uploader more
    if (normKey(up) !== normKey(upC)) hint(up, 0.5);
    if (c.artist) hint(c.title, 0.35);

    const Q = (arr, s, max) => {
      s = (s || '').replace(RX.spaces, ' ').trim().slice(0, 120);
      if (s.length > 2 && !arr.includes(s) && arr.length < max) arr.push(s);
    };
    const q0 = ((c.artist ? c.artist + ' ' : '') + c.title).trim();

    const lq = [];
    Q(lq, q0, 3);
    Q(lq, c.title + (upC ? ' ' + upC : ''), 3);

    const gq = [];
    Q(gq, q0, 3);
    Q(gq, featStr ? (c.artist ? c.artist + ' ' : '') + featStr + ' ' + c.title : c.bare, 3);

    const lq2 = [];
    Q(lq2, c.bare, 3);
    Q(lq2, c.title + ' ' + featStr, 3);
    Q(lq2, c.full, 3);
    const gq2 = [];
    Q(gq2, c.bare, 3);
    Q(gq2, c.title + (upC ? ' ' + upC : ''), 3);
    Q(gq2, c.full, 3);

    // parentheses-proof titles: uploads love "Something (Real Song Name)" and
    // "Song Name 2024" — bracket content gets its own shot at matching, and
    // stray year tags get a stripped variant. Junk/version brackets excluded.
    try {
      const bm = String(meta.title || '').match(/[\(\[]([^\)\]]{4,40})[\)\]]/);
      const inner = bm ? bm[1].trim() : '';
      if (inner && !VERSIONISH.test(inner)
          && !new RegExp('\\b(?:' + JUNK + ')\\b', 'i').test(inner)
          && !titles.some((t) => sameTitle(t, inner))) {
        titles.push(inner);
        const iq = ((c.artist || upC) ? (c.artist || upC) + ' ' : '') + inner;
        if (!lq2.some((x) => normKey(x) === normKey(inner))) lq2.unshift(inner.slice(0, 120));
        if (!gq2.some((x) => normKey(x) === normKey(iq))) gq2.unshift(iq.slice(0, 120));
      }
      const noYear = c.title.replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(RX.spaces, ' ').trim();
      if (noYear && normKey(noYear) !== normKey(c.title) && !titles.some((t) => sameTitle(t, noYear))) titles.push(noYear);
    } catch (e) {}

    return { titles, hints, lq, gq, lq2: lq2.filter((x) => !lq.includes(x)), gq2: gq2.filter((x) => !gq.includes(x)), vt: versionTags(meta.title), clean: c };
  }

  /* title-parser regression self-test — runs the LIVE cleanTitle against
   * real underground-SC patterns so it can never silently drift. A `t`
   * substring is matched against the parsed title, `a` against the artist
   * (both normalized); '' means "must be empty". */
  const TITLE_CASES = [
    { in: 'MajinBlxxdy - Walkin Lick (Prod. Plague)', a: 'majinblxxdy', t: 'walkin lick' },
    { in: 'Children of the Corn - Chronic Time', a: 'children of the corn', t: 'chronic time' },
    { in: 'SLYMM_MUDDYY_1 - SLY GOFF [PROD SPLURCETTI]', a: 'slymm muddyy 1', t: 'sly goff' },
    { in: 'Knzck x Hi-c (Drown)', t: 'drown' },
    { in: 'Demons Counting UP!', t: 'demons counting up' },
    { in: '@VAMPXXTAR666 ***I FW XANAX*** (no xanax remixx)', t: 'i fw xanax', h: 'vampxxtar666' },
    { in: 'Lil Tracy - Like A Farmer (CDQ)', a: 'lil tracy', t: 'like a farmer' },
    { in: 'artist — song (prod. by someone) [HQ]', a: 'artist', t: 'song' },
  ];
  function titleSelfTest() {
    const has = (got, want) => want === '' ? !got : normKey(got).indexOf(normKey(want)) !== -1;
    return TITLE_CASES.map((cse) => {
      let c, ok = true, why = [];
      try { c = cleanTitle(cse.in); } catch (e) { return { in: cse.in, ok: false, why: 'threw: ' + e.message }; }
      if (cse.t != null && !has(c.title, cse.t)) { ok = false; why.push('title="' + c.title + '" wanted~"' + cse.t + '"'); }
      if (cse.a != null && !has(c.artist, cse.a)) { ok = false; why.push('artist="' + c.artist + '" wanted~"' + cse.a + '"'); }
      if (cse.h != null && !has(c.handle || '', cse.h)) { ok = false; why.push('handle="' + (c.handle || '') + '" wanted~"' + cse.h + '"'); }
      return { in: cse.in, ok, why: why.join(' · ') };
    });
  }

  /* ------------------------------------------------------------------ *
   *  4. NETWORK — five providers + canonicalizers + VPN-proof Genius
   * ------------------------------------------------------------------ */

  // global request gate — VPN connections crawl when too many cold
  // connections open at once; cap concurrency and queue the rest
  const NetGate = (() => {
    let active = 0;
    const queue = [];
    const MAX = 10;  // v3.1: wave 1 fires every catalog at once — give it room
    const pump = () => {
      while (active < MAX && queue.length) { active++; queue.shift()(); }
    };
    return {
      run: (fn, deadlineMs) => new Promise((resolve, reject) => {
        queue.push(() => {
          let freed = false;
          const free = () => { if (!freed) { freed = true; active--; pump(); } };
          // a GM request that never fires ANY callback (unanswered @connect
          // prompt, extension bug) must not leak the slot — ten leaks would
          // silently deadlock all lyric networking until reload
          const guard = setTimeout(free, (deadlineMs || 5000) + 8000);
          fn().then(
            (v) => { clearTimeout(guard); free(); resolve(v); },
            (e) => { clearTimeout(guard); free(); reject(e); }
          );
        });
        pump();
      }),
    };
  })();

  const gmFetchRaw = (url, { timeout = 5000, headers = {} } = {}) => new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    try {
      GM_xmlhttpRequest({
        method: 'GET', url, headers, timeout,
        // never attach the user's cookies to third-party lyric hosts — a
        // logged-in Genius/Bing session must not be tied to lyric lookups
        anonymous: !/^https?:\/\/(?:[\w-]+\.)*soundcloud\.com\//.test(url),
        onload: (r) => (r.status >= 200 && r.status < 400)
          ? finish(resolve, r.responseText)
          : finish(reject, new Error('HTTP ' + r.status)),
        onerror: () => finish(reject, new Error('neterr')),
        ontimeout: () => finish(reject, new Error('timeout')),
      });
    } catch (e) { finish(reject, e); }
  });

  const gmFetch = (url, opts) => NetGate.run(() => gmFetchRaw(url, opts), (opts && opts.timeout) || 5000);

  const gmJSON = async (url, opts) => {
    const text = await gmFetch(url, opts);
    if (text && text.charCodeAt(0) === 60) throw new Error('html');
    return JSON.parse(text);
  };

  /* ── one api-v2 resolve per track, shared by the lyric search and the chapters (a miss is retried next time) ── */
  const trackJsonMemo = new Map();
  function trackJson(href) {
    if (!href) return Promise.resolve(null);
    const cid = SUITE.clientId ? SUITE.clientId() : null;
    if (!cid) return Promise.resolve(null);
    if (trackJsonMemo.has(href)) return trackJsonMemo.get(href);
    const p = gmJSON('https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent('https://soundcloud.com' + href) + '&client_id=' + encodeURIComponent(cid), { timeout: 6000 }).catch(() => null);
    trackJsonMemo.set(href, p);
    if (trackJsonMemo.size > 24) trackJsonMemo.delete(trackJsonMemo.keys().next().value);
    p.then((d) => { if (!d) trackJsonMemo.delete(href); });
    return p;
  }

  /* ── chapters: a mix's timestamped tracklist, read from its description, plus the listener's own cue points ──
   * DJ mixes and podcasts are a huge part of SoundCloud and the player does nothing for them: a
   * two-hour set is one flat waveform. Any description line carrying a m:ss or h:mm:ss stamp
   * ("12:33 The London (Dela Sur Remix) - Travis Scott", "01. Artist – Title [00:00]") becomes a
   * chapter; three or more make a list. Cue points are the listener's own markers on any track,
   * kept per track (up to 100 tracks). */
  const CUES_KEY = 'sl:cues';
  const Chapters = {
    href: '', list: [], descList: [], fromDesc: 0, onChange: null, _seq: 0,
    ts(t) { t = Math.max(0, Math.round(t)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0'); },
    parse(desc, dur) {
      const out = [];
      if (!desc) return out;
      const TS = '(?:(\\d{1,2}):)?(\\d{1,3}):(\\d{2})';
      const first = new RegExp('^(?:\\d{1,3}[.)]\\s*)?[\\[(]?' + TS + '[\\])]?\\s*[-–—:|.]*\\s*(.+?)\\s*$');
      const last = new RegExp('^(?:\\d{1,3}[.)]\\s*)?(.+?)\\s*[-–—|@(\\[]*\\s*[\\[(]?' + TS + '[\\])]?\\s*$');
      const toSec = (h, m, x) => (h ? +h * 3600 : 0) + (+m) * 60 + (+x);
      for (let ln of String(desc).split(/\r?\n/)) {
        ln = ln.replace(/^[\s\-–—•*·>#]+/, '').trim();
        if (!ln || /https?:\/\/|www\./i.test(ln)) continue;
        let m = first.exec(ln), t, name;
        if (m) { t = toSec(m[1], m[2], m[3]); name = m[4]; }
        else { m = last.exec(ln); if (!m) continue; name = m[1]; t = toSec(m[2], m[3], m[4]); }
        name = name.replace(/^[\s\-–—:|.]+|[\s\-–—:|(\[]+$/g, '').replace(/\s+/g, ' ');
        if (!name || name.length < 2 || !isFinite(t)) continue;
        if (dur > 0 && t > dur + 30) continue;
        out.push({ t, name: name.slice(0, 100), src: 'desc' });
      }
      if (out.length < 3) return [];
      out.sort((a, b) => a.t - b.t);
      const seen = new Set();
      return out.filter((c) => { if (seen.has(c.t)) return false; seen.add(c.t); return true; });
    },
    cues(href) { try { const all = GM_getValue(CUES_KEY, {}) || {}; const l = all[href]; return Array.isArray(l) ? l.filter((c) => c && isFinite(c.t)).map((c) => ({ t: +c.t, name: String(c.n || ''), src: 'cue' })) : []; } catch (e) { return []; } },
    saveCues(href, list) {
      try {
        const all = GM_getValue(CUES_KEY, {}) || {};
        if (list.length) all[href] = list.map((c) => ({ t: Math.round(c.t * 10) / 10, n: c.name })); else delete all[href];
        const keys = Object.keys(all); while (keys.length > 100) delete all[keys.shift()];
        GM_setValue(CUES_KEY, all);
      } catch (e) {}
    },
    rebuild() {
      const cues = this.href ? this.cues(this.href) : [];
      this.fromDesc = this.descList.length;
      this.list = this.descList.concat(cues).sort((a, b) => a.t - b.t);
      try { if (this.onChange) this.onChange(); } catch (e) {}
    },
    load(meta) {
      const href = (meta && meta.href) || '';
      const seq = ++this._seq;
      this.href = href; this.descList = []; this.rebuild();
      if (!href) return;
      trackJson(href).then((d) => {
        if (seq !== this._seq) return;
        const dur = (d && d.duration > 0) ? d.duration / 1000 : ((meta && meta.dur) || 0);
        this.descList = this.parse(d && d.description, dur);
        if (this.descList.length) this.rebuild();
      });
    },
    indexAt(t) { let i = -1; for (let k = 0; k < this.list.length; k++) { if (this.list[k].t <= t + 0.5) i = k; else break; } return i; },
    addCue(t, name) {
      if (!this.href) return null;
      const cues = this.cues(this.href).filter((c) => Math.abs(c.t - t) > 1);
      const nm = name || ('Cue ' + (cues.length + 1));
      cues.push({ t, name: nm, src: 'cue' }); cues.sort((a, b) => a.t - b.t);
      this.saveCues(this.href, cues); this.rebuild();
      return nm;
    },
    removeCue(t) { if (!this.href) return; this.saveCues(this.href, this.cues(this.href).filter((c) => Math.abs(c.t - t) > 0.05)); this.rebuild(); },
    renameCue(t, name) { if (!this.href) return; const cues = this.cues(this.href); for (const c of cues) if (Math.abs(c.t - t) <= 0.05) c.name = name; this.saveCues(this.href, cues); this.rebuild(); },
    tracklistText() { return this.list.map((c) => this.ts(c.t) + '  ' + c.name).join('\n'); },
  };

  /* ----- LRCLIB ----- */

  const LRC_HEADERS = { 'Lrclib-Client': 'SuperLyricsSC v4.0 (userscript)' };

  // LRCLIB rate-limit back-off. On a 429 we'd otherwise keep hammering and dig
  // ourselves deeper; the helper here parks the provider for 60s, gives the
  // user a one-time toast, and silently no-ops further calls until the window
  // expires. Retry-After header isn't surfaced by gmFetchRaw — a flat 60s
  // matches LRCLIB's published 100-req/min policy comfortably.
  let _lrcCooldownUntil = 0, _lrcCooldownToldAt = 0;
  const lrcCooldownActive = () => Date.now() < _lrcCooldownUntil;
  function lrcMarkRateLimited() {
    _lrcCooldownUntil = Date.now() + 60000;
    if (Date.now() - _lrcCooldownToldAt > 300000) {   // one toast per 5 min, not on every retry
      _lrcCooldownToldAt = Date.now();
      try { UI.toast('LRCLIB rate-limited — paused for 60s'); } catch (e) {}
    }
  }
  function lrcHandleErr(e) {
    if (e && /HTTP 429/.test(String(e.message || e))) lrcMarkRateLimited();
  }

  const lrcItem = (it, rank) => ({
    src: 'lrclib', id: 'l' + it.id, rank,
    t: it.trackName || '', a: it.artistName || '',
    dur: it.duration || 0,
    synced: !!(it.syncedLyrics && it.syncedLyrics.trim()),
    syncedRaw: it.syncedLyrics || '',
    plain: it.plainLyrics || '',
    instrumental: !!it.instrumental,
  });

  async function lrcSearch({ track, artist, q }) {
    if (lrcCooldownActive()) return { songs: [] };
    const u = new URL('https://lrclib.net/api/search');
    if (q) u.searchParams.set('q', q);
    else {
      u.searchParams.set('track_name', track || '');
      if (artist) u.searchParams.set('artist_name', artist);
    }
    try {
      const arr = await gmJSON(u.toString(), { headers: LRC_HEADERS, timeout: 7000 });
      if (!Array.isArray(arr)) return { songs: [] };
      return { songs: arr.slice(0, 12).map(lrcItem) };
    } catch (e) { lrcHandleErr(e); throw e; }
  }

  async function lrcGet({ track, artist, album, dur }) {
    if (lrcCooldownActive()) return { songs: [] };
    try {
      const u = new URL('https://lrclib.net/api/get');
      u.searchParams.set('track_name', track || '');
      u.searchParams.set('artist_name', artist || '');
      if (album) u.searchParams.set('album_name', album);
      if (dur > 0) u.searchParams.set('duration', String(Math.round(dur)));
      const it = await gmJSON(u.toString(), { headers: LRC_HEADERS, timeout: 7000 });
      return { songs: it && it.id ? [lrcItem(it, 0)] : [] };
    } catch (e) {
      lrcHandleErr(e);
      if (/HTTP 404/.test(String(e && e.message))) return { songs: [] };   // "no exact match" is an answer, not a failure
      throw e;
    }
  }

  /* ----- LRCLIB PUBLISH — contribute lyrics back so this track (and your
   * whole underground scene) is findable next time. Opt-in only. LRCLIB
   * gates writes with a small proof-of-work: fetch a challenge, then find a
   * nonce whose SHA-256 is under the target. ----- */
  function gmPostJSON(url, bodyObj, headers) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url, timeout: 12000, anonymous: true,
          headers: Object.assign({ 'Content-Type': 'application/json' }, LRC_HEADERS, headers || {}),
          data: bodyObj == null ? '' : JSON.stringify(bodyObj),
          onload: (r) => resolve({ status: r.status, text: r.responseText }),
          onerror: () => reject(new Error('neterr')),
          ontimeout: () => reject(new Error('timeout')),
        });
      } catch (e) { reject(e); }
    });
  }
  const _hexToBytes = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const _lt = (a, b) => { for (let i = 0; i < a.length && i < b.length; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; } return false; };
  // LRCLIB's challenge needs ~2^24 hashes: awaited WebCrypto digests manage ~30k/s on the page thread,
  // a pure-JS SHA-256 in a worker ~600k/s per core, so the search runs off-thread on a few cores
  const POW_WORKER_SRC = ''
  + 'const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);'
  + 'const W=new Uint32Array(64);const H=new Uint32Array(8);'
  + 'function sha256(b){const n=b.length;const p=((n+9+63)>>6)<<6;const m=new Uint8Array(p);m.set(b);m[n]=0x80;'
  + 'const bits=n*8;m[p-4]=bits>>>24;m[p-3]=(bits>>>16)&255;m[p-2]=(bits>>>8)&255;m[p-1]=bits&255;'
  + 'H[0]=0x6a09e667;H[1]=0xbb67ae85;H[2]=0x3c6ef372;H[3]=0xa54ff53a;H[4]=0x510e527f;H[5]=0x9b05688c;H[6]=0x1f83d9ab;H[7]=0x5be0cd19;'
  + 'for(let o=0;o<p;o+=64){for(let i=0;i<16;i++)W[i]=(m[o+i*4]<<24)|(m[o+i*4+1]<<16)|(m[o+i*4+2]<<8)|m[o+i*4+3];'
  + 'for(let i=16;i<64;i++){const x=W[i-15],y=W[i-2];const s0=((x>>>7)|(x<<25))^((x>>>18)|(x<<14))^(x>>>3);const s1=((y>>>17)|(y<<15))^((y>>>19)|(y<<13))^(y>>>10);W[i]=(W[i-16]+s0+W[i-7]+s1)|0}'
  + 'let a=H[0],c=H[1],d=H[2],e=H[3],f=H[4],g=H[5],h=H[6],k=H[7];'
  + 'for(let i=0;i<64;i++){const S1=((f>>>6)|(f<<26))^((f>>>11)|(f<<21))^((f>>>25)|(f<<7));const ch=(f&g)^(~f&h);const t1=(k+S1+ch+K[i]+W[i])|0;'
  + 'const S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));const mj=(a&c)^(a&d)^(c&d);const t2=(S0+mj)|0;'
  + 'k=h;h=g;g=f;f=(e+t1)|0;e=d;d=c;c=a;a=(t1+t2)|0}'
  + 'H[0]=(H[0]+a)|0;H[1]=(H[1]+c)|0;H[2]=(H[2]+d)|0;H[3]=(H[3]+e)|0;H[4]=(H[4]+f)|0;H[5]=(H[5]+g)|0;H[6]=(H[6]+h)|0;H[7]=(H[7]+k)|0}'
  + 'const out=new Uint8Array(32);for(let i=0;i<8;i++){out[i*4]=H[i]>>>24;out[i*4+1]=(H[i]>>>16)&255;out[i*4+2]=(H[i]>>>8)&255;out[i*4+3]=H[i]&255}return out}'
  + 'onmessage=e=>{const d=e.data;const enc=new TextEncoder();const t=d.target;for(let n=d.from;n<d.to;n++){const h=sha256(enc.encode(d.prefix+n));'
  + 'let lt=false;for(let i=0;i<32;i++){if(h[i]<t[i]){lt=true;break}if(h[i]>t[i])break}if(lt){postMessage({found:n});return}}postMessage({done:d.to})};';
  function lrclibSolve(prefix, targetHex, deadline) {
    const target = _hexToBytes(targetHex);
    const fallback = async () => {   // no Worker / Blob URL: the slow path, still correct
      const enc = new TextEncoder();
      for (let nonce = 0; nonce < 20000000; nonce++) {
        const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(prefix + nonce)));
        if (_lt(h, target)) return prefix + ':' + nonce;
        if ((nonce & 2047) === 0 && Date.now() > deadline) throw new Error('pow timeout');
      }
      throw new Error('pow exhausted');
    };
    if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL === 'undefined' || !URL.createObjectURL) return fallback();
    return new Promise((resolve, reject) => {
      const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency | 0) || 2));
      const CHUNK = 200000;
      let url = null, workers = [], next = 0, settled = false, timer = 0;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        for (const w of workers) { try { w.terminate(); } catch (e) {} }
        workers = [];
        if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
        if (fn) fn(v);
      };
      const feed = (w) => {
        const from = next; next += CHUNK;
        if (from >= 80000000) { finish(reject, new Error('pow exhausted')); return; }
        w.postMessage({ prefix, target, from, to: from + CHUNK });
      };
      try {
        url = URL.createObjectURL(new Blob([POW_WORKER_SRC], { type: 'text/javascript' }));
        for (let i = 0; i < threads; i++) {
          const w = new Worker(url);
          w.onmessage = (e) => { const d = e.data || {}; if (d.found != null) finish(resolve, prefix + ':' + d.found); else feed(w); };
          w.onerror = () => { finish(null, null); fallback().then(resolve, reject); };
          workers.push(w); feed(w);
        }
        timer = setTimeout(() => finish(reject, new Error('pow timeout')), Math.max(1000, deadline - Date.now()));
      } catch (e) { finish(null, null); fallback().then(resolve, reject); }
    });
  }
  async function lrclibPublish(meta) {
    // meta: { track, artist, album, duration, plain, synced }
    const ch = await gmPostJSON('https://lrclib.net/api/request-challenge', null);
    if (ch.status < 200 || ch.status >= 300) throw new Error('challenge ' + ch.status);
    const c = JSON.parse(ch.text);
    if (!c || !c.prefix || !c.target) throw new Error('bad challenge');
    const token = await lrclibSolve(c.prefix, c.target, Date.now() + 240000);   // a few minutes on a slow machine is fine: it runs off-thread
    const res = await gmPostJSON('https://lrclib.net/api/publish', {
      trackName: meta.track || '', artistName: meta.artist || '', albumName: meta.album || meta.track || '',
      duration: Math.round(meta.duration || 0), plainLyrics: meta.plain || '', syncedLyrics: meta.synced || '',
    }, { 'X-Publish-Token': token });
    if (res.status === 201 || res.status === 200) return true;
    throw new Error('publish ' + res.status + (res.text ? ' ' + res.text.slice(0, 80) : ''));
  }

  /* ----- GENIUS (direct + VPN-proof proxy route) ----- */

  // mode persists across sessions; 'proxy' auto-expires after 24h so direct gets retried
  const Gmode = (() => {
    let mode = 'direct';
    try {
      const s = GM_getValue('sl:gmode', null);
      if (s && s.m === 'proxy' && Date.now() - s.ts < 86400000) mode = 'proxy';
    } catch (e) {}
    return {
      get: () => mode,
      set(m) {
        if (mode === m) return;
        mode = m;
        try { GM_setValue('sl:gmode', { m, ts: Date.now() }); } catch (e) {}
      },
    };
  })();

  /* R17 · STRICT-PRIVACY toggle. Off by default (otherwise VPN/Cloudflare-blocked
   * users would silently lose lyric pages for newer tracks not yet on Wayback).
   * When ON, the codetabs + allorigins mirrors are skipped — only direct +
   * Wayback (Internet Archive, non-commercial) are used. The extension's
   * background worker fetches genius.com directly with host_permissions, so
   * for most users direct works and proxies are never hit. */
  const Strict = (() => {
    let on = false; try { on = !!GM_getValue('sl:strict', 0); } catch (e) {}
    return {
      get: () => on,
      set(v) { on = !!v; try { GM_setValue('sl:strict', on ? 1 : 0); } catch (e) {} },
      toggle() { this.set(!on); return on; },
    };
  })();

  const GH = { ok: 0, bad: 0 };

  const gHit = (r, rank) => ({
    src: 'genius', id: 'g' + r.id, rank,
    url: r.url,
    t: r.title || '', tf: r.title_with_featured || r.title || '',
    a: (r.primary_artist && r.primary_artist.name) || '',
    an: r.artist_names || '',
    img: r.song_art_image_thumbnail_url || '',
    dur: 0,
  });

  function parseGeniusSearch(j) {
    const songs = [], lyricHits = [];
    const resp = j && j.response;
    if (!resp) return { songs, lyricHits };
    const sections = resp.sections || (resp.hits ? [{ type: 'song', hits: resp.hits }] : []);
    const seen = new Set();
    for (const sec of sections) {
      const type = sec.type || 'song';
      if (type !== 'song' && type !== 'lyric' && type !== 'top_hit') continue;
      let i = 0;
      for (const h of sec.hits || []) {
        const r = h.result;
        if (!r || (h.type && h.type !== 'song') || (r._type && r._type !== 'song')) continue;
        if (r.lyrics_state && r.lyrics_state !== 'complete') continue;
        if (seen.has(r.id)) { i++; continue; }
        seen.add(r.id);
        const hit = gHit(r, i++);
        (type === 'lyric' ? lyricHits : songs).push(hit);
      }
    }
    return { songs, lyricHits };
  }

  const G_HEADERS = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

  const gWrap = async (url) => {
    try {
      const j = await gmJSON(url, { headers: G_HEADERS, timeout: 9000 });
      GH.ok++;
      if (Gmode.get() === 'proxy') Gmode.set('direct'); // direct access recovered
      return parseGeniusSearch(j);
    } catch (e) {
      GH.bad++;
      if (GH.ok === 0 && GH.bad >= 2) Gmode.set('proxy'); // Cloudflare is blocking us
      throw e;
    }
  };

  // session memo for search calls — retries & repeats cost zero network
  const SearchMemo = (() => {
    const m = new Map(); const TTL = 30 * 60 * 1000;
    return {
      wrap(prefix, q, fn) {
        const k = prefix + ':' + normKey(q);
        const e = m.get(k);
        if (e && Date.now() - e.t < TTL) return Promise.resolve(e.v);
        return fn().then((v) => {
          if (v && v.songs && v.songs.length) { if (m.size > 200) m.clear(); m.set(k, { v, t: Date.now() }); }
          return v;
        });
      },
    };
  })();

  const geniusMulti = (q) => SearchMemo.wrap('gm', q, () => gWrap('https://genius.com/api/search/multi?per_page=5&q=' + encodeURIComponent(q)));
  const geniusSong = (q) => SearchMemo.wrap('gs', q, () => gWrap('https://genius.com/api/search/song?per_page=10&q=' + encodeURIComponent(q)));
  const geniusLegacy = (q) => gWrap('https://genius.com/api/search?q=' + encodeURIComponent(q));

  /* ── Official Genius API (api.genius.com) — needs a free Client Access
   * Token (genius.com/api-clients). On networks where Cloudflare 403s the
   * unofficial genius.com/api routes AND the web-search fallbacks are
   * blocked, this is the RELIABLE way to find the right song + its page URL.
   * The lyrics page itself is still fetched the usual way (direct → Wayback /
   * mirror), because Genius's API deliberately doesn't return lyric text. */
  // built-in default Genius token. SOURCE is intentionally BLANK so this file
  // is always safe to publish (greasyfork, CWS, gists). Local extension builds
  // inject the owner's personal token from tools/dev-token.txt via build.sh —
  // see that file's `--public` flag which enforces blank-and-fail for releases.
  // A user-set token via the ⋯ menu always overrides whatever's here.
  const GTOK_DEFAULT = '';
  const Gtok = (() => {
    let t = '';
    try { t = GM_getValue('sl:gtok', '') || ''; } catch (e) {}
    if (!t) t = GTOK_DEFAULT;   // nothing stored → use the baked-in default
    return {
      get: () => t,
      has: () => !!t,
      set(v) { t = String(v || '').trim() || GTOK_DEFAULT; try { GM_setValue('sl:gtok', String(v || '').trim()); } catch (e) {} },
    };
  })();
  /* collective / uploader → real-artist alias map (user-taught). Keyed by a
   * normalized name; resolves a whole crew once you correct one track. */
  const Aliases = (() => {
    let m = {};
    try { m = GM_getValue('sl:aliases', {}) || {}; } catch (e) {}
    return {
      for(name) { const k = normKey(name || ''); return (k && Array.isArray(m[k])) ? m[k] : []; },
      add(name, artist) {
        const k = normKey(name || ''); artist = String(artist || '').trim();
        if (!k || !artist) return;
        const a = (Object.prototype.hasOwnProperty.call(m, k) && Array.isArray(m[k])) ? m[k] : [];   // "constructor" etc. must not hit the prototype
        if (!a.some((x) => normKey(x) === normKey(artist))) a.push(artist);
        m[k] = a.slice(0, 6);
        const keys = Object.keys(m);
        if (keys.length > 400) delete m[keys[0]];   // bound the persisted map — drop the oldest alias key
        try { GM_setValue('sl:aliases', m); } catch (e) {}
      },
    };
  })();

  const geniusApiSearch = (q) => {
    if (!Gtok.has() || !q) return Promise.resolve({ songs: [] });
    return SearchMemo.wrap('ga', q, async () => {
      try {
        const j = await gmJSON('https://api.genius.com/search?q=' + encodeURIComponent(q),
          { headers: { Authorization: 'Bearer ' + Gtok.get(), Accept: 'application/json' }, timeout: 8000 });
        const r = parseGeniusSearch(j);
        if (r.songs.length) { GH.ok++; if (Gmode.get() === 'proxy') Gmode.set('direct'); }
        return r;
      } catch (e) { return { songs: [] }; }
    });
  };

  // shared parser for web-search results that point at genius.com lyric pages
  function webGeniusHit(out, hrefRaw, innerHtml) {
    if (out.length >= 6) return;
    let href = String(hrefRaw || '').replace(/&amp;/g, '&');
    const ud = href.match(/[?&](?:uddg|u)=([^&]+)/);
    if (ud) {
      let v = ud[1];
      try { v = decodeURIComponent(v); } catch (e) {}
      // Bing wraps every organic result as /ck/a?…&u=a1<base64url of the real URL>
      if (/^a1[A-Za-z0-9_-]+$/.test(v)) { try { v = atob(v.slice(2).replace(/-/g, '+').replace(/_/g, '/')); } catch (e) {} }
      href = v;
    }
    if (!/^https?:\/\/(?:www\.)?genius\.com\/(?!api|albums|artists|search)[^\s"']+/i.test(href)) return;
    if (!/-lyrics(?:$|[/?#])/i.test(href)) return;
    // translation/romanization pages match the title perfectly but carry the
    // wrong-language lyrics — exactly what we don't want from a web fallback
    if (/\/genius-[a-z-]*(?:translations?|romanizations?)-/i.test(href)) return;
    const clean = href.split('?')[0].split('#')[0];
    if (out.some((o) => o.url === clean)) return;
    let title = String(innerHtml || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')
      .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim();
    title = title.replace(/\s*[\|\-–]\s*Genius.*$/i, '').replace(/\s+Lyrics\s*$/i, '');
    let a = '', t = title;
    const sp = title.split(/\s+[–—]\s+|\s+-\s+/);
    if (sp.length >= 2) { a = sp[0].trim(); t = sp.slice(1).join(' - ').trim(); }
    if (!t) return;
    out.push({ src: 'genius', id: 'gw' + out.length + ':' + clean.slice(-24), url: clean, t, a, an: a, rank: out.length, img: '', dur: 0 });
  }

  // web search route 1: DuckDuckGo HTML — finds pages the way a browser
  // search does, spelling variants included. VPN IPs sometimes get an
  // "anomaly" block page; that's detected and Bing takes over.
  async function ddgGeniusSearch(q) {
    const html = await gmFetch('https://html.duckduckgo.com/html/?q='
      + encodeURIComponent('site:genius.com ' + q), { timeout: 8000 });
    if (/anomaly-modal|anomaly_modal|If this error persists|unfortunately, bots use DuckDuckGo too/i.test(html)) {
      throw new Error('ddg-blocked');
    }
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html))) webGeniusHit(out, m[1], m[2]);
    if (!out.length) {
      const re2 = /<a[^>]+href="((?:[^"]*uddg=[^"]+|https?:\/\/(?:www\.)?genius\.com\/[^"]+))"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re2.exec(html))) webGeniusHit(out, m[1], m[2]);
    }
    return { songs: out };
  }

  // web search route 2: Bing HTML — very tolerant of VPN traffic
  async function bingGeniusSearch(q) {
    const html = await gmFetch('https://www.bing.com/search?q='
      + encodeURIComponent('site:genius.com ' + q) + '&count=10', { timeout: 8000 });
    const out = [];
    let m;
    const re = /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = re.exec(html))) webGeniusHit(out, m[1], m[2]);
    if (!out.length) {   // the first anchor in a result is often Bing's site-link, whose text is a URL — a last resort only
      const re0 = /<li class="b_algo"[\s\S]{0,400}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re0.exec(html))) webGeniusHit(out, m[1], m[2]);
    }
    if (!out.length) {
      const re2 = /<a[^>]+href="(https?:\/\/(?:www\.)?genius\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re2.exec(html))) webGeniusHit(out, m[1], m[2]);
    }
    return { songs: out };
  }

  // web search route 3: Mojeek HTML — independent index, no bot walls
  async function mojeekGeniusSearch(q) {
    const html = await gmFetch('https://www.mojeek.com/search?q='
      + encodeURIComponent('site:genius.com ' + q), { timeout: 8000 });
    const out = [];
    let m;
    const re = /<a[^>]+class="title"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = re.exec(html))) webGeniusHit(out, m[1], m[2]);
    if (!out.length) {
      const re2 = /<a[^>]+href="(https?:\/\/(?:www\.)?genius\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re2.exec(html))) webGeniusHit(out, m[1], m[2]);
    }
    return { songs: out };
  }

  // one call = best effort across the engines. DDG leads, but Bing joins the
  // race after a 2.5s head start (or instantly when DDG fails/comes back
  // empty) — a slow DDG no longer costs 8s before anything else moves.
  // Mojeek stays the quiet last resort.
  /* dead-route memory: an engine that's blocked/empty on THIS connection
   * (DuckDuckGo's anomaly wall, Bing returning nothing) gets skipped after a
   * few strikes so every search doesn't pay its stagger. Re-probed every 6h. */
  const WebRoutes = (() => {
    let s = {};
    try { s = GM_getValue('sl:webdead', {}) || {}; } catch (e) {}
    const TTL = 6 * 3600000;
    const save = () => { try { GM_setValue('sl:webdead', s); } catch (e) {} };
    return {
      dead: (k) => { const e = s[k]; return !!(e && e.n >= 3 && Date.now() - e.t < TTL); },
      fail(k) { const e = s[k] || { n: 0, t: 0 }; e.n = Math.min(e.n + 1, 9); e.t = Date.now(); s[k] = e; save(); },
      ok(k) { if (s[k] && s[k].n) { s[k].n = 0; save(); } },
    };
  })();

  const webSearch = (q) => SearchMemo.wrap('ws', q, () => new Promise((resolve, reject) => {
    let done = false, inflight = 0, idx = 0;
    let timer = null;
    let engines = [
      { k: 'ddg', fn: ddgGeniusSearch },
      { k: 'bing', fn: bingGeniusSearch },
      { k: 'mojeek', fn: mojeekGeniusSearch },
    ].filter((e) => !WebRoutes.dead(e.k));
    if (!engines.length) engines = [{ k: 'mojeek', fn: mojeekGeniusSearch }];   // never abandon entirely
    const ok = (r) => {
      if (!done && r && r.songs && r.songs.length) { done = true; if (timer) timer.stop(); resolve(r); }
    };
    const settle = () => {
      if (done || inflight > 0) return;
      if (idx < engines.length) { launchNext(); return; }
      done = true; if (timer) timer.stop(); reject(new Error('empty'));
    };
    const launch = (e) => {
      inflight++;
      e.fn(q).then(
        (r) => { inflight--; if (r && r.songs && r.songs.length) WebRoutes.ok(e.k); ok(r); settle(); },   // an empty (but successful) search is not an outage
        () => { inflight--; WebRoutes.fail(e.k); settle(); });
    };
    const launchNext = () => { if (idx < engines.length && !done) launch(engines[idx++]); };
    launchNext();                                  // first reachable engine now
    if (engines.length > 1) timer = Ticker.after(launchNext, 2500);   // next joins after a head start
  }));

  // lyric page → lines
  function parseGeniusHtml(html) {
    if (/just a moment|cf-chl|challenge-platform/i.test(html.slice(0, 3000))) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let containers = doc.querySelectorAll('[data-lyrics-container="true"]');
    if (!containers.length) containers = doc.querySelectorAll('.lyrics, .Lyrics__Container');
    if (!containers.length) return null;
    const chunks = [];
    containers.forEach((c) => {
      c.querySelectorAll('[data-exclude-from-selection], [class*="LyricsHeader"], [class*="SongHeader"], [class*="InreadAd"], [class*="RightSidebar"]').forEach((n) => n.remove());
      c.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      chunks.push(c.textContent || '');
    });
    return chunks.join('\n');
  }

  function tidyLyricLines(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l, i, arr) => {
      if (/^\d*\s*Embed$/i.test(l)) return false;
      if (/^you might also like$/i.test(l)) return false;
      if (/^see .{0,60}live$/i.test(l)) return false;
      if (/^get tickets as low as/i.test(l)) return false;
      if (/^\d+\s*Contributors?/i.test(l)) return false;
      if (/^Translations?$/i.test(l)) return false;
      if (l === '' && arr[i - 1] === '') return false;
      return true;
    });
    while (lines.length && lines[0] === '') lines.shift();
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.length ? lines : null;
  }

  const BodyCache = new Map(); // key → Promise<body|null>
  const PB_IDX = 'pb:idx';
  function pbRemember(key, v) {
    try {
      const ok = (Array.isArray(v) && v.length) || (typeof v === 'string' && v.length > 40);
      if (!ok) return;
      GM_setValue('pb:' + key, v);
      let idx = GM_getValue(PB_IDX, []).filter((k) => k !== key);
      idx.push(key);
      while (idx.length > 60) { GM_deleteValue('pb:' + idx.shift()); }   // bodies are fat; lyric entries matter more
      GM_setValue(PB_IDX, idx);
    } catch (e) {}
  }
  function cachedBody(key, fn) {
    if (BodyCache.has(key)) return BodyCache.get(key);
    let stored = null;
    try { stored = GM_getValue('pb:' + key, null); } catch (e) {}
    if (stored != null) {
      const p0 = Promise.resolve(stored);
      BodyCache.set(key, p0);
      return p0;
    }
    const p = fn();
    // a null body (every route failed) must not be remembered for the session —
    // the next search for this track should get another go at it
    p.then((v) => { if (v == null) BodyCache.delete(key); else pbRemember(key, v); }).catch(() => BodyCache.delete(key));
    if (BodyCache.size >= 40) { const k = BodyCache.keys().next().value; BodyCache.delete(k); }
    BodyCache.set(key, p);
    return p;
  }

  const firstOk = (proms) => new Promise((res) => {
    let pending = proms.length;
    if (!pending) return res(null);
    proms.forEach((p) => p
      .then((v) => { if (v && v.length) res(v); else if (--pending === 0) res(null); })
      .catch(() => { if (--pending === 0) res(null); }));
  });

  function geniusLyrics(pageUrl) {
    return cachedBody('g:' + pageUrl, async () => {
      const viaHtml = (html) => { const t = parseGeniusHtml(html); return t ? tidyLyricLines(t) : null; };
      const direct = async () => {
        try {
          const html = await gmFetch(pageUrl, { timeout: 10000 });
          const r = viaHtml(html);
          if (r) { GH.ok++; if (Gmode.get() === 'proxy') Gmode.set('direct'); return r; }
          GH.bad++; if (GH.ok === 0 && GH.bad >= 2) Gmode.set('proxy');
          return null;
        } catch (e) {
          GH.bad++; if (GH.ok === 0 && GH.bad >= 2) Gmode.set('proxy');
          return null;
        }
      };
      // mirrors fetch genius.com from OTHER servers — Cloudflare never sees this device.
      // R17: Wayback (Internet Archive, non-commercial) is always used; the two
      // commercial proxies (codetabs/allorigins) drop out in strict-privacy mode.
      let wbP = null;   // one Wayback round trip per page, shared by the proxy race and the mirror fallback
      const wayback = () => wbP || (wbP = gmFetch('https://web.archive.org/web/2id_/' + pageUrl, { timeout: 14000 }).then(viaHtml).catch(() => null));
      const mirrors = () => {
        const list = [wayback()];
        if (!Strict.get()) {
          list.push(
            gmFetch('https://api.codetabs.com/v1/proxy?quest=' + pageUrl, { timeout: 10000 }).then(viaHtml).catch(() => null),
            gmFetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(pageUrl), { timeout: 10000 }).then(viaHtml).catch(() => null),
          );
        }
        return firstOk(list);
      };
      if (Gmode.get() === 'direct') {
        const r = await direct();
        if (r) return r;
        return await mirrors();
      }
      const r = await firstOk([direct(), wayback()]);
      if (r) return r;
      return await mirrors();
    });
  }

  /* ----- KUGOU (synced LRC, huge catalog, keyless) ----- */

  async function kugouSearch(q, durSec) {
    const path = 'krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=' + encodeURIComponent(q)
      + '&duration=' + (durSec > 0 ? Math.round(durSec * 1000) : '') + '&hash=';
    // https only — a cleartext fallback would put song titles on the wire
    const j = await gmJSON('https://' + path, { timeout: 8000 });
    const cands = (j && j.candidates) || [];
    return {
      songs: cands.slice(0, 6).map((c, i) => ({
        src: 'kugou', id: 'k' + c.id, kid: c.id, kkey: c.accesskey, rank: i,
        t: String(c.song || '').trim(), a: String(c.singer || '').trim(), an: String(c.singer || ''),
        dur: Math.round((c.duration || 0) / 1000), img: '',
      })),
    };
  }

  function kugouLyric(kid, kkey) {
    return cachedBody('k:' + kid, async () => {
      const path = 'lyrics.kugou.com/download?ver=1&client=pc&id=' + kid
        + '&accesskey=' + encodeURIComponent(kkey || '') + '&fmt=lrc&charset=utf8';
      const j = await gmJSON('https://' + path, { timeout: 8000 });
      if (!j || !j.content) return null;
      let raw = '';
      try { raw = atob(j.content); } catch (e) { return null; }
      try { raw = decodeURIComponent(escape(raw)); } catch (e) {}
      return raw && raw.trim() ? raw : null;
    });
  }

  /* ----- NETEASE (synced LRC, huge catalog incl. Western, keyless) ----- */

  async function neteaseSearch(q, durSec) {
    const j = await gmJSON('https://music.163.com/api/search/get?s=' + encodeURIComponent(q)
      + '&type=1&limit=6&offset=0', { timeout: 8000 });
    const songs = (j && j.result && j.result.songs) || [];
    return {
      songs: songs.map((s, i) => {
        const arts = s.artists || s.ar || [];
        return {
          src: 'netease', id: 'n' + s.id, nid: s.id, rank: i,
          t: String(s.name || '').trim(),
          a: (arts[0] && arts[0].name) || '',
          an: arts.map(a => a && a.name).filter(Boolean).join(', '),
          dur: Math.round((s.duration || s.dt || 0) / 1000), img: '',
        };
      }),
    };
  }

  function neteaseLyric(nid) {
    return cachedBody('n:' + nid, async () => {
      // os=pc matters: without it this endpoint refuses many clients —
      // the diagnostics trail showed search working but every body failing
      try {
        const j = await gmJSON('https://music.163.com/api/song/lyric?os=pc&id=' + nid + '&lv=-1&kv=-1&tv=-1', { timeout: 8000 });
        const raw = j && j.lrc && j.lrc.lyric;
        if (raw && raw.trim()) return raw;
      } catch (e) {}
      // second door: the legacy media endpoint serves the same LRC and
      // answers from networks the lyric API refuses outright
      const j2 = await gmJSON('https://music.163.com/api/song/media?id=' + nid, { timeout: 8000 });
      const raw2 = j2 && j2.lyric;
      return raw2 && raw2.trim() ? raw2 : null;
    });
  }

  /* ----- MUSIXMATCH (synced + text, auto token) ----- */

  const MXM = (() => {
    let token = '';
    try {
      token = GM_getValue('sl:mxmtok', '') || '';
      // the endpoint hands some networks a token of all zeros that "works" but answers every query with the
      // same unrelated song; and any token older than a week is not worth trusting
      const ts = +GM_getValue('sl:mxmtokts', 0) || 0;
      if (/^0+$/.test(token) || (token && Date.now() - ts > 7 * 86400000)) { token = ''; GM_setValue('sl:mxmtok', ''); }
    } catch (e) {}
    // 'dead' (UpgradeOnly token) expires after 6h instead of poisoning every
    // future session — stale unofficial tokens are the steady state here
    let dead = false;
    try { const dts = GM_getValue('sl:mxmdead', 0); dead = !!dts && Date.now() - dts < 6 * 3600000; } catch (e) {}
    const markDead = () => { dead = true; try { GM_setValue('sl:mxmdead', Date.now()); } catch (e) {} };

    async function getToken() {
      if (token) return token;
      if (dead) throw new Error('mxm');
      const j = await gmJSON('https://apic-desktop.musixmatch.com/ws/1.1/token.get?app_id=web-desktop-app-v1.0&t=' + Date.now(), { timeout: 7000 });
      const t = j && j.message && j.message.body && j.message.body.user_token;
      if (!t || /UpgradeOnly/.test(t) || /^0+$/.test(t)) { markDead(); throw new Error('mxm'); }
      token = t;
      try { GM_setValue('sl:mxmtok', t); GM_setValue('sl:mxmtokts', Date.now()); } catch (e) {}
      return t;
    }

    async function query(artist, track, dur) {
      const tok = await getToken();
      const u = new URL('https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get');
      u.searchParams.set('format', 'json');
      u.searchParams.set('namespace', 'lyrics_richsynched');
      u.searchParams.set('subtitle_format', 'lrc');
      u.searchParams.set('app_id', 'web-desktop-app-v1.0');
      u.searchParams.set('usertoken', tok);
      u.searchParams.set('q_artist', artist || '');
      u.searchParams.set('q_track', track || '');
      if (dur > 0) {
        u.searchParams.set('q_duration', String(Math.round(dur)));
        u.searchParams.set('f_subtitle_length', String(Math.round(dur)));
        u.searchParams.set('f_subtitle_length_max_deviation', '4');
      }
      const j = await gmJSON(u.toString(), { timeout: 8000 });
      const hdr = j && j.message && j.message.header;
      if (hdr && (hdr.status_code === 401 || hdr.hint === 'renew')) {
        token = '';
        try { GM_setValue('sl:mxmtok', ''); } catch (e) {}
        throw new Error('mxm401');
      }
      return j;
    }

    function parse(j) {
      const mc = j && j.message && j.message.body && j.message.body.macro_calls;
      if (!mc) return { songs: [] };
      const trMsg = mc['matcher.track.get'];
      const tr = trMsg && trMsg.message && trMsg.message.body && trMsg.message.body.track;
      if (!tr) return { songs: [] };
      let syncedRaw = '', plain = '', wt = null;
      const subBody = mc['track.subtitles.get'] && mc['track.subtitles.get'].message && mc['track.subtitles.get'].message.body;
      const sl = subBody && subBody.subtitle_list && subBody.subtitle_list[0] && subBody.subtitle_list[0].subtitle;
      if (sl && sl.subtitle_body) syncedRaw = sl.subtitle_body;
      // richsync = Musixmatch's WORD-LEVEL timing. When present it is the most
      // accurate source, so we make it BOTH the line-level LRC and the word map,
      // built from the SAME segments — that guarantees the word map's keys line
      // up with the rendered lines (separate plain subtitles can carry slightly
      // different timestamps, which would silently miss). wt =
      // { <centisec-of-line-start> : { e:<lineEndSec|null>, w:[[<wordStartSec>,<charLen>],…] } },
      // keyed by TIME so it survives LRC sort/dedup/filtering and the lyric
      // cache, and simply no-ops (keys don't match) for scaled / estimated lines.
      try {
        const rsBody = mc['track.richsync.get'] && mc['track.richsync.get'].message && mc['track.richsync.get'].message.body;
        const rs = rsBody && rsBody.richsync && rsBody.richsync.richsync_body;
        if (rs) {
          const arr = JSON.parse(rs);
          if (Array.isArray(arr)) {
            const fmt = (t) => {
              const cs = Math.max(0, Math.round((+t || 0) * 100));
              return '[' + String(Math.floor(cs / 6000)).padStart(2, '0') + ':'
                + String(Math.floor((cs % 6000) / 100)).padStart(2, '0') + '.'
                + String(cs % 100).padStart(2, '0') + ']';
            };
            const wmap = {};
            const ls = [];
            for (const seg of arr) {
              if (!seg) continue;
              const ts = +seg.ts || 0;
              const segTxt = String(seg.x != null ? seg.x : (seg.l || []).map((w) => (w && w.c) || '').join('')).trim();
              if (!segTxt) continue;
              ls.push(fmt(ts) + segTxt);
              if (Array.isArray(seg.l) && seg.l.length) {
                const words = [];
                for (const w of seg.l) {
                  const cc = (w && w.c != null) ? String(w.c) : '';
                  if (!cc.length) continue;
                  // seg.ts and w.o are SECONDS; w.c is the word text → its length
                  words.push([+(ts + (+(w && w.o) || 0)).toFixed(3), cc.length]);
                }
                if (words.length) {
                  words.sort((a, b) => a[0] - b[0]);   // guarantee monotonic word starts for the wipe loop
                  const te = (+seg.te || 0) > ts ? +seg.te : null;   // null ⇒ the loop uses the next line's start as the end
                  wmap[String(Math.round(ts * 100))] = { e: te != null ? +te.toFixed(3) : null, w: words };
                }
              }
            }
            // richsync becomes the line source only when it yields a real sheet;
            // pairing syncedRaw + wt from the same segments keeps their times in
            // lock-step so the word map can never silently mismatch the lines
            if (ls.length >= 4) {
              syncedRaw = ls.join('\n');
              if (Object.keys(wmap).length) wt = wmap;
            }
          }
        }
      } catch (e) {}
      const lyBody = mc['track.lyrics.get'] && mc['track.lyrics.get'].message && mc['track.lyrics.get'].message.body;
      const ly = lyBody && lyBody.lyrics;
      if (ly && ly.lyrics_body && !ly.restricted) plain = ly.lyrics_body;
      if (/\*{5,}/.test(plain)) plain = '';
      const base = {
        src: 'mxm', id: 'm' + (tr.track_id || tr.commontrack_id || 0), rank: 0,
        t: tr.track_name || '', a: tr.artist_name || '',
        dur: tr.track_length || 0, img: '',
      };
      if (tr.instrumental) return { songs: [{ ...base, instrumental: true, synced: false, syncedRaw: '', plain: '' }] };
      if (!syncedRaw.trim() && !plain.trim()) return { songs: [] };
      return { songs: [{ ...base, instrumental: false, synced: !!syncedRaw.trim(), syncedRaw, plain, wt }] };
    }

    async function find({ artist, track, dur }) {
      if (dead || !track) return { songs: [] };
      const once = async (d) => {
        // bounded retry on a stale token (was a single inline retry — keep that
        // semantic but cap to TWO attempts explicitly and Log.err the run when
        // both fail with mxm401 so a permanently-cursed token surfaces in the
        // error ring instead of silently degrading every search forever)
        for (let attempt = 0; attempt < 2; attempt++) {
          try { return parse(await query(artist, track, d)); }
          catch (e) {
            if (e && e.message === 'mxm401' && attempt === 0) continue;
            if (e && e.message === 'mxm401') {
              try { Log.err && Log.err('mxm', new Error('401 after refresh — token rejected twice')); } catch (x) {}
              markDead();
            }
            throw e;
          }
        }
        return { songs: [] };   // unreachable but the type-checker likes a fallback
      };
      let r = await once(dur > 0 ? dur : 0);
      // the ±4s subtitle-length filter rejects every sped-up/slowed/tagged
      // upload even when MXM has the lyrics — retry open and let the scorer
      // and the scaled-sync path judge the fit instead
      if (!r.songs.length && dur > 0) r = await once(0);
      return r;
    }

    return { find };
  })();

  /* ----- LYRICS.OVH (plain-text last resort) ----- */

  // dead-state cache like MXM: a sustained failure stretch parks the provider
  // for 6h so search waves don't waste a slot waiting on it every track. Cleared
  // on the next successful hit.
  let _ovhDeadTs = 0;
  try { _ovhDeadTs = +GM_getValue('sl:ovhdead', 0) || 0; } catch (e) {}
  let _ovhFails = 0;
  const ovhDead = () => _ovhDeadTs && (Date.now() - _ovhDeadTs) < 6 * 3600 * 1000;
  const ovhMarkDead = () => { _ovhDeadTs = Date.now(); try { GM_setValue('sl:ovhdead', _ovhDeadTs); } catch (e) {} };
  const ovhMarkAlive = () => { _ovhDeadTs = 0; _ovhFails = 0; try { GM_setValue('sl:ovhdead', 0); } catch (e) {} };

  async function ovhFind(artist, title) {
    if (ovhDead()) return { songs: [] };   // skip while parked
    try {
      const j = await gmJSON('https://api.lyrics.ovh/v1/' + encodeURIComponent(artist) + '/' + encodeURIComponent(title), { timeout: 7000 });
      const L = j && j.lyrics;
      if (!L || !L.trim()) return { songs: [] };
      ovhMarkAlive();
      return {
        songs: [{
          src: 'ovh', id: 'o' + normKey(artist + ' ' + title).split(' ').join('').slice(0, 30), rank: 0,
          t: title, a: artist, dur: 0, img: '',
          synced: false, syncedRaw: '', plain: L, instrumental: false,
        }],
      };
    } catch (e) {
      // lyrics.ovh answers a plain "no lyrics" with HTTP 404 — that's a miss,
      // not an outage, and must not count toward parking the provider
      if (/HTTP 404/.test(String(e && e.message))) return { songs: [] };
      _ovhFails++; if (_ovhFails >= 4) ovhMarkDead();
      try { Log.err('ovhFind', e); } catch (x) {}
      return { songs: [] };
    }
  }

  /* ----- ITUNES + SOUNDCLOUD METADATA ----- */

  async function itunesSearch(q) {
    const j = await gmJSON('https://itunes.apple.com/search?media=music&limit=4&term=' + encodeURIComponent(q),
      { headers: { Accept: 'application/json' }, timeout: 6000 });
    return (j.results || []).map((r) => ({
      a: r.artistName || '', t: r.trackName || '', al: r.collectionName || '',
      dur: Math.round((r.trackTimeMillis || 0) / 1000),
    })).filter((r) => r.a && r.t);
  }

  async function scTrackData(path) {
    const html = await gmFetch('https://soundcloud.com' + path, { timeout: 6000 });
    const m = html.match(/window\.__sc_hydration\s*=\s*(\[[\s\S]*?\])\s*;\s*<\/script>/);
    if (!m) return null;
    const arr = JSON.parse(m[1]);
    const snd = arr.find((x) => x && x.hydratable === 'sound');
    return (snd && snd.data) || null;
  }

  /* ----- SOUNDCLOUD DESCRIPTION as a lyrics source -----
   * Underground SC artists very often paste the full lyrics into the track
   * description — and those words exist NOWHERE else (not Genius, not MXM).
   * This is deliberately conservative: it strips promo / credit / link lines
   * and only returns a body that genuinely reads like lyrics, so it can be a
   * trustworthy LAST resort before "no match". */
  const DESC_JUNK = /(?:[©℗]|\b(?:prod(?:\.|uced)?\s*by|directed by|mixed?\s*by|master(?:ed)?\s*by|engineer|cover\s*art|art\s*by|follow|subscribe|subs?\b|stream(?:ing)?|out\s*now|available|free\s*dl|download|buy\b|link\s*in|dm\s*for|booking|business|inquiries|instagram|twitter|tiktok|youtube|spotify|apple\s*music|soundcloud|all\s*rights|beat\s*(?:by|from)|type\s*beat)\b)|@[\w.]|https?:\/\/|www\.|[\w-]+\.(?:com|net|co|to|xyz|fm)\b/i;
  function descLyricsFrom(desc) {
    if (!desc || String(desc).length < 60) return null;
    const raw = String(desc).replace(/\r/g, '').split('\n').map((l) => l.trim());
    const kept = [];
    for (const l of raw) {
      if (!l) { kept.push(''); continue; }
      if (DESC_JUNK.test(l)) continue;                 // drop promo / credits / links
      if (/^[-=_*~.]{2,}$/.test(l)) continue;          // separators
      kept.push(l);
    }
    const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const real = body.split('\n').filter((x) => x.trim());
    if (real.length < 8) return null;                  // too short to be a lyric sheet
    const avg = real.reduce((s, x) => s + x.length, 0) / real.length;
    if (avg < 6 || avg > 90) return null;              // paragraphs / single words ≠ lyrics
    // most lines must read like sung text (majority letters)
    const wordy = real.filter((x) => (x.match(/\p{L}/gu) || []).length >= x.length * 0.5).length;   // any script, not just ASCII
    if (wordy < real.length * 0.7) return null;
    return body.split('\n').map((x) => x.trim());
  }

  /* ----- DIAGNOSTICS — tests every route against a known song ----- */

  const DIAG_URL = 'https://genius.com/Kendrick-lamar-humble-lyrics';
  const DIAG_Q = 'HUMBLE Kendrick Lamar';

  async function runDiagnostics(onStep) {
    const out = [];
    const step = (name, fn) => {
      const t = performance.now();
      return fn().then(
        () => { out.push({ name, ok: true, ms: Math.round(performance.now() - t) }); if (onStep) onStep(out.slice()); },
        (e) => { out.push({ name, ok: false, ms: Math.round(performance.now() - t), msg: (e && e.message) || 'failed' }); if (onStep) onStep(out.slice()); }
      );
    };
    // small sequential batches → timings reflect each route, not a pile-up
    await Promise.all([
      step('Genius search API', async () => {
        const j = await gmJSON('https://genius.com/api/search/song?per_page=1&q=' + encodeURIComponent(DIAG_Q), { headers: G_HEADERS, timeout: 9000 });
        if (!j || !j.response) throw new Error('unexpected response');
      }),
      step(Gtok.has() ? 'Genius API (your token)' : 'Genius API token (not set)', async () => {
        if (!Gtok.has()) throw new Error('add a token in ⋯ menu — reliable on blocked networks');
        const j = await gmJSON('https://api.genius.com/search?q=' + encodeURIComponent(DIAG_Q),
          { headers: { Authorization: 'Bearer ' + Gtok.get(), Accept: 'application/json' }, timeout: 9000 });
        if (!j || !j.response || !(j.response.hits || []).length) throw new Error('token rejected or no results');
      }),
      step('Genius page · direct', async () => {
        const h = await gmFetch(DIAG_URL, { timeout: 10000 });
        if (!parseGeniusHtml(h)) throw new Error('Cloudflare challenge');
      }),
      step('LRCLIB', async () => {
        const r = await lrcSearch({ q: DIAG_Q });
        if (!r.songs.length) throw new Error('no results');
      }),
    ]);
    await Promise.all([
      step('Genius page · Wayback', async () => {
        const h = await gmFetch('https://web.archive.org/web/2id_/' + DIAG_URL, { timeout: 14000 });
        if (!parseGeniusHtml(h)) throw new Error('no snapshot / parse');
      }),
      // R17: codetabs + allorigins skip silently when strict-privacy is on so a
      // diagnostics page with green Wayback + missing rows is unambiguously a
      // user setting, not "the network is broken"
      step('Genius page · codetabs', async () => {
        if (Strict.get()) throw new Error('skipped · strict privacy on');
        const h = await gmFetch('https://api.codetabs.com/v1/proxy?quest=' + DIAG_URL, { timeout: 10000 });
        if (!parseGeniusHtml(h)) throw new Error('blocked / parse');
      }),
      step('Genius page · allorigins', async () => {
        if (Strict.get()) throw new Error('skipped · strict privacy on');
        const h = await gmFetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(DIAG_URL), { timeout: 10000 });
        if (!parseGeniusHtml(h)) throw new Error('blocked / parse');
      }),
    ]);
    await Promise.all([
      step('Web search · DuckDuckGo', async () => {
        const r = await ddgGeniusSearch(DIAG_Q);
        if (!r.songs.length) throw new Error('no results');
      }),
      step('Web search · Bing', async () => {
        const r = await bingGeniusSearch(DIAG_Q);
        if (!r.songs.length) throw new Error('no results');
      }),
      step('Web search · Mojeek', async () => {
        const r = await mojeekGeniusSearch(DIAG_Q);
        if (!r.songs.length) throw new Error('no results');
      }),
    ]);
    await Promise.all([
      step('Musixmatch', async () => {
        const r = await MXM.find({ artist: 'Kendrick Lamar', track: 'HUMBLE.', dur: 177 });
        if (!r.songs.length) throw new Error('no lyrics / token');
      }),
      step('Kugou', async () => {
        const r = await kugouSearch('HUMBLE Kendrick Lamar', 177);
        if (!r.songs.length) throw new Error('no results');
      }),
      step('NetEase', async () => {
        const r = await neteaseSearch('HUMBLE Kendrick Lamar', 177);
        if (!r.songs.length) throw new Error('no results');
      }),
    ]);
    return out;
  }

  /* ------------------------------------------------------------------ *
   *  5. LRC PARSING — with credit-line filtering
   * ------------------------------------------------------------------ */

  // NetEase and Kugou answer an instrumental with a placeholder LRC instead of
  // an empty one ("纯音乐，请欣赏" — "pure music, please enjoy", and variants);
  // shown as lyrics it reads as a Chinese line over an English song
  const LRC_PLACEHOLDER = /纯音乐|请欣赏|无歌词|暂无歌词|no lyrics/i;
  function lrcIsPlaceholder(lines) {
    return lines.length > 0 && lines.length <= 3 && lines.every((l) => LRC_PLACEHOLDER.test(l[1]));
  }

  function parseLRC(raw, selfArtist, selfTitle) {
    const tagRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    let offset = 0;
    const out = [];
    for (const lineRaw of String(raw || '').split(/\r?\n/)) {
      // [offset:N] can sit anywhere on the line (some LRCs put it next to [ar:]
      // / [ti:] header tags) — match unanchored, but only treat it as a HEADER
      // (skip the line for timestamp parsing) when the line carries NO timestamp
      // tags of its own. A line like '[00:01.50][offset:50]text' is unusual but
      // shouldn't drop the lyric.
      const om = lineRaw.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
      if (om) { offset = parseInt(om[1], 10) || 0; if (!/\[\d{1,2}:\d{2}/.test(lineRaw)) continue; }
      const tags = [...lineRaw.matchAll(tagRe)];
      if (!tags.length) continue;
      const text = lineRaw.replace(tagRe, '').replace(/<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, '').replace(/\s{2,}/g, ' ').trim();   // enhanced-LRC word tags too
      if (!text) continue;
      for (const m of tags) {
        const mm = parseInt(m[1], 10), ss = parseInt(m[2], 10);
        let frac = 0;
        if (m[3]) frac = parseInt(m[3], 10) / Math.pow(10, m[3].length);
        out.push([Math.max(0, mm * 60 + ss + frac - offset / 1000), text]);
      }
    }
    out.sort((x, y) => x[0] - y[0]);
    const deduped = out.filter((e, i) => !i || e[0] !== out[i - 1][0] || e[1] !== out[i - 1][1]);
    // KuGou-style bilingual LRCs interleave original + translation at the
    // SAME timestamp — collapse those pairs to the line whose script matches
    // this candidate's own title, so one lyric renders as one line
    const merged = [];
    for (const e of deduped) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(prev[0] - e[0]) < 0.05) {
        const lp = latinish(prev[1]), le = latinish(e[1]);
        if (Math.abs(lp - le) > 0.5) {
          const wantLatin = selfTitle ? latinish(selfTitle) > 0.6 : lp >= le;
          if (wantLatin ? le > lp : le < lp) merged[merged.length - 1] = e;
          continue;
        }
      }
      merged.push(e);
    }
    return merged.filter(([t, text]) => {
      // credit headers (作词/作曲/produced by…) often run well past 3s
      if (t <= 15 && RX.credit.test(text)) return false;
      if (t > 3) return true;
      if (selfTitle && sameTitle(text, selfTitle)) return false;
      if (selfArtist && selfTitle && sim(text, selfArtist + ' ' + selfTitle) > 0.85) return false;
      return true;
    });
  }

  /* ------------------------------------------------------------------ *
   *  5b. ESTIMATED SYNC — text lyrics spread across the track duration,
   *      weighted by line length. Approximate by nature, honest by label.
   * ------------------------------------------------------------------ */

  function estimateTimes(lines, dur) {
    // Latin-1 vowel groups count one syllable each (standard English/Spanish
    // heuristic). For non-Latin scripts the original regex returns 0, which
    // collapses estimated-sync lines onto a single timestamp; count per-char:
    //   \u2022 CJK ideographs + kana + Hangul \u2192 one syllable per char
    //   \u2022 Cyrillic / Greek / Hebrew \u2192 vowel groups via their own vowel sets
    //   \u2022 Devanagari / Bengali / Tamil / Thai \u2192 consonant clusters as proxy
    const RX_LATIN = /[aeiouy\u00e0-\u00fc]+/gi;
    const RX_CJK = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\uac00-\ud7af]/gu;
    const RX_CYR_VOW = /[\u0430\u0435\u0451\u0438\u043e\u0443\u044b\u044d\u044e\u044f\u0456\u0457\u0454\u0410\u0415\u0401\u0418\u041e\u0423\u042b\u042d\u042e\u042f]+/g;
    const RX_GR_VOW = /[\u03b1\u03b5\u03b7\u03b9\u03bf\u03c5\u03c9\u0391\u0395\u0397\u0399\u039f\u03a5\u03a9]+/g;
    const RX_INDIC = /[\u0900-\u097f\u0980-\u09ff\u0a00-\u0a7f\u0b00-\u0b7f\u0b80-\u0bff\u0c00-\u0c7f\u0e00-\u0e7f]/g;
    const syllables = (s) => {
      const str = String(s);
      let n = (str.match(RX_LATIN) || []).length;
      const cjk = (str.match(RX_CJK) || []).length;
      const cyr = (str.match(RX_CYR_VOW) || []).length;
      const gr = (str.match(RX_GR_VOW) || []).length;
      const indic = (str.match(RX_INDIC) || []).length;
      n += cjk + cyr + gr + Math.ceil(indic / 2);   // Indic clusters approximate 1 syllable per ~2 code points
      return n;
    };
    const items = lines.map((text) => {
      if (text === '') return { text, w: 1.6, gap: true };
      if (/^\[[^\]]{1,40}\]$/.test(text)) {
        const inner = text.toLowerCase();
        const w = /intro/.test(inner) ? 2.6 : /outro/.test(inner) ? 2.2 : /bridge|interlude|skit/.test(inner) ? 2.0 : 1.4;
        return { text, w, sec: true };
      }
      // ad-libs in parentheses barely take time; weight the core line by syllables
      const core = String(text).replace(/\([^)]*\)/g, ' ');
      let s = syllables(core);
      if (!s) s = Math.ceil(Math.max(core.replace(/[^\p{L}\p{N}]/gu, '').length, 4) / 3);
      return { text, w: Math.min(Math.max(s, 2), 26) / 5 + 0.55 };
    });
    const totalW = items.reduce((sum, i) => sum + i.w, 0) || 1;
    // intros/outros scale with track length — SC rap commonly opens on a
    // bar or two of beat before the first word, and fades out on the beat
    const intro = Math.min(Math.max(dur * 0.07, 3.5), 20);
    const outro = Math.min(Math.max(dur * 0.05, 3), 14);
    const usable = Math.max(dur - intro - outro, 10);
    let acc = 0;
    const out = items.map((it) => {
      const t = intro + (acc / totalW) * usable;
      acc += it.w;
      return { t, text: it.text, sec: !!it.sec, gap: !!it.gap };
    });
    // guarantee forward motion: never let two lines share (or invert) a time,
    // which made the highlight stick or jump backwards on dense verses
    for (let i = 1; i < out.length; i++) {
      if (out[i].t <= out[i - 1].t) out[i].t = out[i - 1].t + 0.4;
    }
    return out;
  }

  // bend estimated times through user anchors (line index → real song time).
  // piecewise-linear: handles sped-up / slowed-down sections exactly.
  function warpTimes(base, anchors) {
    if (!anchors || !anchors.length) return base.slice();
    const A = anchors.slice().sort((x, y) => x.i - y.i).filter((a) => a.i >= 0 && a.i < base.length);
    if (!A.length) return base.slice();
    const out = base.slice();
    const f = A[0];
    const shift0 = f.t - base[f.i];
    for (let i = 0; i <= f.i; i++) out[i] = Math.max(0, base[i] + shift0);
    for (let k = 0; k < A.length - 1; k++) {
      const a = A[k], b = A[k + 1];
      const span = (base[b.i] - base[a.i]) || 1;
      for (let i = a.i; i <= b.i; i++) out[i] = a.t + (base[i] - base[a.i]) * (b.t - a.t) / span;
    }
    const l = A[A.length - 1];
    const shiftN = l.t - base[l.i];
    for (let i = l.i; i < base.length; i++) out[i] = base[i] + shiftN;
    for (let i = 1; i < out.length; i++) if (out[i] < out[i - 1] + 0.15) out[i] = out[i - 1] + 0.15;
    return out;
  }

  /* ------------------------------------------------------------------ *
   *  6. SCORING + FINDER — event-driven judge across five providers
   * ------------------------------------------------------------------ */

  const SOLID = 0.78;
  const POOL_MIN = 0.42;

  // decision trail — included in the diagnostics report so failures are explainable
  const Trail = {
    lines: [],
    add(s) {
      this.lines.push(new Date().toTimeString().slice(0, 8) + ' ' + s);
      if (this.lines.length > 50) this.lines.shift();
      // console mirror only in debug mode — the in-memory buffer always feeds diagReport
      try { if (SUITE.debug && SUITE.debug()) console.debug('[SuperLyrics]', s); } catch (e) {}
    },
    dump() { return this.lines.join('\n'); },
  };

  const rankPrior = (r) => (r === 0 ? 0.05 : r === 1 ? 0.03 : r === 2 ? 0.015 : 0);
  const needsBody = (c) => c.src === 'genius' || c.src === 'kugou' || c.src === 'netease';

  const FT_SPLIT = /\s*(?:\(|\)|\[|\]|,|&|\+|\b(?:ft|feat|featuring|with)\b\.?|\bx\b|\band\b)\s*/gi;
  function artistParts(c) {
    const out = [];
    const push = (v) => {
      v = (v || '').trim();
      if (v && v.length > 1 && !out.some((o) => normKey(o) === normKey(v))) out.push(v);
    };
    push(c.a);
    String(c.an || '').split(FT_SPLIT).forEach(push);
    String(c.a || '').split(FT_SPLIT).forEach(push);
    push(c.an);
    return out.length ? out : [''];
  }

  function scoreCand(c, G, dur) {
    const flg = (G.clean && G.clean.flags) || {};
    let ts = 0;
    for (const t of G.titles) {
      ts = Math.max(ts, sim(t, c.t), c.tf ? sim(t, c.tf) : 0);
    }
    let asEff = 0.5;
    if (G.hints.length) {
      asEff = 0;
      const parts = artistParts(c);
      for (const h of G.hints) {
        let s = 0;
        for (const p of parts) s = Math.max(s, sim(h.a, p));
        asEff = Math.max(asEff, s * h.conf + (1 - h.conf) * 0.45);
      }
    }
    let score = 0.70 * ts + 0.30 * asEff;
    // when the artist is KNOWN (dash-split title, library metadata), a
    // candidate from a completely different artist is almost certainly a
    // same-title stranger — exactly the "random song" failure
    if (G.hints.length && G.hints[0].conf >= 0.9 && asEff < 0.3) score -= 0.08;
    if (c.src === 'genius') score += 0.05; // Genius leads: best catalog + naming authority
    // "Genius English Translations" / "Genius Romanizations" pages match the
    // title perfectly but carry the wrong-language lyrics — bury them
    if (c.a && /^genius\b/i.test(c.a) && /translation|romanization/i.test(c.a)) score -= 0.3;
    let dc = null;
    if (c.dur > 0 && dur > 0) {
      // relative window: ±10s on a 3-min song is a different version,
      // on a 10-min mix it's a DJ tag
      const dd = Math.abs(c.dur - dur);
      dc = Math.max(0, 1 - dd / Math.max(10, 0.05 * dur));
      // v3.1: duration agreement = right VERSION, not just right song —
      // it's the strongest predictor that timestamps will actually land
      score += 0.09 * dc;
      if (dd <= 2) score += 0.05;
    }
    if (c.synced) {
      if (flg.cover) score -= 0.04;   // the original's timestamps won't fit a cover
      else if (dc == null || dc >= 0.3) score += 0.04;
      else {
        const ratio = (c.dur > 0 && dur > 0) ? dur / c.dur : 0;
        if (!(ratio >= 0.6 && ratio <= 1.7)) score -= 0.06;
        else if (flg.spedUp || flg.slowed) score += 0.03;   // expected tempo change — scaled sync will fit
      }
    }
    // Musixmatch is the SYNCED-lyrics authority — prioritise it so the karaoke
    // sync actually works, but ONLY when we're confident it's the RIGHT track:
    // a strong title (ts≥0.65) AND a confirmed (or unknown) duration. A weak or
    // duration-mismatched MXM gets just the normal lead (+0.05, parity with
    // Genius), so it can never outrank a correct Genius/other match — those
    // remain the fallback when MXM has nothing solid. (placed AFTER dc is known)
    if (c.src === 'mxm') score += (c.synced && ts >= 0.65 && (dc == null || dc >= 0.4)) ? 0.12 : 0.05;
    if (c.instrumental && flg.instrumental) score += 0.2;   // the title says so and the source agrees
    if (c.src === 'kugou' || c.src === 'netease') score += 0.03; // usually synced
    score += rankPrior(c.rank || 0);
    if (G.titles.some((t) => sameTitle(t, c.t) || (c.tf && sameTitle(t, c.tf)))) score += 0.05;
    // version-tag agreement: "(Remix)" / "Live" / "pt. 2" must match BOTH ways
    // — title similarity alone happily pairs a remix with the original
    if (G.vt) {
      const cvt = versionTags((c.t || '') + ' ' + (c.tf || ''));
      let vHit = 0, vMiss = 0;
      for (const tg of G.vt) { if (cvt.has(tg)) vHit++; else if (tg !== 'remaster') vMiss++; }
      for (const tg of cvt) if (!G.vt.has(tg) && tg !== 'remaster') vMiss++;
      score += Math.min(vHit * 0.04, 0.08) - Math.min(vMiss * 0.12, 0.24);
    }
    score += (c.agreeBonus || 0);   // cross-source consensus (set in add())
    // ovh ECHOES the query back as its metadata, so its similarity is a lie —
    // cap it below every fast-path threshold; it can only win as a last resort
    if (c.src === 'ovh') score = Math.min(score - 0.08, 0.68);
    c.asEff = asEff; c.ts = ts; c.dc = dc;
    return score;
  }

  // inline candidates (lrclib / mxm / ovh) → result
  function fromInline(c, wantDur, flags) {
    if (c.instrumental) return { instr: true, src: c.src, a: c.a, t: c.t, score: c.score, low: c.score < SOLID };
    const isCover = !!(flags && flags.cover);   // covers get text — the original's timeline is wrong by definition
    if (c.synced && !isCover) {
      const fit = fitSync(parseLRC(c.syncedRaw, c.a, c.t), c.dur, wantDur);
      if (fit) {
        return { src: c.src, synced: true, scaled: fit.scaled, lines: fit.lines, a: c.a, t: c.t, srcDur: c.dur || 0, score: c.score, low: c.score < SOLID, wt: fit.scaled ? null : (c.wt || null) };
      }
      // version too far off to trust the timeline → fall through to plain text
    }
    let texts = [];
    if (c.plain && c.plain.trim()) texts = c.plain.split(/\r?\n/).map((l) => l.trim());
    else if (c.synced) texts = parseLRC(c.syncedRaw, c.a, c.t).map((l) => l[1]);
    texts = texts.filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));
    if (!texts.filter(Boolean).length) return null;
    return { src: c.src, synced: false, lines: texts, a: c.a, t: c.t, score: c.score, low: c.score < SOLID };
  }

  function findLyrics(meta, onLate, onStage, opts) {
    // lite mode (next-track pre-warm): wave 1 only, no web-search chains, no
    // long extensions — a track the user may skip past doesn't get the full
    // escalation, which keeps the connection budget free for the foreground
    const lite = !!(opts && opts.lite);
    try {
      if (SUITE.libByUrl && meta.href) {
        const lib0 = SUITE.libByUrl('https://soundcloud.com' + meta.href);
        if (lib0) {
          if (lib0.durMs > 0 && !(meta.dur > 0)) meta.dur = Math.round(lib0.durMs / 1000);
          if (lib0.artist) meta.libArtist = lib0.artist;
        }
      }
    } catch (e) {}
    const G = buildGuesses(meta);
    const FLAGS = (G.clean && G.clean.flags) || {};
    // collective aliases: the uploader (e.g. a crew/label) maps to the real
    // credited artist(s). User-taught and remembered, so a whole collective
    // resolves correctly after one correction.
    try {
      const names = new Set();
      [meta.uploader, G.clean.artist, G.clean.handle].forEach((n) => Aliases.for(n).forEach((a) => names.add(a)));
      names.forEach((a) => { if (a && !G.hints.some((h) => normKey(h.a) === normKey(a))) G.hints.unshift({ a, conf: 0.92 }); });
    } catch (e) {}
    if (meta.libArtist) {
      const k0 = normKey(meta.libArtist);
      if (k0 && !G.hints.some((h) => normKey(h.a) === k0)) G.hints.unshift({ a: meta.libArtist, conf: 0.95 });
      const q0b = (meta.libArtist + ' ' + G.clean.title).trim();
      if (!G.gq.some((x) => normKey(x) === normKey(q0b))) G.gq.unshift(q0b);
      if (!G.lq.some((x) => normKey(x) === normKey(q0b))) G.lq.unshift(q0b);
      meta.exactReady = true;   // wave 0: artist+title+duration in hand — fire the exact lookup first
    }
    // user-banned matches for this track ("wrong lyrics" in the ⋯ menu)
    let banned = null;
    try {
      const bm = GM_getValue('sl:ban', null);
      const bl = bm && meta.key && bm[meta.key];
      if (bl && bl.length) banned = bl;
    } catch (e) {}
    const banTag = (it) => (it.src || '') + '|' + normKey((it.a || '') + ' ' + (it.t || ''));
    const descBanned = () => !!(banned && banned.includes('scdesc|' + normKey((meta.uploader || '') + ' ' + (meta.title || ''))));
    Trail.add(`find "${meta.title}" · up:${meta.uploader} · dur:${meta.dur || '?'} · gmode:${Gmode.get()}`);
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      let done = false, left = 0, total = 0, fails = 0;
      let wave2Fired = false, finalScheduled = false, drained = false;
      let extensions = 0, lateFired = false, stageFired = false, artistLoopFired = false, pivotFired = false;
      let resolved = null;   // what finish() delivered — a late result may only replace it when clearly better
      const lateOk = (score, synced) => !resolved || ((score || 0) > (resolved.score || 0) + 0.1 && (!resolved.synced || !!synced));
      let partialFired = false;   // provisional render: best-ready result shown while verification continues
      const pool = [], lyricPool = [], reserve = [];
      const bodies = new Map(); // cand.id → { state:'p'|'ok'|'bad', synced, lines }
      const timers = [];
      const after = (fn, ms) => { const h = Ticker.after(fn, ms); timers.push(h); return h; };

      const stop = () => timers.forEach((h) => { try { h && h.stop ? h.stop() : clearTimeout(h); } catch (e) {} });
      const xcheck = (v) => {
        try {
          if (!v || v.src === 'genius' || v.instr) return true;
          // verify synced results AND the echo-prone plain sources (ovh
          // fabricates its metadata from the query, so its score lies)
          if (!v.synced && v.src !== 'ovh' && v.src !== 'mxm') return true;
          let ref = null;
          for (const p of pool) {
            if (p.src !== 'genius' || p.score < 0.6) continue;
            const b = bodies.get(p.id);
            if (b && b.state === 'ok' && b.lines && b.lines.length >= 8) { ref = b; break; }
          }
          if (!ref) return true;
          const bad = pool.find((p) => p.src === v.src && p.t === v.t && p.a === v.a);
          if (bad && bad.xbad) return true; // already demoted once — accept, don't loop
          // synced lines are [time, text] pairs — the old extractor returned ''
          // for them, which silently disabled this whole cross-check
          const txt = (ls) => normKey(ls.slice(0, 45).map((l) => {
            if (typeof l === 'string') return l;
            if (Array.isArray(l)) return l[1] || '';
            return (l && (l.text || l.txt)) || '';
          }).join(' '));
          const ra = txt(ref.lines), rb = txt(v.lines || []);
          if (!ra || !rb) return true;
          const sa = new Set(ra.split(' ')), sb = new Set(rb.split(' '));
          let inter = 0;
          for (const t of sb) if (sa.has(t)) inter++;
          const ov = inter / Math.max(10, Math.min(sa.size, sb.size));
          if (ov >= 0.3) return true;
          Trail.add(`cross-check vs genius failed (${ov.toFixed(2)}) — dropping "${v.t}" ${v.src}`);
          if (bad) { bad.score -= 0.3; bad.xbad = true; }
          return false;
        } catch (e) { return true; }
      };
      const finish = (v) => {
        if (v && !xcheck(v)) { pool.sort((a, b) => b.score - a.score); judge(); return; }
        if (!done) {
          done = true; resolved = v || null; stop();
          Trail.add(v ? `→ ${v.src}${v.synced ? '/synced' : '/text'} "${v.t}" (${(v.score || 0).toFixed(2)}${v.low ? ' low' : ''})` : '→ no match');
          resolve(v);
        }
      };
      const failNet = () => { if (!done) { done = true; stop(); Trail.add('→ network failure (all sources errored)'); reject(new Error('net')); } };

      function mkBody(c, body, lowOverride) {
        const low = lowOverride != null ? lowOverride : c.score < SOLID;
        if (body.synced) {
          // covers: the original's timeline is wrong by definition — render text
          if (FLAGS.cover) return { src: c.src, synced: false, lines: body.lines.map((l) => l[1]), a: c.a, t: c.t, score: c.score, low, img: c.img };
          // scale the real timestamps onto THIS upload's length (sped-up / slowed
          // mixes drift otherwise); too-far-off = wrong version → render as text
          const fit = fitSync(body.lines, c.dur, meta.dur);
          if (fit) return { src: c.src, synced: true, scaled: fit.scaled, lines: fit.lines, a: c.a, t: c.t, srcDur: c.dur || 0, score: c.score, low, img: c.img };
          return { src: c.src, synced: false, lines: body.lines.map((l) => l[1]), a: c.a, t: c.t, score: c.score, low, img: c.img };
        }
        return { src: c.src, synced: false, lines: body.lines, a: c.a, t: c.t, score: c.score, low, img: c.img };
      }

      function fetchBody(c) {
        if (!c || !needsBody(c) || bodies.has(c.id)) return;
        bodies.set(c.id, { state: 'p' });
        const fromLrcRaw = (raw) => {
          if (!raw) return null;
          const lines = parseLRC(raw, c.a, c.t);
          if (lrcIsPlaceholder(lines)) { Trail.add(`${c.src} body for "${c.t}" is an instrumental placeholder`); return null; }
          return lines.length ? { synced: true, lines } : null;
        };
        const p = c.src === 'genius'
          ? geniusLyrics(c.url).then((lines) => (lines && lines.length ? { synced: false, lines } : null))
          : c.src === 'netease'
            ? neteaseLyric(c.nid).then(fromLrcRaw)
            : kugouLyric(c.kid, c.kkey).then(fromLrcRaw);
        // a STRONG match whose lyric download dies must not end the search —
        // its artist+title are confirmed evidence: pivot them into exact
        // lookups at the catalogs that ARE reachable (the trail showed
        // NetEase naming the right song at 0.77 and the engine giving up)
        const pivot = () => {
          if (pivotFired || done || (c.score || 0) < 0.6 || !c.a) return;
          pivotFired = true;
          Trail.add(`body failed for strong "${c.t}" — pivoting to exact synced lookups`);
          track(lrcGet({ track: c.t, artist: c.a, dur: meta.dur > 0 ? meta.dur : (c.dur || 0) }));
          track(MXM.find({ artist: c.a, track: c.t, dur: meta.dur > 0 ? meta.dur : (c.dur || 0) }));
        };
        p.then((body) => {
          bodies.set(c.id, body ? { state: 'ok', synced: body.synced, lines: body.lines } : { state: 'bad' });
          Trail.add(`body ${c.src} "${c.t}" (${(c.score || 0).toFixed(2)}) → ${body ? 'ok' : 'FAILED on every route'}`);
          if (!body) pivot();
          if (done && body && !lateFired && c.score >= 0.55 && typeof onLate === 'function' && lateOk(c.score, body.synced)) {
            lateFired = true;
            Trail.add('late delivery → rendering now');
            try { onLate(mkBody(c, { state: 'ok', synced: body.synced, lines: body.lines })); } catch (e) {}
          }
          judge();
        }).catch(() => {
          // only a body that never landed is 'bad' — a throw inside judge() must
          // not re-label a good body and pivot the search away from it
          const st = bodies.get(c.id);
          if (!st || st.state === 'p') { bodies.set(c.id, { state: 'bad' }); pivot(); }
          judge();
        });
      }

      function readyResult(c, lowOverride) {
        // hard title floor: whatever the artist/duration/rank bonuses add up
        // to, a candidate whose TITLE doesn't resemble the track's is a
        // random song — it never renders (cross-source consensus excepted)
        if ((c.ts || 0) < 0.45 && !c.agreeBonus && !c.picked) return null;
        if (!needsBody(c)) return fromInline(c, meta.dur, FLAGS);
        const b = bodies.get(c.id);
        if (b && b.state === 'ok') return mkBody(c, b, lowOverride);
        return null;
      }

      // returns true (resolved) | 'wait' (a top option's body is loading) | false
      function tryResolve(minScore, slack) {
        const top = pool[0];
        if (!top || top.score < minScore) return false;
        const floor = Math.max(minScore, top.score - (slack == null ? 0.04 : slack));
        for (const c of pool) {
          if (c.score < floor) break;
          // readyResult (not fromInline/mkBody directly) so the hard title
          // floor applies on the fast tiers too
          if (!needsBody(c)) {
            const r = readyResult(c);
            if (r) { finish(r); return true; }
            continue;
          }
          const b = bodies.get(c.id);
          if (b && b.state === 'ok') { const r = readyResult(c); if (r) { finish(r); return true; } continue; }
          if (!b) { fetchBody(c); return 'wait'; }
          if (b.state === 'p') return 'wait';
        }
        return false;
      }

      function fireWave2() {
        if (wave2Fired) return;
        wave2Fired = true;
        if (lite) return;   // pre-warm never escalates
        if (G.lq2[0]) track(lrcSearch({ q: G.lq2[0] }));
        const wq = G.gq2[0] || G.gq[0];
        if (wq) {
          if (Gmode.get() === 'direct') track(geniusLegacy(wq));
          // honor the once-per-run latch when falling back to the wave-1 query
          if (!(wsLaunched && wq === G.gq[0])) {
            if (wq === G.gq[0]) wsLaunched = true;
            track(webSearch(wq), true);
          }
        }
        if (normKey(G.clean.bare) !== normKey(G.gq[0] || '')) track(kugouSearch(G.clean.bare || G.clean.title, meta.dur));
        const h = G.hints[0];
        if (h && h.conf >= 0.55) track(ovhFind(h.a, G.clean.title), false, true);
      }

      function finalEffort() {
        if (done) return;
        pool.sort((a, b) => b.score - a.score);
        // make sure the STRONGEST candidates actually have their lyric pages
        // in flight before we judge — a high-score candidate that slipped in
        // without a body fetch must never be the reason we conclude "no match"
        pool.filter((c) => (c.score || 0) >= 0.6 && needsBody(c) && !bodies.has(c.id)).slice(0, 3).forEach(fetchBody);
        for (const c of pool) {
          if ((c.score || 0) < 0.48 && !c.agreeBonus && !c.picked) continue;   // same floor as the reserve — POOL_MIN alone is "maybe", not "render"
          const r = readyResult(c);
          if (r) { finish(r); return; }
        }
        const pendingBody = (c) => needsBody(c) && (!bodies.get(c.id) || bodies.get(c.id).state === 'p');
        const strongPending = pool.some((c) => c.score >= 0.55 && pendingBody(c));
        // the RIGHT answer is loading (strong title, high score, body in
        // flight) — be far more patient: this is exactly the song we want
        const rightAnswerLoading = pool.some((c) => c.score >= 0.7 && (c.ts || 0) >= 0.55 && pendingBody(c));
        const cap = lite ? 1 : (rightAnswerLoading ? 9 : 4);
        if (((strongPending || rightAnswerLoading) && extensions < cap) || (left > 0 && extensions < (lite ? 1 : 4))) {
          extensions++;
          Trail.add(`final: still working (inflight:${left}${rightAnswerLoading ? ' · right answer loading' : ''}) — extending (#${extensions})`);
          after(finalEffort, strongPending ? 3500 : 2500);
          return;
        }
        for (const c of reserve) {
          if ((c.score || 0) < 0.48) continue;   // "anything beats nothing" ends here —
          const r = readyResult(c, true);        // a weak guess IS the wrong-song complaint
          if (r) { finish(r); return; }
        }
        lyricPool.sort((a, b) => (b.asEff || 0) - (a.asEff || 0));
        const ly = lyricPool[0];
        if (ly && (ly.score || 0) >= 0.45) {
          const r = readyResult(ly, true);
          if (r) { finish(r); return; }
        }
        if (!pool.length && !lyricPool.length && !reserve.length && ((total > 0 && fails === total) || navigator.onLine === false)) { failNet(); return; }
        // the title or SoundCloud's own genre/tags said "instrumental" and no
        // source disagreed strongly enough to win — believe them. (Never from
        // a lite pre-warm: wave-1-only evidence must not cache an instrumental.)
        if (!lite && (FLAGS.instrumental || meta.instrHint)) {
          finish({ instr: true, src: 'title', a: meta.uploader || '', t: meta.title || '' });
          return;
        }
        // genuine last resort: lyrics the artist pasted into the SC description
        // (nothing else found them). Marked low so the source line is honest.
        if (!lite && !descBanned() && meta.descLyrics && meta.descLyrics.filter(Boolean).length >= 8) {
          Trail.add('→ falling back to SC-description lyrics');
          finish({ src: 'scdesc', synced: false, lines: meta.descLyrics, a: meta.uploader || '', t: meta.title || '', low: true });
          return;
        }
        finish(null);
      }

      function judge(forcedTier) {
        if (done) return;
        pool.sort((a, b) => b.score - a.score);

        // eagerly fetch bodies: top 3 genius, top kugou/netease, plus Genius' own #1
        pool.filter((p) => p.src === 'genius').slice(0, 3).forEach(fetchBody);
        const kk = pool.find((p) => p.src === 'kugou');
        if (kk) fetchBody(kk);
        const ne = pool.find((p) => p.src === 'netease');
        if (ne) fetchBody(ne);
        if (!pool.some((p) => p.src === 'genius') && reserve[0]) fetchBody(reserve[0]);

        const el = performance.now() - t0;
        const tier = Math.max(forcedTier || 0, drained ? 2 : 0,
          el >= 4200 ? 4 : el >= 2400 ? 3 : el >= 1200 ? 2 : el >= 800 ? 1 : 0);

        // instant rules
        for (const p of pool) {
          if (p.score < 0.80) break;
          if (p.dc != null && p.dc < 0.4) continue;
          const r = readyResult(p);
          if (r && r.synced) { finish(r); return; }     // confident synced → render now
          if (r && p.src === 'genius') { finish(r); return; } // confident genius text → render now
        }
        // dominance rule — clear leader, lyrics in hand → no reason to wait
        const lead = pool[0];
        if (lead && lead.score >= 0.72 && (!pool[1] || lead.score - pool[1].score >= 0.08)) {
          const r = readyResult(lead);
          if (r) { finish(r); return; }
          if (needsBody(lead)) fetchBody(lead);
        }

        // provisional render: a decent candidate with lyrics IN HAND goes on
        // screen immediately marked "verifying…" — the search keeps running
        // and either confirms it or swaps in something better
        // a STRONG leader with lyrics in hand renders at tier 0 — LRCLIB often
        // answers in <700ms, so don't sit on it until the 1.1s tier ticks over
        if (!partialFired && opts && opts.onPartial) {
          if (lead && lead.src !== 'ovh' && (lead.score >= 0.70 || (tier >= 1 && lead.score >= 0.64))) {
            const rp = readyResult(lead);
            if (rp && !rp.instr && (rp.synced || lead.src === 'genius')) {
              partialFired = true;
              try { opts.onPartial(rp); } catch (e) {}
            }
          }
        }

        if (tier >= 2 && !pool.some((p) => p.score >= 0.62)) fireWave2();
        if (tier >= 2 && tryResolve(0.62) === true) return;
        // v3.1: floors raised — showing the WRONG song's lyrics is worse
        // than admitting "no match"; weak guesses were the top complaint
        if (tier >= 3 && tryResolve(0.55, 0.06) === true) return;
        if (tier >= 4) {
          const r = tryResolve(0.48, 0.10);
          if (r === true) return;
          if (reserve[0]) fetchBody(reserve[0]);
          lyricPool.sort((a, b) => (b.asEff || 0) - (a.asEff || 0));
          if (lyricPool[0]) fetchBody(lyricPool[0]);
          if (!finalScheduled) {
            finalScheduled = true;
            after(finalEffort, 2600);
          }
          if (r !== 'wait' && left === 0) {
            const anyPending = [...bodies.values()].some((b) => b.state === 'p');
            if (!anyPending) finalEffort();
          }
        }
      }

      function add(res, primary) {
        if (!res) return;
        // LATE RESCUE: the right answer can land a heartbeat after we already
        // concluded (slow proxy/web-search Genius). Don't drop it — fetch its
        // body and deliver via onLate. This is the "Demons Counting Up was
        // found at 1.07 but rendered nothing" bug: it arrived just post-done.
        if (done) {
          if (lateFired || typeof onLate !== 'function') return;
          for (const it of (res.songs || [])) {
            if (banned && banned.includes(banTag(it))) continue;
            if (pool.some((p) => p.id === it.id)) continue;
            it.score = scoreCand(it, G, meta.dur);
            if (it.score < 0.7 || (it.ts || 0) < 0.5) continue;
            if (!needsBody(it)) {
              const r = fromInline(it, meta.dur, FLAGS);
              if (r && !r.instr && lateOk(it.score, r.synced)) { lateFired = true; Trail.add(`late rescue inline → ${it.src} "${it.t}"`); try { onLate(r); } catch (e) {} return; }
            } else if (!bodies.has(it.id)) {
              Trail.add(`late rescue → fetching "${it.t}" (${it.score.toFixed(2)}) ${it.src}`);
              fetchBody(it);   // fetchBody's done-branch fires onLate when it lands
            }
          }
          return;
        }
        const wantLatin = latinish(G.clean.title) > 0.7;
        for (const it of res.songs || []) {
          // language gate: a Latin-titled track never matches a CJK/Cyrillic candidate
          if (wantLatin && latinish((it.t || '') + ' ' + (it.a || '')) < 0.4) continue;
          if (banned && banned.includes(banTag(it))) continue;
          if (it.src === 'genius' && primary && (it.rank || 0) <= 1 && reserve.length < 2
            && !reserve.some((p) => p.id === it.id || (it.url && p.url === it.url))) {
            it.score = scoreCand(it, G, meta.dur);
            reserve.push(it);
          }
          if (pool.some((p) => p.id === it.id)) continue;
          if (it.url && pool.some((p) => p.url === it.url)) continue;
          it.score = scoreCand(it, G, meta.dur);
          if (it.score >= POOL_MIN) {
            // consensus: two INDEPENDENT sources naming the same song is far
            // stronger evidence than either one alone — boost both. When one
            // of the pair is Genius (text-only) and the other carries real
            // TIMESTAMPS, boost the synced one harder: Genius confirms WHICH
            // song it is, the synced source carries the clock — sync must
            // win the render or "Genius-first" costs the user their sync.
            for (const p of pool) {
              if (p.src === it.src || it.agreeBonus) continue;
              if (sameTitle(p.t, it.t) && sim(p.a, it.a) > 0.8) {
                const syncedish = (x) => !!x.synced || x.src === 'kugou' || x.src === 'netease';
                const bonus = (x, other) => (syncedish(x) && other.src === 'genius') ? 0.1 : 0.05;
                it.agreeBonus = bonus(it, p); it.score += it.agreeBonus;
                if (!p.agreeBonus) { p.agreeBonus = bonus(p, it); p.score += p.agreeBonus; }
                break;
              }
            }
            pool.push(it);
          }
          // a solid title match reveals the real artist → unlock synced sources.
          // Genius anchors at 0.62; a strong SYNCED lrclib/mxm hit can anchor
          // too (vital in proxy mode, where Genius may contribute nothing)
          if (!artistLoopFired && it.a && (
                (it.src === 'genius' && (it.ts || 0) >= 0.58) ||
                ((it.src === 'lrclib' || it.src === 'mxm') && it.synced && (it.ts || 0) >= 0.75) ||
                ((it.src === 'kugou' || it.src === 'netease') && (it.ts || 0) >= 0.75)
              )) {
            const k = normKey(it.a);
            if (k && !G.hints.some((h) => normKey(h.a) === k)) {
              artistLoopFired = true;
              G.hints.push({ a: it.a, conf: 0.7 });
              if (it.t && !G.titles.some((t) => sameTitle(t, it.t))) G.titles.push(it.t);
              rescoreAll();
              Trail.add(`${it.src} anchor: "${it.a} — ${it.t}" → exact synced lookups`);
              track(lrcGet({ track: it.t, artist: it.a, dur: meta.dur > 0 ? meta.dur : (it.dur || 0) }));
              track(kugouSearch((it.a + ' ' + it.t).trim(), meta.dur));
              const fp = artistParts(it).filter((p) => normKey(p) !== normKey(it.a) && !/[()\[\]]/.test(p)).slice(0, 1);
              fp.forEach((p) => {
                if (!G.hints.some((h) => normKey(h.a) === normKey(p))) G.hints.push({ a: p, conf: 0.65 });
                track(lrcGet({ track: it.t, artist: p, dur: meta.dur > 0 ? meta.dur : (it.dur || 0) }));
              });
              fireForArtist(it.a);
            }
          }
        }
        if (!stageFired && typeof onStage === 'function') {
          pool.sort((a, b) => b.score - a.score);
          if (pool[0] && pool[0].score >= 0.62) { stageFired = true; try { onStage(pool[0]); } catch (e) {} }
        }
        for (const it of res.lyricHits || []) {
          if (lyricPool.some((p) => p.id === it.id) || pool.some((p) => p.id === it.id)) continue;
          it.score = scoreCand(it, G, meta.dur);
          lyricPool.push(it);
        }
        judge();
        if (res.songs && res.songs.length) {
          pool.sort((a, b) => b.score - a.score);
          const top = pool[0];
          Trail.add(`+${res.songs.length} ${res.songs[0].src}${top ? ` · pool top: "${top.t}" ${top.score.toFixed(2)}` : ''}`);
        }
      }

      function track(p, primary, aux) {   // aux: metadata helpers that never fail, so they must not hide a dead network
        if (!aux) total++;
        left++; drained = false;
        p.then((res) => add(res, primary)).catch(() => { if (!aux) fails++; }).finally(() => {
          if (--left === 0 && !done) {
            drained = true;
            if (!pool.some((x) => x.score >= 0.62)) fireWave2();
            if (left === 0) judge(2);
            if (left > 0) drained = false; // wave 2 went out
            else if (wave2Fired && !finalScheduled) {
              finalScheduled = true;
              Trail.add('drained — concluding early');
              after(finalEffort, 800);
            }
          }
        });
      }

      const rescoreAll = () => {
        for (const p of pool) p.score = scoreCand(p, G, meta.dur);
        for (const p of lyricPool) p.score = scoreCand(p, G, meta.dur);
        for (const p of reserve) p.score = scoreCand(p, G, meta.dur);
      };

      const fireForArtist = (artist) => {
        // artist-exact lookups are cheap and precise — they run even in lite
        track(lrcSearch({ track: G.clean.title, artist }));
        track(MXM.find({ artist, track: G.clean.title, dur: meta.dur > 0 ? meta.dur : 0 }));
        track(kugouSearch((artist + ' ' + G.clean.title).trim(), meta.dur));
        track(neteaseSearch((artist + ' ' + G.clean.title).trim(), meta.dur));
        const cq = (artist + ' ' + G.clean.title).trim();
        if (!G.gq.some((q) => normKey(q) === normKey(cq))) {
          if (Gtok.has()) track(geniusApiSearch(cq), true, true);   // reliable, cheap — worth it even in lite
          if (!lite) {
            if (Gmode.get() === 'direct') track(geniusSong(cq), true);
            track(webSearch(cq), true);
          }
        }
      };

      const scEnrich = async () => {
        try {
          if (!meta.href) return { songs: [] };
          const full = 'https://soundcloud.com' + meta.href;

          // 1) the shuffle module's likes-library cache — canonical artist,
          //    title and duration for ZERO network cost (huge for archive rips)
          const lib = SUITE.libByUrl ? SUITE.libByUrl(full) : null;
          if (lib && !done) {
            if (lib.durMs > 0 && !(meta.dur > 0)) meta.dur = Math.round(lib.durMs / 1000);
            if (lib.artist && !G.hints.some((h) => normKey(h.a) === normKey(lib.artist))) {
              Trail.add(`library cache: artist "${lib.artist}"`);
              G.hints.unshift({ a: lib.artist, conf: 0.95 });
              rescoreAll(); judge();
              fireForArtist(lib.artist);
            }
          }

          // 2) exact track JSON via the api-v2 client_id the shuffle module
          //    sniffed — far lighter than pulling the whole HTML page
          let d = null;
          try { d = await trackJson(meta.href); } catch (e) { d = null; }   // memoised: the chapters share the same fetch
          // 3) fall back to the old HTML scrape only when both fast paths miss
          if (!d && !lib) d = await scTrackData(meta.href);
          if (!d || done) return { songs: [] };
          if (d.duration && (!(meta.dur > 0) || Math.abs(meta.dur - d.duration / 1000) > 2)) {
            meta.dur = Math.round(d.duration / 1000);
          }
          // free instrumental signal in data we already fetched: a beats/
          // type-beat genre or tag means "stop hunting for words"
          try {
            const gt = (d.genre || '') + ' ' + (d.tag_list || '');
            if (/instrumental|type\s*beat|karaoke|no\s*vocals?/i.test(gt)) {
              meta.instrHint = true;
              Trail.add('sc metadata: instrumental hint');
            }
          } catch (e) {}
          const pm = d.publisher_metadata || {};
          let newArtist = (pm.artist || '').trim();
          try {
            if (pm.writer_composer) {
              String(pm.writer_composer).split(/\s*(?:,|&|\/|\band\b)\s*/i).slice(0, 3).forEach((w) => {
                w = w.trim();
                if (w.length > 1 && !G.hints.some((h) => normKey(h.a) === normKey(w))) G.hints.push({ a: w, conf: 0.6 });
              });
            }
            const altT = (pm.release_title || '').trim() || (d.title || '').trim();
            if (altT && !G.titles.some((t) => sameTitle(t, altT))) {
              const ct2 = cleanTitle(altT);
              [ct2.title, ct2.full].forEach((t2) => {
                if (t2 && !G.titles.some((t) => sameTitle(t, t2))) G.titles.push(t2);
              });
              Trail.add(`sc metadata title: "${altT}"`);
            }
          } catch (e) {}
          if (d.description) {
            if (!newArtist) {
              for (const ln of String(d.description).split(/\r?\n/).slice(0, 6)) {
                const dm = ln.match(/^\s*(.{2,40}?)\s*[-–—]\s*(.{2,60}?)\s*$/);
                if (dm && sim(dm[2], G.clean.title) > 0.7) { newArtist = dm[1].trim(); break; }
              }
            }
            // lyrics in the description — the one source the rest of the web
            // doesn't have for underground SC. Kept as a last-resort candidate.
            if (!lite && !meta.descLyrics) {
              const dl = descLyricsFrom(d.description);
              if (dl) { meta.descLyrics = dl; Trail.add(`sc description: possible lyrics (${dl.filter(Boolean).length} lines)`); }
            }
          }
          if (newArtist && !G.hints.some((h) => normKey(h.a) === normKey(newArtist))) {
            G.hints.unshift({ a: newArtist, conf: 0.95 });
            rescoreAll(); judge();
            fireForArtist(newArtist);
          } else {
            rescoreAll(); judge();
          }
        } catch (e) {}
        return { songs: [] };
      };

      const itunesCanonical = async () => {
        try {
          const list = await itunesSearch(G.gq[0] || G.clean.title);
          let best = null, bs = 0;
          for (const r of list) {
            let ts = 0;
            for (const t of G.titles) ts = Math.max(ts, sim(t, r.t));
            let as = 0.5;
            if (G.hints.length) {
              as = 0;
              for (const h of G.hints) as = Math.max(as, sim(h.a, r.a) * h.conf + (1 - h.conf) * 0.45);
            }
            const s = 0.7 * ts + 0.3 * as;
            if (s > bs) { bs = s; best = r; }
          }
          if (best && bs >= 0.6 && !done) {
            if (!G.hints.some((h) => normKey(h.a) === normKey(best.a))) G.hints.push({ a: best.a, conf: 0.9 });
            if (!G.titles.some((t) => sameTitle(t, best.t))) G.titles.push(best.t);
            rescoreAll(); judge();
            track(lrcGet({ track: best.t, artist: best.a, album: best.al, dur: best.dur }));
            track(lrcSearch({ track: best.t, artist: best.a }));
            track(MXM.find({ artist: best.a, track: best.t, dur: best.dur || meta.dur }));
            const cq = (best.a + ' ' + best.t).trim();
            if (!G.gq.some((q) => normKey(q) === normKey(cq))) {
              if (Gmode.get() === 'direct') track(geniusSong(cq), true);
              track(webSearch(cq), true);
            }
          }
        } catch (e) {}
        return { songs: [] };
      };

      // ---- staggered launch: lean first wave, escalate only if needed ----
      // (keeps concurrent connections low — on VPNs, parallel cold
      // connections queue up and *everything* crawls)
      const strong = () => pool.some((p) => p.score >= 0.72);
      let wsLaunched = false;   // webSearch fires once per run, even if Gmode flips mid-find
      let mxmLaunched = false, neteaseLaunched = false;   // wave-1 promotion must not double-fire in 1.8

      // wave 0 — when the library cache already gave us canonical artist +
      // title + duration, LRCLIB's /get endpoint can answer EXACTLY in one
      // round-trip. Cheapest, fastest, most precise call we can make.
      if (meta.exactReady && meta.libArtist) {
        track(lrcGet({ track: G.clean.title, artist: meta.libArtist, dur: meta.dur > 0 ? meta.dur : 0 }));
      }

      // wave 1 — four requests, four hosts (genius gets one auto-retry).
      // In proxy mode (Cloudflare blocks direct Genius) those direct searches
      // are known-doomed 9s timeouts: promote webSearch to wave 1 instead and
      // keep ONE direct probe so recovery (gWrap flips back) still happens.
      if (G.lq[0]) track(lrcSearch({ q: G.lq[0] }));
      if (G.gq[0]) {
        // official API first when a token is set — it's the only Genius route
        // that survives a Cloudflare-blocked / VPN connection reliably
        if (Gtok.has()) track(geniusApiSearch(G.gq[0]), true, true);
        if (Gmode.get() === 'direct') {
          track(geniusSong(G.gq[0]).catch(() =>
            new Promise((r) => setTimeout(r, 1200)).then(() => geniusSong(G.gq[0]))), true);
          track(geniusMulti(G.gq[0]), true);
        } else {
          if (!lite) { wsLaunched = true; track(webSearch(G.gq[0]), true); }
          track(geniusSong(G.gq[0]), true);
        }
      }
      track(kugouSearch(G.gq[0] || G.clean.title, meta.dur));
      track(scEnrich(), false, true);
      if (!lite) {
        // v3.1: the big synced catalogs race from t=0 too — staggering them
        // was a VPN-era politeness that just made every search feel slow
        const h0w = G.hints[0];
        // MXM's matcher handles fuzz server-side and is often the fastest
        // SYNCED source on restrictive networks — always worth wave 1
        mxmLaunched = true;
        track(MXM.find({ artist: (h0w && h0w.a) || '', track: G.clean.title, dur: meta.dur > 0 ? meta.dur : 0 }));
        neteaseLaunched = true;
        track(neteaseSearch(G.gq[0] || G.clean.title, meta.dur));
      }

      if (!lite) {
        // wave 1.5 — only if nothing strong yet
        after(() => {
          if (done || strong()) return;
          if (G.gq[0] && Gmode.get() === 'direct') track(geniusMulti(G.gq[0]), true);
          const h0 = G.hints[0];
          if (h0 && h0.conf >= 0.55) track(lrcSearch({ track: G.clean.title, artist: h0.a }));
          track(itunesCanonical(), false, true);
        }, 400);

        // wave 1.8 — web search joins; anything wave 1 skipped catches up
        after(() => {
          if (done || strong()) return;
          if (G.gq[0] && !wsLaunched) { wsLaunched = true; track(webSearch(G.gq[0]), true); }
          const th = G.hints[0];
          if (!mxmLaunched && th && th.conf >= 0.6) { mxmLaunched = true; track(MXM.find({ artist: th.a, track: G.clean.title, dur: meta.dur > 0 ? meta.dur : 0 })); }
          if (!neteaseLaunched) { neteaseLaunched = true; track(neteaseSearch(G.gq[0] || G.clean.title, meta.dur)); }
          if (G.lq[1]) track(lrcSearch({ q: G.lq[1] }));
        }, 900);

        // wave 2.2 — messy-title rescue: on these underground uploads the
        // dash-split often fails, but the UPLOADER is the real artist. Try
        // the bare title against the uploader directly across catalogs.
        after(() => {
          if (done || strong()) return;
          const up = uploaderCore(meta.uploader) || deFancy(String(meta.uploader || '')).trim();
          const bare = G.clean.bare || G.clean.title;
          if (up && up.length > 1 && !G.hints.some((h) => normKey(h.a) === normKey(up))) {
            track(lrcSearch({ track: bare, artist: up }));
            track(MXM.find({ artist: up, track: bare, dur: meta.dur > 0 ? meta.dur : 0 }));
            track(neteaseSearch((up + ' ' + bare).trim(), meta.dur));
          }
          // last-ditch bare-title-only LRCLIB (catches single-word/odd titles)
          if (bare && bare.length > 2) track(lrcSearch({ q: bare }));
        }, 1700);

        [700, 1600, 3000, 5400].forEach((ms) => after(() => judge(), ms));
        after(finalEffort, 7400);
      } else {
        // pre-warm: short fuse, no escalation — best-effort wave 1 only
        [1400, 2800].forEach((ms) => after(() => judge(), ms));
        after(finalEffort, 4800);
      }

      if (!total) finish(null);
    });
  }

  /* ------------------------------------------------------------------ *
   *  7. CACHE — GM LRU + session miss cache + in-flight dedupe
   * ------------------------------------------------------------------ */

  const Cache = (() => {
    const PFX = 'sl4:', IDX = 'sl4:idx', MAX = 300;   // extension shares SC's quota — leave headroom
    try {
      if (typeof GM_listValues === 'function' && !GM_getValue('sl4:mig')) {
        GM_listValues().forEach((k) => { if (String(k).indexOf('sl3:') === 0) GM_deleteValue(k); });
        GM_setValue('sl4:mig', 1);
      }
    } catch (e) {}
    const idx = () => { try { return GM_getValue(IDX, []); } catch (e) { return []; } };
    const setIdx = (v) => { try { GM_setValue(IDX, v); } catch (e) {} };
    let keys = null;   // mirror of idx for O(1) existence checks (no full-entry reads)
    const keySet = () => { if (!keys) keys = new Set(idx()); return keys; };
    return {
      has(key) { try { return GM_getValue(PFX + key, null) != null; } catch (e) { return false; } },   // the store, not this tab's mirror
      get(key) {
        try { return GM_getValue(PFX + key, null) || null; } catch (e) { return null; }
      },
      set(key, val) {
        try {
          GM_setValue(PFX + key, val);
          if (GM_getValue(PFX + key, null) == null) return;   // the write was shed under quota pressure — nothing to index
          let i = idx();
          if (i[i.length - 1] !== key) {   // skip the index rewrite when already most-recent
            i = i.filter((k) => k !== key);
            i.push(key);
            while (i.length > MAX) { const old = i.shift(); GM_deleteValue(PFX + old); keySet().delete(old); }
            setIdx(i);
          }
          keySet().add(key);
        } catch (e) {}
      },
      del(key) {
        try { GM_deleteValue(PFX + key); setIdx(idx().filter((k) => k !== key)); keySet().delete(key); } catch (e) {}
      },
      clear() {
        try { idx().forEach((k) => GM_deleteValue(PFX + k)); setIdx([]); keys = new Set(); } catch (e) {}
      },
    };
  })();

  /* Misses persist across sessions now: a beat-heavy library used to re-run
   * the full multi-provider race (~11s, dozens of requests) for the SAME
   * lyricless tracks every browser restart. 48h TTL; Retry / manual pick /
   * "Clear lyrics cache" all clear the flag. */
  const Miss = (() => {
    const m = new Map(); const TTL = 10 * 60 * 1000;
    const PKEY = 'sl4:miss', PTTL = 48 * 3600000, PMAX = 500;
    let stored = null;
    const load = () => {
      if (!stored) { try { stored = GM_getValue(PKEY, {}) || {}; } catch (e) { stored = {}; } }
      return stored;
    };
    const save = () => {
      try {
        const s = load();
        const ks = Object.keys(s);
        if (ks.length > PMAX) {
          ks.sort((a, b) => s[a] - s[b]);
          for (let i = 0; i < ks.length - PMAX; i++) delete s[ks[i]];
        }
        GM_setValue(PKEY, s);
      } catch (e) {}
    };
    return {
      has: (k) => {
        const t = m.get(k);
        if (t && Date.now() - t <= TTL) return true;
        if (t) m.delete(k);
        const s = load();
        if (s[k] && Date.now() - s[k] <= PTTL) return true;
        if (s[k]) { delete s[k]; save(); }
        return false;
      },
      add: (k) => { m.set(k, Date.now()); const s = load(); s[k] = Date.now(); save(); },
      del: (k) => { m.delete(k); const s = load(); if (s[k]) { delete s[k]; save(); } },
      clearAll: () => { m.clear(); stored = {}; try { GM_setValue(PKEY, {}); } catch (e) {} },
    };
  })();

  const Inflight = new Map();

  /* ------------------------------------------------------------------ *
   *  8. UI
   * ------------------------------------------------------------------ */

  const SRC_NAME = { genius: 'Genius', lrclib: 'LRCLIB', kugou: 'Kugou', netease: 'NetEase', mxm: 'Musixmatch', ovh: 'Lyrics.ovh', file: 'Your file', paste: 'Pasted', scdesc: 'SC description' };

  const CSS = `
/*!__SUITE_CSS_BEGIN__*/
:host { all: initial; --acc: #ff5500; --acc2: #ff8a3d; }
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
button { font: inherit; background: none; border: 0; cursor: pointer; color: inherit; }

.panel {
  position: fixed; right: 12px; bottom: 58px; z-index: 2147483000;
  width: 300px; max-height: min(46vh, 430px);
  display: flex; flex-direction: column;
  background: rgba(16,16,19,0.9);
  -webkit-backdrop-filter: blur(40px) saturate(175%); backdrop-filter: blur(40px) saturate(175%);
  border-radius: 26px;
  box-shadow: 0 24px 64px -22px rgba(0,0,0,0.66);
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, 'Segoe UI', Roboto, sans-serif;
  color: #f2f2f4;
  opacity: 0; transform: translateY(12px) scale(0.96); pointer-events: none;
  transition: opacity 0.2s ease, transform 0.26s cubic-bezier(0.34, 1.35, 0.4, 1), width 0.22s ease, max-height 0.22s ease;
}
/* settings + stats are content-heavy — give them a roomier panel so they breathe */
.panel.data { width: 352px; max-height: min(80vh, 720px); }
/* the equalizer needs width for 10 faders — give the Audio tab the widest panel */
.panel.audio { width: 432px; max-height: min(84vh, 780px); }
.panel::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit; padding: 1px;
  background: rgba(255,255,255,0.07);   /* calm hairline edge, no gradient sheen */
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  pointer-events: none;
}
.panel.open { opacity: 1; transform: none; pointer-events: auto; }

.glow { position: absolute; top: -50px; left: -30px; right: -30px; height: 200px; background: center/cover no-repeat; filter: blur(54px) saturate(190%) brightness(0.9); opacity: 0; transition: opacity 0.7s ease; pointer-events: none; }
.panel.haz .glow { opacity: 0.34; }

.hdr { position: relative; z-index: 1; display: flex; align-items: center; gap: 9px; padding: 12px 10px 11px 13px; flex: none; user-select: none; }
.hdr::after { content: ''; position: absolute; left: 15px; right: 15px; bottom: 0; height: 1px; background: rgba(255,255,255,0.045); }
.prog { position: absolute; left: 15px; bottom: 0; height: 2px; width: 0%; max-width: calc(100% - 30px); background: var(--acc); border-radius: 2px; z-index: 1; }
.tm { font-size: 9.5px; font-weight: 600; color: #74747b; font-variant-numeric: tabular-nums; flex: none; margin-right: 2px; letter-spacing: 0.02em; opacity: .8; }

.art { position: relative; width: 34px; height: 34px; border-radius: 10px; flex: none; background: rgba(255,255,255,0.04); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.07); display: grid; place-items: center; color: #5c5c63; overflow: hidden; }
.art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.art svg { width: 15px; height: 15px; }
.eq { position: absolute; right: 3px; bottom: 3px; display: flex; gap: 2px; align-items: flex-end; height: 10px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6)); }
.eq i { width: 2.5px; border-radius: 2px; background: linear-gradient(180deg, var(--acc2), var(--acc)); height: 30%; animation: eq 0.9s ease-in-out infinite; }
.eq i:nth-child(2) { animation-delay: 0.22s; }
.eq i:nth-child(3) { animation-delay: 0.44s; }
.panel:not(.playing) .eq i { animation-play-state: paused; height: 26%; }
@keyframes eq { 0%, 100% { height: 26%; } 50% { height: 100%; } }

.meta { flex: 1; min-width: 0; }
.tt { font-size: 12.5px; font-weight: 680; letter-spacing: -0.2px; color: #f3f3f5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.src { font-size: 10.5px; font-weight: 500; letter-spacing: 0.1px; color: #83838c; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color .2s ease; }
.src .dot { color: var(--acc2); }
.src.lk { cursor: pointer; }
.src.lk:hover { color: #c9c9cf; }
.hbtn { width: 25px; height: 25px; flex: none; border-radius: 9px; display: grid; place-items: center; color: #82828a; transition: background .16s ease, color .16s ease, transform .12s ease; }
.hbtn:hover { background: rgba(255,255,255,0.07); color: #f3f3f5; }
.hbtn:active { transform: scale(0.9); }
.hbtn svg { width: 14.5px; height: 14.5px; display: block; }
@keyframes slpulse { 50% { opacity: 0.4; } }

.body { position: relative; z-index: 1; overflow-y: auto; overscroll-behavior: contain; padding: 14px 10px 26px; scrollbar-width: none; flex: 1; min-height: 96px;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 28px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 28px), transparent 100%); }
.body::-webkit-scrollbar { display: none; }

.line, .sec, .dots { animation: lin 0.38s ease both; }
@keyframes lin { from { opacity: 0; } }

.line { padding: 7px 14px; border-radius: 10px; font-size: var(--fs, 16px); line-height: 1.5; font-weight: 600; letter-spacing: 0.1px; color: #7d7d86; transition: color 0.3s cubic-bezier(.22,1,.36,1), opacity .3s ease, transform 0.32s cubic-bezier(.22,1,.36,1); transform-origin: left center; }
.line.sk-click { cursor: pointer; }
.line.sk-click:hover:not(.act) { color: #d8d8de; transform: translateX(1px); }
.line.past { color: #4c4c53; }
.line.act {
  color: transparent;
  /* TRUE karaoke wipe: --fill (0→100%) is driven every frame from the real
     playback position WITHIN this line, so the bright "sung" portion sweeps
     left→right exactly in time with the music — sung text white, not-yet gray */
  background: linear-gradient(90deg, #ffffff 0%, #ffe9d6 calc(var(--fill, 0%) - 1.5%), var(--acc2) var(--fill, 0%), #83838d calc(var(--fill, 0%) + 0.5%), #83838d 100%);
  -webkit-background-clip: text; background-clip: text;
  transform: translateX(2px) scale(1.015);
  filter: drop-shadow(0 1px 9px rgba(255, 120, 0, 0.09));
  font-weight: 700;
  /* no fade-in and a near-instant colour flip: the line must read as lit on the very frame the
     word is heard (a 340 ms fade + 300 ms colour ease made every line land a third of a second
     late at lead 0). Leaving .act keeps the slower .line ease, so past lines still dim gently. */
  transition: color 0.06s linear, opacity 0.1s ease, transform 0.22s cubic-bezier(.22,1,.36,1);
}
@supports not (-webkit-background-clip: text) { .line.act { color: #fff; background: none; } }
.line.u { font-weight: 500; color: #c9c9cf; cursor: default; padding: 4px 14px; font-size: calc(var(--fs, 16px) - 1px); opacity: .92; }
.tline { padding: 0 14px 5px; margin-top: -3px; font-size: calc(var(--fs, 16px) - 4px); line-height: 1.35; font-weight: 500; font-style: italic; color: #6f6f78; letter-spacing: 0.1px; animation: lin 0.38s ease both; }
.line.act + .tline { color: #9a9aa2; }
/* premium custom range sliders + select chevron (Audio tab) */
.sxr { -webkit-appearance: none; appearance: none; height: 5px; border-radius: 5px; outline: none; cursor: pointer; background: rgba(255,255,255,0.13); }
.sxr::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0,0,0,0.55); transition: box-shadow 0.15s ease, transform 0.1s ease; cursor: grab; }
.sxr::-webkit-slider-thumb:hover { box-shadow: 0 2px 7px rgba(0,0,0,0.5); transform: scale(1.18); }
.sxr:active::-webkit-slider-thumb { cursor: grabbing; transform: scale(1.06); }
.sxsel { -webkit-appearance: none; appearance: none; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a0a0a8' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>"); background-repeat: no-repeat; background-position: right 11px center; padding-right: 30px !important; }
.sec { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #5d5d65; padding: 18px 16px 4px; opacity: .7; }
.gap { height: 8px; }

.dots { display: flex; gap: 6px; align-items: center; padding: 10px 15px; cursor: pointer; }
.dots i { width: 5px; height: 5px; border-radius: 50%; background: #505057; transition: background 0.25s ease, transform 0.25s ease; }
.dots:hover i { background: #74747c; }
.dots.past i { background: #3e3e44; }
.dots.act i { background: var(--acc); animation: dotp 1.05s ease-in-out infinite; }
.dots.act i:nth-child(2) { animation-delay: 0.18s; }
.dots.act i:nth-child(3) { animation-delay: 0.36s; }
@keyframes dotp { 0%, 100% { transform: scale(0.8); opacity: 0.55; } 50% { transform: scale(1.3); opacity: 1; } }

.state { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 8px; text-align: center; padding: 22px 20px 16px; color: #8b8b91; }
.state .ic { color: #46464c; }
.state .ic svg { width: 26px; height: 26px; }
.state .h { font-size: 14px; font-weight: 680; color: #e6e6ea; letter-spacing: -0.1px; }
.state .p { font-size: 11.5px; line-height: 1.55; max-width: 250px; }
/* the No-lyrics / error states stack up to 4 buttons — they MUST wrap inside
   the panel, never overflow off the right edge (was the "weird buttons" bug) */
.row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; justify-content: center; max-width: 100%; }
.btn { font-size: 11.5px; font-weight: 650; letter-spacing: .1px; color: #eaeaee; background: rgba(255,255,255,0.07); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08); padding: 7px 15px; border-radius: 99px; transition: background 0.15s ease, transform 0.12s ease, box-shadow .15s ease; white-space: nowrap; }
.btn:hover { background: rgba(255,255,255,0.13); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14); }
.btn:active { transform: scale(0.95); }
.btn.acc { background: var(--acc); box-shadow: none; color: #fff; }
.btn.acc:hover { background: var(--acc2); box-shadow: none; }

.sk { height: 12px; border-radius: 7px; margin: 15px 14px 0;
  background: linear-gradient(90deg, rgba(255,255,255,0.045) 25%, rgba(255,255,255,0.11) 50%, rgba(255,255,255,0.045) 75%);
  background-size: 200% 100%; animation: shim 1s linear infinite; }
@keyframes shim { from { background-position: 200% 0; } to { background-position: -200% 0; } }

.srch { position: relative; z-index: 1; padding: 10px 11px 6px; display: flex; gap: 8px; flex: none; }
.inp { flex: 1; min-width: 0; font: inherit; font-size: 12.5px; color: #fff; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.09); border-radius: 11px; padding: 7.5px 11px; outline: none; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.inp:focus { border-color: rgba(255,85,0,0.55); box-shadow: 0 0 0 3px rgba(255,85,0,0.13); }
.inp::placeholder { color: #6a6a71; }
.go { flex: none; width: 34px; border-radius: 11px; background: var(--acc); color: #fff; display: grid; place-items: center; box-shadow: none; transition: background 0.15s ease, transform 0.12s ease; }
.go:hover { background: var(--acc2); }
.go:active { transform: scale(0.94); }
.go svg { width: 14px; height: 14px; }

.res { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 7px 13px; border-radius: 12px; transition: background 0.14s ease; animation: lin 0.3s ease both; }
.res:hover { background: rgba(255,255,255,0.06); }
.rimg { flex: none; width: 28px; height: 28px; border-radius: 7px; background: #232327 center/cover no-repeat; display: grid; place-items: center; color: #5c5c63; overflow: hidden; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06); }
.rimg img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rimg svg { width: 13px; height: 13px; }
.rwrap { min-width: 0; flex: 1; }
.rt { font-size: 12.5px; font-weight: 600; color: #ececf0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ra { font-size: 10.5px; color: #84848a; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { flex: none; font-size: 8.5px; font-weight: 800; letter-spacing: 0.08em; padding: 3px 6px; border-radius: 5px; background: rgba(255,255,255,0.08); color: #a0a0a7; }
.badge.sync { background: rgba(255,85,0,0.15); color: #ff8345; }

.qdot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
.nxt { position: relative; z-index: 1; flex: none; padding: 5px 13px 7px; font-size: 10px; font-weight: 600; letter-spacing: 0.02em; color: #9a9aa2; border-top: 1px solid rgba(255,255,255,0.05); display: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nxt.show { display: block; }
.nxt { cursor: pointer; }
.nxt:hover b { color: #fff; }
.nxt b { color: #c9c9cf; font-weight: 650; }
.nxt .zap { color: var(--acc2); }
.toast { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%) translateY(6px); background: rgba(30,30,34,0.97); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.09), 0 8px 24px rgba(0,0,0,0.45); color: #ececf0; font-size: 11px; font-weight: 600; letter-spacing: .1px; padding: 6px 13px; border-radius: 99px; opacity: 0; pointer-events: none; transition: opacity 0.18s ease, transform 0.18s ease; white-space: nowrap; max-width: calc(100% - 24px); overflow: hidden; text-overflow: ellipsis; -webkit-backdrop-filter: blur(20px) saturate(160%); backdrop-filter: blur(20px) saturate(160%); }
.toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }

.dghead { padding: 12px 14px 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #6e6e75; }
.dg { padding: 4px 14px; display: flex; align-items: center; gap: 9px; font-size: 11.5px; color: #b9b9c0; animation: lin 0.3s ease both; }
.dg b { font-weight: 650; color: #e8e8ec; white-space: nowrap; }
.dg .why { color: #8b8b91; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dg .st { flex: none; width: 15px; text-align: center; font-weight: 800; }
.dg.ok .st { color: #36d399; }
.dg.bad .st { color: #ff5d5d; }
.dg .ms { margin-left: auto; font-size: 10px; color: #6c6c73; flex: none; }

.fab { position: fixed; right: 12px; bottom: 58px; z-index: 2147482999; pointer-events: auto; width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(180deg, rgba(26,26,30,0.94), rgba(14,14,16,0.96)); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); box-shadow: inset 0 1px 0 rgba(255,255,255,0.1), 0 10px 28px rgba(0,0,0,0.45); color: #d7d7dc; display: none; place-items: center; transition: color 0.15s ease, transform 0.15s ease; }
.fab:hover { color: #fff; transform: translateY(-1px); }
.fab.show { display: grid; }
.fab.on { color: var(--acc); }
.fab svg { width: 17px; height: 17px; }
.fab .rdy { position: absolute; top: 7px; right: 7px; width: 6px; height: 6px; border-radius: 50%; background: var(--acc); box-shadow: 0 0 6px rgba(255,85,0,0.8); display: none; }
.fab.has .rdy { display: block; }

/* ── hub: clean underline tabs (accent only under the active one) ── */
.tabs { position: relative; z-index: 1; display: flex; gap: 2px; padding: 9px 14px 0; flex: none; box-shadow: inset 0 -1px 0 rgba(255,255,255,0.06); }
.tab { position: relative; flex: 1; font-size: 11px; font-weight: 550; letter-spacing: 0.2px; color: #83838b; padding: 7px 2px 11px; border-radius: 0; transition: color .18s ease; }
.tab:hover { color: #c7c7cd; }
.tab.on { color: #f3f3f5; }
.tab.on::after { content: ''; position: absolute; left: 50%; bottom: -1px; transform: translateX(-50%); width: 60%; max-width: 32px; height: 2px; border-radius: 2px; background: var(--acc); }
.tdot { display: none; }

/* ── overflow menu ── */
.menu { position: absolute; top: 46px; right: 10px; z-index: 7; min-width: 206px; padding: 5px; border-radius: 15px;
  background: rgba(21,21,25,0.98); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.07), 0 18px 46px -10px rgba(0,0,0,0.6); display: none; }
.menu.on { display: block; animation: lin .15s ease both; }
.mi { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; font-size: 11.5px; font-weight: 550; color: #dcdce2; padding: 7px 11px; border-radius: 10px; transition: background .13s ease; }
.mi:hover { background: rgba(255,255,255,0.08); }
.mi .k { margin-left: auto; font-size: 9px; color: #707078; }
.msep { height: 1px; background: rgba(255,255,255,0.07); margin: 5px 8px; }

/* ── back-to-live chip ── */
.chip { position: absolute; left: 50%; bottom: 44px; transform: translateX(-50%); z-index: 4; font-size: 10.5px; font-weight: 650; color: #fff;
  background: var(--acc); padding: 6px 14px; border-radius: 99px; box-shadow: 0 6px 18px -5px rgba(0,0,0,.55); display: none; }
.chip.on { display: block; animation: lin .2s ease both; }

/* ── resize grip ── */
.grip { position: absolute; right: 2px; bottom: 2px; width: 18px; height: 18px; z-index: 6; cursor: nwse-resize; opacity: .35; touch-action: none; }
.grip::after { content: ''; position: absolute; right: 5px; bottom: 5px; width: 8px; height: 8px; border-right: 2px solid #9a9aa2; border-bottom: 2px solid #9a9aa2; border-radius: 2px; }
.grip:hover { opacity: .9; }
.panel.max .grip { display: none; }
.hdr { cursor: grab; touch-action: none; }
.hdr:active { cursor: grabbing; }
.hdr .hbtn, .hdr .art { cursor: pointer; }

/* ── immersive fullscreen ── */
.panel.max { left: 4vw !important; right: 4vw !important; top: 4vh !important; bottom: 9vh !important; width: auto !important; height: auto !important; max-height: none !important; border-radius: 26px; }
.panel.max .body { padding: 4vh 10vw 16vh;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 7%, #000 86%, transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 7%, #000 86%, transparent 100%); }
.panel.max .line { font-size: calc(var(--fs, 16px) * 1.9); line-height: 1.5; padding: 10px 18px; border-radius: 14px; }
.panel.max .line.u { font-size: calc(var(--fs, 16px) * 1.55); }
.panel.max .sec { font-size: 13px; }
/* immersive: don't let the 5 tabs stretch edge-to-edge — keep them a tidy
   centered group (full-width hairline stays), and scale the header up to match */
.panel.max .tabs { justify-content: center; gap: 34px; padding-top: 11px; }
.panel.max .tab { flex: 0 0 auto; padding: 8px 8px 13px; font-size: 12px; }
.panel.max .hdr { padding: 18px 24px 15px; }
.panel.max .hdr::after { left: 24px; right: 24px; }
.panel.max .prog { left: 24px; max-width: calc(100% - 48px); }
.panel.max .tt { font-size: 15px; }
.panel.max .src { font-size: 11.5px; margin-top: 4px; }
.panel.max .art { width: 38px; height: 38px; }
/* immersive: the DATA tabs (queue/stats/tweaks/audio) must NOT stretch edge-to-edge
   like the lyrics — keep their content in a tidy centered column (!important beats
   the inline padding the render fns set) */
.panel.max #qbody, .panel.max #sbody, .panel.max #ebody, .panel.max #abody {
  max-width: 760px; margin-left: auto; margin-right: auto; padding: 22px 20px 44px !important; }
.panel.max .glow { height: 65%; top: -12%; }
.panel.max.haz .glow { opacity: 0.42; }

/* ── hotkey cheat sheet ── */
.keys { position: absolute; inset: 0; z-index: 8; background: rgba(10,10,12,0.85); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  display: none; flex-direction: column; justify-content: center; padding: 18px 26px; cursor: pointer; }
.keys.on { display: flex; animation: lin .15s ease both; }
.keys h3 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #9a9aa2; margin-bottom: 10px; font-weight: 700; }
.krow { display: flex; align-items: center; gap: 10px; padding: 3.5px 0; font-size: 11.5px; color: #c9c9cf; }
.krow b { font-weight: 650; min-width: 96px; color: #fff; font-size: 10.5px; flex: none; }
.krow b i { font-style: normal; display: inline-block; background: rgba(255,255,255,0.1); border-radius: 5px; padding: 1px 6px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08); }

/* ── command palette (⌘K) ── always dark for contrast, sits above everything ── */
.cmdk { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: flex-start; justify-content: center; background: rgba(7,7,10,0.5); backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px); pointer-events: auto; }
.cmdk.on { display: flex; animation: lin .12s ease both; }
.cmdkbox { margin-top: 11vh; width: min(540px, 92vw); max-height: 64vh; display: flex; flex-direction: column; background: #16171d; border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; box-shadow: 0 32px 90px rgba(0,0,0,0.62); overflow: hidden; }
.cmdkin { border: 0; outline: 0; background: transparent; color: #fff; font: inherit; font-size: 15px; padding: 15px 18px; border-bottom: 1px solid rgba(255,255,255,0.08); width: 100%; box-sizing: border-box; }
.cmdkin::placeholder { color: #74747d; }
.cmdklist { overflow-y: auto; padding: 6px; }
.cmdkit { display: flex; align-items: center; gap: 11px; padding: 9px 12px; border-radius: 10px; cursor: pointer; color: #ccccd3; }
.cmdkit .ci { flex: none; width: 20px; text-align: center; opacity: .82; font-size: 13px; }
.cmdkit .cl { flex: 1; min-width: 0; font-size: 13px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cmdkit .ch { flex: none; font-size: 9.5px; color: #7b7b84; text-transform: uppercase; letter-spacing: .06em; }
.cmdkit.sel { background: linear-gradient(135deg, rgba(255,90,0,0.22), rgba(255,138,61,0.15)); color: #fff; }
.cmdkit.sel .ch { color: #ffb48a; }
.cmdkempty { padding: 22px; text-align: center; color: #74747d; font-size: 12.5px; }

/* ── queue & stats tabs ── */
.qhead { padding: 20px 16px 8px; font-size: 9.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #76767e; display: flex; align-items: center; gap: 8px; }
.qhead::before { content: ''; width: 10px; height: 2px; border-radius: 2px; background: rgba(255,255,255,0.16); flex: none; }
.stathero { margin: 14px 12px 2px; padding: 16px 18px; border-radius: 15px; background: rgba(255,255,255,0.04); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06); }
.stathero .sh-big { font-size: 30px; font-weight: 750; letter-spacing: -1px; line-height: 1.05; color: #f3f3f5; font-variant-numeric: tabular-nums; }
.stathero .sh-sub { font-size: 11.5px; color: #8a8a92; margin-top: 4px; font-weight: 500; }
.panel.lite .stathero { background: rgba(0,0,0,0.035); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.05); }
.panel.lite .stathero .sh-big { color: #1b1b1f; }
.panel.lite .stathero .sh-sub { color: #6a6a72; }
.qrow { display: flex; align-items: center; gap: 9px; padding: 6px 14px; border-radius: 9px; font-size: 12px; color: #b9b9c0; transition: background .14s ease; }
.qrow .n { flex: none; width: 30px; text-align: right; font-size: 10px; color: #6c6c73; font-variant-numeric: tabular-nums; }
.qrow .qt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 550; }
.qrow .qa { flex: none; max-width: 38%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 10.5px; color: #84848a; }
.qrow.now { background: rgba(255,255,255,0.07); color: #fff; box-shadow: inset 2px 0 0 var(--acc); }
.qrow.ch { cursor: pointer; }
.line.sel { background: rgba(255,85,0,0.16); color: #fff; box-shadow: inset 3px 0 0 var(--acc); }
.sharebar { position: absolute; left: 10px; right: 10px; bottom: 10px; z-index: 6; display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 14px; background: rgba(18,18,22,0.97); box-shadow: 0 12px 34px rgba(0,0,0,0.45); font-size: 11.5px; color: #cfcfd6; }
.sharebar canvas { width: 46px; height: 46px; border-radius: 9px; flex: none; background: #222; }
.sharebar .st { flex: 1; min-width: 0; line-height: 1.35; }
.sharebar .st b { display: block; color: #fff; font-size: 12px; }
.sharebar .btn { padding: 7px 11px; }
.qrow.ch:hover { background: rgba(255,255,255,0.05); }
.qrow.ch:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
.qrow.ch .n { width: 50px; font-size: 10.5px; }
.qrow.ch.cue .qt::before { content: '◆ '; color: var(--acc); font-size: 9px; }
.qrow.ch .chx { flex: none; font-size: 10px; color: #7c7c84; padding: 2px 6px; border-radius: 6px; opacity: 0; }
.qrow.ch:hover .chx, .qrow.ch:focus-within .chx { opacity: 1; }
.qrow.ch .chx:hover { color: #fff; background: rgba(255,255,255,0.1); }
.sgrid { display: flex; padding: 4px 12px; gap: 7px; }
.scell { flex: 1; text-align: center; padding: 11px 0 9px; }
.scell .v { font-size: 21px; font-weight: 650; letter-spacing: -.02em; color: #edeef1; font-variant-numeric: tabular-nums; }
.scell .l { font-size: 9.5px; color: #82828a; margin-top: 3px; letter-spacing: .05em; }
.sbtns { display: flex; gap: 6px; padding: 8px 14px; flex-wrap: wrap; }
.sbtn { font-size: 10.5px; font-weight: 650; color: #dcdce2; background: rgba(255,255,255,0.07); border-radius: 99px; padding: 5px 12px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06); }
.sbtn:hover { background: rgba(255,255,255,0.13); }

/* ── mini lyric bar: the current line floats above the player even with
      the panel closed; click it to open the full panel ── */
.mini { position: fixed; left: 50%; transform: translateX(-50%); bottom: 64px; z-index: 2147482998;
  max-width: min(62vw, 700px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px; font-weight: 650; letter-spacing: 0.1px; color: #f2f2f4; text-align: center;
  background: linear-gradient(180deg, rgba(22,22,26,0.92), rgba(12,12,14,0.95));
  padding: 8px 18px; border-radius: 99px;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.09), 0 10px 30px rgba(0,0,0,0.45);
  backdrop-filter: blur(18px) saturate(160%); -webkit-backdrop-filter: blur(18px) saturate(160%);
  display: none; pointer-events: auto; cursor: pointer; transition: box-shadow .15s ease; }
.mini.on { display: block; animation: lin .25s ease both; }
.mini:hover { box-shadow: inset 0 0 0 1px var(--acc), 0 10px 30px rgba(0,0,0,0.45); }

/* ── sync wizard chip ── */
.wchip { position: absolute; left: 50%; bottom: 78px; transform: translateX(-50%); z-index: 5; max-width: calc(100% - 30px);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 10.5px; font-weight: 650; color: #fff;
  background: rgba(20,20,24,0.98); box-shadow: inset 0 0 0 1px rgba(255,90,0,0.5), 0 8px 24px -6px rgba(0,0,0,.55);
  padding: 7px 14px; border-radius: 99px; display: none; cursor: pointer; }
.wchip.on { display: block; animation: lin .2s ease both; }
.wchip:hover { background: rgba(30,30,35,0.98); }

/* ── focus (karaoke) mode: only the sung line matters ── */
.panel.focus .line:not(.act) { opacity: .28; }
.panel.focus .line.past { opacity: .14; }
.panel.focus .sec, .panel.focus .dots { opacity: .25; }

/* ── busy fab + scrollable menu ── */
.fab.busy { animation: slpulse 1.1s ease-in-out infinite; }
.menu { max-height: calc(100% - 58px); overflow-y: auto; }

/* ── search duration agreement ── */
.ra .dgood { color: #3ddc84; font-weight: 700; }
.ra .dok { color: #ffb454; }
.ra .dbad { color: #97979e; }

/* ── v3.6 minimal pass: the accent belongs to the MUSIC (active line,
      progress, glow) — the chrome stays quiet, soft and airy.
      (Rules that just retuned base values were merged into their bases;
      what's left below is genuinely new selectors / class composes.) */
/* the action cluster keeps the 4 icons tight so the title isn't crushed on
   the compact 300px panel (was: 7 evenly-gapped header items) */
.hactions { display: flex; align-items: center; gap: 0; flex: none; }
.hactions .tm { margin-right: 4px; }
.panel.max.haz .glow { opacity: 0.48; }
.qhead { opacity: .85; }   /* .sec opacity moved to base def (was .85 here + .7 in v3.8-coh; .7 won — kept) */
.scell { background: rgba(255,255,255,0.035); border-radius: 13px; margin: 0; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05); transition: background .15s ease; }
.scell:hover { background: rgba(255,255,255,0.06); }
.panel.max .hdr, .panel.max .tabs, .panel.max .nxt, .panel.max .grip { transition: opacity .45s ease; }
.panel.max.idle { cursor: none; }
.panel.max.idle .hdr, .panel.max.idle .tabs, .panel.max.idle .nxt { opacity: 0; pointer-events: none; }
.spark.hrs { height: 24px; gap: 1.5px; }
.spark.hrs b { border-radius: 2px 2px 1px 1px; }
.line.tapnext { color: #fff; background: rgba(255,85,0,0.16); box-shadow: inset 0 0 0 1px var(--acc); }
.panel.lite .line.tapnext { color: #111; background: rgba(255,85,0,0.12); }

/* ── v3.7 personalization: backdrop density · font family · comfort ── */
.panel.g-solid { background: linear-gradient(180deg, rgba(18,18,22,0.98), rgba(9,9,11,0.99)); -webkit-backdrop-filter: blur(8px) saturate(150%); backdrop-filter: blur(8px) saturate(150%); }
.panel.g-ghost { background: linear-gradient(180deg, rgba(20,20,24,0.62), rgba(11,11,13,0.72)); -webkit-backdrop-filter: blur(60px) saturate(190%); backdrop-filter: blur(60px) saturate(190%); }
.panel.lite.g-solid { background: linear-gradient(180deg, rgba(252,252,253,0.99), rgba(243,243,247,1)); }
.panel.lite.g-ghost { background: linear-gradient(180deg, rgba(252,252,253,0.66), rgba(243,243,247,0.76)); }
.panel.f-serif .line, .panel.f-serif .tt { font-family: 'New York', 'Iowan Old Style', Georgia, 'Times New Roman', serif; letter-spacing: 0; }
.panel.f-rounded .line, .panel.f-rounded .tt { font-family: ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', 'Quicksand', system-ui, sans-serif; }
.panel.f-mono .line, .panel.f-mono .tt { font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', 'Menlo', monospace; letter-spacing: -0.4px; }
.panel.comfy .line { padding-top: 12px; padding-bottom: 12px; }
.panel.comfy .body { padding-top: 18px; }

/* ── v3.7 beautification: calmer chrome, richer focus on the sung line ──
   (most rules from this block were merged into their base definitions; the
   ones that remain add NEW selectors or compose with classes the base lacks) */
.line:not(.act):not(.u) { letter-spacing: 0.1px; }
.body::-webkit-scrollbar { width: 0; }
.wchip, .chip { font-weight: 650; letter-spacing: .1px; }
.scell .v { letter-spacing: -0.3px; }
.state .ic svg { filter: drop-shadow(0 2px 8px rgba(0,0,0,0.3)); }

/* ── v3.8 cohesion: segmented tabs, tidy compact header, clean rhythm.
   (Single-selector tweaks were merged into their base definitions; only the
   composed .panel.lite descendants remain as theme-conditional overrides.) */
.panel.lite .tabs { background: none; box-shadow: inset 0 -1px 0 rgba(0,0,0,0.08); }
.panel.lite .tab.on { background: none; }

/* ── stats tab: sparkline + value chips (v2.3, migrated from the bar card) ── */
.spark { display: flex; gap: 3px; align-items: flex-end; height: 34px; padding: 6px 14px 0; }
.spark b { flex: 1; min-height: 3px; border-radius: 3px 3px 1px 1px; background: #65656d; opacity: .55; transition: opacity .15s ease, background .15s ease; }
.spark b:hover { opacity: .9; }
.spark b.today { background: var(--acc); opacity: 1; box-shadow: none; }
.sparkl { display: flex; gap: 3px; padding: 2px 14px 0; font-size: 8px; color: #6c6c73; letter-spacing: .04em; }
.sparkl span { flex: 1; text-align: center; }
.sparkl span:first-child { text-align: left; }
.sparkl span:last-child { text-align: right; }
.qv { flex: none; font-size: 10px; color: #6c6c73; font-variant-numeric: tabular-nums; }
.qrow:hover { background: rgba(255,255,255,0.04); }

/* ── light theme ── */
.panel.lite { background: linear-gradient(180deg, rgba(252,252,253,0.92), rgba(243,243,247,0.96)); color: #1b1b1f; }
.panel.lite::before { background: linear-gradient(180deg, rgba(0,0,0,0.07), rgba(0,0,0,0.03) 35%, rgba(0,0,0,0.02)); }
.panel.lite .hdr::after { background: rgba(0,0,0,0.07); }
.panel.lite .src { color: #76767e; }
.panel.lite .tm { color: #82828a; }
.panel.lite .hbtn { color: #6b6b74; }
.panel.lite .hbtn:hover { background: rgba(0,0,0,0.06); color: #1b1b1f; }
.panel.lite .line { color: #9a9aa2; }
.panel.lite .line.past { color: #c6c6cd; }
.panel.lite .line.sk-click:hover:not(.act) { color: #4a4a52; }
.panel.lite .line.u { color: #3c3c44; }
.panel.lite .line.act { background: linear-gradient(90deg, #111114 0%, #2a1c12 calc(var(--fill, 0%) - 1.5%), var(--acc) var(--fill, 0%), #b4b4bc calc(var(--fill, 0%) + 0.5%), #b4b4bc 100%); -webkit-background-clip: text; background-clip: text; }
@supports not (-webkit-background-clip: text) { .panel.lite .line.act { color: #111; background: none; } }
.panel.lite .sec { color: #9a9aa2; }
.panel.lite .state { color: #76767e; }
.panel.lite .state .h { color: #2c2c33; }
.panel.lite .btn { color: #2c2c33; background: rgba(0,0,0,0.05); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.05); }
.panel.lite .btn:hover { background: rgba(0,0,0,0.09); }
.panel.lite .btn.acc { color: #fff; }
.panel.lite .inp { color: #1b1b1f; background: rgba(0,0,0,0.05); border-color: rgba(0,0,0,0.08); }
.panel.lite .inp::placeholder { color: #9a9aa2; }
.panel.lite .res:hover { background: rgba(0,0,0,0.05); }
.panel.lite .rt { color: #26262c; }
.panel.lite .tab { color: #82828a; }
.panel.lite .tab:hover { color: #3c3c44; }
.panel.lite .tab.on { color: #1b1b1f; background: none; box-shadow: none; }
.panel.lite .qrow { color: #4a4a52; }
.panel.lite .qrow.now { background: rgba(0,0,0,0.06); color: #111; }
.panel.lite .nxt { color: #76767e; border-top-color: rgba(0,0,0,0.06); }
.panel.lite .nxt b { color: #2c2c33; }
.panel.lite .nxt:hover b { color: #111; }
.panel.lite .toast { background: rgba(255,255,255,0.99); color: #1b1b1f; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.18); }
.panel.lite .menu { background: rgba(252,252,253,0.99); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.07), 0 16px 40px rgba(0,0,0,0.22); }
.panel.lite .mi { color: #2c2c33; }
.panel.lite .mi:hover { background: rgba(0,0,0,0.05); }
.panel.lite .msep { background: rgba(0,0,0,0.06); }
.panel.lite .keys { background: rgba(250,250,252,0.92); }
.panel.lite .krow { color: #3c3c44; }
.panel.lite .krow b { color: #111; }
.panel.lite .krow b i { background: rgba(0,0,0,0.06); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06); }
.panel.lite .keys h3 { color: #76767e; }
.panel.lite .sk { background: linear-gradient(90deg, rgba(0,0,0,0.045) 25%, rgba(0,0,0,0.1) 50%, rgba(0,0,0,0.045) 75%); background-size: 200% 100%; }
.panel.lite .dots i { background: #b9b9c0; }
.panel.lite .grip::after { border-color: #76767e; }
.panel.lite .sparkl, .panel.lite .qv { color: #9a9aa2; }
.panel.lite .spark b { opacity: .5; }
.panel.lite .qrow:hover { background: rgba(0,0,0,0.04); }
.panel.lite .scell { background: rgba(0,0,0,0.03); }
.panel.lite .scell .v { color: #1b1b1f; }
.panel.lite .qhead { color: #76767e; }
/* the Audio & Tweaks tabs are built with hard-coded DARK inline styles (white text on
   faint cards); on a LIGHT panel that's unreadable — give those two bodies a dark
   surface so the dark-built content reads correctly (clipped to the panel's radius) */
.panel.lite #abody, .panel.lite #ebody { background: #16171b; color: #e6e6ea; }

/* R32: visually-hidden live region for the active-line screen-reader announce */
.srl { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); border: 0; white-space: nowrap; }

/* ── lite-theme parity for the surfaces the original block missed: the track
   title (was white-on-cream — unreadable), the translation sub-lines under each
   lyric line, and the search-result source badges (almost-invisible #a0a0a7 on
   ~white otherwise) ── */
.panel.lite .tt { color: #1b1b1f; }
.panel.lite .tline { color: #4a4a52; }
.panel.lite .line.act + .tline { color: #2c2c33; }
.panel.lite .badge { background: rgba(0,0,0,0.06); color: #4a4a52; }
.panel.lite .badge.sync { background: rgba(255,85,0,0.12); color: #b54b00; }
.panel.lite .ra { color: #76767e; }
.panel.lite .dghead { color: #76767e; }
.panel.lite .dg b { color: #1b1b1f; }
.panel.lite .dg .why { color: #76767e; }
.panel.lite .dg .ms { color: #9a9aa2; }
/* Focus mode on LITE: the base focus rule (.panel.focus .line.past opacity:.14)
   collapsed past lines to almost-invisible cream-on-cream. Restore opacity to
   the same .28 the active surround uses, and pick a darker past color that
   actually reads on the cream panel (was #d6d6db — lighter than the non-focus
   .panel.lite .line.past at #c6c6cd, i.e. wrong direction). */
.panel.lite.focus .line.past { color: #9a9aa2; opacity: .28; }
.panel.lite.focus .line:not(.act):not(.past) { color: #4a4a52; }

/* ── R32 piece · focus-visible ring across the whole hub for keyboard a11y.
   Settings + shuffle popover already have their own focus rings; the hub
   itself shipped without any, so Tab through the panel was invisible. ── */
.hbtn:focus-visible,
.tab:focus-visible,
.mi:focus-visible,
.res:focus-visible,
.btn:focus-visible,
.fab:focus-visible,
.qrow:focus-visible,
.cmdkit:focus-visible,
.wchip:focus-visible,
.chip:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; border-radius: inherit; }
.panel.lite .hbtn:focus-visible,
.panel.lite .tab:focus-visible,
.panel.lite .mi:focus-visible,
.panel.lite .res:focus-visible,
.panel.lite .btn:focus-visible,
.panel.lite .qrow:focus-visible,
.panel.lite .cmdkit:focus-visible { outline: 2px solid #b54b00; outline-offset: 2px; }
/* on lite, the inputs already have their own border — keep the focus ring tight */
.panel.lite .inp:focus { outline: 2px solid #b54b00; outline-offset: 1px; }

/* ── Windows High Contrast / forced-colors mode — without this the whole panel
   collapses into a black box because every surface is a low-alpha rgba ── */
@media (forced-colors: active) {
  .panel { background: Canvas !important; color: CanvasText !important; box-shadow: none !important; outline: 1px solid CanvasText; }
  .panel::before { display: none; }
  .hdr::after, .nxt, .prog, .tabs { border-color: CanvasText !important; }
  .prog { background: Highlight !important; }
  .line.act { color: Highlight !important; -webkit-text-fill-color: Highlight !important; }
  .hbtn, .tab, .mi, .btn, .res, .qrow, .fab { color: CanvasText !important; background: ButtonFace !important; border: 1px solid ButtonBorder !important; }
  .hbtn:focus-visible, .tab:focus-visible, .mi:focus-visible, .res:focus-visible, .btn:focus-visible, .qrow:focus-visible, .fab:focus-visible { outline: 2px solid Highlight !important; outline-offset: 2px; }
  .badge, .badge.sync { color: CanvasText !important; background: ButtonFace !important; }
  .toast { background: Canvas !important; color: CanvasText !important; outline: 1px solid CanvasText !important; }
}

/* ── responsive across every desktop resolution ──
   inline width/height (saved size) always overrides these, so a custom-sized
   panel is untouched; defaults scale with the screen. */
@media (max-width: 600px) {
  .panel { right: 8px; left: 8px; width: auto; bottom: 70px; max-height: 44vh; }
  .fab { bottom: 70px; }
}
/* short laptop screens: keep it snug */
@media (max-height: 800px) {
  .panel { max-height: min(52vh, 400px); }
}
/* big displays: stay small and corner-tucked — only a gentle bump so the
   text isn't microscopic on 4K, never a large floating panel */
@media (min-width: 2400px) {
  .panel { width: 330px; max-height: min(48vh, 520px); }
}
@media (min-width: 3400px) {
  .panel { width: 360px; }
}
@media (prefers-reduced-motion: reduce) {
  .panel, .line, .hbtn, .btn, .toast, .fab, .go, .inp, .dots, .tab { transition: none !important; }
  .sk, .eq i, .dots i { animation: none !important; }
  .line, .sec, .dots, .res, .menu.on, .chip.on, .keys.on, .mini.on { animation: none !important; }
}
/*!__SUITE_CSS_END__*/
`;

  const ICONS = {
    lyrics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h13"/><path d="M4 11h10"/><path d="M4 16h7"/><path d="M19.5 15.8V7.3l1.6.5"/><circle cx="17.6" cy="16" r="2.1" fill="currentColor" stroke="none"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18.5V6l10-2v12.5"/><circle cx="6.6" cy="18.5" r="2.4"/><circle cx="16.6" cy="16.5" r="2.4"/></svg>',
    sad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M9.2 15.6c.8-.7 1.7-1.1 2.8-1.1s2 .4 2.8 1.1"/></svg>',
    off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M9 6l10-2v10"/><path d="M9 9.5V18.5"/><circle cx="6.6" cy="18.5" r="2.4"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>',
  };

  const UI = (() => {
    let root, panel, body, art, tt, src, toastEl, fab, barBtn, barDot, progEl, glowEl;
    let qbody, sbody, ebody, abody, tabsEl, tmEl, chipEl, menuEl, keysEl, gripEl, hdrEl, nxtEl, bMenuEl;
    let open = false;
    let searchMode = false;
    let ready = false;
    let rafOn = false;           // the loop only runs while the panel is open
    let tab = 'lyrics';          // hub tabs: lyrics | queue | stats
    let chapToldFor = '';        // the track whose chapter count was announced
    let uiMeta = null;           // the header's metadata (title, uploader, artwork), for the share card
    let maxOn = false;           // immersive fullscreen
    let menuOn = false, keysOn = false, keysBuilt = false;
    let chipShown = false, lastTm = -1;
    let lastSearchDur = 0;       // playing track's duration during manual search
    let themeMode = 'auto';      // auto | dark | light
    try { themeMode = GM_getValue('sl:theme', 'auto') || 'auto'; } catch (e) {}
    let mini = null, miniData = null, miniShown = false;   // floating current-line bar
    let miniOn = true;
    try { miniOn = !!GM_getValue('sl:mini', 1); } catch (e) {}
    let lastDragEnd = 0;         // suppress the click that follows a header drag
    try { const st = GM_getValue('sl:tab', 'lyrics'); if (st === 'queue' || st === 'stats' || st === 'tweaks' || st === 'audio') tab = st; } catch (e) {}
    let wizEl = null, wizT = null;
    let wizOn = true;
    try { wizOn = !!GM_getValue('sl:wiz', 1); } catch (e) {}
    let focusOn = false;
    try { focusOn = !!GM_getValue('sl:focus', 0); } catch (e) {}
    let tmRemain = false;
    try { tmRemain = !!GM_getValue('sl:tmr', 0); } catch (e) {}
    let tabTitleOn = false, titleTaken = '';
    try { tabTitleOn = !!GM_getValue('sl:ttl', 0); } catch (e) {}
    let loadTick = null, loadT0 = 0;
    let findWrap = null, findHits = [], findPos = -1;
    let wnEl = null;

    let lineEls = [], times = [], lineWords = [], activeI = -1, isSynced = false, estMode = false;
    // lyric translation (optional, persisted) — target = the user's own language
    let transToken = 0; const transCache = new Map();
    let transLang = (() => { try { return (navigator.language || 'en').split('-')[0] || 'en'; } catch (e) { return 'en'; } })();
    let transOn = (() => { try { return GM_getValue('sl:trans', false) === true; } catch (e) { return false; } })();
    let estBaseTimes = null;            // est-mode unwarped times (for tap-along)
    let tapOn = false, tapIdx = 0;      // tap-along calibration state
    let curLyr = null;                  // last rendered lyrics (for src-line refresh)
    let estTip = false;   // session-scoped: re-surface the "estimated, tap to sync" hint once each session
    let fontPx = 16;
    try {
      const savedFs = GM_getValue('sl:fs', 0) | 0;   // 0 = never set → small default, tiny bump on 4K
      fontPx = savedFs >= 12
        ? Math.min(30, savedFs)
        : (innerWidth >= 3400 ? 17 : innerWidth >= 2400 ? 16 : 15);
    } catch (e) {}
    let pauseScrollUntil = 0;
    let lastProg = -1, lastPlaying = null, lastFrameNow = -1, lastFill = '';
    let curArtAccent = null;   // last artwork-derived accent (for 'auto' mood)

    // ── v3.7 personalization (all persisted, all in the ⋯ menu) ──
    const GLASS = ['glass', 'solid', 'ghost'];          // backdrop density
    let glass = 'glass';
    try { const g = GM_getValue('sl:glass', 'glass'); if (GLASS.includes(g)) glass = g; } catch (e) {}
    const FONTS = ['system', 'serif', 'rounded', 'mono'];
    let fontFam = 'system';
    try { const f = GM_getValue('sl:font', 'system'); if (FONTS.includes(f)) fontFam = f; } catch (e) {}
    const MOODS = ['auto', 'sunset', 'ocean', 'grape', 'mono'];   // accent moods
    let mood = 'auto';
    try { const md = GM_getValue('sl:mood', 'auto'); if (MOODS.includes(md)) mood = md; } catch (e) {}
    let autoOpenFound = false;
    try { autoOpenFound = !!GM_getValue('sl:autoopen', 0); } catch (e) {}
    let comfyOn = false;
    try { comfyOn = !!GM_getValue('sl:comfy', 0); } catch (e) {}
    const MOOD_RGB = { sunset: [255, 85, 0], ocean: [10, 160, 220], grape: [150, 90, 235], mono: [180, 180, 188] };
    function applyChrome() {
      if (!panel) return;
      GLASS.forEach((g) => panel.classList.toggle('g-' + g, g === glass));
      FONTS.forEach((f) => panel.classList.toggle('f-' + f, f === fontFam));
      panel.classList.toggle('comfy', comfyOn);
    }
    function cycleGlass() {
      glass = GLASS[(GLASS.indexOf(glass) + 1) % GLASS.length];
      try { GM_setValue('sl:glass', glass); } catch (e) {}
      applyChrome(); toast('Backdrop: ' + glass);
    }
    function cycleFont() {
      fontFam = FONTS[(FONTS.indexOf(fontFam) + 1) % FONTS.length];
      try { GM_setValue('sl:font', fontFam); } catch (e) {}
      applyChrome(); toast('Font: ' + fontFam);
    }
    function cycleMood() {
      mood = MOODS[(MOODS.indexOf(mood) + 1) % MOODS.length];
      try { GM_setValue('sl:mood', mood); } catch (e) {}
      if (mood === 'auto') { setAccent(curArtAccent); } else { setAccent(MOOD_RGB[mood]); }
      toast('Accent: ' + mood);
    }
    function toggleComfy() {
      comfyOn = !comfyOn;
      try { GM_setValue('sl:comfy', comfyOn ? 1 : 0); } catch (e) {}
      applyChrome(); activeI = -1; lastFrameNow = -1; toast('Comfort spacing ' + (comfyOn ? 'on' : 'off'));
    }
    function toggleAutoOpen() {
      autoOpenFound = !autoOpenFound;
      try { GM_setValue('sl:autoopen', autoOpenFound ? 1 : 0); } catch (e) {}
      toast('Auto-open on lyrics found ' + (autoOpenFound ? 'on' : 'off'));
    }
    function snapCorner(which) {
      try {
        const w = panel.offsetWidth || 324, h = panel.offsetHeight || 480;
        const pad = 14;
        const x = which.indexOf('l') >= 0 ? pad : innerWidth - w - pad;
        const y = which.indexOf('t') >= 0 ? pad : innerHeight - h - 70;
        panel.style.left = Math.max(4, x) + 'px';
        panel.style.top = Math.max(4, y) + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
        GM_setValue('sl:pos', { x: parseInt(panel.style.left, 10), y: parseInt(panel.style.top, 10) });
      } catch (e) {}
    }

    function mount() {
      const host = document.createElement('div');
      host.id = 'slx3-host';
      host.style.cssText = 'position:fixed;inset:0 0 auto auto;width:0;height:0;z-index:2147483000;pointer-events:none;';
      (document.body || document.documentElement).appendChild(host);
      root = host.attachShadow({ mode: 'open' });
      // SoundCloud sees every key typed in here as landing on the host <div> and runs its shortcuts
      // (S focuses search, Space toggles play, digits seek); keep field input inside the panel
      // typing inside the hub never reaches SoundCloud's own shortcuts: its Space toggle listens on keyup
      // as well, so every key event of a field is shielded, not just keydown
      for (const ev of ['keydown', 'keypress', 'keyup']) root.addEventListener(ev, (e) => {
        const t = (e.composedPath ? e.composedPath()[0] : null) || e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) e.stopPropagation();
      });

      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);

      panel = document.createElement('div');
      panel.className = 'panel';
      // role=region (not dialog): the hub doesn't trap focus and is dismissable
      // via standard browser controls — VoiceOver / NVDA expect dialogs to be
      // modal, so labelling as a region matches actual behavior.
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', 'SoundCloud Suite — lyrics & player hub');
      panel.innerHTML = `
        <div class="glow" id="glow" aria-hidden="true"></div>
        <div class="hdr" id="hdr">
          <div class="art" id="art" aria-hidden="true">${ICONS.note}</div>
          <div class="meta">
            <div class="tt" id="tt">SuperLyrics</div>
            <div class="src" id="src">Play a song</div>
          </div>
          <div class="hactions">
            <span class="tm" id="tm" aria-hidden="true"></span>
            <button class="hbtn" id="bSearch" type="button" title="Search lyrics manually (S)" aria-label="Search lyrics manually">${ICONS.search}</button>
            <button class="hbtn" id="bMax" type="button" title="Immersive mode (F)" aria-label="Immersive (full-screen) mode" aria-pressed="false">${ICONS.expand}</button>
            <button class="hbtn" id="bMenu" type="button" title="More options" aria-label="More options" aria-haspopup="menu" aria-expanded="false">${ICONS.more}</button>
            <button class="hbtn" id="bClose" type="button" title="Close (Esc)" aria-label="Close lyrics hub">${ICONS.close}</button>
          </div>
          <div class="prog" id="prog" aria-hidden="true"></div>
        </div>
        <div class="tabs" id="tabs" role="tablist" aria-label="Hub sections">
          <button class="tab on" data-tab="lyrics" role="tab" aria-selected="true"><span class="tdot" aria-hidden="true"></span>Lyrics</button>
          <button class="tab" data-tab="queue" role="tab" aria-selected="false"><span class="tdot" aria-hidden="true"></span>Queue</button>
          <button class="tab" data-tab="stats" role="tab" aria-selected="false"><span class="tdot" aria-hidden="true"></span>Stats</button>
          <button class="tab" data-tab="audio" role="tab" aria-selected="false"><span class="tdot" aria-hidden="true"></span>Audio</button>
          <button class="tab" data-tab="tweaks" role="tab" aria-selected="false"><span class="tdot" aria-hidden="true"></span>Tweaks</button>
        </div>
        <div class="body" id="body" role="region" aria-label="Lyrics"></div>
        <div class="body" id="qbody" role="region" aria-label="Queue" style="display:none"></div>
        <div class="body" id="sbody" role="region" aria-label="Stats" style="display:none"></div>
        <div class="body" id="ebody" role="region" aria-label="Tweaks" style="display:none"></div>
        <div class="body" id="abody" role="region" aria-label="Audio" style="display:none"></div>
        <div class="nxt" id="nxt"></div>
        <button class="chip" id="chip" type="button">↓ Back to live</button>
        <button class="wchip" id="wiz" type="button"></button>
        <div class="menu" id="menu" role="menu"></div>
        <div class="keys" id="keys"></div>
        <div class="grip" id="grip" title="Drag to resize" aria-hidden="true"></div>
        <div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>
        <!-- R32: hidden live region — screen readers announce the active lyric line as it changes -->
        <div class="srl" id="srl" aria-live="polite" aria-atomic="true"></div>`;
      root.appendChild(panel);

      body = panel.querySelector('#body');
      // during tap-along calibration, a click ANYWHERE in the lyrics = advance to the
      // next line (so you can tap with the mouse, not just the spacebar). Capture
      // phase so it beats the per-line seek handler.
      body.addEventListener('click', (e) => {
        if (tapOn) { e.preventDefault(); e.stopPropagation(); tapAdvance(); }
      }, true);
      qbody = panel.querySelector('#qbody');
      Chapters.onChange = () => { try { if (tab === 'queue') renderQueue(); if (Chapters.fromDesc >= 3 && Chapters.href && chapToldFor !== Chapters.href && panel.classList.contains('open') && tab !== 'queue') { chapToldFor = Chapters.href; toast(Chapters.fromDesc + ' chapters in this one · Queue tab'); } } catch (e) {} };
      setInterval(paintChapterNow, 1000);
      sbody = panel.querySelector('#sbody');
      ebody = panel.querySelector('#ebody');
      abody = panel.querySelector('#abody');
      art = panel.querySelector('#art');
      tt = panel.querySelector('#tt');
      src = panel.querySelector('#src');
      toastEl = panel.querySelector('#toast');
      progEl = panel.querySelector('#prog');
      glowEl = panel.querySelector('#glow');
      tabsEl = panel.querySelector('#tabs');
      tmEl = panel.querySelector('#tm');
      chipEl = panel.querySelector('#chip');
      wizEl = panel.querySelector('#wiz');
      menuEl = panel.querySelector('#menu');
      keysEl = panel.querySelector('#keys');
      gripEl = panel.querySelector('#grip');
      hdrEl = panel.querySelector('#hdr');
      nxtEl = panel.querySelector('#nxt');
      bMenuEl = panel.querySelector('#bMenu');

      panel.querySelector('#bClose').addEventListener('click', () => setOpen(false));
      panel.querySelector('#bSearch').addEventListener('click', () => { setTab('lyrics'); (searchMode ? exitSearch() : enterSearch()); });
      panel.querySelector('#bMax').addEventListener('click', () => toggleMax());
      bMenuEl.addEventListener('click', (e) => { e.stopPropagation(); setMenu(!menuOn); });
      src.addEventListener('click', () => { if (src.classList.contains('lk') && !searchMode) enterSearch(); });
      tabsEl.addEventListener('click', (e) => {
        const b = e.target.closest('.tab');
        if (b) setTab(b.dataset.tab);
      });
      nxtEl.addEventListener('click', () => setTab('queue'));
      chipEl.addEventListener('click', () => { pauseScrollUntil = 0; activeI = -1; lastFrameNow = -1; });
      wizEl.addEventListener('click', () => {
        hideWizard();
        startTapAlign();   // estimated → the accurate per-line calibration (tap ⎵ / click per line)
      });
      tmEl.style.cursor = 'pointer';
      tmEl.title = 'Toggle time left ↔ elapsed';
      tmEl.addEventListener('click', () => {
        tmRemain = !tmRemain;
        try { GM_setValue('sl:tmr', tmRemain ? 1 : 0); } catch (e2) {}
        lastTm = -1;   // force the next loop tick to repaint
      });
      keysEl.addEventListener('click', () => showKeys(false));
      root.addEventListener('pointerdown', (e) => {
        // tap-away closes the menu (shadow-aware)
        if (menuOn) {
          const path = e.composedPath ? e.composedPath() : [];
          if (!path.includes(menuEl) && !path.includes(bMenuEl)) setMenu(false);
        }
      });

      // ── drag to move (header), double-click header to reset ──
      let drag = null;
      hdrEl.addEventListener('pointerdown', (e) => {
        if (e.button || e.target.closest('.hbtn') || maxOn) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, id: e.pointerId, x0: e.clientX, y0: e.clientY };
      });
      hdrEl.addEventListener('pointermove', (e) => {
        if (!drag) return;
        // capture only once the pointer really travels: capturing on pointerdown retargets the
        // click to the header, which killed the clock, title, source-line and artwork clicks
        if (!drag.moved) {
          if (Math.abs(e.clientX - drag.x0) < 3 && Math.abs(e.clientY - drag.y0) < 3) return;
          drag.moved = true;
          try { hdrEl.setPointerCapture(drag.id); } catch (e2) {}
        }
        const x = Math.min(Math.max(4, e.clientX - drag.dx), innerWidth - 80);
        const y = Math.min(Math.max(4, e.clientY - drag.dy), innerHeight - 60);
        panel.style.left = x + 'px';
        panel.style.top = y + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      });
      hdrEl.addEventListener('pointerup', () => {
        if (drag && drag.moved) {
          lastDragEnd = performance.now();
          clampPanel();   // snap fully back on-screen before saving
          try { GM_setValue('sl:pos', { x: parseInt(panel.style.left, 10) || 0, y: parseInt(panel.style.top, 10) || 0 }); } catch (e2) {}
        }
        drag = null;
      });
      hdrEl.addEventListener('pointercancel', () => { drag = null; });
      hdrEl.addEventListener('dblclick', (e) => {
        if (e.target.closest('.hbtn') || e.target.closest('.art') || e.target.closest('.tt')) return;
        panel.style.left = panel.style.top = '';
        panel.style.right = panel.style.bottom = '';
        try { GM_setValue('sl:pos', null); } catch (e2) {}
        toast('Position reset');
      });
      // the thin progress line at the header's base is a seek bar — click
      // anywhere along it to jump the song there
      hdrEl.addEventListener('click', (e) => {
        if (performance.now() - lastDragEnd < 250) return;
        if (e.target.closest('.hbtn') || e.target.closest('.art') || e.target.closest('.tt') || e.target.closest('.tm')) return;
        const r = hdrEl.getBoundingClientRect();
        if (r.bottom - e.clientY > 9) return;   // only the bottom strip counts
        const m2 = App.meta();
        if (!m2 || !(m2.dur > 0)) return;
        const pct = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 0.99);
        Media.seek(m2.dur * pct);
        pauseScrollUntil = 0;
        toast('→ ' + fmtClock(m2.dur * pct));
      });
      // cinema fullscreen: the chrome melts away while you just listen
      panel.addEventListener('pointermove', wakeChrome);
      // double-click the artwork → immersive fullscreen
      art.addEventListener('dblclick', (e) => { e.stopPropagation(); toggleMax(); });
      // click the title → copy a shareable "Title — link" snippet
      tt.style.cursor = 'pointer';
      tt.addEventListener('click', () => {
        if (performance.now() - lastDragEnd < 250) return;   // not the tail of a drag
        const m2 = App.meta();
        if (!m2 || !m2.href) return;
        const txt2 = (m2.title || '') + ' — https://soundcloud.com' + m2.href;
        try { GM_setClipboard(txt2); toast('Track link copied'); return; } catch (e2) {}
        try { navigator.clipboard.writeText(txt2).then(() => toast('Track link copied'), () => {}); } catch (e2) {}
      });

      // ── resize grip (bottom-right), persisted ──
      let rsz = null;
      gripEl.addEventListener('pointerdown', (e) => {
        if (e.button) return;
        e.preventDefault(); e.stopPropagation();
        const r = panel.getBoundingClientRect();
        rsz = { w: r.width, h: r.height, x: e.clientX, y: e.clientY };
        try { gripEl.setPointerCapture(e.pointerId); } catch (e2) {}
      });
      gripEl.addEventListener('pointermove', (e) => {
        if (!rsz) return;
        const w = Math.min(Math.max(280, rsz.w + e.clientX - rsz.x), innerWidth - 24);
        const h = Math.min(Math.max(300, rsz.h + e.clientY - rsz.y), innerHeight - 24);
        panel.style.width = w + 'px';
        panel.style.maxHeight = h + 'px';
        panel.style.height = h + 'px';
      });
      gripEl.addEventListener('pointerup', () => {
        if (rsz) {
          try { GM_setValue('sl:size', { w: parseInt(panel.style.width, 10) || 0, h: parseInt(panel.style.height, 10) || 0 }); } catch (e2) {}
        }
        rsz = null;
      });
      gripEl.addEventListener('pointercancel', () => { rsz = null; });

      // restore saved position / size (clamped into the viewport)
      try {
        const sp = GM_getValue('sl:pos', null);
        if (sp && isFinite(sp.x) && isFinite(sp.y)) {
          panel.style.left = Math.min(Math.max(4, sp.x), innerWidth - 80) + 'px';
          panel.style.top = Math.min(Math.max(4, sp.y), innerHeight - 60) + 'px';
          panel.style.right = 'auto';
          panel.style.bottom = 'auto';
        }
        const sz = GM_getValue('sl:size', null);
        if (sz && sz.w >= 280) panel.style.width = Math.min(sz.w, innerWidth - 24) + 'px';
        if (sz && sz.h >= 300) {
          const hh = Math.min(sz.h, innerHeight - 24);
          panel.style.maxHeight = hh + 'px';
          panel.style.height = hh + 'px';
        }
      } catch (e) {}
      // the panel must never hang off-screen (behind the player bar / below
      // the viewport) — the old restore clamped only the TOP edge, so a tall
      // panel with a low saved top spilled its buttons off the bottom
      requestAnimationFrame(clampPanel);
      try { window.addEventListener('resize', () => { clampPanel(); }); } catch (e) {}

      const pause = () => { pauseScrollUntil = performance.now() + 2600; };
      body.addEventListener('wheel', pause, { passive: true });
      body.addEventListener('touchmove', pause, { passive: true });
      // ⌘/Ctrl + scroll over the lyrics = zoom the text
      body.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        bumpFont(e.deltaY < 0 ? 1 : -1);
      }, { passive: false });

      fab = document.createElement('button');
      fab.className = 'fab';
      fab.title = 'Lyrics (Alt+L)';
      fab.innerHTML = ICONS.lyrics + '<span class="rdy"></span>';
      fab.addEventListener('click', () => setOpen(!open));
      root.appendChild(fab);

      // mini lyric bar — the current synced line, visible while the panel is
      // closed; a cheap worker tick drives it (the rAF loop stays parked)
      mini = document.createElement('button');
      mini.className = 'mini';
      mini.type = 'button';
      mini.title = 'Open lyrics (Alt+L)';
      mini.addEventListener('click', () => setOpen(true));
      mini.addEventListener('dblclick', () => { setOpen(true); toggleMax(true); });
      root.appendChild(mini);
      Ticker.every(updateMini, 700);
      if (focusOn) panel.classList.add('focus');

      applyFont();
      applyPanelTheme();
      applyChrome();
      if (mood !== 'auto') setAccent(MOOD_RGB[mood]);
      if (tab !== 'lyrics') setTab(tab);   // restore the last-used hub tab
      // the panel is still closed: a remembered Audio tab must not route the FX
      // chain (latency + CPU with nothing visible); setOpen(true) re-activates it
      if (tab === 'audio') { try { if (SUITE.audioTabActive) SUITE.audioTabActive(false); } catch (e) {} }
      // no rAF here: the loop starts in setOpen(true) and parks itself when
      // the panel closes — zero per-frame work for users who never open it
    }

    /* ---------- mini lyric bar ---------- */
    function setMini(lines) {
      miniData = (lines && lines.length) ? lines : null;
      if (!miniData && miniShown && mini) { miniShown = false; mini.classList.remove('on'); }
    }
    function curMiniLine() {
      if (!miniData) return -1;
      const t = Media.time() + (App.leadMs() || 0) / 1000 + ((App.offsetMs() || 0) + (App.latencyMs() || 0) + (SyncAuto.ms || 0)) / 1000;
      let lo = 0, hi = miniData.length - 1, ans = -1;
      while (lo <= hi) { const m2 = (lo + hi) >> 1; if (miniData[m2][0] <= t) { ans = m2; lo = m2 + 1; } else hi = m2 - 1; }
      return ans;
    }
    function updateMini() {
      try {
        if (!mini) return;
        const playing = Media.playing();
        // optional: mirror the sung line into the browser tab title
        if (tabTitleOn && miniData && playing) {
          const ti = curMiniLine();
          if (ti >= 0) {
            if (!/^♪ /.test(document.title)) titleTaken = document.title;
            const want = '♪ ' + miniData[ti][1];
            if (document.title !== want) document.title = want;
          }
        } else if (titleTaken && /^♪ /.test(document.title)) {
          document.title = titleTaken;
          titleTaken = '';
        }
        if (!miniOn || open || !miniData || !playing) {
          if (miniShown) { miniShown = false; mini.classList.remove('on'); }
          return;
        }
        const ans = curMiniLine();
        if (ans < 0) { if (miniShown) { miniShown = false; mini.classList.remove('on'); } return; }
        const txt2 = miniData[ans][1];
        if (mini.__t !== txt2) {
          mini.__t = txt2;
          mini.textContent = txt2;
          const nx2 = miniData[ans + 1];
          mini.title = nx2 ? 'Next: ' + nx2[1] : 'Open lyrics (Alt+L)';
        }
        if (!miniShown) { miniShown = true; mini.classList.add('on'); }
      } catch (e) {}
    }
    function toggleTabTitle() {
      tabTitleOn = !tabTitleOn;
      try { GM_setValue('sl:ttl', tabTitleOn ? 1 : 0); } catch (e) {}
      if (!tabTitleOn && titleTaken) { try { document.title = titleTaken; } catch (e) {} titleTaken = ''; }
      toast('Tab-title lyrics ' + (tabTitleOn ? 'on' : 'off'));
    }
    function toggleMini() {
      miniOn = !miniOn;
      try { GM_setValue('sl:mini', miniOn ? 1 : 0); } catch (e) {}
      if (!miniOn && miniShown) { miniShown = false; mini.classList.remove('on'); }
      toast('Mini lyric bar ' + (miniOn ? 'on' : 'off'));
    }

    /* ---------- sync wizard: one tap on the first line = aligned ---------- */
    function hideWizard() {
      if (wizT) { try { wizT.stop(); } catch (e) {} wizT = null; }
      if (wizEl) wizEl.classList.remove('on');
    }
    function maybeWizard(lyr2) {
      hideWizard();
      // ONLY estimated, not-yet-calibrated tracks get the prompt. Confirmed synced
      // lyrics are already accurate — never nag them to calibrate (no point). [user]
      if (!wizOn || !estMode || App.anchorCount() || !lineEls.length) return;
      let idx = -1;
      for (let i = 0; i < lineEls.length; i++) {
        const el2 = lineEls[i];
        if (el2 && el2.classList && el2.classList.contains('line')) { idx = i; break; }
      }
      if (idx < 0) return;
      // only near the top of the track, so it never pops mid-song
      if (times[idx] != null && Media.time() > times[idx] + 25) return;
      wizEl.textContent = '🎤 Estimated timing — tap to sync this track line-by-line';
      wizEl.classList.add('on');
      wizT = Ticker.after(hideWizard, 24000);
    }
    function toggleWizard() {
      wizOn = !wizOn;
      try { GM_setValue('sl:wiz', wizOn ? 1 : 0); } catch (e) {}
      if (!wizOn) hideWizard();
      toast('Sync wizard ' + (wizOn ? 'on' : 'off'));
    }

    /* ---------- focus (karaoke) mode ---------- */
    function toggleFocus() {
      focusOn = !focusOn;
      try { GM_setValue('sl:focus', focusOn ? 1 : 0); } catch (e) {}
      panel.classList.toggle('focus', focusOn);
      toast('Focus mode ' + (focusOn ? 'on' : 'off'));
    }

    /* ---------- jump to chorus: the most-repeated synced line ---------- */
    function jumpChorus() {
      if (!isSynced || !times.length) { toast('Chorus jump needs synced lyrics'); return; }
      const cnt = new Map();
      lineEls.forEach((el2, i) => {
        if (!el2 || !el2.classList || !el2.classList.contains('line')) return;
        const k = normKey(el2.textContent || '');
        if (k.length < 8) return;
        if (!cnt.has(k)) cnt.set(k, []);
        cnt.get(k).push(i);
      });
      let best = null;
      for (const idxs of cnt.values()) if (idxs.length >= 3 && (!best || idxs.length > best.length)) best = idxs;
      if (!best) { toast('No repeating chorus found'); return; }
      const offS = ((App.offsetMs() || 0) + (App.latencyMs() || 0) + (SyncAuto.ms || 0)) / 1000;
      const nowT = Media.time() + offS;
      let target = best[0];   // next occurrence ahead of now, else the first
      for (const i of best) if (times[i] > nowT + 1) { target = i; break; }
      Media.seek(Math.max(0, times[target] - offS));
      pauseScrollUntil = 0;
      toast('→ chorus');
    }

    /* ---------- line navigation: ↑/↓ seek, R replays ----------
     * Returns false when there's nothing to do so the hotkey handler can
     * let the arrow keys fall through to normal page scrolling. */
    function seekLine(delta) {
      if (!isSynced || !times.length || tab !== 'lyrics' || searchMode) return false;
      const offS = ((App.offsetMs() || 0) + (App.latencyMs() || 0) + (SyncAuto.ms || 0)) / 1000;
      let i = activeI < 0 ? 0 : activeI + delta;
      i = Math.max(0, Math.min(times.length - 1, i));
      Media.seek(Math.max(0, times[i] - offS));
      pauseScrollUntil = 0;
      return true;
    }
    function replayLine() {
      if (!isSynced || activeI < 0 || tab !== 'lyrics' || searchMode) return false;
      const offS = ((App.offsetMs() || 0) + (App.latencyMs() || 0) + (SyncAuto.ms || 0)) / 1000;
      Media.seek(Math.max(0, times[activeI] - offS));
      pauseScrollUntil = 0;
      toast('↻ replaying line');
      return true;
    }

    /* ---------- find in lyrics ---------- */
    function openFind() {
      if (tab !== 'lyrics' || searchMode) return;
      if (findWrap) { findWrap.querySelector('input').focus(); return; }
      findWrap = document.createElement('div');
      findWrap.className = 'srch';
      findWrap.innerHTML = '<input class="inp" type="text" placeholder="Find in lyrics… Enter = next, Esc = close" spellcheck="false">';
      panel.insertBefore(findWrap, body);
      const inp = findWrap.querySelector('input');
      const jump = () => {
        if (!findHits.length) { toast('No match'); return; }
        findPos = (findPos + 1) % findHits.length;
        const el2 = findHits[findPos];
        pauseScrollUntil = performance.now() + 6000;
        body.scrollTo({ top: el2.offsetTop - body.clientHeight * 0.3, behavior: 'smooth' });
        el2.style.textDecoration = 'underline';
        el2.style.textDecorationColor = 'var(--acc)';
        setTimeout(() => { el2.style.textDecoration = ''; }, 1800);
        toast('Match ' + (findPos + 1) + ' / ' + findHits.length);
      };
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Escape') { closeFind(); return; }
        if (ev.key !== 'Enter') return;
        const q = normKey(inp.value.trim());
        if (q !== inp.__q) {
          inp.__q = q;
          findHits = q ? [...body.querySelectorAll('.line')].filter((el2) => normKey(el2.textContent || '').includes(q)) : [];
          findPos = -1;
        }
        jump();
      });
      setTimeout(() => inp.focus(), 20);
    }
    function closeFind() {
      if (findWrap) { findWrap.remove(); findWrap = null; }
      findHits = []; findPos = -1;
    }

    /* ---------- share a line with its timestamp ---------- */
    function copyLineTs(text, t) {
      const m2 = App.meta();
      const ts = '[' + Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0') + ']';
      const q = '“' + text + '” ' + ts + (m2 && m2.title ? ' — ' + m2.title : '') + (m2 && m2.href ? ' — https://soundcloud.com' + m2.href : '');
      try { GM_setClipboard(q); toast('Quote + timestamp copied'); return; } catch (e) {}
      try { navigator.clipboard.writeText(q).then(() => toast('Quote copied'), () => toast('Copy failed')); } catch (e) { toast('Copy failed'); }
    }

    /* ---------- paste-lyrics sheet ---------- */
    /* ---------- lyric share card: a few lines on the artwork, as an image ---------- */
    let shareBar = null, shareSel = [], shareSelClick = null;
    function shareFont(px, w) { return (w || 700) + ' ' + px + 'px Inter, "SF Pro Display", "Segoe UI", system-ui, sans-serif'; }
    function shareWrap(ctx, text, maxW) {   // greedy word wrap on the canvas's own measure
      const words = String(text).split(/\s+/), out = []; let cur = '';
      for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t; }
      if (cur) out.push(cur);
      return out;
    }
    function shareArtwork(src) {   // the artwork CDN answers CORS, so the canvas stays exportable; a miss just means no photo
      return new Promise((res) => {
        if (!src) { res(null); return; }
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => res(img); img.onerror = () => res(null);
        img.src = String(src).replace(/-t\d+x\d+(\.\w+)/, '-t500x500$1');
        setTimeout(() => res(null), 4000);
      });
    }
    async function shareRender(lines, size) {
      const S = size || 1080, c = document.createElement('canvas'); c.width = S; c.height = S;
      const ctx = c.getContext('2d'); if (!ctx) return c;
      const m = uiMeta || {}, artist = (curLyr && curLyr.a) || m.uploader || '', title = (curLyr && curLyr.t) || m.title || '';
      const img = await shareArtwork(m.art);
      const acc = (getComputedStyle(panel).getPropertyValue('--acc') || '#ff5500').trim() || '#ff5500';
      // backdrop: the artwork blown up and blurred under a dark wash; without one, a deep gradient
      ctx.fillStyle = '#141318'; ctx.fillRect(0, 0, S, S);
      if (img) {
        try { ctx.save(); ctx.filter = 'blur(' + Math.round(S * 0.045) + 'px) saturate(1.2)'; ctx.drawImage(img, -S * 0.15, -S * 0.15, S * 1.3, S * 1.3); ctx.restore(); } catch (e) {}
        const g = ctx.createLinearGradient(0, 0, 0, S); g.addColorStop(0, 'rgba(8,8,12,0.42)'); g.addColorStop(1, 'rgba(8,8,12,0.82)'); ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
      } else {
        const g = ctx.createLinearGradient(0, 0, S, S); g.addColorStop(0, '#1d1a22'); g.addColorStop(1, '#0d0d10'); ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
        ctx.fillStyle = acc; ctx.globalAlpha = 0.16; ctx.beginPath(); ctx.arc(S * 0.85, S * 0.1, S * 0.36, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      }
      const pad = Math.round(S * 0.085), u = S / 1080;
      // header: artwork thumb, title, artist
      const th = Math.round(132 * u);
      if (img) { try { ctx.save(); ctx.beginPath(); const r = 22 * u; ctx.roundRect(pad, pad, th, th, r); ctx.clip(); ctx.filter = 'none'; ctx.drawImage(img, pad, pad, th, th); ctx.restore(); } catch (e) {} }
      const tx = pad + (img ? th + 28 * u : 0);
      ctx.fillStyle = '#fff'; ctx.font = shareFont(Math.round(40 * u), 700); ctx.textBaseline = 'top';
      const tl = shareWrap(ctx, title, S - tx - pad); ctx.fillText(tl[0] || '', tx, pad + 14 * u);
      ctx.fillStyle = 'rgba(255,255,255,0.72)'; ctx.font = shareFont(Math.round(30 * u), 500); ctx.fillText(artist, tx, pad + 70 * u);
      // the lines: bigger when there are fewer, wrapped to the card, with an accent bar
      const px = Math.round((lines.length <= 2 ? 64 : lines.length === 3 ? 56 : lines.length === 4 ? 50 : 44) * u);
      ctx.font = shareFont(px, 700);
      const maxW = S - pad * 2 - 34 * u, rows = [];
      for (const l of lines) for (const w of shareWrap(ctx, l, maxW)) rows.push(w);
      const lh = Math.round(px * 1.28), top = Math.max(pad + th + 60 * u, Math.round((S - rows.length * lh) / 2));
      ctx.fillStyle = acc; ctx.fillRect(pad, top + 6 * u, 8 * u, Math.max(lh, rows.length * lh - 12 * u));
      ctx.fillStyle = '#fff';
      rows.forEach((r, i) => ctx.fillText(r, pad + 34 * u, top + i * lh));
      // footer
      ctx.fillStyle = acc; ctx.font = shareFont(Math.round(24 * u), 700); ctx.fillText('SoundCloud Suite', pad, S - pad - 26 * u);
      return c;
    }
    function shareLinesText() { return shareSel.slice().sort((a, b) => a - b).map((i) => (lineEls[i] && lineEls[i].textContent) || '').filter(Boolean); }
    function shareClose() {
      if (shareBar) { try { shareBar.remove(); } catch (e) {} shareBar = null; }
      if (shareSelClick) { try { body.removeEventListener('click', shareSelClick, true); } catch (e) {} shareSelClick = null; }
      for (const el of lineEls) if (el) el.classList.remove('sel');
      shareSel = [];
    }
    function sharePreview() {
      if (!shareBar) return;
      const lines = shareLinesText();
      shareBar.querySelector('.st b').textContent = lines.length + (lines.length === 1 ? ' line' : ' lines') + ' picked';
      shareRender(lines, 360).then((c) => { if (!shareBar) return; const pv = shareBar.querySelector('canvas'); const px = pv.getContext('2d'); px.clearRect(0, 0, pv.width, pv.height); px.drawImage(c, 0, 0, pv.width, pv.height); });
    }
    function shareToggle(i) {
      const k = shareSel.indexOf(i);
      if (k >= 0) { shareSel.splice(k, 1); lineEls[i].classList.remove('sel'); }
      else { if (shareSel.length >= 6) { toast('Six lines is the most a card can hold'); return; } shareSel.push(i); lineEls[i].classList.add('sel'); }
      sharePreview();
    }
    async function shareExport(copy) {
      const lines = shareLinesText();
      if (!lines.length) { toast('Pick a line first'); return; }
      const c = await shareRender(lines, 1080);
      const blob = await new Promise((r) => { try { c.toBlob(r, 'image/png'); } catch (e) { r(null); } });
      if (!blob) { toast('Could not build the image'); return; }
      if (copy) {
        try { if (!window.ClipboardItem) throw new Error('no ClipboardItem'); await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]); toast('Card copied · paste it anywhere'); return; } catch (e) {}
      }
      try {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        const m = uiMeta || {};
        a.download = 'lyric-card-' + String(m.title || 'lyrics').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) + '.png';
        (document.body || document.documentElement).appendChild(a); a.click();
        setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 1000);
        toast(copy ? 'Clipboard unavailable · saved as a file instead' : 'Card saved');
      } catch (e) { toast('Could not save the image'); }
    }
    function shareSheet() {
      if (!lineEls.length || !curLyr || curLyr.instr) { toast('No lyrics to share yet'); return; }
      if (shareBar) { shareClose(); return; }
      setTab('lyrics');
      shareSel = [];
      let start = activeI >= 0 ? activeI : 0, n = 0;
      for (let i = start; i < lineEls.length && n < 3; i++) { if (lineEls[i] && lineEls[i].classList.contains('line') && lineEls[i].textContent.trim()) { shareSel.push(i); lineEls[i].classList.add('sel'); n++; } }
      shareBar = document.createElement('div'); shareBar.className = 'sharebar'; shareBar.setAttribute('role', 'region'); shareBar.setAttribute('aria-label', 'Lyric card');
      const pv = document.createElement('canvas'); pv.width = 92; pv.height = 92;
      const st = document.createElement('div'); st.className = 'st'; st.innerHTML = '<b></b>Click lines to pick up to six · Esc to close';
      const copyB = document.createElement('button'); copyB.className = 'btn acc'; copyB.textContent = 'Copy image'; copyB.addEventListener('click', () => shareExport(true));
      const saveB = document.createElement('button'); saveB.className = 'btn'; saveB.textContent = 'Save'; saveB.addEventListener('click', () => shareExport(false));
      const x = document.createElement('button'); x.className = 'btn'; x.textContent = '✕'; x.title = 'Close'; x.setAttribute('aria-label', 'Close the lyric card'); x.addEventListener('click', shareClose);
      shareBar.append(pv, st, copyB, saveB, x);
      panel.appendChild(shareBar);
      shareSelClick = (ev) => {   // while the bar shows, a click on a line picks it instead of seeking
        const el = ev.target && ev.target.closest ? ev.target.closest('.line') : null;
        if (!el) return;
        const i = lineEls.indexOf(el); if (i < 0) return;
        ev.stopPropagation(); ev.preventDefault(); shareToggle(i);
      };
      body.addEventListener('click', shareSelClick, true);
      sharePreview();
      toast('Pick the lines for your card');
    }

    function pasteSheet() {
      const wrap = document.createElement('div');
      wrap.className = 'keys on';
      wrap.style.cursor = 'default';
      const h = document.createElement('h3');
      h.textContent = 'Paste lyrics for this track';
      const ta = document.createElement('textarea');
      ta.style.cssText = 'width:100%;flex:1;min-height:120px;background:rgba(128,128,128,0.12);color:inherit;border:1px solid rgba(128,128,128,0.25);border-radius:10px;padding:10px;font:inherit;font-size:12px;line-height:1.5;resize:none;outline:none;';
      ta.placeholder = 'Plain text, or .lrc with [mm:ss.xx] timestamps for true sync…';
      ta.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') { ev.preventDefault(); wrap.remove(); } });
      const row = document.createElement('div');
      row.className = 'row';
      const save = document.createElement('button');
      save.className = 'btn acc';
      save.textContent = 'Save';
      save.addEventListener('click', () => { if (App.acceptPasted(ta.value) !== false) wrap.remove(); });   // no track yet: keep the text
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => wrap.remove());
      row.append(save, cancel);
      wrap.append(h, ta, row);
      panel.appendChild(wrap);
      setTimeout(() => ta.focus(), 30);
    }

    /* ---------- what's new ---------- */
    function showWhatsNew() {
      if (!wnEl) {
        wnEl = document.createElement('div');
        wnEl.className = 'keys';
        // always dark (override the lite-theme backdrop) so the cards read well
        wnEl.style.cssText += ';justify-content:flex-start;align-items:center;overflow-y:auto;padding:0;background:radial-gradient(125% 55% at 50% 0%, rgba(255,90,0,.12), rgba(9,9,12,.96) 52%)';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'width:100%;max-width:430px;margin:auto;padding:26px 20px 30px;box-sizing:border-box';
        // header — gradient spark badge + title + version
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:11px;margin-bottom:18px';
        const spark = document.createElement('div');
        spark.textContent = '✨';
        spark.style.cssText = 'width:40px;height:40px;border-radius:13px;flex:none;display:flex;align-items:center;justify-content:center;font-size:20px;background:linear-gradient(135deg,#f50,#ff8a3d);box-shadow:0 8px 22px -6px rgba(255,85,0,.65)';
        const htext = document.createElement('div');
        const ht = document.createElement('div'); ht.textContent = 'What’s new'; ht.style.cssText = 'font-size:18px;font-weight:800;letter-spacing:-.3px;color:#fff';
        const hv = document.createElement('div'); hv.textContent = 'SoundCloud Suite · v' + VER; hv.style.cssText = 'font-size:11.5px;color:#9a9aa2;margin-top:1px';
        htext.append(ht, hv); head.append(spark, htext);
        wrap.appendChild(head);
        // curated highlights (newest first) — clean cards, not a wall of text
        const FEATS = [
          ['✨', 'Enhance, remastered', 'A five-stage tone shape, 4× saturation, a harmonic exciter and a three-band compressor that follows the track’s own loudness — level-matched, so it never wins by simply being louder.'],
          ['🎯', 'Lyrics locked to the vocals', 'The highlight follows the audio clock to the frame. For synced sheets the hub listens to the first 90 s and offers “Align to vocals” in the ⋯ menu when it hears a constant lag.'],
          ['⌨️', 'Keys stay in the hub', 'R, M, S and the digits no longer reach SoundCloud’s own shortcuts while the hub is open, Escape closes every sheet and dialog, and the EQ curve, switches and sliders work from the keyboard.'],
          ['🎚️', 'A complete Audio tab', 'Loudness normalize that measures like the streaming services (with a per-track memory), a clip guard, volume boost to 300 %, Night mode, hold-to-compare, headphone correction from AutoEQ, bass, vocals, tilt, crossfeed, balance, mono, tempo chips, pitch-follows-speed, fades — every control an exact passthrough when off.'],
          ['⏱️', 'Pinpoint lyric sync', 'Synced lyrics auto-stretch to THIS upload’s real length (SoundCloud is full of sped-up / edited versions), and a phase-locked clock makes the highlight glide exactly with the audio — locked to the track that’s actually playing, no more creeping out by the last chorus. For tracks with no synced lyrics anywhere, the timing is estimated — tap the 🎤 prompt (or ⋯ → Calibrate sync) and tap each line as you hear it to lock it perfectly.'],
          ['🌐', 'Lyric translation', 'Lyrics ⋯ menu → Translate: each line gets a dimmed translation in your language, right under the original.'],
          ['🚀', 'One-tap recommended setup', 'First run offers a “Use recommended” option — a dark theme, the audio enhancer, loudness leveling & a touch of stereo width, all in one tap. Or set it up yourself.'],
          ['🎛️', 'Interactive equalizer', 'A drag-the-curve 10-band EQ — pull the dots over a glowing live spectrum, just like a pro plugin, with presets you can save.'],
          ['🔊', 'Loudness & fade', 'Also in the Audio tab: auto-level quiet vs. loud uploads and fade tracks in/out. All experimental & instantly reversible.'],
          ['💤', 'Sleep timer & shortcuts', 'Pause after 15m–1.5h, per-track speed memory, and press ? in the hub for every shortcut.'],
        ];
        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:9px';
        const cardBase = 'inset 0 0 0 1px rgba(255,255,255,.07),0 6px 18px -12px rgba(0,0,0,.6)';
        const cardHover = 'inset 0 0 0 1px rgba(255,120,40,.32),0 14px 30px -12px rgba(255,90,0,.42)';
        for (const [icon, title, desc] of FEATS) {
          const card = document.createElement('div');
          card.style.cssText = 'display:flex;gap:13px;align-items:flex-start;padding:13px 14px;border-radius:15px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.022));box-shadow:' + cardBase + ';transition:transform .16s ease,box-shadow .16s ease';
          card.addEventListener('mouseenter', () => { card.style.transform = 'translateY(-2px)'; card.style.boxShadow = cardHover; });
          card.addEventListener('mouseleave', () => { card.style.transform = ''; card.style.boxShadow = cardBase; });
          const ic = document.createElement('div');
          ic.textContent = icon;
          ic.style.cssText = 'width:36px;height:36px;border-radius:11px;flex:none;display:flex;align-items:center;justify-content:center;font-size:18px;background:linear-gradient(135deg,rgba(255,138,61,.3),rgba(245,80,0,.2));box-shadow:inset 0 0 0 1px rgba(255,120,40,.42),0 4px 12px -6px rgba(255,90,0,.5)';
          const txt = document.createElement('div'); txt.style.minWidth = '0';
          const tt = document.createElement('div'); tt.textContent = title; tt.style.cssText = 'font-size:13px;font-weight:700;color:#fff;letter-spacing:-.1px';
          const dd = document.createElement('div'); dd.textContent = desc; dd.style.cssText = 'font-size:11.5px;color:#b4b4be;line-height:1.45;margin-top:2px';
          txt.append(tt, dd); card.append(ic, txt); list.appendChild(card);
        }
        wrap.appendChild(list);
        const hint = document.createElement('div');
        hint.textContent = 'Tap anywhere to close';
        hint.style.cssText = 'text-align:center;font-size:11px;color:#76767e;margin-top:18px';
        wrap.appendChild(hint);
        wnEl.appendChild(wrap);
        wnEl.addEventListener('click', () => wnEl.classList.remove('on'));
        panel.appendChild(wnEl);
      }
      wnEl.classList.add('on');
    }

    function applyFont() { if (panel) panel.style.setProperty('--fs', fontPx + 'px'); }
    function bumpFont(d) {
      fontPx = Math.min(30, Math.max(12, fontPx + d));
      applyFont();
      try { GM_setValue('sl:fs', fontPx); } catch (e) {}
      toast('Lyrics size ' + fontPx + 'px');
    }

    /* ---------- theme: auto-match SoundCloud, or force dark/light ---------- */
    function panelThemeIsDark() {
      if (themeMode === 'dark') return true;
      if (themeMode === 'light') return false;
      try { return SUITE.pageIsDark(); } catch (e) { return true; }
    }
    function applyPanelTheme() { if (panel) panel.classList.toggle('lite', !panelThemeIsDark()); }
    function cycleTheme() {
      themeMode = themeMode === 'auto' ? 'dark' : themeMode === 'dark' ? 'light' : 'auto';
      try { GM_setValue('sl:theme', themeMode); } catch (e) {}
      applyPanelTheme();
      toast('Theme: ' + themeMode);
    }

    /* ---------- dynamic accent: tint the whole panel from the artwork ---------- */
    function setAccent(rgb) {
      try {
        const hostEl = root.host;
        if (!rgb) { hostEl.style.removeProperty('--acc'); hostEl.style.removeProperty('--acc2'); return; }
        const [r, g2, b2] = rgb;
        hostEl.style.setProperty('--acc', `rgb(${r},${g2},${b2})`);
        hostEl.style.setProperty('--acc2', `rgb(${Math.min(255, r + 50)},${Math.min(255, g2 + 50)},${Math.min(255, b2 + 50)})`);
      } catch (e) {}
    }
    // artwork tint, but a forced accent MOOD always wins over it
    function applyArtAccent(rgb) {
      curArtAccent = rgb || null;
      if (mood !== 'auto') { setAccent(MOOD_RGB[mood]); return; }
      setAccent(rgb);
    }
    function tintFrom(image) {
      try {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 10;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(image, 0, 0, 10, 10);
        const d = cx.getImageData(0, 0, 10, 10).data;
        let r = 0, g2 = 0, b2 = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G2 = d[i + 1], B = d[i + 2];
          const mx = Math.max(R, G2, B), mn = Math.min(R, G2, B);
          if (mx < 40 || mn > 225 || mx - mn < 26) continue;   // skip blacks / whites / grays
          r += R; g2 += G2; b2 += B; n++;
        }
        if (n < 6) return null;
        r = r / n; g2 = g2 / n; b2 = b2 / n;
        const k = 235 / (Math.max(r, g2, b2) || 1);   // normalize brightness for readable glows
        const up = (v) => Math.min(255, Math.round(v * k));
        return [up(r), up(g2), up(b2)];
      } catch (e) { return null; }   // tainted canvas (no CORS) → keep default orange
    }

    /* ---------- hub tabs ---------- */
    function setTab(t) {
      if (t !== 'lyrics' && t !== 'queue' && t !== 'stats' && t !== 'tweaks' && t !== 'audio') return;
      tab = t;
      if (t !== 'lyrics') { closeFind(); if (searchMode) exitSearch(); }   // find bar / manual search must not float over other tabs; a result found meanwhile gets painted
      try { GM_setValue('sl:tab', t); } catch (e) {}
      tabsEl.querySelectorAll('.tab').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
      body.style.display = t === 'lyrics' ? '' : 'none';
      qbody.style.display = t === 'queue' ? '' : 'none';
      sbody.style.display = t === 'stats' ? '' : 'none';
      if (ebody) ebody.style.display = t === 'tweaks' ? '' : 'none';
      if (abody) abody.style.display = t === 'audio' ? '' : 'none';
      // the data-heavy tabs (settings / stats / audio) get a bigger, roomier panel
      // so they don't feel cramped — lyrics/queue stay compact in the corner
      try { panel.classList.toggle('data', (t === 'tweaks' || t === 'stats' || t === 'audio') && !maxOn); } catch (e) {}
      try { panel.classList.toggle('audio', t === 'audio' && !maxOn); } catch (e) {}
      // the Audio tab routes the FX chain so its live spectrum has signal
      try { if (SUITE.audioTabActive) SUITE.audioTabActive(t === 'audio'); } catch (e) {}
      if (t === 'queue') renderQueue();
      if (t === 'stats') renderStats();
      if (t === 'tweaks') renderTweaks();
      if (t === 'audio') renderAudio();
    }
    function renderAudio() {
      try {
        if (!abody) return;
        if (SUITE.audioRender) SUITE.audioRender(abody);
        else abody.replaceChildren(stateEl(ICONS.note, 'Audio FX not loaded', 'The SoundCloud Enhancer module isn’t active.'));
      } catch (e) {}
    }
    function renderTweaks() {
      try {
        if (!ebody) return;
        if (SUITE.enhancerRender) SUITE.enhancerRender(ebody);
        else ebody.replaceChildren(stateEl(ICONS.note, 'Enhancer not loaded', 'The SoundCloud Enhancer module isn’t active.'));
      } catch (e) {}
    }
    function syncTabs() {
      if (!open) return;
      if (tab === 'queue') renderQueue();
      else if (tab === 'stats') renderStats();
      // Tweaks is not rebuilt here: a track change would throw away focus, scroll, open groups and any unsaved edit
    }

    function renderChapters() {   // the chapters block at the top of the Queue tab; true when anything was drawn
      const L = Chapters.list;
      if (!L.length) return false;
      const cues = L.length - Chapters.fromDesc;
      const head2 = document.createElement('div');
      head2.className = 'qhead';
      head2.textContent = (Chapters.fromDesc ? Chapters.fromDesc + (Chapters.fromDesc === 1 ? ' chapter' : ' chapters') + ' from the description' : '') + (cues ? (Chapters.fromDesc ? ' · ' : '') + cues + (cues === 1 ? ' cue point' : ' cue points') : '');
      qbody.appendChild(head2);
      const bar = document.createElement('div');
      bar.className = 'sbtns';
      bar.style.paddingTop = '2px';
      const cueB = document.createElement('button'); cueB.className = 'sbtn'; cueB.textContent = '+ Cue here'; cueB.title = 'Drop a cue point at the current time';
      cueB.addEventListener('click', () => addCueNow());
      const cpB = document.createElement('button'); cpB.className = 'sbtn'; cpB.textContent = 'Copy'; cpB.title = 'Copy the tracklist with timestamps';
      cpB.addEventListener('click', () => { try { GM_setClipboard(Chapters.tracklistText()); toast('Tracklist copied'); } catch (e) { toast('Copy failed'); } });
      bar.append(cueB, cpB);
      qbody.appendChild(bar);
      const wrap = document.createElement('div');
      const now = Chapters.indexAt(Media.time() || 0);
      L.forEach((c, i) => {
        const r = document.createElement('div');
        r.className = 'qrow ch' + (i === now ? ' now' : '') + (c.src === 'cue' ? ' cue' : '');
        r.tabIndex = 0; r.setAttribute('role', 'button');
        const n = document.createElement('span'); n.className = 'n'; n.textContent = Chapters.ts(c.t);
        const qt = document.createElement('span'); qt.className = 'qt'; qt.textContent = c.name;
        r.append(n, qt);
        if (c.src === 'cue') {
          r.title = 'Click to jump here · double-click to rename';
          const x = document.createElement('button'); x.className = 'chx'; x.textContent = '✕'; x.title = 'Remove this cue'; x.setAttribute('aria-label', 'Remove cue ' + c.name);
          x.addEventListener('click', (ev) => { ev.stopPropagation(); Chapters.removeCue(c.t); toast('Cue removed'); });
          r.appendChild(x);
          r.addEventListener('dblclick', () => { let v = null; try { v = prompt('Cue name', c.name); } catch (e) {} if (v != null && v.trim()) Chapters.renameCue(c.t, v.trim().slice(0, 80)); });
        } else r.title = 'Click to jump here';
        r.addEventListener('click', () => Media.seek(c.t));
        r.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); Media.seek(c.t); } });
        wrap.appendChild(r);
      });
      qbody.appendChild(wrap);
      return true;
    }
    function paintChapterNow() {   // 1 Hz while the Queue tab shows: the playing chapter follows the head
      try {
        if (tab !== 'queue' || !panel.classList.contains('open')) return;
        const rows = qbody.querySelectorAll('.qrow.ch');
        if (!rows.length) return;
        const now = Chapters.indexAt(Media.time() || 0);
        rows.forEach((r, i) => { const on = i === now; if (r.classList.contains('now') !== on) { r.classList.toggle('now', on); if (on) { try { r.scrollIntoView({ block: 'nearest' }); } catch (e) {} } } });
      } catch (e) {}
    }
    function curDur() { try { const el = Media.el(); return (el && isFinite(el.duration)) ? el.duration : 0; } catch (e) { return 0; } }
    function addCueNow() {
      const t = Media.time();
      if (!Chapters.href || !(t >= 0)) { toast('Play a track first'); return; }
      const nm = Chapters.addCue(t);
      if (nm) toast(nm + ' at ' + Chapters.ts(t) + ' · double-click it to rename');
    }
    function jumpChapter(d) {
      const L = Chapters.list; if (!L.length) { toast('No chapters on this track'); return; }
      const t = Media.time() || 0, i = Chapters.indexAt(t);
      let k = d > 0 ? i + 1 : (i >= 0 && t - L[i].t > 3 ? i : i - 1);
      k = Math.max(0, Math.min(L.length - 1, k));
      Media.seek(L[k].t); toast(Chapters.ts(L[k].t) + ' · ' + L[k].name);
    }
    function renderQueue() {
      // a track change re-renders this tab — keep whatever the user was typing AND
      // their focus/caret, so a track flipping mid-type doesn't kick them out of the box
      const prevInp = qbody.querySelector('input.inp');
      const prevFlt = (prevInp && prevInp.value) || '';
      let prevCaret = null;
      try { if (prevInp && prevInp.getRootNode().activeElement === prevInp) prevCaret = prevInp.selectionStart; } catch (e) {}
      qbody.replaceChildren();
      const hadCh = renderChapters();
      const list = SUITE.queueList && SUITE.queueList();
      if (!list) {
        if (!hadCh) qbody.appendChild(stateEl(ICONS.note, 'No shuffle queue', 'Run Shuffle Play and the full shuffled order shows up here.', [
          { label: 'Shuffle now', acc: true, fn: () => { const m = SUITE.shuffleNow ? SUITE.shuffleNow() : 'Shuffle module not loaded'; toast(m || 'Shuffling…'); } },
        ]));
        return;
      }
      const m = App.meta();
      const cur = m && m.href ? 'https://soundcloud.com' + m.href : '';
      let idx = -1;
      if (cur) for (let i = 0; i < list.length; i++) if (list[i].u === cur) { idx = i; break; }
      const head2 = document.createElement('div');
      head2.className = 'qhead';
      let remTxt = '';
      try {
        // wall-clock left in this run, from the library cache — zero network
        if (SUITE.libByUrl) {
          let remMs = 0, known = 0;
          for (let i = Math.max(0, idx); i < list.length; i++) {
            const lb = SUITE.libByUrl(list[i].u);
            if (lb && lb.durMs > 0) { remMs += lb.durMs; known++; }
          }
          if (known > 5) {
            const mn2 = Math.round(remMs / 60000);
            remTxt = ' · ≈ ' + (mn2 < 60 ? mn2 + 'm' : Math.floor(mn2 / 60) + 'h ' + (mn2 % 60) + 'm') + ' left';
          }
        }
      } catch (e) {}
      head2.textContent = (idx >= 0 ? `Track ${(idx + 1).toLocaleString()} of ${list.length.toLocaleString()}` : list.length.toLocaleString() + ' tracks queued') + remTxt;
      qbody.appendChild(head2);

      // type-to-filter the whole shuffled queue + a one-tap jump to "now"
      const bar = document.createElement('div');
      bar.className = 'sbtns';
      bar.style.paddingTop = '2px';
      const qin = document.createElement('input');
      qin.className = 'inp';
      qin.placeholder = 'Filter ' + list.length.toLocaleString() + ' tracks…';
      qin.style.cssText = 'flex:1;min-width:0;font-size:11px;padding:5px 11px;border-radius:9px;';
      qin.addEventListener('keydown', (ev) => ev.stopPropagation());
      const nowB = document.createElement('button');
      nowB.className = 'sbtn';
      nowB.textContent = 'Now';
      nowB.title = 'Jump back to the playing track';
      const reB = document.createElement('button');
      reB.className = 'sbtn';
      reB.textContent = '↻';
      reB.title = 'Reshuffle';
      reB.addEventListener('click', () => { const m = SUITE.shuffleNow ? SUITE.shuffleNow() : 'Shuffle module not loaded'; toast(m || 'Shuffling…'); });
      const exB = document.createElement('button');
      exB.className = 'sbtn';
      exB.textContent = 'M3U';
      exB.title = 'Export this queue as an .m3u8 playlist';
      exB.addEventListener('click', () => {
        try {
          const txt = '#EXTM3U\n' + list.map((x) => '#EXTINF:-1,' + (x.a ? x.a + ' - ' : '') + (x.t || x.u) + '\n' + x.u).join('\n');
          const blob = new Blob([txt], { type: 'audio/x-mpegurl' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'sc-queue-' + new Date().toISOString().slice(0, 10) + '.m3u8';
          (document.body || document.documentElement).appendChild(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
          toast('Queue exported');
        } catch (e) { toast('Export failed'); }
      });
      bar.append(qin, nowB, reB, exB);
      qbody.appendChild(bar);
      const rowsWrap = document.createElement('div');
      qbody.appendChild(rowsWrap);

      const mkRow = (x, i) => {
        const r = document.createElement('div');
        r.className = 'qrow' + (i === idx ? ' now' : '');
        const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1);
        const qt = document.createElement('span'); qt.className = 'qt'; qt.textContent = x.t || x.u;
        const qa = document.createElement('span'); qa.className = 'qa'; qa.textContent = x.a || '';
        r.append(n, qt, qa);
        try {
          const lb2 = SUITE.libByUrl && SUITE.libByUrl(x.u);
          if (lb2 && lb2.durMs > 0) {
            const s2 = Math.round(lb2.durMs / 1000);
            const dv = document.createElement('span');
            dv.className = 'qv';
            dv.textContent = Math.floor(s2 / 60) + ':' + String(s2 % 60).padStart(2, '0');
            r.appendChild(dv);
          }
        } catch (e) {}
        r.title = x.u + '\nDouble-click to open · right-click to copy';
        r.addEventListener('dblclick', () => { try { window.open(x.u, '_blank'); } catch (e) {} });
        r.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          try { GM_setClipboard(x.u); toast('Link copied'); } catch (e) {}
        });
        return r;
      };
      const fill = (flt) => {
        rowsWrap.replaceChildren();
        let nowRow = null;
        if (flt) {
          let shown = 0;
          for (let i = 0; i < list.length && shown < 100; i++) {
            const x = list[i];
            if (((x.t || '') + ' ' + (x.a || '')).toLowerCase().indexOf(flt) === -1) continue;
            rowsWrap.appendChild(mkRow(x, i));
            shown++;
          }
          if (!shown) {
            const none = document.createElement('div');
            none.className = 'qhead';
            none.textContent = 'No matches';
            rowsWrap.appendChild(none);
          }
          return;
        }
        const from = Math.max(0, idx - 3);
        const to = Math.min(list.length, (idx < 0 ? 60 : idx + 61));
        for (let i = from; i < to; i++) {
          const r = mkRow(list[i], i);
          rowsWrap.appendChild(r);
          if (i === idx) nowRow = r;
        }
        if (to < list.length) {
          const more = document.createElement('div');
          more.className = 'qhead';
          more.textContent = '… ' + (list.length - to).toLocaleString() + ' more ahead';
          rowsWrap.appendChild(more);
        }
        if (nowRow) requestAnimationFrame(() => { try { qbody.scrollTop = Math.max(0, nowRow.offsetTop - qbody.clientHeight * 0.3); } catch (e) {} });
      };
      qin.addEventListener('input', () => {
        clearTimeout(qin.__d);
        qin.__d = setTimeout(() => fill(qin.value.trim().toLowerCase()), 150);
      });
      nowB.addEventListener('click', () => { qin.value = ''; fill(''); });
      qin.value = prevFlt;
      fill(prevFlt.trim().toLowerCase());
      // restore focus + caret if the user was typing when the track changed
      if (prevCaret != null) { try { qin.focus(); qin.setSelectionRange(prevCaret, prevCaret); } catch (e) {} }
    }

    function renderStats() {
      sbody.replaceChildren();
      const s = SUITE.statsSnapshot && SUITE.statsSnapshot();
      if (!s) {
        sbody.appendChild(stateEl(ICONS.note, 'No stats yet', 'Play something and the numbers start counting.'));
        return;
      }
      const x = (SUITE.statsExtra && SUITE.statsExtra()) || null;   // v2.3: full detail, in-panel
      const fmtT = (ms) => { const mn = Math.floor(ms / 60000); return mn < 60 ? mn + 'm' : Math.floor(mn / 60) + 'h ' + (mn % 60) + 'm'; };
      const qh = (t) => { const h = document.createElement('div'); h.className = 'qhead'; h.textContent = t; return h; };
      const grid = (cells) => {
        const g = document.createElement('div'); g.className = 'sgrid';
        cells.forEach(([v, l]) => {
          const c = document.createElement('div'); c.className = 'scell';
          const vv = document.createElement('div'); vv.className = 'v'; vv.textContent = v;
          const ll = document.createElement('div'); ll.className = 'l'; ll.textContent = l;
          c.append(vv, ll); g.appendChild(c);
        });
        return g;
      };
      const rows = (items) => {
        items.forEach((rw) => {
          const r = document.createElement('div'); r.className = 'qrow';
          const qt = document.createElement('span'); qt.className = 'qt'; qt.textContent = rw.t;
          r.appendChild(qt);
          if (rw.a) { const qa = document.createElement('span'); qa.className = 'qa'; qa.textContent = rw.a; r.appendChild(qa); }
          if (rw.v) { const qv = document.createElement('span'); qv.className = 'qv'; qv.textContent = rw.v; r.appendChild(qv); }
          sbody.appendChild(r);
        });
      };
      // hero — the headline number, big and proud
      const hero = document.createElement('div');
      hero.className = 'stathero';
      const shBig = document.createElement('div'); shBig.className = 'sh-big'; shBig.textContent = fmtT(s.allMs);
      const shSub = document.createElement('div'); shSub.className = 'sh-sub'; shSub.textContent = 'total listening · ' + (s.streak >= 2 ? s.streak + '-day streak 🔥' : (fmtT(s.todayMs) + ' today'));
      hero.append(shBig, shSub);
      sbody.appendChild(hero);
      sbody.appendChild(qh('This session'));
      sbody.appendChild(grid([[fmtT(s.sessMs), 'listened'], [String(s.played), 'played'], [String(s.skipped), 'skipped']]));
      sbody.appendChild(qh('Bigger picture'));
      sbody.appendChild(grid([[fmtT(s.todayMs), 'today'], [fmtT(s.allMs), 'all time'], [s.streak >= 2 ? s.streak + 'd' : '—', 'streak']]));
      if (x && x.days && x.days.some((d) => d.ms > 0)) {
        const weekMs = x.days.reduce((a, d) => a + d.ms, 0);
        sbody.appendChild(qh('Last 7 days · ' + fmtT(weekMs)));
        const max = Math.max(...x.days.map((d) => d.ms), 1);
        const sp = document.createElement('div'); sp.className = 'spark';
        const lb = document.createElement('div'); lb.className = 'sparkl';
        x.days.forEach((d) => {
          const b = document.createElement('b');
          if (d.today) b.className = 'today';
          b.style.height = Math.max(8, Math.round(d.ms / max * 100)) + '%';
          b.title = fmtT(d.ms);
          sp.appendChild(b);
          const l = document.createElement('span'); l.textContent = d.w; lb.appendChild(l);
        });
        sbody.appendChild(sp);
        sbody.appendChild(lb);
      }
      if (x && x.hours && x.hours.some((v) => v > 0)) {
        let peak = 0;
        x.hours.forEach((v, i) => { if (v > x.hours[peak]) peak = i; });
        const hmax = Math.max(...x.hours, 1);
        const fmtH2 = (h2) => (h2 % 12 === 0 ? 12 : h2 % 12) + (h2 < 12 ? 'am' : 'pm');
        sbody.appendChild(qh('Listening clock · peak ' + fmtH2(peak)));
        const hp = document.createElement('div'); hp.className = 'spark hrs';
        x.hours.forEach((v, i) => {
          const b = document.createElement('b');
          b.style.height = Math.max(6, Math.round(v / hmax * 100)) + '%';
          b.title = fmtH2(i) + ' · ' + fmtT(v);
          hp.appendChild(b);
        });
        sbody.appendChild(hp);
        const hl = document.createElement('div'); hl.className = 'sparkl';
        ['12am', '6am', '12pm', '6pm', '11pm'].forEach((t2) => {
          const sp2 = document.createElement('span'); sp2.textContent = t2; hl.appendChild(sp2);
        });
        sbody.appendChild(hl);
      }
      if (s.libN > 0) {
        const pct = Math.min(100, Math.round((s.heardN || 0) / s.libN * 100));
        sbody.appendChild(qh('Library coverage'));
        sbody.appendChild(grid([[s.libN.toLocaleString(), 'likes'], [(s.heardN || 0).toLocaleString(), 'plays logged'], ['≈' + pct + '%', 'explored']]));
      }
      {
        let goal = 0;
        try { goal = GM_getValue('sl:goal', 0) | 0; } catch (e) {}
        const hit = goal && s.todayMs >= goal * 60000;
        sbody.appendChild(qh('Daily goal' + (goal ? ' · ' + fmtT(Math.min(s.todayMs, goal * 60000)) + ' / ' + goal + 'm' + (hit ? ' ✓ done!' : '') : '')));
        const gb = document.createElement('div');
        gb.className = 'sbtns';
        [[30, '30m'], [60, '1h'], [120, '2h'], [0, 'Off']].forEach(([mn2, lbl]) => {
          const b2 = document.createElement('button');
          b2.className = 'sbtn';
          b2.textContent = lbl;
          b2.addEventListener('click', () => {
            try { GM_setValue('sl:goal', mn2); } catch (e) {}
            toast(mn2 ? 'Goal: ' + lbl + ' of listening a day' : 'Goal off');
            renderStats();
          });
          gb.appendChild(b2);
        });
        sbody.appendChild(gb);
      }
      const rem = SUITE.sleep ? SUITE.sleep.remainingMs() : 0;
      sbody.appendChild(qh('Sleep timer' + (SUITE.sleep && SUITE.sleep.armed() ? ' · after this track' : rem ? ' · ' + Math.max(1, Math.ceil(rem / 60000)) + 'm left' : '')));
      const btns = document.createElement('div'); btns.className = 'sbtns';
      [[15, '15m'], [30, '30m'], [60, '1h'], [-1, 'Track end'], [0, 'Off']].forEach(([mn, lbl]) => {
        const b2 = document.createElement('button'); b2.className = 'sbtn'; b2.textContent = lbl;
        b2.addEventListener('click', () => {
          if (!SUITE.sleep) return;
          if (mn === -1) {
            // fire just BEFORE this track ends → the watcher arms
            // "pause after this track" instead of fading mid-song
            const m2 = App.meta();
            let rate = 1; try { const el = Media.el(); if (el && el.playbackRate > 0) rate = el.playbackRate; } catch (e) {}   // the timer is wall-clock: media seconds left ÷ the speed
            const remS = m2 && m2.dur > 0 ? Math.max(5, (m2.dur - Media.time()) / rate) : 0;
            if (!remS) { toast('Play something first'); return; }
            SUITE.sleep.set(Math.max(0.01, remS / 60 - 0.12));
            toast('Pausing after this track');
          } else if (mn) { SUITE.sleep.set(mn); toast('Sleeping in ' + lbl); } else { SUITE.sleep.clear(); toast('Sleep timer off'); }
          renderStats();
        });
        btns.appendChild(b2);
      });
      sbody.appendChild(btns);
      if (x) {
        if (x.topArtists.length) { sbody.appendChild(qh('Top artists')); rows(x.topArtists.map((a) => ({ t: a.n, v: a.p + ' plays' }))); }
        if (x.onRepeat.length) { sbody.appendChild(qh('On repeat')); rows(x.onRepeat.map((r) => ({ t: r.t, a: r.a, v: r.n + '×' }))); }
        if (x.skipped.length) { sbody.appendChild(qh('Often skipped')); rows(x.skipped.map((r) => ({ t: r.t, a: r.a, v: r.n + '× skipped' }))); }
        if (x.recent.length) { sbody.appendChild(qh('Recently played')); rows(x.recent.map((r) => ({ t: r.t, a: r.a, v: r.when }))); }
      }
      sbody.appendChild(qh('More'));
      const btns2 = document.createElement('div'); btns2.className = 'sbtns';
      const mk = (lbl, fn) => { const b3 = document.createElement('button'); b3.className = 'sbtn'; b3.textContent = lbl; b3.addEventListener('click', fn); btns2.appendChild(b3); };
      mk('Shuffle now', () => { const msg = SUITE.shuffleNow ? SUITE.shuffleNow() : 'Shuffle module not loaded'; toast(msg || 'Shuffling…'); });
      mk('More like this', () => {
        const msg = SUITE.moreLikeThis ? SUITE.moreLikeThis() : 'Shuffle module not loaded';
        toast(msg || 'Shuffling this genre…');
      });
      mk('Shuffle settings', () => { if (SUITE.openShuffleSettings) SUITE.openShuffleSettings(bMenuEl); });
      mk('Copy history', () => {
        const txt2 = SUITE.historyText ? SUITE.historyText() : '';
        if (!txt2) { toast('No history yet'); return; }
        try { GM_setClipboard(txt2); toast('History copied'); } catch (e) { toast('Copy failed'); }
      });
      if (x && x.brokenN) {
        mk('Copy ' + x.brokenN + ' broken like' + (x.brokenN === 1 ? '' : 's'), () => {
          const txt2 = SUITE.brokenText ? SUITE.brokenText() : '';
          if (!txt2) { toast('Nothing to copy'); return; }
          try { GM_setClipboard(txt2); toast('Broken likes copied — go un-like them'); } catch (e) { toast('Copy failed'); }
        });
      }
      mk('Reset session', () => { if (SUITE.resetSession) SUITE.resetSession(); toast('Session reset'); renderStats(); });
      sbody.appendChild(btns2);
    }

    /* ---------- overflow menu ---------- */
    function buildMenu() {
      menuEl.replaceChildren();
      const mi = (label, fn, k) => {
        const b = document.createElement('button');
        b.className = 'mi';
        b.textContent = label;
        if (k) { const sk = document.createElement('span'); sk.className = 'k'; sk.textContent = k; b.appendChild(sk); }
        b.addEventListener('click', () => { setMenu(false); fn(); });
        menuEl.appendChild(b);
      };
      const sep = () => { const d = document.createElement('div'); d.className = 'msep'; menuEl.appendChild(d); };
      mi('Re-search this track', () => { setTab('lyrics'); App.retry(); });
      mi('Pick a different match', () => { setTab('lyrics'); enterSearch(); }, 'S');
      mi('Wrong lyrics — ban this match', () => App.banCurrent());
      mi('Set real artist for this uploader…', () => {
        const m2 = App.meta();
        if (!m2 || !m2.uploader) { toast('Play a track first'); return; }
        let v = null;
        try { v = prompt('Real credited artist for uploads by “' + m2.uploader + '”.\n\nUseful for collectives/labels where the uploader isn’t the artist (e.g. a crew name → the member who made it). Remembered for every future track from this uploader.', ''); } catch (e) {}
        if (v === null || !v.trim()) return;
        App.addAlias(m2.uploader, v.trim());
        toast('Saved — re-searching');
        App.retry();
      });
      mi('Copy report for this track', () => App.quickReport());
      mi('Mark as instrumental', () => App.markInstrumental());
      mi('Load .lrc / .txt file…', () => App.importLrc());
      mi('Paste lyrics…', () => pasteSheet());
      sep();
      mi('Find in lyrics', () => openFind(), '/');
      mi('Jump to chorus', () => jumpChorus(), 'C');
      mi('Focus mode: ' + (focusOn ? 'on' : 'off'), () => toggleFocus(), 'K');
      mi('Copy lyrics', () => App.copyLyrics());
      mi('Share a lyric card…', () => shareSheet());
      mi('Export .lrc file', () => App.exportLrc());
      if (Chapters.list.length || curDur() >= 600) {
        sep();
        if (Chapters.list.length) mi('Chapters (' + Chapters.list.length + ')', () => setTab('queue'));
        mi('Add cue point at ' + Chapters.ts(Media.time() || 0), () => addCueNow());
        if (Chapters.list.length) mi('Copy tracklist', () => { try { GM_setClipboard(Chapters.tracklistText()); toast('Tracklist copied'); } catch (e) { toast('Copy failed'); } });
      }
      // contribute back — only for lyrics you vetted (pasted / imported /
      // hand-picked / calibrated), so we never publish a junk guess
      if (curLyr && !curLyr.instr && (curLyr.picked || curLyr.src === 'file' || curLyr.src === 'paste' || App.anchorCount() > 0)) {
        mi('Publish lyrics to LRCLIB ↗', () => App.publishLrclib());
      }
      sep();
      mi('Calibrate sync (tap along)', () => startTapAlign(), 'A');
      mi('Reset sync & anchors', () => App.nudge(0), '0');
      // a clear vocal-alignment finding (≥ 200 ms, not declined) for this synced sheet, not yet applied
      { const r = SyncAuto.last; if (r && !r.reason && r.confidence > 0 && Math.abs(r.lagSec) >= SyncAuto.MIN_SEC && !SyncAuto.ms && curLyr && curLyr.synced && SyncAuto.apply) {
        const ms = -Math.round(r.lagSec * 1000);
        mi('Align to vocals: ' + (ms > 0 ? '+' : '') + (ms / 1000).toFixed(2) + 's (' + (r.confidence >= 0.5 ? 'clear' : r.confidence >= 0.2 ? 'likely' : 'weak') + ')', () => SyncAuto.apply());
      } }
      mi('Sync wizard: ' + (wizOn ? 'on' : 'off'), () => toggleWizard());
      mi('Audio latency: auto ' + (App.autoLatencyMs() || 0) + 'ms' + ((App.latencyMs() || 0) ? ' + ' + App.latencyMs() + ' manual' : ''), () => {
        let v = null;
        try { v = prompt('Extra sync nudge (ms), on top of the ' + (App.autoLatencyMs() || 0) + 'ms auto-detected from your audio device.\n\nPositive = lyrics earlier (use if they feel LATE).\nNegative = lyrics later (use if they feel EARLY / ahead).\n0 = auto only.', String(App.latencyMs() || 0)); } catch (e) {}
        if (v === null) return;
        App.setLatency(parseInt(v, 10) || 0);
      });
      mi('Highlight timing: ' + (App.leadMs() === 0 ? 'exact' : App.leadMs() === 250 ? 'early' : 'standard'), () => App.cycleLead());
      mi('Reset learned sync memory', () => { try { GM_setValue('sl:soff', {}); } catch (e) {} toast('Sync memory cleared'); });
      sep();
      mi('Theme: ' + themeMode, () => { cycleTheme(); }, 'T');
      mi('Accent: ' + mood, () => cycleMood(), 'M');
      mi('Backdrop: ' + glass, () => cycleGlass(), 'G');
      mi('Lyrics font: ' + fontFam, () => cycleFont());
      mi('Comfort spacing: ' + (comfyOn ? 'on' : 'off'), () => toggleComfy());
      mi('Snap to corner ▸', () => {
        // quick re-open the menu as a corner picker
        setMenu(false);
        const pick = (c) => { snapCorner(c); };
        const m2 = menuEl; m2.replaceChildren();
        [['Top-left', 'tl'], ['Top-right', 'tr'], ['Bottom-left', 'bl'], ['Bottom-right', 'br']].forEach(([lbl, c]) => {
          const b = document.createElement('button'); b.className = 'mi'; b.textContent = lbl;
          b.addEventListener('click', () => { setMenu(false); pick(c); }); m2.appendChild(b);
        });
        setMenu(true, true);   // keep the picker — a rebuild would put the full menu back
      });
      sep();
      mi('Mini lyric bar: ' + (miniOn ? 'on' : 'off'), () => toggleMini(), 'N');
      mi('Lyrics in tab title: ' + (tabTitleOn ? 'on' : 'off'), () => toggleTabTitle());
      mi('Auto-open when found: ' + (autoOpenFound ? 'on' : 'off'), () => toggleAutoOpen());
      mi('Hover pre-warm: ' + (App.hoverOn() ? 'on' : 'off'), () => App.toggleHover());
      sep();
      mi('Genius API token: ' + (Gtok.has() ? 'set ✓' : 'not set'), () => {
        let v = null;
        try {
          v = prompt('Paste your Genius API "Client Access Token".\n\nGet one free at genius.com/api-clients — sign in, create an API Client (any app name + URL), then copy the Client Access Token.\n\nThis makes finding the right song reliable on networks that block Genius. Leave empty to clear.', Gtok.get() || '');
        } catch (e) {}
        if (v === null) return;
        Gtok.set(v);
        toast(v.trim() ? 'Genius token saved — searches just got more reliable' : 'Genius token cleared');
      });
      mi('Strict privacy: ' + (Strict.get() ? 'on ✓ (skip 3rd-party proxies)' : 'off'), () => {
        const now = Strict.toggle();
        toast(now
          ? 'Strict privacy on — Genius pages: direct + Wayback only (no codetabs/allorigins). Some VPN-blocked tracks may stop resolving.'
          : 'Strict privacy off — all proxies available as fallback.');
      });
      sep();
      let cn = 0, mn = 0;
      try { cn = (GM_getValue('sl4:idx', []) || []).length; } catch (e) {}
      try { mn = Object.keys(GM_getValue('sl4:miss', {}) || {}).length; } catch (e) {}
      mi('Export lyric library (' + cn + ')', () => App.exportLibraryJson());
      mi('Clear lyric cache (' + cn + ')', () => { Cache.clear(); Miss.clearAll(); toast('Lyric cache cleared'); });
      if (mn) mi('Retry ' + mn + ' missed track' + (mn === 1 ? '' : 's'), () => { Miss.clearAll(); toast('Miss list cleared — they’ll search again'); });
      sep();
      mi('Tweaks & settings ✦', () => { if (SUITE.openEnhancer) SUITE.openEnhancer(); });
      mi('Shuffle my Likes', () => { const m = SUITE.shuffleNow ? SUITE.shuffleNow() : 'Shuffle module not loaded'; if (m) toast(m); }, 'Alt+S');
      mi('Hotkeys', () => showKeys(true), '?');
      mi(transOn ? 'Stop translating lyrics' : ('Translate lyrics → ' + transLang.toUpperCase()), () => toggleTranslate());
      mi("What's new in v" + VER, () => showWhatsNew());
      mi('Diagnostics', () => { setTab('lyrics'); showDiag(); });
      mi('Copy sync debug → paste it to me', () => {
        try {
          const m = App.meta() || {};
          const ac = (SUITE.audioClock && SUITE.audioClock());
          const srcClk = ac != null ? 'captured-element' : (Media.el() ? 'active-element' : 'aria/text-fallback');
          let aria = -1;
          try { const w = document.querySelector('.playbackTimeline__progressWrapper'); if (w) { const v = parseFloat(w.getAttribute('aria-valuenow')); if (isFinite(v)) aria = +v.toFixed(2); } } catch (e) {}
          const elem = ac != null ? +ac.toFixed(2) : null;
          const drift = (elem != null && aria >= 0) ? +(elem - aria).toFixed(2) : null;
          let rate = 1; try { const el = Media.el(); if (el && el.playbackRate) rate = el.playbackRate; } catch (e) {}
          const L = curLyr || {};
          const type = L.instr ? 'instrumental' : (L.synced ? (L.scaled ? 'scaled-sync' : 'synced') : (estMode ? 'estimated' : 'text'));
          const ratio = (L.srcDur > 0 && m.dur > 0) ? +(m.dur / L.srcDur).toFixed(4) : null;
          const lineCount = (L.lines && L.lines.length) || 0;
          let act = '';
          try { if (activeI >= 0 && lineEls[activeI]) act = (lineEls[activeI].textContent || '').slice(0, 50); } catch (e) {}
          const samp = [];
          try {
            const real = [];
            for (let i = 0; i < lineEls.length; i++) if (lineEls[i] && lineEls[i].classList && lineEls[i].classList.contains('line')) real.push(i);
            const pick = real.length <= 6 ? real : [real[0], real[1], real[2], real[Math.floor(real.length / 2)], real[real.length - 2], real[real.length - 1]];
            pick.forEach((i) => samp.push('  t=' + (times[i] != null ? times[i].toFixed(2) : '?') + 's  "' + (lineEls[i].textContent || '').slice(0, 42) + '"'));
          } catch (e) {}
          const out = [
            'SoundCloud Suite sync debug · v' + VER,
            'track: "' + (m.title || '?') + '" — ' + (m.uploader || '?'),
            'SC duration: ' + (m.dur || '?') + 's   href: ' + (m.href || '?'),
            'lyric source: ' + (L.src || '?') + '   type: ' + type + '   score: ' + (L.score != null ? +L.score.toFixed(2) : '?'),
            'lyric srcDuration: ' + (L.srcDur || '?') + 's   SC/src ratio: ' + (ratio != null ? ratio : '?') + (ratio != null && Math.abs(ratio - 1) > 0.008 ? '  (auto-scaled)' : ''),
            'lines: ' + lineCount,
            'clock: source=' + srcClk + '  media=' + (elem != null ? elem : '?') + 's  SC-timeline=' + (aria >= 0 ? aria : '?') + 's  delta=' + (drift != null ? drift : '?') + 's  rate=' + rate,
            'usedTime: ' + Media.time().toFixed(2) + 's',
            'offsets: global=' + (App.latencyMs() || 0) + 'ms  track=' + (App.offsetMs() || 0) + 'ms  auto=' + (SyncAuto.ms | 0) + 'ms' + (SyncAuto.last ? ' (conf ' + (+SyncAuto.last.confidence).toFixed(2) + (SyncAuto.last.reason ? ', ' + SyncAuto.last.reason : '') + ')' : '') + '  anchors=' + (App.anchorCount() || 0) + '  lead=' + (App.leadMs() || 0) + 'ms  autoLat=' + (App.autoLatencyMs() || 0) + 'ms',
            'active line #' + activeI + ': "' + act + '"',
            'sample lines (effective time -> text):',
          ].concat(samp).join('\n');
          // route through the shared redactor before any clipboard sink so a track
          // href with ?client_id=… or a swallowed Bearer can never ride along
          const safe = (Log && Log.redact) ? Log.redact(out) : out;
          console.log('%c[SoundCloud Suite sync]', 'color:#ff5500;font-weight:700', '\n' + safe);
          try { GM_setClipboard(safe); toast('Sync debug copied — paste it to me'); return; } catch (e) {}
          try { navigator.clipboard.writeText(safe).then(() => toast('Sync debug copied — paste it to me'), () => toast('Logged to console (clipboard blocked)')); } catch (e) { toast('Logged to console'); }
        } catch (e) { toast('Sync debug failed'); }
      });
      mi('Copy theme debug → paste it to me', () => {
        try {
          // read-only DOM scan of the areas flagged as un-themed (comments + the
          // FANS/leaderboard rail + related), dumping the REAL class names + their
          // current background so I can write exact CSS instead of guessing.
          const out = [], seen = new Set();
          const sel = '[class*="comment" i],[class*="fan" i],[class*="leaderboard" i],[class*="related" i],aside,aside *,[class*="sidebar" i] *';
          document.querySelectorAll(sel).forEach((el) => {
            if (out.length >= 70 || !el || !el.tagName) return;
            let cls = '';
            try { cls = (el.getAttribute && el.getAttribute('class')) || ''; } catch (e) {}
            if (!cls || typeof cls !== 'string' || !cls.trim()) return;
            const key = el.tagName + '|' + cls;
            if (seen.has(key)) return;
            seen.add(key);
            let bg = '';
            try { bg = getComputedStyle(el).backgroundColor; } catch (e) {}
            out.push(el.tagName.toLowerCase() + '  class="' + cls.slice(0, 110) + '"  bg=' + bg);
          });
          const raw = 'SoundCloud Suite theme debug · v' + VER + '\n' + out.length + ' elements (comments / fans / leaderboard / related / sidebar):\n' + out.join('\n');
          const txt = (Log && Log.redact) ? Log.redact(raw) : raw;
          console.log(txt);
          try { GM_setClipboard(txt); toast('Theme debug copied — paste it to me'); return; } catch (e) {}
          try { navigator.clipboard.writeText(txt).then(() => toast('Theme debug copied — paste it to me'), () => toast('Logged to console')); } catch (e) { toast('Logged to console'); }
        } catch (e) { toast('Theme debug failed'); }
      });
      mi('Copy error log', () => {
        const txt = 'SoundCloud Suite error log · v' + VER + '\n' + Log.dump();
        try { GM_setClipboard(txt); toast('Error log copied'); return; } catch (e) {}
        try { navigator.clipboard.writeText(txt).then(() => toast('Error log copied'), () => toast('Logged to console')); console.log(txt); } catch (e) { toast('Logged to console'); }
      });
      mi('Run title self-test', () => {
        const res = titleSelfTest();
        const pass = res.filter((r) => r.ok).length;
        const raw = 'Title parser self-test: ' + pass + '/' + res.length + ' passed\n\n'
          + res.map((r) => (r.ok ? 'OK   ' : 'FAIL ') + r.in + (r.ok ? '' : '\n      → ' + r.why)).join('\n');
        const report = (Log && Log.redact) ? Log.redact(raw) : raw;
        try { GM_setClipboard(report); } catch (e) {}
        toast(pass === res.length ? 'Title self-test: all ' + res.length + ' passed ✓' : 'Title self-test: ' + pass + '/' + res.length + ' — details copied');
      });
    }
    // tap-away anywhere on the PAGE (not just inside the panel's shadow root) closes
    // the ⋯ menu — composedPath sees through the shadow boundary so in-menu taps stay open
    function docMenuAway(e) {
      if (!menuOn) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (!path.includes(menuEl) && !path.includes(bMenuEl)) setMenu(false);
    }
    function setMenu(v, keep) {
      menuOn = !!v;
      if (menuOn && !keep) buildMenu();
      menuEl.classList.toggle('on', menuOn);
      // keep the bMenu button's aria-expanded in sync so screen readers
      // announce the open/closed state correctly (was declared but never wired
      // when the ARIA attributes shipped in Sprint 3 — fixed in Sprint 5).
      try { const b = panel && panel.querySelector('#bMenu'); if (b) b.setAttribute('aria-expanded', menuOn ? 'true' : 'false'); } catch (e) {}
      try {
        if (menuOn) document.addEventListener('pointerdown', docMenuAway, true);
        else document.removeEventListener('pointerdown', docMenuAway, true);
      } catch (e) {}
    }

    /* ---------- immersive fullscreen ---------- */
    let idleT = 0;
    function wakeChrome() {
      if (!maxOn) return;
      panel.classList.remove('idle');
      clearTimeout(idleT);
      idleT = setTimeout(() => { if (maxOn && open) panel.classList.add('idle'); }, 3000);
    }
    function toggleMax(force, silent) {
      maxOn = force != null ? !!force : !maxOn;
      panel.classList.toggle('max', maxOn);
      // keep #bMax aria-pressed in sync with the visible state (was declared
      // but never wired when ARIA attributes shipped in Sprint 3).
      try { const b = panel && panel.querySelector('#bMax'); if (b) b.setAttribute('aria-pressed', maxOn ? 'true' : 'false'); } catch (e) {}
      // switchTab drops the per-tab size class (data/audio) while maxed — re-apply it
      // for the current tab when LEAVING immersive, else the panel snaps to the cramped
      // 300px width on Stats/Tweaks/Audio (the EQ/settings need the wider panel).
      try { panel.classList.toggle('data', !maxOn && (tab === 'tweaks' || tab === 'stats' || tab === 'audio')); } catch (e) {}
      try { panel.classList.toggle('audio', !maxOn && tab === 'audio'); } catch (e) {}
      // remember the user's choice — the panel reopens the way they left it.
      // `silent` marks automatic exits (panel closing), which must not count.
      if (!silent) { try { GM_setValue('sl:max', maxOn ? 1 : 0); } catch (e) {} }
      if (maxOn && !open) setOpen(true);
      if (maxOn) wakeChrome();
      else { panel.classList.remove('idle'); clearTimeout(idleT); }
      // recenter the active line after the reflow (and wake one frame even while paused)
      activeI = -1; lastFrameNow = -1;
      pauseScrollUntil = 0;
    }

    /* ---------- hotkey cheat sheet ---------- */
    function showKeys(v) {
      if (v && !keysBuilt) {
        keysBuilt = true;
        const h = document.createElement('h3');
        h.textContent = 'Keyboard shortcuts';
        keysEl.appendChild(h);
        [['Alt+L', 'Toggle this panel'], ['Alt+S', 'Shuffle your Likes'], ['Alt+B', 'Block current track'],
         ['F', 'Immersive fullscreen'], ['K', 'Focus (karaoke) mode'], ['S', 'Search lyrics manually'],
         ['/', 'Find in lyrics'], ['C', 'Jump to chorus'], ['↑ / ↓', 'Seek previous / next line'],
         ['R', 'Replay current line'], ['A', 'Calibrate sync (tap along)'], ['1 – 5', 'Lyrics · Queue · Stats · Audio · Tweaks'],
         ['Space', 'Play / pause'], ['J / L', 'Seek ∓10 s'], ['← / →', 'Seek ∓5 s'],
         ['[ / ]', 'Nudge sync ±100 ms'], ['{ / }', 'Fine nudge ±25 ms'], ['< / >', 'Coarse nudge ±500 ms'],
         ['0', 'Reset sync & anchors'], ['− / =', 'Lyrics text size'], ['T', 'Cycle theme'],
         ['M', 'Accent mood'], ['G', 'Backdrop density'], ['N', 'Mini lyric bar'],
         ['Audio tab', 'A hold = compare · N night · , . speed (with Global hotkeys on)'],
         ['Click a line', 'Seek there'], ['2× click a line', 'On guessed timing: pin that line as an anchor'], ['Alt+click a line', 'Copy quote + timestamp'], ['Right-click a line', 'Copy that line'],
         ['2× click artwork', 'Immersive fullscreen'], ['Click title', 'Copy track link'], ['Click the clock', 'Time left ↔ elapsed'],
         ['Esc', 'Back out (sheet → menu → find → fullscreen → search → close)'], ['?', 'This sheet']]
          .forEach(([k, d]) => {
            const r = document.createElement('div'); r.className = 'krow';
            const b = document.createElement('b');
            const i = document.createElement('i'); i.textContent = k;
            b.appendChild(i); r.appendChild(b);
            const sp = document.createElement('span'); sp.textContent = d;
            r.appendChild(sp);
            keysEl.appendChild(r);
          });
      }
      keysOn = !!v;
      keysEl.classList.toggle('on', keysOn);
    }

    // Esc backs out one layer at a time; returns true when it consumed the key
    function escStep() {
      if (paletteOpen()) { closePalette(); return true; }   // the palette sits above everything
      if (tapOn) { endTapAlign(tapIdx > 0); return true; }                    // finish calibration (no "saved" toast when nothing was tapped)
      const ps = panel.querySelector('.keys.on');
      if (ps && ps !== keysEl && ps !== wnEl) { ps.remove(); return true; }   // paste sheet
      if (wnEl && wnEl.classList.contains('on')) { wnEl.classList.remove('on'); return true; }
      if (keysOn) { showKeys(false); return true; }
      if (menuOn) { setMenu(false); return true; }
      if (findWrap) { closeFind(); return true; }
      if (maxOn) { toggleMax(false); return true; }
      return false;
    }

    /* ---------- share a line ---------- */
    function copyLine(text) {
      const m2 = App.meta();
      const quote = '“' + text + '”' + (m2 && m2.title ? ' — ' + m2.title : '');
      try { if (GM_setClipboard(quote) !== false) { toast('Line copied'); return; } } catch (e) {}
      try { navigator.clipboard.writeText(quote).then(() => toast('Line copied'), () => toast('Copy failed')); } catch (e) { toast('Copy failed'); }
    }

    const fmtClock = (t) => { t = Math.max(0, Math.floor(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

    let hdrGen = 0;   // a slow artwork error/load from the previous track must not repaint the next one's header
    function setHeader(meta) {
      const gen = ++hdrGen;
      uiMeta = meta || null;
      tt.textContent = meta && meta.title ? meta.title : 'SoundCloud Suite';
      tt.title = tt.textContent;
      const eqHtml = '<div class="eq"><i></i><i></i><i></i></div>';
      // the artwork URL derives from user-uploaded data and lands in a CSS
      // url() literal — strip anything that could break out of it
      const cssSafe = (u) => String(u || '').replace(/["'()\\\s]/g, '');
      if (meta && meta.art) {
        const orig = meta.art;
        const hi = orig.replace(/-t\d+x\d+(\.\w+)/, '-t200x200$1');
        const img = new Image();
        img.alt = '';
        img.onerror = () => {
          if (gen !== hdrGen) return;
          if (img.src !== orig) { img.src = orig; glowEl.style.backgroundImage = `url("${cssSafe(orig)}")`; }
          else { art.innerHTML = ICONS.note + eqHtml; glowEl.style.backgroundImage = ''; panel.classList.remove('haz'); }
        };
        img.src = hi;
        glowEl.style.backgroundImage = `url("${cssSafe(hi)}")`;
        panel.classList.add('haz');
        art.innerHTML = eqHtml;
        art.insertBefore(img, art.firstChild);
        // dynamic accent: a second CORS image feeds the tint sampler so a
        // missing CORS header can never break the visible artwork
        try {
          const tImg = new Image();
          tImg.crossOrigin = 'anonymous';
          tImg.onload = () => { if (gen === hdrGen) applyArtAccent(tintFrom(tImg)); };
          tImg.onerror = () => { if (gen === hdrGen) applyArtAccent(null); };
          tImg.src = hi;
        } catch (e) { applyArtAccent(null); }
      } else {
        art.innerHTML = ICONS.note + (meta ? eqHtml : '');
        glowEl.style.backgroundImage = '';
        panel.classList.remove('haz');
        applyArtAccent(null);
      }
      applyPanelTheme();
    }

    function setSrcLine(html, clickable) {
      src.innerHTML = html;
      src.classList.toggle('lk', !!clickable);
    }

    function setNext(info) {
      try {
        const n = panel && panel.querySelector('#nxt');
        if (!n) return;
        if (!info || !info.t) { n.classList.remove('show'); n.innerHTML = ''; return; }
        n.innerHTML = 'Next up: <b></b>' + (info.ready ? ' <span class="zap">⚡ lyrics ready</span>' : '');
        n.querySelector('b').textContent = info.t.slice(0, 48);
        n.classList.add('show');
      } catch (e) {}
    }

    const srcFor = (lyr) => {
      if (!lyr) return ['', false];
      const name = SRC_NAME[lyr.src] || 'Lyrics';
      const kind = lyr.synced ? (lyr.scaled ? 'Scaled sync' : 'Synced') : (estMode ? (App.anchorCount() > 0 ? 'Calibrated sync' : 'Est. sync') : 'Text');
      const qc = lyr.synced ? '#3ddc84' : (estMode ? '#ffb454' : '#8b8b92');
      let s = `<span class="qdot" style="background:${qc};box-shadow:0 0 6px ${qc}66"></span>${name}<span class="dot"> · </span>${kind}`;
      // a persisted nudge silently re-applies on every future play — show it
      const om = App.offsetMs ? App.offsetMs() : 0, am = SyncAuto.ms | 0;
      if (om || am) { const tot = om + am; s += `<span class="dot"> · </span>${!om && am ? 'auto ' : ''}${tot > 0 ? '+' : ''}${(tot / 1000).toFixed(Math.abs(tot) % 100 ? 2 : 1)}s`; }
      let lk = false;
      if (lyr.picked) s += '<span class="dot"> · </span>Picked';
      else if (lyr.low) { s += '<span class="dot"> · </span>Low match — tap to fix'; lk = true; }
      return [s, lk];
    };

    function stateEl(icon, h, p, buttons) {
      const d = document.createElement('div');
      d.className = 'state';
      d.innerHTML = `<div class="ic">${icon}</div>${h ? `<div class="h">${esc(h)}</div>` : ''}${p ? `<div class="p">${esc(p)}</div>` : ''}`;
      if (buttons && buttons.length) {
        const row = document.createElement('div');
        row.className = 'row';
        for (const b of buttons) {
          const btn = document.createElement('button');
          btn.className = 'btn' + (b.acc ? ' acc' : '');
          btn.textContent = b.label;
          btn.addEventListener('click', b.fn);
          row.appendChild(btn);
        }
        d.appendChild(row);
      }
      return d;
    }

    function showIdle() {
      clearLyrics();
      body.replaceChildren(stateEl(ICONS.note, 'Play something', 'Lyrics will appear here.'));
      setSrcLine('Play a song');
    }
    function setBusy(v) {
      try { fab.classList.toggle('busy', !!v); } catch (e) {}
    }
    function stopLoadTick() { if (loadTick) { try { loadTick.stop(); } catch (e) {} loadTick = null; } }
    function showLoading() {
      clearLyrics();
      body.innerHTML = '<div class="sk" style="width:72%"></div><div class="sk" style="width:86%"></div><div class="sk" style="width:58%"></div><div class="sk" style="width:78%"></div>';
      setSrcLine('Searching…');
      stopLoadTick();
      loadT0 = performance.now();
      loadTick = Ticker.every(() => {
        // live elapsed readout while the race runs; parks itself the moment
        // anything else writes the source line
        if (!open || src.textContent.indexOf('Searching') !== 0) { stopLoadTick(); return; }
        setSrcLine('Searching… ' + ((performance.now() - loadT0) / 1000).toFixed(1) + 's');
      }, 300);
    }
    function showNone() {
      clearLyrics();
      body.replaceChildren(stateEl(ICONS.sad, 'No lyrics found', 'Searched Genius, Musixmatch, LRCLIB, Kugou, NetEase and the web. Underground tracks often aren’t transcribed anywhere — paste your own, or report it.', [
        { label: 'Search', acc: true, fn: () => enterSearch() },
        { label: 'Paste lyrics', fn: () => pasteSheet() },
        { label: 'Retry', fn: () => App.retry() },
        { label: 'Report', fn: () => App.quickReport() },
        { label: 'Instrumental', fn: () => App.markInstrumental() },
        ...(Chapters.list.length ? [{ label: 'Chapters (' + Chapters.list.length + ')', fn: () => setTab('queue') }] : []),
      ]));
      setSrcLine('No match — tap to search', true);
    }
    function showError() {
      clearLyrics();
      body.replaceChildren(stateEl(ICONS.off, "Can't reach lyric sources", 'Check your connection, then retry.', [
        { label: 'Retry', acc: true, fn: () => App.retry() },
      ]));
      setSrcLine('Offline?');
    }
    function showInstrumental() {
      clearLyrics();
      body.replaceChildren(stateEl(ICONS.note, 'Instrumental', 'No lyrics for this one.'));
      setSrcLine('Instrumental');
    }

    function clearLyrics() {
      if (shareBar) shareClose();
      closeFind();   // stale hits over the next track's state would point at detached lines
      lineEls = []; times = []; lineWords = []; activeI = -1; isSynced = false; estMode = false;
      estBaseTimes = null;
      ++transToken;   // invalidate any in-flight translation so it can't decorate the next track's lines
      if (tapOn) endTapAlign(false);
      hideWizard();
    }

    /* ---------- tap-along calibration: align a whole song in one pass ----------
     * Play the track and press ⎵ (or click the chip) right as each line is
     * sung; every tap drops an anchor and the timeline warps live. Far faster
     * than scattered double-taps, and the result persists per track. */
    function startTapAlign() {
      if (searchMode) exitSearch();
      if (!lineEls.length) { toast('Play a track with lyrics first'); return; }
      if (!estMode) { toast(isSynced ? 'Already synced — nudge with [ and ]' : 'Needs timed lyrics to calibrate'); return; }
      if (tab !== 'lyrics') setTab('lyrics');
      if (!Media.playing()) { toast('Press play first, then tap ⎵ as each line starts'); return; }
      tapOn = true; tapIdx = 0;
      pauseScrollUntil = 0; activeI = -1;
      tapTick();
      toast('Tap ⎵ as each line starts · Esc to finish');
    }
    function tapTick() {
      if (!tapOn) return;
      const total = lineEls.length;
      const next = lineEls[tapIdx];
      if (next) {
        body.scrollTo({ top: Math.max(0, next.offsetTop - body.clientHeight * 0.4), behavior: 'smooth' });
        lineEls.forEach((el, k) => { el.classList.toggle('tapnext', k === tapIdx); });
      }
      setSrcLine('Calibrating · tap ⎵ or click · line ' + Math.min(tapIdx + 1, total) + ' / ' + total + ' · Esc done');
    }
    function tapAdvance() {
      if (!tapOn) return;
      if (tapIdx >= lineEls.length) { endTapAlign(true); return; }
      const list = App.addAnchor(tapIdx, Media.time());   // anchor THIS line to now
      if (estBaseTimes) times = warpTimes(estBaseTimes, list);   // est mode re-warps live
      tapIdx++;
      if (tapIdx >= lineEls.length) { endTapAlign(true); return; }
      tapTick();
    }
    function endTapAlign(done) {
      if (!tapOn) return;
      tapOn = false;
      lineEls.forEach((el) => el.classList && el.classList.remove('tapnext'));
      try { if (curLyr) { const sl = srcFor(curLyr); setSrcLine(sl[0], sl[1]); } } catch (e) {}
      if (done) toast('Sync calibrated — saved for this track');
      activeI = -1; lastFrameNow = -1; pauseScrollUntil = 0;
    }

    function renderLyrics(lyr) {
      curLyr = lyr;
      exitSearch(true);
      closeFind();
      hideWizard();
      clearLyrics();
      const frag = document.createDocumentFragment();
      const m = App.meta();
      const dur = m && m.dur > 0 ? m.dur : 0;

      let mode = 'text';
      if (lyr.synced) mode = 'sync';
      else if (dur > 20 && dur < 1200) {
        // no estimated sync over DJ-mix lengths: smearing 40 lines across an
        // hour produces confidently-wrong highlights and useless seeking
        const realLines = lyr.lines.filter((l) => l && !/^\[[^\]]{1,40}\]$/.test(l)).length;
        if (realLines >= 8) mode = 'est';
      }
      isSynced = mode !== 'text';
      estMode = mode === 'est';

      let di = 0;
      const stagger = (el) => { el.style.animationDelay = Math.min(di * 14, 280) + 'ms'; di++; };
      const seekTo = (t) => {
        // the highlight loop adds +(off+latency) to media time, so line i
        // activates at media time (times[i] − off − latency) — seeking must
        // SUBTRACT both or a nudged sync lands away from the clicked line
        const off = ((App.offsetMs() || 0) + (App.latencyMs() || 0) + (SyncAuto.ms || 0)) / 1000;
        Media.seek(Math.max(0, t - off));
        pauseScrollUntil = 0;
      };

      if (mode === 'sync') {
        const L = lyr.lines;
        // word-level timing map (Musixmatch richsync), keyed by line-start
        // centiseconds — matched to each rendered line by its own time
        const wtMap = (lyr && lyr.wt && typeof lyr.wt === 'object') ? lyr.wt : null;
        const entries = [];
        if (L.length && L[0][0] > 7) entries.push({ g: 1, t: 0 });
        L.forEach(([t, txt], i) => {
          entries.push({ t, txt });
          const n = L[i + 1];
          if (n && n[0] - t > 8) entries.push({ g: 1, t: t + 2.2 });
        });

        // confirmed synced → render the source's own (already duration-scaled)
        // timestamps verbatim. No per-line anchoring/warp: it's accurate as-is.
        for (const en of entries) {
          const idx = lineEls.length;
          let el;
          if (en.g) {
            el = document.createElement('div');
            el.className = 'dots';
            el.innerHTML = '<i></i><i></i><i></i>';
            el.addEventListener('click', () => seekTo(times[idx]));
          } else {
            el = document.createElement('div');
            el.className = 'line sk-click';
            el.textContent = en.txt;
            // CONFIRMED SYNCED lyrics are already accurate — clicking a line just
            // SEEKS to it. No tap-to-anchor here: anchoring real synced timing has
            // no point and could only RUIN it. (Calibration is estimated-only.) [user]
            // alt-click copies the line + timestamp; right-click copies the quote.
            let ct = 0;
            el.addEventListener('click', (ev) => {
              clearTimeout(ct);
              if (ev.altKey) { copyLineTs(en.txt, times[idx]); return; }
              ct = setTimeout(() => seekTo(times[idx]), 280);
            });
            el.addEventListener('dblclick', (ev) => { ev.preventDefault(); clearTimeout(ct); seekTo(times[idx]); });
            el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); copyLine(en.txt); });
          }
          stagger(el);
          frag.appendChild(el);
          lineEls.push(el);
          times.push(en.t);
          lineWords.push((!en.g && wtMap) ? (wtMap[String(Math.round(en.t * 100))] || null) : null);
        }
      } else if (mode === 'est') {
        const baseTimes = [];
        for (const en of estimateTimes(lyr.lines, dur)) {
          if (en.gap) { const g = document.createElement('div'); g.className = 'gap'; frag.appendChild(g); continue; }
          if (en.sec) {
            const s = document.createElement('div');
            s.className = 'sec';
            s.textContent = en.text.slice(1, -1);
            stagger(s);
            frag.appendChild(s);
            continue;
          }
          const el = document.createElement('div');
          el.className = 'line sk-click';
          el.textContent = en.text;
          const idx = lineEls.length;
          let ct = 0;
          el.addEventListener('click', (ev) => {
            clearTimeout(ct);
            if (ev.altKey) { copyLineTs(en.text, times[idx]); return; }
            ct = setTimeout(() => seekTo(times[idx]), 280);
          });
          el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            clearTimeout(ct);
            const list = App.addAnchor(idx, Media.time());
            times = warpTimes(baseTimes, list);
            activeI = -1;
            const [s2, lk2] = srcFor(lyr);
            setSrcLine(s2, lk2);
            toast('Anchored — sync calibrated');
          });
          el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); copyLine(en.text); });
          stagger(el);
          frag.appendChild(el);
          lineEls.push(el);
          baseTimes.push(en.t);
          lineWords.push(null);   // estimated lines have no word data — keep lockstep with lineEls/times
        }
        estBaseTimes = baseTimes;   // kept so tap-along can re-warp live
        times = warpTimes(baseTimes, App.getAnchors());
        if (!estTip && lineEls.length) {
          estTip = true;   // once per session (no synced lyrics exist for this track \u2014 timing is a guess)
          setTimeout(() => toast('Timing is a guess \u2014 press A to tap along'), 900);
        }
      } else {
        for (const text of lyr.lines) {
          if (text === '') { const g = document.createElement('div'); g.className = 'gap'; frag.appendChild(g); continue; }
          const el = document.createElement('div');
          if (/^\[[^\]]{1,40}\]$/.test(text)) {
            el.className = 'sec';
            el.textContent = text.slice(1, -1);
          } else {
            el.className = 'line u';
            el.textContent = text;
            el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); copyLine(text); });
          }
          stagger(el);
          frag.appendChild(el);
        }
      }

      body.replaceChildren(frag);
      body.scrollTop = 0;
      const [s, lk] = srcFor(lyr);
      setSrcLine(s, lk);
      try {
        src.title = (SRC_NAME[lyr.src] || lyr.src || '') + (lyr.score ? ' · match ' + Math.round(lyr.score * 100) + '%' : '')
          + (lyr.scaled ? ' · tempo-scaled' : '') + (estMode ? ' · estimated timing' : '');
      } catch (e) {}
      maybeWizard(lyr);
      try { if (transOn) decorateTranslation(); } catch (e) {}
    }

    // ── lyric translation ── decorate each rendered line with a dimmed
    // translation in the user's language. ADDITIVE: inserts a .tline SIBLING after
    // each .line, never touching the line's own content, so the karaoke wipe and
    // highlight loop (which read lineEls) are completely unaffected.
    function gtxTranslate(text, lang) {
      return new Promise((res) => {
        try {
          const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(lang) + '&dt=t&q=' + encodeURIComponent(text);
          GM_xmlhttpRequest({
            method: 'GET', url, timeout: 12000, anonymous: true,   // don't send the user's Google cookies
            onload: (r) => { try { const j = JSON.parse(r.responseText); const segs = (j && j[0]) || []; let out = ''; for (const s of segs) { if (s && s[0] != null) out += s[0]; } res(out); } catch (e) { res(null); } },
            onerror: () => res(null), ontimeout: () => res(null),
          });
        } catch (e) { res(null); }
      });
    }
    function clearTranslation() { try { if (body) body.querySelectorAll('.tline').forEach((e) => e.remove()); } catch (e) {} }
    async function decorateTranslation() {
      try {
        if (!transOn || !body) return;
        const myToken = ++transToken;
        const els = Array.from(body.querySelectorAll('.line'));   // plain-text sheets never fill lineEls
        if (!els.length) return;
        const texts = els.map((el) => (el.textContent || '').trim());
        // chunk lines so each request stays well under the endpoint's length cap;
        // newlines are preserved through translation so we can split back per line
        const chunks = []; let cur = [], len = 0;
        for (const t of texts) { if (len + t.length > 3500 && cur.length) { chunks.push(cur); cur = []; len = 0; } cur.push(t); len += t.length + 1; }
        if (cur.length) chunks.push(cur);
        const out = [];
        for (const ch of chunks) {
          const key = transLang + '\u0000' + ch.join('\n');
          let tr;
          if (transCache.has(key)) tr = transCache.get(key);
          else {
            const raw = await gtxTranslate(ch.join('\n'), transLang);
            if (myToken !== transToken) return;   // track changed / toggled off mid-flight — abandon
            if (raw != null) { tr = raw.split('\n'); transCache.set(key, tr); if (transCache.size > 200) { try { transCache.delete(transCache.keys().next().value); } catch (e) {} } }
            else tr = null;   // don't cache failures — retry next time
          }
          // only trust a chunk whose line count survived translation 1:1
          if (tr && tr.length === ch.length) { for (let i = 0; i < tr.length; i++) out.push(tr[i]); }
          else { for (let i = 0; i < ch.length; i++) out.push(null); }
        }
        if (myToken !== transToken || !transOn) return;
        if (!out.some(Boolean)) toast('Translation unavailable right now');   // every chunk failed: say so instead of silently showing nothing
        for (let i = 0; i < els.length; i++) {
          const el = els[i], t = out[i];
          const nx = el.nextSibling;
          if (!t || t === texts[i]) { if (nx && nx.classList && nx.classList.contains('tline')) nx.remove(); continue; }
          if (nx && nx.classList && nx.classList.contains('tline')) nx.textContent = t;
          else { const tl = document.createElement('div'); tl.className = 'tline'; tl.textContent = t; if (el.parentNode) el.parentNode.insertBefore(tl, el.nextSibling); }
        }
      } catch (e) {}
    }
    function toggleTranslate() {
      transOn = !transOn;
      try { GM_setValue('sl:trans', transOn); } catch (e) {}
      if (transOn) { toast('Translating lyrics → ' + transLang.toUpperCase()); decorateTranslation(); }
      else { ++transToken; clearTranslation(); toast('Translation off'); }
    }

    function bisect(t) {
      let lo = 0, hi = times.length - 1, ans = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (times[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1;
      }
      return ans;
    }

    function loop() {
      if (!open) { rafOn = false; return; }   // park: setOpen(true) restarts us
      requestAnimationFrame(loop);

      const now = Media.time();
      const playing = Media.playing();
      // IDLE PARK: when paused and the clock isn't advancing, nothing on screen
      // changes — skip ALL per-frame work (bisect / karaoke fill / scroll / writes).
      // Anything that resets activeI also sets lastFrameNow = -1 so the reset paints once.
      // Keep the rAF alive so playback resumes instantly. Guards: only when the
      // play→pause transition has already settled (playing === lastPlaying) and the
      // "back to live" chip isn't mid-display (so it can still hide on its own).
      if (!playing && playing === lastPlaying && now === lastFrameNow && !chipShown
        && performance.now() >= pauseScrollUntil) return;
      lastFrameNow = now;

      const meta = App.meta();
      if (meta && meta.dur) {
        const pct = Math.round(Math.min(now / meta.dur, 1) * 400) / 4;
        if (pct !== lastProg) { lastProg = pct; progEl.style.width = pct + '%'; }
      } else if (lastProg !== 0) { lastProg = 0; progEl.style.width = '0%'; }

      // elapsed / total readout (1 write per second)
      const sCur = Math.floor(now);
      if (sCur !== lastTm) {
        lastTm = sCur;
        const d = meta && meta.dur > 0 ? meta.dur : 0;
        tmEl.textContent = d
          ? (tmRemain ? '−' + fmtClock(Math.max(0, d - now)) + ' / ' + fmtClock(d) : fmtClock(now) + ' / ' + fmtClock(d))
          : (now > 0 ? fmtClock(now) : '');
      }

      if (playing !== lastPlaying) { lastPlaying = playing; panel.classList.toggle('playing', playing); }

      // back-to-live chip while manual scrolling holds the auto-follow
      const paused = isSynced && tab === 'lyrics' && !searchMode && performance.now() < pauseScrollUntil;
      if (paused !== chipShown) { chipShown = paused; chipEl.classList.toggle('on', paused); }

      if (!isSynced || !times.length || searchMode || tab !== 'lyrics' || tapOn) return;
      // configurable perceptual lead + per-track nudge + device-latency comp
      const t = Media.time() + (App.leadMs() || 0) / 1000 + ((App.offsetMs() || 0) + (App.latencyMs() || 0) + (SyncAuto.ms || 0)) / 1000;
      const i = bisect(t);
      // TRUE karaoke wipe: every frame, fill the current line from its exact
      // playback position within the line — this is what makes sync read as
      // perfectly tracked rather than lines snapping on/off
      if (activeI >= 0 && activeI < times.length && lineEls[activeI]) {
        const s = times[activeI];
        const e = (times[activeI + 1] != null ? times[activeI + 1] : s + 4);
        const span = Math.max(0.2, e - s);
        let pct;
        const wd = lineWords[activeI];
        if (wd && wd.w && wd.w.length) {
          // WORD-ACCURATE wipe: advance the fill word-by-word from real
          // Musixmatch word timings, so the gradient holds on sustained words
          // and races across quick ones — tracking the actual vocal, not a
          // straight-line guess across the whole line
          const W = wd.w;
          // map the (possibly warped) highlight time back into THIS line's original
          // word-time base, so the per-word wipe stays accurate after drift warping
          // (exact identity when uncalibrated: anchorCount 0 → tw = t)
          const oS = W[0][0];
          const oE = (wd.e != null && wd.e > oS) ? wd.e : (W[W.length - 1][0] + 0.4);
          const tw = (App.anchorCount() > 0 && e > s) ? oS + (t - s) / (e - s) * (oE - oS) : t;
          let started = 0;
          while (started < W.length && tw >= W[started][0]) started++;
          let filled = 0, total = 0;
          for (let k = 0; k < W.length; k++) total += W[k][1];
          for (let k = 0; k < started - 1; k++) filled += W[k][1];
          if (started >= 1) {
            const cur = W[started - 1];
            const nextT = (started < W.length) ? W[started][0] : oE;
            const fr = Math.max(0, Math.min(1, (tw - cur[0]) / Math.max(0.01, nextT - cur[0])));
            filled += cur[1] * fr;
          }
          pct = total > 0 ? Math.max(0, Math.min(100, (filled / total) * 100)) : 0;
        } else {
          // line-level fallback (no richsync words): linear across the line
          pct = Math.max(0, Math.min(100, ((t - s) / span) * 100));
        }
        const fillStr = pct.toFixed(1) + '%';   // skip the style write (recalc) when it rounds to the same value
        if (fillStr !== lastFill) { lineEls[activeI].style.setProperty('--fill', fillStr); lastFill = fillStr; }
      }
      if (i === activeI) return;
      if (activeI >= 0 && lineEls[activeI]) { lineEls[activeI].classList.remove('act'); lineEls[activeI].removeAttribute('aria-current'); }
      else if (activeI < 0) lineEls.forEach((el) => { if (el && el.classList && el.classList.contains('act')) { el.classList.remove('act'); el.removeAttribute('aria-current'); } });   // a reset (tap-along, anchor) forgot the lit line
      if (i > activeI + 1 || i < activeI) {
        lineEls.forEach((el, k) => el.classList.toggle('past', k < i));
      } else {
        for (let k = Math.max(0, activeI); k < i; k++) if (lineEls[k]) lineEls[k].classList.add('past');
      }
      activeI = i;
      const el = lineEls[i];
      if (el) {
        el.style.setProperty('--fill', '0%'); lastFill = '0%';
        el.classList.add('act');
        el.classList.remove('past');
        el.setAttribute('aria-current', 'true');
        announceLine(el.textContent || '');
        if (performance.now() > pauseScrollUntil) {
          const top = el.offsetTop - body.clientHeight * 0.38;
          body.scrollTo({ top, behavior: 'smooth' });
        }
      }
    }
    /* R32: rate-limited SR announce — synced lyrics can flip every few seconds.
     * v4.50 used a trailing-edge debounce that DROPPED every line except the
     * final one of a fast sequence (the opposite of "one line per perceptible
     * pause"). v5 uses leading-edge throttle: announce the FIRST line
     * immediately, then suppress further announcements for THROTTLE_MS, and
     * write the most-recent text once at the end of the window. setOpen(false)
     * clears state so a pending announce can't fire into a closed panel. */
    let _annT = 0, _annTxt = '', _annLastAt = 0;
    const ANN_THROTTLE_MS = 1200;
    function _annWrite(t) { try { const r = panel && panel.querySelector('#srl'); if (r) r.textContent = t; } catch (e) {} }
    function announceLine(text) {
      if (!open) return;
      const t = (text || '').trim().slice(0, 240);
      if (!t) return;
      _annTxt = t;
      const now = performance.now();
      const since = now - _annLastAt;
      if (since >= ANN_THROTTLE_MS) {
        _annLastAt = now;
        _annWrite(t);
        if (_annT) { clearTimeout(_annT); _annT = 0; }
        return;
      }
      // inside window — schedule a tail write to catch up if the line stops
      // changing before the next leading edge fires
      if (_annT) clearTimeout(_annT);
      _annT = setTimeout(() => {
        _annT = 0;
        if (!open) return;
        _annLastAt = performance.now();
        _annWrite(_annTxt);
      }, ANN_THROTTLE_MS - since);
    }
    function clearAnnouncer() {
      if (_annT) { clearTimeout(_annT); _annT = 0; }
      _annTxt = ''; _annLastAt = 0;
      _annWrite('');
    }

    /* ---------- manual search (progressive, all sources) ---------- */
    let srchWrap = null;
    let searchSeq = 0;
    function enterSearch() {
      if (searchMode) return;
      if (tapOn) endTapAlign(false);   // the tap-along click capture would swallow every result click
      closeFind();
      searchMode = true;
      const meta = App.meta();
      const c = meta ? cleanTitle(meta.title) : { title: '', artist: '' };
      const pre = ((c.artist ? c.artist + ' ' : '') + c.title).trim();

      srchWrap = document.createElement('div');
      srchWrap.className = 'srch';
      srchWrap.innerHTML = `<input class="inp" id="inp" type="text" placeholder="artist title…" spellcheck="false"><button class="go" id="go" title="Search">${ICONS.search}</button>`;
      panel.insertBefore(srchWrap, body);

      const inp = srchWrap.querySelector('#inp');
      inp.value = pre;
      const go = () => runSearch(inp.value.trim());
      srchWrap.querySelector('#go').addEventListener('click', go);
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go();
        if (e.key === 'Escape') exitSearch();
      });

      const bs = panel.querySelector('#bSearch');
      bs.innerHTML = ICONS.back;
      bs.title = 'Back to lyrics'; bs.setAttribute('aria-label', 'Back to lyrics');

      body.replaceChildren(stateEl(ICONS.search, '', 'Searches Genius, Musixmatch, LRCLIB, Kugou, NetEase and the web. Pick the right match.'));
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
    }

    function exitSearch(silent) {
      if (!searchMode) return;
      searchMode = false;
      searchSeq++;
      if (srchWrap) { srchWrap.remove(); srchWrap = null; }
      const bs = panel.querySelector('#bSearch');
      bs.innerHTML = ICONS.search;
      bs.title = 'Search lyrics manually (S)'; bs.setAttribute('aria-label', 'Search lyrics manually');
      if (!silent) App.rerender();
    }

    function paintResults(items) {
      const frag = document.createDocumentFragment();
      let di = 0;
      for (const it of items) {
        const b = document.createElement('button');
        b.className = 'res';
        b.style.animationDelay = Math.min(di * 18, 180) + 'ms'; di++;
        const badge = it.src === 'genius' ? '<span class="badge">GENIUS</span>'
          : it.src === 'kugou' ? '<span class="badge sync">KUGOU</span>'
          : it.src === 'netease' ? '<span class="badge sync">NETEASE</span>'
            : it.synced ? '<span class="badge sync">SYNC</span>' : '<span class="badge">TXT</span>';
        // duration agreement with the playing track = the strongest "right
        // version" signal a human can read at a glance — color it
        let dur = '';
        if (it.dur) {
          const ds = Math.round(it.dur);   // round first: 239.6 s is 4:00, not 3:60
          const dtxt = `${Math.floor(ds / 60)}:${String(ds % 60).padStart(2, '0')}`;
          const diff = lastSearchDur > 0 ? Math.abs(it.dur - lastSearchDur) : -1;
          const cls = diff < 0 ? '' : diff <= 3 ? ' class="dgood"' : diff <= 10 ? ' class="dok"' : ' class="dbad"';
          dur = ` · <span${cls}>${dtxt}</span>`;
        }
        b.innerHTML = `<span class="rimg">${ICONS.note}</span><div class="rwrap"><div class="rt">${esc(it.t)}</div><div class="ra">${esc(it.a)}${dur}</div></div>${badge}`;
        if (it.img) {
          const im = new Image();
          im.alt = '';
          const holder = b.querySelector('.rimg');
          im.onload = () => { holder.textContent = ''; holder.appendChild(im); };
          im.src = it.img;
        }
        b.addEventListener('click', () => App.pick(it));
        frag.appendChild(b);
      }
      body.replaceChildren(frag);
    }

    async function runSearch(q) {
      if (!q) return;
      const seq = ++searchSeq;
      body.innerHTML = '<div class="sk" style="width:72%"></div><div class="sk" style="width:86%"></div><div class="sk" style="width:58%"></div>';
      const got = new Map();
      let gFail = false;

      const order = () => {
        const all = [...got.values()];
        // Genius first — best catalog and naming authority; synced sources follow
        return [
          ...all.filter((x) => x.src === 'genius' && !x.fromLyric),
          ...all.filter((x) => x.src === 'lrclib' && x.synced),
          ...all.filter((x) => x.src === 'mxm'),
          ...all.filter((x) => x.src === 'netease'),
          ...all.filter((x) => x.src === 'kugou'),
          ...all.filter((x) => x.src === 'genius' && x.fromLyric),
          ...all.filter((x) => x.src === 'lrclib' && !x.synced && (x.plain || x.instrumental)),
        ].slice(0, 14);
      };
      const handle = (res) => {
        if (!searchMode || seq !== searchSeq || !res) return;
        (res.songs || []).forEach((it) => { if (!got.has(it.id)) got.set(it.id, it); });
        (res.lyricHits || []).forEach((it) => { if (!got.has(it.id)) { it.fromLyric = true; got.set(it.id, it); } });
        const items = order();
        if (items.length) paintResults(items);
      };

      const geniusChain = Gmode.get() === 'direct'
        ? geniusSong(q).then(handle).catch(() =>
            geniusMulti(q).then(handle).catch(() => { gFail = true; }))
        : geniusSong(q).then(handle).catch(() => { gFail = true; });

      // give Kugou the playing track's duration (better ranking) and add
      // Musixmatch — the second-largest synced catalog was missing from
      // manual search entirely
      const curDur = (App.meta() && App.meta().dur) || 0;
      lastSearchDur = curDur;   // paintResults colors each result's duration by closeness
      let mArtist = '', mTrack = q;
      const mdash = q.match(/^(.{1,60}?)\s+[-–—]\s+(.{1,90})$/);
      if (mdash) { mArtist = mdash[1].trim(); mTrack = mdash[2].trim(); }
      await Promise.allSettled([
        lrcSearch({ q }).then(handle).catch(() => {}),
        // duration helps ranking, but the user may be searching a DIFFERENT
        // song — retry open when the duration-filtered search comes up empty
        kugouSearch(q, curDur)
          .then((r) => (curDur > 0 && !(r && r.songs && r.songs.length) ? kugouSearch(q, 0) : r))
          .then(handle).catch(() => {}),
        neteaseSearch(q, curDur).then(handle).catch(() => {}),
        MXM.find({ artist: mArtist, track: mTrack, dur: 0 }).then(handle).catch(() => {}),
        webSearch(q).then((r) => { if (r && r.songs && r.songs.length) gFail = false; handle(r); }).catch(() => {}),
        geniusApiSearch(q).then((r) => { if (r && r.songs && r.songs.length) gFail = false; handle(r); }).catch(() => {}),
        geniusChain,
      ]);
      if (!searchMode || seq !== searchSeq) return;
      if (gFail && [...got.values()].some((x) => x.src === 'genius')) gFail = false;
      if (!got.size) {
        body.replaceChildren(stateEl(ICONS.sad, 'Nothing found',
          gFail ? 'Genius unreachable on every route — try again in a bit.' : 'Try fewer words.'));
        return;
      }
      if (gFail) toast('Genius unreachable — other sources only');
    }

    /* ---------- diagnostics view ---------- */
    let diagGen = 0;
    async function showDiag() {
      const gen = ++diagGen;
      exitSearch(true);
      clearLyrics();
      body.innerHTML = '<div class="dghead">Checking every route…</div>';
      setSrcLine('Diagnostics');
      const list = document.createElement('div');
      body.appendChild(list);
      const paint = (results) => {
        list.replaceChildren(...results.map((r) => {
          const d = document.createElement('div');
          d.className = 'dg ' + (r.ok ? 'ok' : 'bad');
          d.innerHTML = `<span class="st">${r.ok ? '✓' : '✗'}</span><b>${esc(r.name)}</b>`
            + (r.ok ? '' : `<span class="why">${esc(r.msg || '')}</span>`)
            + `<span class="ms">${r.ms}ms</span>`;
          return d;
        }));
      };
      let results;
      try { results = await App.diagnose(paint); }
      catch (e) { results = []; }
      if (gen !== diagGen || !list.isConnected) return;   // a track change re-rendered lyrics meanwhile
      paint(results);
      const okCount = results.filter((r) => r.ok).length;
      const row = document.createElement('div');
      row.className = 'state';
      row.style.padding = '12px 22px 8px';
      const btn = document.createElement('button');
      btn.className = 'btn acc';
      btn.textContent = 'Copy report';
      btn.addEventListener('click', () => {
        const raw = App.diagReport(results);
        const report = (typeof Log !== 'undefined' && Log && Log.redact) ? Log.redact(raw) : raw;
        let copied = false;
        try { GM_setClipboard(report); copied = true; } catch (e) {}
        if (!copied) { try { navigator.clipboard.writeText(report); copied = true; } catch (e2) {} }
        toast(copied ? 'Copied — paste it in the chat' : 'Copy failed');
      });
      row.appendChild(btn);
      const back = document.createElement('button');
      back.className = 'btn';
      back.textContent = 'Back to lyrics';
      back.addEventListener('click', () => { ++diagGen; if (curLyr) { curLyr.instr ? showInstrumental() : renderLyrics(curLyr); } else showIdle(); });   // the last sheet, or the idle card
      row.appendChild(back);
      body.appendChild(row);
      setSrcLine(`Diagnostics · ${okCount}/${results.length} routes OK`);
    }

    /* ---------- toast ---------- */
    let toastT = 0;
    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('on');
      clearTimeout(toastT);
      toastT = setTimeout(() => toastEl.classList.remove('on'), Math.min(5000, 2000 + msg.length * 25));   // longer notes stay a little longer
    }

    /* ---------- keep the panel fully on-screen ---------- */
    function clampPanel() {
      if (!panel || maxOn) return;
      try {
        const RESERVE = 74;   // never cross SoundCloud's player bar
        if (panel.style.top && panel.style.top !== 'auto') {
          const h = panel.getBoundingClientRect().height || 480;
          let top = parseInt(panel.style.top, 10); if (!isFinite(top)) top = 6;
          const maxTop = innerHeight - h - RESERVE;
          top = Math.max(6, Math.min(top, Math.max(6, maxTop)));
          panel.style.top = top + 'px';
        }
        if (panel.style.left && panel.style.left !== 'auto') {
          const w = panel.getBoundingClientRect().width || 324;
          let left = parseInt(panel.style.left, 10); if (!isFinite(left)) left = 6;
          left = Math.max(6, Math.min(left, Math.max(6, innerWidth - w - 6)));
          panel.style.left = left + 'px';
        }
      } catch (e) {}
    }

    /* ---------- open/close + toggle buttons ---------- */
    function setOpen(v) {
      open = v;
      panel.classList.toggle('open', v);
      fab.classList.toggle('on', v);
      fab.classList.toggle('has', ready && !v);
      if (barBtn) { barBtn.style.color = v ? '#ff5500' : 'inherit'; barBtn.style.opacity = v ? '1' : '.55'; }
      if (barDot) barDot.style.display = (ready && !v) ? 'block' : 'none';
      if (v && !rafOn) { rafOn = true; requestAnimationFrame(loop); }
      if (v) {
        applyPanelTheme();
        pauseScrollUntil = 0;
        activeI = -1; lastFrameNow = -1;   // jump straight to the sung line on every open — even while paused
        try { if (!maxOn && GM_getValue('sl:max', 0)) toggleMax(true); } catch (e) {}
        requestAnimationFrame(clampPanel);   // never reveal an off-screen panel
        App.onOpen();
        syncTabs();
        if (tab === 'tweaks') renderTweaks();   // restored from storage without setTab: build it on open
        try { if (tab === 'audio') { if (SUITE.audioTabActive) SUITE.audioTabActive(true); renderAudio(); } } catch (e) {}
      } else {
        try { if (SUITE.audioTabActive) SUITE.audioTabActive(false); } catch (e) {}   // stop the EQ spectrum + bypass routing
        exitSearch(true);
        setMenu(false);
        showKeys(false);
        closeFind();
        hideWizard();
        try { clearAnnouncer(); } catch (e) {}   // drop the SR live-region + cancel any pending announce
        const ps = panel.querySelector('.keys.on');
        if (ps && ps !== keysEl && ps !== wnEl) ps.remove();
        if (maxOn) toggleMax(false, true);   // silent: closing must not forget the preference
      }
    }

    function setReady(v) {
      ready = !!v;
      fab.classList.toggle('has', ready && !open);
      if (barDot) barDot.style.display = (ready && !open) ? 'block' : 'none';
    }

    function makeBarBtn() {
      const b = document.createElement('button');
      b.id = 'slx3-btn';
      b.type = 'button';
      b.title = 'Lyrics (Alt+L)';
      b.setAttribute('aria-label', 'Lyrics');
      b.style.cssText = 'position:relative;width:26px;height:26px;margin:0 1px;padding:0;border:0;background:none;border-radius:7px;cursor:pointer;color:inherit;opacity:.55;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;transition:opacity .15s ease,background .15s ease,color .15s ease,transform .15s ease;flex:none;';
      b.innerHTML = ICONS.lyrics;
      const svg = b.querySelector('svg');
      if (svg) { svg.style.width = '16px'; svg.style.height = '16px'; svg.style.display = 'block'; }
      barDot = document.createElement('span');
      barDot.style.cssText = 'position:absolute;top:3px;right:3px;width:5px;height:5px;border-radius:50%;background:#ff5500;box-shadow:0 0 4px rgba(255,85,0,.7);display:none;pointer-events:none;';
      b.appendChild(barDot);
      if (ready && !open) barDot.style.display = 'block';
      b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,85,0,0.12)'; b.style.color = '#ff5500'; b.style.opacity = '1'; b.style.transform = 'scale(1.08)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'none'; b.style.transform = ''; if (open) { b.style.color = '#ff5500'; b.style.opacity = '1'; } else { b.style.color = 'inherit'; b.style.opacity = '.55'; } });
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); });
      return b;
    }

    function ensureButton() {
      // the all-in-one enhancer pill carries its own Suite/lyrics button — when
      // it's present, don't add a second standalone one (or a FAB); remove a stale one
      if (document.querySelector('.sce-barwrap')) {
        if (barBtn) { try { barBtn.remove(); } catch (e) {} barBtn = null; }
        if (fab) fab.classList.remove('show');
        return;
      }
      if (barBtn && document.contains(barBtn)) return;
      const slot = document.querySelector('.playbackSoundBadge__actions')
        || document.querySelector('.playControls__elements');
      if (slot) {
        barBtn = makeBarBtn();
        if (open) barBtn.style.color = '#ff5500';
        slot.appendChild(barBtn);
        fab.classList.remove('show');
      } else {
        fab.classList.add('show');
      }
    }

    /* ───────── command palette (⌘K) — one fuzzy launcher for the whole suite ───────── */
    let cmdkEl = null, cmdkIn = null, cmdkListEl = null, cmdkView = [], cmdkSel = 0;
    function paletteOpen() { return !!(cmdkEl && cmdkEl.classList.contains('on')); }
    function paletteCommands() {
      const C = [];
      const add = (icon, label, hint, run) => C.push({ icon, label, hint, run });
      // in-app navigation (a real anchor click goes through SoundCloud's router, so playback and the suite survive)
      const go = (p) => { try { const a = document.createElement('a'); a.href = p; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); } catch (e) { try { location.assign('https://soundcloud.com' + p); } catch (e2) {} } };
      // hub / view
      add('◐', 'Open lyrics hub', 'View', () => { setOpen(true); setTab('lyrics'); });
      add('♫', 'Lyrics tab', 'View', () => { setOpen(true); setTab('lyrics'); });
      add('≣', 'Queue tab', 'View', () => { setOpen(true); setTab('queue'); });
      add('▤', 'Stats tab', 'View', () => { setOpen(true); setTab('stats'); });
      add('🎛', 'Audio tab', 'View', () => { setOpen(true); setTab('audio'); });
      add('⚙', 'Tweaks tab', 'View', () => { setOpen(true); setTab('tweaks'); });
      add('⛶', 'Immersive mode', 'View', () => { setOpen(true); toggleMax(true); });
      add('◑', 'Toggle focus mode', 'View', () => { setOpen(true); toggleFocus(); });
      add('▭', 'Toggle mini lyric bar', 'View', () => toggleMini());
      add('✕', 'Close hub', 'View', () => setOpen(false));
      // lyrics
      add('⟳', 'Re-search this track', 'Lyrics', () => { setOpen(true); setTab('lyrics'); App.retry(); });
      add('▣', 'Share a lyric card', 'Lyrics', () => { setOpen(true); shareSheet(); });
      // chapters / cue points
      if (Chapters.list.length) {
        add('☰', 'Chapters (' + Chapters.list.length + ')', 'Chapters', () => { setOpen(true); setTab('queue'); });
        add('⏭', 'Next chapter', 'Chapters', () => jumpChapter(1));
        add('⏮', 'Previous chapter', 'Chapters', () => jumpChapter(-1));
        add('⎘', 'Copy tracklist', 'Chapters', () => { try { GM_setClipboard(Chapters.tracklistText()); toast('Tracklist copied'); } catch (e) { toast('Copy failed'); } });
      }
      add('◆', 'Add cue point here', 'Chapters', () => addCueNow());
      add('⌕', 'Pick a different match', 'Lyrics', () => { setOpen(true); setTab('lyrics'); enterSearch(); });
      add('/', 'Find in lyrics', 'Lyrics', () => { setOpen(true); setTab('lyrics'); openFind(); });
      add('⤓', 'Jump to chorus', 'Lyrics', () => { setOpen(true); if (searchMode) exitSearch(); jumpChorus(); });
      add('◎', 'Calibrate sync (tap along)', 'Lyrics', () => { setOpen(true); if (searchMode) exitSearch(); startTapAlign(); });
      add('⧉', 'Copy lyrics', 'Lyrics', () => { try { App.copyLyrics(); } catch (e) {} });
      add('⭳', 'Export .lrc file', 'Lyrics', () => { try { App.exportLrc(); } catch (e) {} });
      add('📄', 'Load .lrc / .txt file', 'Lyrics', () => { try { App.importLrc(); } catch (e) {} });
      // shuffle
      add('🔀', 'Shuffle my Likes', 'Shuffle', () => { const m = SUITE.shuffleNow ? SUITE.shuffleNow() : 'Shuffle module not loaded'; if (m) { if (!open) setOpen(true); toast(m); } });
      add('✧', 'More like this track', 'Shuffle', () => { const m = SUITE.moreLikeThis ? SUITE.moreLikeThis() : 'Shuffle module not loaded'; if (m) { if (!open) setOpen(true); toast(m); } });
      // themes (SoundCloud page theme — handled by the enhancer over the bus)
      if (SUITE.setTheme) {
        const themes = [['none', 'Light'], ['dark', 'Dark'], ['amoled', 'AMOLED black'], ['midnight', 'Midnight'], ['dracula', 'Dracula'], ['nord', 'Nord'], ['ocean', 'Ocean'], ['gruvbox', 'Gruvbox'], ['rosepine', 'Rosé Pine'], ['solar', 'Solarized'], ['coffee', 'Coffee'], ['slate', 'Slate'], ['custom', 'Custom']];
        for (const [id, nm] of themes) add('◧', 'Theme: ' + nm, 'Theme', () => { if (SUITE.setTheme) SUITE.setTheme(id); });
      }
      // backup
      add('⭳', 'Back up everything', 'Backup', () => { if (SUITE.backupAll) SUITE.backupAll(); });
      // navigate SoundCloud
      const nav = [['Home feed', '/feed'], ['Discover', '/discover'], ['Likes', '/you/likes'], ['Playlists', '/you/sets'], ['Albums', '/you/albums'], ['Following', '/you/following'], ['History', '/you/history'], ['Upload', '/upload'], ['Notifications', '/notifications'], ['Messages', '/messages'], ['Settings', '/settings']];
      for (const [nm, p] of nav) add('→', 'Go to ' + nm, 'Go', () => go(p));
      // help
      add('⌨', 'Keyboard shortcuts', 'Help', () => { setOpen(true); showKeys(true); });
      add('★', "What’s new", 'Help', () => { setOpen(true); showWhatsNew(); });
      add('⚑', 'Diagnostics', 'Help', () => { setOpen(true); setTab('lyrics'); showDiag(); });
      return C;
    }
    function cmdkFuzzy(q, s) {
      s = (s || '').toLowerCase();
      if (!q) return 0;
      const idx = s.indexOf(q);
      if (idx !== -1) return 100 - idx;                 // substring match ranks high
      let qi = 0, score = 0;
      for (let i = 0; i < s.length && qi < q.length; i++) { if (s[i] === q[qi]) { qi++; score++; } }
      return qi === q.length ? score : -1;              // subsequence match, else miss
    }
    function cmdkSetSel(i) {
      const items = cmdkListEl ? cmdkListEl.querySelectorAll('.cmdkit') : [];
      if (!items.length) return;
      cmdkSel = Math.max(0, Math.min(items.length - 1, i));
      items.forEach((el, k) => el.classList.toggle('sel', k === cmdkSel));
    }
    function cmdkMove(d) {
      const items = cmdkListEl ? cmdkListEl.querySelectorAll('.cmdkit') : [];
      if (!items.length) return;
      cmdkSetSel((cmdkSel + d + items.length) % items.length);
      const el = items[cmdkSel]; if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function cmdkRun() {
      const c = cmdkView[cmdkSel];
      closePalette();
      if (c) { try { c.run(); } catch (e) {} }
    }
    function renderPalette(all) {
      const q = (cmdkIn.value || '').trim().toLowerCase();
      let list = all;
      if (q) {
        list = all.map((c) => ({ c, s: Math.max(cmdkFuzzy(q, c.label), cmdkFuzzy(q, c.hint) - 5) }))
          .filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.c);
      }
      cmdkView = list; cmdkSel = 0;
      cmdkListEl.replaceChildren();
      if (!list.length) {
        const e = document.createElement('div'); e.className = 'cmdkempty'; e.textContent = 'No matching commands';
        cmdkListEl.appendChild(e); return;
      }
      list.forEach((c, i) => {
        const it = document.createElement('div');
        it.className = 'cmdkit' + (i === 0 ? ' sel' : '');
        const ci = document.createElement('span'); ci.className = 'ci'; ci.textContent = c.icon || '›';
        const cl = document.createElement('span'); cl.className = 'cl'; cl.textContent = c.label;
        const ch = document.createElement('span'); ch.className = 'ch'; ch.textContent = c.hint || '';
        it.append(ci, cl, ch);
        it.addEventListener('mousemove', () => cmdkSetSel(i));
        it.addEventListener('click', () => { cmdkSetSel(i); cmdkRun(); });
        cmdkListEl.appendChild(it);
      });
    }
    function ensureCmdk() {
      if (cmdkEl && cmdkEl.isConnected) return;
      cmdkEl = document.createElement('div');
      cmdkEl.className = 'cmdk';
      cmdkEl.innerHTML = '<div class="cmdkbox"><input class="cmdkin" type="text" spellcheck="false" placeholder="Type a command…  (Esc to close)" aria-label="Command palette"><div class="cmdklist"></div></div>';
      cmdkIn = cmdkEl.querySelector('.cmdkin');
      cmdkListEl = cmdkEl.querySelector('.cmdklist');
      cmdkEl.addEventListener('mousedown', (e) => { if (e.target === cmdkEl) closePalette(); });   // click the dim backdrop
      let all = [];
      cmdkIn.addEventListener('input', () => renderPalette(all));
      cmdkIn.addEventListener('keydown', (e) => {
        e.stopPropagation();   // these keys belong to the palette, not the page / panel
        if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
        if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') { e.preventDefault(); closePalette(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); cmdkMove(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); cmdkMove(-1); return; }
        if (e.key === 'Enter') { e.preventDefault(); cmdkRun(); return; }
      });
      cmdkEl.__setAll = (a) => { all = a; };
      root.appendChild(cmdkEl);
    }
    let cmdkPrev = null;
    function openPalette() {
      try {
        ensureCmdk();
        cmdkPrev = (root.activeElement && root.activeElement !== cmdkEl ? root.activeElement : document.activeElement) || null;
        if (cmdkPrev && (cmdkPrev === document.body || (cmdkEl && cmdkEl.contains(cmdkPrev)))) cmdkPrev = null;
        const all = paletteCommands();
        cmdkEl.__setAll(all);
        cmdkIn.value = '';
        renderPalette(all);
        cmdkEl.classList.add('on');
        setTimeout(() => { try { cmdkIn.focus(); } catch (e) {} }, 0);
      } catch (e) {}
    }
    function closePalette() {
      if (cmdkEl) cmdkEl.classList.remove('on');
      const p = cmdkPrev; cmdkPrev = null;
      if (p && p.isConnected) { try { p.focus({ preventScroll: true }); } catch (e) {} }
    }

    return {
      mount, setOpen, isOpen: () => open, setNext,
      setHeader, setSrcLine, setReady, setBusy,
      showIdle, showLoading, showNone, showError, showInstrumental, showDiag, showWhatsNew,
      renderLyrics, srcFor, toast, ensureButton, bumpFont,
      shareOpen: () => !!shareBar, shareClose, shareSheet,
      setTab, syncTabs, toggleMax, showKeys, escStep, setMini,
      toggleFocus, jumpChorus, seekLine, replayLine, openFind, toggleMini, cycleTheme,
      cycleMood, cycleGlass, autoOpenWanted: () => autoOpenFound,
      startTapAlign, tapAdvance, tapActive: () => tapOn, endTapAlign,
      inSearch: () => searchMode, enterSearch, exitSearch,
      openPalette, closePalette, paletteOpen, curTab: () => tab,
    };
  })();

  /* ------------------------------------------------------------------ *
   *  9. APP — track watcher, instant prefetch, state
   * ------------------------------------------------------------------ */

  const App = (() => {
    let meta = null;
    let lyr = null;
    let off = 0;
    let anch = [];
    let token = 0;
    let prefetchT = null, warmT = null, warmT2 = null;   // Ticker handles: background-tab-proof
    const stopT = (h) => { if (h) { try { h.stop(); } catch (e) {} } };

    // global audio-latency compensation (Bluetooth ≈ 100–300 ms): shifts the
    // highlight for EVERY track, separate from the per-track [ / ] nudge,
    // and never baked into .lrc exports (it's a playback-device property)
    let goff = 0;
    try { goff = Math.min(5000, Math.max(-5000, (GM_getValue('sl:goff', 0) | 0))); } catch (e) {}
    function setLatency(ms) {
      goff = Math.min(5000, Math.max(-5000, ms | 0));
      try { GM_setValue('sl:goff', goff); } catch (e) {}
      UI.toast(goff ? 'Global lyric offset: ' + (goff > 0 ? '+' : '') + (goff / 1000).toFixed(2) + 's' : 'Global lyric offset cleared');
    }

    // highlight lead: how early a line lights up before it's actually sung.
    // 120ms reads as "on time" to most people; 'early' suits singing along;
    // 'exact' is for purists checking sync against the waveform.
    let lead = 0;   // default: highlight EXACTLY on the heard vocal (was +120 ms early)
    try { lead = Math.min(400, Math.max(0, GM_getValue('sl:lead', 0) | 0)); } catch (e) {}
    function cycleLead() {
      lead = lead === 120 ? 250 : lead === 250 ? 0 : 120;
      try { GM_setValue('sl:lead', lead); } catch (e) {}
      UI.toast('Highlight timing: ' + (lead === 0 ? 'exact' : lead === 250 ? 'early (sing-along)' : 'standard'));
    }

    // smart sync memory: every manual nudge / tap-to-sync teaches the engine
    // the typical correction for that SOURCE — fresh tracks start pre-corrected
    function learnOffset() {
      try {
        if (!lyr || !lyr.src || !lyr.synced || lyr.scaled) return;
        const m2 = GM_getValue('sl:soff', {}) || {};
        const prev = m2[lyr.src];
        m2[lyr.src] = prev == null ? (off | 0) : Math.round(prev * 0.7 + off * 0.3);
        GM_setValue('sl:soff', m2);
      } catch (e) {}
    }
    function autoOff(srcName) {
      try {
        const m2 = GM_getValue('sl:soff', null);
        const v = m2 && m2[srcName];
        if (!v || Math.abs(v) < 80) return 0;   // small averages are noise, not a pattern
        return Math.max(-3000, Math.min(3000, Math.round(v / 10) * 10));
      } catch (e) { return 0; }
    }

    // debounced: holding ] used to rewrite the full multi-KB cache entry per
    // keystroke; values are captured NOW so a track change can't corrupt them
    let syncSaveT = null;
    const persistSync = () => {
      if (!meta) return;
      const key = meta.key, offNow = off, aoffNow = SyncAuto.ms, anchNow = anch.slice();
      stopT(syncSaveT);
      syncSaveT = Ticker.after(() => {
        const entry = Cache.get(key);
        if (entry) { entry.off = offNow; entry.aoff = aoffNow; entry.anch = anchNow; Cache.set(key, entry); }
      }, 600);
    };

    /* audio auto-align (v5.1): LYRIC_ALIGN listens to the first 90 s of every track through taps of its own on
     * the captured source and estimates the constant lag between the synced sheet and the vocals it actually
     * hears (community sheets are sometimes a few hundred ms off, timed to another master or intro). Looks at
     * 45, 60 and 75 s. The estimate is never applied on its own: on six real tracks it was precise (shift-
     * invariant within 0.02 s, never confident on a scrambled or wrong-song sheet) but its confidence on true
     * sheets stayed low and the lags it found clustered at +0.1..0.18 s — the vocal's energy rises after the
     * timestamp people tap, not a sheet error. So a clear finding of ≥ 200 ms is offered in the ⋯ menu as
     * "Align to vocals"; applying it sets a third offset term, SyncAuto.ms (clock-side: −lagSec), persisted with
     * the cache entry, shown as "auto" in the source line. '0' clears it like the other offsets; a manual nudge
     * sits on top of it. */
    let aligner = null, alignT = null, alignTries = 0;   // SyncAuto.ms (clock-side ms), .conf, .last (the latest estimate)
    const AUTO_ALIGN_AT_MS = [45000, 15000, 15000];   // first look at 45 s, then 60 s, 75 s
    function alignStop() { stopT(alignT); alignT = null; if (aligner) { try { aligner.dispose(); } catch (e) {} aligner = null; } }
    function alignStart() {
      alignStop(); alignTries = 0; SyncAuto.last = null;
      try {
        const tap = SUITE.audioTap && SUITE.audioTap(); if (!tap || !tap.ctx || !tap.src || typeof LYRIC_ALIGN === 'undefined') return;
        aligner = LYRIC_ALIGN.create(tap.ctx, tap.src, {
          mediaTime: () => { try { const c = SUITE.audioClock && SUITE.audioClock(); return c == null ? NaN : c; } catch (e) { return NaN; } },
          paused: () => !Media.playing(),
          playbackRate: () => { try { return (SUITE.audioRate && SUITE.audioRate()) || 1; } catch (e) { return 1; } },
          windowSec: 90,
        });
        alignT = Ticker.after(alignRun, AUTO_ALIGN_AT_MS[0]);
      } catch (e) { aligner = null; }
    }
    function alignRun() {
      alignT = null;
      try {
        if (!aligner || !lyr || !lyr.synced || lyr.instr) return;
        const starts = lyr.lines.map((l) => +l[0]).filter((t) => isFinite(t));
        const r = aligner.estimate(starts); SyncAuto.last = r;
        if (r && !r.reason && r.confidence > 0 && Math.abs(r.lagSec) >= SyncAuto.MIN_SEC) return;   // a clear finding: the menu offers it
        if (++alignTries < AUTO_ALIGN_AT_MS.length) alignT = Ticker.after(alignRun, AUTO_ALIGN_AT_MS[alignTries]);   // more audio, another look
      } catch (e) {}
    }
    // the ⋯ menu's "Align to vocals": apply the latest estimate as the auto offset (a nudge on top stays possible)
    SyncAuto.apply = () => {
      try {
        const r = SyncAuto.last; if (!r || !lyr || !lyr.synced) return;
        SyncAuto.ms = -Math.round(r.lagSec * 1000); SyncAuto.conf = r.confidence;
        persistSync();
        try { const sl = UI.srcFor(lyr); UI.setSrcLine(sl[0], sl[1]); } catch (e) {}
        UI.toast('Lyrics aligned to the vocals (' + (SyncAuto.ms > 0 ? '+' : '') + (SyncAuto.ms / 1000).toFixed(2) + ' s) · 0 undoes it');
      } catch (e) {}
    };

    // permalink-first cache key: archive accounts post many distinct tracks
    // titled "untitled"/"snippet" — title|uploader collided them, silently
    // sharing lyrics, offset AND anchors between different songs
    const trackKey = (m) => (m.href ? 'p:' + m.href : normKey(m.title) + '|' + normKey(m.uploader));

    // warm DNS+TLS to the main lyric hosts the moment music FIRST plays —
    // not on every page load (zero third-party contact until then)
    let hostsWarmed = false;
    function preconnect() {
      if (hostsWarmed) return;
      hostsWarmed = true;
      // gmFetchRaw, NOT gmFetch: warm-up pings must never occupy the 6-slot
      // NetGate the first track's own search is about to need
      ['https://lrclib.net/api/search?q=a',
       'https://genius.com/robots.txt',
       'https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=a&duration=&hash='].forEach((u) => gmFetchRaw(u, { timeout: 10000 }).catch(() => {}));
    }

    function readMeta() {
      const badge = document.querySelector('.playbackSoundBadge');
      if (!badge) return null;
      const tl = badge.querySelector('.playbackSoundBadge__titleLink');
      const title = (tl && (tl.getAttribute('title') || tl.textContent) || '').trim();
      if (!title) return null;
      let href = (tl && tl.getAttribute('href')) || '';
      href = href.split('?')[0];
      if (href && href[0] !== '/') href = '/' + href;
      const ul = badge.querySelector('.playbackSoundBadge__lightLink');
      const uploader = (ul && (ul.getAttribute('title') || ul.textContent) || '').trim();
      let dur = 0;
      const pw = document.querySelector('.playbackTimeline__progressWrapper');
      const vmax = pw && parseFloat(pw.getAttribute('aria-valuemax'));
      if (isFinite(vmax) && vmax > 0) dur = vmax;
      if (!dur) {
        const dWrap = document.querySelector('.playbackTimeline__duration');
        if (dWrap) {
          const span = dWrap.querySelector('span[aria-hidden="true"]') || dWrap;
          const txt = (span.textContent || '').trim();
          let v = parseClock(txt.replace(/^[\u2212-]\s*/, ''));
          if (/^[\u2212-]/.test(txt)) {
            // SC is set to show time REMAINING — total = elapsed + remaining
            const tp = document.querySelector('.playbackTimeline__timePassed');
            const ps = tp && (tp.querySelector('span[aria-hidden="true"]') || tp);
            const passed = ps ? parseClock((ps.textContent || '').trim()) : 0;
            v = v + Math.max(passed, 0);
          }
          if (v > 0) dur = v;
        }
      }
      let art = '';
      // the badge wraps the artwork in a div that also carries .sc-artwork; the
      // image URL lives on the inner span's inline style, so match on that
      const aEl = badge.querySelector('.sc-artwork[style*="background-image"]') || badge.querySelector('.sc-artwork');
      if (aEl) {
        const m = (aEl.style.backgroundImage || '').match(/url\(["']?(.+?)["']?\)/);
        if (m) art = m[1];
      }
      return { key: '', title, uploader, dur, art, href };
    }

    // v4 cache format: entries written by the pre-v3.2 engine are RETIRED —
    // they carry old-engine matches (wrong versions, weak guesses) and would
    // mask every accuracy fix on tracks the user already played. Hand-picked
    // and user-imported lyrics survive: the user chose those deliberately.
    const toCache = (l) => ({
      v: 4, src: l.src, synced: !!l.synced, scaled: !!l.scaled, instr: !!l.instr,
      lines: l.lines || [], a: l.a || '', t: l.t || '',
      sd: l.srcDur || 0,
      // word-level timing for the karaoke wipe — optional, only present on
      // Musixmatch richsync tracks; capped so a giant song can't bloat storage
      wt: (l.wt && typeof l.wt === 'object' && Object.keys(l.wt).length <= 400) ? l.wt : 0,
      low: !!l.low, picked: !!l.picked, off: off || 0, ts: Date.now(),
    });
    const fromCache = (c) => c && (c.v === 4 || (c.v === 3 && (c.picked || c.instr))) ? {
      src: c.src, synced: c.synced, scaled: !!c.scaled, instr: c.instr, lines: c.lines,
      a: c.a, t: c.t, srcDur: c.sd || 0, low: c.low, picked: c.picked,
      wt: (c.wt && typeof c.wt === 'object') ? c.wt : null,
    } : null;

    function apply(result, myToken) {
      if (myToken !== token) return;
      if (UI.inSearch && UI.inSearch()) { try { UI.setBusy(false); } catch (e) {} lyr = result; return; }   // the search view stays; Back paints it
      try { UI.setBusy(false); } catch (e) {}
      // a confirmed provisional: don't re-render identical content (flash),
      // just drop the "verifying…" tag from the source line
      const sameLines = (x, y) => {
        if (x === y) return true;
        if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
        for (let i = 0; i < x.length; i++) {
          const a = x[i], b = y[i];
          if (a === b) continue;
          if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
          for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
        }
        return true;
      };
      const same = result && lyr && (result === lyr ||
        (result.src === lyr.src && !!result.synced === !!lyr.synced && sameLines(result.lines, lyr.lines)));
      lyr = result;
      if (!aligner && result && result.synced) alignStart();   // the source arrived after the track change
      // confirmed synced lyrics are accurate as-is — drop any stale per-line anchors
      // (e.g. left by an older version) so they can't linger in storage / diagnostics
      if (result && result.synced && anch.length) { anch = []; try { persistSync(); } catch (e) {} }
      UI.setReady(!!result && !result.instr);
      // ALWAYS arm the pre-warm — the next track deserves a head start even
      // when this one is instrumental or lyricless (it used to be skipped)
      stopT(warmT);
      warmT = Ticker.after(warmNext, 6000);
      refreshNext();
      try { UI.syncTabs(); } catch (e) {}   // live Queue/Stats tabs follow track changes
      try { UI.setMini(result && result.synced && !result.instr ? result.lines : null); } catch (e) {}
      // auto-open: real lyrics just landed and the user opted in → reveal them
      try {
        if (result && !result.instr && !UI.isOpen() && UI.autoOpenWanted && UI.autoOpenWanted()) {
          UI.setOpen(true);
        }
      } catch (e) {}
      if (!UI.isOpen()) return;
      if (!result) { UI.showNone(); return; }
      if (result.instr) { UI.showInstrumental(); return; }
      if (same) { const sl = UI.srcFor(result); UI.setSrcLine(sl[0], sl[1]); return; }
      UI.renderLyrics(result);
    }

    function refreshNext() {
      try {
        if (!SUITE.nextUp || !meta || !meta.href) { UI.setNext(null); return; }
        const nx = SUITE.nextUp('https://soundcloud.com' + meta.href);
        if (!nx) { UI.setNext(null); return; }
        const lib = SUITE.libByUrl ? SUITE.libByUrl(nx.u) : null;
        const nm = {
          title: nx.t || (lib && lib.title) || '',
          uploader: nx.a || (lib && lib.artist) || '',
          href: nx.u ? nx.u.replace(/^https?:\/\/[^/]+/, '') : '',   // same key shape as warmNext
        };
        if (!nm.title) { UI.setNext(null); return; }
        UI.setNext({ t: nm.title, ready: Cache.has(trackKey(nm)) });
      } catch (e) { try { UI.setNext(null); } catch (e2) {} }
    }

    // pre-warm lyrics for the NEXT track in the shuffle queue, so skipping
    // ahead lands on an instant cache hit (idle, after the current find)
    async function warmNext() {
      try {
        stopT(warmT2);   // cancel any pending 2-ahead warm so they can't stack up over a long session
        if (!SUITE.nextUp || !meta || !meta.href) return;
        if (SUITE.shuffleBusy && SUITE.shuffleBusy()) {
          // a queue load can run for minutes — retry instead of giving up
          // (the old one-shot meant the pre-warm never fired during a run)
          stopT(warmT);
          warmT = Ticker.after(warmNext, 8000);
          return;
        }
        const warmTrack = (nx) => {
          if (!nx || !nx.u) return false;
          const path = nx.u.replace(/^https?:\/\/[^/]+/, '');
          const lib = SUITE.libByUrl ? SUITE.libByUrl(nx.u) : null;
          const m = {
            title: nx.t || (lib && lib.title) || '',
            uploader: nx.a || (lib && lib.artist) || '',
            href: path,
            dur: lib && lib.durMs > 0 ? Math.round(lib.durMs / 1000) : 0,
          };
          if (!m.title) return false;
          m.key = trackKey(m);
          if (m.key === meta.key || Cache.has(m.key) || Miss.has(m.key) || Inflight.has(m.key)) return false;
          Trail.add(`warming (lite): "${m.title}"`);
          // lite: wave 1 only — a track the user may skip past never gets the
          // full escalation, keeping the connection budget for the foreground
          const p = findLyrics(m, null, null, { lite: true }).then((r) => {
            Inflight.delete(m.key);
            // only cache CONFIDENT lite results — a low-score wave-1 match must
            // not suppress the full foreground search the user would get. And a
            // synced result found with NO known duration was never validated
            // against the actual upload — don't cache a possibly-wrong timeline.
            if (r && !r.low && !(r.synced && !(m.dur > 0))) { const e2 = toCache(r); e2.off = 0; Cache.set(m.key, e2); refreshNext(); }
            return r;
          }).catch(() => { Inflight.delete(m.key); return null; });
          p.lite = true;   // ensure() must not treat a lite null as a real miss
          Inflight.set(m.key, p);
          return true;
        };
        const nx = SUITE.nextUp('https://soundcloud.com' + meta.href);
        if (!nx || !nx.u) return;
        warmTrack(nx);
        // skip-skippers skip twice: warm the track AFTER next too, staggered
        // so it never competes with the first warm or the foreground
        const nx2 = SUITE.nextUp(nx.u);
        if (nx2 && nx2.u) {
          const curKey = meta.key;
          warmT2 = Ticker.after(() => {
            try {
              if (!meta || meta.key !== curKey) return;   // user moved on — the chain re-arms itself
              if (SUITE.shuffleBusy && SUITE.shuffleBusy()) return;
              warmTrack(nx2);
            } catch (e) {}
          }, 12000);
        }
      } catch (e) {}
    }

    const keyGen = new Map();   // per-track search generation: a forced re-search (ban / retry) outranks older runs' cache writes
    // the user's own choice wins: bump the generation so a still-running automatic search
    // (or its late rescue) can neither repaint over it nor overwrite it in the cache
    function supersede() { token++; if (meta) keyGen.set(meta.key, (keyGen.get(meta.key) || 0) + 1); return token; }
    function ensure(force) {
      if (!meta) { if (UI.isOpen()) UI.showIdle(); return; }
      const key = meta.key;
      if (force) { token++; keyGen.set(key, (keyGen.get(key) || 0) + 1); SyncAuto.ms = 0; SyncAuto.conf = 0; SyncAuto.last = null; }   // stale results from the superseded run must neither paint nor cache; the old match's auto-offset dies with it
      const myToken = token;
      const myGen = keyGen.get(key) || 0;

      if (!force) {
        const entry = Cache.get(key);
        const c = fromCache(entry);
        if (c) {
          off = (entry && entry.off) || 0;
          SyncAuto.ms = (entry && entry.aoff) | 0; SyncAuto.conf = SyncAuto.ms ? 1 : 0;
          anch = (entry && entry.anch) || [];
          apply(c, myToken);
          return;
        }
        if (Miss.has(key)) { apply(null, myToken); return; }
        if (Inflight.has(key)) {
          if (UI.isOpen() && !UI.inSearch()) UI.showLoading();
          try { UI.setBusy(true); } catch (e) {}
          const infl = Inflight.get(key);
          infl.then((r) => {
            if (myToken !== token) return;
            // a LITE pre-warm coming back empty OR low-confidence is not an
            // answer — run the full search instead of trusting weak evidence
            if (infl.lite && (!r || r.low)) { if (!Inflight.has(key)) ensure(true); return; }
            apply(r, myToken);
          }).catch(() => { if (myToken !== token) return; try { UI.setBusy(false); } catch (e) {} if (UI.isOpen()) UI.showError(); });
          return;
        }
      } else {
        Miss.del(key);
      }

      if (UI.isOpen() && !UI.inSearch()) UI.showLoading();
      try { UI.setBusy(true); } catch (e) {}
      off = 0;
      anch = [];
      let partial = null;   // best-ready candidate rendered while verification continues
      const p = findLyrics(meta, (late) => {
        if (!late) return;
        if ((keyGen.get(key) || 0) === myGen) {
          const e2 = toCache(late);
          if (token !== myToken) e2.off = 0;   // never bake the NOW-playing track's offset into another track's entry
          Cache.set(key, e2);
          Miss.del(key);
        }
        if (token === myToken) {
          apply(late, myToken);
          if (UI.isOpen()) UI.toast('Found it');
        }
      }, (cand) => {
        if (token === myToken && UI.isOpen() && !UI.inSearch() && !lyr) {
          UI.setSrcLine('Found \u201C' + esc(cand.t) + '\u201D \u00B7 loading lyrics\u2026');
        }
      }, {
        onPartial: (rp) => {
          if (token !== myToken || partial) return;
          partial = rp;
          // lyrics on screen NOW; the judge keeps working and either confirms
          // this result (no re-render) or swaps in a better one
          if (UI.isOpen() && !UI.inSearch()) {
            lyr = rp;
            UI.renderLyrics(rp);
            const sl = UI.srcFor(rp);
            UI.setSrcLine(sl[0] + '<span class="dot"> \u00B7 </span>verifying\u2026', sl[1]);
          }
        },
      }).then((r) => {
        if (Inflight.get(key) === p) Inflight.delete(key);
        // a decent provisional that survived the whole search beats "nothing"
        const fin = r || partial;
        if (fin && fin.synced && !fin.instr && !off && myToken === token) {
          const ao = autoOff(fin.src);   // smart sync memory pre-correction
          if (ao) off = ao;
        }
        if ((keyGen.get(key) || 0) === myGen) {
          if (fin) {
            const e2 = toCache(fin);
            if (myToken !== token) e2.off = 0;   // finished after a track change: cache it, but not with the new track's offset
            Cache.set(key, e2);
          } else Miss.add(key);
        }
        return fin;
      }, (err) => {
        if (Inflight.get(key) === p) Inflight.delete(key);
        throw err;
      });
      Inflight.set(key, p);
      p.then((r) => apply(r, myToken)).catch(() => {
        try { UI.setBusy(false); } catch (e) {}
        if (myToken === token && UI.isOpen()) UI.showError();
      });
    }

    function onTrackChange(m) {
      preconnect();   // first music = first third-party contact, not page load
      meta = m;
      meta.key = trackKey(m);
      try { Chapters.load(meta); } catch (e) {}
      token++;
      lyr = null;
      off = 0;
      SyncAuto.ms = 0; SyncAuto.conf = 0;
      anch = [];
      alignStart();
      UI.setReady(false);
      UI.setHeader(meta);
      UI.exitSearch(true);
      try { UI.setMini(null); } catch (e) {}   // never show the previous track's line
      if (UI.isOpen() && !UI.inSearch()) UI.showLoading();
      stopT(prefetchT);
      stopT(warmT); stopT(warmT2);   // cancel the previous track's pending pre-warms so they can't pile up
      // Ticker, not setTimeout: hidden-tab timer clamping used to stall the
      // deferred search for minutes in exactly the background-tab scenario
      // the shared Worker exists for
      let kicks = 0;
      const kick = () => {
        if (SUITE.shuffleBusy && SUITE.shuffleBusy()) { prefetchT = Ticker.after(kick, 1200); return; }
        // duration is the engine's strongest right-version signal, but the
        // player DOM often exposes it a beat AFTER the title changes — wait
        // for it (max ~500ms) instead of searching blind without it
        if (!(meta.dur > 0) && kicks++ < 4) {
          const m2 = readMeta();
          if (m2 && m2.dur > 0 && m2.title === meta.title) meta.dur = m2.dur;
          if (!(meta.dur > 0)) { prefetchT = Ticker.after(kick, 120); return; }
        }
        ensure(false);
      };
      prefetchT = Ticker.after(kick, 20);
    }

    function watch() {
      let lastSig = '';
      let observed = null;
      let moT = 0;

      const check = () => {
        const m = readMeta();
        const sig = m ? m.title + '|' + m.uploader : '';
        if (sig && sig !== lastSig) {
          lastSig = sig;
          onTrackChange(m);
        } else if (m && meta && meta.href && m.href && m.href !== meta.href) {
          onTrackChange(m);   // same title + uploader, different permalink (archive accounts' "untitled" uploads)
        } else if (m && meta) {
          if (m.dur > 0 && !(meta.dur > 0)) meta.dur = m.dur;
          if (m.art && !meta.art) { meta.art = m.art; UI.setHeader(meta); }
          if (m.href && !meta.href) {
            // late href: recompute the (permalink-based) key and migrate any
            // state filed under the title|uploader fallback key. An in-flight
            // search still writes under the OLD key it captured — so migrate
            // AFTER it settles, and never overwrite a fresher entry at nk.
            meta.href = m.href;
            const old = meta.key, nk = trackKey(meta);
            if (nk !== old) {
              meta.key = nk;
              const migrate = () => {
                try {
                  if (!Cache.has(nk)) {
                    const e2 = Cache.get(old);
                    if (e2) Cache.set(nk, e2);
                    else if (Miss.has(old)) Miss.add(nk);
                  }
                  Miss.del(old);
                } catch (e) {}
              };
              const fl = Inflight.get(old);
              if (fl) fl.then(migrate, migrate);
              else migrate();
            }
          }
        }
      };

      const mo = new MutationObserver(() => {
        clearTimeout(moT);
        moT = setTimeout(check, 120);
      });
      const attach = () => {
        const t = document.querySelector('.playbackSoundBadge') || document.querySelector('.playControls');
        if (t && t !== observed) {
          try { mo.disconnect(); mo.observe(t, { childList: true, subtree: true }); observed = t; } catch (e) {}   // no characterData: the ticking clock fired check() ~8×/s; track changes are structural (childList), and the 800ms poll is the safety net
        } else if (observed && !observed.isConnected) {
          observed = null;
        }
      };

      Ticker.every(() => { check(); UI.ensureButton(); attach(); }, 800);
      attach();
      check();
      UI.ensureButton();
      hoverWarmInit();

      // network recovery: a track that came up empty while offline searches
      // itself again the moment the connection returns
      window.addEventListener('online', () => {
        Ticker.after(() => {
          try {
            if (!meta || lyr || Inflight.has(meta.key)) return;
            Miss.del(meta.key);
            ensure(true);
            if (UI.isOpen()) UI.toast('Back online — searching again');
          } catch (e) {}
        }, 800);
      });
    }

    /* ---------- "wrong lyrics": ban this match for this track, re-search ---------- */
    function banCurrent() {
      if (!meta || !lyr || lyr.instr) { UI.toast('Nothing to ban'); return; }
      try { UI.exitSearch(true); } catch (e) {}
      try {
        const bm = GM_getValue('sl:ban', {}) || {};
        const arr = bm[meta.key] || [];
        const tag = (lyr.src || '') + '|' + normKey((lyr.a || '') + ' ' + (lyr.t || ''));
        if (!arr.includes(tag)) arr.push(tag);
        bm[meta.key] = arr.slice(-8);
        const ks = Object.keys(bm);
        while (ks.length > 120) delete bm[ks.shift()];
        GM_setValue('sl:ban', bm);
      } catch (e) {}
      try { Cache.del(meta.key); } catch (e) {}   // or the banned lyrics come straight back from cache on the next play
      UI.toast('Banned that match — searching again');
      ensure(true);
    }

    /* ---------- bring your own lyrics: .lrc / .txt file, or paste ---------- */
    function adopt(result, expectToken) {
      // a file read / paste can complete after the user skipped to another track;
      // bail so the imported lyrics never get filed under (or rendered on) the wrong song
      if (expectToken != null && expectToken !== token) { UI.toast('Track changed — import skipped'); return; }
      try { UI.exitSearch(true); } catch (e) {}
      const mine = supersede();
      off = 0;
      anch = [];
      SyncAuto.ms = 0; SyncAuto.conf = 0; SyncAuto.last = null;
      if (meta) { Cache.set(meta.key, toCache(result)); Miss.del(meta.key); }
      apply(result, mine);
    }
    function importLrc() {
      if (!meta) { UI.toast('Play a track first'); return; }
      try {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.lrc,.txt,text/plain';
        inp.style.display = 'none';
        inp.addEventListener('cancel', () => inp.remove(), { once: true });   // dismissed picker: don't leave an orphan input behind
        inp.addEventListener('change', () => {
          const f = inp.files && inp.files[0];
          if (!f) { inp.remove(); return; }
          if (f.size > 512 * 1024) { UI.toast('That file is too big — lyrics files are a few KB'); inp.remove(); return; }
          const myToken = token, a = (meta && meta.uploader) || '', t = (meta && meta.title) || '';   // pin to the track the file was chosen FOR
          const rd = new FileReader();
          rd.onload = () => {
            try {
              const raw = String(rd.result || '');
              const lines = parseLRC(raw, '', '');
              if (lines.length >= 4) {
                adopt({ src: 'file', synced: true, lines, a, t, picked: true }, myToken);
                UI.toast('Lyrics loaded — synced');
              } else {
                const texts = raw.split(/\r?\n/).map((l) => l.trim());
                if (!texts.filter(Boolean).length) { UI.toast('That file looks empty'); return; }
                adopt({ src: 'file', synced: false, lines: texts, a, t, picked: true }, myToken);
                UI.toast('Lyrics loaded');
              }
            } catch (e) { UI.toast('Couldn’t read that file'); }
          };
          rd.readAsText(f);
          setTimeout(() => inp.remove(), 2000);
        });
        (document.body || document.documentElement).appendChild(inp);
        inp.click();
      } catch (e) { UI.toast('Import failed'); }
    }
    function acceptPasted(text) {
      if (!meta) { UI.toast('Play a track first'); return false; }
      const lines = parseLRC(text, '', '');
      if (lines.length >= 4) {
        adopt({ src: 'paste', synced: true, lines, a: meta.uploader || '', t: meta.title || '', picked: true });
        UI.toast('Pasted — synced');
        return;
      }
      const texts = String(text || '').split(/\r?\n/).map((l) => l.trim());
      if (!texts.filter(Boolean).length) { UI.toast('Nothing to paste'); return; }
      adopt({ src: 'paste', synced: false, lines: texts, a: meta.uploader || '', t: meta.title || '', picked: true });
      UI.toast('Pasted lyrics saved');
    }
    function exportLibraryJson() {
      try {
        const out = SUITE.lyricsDump ? SUITE.lyricsDump() : null;
        if (!out) { UI.toast('No cached lyrics yet'); return; }
        const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'sc-lyrics-library-' + new Date().toISOString().slice(0, 10) + '.json';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        UI.toast(Object.keys(out).length + ' lyrics exported');
      } catch (e) { UI.toast('Export failed'); }
    }

    /* ---------- hover pre-warm: linger on a track link → lyrics load before you press play ---------- */
    let hoverOn = true;
    try { hoverOn = !!GM_getValue('sl:hover', 1); } catch (e) {}
    function toggleHover() {
      hoverOn = !hoverOn;
      try { GM_setValue('sl:hover', hoverOn ? 1 : 0); } catch (e) {}
      UI.toast('Hover pre-warm ' + (hoverOn ? 'on' : 'off'));
    }
    const HOVER_SKIP = /^\/(you|discover|search|stream|library|settings|messages|notifications|tags|charts|people|popular|stations|upload|feed|mobile|pages|jobs|terms|imprint)(\/|$)/;
    const HOVER_SKIP2 = /^\/[\w-]+\/(tracks|albums|sets|playlists|reposts|followers|following|likes|comments|popular-tracks)$/;   // profile tabs, not tracks
    let hoverT2 = null, hoverHref = '', hoverWarms = 0;
    const hoverSeen = new Map();
    function hoverWarmInit() {
      try {
        document.addEventListener('mouseover', (e) => {
          if (!hoverOn || hoverWarms >= 50) return;   // a browse session, not a crawler
          const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
          if (!a) return;
          const href = (a.getAttribute('href') || '').split('?')[0].split('#')[0];
          if (!/^\/[\w-]+\/[\w-]+$/.test(href) || HOVER_SKIP.test(href) || HOVER_SKIP2.test(href)) return;
          const label = (a.getAttribute('title') || a.textContent || '').trim();
          if (label.length < 3 || href === hoverHref) return;
          hoverHref = href;
          if (hoverT2) { try { hoverT2.stop(); } catch (e2) {} }
          hoverT2 = Ticker.after(() => {
            try {
              if (hoverHref !== href || !hoverOn) return;   // the cursor moved on
              if (Date.now() - (hoverSeen.get(href) || 0) < 600000) return;
              hoverSeen.set(href, Date.now());
              if (hoverSeen.size > 500) hoverSeen.delete(hoverSeen.keys().next().value);   // evict OLDEST, not the whole map (was thrashing the 10-min dedup)
              if (SUITE.shuffleBusy && SUITE.shuffleBusy()) return;
              const lib = SUITE.libByUrl ? SUITE.libByUrl('https://soundcloud.com' + href) : null;
              const m = {
                title: (lib && lib.title) || label,
                uploader: (lib && lib.artist) || href.split('/')[1].replace(/-/g, ' '),
                href,
                dur: lib && lib.durMs > 0 ? Math.round(lib.durMs / 1000) : 0,
              };
              m.key = trackKey(m);
              if ((meta && m.key === meta.key) || Cache.has(m.key) || Miss.has(m.key) || Inflight.has(m.key)) return;
              hoverWarms++;
              Trail.add(`hover-warm: "${m.title}"`);
              const p = findLyrics(m, null, null, { lite: true }).then((r) => {
                Inflight.delete(m.key);
                // same caching bar as the queue pre-warm: confident hits only
                if (r && !r.low && !(r.synced && !(m.dur > 0))) { const e2 = toCache(r); e2.off = 0; Cache.set(m.key, e2); }
                return r;
              }).catch(() => { Inflight.delete(m.key); return null; });
              p.lite = true;
              Inflight.set(m.key, p);
            } catch (e2) {}
          }, 450);
        }, { passive: true, capture: true });
      } catch (e) {}
    }

    async function pick(item) {
      const myToken = token;
      UI.exitSearch(true);
      UI.showLoading();
      try {
        let result = null;
        const wantDur = meta ? meta.dur : 0;
        if (item.src === 'genius') {
          const lines = await geniusLyrics(item.url);
          if (lines && lines.length) result = { src: 'genius', synced: false, lines, a: item.a, t: item.t, picked: true };
        } else if (item.src === 'kugou' || item.src === 'netease') {
          const raw = item.src === 'netease' ? await neteaseLyric(item.nid) : await kugouLyric(item.kid, item.kkey);
          if (raw) {
            const lines = parseLRC(raw, item.a, item.t);
            if (lrcIsPlaceholder(lines)) {
              // an instrumental placeholder is not lyrics — leave the result empty
            } else if (lines.length) {
              // same ladder as the automatic path: scale to the upload's length,
              // or render text when the version is too far off to trust.
              const fit = fitSync(lines, item.dur, wantDur);
              result = fit
                ? { src: item.src, synced: true, scaled: fit.scaled, lines: fit.lines, a: item.a, t: item.t, srcDur: item.dur || 0, picked: true }
                : { src: item.src, synced: false, lines: lines.map((l) => l[1]), a: item.a, t: item.t, picked: true };
            }
          }
        } else {
          item.score = 1;
          result = fromInline(item, wantDur);
          if (result) { result.picked = true; result.low = false; }
        }
        if (!result) {
          if (myToken === token && UI.isOpen()) { UI.showNone(); UI.toast("Couldn't load that one"); }
          return;
        }
        if (myToken !== token) return;   // track changed during the await — don't zero/cache the NEW track's state
        const mine = supersede();
        off = 0;
        anch = [];
        SyncAuto.ms = 0; SyncAuto.conf = 0; SyncAuto.last = null;
        if (meta) { Cache.set(meta.key, toCache(result)); Miss.del(meta.key); }
        apply(result, mine);
      } catch (e) {
        if (myToken === token && UI.isOpen()) { UI.showError(); UI.toast('Source unreachable'); }
      }
    }

    function nudge(deltaMs) {
      if (!lyr || lyr.instr) return;
      const refreshSrc = () => {
        try { const sl = UI.srcFor(lyr); UI.setSrcLine(sl[0], sl[1]); } catch (e) {}
      };
      if (deltaMs === 0) {
        const hadAnchors = anch.length > 0;
        off = 0; SyncAuto.ms = 0; SyncAuto.conf = 0;
        anch = [];
        persistSync();
        UI.toast(hadAnchors ? 'Sync + anchors reset' : 'Sync reset');
        if (hadAnchors) rerender(); else refreshSrc();
        return;
      }
      off += deltaMs;
      persistSync();
      learnOffset();
      refreshSrc();   // the offset chip in the source line stays honest
      UI.toast(`Sync ${off > 0 ? '+' : ''}${(off / 1000).toFixed(Math.abs(off) % 100 ? 2 : 1)}s`);
    }

    // "this line is being sung RIGHT NOW" → compute the exact offset that
    // makes it the active line (highlight lead + device latency accounted for)
    function syncToLine(t) {
      if (!lyr || !lyr.synced) return;
      off = Math.round((t - lead / 1000 - Media.time()) * 1000) - goff - SyncAuto.ms;
      if (Math.abs(off) < 30) off = 0;
      persistSync();
      learnOffset();
      UI.toast('Synced to this line (' + (off >= 0 ? '+' : '') + (off / 1000).toFixed(2) + 's)');
    }

    function rerender() {
      if (!meta) { UI.showIdle(); return; }
      if (lyr) { lyr.instr ? UI.showInstrumental() : UI.renderLyrics(lyr); }
      else ensure(false);
    }

    function addAnchor(i, t) {
      // Compute the new anchor set in a LOCAL — don't mutate `anch`/`off` until
      // we know the new anchor survives validation. A rejected tap shouldn't
      // also wipe the user's existing offset.
      const tNew = Math.max(0, t);
      const fresh = { i, t: tNew, _new: true };
      // start from existing minus any anchor on the same line (re-tap replaces)
      const proposed = anch.filter((a) => a.i !== i).concat(fresh);
      // Monotonicity: anchors must ascend in BOTH index AND time. Walk in
      // line-index order; on a conflict, the _new anchor wins (newest tap
      // overrides) — drop any kept anchor that contradicts it. This is the
      // correct fix for the v4.50 regression where the sort order alone
      // decided who survived (so a late-tap of an EARLIER line couldn't win).
      proposed.sort((a, b) => a.i - b.i);
      const kept = [];
      for (const a of proposed) {
        // strip any existing anchor whose time/index would be non-monotonic vs a
        while (kept.length) {
          const last = kept[kept.length - 1];
          if (last.t < a.t && last.i < a.i) break;
          if (a._new) { kept.pop(); continue; }     // new tap always wins over older
          break;                                    // a is old, last is older — keep last, drop a
        }
        if (!kept.length || (a.i > kept[kept.length - 1].i && a.t > kept[kept.length - 1].t)) {
          kept.push(a);
        }
      }
      // The new tap must end up in `kept` for the addAnchor call to be considered
      // accepted. If it isn't (extremely contradictory user input), surface a
      // toast and leave anch+off untouched.
      const accepted = kept.some((a) => a._new);
      if (!accepted) {
        try { UI && UI.toast && UI.toast('Anchor conflicts — press 0 to reset sync'); } catch (e) {}
        return anch.slice();
      }
      // strip the _new flag now that we're committing
      for (const a of kept) delete a._new;
      anch = kept.length > 80 ? kept.slice(-80) : kept;
      off = 0;
      persistSync();
      return anch.slice();
    }

    function markInstrumental() {
      if (!meta) return;
      try { UI.exitSearch(true); } catch (e) {}
      const r = { instr: true, src: 'user', a: meta.uploader || '', t: meta.title || '' };
      const mine = supersede();
      Cache.set(meta.key, toCache(r));
      Miss.del(meta.key);
      apply(r, mine);
      UI.toast('Marked instrumental — no more searching for this one');
    }

    /* ---------- export: plain text + .lrc (calibration baked in) ---------- */
    function lyricsText() {
      if (!lyr || lyr.instr || !lyr.lines || !lyr.lines.length) return '';
      const arr = lyr.synced ? lyr.lines.map(x => x[1]) : lyr.lines.slice();
      return arr.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    function lyricsLrc() {
      if (!lyr || lyr.instr || !lyr.lines || !lyr.lines.length) return '';
      const offS = ((off || 0) + (SyncAuto.ms || 0)) / 1000;   // what the panel plays: manual nudge plus the vocal alignment
      const fmt = (t) => {
        t = Math.max(0, t - offS);   // a line activates at media time (t − off)
        const cs = Math.round(t * 100);   // round in centiseconds first — 59.999s must not print "[..:60.00]"
        const mm = Math.floor(cs / 6000), ss = (cs % 6000) / 100;
        return '[' + String(mm).padStart(2, '0') + ':' + (ss < 10 ? '0' : '') + ss.toFixed(2) + ']';
      };
      const head2 = [];
      if (lyr.t) head2.push('[ti:' + lyr.t + ']');
      if (lyr.a) head2.push('[ar:' + lyr.a + ']');
      head2.push('[re:SoundCloud Suite]');
      if (lyr.synced) return head2.concat(lyr.lines.map(([t, txt]) => fmt(t) + txt)).join('\n');
      // estimated/calibrated mode: rebuild exactly what the panel shows —
      // the user's double-tap anchors are baked into the exported times.
      // Same gates as the renderer: never fabricate a timeline the panel
      // itself refuses to display (too short, DJ-mix length, too few lines).
      const dur = meta && meta.dur > 0 ? meta.dur : 0;
      if (dur <= 20 || dur >= 1200) return '';
      const ents = estimateTimes(lyr.lines, dur).filter(e => !e.gap && !e.sec);
      if (ents.length < 8) return '';
      const warped = warpTimes(ents.map(e => e.t), anch);
      return head2.concat(ents.map((e, i) => fmt(warped[i]) + e.text)).join('\n');
    }
    function copyLyrics() {
      const txt = lyricsText();
      if (!txt) { UI.toast(lyr && lyr.instr ? 'Instrumental — nothing to copy' : 'No lyrics to copy'); return; }
      try { if (GM_setClipboard(txt) !== false) { UI.toast('Lyrics copied'); return; } } catch (e) {}
      // async fallback: only report success when the write actually lands
      try {
        navigator.clipboard.writeText(txt).then(() => UI.toast('Lyrics copied'), () => UI.toast('Copy failed'));
      } catch (e) { UI.toast('Copy failed'); }
    }
    function exportLrc() {
      const txt = lyricsLrc();
      if (!txt) {
        UI.toast(lyr && lyr.instr ? 'Instrumental — nothing to export' : 'No timed lyrics to export');
        return;
      }
      try {
        const blob = new Blob([txt], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const nm = ((meta && meta.title) || 'lyrics').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
        a.download = (nm || 'lyrics') + '.lrc';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        UI.toast('.lrc downloaded' + (anch.length ? ' — calibration baked in' : ''));
      } catch (e) { UI.toast('Export failed'); }
    }
    function publishLrclib() {
      if (!lyr || lyr.instr || !lyr.lines || !lyr.lines.length) { UI.toast('No lyrics to publish'); return; }
      if (!meta || !(meta.dur > 0)) { UI.toast('Need the track duration first'); return; }
      const track = (lyr.t || meta.title || '').trim();
      const artist = (lyr.a || meta.uploader || '').trim();
      if (!track || !artist) { UI.toast('Missing title/artist to publish'); return; }
      const plain = lyricsText();
      const synced = (lyr.synced || anch.length) ? lyricsLrc() : '';   // real or calibrated timings only — a syllable guess must never reach the public database
      UI.toast('Publishing to LRCLIB… solving its puzzle (up to a minute or two)');
      lrclibPublish({ track, artist, album: track, duration: meta.dur, plain, synced })
        .then(() => UI.toast('Published to LRCLIB — thank you! Findable for everyone now.'))
        .catch((e) => { const m = String((e && e.message) || ''); UI.toast('Couldn’t publish — ' + (/pow/.test(m) ? 'the puzzle took too long, try again' : (m || 'try again'))); });
    }

    return {
      meta: () => meta,
      lyricDebug: () => ({ off, goff, aoff: SyncAuto.ms, aoffConf: SyncAuto.conf, lead, last: SyncAuto.last, tracker: aligner ? aligner.stats() : null, synced: !!(lyr && lyr.synced), lines: lyr && lyr.lines ? lyr.lines.length : 0, src: lyr && lyr.src, meta: meta && { title: meta.title, dur: meta.dur } }),
      offsetMs: () => off,
      autoAlignMs: () => SyncAuto.ms,
      latencyMs: () => goff,
      autoLatencyMs: () => { try { return (SUITE.audioLatency && SUITE.audioLatency()) || 0; } catch (e) { return 0; } },
      setLatency,
      leadMs: () => lead,
      cycleLead,
      playPause() {
        // toggle SoundCloud's own transport, so the lyrics panel doubles as
        // a remote — no need to reach back to the player bar
        const b = document.querySelector('.playControls__play');
        if (b) { b.click(); return; }
        const m = Media.el();
        if (m) { try { m.paused ? m.play() : m.pause(); } catch (e) {} }
      },
      seekBy(sec) {
        const t = Media.time() + sec;
        Media.seek(Math.max(0, t));
        try { UI.toast((sec > 0 ? '+' : '') + sec + 's'); } catch (e) {}
      },
      markInstrumental, copyLyrics, exportLrc, publishLrclib, syncToLine,
      banCurrent, importLrc, acceptPasted, exportLibraryJson,
      addAlias: (name, artist) => { try { Aliases.add(name, artist); } catch (e) {} },
      hoverOn: () => hoverOn, toggleHover,
      diagnose: (onStep) => runDiagnostics(onStep),
      diagReport(results) {
        const head = `SoundCloud Suite v${VER} lyrics diagnostics · gmode=${Gmode.get()} · token=${Gtok.has() ? 'yes' : 'no'} · ${new Date().toISOString()}`;
        const lines = (results || []).map((r) => `${r.ok ? 'OK  ' : 'FAIL'} ${r.name} (${r.ms}ms)${r.ok ? '' : ' — ' + (r.msg || '')}`);
        return head + '\n' + lines.join('\n') + '\n\n-- last find trail --\n' + Trail.dump();
      },
      // one-tap bug report: track facts + the engine's decision trail, no
      // need to run full diagnostics first
      quickReport() {
        const m = meta || {};
        const head = `SoundCloud Suite v${VER} — track report · gmode=${Gmode.get()} · token=${Gtok.has() ? 'yes' : 'no'}`;
        const facts = `\nTitle: ${m.title || '?'}\nUploader: ${m.uploader || '?'}\nDuration: ${m.dur || '?'}s`
          + `\nURL: ${m.href ? 'https://soundcloud.com' + m.href : '?'}`;
        const raw = head + facts + '\n\n-- find trail --\n' + Trail.dump();
        const report = (typeof Log !== 'undefined' && Log && Log.redact) ? Log.redact(raw) : raw;
        try { GM_setClipboard(report); UI.toast('Report copied — paste it to me'); return; } catch (e) {}
        try { navigator.clipboard.writeText(report).then(() => UI.toast('Report copied — paste it to me'), () => UI.toast('Copy failed')); }
        catch (e) { UI.toast('Copy failed'); }
      },
      onOpen() {
        if (!meta) { UI.showIdle(); const m = readMeta(); if (m) onTrackChange(m); return; }
        if (lyr) { lyr.instr ? UI.showInstrumental() : UI.renderLyrics(lyr); }
        else ensure(false);
      },
      rerender,
      retry() { ensure(true); },
      getAnchors: () => anch.slice(),
      anchorCount: () => anch.length,
      addAnchor,
      pick, nudge, watch,
    };
  })();
  // lyric engine debug accessor — only when the user opted into debug (localStorage 'scss:debug' = '1')
  try { if (W.localStorage.getItem('scss:debug') === '1') { SUITE.lyricDebug = () => App.lyricDebug(); W.__sceLyricDebug = SUITE.lyricDebug; } } catch (e) {}

  /* ------------------------------------------------------------------ *
   *  10. HOTKEYS + BOOT
   * ------------------------------------------------------------------ */

  function hotkeys() {
    window.addEventListener('keydown', (e) => {
      // composedPath: inputs inside the shadow panel (queue filter, search)
      // retarget e.target to the host div — check the REAL target too
      const rt = (e.composedPath ? e.composedPath()[0] : null) || e.target;
      const ae = document.activeElement;
      const isTyping = (el2) => el2 && (el2.tagName === 'INPUT' || el2.tagName === 'TEXTAREA' || el2.tagName === 'SELECT' || el2.tagName === 'CANVAS' || el2.isContentEditable);
      // ⌘K / Ctrl+K — command palette, openable from anywhere (the palette's own
      // input stops propagation, so this never fights it once it's open)
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
        e.preventDefault(); UI.openPalette(); return;
      }
      if (isTyping(ae) || isTyping(rt)) return;

      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.repeat && e.code === 'KeyL') {   // ctrl/meta guard: AltGr chords must not toggle the panel; a held key must not flicker it
        e.preventDefault();
        UI.setOpen(!UI.isOpen());
        return;
      }
      // the palette floats above everything and can be open with the panel closed: Esc belongs to it first
      if (e.key === 'Escape' && UI.paletteOpen()) { e.preventDefault(); e.stopPropagation(); UI.closePalette(); return; }
      if (e.key === 'Escape' && UI.shareOpen && UI.shareOpen()) { e.preventDefault(); e.stopPropagation(); UI.shareClose(); return; }
      if (!UI.isOpen()) return;
      // a held key auto-repeats ~30×/s: only the seek / nudge / text-size keys may repeat
      if (e.repeat && !/^(?:Arrow(?:Left|Right|Up|Down)|[-=+[\]{}<>,.])$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); return; }
      // every key the panel consumes is also stopped, so SoundCloud's own shortcuts (R repost, M mute,
      // S search, 0-9 seek, G chords…) never fire alongside — it listens on window after us
      const own = () => { e.preventDefault(); e.stopPropagation(); };

      if (e.key === 'Escape') {
        if (SUITE.cardOpen && SUITE.cardOpen()) return; // shuffle's card closes first
        if (UI.escStep()) return;                       // cheat sheet → menu → fullscreen
        if (UI.inSearch()) UI.exitSearch();
        else UI.setOpen(false);
        return;
      }
      if (UI.inSearch()) return;
      // brackets BEFORE the modifier bail: on AltGr layouts '[' arrives with
      // ctrl+alt set. But never on Cmd+[ / plain Ctrl+[ — those are browser
      // Back/Forward and must not silently nudge sync.
      if (!e.metaKey && (!e.ctrlKey || e.altKey)) {
        if (e.key === '[') { own(); App.nudge(-100); return; }
        if (e.key === ']') { own(); App.nudge(100); return; }
        if (e.key === '{') { own(); App.nudge(-25); return; }
        if (e.key === '}') { own(); App.nudge(25); return; }
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return; // Alt+S = shuffle, never lyric search
      // SoundCloud's own Shift chords (⇧←/→ previous/next, ⇧↑/↓ volume, ⇧L repeat, ⇧S shuffle) pass through untouched
      if (e.shiftKey && (e.key.startsWith('Arrow') || e.key === 'L' || e.key === 'S')) return;

      // the Audio tab owns A (compare) · N (night) · , . (speed): tap-align, the mini bar and lyric nudging keep them elsewhere
      if (UI.curTab && UI.curTab() === 'audio' && SUITE.audioKey && SUITE.audioKey(e)) { own(); return; }
      if (e.key === 's' || e.key === 'S') { own(); UI.setTab('lyrics'); UI.enterSearch(); return; }
      if (e.key === 'f' || e.key === 'F') { own(); UI.toggleMax(); return; }
      if (e.key === 'k' || e.key === 'K') { own(); UI.toggleFocus(); return; }
      if (e.key === 'c' || e.key === 'C') { own(); UI.jumpChorus(); return; }
      if (e.key === 't' || e.key === 'T') { own(); UI.cycleTheme(); return; }
      if (e.key === 'n' || e.key === 'N') { own(); UI.toggleMini(); return; }
      if (e.key === 'm' || e.key === 'M') { own(); UI.cycleMood(); return; }
      if (e.key === 'g' || e.key === 'G') { own(); UI.cycleGlass(); return; }
      if (e.key === '/') { own(); UI.setTab('lyrics'); UI.openFind(); return; }
      // playback keys own the event when the panel is open — stopPropagation
      // so SoundCloud's native Space/arrow shortcuts don't ALSO fire (which
      // would double-toggle play or double-seek)
      // a focused panel button (switch, tab, chip) keeps Space for itself — and SoundCloud must not see it either
      if ((e.key === ' ' || e.key === 'Spacebar') && rt && rt.tagName === 'BUTTON' && !UI.tapActive()) { e.stopPropagation(); return; }
      if (e.key === ' ' || e.key === 'Spacebar') { own(); if (UI.tapActive()) UI.tapAdvance(); else App.playPause(); return; }
      if (e.key === 'a' || e.key === 'A') { own(); UI.startTapAlign(); return; }
      if (e.key === 'j' || e.key === 'J') { own(); App.seekBy(-10); return; }
      if (e.key === 'l' || e.key === 'L') { own(); App.seekBy(10); return; }
      if (e.key === 'ArrowUp') { if (UI.seekLine(-1)) own(); return; }
      if (e.key === 'ArrowDown') { if (UI.seekLine(1)) own(); return; }
      if (e.key === 'ArrowLeft') { own(); App.seekBy(-5); return; }
      if (e.key === 'ArrowRight') { own(); App.seekBy(5); return; }
      if (e.key === 'r' || e.key === 'R') { own(); UI.replayLine(); return; }
      if (e.key === ',' || e.key === '<') { own(); App.nudge(-500); return; }
      if (e.key === '.' || e.key === '>') { own(); App.nudge(500); return; }
      if (e.key === '?') { own(); UI.showKeys(true); return; }
      if (e.key === '1') { own(); UI.setTab('lyrics'); return; }
      if (e.key === '2') { own(); UI.setTab('queue'); return; }
      if (e.key === '3') { own(); UI.setTab('stats'); return; }
      if (e.key === '4') { own(); UI.setTab('audio'); return; }
      if (e.key === '5') { own(); UI.setTab('tweaks'); return; }
      if (e.key === '-' || e.key === '=' || e.key === '+') { own(); UI.bumpFont(e.key === '-' ? -1 : 1); return; }
      if (e.key === '0') { own(); App.nudge(0); return; }
    }, true);
    // keyup: a held A (compare) on the Audio tab is released here, since the hub owns the keys while open
    window.addEventListener('keyup', (e) => { try { if (UI.isOpen() && SUITE.audioKey) SUITE.audioKey(e); } catch (e2) {} }, true);   // any tab: a release must always clear a held compare
  }

  function boot() {
    try {
      UI.mount();
      App.watch();
      hotkeys();
      SUITE.lyricsOpen = () => UI.isOpen();
      // all-in-one: the ✦ enhancer button opens the hub on its Tweaks tab
      SUITE.openLyricsTweaks = () => { try { UI.setOpen(true); UI.setTab('tweaks'); } catch (e) {} };
      // the ✦ gear TOGGLES settings: already on Tweaks → close; otherwise open + show Tweaks
      SUITE.toggleTweaks = () => { try { if (UI.isOpen() && UI.curTab && UI.curTab() === 'tweaks') UI.setOpen(false); else { UI.setOpen(true); UI.setTab('tweaks'); } } catch (e) {} };
      // open the hub on its Lyrics tab (the player-bar suite button)
      SUITE.openLyrics = () => { try { UI.setOpen(true); UI.setTab('lyrics'); } catch (e) {} };
      // toggle the hub open/closed — the bar's suite button must visibly do
      // something even when the panel is already open
      SUITE.toggleLyrics = () => { try { if (UI.isOpen()) { UI.setOpen(false); } else { UI.setOpen(true); UI.setTab('lyrics'); } } catch (e) {} };
      // extension toolbar button → toggle the panel. The background worker
      // relays the click through bridge.js (isolated world) to here (MAIN).
      // Harmless in the Tampermonkey build — no such message ever arrives.
      try {
        W.addEventListener('message', (e) => {
          if (e.source === W && e.data && e.data.scss === 'sl-toggle') {
            try { UI.setOpen(!UI.isOpen()); } catch (e2) {}
          }
        });
      } catch (e) {}
      // once per version: open the panel and show what changed — new features
      // shouldn't depend on the user spelunking through menus to be noticed
      try {
        // gate on the MINOR version (4.46), so it fires once per feature release —
        // not frozen at one version (the old bug: hard-coded !== '4.31.0' meant it
        // only ever fired once), and not on every patch bump.
        const sv = VER.split('.').slice(0, 2).join('.');
        const prevVer = GM_getValue('sl:ver', '');
        if (prevVer !== sv) {
          GM_setValue('sl:ver', sv);
          // the engine often changed between releases: stale "no lyrics here"
          // verdicts must re-search so improvements actually reach the user
          try { Miss.clearAll(); } catch (e) {}
          // upgrades only: a first install already gets the welcome card, and two sheets at once bury both
          if (prevVer) Ticker.after(() => { try { UI.setOpen(true); UI.showWhatsNew(); } catch (e) {} }, 2500);
        }
      } catch (e) {}
      // one-time: clear any dragged position/size so the panel returns to its
      // small, corner-tucked default (separate flag → doesn't re-pop What's New)
      try {
        if (!GM_getValue('sl:cornerreset', 0)) {
          GM_setValue('sl:cornerreset', 1);
          GM_deleteValue('sl:pos');
          GM_deleteValue('sl:size');
        }
      } catch (e) {}
      // lyric cache rides along in the shuffle module's Export/Import backups
      SUITE.lyricsDump = () => {
        try {
          const out = {};
          GM_getValue('sl4:idx', []).forEach((k) => { const v = GM_getValue('sl4:' + k, null); if (v) out[k] = v; });
          return Object.keys(out).length ? out : null;
        } catch (e) { return null; }
      };
      SUITE.lyricsRestore = (obj) => {
        try {
          if (!obj || typeof obj !== 'object') return;
          for (const k of Object.keys(obj)) {
            // a hand-edited backup must not clobber the cache's own bookkeeping
            if (k === 'idx' || k === 'mig' || k === 'miss' || k.length > 300) continue;
            const v = obj[k];
            if (v && (v.v === 3 || v.v === 4) && Array.isArray(v.lines)) Cache.set(k, v);
          }
        } catch (e) {}
      };
      // (connection pre-warm now happens on the FIRST track change — see
      // App.preconnect — so idle browsing makes zero third-party contact)
      try {
        GM_registerMenuCommand('Open lyrics panel', () => UI.setOpen(true));
        GM_registerMenuCommand('Re-search this track', () => { UI.setOpen(true); App.retry(); });
        GM_registerMenuCommand('Copy lyrics (text)', () => App.copyLyrics());
        GM_registerMenuCommand('Export lyrics as .lrc', () => App.exportLrc());
        GM_registerMenuCommand('Run diagnostics', () => { UI.setOpen(true); UI.showDiag(); });
        GM_registerMenuCommand('Clear lyrics cache', () => { Cache.clear(); Miss.clearAll(); UI.toast('Cache cleared'); });
      } catch (e) {}
    } catch (e) {
      try { console.warn('[SuperLyrics] failed to start:', e); } catch (e2) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

/* ═══════════════════ MODULE 3 · ENHANCER (themes · declutter · player · QOL) ═══════════════════
 *  A whole-SoundCloud enhancer. Every feature is isolated and FAIL-SAFE:
 *  visual features are pure CSS (a stale selector just does nothing, it can
 *  never break playback or layout), behavioural features read live settings
 *  inside try/catch. Settings persist via GM storage (shared with the rest
 *  of the suite). One settings panel, opened from a player-bar button. */
(() => {
  'use strict';
  const W = (typeof SUITE !== 'undefined' && SUITE.W) ? SUITE.W : window;
  try { if (W.__SCENH__) return; W.__SCENH__ = 1; } catch (e) {}
  const D = document;
  const GET = (k, d) => { try { return GM_getValue(k, d); } catch (e) { return d; } };
  const SET = (k, v) => { try { GM_setValue(k, v); } catch (e) {} };

  const DEFAULTS = {
    theme: 'none',          // none | dark themes | tint themes | custom
    customTheme: { bg: '#16181c', card: '#1d2025', hov: '#23272e', tx: '#e7e7ec', sub: '#9a9aa2', bd: '#2b2f36' },
    autoDark: false,        // auto-switch to a dark theme at night, light by day (overrides `theme` while on)
    autoDarkTheme: 'dark',  // which dark theme to use after dark
    accent: 'default',      // default | red | pink | purple | blue | cyan | green | gold | custom
    customAccent: '#ff5500',// hex used when accent === 'custom'
    hideUpsell: true,       // Go+ / upgrade nags
    hidePromoted: false,    // promoted / sponsored items in the stream
    hideComments: false,    // comment markers on the waveform
    grayArt: false,         // artwork grayscale until hover
    dimSidebar: false,      // fade the right sidebar until hover
    bigPlay: false,         // larger play button
    fontScale: 100,         // 85..120 (%)
    hideFollowFeed: false,  // hide "suggested people to follow" boxes
    customCss: '',          // power users: your own CSS, applied last
    // ── more declutter / appearance (all pure-CSS, fail-safe) ──
    hideUpload: false,      // hide the header Upload button
    hideStories: false,     // hide the stories/"upload your first" bar
    hidePlayCounts: false,  // hide play / like counts for a calmer feed
    hideRelated: false,     // hide the related-tracks autoplay panel
    hideCommentSection: false, // hide the comments list under a track
    hideAppBanner: true,    // hide "get the app"/mobile nags
    squareArt: false,       // square artwork instead of rounded
    thinScroll: false,      // slim custom scrollbars
    focusMode: false,       // hide the right sidebar entirely
    maxWidth: false,        // cap content width for big screens
    hideReposts: false,     // hide reposts in the stream
    resumePos: 'ask',       // long tracks remember their position: 'ask' | 'auto' | 'off'
    hidePlaylistsFeed: false, // hide playlists in the stream
    compactFeed: false,     // tighter stream rows
    biggerWave: false,      // taller waveform
    backTop: true,          // back-to-top button when scrolled
    // ── player / listener (behavioural) ──
    speed: 100,             // 50..200 (% playback speed)
    speedPerTrack: false,   // remember & restore playback speed per track URL
    // ── audio FX (experimental, default OFF; perfect passthrough when off) ──
    eqOn: false,            // 10-band graphic EQ master switch
    eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],   // per-band gain, −12..+12 dB (31Hz→16kHz)
    eqPreamp: 0,            // master pre-amp, −12..+12 dB
    eqCustom: {},           // user-saved EQ presets { name: number[10] }
    loudnessOn: false,      // auto-level loudness via analyser + makeup gain
    fadeOn: false,          // fade tracks in/out to smooth the gap
    enhanceOn: false,       // psychoacoustic enhancer: air shelf + warmth + punch
    enhanceAmt: 50,         // enhancer intensity 0..100
    stereoWidth: 100,       // stereo width 0..200 (100 = normal, 0 = mono)
    rememberVol: true,      // restore volume across sessions
    loopTrack: false,       // loop the current track
    pauseOnHide: false,     // pause when the tab is hidden
    volScroll: true,        // scroll wheel over the player bar = volume
    keySeek: false,         // 0–9 seek %, [ ] = ±10s, when not typing (opt-in)
    hotkeys: false,         // global one-key shortcuts (opt-in)
    miniPlayer: false,      // draggable floating now-playing widget
    cfgVer: 2,              // settings schema version (migrateCfg)
    // ── audio: EQ ──
    eqAutoPre: true,        // lower the pre-amp by the composite boost (auto-headroom)
    eqPerTrack: false,      // remember & restore the EQ curve per track URL (WP10; the spd:bytrack pattern)
    peqOn: false,           // headphone correction bank (AutoEQ)
    peq: [],                // ≤10 × { t:'PK'|'LSC'|'HSC', f:20..20000, g:-15..15, q:0.1..10 }
    peqPreamp: 0,           // -15..0 dB, from the AutoEQ "Preamp" line
    peqName: '',            // ≤40 chars
    // ── audio: tone ──
    bassDb: 0,              // 0..9 (step .5); the 25 Hz rumble filter engages automatically under any LF boost
    bassHarm: 0,            // 0..100 harmonic bass for small speakers (WP10): a parallel branch off `bass`, gain 0..0.5
    tiltDb: 0,              // -4..4 (step .5), per shelf
    vocalAmt: 0,            // -100..100
    loudCompOn: false, loudCompAmt: 6,   // 0..9 dB (no slider yet)
    listenOn: '',           // '' | 'headphones' | 'laptop' | 'speakers' (which chip is lit)
    // ── audio: stereo (stereoWidth is above, where widenAmt used to be) ──
    crossfeedOn: false, crossfeedMode: 'natural',   // subtle | natural | strong
    balance: 0,             // -100..100
    monoOn: false, swapLR: false,
    // ── audio: loudness & dynamics ──
    loudTarget: -14,        // -18 | -14 | -11 LUFS
    boostAmt: 100,          // 100..300 %
    limiterOn: true,
    nightOn: false, nightAmt: 50,        // 0..100
    // ── audio: playback ──
    vinylMode: false,
    fadeIn: 0.6, fadeOut: 2.5,           // 0..3 s, 0..8 s
    skipSilence: false,     // end-of-track silence trim (WP10): the last 30 s only, never mid-track
    reverbAmt: 0,           // 0..100 → wet 0..0.35 through a generated 1.6 s IR (WP10 "Slowed + reverb")
    // ── toolbar buttons ──
    barSpeed: true, barCopy: true, barRestart: true, barAB: false, barInfo: true,
  };

  /* ───────── data-driven feature table — each entry is fully isolated and
   * FAIL-SAFE. 'hide' = display:none for the selectors; 'css' = raw CSS when
   * on. A stale selector simply does nothing — it can never break the page.
   * Adding a feature is one line here; DEFAULTS / CSS / the settings panel all
   * derive from it automatically. All default OFF (non-intrusive). ─────────
   * [key, category, label, type, payload] */
  const MORE = [
    // ── Declutter ──
    ['mhFooter', 'Hide more', 'Page footer', 'hide', '#app__footer,.l-footer,.footer__inner,footer.l-container'],
    ['mhTags', 'Hide more', 'Track tags', 'hide', '.sc-tagList,.tagList,.soundBadge__tagList,.tagContent'],
    ['mhDesc', 'Hide more', 'Track descriptions', 'hide', '.soundDescription,.truncatedAudioInfo,.sound__description,.audibleTitle'],
    ['mhShare', 'Hide more', 'Share buttons', 'hide', '.sc-button-share,.shareButton'],
    ['mhBuy', 'Hide more', 'Buy / purchase links', 'hide', '.buyLink,.soundActions__purchase,[class*="purchase" i],a.sc-buylink'],
    ['mhTrending', 'Hide more', 'Trending / charts sidebar', 'hide', '.sidebar .trending,[class*="chart" i].sidebarModule,.l-sidebar-right .charts'],
    ['mhInPlaylists', 'Hide more', '“In playlists” section', 'hide', '.soundContentInformation,.relatedPlaylists,.l-listen-content .inPlaylists'],
    ['mhMessages', 'Hide more', 'Messages icon', 'hide', 'a[href="/messages"],.header__notification--messages'],
    ['mhNotif', 'Hide more', 'Notifications icon', 'hide', 'a[href="/notifications"],.header__activities,.header__notification'],
    ['mhStats', 'Hide more', 'Stat numbers everywhere', 'hide', '.sc-ministats-comments,.infoStats__value,.sc-ministats-reposts'],
    ['mhProBadges', 'Hide more', 'Pro / Go+ badges', 'hide', '.proBadge,[class*="proBadge" i],.go-plus-badge,.sc-badge-go'],
    ['mhArtBig', 'Hide more', 'Big artwork (data saver)', 'hide', '.fullHero__artwork,.fullListenHero__artwork'],
    ['mhAvatars', 'Hide more', 'All avatars (data saver)', 'hide', '.userBadge__avatar,.commentItem__avatar,.userAvatar,.sc-artwork.userBadge__image'],
    ['mhRelatedArtists', 'Hide more', 'Related artists', 'hide', '.relatedArtists,.l-related-artists,[class*="relatedArtist" i]'],
    ['mhComposeBar', 'Hide more', 'Comment box on tracks', 'hide', '.commentForm,.commentsList__newComment'],
    // ── Layout ──
    ['mlSquareAv', 'Layout', 'Square avatars', 'css', '.image__rounded,.userBadge__avatar,.commentItem__avatar{border-radius:6px !important}'],
    ['mlCircleArt', 'Layout', 'Circular artwork', 'css', '.sound__coverArt .sc-artwork,.fullHero__artwork{border-radius:50% !important}'],
    ['mlRoundBtns', 'Layout', 'Pill-shaped buttons', 'css', '.sc-button,.sc-button-medium{border-radius:99px !important}'],
    ['mlFullWidth', 'Layout', 'Full-width layout', 'css', '.l-container,.l-container.l-fluid{max-width:none !important}'],
    ['mlStaticHeader', 'Layout', 'Non-sticky header', 'css', '.header{position:static !important}'],
    ['mlUnderline', 'Layout', 'Underline links on hover', 'css', '.l-container a:hover{text-decoration:underline !important}'],
    ['mlCompactComments', 'Layout', 'Compact comments', 'css', '.commentsList__item,.comment{padding-top:4px !important;padding-bottom:4px !important}'],
    ['mlMono', 'Layout', 'Monospace text', 'css', '.l-container,.l-container *:not([class*="icon"]){font-family:ui-monospace,Menlo,monospace !important}'],
    ['mlNoMotion', 'Layout', 'Reduce animations', 'css', '.l-container *,.playControls *{transition-duration:.01s !important;animation-duration:.01s !important}'],
    ['mlBigArt', 'Layout', 'Slightly bigger artwork', 'css', '.fullHero__artwork{transform:scale(1.05)}'],
    ['mlBoldTitles', 'Layout', 'Bolder track titles', 'css', '.soundTitle__title,.fullHero__title{font-weight:800 !important}'],
    // ── Reading / focus ──
    ['mrDimList', 'Reading', 'Spotlight hovered track', 'css', '.soundList__item{opacity:.72;transition:opacity .15s}.soundList__item:hover,.soundList__item:focus-within{opacity:1}'],
    ['mrHideAllCounts', 'Reading', 'Hide all engagement counts', 'hide', '.sc-ministats-item,.sound__soundStats .sc-ministats'],
    ['mrHideAvatarsFeed', 'Reading', 'Hide avatars in feed', 'hide', '.soundList__item .userBadge__avatar,.stream .userAvatar'],
    // ── Hide more (wave 2) ──
    ['mhFollowBtns', 'Hide more', 'Follow buttons in lists', 'hide', '.soundList__item .sc-button-follow,.userBadgeList .sc-button-follow'],
    ['mhVerified', 'Hide more', 'Verified badges', 'hide', '.verifiedBadge,[class*="verified" i].badge,.g-badge-verified'],
    ['mhBreadcrumb', 'Hide more', 'Breadcrumbs', 'hide', '.breadcrumb,.soundActions__breadcrumb,.systemPlaylistDetails__breadcrumb'],
    ['mhNativeShuffle', 'Hide more', 'SoundCloud shuffle/repeat', 'hide', '.shuffleControl,.repeatControl'],
    ['mhPlaylistCounts', 'Hide more', 'Playlist track counts', 'hide', '.playlist__trackCount,.trackList__count,.genericTrackCount__count'],
    ['mhSuggested', 'Hide more', 'Suggested tracks', 'hide', '.suggestedTracks,[class*="suggestion" i].soundList'],
    ['mhUploadAll', 'Hide more', 'Upload links everywhere', 'hide', 'a[href="/upload"],.uploadButton,.header__upsell'],
    ['mhNewBadges', 'Hide more', 'Unread / “new” dots', 'hide', '.header__notification--unread,.g-badge,[class*="unread" i].badge'],
    ['mhCoverBlur', 'Hide more', 'Blurred cover backgrounds', 'hide', '.fullHero__background,.listenHero__background,.l-hero-bg'],
    ['mhGenre', 'Hide more', 'Genre labels', 'hide', '.sc-tag.genre,.soundTitle__additionalContainer .sc-tag,.genreLabel'],
    ['mhListenHistory', 'Hide more', '“Recently played”', 'hide', '.historyList,[class*="recentlyPlayed" i]'],
    ['mhWaveTime', 'Hide more', 'Waveform timeline (under the wave)', 'hide', '.waveform__timeline,.playbackTimeline__timestamp'],
    // ── Layout (wave 2) ──
    ['mlFlat', 'Layout', 'Flat design (no shadows)', 'css', '.l-container *,.playControls{box-shadow:none !important}'],
    ['mlDarkScroll', 'Layout', 'Dark scrollbars', 'css', '::-webkit-scrollbar-thumb{background:#555 !important;border-radius:6px}::-webkit-scrollbar-track{background:transparent}'],
    ['mlLineSpacing', 'Layout', 'Roomier line spacing', 'css', '.l-container,.soundDescription,.commentsList__item{line-height:1.7 !important}'],
    ['mlBigTargets', 'Layout', 'Bigger click targets', 'css', '.sc-button,.sc-button-medium{min-height:38px !important}'],
    ['mlBigComments', 'Layout', 'Larger comment text', 'css', '.commentsList__item,.comment .commentItem__message{font-size:14px !important}'],
    ['mlCompactHeader', 'Layout', 'Compact header', 'css', '.header{height:46px !important;min-height:46px !important}'],
    ['mlRoundedArt', 'Layout', 'Softer rounded artwork', 'css', '.sc-artwork{border-radius:12px !important}'],
    ['mlNoHoverScale', 'Layout', 'No hover zoom', 'css', '.sound__artwork:hover .sc-artwork,.image:hover{transform:none !important}'],
    ['mlStickyPlayer', 'Layout', 'Emphasize player bar', 'css', '.playControls{box-shadow:0 -2px 18px rgba(0,0,0,.18) !important}'],
    ['mlWideSidebar', 'Layout', 'Wider right sidebar', 'css', '.l-sidebar-right{flex-basis:340px !important;max-width:340px !important}'],
    // ── Reading / focus (wave 2) ──
    ['mrZen', 'Reading', 'Zen mode (hide sidebar, footer & header menu)', 'hide', '.l-sidebar-right,.sidebar,#app__footer,.footer__inner,.header__nav .header__moreMenu'],
    ['mrA11yFocus', 'Reading', 'Always-visible focus rings', 'css', '.l-container a:focus,.sc-button:focus{outline:2px solid #ff5500 !important;outline-offset:2px}'],
    ['mrReduceTransparency', 'Reading', 'Reduce transparency', 'css', '.l-container [style*="rgba"],.modal__modal{backdrop-filter:none !important}'],
    // ── Hide more (wave 3) ──
    ['mhHeaderMore', 'Hide more', 'Header “⋯” menu', 'hide', '.header__moreActions,.header__moreMenu'],
    ['mhArtistStudio', 'Hide more', 'Artist Studio link', 'hide', 'a[href*="artists.soundcloud.com"],a[href^="/artist-studio"],.header__link--studio,.creatorSubscriptionUpsell'],
    ['mhProfileBanner', 'Hide more', 'Profile header banner', 'hide', '.profileHeaderBackground,.userHeader__background,.fullHero__background'],
    ['mhTrackNums', 'Hide more', 'Track numbers in lists', 'hide', '.trackItem__number,.trackList__item .trackItem__number'],
    ['mhRepostOverlay', 'Hide more', 'Repost overlay on tiles', 'hide', '.sound__artwork .sc-button-repost,.audibleTile .sc-button-repost'],
    ['mhCommentTimes', 'Hide more', 'Comment timestamps', 'hide', '.commentItem__timestamp,.comment__timestamp,.commentNode__timestamp'],
    ['mhSocialFooter', 'Hide more', 'Footer social links', 'hide', '.footer__socialLinks,.l-footer__social,.footer__columns'],
    ['mhReport', 'Hide more', '“Report” links', 'hide', '.sc-button-report,a[href*="/report"],.reportLink'],
    ['mhPartnerOffers', 'Hide more', 'Partner offers', 'hide', '[class*="partnerOffer" i],a[href*="partner-offers"],a[href$="/partners"]'],
    ['mhInsightsNag', 'Hide more', 'Insights / studio nags', 'hide', '.insightsUpsell,[class*="insights" i].upsell,.creatorUpsell'],
    ['mhFollowProfile', 'Hide more', 'Follow button on profiles', 'hide', '.profileHeaderInfo .sc-button-follow,.userInfoBar .sc-button-follow'],
    ['mhWaveNumbers', 'Hide more', 'Player-bar duration & timecodes', 'hide', '.playbackTimeline__duration,.waveform__layer .timecode'],
    ['mhTrendingTags', 'Hide more', 'Trending tags bar', 'hide', '.trendingTags,.g-tags-trending,[class*="trendingTag" i]'],
    // ── Layout (wave 3) ──
    ['mlSharp', 'Layout', 'Sharp corners (no rounding)', 'css', '.sc-artwork,.sc-button,.image,.image__rounded{border-radius:0 !important}'],
    ['mlBubbly', 'Layout', 'Extra-rounded artwork', 'css', '.sc-artwork,.sound__coverArt .image{border-radius:16px !important}'],
    ['mlCardShadows', 'Layout', 'Card depth shadows', 'css', '.sound,.audibleTile,.soundList__item{box-shadow:0 2px 10px rgba(0,0,0,.18) !important;border-radius:10px}'],
    ['mlHoverLift', 'Layout', 'Lift tiles on hover', 'css', '.soundList__item,.audibleTile{transition:transform .15s}.soundList__item:hover,.audibleTile:hover{transform:translateY(-2px)}'],
    ['mlNoTruncate', 'Layout', 'Full track titles', 'css', '.soundTitle__title,.playableTile__heading{white-space:normal !important;overflow:visible !important;text-overflow:clip !important}'],
    ['mlSmoothScroll', 'Layout', 'Smooth scrolling', 'css', 'html{scroll-behavior:smooth !important}'],
    ['mlAlwaysScroll', 'Layout', 'Always show scrollbars', 'css', '::-webkit-scrollbar{width:11px;height:11px}'],
    ['mlCenterControls', 'Layout', 'Center player controls', 'css', '.playControls__inner{justify-content:center !important}'],
    ['mlBigBadge', 'Layout', 'Bigger now-playing artwork', 'css', '.playbackSoundBadge__avatar,.playbackSoundBadge .image{transform:scale(1.1)}'],
    ['mlColorPlay', 'Layout', 'Accent the play button', 'css', '.playControls__play{color:#ff5500 !important}'],
    ['mlWaveGlow', 'Layout', 'Glowing waveform', 'css', '.waveform__layer{filter:drop-shadow(0 0 4px rgba(255,85,0,.35))}'],
    ['mlNeonAccent', 'Layout', 'Neon glow on orange', 'css', '.sc-button-cta,.playControls__play{box-shadow:0 0 12px rgba(255,85,0,.5) !important}'],
    ['mlRoundAvatars', 'Layout', 'Round avatars', 'css', '.userBadge__avatar,.commentItem__avatar{border-radius:50% !important}'],
    ['mlZoomHover', 'Layout', 'Zoom artwork on hover', 'css', '.sound__artwork .sc-artwork{transition:transform .2s}.sound__artwork:hover .sc-artwork{transform:scale(1.04)}'],
    ['mlFadeImg', 'Layout', 'Fade images in', 'css', '@keyframes sceFade{from{opacity:0}to{opacity:1}}.sc-artwork,.image__full{animation:sceFade .4s ease}'],
    ['mlWideMain', 'Layout', 'Wider main column', 'css', '.l-main,.l-middle-fixed{max-width:none !important;flex:1 1 auto !important}'],
    ['mlTallTiles', 'Layout', 'Taller artwork tiles', 'css', '.audibleTile__artwork,.sound__coverArt{min-height:auto}'],
    // ── Delight ──
    ['mdSpinArt', 'Delight', 'Spin artwork while playing', 'css', '@keyframes sceSpin{to{transform:rotate(360deg)}}.playControls:has(.playControls__play.playing) .playbackSoundBadge__avatar .sc-artwork,.playControls:has(.playControls__play.playing) .playbackSoundBadge .image{animation:sceSpin 12s linear infinite;border-radius:50% !important}'],
    ['mdGrayPause', 'Delight', 'Grayscale art when paused', 'css', '.playControls:not(:has(.playControls__play.playing)) .playbackSoundBadge .sc-artwork{filter:grayscale(1);transition:filter .3s}'],
    ['mdPulsePlay', 'Delight', 'Pulse the play button', 'css', '@keyframes scePulse{50%{transform:scale(1.08)}}.playControls__play.playing{animation:scePulse 1.6s ease-in-out infinite}'],
    ['mdGlowArt', 'Delight', 'Glow around now-playing art', 'css', '.playControls:has(.playControls__play.playing) .playbackSoundBadge__avatar{box-shadow:0 0 16px rgba(255,85,0,.5) !important;border-radius:8px}'],
    ['mdRainbowWave', 'Delight', 'Rainbow waveform sheen', 'css', '@keyframes sceHue{to{filter:hue-rotate(360deg)}}.waveform__layer{animation:sceHue 8s linear infinite}'],
    ['mdTiltHover', 'Delight', 'Tilt tiles on hover', 'css', '.audibleTile{transition:transform .18s}.audibleTile:hover{transform:perspective(600px) rotateX(3deg) scale(1.02)}'],
    ['mdShimmerTitle', 'Delight', 'Shimmer the page title', 'css', '.contentTitle,.profileHeaderInfo__userName{background:linear-gradient(90deg,#ff5500,#ff8a3d,#ff5500);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}'],
    ['mdBounceLike', 'Delight', 'Bounce on like', 'css', '@keyframes scePulse{50%{transform:scale(1.08)}}.sc-button-like.sc-button-selected{animation:scePulse .4s ease}'],
    // ── Reading (wave 3) ──
    ['mrMinimal', 'Reading', 'Minimal player (waveform only)', 'css', '.listenEngagement,.soundActions,.commentsList,.l-related,.relatedTracks{display:none !important}'],
    ['mrHideChrome', 'Reading', 'Hide nav, sidebar & footer', 'hide', '.header,.l-sidebar-right,.sidebar,#app__footer,.footer__inner'],
    ['mrBigTitles2', 'Reading', 'Large track titles', 'css', '.soundTitle__title,.playableTile__heading{font-size:16px !important;font-weight:700 !important}'],
  ];
  MORE.forEach((f) => { if (!(f[0] in DEFAULTS)) DEFAULTS[f[0]] = false; });

  let CFG = Object.assign({}, DEFAULTS, GET('enh:cfg', {}) || {});
  const save = () => SET('enh:cfg', CFG);
  // trailing debounce for drags (sliders, the EQ canvas): nodes ramp on every
  // input event, storage is written once the hand stops moving
  let _saveT = 0;
  const saveSoon = () => { clearTimeout(_saveT); _saveT = setTimeout(save, 250); };
  // every audio key: what Copy/Paste/Reset walk, and what the import clamps cover
  const AUDIO_KEYS = ['speed', 'speedPerTrack', 'eqOn', 'eqBands', 'eqPreamp', 'eqCustom', 'eqAutoPre', 'eqPerTrack', 'peqOn', 'peq', 'peqPreamp', 'peqName',
    'bassDb', 'bassHarm', 'tiltDb', 'vocalAmt', 'loudCompOn', 'loudCompAmt', 'listenOn', 'stereoWidth', 'crossfeedOn', 'crossfeedMode', 'balance', 'monoOn', 'swapLR',
    'loudnessOn', 'loudTarget', 'boostAmt', 'limiterOn', 'nightOn', 'nightAmt', 'enhanceOn', 'enhanceAmt', 'fadeOn', 'fadeIn', 'fadeOut', 'vinylMode', 'skipSilence', 'reverbAmt', 'loopTrack', 'rememberVol'];
  // numeric ranges [min, max, step], string caps { max }, enums { one: [...] }
  const AUDIO_CLAMP = {
    speed: [50, 200, 5], eqPreamp: [-12, 12, 1], peqPreamp: [-15, 0, 0.1], bassDb: [0, 9, 0.5], bassHarm: [0, 100, 5], tiltDb: [-4, 4, 0.5], vocalAmt: [-100, 100, 5],
    loudCompAmt: [0, 9, 0.5], stereoWidth: [0, 200, 5], balance: [-100, 100, 5], boostAmt: [100, 300, 5], nightAmt: [0, 100, 5], enhanceAmt: [0, 100, 5],
    fadeIn: [0, 3, 0.1], fadeOut: [0, 8, 0.1], reverbAmt: [0, 100, 5],
    resumePos: { one: ['ask', 'auto', 'off'] }, peqName: { max: 40 }, listenOn: { one: ['', 'headphones', 'laptop', 'speakers'] }, crossfeedMode: { one: ['subtle', 'natural', 'strong'] }, loudTarget: { one: [-18, -14, -11] },
  };
  const clampNum = (v, lo, hi, st) => { let x = +v; if (!isFinite(x)) x = 0; x = Math.max(lo, Math.min(hi, x)); if (st) x = Math.round(x / st) * st; return Math.round(x * 1000) / 1000; };
  // one PEQ filter entry, re-validated field by field (data only)
  const clampPeq = (f) => {
    if (!f || typeof f !== 'object') return null;
    const t = (f.t === 'LSC' || f.t === 'HSC') ? f.t : 'PK';
    return { t, f: clampNum(f.f, 20, 20000, 0), g: clampNum(f.g, -15, 15, 0), q: clampNum(f.q == null ? 0.7 : f.q, 0.1, 10, 0) };
  };
  // a custom preset's name: never a prototype-walking key (Object.assign would honour it)
  const eqPresetNameOk = (n) => typeof n === 'string' && n.length > 0 && n !== '__proto__' && n !== 'constructor' && n !== 'prototype';
  const clampBands = (a) => { a = Array.isArray(a) ? a : []; const out = []; for (let i = 0; i < 10; i++) out.push(clampNum(a[i], -12, 12, 1)); return out; };
  // the custom-preset map, rebuilt entry by entry: arrays (old saves) stay arrays, { b, pre } objects
  // keep both fields clamped; built without a prototype, then re-plained so storage sees a normal object
  const clampEqCustom = (v) => {
    const o = Object.create(null);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v)) {
        if (!eqPresetNameOk(k) || k.length > 24) continue;
        const p = v[k];
        if (Array.isArray(p)) o[k] = clampBands(p);
        else if (p && typeof p === 'object' && Array.isArray(p.b)) { const e = { b: clampBands(p.b) }; if (p.pre != null && isFinite(+p.pre)) e.pre = clampNum(p.pre, -12, 12, 1); o[k] = e; }
      }
    }
    return JSON.parse(JSON.stringify(o));
  };
  // returns a sanitized value for an audio key, or the default when the shape is wrong
  const clampAudioKey = (k, v) => {
    const d = DEFAULTS[k];
    if (k === 'eqBands') return clampBands(v);
    if (k === 'peq') { return (Array.isArray(v) ? v : []).map(clampPeq).filter(Boolean).slice(0, 10); }
    if (k === 'eqCustom') return clampEqCustom(v);
    if (typeof v !== typeof d) return (d && typeof d === 'object') ? JSON.parse(JSON.stringify(d)) : d;
    const c = AUDIO_CLAMP[k];
    if (!c) return v;
    if (Array.isArray(c)) return clampNum(v, c[0], c[1], c[2]);
    if (c.one) return c.one.indexOf(v) >= 0 ? v : d;
    if (c.max) return String(v).slice(0, c.max);
    return v;
  };
  // clamp every audio key currently in CFG (after an import / paste)
  function clampAudioCfg() { try { for (const k of AUDIO_KEYS) CFG[k] = clampAudioKey(k, CFG[k]); } catch (e) {} }
  // one-shot schema migration for existing users (idempotent; runs before any
  // Web Audio capture so the chain never sees a pre-migration CFG)
  // pre-v2 settings (a stored config or an imported backup): widen → stereo width, and no
  // automatic level drop for boost-heavy EQs, so what they hear stays the same
  function migrateFrom(src) {
    try {
      if (!src || typeof src !== 'object' || (src.cfgVer | 0) >= 2) return;
      if ('widenAmt' in src) { const w = Math.max(0, Math.min(100, +src.widenAmt || 0)); CFG.stereoWidth = Math.round(100 + w * 0.9); }
      if (!('eqAutoPre' in src)) {
        const b = Array.isArray(src.eqBands) ? src.eqBands : [];
        if (src.eqOn && (Math.max(0, ...b.map(Number)) > 0 || (+src.eqPreamp || 0) > 0)) CFG.eqAutoPre = false;
      }
    } catch (e) {}
  }
  function migrateCfg() {
    try {
      const stored = GET('enh:cfg', null);
      // the version must come from what was STORED: CFG already carries the
      // DEFAULTS cfgVer, so reading it there would skip every existing user
      const ver = (stored && typeof stored === 'object') ? (stored.cfgVer | 0) : 2;
      if (ver >= 2) return;
      migrateFrom(stored);
      delete CFG.widenAmt; delete CFG.abLoop; delete CFG.rumbleOn;
      CFG.cfgVer = 2; save();
    } catch (e) {}
  }
  migrateCfg();
  // a correction switch that was left on without a profile did nothing but route the chain
  try { if (CFG.peqOn && !(Array.isArray(CFG.peq) && CFG.peq.length)) { CFG.peqOn = false; save(); } } catch (e) {}

  const activeMedia = () => {
    // SoundCloud plays through the Web Audio API with a DETACHED media element
    // that never enters the DOM. We capture that real element via
    // createMediaElementSource into `sceMediaEls`. Whichever set it lives in,
    // the PLAYING element wins; otherwise the freshest captured one, then any
    // in-DOM one — a paused promo <video> must never outrank the real player.
    let playing = null, captured = null, inDom = null;
    try { sceMediaEls.forEach((a) => { if (!a) return; captured = a; if (!playing && !a.paused && a.readyState > 0) playing = a; }); } catch (e) {}
    try { D.querySelectorAll('audio,video').forEach((a) => { if (!inDom) inDom = a; if (!playing && !a.paused && a.readyState > 0) playing = a; }); } catch (e) {}
    let m = playing || captured || inDom;
    return m;
  };

  /* ───────── page themes via a BACKDROP-FILTER overlay ─────────
   * CRITICAL: a `filter` on <html> (the old approach) breaks position:fixed —
   * it re-bases fixed elements to the full document, shoving our panels off
   * the bottom of the page (the "settings won't open" bug). Instead we lay a
   * transparent fixed overlay ABOVE SoundCloud but BELOW our own UI and put
   * the filter on its backdrop. No ancestor ever gets a filter, so fixed
   * positioning is never touched. */
  // tint themes use a backdrop-filter overlay; dark themes use REAL dark CSS
  // (proper dark surfaces + light text — not a colour inversion).
  const THEME_BD = {
    none: '', dim: 'brightness(.85)', dimmer: 'brightness(.7)',
    warm: 'sepia(.3) saturate(1.05) brightness(.97)', gray: 'grayscale(1)',
    contrast: 'contrast(1.18)',
    cool: 'hue-rotate(-12deg) saturate(1.1) brightness(.96)',
    vivid: 'saturate(1.45) contrast(1.06)',
    muted: 'saturate(.55) brightness(.99)',
    vintage: 'sepia(.5) contrast(1.08) brightness(.96) saturate(1.1)',
    rose: 'hue-rotate(-18deg) sepia(.22) saturate(1.15)',
    sunset: 'sepia(.35) hue-rotate(-20deg) saturate(1.3) brightness(.98)',
    forest: 'hue-rotate(35deg) saturate(.95) brightness(.96)',
    neon: 'saturate(1.6) contrast(1.05) brightness(1.02)',
    noir: 'grayscale(1) contrast(1.25) brightness(.92)',
    cyber: 'hue-rotate(-25deg) saturate(1.5) contrast(1.1)',
    pastel: 'saturate(.7) brightness(1.05)',
  };
  // real dark themes: { background, card surface, hover, text, subtext, border, accent }
  const DARK_THEMES = {
    dark:    { bg: '#16181c', card: '#1d2025', hov: '#23272e', tx: '#e7e7ec', sub: '#9a9aa2', bd: '#2b2f36' },
    amoled:  { bg: '#000000', card: '#0c0c0e', hov: '#161618', tx: '#ededf2', sub: '#8e8e96', bd: '#1d1d20' },
    midnight:{ bg: '#0f1420', card: '#161d2e', hov: '#1d2740', tx: '#e4e8f2', sub: '#94a0bd', bd: '#26304a' },
    dracula: { bg: '#282a36', card: '#2f3142', hov: '#383b4d', tx: '#f8f8f2', sub: '#a0a3b8', bd: '#3c3f52' },
    nord:    { bg: '#2e3440', card: '#353c4a', hov: '#3e4759', tx: '#eceff4', sub: '#9aa3b5', bd: '#434c5e' },
    ocean:   { bg: '#0d1b2a', card: '#14253a', hov: '#1c3149', tx: '#e0eaf5', sub: '#8aa0bd', bd: '#243b57' },
    gruvbox: { bg: '#282828', card: '#32302f', hov: '#3c3836', tx: '#ebdbb2', sub: '#a89984', bd: '#504945' },
    rosepine:{ bg: '#191724', card: '#1f1d2e', hov: '#26233a', tx: '#e0def4', sub: '#908caa', bd: '#2a2837' },
    solar:   { bg: '#002b36', card: '#073642', hov: '#0a4350', tx: '#eee8d5', sub: '#93a1a1', bd: '#0e4d5a' },
    coffee:  { bg: '#1c1410', card: '#261b14', hov: '#33251b', tx: '#efe4d8', sub: '#b39e8a', bd: '#3a2a1f' },
    slate:   { bg: '#1a1d23', card: '#22262e', hov: '#2a2f38', tx: '#e6e8ec', sub: '#9aa0ab', bd: '#2f343d' },
  };
  function darkCss(t) {
    // page + flat containers → page background (NOT cards — that's what made
    // those empty dark rectangles under each track)
    const surf = 'html,body,#app,.l-fluid,.l-fluid-fixed,.l-container,.l-main,.l-listen-wrapper,.l-listen-content,'
      + '.l-collection,.l-sidebar-right,.sidebar,.stream,.soundList,.tabHeader,.g-tabs,.lazyLoadingList,'
      + '.userInfoBar,.infoStats,.systemPlaylistDetails,.listenDetails,.fullHero,.l-trackList,.soundList__item,'
      + '.sound,.audibleTile,.searchItem,.badgeList__item,.trackList__item,.playableTile,.l-tabs-content';
    // elevated surfaces (popovers, modals, player bar, queue) — slightly raised
    const elev = '.header,.header__inner,.modal__modal,.dropdownMenu,.moreActions,.g-modal,.queue,.queue__panel,'
      + '.playControls,.commentsList,.dialog,.modal,.headerMenu,.l-header-menu';
    // SECONDARY text (usernames, stats) — emitted FIRST so the primary rule
    // below wins on any element that matches both (fixes dim titles bug)
    const sub = '.sc-text-secondary,.sc-text-light,.sc-text-grey,.soundTitle__username,.sound__username,'
      + '.userBadge__usernameLink,.commentItem__usernameLink,.queue__itemUser,.sc-ministats,.sc-ministats-item,'
      + '.playableTile__username,.sound__username a,.soundTitle__usernameTitle';
    // PRIMARY text (titles, headings) — emitted LAST so titles read bright
    const txt = '.sc-text-h1,.sc-text-h2,.sc-text-h3,.sc-text-h4,.sc-text-h5,.sc-text-body,.sc-text,'
      + '.sc-link-dark,.sc-link-medium,.soundTitle__title,.soundTitle__title a,.fullHero__title,.commentItem__message,.sc-type-light,.g-nav-item-a,'
      + '.profileHeaderInfo__userName,.userBadge__username,.playableTile__heading,.playableTile__heading a,.queue__itemTitle,.sound__title,.sound__title a,'
      + '.tabs__tabLink,.g-tabs-link,.header__link,.contentTitle,.trackItem__trackTitle,.soundBadge__title a';
    const inp = '.sc-input,.headerSearch__input,.textfield__input,input[type="text"],input[type="search"],textarea,.filterField__input';
    const bord = '.sc-border-light,.sc-border-light-top,.sc-border-light-bottom,.sc-border-light-left,.sc-border-light-right,.divider,.tabs__tabBorder';
    return [
      'html,body{background:' + t.bg + ' !important}',
      surf + '{background-color:' + t.bg + ' !important;background-image:none !important;color:' + t.tx + ' !important}',
      elev + '{background-color:' + t.card + ' !important;color:' + t.tx + ' !important}',
      sub + '{color:' + t.sub + ' !important}',
      txt + '{color:' + t.tx + ' !important}',
      inp + '{background:' + t.card + ' !important;color:' + t.tx + ' !important;border-color:' + t.bd + ' !important}',
      bord + '{border-color:' + t.bd + ' !important}',
      // clean hover on tiles — subtle lift, rounded
      '.soundList__item:hover,.audibleTile:hover,.searchItem:hover,.trackList__item:hover{background-color:' + t.hov + ' !important;border-radius:10px}',
      '.moreActions__button:hover,.dropdownMenu__item:hover,.linkMenu__link:hover{background-color:' + t.hov + ' !important}',
      // artwork: soft rounding + a hairline so it reads as a card on pure black
      '.sc-artwork,.image__full,.sound__coverArt .image,.fullHero__artwork{border-radius:8px !important;box-shadow:inset 0 0 0 1px ' + t.bd + ' !important}',
      // player bar
      '.playControls{border-top:1px solid ' + t.bd + ' !important}',
      '.playControls__elements,.playbackSoundBadge,.playbackSoundBadge__title,.playbackSoundBadge__titleLink{color:' + t.tx + ' !important}',
      '.playbackSoundBadge__lightLink{color:' + t.sub + ' !important}',
      // like / repost / follow / add / queue / share action buttons — kill the
      // light backgrounds & light hovers so they sit cleanly on the dark bar
      '.sc-button-like,.sc-button-repost,.sc-button-share,.sc-button-more,.sc-button-download,.sc-button-addtoset,.sc-button-follow,.addToNextUp,.playControls__queue,.playbackSoundBadge__queue,.playbackSoundBadge__follow,.systemPlaylistBadge__queue{background-color:transparent !important;color:' + t.tx + ' !important;border-color:' + t.bd + ' !important}',
      // LIKE heart must read its state in any theme: dim grey when NOT liked,
      // bright RED when liked (.sc-button-selected) — higher specificity than the
      // rule above so it wins; repost keeps its accent when active too
      '.sc-button-like:not(.sc-button-selected),.sc-button-like:not(.sc-button-selected) svg{color:' + t.sub + ' !important;fill:currentColor !important}',
      '.sc-button-like.sc-button-selected,.sc-button-like.sc-button-selected svg,.playbackSoundBadge__like.sc-button-selected svg{color:#ff2d4f !important;fill:#ff2d4f !important}',
      '.sc-button-repost.sc-button-selected,.sc-button-repost.sc-button-selected svg{color:#ff5500 !important;fill:#ff5500 !important}',
      '.sc-button-like:hover,.sc-button-repost:hover,.sc-button-share:hover,.sc-button-more:hover,.sc-button-follow:hover,.sc-button-download:hover,.sc-button-addtoset:hover,.addToNextUp:hover,.playControls__queue:hover,.sc-button-icon:hover{background-color:' + t.hov + ' !important}',
      // dropdown / overflow / "More" menus — panels + items (the Partner offers
      // / Tracks / Insights menu and friends)
      '.dropdownMenu,.dropdownMenu__list,.moreActions,.moreActions__list,.moreMenu,.g-menu,.headerMenu,.l-header-menu,.linkMenu,.linkMenu__list,.actionMenu,.actionsDropdown,[role="menu"],.queriesList{background-color:' + t.card + ' !important;color:' + t.tx + ' !important;border-color:' + t.bd + ' !important;box-shadow:0 8px 28px rgba(0,0,0,.5) !important}',
      '.moreActions__button,.dropdownMenu__item,.linkMenu__link,.headerMenu a,.l-header-menu a,[role="menuitem"],.menuItem,.g-menu-item a{color:' + t.tx + ' !important}',
      '[role="menuitem"]:hover,.menuItem:hover,.g-menu-item a:hover{background-color:' + t.hov + ' !important}',
      // track / listen page HERO — the big artwork-tinted banner behind the
      // title + waveform shows up light/coloured otherwise; force it dark and
      // kill the blurred-artwork background layer
      '.fullHero,.listenHero,.fullListenHero,.l-listen-hero,.l-listen-hero__inner,.sound__header,.soundHeader,.listenArtworkWrapper,.listenEngagement,.soundActions{background-color:' + t.bg + ' !important;background-image:none !important}',
      '.fullHero__background,.listenHero__background,[class*="Hero__background" i],[class*="heroBackground" i],[class*="hero__bg" i],[class*="Hero__bg" i]{background:' + t.bg + ' !important;background-image:none !important;filter:none !important;opacity:1 !important}',
      // comment composer / reply box + individual comments
      '.commentForm,.commentForm__input,.commentForm textarea,.composer,.commentInput,[class*="commentForm" i],[class*="commentComposer" i]{background-color:' + t.card + ' !important;color:' + t.tx + ' !important;border-color:' + t.bd + ' !important}',
      '.commentItem,.commentNode,.comment,.comment__body,.commentItem__message{background-color:transparent !important;color:' + t.tx + ' !important;border-color:' + t.bd + ' !important}',
      // player-control icon buttons (so they read on the dark bar)
      // ── PLAYER BAR (exact SoundCloud classes from the live DOM) ──
      '.playControls,.playControls__inner,.playControls__wrapper,.playControls__bg{background-color:' + t.card + ' !important;background-image:none !important}',
      // every control icon (prev/play/next/shuffle/repeat/volume/queue/cast) reads bright
      '.playControls__control,.skipControl,.shuffleControl,.repeatControl,.playControls__repeatIcon,.volume__button,.volume__speakerIcon,.playbackSoundBadge__showQueue,.playbackSoundBadge__showQueue svg,.playControls__prev,.playControls__next{color:' + t.tx + ' !important;fill:currentColor !important}',
      // BUT preserve SoundCloud's own "shuffle/repeat is ON" indicator: SC marks the
      // active state with .m-shuffling / .m-one / .m-all (and aria-pressed="true" on
      // newer DOM); without this re-paint the theme override above flattens on AND
      // off to the SAME theme text color, so the user can't tell either is engaged
      '.shuffleControl.m-shuffling,.shuffleControl[aria-pressed="true"],.repeatControl.m-one,.repeatControl.m-all,.repeatControl[aria-pressed="true"]{color:var(--sce-acc,#ff5500) !important;fill:var(--sce-acc,#ff5500) !important}',
      '.shuffleControl.m-shuffling svg,.shuffleControl[aria-pressed="true"] svg,.repeatControl.m-one svg,.repeatControl.m-all svg,.repeatControl[aria-pressed="true"] svg{color:var(--sce-acc,#ff5500) !important;fill:currentColor !important}',
      // FLATTEN the grey secondary-button backgrounds on every bar button (these
      // are the un-themed boxes around prev/next/shuffle/repeat/like/follow/queue);
      // the white play button (.sc-button-play) is intentionally left alone
      '.playControls .sc-button-secondary,.playControls .sc-button-icon,.playbackSoundBadge__actions .sc-button{background-color:transparent !important;box-shadow:none !important;border-color:transparent !important}',
      '.playControls .sc-button-secondary:hover,.playControls .sc-button-icon:hover,.playbackSoundBadge__actions .sc-button:hover{background-color:' + t.hov + ' !important}',
      // the little queue-count dot can render as a stray box — keep it subtle
      '.playbackSoundBadge__queueCircle{background-color:transparent !important;box-shadow:none !important}',
      // scrubber + volume rails
      '.playbackTimeline__timePassed,.playbackTimeline__duration{color:' + t.tx + ' !important}',
      '.playbackTimeline__progressBackground,.volume__sliderBackground{background-color:' + t.bd + ' !important}',
      // the leftover dark-grey upsell panel that sits under the bar
      '.playControlsPanel,.playControls__panel,.sc-background-darkgrey{background-color:' + t.bg + ' !important;color:' + t.tx + ' !important}',
      // ── the "Next up" queue flyout: chrome + rows, and KILL the empty-queue
      // skeleton background that renders as a giant dark box (the "bug") ──
      '.queue,.queue__panel{background-color:' + t.card + ' !important}',
      '.queue__title{color:' + t.tx + ' !important;background-color:transparent !important}',
      '.queue__clear,.queue__hide{color:' + t.tx + ' !important;background-color:transparent !important}',
      '.queue__clear:hover,.queue__hide:hover{background-color:' + t.hov + ' !important}',
      '.queue__scrollable,.queue__scrollableInner,.queue__itemsHeight,.queue__itemsContainer{background:none !important;background-image:none !important}',
      '.queue__itemWrapper,.queue__item,.queueItemView,.queueItemView__content,.queue__fallback{background-color:' + t.card + ' !important;color:' + t.tx + ' !important;border-color:' + t.bd + ' !important}',
      '.queue__itemWrapper:hover,.queue__item:hover{background-color:' + t.hov + ' !important}',
      // search autocomplete dropdown
      '.headerSearch__results,.search__results,.autocomplete,.autocomplete__results,[class*="searchResults" i],[class*="autocomplete" i]{background:' + t.card + ' !important;border-color:' + t.bd + ' !important;color:' + t.tx + ' !important}',
      // floating overlays: tooltips, popovers & context menus
      '.tooltip,[role="tooltip"],.sc-tooltip,[class*="tooltip" i],[class*="popover" i],[class*="contextMenu" i],[class*="context-menu" i]{background:' + t.card + ' !important;color:' + t.tx + ' !important;border-color:' + t.bd + ' !important}',
      // notification panel / messages list (panel only, never the badge dot)
      '.notificationList,.notificationsList,[class*="notificationList" i],[class*="notificationItem" i],.conversationsList,.messageList{background-color:' + t.card + ' !important;color:' + t.tx + ' !important;border-color:' + t.bd + ' !important}',
      // modals / dialogs / sheets (content, not the dimmed backdrop)
      '.modal__modal,.dialog,.g-modal,.modal__content,.dialog__content,.sheet__content,.commentsModal,.shareModal,.addToPlaylist,.createPlaylist{background-color:' + t.card + ' !important;color:' + t.tx + ' !important;border-color:' + t.bd + ' !important}',
      // form controls on settings / upload pages
      'select,.sc-classic-select,.dropdown__button,.sc-checkbox,.checkbox__input,.formElement input,.formElement textarea{background-color:' + t.card + ' !important;color:' + t.tx + ' !important;border-color:' + t.bd + ' !important}',
      // header underline + search
      '.header{box-shadow:0 1px 0 ' + t.bd + ' !important}',
      // scrollbars
      '::-webkit-scrollbar-thumb{background:' + t.bd + ' !important;border-radius:7px}::-webkit-scrollbar-track{background:transparent}',
      // hide the leftover Pro / distribution / "100% royalties" promo banners
      // for a clean top — upsell-scoped so it never touches real content
      (CFG.hideUpsell ? '.upsellBanner,[class*="upsell" i],[class*="distributionBanner" i],[class*="distribution" i][class*="anner" i],[class*="creatorSubscription" i],[class*="nextPro" i],[class*="goPlus" i],[class*="royalt" i],[class*="monetiz" i],.l-banner-promo,.newFeatureBanner,[data-testid*="upsell" i],[data-testid*="banner" i][data-testid*="promo" i],.l-product-banners .banner.m-promotion,.l-product-banners:not(:has(.banner:not(.m-promotion))){display:none !important}' : ''),   // follows the Hide Go+ upsells toggle; .m-promotion is the 2026 Go+ banner
      // ── FIX (real classes from the live DOM): the timed-comment popover over the
      //    waveform (.commentPopover…) is a FULL-WIDTH overlay; the generic
      //    [class*="popover"] rule above painted its layers near-black and buried the
      //    wave. Force the whole subtree transparent — transparent can NEVER cover the
      //    waveform — so SC's comment renders natively over the bars. (Emitted last so
      //    it wins the same-specificity tie with the popover rule.)
      '.commentPopover,.commentPopover__scrub,.commentPopover__playableArea,.commentPopover__wrapper,.commentPopover__avatar,.commentPopover__username,.commentPopover__body,[class*="commentPopover" i]{background-color:transparent !important;background-image:none !important;box-shadow:none !important;border:0 !important}',
      // related-tracks list container renders pure-black; align it to the theme bg
      '.soundBadgeList{background-color:' + t.bg + ' !important;background-image:none !important}',
    ].join('');
  }
  // night window for auto-dark: 19:00 → 07:00 local
  function nightNow() {
    try { const h = new Date().getHours(); return h >= 19 || h < 7; } catch (e) { return false; }
  }
  // the theme that should actually render right now — auto-dark, when enabled,
  // takes over (dark theme at night, light by day); otherwise the chosen theme
  function effTheme() {
    try { if (CFG.autoDark) return nightNow() ? (CFG.autoDarkTheme || 'dark') : 'none'; } catch (e) {}
    return CFG.theme;
  }
  let themeOv = null;
  function applyTheme() {
    try {
      const bd = THEME_BD[effTheme()] || '';
      if (!bd) { if (themeOv) themeOv.style.display = 'none'; return; }
      if (!themeOv || !themeOv.isConnected) {
        themeOv = D.createElement('div');
        themeOv.id = 'sce-theme';
        // z below our suite UI (~2.147e9) but far above any SoundCloud z-index
        themeOv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2000000000';
        (D.body || D.documentElement).appendChild(themeOv);
      }
      themeOv.style.display = '';
      themeOv.style.backdropFilter = bd;
      themeOv.style.webkitBackdropFilter = bd;
    } catch (e) {}
  }
  const ACCENTS = { red: '#ff2d2d', pink: '#ff3d9a', purple: '#9b5cff', blue: '#2d8cff', cyan: '#13c4d6', green: '#23c552', gold: '#ffb400' };
  function buildCss() {
    let css = '';
    // ── tighten the player-bar right cluster (applies in every theme) so the
    // track title, like/follow/queue actions and our pill don't look so spread
    // out with big awkward gaps ──
    css += '.playbackSoundBadge__titleContextContainer{margin-right:10px !important}'
      + '.playbackSoundBadge__actions{margin-left:2px !important}'
      + '.playbackSoundBadge__actions .sc-button{margin-right:3px !important}';
    const TH = effTheme();   // resolves auto-dark → the theme that should render now
    if (DARK_THEMES[TH]) css += darkCss(DARK_THEMES[TH]);   // real dark theme (not an invert)
    else if (TH === 'custom' && CFG.customTheme) css += darkCss(CFG.customTheme);   // your custom palette
    // accent recolour — SoundCloud's orange CTA buttons & primary text/links.
    // Best-effort (the canvas waveform can't be CSS-recoloured); fail-safe.
    if (CFG.accent !== 'default' && (ACCENTS[CFG.accent] || CFG.accent === 'custom')) {
      const a = CFG.accent === 'custom' ? (/^#[0-9a-f]{6}$/i.test(CFG.customAccent || '') ? CFG.customAccent : '#ff5500') : ACCENTS[CFG.accent];
      // publish the chosen accent as a CSS variable so other Suite rules (e.g.
      // the SC shuffle/repeat orange-on indicator at the dark-theme block) can
      // honor a custom accent instead of hardcoding SoundCloud-orange.
      css += ':root{--sce-acc:' + a + '}';
      css += '.sc-button-cta,.sc-button-play.sc-button-selected,.g-promoted,'
        + 'button.sc-button-cta,a.sc-button-cta{background-color:' + a + ' !important;border-color:' + a + ' !important}'
        + '.sc-text-orange,.sc-text-primary,[class*="-orange"]{color:' + a + ' !important}'
        + '.playControls__play:hover{color:' + a + ' !important}';
    }
    if (CFG.hideUpsell) css += '.upsell,.upsellHeader,[class*="upsell" i],[class*="goPlus" i],[class*="go-plus" i],.playControls__upsell,.header__upsell,.l-upsell,.upgradeButton,.go-plus-upsell,.l-product-banners .banner.m-promotion,.l-product-banners:not(:has(.banner:not(.m-promotion))){display:none !important}';
    if (CFG.hidePromoted) css += '[class*="promoted" i],[class*="sponsored" i],.promotedTrack{display:none !important}';
    if (CFG.hideComments) css += '.commentNode,.waveform__layer.commentsLayer,.commentForm{display:none !important}';
    if (CFG.grayArt) css += '.sc-artwork,.image__full{filter:grayscale(1);transition:filter .25s}.sc-artwork:hover,.listenArtworkWrapper:hover .sc-artwork{filter:none !important}';
    if (CFG.dimSidebar) css += '.l-sidebar-right,.sidebar{opacity:.55;transition:opacity .2s}.l-sidebar-right:hover,.sidebar:hover{opacity:1}';
    if (CFG.bigPlay) css += '.playControls__play{transform:scale(1.18)}';
    if (CFG.fontScale !== 100) css += 'html{font-size:' + Math.min(120, Math.max(85, CFG.fontScale | 0)) + '% !important}';
    // ── declutter ──
    if (CFG.hideUpload) css += '.header__upsell,a.uploadButton,.header__moreMenu .uploadButton,.uploadButton{display:none !important}';
    if (CFG.hideStories) css += '[class*="stories" i],.uploadYourFirst{display:none !important}';
    if (CFG.hidePlayCounts) css += '.sc-ministats-plays,.sound__soundStats .sc-ministats-item,.playbackSoundBadge__sliderProgress~.sc-ministats{display:none !important}';
    if (CFG.hideRelated) css += '.relatedTracks,.l-related,[class*="related" i].l-listenable-content{display:none !important}';
    if (CFG.hideCommentSection) css += '.comments,.commentsList,.commentsSection{display:none !important}';
    if (CFG.hideAppBanner) css += '.mobileAppBanner,[class*="appBanner" i],.smartBanner,.l-mobile-app-banner,#onetrust-banner-sdk{display:none !important}';
    if (CFG.squareArt) css += '.sc-artwork,.image__rounded,.sound__artwork .image{border-radius:4px !important}';
    if (CFG.thinScroll) css += '::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:rgba(128,128,128,.45);border-radius:6px}::-webkit-scrollbar-track{background:transparent}';
    if (CFG.focusMode) css += '.l-sidebar-right,.sidebar,.l-fluid-fixed .l-sidebar-right{display:none !important}.l-main .l-fluid-fixed .l-middle-fixed,.l-main{max-width:100% !important}';
    if (CFG.maxWidth) css += '.l-container.l-fluid,.l-container{max-width:1100px !important;margin:0 auto !important}';
    if (CFG.hideReposts) css += '.soundList__item .sound.streamContext-repost,.repostItem,[class*="repost" i].streamContext{display:none !important}';
    if (CFG.hidePlaylistsFeed) css += '.soundList__item:has(.playlist),.soundList__item:has(.systemPlaylistBadge),.stream__list .playlist{display:none !important}';
    if (CFG.compactFeed) css += '.soundList__item{padding-top:7px !important;padding-bottom:7px !important}.sound__body,.soundContext{padding-top:4px !important;padding-bottom:4px !important}';
    if (CFG.biggerWave) css += '.waveform,.waveform__layer{height:160px !important}.listenEngagement,.waveform canvas{height:160px !important}';
    if (CFG.hideFollowFeed) css += '.userBadgeListItem.suggestion,.suggestedUsers,.recommendedUsers,[class*="whoToFollow" i],[class*="suggestedFollow" i]{display:none !important}';
    // data-driven feature table (each entry isolated & fail-safe)
    for (const f of MORE) {
      if (!CFG[f[0]]) continue;
      css += (f[3] === 'hide') ? (f[4] + '{display:none !important}') : f[4];
    }
    if (CFG.customCss) css += '\n/* your CSS */\n' + CFG.customCss;
    return css;
  }
  let styleEl = null;
  function applyCss() {
    try {
      if (!styleEl || !styleEl.isConnected) {
        styleEl = D.createElement('style'); styleEl.id = 'sce-style';
        (D.head || D.documentElement).appendChild(styleEl);
      }
      styleEl.textContent = buildCss();
      applyTheme();
    } catch (e) {}
  }

  /* ───────── behavioural features (guarded, enforced on a slow tick) ───────── */
  const VOL_KEY = 'enh:vol';
  let mutedVol = null;   // the level M muted from (null = not muted); the 1 Hz volume memory skips saves while set
  let lastVolSaved = 0;
  // playback speed — SoundCloud plays through the WEB AUDIO API with NO <audio>
  // element in the page DOM (the console diagnostic showed querySelectorAll
  // returns 0). So plain playbackRate has nothing to drive. Instead we CAPTURE
  // the audio at the Web Audio layer — the (often detached) media element that
  // SoundCloud routes through createMediaElementSource, plus any new Audio() it
  // makes, plus raw AudioBufferSourceNodes — and set THEIR rate.
  function wantedRate() { return Math.min(2, Math.max(0.5, (CFG.speed | 0) / 100 || 1)); }
  const sceMediaEls = new Set();   // captured <audio>/<video>, even if never added to the DOM
  const sceBufNodes = new Set();   // captured AudioBufferSourceNodes
  let sceLastCtx = null;           // the AudioContext SoundCloud routes through (for output-latency)
  let sceLatMs = 0;                // smoothed output latency (ms) — avoids per-frame jitter
  function captureMedia(m) {
    try {
      if (!m || (m.tagName !== 'AUDIO' && m.tagName !== 'VIDEO') || sceMediaEls.has(m)) return;
      sceMediaEls.add(m);
      // capture hygiene (2.31): keep the set bounded — once past eight, drop one paused element
      // (its listeners stay; the element is garbage as soon as SoundCloud lets go of it)
      if (sceMediaEls.size > 8) { for (const x of sceMediaEls) { if (x !== m && x.paused) { sceMediaEls.delete(x); break; } } }
      // listeners are registered ONCE per element: a pruned element the 1 Hz DOM scan re-captures
      // only rejoins the set, so the bound can never turn into a re-registration loop
      if (m.__sceCap) return;
      m.__sceCap = true;
      const re = () => { try { const w = wantedRate(); if (Math.abs((m.playbackRate || 1) - w) > 0.01) m.playbackRate = w; } catch (e) {} try { fadeCtl.onRate(m); } catch (e) {} };
      m.addEventListener('ratechange', re); m.addEventListener('play', re);
      m.addEventListener('playing', re); m.addEventListener('loadeddata', re);
      m.addEventListener('playing', () => { try { restoreTrackLoud(); } catch (e) {} });   // loudness memory: a track that starts (no-op while loudness is off)
      m.addEventListener('playing', () => { try { offerResume(m); } catch (e) {} });   // long tracks: offer to resume when one starts from the top
      m.addEventListener('ended', () => { try { resumeForget(curTrackHref()); } catch (e) {} });
      // A–B (2.28): a seek, a rate change or a (re)start moves the wrap point — re-aim the timer
      const abRe = () => { try { if (abOn) armAb(); } catch (e) {} };
      m.addEventListener('ratechange', abRe); m.addEventListener('seeking', abRe); m.addEventListener('play', abRe);
      syncPitch(m);
      // fades (2.21) are event-driven: `play` arms, `playing` fades in, `timeupdate` schedules the
      // fade-out, `seeking` clears it; pause / ended only track the element's state
      try {
        m.addEventListener('play', () => { try { fadeCtl.onPlay(m); } catch (e) {} });
        m.addEventListener('playing', () => { try { fadeCtl.onPlaying(m); } catch (e) {} });
        m.addEventListener('timeupdate', () => { try { fadeCtl.onTimeUpdate(m); } catch (e) {} });
        m.addEventListener('seeking', () => { try { fadeCtl.onSeeking(m); } catch (e) {} });
        m.addEventListener('pause', () => { try { fadeCtl.onPause(m); } catch (e) {} });
        m.addEventListener('ended', () => { try { fadeCtl.onEnded(m); } catch (e) {} });
      } catch (e) {}
    } catch (e) {}
  }
  // pitch follows speed (2.20): preservesPitch is the element's, so it is written here (capture, every
  // applySpeed, every applyFx) rather than in the chain. `true` = the old hard-coded behaviour.
  function syncPitch(m) {
    try {
      const pp = !CFG.vinylMode;
      if (m.preservesPitch !== pp) m.preservesPitch = pp;
      if ('mozPreservesPitch' in m && m.mozPreservesPitch !== pp) m.mozPreservesPitch = pp;
      if ('webkitPreservesPitch' in m && m.webkitPreservesPitch !== pp) m.webkitPreservesPitch = pp;
    } catch (e) {}
  }
  function applySpeed() {
    try {
      const want = wantedRate();
      try { D.querySelectorAll('audio,video').forEach((m) => captureMedia(m)); } catch (e) {}
      sceMediaEls.forEach((m) => { try { if (Math.abs((m.playbackRate || 1) - want) > 0.01) m.playbackRate = want; } catch (e) {} syncPitch(m); });
      // raw buffer sources: only real tracks (> 30 s) follow the speed — UI blips and previews stay put (2.31)
      if (sceBufNodes.size) sceBufNodes.forEach((n) => { try { if (n.playbackRate && n.buffer && n.buffer.duration > 30 && n.playbackRate.value !== want) n.playbackRate.value = want; } catch (e) {} });
    } catch (e) {}
  }
  /* ───────── Audio FX (EXPERIMENTAL) — EQ · loudness · fade ─────────
   * We already capture SoundCloud's source node via createMediaElementSource.
   * Here we OPTIONALLY splice a suite-owned chain (preamp → 10-band EQ → analyser → makeup
   * gain → fade gain) between that source and wherever SC connected it. DEFAULT
   * OFF and a perfect passthrough when off: with no effect enabled the source is
   * wired straight to its real destination and the chain is detached, so toggling
   * everything off instantly restores native playback. We override connect/
   * disconnect ONLY on SC's own captured source node — never the global AudioNode
   * prototype — so nothing else on the page is affected. Every step is guarded;
   * any failure falls back to the original connect. */
  const sceFx = new Set();   // { ctx, src, chain, dests, reroute }
  let fxRouted = false, audioTabOn = false, fxBypass = false;
  let sleepFadeOn = false;   // a sleep-timer fade is riding output.gain (WP10): applyFx must not reset it
  let paintCmp = null;     // set by audioRender (the Compare button's painter); null until the tab has rendered
  let loudTimer = 0;       // the loudness measurement interval (started/stopped by applyFx)
  const meter = {};        // live meter values { m, s, i, peak, outDb, gainDb, gr, limGr, corr, monoSrc } — filled by the meter loops
  let monoSince = 0, monoLow = 0;   // WP10 mono-upload guard: when r first read > 0.98 with the vocal band in use · consecutive low reads
  // Loudness-normalize measurement state (2.4 / 2.5), one track at a time: the gated K-weighted
  // blocks (400 ms each, from the SOURCE taps), the integrated value, the source peak, the gain
  // the makeup node was last told (dB) and where it came from ('' measuring · 'measured' · 'remembered')
  const lnorm = { href: null, blocks: [], recent: [], trackPeak: 0, curGainDb: 0, nodeDb: 0, lint: NaN, dur: NaN, measuring: true, src: '', pending: false, lastWrite: 0, tgKey: '' };
  let lastLoudUrl = null;  // the href the loudness state belongs to (mirrors lastSpeedUrl)
  let lastHeadroomDb = 0;  // the auto-headroom applyFx last took off the pre-amp (dB, ≥ 0) — shown in the Pre-amp value
  let eqCurveVer = 0;      // bumped by applyFx whenever anything that shapes the composite curve changed (the canvas redraws on it)
  let contourK = 0;        // loudness-contour depth 0..1 from SoundCloud's volume slider (driven by the enforce tick)
  let contourAppliedK = 0; // contourK as of the last applyFx — the headroom re-runs once k·amt has moved > 0.5 dB
  let listenSig = null;    // the five keys a Listening-on profile set, as applyFx last saw them; drift un-lights the chip (2.13)
  // the biquad corners the bands actually use: the 31 Hz / 16 kHz labels stay, but a
  // lowshelf AT 31 Hz gives the 31 Hz label only half its gain and a highshelf at 16 kHz
  // sits above the codec's passband (2.26)
  const EQ_NODE_FREQS = [48, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 11000];
  // 160 log-spaced probe frequencies, 20 Hz – 20 kHz: the composite curve + auto-headroom
  const PROBE_N = 160;
  const PROBE_FREQS = (() => { const a = new Float32Array(PROBE_N); for (let i = 0; i < PROBE_N; i++) a[i] = 20 * Math.pow(1000, i / (PROBE_N - 1)); return a; })();
  const _probeMag = new Float32Array(PROBE_N), _probePh = new Float32Array(PROBE_N);
  // crossfeed feed levels (LF cross level below direct, the bs2b convention): f = r/(1+r), r = 10^(−dB/20)
  const CF_FEED_DB = { subtle: 9.5, natural: 6, strong: 4.5 };   // bs2b "Meier" / "Chu Moy" / default
  const cfFeed = (mode) => { const db = CF_FEED_DB[mode] == null ? CF_FEED_DB.natural : CF_FEED_DB[mode]; const r = Math.pow(10, -db / 20); return r / (1 + r); };
  // compressor auto-makeup calibration cache: key 'thr|knee|ratio' → { db, exact }
  const _calib = new Map(), _calibWanted = new Set();
  // the one AudioParam writer for everything audible: a short linear ramp so
  // toggles never click; linear ramps arrive exactly, so inert values are exact
  function ramp(p, v, t, s) {
    try { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(v, t + (s || 0.03)); }
    catch (e) { try { p.value = v; } catch (e2) {} }
  }
  // what the chain adds on top of the device latency, in ms. Chromium's
  // DynamicsCompressor has a fixed pre-delay of floor(0.006·sr) frames (≈ 6 ms at
  // every rate) even at ratio 1; the chain carries two stages of it (the comp ‖ bank
  // crossfade, then the clip guard) → 12 ms whenever routed. The WaveShapers' 4×
  // oversampling adds 192 samples while Enhance is on (Compare leaves oversample
  // alone, so key on CFG.enhanceOn only).
  function fxLatencyMs() {
    if (!fxRouted) return 0;
    const sr = (sceLastCtx && sceLastCtx.sampleRate) || 48000;
    return 12 + (CFG.enhanceOn ? Math.round(192000 / sr) : 0);
  }
  // Compare: a parameter-level bypass (routing stays, so no click and the
  // spectrum keeps running). Live state only — never persisted.
  function setBypass(v) {
    v = !!v;
    if (v === fxBypass) { try { if (paintCmp) paintCmp(v); } catch (e) {} return; }
    fxBypass = v;
    try { applyFx(); } catch (e) {}
    try { if (paintCmp) paintCmp(v); } catch (e) {}
  }
  // a held Compare whose keyup/pointerup was lost (Alt-Tab, screenshot key, the
  // hub closing) must never leave the player on the original
  try { W.addEventListener('blur', () => { try { setBypass(false); } catch (e) {} }); } catch (e) {}
  try { D.addEventListener('visibilitychange', () => { try { if (D.hidden) setBypass(false); } catch (e) {} }); } catch (e) {}
  // the Audio tab routes the (transparent) chain so the spectrum analyser gets a
  // live signal even before any effect is actually enabled
  function fxUserOn() {
    return !!(CFG.eqOn || CFG.loudnessOn || CFG.fadeOn || CFG.enhanceOn || CFG.peqOn || CFG.nightOn || CFG.loudCompOn
      || CFG.crossfeedOn || CFG.monoOn || CFG.swapLR
      || (CFG.stereoWidth | 0) !== 100 || (+CFG.balance || 0) !== 0 || (+CFG.vocalAmt || 0) !== 0
      || (+CFG.tiltDb || 0) !== 0 || (+CFG.bassDb || 0) !== 0 || (+CFG.bassHarm || 0) > 0 || (+CFG.reverbAmt || 0) > 0 || (CFG.boostAmt | 0) > 100 || CFG.skipSilence);   // the trim listens through the source taps
  }
  function fxOn() { return fxUserOn() || audioTabOn; }
  const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const EQ_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
  // built-in presets: tonal shapes first, then genres (bands at EQ_FREQS, dB)
  const EQ_PRESETS = {
    'Flat': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'Bass boost': [7, 6, 4, 2, 0, 0, 0, 0, 0, 0],
    'Bass cut': [-8, -6, -3, -1, 0, 0, 0, 0, 0, 0],
    'Bass reducer': [-6, -5, -3, -1, 0, 0, 0, 0, 0, 0],
    'Treble boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
    'Soft highs': [0, 0, 0, 0, 0, 0, -1, -4, -2, -2],
    'Loudness curve': [6, 4, 2, 0, -1, -1, 0, 2, 4, 6],
    'Small speakers': [-4, -2, 1, 3, 3, 2, 1, 1, 0, -1],
    'Late night': [-4, -3, -1, 1, 2, 2, 1, 0, -2, -4],
    'Vocal': [-3, -2, 0, 2, 4, 4, 3, 1, 0, -1],
    'Podcast': [-8, -6, 0, 3, 4, 4, 3, 1, -2, -4],
    'Rock': [5, 3, 2, 0, -1, 0, 2, 3, 4, 4],
    'Pop': [-1, 0, 2, 3, 3, 2, 0, -1, -1, -1],
    'Electronic': [5, 4, 1, 0, -2, 1, 1, 2, 4, 5],
    'Dance': [5, 4, 2, 0, 0, -2, -2, 0, 3, 4],
    'Hip-hop': [6, 5, 3, 2, 1, -1, 0, 1, 2, 3],
    'R&B': [3, 5, 4, 1, -1, -1, 1, 2, 3, 3],
    'Deep': [4, 3, 1, 1, 2, 2, 1, -1, -3, -4],
    'Jazz': [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
    'Classical': [0, 0, 0, 0, 0, 0, -2, -3, -3, -4],
    'Piano': [2, 1, 0, 2, 3, 1, 2, 3, 2, 1],
    'Acoustic': [4, 3, 2, 1, 1, 1, 2, 3, 3, 2],
    'Lo-fi': [4, 3, 1, 0, 0, -2, -5, -8, -11, -12],
  };
  // K-weighting (the ITU-R BS.1770 pre-filter + RLB high-pass) derived for any sample
  // rate by the bilinear method libebur128 uses — reproduces the 48 kHz table exactly
  function kCoeffs(fs) {
    const G = 3.999843853973347;
    let f0 = 1681.974450955533, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    const pb = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0];
    const pa = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
    f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
    const rb = [1, -2, 1], d = 1 + K / Q + K * K;
    const ra = [1, 2 * (K * K - 1) / d, (1 - K / Q + K * K) / d];
    const mul = (x, y) => { const r = new Array(x.length + y.length - 1).fill(0); for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) r[i + j] += x[i] * y[j]; return r; };
    return { b: mul(pb, rb), a: mul(pa, ra) };
  }
  /* The chain (spec §3). Every stage is an exact identity at its default, so with
   * nothing enabled the routed chain is a passthrough (plus the two compressors'
   * fixed 6 ms pre-delay); the chain is detached entirely when fxOn() is false.
   *   input → [taps] → preamp → rumble → tiltLo/Hi → lcLo/Hi → bands[10] → peq[10] → bass →
   *   Enhance (pre → sub/warm/mud/pres/air → shaper ‖ exciter → sum) → (comp ‖ 3-band bank) →
   *   compTrim → M/S (width + vocal band) → crossfeed → matrix → analyser → makeup → boost →
   *   (lim ‖ true-peak limiter) → limTrim → [tap] → output
   * Highpass/lowpass biquads cannot be made inert by parameters, so they are either
   * swapped to `peaking` 0 dB (rumble) or live only on paths whose gain is 0. */
  // The clip guard's true-peak leg: a brick-wall limiter as a Blob-URL AudioWorklet (the
  // extension ships no web-accessible files; soundcloud.com serves no CSP, and load() answers
  // false instead of throwing if that ever changes, leaving the compressor leg in charge).
  // TP_LIMITER = { source, load, create }.
  //
  //   await TP_LIMITER.load(ctx)      → true | false (never throws; one addModule per context)
  //   const lim = TP_LIMITER.create(ctx)   → AudioWorkletNode or null (if not loaded)
  //   lim.parameters.get('ceiling').value = -1     // dBTP  (default -1, range -40..0)
  //   lim.parameters.get('release').value = 0.08   // s     (default 0.08, range 0.005..2)
  //   lim.parameters.get('bypass').value  = 1      // 1 = delayed dry signal, unchanged
  //   lim.latencySamples / lim.latencyMs           // look-ahead delay (5 ms, rounded to samples)
  //   lim.gainReduction                            // dB of reduction (>= 0), refreshed <= 10×/s
  //   lim.port 'message' events: { gr: <dB of reduction, >= 0> }, at most 10 per second
  //
  // Processor design (sce-tp-limiter), per sample n, per channel c (stereo-linked gain):
  //   ring[n]   = x[n]                        delay line; also the T=16-sample FIR history
  //   tp[n]     = max_c( |x[n-8]|, |ph0..ph3| ), ph_p = Σ_i H[p][i]·x[n-i]: the 4× over-sampled
  //               inter-sample values between x[n-8] and x[n-7] (polyphase windowed-sinc, see H)
  //   tg[n]     = tp > C ? C / tp : 1         target gain, C = 10^(ceiling/20)
  //   gmin[n]   = min( tg[n-W+1 .. n] )       sliding-window minimum (monotonic deque, O(1))
  //   grel[n]   = min( gmin[n], grel[n-1] + (1 - grel[n-1])·α )   exponential release,
  //               α = 1 - exp(-1 / (τ·fs)),  τ = release · (1 + 3·min(1, hold/0.3 s))
  //               (program-dependent: τ stretches from 1× to 4× while gain reduction has been
  //                continuously active for up to 300 ms; `hold` decays 4× faster once recovered)
  //   g[n]      = mean( grel[n-A+1 .. n] )    box average → linear attack ramp of A samples
  //   y[n]      = ring[n-D] · g[n]            D = round(0.005·fs) (look-ahead = latency),
  //                                           A = D - 16 (ramp), W = D + 1 (min window)
  // Guarantee: every grel that enters the average of g[n] is ≤ tg[j] for all j in
  // [n-D, n-D+16], i.e. the gain applied to the delayed sample x[n-D] is never above
  // C / (detector peak anywhere in x[n-D-8 .. n-D+9)). The sample peak is part of tp, so output
  // samples never exceed C either. Residual: gain changes inside a downstream meter's own
  // interpolator span (second-order; measured ≤ 0.1 dB, see tp-limiter-test.js).
  // Exactness: when no sample within the FIR span exceeds C / ‖H‖₁ the FIR is skipped and
  // tg = 1; when nothing in the box window is < 1 the gain is exactly 1 (and the running sum
  // is re-anchored, so no float drift). A -20 dBFS signal therefore passes bit-exactly.
  // Channels: 1 or 2 input channels (mono is duplicated to both outputs); with no input the
  // delay line is flushed and the node then idles (silence, no per-sample work).
  // Cost per sample: ≤ 16 ring reads + 64 MACs per channel + ~20 scalar ops; the FIR only runs
  // while the signal is within ‖H‖₁ (≈ 6 dB) of the ceiling. Measured (OfflineAudioContext
  // render time as a proxy, 60 s of dense stereo noise at 48 kHz, Chromium 141): 0.79 % of real
  // time while limiting (0.61 % net of the graph baseline), 0.39 % (0.20 % net) below threshold.
  // Meter dependence (honest numbers from tp-limiter-test.js): the ceiling holds within 0.1 dB
  // on the ITU-R BS.1770 4× meter, an ideal 4× interpolator and the sample peak for material
  // band-limited to ≤ 20 kHz and for square waves ≤ 3 kHz; full-band white noise or naive
  // 5–7 kHz squares (energy at Nyquist, where any 4× meter under-reads) can read up to ≈ 0.4 dB
  // higher on an ideal interpolator while the BS.1770 meter still shows ≤ the ceiling.
  const TP_LIMITER = {
    name: 'sce-tp-limiter',
    lookaheadSec: 0.005,
    lastError: null,

    // AudioWorkletProcessor code, loaded via a Blob URL (no web-accessible files needed).
    source: `'use strict';
  // Detector FIR H: 4× polyphase interpolator derived here (no table to trust):
  //   prototype h[k] = sinc((k - c)/4) · Kaiser(β = 5),  k = 0..4T-1,  T = 16 taps per phase,
  //   c = (4T-1)/2 = 31.5 quarter-samples;  phase p, tap i = h[4i + p] multiplies x[n-i];
  //   each phase is normalised to Σ taps = 10^(0.1/20) (unity DC gain, +0.1 dB calibration).
  // Response: flat within 0.02 dB to 15 kHz, -0.2 dB at 20 kHz (48 kHz rate), ≈ -33 dB stop band.
  // The four phases at step n sit at n - 7.875, -7.625, -7.375, -7.125, i.e. between x[n-8] and
  // x[n-7]; |x[n-8]| is added so the sample peak is always covered.
  // Why not the raw ITU-R BS.1770-4 Annex 2 table: its phases 1-2 sum to 0.973 (-0.24 dB), so it
  // under-reads mid-phase inter-sample peaks; an ideal interpolator read a BS.1770-limited output
  // +0.14..0.21 dB over the ceiling. With this filter and the +0.1 dB calibration both the standard
  // BS.1770 4× meter and an ideal (64-tap Kaiser β=10) 4× interpolator stay within 0.1 dB of the
  // ceiling on band-limited material (≤ 20 kHz) and on square waves ≤ 3 kHz (see tp-limiter-test.js).
  var T = 16, DET_GAIN_DB = 0.1, KAISER_BETA = 5;
  function I0(x) { var s = 1, t = 1, k; for (k = 1; k < 80; k++) { t *= (x / 2 / k) * (x / 2 / k); s += t; } return s; }
  function deriveH() {
    var N4 = 4 * T, c = (N4 - 1) / 2, g = Math.pow(10, DET_GAIN_DB / 20), i0b = I0(KAISER_BETA);
    var h = new Float64Array(N4), k, r, t, x, p, i, ph, s, out = [];
    for (k = 0; k < N4; k++) {
      r = 2 * k / (N4 - 1) - 1; t = (k - c) / 4; x = Math.PI * t;
      h[k] = (Math.abs(t) < 1e-9 ? 1 : Math.sin(x) / x) * I0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    }
    for (p = 0; p < 4; p++) {
      ph = new Float64Array(T); s = 0;
      for (i = 0; i < T; i++) { ph[i] = h[4 * i + p]; s += ph[i]; }
      for (i = 0; i < T; i++) ph[i] *= g / s;
      out.push(ph);
    }
    return out;
  }
  var H = deriveH();
  class SceTpLimiter extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'ceiling', defaultValue: -1,   minValue: -40,   maxValue: 0, automationRate: 'k-rate' },
        { name: 'release', defaultValue: 0.08, minValue: 0.005, maxValue: 2, automationRate: 'k-rate' },
        { name: 'bypass',  defaultValue: 0,    minValue: 0,     maxValue: 1, automationRate: 'k-rate' }
      ];
    }
    constructor(options) {
      super(options);
      var fs = sampleRate;
      var D = Math.max(T + 8, Math.round(0.005 * fs));    // look-ahead = delay = latency (5 ms)
      this.D = D; this.G = T >> 1;                        // detector centre offset (8 samples)
      this.A = Math.max(1, D - T);                        // attack ramp length (box average)
      this.W = this.A + T + 1;                            // sliding-min window (= D + 1)
      var n = 1; while (n < D + T + 4) n <<= 1;           // ring holds D + FIR history
      this.mask = n - 1;
      this.rL = new Float32Array(n); this.rR = new Float32Array(n); this.w = 0;
      var q = 1; while (q < this.W + 2) q <<= 1;          // monotonic deque capacity
      this.qm = q - 1; this.qv = new Float64Array(q); this.qi = new Float64Array(q);
      this.qh = 0; this.qt = 0; this.t = 0;
      this.box = new Float64Array(this.A); this.box.fill(1); this.bi = 0;
      this.sum = this.A; this.nBelow = 0; this.invA = 1 / this.A;
      this.grel = 1; this.hold = 0; this.loud = 0;
      this.h0 = H[0]; this.h1 = H[1]; this.h2 = H[2]; this.h3 = H[3];
      var l1 = 0, p, i, s;
      for (p = 0; p < 4; p++) { s = 0; for (i = 0; i < T; i++) s += Math.abs(H[p][i]); if (s > l1) l1 = s; }
      this.L1 = l1;                                       // max phase L1 norm (≈ 2.04): |FIR out| ≤ L1·max|x|
      this.ceilDb = NaN; this.C = 1; this.thr = 1;
      this.relS = NaN; this.tauMul = 0; this.alpha = 0;
      this.idle = 0; this.zeros = null; this.scratch = null;
      this.repEvery = Math.max(1, Math.round(fs / 10)); this.repCount = 0; this.gMinRep = 1; this.lastGr = 0;
    }
    process(inputs, outputs, params) {
      var out = outputs[0];
      if (!out || !out.length) return true;
      var oL = out[0], N = oL.length;
      if (!this.scratch || this.scratch.length !== N) { this.scratch = new Float32Array(N); this.zeros = new Float32Array(N); }
      var oR = out.length > 1 ? out[1] : this.scratch;
      var inp = inputs[0], nIn = inp ? inp.length : 0;
      if (nIn === 0) {
        if (this.idle >= this.D + T + 4) {                // delay line already flushed → silence, no work
          oL.fill(0); oR.fill(0);
          if (this.lastGr !== 0) { this.lastGr = 0; this.gMinRep = 1; this.repCount = 0; this.port.postMessage({ gr: 0 }); }
          return true;
        }
        this.idle += N;                                   // keep running on zeros to flush the tail
      } else this.idle = 0;
      var iL = nIn ? inp[0] : this.zeros, stereo = nIn > 1, iR = stereo ? inp[1] : iL;
      // k-rate parameters (recomputed only on change)
      var cdb = params.ceiling[0];
      if (cdb !== this.ceilDb) { this.ceilDb = cdb; this.C = Math.pow(10, cdb / 20); this.thr = this.C / this.L1; }
      var tauMul = 1 + 3 * Math.min(1, this.hold / 0.3), relS = params.release[0];
      if (relS !== this.relS || tauMul !== this.tauMul) { this.relS = relS; this.tauMul = tauMul; this.alpha = 1 - Math.exp(-1 / (relS * tauMul * sampleRate)); }
      var bypass = params.bypass[0] >= 0.5;
      var rL = this.rL, rR = this.rR, m = this.mask, D = this.D, G = this.G, W = this.W, A = this.A, C = this.C, thr = this.thr, alpha = this.alpha;
      var h0 = this.h0, h1 = this.h1, h2 = this.h2, h3 = this.h3, qv = this.qv, qi = this.qi, qm = this.qm, box = this.box, invA = this.invA;
      var w = this.w, t = this.t, qh = this.qh, qt = this.qt, loud = this.loud, grel = this.grel, bi = this.bi, sum = this.sum, nBelow = this.nBelow, gMinRep = this.gMinRep;
      var limCount = 0;
      for (var n = 0; n < N; n++) {
        var xL = iL[n], xR = iR[n];
        rL[w] = xL; rR[w] = xR;
        var aL = xL < 0 ? -xL : xL, aR = xR < 0 ? -xR : xR; if (aR > aL) aL = aR;
        if (aL > thr) loud = T; else if (loud > 0) loud--;  // FIR needed only while a loud sample is within its span
        var tg = 1;
        if (loud > 0) {
          var pk = rL[(w - G) & m]; if (pk < 0) pk = -pk;
          var s0 = 0, s1 = 0, s2 = 0, s3 = 0, i, v;
          for (i = 0; i < T; i++) { v = rL[(w - i) & m]; s0 += h0[i] * v; s1 += h1[i] * v; s2 += h2[i] * v; s3 += h3[i] * v; }
          if (s0 < 0) s0 = -s0; if (s0 > pk) pk = s0;
          if (s1 < 0) s1 = -s1; if (s1 > pk) pk = s1;
          if (s2 < 0) s2 = -s2; if (s2 > pk) pk = s2;
          if (s3 < 0) s3 = -s3; if (s3 > pk) pk = s3;
          if (stereo) {
            v = rR[(w - G) & m]; if (v < 0) v = -v; if (v > pk) pk = v;
            s0 = 0; s1 = 0; s2 = 0; s3 = 0;
            for (i = 0; i < T; i++) { v = rR[(w - i) & m]; s0 += h0[i] * v; s1 += h1[i] * v; s2 += h2[i] * v; s3 += h3[i] * v; }
            if (s0 < 0) s0 = -s0; if (s0 > pk) pk = s0;
            if (s1 < 0) s1 = -s1; if (s1 > pk) pk = s1;
            if (s2 < 0) s2 = -s2; if (s2 > pk) pk = s2;
            if (s3 < 0) s3 = -s3; if (s3 > pk) pk = s3;
          }
          if (pk > C) tg = C / pk;
        }
        // sliding-window minimum of tg over the last W samples (monotonic deque)
        while (qt > qh && qv[(qt - 1) & qm] >= tg) qt--;
        qv[qt & qm] = tg; qi[qt & qm] = t; qt++;
        while (qi[qh & qm] <= t - W) qh++;
        var gmin = qv[qh & qm];
        if (gmin < 1) limCount++;
        // exponential release (never above the window minimum)
        var cand = grel + (1 - grel) * alpha;
        grel = gmin < cand ? gmin : cand;
        if (grel > 0.99999) grel = 1;                      // snap once within 1e-5 (-0.0001 dB): exact unity, no drift
        // box average → linear attack ramp; exact 1 and drift-free when idle
        var old = box[bi]; box[bi] = grel; if (++bi === A) bi = 0;
        if (old < 1) nBelow--; if (grel < 1) nBelow++;
        sum += grel - old;
        var g;
        if (nBelow === 0) { g = 1; sum = A; } else { g = sum * invA; if (g > 1) g = 1; }
        if (bypass) g = 1;
        if (g < gMinRep) gMinRep = g;
        var rp = (w - D) & m;
        oL[n] = rL[rp] * g; oR[n] = rR[rp] * g;
        w = (w + 1) & m; t++;
      }
      this.w = w; this.t = t; this.qh = qh; this.qt = qt; this.loud = loud; this.grel = grel; this.bi = bi; this.sum = sum; this.nBelow = nBelow;
      // program-dependent release bookkeeping
      if (limCount > 0) this.hold = Math.min(1, this.hold + limCount / sampleRate);
      else if (grel > 0.99) this.hold = Math.max(0, this.hold - 4 * N / sampleRate);
      // gain-reduction report, at most 10 per second, only when the value changes
      this.repCount += N;
      if (this.repCount >= this.repEvery) {
        this.repCount = 0;
        var gr = gMinRep >= 1 ? 0 : Math.round(-2000 * Math.log10(gMinRep)) / 100;
        if (gr !== this.lastGr) { this.lastGr = gr; this.port.postMessage({ gr: gr }); }
        this.gMinRep = 1;
      } else this.gMinRep = gMinRep;
      return true;
    }
  }
  registerProcessor('sce-tp-limiter', SceTpLimiter);
  `,

    // Adds the processor module to ctx.audioWorklet from a Blob URL, once per context.
    // Resolves true on success, false on any failure (CSP, unsupported, closed context); never throws.
    load(ctx) {
      try {
        if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return Promise.resolve(false);
        if (ctx.__sceTpLimiterLoad) return ctx.__sceTpLimiterLoad;
        var p = (async function () {
          var url = '';
          try {
            url = URL.createObjectURL(new Blob([TP_LIMITER.source], { type: 'application/javascript' }));
            await ctx.audioWorklet.addModule(url);
            ctx.__sceTpLimiterOk = true;
            return true;
          } catch (e) {
            TP_LIMITER.lastError = e;
            ctx.__sceTpLimiterOk = false;
            ctx.__sceTpLimiterLoad = null;              // allow a later retry
            return false;
          } finally {
            if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }
          }
        })();
        ctx.__sceTpLimiterLoad = p;
        return p;
      } catch (e) { TP_LIMITER.lastError = e; return Promise.resolve(false); }
    },

    // Returns a configured AudioWorkletNode (1 in, 1 out, stereo out) or null when the module
    // is not loaded in this context. Attaches latencySamples / latencyMs / gainReduction.
    create(ctx) {
      if (!ctx || ctx.__sceTpLimiterOk !== true) return null;
      try {
        var node = new AudioWorkletNode(ctx, 'sce-tp-limiter', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: 'clamped-max', channelInterpretation: 'speakers'
        });
        node.latencySamples = Math.max(24, Math.round(0.005 * ctx.sampleRate));
        node.latencyMs = node.latencySamples / ctx.sampleRate * 1000;
        node.gainReduction = 0;
        node.port.addEventListener('message', function (ev) { if (ev.data && typeof ev.data.gr === 'number') node.gainReduction = ev.data.gr; });
        node.port.start();
        return node;
      } catch (e) { TP_LIMITER.lastError = e; return null; }
    }
  };
  const TP_CEIL = -1;   // dBTP — the true-peak leg's ceiling (the compressor leg holds −3 dBFS sample peaks)
  /* Enhance (spec §2.25, v2). One block definition serves the live chain and the offline
   * level calibration, so what is measured is exactly what plays. At intensity a ∈ [0, 1]:
   *   pre    −ENH_HEAD·a dB — the block's own headroom: the tone's biggest boost (the sub and
   *          warm shelves overlap) comes off first, so the shaper never clamps a full-scale
   *          master. The trim gives it back after the dynamics.
   *   tone   sub 55 Hz +2a · warm 90 Hz +1.5a · mud 280 Hz −1.5a (Q 1.4) · presence 3 kHz +2a
   *          (Q 1) · air 8.5 kHz +3a
   *   shaper the unity-gain cubic (satCurve), 4× oversampled while Enhance is on
   *   exciter HP 4 kHz (×2) → tanh(3x)/tanh(3) (4×) → HP 6.5 kHz (×2) → 0.22a, summed with the
   *          shaper: new harmonics above 6.5 kHz from the 4–9 kHz band, where a lossy stream
   *          has rolled off. The two shapers share one oversample setting so both legs of the
   *          sum carry the same resampler delay.
   *   bank   LR4 crossovers 150 / 2500 Hz; lo thr −16−4a ratio 1+0.6a att 30 ms rel 200 ms;
   *          mid −14−4a, 1+0.5a, 12 / 150 ms; hi −18−6a, 1+0.7a, 5 / 100 ms; knee 12. Thresholds
   *          follow the pre-gain (−ENH_HEAD·a) so the bands work the same programme level the
   *          bench tuned them on. The bank is inert (ratio 1, thr 0) and its input gain 0 off.
   * Every stage is an exact identity at a = 0; mbG 0 / cpG 1 hands the signal to the wideband
   * compressor path. */
  const ENH = { sub: 2.0, warm: 1.5, mud: -1.5, pres: 2.0, air: 3.0, exMix: 0.22 };
  const ENH_HEAD = ENH.sub + ENH.warm;   // dB per unit intensity: the two low shelves stack fully below 55 Hz (enhToneMaxDb checks it)
  ENH.lo = { thr: -16, thrA: 4 + ENH_HEAD, ratio: 0.6, att: 0.03, rel: 0.2 };
  ENH.mid = { thr: -14, thrA: 4 + ENH_HEAD, ratio: 0.5, att: 0.012, rel: 0.15 };
  ENH.hi = { thr: -18, thrA: 6 + ENH_HEAD, ratio: 0.7, att: 0.005, rel: 0.1 };
  function buildEnhanceBlock(ctx) {
    const biq = (type, f, q, g) => { const b = ctx.createBiquadFilter(); b.type = type; try { b.frequency.value = f; if (q != null) b.Q.value = q; b.gain.value = g || 0; } catch (e) {} return b; };
    const gain = (g) => { const n = ctx.createGain(); n.gain.value = g; return n; };
    const BW = -3.01;
    const pre = gain(1);
    const sub = biq('lowshelf', 55, null, 0), warm = biq('lowshelf', 90, null, 0), mud = biq('peaking', 280, 1.4, 0), pres = biq('peaking', 3000, 1.0, 0), air = biq('highshelf', 8500, null, 0);
    // saturation: curve null + oversample 'none' = passthrough with 0 latency
    const shaper = ctx.createWaveShaper(); try { shaper.oversample = 'none'; } catch (e) {}
    // exciter branch: Butterworth pairs (Q −3.01 dB) either side of a fixed tanh curve; only exGain moves
    const exHp1 = biq('highpass', 4000, BW, 0), exHp2 = biq('highpass', 4000, BW, 0), exHp3 = biq('highpass', 6500, BW, 0), exHp4 = biq('highpass', 6500, BW, 0);
    const exShape = ctx.createWaveShaper();
    try { exShape.oversample = 'none'; const N = 2048, c = new Float32Array(N), d = 3, t = Math.tanh(d); for (let i = 0; i < N; i++) c[i] = Math.tanh(d * (i * 2 / (N - 1) - 1)) / t; exShape.curve = c; } catch (e) {}
    const exGain = gain(0), sum = gain(1);
    // three-band bank: LR4 = two cascaded Butterworth biquads per edge
    const lp = (f) => { const x = biq('lowpass', f, BW, 0), y = biq('lowpass', f, BW, 0); x.connect(y); return { i: x, o: y }; };
    const hp = (f) => { const x = biq('highpass', f, BW, 0), y = biq('highpass', f, BW, 0); x.connect(y); return { i: x, o: y }; };
    const comp = () => { const c = ctx.createDynamicsCompressor(); try { c.threshold.value = 0; c.knee.value = 12; c.ratio.value = 1; c.attack.value = 0.01; c.release.value = 0.1; } catch (e) {} return c; };
    const mbG = gain(0), mbOut = gain(1);
    const lo = lp(150), midHp = hp(150), midLp = lp(2500), hi = hp(2500);
    const mbLo = comp(), mbMid = comp(), mbHi = comp();
    // wiring
    pre.connect(sub); sub.connect(warm); warm.connect(mud); mud.connect(pres); pres.connect(air); air.connect(shaper); shaper.connect(sum);
    air.connect(exHp1); exHp1.connect(exHp2); exHp2.connect(exShape); exShape.connect(exHp3); exHp3.connect(exHp4); exHp4.connect(exGain); exGain.connect(sum);
    mbG.connect(lo.i); lo.o.connect(mbLo); mbLo.connect(mbOut);
    mbG.connect(midHp.i); midHp.o.connect(midLp.i); midLp.o.connect(mbMid); mbMid.connect(mbOut);
    mbG.connect(hi.i); hi.o.connect(mbHi); mbHi.connect(mbOut);
    return { enhPre: pre, sub, warm, mud, pres, air, shaper, exShape, exGain, sum, mbG, mbOut, mbLo, mbMid, mbHi };
  }
  // the node values for intensity a (0 = every stage inert) with the bank on or off (Night mode
  // keeps the tone and takes the dynamics) at programme offset `off` dB (see enhTick: the bank
  // is wrapped in +off / −off gains so it always works the level it was tuned on; the wrap
  // nets to exactly 1). `w(param, value, seconds)` is the writer (applyFx ramps a routed
  // chain, the calibration and a detached chain write .value).
  function setEnhanceParams(b, a, bank, off, w, db2g) {
    w(b.enhPre.gain, db2g(-ENH_HEAD * a));
    w(b.sub.gain, ENH.sub * a); w(b.warm.gain, ENH.warm * a); w(b.mud.gain, ENH.mud * a); w(b.pres.gain, ENH.pres * a); w(b.air.gain, ENH.air * a);
    w(b.exGain.gain, ENH.exMix * a, 0.05);
    b.bankOn = !!bank;
    w(b.mbG.gain, bank ? db2g(off) : 0, 0.05); w(b.mbOut.gain, db2g(-off), 0.05);
    for (const [c, k] of [[b.mbLo, ENH.lo], [b.mbMid, ENH.mid], [b.mbHi, ENH.hi]]) {
      w(c.threshold, bank ? k.thr - k.thrA * a : 0, 0.05); w(c.ratio, bank ? 1 + k.ratio * a : 1, 0.05); w(c.knee, 12, 0.05);
      w(c.attack, k.att, 0.05); w(c.release, k.rel, 0.05);
    }
  }
  /* Programme-adaptive bank (v2.1). The bank's thresholds are absolute, so on its own it would
   * work a −8 LUFS master hard and a −18 LUFS dynamic mix barely at all — and the measured level
   * match only holds at the level it was tuned on. So the source's short-term loudness (the
   * K-weighted taps, 6 × 400 ms, smoothed with a 4 s time constant, snapped on a track change,
   * held through silence) sets an offset ENH_REF − L, clamped ±10 dB, and the bank sits between
   * +off and −off gains: whatever the track's level, the bank sees the calibration clip's level,
   * the auto-makeup is untouched, and the wrap nets to exactly 1 — also mid-move: the two gains
   * glide as reciprocal exponential ramps (0.6 s), whose product is 1 at every instant. Run by
   * loudTick (every 500 ms while Enhance is on and the chain is routed), so it never pumps. */
  const ENH_REF = -11.6;   // LUFS of the calibration clip (bench, gated)
  const enhTrack = { href: null, entry: null, recent: [], lufs: NaN, off: 0 };
  function enhTick() {
    if (!CFG.enhanceOn) return;
    let e = null; sceFx.forEach((x) => { if (x.routed) e = x; }); if (!e) return;   // the newest routed chain
    const m = activeMedia(); if (!m || m.paused || !(m.readyState > 0)) return;
    // a new track (the badge's href) or a new source node (a fresh chain entry): start over from its first block
    const href = curTrackHref();
    if (href !== enhTrack.href || e !== enhTrack.entry) { enhTrack.href = href; enhTrack.entry = e; enhTrack.recent = []; enhTrack.lufs = NaN; }
    const c = e.chain, sr = e.ctx.sampleRate || 48000;
    const n = Math.max(1, Math.min(Math.round(0.4 * sr), c.bufKL.length));
    c.kL.getFloatTimeDomainData(c.bufKL); c.kR.getFloatTimeDomainData(c.bufKR);
    const ms = (b) => { let s = 0; for (let i = b.length - n; i < b.length; i++) s += b[i] * b[i]; return s / n; };
    const pw = ms(c.bufKL) + ms(c.bufKR);
    if (!(pw >= 1e-9)) return;   // silence (< −90 LUFS) or NaN: hold the last offset
    enhTrack.recent.push(pw); if (enhTrack.recent.length > 6) enhTrack.recent.shift();
    const st = -0.691 + 10 * Math.log10(enhTrack.recent.reduce((a, b) => a + b, 0) / enhTrack.recent.length);
    enhTrack.lufs = isFinite(enhTrack.lufs) ? enhTrack.lufs + (st - enhTrack.lufs) * 0.12 : st;
    const off = Math.max(-10, Math.min(10, ENH_REF - enhTrack.lufs));
    if (Math.abs(off - enhTrack.off) < 0.2) return;
    enhTrack.off = off;
    const gIn = Math.pow(10, off / 20), gOut = Math.pow(10, -off / 20);
    sceFx.forEach((x) => {
      if (!x.routed || !x.chain.bankOn) return;   // bankOn is stamped on the object setEnhanceParams wrote (the chain)
      try {
        const now = x.ctx.currentTime || 0, a = x.chain.mbG.gain, b = x.chain.mbOut.gain;
        const a0 = Math.max(1e-4, a.value), b0 = Math.max(1e-4, b.value);   // exponential ramps need non-zero ends
        a.cancelScheduledValues(now); a.setValueAtTime(a0, now); a.exponentialRampToValueAtTime(gIn, now + 0.6);
        b.cancelScheduledValues(now); b.setValueAtTime(b0, now); b.exponentialRampToValueAtTime(gOut, now + 0.6);
      } catch (er) {}
    });
  }
  // the tone's biggest boost (dB) at intensity a — the sub and warm shelves overlap below 90 Hz
  // (≈ 3.3 dB at a = 1, measured on the probe bank); this is what `pre` takes off up front
  function enhToneMaxDb(a) {
    let m = 0;
    try { const cd = compositeDb(PROBE_FREQS, a); for (let i = 0; i < cd.enhDb.length; i++) if (cd.enhDb[i] > m) m = cd.enhDb[i]; } catch (e) {}
    return m > 0 ? m : ENH_HEAD * a;
  }
  /* Level match, measured: the whole block (pre-gain, tone, saturation, exciter, bank with
   * Chromium's per-band auto-makeup) rendered offline over 4 s of a music-like clip (kick,
   * snare, hats, saw bass, pad, a vocal band, a 9 kHz codec roll-off) mastered the way most
   * uploads are — +4 dB into a hard clip at −1 dBFS, ≈ −11.6 LUFS, 11 dB crest. The bank's
   * gain depends on the programme (it works harder on a brickwalled master, less on a dynamic
   * one); this middle sits within ±0.9 dB of both ends at full intensity. The K-weighted mean
   * power out vs in is the block's gain, and compTrim cancels it. Cached per intensity (5 %
   * steps) and sample rate; until the render lands (~100 ms, on the audio thread) the bench's
   * table stands in, interpolated. Same shape as calibrateComp: returns the estimate now,
   * calls applyFx() once when the exact figure arrives. */
  const ENH_GAIN_TABLE = [[0, 0], [0.25, -0.12], [0.5, -0.22], [0.75, -0.36], [1, -0.56]];   // [a, block gain dB] — bench, 48 kHz
  const _enhCalib = new Map(); let _enhCalibBusy = false, _enhCalibNext = null;
  function enhGainTable(a) {
    const T = ENH_GAIN_TABLE;
    for (let i = 1; i < T.length; i++) if (a <= T[i][0]) { const t = (a - T[i - 1][0]) / (T[i][0] - T[i - 1][0]); return T[i - 1][1] + (T[i][1] - T[i - 1][1]) * t; }
    return T[T.length - 1][1];
  }
  function enhClip(ctx, sr) {   // 4 s, mono, deterministic (LCG), mastered to −1 dBFS
    const n = Math.round(4 * sr), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    let seed = 1; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    const beat = 60 / 96, notes = [55, 55, 65.4, 73.4, 55, 55, 49, 65.4];
    for (let i = 0; i < n; i++) {
      const t = i / sr, tb = t % beat, bar = Math.floor(t / beat);
      const kick = Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-tb * 18)) * tb) * Math.exp(-tb * 7) * 0.9;
      const ts = (t + beat) % (2 * beat);
      const snare = ts < 0.25 ? (rnd() * Math.exp(-ts * 22) * 0.55 + Math.sin(2 * Math.PI * 190 * ts) * Math.exp(-ts * 30) * 0.4) : 0;
      const th = t % (beat / 2), hat = rnd() * Math.exp(-th * 90) * 0.18;
      const f0 = notes[bar % notes.length], saw = 2 * ((t * f0) % 1) - 1, pf = f0 * 4;
      const pad = (2 * ((t * pf * 1.003) % 1) - 1 + 2 * ((t * pf * 0.997) % 1) - 1) * 0.12;
      const vEnv = Math.max(0, Math.sin(2 * Math.PI * t / 4)) * 0.35;
      const voc = vEnv * (Math.sin(2 * Math.PI * 220 * t) + 0.6 * Math.sin(2 * Math.PI * 440 * t) + 0.5 * Math.sin(2 * Math.PI * 660 * t) + 0.35 * Math.sin(2 * Math.PI * 1100 * t) + 0.2 * Math.sin(2 * Math.PI * 2600 * t)) * 0.4;
      d[i] = kick + snare + hat + pad + voc + saw * 0.45 + rnd() * 0.01;
    }
    let y = 0; const k = Math.exp(-2 * Math.PI * 9000 / sr);
    for (let i = 0; i < n; i++) { y = k * y + (1 - k) * d[i]; d[i] = y; }
    let pk = 0; for (let i = 0; i < n; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; }
    const g = pk > 0 ? Math.pow(10, 3 / 20) / pk : 1, c = Math.pow(10, -1 / 20);   // −1 dBFS peak, then +4 dB into the clip
    for (let i = 0; i < n; i++) { const v = d[i] * g; d[i] = v > c ? c : v < -c ? -c : v; }
    return buf;
  }
  function calibrateEnhance(a) {
    const sr = (sceLastCtx && sceLastCtx.sampleRate) || 48000;
    const key = Math.round(a * 20) + '|' + sr;   // the slider steps by 5 %
    const hit = _enhCalib.get(key);
    if (hit) return hit.db;
    const ent = { db: enhGainTable(a), exact: false }; _enhCalib.set(key, ent);
    _enhCalibNext = { key, a, sr, ent };
    enhCalibRun();
    return ent.db;
  }
  function enhCalibRun() {   // one render at a time; a newer request replaces a queued one
    if (_enhCalibBusy || !_enhCalibNext) return;
    const job = _enhCalibNext; _enhCalibNext = null;
    try {
      const OAC = W.OfflineAudioContext || W.webkitOfflineAudioContext;
      if (!OAC) return;
      const sr = job.sr, len = Math.round(4 * sr);
      const oc = new OAC(2, len, sr);
      const src = oc.createBufferSource(); src.buffer = enhClip(oc, sr);
      const blk = buildEnhanceBlock(oc);
      const bank = oc.createDynamicsCompressor(); try { bank.threshold.value = 0; bank.knee.value = 0; bank.ratio.value = 1; } catch (e) {}   // the dry leg gets the same fixed pre-delay
      setEnhanceParams(blk, job.a, true, 0, (p, v) => { try { p.value = v; } catch (e) {} }, (db) => Math.pow(10, db / 20));
      try { blk.shaper.curve = satCurve(job.a); blk.shaper.oversample = '4x'; blk.exShape.oversample = '4x'; } catch (e) {}
      const k = kCoeffs(sr), kDry = oc.createIIRFilter(k.b, k.a), kWet = oc.createIIRFilter(k.b, k.a), merge = oc.createChannelMerger(2);
      src.connect(bank); bank.connect(kDry); kDry.connect(merge, 0, 0);
      src.connect(blk.enhPre); blk.sum.connect(blk.mbG); blk.mbOut.connect(kWet); kWet.connect(merge, 0, 1);
      merge.connect(oc.destination); src.start(0);
      _enhCalibBusy = true;
      oc.startRendering().then((out) => {
        _enhCalibBusy = false;
        try {
          const x = out.getChannelData(0), y = out.getChannelData(1), from = Math.round(0.3 * sr);
          let sx = 0, sy = 0; for (let i = from; i < x.length; i++) { sx += x[i] * x[i]; sy += y[i] * y[i]; }
          if (sx > 0 && sy > 0) { const db = 10 * Math.log10(sy / sx); if (isFinite(db) && Math.abs(db) < 12) { job.ent.db = db; job.ent.exact = true; applyFx(); } }
        } catch (e) {}
        enhCalibRun();
      }).catch(() => { _enhCalibBusy = false; enhCalibRun(); });
    } catch (e) { _enhCalibBusy = false; }
  }
  // the probe bank: a never-connected copy of every linear user stage. Its params are
  // written with .value (no ramp to lag behind), so getFrequencyResponse gives the true
  // composite curve for auto-headroom and the canvas. Unconnected nodes cost no render time.
  function buildProbeBank(ctx) {
    const biq = (type, f, q, g) => { const b = ctx.createBiquadFilter(); b.type = type; try { b.frequency.value = f; if (q != null) b.Q.value = q; b.gain.value = g || 0; } catch (e) {} return b; };
    const bands = EQ_NODE_FREQS.map((f, i) => (i === 0 ? biq('lowshelf', f, null, 0) : i === EQ_NODE_FREQS.length - 1 ? biq('highshelf', f, null, 0) : biq('peaking', f, 1.4, 0)));
    const peq = []; for (let i = 0; i < 10; i++) peq.push(biq('peaking', 1000, 1, 0));
    return { bands, peq, bass: biq('lowshelf', 100, null, 0),
      sub: biq('lowshelf', 55, null, 0), warm: biq('lowshelf', 90, null, 0), mud: biq('peaking', 280, 1.4, 0), pres: biq('peaking', 3000, 1.0, 0), air: biq('highshelf', 8500, null, 0),
      tiltLo: biq('lowshelf', 700, null, 0), tiltHi: biq('highshelf', 700, null, 0), lcLo: biq('lowshelf', 100, null, 0), lcHi: biq('highshelf', 8000, null, 0) };
  }
  // before the first play there is no chain (SoundCloud builds its graph on play): a bank on a
  // tiny offline context answers for the canvas and the pre-amp value until a real chain exists
  let _probeFallback = null;
  function fallbackProbe() {
    if (_probeFallback) return _probeFallback;
    try { const OAC = W.OfflineAudioContext || window.OfflineAudioContext; if (OAC) _probeFallback = buildProbeBank(new OAC(1, 128, 48000)); } catch (e) { _probeFallback = null; }
    return _probeFallback;
  }
  // reverb IR (WP10): 1.6 s of decorrelated noise (two independent channels), −60 dB at the end; built on first use.
  // Seeded (mulberry32) so every chain — and every session — gets the same room: a fresh random IR would give each
  // frequency a different response each time (a noise IR's gain at one frequency is Rayleigh-distributed).
  function reverbIr(ctx) {
    const sr = ctx.sampleRate || 48000, n = Math.round(1.6 * sr), buf = ctx.createBuffer(2, n, sr);
    let seed = 0x9e3779b9;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * Math.exp(-6.9 * i / n); }
    return buf;
  }
  function buildFxChain(ctx) {
    const sr = ctx.sampleRate || 48000;
    const biq = (type, f, q, g) => { const b = ctx.createBiquadFilter(); b.type = type; try { b.frequency.value = f; if (q != null) b.Q.value = q; b.gain.value = g || 0; } catch (e) {} return b; };
    const gain = (g) => { const n = ctx.createGain(); n.gain.value = g; return n; };
    // intermediate mono buses: explicit 1 channel so the M/S maths stay exact
    const mono = (g) => { const nn = ctx.createGain(); try { nn.channelCount = 1; nn.channelCountMode = 'explicit'; nn.channelInterpretation = 'discrete'; } catch (e) {} nn.gain.value = g; return nn; };
    // stereo entry points: force a real L/R pair so a mono source never arrives as [L, silence]
    const stereo = (g) => { const nn = ctx.createGain(); try { nn.channelCount = 2; nn.channelCountMode = 'explicit'; nn.channelInterpretation = 'speakers'; } catch (e) {} nn.gain.value = g == null ? 1 : g; return nn; };
    // measurement taps: time-domain reads only (no FFT is ever computed), so the
    // 32768 size is free and a 500 ms read sees every sample
    const tap = () => { const a = ctx.createAnalyser(); try { a.fftSize = 32768; a.smoothingTimeConstant = 0; a.channelCount = 1; } catch (e) {} return a; };
    const BW = -3.01;   // Chromium reads highpass/lowpass Q in dB: −3.01 dB = linear 0.707 = Butterworth
    // 1. input — the single attachment point for reroute. Stereo-forced so the source
    //    taps and the whole chain see the same L/R pair the speakers would (a mono
    //    stream is up-mixed L = R exactly as the destination would do it).
    const input = stereo(1);
    // 1b. side taps from `input` (never in the audio path; outputs unconnected — Chromium
    //     still processes them): K-weighted L/R for loudness, plain L/R for the source peak.
    //     Measured BEFORE every user stage so the stored loudness is the track's, not ours.
    let kIn = null, kOut = null;
    try { const k = kCoeffs(sr); kIn = kOut = ctx.createIIRFilter(k.b, k.a); } catch (e) { kIn = kOut = null; }
    if (!kIn) { kIn = biq('highshelf', 1681.97, null, 4); kOut = biq('highpass', 38.135, -6.02, 0); kIn.connect(kOut); }   // within 0.26 dB
    const kSplit = ctx.createChannelSplitter(2), kL = tap(), kR = tap();
    input.connect(kIn); kOut.connect(kSplit); kSplit.connect(kL, 0); kSplit.connect(kR, 1);
    const pSplit = ctx.createChannelSplitter(2), pL = tap(), pR = tap();
    input.connect(pSplit); pSplit.connect(pL, 0); pSplit.connect(pR, 1);
    // 2. pre-amp: user pre-amp + AutoEQ preamp − composite auto-headroom
    const preamp = gain(1);
    // 3. automatic rumble filter: identity (peaking 0 dB) until something boosts the
    //    low end, then a 25 Hz Butterworth high-pass (type swapped on the edge only)
    const rumble = biq('peaking', 25, 1, 0);
    // 4. tilt shelves (700 Hz pivot) · 5. loudness-contour shelves
    const tiltLo = biq('lowshelf', 700, null, 0), tiltHi = biq('highshelf', 700, null, 0);
    const lcLo = biq('lowshelf', 100, null, 0), lcHi = biq('highshelf', 8000, null, 0);
    // 6. the graphic EQ (48 Hz lowshelf, 62 Hz–8 kHz peaking Q 1.4, 11 kHz highshelf)
    const mkBands = () => EQ_NODE_FREQS.map((f, i) => (i === 0 ? biq('lowshelf', f, null, 0) : i === EQ_NODE_FREQS.length - 1 ? biq('highshelf', f, null, 0) : biq('peaking', f, 1.4, 0)));
    const bands = mkBands();
    // 7. headphone-correction bank (peaking 0 dB = exact identity while unused)
    const mkPeq = () => { const a = []; for (let i = 0; i < 10; i++) a.push(biq('peaking', 1000, 1, 0)); return a; };
    const peq = mkPeq();
    // 8. bass shelf · 9. Enhance's linear parts (before the nonlinear stages so they shape what gets saturated)
    const bass = biq('lowshelf', 100, null, 0);
    // 8b. harmonic bass (WP10): a parallel branch off `bass` for small speakers — lowpass 120 Hz → a soft shaper
    //     x·|x|·0.8 + 0.2·x (no oversampling: its input is band-limited) → bandpass 180 Hz Q 0.9 → gain 0..0.5,
    //     summed with the direct path in bassSum. applyFx disconnects the branch input at 0 (pinning the gain to 0 as
    //     it does: a node whose input went silent is no longer processed, so its readable gain would freeze mid-ramp).
    const bassSum = gain(1), hLP = biq('lowpass', 120, BW, 0), hBP = biq('bandpass', 180, 0.9, 0), hGain = gain(0);
    const hShape = ctx.createWaveShaper();
    try { hShape.oversample = 'none'; const HN = 1025, hc = new Float32Array(HN); for (let i = 0; i < HN; i++) { const x = (i / (HN - 1)) * 2 - 1; hc[i] = x * Math.abs(x) * 0.8 + 0.2 * x; } hShape.curve = hc; } catch (e) {}
    hLP.connect(hShape); hShape.connect(hBP); hBP.connect(hGain); hGain.connect(bassSum);
    // 9. Enhance (see buildEnhanceBlock): headroom → tone → saturation ‖ exciter → sum, then
    //    its multiband bank in parallel with the wideband compressor below
    const enh = buildEnhanceBlock(ctx);
    // 11. Night mode / Enhance dynamics, arbitrated by two crossfade gains that always sum to 1:
    //     cpG → the wideband compressor (Night; inert thr 0 / ratio 1 when nothing uses it),
    //     mbG → Enhance's three-band bank. Both paths carry the compressor's fixed pre-delay,
    //     so the crossfade is a plain mix (no comb filter) and the chain's latency never moves.
    //     compTrim replaces Chromium's auto-makeup with programme-aware makeup (Night) or the
    //     measured level match (Enhance).
    const comp = ctx.createDynamicsCompressor();
    try { comp.threshold.value = 0; comp.knee.value = 0; comp.ratio.value = 1; comp.attack.value = 0.003; comp.release.value = 0.25; } catch (e) {}
    const cpG = gain(1), compTrim = gain(1);
    enh.sum.connect(cpG); cpG.connect(comp); comp.connect(compTrim);
    enh.sum.connect(enh.mbG); enh.mbOut.connect(compTrim);
    // 12. M/S block: width on the side bus, the vocal band on the mid bus. width = 1
    //     reconstructs L/R bit-exactly; the merger rebuilds a clean stereo pair.
    const wIn = stereo(1);
    const wSplit = ctx.createChannelSplitter(2);
    const wMid = mono(0.5), wSide = mono(0.5), wRinv = mono(-1), wWidth = mono(1), wSinv = mono(-1), wOutL = mono(1), wOutR = mono(1);
    const wMerge = ctx.createChannelMerger(2);
    wIn.connect(wSplit);
    wSplit.connect(wMid, 0); wSplit.connect(wMid, 1);                          // mid = 0.5(L+R)
    wSplit.connect(wSide, 0); wSplit.connect(wRinv, 1); wRinv.connect(wSide);  // side = 0.5(L−R)
    wSide.connect(wWidth); wWidth.connect(wSinv);                              // sideW = side·width
    // vocals: mid = LP(mid) + HP(mid) + band with band = mid − LP − HP (sample-exact —
    // biquads have no latency), so only the 200 Hz – 7 kHz centre is scaled by vGain
    const vLP = biq('lowpass', 200, BW, 0), vHP = biq('highpass', 7000, BW, 0);
    const vInv = mono(-1), vBand = mono(1), vGain = mono(1);
    wMid.connect(vLP); wMid.connect(vHP);
    vLP.connect(vInv); vHP.connect(vInv);
    wMid.connect(vBand); vInv.connect(vBand);
    vBand.connect(vGain);
    vLP.connect(wOutL); vHP.connect(wOutL); vGain.connect(wOutL); wWidth.connect(wOutL);   // L = mid' + sideW
    vLP.connect(wOutR); vHP.connect(wOutR); vGain.connect(wOutR); wSinv.connect(wOutR);    // R = mid' − sideW
    wOutL.connect(wMerge, 0, 0); wOutR.connect(wMerge, 0, 1);
    // 13. crossfeed, exact-complement topology: X' = x − f·LP(x) + f·LP(y). Centre content
    //     (x = y) sums back to x at every frequency and phase; the Butterworth's 0.32 ms
    //     low-frequency group delay is the inter-aural delay, so there is no DelayNode.
    //     Off: both gain pairs 0 → the lowpass lives only on silent paths.
    const cfIn = stereo(1);
    const cfSplit = ctx.createChannelSplitter(2), cfMerge = ctx.createChannelMerger(2);
    const cfLpL = biq('lowpass', 700, BW, 0), cfLpR = biq('lowpass', 700, BW, 0);
    const cfFeedL = mono(0), cfFeedR = mono(0), cfNegL = mono(0), cfNegR = mono(0);
    cfIn.connect(cfSplit);
    cfSplit.connect(cfMerge, 0, 0); cfSplit.connect(cfMerge, 1, 1);            // direct, gain 1, no filter
    cfSplit.connect(cfLpL, 0); cfSplit.connect(cfLpR, 1);
    cfLpL.connect(cfFeedL); cfFeedL.connect(cfMerge, 0, 1);                    // cross: LP(L) → R
    cfLpR.connect(cfFeedR); cfFeedR.connect(cfMerge, 0, 0);                    // cross: LP(R) → L
    cfLpL.connect(cfNegL); cfNegL.connect(cfMerge, 0, 0);                      // complement: −LP(L) → L
    cfLpR.connect(cfNegR); cfNegR.connect(cfMerge, 0, 1);                      // complement: −LP(R) → R
    // 14. output matrix — balance / mono / swap, the last spatial operation. gXY = input X → output Y.
    const mxIn = stereo(1);
    const mxSplit = ctx.createChannelSplitter(2), mxMerge = ctx.createChannelMerger(2);
    const gLL = mono(1), gLR = mono(0), gRL = mono(0), gRR = mono(1);
    mxIn.connect(mxSplit);
    mxSplit.connect(gLL, 0); gLL.connect(mxMerge, 0, 0);
    mxSplit.connect(gLR, 0); gLR.connect(mxMerge, 0, 1);
    mxSplit.connect(gRL, 1); gRL.connect(mxMerge, 0, 0);
    mxSplit.connect(gRR, 1); gRR.connect(mxMerge, 0, 1);
    // 14b. reverb (WP10): a parallel convolver off the matrix output, wet 0..0.35 into the analyser alongside the
    //      dry path. Its IR is built on first use and applyFx disconnects it at 0: the default is an exact identity.
    const conv = ctx.createConvolver(), rvWet = gain(0);
    // 15. spectrum analyser (the canvas only) · 16. loudness gain · 17. volume boost
    const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.82;
    rvWet.connect(analyser);
    const makeup = gain(1);
    const boost = gain(1);
    // 18. clip guard: two aligned legs behind gA / gB (they always sum to 1). gA → `lim`, a
    //     DynamicsCompressor (thr −3 / ratio 20, inert thr 0 / ratio 1) — the leg every context
    //     has; gB → `tpl`, the true-peak limiter (attached by attachGuard once its module has
    //     loaded) → tplAlign, an integer-sample delay padding its 5 ms look-ahead out to the
    //     compressor's fixed floor(0.006·sr) pre-delay, so swapping legs is a plain crossfade
    //     and the chain's latency never moves. limTrim cancels the compressor's auto-makeup
    //     (1 on the true-peak leg). 18b. output tap = what reaches the speakers.
    const lim = ctx.createDynamicsCompressor();
    try { lim.threshold.value = 0; lim.knee.value = 0; lim.ratio.value = 1; lim.attack.value = 0.001; lim.release.value = 0.08; } catch (e) {}
    const gA = gain(1), gB = gain(0), tplAlign = ctx.createDelay(0.05);
    try { tplAlign.delayTime.value = Math.max(0, Math.floor(0.006 * sr) - Math.max(24, Math.round(0.005 * sr))) / sr; } catch (e) {}
    const limTrim = gain(1);
    const oSplit = ctx.createChannelSplitter(2), oL = tap(), oR = tap();
    limTrim.connect(oSplit); oSplit.connect(oL, 0); oSplit.connect(oR, 1);
    // 19. output (fade) — after the limiter so a fade never triggers gain reduction; reroute connects it to SC's destinations
    const output = gain(1);
    // the audio path
    const path = [input, preamp, rumble, tiltLo, tiltHi, lcLo, lcHi].concat(bands, peq, [bass, bassSum, enh.enhPre]);
    for (let i = 0; i < path.length - 1; i++) path[i].connect(path[i + 1]);
    compTrim.connect(wIn);
    wMerge.connect(cfIn); cfMerge.connect(mxIn); mxMerge.connect(analyser);
    analyser.connect(makeup); makeup.connect(boost);
    boost.connect(gA); gA.connect(lim); lim.connect(limTrim);          // compressor leg
    boost.connect(gB); tplAlign.connect(limTrim); limTrim.connect(output);   // true-peak leg: gB → tpl → tplAlign, once attached
    // probe bank — a second, never-connected copy of every linear user stage (see buildProbeBank)
    const probe = buildProbeBank(ctx);
    return {
      input, preamp, rumble, tiltLo, tiltHi, lcLo, lcHi, bands, peq, bass, bassSum, hLP, hShape, hBP, hGain, harmOn: false,
      enhPre: enh.enhPre, sub: enh.sub, warm: enh.warm, mud: enh.mud, pres: enh.pres, air: enh.air, shaper: enh.shaper, exShape: enh.exShape, exGain: enh.exGain, enhSum: enh.sum,
      mbG: enh.mbG, mbOut: enh.mbOut, mbLo: enh.mbLo, mbMid: enh.mbMid, mbHi: enh.mbHi, bankOn: false, cpG, comp, compTrim,
      widener: wWidth, vGain, cfLpL, cfLpR, cfFeedL, cfFeedR, cfNegL, cfNegR, gLL, gLR, gRL, gRR, mxMerge, conv, rvWet, rvOn: false,
      analyser, kL, kR, pL, pR, oL, oR, makeup, boost, gA, gB, lim, tpl: null, tplReady: false, tplAlign, limTrim, output, probe,
      rumbleOn: false,   // the rumble filter's current type (edge-triggered by applyFx)
      freq: new Uint8Array(analyser.frequencyBinCount), buf: new Float32Array(analyser.fftSize),
      bufKL: new Float32Array(kL.fftSize), bufKR: new Float32Array(kR.fftSize), bufPL: new Float32Array(pL.fftSize), bufPR: new Float32Array(pR.fftSize),
      bufOL: new Float32Array(oL.fftSize), bufOR: new Float32Array(oR.fftSize),
    };
  }
  // composite response of the user stages from the newest chain's probe bank, in dB at
  // `fr` (default: the 160-point log grid): userDb = bands + bass + tilt + contour (each only
  // while active), enhDb = Enhance's tone (its own block takes the headroom for it, so the
  // auto-headroom leaves it out; the canvas draws it), peqDb = the AutoEQ bank while it is on.
  // `enhA` overrides the intensity (enhToneMaxDb asks for the tone at a given a).
  function compositeDb(fr, enhA) {
    fr = fr || PROBE_FREQS;
    const n = fr.length, userDb = new Float32Array(n), peqDb = new Float32Array(n), enhDb = new Float32Array(n);
    try {
      const on = (k) => !fxBypass && !!CFG[k];
      const cl = (v, lo, hi) => { v = +v; return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0; };
      // nothing shapes the response → flat, without building the offline fallback bank
      const shaping = () => (on('eqOn') && Array.isArray(CFG.eqBands) && CFG.eqBands.some((x) => cl(x, -12, 12) !== 0))
        || (!fxBypass && (cl(CFG.bassDb, 0, 9) > 0 || cl(CFG.tiltDb, -4, 4) !== 0))
        || (on('enhanceOn') && cl(CFG.enhanceAmt, 0, 100) > 0) || (on('loudCompOn') && cl(CFG.loudCompAmt, 0, 9) > 0)
        || (on('peqOn') && Array.isArray(CFG.peq) && CFG.peq.some((f) => { const c = clampPeq(f); return !!(c && c.g); }));
      const e = [...sceFx].pop(); const p = (e && e.chain && e.chain.probe) || (shaping() || enhA > 0 ? fallbackProbe() : null);
      if (!p) return { userDb, peqDb, enhDb };
      const mag = n === PROBE_N ? _probeMag : new Float32Array(n), ph = n === PROBE_N ? _probePh : new Float32Array(n);
      const add = (node, out) => { try { node.getFrequencyResponse(fr, mag, ph); for (let i = 0; i < n; i++) { const m = mag[i]; if (m > 0 && isFinite(m)) out[i] += 20 * Math.log10(m); } } catch (er) {} };
      const setG = (node, g) => { try { node.gain.value = g; } catch (er) {} };
      const bands = Array.isArray(CFG.eqBands) ? CFG.eqBands : [];
      const eqOn = on('eqOn');
      for (let i = 0; i < p.bands.length; i++) { const g = eqOn ? cl(bands[i], -12, 12) : 0; setG(p.bands[i], g); if (g) add(p.bands[i], userDb); }
      const bassG = fxBypass ? 0 : cl(CFG.bassDb, 0, 9); setG(p.bass, bassG); if (bassG) add(p.bass, userDb);
      const t = fxBypass ? 0 : cl(CFG.tiltDb, -4, 4); setG(p.tiltLo, -t); setG(p.tiltHi, t); if (t) { add(p.tiltLo, userDb); add(p.tiltHi, userDb); }
      const a = enhA != null ? cl(enhA, 0, 1) : on('enhanceOn') ? cl(CFG.enhanceAmt, 0, 100) / 100 : 0;
      setG(p.sub, ENH.sub * a); setG(p.warm, ENH.warm * a); setG(p.mud, ENH.mud * a); setG(p.pres, ENH.pres * a); setG(p.air, ENH.air * a);
      if (a) for (const nd of [p.sub, p.warm, p.mud, p.pres, p.air]) add(nd, enhDb);
      const k = on('loudCompOn') ? contourK * cl(CFG.loudCompAmt, 0, 9) : 0; setG(p.lcLo, k); setG(p.lcHi, k / 3); if (k) { add(p.lcLo, userDb); add(p.lcHi, userDb); }
      if (on('peqOn') && Array.isArray(CFG.peq)) {
        for (let i = 0; i < p.peq.length; i++) {
          const f = clampPeq(CFG.peq[i]); if (!f || !f.g) continue;
          const node = p.peq[i];
          try { node.type = f.t === 'LSC' ? 'lowshelf' : f.t === 'HSC' ? 'highshelf' : 'peaking'; node.frequency.value = f.f; if (f.t === 'PK') node.Q.value = f.q; node.gain.value = f.g; } catch (er) {}
          add(node, peqDb);
        }
      }
    } catch (e) {}
    return { userDb, peqDb, enhDb };
  }
  // does anything upstream push the level up? Boost above 100 % and Enhance engage the guard
  // even with the switch off (the row text says so): Enhance's bank lets transients through
  // above the input's peaks (that is the punch) and relies on the guard to hold them. During
  // Compare only the kept stages (loudness gain, boost) count, so the original is not guarded
  // when nothing kept needs it.
  function needsLimiter() {
    const on = (k) => !fxBypass && !!CFG[k];
    const bands = Array.isArray(CFG.eqBands) ? CFG.eqBands : [];
    const eqBoosting = on('eqOn') && ((+CFG.eqPreamp || 0) > 0 || Math.max(0, ...bands.map((x) => +x || 0)) > 0);
    const boosting = eqBoosting || on('peqOn') || !!CFG.loudnessOn || on('enhanceOn') || on('nightOn') || on('loudCompOn')
      || (!fxBypass && ((CFG.stereoWidth | 0) > 100 || (+CFG.bassDb || 0) > 0 || (+CFG.bassHarm || 0) > 0 || (+CFG.reverbAmt || 0) > 0 || (+CFG.tiltDb || 0) !== 0 || (+CFG.vocalAmt || 0) > 0));
    return (!!CFG.limiterOn && boosting) || (CFG.boostAmt | 0) > 100 || on('enhanceOn');
  }
  // Chromium's DynamicsCompressor applies an automatic makeup gain that depends on
  // threshold / knee / ratio: 0.6 × the static curve's gain at 0 dBFS. The hard-knee
  // figure is 0.6·|thr|·(1 − 1/ratio) dB; with a soft knee Chromium's exponential knee
  // curve gives noticeably less (6 dB at thr −30 / knee 24 / ratio 3), so this replica
  // of its static-curve maths (kAtSlope + saturate) is the synchronous estimate.
  function compAutoDb(thr, knee, ratio) {
    if (!(thr < 0) || !(ratio > 1)) return 0;
    const db2lin = (d) => Math.pow(10, d / 20), lin2db = (x) => 20 * Math.log10(x);
    const lt = db2lin(thr), kneeDb = thr + knee, kneeLin = db2lin(kneeDb), slope = 1 / ratio;
    const kneeCurve = (x, k) => (x < lt ? x : lt + (1 - Math.exp(-k * (x - lt))) / k);
    const slopeAt = (x, k) => { if (x < lt) return 1; const x2 = x * 1.001; return (lin2db(kneeCurve(x2, k)) - lin2db(kneeCurve(x, k))) / (lin2db(x2) - lin2db(x)); };
    let minK = 0.1, maxK = 10000, k = 5;
    for (let i = 0; i < 15; i++) { if (slopeAt(kneeLin, k) < slope) maxK = k; else minK = k; k = Math.sqrt(minK * maxK); }
    const yKneeDb = lin2db(kneeCurve(kneeLin, k));
    const full = 1 < kneeLin ? kneeCurve(1, k) : db2lin(yKneeDb + slope * (0 - kneeDb));
    const db = -0.6 * lin2db(full);
    return isFinite(db) ? Math.max(0, db) : 0;
  }
  // Returns that estimate synchronously and measures the exact figure once, offline
  // (0.4 s of a −50 dBFS 200 Hz sine — far below any threshold, so only the makeup
  // shows), then calls applyFx() once when it lands.
  function calibrateComp(thr, knee, ratio) {
    const key = thr + '|' + knee + '|' + ratio;
    const analytic = compAutoDb(thr, knee, ratio);
    _calibWanted.add(key);
    const hit = _calib.get(key);
    if (hit) return hit.db;
    const ent = { db: analytic, exact: false }; _calib.set(key, ent);
    try {
      const OAC = W.OfflineAudioContext || W.webkitOfflineAudioContext;
      if (!OAC) return analytic;
      const sr = (sceLastCtx && sceLastCtx.sampleRate) || 48000, len = Math.round(0.4 * sr), amp = Math.pow(10, -50 / 20);
      const oc = new OAC(1, len, sr);
      const buf = oc.createBuffer(1, len, sr), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = amp * Math.sin(2 * Math.PI * 200 * i / sr);
      const src = oc.createBufferSource(); src.buffer = buf;
      const c = oc.createDynamicsCompressor();
      c.threshold.value = thr; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = 0.001; c.release.value = 0.05;
      src.connect(c); c.connect(oc.destination); src.start(0);
      oc.startRendering().then((out) => {
        try {
          const x = out.getChannelData(0); let pk = 0;
          for (let i = Math.round(0.3 * sr); i < x.length; i++) { const v = Math.abs(x[i]); if (v > pk) pk = v; }
          if (pk > 0) { ent.db = 20 * Math.log10(pk / amp); ent.exact = true; if (_calibWanted.has(key)) applyFx(); }
        } catch (e) {}
      }).catch(() => {});
    } catch (e) {}
    return analytic;
  }
  // cached saturation curve: a unity-gain cubic, x − k²x³/3 with k = 0.15 + 0.45·a. The
  // derivative at 0 is exactly 1 (no small-signal level change), |c| ≤ 1 − k²/3 = 0.88 at
  // full intensity so it can never exceed its input; THD ≈ 0.3 % at −10 dBFS.
  let _satKey = -1, _satCurve = null;
  function satCurve(amt01) {
    const key = Math.round(amt01 * 100);
    if (key === _satKey && _satCurve) return _satCurve;
    const k = 0.15 + 0.45 * amt01, n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i * 2 / (n - 1) - 1, xk = x * k; c[i] = (xk - xk * xk * xk / 3) / k; }
    _satKey = key; _satCurve = c; return c;
  }
  function installFx(ctx, src) {
    try {
      if (!ctx || !src || src.__sceFxInstalled) return;
      src.__sceFxInstalled = true;
      const chain = buildFxChain(ctx);
      const dests = new Map();   // dest → [output index, input index] exactly as SC connected it
      const oConnect = src.connect.bind(src);
      const oDisconnect = src.disconnect.bind(src);
      const isNode = (d) => !!(d && typeof d.connect === 'function' && typeof d.context !== 'undefined');
      const entry = { ctx, src, chain, dests, reroute: null, routed: null };   // routed: null = never decided (passthrough)
      const reroute = () => {
        dests.forEach((oi, d) => { try { oDisconnect(d); } catch (e) {} });
        try { oDisconnect(chain.input); } catch (e) {}
        try { chain.output.disconnect(); } catch (e) {}
        if (entry.routed) {
          try { oConnect(chain.input); } catch (e) {}
          dests.forEach((oi, d) => { try { chain.output.connect(d, 0, oi[1]); } catch (e) { try { chain.output.connect(d); } catch (e2) {} } });
        } else {
          dests.forEach((oi, d) => { try { oConnect(d, oi[0], oi[1]); } catch (e) { try { oConnect(d); } catch (e2) {} } });
        }
      };
      entry.reroute = reroute;
      src.connect = function (dest, out, inp) {
        try {
          if (!isNode(dest)) return oConnect.apply(src, arguments);   // AudioParam / odd target — never reroute
          dests.set(dest, [out | 0, inp | 0]); reroute(); return dest;
        } catch (e) { try { return oConnect.apply(src, arguments); } catch (e2) {} }
      };
      src.disconnect = function () {
        try {
          if (!arguments.length) { dests.clear(); try { chain.output.disconnect(); } catch (e) {} try { oDisconnect(chain.input); } catch (e) {} return oDisconnect(); }
          const d = arguments[0];
          if (isNode(d)) { dests.delete(d); try { chain.output.disconnect(d); } catch (e) {} try { oDisconnect(d); } catch (e) {} return; }
          return oDisconnect.apply(src, arguments);
        } catch (e) { try { return oDisconnect.apply(src, arguments); } catch (e2) {} }
      };
      sceFx.add(entry);
      // SC reuses one source node in practice; if it ever makes fresh ones per track, keep
      // the iterated set bounded (oldest entry = stalest/dead source) AND take the evicted
      // chain out of the graph: routed back to passthrough, then every node disconnected.
      // Detaching the ends is not enough — the analyser taps have no outputs, so Chromium
      // pulls them itself every render quantum, and through them the whole chain behind
      // them (five compressors, two resamplers, the limiter) would keep rendering silence.
      if (sceFx.size > 6) {
        try {
          const old = sceFx.values().next().value; sceFx.delete(old);
          old.routed = false; try { old.reroute(); } catch (e) {}
          const walk = (v) => {
            if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return;
            if (typeof v.disconnect === 'function' && typeof v.context === 'object') { try { v.disconnect(); } catch (e) {} return; }
            if (Array.isArray(v)) { v.forEach(walk); return; }
            for (const k in v) walk(v[k]);
          };
          walk(old.chain);
        } catch (e) {}
      }
      if (ctx.__sceTpLimiterOk === true) attachGuard(entry); else loadGuard(ctx);
      applyFx();
    } catch (e) { Log.err('installFx', e); }
  }
  // the true-peak leg: once the worklet module has loaded in a chain's context, create the node,
  // wire gB → tpl → tplAlign, and — after its delay line has filled (120 ms; it starts empty) —
  // let applyFx crossfade the legs. Until then the leg stays bypassed and silent (gB = 0).
  function attachGuard(e) {
    try {
      const c = e.chain; if (!c || c.tpl) return;
      const t = TP_LIMITER.create(e.ctx); if (!t) return;
      try { t.parameters.get('ceiling').value = TP_CEIL; t.parameters.get('bypass').value = 1; } catch (er) {}
      c.gB.connect(t); t.connect(c.tplAlign); c.tpl = t;
      setTimeout(() => { try { c.tplReady = true; applyFx(); } catch (er) {} }, 120);
    } catch (er) {}
  }
  function loadGuard(ctx) {
    try { TP_LIMITER.load(ctx).then((ok) => { if (ok) sceFx.forEach((e) => { if (e.ctx === ctx) attachGuard(e); }); }).catch(() => {}); } catch (er) {}
  }
  /* applyFx — the one place CFG becomes node parameters. Reads and clamps CFG once,
   * takes the auto-headroom from the composite response, then writes every stage of
   * every chain with short ramps (inert values arrive exactly). `on(key)` = the stages
   * Compare bypasses (tone, dynamics, spatial); `keep(key)` = the stages it keeps
   * (loudness gain, boost, the clip guard, fade) so every A/B is level-honest.
   * Routing is decided per chain entry; the loudness timer follows the routing. */
  function applyFx() {
    try {
      const on = (k) => !fxBypass && !!CFG[k];
      const keep = (k) => !!CFG[k];
      const cl = (v, lo, hi) => { v = +v; return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo; };
      const db2g = (db) => Math.pow(10, db / 20);
      // ── read + clamp CFG once ──
      const bands = Array.isArray(CFG.eqBands) ? CFG.eqBands : [];
      const eqOn = on('eqOn'), peqOn = on('peqOn'), enhOn = on('enhanceOn'), nightOn = on('nightOn');
      const eqPre = cl(CFG.eqPreamp, -12, 12), peqPre = cl(CFG.peqPreamp, -15, 0);
      const peq = (peqOn && Array.isArray(CFG.peq)) ? CFG.peq.slice(0, 10).map(clampPeq) : [];
      const bassDb = fxBypass ? 0 : cl(CFG.bassDb, 0, 9);
      const harm = fxBypass ? 0 : cl(CFG.bassHarm, 0, 100) / 100 * 0.5;
      const rv = fxBypass ? 0 : cl(CFG.reverbAmt, 0, 100) / 100 * 0.35;
      const tilt = fxBypass ? 0 : cl(CFG.tiltDb, -4, 4);
      const vocal = fxBypass ? 0 : cl(CFG.vocalAmt, -100, 100) / 100;
      const lcDb = on('loudCompOn') ? contourK * cl(CFG.loudCompAmt, 0, 9) : 0;
      const width = fxBypass ? 1 : cl(CFG.stereoWidth == null ? 100 : CFG.stereoWidth, 0, 200) / 100;
      const bal = on('balance') ? cl(CFG.balance, -100, 100) : 0;
      const boost = cl(CFG.boostAmt == null ? 100 : CFG.boostAmt, 100, 300) / 100;   // kept during Compare
      const enhAmt = cl(CFG.enhanceAmt, 0, 100) / 100, nightAmt = cl(CFG.nightAmt, 0, 100) / 100;
      const cfF = on('crossfeedOn') ? cfFeed(CFG.crossfeedMode) : 0;
      // ── Listening on (2.13): the chip stays lit only while the five keys its bundle set are
      //    untouched — any edit (slider, switch, debug, paste) clears it. From CFG, not Compare ──
      const sig = [cl(CFG.bassDb, 0, 9), cl(CFG.tiltDb, -4, 4), !!CFG.crossfeedOn, String(CFG.crossfeedMode), !!CFG.loudCompOn].join('|');
      if (CFG.listenOn) { if (listenSig == null) listenSig = sig; else if (sig !== listenSig) { CFG.listenOn = ''; listenSig = null; try { save(); } catch (er) {} } }
      else listenSig = null;
      contourAppliedK = contourK;
      // ── Vocals (2.12): once, the first time the slider goes past the middle of "softer" ──
      if (cl(CFG.vocalAmt, -100, 100) < -50 && !GET('enh:vocalHint', 0)) { SET('enh:vocalHint', 1); toast('Vocals are softened, not removed — works on stereo mixes'); }
      // ── auto-headroom from the composite response (2.9): overlapping shelves add up,
      //    and with Enhance on the shaper hard-clips anything over 0 dBFS at that point ──
      let headroomDb = 0;
      if (on('eqAutoPre')) {
        const cd = compositeDb();
        for (let i = 0; i < cd.userDb.length; i++) { const v = cd.userDb[i] + (peqOn ? cd.peqDb[i] + peqPre : 0); if (v > headroomDb) headroomDb = v; }
      }
      lastHeadroomDb = headroomDb;
      const preampDb = cl((eqOn ? eqPre : 0) + (peqOn ? peqPre : 0) - headroomDb, -36, 12);
      // ── rumble: from CFG only — Compare never flips it (the type swap is a one-time
      //    transient; the biquad state is not reset on a type change) ──
      const rumbleNeeded = cl(CFG.bassDb, 0, 9) > 0 || (!!CFG.eqOn && (+bands[0] || 0) > 0) || !!CFG.peqOn || !!CFG.loudCompOn || !!CFG.enhanceOn;
      // ── Enhance / Night compressor arbitration (Night wins). Set against Chromium's
      //    per-sample PEAK detector (which sits around −5..−8 dBFS on a modern master),
      //    not against programme LUFS; the trim swaps its auto-makeup for ours ──
      _calibWanted.clear();
      let cp = null;
      if (nightOn) {
        const thr = -24 - 12 * nightAmt, ratio = 2 + 2 * nightAmt;
        const mk = Math.min(22, Math.max(0, -8 - thr) * (1 - 1 / ratio));
        cp = { thr, knee: 24, ratio, att: 0.02, rel: 0.5, trim: db2g(mk - calibrateComp(thr, 24, ratio)) };
      }
      // ── Enhance (2.25 v2): tone + saturation + exciter at intensity enhA; its three-band bank
      //    takes the dynamics unless Night holds the wideband compressor. The trim is the measured
      //    level match (bank on) — with Night, its trim stands and only the block's pre-gain is
      //    given back (the tone then reads as a small, honest lift) ──
      const enhA = enhOn ? enhAmt : 0, bank = enhA > 0 && !nightOn;
      if (!CFG.enhanceOn) { enhTrack.off = 0; enhTrack.lufs = NaN; enhTrack.recent = []; }   // off: the offset rests at 0 for the next time
      const compTrimG = bank ? db2g(-calibrateEnhance(enhA)) : cp ? cp.trim * db2g(ENH_HEAD * enhA) : 1;
      // ── clip guard: the true-peak leg (ceiling TP_CEIL, bypass exact when nothing boosts) where it
      //    is attached and filled, else the compressor leg (−3 dB, 20:1, its auto-makeup trimmed back
      //    out — calibrated only when a chain actually uses it) ──
      const L = needsLimiter();
      let limTrimComp = null; const limTrimFor = () => (limTrimComp == null ? (limTrimComp = L ? db2g(-calibrateComp(-3, 0, 20)) : 1) : limTrimComp);
      // ── vocals: 1 = LP + HP + band = mid exactly; softer floors at 0.1, lift ≤ +4 dB ──
      if (!vocal) { monoSince = 0; monoLow = 0; meter.monoSrc = false; }   // the mono-upload verdict lives only while the knob is in use
      const vG = (vocal === 0 || meter.monoSrc) ? 1 : vocal < 0 ? Math.max(0.1, 1 - 0.9 * Math.abs(vocal)) : db2g(4 * vocal);
      // ── output matrix [LL, LR, RL, RR]: identity → mono / swap → balance (attenuates only) ──
      const bL = 1 - Math.max(0, bal) / 100, bR = 1 - Math.max(0, -bal) / 100;
      const base = on('monoOn') ? [0.5, 0.5, 0.5, 0.5] : on('swapLR') ? [0, 1, 1, 0] : [1, 0, 0, 1];
      const mx = [base[0] * bL, base[1] * bR, base[2] * bL, base[3] * bR];
      // ── routing is decided first: a chain nobody hears gets its params written directly.
      //    AudioParam automation only advances while the node is rendered, so ramping a
      //    detached chain would leave stale events (and stale .value reads) behind ──
      const want = fxOn();
      sceFx.forEach((e) => {
        const c = e.chain; let now = 0; try { now = e.ctx.currentTime || 0; } catch (er) {}
        const w = want ? (p, v, sec) => ramp(p, v, now, sec) : (p, v) => { try { p.cancelScheduledValues(0); p.value = v; } catch (er) {} };
        w(c.preamp.gain, db2g(preampDb));
        if (rumbleNeeded !== !!c.rumbleOn) {
          c.rumbleOn = rumbleNeeded;
          try {
            if (rumbleNeeded) { c.rumble.type = 'highpass'; c.rumble.frequency.value = 25; c.rumble.Q.value = -3.01; c.rumble.gain.value = 0; }
            else { c.rumble.type = 'peaking'; c.rumble.gain.value = 0; c.rumble.Q.value = 1; }
          } catch (er) {}
        }
        w(c.tiltLo.gain, -tilt); w(c.tiltHi.gain, tilt);
        w(c.lcLo.gain, lcDb); w(c.lcHi.gain, lcDb / 3);
        for (let i = 0; i < c.bands.length; i++) w(c.bands[i].gain, eqOn ? cl(bands[i], -12, 12) : 0, 0.02);
        for (let i = 0; i < c.peq.length; i++) {
          const f = peq[i], n = c.peq[i];
          if (f) { try { n.type = f.t === 'LSC' ? 'lowshelf' : f.t === 'HSC' ? 'highshelf' : 'peaking'; n.frequency.value = f.f; if (f.t === 'PK') n.Q.value = f.q; } catch (er) {} w(n.gain, f.g); }
          else { try { if (n.type !== 'peaking') n.type = 'peaking'; } catch (er) {} w(n.gain, 0); }
        }
        w(c.bass.gain, bassDb);
        w(c.hGain.gain, harm, 0.05);
        if ((harm > 0) !== !!c.harmOn) {
          c.harmOn = harm > 0;
          try { if (c.harmOn) c.bass.connect(c.hLP); else setTimeout(() => { try { if (!c.harmOn) { c.hGain.gain.cancelScheduledValues(0); c.hGain.gain.value = 0; c.bass.disconnect(c.hLP); } } catch (er) {} }, 250); } catch (er) {}
        }
        setEnhanceParams(c, enhA, bank, enhTrack.off, w, db2g);
        try {
          const curve = enhA > 0 ? satCurve(enhA) : null;
          if (c.shaper.curve !== curve) c.shaper.curve = curve;
          // the resamplers (and their 192-sample latency) follow the REAL toggle only: Compare
          // nulls the curve but leaves oversample, so the lyric clock stays put. Both shapers
          // switch together — the exciter leg must carry the same delay as the shaper it sums with.
          const os = CFG.enhanceOn ? '4x' : 'none';
          if (c.shaper.oversample !== os) c.shaper.oversample = os;
          if (c.exShape.oversample !== os) c.exShape.oversample = os;
        } catch (er) {}
        w(c.cpG.gain, bank ? 0 : 1, 0.05);
        w(c.comp.threshold, cp ? cp.thr : 0, 0.05); w(c.comp.knee, cp ? cp.knee : 0, 0.05); w(c.comp.ratio, cp ? cp.ratio : 1, 0.05);
        if (cp) { w(c.comp.attack, cp.att, 0.05); w(c.comp.release, cp.rel, 0.05); }
        w(c.compTrim.gain, compTrimG, 0.05);
        w(c.widener.gain, width, 0.05);
        w(c.vGain.gain, vG, 0.05);
        w(c.cfFeedL.gain, cfF, 0.05); w(c.cfFeedR.gain, cfF, 0.05); w(c.cfNegL.gain, -cfF, 0.05); w(c.cfNegR.gain, -cfF, 0.05);
        w(c.gLL.gain, mx[0]); w(c.gLR.gain, mx[1]); w(c.gRL.gain, mx[2]); w(c.gRR.gain, mx[3]);
        w(c.rvWet.gain, rv, 0.05);
        if ((rv > 0) !== !!c.rvOn) {
          c.rvOn = rv > 0;
          try {
            if (c.rvOn) { if (!c.conv.buffer) c.conv.buffer = reverbIr(e.ctx); c.mxMerge.connect(c.conv); c.conv.connect(c.rvWet); }
            else setTimeout(() => { try { if (!c.rvOn) { c.rvWet.gain.cancelScheduledValues(0); c.rvWet.gain.value = 0; c.mxMerge.disconnect(c.conv); c.conv.disconnect(c.rvWet); } } catch (er) {} }, 250);
          } catch (er) {}
        }
        if (!keep('loudnessOn')) w(c.makeup.gain, 1, 0.05);   // Compare never touches the loudness gain
        w(c.boost.gain, boost, 0.05);
        const tp = !!(c.tpl && c.tplReady);
        w(c.gA.gain, tp ? 0 : 1, 0.05); w(c.gB.gain, tp ? 1 : 0, 0.05);
        w(c.lim.threshold, !tp && L ? -3 : 0); w(c.lim.knee, 0); w(c.lim.ratio, !tp && L ? 20 : 1);
        try { c.lim.attack.value = 0.001; c.lim.release.value = 0.08; } catch (er) {}
        w(c.limTrim.gain, tp ? 1 : limTrimFor());
        if (c.tpl) {   // bypass is a hard flip inside the worklet: engage at once, release 100 ms later so a ramping boost can settle first
          try {
            const bp = c.tpl.parameters.get('bypass'); c.tpl.parameters.get('ceiling').value = TP_CEIL;
            bp.cancelScheduledValues(0);
            if (!tp || !L) { if (want && tp) bp.setValueAtTime(1, now + 0.1); else bp.value = 1; } else bp.setValueAtTime(0, want ? now : 0);
          } catch (er) {}
        }
        if (!keep('fadeOn') && !sleepFadeOn) { try { c.output.gain.cancelScheduledValues(now); c.output.gain.setValueAtTime(1, now); c.output.gain.value = 1; } catch (er) {} }
      });
      if (!keep('fadeOn')) fadeCtl.reset();
      try { sceMediaEls.forEach(syncPitch); } catch (er) {}   // vinyl mode (2.20) is an element property
      // ── routing, per chain entry; fxRouted = "any entry routed" (latency + loudness gates) ──
      let any = false;
      sceFx.forEach((e) => { if (e.routed !== want) { e.routed = want; try { e.reroute(); } catch (er) {} } if (e.routed) any = true; });
      fxRouted = any;
      // ── the loudness measurement loop runs only while it can hear something ──
      const wantLoud = (keep('loudnessOn') || !!CFG.enhanceOn) && fxRouted;   // Enhance's programme tracker rides the same tick
      if (wantLoud && !loudTimer) { loudTimer = setInterval(loudTick, 500); lastLoudUrl = null; try { restoreTrackLoud(); } catch (er) {} }
      else if (!wantLoud && loudTimer) { clearInterval(loudTimer); loudTimer = 0; }
      if (!keep('loudnessOn')) { if (lnorm.href != null || lnorm.src || lnorm.blocks.length) loudReset(null); lastLoudUrl = null; lnorm.nodeDb = 0; }
      else loudRetarget();   // a new target or guard state re-applies the gain immediately
      eqCurveVer++;
      try { refreshBar(); } catch (er) {}   // the player-bar FX glow (WP10)
    } catch (e) { Log.err('applyFx', e); }
  }
  // ── Listening on (2.13): one tap sets a bundle for the output in use. Never auto-applied
  //    (no device detection); `listenOn` only remembers which chip is lit ──
  const LISTEN_ON = {
    headphones: { set: { crossfeedOn: true, crossfeedMode: 'natural', bassDb: 2, loudCompOn: false }, toast: 'Headphones · crossfeed + bass +2 dB' },
    laptop: { set: { crossfeedOn: false, bassDb: 3, tiltDb: 1, loudCompOn: true }, toast: 'Laptop · bass +3 dB, brighter, loudness contour' },
    speakers: { set: { crossfeedOn: false, bassDb: 0, tiltDb: 0, loudCompOn: false }, toast: 'Speakers · neutral' },
  };
  function applyListenOn(which) {
    try {
      const p = LISTEN_ON[which]; if (!p) return;
      Object.assign(CFG, p.set);
      CFG.listenOn = which; listenSig = null;   // applyFx records the bundle it now sees
      save(); applyFx(); toast(p.toast);
    } catch (e) { Log.err('applyListenOn', e); }
  }
  // ── Loudness contour (2.14): SoundCloud's volume slider drives element.volume (the OS
  //    volume is invisible to a page); below 0.45 the 100 Hz / 8 kHz shelves rise toward
  //    loudCompAmt (bass) and a third of it (treble), with a 0.3 s time constant. Run by the
  //    enforce tick; the headroom part of applyFx re-runs once the depth moved > 0.5 dB ──
  function updateContour(m) {
    try {
      let v = +m.volume; if (!isFinite(v)) v = 1;
      contourK = Math.max(0, Math.min(1, (0.45 - v) / 0.45));
      const amt = Math.max(0, Math.min(9, +CFG.loudCompAmt || 0));
      const db = (!fxBypass && !!CFG.loudCompOn) ? contourK * amt : 0;
      sceFx.forEach((e) => {
        if (!e.routed) return;   // a detached chain gets no automation (applyFx writes it directly)
        try { const now = e.ctx.currentTime || 0; e.chain.lcLo.gain.setTargetAtTime(db, now, 0.3); e.chain.lcHi.gain.setTargetAtTime(db / 3, now, 0.3); } catch (er) {}
      });
      if (Math.abs((contourK - contourAppliedK) * amt) > 0.5) applyFx();
    } catch (e) {}
  }
  // post-limiter peak / mean power (what actually reaches the speakers) plus the
  // untouched source peak, read from the newest routed chain's taps into `meter` (dBFS)
  function peakTick(vote) {   // vote: the 1 Hz / 500 ms meter ticks decide the mono-upload verdict; the tab's 10 Hz reads only paint
    try {
      let e = null; sceFx.forEach((x) => { if (x.routed) e = x; }); if (!e) return;
      const c = e.chain;
      const rd = (a, b) => { a.getFloatTimeDomainData(b); let pk = 0, ss = 0; for (let i = 0; i < b.length; i++) { const v = b[i]; ss += v * v; const av = v < 0 ? -v : v; if (av > pk) pk = av; } return { pk, ss, n: b.length }; };
      const l = rd(c.oL, c.bufOL), r = rd(c.oR, c.bufOR), pk = Math.max(l.pk, r.pk), ms = (l.ss + r.ss) / (l.n + r.n);
      meter.peak = pk > 1e-6 ? 20 * Math.log10(pk) : -120;
      meter.outDb = ms > 1e-12 ? 10 * Math.log10(ms) : -120;
      const sl = rd(c.pL, c.bufPL), sr = rd(c.pR, c.bufPR), spk = Math.max(sl.pk, sr.pk);
      meter.srcPeak = spk > 1e-6 ? 20 * Math.log10(spk) : -120;
      try { meter.gr = c.comp.reduction; meter.limGr = (c.tpl && c.tplReady) ? -(+c.tpl.gainReduction || 0) : c.lim.reduction; } catch (er) {}
      // stereo correlation (WP10): Pearson r of the source taps (NaN on silence — no verdict). A mono upload (r > 0.98
      // for 3 s) has no side signal, so softening the vocal band would only dip the whole mix: while the Vocals knob is
      // in use the guard forces vGain to 1 and the row reads "Mono upload", until a stereo track (r ≤ 0.98) arrives.
      // The window runs only while Vocals ≠ 0 — there is nothing to guard at Normal.
      // The taps are read one after the other, so a render quantum landing between the reads shifts R against L
      // by 128 samples (a sine's r collapses): re-read L and compare the tail — a changed tail = no verdict this tick.
      const bl = c.bufPL, br = c.bufPR, n = bl.length; let sL = 0, sR = 0, sLR = 0, raced = false;
      try { const tail = Array.prototype.slice.call(bl, n - 8); c.pL.getFloatTimeDomainData(c.bufOL); for (let i = 0; i < 8; i++) if (c.bufOL[n - 8 + i] !== tail[i]) { raced = true; break; } } catch (er) { raced = true; }
      for (let i = 0; i < n; i++) { sL += bl[i]; sR += br[i]; sLR += bl[i] * br[i]; }
      const den = Math.sqrt(Math.max(0, (n * sl.ss - sL * sL) * (n * sr.ss - sR * sR)));
      const corr = (!raced && den > 1e-9) ? Math.max(-1, Math.min(1, (n * sLR - sL * sR) / den)) : NaN;
      if (!raced) meter.corr = corr;   // a raced read casts no vote and leaves the displayed value alone (no tick flicker); silence clears it
      // a stereo track reads low on every tick, so three low reads in a row lift the verdict; one stray read never does
      const guard = (+CFG.vocalAmt || 0) !== 0;
      const lift = () => { monoSince = 0; monoLow = 0; if (meter.monoSrc) { meter.monoSrc = false; applyFx(); } };
      if (!vote) return;
      if (!guard) lift();
      else if (corr > 0.98) { monoLow = 0; const t = Date.now(); if (!monoSince) monoSince = t; else if (t - monoSince > 3000 && !meter.monoSrc) { meter.monoSrc = true; applyFx(); } }
      else if (corr <= 0.98 && ++monoLow >= 3) lift();
    } catch (e) {}
  }
  // ── Loudness normalize (2.4): K-weighted, gated, measured at `input` (the untouched
  //    source, so the value is the track's — ReplayGain semantics — whatever the chain does) ──
  const newestRouted = () => { let e = null; sceFx.forEach((x) => { if (x.routed) e = x; }); return e; };
  function loudReset(href) {
    lnorm.href = href; lnorm.blocks = []; lnorm.recent = []; lnorm.trackPeak = 0; lnorm.curGainDb = 0; lnorm.lint = NaN; lnorm.dur = NaN;
    lnorm.measuring = true; lnorm.src = ''; lnorm.pending = false; lnorm.lastWrite = 0;
    delete meter.m; delete meter.s; delete meter.i; delete meter.gainDb;
  }
  // the gain for a track of integrated loudness `lint` and sample peak `peak` (linear): the
  // target delta, never past 0.98 FS at the source (+3 dB of limiting budget while the guard
  // is on — what the streaming services allow), clamped −15..+12
  function loudGainDb(lint, peak) {
    const tg = AUDIO_CLAMP.loudTarget.one.indexOf(+CFG.loudTarget) >= 0 ? +CFG.loudTarget : -14;
    const budget = CFG.limiterOn ? 3 : 0;
    const g = Math.min(tg - lint, 20 * Math.log10(0.98 / Math.max(+peak || 0, 1e-4)) + budget);
    return isFinite(g) ? Math.max(-15, Math.min(12, g)) : 0;
  }
  // the target / guard state a gain was computed for
  const loudTgKey = () => (+CFG.loudTarget) + '|' + (CFG.limiterOn ? 1 : 0);
  // write the makeup gain of every routed chain: fast = a 50 ms ramp (a remembered value at track
  // start, a new target); otherwise asymmetric — down in ~1 s (a loud drop after a quiet intro),
  // up over ~10 s (a correction upward is never a jump)
  function loudWrite(gDb, fast) {
    const g = Math.pow(10, gDb / 20), down = gDb < lnorm.nodeDb;
    sceFx.forEach((e) => {
      if (!e.routed) return;
      const p = e.chain.makeup.gain, now = e.ctx.currentTime || 0;
      try {
        if (fast) ramp(p, g, now, 0.05);
        else { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.setTargetAtTime(g, now, down ? 0.3 : 3); }
      } catch (er) { try { p.value = g; } catch (e2) {} }
    });
    lnorm.curGainDb = gDb; lnorm.nodeDb = gDb; meter.gainDb = gDb; lnorm.tgKey = loudTgKey();
  }
  // a new target / guard state re-applies the current track's gain at once (2.4 "immediately"); no-op until one is known
  function loudRetarget() {
    try {
      if (!CFG.loudnessOn || !lnorm.src || !isFinite(lnorm.lint) || lnorm.tgKey === loudTgKey()) return;
      const g = loudGainDb(lnorm.lint, lnorm.trackPeak);
      if (Math.abs(g - lnorm.curGainDb) > 0.01) { loudWrite(g, true); rememberLoud(true); }
      else lnorm.tgKey = loudTgKey();
    } catch (e) {}
  }
  // the 500 ms loop: output meter, then one 400 ms K-weighted block from the source taps →
  // momentary / short-term / gated integrated loudness → the gain once 3 s have been heard
  function loudTick() {
    peakTick(true);
    try { enhTick(); } catch (e) {}
    try {
      if (!CFG.loudnessOn) return;
      const e = newestRouted(); if (!e) return;
      restoreTrackLoud();   // a track change, or a restore deferred until the duration is known
      const m = activeMedia();
      if (!m || m.paused || !(m.readyState > 0)) return;
      if (isFinite(m.duration) && m.duration > 0) lnorm.dur = m.duration;
      if (!lnorm.measuring) return;   // a complete remembered value is applied — nothing to measure
      const c = e.chain, sr = e.ctx.sampleRate || 48000;
      // 400 ms (up to 81.9 kHz), capped at the tap size: an unguarded 38 400 at 96 k would index below 0
      const n = Math.max(1, Math.min(Math.round(0.4 * sr), c.bufKL.length));
      c.kL.getFloatTimeDomainData(c.bufKL); c.kR.getFloatTimeDomainData(c.bufKR);
      const ms = (b) => { let s = 0; for (let i = b.length - n; i < b.length; i++) s += b[i] * b[i]; return s / n; };
      const pw = ms(c.bufKL) + ms(c.bufKR);
      // the source sample peak (peakTick just read the whole pL/pR buffers into meter.srcPeak, dBFS)
      if (isFinite(meter.srcPeak) && meter.srcPeak > -119) lnorm.trackPeak = Math.max(lnorm.trackPeak, Math.pow(10, meter.srcPeak / 20));
      if (!(pw >= 1e-12)) return;   // silence (or NaN): no block
      const Lb = -0.691 + 10 * Math.log10(pw);
      meter.m = Lb;
      lnorm.recent.push(pw); if (lnorm.recent.length > 6) lnorm.recent.shift();
      meter.s = -0.691 + 10 * Math.log10(lnorm.recent.reduce((a, b) => a + b, 0) / lnorm.recent.length);
      if (Lb > -70 && lnorm.blocks.length < 3000) lnorm.blocks.push(Lb);   // absolute gate; 25 min cap
      const bl = lnorm.blocks; if (!bl.length) return;
      const P = bl.map((L) => Math.pow(10, (L + 0.691) / 10));
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const Lrel = -0.691 + 10 * Math.log10(mean(P)) - 10;   // relative gate
      const above = P.filter((v, i) => bl[i] > Lrel);
      if (!above.length) return;
      lnorm.lint = -0.691 + 10 * Math.log10(mean(above));
      meter.i = lnorm.lint;
      if (bl.length >= 6) {   // 3 s heard — never a gain from a 1.5 s intro
        lnorm.pending = false;
        const g = loudGainDb(lnorm.lint, lnorm.trackPeak);
        if (Math.abs(g - lnorm.curGainDb) > 0.5) { loudWrite(g, false); lnorm.src = 'measured'; rememberLoud(true); }
        else if (!lnorm.src) { lnorm.src = 'measured'; lnorm.curGainDb = lnorm.nodeDb; meter.gainDb = lnorm.nodeDb; lnorm.tgKey = loudTgKey(); rememberLoud(true); }
        else rememberLoud(false);   // the 30 s cadence
      }
    } catch (e) {}
  }
  // ── per-track loudness memory (2.5): GM 'loud:bytrack' → { [href]: { l, p, s, d, t, f } } ──
  // l / p are SOURCE values (taps at `input`), so they stay valid whatever the chain does later;
  // f = 1 once at least min(60 s, half the track) has been heard (a complete measurement)
  function rememberLoud(force) {
    try {
      if (!CFG.loudnessOn || !lnorm.href || !isFinite(lnorm.lint) || lnorm.blocks.length < 6) return;
      if (!force && Date.now() - lnorm.lastWrite < 30000) return;
      lnorm.lastWrite = Date.now();
      const s = lnorm.blocks.length * 0.5, d = isFinite(lnorm.dur) ? lnorm.dur : 0;
      let map = GET('loud:bytrack', {}); if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
      const old = map[lnorm.href];
      // a partial re-measurement never replaces a longer one of the same upload
      if (old && typeof old === 'object' && Math.abs((+old.d || 0) - d) <= 2 && s < (+old.s || 0)) return;
      map[lnorm.href] = { l: Math.round(lnorm.lint * 10) / 10, p: Math.round(lnorm.trackPeak * 1000) / 1000, s: Math.round(s * 10) / 10, d: Math.round(d * 10) / 10, t: Date.now(), f: s >= Math.min(60, 0.5 * d) ? 1 : 0 };
      const keys = Object.keys(map);
      if (keys.length > 1000) { keys.sort((a, b) => (+(map[a] && map[a].t) || 0) - (+(map[b] && map[b].t) || 0)); for (let i = 0; i < keys.length - 1000; i++) delete map[keys[i]]; }
      SET('loud:bytrack', map);
    } catch (e) {}
  }
  // on a track change (enforce, the loudness tick, a captured element's `playing`): flush the old
  // track's memory, reset the measurement, and apply a remembered value at once — no slow ramp.
  // A remembered value is used only when the duration matches (same upload); a complete one
  // (f = 1) ends the measuring for this track, a partial one is refined and overwritten.
  function restoreTrackLoud() {
    try {
      if (!CFG.loudnessOn) return;
      const href = curTrackHref();
      if (href !== lastLoudUrl) {
        rememberLoud(true);
        lastLoudUrl = href; loudReset(href);
        lnorm.pending = !!href;
      }
      if (!lnorm.pending) return;
      let map = GET('loud:bytrack', {}); if (!map || typeof map !== 'object') map = {};
      const entry = map[lnorm.href];
      if (!entry || typeof entry !== 'object' || !isFinite(+entry.l)) {
        // an unknown track starts at unity: never carry a quiet track's +9 dB into the next one
        lnorm.pending = false; if (lnorm.nodeDb !== 0) loudWrite(0, true); lnorm.curGainDb = 0;
        return;
      }
      const m = activeMedia(), d = m ? +m.duration : NaN;
      if (!isFinite(d) || d <= 0) return;   // metadata not there yet — again next tick (the measurement takes over after 3 s anyway)
      lnorm.pending = false; lnorm.dur = d;
      if (Math.abs((+entry.d || 0) - d) > 2) { if (lnorm.nodeDb !== 0) loudWrite(0, true); lnorm.curGainDb = 0; return; }   // a different upload at this href
      lnorm.lint = +entry.l; lnorm.trackPeak = Math.max(lnorm.trackPeak, +entry.p || 0); meter.i = lnorm.lint;
      loudWrite(loudGainDb(lnorm.lint, lnorm.trackPeak), true);
      lnorm.src = 'remembered';
      if (entry.f) lnorm.measuring = false;
    } catch (e) {}
  }
  try { W.addEventListener('pagehide', () => { try { rememberLoud(true); } catch (e) {} }); } catch (e) {}
  /* fades (2.21) — event-driven, on `output` (the last node, after the limiter, so a fade never
   * triggers gain reduction). `play` only ARMS the gain at the floor so nothing bursts before audio
   * flows; `playing` (audio actually flowing — the decoder's start-up no longer eats the ramp) fades
   * in, the full length for a fresh start and a short one when the same track resumes after a pause;
   * `timeupdate` (≈ 4 Hz) schedules ONE exponential fade-out into the last `fadeOut` seconds, its
   * length divided by the playback rate; `seeking` clears it and restores unity unless the seek lands
   * inside the fade-out window (the next timeupdate reschedules). A user seek (restart / nudge /
   * seekPct / the A–B wrap) in the last 500 ms skips the arm and the fade so a jump never dips the
   * level. The enforce tick re-runs the timeupdate check as a backstop; nothing here ever throws. */
  const FADE_FLOOR = 0.04;
  let __sceUserSeek = 0;          // Date.now() of the last suite-initiated seek
  let silentSince = 0;            // end-trim (WP10): when the source peak first read below −60 dBFS inside the last 30 s
  let fadeHref = null;            // the track the last fade-in was for
  let fadeOutSched = false;       // one fade-out per track
  let fadeInAt = 0;               // Date.now() of the last fade-in (guards the href-change fade against a double dip)
  let fadeOutInfo = null;         // the last scheduled fade-out { at, dur, rate, remain } (debug)
  const fadeLen = () => ({ fi: clampNum(CFG.fadeIn == null ? 0.6 : CFG.fadeIn, 0, 3, 0), fo: clampNum(CFG.fadeOut == null ? 2.5 : CFG.fadeOut, 0, 8, 0) });
  const fadeEach = (fn) => { sceFx.forEach((e) => { try { fn(e.chain.output.gain, e.ctx.currentTime || 0); } catch (er) {} }); };
  const fadeUnity = () => fadeEach((g, t) => { g.cancelScheduledValues(t); g.setValueAtTime(1, t); });
  const fadeInNow = (len) => {
    fadeInAt = Date.now();
    fadeEach((g, t) => { g.cancelScheduledValues(t); if (len > 0) { g.setValueAtTime(FADE_FLOOR, t); g.exponentialRampToValueAtTime(1, t + len); } else g.setValueAtTime(1, t); });
  };
  const inFadeOutWindow = (m, fo) => { const dur = m.duration, cur = m.currentTime; return isFinite(dur) && dur > 8 && isFinite(cur) && fo > 0 && (dur - cur) <= fo + 0.25; };
  // the gain writes are global (one output gain per chain) while the events are per element: a
  // `play` on a second element while the active track is flowing (SoundCloud pre-positioning the
  // next track) or a `seeking` on a paused, non-active one must not touch the active track's level
  const otherFlowing = (m) => { let o = false; try { sceMediaEls.forEach((x) => { if (x !== m && !x.paused && x.readyState > 0) o = true; }); } catch (e) {} return o; };
  const fadeCtl = {
    onPlay(m) {
      if (!CFG.fadeOn || !m || otherFlowing(m)) return;
      if (Date.now() - __sceUserSeek < 500) { m.__sceFade = 'seek'; return; }   // a jump: never dip
      m.__sceFade = 'armed';
      fadeEach((g, t) => { g.cancelScheduledValues(t); g.setValueAtTime(FADE_FLOOR, t); });
    },
    onPlaying(m) {
      if (!CFG.fadeOn || !m) return;
      const href = curTrackHref(), same = href === fadeHref, st = m.__sceFade;
      if (!same) fadeOutSched = false;
      fadeHref = href;
      if (Date.now() - __sceUserSeek < 500 || st === 'seek') { m.__sceFade = 'flowing'; if (!fadeOutSched) fadeUnity(); return; }
      if (st === 'flowing' && same) return;   // a stall or a seek on a flowing track: leave the gain alone
      m.__sceFade = 'flowing';
      const { fi } = fadeLen();
      fadeInNow(same && m.currentTime > 1 ? Math.min(fi, 0.15) : fi);
    },
    onTimeUpdate(m) {
      if (!CFG.fadeOn || !m || m.paused) return;
      const { fi, fo } = fadeLen();
      // a new track on the same element (SoundCloud swaps src) or the badge catching up: fade it in once
      const href = curTrackHref();
      if (href !== fadeHref) {
        fadeHref = href; fadeOutSched = false;
        if (Date.now() - fadeInAt > 1200 && m.currentTime < 2) { m.__sceFade = 'flowing'; fadeInNow(fi); }
      }
      const dur = m.duration, cur = m.currentTime;
      if (fadeOutSched) {
        // a wrap (element loop) lands well before the window with the fade-out still armed: start over
        if (isFinite(dur) && isFinite(cur) && cur < dur - fo - 1) { fadeOutSched = false; fadeInNow(fi); }
        return;
      }
      if (!inFadeOutWindow(m, fo)) return;
      const remain = Math.max(0.05, (dur - cur) / Math.max(0.25, m.playbackRate || 1));
      fadeEach((g, t) => { g.cancelScheduledValues(t); g.setValueAtTime(Math.max(FADE_FLOOR, g.value), t); g.exponentialRampToValueAtTime(FADE_FLOOR, t + remain); });
      fadeOutSched = true; fadeOutInfo = { at: cur, dur, rate: m.playbackRate || 1, remain };
    },
    onSeeking(m) {
      if (!CFG.fadeOn || !m || (m.paused && m !== activeMedia())) return;
      fadeOutSched = false;
      if (inFadeOutWindow(m, fadeLen().fo)) return;   // the next timeupdate reschedules the fade-out
      fadeUnity();
    },
    onRate(m) { if (CFG.fadeOn && m && !m.paused && fadeOutSched && m === activeMedia()) fadeOutSched = false; },
    onPause(m) { try { if (m && m.__sceFade !== 'seek') m.__sceFade = 'paused'; } catch (e) {} },
    onEnded(m) { fadeOutSched = false; try { if (m) m.__sceFade = 'ended'; } catch (e) {} },
    reset() { fadeHref = null; fadeOutSched = false; fadeInAt = 0; },
    state() { return { href: fadeHref, outScheduled: fadeOutSched, out: fadeOutInfo, userSeekAgo: __sceUserSeek ? Date.now() - __sceUserSeek : null }; },
  };
  // Install the Web Audio captures ONCE at module load (document_start, before
  // SoundCloud builds its audio graph). All wrappers preserve native behaviour
  // exactly and are inert at 1×, so they can't affect normal playback.
  (function hookWebAudio() {
    try {
      // a) capture elements made via `new Audio()`
      try {
        const OrigAudio = W.Audio;
        if (typeof OrigAudio === 'function' && !OrigAudio.__sceWrapped) {
          const Wrapped = function () { const el = arguments.length ? new OrigAudio(arguments[0]) : new OrigAudio(); try { captureMedia(el); } catch (e) {} return el; };
          Wrapped.prototype = OrigAudio.prototype; Wrapped.__sceWrapped = true;
          try { W.Audio = Wrapped; } catch (e) {}
        }
      } catch (e) {}
      // b) hook the AudioContext: the element fed to createMediaElementSource is
      //    SoundCloud's real audio element (works even when it's not in the DOM);
      //    also force the rate on any raw buffer sources
      const AC = W.AudioContext || W.webkitAudioContext;
      if (AC && !AC.prototype.__sceHooked) {
        AC.prototype.__sceHooked = true;
        const oMES = AC.prototype.createMediaElementSource;
        if (oMES) AC.prototype.createMediaElementSource = function (el) { try { captureMedia(el); } catch (e) {} try { sceLastCtx = this; loadGuard(this); } catch (e) {} const node = oMES.apply(this, arguments); try { installFx(this, node); } catch (e) {} return node; };
        const oBS = AC.prototype.createBufferSource;
        if (oBS) AC.prototype.createBufferSource = function () {
          const node = oBS.apply(this, arguments);
          try {
            sceBufNodes.add(node);
            const drop = () => { try { sceBufNodes.delete(node); } catch (e) {} };
            if (node.addEventListener) node.addEventListener('ended', drop);
            // the rate is decided at start(), when the buffer is known: only real tracks follow the speed (2.31)
            const ost = node.start; if (typeof ost === 'function') node.start = function () { try { const w = wantedRate(); if (w !== 1 && node.playbackRate && node.buffer && node.buffer.duration > 30) node.playbackRate.value = w; } catch (e) {} return ost.apply(this, arguments); };
            const os = node.stop; if (typeof os === 'function') node.stop = function () { drop(); return os.apply(this, arguments); };
            const od = node.disconnect; if (typeof od === 'function') node.disconnect = function () { drop(); return od.apply(this, arguments); };
          } catch (e) {}
          return node;
        };
      }
    } catch (e) {}
  })();
  // some promo banners (e.g. the "Keep 100% royalties" distribution bar) carry
  // no upsell-ish class for CSS to target, so match them by TEXT and hide the
  // full-width bar. Bounded + text-gated so it can never touch real content.
  let _upsellTick = 0;
  function killUpsellBanners() {
    try {
      // The full-document scan below is costly; the promo bar appears rarely and
      // hiding it a few seconds late is invisible, so run it every ~5s, not every tick.
      if ((_upsellTick++ % 5) !== 0) return;
      const RX = /100%\s*royalt|distribute to every major|unlock new ways to get paid|keep 100%|earn more without fees/i;
      // scan all block elements (the banner often has no upsell-ish class and
      // sits deep in the tree); the children-count guard keeps it cheap by only
      // reading textContent on small, leaf-ish elements
      const cand = D.querySelectorAll('div,section,aside');
      const vw = (W.innerWidth || 1280) * 0.65;
      for (const el of cand) {
        if (el.__sceKilled || el.children.length > 6) continue;
        // never inside real content: a comment or description that quotes the
        // upsell wording is the user's, not SoundCloud's
        if (el.closest && el.closest('.commentsList,.commentItem,.commentNode,.soundDescription,.truncatedAudioInfo,.soundList__item,.trackList__item,.soundTitle')) continue;
        const t = el.textContent;
        if (!t || t.length < 10 || t.length > 360 || !RX.test(t)) continue;
        // climb to find a VERIFIED full-width/short banner bar; if none is found
        // we hide only the original text-gated element — never an unverified
        // ancestor, so we can't nuke a large legit container
        let n = el, bar = null;
        for (let i = 0; i < 5 && n && n !== D.body; i++) {
          if (n.offsetWidth >= vw && n.offsetHeight > 0 && n.offsetHeight < 220) { bar = n; break; }
          n = n.parentElement;
        }
        const target = bar || el;
        target.__sceKilled = true; target.style.setProperty('display', 'none', 'important');
        return;
      }
    } catch (e) {}
  }
  /* ── resume long tracks: per-track position memory for mixes and podcasts ──
   * SoundCloud restores only the queue's current track after a reload; a two-hour mix you left
   * on Tuesday starts from the top on Friday. While a track of ten minutes or more plays, its
   * position is saved every 5 s (from 60 s in; a finished track drops its entry). When such a
   * track later starts from the top, a chip offers "Resume at h:mm:ss" (or auto mode seeks at
   * once). Up to 60 tracks, a month each, all local. */
  const RESUME_KEY = 'enh:resumeMap', RESUME_MIN_DUR = 600, RESUME_MAX = 60, RESUME_TTL = 30 * 864e5;
  let resumeSavedAt = 0, resumePending = null, resumeChip = null, resumeChipT = 0, resumeSeenHref = null, resumeOfferedFor = null;
  function fmtClock(sec) { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0'); }
  function resumeMap() { const o = GET(RESUME_KEY, null); return (o && typeof o === 'object') ? o : {}; }
  function resumeForget(href) { const map = resumeMap(); if (href in map) { delete map[href]; SET(RESUME_KEY, map); } }
  function recordResume(m) {
    if (CFG.resumePos === 'off' || !m || m.paused || !isFinite(m.duration) || m.duration < RESUME_MIN_DUR) return;
    const now = Date.now(); if (now - resumeSavedAt < 5000) return;
    resumeSavedAt = now;
    const href = curTrackHref(); if (!href) return;
    const pos = m.currentTime, left = m.duration - pos;
    if (left < 30) { resumeForget(href); return; }   // finished: never offered again
    if (pos < 60) return;
    const map = resumeMap();
    map[href] = { pos: Math.round(pos), dur: Math.round(m.duration), t: now };
    const keys = Object.keys(map);
    if (keys.length > RESUME_MAX) { keys.sort((a, b) => (map[a].t || 0) - (map[b].t || 0)); keys.slice(0, keys.length - RESUME_MAX).forEach((k) => { delete map[k]; }); }
    SET(RESUME_KEY, map);
  }
  function hideResumeChip() { clearTimeout(resumeChipT); if (resumeChip) { try { resumeChip.remove(); } catch (e) {} resumeChip = null; } }
  function showResumeChip(pos) {
    hideResumeChip();
    const c = D.createElement('div'); c.setAttribute('data-sce-resume', '1'); c.setAttribute('role', 'status');
    c.style.cssText = 'position:fixed;left:50%;bottom:62px;transform:translateX(-50%);z-index:2147483399;display:flex;align-items:center;gap:2px;background:rgba(22,22,26,.94);color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:3px 4px 3px 6px;box-shadow:0 10px 30px rgba(0,0,0,.45);font:600 12.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;backdrop-filter:blur(10px)';
    const go = D.createElement('button'); go.type = 'button'; go.textContent = '▶  Resume at ' + fmtClock(pos);
    go.style.cssText = 'all:unset;cursor:pointer;padding:7px 10px;border-radius:999px;color:#fff';
    go.addEventListener('click', () => { const m = activeMedia(); if (m) applyResume(m, true); else hideResumeChip(); });
    const no = D.createElement('button'); no.type = 'button'; no.textContent = '✕'; no.title = 'Start from the top'; no.setAttribute('aria-label', 'Start from the top');
    no.style.cssText = 'all:unset;cursor:pointer;padding:7px 9px;border-radius:999px;color:#9a9aa2';
    no.addEventListener('click', () => { resumePending = null; hideResumeChip(); });
    for (const b of [go, no]) { b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,.1)'; }); b.addEventListener('mouseleave', () => { b.style.background = ''; }); b.addEventListener('focus', () => { b.style.boxShadow = '0 0 0 2px #ff5500'; }); b.addEventListener('blur', () => { b.style.boxShadow = ''; }); }
    c.append(go, no); (D.body || D.documentElement).appendChild(c); resumeChip = c;
    resumeChipT = setTimeout(() => { resumePending = null; hideResumeChip(); }, 30000);   // an unanswered offer expires
  }
  function offerResume(m) {   // once per track start: from the tick and from the element's `playing`
    if (CFG.resumePos === 'off' || !m || m.paused) return;
    const href = curTrackHref(); if (!href) return;
    if (href !== resumeSeenHref) { resumeSeenHref = href; resumeOfferedFor = null; if (resumePending && resumePending.href !== href) { resumePending = null; hideResumeChip(); } }
    if (resumeOfferedFor === href) return;
    if (!isFinite(m.duration) || m.duration < RESUME_MIN_DUR) return;   // duration arrives a moment after `playing`: try again next tick
    resumeOfferedFor = href;
    const e = resumeMap()[href];
    if (!e || !(e.pos >= 60) || Date.now() - (e.t || 0) > RESUME_TTL) return;
    if (m.currentTime > 8) return;   // not starting from the top (SoundCloud's own queue restore, or a seek)
    resumePending = { href, pos: e.pos };
    if (CFG.resumePos === 'auto') applyResume(m, true); else showResumeChip(e.pos);
  }
  function applyResume(m, now) {   // `now` = the user asked (chip) or auto mode; otherwise only a pending offer that is still valid
    if (!resumePending || !m || !isFinite(m.duration)) return;
    if (curTrackHref() !== resumePending.href) { resumePending = null; hideResumeChip(); return; }
    if (!now) return;
    const pos = Math.min(resumePending.pos, m.duration - 5);
    resumePending = null; hideResumeChip();
    __sceUserSeek = Date.now(); try { m.currentTime = pos; } catch (e) {}
    resumeSavedAt = 0;
    toast('Resumed at ' + fmtClock(pos));
  }

  function enforce() {
    try {
      applySpeed();   // runs every tick + immediately on cycleSpeed; works even before activeMedia resolves
      try { killUpsellBanners(); } catch (e) {}
      try { if (sleepEls) paintSleep(); } catch (e) {}
      try { if (CFG.speedPerTrack) restoreTrackSpeed(); } catch (e) {}
      try { if (CFG.eqPerTrack) restoreTrackEq(); } catch (e) {}
      try { restoreTrackLoud(); } catch (e) {}
      try { if (fxRouted && !loudTimer) peakTick(true); } catch (e) {}
      try { if (CFG.fadeOn) fadeCtl.onTimeUpdate(activeMedia()); } catch (e) {}   // backstop for a missed timeupdate
      const m = activeMedia();
      if (!m) return;
      try { offerResume(m); recordResume(m); applyResume(m); } catch (e) {}
      // end-of-track silence trim (WP10): source peak < −60 dBFS for 2 s with under 30 s left → seek to the end.
      // Never mid-track (HLS seeks rebuffer, and ambient music has real silences); a rumble-free read is the tap's own.
      try {
        const left = isFinite(m.duration) ? m.duration - m.currentTime : NaN;
        // the taps sit after the element's own volume: undo the slider before comparing (a mute or a near-silent level is
        // not a silent ending) and only read buffered audio (a stall reads silent too)
        const vol = m.muted ? 0 : +m.volume;
        if (CFG.skipSilence && fxRouted && !m.paused && m.readyState >= 3 && vol >= 0.02 && left < 30 && left > 0.5 && meter.srcPeak - 20 * Math.log10(vol) < -60) {
          if (!silentSince) silentSince = Date.now();
          else if (Date.now() - silentSince > 2000) { silentSince = 0; __sceUserSeek = Date.now(); m.currentTime = m.duration - 0.2; toast('Skipped the silent ending'); }
        } else silentSince = 0;
      } catch (e) {}
      try { updateContour(m); } catch (e) {}
      // loop — only ever ASSERT our own loop; never force-off (so we don't
      // fight SoundCloud's native repeat button)
      try {
        if (CFG.loopTrack) { if (!m.loop) { m.loop = true; m.__sceLoop = true; } }
        else if (m.loop && m.__sceLoop) { m.loop = false; m.__sceLoop = false; }
      } catch (e) {}
      // remember volume: restore once when media first has a usable volume
      if (CFG.rememberVol) {
        if (!m.__sceVolRestored) {   // per element: SoundCloud can hand us a fresh <audio> per track
          const sv = parseFloat(GET(VOL_KEY, ''));
          if (isFinite(sv) && sv >= 0.02 && sv <= 1) { try { m.volume = sv; } catch (e) {} }   // a stored 0 is ignored: SoundCloud's own level stays
          m.__sceVolRestored = true;
        } else {
          const now = Date.now();
          // never remember a mute (M) or a near-silent level as "the volume": unmuting / the next session would restore silence
          // (nor a sleep-timer fade in flight: its stepped-down levels are not "the volume" either)
          let sleepFading = false; try { sleepFading = !!(SUITE.sleep && SUITE.sleep.fading && SUITE.sleep.fading()); } catch (e) {}
          if (mutedVol != null && isFinite(m.volume) && m.volume >= 0.02) mutedVol = null;   // the slider raised the level: that is an unmute
          if (mutedVol == null && !sleepFading && isFinite(m.volume) && m.volume >= 0.02 && now - lastVolSaved > 1500) { lastVolSaved = now; SET(VOL_KEY, String(m.volume)); }
        }
      }
    } catch (e) {}
  }
  /* A–B loop endpoints (live, not persisted) */
  let abOn = false, abA = null, abB = null, abM = null, abHref = null, abT = 0, abI = 0;   // abM / abHref: the element and the track the loop was set on · abT/abI: the wrap timers (armed by armAb)
  function abMark() {
    const m = activeMedia();
    if (!m || !isFinite(m.currentTime)) { toast('Play a track first'); return; }
    if (abA == null || abB != null) { abA = m.currentTime; abB = null; abOn = false; armAb(); toast('A set — mark B next'); }
    else if (m.currentTime > abA) { abB = m.currentTime; abOn = true; abM = m; abHref = curTrackHref(); armAb(); toast('A–B loop on · ' + (abB - abA).toFixed(1) + ' s'); }
    else { abA = m.currentTime; toast('A moved'); }
    refreshBar();
  }
  // A–B timeline markers (WP10): 2-px accent spans inside SoundCloud's progress wrapper at A/dur and B/dur
  // (A alone as soon as it is set); removed on clear. Repainted by refreshBar and, while looping, once a second
  // from abCheck (the wrapper is re-rendered by SoundCloud on a track change).
  let abMarkN = 0;
  function abMarkers() {
    try {
      const w = D.querySelector('.playbackTimeline__progressWrapper'), m = activeMedia(), dur = m ? m.duration : NaN;
      const pts = [abA, abB].filter((t) => t != null && isFinite(t));
      const want = w && pts.length && isFinite(dur) && dur > 0;
      D.querySelectorAll('.sce-abmark').forEach((e) => { if (!want || e.parentNode !== w || +e.dataset.i >= pts.length) e.remove(); });
      if (!want) return;
      if (!w.style.position && getComputedStyle(w).position === 'static') w.style.position = 'relative';
      pts.forEach((t, i) => {
        let el = w.querySelector('.sce-abmark[data-i="' + i + '"]');
        if (!el) { el = D.createElement('span'); el.className = 'sce-abmark'; el.dataset.i = i; el.style.cssText = 'position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;border-radius:1px;background:#ff6a1f;pointer-events:none;z-index:3'; w.appendChild(el); }
        const left = Math.max(0, Math.min(100, t / dur * 100)).toFixed(2) + '%'; if (el.style.left !== left) el.style.left = left;
      });
    } catch (e) {}
  }
  // quiet: the loop switched itself off (the user seeked out of it) — a softer toast than an explicit clear
  function abClear(quiet) { abA = abB = null; abM = null; abHref = null; abOn = false; try { clearTimeout(abT); clearInterval(abI); } catch (e) {} abT = 0; abI = 0; refreshBar(); toast(quiet ? 'A–B loop off' : 'A–B loop cleared'); }
  // 2.28: the wrap is a timer aimed 30 ms of media time before B (rate-aware) plus a 100 ms backstop that survives
  // seeks and rate changes; the 1 Hz enforce tick no longer takes part, so the loop lands within ~50 ms of B
  const abAimMs = (m) => ((abB - 0.03 - m.currentTime) / Math.max(0.25, +m.playbackRate || 1)) * 1000;   // wall ms until 30 ms (media) before B
  function armAb() {
    try { clearTimeout(abT); clearInterval(abI); } catch (e) {}
    abT = 0; abI = 0;
    if (!abOn || abA == null || abB == null) return;
    const m = activeMedia();
    if (!m) return;
    try {
      abT = setTimeout(abCheck, Math.max(0, abAimMs(m)));
      abI = setInterval(abCheck, 100);
    } catch (e) {}
  }
  function abCheck() {
    try {
      if (!abOn || abA == null || abB == null) { armAb(); return; }
      const m = activeMedia();
      if (!m || !isFinite(m.currentTime)) return;
      // another element took over: a track change ends the loop (a fresh element starts at 0, which the outside test below
      // cannot tell from a loop whose A sits at the very start); a merely paused loop element keeps its loop and rests the backstop
      if (abM && m !== abM) { if (!m.paused) abClear(true); else { try { clearInterval(abI); } catch (e) {} abI = 0; } return; }
      if (!(++abMarkN % 10)) abMarkers();
      // the same element with a new src (SoundCloud swaps tracks in place, restarting at 0 — inside a loop whose A sits at the
      // start): the badge link tells the track; a link missing during a re-render never clears the loop
      if (abHref) { const h = curTrackHref(); if (h && h !== abHref) { abClear(true); return; } }
      const t = m.currentTime;
      if (t < abA - 0.5 || t > abB + 1) { abClear(true); return; }   // the listener seeked outside the loop (checked first: a seek past B must not wrap)
      if (t >= abB - 0.05) { __sceUserSeek = Date.now(); m.currentTime = abA; armAb(); return; }
      if (m.paused) { try { clearInterval(abI); } catch (e) {} abI = 0; return; }   // nothing moves while paused: `play` / `seeking` re-arm the backstop
      // close to B but short of the threshold (the media clock lags the timer a little): re-aim rather than wait for the backstop
      if (abB - t < 0.3 && !m.paused) { try { clearTimeout(abT); } catch (e) {} abT = setTimeout(abCheck, Math.max(5, abAimMs(m))); }
    } catch (e) {}
  }
  function restartTrack() {
    const m = activeMedia();
    try { if (m) { __sceUserSeek = Date.now(); m.currentTime = 0; toast('Restarted'); } } catch (e) {}
  }
  function nudgeSeek(sec) {
    const m = activeMedia();
    try { if (m && isFinite(m.duration)) { __sceUserSeek = Date.now(); m.currentTime = Math.min(m.duration - 0.3, Math.max(0, m.currentTime + sec)); } } catch (e) {}
  }
  function seekPct(p) {
    const m = activeMedia();
    try { if (m && isFinite(m.duration) && m.duration > 0) { __sceUserSeek = Date.now(); m.currentTime = m.duration * p; } } catch (e) {}
  }
  function setupBehaviour() {
    try { setInterval(() => { enforce(); ensureMini(); }, 1000); } catch (e) {}
    try {
      D.addEventListener('visibilitychange', () => {
        try {
          if (CFG.pauseOnHide && D.hidden) {
            const pc = D.querySelector('.playControls__play');
            if (pc && pc.classList.contains('playing')) pc.click();
          }
        } catch (e) {}
      });
    } catch (e) {}
    // scroll wheel over the player bar = volume
    try {
      D.addEventListener('wheel', (e) => {
        try {
          if (!CFG.volScroll) return;
          const bar = e.target && e.target.closest && e.target.closest('.playControls, .playControls__elements');
          if (!bar || (e.target.closest && e.target.closest('.queue, .playControls__queue'))) return;   // the Next Up panel sits inside the bar: its list keeps the wheel
          const m = activeMedia();
          if (!m) return;
          e.preventDefault();
          const v = Math.min(1, Math.max(0, (m.volume || 0) + (e.deltaY < 0 ? 0.05 : -0.05)));
          if (v > 0) mutedVol = null;   // wheeling up out of a mute is an unmute: the volume memory runs again
          m.volume = v; SET(VOL_KEY, String(v)); toast('Volume ' + Math.round(v * 100) + '%');
        } catch (e2) {}
      }, { passive: false });
    } catch (e) {}
    // keyboard: number keys seek %, [ ] ± 10s, plus opt-in global one-key
    // shortcuts — all only when NOT typing and the lyrics panel isn't capturing
    try {
      W.addEventListener('keydown', (e) => {
        try {
          if (e.altKey || e.ctrlKey || e.metaKey) return;
          const t = (e.composedPath ? e.composedPath()[0] : null) || e.target;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
          if (SUITE.lyricsOpen && SUITE.lyricsOpen()) return;   // lyrics panel owns keys when open
          if (CFG.keySeek) {
            if (e.key >= '0' && e.key <= '9') { seekPct((+e.key) / 10); return; }
            if (e.key === '[') { nudgeSeek(-10); return; }
            if (e.key === ']') { nudgeSeek(10); return; }
          }
          if (CFG.hotkeys) {
            const k = e.key;
            if (e.repeat && k !== '=' && k !== '+' && k !== '-' && k !== '_') return;   // only the volume keys auto-repeat
            if (SUITE.audioKey && SUITE.audioKey(e)) { e.preventDefault(); return; }    // A compare · N night · , . speed
            if (k === '/') { const s = D.querySelector('input.headerSearch__input,.headerSearch__input,input[type="search"],.header__searchInput'); if (s) { e.preventDefault(); s.focus(); s.select && s.select(); } }
            else if (k === 'm' || k === 'M') { toggleMute(); }
            else if (k === '=' || k === '+') { bumpVol(0.05); }
            else if (k === '-' || k === '_') { bumpVol(-0.05); }
            else if (k === 'b' || k === 'B') { likeCurrent(); }
            else if (k === 'c' || k === 'C') { copyTrackLink(); }
            else if (k === 'g' || k === 'G') { gotoArtist(); }
            else if (k === 'i' || k === 'I') { showInfo(); }
            else if (k === '?') { e.preventDefault(); showShortcuts(); }
          }
        } catch (e2) {}
      }, true);
      // keyup releases a held A (compare); the hub takes over both edges while it is open (module 2 yields on its Audio tab)
      W.addEventListener('keyup', (e) => { try { if (!(SUITE.lyricsOpen && SUITE.lyricsOpen()) && SUITE.audioKey) SUITE.audioKey(e); } catch (e2) {} }, true);
    } catch (e) {}
    // back-to-top button
    try {
      W.addEventListener('scroll', ensureTop, { passive: true });
    } catch (e) {}
  }
  function bumpVol(d) { const m = activeMedia(); if (!m) return; const v = Math.min(1, Math.max(0, (m.volume || 0) + d)); if (v > 0) mutedVol = null; m.volume = v; SET(VOL_KEY, String(v)); toast('Volume ' + Math.round(v * 100) + '%'); }
  function toggleMute() { const m = activeMedia(); if (!m) return; if (m.volume > 0) { mutedVol = m.volume; m.volume = 0; toast('Muted'); } else { m.volume = mutedVol || 0.5; mutedVol = null; toast('Unmuted'); } }

  /* ───────── sleep timer chips (2.29) — one timer for the whole suite: module 1's SUITE.sleep owns the
     clock, the fade-out and the "after this track" arming; these chips only set / clear it and paint it ───────── */
  let sleepEls = null, sleepChipMin = 0, sleepChipEnd = 0;   // the chip clicked last (-1 = Track end) and the timer end it set; cleared once the timer is gone
  function paintSleep(force) {   // force: the Tweaks render paints before its row is attached
    try {
      if (!sleepEls || !sleepEls.wrap || (!force && !sleepEls.wrap.isConnected)) return;
      const S = SUITE.sleep;
      const rem = S ? (S.remainingMs() || 0) : 0, armed = !!(S && S.armed());
      if (!rem && !armed) { sleepChipMin = 0; sleepChipEnd = 0; }
      else {
        // the timer's end moved without a chip click (the hub's Stats tab, module 1's own panel, "after this track"
        // arming): light the chip whose minutes match, or none
        const end = armed ? -1 : Date.now() + rem;
        if (armed ? sleepChipEnd !== -1 : Math.abs(end - sleepChipEnd) > 2000) {
          const cm = armed ? -1 : Math.ceil(rem / 60000);
          sleepChipMin = sleepEls.chips.some((c) => +c.dataset.min === cm) ? cm : 0;
          sleepChipEnd = end;
        }
      }
      sleepEls.chips.forEach((c) => {
        const on = sleepChipMin !== 0 && (+c.dataset.min === sleepChipMin);
        c.style.background = on ? 'linear-gradient(135deg,#f50,#ff8a3d)' : 'rgba(255,255,255,.07)';
        c.style.color = on ? '#fff' : '#dcdce2';
      });
      sleepEls.label.textContent = !S ? 'Sleep timer unavailable' : armed ? 'Pausing after this track' : rem ? ('Pausing playback in ~' + Math.max(1, Math.ceil(rem / 60000)) + ' min') : 'Pause playback automatically';
    } catch (e) {}
  }
  function sleepChip(min) {
    try {
      if (!SUITE.sleep) { toast('Sleep timer unavailable'); return; }
      if (min === -1) {
        // fire just before this track ends → the watcher arms "pause after this track" instead of fading mid-song
        const m = activeMedia();
        const rate = m ? Math.max(0.25, +m.playbackRate || 1) : 1;   // the timer is wall-clock: media seconds left ÷ the speed
        const remS = m && isFinite(m.duration) && m.duration > 0 ? Math.max(5, (m.duration - m.currentTime) / rate) : 0;
        if (!remS) { toast('Play something first'); return; }
        SUITE.sleep.set(Math.max(0.01, remS / 60 - 0.12)); sleepChipMin = -1; toast('Pausing after this track');
      } else if (min > 0) { SUITE.sleep.set(min); sleepChipMin = min; toast('💤 Sleep timer set · ' + (min >= 60 ? (min / 60) + 'h' : min + ' min')); }
      else { SUITE.sleep.clear(); sleepChipMin = 0; toast('Sleep timer off'); }
      sleepChipEnd = sleepChipMin ? Date.now() + (SUITE.sleep.remainingMs() || 0) : 0;
      paintSleep();
    } catch (e) {}
  }
  function likeCurrent() {
    // the player bar only, most specific first: a selector list returns the first match in DOCUMENT order, i.e. a stream item's button
    const b = ['.playbackSoundBadge__actions .sc-button-like', '.playbackSoundBadge__like', '.playControls__soundBadge .sc-button-like', '.playControls .sc-button-like'].map((s) => D.querySelector(s)).find(Boolean);
    if (b) { const was = b.classList.contains('sc-button-selected'); b.click(); toast(was ? 'Unliked' : 'Liked ♥'); } else toast('Play a track first');
  }
  function gotoArtist() { const a = D.querySelector('.playbackSoundBadge__lightLink'); const h = a && a.getAttribute('href'); if (h) { try { W.open('https://soundcloud.com' + h.split('?')[0], '_blank'); } catch (e) {} } else toast('Play a track first'); }
  let topBtn = null;
  function ensureTop() {
    try {
      if (!CFG.backTop) { if (topBtn) topBtn.style.display = 'none'; return; }
      if (!topBtn) {
        topBtn = D.createElement('button');
        topBtn.textContent = '↑'; topBtn.title = 'Back to top';
        topBtn.style.cssText = 'position:fixed;right:16px;bottom:112px;z-index:2147483330;width:38px;height:38px;border-radius:50%;border:0;cursor:pointer;'
          + 'background:linear-gradient(180deg,rgba(42,42,48,.95),rgba(20,20,24,.97));color:#fff;font-size:17px;box-shadow:0 8px 24px rgba(0,0,0,.42),inset 0 0 0 1px rgba(255,255,255,.08);display:none;transition:opacity .2s,transform .15s';
        topBtn.addEventListener('mouseenter', () => { topBtn.style.transform = 'translateY(-2px)'; });
        topBtn.addEventListener('mouseleave', () => { topBtn.style.transform = 'none'; });
        topBtn.addEventListener('click', () => { try { W.scrollTo({ top: 0, behavior: 'smooth' }); const sc = D.querySelector('#content, .l-container, .l-fluid'); if (sc && sc.scrollTo) sc.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {} });
        (D.body || D.documentElement).appendChild(topBtn);
      }
      topBtn.style.display = ((W.scrollY || (D.scrollingElement && D.scrollingElement.scrollTop) || 0) > 500) ? 'block' : 'none';
    } catch (e) {}
  }

  /* ───────── small player-bar buttons (speed cycle · copy link) ───────── */
  // per-track speed memory (opt-in): each track remembers the last speed you set
  // for it and restores it on play; untracked tracks keep whatever's current.
  let lastSpeedUrl = null;
  function curTrackHref() { try { const a = D.querySelector('.playbackSoundBadge__titleLink'); return (a && a.getAttribute('href')) || null; } catch (e) { return null; } }
  function rememberSpeed() {
    if (!CFG.speedPerTrack) return;
    try {
      const href = curTrackHref(); if (!href) return;
      const map = GET('spd:bytrack', {}) || {};
      map[href] = CFG.speed | 0;
      const keys = Object.keys(map);
      if (keys.length > 250) delete map[keys[0]];   // bound the map, oldest first
      SET('spd:bytrack', map);
      lastSpeedUrl = href;   // we just set it — don't let restore re-fire on this track
    } catch (e) {}
  }
  function restoreTrackSpeed() {
    if (!CFG.speedPerTrack) return;
    try {
      const href = curTrackHref();
      if (!href || href === lastSpeedUrl) return;
      lastSpeedUrl = href;
      const want = (GET('spd:bytrack', {}) || {})[href] | 0;
      if (want >= 50 && want <= 200 && want !== (CFG.speed | 0)) { CFG.speed = want; save(); applySpeed(); refreshBar(); try { if (eqRepaint) eqRepaint(); } catch (e) {} toast('Speed ' + (want / 100) + '× (remembered)'); }
    } catch (e) {}
  }
  // per-track EQ memory (WP10, opt-in — the spd:bytrack pattern, cap 250): the curve, pre-amp and switch a track was
  // last left with, saved when a canvas drag ends, a band is double-clicked or a preset is picked (never mid-drag) and
  // restored on the 1 Hz tick when the track changes. Untracked tracks keep whatever is current, like speed.
  let lastEqUrl = null;
  let eqMemT = 0;
  const rememberEqSoon = () => { clearTimeout(eqMemT); eqMemT = setTimeout(rememberEq, 300); };   // slider drags settle first
  function rememberEq() {
    if (!CFG.eqPerTrack) return;
    try {
      const href = curTrackHref(); if (!href) return;
      const map = GET('eq:bytrack', {}) || {};
      map[href] = { on: !!CFG.eqOn, b: ensureEqBands().slice(), pre: CFG.eqPreamp | 0 };
      const keys = Object.keys(map);
      if (keys.length > 250) delete map[keys[0]];   // bound the map, oldest first
      SET('eq:bytrack', map);
      lastEqUrl = href;   // we just set it — don't let restore re-fire on this track
    } catch (e) {}
  }
  function restoreTrackEq() {
    if (!CFG.eqPerTrack) return;
    try {
      const href = curTrackHref();
      if (!href || href === lastEqUrl) return;
      lastEqUrl = href;
      const m = (GET('eq:bytrack', {}) || {})[href];
      if (!m || !Array.isArray(m.b)) return;
      const b = m.b.slice(0, EQ_FREQS.length).map((x) => Math.max(-12, Math.min(12, Math.round(+x || 0))));
      while (b.length < EQ_FREQS.length) b.push(0);
      const pre = Math.max(-12, Math.min(12, m.pre | 0)), cur = ensureEqBands();
      if (!!m.on === !!CFG.eqOn && pre === (CFG.eqPreamp | 0) && b.every((x, i) => x === (cur[i] | 0))) return;
      CFG.eqBands = b; CFG.eqOn = !!m.on; CFG.eqPreamp = pre;
      save(); applyFx();   // the open tab repaints on the curve version bump
      toast('EQ restored for this track');
    } catch (e) {}
  }
  const SPEEDS = [100, 125, 150, 175, 200, 50, 75];
  function cycleSpeed() {
    const i = SPEEDS.indexOf(CFG.speed | 0);
    CFG.speed = SPEEDS[(i + 1) % SPEEDS.length];
    // remember BEFORE enforce(): enforce→restoreTrackSpeed must see this track
    // already locked, so a manual change can't be clobbered by a stale remembered value
    save(); rememberSpeed(); enforce(); refreshBar();
    try { if (eqRepaint) eqRepaint(); } catch (e) {}   // the Audio tab's Speed row and chips follow
    // one-line diagnostic so we can see whether SoundCloud's audio element even
    // accepts the rate (open DevTools console → change speed → read this)
    try {
      console.log('%c[SoundCloud Suite speed]', 'color:#ff5500;font-weight:700', 'wanted=' + (CFG.speed / 100) + '×',
        'domMedia=' + D.querySelectorAll('audio,video').length,
        'capturedEls=' + sceMediaEls.size, 'rates=[' + [...sceMediaEls].map((m) => m.playbackRate).join(',') + ']',
        'bufferNodes=' + sceBufNodes.size);
    } catch (e) {}
    toast('Speed ' + (CFG.speed / 100) + '×');
  }
  let _lastClip = '';
  function clip(text, label) {
    _lastClip = String(text == null ? '' : text);
    let ok = false;
    try { ok = GM_setClipboard(text) !== false; } catch (e) {}
    if (!ok) { try { navigator.clipboard.writeText(text).catch(() => {}); } catch (e2) {} }
    toast(label || 'Copied');
  }
  function copyTrackLink() {
    try {
      const a = D.querySelector('.playbackSoundBadge__titleLink');
      const href = a && a.getAttribute('href');
      if (!href) { toast('Play a track first'); return; }
      clip('https://soundcloud.com' + href.split('?')[0], 'Track link copied');
    } catch (e) {}
  }

  /* ───────── ARTIST / TRACK tools — a track-info popover with metadata,
   * download (for downloadable tracks), artist quick-links and embed copy.
   * Fetches the public track JSON via the api-v2 client_id the shuffle module
   * already sniffed. Fully guarded; fails to a friendly message. ───────── */
  function gmGetJSON(url) {
    return new Promise((res) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: 9000,
          onload: (r) => { try { res(JSON.parse(r.responseText)); } catch (e) { res(null); } },
          onerror: () => res(null), ontimeout: () => res(null),
        });
      } catch (e) { res(null); }
    });
  }
  const cid = () => { try { return (SUITE.clientId && SUITE.clientId()) || null; } catch (e) { return null; } };
  async function fetchTrack() {
    const a = D.querySelector('.playbackSoundBadge__titleLink');
    const href = a && a.getAttribute('href');
    if (!href) return { err: 'Play a track first' };
    const url = 'https://soundcloud.com' + href.split('?')[0];
    const c = cid();
    if (!c) return { err: 'Loading SoundCloud… try again in a moment', url };
    const d = await gmGetJSON('https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent(url) + '&client_id=' + encodeURIComponent(c));
    if (!d || !d.id) return { err: 'Couldn’t load track info', url };
    d.__url = url;
    return d;
  }
  function downloadTrack(d) {
    const c = cid();
    if (!c) { toast('Try again in a moment'); return; }
    toast('Preparing download…');
    gmGetJSON('https://api-v2.soundcloud.com/tracks/' + d.id + '/download?client_id=' + encodeURIComponent(c)).then((j) => {
      if (j && j.redirectUri) { try { W.open(j.redirectUri, '_blank'); } catch (e) {} toast('Download started'); }
      else toast('No download available');
    });
  }
  let infoEl = null, infoAway = null, infoEsc = null, infoFrom = null;   // infoFrom: what had focus when the popover opened (focus goes back there on close)
  function closeInfo() {
    if (infoAway) { try { D.removeEventListener('mousedown', infoAway, true); } catch (e) {} infoAway = null; }
    if (infoEsc) { try { D.removeEventListener('keydown', infoEsc, true); } catch (e) {} infoEsc = null; }
    if (infoEl) { try { infoEl.remove(); } catch (e) {} infoEl = null; }
    if (infoFrom) { const f = infoFrom; infoFrom = null; try { if (f.isConnected && (!D.activeElement || D.activeElement === D.body)) f.focus(); } catch (e) {} }
  }
  function showInfo() {
    if (infoEl) { closeInfo(); return; }
    try { const a = D.activeElement; infoFrom = a && a !== D.body && a !== D.documentElement ? a : null; } catch (e) { infoFrom = null; }
    infoEl = D.createElement('div');
    infoEl.style.cssText = 'position:fixed;right:14px;bottom:62px;z-index:2147483350;width:302px;max-height:74vh;overflow:auto;'
      + 'background:linear-gradient(180deg,rgba(24,24,28,.85),rgba(11,11,14,.93));color:#f2f2f4;border-radius:18px;'
      + 'backdrop-filter:blur(30px) saturate(1.6);-webkit-backdrop-filter:blur(30px) saturate(1.6);'
      + 'box-shadow:0 28px 72px -18px rgba(0,0,0,.78),inset 0 0 0 1px rgba(255,255,255,.08);'
      + 'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:14px';
    infoEl.innerHTML = '<div style="opacity:.6;font-size:12px">Loading track info…</div>';
    (D.body || D.documentElement).appendChild(infoEl);
    // tap-away closes it (handler stored so it's always cleaned up)
    setTimeout(() => {
      infoAway = (e) => { try { if (infoEl && !infoEl.contains(e.target) && !(e.target.closest && e.target.closest('.sce-info'))) closeInfo(); } catch (e2) {} };
      D.addEventListener('mousedown', infoAway, true);
      infoEsc = (e) => { try { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeInfo(); } } catch (e2) {} };
      D.addEventListener('keydown', infoEsc, true);
    }, 0);
    const el = infoEl;   // an earlier, slower fetch must not overwrite a re-opened popover
    fetchTrack().then((d) => {
      if (!infoEl || infoEl !== el) return;
      if (d && d.err) { infoEl.innerHTML = '<div style="opacity:.7;font-size:12px">' + esc(d.err) + '</div>'; return; }
      renderInfo(d);
    });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtNum(n) { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }
  function renderInfo(d) {
    const u = (d.user && d.user.username) || '';
    const uhref = (d.user && d.user.permalink_url) || '';
    const genre = (d.genre || '').trim();
    const date = (d.display_date || d.created_at || '').slice(0, 10);
    const bpm = (d.bpm) || (d.publisher_metadata && d.publisher_metadata.bpm) || '';
    const dur = d.full_duration || d.duration || 0;
    const mm = Math.floor(dur / 60000), ss = Math.floor((dur % 60000) / 1000);
    const dl = !!(d.downloadable && d.has_downloads_left);
    const artUrl = esc((d.artwork_url || (d.user && d.user.avatar_url) || '').replace('-large', '-t300x300')).replace(/["')]/g, '');
    const len = mm + ':' + String(ss).padStart(2, '0');
    const statTile = (n, label) => '<div style="flex:1;text-align:center;padding:9px 4px;border-radius:11px;background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)">'
      + '<div style="font-size:15px;font-weight:800;letter-spacing:-.3px">' + esc(fmtNum(n)) + '</div>'
      + '<div style="font-size:8px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#86868e;margin-top:2px">' + label + '</div></div>';
    const metaChips = [];
    if (genre) metaChips.push(['Genre', genre]);
    if (bpm) metaChips.push(['BPM', String(bpm)]);
    if (date) metaChips.push(['Released', date]);
    metaChips.push(['Length', len]);
    let chipHtml = '';
    for (const [k, v] of metaChips) chipHtml += '<span style="display:inline-flex;gap:6px;align-items:baseline;padding:5px 10px;border-radius:8px;background:rgba(255,255,255,.04)"><span style="font-size:8px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#83838c">' + k + '</span><span style="font-size:11.5px;font-weight:600;color:#dcdce2">' + esc(v) + '</span></span>';
    // ── hero: blurred-artwork backdrop + sharp tile + title/artist ──
    let html = '<div style="position:relative;margin:-14px -14px 13px;height:106px;overflow:hidden">';
    if (artUrl) html += '<div style="position:absolute;inset:0;background:#1a1a1e center/cover no-repeat url(&quot;' + artUrl + '&quot;);filter:blur(22px) brightness(.5) saturate(1.25);transform:scale(1.4)"></div>';
    html += '<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(14,14,17,.2),rgba(12,12,15,.95))"></div>'
      + '<div style="position:absolute;left:14px;right:14px;bottom:12px;display:flex;gap:11px;align-items:flex-end">'
      + '<div style="width:58px;height:58px;border-radius:12px;flex:none;background:#222 center/cover no-repeat' + (artUrl ? ' url(&quot;' + artUrl + '&quot;)' : '') + ';box-shadow:0 8px 22px -4px rgba(0,0,0,.6),inset 0 0 0 1px rgba(255,255,255,.14)"></div>'
      + '<div style="min-width:0;flex:1;padding-bottom:2px">'
      + '<div title="' + esc(d.title || '').replace(/"/g, '&quot;') + '" style="font-weight:800;font-size:14.5px;letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 10px rgba(0,0,0,.6)">' + esc(d.title || '') + '</div>'
      + '<div title="' + esc(u).replace(/"/g, '&quot;') + '" style="font-size:11.5px;color:#cdcdd5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">' + esc(u) + '</div>'
      + '</div></div></div>';
    html += '<div style="display:flex;gap:7px;margin-bottom:11px">' + statTile(d.playback_count, 'Plays') + statTile(d.likes_count || d.favoritings_count, 'Likes') + statTile(d.reposts_count, 'Reposts') + '</div>';
    if (chipHtml) html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:13px">' + chipHtml + '</div>';
    infoEl.innerHTML = html;
    const acts = D.createElement('div'); acts.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px'; infoEl.appendChild(acts);
    const mkA = (txt, fn, accent, full) => {
      const b = D.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'flex:' + (full ? '1 1 100%' : '1 1 auto') + ';min-width:84px;border:0;border-radius:10px;padding:9px 10px;font:700 11px inherit;cursor:pointer;transition:filter .14s ease,background .14s ease;'
        + (accent ? 'background:#f50;color:#fff' : 'background:rgba(255,255,255,.07);color:#eaeaee');
      b.addEventListener('mouseenter', () => { if (accent) b.style.background = '#ff8a3d'; else b.style.background = 'rgba(255,255,255,.13)'; });
      b.addEventListener('mouseleave', () => { if (accent) b.style.background = '#f50'; else b.style.background = 'rgba(255,255,255,.07)'; });
      b.addEventListener('click', fn);
      acts.appendChild(b);
    };
    if (dl) mkA('⤓  Download', () => downloadTrack(d), true, true);   // only when the artist allows downloads
    mkA('Open artist', () => { if (uhref) { try { W.open(uhref, '_blank'); } catch (e) {} } });
    mkA('Copy artist', () => uhref && clip(uhref, 'Artist link copied'));
    mkA('Copy link', () => clip(d.__url || d.permalink_url || '', 'Track link copied'));
    mkA('Copy embed', () => clip('<iframe width="100%" height="166" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?url=' + encodeURIComponent(d.permalink_url || d.__url || '') + '"></iframe>', 'Embed code copied'));
    const fb = acts.querySelector('button'); if (fb) { try { fb.focus({ preventScroll: true }); } catch (e) {} }   // keyboard: Tab walks the actions, Escape closes
  }

  /* ───────── keyboard shortcut cheat-sheet (press ?) ─────────
   * The lyrics hub has its own in-panel help (?); this one surfaces the GLOBAL
   * player/track hotkeys that otherwise have no discovery affordance. */
  let keysEl = null, keysEsc = null;
  function closeKeys() {
    if (keysEsc) { try { D.removeEventListener('keydown', keysEsc, true); } catch (e) {} keysEsc = null; }
    if (keysEl) { try { keysEl.remove(); } catch (e) {} keysEl = null; }
  }
  function showShortcuts() {
    if (keysEl) { closeKeys(); return; }
    const groups = [
      ['Seek & volume', [
        [['0–9'], 'Jump to 0%–90% of the track'],
        [['[', ']'], 'Rewind / forward 10 seconds'],
        [['M'], 'Mute / unmute'],
        [['+', '−'], 'Volume up / down'],
      ]],
      ['Current track', [
        [['B'], 'Like / unlike'],
        [['C'], 'Copy track link'],
        [['G'], 'Open the artist'],
        [['I'], 'Track info, download & embed'],
        [['/'], 'Focus the SoundCloud search'],
      ]],
      ['Audio', [
        [['A'], 'Hold to compare with the original'],
        [['N'], 'Night mode on / off'],
        [[',', '.'], 'Speed −5 % / +5 %'],
      ], 'Also work inside the hub on the Audio tab once Global hotkeys is on'],
      ['Suite', [
        [['?'], 'Show / hide this sheet'],
      ]],
    ];
    keysEl = D.createElement('div');
    keysEl.style.cssText = 'position:fixed;inset:0;z-index:2147483360;display:flex;align-items:center;justify-content:center;background:rgba(6,6,9,.5);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .18s ease';
    const card = D.createElement('div');
    card.style.cssText = 'width:min(440px,92vw);max-height:84vh;overflow:auto;background:linear-gradient(180deg,rgba(24,24,28,.98),rgba(13,13,16,.99));color:#f2f2f4;border-radius:20px;box-shadow:0 30px 80px -20px rgba(0,0,0,.8),inset 0 0 0 1px rgba(255,255,255,.08);padding:20px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;transform:translateY(8px) scale(.985);transition:transform .22s cubic-bezier(.3,1,.4,1)';
    const chip = (k) => '<kbd style="display:inline-block;min-width:16px;text-align:center;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.14);border-bottom-width:2px;border-radius:6px;padding:2px 6px;font:700 11px ui-monospace,Menlo,monospace;color:#fff;margin:0 1px">' + esc(k) + '</kbd>';
    let html = '<div style="display:flex;align-items:center;gap:11px;margin-bottom:2px">'
      + '<div style="width:30px;height:30px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center;background:#f50;font-size:15px">⌨</div>'
      + '<div><div style="font-size:16px;font-weight:800;letter-spacing:-.3px">Keyboard shortcuts</div>'
      + '<div style="font-size:11px;color:#9a9aa2">Global keys — anywhere on SoundCloud</div></div></div>';
    for (const [title, rows, note] of groups) {
      html += '<div style="font-size:9.5px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:#7e7e88;margin:16px 0 5px">' + esc(title) + '</div>';
      for (const [keys, desc] of rows) {
        html += '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">'
          + '<div style="flex:none;min-width:92px">' + keys.map(chip).join('') + '</div>'
          + '<div style="flex:1;color:#cfcfd6;font-size:12px">' + esc(desc) + '</div></div>';
      }
      if (note) html += '<div style="font-size:10px;color:#7e7e88;margin-top:5px">' + esc(note) + '</div>';
    }
    html += '<div style="margin-top:14px;padding:10px 12px;border-radius:11px;background:rgba(255,90,0,.08);font-size:11.5px;color:#cdb6a6;line-height:1.45">Open the <b style="color:#ffb083">lyrics hub</b> (♪ in the player bar) and press <b style="color:#fff">?</b> inside it for 20+ lyric, sync & navigation keys.</div>';
    html += '<div style="text-align:center;font-size:10px;color:#6a6a72;margin-top:12px;letter-spacing:.03em">Esc or click away to close · turn on Global hotkeys in the Tweaks tab</div>';
    card.innerHTML = html;
    card.addEventListener('click', (e) => e.stopPropagation());
    keysEl.appendChild(card);
    keysEl.addEventListener('click', () => closeKeys());
    (D.body || D.documentElement).appendChild(keysEl);
    try { requestAnimationFrame(() => { if (keysEl) { keysEl.style.opacity = '1'; card.style.transform = 'none'; } }); } catch (e) { keysEl.style.opacity = '1'; }
    // register the close-key handler on the NEXT tick so the very keypress that
    // opened the sheet can't also close it within the same event dispatch
    setTimeout(() => {
      keysEsc = (e) => { try { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); closeKeys(); } } catch (e2) {} };
      D.addEventListener('keydown', keysEsc, true);
    }, 0);
  }

  /* ───────── graphic equalizer + audio FX — rendered into its own hub "Audio" tab ───────── */
  let eqRaf = 0, eqRepaint = null;
  function ensureEqBands() {
    if (!Array.isArray(CFG.eqBands) || CFG.eqBands.length !== EQ_FREQS.length) CFG.eqBands = EQ_FREQS.map(() => 0);
    return CFG.eqBands;
  }
  function setBand(i, v) {
    v = Math.max(-12, Math.min(12, Math.round(v)));
    const cur = ensureEqBands();
    if ((cur[i] || 0) === v) return;   // no change → skip storage churn during a drag
    const arr = cur.slice();           // fresh array — never mutate the DEFAULTS reference
    arr[i] = v;
    CFG.eqBands = arr;
    if (!CFG.eqOn) CFG.eqOn = true;   // touching the EQ turns it on
    saveSoon(); applyFx();
    if (eqRepaint) eqRepaint();   // the switch when it flipped, the pre-amp value, the preset select's dirty state
  }
  // a preset is a bands array (built-ins, old custom saves) or { b: number[10], pre: number }
  // (custom saves, which remember the pre-amp)
  const presetBands = (p) => Array.isArray(p) ? p : (p && typeof p === 'object' && Array.isArray(p.b)) ? p.b : [];
  const presetPre = (p) => (p && !Array.isArray(p) && typeof p === 'object' && p.pre != null && isFinite(+p.pre)) ? Math.max(-12, Math.min(12, Math.round(+p.pre))) : null;
  const customPresets = () => (CFG.eqCustom && typeof CFG.eqCustom === 'object' && !Array.isArray(CFG.eqCustom)) ? CFG.eqCustom : {};
  function applyEqPreset(p) {
    const out = presetBands(p).slice(0, EQ_FREQS.length).map((x) => Math.max(-12, Math.min(12, Math.round(+x || 0))));
    while (out.length < EQ_FREQS.length) out.push(0);
    const pre = presetPre(p);
    CFG.eqBands = out; CFG.eqOn = true;
    if (pre != null) CFG.eqPreamp = pre;
    save(); applyFx(); rememberEq();
    if (eqRepaint) eqRepaint();
  }
  // the preset the current curve equals ('b:Name' | 'c:Name' | '' when edited): bands must match,
  // and the pre-amp too when the preset stores one. When two presets share a curve (a custom
  // save of a built-in) the one last chosen or saved wins, so the select shows what the
  // listener just did; otherwise built-ins come first
  let eqPresetHint = '';
  function matchEqPreset() {
    const cur = ensureEqBands(), pre = CFG.eqPreamp | 0;
    const same = (p) => {
      const b = presetBands(p); if (b.length !== cur.length) return false;
      for (let i = 0; i < b.length; i++) if (Math.round(+b[i] || 0) !== (cur[i] | 0)) return false;
      const pp = presetPre(p); return pp == null || pp === pre;
    };
    const cu = customPresets();
    const lookup = (key) => { if (!key) return undefined; const n = key.slice(2); if (key.charAt(0) === 'b') return EQ_PRESETS[n]; return (eqPresetNameOk(n) && Object.prototype.hasOwnProperty.call(cu, n)) ? cu[n] : undefined; };
    const hinted = lookup(eqPresetHint);
    if (hinted && same(hinted)) return eqPresetHint;
    for (const k of Object.keys(EQ_PRESETS)) if (same(EQ_PRESETS[k])) return 'b:' + k;
    for (const k of Object.keys(cu)) if (eqPresetNameOk(k) && same(cu[k])) return 'c:' + k;
    return '';
  }
  // ── headphone correction (2.8): an AutoEQ "ParametricEQ.txt" → ≤ 10 filters. Data only, never
  //    eval'd; OFF filters skipped; LS/HS folded into LSC/HSC; more than ten → the ten with the
  //    largest |gain| (so a 12-band profile keeps its treble filters), then in frequency order ──
  function parseAutoEq(text) {
    const out = { preamp: 0, name: '', filters: [] };
    try {
      const s = String(text == null ? '' : text);
      const pm = /^\s*Preamp:\s*(-?[\d.]+)\s*dB/mi.exec(s);
      if (pm) out.preamp = clampNum(pm[1], -15, 0, 0);
      const re = /Filter\s*\d+:\s*(ON|OFF)\s+(PK|LSC|HSC|LS|HS)\s+Fc\s+([\d.]+)\s*Hz\s+Gain\s+(-?[\d.]+)\s*dB(?:\s+Q\s+([\d.]+))?/gi;
      let m, all = [];
      while ((m = re.exec(s))) {
        if (m[1].toUpperCase() === 'OFF') continue;
        let t = m[2].toUpperCase(); if (t === 'LS') t = 'LSC'; else if (t === 'HS') t = 'HSC';
        all.push(clampPeq({ t, f: +m[3], g: +m[4], q: m[5] == null ? 0.7 : +m[5] }));
      }
      all = all.filter(Boolean);
      if (all.length > 10) { all.sort((a, b) => Math.abs(b.g) - Math.abs(a.g)); all = all.slice(0, 10); }
      all.sort((a, b) => a.f - b.f);
      out.filters = all;
      // the profile's name: the first line that is neither the Preamp nor a Filter line
      const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^Preamp:/i.test(l) && !/^Filter\s*\d+:/i.test(l));
      out.name = (line || 'AutoEQ profile').slice(0, 40);
    } catch (e) {}
    return out;
  }
  function applyAutoEqText(text) {
    const p = parseAutoEq(text);
    if (!p.filters.length) { toast('No filters found in that text'); return false; }
    CFG.peq = p.filters; CFG.peqPreamp = p.preamp; CFG.peqName = p.name; CFG.peqOn = true;
    save(); applyFx(); if (eqRepaint) eqRepaint();
    toast(p.name + ' · ' + p.filters.length + (p.filters.length === 1 ? ' filter' : ' filters'));
    return true;
  }
  function clearAutoEq() {
    CFG.peq = []; CFG.peqPreamp = 0; CFG.peqName = ''; CFG.peqOn = false;
    save(); applyFx(); if (eqRepaint) eqRepaint();
    toast('Headphone profile cleared');
  }
  // ── Copy / Paste / Reset all audio (2.22) ──
  let audioHost = null;   // the tab body audioRender last painted: a paste or a reset rebuilds it in place
  function rerenderAudio() { try { if (audioHost && audioHost.isConnected && audioTabOn) audioRender(audioHost); else if (eqRepaint) eqRepaint(); } catch (e) {} }
  function exportAudio() {
    const audio = {};
    for (const k of AUDIO_KEYS) { try { const v = CFG[k] === undefined ? DEFAULTS[k] : CFG[k]; audio[k] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v; } catch (e) {} }
    let loudMem = GET('loud:bytrack', {}); if (!loudMem || typeof loudMem !== 'object' || Array.isArray(loudMem)) loudMem = {};
    return { v: 1, audio, loudMem };
  }
  // the per-track loudness memory from a paste, entry by entry (≤ 1000, numbers only)
  const clampLoudMem = (v) => {
    const out = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    let n = 0;
    for (const k of Object.keys(v)) {
      const e = v[k];
      if (!eqPresetNameOk(k) || k.length > 300 || !e || typeof e !== 'object' || !isFinite(+e.l)) continue;
      out[k] = { l: clampNum(e.l, -70, 0, 0), p: clampNum(e.p, 0, 4, 0), s: clampNum(e.s, 0, 36000, 0), d: clampNum(e.d, 0, 36000, 0), t: clampNum(e.t, 0, 1e13, 0), f: e.f ? 1 : 0 };
      if (++n >= 1000) break;
    }
    return out;
  };
  // the Paste box takes the JSON from Copy settings OR an AutoEQ profile: a leading `{` routes to
  // the settings importer, anything else to the AutoEQ parser. Unknown keys are ignored, a key of
  // the wrong shape keeps its current value, every accepted value goes through the audio clamps.
  // Saved presets are merged, never dropped, and the loudness memory is restored when present.
  function importAudioText(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return false;
    if (s.charAt(0) !== '{') return applyAutoEqText(s);
    let obj = null;
    try { obj = JSON.parse(s); } catch (e) { obj = null; }
    const audio = obj && typeof obj === 'object' && obj.audio && typeof obj.audio === 'object' && !Array.isArray(obj.audio) ? obj.audio : null;
    if (!audio) { toast('That isn’t audio settings JSON'); return false; }
    for (const k of AUDIO_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(audio, k)) continue;
      const v = audio[k], d = DEFAULTS[k];
      if (v === null || typeof v !== typeof d || Array.isArray(v) !== Array.isArray(d)) continue;
      if (k === 'eqCustom') { CFG.eqCustom = clampEqCustom(Object.assign({}, clampEqCustom(CFG.eqCustom), clampEqCustom(v))); continue; }
      CFG[k] = clampAudioKey(k, v);
    }
    if (obj.loudMem && typeof obj.loudMem === 'object') { try { SET('loud:bytrack', clampLoudMem(obj.loudMem)); } catch (e) {} }
    ensureEqBands();
    save(); try { applySpeed(); } catch (e) {} applyFx(); rerenderAudio();
    try { refreshBar(); } catch (e) {}
    toast('Audio settings pasted');
    return true;
  }
  // every audio key back to its default (saved presets stay: they are a library, not a setting),
  // the per-track loudness memory cleared, the tab rebuilt
  function resetAudio() {
    for (const k of AUDIO_KEYS) { if (k === 'eqCustom') continue; try { const d = DEFAULTS[k]; CFG[k] = (d && typeof d === 'object') ? JSON.parse(JSON.stringify(d)) : d; } catch (e) {} }
    try { SET('loud:bytrack', {}); } catch (e) {}
    save(); try { applySpeed(); } catch (e) {} applyFx(); rerenderAudio();
    try { refreshBar(); } catch (e) {}
    toast('Audio reset · track loudness memory cleared');
  }

  function audioRender(host) {
    try {
      if (!host) return;
      audioHost = host;
      ensureEqBands();
      host.replaceChildren();
      host.style.padding = '16px 18px 26px';
      const ACC = '#ff5500';
      const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      // one clean switch style, shared by EQ / Enhance / Loudness / Fade
      const makeSwitch = (get, toggle, name) => {
        const sw = D.createElement('button'); sw.type = 'button'; sw.setAttribute('role', 'switch');
        if (name) sw.setAttribute('aria-label', name);
        sw.style.cssText = 'position:relative;width:38px;height:22px;border-radius:22px;border:0;cursor:pointer;flex:none;padding:0;transition:background .2s ease';
        const kn = D.createElement('span'); kn.style.cssText = 'position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .2s cubic-bezier(.3,1.5,.5,1);box-shadow:0 1px 2px rgba(0,0,0,.35)';
        sw.appendChild(kn);
        const paint = () => { const on = !!get(); sw.style.background = on ? ACC : 'rgba(255,255,255,.16)'; kn.style.transform = on ? 'translateX(16px)' : 'none'; sw.setAttribute('aria-checked', String(on)); };
        paint(); sw.addEventListener('click', () => { toggle(); paint(); }); sw._paint = paint; return sw;
      };
      // one clean slider row: label · track · value
      const sliderRow = (label, mn, mx, st, get, set, fmt, resetTo) => {
        const row = D.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:14px;padding:10px 0';
        const l = D.createElement('span'); l.textContent = label; l.style.cssText = 'flex:none;width:86px;font-size:12.5px;color:#c4c4cc';
        const r = D.createElement('input'); r.type = 'range'; r.min = mn; r.max = mx; r.step = st; r.value = get(); r.className = 'sxr'; r.style.cssText = 'flex:1'; r.setAttribute('aria-label', label);
        const v = D.createElement('span'); v.style.cssText = 'flex:none;width:46px;text-align:right;font-size:11.5px;color:#86868e;font-variant-numeric:tabular-nums';
        const paint = () => { const cur = +r.value; const pct = (cur - mn) / (mx - mn) * 100; r.style.background = 'linear-gradient(90deg,' + ACC + ' ' + pct + '%,rgba(255,255,255,.12) ' + pct + '%)'; v.textContent = fmt(cur); r.setAttribute('aria-valuetext', v.textContent); };
        paint(); r.addEventListener('input', () => { set(+r.value); paint(); }); r._paint = paint;
        if (resetTo != null) { l.title = label + ' · double-click resets'; l.style.cursor = 'default'; l.addEventListener('dblclick', () => { try { r.value = resetTo; set(+r.value); paint(); } catch (e) {} }); }
        row.append(l, r, v); return { row, input: r, paint };
      };
      const sectionLabel = (txt) => { const s = D.createElement('div'); s.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:9.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#76767e;margin:22px 2px 6px'; const d = D.createElement('span'); d.style.cssText = 'width:10px;height:2px;border-radius:2px;flex:none;background:rgba(255,255,255,.16)'; const t = D.createElement('span'); t.textContent = txt; s.append(d, t); return s; };
      // the preset select's clothes, shared by every select, the preset-name input and the paste boxes
      const SEL_CSS = 'flex:1;min-width:0;background-color:rgba(255,255,255,.05);border:0;border-radius:10px;color:#e6e6ea;font:500 12.5px inherit;padding:10px 12px;cursor:pointer';
      // a small select: opts = [[value, label], …]; set() receives the chosen value string
      const mkSel = (opts, get, set) => { const s = D.createElement('select'); s.className = 'sxsel'; s.style.cssText = SEL_CSS; for (const o of opts) { const op = new Option(o[1], String(o[0])); op.style.color = '#111'; s.add(op); } s.value = String(get()); s.addEventListener('change', () => { try { set(s.value); } catch (e) {} }); return s; };
      // a paste area (AutoEQ text, settings JSON), hidden until its button opens it
      const pasteBox = (ph) => { const t = D.createElement('textarea'); t.placeholder = ph || ''; t.spellcheck = false; t.style.cssText = SEL_CSS + ';height:96px;resize:vertical;cursor:text;display:none;width:100%;box-sizing:border-box;margin-top:8px;font-family:inherit;outline:0'; return t; };

      const mkBtn = (txt) => { const b = D.createElement('button'); b.type = 'button'; b.textContent = txt; b.style.cssText = 'flex:none;border:0;border-radius:10px;padding:10px 14px;font:600 11.5px inherit;cursor:pointer;background:rgba(255,255,255,.06);color:#c4c4ca;transition:background .14s'; b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,.11)'; }); b.addEventListener('mouseleave', () => { b.style.background = 'rgba(255,255,255,.06)'; }); return b; };
      // everything after the canvas lives in one body div, dimmed while comparing (2.3)
      const bodyEl = D.createElement('div'); bodyEl.style.cssText = 'transition:opacity .15s';
      // rows that mirror CFG (the chips, the tone / stereo sliders and switches) re-sync on
      // every applyFx through repaintAll, so a profile tap or a debug write repaints them
      const liveSync = [];
      const syncSlider = (r, get) => () => { const v = get(); if (String(r.input.value) !== String(v)) r.input.value = v; r.paint(); };
      const num = (k, lo, hi) => { const v = +CFG[k]; return isFinite(v) ? cl(v, lo, hi) : 0; };
      const toggleRow = (label, desc, key, guard) => {   // guard() === false keeps the switch where it is
        const row = D.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid rgba(255,255,255,.05)';
        const tx = D.createElement('div'); tx.style.cssText = 'flex:1';
        const t1 = D.createElement('div'); t1.style.cssText = 'font-size:12.5px;color:#e6e6ea'; t1.textContent = label;
        const t2 = D.createElement('div'); t2.style.cssText = 'font-size:10.5px;color:#7c7c84;margin-top:2px'; t2.textContent = desc;
        tx.append(t1, t2);
        const sw = makeSwitch(() => CFG[key], () => { if (guard && guard() === false) return; CFG[key] = !CFG[key]; save(); applyFx(); }, label);
        row.append(tx, sw); bodyEl.appendChild(row); return { row, sw, desc: t2 };
      };

      // ── header: title + the live meter line (2.6), Compare (2.3), the EQ switch ──
      const HINT = '10-band · drag the curve · double-click resets';
      const hd = D.createElement('div'); hd.style.cssText = 'display:flex;align-items:center;margin-bottom:14px';
      const htx = D.createElement('div'); htx.style.cssText = 'flex:1;min-width:0';
      htx.innerHTML = '<div style="font-size:17px;font-weight:700;letter-spacing:-.4px;color:#fff">Equalizer</div><div style="font-size:11px;color:#7c7c84;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>';
      const subEl = htx.children[1];
      // the sub-line: the Compare state while comparing; the meter segments while loudness,
      // boost or the clip guard is in play (LUFS / applied only with loudness on, boost only
      // above 100 %, guard only while it reduces); the plain hint otherwise. Real minus signs.
      const fmtDb = (v, plus) => (v < 0 ? '−' : plus ? '+' : '') + Math.abs(v).toFixed(1);
      let cmpLatched = fxBypass, frame = 0, lastSub = '', lastGuard = '', lastLoud = '', lastNight = '';   // a rebuild while latched keeps the latch
      const subText = () => {
        if (fxBypass) return 'Comparing · original tone' + (cmpLatched ? ' — click Compare to return' : '');
        const boost = CFG.boostAmt | 0, loud = !!CFG.loudnessOn, gr = +meter.limGr;
        if (!loud && boost <= 100 && !needsLimiter()) return HINT;
        const seg = [];
        if (loud && isFinite(meter.i)) seg.push(fmtDb(meter.i) + ' LUFS');
        if (isFinite(meter.peak) && meter.peak > -90) seg.push('peak ' + fmtDb(meter.peak) + ' dB');
        if (loud && isFinite(meter.gainDb) && meter.gainDb > -90) seg.push(fmtDb(meter.gainDb, true) + ' dB applied');
        if (boost > 100) seg.push('boost ' + boost + ' %');
        if (isFinite(gr) && gr < -0.3) seg.push('guard ' + fmtDb(gr) + ' dB');
        return seg.length ? seg.join(' · ') : HINT;
      };
      const paintSub = () => { const t = subText(); if (t !== lastSub) { lastSub = t; subEl.textContent = t; } };
      // Compare: hold to hear the original, a quick click keeps comparing until the next
      // click (or the tab closes). Tint + body dim make it obvious the switches do not apply.
      const cmp = mkBtn('Compare'); cmp.style.padding = '7px 11px'; cmp.style.marginRight = '10px'; cmp.style.userSelect = 'none'; cmp.style.touchAction = 'none';
      cmp.title = 'Hold to hear the original · click to keep comparing';
      const tintCmp = (v) => { cmp.style.background = v ? 'rgba(255,85,0,.22)' : 'rgba(255,255,255,.06)'; cmp.style.color = v ? '#ffb083' : '#c4c4ca'; cmp.setAttribute('aria-pressed', String(!!v)); };
      // mkBtn's own hover handlers run first; these keep the tint while comparing
      cmp.addEventListener('mouseenter', () => { if (fxBypass) tintCmp(true); });
      cmp.addEventListener('mouseleave', () => { if (fxBypass) tintCmp(true); });
      let cmpDown = 0;
      cmp.addEventListener('pointerdown', (ev) => { if (ev.button) return; cmpDown = Date.now(); setBypass(true); });
      const cmpUp = () => {
        if (!cmpDown) return;
        const held = Date.now() - cmpDown; cmpDown = 0;
        if (held < 350) { cmpLatched = !cmpLatched; setBypass(cmpLatched); }
        else { cmpLatched = false; setBypass(false); }
      };
      cmp.addEventListener('pointerup', cmpUp); cmp.addEventListener('pointerleave', cmpUp); cmp.addEventListener('pointercancel', cmpUp);
      cmp.addEventListener('click', (ev) => { if (ev.detail === 0) { cmpLatched = !cmpLatched; setBypass(cmpLatched); } });   // keyboard Enter: a click with no pointer
      paintCmp = (v) => { v = !!v; if (!v) cmpLatched = false; tintCmp(v); bodyEl.style.opacity = v ? '.45' : '1'; try { paintSub(); } catch (e) {} };
      const eqSw = makeSwitch(() => CFG.eqOn, () => { CFG.eqOn = !CFG.eqOn; save(); applyFx(); rememberEq(); }, 'Equalizer');
      hd.append(htx, cmp, eqSw); host.appendChild(hd);

      // ── EQ curve stage (flat, calm) ──
      const stage = D.createElement('div'); stage.style.cssText = 'position:relative;border-radius:14px;background:rgba(255,255,255,.035);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);overflow:hidden';
      const canvas = D.createElement('canvas'); canvas.width = 880; canvas.height = 380; canvas.style.cssText = 'display:block;width:100%;height:188px;touch-action:none;cursor:pointer';
      stage.appendChild(canvas); host.appendChild(stage);
      host.appendChild(bodyEl);

      // ── pre-amp: the value also shows what auto-headroom (2.9) took off ("0 dB · auto −4") ──
      const fmtAuto = () => { const h = Math.round(lastHeadroomDb * 10) / 10; return h > 0 ? ' · auto −' + h : ''; };
      const pre = sliderRow('Pre-amp', -12, 12, 1, () => CFG.eqPreamp | 0, (x) => { CFG.eqPreamp = x | 0; if (!CFG.eqOn) { CFG.eqOn = true; eqSw._paint(); } saveSoon(); applyFx(); rememberEqSoon(); }, (x) => (x > 0 ? '+' : '') + (x | 0) + ' dB' + fmtAuto(), 0);
      pre.row.style.cssText += ';margin-top:6px;border-top:1px solid rgba(255,255,255,.05)';
      pre.row.lastChild.style.cssText += ';width:auto;min-width:104px;white-space:nowrap';   // a fixed reserve for the auto part, so the track does not shift as it changes
      bodyEl.appendChild(pre.row);

      // ── presets (2.27): the select mirrors the curve (blank once it is edited), Save is an inline row ──
      bodyEl.appendChild(sectionLabel('Preset'));
      const pRow = D.createElement('div'); pRow.style.cssText = 'display:flex;gap:8px;align-items:center';
      const sel = D.createElement('select'); sel.className = 'sxsel'; sel.style.cssText = SEL_CSS;
      const fillSel = () => { sel.replaceChildren(); sel.add(new Option('Choose a preset…', '')); const og1 = D.createElement('optgroup'); og1.label = 'Built-in'; for (const k of Object.keys(EQ_PRESETS)) { const o = new Option(k, 'b:' + k); o.style.color = '#111'; og1.appendChild(o); } sel.add(og1); const keys = Object.keys(customPresets()).filter(eqPresetNameOk); if (keys.length) { const og2 = D.createElement('optgroup'); og2.label = 'My presets'; for (const k of keys) { const o = new Option(k, 'c:' + k); o.style.color = '#111'; og2.appendChild(o); } sel.add(og2); } sel.value = ''; };
      fillSel();
      const delBtn = mkBtn('✕'); delBtn.style.display = 'none'; delBtn.style.padding = '10px 0'; delBtn.style.width = '36px'; delBtn.title = 'Delete preset';
      // dirty state: the select shows the preset the curve equals, or nothing once a band or the pre-amp moved
      const syncSel = () => { try { const v = matchEqPreset(); if (sel.value !== v) sel.value = v; delBtn.style.display = (v && v.charAt(0) === 'c') ? '' : 'none'; } catch (e) {} };
      const repaintAll = () => { eqSw._paint(); try { pre.input.value = CFG.eqPreamp | 0; } catch (e) {} pre.paint(); syncSel(); for (const f of liveSync) { try { f(); } catch (e) {} } };
      eqRepaint = repaintAll;
      syncSel();
      sel.addEventListener('change', () => { const v = sel.value; if (!v) { syncSel(); return; } eqPresetHint = v; if (v.charAt(0) === 'b') applyEqPreset(EQ_PRESETS[v.slice(2)]); else { const cu = customPresets(), name = v.slice(2); if (Object.prototype.hasOwnProperty.call(cu, name)) applyEqPreset(cu[name]); else syncSel(); } });
      const setCustom = (cu) => { CFG.eqCustom = clampEqCustom(cu); save(); fillSel(); syncSel(); };
      delBtn.addEventListener('click', () => { const v = sel.value; if (!v || v.charAt(0) !== 'c') return; const name = v.slice(2); const cu = Object.assign({}, customPresets()); delete cu[name]; setCustom(cu); toast('Removed “' + name + '”'); });
      // inline Save: a hidden name row under the preset row (no window.prompt); Enter = OK, Escape = Cancel
      const nRow = D.createElement('div'); nRow.style.cssText = 'display:none;gap:8px;align-items:center;margin-top:8px';
      const nIn = D.createElement('input'); nIn.type = 'text'; nIn.maxLength = 24; nIn.placeholder = 'Preset name'; nIn.spellcheck = false; nIn.style.cssText = SEL_CSS + ';cursor:text;font-family:inherit;outline:0';
      const okBtn = mkBtn('OK'), noBtn = mkBtn('Cancel');
      const showName = (on) => { nRow.style.display = on ? 'flex' : 'none'; if (on) { nIn.value = ''; try { nIn.focus(); } catch (e) {} } };
      const commitName = () => {
        const name = String(nIn.value || '').slice(0, 24).trim();
        if (!eqPresetNameOk(name)) { toast('Not a valid name'); return; }
        const cu = Object.assign({}, customPresets()); cu[name] = { b: ensureEqBands().slice(), pre: CFG.eqPreamp | 0 };
        eqPresetHint = 'c:' + name; setCustom(cu); showName(false); toast('Saved “' + name + '”');
      };
      okBtn.addEventListener('click', commitName); noBtn.addEventListener('click', () => showName(false));
      nIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commitName(); } else if (ev.key === 'Escape') { ev.preventDefault(); showName(false); } });
      const saveBtn = mkBtn('Save'); saveBtn.addEventListener('click', () => showName(nRow.style.display === 'none'));
      const flatBtn = mkBtn('Reset'); flatBtn.addEventListener('click', () => applyEqPreset({ b: EQ_PRESETS.Flat, pre: 0 }));   // flat AND unity, never a stray pre-amp
      pRow.append(sel, delBtn, saveBtn, flatBtn); bodyEl.appendChild(pRow);
      nRow.append(nIn, okBtn, noBtn); bodyEl.appendChild(nRow);
      // auto-headroom (2.9) closes the EQ block
      toggleRow('Auto-headroom', 'Lowers the volume by your biggest boost so nothing clips', 'eqAutoPre');
      toggleRow('Remember EQ per track', 'Each track keeps the curve you last gave it', 'eqPerTrack');   // WP10

      // ── listening on (2.13): three chips, one tap applies a bundle; the lit one is only a
      //    memory of which bundle was tapped, cleared by any edit of what it set ──
      bodyEl.appendChild(sectionLabel('Listening on'));
      const chipRow = D.createElement('div'); chipRow.style.cssText = 'display:flex;gap:8px;align-items:center';
      const chips = [['headphones', 'Headphones'], ['laptop', 'Laptop'], ['speakers', 'Speakers']].map((c) => {
        const b = mkBtn(c[1]); b.style.flex = '1'; b.style.padding = '8px 0';
        const tint = () => { const lit = CFG.listenOn === c[0]; b.style.background = lit ? 'rgba(255,85,0,.22)' : 'rgba(255,255,255,.06)'; b.style.color = lit ? '#ffb083' : '#c4c4ca'; };
        // mkBtn's own hover handlers run first; these keep the tint on the lit chip
        b.addEventListener('mouseenter', () => { if (CFG.listenOn === c[0]) tint(); });
        b.addEventListener('mouseleave', () => { if (CFG.listenOn === c[0]) tint(); });
        b.addEventListener('click', () => { applyListenOn(c[0]); repaintAll(); });
        b._paint = tint; tint(); chipRow.appendChild(b); return b;
      });
      bodyEl.appendChild(chipRow);
      liveSync.push(() => chips.forEach((b) => b._paint()));

      // ── playback (2.19 – 2.21): Speed + tempo chips, Pitch follows speed, Fade in / out + lengths.
      //    Speed is the suite's most-used control, so it sits right under Listening on ──
      bodyEl.appendChild(sectionLabel('Playback'));
      const setSpeed = (x) => { CFG.speed = cl(x | 0, 50, 200); saveSoon(); rememberSpeed(); applySpeed(); refreshBar(); };
      let paintSpeed = () => {};
      const spdR = sliderRow('Speed', 50, 200, 5, () => cl(CFG.speed | 0, 50, 200), (x) => { setSpeed(x); paintSpeed(); }, (x) => (x / 100) + '×', 100);
      spdR.row.firstChild.title = 'Playback speed · 0.5× – 2× · double-click resets';
      bodyEl.appendChild(spdR.row);
      // tempo chips: the same six stops the player-bar pill cycles through; the lit one is the current speed
      const tempoRow = D.createElement('div'); tempoRow.style.cssText = 'display:flex;gap:6px';
      const tempoChips = [50, 75, 100, 125, 150, 200].map((v) => {
        const b = mkBtn((v / 100) + '×'); b.style.flex = '1'; b.style.padding = '8px 0';
        const tint = () => { const lit = (CFG.speed | 0) === v; b.style.background = lit ? 'rgba(255,85,0,.22)' : 'rgba(255,255,255,.06)'; b.style.color = lit ? '#ffb083' : '#c4c4ca'; };
        // mkBtn's own hover handlers run first; these keep the tint on the lit chip
        b.addEventListener('mouseenter', () => { if ((CFG.speed | 0) === v) tint(); });
        b.addEventListener('mouseleave', () => { if ((CFG.speed | 0) === v) tint(); });
        b.addEventListener('click', () => { setSpeed(v); try { spdR.input.value = v; } catch (e) {} spdR.paint(); paintSpeed(); });
        b._paint = tint; tint(); tempoRow.appendChild(b); return b;
      });
      bodyEl.appendChild(tempoRow);
      // pitch follows speed (2.20): the semitone shift rides in the description, hidden at 1×
      const VINYL_DESC = 'Vinyl / tape feel · slowed sounds deeper, sped-up sounds higher';
      const vinR = toggleRow('Pitch follows speed', VINYL_DESC, 'vinylMode');
      const semis = () => { const st = 12 * Math.log2(wantedRate()); return Math.abs(st) < 0.05 ? '' : ' · ' + (st < 0 ? '−' : '+') + Math.abs(st).toFixed(1) + ' semitones'; };
      const paintVinyl = () => { const t = VINYL_DESC + (CFG.vinylMode ? semis() : ''); if (vinR.desc.textContent !== t) vinR.desc.textContent = t; };
      // (no click handler of its own: toggleRow's switch saves and runs applyFx, which syncs preservesPitch)
      // reverb (WP10) + the "Slowed + reverb" chip: speed 85 · pitch follows speed · reverb 25, lit while all three hold; a second tap undoes it
      const rvR = sliderRow('Reverb', 0, 100, 5, () => num('reverbAmt', 0, 100), (x) => { CFG.reverbAmt = cl(x | 0, 0, 100); saveSoon(); applyFx(); }, (x) => ((x | 0) ? (x | 0) + '%' : 'Off'), 0);
      rvR.row.firstChild.title = 'A little room around the track · double-click resets'; bodyEl.appendChild(rvR.row);
      const slowRow = D.createElement('div'); slowRow.style.cssText = 'display:flex;gap:6px';
      const slowChip = mkBtn('Slowed + reverb'); slowChip.style.padding = '8px 14px';
      const slowOn = () => (CFG.speed | 0) === 85 && !!CFG.vinylMode && (CFG.reverbAmt | 0) === 25;
      const tintSlow = () => { const lit = slowOn(); slowChip.style.background = lit ? 'rgba(255,85,0,.22)' : 'rgba(255,255,255,.06)'; slowChip.style.color = lit ? '#ffb083' : '#c4c4ca'; };
      slowChip.addEventListener('mouseenter', () => { if (slowOn()) tintSlow(); }); slowChip.addEventListener('mouseleave', () => { if (slowOn()) tintSlow(); });
      slowChip.addEventListener('click', () => {
        const lit = slowOn(); CFG.vinylMode = !lit; CFG.reverbAmt = lit ? 0 : 25; setSpeed(lit ? 100 : 85); save(); applyFx();
        try { spdR.input.value = CFG.speed; } catch (e) {} spdR.paint(); paintSpeed(); toast(lit ? 'Slowed + reverb off' : 'Slowed + reverb · 0.85×, pitch follows, a little room');
      });
      slowRow.appendChild(slowChip); bodyEl.appendChild(slowRow);
      paintSpeed = () => { tempoChips.forEach((b) => b._paint()); paintVinyl(); tintSlow(); };
      paintVinyl();
      // fade in / out (2.21): the lengths dim while off and wake the switch like Intensity does
      const fadeRow = toggleRow('Fade in / out', 'Smooth the gap between tracks', 'fadeOn');
      const fmtSec = (x) => (+x).toFixed(1) + ' s';
      let fiR = null, foR = null;
      const paintFade = () => { try { const op = CFG.fadeOn ? '1' : '.45'; fiR.row.style.opacity = op; foR.row.style.opacity = op; } catch (e) {} };
      const wakeFade = () => { if (!CFG.fadeOn) { CFG.fadeOn = true; fadeRow.sw._paint(); } saveSoon(); applyFx(); paintFade(); };
      fiR = sliderRow('Fade in', 0, 3, 0.1, () => num('fadeIn', 0, 3), (x) => { CFG.fadeIn = Math.round(cl(+x || 0, 0, 3) * 10) / 10; wakeFade(); }, fmtSec, 0.6);
      foR = sliderRow('Fade out', 0, 8, 0.1, () => num('fadeOut', 0, 8), (x) => { CFG.fadeOut = Math.round(cl(+x || 0, 0, 8) * 10) / 10; wakeFade(); }, fmtSec, 2.5);
      foR.row.firstChild.title = 'Fade out · shortened in proportion at higher speeds · double-click resets';
      fadeRow.sw.addEventListener('click', paintFade);
      paintFade(); bodyEl.append(fiR.row, foR.row);
      const skipRow = toggleRow('Skip silent endings', 'Jumps to the end when the last 30 s of a track go quiet · never mid-track', 'skipSilence');   // WP10
      liveSync.push(syncSlider(spdR, () => cl(CFG.speed | 0, 50, 200)), syncSlider(rvR, () => num('reverbAmt', 0, 100)), () => { paintSpeed(); vinR.sw._paint(); },
        syncSlider(fiR, () => num('fadeIn', 0, 3)), syncSlider(foR, () => num('fadeOut', 0, 8)), () => { fadeRow.sw._paint(); skipRow.sw._paint(); paintFade(); });

      // ── tone (2.10 – 2.14): Bass · Vocals · Loudness contour · Tilt. No master switch — the
      //    label's double-click (sliderRow's resetTo) is how a listener turns a knob off ──
      bodyEl.appendChild(sectionLabel('Tone'));
      const VAL_WIDE = ';width:62px';   // room for "Softer 100" / "Bright 2.5" without the track shifting mid-drag
      const bassR = sliderRow('Bass', 0, 9, 0.5, () => num('bassDb', 0, 9), (x) => { CFG.bassDb = cl(+x || 0, 0, 9); saveSoon(); applyFx(); }, (x) => (x > 0 ? '+' : '') + x + ' dB', 0);
      bassR.row.firstChild.title = 'Sub-25 Hz rumble is removed automatically while bass is boosted · double-click resets';
      bassR.row.lastChild.style.cssText += VAL_WIDE; bodyEl.appendChild(bassR.row);
      // harmonic bass (WP10): harmonics of the sub-bass that a small speaker can actually play
      const harmR = sliderRow('Harmonic bass', 0, 100, 5, () => num('bassHarm', 0, 100), (x) => { CFG.bassHarm = cl(x | 0, 0, 100); saveSoon(); applyFx(); }, (x) => ((x | 0) ? (x | 0) + '%' : 'Off'), 0);
      harmR.row.firstChild.title = 'Adds harmonics of the sub-bass that small speakers can play · double-click resets';
      harmR.row.lastChild.style.cssText += VAL_WIDE; bodyEl.appendChild(harmR.row);
      const vocR = sliderRow('Vocals', -100, 100, 5, () => num('vocalAmt', -100, 100), (x) => { CFG.vocalAmt = cl(x | 0, -100, 100); saveSoon(); applyFx(); }, (x) => (meter.monoSrc && (x | 0) !== 0 ? 'Mono upload' : x < 0 ? 'Softer ' + (-x | 0) : x > 0 ? 'Lift ' + (x | 0) : 'Normal'), 0);
      vocR.row.firstChild.title = 'Softens or lifts the centre of a stereo mix (200 Hz – 7 kHz) · vocals are softened, not removed · double-click resets';
      vocR.row.lastChild.style.cssText += VAL_WIDE; bodyEl.appendChild(vocR.row);
      // loudness contour (2.14): the description carries the live state so the row never looks
      // broken for listeners who use the OS volume (invisible to a page) instead of SoundCloud's slider
      const LC_DESC = 'Keeps bass & sparkle when SoundCloud’s volume slider is low';
      const lcRow = toggleRow('Loudness contour', LC_DESC, 'loudCompOn');
      const lcDesc = () => { if (!CFG.loudCompOn) return LC_DESC; const db = contourK > 0 ? contourK * num('loudCompAmt', 0, 9) : 0; return LC_DESC + (db > 0 ? ' · +' + db.toFixed(1) + ' dB bass' : ' · off at this volume'); };
      let lastLc = ''; const paintLc = () => { const t = lcDesc(); if (t !== lastLc) { lastLc = t; lcRow.desc.textContent = t; } };
      paintLc(); lcRow.sw.addEventListener('click', paintLc);
      const tiltR = sliderRow('Tilt', -4, 4, 0.5, () => num('tiltDb', -4, 4), (x) => { CFG.tiltDb = cl(+x || 0, -4, 4); saveSoon(); applyFx(); }, (x) => (x < 0 ? 'Warm ' + (-x) : x > 0 ? 'Bright ' + x : 'Flat'), 0);
      tiltR.row.firstChild.title = 'Tilts the whole balance around 700 Hz · the figure is per shelf · double-click resets';
      tiltR.row.lastChild.style.cssText += VAL_WIDE; bodyEl.appendChild(tiltR.row);
      liveSync.push(syncSlider(bassR, () => num('bassDb', 0, 9)), syncSlider(harmR, () => num('bassHarm', 0, 100)), syncSlider(vocR, () => num('vocalAmt', -100, 100)), syncSlider(tiltR, () => num('tiltDb', -4, 4)), () => { lcRow.sw._paint(); paintLc(); });

      // ── enhance ──
      bodyEl.appendChild(sectionLabel('Enhance'));
      const enhHead = D.createElement('div'); enhHead.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid rgba(255,255,255,.05)';
      const enhTx = D.createElement('div'); enhTx.style.cssText = 'flex:1';
      enhTx.innerHTML = '<div style="font-size:12.5px;color:#e6e6ea">Enhance audio</div><div style="font-size:10.5px;color:#7c7c84;margin-top:2px">Clarity, warmth &amp; punch — level-matched, no loudness trick</div>';
      const intR = sliderRow('Intensity', 0, 100, 5, () => CFG.enhanceAmt | 0, (x) => { CFG.enhanceAmt = x | 0; if (!CFG.enhanceOn) { CFG.enhanceOn = true; enhSw._paint(); intR.row.style.opacity = '1'; } saveSoon(); applyFx(); }, (x) => (x | 0) + '%', 50);
      const enhSw = makeSwitch(() => CFG.enhanceOn, () => { CFG.enhanceOn = !CFG.enhanceOn; save(); applyFx(); intR.row.style.opacity = CFG.enhanceOn ? '1' : '.45'; }, 'Enhance audio');
      enhHead.append(enhTx, enhSw); bodyEl.appendChild(enhHead);
      intR.row.style.opacity = CFG.enhanceOn ? '1' : '.45'; bodyEl.appendChild(intR.row);

      // ── loudness & dynamics ──
      bodyEl.appendChild(sectionLabel('Loudness & dynamics'));
      // loudness normalize (2.4): the description carries the live state (measuring… / applied /
      // remembered); the Target select re-applies the gain at once and, like Intensity, wakes the switch
      const LOUD_DESC = 'Even out quiet & loud tracks';
      const loudRow = toggleRow('Loudness normalize', LOUD_DESC, 'loudnessOn');
      const tgRow = D.createElement('div'); tgRow.style.cssText = 'display:flex;align-items:center;gap:14px;padding:10px 0;transition:opacity .15s';
      const tgL = D.createElement('span'); tgL.textContent = 'Target'; tgL.style.cssText = 'flex:none;width:86px;font-size:12.5px;color:#c4c4cc';
      tgL.title = 'Quiet −18 · Normal −14 · Loud −11 LUFS';
      const paintTg = () => { tgRow.style.opacity = CFG.loudnessOn ? '1' : '.45'; };
      const tgSel = mkSel([['-18', 'Quiet'], ['-14', 'Normal'], ['-11', 'Loud']], () => ([-18, -14, -11].indexOf(CFG.loudTarget | 0) >= 0 ? CFG.loudTarget | 0 : -14),
        (v) => { CFG.loudTarget = v | 0; if (!CFG.loudnessOn) { CFG.loudnessOn = true; loudRow.sw._paint(); } save(); applyFx(); paintTg(); });
      loudRow.sw.addEventListener('click', paintTg);
      tgRow.append(tgL, tgSel); paintTg(); bodyEl.appendChild(tgRow);
      const loudDesc = () => {
        if (!CFG.loudnessOn) return LOUD_DESC;
        const g = +meter.gainDb;
        if (lnorm.src === 'remembered' && isFinite(g)) return LOUD_DESC + ' · remembered · ' + fmtDb(g, true) + ' dB';
        if (lnorm.src === 'measured' && isFinite(g)) return LOUD_DESC + ' · ' + fmtDb(g, true) + ' dB applied';
        return LOUD_DESC + ' · measuring…';
      };
      loudRow.desc.textContent = loudDesc();
      // night mode (2.7): the comp as a gentle leveller (Night wins over Enhance's punch). Strength dims
      // while off and wakes the switch like Intensity does; the description carries the live gain reduction
      const NIGHT_DESC = 'Quiet parts up, loud parts down · late-night & commute listening';
      const nightRow = toggleRow('Night mode', NIGHT_DESC, 'nightOn');
      let strR = null;
      const paintNight = () => { try { strR.row.style.opacity = CFG.nightOn ? '1' : '.45'; } catch (e) {} };
      strR = sliderRow('Strength', 0, 100, 5, () => cl(CFG.nightAmt | 0, 0, 100), (x) => { CFG.nightAmt = x | 0; if (!CFG.nightOn) { CFG.nightOn = true; nightRow.sw._paint(); } saveSoon(); applyFx(); paintNight(); }, (x) => (x | 0) + '%', 50);
      nightRow.sw.addEventListener('click', paintNight);
      paintNight(); bodyEl.appendChild(strR.row);
      liveSync.push(syncSlider(strR, () => cl(CFG.nightAmt | 0, 0, 100)), () => { nightRow.sw._paint(); paintNight(); });
      // volume boost (2.2): ×1..×3 after the loudness gain, always through the clip guard
      let boostR = null;
      const paintBoost = () => { try { boostR.row.lastChild.style.color = (CFG.boostAmt | 0) > 100 ? '#ff6a1f' : '#86868e'; } catch (e) {} };
      boostR = sliderRow('Volume boost', 100, 300, 5, () => cl(CFG.boostAmt | 0, 100, 300), (x) => { CFG.boostAmt = x | 0; saveSoon(); applyFx(); paintBoost(); }, (x) => (x | 0) + '%', 100);
      paintBoost(); bodyEl.appendChild(boostR.row);
      // clip guard (2.1): the description gains a live gain-reduction suffix while it works
      const GUARD_DESC = 'Stops boosts from distorting · on automatically when boosting or enhancing';
      const guard = toggleRow('Clip guard', GUARD_DESC, 'limiterOn');

      // ── stereo ──
      bodyEl.appendChild(sectionLabel('Stereo'));
      const wR = sliderRow('Stereo width', 0, 200, 5, () => CFG.stereoWidth | 0, (x) => { CFG.stereoWidth = x | 0; saveSoon(); applyFx(); }, (x) => ((x | 0) === 0 ? 'Mono' : (x | 0) === 100 ? 'Normal' : (x | 0) + '%'), 100);
      wR.row.lastChild.style.cssText += VAL_WIDE; bodyEl.appendChild(wR.row);
      // crossfeed (2.16) + its Mode select: like the loudness Target, choosing a mode wakes the switch
      const cfRow = toggleRow('Crossfeed', 'Headphones sound like speakers in a room · less ping-pong fatigue', 'crossfeedOn');
      const mdRow = D.createElement('div'); mdRow.style.cssText = 'display:flex;align-items:center;gap:14px;padding:10px 0;transition:opacity .15s';
      const mdL = D.createElement('span'); mdL.textContent = 'Mode'; mdL.style.cssText = 'flex:none;width:86px;font-size:12.5px;color:#c4c4cc';
      mdL.title = 'How much of each side reaches the other ear · Subtle 9.5 · Natural 6 · Strong 4.5 dB below direct';
      const CF_MODES = ['subtle', 'natural', 'strong'];
      const cfMode = () => (CF_MODES.indexOf(CFG.crossfeedMode) >= 0 ? CFG.crossfeedMode : 'natural');
      const paintMd = () => { mdRow.style.opacity = CFG.crossfeedOn ? '1' : '.45'; };
      const mdSel = mkSel([['subtle', 'Subtle'], ['natural', 'Natural'], ['strong', 'Strong']], cfMode,
        (v) => { CFG.crossfeedMode = CF_MODES.indexOf(v) >= 0 ? v : 'natural'; if (!CFG.crossfeedOn) { CFG.crossfeedOn = true; cfRow.sw._paint(); } save(); applyFx(); paintMd(); });
      cfRow.sw.addEventListener('click', paintMd);
      mdRow.append(mdL, mdSel); paintMd(); bodyEl.appendChild(mdRow);
      // balance (2.17): attenuates the other side only, never boosts
      const balR = sliderRow('Balance', -100, 100, 5, () => num('balance', -100, 100), (x) => { CFG.balance = cl(x | 0, -100, 100); saveSoon(); applyFx(); }, (x) => (x < 0 ? 'L ' + (-x | 0) : x > 0 ? 'R ' + (x | 0) : 'Centre'), 0);
      balR.row.lastChild.style.cssText += VAL_WIDE; bodyEl.appendChild(balR.row);
      const monoRow = toggleRow('Mono', 'Same sound in both ears · for one earbud or a single speaker', 'monoOn');
      // swap L / R (WP10): falls out of the 2×2 matrix — the rows swap, balance still applies per output
      const swapRow = toggleRow('Swap left / right', 'Left channel in the right ear and vice versa · for reversed headphones', 'swapLR');
      liveSync.push(syncSlider(wR, () => cl(CFG.stereoWidth | 0, 0, 200)), syncSlider(balR, () => num('balance', -100, 100)),
        () => { cfRow.sw._paint(); monoRow.sw._paint(); swapRow.sw._paint(); paintMd(); const mv = cfMode(); if (mdSel.value !== mv) mdSel.value = mv; });

      // a paste area with Apply / Cancel under it, hidden until its opener shows it (2.8, 2.22);
      // Apply keeps the box open when the text was refused (the toast says why)
      const pasteUi = (ph, onApply) => {
        const box = pasteBox(ph);
        const act = D.createElement('div'); act.style.cssText = 'display:none;gap:8px;margin-top:8px';
        const ok = mkBtn('Apply'), no = mkBtn('Cancel');
        const show = (v) => { box.style.display = v ? 'block' : 'none'; act.style.display = v ? 'flex' : 'none'; if (v) { try { box.focus(); } catch (e) {} } else box.value = ''; };
        ok.addEventListener('click', () => { try { const t = box.value; if (!t.trim()) { show(false); return; } if (onApply(t) !== false) show(false); } catch (e) {} });
        no.addEventListener('click', () => show(false));
        act.append(ok, no); bodyEl.append(box, act);
        return { box, act, show };
      };

      // ── headphone correction (2.8): the AutoEQ bank, kept apart from the taste EQ ──
      bodyEl.appendChild(sectionLabel('Headphone correction'));
      const PEQ_HINT = 'Paste an AutoEQ profile for your headphones';
      const peqDesc = () => {
        const n = Array.isArray(CFG.peq) ? CFG.peq.length : 0;
        if (!n || !CFG.peqName) return PEQ_HINT;
        const shelf = CFG.peq.some((f) => f && f.t !== 'PK');   // Web Audio shelves have a fixed slope: the profile's shelf Q cannot be honoured
        return CFG.peqName + ' · ' + n + (n === 1 ? ' filter' : ' filters') + (shelf ? ' (shelf Q ignored)' : '');
      };
      // without a profile the switch cannot do anything: it opens the paste box instead of routing an empty chain
      let pqUi = null;
      const peqRow = toggleRow('Headphone correction', peqDesc(), 'peqOn', () => { if (!CFG.peqOn && !(Array.isArray(CFG.peq) && CFG.peq.length)) { pqUi.show(true); return false; } });
      const pqBtns = D.createElement('div'); pqBtns.style.cssText = 'display:flex;gap:8px;margin-top:4px';
      const pqPaste = mkBtn('Paste AutoEQ'), pqClear = mkBtn('Clear');
      pqBtns.append(pqPaste, pqClear); bodyEl.appendChild(pqBtns);
      pqUi = pasteUi('Preamp: -6.2 dB\nFilter 1: ON PK Fc 105 Hz Gain 3.1 dB Q 0.7 …', (t) => importAudioText(t));
      const paintPeq = () => { peqRow.sw._paint(); const d = peqDesc(); if (peqRow.desc.textContent !== d) peqRow.desc.textContent = d; pqClear.style.display = (Array.isArray(CFG.peq) && CFG.peq.length) ? '' : 'none'; };
      pqPaste.addEventListener('click', () => pqUi.show(true));
      pqClear.addEventListener('click', () => { clearAutoEq(); paintPeq(); });
      paintPeq(); liveSync.push(paintPeq);

      // ── footer (2.22): Copy / Paste / Reset all audio, then the engine footnote (2.24) ──
      const ft = D.createElement('div'); ft.style.cssText = 'display:flex;gap:8px;margin-top:18px';
      const cpB = mkBtn('Copy settings'), psB = mkBtn('Paste settings'), rsB = mkBtn('Reset all audio');
      cpB.title = 'Every audio setting + the per-track loudness memory, as JSON'; psB.title = 'The JSON from Copy settings, or an AutoEQ profile'; rsB.title = 'Every audio setting back to its default · saved presets stay';
      for (const b of [cpB, psB, rsB]) { b.style.flex = '1 1 0'; b.style.minWidth = '0'; b.style.padding = '10px 6px'; b.style.whiteSpace = 'nowrap'; }   // three across the ~396 px body
      ft.append(cpB, psB, rsB); bodyEl.appendChild(ft);
      const psUi = pasteUi('Paste the JSON from Copy settings here (an AutoEQ profile works too)', (t) => importAudioText(t));
      cpB.addEventListener('click', () => { try { clip(JSON.stringify(exportAudio()), 'Audio settings copied'); } catch (e) {} });
      psB.addEventListener('click', () => psUi.show(true));
      rsB.addEventListener('click', () => { try { resetAudio(); } catch (e) {} });

      // ── footnote (2.24): the engine line (rate · total delay = output + effects), refreshed
      //    from the draw loop every 60 frames, then the plain-language sentences ──
      const NOTE_TAIL = 'These shape SoundCloud’s audio in real time; turn them off and playback returns to normal instantly. Crossfade and higher bitrates aren’t possible in the browser; the system volume is invisible to the loudness contour.';
      const noteText = () => {
        let sr = 48000, fx = 0, out = 0;
        try { sr = (sceLastCtx && sceLastCtx.sampleRate) || 48000; } catch (e) {}
        try { fx = fxLatencyMs() | 0; } catch (e) {}
        try { out = Math.max(0, ((SUITE.audioLatency ? SUITE.audioLatency() : sceLatMs) | 0) - fx); } catch (e) { out = sceLatMs | 0; }
        return Math.round(sr / 1000) + ' kHz · ' + (out + fx) + ' ms delay (' + out + ' ms output + ' + fx + ' ms effects) · ' + NOTE_TAIL;
      };
      const note = D.createElement('div'); note.style.cssText = 'margin-top:20px;font-size:10px;color:#67676f;line-height:1.5';
      let lastNote = '';
      const paintNote = () => { const t = noteText(); if (t !== lastNote) { lastNote = t; note.textContent = t; } };
      paintNote(); bodyEl.appendChild(note);

      // ── the live numbers: output-tap reads at 10 Hz while loudness is off (the loudness
      //    loop reads them itself otherwise); sub-line + guard suffix repainted at ~5 Hz ──
      const refreshMeter = () => {
        try {
          if (!loudTimer && frame % 6 === 0) peakTick();
          if (frame % 60 === 0) paintNote();
          if (frame % 12) return;
          paintSub();
          const gr = +meter.limGr;
          const g = (isFinite(gr) && gr < -0.3) ? GUARD_DESC + ' · ' + fmtDb(gr) + ' dB' : GUARD_DESC;
          if (g !== lastGuard) { lastGuard = g; guard.desc.textContent = g; }
          const ng = +meter.gr;
          const nd = (CFG.nightOn && isFinite(ng) && ng < -0.3) ? NIGHT_DESC + ' · ' + fmtDb(ng) + ' dB' : NIGHT_DESC;
          if (nd !== lastNight) { lastNight = nd; nightRow.desc.textContent = nd; }
          const ld = loudDesc();
          if (ld !== lastLoud) { lastLoud = ld; loudRow.desc.textContent = ld; }
          paintLc();
        } catch (e) {}
      };

      // ── EQ curve renderer (2.26): the TRUE composite response from the probe bank (bands +
      //    bass + tilt, plus the Enhance shelves / contour while they are on) on a log axis, the
      //    spectrum on the same axis, dotted ±6 / ±12 grid, the AutoEQ bank dashed, small dots ──
      const cx = canvas.getContext('2d');
      const N = EQ_FREQS.length, CW = canvas.width, CH = canvas.height;
      const padX = 30, padY = 48, usableH = CH - padY * 2, midY = padY + usableH / 2;
      const bandX = (i) => padX + (i / (N - 1)) * (CW - padX * 2);
      // the log axis runs through the handles (31 Hz at bandX(0), 16 kHz at bandX(9)) so every
      // handle sits on the curve; the curve and the spectrum continue to the canvas edges (≈ 25 Hz .. 20 kHz)
      const LOGSPAN = Math.log2(EQ_FREQS[N - 1] / EQ_FREQS[0]);
      const freqX = (f) => padX + Math.log2(f / EQ_FREQS[0]) / LOGSPAN * (CW - padX * 2);
      const xFreq = (x) => EQ_FREQS[0] * Math.pow(2, (x - padX) / (CW - padX * 2) * LOGSPAN);
      const gainToY = (g) => midY - (cl(g, -12, 12) / 12) * (usableH / 2);
      const gainFromY = (y) => cl(Math.round((midY - y) / (usableH / 2) * 12), -12, 12);
      let dragBand = -1, hoverBand = -1;
      const evToC = (ev) => { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) / r.width * CW, y: (ev.clientY - r.top) / r.height * CH }; };
      const nearest = (x) => { let bi = 0, bd = 1e9; for (let i = 0; i < N; i++) { const d = Math.abs(x - bandX(i)); if (d < bd) { bd = d; bi = i; } } return bi; };
      canvas.addEventListener('pointerdown', (ev) => { if (ev.button) return; const p = evToC(ev); dragBand = nearest(p.x); try { canvas.setPointerCapture(ev.pointerId); } catch (e) {} setBand(dragBand, gainFromY(p.y)); });
      canvas.addEventListener('pointermove', (ev) => { const p = evToC(ev); if (dragBand >= 0) setBand(dragBand, gainFromY(p.y)); else hoverBand = nearest(p.x); });
      canvas.addEventListener('pointerup', () => { if (dragBand >= 0) rememberEq(); dragBand = -1; });   // per-track memory (WP10): once the hand stops
      canvas.addEventListener('pointercancel', () => { dragBand = -1; });
      canvas.addEventListener('pointerleave', () => { hoverBand = -1; });
      canvas.addEventListener('dblclick', (ev) => { const p = evToC(ev); setBand(nearest(p.x), 0); rememberEq(); });
      // keyboard: the curve is focusable — ← → pick a band, ↑ ↓ move it by 1 dB, Home or 0 flattens it
      canvas.tabIndex = 0; canvas.setAttribute('role', 'slider'); canvas.setAttribute('aria-label', 'Equalizer bands');
      const eqAria = (i) => { const g = ensureEqBands()[i] | 0; canvas.setAttribute('aria-valuenow', String(g)); canvas.setAttribute('aria-valuetext', EQ_LABELS[i] + ' Hz ' + (g > 0 ? '+' : '') + g + ' dB'); };
      canvas.addEventListener('focus', () => { if (hoverBand < 0) hoverBand = 0; eqAria(hoverBand); });
      canvas.addEventListener('blur', () => { hoverBand = -1; });
      canvas.addEventListener('keydown', (ev) => {
        const i = hoverBand >= 0 ? hoverBand : 0; let handled = true;
        if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') hoverBand = cl(i + (ev.key === 'ArrowRight' ? 1 : -1), 0, N - 1);
        else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') { hoverBand = i; setBand(i, (ensureEqBands()[i] | 0) + (ev.key === 'ArrowUp' ? 1 : -1)); rememberEq(); }
        else if (ev.key === 'Home' || ev.key === '0') { hoverBand = i; setBand(i, 0); rememberEq(); }
        else handled = false;
        if (handled) { ev.preventDefault(); ev.stopPropagation(); eqAria(hoverBand); }
      });
      // the composite is read from the probe bank only when applyFx changed something (eqCurveVer)
      let drawnVer = -1, curve = null, peqCurve = null, peqAny = false, drawnHover = -2, drawnDrag = -2;
      const refreshCurve = () => { const cd = compositeDb(); curve = cd.userDb; for (let i = 0; i < curve.length; i++) curve[i] += cd.enhDb[i]; peqCurve = cd.peqDb; peqAny = false; for (let i = 0; i < peqCurve.length; i++) if (Math.abs(peqCurve[i]) > 0.05) { peqAny = true; break; } };
      const plot = (arr) => { cx.beginPath(); for (let i = 0; i < PROBE_N; i++) { const x = freqX(PROBE_FREQS[i]), y = gainToY(arr[i]); if (i) cx.lineTo(x, y); else cx.moveTo(x, y); } };
      // spectrum bars: 64 over the same axis, each the max of the FFT bins it spans (recomputed per sample rate)
      const BARS = 64, barLo = new Int32Array(BARS), barHi = new Int32Array(BARS); let barsSr = 0;
      const GRID = [12, 6, -6, -12];
      if (eqRaf) { try { cancelAnimationFrame(eqRaf); } catch (e) {} eqRaf = 0; }
      const draw = () => {
        if (!audioTabOn || !canvas.isConnected) { eqRaf = 0; return; }
        eqRaf = requestAnimationFrame(draw);
        frame++; refreshMeter();
        try {
          const changed = eqCurveVer !== drawnVer;
          if (changed) { drawnVer = eqCurveVer; refreshCurve(); repaintAll(); }
          // frame skipping: nothing plays and nothing changed → repaint every 4th frame
          let idle = false; try { const m = activeMedia(); idle = !m || m.paused; } catch (e) {}
          if (!changed && idle && hoverBand === drawnHover && dragBand === drawnDrag && (frame & 3)) return;
          drawnHover = hoverBand; drawnDrag = dragBand;
          cx.clearRect(0, 0, CW, CH);
          const e = [...sceFx].pop(); const ch = e && e.chain;
          if (ch) {
            ch.analyser.getByteFrequencyData(ch.freq);
            const bins = ch.freq, n = bins.length, bw = CW / BARS;
            let sr = 48000; try { sr = e.ctx.sampleRate || 48000; } catch (er) {}
            if (sr !== barsSr) { barsSr = sr; const binHz = sr / ch.analyser.fftSize; for (let b = 0; b < BARS; b++) { let lo = Math.floor(xFreq(b * bw) / binHz), hi = Math.floor(xFreq((b + 1) * bw) / binHz); lo = Math.max(1, Math.min(n - 1, lo)); if (hi <= lo) hi = lo + 1; if (hi > n) hi = n; barLo[b] = lo; barHi[b] = hi; } }
            for (let b = 0; b < BARS; b++) { let m = 0; for (let k = barLo[b]; k < barHi[b]; k++) if (bins[k] > m) m = bins[k]; const v = m / 255, bh = v * (CH * 0.7); cx.fillStyle = 'rgba(255,255,255,' + (0.03 + v * 0.05).toFixed(3) + ')'; cx.fillRect(b * bw, CH - bh, bw - 1, bh); }
          }
          // grid: the midline, dotted ±6 / ±12 lines, small labels at the left edge
          cx.strokeStyle = 'rgba(255,255,255,.05)'; cx.lineWidth = 1; cx.beginPath(); cx.moveTo(0, midY); cx.lineTo(CW, midY); cx.stroke();
          cx.strokeStyle = 'rgba(255,255,255,.04)'; cx.setLineDash([1, 3]); cx.beginPath();
          for (const g of GRID) { const y = Math.round(gainToY(g)) + 0.5; cx.moveTo(0, y); cx.lineTo(CW, y); }
          cx.stroke(); cx.setLineDash([]);
          cx.font = '500 14px -apple-system,BlinkMacSystemFont,sans-serif'; cx.textAlign = 'left'; cx.textBaseline = 'middle'; cx.fillStyle = '#76767e';
          for (const g of GRID) cx.fillText((g > 0 ? '+' : '−') + Math.abs(g), 6, gainToY(g));
          cx.textBaseline = 'alphabetic';
          const bands = ensureEqBands();
          if (curve) {
            // soft fill between the composite and the midline, then the line itself
            plot(curve); cx.lineTo(freqX(PROBE_FREQS[PROBE_N - 1]), midY); cx.lineTo(freqX(PROBE_FREQS[0]), midY); cx.closePath();
            const fg = cx.createLinearGradient(0, padY, 0, CH - padY); fg.addColorStop(0, 'rgba(255,90,0,.13)'); fg.addColorStop(.5, 'rgba(255,90,0,.02)'); fg.addColorStop(1, 'rgba(255,90,0,.13)');
            cx.fillStyle = fg; cx.fill();
            cx.strokeStyle = '#ff7a3d'; cx.lineWidth = 2; cx.lineJoin = 'round'; plot(curve); cx.stroke();
            // the headphone-correction bank, dashed, only while it does something
            if (peqAny) { cx.setLineDash([6, 5]); cx.strokeStyle = 'rgba(255,255,255,.35)'; cx.lineWidth = 1.5; plot(peqCurve); cx.stroke(); cx.setLineDash([]); }
          }
          cx.font = '500 15px -apple-system,BlinkMacSystemFont,sans-serif'; cx.textAlign = 'center';
          for (let i = 0; i < N; i++) { const x = bandX(i), y = gainToY(bands[i] || 0), act = (i === dragBand || i === hoverBand); cx.fillStyle = act ? 'rgba(255,170,120,.85)' : 'rgba(150,150,160,.36)'; cx.fillText(EQ_LABELS[i], x, CH - 16); cx.beginPath(); cx.arc(x, y, act ? 5.5 : 4, 0, 7); cx.fillStyle = act ? '#ff7a3d' : '#fff'; cx.fill(); }
          // stereo correlation (WP10): a 3-px tick on a small scale in the free top-right corner — left = anti-phase,
          // right = identical channels; lit while the mono-upload guard holds the vocal band
          if (isFinite(meter.corr)) { const x0 = CW - padX - 40, y = 14; cx.fillStyle = 'rgba(255,255,255,.06)'; cx.fillRect(x0, y - 1, 40, 2); cx.fillStyle = meter.monoSrc ? 'rgba(255,170,120,.85)' : 'rgba(150,150,160,.5)'; cx.fillRect(x0 + (meter.corr + 1) / 2 * 40 - 1.5, y - 6, 3, 12); }
          // the value while dragging, just above the handle
          if (dragBand >= 0) { const g = bands[dragBand] | 0; cx.fillStyle = 'rgba(255,170,120,.85)'; cx.fillText((g > 0 ? '+' : g < 0 ? '−' : '') + Math.abs(g) + ' dB', bandX(dragBand), gainToY(g) - 16); }
        } catch (e) {}
      };
      draw();
      paintCmp(fxBypass);   // a reopened tab never shows an un-tinted button while bypassed
    } catch (e) {}
  }
  try { SUITE.audioRender = audioRender; } catch (e) {}
  try { SUITE.audioTabActive = (on) => { audioTabOn = !!on; if (!on) setBypass(false); try { applyFx(); } catch (e) {} }; } catch (e) {}
  // audio hotkeys (2.23): one dispatcher for a keydown OR keyup; returns true when it consumed the key. Two callers —
  // module 3's own window listeners (hub closed) and the hub's hotkeys() on its Audio tab (hub open) — so A/N/,/.
  // never reach tap-align, the mini bar or lyric nudging while the listener is looking at the Audio tab
  function stepSpeed(d) {
    CFG.speed = Math.max(50, Math.min(200, (CFG.speed | 0) + d));
    save(); rememberSpeed(); enforce(); refreshBar();
    try { if (eqRepaint) eqRepaint(); } catch (e) {}   // the Audio tab's Speed row and chips follow
    toast('Speed ' + (CFG.speed / 100) + '×');
  }
  function toggleNight() {
    CFG.nightOn = !CFG.nightOn;
    save(); applyFx();
    try { if (eqRepaint) eqRepaint(); } catch (e) {}
    toast('Night mode ' + (CFG.nightOn ? 'on' : 'off'));
  }
  try {
    SUITE.audioKey = (e) => {
      try {
        if (!CFG.hotkeys || !e) return false;
        if (e.altKey || e.ctrlKey || e.metaKey) return false;
        const t = (e.composedPath ? e.composedPath()[0] : null) || e.target, ae = D.activeElement;
        const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (typing(t) || typing(ae)) return false;
        const k = e.key, down = e.type === 'keydown';
        const mine = k === 'a' || k === 'A' || k === 'n' || k === 'N' || k === ',' || k === '.';
        if (!mine) return false;
        // a held key auto-repeats after ~500 ms: those keydowns are ours to swallow (true = the hub's hotkeys()
        // yields too), otherwise a held A would fall through to tap-align, N to the mini bar, , . to lyric nudging
        if (e.repeat) return true;
        if (k === 'a' || k === 'A') { setBypass(down); return true; }   // hold to compare: down sets, up clears
        if (!down) return false;
        if (k === 'n' || k === 'N') { toggleNight(); return true; }
        if (k === ',') { stepSpeed(-5); return true; }
        if (k === '.') { stepSpeed(5); return true; }
      } catch (e2) {}
      return false;
    };
  } catch (e) {}
  // expose the captured audio element's clock + the AudioContext output latency
  // so the lyrics engine can sync the highlight to what's HEARD, not just decoded
  try { SUITE.audioClock = () => { try {
    // SoundCloud's own visible position — the source of truth for WHICH track is
    // playing. Used to reject a preloaded/stale media element whose currentTime
    // belongs to a different song (the classic cause of "wildly out of sync").
    let ref = -1;
    try { const w = document.querySelector('.playbackTimeline__progressWrapper'); if (w) { const v = parseFloat(w.getAttribute('aria-valuenow')); if (isFinite(v) && v >= 0) ref = v; } } catch (e) {}
    let best = null, bestDelta = Infinity;
    sceMediaEls.forEach((m) => {
      if (!m || m.paused || !isFinite(m.currentTime) || m.currentTime <= 0) return;
      if (ref >= 0) { const d = Math.abs(m.currentTime - ref); if (d < bestDelta) { bestDelta = d; best = m; } }   // closest to the SC timeline wins
      else if (!best) best = m;
    });
    // if every live element disagrees with the timeline by a wide margin, none of
    // them is the current track — let Media.time() fall back to the SC timeline
    if (best && ref >= 0 && bestDelta > 2.5) return null;
    if (best) return best.currentTime;
    const m = activeMedia(); return (m && isFinite(m.currentTime) && m.currentTime > 0) ? m.currentTime : null;
  } catch (e) { return null; } }; } catch (e) {}
  // device output latency (smoothed) + whatever the FX chain adds — in output ms
  try { SUITE.audioLatency = () => { try { const c = sceLastCtx; if (c) { const l = (c.outputLatency || c.baseLatency || 0); const raw = (l > 0 && l < 0.6) ? Math.round(l * 1000) : 0; if (raw > 0 && Math.abs(raw - sceLatMs) >= 5) sceLatMs = raw; } return sceLatMs + fxLatencyMs(); } catch (e) { return sceLatMs; } }; } catch (e) {}
  // the hub converts that latency from output seconds to media seconds
  try { SUITE.audioRate = () => wantedRate(); } catch (e) {}
  // the captured source and its context for the hub's own analysis taps (lyric auto-align):
  // the newest entry, whether or not the chain is routed — a tap on the source node hears the
  // track either way. null before SoundCloud has built its graph.
  try { SUITE.audioTap = () => { const e = [...sceFx].pop(); return e ? { ctx: e.ctx, src: e.src } : null; }; } catch (e) {}
  // the captured media elements, oldest first: the shuffle module mutes, watches and fades playback through
  // these because SoundCloud's player element never enters the DOM and its own querySelectorAll finds nothing
  try { SUITE.mediaEls = () => [...sceMediaEls]; } catch (e) {}
  // sleep-timer fade (WP10): module 1 asks for it. With the chain routed, a linear ramp of every routed chain's output
  // gain to 0.02 in `sec` s — after the limiter, so it never pumps, and the element's volume (SoundCloud's slider)
  // stays put; 0 restores unity after the pause. false when nothing is routed: module 1 steps the volume instead.
  // The ramp lands a second early (the floor is −34 dB, so nothing is heard of it): module 1's pause click is on the
  // wall clock, the ramp on the audio clock, and the two drift apart on a busy machine.
  try {
    SUITE.audioFadeOut = (sec) => {
      let any = false;
      if (fxRouted) sceFx.forEach((e) => {
        if (!e.routed) return;
        try {
          const g = e.chain.output.gain, t = e.ctx.currentTime || 0;
          g.cancelScheduledValues(t);
          if (sec > 0) { g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0.02, t + Math.max(1, sec - 1)); } else g.setValueAtTime(1, t);
          any = true;
        } catch (er) {}
      });
      sleepFadeOn = any && sec > 0;
      return any;
    };
  } catch (e) {}
  // composite user response at one frequency (dB), from the probe bank (2.26)
  function eqCurveDbAt(f) {
    try { const r = compositeDb(new Float32Array([+f || 1000])); return (r.userDb[0] + r.enhDb[0]) || 0; } catch (e) { return 0; }
  }
  // the saturation curve's value at x ∈ [−1, 1] for the current Enhance intensity,
  // interpolated between table points exactly as the WaveShaper does
  function satCurveAt(x) {
    try {
      const c = satCurve(Math.max(0, Math.min(100, +CFG.enhanceAmt || 0)) / 100);
      const p = (Math.max(-1, Math.min(1, +x || 0)) + 1) / 2 * (c.length - 1);
      const i = Math.max(0, Math.min(c.length - 2, Math.floor(p))), t = p - i;
      return c[i] + (c[i + 1] - c[i]) * t;
    } catch (e) { return NaN; }
  }
  /* ── debug accessor — only when the user opted into debug (localStorage 'scss:debug' = '1').
   * Snapshots every node in the newest chain generically (AudioParams read .value), so
   * later chain stages are covered without touching this block. Mirrored on the window
   * under the same gate because SUITE itself is closure-private. ── */
  try {
    let dbgOn = false; try { dbgOn = W.localStorage.getItem('scss:debug') === '1'; } catch (e) {}
    if (dbgOn) {
      const isAudioNode = (n) => !!(n && typeof n === 'object' && typeof n.connect === 'function' && typeof n.context === 'object');
      const isParam = (p) => !!(p && typeof p === 'object' && typeof p.value === 'number' && typeof p.setValueAtTime === 'function');
      const snapNode = (n) => {
        const out = {};
        for (const k in n) {
          if (k === 'context' || k.indexOf('channel') === 0 || k.indexOf('numberOf') === 0 || k.indexOf('on') === 0) continue;
          let v; try { v = n[k]; } catch (e) { continue; }
          if (isParam(v)) out[k] = v.value;
          else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
          else if (k === 'curve') out.hasCurve = !!v;
        }
        return out;
      };
      const snapAny = (v, depth) => {
        if (v == null || depth > 3) return undefined;
        if (isAudioNode(v)) return snapNode(v);
        if (ArrayBuffer.isView(v)) return undefined;
        if (Array.isArray(v)) return v.map((x) => snapAny(x, depth + 1));
        if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) { const r = snapAny(v[k], depth + 1); if (r !== undefined) o[k] = r; } return o; }
        return undefined;
      };
      const snapshot = () => {
        const e = [...sceFx].pop(); if (!e || !e.chain) return null;
        const out = snapAny(e.chain, 0) || {};
        try { out.shaperOversample = e.chain.shaper.oversample; out.exOversample = e.chain.exShape.oversample; } catch (er) {}
        return out;
      };
      SUITE.audioDebug = () => {
        const e = [...sceFx].pop();
        let hasCurve = false; try { hasCurve = !!(e && e.chain.shaper.curve); } catch (er) {}
        return {
          routed: fxRouted, bypassed: fxBypass, chains: sceFx.size, latencyMs: fxLatencyMs(), outLatMs: sceLatMs, tabOn: audioTabOn,
          sampleRate: (sceLastCtx && sceLastCtx.sampleRate) || 0,
          params: snapshot(), shaperHasCurve: hasCurve, loudTimer: !!loudTimer, meter: Object.assign({}, meter),
          dests: e ? [...e.dests].map((kv) => [kv[0], kv[1][0], kv[1][1]]) : [],
          headroomDb: lastHeadroomDb, curveVer: eqCurveVer, needsLimiter: needsLimiter(),
          branches: e ? { harm: !!e.chain.harmOn, reverb: !!e.chain.rvOn } : null, nodes: () => (e ? e.chain : null), source: () => (e ? e.src : null), context: () => (e ? e.ctx : null),
          guard: (() => { try { const c = e && e.chain; if (!c) return null; const tp = !!(c.tpl && c.tplReady); let bypass = null; try { if (c.tpl) bypass = c.tpl.parameters.get('bypass').value; } catch (er) {}
            return { mode: tp ? 'tp' : 'comp', on: needsLimiter(), ceiling: tp ? TP_CEIL : c.lim.threshold.value, bypass, attached: !!c.tpl, gr: meter.limGr, alignSamples: Math.round(c.tplAlign.delayTime.value * e.ctx.sampleRate), latencySamples: c.tpl ? c.tpl.latencySamples : null, loadErr: TP_LIMITER.lastError ? String(TP_LIMITER.lastError) : null }; } catch (er) { return null; } })(),
          ir: (() => { try { const b = e && e.chain.conv.buffer; if (!b) return null; const a0 = b.getChannelData(0), a1 = b.getChannelData(1); let s01 = 0, s00 = 0, s11 = 0; for (let i = 0; i < a0.length; i++) { s01 += a0[i] * a1[i]; s00 += a0[i] * a0[i]; s11 += a1[i] * a1[i]; } return { sec: b.duration, ch: b.numberOfChannels, corr: s01 / Math.sqrt(s00 * s11) }; } catch (er) { return null; } })(),
          meterTick: () => { peakTick(true); return Object.assign({}, meter); },
          composite: (f) => { const r = compositeDb(f == null ? null : new Float32Array([+f])); return { userDb: Array.from(r.userDb), peqDb: Array.from(r.peqDb), enhDb: Array.from(r.enhDb) }; },
          enhCalib: () => { const o = {}; _enhCalib.forEach((v, k) => { o[k] = Object.assign({}, v); }); return o; }, enhToneMaxDb,
          enhTrack: () => ({ href: enhTrack.href, lufs: enhTrack.lufs, off: enhTrack.off, blocks: enhTrack.recent.length }),
          calib: () => { const o = {}; _calib.forEach((v, k) => { o[k] = Object.assign({}, v); }); return o; },
          set: (k, v) => { CFG[k] = v; save(); applyFx(); }, get: (k) => CFG[k], cfg: () => Object.assign({}, CFG),
          bypass: (v) => setBypass(v), setBand, curveAt: (f) => eqCurveDbAt(f), curveSample: (x) => satCurveAt(x),
          loudMem: () => GET('loud:bytrack', {}) || {},
          loudMemClear: () => SET('loud:bytrack', {}),
          eqMem: () => GET('eq:bytrack', {}) || {}, eqMemClear: () => { SET('eq:bytrack', {}); lastEqUrl = null; }, rememberEq,
          loud: () => ({ href: lnorm.href, blocks: lnorm.blocks.length, lint: lnorm.lint, trackPeak: lnorm.trackPeak, curGainDb: lnorm.curGainDb, nodeDb: lnorm.nodeDb, dur: lnorm.dur, measuring: lnorm.measuring, src: lnorm.src, pending: lnorm.pending }),
          restoreLoud: () => restoreTrackLoud(),
          ab: (a, b) => { abA = +a; abB = +b; abOn = true; abM = activeMedia(); armAb(); refreshBar(); }, abOn: () => abOn, abClear, rate: () => wantedRate(),
          sleep: () => ({ rem: SUITE.sleep ? SUITE.sleep.remainingMs() : -1, armed: !!(SUITE.sleep && SUITE.sleep.armed()), chip: sleepChipMin }),
          sleepSet: (min) => { if (SUITE.sleep) SUITE.sleep.set(+min); }, sleepFading: () => sleepFadeOn,
          muted: () => mutedVol != null,
          seek: (t) => { const m = activeMedia(); if (m) m.currentTime = +t; }, time: () => { const m = activeMedia(); return m ? m.currentTime : null; },
          fade: () => fadeCtl.state(), restartTrack, nudgeSeek, seekPct, applySpeed, status: () => audioStatus(),
          toggleMute, bumpVol, lastClip: () => _lastClip, latency: () => SUITE.audioLatency(),
          pasteAutoEq: applyAutoEqText, clearAutoEq, exportAudio, importAudio: importAudioText, resetAudio,
          gm: (k, v) => { if (v === undefined) return GET(k, null); SET(k, v); }, contourK: () => contourK,
        };
      };
      try { W.__sceAudioDebug = SUITE.audioDebug; } catch (e) {}
    }
  } catch (e) {}

  /* ───────── mini floating now-playing widget (draggable) ───────── */
  let miniEl = null;
  function buildMini() {
    miniEl = D.createElement('div');
    miniEl.style.cssText = 'position:fixed;z-index:2147483340;width:228px;display:none;align-items:center;gap:9px;padding:8px 10px;'
      + 'background:linear-gradient(180deg,rgba(22,22,26,.95),rgba(12,12,14,.97));color:#f2f2f4;border-radius:14px;'
      + 'box-shadow:0 16px 44px -14px rgba(0,0,0,.66),inset 0 0 0 1px rgba(255,255,255,.07);'
      + 'font:600 12px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;cursor:grab';
    try { const p = GET('enh:minipos', null); if (p && isFinite(p.x)) { miniEl.style.left = Math.min(Math.max(4, +p.x), Math.max(4, innerWidth - 232)) + 'px'; miniEl.style.top = Math.min(Math.max(4, +p.y || 0), Math.max(4, innerHeight - 60)) + 'px'; } else { miniEl.style.right = '14px'; miniEl.style.top = '70px'; } } catch (e) {}   // a smaller window must not hide it
    const art = D.createElement('div'); art.className = 'sce-mini-art'; art.style.cssText = 'width:38px;height:38px;border-radius:8px;background:#222 center/cover no-repeat;flex:none';
    const mid = D.createElement('div'); mid.style.cssText = 'flex:1;min-width:0';
    const ttl = D.createElement('div'); ttl.className = 'sce-mini-title'; ttl.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const ctr = D.createElement('div'); ctr.style.cssText = 'display:flex;gap:2px;margin-top:3px';
    const mkb = (txt, sel, name) => {
      const b = D.createElement('button'); b.textContent = txt; b.type = 'button'; b.title = name; b.setAttribute('aria-label', name);
      b.style.cssText = 'background:none;border:0;color:#cfcfd4;cursor:pointer;font-size:12px;padding:2px 6px;border-radius:6px';
      b.addEventListener('click', (e) => { e.stopPropagation(); const el = D.querySelector(sel); if (el) el.click(); });
      b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,.1)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'none'; });
      return b;
    };
    ctr.appendChild(mkb('⏮', '.skipControl__previous', 'Previous track'));
    const playB = mkb('⏯', '.playControls__play', 'Play or pause'); playB.className = 'sce-mini-play'; ctr.appendChild(playB);
    ctr.appendChild(mkb('⏭', '.skipControl__next', 'Next track'));
    mid.appendChild(ttl); mid.appendChild(ctr);
    miniEl.appendChild(art); miniEl.appendChild(mid);
    let dg = null;
    miniEl.addEventListener('pointerdown', (e) => { if (e.button || (e.target.closest && e.target.closest('button'))) return; const r = miniEl.getBoundingClientRect(); dg = { dx: e.clientX - r.left, dy: e.clientY - r.top }; try { miniEl.setPointerCapture(e.pointerId); } catch (e2) {} miniEl.style.cursor = 'grabbing'; });
    miniEl.addEventListener('pointermove', (e) => { if (!dg) return; dg.moved = true; const x = Math.min(Math.max(4, e.clientX - dg.dx), innerWidth - 232); const y = Math.min(Math.max(4, e.clientY - dg.dy), innerHeight - 60); miniEl.style.left = x + 'px'; miniEl.style.top = y + 'px'; miniEl.style.right = 'auto'; });
    miniEl.addEventListener('pointerup', () => { if (dg && dg.moved) { try { SET('enh:minipos', { x: parseInt(miniEl.style.left, 10) || 0, y: parseInt(miniEl.style.top, 10) || 0 }); } catch (e) {} } dg = null; miniEl.style.cursor = 'grab'; });   // a plain click must not save x:0
    (D.body || D.documentElement).appendChild(miniEl);
  }
  function ensureMini() {
    try {
      if (!CFG.miniPlayer) { if (miniEl) miniEl.style.display = 'none'; return; }
      const tl = D.querySelector('.playbackSoundBadge__titleLink');
      if (!tl) { if (miniEl) miniEl.style.display = 'none'; return; }
      if (!miniEl) buildMini();
      miniEl.style.display = 'flex';
      const ttl = miniEl.querySelector('.sce-mini-title');
      const title = (tl.getAttribute('title') || tl.textContent || '').trim();
      if (ttl && ttl.textContent !== title) { ttl.textContent = title; ttl.title = title; }
      const a = D.querySelector('.playbackSoundBadge span.sc-artwork, .playbackSoundBadge .image__full');
      let src = '';
      if (a) { const m = (a.style.backgroundImage || '').match(/url\(["']?(.+?)["']?\)/); if (m) src = m[1]; }
      const artEl = miniEl.querySelector('.sce-mini-art');
      if (artEl && src && artEl.__src !== src) { artEl.__src = src; artEl.style.backgroundImage = 'url("' + src.replace(/["')]/g, '') + '")'; }
      const pc = D.querySelector('.playControls__play');
      const pb = miniEl.querySelector('.sce-mini-play');
      if (pb) pb.textContent = (pc && pc.classList.contains('playing')) ? '⏸' : '▶';
    } catch (e) {}
  }
  let barWrap = null;
  function refreshBar() {
    try {
      if (!barWrap) return;
      const show = (cls, on) => { const el = barWrap.querySelector(cls); if (el) el.style.display = on ? 'inline-flex' : 'none'; };
      const sp = barWrap.querySelector('.sce-speed');
      if (sp) {
        sp.textContent = (CFG.speed / 100) + '×';
        const on = (CFG.speed | 0) !== 100;   // not 1× → a subtle accent so it's clearly engaged
        sp.style.color = on ? '#ff6a1f' : ''; sp.style.opacity = on ? '.95' : '.55';
        sp.style.textShadow = on ? '0 0 10px rgba(255,106,31,.55)' : '';
      }
      show('.sce-speed', CFG.barSpeed);
      show('.sce-copy', CFG.barCopy);
      show('.sce-restart', CFG.barRestart);
      show('.sce-info', CFG.barInfo);
      const ab = barWrap.querySelector('.sce-ab');
      if (ab) { ab.style.display = CFG.barAB ? 'inline-flex' : 'none'; ab.style.color = (abOn ? '#ff6a1f' : ''); ab.style.opacity = abOn ? '.95' : '.55'; ab.style.textShadow = abOn ? '0 0 10px rgba(255,106,31,.55)' : ''; }
      // FX glow (WP10): the hub button wears the speed pill's accent while the listener's own audio settings are
      // engaged (an open tab alone routes the chain but changes nothing audible); the tooltip names it and the boost
      abMarkers();
      const hb = barWrap.querySelector('.sce-hub');
      if (hb) {
        const fx = fxUserOn() && !fxBypass, bst = CFG.boostAmt | 0;
        hb.style.color = fx ? '#ff6a1f' : ''; hb.style.opacity = fx ? '.95' : '.55'; hb.style.textShadow = fx ? '0 0 10px rgba(255,106,31,.55)' : '';
        hb._tip = fx ? 'Audio FX on' + (bst > 100 ? ' · boost ' + bst + ' %' : '') : '';
        const t = 'Open / close the lyrics hub' + (hb._tip ? ' · ' + hb._tip : ''); if (hb.title !== t) hb.title = t;
      }
    } catch (e) {}
  }
  function ensureBar() {
    try {
      const host = D.querySelector('.playControls__elements') || D.querySelector('.playControls');
      if (!host || (barWrap && barWrap.isConnected)) { refreshBar(); return; }
      barWrap = D.createElement('span');
      barWrap.className = 'sce-barwrap';
      // a small, minimal glassy pill that reads on both light and dark bars;
      // position:relative anchors the hover tooltip; flex:none + a little right
      // clearance keeps the last (gear) button from being clipped
      barWrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;gap:0;flex:0 0 auto;margin:0 10px 0 2px;padding:2px;border-radius:9px;vertical-align:middle;background:rgba(124,124,134,.09);box-shadow:inset 0 0 0 1px rgba(150,150,160,.13);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)';
      // one shared minimalist tooltip that floats above the hovered button
      const tip = D.createElement('div');
      tip.style.cssText = 'position:absolute;bottom:calc(100% + 9px);left:0;transform:translateX(-50%);background:rgba(18,18,22,.97);color:#fff;font:600 10px/1 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.02em;padding:5px 8px;border-radius:7px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .12s ease;box-shadow:0 6px 18px rgba(0,0,0,.5);z-index:30';
      barWrap.appendChild(tip);
      const showTip = (b, text) => { tip.textContent = text; tip.style.left = (b.offsetLeft + b.offsetWidth / 2) + 'px'; tip.style.opacity = '1'; };
      const hideTip = () => { tip.style.opacity = '0'; };
      const I = {
        restart: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 5v14"/><path d="M19 5 9 12l10 7Z"/></svg>',
        info: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.7" r="1.15" fill="currentColor" stroke="none"/></svg>',
        copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
        spark: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="none"><path d="M12 2.4 13.95 9 20.6 11 13.95 13 12 19.6 10.05 13 3.4 11 10.05 9z"/></svg>',
        hub: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        shuffle: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M21 3 13 11"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M3 4l6 6"/></svg>',
        gear: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V15z"/></svg>',
      };
      // minimalist icon-only button; a tiny label floats above it on hover
      const mk = (cls, content, label, title, fn, isHtml) => {
        const b = D.createElement('button');
        b.type = 'button'; b.className = cls; b.title = title; b.setAttribute('aria-label', title);
        b.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;background:none;border:0;color:inherit;opacity:.55;cursor:pointer;font:800 10px/1 inherit;padding:0 ' + (isHtml ? '0' : '5px') + ';min-width:26px;height:26px;border-radius:7px;transition:opacity .14s ease,background .14s ease,color .14s ease';
        if (isHtml) b.innerHTML = content; else b.textContent = content;
        b.addEventListener('mouseenter', () => { b.style.opacity = '1'; b.style.background = 'rgba(255,90,0,.15)'; b.style.color = '#ff6a1f'; showTip(b, b._tip || label); });
        b.addEventListener('mouseleave', () => { b.style.background = 'none'; b.style.color = ''; b.style.opacity = '.55'; hideTip(); refreshBar(); });
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
        return b;
      };
      // ONE consolidated pill: the Suite/lyrics button leads, then shuffle, etc.
      // (the lyrics module suppresses its own standalone button when this exists)
      barWrap.appendChild(mk('sce-hub', I.hub, 'Lyrics hub', 'Open / close the lyrics hub', () => { try { if (SUITE.toggleLyrics) SUITE.toggleLyrics(); else if (SUITE.openLyrics) SUITE.openLyrics(); else openSettings(); } catch (e) {} }, true));
      barWrap.appendChild(mk('sce-shuffle', I.shuffle, 'Shuffle Likes', 'Shuffle your entire Likes library', () => { try { const m = SUITE.shuffleNow ? SUITE.shuffleNow() : 'Open your Likes to shuffle'; if (m) toast(m); } catch (e) {} }, true));
      barWrap.appendChild(mk('sce-restart', I.restart, 'Restart track', 'Restart this track from the beginning', restartTrack, true));
      barWrap.appendChild(mk('sce-speed', (CFG.speed / 100) + '×', 'Playback speed', 'Playback speed — click to cycle 0.5×–2×', cycleSpeed, false));
      barWrap.appendChild(mk('sce-ab', 'A·B', 'A–B loop', 'A–B loop: click for A, again for B (right-click clears)', abMark, false));
      barWrap.appendChild(mk('sce-info', I.info, 'Track info', 'Track info & artist links', showInfo, true));
      barWrap.appendChild(mk('sce-copy', I.copy, 'Copy link', 'Copy this track’s link', copyTrackLink, true));
      barWrap.appendChild(mk('sce-gear', I.gear, 'Settings', 'Open / close all settings (Tweaks)', () => { try { if (SUITE.toggleTweaks) SUITE.toggleTweaks(); else openSettings(); } catch (e) {} }, true));
      const ab = barWrap.querySelector('.sce-ab');
      if (ab) ab.addEventListener('contextmenu', (e) => { e.preventDefault(); abClear(); });
      host.appendChild(barWrap);
      // the pill now owns Suite + Shuffle, so clear out the old standalone
      // shuffle bolt + lyrics button if they slipped in before us
      try { D.querySelectorAll('.bhx-barwrap').forEach((e) => e.remove()); } catch (e) {}
      refreshBar();
    } catch (e) {}
  }

  /* ───────── toast ───────── */
  let toastEl = null, toastT = 0;
  function toast(msg) {
    try {
      if (!toastEl) {
        toastEl = D.createElement('div');
        toastEl.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%) translateY(7px);z-index:2147483400;background:rgba(24,24,28,.92);color:#fff;font:600 12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.01em;padding:9px 16px;border-radius:99px;box-shadow:0 12px 34px -8px rgba(0,0,0,.62),inset 0 0 0 1px rgba(255,255,255,.09);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);opacity:0;transition:opacity .22s ease,transform .28s cubic-bezier(.3,1,.4,1);pointer-events:none';
        (D.body || D.documentElement).appendChild(toastEl);
      }
      toastEl.textContent = msg; toastEl.style.opacity = '1'; toastEl.style.transform = 'translateX(-50%) translateY(0)';
      clearTimeout(toastT); toastT = setTimeout(() => { if (toastEl) { toastEl.style.opacity = '0'; toastEl.style.transform = 'translateX(-50%) translateY(7px)'; } }, 1900);
    } catch (e) {}
  }

  /* ───────── settings panel (own shadow DOM) ───────── */
  let host = null, root = null, panelOpen = false;
  const PANEL_CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.wrap{position:fixed;right:14px;bottom:62px;z-index:2147483300;width:300px;max-height:min(72vh,640px);display:flex;flex-direction:column;
 background:linear-gradient(180deg,rgba(22,22,26,.94),rgba(12,12,14,.97));backdrop-filter:blur(40px) saturate(1.7);-webkit-backdrop-filter:blur(40px) saturate(1.7);
 border-radius:20px;box-shadow:0 28px 70px -18px rgba(0,0,0,.7),inset 0 0 0 1px rgba(255,255,255,.07);color:#f2f2f4;overflow:hidden;
 opacity:0;transform:translateY(10px) scale(.97);transition:opacity .2s,transform .24s cubic-bezier(.3,1,.4,1)}
.wrap.on{opacity:1;transform:none}
.hd{display:flex;align-items:center;gap:9px;padding:13px 14px;font-weight:700;font-size:13px;flex:none;border-bottom:1px solid rgba(255,255,255,.06)}
.hd .x{margin-left:auto;width:24px;height:24px;border:0;background:none;color:#999;cursor:pointer;border-radius:7px;font-size:16px;line-height:1}
.hd .x:hover{background:rgba(255,255,255,.08);color:#fff}
.bd{overflow-y:auto;padding:6px 14px 16px;scrollbar-width:thin}
.bd::-webkit-scrollbar{width:0}
.sec{font-size:9.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:#7a7a82;margin:14px 0 4px}
.row{display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid rgba(255,255,255,.05)}
.row:last-child{border-bottom:0}
.lab{flex:1;min-width:0;font-size:12px;font-weight:500}
.lab small{display:block;font-size:10px;color:#888;font-weight:400;margin-top:1px}
.sw{position:relative;width:34px;height:19px;border-radius:19px;background:rgba(255,255,255,.16);border:0;cursor:pointer;flex:none;transition:background .18s}
.sw.on{background:#f50}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left .18s;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.sw.on::after{left:17px}
.sel{background:rgba(255,255,255,.08);border:0;border-radius:8px;color:#fff;font:inherit;font-size:11.5px;padding:5px 8px;cursor:pointer;max-width:130px}
.rng{flex:none;width:108px}
.val{flex:none;font-size:11px;color:#aaa;width:36px;text-align:right;font-variant-numeric:tabular-nums}
.hint{font-size:9.5px;color:#6a6a72;text-align:center;margin-top:12px;letter-spacing:.04em}
.foot{display:flex;gap:7px;margin-top:12px}
.btn{flex:1;background:rgba(255,255,255,.07);border:0;border-radius:9px;color:#eaeaee;font:600 11px inherit;padding:8px;cursor:pointer;transition:background .15s}
.btn:hover{background:rgba(255,255,255,.13)}
.ta{width:100%;min-height:70px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#eee;font:11px/1.4 ui-monospace,Menlo,monospace;padding:8px;resize:vertical;outline:none}
.ta:focus{border-color:rgba(255,85,0,.55)}
.fnd{width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#fff;font:inherit;font-size:12px;padding:7px 11px;outline:none;margin:8px 0 2px}
.fnd:focus{border-color:rgba(255,85,0,.55)}
.row.hide{display:none}
.sw:focus-visible,.sel:focus-visible,.rng:focus-visible,.btn:focus-visible,.x:focus-visible,.ta:focus-visible{outline:2px solid #f50;outline-offset:2px}
@media (prefers-reduced-motion:reduce){.wrap{transition:none}.sw::after,.sw{transition:none}}
`;
  // feature rows for the panel — declarative so it stays clean & extensible
  const ROWS = [
    ['SEC', 'Appearance'],
    ['theme', 'select', 'Theme', 'Real dark themes + tints', [['none', 'Default (light)'], ['dark', '🌙 Dark'], ['amoled', '⬛ AMOLED black'], ['midnight', '🌌 Midnight blue'], ['dracula', '🧛 Dracula'], ['nord', '❄ Nord'], ['ocean', '🌊 Ocean'], ['gruvbox', '🟫 Gruvbox'], ['rosepine', '🌹 Rosé Pine'], ['solar', '☀ Solarized'], ['coffee', '☕ Coffee'], ['slate', '🪨 Slate'], ['dim', 'Dim (tint)'], ['dimmer', 'Dimmer (tint)'], ['warm', 'Night warm (tint)'], ['cool', 'Cool (tint)'], ['vivid', 'Vivid (tint)'], ['muted', 'Muted (tint)'], ['vintage', 'Vintage (tint)'], ['rose', 'Rosé (tint)'], ['sunset', 'Sunset (tint)'], ['forest', 'Forest (tint)'], ['neon', 'Neon (tint)'], ['noir', 'Noir (tint)'], ['cyber', 'Cyberpunk (tint)'], ['pastel', 'Pastel (tint)'], ['gray', 'Grayscale (tint)'], ['contrast', 'High contrast (tint)'], ['custom', '🎨 Custom…']]],
    ['autoDark', 'toggle', 'Auto dark at night', 'Dark 7pm–7am, light by day — overrides the theme above while on'],
    ['autoDarkTheme', 'select', 'After-dark theme', 'Which dark theme to use at night', [['dark', '🌙 Dark'], ['amoled', '⬛ AMOLED'], ['midnight', '🌌 Midnight'], ['dracula', '🧛 Dracula'], ['nord', '❄ Nord'], ['ocean', '🌊 Ocean'], ['gruvbox', '🟫 Gruvbox'], ['rosepine', '🌹 Rosé Pine'], ['solar', '☀ Solarized'], ['coffee', '☕ Coffee'], ['slate', '🪨 Slate']]],
    ['accent', 'select', 'Accent colour', 'Recolours buttons & links', [['default', 'SoundCloud orange'], ['red', 'Red'], ['pink', 'Pink'], ['purple', 'Purple'], ['blue', 'Blue'], ['cyan', 'Cyan'], ['green', 'Green'], ['gold', 'Gold'], ['custom', '🎨 Custom…']]],
    ['grayArt', 'toggle', 'Grayscale artwork', 'Colour returns on hover'],
    ['squareArt', 'toggle', 'Square artwork', ''],
    ['dimSidebar', 'toggle', 'Dim right sidebar', 'Fades until you hover'],
    ['focusMode', 'toggle', 'Focus mode', 'Hide the right sidebar entirely'],
    ['maxWidth', 'toggle', 'Cap content width', 'Center on wide screens'],
    ['bigPlay', 'toggle', 'Bigger play button', ''],
    ['biggerWave', 'toggle', 'Taller waveform', ''],
    ['thinScroll', 'toggle', 'Slim scrollbars', ''],
    ['fontScale', 'range', 'Text size', '', 85, 120],
    ['SEC', 'Declutter'],
    ['hideUpsell', 'toggle', 'Hide Go+ upsells', 'Upgrade nags & banners'],
    ['hideAppBanner', 'toggle', 'Hide app / cookie banners', ''],
    ['hidePromoted', 'toggle', 'Hide promoted items', 'Sponsored tracks in the stream'],
    ['hideReposts', 'toggle', 'Hide reposts', 'In your stream'],
    ['hidePlaylistsFeed', 'toggle', 'Hide playlists in feed', 'Only tracks in the stream'],
    ['compactFeed', 'toggle', 'Compact feed', 'Tighter stream rows'],
    ['hideComments', 'toggle', 'Hide waveform comments', 'Cleaner player'],
    ['hideCommentSection', 'toggle', 'Hide comments list', 'Under the track'],
    ['hideRelated', 'toggle', 'Hide related tracks', ''],
    ['hidePlayCounts', 'toggle', 'Hide play / like counts', 'Calmer feed'],
    ['hideUpload', 'toggle', 'Hide Upload button', ''],
    ['hideStories', 'toggle', 'Hide stories bar', ''],
    ['SEC', 'Player'],
    ['speed', 'range', 'Playback speed', '%', 50, 200],
    ['speedPerTrack', 'toggle', 'Remember speed per track', 'Restore each track’s last speed'],
    ['loopTrack', 'toggle', 'Loop current track', ''],
    ['rememberVol', 'toggle', 'Remember volume', 'Restore it next time'],
    ['volScroll', 'toggle', 'Scroll = volume', 'Scroll over the player bar'],
    ['keySeek', 'toggle', 'Number-key seeking', '0–9 jump · [ ] = ∓10s'],
    ['hotkeys', 'toggle', 'Global hotkeys', '/ search · M mute · ± volume · B like · C copy · G artist · I info · A compare · N night · , . speed'],
    ['miniPlayer', 'toggle', 'Mini floating player', 'Draggable now-playing widget'],
    ['backTop', 'toggle', 'Back-to-top button', 'Appears when you scroll down'],
    ['pauseOnHide', 'toggle', 'Pause on tab switch', 'Pause when this tab is hidden'],
    ['resumePos', 'select', 'Resume long tracks', 'Mixes and podcasts over 10 minutes remember where you stopped, for a month', [['ask', 'Offer to resume'], ['auto', 'Resume automatically'], ['off', 'Off']]],
    ['SEC', 'Artist / track'],
    ['barInfo', 'toggle', 'Track info button', 'ⓘ — metadata, download, artist links, embed'],
    ['hideFollowFeed', 'toggle', 'Hide “who to follow”', 'Suggested-people boxes'],
    ['SEC', 'Toolbar buttons'],
    ['barSpeed', 'toggle', 'Speed', ''],
    ['barRestart', 'toggle', 'Restart track', ''],
    ['barAB', 'toggle', 'A–B loop', 'Click to set A then B'],
    ['barCopy', 'toggle', 'Copy track link', ''],
    ['SEC', 'Advanced'],
    ['customCss', 'textarea', 'Custom CSS', 'Power users — applied last, wins over everything'],
  ];
  // splice the data-driven feature toggles in (grouped by category) just
  // before the Advanced section, so they share the same settings panel + search
  (() => {
    // group by category (first-seen order) so each section appears once even
    // when features for the same category are added across multiple waves
    const byCat = {}, order = [];
    for (const f of MORE) { if (!byCat[f[1]]) { byCat[f[1]] = []; order.push(f[1]); } byCat[f[1]].push(f); }
    const gen = [];
    for (const cat of order) { gen.push(['SEC', cat]); for (const f of byCat[cat]) gen.push([f[0], 'toggle', f[2], '']); }
    const advIdx = ROWS.findIndex((r) => r[0] === 'SEC' && r[1] === 'Advanced');
    ROWS.splice(advIdx < 0 ? ROWS.length : advIdx, 0, ...gen);
  })();
  function buildPanel() {
    host = D.createElement('div');
    host.id = 'sce-host';
    host.style.cssText = 'position:fixed;inset:0 0 auto auto;width:0;height:0;z-index:2147483300';
    (D.body || D.documentElement).appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    // typing in the panel's fields must not trigger SoundCloud's shortcuts (its Space toggle listens on keyup too)
    for (const ev of ['keydown', 'keypress', 'keyup']) root.addEventListener(ev, (e) => {
      const t = (e.composedPath ? e.composedPath()[0] : null) || e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) e.stopPropagation();
      if (ev === 'keydown' && e.key === 'Escape') { e.stopPropagation(); setPanel(false); try { const g = D.querySelector('.sce-gear'); if (g) g.focus(); } catch (e2) {} }
    });
    const st = D.createElement('style'); st.textContent = PANEL_CSS; root.appendChild(st);
    const wrap = D.createElement('div'); wrap.className = 'wrap';
    const hd = D.createElement('div'); hd.className = 'hd';
    hd.innerHTML = '<span style="color:#f50">✦</span><span>SoundCloud Enhancer</span>';
    const x = D.createElement('button'); x.className = 'x'; x.textContent = '×'; x.type = 'button'; x.setAttribute('aria-label', 'Close settings');
    x.addEventListener('click', () => setPanel(false));
    hd.appendChild(x); wrap.appendChild(hd);
    const bd = D.createElement('div'); bd.className = 'bd';
    // filter box — 60+ settings deserve a search
    const find = D.createElement('input'); find.className = 'fnd'; find.type = 'text'; find.placeholder = 'Search settings…'; find.setAttribute('aria-label', 'Search settings');
    bd.appendChild(find);
    const rowMeta = [];   // {el, sec, text} for filtering
    let curSec = null;
    for (const r of ROWS) {
      if (r[0] === 'SEC') { const s = D.createElement('div'); s.className = 'sec'; s.textContent = r[1]; bd.appendChild(s); curSec = { el: s, kids: [] }; rowMeta.push({ sec: curSec }); continue; }
      const [key, type, label, desc] = r;
      const row = D.createElement('div'); row.className = 'row';
      const lab = D.createElement('div'); lab.className = 'lab';
      lab.innerHTML = '<span></span>' + (desc ? '<small></small>' : '');
      lab.querySelector('span').textContent = label;
      if (desc) lab.querySelector('small').textContent = desc;
      row.appendChild(lab);
      if (type === 'toggle') {
        const sw = D.createElement('button'); sw.className = 'sw' + (CFG[key] ? ' on' : '');
        sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!!CFG[key])); sw.setAttribute('aria-label', label); sw.type = 'button';
        sw.addEventListener('click', () => { CFG[key] = !CFG[key]; sw.classList.toggle('on', CFG[key]); sw.setAttribute('aria-checked', String(!!CFG[key])); save(); applyAll(); });
        row.appendChild(sw);
      } else if (type === 'select') {
        const sel = D.createElement('select'); sel.className = 'sel'; sel.setAttribute('aria-label', label);
        for (const [v, t] of r[4]) { const o = D.createElement('option'); o.value = v; o.textContent = t; if (CFG[key] === v) o.selected = true; sel.appendChild(o); }
        sel.addEventListener('change', () => { CFG[key] = sel.value; if (key === 'theme') CFG.autoDark = false; save(); applyAll(); });
        row.appendChild(sel);
      } else if (type === 'range') {
        const rng = D.createElement('input'); rng.type = 'range'; rng.className = 'rng'; rng.min = r[4]; rng.max = r[5]; rng.step = key === 'speed' ? 5 : 1; rng.value = CFG[key]; rng.setAttribute('aria-label', label);
        const val = D.createElement('span'); val.className = 'val'; val.textContent = CFG[key] + (r[3] || '');
        rng.addEventListener('input', () => { CFG[key] = parseInt(rng.value, 10); val.textContent = CFG[key] + (r[3] || ''); saveSoon(); if (key === 'speed') rememberSpeed(); applyAll(); refreshBar(); });
        row.appendChild(rng); row.appendChild(val);
      } else if (type === 'textarea') {
        row.style.display = 'block';
        const ta = D.createElement('textarea'); ta.className = 'ta'; ta.value = CFG[key] || ''; ta.spellcheck = false; ta.setAttribute('aria-label', label);
        ta.placeholder = '.playControls { background:#111 }';
        ta.addEventListener('keydown', (e) => e.stopPropagation());
        let dT = 0;
        ta.addEventListener('input', () => { clearTimeout(dT); dT = setTimeout(() => { CFG[key] = ta.value; save(); applyCss(); }, 400); });
        row.appendChild(ta);
      }
      bd.appendChild(row);
      const txt = (label + ' ' + (desc || '')).toLowerCase();
      if (curSec) curSec.kids.push(row);
      rowMeta.push({ el: row, text: txt, sec: curSec });
    }
    // live filtering: hide non-matching rows + any section that ends up empty
    find.addEventListener('input', () => {
      const q = find.value.trim().toLowerCase();
      const secHas = new Map();
      for (const m of rowMeta) {
        if (!m.el) continue;                      // section-marker entry
        const ok = !q || m.text.indexOf(q) !== -1;
        m.el.classList.toggle('hide', !ok);
        if (ok && m.sec) secHas.set(m.sec, true);
      }
      const seen = new Set();
      for (const m of rowMeta) {
        const sec = m.sec;
        if (sec && sec.el && !seen.has(sec)) { seen.add(sec); sec.el.classList.toggle('hide', !!q && !secHas.get(sec)); }
      }
    });
    const foot = D.createElement('div'); foot.className = 'foot';
    const mkF = (txt, fn) => { const b = D.createElement('button'); b.className = 'btn'; b.textContent = txt; b.addEventListener('click', fn); foot.appendChild(b); return b; };
    let resetArm = 0, resetB = null;
    resetB = mkF('Reset enhancer', () => {
      if (!resetArm) { resetB.textContent = 'Really reset?'; resetArm = setTimeout(() => { resetArm = 0; resetB.textContent = 'Reset enhancer'; }, 4000); return; }   // one more click confirms
      clearTimeout(resetArm); resetArm = 0;
      CFG = Object.assign({}, DEFAULTS, { eqCustom: clampEqCustom(CFG.eqCustom) }); save(); rebuildPanel(); applyAll(); toast('Enhancer reset');
    });
    mkF('Export', () => {
      try {
        const blob = new Blob([JSON.stringify(CFG, null, 2)], { type: 'application/json' });
        const a = D.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = 'soundcloud-enhancer-settings.json'; (D.body || D.documentElement).appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); toast('Settings exported');
      } catch (e) { toast('Export failed'); }
    });
    mkF('Import', () => {
      try {
        const inp = D.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json'; inp.style.display = 'none';
        inp.addEventListener('change', () => {
          const f = inp.files && inp.files[0]; if (!f) { inp.remove(); return; }
          const rd = new FileReader();
          rd.onload = () => {
            try {
              const d = JSON.parse(rd.result);
              if (d && typeof d === 'object') {
                for (const k of Object.keys(DEFAULTS)) if (k !== 'abLoop' && k in d && typeof d[k] === typeof DEFAULTS[k]) CFG[k] = d[k];   // A–B endpoints are live-only
                migrateFrom(d); CFG.cfgVer = DEFAULTS.cfgVer;
                ensureEqBands(); clampAudioCfg();
                save(); rebuildPanel(); applyAll(); toast('Settings imported');
              }
            } catch (e) { toast('That file isn’t enhancer settings'); }
          };
          rd.readAsText(f); setTimeout(() => inp.remove(), 2000);
        });
        (D.body || D.documentElement).appendChild(inp); inp.click();
      } catch (e) { toast('Import failed'); }
    });
    bd.appendChild(foot);
    bd.appendChild(Object.assign(D.createElement('div'), { className: 'hint', textContent: 'All local · toggles apply instantly · part of SoundCloud Suite' }));
    wrap.appendChild(bd);
    root.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('on'));
  }
  function rebuildPanel() { if (host) { try { host.remove(); } catch (e) {} host = null; root = null; } buildPanel(); }
  function setPanel(v) {
    panelOpen = v;
    try {
      if (v) { if (!host) buildPanel(); else rebuildPanel(); }
      else if (root) { const w = root.querySelector('.wrap'); if (w) { w.classList.remove('on'); setTimeout(() => { if (host && !panelOpen) { host.remove(); host = null; root = null; } }, 240); } }
    } catch (e) {
      // never let a build error permanently brick the panel — reset & retry clean
      try { if (host) host.remove(); } catch (e2) {}
      host = null; root = null;
      try { console.warn('[SC Enhancer] panel error:', e); } catch (e2) {}
    }
  }
  function togglePanel() { try { setPanel(!panelOpen); } catch (e) { panelOpen = false; } }

  /* ───────── embeddable settings renderer ─────────
   * Builds the full enhancer settings UI with FULLY INLINE styles (no CSS
   * classes → can't collide with the lyrics hub's own styles) into any
   * container — used to host all the SoundCloud tweaks inside the lyrics
   * hub's "Tweaks" tab, so everything lives in one place. */
  function enhancerRender(container) {
    try {
      if (!container) return;
      // a rebuild (theme swatch, preset, reset…) keeps what the user had open, typed and scrolled to
      const prevQ = (container.querySelector('input[aria-label="Search settings"]') || {}).value || '';
      const prevOpen = Array.from(container.querySelectorAll('[data-sec][data-open="1"]')).map((h) => h.getAttribute('data-sec'));
      const prevTop = container.scrollTop, hadPrev = !!container.firstChild;
      container.replaceChildren();
      container.style.padding = '8px 14px 26px';
      container.style.webkitMaskImage = 'none'; container.style.maskImage = 'none';   // no edge fade on settings
      const ACC = '#ff5500';
      const find = D.createElement('input');
      find.type = 'text'; find.placeholder = 'Search settings…'; find.setAttribute('aria-label', 'Search settings');
      find.style.cssText = 'width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#fff;font:inherit;font-size:12px;padding:7px 11px;outline:none;margin:6px 0 4px';
      find.addEventListener('keydown', (e) => e.stopPropagation());
      container.appendChild(find);
      const meta = [];
      const sections = [];
      let curSec = null, curGrp = null;
      const setSecOpen = (sec, open) => { sec.open = open; sec.el.setAttribute('data-open', open ? '1' : '0'); sec.grp.style.display = open ? '' : 'none'; sec.chev.style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)'; sec.dot.style.background = open ? ACC : 'rgba(255,255,255,.22)'; sec.el.style.background = open ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.04)'; };
      // each category is a collapsible accordion group, so the whole panel reads
      // as a short tidy list of headers instead of one endless scroll
      const addSection = (title) => {
        const head = D.createElement('button'); head.type = 'button'; head.setAttribute('data-sec', title);
        head.style.cssText = 'width:100%;display:flex;align-items:center;gap:9px;margin:7px 0 2px;padding:10px 11px;background:rgba(255,255,255,.04);border:0;border-radius:11px;cursor:pointer;font:800 10px/1 inherit;letter-spacing:.13em;text-transform:uppercase;color:#c2c2ca;transition:background .14s ease';
        const dot = D.createElement('span'); dot.style.cssText = 'width:10px;height:2px;border-radius:2px;flex:none;background:rgba(255,255,255,.22);transition:background .16s ease';
        const tt = D.createElement('span'); tt.textContent = title; tt.style.cssText = 'flex:1;text-align:left';
        const chev = D.createElement('span'); chev.textContent = '▸'; chev.style.cssText = 'color:#8a8a92;font-size:10px;transition:transform .18s ease;flex:none';
        head.append(dot, tt, chev);
        head.addEventListener('mouseenter', () => { head.style.background = 'rgba(255,255,255,.08)'; });
        head.addEventListener('mouseleave', () => { head.style.background = sec.open ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.04)'; });
        const grp = D.createElement('div');
        grp.style.cssText = 'margin:3px 1px 8px;padding:2px 12px;background:rgba(255,255,255,0.035);border-radius:13px;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.05)';
        container.append(head, grp);
        const sec = { el: head, grp, chev, dot, open: false };
        sections.push(sec);
        head.addEventListener('click', () => setSecOpen(sec, !sec.open));
        curSec = sec; curGrp = grp;
        return sec;
      };
      // fold the SHUFFLE settings in as the first collapsible group (all-in-one)
      if (SUITE.shuffleRender) {
        addSection('Shuffle');
        try { SUITE.shuffleRender(curGrp); } catch (e) {}
        meta.push({ el: curGrp, text: 'shuffle queue likes order genres blocklist sleep stats library listenbrainz spread fresh picks', sec: curSec });
      }
      for (const r of ROWS) {
        if (r[0] === 'SEC') { addSection(r[1]); continue; }
        const [key, type, label, desc] = r;
        const row = D.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:11px 2px;border-bottom:1px solid rgba(255,255,255,.05)';
        const lab = D.createElement('div'); lab.style.cssText = 'flex:1;min-width:0;font-size:12px;font-weight:500';
        const ls = D.createElement('span'); ls.textContent = label; lab.appendChild(ls);
        if (desc) { const sm = D.createElement('small'); sm.textContent = desc; sm.style.cssText = 'display:block;font-size:10px;color:#888;font-weight:400;margin-top:1px'; lab.appendChild(sm); }
        row.appendChild(lab);
        if (type === 'toggle') {
          const sw = D.createElement('button'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', label);
          sw.style.cssText = 'position:relative;width:34px;height:19px;border-radius:19px;border:0;cursor:pointer;flex:none;transition:background .18s';
          const knob = D.createElement('span'); knob.style.cssText = 'position:absolute;top:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:left .18s;box-shadow:0 1px 3px rgba(0,0,0,.4)';
          sw.appendChild(knob);
          const paint = () => { const on = !!CFG[key]; sw.style.background = on ? '#ff5500' : 'rgba(255,255,255,.18)'; knob.style.left = on ? '17px' : '2px'; sw.setAttribute('aria-checked', String(on)); };
          paint();
          sw.addEventListener('click', () => { CFG[key] = !CFG[key]; paint(); save(); applyAll(); });
          row.appendChild(sw);
        } else if (type === 'select') {
          const sel = D.createElement('select'); sel.setAttribute('aria-label', label);
          sel.style.cssText = 'background:rgba(255,255,255,.08);border:0;border-radius:8px;color:#fff;font:inherit;font-size:11.5px;padding:5px 8px;cursor:pointer;max-width:150px';
          for (const [v, t] of r[4]) { const o = D.createElement('option'); o.value = v; o.textContent = t; o.style.color = '#111'; if (CFG[key] === v) o.selected = true; sel.appendChild(o); }
          sel.addEventListener('change', () => { CFG[key] = sel.value; if (key === 'theme') CFG.autoDark = false; save(); applyAll(); if (key === 'accent' || key === 'theme') enhancerRender(container); });   // theme → custom palette editor / swatches follow
          row.appendChild(sel);
        } else if (type === 'range') {
          const rng = D.createElement('input'); rng.type = 'range'; rng.min = r[4]; rng.max = r[5]; rng.step = key === 'speed' ? 5 : 1; rng.value = CFG[key]; rng.setAttribute('aria-label', label);
          rng.style.cssText = 'flex:none;width:108px;accent-color:' + ACC;
          const val = D.createElement('span'); val.textContent = CFG[key] + (r[3] || ''); val.style.cssText = 'flex:none;font-size:11px;color:#aaa;width:38px;text-align:right';
          rng.addEventListener('input', () => { CFG[key] = parseInt(rng.value, 10); val.textContent = CFG[key] + (r[3] || ''); saveSoon(); if (key === 'speed') rememberSpeed(); applyAll(); refreshBar(); });
          row.appendChild(rng); row.appendChild(val);
        } else if (type === 'textarea') {
          row.style.display = 'block';
          const ta = D.createElement('textarea'); ta.value = CFG[key] || ''; ta.spellcheck = false; ta.setAttribute('aria-label', label);
          ta.placeholder = '.playControls { background:#111 }';
          ta.style.cssText = 'width:100%;min-height:70px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#eee;font:11px/1.4 ui-monospace,Menlo,monospace;padding:8px;resize:vertical;outline:none;margin-top:6px';
          ta.addEventListener('keydown', (e) => e.stopPropagation());
          let dT = 0;
          ta.addEventListener('input', () => { clearTimeout(dT); dT = setTimeout(() => { CFG[key] = ta.value; save(); applyCss(); }, 400); });
          row.appendChild(ta);
        }
        (curGrp || container).appendChild(row);
        meta.push({ el: row, text: (label + ' ' + (desc || '')).toLowerCase(), sec: curSec });
        // ── visual swatch picker + custom theme builder, right under the Theme dropdown ──
        if (key === 'theme') {
          const wrap = D.createElement('div');
          wrap.style.cssText = 'padding:4px 0 8px;border-bottom:1px solid rgba(255,255,255,.05)';
          const grid = D.createElement('div');
          grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:7px;padding:2px 0';
          // [id, label, bg, accent-dot]
          const SW = [['none', 'Light', '#f3f3f5', '#ff5500']];
          const TNAME = { dark: 'Dark', amoled: 'AMOLED black', midnight: 'Midnight', dracula: 'Dracula', nord: 'Nord', ocean: 'Ocean', gruvbox: 'Gruvbox', rosepine: 'Rosé Pine', solar: 'Solarized', coffee: 'Coffee', slate: 'Slate' };
          for (const id of Object.keys(DARK_THEMES)) { const t = DARK_THEMES[id]; SW.push([id, TNAME[id] || id, t.bg, t.tx]); }
          SW.push(['custom', 'Custom', (CFG.customTheme && CFG.customTheme.bg) || '#16181c', (CFG.customTheme && CFG.customTheme.tx) || '#e7e7ec']);
          const paintSel = () => { for (const c of grid.children) c.style.borderColor = (c.getAttribute('data-t') === CFG.theme) ? ACC : 'rgba(255,255,255,.14)'; };
          for (const [id, tname, bg, dot] of SW) {
            const sw = D.createElement('button'); sw.type = 'button'; sw.title = tname; sw.setAttribute('data-t', id); sw.setAttribute('aria-label', 'Theme: ' + tname);
            sw.style.cssText = 'width:30px;height:30px;border-radius:8px;border:2px solid rgba(255,255,255,.14);background:' + bg + ';cursor:pointer;position:relative;flex:none;padding:0';
            const d2 = D.createElement('span'); d2.style.cssText = 'position:absolute;bottom:3px;right:3px;width:8px;height:8px;border-radius:50%;background:' + dot + ';box-shadow:0 0 0 1px rgba(0,0,0,.25)';
            sw.appendChild(d2);
            sw.addEventListener('click', () => { CFG.theme = id; CFG.autoDark = false; save(); applyAll(); enhancerRender(container); });
            grid.appendChild(sw);
          }
          wrap.appendChild(grid);
          paintSel();
          // custom palette editor — only when Custom is the active theme
          if (CFG.theme === 'custom') {
            if (!CFG.customTheme || typeof CFG.customTheme !== 'object') CFG.customTheme = Object.assign({}, DEFAULTS.customTheme);
            const ed = D.createElement('div');
            ed.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin-top:9px;padding:9px;background:rgba(255,255,255,.04);border-radius:10px';
            const FIELDS = [['bg', 'Background'], ['card', 'Surface'], ['hov', 'Hover'], ['tx', 'Text'], ['sub', 'Subtext'], ['bd', 'Border']];
            for (const [ck, clabel] of FIELDS) {
              const cell = D.createElement('label'); cell.style.cssText = 'display:flex;align-items:center;gap:7px;font-size:11px;color:#cfcfd6;cursor:pointer';
              const ci = D.createElement('input'); ci.type = 'color'; ci.value = (CFG.customTheme[ck] || DEFAULTS.customTheme[ck]);
              ci.style.cssText = 'width:24px;height:22px;border:0;border-radius:6px;background:none;cursor:pointer;flex:none;padding:0';
              ci.setAttribute('aria-label', clabel + ' colour');
              let cT = 0;
              ci.addEventListener('input', () => { if (CFG.customTheme === DEFAULTS.customTheme) CFG.customTheme = Object.assign({}, CFG.customTheme); CFG.customTheme[ck] = ci.value; clearTimeout(cT); cT = setTimeout(() => { save(); applyAll(); }, 120); });   // never edit DEFAULTS' own object
              cell.appendChild(ci); cell.appendChild(D.createTextNode(clabel));
              ed.appendChild(cell);
            }
            wrap.appendChild(ed);
            const presetRow = D.createElement('div'); presetRow.style.cssText = 'display:flex;gap:6px;margin-top:8px';
            const mkP = (txt, src) => { const b = D.createElement('button'); b.type = 'button'; b.textContent = txt; b.style.cssText = 'flex:1;background:rgba(255,255,255,.06);border:0;border-radius:8px;color:#dcdce2;font:600 10.5px inherit;padding:6px;cursor:pointer'; b.addEventListener('click', () => { CFG.customTheme = Object.assign({}, src); save(); applyAll(); enhancerRender(container); }); presetRow.appendChild(b); };
            mkP('Start from Dark', DARK_THEMES.dark);
            mkP('Start from Nord', DARK_THEMES.nord);
            mkP('Start from Dracula', DARK_THEMES.dracula);
            wrap.appendChild(presetRow);
          }
          (curGrp || container).appendChild(wrap);
          meta.push({ el: wrap, text: 'theme appearance colour color swatch custom palette dark', sec: curSec });
        }
        // ── sleep-timer chips, tucked under the Player section ──
        if (key === 'pauseOnHide') {
          const wrap = D.createElement('div');
          wrap.style.cssText = 'padding:9px 2px 11px;border-bottom:1px solid rgba(255,255,255,.05)';
          const lab = D.createElement('div'); lab.style.cssText = 'flex:1;min-width:0;font-size:12px;font-weight:500;margin-bottom:8px';
          const ls = D.createElement('span'); ls.textContent = '💤 Sleep timer'; lab.appendChild(ls);
          const sm = D.createElement('small'); sm.style.cssText = 'display:block;font-size:10px;color:#888;font-weight:400;margin-top:1px';
          lab.appendChild(sm); wrap.appendChild(lab);
          const chipRow = D.createElement('div'); chipRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
          const chips = [];
          const mkChip = (min, txt) => {
            const b = D.createElement('button'); b.type = 'button'; b.dataset.min = String(min); b.textContent = txt;
            b.style.cssText = 'flex:1 0 auto;min-width:40px;white-space:nowrap;background:rgba(255,255,255,.07);border:0;border-radius:8px;color:#dcdce2;font:700 11px inherit;padding:7px 4px;cursor:pointer;transition:background .14s,color .14s';
            b.addEventListener('click', () => sleepChip(min));
            chipRow.appendChild(b); chips.push(b);
          };
          mkChip(15, '15m'); mkChip(30, '30m'); mkChip(45, '45m'); mkChip(60, '1h'); mkChip(90, '1.5h'); mkChip(-1, 'Track end'); mkChip(0, 'Off');
          wrap.appendChild(chipRow);
          sleepEls = { wrap, chips, label: sm };
          paintSleep(true);
          (curGrp || container).appendChild(wrap);
          meta.push({ el: wrap, text: 'sleep timer pause auto stop bedtime night playback', sec: curSec });
        }
        // ── custom accent colour picker, shown when "Custom…" is selected ──
        if (key === 'accent' && CFG.accent === 'custom') {
          const wrap2 = D.createElement('div');
          wrap2.style.cssText = 'display:flex;align-items:center;gap:9px;padding:8px 2px;border-bottom:1px solid rgba(255,255,255,.05)';
          const cl = D.createElement('label'); cl.style.cssText = 'flex:1;font-size:11.5px;color:#cfcfd6'; cl.textContent = 'Custom accent colour';
          const ci = D.createElement('input'); ci.type = 'color'; ci.value = /^#[0-9a-f]{6}$/i.test(CFG.customAccent || '') ? CFG.customAccent : '#ff5500';
          ci.style.cssText = 'width:30px;height:24px;border:0;border-radius:7px;background:none;cursor:pointer;flex:none;padding:0'; ci.setAttribute('aria-label', 'Custom accent colour');
          let aT = 0;
          ci.addEventListener('input', () => { CFG.customAccent = ci.value; clearTimeout(aT); aT = setTimeout(() => { save(); applyAll(); }, 120); });
          cl.setAttribute('for', ''); wrap2.append(cl, ci);
          (curGrp || container).appendChild(wrap2);
          meta.push({ el: wrap2, text: 'accent custom colour color hex picker', sec: curSec });
        }
        // ── audio-engine status, right under the speed slider ──
        if (key === 'speed') {
          const box = D.createElement('div');
          box.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 9px;margin:2px 0 4px;border-radius:9px;background:rgba(255,255,255,.04);font-size:11px';
          const dot = D.createElement('span'); dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:none';
          const txt = D.createElement('span'); txt.style.cssText = 'flex:1;color:#bdbdc6';
          const btn = D.createElement('button'); btn.type = 'button'; btn.textContent = 'Re-check'; btn.style.cssText = 'background:rgba(255,255,255,.08);border:0;border-radius:7px;color:#dcdce2;font:600 10px inherit;padding:5px 9px;cursor:pointer;flex:none';
          const paint = () => { const s = audioStatus(); const ok = s.ok || s.cap > 0; const n = s.cap || s.dom; dot.style.background = ok ? '#23c552' : '#ffb400'; txt.textContent = ok ? ('Audio engine connected · driving ' + n + ' source' + (n === 1 ? '' : 's')) : 'Not captured yet — play a track, then Re-check'; };
          paint(); btn.addEventListener('click', paint);
          box.append(dot, txt, btn);
          (curGrp || container).appendChild(box);
          meta.push({ el: box, text: 'audio engine status speed capture web audio diagnostics controllable', sec: curSec });
        }
        // ── discoverable shortcuts entry, next to the hotkeys toggle ──
        if (key === 'hotkeys') {
          const row2 = D.createElement('div');
          row2.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid rgba(255,255,255,.05)';
          const lab2 = D.createElement('div'); lab2.style.cssText = 'flex:1;min-width:0;font-size:12px;font-weight:500';
          const ls2 = D.createElement('span'); ls2.textContent = 'Keyboard shortcuts'; lab2.appendChild(ls2);
          const sub = D.createElement('small'); sub.style.cssText = 'display:block;font-size:10px;color:#888;font-weight:400;margin-top:1px'; sub.textContent = 'See every global key'; lab2.appendChild(sub);
          const vb = D.createElement('button'); vb.type = 'button'; vb.textContent = 'View ⌨'; vb.style.cssText = 'background:rgba(255,255,255,.08);border:0;border-radius:8px;color:#eaeaee;font:600 10.5px inherit;padding:6px 11px;cursor:pointer;flex:none';
          vb.addEventListener('click', () => { try { showShortcuts(); } catch (e) {} });
          row2.append(lab2, vb);
          (curGrp || container).appendChild(row2);
          meta.push({ el: row2, text: 'keyboard shortcuts hotkeys cheat sheet keys help question mark', sec: curSec });
        }
      }
      if (hadPrev) {
        for (const sec of sections) setSecOpen(sec, prevOpen.indexOf(sec.el.getAttribute('data-sec')) !== -1);
      } else if (sections.length) setSecOpen(sections[0], true);   // first group open as a hint they expand
      // footer actions
      const foot = D.createElement('div'); foot.style.cssText = 'display:flex;gap:7px;margin-top:14px';
      const mkF = (txt, fn) => { const b = D.createElement('button'); b.textContent = txt; b.style.cssText = 'flex:1;background:rgba(255,255,255,.07);border:0;border-radius:9px;color:#eaeaee;font:600 11px inherit;padding:8px;cursor:pointer'; b.addEventListener('click', fn); foot.appendChild(b); return b; };
      let resetArm = 0, resetB = null;
      resetB = mkF('Reset enhancer', () => {
        if (!resetArm) { resetB.textContent = 'Really reset?'; resetArm = setTimeout(() => { resetArm = 0; resetB.textContent = 'Reset enhancer'; }, 4000); return; }   // one more click confirms
        clearTimeout(resetArm); resetArm = 0;
        CFG = Object.assign({}, DEFAULTS, { eqCustom: clampEqCustom(CFG.eqCustom) }); save(); applyAll(); enhancerRender(container); toast('Enhancer reset');
      });
      // whole-suite backup (shuffle + lyrics + enhancer in one file)
      mkF('Back up everything', () => { if (SUITE.backupAll) SUITE.backupAll(); else toast('Backup unavailable'); });
      mkF('Restore', () => {
        try {
          const inp = D.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json'; inp.style.display = 'none';
          inp.addEventListener('change', () => {
            const f = inp.files && inp.files[0]; if (!f) { inp.remove(); return; }
            if (SUITE.restoreAll) { SUITE.restoreAll(f); setTimeout(() => { try { enhancerRender(container); } catch (e) {} }, 400); }
            else toast('Restore unavailable');
            setTimeout(() => inp.remove(), 2000);
          });
          (D.body || D.documentElement).appendChild(inp); inp.click();
        } catch (e) { toast('Restore failed'); }
      });
      container.appendChild(foot);
      if (hadPrev && prevTop) { try { container.scrollTop = prevTop; } catch (e) {} }
      // copyable debug snapshot (audio status + flags + recent errors) for support
      const dbg = D.createElement('button'); dbg.type = 'button'; dbg.textContent = 'Copy debug log';
      dbg.style.cssText = 'display:block;margin:9px auto 0;background:none;border:0;color:#7a7a82;font:600 10.5px inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px';
      dbg.addEventListener('click', () => { try { clip(debugDump(), 'Debug log copied'); } catch (e) {} });
      container.appendChild(dbg);
      // live search filter — also auto-expands the groups that have matches and
      // collapses everything back when the query clears
      find.addEventListener('input', () => {
        const q = find.value.trim().toLowerCase();
        const secHas = new Map();
        for (const m of meta) { if (!m.el) continue; const ok = !q || (m.text || '').indexOf(q) !== -1; m.el.style.display = ok ? '' : 'none'; if (ok && m.sec) secHas.set(m.sec, true); }
        for (const sec of sections) {
          const has = !!secHas.get(sec);
          sec.el.style.display = (q && !has) ? 'none' : '';
          if (q) setSecOpen(sec, has);
        }
        if (!q) sections.forEach((s, i) => setSecOpen(s, i === 0));
      });
      if (hadPrev && prevQ) { find.value = prevQ; find.dispatchEvent(new Event('input')); }   // the filter the user had typed
    } catch (e) { try { console.warn('[SC Enhancer] render error:', e); } catch (e2) {} }
  }
  try { SUITE.enhancerRender = enhancerRender; } catch (e) {}
  // whole-suite backup: the shuffle module's Export/Import bundles these in
  try { SUITE.enhancerDump = () => { try { return Object.assign({}, CFG); } catch (e) { return null; } }; } catch (e) {}
  try {
    SUITE.enhancerRestore = (obj) => {
      try {
        if (!obj || typeof obj !== 'object') return;
        for (const k of Object.keys(DEFAULTS)) if (k !== 'abLoop' && k in obj && typeof obj[k] === typeof DEFAULTS[k]) CFG[k] = obj[k];   // A–B endpoints are live-only
        migrateFrom(obj); CFG.cfgVer = DEFAULTS.cfgVer;
        ensureEqBands(); clampAudioCfg();
        save(); applyAll();
      } catch (e) {}
    };
  } catch (e) {}
  // ✦ opens the all-in-one hub (lyrics panel → Tweaks tab) when the lyrics
  // module is present; otherwise falls back to the standalone panel.
  function openSettings() { try { if (SUITE.openLyricsTweaks) SUITE.openLyricsTweaks(); else togglePanel(); } catch (e) { togglePanel(); } }
  try { SUITE.openEnhancer = openSettings; } catch (e) {}
  // set the SoundCloud page theme over the bus (used by the ⌘K command palette);
  // a manual pick wins over auto-dark so the choice actually sticks
  try { SUITE.setTheme = (id) => { try { if (typeof id !== 'string') return; CFG.theme = id; CFG.autoDark = false; save(); applyAll(); } catch (e) {} }; } catch (e) {}

  function applyAll() { applyCss(); applyFx(); enforce(); refreshBar(); ensureMini(); ensureTop(); }

  /* ───────── lightweight error log + a copyable debug snapshot ─────────
   * The suite swallows its own errors defensively, so when something misbehaves
   * there's usually no trace. A small global handler + a one-tap "Copy debug log"
   * gives the user something concrete to paste — vital since this can't be
   * reproduced or runtime-tested locally. */
  const errLog = [];
  function logErr(kind, msg) {
    try {
      const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + kind + ': ' + String(msg).slice(0, 240);
      if (errLog[errLog.length - 1] !== line) { errLog.push(line); if (errLog.length > 50) errLog.shift(); }
    } catch (e) {}
  }
  try { SUITE.logErr = logErr; } catch (e) {}
  function audioStatus() {
    let dom = 0; try { dom = D.querySelectorAll('audio,video').length; } catch (e) {}
    return { dom, cap: sceMediaEls.size, buf: sceBufNodes.size, ok: !!activeMedia() };
  }
  function debugDump() {
    const s = audioStatus(); const L = [];
    L.push('SoundCloud Suite — debug snapshot'); L.push('version: ' + VER);
    try { L.push('url: ' + location.href); } catch (e) {}
    try { L.push('ua: ' + navigator.userAgent); } catch (e) {}
    L.push('audio: domMedia=' + s.dom + ' captured=' + s.cap + ' bufNodes=' + s.buf + ' control=' + (s.ok || s.cap > 0 ? 'available' : 'UNAVAILABLE'));
    try { L.push('theme=' + effTheme() + ' accent=' + CFG.accent + (CFG.accent === 'custom' ? ('(' + CFG.customAccent + ')') : '') + ' speed=' + CFG.speed + '% loop=' + !!CFG.loopTrack + ' abLoop=' + abOn); } catch (e) {}
    try { L.push('flags: hotkeys=' + !!CFG.hotkeys + ' keySeek=' + !!CFG.keySeek + ' speedPerTrack=' + !!CFG.speedPerTrack + ' rememberVol=' + !!CFG.rememberVol + ' mini=' + !!CFG.miniPlayer); } catch (e) {}
    try { L.push('clientId=' + ((SUITE.clientId && SUITE.clientId()) ? 'yes' : 'no')); } catch (e) {}
    L.push('errors (' + errLog.length + '):');
    if (errLog.length) for (const ln of errLog) L.push('  ' + ln); else L.push('  (none captured)');
    try { L.push('suite log:'); L.push(Log.dump()); } catch (e) {}   // the caught-failure ring the modules write to
    return L.join('\n');
  }

  /* ───────── boot ───────── */
  /* ───────── first-run setup: recommended vs manual ───────── */
  function applyRecommended() {
    try {
      if (DARK_THEMES && DARK_THEMES.dark) { CFG.theme = 'dark'; CFG.autoDark = false; }
      // Enhance is the sound: its own sub / warmth / presence / air shape replaces the old "smile"
      // EQ (the two together doubled the highs), leveling keeps tracks even, a touch of width
      CFG.eqOn = false; CFG.eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      CFG.loudnessOn = true;
      CFG.enhanceOn = true; CFG.enhanceAmt = 60;
      CFG.stereoWidth = 110;   // on the slider's 5-step grid, so the tab shows what plays
      CFG.hideUpsell = true;
      save();
      try { applyAll(); } catch (e) {}
      toast('✨ Recommended setup applied');
    } catch (e) {}
  }
  let onbEl = null, onbEsc = null;
  function closeOnboarding() {
    if (onbEsc) { try { D.removeEventListener('keydown', onbEsc, true); } catch (e) {} onbEsc = null; }
    if (onbEl) { try { onbEl.remove(); } catch (e) {} onbEl = null; }
  }
  function showOnboarding() {
    if (onbEl) return;
    onbEl = D.createElement('div');
    onbEl.style.cssText = 'position:fixed;inset:0;z-index:2147483361;display:flex;align-items:center;justify-content:center;background:radial-gradient(120% 70% at 50% 0%, rgba(255,90,0,.16), rgba(6,6,9,.72) 60%);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);opacity:0;transition:opacity .22s ease';
    const card = D.createElement('div');
    card.style.cssText = 'width:min(440px,92vw);background:linear-gradient(180deg,rgba(24,24,28,.985),rgba(13,13,16,.99));color:#f2f2f4;border-radius:22px;box-shadow:0 34px 90px -22px rgba(0,0,0,.85),inset 0 0 0 1px rgba(255,255,255,.08);padding:26px 24px 20px;font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;transform:translateY(10px) scale(.985);transition:transform .24s cubic-bezier(.3,1,.4,1);text-align:center';
    card.addEventListener('click', (e) => e.stopPropagation());
    card.innerHTML = '<div style="width:54px;height:54px;margin:0 auto 14px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:27px;background:linear-gradient(135deg,#ff8a3d,#f50);box-shadow:0 12px 30px -8px rgba(255,90,0,.7)">✨</div>'
      + '<div style="font-size:19px;font-weight:800;letter-spacing:-.4px">Welcome to SoundCloud Suite</div>'
      + '<div style="font-size:12.5px;color:#a8a8b0;margin:8px auto 20px;max-width:330px;line-height:1.5">Want me to set up the recommended look &amp; sound — a clean dark theme, the audio enhancer, loudness leveling and a touch of stereo width? Or set it all up yourself.</div>';
    const rec = D.createElement('button'); rec.type = 'button'; rec.textContent = '✨  Use recommended';
    rec.style.cssText = 'display:block;width:100%;border:0;border-radius:13px;padding:13px;font:800 13px inherit;cursor:pointer;background:linear-gradient(135deg,#f50,#ff8a3d);color:#fff;box-shadow:0 10px 26px -8px rgba(255,90,0,.6);transition:filter .14s';
    rec.addEventListener('mouseenter', () => { rec.style.filter = 'brightness(1.08)'; });
    rec.addEventListener('mouseleave', () => { rec.style.filter = ''; });
    rec.addEventListener('click', () => { try { applyRecommended(); } catch (e) {} SET('sce:onboarded', 1); closeOnboarding(); });
    const man = D.createElement('button'); man.type = 'button'; man.textContent = 'I’ll set it up myself';
    man.style.cssText = 'display:block;width:100%;border:0;border-radius:13px;padding:12px;margin-top:9px;font:700 12px inherit;cursor:pointer;background:rgba(255,255,255,.08);color:#cfcfd6';
    man.addEventListener('click', () => { SET('sce:onboarded', 1); toast('You can tune everything in the Audio & Tweaks tabs'); closeOnboarding(); });
    const hint = D.createElement('div'); hint.textContent = 'Open the suite anytime from the ♪ button in the player bar'; hint.style.cssText = 'font-size:10px;color:#6a6a72;margin-top:14px';
    card.append(rec, man, hint);
    onbEl.appendChild(card);
    onbEl.addEventListener('click', () => { SET('sce:onboarded', 1); closeOnboarding(); });   // dismiss = treat as handled
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', 'Welcome to SoundCloud Suite');
    onbEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); SET('sce:onboarded', 1); closeOnboarding(); } };
    D.addEventListener('keydown', onbEsc, true);
    (D.body || D.documentElement).appendChild(onbEl);
    try { rec.focus({ preventScroll: true }); } catch (e) {}
    try { requestAnimationFrame(() => { if (onbEl) { onbEl.style.opacity = '1'; card.style.transform = 'none'; } }); } catch (e) { onbEl.style.opacity = '1'; }
  }
  try { SUITE.showOnboarding = showOnboarding; } catch (e) {}
  function boot() {
    try {
      applyCss();
      setupBehaviour();
      ensureBar();
      ensureTop();
      // first run → offer the recommended-vs-manual setup once (after the page settles)
      try { if (!GET('sce:onboarded', 0)) setTimeout(() => { try { if (!GET('sce:onboarded', 0)) showOnboarding(); } catch (e) {} }, 3500); } catch (e) {}
      setInterval(ensureBar, 3000);   // survive SoundCloud SPA re-renders
      setInterval(() => { try { if (CFG.autoDark) applyCss(); } catch (e) {} }, 60000);   // auto-dark flips at the day/night line
      // capture uncaught errors for the copyable debug snapshot (best-effort)
      try {
        W.addEventListener('error', (e) => { try { logErr('error', (e.message || 'error') + ' @' + ((e.filename || '').split('/').pop() || '') + ':' + (e.lineno || '')); } catch (e2) {} });
        W.addEventListener('unhandledrejection', (e) => { try { logErr('promise', (e.reason && (e.reason.message || e.reason)) || 'rejection'); } catch (e2) {} });
      } catch (e) {}
      // expose a tiny bus hook so the lyrics menu / bar button open the hub
      try { SUITE.openEnhancer = openSettings; } catch (e) {}
      try {
        GM_registerMenuCommand('SoundCloud Suite settings', () => setPanel(true));
      } catch (e) {}
    } catch (e) { try { console.warn('[SC Enhancer] failed to start:', e); } catch (e2) {} }
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
})();
