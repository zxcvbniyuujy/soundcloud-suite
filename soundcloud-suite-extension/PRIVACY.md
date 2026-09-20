# SoundCloud SuperSuite — Privacy Policy

_Last updated: 20 September 2026._

SoundCloud SuperSuite is a browser extension that enhances soundcloud.com.
**The extension has no servers and collects nothing.**

## What it stores

All settings, listening stats, the lyric cache, blocklists and the shuffle
library cache are stored **locally in your own browser**, inside
soundcloud.com's localStorage and IndexedDB. None of it is transmitted to us.
There is no server, no account system and no analytics.

## What it sends, and to whom

To show lyrics, the extension fetches lyric data **directly from public lyric
providers** on your behalf: for the track you are playing or searching, for the
next track in your queue, and (unless you turn off "Pre-warm on hover" in
Tweaks) for a track whose link you hover over, so its lyrics are ready before
you press play. Every request goes over HTTPS.

- lrclib.net, genius.com, api.genius.com, itunes.apple.com,
  apic-desktop.musixmatch.com, music.163.com, lyrics.kugou.com, krcs.kugou.com,
  api.lyrics.ovh — lyric and metadata lookups
- html.duckduckgo.com, www.bing.com, www.mojeek.com — web search used to find
  the correct lyric page
- web.archive.org, api.allorigins.win, api.codetabs.com — read-only mirrors
  used to fetch a lyric page when the direct site is blocked
- translate.googleapis.com — **only** while you have Translate switched on in
  the ⋯ menu; each line of the current lyrics is then sent for translation
- api.listenbrainz.org — **only** if you add your own ListenBrainz token to
  scrobble plays (off by default)
- api-v2.soundcloud.com / soundcloud.com — to read the playing track's public
  metadata

These requests contain only the song's title and artist (or the URL you are
viewing). Requests to third-party hosts are made **without cookies**. No
personal identifiers are added.

## Optional tokens you provide

A **Genius API token** and a **ListenBrainz token** are optional, stored
locally, and used only to call those services' own APIs. They are never sent
anywhere else, and the extension ships without any built-in token.

## Permissions, and why

- Host access to soundcloud.com — to run the enhancer on the site.
- Host access to the lyric providers above — to fetch lyrics.

The extension requests no other permissions.

## No tracking

No analytics, no telemetry, no ads, no third-party tracking, no sale of data.

## Contact

This is an open-source extension. Questions: open an issue wherever you
obtained it.
