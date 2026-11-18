#!/usr/bin/env node
/**
 * Verify that switching videos *without a full page reload* extracts the new
 * video's streams.
 *
 * The reported bug: after downloading video A, clicking another video B on the
 * page and downloading again produced a file named after B but with A's
 * content. Title comes from the `view` API (keyed by bvid from the URL), while
 * the streams came from `window.__playinfo__`, which still held A's playurl.
 * The guard meant to prevent that compared `cached.cid` — but `__playinfo__`
 * has no cid field, so the check was always true.
 *
 * Bilibili navigates between videos with the history API (SPA), no reload,
 * which is why simply opening a URL did not reproduce it.
 *
 *   node tests/browser_stale_streams.mjs
 */
const CDP = "http://127.0.0.1:9222";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const A = "https://www.bilibili.com/video/BV132436REqW/";
const B = "https://www.bilibili.com/video/BV1GJ411x7h7/";
const B_PATH = "/video/BV1GJ411x7h7/";

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

const cidFromUrl = url => {
  const m = String(url || "").match(/\/(\d{6,})\/\1_/);
  return m ? m[1] : "";
};

const main = async () => {
  const extension = process.env.BILI_EXTENSION_ID
    || (await targets()).find(t => t.type === "service_worker" && t.url.includes("khkbfeoekein"))?.url.split("/")[2];
  if (!extension) throw new Error("找不到扩展 ID");

  const popupTab = await newTab(`chrome-extension://${extension}/popup.html`);
  const popup = new Session(popupTab.id);
  await sleep(1200);

  const extract = () => popup.eval(`(async () => {
    const info = await chrome.runtime.sendMessage({ type: "GET_VIDEO_INFO" });
    if (!info.ok) return { ok: false, error: info.error };
    return {
      ok: true, bvid: info.bvid, cid: String(info.cid), title: info.title,
      streamCid: (() => {
        const url = (info.videos[0] || {}).urls?.[0] || "";
        const m = url.match(/\\/(\\d{6,})\\/\\1_/);
        return m ? m[1] : "";
      })(),
    };
  })()`);

  const activate = () => popup.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find(t => t.url && t.url.includes("bilibili.com/video"));
    if (target) await chrome.tabs.update(target.id, { active: true });
    await new Promise(r => setTimeout(r, 200));
    return Boolean(target);
  })()`);

  // Start from a clean slate: leftover video tabs from earlier runs would be
  // picked up by GET_VIDEO_INFO (it reads the *active* tab), making this test
  // assert against the wrong page.
  await popup.eval(`(async () => {
    const tabs = await chrome.tabs.query({});
    const stale = tabs.filter(t => t.url && t.url.includes("bilibili.com/video"));
    for (const tab of stale) await chrome.tabs.remove(tab.id);
    return stale.length;
  })()`);
  await sleep(500);

  // 1. Video A, fully loaded so __playinfo__ is populated.
  const tabA = await newTab(A);
  const page = new Session(tabA.id);
  await sleep(8000);
  await activate();
  const a = await extract();
  console.log("A:", JSON.stringify({ bvid: a.bvid, cid: a.cid, streamCid: a.streamCid }));
  if (!a.ok) throw new Error(`A 提取失败: ${a.error}`);
  if (!a.streamCid) throw new Error("A 的流地址里没有 cid，测试前提不成立");

  // 2. SPA navigation to B in the same tab: location changes, __playinfo__ is
  //    NOT rebuilt. This is the exact state the user was in.
  await page.eval(`history.pushState({}, "", ${JSON.stringify(B_PATH)});`);
  await activate();
  const b = await extract();
  console.log("B:", JSON.stringify({ bvid: b.bvid, cid: b.cid, streamCid: b.streamCid }));
  if (!b.ok) throw new Error(`B 提取失败: ${b.error}`);

  // 3. Decisive assertions.
  if (b.bvid === a.bvid) throw new Error(`切换后 bvid 未变：${b.bvid}`);
  if (b.cid === a.cid) throw new Error(`切换后 cid 未变：${b.cid}`);
  if (!b.streamCid) throw new Error("B 的流地址里没有 cid");
  if (b.streamCid !== b.cid) {
    throw new Error(
      `流地址属于 cid=${b.streamCid}，页面却是 cid=${b.cid} —— 复用了上一个视频的播放地址（这正是"标题变了文件没变"）`,
    );
  }
  if (b.streamCid === a.streamCid) throw new Error("A 与 B 的流 cid 相同，仍是旧数据");

  console.log("\nPASS: 页面内切换视频后，拿到的是新视频的流");
  popup.close();
  page.close();
};

main().catch(error => {
  console.error("\nFAIL:", error.message);
  process.exitCode = 1;
});
