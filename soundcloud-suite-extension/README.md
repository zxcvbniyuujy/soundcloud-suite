# SoundCloud SuperSuite — Chrome extension

Native Chrome (Manifest V3) build of SoundCloud SuperSuite: page themes and
declutter, player upgrades (speed, loop, volume memory, sleep timer, audio FX),
a synced-lyrics hub with six sources, and full-library shuffle with stats.
No Tampermonkey needed. Version: see `manifest.json`.

## Install / reload

1. Open `chrome://extensions/` and enable **Developer mode** (top right).
2. **Load unpacked** → pick this folder. Already loaded? Hit **↻** on the card.
3. Disable or remove any Tampermonkey copy of the suite. Both would patch the
   same page; the suite has a double-injection guard, but only one instance
   should be installed.
4. Reload soundcloud.com.

## How it is structured

| File | World | Job |
|---|---|---|
| `js/bridge.js` | isolated | Relays lyric-fetch requests from the page to the background worker, and the toolbar click back into the page |
| `js/gm-shim.js` | page (MAIN) | Stands in for Tampermonkey's `GM_*` APIs: synchronous localStorage-backed storage, clipboard, and a cross-origin request relay |
| `js/suite.js` | page (MAIN) | The suite itself: the userscript, unmodified apart from version sync |
| `js/background.js` | service worker | Performs the cross-origin fetches (allowlisted hosts only, our own content script only) |

The suite must run in the page's MAIN world because it patches SoundCloud's
`fetch`/`XMLHttpRequest` (shuffle feed), `history` (navigation), and
`Audio`/`AudioContext` (media hooks). Extension APIs aren't available there,
so the bridge and background worker hold the network privileges.

Everything the suite stores (settings, stats, lyric cache, blocklist, library
cache) lives in soundcloud.com's own localStorage and IndexedDB, under the
`scssgm:` / `bh_sc_` / `sl4:` prefixes. Nothing leaves the browser.

## Building and releasing

`build.sh` keeps the four version strings (userscript `@version`,
`manifest.json`, the shim's `GM_info`, and the suite's own fallback) in lockstep
and enforces the token policy. It works on macOS and Linux.

```sh
./build.sh                    # sync versions, verify blank Genius token, syntax-check
./build.sh 4.52.0             # bump the version everywhere first
./build.sh --public --zip     # release build: refuses any token, writes ../supersuite-<v>.zip
```

If you keep the userscript as a separate file, point the script at it with
`SC_SUITE_SRC=/path/to/soundcloud-suite.user.js`; otherwise `js/suite.js` is
edited in place. A personal Genius token for local builds goes in
`tools/dev-token.txt` (git-ignored) and is only ever injected into a copied
build, never into the tracked source.

## Hotkeys

- **Alt+L** lyrics hub · **Alt+S** shuffle · **Alt+B** block the current track
- **Ctrl/⌘+K** command palette · **?** the full cheat-sheet (inside the hub)

## Troubleshooting

- `chrome://extensions` → SuperSuite card → **Errors** shows loader problems.
- On soundcloud.com the DevTools console prints
  `[SuperSuite] GM shim ready (extension build)` at page load.
- Set `localStorage['scss:debug'] = '1'` on soundcloud.com to see the suite's
  caught errors in the console; **⋯ → Copy error log** in the hub copies the
  same ring (tokens redacted).

## License

MIT — see `LICENSE`.
