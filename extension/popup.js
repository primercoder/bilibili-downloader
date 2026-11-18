// Popup UI.
//
// Behaviour contract (each rule exists because of a real reported problem):
//
//   * Opening the panel always re-reads the current page, so a finished job in
//     another tab can never hide this video's form.
//   * While downloading, the toolbar badge shows the progress percentage.
//   * On success the badge shows ✓. If the panel is already open it stays open
//     showing the finished screen; the ✓→form reset only happens when the panel
//     is closed (see background.js).
//   * A missing native host fails fast with a small error panel instead of
//     showing the full form.
//   * The finished screen offers only "打开所在文件夹"; starting another video
//     means reopening the panel on that video.

const $ = id => document.getElementById(id);

let info = null;
let defaults = null;
let currentJobId = null;
let currentTabId = null;
let savedDirectory = "";
let busy = false;
let interruptedJobId = null;
let popupPort = null;

const send = message => chrome.runtime.sendMessage(message);

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "";
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
  if (!bytes) return "";
  return `${(bytes / 1048576).toFixed(1)} MB/s`;
}

function showOnly(name) {
  for (const section of ["loading", "error", "form", "progressSection"]) {
    $(section).classList.toggle("hidden", section !== name);
  }
}

function fail(message) {
  showOnly("error");
  $("errorBox").textContent = message;
  $("statusDot").classList.remove("ready", "busy");
}

// ---------------------------------------------------------------------------
// form
// ---------------------------------------------------------------------------

function qualityLabel(video) {
  const name = info.qualityNames?.[video.id];
  const primary = name || (video.height ? `${video.height}P` : `${video.id}`);
  const parts = [
    primary,
    video.codec,
    video.fps ? `${Math.round(video.fps)}fps` : "",
    video.bandwidth ? `${(video.bandwidth / 1e6).toFixed(1)}M` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

// AVC plays everywhere; HEVC/AV1 come after it. Higher resolution first.
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
    option.textContent = page.part ? `P${page.page} ${page.part}` : `P${page.page}`;
    $("pageSelect").append(option);
  }
  $("pageSelect").value = String(info.page || 1);
}

function populate() {
  showOnly("form");
  $("title").textContent = info.title || info.bvid;
  $("title").title = info.title || "";
  const bits = [info.partTitle, formatDuration(info.duration)].filter(Boolean);
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
  const preferred =
    videos.find(v => v.id === 80 && v.codec === "AVC") ||
    videos.filter(v => v.codec === "AVC" && (v.height || 0) <= 1080)
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0] ||
    videos[0];
  if (preferred) $("quality").value = String(info.videos.indexOf(preferred));

  $("audio").replaceChildren();
  const audios = [...(info.audios || [])].sort((a, b) => b.bandwidth - a.bandwidth);
  for (const audio of audios) {
    const option = document.createElement("option");
    option.value = String(info.audios.indexOf(audio));
    option.textContent = audio.bandwidth
      ? `${Math.round(audio.bandwidth / 1000)} kbps`
      : audio.codecs || "音频";
    $("audio").append(option);
  }

  if (!$("directory").value) $("directory").value = savedDirectory || defaults?.downloadDir || "";
}

function buildJob(jobId) {
  return {
    id: jobId,
    title: info.title,
    partTitle: info.partTitle,
    bvid: info.bvid,
    page: info.page,
    duration: info.duration,
    video: info.videos[Number($("quality").value)],
    audio: info.audios[Number($("audio").value)],
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
  $("statusDot").classList.add("busy");
  $("statusDot").classList.remove("ready");
  paintProgress(state);
}

function paintProgress(state) {
  const percent = Math.max(0, Math.min(100, state.percent || 0));
  $("bar").style.width = `${percent}%`;
  $("percent").textContent = `${percent >= 100 ? 100 : percent.toFixed(percent < 10 ? 1 : 0)}%`;
  $("stage").textContent = state.stage || "处理中";
  $("doneSize").textContent = state.downloaded ? formatBytes(state.downloaded) : "";
  $("speed").textContent = formatSpeed(state.speed);

  const downloading = Boolean(state.total && state.downloaded != null && state.speed > 0);
  $("etaWrap").classList.toggle("hidden", !downloading);
  if (downloading) {
    const remain = Math.max(0, state.total - state.downloaded);
    const seconds = remain / state.speed;
    $("eta").textContent = seconds > 0 && seconds < 7200 ? formatDuration(seconds) : "—";
  }
}

function renderDone(state) {
  busy = false;
  currentJobId = state.jobId || currentJobId;
  // Tell the background this popup is displaying the finished screen. When the
  // popup closes, the port disconnects and the job is dropped, so the next open
  // starts from a clean form.
  try {
    popupPort?.postMessage({ type: "MARK_DONE_VISIBLE", jobId: currentJobId });
  } catch (_) {
    /* popup closing */
  }
  showOnly("progressSection");
  $("bar").style.width = "100%";
  $("percent").textContent = "100%";
  $("stage").textContent = "已下载";
  $("statusDot").classList.add("ready");
  $("statusDot").classList.remove("busy");
  $("cancel").classList.add("hidden");
  $("again").classList.add("hidden");
  $("openFolder").classList.remove("hidden");
  $("etaWrap").classList.add("hidden");
  $("doneSize").textContent = formatBytes(state.size || state.downloaded);
  $("speed").textContent = "";

  const box = $("result");
  box.classList.remove("error", "hidden");
  box.replaceChildren();
  const name = document.createElement("div");
  name.textContent = (state.output || "").split(/[/\\]/).pop() || "";
  box.append(name);
  const meta = document.createElement("div");
  meta.style.marginTop = "3px";
  meta.style.color = "#9499a0";
  const bits = [];
  if (state.duration) bits.push(formatDuration(state.duration));
  if (state.videoCodec) bits.push(state.videoCodec.split("/")[0]);
  box.append(meta);
  meta.textContent = bits.join(" · ");

  $("openFolder").dataset.path = state.output || state.directory || "";
}

function renderQueued(state) {
  busy = true;
  showOnly("progressSection");
  $("stage").textContent = "排队中";
  $("percent").textContent = `${state.position || 1}`;
  $("bar").style.width = "0%";
  $("doneSize").textContent = "";
  $("speed").textContent = "";
  $("etaWrap").classList.add("hidden");
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
    // The service worker was recycled mid-download. Segments are on disk, so
    // offer a one-click resume rather than a bare failure.
    busy = false;
    currentJobId = state.jobId || currentJobId;
    interruptedJobId = state.jobId || currentJobId;
    showOnly("progressSection");
    $("stage").textContent = "已中断";
    $("percent").textContent = `${Math.round(state.percent || 0)}%`;
    $("bar").style.width = `${Math.max(0, Math.min(100, state.percent || 0))}%`;
    $("statusDot").classList.remove("busy", "ready");
    $("cancel").classList.add("hidden");
    $("openFolder").classList.add("hidden");
    $("again").classList.remove("hidden");
    $("again").textContent = "继续下载";
    $("result").classList.add("hidden");
    return;
  }

  if (state.type === "progress") {
    interruptedJobId = null;
    renderProgress(state);
  } else if (state.type === "done") {
    interruptedJobId = null;
    renderDone(state);
  } else if (state.type === "queued") {
    interruptedJobId = null;
    renderQueued(state);
  } else {
    busy = false;
    interruptedJobId = null;
    if ((state.error || "").includes("已取消")) {
      if (info) populate();
      else loadInfo();
      return;
    }
    showOnly("progressSection");
    $("stage").textContent = "下载失败";
    $("percent").textContent = "";
    $("bar").style.width = "0%";
    $("doneSize").textContent = "";
    $("speed").textContent = "";
    $("etaWrap").classList.add("hidden");
    $("cancel").classList.add("hidden");
    $("again").classList.remove("hidden");
    $("again").textContent = "重试";
    $("openFolder").classList.add("hidden");
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
    fail(response?.error || "读取视频失败");
    return false;
  }
  info = response;
  populate();
  return true;
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
  popupPort = port;
  port.onMessage.addListener(message => {
    if (message.type === "DIRECTORY") {
      if (message.path) {
        $("directory").value = message.path;
        chrome.storage.local.set({ directory: message.path });
      }
      return;
    }
    if (message.type === "JOB") {
      if (message.tabId && currentTabId && message.tabId !== currentTabId) return;
      currentJobId = message.jobId;
      applyState(message.state);
      return;
    }
    if (message.type === "NATIVE_DOWN") {
      $("statusDot").classList.remove("ready", "busy");
    }
  });

  const saved = await chrome.storage.local.get({ keep: false, directory: "" });
  savedDirectory = saved.directory || "";
  $("keep").checked = saved.keep;
  $("directory").value = savedDirectory;

  // Fail fast when the helper is missing: showing the full form only to error
  // out on click is worse than a small, immediate explanation.
  const readiness = await send({ type: "GET_DEFAULTS" });
  if (!readiness?.ok) {
    $("statusDot").classList.add("bad");
    fail(readiness?.error || "本地助手未安装或未运行");
    return;
  }
  defaults = readiness.defaults || null;
  $("statusDot").classList.add("ready");

  const state = await send({ type: "GET_TAB_STATE" });
  currentTabId = state?.tabId || null;
  const previous = state?.state;

  if (previous && (previous.type === "progress" || previous.type === "queued")) {
    currentJobId = previous.jobId || null;
    applyState(previous);
    // Load the form in the background so cancelling falls back cleanly.
    loadInfo().then(ok => {
      if (ok && previous.type === "progress") applyState(previous);
    });
    return;
  }

  if (previous && previous.type === "done") {
    currentJobId = previous.jobId || null;
    // Do NOT call loadInfo() here: it ends in populate(), which calls
    // showOnly("form") and silently replaces the finished screen with the
    // settings form. renderDone only needs the job state, not the page info.
    renderDone(previous);
    return;
  }

  await loadInfo();
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

$("download").addEventListener("click", async () => {
  if (!info || busy) return;
  const directory = $("directory").value.trim();
  await chrome.storage.local.set({ keep: $("keep").checked, directory });
  const jobId = crypto.randomUUID();
  currentJobId = jobId;
  const job = buildJob(jobId);
  renderProgress({ type: "progress", jobId, stage: "正在启动", percent: 0 });
  const response = await send({ type: "START_DOWNLOAD", job });
  if (!response?.ok) {
    busy = false;
    showOnly("form");
    $("statusDot").classList.remove("busy", "ready");
    $("statusDot").classList.add("bad");
    $("errorBox").textContent = response?.error || "无法启动下载";
    showOnly("error");
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
    const response = await send({ type: "RESUME_JOB", jobId });
    if (!response?.ok) {
      fail(response?.error || "无法继续下载");
    }
    return;
  }
  busy = false;
  currentJobId = null;
  await loadInfo();
});

$("retry").addEventListener("click", () => {
  initialize().catch(error => fail(error?.message || String(error)));
});

$("openFolder").addEventListener("click", () => {
  const path = $("openFolder").dataset.path;
  if (path) send({ type: "OPEN_FOLDER", path });
});

$("keep").addEventListener("change", () => chrome.storage.local.set({ keep: $("keep").checked }));
$("directory").addEventListener("change", () => chrome.storage.local.set({ directory: $("directory").value.trim() }));

// Closing the panel after a finished job resets the state, so the next open
// starts from a clean form. This is reported over the popup's own port because
// Chrome does not reliably fire pagehide when it tears a popup down; the port's
// onDisconnect in background.js is the dependable signal.
initialize().catch(error => fail(error?.message || String(error)));
