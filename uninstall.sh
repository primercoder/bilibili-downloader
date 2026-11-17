#!/usr/bin/env bash
# Remove the native host registration and the helper binary (Linux).
set -euo pipefail
HOST_NAME="com.opencode.bili_downloader"
for BASE in "$HOME/.config/google-chrome" \
            "$HOME/.config/google-chrome-beta" \
            "$HOME/.config/google-chrome-unstable" \
            "$HOME/.config/chromium" \
            "$HOME/.config/BraveSoftware/Brave-Browser" \
            "$HOME/.config/microsoft-edge" \
            "$HOME/.config/vivaldi" \
            "$HOME/.config/opera" \
            "$HOME/.var/app/org.chromium.Chromium/config/chromium" \
            "$HOME/snap/chromium/common/chromium"; do
  rm -f "$BASE/NativeMessagingHosts/$HOST_NAME.json"
done
rm -rf "$HOME/.local/share/bili-downloader"
rm -rf "${TMPDIR:-/tmp}/bili-downloader"
echo "已卸载本地助手。别忘了在 chrome://extensions/ 中移除「Bili 下载器」扩展。"
