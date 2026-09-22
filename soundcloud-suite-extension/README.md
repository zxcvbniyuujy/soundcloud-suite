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
  (Tweaks → Player).
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
  player never has an ad to play and goes straight to the track. Nothing is
  ever muted, re-rated or seeked: the sound the listener hears is never
  touched (4.64.1 removed a media-level fallback that could mute). A tally
  sits in the debug snapshot.
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
- **The stage** — **F**, the ⤢ button or a double-click on the artwork fills the
  screen with the lyrics alone: the artwork blurred behind them, the sung line
  lit with its wipe, the cover beside them, a seek bar and prev / play / next
  along the bottom; the chrome fades after three quiet seconds. Style picks
  the size (S–XL), left or centred lines, the cover on or off and an artwork
  or plain-dark backdrop, and remembers (`sl:stage`). Esc or F leaves. On the
  other tabs immersive mode is the roomy panel it was.
- **A tempo you can trust** — the onset feed is now spectral flux: a 1024-point
  FFT of the decimated mix about 172 times a second (at 44.1 kHz) in the audio worklet, the rise of
  24 log-spaced bands summed per frame. Every 4 s the last 32 s are gated (real
  onsets, not silence, a held note or speech) and autocorrelated; each estimate
  is a vote, votes within 3 % cluster and fade with a 30 s half-life, and the
  heaviest cluster publishes — one odd window never flips the figure, a real
  tempo change in the track wins within half a minute. On eight recorded uploads
  with published tempos, six land within 1.5 %, a re-upload reads 2 % slow and
  an 87 BPM track with a triplet feel reads its 130 BPM pulse.
- **Lyrics in the comments** — when nothing else has a sheet, the upload's own
  comments are scanned for one: a long multi-line comment that reads like
  lyrics, or a run of timestamped one-line comments by one listener (the
  artist first of all), delivered as text for the aligner to time.
- **Your own likes, on paper and in practice** — the signed-in Likes page is
  the one flow that cannot be exercised from this environment, so a reviewer
  read it against today's SoundCloud. Six changes: the account id that keys
  the cached library no longer depends on the sign-in token's shape alone
  (when the token does not carry it, the suite asks `/me` once); a liked
  playlist's tracks count as already on the page, since SoundCloud expands
  them ahead of the pool and holds each track once; each page keeps its own
  record of what its list loaded, so a visit to another likes page cannot
  erase it; a library cached before accounts were kept apart is dropped rather
  than claimed by whichever account shuffles first; the compact library behind
  stats, search and hide-liked is tagged with its account and not read by
  another; and the Shuffle Play button on your Likes page mounts above the
  list when SoundCloud's collection header is not found. The compatibility
  engine (playlist pages) was verified live on a public 50-track playlist.
- **A third review, six fixes** — an independent read of the 4.78.0 likes
  engine: the likes captured from one profile's list could be applied to the
  next profile's pool when SoundCloud rendered that page from its cache (the
  capture is now tied to the page it was made on, and a cached library learns
  the profile whose pagination the feed may answer from it); the queue-panel
  jump could be beaten by the loader's own scrolling while later pages loaded,
  and could not reach a first pool track that sat past SoundCloud's rendered
  window (a profile whose liked playlists expand ahead of the pool) — the
  loader's kicks now yield to the jump and the scan extends the window itself,
  verified on a 520-like profile; a landing on the seed no longer counts as a
  pool track; a run cancelled mid-start (an SPA navigation, a second press)
  can no longer skip, unpause or finish the run that replaced it; a refused
  reload leaves nothing armed and a cancel drops the auto-run flag; a re-used
  XHR cannot record a served page as the list's own; the "Queue almost done"
  toast reshuffles the page you are on instead of navigating to your likes.
- **Shuffle Play on today's SoundCloud** — the likes engine had gone quiet on
  the current site and every run fell to the compatibility engine with one
  track queued. Four causes, four fixes, all verified live on public likes
  pages: SoundCloud pages a likes list through the mixed `/users/{id}/likes`
  endpoint (tracks and playlists), which the feed now answers alongside
  `track_likes`, minting later pages on the request the queue actually made
  and claiming only this profile's pagination; a signed-out listener's first
  play click opens the site's sign-in nudge instead of playing, so the seed
  closes the nudge its own click raised and presses again; the queue holds the
  page of likes the list had loaded (24, more if scrolled) ahead of the served
  pool and the seed is only the last rendered row, so playback now starts on
  the pool's first track through the queue panel instead of a skip off the
  seed, and the likes already on the page leave the pool (they'd be
  deduplicated anyway) so "N queued" and Up next say what will play; and since
  SoundCloud keeps that collection for the life of the page and holds each
  track once, a second shuffle on the same page reloads it and runs on arrival
  from the cached library (instant), with a fresh order every time. Also:
  `next_href` gets the page's `client_id` (page two answered 401 for a
  signed-out listener), and a feed run can no longer report "queued" before
  its first page was handed over.
- **The relay answers to the suite alone** — the extension's background worker
  fetches lyrics with the extension's own host permissions, and any script on
  soundcloud.com used to be able to ask it to. Requests now travel over a private
  channel: a detached element the shim shows the isolated-world bridge once, at
  `document_start` before any page script runs, and keeps in its closure; the
  bridge relays nothing that arrives any other way (window.postMessage is
  accepted only while no channel exists, i.e. a handshake that never completed),
  and the suite takes `GM_xmlhttpRequest` off the window as soon as it holds it.
  Verified live: an inline script first in `<head>` sees no offer, its
  postMessage request gets no answer, its own channel is never adopted, and
  lyrics still arrive.
- **Every label in your language** — a live collection of every string the
  English hub shows, checked against all eleven dictionaries, found labels no
  dictionary had at all (the coverage probe only flags keys left untranslated):
  tab and segment names, audio terms, the hotkey legend, the engine footnote,
  tint styles. 277 entries added across the eleven languages, each consistent
  with its dictionary's established wording; the Audio tab's jump chips are
  named after their sections ("Playback", "Stereo"), since "Play" and "Space"
  read as the play button and the spacebar once translated.
- **A second review, three fixes** — the per-track loudness pin is taken only
  on an element that plays and is released once the pinned element has been
  idle two seconds while another plays (a badge that changed before this
  track's element buffered used to leave the whole track unmeasured); the shim
  takes `dispatchEvent`, `CustomEvent`, the `detail` getter, `JSON` and
  `String` before any page script runs, so patched built-ins see none of the
  channel's traffic (the relay probe patches all four and sees nothing); token
  names are checked as own properties.
- **Your tokens leave the page** — the Genius API token and the ListenBrainz
  token used to sit in soundcloud.com's localStorage, readable by any script on
  the site. They now live in the extension's own storage (the one `storage`
  permission): the page holds a placeholder, and the background worker puts the
  token into a request only for that service's host, refusing it for any other.
  A token an older build kept in the page moves over on the first run and is
  removed from the page; the prompts never show it back. Verified live: the
  worker's fetch to api.genius.com carries the real token, the page's trail and
  storage never do.
- **Five more from the review** — listening stats kept in two tabs add up
  instead of overwriting each other (each tab merges its deltas into storage);
  another profile's cached library is cleared a week after its last shuffle
  (yours is kept); the clip guard's bypass is a detector input, so the level
  never steps when the guard engages or lets go (bypass is exact within a
  quarter second, by a 20 ms release); a chain the player has abandoned tells
  its limiter and onset worklets to stop instead of rendering silence forever.
- **Tap the tempo yourself** — when the reading is wrong, the Tap button beside
  the readout takes over: eight taps (or four and a pause) set this track's tempo
  from the median interval, remembered as tapped and never replaced by the
  detector; the beat dot follows it, and "Detect again" measures the track anew.
- **A dot on the beat** — beside the tempo readout a dot blinks on each beat and
  the stage's pulse backdrop swells on it. The phase comes from the onset
  envelope: over the last 12 s, the comb at a period within 1.5 % of the
  published tempo that gathers the most onset strength, refitted every 2 s and
  trusted only once two fits in a row land on the same beat within 25 ms; a
  track whose beat the comb cannot hold shows no clock. The output latency is
  added so the dot and the sound agree. Hidden under reduced motion.
- **No stranger's sheet on an unknown upload** — a candidate that only matched
  the title (a famous song's Genius page, a synced entry of the wrong length)
  could score 0.9 and render: the random lyrics on underground tracks. Every
  render now passes one gate: the artist agrees with a hint that did not come
  from a candidate (the title's own split, the uploader, the library,
  SoundCloud's metadata, an alias), the length agrees to a few seconds, or a
  confirmed candidate names the same song. Hints an anchor or the store lookup
  derived from candidates no longer vouch. Anything less is capped under every
  rendering floor, the trail says "unsure", and the "no lyrics" card names the
  same-title strangers with Search starting from the first.
- **Sing along on the stage** — a switch in the stage's Style popover softens the
  vocal band by 20 dB while the lyrics run full-screen; off, or leaving the
  stage, lifts it. The Vocals setting is never touched.
- **The musical key beside the tempo** — a chroma histogram from the audio
  matched against Temperley's key profiles (the Krumhansl–Schmuckler method),
  a bass-line tie-break between a major and its relative minor; named the
  musician's way and the DJ's (Camelot) on the Audio tab and in track info,
  remembered per track under "Detect tempo & key".
- **A pulse backdrop for the stage** — twelve soft blobs, one per spectrum band,
  breathing with the music behind the lyrics; a still frame under reduced motion.
- **The whole suite in your language** — every string the suite shows has an
  entry in all eleven languages (179 were missing after the stage, pins, pill
  and Tweaks waves), and a line built from parts, like “Queue · <track>” or
  “Focus mode: off”, is translated part by part. Lyric lines, track titles and
  artist names are never touched, tooltips included.
- **Twelve fixes from a full review** — the promo sweep could hide the player
  bar when a track was called “100% Royalty Free”; Enter on a hub button toggled
  playback; timestamps, playlist runtime and hidden banners stayed after their
  switch went off; the playing-chapter highlight sat on the wrong row; and
  eight smaller ones (see the commit for 4.71.0).
- **A wrapped line fills row by row** — the karaoke wipe paints the line's
  inline text span, so a two-row line fills its first row before its second
  starts (the block used to light every row from the left at once). Panel,
  stage and floating window alike.
- **A cleaner pill in the player bar** — one capsule tinted from the bar,
  round 26 px buttons, a hairline between the suite's buttons and the track
  tools, a floating label on hover, a focus ring, the hub button lit while the
  hub is open. Below SoundCloud's 960 px floor the bar and the title badge
  shrink so the pill never runs past the window edge.
- **The vocals decide how a sheet is read** — a sheet from a master of another
  length has two readings: as written, with a lag, or stretched by the ratio.
  It starts as written unless the upload says sped-up or slowed (the same
  master cut differently is far more common than an unlabelled tempo change);
  each look scores both readings on the vocals, and one a clear margin ahead
  on eight lines or more takes over the sheet and its cache entry. A finding
  agreed meanwhile does not close the question. The trail says why.
- **A sheet that is not these vocals says so** — two looks by the vocal
  aligner on a dozen lines each, and no clear lag either time, flag a synced
  sheet as doubtful: the source line reads "Not these vocals? tap to pick" and
  opens the search. A confirmed or picked sheet is never doubted.
- **Pin a line as it's sung** — the guess on a text-only sheet was measured on
  twenty rap tracks with real synced sheets: a median 7.5 s off; pins every
  eight lines bring it to 0.5 s, every four to 0.2 s. Every line grows a pin on
  hover; the source line reads Guessed timing, Vocal-guided or Pinned by you.
- **QQ Music word by word** — QQ's word-timed QRC sheets are decrypted in the
  page: the DES its client ships (Brad Conte's, two S-box typos and little-endian
  word order included) transliterated line for line and checked byte-exact
  against the compiled original, 3DES under the client's key, zlib via
  DecompressionStream. Each word carries its start and length, so the karaoke
  wipe runs word by word, as it does on Musixmatch richsync and NetEase yrc.
  The manual search shows up to four rows per catalog.
- **A line that lights a beat early** — the default highlight lead is 100 ms.
  ITU-R BT.1359 puts the detectability of a picture trailing its sound at
  45 ms and of one leading it at 125 ms, and the flip costs a frame or two, so
  an "exact" flip read as late. Lyrics ⋯ → Highlight timing keeps exact (0)
  and early (250 ms). The diagnostics report lists each voice's offset from
  the sheet.
- **Synced sheets, one-to-one with the voice** — the aligner's onset detector
  (a steady 300 ms of the vocal band, then a rise of 4 dB that holds 160 ms;
  its own 0.3 s lag measured against a right LRCLIB sheet and taken off)
  matches each voice heard after a pause to its line. Three matches set a
  provisional auto offset within the first verse; a look on twelve lines
  confirms or replaces it, and a stored finding is never second-guessed. A
  voice that comes up to 350 ms before its line's timestamp lights that line.
  The karaoke wipe runs over the sung part of a line (from its syllables) and
  holds, instead of crawling through the silence after it. A catalog that
  answers with no sheet for an entry is reported as "no sheet there", not as
  a failed route, and one query reaches each catalog once per search.
- **Text sheets that follow the voice** — on a sheet without timing (Genius),
  the aligner listens for a voice coming in after a pause (the vocal-band
  level steady for 500 ms, then a rise of 4 dB that holds — a drum hit does
  not) and pins the next line to it, starting with the first line after the intro; the
  source line says "Vocal-guided". A tap-along still wins, 0 clears it for the
  track, and Lyrics ⋯ → Vocal-guided timing turns it off. QQ Music is a fifth
  synced catalog (c.y.qq.com, u.y.qq.com), in every wave and the manual search.
- **Floating lyrics window** — **P** in the hub, ⋯ → Floating lyrics window,
  or Ctrl+K: a small always-on-top window (Document Picture-in-Picture,
  Chrome 116+) with the artwork behind a soft blur, the line before, the sung
  line and its wipe, the line after, a glowing progress bar and prev / play /
  next. It follows the same list the hub highlights: synced lines, or the
  estimated timing a text sheet gets (the hub's "Est. sync"), warped by any
  anchors you tapped. Space and ← → work inside it,
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
- **Tempo** — the BPM measured from the audio itself (spectral flux from a
  1024-point FFT in the audio worklet, autocorrelated, the estimates voting),
  shown whole in the Audio tab and the track-info popover, corrected for the
  playback speed and remembered per track (Tweaks → Player).
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
