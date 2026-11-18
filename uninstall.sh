#!/usr/bin/env bash
# Bili 下载器 - Linux 本地助手交互式卸载脚本
#
# 直接运行即可，不需要任何命令行参数：
#
#   ./uninstall.sh
#
# 脚本会：
#   1. 检测本机有哪些 Chromium 系浏览器；
#   2. 标出哪些浏览器已注册、哪些目录里还有本地助手文件；
#   3. 让你多选要卸载的浏览器；
#   4. 确认后删除对应的清单和助手文件；
#   5. 提醒你到浏览器里移除扩展。
#
# 不会删除你下载的视频，也不会触碰浏览器书签、密码或其它扩展。

set -o pipefail

HOST_NAME="com.opencode.bili_downloader"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""
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

pretty_path() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

ask_uninstall() {
  local answer
  while true; do
    printf '确认卸载？[y/N] '
    if ! read -r answer; then
      printf '\n'
      return 1
    fi
    case "$answer" in
      "") return 1 ;;
      y|Y|yes|YES|是) return 0 ;;
      n|N|no|NO|否) return 1 ;;
      *) printf '请输入 y 或 n。\n' ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# 浏览器清单（与 install.sh 保持一致）
# ---------------------------------------------------------------------------

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
STANDARD_HELPER="$DATA_HOME/bili-downloader"

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

add_browser "Chromium（Snap）" \
  "$HOME/snap/chromium/common/chromium" \
  "$HOME/snap/chromium/common/bili-downloader" \
  "chrome://extensions/" snap "" "chromium"

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

manifest_path() { printf '%s/NativeMessagingHosts/%s.json' "${B_CONFIG[$1]}" "$HOST_NAME"; }
binary_path()   { printf '%s/bili-host' "${B_HELPER[$1]}"; }

# 只要浏览器被检测到、清单还在、或助手文件还在，就列出来。
ACTIVE=()
UNREGISTERED=()
B_STATUS=()
B_HAS_MANIFEST=()
B_HAS_BINARY=()
B_DETECTED=()

resolve_entries() {
  local i m b parts include standard_helper_present=0 standard_manifest=0
  ACTIVE=()
  UNREGISTERED=()
  B_STATUS=()
  for i in "${!B_LABEL[@]}"; do
    m=$(manifest_path "$i")
    b=$(binary_path "$i")
    B_HAS_MANIFEST[$i]=0
    B_HAS_BINARY[$i]=0
    B_DETECTED[$i]=0
    [ -f "$m" ] && B_HAS_MANIFEST[$i]=1
    [ -e "$b" ] && B_HAS_BINARY[$i]=1
    detect_browser "$i" && B_DETECTED[$i]=1

    # 普通浏览器的助手是共用的：没有清单就说明这个浏览器没有安装，
    # 不能因为共用目录里有 bili-host 就把它列成十个“已安装”。
    include=0
    if [ "${B_HAS_MANIFEST[$i]}" -eq 1 ]; then
      include=1
      [ "${B_KIND[$i]}" = "standard" ] && standard_manifest=1
    elif [ "${B_HAS_BINARY[$i]}" -eq 1 ] && [ "${B_KIND[$i]}" != "standard" ]; then
      include=1
    fi
    [ "${B_KIND[$i]}" = "standard" ] && [ -e "$STANDARD_HELPER/bili-host" ] && standard_helper_present=1
    if [ "$include" -eq 0 ]; then
      [ "${B_DETECTED[$i]}" -eq 1 ] && UNREGISTERED+=("${B_LABEL[$i]}")
      continue
    fi

    parts=()
    if [ "${B_HAS_MANIFEST[$i]}" -eq 1 ]; then
      parts+=("已注册")
    else
      parts+=("未注册")
    fi
    [ "${B_HAS_BINARY[$i]}" -eq 1 ] && parts+=("有助手")
    [ "${B_DETECTED[$i]}" -eq 0 ] && parts+=("浏览器缺失")
    B_STATUS[$i]=$(IFS=' + '; printf '%s' "${parts[*]}")
    ACTIVE+=("$i")
  done

  # 没有任何普通浏览器注册、但共用目录里还留着助手时，给出一个单独的
  # 清理项，否则这些残留文件永远不会被看到。
  if [ "$standard_helper_present" -eq 1 ] && [ "$standard_manifest" -eq 0 ]; then
    add_browser "本地助手文件（普通浏览器共用）" "" "$STANDARD_HELPER" "" standard "" ""
    i=$((${#B_LABEL[@]} - 1))
    B_HAS_MANIFEST[$i]=0
    B_HAS_BINARY[$i]=1
    B_DETECTED[$i]=0
    B_STATUS[$i]="残留，未注册"
    ACTIVE+=("$i")
  fi
}

resolve_entries

printf '%sBili 下载器 - 卸载本地助手%s\n' "$C_BOLD" "$C_RESET"
if [ ${#ACTIVE[@]} -eq 0 ]; then
  if [ ${#UNREGISTERED[@]} -gt 0 ]; then
    unregistered_text=$(IFS='、'; printf '%s' "${UNREGISTERED[*]}")
    info "未注册的浏览器：$unregistered_text"
  fi
  info "没有可卸载的本地助手。"
  pause_exit
  exit 0
fi

info "检测到 ${#ACTIVE[@]} 项："
for n in "${!ACTIVE[@]}"; do
  i="${ACTIVE[$n]}"
  printf '  %2d) %s [%s]\n' "$((n + 1))" "${B_LABEL[$i]}" "${B_STATUS[$i]}"
done
info "将删除所选清单；助手目录在无其它浏览器使用时删除。"

# ---------------------------------------------------------------------------
# 多选
# ---------------------------------------------------------------------------

SELECTED=()
entry_count=${#ACTIVE[@]}

while [ ${#SELECTED[@]} -eq 0 ]; do
  printf '\n请输入要卸载的浏览器编号（可多选，如 %s1 3%s 或 %s1,3%s）；all=全部，q=退出：' \
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
    if [ "$n" -lt 0 ] || [ "$n" -ge "$entry_count" ]; then
      warn "编号 $token 不存在，请输入 1 到 $entry_count。"
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

selected_labels=()
for i in "${SELECTED[@]}"; do selected_labels+=("${B_LABEL[$i]}"); done
selected_text=$(IFS='、'; printf '%s' "${selected_labels[*]}")
info
info "即将卸载：$selected_text"
info "不会删除已下载视频、书签或其它扩展。"
if ! ask_uninstall; then
  info "已取消，没有删除任何文件。"
  pause_exit
  exit 0
fi

# ---------------------------------------------------------------------------
# 执行删除
# ---------------------------------------------------------------------------

REMOVED_MANIFESTS=()
REMOVED_DIRS=()
KEPT_DIRS=()

helper_still_used() {
  local dir="$1" i m
  for i in "${!B_LABEL[@]}"; do
    m=$(manifest_path "$i")
    if [ -f "$m" ] && grep -Fq "$dir/bili-host" "$m" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

for i in "${SELECTED[@]}"; do
  m=$(manifest_path "$i")
  if [ -f "$m" ]; then
    if rm -f "$m" 2>/dev/null; then
      REMOVED_MANIFESTS+=("$m")
    else
      err "无法删除清单：$(pretty_path "$m")"
    fi
  fi
done

# 清单删除后再判断助手是否仍被未卸载的浏览器引用，避免误删共用的文件。
for i in "${SELECTED[@]}"; do
  dir="${B_HELPER[$i]}"
  [ -d "$dir" ] || continue

  duplicate=0
  for seen in "${REMOVED_DIRS[@]}" "${KEPT_DIRS[@]}"; do
    [ "$seen" = "$dir" ] && duplicate=1 && break
  done
  [ "$duplicate" -eq 1 ] && continue

  if helper_still_used "$dir"; then
    KEPT_DIRS+=("$dir")
  else
    if rm -rf "$dir" 2>/dev/null; then
      REMOVED_DIRS+=("$dir")
    else
      err "无法删除助手目录：$(pretty_path "$dir")"
    fi
  fi
done

# 顺手清理空的 NativeMessagingHosts 目录。
for i in "${SELECTED[@]}"; do
  [ -n "${B_CONFIG[$i]}" ] || continue
  nm_dir="${B_CONFIG[$i]}/NativeMessagingHosts"
  if [ -d "$nm_dir" ] && [ -z "$(ls -A "$nm_dir" 2>/dev/null)" ]; then
    rmdir "$nm_dir" 2>/dev/null || true
  fi
done

removed_parts=()
[ ${#REMOVED_MANIFESTS[@]} -gt 0 ] && removed_parts+=("${#REMOVED_MANIFESTS[@]} 个清单")
[ ${#REMOVED_DIRS[@]} -gt 0 ] && removed_parts+=("${#REMOVED_DIRS[@]} 个助手目录")
if [ ${#removed_parts[@]} -gt 0 ]; then
  removed_text=$(IFS='、'; printf '%s' "${removed_parts[*]}")
  ok "已删除 $removed_text。"
fi
if [ ${#KEPT_DIRS[@]} -gt 0 ]; then
  kept_text=""
  for dir in "${KEPT_DIRS[@]}"; do
    kept_text+="${kept_text:+、}$(pretty_path "$dir")"
  done
  info "助手目录保留（仍有浏览器使用）：$kept_text"
fi

# 如果所有已知浏览器都已不再注册，就可以安全清理下载临时文件和状态缓存。
REMAINING=()
for i in "${!B_LABEL[@]}"; do
  [ -f "$(manifest_path "$i")" ] && REMAINING+=("${B_LABEL[$i]}")
done

if [ ${#REMAINING[@]} -eq 0 ]; then
  rm -rf "${TMPDIR:-/tmp}/bili-downloader" 2>/dev/null || true
  rm -f "${TMPDIR:-/tmp}/bili-downloader-host.log" 2>/dev/null || true
  rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/bili-downloader" 2>/dev/null || true
  if [ -d "$STANDARD_HELPER" ] && [ -z "$(ls -A "$STANDARD_HELPER" 2>/dev/null)" ]; then
    rmdir "$STANDARD_HELPER" 2>/dev/null || true
  fi
else
  info "仍有浏览器使用本地助手，临时文件未清理。"
fi

info
info "卸载完成。"
BROWSER_REMINDER=0
for i in "${SELECTED[@]}"; do
  [ -n "${B_EXT[$i]}" ] || continue
  if [ "$BROWSER_REMINDER" -eq 0 ]; then
    info "最后到扩展页移除「Bili 下载器」："
    BROWSER_REMINDER=1
  fi
  info "  • ${B_LABEL[$i]}：${B_EXT[$i]}"
done
if [ "$BROWSER_REMINDER" -eq 0 ]; then
  info "本次只清理了残留助手文件。"
fi
info "若浏览器正开着，完全退出再打开。"

pause_exit
exit 0
