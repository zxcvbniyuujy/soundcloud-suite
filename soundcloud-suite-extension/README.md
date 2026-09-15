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

## Audio

The hub's Audio tab shapes SoundCloud's sound in real time through a Web
Audio chain spliced into the player's own graph. Every control is an exact
passthrough at its default, and with nothing enabled the chain is detached
entirely, so SoundCloud plays exactly as it does without the extension.

- **Equalizer** — 10 bands you drag on the curve (the curve shown is the real
  combined response of everything below), pre-amp, 23 presets, your own saved
  presets, and **Auto-headroom**, which lowers the pre-amp by your biggest
  boost so nothing clips. Optionally remembers the curve per track.
- **Listening on** — one-tap Headphones / Laptop / Speakers profiles.
- **Playback** — speed 0.5×–2× with tempo chips, **Pitch follows speed**
  (vinyl / slowed / nightcore), fade in and out with adjustable lengths, and a
  **Slowed + reverb** chip.
- **Tone** — Bass (with an automatic sub-25 Hz rumble filter), Vocals softer
  or lifted, a loudness contour for low volume, Tilt (warm ↔ bright), and a
  harmonic bass for small speakers.
- **Enhance** — a five-stage tone shape (sub, warmth, a mud dip, presence,
  air), 4×-oversampled saturation, a harmonic exciter that rebuilds the top
  end a lossy stream lost, and a three-band compressor for punch that follows
  the track's own loudness, so a quiet dynamic mix and a brickwalled master
  get the same treatment. It takes its own headroom so nothing clips, and its
  level is measured offline on a music clip and cancelled, so it never wins by
  simply being louder.
- **Loudness & dynamics** — K-weighted, gated loudness normalization with a
  Quiet / Normal / Loud target and a per-track memory; Night mode; Volume
  boost up to 300 %; and a **Clip guard** — a true-peak brick-wall limiter
  (an AudioWorklet with 5 ms look-ahead, ceiling −1 dBTP; a compressor stands
  in where the worklet can't load) that engages automatically whenever
  something boosts or Enhance is on.
- **Stereo** — width 0–200 %, headphone crossfeed (Subtle / Natural /
  Strong), balance, mono, swap left / right.
- **Headphone correction** — paste an AutoEQ profile for your headphones.
- **Compare** — hold to hear the original at the same level; the header shows
  a live meter (loudness, peak, applied gain, guard).
- Copy / Paste / Reset all audio settings; the footnote reports the engine's
  sample rate and total delay, which the lyrics sync accounts for.

Lyrics sync: the highlight follows the audio clock minus the measured output
and effects delay, lights the sung line on its own frame, and — for synced
sheets — listens to the first 90 s of the track through its own taps to
estimate the constant lag between the sheet and the vocals it hears; when the
estimate is confident it applies it as an "auto" offset (shown in the source
line; **0** clears it, and any manual nudge wins).

Audio hotkeys (with **Global hotkeys** on in Tweaks): **A** hold to compare,
**N** night mode, **,** / **.** speed −5 % / +5 %. Inside the hub they work on
the Audio tab.

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
- **A** (hold) compare · **N** night mode · **,** / **.** speed, with Global hotkeys on

## Testing the audio engine

`tools/audio-harness.js` loads the unpacked extension into Playwright's
Chromium, plays synthetic test tones through the same Web Audio hooks
SoundCloud's player uses, and checks every audio feature: node values,
passthrough, loudness measurement, limiter ceiling, fades, hotkeys and the
tab's rendering.

```sh
npm i -g playwright && npx playwright install chromium   # once
node tools/audio-harness.js              # all scenarios; add --list or --only a,b
```

The debug accessor it reads (`window.__sceAudioDebug`) exists only while
`localStorage['scss:debug'] === '1'` on soundcloud.com.

## Troubleshooting

- `chrome://extensions` → SuperSuite card → **Errors** shows loader problems.
- On soundcloud.com the DevTools console prints
  `[SuperSuite] GM shim ready (extension build)` at page load.
- Set `localStorage['scss:debug'] = '1'` on soundcloud.com to see the suite's
  caught errors in the console; **⋯ → Copy error log** in the hub copies the
  same ring (tokens redacted).

## License

MIT — see `LICENSE`.
