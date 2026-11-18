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
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o "../dist/hosts/bili-host-windows-amd64.exe" .
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
  mkdir -p "$STAGE/${DIR_NAME}/docs"
  cp docs/usage.md docs/how-it-works.md "$STAGE/${DIR_NAME}/docs/"
  cp "dist/hosts/${HOST_BIN}" "$STAGE/${DIR_NAME}/host/"
  tar -C "$STAGE" -czf "dist/${DIR_NAME}.tar.gz" "${DIR_NAME}"
  rm -rf "$STAGE"
done

echo "==> packing windows bundle"
STAGE=$(mktemp -d)
DIR_NAME="${NAME}-windows-x64"
mkdir -p "$STAGE/${DIR_NAME}"
cp -r extension "$STAGE/${DIR_NAME}/"
cp install.bat uninstall.bat install.ps1 uninstall.ps1 README.md "$STAGE/${DIR_NAME}/"
mkdir -p "$STAGE/${DIR_NAME}/docs"
cp docs/usage.md docs/how-it-works.md "$STAGE/${DIR_NAME}/docs/"
mkdir -p "$STAGE/${DIR_NAME}/host"
cp dist/hosts/bili-host-windows-amd64.exe "$STAGE/${DIR_NAME}/host/bili-host.exe"
# Windows also gets a plain-text quick start next to the installer, so a user
# who only double-clicks can still find the instructions without opening Markdown.
cat > "$STAGE/${DIR_NAME}/先看这里.txt" <<'TXT'
Bili 下载器 - 快速开始
======================

1) 确保已经【完整解压】本压缩包（不要在压缩软件窗口里直接双击 install.bat）。

2) 双击 install.bat，按窗口里的提示操作：
   - 脚本会检测浏览器，并列出每个浏览器会改动哪些文件；
   - 输入编号多选浏览器（all = 全部）；
   - 确认后会安装；如果发现旧文件，会再次询问是否覆盖。

3) 安装完成后，窗口里会显示加载扩展的步骤：
   打开 Chrome，地址栏输入 chrome://extensions/
   - 打开右上角「开发者模式」
   - 点「加载已解压的扩展程序」
   - 选择本文件夹下的 extension 目录（不是它的上一级）

4) 完全退出浏览器，再重新打开一次。

5) 打开任意 B 站视频页，点工具栏里的粉色 B 图标即可下载。

不需要安装 Python、FFmpeg，也不需要管理员权限。
完整说明见 README.md，使用与排错见 docs\usage.md。
TXT
# Convert Markdown/plain text to CRLF so Notepad renders them correctly.
python3 - "$STAGE/${DIR_NAME}/README.md" \
         "$STAGE/${DIR_NAME}/docs/usage.md" \
         "$STAGE/${DIR_NAME}/docs/how-it-works.md" \
         "$STAGE/${DIR_NAME}/先看这里.txt" <<'PY'
import sys, pathlib
for name in sys.argv[1:]:
    path = pathlib.Path(name)
    path.write_bytes(path.read_text(encoding="utf-8").replace("\n", "\r\n").encode("utf-8"))
PY
(cd "$STAGE" && zip -qr "$OLDPWD/dist/${DIR_NAME}.zip" "${DIR_NAME}")
rm -rf "$STAGE"

echo
echo "Done. Artifacts:"
ls -lh dist/*.zip dist/*.tar.gz
