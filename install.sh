#!/usr/bin/env bash
# One-step installer for the Bili Downloader native host on Linux.
#
#   ./install.sh          install or upgrade
#   ./install.sh --check  only report what would be done
#
# What it does, in order:
#   1. Copies the helper binary to a per-user directory (no root needed).
#   2. Registers it as a Chrome/Chromium native messaging host for every
#      browser it finds, including Snap and Flatpak Chromium.
#   3. Prints the extension ID and the two steps left in the browser.
#
# No Python, no FFmpeg, no root, no PATH changes.
#
# Snap and Flatpak sandboxes cannot read hidden directories inside $HOME, so for
# those browsers the helper is installed under their own data directory. This is
# detected automatically; the user never has to know about it.
set -euo pipefail

HOST_NAME="com.opencode.bili_downloader"
EXT_KEY="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1utkFp6OccsDY+CMfFeuRuvNfBpcJxWEI1eavopPIif5vqMJV5eM/gC9RjSukEImbXKKURGdN/J3cKX2E8ljnf6DtoOQZyFifP4ZmeRHlUXC/HQ8fa5ZRZ9+SwtOv1DzauJRB0QAmA8VWF7f0FcW186e78bmfzE7htCM6wtIqu4dEQu5vENhEsksShu0P1zCwhCEJWun/MHAeJ3kW08pTVSjMoJJmlA1myShMpeQO6dsjQyVxMdZueWxU/IK/HeIhmn/C0iSgCnT14ECicrCGeCay7WIrNR4dmA59HnNrJTQ3T19k++kRMsvyxDj/vp2VxjAx2zq7SPBlpcmiktAKwIDAQAB"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

info() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

# --- locate the helper binary -------------------------------------------------
SOURCE=""
for candidate in \
  "$SCRIPT_DIR/host/bili-host-linux-amd64" \
  "$SCRIPT_DIR/dist/hosts/bili-host-linux-amd64"; do
  [ -f "$candidate" ] && SOURCE="$candidate" && break
done
[ -n "$SOURCE" ] || die "找不到 host/bili-host-linux-amd64。请从发布包运行本脚本，或先运行 scripts/build.sh。"

ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  for candidate in \
    "$SCRIPT_DIR/host/bili-host-linux-arm64" \
    "$SCRIPT_DIR/dist/hosts/bili-host-linux-arm64"; do
    [ -f "$candidate" ] && SOURCE="$candidate" && break
  done
fi

# --- extension id ------------------------------------------------------------
# Chrome derives an unpacked extension's ID from the manifest "key": the first
# 32 hex digits of SHA-256(key), each hex digit mapped to a-p. The key is fixed
# in extension/manifest.json, so the ID is a constant — no Python or other tool
# is needed to compute it at install time.
EXT_ID="khkbfeoekeinbdgbicojpgfidfihfffc"
if command -v python3 >/dev/null 2>&1; then
  COMPUTED=$(python3 - "$EXT_KEY" <<'PY' 2>/dev/null || true
import base64, hashlib, sys
key = base64.b64decode(sys.argv[1])
print("".join(chr(ord('a') + int(c, 16)) for c in hashlib.sha256(key).hexdigest()[:32]))
PY
)
  if [ -n "$COMPUTED" ] && [ "$COMPUTED" != "$EXT_ID" ]; then
    info "提示：manifest.json 的 key 已变更，改用新扩展 ID：$COMPUTED"
    EXT_ID="$COMPUTED"
  fi
fi
[ -n "$EXT_ID" ] || die "无法确定扩展 ID"

manifest_for() {
  cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Bili Downloader native host",
  "path": "$1",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
}

install_host() {
  local target_dir="$1"
  local label="$2"
  local binary="$target_dir/bili-host"
  if [ "$CHECK_ONLY" = "1" ]; then
    info "  [预览] $label -> $binary"
    return
  fi
  mkdir -p "$target_dir"
  install -m 755 "$SOURCE" "$binary"
  info "  已安装 $label: $binary"
}

register() {
  local browser_dir="$1"
  local binary_path="$2"
  local label="$3"
  local target="$browser_dir/NativeMessagingHosts"
  if [ "$CHECK_ONLY" = "1" ]; then
    info "  [预览] 注册 $label: $target/$HOST_NAME.json"
    return
  fi
  mkdir -p "$target"
  manifest_for "$binary_path" > "$target/$HOST_NAME.json"
  info "  已注册 $label"
}

# Friendly name for a browser config directory, e.g. "Chrome" for
# ~/.config/google-chrome.
browser_label() {
  case "$(basename "$1")" in
    google-chrome) echo "Chrome" ;;
    google-chrome-beta) echo "Chrome Beta" ;;
    google-chrome-unstable) echo "Chrome Dev" ;;
    chromium) echo "Chromium" ;;
    Brave-Browser) echo "Brave" ;;
    microsoft-edge) echo "Edge" ;;
    vivaldi) echo "Vivaldi" ;;
    opera) echo "Opera" ;;
    *) basename "$1" ;;
  esac
}

info "Bili 下载器 - 本地助手安装"
info

# --- standard (non-sandboxed) install ---------------------------------------
STANDARD_DIR="$HOME/.local/share/bili-downloader"
info "常规浏览器（Chrome / Chromium / Brave / Edge / Vivaldi）"
install_host "$STANDARD_DIR" "本地助手"
STANDARD_BIN="$STANDARD_DIR/bili-host"

registered=0
for BASE in \
  "$HOME/.config/google-chrome" \
  "$HOME/.config/google-chrome-beta" \
  "$HOME/.config/google-chrome-unstable" \
  "$HOME/.config/chromium" \
  "$HOME/.config/BraveSoftware/Brave-Browser" \
  "$HOME/.config/microsoft-edge" \
  "$HOME/.config/vivaldi" \
  "$HOME/.config/opera"; do
  [ -d "$BASE" ] || continue
  register "$BASE" "$STANDARD_BIN" "$(browser_label "$BASE")"
  registered=$((registered + 1))
done

if [ "$registered" -eq 0 ]; then
  # No browser has run yet for this user: pre-register the two common paths so
  # the extension works the very first time the browser starts.
  register "$HOME/.config/google-chrome" "$STANDARD_BIN" "google-chrome（预注册）"
  register "$HOME/.config/chromium" "$STANDARD_BIN" "chromium（预注册）"
fi
info

# --- Snap Chromium ----------------------------------------------------------
# The snap's AppArmor profile denies reads of hidden $HOME directories, so the
# binary must live inside the snap's own data folder and the manifest inside
# the snap's profile folder. Chrome resolves snap $HOME to that same folder.
SNAP_BASE=""
if [ -d "$HOME/snap/chromium" ]; then
  SNAP_BASE="$HOME/snap/chromium/common/chromium"
elif command -v snap >/dev/null 2>&1 && snap list chromium >/dev/null 2>&1; then
  SNAP_BASE="$HOME/snap/chromium/common/chromium"
fi
if [ -n "$SNAP_BASE" ]; then
  info "Snap Chromium（AppArmor 沙箱，需要单独目录）"
  SNAP_HOST_DIR="$HOME/snap/chromium/common/bili-downloader"
  install_host "$SNAP_HOST_DIR" "本地助手（Snap）"
  register "$SNAP_BASE" "$SNAP_HOST_DIR/bili-host" "Snap Chromium"
  info
fi

# --- Flatpak Chromium -------------------------------------------------------
FLATPAK_BASE="$HOME/.var/app/org.chromium.Chromium/config/chromium"
if [ -d "$FLATPAK_BASE" ]; then
  info "Flatpak Chromium"
  install_host "$HOME/.var/app/org.chromium.Chromium/data/bili-downloader" "本地助手（Flatpak）"
  register "$FLATPAK_BASE" "$HOME/.var/app/org.chromium.Chromium/data/bili-downloader/bili-host" "Flatpak Chromium"
  info
fi

if [ "$CHECK_ONLY" = "1" ]; then
  info "预览结束，未做任何修改。去掉 --check 正式安装。"
  exit 0
fi

info "扩展 ID: $EXT_ID"
info
info "接下来只需要两步："
info "  1. 打开 chrome://extensions/ ，开启右上角「开发者模式」"
info "  2. 点「加载已解压的扩展程序」，选择本目录下的 extension 文件夹"
info
info "之后打开任意 B 站视频页，点工具栏的粉色 B 图标即可下载。"
info "默认保存到：$( "$STANDARD_BIN" default-dir 2>/dev/null || echo "$HOME/Downloads" )"
info
info "如果浏览器当时正开着，请到 chrome://extensions/ 点一下扩展的「重新加载」，"
info "或者完全退出浏览器再启动，让新的本地助手注册生效。"
