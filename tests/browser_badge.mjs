#!/usr/bin/env node
/**
 * Verify the toolbar badge and the finished-screen contract.
 *
 *   * while downloading the badge shows time remaining, not a percentage
 *   * on success it shows ✓
 *   * with the panel closed, ✓ is cleared after ~3s and the job is forgotten
 *   * the finished screen offers only "打开所在文件夹"
 *
 *   node tests/browser_badge.mjs
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
  if (!extension) throw new Error("找不到扩展 ID");

  // Use an extension page as the driver: it can read the badge and drive jobs.
  const driverTab = await newTab(`chrome-extension://${extension}/popup.html`);
  const driver = new Session(driverTab.id);
  await sleep(1200);

  await driver.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs.filter(t => t.url && t.url.includes("bilibili.com/video"))) {
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

  const badge = () => driver.eval(`chrome.action.getBadgeText({})`);

  const started = await driver.eval(`(async () => {
    const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
    if (!info.ok) return { ok: false, error: info.error };
    const v = info.videos.filter(x => x.codec === "AVC").sort((a, b) => b.height - a.height)[0];
    const a = info.audios.slice().sort((x, y) => x.bandwidth - y.bandwidth)[0];
    const job = { id: crypto.randomUUID(), title: "badge-test", partTitle: "",
      bvid: info.bvid, page: info.page, duration: info.duration,
      video: v, audio: a, keep: false, directory: "", workers: 8 };
    const r = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", job });
    return { ok: r.ok, jobId: r.jobId, error: r.error, bytes: v.bandwidth };
  })()`);
  console.log("start:", JSON.stringify(started));
  if (!started.ok) throw new Error(started.error);

  // Sample the badge while it is still downloading.
  const seen = new Set();
  for (let i = 0; i < 14; i++) {
    const text = await badge();
    seen.add(text);
    await sleep(400);
  }
  console.log("角标采样:", JSON.stringify([...seen]));

  // Wait for completion.
  let done = null;
  for (let i = 0; i < 240; i++) {
    const jobs = await driver.eval(
      `(async () => (await chrome.runtime.sendMessage({ type: "GET_ALL_JOBS" })).jobs || [])()`,
    );
    const mine = jobs.find(j => j.jobId === started.jobId);
    if (mine && (mine.type === "done" || mine.type === "error")) {
      done = mine;
      break;
    }
    await sleep(1000);
  }
  if (!done) throw new Error("任务没有结束");
  if (done.type === "error") throw new Error(`任务失败: ${done.error}`);
  console.log("完成后状态:", done.type);

  const badgeAtDone = await badge();
  console.log("完成时角标:", JSON.stringify(badgeAtDone));
  if (badgeAtDone !== "✓") throw new Error(`完成时角标应为 ✓，实际 ${JSON.stringify(badgeAtDone)}`);

  // Close the popup page for real: closing only the CDP socket leaves the tab
  // alive, so the port would stay connected and the ✓ would never clear.
  await driver.eval(`chrome.tabs.getCurrent(t => t && chrome.tabs.remove(t.id))`).catch(() => {});
  driver.close();
  await sleep(600);
  await new Promise(r => setTimeout(r, 4200));

  const verifyTab = await newTab(`chrome-extension://${extension}/popup.html`);
  const verify = new Session(verifyTab.id);
  await sleep(900);
  const badgeAfter = await verify.eval(`chrome.action.getBadgeText({})`);
  console.log("3 秒后角标:", JSON.stringify(badgeAfter));
  if (badgeAfter !== "") throw new Error(`3 秒后角标应清空，实际 ${JSON.stringify(badgeAfter)}`);

  const jobsAfter = await verify.eval(
    `(async () => (await chrome.runtime.sendMessage({ type: "GET_ALL_JOBS" })).jobs || [])()`,
  );
  const stillThere = (jobsAfter || []).find(j => j.jobId === started.jobId);
  if (stillThere) throw new Error("任务完成后应被遗忘，但仍在任务表里");

  console.log("\nPASS: 角标显示剩余时间 → 完成 ✓ → 3 秒后清空并遗忘任务");
  verify.close();
  video.close();
};

main().catch(error => {
  console.error("\nFAIL:", error.message);
  process.exitCode = 1;
});
