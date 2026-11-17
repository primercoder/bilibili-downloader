const $ = id => document.getElementById(id);
let info = null;
let defaults = null;
let busy = false;
let currentJobId = null;
let savedDirectory = "";

function send(message) {
  return chrome.runtime.sendMessage(message);
}
function formatDuration(seconds) {
  if (!seconds) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function formatMbps(bandwidth) {
  return `${(bandwidth / 1e6).toFixed(bandwidth >= 1e7 ? 0 : 1)} Mbps`;
}
function showOnly(id) {
  for (const name of ["loading", "error", "form", "progressSection"]) $(name).classList.toggle("hidden", name !== id);
}
function fail(message) {
  showOnly("error");
  $("error").textContent = message;
  $("statusDot").classList.remove("ready");
}
function codecLabel(video) {
  const desc = info.description[video.id] || `${video.height}P`;
  return `${desc} · ${video.width}×${video.height} · ${video.fps || "?"}fps · ${video.codec} · ${formatMbps(video.bandwidth)}`;
}
function populate() {
  showOnly("form");
  $("title").textContent = info.title;
  $("title").title = info.title;
  $("meta").textContent = `${info.bvid}${info.partTitle ? ` · ${info.partTitle}` : ""} · ${formatDuration(info.duration)}`;
  $("quality").replaceChildren();
  const avc = info.videos.filter(v => v.codec === "AVC");
  const ordered = [...(avc.length ? avc : []), ...info.videos.filter(v => v.codec !== "AVC")];
  for (const video of ordered) {
    const option = document.createElement("option");
    option.value = String(info.videos.indexOf(video));
    option.textContent = codecLabel(video);
    $("quality").append(option);
  }
  if ($("quality").value === "") $("quality").selectedIndex = 0;
  // Prefer 1080P AVC; fall back to the highest AVC at or below 1080P.
  const preferred = ordered.find(v => v.id === 80 && v.codec === "AVC")
    || ordered.filter(v => v.codec === "AVC" && v.height <= 1080).sort((a, b) => b.height - a.height)[0]
    || ordered[0];
  $("quality").value = String(info.videos.indexOf(preferred));
  $("audio").replaceChildren();
  const audios = [...info.audios].sort((a, b) => b.bandwidth - a.bandwidth);
  for (const audio of audios) {
    const option = document.createElement("option");
    option.value = String(info.audios.indexOf(audio));
    option.textContent = `${Math.round(audio.bandwidth / 1000)} kbps · ${audio.codecs}`;
    $("audio").append(option);
  }
  if (!$("directory").value) $("directory").value = savedDirectory || defaults?.downloadDir || "";
  $("platformHint").textContent = defaults ? `${defaults.platform === "windows" ? "Windows" : "Linux"} 默认下载目录${defaults.ffmpeg ? " · FFmpeg 就绪" : " · 未检测到 FFmpeg"}` : "正在连接本地 FFmpeg 助手…";
  $("statusDot").classList.toggle("ready", Boolean(defaults?.ffmpeg));
}
function selectedIndex(id) { return Number($(id).value); }
function jobFromForm() {
  const video = info.videos[selectedIndex("quality")];
  const audio = info.audios[selectedIndex("audio")];
  return {
    id: crypto.randomUUID(), title: info.title, partTitle: info.partTitle,
    bvid: info.bvid, page: info.page, duration: info.duration,
    video, audio, keep: $("keep").checked, directory: $("directory").value.trim()
  };
}
function updateState(state) {
  if (!state || state.state === "idle") return;
  if (state.type === "defaults") {
    defaults = state;
    if (info && !busy) populate();
    return;
  }
  if (state.type === "directory") {
    if (state.path) $("directory").value = state.path;
    return;
  }
  if (!["progress", "done", "error"].includes(state.type)) return;
  if (currentJobId && state.jobId && state.jobId !== currentJobId) return;
  if (state.type === "progress") {
    busy = true;
    showOnly("progressSection");
    $("result").classList.add("hidden");
    $("again").classList.add("hidden");
    $("cancel").classList.remove("hidden");
    $("stage").textContent = state.stage || "处理中";
    const percent = Math.max(0, Math.min(100, state.percent || 0));
    $("progress").value = percent;
    $("percent").textContent = `${Math.round(percent)}%`;
    const downloaded = state.downloaded != null ? `${(state.downloaded / 1048576).toFixed(1)} MB` : "";
    const total = state.total ? ` / ${(state.total / 1048576).toFixed(1)} MB` : "";
    const speed = state.speed ? ` · ${(state.speed / 1048576).toFixed(1)} MB/s` : "";
    $("progressDetail").textContent = `${downloaded}${total}${speed}${state.detail ? ` · ${state.detail}` : ""}`;
  } else if (state.type === "done") {
    busy = false;
    showOnly("progressSection");
    $("stage").textContent = "下载完成";
    $("percent").textContent = "100%";
    $("progress").value = 100;
    $("progressDetail").textContent = `视频 ${state.videoCodec || ""} + 音频 ${state.audioCodec || ""} · 已验证音视频流`;
    $("result").textContent = `保存至：${state.output}${state.kept?.length ? `\n中间文件：\n${state.kept.join("\n")}` : "\n中间文件已自动清理"}`;
    $("result").classList.remove("hidden");
    $("cancel").classList.add("hidden");
    $("again").classList.remove("hidden");
  } else {
    busy = false;
    if (state.error?.includes("已取消")) {
      if (info) populate();
      return;
    }
    fail(state.error || "下载失败");
  }
}

async function initialize() {
  const port = chrome.runtime.connect({ name: "popup" });
  port.onMessage.addListener(message => {
    if (message.type === "STATE") updateState(message.state);
    if (message.type === "NATIVE") updateState(message.message);
  });
  const saved = await chrome.storage.local.get({ keep: false, directory: "" });
  savedDirectory = saved.directory || "";
  $("keep").checked = saved.keep;
  const state = await send({ type: "GET_STATE" });
  if (state && ["progress", "done", "error"].includes(state.type)) {
    currentJobId = state.jobId || null;
    updateState(state);
    if (["progress", "done"].includes(state.type)) return;
  }
  const response = await send({ type: "GET_VIDEO_INFO" });
  if (!response?.ok) { fail(response?.error || "读取视频失败"); return; }
  info = response;
  populate();
  const defaultsResponse = await send({ type: "GET_DEFAULTS" });
  if (!defaultsResponse?.ok) fail(defaultsResponse?.error || "本地助手连接失败");
}

$("download").addEventListener("click", async () => {
  if (!info || busy) return;
  const directory = $("directory").value.trim();
  if (!directory) { fail("请选择保存目录，或使用默认下载目录"); return; }
  await chrome.storage.local.set({ keep: $("keep").checked, directory });
  currentJobId = crypto.randomUUID();
  const job = { ...jobFromForm(), id: currentJobId };
  updateState({ type: "progress", state: "progress", jobId: currentJobId, stage: "正在启动本地助手", percent: 0 });
  const response = await send({ type: "START_DOWNLOAD", job });
  if (!response?.ok) fail(response?.error || "无法启动下载");
});
$("browse").addEventListener("click", () => send({ type: "CHOOSE_DIRECTORY" }));
$("cancel").addEventListener("click", () => {
  if (currentJobId) send({ type: "CANCEL_DOWNLOAD", jobId: currentJobId });
  $("cancel").disabled = true;
});
$("again").addEventListener("click", () => { if (info) populate(); });
$("keep").addEventListener("change", () => chrome.storage.local.set({ keep: $("keep").checked }));
$("directory").value = "";
initialize().catch(error => fail(error?.message || String(error)));
