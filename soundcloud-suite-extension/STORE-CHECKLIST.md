# Chrome Web Store — release checklist

Run through this before uploading. The goal: a clean, stable, policy-compliant
public listing.

## Build the public package

```sh
./build.sh --public --zip 4.83.0
```

`--public` refuses to build if any Genius token is present; `--zip` writes
`../soundcloud-suite-4.83.0.zip` containing `manifest.json`, `icons/`, `js/`,
`_locales/` (the store name and summary in twelve languages) and `i18n/` (the
in-app dictionaries), and nothing else — no tools, docs or dotfiles.
Upload it at https://chrome.google.com/webstore/devconsole

## MUST verify before upload

- [ ] **Genius token blank** — `grep "GTOK_DEFAULT = " js/suite.js` shows `''`.
      (`--public` enforces this; never upload a personal token.)
- [ ] **No remote code** — all logic is bundled. The shuffle Web Worker is built
      from an inline string (allowed); lyric sites return *data*, never executed.
- [ ] Icons present (16/32/48/128) and the listing screenshots taken.
- [ ] Versions match: `manifest.json`, userscript `@version`, What's-New
      (`build.sh` syncs the first two plus the shim and the suite's fallback).
- [ ] All four scripts pass the syntax check (`build.sh` runs it).

## Store listing fields

- **Category:** Productivity (or Entertainment).
- **Privacy policy URL:** host `PRIVACY.md` somewhere public (a GitHub repo or
  Pages site) and paste the link. The store requires this because the
  extension uses host permissions.
- **Permission justifications** (the reviewer asks for each):
  - *Host permission soundcloud.com* — the extension's entire purpose is to
    enhance soundcloud.com (themes, player tools, lyrics, shuffle).
  - *Host permissions for lyric providers* — fetch lyrics for the playing track
    directly from public lyric APIs, without cookies; no proxying of user data.
    The background worker only serves the extension's own content script and
    only for the allowlisted hosts.
  - *`storage`* — the extension's own storage holds only the optional tokens
    the user enters (a Genius API token, a ListenBrainz token), so they never
    sit in the page's storage where site scripts could read them. Nothing else
    is stored there.
  - *Single purpose:* "Enhance the SoundCloud web player."
- The only `permissions` entry is `storage` (above); everything else stays in
  soundcloud.com's own browser storage.

## Stability notes (already handled)

- Every enhancer feature is isolated and try/caught; a stale SoundCloud
  selector makes a feature no-op rather than breaking the page.
- Visual features are pure CSS (reversible, can't break playback or layout).
- The script guards against double-injection and SPA re-renders.

## Listing assets (all in `store/`, regenerated with `tools/store/shots.js` then `tools/store/compose.js`)

- [x] Five 1280×800 screenshots: lyrics, audio, shuffle, themes, player tools.
- [x] Small promo tile 440×280 and marquee 1400×560.
- [x] Store icon 128×128 (`store-icon-128.png`; the same mark as `icons/`).
- [x] `store/description.txt` (the long description) and `store/listing.md` (every dashboard field, ready to paste).
- [x] Homepage and support URLs: the GitHub repository and its issues page.

## Before you press Publish

- [ ] Merge this branch to `main` so the privacy policy link in `listing.md` (the `main` row) resolves; until then use the branch row.
- [ ] Upload the zip `build.sh --public --zip` wrote (the one whose version matches `manifest.json`).
- [ ] Paste the fields from `store/listing.md`: summary, description, category, privacy tab (single purpose, permission justifications, data usage, certifications), test instructions.
- [ ] Upload the five screenshots in the listed order and both promo tiles.
- [ ] Revoke any Genius API token that was ever committed to the repository's history (the build refuses a non-blank one, but the old value is still in git history until revoked).
