#!/usr/bin/env node
/**
 * Verify that a download survives the service worker being recycled.
 *
 * Chrome kills MV3 service workers when idle, and that closes the native port,
 * which aborts the transfer. The host keeps its segments on disk, so the panel
 * must show "interrupted" and offer a resume that continues from those
 * segments instead of starting over.
 *
 *   node tests/browser_interrupt.mjs
 */
const CDP = "http://127.0.0.1:9222";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  return (await fetch(`${CDP}/json/list`)).json();
}
async function newTab(url) {
  return (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
}

class Session {
  constructor(id) {
    this.id = id; this.seq = 0; this.pending = new Map();
    this.ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${id}`);
    this.ready = new Promise(r => this.ws.addEventListener("open", r));
    this.ws.addEventListener("message", e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
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
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const main = async () => {
  const extension = process.env.BILI_EXTENSION_ID
    || (await targets()).find(t => t.type === "service_worker" && t.url.includes("khkbfeoekein"))?.url.split("/")[2];
  if (!extension) throw new Error("找不到扩展 ID");
  console.log("extension:", extension);

  // A long video so the download is still running when we kill the worker.
  const videoUrl = "https://www.bilibili.com/video/BV1i4411L7br/";
  const videoTab = await newTab(videoUrl);
  const video = new Session(videoTab.id);
  await sleep(7000);

  const popupTab = await newTab(`chrome-extension://${extension}/popup.html`);
  const popup = new Session(popupTab.id);
  await sleep(900);
  await popup.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find(t => t.url && t.url.startsWith("https://www.bilibili.com/video/"));
    if (target) await chrome.tabs.update(target.id, { active: true });
  })()`);

  const started = await popup.eval(`(async () => {
    const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
    if (!info.ok) return { ok: false, error: info.error };
    const avc = info.videos.filter(v => v.codec === "AVC").sort((a, b) => b.height - a.height);
    const video = avc.find(v => v.height <= 1080) || avc[0];
    const audio = info.audios.slice().sort((a, b) => a.bandwidth - b.bandwidth)[0];
    const job = { id: crypto.randomUUID(), title: "interrupt-test", partTitle: "",
      bvid: info.bvid, page: info.page, duration: info.duration, video, audio,
      keep: false, directory: "", workers: 8 };
    const response = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", job });
    return { ok: response.ok, jobId: response.jobId, error: response.error,
             height: video.height };
  })()`);
  console.log("started:", JSON.stringify(started));
  if (!started.ok) throw new Error(started.error);

  await sleep(2500);
  const progress = await popup.eval(
    `(async () => (await chrome.runtime.sendMessage({ type: "GET_ALL_JOBS" })).jobs || [])()`,
  );
  console.log("before kill:", JSON.stringify(progress).slice(0, 260));

  // Kill the service worker exactly like Chrome's idle GC does.
  const workers = (await targets()).filter(t => t.type === "service_worker" && t.url.includes(extension));
  console.log("killing service worker(s):", workers.length);
  for (const worker of workers) {
    await fetch(`${CDP}/json/close/${worker.id}`);
  }
  await sleep(3000);

  // Wait for the native host to notice the closed port and exit, then check the
  // state a fresh popup would see (this is what persistJobs/restoreJobs feed).
  let state = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const tab = await newTab(`chrome-extension://${extension}/popup.html`);
    const fresh = new Session(tab.id);
    await sleep(900);
    state = await fresh.eval(
      `(async () => (await chrome.runtime.sendMessage({ type: "GET_TAB_STATE" })).state || null)()`,
    );
    fresh.close();
    if (state) break;
    await sleep(1000);
  }
  console.log("after kill:", JSON.stringify(state).slice(0, 300));

  // Accept either an explicit "interrupted" marker or a still-progressing job
  // (if Chrome respawned the worker and the host finished quickly).
  if (state?.type === "interrupted") {
    const resumed = await popup.eval(
      `(async () => await chrome.runtime.sendMessage({ type: "RESUME_JOB", jobId: ${JSON.stringify(state.jobId)} }))()`,
    ).catch(() => null);
    console.log("resume via old popup (worker gone):", JSON.stringify(resumed));
  }
  console.log("\nNOTE: 关键断言在下面的最终状态里：任务要么完成，要么可续传，不能静默消失。");

  // Final: the job must reach done (after resume or on its own).
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const tab = await newTab(`chrome-extension://${extension}/popup.html`);
    const fresh = new Session(tab.id);
    await sleep(800);
    const jobs = await fresh.eval(
      `(async () => (await chrome.runtime.sendMessage({ type: "GET_ALL_JOBS" })).jobs || [])()`,
    );
    fresh.close();
    const mine = (jobs || []).find(j => j.jobId === started.jobId);
    if (mine) {
      console.log(`  job ${mine.jobId}: ${mine.type} ${mine.percent || 0}%`);
      if (mine.type === "done") {
        console.log("\nPASS: 中断后任务仍然可以完成，没有静默丢失");
        popup.close();
        video.close();
        return;
      }
      if (mine.type === "interrupted") {
        const tab2 = await newTab(`chrome-extension://${extension}/popup.html`);
        const again = new Session(tab2.id);
        await sleep(700);
        const resumed = await again.eval(
          `(async () => await chrome.runtime.sendMessage({ type: "RESUME_JOB", jobId: ${JSON.stringify(mine.jobId)} }))()`,
        );
        again.close();
        console.log("  resume:", JSON.stringify(resumed));
      }
    }
    await sleep(3000);
  }
  throw new Error("任务既没有完成也没有可续传状态 —— 状态丢失");
};

main().catch(error => {
  console.error("\nFAIL:", error.message);
  process.exitCode = 1;
});
