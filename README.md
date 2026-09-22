# SoundCloud Suite

A Chrome extension for the SoundCloud web player: synced lyrics, a studio-grade
audio chain, a shuffle that reaches your whole likes library, dark themes and
player tools. It runs entirely in your browser and sends nothing to us.

The extension lives in [`soundcloud-suite-extension/`](soundcloud-suite-extension/):

- [README](soundcloud-suite-extension/README.md) — every feature, how to load it
  from source, how it is built and tested.
- [PRIVACY](soundcloud-suite-extension/PRIVACY.md) — what leaves the browser, to
  whom, and why (the privacy policy the store listing links to).
- [SECURITY](SECURITY.md) — how to report a vulnerability privately.
- [Store checklist](soundcloud-suite-extension/STORE-CHECKLIST.md) — how a release
  is packaged and what is verified before upload.

## Install

From the Chrome Web Store once the listing is live, or from source: clone the
repository, open `chrome://extensions`, turn on Developer mode, choose
**Load unpacked** and pick `soundcloud-suite-extension/`. Then open
soundcloud.com and press **Alt+L**.

## Bugs and ideas

Open an [issue](https://github.com/zxcvbniyuujy/soundcloud-suite/issues/new/choose).
For bugs, the hub's debug log (Tweaks → Data → Debug log → Copy) says which
request or selector gave up and contains no tokens.
