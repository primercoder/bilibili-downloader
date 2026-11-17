#!/usr/bin/env node
/**
 * Drive the real extension inside Chromium over the DevTools protocol.
 *
 * Verifies what unit tests cannot:
 *   - Chrome accepts the native-messaging manifest and can spawn the helper;
 *   - the page extractor returns usable streams on a live Bilibili page;
 *   - a download started from the extension produces a playable MP4;
 *   - a *second* download starts right after — the regression that used to
 *     require reloading the extension.
 *
 * Usage:
 *   chromium --remote-debugging-port=9222 --load-extension=$PWD/extension
 *   node tests/browser_drive.mjs
 */
import fs from "node:fs";
import path from "node:path";

const CDP = "http://127.0.0.1:9222";
const VIDEOS = [
  "https://www.bilibili.com/video/BV132436REqW/",
  "https://www.bilibili.com/video/BV1GJ411x7h7/",
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function jsonFetch(url, method = "GET") {
  const response = await fetch(url, { method });
  return response.json();
}

/** /json/new requires PUT on current Chrome versions. */
async function newTab(url) {
  return jsonFetch(`${CDP}/json/new?${encodeURIComponent(url)}`, "PUT");
}

class Session {
  constructor(targetId, label) {
    this.id = targetId;
    this.label = label;
    this.seq = 0;
    this.pending = new Map();
    this.ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${targetId}`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve);
      this.ws.addEventListener("error", reject);
    });
    this.ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      const resolver = this.pending.get(message.id);
      if (resolver) {
        this.pending.delete(message.id);
        resolver(message);
      }
    });
  }

  async call(method, params = {}) {
    await this.ready;
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    const message = await new Promise(resolve => this.pending.set(id, resolve));
    if (message.error) throw new Error(`${method}: ${JSON.stringify(message.error)}`);
    return message.result || {};
  }

  async eval(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(`JS: ${detail.exception?.description || detail.text}`);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function findExtensionId() {
  const targets = await jsonFetch(`${CDP}/json/list`);
  const candidates = [
    ...new Set(
      targets
        .filter(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))
        .map(t => t.url.split("/")[2]),
    ),
  ];
  for (const id of candidates) {
    try {
      const tab = await newTab(`chrome-extension://${id}/popup.html`);
      const session = new Session(tab.id, id);
      await session.ready;
      await sleep(900);
      const title = await session.eval("document.title");
      const canNative = await session.eval("typeof chrome?.runtime?.connectNative");
      session.close();
      if (title?.includes("Bili") && canNative === "function") return id;
    } catch {
      /* not ours */
    }
  }
  throw new Error("找不到已加载的 Bili 扩展（用 --load-extension 启动 Chromium）");
}

async function openExtensionPage(extensionId) {
  const tab = await newTab(`chrome-extension://${extensionId}/popup.html`);
  const session = new Session(tab.id, "popup");
  await session.ready;
  await sleep(900);
  return session;
}

async function activateVideoTab(page, url) {
  return page.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(url)}));
    if (!target) return null;
    await chrome.tabs.update(target.id, { active: true });
    await new Promise(r => setTimeout(r, 350));
    return target.id;
  })()`);
}

async function main() {
  const extension = await findExtensionId();
  console.log("extension id:", extension);

  const saved = [];
  let failures = 0;

  for (const [index, url] of VIDEOS.entries()) {
    console.log(`\n[${index + 1}/${VIDEOS.length}] ${url}`);
    // Each round uses a fresh extension page: the most honest simulation of a
    // user closing and reopening the popup.
    const page = await openExtensionPage(extension);
    const tab = await newTab(url);
    const video = new Session(tab.id, "video");
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        if (await video.eval("Boolean(window.__playinfo__ && window.__playinfo__.data)")) break;
      } catch {
        /* still loading */
      }
      await sleep(500);
    }
    await sleep(1200);

    if (!(await activateVideoTab(page, url))) throw new Error("找不到视频标签页");

    const info = await page.eval(`(async () => {
      const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
      const defaults = await chrome.runtime.sendMessage({ type: "GET_DEFAULTS" });
      return {
        ok: info.ok, error: info.error, title: info.title, bvid: info.bvid,
        videos: (info.videos || []).length, audios: (info.audios || []).length,
        pages: (info.pages || []).length,
        defaultsOk: defaults.ok, defaultsError: defaults.error,
        downloadDir: defaults.ok === false ? "" : undefined,
      };
    })()`);
    console.log("  extract:", JSON.stringify(info));
    if (!info.ok) throw new Error(`提取失败: ${info.error}`);
    if (!info.defaultsOk) throw new Error(`本地助手不可用: ${info.defaultsError}`);

    const started = await page.eval(`(async () => {
      const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
      if (!info.ok) return { ok: false, error: info.error };
      const avc = info.videos.filter(v => v.codec === "AVC").sort((a, b) => b.height - a.height);
      const video = avc.find(v => v.height <= 480) || avc[avc.length - 1];
      const audio = info.audios.slice().sort((a, b) => a.bandwidth - b.bandwidth)[0];
      const job = {
        id: crypto.randomUUID(), title: info.title, partTitle: info.partTitle,
        bvid: info.bvid, page: info.page, duration: info.duration,
        video, audio, keep: false, directory: "", workers: 8,
      };
      const response = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", job });
      return { ok: response.ok, error: response.error, jobId: response.jobId,
               height: video.height, codec: video.codec };
    })()`);
    console.log("  start:", JSON.stringify(started));
    if (!started.ok) throw new Error(`启动失败: ${started.error}`);

    const begin = Date.now();
    let final = null;
    let lastPercent = -100;
    while (Date.now() - begin < 420000) {
      const state = (await page.eval(
        `(async () => (await chrome.runtime.sendMessage({ type: "GET_TAB_STATE" })).state || null)()`,
      )) || {};
      if (state.type === "progress" || state.type === "queued") {
        const percent = state.percent || 0;
        if (percent - lastPercent >= 15) {
          console.log(
            `    ${percent.toFixed(1).padStart(5)}%  ${(state.stage || "").padEnd(12)}` +
              ` ${((state.speed || 0) / 1e6).toFixed(1).padStart(5)} MB/s  ${state.detail || ""}`,
          );
          lastPercent = percent;
        }
      } else if (state.type === "done" || state.type === "error") {
        final = state;
        break;
      }
      await sleep(700);
    }
    if (!final) throw new Error("超时：没有等到下载完成");
    if (final.type === "error") throw new Error(`下载失败: ${final.error}`);

    const stat = fs.statSync(final.output);
    const sizeMb = stat.size / 1048576;
    const elapsed = ((Date.now() - begin) / 1000).toFixed(1);
    console.log(`  saved: ${final.output}`);
    console.log(
      `  ${sizeMb.toFixed(1)} MiB in ${elapsed}s, ${Math.round(final.duration || 0)}s, ` +
        `${final.videoCodec} + ${final.audioCodec}`,
    );
    if (sizeMb < 1) throw new Error("输出过小");
    if (!final.hasAudio) throw new Error("输出缺少音频轨");
    saved.push({ output: final.output, sizeMb });
    page.close();
    video.close();
  }

  console.log("\n汇总:");
  for (const item of saved) console.log(`  ${item.sizeMb.toFixed(1)} MiB  ${item.output}`);
  console.log(`\nPASS: 连续 ${saved.length} 次下载都成功，无需重启扩展`);
}

main().catch(error => {
  console.error("\nFAIL:", error.message);
  process.exitCode = 1;
});
