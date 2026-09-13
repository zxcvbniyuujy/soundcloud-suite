# SoundCloud SuperSuite — Chrome Extension (v2.2.0)

Native Chrome extension build of SoundCloud SuperSuite (lyrics hub + library shuffle). No Tampermonkey needed.

## Install / Reload

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this folder
   (already loaded? just hit the **↻ refresh** icon on the extension card)
4. **Disable or remove the Tampermonkey copy** of the script — running both
   would fight over the same page (the suite has a guard, but only one wins)
5. Reload soundcloud.com

## How it's structured

| File | World | Job |
|---|---|---|
| `js/gm-shim.js` | page (MAIN) | Replaces Tampermonkey's GM_* APIs: synchronous localStorage-backed storage, clipboard, and a cross-origin request relay |
| `js/suite.js` | page (MAIN) | The full userscript, byte-for-byte unmodified |
| `js/bridge.js` | isolated | Relays lyric-fetch requests from the page to the background worker |
| `js/background.js` | service worker | Performs the actual cross-origin fetches (allowlisted hosts only) |

The suite must run in the page's MAIN world because it patches SoundCloud's
`fetch`/`XMLHttpRequest` (shuffle feed), `history` (navigation), and
`Audio`/`createElement` (media hook). Extension APIs aren't available there,
so the bridge + background worker handle the network privileges.

## Updating the script

Edit the source userscript, then copy it over and reload the extension:

```sh
cp "/Users/x/Downloads/soundcloud suite/soundcloud-suite.user.js" \
   "/Users/x/Downloads/soundcloud-suite-extension/js/suite.js"
```

## What carries over from the Tampermonkey version

- ✅ Shuffle settings, stats, history, blocklist — these always lived in
  soundcloud.com's localStorage/IndexedDB, so they carry over automatically
- ❌ Lyric cache, sync memory, theme/position, Musixmatch token — these lived
  in Tampermonkey's private storage and start fresh (they rebuild on their
  own as you listen)

## Troubleshooting

- `chrome://extensions` → SuperSuite card → **Errors** shows loader problems
- On soundcloud.com, DevTools console should show
  `[SuperSuite] GM shim ready (extension build)` at page load
- Hotkeys: **Alt+L** lyrics panel · **Alt+S** shuffle · **?** in the panel
  for the full list
