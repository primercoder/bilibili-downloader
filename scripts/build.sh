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

echo "==> packing linux bundle"
STAGE=$(mktemp -d)
mkdir -p "$STAGE/${NAME}-linux"
cp -r extension "$STAGE/${NAME}-linux/"
cp install.sh "$STAGE/${NAME}-linux/"
cp uninstall.sh "$STAGE/${NAME}-linux/"
cp README.md "$STAGE/${NAME}-linux/"
mkdir -p "$STAGE/${NAME}-linux/docs"
cp docs/usage.md "$STAGE/${NAME}-linux/docs/"
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
cp docs/usage.md "$STAGE/${NAME}-windows/docs/"
cp docs/how-it-works.md "$STAGE/${NAME}-windows/docs/"
mkdir -p "$STAGE/${NAME}-windows/host"
cp dist/hosts/bili-host-windows-amd64.exe "$STAGE/${NAME}-windows/host/bili-host.exe"
# Windows also gets a plain-text quick start next to the installer, so a user
# who only double-clicks can still find the instructions without opening Markdown.
cat > "$STAGE/${NAME}-windows/先看这里.txt" <<'TXT'
Bili 下载器 - 快速开始
======================

1) 确保已经【完整解压】本压缩包（不要在压缩软件窗口里直接双击 install.bat）。

2) 双击 install.bat，等它显示「安装完成」后按任意键关闭。

3) 打开 Chrome，地址栏输入 chrome://extensions/
   - 打开右上角「开发者模式」
   - 点「加载已解压的扩展程序」
   - 选择本文件夹下的 extension 目录（不是它的上一级）

4) 完全退出浏览器，再重新打开一次。

5) 打开任意 B 站视频页，点工具栏里的粉色 B 图标即可下载。

不需要安装 Python、FFmpeg，也不需要管理员权限。
完整说明见 README.md，使用与排错见 docs\usage.md。
TXT
# Convert Markdown/plain text to CRLF so Notepad renders them correctly.
python3 - "$STAGE/${NAME}-windows/README.md" \
         "$STAGE/${NAME}-windows/docs/usage.md" \
         "$STAGE/${NAME}-windows/docs/how-it-works.md" \
         "$STAGE/${NAME}-windows/先看这里.txt" <<'PY'
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
