# Bili 下载器

一个 Chrome / Chromium 扩展，用来下载 B 站网页视频，并直接合成为**普通 MP4**（不是需要特殊播放器的 `.m4s` 片段）。

**不需要安装 Python，不需要安装 FFmpeg，不需要配置 PATH，不需要管理员权限。**

---

## 目录

- [它解决了什么问题](#它解决了什么问题)
- [功能](#功能)
- [Windows 安装（推荐，3 步）](#windows-安装推荐3-步)
- [Linux 安装（3 步）](#linux-安装3-步)
- [使用](#使用)
- [常见问题](#常见问题)
- [从源码构建](#从源码构建)
- [性能数据](#性能数据)
- [工作原理](#工作原理)（详细版见 [docs/how-it-works.md](docs/how-it-works.md)）
- [使用与排错速查](docs/usage.md)
- [卸载](#卸载)
- [已知限制](#已知限制)

---

## 它解决了什么问题

上一版（1.x）有三个真实存在的问题，这一版逐个修掉了：

| 问题 | 原因 | 现在的做法 |
| --- | --- | --- |
| **下载完一个视频后，再也下载不了第二个，必须重启扩展** | 扩展把「上一个任务已完成」当成全局状态，之后每次打开面板都直接复用这个旧结果，不再重新读取页面；同时本地助手在任务异常结束时不会释放任务槽，新任务被永久拒绝 | 状态改为**按标签页隔离**，每次打开面板都重新读取当前页面；助手改为**任务队列**，任务结束（含失败、取消）一定释放槽位，新任务排队并自动开始 |
| **刚开始下载很快，之后就慢下来** | B 站 CDN 对**单个 TCP 连接**限速，且限速在传输持续一段时间后才生效 | 改成**多连接分片下载 + 镜像轮换**：把文件切成 4 MiB 分片，用 8 个连接并行拉取，并在 API 返回的多个 CDN 镜像之间自动选快的、自动踢掉坏的 |
| **必须自己装 FFmpeg，Windows 用户配置很痛苦** | 旧版把合成外包给系统 `ffmpeg`，用户要装它、配 PATH、还常被 Microsoft Store 的假 `python.exe` / 权限问题卡住 | **内置 Go 合成引擎**，直接把 B 站的 fragmented MP4 重排成标准 progressive MP4，与 `ffmpeg -c copy` 结果一致，零外部依赖 |

此外还修了几个顺带发现的问题：

- 部分视频的分片里**不写每帧时长**（只靠 `tfdt` 时间戳），旧逻辑会解析出 0 秒时长，播放器直接拒绝 —— 现在从时间戳重建时长。
- B 站源文件自带 `elst`（编辑列表），原样搬到成品里会让播放器把整段视频读成 0.04 秒 —— 现在合成时丢弃它。
- 扩展 ID 的计算、Snap / Flatpak 版 Chromium 读不到隐藏目录等平台坑，都已在安装脚本里自动处理。

---

## 功能

- 在任意 `https://www.bilibili.com/video/BV...` 视频页点击扩展图标即可下载。
- 自动使用页面登录态，列出**你的账号有权限的**清晰度（360P ~ 4K / HDR，取决于账号与视频）。
- 编码可选：优先列出 **AVC（H.264，兼容性最好）**，也支持 HEVC / AV1。
- 支持**分 P 视频**，面板里可直接切换。
- 多线程分段下载，**支持断点续传**：连接断了、进程被杀了，重下会从已完成的字节继续，不会从 0 开始。
- **后台被回收也能续传**：Chrome 会回收扩展的后台页面，这会让下载中断。本扩展会记住任务，重新打开面板时显示「下载已中断」并提供**一键续传**，已下载的分段不会浪费。
- 多 CDN 镜像自动测速与故障切换：某个镜像变慢或报错，流量会自动转移到其它镜像。
- 下载默认保存到系统**下载目录**（Windows 是 `下载` 文件夹，Linux 读取 XDG 配置），可在面板里改。
- 可选保留 `.m4s` 中间文件；默认合成后自动清理。
- 完成后可在面板里直接「打开所在文件夹」。
- 支持后台下载：关掉面板不影响下载，浏览器工具栏图标会显示进度百分比。

---

## Windows 安装（推荐，3 步）

> 适用于 Windows 10 / 11，Chrome、Edge、Brave、Chromium、Vivaldi 都可以。
> **不需要**安装 Python、FFmpeg 或任何运行库，也不需要管理员权限。

### 第 1 步：解压

1. 下载 `bili-downloader-<版本>-windows-x64.zip`。
2. 右键 → **全部解压到当前文件夹**。

> ⚠️ 一定要先解压。**不要在压缩软件窗口里直接双击 `install.bat`**，那样文件是只读的，安装会失败。

解压后应该能看到：

```
bili-downloader-2.0.0-windows\
├── 先看这里.txt         <- 三步快速开始（也可以用记事本打开）
├── install.bat          <- 待会双击这个
├── uninstall.bat
├── README.md            <- 完整说明
├── docs\
│   ├── usage.md         <- 使用与排错速查
│   └── how-it-works.md  <- 运行原理
├── extension\           <- 待会要加载这个文件夹
└── host\
    └── bili-host.exe    <- 本地助手（由 install.bat 安装）
```

### 第 2 步：双击 `install.bat`

会弹出一个黑色窗口，几秒内完成，出现类似输出就说明成功了：

```
[1/3] 本地助手已就绪: C:\Users\你\AppData\Local\BiliDownloader\bili-host.exe
[2/3] 已生成清单: C:\Users\你\AppData\Local\BiliDownloader\com.opencode.bili_downloader.json
      扩展 ID: khkbfeoekeinbdgbicojpgfidfihfffc
[3/3] 本地助手注册完成。
      - Chrome: 已注册
      - Edge: 已注册
```

窗口里会显示「安装完成」，按任意键关闭即可。

> 如果杀毒软件弹窗，选择「允许」。脚本只做三件事：复制一个 exe 到你的用户目录、写一个 json 清单、在 `HKCU`（当前用户，非系统级）里加注册表项。

### 第 3 步：在浏览器里加载扩展

1. 地址栏打开 `chrome://extensions/`
   （Edge 是 `edge://extensions/`）
2. 打开右上角的 **「开发者模式」** 开关
3. 点击左上角 **「加载已解压的扩展程序」**
4. 选择解压出来的 **`extension`** 文件夹（不是它的上级目录）
5. 工具栏出现粉色的 **B** 图标，安装完成

> 如果图标没显示，点一下工具栏的拼图图标，把「Bili 下载器」固定到工具栏。

**最后：如果浏览器当时是开着的，请完全退出再重新打开一次**——这样新注册的本地助手才会被浏览器读到。

---

## Linux 安装（3 步）

> 适用于 Chrome、Chromium、Brave、Edge、Vivaldi，包括 **Snap** 和 **Flatpak** 版 Chromium。
> 不需要 root、不需要 Python、不需要 FFmpeg。

### 第 1 步：解压

```bash
tar -xzf bili-downloader-<版本>-linux-x64.tar.gz
cd bili-downloader-<版本>-linux
```

解压后应该能看到：

```
bili-downloader-2.0.0-linux/
├── install.sh           <- 待会运行这个
├── uninstall.sh
├── README.md            <- 完整说明
├── docs/
│   ├── usage.md         <- 使用与排错速查
│   └── how-it-works.md  <- 运行原理
├── extension/           <- 待会要加载这个文件夹
└── host/
    ├── bili-host-linux-amd64
    └── bili-host-linux-arm64
```

### 第 2 步：运行安装脚本

```bash
./install.sh
```

如果提示没有执行权限：

```bash
chmod +x install.sh && ./install.sh
```

脚本会输出类似内容：

```
常规浏览器（Chrome / Chromium / Brave / Edge / Vivaldi）
  已安装 本地助手: /home/你/.local/share/bili-downloader/bili-host
  已注册 google-chrome
  已注册 chromium

Snap Chromium（AppArmor 沙箱，需要单独目录）
  已安装 本地助手（Snap）: /home/你/snap/chromium/common/bili-downloader/bili-host
  已注册 Snap Chromium

扩展 ID: khkbfeoekeinbdgbicojpgfidfihfffc
```

> 想先看会做什么、不改动系统：`./install.sh --check`

### 第 3 步：在浏览器里加载扩展

1. 打开 `chrome://extensions/`
2. 打开右上角 **「开发者模式」**
3. 点 **「加载已解压的扩展程序」**
4. 选择本目录下的 **`extension`** 文件夹
5. 工具栏出现粉色 **B** 图标

**最后：完全退出浏览器再重新打开一次**，让本地助手注册生效。

### 关于 Snap / Flatpak 版 Chromium

Snap 和 Flatpak 版的 Chromium 有沙箱限制，**读不到 `~/.local` 这类隐藏目录**。
`install.sh` 会自动检测，并把助手和清单装到 Snap / Flatpak 自己的数据目录里，你不需要做任何额外配置。

---

## 使用

1. 打开任意 B 站视频页，例如 `https://www.bilibili.com/video/BV1xx411c7mD`
2. 点击工具栏的粉色 **B** 图标
3. 选择**清晰度 / 编码**、**音频质量**（默认已选好 1080P AVC + 最佳音频）
4. 分 P 视频可以在「分 P 选择」里切换
5. 需要改保存位置就点「选择…」，或直接改输入框
6. 点 **「下载并合成 MP4」**
7. 完成后点「打开所在文件夹」即可看到成品

下载过程中可以关掉面板，任务会继续在后台跑；工具栏图标上的数字就是进度百分比。

**快捷键**：`Alt+Shift+B` 打开面板（若与其他扩展冲突，可在 `chrome://extensions/shortcuts` 修改）。

面板各状态的含义、按现象查原因的表，见 **[docs/usage.md](docs/usage.md)**（安装包里也带了一份，在 `docs/usage.md`）。

---

## 常见问题

### 提示「本地助手未安装或未注册」

按顺序检查：

1. **是否运行过安装脚本？** Windows 是双击 `install.bat`，Linux 是 `./install.sh`。
2. **是否重启过浏览器？** 注册后必须重启一次浏览器（或者到 `chrome://extensions/` 点扩展的「重新加载」按钮）。
3. **扩展 ID 是否一致？** 打开 `chrome://extensions/`，在「Bili 下载器」卡片上能看到 ID，应该是
   `khkbfeoekeinbdgbicojpgfidfihfffc`。如果不一致，重新运行一次安装脚本即可（脚本会自动识别新 ID）。
4. **Linux Snap 用户**：确认运行过新版 `./install.sh`，它会额外注册 Snap 专用路径。

### 下载完成后「再点就没反应」

这是 1.x 的 bug，2.0 已修复。如果你还在用旧版，重新加载扩展即可。
新版每次打开面板都会重新读取当前页面，任务状态按标签页隔离，不会互相影响。

### 下载速度慢 / 中途变慢

2.0 已经默认 8 连接并行。如果仍然慢：

- 在面板里看「速度」和「CDN x/y」：如果 CDN 掉到 `1/1`，说明可用的镜像变少了，通常是网络或账号被限流。
- 换一个清晰度试试（高码率视频更容易触发 CDN 限速）。
- 暂停其他占用带宽的程序。

### 下载到一半失败，要从头再来吗

**不用。** 每个分片下载完就立刻按最终偏移写入磁盘，失败或关闭后会保留进度。重新点下载，会从已完成的片段继续，面板会显示「续传 x/y 段」。

如果面板显示 **「下载已中断」**（Chrome 回收了扩展后台页面时会出现），点「继续下载（从断点续传）」即可，已下载的部分不会重新下载。

### 提示「媒体地址已过期（HTTP 403）」

B 站的播放地址带时效签名。扩展会自动重新读取一次页面地址并续传；如果仍失败，刷新视频页后重新点下载即可。

### 视频清晰度不全 / 只有 480P

清晰度取决于**你的账号**：未登录一般最高 480P，登录后 1080P，大会员才有 1080P+ / 4K / HDR。请在浏览器里正常登录 B 站后再使用。

### 合成失败 / 播放器打不开

2.0 使用内置合成引擎，成品是标准 MP4（H.264 + AAC，`moov` 在文件头部，可边下边播）。
如果某个播放器仍打不开，可以先确认文件能被系统播放器打开；必要时在面板里勾选「保留视频、音频中间文件」，把 `.m4s` 文件反馈出来。

### Windows：`install.bat` 一闪而过

说明是直接在压缩包里双击运行的。**先完整解压，再运行**。

### Windows：提示找不到 `bili-host.exe`

确认解压后 `host\bili-host.exe` 存在。如果被杀毒软件删了，请把它加入白名单后重新解压。

### macOS

本版本只发布 Windows 和 Linux 包。源码支持 macOS（`go build` 交叉编译即可），但没有做安装向导。

---

## 从源码构建

需要 Go 1.21+（构建时），运行成品时不需要任何依赖。

```bash
# 构建所有二进制和发布包
bash scripts/build.sh
```

产物：

```
dist/
├── bili-downloader-2.0.0-windows-x64.zip      # Windows 完整包（扩展 + 助手 + 文档）
├── bili-downloader-2.0.0-linux-x64.tar.gz     # Linux 完整包（扩展 + 助手 + 文档）
└── hosts/
    ├── bili-host-linux-amd64                  # 静态链接，无 glibc 依赖
    ├── bili-host-linux-arm64
    └── bili-host-windows-amd64.exe
```

> 不再单独产出扩展 zip。扩展离开本地助手无法下载任何东西，单独分发只会让人误下错包，
> 因此扩展始终和所需的助手一起打包在平台包里。

### 开发时手动加载

```bash
go build -C native_host -o ../dist/hosts/bili-host-linux-amd64 .
./install.sh
# 然后用 chromium --load-extension=$PWD/extension 启动，或手动「加载已解压的扩展程序」
```

### 测试

```bash
# 单元测试（合成器、下载器、任务队列、时长重建）
cd native_host && go test ./...

# 竞态检测
cd native_host && go test -race ./...

# 端到端：真实 B 站视频 -> 下载 -> 合成 -> ffprobe 校验
python3 tests/e2e_native.py

# 真实浏览器测试（需要先用 --load-extension 启动 Chromium）
chromium --remote-debugging-port=9222 --load-extension=$PWD/extension &

# 连续下载两个视频（验证「下载完还能继续下」这个老 bug）
BILI_EXTENSION_ID=khkbfeoekeinbdgbicojpgfidfihfffc node tests/browser_drive.mjs

# 分 P / HEVC / 任务排队
BILI_EXTENSION_ID=khkbfeoekeinbdgbicojpgfidfihfffc node tests/browser_extra.mjs

# 后台被回收后的中断与续传
BILI_EXTENSION_ID=khkbfeoekeinbdgbicojpgfidfihfffc node tests/browser_interrupt.mjs

# CDN 多连接吞吐基准
python3 tests/bench_cdn.py --seconds 15 --connections 1 4 8
```

测试样本在 `tests/fixtures/`（约 5.7 MB，覆盖两种 B 站分片格式），可用
`python3 tests/fetch_fixtures.py` 重新生成。

---

## 性能数据

同一台机器、同一个 B 站源，持续传输 15 秒的实测（`tests/bench_cdn.py`）：

| 连接数 | 持续吞吐 | 相对速度 |
| --- | --- | --- |
| 1 | 10.3 MB/s | 1.00x |
| 4 | 29.7 MB/s | 2.88x |
| 8 | **59.2 MB/s** | **5.74x** |

这就是「先快后慢」的根源：单连接在前几秒能跑满带宽，之后被 CDN 限速；多连接则一直保持高速。

完整下载实测（79.5 MiB / 801 秒的 1080P 视频）：**约 2.1 秒完成下载 + 合成**。

---

## 工作原理

```
┌──────────────────────────────┐
│ 扩展 (MV3)                    │
│  popup  面板与进度             │
│  background  页面提取 / 状态   │
│  page-extractor  读取登录态    │
└──────────────┬───────────────┘
               │ Native Messaging (stdio)
┌──────────────▼───────────────┐
│ 本地助手 (Go, 单文件二进制)     │
│  探测：文件大小 + 镜像测速      │
│  下载：8 连接 × 4 MiB 分片      │
│        失败自动换镜像          │
│        按最终偏移写入 → 续传    │
│  合成：内置 MP4 重排引擎        │
│  校验：索引 / 时长 / 字节数     │
└──────────────────────────────┘
```

**为什么需要本地助手**：浏览器的 `chrome.downloads` 无法并行分片写入指定偏移，也无法合并 DASH 音视频；纯浏览器方案要么内存爆掉（4K 视频），要么只能依赖几十 MB 的 ffmpeg.wasm。让扩展只做页面解析和 UI，把下载与合成交给本地进程，才能做到多连接、可续传、低内存。

**为什么不用 FFmpeg**：B 站的 `.m4s` 本身是标准 fragmented MP4。内置引擎把 `moof`/`mdat` 片段抽出来，重建完整的 `stbl` 索引（`stts` / `ctts` / `stss` / `stsc` / `stco` / `stsz`），再按 progressive MP4 布局写出。这样成品和 `ffmpeg -c copy` 一致，但用户什么都不用装。

页面识别、下载链接获取、多连接调度、临时文件生命周期、音视频合并细节以及两个平台各自的配置差异，见 **[docs/how-it-works.md](docs/how-it-works.md)**。

**安全边界**：

- 页面脚本只在 B 站视频页的 MAIN world 运行，只调用 B 站自己的 API，**不导出 Cookie**。
- Native Messaging 白名单只允许固定扩展 ID（`manifest.json` 里的 `key` 保证 ID 稳定）。
- 本地助手只接受 `https://` 媒体地址（回环地址仅用于测试），不接受任意 shell 命令。
- 日志只写到系统临时目录，不含 URL 或登录信息。

---

## 卸载

**Windows**：双击 `uninstall.bat`，然后在 `chrome://extensions/` 移除扩展。

**Linux**：

```bash
./uninstall.sh
```

然后在 `chrome://extensions/` 移除「Bili 下载器」。

---

## 已知限制

- 下载能力取决于账号权限；未登录或大会员内容可能只返回较低清晰度。
- 支持普通视频与番剧（部分）；**不支持**直播、付费课程、DRM 保护内容。
- 番剧受版权与地区限制时可能无法获取播放地址。
- AV1 / HEVC 成品需要播放器支持对应编码；默认优先选 AVC。
- 只下载单条视频轨道 + 单条音频轨道（B 站 DASH 的标准形态），不支持杜比全景声多轨。
- 请遵守 B 站服务条款与视频作者的授权，仅保存你有权保存的内容。

---

## 许可

仅供个人学习与备份使用。下载内容请遵守哔哩哔哩用户协议及相关法律法规。
