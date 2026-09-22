# SoundCloud Suite — Chrome extension

Native Chrome (Manifest V3) build of SoundCloud Suite: page themes and
declutter, player upgrades (speed, loop, volume memory, sleep timer, audio FX),
a synced-lyrics hub with six sources, and full-library shuffle with stats.
No Tampermonkey needed. Version: see `manifest.json`.

## For mixes, podcasts and long listens

- **Chapters** — a mix whose description carries a timestamped tracklist gets a
  chapter list at the top of the hub's Queue tab that follows the playhead;
  click to jump, `Next / Previous chapter` from the palette, `Copy tracklist`.
- **Cue points** — your own markers on any track (`+ Cue here`, the ⋯ menu or
  the palette), renamed by double-click, kept per track.
- **Resume long tracks** — anything over ten minutes remembers where you
  stopped for a month and offers to pick up there when it starts again
  (Tweaks → Player, ask / automatic / off).
- **Clickable timestamps** — any `12:34` in a description or comment jumps
  there; `#t=12:34` on a track URL lands the same way, and the track-info
  popover copies such a link at the current time.
- **Playlist runtime** — track count, total length and the clock time a full
  play-through would end, under every playlist and album title.
- **Continue listening** — the long tracks you left halfway, newest first, at
  the top of the hub's Queue tab; one click picks up where you stopped.

## Feed rules

Tweaks → Declutter: **Mute words** (title, artist, tags or genre), **Hide tracks
shorter / longer than**, **Hide tracks you already liked**, **Hide tracks you
already played** (30 seconds in counts, remembered for a month), **Hide
tracks with more plays than** and **Hide tracks older than** (fresh finds) and
**Hide reposts** run on SoundCloud's own feed, search and related-tracks
responses before the page renders them, so a hidden track never shows and
never plays.

## Player and system

- **System media controls** — title, artist and artwork in the OS now-playing
  panel; play, pause and seek from media keys (SoundCloud itself registers
  only next / previous). Inside a mix with a tracklist the panel names the
  chapter, with the mix as the album.
- **Chrome-wide keyboard commands** — Alt+Shift+P play / pause, Alt+Shift+N
  next, Alt+Shift+B previous, Alt+Shift+L like, from any tab; change them at
  `chrome://extensions/shortcuts`. The command reaches the SoundCloud tab
  that is playing, else the one last in front. No new permissions.
- **Pause when the audio output goes away** — headphones unplugged or a
  Bluetooth link dropped: playback pauses instead of switching to the speakers
  (Tweaks → Player). Chrome names outputs only once the site may use the
  microphone; before that the pause comes when no output is left.
- **Smart rewind** — a pause of three minutes on a track of five minutes or
  more resumes 5 s back, fifteen minutes 15 s back (Tweaks → Player).
- **Listen later** — a private, local shortlist that needs no account: save
  from the ⋯ menu, the palette or the track-info popover, find it on the
  Queue tab, one click opens and plays, and thirty seconds of playing a saved
  track clears it (Tweaks → Player).
- **Command palette arguments** — type `12:34`, `1:02:03`, `+30`, `-1:00` or
  `40%` into Ctrl+K to jump, `1.5x` for the speed, `170 bpm` to lock the
  tempo; audio switches (Night mode, Enhance, Loudness normalize, Equalizer,
  Crossfeed, Mono) show their state; recent commands come first; a title or
  artist from your likes opens and plays the track.
- **Tempo lock** — once a track's tempo is measured the speed follows so every
  track plays at the BPM you chose (0.5×–2×); a known tempo is never replaced
  while the speed is off 1×.
- **Loop a lyric line** — ⋯ menu → *Loop this line* (or the lines picked for a
  card) on the player's A–B loop; Escape or *Loop off* stops it.
- **Auto dark follows the system** — Tweaks → Look → *Auto dark follows*: the
  clock, or the OS colour scheme, applied the moment it flips.
- **Copy as…** — the track-info popover copies “Artist – Title” and a Markdown
  link; Shift+C (with global hotkeys on) copies the link at the current time.
- **Keyboard in lists** — J and K walk the tracks of the feed, search and
  playlists with a visible ring; Enter plays, O opens, L likes, Escape clears
  (Tweaks → Player). Tracks you played for 30 s or more carry a small ✓.
- **More Chrome-wide commands** — Back 10 s, Forward 10 s, Mute and Jump to the
  SoundCloud tab that is playing, unbound until you give them keys at
  `chrome://extensions/shortcuts`.
- **Translation language and romanization** — Lyrics ⋯ menu: twenty target
  languages, and a romanized line under non-Latin lyrics (Japanese, Korean,
  Chinese, Cyrillic, Arabic, Greek, Hebrew, Thai, Hindi). Lines go to Google
  Translate without cookies, only while translation is on.
- **Quiet synced upgrade** — a text-only lyric sheet is re-checked against
  LRCLIB's exact match once a week; a synced version replaces it quietly.
- **Lyrics, faster and tighter** — LRCLIB’s exact duration-matched lookup runs
  first on every track; bare “sped up” / “slowed + reverb” / “Official Video”
  words are stripped from queries; a search ends within 14 s. A sheet timed to
  a master a few seconds longer or shorter keeps its timestamps (no stretching)
  and the vocal aligner applies a finding on its own once two looks agree
  (at 20, 35, 50, 70, 100, 140 and 200 s of playback, each on twelve lines or
  more); pressing 0 undoes it. NetEase sheets carry word-level timing for the
  karaoke wipe. The first related track is pre-warmed when no shuffle queue is
  set, and a run of skipped tracks starts one search, not one per track.
- **NetEase that loads** — its requests carry the headers its own apps send,
  which is what its lyric service wants from outside China; when a sheet still
  will not load, the toast says what happened (no answer, a placeholder, no
  timed lines) and the Copy diagnostics trail records it.
- **Skip audio ads** (Tweaks → Declutter, on by default) — the two
  first-party ad calls that ad-blocking filter lists fail (…/audio-ad…,
  …/promoted…) fail here exactly the way a blocked request looks to the
  page (fetch rejects, XHR reports status 0 with an error event), so the
  player goes on to the track; a creative that still arrives from the ad
  CDN paths is muted, run at 16× and sent to its end, and the element is
  handed back untouched when a track loads into it. A tally sits in the
  debug snapshot.
- **In your language** — the suite’s own text (tabs, rows, menus, toasts,
  tooltips, sheets, the tour, the floating window) in German, French,
  Spanish, Portuguese, Italian, Dutch, Polish, Turkish, Russian, Japanese or
  Korean. Auto follows the browser; Tweaks → Appearance → Language picks one.
  A translator (js/i18n.js) follows the suite’s own roots and looks every
  text node and title up as written, numbers folded to #, so track titles,
  artists and lyric lines are never touched; the dictionary is a packaged
  file the background worker hands over through the relay, and English is an
  exact no-op. The store listing itself carries a name and summary in twelve
  languages.
- **Floating lyrics window** — **P** in the hub, ⋯ → Floating lyrics window,
  or Ctrl+K: a small always-on-top window (Document Picture-in-Picture,
  Chrome 116+) with the artwork, the sung line and its karaoke wipe, the next
  line, a progress bar and prev / play / next. Space and ← → work inside it,
  ⤴ brings the SoundCloud tab forward, and the worker ticker keeps it moving
  while the tab is hidden. It reads the same synced sheet as the mini bar, so
  a text-only sheet shows the track instead.
- **The tour** — after the first-run setup choice, three spotlights on the
  suite's own buttons in the player bar (lyrics, shuffle, everything else);
  Next, Skip, Esc, Enter. Ctrl+K → Take the tour repeats it any time.
- **Rate & share** — Ctrl+K → Share SoundCloud Suite copies a line with the
  Chrome Web Store link (the relay hands the page the extension id); Rate
  SoundCloud Suite opens the store's review page. After seven days and
  thirty tracks a small corner card asks once: Rate, Share or Not now, and
  any answer settles it.
- **Sturdier under real conditions** — the toolbar icon toggles the hub
  without reloading the tab (it used to reload on every click, because the
  relay never answered); toasts raised in a hidden tab go away on their own;
  a failed shuffle says why on a toast with Copy log (queue panel, sign-in,
  rate limit, filters) and the button resets; a rate-limited fetch counts
  down on the button instead of looking frozen; a wedged IndexedDB cannot
  park the button; a buffering stream gets three times as long before the
  stuck-track watchdog skips it, and is never marked broken; a library too big
  for localStorage sheds cached page bodies, then titles, then says so once;
  the full like objects leave memory half an hour after the last shuffle; if
  SoundCloud renames the player bar the suite says so once instead of going
  quiet; ListenBrainz gets the start time of a listen.
- **Lyric requests you wait for go first** — the exact LRCLIB lookup and the
  winning candidate's body take a priority lane past a skipped track's
  speculative waves; NetEase or Kugou that keep timing out are parked for
  45 min; the "no lyrics" card names the sources that were unavailable and
  leads with Retry; a result that arrives while the search box is open still
  feeds the mini bar and the next-track pre-warm; a sheet swapped in late
  drops the previous sheet's auto offset; a quiet upgrade never overwrites a
  calibration saved while it waited; the vocal aligner's tap stops when there
  is nothing left to align; chapters retry when the client_id was not seen
  yet; a pick that cannot load leaves the sheet that was showing; the manual
  search opens with the artist the library knows; the results list paints
  once and then settles instead of rebuilding on every source.
- **Audio that follows the element that plays** — SoundCloud keeps a media
  source ready for the next track while the current one plays; the meters,
  loudness normalize, the Enhance tracker, the EQ spectrum and the silent-ending
  trim now read the chain of the element that is audible, and a seek, mute,
  restart or volume change while paused lands on the element that played, not
  the pre-created one. The player-bar title link is looked up with fallbacks
  and its absence is noted in the debug snapshot. The speed and text-size
  sliders touch only what they change (no full stylesheet rebuild, graph
  write and DOM scan per input event), the stylesheet is replaced only when
  it changed, and the promo-bar sweep tests text nodes instead of serialising
  the page. The Enhance glide waits out a bank crossfade; list keys leave a
  focused button, link, select, menu or dialog alone and the Liked toast
  reads the state before the click; the theme lands at document_start (no
  light flash on a dark theme); timestamps are re-linked after "Show more";
  the OS scrubber follows a speed change at once.
- **Loudness normalize measures the source at unity** — SoundCloud’s own
  volume slider sits before the capture point; it is compensated now, so a
  track played at 50 % is no longer read as quiet and pushed back up.
- **Audio scenes** — the whole Audio tab under a name: save, recall (tab or
  palette), delete. Scenes ride in the backup.
- **Quiet hours** — Night mode and the −18 LUFS target between two hours,
  both put back at the end (Tweaks → Player).
- **Notes** — a private note on any track in the track-info popover, searched
  from Ctrl+K (a word from the note, the title or the artist opens the track).
- **History browser** — Stats tab: every logged play grouped by day, one
  click opens and plays, *Export history CSV*.
- **Playlist tools** — under the runtime chip on any set: *Copy links* (every
  track, one per line) and *Export CSV* (title, artist, length, link).
- **Your data** — Tweaks → Data → Your data lists every store with its size and a
  Clear for each; the total against the browser's allowance.
- **Comment noise filter** — Tweaks → Declutter: emoji-only, promo and
  duplicate comments stay out of the comment list (an API-layer rule).
- **Accessibility** — the site and hub follow the OS reduce-motion setting;
  skip links (Skip to content, Skip to player) wait at the top of every page;
  *Readable secondary text* lifts the light grey copy to WCAG contrast.
- **Lyric share card** — ⋯ menu → *Share a lyric card*: pick up to six lines,
  get a 1080×1080 image on the clipboard or as a file.
- **Listening card** — Stats → *Share card*: total time, a 24-hour listening
  clock, top artists and the last seven days as one 1080×1080 image.
- **Find a song by a lyric** — ⋯ menu → *Find a song by a lyric*: the words you
  remember, searched across every lyric sheet this browser has cached.
- **Tempo** — the BPM measured from the audio itself (an onset detector in the
  audio worklet), shown in the Audio tab and the track-info popover, corrected
  for the playback speed and remembered per track (Tweaks → Player).
- **Minute seeks** — `{` and `}` seek a whole minute; `[` and `]` still seek
  ten seconds and the digits jump to a tenth of the track.
- **Artwork ↗** — the track-info popover opens the full-size cover.
- **Start page** — open SoundCloud on the page you choose (Tweaks → Player),
  applied only on a cold load, never to a link you followed.
- **Backups carry everything** — the one-file backup now includes cue points,
  resume positions, measured tempos and the played-tracks memory, each
  re-validated on import.

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
sheets — listens to the track through its own taps (a 90 s window that slides
along with playback) to estimate the constant lag between the sheet and the
vocals it hears. A finding of 200 ms or more shows up in the ⋯ menu as
**Align to vocals**; two looks that agree within 150 ms, each on twelve lines
or more with a clear peak, apply themselves. Applying sets an "auto" offset
(shown in the source line; **0** clears it, and any manual nudge sits on top).
The aligner waits for SoundCloud's media element when a cached sheet paints
before it exists, and re-taps when SoundCloud swaps elements between tracks.

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
./build.sh --public --zip     # release build: refuses any token, writes ../soundcloud-suite-<v>.zip
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

- `chrome://extensions` → SoundCloud Suite card → **Errors** shows loader problems.
- On soundcloud.com the DevTools console prints
  `[SoundCloud Suite] GM shim ready (extension build)` at page load.
- Set `localStorage['scss:debug'] = '1'` on soundcloud.com to see the suite's
  caught errors in the console; **⋯ → Copy error log** in the hub copies the
  same ring (tokens redacted). Shuffle failures land in the same ring, and the
  "Shuffle failed" toast carries a Copy log button.
- "SoundCloud's player layout changed" means the player bar is on the page but
  the class names the suite relies on are not; the log names which. Stats,
  Alt+B, sleep-after-this-track and scrobbling wait for an update.
- "Your library is too big for the browser's storage" means the compact likes
  index did not fit next to SoundCloud's own localStorage even after shedding
  cached lyric page bodies and titles; the shuffle itself still works from
  IndexedDB, but stats, the blocklist and lyric matching may miss some likes.
- "No lyrics found yet … some sources were unavailable" is not a verdict on the
  track: the card names what was missing (a rate-limited LRCLIB, a dead
  Musixmatch token, Genius reachable only through mirrors, NetEase or Kugou
  parked after four timeouts, or no network) and the track is searched again
  next time it plays.

## License

MIT — see `LICENSE`.
