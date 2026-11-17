#!/usr/bin/env bash
# Build a zip that can be uploaded to the Chrome Web Store or shared.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
OUT="dist/bili-downloader-extension-${VERSION}.zip"
mkdir -p dist
rm -f "$OUT"
cd extension
zip -qr "../$OUT" .
cd ..
echo "Built $OUT"
