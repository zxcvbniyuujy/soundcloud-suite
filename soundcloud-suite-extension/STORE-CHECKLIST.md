# Chrome Web Store — release checklist

Run through this before uploading. The goal: a clean, stable, policy-compliant
public listing.

## Build the public package

```sh
./build.sh --public --zip 4.69.0
```

`--public` refuses to build if any Genius token is present; `--zip` writes
`../soundcloud-suite-4.69.0.zip` containing only `manifest.json`, `icons/` and `js/`.
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
  - *Single purpose:* "Enhance the SoundCloud web player."
- The extension requests no `permissions` entries at all; all data stays in
  soundcloud.com's own browser storage.

## Stability notes (already handled)

- Every enhancer feature is isolated and try/caught; a stale SoundCloud
  selector makes a feature no-op rather than breaking the page.
- Visual features are pure CSS (reversible, can't break playback or layout).
- The script guards against double-injection and SPA re-renders.

## Nice-to-have before launch

- [ ] Take 3–5 screenshots (lyrics hub, themes, shuffle, settings).
- [ ] A 1–2 line store description plus a longer feature list.
- [ ] Decide a support contact / repo URL.
