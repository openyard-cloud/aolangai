#!/bin/sh
# Remakes the app icon from build/icon.svg into build/icon.icns, and prints the menu-bar icon (build/tray.svg at
# 36 px, a 2x macOS template image) as the base64 to paste into TRAY_ICON in src/main/index.ts.
# Needs rsvg-convert (brew install librsvg) and iconutil (part of macOS). Usage: sh scripts/icons.sh
set -e
cd "$(dirname "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/icon.iconset"
for s in 16 32 128 256 512; do
  rsvg-convert -w "$s" -h "$s" build/icon.svg -o "$tmp/icon.iconset/icon_${s}x${s}.png"
  rsvg-convert -w $((s * 2)) -h $((s * 2)) build/icon.svg -o "$tmp/icon.iconset/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$tmp/icon.iconset" -o build/icon.icns
echo "Wrote build/icon.icns"

rsvg-convert -w 36 -h 36 build/tray.svg -o "$tmp/tray.png"
echo "TRAY_ICON:"
base64 -i "$tmp/tray.png" | tr -d '\n'
echo
