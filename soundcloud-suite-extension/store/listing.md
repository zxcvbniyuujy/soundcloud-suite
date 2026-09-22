# Chrome Web Store listing — SoundCloud Suite

Paste these into the developer dashboard. Files referenced are in this folder.

## Store listing

| Field | Value |
|---|---|
| Name (from manifest) | SoundCloud Suite |
| Summary (from the manifest's `_locales`, 117 chars, shown by the store in the user's language) | Synced lyrics, studio-grade audio, full-library shuffle, ad skipping and a cleaner look for the SoundCloud web player. |
| Description | `description.txt` (4,569 characters; the limit is 16,000) |
| Category | Entertainment |
| Language | English (United States) |
| Store icon (128×128) | `store-icon-128.png` |
| Screenshots (1280×800, in this order) | `screenshot-1-lyrics.png`, `screenshot-2-audio.png`, `screenshot-3-shuffle.png`, `screenshot-4-themes.png`, `screenshot-5-tools.png` |
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
| Host permission justification (983 chars) | soundcloud.com, *.soundcloud.com: the extension runs only on the SoundCloud player. Every other host is a read-only data source for the lyrics feature, fetched without cookies by the background worker for the extension's own content script; any other host is refused. lrclib.net, genius.com, apic-desktop.musixmatch.com, api.lyrics.ovh, krcs.kugou.com, lyrics.kugou.com, music.163.com, c.y.qq.com, u.y.qq.com: lyric providers queried for the playing track. itunes.apple.com: canonical title and artist lookup. html.duckduckgo.com, www.bing.com, www.mojeek.com: find a lyrics page when no provider has the track. web.archive.org, api.allorigins.win, api.codetabs.com: fallback readers for lyric pages that block direct fetches. api.listenbrainz.org: optional scrobbling to the user's own ListenBrainz account, only with a token the user enters. translate.googleapis.com: optional lyric translation, only while the user switches it on. Responses are treated as data and never executed. |
| Permission justification: storage | Holds only the optional tokens the user enters (a Genius API token, a ListenBrainz token) in the extension's own storage, so they never sit in the page's storage where site scripts could read them. The background worker puts a token into a request only for that service's host. Nothing else is stored there. |
| Remote code | No, I am not using Remote code |
| Data usage: what is collected | Website content only (the playing track's title and artist are sent to the lyric providers; lyric lines go to Google Translate only while Translate is on). Nothing else is checked. |
| Certifications | All three checked |
| Privacy policy URL (now) | https://github.com/zxcvbniyuujy/soundcloud-suite/blob/claude/focused-tesla-p6n356/soundcloud-suite-extension/PRIVACY.md |
| Privacy policy URL (after merging to main) | https://github.com/zxcvbniyuujy/soundcloud-suite/blob/main/soundcloud-suite-extension/PRIVACY.md |

## Test instructions tab

| Field | Value |
|---|---|
| Username / Password | Leave empty. Everything can be exercised signed out: lyrics, audio, themes, and Shuffle Play on any public likes page. |
| Additional instructions (≈560 chars) | No login needed. 1) Open https://soundcloud.com/rexorangecounty/best-friend and press play; if SoundCloud shows its sign-in prompt on the first play, close it and press play again. Dismiss the one-time welcome card. 2) Press Alt+L (or the note icon in the player bar): the hub opens with synced lyrics that follow the song. 3) Audio tab: drag the EQ curve, switch on Enhance, hold Compare to hear the original. 4) Tweaks tab: pick a theme. 5) Shuffle: open https://soundcloud.com/flume/likes and press the "Shuffle Play" button next to the Likes tab; the whole library is queued in a fresh order and playback starts. |

## Distribution

| Field | Value |
|---|---|
| Visibility | Public |
| Regions | All regions |
| Pricing | Free |

## Not affiliated

The description ends with the disclosure that the project is independent of SoundCloud and that the name and logo are used with permission. Keep it: reviewers look for it when a listing carries a third-party brand.
