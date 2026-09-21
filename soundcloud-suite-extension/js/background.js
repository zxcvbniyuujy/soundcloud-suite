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

/* Keyboard commands (chrome://extensions/shortcuts): the page cannot hear them. The tab that last reported
 * playing gets the command straight away; otherwise (the worker restarted, or nothing is playing) every tab is
 * asked who it is and the best one is chosen: playing first, then the tab that started or stopped most recently,
 * then a visible one. A hidden, silent tab still declines a blind broadcast so four tabs never start at once. */
const cmdTabs = { playing: null };
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.scss !== 'state' || !sender || !sender.tab || sender.tab.id == null || !SC_FRAME.test(String(sender.url || ''))) return;
  if (msg.playing === true) cmdTabs.playing = sender.tab.id;
  else if (msg.playing === false && cmdTabs.playing === sender.tab.id) cmdTabs.playing = null;
});
try { chrome.tabs.onRemoved.addListener((id) => { if (cmdTabs.playing === id) cmdTabs.playing = null; }); } catch (e) {}
// resolves true (handled), false (the tab declined), an info object (a whoami answer) or null (no receiver: the tab is gone or has no content script)
function sendCommand(tabId, name, broadcast) {
  return new Promise((resolve) => {
    try { chrome.tabs.sendMessage(tabId, { scss: 'cmd', name, broadcast: !!broadcast }, (r) => { const dead = !!chrome.runtime.lastError || r === undefined; void chrome.runtime.lastError; resolve(dead ? null : (r === true || !!(r && r.handled === true && !r.info) ? true : (r && r.info) ? r.info : false)); }); } catch (e) { resolve(null); }
  });
}
async function pickTab() {
  let tabs = []; try { tabs = await chrome.tabs.query({}); } catch (e) {}
  const answers = await Promise.all(tabs.filter((t) => t && t.id != null).map(async (t) => { const r = await sendCommand(t.id, 'whoami', false); return r && typeof r === 'object' && r.player ? { id: t.id, info: r } : null; }));
  const c = answers.filter(Boolean);
  if (!c.length) return null;
  c.sort((p, q) => (q.info.playing - p.info.playing) || ((q.info.lastAt || 0) - (p.info.lastAt || 0)) || (q.info.visible - p.info.visible));
  return c[0].id;
}
async function dispatchCommand(name) {
  // a tab that declines (next is greyed out, nothing loaded) ends the command: it must not land in another tab
  if (cmdTabs.playing != null) { const r = await sendCommand(cmdTabs.playing, name, false); if (r === true) return cmdTabs.playing; if (r === false) return null; cmdTabs.playing = null; }
  const id = await pickTab();
  if (id != null) { const r = await sendCommand(id, name, false); return r === true ? id : null; }
  let tabs = []; try { tabs = await chrome.tabs.query({}); } catch (e) {}
  for (const t of tabs) { if (t && t.id != null && await sendCommand(t.id, name, true) === true) return t.id; }
  return null;
}
async function focusPlayingTab() {   // bring the SoundCloud tab that plays (else the most recent one) to the front
  let id = cmdTabs.playing;
  if (id == null || await sendCommand(id, 'whoami', false) === null) id = await pickTab();
  if (id == null) return null;
  try { const t = await chrome.tabs.update(id, { active: true }); if (t && t.windowId != null) { try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) {} } } catch (e) { return null; }
  return id;
}
try { chrome.commands.onCommand.addListener((name) => { if (name === 'focus-tab') focusPlayingTab(); else dispatchCommand(name); }); } catch (e) {}
if (typeof module !== 'undefined' && module.exports) module.exports = { dispatchCommand, focusPlayingTab, cmdTabs, hostAllowed };   // the unit test

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
