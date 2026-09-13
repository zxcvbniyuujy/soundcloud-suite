# Chrome Web Store — release checklist

Run through this before uploading. The goal: a clean, stable, policy-compliant
public listing.

## Build the public package
```sh
./build.sh --public 4.0.0      # strips the personal Genius token, syncs version
```
Then zip the folder **excluding** dev files:
```sh
cd /Users/x/Downloads/soundcloud-suite-extension
zip -r ../supersuite-4.0.0.zip . -x "build.sh" "*.md" ".*" "*/.*"
```
Upload `supersuite-4.0.0.zip` at https://chrome.google.com/webstore/devconsole

## MUST verify before upload
- [ ] **Genius token stripped** — `grep "GTOK_DEFAULT" js/suite.js` shows `''`.
      (The `--public` build does this; never upload your personal token.)
- [ ] **No remote code** — all logic is bundled. The shuffle Web Worker is built
      from an inline string (allowed); lyric sites return *data*, never executed.
- [ ] Icons present (16/32/48/128) and the listing screenshots taken.
- [ ] Versions match: `manifest.json`, userscript `@version`, What's-New.
- [ ] All four scripts pass the syntax check (build.sh runs it).

## Store listing fields
- **Category:** Productivity (or Entertainment).
- **Privacy policy URL:** host `PRIVACY.md` somewhere public (e.g. a GitHub
  repo / Pages) and paste the link — the store requires this because the
  extension uses host permissions.
- **Permission justifications** (the reviewer asks for each):
  - *Host permission soundcloud.com* — the extension's entire purpose is to
    enhance soundcloud.com (themes, player tools, lyrics, shuffle).
  - *Host permissions for lyric providers* — fetch lyrics for the playing track
    directly from public lyric APIs; no proxying of user data.
  - *storage / unlimitedStorage* — cache lyrics and settings locally so the
    extension is fast and works offline-ish; nothing leaves the device.
  - *Single purpose:* "Enhance the SoundCloud web player."

## Stability notes (already handled)
- Every enhancer feature is isolated + try/caught; a stale SoundCloud selector
  makes a feature no-op rather than breaking the page.
- Visual features are pure CSS (reversible, can't break playback/layout).
- The script guards against double-injection and SPA re-renders.

## Nice-to-have before launch
- [ ] Take 3–5 screenshots (lyrics panel, themes, shuffle, enhancer settings).
- [ ] A 1–2 line store description + a longer feature list.
- [ ] Decide a support contact / repo URL.
