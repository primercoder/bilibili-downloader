#!/usr/bin/env bash
# Bili 下载器 - Linux 本地助手交互式安装脚本
#
# 直接运行即可，不需要任何命令行参数：
#
#   ./install.sh
#
# 脚本会：
#   1. 检测本机安装的 Chromium 系浏览器；
#   2. 列出每个浏览器安装后会被改动的文件，供你多选；
#   3. 检查目标位置是否已有旧版本文件，并再次确认是否覆盖；
#   4. 安装本地助手、写入 native messaging 清单；
#   5. 逐步说明浏览器里还要做哪些操作。
#
# 不需要 root，不修改 PATH，不依赖 Python / FFmpeg。
#
# Snap 和 Flatpak 浏览器读不到 $HOME 下的隐藏目录，脚本会自动把助手放到
# 沙箱可访问的目录；这一步对用户透明。

set -o pipefail

HOST_NAME="com.opencode.bili_downloader"
EXT_KEY="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1utkFp6OccsDY+CMfFeuRuvNfBpcJxWEI1eavopPIif5vqMJV5eM/gC9RjSukEImbXKKURGdN/J3cKX2E8ljnf6DtoOQZyFifP4ZmeRHlUXC/HQ8fa5ZRZ9+SwtOv1DzauJRB0QAmA8VWF7f0FcW186e78bmfzE7htCM6wtIqu4dEQu5vENhEsksShu0P1zCwhCEJWun/MHAeJ3kW08pTVSjMoJJmlA1myShMpeQO6dsjQyVxMdZueWxU/IK/HeIhmn/C0iSgCnT14ECicrCGeCay7WIrNR4dmA59HnNrJTQ3T19k++kRMsvyxDj/vp2VxjAx2zq7SPBlpcmiktAKwIDAQAB"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
EXT_DIR="$SCRIPT_DIR/extension"

# ---------------------------------------------------------------------------
# 输出与交互
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_PINK=$'\033[38;5;205m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_PINK=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
err()  { printf '%s错误：%s\n' "$C_RED" "$*" >&2; }
hr()   { printf '%s\n' "────────────────────────────────────────────────────────────"; }

pause_exit() {
  if [ -t 0 ]; then
    printf '\n按回车键退出…'
    read -r _ || true
  fi
}

die() {
  err "$*"
  pause_exit
  exit 1
}

# 默认值：y=回车视为是，n=回车视为否。
ask_yn() {
  local prompt="$1" default="${2:-n}" answer suffix
  if [ "$default" = "y" ]; then suffix="[Y/n]"; else suffix="[y/N]"; fi
  while true; do
    printf '%s %s ' "$prompt" "$suffix"
    if ! read -r answer; then
      printf '\n'
      [ "$default" = "y" ]
      return
    fi
    case "$answer" in
      "") [ "$default" = "y" ]; return ;;
      y|Y|yes|YES|是) return 0 ;;
      n|N|no|NO|否) return 1 ;;
      *) printf '请输入 y 或 n。\n' ;;
    esac
  done
}

pretty_path() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# ---------------------------------------------------------------------------
# 找到本地助手
# ---------------------------------------------------------------------------

ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64|armv8*) BINARY_NAME="bili-host-linux-arm64" ;;
  x86_64|amd64|x64)     BINARY_NAME="bili-host-linux-amd64" ;;
  armv7l|armv6l|arm*)
    die "本机是 32 位 ARM（$ARCH），本扩展只提供 64 位（arm64）助手。请使用 64 位系统。" ;;
  *)
    die "不支持的 CPU 架构：$ARCH（本扩展只提供 x86_64 与 arm64 的本地助手）" ;;
esac

SOURCE=""
for candidate in \
  "$SCRIPT_DIR/host/$BINARY_NAME" \
  "$SCRIPT_DIR/dist/hosts/$BINARY_NAME"; do
  if [ -f "$candidate" ]; then SOURCE="$candidate"; break; fi
done

if [ -z "$SOURCE" ]; then
  available=$(find "$SCRIPT_DIR/host" "$SCRIPT_DIR/dist/hosts" -maxdepth 1 -name 'bili-host-linux-*' -type f 2>/dev/null \
    | xargs -r -n1 basename | sort -u | tr '\n' ' ')
  die "找不到适用于 $ARCH 的本地助手（$BINARY_NAME）。
       包里现有：${available:-无}
       请确认下载的发布包与本机架构一致，或从源码运行 scripts/build.sh 重新构建。"
fi

if [ ! -f "$EXT_DIR/manifest.json" ]; then
  warn "当前目录下没有找到 extension/manifest.json。安装仍会继续，但加载扩展的步骤可能无法完成。"
fi

# ---------------------------------------------------------------------------
# 扩展 ID
# ---------------------------------------------------------------------------

# Chrome 用 manifest 的 key 推导扩展 ID：SHA-256(key) 前 32 个十六进制位，
# 每位 0-f 映射到 a-p。key 固定，所以 ID 是常量；有 python3 时再复算校验。
EXT_ID="khkbfeoekeinbdgbicojpgfidfihfffc"
if command -v python3 >/dev/null 2>&1; then
  COMPUTED=$(python3 - "$EXT_KEY" <<'PY' 2>/dev/null || true
import base64, hashlib, sys
key = base64.b64decode(sys.argv[1])
print("".join(chr(ord('a') + int(c, 16)) for c in hashlib.sha256(key).hexdigest()[:32]))
PY
)
  if [ -n "$COMPUTED" ] && [ "$COMPUTED" != "$EXT_ID" ]; then
    EXT_ID="$COMPUTED"
  fi
fi

# ---------------------------------------------------------------------------
# 浏览器清单
#
# 每一项记录：显示名称、配置目录、助手目录、扩展管理页地址、检测方式。
# kind:
#   standard  普通安装（~/.local/share + ~/.config）
#   snap      Snap 沙箱（助手放在 ~/snap/<app>/common/...）
#   flatpak   Flatpak 沙箱（助手放在 ~/.var/app/<id>/data/...）
# ---------------------------------------------------------------------------

B_LABEL=()
B_CONFIG=()
B_HELPER=()
B_EXT=()
B_KIND=()
B_DETECT=()
B_APPID=()

add_browser() {
  B_LABEL+=("$1")
  B_CONFIG+=("$2")
  B_HELPER+=("$3")
  B_EXT+=("$4")
  B_KIND+=("$5")
  B_DETECT+=("${6:-}")
  B_APPID+=("${7:-}")
}

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
STANDARD_HELPER="$DATA_HOME/bili-downloader"

# 普通安装的 Chromium 系浏览器
add_browser "Google Chrome" \
  "$CONFIG_HOME/google-chrome" "$STANDARD_HELPER" "chrome://extensions/" standard \
  "google-chrome google-chrome-stable /opt/google/chrome/chrome"
add_browser "Google Chrome Beta" \
  "$CONFIG_HOME/google-chrome-beta" "$STANDARD_HELPER" "chrome://extensions/" standard \
  "google-chrome-beta /opt/google/chrome-beta/chrome"
add_browser "Google Chrome Dev" \
  "$CONFIG_HOME/google-chrome-unstable" "$STANDARD_HELPER" "chrome://extensions/" standard \
  "google-chrome-unstable /opt/google/chrome-unstable/chrome"
add_browser "Chromium" \
  "$CONFIG_HOME/chromium" "$STANDARD_HELPER" "chrome://extensions/" standard \
  "chromium chromium-browser /usr/lib/chromium/chromium"
add_browser "Brave" \
  "$CONFIG_HOME/BraveSoftware/Brave-Browser" "$STANDARD_HELPER" "brave://extensions/" standard \
  "brave-browser brave /opt/brave.com/brave/brave"
add_browser "Microsoft Edge" \
  "$CONFIG_HOME/microsoft-edge" "$STANDARD_HELPER" "edge://extensions/" standard \
  "microsoft-edge microsoft-edge-stable /opt/microsoft/msedge/msedge"
add_browser "Vivaldi" \
  "$CONFIG_HOME/vivaldi" "$STANDARD_HELPER" "vivaldi://extensions/" standard \
  "vivaldi vivaldi-stable /opt/vivaldi/vivaldi"
add_browser "Opera" \
  "$CONFIG_HOME/opera" "$STANDARD_HELPER" "opera://extensions/" standard \
  "opera opera-stable /usr/lib/x86_64-linux-gnu/opera/opera /usr/lib/aarch64-linux-gnu/opera/opera"
add_browser "Yandex Browser" \
  "$CONFIG_HOME/yandex-browser" "$STANDARD_HELPER" "browser://extensions/" standard \
  "yandex-browser yandex-browser-stable"

# Snap Chromium：AppArmor 禁止读取隐藏的 $HOME 目录，必须放进 snap 自己的目录。
add_browser "Chromium（Snap）" \
  "$HOME/snap/chromium/common/chromium" \
  "$HOME/snap/chromium/common/bili-downloader" \
  "chrome://extensions/" snap "" "chromium"

# Flatpak：同理，助手放进各自应用可访问的 data 目录。
add_browser "Chromium（Flatpak）" \
  "$HOME/.var/app/org.chromium.Chromium/config/chromium" \
  "$HOME/.var/app/org.chromium.Chromium/data/bili-downloader" \
  "chrome://extensions/" flatpak "" "org.chromium.Chromium"
add_browser "Google Chrome（Flatpak）" \
  "$HOME/.var/app/com.google.Chrome/config/google-chrome" \
  "$HOME/.var/app/com.google.Chrome/data/bili-downloader" \
  "chrome://extensions/" flatpak "" "com.google.Chrome"
add_browser "Brave（Flatpak）" \
  "$HOME/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser" \
  "$HOME/.var/app/com.brave.Browser/data/bili-downloader" \
  "brave://extensions/" flatpak "" "com.brave.Browser"
add_browser "Microsoft Edge（Flatpak）" \
  "$HOME/.var/app/com.microsoft.Edge/config/microsoft-edge" \
  "$HOME/.var/app/com.microsoft.Edge/data/bili-downloader" \
  "edge://extensions/" flatpak "" "com.microsoft.Edge"
add_browser "Vivaldi（Flatpak）" \
  "$HOME/.var/app/com.vivaldi.Vivaldi/config/vivaldi" \
  "$HOME/.var/app/com.vivaldi.Vivaldi/data/bili-downloader" \
  "vivaldi://extensions/" flatpak "" "com.vivaldi.Vivaldi"

FLATPAK_APPS=""
if command -v flatpak >/dev/null 2>&1; then
  FLATPAK_APPS=$(flatpak list --app --columns=application 2>/dev/null || true)
fi

# 旧版脚本会预先创建空的配置目录；只有目录里有真实 profile 才算浏览器。
config_has_profile() {
  local dir="$1" entry
  [ -d "$dir" ] || return 1
  while IFS= read -r -d '' entry; do
    case "$(basename "$entry")" in
      NativeMessagingHosts) continue ;;
      *) return 0 ;;
    esac
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
  return 1
}

# snap 提供的命令不是普通安装的浏览器，不能算到 standard 条目里。
is_snap_path() {
  case "$(readlink -f "$1" 2>/dev/null)" in
    /snap/*|/var/lib/snapd/*|/usr/lib/snapd/*) return 0 ;;
  esac
  return 1
}

detect_browser() {
  local i="$1" probe resolved kind appid
  kind="${B_KIND[$i]}"
  case "$kind" in
    standard)
      for probe in ${B_DETECT[$i]}; do
        if [ "${probe#/}" != "$probe" ]; then
          [ -x "$probe" ] && ! is_snap_path "$probe" && return 0
          continue
        fi
        resolved=$(command -v "$probe" 2>/dev/null) || continue
        is_snap_path "$resolved" && continue
        # Ubuntu 的 chromium-browser 是 snap 过渡脚本。
        if [ "$probe" = "chromium-browser" ]; then
          [ -x /snap/bin/chromium ] && continue
          if head -c 2 "$resolved" 2>/dev/null | grep -q '#!' && grep -q 'snap' "$resolved" 2>/dev/null; then
            continue
          fi
        fi
        return 0
      done
      config_has_profile "${B_CONFIG[$i]}" && return 0
      ;;
    snap)
      [ -d "$HOME/snap/chromium" ] && return 0
      if command -v snap >/dev/null 2>&1; then
        snap list chromium >/dev/null 2>&1 && return 0
      fi
      ;;
    flatpak)
      appid="${B_APPID[$i]}"
      [ -d "$HOME/.var/app/$appid" ] && return 0
      if [ -n "$FLATPAK_APPS" ] && printf '%s\n' "$FLATPAK_APPS" | grep -Fxq "$appid"; then
        return 0
      fi
      ;;
  esac
  return 1
}

ACTIVE=()
B_STATUS=()
resolve_browsers() {
  local i
  ACTIVE=()
  B_STATUS=()
  for i in "${!B_LABEL[@]}"; do
    B_STATUS[$i]=""
    if detect_browser "$i"; then
      ACTIVE+=("$i")
      if [ -d "${B_CONFIG[$i]}" ]; then
        B_STATUS[$i]="已安装"
      else
        B_STATUS[$i]="未启动"
      fi
    fi
  done
}

resolve_browsers

# 一个浏览器都没检测到时，仍允许为最常见的两个位置预注册；用户装好浏览器
# 后第一次启动就能直接使用，不需要再运行脚本。
if [ ${#ACTIVE[@]} -eq 0 ]; then
  warn "没有检测到已安装的 Chromium 系浏览器。"
  info "你仍然可以预先注册 Chrome 或 Chromium；等浏览器安装并启动后即可生效。"
  add_browser "Google Chrome" \
    "$CONFIG_HOME/google-chrome" "$STANDARD_HELPER" "chrome://extensions/" standard \
    "google-chrome google-chrome-stable /opt/google/chrome/chrome"
  add_browser "Chromium" \
    "$CONFIG_HOME/chromium" "$STANDARD_HELPER" "chrome://extensions/" standard \
    "chromium chromium-browser /usr/lib/chromium/chromium"
  # 这两个是“预注册”项，即使当前检测不到也允许选择。
  first_fallback=$((${#B_LABEL[@]} - 2))
  ACTIVE=("$first_fallback" "$((first_fallback + 1))")
  for i in "${ACTIVE[@]}"; do
    B_STATUS[$i]="未检测到"
  done
fi

# ---------------------------------------------------------------------------
# 展示浏览器列表与改动
# ---------------------------------------------------------------------------

printf '%sBili 下载器 - 安装本地助手%s\n' "$C_BOLD" "$C_RESET"
info "检测到 ${#ACTIVE[@]} 个浏览器："
has_standard=0
has_sandbox=0
for n in "${!ACTIVE[@]}"; do
  i="${ACTIVE[$n]}"
  case "${B_KIND[$i]}" in
    standard) has_standard=1; change="清单 + 共用助手" ;;
    snap)     has_sandbox=1;  change="清单 + Snap 助手" ;;
    flatpak)  has_sandbox=1;  change="清单 + Flatpak 助手" ;;
    *)        change="清单" ;;
  esac
  printf '  %2d) %s [%s] · %s\n' "$((n + 1))" "${B_LABEL[$i]}" "${B_STATUS[$i]}" "$change"
done
info
info "  清单：<浏览器配置目录>/NativeMessagingHosts/$HOST_NAME.json"
if [ "$has_standard" -eq 1 ]; then
  info "  共用助手：$(pretty_path "$STANDARD_HELPER/bili-host")"
fi
if [ "$has_sandbox" -eq 1 ]; then
  info "  Snap/Flatpak 助手：放在各自沙箱可访问的目录。"
fi
info "  只写当前用户目录，不需要 sudo/root。"

# ---------------------------------------------------------------------------
# 多选
# ---------------------------------------------------------------------------

SELECTED=()
selection_count=${#ACTIVE[@]}

while [ ${#SELECTED[@]} -eq 0 ]; do
  printf '\n请输入要安装的浏览器编号（可多选，如 %s1 3%s 或 %s1,3%s）；all=全部，q=退出：' \
    "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  if ! read -r answer; then
    printf '\n已取消。\n'
    exit 0
  fi
  answer="${answer//，/,}"
  answer="${answer//、/,}"
  answer="${answer// /,}"
  answer="${answer//$'\t'/,}"
  case "$answer" in
    q|Q|quit|QUIT|退出) info "已取消。"; exit 0 ;;
    all|ALL|全部|a|A)
      SELECTED=("${ACTIVE[@]}")
      break
      ;;
  esac

  IFS=',' read -r -a tokens <<< "$answer"
  for token in "${tokens[@]}"; do
    token="${token//[$'\r\n']/}"
    [ -z "$token" ] && continue
    if ! [[ "$token" =~ ^[0-9]+$ ]]; then
      warn "「$token」不是有效编号。"
      SELECTED=()
      break
    fi
    n=$((token - 1))
    if [ "$n" -lt 0 ] || [ "$n" -ge "$selection_count" ]; then
      warn "编号 $token 不存在，请输入 1 到 $selection_count。"
      SELECTED=()
      break
    fi
    i="${ACTIVE[$n]}"
    duplicate=0
    for existing in "${SELECTED[@]}"; do
      [ "$existing" = "$i" ] && duplicate=1 && break
    done
    [ "$duplicate" -eq 0 ] && SELECTED+=("$i")
  done
done

# ---------------------------------------------------------------------------
# 第一次确认
# ---------------------------------------------------------------------------

selected_labels=()
for i in "${SELECTED[@]}"; do selected_labels+=("${B_LABEL[$i]}"); done
selected_text=$(IFS='、'; printf '%s' "${selected_labels[*]}")
info
info "即将安装：$selected_text"
if ! ask_yn "确认安装？" y; then
  info "已取消，没有做任何修改。"
  pause_exit
  exit 0
fi

# ---------------------------------------------------------------------------
# 检查旧文件（第二次确认）
# ---------------------------------------------------------------------------

CONFLICT_FILES=()
ENTRY_CONFLICT=()

add_conflict_file() {
  local f existing
  f="$1"
  for existing in "${CONFLICT_FILES[@]}"; do
    [ "$existing" = "$f" ] && return 0
  done
  CONFLICT_FILES+=("$f")
}

for i in "${SELECTED[@]}"; do
  ENTRY_CONFLICT[$i]=0
  for p in "${B_HELPER[$i]}/bili-host" "${B_CONFIG[$i]}/NativeMessagingHosts/$HOST_NAME.json"; do
    if [ -e "$p" ] || [ -L "$p" ]; then
      ENTRY_CONFLICT[$i]=1
      add_conflict_file "$p"
    fi
  done
done

if [ ${#CONFLICT_FILES[@]} -gt 0 ]; then
  info
  printf '%s发现旧文件（可能是之前版本遗留）：%s\n' "$C_YELLOW" "$C_RESET"
  for f in "${CONFLICT_FILES[@]}"; do
    printf '  • %s\n' "$(pretty_path "$f")"
  done
  info "  1) 覆盖并继续   2) 跳过有旧文件的浏览器   3) 取消（默认）"
  while true; do
    printf '请选择 [1/2/3]：'
    if ! read -r overwrite; then
      printf '\n已取消，没有做任何修改。\n'
      exit 0
    fi
    overwrite="${overwrite:-3}"
    case "$overwrite" in
      1)
        break
        ;;
      2)
        KEPT=()
        SKIPPED=()
        for i in "${SELECTED[@]}"; do
          if [ "${ENTRY_CONFLICT[$i]}" -eq 0 ]; then
            KEPT+=("$i")
          else
            SKIPPED+=("${B_LABEL[$i]}")
          fi
        done
        if [ ${#KEPT[@]} -eq 0 ]; then
          info "所有选中的浏览器都有旧文件，已取消。"
          pause_exit
          exit 0
        fi
        skipped_text=$(IFS='、'; printf '%s' "${SKIPPED[*]}")
        info "跳过：$skipped_text"
        SELECTED=("${KEPT[@]}")
        break
        ;;
      3|q|Q)
        info "已取消，没有做任何修改。"
        pause_exit
        exit 0
        ;;
      *)
        printf '请输入 1、2 或 3。\n'
        ;;
    esac
  done
fi

# ---------------------------------------------------------------------------
# 安装
# ---------------------------------------------------------------------------

manifest_for() {
  local bin
  bin=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Bili Downloader native host",
  "path": "$bin",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
}

INSTALLED=()
INSTALLED_LABELS=()
HELPERS_DONE=()
INSTALLED_BINS=()
FAILED=0

for i in "${SELECTED[@]}"; do
  label="${B_LABEL[$i]}"
  helper_dir="${B_HELPER[$i]}"
  binary="$helper_dir/bili-host"
  manifest="${B_CONFIG[$i]}/NativeMessagingHosts/$HOST_NAME.json"

  helper_ready=0
  for done_dir in "${HELPERS_DONE[@]}"; do
    [ "$done_dir" = "$helper_dir" ] && helper_ready=1 && break
  done

  if [ "$helper_ready" -eq 0 ]; then
    if ! mkdir -p "$helper_dir" 2>/dev/null; then
      err "无法创建目录 $(pretty_path "$helper_dir")"
      FAILED=$((FAILED + 1))
      continue
    fi
    if ! install -m 755 "$SOURCE" "$binary" 2>/dev/null; then
      if ! cp -f "$SOURCE" "$binary" 2>/dev/null || ! chmod 755 "$binary" 2>/dev/null; then
        err "无法复制本地助手到 $(pretty_path "$binary")"
        FAILED=$((FAILED + 1))
        continue
      fi
    fi
    HELPERS_DONE+=("$helper_dir")
    INSTALLED_BINS+=("$binary")
  fi

  if ! mkdir -p "$(dirname "$manifest")" 2>/dev/null; then
    err "无法创建清单目录 $(pretty_path "$(dirname "$manifest")")"
    FAILED=$((FAILED + 1))
    continue
  fi

  tmp_manifest="$(dirname "$manifest")/.$HOST_NAME.json.tmp.$$"
  if manifest_for "$binary" > "$tmp_manifest" 2>/dev/null && mv -f "$tmp_manifest" "$manifest" 2>/dev/null; then
    chmod 644 "$manifest" 2>/dev/null || true
    INSTALLED_LABELS+=("$label")
    INSTALLED+=("$i")
  else
    rm -f "$tmp_manifest" 2>/dev/null || true
    err "无法写入清单 $(pretty_path "$manifest")"
    FAILED=$((FAILED + 1))
  fi
done

info
if [ ${#INSTALLED[@]} -eq 0 ]; then
  die "没有安装成功任何浏览器。请检查上面的错误信息，或确认磁盘空间与目录权限。"
fi

if [ ${#INSTALLED_BINS[@]} -eq 1 ]; then
  ok "本地助手：$(pretty_path "${INSTALLED_BINS[0]}")"
elif [ ${#INSTALLED_BINS[@]} -gt 1 ]; then
  ok "本地助手已安装（${#INSTALLED_BINS[@]} 份）"
fi
installed_text=$(IFS='、'; printf '%s' "${INSTALLED_LABELS[*]}")
ok "已注册：$installed_text"
if [ "$FAILED" -gt 0 ]; then
  warn "有 $FAILED 个浏览器安装失败，详见上面的错误信息。"
fi

# ---------------------------------------------------------------------------
# 安装后的浏览器操作说明
# ---------------------------------------------------------------------------

DEFAULT_DIR=""
if [ ${#INSTALLED_BINS[@]} -gt 0 ]; then
  DEFAULT_DIR=$("${INSTALLED_BINS[0]}" default-dir 2>/dev/null || true)
fi
[ -n "$DEFAULT_DIR" ] || DEFAULT_DIR="$HOME/Downloads"

info
printf '%s安装完成。%s\n' "$C_BOLD$C_GREEN" "$C_RESET"
info
info "接下来在浏览器中操作（每个已安装的浏览器各做一次）："
info "  1. 打开扩展管理页："
for i in "${INSTALLED[@]}"; do
  info "     • ${B_LABEL[$i]}：${B_EXT[$i]}"
done
info "  2. 打开右上角「开发者模式」。"
info "  3. 点「加载已解压的扩展程序」，选择：$EXT_DIR"
info "  4. 完全退出浏览器再重新打开，让本地助手注册生效。"
info
info "扩展 ID：$EXT_ID · 默认下载：$DEFAULT_DIR"
info "工具栏没有 B 图标时，点右上角拼图图标固定即可。"
info "请保留 extension 目录；移动或删除后扩展会失效。"
info "仍提示助手未注册：到扩展页点「重新加载」，或重新运行本脚本。"

pause_exit
exit 0
