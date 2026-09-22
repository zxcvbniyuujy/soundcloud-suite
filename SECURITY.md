# Security

SoundCloud Suite runs entirely in your browser: no server, no account, no
analytics. The parts worth scrutiny are the ones that touch other origins, and
they are documented in
[`soundcloud-suite-extension/PRIVACY.md`](soundcloud-suite-extension/PRIVACY.md):
the background worker's relay (which answers only the extension's own content
script, over a private channel page scripts cannot reach, and only for the
listed hosts), the optional tokens kept in the extension's storage, and the
calls made to SoundCloud's own API with the page's own session.

## Reporting a vulnerability

If you find a way for a page script to use the relay, read a token, reach a
host outside the list, or make the extension send anything it should not,
please report it privately rather than in a public issue: open a
[private security advisory](https://github.com/zxcvbniyuujy/soundcloud-suite/security/advisories/new)
on this repository. Include the SoundCloud page, the extension version (the
hub's "What's new in v…" item) and the steps; a debug log (hub → Tweaks →
Data → Debug log → Copy) helps and contains no tokens.

Reports about SoundCloud itself belong with SoundCloud.

## What a fix looks like

Security fixes ship as a normal store update with a What's new card that says
what was wrong and what changed, the way the relay hardening and the token
move did.
