/* SoundCloud Suite — background service worker.
 * Performs the cross-origin fetches the lyric engine needs (host_permissions
 * exempt these from CORS). Three guards keep this from becoming an open proxy
 * for anything else running on soundcloud.com:
 *   · only our own content script, on a soundcloud.com frame, may ask
 *   · the requested host AND the final host after redirects must be allowlisted
 *     (the list mirrors the userscript's @connect rules and the manifest)
 *   · responses are capped so a runaway body can't exhaust the message channel */

const ALLOWED_HOSTS = [
  'soundcloud.com',
  'lrclib.net',
  'genius.com',
  'itunes.apple.com',
  'apic-desktop.musixmatch.com',
  'html.duckduckgo.com',
  'api.lyrics.ovh',
  'web.archive.org',
  'api.allorigins.win',
  'www.bing.com',
  'www.mojeek.com',
  'api.codetabs.com',
  'krcs.kugou.com',
  'lyrics.kugou.com',
  'music.163.com',
  'api.listenbrainz.org',
  'translate.googleapis.com',
];
const MAX_BODY_BYTES = 8 * 1024 * 1024;   // lyric pages and search HTML are well under 1 MB
const SC_FRAME = /^https:\/\/([\w-]+\.)*soundcloud\.com\//;

function hostAllowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) { return false; }
}

// toolbar icon: on SoundCloud, toggle the lyrics hub (relayed through bridge.js,
// since the suite runs in the page's MAIN world); anywhere else, open SoundCloud
chrome.action.onClicked.addListener((tab) => {
  const onSoundCloud = !!(tab && typeof tab.url === 'string' && SC_FRAME.test(tab.url));
  if (onSoundCloud && tab.id != null) {
    // no receiver = the tab was open before the install or update: reload it so the content scripts land
    try { chrome.tabs.sendMessage(tab.id, { scss: 'sl-toggle' }, () => { if (chrome.runtime.lastError) { try { chrome.tabs.reload(tab.id); } catch (e) {} } }); } catch (e) {}
    return;
  }
  try { chrome.tabs.create({ url: 'https://soundcloud.com/' }); } catch (e) {}
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.scss !== 'xhr' || !msg.req) return;
  if (!sender || !sender.tab || !SC_FRAME.test(String(sender.url || ''))) {
    sendResponse({ ok: false, error: 'relay refused: unexpected sender' });
    return;
  }
  const req = msg.req;
  if (!hostAllowed(req.url)) {
    sendResponse({ ok: false, error: 'host not allowed: ' + req.url });
    return;
  }
  const ctrl = new AbortController();
  const ms = Math.min(Math.max((req.timeout | 0) || 30000, 1000), 60000);
  const timer = setTimeout(() => ctrl.abort(), ms);
  const fail = (e) => {
    clearTimeout(timer);
    sendResponse({
      ok: false,
      timedOut: !!(e && e.name === 'AbortError'),
      error: String((e && e.message) || e),
    });
  };
  try {
    fetch(req.url, {
      method: req.method || 'GET',
      headers: req.headers || {},
      body: req.data != null ? req.data : undefined,
      credentials: (!req.anonymous && SC_FRAME.test(req.url)) ? 'include' : 'omit',   // cookies only ever go to soundcloud.com, whatever the page asks
      redirect: 'follow',
      signal: ctrl.signal,
    }).then((r) => {
      if (!hostAllowed(r.url)) { ctrl.abort(); throw new Error('redirected off the allowlist: ' + r.url); }
      const len = +r.headers.get('content-length');
      if (len > MAX_BODY_BYTES) { ctrl.abort(); throw new Error('response too large'); }
      return r.text().then((text) => {
        clearTimeout(timer);
        if (text.length > MAX_BODY_BYTES) throw new Error('response too large');
        sendResponse({ ok: true, status: r.status, statusText: r.statusText, text, url: r.url });
      });
    }).catch(fail);
  } catch (e) { fail(e); }
  return true; // keep the message channel open for the async sendResponse
});
