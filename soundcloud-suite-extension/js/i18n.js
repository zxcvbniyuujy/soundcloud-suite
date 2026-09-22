/* SoundCloud Suite — the suite's own text in the listener's language.
 * A dictionary per language (i18n/<lang>.json, fetched by the background worker through the relay) and a
 * translator that follows the suite's roots: every text node and every title / placeholder / aria-label under a
 * watched root is looked up as written in English, with numbers folded to # so one entry covers every value.
 * Track titles, artists and lyric lines never match a dictionary entry of their own accord, and the containers
 * that hold them are skipped outright. English, or a language with no dictionary, is an exact no-op. */
(() => {
  'use strict';
  if (window.__scsI18n) return;
  const LANGS = ['de', 'fr', 'es', 'pt', 'it', 'nl', 'pl', 'tr', 'ru', 'ja', 'ko'];
  const NUM = /\d[\d.,:]*/g;
  const SKIP_CLASS = /(^|\s)(line|rline|tline|lines|res|qrow|qtitle|qart|hist|hrow|tt|nxt|mini|cur|nx|pv|ln|t|a|sce-mini-title|sce-mini-artist|bhx-nowmeta|cmdkl|cmdki)(\s|$)/;   // pv · ln: the floating window's previous line and its line block
  const SKIP_TAG = /^(SCRIPT|STYLE|TEXTAREA|INPUT|CODE|PRE)$/;
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const st = { lang: 'en', want: 'auto', dict: null, loading: '', roots: new Set(), orig: new WeakMap(), out: new WeakMap(), aorig: new WeakMap(), aout: new WeakMap(), asked: 0 };

  function pick(want) {
    let w = want;
    if (!w || w === 'auto') { try { w = (navigator.language || 'en').toLowerCase(); } catch (e) { w = 'en'; } }
    const base = String(w).split(/[-_]/)[0];
    return LANGS.indexOf(base) >= 0 ? base : 'en';
  }
  function saved() { try { const c = JSON.parse(localStorage.getItem('scssgm:enh:cfg') || '{}'); return (c && typeof c.uiLang === 'string') ? c.uiLang : 'auto'; } catch (e) { return 'auto'; } }

  function lookupOne(d, t) {
    let r = d[t]; if (typeof r === 'string' && r) return r;
    const nums = t.match(NUM); if (!nums) return null;
    r = d[t.replace(NUM, '#')]; if (typeof r !== 'string' || !r) return null;
    let i = 0; return r.replace(/#/g, () => (i < nums.length ? nums[i++] : '#'));
  }
  // "Label: value" and "a · b" are built at run time from parts the dictionary holds one by one ("Focus mode: off",
  // "Queue · <track title>"): when the whole has no entry, each part is looked up on its own and the separators stay.
  // A part with no entry (a title, a name) stays as written; a whole with no translated part is left alone
  const SEP = /( · |: )/;
  function lookup(text) {
    const d = st.dict; if (!d) return null;
    const t = norm(text); if (!t || !/[A-Za-z]/.test(t)) return null;
    const whole = lookupOne(d, t); if (whole) return whole;
    if (!SEP.test(t)) return null;
    const bits = t.split(SEP); let hit = false;
    for (let i = 0; i < bits.length; i += 2) { const r = lookupOne(d, bits[i]); if (r) { bits[i] = r; hit = true; } }
    return hit ? bits.join('') : null;
  }
  function skip(el) {
    let n = el, k = 0;
    while (n && n.nodeType === 1 && k++ < 6) {
      if (SKIP_TAG.test(n.tagName) || n.hasAttribute('data-i18n-skip') || SKIP_CLASS.test(n.className || '')) return true;
      n = n.parentNode && n.parentNode.nodeType === 1 ? n.parentNode : null;
    }
    return false;
  }
  function textNode(node) {
    const cur = node.nodeValue; if (cur == null) return;
    if (st.out.get(node) === cur) { if (st.lang === 'en') { const o = st.orig.get(node); if (o != null) { node.nodeValue = o; st.out.delete(node); } } return; }   // our own write, or a restore
    if (st.lang === 'en') return;
    if (!/[A-Za-z]/.test(cur) || skip(node.parentNode)) return;
    const r = lookup(cur); if (!r) return;
    const lead = cur.match(/^\s*/)[0], tail = cur.match(/\s*$/)[0];
    const v = lead + r + tail; if (v === cur) return;
    st.orig.set(node, cur); st.out.set(node, v); node.nodeValue = v;
  }
  // attributes: a skipped container's title / aria-label carries the same content as its text (a track title as a
  // tooltip), so the class and data-i18n-skip rules apply — but not the tag rule: a field's placeholder is the suite's
  function skipAttr(el) {
    if (el.hasAttribute('data-i18n')) return false;   // the element opts its own tooltip in (a row that holds a track title but carries the suite's tooltip)
    let n = el, k = 0;
    while (n && n.nodeType === 1 && k++ < 6) {
      if (n.hasAttribute('data-i18n-skip') || SKIP_CLASS.test(n.className || '')) return true;
      n = n.parentNode && n.parentNode.nodeType === 1 ? n.parentNode : null;
    }
    return false;
  }
  function attrs(el) {
    if (el.nodeType !== 1 || skipAttr(el)) return;
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a);
      const outs = st.aout.get(el) || {}, origs = st.aorig.get(el) || {};
      if (outs[a] === cur) { if (st.lang === 'en' && origs[a] != null) { el.setAttribute(a, origs[a]); delete outs[a]; } continue; }
      if (st.lang === 'en' || !/[A-Za-z]/.test(cur)) continue;
      const r = lookup(cur); if (!r || r === cur) continue;
      origs[a] = cur; outs[a] = r; st.aorig.set(el, origs); st.aout.set(el, outs); el.setAttribute(a, r);
    }
  }
  function walk(root) {
    if (!root) return;
    try {
      if (root.nodeType === 3) { textNode(root); return; }
      const w = document.createTreeWalker(root, 5);   // elements and text
      let n = root; if (n.nodeType === 1) attrs(n);
      while ((n = w.nextNode())) { if (n.nodeType === 3) textNode(n); else attrs(n); }
    } catch (e) {}
  }
  function observe(root) {
    try {
      const mo = new MutationObserver((recs) => {
        for (const r of recs) {
          if (r.type === 'characterData') textNode(r.target);
          else if (r.type === 'attributes') attrs(r.target);
          else r.addedNodes.forEach(walk);
        }
      });
      mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    } catch (e) {}
  }
  function refresh() { st.roots.forEach((r) => { if (r.isConnected === false && !(r.host && r.host.isConnected)) st.roots.delete(r); else walk(r); }); }

  // the dictionary comes from the packaged i18n/<lang>.json through the relay (isolated world → background)
  function load(lang) {
    if (st.loading === lang) return;
    st.loading = lang; st.asked = Date.now();
    try { window.postMessage({ scss: 'dict?', lang }, location.origin); } catch (e) {}
    setTimeout(() => { if (st.loading === lang && !st.dict) { try { window.postMessage({ scss: 'dict?', lang }, location.origin); } catch (e) {} } }, 2500);   // the relay may not have been listening yet
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.scss !== 'dict' || typeof d.lang !== 'string') return;
    if (d.lang !== st.loading) return;
    let dict = null; try { dict = typeof d.json === 'string' ? JSON.parse(d.json) : d.json; } catch (err) { dict = null; }
    st.loading = '';
    if (!dict || typeof dict !== 'object') return;
    st.dict = dict; st.lang = d.lang; refresh();
  });

  function setLang(want) {
    const target = pick(want);
    st.want = want || 'auto';
    if (target === st.lang && (target === 'en' || st.dict)) return;
    // back to English first: every translated node returns to what the suite wrote
    if (st.lang !== 'en') { st.lang = 'en'; st.dict = null; refresh(); }
    if (target !== 'en') load(target);
  }
  window.__scsI18n = {
    watch(root) { if (!root || st.roots.has(root)) return; st.roots.add(root); observe(root); if (st.lang !== 'en' && st.dict) walk(root); },
    setLang, lang: () => st.lang, langs: () => LANGS.slice(), ready: () => !!st.dict,
    t: (s) => (st.lang !== 'en' && st.dict && lookup(s)) || s,
  };
  setLang(saved());
})();
