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
| Windows 10 / 11（x64） | `bili-downloader-2.0.4-windows-x64.zip` |
| Linux x86_64 | `bili-downloader-2.0.4-linux-x64.tar.gz` |
| Linux ARM64 | `bili-downloader-2.0.4-linux-arm64.tar.gz` |

每个包都完整可用：里面同时包含 Chrome 扩展、对应架构的本地助手程序和说明文档。
不需要安装 Python、FFmpeg 或任何运行库，也不需要管理员 / root 权限。

## 本次更新（2.0.4）

- 工具栏图标改为显示下载进度百分比，完成后显示 ✓。
- 安装 / 卸载改为交互式：自动检测浏览器、列出改动、支持多选；
  发现旧版本文件时再次确认覆盖 / 跳过 / 取消。
- 安装完成后逐个浏览器显示扩展加载步骤；卸载时识别已注册浏览器和残留文件。
- Windows 使用 `install.ps1` / `uninstall.ps1` 实现交互流程，仍可双击 `install.bat` / `uninstall.bat`。
- 精简安装与卸载脚本输出，减少重复信息。
- 修复浏览器检测：不再把旧版留下的空配置目录或 Snap 命令误判为普通 Chrome / Chromium。
- 修复切到非目标网页后打开面板只报错、看不到下载进度的问题；有任务时不再检查当前网页。
- 提升扩展版本号，确保 Chromium 重新加载新的后台脚本。
- 支持番剧 / 影视页面：`ep`、`ss` 链接均可解析，有观看权限的剧集可在「选集」中切换并下载。

## 包内结构

```
bili-downloader-2.0.4-windows-x64\
├── 先看这里.txt         # 快速开始
├── install.bat / install.ps1
├── uninstall.bat / uninstall.ps1
├── README.md            # 完整说明
├── docs\
│   ├── usage.md         # 使用与排错速查
│   └── how-it-works.md  # 运行原理
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
