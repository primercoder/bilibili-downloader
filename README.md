# Bili 下载器

一个 Chrome / Chromium 扩展，用来下载 B 站网页视频，并直接合成为**普通 MP4**。
下载、合成全部在本机完成，不上传任何数据。

**不需要 Python，不需要 FFmpeg，不需要配置 PATH，也不需要管理员 / root 权限。**

## 功能

- 在任意 `https://www.bilibili.com/video/BV...` 视频页点击扩展图标即可下载。
- 自动使用页面登录态，列出**你的账号有权限的**清晰度（360P ~ 4K / HDR）。
- 编码可选：默认 **AVC（H.264，兼容性最好）**，也支持 HEVC / AV1。
- 支持**分 P 视频**，面板里可直接切换。
- **8 连接并行下载**，多 CDN 镜像自动测速与故障切换。
- **断点续传**：连接断开、进程退出、浏览器回收后台页面，都能从已下载的分段继续。
- 下载默认保存到系统**下载目录**，可在面板里修改。
- 后台下载：关掉面板不影响任务；工具栏图标显示预计剩余时间，完成后显示 ✓。
- 可选保留 `.m4s` 中间文件；默认合成后自动清理。
- 完成后可在面板里直接「打开所在文件夹」。

## 下载哪个包

| 你的系统 | 下载 |
| --- | --- |
| Windows 10 / 11（x64） | `bili-downloader-2.0.2-windows-x64.zip` |
| Linux x86_64 | `bili-downloader-2.0.2-linux-x64.tar.gz` |
| Linux ARM64 | `bili-downloader-2.0.2-linux-arm64.tar.gz` |

每个包都完整可用：里面同时包含扩展、对应架构的本地助手和说明文档。
如果你的机器是 32 位系统，本扩展不提供对应助手，请使用 64 位系统。

## Windows 安装

支持 Chrome、Edge、Brave、Chromium、Vivaldi。

### 1. 解压

下载 `bili-downloader-2.0.2-windows-x64.zip`，右键 → **全部解压到当前文件夹**。

> 一定要先解压。不要在压缩软件窗口里直接双击 `install.bat`，那样安装会失败。

解压后目录如下：

```
bili-downloader-2.0.2-windows-x64\
├── 先看这里.txt
├── install.bat
├── uninstall.bat
├── README.md
├── docs\
├── extension\
└── host\
    └── bili-host.exe
```

### 2. 双击 `install.bat`

窗口里出现「安装完成」后按任意键关闭即可。脚本只做三件事：

1. 把本地助手复制到你的用户目录；
2. 写入 native messaging 清单；
3. 在当前用户注册表（`HKCU`）中注册助手。

如果杀毒软件弹窗，选择「允许」。

### 3. 加载扩展

1. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）。
2. 打开右上角 **「开发者模式」**。
3. 点击 **「加载已解压的扩展程序」**。
4. 选择解压目录里的 **`extension`** 文件夹（不是它的上级目录）。
5. 工具栏出现粉色 **B** 图标。

### 4. 重启浏览器

完全退出浏览器再打开一次，让新注册的本地助手生效。

## Linux 安装

支持 Chrome、Chromium、Brave、Edge、Vivaldi，包括 Snap 和 Flatpak 版 Chromium。

### 1. 解压

根据架构选择包：

```bash
# x86_64
tar -xzf bili-downloader-2.0.2-linux-x64.tar.gz
cd bili-downloader-2.0.2-linux-x64

# ARM64
tar -xzf bili-downloader-2.0.2-linux-arm64.tar.gz
cd bili-downloader-2.0.2-linux-arm64
```

### 2. 运行安装脚本

```bash
./install.sh
```

没有执行权限时：

```bash
chmod +x install.sh && ./install.sh
```

脚本会自动识别系统架构和浏览器，安装对应助手并完成注册。
想先看会做什么而不改动系统，可以运行 `./install.sh --check`。

Snap / Flatpak 版 Chromium 的沙箱读不到 `~/.local`，脚本会自动把助手装到它们能访问的目录，无需手动配置。

### 3. 加载扩展

1. 打开 `chrome://extensions/`。
2. 打开右上角 **「开发者模式」**。
3. 点击 **「加载已解压的扩展程序」**。
4. 选择本目录下的 **`extension`** 文件夹。
5. 工具栏出现粉色 **B** 图标。

### 4. 重启浏览器

完全退出浏览器再打开一次，让本地助手注册生效。

## 使用

1. 打开任意 B 站视频页，例如 `https://www.bilibili.com/video/BV1xx411c7mD`。
2. 点击工具栏的粉色 **B** 图标。
3. 选择**清晰度 / 编码**和**音频**（默认已选好 AVC + 最佳音质）。
4. 多 P 视频可以在「分 P」里切换。
5. 需要改保存位置就点「选择」，或直接改输入框。
6. 点 **「下载 MP4」**。
7. 完成后点「打开所在文件夹」查看成品。

下载过程中可以关掉面板，任务会继续在后台运行，工具栏图标显示预计剩余时间。

**快捷键**：`Alt+Shift+B` 打开面板。与其他扩展冲突时，可在 `chrome://extensions/shortcuts` 修改。

### 面板状态

| 显示 | 含义 | 需要做什么 |
| --- | --- | --- |
| 解析下载地址 | 正在探测文件大小和 CDN 镜像 | 等待 |
| 下载视频流 / 音频流 | 分片并行下载中 | 等待 |
| 合成 MP4 | 内置引擎重排文件，不重新编码 | 等待，通常 1~2 秒 |
| 已下载 | 已校验通过 | 点「打开所在文件夹」 |
| 排队中 | 前面的任务完成后自动开始 | 等待 |
| 下载已中断 | 浏览器回收了扩展后台页面 | 点「继续下载」续传 |
| 下载失败 | 红框内会显示具体原因 | 见下方常见问题 |

## 常见问题

**提示「本地助手未安装或未注册」**
先运行安装脚本（Windows 双击 `install.bat`，Linux 运行 `./install.sh`），然后完全退出浏览器再打开。
仍不行时，到 `chrome://extensions/` 确认扩展 ID 为 `khkbfeoekeinbdgbicojpgfidfihfffc`，再重新运行一次安装脚本。

**清晰度只有 480P**
清晰度取决于账号权限：未登录一般最高 480P，登录后 1080P，大会员才有 1080P+ / 4K / HDR。

**下载到一半失败，要从头再来吗**
不用。已完成的字节会保留，重新点下载即可从断点继续。
如果面板显示「下载已中断」，点「继续下载」即可。

**提示「媒体地址已过期（HTTP 403）」**
扩展会自动刷新一次播放地址并续传；仍失败时刷新视频页后重新下载。

**Windows 双击 `install.bat` 一闪而过**
通常是直接在压缩包里运行的。请先完整解压，再运行。

**支持 macOS 吗**
当前只发布 Windows 和 Linux 包。macOS 可以从源码构建，但没有安装向导。

## 卸载

Windows：双击 `uninstall.bat`，然后到 `chrome://extensions/` 移除扩展。

Linux：

```bash
./uninstall.sh
```

然后到 `chrome://extensions/` 移除「Bili 下载器」。

## 说明

- 下载能力取决于账号权限；不支持直播、付费课程、DRM 保护内容。
- 番剧受版权与地区限制时可能无法获取播放地址。
- HEVC / AV1 成品需要播放器支持对应编码；默认优先选 AVC。
- 页面脚本只在 B 站视频页运行，只调用 B 站自己的 API，不导出 Cookie。
- 请遵守哔哩哔哩用户协议与视频作者的授权，仅保存你有权保存的内容。

## 从源码构建

需要 Go 1.21+（仅构建时需要）：

```bash
bash scripts/build.sh
```

产物在 `dist/`：Windows x64、Linux x64、Linux ARM64 三个平台包。详细实现见
[docs/how-it-works.md](docs/how-it-works.md)。

## 许可

仅供个人学习与备份使用。下载内容请遵守哔哩哔哩用户协议及相关法律法规。
