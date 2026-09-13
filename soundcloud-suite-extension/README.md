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
| `js/suite.js` | page (MAIN) | The suite itself (also runs as a Tampermonkey userscript) |
| `js/background.js` | service worker | Performs the cross-origin fetches (allowlisted hosts only, our own content script only) |

The suite must run in the page's MAIN world because it patches SoundCloud's
`fetch`/`XMLHttpRequest` (shuffle feed), `history` (navigation), and
`Audio`/`AudioContext` (media hooks). Extension APIs aren't available there,
so the bridge and background worker hold the network privileges.

Everything the suite stores (settings, stats, lyric cache, blocklist, library
cache) lives in soundcloud.com's own localStorage and IndexedDB, under the
`scssgm:` / `bh_sc_` / `sl4:` prefixes. Nothing leaves the browser.

## UI structure

Every surface the suite draws — the lyrics hub, the shuffle cards, the
settings and audio tabs, the track-info popover, the sheets and the toast —
is built on one design system that lives at the top of `js/suite.js`
(`SUITE.DS`). It holds the token set (colour, type, spacing, radius, motion,
with a light variant) and the component vocabulary (`ss-row`, `ss-sw`,
`ss-btn`, `ss-sel`, `ss-range`, `ss-tile`, `ss-dialog`, `ss-toast`, …).
Each surface root carries the class `ss` (plus `ss-light` when the page is
light) and adopts that stylesheet, so a switch or a button looks the same in
every module and a change to a token changes everything at once. Module-
specific rules sit next to their module; nothing is styled inline apart from
data-driven values such as artwork URLs, slider positions and drag offsets.

`SUITE.toast(message, secondLine, { label, fn })` is the single notification
for all three modules.

The hub itself is a frosted dark sheet floating just inside the right
edge, between SoundCloud's header and player bar, set in the Söhne web
font the site loads. The cover art, blurred and enlarged, lights the top
of the sheet; the header is a Now Playing card whose base is a 4px orange
progress bar (click along it to seek) with the time and the four actions
in the band above it; the tabs are a segmented control; lyrics are large
and bold, the live line bright with its sung words wiping to white; the
Queue, Stats, Audio and Tweaks tabs lay their content out in rounded
cards. SoundCloud orange is the one interactive accent; the artwork's
colour is used only for the ambient light. Dragging the sheet's left edge
changes the width (double-click resets).
Press **D**, use ⋯ → Layout, or pull the header away from the edge to turn
it into the compact floating card, which remembers its own position and
size; **D** docks it again. Immersive mode (**F**) works from either.

## Previewing changes

`tools/preview.js` loads the unpacked extension into Playwright's Chromium,
opens a public playlist, starts playback and screenshots every surface (hub
tabs, menu, hotkey sheet, search, command palette, settings, track info):

```sh
npm i -g playwright && npx playwright install chromium   # once
node tools/preview.js ./preview-shots
```

It prints any page errors the suite raised. `preview-shots/` is git-ignored.

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
- **D** docked drawer ↔ floating card · **F** immersive · **T** theme (inside the hub)

## Troubleshooting

- `chrome://extensions` → SuperSuite card → **Errors** shows loader problems.
- On soundcloud.com the DevTools console prints
  `[SuperSuite] GM shim ready (extension build)` at page load.
- Set `localStorage['scss:debug'] = '1'` on soundcloud.com to see the suite's
  caught errors in the console; **⋯ → Copy error log** in the hub copies the
  same ring (tokens redacted).

## License

MIT — see `LICENSE`.
