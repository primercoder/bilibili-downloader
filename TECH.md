# 技术设计文档

本文描述 Bili 下载器的真实实现：下载逻辑、前后端交互、合成与校验、状态管理，以及平台差异。所有内容对应仓库中的代码，不是设计意图。

对应文件：

| 文件 | 职责 |
| --- | --- |
| `extension/manifest.json` | 权限、固定扩展 ID、快捷键 |
| `extension/popup.html` / `popup.css` / `popup.js` | 面板：选择清晰度、显示进度与结果 |
| `extension/background.js` | Service Worker：页面提取调度、任务状态、本地 HTTP / SSE 客户端 |
| `extension/page-extractor.js` | 注入 B 站页面 MAIN world，读取登录态与播放地址 |
| `native_host/server.go` | 本地 HTTP 服务、SSE 广播、CORS |
| `native_host/jobs.go` | 任务队列、临时文件生命周期、进度合成 |
| `native_host/downloader.go` | 多连接分片下载、镜像调度、断点续传 |
| `native_host/mux.go` | 内置 MP4 重排引擎（fMP4 → progressive MP4） |
| `native_host/verify.go` | 成品结构校验 |
| `native_host/stream.go` | 流地址校验（HTTPS 边界） |
| `native_host/platform.go` | 共享路径工具、默认下载目录入口、`safeName` |
| `native_host/tray.go` | 托盘应用：图标状态、菜单、退出时取消任务 |
| `native_host/main.go` | 命令行入口：默认启动托盘，也支持 serve / status / autostart |
| `native_host/folder_windows.go` / `folder_other.go` | 默认下载目录、打开所在文件夹 |
| `native_host/picker_windows.go` / `picker_other.go` | 系统文件夹选择器 |
| `native_host/autostart_windows.go` / `autostart_other.go` | 开机自启的读写 |
| `native_host/notify_windows.go` / `notify_other.go` | 无控制台时的提示方式 |

---

## 1. 整体架构

```
Chrome 扩展 (MV3)                        本地助手 (Go 单文件二进制)
┌────────────────────────┐              ┌────────────────────────────┐
│ popup.html/js          │              │ HTTP 服务 127.0.0.1:47821+ │
│ background.js (SW)     │◄── HTTP ────►│ messageHub（状态 + SSE）    │
│ page-extractor.js      │    + SSE     │ jobManager（任务队列）      │
└────────────────────────┘              │ downloader（分片下载）      │
        │                               │ mux + verify（合成校验）    │
        │ MAIN world 注入                └────────────────────────────┘
        ▼
   B 站页面（登录态、播放器数据）
```

### 为什么拆成两部分

浏览器的 `chrome.downloads` 无法按字节偏移并行写入同一个文件，也无法合并 DASH 的音视频双轨。纯浏览器方案要么把整个视频读进内存（4K 直接吃满），要么打包几十 MB 的 ffmpeg.wasm。

因此职责划分是：

- 扩展只做**读取页面**和**显示界面**
- 字节级下载、续传、合成、校验全部交给本地进程

---

## 2. 前后端交互

### 2.1 发现机制（不需要注册）

早期版本使用 Chrome Native Messaging，需要为每个浏览器写清单和注册表项。现在改为本地 HTTP：

- 助手启动时在 `127.0.0.1` 的 `47821–47860` 中 `net.Listen` 第一个空端口（`server.go` 的 `listenLocal`）
- 启动前先 `findRunningHost()` 扫描 `/health`，若已有实例则直接退出 —— 天然单实例
- 扩展的 `discoverHost()` 扫描同样端口段，比对 `app === "bili-downloader" && protocol === 1`

端口段是固定的，避免用户配置；扫描失败时给出"本地助手未运行"的明确提示。

### 2.2 HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 身份识别与版本探测（唯一免自定义请求头的端点） |
| GET | `/defaults` | 下载目录、平台、架构、是否存在 ffmpeg |
| GET | `/events` | SSE，进度推送 |
| GET | `/jobs` | 全量任务快照（对账用） |
| POST | `/jobs` | 提交下载任务 |
| POST | `/cancel` | 取消单个任务 |
| POST | `/cancel_all` | 取消全部 |
| POST | `/choose-directory` | 弹出系统文件夹选择器 |
| POST | `/open-folder` | 打开目录或在文件管理器中定位文件 |
| POST | `/probe` | 预先探测文件大小与镜像延迟（保留接口，当前扩展未调用） |

### 2.3 SSE 协议

```
id: 0
event: snapshot
data: {"ok":true,"jobs":[{...}]}

id: 1
event: job
data: {"jobId":"...","type":"progress","percent":42.7,...}

: ping
```

实现要点（`server.go` 的 `messageHub`）：

- 连接建立后**先发 `snapshot`**，因此任何漏掉的事件都能靠重连恢复
- 之后每条状态变化带自增 `id` 推送
- 每 15 秒发送一次 `: ping` 心跳
- 每个订阅者 channel 缓冲 64 条；写不进去就**关闭该连接**，让它重连并重新拿 snapshot —— 宁可重连也不能静默丢掉终态事件

### 2.4 扩展侧状态机

```
EventSource ──snapshot──► applyHostSnapshot()
             └─job──────► applyHostState()
连接失败 ──► 退避重连 [1,2,4,8,10] 秒 ──► 超过次数才标记「已中断」
环境无 EventSource ──► 1.5 秒低频快照兜底
```

关键设计：

- **启动即对账**：Service Worker 唤醒时先 `GET /jobs` 拉一次快照，再建立 SSE。这样重启前就在跑的任务不会消失
- **延迟对账**：刚 `POST /jobs` 完成、助手还没产生第一帧时，3.5 秒后复查一次（`scheduleSnapshotReconcile`），避免误判任务丢失
- **空闲断开**：没有活动任务就关闭 SSE，助手仍在后台下载
- **按 jobId 匹配**：进度消息用 `jobId` 而不是 `tabId` 过滤，否则切到其它标签页后进度会卡在第一帧

### 2.5 任务表与持久化

```js
jobs      // jobId -> { tabId, bvid, payload, state, startedAt, autoResumes }
tabJobs   // tabId -> 最近一次 jobId
infoCache // tabId -> 最近一次提取结果（403 刷新时复用）
```

只有三种状态写入 `chrome.storage.local`：

- `progress`
- `queued`
- `interrupted`

`done` 是**临时 UI 状态**，只保留 3 秒（或面板关闭时清掉）。早期版本把 `done` 也持久化，导致每次 Service Worker 重启都会复活一个历史任务的 ✓。

### 2.6 安全边界

- 只绑定 `127.0.0.1`，不监听外网
- CORS 只放行 `chrome-extension://khkbfeoekeinbdgbicojpgfidfihfffc`
- 除 `/health` 和 SSE 的 `/events` 外，请求必须带 `X-Bili-Client: extension`，强制触发预检 —— 普通网页无法用简单请求打进来（`/events` 免头是因为 `EventSource` 无法设置自定义请求头，它仍受上面的 Origin 白名单限制）
- 响应 `Access-Control-Allow-Private-Network`，兼容 Chrome 的 Private Network Access 预检

---

## 3. 取流逻辑

### 3.1 页面识别

`background.js` 的 `isVideoUrl`：

```js
/(^https:\/\/www\.bilibili\.com\/(video|bangumi)\/)/
```

`page-extractor.js` 再从路径解析标识：

| 页面类型 | 正则 | 结果 |
| --- | --- | --- |
| 普通视频 | `/video/(BV[0-9A-Za-z]+|av\d+)/` | `bvid`，旧式 `av` 号会先换取 `bvid` |
| 番剧 / 影视 | `/bangumi/play/(ep\d+|ss\d+)/` | 剧集号，解析出当前集 |

### 3.2 为什么能拿到登录态

提取脚本通过以下方式注入：

```js
chrome.scripting.executeScript({ target, world: "MAIN", files: ["page-extractor.js"] })
```

`world: "MAIN"` 表示脚本运行在页面自己的 JS 上下文里，与 B 站前端同源同会话，因此 `fetch` 天然携带 Cookie，`playurl` 返回该账号有权限的清晰度。

**安全边界**：脚本只导出流地址，返回对象只包含 `bvid`、`cid`、标题、清晰度列表和 `https://` 开头的媒体 URL，**不读取也不转发 Cookie**。

### 3.3 两条取流路径

**路径 A：复用播放器数据**

页面上的 `window.__playinfo__` 是 B 站播放器自己请求的结果，直接使用可以省掉一次接口往返。

但 `__playinfo__` **没有 `cid` 字段**。判断它是否属于当前视频，靠媒体 URL 的路径段：

```
.../upgcxcode/34/78/<cid>/<cid>_u1-1-....m4s
```

路径中包含当前 `cid` 才复用。没有这个校验时，从视频 A 导航到视频 B 会拿到 A 的过期流，导致"文件是 B 的名字、内容是 A"。

**路径 B：主动请求**

```http
GET https://api.bilibili.com/x/player/playurl
    ?bvid=BVxxx&cid=<cid>&fnval=4048&fnver=0&fourk=1&qn=127
```

番剧优先走 PGC 接口，失败再回退：

```http
GET https://api.bilibili.com/pgc/player/web/playurl
    ?ep_id=<ep>&cid=<cid>&bvid=BVxxx&fnval=4048&fnver=0&fourk=1&qn=127
```

| 参数 | 含义 |
| --- | --- |
| `fnval=4048` | 要求 DASH（而非旧式 FLV），并开启杜比 / FLAC |
| `fnver=0` | 接口版本 |
| `fourk=1` | 允许 4K |
| `qn=127` | 请求最高清晰度 |

普通接口的播放数据在 `data`，PGC 接口在 `result`，提取脚本两者都兼容。

### 3.4 番剧集数解析

优先级：

1. 页面 `__INITIAL_STATE__.epInfo`（当前集）、`epList`（剧集列表）
2. `pgc/view/web/season?ep_id=` 或 `?season_id=`
3. `result.section[].episodes`（PV、特别篇等）

过滤掉没有 `cid` 的条目，保证面板里的集号与可下载列表一致。

### 3.5 流清单

每个流得到 **1 个主地址 + 最多 2 个备用镜像**（`baseUrl` + `backupUrl`），全部经 `startsWith("https://")` 过滤。

清晰度选择策略：优先 **AVC（H.264）**，兼容性最好；默认选 1080P 的 AVC，没有则退到 1080P 以下最高的 AVC。HEVC / AV1 仍可手动选择。

### 3.6 地址过期

媒体地址带时效签名，过期返回 `403`。扩展收到 `HTTP 403` 会用 `infoCache` 里的提取结果重新取一次地址并续传（`retryWithFreshUrls`）。

---

## 4. 下载逻辑

### 4.1 探测（几乎不耗流量）

对每个镜像并发发一个 `Range: bytes=0-0` 请求（1 字节）：

- 从 `Content-Range: bytes 0-0/76666968` 得到**文件总大小**
- 顺带测出每个镜像的**响应延迟**
- 确认是否支持 `206 Partial Content`，不支持则降级为单连接整文件下载

### 4.2 镜像调度

每个镜像维护一个吞吐评分（指数滑动平均）：

| 规则 | 行为 |
| --- | --- |
| 未测过的镜像 | 优先给一次机会，避免一开始就死磕最慢的 |
| 已测过的镜像 | 直接选评分最高者 |
| 成功 | `score = 0.6 × score + 0.4 × 实测速率` |
| 出错 | `score ×= 0.4`；连续失败 4 次或评分降到 1 以下则标记不可用 |
| `401/403/404/410/451` | 视为致命错误，立即剔除 |
| `429` | 限流，降权后重试 |

这是解决"刚开快、后面慢"的关键：B 站 CDN 对**单个 TCP 连接**限速，且限速在持续传输一段时间后才生效。

### 4.3 分片与写入

- 固定 **4 MiB** 一片，共 `ceil(总大小 / 4MiB)` 个片段
- 默认 **8 个 worker**，上限 16
- 每个 worker 从 channel 队列取片段，发 `Range: bytes=start-end`
- 数据到达后用 **`file.WriteAt(buf, start+已写入)`** 写到文件的**最终位置**

`WriteAt` 是关键设计：字节一落地就在它该在的偏移上。因此：

- 不存在"下完再拼装"的中间态
- 不会出现重下时偏移错位
- 连接断开可以从该片段已写入的字节继续

### 4.4 容错

| 情况 | 处理 |
| --- | --- |
| 连接中途断开 | 从该片段**已写入的字节**继续（`start+offset`），不从头来 |
| 单个片段失败 | 最多重试 8 次，退避 `300 + 400×尝试次数` 毫秒，上限 3 秒 |
| 所有镜像死亡 | 立即失败并提示刷新地址 |
| 整体 45 秒无进展 | 看门狗判定停滞，中止并保留进度 |
| 服务器忽略 `Range` | probe 阶段检测到不支持 206，改用单连接整文件下载 |

### 4.5 断点续传

状态文件写在系统临时目录（Linux `$TMPDIR/bili-downloader/`，Windows `%TEMP%\bili-downloader\`）：

- 文件名：**流路径 SHA-1 的前 16 位**
- 内容：总大小、片大小、已完成片段集合

用流路径哈希而不是任务 ID 做 key，是因为重试时任务 ID 会变；用任务 ID 命名会在重新下载时认不出旧分片，而"网络在 90% 断掉后重试"恰恰最需要续传。

并发安全：两个 worker 可能同时完成片段，写状态文件时用 `stateMu` 串行，且在 `mu` 锁内复制快照后再落盘 —— 直接迭代另一个 goroutine 正在写的 map 会触发 Go 的致命错误，无法被 `recover()` 捕获。

下载完成后状态文件被删除。

### 4.6 进度上报

每 500ms 采样一次，速度用 `0.65 × 旧值 + 0.35 × 瞬时值` 平滑，避免面板数字乱跳。

**视频流与音频流同时下载**，共用连接池。进度区间分配：

| 区间 | 阶段 |
| --- | --- |
| 2% | 探测大小与镜像 |
| 4% – 92% | 两条流并行下载，按 `(已下视频+已下音频) / (总+总)` 折算 |
| 94% | 合成 MP4 |
| 98% | 校验文件 |
| 100% | 完成 |

### 4.7 临时文件布局

```
<下载目录>/.bili-tmp-<streamKey>/
    video.m4s
    audio.m4s
<下载目录>/.<jobId>.partial.mp4     ← 合成产物
<下载目录>/<标题> - P<n> <分P>.mp4  ← 校验通过后原子 rename
```

临时目录用**流地址哈希**命名而非任务 ID，原因同续传状态。

`keep = true` 时中间文件按最终文件名保留：

```
<成品名>.video.m4s
<成品名>.audio.m4s
```

**为什么先写 `partial` 再 rename**：同目录内 `rename` 是原子的。因此下载目录里永远不会出现一个正在写入、半截的 `.mp4` —— 要么不存在，要么是完整校验过的成品。

---

## 5. 合成与校验（不使用 FFmpeg）

### 5.1 问题

B 站的 `.m4s` 是标准 **fragmented MP4**：

```
ftyp | moov | sidx | (moof + mdat) × N
```

分片本身合法，但**没有完整样本索引**。Windows「电影和电视」、QuickTime、不少剪辑软件和部分手机播放器都无法拖动进度条，个别甚至拒绝播放。

### 5.2 重排做了什么

`mux.go` 把它重排为普通的 progressive MP4：

1. **解析**：逐个读顶层 box，提取 `ftyp`、`moov` 内 `trak`/`stbl`（含 `stsd` 编码参数）、每个 `moof` 的 `tfhd`/`trun`/`tfdt`，以及对应 `mdat` 的负载位置
2. **重建每帧时长**：B 站至少有两种封装变体
   - `tfhd` 无 `default_duration` 且 `trun` 不带每帧时长 → 由相邻分片 `tfdt` 差值推算，按样本数均分；尾片段按**每样本速率**外推
   - 源文件带 `elst`（编辑列表）→ **丢弃**，改用 `tkhd`/`mdhd` 的真实时长（这个包曾把 212 秒视频读成 0.042 秒）
3. **识别关键帧**：不信任源文件 `sample_flags`（B 站把每帧都标成 sync，会让拖进度条花屏），直接读码流
   - H.264：NAL type 5 = IDR
   - HEVC：NAL type 16–21
   - AV1：OBU `frame_type == 0`
4. **重建索引**，生成完整样本表

| box | 内容 |
| --- | --- |
| `stts` | 每帧时长（行程编码压缩） |
| `ctts` | 合成偏移（有 B 帧才写，负值用 version 1） |
| `stss` | 关键帧列表（全为关键帧则省略） |
| `stsc` | 样本↔分块映射（64 样本一块） |
| `stco` / `co64` | 分块偏移（超过 4GB 自动改用 `co64`） |
| `stsz` | 每帧字节数 |

5. **布局固定为 `ftyp + moov + mdat`**，即 moov 前置（等价 ffmpeg 的 `+faststart`）。播放器不必读完整个文件即可开始播放，也能立即拖动进度。

全程**不重新编码**，因此速度快、画质无损。

### 5.3 校验

`verifyMP4` 检查四项：

1. `moov` 必须在 `mdat` 之前
2. 每个 chunk 偏移必须落在文件范围内
3. **索引声明的样本总字节数 ≤ `mdat` 实际负载**（抓 CDN 传输截断的关键）
4. 两条轨道时长差 ≤ 5 秒（抓音画不同步）

任何一项不通过就删除 partial 并报错，不会把坏文件当作成功。

---

## 6. 任务与状态管理

### 6.1 队列

`jobManager` **同一时刻只跑一个任务**：两个并行任务会互相抢 CDN 带宽，让进度面板失去意义。

- 运行中再提交新任务 → 进入队列，回 `queued` + `position`
- 前一个任务结束（成功/失败/取消）后自动出队下一个
- 按 `jobId` 去重，重复 `POST /jobs` 不会重复入队
- 排队中的任务可以取消，此时不会真的开始下载

### 6.2 状态集合

| 状态 | 含义 |
| --- | --- |
| `progress` | 下载 / 合成 / 校验中 |
| `queued` | 排队等待 |
| `interrupted` | 助手退出或连接中断，分段保留，可续传 |
| `done` | 校验通过，已原子重命名 |
| `error` | 失败，带具体原因 |

### 6.3 状态保留

`messageHub` 只保留每个 `jobId` 的最新状态；`done` / `error` 超过 2 分钟会被清理。这样 `GET /jobs` 返回的是"当前有意义的状态"，而不是无限增长的历史。

### 6.4 工具栏角标

- 下载中：显示**进度百分比**（`42%`）
- 完成：显示 `✓`，保留 3 秒
- 面板正展示该结果时，`✓` 延长到面板关闭
- 其它情况：清空

---

## 7. 桌面形态与平台差异

### 7.1 为什么是托盘应用

助手不能是"双击后留一个黑窗口"的命令行程序：用户装完就不该再看见它，但又要能确认它在跑、能打开下载目录、能退出。

因此助手是一个常驻托盘的后台程序：

- Windows 构建带 `-H=windowsgui`，双击不会出现控制台窗口
- 启动后绑定本地端口，并在系统托盘区显示图标
- 托盘图标颜色就是状态：粉色=空闲、蓝色=下载中、橙色=合成/校验
- 左键、右键都打开同一个菜单

菜单内容：

| 项 | 行为 |
| --- | --- |
| 状态：空闲 / 下载中 42% / 合成中 | 只读显示 |
| 端口：47821 | 只读显示，方便排查 |
| 打开下载文件夹 | 调用平台文件管理器 |
| 开机自启（勾选） | 直接读写当前用户的自启动配置 |
| 退出 | 取消正在跑的任务后退出，避免留下半截临时文件 |

### 7.2 启动入口

| 命令 | 行为 |
| --- | --- |
| 无参数 / `tray` | 启动服务 + 托盘（双击时的默认行为） |
| `serve` | 只启动服务，前台阻塞，无托盘 |
| `status` | 打印助手是否在运行、端口、健康检查地址 |
| `autostart on/off/status` | 脚本化地开关开机自启 |
| `default-dir` / `pick-dir` / `open <path>` | 单次工具命令 |

单实例：`startServer` 先 `findRunningHost()` 扫端口，已在运行就直接提示"已在运行"并退出，不会起第二个进程。

### 7.3 路径与开机自启

| 项目 | Windows | Linux |
| --- | --- | --- |
| 运行位置 | 解压目录里的 `host\bili-host.exe`（不需要安装） | 解压目录里的 `host/bili-host-linux-*` |
| 开机自启 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 值 `BiliDownloader` | `~/.config/autostart/bili-downloader.desktop` |
| 默认下载目录 | `SHGetKnownFolderPath(FOLDERID_Downloads)`，尊重"下载"被重定向 | `~/.config/user-dirs.dirs` 的 `XDG_DOWNLOAD_DIR` |

Windows 侧原先通过 PowerShell 读注册表，现在直接调用 shell32：少一个子进程，也不再受执行策略影响。两者都失败时退回 `~/Downloads`。

### 7.4 文件夹选择器

| 平台 | 实现 |
| --- | --- |
| Windows | `SHBrowseForFolderW` + `SHGetPathFromIDListW`，在锁定的 OS 线程上以 STA 初始化 COM |
| Linux | 依次尝试 `zenity` → `kdialog` → `python3 -tkinter` |
| macOS | `osascript` 的 `choose folder` |

Windows 侧换掉 PowerShell 的原因很实际：助手由托盘/登录项启动，子 PowerShell 在这种环境里经常直接以非零码退出，用户只看到"无法打开文件夹选择器"。原生的 shell32 调用没有这个问题。

对话框的 owner 取自 `GetForegroundWindow()`（通常就是浏览器），因此对话框是模态的，不会跑到浏览器后面去。picker 用互斥锁串行，快速点两次不会开出两个窗口。

页面上的"选择"按钮不再受 6 秒请求超时限制：选文件夹本身可能需要很久，超时由用户关闭对话框决定。

### 7.5 打开所在文件夹

| 平台 | 实现 |
| --- | --- |
| Windows | `%SystemRoot%\explorer.exe`；目标是文件时用 `/select,<绝对路径>` 定位并高亮 |
| Linux | `xdg-open` 或 `gio open` |
| macOS | `open` |

Windows 有两个必须遵守的点：

- **不能**给 explorer 设 `CREATE_NO_WINDOW`，那样它会静默什么都不做（这正是"按钮没反应"的直接原因）
- 用 `/select,` 而不是只打开父目录，用户能立刻看到成品文件

路径先 `filepath.Abs` 再 `os.Stat`，不存在时返回明确错误，面板会显示原因而不是静默失败。

### 7.6 无控制台时如何提示

Windows GUI 构建没有 stdout，因此提示分两条路：

- `notify_windows.go`：`MessageBoxW`，用于"助手已在运行"、"服务已启动，端口 X"、`--help`
- `notify_other.go`：写日志 + stdout

托盘菜单里的操作反馈（例如"无法打开文件夹：…"、"已设置开机自启"）通过在菜单里临时插入一行提示实现，6 秒后自动隐藏。

---

## 8. 安全边界

| 边界 | 实现 |
| --- | --- |
| 页面脚本 | 仅在 B 站视频页的 MAIN world 运行，只调用 B 站自身接口，不导出 Cookie |
| 本地 HTTP | 只监听 `127.0.0.1`；CORS 只允许固定扩展 ID 的 origin；除 `/health` 与 `/events` 外的请求要求 `X-Bili-Client` 头 |
| 媒体地址 | 助手只接受 `https://`，回环地址仅用于测试，拒绝 `file://` 等协议 |
| 文件路径 | 标题经过 `safeName` 清洗，去掉 `/\:*?"<>|` 与 Windows 保留名，禁止路径穿越 |
| 命令执行 | 助手不接受任意 shell 命令：文件夹选择走系统 API，打开目录只用固定的 explorer/xdg-open 参数 |
| 日志 | 只写系统临时目录，不含 URL 或登录信息 |

---

## 9. 测试策略

| 类型 | 文件 | 覆盖内容 |
| --- | --- | --- |
| Go 单元测试 | `native_host/*_test.go` | 分片下载、续传、并发、MP4 解析与合成时长 |
| 离线提取测试 | `tests/bangumi_extract.mjs` | 番剧 `ss` 页当前集定位、选集切换 |
| 浏览器回归测试 | `tests/browser_*.mjs` | 角标、完成界面、中断恢复、换视频不串流 |
| 探测脚本 | `tests/probe_*.mjs` | 助手连通性、播放器数据结构 |
| 基准脚本 | `tests/bench_*.py` | 连接数与 CDN 吞吐实测 |

浏览器测试通过 CDP（`--remote-debugging-port=9222`）驱动真实 Chromium：

```bash
chromium --remote-debugging-port=9222 --load-extension=$PWD/extension
node tests/browser_drive.mjs
```

---

## 10. 已知限制

| 限制 | 原因 |
| --- | --- |
| DRM 保护内容 | 受保护流无法通过普通下载得到可播放文件 |
| 老内容的 `durl` / FLV 流 | 当前只处理 DASH 的独立音视频流，纯 `durl` 会提示"没有可用的 DASH 视频流" |
| `/bangumi/media/md...` 详情页 | 这是介绍页不是播放页，需要点进 `ep` / `ss` 再下载 |
| 试看 / 地区 / 会员限制 | 由 PGC 接口的 `is_preview`、`can_watch_reason` 决定，失败时按接口消息提示 |
| 直播、付费课程 | 不属于当前支持范围 |
| MV3 Service Worker 休眠 | 助手继续下载，但角标可能停在最后一帧，直到用户再打开面板触发对账 |
| Linux 托盘图标 | 依赖桌面环境的 StatusNotifierItem；GNOME 默认需要 AppIndicator 扩展，没有图标时下载功能不受影响 |
