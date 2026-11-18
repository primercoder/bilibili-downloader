#!/usr/bin/env node
/**
 * Verify the finished-screen rules against the real toolbar-popup behaviour.
 *
 *   1. Panel closed at completion: the result survives for ~3s, so opening the
 *      panel inside that window shows the finished screen, not a fresh form.
 *   2. Panel open at completion: it stays on the finished screen past 3s.
 *   3. Closing that panel resets the job, so the next open is a clean form.
 *   4. The finished screen offers only 打开所在文件夹.
 *
 * The popup is opened as a *background* tab via CDP Target.createTarget. A
 * foreground tab would become the active tab, and the popup reads the active
 * tab — the real toolbar popup never changes which tab is active, so a
 * foreground tab would test something the user never experiences.
 *
 *   node tests/browser_done_screen.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CDP = "http://127.0.0.1:9222";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIDEO = "https://www.bilibili.com/video/BV1GJ411x7h7/";
const TITLE = "done-screen-test";
const DOWNLOADS = path.join(process.env.HOME || os.homedir(), "Downloads");

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

/** Browser-level CDP session, needed for Target.createTarget. */
class Browser {
  constructor(url) {
    this.seq = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
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
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/**
 * Open the popup without stealing focus from the video tab, like the toolbar
 * popup does. Returns a session plus a closer.
 *
 * It waits for a *decided* section (form / progress / error), not merely any
 * visible one: the panel shows "loading" first, so returning there would assert
 * against a half-initialised popup and report a false failure.
 */
async function openPopupBackground(browser, extension) {
  const { targetId } = await browser.call("Target.createTarget", {
    url: `chrome-extension://${extension}/popup.html`,
    background: true,
  });
  const session = new Session(targetId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const decided = await session.eval(`
        (["form", "progressSection", "error"]
          .find(id => { const el = document.getElementById(id); return el && !el.classList.contains("hidden"); })
        ) || ""
      `);
      if (decided) return { targetId, session, openedAt: Date.now(), decided };
    } catch {
      /* page still loading */
    }
    await sleep(40);
  }
  throw new Error("面板在 15 秒内没有进入可用状态");
}

const closePopup = async popup => {
  await popup.session.eval(`chrome.tabs.getCurrent(t => t && chrome.tabs.remove(t.id))`).catch(() => {});
  popup.session.close();
  await sleep(300);
};

/**
 * Wait until the finished mp4 lands in the download directory.
 *
 * Completion is detected from the file rather than from persisted state: a
 * finished job is deliberately *not* persisted (it is transient UI state that
 * must not resurrect as a stale ✓ after a worker restart), so polling storage
 * would never see "done". The file is renamed into place at the same moment the
 * job reports done, which keeps the 3-second window measurable.
 */
async function waitForOutput(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let names = [];
    try {
      names = fs.readdirSync(DOWNLOADS);
    } catch { names = []; }
    const hit = names.find(n => n.startsWith(TITLE) && n.endsWith(".mp4"));
    if (hit) {
      const full = path.join(DOWNLOADS, hit);
      const size = fs.statSync(full).size;
      await sleep(120);
      if (fs.statSync(full).size === size) return { path: full, at: Date.now() };
    }
    await sleep(40);
  }
  throw new Error(`等待输出文件超时：${DOWNLOADS}/${TITLE}*.mp4`);
}

const visibleSection = session => session.eval(
  `[...document.querySelectorAll("main > section")]
     .filter(s => !s.classList.contains("hidden")).map(s => s.id).join(",")`,
);

function clearOutputs() {
  try {
    for (const name of fs.readdirSync(DOWNLOADS)) {
      if (name.startsWith(TITLE) && name.endsWith(".mp4")) {
        fs.rmSync(path.join(DOWNLOADS, name), { force: true });
      }
    }
  } catch { /* nothing to clear */ }
}

const main = async () => {
  const extension = process.env.BILI_EXTENSION_ID
    || (await targets()).find(t => t.type === "service_worker" && t.url.includes("khkbfeoekein"))?.url.split("/")[2];
  if (!extension) throw new Error("找不到扩展 ID");
  clearOutputs();

  const version = await (await fetch(`${CDP}/json/version`)).json();
  const browser = new Browser(version.webSocketDebuggerUrl);

  // Driver popup: only used to control jobs, never to render assertions.
  const driver = await openPopupBackground(browser, extension);
  await driver.session.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs.filter(x => x.url && x.url.includes("bilibili.com/video"))) {
      await chrome.tabs.remove(t.id);
    }
  })()`);

  const videoTab = await newTab(VIDEO);
  const video = new Session(videoTab.id);
  await sleep(8000);
  await driver.session.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find(x => x.url && x.url.includes("bilibili.com/video"));
    await chrome.tabs.update(t.id, { active: true });
    await new Promise(r => setTimeout(r, 250));
  })()`);

  const startJob = () => driver.session.eval(`(async () => {
    const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
    if (!info.ok) return { ok: false, error: info.error };
    const v = info.videos.filter(x => x.codec === "AVC").sort((a, b) => a.height - b.height)[0];
    const a = info.audios.slice().sort((x, y) => x.bandwidth - y.bandwidth)[0];
    const job = { id: crypto.randomUUID(), title: ${JSON.stringify(TITLE)}, partTitle: "",
      bvid: info.bvid, page: info.page, duration: info.duration,
      video: v, audio: a, keep: false, directory: "", workers: 8 };
    const r = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", job });
    return { ok: r.ok, jobId: r.jobId, error: r.error };
  })()`);

  // --- Case 1: nothing open at completion --------------------------------
  console.log("[1] 完成时没有面板，窗口内（<3s）打开");
  const first = await startJob();
  if (!first.ok) throw new Error(first.error);
  await closePopup(driver);
  const out1 = await waitForOutput();
  console.log("  输出:", path.basename(out1.path));

  // Reopen at once, inside the ✓ window, as a background tab so the video page
  // stays the active tab just as it does for the toolbar popup.
  const reopened = await openPopupBackground(browser, extension);
  const section = await visibleSection(reopened.session);
  const text = await reopened.session.eval(`document.querySelector("main").innerText`);
  const activeUrl = await reopened.session.eval(
    `(async () => { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t && t.url; })()`,
  );
  console.log("  活动标签:", String(activeUrl).slice(0, 48));
  console.log("  section:", section, "| 文本首行:", JSON.stringify(text.split("\n").filter(Boolean)[1] || ""));
  if (!section.includes("progressSection")) {
    throw new Error(`窗口内打开应显示完成界面，实际是 ${section}`);
  }
  if (!/已下载/.test(text)) throw new Error("缺少「已下载」标题");

  const buttons = await reopened.session.eval(`
    [...document.querySelectorAll("#progressSection button")]
      .filter(b => !b.classList.contains("hidden")).map(b => b.textContent.trim())
  `);
  console.log("  可见按钮:", JSON.stringify(buttons));
  if (!buttons.includes("打开所在文件夹")) throw new Error("缺少「打开所在文件夹」");
  if (buttons.some(t => /继续|回到设置|重试/.test(t))) {
    throw new Error(`完成界面不应出现其它按钮：${JSON.stringify(buttons)}`);
  }

  // --- Case 2: popup open when the job completes -------------------------
  console.log("\n[2] 完成时面板已打开");
  // Close the previous popup first: only one panel exists in reality, and its
  // close resets the job it was showing.
  await closePopup(reopened);

  const live = await openPopupBackground(browser, extension);
  const startFrom = session => session.eval(`(async () => {
    const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
    if (!info.ok) return { ok: false, error: info.error };
    const v = info.videos.filter(x => x.codec === "AVC").sort((a, b) => a.height - b.height)[0];
    const a = info.audios.slice().sort((x, y) => x.bandwidth - y.bandwidth)[0];
    const job = { id: crypto.randomUUID(), title: ${JSON.stringify(TITLE)}, partTitle: "",
      bvid: info.bvid, page: info.page, duration: info.duration,
      video: v, audio: a, keep: false, directory: "", workers: 8 };
    const r = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", job });
    return { ok: r.ok, jobId: r.jobId, error: r.error };
  })()`);

  // Clear the previous case's output first. Otherwise waitForOutput would match
  // the stale file instantly and report "done" before this job even started.
  clearOutputs();
  const second = await startFrom(live.session);
  if (!second.ok) throw new Error(second.error);
  const out2 = await waitForOutput();
  console.log("  输出:", path.basename(out2.path));

  await sleep(4500); // well past the 3s window
  const section2 = await visibleSection(live.session);
  const text2 = await live.session.eval(`document.querySelector("main").innerText`);
  console.log("  4.5 秒后:", section2, /已下载/.test(text2) ? "（完成界面）" : "（非完成界面）");
  if (!/已下载/.test(text2)) throw new Error("面板打开时完成结果不应被清掉");

  // --- Case 3: closing that panel resets the state -----------------------
  console.log("\n[3] 关闭面板后重新打开");
  await closePopup(live);
  const check = await openPopupBackground(browser, extension);
  const section3 = await visibleSection(check.session);
  const text3 = await check.session.eval(`document.querySelector("main").innerText`);
  console.log("  section:", section3);
  if (/已下载/.test(text3)) throw new Error("关闭面板后应重置为设置界面");
  if (!section3.includes("form")) throw new Error(`关闭后应显示设置表单，实际 ${section3}`);

  const badge = await check.session.eval(`chrome.action.getBadgeText({})`);
  console.log("  角标:", JSON.stringify(badge));
  if (badge === "✓") throw new Error("关闭面板后 ✓ 应消失");

  console.log("\nPASS: 完成界面规则全部符合");
  check.session.close();
  video.close();
};

main().catch(error => {
  console.error("\nFAIL:", error.message);
  process.exitCode = 1;
});
