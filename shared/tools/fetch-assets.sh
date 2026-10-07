#!/usr/bin/env bash
# Re-fetches the vendored third-party assets of the design system (fonts, QR library) from npm.
# Everything is committed to the repo, this script only documents + reproduces how they got there.
#   bash shared/tools/fetch-assets.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pack() { (cd "$TMP" && npm pack "$1" --silent >/dev/null && mkdir -p "x/$2" && tar -xzf ./*"$2"*.tgz -C "x/$2" ); }

# Fonts: Bricolage Grotesque (display, opsz+wght variable) and Inter (text, wght variable). latin + latin-ext only.
pack @fontsource-variable/bricolage-grotesque bricolage-grotesque
pack @fontsource-variable/inter inter
B="$TMP/x/bricolage-grotesque/package"; I="$TMP/x/inter/package"
cp "$B/files/bricolage-grotesque-latin-opsz-normal.woff2"     fonts/bricolage-grotesque-latin.woff2
cp "$B/files/bricolage-grotesque-latin-ext-opsz-normal.woff2" fonts/bricolage-grotesque-latin-ext.woff2
cp "$I/files/inter-latin-wght-normal.woff2"                   fonts/inter-latin.woff2
cp "$I/files/inter-latin-ext-wght-normal.woff2"               fonts/inter-latin-ext.woff2
cp "$B/LICENSE" fonts/OFL-bricolage-grotesque.txt
cp "$I/LICENSE" fonts/OFL-inter.txt

# QR code generator (MIT, Kazuhiko Arase): ES module build, licence header kept verbatim (UTF-8 enabled in js/qr.js).
pack qrcode-generator qrcode-generator
cp "$TMP/x/qrcode-generator/package/dist/qrcode.mjs" vendor/qrcode.js
echo "fonts + vendor/qrcode.js updated"

# Gravitee logos come from the repo's assets/ folder (not npm).
for f in Horizontal_DarkMode:gravitee-horizontal-on-dark Horizontal_LightMode:gravitee-horizontal-on-light Mark:gravitee-mark Mark_White:gravitee-mark-white; do
  cp "../assets/gravitee-logo/${f%%:*}.svg" "img/${f##*:}.svg"
done
echo "logos copied"
# Icons: node shared/tools/build-sprite.mjs
