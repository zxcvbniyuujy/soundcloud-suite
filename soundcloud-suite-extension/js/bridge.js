/* SoundCloud Suite — isolated-world relay.
 * The main-world shim can't touch chrome.runtime, so this script forwards
 * its xhr requests to the background service worker and posts the result
 * back, and relays the toolbar-click toggle into the page. */
(() => {
  // background → page: toolbar icon click toggles the lyrics panel
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.scss === 'sl-toggle') {
        try { window.postMessage({ scss: 'sl-toggle' }, location.origin); } catch (e) {}
      }
    });
  } catch (e) {}

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
