# 运行原理

本文按一次完整下载的时序，说明每个环节的真实实现。所有描述都对应仓库中的代码，不是设计意图。

对应文件：

| 文件 | 职责 |
| --- | --- |
| `extension/manifest.json` | 权限与固定扩展 ID |
| `extension/popup.html` / `popup.js` / `popup.css` | 面板：选择清晰度、显示进度 |
| `extension/background.js` | Service worker：页面提取调度、任务状态、Native Messaging 桥 |
| `extension/page-extractor.js` | 注入 B 站页面 MAIN world，读取登录态与播放地址 |
| `native_host/downloader.go` | 多连接分片下载、镜像调度、断点续传 |
| `native_host/mux.go` | 内置 MP4 重排引擎（fMP4 → progressive MP4） |
| `native_host/verify.go` | 成品结构校验 |
| `native_host/jobs.go` | 任务队列、临时文件生命周期、进度合成 |
| `native_host/platform.go` | 两平台的路径、对话框、打开目录 |

---

## 1. 整体架构

```
Chrome 扩展 (MV3)                      本地助手 (Go 单文件二进制)
┌──────────────────────┐              ┌──────────────────────────┐
│ popup.html/js        │              │ 探测 + 多连接分片下载     │
│ background.js        │◄─Native─────►│ 断点续传 + CDN 切换       │
│ page-extractor.js    │  Messaging   │ 内置 MP4 合成 + 校验      │
└──────────────────────┘  (stdio)     └──────────────────────────┘
```

**为什么拆成两部分**

浏览器的 `chrome.downloads` 无法按字节偏移并行写入同一个文件，也无法合并 DASH 的音视频轨。纯浏览器方案要么把整个视频读进内存（4K 视频会直接吃满），要么打包几十 MB 的 ffmpeg.wasm。

所以扩展只做两件事：**读取页面**、**显示界面**；下载与同步交给本地进程。这样才有条件做多连接、字节级续传和低内存合成。

---

## 2. 页面识别

识别分两层。

### 2.1 URL 白名单

`background.js` 的 `isVideoUrl`：

```js
/(^https:\/\/www\.bilibili\.com\/(video|bangumi)\/)/
```

只接受 `bilibili.com/video/*` 与 `bilibili.com/bangumi/play/*`。在其它页面点图标，面板直接提示“请先打开 Bilibili 视频页面”。

### 2.2 从路径解析标识

| 页面类型 | 正则 | 结果 |
| --- | --- | --- |
| 普通视频 | `/video/(BV[0-9A-Za-z]+|av\d+)/` | `bvid`，或旧式 `av` 号 |
| 番剧 | `/bangumi/play/(ep\d+|ss\d+)/` | 从 `__INITIAL_STATE__` 或 season 接口解析当前集，再换取 `bvid` + `cid` |

分 P 由 URL 的 `?p=N` 决定；番剧由页面状态定位当前集。面板切换分 P / 选集时，扩展先注入页面作用域变量 `window.__biliDownloaderPage` 再执行提取脚本，执行完立刻清 0，避免污染下一次调用。

### 2.3 为什么能拿到登录态

提取脚本通过以下方式注入：

```js
chrome.scripting.executeScript({ target, world: "MAIN", files: ["page-extractor.js"] })
```

`world: "MAIN"` 表示脚本运行在页面自己的 JS 上下文里，与 B 站前端同源同会话，因此 `fetch` 天然携带 Cookie，`playurl` 会返回该账号有权限的清晰度。

安全边界：脚本**只导出流地址**，返回对象里只有 `bvid`、标题、清晰度列表和 `https://` 开头的媒体 URL，**不读取也不转发 Cookie**。

---

## 3. 下载链接获取

### 3.1 先取 cid

```
GET https://api.bilibili.com/x/web-interface/view?bvid=BVxxx
```

取 `data.title` 与 `data.pages[]`（每个分 P 的 `cid`、时长、标题）。

### 3.2 再取 DASH 播放地址

有两条路径，优先第一条。

**路径 A：复用播放器已取回的数据**

页面上的 `window.__playinfo__` 是 B 站播放器自己请求的结果。若其 `cid` 与当前分 P 一致，直接使用——省掉一次接口往返，也避免“面板地址与播放器不一致”。

**路径 B：主动请求**

`__playinfo__` 不存在或 `cid` 不匹配时：

```
GET https://api.bilibili.com/x/player/playurl
    ?bvid=BVxxx&cid=<cid>&fnval=4048&fnver=0&fourk=1&qn=127
```

番剧 / 影视页面优先使用 PGC 接口，再退回上面的普通接口：

```
GET https://api.bilibili.com/pgc/player/web/playurl
    ?ep_id=<ep>&cid=<cid>&bvid=BVxxx&fnval=4048&fnver=0&fourk=1&qn=127
```

PGC 接口的播放数据在 `result` 字段，普通接口在 `data` 字段；提取脚本两者都兼容。

| 参数 | 含义 |
| --- | --- |
| `fnval=4048` | 要求 DASH（而非旧式 FLV），并开启杜比 / FLAC |
| `fnver=0` | 接口版本 |
| `fourk=1` | 允许 4K |
| `qn=127` | 请求最高清晰度 |

请求带 `credentials: "include"`，因此使用当前登录态。

### 3.3 实际用到的返回字段

| 字段 | 用途 |
| --- | --- |
| `data.dash.video[]` | 每项含 `id`（清晰度）、`codecs`、`width`/`height`、`frameRate`、`bandwidth`、`baseUrl`、`backupUrl[]` |
| `data.dash.audio[]` | 独立音频流（B 站 DASH 音视频分离） |
| `dash.dolby.audio`、`dash.flac.audio` | 杜比 / 无损音轨，存在时一并列出 |
| `accept_quality` + `accept_description` | 把数字 ID 映射为“高清 1080P”这类名称 |

每个流得到 **1 个主地址 + 最多 2 个备用镜像**（`baseUrl` + `backupUrl`）。所有地址都经 `startsWith("https://")` 过滤，这是后续镜像切换的基础。

**清晰度选择策略**：优先 **AVC（H.264）**，兼容性最好；默认选 1080P 的 AVC，没有则退到 1080P 以下最高的 AVC。HEVC / AV1 排在后面，仍可手动选择。

### 3.4 地址会过期

这些地址带时效签名，过期后返回 `403`。扩展检测到 `HTTP 403` 会自动重新提取一次页面地址并续传（`background.js` 的 `retryWithFreshUrls`），无需手动刷新。

---

## 4. 下载方式

核心是**多连接分片 + 断点续传 + 镜像自动切换**。

### 4.1 探测（几乎不耗流量）

对每个镜像发一个 `Range: bytes=0-0` 请求（1 字节）：

- 从 `Content-Range: bytes 0-0/76666968` 得到**文件总大小**
- 顺便测出每个镜像的**响应延迟**
- 确认服务器是否支持 `206 Partial Content`；不支持则退回单连接模式

### 4.2 切片

固定 **4 MiB** 一片，共 `ceil(总大小 / 4MiB)` 个片段。

### 4.3 并行拉取

- 默认 **8 个 worker**，上限 16
- 每个 worker 从队列取片段，发 `Range: bytes=start-end`
- 数据到达后用 **`file.WriteAt(buf, start+已写入)`** 写到文件的**最终位置**

`WriteAt` 是关键：字节一落地就在它该在的偏移上。因此不存在“下完再拼装”的中间态，也不会出现重下时偏移错位。

### 4.4 镜像调度

每个镜像维护一个吞吐评分（指数滑动平均）：

| 规则 | 行为 |
| --- | --- |
| 未测过的镜像 | 优先给一次机会，避免一开始就死磕最慢的 |
| 已测过的镜像 | 直接选评分最高者（不做额外迟滞） |
| 出错 | 评分乘 0.4；连续失败 4 次或评分降到 1 以下则标记不可用 |
| `401/403/404/410/451` | 视为致命错误，立即剔除 |
| `429` | 限流，降权后重试 |

这是解决“刚开快、后面慢”的关键：B 站 CDN 对**单个 TCP 连接**限速，且限速在持续传输一段时间之后才生效。

实测（同一文件，持续 15 秒，`tests/bench_cdn.py`）：

| 连接数 | 持续吞吐 | 相对 |
| --- | --- | --- |
| 1 | 10.3 MB/s | 1.00x |
| 4 | 29.7 MB/s | 2.88x |
| 8 | 59.2 MB/s | 5.74x |

### 4.5 容错

| 情况 | 处理 |
| --- | --- |
| 连接中途断开 | 从该片段**已写入的字节**继续（`start+offset`），不从头来 |
| 单个片段失败 | 最多重试 8 次，退避 `300 + 400×尝试次数` 毫秒，上限 3 秒 |
| 整体 45 秒无进展 | 看门狗判定停滞，中止并保留进度 |
| 服务器忽略 `Range` | 降级为单连接整文件下载 |

### 4.6 进度上报

每 500ms 采样一次，速度用 `0.65 × 旧值 + 0.35 × 瞬时值` 平滑，避免面板数字乱跳。

**视频流与音频流同时下载**，共用连接池；进度条 4%~92% 分配给两条流，合成与校验占后半段。

### 4.7 续传状态

状态文件写在系统临时目录（Linux `$TMPDIR/bili-downloader/`，Windows `%TEMP%\bili-downloader\`）：

- 文件名：流路径 SHA-1 的前 16 位
- 内容：总大小、片大小、已完成片段集合

因此关闭浏览器、重启机器后重新下载同一视频，仍会接着上次进度。下载完成后该文件被删除。

---

## 5. 临时文件处理

有两个独立的临时物，不要混淆。

### 5.1 下载产物（`.m4s`）

**默认（`keep = false`）**：放在下载目录下的隐藏子目录

```
<下载目录>/.bili-tmp-<流哈希>/
    video.m4s
    audio.m4s
```

目录名使用**流地址的哈希**而非任务 ID。原因：重试时任务 ID 会变，若用任务 ID 命名，重新下载会认不出旧分片，已下载内容全部作废——而“网络在 90% 断掉后重试”恰恰最需要续传。

合成与校验通过后整个目录删除；失败也会清理（但断点状态保留在系统临时目录）。

**保留中间文件（`keep = true`）**：直接写在下载目录，最终重命名为

```
<成品名>.video.m4s
<成品名>.audio.m4s
```

### 5.2 合成中间文件

```
<下载目录>/.<任务ID>.partial.mp4
```

合成与校验都通过后，才用 `os.Rename` **原子重命名**为最终 `.mp4`；任何一步失败都会删除它。

**为什么先写 partial 再 rename**：同目录内 `rename` 是原子的。因此下载目录里永远不会出现一个正在写入、半截的 `.mp4`——要么不存在，要么是完整校验过的成品。

---

## 6. 音视频合并

不使用 FFmpeg。B 站的 `.m4s` 本身就是标准 **fragmented MP4**：

```
ftyp | moov | sidx | (moof + mdat) × N
```

问题是这种分片式文件**没有完整索引**：Windows「电影和电视」、部分剪辑软件不接受，拖动进度条体验也差。内置引擎把它重排为普通 progressive MP4。

### 6.1 解析

逐个读顶层 box，提取：

- `ftyp`
- `moov` 内 `trak` 的 `tkhd` / `mdhd` / `hdlr` / `stsd`（编码参数）/ `dinf`
- 每个 `moof` 内 `tfhd`（默认时长、默认大小）、`trun`（每帧大小 / 时长 / 合成偏移）、`tfdt`（分片起始时间）
- 对应 `mdat` 的负载位置

### 6.2 重建每帧时长

B 站至少有两种封装变体，处理过两个真实缺陷：

| 缺陷 | 现象 | 修复 |
| --- | --- | --- |
| `tfhd` 无 `default_duration`，`trun` 也不带每帧时长 | 解析出全 0 时长，成品时长为 0，播放器拒绝 | 由相邻分片的 `tfdt` 差值推算，并按该分片样本数均分；尾片段样本数可能更多，按**每样本速率**外推，而不是照抄上一段总时长 |
| 源文件带 `elst`（编辑列表） | 212 秒的视频被读成 0.042 秒 | **丢弃 `elst`**，改用 `tkhd`/`mdhd` 的真实时长与样本表 |

### 6.3 识别关键帧

不信任源文件的 `sample_flags`（B 站把每帧都标成 sync，会导致拖进度条花屏），改为直接读码流：

| 编码 | 判定 |
| --- | --- |
| H.264 (`avc1`) | NAL type 5 = IDR |
| HEVC (`hvc1` / `hev1`) | NAL type 16~21 = BLA / IDR / CRA |
| AV1 (`av01`) | OBU `frame_type == 0` = KEY_FRAME |

### 6.4 重建索引

为每条轨道生成完整样本表：

| box | 内容 |
| --- | --- |
| `stts` | 每帧时长（行程编码压缩） |
| `ctts` | 合成偏移（有 B 帧才写，负值用 version 1） |
| `stss` | 关键帧列表（全为关键帧则省略） |
| `stsc` | 样本↔分块映射（64 样本一块） |
| `stco` / `co64` | 分块偏移（超过 4GB 自动改用 `co64`） |
| `stsz` | 每帧字节数 |

文件布局固定为 **`ftyp + moov + mdat`**，即 **moov 在前**（等价 ffmpeg 的 `+faststart`）。播放器不必读完整个文件即可开始播放，也能立即拖动进度。

### 6.5 校验

`verifyMP4` 检查四项：

1. `moov` 必须在 `mdat` 之前
2. 每个 chunk 偏移必须落在文件范围内
3. **索引声明的样本总字节数 ≤ `mdat` 实际负载**（截断检测的关键）
4. 两条轨道时长差 ≤ 5 秒（音画不同步检测）

任何一项不通过就删除 partial 并报错，不会把坏文件当作成功。

---

## 7. 一次完整下载的时序

```
1.  点图标 → popup 连接 background（端口名 "popup"）
2.  popup 发 GET_TAB_STATE，取当前标签页的任务状态
3.  popup 发 GET_VIDEO_INFO → background 注入 page-extractor.js 到 MAIN world
4.  脚本读 __playinfo__ 或请求 playurl → 返回视频流 / 音频流列表
5.  popup 发 GET_DEFAULTS → 经 Native Messaging 取下载目录与平台信息
6.  点「下载 MP4」
7.  background 建立任务记录（持久化到 storage）并下发给助手
8.  助手：探测大小与镜像 → 8 线程分片下载（视频与音频并行）
9.  每 500ms 回 progress，background 更新工具栏角标（下载进度百分比）
10. 两流完成 → 内置引擎合成 progressive MP4 → 校验 → 原子 rename
11. 回 done（路径 / 时长 / 编码）→ 面板显示「打开所在文件夹」
```

任务记录会写入 `chrome.storage.local`。即使 Chrome 回收扩展后台页面（MV3 的正常行为，会一并关闭本地助手并中断下载），重新打开面板也会显示「下载已中断」并提供**一键续传**。

---

## 8. 两个平台的配置步骤

### 8.1 共同部分（完全相同）

加载扩展的方式两平台一致：

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」
4. 选择解压出的 **`extension`** 文件夹（不是其上级目录）
5. 工具栏出现粉色 **B** 图标

两平台都**不需要** Python、FFmpeg、Node、管理员 / root 权限，也不修改 PATH。

扩展 ID 由 `manifest.json` 的 `key` 固定推导，两平台一致：

```
khkbfeoekeinbdgbicojpgfidfihfffc
```

### 8.2 Windows 专属

**第 1 步：解压**（必须，不能在压缩软件窗口里直接双击）

得到 `install.bat`、`install.ps1`、`uninstall.bat`、`uninstall.ps1`、`host\bili-host.exe`、`extension\`、`README.md`。

**第 2 步：双击 `install.bat`**

脚本是交互式的，没有命令行参数：

1. 检测已安装的浏览器，列出每个浏览器安装后会改动的文件与注册表项；
2. 输入编号多选浏览器（`all` 全选）；
3. 确认安装；发现旧文件时再次确认覆盖 / 跳过 / 取消；
4. 逐个浏览器显示加载扩展的步骤。

| 动作 | 位置 |
| --- | --- |
| 复制助手 | `%LOCALAPPDATA%\BiliDownloader\bili-host.exe` |
| 写清单 | `%LOCALAPPDATA%\BiliDownloader\com.opencode.bili_downloader.json` |
| 注册表 | `HKCU\Software\{Google\Chrome, Microsoft\Edge, BraveSoftware\Brave-Browser, Chromium, Vivaldi, ...}\NativeMessagingHosts\...` |

写入 `HKCU`（当前用户），因此**无需管理员权限**。扩展 ID 在脚本内为常量，同时用 PowerShell 复算一次做自校验。

**第 3 步：完全退出浏览器再打开**，然后按 8.1 加载扩展。

Windows 特有实现：

| 能力 | 做法 |
| --- | --- |
| 默认下载目录 | 读注册表 `User Shell Folders` 的 `{374DE290-123F-4565-9164-39C4925E467B}`（尊重“下载”文件夹被重定向），失败退回 `%USERPROFILE%\Downloads` |
| 选择文件夹 | PowerShell `FolderBrowserDialog` |
| 打开所在文件夹 | `explorer <路径>` |
| 子进程不弹黑窗 | `CREATE_NO_WINDOW`（0x08000000） |

### 8.3 Linux 专属

**第 1 步：解压**

```bash
# x86_64
tar -xzf bili-downloader-2.0.4-linux-x64.tar.gz
cd bili-downloader-2.0.4-linux-x64

# ARM64
tar -xzf bili-downloader-2.0.4-linux-arm64.tar.gz
cd bili-downloader-2.0.4-linux-arm64
```

**第 2 步：运行安装脚本**

```bash
./install.sh
```

没有执行权限时先 `chmod +x install.sh`。脚本同样是交互式的：检测浏览器、多选、
检查旧文件并二次确认，不需要任何命令行参数。

| 动作 | 位置 |
| --- | --- |
| 复制助手 | `~/.local/share/bili-downloader/bili-host` |
| 注册 | `~/.config/<浏览器>/NativeMessagingHosts/com.opencode.bili_downloader.json` |

覆盖 Chrome、Chrome Beta/Dev、Chromium、Brave、Edge、Vivaldi、Opera。

**第 3 步：完全退出浏览器再打开**，然后按 8.1 加载扩展。

Linux 两个需要特别注意的情况，安装脚本已自动处理：

| 情况 | 处理 |
| --- | --- |
| **Snap 版 Chromium** | AppArmor 禁止读取 `~/.local` 等隐藏目录。脚本把助手装到 `~/snap/chromium/common/bili-downloader/`，清单放进 snap 自己的 profile 目录 |
| **Flatpak 版 Chromium** | 同理，装到 `~/.var/app/org.chromium.Chromium/data/bili-downloader/` |

Linux 特有实现：

| 能力 | 做法 |
| --- | --- |
| 默认下载目录 | 读 `~/.config/user-dirs.dirs` 的 `XDG_DOWNLOAD_DIR`，失败退回 `~/Downloads` |
| 选择文件夹 | 依次尝试 `zenity` → `kdialog` → `python3 -tk`；都不可用则提示手动填写 |
| 打开所在文件夹 | `xdg-open` 或 `gio open` |
| 二进制 | 静态链接（`CGO_ENABLED=0`），不依赖 glibc 版本；提供 amd64 与 arm64 |

### 8.4 两平台差异一览

| 项目 | Windows | Linux |
| --- | --- | --- |
| 安装方式 | 双击 `install.bat`（交互式） | `./install.sh`（交互式） |
| 助手位置 | `%LOCALAPPDATA%\BiliDownloader\` | `~/.local/share/bili-downloader/` |
| 注册机制 | 注册表 `HKCU` | JSON 文件 |
| 默认下载目录 | 注册表已知文件夹 | XDG 配置 |
| 文件夹选择 | PowerShell 对话框 | zenity / kdialog / tk |
| 沙箱特例 | 无 | Snap / Flatpak 单独路径 |
| 二进制文件名 | `bili-host.exe` | `bili-host` |
| 需要管理员 | 否 | 否 |
| 需要 FFmpeg / Python | 否 | 否 |
| 扩展加载步骤 | 相同 | 相同 |

---

## 9. 安全边界

| 边界 | 实现 |
| --- | --- |
| 页面脚本 | 仅在 B 站视频页的 MAIN world 运行，只调用 B 站自身接口，不导出 Cookie |
| Native Messaging | `allowed_origins` 只允许固定扩展 ID，由 `manifest.json` 的 `key` 保证 ID 稳定 |
| 媒体地址 | 助手只接受 `https://`（回环地址仅用于测试），拒绝 `file://` 等协议 |
| 文件路径 | 标题经过 `safeName` 清洗，去掉 `/\:*?"<>|` 与保留名，禁止路径穿越 |
| 命令执行 | 助手不接受任意 shell 命令，只内置文件夹选择与打开目录两种动作 |
| 日志 | 只写系统临时目录，不含 URL 或登录信息 |
