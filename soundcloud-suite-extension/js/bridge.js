/* SoundCloud Suite — isolated-world relay.
 * The main-world shim can't touch chrome.runtime, so this script forwards
 * its xhr requests to the background service worker and posts the result
 * back, and relays the toolbar-click toggle into the page. */
(() => {
  // background → page: toolbar icon click toggles the lyrics panel
  let cmdSeq = 0;
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.scss === 'sl-toggle') {
        try { window.postMessage({ scss: 'sl-toggle' }, location.origin); } catch (e) {}
        try { sendResponse(true); } catch (e) {}   // an unanswered message reads as "no receiver" to the background, which reloads the tab
        return;
      }
      // a keyboard command: hand it to the page and answer with whether the page handled it
      if (msg && msg.scss === 'cmd' && typeof msg.name === 'string') {
        const id = ++cmdSeq;
        let done = false;
        function finish(handled, info) { if (done) return; done = true; window.removeEventListener('message', onAck); try { sendResponse(info && typeof info === 'object' ? { handled: handled === true, info } : handled === true); } catch (e) {} }
        function onAck(e) { const d = e.data; if (e.source === window && d && d.scss === 'cmd-ack' && d.id === id) finish(d.handled, d.info); }
        window.addEventListener('message', onAck);
        setTimeout(() => finish(false), 1500);   // a busy player tab (a shuffle load rendering, a lyric sheet painting) needs more than a frame
        try { window.postMessage({ scss: 'cmd', id, name: msg.name, broadcast: !!msg.broadcast }, location.origin); } catch (e) { finish(false); }
        return true;   // sendResponse comes later
      }
    });
  } catch (e) {}
  // page → background: which tab plays, which tab was last in front (the command router's two answers)
  const tell = (state) => { try { chrome.runtime.sendMessage(Object.assign({ scss: 'state' }, state), () => { void chrome.runtime.lastError; }); } catch (e) {} };
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source === window && d && d.scss === 'state') tell({ playing: d.playing === true ? true : d.playing === false ? false : undefined, focus: !!d.focus });
    // the page asks for a language dictionary (i18n/<lang>.json): the background reads the packaged file
    if (e.source === window && d && d.scss === 'dict?' && typeof d.lang === 'string' && /^[a-z]{2}$/.test(d.lang)) {
      try { chrome.runtime.sendMessage({ scss: 'dict', lang: d.lang }, (res) => { void chrome.runtime.lastError; if (res && res.ok && typeof res.json === 'string') { try { window.postMessage({ scss: 'dict', lang: d.lang, json: res.json }, location.origin); } catch (err) {} } }); } catch (err) {}
    }
    // the page asks for the extension id: it builds the Chrome Web Store link from it (Rate & share)
    if (e.source === window && d && d.scss === 'ext-id?') { try { window.postMessage({ scss: 'ext-id', id: String(chrome.runtime.id || '') }, location.origin); } catch (err) {} }
  });
  window.addEventListener('focus', () => tell({ focus: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tell({ focus: true }); });

  /* page → background: the shim's cross-origin requests. The channel is a detached element the shim made at
   * document_start and showed this script once, through a bubbling event, before any page script ran: nothing
   * on the page can reach it afterwards, so a request arriving on it came from the shim and nowhere else. Should
   * the handshake ever fail, the shim falls back to window.postMessage, accepted only while no channel exists. */
  let chan = null;
  const relay = (req, reply) => {
    let responded = false;
    const once = (res) => { if (responded) return; responded = true; reply(res); };
    try {
      chrome.runtime.sendMessage({ scss: 'xhr', req }, (res) => {
        if (chrome.runtime.lastError || !res) once({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no response from background' });
        else once(res);
      });
    } catch (err) { once({ ok: false, error: String((err && err.message) || err) }); }
  };
  const adopt = (el) => {
    if (chan || !el || typeof el.addEventListener !== 'function') return;   // the first channel offered is the shim's; a later one is not
    chan = el;
    el.addEventListener('scss-xhr', (e) => {
      let d = null; try { d = JSON.parse(String(e.detail)); } catch (err) { d = null; }
      if (!d || !d.req) return;
      relay(d.req, (res) => { try { el.dispatchEvent(new CustomEvent('scss-xhr-res', { detail: JSON.stringify(Object.assign({ id: d.id }, res)) })); } catch (err) {} });
    });
    try { el.dispatchEvent(new CustomEvent('scss-chan!')); } catch (e) {}   // linked: the shim stops offering
  };
  document.addEventListener('scss-chan', (e) => adopt(e.target), true);
  try { document.dispatchEvent(new CustomEvent('scss-chan?')); } catch (e) {}   // the shim may have offered before this script listened: ask it to offer again
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.scss !== 'xhr-req' || !d.req || chan) return;
    relay(d.req, (res) => { try { window.postMessage(Object.assign({ scss: 'xhr-res', id: d.id }, res), location.origin); } catch (e2) {} });
  });
})();
