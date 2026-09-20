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
| Single purpose | Enhance the SoundCloud web player: synced lyrics, audio processing, full-library shuffle and page themes on soundcloud.com. |
| Privacy policy URL | https://github.com/zxcvbniyuujy/soundcloud-suite/blob/main/soundcloud-suite-extension/PRIVACY.md (valid once this branch is merged to main; until then use the branch URL) |
| Host permission justification: soundcloud.com | The extension's entire purpose is to enhance soundcloud.com pages and its player. |
| Host permission justification: lyric providers (lrclib.net, genius.com, itunes.apple.com, apic-desktop.musixmatch.com, api.lyrics.ovh, krcs.kugou.com, lyrics.kugou.com, music.163.com, html.duckduckgo.com, www.bing.com, www.mojeek.com, web.archive.org, api.allorigins.win, api.codetabs.com) | Fetches lyrics and lyric-search results for the track that is playing. Requests carry no cookies and are made only from the extension's own content script for these allowlisted hosts. |
| Host permission justification: api.listenbrainz.org | Optional scrobbling of listened tracks to the user's own ListenBrainz account, only when the user enters their token. |
| Host permission justification: translate.googleapis.com | Optional line-by-line lyric translation, only while the user has Translate switched on. |
| Remote code | No. All logic ships in the package; the shuffle and proof-of-work workers are built from inline strings. Lyric sites return data, never code. |
| Data usage | Collects no user data. Everything is stored locally in the browser. |

## Distribution

| Field | Value |
|---|---|
| Visibility | Public |
| Regions | All regions |
| Pricing | Free |

## Not affiliated

The description ends with the disclosure that the project is independent of SoundCloud and that the name and logo are used with permission. Keep it: reviewers look for it when a listing carries a third-party brand.
