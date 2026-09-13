#!/usr/bin/env bash
# SoundCloud SuperSuite — build / package the extension.
#
# Keeps js/suite.js, manifest.json, js/gm-shim.js and the suite's own VER
# fallback in lockstep, so the four version strings can never drift.
#
# Source of truth
#   If a standalone userscript exists (SC_SUITE_SRC, or a sibling
#   "soundcloud suite/soundcloud-suite.user.js" / "soundcloud-suite/…"), it is
#   copied into js/suite.js. If none is found, js/suite.js itself is the
#   source and the script runs in-place — that is the layout this repo ships.
#
# Token policy
#   The shipped source carries a BLANK Genius token (GTOK_DEFAULT = ''). A
#   personal token may live in tools/dev-token.txt (git-ignored); it is
#   injected only into a copied build, never into the tracked source, and
#   never into a --public build.
#
# Usage
#   ./build.sh                 sync versions, verify token policy, syntax-check
#   ./build.sh 4.52.0          also bump the version everywhere first
#   ./build.sh --public        refuse to build if any token is present
#   ./build.sh --zip           also write ../supersuite-<version>.zip for the store
#   ./build.sh --public --zip 4.52.0
set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="$EXT_DIR/js/suite.js"
MANIFEST="$EXT_DIR/manifest.json"
SHIM="$EXT_DIR/js/gm-shim.js"
SCRIPTS=(js/gm-shim.js js/bridge.js js/background.js js/suite.js)

fail() { echo "✗ $*" >&2; exit 1; }
note() { echo "• $*"; }

# in-place sed that works with both GNU sed (-i) and BSD/macOS sed (-i '')
sedi() {
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}

PUBLIC=0; ZIP=0; NEWV=""
for a in "$@"; do
  case "$a" in
    --public) PUBLIC=1 ;;
    --zip) ZIP=1 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) fail "unknown flag: $a" ;;
    *) [ -z "$NEWV" ] || fail "unexpected argument: $a"; NEWV="$a" ;;
  esac
done

# ── locate the source userscript ─────────────────────────────────────────────
IN_PLACE=0
if [ -n "${SC_SUITE_SRC:-}" ]; then
  [ -f "$SC_SUITE_SRC" ] || fail "SC_SUITE_SRC does not exist: $SC_SUITE_SRC"
  SRC="$SC_SUITE_SRC"
elif [ -f "$EXT_DIR/../soundcloud suite/soundcloud-suite.user.js" ]; then
  SRC="$EXT_DIR/../soundcloud suite/soundcloud-suite.user.js"
elif [ -f "$EXT_DIR/../soundcloud-suite/soundcloud-suite.user.js" ]; then
  SRC="$EXT_DIR/../soundcloud-suite/soundcloud-suite.user.js"
else
  SRC="$DST"; IN_PLACE=1
  note "no external userscript found — building js/suite.js in place"
fi
SRC_DIR="$(cd "$(dirname "$SRC")" && pwd)"
SRC="$SRC_DIR/$(basename "$SRC")"
DEV_TOKEN_FILE="$SRC_DIR/tools/dev-token.txt"
[ -f "$DEV_TOKEN_FILE" ] || DEV_TOKEN_FILE="$EXT_DIR/tools/dev-token.txt"

# ── optional version bump (strict N.N.N — also guards the sed patterns) ──────
if [ -n "$NEWV" ]; then
  printf '%s' "$NEWV" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || fail "version must be N.N.N (got: $NEWV)"
  sedi "s/^\/\/ @version      [0-9][0-9.]*/\/\/ @version      $NEWV/" "$SRC"
  note "userscript @version → $NEWV"
fi

# ── copy + sync every version string ─────────────────────────────────────────
VER="$(grep -m1 '^// @version' "$SRC" | awk '{print $3}')"
[ -n "$VER" ] || fail "could not read @version from $SRC"
if [ "$IN_PLACE" = "0" ]; then cp "$SRC" "$DST"; fi
sedi "s/\"version\": \"[0-9][0-9.]*\"/\"version\": \"$VER\"/" "$MANIFEST"
sedi "s/version: '[0-9][0-9.]*' }/version: '$VER' }/" "$SHIM"
# the suite's last-resort fallback when no GM_info is present at all
sedi "s/^\(    const VER = .*\)|| '[0-9][0-9.]*';$/\1|| '$VER';/" "$DST"
note "manifest · gm-shim · suite fallback → v$VER"

# ── token policy ─────────────────────────────────────────────────────────────
BLANK_TOKEN="^  const GTOK_DEFAULT = '';$"
grep -q "$BLANK_TOKEN" "$SRC" \
  || fail "refusing to build: $SRC has a non-blank GTOK_DEFAULT — keep the source token-free; use tools/dev-token.txt for local injection."

if [ "$PUBLIC" = "1" ]; then
  grep -q "$BLANK_TOKEN" "$DST" \
    || fail "PUBLIC build aborted: $DST carries a token that is not in the source — refusing to ship."
  note "PUBLIC build · verified blank Genius token in source and build ✓"
elif [ -f "$DEV_TOKEN_FILE" ]; then
  if [ "$IN_PLACE" = "1" ]; then
    note "dev-token present but the build is in place — not injecting into the tracked source (copy the userscript out, or set SC_SUITE_SRC)"
  else
    DEV_TOKEN="$(head -n1 "$DEV_TOKEN_FILE" | tr -d '[:space:]')"
    if [ -n "$DEV_TOKEN" ]; then
      ESCAPED="$(printf '%s' "$DEV_TOKEN" | sed 's/[&/\]/\\&/g')"
      sedi "s/$BLANK_TOKEN/  const GTOK_DEFAULT = '$ESCAPED';/" "$DST"
      note "DEV build · injected dev-token into js/suite.js (source stays blank) ✓"
    fi
  fi
fi

# ── syntax check (node → macOS JXA → skip) ───────────────────────────────────
note "syntax check:"
for f in "${SCRIPTS[@]}"; do
  if command -v node >/dev/null 2>&1; then
    node --check "$EXT_DIR/$f" && echo "    $f → OK"
  elif command -v osascript >/dev/null 2>&1; then
    osascript -l JavaScript -e "ObjC.import('Foundation');
      const c = ObjC.unwrap(\$.NSString.stringWithContentsOfFileEncodingError('$EXT_DIR/$f', \$.NSUTF8StringEncoding, null));
      let o; try { (0, eval)(c); o = 'OK'; } catch (e) { o = (e instanceof SyntaxError) ? ('SYNTAX ERROR: ' + e.message) : 'OK'; }
      '    $f → ' + o;" 2>/dev/null || echo "    $f — check skipped"
  else
    echo "    $f — no node or osascript, check skipped"
  fi
done

# ── manifest must parse ──────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  node -e "const m=require('$MANIFEST'); if(m.version!=='$VER') process.exit(1); console.log('• manifest.json valid · v'+m.version)"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "import json,sys; m=json.load(open('$MANIFEST')); sys.exit(0 if m['version']=='$VER' else 1); print('• manifest.json valid · v'+m['version'])"
else
  note "manifest.json not validated (no node/python3)"
fi

# ── optional store zip (dev files excluded) ──────────────────────────────────
if [ "$ZIP" = "1" ]; then
  OUT="$EXT_DIR/../supersuite-$VER.zip"
  rm -f "$OUT"
  ( cd "$EXT_DIR" && zip -qr "$OUT" manifest.json icons js -x '*/.*' '.*' )
  note "store package → $OUT"
fi
echo "✓ build complete — reload the extension in chrome://extensions"
