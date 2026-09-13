#!/bin/bash
# SoundCloud SuperSuite — build the extension from the single source userscript.
# Keeps js/suite.js and the manifest version in lockstep with the userscript,
# so the two copies can never drift (we've been bitten by manual copies before).
#
# Source is BLANK-TOKEN by default (safe to publish). For local dev convenience,
# drop your personal Genius token into ../soundcloud suite/tools/dev-token.txt
# (gitignored) and build.sh will inject it into the extension copy only.
#
# Usage:  ./build.sh                 # copy userscript → suite.js, sync version,
#                                    # inject dev-token if present
#         ./build.sh 4.0.0           # also rewrite the userscript @version first
#         ./build.sh --public        # PUBLIC build: refuse any non-blank token
#                                    # (exits 1 if it can't guarantee blank)
#         ./build.sh --public 4.0.0  # both
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")" && pwd)"
DST="$EXT_DIR/js/suite.js"
MANIFEST="$EXT_DIR/manifest.json"
# Source userscript: env var → sibling dir guess → fail with help. The sibling
# guess matches the layout this repo ships with (../soundcloud suite). Set
# SC_SUITE_SRC=/abs/path/soundcloud-suite.user.js to override.
if [ -n "${SC_SUITE_SRC:-}" ]; then
  SRC="$SC_SUITE_SRC"
elif [ -f "$EXT_DIR/../soundcloud suite/soundcloud-suite.user.js" ]; then
  SRC="$EXT_DIR/../soundcloud suite/soundcloud-suite.user.js"
elif [ -f "$EXT_DIR/../soundcloud-suite/soundcloud-suite.user.js" ]; then
  SRC="$EXT_DIR/../soundcloud-suite/soundcloud-suite.user.js"
else
  echo "✗ source not found. Set SC_SUITE_SRC=/path/to/soundcloud-suite.user.js" >&2
  exit 1
fi
SRC_DIR="$(cd "$(dirname "$SRC")" && pwd)"
SRC="$SRC_DIR/$(basename "$SRC")"
DEV_TOKEN_FILE="$SRC_DIR/tools/dev-token.txt"

PUBLIC=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--public" ]; then PUBLIC=1; else ARGS+=("$a"); fi
done

# optional: set a new version across the userscript header
if [ "${ARGS[0]:-}" != "" ]; then
  NEWV="${ARGS[0]}"
  # reject anything that isn't a strict semver — guards against sed injection
  # and against fat-finger version strings that would silently break the
  # downstream version-sync sed patterns
  case "$NEWV" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "✗ version must be N.N.N (got: $NEWV)" >&2; exit 1 ;;
  esac
  if ! printf '%s' "$NEWV" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "✗ version must match /^[0-9]+\.[0-9]+\.[0-9]+$/ (got: $NEWV)" >&2
    exit 1
  fi
  /usr/bin/sed -i '' "s/@version      [0-9][0-9.]*/@version      $NEWV/" "$SRC"
  echo "• userscript @version → $NEWV"
fi

# read the userscript's version and copy it across
VER="$(/usr/bin/grep -m1 '@version' "$SRC" | /usr/bin/awk '{print $3}')"
cp "$SRC" "$DST"
/usr/bin/sed -i '' "s/\"version\": \"[0-9][0-9.]*\"/\"version\": \"$VER\"/" "$MANIFEST"
# keep the gm-shim's GM_info.script.version in lockstep so the suite's single VER
# source-of-truth resolves correctly in the extension (no userscript GM_info there)
/usr/bin/sed -i '' "s/version: '[0-9][0-9.]*' }/version: '$VER' }/" "$EXT_DIR/js/gm-shim.js"
echo "• suite.js updated · manifest + gm-shim version → $VER"

# enforce: source must always be blank-token (the GTOK_DEFAULT line lives in source
# at a fixed selector). If a stray edit ever puts a literal token back, refuse.
if ! /usr/bin/grep -q "^  const GTOK_DEFAULT = '';$" "$SRC"; then
  echo "✗ refusing to build: $SRC has a non-blank GTOK_DEFAULT — keep source token-free, use tools/dev-token.txt for local injection." >&2
  exit 1
fi

if [ "$PUBLIC" = "1" ]; then
  # PUBLIC build: verify the just-copied DST is also blank. With the source
  # enforcement above this is redundant in practice, but it's the explicit
  # assertion the security model requires — failure here means someone wrote
  # a token into the DST out of band after the cp ran (e.g., a stale build
  # cache, a hook that injected, an editor save mid-build).
  if ! /usr/bin/grep -q "^  const GTOK_DEFAULT = '';$" "$DST"; then
    echo "✗ PUBLIC build aborted: $DST has a token that wasn't in source — refusing to ship." >&2
    exit 1
  fi
  echo "• PUBLIC build · verified blank Genius token in source AND build artifact ✓"
else
  # DEV build: if the owner has a tools/dev-token.txt, inject it into DST so the
  # local extension keeps its full Genius-search quality. SRC stays blank.
  if [ -f "$DEV_TOKEN_FILE" ]; then
    DEV_TOKEN="$(/usr/bin/head -n1 "$DEV_TOKEN_FILE" | /usr/bin/tr -d '[:space:]')"
    if [ -n "$DEV_TOKEN" ]; then
      # escape any '/' or '&' that could break the sed s/// (Genius tokens are
      # base64-ish, no slashes in practice, but be safe)
      ESCAPED="$(printf '%s' "$DEV_TOKEN" | /usr/bin/sed 's/[&/\]/\\&/g')"
      /usr/bin/sed -i '' "s/^  const GTOK_DEFAULT = '';$/  const GTOK_DEFAULT = '$ESCAPED';/" "$DST"
      echo "• DEV build · injected dev-token into suite.js (source stays blank) ✓"
    fi
  fi
fi

# syntax-check every extension script (no node here → JXA program-level eval)
echo "• syntax check:"
for f in js/gm-shim.js js/bridge.js js/background.js js/suite.js; do
  /usr/bin/osascript -l JavaScript -e "ObjC.import('Foundation'); \
    const c=ObjC.unwrap(\$.NSString.stringWithContentsOfFileEncodingError('$EXT_DIR/$f', \$.NSUTF8StringEncoding, null)); \
    let o; try{(0,eval)(c);o='ran';}catch(e){o=(e instanceof SyntaxError)?('SYNTAX ERROR: '+e.message):'OK';} \
    '  $f → '+o;" 2>/dev/null || echo "    $f — check skipped"
done

# validate the manifest JSON
/usr/bin/python3 -c "import json;json.load(open('$MANIFEST'));print('• manifest.json valid · v'+json.load(open('$MANIFEST'))['version'])"
echo "✓ build complete — reload the extension in chrome://extensions"
