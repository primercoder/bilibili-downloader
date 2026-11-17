# Bili 下载器

一个 Chrome (Manifest V3) 扩展，用于下载 B 站网页视频的 **DASH 视频流 + 音频流**，并在本地用 FFmpeg 无损合成为 MP4。

## 功能

- 在任意 `https://www.bilibili.com/video/BV...` 视频页点击扩展图标，弹出 B 站风格下载面板。
- 自动读取页面登录态，支持当前账号有权限的清晰度（360P ~ 4K，取决于账号/视频）。
- 可分别选择视频编码（优先列出 AVC，兼容性最好）与音频码率。
- 可选保留视频和音频 `.m4s` 中间文件；关闭时合成后自动清理。
- 默认保存到系统下载目录：
  - Linux：读取 XDG 配置，通常是 `~/Downloads`
  - Windows：通常是 `%USERPROFILE%\Downloads`
- 面板内可直接编辑保存目录，或点击“选择…”调用系统文件夹选择器。
- 下载不会占用 Chrome 内存：由本地助手流式写入磁盘，支持 HTTP Range 断点续传、CDN 备用源切换、截断检测。
- 合成使用 `ffmpeg -c copy`，不重新编码，速度快且不损失画质；完成后用 `ffprobe` 检查音视频流是否齐全。

## 目录结构

```
extension/               Chrome MV3 扩展
  manifest.json
  background.js          Service Worker：页面提取 + Native Messaging 消息转发
  page-extractor.js      注入页面的登录态 API 请求
  popup.html/js/css      下载面板
  icons/
native_host/
  native_host.py         Native Messaging 本地助手（Python 标准库 + FFmpeg）
  install.py             注册 Linux/Windows 主机
  uninstall.py
tests/
  test_resume.py         模拟 CDN 提前断开，验证断点续传
  integration_native.py  真实视频端到端下载 + FFmpeg 合成 + ffprobe 校验
```

## 环境要求

- Chrome / Chromium（开发模式加载已解压扩展）
- Python 3.9+（本地助手）
- FFmpeg 与 ffprobe 在 `PATH` 中
  - Ubuntu/Debian：`sudo apt install ffmpeg python3`
  - Windows：`winget install Gyan.FFmpeg`，重新打开终端后执行 `ffmpeg -version` 确认

## 安装

### Linux

```bash
cd bilibili-downloader
python3 native_host/install.py
```

然后在 Chrome 打开 `chrome://extensions/`：

1. 打开右上角“开发者模式”。
2. 点击“加载已解压的扩展程序”。
3. 选择本项目的 `extension` 文件夹。
4. 进入一个 B 站视频页，点击工具栏里的粉色 B 图标。

如果扩展 ID 与安装时打印的不一致（例如改了 `manifest.json` 的 `key`），重新运行安装脚本即可。

### Windows

先安装 Python 3 和 FFmpeg，然后在 PowerShell 中执行：

```powershell
cd bilibili-downloader
python native_host\install.py
```

脚本会生成一个小型 `launcher.exe` 用于启动 Python 助手，并在当前用户注册表中注册 Native Messaging 主机。随后按上面相同步骤在 Chrome 加载 `extension` 文件夹。

> 如果系统策略禁止运行 Python 脚本，请确保使用官方 Python 安装包，而不是 Microsoft Store 的占位 `python.exe`。

## 使用

1. 打开视频页面（支持分 P，当前 URL 的 `p` 参数会被识别）。
2. 点击扩展图标。
3. 选择清晰度、编码、音频质量。
4. 按需打开“保留视频、音频中间文件”。
5. 点击“下载并合成”。
6. 完成后面板会显示最终路径；保持下载面板关闭也可以，任务在本地助手运行。

快捷键：`Alt+Shift+B` 尝试打开面板（若被其他扩展占用，可在 `chrome://extensions/shortcuts` 调整）。

## 测试

```bash
python3 -m py_compile native_host/native_host.py
node --check extension/background.js
node --check extension/popup.js
node --check extension/page-extractor.js
python3 tests/test_resume.py
python3 tests/integration_native.py   # 会真实下载测试视频，约 73 MB
```

`integration_native.py` 会在 `/tmp/opencode/bili-test-output/` 生成测试文件，并断言视频流和音频流时长一致，避免把 CDN 截断的文件误判为成功。

## 设计说明

### 为什么需要本地助手

Chrome 扩展的 `chrome.downloads` 无法合并 DASH 音视频；纯浏览器方案需要捆绑数十 MB 的 ffmpeg.wasm，并且 4K 视频会遇到内存上限。这里让扩展只负责页面解析和 UI，下载与合成都交给系统现有的 FFmpeg，更稳定，也能处理大文件。

### 安全边界

- 页面提取脚本只在 B 站视频页的 MAIN world 运行，只调用 B 站自己的 API，不导出 Cookie。
- Native Messaging 白名单只允许固定扩展 ID（`manifest.json` 中的 `key` 保证 ID 稳定）。
- 本地助手只接受 `https://` 媒体地址，并使用 B 站 `Referer` 请求 CDN；不接受任意 shell 命令。
- 助手日志仅存储在临时目录，不包含 URL 或登录信息。

### 已知限制

- 下载能力取决于账号权限；未登录或大会员内容可能只返回较低清晰度/无流。
- 仅支持普通视频 DASH，不处理直播、番剧 DRM、付费课程等受保护内容。
- AV1/HEVC 成品需要播放器支持对应编码；默认优先 AVC。
- 下载时请遵守 B 站服务条款及视频作者授权，仅保存你有权保存的内容。

## 卸载

```bash
python3 native_host/uninstall.py
```

然后在 `chrome://extensions/` 中移除“Bili 下载器”。
