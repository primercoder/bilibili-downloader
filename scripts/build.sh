#!/usr/bin/env bash
# Build every native host binary and the extension zip.
#
# Outputs:
#   dist/bili-downloader-extension-<version>.zip   installable extension
#   dist/hosts/bili-host-linux-amd64               Linux x86_64 (static)
#   dist/hosts/bili-host-linux-arm64               Linux ARM64 (static)
#   dist/hosts/bili-host-windows-amd64.exe         Windows x86_64
#   dist/bili-downloader-<version>-linux-x64.tar.gz
#   dist/bili-downloader-<version>-windows-x64.zip
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
NAME="bili-downloader-${VERSION}"
mkdir -p dist/hosts

echo "==> building native hosts (v${VERSION})"
cd native_host
# CGO_ENABLED=0 keeps the Linux binary a single static file: no glibc version
# problem on older distros, and no runtime to install.
CGO_ENABLED=0 GOOS=linux  GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o "../dist/hosts/bili-host-linux-amd64" .
CGO_ENABLED=0 GOOS=linux  GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o "../dist/hosts/bili-host-linux-arm64" .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o "../dist/hosts/bili-host-windows-amd64.exe" .
cd ..
chmod +x dist/hosts/bili-host-linux-amd64 dist/hosts/bili-host-linux-arm64
ls -lh dist/hosts

echo "==> packing extension"
rm -f "dist/${NAME}-extension.zip"
(cd extension && zip -qr "../dist/${NAME}-extension.zip" . -x '*.DS_Store')

echo "==> packing linux bundle"
STAGE=$(mktemp -d)
mkdir -p "$STAGE/${NAME}-linux"
cp -r extension "$STAGE/${NAME}-linux/"
cp install.sh "$STAGE/${NAME}-linux/"
cp uninstall.sh "$STAGE/${NAME}-linux/"
cp README.md "$STAGE/${NAME}-linux/"
mkdir -p "$STAGE/${NAME}-linux/docs"
cp docs/how-it-works.md "$STAGE/${NAME}-linux/docs/"
mkdir -p "$STAGE/${NAME}-linux/host"
cp dist/hosts/bili-host-linux-amd64 "$STAGE/${NAME}-linux/host/"
cp dist/hosts/bili-host-linux-arm64 "$STAGE/${NAME}-linux/host/"
tar -C "$STAGE" -czf "dist/${NAME}-linux-x64.tar.gz" "${NAME}-linux"
rm -rf "$STAGE"

echo "==> packing windows bundle"
STAGE=$(mktemp -d)
mkdir -p "$STAGE/${NAME}-windows"
cp -r extension "$STAGE/${NAME}-windows/"
cp install.bat "$STAGE/${NAME}-windows/"
cp uninstall.bat "$STAGE/${NAME}-windows/"
cp README.md "$STAGE/${NAME}-windows/"
mkdir -p "$STAGE/${NAME}-windows/docs"
cp docs/how-it-works.md "$STAGE/${NAME}-windows/docs/"
mkdir -p "$STAGE/${NAME}-windows/host"
cp dist/hosts/bili-host-windows-amd64.exe "$STAGE/${NAME}-windows/host/bili-host.exe"
# Convert Markdown to CRLF so Notepad on Windows renders it correctly.
python3 - "$STAGE/${NAME}-windows/README.md" "$STAGE/${NAME}-windows/docs/how-it-works.md" <<'PY'
import sys, pathlib
for name in sys.argv[1:]:
    path = pathlib.Path(name)
    path.write_bytes(path.read_text(encoding="utf-8").replace("\n", "\r\n").encode("utf-8"))
PY
(cd "$STAGE" && zip -qr "$OLDPWD/dist/${NAME}-windows-x64.zip" "${NAME}-windows")
rm -rf "$STAGE"

echo
echo "Done. Artifacts:"
ls -lh dist/*.zip dist/*.tar.gz
