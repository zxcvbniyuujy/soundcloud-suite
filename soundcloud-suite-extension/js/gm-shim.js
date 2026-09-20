/* SoundCloud Suite — GM_* shim (extension build)
 *
 * Loads in the page's MAIN world BEFORE js/suite.js (order is guaranteed by
 * the manifest's js array). Two constraints shape this file:
 *
 *  · The suite reads settings synchronously at boot (GM_getValue inline),
 *    so storage is localStorage-backed JSON — chrome.storage is async and
 *    is also unavailable in the main world anyway.
 *  · Cross-origin lyric fetches need extension privileges, so
 *    GM_xmlhttpRequest relays: page → bridge.js (isolated world, via
 *    postMessage) → background service worker (fetch with host_permissions).
 */
(() => {
  'use strict';
  if (window.__SCSS_SHIM__) return;
  window.__SCSS_SHIM__ = true;

  const PFX = 'scssgm:';

  // the suite asks for unsafeWindow; in the main world we ARE the page
  window.unsafeWindow = window;

  // GM_info: the suite reads GM_info.script.version as its single source of truth
  // for the displayed version. build.sh keeps this in lockstep with the manifest.
  window.GM_info = { script: { name: 'SoundCloud Suite', version: '4.54.0' } };

  window.GM_getValue = function (key, fallback) {
    try {
      const raw = localStorage.getItem(PFX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  };
  window.GM_setValue = function (key, value) {
    const k = PFX + key;
    let v;
    try { v = JSON.stringify(value); } catch (e) { return false; }
    try { localStorage.setItem(k, v); return true; } catch (e) {}
    // quota pressure (we share soundcloud.com's localStorage): cached page
    // bodies are the fattest entries and always re-fetchable — shed them
    // and retry, so the lyric cache itself keeps working
    try {
      const dead = [];
      for (let i = 0; i < localStorage.length && dead.length < 60; i++) {
        const kk = localStorage.key(i);
        if (kk && kk.indexOf(PFX + 'pb:') === 0) dead.push(kk);
      }
      dead.forEach((kk) => localStorage.removeItem(kk));
      localStorage.setItem(k, v);
      return true;
    } catch (e) { return false; }   // the caller may re-read to confirm; nothing else it can do
  };
  window.GM_deleteValue = function (key) {
    try { localStorage.removeItem(PFX + key); } catch (e) {}
  };
  window.GM_listValues = function () {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PFX) === 0) out.push(k.slice(PFX.length));
      }
    } catch (e) {}
    return out;
  };

  // Tampermonkey menu has no equivalent here; the suite's own UI covers it
  window.GM_registerMenuCommand = function () {};

  window.GM_setClipboard = function (text) {
    let done = false;
    try {
      const ta = document.createElement('textarea');
      ta.value = String(text);
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-200px;left:-200px;opacity:0';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      done = document.execCommand('copy');
      ta.remove();
    } catch (e) {}
    if (!done) { try { navigator.clipboard.writeText(String(text)).catch(() => {}); } catch (e) {} }
    // Tampermonkey returns undefined; we return false when the synchronous copy
    // failed so callers can fall back to (and report on) the async path
    return done;
  };

  let seq = 0;
  const pending = new Map();
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.scss !== 'xhr-res') return;
    const cb = pending.get(d.id);
    if (!cb) return;
    pending.delete(d.id);
    cb(d);
  });

  window.GM_xmlhttpRequest = function (opts) {
    opts = opts || {};
    const id = ++seq;
    const timeout = Math.max(1000, (opts.timeout | 0) || 30000);
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      pending.delete(id);
      try { if (fn) fn(arg); } catch (e) {}
    };
    // if the bridge or background never answers, fail instead of leaking
    const guard = setTimeout(() => settle(opts.ontimeout || opts.onerror), timeout + 10000);
    pending.set(id, (res) => {
      clearTimeout(guard);
      if (res.ok) {
        settle(opts.onload, {
          status: res.status,
          statusText: res.statusText || '',
          responseText: res.text || '',
          response: res.text || '',
          finalUrl: res.url || opts.url,
        });
      } else if (res.timedOut) {
        settle(opts.ontimeout || opts.onerror);
      } else {
        settle(opts.onerror, new Error(res.error || 'network error'));
      }
    });
    try {
      window.postMessage({
        scss: 'xhr-req',
        id,
        req: {
          method: opts.method || 'GET',
          url: String(opts.url || ''),
          headers: opts.headers || {},
          data: opts.data != null ? String(opts.data) : null,
          timeout,
          anonymous: !!opts.anonymous,
        },
      }, location.origin);
    } catch (e) {
      clearTimeout(guard);
      settle(opts.onerror, e);
    }
    return { abort: () => settle(null) };
  };

  try { console.info('[SoundCloud Suite] GM shim ready (extension build)'); } catch (e) {}
})();
