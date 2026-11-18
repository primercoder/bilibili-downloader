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
| Windows 10 / 11（x64） | `bili-downloader-2.0.2-windows-x64.zip` |
| Linux x86_64 | `bili-downloader-2.0.2-linux-x64.tar.gz` |
| Linux ARM64 | `bili-downloader-2.0.2-linux-arm64.tar.gz` |

每个包都**完整可用**：里面同时包含 Chrome 扩展、对应架构的本地助手程序和说明文档。
Linux 包只带本机架构的助手，不会混入另一个架构的文件。
不需要安装 Python、FFmpeg 或任何运行库，也不需要管理员 / root 权限。

安装步骤见包内的 `README.md`；Windows 包里还有一个 `先看这里.txt` 写明三步操作。

## 本次更新（2.0.2）

Linux 发布包按架构拆分：`linux-x64` 只包含 amd64 助手，`linux-arm64` 只包含 arm64 助手，
下载时不会再误拿另一个架构的文件。README 也精简为功能、安装与使用说明。
以下为 2.0.1 的修复内容。

### 1. 切换视频后，下到的仍是上一个视频

在同一个标签页里点开另一个视频再下载时，标题会变成新视频，文件内容却还是上一个。
原因是读取页面缓存播放数据时用 `__playinfo__` 里的 `cid` 做校验，而这个对象根本没有 `cid`
字段，校验永远通过。现在改为用流地址里的 `cid` 路径段比对，并补了「先失败、修复后通过」的
真实浏览器回归测试。

### 2. 工具栏图标改为显示剩余时间

下载中显示预计剩余时间；进入合成显示「合成」；完成后显示 ✓。
✓ 只保留 3 秒：这 3 秒内点图标会直接看到完成界面，否则图标恢复正常，再点就是当前网页的下载设置。
下载完成时面板已经打开的话，面板会一直停留在完成界面；关闭面板即重置，下次打开是干净的设置页。

### 3. 面板更小更干净

完成界面只保留「打开所在文件夹」；去掉冗余说明与碎字，宽度收窄到 360px。
本地助手缺失时不再显示完整设置页，而是直接弹出一个小报错窗并给出处理方法。

### 4. 修复 ARM 安装脚本的架构判断

旧脚本先找 amd64 助手，找不到就直接退出，导致「明明是 ARM 机器、包里也有 arm64 助手却装不上」。
现在先按 `uname -m` 选出本机架构，再找对应文件，并在缺失时列出包里实际有哪些架构。

### 5. 其它稳定性修复

- 完成状态不再写入持久存储。此前后台页面每次重启都会把历史任务恢复出来，
  导致工具栏出现与本页无关的 ✓；现在完成状态只作为临时界面状态存在。
- 排队中或已中断的任务在后台重启后都能恢复，不会静默消失。
- 合成阶段角标不再短暂显示百分比，避免误读。

## 2.0.0 的主要改进

- **下载完一个视频后无法继续下载**：任务状态改为按标签页隔离，助手改为任务队列。
- **先快后慢**：8 连接 × 4 MiB 分片并行下载，多镜像自动测速与切换。
- **不再需要 FFmpeg / Python**：内置 Go 合成引擎直接输出普通 MP4，单文件、免安装。

## 包内结构

```
bili-downloader-2.0.2-windows-x64\
├── 先看这里.txt         # 三步快速开始
├── install.bat / uninstall.bat
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
