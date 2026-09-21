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
        return;
      }
      // a keyboard command: hand it to the page and answer with whether the page handled it
      if (msg && msg.scss === 'cmd' && typeof msg.name === 'string') {
        const id = ++cmdSeq;
        let done = false;
        const finish = (handled, info) => { if (done) return; done = true; window.removeEventListener('message', onAck); try { sendResponse(info && typeof info === 'object' ? { handled: handled === true, info } : handled === true); } catch (e) {} };
        const onAck = (e) => { const d = e.data; if (e.source === window && d && d.scss === 'cmd-ack' && d.id === id) finish(d.handled, d.info); };
        window.addEventListener('message', onAck);
        setTimeout(() => finish(false), 400);
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
  });
  window.addEventListener('focus', () => tell({ focus: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tell({ focus: true }); });

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.scss !== 'xhr-req' || !d.req) return;
    let responded = false;
    const reply = (res) => {
      if (responded) return;
      responded = true;
      try {
        window.postMessage(Object.assign({ scss: 'xhr-res', id: d.id }, res), location.origin);
      } catch (e2) {}
    };
    try {
      chrome.runtime.sendMessage({ scss: 'xhr', req: d.req }, (res) => {
        if (chrome.runtime.lastError || !res) {
          reply({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no response from background' });
        } else {
          reply(res);
        }
      });
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  });
})();
