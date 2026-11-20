#!/usr/bin/env bash
# Bili 下载器 - Linux 本地助手安装脚本
#
# 助手是一个托盘应用：启动后在 127.0.0.1 上监听端口，并常驻系统托盘。
# 安装脚本只做两件事：复制助手、设置为登录时自动启动。
set -o pipefail

HELPER_DIR="$HOME/.local/share/bili-downloader"
BINARY="$HELPER_DIR/bili-host"
SERVICE_NAME="bili-downloader.service"
SERVICE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_NAME"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
AUTOSTART_FILE="$AUTOSTART_DIR/bili-downloader.desktop"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
EXT_DIR="$SCRIPT_DIR/extension"

info() { printf '%s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*"; }
die()  { printf '错误：%s\n' "$*" >&2; exit 1; }

pause_exit() {
  if [ -t 0 ]; then
    printf '\n按回车键退出…'
    read -r _ || true
  fi
}

ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64|armv8*) BINARY_NAME="bili-host-linux-arm64" ;;
  x86_64|amd64|x64)     BINARY_NAME="bili-host-linux-amd64" ;;
  armv7l|armv6l|arm*)
    die "本机是 32 位 ARM（$ARCH），本扩展只提供 64 位（arm64）助手。" ;;
  *)
    die "不支持的 CPU 架构：$ARCH（只提供 x86_64 与 arm64）" ;;
esac

SOURCE=""
for candidate in "$SCRIPT_DIR/host/$BINARY_NAME" "$SCRIPT_DIR/dist/hosts/$BINARY_NAME"; do
  [ -f "$candidate" ] && SOURCE="$candidate" && break
done
[ -n "$SOURCE" ] || die "找不到适用于 $ARCH 的本地助手（$BINARY_NAME）。请确认发布包架构与本机一致。"

info
info "Bili 下载器 - 安装本地助手"
info

# 升级时先停掉旧实例（包括 2.0.x 时期的 systemd 服务）。
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$SERVICE_FILE"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
pkill -f "$BINARY" >/dev/null 2>&1 || true
sleep 0.3

mkdir -p "$HELPER_DIR" || die "无法创建 $HELPER_DIR"
if ! install -m 755 "$SOURCE" "$BINARY" 2>/dev/null; then
  cp -f "$SOURCE" "$BINARY" && chmod 755 "$BINARY" || die "无法复制本地助手到 $BINARY"
fi
ok "本地助手：$BINARY"

# 助手自己也会写这个文件（托盘菜单里的「开机自启」），这里先写好，
# 保证安装完立刻生效。
mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Bili Downloader
Comment=本地下载助手
Exec="$BINARY"
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
ok "已设置为登录后自动启动"

# 从当前终端启动时继承 DISPLAY/WAYLAND_DISPLAY，托盘图标和文件夹选择器
# 才能正常显示。
nohup "$BINARY" >/dev/null 2>&1 &
ok "本地助手已启动（托盘图标在系统托盘区）"

info
info "安装完成。接下来在浏览器中加载扩展："
info "  1. 打开 chrome://extensions/（Edge 为 edge://extensions/）"
info "  2. 打开右上角「开发者模式」"
info "  3. 点「加载已解压的扩展程序」"
info "  4. 选择：$EXT_DIR"
info
info "助手会在 127.0.0.1 的本地端口（47821–47860）上监听，不需要浏览器注册或额外配置。"
info "托盘图标：左键/右键都打开菜单，可查看状态、打开下载文件夹、开关开机自启、退出。"
info "如果提示助手未运行，重新运行：$BINARY"
info
pause_exit
exit 0
