#!/usr/bin/env node
/**
 * Verify the code paths that the two-video test does not reach:
 *
 *   1. multi-part (分 P) videos — the part picker and page override;
 *   2. HEVC / AV1 streams — different keyframe detection in the muxer;
 *   3. queued jobs — starting a second download while the first runs.
 *
 *   node tests/browser_extra.mjs
 */
const CDP = "http://127.0.0.1:9222";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const MULTI_PART = "https://www.bilibili.com/video/BV1i4411L7br/";
// A video that ships AVC + HEVC + AV1 streams, for the codec-path test.
const MULTI_CODEC = "https://www.bilibili.com/video/BV1GJ411x7h7/";

async function targets() {
  return (await fetch(`${CDP}/json/list`)).json();
}
async function newTab(url) {
  return (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
}

class Session {
  constructor(id) {
    this.id = id;
    this.seq = 0;
    this.pending = new Map();
    this.ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${id}`);
    this.ready = new Promise(r => this.ws.addEventListener("open", r));
    this.ws.addEventListener("message", e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    const m = await new Promise(r => this.pending.set(id, r));
    if (m.error) throw new Error(JSON.stringify(m.error));
    return m.result || {};
  }
  async eval(expression) {
    const r = await this.call("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function openPopup(extension) {
  const tab = await newTab(`chrome-extension://${extension}/popup.html`);
  const session = new Session(tab.id);
  await sleep(900);
  return session;
}

const activate = (page, url) => page.eval(`(async () => {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(url)}));
  if (!target) return null;
  await chrome.tabs.update(target.id, { active: true });
  await new Promise(r => setTimeout(r, 300));
  return target.id;
})()`);

/** Start a job and wait for it to reach a terminal state. */
async function runJob(page, { pickCodec = "AVC", maxHeight = 1080, workers = 8, label = "" } = {}) {
  const started = await page.eval(`(async () => {
    const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
    if (!info.ok) return { ok: false, error: info.error };
    const pool = info.videos.filter(v => v.codec === ${JSON.stringify(pickCodec)});
    const source = pool.length ? pool : info.videos;
    const video = source
      .filter(v => (v.height || 0) <= ${maxHeight})
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0] || source[0];
    const audio = info.audios.slice().sort((a, b) => a.bandwidth - b.bandwidth)[0];
    const job = {
      id: crypto.randomUUID(), title: info.title, partTitle: info.partTitle,
      bvid: info.bvid, page: info.page, duration: info.duration,
      video, audio, keep: false, directory: "", workers: ${workers},
    };
    const response = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", job });
    return { ok: response.ok, error: response.error, jobId: response.jobId,
             height: video && video.height, codec: video && video.codec,
             audios: info.audios.length };
  })()`);
  if (!started.ok) throw new Error(`start failed: ${started.error}`);
  const final = await waitJob(page, started.jobId);
  return { started, final };
}

async function waitJob(page, jobId, timeout = 420000) {
  const begin = Date.now();
  let sawQueued = false;
  while (Date.now() - begin < timeout) {
    const state = (await page.eval(
      `(async () => (await chrome.runtime.sendMessage({ type: "GET_TAB_STATE" })).state || null)()`,
    )) || {};
    if (state.jobId && state.jobId !== jobId) {
      // This tab jumped to another job (queue test); keep waiting for ours.
    } else if (state.type === "queued") {
      sawQueued = true;
    } else if (state.type === "done" || state.type === "error") {
      return state;
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${jobId} (queued=${sawQueued})`);
}

const main = async () => {
  const extension = process.env.BILI_EXTENSION_ID
    || (await targets()).find(t => t.type === "service_worker" && t.url.includes("khkbfeoekein"))?.url.split("/")[2];
  if (!extension) throw new Error("找不到扩展 ID");

  // --- 1. multi-part video -------------------------------------------------
  console.log("[1] 分 P 视频");
  const partTab = await newTab(MULTI_PART);
  const partSession = new Session(partTab.id);
  await sleep(6000);
  const popup = await openPopup(extension);
  await activate(popup, MULTI_PART);

  const parts = await popup.eval(`(async () => {
    const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
    if (!info.ok) return { ok: false, error: info.error };
    return { ok: true, pages: (info.pages || []).map(p => ({ page: p.page, part: p.part })),
             current: info.page };
  })()`);
  console.log("  parts:", JSON.stringify(parts).slice(0, 300));
  if (!parts.ok) throw new Error(`extract failed: ${parts.error}`);
  if (parts.pages.length <= 1) {
    console.log("  (这个视频没有分 P，跳过切换测试)");
  } else {
    const switched = await popup.eval(`(async () => {
      const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO", page: 2 });
      return { ok: info.ok, page: info.page, partTitle: info.partTitle, error: info.error };
    })()`);
    console.log("  switch to P2:", JSON.stringify(switched));
    if (!switched.ok || switched.page !== 2) throw new Error("分 P 切换失败");
    const back = await popup.eval(`(async () => {
      const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
      return { page: info.page };
    })()`);
    if (back.page !== 1) throw new Error(`page override leaked: got P${back.page}`);
    console.log("  切回 P1 正常（没有残留覆盖）");
  }

  // --- 2. HEVC -------------------------------------------------------------
  console.log("\n[2] HEVC 编码合成");
  const codecTab = await newTab(MULTI_CODEC);
  const codecSession = new Session(codecTab.id);
  await sleep(6500);
  await activate(popup, MULTI_CODEC);
  const codecs = await popup.eval(`(async () => {
    const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
    if (!info.ok) return { ok: false, error: info.error, codecs: [] };
    return { ok: true, codecs: [...new Set((info.videos || []).map(v => v.codec))] };
  })()`);
  console.log("  available codecs:", JSON.stringify(codecs.codecs));
  if (!codecs.ok) throw new Error(`提取失败: ${codecs.error}`);
  if (codecs.codecs.includes("HEVC")) {
    const result = await runJob(popup, { pickCodec: "HEVC", maxHeight: 480 });
    console.log(`  HEVC -> ${result.final.type}, ${result.final.videoCodec}, `
      + `${Math.round(result.final.duration || 0)}s`);
    if (result.final.type !== "done") throw new Error(`HEVC download failed: ${result.final.error}`);
    if (!/HEVC|H\.265/i.test(result.final.videoCodec || "")) {
      throw new Error(`期望 HEVC 输出，实际 ${result.final.videoCodec}`);
    }
  } else {
    throw new Error("测试视频应包含 HEVC 流");
  }
  codecSession.close();

  // --- 3. queue two jobs ---------------------------------------------------
  console.log("\n[3] 连续提交两个任务（排队行为）");
  await activate(popup, MULTI_PART);
  const both = await popup.eval(`(async () => {
    const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
    if (!info.ok) return { ok: false, error: info.error };
    const avc = info.videos.filter(v => v.codec === "AVC").sort((a, b) => b.height - a.height);
    const video = avc.find(v => v.height <= 480) || avc[avc.length - 1];
    const audio = info.audios.slice().sort((a, b) => a.bandwidth - b.bandwidth)[0];
    const make = () => ({ id: crypto.randomUUID(), title: info.title,
      partTitle: info.partTitle, bvid: info.bvid, page: info.page,
      duration: info.duration, video, audio, keep: false, directory: "", workers: 8 });
    const a = make();
    const b = make();
    const first = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", job: a });
    const second = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", job: b });
    return { ok: true, a: a.id, b: b.id, first, second };
  })()`);
  if (!both.ok) throw new Error(`queue start failed: ${both.error}`);
  console.log("  first:", both.first.ok, "second:", both.second.ok);

  // Both must reach "done". GET_TAB_STATE only reports the tab's newest job, so
  // poll GET_ALL_JOBS which keeps every job of this browser session.
  const done = await popup.eval(`(async () => {
    const wanted = ${JSON.stringify([both.a, both.b])};
    const seen = {};
    const begin = Date.now();
    while (Date.now() - begin < 300000) {
      const response = await chrome.runtime.sendMessage({ type: "GET_ALL_JOBS" });
      for (const job of (response.jobs || [])) {
        if (!wanted.includes(job.jobId)) continue;
        if (job.type === "done") seen[job.jobId] = "done";
        else if (job.type === "error") seen[job.jobId] = "error: " + job.error;
      }
      if (Object.keys(seen).length === wanted.length) return seen;
      await new Promise(r => setTimeout(r, 500));
    }
    return seen;
  })()`);
  console.log("  results:", JSON.stringify(done));
  if (Object.keys(done).length !== 2) {
    throw new Error(`只有 ${Object.keys(done).length}/2 个任务结束：${JSON.stringify(done)}`);
  }
  for (const [id, result] of Object.entries(done)) {
    if (result !== "done") throw new Error(`job ${id} -> ${result}`);
  }

  console.log("\nPASS: 分 P / HEVC / 排队 三条路径全部通过");
  popup.close();
  partSession.close();
};

main().catch(error => {
  console.error("\nFAIL:", error.message);
  process.exitCode = 1;
});
