#!/bin/sh
# Builds the website in site/, which Cloudflare serves at aolangai.openyard.cloud (see wrangler.jsonc).
# Usage: sh scripts/build-site.sh, or npm run build:site
#
# Committed sources in site/: index.html, privacy.html, openyard.svg (the OpenYard mark) and og.png (the link
# preview picture, made from scripts/og.html by node scripts/screenshots.mjs, which needs Google Chrome).
# Build outputs, git-ignored: site/demo/ (the browser demo, npm run build:demo) and site/overview.png (the picture
# phones get instead of the live demo, copied from docs/screenshots).
set -e
cd "$(dirname "$0")/.."

npm run build:demo
cp docs/screenshots/overview.png site/overview.png

for f in site/index.html site/privacy.html site/openyard.svg site/og.png site/overview.png site/demo/index.html; do
  if [ ! -f "$f" ]; then
    echo "build-site: $f is missing" >&2
    exit 1
  fi
done

echo "Built site/:"
find site -type f | sort | sed 's/^/  /'
