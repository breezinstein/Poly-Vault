#!/bin/sh
# Re-roots a Mesh2Motion production build (dist/) under a URL prefix.
#
#   sh scripts/m2m-rebase.sh <dist-dir> [/rig]
#
# Upstream builds with base './', so bundle and asset URLs are already relative.
# What is left are a handful of root-absolute references in HTML, CSS and JS
# (nav links, /images/ icons, /desktop.css). Each top-level entry of dist/ is
# rewritten only when it appears right after a quote, backtick, "(" or "=",
# so unrelated strings are untouched. The Google Fonts stylesheet is removed:
# the strict CSP blocks off-site requests and the UI falls back to system fonts.
set -eu
DIST="$1"
PREFIX="${2:-/rig}"
cd "$DIST"

NAMES=""
for entry in *; do
  NAMES="${NAMES:+$NAMES|}$(printf '%s' "$entry" | sed 's/[.]/\\./g')"
done

find . -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' \) | while read -r f; do
  sed -i -E "s#([\"'\`(=])/(($NAMES)([/\"'\`)?#]|\$))#\\1$PREFIX/\\2#g" "$f"
done

# Poly Vault bridge (hand-off + "Save to vault"), when bundled next to the pages.
if [ -f pv-bridge.js ]; then
  find . -type f -name '*.html' -exec sed -i "s#</body>#<script src=\"$PREFIX/pv-bridge.js\"></script></body>#" {} +
fi

# Bare links to the app root ("Explore") point at the prefix root.
find . -type f -name '*.html' -exec sed -i -E "s#href=\"/\"#href=\"$PREFIX/\"#g" {} +
find . -type f -name '*.html' -exec sed -i -E '/fonts\.(googleapis|gstatic)\.com/d' {} +
find . -type f -name '*.css' -exec sed -i -E 's#@import ?(url\()?"?https://fonts\.googleapis\.com/[^;]*;##g' {} +

# Report anything root-absolute that is still left (should be empty).
# (find -exec instead of grep --include: BusyBox grep has no --include.)
left=$(find . -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' \) \
  -exec grep -hoE "[\"'\`(=]/($NAMES)" {} + 2>/dev/null || true)
if [ -n "$left" ]; then
  echo "m2m-rebase: unrewritten references:" >&2
  echo "$left" | sort | uniq -c >&2
  exit 1
fi
echo "m2m-rebase: re-rooted under $PREFIX/"
