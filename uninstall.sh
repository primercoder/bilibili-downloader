#!/usr/bin/env bash
# Bili 下载器 - Linux 本地助手卸载脚本
set -o pipefail

HELPER_DIR="$HOME/.local/share/bili-downloader"
BINARY="$HELPER_DIR/bili-host"
SERVICE_NAME="bili-downloader.service"
SERVICE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_NAME"
AUTOSTART_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/bili-downloader.desktop"

info() { printf '%s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
die()  { printf '错误：%s\n' "$*" >&2; exit 1; }

pause_exit() {
  if [ -t 0 ]; then
    printf '\n按回车键退出…'
    read -r _ || true
  fi
}

info
info "Bili 下载器 - 卸载本地助手"
info

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
fi
pkill -f "$BINARY serve" >/dev/null 2>&1 || true
rm -f "$SERVICE_FILE" "$AUTOSTART_FILE"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
ok "已停止本地助手并移除开机启动"

if [ -d "$HELPER_DIR" ]; then
  rm -rf "$HELPER_DIR" || die "无法删除 $HELPER_DIR"
  ok "已删除助手目录：$HELPER_DIR"
else
  info "助手目录不存在，跳过。"
fi

# 清理 2.0.x 的 Native Messaging 清单，方便从旧版本升级。
for base in \
  "$HOME/.config/google-chrome" \
  "$HOME/.config/google-chrome-beta" \
  "$HOME/.config/google-chrome-unstable" \
  "$HOME/.config/chromium" \
  "$HOME/.config/BraveSoftware/Brave-Browser" \
  "$HOME/.config/microsoft-edge" \
  "$HOME/.config/vivaldi" \
  "$HOME/.config/opera" \
  "$HOME/.config/yandex-browser"; do
  rm -f "$base/NativeMessagingHosts/com.opencode.bili_downloader.json" 2>/dev/null || true
done
rm -f "$HOME/snap/chromium/common/chromium/NativeMessagingHosts/com.opencode.bili_downloader.json" 2>/dev/null || true
rm -rf "$HOME/snap/chromium/common/bili-downloader" 2>/dev/null || true
find "$HOME/.var/app" -type f -path '*/NativeMessagingHosts/com.opencode.bili_downloader.json' -delete 2>/dev/null || true
find "$HOME/.var/app" -type d -path '*/data/bili-downloader' -prune -exec rm -rf {} + 2>/dev/null || true

rm -rf "${TMPDIR:-/tmp}/bili-downloader" 2>/dev/null || true
rm -f "${TMPDIR:-/tmp}/bili-downloader-host.log" 2>/dev/null || true
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/bili-downloader" 2>/dev/null || true
ok "已清理临时文件与状态缓存"

info
info "最后到浏览器扩展页移除「Bili 下载器」："
info "  chrome://extensions/（或 edge://extensions/ 等）"
info
pause_exit
exit 0
