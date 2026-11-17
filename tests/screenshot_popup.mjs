#!/usr/bin/env node
/**
 * Screenshot the real extension popup for visual checking.
 *
 * The popup reads the *active* tab, so this activates a Bilibili video page
 * first, then captures the popup at its natural 420x~600 size.
 *
 *   node tests/screenshot_popup.mjs [output.png]
 */
import fs from "node:fs";

const CDP = "http://127.0.0.1:9222";
const VIDEO = "https://www.bilibili.com/video/BV1GJ411x7h7/";
const OUT = process.argv[2] || "/tmp/opencode/popup.png";
const EXTENSION = process.env.BILI_EXTENSION_ID;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function targets() {
  return (await fetch(`${CDP}/json/list`)).json();
}

async function newTab(url) {
  const response = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return response.json();
}

class Session {
  constructor(id) {
    this.id = id;
    this.seq = 0;
    this.pending = new Map();
    this.ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${id}`);
    this.ready = new Promise(resolve => this.ws.addEventListener("open", resolve));
    this.ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    });
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    const message = await new Promise(resolve => this.pending.set(id, resolve));
    if (message.error) throw new Error(JSON.stringify(message.error));
    return message.result || {};
  }
  async eval(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const main = async () => {
  let extension = EXTENSION;
  if (!extension) {
    for (const target of await targets()) {
      if (target.type === "service_worker" && target.url.includes("khkbfeoekein")) {
        extension = target.url.split("/")[2];
      }
    }
  }
  if (!extension) throw new Error("找不到扩展 ID，设置 BILI_EXTENSION_ID");

  // 1. Make a Bilibili video page the active tab.
  let videoTab = (await targets()).find(t => t.type === "page" && t.url.startsWith("https://www.bilibili.com/video/"));
  if (!videoTab) {
    videoTab = await newTab(VIDEO);
    await sleep(6000);
  }
  const video = new Session(videoTab.id);
  await video.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    return "ok";
  })()`).catch(() => "no chrome api in page");

  // 2. Open the popup in an extension page and activate the video tab.
  const popupTab = await newTab(`chrome-extension://${extension}/popup.html`);
  const popup = new Session(popupTab.id);
  await sleep(800);
  await popup.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find(t => t.url && t.url.startsWith("https://www.bilibili.com/video/"));
    if (target) await chrome.tabs.update(target.id, { active: true });
    return true;
  })()`);
  // Reload so the popup initialises against the now-active video tab.
  await popup.call("Page.reload", { ignoreCache: true });
  await sleep(4000);

  // 3. Size the viewport to the popup's own width and capture.
  const metrics = await popup.call("Page.getLayoutMetrics");
  const height = Math.min(Math.ceil(metrics.cssContentSize.height || 600), 800);
  await popup.call("Emulation.setDeviceMetricsOverride", {
    width: 420, height, deviceScaleFactor: 2, mobile: false,
  });
  await sleep(400);
  const shot = await popup.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log(`saved ${OUT} (420x${height})`);
  const text = await popup.eval("document.body.innerText");
  console.log("--- visible text ---");
  console.log(text);
  popup.close();
  video.close();
};

main().catch(error => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
