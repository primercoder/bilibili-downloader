// Popup UI.
//
// The v1 popup asked the service worker for a stored state and, if it looked
// like a finished job, returned immediately — so once a download had completed,
// opening the popup on a *different* video showed the old result forever and the
// panel could never start another download. Now every open does two separate
// things: (a) read this tab's own job state, (b) always re-extract the page.
// A finished job in another tab or an older video can no longer hide the form.

const $ = id => document.getElementById(id);

let info = null;
let defaults = null;
let currentJobId = null;
let currentTabId = null;
let savedDirectory = "";
let busy = false;
let lastSnapshot = null;
let externalTabNote = "";
let interruptedJobId = null;

const send = message => chrome.runtime.sendMessage(message);

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function formatDuration(seconds) {
  if (!seconds) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (!bytes) return "—";
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatSpeed(bytes) {
  if (!bytes) return "—";
  return `${(bytes / 1048576).toFixed(1)} MB/s`;
}

function formatMbps(bandwidth) {
  if (!bandwidth) return "";
  const mbps = bandwidth / 1e6;
  return `${mbps >= 10 ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`;
}

function showOnly(name) {
  for (const section of ["loading", "error", "form", "progressSection"]) {
    $(section).classList.toggle("hidden", section !== name);
  }
}

function fail(message, hint = "") {
  showOnly("error");
  $("errorBox").textContent = message;
  $("errorHint").textContent = hint;
  $("statusDot").classList.remove("ready", "busy");
}

// ---------------------------------------------------------------------------
// form
// ---------------------------------------------------------------------------

function qualityLabel(video) {
  const name = info.qualityNames?.[video.id];
  const resolution = video.height ? `${video.height}P` : "";
  const primary = name || resolution || `${video.id}`;
  const parts = [
    primary,
    video.width && video.height ? `${video.width}×${video.height}` : "",
    video.fps ? `${Math.round(video.fps)}fps` : "",
    video.codec,
    formatMbps(video.bandwidth),
  ].filter(Boolean);
  return parts.join(" · ");
}

// AVC plays everywhere; HEVC/AV1 are offered after it. Higher resolution first.
function orderVideos(videos) {
  const order = { AVC: 0, HEVC: 1, AV1: 2 };
  return [...videos].sort((a, b) => {
    const codec = (order[a.codec] ?? 9) - (order[b.codec] ?? 9);
    if (codec) return codec;
    return (b.height || 0) - (a.height || 0);
  });
}

function fillPages() {
  const pages = info.pages || [];
  if (pages.length <= 1) {
    $("pageLabel").classList.add("hidden");
    return;
  }
  $("pageLabel").classList.remove("hidden");
  $("pageSelect").replaceChildren();
  for (const page of pages) {
    const option = document.createElement("option");
    option.value = String(page.page);
    const label = page.part ? `P${page.page} ${page.part}` : `P${page.page}`;
    option.textContent = page.duration ? `${label}（${formatDuration(page.duration)}）` : label;
    $("pageSelect").append(option);
  }
  $("pageSelect").value = String(info.page || 1);
}

function populate() {
  showOnly("form");
  $("title").textContent = info.title || info.bvid;
  $("title").title = info.title || "";
  const bits = [info.bvid, info.partTitle, formatDuration(info.duration)].filter(Boolean);
  $("meta").textContent = bits.join(" · ");
  fillPages();

  $("quality").replaceChildren();
  const videos = orderVideos(info.videos || []);
  for (const video of videos) {
    const option = document.createElement("option");
    option.value = String(info.videos.indexOf(video));
    option.textContent = qualityLabel(video);
    $("quality").append(option);
  }
  // Prefer 1080p AVC, then the largest AVC at or below 1080p, then anything.
  const preferred =
    videos.find(v => v.id === 80 && v.codec === "AVC") ||
    videos.filter(v => v.codec === "AVC" && (v.height || 0) <= 1080).sort((a, b) => (b.height || 0) - (a.height || 0))[0] ||
    videos[0];
  if (preferred) $("quality").value = String(info.videos.indexOf(preferred));

  $("audio").replaceChildren();
  const audios = [...(info.audios || [])].sort((a, b) => b.bandwidth - a.bandwidth);
  for (const audio of audios) {
    const option = document.createElement("option");
    option.value = String(info.audios.indexOf(audio));
    const kbps = audio.bandwidth ? `${Math.round(audio.bandwidth / 1000)} kbps` : "";
    option.textContent = [kbps, audio.codecs].filter(Boolean).join(" · ");
    $("audio").append(option);
  }

  if (!$("directory").value) $("directory").value = savedDirectory || defaults?.downloadDir || "";
  renderPlatformHint();
}

function renderPlatformHint() {
  if (!defaults) {
    $("platformHint").textContent = "正在连接本地助手…";
    $("statusDot").classList.remove("ready");
    return;
  }
  const platform = defaults.platform === "windows" ? "Windows" : defaults.platform === "darwin" ? "macOS" : "Linux";
  const parts = [`${platform} 默认目录：${defaults.downloadDir}`];
  parts.push("内置合成引擎");
  if (defaults.ffmpeg) parts.push("已检测到 FFmpeg（可用于其它工具）");
  $("platformHint").textContent = parts.join(" · ");
  $("platformHint").classList.remove("error", "warn");
  $("statusDot").classList.add("ready");
}

function selected(index) {
  return Number($(index).value);
}

function buildJob(jobId) {
  return {
    id: jobId,
    title: info.title,
    partTitle: info.partTitle,
    bvid: info.bvid,
    page: info.page,
    duration: info.duration,
    video: info.videos[selected("quality")],
    audio: info.audios[selected("audio")],
    keep: $("keep").checked,
    directory: $("directory").value.trim(),
  };
}

// ---------------------------------------------------------------------------
// progress rendering
// ---------------------------------------------------------------------------

function renderProgress(state) {
  busy = true;
  showOnly("progressSection");
  $("result").classList.add("hidden");
  $("openFolder").classList.add("hidden");
  $("again").classList.add("hidden");
  $("cancel").classList.remove("hidden");
  $("cancel").disabled = false;
  $("stage").textContent = state.stage || "处理中";
  $("statusDot").classList.add("busy");
  $("statusDot").classList.remove("ready");
  lastSnapshot = state;
  paintProgress(state);
}

function paintProgress(state) {
  const percent = Math.max(0, Math.min(100, state.percent || 0));
  $("bar").style.width = `${percent}%`;
  $("percent").textContent = `${percent >= 100 ? 100 : percent.toFixed(percent < 10 ? 1 : 0)}%`;
  $("stage").textContent = state.stage || "处理中";
  $("doneSize").textContent = state.downloaded ? formatBytes(state.downloaded) : "—";
  $("speed").textContent = formatSpeed(state.speed);

  const downloading = Boolean(state.total && state.downloaded != null && state.speed > 0);
  $("etaWrap").classList.toggle("hidden", !downloading);
  if (downloading) {
    const remain = Math.max(0, state.total - state.downloaded);
    const seconds = remain / state.speed;
    $("eta").textContent = seconds > 0 && seconds < 7200 ? formatDuration(seconds) : "—";
  }
  const detail = [];
  if (state.total) detail.push(`共 ${formatBytes(state.total)}`);
  if (state.detail) detail.push(state.detail);
  $("progressDetail").textContent = detail.join(" · ");
  // A background job from another tab stays visible without stealing the
  // "排队中" slot, so progress updates do not hide the explanation.
  if (externalTabNote) {
    $("queueNote").classList.remove("hidden");
    $("queueNote").textContent = externalTabNote;
  }
}

function renderDone(state) {
  busy = false;
  currentJobId = state.jobId || currentJobId;
  showOnly("progressSection");
  $("bar").style.width = "100%";
  $("percent").textContent = "100%";
  $("stage").textContent = "下载完成";
  $("statusDot").classList.add("ready");
  $("statusDot").classList.remove("busy");
  $("cancel").classList.add("hidden");
  $("again").classList.remove("hidden");
  $("openFolder").classList.remove("hidden");
  $("etaWrap").classList.add("hidden");
  $("doneSize").textContent = formatBytes(state.size || state.downloaded);
  $("speed").textContent = "—";

  const codecs = [state.videoCodec, state.hasAudio === false ? "无音频" : state.audioCodec].filter(Boolean);
  const detail = [];
  if (state.duration) detail.push(`时长 ${formatDuration(state.duration)}`);
  if (codecs.length) detail.push(codecs.join(" + "));
  detail.push("校验通过");
  $("progressDetail").textContent = detail.join(" · ");

  const box = $("result");
  box.classList.remove("error");
  box.classList.add("hidden");
  box.replaceChildren();
  const line = document.createElement("div");
  line.textContent = `已保存：${state.output || ""}`;
  box.append(line);
  if (state.kept?.length) {
    const kept = document.createElement("div");
    kept.style.marginTop = "4px";
    kept.textContent = `中间文件：${state.kept.length} 个 .m4s`;
    box.append(kept);
  }
  box.classList.remove("hidden");
  $("openFolder").dataset.path = state.output || state.directory || "";
}

function renderQueued(state) {
  busy = true;
  // Queued jobs must still show the progress panel, otherwise the note is
  // invisible while the form looks stuck.
  showOnly("progressSection");
  $("queueNote").classList.remove("hidden");
  $("queueNote").textContent = `已有任务在进行，本任务排队中（第 ${state.position || 1} 位），会自动开始。`;
  $("stage").textContent = "排队中";
  $("progressDetail").textContent = "前面的任务完成后自动开始，可以关闭面板";
  $("bar").style.width = "0%";
  $("percent").textContent = "0%";
  $("cancel").classList.remove("hidden");
  $("cancel").disabled = false;
  $("again").classList.add("hidden");
  $("openFolder").classList.add("hidden");
  $("result").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// state plumbing
// ---------------------------------------------------------------------------

function applyState(state) {
  if (!state) return;
  if (!["progress", "done", "error", "queued", "interrupted"].includes(state.type)) return;
  if (currentJobId && state.jobId && state.jobId !== currentJobId) return;

  if (state.type === "interrupted") {
    // The browser recycled the service worker mid-download. The helper already
    // kept its segments, so offer a one-click resume instead of a bare error.
    busy = false;
    currentJobId = state.jobId || currentJobId;
    interruptedJobId = state.jobId || currentJobId;
    showOnly("progressSection");
    $("stage").textContent = "下载已中断";
    $("statusDot").classList.remove("busy", "ready");
    $("queueNote").classList.add("hidden");
    $("cancel").classList.add("hidden");
    $("openFolder").classList.add("hidden");
    $("again").classList.remove("hidden");
    $("again").textContent = "继续下载（从断点续传）";
    const box = $("result");
    box.classList.remove("hidden");
    box.classList.add("error");
    box.textContent =
      state.detail ||
      "浏览器回收了后台页面，下载已中断。已下载的分段仍然保留，点下面的按钮即可继续。";
    const percent = Math.max(0, Math.min(100, state.percent || 0));
    $("bar").style.width = `${percent}%`;
    $("percent").textContent = `${Math.round(percent)}%`;
    $("progressDetail").textContent = "续传会从已完成的分段继续，不会重新下载。";
    return;
  }

  if (state.type === "progress") {
    interruptedJobId = null;
    $("again").textContent = "继续下载（回到设置）";
    if (!externalTabNote) $("queueNote").classList.add("hidden");
    renderProgress(state);
  } else if (state.type === "done") {
    externalTabNote = "";
    interruptedJobId = null;
    $("again").textContent = "继续下载（回到设置）";
    $("queueNote").classList.add("hidden");
    renderDone(state);
  } else if (state.type === "queued") {
    interruptedJobId = null;
    $("again").textContent = "继续下载（回到设置）";
    busy = true;
    renderQueued(state);
  } else {
    busy = false;
    externalTabNote = "";
    interruptedJobId = null;
    $("again").textContent = "继续下载（回到设置）";
    if ((state.error || "").includes("已取消")) {
      $("queueNote").classList.add("hidden");
      if (info) populate();
      else loadInfo();
      return;
    }
    showOnly("progressSection");
    $("stage").textContent = "下载失败";
    $("cancel").classList.add("hidden");
    $("again").classList.remove("hidden");
    $("openFolder").classList.add("hidden");
    $("queueNote").classList.add("hidden");
    const box = $("result");
    box.classList.remove("hidden");
    box.classList.add("error");
    box.textContent = state.error || "未知错误";
    $("statusDot").classList.remove("busy", "ready");
  }
}

// ---------------------------------------------------------------------------
// page info
// ---------------------------------------------------------------------------

async function loadInfo() {
  showOnly("loading");
  const response = await send({ type: "GET_VIDEO_INFO" });
  if (!response?.ok) {
    fail(response?.error || "读取视频失败", "");
    return;
  }
  info = response;
  populate();
  const defaultsResponse = await send({ type: "GET_DEFAULTS" });
  if (!defaultsResponse?.ok) {
    $("platformHint").textContent = defaultsResponse?.error || "本地助手未连接";
    $("platformHint").classList.add("error");
    $("statusDot").classList.remove("ready");
    if (defaultsResponse?.detail) $("platformHint").title = defaultsResponse.detail;
  }
}

async function switchPage(page) {
  if (!info) return;
  const response = await send({ type: "GET_VIDEO_INFO", page });
  if (!response?.ok) {
    fail(response?.error || "切换分 P 失败");
    return;
  }
  info = response;
  populate();
}

async function initialize() {
  const port = chrome.runtime.connect({ name: "popup" });
  port.onMessage.addListener(message => {
    if (message.type === "DEFAULTS") {
      defaults = message.defaults;
      if (info) renderPlatformHint();
      return;
    }
    if (message.type === "DIRECTORY") {
      if (message.path) {
        $("directory").value = message.path;
        chrome.storage.local.set({ directory: message.path });
      }
      return;
    }
    if (message.type === "JOB") {
      // Ignore jobs that belong to another tab; that was the other half of the
      // "stuck on the previous video" bug.
      if (message.tabId && currentTabId && message.tabId !== currentTabId) return;
      currentJobId = message.jobId;
      applyState(message.state);
      return;
    }
    if (message.type === "NATIVE_DOWN") {
      $("statusDot").classList.remove("ready", "busy");
      if (!message.resumed) {
        $("platformHint").textContent = message.error
          ? `本地助手已断开（${message.error}）`
          : "本地助手未运行";
        $("platformHint").classList.add("error");
      }
    }
  });

  const saved = await chrome.storage.local.get({ keep: false, directory: "" });
  savedDirectory = saved.directory || "";
  $("keep").checked = saved.keep;
  $("directory").value = savedDirectory;

  const state = await send({ type: "GET_TAB_STATE" });
  currentTabId = state?.tabId || null;
  if (state?.ok && state.state) {
    currentJobId = state.state.jobId || null;
    if (state.state.type === "progress" || state.state.type === "queued") {
      applyState(state.state);
      // Keep the form data loaded so "取消" can fall back to it, and so the
      // panel still knows this video after a background job ends.
      await loadInfo();
      applyState(state.state);
      if (state.otherTab) {
        externalTabNote = "正在下载另一个标签页里的视频，这里显示的是该任务的进度。";
        $("queueNote").classList.remove("hidden");
        $("queueNote").textContent = externalTabNote;
      }
      return;
    }
    if (state.state.type === "done") {
      applyState(state.state);
      await loadInfo();
      applyState(state.state);
      return;
    }
    if (state.state.type === "interrupted") {
      // Show the resume offer, and still load the form so "回到设置" works.
      applyState(state.state);
      await loadInfo();
      applyState(state.state);
      currentJobId = state.state.jobId || null;
      interruptedJobId = state.state.jobId || null;
      return;
    }
    // A previous error should not hide this video's form.
  }
  await loadInfo();
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

$("download").addEventListener("click", async () => {
  if (!info || busy) return;
  const directory = $("directory").value.trim();
  if (!directory) {
    $("platformHint").textContent = "请填写保存目录，或留空使用系统下载目录";
    $("platformHint").classList.add("error");
    return;
  }
  await chrome.storage.local.set({ keep: $("keep").checked, directory });
  const jobId = crypto.randomUUID();
  currentJobId = jobId;
  const job = { ...buildJob(jobId), id: jobId };
  renderProgress({ state: "progress", type: "progress", jobId, stage: "正在启动本地助手", percent: 0 });
  const response = await send({ type: "START_DOWNLOAD", job });
  if (!response?.ok) {
    showOnly("form");
    busy = false;
    $("platformHint").textContent = response?.error || "无法启动下载";
    $("platformHint").classList.add("error");
    if (response?.hint) $("errorHint").textContent = response.hint;
  }
});

$("pageSelect").addEventListener("change", () => {
  switchPage(Number($("pageSelect").value)).catch(error => fail(error?.message || String(error)));
});

$("browse").addEventListener("click", () => send({ type: "CHOOSE_DIRECTORY" }));

$("cancel").addEventListener("click", async () => {
  if (!currentJobId) return;
  $("cancel").disabled = true;
  await send({ type: "CANCEL_DOWNLOAD", jobId: currentJobId });
});

$("again").addEventListener("click", async () => {
  if (interruptedJobId) {
    const jobId = interruptedJobId;
    interruptedJobId = null;
    $("again").textContent = "继续下载（回到设置）";
    const response = await send({ type: "RESUME_JOB", jobId });
    if (!response?.ok) {
      fail(response?.error || "无法继续下载");
      return;
    }
    return;
  }
  busy = false;
  currentJobId = null;
  $("queueNote").classList.add("hidden");
  await loadInfo();
});

$("retry").addEventListener("click", () => {
  loadInfo().catch(error => fail(error?.message || String(error)));
});

$("openFolder").addEventListener("click", () => {
  const path = $("openFolder").dataset.path;
  if (path) send({ type: "OPEN_FOLDER", path });
});

$("keep").addEventListener("change", () => chrome.storage.local.set({ keep: $("keep").checked }));
$("directory").addEventListener("change", () => chrome.storage.local.set({ directory: $("directory").value.trim() }));

initialize().catch(error => fail(error?.message || String(error)));
