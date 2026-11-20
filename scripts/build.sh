#!/usr/bin/env bash
# Build every native host binary and the platform bundles.
#
# There is deliberately no standalone extension zip: the extension alone cannot
# download anything (it needs the native host), so shipping it separately only
# invites users to grab the wrong file. The extension lives inside each bundle,
# next to the host it needs.
#
# Outputs:
#   dist/hosts/bili-host-linux-amd64               Linux x86_64 (static)
#   dist/hosts/bili-host-linux-arm64               Linux ARM64 (static)
#   dist/hosts/bili-host-windows-amd64.exe         Windows x86_64
#   dist/bili-downloader-<version>-linux-x64.tar.gz
#   dist/bili-downloader-<version>-linux-arm64.tar.gz
#   dist/bili-downloader-<version>-windows-x64.zip
#
# Each Linux bundle carries only the host for its own architecture. Shipping
# both inside one archive forced users to guess which binary was theirs and made
# the x64 download look like the ARM one.
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
# -H=windowsgui is what stops a console window from flashing when the user
# double-clicks the helper: the shipped build is a tray app, not a CLI.
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -H=windowsgui" -o "../dist/hosts/bili-host-windows-amd64.exe" .
cd ..
chmod +x dist/hosts/bili-host-linux-amd64 dist/hosts/bili-host-linux-arm64
ls -lh dist/hosts

echo "==> packing linux bundles"
for ARCH in x64 arm64; do
  if [ "$ARCH" = "x64" ]; then
    HOST_BIN="bili-host-linux-amd64"
  else
    HOST_BIN="bili-host-linux-arm64"
  fi
  DIR_NAME="${NAME}-linux-${ARCH}"
  STAGE=$(mktemp -d)
  mkdir -p "$STAGE/${DIR_NAME}/host"
  cp -r extension "$STAGE/${DIR_NAME}/"
  cp install.sh uninstall.sh README.md "$STAGE/${DIR_NAME}/"
  cp "dist/hosts/${HOST_BIN}" "$STAGE/${DIR_NAME}/host/"
  tar -C "$STAGE" -czf "dist/${DIR_NAME}.tar.gz" "${DIR_NAME}"
  rm -rf "$STAGE"
done

echo "==> packing windows bundle"
STAGE=$(mktemp -d)
DIR_NAME="${NAME}-windows-x64"
mkdir -p "$STAGE/${DIR_NAME}"
cp -r extension "$STAGE/${DIR_NAME}/"
cp README.md "$STAGE/${DIR_NAME}/"
mkdir -p "$STAGE/${DIR_NAME}/host"
cp dist/hosts/bili-host-windows-amd64.exe "$STAGE/${DIR_NAME}/host/bili-host.exe"
# Convert Markdown to CRLF so Notepad renders it correctly.
python3 - "$STAGE/${DIR_NAME}/README.md" <<'PY'
import sys, pathlib
path = pathlib.Path(sys.argv[1])
path.write_bytes(path.read_text(encoding="utf-8").replace("\n", "\r\n").encode("utf-8"))
PY
rm -f "dist/${DIR_NAME}.zip"
(cd "$STAGE" && zip -qr "$OLDPWD/dist/${DIR_NAME}.zip" "${DIR_NAME}")
rm -rf "$STAGE"

echo
echo "Done. Artifacts:"
ls -lh dist/*.zip dist/*.tar.gz
