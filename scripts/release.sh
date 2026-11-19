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
| Windows 10 / 11（x64） | `bili-downloader-2.1.0-windows-x64.zip` |
| Linux x86_64 | `bili-downloader-2.1.0-linux-x64.tar.gz` |
| Linux ARM64 | `bili-downloader-2.1.0-linux-arm64.tar.gz` |

每个包都完整可用：里面同时包含 Chrome 扩展、对应架构的本地助手程序和说明文档。
不需要安装 Python、FFmpeg 或任何运行库，也不需要管理员 / root 权限。

## 本次更新（2.1.0）

- 本地助手改为监听本地 HTTP 端口，扩展自动发现并连接；不再注册 Native Messaging，
  不再写浏览器清单或注册表。
- 安装 / 卸载简化为「复制助手 + 设置当前用户开机启动」，不需要选择浏览器或写配置。
- 下载、进度、取消、续传、番剧选集和工具栏百分比继续沿用原有界面。
- 修复 Windows 的「选择文件夹」和「打开所在文件夹」：
  使用绝对路径调用 PowerShell / Explorer，文件夹对话框置顶，打开文件时自动定位到文件。
- 文件夹选择请求不再受 6 秒超时限制，失败原因会显示在面板里。
- 修复切到非目标网页后看不到下载进度，以及排队/中断任务在切页或关闭标签后丢失的问题。

## 包内结构

```
bili-downloader-2.1.0-windows-x64\
├── install.bat / install.ps1
├── uninstall.bat / uninstall.ps1
├── README.md            # 功能、安装与使用方法
├── extension\           # Chrome 扩展
└── host\bili-host.exe   # 本地助手
```

Linux 包结构相同，用 `install.sh` / `uninstall.sh`；x64 包只含 amd64 助手，
ARM64 包只含 arm64 助手。
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
