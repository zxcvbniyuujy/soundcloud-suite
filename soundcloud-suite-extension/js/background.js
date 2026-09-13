/* SoundCloud SuperSuite — background service worker.
 * Performs the cross-origin fetches the lyric engine needs (host_permissions
 * exempt these from CORS). Hosts are allowlisted so page code can never use
 * this as an open proxy — the list mirrors the userscript's @connect rules. */

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
  'bing.com',
  'mojeek.com',
  'api.codetabs.com',
  'krcs.kugou.com',
  'lyrics.kugou.com',
  'music.163.com',
  'api.listenbrainz.org',
  'translate.googleapis.com',
];

function hostAllowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) { return false; }
}

// toolbar icon click → tell the page to toggle the lyrics panel (relayed
// through bridge.js, since the suite runs in the page's MAIN world)
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    try { chrome.tabs.sendMessage(tab.id, { scss: 'sl-toggle' }, () => void chrome.runtime.lastError); } catch (e) {}
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.scss !== 'xhr' || !msg.req) return;
  const req = msg.req;
  if (!hostAllowed(req.url)) {
    sendResponse({ ok: false, error: 'host not allowed: ' + req.url });
    return;
  }
  const ctrl = new AbortController();
  const ms = Math.min(Math.max((req.timeout | 0) || 30000, 1000), 60000);
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    fetch(req.url, {
      method: req.method || 'GET',
      headers: req.headers || {},
      body: req.data != null ? req.data : undefined,
      credentials: req.anonymous ? 'omit' : 'include',
      redirect: 'follow',
      signal: ctrl.signal,
    }).then((r) => r.text().then((text) => {
      clearTimeout(timer);
      sendResponse({ ok: true, status: r.status, statusText: r.statusText, text, url: r.url });
    })).catch((e) => {
      clearTimeout(timer);
      sendResponse({
        ok: false,
        timedOut: !!(e && e.name === 'AbortError'),
        error: String((e && e.message) || e),
      });
    });
  } catch (e) {
    clearTimeout(timer);
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
  return true; // keep the message channel open for the async sendResponse
});
