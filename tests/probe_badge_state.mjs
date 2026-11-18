#!/usr/bin/env node
/**
 * Print what the badge would show, next to the raw progress numbers.
 *
 * Used to diagnose "badge should show the download percentage":
 * it samples GET_ALL_JOBS (which carries percent/downloaded/total/speed) while
 * a real download is running, so the badge can be checked against real data.
 *
 *   node tests/probe_badge_state.mjs
 */
const CDP = "http://127.0.0.1:9222";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIDEO = "https://www.bilibili.com/video/BV1i4411L7br/";

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
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text);
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const main = async () => {
  const extension = process.env.BILI_EXTENSION_ID
    || (await targets()).find(t => t.type === "service_worker" && t.url.includes("khkbfeoekein"))?.url.split("/")[2];
  const driverTab = await newTab(`chrome-extension://${extension}/popup.html`);
  const driver = new Session(driverTab.id);
  await sleep(1200);

  await driver.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs.filter(x => x.url && x.url.includes("bilibili.com/video"))) {
      await chrome.tabs.remove(t.id);
    }
  })()`);

  const videoTab = await newTab(VIDEO);
  const video = new Session(videoTab.id);
  await sleep(8000);
  await driver.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find(x => x.url && x.url.includes("bilibili.com/video"));
    await chrome.tabs.update(t.id, { active: true });
    await new Promise(r => setTimeout(r, 250));
  })()`);

  const started = await driver.eval(`(async () => {
    const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
    if (!info.ok) return { ok: false, error: info.error };
    const v = info.videos.filter(x => x.codec === "AVC").sort((a, b) => b.height - a.height)[0];
    const a = info.audios.slice().sort((x, y) => x.bandwidth - y.bandwidth)[0];
    const job = { id: crypto.randomUUID(), title: "probe-badge", partTitle: "",
      bvid: info.bvid, page: info.page, duration: info.duration,
      video: v, audio: a, keep: false, directory: "", workers: 8 };
    const r = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", job });
    return { ok: r.ok, jobId: r.jobId, error: r.error };
  })()`);
  console.log("start:", JSON.stringify(started));
  if (!started.ok) throw new Error(started.error);

  for (let i = 0; i < 20; i++) {
    const jobs = await driver.eval(
      `(async () => (await chrome.runtime.sendMessage({ type: "GET_ALL_JOBS" })).jobs || [])()`,
    );
    const mine = jobs.find(j => j.jobId === started.jobId);
    const badge = await driver.eval(`chrome.action.getBadgeText({})`);
    if (!mine) { console.log("  job gone"); break; }
    const remain = mine.total ? mine.total - mine.downloaded : 0;
    const eta = mine.speed > 0 ? Math.round(remain / mine.speed) : null;
    console.log(
      `  type=${mine.type} ${String(mine.percent).padEnd(5)} ` +
      `done=${String(mine.downloaded).padEnd(11)} total=${String(mine.total).padEnd(11)} ` +
      `speed=${(mine.speed / 1048576).toFixed(1)}MB/s  eta=${eta}s  badge=${JSON.stringify(badge)}`,
    );
    if (mine.type === "done" || mine.type === "error") break;
    await sleep(700);
  }

  await driver.eval(`(async () => {
    const r = await chrome.runtime.sendMessage({ type: "GET_ALL_JOBS" });
    for (const j of r.jobs || []) {
      if (j.type === "progress") await chrome.runtime.sendMessage({ type: "CANCEL_DOWNLOAD", jobId: j.jobId });
    }
  })()`);
  driver.close();
  video.close();
};

main().catch(error => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
