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
| Windows 10 / 11（x64） | `bili-downloader-2.3.1-windows-x64.zip` |
| Linux x86_64 | `bili-downloader-2.3.1-linux-x64.tar.gz` |
| Linux ARM64 | `bili-downloader-2.3.1-linux-arm64.tar.gz` |

每个包都完整可用：里面同时包含 Chrome 扩展、对应架构的本地助手程序和说明文档。
不需要安装 Python、FFmpeg 或任何运行库，也不需要管理员 / root 权限。

## 本次更新（2.3.1）

- 在 Windows 11 实机（虚拟机）完成全量测试：真实下载、合成、目录记忆、
  阶段文案、单实例、开机自启、CORS 均验证通过（22/22 + Edge 端到端 2/2）。
- 修复重复启动时提示框文案重复的问题（"已在运行…已在运行（端口 47821）"）。
- 新增 Windows 虚拟机端到端测试脚本 `tests/test_vm_e2e.py`，
  覆盖服务级 22 项断言，可在任何 Windows 机器上复跑。

## 2.3.0 主要变化（回顾）

- 修复「下载目录无法更新」：所选目录持久保存，重启助手后仍然生效；托盘
  「打开下载文件夹」同步打开上一次选择的目录。首次运行默认系统下载目录。
- 修复下载时面板在「下载视频流 / 下载音频流」之间频繁跳动：传输阶段统一
  显示「下载中」，完成后显示「合并中」，托盘同步为 空闲 / 下载中 / 合成中。
- 修复托盘菜单里开关「开机自启」后多出一行「已开启 / 已关闭」提示的问题。

## 包内结构

```
bili-downloader-2.3.1-windows-x64\
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
