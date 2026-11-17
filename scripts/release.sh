#!/usr/bin/env bash
# Publish the built artifacts as a GitHub release.
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

EXT="dist/${NAME}-extension.zip"
WIN="dist/${NAME}-windows-x64.zip"
LINUX="dist/${NAME}-linux-x64.tar.gz"

for artifact in "$EXT" "$WIN" "$LINUX"; do
  if [ ! -f "$artifact" ]; then
    echo "缺少构建产物：$artifact" >&2
    echo "请先运行：bash scripts/build.sh" >&2
    exit 1
  fi
done

if [ "${1:-}" = "--dry-run" ]; then
  echo "将创建 release ${TAG} 并上传："
  ls -lh "$EXT" "$WIN" "$LINUX"
  exit 0
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI 未登录。请先运行：gh auth login" >&2
  exit 1
fi

NOTES=$(mktemp)
trap 'rm -f "$NOTES"' EXIT
cat > "$NOTES" <<'EOF'
## 主要改进

本次大版本重写了下载与合成流程，修复了三个长期存在的问题。

### 1. 下载完一个视频后无法继续下载（必须重启扩展）

根因有两处：扩展把「上一个任务已完成」当成全局状态，之后每次打开面板都复用旧结果、
不再读取当前页面；本地助手在任务异常结束时也不会释放任务槽，新任务被永久拒绝。

现在任务状态按标签页隔离，每次打开面板都会重新读取当前页面，助手改为任务队列，
任务结束（含失败、取消）一定会释放槽位。

### 2. 先快后慢

B 站 CDN 会对单个 TCP 连接限速，而且限速在传输持续一段时间后才生效。
现在改为多连接分片下载（8 连接 × 4 MiB 分片）并在多个镜像之间自动测速与切换。

实测持续吞吐（同一文件、持续 15 秒）：

| 连接数 | 持续吞吐 | 相对速度 |
| --- | --- | --- |
| 1 | 10.3 MB/s | 1.00x |
| 4 | 29.7 MB/s | 2.88x |
| 8 | 59.2 MB/s | 5.74x |

### 3. 不再需要安装 FFmpeg

B 站的 `.m4s` 本身就是标准 fragmented MP4。现在由内置的 Go 引擎重建完整索引，
直接输出普通 MP4。用户不需要安装 Python、FFmpeg，也不用手动配置 PATH。

体积从「扩展 + Python + FFmpeg」变成了一个 7 MB 的单文件程序。

## 其他修复

- 部分视频的分片不写每帧时长，旧逻辑会解析出 0 秒时长导致播放器拒绝；
  现在从 `tfdt` 时间戳重建。
- 源文件自带的 `elst` 会让成品时长变成 0.04 秒；合成时丢弃。
- Chrome 回收扩展后台页面时，下载会中断且状态丢失；现在会记住任务并支持一键续传。
- 排队状态在面板上不可见、跨标签页的进度会丢失。
- Windows 安装脚本计算扩展 ID 有误；Snap / Flatpak 版 Chromium 因沙箱读不到隐藏目录。

## 安装

Windows：解压 `bili-downloader-2.0.0-windows-x64.zip`，双击 `install.bat`，
然后在 `chrome://extensions/` 打开开发者模式，加载 `extension` 文件夹。

Linux：解压 `bili-downloader-2.0.0-linux-x64.tar.gz`，运行 `./install.sh`，
然后同样加载 `extension` 文件夹。

详细步骤与排错见 README。
EOF

# Reuse an existing release if the tag already exists, so re-running is safe.
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release ${TAG} 已存在，改为上传/覆盖产物"
  gh release upload "$TAG" "$EXT" "$WIN" "$LINUX" --clobber
else
  gh release create "$TAG" "$EXT" "$WIN" "$LINUX" \
    --title "Bili 下载器 ${VERSION}" \
    --notes-file "$NOTES"
fi

echo
echo "已发布：$(gh release view "$TAG" --json url --jq .url)"
