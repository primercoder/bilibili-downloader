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

const HOST = "com.opencode.bili_downloader";
const MAX_AUTO_RESUME = 2;
const JOB_STORE_KEY = "bili.jobs";
let lastPersistError = "";

let nativePort = null;
let popupPort = null;
let connecting = null;
let lastDefaults = null;

/** jobId -> { tabId, bvid, payload, state, autoResumes } */
const jobs = new Map();
/** tabId -> jobId of the most recent job for that tab */
const tabJobs = new Map();
/** tabId -> last extracted video info (for retry after 403) */
const infoCache = new Map();

// MV3 service workers are killed when idle, and Chrome closes the native port
// with them, which aborts the download. The helper resumes from its on-disk
// segments, but only if we remember which job was running. So every state
// change is mirrored into chrome.storage.local and reconciled on startup.
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
    if (type === "progress" || type === "queued" || type === "interrupted") {
      // It cannot still be running: its death closed the native port. Report it
      // as interrupted so the user gets a one-click resume instead of silence.
      // Queued jobs never transferred a byte, but they must still surface —
      // dropping them here is what made a queued second download vanish.
      jobs.set(jobId, {
        ...job,
        state: {
          type: "interrupted",
          state: "interrupted",
          jobId,
          stage: type === "queued" ? "排队时被中断" : "下载已中断",
          percent: job.state.percent || 0,
          detail:
            type === "queued"
              ? "还没开始下载；点击继续即可开始"
              : "浏览器回收了后台页面；已下载的分段仍然保留，可以续传",
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

const jobsReady = restoreJobs();

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
// Native messaging
// ---------------------------------------------------------------------------

function connectNative() {
  if (nativePort) return Promise.resolve(nativePort);
  if (connecting) return connecting;
  connecting = new Promise(resolve => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (error) {
      connecting = null;
      resolve({ error: error?.message || String(error) });
      return;
    }
    nativePort = port;
    port.onMessage.addListener(handleNativeMessage);
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || "";
      nativePort = null;
      connecting = null;
      const running = [...jobs.entries()].filter(([, job]) => job.state?.type === "progress");
      if (!running.length) {
        postToPopup({ type: "NATIVE_DOWN", error });
        return;
      }
      // The host process died mid-download. It writes each segment at its final
      // offset, so restarting continues where it stopped instead of from zero.
      let resumed = 0;
      for (const [jobId, job] of running) {
        job.autoResumes = (job.autoResumes || 0) + 1;
        if (job.autoResumes > MAX_AUTO_RESUME) {
          setJobState(jobId, {
            type: "error",
            state: "error",
            jobId,
            error: `本地助手连接中断（${error || "未知原因"}），已自动重试 ${MAX_AUTO_RESUME} 次。` +
              "请到扩展管理页重新加载扩展，或重新运行安装脚本。",
          });
          continue;
        }
        resumed++;
        setJobState(jobId, {
          type: "progress",
          state: "progress",
          jobId,
          stage: "重新连接本地助手",
          percent: job.state.percent || 0,
          detail: "已保留已下载的分段，继续续传",
        });
        setTimeout(() => {
          connectNative().then(port2 => {
            if (port2?.error) return;
            port2.postMessage({ type: "start", job: job.payload });
          });
        }, 800);
      }
      if (resumed) {
        postToPopup({ type: "NATIVE_DOWN", error, resumed: true });
      }
    });
    // The host sends nothing until asked, but the open port is what proves the
    // manifest is installed; ask for defaults as a handshake + version probe.
    port.postMessage({ type: "defaults" });
    connecting = null;
    resolve(port);
  });
  return connecting;
}

function handleNativeMessage(message) {
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "defaults":
    case "status":
      lastDefaults = message;
      postToPopup({ type: "DEFAULTS", defaults: message });
      return;
    case "directory":
      postToPopup({ type: "DIRECTORY", path: message.path || "" });
      return;
    case "progress":
    case "done":
    case "error":
    case "queued": {
      const jobId = message.jobId || "unknown";
      if (message.type === "done") {
        // A 403 on the media URL means the signed link expired; retry once with
        // freshly extracted URLs instead of asking the user to do anything.
      }
      setJobState(jobId, message);
      if (message.type === "error" && /HTTP 403|拒绝访问/.test(message.error || "")) {
        retryWithFreshUrls(jobId);
      }
      return;
    }
    default:
      return;
  }
}

async function retryWithFreshUrls(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.refreshed) return;
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
  const port = await connectNative();
  if (port?.error) return;
  setJobState(jobId, {
    type: "progress", state: "progress", jobId,
    stage: "刷新下载地址", percent: job.state?.percent || 0,
    detail: "原地址已过期，已重新获取并续传",
  });
  port.postMessage({ type: "start", job: payload });
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
        const busyTypes = ["progress", "queued", "interrupted"];
        if (direct && busyTypes.includes(direct.type)) {
          return { ok: true, state: direct, tabId: tab.id };
        }
        // Fallback: a download may still be running for another tab (the user
        // navigated away or switched tabs). Attaching it to this tab keeps the
        // panel honest instead of looking idle and losing the progress.
        const candidates = [...jobs.values()]
          .filter(job => busyTypes.includes(job.state?.type))
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
        const port = await connectNative();
        if (port?.error) return { ok: false, error: "本地助手连接失败：" + port.error };
        // Reuse the stored payload: the helper's segment files are keyed by the
        // stream URLs, so the same payload continues from the last byte.
        job.resumable = false;
        job.autoResumes = 0;
        job.finishedAt = 0;
        setJobState(job.state.jobId || message.jobId, {
          type: "progress", state: "progress", jobId: job.state.jobId || message.jobId,
          stage: "继续下载", percent: job.state.percent || 0,
          detail: "从已下载的分段继续",
        });
        port.postMessage({ type: "start", job: job.payload });
        return { ok: true };
      }
      case "GET_DEFAULTS": {
        const port = await connectNative();
        if (port?.error) {
          return {
            ok: false,
            error:
              "本地助手未安装或未注册。请运行安装脚本（Windows 双击 install.bat，Linux 运行 ./install.sh），再重新加载扩展。",
            detail: port.error,
          };
        }
        // The popup checks this before showing the form, so it needs a real
        // answer rather than "request sent". Use the handshake value when it is
        // already known, otherwise wait briefly for the host's first reply.
        if (!lastDefaults) {
          await new Promise(resolve => {
            const deadline = Date.now() + 2500;
            const tick = () => {
              if (lastDefaults || Date.now() > deadline) resolve();
              else setTimeout(tick, 50);
            };
            tick();
          });
        }
        if (!lastDefaults) {
          return { ok: false, error: "本地助手没有响应，请重新运行安装脚本后重启浏览器。" };
        }
        return { ok: true, defaults: lastDefaults };
      }
      case "CHOOSE_DIRECTORY": {
        const port = await connectNative();
        if (port?.error) return { ok: false, error: "本地助手不可用：" + port.error };
        port.postMessage({ type: "choose_directory" });
        return { ok: true };
      }
      case "OPEN_FOLDER": {
        const port = await connectNative();
        if (port?.error) return { ok: false, error: port.error };
        port.postMessage({ type: "open_folder", path: message.path || "" });
        return { ok: true };
      }
      case "START_DOWNLOAD": {
        await jobsReady;
        const tab = await getActiveTab();
        const port = await connectNative();
        if (port?.error) {
          return {
            ok: false,
            error: "本地助手连接失败：" + port.error,
            hint: "请确认已运行安装脚本，并在扩展管理页重新加载扩展。",
          };
        }
        const jobId = message.job.id;
        const payload = { ...message.job, id: jobId };
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
        port.postMessage({ type: "start", job: payload });
        return { ok: true, jobId };
      }
      case "CANCEL_DOWNLOAD": {
        const port = await connectNative();
        if (port?.error) return { ok: false, error: port.error };
        port.postMessage({ type: "cancel", jobId: message.jobId || "" });
        return { ok: true };
      }
      case "GET_HOST_STATUS": {
        const port = await connectNative();
        if (port?.error) return { ok: false, error: port.error };
        port.postMessage({ type: "status" });
        return { ok: true };
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
    if (job && job.state?.type !== "progress") jobs.delete(jobId);
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
  if (job && job.state?.type === "progress") return;
  tabJobs.delete(tabId);
  if (job) jobs.delete(jobId);
});
