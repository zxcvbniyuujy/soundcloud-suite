# Chrome Web Store listing — SoundCloud Suite

Paste these into the developer dashboard. Files referenced are in this folder.

## Store listing

| Field | Value |
|---|---|
| Name (from manifest) | SoundCloud Suite |
| Summary (from manifest, 130 chars) | All-in-one SoundCloud upgrade: themes & declutter, player tools, studio-grade audio, a synced-lyrics hub and full-library shuffle. |
| Description | `description.txt` (3,412 characters) |
| Category | Entertainment |
| Language | English (United States) |
| Store icon (128×128) | `store-icon-128.png` |
| Screenshots (1280×800, in this order) | `screenshot-1-lyrics.png`, `screenshot-2-audio.png`, `screenshot-3-themes.png`, `screenshot-4-tools.png`, `screenshot-5-tweaks.png` |
| Small promo tile (440×280) | `promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `promo-marquee-1400x560.png` |
| Global promo video | none |

## Additional fields

| Field | Value |
|---|---|
| Official URL | none (needs a Search Console verified site; leave unset) |
| Homepage URL | https://github.com/zxcvbniyuujy/soundcloud-suite |
| Support URL | https://github.com/zxcvbniyuujy/soundcloud-suite/issues |
| Mature content | No |

## Privacy tab

| Field | Value |
|---|---|
| Single purpose description | Enhance the SoundCloud web player: synced lyrics, audio processing, full-library shuffle and page themes on soundcloud.com. |
| Host permission justification (994 chars) | soundcloud.com and *.soundcloud.com: the extension runs only on the SoundCloud web player and enhances it. Every other host is a read-only data source for the synced-lyrics feature, fetched without cookies by the background worker for the extension's own content script only; any other host is refused. lrclib.net, genius.com, apic-desktop.musixmatch.com, api.lyrics.ovh, krcs.kugou.com, lyrics.kugou.com, music.163.com: lyric providers queried for the playing track. itunes.apple.com: canonical title and artist lookup. html.duckduckgo.com, www.bing.com, www.mojeek.com: find a lyrics page when no provider has the track. web.archive.org, api.allorigins.win, api.codetabs.com: fallback readers for lyric pages that block direct fetches. api.listenbrainz.org: optional scrobbling to the user's own ListenBrainz account, only with a token the user enters. translate.googleapis.com: optional lyric translation, only while the user switches it on. Responses are treated as data and never executed. |
| Remote code | No, I am not using Remote code |
| Data usage: what is collected | Website content only (the playing track's title and artist are sent to the lyric providers; lyric lines go to Google Translate only while Translate is on). Nothing else is checked. |
| Certifications | All three checked |
| Privacy policy URL (now) | https://github.com/zxcvbniyuujy/soundcloud-suite/blob/claude/focused-tesla-p6n356/soundcloud-suite-extension/PRIVACY.md |
| Privacy policy URL (after merging to main) | https://github.com/zxcvbniyuujy/soundcloud-suite/blob/main/soundcloud-suite-extension/PRIVACY.md |

## Distribution

| Field | Value |
|---|---|
| Visibility | Public |
| Regions | All regions |
| Pricing | Free |

## Not affiliated

The description ends with the disclosure that the project is independent of SoundCloud and that the name and logo are used with permission. Keep it: reviewers look for it when a listing carries a third-party brand.
