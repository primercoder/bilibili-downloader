// Service worker: page extraction + native messaging bridge.
//
// Design notes for the "download once, then everything hangs" bug that v1 had:
//   1. v1 kept one global `lastState` forever. The popup saw "done" from the
//      *previous* video on every later open, returned early in initialize(), and
//      never extracted the new page's streams — the UI was stuck on the old
//      result until the extension was reloaded.
//   2. v1 also never released the native job slot if a job ended abnormally.
//
// So: state is keyed by tab, a stale job from another tab is never shown, the
// popup always re-extracts the active page, and jobs are queued by the host
// instead of rejected.

// The helper is a local daemon, not a registered Native Messaging host.
// It scans this range for an empty port; the extension scans the same range and
// identifies the process through GET /health.
const HOST_APP = "bili-downloader";
const HOST_PROTOCOL = 1;
const HOST_PORTS = Array.from({ length: 40 }, (_, index) => 47821 + index);
const HOST_EVENT_RETRY_MS = [1000, 2000, 4000, 8000, 10000];
// Jobs that are still alive somewhere in the host. These must survive tab
// navigation and even tab closure, otherwise switching to a non-target page
// (or closing the original tab) makes a queued/interrupted job unreachable.
const ACTIVE_STATES = new Set(["progress", "queued", "interrupted"]);
const JOB_STORE_KEY = "bili.jobs";
let lastPersistError = "";

let popupPort = null;
let lastDefaults = null;
let hostBase = null;
let hostLookup = null;
let hostEvents = null;
let hostEventRetry = 0;
let hostEventTimer = null;
let fallbackPollTimer = null;
let reconcileTimer = null;

/** jobId -> { tabId, bvid, payload, state, autoResumes } */
const jobs = new Map();
/** tabId -> jobId of the most recent job for that tab */
const tabJobs = new Map();
/** tabId -> last extracted video info (for retry after 403) */
const infoCache = new Map();

// MV3 service workers are killed when idle. The helper is an independent
// daemon now, so a sleeping worker does not stop the download; we just need to
// remember which job was running and reconcile with GET /jobs on wake-up.
// Only work that is still in flight (or interrupted mid-way) is worth keeping.
//
// A finished result is transient UI state: it is cleared after 3 seconds, or as
// soon as the panel showing it closes. Persisting it made every service-worker
// restart resurrect old ✓ badges for videos finished long ago, and left the job
// table full of stale entries that the panel then had to ignore.
function shouldPersist(state) {
  return state?.type === "progress" || state?.type === "queued" || state?.type === "interrupted";
}

async function persistJobs() {
  try {
    const serialisable = {};
    for (const [jobId, job] of jobs) {
      if (!shouldPersist(job.state)) continue;
      serialisable[jobId] = {
        tabId: job.tabId,
        bvid: job.bvid,
        payload: job.payload,
        state: job.state,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      };
    }
    await chrome.storage.local.set({ [JOB_STORE_KEY]: serialisable });
    lastPersistError = "";
  } catch (error) {
    // Never let bookkeeping break a download, but keep the reason visible for
    // diagnostics (GET_ALL_JOBS reports it).
    lastPersistError = error?.message || String(error);
    console.warn("persistJobs failed:", lastPersistError);
  }
}

/** Restore jobs saved by a previous service-worker lifetime. */
async function restoreJobs() {
  let saved = {};
  try {
    saved = (await chrome.storage.local.get({ [JOB_STORE_KEY]: {} }))[JOB_STORE_KEY] || {};
  } catch (_) {
    return;
  }
  for (const [jobId, job] of Object.entries(saved)) {
    if (!job || !job.payload) continue;
    const type = job.state?.type;
    if (type === "progress" || type === "queued") {
      // The daemon may still be downloading this job. Show its last known
      // state while the first SSE snapshot confirms it; do not fabricate an
      // "interrupted" screen just because the worker went to sleep.
      jobs.set(jobId, {
        ...job,
        state: {
          ...job.state,
          type,
          state: type,
          jobId,
          stage: "正在恢复任务",
          detail: "正在连接本地助手",
          percent: job.state.percent || 0,
        },
        resumable: false,
      });
      if (job.tabId) tabJobs.set(job.tabId, jobId);
    } else if (type === "interrupted") {
      jobs.set(jobId, {
        ...job,
        state: {
          type: "interrupted",
          state: "interrupted",
          jobId,
          stage: job.state.stage || "下载已中断",
          percent: job.state.percent || 0,
          detail: job.state.detail || "已下载的分段仍然保留，可以续传",
        },
        resumable: true,
      });
      if (job.tabId) tabJobs.set(job.tabId, jobId);
    }
    // Finished results are deliberately not restored: they are transient UI
    // state and must not come back as a stale ✓ after a worker restart.
  }
  if (jobs.size) {
    const newest = [...jobs.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
    badgeFor(newest.state);
  }
}

const jobsReady = restoreJobs().then(async () => {
  // One snapshot on startup/reconnect. It discovers jobs started before this
  // service worker woke up and gives the popup a truthful state immediately.
  try {
    const data = await hostRequest("/jobs", { timeout: 3000 });
    applyHostSnapshot(data.jobs || []);
  } catch (_) {
    // The helper may not be running; the UI will show the usual hint.
  }
  if (activeJobsExist()) ensureHostEvents();
});

function postToPopup(message) {
  try {
    popupPort?.postMessage(message);
  } catch (_) {
    /* popup closed */
  }
}

function stateForTab(tabId) {
  const jobId = tabJobs.get(tabId);
  if (!jobId) return null;
  const job = jobs.get(jobId);
  return job ? job.state : null;
}

function notifyStatus() {
  postToPopup({ type: "STATUS", running: [...jobs.values()].filter(job => job.state?.type === "progress").length });
}

function clearBadge() {
  try {
    chrome.action.setBadgeText({ text: "" });
  } catch (_) {
    /* action unavailable */
  }
}

function badgeFor(state) {
  try {
    if (state?.type === "progress") {
      // The toolbar badge always shows download progress as a percentage.
      // It fits four characters, so "100%" is the widest value.
      const percent = Math.max(0, Math.min(100, Math.round(state.percent || 0)));
      chrome.action.setBadgeText({ text: `${percent}%` });
      chrome.action.setBadgeBackgroundColor({ color: "#fb7299" });
    } else if (state?.type === "done") {
      chrome.action.setBadgeText({ text: "✓" });
      chrome.action.setBadgeBackgroundColor({ color: "#00aeec" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch (_) {
    /* action unavailable (rare) */
  }
}

// How long the ✓ stays when nothing is showing the result. Clicking the icon
// inside this window opens the finished screen; after it the job is dropped so
// the next open starts from a clean form.
const DONE_BADGE_MS = 3000;
/** jobId -> timer that clears the ✓ and forgets the finished job */
const doneTimers = new Map();
/** Finished jobs whose ✓ must not expire because a panel just opened. */
const pausedDone = new Set();
/** The finished job the currently open panel is displaying, if any. */
let shownDoneJobId = "";

function dropJob(jobId) {
  const job = jobs.get(jobId);
  jobs.delete(jobId);
  if (job?.tabId && tabJobs.get(job.tabId) === jobId) tabJobs.delete(job.tabId);
  if (shownDoneJobId === jobId) shownDoneJobId = "";
  pausedDone.delete(jobId);
  // Recompute instead of clearing: another job may be mid-download and its
  // progress badge must survive this one being forgotten.
  const active = [...jobs.values()]
    .filter(j => j.state?.type === "progress" || j.state?.type === "done")
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  if (active) badgeFor(active.state);
  else clearBadge();
  persistJobs();
}

function scheduleDoneReset(jobId) {
  cancelDoneReset(jobId);
  doneTimers.set(
    jobId,
    setTimeout(() => {
      doneTimers.delete(jobId);
      // A panel is showing this result, or just opened to show it: its own
      // close is what resets the state, so the ✓ outlives the timer.
      if (shownDoneJobId === jobId || pausedDone.has(jobId)) return;
      dropJob(jobId);
    }, DONE_BADGE_MS),
  );
}

function cancelDoneReset(jobId) {
  const timer = doneTimers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    doneTimers.delete(jobId);
  }
}

function setJobState(jobId, state) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.state = state;
  if (["done", "error"].includes(state.type)) {
    job.finishedAt = Date.now();
  }
  badgeFor(state);
  postToPopup({ type: "JOB", jobId, tabId: job.tabId, state });
  notifyStatus();
  persistJobs();
  if (state.type === "done") {
    scheduleDoneReset(jobId);
  } else if (state.type === "progress" || state.type === "queued") {
    cancelDoneReset(jobId);
  }
}

// ---------------------------------------------------------------------------
// Local HTTP host
// ---------------------------------------------------------------------------

function abortAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function fetchHost(url, options = {}, timeout = 4000) {
  const abort = abortAfter(timeout);
  try {
    return await fetch(url, {
      ...options,
      signal: abort.signal,
      cache: "no-store",
      headers: { "X-Bili-Client": "extension", ...(options.headers || {}) },
    });
  } finally {
    abort.cancel();
  }
}

async function discoverHost() {
  if (hostBase) return hostBase;
  if (hostLookup) return hostLookup;
  hostLookup = (async () => {
    for (const port of HOST_PORTS) {
      const base = `http://127.0.0.1:${port}`;
      try {
        const response = await fetchHost(`${base}/health`, {}, 350);
        if (!response.ok) continue;
        const info = await response.json();
        if (info?.app === HOST_APP && info?.protocol === HOST_PROTOCOL) {
          hostBase = base;
          return base;
        }
      } catch (_) {
        // Port is closed or belongs to another local service. Try the next.
      }
    }
    return null;
  })();
  try {
    return await hostLookup;
  } finally {
    hostLookup = null;
  }
}

async function hostRequest(path, options = {}) {
  const { timeout = 6000, ...fetchOptions } = options;
  const headers = { ...(fetchOptions.headers || {}) };
  if (fetchOptions.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const execute = async base => {
    const response = await fetchHost(base + path, { ...fetchOptions, headers }, timeout);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      throw new Error(`本地助手返回了无效数据（HTTP ${response.status}）`);
    }
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || `本地助手返回 HTTP ${response.status}`);
    }
    return data;
  };

  let base = await discoverHost();
  if (!base) {
    throw new Error("本地助手未运行。请先启动 Bili 下载器助手（安装脚本会设置开机启动）。");
  }
  try {
    return await execute(base);
  } catch (error) {
    // Retry discovery for reads only. Replaying a POST could start the same
    // download twice or open a second folder dialog.
    if ((fetchOptions.method || "GET").toUpperCase() !== "GET") throw error;
    hostBase = null;
    const retryBase = await discoverHost();
    if (!retryBase) throw error;
    return await execute(retryBase);
  }
}

const hostPost = (path, body = {}) =>
  hostRequest(path, { method: "POST", body: JSON.stringify(body) });

async function fetchDefaults() {
  const data = await hostRequest("/defaults");
  lastDefaults = data.defaults || data;
  postToPopup({ type: "DEFAULTS", defaults: lastDefaults });
  return lastDefaults;
}

function activeJobsExist() {
  return [...jobs.values()].some(job => ACTIVE_STATES.has(job.state?.type));
}

function applyHostState(state) {
  if (!state?.jobId) return;
  let job = jobs.get(state.jobId);
  if (!job) {
    // Finished results for a job this worker never knew about would resurrect
    // an old completion screen. Active jobs can still arrive after storage was
    // cleared (for example a fresh service worker), so attach those.
    if (state.type === "done" || state.type === "error") return;
    job = {
      tabId: null,
      bvid: state.bvid || "",
      payload: null,
      state: null,
      startedAt: state.updatedAt || Date.now(),
      autoResumes: 0,
    };
    jobs.set(state.jobId, job);
  }
  setJobState(state.jobId, state);
  if (state.type === "error" && /HTTP 403|拒绝访问/.test(state.error || "")) {
    retryWithFreshUrls(state.jobId);
  }
}

function applyHostSnapshot(states) {
  const seen = new Set();
  for (const state of states || []) {
    if (!state?.jobId) continue;
    seen.add(state.jobId);
    applyHostState(state);
  }
  const now = Date.now();
  let needReconcile = false;
  for (const [jobId, job] of [...jobs.entries()]) {
    if (!ACTIVE_STATES.has(job.state?.type) || seen.has(jobId)) continue;
    if (now - (job.startedAt || 0) < 3000) {
      // A job can be POSTed a few milliseconds before the hub records its
      // first progress event. Recheck once after the grace period instead of
      // declaring it dead immediately.
      needReconcile = true;
      continue;
    }
    setJobState(jobId, {
      type: "interrupted",
      state: "interrupted",
      jobId,
      stage: "本地助手没有该任务",
      percent: job.state?.percent || 0,
      detail: "本地助手可能已重启；点击继续可从已下载分段续传",
      resumable: true,
    });
  }
  if (needReconcile) scheduleSnapshotReconcile();
  if (!activeJobsExist()) closeHostEvents();
}

function markHostDown(error) {
  for (const [jobId, job] of [...jobs.entries()]) {
    if (!ACTIVE_STATES.has(job.state?.type)) continue;
    setJobState(jobId, {
      type: "interrupted",
      state: "interrupted",
      jobId,
      stage: "本地助手连接中断",
      percent: job.state?.percent || 0,
      detail: error?.message || "请启动本地助手后点击继续下载",
      resumable: true,
    });
  }
  hostBase = null;
  closeHostEvents();
  postToPopup({ type: "NATIVE_DOWN", error: error?.message || String(error) });
}

function scheduleSnapshotReconcile() {
  if (reconcileTimer || !activeJobsExist()) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    if (!activeJobsExist()) return;
    hostRequest("/jobs", { timeout: 3000 })
      .then(data => applyHostSnapshot(data.jobs || []))
      .catch(() => {});
  }, 3500);
}

function closeHostEvents() {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }
  if (hostEvents) {
    const source = hostEvents;
    hostEvents = null;
    try { source.close(); } catch (_) { /* already closed */ }
  }
  if (hostEventTimer) {
    clearTimeout(hostEventTimer);
    hostEventTimer = null;
  }
  if (fallbackPollTimer) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }
  hostEventRetry = 0;
}

function scheduleHostReconnect(error) {
  if (!activeJobsExist()) {
    closeHostEvents();
    return;
  }
  hostEventRetry++;
  if (hostEventRetry > HOST_EVENT_RETRY_MS.length) {
    markHostDown(error);
    return;
  }
  if (hostEventTimer) return;
  const delay = HOST_EVENT_RETRY_MS[Math.min(hostEventRetry - 1, HOST_EVENT_RETRY_MS.length - 1)];
  hostEventTimer = setTimeout(() => {
    hostEventTimer = null;
    connectHostEvents().catch(() => {});
  }, delay);
}

async function connectHostEvents() {
  if (hostEvents || hostEventTimer) return;
  if (typeof EventSource !== "function") {
    startFallbackPolling();
    return;
  }
  const base = await discoverHost();
  if (!base) {
    scheduleHostReconnect(new Error("本地助手未运行"));
    return;
  }
  let source;
  try {
    source = new EventSource(`${base}/events`);
  } catch (error) {
    scheduleHostReconnect(error);
    return;
  }
  hostEvents = source;
  source.onopen = () => {
    hostEventRetry = 0;
  };
  source.addEventListener("snapshot", event => {
    try {
      const data = JSON.parse(event.data);
      hostEventRetry = 0;
      applyHostSnapshot(data.jobs || []);
    } catch (_) {
      /* malformed snapshot; the next reconnect will resend it */
    }
  });
  source.addEventListener("job", event => {
    try {
      const state = JSON.parse(event.data);
      applyHostState(state);
      if (!activeJobsExist()) closeHostEvents();
    } catch (_) {
      /* malformed event; snapshot on reconnect is authoritative */
    }
  });
  source.onerror = () => {
    if (hostEvents !== source) return;
    hostBase = null;
    hostEvents = null;
    try { source.close(); } catch (_) { /* already closed */ }
    scheduleHostReconnect(new Error("SSE 连接中断"));
  };
}

function ensureHostEvents() {
  return connectHostEvents();
}

function startFallbackPolling() {
  if (fallbackPollTimer) return;
  const tick = async () => {
    try {
      const data = await hostRequest("/jobs", { timeout: 3000 });
      applyHostSnapshot(data.jobs || []);
    } catch (error) {
      markHostDown(error);
    }
  };
  fallbackPollTimer = setInterval(() => { tick().catch(() => {}); }, 1500);
  tick().catch(() => {});
}

async function retryWithFreshUrls(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.payload || job.refreshed) return;
  job.refreshed = true;
  const info = infoCache.get(job.tabId);
  if (!info) return;
  const payload = { ...job.payload };
  const video = info.videos.find(item => item.codecs === job.payload.video?.codecs && item.id === job.payload.video?.id);
  const audio = info.audios.find(item => item.id === job.payload.audio?.id);
  if (!video || !audio) return;
  payload.video = video;
  payload.audio = audio;
  job.payload = payload;
  try {
    await hostPost("/jobs", payload);
  } catch (_) {
    return;
  }
  setJobState(jobId, {
    type: "progress", state: "progress", jobId,
    stage: "刷新下载地址", percent: job.state?.percent || 0,
    detail: "原地址已过期，已重新获取并续传",
  });
  ensureHostEvents();
}

// ---------------------------------------------------------------------------
// Page extraction
// ---------------------------------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("找不到当前标签页");
  return tab;
}

function isVideoUrl(url) {
  return typeof url === "string" && /(^https:\/\/www\.bilibili\.com\/(video|bangumi)\/)/.test(url);
}

async function extract(tabId, page) {
  const target = { tabId };
  if (page) {
    // The extractor is injected as a file, so the requested part number is
    // handed over through a page-scoped variable first.
    await chrome.scripting.executeScript({
      target,
      world: "MAIN",
      func: value => {
        window.__biliDownloaderPage = value;
      },
      args: [page],
    });
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target,
      world: "MAIN",
      files: ["page-extractor.js"],
    });
    return result?.result || { ok: false, error: "页面脚本未返回结果，请刷新视频页后重试" };
  } finally {
    if (page) {
      // Clear the override so a later call without an explicit page falls back
      // to the URL's own ?p= value instead of a stale part number.
      chrome.scripting
        .executeScript({
          target,
          world: "MAIN",
          func: () => {
            window.__biliDownloaderPage = 0;
          },
        })
        .catch(() => {});
    }
  }
}

async function extractForTab(tabId, page) {
  const info = await extract(tabId, page);
  if (info?.ok) infoCache.set(tabId, info);
  return info;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "popup") return;
  popupPort = port;
  // Pause pending ✓ expiries. The user may have clicked the icon precisely to
  // see this result, and the popup needs a moment to connect and ask for state;
  // letting the timer fire underneath it would drop the screen just clicked for.
  for (const jobId of [...doneTimers.keys()]) {
    cancelDoneReset(jobId);
    pausedDone.add(jobId);
  }
  port.onMessage.addListener(message => {
    if (message?.type !== "MARK_DONE_VISIBLE") return;
    const jobId = message.jobId || "";
    // This panel owns the finished screen: keep it while the panel is open.
    shownDoneJobId = jobId;
    pausedDone.delete(jobId);
    cancelDoneReset(jobId);
  });
  port.onDisconnect.addListener(() => {
    if (popupPort !== port) return;
    popupPort = null;
    // Closing the panel resets what it was showing. Any finished job it opened
    // too late to display is dropped too, otherwise its ✓ would never clear.
    if (shownDoneJobId) {
      const jobId = shownDoneJobId;
      shownDoneJobId = "";
      pausedDone.delete(jobId);
      if (jobs.has(jobId)) dropJob(jobId);
    }
    for (const jobId of [...pausedDone]) {
      pausedDone.delete(jobId);
      if (jobs.has(jobId)) dropJob(jobId);
    }
  });
  if (lastDefaults) port.postMessage({ type: "DEFAULTS", defaults: lastDefaults });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_VIDEO_INFO": {
        const tab = await getActiveTab();
        if (!isVideoUrl(tab.url)) {
          return { ok: false, error: "请先打开 Bilibili 视频页面，再点击本扩展图标" };
        }
        return await extractForTab(tab.id, message.page);
      }
      case "GET_ALL_JOBS": {
        // Wait for the restore pass: on a freshly spawned service worker the
        // job table is still empty for a few milliseconds, and returning that
        // empty list is what makes a running download look like it vanished.
        await jobsReady;
        const recent = [...jobs.entries()]
          .map(([jobId, job]) => ({
            jobId,
            tabId: job.tabId,
            bvid: job.bvid,
            type: job.state?.type || "",
            stage: job.state?.stage || "",
            percent: job.state?.percent || 0,
            downloaded: job.state?.downloaded || 0,
            total: job.state?.total || 0,
            speed: job.state?.speed || 0,
            output: job.state?.output || "",
            error: job.state?.error || "",
            startedAt: job.startedAt || 0,
            finishedAt: job.finishedAt || 0,
          }))
          .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        return {
          ok: true,
          jobs: recent,
          persistError: lastPersistError,
          stored: [...jobs.keys()].length,
        };
      }
      case "GET_TAB_STATE": {
        // Same reason as GET_ALL_JOBS: never answer before the restore finished.
        await jobsReady;
        const tab = await getActiveTab();
        const direct = stateForTab(tab.id);
        if (direct && ACTIVE_STATES.has(direct.type)) {
          return { ok: true, state: direct, tabId: tab.id };
        }
        // Fallback: a download may still be running for another tab (the user
        // navigated away or switched tabs). Attaching it to this tab keeps the
        // panel honest instead of looking idle and losing the progress.
        const candidates = [...jobs.values()]
          .filter(job => ACTIVE_STATES.has(job.state?.type))
          .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        const running =
          candidates.find(job => job.state?.type === "progress") ||
          candidates.find(job => job.state?.type === "interrupted") ||
          candidates[0];
        if (running) {
          return {
            ok: true,
            state: running.state,
            tabId: tab.id,
            attachedJobId: running.state.jobId || null,
            otherTab: running.tabId !== tab.id,
            resumable: running.state?.type === "interrupted",
          };
        }
        // No live job: keep a finished/error result that belongs to this tab.
        if (direct) return { ok: true, state: direct, tabId: tab.id };
        return { ok: true, state: null, tabId: tab.id };
      }
      case "RESUME_JOB": {
        await jobsReady;
        const job = jobs.get(message.jobId || "");
        if (!job) return { ok: false, error: "找不到该任务" };
        if (!job.payload) return { ok: false, error: "找不到续传所需的下载信息，请重新点下载" };
        try {
          await hostPost("/jobs", job.payload);
        } catch (error) {
          return { ok: false, error: "本地助手连接失败：" + (error?.message || String(error)) };
        }
        // Reuse the stored payload: the helper's segment files are keyed by the
        // stream paths, so the same payload continues from the last byte.
        job.resumable = false;
        job.autoResumes = 0;
        job.finishedAt = 0;
        setJobState(job.state.jobId || message.jobId, {
          type: "progress", state: "progress", jobId: job.state.jobId || message.jobId,
          stage: "继续下载", percent: job.state.percent || 0,
          detail: "从已下载的分段继续",
        });
        ensureHostEvents();
        return { ok: true };
      }
      case "GET_DEFAULTS": {
        try {
          const defaults = await fetchDefaults();
          return { ok: true, defaults };
        } catch (error) {
          return {
            ok: false,
            error: `本地助手未运行：${error?.message || String(error)}`,
            hint: "安装脚本会把助手设置为开机启动；也可以手动运行 bili-host serve。",
          };
        }
      }
      case "CHOOSE_DIRECTORY": {
        try {
          const data = await hostRequest("/choose-directory", {
            method: "POST",
            body: "{}",
            timeout: 5 * 60 * 1000,
          });
          const path = data.path || "";
          if (path) postToPopup({ type: "DIRECTORY", path });
          return { ok: true, path };
        } catch (error) {
          return { ok: false, error: "无法打开文件夹选择器：" + (error?.message || String(error)) };
        }
      }
      case "OPEN_FOLDER": {
        try {
          await hostPost("/open-folder", { path: message.path || "" });
          return { ok: true };
        } catch (error) {
          return { ok: false, error: "无法打开文件夹：" + (error?.message || String(error)) };
        }
      }
      case "START_DOWNLOAD": {
        await jobsReady;
        const tab = await getActiveTab();
        const jobId = message.job.id;
        const payload = { ...message.job, id: jobId };
        // Record the job before POSTing. If the worker is suspended between the
        // request and the response, the next wake-up can still reconcile it.
        jobs.set(jobId, {
          tabId: tab.id,
          bvid: payload.bvid,
          payload,
          state: { type: "progress", state: "progress", jobId, stage: "正在启动", percent: 0 },
          startedAt: Date.now(),
          autoResumes: 0,
        });
        tabJobs.set(tab.id, jobId);
        badgeFor({ type: "progress", percent: 0 });
        persistJobs();
        try {
          await hostPost("/jobs", payload);
        } catch (error) {
          dropJob(jobId);
          return {
            ok: false,
            error: "本地助手连接失败：" + (error?.message || String(error)),
            hint: "请确认本地助手正在运行，或重新运行安装脚本。",
          };
        }
        ensureHostEvents();
        return { ok: true, jobId };
      }
      case "CANCEL_DOWNLOAD": {
        try {
          await hostPost("/cancel", { jobId: message.jobId || "" });
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error?.message || String(error) };
        }
      }
      case "GET_HOST_STATUS": {
        try {
          const status = await hostRequest("/health");
          return { ok: true, status };
        } catch (error) {
          return { ok: false, error: error?.message || String(error) };
        }
      }
      default:
        return { ok: false, error: "未知操作" };
    }
  })()
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

// A navigated tab starts from a clean form. We deliberately keep finished job
// results when the user merely switches tabs and comes back.
chrome.tabs.onRemoved.addListener(tabId => {
  const jobId = tabJobs.get(tabId);
  tabJobs.delete(tabId);
  infoCache.delete(tabId);
  if (jobId) {
    const job = jobs.get(jobId);
    if (job && !ACTIVE_STATES.has(job.state?.type)) jobs.delete(jobId);
  }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  // A navigated tab starts from a clean form, but a download that is still
  // running must stay attached to the extension so the panel can show it again
  // after the user comes back.
  infoCache.delete(tabId);
  const jobId = tabJobs.get(tabId);
  if (!jobId) return;
  const job = jobs.get(jobId);
  if (job && ACTIVE_STATES.has(job.state?.type)) return;
  tabJobs.delete(tabId);
  if (job) jobs.delete(jobId);
});
