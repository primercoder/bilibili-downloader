#!/usr/bin/env bash
# Publish the built artifacts as a GitHub release.
#
# Only the two platform bundles are published. The extension is not shipped as a
# standalone zip: it cannot work without the native host, so a separate download
# only encourages users to grab the wrong file. Both bundles contain the
# extension, the host and the documentation.
#
# Requires an authenticated GitHub CLI (`gh auth login`) with permission to
# create releases on the repository. Run scripts/build.sh first.
#
#   bash scripts/release.sh            # create the release for the current version
#   bash scripts/release.sh --dry-run  # show what would be uploaded
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
TAG="v${VERSION}"
NAME="bili-downloader-${VERSION}"

WIN="dist/${NAME}-windows-x64.zip"
LINUX_X64="dist/${NAME}-linux-x64.tar.gz"
LINUX_ARM64="dist/${NAME}-linux-arm64.tar.gz"
ARTIFACTS=("$WIN" "$LINUX_X64" "$LINUX_ARM64")

for artifact in "${ARTIFACTS[@]}"; do
  if [ ! -f "$artifact" ]; then
    echo "缺少构建产物：$artifact" >&2
    echo "请先运行：bash scripts/build.sh" >&2
    exit 1
  fi
done

if [ "${1:-}" = "--dry-run" ]; then
  echo "将创建 release ${TAG} 并上传："
  ls -lh "${ARTIFACTS[@]}"
  exit 0
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI 未登录。请先运行：gh auth login" >&2
  exit 1
fi

NOTES=$(mktemp)
trap 'rm -f "$NOTES"' EXIT
cat > "$NOTES" <<'EOF'
## 下载哪个包

| 你的系统 | 下载 |
| --- | --- |
| Windows 10 / 11（x64） | `bili-downloader-2.2.0-windows-x64.zip` |
| Linux x86_64 | `bili-downloader-2.2.0-linux-x64.tar.gz` |
| Linux ARM64 | `bili-downloader-2.2.0-linux-arm64.tar.gz` |

每个包都完整可用：里面同时包含 Chrome 扩展、对应架构的本地助手程序和说明文档。
不需要安装 Python、FFmpeg 或任何运行库，也不需要管理员 / root 权限。

## 本次更新（2.2.0）

- 本地助手变成托盘应用：双击即运行，不再弹出黑色控制台窗口。
- 托盘图标反映状态（空闲 / 下载 / 合成），菜单可查看端口、打开下载文件夹、
  开关开机自启、退出。
- **移除 Windows 安装脚本**：不需要任何安装步骤，双击 `host\bili-host.exe` 即可。
  开机自启在托盘菜单里勾选，写入当前用户启动项，无需管理员权限。
- 修复 Windows「选择文件夹」：改用系统 Shell 的文件夹浏览器（不依赖 PowerShell），
  对话框归属浏览器窗口，不会再跑到后面或直接报错。
- 修复 Windows「打开所在文件夹」：改用 Explorer 的 `/select` 定位文件。
- 默认下载目录改用 Shell 已知文件夹 API，正确尊重「下载」被重定向的情况。
- 助手改为单实例：重复启动会提示已在运行，而不是再开一个进程。
- Linux 支持托盘（StatusNotifierItem），并保留可选的安装脚本。

## 包内结构

```
bili-downloader-2.2.0-windows-x64\
├── README.md            # 功能、安装与使用方法
├── extension\           # Chrome 扩展
└── host\bili-host.exe   # 本地助手（双击运行）
```

Linux 包结构相同，`host/` 下是对应架构的 `bili-host-linux-*`，
另附可选的 `install.sh` / `uninstall.sh`。
EOF

# Reuse an existing release if the tag already exists, so re-running is safe.
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release ${TAG} 已存在，改为上传/覆盖产物"
  gh release edit "$TAG" --notes-file "$NOTES"
  gh release upload "$TAG" "${ARTIFACTS[@]}" --clobber
  # Drop the old standalone extension asset if a previous release shipped one.
  if gh release view "$TAG" --json assets --jq '.assets[].name' | grep -q -- '-extension.zip'; then
    gh release delete-asset "$TAG" "${NAME}-extension.zip" --yes || true
    echo "已移除旧的独立扩展包"
  fi
else
  gh release create "$TAG" "${ARTIFACTS[@]}" \
    --title "Bili 下载器 ${VERSION}" \
    --notes-file "$NOTES"
fi

echo
echo "已发布：$(gh release view "$TAG" --json url --jq .url)"
