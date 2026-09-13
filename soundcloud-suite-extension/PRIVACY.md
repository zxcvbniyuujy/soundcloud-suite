# SoundCloud SuperSuite — Privacy Policy

_Last updated: 2026._

SoundCloud SuperSuite is a browser extension that enhances soundcloud.com. Your
privacy is simple here: **the extension has no servers and collects nothing.**

## What it stores
All settings, listening stats, the lyric cache, blocklists and your shuffle
library cache are stored **locally in your own browser** (via the browser's
storage and IndexedDB). None of it is transmitted to us — we don't have a
server, an account system, or any analytics.

## What it sends, and to whom
To show lyrics, the extension fetches lyric data **directly from public lyric
providers** on your behalf, only for the track you're playing or searching:

- lrclib.net, genius.com, api.genius.com, itunes.apple.com,
  apic-desktop.musixmatch.com, music.163.com, lyrics.kugou.com, krcs.kugou.com,
  api.lyrics.ovh — lyric/metadata lookups
- html.duckduckgo.com, www.bing.com, www.mojeek.com — web search used to find
  the correct lyric page
- web.archive.org, api.allorigins.win, api.codetabs.com — read-only mirrors
  used to fetch a lyric page when the direct site is blocked
- api.listenbrainz.org — **only** if you add your own ListenBrainz token to
  scrobble plays (off by default)
- api-v2.soundcloud.com / soundcloud.com — to read the playing track's public
  metadata

These requests contain only the song's title/artist (or the URL you're
viewing). Cookies are **not** sent to third-party lyric hosts. No personal
identifiers are added.

## Optional tokens you provide
- **Genius API token** and **ListenBrainz token** are optional, stored locally,
  and used only to call those services' own APIs. They are never sent anywhere
  else.

## Permissions, and why
- Host access to soundcloud.com — to run the enhancer on the site.
- Host access to the lyric providers above — to fetch lyrics.
- `storage` / `unlimitedStorage` — to cache lyrics and settings locally.

## No tracking
No analytics, no telemetry, no ads, no third-party tracking, no sale of data.

## Contact
This is an open userscript/extension. Questions: open an issue wherever you
obtained it.
